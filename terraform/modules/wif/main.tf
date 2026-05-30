variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository (owner/repo) allowed to assume the deployer SA."
  type        = string
}

# Deployer service account assumed by GitHub Actions via WIF. NO JSON keys.
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-deployer"
  display_name = "resplit-fx CI/CD deployer (WIF, no keys)"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${var.name_prefix}-gh-pool"
  display_name              = "resplit-fx GitHub pool"
  description               = "OIDC federation for GitHub Actions deploys."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "${var.name_prefix}-gh-provider"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Lock to the one repo: the provider rejects tokens from any other repository.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Bind the deployer SA so only OIDC tokens from the locked repo can impersonate it.
resource "google_service_account_iam_member" "wif_impersonation" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

output "deployer_service_account_email" {
  description = "Email of the WIF deployer service account."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Provider resource name for the GitHub Actions workflow `auth` step."
  value       = google_iam_workload_identity_pool_provider.github.name
}
