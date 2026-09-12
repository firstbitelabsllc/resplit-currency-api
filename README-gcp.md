# Resplit Currency API — GCP/Go Rewrite

> **⚠️ REFERENCE-ONLY for FX (2026-07-03).** Cloudflare/JS is the **canonical** FX
> read + publish stack; this Go/GCP rewrite is a **design/reference artifact** and
> is **not deployed for FX**. Its quorum math was ported to
> `scripts/lib/sources.js`. Do not extend `internal/fx/*` — change the JS port
> instead. See [docs/decisions/0001-fx-cloudflare-js-canonical.md](docs/decisions/0001-fx-cloudflare-js-canonical.md).
> (The manual, `workflow_dispatch`-only OCR/sideload Cloud Run deploy in
> `.github/workflows/deploy.yml` is a separate concern and out of scope for that
> FX decision.)

Clean-slate Go rewrite of `resplit-currency-api`, targeting Google Cloud. This
replaces the Cloudflare Worker + Pages topology with a **static-first spine plus
a blast-radius split**: the high-volume FX read path serves precomputed JSON
straight off a CDN with zero compute, while the two paths that *must* hold
secrets or device-attest state (OCR, sideload) live in small, independently
deployable Cloud Run services that can fail — or be killed — without taking FX
down.

The legacy Cloudflare `worker/` directory stays in this repo untouched. It runs
in parallel during migration (see [Parallel-Run Migration](#parallel-run-migration--kill-switch)),
and `fx.resplit.app` only repoints to GCP once the static spine is proven.

---

## Architecture Overview

### Static-first spine

The read path is the product's hot path: a 160-currency FX app hammering
`/latest/{code}.json` and history windows. **There is no Cloud Run on the FX read
path.** A daily publish job writes one precomputed JSON file per base currency to
a GCS bucket; Cloud CDN fronts the bucket; the client does cross-rate division
locally (`to/from` against a common base, exactly as the worker's
`computeCrossRate` does today). Compute cost on reads is therefore zero and the
read path has no growth ceiling — it scales like a static site because it *is* a
static site.

`/quote`, `/history`, and `/coverage` are thin convenience endpoints layered on
the same static artifacts (manifest + per-year archive payloads). They can be
served from the edge or from a tiny stateless Cloud Run shim; either way they
hold no secrets and carry no device state.

### Blast-radius split

Everything that needs a secret or per-device state is isolated so a compromise or
cost-spike in one path cannot touch the others:

| Path        | Surface          | Holds                                              | Blast radius if it falls over          |
|-------------|------------------|----------------------------------------------------|----------------------------------------|
| **FX read** | GCS + Cloud CDN  | nothing (public JSON)                              | none — static                          |
| **OCR**     | Cloud Run (`ocr`)| Azure DI key (Secret Manager), App Attest gate, Firestore state, budget kill-switch | OCR scanning only; FX + sideload unaffected |
| **Sideload**| Cloud Run (`sideload`) | V4 signed URLs, App Attest gate, GCS bucket  | photo sideload only                    |
| **Publish** | Scheduler → Pub/Sub → Cloud Run **Job** | 2-of-3 source quorum + freshness gate | stale rates at worst; reads keep serving last-good |

- **OCR** is the only secret-holder for the Azure Document Intelligence key. The
  key never leaves the service — it lives in Secret Manager and is read at boot.
  Every `/ocr/scan` is gated by an Apple **App Attest** assertion (per-request)
  after a once-per-device **attestation** at `/ocr/attest`. Firestore holds
  `attest_keys`, `ocr_idempotency` (keyed `deviceId:imageHash`), and `rate_caps`.
  A **budget kill-switch** hard-stops scanning when the OCR abuse path runs hot —
  this is the *only* hard kill-switch in the system.
- **Sideload** mints **V4 signed URLs** so bytes flow client ↔ GCS directly,
  never through the service. Same App Attest gate; its own GCS bucket.
- **Publish** runs on Cloud Scheduler → Pub/Sub → a Cloud Run **Job** (not a
  service). It pulls from three upstream rate sources, requires a **2-of-3
  quorum** agreeing within tolerance, and applies a **freshness gate** before
  promoting a new snapshot to the static bucket. A failed quorum leaves the
  last-good snapshot in place — reads never see a partial or stale-but-unflagged
  update.

### Spine services

- **Firestore** — durable state (attest keys, idempotency, rate caps).
- **Secret Manager** — Azure DI key and any future secrets. No JSON service-account keys anywhere.
- **Workload Identity Federation (WIF)** — Cloud Build and CI authenticate via
  WIF, not downloaded keys. The repo never contains a credential file.
- **Terraform** — all infra as code, **GCS state backend** (locked, versioned).
- **Cloud Build → Artifact Registry → Cloud Run** — build via WIF, push images to
  Artifact Registry, deploy to Cloud Run.
- **Observability** — Cloud Logging + Cloud Trace + Google Managed Prometheus,
  visualized in Grafana. Services emit structured `log/slog` JSON to stdout and
  OpenTelemetry spans via `go.opentelemetry.io/otel`.
