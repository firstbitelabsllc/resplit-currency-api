#!/usr/bin/env bash
# Update the dormant production FX publisher job by immutable image digest.
# The job is never executed here. Any failure after mutation restores the last
# completed execution's image and verifies that every non-image setting matches.
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-resplit-fx}"
JOB="${JOB:-fx-publish}"
IMAGE="${IMAGE:?set IMAGE to an immutable resplit-fx/fx-publish@sha256: digest}"
GCLOUD="${GCLOUD:-gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-artifact-runtime-image.sh
# The helper is shellchecked separately from this dynamic source path.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/resolve-artifact-runtime-image.sh"

EXPECTED_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/fx-publish@sha256:"
TARGET_DIGEST="${IMAGE#"$EXPECTED_PREFIX"}"
if [[ "$IMAGE" != "${EXPECTED_PREFIX}"* ]] ||
   [[ ! "$TARGET_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> refusing non-canonical FX publisher image" >&2
  exit 2
fi
if ! EXPECTED_RUNTIME_IMAGE="$(resolve_artifact_linux_amd64_image "$GCLOUD" "$IMAGE")"; then
  echo ">> unable to resolve the reviewed FX publisher image to one linux/amd64 runtime" >&2
  exit 1
fi

normalize_contract() {
  jq -Sc '.spec.template.spec | del(.template.spec.containers[0].image)'
}

before="$("$GCLOUD" run jobs describe "$JOB" \
  --region="$REGION" --project="$PROJECT" --format=json)"
latest_execution="$(printf '%s' "$before" | jq -r '.status.latestCreatedExecution.name')"
if [[ -z "$latest_execution" || "$latest_execution" == "null" ]]; then
  echo ">> FX publisher has no completed rollback execution" >&2
  exit 1
fi
execution="$("$GCLOUD" run jobs executions describe "$latest_execution" \
  --region="$REGION" --project="$PROJECT" --format=json)"
test "$(printf '%s' "$execution" | jq -r \
  '.status.conditions[] | select(.type == "Completed") | .status')" = "True"
rollback_image="$(printf '%s' "$execution" | jq -r \
  '.spec.template.spec.containers[0].image')"
rollback_digest="${rollback_image#"$EXPECTED_PREFIX"}"
if [[ "$rollback_image" != "${EXPECTED_PREFIX}"* ]] ||
   [[ ! "$rollback_digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> FX publisher rollback execution is not a canonical immutable image" >&2
  exit 1
fi
before_contract="$(printf '%s' "$before" | normalize_contract)"

rollback_armed=false
rollback_fx_image() {
  local status=$?
  local restored=""
  local restored_image=""
  local restored_contract=""
  trap - EXIT
  if [[ "$rollback_armed" == "true" ]]; then
    if ! "$GCLOUD" run jobs update "$JOB" \
      --image="$rollback_image" \
      --region="$REGION" --project="$PROJECT" --quiet >/dev/null 2>&1; then
      echo ">> FX publisher rollback update failed" >&2
      status=1
    else
      restored="$("$GCLOUD" run jobs describe "$JOB" \
        --region="$REGION" --project="$PROJECT" --format=json 2>/dev/null || true)"
      restored_image="$(printf '%s' "$restored" | jq -r \
        '.spec.template.spec.template.spec.containers[0].image // empty' 2>/dev/null || true)"
      restored_contract="$(printf '%s' "$restored" | normalize_contract 2>/dev/null || true)"
      if [[ "$restored_image" != "$rollback_image" ||
            "$restored_contract" != "$before_contract" ]]; then
        echo ">> FX publisher rollback readback failed" >&2
        status=1
      fi
    fi
  fi
  exit "$status"
}
trap rollback_fx_image EXIT

rollback_armed=true
"$GCLOUD" run jobs update "$JOB" \
  --image="$EXPECTED_RUNTIME_IMAGE" \
  --region="$REGION" --project="$PROJECT" --quiet

after="$("$GCLOUD" run jobs describe "$JOB" \
  --region="$REGION" --project="$PROJECT" --format=json)"
actual="$(printf '%s' "$after" | jq -r \
  '.spec.template.spec.template.spec.containers[0].image')"
test "$actual" = "$EXPECTED_RUNTIME_IMAGE"
after_contract="$(printf '%s' "$after" | normalize_contract)"
if [[ "$after_contract" != "$before_contract" ]]; then
  echo ">> FX publisher non-image contract drifted; restoring last proven digest" >&2
  exit 1
fi
test "$(printf '%s' "$after" | jq -r '.status.latestCreatedExecution.name')" = "$latest_execution"

rollback_armed=false
trap - EXIT
echo ">> ${JOB} image updated by digest without executing the job or changing its contract"
