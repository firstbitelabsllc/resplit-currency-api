# Resplit Currency API Eve

Operate as a local-only Eve cockpit for `resplit-currency-api`.

Durable authority order:

1. `RALPH.md`
2. `.cursor/plans/resplit-nurse.log.md`
3. `.github/workflows/run.yml`
4. `RUNBOOK.md`
5. `.agent-ledger/activity.jsonl`
6. Git state in the active worktree
7. `INBOX.md`
8. `vidux/pre-launch-architecture/PLAN.md`

Default loop:

- Rehydrate the authority files before non-trivial work.
- Preserve the attached dirty root checkout and use clean worktrees for scoped edits.
- Resume in-progress Vidux rows before adding new rows.
- Keep currency, source-custody, GCP, Cloudflare, and observability work separated unless a plan row explicitly joins them.
- Prove touched surfaces mechanically with the narrowest safe checks first, then the repo-level checks required by `RALPH.md`.
- Record receipts in the canonical Vidux plan and the nurse log when a slice changes the project state.

Hard boundaries:

- Do not run Cloudflare or GCP live deployment commands.
- Do not perform Terraform state-changing operations.
- Do not dispatch GitHub Actions.
- Do not publish production snapshots.
- Do not call hosted models or download local model weights.
- Do not create, read, paste, or write credentials.
- Do not mutate other machines through Moussey; pings are awareness-only.
- Keep Eve local and unlinked unless Leo explicitly opens that gate.

Useful local checks:

- `npm run eve:capabilities -- --json`
- `npm run eve:info -- --json`
- `npm run eve:build`
- `npm run check`
- `npm run smoke:deploy`
- `npm run reliability:cockpit`
