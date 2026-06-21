# P2 — GCP Target Architecture (chair synthesis)

I'm the chair. This is a decision deliverable, not a code task — I have full grounding from all 11 layer designs and 3 topology arguments. I'll synthesize and write the build-ready design directly. The decision is clear enough that I'll commit to it and back it with the tradeoff analysis the subplans need.

# Resplit FX → GCP: Target Architecture Decision (Chair's Verdict)

## Decision + rationale

**Verdict: Topology C (Static-first) as the spine, with the Topology B blast-radius split applied to the dynamic services. I'm calling this C+B — and rejecting A.**

Concretely: the launch-critical FX read path has **zero compute** (GCS + Cloud CDN serving precomputed per-`from` JSON), and the two genuinely-dynamic concerns (`ocr`, `sideload`) are **separate scale-to-zero Cloud Run services**, not folded into one container. The publish pipeline is a cold-path Cloud Run Job. State is Firestore. One Terraform repo, one Grafana pane.

**Why C as the spine.** The dominant fact across all 11 layer designs is that FX is ~99% of traffic, the data is tiny (~3 KB per-currency `*.min.json`, ~6 KB full snapshot, 363-file/2.5 MB archive), immutable-per-day, and identical for every reader. That is the textbook CDN-cacheable static workload. Putting *any* compute on that path — even Vision A's CDN-shielded `/quote` shim — is paying CPU to re-serialize a byte-identical blob millions of times. Topology C's move (precompute cross-rates at publish time into 160 per-`from` tables, client does one divide) means the launch-critical path **has no `google_cloud_run_*` resource on it at all**. There is no cold start, no min-instance bill, no concurrency to tune, no incident class on the read path. Static objects on a CDN don't page you.

**Why B's split for the dynamic services, not A's monolith.** Vision A's honest tax is that the Azure DI key + the abuse-exposed money path share a process with launch-critical FX, and an OCR deploy re-rolls the FX revision. Topology C already removes FX from compute entirely, so that specific coupling is moot — but the OCR/sideload split is still correct on its own terms: OCR holds a secret and spends real money (`concurrency=8`, `max=30` as a literal $/sec ceiling, `min=1` warm so cold-start crypto doesn't read as "App Attest broken"), while sideload is single-user scale-to-zero with a bucket-signer SA. These two want opposite settings and opposite secret surfaces. The cost of splitting them is one extra warm instance (~$15-20/mo) and one more Terraform module — bounded and known. The win is least-privilege IAM by construction: the FX path (a bucket) and the sideload path physically cannot read the Azure key.

**Why not A.** A's entire case is "lowest migration surface." But Topology C's migration is *also* low — the FX read path is already "static JSON behind a CDN," so swapping CF Pages/GH Pages/Vercel triple-mirror → one GCS bucket is the easiest piece, and the App Attest crypto core ports verbatim regardless of topology. A buys simplicity by accepting a shared-secret blast radius and a shared deploy unit; C+B gets *more* simplicity on the hot path (no service at all) for the same migration effort. A's "split later is mechanical" promise is real but it's a promise to do work; C+B just doesn't incur the coupling in the first place.

**Weighing the five axes:**

| Axis | How C+B wins |
|---|---|
| **Scale-to-millions** | Hot path is a CDN-cached static read — the cheapest scaling story possible. Origin sees thousands of req/day whether you serve 1M or 100M users. OCR is Azure-quota-bound (not Cloud Run-bound). The thing that scales is free to scale; the thing that costs (Azure) is gated. |
| **Solo-dev ops** | Read path has *zero* ops surface. On-call collapses to one question: "did the last publish write a fresh, quorum-verified snapshot?" Two warm instances total (ocr; FX has none). |
| **AI-driven-dev** | Hot path is *data, not code* — less running software for an agent to break. The contract is an OpenAPI spec + a documented GCS object shape; an agent can't break `/quote` at the serving layer because there's no handler to break, the answer is a file. |
| **Grafana learning** | Same golden-signal pipeline as any vision (GMP + Cloud Trace + Cloud Logging → one Grafana pane), and the static-first design forces the single most important learning artifact: a freshness dead-man's-switch alert. |
| **Migration effort** | FX read path is the easiest possible lift (static→static). No service-decomposition on the hot path. The hard crypto ports verbatim. Effort is *lower* than B (no `fx-api` service to build) and within a rounding of A. |

**The one tradeoff I'm accepting knowingly** (Topology C's stated biggest risk): a silent publish failure is *more* invisible when there's no always-on server whose absence you'd notice — exactly the May 12-23 failure class. The mitigation is non-negotiable and ships in the **first PR before any traffic**: `fx_snapshot_age_seconds` freshness metric + 26h dead-man's-switch alert + 2-of-3 source quorum + locked-down CDN cache-key policy. Static-first's gift (nothing to break) is its trap (no idle visibility); the freshness alert converts the trap back into the gift.

---

## Target architecture — ASCII diagram + GCP service for every box

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ PUBLISH PLANE (cold path, ~4×/day, user-count-independent)                    │
  │                                                                               │
  │  open.er-api.com ─┐                                                           │
  │  frankfurter/ECB ─┼─▶ Cloud Scheduler ─▶ Pub/Sub ─▶ Cloud Run JOB "fx-publish"│
  │  exchangerate.host┘   (cron 0,6,12,18)   (DLQ +     • fetch N sources ∥       │
  │  (3-source quorum)                        retry)    • 2-of-3 reconcile/median │
  │                                                     • freshness + coverage gate│
  │                                                     • PRECOMPUTE 160 per-from  │
  │                                                       /latest/<ccy>.min.json   │
  │                                                     • write immutable to GCS   │
  │                                          Secret Manager ◀── (paid src key, opt)│
  │                                          Firestore fx_sources ◀── trust/quorum  │
  └────────────────────────────────────┬──────────────────────────────────────────┘
                                        │ writes immutable dated objects
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  GCS bucket  gs://resplit-fx-artifacts   (versioned, lifecycle TTL)           │
  │   /latest/<ccy>.min.json   (~3 KB EUR-base per-from table)                    │
  │   /history/<ccy>/<window>.json   /coverage.json   /archive-manifest.json      │
  └────────────────────────────────────┬──────────────────────────────────────────┘
                                        │ origin (cache-fill only, ~0.1%)
                                        ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  Global External Application LB  +  Cloud CDN  (+ Cloud Armor, flag-gated)     │
  │  fx.resplit.app                                                                │
  └──┬──────────────────────────────────────┬─────────────────────┬────────────────┘
     │ /quote /history /latest /coverage     │ /ocr/*              │ /sideload/*
     │ /archive-*   → BACKEND BUCKET         │ (DYNAMIC)           │ (DYNAMIC)
     │ ZERO COMPUTE · ~99.9% edge hit         ▼                     ▼
     │ (client does one cross-rate divide) ┌──────────────────┐ ┌──────────────────┐
     │                                     │ Cloud Run "ocr"  │ │ Cloud Run         │
  ┌──▼─────────┐                           │ min=1 warm       │ │ "sideload"        │
  │  iOS app   │                           │ conc=8 max=30 CAP│ │ min=0 max=3       │
  │ (millions, │                           │ Azure DI key     │ │ V4 signed URLs    │
  │ App Attest)│──────photo bytes─────────▶│ (Secret Mgr,     │ │ (bytes go         │
  └────────────┘   client↔GCS direct       │  OCR SA only)    │ │  client↔GCS)      │
                   (signed URL)            │ App Attest gate  │ │ App Attest gate   │
                                           └───┬──────┬───────┘ └────┬──────────────┘
                                               │      │              │
       ┌───────────────────────────────────────┼──────┼──────────────┼──────────────┐
       │ SHARED DATA + IDENTITY PLANE           │      │              │              │
       │  ┌──────────────┐ ┌────────────────┐ ┌─▼──────▼──┐ ┌─────────▼──────────┐   │
       │  │ GCS photos   │ │ Secret Manager │ │ Firestore │ │ Workload Identity   │   │
       │  │ bucket       │ │ azure-di-key   │ │ attest_keys│ │ Federation          │   │
       │  │ (PAP enforced│ │ (ocr SA only)  │ │ ocr_idempot│ │ (no JSON keys;      │   │
       │  │  signed PUT) │ │                │ │  {dev}:{hash}│ │  per-svc SAs)      │   │
       │  └──────────────┘ └────────────────┘ │ rate_caps  │ └─────────────────────┘   │
       │                                      │ fx_nonces  │  TTL policies (24h sweep) │
       │                                      └────────────┘                           │
       └───────────────────────────────────────────────────────────────────────────────┘
                                        │ (all services + job)
            structured JSON logs → Cloud Logging │ OTLP → Cloud Trace │ OTel → GMP
                                        ▼
              ONE Grafana Cloud pane  (golden signals + cost row + SLO burn)
                                        ▲
              Terraform (one repo) ─── drives every box │ Cloud Build (WIF) ── ships it
```

**Service-per-box:** Compute = Cloud Run (services `ocr`, `sideload`; Job `fx-publish`). Edge = Global External Application LB + Cloud CDN + Cloud Armor (flag-gated). FX origin = GCS backend bucket. State = Firestore Native. Secrets = Secret Manager. Identity = Workload Identity Federation + per-service SAs. Schedule = Cloud Scheduler → Pub/Sub (with DLQ). Photos = GCS bucket (PAP enforced). Observability = Cloud Logging + Cloud Trace + Managed Service for Prometheus → Grafana Cloud. IaC = Terraform (GCS state backend). CI/CD = Cloud Build (GitHub-triggered via WIF) → Artifact Registry → Cloud Run.

---

## Per-concern landing

### FX — GCS + Cloud CDN, **zero compute on the read path**
- **Where:** GCS backend bucket behind the LB+CDN. The url-map points `/quote`, `/history`, `/latest`, `/coverage`, `/archive-*` at a `google_compute_backend_bucket`, **not** a serverless NEG.
- **Why:** rates are tiny, immutable-per-day, identical for every reader. Precompute **one artifact per `from` currency** (`/latest/<from>.min.json` — the exact `*.min.json` shape that already exists in `package/`), so a cross-rate `X→Y = rate[Y]/rate[X]` is the client doing one divide on a CDN-served file. That's **160 cache keys, not 25,600 N² objects** — EUR-base makes pairwise objects unnecessary. Compute-events drop from "per-request, millions of times" to "per-publish, 4 times" — a ~1,000,000× reduction.
- **MVP carve-out:** ship per-`from` tables only (client divides). Add a thin CDN-cached Cloud Run `/quote` shim *only* if a consumer genuinely needs a single server-side pre-divided number — and even then it runs on cache-miss only (~thousands/day, inside free tier).
- **Firestore:** none on the FX read path. `fx_nonces` (challenge nonces, transactional consume-once, 5-min TTL) is touched only if you gate `/quote` behind attest — keep FX read public + CDN-cached for launch; nonces are an OCR/attest concern.

### OCR — dedicated Cloud Run `ocr` service, the only secret-holder
- **Where:** Cloud Run service, `min=1` (warm — cold-start App Attest crypto reads as "attest broken"), `concurrency=8`, `max-instances=30` (literal Azure $/sec ceiling), `startup_cpu_boost=true`. Azure DI key from **Secret Manager**, mounted to the OCR SA *only*.
- **Firestore:** `attest_keys/{keyId}` (durable, no TTL), `ocr_idempotency/{deviceId}:{contentHash}` (TTL 24h — **the user-scoping fix**; the current global key is a cross-tenant cache-leak bug, closed by construction in the rebuild), `rate_caps/{deviceId}:{windowStart}` (per-device keyed to avoid the 1-write/sec hot-doc limit, atomic `FieldValue.increment`).
- **Wallet guard:** billing-budget → Pub/Sub → kill-switch Function flips `max-instances=0` on breach. Cloud Armor per-IP rate-ban on `/ocr/*` (flag-gated).
- **GCS:** none directly (Azure does OCR; results cached in Firestore as structured JSON, not the image blob).

### Sideload — dedicated Cloud Run `sideload` service, bytes skip compute
- **Where:** Cloud Run `min=0, max=3`. Mints **V4 signed URLs** via IAM Credentials `signBlob` (no JSON key on disk — signer SA impersonated by the runtime SA). App Attest gate (reuse the OCR verify), replacing CF Access.
- **GCS:** dedicated photos bucket, `public_access_prevention=enforced`, `uniform_bucket_level_access`, Autoclass on, lifecycle delete at ~400 days. **Size + content-type baked into the V4 signature** (`x-goog-content-length-range`) so GCS rejects bad PUTs before a byte lands. Photo bytes flow **client↔GCS directly** — never through Cloud Run.
- **Firestore:** one metadata doc per photo (`users/{uid}/photos/{ulid}`) for listing/dedup (never list-objects as a query layer).

---

## The "vibe code" operating model

The bet: **every operation an agent needs is a Terraform diff, an OpenAPI diff, or an MCP tool call.** No bespoke imperative script in the critical path.

- **Terraform (one repo), state in a versioned GCS backend bucket.** Largest LLM training corpus of any IaC tool → agents write correct HCL first-try. Repo shape: `openapi.yaml` (source of truth), `src/` (ocr + sideload handlers), `publish/` (fx-publish job), `mcp/` (live-API MCP server), `terraform/` (run, cdn, gateway, build, secrets, firestore, grafana, monitoring modules), `cloudbuild.preview.yaml` + `cloudbuild.deploy.yaml`. **Hard rule:** only `main`/Cloud Build runs `terraform apply`; laptops and PR builds run `plan` only (enforced by *not* granting write roles to the human ADC identity). State versioning + soft-delete ON so a bad apply is a rollback, not an outage. A nightly drift-detector `plan` posts to Grafana if prod drifts from code.
- **OpenAPI 3.1 = the contract for all routes.** Drives generated TS types, the API Gateway config (the spec *is* the gateway deploy), contract tests, and the MCP tool schemas. An agent extends the API by editing the spec + one service's handlers + a contract test; a handler that violates the spec fails the Cloud Build contract test — that's what stops an agent silently breaking `/quote`.
- **MCP server** wraps `gcloud run`, `gcloud logging read`, Cloud Trace, GCS object reads, and Firestore state (`get_last_run`, `get_source_health`, `query_metrics(promql)`, `tail_logs`, `trace.get`). An agent self-debugs "why did publish block on 5/19" in three tool calls — no SSH, no log spelunking.
- **Preview envs:** `gcloud run deploy --tag pr-N --no-traffic` gives a stable per-PR URL per dynamic service, scale-to-zero cheap; `terraform workspace` + a `fx-artifacts-preview-<sha>` bucket gives an isolated publish sandbox (run the job `--dry-run`, inspect would-publish objects, tear down). Each PR also gets its own named Firestore database for state isolation.
- **Structured JSON logs + W3C trace context** → an agent reads a failing request's `trace` field and walks the span tree (attest → Firestore → Azure) because each span is labeled. The ~208 `node --test` cases port directly; add contract tests + a golden-snapshot replay (feed a recorded source response, assert exact GCS objects produced).

**Who ships/operates it:** solo dev directs + reviews diffs; agents author Terraform/OpenAPI/handlers, open PRs, read their own `terraform plan` and preview URL in the PR comment, fix from structured traces, and merge when local gates + contract tests + review pass. On-call = read the Grafana SLO-burn alert → open the linked trace → agent ships a fix PR → merge.

---

## Observability → Grafana

**Golden-signal taxonomy** (the layer that does NOT exist today — current state has logs+traces but no numbers to alert on):

| Signal | Metric | Type | Labels (low-cardinality only) |
|---|---|---|---|
| Availability | `http_requests_total` | Counter | `route` (templated), `status_class` |
| Latency | `http_request_duration_seconds` | Histogram (≤10 buckets / native) | `route` |
| **FX freshness** | `fx_snapshot_age_seconds` | Gauge | `base_currency` |
| FX coverage | `fx_quorum_coverage_pairs` | Gauge | — |
| OCR cost | `ocr_scan_cost_usd_total` | Counter | `outcome` |
| OCR abuse | `ocr_abuse_rejections_total` | Counter (log-based) | `reason` |
| Per-source health | `fx_source_available` / `fx_source_trust_score` | Gauge | `source` |
| Sideload | `sideload_sign_errors_total` | Counter | `reason` |

**Pipeline:** OTel SDK in each container → OTLP straight to `telemetry.googleapis.com` (no sidecar) → **Google Managed Service for Prometheus** (PromQL — the portable, Snap-relevant skill) + **Cloud Trace** + **Cloud Logging**. All three federate into **one Grafana Cloud pane** via the GCP datasources, auth'd by a read-only SA over Workload Identity Federation (keyless). Phase 4 builds the panels; this hands it the metric names + datasources.

**The cardinality rule that prevents a silent bill detonation:** never put `device_hash`, raw URL, or currency-pair on a metric label — per-device abuse lives in log-based metrics / Firestore counters; only a low-cardinality `ocr_abuse_rejections_total{reason}` crosses into GMP. Route labels are templated (`/quote`, never the querystring). Set a GMP samples/sec budget alert on day one.

**Alerts that ship with the first PR:** (1) `fx_snapshot_age_seconds > 26h` dead-man's-switch — fires on *absence* of publish, the only signal that catches a silent upstream death; (2) FX `/quote` SLO fast-burn (14.4× = 2% of 28-day budget in 1h); (3) `cdn_cache_hit_ratio < 95%` — the cache-key cost-bomb canary; (4) OCR daily-spend budget → kill-switch; (5) Pub/Sub DLQ depth > 0.

---

## What gets DELETED

**~8,000 of the 8,996 LOC in `scripts/` die.** The bespoke ops surface exists *because there was no managed control plane* — GCP provides it.

| File | LOC | Verdict | Replaced by |
|---|---|---|---|
| `reliability-cockpit.js` | 4895 | 🗑️ DELETE | Cloud Monitoring SLO + uptime check + Grafana pane |
| `source-promotion-packet.js` | 1085 | ✂️ Delete HTML packet; **preserve ~200 LOC decision logic** | FX promotion = 2-of-3 quorum + trust-score state in Firestore `fx_sources`, inside the publish Job |
| `verify-grafana-otel-smoke.js` | 613 | 🗑️ DELETE | Native Cloud Logging→Grafana; uptime check proves the pipe |
| `audit-history-backfill-sources.js` | 532 | ⚠️ Mostly delete; **preserve backfill-gap detection** | Log-based freshness metric + archive-coverage check in publisher |
| `smoke-check-deploy.js` | 384 | 🗑️ DELETE | Cloud Build post-deploy smoke step vs preview URL |
| `trust-preflight.js` | 372 | 🗑️ DELETE | `terraform plan` gate + Cloud Build |
| `validate-package.js` | 274 | 🗑️ DELETE | Artifact Registry provenance + Cloud Build contract tests |
| probes + sentry helpers | ~620 | 🗑️ DELETE | Cloud Trace + Cloud Logging native; Sentry stays for app exceptions only |
| ops-tooling `*.test.js` | (22 files) | 🗑️ Delete ops tests; **keep FX-math + promotion-decision tests** | — |

**Preserved (~800–1,000 LOC, relocated):** FX source-promotion *decision* logic (the `accept-current`/`reject` trust ledger — no managed service knows your FX rules), backfill-gap detection, cross-rate math, App Attest verify (ports verbatim), the ~208 domain tests worth keeping. The 363-file archive stays as durable source-of-truth — now **one GCS origin**, not triple-mirrored to CF Pages + GH Pages + Vercel (most of the deleted LOC existed to reconcile git-state across those 3 mirrors, a problem one GCS bucket doesn't have).

---

## Migration path (Cloudflare → GCP, ordered, de-risked)

Pre-2.0 = clean rebuild, **no live data migration** (archive just gets republished to GCS).

1. **Stand up the IaC + identity spine first.** Terraform repo + GCS state backend (versioned, soft-delete), WIF pool/provider locked to the repo OIDC claim, per-service SAs, Artifact Registry, Cloud Build triggers. Get the security-sensitive WIF wiring right before anything serves traffic.
2. **FX read path (easiest, do it early).** Publish the precomputed per-`from` `*.min.json` + archive to `gs://resplit-fx-artifacts`; stand up LB + backend bucket + Cloud CDN with locked cache-key policy (path + allowlisted `rate_version` only). **Keep the existing GH Actions cron writing to GCS** at this stage — don't move the cron yet. **Wire the `fx_snapshot_age_seconds` freshness alert in this same step, before traffic.**
3. **OCR + sideload services.** App Attest verify ports verbatim; `wrangler secret` → Secret Manager (OCR SA only); `ATTEST_KV` → Firestore (fixing the global-idempotency bug in the move); R2 → GCS signed URLs; CF Access → App Attest. Deploy direct on `*.run.app` URLs first (App Attest + Firestore rate-cap is the abuse control); the LB path-rules for `/ocr/*` `/sideload/*` come with the LB.
4. **Publish pipeline last.** Move the FX cron GH Actions → Cloud Scheduler → Pub/Sub → Cloud Run Job, and add the net-new **2-of-3 source quorum + freshness gate** (~300 LOC — the whole point; kills the May 12-23 SPOF). Migrate `fx_sources` trust state to Firestore.
5. **DNS cutover with a client fallback chain.** Point `fx.resplit.app` at the GCP LB. **Parallel-run:** keep the Cloudflare Worker live and have the iOS client try GCP first, fall back to the CF URL on failure, for one release cycle. **Kill-switch:** a remote-config flag (or DNS revert) flips the client back to Cloudflare instantly if GCP misbehaves. Only after a clean parallel-run window do you decommission the Worker.
6. **Delete the 9k-LOC ops surface** as each managed replacement lands — not as a separate "cleanup PR," but in the PR that ships the replacement.

---

## Cost model

**MVP (~50k reads/day, single OCR user): ~$23–25/mo**, dominated by the LB forwarding-rule floor.

| Item | $/mo |
|---|---|
| GCS storage (artifacts + archive, <100 MB) | ~$0.01 |
| Cloud CDN (egress few GB + ~1.5M lookups) | ~$1.50 |
| Cloud Run (ocr `min=1` warm; sideload + publish scale-to-zero) | ~$3–6 |
| Firestore / Secret Mgr / Scheduler / Pub/Sub / Logging / Trace | ~$0 (free tiers) |
| **LB forwarding rule (fixed floor)** | **~$18** |
| Azure DI (single user) | ~$0–2 |

**MVP cost-cut (the cliff to know):** the **~$18 LB floor is the only non-scale-to-zero line and the death of "scale to zero" pre-revenue.** Ship MVP without the LB — serve FX from a CDN-fronted public bucket and hit `ocr`/`sideload` on `*.run.app` URLs directly; App Attest + Firestore rate-cap is the abuse control. Put the LB + Cloud Armor behind `var.enable_lb` and flip it on at App Store launch. Drops the floor toward ~$5/mo.

**At millions (~150M reads/mo, ~200k OCR scans/mo): ~$170–230/mo GCP-side.**

| Item | $/mo | Note |
|---|---|---|
| Cloud CDN egress (~450 GB) | ~$36 | tiny payload |
| **Cloud CDN cache-lookups (150M/10k)** | **~$112** | **the dominant GCP line — per-lookup fees, not egress** |
| Cloud Run (ocr ~$20 + sideload + publish; **FX path = $0**) | ~$25 | CDN shields it |
| Firestore (attest/idempot/ratecap) | ~$10–30 | per-op, sharded |
| Cloud Logging (down-sampled) | ~$5–20 | exclusion filter mandatory |
| GCS + LB + Monitoring | ~$20 | |
| **Azure DI (200k scans)** | **~$2,000** | not GCP, not topology-dependent — the real cost center, gated by attest + cap + kill-switch |

**Cost cliffs called out:** (1) **Cloud Logging ingest** — full-payload request logging at millions/day silently crosses the 50 GiB free tier into 4-figure territory with no error. The `drop-2xx-request-logs` exclusion filter **must ship in the first Terraform apply, before traffic.** (2) **CDN cache-key** — a buggy client `?_=<uuid>` collapses the hit ratio and turns the free CDN path into a per-request origin bill; lock the cache key to path + `rate_version` day-one (the `<95%` hit-ratio alert is the canary). (3) **GMP cardinality** — `device_hash` on a metric label = millions of series = detonated bill; per-device abuse stays in logs/Firestore. (4) **Azure OCR** is the true dominant cost at scale and lives outside GCP — bounded only by attest-gating + rate-cap + the budget kill-switch, identical across all topologies.

**Topology does not move the GCP cost needle** — C+B is within ~$50/mo of A at both MVP and millions. That's a reason to pick the topology that's safest and most legible, not the one that's nominally cheapest.

---

## Open decisions for Leo (genuinely need your call)

1. **GCP project + billing account.** New dedicated project (e.g. `resplit-fx-prod`) vs reuse the shared GCP project the Gmail/Calendar MCPs already point at? I'd default to a **new dedicated project** for clean IAM/billing isolation and a clean BigQuery billing export — but the billing account to attach is yours to name. *(Hard exception: cost commitment.)*
2. **Monthly budget ceiling.** I'm defaulting the `google_billing_budget` to **$200/mo** with 50/90/100% Pub/Sub alerts + the OCR kill-switch at 100%. Confirm or set your real ceiling — this is the number the automated wallet-defense flips `max-instances=0` against. *(Hard exception: cost commitment.)*
3. **Domain.** Keep `fx.resplit.app` (means a managed-SSL cert on the GCP LB + the DNS cutover in step 5), or stand up a parallel `fx-gcp.resplit.app` for the parallel-run window then swap? I'd default to **parallel hostname for the cutover, then repoint `fx.resplit.app`** so the kill-switch is a clean DNS revert. *(Hard exception: brand/domain.)*
4. **Paid FX fallback source (S3 in the quorum).** The 2-of-3 quorum needs a third source; two free ones (open.er-api + frankfurter/ECB) + one keyed source. Ship MVP on **two free sources + quorum-of-2**, or pay ~$12/mo now for a keyed S3 (openexchangerates / exchangerate.host) for true 2-of-3 insurance? I'd default to **two-free-at-MVP, add the paid key before millions** — but it's a small real-dollar line that's yours to greenlight. *(Hard exception: cost commitment.)*

Everything else (Cloud Run sizing, concurrency, TTLs, Firestore key shapes, CDN policy, Terraform module layout, the migration order) is decided above and ready for subplans to be written against.