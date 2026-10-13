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
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	fsstore "github.com/firstbitelabsllc/resplit-currency-api/internal/firestore"
)

func TestEmulatorAuthenticatedScanRecovery(t *testing.T) {
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
	polling := make(chan struct{})
	finish := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.Header().Set("Operation-Location", "http://"+r.Host+"/poll")
			w.WriteHeader(202)
			return
		}
		close(polling)
		<-finish
		io.WriteString(w, `{"status":"succeeded","analyzeResult":{"merchant":"synthetic"}}`)
	}))
	defer upstream.Close()
	provider, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "local-fixture", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	gate := &ocrSpendGate{store: store, idempotencyTTL: time.Hour, window: time.Hour, attestedLimit: 10}
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
	if a.Code != 200 || b.Code != 200 || posts.Load() != 1 {
		t.Fatalf("joined statuses=%d/%d Azure POSTs=%d", a.Code, b.Code, posts.Load())
	}
	// Simulate cache/process loss on a separate real SDK connection. The same
	// canonical identity must retain its durable spend slot across aliases.
	other, err := fsstore.NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	srv = newServerWithGate(other, provider, slog.Default(), nil, &ocrSpendGate{store: other, idempotencyTTL: time.Hour, window: time.Hour, attestedLimit: 10})
	h = srv.routes()
	if w := request(3, id); w.Code != 429 || posts.Load() != 1 {
		t.Fatalf("restart duplicate=%d Azure POSTs=%d", w.Code, posts.Load())
	}
	if _, n, err := other.GetKey(ctx, id); err != nil || n != 3 {
		t.Fatalf("counter=%d err=%v", n, err)
	}
	if err := other.CreateKey(ctx, id, spki, 0); err != attest.ErrAlreadyExists {
		t.Fatalf("registration overwrite=%v", err)
	}
}
