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

Push the branch, open a draft PR, emit ledger proof, and update the
command-center receipt so later agents can re-prove from merged `origin/main`.
