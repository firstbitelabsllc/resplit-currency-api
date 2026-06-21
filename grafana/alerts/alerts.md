# Resplit FX/OCR — First-PR Alerts

Five alerts ship in this first observability PR. They are the minimum set that
catches a silent FX outage, an SLO regression, a cost runaway, and a broken
delivery path. All run against the **Google Managed Prometheus** datasource the
OTel metric exporter pushes to (see `internal/obs/otel.go`).

Each alert is expressed as a Grafana-managed alert rule (Prometheus-style
`expr`). Routing is via a single contact point (Slack `#resplit-alerts` +
PagerDuty for `severity=page`); silence windows and the notification policy live
in the Grafana provisioning, not here.

| # | Alert | Severity | For | Fires when |
|---|-------|----------|-----|------------|
| 1 | `FXSnapshotStale` (dead-man) | page | 10m | snapshot age > 26h |
| 2 | `FXReadSLOFastBurn` | page | 5m | 5m **and** 1h burn > 14.4× budget |
| 3 | `CDNHitRatioLow` | warn | 15m | cache-hit ratio < 95% |
| 4 | `OCRDailySpendBudget` | warn→page | 5m | projected/actual daily USD over budget |
| 5 | `PubSubDLQNonEmpty` | page | 0m | publish DLQ depth > 0 |

---

## 1. `FXSnapshotStale` — dead-man's-switch (snapshot freshness)

**Why:** the FX read-path is static-first — clients read a published snapshot
from GCS+CDN. If the daily publish job silently stops, nothing 500s; clients
just keep serving an ever-staler rate. This is the single highest-value alert: a
freshness dead-man is the only thing that catches a *non-erroring* outage. The
May-2026 incident this whole rewrite responds to was exactly this class.

**Signal:** `fx_snapshot_age_seconds` (set on every publish and on liveness
checks via `Recorder.SetFXSnapshotAge`). The publisher runs daily, so a healthy
value sawtooths under ~24h. 26h gives a 2h grace past the daily cadence before
paging.
