# Resplit Nurse Log

## 2026-06-10 03:28 EDT

- `NO-GO` overall launch until AKig has merged/deployed FX key-value OCR proof, the opt-in Worker env is enabled, and a real TestFlight scan observes discount/credit extras. `PR-proven` for the FX Worker code path on branch `codex/ocr-kv-layout-20260610`.
- Shipped delta: added model-specific Azure submit/poll helpers for `prebuilt-receipt` and `prebuilt-layout`; added opt-in `AZURE_OCR_KV_EXTRAS` routing that runs the layout key-value analyze only when enabled and merges `analyzeResult.keyValuePairs` into the raw receipt envelope; added OCR router coverage proving the default path still bills one receipt analyze and the opt-in path performs one receipt analyze plus one layout key-value analyze.
- Fresh proof:
  - `node --test tests/ocr-router.test.js` -> `7/7` OCR router tests green after dependency install.
  - `npm run test` -> `230/230` tests green after `npm run generate` created the clean-worktree package artifacts needed by package validation tests.
  - `npm run check` -> generated `2026-06-10`, `validate:release` OK, `230/230` tests green.
  - `git diff --check` -> clean.
  - `npm run smoke:deploy` -> `OK (date=2026-06-10, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Live production health remains on deployed release `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`; `/ocr/challenge` returns a challenge. The key-value extras branch is not live yet.
- Known / unknown / forgotten work surfaced:
  - known: the change is guarded behind `AZURE_OCR_KV_EXTRAS`; leaving it unset preserves the deployed single-analyze OCR path and avoids accidental double Azure billing.
  - unknown: whether production Azure config plus real receipt images return useful layout key-value pairs for restaurant discounts/credits; local tests prove merge behavior with stubbed Azure only.
  - forgotten: AKig spans two repos now. iOS PR `#820` maps key-value extras into `ScannedReceipt.extras`; this Worker PR is the missing server-side source of those key-value pairs.
- Exact next slice: push and open the ready PR, merge/deploy it to `main`, set `AZURE_OCR_KV_EXTRAS=enabled` only after merge/deploy is ready to observe, then run a live `/ocr/scan`/TestFlight receipt scan that proves merged `keyValuePairs` reach iOS.
- Current build boundary: branch `codex/ocr-kv-layout-20260610` from `origin/main` `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`; FX publish date `2026-06-10`; Worker production release still `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`.
- Latency: `hygiene` `5m`, `discovery` `6m`, `implementation` `20m`, `proof/wait` `10m`.

<promise>KEEP-GOING: PR merge/deploy/env/live scan</promise>

## 2026-06-09 20:18 EDT

- `NO-GO` overall launch until a real iOS scan on TestFlight `2.2.0 (2705)` is observed post-fix; `GO/deployed` for the FX OCR Worker route.
- Shipped delta: mounted `/ocr/*` in `worker/src/index.mjs`; added the OCR router/App Attest/Azure DI proxy modules; added route/auth/monitoring coverage; added `ATTEST_KV` binding and server-side `AZURE_OCR_ENDPOINT` Worker var. The Azure key remains a Worker secret and is not in source.
- Fresh proof:
  - `node --test tests/ocr-router.test.js tests/ocr-attest.test.js tests/ocr-monitoring.test.js` -> `12/12` OCR tests green.
  - `npm run check` -> generated `2026-06-10`, `validate:release` OK, `228/228` tests green.
  - `npx wrangler deploy --config wrangler.jsonc --env="" --dry-run` -> bundle OK; bindings include `ATTEST_KV`, `SIDELOAD_R2`, `ASSET_BASE_URL`, `SENTRY_ENVIRONMENT`, `AZURE_OCR_ENDPOINT`.
  - Live production before deploy: `POST https://fx.resplit.app/ocr/scan` returned route-level `404` (`{"error":"NOT_FOUND","message":"Route not found"}`), matching iOS Sentry issue `RESPLIT-IOS-A0` on TestFlight `2.2.0 (2705)`.
  - `gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api --ref main` -> `https://github.com/firstbitelabsllc/resplit-currency-api/actions/runs/27244503863`, completed `success` on `021e913fc7ed1aa82e68538747b73e9515697593`; deploy steps included Cloudflare Pages, FX Worker, GitHub Pages, and smoke.
  - Live production after deploy: `/health` returns release `021e913fc7ed1aa82e68538747b73e9515697593`; `/ocr/challenge` returns `200`; empty-image `POST /ocr/scan` with soft-fail header returns `400 BAD_REQUEST` (`empty image body`), proving the route is mounted and no longer route-level `404`.
  - `npm run smoke:deploy` -> `OK (date=2026-06-10, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
- Known / unknown / forgotten work surfaced:
  - known: iOS build `2705` is uploaded/distributed and now depends on this Worker route; no new iOS build is required for the route-level fix if production deploy mounts `/ocr/scan`.
  - unknown: whether Cloudflare production has a valid `AZURE_OCR_KEY` and provider path; local `wrangler secret list`/direct deploy were blocked by Cloudflare auth code `10000`, while GitHub Actions secret sync/deploy succeeded. Empty-image proof verifies routing without billing Azure; a real TestFlight scan still needs provider proof.
  - forgotten: this repo had stale nurse/ledger entries; all source/deploy proof for this launch-critical slice should now be recorded here before handing back to the iOS plan.
- Exact next slice: update the iOS launch plan/ledger with TestFlight `2705` + FX OCR deploy proof, then observe a real iOS scan or Sentry quiet period for `RESPLIT-IOS-A0` after release `021e913`.
- Current build boundary: trunk `origin/main` `021e913`; FX publish date `2026-06-10`; Worker `resplit-fx` release `021e913fc7ed1aa82e68538747b73e9515697593`.
- Latency: `hygiene` `10m`, `discovery` `8m`, `implementation` `15m`, `proof/wait` `12m`.

<promise>KEEP-GOING: observe iOS scan</promise>

## 2026-04-10 23:25 EDT

- `NO-GO` overall launch (resplit-ios trunk dirty with active claude thread mid-fix on `PendingScanRecord` SwiftData @Model bricked-app failure); `GO/current` for `resplit-currency-api`.
- Shipped delta: nurse log refresh only — no product/runtime code delta this cycle. Repo remained quiet for 7 days since the 2026-04-03 entry. Test count grew from `72 → 74` (two additive tests landed between 2026-04-03 and 2026-04-10, surfaced via `npm run check`).
- Fresh proof:
  - `npm run check` -> `74/74` tests green (was `72/72` in last entry).
  - `npm run smoke:deploy` -> `OK (date=2026-04-11, historyPoints=30, cf=https://resplit-currency-api.pages.dev)` — FX worker has rolled forward to the `2026-04-11` publish date already (correct for late evening Eastern, since the daily publish runs on UTC and we're past 03:00 UTC).
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker is now resplit-ios `PendingScanRecord` SwiftData `@Model` bricked-app failure (TestFlight build 1795 was rejected, fastlane has been failing for 24+ hours, commits-pending climbed to 574 in the deploy ledger). An active claude thread is mid-fix; the sidecar fleet (bug-fixer, launch-loop, ios-ux, currency) is in coordinated standby per the standing directive.
  - unknown: the 2 new tests added between the 2026-04-03 entry and now — worth a quick `git log -- tests/` audit if a deeper slice runs later. Recent commits show `08091af vidux: harden fx publish freshness window` and `6898cdf feat: surface FX freshness diagnostics` — likely the source of the new test coverage.
  - forgotten: still no active hot-file owner in this repo and ledger queries still return newline-only — `.agent-ledger/activity.jsonl` for this repo remains unstreamed.
- Exact next slice: keep `resplit-currency-api` on fast-exit unless (a) FX freshness drifts past the publish window, OR (b) a launch-critical FX bug surfaces in resplit-ios manual expense / multi-currency split paths, OR (c) the resplit-ios trunk wall clears and the launch train resumes.
- Current build boundary: trunk `origin/main` `9ff5e74` (was `afdaf5ca`); FX publish date `2026-04-11`; worker 30-day coverage green.
- Latency: `hygiene` `1m`, `discovery` `2m`, `implementation` `0m` (read-only verify), `proof/wait` `2m`.

<promise>SKIP: external blocker</promise>

## 2026-04-03 18:43 EDT

- `NO-GO` overall launch; `GO/current` for `resplit-currency-api`.
- Shipped delta: docs-only checkpoint from fresh disposable lane `/Users/leokwan/Development/resplit-currency-api-worktrees/codex/vidux-20260403-183332-fx-fast-exit` on branch `codex/vidux-20260403-183332-fx-fast-exit`; no product/runtime code delta.
- Fresh proof:
  - `PATH=/opt/homebrew/bin:$PATH npm ci`
  - `PATH=/opt/homebrew/bin:$PATH npm run check` -> `72/72` tests green; publish artifacts regenerated for `2026-04-03` with clean git state.
  - `PATH=/opt/homebrew/bin:$PATH npm run smoke:deploy` -> `OK (date=2026-04-03, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Runbook probes with explicit user agent confirm live parity on `2026-04-03`: Cloudflare latest `date=2026-04-03`; history `points=30`; archive manifest `latestDate=2026-04-03`; GitHub Pages fallback latest `date=2026-04-03`; worker quote `resolutionKind=exact` + `resolvedDate=2026-04-03`; worker coverage `historyCoverage.availableDays=30`, `missingDayCount=0`, `archiveGapCount=0`.
  - GitHub Actions CLI probe confirms latest runs `23931026119` (`pages build and deployment`) and `23930995489` (`Update Currency Rates`) are `completed/success`.
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker unchanged — `resplit-ios` Task 9 manual/TestFlight verification on build `876`, plus unresolved claimed row `ADm7xviYCN62zYBS8O6FZ4c` in `/Users/leokwan/Development/resplit-ios/.cursor/plans/app-store-feedback.plan.md`.
  - unknown: `.agent-ledger/activity.jsonl` in this repo remains newline-only and `ledger --gc --report` is unavailable (`ledger command not found`).
  - forgotten: confirmed no active hot-file owner in this repo and preserved attached-root hygiene (all execution from fresh `origin/main` worktree, no local dirt promoted as checkpoint).
- Exact next slice: keep `resplit-currency-api` on fast-exit unless workflow/runbook truth goes red; continue shipper pressure on `resplit-ios` build-`876` manual/TestFlight wall.
- Current build boundary: trunk `origin/main` `afdaf5ca`; FX publish date `2026-04-03`; worker 30-day coverage green.
- Latency: `hygiene` `8m`, `discovery` `17m`, `implementation` `5m`, `proof/wait` `10m`.

<promise>SKIP: external blocker</promise>
