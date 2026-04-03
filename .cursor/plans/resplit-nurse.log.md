# Resplit Nurse Log

## 2026-04-03 14:39 EDT

- `NO-GO` overall launch; `GO/current` for `resplit-currency-api`.
- Shipped delta: docs-only checkpoint from fresh disposable lane `/Users/leokwan/Development/resplit-currency-api-worktrees/codex/vidux-20260403-143335-fx-fast-exit` on branch `codex/vidux-20260403-143335-fx-fast-exit`; no product/runtime code delta.
- Fresh proof:
  - `PATH=/opt/homebrew/bin:$PATH npm ci`
  - `PATH=/opt/homebrew/bin:$PATH npm run check` -> `72/72` tests green; publish artifacts regenerated for `2026-04-03` with clean git state.
  - `PATH=/opt/homebrew/bin:$PATH npm run smoke:deploy` -> `OK (date=2026-04-03, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Runbook probes with explicit user agent confirm parity: Cloudflare latest `date=2026-04-03`; history `points=30`; meta `latestDate=2026-04-03`; dated snapshot `https://2026-04-03.resplit-currency-api.pages.dev/snapshots/base-rates.json` `date=2026-04-03`; GitHub Pages fallback latest `date=2026-04-03`; worker quote `resolvedDate=2026-04-03` (`resolutionKind=exact`); worker coverage `historyCoverage.availableDays=30`, `missingDayCount=0`, `archiveGapCount=0`.
  - GitHub Actions REST probe is temporarily rate-limited on this host (`403`, `X-RateLimit-Remaining: 0`), so workflow-head state used smoke/live endpoint truth only this cycle.
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker unchanged — `resplit-ios` Task 9 manual/TestFlight verification on build `876`, plus unresolved claimed row `ADm7xviYCN62zYBS8O6FZ4c` in `/Users/leokwan/Development/resplit-ios/.cursor/plans/app-store-feedback.plan.md`.
  - unknown: `.agent-ledger/activity.jsonl` in this repo is still newline-only, and GitHub REST workflow checks can intermittently hard-stop on unauthenticated rate limits.
  - forgotten: preserved attached-root hygiene (all execution from fresh `origin/main` worktree, no hot-file collisions, no local dirt promoted as checkpoint).
- Exact next slice: keep `resplit-currency-api` on fast-exit unless workflow/runbook truth goes red; continue shipper pressure on `resplit-ios` build-`876` manual/TestFlight wall.
- Current build boundary: trunk `origin/main` `fd4fe8f5`; FX publish date `2026-04-03`; worker 30-day coverage green.
- Latency: `hygiene` `8m`, `discovery` `15m`, `implementation` `6m`, `proof/wait` `9m`.

<promise>SKIP: external blocker</promise>

## 2026-04-03 13:34 EDT

- `NO-GO` overall launch; `GO/current` for `resplit-currency-api`.
- Shipped delta: docs-only checkpoint from fresh disposable lane `/Users/leokwan/Development/resplit-currency-api-worktrees/codex/vidux-20260403-133336-fx-fast-exit` on branch `codex/vidux-20260403-133336-fx-fast-exit`; no product/runtime code delta.
- Fresh proof:
  - `PATH=/opt/homebrew/bin:$PATH npm ci`
  - `PATH=/opt/homebrew/bin:$PATH npm run check` -> `72/72` tests green; publish artifact regenerated for `2026-04-03` with clean git state.
  - `PATH=/opt/homebrew/bin:$PATH npm run smoke:deploy` -> `OK (date=2026-04-03, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Runbook probes with explicit user agent confirm live parity: Cloudflare latest `date=2026-04-03`; history `points=30`; archive manifest `earliestDate=2025-04-04`, `latestDate=2026-04-03`, `availableDates=363`, `gapCount=2`; dated snapshot `date=2026-04-03`; GitHub Pages fallback latest `date=2026-04-03`; worker quote `resolvedDate=2026-04-03` (`resolutionKind=exact`); worker coverage path `historyCoverage.availableDays=30`, `historyCoverage.missingDayCount=0`, `historyCoverage.archiveGapCount=0`.
  - GitHub Actions head via public API stayed green: `23931026119` (`pages build and deployment`) and `23930995489` (`Update Currency Rates`) both `completed/success`.
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker unchanged — `resplit-ios` Task 9 manual/TestFlight verification on build `876`, plus unresolved claimed row `ADm7xviYCN62zYBS8O6FZ4c` in `/Users/leokwan/Development/resplit-ios/.cursor/plans/app-store-feedback.plan.md`.
  - unknown: this repo still has no shared stop-hook breadcrumbs (`.agent-ledger/activity.jsonl` remains newline-only), and `gh` CLI remains unavailable on this host so workflow truth stayed on API fallback.
  - forgotten: protected attached-root hygiene stayed intact (all execution from fresh `origin/main` worktree, no hot-file collisions, no local drift promoted as checkpoint).
- Exact next slice: keep `resplit-currency-api` on fast-exit unless workflow/runbook truth goes red; continue shipper pressure on `resplit-ios` build-`876` manual/TestFlight wall.
- Current build boundary: trunk `origin/main` `d48d26f3`; FX publish date `2026-04-03`; worker 30-day coverage green.
- Latency: `hygiene` `9m`, `discovery` `17m`, `implementation` `5m`, `proof/wait` `8m`.

<promise>SKIP: external blocker</promise>
