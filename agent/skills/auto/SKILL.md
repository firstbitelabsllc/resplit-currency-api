---
description: Use for safe local default-action, boundary checks, and durable evidence in Resplit Currency API.
---

# Auto

Use the local `auto` operating style: default to safe local work, avoid waiting
for permission where repo rules already decide the path, and stop only for true
human gates such as credentials, money, live destructive actions, or external
messages to humans.

For this repository, "auto" still means evidence-first:

- Read `RALPH.md`, the nurse log, workflow, runbook, ledger, and git state.
- Pick the smallest agent-owned slice.
- Keep deploy, secret, and external-service gates closed.
- Leave enough durable proof for the next agent to resume without chat memory.
