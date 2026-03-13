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
