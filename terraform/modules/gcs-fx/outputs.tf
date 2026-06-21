output "bucket_name" {
  description = "Name of the FX artifacts bucket."
  value       = google_storage_bucket.fx_artifacts.name
}

output "bucket_url" {
  description = "gs:// URL of the FX artifacts bucket."
  value       = google_storage_bucket.fx_artifacts.url
}

output "backend_bucket_self_link" {
  description = "Self-link of the Cloud CDN backend bucket."
  value       = google_compute_backend_bucket.fx_cdn.self_link
}

output "lb_ip_address" {
  description = "Global anycast IP of the FX load balancer (null when enable_lb=false)."
  value       = var.enable_lb ? google_compute_global_address.fx_lb[0].address : null
}

output "lb_url" {
  description = "HTTPS URL served by the FX load balancer (null when enable_lb=false)."
  value       = var.enable_lb ? "https://fx.resplit.app" : null
}
