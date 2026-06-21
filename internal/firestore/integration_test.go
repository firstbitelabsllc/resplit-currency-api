//go:build integration

package firestore_test

// Integration test for the live *firestore.Client adapter. Skipped by default;
// run against a real Firestore (default) database with:
//
//	FIRESTORE_INTEGRATION_PROJECT=resplit-fx-prod \
//	  go test -tags integration ./internal/firestore/ -run TestLiveFirestoreRoundTrip -v
//
// Requires Application Default Credentials (gcloud auth application-default
// login, or a Cloud Run metadata server) with Firestore access. Writes a
// handful of uniquely-prefixed test documents; attest_keys/rate_caps have no
// TTL so the ids are timestamped to stay unique across runs.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/firestore"
)

func TestLiveFirestoreRoundTrip(t *testing.T) {
	project := getenv(t, "FIRESTORE_INTEGRATION_PROJECT")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	store, err := firestore.NewFirestoreStore(ctx, project)
	if err != nil {
		t.Fatalf("NewFirestoreStore(%q): %v", project, err)
	}

	// Unique suffix so reruns don't collide (no Date.now restriction in Go).
	suffix := fmt.Sprintf("itest-%d", time.Now().UnixNano())

	// --- attest.Store: PutKey then GetKey round-trips SPKI + signCount. ---
	keyID := "key-" + suffix
	spki := []byte{0xDE, 0xAD, 0xBE, 0xEF}
	if err := store.PutKey(ctx, keyID, spki, 7); err != nil {
		t.Fatalf("PutKey: %v", err)
	}
	gotSPKI, gotCount, err := store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if string(gotSPKI) != string(spki) || gotCount != 7 {
		t.Fatalf("GetKey round-trip: spki=%x count=%d, want %x / 7", gotSPKI, gotCount, spki)
	}

	// A monotonic signCount update (the replay-guard write) persists.
	if err := store.PutKey(ctx, keyID, spki, 9); err != nil {
		t.Fatalf("PutKey update: %v", err)
	}
	if _, c, _ := store.GetKey(ctx, keyID); c != 9 {
		t.Fatalf("signCount after update = %d, want 9", c)
	}

	// Unknown key maps to the shared attest sentinel.
	if _, _, err := store.GetKey(ctx, "missing-"+suffix); !errors.Is(err, attest.ErrUnknownKey) {
		t.Fatalf("GetKey(missing): want attest.ErrUnknownKey, got %v", err)
	}

	// --- idempotency: first ReserveOCR is fresh, second is a duplicate. ---
	hash := "hash-" + suffix
	fresh, err := store.ReserveOCR(ctx, "dev-"+suffix, hash, time.Minute)
	if err != nil || !fresh {
		t.Fatalf("ReserveOCR #1: fresh=%v err=%v, want fresh=true", fresh, err)
	}
	fresh2, err := store.ReserveOCR(ctx, "dev-"+suffix, hash, time.Minute)
	if err != nil || fresh2 {
		t.Fatalf("ReserveOCR #2: fresh=%v err=%v, want fresh=false", fresh2, err)
	}

	// --- rate caps: atomic increment returns the post-increment count. ---
	dev := "rate-" + suffix
	allowed, c1, err := store.AllowRate(ctx, dev, time.Minute, 2)
	if err != nil || !allowed || c1 != 1 {
		t.Fatalf("AllowRate #1: allowed=%v count=%d err=%v, want true/1", allowed, c1, err)
	}
	_, c2, _ := store.AllowRate(ctx, dev, time.Minute, 2)
	allowed3, c3, _ := store.AllowRate(ctx, dev, time.Minute, 2)
	if c2 != 2 || c3 != 3 || allowed3 {
		t.Fatalf("AllowRate increments: c2=%d c3=%d allowed3=%v, want 2/3/false", c2, c3, allowed3)
	}

	t.Logf("live Firestore round-trip OK against project %q (suffix %s)", project, suffix)
}

func getenv(t *testing.T, k string) string {
	t.Helper()
	v := os.Getenv(k)
	if v == "" {
		t.Skipf("%s not set; skipping live Firestore integration test", k)
	}
	return v
}
