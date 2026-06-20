# Resplit Currency API Eve Studio Receiver Receipt - 2026-06-20

## Scope

Install a local-only Eve cockpit for Resplit Currency API from a clean Studio
worktree, following the existing nurse log, runbook, and Vidux
pre-launch-architecture plan while preserving the dirty attached checkout.

## Baseline

- Root checkout: `/Users/leokwan/Development/resplit-currency-api` was dirty on
  `codex/w2-5-fx-manifest-source-custody`; it was not mutated.
- Worktree GC reported dirty/open historical worktrees and required owner review
  before cleanup; no automated removal happened.
- New worktree: `/Users/leokwan/Development/resplit-currency-api-worktrees/eve-studio-20260620`
  on `codex/eve-studio-resplit-currency-api-20260620`, based on
  `origin/main@5947eafb`.

## Installed

- Eve agent entrypoint and instructions under `agent/`.
- Local wrappers for `auto`, `vidux`, `moussey`, `resplit-currency-api`, and
  optional `glm-local`.
- Read-only `fx-readiness` subagent scaffold.
- Local capability checker at `scripts/eve-capability-check.mjs`.
- NPM scripts for `eve:info`, `eve:build`, `eve:dev:local`, and
  `eve:capabilities`.
- Root dev dependencies for `eve`, `ai`, and `zod`.
- `.eve/` and `.output/` ignored as generated local artifacts.

## Proof

Proof passed from `/Users/leokwan/Development/resplit-currency-api-worktrees/eve-studio-20260620`:

- `npm install -D --save-exact eve@0.11.5 ai@7.0.0-beta.178 zod@4.4.3` completed and updated the lockfile.
- `npm ci --dry-run` exited 0 with the checked-in lockfile.
- `npm run eve:capabilities -- --json` returned `ok: true`, no errors, and no warnings.
- `npm run eve:info -- --json` returned status `ready`, 0 errors, and 0 warnings.
- `npm run eve:build` built `.output` successfully.
- `node --check scripts/eve-capability-check.mjs` passed.
- `git diff --check` passed.
- `npm run check` generated the `2026-06-20` package artifacts, passed `validate:release`, and passed `248/248` tests.
- `npm run smoke:deploy` returned `OK (date=2026-06-20, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.

Install note: the install reports npm audit debt (`12 vulnerabilities`). No
`npm audit fix` was run because that would change unrelated dependencies.

## True-Integration Reproof

Studio re-proved PR `firstbitelabsllc/resplit-currency-api#24` from the same
clean worktree on 2026-06-20 after the first receiver install.

- Worktree:
  `/Users/leokwan/Development/resplit-currency-api-worktrees/eve-studio-20260620`
- Branch: `codex/eve-studio-resplit-currency-api-20260620`
- Base before this reproof: `origin/main@5947eafb`
- Existing head before this reproof: `44373510`
- PR state before this reproof: `OPEN`, draft, `MERGEABLE`/`CLEAN`, with CodeQL
  and Graphite AI Reviews green.

Additional integration hardening:

- `scripts/eve-capability-check.mjs` now verifies that the required Eve
  dependency packages are actually installed in `node_modules`, not only listed
  in `package.json`.
- The same checker now verifies the local `node_modules/.bin/eve` binary exists
  before reporting the receiver ready.

Fresh proof passed from the clean worktree:

- `git fetch origin --prune`
- `git rev-list --left-right --count origin/main...HEAD` returned `0 1` before
  the reproof commit.
- `npm install --package-lock=false` completed; npm reported `0 vulnerabilities`.
- `npm ci --dry-run` exited 0 with the checked-in lockfile.
- `npm ls eve ai zod --depth=0` showed `eve@0.11.5`,
  `ai@7.0.0-beta.178`, and `zod@4.4.3`.
- `node --check scripts/eve-capability-check.mjs` passed.
- `git diff --check` passed.
- `npm run eve:capabilities -- --json` returned `ok: true`, 0 errors, and 0
  warnings.
- `npm run eve:info -- --json` returned status `ready`, 0 errors, and 0
  warnings.
- `npm run eve:build` built `.output` successfully.
- `npm run check` generated `2026-06-20`, passed package validation, and passed
  `248/248` tests.
- `npm run smoke:deploy` returned
  `OK (date=2026-06-20, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.

Runbook/live proof:

- `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 3` showed
  the latest pages deployment, scheduled currency-rate update, and PR CodeQL
  runs completed successfully.
- `https://fx.resplit.app/quote?from=USD&to=EUR&date=2026-06-20` returned
  `requestedDate: 2026-06-20`, `resolvedDate: 2026-06-20`, and
  `resolutionKind: exact`.
- `https://fx.resplit.app/coverage?from=USD&to=EUR&anchorDate=2026-06-20&days=7`
  returned `mismatchCount: 0`, no `signals`, and freshness lags of `0` days.

Moussey coding handoff
`d4e3f5c5-0717-4e2d-9329-6460b84bb0f8` was staged and verified from the
command-center source path. It is a verifier handoff only; it did not start
local CI, call a model, deploy, or mutate another checkout.

## Non-Claims

- This does not deploy to Cloudflare or GCP.
- This does not mutate Terraform state.
- This does not dispatch GitHub Actions.
- This does not publish package or production snapshot artifacts.
- This does not link Eve to a hosted project or run hosted Eve deployment.
- This does not call hosted models, download GLM weights, or start a local model
  server.
- This does not mutate other Macs or the attached dirty root checkout.

## Next

Push the reproof commit, mark PR `#24` ready for review, wait for refreshed
GitHub checks, emit ledger proof, and update the command-center receipt so later
agents can re-prove from merged `origin/main`.
