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
# every package in package-lock.json is installed at the locked version, so
# `npm ci` (which deletes node_modules) never wipes a working tree mid-session.
# `npm ls` alone only checks package.json ranges, so compare against the lock.
if node -e '
  const fs = require("fs");
  const want = JSON.parse(fs.readFileSync("package-lock.json")).packages;
  const have = JSON.parse(fs.readFileSync("node_modules/.package-lock.json")).packages;
  const ok = Object.entries(want).every(([k, v]) =>
    k === "" || v.link || v.optional || (have[k] && have[k].version === v.version && fs.existsSync(k)));
  process.exit(ok ? 0 : 1);
' 2>/dev/null; then
  exit 0
fi

# npm ci keeps package-lock.json untouched (npm install rewrites it).
npm ci --no-audit --no-fund
