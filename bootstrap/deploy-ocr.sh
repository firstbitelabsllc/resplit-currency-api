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
#   bootstrap/deploy-ocr.sh                 # deploy :latest
#   IMAGE=…/ocr:<sha> bootstrap/deploy-ocr.sh   # deploy a pinned digest (preferred)
set -euo pipefail

PROJECT="${PROJECT:-resplit-fx-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ocr}"
IMAGE="${IMAGE:-us-central1-docker.pkg.dev/${PROJECT}/resplit-fx/ocr:latest}"
RUNTIME_SA="${RUNTIME_SA:-903653538868-compute@developer.gserviceaccount.com}"
GCLOUD="${GCLOUD:-/opt/homebrew/share/google-cloud-sdk/bin/gcloud}"
command -v "$GCLOUD" >/dev/null 2>&1 || GCLOUD=gcloud

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

echo ">> deploying ${SERVICE} (${IMAGE}) to ${PROJECT}/${REGION}"

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
  `# ── LOAD-BEARING #1: CPU always allocated while an instance is alive. ──` \
  `# Cloud Run's default throttles CPU to ~0 between requests, which FREEZES` \
  `# the OTel periodic metric reader + batch span exporter goroutines. Result:` \
  `# scans return 200 but ocr_scans_total never increments and no trace ships.` \
  `# Removing this flag silently kills all Grafana telemetry. Scales to zero` \
  `# fine; idle instances bill nothing once torn down.` \
  --no-cpu-throttling \
  `# ── LOAD-BEARING #2: the OTLP endpoint is the master telemetry switch. ──` \
  `# cmd/ocr/main.go only builds the OTLP exporters when this is set; unset =` \
  `# NoopExporters = silent no telemetry. A --set-env-vars (REPLACE semantics)` \
  `# once wiped this and took Grafana dark with zero errors. Use ^@@^ multi-var` \
  `# delimiter so the comma-free values pass through cleanly.` \
  --set-env-vars="^@@^OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}@@OTEL_SERVICE_NAME=${SERVICE}@@OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf@@GCP_PROJECT_ID=${PROJECT}@@AZURE_OCR_ENDPOINT=${AZURE_OCR_ENDPOINT}" \
  `# ── LOAD-BEARING #3: secrets, never plaintext. ──` \
  `# Azure DI key + Grafana OTLP auth header both come from Secret Manager.` \
  `# The runtime SA needs roles/secretmanager.secretAccessor on each (granted` \
  `# in setup-gcp.sh / via add-iam-policy-binding).` \
  --set-secrets="AZURE_OCR_KEY=resplit-fx-azure-di-key:latest,OTEL_EXPORTER_OTLP_HEADERS=grafana-otlp-auth-header:latest" \
  --quiet

echo ">> deployed. verifying telemetry export is alive…"
URL="$("$GCLOUD" run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
echo ">> service URL: ${URL}"
echo ">> send a scan + check Grafana for ocr_scans_total to confirm (see vidux/pre-launch-architecture)."
