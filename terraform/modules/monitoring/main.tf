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

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "fx_read_host" {
  description = "Hostname of the FX read path (CDN/LB front door) the uptime check probes. Defaults to the production custom domain."
  type        = string
  default     = "fx.resplit.app"
}

variable "fx_latest_path" {
  description = "Path on the FX read host that serves the freshest published snapshot. Probed by the uptime check; also the object whose age the dead-man-switch watches."
  type        = string
  default     = "/latest.json"
}

variable "fx_snapshot_max_age_hours" {
  description = "Dead-man-switch threshold. If the newest published FX snapshot is older than this, the publish pipeline has silently died — page. Publish cadence is every 6h, so 26h = ~4 missed runs."
  type        = number
  default     = 26
}

variable "ocr_spend_threshold_usd" {
  description = "Rolling-window OCR (Azure Document Intelligence) spend that trips the spend alert. This is an early-warning signal distinct from the hard billing budget."
  type        = number
  default     = 50
}

variable "ocr_service_name" {
  description = "Cloud Run service name emitting OCR cost/usage metrics. Used to scope the OCR spend alert filter."
  type        = string
  default     = "resplit-fx-ocr"
}

variable "alert_notification_channels" {
  description = "Notification channel resource names (projects/<p>/notificationChannels/<id>) alert policies fan out to. Empty list = policies created but silent (wire channels post-bootstrap)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Golden-signals dashboard. Cloud Monitoring dashboard JSON mirrors the Grafana
# golden-signals board (latency / traffic / errors / saturation) plus the two
# FX-specific tiles (snapshot freshness, OCR reject rate). Managed-Prometheus +
# OTel feed the same metrics, so this dashboard and the Grafana board stay in
# lockstep — this is the GCP-native mirror for on-call who live in the console.
# ---------------------------------------------------------------------------
resource "google_monitoring_dashboard" "golden_signals" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "resplit-fx — Golden Signals"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 6
          height = 4
          widget = {
            title = "FX read path — request latency (p50/p95/p99)"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"https_lb_rule\" metric.type=\"loadbalancing.googleapis.com/https/total_latencies\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_PERCENTILE_95"
                        crossSeriesReducer = "REDUCE_MEAN"
                      }
                    }
                  }
                  plotType = "LINE"
                }
              ]
              timeshiftDuration = "0s"
              yAxis = {
                label = "ms"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 6
          width  = 6
          height = 4
          widget = {
            title = "FX read path — traffic (req/s) + cache hit ratio"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"https_lb_rule\" metric.type=\"loadbalancing.googleapis.com/https/request_count\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_RATE"
                        crossSeriesReducer = "REDUCE_SUM"
                        groupByFields      = ["metric.label.cache_result"]
                      }
                    }
                  }
                  plotType = "STACKED_AREA"
                }
              ]
              yAxis = {
                label = "req/s"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          yPos   = 4
          width  = 6
          height = 4
          widget = {
            title = "Errors — OCR Cloud Run 5xx rate"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"cloud_run_revision\" resource.label.service_name=\"${var.ocr_service_name}\" metric.type=\"run.googleapis.com/request_count\" metric.label.response_code_class=\"5xx\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_RATE"
                        crossSeriesReducer = "REDUCE_SUM"
                      }
                    }
                  }
                  plotType = "LINE"
                }
              ]
              yAxis = {
                label = "5xx/s"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 6
          yPos   = 4
          width  = 6
          height = 4
          widget = {
            title = "Saturation — OCR Cloud Run instance count"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"cloud_run_revision\" resource.label.service_name=\"${var.ocr_service_name}\" metric.type=\"run.googleapis.com/container/instance_count\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_MEAN"
                        crossSeriesReducer = "REDUCE_SUM"
                      }
                    }
                  }
                  plotType = "LINE"
                }
              ]
              yAxis = {
                label = "instances"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          yPos   = 8
          width  = 6
          height = 4
          widget = {
            title = "FX snapshot freshness (dead-man-switch input)"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    # Custom OTel gauge: age in seconds of newest published snapshot.
                    timeSeriesFilter = {
                      filter = "metric.type=\"custom.googleapis.com/fx/snapshot_age_seconds\""
                      aggregation = {
                        alignmentPeriod  = "300s"
                        perSeriesAligner = "ALIGN_MEAN"
                      }
                    }
                  }
                  plotType = "LINE"
                }
              ]
              thresholds = [
                {
                  value     = var.fx_snapshot_max_age_hours * 3600
                  color     = "RED"
                  direction = "ABOVE"
                  label     = "dead-man-switch"
                }
              ]
              yAxis = {
                label = "seconds"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 6
          yPos   = 8
          width  = 6
          height = 4
          widget = {
            title = "OCR abuse rejections (log-based metric)"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${var.name_prefix}-ocr-abuse-rejections\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_RATE"
                        crossSeriesReducer = "REDUCE_SUM"
                        groupByFields      = ["metric.label.reason"]
                      }
                    }
                  }
                  plotType = "STACKED_BAR"
                }
              ]
              yAxis = {
                label = "rejects/s"
                scale = "LINEAR"
              }
            }
          }
        }
      ]
    }
  })
}

# ---------------------------------------------------------------------------
# Log-based metric: ocr_abuse_rejections.
# The OCR service logs a structured line (jsonPayload.event="ocr_abuse_reject")
# whenever it rejects a request on an abuse path — bad App Attest assertion,
# replayed idempotency key, per-device rate cap exceeded. This metric counts
# those, labelled by reason, and feeds both the dashboard tile and the budget
# kill-switch's corroborating signal.
# ---------------------------------------------------------------------------
resource "google_logging_metric" "ocr_abuse_rejections" {
  project = var.project_id
  name    = "${var.name_prefix}-ocr-abuse-rejections"

  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${var.ocr_service_name}\"",
    "jsonPayload.event=\"ocr_abuse_reject\"",
  ])

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "OCR abuse rejections"

    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "Rejection reason: attest_invalid | idempotency_replay | rate_cap | quota_exhausted"
    }
  }

  label_extractors = {
    "reason" = "EXTRACT(jsonPayload.reason)"
  }
}

# ---------------------------------------------------------------------------
# Alert: FX snapshot dead-man-switch. The publish pipeline writes a custom OTel
# gauge custom.googleapis.com/fx/snapshot_age_seconds on every successful run.
# If that value crosses 26h the publish job has silently stopped and the FX read
# path is serving stale rates — page immediately. Uses ABSENCE-tolerant compare:
# the threshold fires on age, and a separate condition fires if the metric stops
# reporting entirely (publisher dead before it could even emit age).
# ---------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "fx_snapshot_dead_man_switch" {
  project      = var.project_id
  display_name = "FX snapshot stale > ${var.fx_snapshot_max_age_hours}h (dead-man-switch)"
  combiner     = "OR"

  conditions {
    display_name = "snapshot_age_seconds above ${var.fx_snapshot_max_age_hours}h"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/fx/snapshot_age_seconds\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.fx_snapshot_max_age_hours * 3600
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "snapshot_age_seconds metric absent (publisher dead)"
    condition_absent {
      filter   = "metric.type=\"custom.googleapis.com/fx/snapshot_age_seconds\" resource.type=\"global\""
      duration = "${var.fx_snapshot_max_age_hours * 3600}s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = var.alert_notification_channels

  alert_strategy {
    auto_close = "604800s"
  }

  documentation {
    content   = <<-EOT
      The FX publish pipeline has not produced a fresh snapshot in over ${var.fx_snapshot_max_age_hours}h.
      Publish cadence is every 6h (0,6,12,18 UTC); this threshold tolerates ~4 missed runs before paging.

      Runbook:
      1. Check the fx-publish Cloud Run Job executions (Cloud Scheduler -> Pub/Sub -> Job).
      2. Inspect the publish-pipeline DLQ topic for failed publish messages.
      3. The FX read path (GCS+CDN) keeps serving the LAST good snapshot — reads are NOT down, but rates are aging.
    EOT
    mime_type = "text/markdown"
  }

  severity = "CRITICAL"
}

# ---------------------------------------------------------------------------
# Alert: OCR spend early-warning. Distinct from the hard billing budget — this
# trips on the rolling OCR cost metric so on-call sees abuse-driven spend BEFORE
# the monthly budget thresholds fire. The budget module owns the kill-switch;
# this owns the human page.
# ---------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "ocr_spend" {
  project      = var.project_id
  display_name = "OCR spend over $${var.ocr_spend_threshold_usd} (rolling)"
  combiner     = "OR"

  conditions {
    display_name = "ocr_cost_usd rolling sum above threshold"
    condition_threshold {
      # Custom OTel cost gauge emitted by the OCR service per billed DI call.
      filter          = "metric.type=\"custom.googleapis.com/ocr/cost_usd\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.ocr_spend_threshold_usd
      duration        = "0s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.alert_notification_channels

  alert_strategy {
    auto_close = "604800s"
  }

  documentation {
    content   = "OCR (Azure DI) spend crossed the early-warning threshold. Cross-check the ${var.name_prefix}-ocr-abuse-rejections metric: a spend spike WITH a reject spike = abuse driving cost; the billing-budget kill-switch will engage the OCR abuse path at the 100% threshold."
    mime_type = "text/markdown"
  }

  severity = "WARNING"
}

# ---------------------------------------------------------------------------
# Uptime check on the FX read path. Probes the CDN/LB front door for the latest
# snapshot from multiple regions. Read path is zero-compute (GCS+CDN) so this is
# really an edge-availability + DNS check.
# ---------------------------------------------------------------------------
resource "google_monitoring_uptime_check_config" "fx_read_path" {
  project      = var.project_id
  display_name = "FX read path — ${var.fx_read_host}${var.fx_latest_path}"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = var.fx_latest_path
    port         = 443
    use_ssl      = true
    validate_ssl = true

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.fx_read_host
    }
  }

  selected_regions = ["USA", "EUROPE", "ASIA_PACIFIC"]
}

resource "google_monitoring_alert_policy" "fx_read_path_down" {
  project      = var.project_id
  display_name = "FX read path uptime check failing"
  combiner     = "OR"

  conditions {
    display_name = "uptime check failure"
    condition_threshold {
      filter = join(" ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.check_id=\"${google_monitoring_uptime_check_config.fx_read_path.uptime_check_id}\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.alert_notification_channels

  alert_strategy {
    auto_close = "604800s"
  }

  severity = "CRITICAL"
}

output "dashboard_id" {
  description = "Resource name of the golden-signals Cloud Monitoring dashboard."
  value       = google_monitoring_dashboard.golden_signals.id
}

output "ocr_abuse_rejections_metric" {
  description = "Name of the ocr_abuse_rejections log-based metric."
  value       = google_logging_metric.ocr_abuse_rejections.name
}

output "fx_uptime_check_id" {
  description = "ID of the FX read-path uptime check."
  value       = google_monitoring_uptime_check_config.fx_read_path.uptime_check_id
}

output "dead_man_switch_policy_id" {
  description = "Resource name of the FX snapshot dead-man-switch alert policy."
  value       = google_monitoring_alert_policy.fx_snapshot_dead_man_switch.id
}
