# Ralph Config

This repo is the FX data pipeline and canonical Worker surface for Resplit.

## Source Of Truth

Rehydrate in this order before taking a slice:

1. `.cursor/plans/resplit-nurse.log.md`
2. `.github/workflows/run.yml`
3. `RUNBOOK.md`
4. `.agent-ledger/activity.jsonl`
5. `git status --short --branch`

Automation memory is supplemental only.

## Queue Contract

Treat the next smallest actionable item from these surfaces as the queue:

- a red or warning-producing publish/deploy path in `.github/workflows/run.yml`
- a failing runbook health check
- drift between documented commands and the commands that actually work on trunk
- missing repo-local guidance needed for future nurse/release-train runs

If the latest nurse log says the repo is `GO` and fresh proof still passes, do not invent work in this repo. Record the clean checkpoint and stop with the external blocker if the launch hold lives elsewhere.

## Completion Standard

A repo slice is only complete when all of the following are true:

1. The touched surface is fixed on `main`.
2. `npm run check` passes.
3. `npm run smoke:deploy` passes against the canonical Worker unless there is a real documented blocker.
4. Any relevant live checks from `RUNBOOK.md` are rerun.
5. `.cursor/plans/resplit-nurse.log.md` gets a concise checkpoint with what changed, fresh proof, remaining blocker, and exact next slice.

## Stop Signals

Use one of these outcomes:

- `<promise>COMPLETE</promise>` when the repo slice is repaired and re-proven.
- `<promise>SKIP: external blocker</promise>` when this repo is green and launch is blocked outside `resplit-currency-api`.
