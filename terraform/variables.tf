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
