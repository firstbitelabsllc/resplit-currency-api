variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Location for the Firestore Native database."
  type        = string
}

# Native-mode Firestore. Holds OCR spine state:
#   attest_keys, ocr_idempotency (deviceId:hash), rate_caps.
resource "google_firestore_database" "this" {
  project                           = var.project_id
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
}

output "database_name" {
  description = "Resource name of the Firestore database."
  value       = google_firestore_database.this.name
}
