# Resplit FX Trust Preflight

- Generated: 2026-06-20T18:42:25.167Z
- Mode: fast
- Status: red
- Cockpit: RED - missing required trust contract

## Commands

| Check | Status | Exit | Expected | Command |
|---|---:|---:|---|---|
| Cockpit syntax | green | 0 | 0 | `node --check scripts/reliability-cockpit.js` |
| Preflight syntax | green | 0 | 0 | `node --check scripts/trust-preflight.js` |
| Source promotion packet syntax | green | 0 | 0 | `node --check scripts/source-promotion-packet.js` |
| Grafana verifier syntax | green | 0 | 0 | `node --check scripts/verify-grafana-otel-smoke.js` |
| Loaded MCP capture syntax | green | 0 | 0 | `node --check scripts/capture-loaded-mcp-probe.js` |
| Targeted cockpit tests | green | 0 | 0 | `node --test tests/capture-loaded-mcp-probe.test.js tests/reliability-cockpit.test.js tests/source-promotion-packet.test.js tests/verify-grafana-otel-smoke.test.js tests/trust-preflight.test.js` |
| Grafana missing-config proof | yellow | 2 | 0, 2 | `npm run observability:otel-smoke -- --skip-trigger --output reports/grafana-otel-smoke-missing-config-preflight.json` |
| Cockpit regenerate | green | 0 | 0 | `npm run reliability:cockpit` |
| Source promotion packet generate | yellow | 1 | 0, 1 | `npm run source:promotion-packet` |

## Trust Contracts

| Gate | Status | Current truth | Next action |
|---|---:|---|---|
| Primary checkout | yellow | dirty 67 / behind 53 on codex/w2-5-fx-manifest-source-custody | Separate user changes from cockpit work, then prove the intended launch source from clean current origin/main. |
| Tracked local-CI contract | red | 3 file(s) missing from HEAD; 0 file(s) missing from origin/main; 0 manifest lane command drift(s); 4 script contract issue(s); 3 untracked/current-only contract file(s) | Land or sync .firstbite/local-ci.json, package scripts, and referenced script files onto tracked source before trusting clean-lane proof. |
| Clean proof targetability | red | 3 clean-proof readiness issue(s); current lane count 4. | Land or sync the current manifest, package scripts, and cockpit scripts to tracked source, then rerun the clean worktree command. |
| Source promotion bundle | red | 13 current-only file(s); 19 modified tracked file(s); 0 missing current file(s); 13 file(s) absent from HEAD; 0 file(s) absent from origin/main; 4 command drift row(s) | Review this bundle, land the listed current-only and modified control-plane paths onto tracked source, then rerun clean worktree FirstBite proof. |
| FirstBite operating readout | yellow | FirstBite operating readout: 0/0 lane proof(s) pass, catalog repo-manifest-v2 has 34/34 declared lane(s), Moussey live_runtime_stale_source_contract_blocked; fresh_clone_ready=true, active_ready=true; M4 peer support-only. | Treat this as a fleet warning: inspect the failed lane(s), active manifest readiness, peer execution boundary, and Moussey status before broad launch claims. |
| M4 peer execution boundary | yellow | M4 peer is support-only: moussey_surface_ready_needs_m4_execute_report; fresh-clone packet codex-goal-20260610T-cycle131-m4-fresh-clone-runtime-request; execution_ready=false. | Run the generated fresh-clone commands on the M4 Pro and capture an M4-local run_lanes execute report before calling the peer execution-ready. |
| Selected local-CI proof | yellow | Manifest has 4 lane(s), but no MCP execute proof for resplit_currency_api was found locally. | Rerun all FX lanes from clean current source with commands matching .firstbite/local-ci.json. |
| Loaded MCP host catalog | red | Loaded MCP host catalog is missing current lanes for resplit_currency_api: repo missing; missing 4/4 expected lane(s). | Restart or reload Codex/Cursor MCP host, capture a fresh list_lanes artifact, and require all resplit_currency_api lanes. |
| Repo-backed MCP package | green | Repo-backed FirstBite MCP sees repo-manifest-v2 with 34 lane(s); resplit_currency_api has 4/4 expected lane(s). fresh_clone_ready=true, active_ready=true. | Treat this as the control-plane source until loaded host catches up. |
| OTEL/Grafana evidence | yellow | Worker observability config exists; JSON proof does not show both Tempo and Loki matches: reports/grafana-otel-smoke-missing-config-preflight.json. | After Cloudflare destinations exist, run npm run observability:otel-smoke with Grafana read env until Tempo and Loki both match. |
| Release-history strict coverage | yellow | Exact next slice: merge PR #7, then run `worktree=true` FirstBite proof from the landed tracked source. Keep loaded MCP restart, M4 peer execution, Grafana proof, and release-history as separate trust gates. | Backfill or age out the May 12-23 history gap; keep FX launch readiness yellow until strict validation passes. |
| Agent ledger health | red | 1 unrecovered failure row(s) found in the last 24h ledger window. | Resolve unrecovered ledger failure rows before using agent history as trust evidence. |

