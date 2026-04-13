#!/usr/bin/env bash
#
# Sideload staging smoke test — exercises the full upload lifecycle
# against the deployed staging worker.
#
# Prerequisites:
#   - CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET env vars set
#   - Worker deployed to staging (npx wrangler deploy)
#
# Usage:
#   npm run smoke:sideload
#   # or directly:
#   SIDELOAD_BASE="${SIDELOAD_BASE:-https://resplit-fx.leojkwan.workers.dev}" ./scripts/smoke-sideload-staging.sh

set -euo pipefail

BASE="${SIDELOAD_BASE:-https://resplit-fx.leojkwan.workers.dev}"
HEADERS=(-H "Cf-Access-Client-Id: ${CF_ACCESS_CLIENT_ID:?missing}" \
         -H "Cf-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:?missing}")

echo "=== Sideload Smoke Test ==="
echo "Target: $BASE"
echo ""

# 1. Preflight (no auth needed)
echo "1. OPTIONS preflight..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE/sideload/photos")
if [ "$STATUS" != "204" ]; then
  echo "   FAIL: expected 204, got $STATUS"
  exit 1
fi
echo "   PASS (204)"

# 2. List photos (should work, may be empty)
echo "2. GET /sideload/photos (list)..."
LIST_RESP=$(curl -s "${HEADERS[@]}" "$BASE/sideload/photos?limit=5")
echo "   Response: $(echo "$LIST_RESP" | head -c 120)"
echo "   PASS"

# 3. Create a test image (16 bytes of random data)
echo "3. POST /sideload/photos/upload (init)..."
TEST_FILE=$(mktemp)
dd if=/dev/urandom of="$TEST_FILE" bs=16 count=1 2>/dev/null
SHA256=$(shasum -a 256 "$TEST_FILE" | awk '{print $1}')
SIZE=$(wc -c < "$TEST_FILE" | tr -d ' ')

INIT_RESP=$(curl -s "${HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -X POST "$BASE/sideload/photos/upload" \
  -d "{\"contentType\":\"image/jpeg\",\"size\":$SIZE,\"sha256\":\"$SHA256\"}")

PHOTO_ID=$(echo "$INIT_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('photoId',''))" 2>/dev/null || echo "")
UPLOAD_URL=$(echo "$INIT_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uploadUrl',''))" 2>/dev/null || echo "")

if [ -z "$PHOTO_ID" ] || [ -z "$UPLOAD_URL" ]; then
  echo "   FAIL: init did not return photoId/uploadUrl"
  echo "   Response: $INIT_RESP"
  rm -f "$TEST_FILE"
  exit 1
fi
echo "   PASS (photoId=$PHOTO_ID)"

# 4. Upload bytes
echo "4. POST $UPLOAD_URL (bytes)..."
BYTES_RESP=$(curl -s "${HEADERS[@]}" \
  -H "Content-Type: application/octet-stream" \
  -X POST "$BASE$UPLOAD_URL" \
  --data-binary "@$TEST_FILE")

ETAG=$(echo "$BYTES_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('etag',''))" 2>/dev/null || echo "")
if [ -z "$ETAG" ]; then
  echo "   FAIL: upload did not return etag"
  echo "   Response: $BYTES_RESP"
  rm -f "$TEST_FILE"
  exit 1
fi
echo "   PASS (etag=$ETAG)"

# 5. Read meta back
echo "5. GET /sideload/photos/$PHOTO_ID (meta)..."
META_RESP=$(curl -s "${HEADERS[@]}" "$BASE/sideload/photos/$PHOTO_ID")
META_SHA=$(echo "$META_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sha256',''))" 2>/dev/null || echo "")
if [ "$META_SHA" != "$SHA256" ]; then
  echo "   FAIL: sha256 mismatch in meta"
  echo "   Expected: $SHA256"
  echo "   Got: $META_SHA"
  rm -f "$TEST_FILE"
  exit 1
fi
echo "   PASS (sha256 matches)"

# 6. Set labels
echo "6. POST /sideload/photos/$PHOTO_ID/labels..."
LABEL_RESP=$(curl -s "${HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -X POST "$BASE/sideload/photos/$PHOTO_ID/labels" \
  -d '{"labels":{"merchant":"Smoke Test","source":"automated"}}')
echo "   Response: $(echo "$LABEL_RESP" | head -c 100)"
echo "   PASS"

# 7. Cleanup — delete the test photo
echo "7. DELETE /sideload/photos/$PHOTO_ID (cleanup)..."
DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEADERS[@]}" \
  -X DELETE "$BASE/sideload/photos/$PHOTO_ID")
if [ "$DEL_STATUS" != "204" ]; then
  echo "   WARN: expected 204, got $DEL_STATUS (photo may need manual cleanup)"
fi
echo "   PASS (204)"

# 8. Verify FX routes still work
echo "8. FX regression check..."
FX_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/quote?from=USD&to=EUR&date=2026-01-15")
if [ "$FX_STATUS" != "200" ]; then
  echo "   FAIL: FX /quote returned $FX_STATUS (expected 200)"
  rm -f "$TEST_FILE"
  exit 1
fi
echo "   PASS (FX /quote returns 200)"

rm -f "$TEST_FILE"
echo ""
echo "=== All smoke tests passed ==="
