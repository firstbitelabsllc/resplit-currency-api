# Agent Ledger

This repo uses `.agent-ledger/activity.jsonl` as a shared activity log for Claude Code, Cursor, and Codex.

## How It Works
- **Write**: Automatic on agent Stop hook
- **Read**: Claude can auto-inject recent entries on SessionStart; Codex should query the ledger manually before substantial work
- **Schema**: `{"ts":"ISO8601","eid":"evt_1234abcd","agent_id":"codex/abc123","repo":"repo-name","lane":"","skills":[],"event":"stop","stop_reason":"","summary":"2-3 sentences","files":["path"]}`

## Quick Commands
```bash
tail -10 .agent-ledger/activity.jsonl
tail -n 20 .agent-ledger/activity.jsonl | jq -r '"  \(.ts[11:16]) \(.agent_id // ((.agent // "unknown") + "/" + ((.sid // "unknown") | .[0:8]))) — \(.summary // "(no summary)") [\((.files // []) | join(", "))]"'
jq -r 'select((.files // []) | map(test("path-fragment")) | any) | "\(.ts) [\(.agent_id)] \(.summary)"' .agent-ledger/activity.jsonl
jq -r 'select(.agent_id | startswith("codex/")) | "\(.ts) \(.summary)"' .agent-ledger/activity.jsonl
```

## Cursor Cloud specific instructions

This repo has two runnable surfaces plus an auxiliary Go set:
- **Node FX publisher** (`currscript.js`, `scripts/`): generates/validates FX artifacts. Verify with `npm run check` (generate + `validate:release` + Node test suite). See `README.md` "Local development" and the `hooks`/`release-train` skills for the canonical gates. There is no separate ESLint/lint script; `npm run check` is the verification gate for JS.
- **Cloudflare FX Worker** (`worker/src/index.mjs`, `wrangler.jsonc`): run locally with `npx wrangler dev --port 8787 --ip 127.0.0.1` (defaults to `--local`; KV/R2 are simulated). Routes: `/health`, `/quote`, `/history`, `/coverage`, `/cron/fx-canary`. `/quote` and `/history` fetch source JSON from `ASSET_BASE_URL` (`https://resplit-currency-api.pages.dev`), so the worker needs outbound network to serve real quotes locally.
- **Go Cloud Run services** (`cmd/ocr`, `cmd/sideload`, `cmd/fx-publish`, `internal/`): build/test with `go build ./...` / `go test ./...`.

Non-obvious caveats:
- `go.mod` requires **Go 1.26**. The base image ships Go 1.22, so Go 1.26.4 is installed at `/usr/local/go` and `/usr/bin/go` is symlinked to it (persisted in the snapshot). If `go version` ever reports 1.22, reinstall from `https://go.dev/dl/go1.26.4.linux-amd64.tar.gz` into `/usr/local/go` and re-point the symlink. Do not rely on `GOTOOLCHAIN` auto-download — `go1.26` (without patch) is "not available" via the toolchain fetcher.
- `npm run check`'s `generate` step hits `open.er-api.com` and rewrites `snapshot-archive/{today}.json`; a same-day re-run can dirty that file harmlessly (upstream revises rates). See `release-train` skill nursing rules before treating it as a repo failure.
- `eve` (devDependency) warns it wants Node >=24 while the image has Node 22; this is only a warning and does not affect `npm run check`.
- Deploy/smoke scripts (`npm run smoke:deploy`) and live `gh`/`wrangler deploy` flows need Cloudflare/Sentry secrets and target production; they are not part of local dev verification.
