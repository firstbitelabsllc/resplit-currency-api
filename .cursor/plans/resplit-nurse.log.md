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

## 2026-03-23 22:39 EDT

- Rehydrated repo state again and found the nurse contract gap was still real on trunk: no `RALPH.md`, no repo-local `ai/skills/hooks/SKILL.md`, and no repo-local `ai/skills/release-train/SKILL.md`.
- Added those repo-owned coordination files so future nurse/release-train runs can rehydrate from this repo instead of falling back to host-only context:
  - `RALPH.md`
  - `ai/skills/hooks/SKILL.md`
  - `ai/skills/release-train/SKILL.md`
- Fresh proof this run:
  - `npm run check`
  - `npm run smoke:deploy`
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 3`
  - live endpoint checks against Cloudflare Pages, GitHub Pages fallback, and `https://fx.resplit.app`
- While running local proof, the daily scheduled publish had already landed upstream as `a34db6af` (`chore: archive daily snapshot 2026-03-24`). I removed the redundant local generated snapshot, fast-forwarded `main`, and kept trunk aligned with repo truth.
- Current repo status remains `GO`.
- Remaining blocker for overall launch remains external to this repo: unresolved `resplit-ios` / App Store feedback work.
- Exact next slice in this repo: only revisit if a future publish run goes red or if the non-blocking Worker secret warnings (`SENTRY_DSN`, `CRON_SECRET`) are promoted into a launch requirement.

## 2026-03-24 01:37 EDT

- Rehydrated from repo-owned state in the nurse order and confirmed there is still no competing hot lane or repo-local red in `resplit-currency-api`.
- Fresh proof this run:
  - `npm run check`
  - `npm run smoke:deploy`
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5 --json ...`
  - live endpoint checks for:
    - `https://resplit-currency-api.pages.dev/latest/aed.json`
    - `https://resplit-currency-api.pages.dev/history/30d/aed.json`
    - `https://resplit-currency-api.pages.dev/archive-manifest.json`
    - `https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json`
    - `https://fx.resplit.app/quote?from=AED&to=USD&date=2026-03-24`
    - `https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30`
    - `https://2026-03-24.resplit-currency-api.pages.dev/snapshots/base-rates.json` via Node `fetch` (HTTP 200, date `2026-03-24`)
- Latest upstream publish proof remains green on trunk:
  - scheduled `Update Currency Rates` run `23469629324` succeeded on `main`
  - downstream `pages build and deployment` run `23469664623` succeeded on `gh-pages`
- Working tree stayed clean throughout this pass; `main` remains aligned with `origin/main` at `d5144a3d` (`docs: add repo nurse contract`).
- Current repo status remains `GO`.
- Remaining blocker for overall Resplit 2.0 launch is still external to this repo: unresolved `resplit-ios` / App Store feedback work.
- Exact next slice in this repo: fast-exit unless a future scheduled/manual publish run goes red or the Worker secret warnings (`SENTRY_DSN`, `CRON_SECRET`) are promoted from observability debt into a launch requirement.

## 2026-03-24 04:37 EDT

- Rehydrated from `RALPH.md`, the repo nurse log, the repo ledger, and current trunk state; no competing hot lane or repo-local failure surfaced in `resplit-currency-api`.
- Fresh proof this run:
  - `npm run check`
  - `npm run smoke:deploy`
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5 --json databaseId,displayTitle,event,headBranch,headSha,status,conclusion,workflowName,createdAt,updatedAt`
  - live endpoint checks for:
    - `https://resplit-currency-api.pages.dev/latest/aed.json`
    - `https://resplit-currency-api.pages.dev/history/30d/aed.json`
    - `https://resplit-currency-api.pages.dev/archive-manifest.json`
    - `https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json`
    - `https://fx.resplit.app/quote?from=AED&to=USD&date=2026-03-24`
    - `https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30`
    - `https://2026-03-24.resplit-currency-api.pages.dev/snapshots/base-rates.json`
- Latest upstream publish proof is still green:
  - scheduled `Update Currency Rates` run `23469629324` succeeded on `main`
  - downstream `pages build and deployment` run `23469664623` succeeded on `gh-pages`
- No code, workflow, deploy, or snapshot repair was needed this run; working tree remained clean on `main` at `8e33bf84` (`docs: checkpoint nurse proof 2026-03-24`).
- Current repo status remains `GO`.
- Remaining blocker for overall Resplit 2.0 launch is still external to this repo: unresolved `resplit-ios` / App Store feedback work.
- Exact next slice in this repo: fast-exit unless a future scheduled/manual publish run goes red or the Worker secret warnings (`SENTRY_DSN`, `CRON_SECRET`) are promoted from observability debt into a launch requirement.

## 2026-03-24 07:38 EDT

- Rehydrated from the repo-owned nurse surfaces again and found no new red lane, drift, or competing owner in `resplit-currency-api`.
- Fresh proof this run:
  - `npm run check`
  - `git status --short --branch`
  - `npm run smoke:deploy`
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5 --json databaseId,displayTitle,event,headBranch,headSha,status,conclusion,workflowName,createdAt,updatedAt`
  - live endpoint checks for:
    - `https://resplit-currency-api.pages.dev/latest/aed.json`
    - `https://resplit-currency-api.pages.dev/history/30d/aed.json`
    - `https://resplit-currency-api.pages.dev/archive-manifest.json`
    - `https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json`
    - `https://fx.resplit.app/quote?from=AED&to=USD&date=2026-03-24`
    - `https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30`
    - `https://2026-03-24.resplit-currency-api.pages.dev/snapshots/base-rates.json`
- Live proof details:
  - Cloudflare Pages latest `aed` payload date: `2026-03-24`
  - Cloudflare Pages 30-day history window: `30` points spanning `2026-02-23` through `2026-03-24`
  - Archive manifest shape is still healthy on trunk: earliest `2025-03-18`, latest `2026-03-24`, `370` available dates, `2` acknowledged gaps
  - GitHub Pages fallback latest `aed` payload date: `2026-03-24`
  - Canonical Worker quote `AED -> USD` for `2026-03-24`: `0.27228722`
  - Canonical Worker coverage for the same pair/date reports `30/30` days available with `0` missing days
  - Dated Cloudflare snapshot branch for `2026-03-24` serves `base=eur` with `166` rates
- Latest upstream publish proof is still green:
  - scheduled `Update Currency Rates` run `23469629324` succeeded on `main`
  - downstream `pages build and deployment` run `23469664623` succeeded on `gh-pages`
- No repo-local fix was required this pass. Trunk stayed clean before this breadcrumb update at `fee5091b` (`docs: checkpoint nurse proof 2026-03-24-0437`).
- Current repo status remains `GO`.
- Remaining blocker for overall Resplit 2.0 launch is still external to this repo: unresolved `resplit-ios` / App Store feedback work.
- Exact next slice in this repo: fast-exit unless a future scheduled/manual publish run goes red, dated snapshot coverage regresses, or the Worker secret warnings (`SENTRY_DSN`, `CRON_SECRET`) are promoted from observability debt into a launch requirement.
