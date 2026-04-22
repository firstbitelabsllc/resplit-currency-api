# Grafana Worker Trace Wiring — 2026-04-22

## Shipped slice

- Added `worker/src/otel.mjs` to normalize Grafana Cloud OTLP env vars and wrap the Worker with `@microlabs/otel-cf-workers`.
- Kept `@sentry/cloudflare` in place for error capture and check-ins; Grafana is additive trace export, not a replacement.
- Accepted both standard Grafana OTLP env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, optional `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and repo alias secrets (`OTEL_ENDPOINT`, `OTEL_AUTH_HEADER`).
- Documented the Wrangler secret names and Tempo query target: `service.name=resplit-currency-api-worker`.
- Added `worker/src/otel-verification.mjs` so `/coverage` can emit an opt-in verification span keyed by `x-request-id`.
- Added `scripts/verify-grafana-tempo.mjs` plus `npm run observability:tempo-smoke` so the repo can hit `/coverage` and poll Grafana Tempo for the exact verification span instead of relying on a manual Explore query.

## Verification completed in-repo

- `npm run check`
- `npm run smoke:deploy`
- `npm run observability:tempo-smoke -- --base-url http://127.0.0.1:8787` reached local `/coverage` with request id `210a0718-5cbd-4435-b3cd-e8853787cf87`, but Grafana returned `No Tempo traces found for service resplit-currency-api-worker within 90000ms`
- `node scripts/verify-grafana-tempo.mjs --base-url https://fx.resplit.app --skip-hit --since 24h --timeout-ms 1000` also returned `No Tempo traces found for service resplit-currency-api-worker within 1000ms`

## Current blocker

- The deterministic verifier is working, but Grafana still has zero `resplit-currency-api-worker` traces. That leaves one remaining gap: the Worker runtime is not exporting spans yet, either in local `wrangler dev` or in the deployed Worker.

## Exact next proof step

```bash
npx wrangler dev --local-protocol http --port 8787
npm run observability:tempo-smoke -- --base-url http://127.0.0.1:8787
```

If local `wrangler dev` still produces zero service traces, set or verify the Wrangler OTLP secrets on the deployed Worker, redeploy, and run:

```bash
npm run observability:tempo-smoke -- --base-url https://fx.resplit.app
```
