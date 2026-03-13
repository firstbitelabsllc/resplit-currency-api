# Agent Ledger

Shared activity log at `.agent-ledger/activity.jsonl` for cross-agent coordination. Recent entries are auto-injected on SessionStart in Claude when the repo wires `~/Development/ai/hooks/ledger-inject.sh`.

## Schema (JSONL, one object per line)
`ts` (ISO8601), `eid` (8-char event ID), `agent_id` (`tool/short-session`), `repo` (repo name), `lane` (optional task focus), `skills[]` (optional), `event` (stop), `stop_reason`, `summary` (2-3 sentences max), `files[]`

## Querying (for deeper lookups beyond auto-injected context)
```bash
# Last 50 entries, compact
tail -n 50 .agent-ledger/activity.jsonl | jq -r '"  \(.ts[11:16]) \(.agent_id // ((.agent // "unknown") + "/" + ((.sid // "unknown") | .[0:8]))) — \(.summary // "(no summary)") [\((.files // []) | join(", "))]"'

# Entries from a specific agent
jq -r 'select(.agent_id | startswith("cursor/")) | "\(.ts[11:16]) \(.summary)"' .agent-ledger/activity.jsonl

# Entries touching a specific file or path fragment
jq -r 'select((.files // []) | map(test("path-fragment")) | any) | "\(.ts[11:16]) [\(.agent_id)] \(.summary)"' .agent-ledger/activity.jsonl

# Entries for a lane/task
jq -r 'select(.lane == "feature-name") | "\(.ts[11:16]) \(.summary)"' .agent-ledger/activity.jsonl
```

## Writing
The Stop hook auto-logs. No manual action needed.
