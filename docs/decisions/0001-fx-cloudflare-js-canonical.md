# ADR 0001 — Cloudflare/JS is canonical for FX; the Go/GCP tree is reference-only

- **Status:** Accepted
- **Date:** 2026-07-03
- **Scope:** the FX read + publish path (`fx.resplit.app`). Does **not** re-decide the OCR/sideload services (see "What this does NOT cover").

## Context

This repo carries two parallel implementations:

1. **Cloudflare/JS (live, canonical for FX)** — the Cloudflare Worker
   (`worker/src/index.mjs`) + Pages, fed by the Node publish pipeline
   (`currscript.js`, `scripts/`). This is what serves `fx.resplit.app/quote`
   today and what `run.yml` deploys.
2. **Go/GCP (design, reference-only for FX)** — `internal/` + `cmd/` (~6.7k LOC,
   17 `TODO(gcp)` stubs) describing a clean-slate GCP rewrite (static GCS+CDN
   spine, Cloud Run OCR/sideload, Pub/Sub publish Job). See `README-gcp.md`.

The 10x/hardening work needed a durable answer to "which one is the future?" so
that effort (and the multi-source quorum port) lands in one place instead of
drifting across both.

## Decision

**For the FX read + publish path, Cloudflare/JS is canonical.** The Go/GCP FX
code (`internal/fx/*`) is **reference-only**: its exact quorum constants and
semantics were **ported to JavaScript** (`scripts/lib/sources.js`, cross-checked
by comment against `internal/fx/quorum.go` / `sources.go` / `crossrate.go`) and
that JS port is the shipped implementation. We do **not** finish the GCP FX
migration.

We **keep** the Go tree in-repo as a reference/design artifact rather than
deleting it: it is the source of truth for the ported quorum math and the record
of the blast-radius-split design, and it backs the (separate, manual) OCR/sideload
Cloud Run deploy. Deleting it would destroy that provenance for no runtime gain.

## Prove-unused receipts (FX deployed path, 2026-07-03)

The Go tree is provably **not** part of the deployed FX system:

| Check | Command | Result |
|-------|---------|--------|
| No FX JS imports Go | `rg "require\(['\"].*(internal\|cmd)/" worker scripts currscript.js` | none |
| FX CI never builds/tests Go | `rg "go build\|go test\|setup-go" .github/workflows/run.yml` | none |
| `package.json` has no Go | `rg "go \|golang\|\.go" package.json` | none |
| Worker config ignores Go | `rg "internal\|cmd/\|golang" wrangler.jsonc` | none |
| Deploy entry is JS | `wrangler.jsonc` `"main"` | `worker/src/index.mjs` |

`go.mod`/`go.sum` exist but are not consumed by the FX publish/deploy pipeline
(`run.yml`). See also the quarantine banners in `internal/README.md` and
`cmd/README.md` (added in the Phase 1 canary PR).

## What this does NOT cover

`.github/workflows/deploy.yml` (**`workflow_dispatch` only**, manual) builds and
deploys the **OCR** and **sideload** Cloud Run services from the Go tree
(`Dockerfile.ocr` / `Dockerfile.sideload`, `cmd/ocr`, `cmd/sideload`,
`internal/azure`, `internal/attest`, `internal/sideload`, `internal/firestore`).
That path is a separate, secret-holding blast-radius split and is **out of scope**
for this FX decision — this ADR does not retire or bless it. It is not on the FX
automatic publish path and never touches `fx.resplit.app/quote`.

## Consequences

- New FX reliability/observability work targets the Cloudflare/JS stack only.
- `internal/fx/*` must not be extended; if the quorum math changes, change
  `scripts/lib/sources.js` and update the reference comments so the two cannot
  drift (a follow-up could delete `internal/fx/*` once no OCR/sideload code
  depends on it — today they are independent packages, so it is a safe future
  candidate, deferred to avoid churn).
- The Go/GCP tree stays as reference; revisit only if a deliberate migration off
  Cloudflare is chosen.

## Veto

One line reverts this: if GCP/Go should be the FX future, say so and this ADR is
superseded (finish the migration, repoint `fx.resplit.app`, retire the Worker).
