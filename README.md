# Resplit Currency API

Daily FX rates for 160+ fiat currencies, served as static JSON on Cloudflare Pages plus a dedicated Cloudflare Worker for canonical quote/history endpoints.

Forked from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) and simplified for [Resplit](https://apps.apple.com/app/resplit/id6504840449).

## How it works

1. GitHub Actions runs twice per UTC day: once at 00:00 UTC and again at 03:00 UTC after the upstream usually settles
2. Fetches latest rates from [open.er-api.com](https://open.er-api.com) (free, no API key)
3. Saves today's snapshot to `snapshot-archive/` (committed to repo for durability)
4. Reads historical snapshots from local archive first, network fallback only if missing
5. Generates latest/history artifacts plus immutable archive manifests/year payloads
6. Commits the archive back to the repo, then deploys to Cloudflare Pages + GitHub Pages
7. Deploys the FX Worker that serves canonical `quote`, `history`, and `coverage`

## URL structure

**latest (one file per base currency):**
```
https://resplit-currency-api.pages.dev/latest/{code}.json
```

**history (30-day window, one file per base currency):**
```
https://resplit-currency-api.pages.dev/history/30d/{code}.json
```

**metadata and snapshot seed:**
```
https://resplit-currency-api.pages.dev/meta.json
https://resplit-currency-api.pages.dev/snapshots/base-rates.json
https://resplit-currency-api.pages.dev/archive-manifest.json
https://resplit-currency-api.pages.dev/archive-years/2026.json
```

**canonical FX Worker:**
```
https://fx.resplit.app/quote?from=AED&to=USD&date=2026-02-27
https://fx.resplit.app/history?from=AED&to=USD&start=2026-02-18&end=2026-02-27
https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-02-27&days=30
```

**contract mirrors (same response shape, fallback hosts):**
```
https://www.resplit.app/api/fx/quote?from=AED&to=USD&date=2026-02-27
https://www.resplit.app/api/fx/history?from=AED&to=USD&start=2026-02-18&end=2026-02-27
https://www.resplit.app/api/fx/coverage?from=AED&to=USD&anchorDate=2026-02-27&days=30

https://staging.resplit.app/api/fx/quote?from=AED&to=USD&date=2026-02-27
```

**GitHub Pages fallback:**
```
https://firstbitelabsllc.github.io/resplit-currency-api/latest/{code}.json
```

## Canonical contract

The canonical FX contract is host-agnostic:

- Primary: `https://fx.resplit.app/{quote|history|coverage}`
- Production mirror: `https://www.resplit.app/api/fx/{quote|history|coverage}`
- Staging mirror: `https://staging.resplit.app/api/fx/{quote|history|coverage}`

The Worker is the operational primary. The Vercel routes mirror the same contract so iOS can fall
back without changing request semantics. Static Pages/GitHub artifacts are data sources and
last-resort fallbacks, not the client-facing contract.

### `GET /quote`

Query:
`from={CCY}&to={CCY}&date={YYYY-MM-DD}`

Response:
- `from`, `to`
- `requestedDate`
- `resolvedDate`
- `rate`
- `resolutionKind`: `exact` | `prior_day_fallback` | `today_fallback`
- `warning`

Headers:
- `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`
- `x-request-id`

### `GET /history`

Query:
`from={CCY}&to={CCY}&start={YYYY-MM-DD}&end={YYYY-MM-DD}`

Response:
- `from`, `to`, `start`, `end`
- `points[]`: `{ date, rate }`
- `coverage`: `requestedDays`, `availableDays`, `missingDayCount`, `returnedRange`,
  `archiveLatestDate`, `archiveGapCount`

Headers:
- `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`
- `x-request-id`

### `GET /coverage`

Query:
`from={CCY}&to={CCY}&anchorDate={YYYY-MM-DD}&days={N}`

Response:
- `quote` and `historyCoverage` snapshots for the requested window
- `freshness`: lag-versus-anchor fields used to detect stale Worker/CDN data
- `mismatchCount`
- `signals`

Headers:
- `Cache-Control: no-store`
- `x-request-id`

### `GET /cron/fx-canary`

Auth:
- `Authorization: Bearer $CRON_SECRET`

Purpose:
- runs representative `quote` + `history` + `coverage` probes against the retained archive window
- emits Sentry check-ins/incidents for scheduler-driven health monitoring

## Examples

```
GET https://resplit-currency-api.pages.dev/latest/aed.json
```

```json
{
  "date": "2026-02-27",
  "from": "aed",
  "rates": {
    "usd": 0.27229408,
    "eur": 0.25165782,
    "myr": 1.17830000,
    ...
  }
}
```

## Secrets required

| Secret | Scope | Description |
|--------|-------|-------------|
| `CLOUDFLARE_API_TOKEN` | Required | Cloudflare API token with Pages edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Required | Cloudflare account ID |
| `SENTRY_CURRENCY_API_DSN` | Recommended | Preferred DSN when you provision a dedicated currency-api Sentry project; otherwise the workflow can fall back to `SENTRY_DSN` |
| `SENTRY_DSN` | Optional fallback | Shared fallback DSN if a dedicated project is not configured |
| `CRON_SECRET` | Optional | Worker canary route secret |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional Worker secret | Standard Grafana Cloud OTLP base endpoint for traces |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional Worker secret | Full traces endpoint override when Grafana already gives you `/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional Worker secret | Standard OTLP header string, e.g. `Authorization=Basic ...` |
| `OTEL_ENDPOINT` | Optional Worker secret alias | Repo alias for the OTLP base endpoint |
| `OTEL_AUTH_HEADER` | Optional Worker secret alias | Repo alias for the auth header; raw `Basic ...` is accepted |
| `GRAFANA_CLOUD_STACK_SA_TOKEN` | Optional local env | Needed only for `npm run observability:tempo-smoke` to poll Grafana Tempo |

`GITHUB_TOKEN` is provided automatically. Also used to push snapshot archive commits.

## Observability

This repo includes Sentry-based publisher and Worker observability, plus optional Grafana Cloud Tempo trace export for the Worker runtime.

- `scripts/sentry-monitoring.js` initializes `@sentry/node` with surface, environment, and release metadata for the publisher workflow.
- `scripts/sentry-checkin.js` emits cron monitor check-ins for the scheduled daily publish workflow only, so manual `workflow_dispatch` reruns do not create false missed/failure incidents on the daily monitor.
- `worker/src/monitoring.mjs` initializes `@sentry/cloudflare` for the Worker runtime and tags events with `runtime=worker`.
- `worker/src/otel.mjs` resolves Grafana Cloud OTLP env vars and wraps the Worker with `@microlabs/otel-cf-workers` when the OTLP endpoint + auth header are present.
- `worker/src/otel-verification.mjs` emits an opt-in `/coverage` verification span keyed by `x-request-id` so Tempo proof can be deterministic.
- `currscript.js`, `scripts/validate-package.js`, and `scripts/smoke-check-deploy.js` all run through the monitored wrapper and report grouped failures.
- `scripts/verify-grafana-tempo.mjs` hits `/coverage` with the verification header, then polls Grafana Tempo for the exact span name.
- The GitHub Actions workflow prefers `SENTRY_CURRENCY_API_DSN`, falls back to shared `SENTRY_DSN`, and syncs the chosen DSN into the Worker runtime secret `SENTRY_DSN`.

Current coverage:

- grouped issue capture for publish, validation, deploy, and smoke-check failures
- grouped issue capture for Worker route and coverage failures
- structured Sentry logs for monitoring signals
- release and environment tagging
- cron monitor check-ins for the daily publish job, plus Worker canary check-ins when `/cron/fx-canary` is invoked by an external scheduler or manual probe
- Worker request/outbound-fetch traces in Grafana Cloud Tempo when `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` (or the `OTEL_*` alias pair) are configured as Wrangler secrets
- deterministic Tempo verification via `npm run observability:tempo-smoke`

This is not identical to `resplit-web` in implementation because this repo is a Node cron publisher, not a browser/server app. It is equivalent in intent: release/environment tagging, error capture, structured logs, and runtime health monitoring.

## Local development

```bash
npm ci
npm run check
# Generates package/, validates unversioned artifact integrity, and runs unit tests
```

If you want to deploy locally with wrangler, copy `.env.example` to `.env.local` and fill values.
If you want local Sentry events while running scripts manually, set `SENTRY_CURRENCY_API_DSN` or `SENTRY_DSN`.
If you want local or preview Worker traces in Grafana Cloud, set either:

```bash
wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT
wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
```

or the repo alias pair:

```bash
wrangler secret put OTEL_ENDPOINT
wrangler secret put OTEL_AUTH_HEADER
```

To prove the trace landed without manually searching Explore, run:

```bash
npm run observability:tempo-smoke -- --base-url http://127.0.0.1:8787
```

`npm run smoke:deploy` now defaults its Worker probe to `https://fx.resplit.app`; set
`FX_WORKER_BASE_URL` to point at an alternate host or `SKIP_WORKER_SMOKE_CHECK=1` only when you
intentionally need to bypass the canonical Worker check.

The committed snapshot archive now retains a rolling 365-day span. Small archive gaps are tolerated and surfaced through `archive-manifest.json` / the coverage route rather than silently papered over.
