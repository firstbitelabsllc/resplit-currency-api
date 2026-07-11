#!/usr/bin/env bash
# Provisions the additive OCR stdout -> Pub/Sub -> synchronous Loki forwarder.
# The sink starts and stays disabled. ACTIVATE=1 authorizes resource creation
# and candidate staging only; verify-ocr-loki-export.sh owns proof/promotion.
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-resplit-fx}"
SERVICE="${SERVICE:-ocr-loki-forwarder}"
IMAGE="${IMAGE:?set IMAGE to an immutable resplit-fx/ocr-loki-forwarder@sha256: digest}"
GCLOUD="${GCLOUD:-/opt/homebrew/share/google-cloud-sdk/bin/gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud
command -v jq >/dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-artifact-runtime-image.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/resolve-artifact-runtime-image.sh"

TOPIC="ocr-loki-logs"
DLQ_TOPIC="ocr-loki-logs-dlq"
SUBSCRIPTION="ocr-loki-logs-push"
DLQ_SUBSCRIPTION="ocr-loki-logs-dlq-inspect"
SINK="ocr-loki-export"
RUNTIME_SA_NAME="ocr-loki-forwarder"
PUSH_SA_NAME="ocr-loki-push"
LOKI_SECRET="grafana-otlp-auth-header"
LOKI_URL="${LOKI_URL:-https://logs-prod-036.grafana.net/loki/api/v1/push}"
EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/ocr-loki-forwarder@sha256:"
DIGEST="${IMAGE#"$EXPECTED_IMAGE_PREFIX"}"

if [[ "$IMAGE" != "${EXPECTED_IMAGE_PREFIX}"* ]] || [[ ! "$DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> refusing non-canonical image; expected ${EXPECTED_IMAGE_PREFIX}<64-lowercase-hex>" >&2
  exit 2
fi
if [[ "$LOKI_URL" != https://logs-prod-[0-9][0-9][0-9].grafana.net/loki/api/v1/push ]]; then
  echo ">> refusing non-canonical Grafana Loki endpoint" >&2
  exit 2
fi
LOG_FILTER='resource.type="cloud_run_revision"
resource.labels.service_name="ocr"
log_id("run.googleapis.com/stdout")'

if [[ "${ACTIVATE:-0}" != "1" ]]; then
  echo ">> dry run: source contract validated; no cloud mutation attempted"
  echo ">> activation requires ACTIVATE=1 and creates separately billed GCP resources"
  exit 0
fi

if ! EXPECTED_RUNTIME_IMAGE="$(resolve_artifact_linux_amd64_image "$GCLOUD" "$IMAGE")"; then
  echo ">> unable to resolve one reviewed linux/amd64 forwarder image" >&2
  exit 1
fi

PROJECT_NUMBER="$($GCLOUD projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
PUSH_SA="${PUSH_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

SECRET_VERSION="$($GCLOUD secrets versions list "$LOKI_SECRET" \
  --project="$PROJECT" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 \
  --format='value(name)')"
if [[ ! "$SECRET_VERSION" =~ ^[0-9]+$ ]]; then
  echo ">> ${LOKI_SECRET} has no enabled version; no secret value was read" >&2
  exit 1
fi

EXPECTED_DESTINATION="pubsub.googleapis.com/projects/${PROJECT}/topics/${TOPIC}"
SINK_EXISTS=0
if "$GCLOUD" logging sinks describe "$SINK" --project="$PROJECT" >/dev/null 2>&1; then
  SINK_EXISTS=1
  SINK_JSON="$($GCLOUD logging sinks describe "$SINK" --project="$PROJECT" --format=json)"
  if [[ "$(printf '%s' "$SINK_JSON" | jq -r .destination)" != "$EXPECTED_DESTINATION" ]] ||
     [[ "$(printf '%s' "$SINK_JSON" | jq -r .filter)" != "$LOG_FILTER" ]]; then
    echo ">> existing sink drifted; refusing to mutate runtime" >&2
    exit 1
  fi
  if [[ "$(printf '%s' "$SINK_JSON" | jq -r .disabled)" != "true" ]]; then
    echo ">> disable ${SINK} before staging a new forwarder; the queue is preserved" >&2
    exit 1
  fi
fi

SERVICE_EXISTS=0
if "$GCLOUD" run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
  SERVICE_EXISTS=1
  SERVICE_BEFORE_JSON="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
  PREVIOUS_REVISION="$(printf '%s' "$SERVICE_BEFORE_JSON" | jq -r \
    '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] | if length == 1 then .[0] else "" end')"
  if [[ -z "$PREVIOUS_REVISION" ]]; then
    echo ">> forwarder traffic is not one reviewed 100% revision; refusing to stage" >&2
    exit 1
  fi
fi

ensure_service_account() {
  local name="$1"
  if ! "$GCLOUD" iam service-accounts describe "${name}@${PROJECT}.iam.gserviceaccount.com" \
    --project="$PROJECT" >/dev/null 2>&1; then
    "$GCLOUD" iam service-accounts create "$name" --project="$PROJECT" \
      --display-name="$name"
  fi
}

ensure_topic() {
  local topic="$1"
  local retention="$2"
  if ! "$GCLOUD" pubsub topics describe "$topic" --project="$PROJECT" >/dev/null 2>&1; then
    "$GCLOUD" pubsub topics create "$topic" --project="$PROJECT" \
      --message-retention-duration="$retention"
  fi
}

ensure_service_account "$RUNTIME_SA_NAME"
ensure_service_account "$PUSH_SA_NAME"
ensure_topic "$TOPIC" 7d
ensure_topic "$DLQ_TOPIC" 14d

"$GCLOUD" secrets add-iam-policy-binding "$LOKI_SECRET" --project="$PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null

CANDIDATE_TAG="candidate-${DIGEST:0:12}"
TRAFFIC_ARGS=(--tag="$CANDIDATE_TAG")
if [[ "$SERVICE_EXISTS" == "1" ]]; then
  TRAFFIC_ARGS=(--no-traffic --tag="$CANDIDATE_TAG")
fi

"$GCLOUD" run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --image="$EXPECTED_RUNTIME_IMAGE" --service-account="$RUNTIME_SA" --port=8080 \
  --ingress=internal --no-allow-unauthenticated --concurrency=20 --timeout=30 \
  --cpu=1 --memory=256Mi --min-instances=0 --max-instances=3 \
  --startup-probe="httpGet.path=/health,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=3,failureThreshold=3" \
  --update-env-vars="LOKI_URL=${LOKI_URL}" \
  --update-secrets="LOKI_AUTH_HEADER=${LOKI_SECRET}:${SECRET_VERSION}" \
  "${TRAFFIC_ARGS[@]}" --quiet

SERVICE_JSON="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
SERVICE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r .status.url)"
CANDIDATE_REVISION="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .revisionName] | if length == 1 then .[0] else "" end')"
CANDIDATE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .url] | if length == 1 then .[0] else "" end')"
if [[ -z "$CANDIDATE_REVISION" ]] || [[ "$CANDIDATE_URL" != https://* ]]; then
  echo ">> candidate tag readback failed; stable traffic was not promoted" >&2
  exit 1
fi
DEPLOYED_IMAGE="$($GCLOUD run revisions describe "$CANDIDATE_REVISION" --project="$PROJECT" \
  --region="$REGION" --format='value(spec.containers[0].image)')"
if [[ "$DEPLOYED_IMAGE" != "$EXPECTED_RUNTIME_IMAGE" ]]; then
  echo ">> deployed forwarder image does not match the reviewed digest" >&2
  exit 1
fi
if [[ "$SERVICE_EXISTS" == "1" ]] && printf '%s' "$SERVICE_JSON" | jq -e --arg revision "$CANDIDATE_REVISION" \
  '.status.traffic[] | select(.revisionName == $revision and (.percent // 0) > 0)' >/dev/null; then
  "$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
    --to-revisions="${PREVIOUS_REVISION}=100" --quiet
  echo ">> candidate unexpectedly received stable traffic; restored ${PREVIOUS_REVISION}" >&2
  exit 1
fi

"$GCLOUD" run services add-iam-policy-binding "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --member="serviceAccount:${PUSH_SA}" \
  --role=roles/run.invoker >/dev/null
"$GCLOUD" iam service-accounts add-iam-policy-binding "$PUSH_SA" --project="$PROJECT" \
  --member="serviceAccount:${PUBSUB_AGENT}" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null

if [[ "$SINK_EXISTS" == "0" ]]; then
  "$GCLOUD" logging sinks create "$SINK" \
    "pubsub.googleapis.com/projects/${PROJECT}/topics/${TOPIC}" \
    --project="$PROJECT" --log-filter="$LOG_FILTER" --unique-writer-identity --disabled
fi
SINK_JSON="$($GCLOUD logging sinks describe "$SINK" --project="$PROJECT" --format=json)"
if [[ "$(printf '%s' "$SINK_JSON" | jq -r .destination)" != "$EXPECTED_DESTINATION" ]] ||
   [[ "$(printf '%s' "$SINK_JSON" | jq -r .filter)" != "$LOG_FILTER" ]]; then
  echo ">> existing sink drifted; refusing to repair or broaden it automatically" >&2
  exit 1
fi
if [[ "$(printf '%s' "$SINK_JSON" | jq -r .disabled)" != "true" ]]; then
  echo ">> source staging must leave ${SINK} disabled" >&2
  exit 1
fi
SINK_WRITER="$(printf '%s' "$SINK_JSON" | jq -r .writerIdentity)"
"$GCLOUD" pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT" \
  --member="$SINK_WRITER" --role=roles/pubsub.publisher >/dev/null

if ! "$GCLOUD" pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT" >/dev/null 2>&1; then
  "$GCLOUD" pubsub subscriptions create "$SUBSCRIPTION" --project="$PROJECT" \
    --topic="$TOPIC" --push-endpoint="${SERVICE_URL}/pubsub/push" \
    --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$SERVICE_URL" \
    --ack-deadline=30 --message-retention-duration=7d --expiration-period=never \
    --min-retry-delay=10s --max-retry-delay=600s \
    --dead-letter-topic="$DLQ_TOPIC" --max-delivery-attempts=10
fi
if ! "$GCLOUD" pubsub subscriptions describe "$DLQ_SUBSCRIPTION" --project="$PROJECT" >/dev/null 2>&1; then
  "$GCLOUD" pubsub subscriptions create "$DLQ_SUBSCRIPTION" --project="$PROJECT" \
    --topic="$DLQ_TOPIC" --message-retention-duration=14d --expiration-period=never
fi

SUBSCRIPTION_JSON="$($GCLOUD pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT" --format=json)"
EXPECTED_TOPIC="projects/${PROJECT}/topics/${TOPIC}"
EXPECTED_DLQ_TOPIC="projects/${PROJECT}/topics/${DLQ_TOPIC}"
if ! printf '%s' "$SUBSCRIPTION_JSON" | jq -e \
  --arg topic "$EXPECTED_TOPIC" \
  --arg endpoint "${SERVICE_URL}/pubsub/push" \
  --arg service_account "$PUSH_SA" \
  --arg audience "$SERVICE_URL" \
  --arg dlq "$EXPECTED_DLQ_TOPIC" \
  '.topic == $topic and
   .pushConfig.pushEndpoint == $endpoint and
   .pushConfig.oidcToken.serviceAccountEmail == $service_account and
   .pushConfig.oidcToken.audience == $audience and
   .ackDeadlineSeconds == 30 and
   .messageRetentionDuration == "604800s" and
   ((.expirationPolicy.ttl // "") == "") and
   .retryPolicy.minimumBackoff == "10s" and
   .retryPolicy.maximumBackoff == "600s" and
   .deadLetterPolicy.deadLetterTopic == $dlq and
   .deadLetterPolicy.maxDeliveryAttempts == 10' >/dev/null; then
  echo ">> existing source subscription drifted; refusing to enable export" >&2
  exit 1
fi

DLQ_SUBSCRIPTION_JSON="$($GCLOUD pubsub subscriptions describe "$DLQ_SUBSCRIPTION" --project="$PROJECT" --format=json)"
if ! printf '%s' "$DLQ_SUBSCRIPTION_JSON" | jq -e \
  --arg topic "$EXPECTED_DLQ_TOPIC" \
  '.topic == $topic and
   .messageRetentionDuration == "1209600s" and
   ((.expirationPolicy.ttl // "") == "") and
   ((.pushConfig.pushEndpoint // "") == "")' >/dev/null; then
  echo ">> existing dead-letter subscription drifted; refusing to enable export" >&2
  exit 1
fi

"$GCLOUD" pubsub topics add-iam-policy-binding "$DLQ_TOPIC" --project="$PROJECT" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.publisher >/dev/null
"$GCLOUD" pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" --project="$PROJECT" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.subscriber >/dev/null

echo ">> staged ${CANDIDATE_REVISION} at ${CANDIDATE_URL}; stable traffic remains unchanged when a prior revision exists"
echo ">> ${SINK} remains disabled; verify-ocr-loki-export.sh must prove and promote this exact digest"
echo ">> rollback preserves the queue: gcloud logging sinks update ${SINK} --project=${PROJECT} --disabled"
