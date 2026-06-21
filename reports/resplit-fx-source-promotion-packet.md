# Resplit FX Source Promotion Packet

- Generated: 2026-06-20T18:42:21.446Z
- Status: red
- Repo: /Users/leokwan/Development/resplit-currency-api
- Head: 46c8f62fbf94
- origin/main: 5947eafbf009
- Summary: status=red; stage candidates 19; hold by default 56; command drift 4; cockpit=RED - missing required trust contract
- Next action: Review only the stage candidates, keep hold-by-default rows unstaged, then rerun clean worktree FirstBite proof after the bundle lands.

## Commands

| Step | Command |
|---|---|
| inspectStatus | `git status --short -- '.firstbite/local-ci.json' 'package.json' 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| inspectDiff | `git diff -- '.firstbite/local-ci.json' 'package.json' 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| inspectOriginDiff | `git diff origin/main -- 'package.json' 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| inspectUntracked | `git ls-files --others --exclude-standard -- '.firstbite/local-ci.json' 'package.json' 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| stageExactBundle | `BLOCKED: resolve 1 red candidate(s) before staging the full bundle` |
| stageNonRedCandidates | `git add -- 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| reviewStaged | `git diff --cached --stat && git diff --cached --check` |
| verifyStagedExactBundle | `npm run source:promotion-packet && git diff --cached --name-status && git diff --cached --check` |
| unstageExactBundle | `git restore --staged -- 'package.json' 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| cleanProofAfterPromotion | `cd /Users/leokwan/Development/ai-leo/skills/resplit-watch/mcp/firstbite-local-ci && npm run --silent call -- run_lanes '{"mode":"execute","group":"resplit_currency_api_all","worktree":true,"source_ref":"refs/remotes/origin/main","run_id":"verify-resplit-fx-clean-origin-main-YYYYMMDD"}'` |

## Staging Gate

Status: red — Full bundle staging is blocked by 1 red upstream-drift candidate(s); 18 non-red candidate(s) remain available for separate review-only staging.

| Field | Value |
|---|---|
| fullStageBlocked | yes |
| fullStageCommand | `BLOCKED: resolve 1 red candidate(s) before staging the full bundle` |
| stageNonRedCandidates | `git add -- 'currscript.js' 'scripts/reliability-cockpit.js' 'scripts/smoke-check-deploy.js' 'scripts/source-promotion-packet.js' 'scripts/trust-preflight.js' 'scripts/validate-package.js' '.firstbite/source-promotion-decisions.json' 'tests/reliability-cockpit.test.js' 'tests/source-promotion-packet.test.js' 'tests/trust-preflight.test.js' 'scripts/capture-loaded-mcp-probe.js' 'tests/capture-loaded-mcp-probe.test.js' 'scripts/verify-grafana-otel-smoke.js' 'tests/verify-grafana-otel-smoke.test.js' 'scripts/audit-history-backfill-sources.js' 'tests/audit-history-backfill-sources.test.js' 'tests/smoke-check-deploy.test.js' 'tests/validate-package.test.js'` |
| nextAction | Run the red-row review commands, decide current-vs-origin content, then regenerate this packet before staging the full bundle. |

## Staged Bundle Attestation

Status: red — Index attestation is red because the full staging gate is blocked.

| Field | Value |
|---|---|
| exactMatch | no |
| stagedStageable | 19/19 |
| unexpectedStaged | 0 |
| dirtyAfterStaging | 1 |
| nextAction | Resolve red staging-gate rows before trusting anything currently staged. |

| Category | Paths |
|---|---|
| staged candidate paths | `.firstbite/source-promotion-decisions.json`, `currscript.js`, `package.json`, `scripts/audit-history-backfill-sources.js`, `scripts/capture-loaded-mcp-probe.js`, `scripts/reliability-cockpit.js`, `scripts/smoke-check-deploy.js`, `scripts/source-promotion-packet.js`, `scripts/trust-preflight.js`, `scripts/validate-package.js`, `scripts/verify-grafana-otel-smoke.js`, `tests/audit-history-backfill-sources.test.js`, `tests/capture-loaded-mcp-probe.test.js`, `tests/reliability-cockpit.test.js`, `tests/smoke-check-deploy.test.js`, `tests/source-promotion-packet.test.js`, `tests/trust-preflight.test.js`, `tests/validate-package.test.js`, `tests/verify-grafana-otel-smoke.test.js` |
| unstaged candidate paths | none |
| unexpected staged paths | none |
| dirty after staging paths | `package.json` |

| Blocked path | Classification | Δ origin | Review command |
|---|---|---:|---|
| `package.json` | `modified-tracked-origin-drift` | -2 | `git diff -- 'package.json' && git diff origin/main -- 'package.json'` |

## Stage Candidates

| Path | Role | Git | Current | HEAD | origin/main | Action |
|---|---|---:|---:|---:|---:|---|
| `package.json` | local-CI contract | `MM package.json` | present | tracked | tracked | include modified current source |
| `currscript.js` | local-CI contract | `M  currscript.js` | present | tracked | tracked | include modified current source |
| `scripts/reliability-cockpit.js` | local-CI contract | `A  scripts/reliability-cockpit.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/smoke-check-deploy.js` | local-CI contract | `M  scripts/smoke-check-deploy.js` | present | tracked | tracked | include modified current source |
| `scripts/source-promotion-packet.js` | local-CI contract | `A  scripts/source-promotion-packet.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/trust-preflight.js` | local-CI contract | `A  scripts/trust-preflight.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/validate-package.js` | local-CI contract | `M  scripts/validate-package.js` | present | tracked | tracked | include modified current source |
| `.firstbite/source-promotion-decisions.json` | source-promotion review | `A  .firstbite/source-promotion-decisions.json` | present | missing | tracked | add to HEAD before clean proof |
| `tests/reliability-cockpit.test.js` | verification | `A  tests/reliability-cockpit.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/source-promotion-packet.test.js` | verification | `A  tests/source-promotion-packet.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/trust-preflight.test.js` | verification | `A  tests/trust-preflight.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/capture-loaded-mcp-probe.js` | MCP host probe | `A  scripts/capture-loaded-mcp-probe.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/capture-loaded-mcp-probe.test.js` | verification | `A  tests/capture-loaded-mcp-probe.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/verify-grafana-otel-smoke.js` | telemetry proof | `A  scripts/verify-grafana-otel-smoke.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/verify-grafana-otel-smoke.test.js` | verification | `A  tests/verify-grafana-otel-smoke.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `scripts/audit-history-backfill-sources.js` | release-history audit | `A  scripts/audit-history-backfill-sources.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/audit-history-backfill-sources.test.js` | verification | `A  tests/audit-history-backfill-sources.test.js` | present | missing | tracked | add to HEAD before clean proof |
| `tests/smoke-check-deploy.test.js` | verification | `M  tests/smoke-check-deploy.test.js` | present | tracked | tracked | include modified current source |
| `tests/validate-package.test.js` | verification | `M  tests/validate-package.test.js` | present | tracked | tracked | include modified current source |

## Candidate Reconciliation

Status: red — 19 candidate(s) reviewed; 12 already present on origin/main; 10 origin drift row(s); 0 new local-only file(s); 6 modified tracked file(s)

| Path | Status | Classification | Current | HEAD | origin/main | Δ HEAD | Δ origin | Decision | Review command | Action |
|---|---:|---|---:|---:|---:|---:|---:|---|---|---|
| `package.json` | red | `modified-tracked-origin-drift` | `295faa8f2f11 / 33l` | `a0e3e6a8e15d / 24l` | `ffb5de2b1cf4 / 35l` | +9 | -2 | `none` | `git diff -- 'package.json' && git diff origin/main -- 'package.json'` | Diff against both HEAD and origin/main before staging; branch drift and local edits overlap. |
| `currscript.js` | yellow | `modified-tracked` | `c15af4ace2d6 / 628l` | `e9029b11ec70 / 624l` | `c15af4ace2d6 / 628l` | +4 | 0 | `none` | `git diff -- 'currscript.js'` | Review the working-tree diff before staging this tracked file. |
| `scripts/reliability-cockpit.js` | yellow | `origin-present-origin-drift-reviewed` | `6f5e9b171353 / 4919l` | `missing` | `a8fb476b07b4 / 4885l` | n/a | +34 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:scripts/reliability-cockpit.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/reliability-cockpit.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current cockpit preserves explicit origin-main source_ref clean proof semantics while adding Grafana source-identity trust and keeping source-promotion truth separate from clean-proof readiness. |
| `scripts/smoke-check-deploy.js` | yellow | `modified-tracked` | `3021f4fc2f95 / 435l` | `4f6c021ea796 / 233l` | `3021f4fc2f95 / 435l` | +202 | 0 | `none` | `git diff -- 'scripts/smoke-check-deploy.js'` | Review the working-tree diff before staging this tracked file. |
| `scripts/source-promotion-packet.js` | yellow | `origin-present-origin-drift-reviewed` | `68648860a0e2 / 1158l` | `missing` | `015418faae18 / 1089l` | n/a | +69 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:scripts/source-promotion-packet.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/source-promotion-packet.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current packet keeps landed zero-candidate bundles green, keeps review-decision metadata non-self-blocking, compares the staged package contract when package.json also has unrelated unstaged OCR dependency drift, and excludes that index-sourced package row from generated git-add commands. |
| `scripts/trust-preflight.js` | yellow | `origin-present-origin-drift-reviewed` | `5ebfd6c46195 / 372l` | `missing` | `dc4bc63a57af / 372l` | n/a | 0 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:scripts/trust-preflight.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/trust-preflight.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current preflight writes the Grafana missing-config proof to the cockpit-consumed grafana-otel-smoke-missing-config-preflight.json path. |
| `scripts/validate-package.js` | yellow | `modified-tracked` | `99ee426ff2dd / 274l` | `d843ba715acd / 207l` | `99ee426ff2dd / 274l` | +67 | 0 | `none` | `git diff -- 'scripts/validate-package.js'` | Review the working-tree diff before staging this tracked file. |
| `.firstbite/source-promotion-decisions.json` | yellow | `review-decision-manifest-update` | `62de1e11196f / 120l` | `missing` | `2cae36b2395b / 50l` | n/a | +70 | `none` | `git status --short -- '.firstbite/source-promotion-decisions.json'` | Review decision manifest changed; keep it stageable but do not require a self-referential hash decision. |
| `tests/reliability-cockpit.test.js` | yellow | `origin-present-origin-drift-reviewed` | `241093c717c7 / 2608l` | `missing` | `80542a682a39 / 2531l` | n/a | +77 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:tests/reliability-cockpit.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/reliability-cockpit.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current tests lock source_ref=refs/remotes/origin/main proof, Grafana source-identity trust, and source-promotion/clean-proof gate separation. |
| `tests/source-promotion-packet.test.js` | yellow | `origin-present-origin-drift-reviewed` | `c013bf41d115 / 547l` | `missing` | `d8fb20d3c470 / 473l` | n/a | +74 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:tests/source-promotion-packet.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/source-promotion-packet.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current tests preserve zero-candidate green attestation, cover the decision-manifest non-self-blocking metadata row, and lock the staged-package/unstaged-drift split including safe git-add command generation. |
| `tests/trust-preflight.test.js` | yellow | `origin-present-origin-drift-reviewed` | `2c4a9d21e1ce / 122l` | `missing` | `bd6500043935 / 122l` | n/a | 0 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:tests/trust-preflight.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/trust-preflight.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current test locks the renamed Grafana missing-config preflight artifact path. |
| `scripts/capture-loaded-mcp-probe.js` | yellow | `origin-present-match` | `70c380a12d76 / 258l` | `missing` | `70c380a12d76 / 258l` | n/a | 0 | `none` | `tmp=$(mktemp); git show 'origin/main:scripts/capture-loaded-mcp-probe.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/capture-loaded-mcp-probe.js'; rc=$?; rm -f "$tmp"; exit $rc` | Prefer reconciling the behind checkout with origin/main; current content matches upstream. |
| `tests/capture-loaded-mcp-probe.test.js` | yellow | `origin-present-match` | `1b9b63cd7611 / 94l` | `missing` | `1b9b63cd7611 / 94l` | n/a | 0 | `none` | `tmp=$(mktemp); git show 'origin/main:tests/capture-loaded-mcp-probe.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/capture-loaded-mcp-probe.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Prefer reconciling the behind checkout with origin/main; current content matches upstream. |
| `scripts/verify-grafana-otel-smoke.js` | yellow | `origin-present-origin-drift-reviewed` | `9a2cd523eb61 / 613l` | `missing` | `dad7b3b6f716 / 551l` | n/a | +62 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:scripts/verify-grafana-otel-smoke.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/verify-grafana-otel-smoke.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current Grafana proof records source identity so telemetry evidence carries checkout head, branch, dirty path, and generated-artifact context. |
| `tests/verify-grafana-otel-smoke.test.js` | yellow | `origin-present-origin-drift-reviewed` | `5f1a6594c30f / 223l` | `missing` | `2fa56a14cc75 / 171l` | n/a | +52 | `accepted:accept-current` | `tmp=$(mktemp); git show 'origin/main:tests/verify-grafana-otel-smoke.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/verify-grafana-otel-smoke.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Hash-locked review accepts current over origin/main: Current tests cover the source-identity provenance added to Grafana telemetry proof. |
| `scripts/audit-history-backfill-sources.js` | yellow | `origin-present-match` | `1d25c3ba3d4c / 532l` | `missing` | `1d25c3ba3d4c / 532l` | n/a | 0 | `none` | `tmp=$(mktemp); git show 'origin/main:scripts/audit-history-backfill-sources.js' > "$tmp" && git diff --no-index "$tmp" 'scripts/audit-history-backfill-sources.js'; rc=$?; rm -f "$tmp"; exit $rc` | Prefer reconciling the behind checkout with origin/main; current content matches upstream. |
| `tests/audit-history-backfill-sources.test.js` | yellow | `origin-present-match` | `3b4ecb521790 / 236l` | `missing` | `3b4ecb521790 / 236l` | n/a | 0 | `none` | `tmp=$(mktemp); git show 'origin/main:tests/audit-history-backfill-sources.test.js' > "$tmp" && git diff --no-index "$tmp" 'tests/audit-history-backfill-sources.test.js'; rc=$?; rm -f "$tmp"; exit $rc` | Prefer reconciling the behind checkout with origin/main; current content matches upstream. |
| `tests/smoke-check-deploy.test.js` | yellow | `modified-tracked-origin-drift-reviewed` | `01d4d89c8a52 / 416l` | `8b8294fde2f7 / 189l` | `b61212349834 / 531l` | +227 | -115 | `accepted:accept-current` | `git diff -- 'tests/smoke-check-deploy.test.js' && git diff origin/main -- 'tests/smoke-check-deploy.test.js'` | Hash-locked review accepts current over origin/main: Current tests keep the GitHub Pages propagation-grace coverage while avoiding the duplicated recovery-gap test block present on origin/main. |
| `tests/validate-package.test.js` | yellow | `modified-tracked` | `a22bcaad51f5 / 125l` | `1304acf4b498 / 83l` | `a22bcaad51f5 / 125l` | +42 | 0 | `none` | `git diff -- 'tests/validate-package.test.js'` | Review the working-tree diff before staging this tracked file. |

## Hold By Default

| Path | Status | Disposition |
|---|---:|---|
| `.cursor/plans/resplit-nurse.log.md` | `M` | plan checkpoint; review separately |
| `.gitignore` | `M` | ignore-rule change; review separately |
| `INBOX.md` | `M` | operator doc or queue file; review separately |
| `README.md` | `M` | operator doc or queue file; review separately |
| `RUNBOOK.md` | `M` | operator doc or queue file; review separately |
| `package-lock.json` | `M` | outside source-promotion packet; hold by default |
| `snapshot-archive/2025-05-12.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-13.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-14.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-15.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-16.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-17.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-18.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-19.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-20.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-21.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-22.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-23.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-24.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-25.json` | `D` | snapshot archive data; hold by default |
| `snapshot-archive/2025-05-26.json` | `D` | snapshot archive data; hold by default |
| `tests/fx-worker-routes.test.js` | `M` | outside source-promotion packet; hold by default |
| `worker/src/index.mjs` | `M` | outside source-promotion packet; hold by default |
| `wrangler.jsonc` | `M` | Cloudflare config; review separately |
| `.agents/skills/hooks/SKILL.md` | `??` | agent local state; hold by default |
| `.agents/skills/release-train/SKILL.md` | `??` | agent local state; hold by default |
| `docs/grafana-otel-smoke-20260525.md` | `??` | outside source-promotion packet; hold by default |
| `scripts/backfill-history-snapshots.js` | `??` | outside source-promotion packet; hold by default |
| `snapshot-archive/2026-05-12.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-13.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-14.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-15.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-16.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-17.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-18.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-19.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-20.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-21.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-22.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-23.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-24.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-25.json` | `??` | snapshot archive data; hold by default |
| `snapshot-archive/2026-05-26.json` | `??` | snapshot archive data; hold by default |
| `tests/backfill-history-snapshots.test.js` | `??` | outside source-promotion packet; hold by default |
| `tests/ocr-attest.test.js` | `??` | outside source-promotion packet; hold by default |
| `tests/ocr-monitoring.test.js` | `??` | outside source-promotion packet; hold by default |
| `tests/ocr-router.test.js` | `??` | outside source-promotion packet; hold by default |
| `vidux/pre-launch-architecture/PLAN.md` | `??` | outside source-promotion packet; hold by default |
| `vidux/pre-launch-architecture/research/01-current-architecture.md` | `??` | outside source-promotion packet; hold by default |
| `vidux/pre-launch-architecture/research/02-gcp-target-architecture.md` | `??` | outside source-promotion packet; hold by default |
| `vidux/pre-launch-architecture/research/contract-openapi-draft.yaml` | `??` | outside source-promotion packet; hold by default |
| `worker/src/ocr/attest.mjs` | `??` | outside source-promotion packet; hold by default |
| `worker/src/ocr/attestation.mjs` | `??` | outside source-promotion packet; hold by default |
| `worker/src/ocr/azure.mjs` | `??` | outside source-promotion packet; hold by default |
| `worker/src/ocr/monitoring.mjs` | `??` | outside source-promotion packet; hold by default |
| `worker/src/ocr/router.mjs` | `??` | outside source-promotion packet; hold by default |

## Command Drift

| Name | Kind | Status | Current | HEAD | origin/main |
|---|---|---:|---|---|---|
| `check:publish` | package script | red | `npm run generate && npm run validate && npm run test` | `missing` | `npm run generate && npm run validate && npm run test` |
| `reliability:cockpit` | package script | red | `node scripts/reliability-cockpit.js` | `missing` | `node scripts/reliability-cockpit.js` |
| `source:promotion-packet` | package script | red | `node scripts/source-promotion-packet.js` | `missing` | `node scripts/source-promotion-packet.js` |
| `trust:preflight` | package script | red | `node scripts/trust-preflight.js` | `missing` | `node scripts/trust-preflight.js` |

## Blockers

| Area | Status | Detail |
|---|---:|---|
| source promotion bundle | red | 13 current-only file(s); 19 modified tracked file(s); 0 missing current file(s); 13 file(s) absent from HEAD; 0 file(s) absent from origin/main; 4 command drift row(s) |
| hold-by-default files | yellow | 56 dirty file(s) are outside the source-promotion bundle and should stay out unless separately reviewed. |
| checkout freshness | yellow | Primary checkout is behind origin/main by 53 commit(s). |
| OTEL/Grafana | yellow | Worker observability config exists; JSON proof does not show both Tempo and Loki matches: reports/grafana-otel-smoke-missing-config-preflight.json. |
| release history | yellow | Exact next slice: merge PR #7, then run `worktree=true` FirstBite proof from the landed tracked source. Keep loaded MCP restart, M4 peer execution, Grafana proof, and release-history as separate trust gates. |
| gitignore review | yellow | .gitignore is dirty and is not part of the default source-promotion bundle. |
| candidate reconciliation | red | 19 candidate(s) reviewed; 12 already present on origin/main; 10 origin drift row(s); 0 new local-only file(s); 6 modified tracked file(s) |
| staging gate | red | Full bundle staging is blocked by 1 red upstream-drift candidate(s); 18 non-red candidate(s) remain available for separate review-only staging. |
| staged bundle attestation | red | Index attestation is red because the full staging gate is blocked. |

