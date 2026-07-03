# `internal/` — REFERENCE DESIGN, NOT DEPLOYED

This Go tree is the scaffold for a **parallel GCP migration that is not live**
(see [`README-gcp.md`](../README-gcp.md)). It is kept as a design reference, not
as running production code.

## What actually runs in production

- **FX publish pipeline**: [`currscript.js`](../currscript.js), gated by
  [`scripts/validate-package.js`](../scripts/validate-package.js), deployed by
  [`.github/workflows/run.yml`](../.github/workflows/run.yml).
- **Read API**: the Cloudflare Worker under [`worker/src/`](../worker/src/),
  configured by [`wrangler.jsonc`](../wrangler.jsonc).

## Rules for agents and humans

- Do **not** extend this tree to add product behavior. New behavior lands in the
  JS pipeline or the Worker.
- This code is a **porting source**: e.g. the two-source quorum in
  [`internal/fx/quorum.go`](fx/quorum.go) / [`internal/fx/sources.go`](fx/sources.go)
  is being ported into the live JS pipeline, reusing its exact constants.
- It carries `TODO(gcp)` stubs that are intentionally unfinished. Do not "finish"
  them to make the migration real without an explicit decision to make GCP the
  canonical platform (currently: Cloudflare/JS is canonical).
- Deletion waits for a `/dead-code-sweep` pass with prove-unused receipts, since
  some exports here are consumed by tests.
