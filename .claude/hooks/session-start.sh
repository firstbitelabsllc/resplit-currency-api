#!/bin/bash
# Claude Code cloud sessions only: install npm and Go dependencies so the Node,
# worker (vitest) and Go tests run. Docker is absent, so image builds stay local.
# NODE_USE_ENV_PROXY makes Node's fetch use the cloud proxy.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export NODE_USE_ENV_PROXY=1' >> "$CLAUDE_ENV_FILE"
fi

# Go modules: a no-op when the module cache is warm.
go mod download

# SessionStart also fires on resume, clear and compact. Skip the install when
# the installed tree already matches package-lock.json, so `npm ci` (which
# deletes node_modules) never wipes a working tree mid-session. `npm ls` also
# fails when a package directory is missing, which a timestamp check cannot see.
if npm ls --depth=0 >/dev/null 2>&1; then
  exit 0
fi

# npm ci keeps package-lock.json untouched (npm install rewrites it).
npm ci --no-audit --no-fund
