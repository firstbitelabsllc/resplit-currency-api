---
name: hooks
description: Canonical build, validation, smoke, and health-check commands for resplit-currency-api.
---

# Hooks

Use these commands as the canonical execution path for this repo.

## Bootstrap

```bash
npm ci
```

## Core Gates

```bash
npm run check
npm run smoke:deploy
```

`npm run check` regenerates `package/`, validates artifacts, and runs the Node test suite.

`npm run smoke:deploy` verifies:
- Cloudflare Pages latest artifacts
- dated snapshot deployment
- GitHub Pages fallback
- canonical Worker host via `FX_WORKER_BASE_URL` or `https://fx.resplit.app`

## Live Health Checks

```bash
curl -s https://resplit-currency-api.pages.dev/latest/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/history/30d/aed.json | head -c 100
curl -s https://resplit-currency-api.pages.dev/archive-manifest.json | head -c 120
curl -s https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json | head -c 100
FX_WORKER_BASE_URL="${FX_WORKER_BASE_URL:-https://fx.resplit.app}"
curl -s "$FX_WORKER_BASE_URL/quote?from=AED&to=USD&date=$(date -u +%Y-%m-%d)" | head -c 160
curl -s "$FX_WORKER_BASE_URL/coverage?from=AED&to=USD&anchorDate=$(date -u +%Y-%m-%d)&days=30" | head -c 160
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5
```

## Release Triage

```bash
gh run view <RUN_ID> --repo firstbitelabsllc/resplit-currency-api --log-failed
gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api
```

If a publish run is red, repair the failing slice on trunk, rerun the workflow, and only then update the nurse log.
