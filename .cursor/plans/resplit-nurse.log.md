# Resplit Nurse Log

## 2026-04-02 20:06 EDT

- Launch stays `NO-GO` overall, but `resplit-currency-api` is `GO/current` again after this run repaired the UTC rollover publish gap from a fresh clean worktree.
- Shipped delta: clean disposable lane `/private/tmp/codex-vidux-20260402-200212-fx-proof` on branch `codex/vidux-20260402-200212-fx-proof` re-proved trunk, detected that local `npm run check` could already generate `2026-04-03` while live Pages, GitHub Pages, and `https://fx.resplit.app` were still on `2026-04-02`, then dispatched `gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api`. That workflow landed `9f47cd52` (`chore: archive daily snapshot 2026-04-03`) on `origin/main`, downstream Pages deploy `23927685528` finished green, and this checkpoint is the only follow-up repo edit.
- Fresh proof:
  - `npm ci`
  - `npm run check` -> `72/72` tests green; local archive rotated cleanly to `2026-04-03`
  - `npm run smoke:deploy` -> `OK (date=2026-04-02, historyPoints=30, cf=https://resplit-currency-api.pages.dev)` before the rerun, proving the prior-day train was otherwise healthy
  - `gh run watch 23927654991 --repo firstbitelabsllc/resplit-currency-api --exit-status` -> `success`
  - `gh run watch 23927685528 --repo firstbitelabsllc/resplit-currency-api --exit-status` -> `success`
  - post-publish live probes now agree on `2026-04-03`: `https://resplit-currency-api.pages.dev/latest/aed.json`, `https://2026-04-03.resplit-currency-api.pages.dev/snapshots/base-rates.json`, and `https://firstbitelabsllc.github.io/resplit-currency-api/latest/aed.json` all serve current data; `https://fx.resplit.app/quote?from=AED&to=USD&date=2026-04-03` resolves `exact`; `https://fx.resplit.app/coverage?from=AED&to=USD&anchorDate=2026-04-03&days=30` also reports exact current-day coverage
- Unknown / forgotten work surfaced:
  - forgotten process gap: a new UTC day can be locally generatable before GitHub cron fires; when no active run exists, the safe recovery is a manual `gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api` plus full end-to-end re-proof, not a fast-exit
  - non-blocking debt: downstream `pages-build-deployment` still emits Node 20 deprecation annotations for `actions/checkout@v4`, `actions/upload-artifact@v4`, and `actions/deploy-pages@v4`; queue a workflow-action bump before GitHub forces Node 24 on June 2, 2026
- Blocker: external only — `resplit-ios` Task 9 manual/TestFlight verification on build `876`
- Exact next slice: keep `resplit-currency-api` on fast-exit unless the UTC-day publish train lags again or workflow/live health turns red; otherwise keep shipper pressure on `resplit-ios`
- Current build boundary: FX publish date `2026-04-03`; latest green workflow `23927654991`; downstream Pages deploy `23927685528`; trunk snapshot commit `9f47cd52`
- Latency: `hygiene` `1m`, `discovery` `7m`, `implementation` `1m`, `proof/wait` `4m`

<promise>COMPLETE</promise>

## 2026-04-02 17:05 EDT

- Launch stays `NO-GO` overall, but `resplit-currency-api` is still `GO/current` and no repo-owned product code shipped.
- Shipped delta: repo checkpoint only. Fresh disposable worktree `/private/tmp/resplit-currency-api-20260402-170255-fx-proof` on branch `codex/vidux-20260402-170255-fx-proof` re-proved current `origin/main` at `40f36f44` (`docs: stabilize fx checkpoint wording`) and refreshed this one-screen log from the new trunk boundary instead of the stale attached detached checkout at `89554aed`.
- Fresh proof:
  - `npm ci`
  - `npm run check` -> `72/72` tests green, generated package clean, `snapshot-archive/` stayed clean
  - `npm run smoke:deploy` -> `OK (date=2026-04-02, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5` -> scheduled `Update Currency Rates` run `23880635613` `success`, downstream Pages build `23880665138` `success`
  - raw `python urllib` probes still return `403` for Pages + Worker in this room, but repo-authoritative truth remains green because `npm run smoke:deploy` and workflow status both prove the publish boundary is healthy while GitHub Pages fallback serves `2026-04-02` directly
- Unknown / forgotten work surfaced:
  - no repo product delta survived this run
  - process reminder: the attached detached checkout is behind current trunk, so this repo must keep using fresh `origin/main` worktrees plus `RUNBOOK.md`, `.github/workflows/run.yml`, and this log as queue truth
  - shell reminder: keep treating `npm run smoke:deploy` as the canonical live-health oracle when ad-hoc endpoint reads disagree in this room
- Blocker: external only — `resplit-ios` Task 9 manual/TestFlight verification on build `876`
- Exact next slice: keep FX on fast-exit unless workflow/runbook truth turns red; otherwise return shipper pressure to `resplit-ios`
- Current build boundary: FX publish date `2026-04-02`; latest green workflow `23880635613`; current clean-trunk checkpoint `40f36f44`
- Latency: `hygiene` `2m`, `discovery` `8m`, `implementation` `1m`, `proof/wait` `7m`

<promise>SKIP: external blocker</promise>
