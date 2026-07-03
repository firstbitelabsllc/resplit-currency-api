# Resplit FX — Alerts

**Canonical source of truth: [`fx-alerts.json`](fx-alerts.json)** (rules as code,
provisioned idempotently by [`scripts/provision-grafana.js`](../../scripts/provision-grafana.js)).
This doc is the human rationale; the JSON is what actually ships. The PromQL in
both mirrors [`grafana/dashboards/resplit-fx.json`](../dashboards/resplit-fx.json)
so panels and alerts cannot drift.

Three FX alerts ship — the minimum set that catches a silent FX outage and an
SLO regression on the Cloudflare/JS stack. They run against the **Grafana Cloud
Prometheus** datasource the OTLP metric exporter pushes to (Cloudflare FX Worker
via `@microlabs/otel-cf-workers` + the publish pipeline via OTLP-HTTP/JSON).
Routing is via a single contact point (default email `leojkwan@gmail.com`);
silence windows and the notification policy live in Grafana provisioning.

| # | Alert | Severity | For | Fires when |
|---|-------|----------|-----|------------|
| 1 | `FXSnapshotStale` (dead-man) | page | 10m | snapshot age > 26h |
| 2 | `FXReadSLOFastBurn` | page | 5m | 5m **and** 1h burn > 14.4× budget on `/quote` |
| 3 | `FXFallbackShare` | page | 30m | >25% of `/quote` responses non-exact (silent staleness) |

> **Retired on Cloudflare:** the GCP-era `CDNHitRatioLow`
> (`loadbalancing_googleapis_com:*`) and `PubSubDLQNonEmpty` alerts do not apply
> to the Cloudflare/JS stack and are intentionally dropped. `OCRDailySpendBudget`
> is tracked separately with the OCR/Azure work, not in this FX set.

---

## 1. `FXSnapshotStale` — dead-man's-switch (snapshot freshness)

**Why:** the FX read-path is static-first — clients read a published snapshot
from the Cloudflare CDN (Pages/R2). If the daily publish job silently stops,
nothing 500s; clients just keep serving an ever-staler rate. This is the single
highest-value alert: a freshness dead-man is the only thing that catches a
*non-erroring* outage. The May-2026 incident this whole hardening responds to was
exactly this class. `noData` maps to `Alerting` so a missing metric also pages.

**Signal:** `fx_snapshot_age_seconds` (set on every publish and on liveness
checks via `Recorder.SetFXSnapshotAge`). The publisher runs daily, so a healthy
value sawtooths under ~24h. 26h gives a 2h grace past the daily cadence before
paging.
