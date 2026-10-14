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

## Code comments

Use names, types and tests to explain code. Do not add narration, section
banners, commented-out code or workaround history. Fix an owned workaround
at its cause; keep behavior changes separate from comment deletion.

Keep license headers, public API contracts, necessary tool or compiler
directives, and non-obvious constraints imposed by a current external
platform, dependency or protocol. Link the relevant issue or specification
when it explains the constraint. Correctness or safety suppressions require
a code fix and focused proof; deleting the directive alone is not a fix.
Change generated or vendored comments through their source owner.
