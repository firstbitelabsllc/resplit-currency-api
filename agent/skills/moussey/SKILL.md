---
description: Use for no-secret Moussey awareness pings and cross-machine receipt boundaries.
---

# Moussey

Moussey is local/LAN awareness only for this cockpit.

Allowed:

- Read local Moussey status.
- Send no-secret pings that summarize branch, PR, and proof status.
- Treat incoming pings as hints that must be verified from disk before action.

Not allowed:

- Secrets, tokens, env values, credentials, or private customer data in pings.
- Remote shell, remote install, LAN sync, or target-machine mutation.
- Claims that another machine completed work without a durable receipt.

Any cross-machine Eve handoff remains receipt-gated.
