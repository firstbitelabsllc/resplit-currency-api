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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
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

func TestAttestationStoreFailsClosed(t *testing.T) {
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
