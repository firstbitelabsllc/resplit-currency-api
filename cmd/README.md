# `cmd/` — REFERENCE DESIGN, NOT DEPLOYED

These Go entrypoints (`fx-publish`, `ocr`, `sideload`) belong to a **parallel
GCP migration that is not live** (see [`README-gcp.md`](../README-gcp.md)). They
are a design reference, not running production code.

## What actually runs in production

- **FX publish**: [`currscript.js`](../currscript.js) via
  [`.github/workflows/run.yml`](../.github/workflows/run.yml) — NOT
  [`cmd/fx-publish/main.go`](fx-publish/main.go).
- **Read API / OCR / sideload**: the Cloudflare Worker under
  [`worker/src/`](../worker/src/).

## Rules for agents and humans

- Do **not** extend this tree to add product behavior; that lands in the JS
  pipeline or the Worker.
- [`cmd/fx-publish/main.go`](fx-publish/main.go) is the **design reference** for
  the multi-source quorum being ported into the live JS pipeline.
- `TODO(gcp)` stubs are intentionally unfinished; do not complete them without an
  explicit decision to make GCP canonical (currently: Cloudflare/JS is canonical).
- Deletion waits for a `/dead-code-sweep` pass with prove-unused receipts.
