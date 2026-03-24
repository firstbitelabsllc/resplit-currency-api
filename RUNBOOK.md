# Resplit Currency API — Runbook

## Quick Health Check

```bash
# Is the API serving data?
curl -s https://resplit-currency-api.pages.dev/latest/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/history/30d/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/archive-manifest.json | head -c 120

# Is today's historical snapshot deployed?
curl -s https://$(date -u +%Y-%m-%d).resplit-currency-api.pages.dev/snapshots/base-rates.json | head -c 100

# Is the GitHub Pages fallback alive?
curl -s https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json | head -c 100

# Last workflow run status
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5
```

Also verify the canonical Worker host (`https://fx.resplit.app`) unless you explicitly override it:
```bash
FX_WORKER_BASE_URL="${FX_WORKER_BASE_URL:-https://fx.resplit.app}"
curl -s "$FX_WORKER_BASE_URL/quote?from=AED&to=USD&date=$(date -u +%Y-%m-%d)" | head -c 160
curl -s "$FX_WORKER_BASE_URL/coverage?from=AED&to=USD&anchorDate=$(date -u +%Y-%m-%d)&days=30" | head -c 160
```

## Failure Scenarios

### 1. Pipeline failed (GitHub Actions red)

**Symptoms**: No new data today, workflow shows failed in Actions tab.

**Triage**:
```bash
# Check the latest run
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 1

# View logs for a failed run
gh run view <RUN_ID> --repo firstbitelabsllc/resplit-currency-api --log-failed
```

**Common causes**:
| Cause | Fix |
|-------|-----|
| `open.er-api.com` is down | Pipeline auto-retries once. If still failing, wait and re-trigger manually. Consider adding a backup source (see "Upstream data source dies" below). |
| `npm ci` fails | Check `package-lock.json` integrity, run `npm ci` locally to reproduce. |
| Cloudflare deploy fails | Check `CLOUDFLARE_API_TOKEN` hasn't expired/been revoked. Verify at dash.cloudflare.com/profile/api-tokens. |
| GitHub Pages deploy fails | Check repo settings — Pages must be enabled, source set to `gh-pages` branch. |

**Manual re-trigger**:
```bash
gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api
```

### 2. Data is stale (pipeline succeeds but rates are old)

**Symptoms**: `date` field in JSON shows yesterday or older.

**Triage**:
```bash
# Check what date the API is serving
curl -s https://resplit-currency-api.pages.dev/latest/usd.json | python3 -c "import json,sys; print(json.load(sys.stdin)['date'])"

# Check if cron is actually running
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 7
```

**Common causes**:
| Cause | Fix |
|-------|-----|
| Cron didn't fire | GitHub Actions cron can be delayed or skipped on inactive repos. Push a no-op commit or trigger manually. |
| Source API returning yesterday's data | `open.er-api.com` updates at different times. Usually resolves by ~02:00 UTC. |

### 3. iOS app shows "rate unavailable"

**Symptoms**: Conversion workbench can't fetch rates for a currency pair.

**Triage**:
1. Check if the API returns latest data for that currency:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/latest/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('from') == 'aed' and 'usd' in d.get('rates',{}))"
   ```
2. Check if the historical date snapshot exists:
   ```bash
   curl -sI https://2026-01-15.resplit-currency-api.pages.dev/snapshots/base-rates.json | head -1
   ```
3. If 404 — that date is outside retained history or there is an archive gap. The app can still use a saved per-receipt conversion snapshot if one exists.
4. Validate fast-path artifacts:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/latest/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('from'), 'usd' in d.get('rates',{}))"
   curl -s https://resplit-currency-api.pages.dev/history/30d/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('points', len(d.get('points',[])))"
   ```

**Common causes**:
| Cause | Fix |
|-------|-----|
| Currency not in `open.er-api.com` | Check their supported list. Add a supplementary source if needed. |
| Historical date predates our pipeline | Fallback: the iOS app's `FXRateCache` serves previously fetched data. For dates before pipeline launch, rates will be unavailable. |
| Cloudflare Pages down | iOS `ResplitCurrencyProvider` auto-falls back to GitHub Pages URL. |
| Both CDNs down | iOS app uses cached data from `FXRateCache`. Stale but functional. |

### 4. Cloudflare token expired or revoked

**Symptoms**: Pipeline runs but Cloudflare deploy step fails.

**Fix**:
1. Go to dash.cloudflare.com → Profile → API Tokens
2. Create new token (use "Edit Cloudflare Workers" template, select the team account)
3. Update the GitHub secret:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --repo firstbitelabsllc/resplit-currency-api --body "NEW_TOKEN_HERE"
   ```
4. Re-trigger the workflow.

### 5. Upstream data source dies permanently

**Symptoms**: `open.er-api.com` returns errors for multiple days.

**Options** (in order of effort):
1. **Swap source in `currscript.js`** — replace the fetch URL with another free API (e.g., `exchangerate-api.com`, `currencyapi.com`). Same JSON output format, no iOS changes needed.
2. **Add a paid source** — sign up for a paid API, add the key as a GitHub secret, update the fetch function.
3. **Fall back to fawazahmed0 CDN** — the original upstream still publishes daily. Change iOS URLs back temporarily.

## Monitoring Setup (Optional)

### Email alerts (free, already on)
GitHub sends failure emails to repo admins by default.

### Sentry command center (now wired)
The publisher now emits grouped issues, structured logs, and cron check-ins to Sentry.

Preferred GitHub secret:
```bash
gh secret set SENTRY_CURRENCY_API_DSN --repo firstbitelabsllc/resplit-currency-api --body "YOUR_PROJECT_DSN"
```

Shared fallback secret still supported:
```bash
gh secret set SENTRY_DSN --repo firstbitelabsllc/resplit-currency-api --body "SHARED_PROJECT_DSN"
```

Optional Worker canary secret:
```bash
gh secret set CRON_SECRET --repo firstbitelabsllc/resplit-currency-api --body "LONG_RANDOM_SECRET"
```

Note: this repo exposes `/cron/fx-canary` and reports Sentry canary check-ins when that route is called, but it does not schedule the route on its own. Wire an external scheduler before treating the Worker canary as live recurring coverage.

Current monitor + signal model:
- Cron monitor slug: `resplit-currency-api-daily-publish`
- Schedule: `0 0 * * *` UTC
- Workflow tag: `daily_publish`
- Grouped issue signals:
  - `upstream_fetch_failure`
  - `history_window_shorter_than_30_days`
  - `missing_dated_snapshot_deployment`
  - `cloudflare_deploy_failure`
  - `github_pages_deploy_failure`
  - `fx_worker_deploy_failure`
  - `smoke_check_mismatch`
  - `validate_package_failed`

Quick verification after a manual workflow run:
```bash
gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 3
```

Expected workflow env wiring:
- `SENTRY_CURRENCY_API_DSN`: preferred DSN
- `SENTRY_DSN`: shared fallback only
- `SENTRY_ENVIRONMENT=production`
- `SENTRY_RELEASE=${GITHUB_SHA}`

### Slack webhook (5 min setup)
Add to `.github/workflows/run.yml` after the deploy steps:
```yaml
- name: Notify Slack
  if: failure()
  run: |
    curl -X POST "${{ secrets.SLACK_WEBHOOK }}" \
      -H 'Content-Type: application/json' \
      -d '{"text":"Resplit Currency API pipeline failed. Check: https://github.com/firstbitelabsllc/resplit-currency-api/actions"}'
```

### Uptime ping (free)
Set up UptimeRobot to check:
- `https://resplit-currency-api.pages.dev/latest/usd.json`
- `https://resplit-currency-api.pages.dev/history/30d/usd.json`

## Architecture Recap

```
open.er-api.com ──► GitHub Actions (daily 00:00 UTC, ~40s)
                         │
                    ┌────┴──────────────────────────────────────┐
                    ▼                               ▼
            snapshot-archive/               ┌───────┴───────┐
            (committed to repo,             ▼               ▼
             local-first history,     Cloudflare        GitHub
             365-day retention)        Pages            Pages
                    │                       │               │
                    └──────────────┬────────┴───────────────┘
                                   ▼
                           FX Worker (canonical API)
                                   │
                                   ▼
                           iOS App / resplit-web
                                   │
                                   ▼
                             FXRateCache (short-lived)
```

History is built from the committed `snapshot-archive/` directory (local-first, 365-day retention).
Dated Cloudflare branch deployments are a network fallback only, used to backfill
missing days (e.g., first run or recovery from a reset).

## Key Files

| File | Purpose |
|------|---------|
| `currscript.js` | Fetch rates, generate JSON files, manage snapshot archive |
| `snapshot-archive/` | Committed daily snapshots (~5KB each, retained for 365 days with small gaps tolerated). Local-first history source. |
| `worker/` | Cloudflare Worker runtime for canonical `quote`, `history`, `coverage`, and `cron/fx-canary` routes |
| `wrangler.jsonc` | Worker deployment config |
| `.github/workflows/run.yml` | Daily cron, deploy to CDNs, commit archive |
| `scripts/sentry-monitoring.js` | Shared Sentry issue, log, and cron check-in helper |
| `scripts/sentry-checkin.js` | Workflow helper for start/finish/error check-ins |
| `scripts/validate-package.js` | Validates generated package structure and numeric consistency |
| `scripts/smoke-check-deploy.js` | Verifies Pages, dated snapshot, GitHub fallback, and canonical Worker after publish (`SKIP_WORKER_SMOKE_CHECK=1` only when you intentionally need to bypass the Worker check) |
| `.env.local` | Local Cloudflare credentials (gitignored) |
| `INFRASTRUCTURE.md` | Account IDs, URLs, secrets inventory |
| `package.json` | Dependencies and publisher scripts |

## Credentials

| Credential | Location | Rotation |
|------------|----------|----------|
| Cloudflare Account ID | GitHub secret + `.env.local` | Never changes |
| Cloudflare API Token | GitHub secret + `.env.local` | No expiration, rotate if compromised |
| Sentry DSN | GitHub secret (`SENTRY_CURRENCY_API_DSN`, fallback `SENTRY_DSN`) | Rotate when project DSN changes |
| Cron Secret | GitHub secret (`CRON_SECRET`) + Worker secret | Rotate on suspected exposure |
| GitHub Token | Auto-provided by Actions | Auto-rotated |
