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

This repo has two surfaces: the **canonical Node FX pipeline + Cloudflare Worker** (the documented dev train; see `README.md` "Local development" and the `hooks` / `release-train` skills) and **auxiliary Go GCP Cloud Run microservices** under `cmd/` + `internal/` (deployed as Docker images via `cloudbuild.yaml`, not part of the daily publish train).

Canonical commands live in `package.json` scripts, the `hooks` skill, and `README.md` — reference those rather than re-deriving them.

### Node FX pipeline + Worker (primary)
- `npm run check` is the canonical gate: it runs `generate` (fetches live rates from `open.er-api.com`, **needs network**), then `validate:release` (strict), then the 261-test `node --test` suite. Run `npm run check`, not bare `npm test`: the `validate-package` tests require the generated `package/` dir, so `npm test` alone fails 4 tests with `ENOENT .../package`. `package/` is gitignored and regenerated each run.
- Run the Worker locally with `npx wrangler dev --port 8787 --ip 127.0.0.1`. KV (`ATTEST_KV`) and R2 (`SIDELOAD_R2`) bind in `local` mode automatically; no Cloudflare auth/login needed for `dev`.
- The Worker's `/quote`, `/history`, `/coverage` routes fetch data from `ASSET_BASE_URL` (defaults to the live `https://resplit-currency-api.pages.dev`), so local `dev` needs outbound network to return real rates. `/health` is dependency-free.
- There is no JS linter configured (the `knip.config.js` tool is not installed and CI does not lint JS). Don't expect `npm run lint`.

### Go GCP microservices (auxiliary)
- `go.mod` pins `go 1.26`. The base VM ships Go 1.22 and the toolchain auto-download via GOPROXY fails (`toolchain not available`), but the official tarball from `https://go.dev/dl/go1.26.0.linux-amd64.tar.gz` installs fine. Install it once (e.g. to `/usr/local/go126`) and build/test with `PATH=/usr/local/go126/bin:$PATH GOTOOLCHAIN=local`.
- Gates: `go build ./...`, `go test ./...`, `go vet ./...` all pass under Go 1.26. This Go toolchain is NOT installed by the update script (it's a heavy system dependency for the non-canonical surface); install it manually when working on `cmd/`/`internal/`.
- Running these services for real needs GCP (Firestore, GCS), Azure Document Intelligence, and Cloudflare Access credentials, so full end-to-end runs require external secrets.
