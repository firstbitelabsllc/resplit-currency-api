variable "project_id" {
  description = "GCP project ID to enable services on."
  type        = string
}

locals {
  services = [
    "run.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "monitoring.googleapis.com",
    "cloudscheduler.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
    "compute.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  project = var.project_id
  service = each.value

  disable_dependent_services = false
  disable_on_destroy         = false
}

output "enabled_services" {
  description = "List of services enabled on the project."
  value       = sort([for s in google_project_service.this : s.service])
}
