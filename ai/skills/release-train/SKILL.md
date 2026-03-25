---
name: release-train
description: Launch and publish readiness playbook for the resplit-currency-api pipeline and FX Worker.
---

# Release Train

This repo ships Resplit FX data in one train:

1. generate artifacts from `open.er-api.com`
2. commit `snapshot-archive/`
3. deploy Cloudflare Pages branches
4. deploy the canonical FX Worker
5. force-publish GitHub Pages fallback
6. smoke-check the live surfaces

## Launch Gates

Do not call this repo `GO` unless all of these are true for the current trunk state:

1. `npm run check` passes.
2. `npm run smoke:deploy` passes.
3. the latest GitHub Actions publish run is green.
4. Cloudflare Pages latest endpoint is live.
5. dated snapshot endpoint for today is live.
6. GitHub Pages fallback is live.
7. `https://fx.resplit.app` serves valid `quote` and `coverage` responses.

## Canonical Commands

```bash
npm ci
npm run check
npm run smoke:deploy
gh run list --repo firstbitelabsllc/resplit-currency-api --limit 5
gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api
```

## Nursing Rules

- Work trunk-first on `main`.
- Use `.cursor/plans/resplit-nurse.log.md` as the durable checkpoint log.
- If the repo is already green, do not fabricate a new board here; record the clean proof and point at the external launch blocker.
- If the workflow emits warnings about missing Worker secrets (`SENTRY_DSN`, `CRON_SECRET`), treat them as observability debt unless they break publish or smoke proof.
- Treat the recurring Cloudflare Pages `pages_build_output_dir` warning as expected until you intentionally migrate the Pages project into Wrangler-managed config. Do not add that key to `wrangler.jsonc` blindly; first run `npx wrangler pages download config resplit-currency-api`, review the generated Pages config, and only then decide whether to replace or split the current Worker config.

## Expected Non-Repo Blocker

As of the current launch posture, `resplit-currency-api` can be `GO` while overall Resplit 2.0 stays `NO-GO` because of unresolved `resplit-ios` / App Store feedback work. Keep that separation explicit in every nurse checkpoint.
