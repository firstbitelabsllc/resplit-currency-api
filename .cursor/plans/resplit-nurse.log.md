# Resplit Nurse Log

## 2026-05-25 12:32 EDT

- `NO-GO` overall launch; `RED/current` still holds. The completion audit now treats the Proof Acceptance Matrix as a hard launch gate, so a green Launch Trust Audit or trust-contract shell cannot launder adjacent, stale, or missing proof into a launch-ready claim.
- Shipped delta pending source promotion: `scripts/reliability-completion-audit.js` now requires `trustModel.proofAcceptanceMatrix.status === "green"`, verifies every expected proof row is present, emits `proofBlockers`, and prints `proof:<id>` next actions in the CLI. `tests/reliability-completion-audit.test.js` now covers green proof boundaries, missing proof rows, shared loaded-MCP/Grafana blockers, and the specific failure mode where only the proof matrix is red.
- Fresh proof:
  - `node --test tests/reliability-completion-audit.test.js` -> `7/7` completion-audit tests passed.
  - `node --test tests/reliability-cockpit.test.js tests/verify-reliability-cockpit-report.test.js tests/reliability-completion-audit.test.js` -> `80/80` cockpit/verifier/completion tests passed.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.{json,html}`.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green with `11` gate(s), `5` action(s), and generated Proof Acceptance Matrix HTML/JSON present.
  - `npm run reliability:completion-audit` -> expected red exit `2`: `8` non-green/missing launch boundary(s), `8` non-green/missing proof boundary(s), and `12` non-green trust contract(s). The CLI now shows both launch blockers and matching `proof:*` blockers for loaded MCP, clean FirstBite, Cloudflare, Grafana, peer execution, and ledger fleet proof.
  - `npm run check` -> generate green, strict release validation green, and `257/257` tests passed.
- Boundary: this does not restart/reload Codex/Cursor, prove the live loaded MCP tool is current, land the source bundle to `origin/main`, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It makes the completion gate refuse launch readiness until the proof matrix agrees with the claim boundaries.
- Exact next slice: reload the long-lived Codex/Cursor FirstBite MCP host, recapture live loaded `list_lanes`, then work the matrix rows top-down for clean landed-source FirstBite, M4 peer execution, Cloudflare destination, and Grafana Tempo/Loki proof.

## 2026-05-25 12:22 EDT

- `NO-GO` overall launch; `RED/current` still holds. The cockpit now has an explicit Proof Acceptance Matrix so local operators can see which proof boundaries are accepted versus diagnostic-only, instead of inferring trust from adjacent green rows.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` derives `trustModel.proofAcceptanceMatrix` from the Launch Trust Audit and Operator Action Queue, renders a `Proof Acceptance Matrix` HTML section, and records each row's accepted proof, rejected proof, current gap, next valid proof, and owning action. `scripts/verify-reliability-cockpit-report.js` now fails if that matrix disappears or if the clean FirstBite, loaded-agent MCP, or OTEL/Grafana proof rows are missing.
- Fresh proof:
  - `node --test tests/reliability-cockpit.test.js tests/verify-reliability-cockpit-report.test.js` -> `73/73` focused cockpit/verifier tests passed.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.{json,html}` with Proof Acceptance Matrix status `red`: `4` accepted, `8` blocked.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green with `Proof Acceptance Matrix` present in HTML and JSON.
  - Matrix sample: `clean-firstbite-local-ci` red/blocked until fresh `worktree=true` FirstBite execute proof; `loaded-agent-mcp` red/blocked until fresh loaded-host `list_lanes` with `repo-manifest-v2` and all FX lanes; `otel-grafana-proof` yellow/blocked until Worker trigger, Grafana config, Tempo query, and Loki query are all green.
  - `npm run check` -> generate green, strict release validation green, and `255/255` tests passed.
- Boundary: this does not restart/reload Codex/Cursor, prove the live loaded MCP tool is current, land the `ai-leo` producer stack, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It makes those non-green boundaries impossible to promote accidentally inside the operator cockpit.
- Exact next slice: reload the long-lived Codex/Cursor FirstBite MCP host, recapture live loaded `list_lanes`, then work the matrix rows top-down for clean landed-source FirstBite, M4 peer execution, Cloudflare destination, and Grafana Tempo/Loki proof.

## 2026-05-25 12:00 EDT

- `NO-GO` overall launch; `RED/current` still holds. The stale refresh-packet producer has a durable repair on `ai-leo` draft stack PR #13, and the FX cockpit no longer sees lane-count continuation proof drift after regenerating the packet.
- Shipped delta pending source promotion: `ai-leo` commit `74208f5` on `codex/local-ci-refresh-count-20260525` changes `skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh` to derive refresh packet lane-count expectations from the repo-backed catalog instead of hard-coding `15`. The PR is intentionally stacked on `codex/local-ci-handoff-hardening-20260525` because the packet producer script is not on `origin/main` yet.
- Fresh proof:
  - `bash -n skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh` in the clean `ai-leo` worktree -> green.
  - `git diff --check -- skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh` in the clean `ai-leo` worktree -> green.
  - `FIRSTBITE_MCP_REFRESH_PLAN_RUN_ID=codex-fx-refresh-plan-derived-count-clean-20260525 RESPLIT_CURRENCY_API_REPO=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525 bash /Users/leokwan/Development/ai-leo-worktrees/local-ci-refresh-count-20260525/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh --json` -> repo-backed catalog `repo-manifest-v2`, `16/16` declared lanes, continuation expected-proof text now says `lane_count=16`, and host-app refresh proof now says `16` lanes.
  - The same packet still reports the real blocker: `16/21` loaded MCP server processes are stale, so a Codex/Cursor host restart/reload plus recapture is still required before trusting the loaded in-app MCP tool.
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green; `continuationProofDrift=[]`, MCP refresh plan remains yellow on stale loaded clients, and next action is host-app reload/recapture rather than packet-producer repair.
- Boundary: this does not restart/reload Codex/Cursor, prove the live loaded MCP tool is current, land the `ai-leo` producer stack, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It only closes the stale continuation-proof producer defect and records the remaining host boundary honestly.
- Exact next slice: reload the long-lived Codex/Cursor FirstBite MCP host, recapture live loaded `list_lanes`, then continue PR #10 toward clean landed-source local-CI, M4 peer, Cloudflare destination, and Grafana Tempo/Loki proof.

## 2026-05-25 11:50 EDT

- `NO-GO` overall launch; `RED/current` still holds. The cockpit now catches stale FirstBite refresh-plan continuation instructions instead of trusting a packet that says the old lane count while the repo-backed catalog proves the new one.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` detects `continuationProofDrift` when a refresh packet's `expectedProof` says a lane count different from `repoBackedCatalog.lane_count`, renders that mismatch in the MCP Refresh Plan section, and keeps the refresh plan yellow with a repair/regenerate next action. This surfaced the current local-CI packet drift: continuation commands still say `15` lanes, but the current repo-backed catalog is `16/16` declared lanes including `resplit_currency_api_trust_preflight`.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the current Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`.
  - `FIRSTBITE_MCP_REFRESH_PLAN_RUN_ID=codex-fx-refresh-plan-post-d535c57-20260525 RESPLIT_CURRENCY_API_REPO=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525 bash /Users/leokwan/Development/ai-leo/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh --json` -> repo-backed catalog `repo-manifest-v2`, `16/16` declared lane(s), but continuation expected-proof text still says `15` lanes; process audit still reports `16/21` stale MCP processes.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `67/67` focused cockpit tests green.
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green; MCP refresh plan summary now includes `continuation proof drift: Prove repo-backed MCP catalog expects 15 lane(s), catalog has 16; Refresh host-app MCP clients expects 15 lane(s), catalog has 16`.
  - `npm run check` -> strict release validation green and `253/253` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `10`, command drift `2`; generated `reports/` remain hold-by-default.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not repair the ai-leo refresh packet producer, restart/reload Codex/Cursor, prove loaded-agent execution, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It prevents the FX cockpit from hiding a stale lane-count expectation in the local-CI handoff packet.
- Exact next slice: repair the ai-leo FirstBite MCP refresh-plan producer so it derives expected lane count from the repo-backed catalog, regenerate the packet until `continuationProofDrift=[]`, then restart/reload the MCP host and capture a fresh live loaded-host `list_lanes` artifact.

## 2026-05-25 11:40 EDT

- `NO-GO` overall launch; `RED/current` still holds. The source-promotion action now distinguishes "tracked on this PR head" from "promoted to origin/main" so operators do not loop on a no-op local review after a PR-head source landing.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` classifies a red source bundle with zero current/head candidates but missing `origin/main` files or package-script drift as an origin promotion hold. `source-promotion-review` becomes `canRunNow=false`, `boundary=source-promotion`, and blocks on merge/promotion plus a post-merge packet instead of inviting another local packet review.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the current Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `66/66` focused cockpit tests green.
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green; before commit, `source-promotion-review` is still correctly runnable because `2` tracked source files are modified locally.
  - `npm run check` -> strict release validation green and `252/252` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `9`, command drift `2`; generated `reports/` remain hold-by-default.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not merge the PR, promote the source bundle to `origin/main`, reload the Codex/Cursor MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery.
- Exact next slice: commit/push this source-promotion hold, rerun the cockpit from a clean PR head, confirm `source-promotion-review` becomes held on `origin/main` instead of runnable, then reload the MCP host and run the external Cloudflare/Grafana and M4 proofs.

## 2026-05-25 11:30 EDT

- `NO-GO` overall launch; `RED/current` still holds, but loaded-MCP evidence freshness is now freshly captured and no longer masks the real host-reload blocker.
- Shipped delta pending source promotion: `tests/reliability-cockpit.test.js` now covers the post-recapture state where the loaded MCP probe is fresh/green for evidence freshness but still red for catalog trust. The operator queue must not re-add `loaded-mcp-recapture`; it must keep only `loaded-mcp-refresh` blocked on Codex/Cursor host reload.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the current Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`.
  - `node scripts/capture-loaded-mcp-probe.js --repo /Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525` with the live tool output -> `reports/firstbite-loaded-mcp-lanes.json`; freshness green (`0m old`), catalog red (`repo missing`, `4/4` expected FX lanes missing).
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present; loaded-MCP actions now contain only `loaded-mcp-refresh` with `canRunNow=false`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run check` -> strict release validation green and `250/250` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `1`, hold-by-default `10`, command drift `2`; generated `reports/` remain hold-by-default.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
  - `node --test tests/reliability-cockpit.test.js` -> `64/64` focused cockpit tests green.
- Boundary: this does not reload the MCP host, prove loaded-agent execution, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It proves the current loaded host is freshly inspected and still stale.
- Exact next slice: push this regression guard, then restart/reload Codex/Cursor FirstBite MCP host and capture a new live `list_lanes` artifact before trusting loaded-agent execution.

## 2026-05-25 11:23 EDT

- `NO-GO` overall launch; `RED/current` still holds, and the cockpit now separates a runnable loaded-MCP evidence recapture from the blocked loaded-MCP host reload.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` adds `loaded-mcp-recapture` as a `canRunNow=true` evidence-refresh action when the loaded-host probe is missing/stale, while keeping `loaded-mcp-refresh` red and `canRunNow=false` until Codex/Cursor actually reloads the long-lived MCP host.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the current Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded-agent execution remains red.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `63/63` focused cockpit tests green.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; `loaded-mcp-recapture` is yellow/run-now for stale evidence only, and `loaded-mcp-refresh` remains red/after-dependency for Codex/Cursor host reload.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present.
  - `npm run check` -> strict release validation green and `249/249` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `10`, command drift `2`; generated `reports/` remain hold-by-default.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not recapture the loaded-host artifact, reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It prevents the GUI from conflating "refresh stale evidence" with "trust this host is reloaded."
- Exact next slice: commit/push this recapture-vs-reload split, rerun the read-only review scout from the final PR head, then either capture fresh live loaded-host `list_lanes` evidence or restart/reload Codex/Cursor and recapture before trusting loaded-agent execution.

## 2026-05-25 11:14 EDT

- `NO-GO` overall launch; `RED/current` still holds, and the loaded Codex/Cursor MCP host is now explicitly modeled as a host-reload dependency instead of a runnable same-process action.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` now marks `loaded-mcp-refresh` as `canRunNow=false` when the loaded probe or refresh plan says stale long-lived MCP host processes must restart/reload before repo-manifest lanes can be trusted. The operator recovery flow now puts this under `waitingOnDependency` with a concrete Codex/Cursor reload blocker.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the current Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded-agent execution remains red.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `62/62` focused cockpit tests green.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; `loaded-mcp-refresh` is red, `canRunNow=false`, and blocked by Codex/Cursor host restart/reload.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present.
  - `npm run check` -> strict release validation green and `248/248` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `9`, command drift `2`; index contains only the two source/test files.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It prevents the GUI from implying the current running MCP process can repair its own stale catalog.
- Exact next slice: commit/push this host-reload dependency hardening, rerun the read-only review scout from the final PR head, then restart/reload the FirstBite MCP host and capture fresh live loaded-host `list_lanes` proof before trusting loaded-agent execution.

## 2026-05-25 11:02 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the coding-agent review-scout section now separates current review proof from stale/actionable scout history.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` now counts superseded actionable review-scout packets, renders a `Superseded actionable` row in the cockpit GUI, includes that count in the review-scout summary, and prioritizes failed repo-lane proof ahead of the optional Cursor sidecar recommendation. This makes old packet-only `actionable=true` rows visible as history instead of letting them feel like current review pressure.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the active Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded-agent execution remains red.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `62/62` focused cockpit tests green.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; latest review scout remains stale (`b9e562c` vs `a3dafa2`) but now reports `20` older actionable claim(s) as superseded history.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present.
  - `npm run check` -> strict release validation green and `248/248` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `9`, command drift `2`.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It only removes ambiguity from stale coding-agent review history in the local cockpit.
- Exact next slice: commit/push this cockpit hardening, keep `reports/` local, rerun the read-only review scout from the final PR head, then restart/reload the FirstBite MCP host and capture fresh live loaded-host `list_lanes` proof before trusting loaded-agent execution.

## 2026-05-25 10:52 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the MCP refresh/recovery path now carries the active checkout path instead of letting the next operator accidentally rerun against the stale canonical checkout.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` now scopes FirstBite MCP refresh-plan continuation commands with `RESPLIT_CURRENCY_API_REPO=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525` when building the cockpit, operator action queue, and evidence-freshness ledger.
- Fresh proof:
  - `FIRSTBITE_MCP_REFRESH_PLAN_RUN_ID=codex-fx-refresh-plan-5bf8b78-20260525 RESPLIT_CURRENCY_API_REPO=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525 bash /Users/leokwan/Development/ai-leo/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh --json` -> repo-backed catalog `repo-manifest-v2`, `16/16` declared lane(s), no missing `resplit_currency_api_trust_preflight`; process audit still shows `16/21` stale loaded processes, so host reload remains required.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; loaded MCP action command is now `RESPLIT_CURRENCY_API_REPO='/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525' FIRSTBITE_MCP_REFRESH_PLAN_RUN_ID=handoff-$(date +%Y%m%d-%H%M%S) bash "$HOME/Development/ai-leo/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh"`.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present.
  - `node --test tests/reliability-cockpit.test.js` -> `61/61` focused cockpit tests green, including scoped refresh-plan command coverage.
  - `npm run check` -> strict release validation green and `247/247` tests passed.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `10`, command drift `2`.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not reload the loaded Codex/Cursor MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It makes the GUI's recovery command reproduce the current repo-backed evidence instead of regressing to a stale checkout.
- Exact next slice: commit/push this scoped-refresh-command hardening, keep `reports/` local, then restart/reload the FirstBite MCP host and capture fresh live loaded-host `list_lanes` proof before trusting loaded-agent execution.

## 2026-05-25 10:45 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the repo-backed FirstBite catalog can no longer look green while silently reading the wrong checkout.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` now records expected, requested, and actual repo paths for the repo-backed MCP catalog probe, compares the catalog path against the active cockpit repo, renders that path proof in the HTML GUI, and turns wrong-checkout catalog evidence red even if all expected lane ids are present.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in this active Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded-host execution remains red.
  - `node --test tests/reliability-cockpit.test.js` -> `60/60` focused cockpit tests green, including wrong-checkout catalog rejection.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; repo-backed catalog is green with `expectedRepoPath=requestedRepoPath=actualRepoPath=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525`, while loaded-vs-repo-backed delta remains red (`12` loaded lanes vs `16` repo-backed lanes, missing `resplit_currency_api`).
  - `npm run check` -> strict release validation green and `246/246` tests passed.
  - `npm run reliability:cockpit:verify` -> cockpit report contract green: `11` gate(s), `5` action(s), generated HTML sections present.
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit still `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `10`, command drift `2`.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `8` non-green/missing launch boundary(s), `12` non-green trust contract(s).
- Boundary: this does not reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It closes the stale canonical-checkout trust hole inside the repo-backed control-plane GUI.
- Exact next slice: commit/push this path-proof hardening, keep `reports/` local, then restart/reload the FirstBite MCP host and recapture `reports/firstbite-loaded-mcp-lanes.json` before trusting loaded-agent execution.

## 2026-05-25 10:28 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the cockpit no longer keeps the release-history gate yellow after current strict validation is green.
- Shipped delta pending source promotion: tightened `parseNurseLog` release-history classification so green strict-validation proof is recognized separately from old release-history/backfill warnings. The generated cockpit now removes the `release-history-backfill` operator action when the latest nurse proof says strict validation is green.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the active Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so the loaded-host boundary remains red.
  - `node --check scripts/reliability-cockpit.js && node --test tests/reliability-cockpit.test.js` -> `59/59` focused cockpit tests green.
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green; `Release-history strict coverage` is green and `release-history-backfill` is absent from the operator queue.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `Launch completion blocked: 8 non-green/missing launch boundary(s), 12 non-green trust contract(s).`
  - `npm run trust:preflight` -> expected red exit `2`; commands `11` green, `3` yellow, `1` red; cockpit `RED - missing required trust contract`.
  - `npm run source:promotion-packet` -> expected red exit `1`; stage candidates `2`, hold-by-default `10`, command drift `2`.
  - `npm run check` -> strict release validation green; package validation `OK` with `166` currencies, `history points=30`, `strictHistory=on`; `245/245` tests passed.
  - `npm run smoke:deploy` -> `OK` for `2026-05-25`, `historyPoints=30`, Cloudflare Pages `https://resplit-currency-api.pages.dev`.
  - Post-commit source-state proof: `npm run trust:preflight` -> expected red exit `2`; `npm run source:promotion-packet` -> expected red exit `1` with stage candidates `0`, hold-by-default `9`, command drift `2`; `npm run reliability:completion-audit` -> expected red exit `2`, still `8` non-green launch boundaries and `12` non-green trust contracts.
- Boundary: this does not reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It removes stale release-history noise from the GUI so the remaining red/yellow gates are the actual launch blockers.
- Exact next slice: push this parser fix, keep `reports/` local, then reload the FirstBite MCP host and recapture `mcp__firstbite_local_ci.list_lanes` before loaded-agent execution.

## 2026-05-25 10:22 EDT

- `NO-GO` overall launch; `RED/current` still holds, but launch completion is now mechanically audited instead of inferred from prose.
- Shipped delta pending source promotion: added `npm run reliability:completion-audit` (`scripts/reliability-completion-audit.js`) and wired it into `npm run trust:preflight` as expected red launch evidence. The cockpit report verifier still proves the generated GUI contains the required sections; the completion audit separately fails until every launch-trust boundary and trust contract is green and claim-allowed.
- Fresh proof:
  - Live `mcp__firstbite_local_ci.list_lanes` in the active Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so the loaded-host boundary remains red.
  - `node --check scripts/reliability-completion-audit.js && node --check scripts/trust-preflight.js && node --test tests/reliability-completion-audit.test.js tests/trust-preflight.test.js tests/reliability-cockpit.test.js` -> `67/67` focused tests green.
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> cockpit report contract green.
  - `npm run reliability:completion-audit` -> expected red exit `2`; `Launch completion blocked: 9 non-green/missing launch boundary(s), 13 non-green trust contract(s).`
  - `npm run trust:preflight` -> expected red exit `2`; commands `11 green, 3 yellow, 1 red`; the red command is the expected launch completion audit, and cockpit remains `RED - missing required trust contract`.
  - `npm run check` -> strict release validation green and `242/242` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
- Boundary: this does not reload the loaded MCP host, prove clean landed-source FirstBite execution, prove M4 peer execution, or prove Cloudflare/Grafana delivery. It gives the internal GUI a hard completion gate so those missing surfaces cannot be laundered as launch-ready.
- Exact next slice: commit/push this completion-audit source, rerun the source-promotion packet from the new head, keep `reports/` local, then reload the FirstBite MCP host and recapture `mcp__firstbite_local_ci.list_lanes` before trying loaded-agent execution.

## 2026-05-25 10:13 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the cockpit GUI now has its own source-backed verifier so the internal report cannot silently drop the operator trust surfaces.
- Shipped delta pending source promotion: added `npm run reliability:cockpit:verify` (`scripts/verify-reliability-cockpit-report.js`) and wired it into `npm run trust:preflight`. The verifier checks the generated cockpit JSON and HTML for required trust contracts, operator actions, launch audit, evidence freshness, FirstBite local CI, loaded-host MCP probe/delta, Cloudflare OTEL destinations, Grafana OTEL smoke, and missing FX lane IDs when the loaded host is red.
- Fresh proof:
  - `npm run reliability:cockpit && npm run reliability:cockpit:verify` -> verifier green: `Cockpit report contract is intact: 11 gate(s), 5 action(s), and generated HTML sections are present.`
  - `node --check scripts/reliability-cockpit.js && node --check scripts/trust-preflight.js && node --check scripts/verify-reliability-cockpit-report.js` -> green.
  - `node --test tests/verify-reliability-cockpit-report.test.js tests/reliability-cockpit.test.js tests/trust-preflight.test.js` -> `66/66` focused tests green.
  - `npm run trust:preflight` -> expected red exit `2`; commands `10 green, 3 yellow, 0 red`; cockpit remains `RED - missing required trust contract`.
  - `npm run check` -> strict release validation green and `237/237` tests passed.
  - `npm run source:promotion-packet` before this commit -> expected red source gate with `6` stage candidates (`package.json`, cockpit, trust-preflight, verifier script/test, cockpit tests), generated `reports/` held by default, and command drift because `origin/main` lacks the new trust-preflight/verifier surface.
- Boundary: this does not make loaded MCP, Cloudflare, Grafana, or clean local-CI proof green. It makes the GUI harder to accidentally launder those gates by hiding them from the generated HTML report.
- Exact next slice: commit/push this verifier source, rerun source-promotion packet from the new head, keep `reports/` local, then reload the FirstBite MCP host before trying loaded-agent execution.

## 2026-05-25 10:07 EDT

- `NO-GO` overall launch; `RED/current` still holds, but the loaded-host MCP boundary is now captured as fresh evidence instead of inferred from memory.
- Fresh live loaded MCP capture:
  - `mcp__firstbite_local_ci.list_lanes` in the active Codex host still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`.
  - `npm run mcp:loaded-probe -- --repo /Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525` with that live tool output -> `reports/firstbite-loaded-mcp-lanes.json`; source `codex-mcp-tool:mcp__firstbite_local_ci.list_lanes`, `12` loaded lane(s), `repoPresent=false`, missing `4/4` expected FX lanes.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`; loaded-host freshness is green (`1m old`) while loaded-host catalog status is red, with delta `12` loaded lanes vs repo-backed `16` lanes and missing repo `resplit_currency_api`.
  - `npm run trust:preflight` -> expected red exit `2`; commands `8 green, 3 yellow, 0 red`; cockpit remains red.
  - `npm run source:promotion-packet` -> expected red/yellow source gate; `0` stage candidates, generated `reports/` held by default, and the only command drift is that `origin/main` does not yet contain `resplit_currency_api_trust_preflight`.
- Boundary: this does not reload the MCP host and does not prove loaded-agent execution. It proves the opposite: the current loaded in-app host is fresh enough to inspect and still stale enough to fail the launch trust contract.
- Exact next slice: restart/reload Codex/Cursor FirstBite MCP host, rerun `mcp__firstbite_local_ci.list_lanes`, recapture `reports/firstbite-loaded-mcp-lanes.json`, and require the loaded-host delta to clear before running clean `resplit_currency_api_all` proof from landed source.

## 2026-05-25 09:58 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean landed-source local-CI execution, source-promotion, Cloudflare destination proof, Grafana Tempo/Loki proof, and the red `resplit_currency_api_trust_preflight` lane remain separate required trust contracts.
- Shipped cross-repo delta: `ai-leo` PR #12 (`fix: harden review scout repo identity`) merged to `ai-leo/main` at `ff23db3`. The review-scout producer script now derives canonical repo identity and manifest lane keys from `.firstbite/local-ci.json`, writes ledger rows against the canonical repo path when a worktree maps back to `~/Development/<repo>`, and separates manifest-backed lanes from stale proof-only lanes.
- Fresh proof:
  - `bash -n skills/resplit-watch/scripts/firstbite-cursor-review.sh` in the clean `ai-leo` worktree -> green.
  - `shellcheck skills/resplit-watch/scripts/firstbite-cursor-review.sh` in the clean `ai-leo` worktree -> green.
  - `FIRSTBITE_CURSOR_REVIEW_RUN_ID=codex-ai-leo-narrow-producer-smoke-v2-20260525 bash skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo /Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525 --no-cursor --no-ledger` -> report `/Users/leokwan/.agent-ledger/firstbite-cursor-review/codex-ai-leo-narrow-producer-smoke-v2-20260525/report.json`; `repo_name=resplit-currency-api`, `repo_basename=post-pr9-main-20260525`, `local_ci_repo_key=resplit_currency_api`, `head_sha=770f197`; local-CI repo proof remains `3/4` FX lanes pass with `resplit_currency_api_trust_preflight` failing.
  - `git show origin/main:skills/resplit-watch/scripts/firstbite-cursor-review.sh | rg 'MANIFEST_LOCAL_CI_REPO_KEY|MANIFEST_LOCAL_CI_LANE_KEYS_JSON|LOCAL_CI_REPO_KEY|LEDGER_REPO_PATH|local_ci_repo_key'` in `ai-leo` -> all canonical producer tokens present on `origin/main`.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`, and `Review-scout producer durability` is now green with `durableSupports=true` at `ai-leo origin/main` `ff23db3`.
- Boundary: this removes the producer-durability gap from the FX cockpit, but it does not restart/reload the loaded MCP host, prove clean landed-source `resplit_currency_api_all`, clear the trust-preflight red lane, or prove Cloudflare/Grafana delivery. The local primary `ai-leo` checkout is still dirty/divergent, but the durable reference is `origin/main` `ff23db3`.
- Exact next slice: rerun the review scout from the final PR head after this nurse-log commit, restart/reload Codex/Cursor FirstBite MCP host and capture `reports/firstbite-loaded-mcp-lanes.json`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 09:50 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean landed-source local-CI execution, source-promotion, Cloudflare destination proof, Grafana Tempo/Loki proof, and review-scout producer durability remain separate required trust contracts.
- Shipped delta pending source promotion: the reliability cockpit now has a first-class `Review Scout Producer Control Plane` section. It inspects the producer script in `ai-leo` across the working tree, `HEAD`, `origin/main`, and `origin/codex/local-ci-handoff-hardening-20260525`, then turns "branch/local support exists but origin/main is missing it" into a yellow trust contract, operator action, evidence-freshness row, launch-audit row, and HTML section.
- Fresh proof:
  - `mcp__firstbite_local_ci.list_lanes` still lists only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so the loaded in-app MCP host boundary remains red/missing.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`; review-scout producer durability is yellow with `durableSupports=false` and `producerBranchSupports=true`.
  - `npm run check` -> strict release validation green and `233/233` tests passed.
  - `bash /Users/leokwan/Development/ai-leo/skills/ledger/scripts/audit_ledger_quality.sh` -> `0 failure(s), 0 warning(s)`.
  - `/Users/leokwan/Development/ai/hooks/ledger-fleet-health.sh --repo resplit-currency-api --archive` -> healthy; `88 entries/24h`, `0 failures`, `4` actionable review scouts still visible.
- Boundary: this makes the GUI honest about the producer-side durability gap; it does not land the `ai-leo` review-scout script on `origin/main`, restart/reload the loaded MCP host, prove clean landed-source `resplit_currency_api_all`, or prove Cloudflare/Grafana delivery. After this source commit, rerun the canonical review scout from the final PR head before treating review-scout branch/head match as current proof.
- Exact next slice: land the review-scout producer patch on `ai-leo origin/main`, rerun the canonical review scout from current PR head, restart/reload Codex/Cursor FirstBite MCP host and capture `reports/firstbite-loaded-mcp-lanes.json`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 08:10 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean local-CI execution from landed source, source-promotion, Cloudflare destination proof, Grafana Tempo/Loki proof, and canonical coding-agent review-scout scope remain separate required trust contracts.
- Shipped delta pending source promotion: the reliability cockpit now treats review-scout local-CI scope as its own trust boundary. A current-checkout packet whose `local_ci_repo_key` is missing or mismatched is kept yellow, the cockpit derives only the expected repo lanes from lane metadata, unrelated cross-repo lane failures do not contaminate FX counts, and the HTML review-scout section shows a `Local-CI scope` row with actual versus expected repo key.
- Fresh proof:
  - `FIRSTBITE_CURSOR_REVIEW_RUN_ID=codex-current-pr10-review-scout-20260525-466c899 bash /Users/leokwan/Development/ai-leo/skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo /Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525 --no-cursor` -> report `/Users/leokwan/.agent-ledger/firstbite-cursor-review/codex-current-pr10-review-scout-20260525-466c899/report.json`; this pre-guard source checkpoint was `codex/fx-otel-grafana-config-20260525` `466c899`, Cursor did not run, and `actionable=true` still had no finding payload. Rerun the scout after every source commit before treating branch/head match as current proof.
  - The current scout exposed a scope gap: because the scout ran from worktree basename `post-pr9-main-20260525`, its `local_ci_repo_key` is missing. Regenerated cockpit now reports `derived_from_lane_metadata`, counts only FX lanes `3/4` pass with `resplit_currency_api_trust_preflight` failing, and keeps the review-scout gate yellow instead of treating all `19` latest lanes as repo-scoped proof.
  - Live loaded `mcp__firstbite_local_ci.list_lanes` still exposes only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded MCP host proof remains red/missing until host restart/reload plus captured artifact.
  - `bash /Users/leokwan/Development/ai-leo/skills/ledger/scripts/audit_ledger_quality.sh` -> `0 failure(s), 0 warning(s)`.
  - `/Users/leokwan/Development/ai/hooks/ledger-fleet-health.sh --repo resplit-currency-api --archive` -> healthy; `82 entries/24h`, `0 failures`, `3` actionable review scouts still visible.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `55/55` focused cockpit tests green, including the worktree-scout local-CI scope regression.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract` with `coding-agent-review-scout` yellow for missing `local_ci_repo_key`.
  - `npm run check` -> strict release validation green and `232/232` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
- Boundary: this makes the GUI harder to fool when a worktree-named scout packet carries all-lane local-CI proof. It does not fix the scout script's repo-key detection, prove the loaded in-app MCP host, prove a clean landed `resplit_currency_api_all` run, or prove Cloudflare/Grafana delivery.
- Exact next slice: fix or rerun the review scout so `local_ci_repo_key=resplit_currency_api`, source-promote this PR bundle, restart/reload Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json` from live `list_lanes`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:59 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean local-CI execution from landed source, source-promotion, Cloudflare destination proof, Grafana Tempo/Loki proof, and coding-agent review-scout freshness remain separate required trust contracts.
- Shipped delta pending source promotion: the reliability cockpit now ingests `~/.agent-ledger/firstbite-cursor-review/*/report.json` as a first-class `Coding-agent review scout` contract, evidence-freshness row, launch-audit input, operator action, and HTML section. It compares the scout packet branch/head against the current checkout and demotes no-Cursor `actionable=true` packets with no finding payload to yellow advisory evidence instead of treating them as current review proof.
- Fresh proof:
  - Latest review-scout packet selected by the cockpit: `/Users/leokwan/.agent-ledger/firstbite-cursor-review/verify-continuation-full-20260525-review-scout-resplit_currency_api/report.json`; packet is yellow because it is for `main` `16f7d4e`, not current PR head `codex/fx-otel-grafana-config-20260525` `1ffcfb3e8d28`, Cursor did not run, and `actionable=true` has no finding payload. The same packet still records repo local-CI `3/4` pass with `resplit_currency_api_trust_preflight` failing, so it stays visible as background evidence only.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `54/54` focused cockpit tests green, including non-current packet-only review-scout regression.
  - `npm run check` -> strict release validation green and `231/231` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract` and now includes `coding-agent-review-scout` in the Operator Action Queue.
- Boundary: this improves trust labeling for local coding-agent review packets; it does not prove the loaded in-app MCP host, a current-checkout review scout, a clean landed `resplit_currency_api_all` run, Cloudflare destination existence, or Grafana Tempo/Loki delivery.
- Exact next slice: rerun the read-only review scout from the current PR checkout, source-promote this PR bundle, restart/reload Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json` from live `list_lanes`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:46 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean local-CI execution from landed source, source-promotion, Cloudflare destination proof, and Grafana Tempo/Loki proof remain separate required trust contracts.
- Shipped delta pending source promotion: `npm run mcp:loaded-probe` now derives the expected repo and lane IDs from `.firstbite/local-ci.json` before evaluating a loaded Codex/Cursor MCP `list_lanes` capture. The old hardcoded three-lane default is no longer enough to make a probe look current; a loaded host that sees unit/integration/ui but misses `resplit_currency_api_trust_preflight` stays red.
- Fresh proof:
  - Live loaded `mcp__firstbite_local_ci.list_lanes` still lists only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded MCP host trust remains unproven until restart/reload plus captured artifact.
  - `node --check scripts/capture-loaded-mcp-probe.js` -> green.
  - `node --test tests/capture-loaded-mcp-probe.test.js` -> `5/5` probe tests green, including manifest-derived expected-lane coverage.
  - `node --test tests/reliability-cockpit.test.js` -> `53/53` focused cockpit tests green.
  - `npm run mcp:loaded-probe -- --help` -> documents that `.firstbite/local-ci.json` is the default expected contract and `--reuse-existing` is freshness-only, not reload proof.
  - `npm run check` -> strict release validation green and `230/230` tests passed.
  - `npm run smoke:deploy` -> `OK (date=2026-05-25, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`.
- Boundary: this fixes the loaded-host capture path so it follows the repo manifest, but it still does not prove the loaded in-app MCP host, a clean landed `resplit_currency_api_all` run, Cloudflare destination existence, or Grafana Tempo/Loki delivery. The local `ai-leo` checkout already has unrelated dirty changes including `skills/local-ci/SKILL.md`, so this slice did not mix cross-repo skill edits into that state.
- Exact next slice: source-promote this PR bundle, restart/reload Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json` from live `list_lanes`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:39 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean local-CI execution from landed source, source-promotion, Cloudflare destination proof, and Grafana Tempo/Loki proof remain separate required trust contracts.
- Shipped delta pending source promotion: the FirstBite MCP refresh-plan parser no longer hardcodes a `15` lane catalog floor. It now treats a `repo-manifest-v2` packet as current only when the packet's declared/lane counts are self-consistent and meet the expected manifest lane floor for this repo; fresh packets still go red when they omit current expected lanes such as `resplit_currency_api_trust_preflight`.
- Fresh proof:
  - Live loaded `mcp__firstbite_local_ci.list_lanes` still lists only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so loaded MCP host trust remains unproven until restart/reload plus captured artifact.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `53/53` focused cockpit tests green, including the manifest-driven refresh catalog regression.
  - `npm run check` -> strict release validation green and `229/229` tests passed.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`. Current refresh plan is fresh but red because packet catalog `repo-manifest-v2` `15/15` is missing `resplit_currency_api_trust_preflight`; Grafana proof remains yellow with Tempo/Loki missing.
- Boundary: this removes a stale source assumption in the cockpit; it does not prove the loaded in-app MCP host, a clean landed `resplit_currency_api_all` run, Cloudflare destination existence, or Grafana Tempo/Loki delivery.
- Exact next slice: source-promote this PR bundle, restart/reload Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json` from live `list_lanes`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:31 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, clean local-CI execution from landed source, source-promotion, Cloudflare destination proof, and Grafana Tempo/Loki proof remain separate required trust contracts.
- Shipped delta pending source promotion: the cockpit now ingests `~/.agent-ledger/firstbite-mcp-refresh-plan/*/report.json` as a first-class `FirstBite MCP Refresh Plan` section, trust-contract note, operator action proof, and evidence-freshness row. It compares the packet's repo-backed lane keys against the current `.firstbite/local-ci.json` expected lanes so a fresh packet cannot hide stale source/catalog drift.
- Fresh proof:
  - `FIRSTBITE_MCP_REFRESH_PLAN_RUN_ID=codex-post-pr10-20260525-072944 bash "$HOME/Development/ai-leo/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh"` -> report `/Users/leokwan/.agent-ledger/firstbite-mcp-refresh-plan/codex-post-pr10-20260525-072944/report.json`; verdict `stale_loaded_clients_need_host_app_restart`; process audit `17/19` stale; packet catalog `repo-manifest-v2` `15/15`.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit remains `RED - missing required trust contract`. Direct repo-backed FirstBite probe is green with `16` lanes and `resplit_currency_api` `4/4`; refresh packet is red because it is missing `resplit_currency_api_trust_preflight`; loaded MCP host probe remains missing.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `52/52` focused cockpit tests green, including refresh-plan stale-process and stale-current-manifest regressions.
  - `npm run check` -> strict release validation green and `228/228` tests passed.
- Boundary: this is not live loaded `list_lanes` proof. The refresh packet is read-only process/catalog evidence; it now proves the host-app MCP surface needs restart/reload and also shows its default repo-backed catalog path is stale versus this PR worktree's current manifest.
- Exact next slice: source-promote this PR bundle, restart/reload Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json` from live `list_lanes`, then run clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:18 EDT

- `NO-GO` overall launch; `RED/current` still holds because loaded MCP host freshness, selected clean local-CI proof, source-promotion, and external Cloudflare/Grafana proof remain separate required trust contracts.
- Shipped delta pending source promotion: ai-leo PR #11 is now merged to `ai-leo/main` (`8b55c1685c0c`), so the FirstBite runner's expected/yellow exit handling is durable on `origin/main`. The cockpit now treats `active package + origin/main support` as a green runner-durability signal even when the local ai-leo checkout `HEAD` is stale or divergent, and keeps the stale loaded-host boundary separate.
- Fresh proof:
  - `gh pr view 11 --repo leojkwan/ai-leo` -> `MERGED` at `2026-05-25T11:14:55Z`, merge commit `8b55c1685c0cc0664acbacb4b1ad8378f5322533`.
  - `git show origin/main:skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs` in ai-leo contains `expected_yellow`, `trust_status`, `exit_classification`, and `source_ref`.
  - Repo-backed FirstBite `run_lanes` dry-run for `resplit_currency_api_trust_preflight` with `source_ref=refs/remotes/origin/codex/fx-otel-grafana-config-20260525` -> expected exits `[0,1]`, yellow exits `[1]`, report `/Users/leokwan/.agent-ledger/firstbite-local-ci-mcp/mcp-20260525T111419Z-70628/report.json`.
  - Live loaded `mcp__firstbite_local_ci.list_lanes` still lists only `resplit_web`, `resplit_ios`, `strongyes_web`, and `moussey`; no `resplit_currency_api`, so the loaded host remains stale after ai-leo merge.
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `49/49` focused cockpit tests green, including the stale-local-HEAD/durable-origin-main regression.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit verdict remains `RED - missing required trust contract`; runner durability is now green, repo-backed MCP package green, loaded MCP host missing.
  - `npm run check` -> strict release validation green and `225/225` tests passed.
- Boundary: this does not prove loaded MCP freshness, clean `resplit_currency_api_all` execution from landed source, Cloudflare destination existence, or Grafana Tempo/Loki delivery. The local ai-leo checkout `HEAD` is still stale/divergent even though active files and `origin/main` contain the runner support.
- Exact next slice: restart/reload the Codex/Cursor FirstBite MCP host, capture `reports/firstbite-loaded-mcp-lanes.json`, then rerun clean worktree `resplit_currency_api_all` from landed source and keep Cloudflare/Grafana read-token proofs separate.

## 2026-05-25 07:02 EDT

- `NO-GO` overall launch; `RED/current` for the local-CI/agent/OTEL control plane because the cockpit now separates repo-backed FirstBite catalog truth, runner-package durability, loaded MCP host freshness, and external Grafana proof instead of compressing them into one local-CI color.
- Shipped delta pending source promotion: `scripts/reliability-cockpit.js` now inspects the FirstBite runner control plane from `ai-leo` (`working tree`, `HEAD`, `origin/main`, and `origin/codex/firstbite-mcp-warn-exits-20260525`) and adds a first-class `FirstBite runner durability` trust contract, risk, operator action, launch-audit row, freshness row, and HTML section. The cockpit also stops treating ordinary `needs_review` PR handoffs as ledger failure history unless the row contains an explicit red/fail/blocked signal. Tests cover both the runner-durability split and the ledger classification boundary.
- Fresh proof:
  - `node --check scripts/reliability-cockpit.js` -> green.
  - `node --test tests/reliability-cockpit.test.js` -> `48/48` focused cockpit tests green.
  - `npm run reliability:cockpit` -> regenerated `reports/resplit-fx-reliability-cockpit.html`; cockpit verdict remains `RED - missing required trust contract`.
  - Regenerated cockpit evidence: repo-backed FirstBite catalog is green (`repo-manifest-v2`, `16` lanes, `resplit_currency_api` `4/4` expected lanes); runner durability is yellow (`activeSupports=true`, `headSupports=false`, `durableSupports=false`, `prSupports=true`); loaded MCP host probe is missing until host restart/reload and capture; ledger health drops from false red to yellow when old failure rows have later recovery evidence.
  - `npm run check` -> strict release validation green and `224/224` tests passed.
- Boundary: active `ai-leo` runner files are still dirty and not durable on `HEAD`/`origin/main`; ai-leo PR #11 branch has the support, but the loaded in-app MCP host still needs restart/reload plus `reports/firstbite-loaded-mcp-lanes.json`. Cloudflare destination proof and Grafana Tempo/Loki smoke remain external read-token/deploy proofs, not solved by this local cockpit work.
- Exact next slice: land/merge the ai-leo FirstBite runner change, restart/reload the Codex/Cursor MCP host, capture fresh loaded-host `list_lanes`, rerun clean worktree `resplit_currency_api_all` from landed source, then keep Cloudflare/Grafana proof as a separate gate.

## 2026-05-25 06:40 EDT

- `NO-GO` overall launch; `RED/current` for the local-CI/agent/OTEL control plane because the trust preflight now preserves red cockpit verdicts at the top-level FirstBite lane instead of collapsing every non-green preflight into one ambiguous exit code.
- Shipped delta pending source promotion: `npm run trust:preflight` now exits `0=green`, `1=yellow`, `2=red`; `.firstbite/local-ci.json` declares `resplit_currency_api_trust_preflight` as `expectedExitCodes [0,1]` with `yellowExitCodes [1]`; the cockpit carries expected/yellow lane metadata, keeps expected-warning proof yellow, and keeps red/error proof red.
- Fresh proof:
  - FirstBite MCP package `npm run lint` -> green after local runner support for `expectedExitCodes`, `yellowExitCodes`, lane `warn`, aggregate `warn`, `exit_classification`, and `trust_status`.
  - Repo-backed FirstBite `list_lanes` with `RESPLIT_CURRENCY_API_REPO=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525` -> `repo-manifest-v2`, `16` lanes, `resplit_currency_api_trust_preflight` exposes `expectedExitCodes [0,1]` and `yellowExitCodes [1]`.
  - `node --check scripts/reliability-cockpit.js` and `node --check scripts/trust-preflight.js` -> green.
  - `node --test tests/reliability-cockpit.test.js tests/trust-preflight.test.js` -> `53/53` focused tests green.
  - `npm run trust:preflight` -> expected red exit `2`: commands `8 green, 3 yellow, 0 red`, but cockpit verdict remains `RED - missing required trust contract`.
  - FirstBite `run_lanes` active-checkout proof `verify-resplit-fx-trust-preflight-red-preserved-20260525` -> `overall=fail`, lane `rc=2`, `exit_classification=unexpected`, `trust_status=red`; this proves red cockpit truth is not laundered into yellow.
  - `npm run reliability:cockpit` -> regenerated local cockpit with selected FirstBite proof red: `Manifest has 4 lane(s); latest MCP proof is fail, but resplit_currency_api_trust_preflight: command exited with code 2`.
  - `npm run check` -> strict release validation green and `223/223` tests passed.
  - `npm run source:promotion-packet` -> expected red while cockpit is red; source candidates are reviewed, but generated reports remain local and the launch claim stays blocked by missing trust contracts.
- Boundary: the FirstBite MCP runner patch is local in `ai-leo` until that package is committed/reloaded; the in-app loaded MCP host is still stale until restart/reload and a fresh `reports/firstbite-loaded-mcp-lanes.json` probe.
- Exact next slice: promote this PR bundle, commit/reload the FirstBite MCP package change, capture loaded MCP host proof, then rerun clean worktree `resplit_currency_api_all` from landed source and keep external Cloudflare/Grafana read-token proofs separate.

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
