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
curl -s "$FX_WORKER_BASE_URL/history?from=AED&to=USD&start=$(date -u -v-7d +%Y-%m-%d)&end=$(date -u +%Y-%m-%d)" | head -c 200
curl -s "$FX_WORKER_BASE_URL/coverage?from=AED&to=USD&anchorDate=$(date -u +%Y-%m-%d)&days=30" | head -c 160
```

The production mirror should speak the same contract:
```bash
FX_WEB_BASE_URL="${FX_WEB_BASE_URL:-https://www.resplit.app/api/fx}"
curl -s "$FX_WEB_BASE_URL/quote?from=AED&to=USD&date=$(date -u +%Y-%m-%d)" | head -c 160
```

## Canonical Contract Probe

Use these probes when you need to prove the Worker and `/api/fx` mirrors still match:

```bash
FX_WORKER_BASE_URL="${FX_WORKER_BASE_URL:-https://fx.resplit.app}"
FX_WEB_BASE_URL="${FX_WEB_BASE_URL:-https://www.resplit.app/api/fx}"

curl -s "$FX_WORKER_BASE_URL/quote?from=USD&to=EUR&date=$(date -u +%Y-%m-%d)" | python3 -m json.tool
curl -s "$FX_WORKER_BASE_URL/history?from=USD&to=EUR&start=$(date -u -v-7d +%Y-%m-%d)&end=$(date -u +%Y-%m-%d)" | python3 -m json.tool
curl -s "$FX_WORKER_BASE_URL/coverage?from=USD&to=EUR&anchorDate=$(date -u +%Y-%m-%d)&days=7" | python3 -m json.tool
curl -s "$FX_WEB_BASE_URL/quote?from=USD&to=EUR&date=$(date -u +%Y-%m-%d)" | python3 -m json.tool
```

What to inspect:
- `quote.resolvedDate == requestedDate` means the quote is exact for the anchor date.
- `historyCoverage.archiveLatestDate` tells you the freshest retained day available to the route.
- `freshness.quoteResolvedLagDays` and `freshness.archiveLatestLagDays` are the explicit stale-data
  checks against the requested anchor date.
- `signals` should stay empty on healthy current-day runs; non-empty means fallback or gaps were used.

## Authoritative Cross-Repo Proof Set

Use this sequence when you need one fresh proof bundle that the publisher, Worker, web mirror,
and iOS consumer still agree on the live contract.

### 1. Publisher + CDN

```bash
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 3
cd /Users/leokwan/Development/resplit-currency-api
npm run smoke:deploy
```

Pass criteria:
- the latest `Update Currency Rates` run is `success`
- `npm run smoke:deploy` ends with `smoke-check-deploy: OK (...)`
- the smoke output reports today's `date` plus a non-empty 30-day history payload

### 2. Worker + web mirror parity

```bash
anchor=$(date -u +%Y-%m-%d)
start=$(date -u -v-7d +%Y-%m-%d)

curl -fsSL "https://fx.resplit.app/quote?from=USD&to=EUR&date=$anchor" | python3 -m json.tool
curl -fsSL "https://www.resplit.app/api/fx/quote?from=USD&to=EUR&date=$anchor" | python3 -m json.tool

curl -fsSL "https://fx.resplit.app/history?from=USD&to=EUR&start=$start&end=$anchor" | python3 -m json.tool
curl -fsSL "https://www.resplit.app/api/fx/history?from=USD&to=EUR&start=$start&end=$anchor" | python3 -m json.tool

curl -fsSL "https://fx.resplit.app/coverage?from=USD&to=EUR&anchorDate=$anchor&days=7" | python3 -m json.tool
```

Pass criteria:
- Worker + web mirror quotes match on `requestedDate`, `resolvedDate`, `rate`, and `resolutionKind`
- both history endpoints return full coverage (`requestedDays == availableDays`)
- Worker `/coverage` reports `mismatchCount = 0`, empty `signals`, and zero lag days

### 3. iOS consumer gate

```bash
cd /Users/leokwan/Development/resplit-ios
tuist generate --no-open
tuist test "ResplitCore Unit Tests" --no-selective-testing -- \
  -only-testing:ResplitCoreTests/FXRateProviderTests
tuist xcodebuild build -scheme 'Resplit Debug' \
  -derivedDataPath /tmp/resplit-dd-resplit-currency-fx-ops
```

Pass criteria:
- `FXRateProviderTests` stays green on the Worker-first fallback chain
- the generated `Resplit Debug` build succeeds after `tuist generate --no-open`
- if `tuist xcodebuild build` fails before generation, treat it as repo-shape drift rather than an FX outage

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

# Check the canonical Worker freshness view
curl -s "https://fx.resplit.app/coverage?from=USD&to=EUR&anchorDate=$(date -u +%Y-%m-%d)&days=7" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print({'resolvedDate': d['quote']['resolvedDate'], 'archiveLatestDate': d['historyCoverage']['archiveLatestDate'], 'freshness': d['freshness'], 'signals': d['signals']})"

# Check if cron is actually running
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 7
```

**Common causes**:
| Cause | Fix |
|-------|-----|
| Cron didn't fire | GitHub Actions cron can be delayed or skipped on inactive repos. Push a no-op commit or trigger manually. |
| Source API returning yesterday's data | `open.er-api.com` updates at different times. Usually resolves by ~02:00 UTC. |
| Worker/Web route serving fallback data | Inspect `freshness.*LagDays` and `signals` from `/coverage`; if lag is non-zero after the publish window, treat it as a real stale-data incident. |

### 3. iOS app shows "rate unavailable"

**Symptoms**: Conversion workbench can't fetch rates for a currency pair.

**Triage**:
1. Check if the API returns latest data for that currency:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/latest/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('from') == 'aed' and 'usd' in d.get('rates',{}))"
   ```
2. Check whether the canonical Worker and web mirror both resolve the pair:
   ```bash
   curl -s "https://fx.resplit.app/quote?from=AED&to=USD&date=$(date -u +%Y-%m-%d)" | python3 -m json.tool
   curl -s "https://www.resplit.app/api/fx/quote?from=AED&to=USD&date=$(date -u +%Y-%m-%d)" | python3 -m json.tool
   ```
3. Check if the historical date snapshot exists:
   ```bash
   curl -sI https://2026-01-15.resplit-currency-api.pages.dev/snapshots/base-rates.json | head -1
   ```
4. If 404 — that date is outside retained history or there is an archive gap. The app can still use a saved per-receipt conversion snapshot if one exists.
5. Validate fast-path artifacts:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/latest/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('from'), 'usd' in d.get('rates',{}))"
   curl -s https://resplit-currency-api.pages.dev/history/30d/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('points', len(d.get('points',[])))"
   ```

**Common causes**:
| Cause | Fix |
|-------|-----|
| Currency not in `open.er-api.com` | Check their supported list. Add a supplementary source if needed. |
| Historical date predates our pipeline | Fallback: the iOS app's `FXRateCache` serves previously fetched data. For dates before pipeline launch, rates will be unavailable. |
| Worker down | iOS `ResplitCurrencyProvider` falls back to `https://www.resplit.app/api/fx`, then `https://staging.resplit.app/api/fx`. |
| Worker + web mirrors down | iOS falls through to Cloudflare Pages, then GitHub Pages. |
| Worker + CDNs down | iOS app uses cached data from `FXRateCache`. Stale but functional. |

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

### 6. Cloudflare Pages warns about `pages_build_output_dir`

**Symptoms**: the workflow stays green, but each `wrangler pages deploy` step warns that
`wrangler.jsonc` is missing `pages_build_output_dir`.

**Current intentional state**:
- `wrangler.jsonc` is the canonical Worker config for `resplit-fx`, not the production
  source of truth for the Cloudflare Pages project.
- The publish job intentionally keeps Pages configuration dashboard-owned and uses direct
  uploads via `npx wrangler pages deploy package ...`.
- Leaving `pages_build_output_dir` unset keeps Wrangler in the documented local-dev-only
  path for that file and avoids accidentally promoting the Worker config into Pages
  production config.

**Do not “fix” this warning by blindly adding `pages_build_output_dir` to `wrangler.jsonc`.**
Cloudflare documents that once `pages_build_output_dir` is present, the Wrangler file
becomes the source of truth for the Pages project, so every existing key in the file must
be production-correct for Pages too.

**Only act if you are intentionally migrating Pages config into source control**:
```bash
npx wrangler pages download config resplit-currency-api
```

Then review the generated Pages config against dashboard reality before replacing or
splitting the current Worker-focused config.

### 7. Side-load upload or list fails

**Symptoms**: iOS sideload client gets 502 `SIDELOAD_FAILED`, 401/403 auth errors,
or upload returns `SIZE_MISMATCH`/`HASH_MISMATCH`.

**Triage**:
```bash
# Verify auth is working (needs CF Access credentials)
curl -s -H "Cf-Access-Authenticated-User-Email: leojkwan@gmail.com" \
  "https://fx.resplit.app/sideload/photos" | python3 -m json.tool

# Check if preflight works (no auth needed)
curl -sI -X OPTIONS "https://fx.resplit.app/sideload/photos"

# Check Cloudflare Workers logs for errors
npx wrangler tail resplit-fx --format json 2>/dev/null | head -20
```

**Common causes**:
| Cause | Fix |
|-------|-----|
| `AUTH_MISSING` (401) | CF Access not configured for `/sideload/*` path, or iOS client not sending credentials |
| `FORBIDDEN_NOT_WHITELISTED` (403) | Email doesn't match `leojkwan@gmail.com` (case-insensitive) |
| `SIZE_MISMATCH` (400) | Client declared one size but sent different bytes. Verify client-side byte counting. |
| `HASH_MISMATCH` (409) | SHA-256 doesn't match. Check for stream corruption or encoding issues. pending.json is auto-cleaned. |
| `INVALID_CONTENT_TYPE` (400) | Only jpeg/png/heic/webp allowed |
| `NOT_FOUND` (404) on `_bytes` | No pending upload — client must call `/upload` first |
| `SIDELOAD_FAILED` (502) | Unexpected R2 error — check Sentry for the stack trace |

**R2 bucket inspection** (manual, via wrangler):
```bash
# List objects in the staging bucket
npx wrangler r2 object list resplit-sideload-staging --prefix "users/"

# Check if pending uploads are leaking (should be empty normally)
npx wrangler r2 object list resplit-sideload-staging --prefix "users/" | grep pending
```

**Rollback**: Sideload routes are fully isolated from FX routes. If sideload is broken,
FX `/quote`, `/history`, `/coverage` continue working unaffected. To disable sideload
without redeploying, remove the Cloudflare Access Application covering `/sideload/*`.

## Monitoring Setup (Optional)

### Email alerts (free, already on)
GitHub sends failure emails to repo admins by default.

### Sentry + Grafana command center
The publisher now emits grouped issues, structured logs, and cron check-ins to Sentry. The Worker can also export traces directly to Grafana Cloud Tempo when OTLP secrets are configured.

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

Optional Worker trace secrets (Wrangler, not GitHub secrets):
```bash
npx wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT
npx wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
```

Repo alias pair if you do not want the standard OTEL env names:
```bash
npx wrangler secret put OTEL_ENDPOINT
npx wrangler secret put OTEL_AUTH_HEADER
```

Note: this repo exposes `/cron/fx-canary` and reports Sentry canary check-ins when that route is called, but it does not schedule the route on its own. Wire an external scheduler before treating the Worker canary as live recurring coverage.

Current monitor + signal model:
- Cron monitor slug: `resplit-currency-api-daily-publish`
- Schedule: `0 0,3 * * *` UTC (midnight publish pass plus 03:00 UTC refresh)
- Scope: scheduled GitHub Actions runs only; `workflow_dispatch` reruns still log/report issues but skip cron check-ins so they cannot falsely fail the daily monitor
- Workflow tag: `daily_publish`
- Public `/coverage` route mismatches stay as structured warning logs only; Sentry issue creation is reserved for the cron canary so expected pre-publish fallback diagnostics do not open false production issues.
- Grafana Cloud Worker traces use `worker/src/otel.mjs` + `@microlabs/otel-cf-workers` and show up under `service.name=resplit-currency-api-worker` once the OTLP secrets are present and the Worker is redeployed.
- `scripts/verify-grafana-tempo.mjs` emits an opt-in `/coverage` verification span keyed by `x-request-id`, then polls Tempo until that exact span appears.
- The same verification request returns safe `x-resplit-otel-*` headers so the smoke fails fast when the deployed Worker is missing OTLP endpoint/auth secrets.
- Grouped issue signals:
  - `currency_publish_failed`
  - `upstream_fetch_failure`
  - `history_window_shorter_than_30_days`
  - `missing_dated_snapshot_deployment`
  - `cloudflare_deploy_failure`
  - `github_pages_deploy_failure`
  - `fx_worker_deploy_failure`
  - `smoke_check_mismatch`
  - `validate_package_failed`
  - `worker_route_exception`
  - `coverage_failure`
  - `canary_error`

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

Tempo verification after OTLP secrets are set:
```bash
npm run smoke:deploy
npm run observability:tempo-smoke -- --base-url https://fx.resplit.app
# or run against local wrangler dev:
# npm run observability:tempo-smoke -- --base-url http://127.0.0.1:8787
```

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
open.er-api.com ──► GitHub Actions (00:00 UTC publish pass + 03:00 UTC refresh, ~40s/run)
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
