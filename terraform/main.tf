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
