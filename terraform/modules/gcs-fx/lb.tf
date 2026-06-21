# Global external HTTPS load balancer fronting the FX CDN backend bucket.
# Gated behind var.enable_lb so the bucket+CDN can ship before DNS cutover.
# Domain fx.resplit.app gets repointed (A record -> google_compute_global_address)
# once the managed cert provisions.

resource "google_compute_global_address" "fx_lb" {
  count   = var.enable_lb ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-lb-ip"
}

resource "google_compute_managed_ssl_certificate" "fx_lb" {
  count   = var.enable_lb ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-lb-cert"

  managed {
    domains = ["fx.resplit.app"]
  }
}

resource "google_compute_url_map" "fx_lb" {
  count           = var.enable_lb ? 1 : 0
  project         = var.project_id
  name            = "${var.name_prefix}-url-map"
  default_service = google_compute_backend_bucket.fx_cdn.id
}

# Redirect plain HTTP to HTTPS.
resource "google_compute_url_map" "fx_lb_http_redirect" {
  count   = var.enable_lb ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_https_proxy" "fx_lb" {
  count            = var.enable_lb ? 1 : 0
  project          = var.project_id
  name             = "${var.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.fx_lb[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.fx_lb[0].id]
}

resource "google_compute_target_http_proxy" "fx_lb" {
  count   = var.enable_lb ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-http-proxy"
  url_map = google_compute_url_map.fx_lb_http_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "fx_lb_https" {
  count                 = var.enable_lb ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-https-fr"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.fx_lb[0].id
  ip_address            = google_compute_global_address.fx_lb[0].id
}

resource "google_compute_global_forwarding_rule" "fx_lb_http" {
  count                 = var.enable_lb ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-http-fr"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "80"
  target                = google_compute_target_http_proxy.fx_lb[0].id
  ip_address            = google_compute_global_address.fx_lb[0].id
}
