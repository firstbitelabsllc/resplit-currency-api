locals {
  name_prefix = "resplit-fx"
}

module "project_apis" {
  source     = "./modules/project-apis"
  project_id = var.project_id
}

module "firestore" {
  source     = "./modules/firestore"
  project_id = var.project_id
  region     = var.region

  depends_on = [module.project_apis]
}

module "secrets" {
  source      = "./modules/secrets"
  project_id  = var.project_id
  name_prefix = local.name_prefix

  depends_on = [module.project_apis]
}

# Workload Identity Federation (pool + GitHub OIDC provider + deployer SA) is
# created ONCE by bootstrap/setup-gcp.sh — it's the chicken-and-egg auth layer
# Terraform itself authenticates through, so Terraform does not manage it (that
# would conflict on apply with the already-created pool). The module under
# modules/wif/ is kept for reference; `terraform import` it later if you want
# Terraform to own WIF. Division: bootstrap owns auth/state foundation,
# Terraform owns the application infra below.

module "gcs_fx" {
  source      = "./modules/gcs-fx"
  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix
  enable_lb   = var.enable_lb

  depends_on = [module.project_apis]
}

# Cloud Monitoring: golden-signals dashboard, dead-man-switch + OCR-spend + FX
# uptime alerts, and the ocr_abuse_rejections log-based metric.
module "monitoring" {
  source      = "./modules/monitoring"
  project_id  = var.project_id
  name_prefix = local.name_prefix

  fx_read_host                = var.fx_read_host
  fx_snapshot_max_age_hours   = var.fx_snapshot_max_age_hours
  ocr_spend_threshold_usd     = var.ocr_spend_threshold_usd
  ocr_service_name            = "${local.name_prefix}-ocr"
  alert_notification_channels = var.alert_notification_channels

  depends_on = [module.project_apis]
}

# Publish pipeline: fx-publish Cloud Run Job triggered by Cloud Scheduler ->
# Pub/Sub (0,6,12,18 UTC) with a DLQ on the trigger subscription.
module "publish_pipeline" {
  source      = "./modules/publish-pipeline"
  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix

  publish_image       = var.publish_image
  fx_artifacts_bucket = module.gcs_fx.bucket_name

  depends_on = [module.project_apis]
}

# Billing budget abuse-guard: 50/100/200% thresholds on var.budget_amount wired
# to a Pub/Sub topic the OCR kill-switch listens on. No hard FX/growth cap.
module "budget" {
  source      = "./modules/budget"
  project_id  = var.project_id
  name_prefix = local.name_prefix

  billing_account = var.billing_account
  budget_amount   = var.budget_amount

  depends_on = [module.project_apis]
}

output "fx_artifacts_bucket" {
  description = "Name of the GCS bucket holding precomputed per-currency FX JSON."
  value       = module.gcs_fx.bucket_name
}

output "fx_artifacts_bucket_url" {
  description = "gs:// URL of the FX artifacts bucket."
  value       = module.gcs_fx.bucket_url
}

output "fx_cdn_backend_bucket" {
  description = "Self-link of the Cloud CDN backend bucket for the FX read path."
  value       = module.gcs_fx.backend_bucket_self_link
}

output "fx_lb_ip" {
  description = "Global anycast IP of the FX load balancer (null when enable_lb=false). Repoint fx.resplit.app A record here."
  value       = module.gcs_fx.lb_ip_address
}

output "fx_lb_url" {
  description = "HTTPS URL served by the FX load balancer (null when enable_lb=false)."
  value       = module.gcs_fx.lb_url
}

output "golden_signals_dashboard" {
  description = "Resource name of the golden-signals Cloud Monitoring dashboard."
  value       = module.monitoring.dashboard_id
}

output "fx_publish_job" {
  description = "Name of the fx-publish Cloud Run Job."
  value       = module.publish_pipeline.publish_job_name
}

output "fx_publish_dlq_topic" {
  description = "Pub/Sub dead-letter topic for failed publish triggers."
  value       = module.publish_pipeline.publish_dlq_topic
}

output "ocr_killswitch_topic" {
  description = "Pub/Sub topic the OCR abuse kill-switch listens on for budget threshold crossings."
  value       = module.budget.killswitch_topic
}
