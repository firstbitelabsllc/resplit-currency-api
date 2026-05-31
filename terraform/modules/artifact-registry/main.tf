variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Region (Artifact Registry location) for the docker repository."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "repository_id" {
  description = "Artifact Registry repository ID (the last path segment of the repo)."
  type        = string
  default     = "containers"
}

variable "keep_recent_count" {
  description = "Number of most-recent tagged versions to retain per cleanup policy."
  type        = number
  default     = 10
}

# Docker repository holding the ocr + sideload service images. CI pushes here
# (keyless via WIF); Cloud Run pulls from here. Immutable tags are intentionally
# NOT enforced so :latest and the deploy SHA tag can both be updated.
resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name_prefix}-${var.repository_id}"
  description   = "Container images for resplit-fx Cloud Run services (ocr, sideload)."
  format        = "DOCKER"

  docker_config {
    immutable_tags = false
  }

  # Keep storage bounded: delete untagged images after 7 days, and retain only
  # the N most-recent tagged versions. keep rules win over delete rules.
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  cleanup_policies {
    id     = "keep-recent-tagged"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_recent_count
    }
  }
}

output "repository_id" {
  description = "Full repository ID (location/project scoped name segment)."
  value       = google_artifact_registry_repository.docker.repository_id
}

output "repository_name" {
  description = "Fully-qualified Artifact Registry repository resource name."
  value       = google_artifact_registry_repository.docker.name
}

# Hostname + path prefix images are tagged/pushed under, e.g.
#   us-central1-docker.pkg.dev/resplit-fx-prod/resplit-fx-containers
output "repository_url" {
  description = "Docker registry path prefix for tagging images (no trailing slash)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
