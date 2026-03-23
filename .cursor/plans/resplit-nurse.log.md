# Resplit Nurse Log

## 2026-03-23 16:40 EDT

- Rehydrated repo-owned state for `resplit-currency-api`: no local `RALPH.md`, no existing `.cursor/plans`, clean `main`, and recent ledger entries showed the hot launch blockers living in `resplit-ios`, not this repo.
- Fresh local proof passed on current trunk:
  - `npm ci`
  - `npm run check`
  - `npm run smoke:deploy`
  - live checks against `https://resplit-currency-api.pages.dev`, `https://firstbitelabsllc.github.io/resplit-currency-api`, and `https://fx.resplit.app`
- Found a repo-truth drift during regeneration: local `snapshot-archive/2026-03-23.json` and the live dated Pages snapshot matched each other, but both differed from `HEAD`.
- Repaired the drift by dispatching GitHub Actions run `23458934398` (`Update Currency Rates`), which completed green and advanced `origin/main` to commit `3b482b16` (`chore: archive daily snapshot 2026-03-23`). The downstream `gh-pages` deployment run `23458987968` also completed green.
- Fast-forwarded the local checkout to `3b482b16`. Repo is clean again on `main`.
- Status: API lane is `GO`; launch remains blocked outside this repo by the still-open App Store feedback items tracked in `resplit-ios`.
- Exact next slice in this repo: refresh `.github/workflows/run.yml` action pins for the Node 24 transition warning emitted by run `23458934398`, then rerun the workflow once to confirm the warning clears without regressing publish/deploy.

## 2026-03-23 19:40 EDT

- Shipped `a8f92b4f` (`ci: remove node20 action runtime from publisher`) on `main`.
- Updated `.github/workflows/run.yml` to:
  - pin `actions/checkout` to `v6.0.2` and `actions/setup-node` to `v6.3.0` (both Node 24-native)
  - force JavaScript actions onto Node 24 now
  - replace `cloudflare/wrangler-action` with direct `npx wrangler` deploy commands
  - replace `peaceiris/actions-gh-pages` with an explicit git-based `gh-pages` publish step
- Fresh proof this run:
  - `npm run check`
  - `npm run smoke:deploy`
  - GitHub Actions run `23465564691` on commit `a8f92b4f` completed green
  - exact `Node.js 20 actions are deprecated` warning is gone from the run log
- Current repo status: `GO`. No actionable blocker remains in `resplit-currency-api`; launch blockers are still outside this repo in `resplit-ios`.
- Non-blocking follow-up signal: the workflow still warns that `SENTRY_DSN` and `CRON_SECRET` are not configured for the FX Worker runtime.
