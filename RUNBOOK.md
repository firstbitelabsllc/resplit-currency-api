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

## Reliability Cockpit

Use the local cockpit when you need one operator view that joins repo-owned
local CI, git/source state, agent/nurse-log truth, release gates, and
OTEL/Grafana readiness:

```bash
npm run reliability:cockpit
open reports/resplit-fx-reliability-cockpit.html
```

The cockpit is read-only and writes ignored local artifacts under `reports/`.
It does not run live deploys, mutate Cloudflare/GitHub/Grafana, or replace
`npm run check`, `npm run smoke:deploy`, or the strict release-history gate. A
green local-CI lane is only trusted after the FirstBite MCP records a matching
report/log artifact with source state for `resplit_currency_api`.

The cockpit also renders a `Tracked Source Contract`. Launch trust requires the
repo-owned `.firstbite/local-ci.json`, package scripts used by declared lanes
such as `check:publish`, and their script file inputs to exist on the tracked
execution source (`HEAD` and current `origin/main`). A dirty-current pass with
current-only manifest/scripts is an operator hint, not clean release proof.
The latest MCP proof must also have run the same lane commands declared by the
current manifest; same lane IDs with different commands are treated as command
drift, not green proof.

When the source contract is red, write the read-only promotion packet before
staging anything:

```bash
npm run source:promotion-packet
open reports/resplit-fx-source-promotion-packet.md
```

The packet is built from the same cockpit model and separates exact stage
candidates from dirty files that should be held by default, including agent
local state, snapshot archives, queue files, and Cloudflare/config edits that
need separate review. It prints the exact `git add -- ...` command for the
candidate bundle, plus an unstage command, but does not run either.

Use the cockpit `Trust Contracts` table as the handoff checklist. It maps each
red/yellow boundary to current truth, the proof artifact that would make the
claim inspectable, and the next operator action. This is the first place to look
before deciding whether to rerun local CI, reload the MCP host, attach Grafana
evidence, or keep release-history readiness yellow.

The `Operator Recovery Flow` and `Operator Action Queue` above the trust table
are the working order for the current operator. The flow names the next safe
local command, the first dependency-blocked action, and boundary counts; the
queue keeps the full prioritized rows with owner, runnable command, proof
requirement, and blocker text. Source promotion, clean FirstBite proof, loaded
MCP refresh, Grafana evidence, and release-history repair must stay distinct
instead of blending into one red badge.

Use the `Proof Freshness Ledger` before trusting any red/yellow/green badge.
It separates artifact freshness from trust status, so a proof can be fresh but
still red, or stale even when the underlying contract is otherwise understood.
Refresh stale rows with the listed next action before making launch claims.

Use the cockpit `Agent Activity Matrix` when you need to trust local coding
agent handoffs. It summarizes recent repo-scoped ledger rows by status, age,
agent family, lane, handoff state, proof artifact, and summary. Treat yellow or
red rows as follow-up signals; the table is read-only and derives from the
append-only repo/shared ledgers.

When handing this lane across agents, prefer the bundled local preflight:

```bash
npm run trust:preflight
```

It runs syntax checks, targeted cockpit/Grafana/preflight tests, the
missing-config Grafana verifier, and cockpit regeneration, then writes
`reports/resplit-fx-trust-preflight.json` plus
`reports/resplit-fx-trust-preflight.md`. The command intentionally exits nonzero
while the cockpit verdict is red; inspect the artifact instead of treating the
process exit alone as the result. Use `npm run trust:preflight -- --full` when
you also need the full test suite, `check:publish`, live deploy smoke, and strict
release-history validation captured in one bundle.

OTEL/Grafana stays yellow until there is a fresh Tempo + Loki evidence artifact.
The read-only verifier below can create that artifact after Grafana Cloud and
Cloudflare Observability Pipeline destinations exist:

```bash
GRAFANA_BASE_URL="https://<stack>.grafana.net" \
GRAFANA_API_TOKEN="<read-only service account token>" \
GRAFANA_TEMPO_DATASOURCE_UID="<tempo uid>" \
GRAFANA_LOKI_DATASOURCE_UID="<loki uid>" \
npm run observability:otel-smoke -- --since-minutes 60
```

For a local contract check without touching the Worker or Grafana, run:

```bash
npm run observability:otel-smoke -- --skip-trigger
```

That writes `reports/grafana-otel-smoke.json` with a yellow missing-config
status when the required Grafana env is absent. It never writes the Grafana API
token into the report.

MCP source state has two meanings in current reports. `primary_source_state` is
the repo checkout that declared the lane. `execution_source_state` is the
directory where the command actually ran, usually a disposable worktree.
Compatibility `source_state` mirrors execution truth. Clean launch proof
requires the execution source to be clean and current with `origin/main`; a
dirty primary checkout is still an operator risk and should stay visible.

For host-loaded MCP drift, mirror the current Codex/Cursor `firstbite-local-ci`
`list_lanes` output into `reports/firstbite-loaded-mcp-lanes.json` before
regenerating the cockpit. The cockpit compares that loaded catalog against
`.firstbite/local-ci.json` and stays red when the host process is missing
`resplit_currency_api` or any declared FX lane. The repo-backed MCP package is
the fallback source of truth until the host app restarts. The loaded-host probe
artifact must also be fresh; artifacts older than 60 minutes are yellow even
when their catalog contents look correct.

```bash
# Live capture after restarting/reloading the Codex/Cursor MCP host.
mcp__firstbite_local_ci.list_lanes > /tmp/firstbite-loaded-mcp.json
npm run mcp:loaded-probe -- --input /tmp/firstbite-loaded-mcp.json

# Refresh only the prior artifact timestamp while preserving its payload.
# This keeps stale-host evidence fresh, but it is not host-restart proof.
npm run mcp:loaded-probe -- --reuse-existing
npm run reliability:cockpit
```

For the repo-backed package comparison:

```bash
cd /Users/leokwan/Development/ai-leo/skills/resplit-watch/mcp/firstbite-local-ci
npm run --silent call -- list_lanes '{}'
```

`npm run reliability:cockpit` also runs that repo-backed `list_lanes` probe
read-only and renders a `Repo-Backed MCP Catalog` section. Treat that section
as the control-plane source of truth and the `Loaded MCP Probe` as the current
Codex/Cursor host truth. A green repo-backed catalog with a red loaded probe
means the package is fixed but the long-lived host process still needs restart;
it is not a loaded-host green. The `MCP Catalog Delta` section compares those
two catalogs directly and must clear before trusting loaded-host execution. Use
`--skip-repo-backed-mcp` only when debugging the cockpit without touching the
MCP package process.

The `FirstBite Operating Readout` section also renders the M4 peer execution
boundary. A healthy Moussey or M4 HTTP/LAN response is support evidence only;
the peer is not execution-ready until an M4-local `run_lanes` execute report
exists. If the cockpit shows `M4 peer support-only`, use the linked fresh-clone
commands on the M4 Pro and recapture the readout instead of treating a Studio
handoff or ping as lane proof.

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
npm run check:publish
npm run smoke:deploy
```

Pass criteria:
- the latest `Update Currency Rates` run is `success`
- `npm run check:publish` passes locally or in Actions, with no unexpected validation errors
- `npm run smoke:deploy` ends with `smoke-check-deploy: OK (...)`
- the smoke output reports today's UTC `date` plus a 30-point history payload

`npm run smoke:deploy` fails stale deployments by default. Use `EXPECTED_DATE=yyyy-mm-dd` for a
known workflow date, or `ALLOW_STALE_DEPLOY_SMOKE=1` only for diagnostics when you intentionally
need to inspect the latest deployed stale package.

For release readiness, run `npm run check`. It is stricter than the publish-recovery gate and fails
when the actual latest 30-calendar-day `history/30d` window is incomplete.

When a release-history gap needs backfill, audit sources before writing any snapshot:

```bash
npm run audit:backfill-sources -- --from 2026-05-12 --to 2026-05-23
```

Pass criteria:
- every missing date reports at least one `complete=` source
- the source covers the full current package currency set, not just canary pairs
- no snapshot is written from merged or partial third-party data unless the package contract is explicitly changed

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
- Schedule: `0 0,3 * * *` UTC (midnight publish pass plus 03:00 UTC refresh)
- Scope: scheduled GitHub Actions runs only; `workflow_dispatch` reruns still log/report issues but skip cron check-ins so they cannot falsely fail the daily monitor
- Workflow tag: `daily_publish`
- Public `/coverage` route mismatches stay as structured warning logs only; Sentry issue creation is reserved for the cron canary so expected pre-publish fallback diagnostics do not open false production issues.
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
| `scripts/audit-history-backfill-sources.js` | Read-only audit for historical source completeness before backfilling snapshot gaps. Fails closed when no single source covers the full current package currency set. |
| `scripts/validate-package.js` | Validates generated package structure and numeric consistency. Default mode is publish-recovery tolerant; `STRICT_HISTORY_COVERAGE=1` / `npm run validate:release` requires full 30-calendar-day history. |
| `scripts/smoke-check-deploy.js` | Verifies Pages, dated snapshot, GitHub fallback, and canonical Worker after publish. Defaults to current UTC date; `EXPECTED_DATE=yyyy-mm-dd` pins workflow checks, `ALLOW_STALE_DEPLOY_SMOKE=1` is diagnostic-only, and `SKIP_WORKER_SMOKE_CHECK=1` only bypasses the Worker check intentionally. |
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
