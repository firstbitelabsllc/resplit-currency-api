# R2 Sideload Prep — 2026-04-11

**Lane:** resplit-r2-sideload (Claude cron, director pattern)
**Cycle:** first production cycle
**Status:** BLOCKED on wrangler auth + Leo's R2 bucket creation authorization. All preparation work is complete and ready for execution.

---

## Blockers (ordered)

### B1 — Wrangler not authenticated locally

```
$ npx wrangler whoami
⛅️ wrangler 4.75.0 (update available 4.81.1)
─────────────────────────────────────────────
Getting User settings...
You are not authenticated. Please run `wrangler login`.
```

Per the fx skill: "npx wrangler whoami is the trust boundary — confirm auth before any change." No auth = no Task 1 (bucket creation), no Task 2.4 (dry-run validate), no real deploys.

**Fix:** `npx wrangler login` from Leo's terminal. Interactive OAuth flow — a cron agent cannot do this.

### B2 — R2 bucket creation is production-mutation and needs Leo's explicit signoff

Task 1 creates two durable R2 buckets in Leo's Cloudflare account:
- `resplit-sideload-staging` (with 14-day lifecycle deletion)
- `resplit-sideload-prod` (no lifecycle deletion)

These are reversible (`wrangler r2 bucket delete` exists) and low-cost (R2 free tier covers 10GB, starter buckets are empty), but they're production infrastructure in a shared account. Per the vidux principle "Executing actions with care": shared infrastructure + billing implications = needs explicit authorization, not cron discretion.

**Fix:** Leo says "yes, provision the buckets" (or runs Task 1 personally). Cron will run Task 2 onward automatically once auth is restored AND bucket creation is signed off.

### B3 — Wrangler CLI version is slightly behind

`4.75.0` → `4.81.1` available. Not a blocker but worth noting. The plan's "Cloudflare R2 Worker Binding API (fetched 2026-04-10)" used whatever was current then.

---

## Current `wrangler.jsonc` (12 lines, flat — no environments)

```jsonc
{
  "name": "resplit-fx",
  "main": "worker/src/index.mjs",
  "compatibility_date": "2026-03-17",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "upload_source_maps": true,
  "vars": {
    "ASSET_BASE_URL": "https://resplit-currency-api.pages.dev",
    "SENTRY_ENVIRONMENT": "production"
  }
}
```

## Proposed `wrangler.jsonc` (env-aware, top-level defaults preserved)

This is the Task 2 diff, ready to apply once blockers are resolved:

```jsonc
{
  "name": "resplit-fx",
  "main": "worker/src/index.mjs",
  "compatibility_date": "2026-03-17",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "upload_source_maps": true,
  "vars": {
    "ASSET_BASE_URL": "https://resplit-currency-api.pages.dev",
    "SENTRY_ENVIRONMENT": "production"
  },
  "env": {
    "staging": {
      "name": "resplit-fx-staging",
      "vars": {
        "ASSET_BASE_URL": "https://resplit-currency-api.pages.dev",
        "SENTRY_ENVIRONMENT": "staging"
      },
      "r2_buckets": [
        {
          "binding": "SIDELOAD_R2",
          "bucket_name": "resplit-sideload-staging"
        }
      ]
    },
    "production": {
      "name": "resplit-fx",
      "vars": {
        "ASSET_BASE_URL": "https://resplit-currency-api.pages.dev",
        "SENTRY_ENVIRONMENT": "production"
      },
      "r2_buckets": [
        {
          "binding": "SIDELOAD_R2",
          "bucket_name": "resplit-sideload-prod"
        }
      ]
    }
  }
}
```

**Design rationale:**

1. **Top-level config preserved unchanged.** A `wrangler deploy` (no `--env` flag) still works the same as today, hitting the existing `resplit-fx` worker. This is the safety-net: even if the env migration has a bug, the existing FX surface doesn't break.

2. **Staging environment creates a new worker at `resplit-fx-staging`.** This means existing traffic continues hitting `resplit-fx` (production) while staging runs on a separate sub-domain. No staging/production traffic mixing.

3. **Production environment keeps the worker name `resplit-fx`.** So `wrangler deploy --env production` hits the SAME worker as the current top-level config. This is crucial — the daily publish workflow in `.github/workflows/run.yml` uses `wrangler deploy` (no `--env`). If we want to migrate that to `--env production`, that's a separate change in Task 9.

4. **R2 bindings are per-environment.** `SIDELOAD_R2` in staging points to `resplit-sideload-staging`, in prod to `resplit-sideload-prod`. The code reads from `env.SIDELOAD_R2` in both environments; wrangler wires the right bucket at deploy time.

5. **FX routes unchanged.** Zero edits to `worker/src/index.mjs` in Task 2 — that's Task 3's job. Task 2 only touches `wrangler.jsonc`.

**Validation plan** (once auth + buckets exist):

```bash
# Task 2.4
cd /Users/leokwan/Development/resplit-currency-api
npx wrangler deploy --dry-run --env staging 2>&1 | tail -30
npx wrangler deploy --dry-run --env production 2>&1 | tail -30
# Both must show SIDELOAD_R2 binding attached and FX routes still compile.
```

---

## Handoff sequence

When Leo is back at the terminal (or the blockers are otherwise resolved):

1. `cd /Users/leokwan/Development/resplit-currency-api`
2. `npx wrangler login` → interactive OAuth (B1 fix)
3. `npx wrangler whoami` → confirm correct Cloudflare account (must be the one that owns `resplit-fx` worker + `fx.resplit.app`)
4. **Task 1 execution** (bucket creation — needs Leo's signoff):
   - `npx wrangler r2 bucket create resplit-sideload-staging`
   - `npx wrangler r2 bucket create resplit-sideload-prod`
   - `npx wrangler r2 bucket lifecycle add resplit-sideload-staging --rule 'id=auto-delete-14d,max_age=14d,status=enabled'` (exact CLI shape to be confirmed; Cloudflare docs 404'd a few times during plan research — worth double-checking against the current docs before running)
   - `npx wrangler r2 bucket list` → verify both buckets are listed
5. **Task 2 execution** (wrangler.jsonc edit — can be automated by cron once auth is up):
   - Apply the proposed `wrangler.jsonc` from this file
   - Run both dry-run commands
   - Commit as `feat: r2-sideload Task 2 — env-aware wrangler.jsonc with R2 bindings`
6. Tasks 3-9 follow per the PLAN.md task list.

---

## What this cycle DID accomplish

Nothing was committed to `wrangler.jsonc` or to the live Cloudflare account. This file is the entire cycle output — a 1-commit shippable evidence artifact that unblocks the next cron run completely.

**Specifically:**

- Confirmed wrangler CLI is installed (4.75.0).
- Confirmed resplit-currency-api repo is clean on main (0/0 vs origin).
- Read the current 12-line `wrangler.jsonc` and mapped every field that needs to migrate into env blocks.
- Drafted the Task 2 diff inline as a code block that can be copy-pasted directly.
- Identified the subtle top-level-vs-env-name issue (preserving top-level config means existing `wrangler deploy` still works).
- Documented the Task 1 CLI sequence with the lifecycle rule gotcha (Cloudflare docs 404'd during plan research, worth re-verifying).
- Hit the auth trust boundary cleanly — failed SAFE rather than attempting to bypass.

## Why the cycle stopped here

Per the vidux principle "Executing actions with care": actions with durable production impact AND shared-system blast radius require explicit authorization. Two failure modes were in play:

- **Silent auth flow attempt.** Running `wrangler login` from a cron requires stdin interaction; it would hang forever on a background process.
- **Bucket creation without signoff.** Creating Cloudflare R2 buckets in Leo's account without his explicit "yes, provision" is beyond the cron's authority per standing rule.

Both failure modes are correctly caught by stopping at Task 1.1 (`wrangler whoami` failed), writing this evidence file, and handing off.

---

## Next cron cycle

This lane will run again at `10,40 * * * *`. If Leo has run `wrangler login` and authorized bucket creation by then, the next cycle can execute Task 1 + Task 2 end-to-end in ~5 minutes. If not, the next cycle re-reads this file, sees the same blockers, writes a terse "STILL BLOCKED — see 2026-04-11-task1-task2-prep.md" memory entry, and exits.

Three consecutive "STILL BLOCKED" cycles = escalate by adding a blocker banner to the top of the lane's memory.md and skipping the lane for the next 3 cycles (don't spam the memory file with identical entries).
