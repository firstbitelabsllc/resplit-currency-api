#!/usr/bin/env bash
#
# bootstrap/setup-gcp.sh
# =============================================================================
# ONE-TIME GCP bootstrap for the resplit-currency-api Go/GCP rewrite.
#
# Run this ONCE, by hand, as a solo dev, before you ever run Terraform. It does
# the chicken-and-egg things Terraform CANNOT do for itself:
#
#   1. Authenticate gcloud (interactive).
#   2. Create the GCP project (or reuse it).
#   3. Link a billing account (interactive billing-account pick).
#   4. Enable the APIs that the Terraform `project-apis` module also enables
#      (so the very first `terraform plan` doesn't choke on a disabled API).
#   5. Create the GCS bucket that Terraform uses as its remote STATE backend.
#      (Terraform can't create the bucket that stores its own state — bootstrap.)
#   6. Stand up Workload Identity Federation (pool + GitHub OIDC provider) plus
#      a deployer service account, so CI deploys with NO long-lived JSON keys.
#   7. Print the exact values for `terraform.tfvars` and the GitHub repo secrets,
#      then print the exact next commands to run.
#
# EVERY step is guarded so re-running the script is SAFE (idempotent): it checks
# "does this already exist?" before creating, and skips with a note if so.
#
# Steps that REQUIRE a human (browser auth, picking a billing account) are
# tagged with the marker:  ### [INTERACTIVE / LEO-GATED] ###
# Everything else runs unattended.
#
# Usage:
#   chmod +x bootstrap/setup-gcp.sh
#   PROJECT_ID=resplit-fx-prod ./bootstrap/setup-gcp.sh
#
# Override any of the env vars at the top of the "Configuration" block below.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# gcloud on the path
# -----------------------------------------------------------------------------
# On THIS Mac the Cloud SDK lives under Homebrew's share dir, which is not always
# on a non-interactive shell's PATH. Prepend it so `gcloud`/`gsutil` resolve.
# Override GCLOUD_BIN if you're on a different machine.
GCLOUD_BIN="${GCLOUD_BIN:-/opt/homebrew/share/google-cloud-sdk/bin}"
if [[ -d "${GCLOUD_BIN}" ]]; then
  export PATH="${GCLOUD_BIN}:${PATH}"
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud not found. Expected it under ${GCLOUD_BIN}." >&2
  echo "       Install the Cloud SDK (brew install --cask google-cloud-sdk)" >&2
  echo "       or set GCLOUD_BIN to your install dir, then re-run." >&2
  exit 1
fi

# =============================================================================
# Configuration — override via environment variables
# =============================================================================

# The GCP project to create / use. Default per the decided architecture.
PROJECT_ID="${PROJECT_ID:-resplit-fx-prod}"

# Human-readable project name (shows in the console).
PROJECT_NAME="${PROJECT_NAME:-Resplit FX Prod}"

# Default region for regional resources (Cloud Run, Artifact Registry, buckets).
REGION="${REGION:-us-central1}"

# Terraform remote-state bucket. Globally unique; default derives from project.
# (GCS bucket names are global, so we suffix with the project id.)
TF_STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT_ID}-tfstate}"

# Workload Identity Federation identifiers.
WIF_POOL_ID="${WIF_POOL_ID:-github-pool}"
WIF_POOL_DISPLAY="${WIF_POOL_DISPLAY:-GitHub Actions Pool}"
WIF_PROVIDER_ID="${WIF_PROVIDER_ID:-github-provider}"
WIF_PROVIDER_DISPLAY="${WIF_PROVIDER_DISPLAY:-GitHub OIDC Provider}"

# The GitHub repo allowed to mint tokens via WIF. Lock the WIF binding to THIS
# repo only — any other repo's OIDC token is rejected by the attribute condition.
GITHUB_REPO="${GITHUB_REPO:-firstbitelabsllc/resplit-currency-api}"

# Deployer service account that CI impersonates via WIF.
DEPLOYER_SA_ID="${DEPLOYER_SA_ID:-tf-deployer}"
DEPLOYER_SA_EMAIL="${DEPLOYER_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

# APIs to enable. MUST stay in lockstep with the Terraform `project-apis` module
# (terraform/modules/project-apis/main.tf). If you add an API there, add it here
# too — bootstrap enables them once so the first `terraform plan` can read them.
ENABLE_APIS=(
  cloudresourcemanager.googleapis.com   # project / IAM resource manager
  serviceusage.googleapis.com           # enabling other services
  iam.googleapis.com                    # service accounts, roles
  iamcredentials.googleapis.com         # WIF token minting (STS)
  sts.googleapis.com                    # Security Token Service for WIF
  storage.googleapis.com                # GCS: FX JSON, sideload, TF state
  run.googleapis.com                    # Cloud Run (OCR, sideload services)
  cloudbuild.googleapis.com             # Cloud Build CI -> Artifact Registry
  artifactregistry.googleapis.com       # container image registry
  secretmanager.googleapis.com          # Azure DI key, signing secrets
  firestore.googleapis.com              # attest_keys / idempotency / rate_caps
  pubsub.googleapis.com                 # publish pipeline fan-out
  cloudscheduler.googleapis.com         # publish pipeline cron trigger
  monitoring.googleapis.com             # Managed Prometheus / metrics
  logging.googleapis.com                # Cloud Logging
  cloudtrace.googleapis.com             # Cloud Trace (OTel export)
  compute.googleapis.com                # Cloud CDN / external LB for fx.resplit.app
)

# =============================================================================
# Helpers
# =============================================================================

# Pretty section header.
section() {
  echo ""
  echo "============================================================================="
  echo ">> $1"
  echo "============================================================================="
}

# Mark a step that needs a human.
interactive_note() {
  echo "### [INTERACTIVE / LEO-GATED] ### $1"
}

# Note that a guarded step was skipped because the resource already exists.
skip_note() {
  echo "   [skip] $1 (already exists)"
}

ok_note() {
  echo "   [ok]   $1"
}

# =============================================================================
# Step 0 — confirm config before any side effects
# =============================================================================
section "Step 0 — Configuration summary"
cat <<EOF
   PROJECT_ID        = ${PROJECT_ID}
   PROJECT_NAME      = ${PROJECT_NAME}
   REGION            = ${REGION}
   TF_STATE_BUCKET   = gs://${TF_STATE_BUCKET}
   WIF_POOL_ID       = ${WIF_POOL_ID}
   WIF_PROVIDER_ID   = ${WIF_PROVIDER_ID}
   GITHUB_REPO       = ${GITHUB_REPO}
   DEPLOYER_SA_EMAIL = ${DEPLOYER_SA_EMAIL}
   GCLOUD_BIN        = ${GCLOUD_BIN}
   gcloud            = $(command -v gcloud)
EOF

# =============================================================================
# Step 1 — gcloud auth login
# =============================================================================
### [INTERACTIVE / LEO-GATED] ###
section "Step 1 — gcloud auth login (INTERACTIVE)"
# Guard: only open a browser if there's no active credentialed account.
# `gcloud auth list` prints the ACTIVE account; grep for any non-empty line.
if gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
  skip_note "gcloud already authenticated as ${ACTIVE_ACCOUNT}"
else
  interactive_note "A browser window will open. Log in with the GCP-owning Google account."
  gcloud auth login
fi

# Application Default Credentials — Terraform + the cloud.google.com/go SDKs read
# ADC, which is SEPARATE from `gcloud auth login`. Guard on the well-known file.
ADC_FILE="${HOME}/.config/gcloud/application_default_credentials.json"
if [[ -f "${ADC_FILE}" ]]; then
  skip_note "Application Default Credentials present at ${ADC_FILE}"
else
  ### [INTERACTIVE / LEO-GATED] ###
  interactive_note "A second browser window will open to grant Application Default Credentials (used by Terraform)."
  gcloud auth application-default login
fi

# =============================================================================
# Step 2 — create the project (or reuse it)
# =============================================================================
section "Step 2 — Project: ${PROJECT_ID}"
# `gcloud projects describe` exits non-zero if the project doesn't exist (or you
# can't see it). Use that as the existence check.
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  skip_note "project ${PROJECT_ID}"
else
  ok_note "creating project ${PROJECT_ID}"
  gcloud projects create "${PROJECT_ID}" --name="${PROJECT_NAME}"
fi

# Pin gcloud's active project so subsequent commands don't need --project.
gcloud config set project "${PROJECT_ID}" >/dev/null
ok_note "gcloud active project set to ${PROJECT_ID}"

# Resolve the numeric project number — WIF principals are keyed by project NUMBER,
# not the human-readable id. We need it later for the impersonation binding.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
ok_note "project number = ${PROJECT_NUMBER}"

# =============================================================================
# Step 3 — link a billing account
# =============================================================================
### [INTERACTIVE / LEO-GATED] ###
section "Step 3 — Billing (INTERACTIVE billing-account pick)"
# Guard: skip if billing is already enabled on the project.
BILLING_ENABLED="$(gcloud beta billing projects describe "${PROJECT_ID}" \
  --format='value(billingEnabled)' 2>/dev/null || echo 'False')"

if [[ "${BILLING_ENABLED}" == "True" ]]; then
  skip_note "billing already linked to ${PROJECT_ID}"
else
  # Allow a non-interactive override via BILLING_ACCOUNT_ID for headless re-runs.
  if [[ -n "${BILLING_ACCOUNT_ID:-}" ]]; then
    ok_note "linking billing account ${BILLING_ACCOUNT_ID} (from env)"
    gcloud beta billing projects link "${PROJECT_ID}" \
      --billing-account="${BILLING_ACCOUNT_ID}"
  else
    interactive_note "Pick which billing account to link. Your accounts:"
    echo ""
    gcloud beta billing accounts list \
      --format='table(name.basename():label=ACCOUNT_ID, displayName, open)' || true
    echo ""
    interactive_note "Enter the ACCOUNT_ID to link (e.g. 0X0X0X-0X0X0X-0X0X0X):"
    read -r CHOSEN_BILLING_ACCOUNT
    if [[ -z "${CHOSEN_BILLING_ACCOUNT}" ]]; then
      echo "ERROR: no billing account entered; cannot continue (APIs need billing)." >&2
      exit 1
    fi
    gcloud beta billing projects link "${PROJECT_ID}" \
      --billing-account="${CHOSEN_BILLING_ACCOUNT}"
  fi
  ok_note "billing linked"
fi

# =============================================================================
# Step 4 — enable APIs (lockstep with terraform project-apis module)
# =============================================================================
section "Step 4 — Enable APIs"
# Compute the set of APIs that are NOT already enabled, then enable in one batch
# (one `services enable` call is far faster than N calls and is itself idempotent).
ENABLED_NOW="$(gcloud services list --enabled --format='value(config.name)' 2>/dev/null || true)"
TO_ENABLE=()
for api in "${ENABLE_APIS[@]}"; do
  if grep -qx "${api}" <<<"${ENABLED_NOW}"; then
    skip_note "${api}"
  else
    TO_ENABLE+=("${api}")
  fi
done

if [[ "${#TO_ENABLE[@]}" -gt 0 ]]; then
  ok_note "enabling: ${TO_ENABLE[*]}"
  gcloud services enable "${TO_ENABLE[@]}"
else
  ok_note "all required APIs already enabled"
fi

# =============================================================================
# Step 5 — Terraform state bucket (versioned, uniform bucket-level access)
# =============================================================================
section "Step 5 — Terraform state bucket: gs://${TF_STATE_BUCKET}"
# Guard with `gsutil ls -b` on the bucket itself (exits non-zero if absent).
if gsutil ls -b "gs://${TF_STATE_BUCKET}" >/dev/null 2>&1; then
  skip_note "bucket gs://${TF_STATE_BUCKET}"
else
  ok_note "creating bucket gs://${TF_STATE_BUCKET} in ${REGION}"
  # --uniform-bucket-level-access (-b on): no per-object ACLs, IAM only.
  gsutil mb -p "${PROJECT_ID}" -l "${REGION}" -b on "gs://${TF_STATE_BUCKET}"
fi

# Versioning is its own toggle; setting it is idempotent, so we always assert it
# rather than branch — cheap, and self-healing if it was ever turned off.
gsutil versioning set on "gs://${TF_STATE_BUCKET}" >/dev/null
ok_note "versioning ON for gs://${TF_STATE_BUCKET}"

# Public-access prevention — belt-and-suspenders so TF state can never leak.
gsutil pap set enforced "gs://${TF_STATE_BUCKET}" >/dev/null 2>&1 || true
ok_note "public-access-prevention enforced (best-effort)"

# =============================================================================
# Step 6 — Workload Identity Federation + deployer service account
# =============================================================================
section "Step 6 — Workload Identity Federation + deployer SA"

# 6a — deployer service account.
if gcloud iam service-accounts describe "${DEPLOYER_SA_EMAIL}" >/dev/null 2>&1; then
  skip_note "service account ${DEPLOYER_SA_EMAIL}"
else
  ok_note "creating service account ${DEPLOYER_SA_EMAIL}"
  gcloud iam service-accounts create "${DEPLOYER_SA_ID}" \
    --display-name="Terraform / CI deployer (WIF, no keys)"
fi

# 6b — project-level roles for the deployer SA.
# Least-privilege-ish for a solo-dev deployer: it owns the infra Terraform manages
# plus the deploy path (Cloud Run, Artifact Registry, storage, secrets, WIF).
# These are project-scoped IAM bindings; `add-iam-policy-binding` is idempotent.
DEPLOYER_ROLES=(
  roles/run.admin                       # deploy / update Cloud Run services & jobs
  roles/artifactregistry.admin          # push images, manage repos
  roles/cloudbuild.builds.editor        # trigger Cloud Build
  roles/storage.admin                   # manage FX/sideload/TF-state buckets
  roles/secretmanager.admin             # manage secrets (values set out-of-band)
  roles/datastore.owner                 # Firestore (Datastore-mode API) admin
  roles/iam.serviceAccountAdmin         # manage runtime service accounts
  roles/iam.serviceAccountUser          # actAs runtime SAs on deploy
  roles/iam.workloadIdentityPoolAdmin   # manage the WIF pool/providers via TF
  roles/pubsub.admin                    # publish pipeline topics/subscriptions
  roles/cloudscheduler.admin            # publish pipeline cron jobs
  roles/serviceusage.serviceUsageAdmin  # enable/disable APIs via TF
  roles/resourcemanager.projectIamAdmin # set IAM bindings via TF
  roles/monitoring.admin                # Managed Prometheus / dashboards
  roles/logging.admin                   # log sinks / buckets
)
for role in "${DEPLOYER_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOYER_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
  ok_note "role on deployer SA: ${role}"
done

# 6c — WIF pool.
if gcloud iam workload-identity-pools describe "${WIF_POOL_ID}" \
  --location="global" >/dev/null 2>&1; then
  skip_note "WIF pool ${WIF_POOL_ID}"
else
  ok_note "creating WIF pool ${WIF_POOL_ID}"
  gcloud iam workload-identity-pools create "${WIF_POOL_ID}" \
    --location="global" \
    --display-name="${WIF_POOL_DISPLAY}"
fi

# Full resource name of the pool — needed for the provider + IAM binding.
WIF_POOL_NAME="$(gcloud iam workload-identity-pools describe "${WIF_POOL_ID}" \
  --location='global' --format='value(name)')"

# 6d — WIF OIDC provider for GitHub.
# attribute-condition locks token issuance to OUR repo only — without it ANY
# GitHub repo could assume the pool. This is the single most important security
# line in the whole WIF setup.
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${WIF_POOL_ID}" >/dev/null 2>&1; then
  skip_note "WIF provider ${WIF_PROVIDER_ID}"
else
  ok_note "creating WIF OIDC provider ${WIF_PROVIDER_ID} (locked to ${GITHUB_REPO})"
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER_ID}" \
    --location="global" \
    --workload-identity-pool="${WIF_POOL_ID}" \
    --display-name="${WIF_PROVIDER_DISPLAY}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
fi

# Full resource name of the provider — this is the value CI's
# google-github-actions/auth needs as `workload_identity_provider`.
WIF_PROVIDER_NAME="$(gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER_ID}" \
  --location='global' \
  --workload-identity-pool="${WIF_POOL_ID}" \
  --format='value(name)')"

# 6e — let the GitHub repo's WIF principals impersonate the deployer SA.
# The principalSet maps every OIDC token whose attribute.repository == our repo
# to permission to impersonate the deployer SA. add-iam-policy-binding is idempotent.
WIF_PRINCIPAL="principalSet://iam.googleapis.com/${WIF_POOL_NAME}/attribute.repository/${GITHUB_REPO}"
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${WIF_PRINCIPAL}" \
  --quiet >/dev/null
ok_note "WIF principalSet for ${GITHUB_REPO} may impersonate ${DEPLOYER_SA_EMAIL}"

# =============================================================================
# Step 7 — print the values to wire into Terraform + GitHub
# =============================================================================
section "Step 7 — Wire-up values"

cat <<EOF

-----------------------------------------------------------------------------
A) terraform/backend.tf  — remote state backend (bucket created in Step 5)
-----------------------------------------------------------------------------

  terraform {
    backend "gcs" {
      bucket = "${TF_STATE_BUCKET}"
      prefix = "resplit-currency-api/state"
    }
  }

-----------------------------------------------------------------------------
B) terraform/terraform.tfvars  — paste these
-----------------------------------------------------------------------------

  project_id                 = "${PROJECT_ID}"
  project_number             = "${PROJECT_NUMBER}"
  region                     = "${REGION}"
  github_repo                = "${GITHUB_REPO}"
  deployer_service_account   = "${DEPLOYER_SA_EMAIL}"
  wif_pool_id                = "${WIF_POOL_ID}"
  wif_provider_id            = "${WIF_PROVIDER_ID}"
  tf_state_bucket            = "${TF_STATE_BUCKET}"

-----------------------------------------------------------------------------
C) GitHub repo secrets/vars  — Settings -> Secrets and variables -> Actions
   (firstbitelabsllc/resplit-currency-api)
-----------------------------------------------------------------------------

  Secret  GCP_WORKLOAD_IDENTITY_PROVIDER = ${WIF_PROVIDER_NAME}
  Secret  GCP_DEPLOYER_SERVICE_ACCOUNT   = ${DEPLOYER_SA_EMAIL}
  Var     GCP_PROJECT_ID                 = ${PROJECT_ID}
  Var     GCP_REGION                     = ${REGION}

  In the deploy workflow, authenticate with:

    - uses: google-github-actions/auth@v2
      with:
        workload_identity_provider: \${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
        service_account:            \${{ secrets.GCP_DEPLOYER_SERVICE_ACCOUNT }}

-----------------------------------------------------------------------------
D) Secret Manager values to set out-of-band (NOT created by this script)
-----------------------------------------------------------------------------

  The Azure Document Intelligence key (OCR service's only secret) is set after
  Terraform creates the secret container:

    printf '%s' 'YOUR_AZURE_DI_KEY' | \\
      gcloud secrets versions add azure-di-key --data-file=- --project=${PROJECT_ID}

EOF

# =============================================================================
# Done — exact next commands
# =============================================================================
section "Bootstrap complete — run these next"
cat <<EOF

  cd terraform
  terraform init
  terraform plan

EOF
