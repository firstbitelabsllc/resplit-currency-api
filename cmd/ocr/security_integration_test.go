//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	fsstore "github.com/firstbitelabsllc/resplit-currency-api/internal/firestore"
)

type unavailableDurableRecovery struct{ ocrSpendStore }

func (s *unavailableDurableRecovery) GetOCROperation(context.Context, string, string) (string, error) {
	return "", errors.New("synthetic durable operation lookup unavailable")
}

func TestEmulatorAuthenticatedScanRecovery(t *testing.T) {
	testEmulatorAuthenticatedScanRecovery(t, false)
}

func TestEmulatorAcceptedPollingFailureRecovery(t *testing.T) {
	testEmulatorAuthenticatedScanRecovery(t, true)
}

func testEmulatorAuthenticatedScanRecovery(t *testing.T, failFirstPoll bool) {
	t.Helper()
	if !strings.HasPrefix(os.Getenv("FIRESTORE_EMULATOR_HOST"), "127.0.0.1:") {
		t.Fatal("loopback Firestore emulator required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := fsstore.NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	var key *ecdsa.PrivateKey
	var hash [32]byte
	// Exercise a standard-base64 key that requires the real adapter's path fix.
	for {
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		pub, _ := key.PublicKey.ECDH()
		hash = sha256.Sum256(pub.Bytes())
		if strings.Contains(base64.StdEncoding.EncodeToString(hash[:]), "/") {
			break
		}
	}
	id := base64.StdEncoding.EncodeToString(hash[:])
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateKey(ctx, id, spki, 0); err != nil {
		t.Fatal(err)
	}
	var posts atomic.Int64
	var recoverPoll atomic.Bool
	polling := make(chan struct{})
	var pollingOnce sync.Once
	finish := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.Header().Set("Operation-Location", "http://"+r.Host+"/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/local-operation?api-version=2024-11-30")
			w.WriteHeader(202)
			return
		}
		pollingOnce.Do(func() { close(polling) })
		<-finish
		if failFirstPoll && !recoverPoll.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, `{"status":"succeeded","analyzeResult":{"merchant":"synthetic"}}`)
	}))
	defer upstream.Close()
	provider, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "local-fixture", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	gate := &ocrSpendGate{store: store, idempotencyTTL: time.Hour, window: time.Hour, attestedLimit: 2}
	srv := newServerWithGate(store, provider, slog.Default(), nil, gate)
	h := srv.routes()
	image := []byte("local-security-receipt")
	request := func(count uint32, keyID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/ocr/scan", bytes.NewReader(image)).WithContext(ctx)
		r.Header.Set(headerKeyID, keyID)
		r.Header.Set(headerAssertion, scanAssertion(t, key, count, image))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- request(1, id) }()
	<-polling
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() { second <- request(2, base64.RawURLEncoding.EncodeToString(hash[:])) }()
	// Observe the second signed request crossing the real persisted replay gate
	// before allowing the accepted Azure operation to finish.
	for {
		_, n, err := store.GetKey(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if n == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	close(finish)
	a, b := <-first, <-second
	want := http.StatusOK
	if failFirstPoll {
		want = http.StatusBadGateway
	}
	if a.Code != want || b.Code != want || posts.Load() != 1 {
		t.Fatalf("joined statuses=%d/%d Azure POSTs=%d", a.Code, b.Code, posts.Load())
	}
	var accepted scanEnvelope
	if failFirstPoll {
		accepted.Raw = json.RawMessage(`{"status":"succeeded","analyzeResult":{"merchant":"synthetic"}}`)
	} else {
		if err := json.Unmarshal(a.Body.Bytes(), &accepted); err != nil {
			t.Fatal(err)
		}
	}
	// Discard both HTTP responses and all server A result state. Server B has
	// a separate real SDK client and empty coalescer; only durable state and
	// the accepted provider operation can recover the result.
	a, b = nil, nil
	srv.coalescer = nil
	recoverPoll.Store(true)
	other, err := fsstore.NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	providerB, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "local-fixture", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	srv = newServerWithGate(other, providerB, slog.Default(), nil, &ocrSpendGate{store: other, idempotencyTTL: time.Hour, window: time.Hour, attestedLimit: 2})
	h = srv.routes()
	w := request(3, id) // fresh signature/counter, never replay a prior assertion
	if w.Code != 200 || posts.Load() != 1 {
		t.Fatalf("restart duplicate=%d Azure POSTs=%d", w.Code, posts.Load())
	}
	var recovered scanEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &recovered); err != nil || !bytes.Equal(accepted.Raw, recovered.Raw) {
		t.Fatalf("restart result differs: accepted=%s recovered=%s err=%v", accepted.Raw, recovered.Raw, err)
	}
	if _, n, err := other.GetKey(ctx, id); err != nil || n != 3 {
		t.Fatalf("counter=%d err=%v", n, err)
	}
	if err := other.CreateKey(ctx, id, spki, 0); err != attest.ErrAlreadyExists {
		t.Fatalf("registration overwrite=%v", err)
	}
	// All controls use fresh assertions. Clear B's successful local cache so
	// the denial/recovery decision must exercise the durable boundary.
	srv.coalescer = newScanCoalescer(defaultScanCoalesceTTL, time.Now)
	srv.spendGate.killSwitch = true
	if w := request(4, id); w.Code != 429 {
		t.Fatalf("kill-switch recovery=%d", w.Code)
	}
	srv.spendGate.killSwitch = false
	srv.spendGate.store = &unavailableDurableRecovery{other}
	if w := request(5, id); w.Code != 429 {
		t.Fatalf("durable-store-error recovery=%d", w.Code)
	}
	srv.spendGate.store = &unavailableRateStore{newMemorySpendStore(time.Now)}
	if w := request(6, id); w.Code != 429 {
		t.Fatalf("rate-store-error recovery=%d", w.Code)
	}
	srv.spendGate.store = other
	image = []byte("new-image-at-rate-cap")
	if w := request(7, id); w.Code != 429 {
		t.Fatalf("new image bypassed cap=%d", w.Code)
	}
	// A legacy/ambiguous reservation with no accepted operation remains a
	// durable no-resubmit fence, even when new-work rate allowance is available.
	srv.spendGate.attestedLimit = 100
	if fresh, err := srv.spendGate.Reserve(ctx, "attest:"+id, image); err != nil || !fresh {
		t.Fatalf("synthetic old reservation=%v/%v", fresh, err)
	}
	if w := request(8, id); w.Code != 429 {
		t.Fatalf("no-reference reservation resubmitted=%d", w.Code)
	}
	if err := other.RecordOCROperation(ctx, "attest:"+id, scanImageKey(image), "http://untrusted.invalid/operation"); err != nil {
		t.Fatal(err)
	}
	if w := request(9, id); w.Code != 502 {
		t.Fatalf("malformed operation recovery=%d", w.Code)
	}
	if fresh, err := srv.spendGate.Reserve(ctx, "attest:"+id, image); err != nil || fresh {
		t.Fatalf("malformed reference released reservation=%v/%v", fresh, err)
	}
	if w := request(3, id); w.Code != 403 {
		t.Fatalf("replayed assertion accepted=%d", w.Code)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/ocr/scan", bytes.NewReader(image)))
	if w.Code != 400 || posts.Load() != 1 {
		t.Fatalf("no-auth status=%d provider POSTs=%d", w.Code, posts.Load())
	}
	t.Logf("two fresh servers / two separate real SDK clients / fresh counter3 / same result / fixture POSTs=%d / first-poll-failed=%v", posts.Load(), failFirstPoll)
}
