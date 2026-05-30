variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

# Azure Document Intelligence key. Only the OCR Cloud Run service reads this.
# No version is created here: the secret payload is written out-of-band
# (e.g. `gcloud secrets versions add`) so the key never lands in tfstate.
resource "google_secret_manager_secret" "azure_di_key" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-azure-di-key"

  replication {
    auto {}
  }
}

output "azure_di_key_secret_id" {
  description = "Secret Manager secret ID for the Azure DI key."
  value       = google_secret_manager_secret.azure_di_key.secret_id
}

output "azure_di_key_secret_name" {
  description = "Fully-qualified resource name of the Azure DI key secret."
  value       = google_secret_manager_secret.azure_di_key.name
}
