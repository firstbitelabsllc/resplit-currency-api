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
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	"github.com/fxamacker/cbor/v2"
)

func scanAssertion(t *testing.T, key *ecdsa.PrivateKey, count uint32, image []byte) string {
	t.Helper()
	rpID := sha256.Sum256([]byte(attest.AppID))
	auth := make([]byte, 37)
	copy(auth, rpID[:])
	binary.BigEndian.PutUint32(auth[33:], count)
	imageHash := sha256.Sum256(image)
	digest := sha256.Sum256(append(auth, imageHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := cbor.Marshal(map[string][]byte{"signature": signature, "authenticatorData": auth[:37]})
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

func TestScanKeyIDAliasesShareAccounting(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := key.PublicKey.ECDH()
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(public.Bytes())
	canonical := base64.StdEncoding.EncodeToString(hash[:])
	store := attest.NewMemStore()
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutKey(context.Background(), canonical, spki, 0); err != nil {
		t.Fatal(err)
	}
	gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), window: time.Hour, idempotencyTTL: time.Hour, attestedLimit: 1}
	provider := &countingProvider{}
	handler := newServerWithGate(store, provider, slog.Default(), nil, gate).routes()
	aliases := []string{canonical, base64.RawURLEncoding.EncodeToString(hash[:]), base64.RawStdEncoding.EncodeToString(hash[:]), base64.URLEncoding.EncodeToString(hash[:])}
	for i, keyID := range aliases {
		image := []byte{byte(i), 1, 2}
		request := httptest.NewRequest(http.MethodPost, "/ocr/scan", bytes.NewReader(image))
		request.Header.Set(headerKeyID, keyID)
		request.Header.Set(headerAssertion, scanAssertion(t, key, uint32(i+1), image))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		want := http.StatusTooManyRequests
		if i == 0 {
			want = http.StatusOK
		}
		if recorder.Code != want {
			t.Fatalf("encoding %q: status %d, want %d; %s", keyID, recorder.Code, want, recorder.Body.String())
		}
	}
	if provider.calls != 1 {
		t.Fatalf("provider calls %d, want one", provider.calls)
	}
	if len(gate.mem.rates) != 1 {
		t.Fatalf("aliases minted %d accounting identities", len(gate.mem.rates))
	}
	_, counter, err := store.GetKey(context.Background(), canonical)
	if err != nil || counter != uint32(len(aliases)) {
		t.Fatalf("shared counter=%d err=%v", counter, err)
	}
}

type unavailableRateStore struct{ *memorySpendStore }

type unavailableReservationReadStore struct{ *memorySpendStore }

func (s *unavailableReservationReadStore) HasOCRReservation(context.Context, string, string) (bool, error) {
	return false, errors.New("synthetic reservation read unavailable")
}

func (s *unavailableReservationReadStore) GetOCROperation(context.Context, string, string) (string, error) {
	return "", errors.New("synthetic reservation read unavailable")
}

func (s *unavailableRateStore) AllowRate(context.Context, string, time.Duration, int64) (bool, int64, error) {
	return false, 0, errors.New("synthetic rate store unavailable")
}

func TestScanFinalAllowanceRecoversOnlyAuthenticatedIdentityImage(t *testing.T) {
	store := attest.NewMemStore()
	keys := make([]*ecdsa.PrivateKey, 2)
	ids := make([]string, 2)
	for i := range keys {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys[i] = key
		public, _ := key.PublicKey.ECDH()
		hash := sha256.Sum256(public.Bytes())
		ids[i] = base64.StdEncoding.EncodeToString(hash[:])
		spki, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
		if err := store.CreateKey(context.Background(), ids[i], spki, 0); err != nil {
			t.Fatal(err)
		}
	}
	gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), window: time.Hour, idempotencyTTL: time.Hour, attestedLimit: 1}
	provider := &heldProvider{started: make(chan struct{}), finish: make(chan struct{})}
	srv := newServerWithGate(store, provider, slog.Default(), nil, gate)
	h := srv.routes()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request := func(ctx context.Context, who int, count uint32, image string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/ocr/scan", bytes.NewBufferString(image)).WithContext(ctx)
		r.Header.Set(headerKeyID, ids[who])
		r.Header.Set(headerAssertion, scanAssertion(t, keys[who], count, []byte(image)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	owner := make(chan *httptest.ResponseRecorder, 1)
	go func() { owner <- request(ctx, 0, 1, "accepted-receipt") }()
	<-provider.started // the owner's one rate allowance and reservation are used
	// Cache/image knowledge never admits new work or another capped identity.
	if w := request(ctx, 0, 2, "different-receipt"); w.Code != 429 {
		t.Errorf("capped new image=%d", w.Code)
	}
	gate.mem.AllowRate(ctx, "attest:"+ids[1], time.Hour, 1)
	if w := request(ctx, 1, 1, "accepted-receipt"); w.Code != 429 {
		t.Errorf("capped foreign identity=%d", w.Code)
	}
	gate.killSwitch = true
	if w := request(ctx, 0, 3, "accepted-receipt"); w.Code != 429 {
		t.Errorf("kill-switch recovery=%d", w.Code)
	}
	gate.killSwitch = false
	gate.store = &unavailableRateStore{gate.mem}
	if w := request(ctx, 0, 4, "accepted-receipt"); w.Code != 429 {
		t.Errorf("rate-error recovery=%d", w.Code)
	}
	gate.store = nil
	unauth := httptest.NewRecorder()
	h.ServeHTTP(unauth, httptest.NewRequest(http.MethodPost, "/ocr/scan", bytes.NewBufferString("accepted-receipt")))
	if unauth.Code != 400 {
		t.Errorf("unauthenticated recovery=%d", unauth.Code)
	}
	waiterCtx, cancelWaiter := context.WithCancel(ctx)
	cancelWaiter()
	if w := request(waiterCtx, 0, 5, "accepted-receipt"); w.Code != 502 {
		t.Errorf("cancelled capped waiter=%d", w.Code)
	}
	joined := make(chan *httptest.ResponseRecorder, 1)
	go func() { joined <- request(ctx, 0, 6, "accepted-receipt") }()
	var early *httptest.ResponseRecorder
	select {
	case early = <-joined:
		t.Errorf("capped retry did not join existing work: status=%d", early.Code)
	case <-time.After(100 * time.Millisecond):
	}
	close(provider.finish)
	if w := <-owner; w.Code != 200 {
		t.Errorf("owner=%d", w.Code)
	}
	if early == nil {
		if w := <-joined; w.Code != 200 {
			t.Errorf("joined retry=%d", w.Code)
		}
	}
	if w := request(ctx, 0, 7, "accepted-receipt"); w.Code != 200 {
		t.Errorf("completed capped retry=%d", w.Code)
	}
	if w := request(ctx, 1, 2, "accepted-receipt"); w.Code != 429 {
		t.Errorf("foreign identity read completed image without own reservation=%d", w.Code)
	}
	if w := request(ctx, 0, 1, "accepted-receipt"); w.Code != 403 {
		t.Errorf("replayed assertion read cached result=%d", w.Code)
	}
	if provider.calls.Load() != 1 {
		t.Errorf("provider submissions=%d", provider.calls.Load())
	}
	// Every authenticated request still crosses rate accounting; this narrow
	// recovery exception never refunds counts or creates a second spend slot.
	gate.mem.mu.Lock()
	count := gate.mem.rates[rateMemoryKey("attest:"+ids[0], gate.mem.now(), time.Hour)]
	gate.mem.mu.Unlock()
	if count != 5 { // kill switch and rate-store failure do not increment
		t.Errorf("rate attempts=%d, want5", count)
	}
	srv.coalescer = newScanCoalescer(time.Minute, nil)
	if w := request(ctx, 0, 8, "accepted-receipt"); w.Code != 429 {
		t.Errorf("cache loss at cap=%d", w.Code)
	}
	gate.attestedLimit = 100
	if w := request(ctx, 0, 9, "accepted-receipt"); w.Code != 429 || provider.calls.Load() != 1 {
		t.Errorf("cache loss under new allowance=%d submits=%d", w.Code, provider.calls.Load())
	}
}

type delayedScanBody struct {
	*bytes.Reader
	started chan struct{}
	resume  chan struct{}
}

func (b *delayedScanBody) Read(p []byte) (int, error) {
	select {
	case <-b.started:
	default:
		close(b.started)
		<-b.resume
	}
	return b.Reader.Read(p)
}

func TestScanReservedJoinerRecoversSharedSuccessAfterEarlierDeadline(t *testing.T) {
	store := attest.NewMemStore()
	keys := make([]*ecdsa.PrivateKey, 2)
	ids := make([]string, 2)
	for i := range keys {
		keys[i], _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		pub, _ := keys[i].PublicKey.ECDH()
		hash := sha256.Sum256(pub.Bytes())
		ids[i] = base64.StdEncoding.EncodeToString(hash[:])
		spki, _ := x509.MarshalPKIXPublicKey(&keys[i].PublicKey)
		if err := store.CreateKey(context.Background(), ids[i], spki, 0); err != nil {
			t.Fatal(err)
		}
	}
	var posts atomic.Int64
	accepted, finish := make(chan struct{}), make(chan struct{})
	var once sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.Header().Set("Operation-Location", "http://"+r.Host+"/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/local-operation?api-version=2024-11-30")
			w.WriteHeader(202)
			return
		}
		once.Do(func() { close(accepted) })
		select {
		case <-finish:
			io.WriteString(w, `{"status":"succeeded","analyzeResult":{}}`)
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	provider, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "fixture", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), window: time.Hour, idempotencyTTL: time.Hour, attestedLimit: 1}
	srv := newServerWithGate(store, provider, slog.Default(), nil, gate)
	srv.workTimeout = 2 * time.Second
	h := srv.routes()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	image := []byte("shared-accepted-image")
	request := func(who int, count uint32, body io.Reader) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/ocr/scan", body).WithContext(ctx)
		r.Header.Set(headerKeyID, ids[who])
		r.Header.Set(headerAssertion, scanAssertion(t, keys[who], count, image))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	slow := &delayedScanBody{Reader: bytes.NewReader(image), started: make(chan struct{}), resume: make(chan struct{})}
	joiner := make(chan *httptest.ResponseRecorder, 1)
	go func() { joiner <- request(0, 1, slow) }()
	<-slow.started
	time.Sleep(time.Second) // same budget, earlier handler entry than the owner
	owner := make(chan *httptest.ResponseRecorder, 1)
	go func() { owner <- request(1, 1, bytes.NewReader(image)) }()
	<-accepted
	close(slow.resume)
	if w := <-joiner; w.Code != 502 {
		t.Errorf("earlier joiner=%d", w.Code)
	}
	// The earlier waiter keeps its own accepted-operation reference. Completing
	// the provider then discarding the entire coalescer must still recover it.
	close(finish)
	if w := <-owner; w.Code != 200 {
		t.Errorf("owner=%d", w.Code)
	}
	srv.coalescer = newScanCoalescer(defaultScanCoalesceTTL, time.Now)
	if w := request(0, 3, bytes.NewReader(image)); w.Code != 200 {
		t.Errorf("reserved completed retry=%d", w.Code)
	}
	// Force a durable lookup; store failures cannot admit polling/recovery.
	srv.coalescer = newScanCoalescer(defaultScanCoalesceTTL, time.Now)
	gate.store = &unavailableReservationReadStore{gate.mem}
	if w := request(0, 4, bytes.NewReader(image)); w.Code != 429 {
		t.Errorf("reservation-error recovery=%d", w.Code)
	}
	gate.store = nil
	gate.killSwitch = true
	if w := request(0, 5, bytes.NewReader(image)); w.Code != 429 {
		t.Errorf("kill recovery=%d", w.Code)
	}
	gate.killSwitch = false
	gate.store = &unavailableRateStore{gate.mem}
	if w := request(0, 6, bytes.NewReader(image)); w.Code != 429 {
		t.Errorf("store-error recovery=%d", w.Code)
	}
	gate.store = nil
	// Local-cache expiry/loss now recover the retained accepted operation, but
	// expiry of the reservation itself must still deny recovery and new spend.
	srv.coalescer.now = func() time.Time { return time.Now().Add(2 * defaultScanCoalesceTTL) }
	if w := request(0, 7, bytes.NewReader(image)); w.Code != 200 {
		t.Errorf("expired result=%d", w.Code)
	}
	srv.coalescer = newScanCoalescer(time.Minute, nil)
	gate.attestedLimit = 100
	if w := request(0, 8, bytes.NewReader(image)); w.Code != 200 {
		t.Errorf("cache-loss retry=%d", w.Code)
	}
	if fresh, err := gate.Reserve(ctx, "attest:"+ids[0], image); err != nil || fresh {
		t.Errorf("reservation released=%v/%v", fresh, err)
	}
	srv.coalescer = newScanCoalescer(time.Minute, nil)
	gate.mem.mu.Lock()
	gate.mem.seen["attest:"+ids[0]+":"+scanImageKey(image)] = time.Now().Add(-time.Second)
	gate.mem.mu.Unlock()
	gate.attestedLimit = 1
	if w := request(0, 9, bytes.NewReader(image)); w.Code != 429 {
		t.Errorf("expired reservation recovery=%d", w.Code)
	}
	if posts.Load() != 1 {
		t.Errorf("provider POSTs=%d", posts.Load())
	}
}

func TestAttestationStoreFailsClosed(t *testing.T) {
	t.Setenv("FIRESTORE_EMULATOR_HOST", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", t.TempDir()+"/missing-credentials.json")
	store, err := newAttestationStore(context.Background(), "synthetic-no-network-project", true)
	if err == nil || store != nil {
		t.Fatalf("constructor failure must not return MemStore: store=%T err=%v", store, err)
	}
	store, err = newAttestationStore(context.Background(), "", true)
	if err == nil || store != nil {
		t.Fatalf("Cloud Run without project must refuse: store=%T err=%v", store, err)
	}
	store, err = newAttestationStore(context.Background(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.(*attest.MemStore); !ok {
		t.Fatalf("local no-project store=%T", store)
	}
}
