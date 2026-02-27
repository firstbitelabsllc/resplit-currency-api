# Resplit Currency API — Infrastructure

## Architecture

```
open.er-api.com (free, 160+ currencies)
        │
        ▼
GitHub Actions (daily cron @ 00:00 UTC)
        │
        ├──► Cloudflare Pages (primary CDN)
        │      resplit-currency-api.pages.dev
        │      {date}.resplit-currency-api.pages.dev
        │
        └──► GitHub Pages (fallback)
               firstbitelabsllc.github.io/resplit-currency-api
```

## Cloudflare Setup

- **Account**: (see 1Password / team admin)
- **Account ID**: (see .env.local or GitHub secrets)
- **Pages Project**: `resplit-currency-api`
- **Production URL**: https://resplit-currency-api.pages.dev
- **Wrangler CLI**: authenticated via `npx wrangler login` (OAuth stored at `~/.wrangler/config/default.toml`)

## GitHub Secrets (firstbitelabsllc/resplit-currency-api)

| Secret | Status | Notes |
|--------|--------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | Required | Verified by workflow before deploy |
| `CLOUDFLARE_API_TOKEN` | Required | Verified by workflow before deploy |
| `GITHUB_TOKEN` | Auto | Provided by GitHub Actions |

## URL Patterns

### iOS App (ResplitCurrencyProvider)

| Purpose | URL Pattern |
|---------|-------------|
| Historical (primary) | `https://{YYYY-MM-DD}.resplit-currency-api.pages.dev/v1/currencies/{code}.json` |
| Latest (v2) | `https://resplit-currency-api.pages.dev/v2/latest/{code}.json` |
| 7-day history (v2) | `https://resplit-currency-api.pages.dev/v2/history/7d/{code}.json` |
| Fallback | `https://firstbitelabsllc.github.io/resplit-currency-api/v1/currencies/{code}.json` |

### Deployments Per Run

Each daily run deploys to 3 Cloudflare branches:
1. `main` — production (`resplit-currency-api.pages.dev`)
2. `latest` — alias (`latest.resplit-currency-api.pages.dev`)
3. `{date}` — historical (`2026-02-26.resplit-currency-api.pages.dev`)

## Monitoring & Telemetry

### Built-in (free)
- **GitHub Actions**: Workflow run history, failure notifications (email by default)
- **Cloudflare Analytics**: Request counts, bandwidth, error rates per Pages project (Cloudflare dashboard → Pages → resplit-currency-api → Analytics)
- **GitHub Actions alerts**: Configure in repo Settings → Actions → Notifications

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
- **Artifact quality gate**: `scripts/validate-package.js` blocks deploy if v1/v2 structure is invalid
- **Post-deploy smoke check**: `scripts/smoke-check-deploy.js` verifies Cloudflare, dated branch, and GitHub fallback
