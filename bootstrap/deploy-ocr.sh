#!/usr/bin/env bash
#
# deploy-ocr.sh — canonical, reproducible deploy of the OCR Cloud Run service.
#
# Why this script exists: CI (cloudbuild.yaml) only builds + pushes the image;
# it does NOT run `gcloud run deploy`. The service shape (CPU allocation, env,
# secret bindings) is applied here. Without a single source of truth, an ad-hoc
# `gcloud run deploy ocr --image …` drops flags and silently regresses prod —
# which is exactly how telemetry broke during the GCP migration (see THREE
# load-bearing settings flagged inline below).
#
# Idempotent: safe to re-run. `gcloud run deploy` reconciles to this shape.
#
# Usage:
#   IMAGE=…/ocr@sha256:<digest> bootstrap/deploy-ocr.sh
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ocr}"
IMAGE="${IMAGE:?set IMAGE to an immutable resplit-fx/ocr@sha256: digest}"
RUNTIME_SA="${RUNTIME_SA:-903653538868-compute@developer.gserviceaccount.com}"
GCLOUD="${GCLOUD:-/opt/homebrew/share/google-cloud-sdk/bin/gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud
command -v curl >/dev/null
command -v jq >/dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/resplit-fx/ocr@sha256:"
DIGEST="${IMAGE#"$EXPECTED_IMAGE_PREFIX"}"
if [[ "$IMAGE" != "${EXPECTED_IMAGE_PREFIX}"* ]] ||
   [[ ! "$DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> refusing non-canonical OCR image; expected ${EXPECTED_IMAGE_PREFIX}<64-lowercase-hex>" >&2
  exit 2
fi
IMAGE_REPOSITORY="${REGION}-docker.pkg.dev/${PROJECT}/resplit-fx/ocr"
IMAGE_DIGEST="sha256:${DIGEST}"

resolve_runtime_image() {
  local access_token
  local manifest_json
  local media_type
  local runtime_digest
  local manifest_url

  if ! access_token="$("$GCLOUD" auth print-access-token)"; then
    echo ">> unable to obtain an Artifact Registry read token" >&2
    return 1
  fi
  if [[ -z "$access_token" ]]; then
    echo ">> unable to obtain an Artifact Registry read token" >&2
    return 1
  fi
  manifest_url="https://${REGION}-docker.pkg.dev/v2/${PROJECT}/resplit-fx/ocr/manifests/${IMAGE_DIGEST}"
  if ! manifest_json="$(
    printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
      curl --fail --silent --show-error \
        --connect-timeout 10 --max-time 30 \
        --config - \
        --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
        "$manifest_url"
  )"; then
    echo ">> unable to read the reviewed OCR manifest from Artifact Registry" >&2
    return 1
  fi
  if ! media_type="$(printf '%s' "$manifest_json" | jq -er '.mediaType')"; then
    echo ">> Artifact Registry returned malformed OCR manifest metadata" >&2
    return 1
  fi

  case "$media_type" in
    application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
      if ! runtime_digest="$(printf '%s' "$manifest_json" | jq -er '
        [
          .manifests[]
          | select(.platform.os == "linux" and .platform.architecture == "amd64")
          | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
          | .digest
        ]
        | if length == 1 then .[0] else error("expected exactly one linux/amd64 runtime manifest") end
      ')"; then
        echo ">> reviewed OCR index does not contain exactly one linux/amd64 runtime" >&2
        return 1
      fi
      ;;
    application/vnd.oci.image.manifest.v1+json|application/vnd.docker.distribution.manifest.v2+json)
      runtime_digest="$IMAGE_DIGEST"
      ;;
    *)
      echo ">> unsupported OCR image manifest type: ${media_type}" >&2
      return 1
      ;;
  esac

  if [[ ! "$runtime_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo ">> Artifact Registry returned an invalid OCR runtime digest" >&2
    return 1
  fi
  printf '%s@%s' "$IMAGE_REPOSITORY" "$runtime_digest"
}

if ! EXPECTED_RUNTIME_IMAGE="$(resolve_runtime_image)"; then
  echo ">> unable to resolve the reviewed OCR image to one linux/amd64 runtime" >&2
  exit 1
fi
CANDIDATE_TAG="candidate-${DIGEST:0:12}"
DEPLOY_TRACE_ID="${DEPLOY_TRACE_ID:-deploy-${DIGEST:0:12}}"
SCAN_FIXTURE="${SCAN_FIXTURE:-${REPO_ROOT}/ocr-lab/processed/test_receipt.jpg}"
if [[ ! "$DEPLOY_TRACE_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  echo ">> refusing unsafe deploy trace id" >&2
  exit 2
fi
if [[ ! -s "$SCAN_FIXTURE" ]]; then
  echo ">> OCR deploy canary fixture is missing or empty: ${SCAN_FIXTURE}" >&2
  exit 2
fi

CANDIDATE_CLEANUP_ARMED=false
PROMOTION_ROLLBACK_ARMED=false
cleanup_candidate_tag() {
  local status=$?
  local restored_service=""
  local restored_revision=""
  trap - EXIT
  if [[ "$PROMOTION_ROLLBACK_ARMED" == "true" ]]; then
    if ! "$GCLOUD" run services update-traffic "$SERVICE" \
      --project="$PROJECT" --region="$REGION" \
      --to-revisions="${PREVIOUS_REVISION}=100" --quiet >/dev/null 2>&1; then
      echo ">> OCR rollback update failed" >&2
      status=1
    else
      restored_service="$("$GCLOUD" run services describe "$SERVICE" \
        --project="$PROJECT" --region="$REGION" \
        --format=json 2>/dev/null || true)"
      restored_revision="$(printf '%s' "$restored_service" | jq -r \
        '.status.traffic[] | select(.percent == 100) | .revisionName' 2>/dev/null || true)"
      if [[ "$restored_revision" != "$PREVIOUS_REVISION" ]]; then
        echo ">> OCR rollback readback failed" >&2
        status=1
      fi
    fi
  fi
  if [[ "$CANDIDATE_CLEANUP_ARMED" == "true" ]]; then
    "$GCLOUD" run services update-traffic "$SERVICE" \
      --project="$PROJECT" --region="$REGION" \
      --remove-tags="$CANDIDATE_TAG" --quiet >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_candidate_tag EXIT

# Grafana Cloud OTLP gateway (us-east-2 stack). The auth token is NOT here —
# it lives in Secret Manager (grafana-otlp-auth-header) as the full header
# string `Authorization=Basic%20<base64(instanceID:token)>`. The %20 is
# mandatory: the Go OTel SDK url-unescapes the header VALUE, so a literal space
# would be TrimSpace'd off and the gateway returns 401 "no credentials".
OTLP_ENDPOINT="${OTLP_ENDPOINT:-https://otlp-gateway-prod-us-east-2.grafana.net/otlp}"

# Azure Document Intelligence resource endpoint. Plain env (not a credential —
# the KEY is the secret, sourced from Secret Manager below). If this is unset,
# azure.New() errors "empty endpoint" and cmd/ocr SILENTLY falls back to the
# stub OCR provider: scans return 200 in ~0.3s with a {provider,status,bytes}
# raw envelope instead of real receipt data in ~3-4s. Easy to miss because the
# stub envelope still has a non-empty `raw`. Always verify a real merchant/total
# extraction after deploy, not just HTTP 200.
AZURE_OCR_ENDPOINT="${AZURE_OCR_ENDPOINT:-https://superfit.cognitiveservices.azure.com}"

SERVICE_BEFORE="$("$GCLOUD" run services describe "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format=json)"
PREVIOUS_REVISION="$(printf '%s' "$SERVICE_BEFORE" | jq -r \
  '.status.traffic[] | select(.percent == 100) | .revisionName')"
if [[ -z "$PREVIOUS_REVISION" || "$PREVIOUS_REVISION" == "null" ]]; then
  echo ">> unable to resolve the current 100% OCR rollback revision" >&2
  exit 1
fi
PREVIOUS_IMAGE="$("$GCLOUD" run revisions describe "$PREVIOUS_REVISION" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='value(spec.containers[0].image)')"

echo ">> staging ${SERVICE} candidate (${IMAGE}) with zero production traffic"
echo ">> rollback target: ${PREVIOUS_REVISION} (${PREVIOUS_IMAGE})"

CANDIDATE_CLEANUP_ARMED=true
"$GCLOUD" run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA" \
  --ingress=all \
  --allow-unauthenticated \
  --concurrency=8 \
  --timeout=300 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=10 \
  --cpu-boost \
  --no-traffic \
  --tag="$CANDIDATE_TAG" \
  `# ── LOAD-BEARING #1: CPU always allocated while an instance is alive. ──` \
  `# Cloud Run's default throttles CPU to ~0 between requests, which FREEZES` \
  `# the OTel periodic metric reader + batch span exporter goroutines. Result:` \
  `# scans return 200 but ocr_scans_total never increments and no trace ships.` \
  `# Removing this flag silently kills all Grafana telemetry. Scales to zero` \
  `# fine; idle instances bill nothing once torn down.` \
  --no-cpu-throttling \
  `# ── LOAD-BEARING #2: the OTLP endpoint is the master telemetry switch. ──` \
  `# cmd/ocr/main.go only builds the OTLP exporters when this is set; unset =` \
  `# NoopExporters = silent no telemetry. Preserve operational kill switches` \
  `# and future config while updating this canonical set. Use ^@@^ multi-var` \
  `# delimiter so the comma-free values pass through cleanly.` \
  --update-env-vars="^@@^OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}@@OTEL_SERVICE_NAME=${SERVICE}@@OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf@@GCP_PROJECT_ID=${PROJECT}@@AZURE_OCR_ENDPOINT=${AZURE_OCR_ENDPOINT}" \
  `# ── LOAD-BEARING #3: secrets, never plaintext. ──` \
  `# Azure DI key + Grafana OTLP auth header both come from Secret Manager.` \
  `# The runtime SA needs roles/secretmanager.secretAccessor on each (granted` \
  `# in setup-gcp.sh / via add-iam-policy-binding).` \
  --update-secrets="AZURE_OCR_KEY=resplit-fx-azure-di-key:latest,OTEL_EXPORTER_OTLP_HEADERS=grafana-otlp-auth-header:latest" \
  --quiet

SERVICE_JSON="$("$GCLOUD" run services describe "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format=json)"
CANDIDATE_ENTRY="$(printf '%s' "$SERVICE_JSON" | jq -c --arg tag "$CANDIDATE_TAG" \
  '.status.traffic[] | select(.tag == $tag)')"
CANDIDATE_REVISION="$(printf '%s' "$CANDIDATE_ENTRY" | jq -r '.revisionName')"
CANDIDATE_URL="$(printf '%s' "$CANDIDATE_ENTRY" | jq -r '.url')"
if [[ -z "$CANDIDATE_REVISION" || "$CANDIDATE_REVISION" == "null" ||
      -z "$CANDIDATE_URL" || "$CANDIDATE_URL" == "null" ]]; then
  echo ">> unable to resolve the zero-traffic OCR candidate" >&2
  exit 1
fi
CANDIDATE_IMAGE="$("$GCLOUD" run revisions describe "$CANDIDATE_REVISION" \
  --project="$PROJECT" --region="$REGION" --format='value(spec.containers[0].image)')"
if [[ "$CANDIDATE_IMAGE" != "$EXPECTED_RUNTIME_IMAGE" ]]; then
  echo ">> zero-traffic OCR candidate digest does not match the reviewed image" >&2
  exit 1
fi

probe_ocr() {
  local url="$1"
  local health_json
  local challenge_json
  if ! health_json="$(curl --fail --silent --show-error \
    --connect-timeout 10 --max-time 30 --retry 3 --retry-all-errors --retry-max-time 45 \
    "${url}/health")"; then
    return 1
  fi
  if [[ ! "$health_json" =~ \"status\":[[:space:]]*\"ok\" ]] ||
     [[ ! "$health_json" =~ \"service\":[[:space:]]*\"ocr\" ]]; then
    return 1
  fi
  if ! challenge_json="$(curl --fail --silent --show-error \
    --connect-timeout 10 --max-time 30 --retry 3 --retry-all-errors --retry-max-time 45 \
    "${url}/ocr/challenge")"; then
    return 1
  fi
  [[ "$challenge_json" =~ \"challenge\":[[:space:]]*\"[^\"]+\" ]]
}

if ! probe_ocr "$CANDIDATE_URL"; then
  echo ">> zero-traffic OCR candidate failed health/challenge proof; production is unchanged" >&2
  exit 1
fi

probe_provider_and_logs() {
  local work_dir
  local response_file
  local headers_file
  local scan_file
  local http_status
  local response_request_id
  local log_filter
  local log_match=""
  local telemetry_filter
  local telemetry_match=""
  work_dir="$(mktemp -d)"
  response_file="${work_dir}/response.json"
  headers_file="${work_dir}/headers.txt"
  scan_file="${work_dir}/deploy-canary.jpg"
  cp "$SCAN_FIXTURE" "$scan_file"
  # The prod spend gate reserves identity+image hashes for 24 hours. A unique,
  # JPEG-safe trailing token keeps a retried deploy from false-failing as a
  # duplicate while retaining the real Azure bill/telemetry canary.
  printf '\n%s\n' "$DEPLOY_TRACE_ID" >> "$scan_file"

  if ! http_status="$(curl --silent --show-error \
    --connect-timeout 10 --max-time 95 \
    --output "$response_file" \
    --dump-header "$headers_file" \
    --write-out '%{http_code}' \
    --header 'Content-Type: image/jpeg' \
    --header 'X-Resplit-Attest-Soft-Fail: true' \
    --header 'X-Resplit-Client-Version: deploy-canary' \
    --header "X-Request-Id: ${DEPLOY_TRACE_ID}" \
    --data-binary "@${scan_file}" \
    "${CANDIDATE_URL}/ocr/scan")"; then
    rm -rf "$work_dir"
    return 1
  fi
  if [[ "$http_status" != "200" ]] ||
     ! jq -e '
       .provider == "azure-di" and
       .status == "ok" and
       .raw.status == "succeeded" and
       (.raw.analyzeResult | type) == "object" and
       .raw.provider != "stub"
     ' "$response_file" >/dev/null; then
    rm -rf "$work_dir"
    return 1
  fi
  response_request_id="$(awk -F': *' '
    tolower($1) == "x-request-id" { gsub("\\r", "", $2); print $2; exit }
  ' "$headers_file")"
  if [[ "$response_request_id" != "$DEPLOY_TRACE_ID" ]]; then
    rm -rf "$work_dir"
    return 1
  fi
  rm -rf "$work_dir"

  log_filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND resource.labels.revision_name=\"${CANDIDATE_REVISION}\" AND jsonPayload.request_id=\"${DEPLOY_TRACE_ID}\" AND jsonPayload.message=\"[OCR_MONITORING] scan\""
  telemetry_filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND resource.labels.revision_name=\"${CANDIDATE_REVISION}\" AND jsonPayload.message=\"otel telemetry enabled\""
  for _ in {1..18}; do
    log_match="$("$GCLOUD" logging read "$log_filter" \
      --project="$PROJECT" --freshness=15m --limit=1 \
      --format='value(jsonPayload.provider,jsonPayload.status)' 2>/dev/null || true)"
    telemetry_match="$("$GCLOUD" logging read "$telemetry_filter" \
      --project="$PROJECT" --freshness=15m --limit=1 \
      --format='value(jsonPayload.service_name)' 2>/dev/null || true)"
    if [[ "$log_match" == *"azure-di"* && "$log_match" == *"ok"* &&
          "$telemetry_match" == *"ocr"* ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

if ! probe_provider_and_logs; then
  echo ">> candidate failed real Azure/provider + request-id log + OTel startup proof; production is unchanged" >&2
  exit 1
fi

PRODUCTION_BEFORE_PROMOTION="$("$GCLOUD" run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"
CURRENT_PRODUCTION_REVISION="$(printf '%s' "$PRODUCTION_BEFORE_PROMOTION" | jq -r \
  '.status.traffic[] | select(.percent == 100) | .revisionName')"
if [[ "$CURRENT_PRODUCTION_REVISION" != "$PREVIOUS_REVISION" ]]; then
  echo ">> production traffic changed during candidate proof; refusing to promote over the new owner" >&2
  exit 1
fi

echo ">> candidate verified; promoting ${CANDIDATE_REVISION} to 100%"
PROMOTION_ROLLBACK_ARMED=true
"$GCLOUD" run services update-traffic "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --to-revisions="${CANDIDATE_REVISION}=100" \
  --quiet

URL="$("$GCLOUD" run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
if ! probe_ocr "$URL"; then
  echo ">> promoted OCR revision failed canonical proof; exit trap will roll back to ${PREVIOUS_REVISION}" >&2
  exit 1
fi

"$GCLOUD" run services update-traffic "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --remove-tags="$CANDIDATE_TAG" --quiet
PROMOTION_ROLLBACK_ARMED=false
CANDIDATE_CLEANUP_ARMED=false
echo ">> ${CANDIDATE_REVISION} is healthy at 100%; health, challenge, Azure OCR, request-id logging, and OTel startup verified"
