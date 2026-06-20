# resplit-currency-api — GCP Revamp & Scale-to-Millions Plan

> Opened 2026-05-30 (Leo /goal, refined 3×): "focus on currency api and the move to
> gcp and all the work to revamping currency api to support vibe-code AI-driven
> development as a one person dev shop that plans to scale to millions of users" +
> "move us from wrangler if possible we haven't launched 2.0 so there is no loss in
> moving" + "something i can use with GCP as well as Grafana (my Snap work stack —
> dev velocity on learning outside work)." Master plan; subplans → `subplans/`,
> research → `research/`. Skills: /vidux, /pilot-leo, /auto.

## Progress

- 2026-06-20: Studio installed a local-only Eve cockpit on clean branch
  `codex/eve-studio-resplit-currency-api-20260620` from `origin/main@5947eafb`.
  Added `agent/`, Eve wrapper skills, read-only `fx-readiness` subagent,
  `npm run eve:*` scripts, and `scripts/eve-capability-check.mjs`. Proof passed:
  `npm ci --dry-run`, `npm run eve:capabilities -- --json`,
  `npm run eve:info -- --json`, `npm run eve:build`, `node --check
  scripts/eve-capability-check.mjs`, `git diff --check`, `npm run check`
  (`248/248` tests), and `npm run smoke:deploy` (`2026-06-20`, 30 history
  points). Receipt:
  `vidux/pre-launch-architecture/evidence/2026-06-20-eve-studio-currency-receiver-receipt.md`.
  No Cloudflare/GCP deploy, infrastructure mutation, workflow dispatch,
  credential handling, model/API call, production publish, or remote-machine
  mutation happened.

## Purpose

**Migrate resplit-currency-api off Cloudflare Workers/Wrangler to a GCP-native
architecture** that is (1) **AI-driven-development-friendly** (a solo dev + AI agents
build/operate it — "vibe code"), (2) **scalable to millions of users**, (3)
**observable through Grafana**, and (4) **a GCP/Grafana learning vehicle** (Leo's Snap
work stack). Pre-2.0 = no migration loss, so this is a clean rebuild, not a careful
cutover. The three concerns (FX rates, R2 photo sideload, App Attest OCR proxy) get
re-homed on GCP primitives. **No Kubernetes** — Cloud Run is the unit (serverless
containers, scale-to-zero → millions, zero cluster ops for a solo dev). Output = the
target GCP architecture + migration path + AI-driven operating model + Grafana
observability, as a prioritized master plan + subplans.

## North-star properties

- **AI-driven dev ("vibe code"):** everything-as-code (Terraform IaC, OpenAPI
  contract, MCP server for the API), structured logs/traces an agent can read to
  self-debug, fast preview envs, a test harness agents extend. The codebase is
  optimized for an LLM to build against (per `feedback_llm_friendly_mcp_codebase`).
- **Scale to millions:** Cloud Run autoscaling + Cloud CDN for read-heavy FX;
  Firestore/serverless state; no single-box bottleneck; multi-source FX resilience.
- **Solo-dev ops:** managed > self-hosted; scale-to-zero economics; one Grafana pane.
- **GCP/Grafana learning:** prefer the GCP-native primitive that teaches the stack
  (Cloud Run, Cloud Scheduler, Pub/Sub, GCS, Firestore, Secret Manager, Cloud
  Monitoring/Managed-Prometheus → Grafana, Workload Identity, Cloud Build, Terraform).

## Evidence (current state, grounded 2026-05-30)

- One Worker `resplit-fx` (fx.resplit.app), ~2830 LOC, 3 concerns: `/quote /history
  /coverage /health` (FX), `/sideload/*` (R2 photo), `/ocr/*` (Azure proxy, new).
- FX data: open.er-api.com (FREE, no key, no SLA) → GitHub Actions cron 2×/day →
  `snapshot-archive/` (git-committed) → Cloudflare Pages + GitHub Pages fallback +
  Vercel mirror (www/staging.resplit.app/api/fx/*).
- Observability: Grafana Cloud (Loki `grafana-logs-prod` + Tempo
  `grafana-traces-prod` via Workers Observability) + Sentry (`@sentry/cloudflare`).
  KV `ATTEST_KV`. R2 `resplit-sideload-{staging,prod}`.
- Known pain: May 12-23 FX history hole (free source failed — backfilled); heavy
  bespoke ops tooling (reliability-cockpit, trust-preflight, source-promotion-packet,
  validate-package strict/non-strict, smoke-checks); Grafana proof needs deploy
  evidence (INBOX 2026-04-16 + `~/Development/vidux/projects/fleet-otel-observability`).
- The OCR proxy (PR resplit-currency-api #13) just landed App Attest + Azure key
  server-side + `[OCR_MONITORING]` → Grafana; proven E2E (real receipt, real Azure).

## Constraints (reframed 2026-05-30 per Leo)

- **Small-business MVP — scalable but NOT over-engineered.** "isn't going crazy but
  at least scalable." The target is the simplest architecture that (a) survives launch
  + reasonable growth and (b) a solo dev can run. Reject microservice sprawl AND
  reject "clever" bespoke tooling that only one person understands.
- **GCP is a first-class target — career/learning weighted.** Leo verbatim: "something
  i can use with GCP as well as Grafana (this is my work Snap stack so there is dev
  velocity on learning this stack outside of work)." This **explicitly overrides** the
  `/auto §A` default ("no GCP — too serious"): here GCP earns its place via
  work-stack skill transfer, not just tech merit. Design must seriously weigh a
  **GCP-native** path (Cloud Run, Pub/Sub, Cloud Scheduler, Cloud Storage, BigQuery,
  Cloud Monitoring, Workload Identity) and a **Cloudflare-edge + GCP-core hybrid**, not
  only Cloudflare-only. Bias toward the option that maximizes (product value × GCP
  learning value) at acceptable solo-dev ops cost.
- **Grafana over everything** — single pane of glass across whatever infra wins
  (Cloudflare + GCP both export to Grafana Cloud). Online metrics/dashboards/alerts
  are a hard requirement; this is also a Grafana-skill learning vehicle.
- **Solo dev** — one-person ops burden is the gating lens on every proposal.
- **Launch window** — FX is the launch-critical path; OCR + sideload must not
  threaten it (blast-radius discipline).
- **Cheap-ish** — free/near-free where it doesn't cost learning value; OCR (Azure per
  call) is the only hard real-money concern. GCP free tier + low-traffic MVP = small $.
- No new repo (reuse this one). Append work here, not sibling plans (/pilot-leo).

## Phase plan (workflow-driven; stay in the loop between phases)

- [completed] P1 — UNDERSTAND: grounded map of all subsystems. Key findings: single free FX source (no fallback/SLA — the May hole); ZERO custom metrics/SLOs/alerts/cost-tracking; ~9k LOC bespoke ops surface (reliability-cockpit 4895 LOC) = solo-dev debt; FX serves fully static (Pages JSON + in-worker cross-rates). → `research/01-current-architecture.md`
- [in_progress] P2 — GCP TARGET ARCHITECTURE: 11 layer designers (compute/Cloud Run, pipeline, FX-resilience, serving-at-scale, state/Firestore, OCR, sideload, observability→Grafana, IaC+AI-dev, security/identity, cost+ops-deletion) + 3 topologies (mono Cloud Run / per-concern split / static-first) → chair-synthesized target + migration path. [workflow currency-api-gcp-design] → `research/02-gcp-target-architecture.md`
- [pending] P3 — GRAFANA METRICS (GCP): golden-signal dashboards-as-code, alert rules, SLOs, cost/abuse panels via Cloud Monitoring/Managed-Prometheus → Grafana Cloud. → `research/03-grafana-metrics.md`
- [pending] P4 — MIGRATION & LAUNCH READINESS: ordered Cloudflare→GCP cutover (Terraform bootstrap, data move, client fallback, parallel-run, kill-switch) + pre-launch checklist + rollback. → `research/04-migration-launch.md`
- [pending] P5 — SYNTHESIZE: write the prioritized master plan + per-workstream subplans into `subplans/` (Terraform/IaC, FX-pipeline-on-GCP, OCR-on-Cloud-Run, observability, AI-dev-affordances, migration-cutover).

## DECIDED ARCHITECTURE (P2 chair verdict — Topology C+B "static-first spine + blast-radius split")

- **FX read path = ZERO compute.** GCS bucket `gs://resplit-fx-artifacts` (precomputed
  per-`from` `*.min.json`, 160 cache keys; client does one divide for cross-rates)
  behind Global LB + Cloud CDN. Nothing to crash, infinite scale, ~$0. *The launch-
  critical path has no Cloud Run on it.*
- **OCR = dedicated Cloud Run `ocr`** (min=1 warm, conc=8, max=30 as a literal Azure
  $/sec cap). The ONLY secret-holder (Azure key in Secret Manager, OCR SA only).
  Firestore: `attest_keys` / `ocr_idempotency {deviceId}:{hash}` (fixes today's GLOBAL
  cache-leak bug) / `rate_caps`. Billing-budget → Pub/Sub → kill-switch flips max=0.
- **Sideload = dedicated Cloud Run `sideload`** (min=0): mints V4 signed URLs, photo
  bytes go client↔GCS directly; App Attest gate replaces CF Access; R2 → GCS.
- **Publish = Cloud Scheduler → Pub/Sub (DLQ) → Cloud Run Job `fx-publish`** with the
  net-new **2-of-3 source quorum + freshness gate** (kills the May 12-23 SPOF).
- **Spine:** Firestore (state) · Secret Manager · Workload Identity Federation (no JSON
  keys) · Terraform (GCS state backend) · Cloud Build via WIF → Artifact Registry →
  Cloud Run · Cloud Logging + Cloud Trace + Managed Prometheus → ONE Grafana pane.
- **Delete ~8000 of 8996 LOC bespoke ops tooling** (reliability-cockpit 4895 → managed).
  Preserve ~800-1000 LOC: FX source-promotion decision logic, App Attest verify (ports
  verbatim), cross-rate math, ~208 domain tests.
- **Cost:** MVP ~$5/mo (no-LB variant; LB behind `var.enable_lb`, on at launch) → ~$23
  with LB. At millions ~$170-230/mo GCP (CDN cache-lookups dominate) + Azure OCR the
  real cost center (gated by attest+cap+kill-switch). Topology barely moves GCP cost.
- Full design: `research/02-gcp-target-architecture.md`. Cost cliffs to pre-empt in the
  FIRST terraform apply: Cloud Logging `drop-2xx` exclusion filter, CDN cache-key lock,
  GMP cardinality (no device_hash labels), the `fx_snapshot_age>26h` dead-man's-switch.

## RESOLVED DECISIONS (Leo, 2026-05-30)

1. **GCP project + billing** — NEW dedicated project (default name `resplit-fx-prod`),
   Leo's billing account. [Leo creates at bootstrap — interactive `gcloud` step.]
2. **Budget — NO CEILING.** Leo: "no ceiling." → budget **alerts** for visibility only
   (50/100/200% of a soft $200 reference, non-blocking). The ONLY hard kill-switch stays
   on the **OCR abuse path** (anomalous per-device/global OCR spend → flip ocr max=0),
   NOT on FX or overall growth. Growth is never throttled; abuse is.
3. **Domain — KEEP `fx.resplit.app`.** Repoint to the GCP LB (managed cert) via a
   parallel-run window (client tries GCP → falls back to Cloudflare for one release),
   kill-switch = DNS revert. Zero launch risk.
4. **LANGUAGE = Go, clean-slate rewrite with tests.** Leo: "if we need to rewrite any
   logic in go and basically build this ourselves with tests and clean slate, i support
   this too." → Rewrite in Go (not port the JS): Snap-transferable (career/learning =
   the stated goal), cheaper Cloud Run (fast cold start, low mem), cleaner App Attest
   crypto (Go `crypto/x509`+`crypto/ecdsa` stdlib replaces the @peculiar/x509 hack),
   and best fit for AI-driven dev (idiomatic Go + `go test` + strict compiler gate).
   Preserve LOGIC + the ~208 test CASES (re-expressed as Go table tests), not the JS.
5. **Paid FX 3rd source** — MVP on 2 free sources (open.er-api + ECB/frankfurter)
   quorum-of-2; add a ~$12/mo keyed source before millions.

## THE GCP-vs-CLOUDFLARE CALL (Leo asked "make a case")

On pure tech merit for this edge-static+light-compute workload, **Cloudflare Workers is
the better technical choice** (cheaper, no LB floor, edge-native, already deployed,
OCR works today). We move to GCP **because Leo's decision criterion is career/learning
— GCP+Grafana+Go is his Snap work stack with direct transfer value**, and this
pre-launch app is the ideal low-stakes vehicle to learn it for real. The move is
low-risk: FX is just static files, parallel-run + client fallback makes the cutover
reversible, `fx.resplit.app` is preserved. **If the goal were ever "cheapest reliable
FX API," the answer flips to stay-on-Cloudflare.** The learning ROI is the deciding factor.

## Tasks (subplans — each gets a file in subplans/)

- [pending] SP1 — IaC + identity spine: Terraform repo + GCS state backend (versioned,
  soft-delete) + WIF pool/provider + per-service SAs + Artifact Registry + Cloud Build.
- [pending] SP2 — FX read path: precompute per-`from` JSON → GCS; backend bucket + CDN +
  locked cache-key; `fx_snapshot_age_seconds` freshness alert BEFORE traffic.
- [pending] SP3 — OCR on Cloud Run: port App Attest verbatim; Secret Manager; Firestore
  state (fix global idempotency); budget kill-switch; `[OCR_MONITORING]` → metrics.
- [pending] SP4 — Sideload on Cloud Run: V4 signed URLs; GCS bucket (PAP enforced); App
  Attest gate; lifecycle TTL.
- [pending] SP5 — Publish pipeline: Scheduler → Pub/Sub → Cloud Run Job; 2-of-3 quorum +
  freshness gate; `fx_sources` trust state in Firestore.
- [pending] SP6 — Observability → Grafana: OTel + GMP + Cloud Trace/Logging; golden-signal
  metrics + dashboards-as-code + the 5 first-PR alerts.
- [pending] SP7 — vibe-code affordances: OpenAPI 3.1 (source of truth) + MCP server +
  preview envs + contract tests.
- [pending] SP8 — Migration cutover: parallel-run + client fallback chain + DNS + kill-
  switch; delete ops surface as each managed replacement lands.

## WHERE WE ACTUALLY ARE — "are we truly up on prod?" audit (2026-05-31)

**No — the GCP proxy is LIVE and healthy, but it serves ZERO real traffic. The
security hole the migration exists to close is still OPEN in the shipped app.**
Clarify first: **OCR is Azure Document Intelligence prebuilt-receipt — unchanged.**
GCP Cloud Run is ONLY a thin proxy that holds the Azure key server-side. We did
not, and will not, replace Azure. "OCR on GCP" was wrong shorthand for "the
Azure-key proxy is on GCP."

What shipped (proxy in isolation — verified):
- [completed] OCR proxy deployed to Cloud Run (`ocr-00011`), real Azure DI:
  WHITE HOUSE TAVERN / $119.14 / 6 items, 200 in 4.3s. [Source: curl]
- [completed] Firestore client implemented (was a stub) — attest replay guard
  persists; live round-trip integration test green. [Source: TestLiveFirestoreRoundTrip]
- [completed] Grafana telemetry LIVE + tested: ocr_scans_total + http histograms
  in Mimir, ocr traces in Tempo; token in Secret Manager; cpu-throttling off.
  [Source: grafanacloud-prom/tempo queries] — satisfies SP6 metrics/traces.
- [completed] FX read path proven from GCS+CDN (EUR.min.json @127ms) — SP2 read leg.

The gap between "proxy live" and "truly up on prod" (ordered, blocking-first):
- [completed] G1 — **Dirty main working tree ship-hazard resolved (2026-05-31).**
  Forensics (workflow g1-ship-hazard-forensics, 4 read-only investigators) found the
  production deploy path was ALREADY safe: deploy-watcher `resplit-deploy.sh:302-307`
  has a `repo_has_local_changes()` guard that skips deploy on a dirty tree ('dirty-
  checkout') and builds from clean committed HEAD (working AzureDIv4Provider). Real
  hazard was only a MANUAL dirty-tree `tuist build` (untracked ResplitFXScanProvider +
  Container wiring → fx.resplit.app/ocr 404). Fix: reverted the 2 pure-OCR tracked
  files (Container+Database.swift, OCRConfiguration.swift) to HEAD + moved 3 untracked
  OCR code files to `~/.ai-backup/resplit-ocr-g1-20260531/`. Verified: only those 5
  entries changed (87→82 dirty), all 32 other-chat WIP files byte-identical untouched,
  zero remaining ResplitFXScanProvider/AppAttestService refs. Work preserved in PR #802.
  [Source: git status before/after diff = empty; grep providers = 0 refs]
  NOTE: the tree stays dirty with 82 other-chat WIP entries → deploy-watcher still skips
  all deploys ('dirty-checkout') until those sessions commit/PR their work. Not G1's
  scope (forbidden to touch other chats' work); flagged for fleet coordination.
- [pending] G2 — **Rotate the leaked Azure key.** It shipped in the client binary
  (plist `SubscriptionKey` at tag v2.1.2) → compromised by definition. Rotate the
  Azure DI key, update Secret Manager, leave NO valid key in any client build.
  [Source: git show v2.1.2:ReceiptSplitter/OCRConfiguration.swift]
- [pending] G3 — **Wire rate-limit + hard kill-switch into handleScan.** Endpoint is
  public (`allUsers`) + soft-fail bypass + AllowRate/ReserveOCR called **0 times** =
  open wallet for Azure spend. This is SP3's "budget kill-switch" + the deferred
  soft-fail cap. Must land before any client points at the public endpoint.
  [Source: grep cmd/ocr/main.go = 0 rate calls; gcloud run get-iam-policy = allUsers]
- [pending] G4 — **Device-validate App Attest (TestFlight).** Attest is device-only
  (DCAppAttestService.isSupported=false on sim) → the attest→scan round-trip can only
  be proven on a real device build. Blocks confident merge of #802.
- [pending] G5 — **Merge iOS #802** (host-mismatch fix committed: both halves now
  share ResplitOCREndpoint.baseURL). Only after merge + a TestFlight build do real
  users hit GCP and the Azure key leaves the client. [Depends: G2, G3, G4]
- [pending] G6 — **Budget alert** — `billingbudgets.googleapis.com` not even enabled;
  no spend visibility if the public endpoint is abused. SP-budget partial. [Source: gcloud]
- [pending] G7 — **Decide FX read-path scope.** FX currency rates still served by
  Cloudflare (`fx.resplit.app/quote` alive; iOS FXRateProvider.swift:137 →
  fx.resplit.app). Decide: is launch OCR-key-only, or does FX cut over too (SP2/SP8)?
  This is the rest of "move off Wrangler" — currently only OCR notionally moved.

## Decision Log

- 2026-05-30 — Opened. P1 understand workflow launched (8 subsystem readers). The
  central 10x tension to resolve: the single Worker serves 3 concerns with very
  different traffic/cost/criticality — blast-radius on the launch-critical FX path
  is the architecture question. Plus: free single FX source (no SLA) vs resilience.
- 2026-05-30 — [DIRECTION] GCP override. Leo: build it so it can run on GCP +
  Grafana (his Snap work stack) for learning velocity, as a practical small-biz MVP
  (scalable, not over-engineered). This supersedes `/auto §A` "no GCP." Design phase
  (P3) must produce Cloudflare-only, GCP-native, AND hybrid options and weigh
  (product value × GCP/Grafana learning value × solo-dev ops cost). Captured here; a
  `/captain` `/auto` row update (GCP OK when work-stack-learning-justified) is a
  follow-up.
- 2026-05-31 — [DIRECTION] **OCR stays Azure DI prebuilt-receipt; GCP is ONLY the
  key-proxy.** Leo pushed back on "OCR on GCP" framing — correct. We never replace
  Azure's OCR; Cloud Run is a doorman that holds the Azure key server-side and
  forwards to Azure. All "OCR on GCP" language is wrong shorthand. Do not re-frame
  this as a GCP OCR engine.
- 2026-05-31 — [FINDING] **"Up on prod" was over-claimed.** The proxy is live and
  verified in isolation, but: (a) the shipped app (tag v2.1.2) still calls Azure
  directly with the key in a bundled plist; (b) the GCP proxy serves zero real
  traffic; (c) the client repoint is unmerged (draft #802 + uncommitted on main);
  (d) the public endpoint has no rate-limit/kill-switch wired; (e) the leaked key
  is still valid; (f) FX rates never left Cloudflare. Added ordered gaps G1–G7.
  Planning-only this session per Leo ("dont code"); blocking-first order is
  G1 (ship hazard) → G2 (key rotation) → G3 (rate-limit) before G5 (merge #802).

## Progress

- 2026-05-30 — Master plan created. Phase 1 (understand) in flight.
- 2026-05-30 — P1 understand + P2 GCP design complete (research/01, /02). Architecture
  decided (static-first spine + blast-radius split, Go, no K8s). OpenAPI contract drafted.
- 2026-05-30 — **Scaffold slice 1 shipped: PR #14** (`claude/gcp-go-rewrite-scaffold`).
  Go App Attest port (stdlib, 6 real-ECDSA tests green) + FX cross-rate + 2-of-3 quorum
  (May-outage fix, green) + OCR Cloud Run skeleton + Terraform spine (validate-clean) +
  bootstrap + OpenAPI. Verified: go build/test/vet =0, terraform validate = Success.
  Graphite triggered. Toolchain installed (go 1.26, terraform 1.15.5, gcloud 570).
  ONE Leo-gated step before deploy: run bootstrap/setup-gcp.sh (gcloud auth + project +
  billing). Next slices: SP1 wire Firestore/Secret/Azure impls, SP5 publish job, SP4
  sideload, SP6 Grafana dashboards-as-code, security/CI.
- 2026-05-31 — **GCP FOUNDATION LIVE + slice 2 shipped.** Bootstrap run: project
  `resplit-fx-prod` (#903653538868), billing linked, 17 APIs, TF state bucket, deployer
  SA + 15 roles, WIF (repo-locked) + GitHub secrets, gcloud+cloud-run MCPs connected.
  `terraform apply` = 15 added/0 destroyed: FX bucket + Cloud CDN + Firestore + Secret
  Manager all LIVE. **FX read path PROVEN: `EUR.min.json` served publicly from GCS @127ms.**
  Slice 2 (PR #14): fx-publish job (multi-source quorum), Firestore store, Azure DI
  provider, sideload service, OTel observability, Grafana dashboards-as-code + alerts,
  monitoring/publish-pipeline/budget terraform modules, keyless-WIF CI + Dockerfiles.
  Gates: go build/test/vet =0 (8 pkgs), terraform validate = Success.
  NEXT: build+push images → Artifact Registry → wire+apply cloudrun modules → deploy
  fx-publish Job + run it → flip enable_lb for fx.resplit.app cutover → wire iOS to GCP.
- 2026-05-31 (cont.) — **OCR proxy DEPLOYED + telemetry proven live.** Built+pushed
  ocr image (Cloud Build), deployed Cloud Run `ocr-00011`: real Azure DI extraction
  verified. Implemented the real Firestore client (replacing the ErrClientNotWired
  stub) — attest replay store now durable; proven via live integration test. Grafana
  telemetry LIVE: fixed FOUR silent-200-while-broken bugs — `%20`-encoded OTLP auth
  header, `--no-cpu-throttling` (frozen exporter goroutines), wiped
  OTEL_EXPORTER_OTLP_ENDPOINT, wiped AZURE_OCR_ENDPOINT (was serving the STUB
  provider). All five load-bearing settings codified in `bootstrap/deploy-ocr.sh`;
  Grafana token moved to Secret Manager; terraform cloudrun module got an explicit
  `cpu_idle` var. iOS PR #802: caught + fixed a ship-blocker — AppAttestService
  (fx.resplit.app) and ResplitFXScanProvider (GCP) defaulted to different hosts →
  every real-device scan would have been rejected (ErrUnknownKey); fixed via shared
  `ResplitOCREndpoint.baseURL` + regression test + investigation file.
- 2026-05-31 (audit) — Leo: "are we truly up on prod?" → **No.** Evidence-backed:
  shipped app still direct-Azure key-in-client; proxy zero traffic; #802 unmerged +
  uncommitted-on-main ship hazard (routes to fx.resplit.app/ocr = 404); public
  endpoint un-rate-limited; leaked key still valid; FX still on Cloudflare; budget
  API not enabled. Added G1–G7. Leo: plan only, no code. Next (when unblocked to
  code): G1 de-risk dirty tree → G2 rotate key → G3 rate-limit/kill-switch → G4
  device-validate attest → G5 merge #802 → G6 budget alert → G7 FX-scope decision.
- 2026-06-01 — **Fleet-tree confusion resolved; "deploy freeze" was a misdiagnosis.**
  Spent the session attributing the resplit-ios dirty working tree (82 uncommitted
  entries) and chasing a believed deploy freeze. TWO corrections via verify-before-act:
  (a) the "orphaned at-risk work" was an artifact of a **69-commit-stale local
  checkout** — diffs were against stale local HEAD (05-24), not origin/main (05-30);
  ~all of it was ALREADY MERGED to origin/main via the fleet's PRs. (b) Deploys were
  **never frozen** — the deploy-watcher builds from a DEDICATED clean checkout
  `~/Development/resplit-ios-deploy-clean` (LaunchAgent `DEPLOY_WATCHER_REPO` override),
  NOT the dirty agent tree; it shipped **build 2632** ~12h ago and is skipping only for
  below-threshold/nighttime. The agent tree's dirtiness never touched deploys.
  ACTIONS: refreshed the agent tree to origin/main (69-behind→current, 36 redundant
  stale files removed, 30 genuinely-new artifacts preserved, backed up 3×:
  `backup/main-wip-20260531{,-pre-refresh}` + tarballs). The only "genuinely-new" code
  was 2 STALE test drafts that fail against current source (UITestAppLauncherFalseGreen
  scans for tokens no longer present; CurrencyCountryDisambiguation diverges from merged
  #803) — NOT worth landing; preserved in `~/.ai-backup/`. NET: nothing orphaned, all
  fleet work shipped. **What's left for THIS plan is unchanged: G2–G7** (no code shipped
  to currency-api this session). Deploy-watcher self-heal improvement tracked separately
  in resplit-ios `release-train.plan.md`.
