terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.16"
    }
  }
}

variable "project_id" {
  description = "GCP project ID the budget scopes to."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix (resplit-fx)."
  type        = string
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX) the budget attaches to."
  type        = string
}

variable "budget_amount" {
  description = "Monthly budget ceiling (USD). Alert thresholds (50/100/200%) are computed off this. This is the ABUSE-DETECTION ceiling, not a hard spend cap — FX/growth spend is never throttled."
  type        = number
}

# ---------------------------------------------------------------------------
# Kill-switch Pub/Sub topic. The OCR abuse-path kill-switch (a Cloud Run service
# / Firestore-flag flipper) subscribes here. When the budget crosses a threshold
# Cloud Billing publishes a CostAmount/BudgetAmount message; the listener reads
# the ratio and, at >=100%, flips the OCR abuse path off (raises rate caps to 0,
# rejects un-attested OCR). It NEVER touches the FX read path — that's static
# GCS+CDN with effectively zero marginal cost, and growth is good. Abuse-only.
# ---------------------------------------------------------------------------
resource "google_pubsub_topic" "budget_killswitch" {
  project = var.project_id
  name    = "${var.name_prefix}-budget-killswitch"

  message_retention_duration = "86400s"
}

# Allow the Cloud Billing budgets service agent to publish threshold
# notifications into the kill-switch topic.
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_pubsub_topic_iam_member" "billing_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.budget_killswitch.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budgets@system.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# The budget itself. Three threshold rules at 50% / 100% / 200% of the configured
# amount, evaluated against CURRENT (actual) spend. No `amount` cap is enforced as
# a hard ceiling — google_billing_budget only ALERTS; it cannot stop spend, which
# is exactly the desired blast-radius behavior: FX/growth keeps flowing, only the
# OCR abuse path gets killed by the downstream listener.
#
# Threshold semantics for the listener:
#   50%  -> warn (human page handled by monitoring module's OCR spend alert)
#   100% -> ENGAGE OCR abuse kill-switch (reject un-attested / over-cap OCR)
#   200% -> hard abuse lockdown (reject ALL OCR until manual reset) — runaway abuse
# ---------------------------------------------------------------------------
resource "google_billing_budget" "fx_abuse_guard" {
  billing_account = var.billing_account
  display_name    = "${var.name_prefix} OCR abuse-guard budget"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 2.0
    spend_basis       = "CURRENT_SPEND"
  }

  # Pub/Sub-only notification. NO disable_default_iam_recipients trickery and NO
  # link to a billing-cap action — Cloud Billing has no native hard cap, and we
  # rely on that: the only "cap" is the OCR abuse listener on the topic below.
  all_updates_rule {
    pubsub_topic                   = google_pubsub_topic.budget_killswitch.id
    schema_version                 = "1.0"
    disable_default_iam_recipients = false
  }
}

output "killswitch_topic" {
  description = "Pub/Sub topic the OCR abuse kill-switch listens on for budget threshold crossings."
  value       = google_pubsub_topic.budget_killswitch.id
}

output "budget_name" {
  description = "Resource name of the OCR abuse-guard billing budget."
  value       = google_billing_budget.fx_abuse_guard.name
}
