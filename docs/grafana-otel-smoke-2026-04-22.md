# Grafana Worker Trace Wiring — 2026-04-22

## Shipped slice

- Added `worker/src/otel.mjs` to normalize Grafana Cloud OTLP env vars and wrap the Worker with `@microlabs/otel-cf-workers`.
- Kept `@sentry/cloudflare` in place for error capture and check-ins; Grafana is additive trace export, not a replacement.
- Accepted both standard Grafana OTLP env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, optional `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and repo alias secrets (`OTEL_ENDPOINT`, `OTEL_AUTH_HEADER`).
- Documented the Wrangler secret names and Tempo query target: `service.name=resplit-currency-api-worker`.

## Verification completed in-repo

- `npm run check`
- `npm run smoke:deploy`

## Blocker for full Tempo proof

- No Grafana Cloud OTLP auth secret was available in this session, so direct end-to-end span proof in Tempo was not possible from the worktree alone.
- The Worker code path is dormant until the OTLP endpoint + auth secrets are set in Wrangler and the Worker is redeployed.

## Exact next proof step

```bash
npx wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT
npx wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
npx wrangler deploy
npm run smoke:deploy
```

Then in Grafana Cloud Explore / Traces, query:

```text
service.name = "resplit-currency-api-worker"
```
