#!/usr/bin/env bash
# Proves a staged OCR Loki forwarder through an isolated Pub/Sub subscription,
# then promotes it. ENABLE_SINK=1 additionally proves the real Cloud Logging
# sink before export may remain enabled. No credential value is printed/copied.
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-resplit-fx}"
SERVICE="${SERVICE:-ocr-loki-forwarder}"
IMAGE="${IMAGE:?set IMAGE to the reviewed ocr-loki-forwarder@sha256: digest}"
GCLOUD="${GCLOUD:-/opt/homebrew/share/google-cloud-sdk/bin/gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-artifact-runtime-image.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/resolve-artifact-runtime-image.sh"

TOPIC="ocr-loki-logs"
DLQ_TOPIC="ocr-loki-logs-dlq"
SUBSCRIPTION="ocr-loki-logs-push"
DLQ_SUBSCRIPTION="ocr-loki-logs-dlq-inspect"
LEASE_SUBSCRIPTION="ocr-loki-export-lease"
SINK="ocr-loki-export"
PUSH_SA="ocr-loki-push@${PROJECT}.iam.gserviceaccount.com"
LOKI_PUSH_URL="${LOKI_URL:-https://logs-prod-036.grafana.net/loki/api/v1/push}"
LOKI_QUERY_URL="${LOKI_PUSH_URL%/loki/api/v1/push}/loki/api/v1/query_range"
EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/ocr-loki-forwarder@sha256:"
EXPECTED_DESTINATION="pubsub.googleapis.com/projects/${PROJECT}/topics/${TOPIC}"
EXPECTED_TOPIC="projects/${PROJECT}/topics/${TOPIC}"
EXPECTED_DLQ_TOPIC="projects/${PROJECT}/topics/${DLQ_TOPIC}"
LOG_FILTER='resource.type="cloud_run_revision"
resource.labels.service_name="ocr"
log_id("run.googleapis.com/stdout")'

DIGEST="${IMAGE#"$EXPECTED_IMAGE_PREFIX"}"
if [[ "$IMAGE" != "${EXPECTED_IMAGE_PREFIX}"* ]] || [[ ! "$DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo ">> refusing non-canonical image digest" >&2
  exit 2
fi
if [[ "$LOKI_PUSH_URL" != https://logs-prod-[0-9][0-9][0-9].grafana.net/loki/api/v1/push ]]; then
  echo ">> refusing non-canonical Grafana Loki endpoint" >&2
  exit 2
fi
if [[ "${ACTIVATE:-0}" != "1" ]]; then
  echo ">> dry run: verifier source contract validated; no cloud read or mutation attempted"
  echo ">> proof/promotion requires ACTIVATE=1 and uses separately billed GCP resources"
  exit 0
fi

GRAFANA_LOKI_USER="${GRAFANA_LOKI_USER:?set the read-only Grafana Loki instance id}"
GRAFANA_TOKEN="${GRAFANA_TOKEN:?set a Grafana token that can query Loki}"
command -v base64 >/dev/null
command -v curl >/dev/null
command -v jq >/dev/null
command -v openssl >/dev/null

EXPECTED_RUNTIME_IMAGE="$(resolve_artifact_linux_amd64_image "$GCLOUD" "$IMAGE")"
CANDIDATE_TAG="candidate-${DIGEST:0:12}"
OWNER_ID="$(openssl rand -hex 16)"
PROOF_SUBSCRIPTION="ocr-loki-proof-${OWNER_ID:0:16}"
PROJECT_NUMBER="$($GCLOUD projects describe "$PROJECT" --format='value(projectNumber)')"
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

SERVICE_JSON="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
SERVICE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r .status.url)"
PREVIOUS_REVISION="$(printf '%s' "$SERVICE_JSON" | jq -r \
  '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] | if length == 1 then .[0] else "" end')"
CANDIDATE_REVISION="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .revisionName] | if length == 1 then .[0] else "" end')"
CANDIDATE_URL="$(printf '%s' "$SERVICE_JSON" | jq -r --arg tag "$CANDIDATE_TAG" \
  '[.status.traffic[] | select(.tag == $tag) | .url] | if length == 1 then .[0] else "" end')"
if [[ "$SERVICE_URL" != https://* ]] || [[ -z "$PREVIOUS_REVISION" ]] ||
   [[ -z "$CANDIDATE_REVISION" ]] || [[ "$CANDIDATE_URL" != https://* ]]; then
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
EXPECTED_SINK_WRITER="$(printf '%s' "$SINK_JSON" | jq -r .writerIdentity)"
if [[ ! "$EXPECTED_SINK_WRITER" =~ ^serviceAccount:service-[0-9]+@gcp-sa-logging\.iam\.gserviceaccount\.com$ ]]; then
  echo ">> sink writer identity is not the reviewed unique-writer shape" >&2
  exit 1
fi

retry_command() {
  local _
  for _ in 1 2 3; do
    if "$@"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

current_traffic_revision() {
  "$GCLOUD" run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json | jq -r \
    '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] | if length == 1 then .[0] else "" end'
}

assert_candidate_shape() {
  local expected_traffic="$1"
  local current_json current_traffic current_candidate current_url
  current_json="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)"
  current_traffic="$(printf '%s' "$current_json" | jq -r \
    '[.status.traffic[] | select((.percent // 0) == 100) | .revisionName] | if length == 1 then .[0] else "" end')"
  current_candidate="$(printf '%s' "$current_json" | jq -r --arg tag "$CANDIDATE_TAG" \
    '[.status.traffic[] | select(.tag == $tag) | .revisionName] | if length == 1 then .[0] else "" end')"
  current_url="$(printf '%s' "$current_json" | jq -r --arg tag "$CANDIDATE_TAG" \
    '[.status.traffic[] | select(.tag == $tag) | .url] | if length == 1 then .[0] else "" end')"
  [[ "$current_traffic" == "$expected_traffic" ]] &&
    [[ "$current_candidate" == "$CANDIDATE_REVISION" ]] &&
    [[ "$current_url" == "$CANDIDATE_URL" ]]
}

assert_lease_owner() {
  local lease_json
  lease_json="$($GCLOUD pubsub subscriptions describe "$LEASE_SUBSCRIPTION" --project="$PROJECT" --format=json)" || return 1
  printf '%s' "$lease_json" | jq -e \
    --arg topic "$EXPECTED_DLQ_TOPIC" --arg owner "$OWNER_ID" \
    '.topic == $topic and
     .labels.resplit_owner == $owner and
     .ackDeadlineSeconds == 10 and
     .messageRetentionDuration == "600s" and
     .expirationPolicy.ttl == "86400s" and
     ((.pushConfig.pushEndpoint // "") == "")' >/dev/null
}

assert_sink_shape() {
  local expected_disabled="$1"
  local sink_json
  sink_json="$($GCLOUD logging sinks describe "$SINK" --project="$PROJECT" --format=json)" || return 1
  printf '%s' "$sink_json" | jq -e \
    --arg destination "$EXPECTED_DESTINATION" --arg filter "$LOG_FILTER" \
    --arg writer "$EXPECTED_SINK_WRITER" --argjson disabled "$expected_disabled" \
    '.destination == $destination and .filter == $filter and
     .writerIdentity == $writer and .disabled == $disabled and
     ((.exclusions // []) | length == 0)' >/dev/null
}

policy_has_member() {
  local policy_json="$1"
  local role="$2"
  local member="$3"
  printf '%s' "$policy_json" | jq -e --arg role "$role" --arg member "$member" \
    'any(.bindings[]?; .role == $role and any(.members[]?; . == $member))' >/dev/null
}

assert_access_and_privacy() {
  local service_json run_policy source_topic_policy dlq_topic_policy source_subscription_policy push_sa_policy
  service_json="$($GCLOUD run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)" || return 1
  if [[ "$(printf '%s' "$service_json" | jq -r '.metadata.annotations["run.googleapis.com/ingress"] // ""')" != "internal" ]]; then
    return 1
  fi

  run_policy="$($GCLOUD run services get-iam-policy "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json)" || return 1
  policy_has_member "$run_policy" roles/run.invoker "serviceAccount:${PUSH_SA}" || return 1
  printf '%s' "$run_policy" | jq -e \
    '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0' >/dev/null || return 1

  source_topic_policy="$($GCLOUD pubsub topics get-iam-policy "$TOPIC" --project="$PROJECT" --format=json)" || return 1
  policy_has_member "$source_topic_policy" roles/pubsub.publisher "$EXPECTED_SINK_WRITER" || return 1
  dlq_topic_policy="$($GCLOUD pubsub topics get-iam-policy "$DLQ_TOPIC" --project="$PROJECT" --format=json)" || return 1
  policy_has_member "$dlq_topic_policy" roles/pubsub.publisher "serviceAccount:${PUBSUB_AGENT}" || return 1
  source_subscription_policy="$($GCLOUD pubsub subscriptions get-iam-policy "$SUBSCRIPTION" --project="$PROJECT" --format=json)" || return 1
  policy_has_member "$source_subscription_policy" roles/pubsub.subscriber "serviceAccount:${PUBSUB_AGENT}" || return 1
  push_sa_policy="$($GCLOUD iam service-accounts get-iam-policy "$PUSH_SA" --project="$PROJECT" --format=json)" || return 1
  policy_has_member "$push_sa_policy" roles/iam.serviceAccountTokenCreator "serviceAccount:${PUBSUB_AGENT}"
}

assert_source_subscription_shape() {
  local subscription_json
  subscription_json="$($GCLOUD pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT" --format=json)" || return 1
  printf '%s' "$subscription_json" | jq -e \
    --arg topic "$EXPECTED_TOPIC" --arg endpoint "${SERVICE_URL}/pubsub/push" \
    --arg service_account "$PUSH_SA" --arg audience "$SERVICE_URL" \
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
     .deadLetterPolicy.maxDeliveryAttempts == 10' >/dev/null
}

assert_dlq_subscription_shape() {
  local subscription_json
  subscription_json="$($GCLOUD pubsub subscriptions describe "$DLQ_SUBSCRIPTION" --project="$PROJECT" --format=json)" || return 1
  printf '%s' "$subscription_json" | jq -e --arg topic "$EXPECTED_DLQ_TOPIC" \
    '.topic == $topic and
     .messageRetentionDuration == "1209600s" and
     ((.expirationPolicy.ttl // "") == "") and
     ((.pushConfig.pushEndpoint // "") == "")' >/dev/null
}

assert_topic_shapes() {
  local topic_json dlq_json
  topic_json="$($GCLOUD pubsub topics describe "$TOPIC" --project="$PROJECT" --format=json)" || return 1
  dlq_json="$($GCLOUD pubsub topics describe "$DLQ_TOPIC" --project="$PROJECT" --format=json)" || return 1
  [[ "$(printf '%s' "$topic_json" | jq -r .messageRetentionDuration)" == "604800s" ]] &&
    [[ "$(printf '%s' "$dlq_json" | jq -r .messageRetentionDuration)" == "1209600s" ]]
}

assert_topology() {
  local expected_disabled="$1"
  assert_lease_owner && assert_sink_shape "$expected_disabled" &&
    assert_topic_shapes && assert_source_subscription_shape &&
    assert_dlq_subscription_shape && assert_access_and_privacy
}

assert_proof_subscription_shape() {
  local proof_json
  proof_json="$($GCLOUD pubsub subscriptions describe "$PROOF_SUBSCRIPTION" --project="$PROJECT" --format=json)" || return 1
  printf '%s' "$proof_json" | jq -e \
    --arg topic "$EXPECTED_TOPIC" --arg endpoint "${CANDIDATE_URL}/pubsub/push" \
    --arg service_account "$PUSH_SA" --arg audience "$SERVICE_URL" --arg owner "$OWNER_ID" \
    '.topic == $topic and
     .labels.resplit_owner == $owner and
     .pushConfig.pushEndpoint == $endpoint and
     .pushConfig.oidcToken.serviceAccountEmail == $service_account and
     .pushConfig.oidcToken.audience == $audience and
     .ackDeadlineSeconds == 30 and
     .messageRetentionDuration == "600s" and
     .expirationPolicy.ttl == "86400s" and
     .retryPolicy.minimumBackoff == "10s" and
     .retryPolicy.maximumBackoff == "60s"' >/dev/null
}

LEASE_HELD=0
LEASE_RELEASE_UNCERTAIN=0
PROOF_CREATED=0
PROMOTION_ATTEMPTED=0
SINK_ENABLED_BY_RUN=0

subscription_absent() {
  local subscription="$1"
  local expected="projects/${PROJECT}/subscriptions/${subscription}"
  local list_json _
  for _ in 1 2 3; do
    if list_json="$($GCLOUD pubsub subscriptions list --project="$PROJECT" --format=json 2>/dev/null)"; then
      if printf '%s' "$list_json" | jq -e --arg expected "$expected" --arg short "$subscription" \
        '[.[] | select((.name // "") == $expected or (.name // "") == $short)] | length == 0' >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

acquire_lease() {
  if "$GCLOUD" pubsub subscriptions create "$LEASE_SUBSCRIPTION" --project="$PROJECT" \
    --topic="$DLQ_TOPIC" --ack-deadline=10 --message-retention-duration=10m \
    --expiration-period=1d --labels="resplit_owner=${OWNER_ID}" >/dev/null; then
    LEASE_HELD=1
  else
    local existing_owner
    existing_owner="$($GCLOUD pubsub subscriptions describe "$LEASE_SUBSCRIPTION" \
      --project="$PROJECT" --format='value(labels.resplit_owner)' 2>/dev/null || true)"
    if [[ "$existing_owner" == "$OWNER_ID" ]]; then
      LEASE_HELD=1
    else
      echo ">> another owner holds ${LEASE_SUBSCRIPTION}; refusing shared mutation" >&2
      return 1
    fi
  fi
  if ! assert_lease_owner; then
    echo ">> lease readback failed" >&2
    return 1
  fi
}

release_lease() {
  [[ "$LEASE_HELD" == "1" ]] || return 0

  # Absence is the release commit boundary. A delete can commit remotely while
  # its client observes a transport failure, so command status alone cannot
  # decide whether shared rollback is still safe.
  if subscription_absent "$LEASE_SUBSCRIPTION"; then
    LEASE_HELD=0
    LEASE_RELEASE_UNCERTAIN=0
    return 0
  fi
  if ! assert_lease_owner; then
    LEASE_RELEASE_UNCERTAIN=1
    echo ">> lease state is uncertain; refusing unlocked shared rollback" >&2
    return 1
  fi

  local attempt
  for attempt in 1 2 3; do
    "$GCLOUD" pubsub subscriptions delete "$LEASE_SUBSCRIPTION" \
      --project="$PROJECT" --quiet >/dev/null 2>&1 || true
    if subscription_absent "$LEASE_SUBSCRIPTION"; then
      LEASE_HELD=0
      LEASE_RELEASE_UNCERTAIN=0
      return 0
    fi
    if ! assert_lease_owner; then
      LEASE_RELEASE_UNCERTAIN=1
      echo ">> lease state is uncertain after delete; refusing unlocked shared rollback" >&2
      return 1
    fi
    [[ "$attempt" == "3" ]] || sleep 2
  done

  echo ">> lease delete failed; ownership remains held for safe recovery" >&2
  return 1
}

cleanup_proof_subscription() {
  [[ "$PROOF_CREATED" == "1" ]] || return 0
  if "$GCLOUD" pubsub subscriptions describe "$PROOF_SUBSCRIPTION" --project="$PROJECT" >/dev/null 2>&1; then
    local proof_owner
    proof_owner="$($GCLOUD pubsub subscriptions describe "$PROOF_SUBSCRIPTION" \
      --project="$PROJECT" --format='value(labels.resplit_owner)' 2>/dev/null || true)"
    if [[ "$proof_owner" != "$OWNER_ID" ]]; then
      echo ">> proof subscription ownership changed; refusing foreign cleanup" >&2
      return 1
    fi
    if ! retry_command "$GCLOUD" pubsub subscriptions delete "$PROOF_SUBSCRIPTION" \
      --project="$PROJECT" --quiet >/dev/null 2>&1; then
      echo ">> proof subscription delete failed" >&2
      return 1
    fi
  fi
  if ! subscription_absent "$PROOF_SUBSCRIPTION"; then
    echo ">> proof subscription absence readback failed" >&2
    return 1
  fi
  PROOF_CREATED=0
}

restore_traffic() {
  [[ "$PROMOTION_ATTEMPTED" == "1" ]] || return 0
  local current
  current="$(current_traffic_revision)"
  if [[ "$current" == "$PREVIOUS_REVISION" ]]; then
    PROMOTION_ATTEMPTED=0
    return 0
  fi
  if [[ "$current" != "$CANDIDATE_REVISION" ]]; then
    echo ">> traffic moved to ${current:-an invalid split}; refusing to clobber a newer owner" >&2
    return 1
  fi
  if ! assert_lease_owner; then
    echo ">> lease ownership lost before traffic rollback" >&2
    return 1
  fi
  retry_command "$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" \
    --region="$REGION" --to-revisions="${PREVIOUS_REVISION}=100" --quiet >/dev/null 2>&1 || true
  if [[ "$(current_traffic_revision)" != "$PREVIOUS_REVISION" ]]; then
    echo ">> traffic rollback readback failed" >&2
    return 1
  fi
  PROMOTION_ATTEMPTED=0
}

disable_sink() {
  [[ "$SINK_ENABLED_BY_RUN" == "1" ]] || return 0
  if ! assert_lease_owner; then
    echo ">> lease ownership lost before sink rollback; refusing foreign mutation" >&2
    return 1
  fi
  if ! retry_command "$GCLOUD" logging sinks update "$SINK" --project="$PROJECT" \
    --disabled >/dev/null 2>&1; then
    echo ">> sink disable rollback command failed" >&2
    return 1
  fi
  if ! assert_sink_shape true; then
    echo ">> sink disable rollback readback failed" >&2
    return 1
  fi
  SINK_ENABLED_BY_RUN=0
}

rollback() {
  local original_exit=$?
  local failures=0
  trap - EXIT
  set +e
  if [[ "$LEASE_RELEASE_UNCERTAIN" == "1" ]]; then
    echo ">> ROLLBACK_REFUSED: lease release is uncertain; inspect sink, traffic, and lease before mutation" >&2
    exit 70
  fi
  disable_sink || failures=$((failures + 1))
  cleanup_proof_subscription || failures=$((failures + 1))
  restore_traffic || failures=$((failures + 1))
  if [[ "$failures" == "0" ]]; then
    release_lease || failures=$((failures + 1))
  else
    echo ">> rollback incomplete; retaining the expiring lease for manual recovery" >&2
  fi
  if [[ "$failures" != "0" ]]; then
    echo ">> ROLLBACK_FAILURE count=${failures}; inspect sink, proof subscription, traffic, and lease" >&2
    exit 70
  fi
  exit "$original_exit"
}

# The initial checks are read-only. The fixed-name subscription create below is
# the first mutation and is atomic: another verifier/deployer cannot share it.
if ! assert_sink_shape true || ! assert_topic_shapes ||
   ! assert_source_subscription_shape || ! assert_dlq_subscription_shape; then
  echo ">> source topology drifted; refusing proof mutation" >&2
  exit 1
fi
trap rollback EXIT
acquire_lease
assert_topology true
assert_candidate_shape "$PREVIOUS_REVISION"

AUTH_B64="$(printf '%s:%s' "$GRAFANA_LOKI_USER" "$GRAFANA_TOKEN" | base64 | tr -d '\n')"
query_loki() {
  local request_id="$1"
  local expected_revision="$2"
  local now start_ns end_ns query response
  now="$(date -u +%s)"
  start_ns="$((now - 300))000000000"
  end_ns="$((now + 300))000000000"
  query="{environment=\"production\",service_name=\"ocr\",source=\"gcp_cloud_logging\"} | json | request_id=\"${request_id}\" | forwarder_revision=\"${expected_revision}\""
  if ! response="$(printf 'header = "Authorization: Basic %s"\n' "$AUTH_B64" | \
    curl --config - --silent --show-error --fail-with-body --get "$LOKI_QUERY_URL" \
      --connect-timeout 3 --max-time 8 \
      --data-urlencode "query=${query}" --data-urlencode "start=${start_ns}" \
      --data-urlencode "end=${end_ns}" --data-urlencode 'limit=20')"; then
    return 1
  fi
  printf '%s' "$response" | jq -e --arg request_id "$request_id" --arg revision "$expected_revision" \
    '[.data.result[]?.values[]?[1] | fromjson? |
      select(.request_id == $request_id and .forwarder_revision == $revision)] | length >= 1' >/dev/null
}

wait_for_loki() {
  local request_id="$1"
  local expected_revision="$2"
  local _ deadline
  deadline=$((SECONDS + 90))
  for _ in {1..18}; do
    if query_loki "$request_id" "$expected_revision"; then
      return 0
    fi
    if ((SECONDS >= deadline)); then
      break
    fi
    sleep 5
  done
  return 1
}

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

assert_lease_owner
PROOF_CREATED=1
"$GCLOUD" pubsub subscriptions create "$PROOF_SUBSCRIPTION" --project="$PROJECT" \
  --topic="$TOPIC" --push-endpoint="${CANDIDATE_URL}/pubsub/push" \
  --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$SERVICE_URL" \
  --ack-deadline=30 --message-retention-duration=10m --expiration-period=1d \
  --min-retry-delay=10s --max-retry-delay=60s --labels="resplit_owner=${OWNER_ID}" >/dev/null
assert_proof_subscription_shape
"$GCLOUD" pubsub topics publish "$TOPIC" --project="$PROJECT" --message="$DIRECT_ENTRY" >/dev/null
if ! wait_for_loki "$DIRECT_REQUEST_ID" "$CANDIDATE_REVISION"; then
  echo ">> tagged candidate did not deliver its exact revision-bound proof to Loki" >&2
  exit 1
fi
cleanup_proof_subscription

assert_lease_owner
assert_topology true
assert_candidate_shape "$PREVIOUS_REVISION"
if [[ "$PREVIOUS_REVISION" != "$CANDIDATE_REVISION" ]]; then
  PROMOTION_ATTEMPTED=1
  "$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
    --to-revisions="${CANDIDATE_REVISION}=100" --quiet
fi
assert_candidate_shape "$CANDIDATE_REVISION"

if [[ "${ENABLE_SINK:-0}" != "1" ]]; then
  assert_topology true
  release_lease
  trap - EXIT
  echo ">> revision-bound candidate proof passed and ${CANDIDATE_REVISION} is live; sink remains disabled"
  exit 0
fi

assert_lease_owner
assert_topology true
assert_candidate_shape "$CANDIDATE_REVISION"
SINK_ENABLED_BY_RUN=1
"$GCLOUD" logging sinks update "$SINK" --project="$PROJECT" --no-disabled
assert_topology false

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
if ! wait_for_loki "$SINK_REQUEST_ID" "$CANDIDATE_REVISION"; then
  echo ">> enabled sink did not deliver the exact Cloud Logging proof; rolling back" >&2
  exit 1
fi

assert_lease_owner
assert_topology false
assert_candidate_shape "$CANDIDATE_REVISION"
"$GCLOUD" run services update-traffic "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --remove-tags="$CANDIDATE_TAG" --quiet
release_lease
trap - EXIT
echo ">> proved revision-bound Pub/Sub and Cloud Logging delivery for ${CANDIDATE_REVISION}; ${SINK} is enabled"
