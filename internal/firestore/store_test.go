package firestore

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

// fakeDocs is an in-memory docStore: collection -> id -> fields. It mirrors the
// Firestore semantics FirestoreStore relies on (NotFound, AlreadyExists, atomic
// increment) so the store round-trips identically against it and the real SDK.
type fakeDocs struct {
	mu   sync.Mutex
	data map[string]map[string]map[string]any
}

func newFakeDocs() *fakeDocs {
	return &fakeDocs{data: make(map[string]map[string]map[string]any)}
}

func (f *fakeDocs) coll(name string) map[string]map[string]any {
	c, ok := f.data[name]
	if !ok {
		c = make(map[string]map[string]any)
		f.data[name] = c
	}
	return c
}

func (f *fakeDocs) Get(_ context.Context, coll, id string) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	doc, ok := f.coll(coll)[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := make(map[string]any, len(doc))
	for k, v := range doc {
		out[k] = v
	}
	return out, nil
}

func (f *fakeDocs) Set(_ context.Context, coll, id string, fields map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make(map[string]any, len(fields))
	for k, v := range fields {
		cp[k] = v
	}
	f.coll(coll)[id] = cp
	return nil
}

func (f *fakeDocs) Create(_ context.Context, coll, id string, fields map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.coll(coll)
	if _, ok := c[id]; ok {
		return ErrAlreadyExists
	}
	cp := make(map[string]any, len(fields))
	for k, v := range fields {
		cp[k] = v
	}
	c[id] = cp
	return nil
}

func (f *fakeDocs) Increment(_ context.Context, coll, id, field string, delta int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.coll(coll)
	doc, ok := c[id]
	if !ok {
		doc = make(map[string]any)
		c[id] = doc
	}
	var cur int64
	if v, ok := doc[field].(int64); ok {
		cur = v
	}
	cur += delta
	doc[field] = cur
	return cur, nil
}

func TestFirestoreStore_KeyRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := NewStore(newFakeDocs())

	const keyID = "device-key-1"
	spki := []byte{0x30, 0x59, 0x01, 0x02, 0x03}

	// Unknown key surfaces the attest sentinel.
	if _, _, err := store.GetKey(ctx, keyID); !errors.Is(err, attest.ErrUnknownKey) {
		t.Fatalf("GetKey before Put: want attest.ErrUnknownKey, got %v", err)
	}

	// Put then Get round-trips bytes + count.
	if err := store.PutKey(ctx, keyID, spki, 7); err != nil {
		t.Fatalf("PutKey: %v", err)
	}
	gotSPKI, gotCount, err := store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if string(gotSPKI) != string(spki) {
		t.Errorf("spki: got %x want %x", gotSPKI, spki)
	}
	if gotCount != 7 {
		t.Errorf("signCount: got %d want 7", gotCount)
	}

	// Replace advances the stored count.
	if err := store.PutKey(ctx, keyID, spki, 42); err != nil {
		t.Fatalf("PutKey replace: %v", err)
	}
	_, gotCount, err = store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey after replace: %v", err)
	}
	if gotCount != 42 {
		t.Errorf("signCount after replace: got %d want 42", gotCount)
	}
}

// TestFirestoreStore_SatisfiesAttestStore drives the store through the real
// attest.Store-consuming attestation flow shape (Put then Get), proving the
// concrete type is usable wherever the interface is required.
func TestFirestoreStore_SatisfiesAttestStore(t *testing.T) {
	ctx := context.Background()
	var s attest.Store = NewStore(newFakeDocs())
	if err := s.PutKey(ctx, "k", []byte("spki"), 1); err != nil {
		t.Fatalf("PutKey via interface: %v", err)
	}
	spki, count, err := s.GetKey(ctx, "k")
	if err != nil {
		t.Fatalf("GetKey via interface: %v", err)
	}
	if string(spki) != "spki" || count != 1 {
		t.Fatalf("round-trip via interface: got (%q,%d)", spki, count)
	}
}

func TestReserveOCR_Idempotency(t *testing.T) {
	ctx := context.Background()
	docs := newFakeDocs()
	fixed := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	store := NewStore(docs)
	store.now = func() time.Time { return fixed }

	const (
		device = "dev-1"
		hash   = "abc123"
		ttl    = time.Hour
	)

	// First reservation is fresh.
	fresh, err := store.ReserveOCR(ctx, device, hash, ttl)
	if err != nil {
		t.Fatalf("ReserveOCR #1: %v", err)
	}
	if !fresh {
		t.Fatal("ReserveOCR #1: want fresh=true")
	}

	// Same (device, hash) is a duplicate.
	fresh, err = store.ReserveOCR(ctx, device, hash, ttl)
	if err != nil {
		t.Fatalf("ReserveOCR #2: %v", err)
	}
	if fresh {
		t.Fatal("ReserveOCR #2: want fresh=false (duplicate)")
	}

	// Different hash is independent.
	fresh, err = store.ReserveOCR(ctx, device, "different", ttl)
	if err != nil {
		t.Fatalf("ReserveOCR diff: %v", err)
	}
	if !fresh {
		t.Fatal("ReserveOCR diff: want fresh=true")
	}

	// The reservation carries createdAt + expiresAt (TTL field).
	got, err := docs.Get(ctx, collOCRIdempotency, idempotencyID(device, hash))
	if err != nil {
		t.Fatalf("inspect reservation: %v", err)
	}
	exp, ok := got[fieldExpiresAt].(time.Time)
	if !ok {
		t.Fatalf("expiresAt missing or wrong type: %T", got[fieldExpiresAt])
	}
	if !exp.Equal(fixed.Add(ttl)) {
		t.Errorf("expiresAt: got %v want %v", exp, fixed.Add(ttl))
	}
}

func TestIncrementRate_AtomicPerWindow(t *testing.T) {
	ctx := context.Background()
	docs := newFakeDocs()
	store := NewStore(docs)

	// Pin two timestamps into the same 60s window and a third into the next.
	base := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	window := time.Minute
	times := []time.Time{base, base.Add(30 * time.Second), base.Add(90 * time.Second)}
	idx := 0
	store.now = func() time.Time {
		t := times[idx]
		if idx < len(times)-1 {
			idx++
		}
		return t
	}

	const device = "dev-rate"

	c1, err := store.IncrementRate(ctx, device, window)
	if err != nil {
		t.Fatalf("IncrementRate #1: %v", err)
	}
	c2, err := store.IncrementRate(ctx, device, window)
	if err != nil {
		t.Fatalf("IncrementRate #2: %v", err)
	}
	if c1 != 1 || c2 != 2 {
		t.Fatalf("same window counts: got (%d,%d) want (1,2)", c1, c2)
	}

	// Next window starts a fresh counter.
	c3, err := store.IncrementRate(ctx, device, window)
	if err != nil {
		t.Fatalf("IncrementRate #3: %v", err)
	}
	if c3 != 1 {
		t.Fatalf("new window count: got %d want 1", c3)
	}
}

func TestAllowRate_CapEnforcement(t *testing.T) {
	ctx := context.Background()
	store := NewStore(newFakeDocs())
	store.now = func() time.Time { return time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC) }

	const (
		device = "dev-cap"
		limit  = int64(2)
		window = time.Minute
	)

	for i := 1; i <= 3; i++ {
		allowed, count, err := store.AllowRate(ctx, device, window, limit)
		if err != nil {
			t.Fatalf("AllowRate #%d: %v", i, err)
		}
		wantAllowed := int64(i) <= limit
		if allowed != wantAllowed {
			t.Errorf("AllowRate #%d: allowed=%v want %v (count=%d)", i, allowed, wantAllowed, count)
		}
		if count != int64(i) {
			t.Errorf("AllowRate #%d: count=%d want %d", i, count, i)
		}
	}
}

func TestWindowStartUnix(t *testing.T) {
	// 960 is a window boundary (960/60 = 16). 960 and 1019 are in the same
	// 60s window [960,1020); 1020 starts the next one.
	t1 := time.Unix(960, 0)
	t2 := time.Unix(1019, 0)
	t3 := time.Unix(1020, 0)
	w1 := windowStartUnix(t1, time.Minute)
	if w1 != int64(960) {
		t.Errorf("window start: got %d want 960", w1)
	}
	if w2 := windowStartUnix(t2, time.Minute); w1 != w2 {
		t.Errorf("same window should match: %d != %d", w1, w2)
	}
	if w3 := windowStartUnix(t3, time.Minute); w1 == w3 {
		t.Errorf("different window should differ: %d == %d", w1, w3)
	}
	// Zero/sub-second window falls back to the raw unix timestamp.
	if got := windowStartUnix(t1, 0); got != 960 {
		t.Errorf("zero window: got %d want 960", got)
	}
}

func TestNewFirestoreStore_NotWired(t *testing.T) {
	_, err := NewFirestoreStore(context.Background(), "resplit-fx-prod")
	if !errors.Is(err, ErrClientNotWired) {
		t.Fatalf("NewFirestoreStore: want ErrClientNotWired, got %v", err)
	}
}
