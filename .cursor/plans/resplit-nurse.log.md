# Resplit Nurse Log

## 2026-05-25 06:23 EDT

- `NO-GO` overall launch; `YELLOW/current` for the local-CI/agent/OTEL control plane because repo-backed FirstBite can now see the current FX trust lane, but the loaded in-app MCP host and external Cloudflare/Grafana proof are still not green.
- Shipped delta pending source promotion: added `resplit_currency_api_trust_preflight` to `.firstbite/local-ci.json`; `npm run trust:preflight` now runs the Cloudflare destination proof before Grafana proof; `scripts/reliability-cockpit.js` passes the selected `--repo` path through `RESPLIT_CURRENCY_API_REPO` when probing the repo-backed FirstBite package so worktree evidence is not confused with the default checkout.
- Fresh proof:
  - `node --check scripts/reliability-cockpit.js && node --check scripts/trust-preflight.js && node --test tests/reliability-cockpit.test.js tests/trust-preflight.test.js tests/verify-cloudflare-otel-destinations.test.js` -> `57/57` focused tests green.
  - `npm run trust:preflight` -> expected red overall; commands `8 green, 3 yellow, 0 red`; Cloudflare destination proof yellow for missing `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`; Grafana proof yellow for missing read config; source-promotion generate yellow while cockpit remains red.
  - `npm run check` -> strict release validation green and `221/221` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Repo-backed FirstBite package probe -> green: `repo-manifest-v2`, `16` total lanes, `resplit_currency_api` has `4/4` expected lanes including `resplit_currency_api_trust_preflight`; `fresh_clone_ready=true`, `active_ready=false`.
  - Live loaded `mcp__firstbite_local_ci.list_lanes` still does not expose `resplit_currency_api`; it lists only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`, so the loaded MCP host boundary remains untrusted until restart/reload plus a captured probe artifact.
- Exact next slice: land this PR bundle, reload the in-app FirstBite MCP host and capture `reports/firstbite-loaded-mcp-lanes.json`, then run clean worktree `resplit_currency_api_all` and external Cloudflare/Grafana read-token proofs.

## 2026-05-25 06:12 EDT

- `NO-GO` overall launch; `YELLOW/current` for the Cloudflare/Grafana observability lane because wrangler destination intent is source-declared, but Cloudflare dashboard destination existence and Grafana Tempo/Loki delivery remain separate unproven gates.
- Shipped delta pending source promotion: added `npm run observability:cloudflare-destinations`, a read-only Cloudflare Workers Observability destination verifier, and cockpit/UI trust rows for `Cloudflare OTEL destinations` before `OTEL/Grafana evidence`.
- Fresh proof:
  - `node --check scripts/verify-cloudflare-otel-destinations.js` -> pass.
  - `node --check scripts/reliability-cockpit.js` -> pass.
  - `node --test tests/verify-cloudflare-otel-destinations.test.js tests/reliability-cockpit.test.js tests/verify-grafana-otel-smoke.test.js` -> `56/56` focused tests green.
  - `npm run observability:cloudflare-destinations -- --output reports/cloudflare-otel-destinations.json` -> expected yellow: missing `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`; report redacts destination headers by construction.
  - `npm run reliability:cockpit` -> cockpit remains red overall; `Cloudflare OTEL destinations` is fresh/yellow and blocks `grafana-otel-proof`.
  - `npm run check` -> `220/220` tests green with strict release validation passing (`166 currencies`, `history points=30`).
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run source:promotion-packet` -> expected red while cockpit is red; exact stage candidates are `package.json`, `scripts/reliability-cockpit.js`, `tests/reliability-cockpit.test.js`, `scripts/verify-cloudflare-otel-destinations.js`, `tests/verify-cloudflare-otel-destinations.test.js`; generated `reports/` remain hold-by-default.
- Current build boundary: PR branch `codex/fx-otel-grafana-config-20260525`; source diff is local until committed/pushed; do not claim launch-trusted telemetry until a Workers Observability Read-token run proves dashboard destinations and a Grafana read-token smoke proves Tempo+Loki.

## 2026-05-25 05:56 EDT

- `NO-GO` overall launch; `YELLOW/current` for `resplit-currency-api` observability because Worker OTEL config is now source-declared locally, but Grafana Tempo+Loki have not both matched live telemetry.
- Shipped delta pending source promotion: `wrangler.jsonc` declares first-party Cloudflare Workers Observability export to `grafana-logs-prod` and `grafana-traces-prod` with 10% head sampling and `persist: false`; `scripts/reliability-cockpit.js` now accepts first-party per-stream OTEL blocks and renders the persistence boundary; `INBOX.md` replaces the stale Worker-side SDK row with the current Cloudflare destination trust gate.
- Fresh proof:
  - `npm ci` -> installed Wrangler 4.75.0 locally for schema/dry-run validation.
  - `node --test tests/reliability-cockpit.test.js tests/verify-grafana-otel-smoke.test.js` -> `49/49` focused tests green.
  - `npx wrangler deploy --config wrangler.jsonc --env="" --dry-run --outdir /tmp/resplit-fx-wrangler-dry-run-20260525` -> Wrangler accepted the config and exited at dry run.
  - `npm run check` -> `213/213` tests green.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run observability:otel-smoke -- --skip-trigger --output reports/grafana-otel-smoke.json` -> expected yellow: Grafana read env missing, Tempo/Loki unmatched.
  - `npm run reliability:cockpit` -> cockpit telemetry moved from red/missing config to yellow/config-present, with evidence file `reports/grafana-otel-smoke.json`.
- Known / unknown / forgotten work surfaced:
  - known: config alone is not launch proof; only a fresh Grafana smoke where Worker trigger, Grafana read config, Tempo query, and Loki query are all green can satisfy the OTEL gate.
  - known: loaded in-process FirstBite MCP host catalog is still stale/missing for this generated cockpit; repo-backed MCP remains the source of truth until the host reloads.
  - unknown: whether Cloudflare dashboard destinations named `grafana-logs-prod` and `grafana-traces-prod` already exist in the target account; merge/deploy will not prove delivery without that dashboard state plus Grafana read env.
- Exact next slice: review and promote this source bundle, then after deploy run `npm run observability:otel-smoke -- --since-minutes 60` with Grafana read env until `reports/grafana-otel-smoke.json` shows both Tempo and Loki matched.
- Current build boundary: trunk `origin/main` `3c5a9fd`; local branch/worktree has unpromoted OTEL config/cockpit diffs; broader launch trust remains red because external observability proof and loaded MCP host refresh are not green.
- Latency: `hygiene` `10m`, `implementation` `12m`, `proof/wait` `8m`.

<promise>SKIP: external blocker</promise>

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
