# Resplit Currency API — Runbook

## Quick Health Check

```bash
# Is the API serving data?
curl -s https://resplit-currency-api.pages.dev/v1/currencies/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/v2/latest/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/v2/history/7d/aed.json | head -c 100

# Is today's historical snapshot deployed?
curl -s https://$(date -u +%Y-%m-%d).resplit-currency-api.pages.dev/v1/currencies/aed.json | head -c 100

# Is the GitHub Pages fallback alive?
curl -s https://firstbitelabsllc.github.io/resplit-currency-api/v1/currencies/aed.json | head -c 100

# Last workflow run status
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5
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
curl -s https://resplit-currency-api.pages.dev/v1/currencies/usd.json | python3 -c "import json,sys; print(json.load(sys.stdin)['date'])"

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
1. Check if the API returns data for that currency:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/v1/currencies/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('usd' in d.get('aed',{}))"
   ```
2. Check if the historical date exists:
   ```bash
   curl -sI https://2026-01-15.resplit-currency-api.pages.dev/v1/currencies/aed.json | head -1
   ```
3. If 404 — that date was before the pipeline started. Historical data only exists from the first run onward.
4. Validate v2 fast-path artifacts:
   ```bash
   curl -s https://resplit-currency-api.pages.dev/v2/latest/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('from'), 'usd' in d.get('rates',{}))"
   curl -s https://resplit-currency-api.pages.dev/v2/history/7d/aed.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('points', len(d.get('points',[])))"
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
- `https://resplit-currency-api.pages.dev/v1/currencies/usd.json`
- `https://resplit-currency-api.pages.dev/v2/latest/usd.json`
- `https://resplit-currency-api.pages.dev/v2/history/7d/usd.json`

## Architecture Recap

```
open.er-api.com ──► GitHub Actions (daily 00:00 UTC, ~40s)
                         │
                    ┌────┴────┐
                    ▼         ▼
            Cloudflare    GitHub
             Pages         Pages
                    │         │
                    └────┬────┘
                         ▼
                   iOS App (ResplitCurrencyProvider)
                         │
                         ▼
                    FXRateCache (on-device)
```

## Key Files

| File | Purpose |
|------|---------|
| `currscript.js` | Fetch rates, generate JSON files |
| `.github/workflows/run.yml` | Daily cron, deploy to CDNs |
| `scripts/validate-package.js` | Validates generated package structure and numeric consistency |
| `scripts/smoke-check-deploy.js` | Verifies deployed endpoints after publish |
| `.env.local` | Local Cloudflare credentials (gitignored) |
| `INFRASTRUCTURE.md` | Account IDs, URLs, secrets inventory |
| `package.json` | Dependencies (just `fs-extra`) |

## Credentials

| Credential | Location | Rotation |
|------------|----------|----------|
| Cloudflare Account ID | GitHub secret + `.env.local` | Never changes |
| Cloudflare API Token | GitHub secret + `.env.local` | No expiration, rotate if compromised |
| GitHub Token | Auto-provided by Actions | Auto-rotated |
