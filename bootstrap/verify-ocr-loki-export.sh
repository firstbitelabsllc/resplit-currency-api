#!/usr/bin/env bash
# Proves a staged OCR Loki forwarder through its tagged revision, then promotes
# it. ENABLE_SINK=1 additionally proves the real Cloud Logging sink before the
# sink is allowed to remain enabled. No credential value is printed or copied.
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-resplit-fx}"
SERVICE="${SERVICE:-ocr-loki-forwarder}"
IMAGE="${IMAGE:?set IMAGE to the reviewed ocr-loki-forwarder@sha256: digest}"
GRAFANA_LOKI_USER="${GRAFANA_LOKI_USER:?set the read-only Grafana Loki instance id}"
GRAFANA_TOKEN="${GRAFANA_TOKEN:?set a Grafana token that can query Loki}"
GCLOUD="${GCLOUD:-/opt/homebrew/share/google-cloud-sdk/bin/gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud
command -v base64 >/dev/null
command -v curl >/dev/null
command -v jq >/dev/null
command -v openssl >/dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-artifact-runtime-image.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/resolve-artifact-runtime-image.sh"

TOPIC="ocr-loki-logs"
SUBSCRIPTION="ocr-loki-logs-push"
SINK="ocr-loki-export"
PUSH_SA="ocr-loki-push@${PROJECT}.iam.gserviceaccount.com"
LOKI_PUSH_URL="${LOKI_URL:-https://logs-prod-036.grafana.net/loki/api/v1/push}"
LOKI_QUERY_URL="${LOKI_PUSH_URL%/loki/api/v1/push}/loki/api/v1/query_range"
EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/ocr-loki-forwarder@sha256:"
DIGEST="${IMAGE#"$EXPECTED_IMAGE_PREFIX"}"
if [[ "$IMAGE" != "${EXPECTED_IMAGE_PREFIX}"* ]] || [[ ! "$DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> refusing non-canonical image digest" >&2
  exit 2
fi
if [[ "$LOKI_PUSH_URL" != https://logs-prod-[0-9][0-9][0-9].grafana.net/loki/api/v1/push ]]; then
  echo ">> refusing non-canonical Grafana Loki endpoint" >&2
  exit 2
fi
EXPECTED_RUNTIME_IMAGE="$(resolve_artifact_linux_amd64_image "$GCLOUD" "$IMAGE")"
CANDIDATE_TAG="candidate-${DIGEST:0:12}"

SERVICE_JSON="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
SERVICE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r .status.url)"
PREVIOUS_REVISION="$(printf '%s' "$SERVICE_JSON" | jq -r \
  '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] | if length == 1 then .[0] else "" end')"
CANDIDATE_REVISION="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .revisionName] | if length == 1 then .[0] else "" end')"
CANDIDATE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .url] | if length == 1 then .[0] else "" end')"
if [[ -z "$PREVIOUS_REVISION" ]] || [[ -z "$CANDIDATE_REVISION" ]] || [[ "$CANDIDATE_URL" != https://* ]]; then
  echo ">> service traffic or candidate tag is not in the reviewed shape" >&2
  exit 1
fi
CANDIDATE_IMAGE="$($GCLOUD run revisions describe "$CANDIDATE_REVISION" --project="$PROJECT" \
  --region="$REGION" --format='value(spec.containers[0].image)')"
if [[ "$CANDIDATE_IMAGE" != "$EXPECTED_RUNTIME_IMAGE" ]]; then
  echo ">> candidate revision does not use the reviewed runtime digest" >&2
  exit 1
fi

SINK_JSON="$($GCLOUD logging sinks describe "$SINK" --project="$PROJECT" --format=json)"
if [[ "$(printf '%s' "$SINK_JSON" | jq -r .disabled)" != "true" ]]; then
  echo ">> proof starts only from a disabled sink" >&2
  exit 1
fi
SUBSCRIPTION_JSON="$($GCLOUD pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT" --format=json)"
if [[ "$(printf '%s' "$SUBSCRIPTION_JSON" | jq -r .pushConfig.pushEndpoint)" != "${SERVICE_URL}/pubsub/push" ]] ||
   [[ "$(printf '%s' "$SUBSCRIPTION_JSON" | jq -r .pushConfig.oidcToken.serviceAccountEmail)" != "$PUSH_SA" ]] ||
   [[ "$(printf '%s' "$SUBSCRIPTION_JSON" | jq -r .pushConfig.oidcToken.audience)" != "$SERVICE_URL" ]]; then
  echo ">> stable subscription drifted; refusing proof mutation" >&2
  exit 1
fi

AUTH_B64="$(printf '%s:%s' "$GRAFANA_LOKI_USER" "$GRAFANA_TOKEN" | base64 | tr -d '\n')"
query_loki() {
  local request_id="$1"
  local now start_ns end_ns query response
  now="$(date -u +%s)"
  start_ns="$((now - 300))000000000"
  end_ns="$((now + 300))000000000"
  query="{environment=\"production\",service_name=\"ocr\",source=\"gcp_cloud_logging\"} | json | request_id=\"${request_id}\""
  if ! response="$(printf 'header = "Authorization: Basic %s"\n' "$AUTH_B64" | \
    curl --config - --silent --show-error --fail-with-body --get "$LOKI_QUERY_URL" \
      --data-urlencode "query=${query}" --data-urlencode "start=${start_ns}" \
      --data-urlencode "end=${end_ns}" --data-urlencode 'limit=20')"; then
    return 1
  fi
  printf '%s' "$response" | jq -e --arg request_id "$request_id" \
    '[.data.result[]?.values[]?[1] | fromjson? | select(.request_id == $request_id)] | length >= 1' >/dev/null
}

wait_for_loki() {
  local request_id="$1"
  local _
  for _ in {1..18}; do
    if query_loki "$request_id"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

SUBSCRIPTION_CHANGED=0
PROMOTED=0
restore_subscription() {
  "$GCLOUD" pubsub subscriptions update "$SUBSCRIPTION" --project="$PROJECT" \
    --push-endpoint="${SERVICE_URL}/pubsub/push" \
    --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$SERVICE_URL" >/dev/null
  SUBSCRIPTION_CHANGED=0
}
rollback() {
  local exit_code=$?
  set +e
  "$GCLOUD" logging sinks update "$SINK" --project="$PROJECT" --disabled >/dev/null 2>&1
  if [[ "$SUBSCRIPTION_CHANGED" == "1" ]]; then
    restore_subscription >/dev/null 2>&1
  fi
  if [[ "$PROMOTED" == "1" ]] && [[ "$PREVIOUS_REVISION" != "$CANDIDATE_REVISION" ]]; then
    "$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
      --to-revisions="${PREVIOUS_REVISION}=100" --quiet >/dev/null 2>&1
  fi
  exit "$exit_code"
}
trap rollback EXIT

DIRECT_REQUEST_ID="$(openssl rand -hex 16)"
DIRECT_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DIRECT_ENTRY="$(jq -nc --arg project "$PROJECT" --arg timestamp "$DIRECT_TIMESTAMP" --arg request_id "$DIRECT_REQUEST_ID" '
  {
    insertId: $request_id,
    jsonPayload: {
      message: "[OCR_MONITORING] scan", method: "POST", path: "/ocr/scan",
      request_id: $request_id, scan_id: $request_id, signal: "scan", status: "ok",
      attest: "pass", provider: "azure-di", client_version: "deploy-canary"
    },
    logName: ("projects/" + $project + "/logs/run.googleapis.com%2Fstdout"),
    severity: "INFO", timestamp: $timestamp,
    trace: ("projects/" + $project + "/traces/" + $request_id),
    resource: {type: "cloud_run_revision", labels: {service_name: "ocr"}}
  }')"

"$GCLOUD" pubsub subscriptions update "$SUBSCRIPTION" --project="$PROJECT" \
  --push-endpoint="${CANDIDATE_URL}/pubsub/push" \
  --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$CANDIDATE_URL" >/dev/null
SUBSCRIPTION_CHANGED=1
"$GCLOUD" pubsub topics publish "$TOPIC" --project="$PROJECT" --message="$DIRECT_ENTRY" >/dev/null
if ! wait_for_loki "$DIRECT_REQUEST_ID"; then
  echo ">> candidate did not deliver the exact direct proof to Loki" >&2
  exit 1
fi
restore_subscription

if [[ "$PREVIOUS_REVISION" != "$CANDIDATE_REVISION" ]]; then
  "$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
    --to-revisions="${CANDIDATE_REVISION}=100" --quiet
  PROMOTED=1
fi
SERVICE_AFTER_JSON="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
if ! printf '%s' "$SERVICE_AFTER_JSON" | jq -e --arg revision "$CANDIDATE_REVISION" \
  '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] == [$revision]' >/dev/null; then
  echo ">> candidate promotion readback failed" >&2
  exit 1
fi

if [[ "${ENABLE_SINK:-0}" != "1" ]]; then
  PROMOTED=0
  trap - EXIT
  echo ">> candidate direct proof passed and ${CANDIDATE_REVISION} is live; sink remains disabled"
  exit 0
fi

"$GCLOUD" logging sinks update "$SINK" --project="$PROJECT" --no-disabled
SINK_REQUEST_ID="$(openssl rand -hex 16)"
SINK_PAYLOAD="$(jq -nc --arg request_id "$SINK_REQUEST_ID" '
  {
    message: "[OCR_MONITORING] scan", method: "POST", path: "/ocr/scan",
    request_id: $request_id, scan_id: $request_id, signal: "scan", status: "ok",
    attest: "pass", provider: "azure-di", client_version: "deploy-canary"
  }')"
OCR_REVISION="$($GCLOUD run services describe ocr --project="$PROJECT" --region="$REGION" \
  --format='value(status.latestReadyRevisionName)')"
"$GCLOUD" logging write run.googleapis.com/stdout "$SINK_PAYLOAD" --project="$PROJECT" \
  --payload-type=json --severity=INFO --monitored-resource-type=cloud_run_revision \
  --monitored-resource-labels="project_id=${PROJECT},location=${REGION},service_name=ocr,revision_name=${OCR_REVISION},configuration_name=ocr"
if ! wait_for_loki "$SINK_REQUEST_ID"; then
  echo ">> enabled sink did not deliver the exact Cloud Logging proof; rolling back" >&2
  exit 1
fi

"$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --remove-tags="$CANDIDATE_TAG" --quiet
PROMOTED=0
trap - EXIT
echo ">> proved direct Pub/Sub and Cloud Logging delivery for ${CANDIDATE_REVISION}; ${SINK} is enabled"
