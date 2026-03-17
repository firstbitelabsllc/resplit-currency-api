# Resplit Currency API

Daily FX rates for 160+ fiat currencies, served as static JSON on Cloudflare Pages.

Forked from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) and simplified for [Resplit](https://apps.apple.com/app/resplit/id6504840449).

## How it works

1. GitHub Actions runs daily at midnight UTC
2. Fetches latest rates from [open.er-api.com](https://open.er-api.com) (free, no API key)
3. Saves today's snapshot to `snapshot-archive/` (committed to repo for durability)
4. Reads historical snapshots from local archive first, network fallback only if missing
5. Generates latest/history artifacts from the snapshot window
6. Commits the archive back to the repo, then deploys to Cloudflare Pages + GitHub Pages

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
```

**GitHub Pages fallback:**
```
https://firstbitelabsllc.github.io/resplit-currency-api/latest/{code}.json
```

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

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `SENTRY_CURRENCY_API_DSN` | Preferred DSN for the dedicated currency-api Sentry project |
| `SENTRY_DSN` | Optional shared fallback DSN if a dedicated project is not configured |

`GITHUB_TOKEN` is provided automatically. Also used to push snapshot archive commits.

## Observability

This repo already includes Sentry-based workflow observability.

- `scripts/sentry-monitoring.js` initializes `@sentry/node` with surface, environment, and release metadata.
- `scripts/sentry-checkin.js` emits cron monitor check-ins for the daily publish workflow.
- `currscript.js`, `scripts/validate-package.js`, and `scripts/smoke-check-deploy.js` all run through the monitored wrapper and report grouped failures.
- The GitHub Actions workflow prefers `SENTRY_CURRENCY_API_DSN` and falls back to shared `SENTRY_DSN` only if the dedicated secret is absent.

Current coverage:

- grouped issue capture for publish, validation, deploy, and smoke-check failures
- structured Sentry logs for monitoring signals
- release and environment tagging
- cron monitor check-ins for the daily publish job

This is not identical to `resplit-web` in implementation because this repo is a Node cron publisher, not a browser/server app. It is equivalent in intent: release/environment tagging, error capture, structured logs, and runtime health monitoring.

## Local development

```bash
npm ci
npm run check
# Generates package/, validates unversioned artifact integrity, and runs unit tests
```

If you want to deploy locally with wrangler, copy `.env.example` to `.env.local` and fill values.
If you want local Sentry events while running scripts manually, set `SENTRY_CURRENCY_API_DSN` or `SENTRY_DSN`.
