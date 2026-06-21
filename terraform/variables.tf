variable "project_id" {
  description = "GCP project ID hosting the resplit-fx GCP rewrite."
  type        = string
}

variable "region" {
  description = "Primary GCP region for regional resources (Cloud Run, buckets)."
  type        = string
  default     = "us-central1"
}

variable "state_bucket" {
  description = "GCS bucket holding Terraform remote state (passed to init via -backend-config)."
  type        = string
  default     = "resplit-fx-tfstate"
}

variable "enable_lb" {
  description = "When true, provision the global external HTTPS load balancer fronting the FX CDN backend bucket."
  type        = bool
  default     = false
}

variable "budget_amount" {
  description = "Monthly budget ceiling (USD) used by the OCR abuse kill-switch wiring."
  type        = number
  default     = 200
}

variable "github_repo" {
  description = "GitHub repository (owner/repo) allowed to assume the deployer SA via Workload Identity Federation."
  type        = string
  default     = "firstbitelabsllc/resplit-currency-api"
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX) the OCR abuse-guard budget attaches to. Required for the budget module — google_billing_budget is billing-account-scoped, not project-scoped."
  type        = string
}

variable "fx_read_host" {
  description = "Hostname of the FX read path (CDN/LB front door) the uptime check probes."
  type        = string
  default     = "fx.resplit.app"
}

variable "fx_snapshot_max_age_hours" {
  description = "Dead-man-switch threshold (hours). Pages when the newest published FX snapshot is older than this. 6h publish cadence -> 26h tolerates ~4 missed runs."
  type        = number
  default     = 26
}

variable "ocr_spend_threshold_usd" {
  description = "Rolling-window OCR (Azure DI) spend that trips the early-warning page, distinct from the hard billing budget thresholds."
  type        = number
  default     = 50
}

variable "alert_notification_channels" {
  description = "Notification channel resource names alert policies fan out to. Empty = policies created but silent until channels are wired post-bootstrap."
  type        = list(string)
  default     = []
}

variable "publish_image" {
  description = "Container image for the fx-publish Cloud Run Job. CI overwrites with the built digest; default keeps terraform apply clean before the first image push."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
