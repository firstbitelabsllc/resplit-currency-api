terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.16"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.16"
    }
  }
}

variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Region (location) for the FX artifacts bucket."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "enable_lb" {
  description = "Provision the global external HTTPS load balancer when true."
  type        = bool
}

# Precomputed per-currency FX JSON. Zero compute on the read path: objects are
# served straight from GCS through Cloud CDN; the client divides for cross-rates.
resource "google_storage_bucket" "fx_artifacts" {
  project  = var.project_id
  name     = "${var.name_prefix}-artifacts"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# The FX JSON is public read-only data (rates are not secret). The backend
# bucket below needs anonymous access for CDN edge fills.
resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.fx_artifacts.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Cloud CDN backend bucket. Cache key is locked: it includes the request path
# and excludes ALL query strings except an allowlisted "rate_version" param so
# a single cache-busting token rolls the whole edge cache atomically.
resource "google_compute_backend_bucket" "fx_cdn" {
  project     = var.project_id
  name        = "${var.name_prefix}-cdn-backend"
  description = "Cloud CDN backend for precomputed FX JSON."
  bucket_name = google_storage_bucket.fx_artifacts.name
  enable_cdn  = true

  cdn_policy {
    cache_mode        = "CACHE_ALL_STATIC"
    client_ttl        = 300
    default_ttl       = 300
    max_ttl           = 3600
    negative_caching  = true
    serve_while_stale = 86400

    cache_key_policy {
      include_http_headers   = []
      query_string_whitelist = ["rate_version"]
    }
  }
}
