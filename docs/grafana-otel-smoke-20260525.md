# Resplit FX Grafana OTEL Smoke — 2026-05-25

Checked at: 2026-05-25T19:55:14.698Z

## Result

`green` — Grafana Tempo and Loki both matched Resplit FX Worker telemetry in the last 360 minutes.

## Trigger

- URL: `https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-05-25&days=30`
- HTTP status: `200`
- Request id: `acf4e6f3-e2fb-490b-98e1-4ba0f251abb2`

## Grafana Proof

- Tempo datasource UID: `grafanacloud-traces`
- Tempo query: `{ resource.service.name =~ ".*resplit.*" }`
- Tempo result count: `4`
- Tempo trace id: `771d342fbcc4b8d4f33989f0605a58aa`
- Loki datasource UID: `grafanacloud-logs`
- Loki query: `{service_name=~".*resplit.*"}`
- Loki log line count: `1`

## Local Artifacts

- `reports/grafana-otel-smoke.json`
- `reports/resplit-fx-reliability-cockpit.json`
- `reports/resplit-fx-reliability-cockpit.html`
- `reports/resplit-fx-trust-preflight.json`
- `reports/resplit-fx-trust-preflight.md`

## Remaining Non-OTEL Gates

The OTEL/Grafana row is green, but the cockpit remains red overall because source/local-CI boundaries are still separate gates: dirty primary checkout, tracked local-CI contract drift, loaded MCP host catalog drift, FirstBite operating readout, release-history strict coverage, and ledger health.
