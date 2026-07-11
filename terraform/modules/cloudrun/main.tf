variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Region for the Cloud Run v2 service."
  type        = string
}

variable "name" {
  description = "Cloud Run service name (e.g. resplit-fx-ocr)."
  type        = string
}

variable "image" {
  description = "Fully-qualified container image (Artifact Registry path + tag/digest). This is what couples apply to a pushed image — see terraform/main.tf header on image-then-apply ordering."
  type        = string
}

variable "service_account_email" {
  description = "Runtime service account the revision runs as (NOT the deployer SA)."
  type        = string
}

variable "min_instances" {
  description = "Minimum instances (0 = scale to zero; >=1 keeps a warm instance)."
  type        = number
}

variable "max_instances" {
  description = "Maximum instances ceiling for autoscaling."
  type        = number
}

variable "concurrency" {
  description = "Max concurrent requests per instance (container concurrency)."
  type        = number
  default     = 80
}

variable "cpu" {
  description = "CPU limit per instance (e.g. \"1\", \"2\")."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance (e.g. \"512Mi\", \"1Gi\")."
  type        = string
  default     = "512Mi"
}

variable "container_port" {
  description = "Port the container listens on (Cloud Run injects PORT to match)."
  type        = number
  default     = 8080
}

variable "timeout_seconds" {
  description = "Per-request timeout in seconds."
  type        = number
  default     = 60
}

variable "env" {
  description = "Plain (non-secret) environment variables passed to the container."
  type        = map(string)
  default     = {}
}

# Secret Manager-backed env vars. Map env var name -> { secret_id, version }.
# secret_id is the Secret Manager secret short ID (same project); version
# defaults to "latest". The runtime SA must hold roles/secretmanager.secretAccessor
# on each referenced secret (granted below).
variable "secret_env" {
  description = "Environment variables sourced from Secret Manager."
  type = map(object({
    secret_id = string
    version   = optional(string, "latest")
  }))
  default = {}
}

variable "cpu_idle" {
  description = <<-EOT
    Throttle CPU to ~0 between requests ("CPU is only allocated during request
    processing"). null = auto: true when min_instances==0, false otherwise.

    MUST be false for any service running background goroutines — OTel's periodic
    metric reader and batch span exporter, cache sweepers, etc. With cpu_idle=true
    those goroutines freeze the instant a request returns, so telemetry only
    flushes on instance shutdown and metrics/traces silently never reach Grafana.
    A scan returns 200 while ocr_scans_total never increments. Set false (the
    gcloud equivalent is --no-cpu-throttling) on telemetry-exporting services even
    when they scale to zero; idle instances still bill nothing once torn down.
  EOT
  type        = bool
  default     = null
}

variable "allow_unauthenticated" {
  description = "When true, grant roles/run.invoker to allUsers (public ingress). Keep false for attested/internal services."
  type        = bool
  default     = false
}

variable "ingress" {
  description = "Ingress setting: INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_ONLY, or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
}

resource "google_cloud_run_v2_service" "this" {
  project  = var.project_id
  location = var.region
  name     = var.name
  ingress  = var.ingress

  # Apply the deployer's image as-is; ignore drift on the image so the GitHub
  # Actions deploy step (gcloud run deploy --image <sha>) can advance the
  # revision without Terraform reverting it on the next plan.
  deletion_protection = false

  template {
    service_account                  = var.service_account_email
    timeout                          = "${var.timeout_seconds}s"
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # CPU throttling. Default (var.cpu_idle=null): release CPU between
        # requests only when scaling to zero. But background workers — OTLP
        # metric/trace exporters above all — freeze under throttling, so
        # telemetry services pass cpu_idle=false explicitly even at min=0.
        # See variable "cpu_idle" for the full Grafana-goes-silent failure mode.
        cpu_idle = var.cpu_idle != null ? var.cpu_idle : (var.min_instances == 0)
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = env.value.version
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = var.container_port
        }
        initial_delay_seconds = 1
        period_seconds        = 5
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = var.container_port
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }

  lifecycle {
    # The CI deploy step advances the running image; Terraform owns shape
    # (scaling, SA, secrets) but not which exact digest is live.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}

# Grant the runtime SA accessor on each Secret Manager secret it reads.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = var.secret_env

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"
}

# Optional public ingress. Attested services (OCR) keep this false and rely on
# App Attest at the application layer behind an authenticated invoker.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_name" {
  description = "Name of the Cloud Run service."
  value       = google_cloud_run_v2_service.this.name
}

output "service_uri" {
  description = "HTTPS URI of the Cloud Run service."
  value       = google_cloud_run_v2_service.this.uri
}
