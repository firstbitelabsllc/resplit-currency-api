## PSA — 2026-04-19 ZERO-ASK POLICY (NEW DURABLE RULE)

NEVER ask for permission/opinion on operational work. State the call + execute in the same turn.

Forbidden phrasings: "Want me to...?", "Should I...?", "Would you rather...?", "Shall I proceed?", any A/B/C/D operational menu, any sentence ending in `?` whose answer would unblock execution.

Required shape: "I'm going to X next. Speak up if wrong — otherwise executing." Then execute.

Hard exceptions (only these pause): /auto Hard NEVERs — destructive git ops, force-push, real-money spend, external messaging, dropping prod tables.

IDLE is rarest status. Before reporting IDLE, exhaust: PLAN.md unblocked rows / INBOX.md / Sentry / open PRs / ai-repo skill drift / review-bot threads.

Refs: `~/.claude-leelam/CLAUDE.md` §Full Autonomy + `/vidux-leo` Section 2 ZERO-ASK reinforcement + `/auto` Section F new row. Leo verbatim: "NEVRE ask for my opinion state ur opinion about what ur GOING to do..."

---
# resplit-currency-api INBOX

> Drop zone for cross-agent findings / tasks. Agents read this at cycle start, promote items into commits or `[SKIP: reason]` them.

## Active items

- [ ] [2026-05-24] **P1 release-history risk: daily publish and Worker liveness are fresh again, but the May 12-23 history hole remains.** GitHub scout evidence: `gh -R firstbitelabsllc/resplit-currency-api run list --workflow 'Update Currency Rates' --limit 60` showed continuous failures through run `26354168265` (`2026-05-24T06:36:42Z`, head `68bbb436`). `gh run view 26350936742 --log-failed` showed generation reached `Snapshot window: 351 days (350 local, 0 network)` and wrote package files, then `validate-package` failed with `archive availableDates must contain at least 358 dates, got 351`. Root cause: validation blocked the daily snapshot commit before the workflow could recover from the May 12-23 publish hole; by May 24 the package has 351 dates and 14 archive gaps. Fix in this patch: `currscript.js` now writes `history/30d` from the real latest 30-calendar-day window instead of the last 30 available snapshots; `scripts/validate-package.js` has two explicit gates. `npm run validate` / `npm run check:publish` allow recovery publishes with warnings, while `STRICT_HISTORY_COVERAGE=1 npm run validate` / `npm run check` fail release readiness until full 30-day calendar coverage is restored. The smoke gate is also hardened: `npm run smoke:deploy` defaults to current UTC date, fails stale production, and warns through the known archive-only recovery signals (`history_range_incomplete`, `archive_gap_detected`) only when quote freshness is exact. Current proof: workflow run `26356586086` succeeded on head `3ec116c7977148829a7dea179885018a66e40081`, including `Deploy FX Worker` and `Smoke check deployed endpoints`; live `fx.resplit.app/health` GET/HEAD return 200/no-store/request-id and POST returns 405; live exact quote for `AED -> USD` on `2026-05-24` has no warning; `/coverage` reports `quoteResolvedLagDays=0`, `archiveLatestLagDays=0`, `availableDays=18/30`, `missingDayCount=12`; `node --test tests/validate-package.test.js tests/smoke-check-deploy.test.js tests/fx-worker-routes.test.js` passes 25/25; `npm run validate` warns but passes; `EXPECTED_DATE=2026-05-24 npm run smoke:deploy` passes with the explicit worker coverage warning; `npm run validate:release` still fails honestly at strict release validation until `2026-05-12`..`2026-05-23` are backfilled or age out. 2026-05-24 05:33 EDT follow-up added `npm run audit:backfill-sources` as a read-only backfill gate. Live `npm run audit:backfill-sources -- --from 2026-05-12 --to 2026-05-23 --timeout-ms 5000` exits `2`: no date has a complete single source; `resplit-dated-pages` is 404, `fawaz-currency-api` misses at least `clf,fok,kid`, `fxratesapi` misses `cnh,fok,kid,mru,sle,ssp,stn,tvd,ves,xcg,zwg`, Frankfurter is far too narrow, and even the union still misses `fok,kid` on most dates. Until strict release validation passes, `RESPLIT-WEB-2` / FX canary should stay yellow rather than closed.
  - 2026-05-26 22:06 EDT follow-up: local strict release-history is now repaired. Codex added `scripts/backfill-history-snapshots.js`, added `tests/backfill-history-snapshots.test.js`, wrote `snapshot-archive/2026-05-12.json`..`2026-05-23.json` from the complete `fxapi-pair-history` source, regenerated the package with `PUBLISH_DATE=2026-05-26 npm run generate`, and proved `npm run validate:release` green (`history points=30`, strict mode on). Full local proof also includes `npm run test` 208/208, `git diff --check`, and `EXPECTED_DATE=2026-05-26 npm run smoke:deploy`. Keep this row open until the backfilled/generated bundle is published/deployed: default `npm run smoke:deploy` still fails on current UTC freshness because Cloudflare latest date is `2026-05-26` and expected is `2026-05-27`.

- [ ] [2026-04-16] **Grafana Cloud observability on Cloudflare Workers — prove first-party export.** Leo provisioned Grafana Cloud free-tier stack 2026-04-16. Current direction follows Cloudflare Workers native Observability Pipelines rather than Worker-side OTel packages: destination secrets live in the Cloudflare dashboard, and `wrangler.jsonc` declares logs/traces destinations. 2026-05-24 status: `wrangler.jsonc` has `observability.logs.destinations = ["grafana-logs-prod"]` and `observability.traces.destinations = ["grafana-traces-prod"]`, with production sampling at `0.1`; the local reliability cockpit reads this as config-present but still yellow because there is no deployment/Grafana evidence artifact yet. **Deliverable**: after Cloudflare dashboard destinations exist and the Worker is deployed, capture a fresh smoke showing at least one request trace/log in Grafana Tempo/Loki and write the evidence to `docs/grafana-otel-smoke-YYYYMMDD.md`. **Non-goal**: replacing Sentry — `@sentry/cloudflare` stays for errors. **Blocker**: dashboard destination/token setup and a real Grafana/Cloudflare proof path, tracked in `/Users/leokwan/Development/vidux/projects/fleet-otel-observability/PLAN.md#F-C1`.

## Rules

- Items stay max 7 days. Oldest items archive to `docs/inbox-YYYY-MM-DD.md` if this file overflows 20 entries.
- Promotion = commit + checkmark with date.
- `[SKIP: reason]` is a valid end-state, kept for reference so future agents don't re-ask.

---

## [2026-04-18] Vidux 2.9.0 → 2.16.0 doctrine + tooling release — PSA from upstream

Vidux shipped 8 stacked releases over the last ~5 days. Review and update any lane prompts, CLAUDE.md files, and internal docs that reference old shapes. Most changes are additive; a few old phrasings are now prohibited.

**2.9.0 (shipped in #26)** — "Progress is code change" rule + autonomous-adaptive cuts:
- Metadata-only PRs prohibited (no `flip row to [completed]`, `reconcile Phase N`, `audit already-delivered`, or standalone `investigation closeout` PRs). If a cycle produces no code, it produces no PR.
- `observed` is now a first-class evidence type — user-observed behavior enters PLAN.md directly as `[Source: observed]`.
- `## Open Questions` and `## Surprises` are optional. Required sections dropped from 8 to 6.
- 3× stuck rule no longer requires a human — agent force-switches to next unblocked surface.
- Status FSM: `blocked` is terminal (no `blocked → pending` reverse transition).
- `[P]` parallel marker removed from queue order.
- Observer lane pattern deprecated.

**2.10.0 (#28)** — core/recipes structural split:
- `SKILL.md` now Part 1 discipline only. Part 2 (Automation) moved to `references/automation.md` with on-demand load.
- Cross-tool delegation deprecated. Mode A / Mode B recast as same-tool subagent dispatch via `Agent()`.
- Companion skills retired — single `/vidux` entry point (see commit `8c1f593`).

**2.11.0 (#28)** — `/vidux-status` command + AI-hour ETA convention:
- New `[ETA: Xh]` tag on `[pending]` + `[in_progress]` tasks. AI-hour calibration: 0.25h trivial / 0.5h simple fix / 1h small feature / 2h moderate / 4h e2e bug / 8h+ multi-phase.
- `/vidux-status` summarizes remaining AI-hours per plan.

**2.12.0 (#28)** — `[ETA: Xh]` mandatory + `[FREEFORM]` + `[METER]` cycle-end discipline:
- Adding a new `[pending]` task without `[ETA: Xh]` is now a plan defect.
- Cycle-end format for checkpoint/status replies: 1-3 sentence `[FREEFORM]` line + 20-cell `[METER]` bar (▓ filled / ░ empty). Skip both for casual chat.

**2.13.0 (#28)** — `ASK-LEO.md` durable question queue + tightened marker doctrine:
- One `ASK-LEO.md` per plan-store. Questions accumulate as `## Q<N> — <title>` with `Opened:`, `Status:`, `Lane:`, `Answer:` fields.
- Lane memory references rows (`[ASK-LEO Q1] ...`); never re-summarize the question.
- "No-noise rule" — skip memory entry when state is unchanged (absence = signal).

**2.14.0 (#28)** — `scripts/vidux-status.py`:
- Concrete implementation of `/vidux-status` — sums pending + in_progress ETAs per plan, renders `∅ AI-hrs` for missing ETAs.

**2.15.0 (#28)** — doctrine cleanup:
- L1/L2 nesting retired — nesting model is now just "compound task delegates to investigation file" (max two levels, no L3).
- Cross-tool delegation concept removed entirely (0 deprecation warnings — single user).
- `vidux.config.json` surfaced as first-class plan-store config (inline / local / external modes).

**2.16.0 (#28)** — docs audit cleanup:
- Mode A / Mode B → research / implementation dispatch rename (26 occurrences across 4 files).
- `vidux-auto.md` breadcrumb accuracy fix (Part 2 now correctly points at `guides/automation.md`).
- Stale `PLAN-docs-simplify.md` archived to `projects/docs-simplify/PLAN.md`.

**What this repo should do:**
1. Audit lane prompts (`~/.claude-automations/<lane>/prompt.md`) for prohibited phrasing — metadata-only-PR language, L1/L2, Mode A/Mode B, cross-tool delegation.
2. If any lane prompt says "investigation only — no code" or references the observer pattern, update to new phrasing.
3. If lane prompts reference `Mode A` / `Mode B`, migrate to "research dispatch" / "implementation dispatch" terminology.
4. Add `[ETA: Xh]` tags to existing `[pending]` + `[in_progress]` tasks in PLAN.md (non-breaking — missing ETAs render as `∅ AI-hrs`).
5. Adopt `ASK-LEO.md` if this repo has open questions accumulating in memory files.

Promote this entry to a `[pending]` task in PLAN.md if any action is needed, or mark `[SKIP: no changes required for this repo]` after audit.

Source: https://github.com/leojkwan/vidux/releases (2.9.0 through 2.16.0)
Broadcast by: vidux-ship-coordinator lane (final broadcast — lane retires after this cycle).
