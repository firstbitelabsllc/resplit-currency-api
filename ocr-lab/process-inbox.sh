#!/usr/bin/env bash
# ocr-lab/process-inbox.sh
#
# Runs every receipt image dropped in ocr-lab/inbox/ through the /ocr/scan proxy
# (real Azure DI), saves the envelope to ocr-lab/results/, appends an edge-case
# row to ocr-lab/EDGE-CASES-OBSERVED.md, and moves the image to processed/.
#
# Reuses a worker already listening on $OCR_BASE; otherwise boots `wrangler dev`
# from the OCR branch worktree (which has the /ocr code + a gitignored .dev.vars
# holding AZURE_OCR_KEY) for the duration of the batch, then tears it down.
#
# Drop receipts in ocr-lab/inbox/ and either wait for the 30-min cron or run:
#   bash ocr-lab/process-inbox.sh

set -uo pipefail

LAB="$(cd "$(dirname "$0")" && pwd)"
INBOX="$LAB/inbox"
RESULTS="$LAB/results"
PROCESSED="$LAB/processed"
NOTES="$LAB/EDGE-CASES-OBSERVED.md"
LOG="$LAB/cron.log"

OCR_BASE="${OCR_BASE:-http://127.0.0.1:8801}"
WORKER_DIR="${WORKER_DIR:-/Users/leokwan/Development/resplit-currency-api-worktrees/ocr-key-proxy-20260530}"
WRANGLER_PORT="${WRANGLER_PORT:-8801}"

mkdir -p "$INBOX" "$RESULTS" "$PROCESSED"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

shopt -s nullglob
IMAGES=("$INBOX"/*.{jpg,jpeg,png,JPG,JPEG,PNG,heic,HEIC})
if [ ${#IMAGES[@]} -eq 0 ]; then
  log "inbox empty — nothing to process"
  exit 0
fi
log "found ${#IMAGES[@]} image(s) in inbox"

# Ensure a worker is reachable; boot wrangler dev if not.
STARTED_DEV=0
DEV_PID=""
if ! curl -s -m 3 "$OCR_BASE/ocr/challenge" >/dev/null 2>&1; then
  log "no worker at $OCR_BASE — booting wrangler dev from $WORKER_DIR"
  ( cd "$WORKER_DIR" && npx --no-install wrangler dev --port "$WRANGLER_PORT" >"$LAB/wrangler-dev.log" 2>&1 ) &
  DEV_PID=$!
  STARTED_DEV=1
  for _ in $(seq 1 40); do
    curl -s -m 2 "$OCR_BASE/ocr/challenge" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -s -m 3 "$OCR_BASE/ocr/challenge" >/dev/null 2>&1; then
  log "ERROR: worker still unreachable at $OCR_BASE — aborting (images left in inbox)"
  [ "$STARTED_DEV" = 1 ] && kill "$DEV_PID" 2>/dev/null
  exit 1
fi

# Notes header (once).
if [ ! -f "$NOTES" ]; then
  cat > "$NOTES" <<'HDR'
# OCR observed edge cases (real receipts through /ocr/scan)

Auto-appended by ocr-lab/process-inbox.sh. One row per processed receipt. Pair
with the research corpus in EDGE-CASES.md. Look for: wrong/blank merchant, wrong
total, missing tax, 0 line items, non-`ok` status, slow azure_ms, or a currency/
date the mapper would misparse (decimal-comma, ¥ no-decimal, Buddhist-era +543).

| when (UTC) | file | status | merchant | total | items | azure_ms | notes |
|---|---|---|---|---|---|---|---|
HDR
fi

processed_count=0
for img in "${IMAGES[@]}"; do
  base="$(basename "$img")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$RESULTS/${stamp}-${base%.*}.json"

  http=$(curl -s -m 120 -X POST "$OCR_BASE/ocr/scan" \
    -H "Content-Type: image/jpeg" \
    -H "X-Resplit-Attest-Soft-Fail: true" \
    -H "X-Resplit-Client-Version: ocr-lab-cron" \
    --data-binary "@$img" \
    -o "$out" -w "%{http_code}")

  row=$(OUT="$out" BASE="$base" HTTP="$http" WHEN="$(ts)" python3 - <<'PY'
import json, os
out=os.environ["OUT"]; base=os.environ["BASE"]; http=os.environ["HTTP"]; when=os.environ["WHEN"]
status=merchant=total="?"; items=azure_ms="?"; notes=[]
try:
    d=json.load(open(out))
    status=d.get("status","?")
    raw=d.get("raw") or {}
    if isinstance(raw,dict):
        ar=raw.get("analyzeResult") or {}
        docs=ar.get("documents") or []
        if docs:
            f=docs[0].get("fields",{}) or {}
            mn=f.get("MerchantName") or {}
            merchant=(mn.get("valueString") or mn.get("content") or "?")
            tot=f.get("Total") or {}
            total=(tot.get("content") or tot.get("valueCurrency",{}).get("amount") or "?")
            its=(f.get("Items") or {}).get("valueArray") or []
            items=len(its)
            if not merchant or merchant=="?": notes.append("blank-merchant")
            if total in ("?",None): notes.append("no-total")
            if items==0: notes.append("0-items")
        else:
            notes.append("no-documents")
    # latency from a sibling — not in envelope; left to cron.log
except Exception as e:
    notes.append(f"parse-error:{e}")
if http!="200": notes.append(f"http-{http}")
merchant=str(merchant).replace("|","/")[:40]
print(f"| {when} | {base} | {status} | {merchant} | {total} | {items} | {azure_ms} | {' '.join(notes) or 'ok'} |")
PY
)
  echo "$row" >> "$NOTES"
  log "processed $base -> $http :: $row"
  mv "$img" "$PROCESSED/${stamp}-${base}" 2>/dev/null
  processed_count=$((processed_count+1))
done

[ "$STARTED_DEV" = 1 ] && { log "stopping wrangler dev ($DEV_PID)"; kill "$DEV_PID" 2>/dev/null; pkill -f "wrangler dev --port $WRANGLER_PORT" 2>/dev/null; }
log "batch done — $processed_count processed"
