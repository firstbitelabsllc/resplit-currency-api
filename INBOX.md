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

- [x] [2026-05-24] **P0 publish recovery: daily `Update Currency Rates` no longer fails on the May 12-23 archive hole.** GitHub scout evidence: `gh -R firstbitelabsllc/resplit-currency-api run list --workflow 'Update Currency Rates' --limit 60` showed continuous failures through run `26354168265` (`2026-05-24T06:36:42Z`, head `68bbb436`). `gh run view 26350936742 --log-failed` showed generation reached `Snapshot window: 351 days (350 local, 0 network)` and wrote package files, then `validate-package` failed with `archive availableDates must contain at least 358 dates, got 351`. Root cause: validation blocked the daily snapshot commit before the workflow could recover from the May 12-23 publish hole. Recovery commit `16f7d4e` landed to `main`; manual workflow run `26356044249` generated/committed the May 24 snapshot (`a3562d1`) and deployed Cloudflare Pages, FX Worker, and GitHub Pages, but exposed that deploy smoke was still treating archive-only recovery coverage signals as hard failures. Follow-up commit `3e16f54` landed the smoke-gate split: stale/latest/fallback/unknown-signal cases still fail, while current exact quotes with fresh latest data and only `history_range_incomplete` / `archive_gap_detected` warn during archive recovery. Manual workflow run `26356178180` completed successfully on 2026-05-24; plain `npm run smoke:deploy` now passes against production with an explicit warning: `availableDays=18/30`, `missingDayCount=12`, `signals=history_range_incomplete,archive_gap_detected`.

- [ ] [2026-05-24] **P1 release debt: archive recovery still has May 12-23 coverage gaps.** Publish is recovered, but `/coverage` still reports the known archive-only recovery gap for the latest 30-calendar-day window (`18/30` days available on 2026-05-24). Keep strict release validation/red history expectations until either May 12-23 snapshots are backfilled or those missing dates age out of the latest 30-day window. Do not relax stale/latest/fallback quote checks; the allowed deployed warning is only for current exact quotes with fresh latest data and the two known recovery signals.

- [ ] [2026-04-16] **Grafana Cloud observability on Cloudflare Workers — wire OTel export to Grafana Cloud.** Leo provisioned Grafana Cloud free-tier stack 2026-04-16. This Worker runs on Cloudflare (`wrangler` + `@sentry/cloudflare`); the canonical OTel export path is `@microlabs/otel-cf-workers` (Workers-specific since the Node OTel SDK doesn't run in the Workers runtime). **Scope**: (1) `npm i @microlabs/otel-cf-workers`, (2) wrap the fetch handler with `instrument(handler, config)` where `config.exporter` points at Grafana Cloud OTLP gateway, (3) `wrangler.toml` vars: `OTEL_ENDPOINT` + `OTEL_AUTH_HEADER` — stored as Wrangler secrets, never checked in, (4) Leo pastes the Grafana Cloud access-policy token + instance ID once stack is live. **Non-goal**: replacing Sentry — `@sentry/cloudflare` stays for errors. Grafana adds traces + latency histograms. **Deliverable**: draft PR with a local `wrangler dev` smoke showing at least one span reaching Grafana Cloud Tempo, or a `preview` deploy smoke. Evidence: `docs/grafana-otel-smoke-YYYYMMDD.md`. **Blocker if Leo hasn't pasted token**: open PR with secret placeholders, note in description.

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
