# Grafana Worker OTel Memory

[CYCLE] 2026-04-22 19:40 EDT | repo=resplit-currency-api | slice=OTel verification diagnostics on /coverage | verification=`node --test tests/fx-worker-otel.test.js tests/fx-tempo-verifier.test.js`; `npm run check`; `npm run smoke:deploy` | next=redeploy `vidux/grafana-worker-otel` and rerun `npm run observability:tempo-smoke -- --base-url https://fx.resplit.app` to read the new `x-resplit-otel-*` headers on a live build
