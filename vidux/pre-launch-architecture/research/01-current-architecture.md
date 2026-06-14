# P1 — Current Architecture (grounded map)

All key claims verified: upstream is `open.er-api.com/v6/latest/EUR` (single source, 30s timeout, no fallback), route mount order is sideload → ocr → FX switch, `ASSET_BASE_URL` default hardcoded to `resplit-currency-api.pages.dev`, OCR cache key is `cache:${imageHash}` (global, not user-scoped), and bindings confirmed. I have everything needed to synthesize the document.

# Resplit Currency API — Current Architecture (Phase 1 Map)

*Synthesized from 8 subsystem maps. Every claim grounded in the maps + verified against the repo at `/Users/leokwan/Development/resplit-currency-api`. No proposals — facts only.*

---

## System overview

`resplit-currency-api` is a single Cloudflare Worker (`resplit-fx`, domain `fx.resplit.app`) that has accreted **three independent concerns** behind one deploy unit and one entry router (`worker/src/index.mjs`): (1) **FX rates** — the launch-critical original purpose, serving daily rates for 160+ fiat currencies from a git-committed snapshot archive published by a GitHub Actions cron; (2) **R2 photo sideload** (`/sideload/*`) — a single-user, Cloudflare-Access-gated receipt-photo store; (3) **OCR proxy** (`/ocr/*`) — a just-added, App-Attest-gated proxy that holds the Azure Document Intelligence key server-side and incurs real per-scan cost. The FX data path is **fully offline at request time**: the Worker never calls the upstream rate API — it fetches static JSON artifacts (`/latest/*`, `/archive-manifest.min.json`, `/archive-years/YYYY.min.json`) from Cloudflare Pages (`resplit-currency-api.pages.dev`, hardcoded default at `index.mjs:32`), computes cross-rates (EUR-base) in-Worker, and falls back to prior-day data. Observability is split: structured `console.*` logs (`[FX_MONITORING]`/`[OCR_MONITORING]`) flow via Cloudflare native OTEL into Grafana Cloud (Loki `grafana-logs-prod` + Tempo `grafana-traces-prod`, 10% prod sampling), and `@sentry/cloudflare` captures exceptions + a daily FX-canary check-in. There are **no custom metrics, no SLOs, no alerts, and no cost tracking** anywhere in the system today.

```
┌─────────────────────────── PUBLISH PATH (GitHub Actions cron, 00:00 + 03:00 UTC) ──────────────────────────┐
│                                                                                                            │
│   open.er-api.com ──30s, NO fallback──▶ currscript.js ──▶ snapshot-archive/*.json (363 files, 2.5M, GIT)   │
│   (FREE, no key, no SLA)                  │ saveSnapshot   │ committed → 365-day rolling, durable           │
│                                           │ prune(365d)    │                                                │
│                                           ▼                ▼                                                │
│                              promoteBuildOutput() ──▶ package/ {latest/, history/30d/, archive-years/,     │
│                              (atomic staging swap)        archive-manifest.json, meta.json}                 │
│                                           │                                                                 │
│         validate-package.js (gate) ──▶ node --test (195 tests) ──▶ wrangler deploy ×3                       │
│                                           │                                                                 │
└───────────────────────────────────────────┼────────────────────────────────────────────────────────────┘
                                            │ (publishes to)
        ┌───────────────────────────────────┼───────────────────────────────┐
        ▼                                   ▼                               ▼
  Cloudflare Pages                    Cloudflare Worker                GitHub Pages (fallback)
  resplit-currency-api.pages.dev      resplit-fx / fx.resplit.app      firstbitelabsllc.github.io
  (main / latest / YYYY-MM-DD)        ┌──────────────────────────┐     (gh-pages, force-push)
  = canonical ASSET source ───────────│ index.mjs router         │           │
        ▲  (Worker fetches from here) │  ├─ /sideload/*  ◀── R2  │     Vercel mirror (documented,
        │                             │  ├─ /ocr/*       ◀── KV  │     UNTESTED in CI)
        └─────────────────────────────│  └─ /quote /history      │     www/staging.resplit.app/api/fx/*
                                      │      /coverage /health   │           │
                                      │      /cron/fx-canary     │           │
                                      └────────┬──────┬──────────┘           │
                                               │      │                      │
                    ┌──────────────────────────┘      └──────────┐           │
                    ▼                                             ▼           ▼
              Azure Document Intelligence              ┌──── CLIENTS ───────────────┐
              (prebuilt-receipt, $/scan)               │ resplit-ios (fallback chain:│
                    │                                   │  fx.resplit.app → www →     │
              ATTEST_KV (App Attest + caps)             │  staging → Pages → ghPages) │
                                                        │ resplit-web /api/fx/*       │
                                                        └─────────────────────────────┘

  ┌─ OBSERVABILITY ──────────────────────────────────────────────────────────────────────┐
  │ console.[log/warn/error] → Cloudflare native OTEL → Grafana Loki (logs) + Tempo (traces)│
  │   head_sampling: 1.0 dev / 0.1 prod   |   Sentry: exceptions + FX-canary check-in        │
  │   tracesSampleRate: 0 (Sentry spans OFF)  |  NO metrics · NO SLOs · NO alerts · NO $-track │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌─ BESPOKE OPS SURFACE (read-only, local-only, ~9k LOC) ───────────────────────────────┐
  │ reliability-cockpit.js (4895 LOC) · trust-preflight · source-promotion-packet ·        │
  │ validate-package (strict/non-strict) · smoke-check-deploy · verify-grafana-otel-smoke  │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## The 3 concerns

| Dimension | **FX rates** (`/quote /history /coverage /health`) | **Sideload** (`/sideload/*`) | **OCR proxy** (`/ocr/*`) |
|---|---|---|---|
| **Traffic shape** | High, public, cacheable. `s-maxage=3600, swr=86400`. Read-only asset fetches from Pages CDN; cross-rate math in-Worker. 160+ currency pairs. | Very low. Single whitelisted user (`leojkwan@gmail.com`). Two-stage upload (init→bytes), list, get, delete, labels. No cache. | Low-but-growing, gated. POST per receipt photo. Azure async submit + poll (≤18×1.5s ≈ 27s). SHA256 idempotency cache (10min TTL). |
| **Cost model** | **Free upstream** (`open.er-api.com`, no key, no SLA). Cost = Cloudflare Pages/Worker/git storage only. Snapshot archive committed to git (2.5M / 363 files). | R2 storage (staging `resplit-sideload-staging` / prod `resplit-sideload-prod`). No per-user quota cap → unbounded storage cost possible. | **Real money per scan** (Azure DI billed on every cache-miss submit, even if poll later fails). Only defenses: per-device 200/day + IP soft-fail 20/day + SHA256 cache. No kill-switch. |
| **Auth** | None — fully public. | Cloudflare Access JWT validated at edge → `Cf-Access-Authenticated-User-Email` header → single-email whitelist (compile-time constant in `sideload/auth.mjs`) → SHA256 per-user R2 prefix. | App Attest: `/ocr/challenge` (KV, 5min TTL) → `/ocr/attest` (X.509 chain to Apple root via `@peculiar/x509`, once/device) → per-request ECDSA assertion verify, signCount monotonic. Cron canary uses `Bearer CRON_SECRET`. |
| **Blast radius if it breaks** | **App-wide.** Receipt parsing + currency conversion are critical path for resplit-ios/resplit-web. Pages CDN outage → all `/quote /history /coverage` return 502 (no geo-fallback in Worker code). | Photo upload/list/delete fail (502 `SIDELOAD_FAILED`). Buckets not even provisioned per evidence file → all `/sideload/*` non-functional today. Does not touch FX. | Receipt scan fails → app falls back to manual entry. Azure 429/quota-burn → all scans return `provider_error` silently. Cost runaway risk. Does not touch FX rates. |
| **Launch-criticality** | **P0 / launch-critical.** This is the product reason the repo exists. | **P3.** Opt-in single-user feature; bucket provisioning blocked on auth + Leo signoff. | **P1-emerging.** New, cost-bearing, must not ship without budget guard + observability. Not yet launch-blocking but the riskiest financially. |

**Critical coupling fact:** all three share **one Worker deploy, one Sentry DSN, one OTEL pipeline, and one `wrangler deploy` (all-or-nothing).** A deploy failure or a crash in OCR/sideload bring-up can take down FX serving with it (see Coupling map).

---

## Data flow

### FX publish path (end to end)

1. **GitHub Actions cron** fires at `0 0,3 * * *` UTC (`.github/workflows/run.yml`). Sentry cron check-in starts.
2. `node currscript.js`: `fetchLatestRates()` → `GET https://open.er-api.com/v6/latest/EUR` with a 30s timeout and **zero fallback** (`currscript.js:461–479`). On non-200/timeout/malformed → throws → `upstream_fetch_failure` Sentry issue → workflow exits 1, **no rates published**.
3. `saveSnapshotToArchive(date, rates)` → writes `snapshot-archive/YYYY-MM-DD.json` (EUR-base). **Local-first durability:** committed to git so it survives downstream deploy failure.
4. `pruneSnapshotArchive({retentionDays:365})` removes files older than 365 days (non-atomic loop, no rollback — unlike `promoteBuildOutput`).
5. `buildSnapshotWindow()` assembles the 30-day window: local archive read first; on miss, network-fallback to `https://{date}.resplit-currency-api.pages.dev/snapshots/base-rates.json` (the **previous run's dated branch** — circular dependency: today depends on yesterday's deploy existing). History <30d → non-fatal `history_window_shorter_than_30_days` warning, **publishes anyway** (the mechanism behind the May 12–23 hole).
6. `promoteBuildOutput()` builds into a temp staging dir, then **atomic swap** with backup/restore rollback → `package/` containing `latest/{code}.json`, `history/30d/{code}.json`, `archive/{date}.json`, `archive-years/{YYYY}.json`, `archive-manifest.json`, `meta.json`, `currencies.json`, `package.json` (version `YYYY.MM.DD`).
7. `git add snapshot-archive/` → commit → push. **Stale-run guard** detects concurrent pushes; on input-drift mismatch it exits 1 or skips deploy.
8. **Gate:** `validate-package.js` (≥100 currencies, exactly-30-day history, 365-day archive bounds, snapshot↔latest numeric parity ≤1e-8, `.min.json` parse). Non-strict warns on gaps; `STRICT_HISTORY_COVERAGE=1` blocks.
9. **Gate:** `node --test tests/*.test.js` (195 tests, all-or-nothing).
10. `wrangler pages deploy` × 3 branches (main / latest / dated) → `wrangler deploy` (Worker, syncs `SENTRY_DSN`, `SENTRY_RELEASE`, `CRON_SECRET`) → GitHub Pages force-push.
11. **Gate:** `smoke-check-deploy.js` fetches Pages + dated branch + GitHub Pages + Worker `/health /quote /history`; validates freshness (45-min `publish_grace` window), 30 history points, positive rates, allowed coverage signals.
12. Sentry cron check-in finishes (240-min margin to tolerate Actions' chronic 2h+ late dispatch).

### OCR request path (end to end)

1. **`GET /ocr/challenge`** → `issueChallenge()` → `KV put challenge:{uuid}` (5min TTL) → returns `{challenge}`.
2. **`POST /ocr/attest`** (once/install) → validate body → `KV get challenge:{challenge}` (TOCTOU window between get and delete, `router.mjs:92–94`) → `verifyAttestation()` (heavy X.509 chain to Apple root, nonce, authData via `attestation.mjs`) → `KV put attest:{keyId}` `{publicKeyB64, signCount:0}`.
3. **`POST /ocr/scan`** (per photo): `index.mjs:60` routes `/ocr/*` to `handleOcr` **before** the FX switch.
   - **Auth gate:** if `soft-fail` or missing keyId/assertion → IP-based cap (20/day, `cf-connecting-ip`, spoofable across NAT). Else `verifyAssertion()` (cheap ECDSA over `authenticatorData || SHA256(imageBytes)`) → `KV get attest:{keyId}` → verify sig + rpIdHash + signCount monotonic (non-atomic read-check-write race) → device cap 200/day.
   - **Idempotency:** `imageHash = SHA256(bytes)`; `cacheKey = cache:${imageHash}` (`router.mjs:133`, **global namespace — NOT user-scoped**, cross-user data-leak risk if two users scan identical bytes). HIT → return cached envelope.
   - **Azure forward:** `submitReceiptAnalyze()` → POST to Azure v4 `prebuilt-receipt` with `Ocp-Apim-Subscription-Key` → `Operation-Location`. Poll `getReceiptAnalyzeResult()` ≤18×1.5s. **Every submit is billable even if polling fails.**
   - **Response:** on `ok` + cacheKey → `KV put cache:{imageHash}` (10min TTL). Log `[OCR_MONITORING]` (signal/phase/status/attest/cache/azure_status/azure_ms/total_ms). Return `{v:1, mode:"raw", provider:"azure-di", scanId, status, raw}`. Unhandled → `captureFxRouteFailure` (Sentry, FX channel) + `logOcrMonitoringEvent('error')` → **double-logged** error + 502 `OCR_FAILED`.

---

## External dependencies + failure modes

| Dependency | What breaks | Blast radius | Current mitigation |
|---|---|---|---|
| **open.er-api.com** (free, no key, no SLA) | non-200 / 30s timeout / malformed JSON at cron time → `fetchLatestRates()` throws, no snapshot published (`currscript.js:461–479`) | **Total FX staleness.** Proven: May 12–23 6-day history hole. Snapshot archive stops advancing. | **None automated.** Git-committed archive keeps serving the *last good* day. Manual recovery: `audit:backfill-sources` + `backfill:history` + commit. INFRASTRUCTURE.md explicitly: "Live fallback: none configured today." |
| **Azure Document Intelligence** | service down / key expired-rotated / 429 / 507-quota → submit or poll fails | OCR scans fail (`provider_error`/`rate_limited`); app → manual entry. **Cost runaway** if quota-burned mid-billing-dispute. | Secret in wrangler. Per-device + IP caps + SHA256 cache. **No kill-switch, no exponential backoff, no key-expiry monitor, no $-alert.** 429 treated same as 5xx. |
| **Cloudflare** (Pages CDN / Worker / R2 / KV) | Pages edge fail → all `/quote /history /coverage` 502 (Worker has no in-code geo-fallback). Worker deploy fail → all 3 concerns affected. R2 down → sideload 502. KV down → OCR 503/502. | **FX = app-wide.** Single CF account + single API token deploys all of it (token compromise = wipe Pages+Worker+R2+KV). | Git archive durable; GitHub Pages + Vercel mirrors exist but **not Worker-integrated** and Vercel **untested in CI**. Worker fetches have **no timeout/circuit-breaker** (`fx-contract.mjs:138,229`). |
| **GitHub Actions** | runner unavailable / chronic 2h+ late dispatch / git push race | Daily publish doesn't run → rates stale until next cron. Single publication source, no backup region. | Stale-run guard; `workflow_dispatch` manual trigger; 240-min Sentry check-in margin (which **masks** real latency SLA). |
| **Grafana Cloud** (Loki + Tempo) | destination unreachable / token invalid / quota → logs+traces **silently dropped**, no Worker error, no retry | Observability blind spot. At 0.1 prod sampling, 90% already dropped by design. | None live. Manual `verify-grafana-otel-smoke.js` (read-only, 10s timeout, no retry → spurious preflight fails). |
| **Sentry** (`@sentry/cloudflare`) | DSN missing/invalid/rate-limited → `flush(2000)` best-effort, not awaited; exceptions lost on Worker shutdown | Lose exception context + canary uptime signal. `tracesSampleRate:0` → no Sentry spans regardless. DSN routing ambiguity: Worker uses `SENTRY_DSN`, publisher prefers `SENTRY_CURRENCY_API_DSN` → check-ins may land in wrong project. | `console.*` logs survive to Loki even if Sentry down. DSN-absent → monitoring silently disabled (`isFxMonitoringEnabled`). |

---

## Observability inventory

**Logged TODAY (Loki, via `console.*`):**
- FX: entry signals (`quote_entry`/`history_entry`/`coverage_entry`), success (`*_ok`), errors (`worker_route_exception`/`coverage_failure`), non-fatal coverage mismatches (`fx_integrity_warning`, log-only — no Sentry).
- OCR: `attest_register`/`attest_reject`/`scan`/`ocr_exception` with `azure_status`, `azure_ms`, `total_ms`, `cache` hit/miss, `attest` pass/soft_fail/reject, `client_version`, `scanId`.
- Sideload: `sideload_entry` only (success paths are **silent** — no log on upload/list/delete success).

**Traced TODAY (Tempo):** ambient Cloudflare request/response envelope spans only, 0.1 prod sampling. **No custom spans** — `tracesSampleRate:0` (`monitoring.mjs:41`) disables Sentry spans; OCR's attest→submit→poll flow has no parent/child nesting.

**Alerted TODAY:** exactly one signal — the **Sentry FX-canary cron check-in**. **Schedule mismatch:** code declares `0 13 * * *` (`monitoring.mjs:9`) but RUNBOOK says `0 0,3` and the canary isn't externally scheduled today, so the check-in config is effectively dormant. Canary covers only **3 hardcoded pairs × 4 dates = 12 checks**, while the API serves 160+ currencies; `ok` requires zero mismatches (single missed day fails it — no tolerance threshold).

**The gaps (what a solo maintainer is missing):**
- **Metrics: none.** No request-latency histograms per route, no error-rate counters, no cache hit/miss gauge, no archive-freshness gauge, no per-pair coverage tracking, no Azure-latency percentiles (only raw `azure_ms` field, unaggregated).
- **SLOs: none.** No defined target for "rates fresh by 03:00 UTC," publish success rate, FX uptime, or OCR success rate.
- **Alerts: none in Grafana.** No alert on log-volume drop (= destination down), coverage-mismatch threshold, OCR error-rate spike, Azure-latency, or canary failure firing into a channel.
- **Cost visibility: zero.** Azure is billed per scan; no scan-volume metric, no cost-per-scan, no budget alert. R2 has no per-user quota.
- **Dependency health: none.** No upstream (`open.er-api.com`) availability probe, no Pages-CDN latency metric. CDN failover is silent.

---

## Coupling & blast-radius map

| Failure origin | Takes down | Mechanism |
|---|---|---|
| **`wrangler deploy` fails / Worker crashes on boot** | **FX + Sideload + OCR simultaneously** | One Worker, all-or-nothing deploy (`.github/workflows/run.yml`). OCR/sideload bring-up bugs can crash the shared entry handler. |
| **Cloudflare Pages CDN outage** | **FX `/quote /history /coverage`** (app-wide) | Worker fetches all assets from `resplit-currency-api.pages.dev` (hardcoded default, `index.mjs:32`); no in-code geo/CDN fallback, no fetch timeout, no circuit-breaker (`fx-contract.mjs:138,229,306`). |
| **`open.er-api.com` down at cron** | **FX freshness for all clients** | Single upstream, no fallback. Archive serves last-good day; gap widens daily (May 12–23). |
| **Sentry outage or DSN misroute** | **Cross-concern exception visibility** | Single shared DSN across FX/OCR/sideload; OCR routes errors through FX's `captureFxRouteFailure` → tags entangled, can't filter by concern. |
| **Grafana destination unreachable** | **All log/trace visibility (silent)** | No Worker-side error on drop; 90% already dropped at 0.1 sampling. |
| **OCR Azure quota burn / runaway scans** | **OCR only** (cost, not FX) | Per-device/IP caps are passive (reject request), not a service kill-switch; no budget guard. Isolated from FX by path prefix. |
| **R2 unprovisioned / down** | **Sideload only** | Path-isolated; FX/OCR untouched. Buckets not yet created per evidence file. |
| **Single Cloudflare API token compromise** | **Pages + Worker + R2 + KV (everything)** | One `CLOUDFLARE_API_TOKEN` deploys + manages all secrets; manual rotation, no read-only deploy key. |

**Isolation that holds:** the three concerns are cleanly **path-prefix routed** and share no request-path state — a *runtime* fault in one (Azure down, R2 down) does not cascade to FX serving. The coupling is at the **deploy, auth-secret, observability, and CDN-fetch layers**, not the request logic.

---

## Ops surface assessment

**Bespoke tooling inventory (~9k LOC scripts + ~7k LOC tests, all read-only, all local-only):**

| Tool | LOC | Role |
|---|---|---|
| `reliability-cockpit.js` | 4895 | 151-function monolith. Inspects 11 "trust boundaries," renders HTML+JSON verdict (red/yellow/green). Hardcoded `~/Development/ai-leo/...` + `~/.agent-ledger/...` paths → **runs only on Leo's Mac, not CI-able.** |
| `trust-preflight.js` | 372 | Runs 9–13 preflight checks, regenerates cockpit, gates release. |
| `source-promotion-packet.js` | 1085 | Separates stage-candidates from hold-by-default; builds `git add` contract. |
| `smoke-check-deploy.js` | 384 | Post-deploy fetch-probe (Pages/dated/ghPages/Worker); 45-min `publish_grace` window (undocumented in RUNBOOK). |
| `verify-grafana-otel-smoke.js` | 613 | Read-only Grafana Tempo/Loki proof; yellow when env missing; no retry. |
| `validate-package.js` | 274 | Release gate, strict/non-strict split. |
| `audit-history-backfill-sources.js` + `backfill-history-snapshots.js` | 532+224 | Dry-run gap auditor + single-source backfill (manual recovery for incidents like May 12–23). |
| `capture-loaded-mcp-probe.js` | 258 | Captures live FirstBite MCP lane state; stale-cache, no auto-refresh. |

**Solo-dev maintainability verdict: NEGATIVE / high-debt.** This is a "Goldilocks failure" — not a full CI/CD platform, but **too intricate for a 20-minute sprint review.** Concrete blockers:
- A **4895-line single-function-orchestrated monolith** with 151 exports and minimal JSDoc; one boundary tweak means navigating the whole file. Test:impl asymmetry is extreme (cockpit 2449 test LOC vs smoke 366).
- **Hardcoded `os.homedir()` paths** make the cockpit machine-specific and un-CI-able — it cannot gate deploys automatically.
- **No continuous monitoring:** cockpit verdict can be RED and nobody knows until someone manually runs `npm run reliability:cockpit && open reports/...`. No alert on stale (60-min) proofs.
- **No retry/backoff/timeout** on the `execFileSync` git/npm/MCP probes — a hung MCP host hangs the cockpit indefinitely.
- **Three separate `60`-minute freshness constants**, date-range strings (`May 12-23`) baked into contract text that becomes stale once fixed.
- **Manual recovery loops** (backfill, M4 peer execution, MCP refresh) with no auto-retry — the operator must *infer* the fix from generic `nextAction` strings.

The bespoke surface is **larger and more demanding than the product Worker it guards** (Worker `src` ≈ 50KB across ~12 files; ops scripts ≈ 9k LOC). For a 1hr/week solo cadence this is the single biggest maintainability liability in the repo.

---

## The 10x question list (seeds for Phase 2)

1. **Monolith or split?** Keep one Worker for FX + sideload + OCR (shared deploy = shared blast radius, but one ops surface), or split OCR/sideload into separate Workers so a cost-bearing or experimental concern can't take down launch-critical FX on deploy? What does the all-or-nothing `wrangler deploy` actually cost in incident terms?
2. **Single free FX source vs paid/multi-source?** `open.er-api.com` (free, no SLA) caused the May 12–23 hole and has zero fallback. Is the answer a second free source with auto-failover, a paid primary with SLA, or a multi-source quorum? What's the dollar threshold where paid beats the operational cost of manual backfills?
3. **Git-committed snapshots — durable asset or scaling debt?** 363 files / 2.5M today, growing ~1 file/day, paid on every clone + `npm ci`. Durable and grep-able now; at 1000+ days does it become R2/LFS/external-store territory? Where's the crossover?
4. **What are the golden-signal metrics a solo maintainer actually needs?** Today: zero metrics. Define the minimal set — FX publish freshness (age of latest snapshot), per-route p50/p95 latency + error rate, OCR scan volume + Azure cost/day + cache-hit-rate, archive gap count — and the 3-4 alerts that page vs. the rest that dashboard.
5. **OCR cost-safety: what's the kill-switch + budget guard?** Every Azure submit is billable; caps are passive, 429==5xx, no budget alert, global (non-user-scoped) cache risks cross-user leaks. What's the proactive disable mechanism, the per-day $ ceiling, and the correct cache-key scope (`cache:{deviceKey}:{imageHash}`)?
6. **Canary: 3 pairs or representative coverage?** 12 checks for 160+ currencies, zero-tolerance `ok`, dormant schedule (code `0 13` vs RUNBOOK `0 0,3`, not externally triggered). What's the right pair-sampling strategy + mismatch tolerance, and should the canary actually be scheduled?
7. **Worker→Pages fetch resilience.** No timeout, no circuit-breaker, no geo-fallback in Worker code; Pages outage = app-wide FX 502. Does the Worker need an in-code fallback to GitHub Pages / Vercel mirror, request timeouts, and a retry budget — or is CDN durability enough?
8. **Observability: Grafana metrics + Sentry spans, or rationalize to one?** `tracesSampleRate:0` (no Sentry spans), 0.1 Loki sampling (90% logs dropped), silent destination failures, DSN routing ambiguity, OCR errors double-logged. What's the minimal coherent telemetry stack, and how does a solo dev detect "Grafana is dropping my logs"?
9. **The ~9k-LOC ops surface — keep, slim, or replace?** The reliability-cockpit is machine-locked, un-CI-able, larger than the product. Is the path: decompose into modules + make CI-ready, replace with standard tooling (real CI + Grafana alerts), or delete most of it and keep only `validate-package` + `smoke-check`? What's the launch-readiness gate that survives?
10. **PR-based CI: needed before launch?** Today there is **no PR gate** — code is only validated at cron time (late feedback, bad merges discovered next publish). Is a pre-merge `node --test` + lint gate the highest-leverage reliability add, given GH Actions cost concerns elsewhere in the fleet?
11. **Vercel + GitHub Pages fallbacks: real or theater?** Both are documented as the iOS fallback chain but **neither is validated in CI** and the Vercel mirror can silently drift. Are they load-bearing (then test them) or decorative (then drop them from the contract)?
12. **Pre-launch readiness definition.** What is the concrete, checkable GO gate for each concern — FX (archive complete + canary green + freshness alert live), OCR (budget guard + cache-scope fix + cost metric), sideload (buckets provisioned + per-user quota) — and which of the three are even in-scope for the 2.0 launch?

---

*Files cited (all under `/Users/leokwan/Development/resplit-currency-api/`): `worker/src/index.mjs` (router, `ASSET_BASE_URL` :32, route order :56–73), `worker/src/fx-contract.mjs` (cross-rate + asset fetch, no-timeout :138/:229/:306), `worker/src/fx-diagnostics.mjs`, `worker/src/fx-canary.mjs` (3 hardcoded pairs), `worker/src/monitoring.mjs` (`tracesSampleRate:0` :41, canary `0 13` :9), `worker/src/ocr/router.mjs` (global cache key :133, TOCTOU :92–94), `worker/src/ocr/{attest,attestation,azure,monitoring}.mjs`, `worker/src/sideload/{router,auth,cors}.mjs`, `currscript.js` (upstream :461–479, no fallback), `.github/workflows/run.yml`, `wrangler.jsonc` (OTEL :12–53, bindings :30–70), `scripts/reliability-cockpit.js` (4895 LOC), `scripts/{trust-preflight,source-promotion-packet,smoke-check-deploy,validate-package,verify-grafana-otel-smoke,audit-history-backfill-sources}.js`, `snapshot-archive/` (363 files / 2.5M verified), `INFRASTRUCTURE.md`, `RUNBOOK.md`.*