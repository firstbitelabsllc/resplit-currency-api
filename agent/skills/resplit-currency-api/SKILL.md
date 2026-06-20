---
description: Use for FX package, Worker smoke, source-custody, GCP migration, and nurse-log authority.
---

# Resplit Currency API

This repository powers the FX data package and Worker-facing currency surfaces.

Before meaningful changes, rehydrate:

- `RALPH.md`
- `.cursor/plans/resplit-nurse.log.md`
- `.github/workflows/run.yml`
- `RUNBOOK.md`
- `.agent-ledger/activity.jsonl`
- Git state
- `INBOX.md`
- `vidux/pre-launch-architecture/PLAN.md`

Safe default proof:

- `npm run generate`
- `npm run validate`
- `npm run validate:release`
- `npm run test`
- `npm run check`
- `npm run smoke:deploy`

Guardrails:

- Keep source-custody, snapshot archive, GCP migration, and Cloudflare Worker
  changes explicit in the plan before mutating them.
- Do not publish release artifacts or run live infrastructure changes from Eve.
- Prefer read-only smoke and package validation before any broader queue work.
