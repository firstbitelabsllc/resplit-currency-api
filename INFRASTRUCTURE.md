# Resplit Currency API — Infrastructure

## Architecture

```
open.er-api.com (free, 160+ currencies)
        │
        ▼
GitHub Actions (daily cron @ 00:00 UTC)
        │
        ├──► snapshot-archive/ (committed to repo, local-first history)
        │
        ├──► Cloudflare Pages (artifact CDN)
        │      resplit-currency-api.pages.dev
        │      {date}.resplit-currency-api.pages.dev (fallback only)
        │
        ├──► Cloudflare Worker (canonical FX API)
        │      fx.resplit.app
        │
        └──► GitHub Pages (fallback)
               firstbitelabsllc.github.io/resplit-currency-api
```

The `snapshot-archive/` directory stores one JSON file per day (~5KB each).
`buildSnapshotWindow` reads these local files first, only falling back to
dated Cloudflare branch deployments for missing days. Files older than
`snapshotRetentionDays` (365) are pruned automatically. Small archive gaps are
allowed and surfaced via `archive-manifest.json` and the canonical coverage route.

## Cloudflare Setup

- **Account**: (see 1Password / team admin)
- **Account ID**: (see .env.local or GitHub secrets)
- **Pages Project**: `resplit-currency-api`
- **Production URL**: https://resplit-currency-api.pages.dev
- **Worker Name**: `resplit-fx`
- **Wrangler CLI**: authenticated via `npx wrangler login` (OAuth stored at `~/.wrangler/config/default.toml`)

## GitHub Secrets (firstbitelabsllc/resplit-currency-api)

| Secret | Status | Notes |
|--------|--------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | Required | Verified by workflow before deploy |
| `CLOUDFLARE_API_TOKEN` | Required | Verified by workflow before deploy |
| `SENTRY_CURRENCY_API_DSN` | Recommended | Preferred DSN for the dedicated currency-api Sentry project |
| `SENTRY_DSN` | Optional fallback | Shared fallback DSN if the dedicated project secret is not configured |
| `CRON_SECRET` | Optional but recommended | Protects `/cron/fx-canary` |
| `GITHUB_TOKEN` | Auto | Provided by GitHub Actions |

## URL Patterns

### Artifacts

| Purpose | URL Pattern |
|---------|-------------|
| Latest | `https://resplit-currency-api.pages.dev/latest/{code}.json` |
| 30-day history | `https://resplit-currency-api.pages.dev/history/30d/{code}.json` |
| Dated snapshot | `https://{YYYY-MM-DD}.resplit-currency-api.pages.dev/snapshots/base-rates.json` |
| Fallback | `https://firstbitelabsllc.github.io/resplit-currency-api/latest/{code}.json` |

### Canonical API

| Purpose | URL Pattern |
|---------|-------------|
| Quote | `https://fx.resplit.app/quote?from={code}&to={code}&date={YYYY-MM-DD}` |
| History | `https://fx.resplit.app/history?from={code}&to={code}&start={YYYY-MM-DD}&end={YYYY-MM-DD}` |
| Coverage | `https://fx.resplit.app/coverage?from={code}&to={code}&anchorDate={YYYY-MM-DD}&days=30` |

### Deployments Per Run

Each daily run deploys to 3 Cloudflare branches:
1. `main` — production (`resplit-currency-api.pages.dev`)
2. `latest` — alias (`latest.resplit-currency-api.pages.dev`)
3. `{date}` — historical (`2026-02-26.resplit-currency-api.pages.dev`)

## Monitoring & Telemetry

### Built-in (free)
- **GitHub Actions**: Workflow run history, failure notifications (email by default)
- **Cloudflare Analytics**: Request counts, bandwidth, error rates per Pages project (Cloudflare dashboard → Pages → resplit-currency-api → Analytics)
- **Cloudflare Workers Analytics**: Request counts, errors, p95 latency per Worker
- **GitHub Actions alerts**: Configure in repo Settings → Actions → Notifications
- **Sentry**: grouped publisher and Worker issues, structured logs, and cron monitor check-ins via `scripts/sentry-monitoring.js`, `scripts/sentry-checkin.js`, and `worker/src/monitoring.mjs`

### Optional Upgrades
- **Cloudflare Web Analytics**: Add JS snippet to track real usage (free, no cookies)
- **Uptime monitoring**: Use UptimeRobot (free, 5-min checks) or Checkly to ping the production URL
- **Slack/Discord webhook**: Add a step in run.yml to POST on success/failure
- **Datadog**: Overkill for a static file CDN — Cloudflare Analytics covers what you need

## Data Source

- **Primary**: open.er-api.com (free, no API key, ~160 fiat currencies, updated daily)
- **Fallback**: api.frankfurter.dev (ECB data, ~30 currencies)
- **License**: Data from ECB and other central banks, no commercial restrictions

## Maintenance

- **Upstream sync**: `git fetch upstream && git merge upstream/main` (if fawazahmed0 adds improvements)
- **Adding currencies**: Add to data source or supplement with additional API
- **Token rotation**: Regenerate CLOUDFLARE_API_TOKEN periodically at dash.cloudflare.com/profile/api-tokens
- **Local env template**: `.env.example` documents required local deploy vars
- **Artifact quality gate**: `scripts/validate-package.js` blocks deploy if unversioned structure is invalid
- **Post-deploy smoke check**: `scripts/smoke-check-deploy.js` verifies Cloudflare, dated branch, GitHub fallback, and the canonical Worker (`https://fx.resplit.app`) by default
