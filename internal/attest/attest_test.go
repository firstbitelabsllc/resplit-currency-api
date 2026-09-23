package attest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

const testAppID = "QSL6XFT438.com.superfit.Resplit"

// fakeStore is an in-memory Store for tests. It mirrors the Firestore
// attest_keys collection: keyID -> (SPKI pubkey, signCount).
type fakeStore struct {
	mu      sync.Mutex
	records map[string]fakeRecord
}

type fakeRecord struct {
	spki      []byte
	signCount uint32
}

func newFakeStore() *fakeStore {
	return &fakeStore{records: make(map[string]fakeRecord)}
}

func (s *fakeStore) GetKey(_ context.Context, keyID string) ([]byte, uint32, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[keyID]
	if !ok {
		return nil, 0, ErrUnknownKey
	}
	return r.spki, r.signCount, nil
}

func (s *fakeStore) PutKey(_ context.Context, keyID string, pubSPKI []byte, signCount uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[keyID] = fakeRecord{spki: pubSPKI, signCount: signCount}
	return nil
}

func (s *fakeStore) CreateKey(_ context.Context, keyID string, pubSPKI []byte, signCount uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[keyID]; ok {
		return ErrAlreadyExists
	}
	s.records[keyID] = fakeRecord{spki: pubSPKI, signCount: signCount}
	return nil
}

// buildAuthData assembles the 37-byte assertion authenticatorData:
// rpIdHash(32) || flags(1) || signCount(4 big-endian).
func buildAuthData(appID string, signCount uint32) []byte {
	rpIDHash := sha256.Sum256([]byte(appID))
	out := make([]byte, 0, 37)
	out = append(out, rpIDHash[:]...)
	out = append(out, 0x00) // flags
	var sc [4]byte
	binary.BigEndian.PutUint32(sc[:], signCount)
	out = append(out, sc[:]...)
	return out
}

// signAssertion produces a CBOR assertion {signature, authenticatorData} where
// signature is DER ECDSA-SHA256 over SHA256(authData || SHA256(clientData)),
// signed by key. This is exactly what the iOS App Attest assertion path emits.
func signAssertion(t *testing.T, key *ecdsa.PrivateKey, authData, clientData []byte) []byte {
	t.Helper()
	clientDataHash := sha256.Sum256(clientData)
	signed := append(append([]byte{}, authData...), clientDataHash[:]...)
	digest := sha256.Sum256(signed)
	der, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}
	cborBytes, err := cbor.Marshal(map[string]any{
		"signature":         der,
		"authenticatorData": authData,
	})
	if err != nil {
		t.Fatalf("cbor.Marshal: %v", err)
	}
	return cborBytes
}

// registerKey stores the device public key as SPKI with an initial signCount.
func registerKey(t *testing.T, store Store, keyID string, key *ecdsa.PrivateKey, signCount uint32) {
	t.Helper()
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey: %v", err)
	}
	if err := store.PutKey(context.Background(), keyID, spki, signCount); err != nil {
		t.Fatalf("PutKey: %v", err)
	}
}

func genKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return key
}

func TestVerifyAssertion(t *testing.T) {
	ctx := context.Background()
	const keyID = "device-key-1"
	clientData := []byte("the raw image bytes for /ocr/scan")

	t.Run("accepts genuine assertion", func(t *testing.T) {
		store := newFakeStore()
		key := genKey(t)
		registerKey(t, store, keyID, key, 0)

		authData := buildAuthData(testAppID, 1)
		assertion := signAssertion(t, key, authData, clientData)

		in := AssertionInput{
			KeyID:        keyID,
			AssertionB64: base64.StdEncoding.EncodeToString(assertion),
			ClientData:   clientData,
			AppID:        testAppID,
		}
		if err := VerifyAssertion(ctx, in, store); err != nil {
			t.Fatalf("expected accept, got %v", err)
		}

		// stored signCount must have advanced to 1.
		_, sc, err := store.GetKey(ctx, keyID)
		if err != nil {
			t.Fatalf("GetKey: %v", err)
		}
		if sc != 1 {
			t.Fatalf("signCount not bumped: got %d want 1", sc)
		}
	})

	t.Run("rejects replayed signCount", func(t *testing.T) {
		store := newFakeStore()
		key := genKey(t)
		// Stored signCount is already 5; an assertion at 5 must be rejected as a
		// replay (strictly-greater guard), and one at 3 too.
		registerKey(t, store, keyID, key, 5)

		for _, sc := range []uint32{5, 3} {
			authData := buildAuthData(testAppID, sc)
			assertion := signAssertion(t, key, authData, clientData)
			in := AssertionInput{
				KeyID:        keyID,
				AssertionB64: base64.StdEncoding.EncodeToString(assertion),
				ClientData:   clientData,
				AppID:        testAppID,
			}
			err := VerifyAssertion(ctx, in, store)
			if err == nil {
				t.Fatalf("signCount=%d: expected REPLAY reject, got nil", sc)
			}
			var ae *Error
			if !errors.As(err, &ae) || ae.Code != "REPLAY" {
				t.Fatalf("signCount=%d: expected REPLAY, got %v", sc, err)
			}
		}
	})

	t.Run("rejects wrong-key signature", func(t *testing.T) {
		store := newFakeStore()
		registeredKey := genKey(t)
		attackerKey := genKey(t)
		registerKey(t, store, keyID, registeredKey, 0)

		// Sign with the attacker key but verify against the registered key.
		authData := buildAuthData(testAppID, 1)
		assertion := signAssertion(t, attackerKey, authData, clientData)
		in := AssertionInput{
			KeyID:        keyID,
			AssertionB64: base64.StdEncoding.EncodeToString(assertion),
			ClientData:   clientData,
			AppID:        testAppID,
		}
		err := VerifyAssertion(ctx, in, store)
		if err == nil {
			t.Fatal("expected SIG reject, got nil")
		}
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "SIG" {
			t.Fatalf("expected SIG, got %v", err)
		}
	})

	t.Run("rejects tampered clientData", func(t *testing.T) {
		store := newFakeStore()
		key := genKey(t)
		registerKey(t, store, keyID, key, 0)

		// Sign over the real clientData, but submit different clientData — the
		// signature no longer matches the recomputed signed message.
		authData := buildAuthData(testAppID, 1)
		assertion := signAssertion(t, key, authData, clientData)
		in := AssertionInput{
			KeyID:        keyID,
			AssertionB64: base64.StdEncoding.EncodeToString(assertion),
			ClientData:   []byte("tampered image bytes — different from what was signed"),
			AppID:        testAppID,
		}
		err := VerifyAssertion(ctx, in, store)
		if err == nil {
			t.Fatal("expected SIG reject on tampered clientData, got nil")
		}
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "SIG" {
			t.Fatalf("expected SIG, got %v", err)
		}
	})

	t.Run("rejects unknown key", func(t *testing.T) {
		store := newFakeStore()
		key := genKey(t)
		authData := buildAuthData(testAppID, 1)
		assertion := signAssertion(t, key, authData, clientData)
		in := AssertionInput{
			KeyID:        "never-registered",
			AssertionB64: base64.StdEncoding.EncodeToString(assertion),
			ClientData:   clientData,
			AppID:        testAppID,
		}
		err := VerifyAssertion(ctx, in, store)
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "UNKNOWN_KEY" {
			t.Fatalf("expected UNKNOWN_KEY, got %v", err)
		}
	})

	t.Run("rejects rpIdHash mismatch", func(t *testing.T) {
		store := newFakeStore()
		key := genKey(t)
		registerKey(t, store, keyID, key, 0)

		// authData built for a different appID -> rpIdHash won't match.
		authData := buildAuthData("WRONGTEAM.com.example.Other", 1)
		assertion := signAssertion(t, key, authData, clientData)
		in := AssertionInput{
			KeyID:        keyID,
			AssertionB64: base64.StdEncoding.EncodeToString(assertion),
			ClientData:   clientData,
			AppID:        testAppID,
		}
		err := VerifyAssertion(ctx, in, store)
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "RPID" {
			t.Fatalf("expected RPID, got %v", err)
		}
	})
}

// TestParseAuthData covers the WebAuthn header parse used by both paths.
func TestParseAuthData(t *testing.T) {
	t.Run("parses 37-byte assertion header", func(t *testing.T) {
		ad, err := parseAuthData(buildAuthData(testAppID, 42))
		if err != nil {
			t.Fatalf("parseAuthData: %v", err)
		}
		if ad.signCount != 42 {
			t.Fatalf("signCount: got %d want 42", ad.signCount)
		}
		if ad.hasCredential {
			t.Fatal("assertion authData should have no attested credential data")
		}
		want := sha256.Sum256([]byte(testAppID))
		if string(ad.rpIDHash) != string(want[:]) {
			t.Fatal("rpIdHash mismatch")
		}
	})

	t.Run("rejects short authData", func(t *testing.T) {
		if _, err := parseAuthData([]byte{0x00, 0x01}); err == nil {
			t.Fatal("expected error for short authData")
		}
	})
}

// TestAppleRootEmbedded proves the embedded Apple root PEM parses with crypto/x509
// — the core claim that Go stdlib replaces @peculiar/x509 with no shim.
func TestAppleRootEmbedded(t *testing.T) {
	if appleRootPool == nil {
		t.Fatal("appleRootPool is nil")
	}
	// Re-parse directly to assert identity properties.
	blk, _ := pem.Decode([]byte(appleAppAttestRootCAPEM))
	if blk == nil {
		t.Fatal("PEM decode failed")
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}
	if cert.Subject.CommonName != "Apple App Attestation Root CA" {
		t.Fatalf("unexpected CN: %q", cert.Subject.CommonName)
	}
	if !cert.IsCA {
		t.Fatal("root cert should be a CA")
	}
	if cert.PublicKeyAlgorithm != x509.ECDSA {
		t.Fatalf("expected ECDSA public key, got %v", cert.PublicKeyAlgorithm)
	}
}

// TestRegisterAttestedKeyBlocksSignCountReset pins the Go Cloud Run gap vs the
// Worker: challenges are stateless, so a captured /ocr/attest body could be
// replayed. Unconditional PutKey(0) would reset an advanced counter and
// re-admit old assertions. Create-only registration must leave signCount alone.
func TestRegisterAttestedKeyBlocksSignCountReset(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey: %v", err)
	}
	const keyID = "attest-replay-kid"

	if err := registerAttestedKey(ctx, store, keyID, spki); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if err := store.PutKey(ctx, keyID, spki, 50); err != nil {
		t.Fatalf("advance signCount: %v", err)
	}

	// Captured attest replay: same keyId + SPKI must succeed idempotently…
	if err := registerAttestedKey(ctx, store, keyID, spki); err != nil {
		t.Fatalf("idempotent re-register: %v", err)
	}
	// …without resetting the counter.
	_, sc, err := store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if sc != 50 {
		t.Fatalf("signCount after re-attest = %d, want 50 (must not reset to 0)", sc)
	}

	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey other: %v", err)
	}
	otherSPKI, err := x509.MarshalPKIXPublicKey(&other.PublicKey)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey other: %v", err)
	}
	err = registerAttestedKey(ctx, store, keyID, otherSPKI)
	var ae *Error
	if !errors.As(err, &ae) || ae.Code != "ALREADY" {
		t.Fatalf("expected ALREADY for foreign SPKI, got %v", err)
	}
	_, sc, err = store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey after foreign attempt: %v", err)
	}
	if sc != 50 {
		t.Fatalf("signCount after foreign re-attest = %d, want 50", sc)
	}
}

func TestMemStoreCreateKeyIsAtomic(t *testing.T) {
	store := NewMemStore()
	const keyID = "race-kid"
	spki := []byte{0x30, 0x01}

	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.CreateKey(context.Background(), keyID, spki, 0); err == nil {
				wins.Add(1)
			} else if !errors.Is(err, ErrAlreadyExists) {
				t.Errorf("unexpected CreateKey error: %v", err)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("CreateKey winners = %d, want exactly 1", wins.Load())
	}
}
