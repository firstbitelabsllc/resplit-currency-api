terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.16"
    }
  }
}

variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Region for the Cloud Run Job and Scheduler job."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "publish_image" {
  description = "Container image for the fx-publish Cloud Run Job (Artifact Registry path). Defaults to a placeholder digest the CI deploy overwrites; the Job resource still applies cleanly."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "fx_artifacts_bucket" {
  description = "Name of the GCS bucket the publish job writes precomputed per-currency FX JSON into. Wired from module.gcs_fx.bucket_name."
  type        = string
}

variable "publish_schedule_cron" {
  description = "Cron expression (UTC) for the publish cadence. Default fires at 00:00, 06:00, 12:00, 18:00."
  type        = string
  default     = "0 0,6,12,18 * * *"
}

variable "publish_timeout_seconds" {
  description = "Max wall-clock seconds for one publish-job execution before it is killed."
  type        = number
  default     = 600
}

# ---------------------------------------------------------------------------
# Dedicated runtime SA for the publish job. Least-privilege: write to the FX
# artifacts bucket + read FX source secrets + emit OTel metrics. NOT the deployer
# SA (that one is WIF-only, owned by bootstrap).
# ---------------------------------------------------------------------------
resource "google_service_account" "publisher" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-publisher"
  display_name = "resplit-fx publish job runtime SA"
}

resource "google_storage_bucket_iam_member" "publisher_writes_artifacts" {
  bucket = var.fx_artifacts_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.publisher.email}"
}

resource "google_project_iam_member" "publisher_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.publisher.email}"
}

# ---------------------------------------------------------------------------
# fx-publish Cloud Run Job. Runs the Reconcile (2-of-3 quorum) over the source
# snapshots and writes the precomputed per-currency JSON to the FX bucket, then
# emits custom.googleapis.com/fx/snapshot_age_seconds=0 (resets the dead-man
# switch). Triggered indirectly: Scheduler -> Pub/Sub -> (push subscription ->
# Job execution). No always-on compute.
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "fx_publish" {
  project  = var.project_id
  name     = "${var.name_prefix}-publish"
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.publisher.email
      timeout         = "${var.publish_timeout_seconds}s"
      max_retries     = 1

      containers {
        image = var.publish_image

        env {
          name  = "FX_ARTIFACTS_BUCKET"
          value = var.fx_artifacts_bucket
        }
        env {
          name  = "FX_MIN_AGREE"
          value = "2"
        }
        env {
          name  = "OTEL_RESOURCE_ATTRIBUTES"
          value = "service.name=${var.name_prefix}-publish"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Trigger topic. Scheduler publishes here; a push subscription (below) invokes
# the Cloud Run Job's :run endpoint. Decoupling via Pub/Sub gives us at-least-
# once delivery + a natural DLQ seam for poison triggers.
# ---------------------------------------------------------------------------
resource "google_pubsub_topic" "publish_trigger" {
  project = var.project_id
  name    = "${var.name_prefix}-publish-trigger"

  message_retention_duration = "86400s"
}

# Dead-letter topic for publish triggers that exhaust delivery retries. Drains
# poison messages off the main path so a single bad trigger can't wedge the
# subscription; an alert (monitoring module) can watch its backlog.
resource "google_pubsub_topic" "publish_dlq" {
  project = var.project_id
  name    = "${var.name_prefix}-publish-dlq"

  message_retention_duration = "604800s"
}

# SA Pub/Sub uses to invoke the Cloud Run Job via the push subscription.
resource "google_service_account" "publish_invoker" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-pub-invoker"
  display_name = "resplit-fx publish trigger invoker SA"
}

resource "google_cloud_run_v2_job_iam_member" "invoker_runs_job" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.fx_publish.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.publish_invoker.email}"
}

# Push subscription: every trigger message POSTs the Job :run endpoint with an
# OIDC token minted for publish_invoker. Failed deliveries (5 attempts) spill to
# the DLQ topic.
resource "google_pubsub_subscription" "publish_trigger_push" {
  project = var.project_id
  name    = "${var.name_prefix}-publish-trigger-sub"
  topic   = google_pubsub_topic.publish_trigger.id

  ack_deadline_seconds = 600

  push_config {
    push_endpoint = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.fx_publish.name}:run"

    oidc_token {
      service_account_email = google_service_account.publish_invoker.email
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.publish_dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = "" # never expire
  }
}

# Let Pub/Sub's service agent publish into the DLQ + ack from the trigger sub
# (required for dead_letter_policy to function).
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.publish_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.publish_trigger_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# Cloud Scheduler: the cadence source of truth. Publishes an empty trigger to
# the publish topic at 0,6,12,18 UTC. Scheduler -> Pub/Sub (not -> Job directly)
# so the trigger fan-out stays observable and DLQ-backed.
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "fx_publish_cron" {
  project   = var.project_id
  region    = var.region
  name      = "${var.name_prefix}-publish-cron"
  schedule  = var.publish_schedule_cron
  time_zone = "Etc/UTC"

  pubsub_target {
    topic_name = google_pubsub_topic.publish_trigger.id
    data       = base64encode(jsonencode({ trigger = "scheduled-fx-publish" }))
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "300s"
  }
}

output "publish_job_name" {
  description = "Name of the fx-publish Cloud Run Job."
  value       = google_cloud_run_v2_job.fx_publish.name
}

output "publish_trigger_topic" {
  description = "Pub/Sub topic the scheduler publishes triggers to."
  value       = google_pubsub_topic.publish_trigger.id
}

output "publish_dlq_topic" {
  description = "Pub/Sub dead-letter topic for failed publish triggers."
  value       = google_pubsub_topic.publish_dlq.id
}

output "publisher_service_account" {
  description = "Email of the publish job runtime service account."
  value       = google_service_account.publisher.email
}
