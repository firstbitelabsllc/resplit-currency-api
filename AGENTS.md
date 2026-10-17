# resplit-currency-api

Daily FX rates (static package on Cloudflare Pages and GitHub Pages), a Cloudflare Worker (`worker/src`) serving rate endpoints and OCR routing, and Go services in `cmd/` and `internal/`. See README.md and RUNBOOK.md.

- `npm run check` generates, validates and runs the smoke tests in `tests/`.
- `.github/workflows/run.yml` publishes twice daily; do not break its script entry points in `scripts/`.
