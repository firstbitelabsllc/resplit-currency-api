package attest

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"math/big"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	const keyID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
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
			KeyID:        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
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

func mustP256Cert(t *testing.T, key *ecdsa.PrivateKey) *x509.Certificate {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}
	return cert
}

func keyIDForPub(t *testing.T, pub *ecdsa.PublicKey) string {
	t.Helper()
	ecdhPub, err := pub.ECDH()
	if err != nil {
		t.Fatalf("ECDH: %v", err)
	}
	sum := sha256.Sum256(ecdhPub.Bytes())
	return base64.StdEncoding.EncodeToString(sum[:])
}

// TestBindAttestKeyID pins the Apple/Worker keyId binding that the Go Cloud Run
// path previously omitted: without it, one real attestationObject can be stored
// under arbitrary keyIds and each becomes an independent OCR spend identity.
func TestBindAttestKeyID(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	cert := mustP256Cert(t, key)
	goodKeyID := keyIDForPub(t, &key.PublicKey)
	goodKeyIDBytes, err := base64.StdEncoding.DecodeString(goodKeyID)
	if err != nil {
		t.Fatalf("DecodeString: %v", err)
	}

	t.Run("accepts matching keyId and credentialId", func(t *testing.T) {
		if err := bindAttestKeyID(goodKeyID, cert, goodKeyIDBytes); err != nil {
			t.Fatalf("bindAttestKeyID: %v", err)
		}
	})

	t.Run("rejects keyId that is not sha256(credCert public key)", func(t *testing.T) {
		bogus := make([]byte, 32)
		for i := range bogus {
			bogus[i] = 7
		}
		bogusID := base64.StdEncoding.EncodeToString(bogus)
		err := bindAttestKeyID(bogusID, cert, bogus)
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "KEYID" {
			t.Fatalf("expected KEYID, got %v", err)
		}
	})

	t.Run("rejects credentialId mismatch", func(t *testing.T) {
		other := make([]byte, 32)
		for i := range other {
			other[i] = 9
		}
		err := bindAttestKeyID(goodKeyID, cert, other)
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != "KEYID" {
			t.Fatalf("expected KEYID, got %v", err)
		}
	})
}

// All accepted base64 spellings must use the same persisted replay counter.
func TestVerifyAssertionEquivalentKeyID(t *testing.T) {
	ctx := context.Background()
	key := genKey(t)
	canonical := keyIDForPub(t, &key.PublicKey)
	decoded, err := base64.StdEncoding.DecodeString(canonical)
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemStore()
	registerKey(t, store, canonical, key, 7)
	image := []byte("synthetic receipt, no provider")
	aliases := []string{base64.RawStdEncoding.EncodeToString(decoded), base64.URLEncoding.EncodeToString(decoded), base64.RawURLEncoding.EncodeToString(decoded)}
	for i, alias := range aliases {
		counter := uint32(8 + i)
		signed := signAssertion(t, key, buildAuthData(testAppID, counter), image)
		input := AssertionInput{KeyID: alias, AssertionB64: base64.StdEncoding.EncodeToString(signed), ClientData: image, AppID: testAppID}
		if err := VerifyAssertion(ctx, input, store); err != nil {
			t.Fatalf("equivalent key encoding %q must use registered identity: %v", alias, err)
		}
		_, got, err := store.GetKey(ctx, canonical)
		if err != nil || got != counter {
			t.Fatalf("canonical counter = %d, error %v; want %d", got, err, counter)
		}
		input.KeyID = canonical
		var replay *Error
		if err := VerifyAssertion(ctx, input, store); !errors.As(err, &replay) || replay.Code != "REPLAY" {
			t.Fatalf("encoding change must not replay counter %d: %v", counter, err)
		}
	}
	if len(store.records) != 1 {
		t.Fatalf("aliases minted %d stored keys; want one", len(store.records))
	}
}

// A local X.509 chain supplies a faithful attestation fixture. This tests the
// production verifier against synthetic certificates, not Apple/device use.
func testAttestation(t *testing.T) (string, string, *ecdsa.PrivateKey) {
	t.Helper()
	key, caKey := genKey(t), genKey(t)
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(2), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	oldPool := appleRootPool
	appleRootPool = pool
	t.Cleanup(func() { appleRootPool = oldPool })
	keyID := keyIDForPub(t, &key.PublicKey)
	credential, err := base64.StdEncoding.DecodeString(keyID)
	if err != nil {
		t.Fatal(err)
	}
	auth := buildAuthData(testAppID, 0)
	auth[32] = 0x40
	auth = append(auth, []byte("appattest")...)
	auth = append(auth, make([]byte, 7)...)
	auth = append(auth, 0, byte(len(credential)))
	auth = append(auth, credential...)
	cose, err := cbor.Marshal(coseEC2Key{Kty: 2, Alg: -7, Crv: 1, X: key.X.FillBytes(make([]byte, 32)), Y: key.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	auth = append(auth, cose...)
	challenge := sha256.Sum256([]byte("local challenge"))
	nonce := sha256.Sum256(concat(auth, challenge[:]))
	extension, err := asn1.Marshal(struct {
		Nonce []byte `asn1:"tag:1,explicit"`
	}{nonce[:]})
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(3), NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtraExtensions: []pkix.Extension{{Id: appAttestNonceOID, Value: extension}}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	object, err := cbor.Marshal(attestationObject{Fmt: "apple-appattest", AuthData: auth, AttStmt: attestationStatement{X5C: [][]byte{leafDER, caDER}}})
	if err != nil {
		t.Fatal(err)
	}
	return keyID, base64.StdEncoding.EncodeToString(object), key
}

func TestVerifyAttestationEquivalentKeyID(t *testing.T) {
	canonical, object, _ := testAttestation(t)
	keyBytes, err := base64.StdEncoding.DecodeString(canonical)
	if err != nil {
		t.Fatal(err)
	}
	aliases := []string{base64.RawStdEncoding.EncodeToString(keyBytes), base64.URLEncoding.EncodeToString(keyBytes), base64.RawURLEncoding.EncodeToString(keyBytes)}
	for _, alias := range aliases {
		store := NewMemStore()
		err := VerifyAttestation(context.Background(), AttestationInput{KeyID: alias, AttestationObjectB64: object, Challenge: "local challenge", AppID: testAppID}, store)
		if err != nil {
			t.Fatalf("register alias: %v", err)
		}
		if _, _, err := store.GetKey(context.Background(), canonical); err != nil {
			t.Fatalf("canonical registration missing: %v", err)
		}
		if len(store.records) != 1 {
			t.Fatalf("want one identity, got %d", len(store.records))
		}
	}
}

func TestAttestationReplayCannotResetAssertion(t *testing.T) {
	canonical, object, key := testAttestation(t)
	ctx := context.Background()
	store := NewMemStore()
	input := AttestationInput{KeyID: canonical, AttestationObjectB64: object, Challenge: "local challenge", AppID: testAppID}
	if err := VerifyAttestation(ctx, input, store); err != nil {
		t.Fatal(err)
	}
	image := []byte("synthetic image")
	signed := signAssertion(t, key, buildAuthData(testAppID, 9), image)
	assertion := AssertionInput{KeyID: canonical, AssertionB64: base64.StdEncoding.EncodeToString(signed), ClientData: image, AppID: testAppID}
	if err := VerifyAssertion(ctx, assertion, store); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(canonical)
	input.KeyID = base64.RawURLEncoding.EncodeToString(decoded)
	if err := VerifyAttestation(ctx, input, store); err != nil {
		t.Fatal(err)
	}
	_, count, err := store.GetKey(ctx, canonical)
	if err != nil || count != 9 {
		t.Fatalf("registration reset counter: got %d err %v", count, err)
	}
	var replay *Error
	if err := VerifyAssertion(ctx, assertion, store); !errors.As(err, &replay) || replay.Code != "REPLAY" {
		t.Fatalf("consumed assertion replay admitted: %v", err)
	}
}

func TestCertifiedRegistrationPreservesLegacyAliasCounter(t *testing.T) {
	canonical, object, key := testAttestation(t)
	decoded, _ := base64.StdEncoding.DecodeString(canonical)
	alias := base64.RawURLEncoding.EncodeToString(decoded)
	spki, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	store := NewMemStore()
	ctx := context.Background()
	if err := store.PutKey(ctx, alias, spki, 17); err != nil {
		t.Fatal(err)
	}
	input := AttestationInput{KeyID: canonical, AttestationObjectB64: object, Challenge: "local challenge", AppID: testAppID}
	if err := VerifyAttestation(ctx, input, store); err != nil {
		t.Fatal(err)
	}
	if _, count, err := store.GetKey(ctx, canonical); err != nil || count != 17 {
		t.Errorf("canonical counter=%d/%v", count, err)
	}
	if _, count, err := store.GetKey(ctx, alias); err != nil || count != 17 {
		t.Errorf("legacy counter=%d/%v", count, err)
	}
	image := []byte("historical receipt")
	assertion := AssertionInput{KeyID: canonical, AssertionB64: base64.StdEncoding.EncodeToString(signAssertion(t, key, buildAuthData(testAppID, 17), image)), ClientData: image, AppID: testAppID}
	if err := VerifyAssertion(ctx, assertion, store); err == nil {
		t.Error("legacy consumed assertion replay admitted")
	}
	assertion.AssertionB64 = base64.StdEncoding.EncodeToString(signAssertion(t, key, buildAuthData(testAppID, 18), image))
	if err := VerifyAssertion(ctx, assertion, store); err != nil {
		t.Errorf("fresh post-reconciliation assertion=%v", err)
	}
	// A legacy alias with another public key is never blindly trusted or merged.
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	wrongSPKI, _ := x509.MarshalPKIXPublicKey(&other.PublicKey)
	conflict := NewMemStore()
	conflict.PutKey(ctx, alias, wrongSPKI, 23)
	if err := VerifyAttestation(ctx, input, conflict); err == nil {
		t.Error("conflicting legacy key reconciled")
	}
	if _, _, err := conflict.GetKey(ctx, canonical); !errors.Is(err, ErrUnknownKey) {
		t.Error("conflict minted canonical key")
	}
}

func TestKeyIDAliasesCoverAcceptedHeaderSpellings(t *testing.T) {
	raw := bytes.Repeat([]byte{255}, 32)
	id := base64.StdEncoding.EncodeToString(raw)
	aliases, err := KeyIDAliases(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliases) != 16 {
		t.Fatalf("expected std/url padded/raw and four padbit variants, got%d", len(aliases))
	}
	for _, alias := range aliases {
		got, err := CanonicalKeyID(alias)
		if err != nil || got != id {
			t.Fatalf("alias%q -> %q/%v", alias, got, err)
		}
	}
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

func (s *fakeStore) AdvanceSignCount(_ context.Context, keyID string, next uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[keyID]
	if !ok {
		return ErrUnknownKey
	}
	if next <= r.signCount {
		return attestErr("REPLAY", "signCount %d does not advance stored %d", next, r.signCount)
	}
	r.signCount = next
	s.records[keyID] = r
	return nil
}

// TestVerifyAssertion_ConcurrentSameSignCount admits exactly one of many
// identical assertions. The pre-fix GetKey→PutKey path let every goroutine
// pass the monotonic check and bill Azure; AdvanceSignCount must serialize.
type synchronizedReadStore struct {
	*MemStore
	read    chan struct{}
	release chan struct{}
}

func (s *synchronizedReadStore) GetKey(ctx context.Context, keyID string) ([]byte, uint32, error) {
	spki, count, err := s.MemStore.GetKey(ctx, keyID)
	s.read <- struct{}{}
	<-s.release
	return spki, count, err
}
func TestVerifyAssertion_ConcurrentSameSignCount(t *testing.T) {
	ctx := context.Background()
	key := genKey(t)
	keyID := keyIDForPub(t, &key.PublicKey)
	const n = 32
	base := NewMemStore()
	registerKey(t, base, keyID, key, 10)
	store := &synchronizedReadStore{MemStore: base, read: make(chan struct{}, n), release: make(chan struct{})}
	image := []byte("synthetic race fixture")
	in := AssertionInput{KeyID: keyID, AssertionB64: base64.StdEncoding.EncodeToString(signAssertion(t, key, buildAuthData(testAppID, 11), image)), ClientData: image, AppID: testAppID}
	results := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() { results <- VerifyAssertion(ctx, in, store) }()
	}
	for i := 0; i < n; i++ {
		<-store.read
	}
	close(store.release)
	wins, replays := 0, 0
	for i := 0; i < n; i++ {
		err := <-results
		if err == nil {
			wins++
			continue
		}
		var ae *Error
		if errors.As(err, &ae) && ae.Code == "REPLAY" {
			replays++
			continue
		}
		t.Fatalf("unexpected error: %v", err)
	}
	if wins != 1 || replays != n-1 {
		t.Fatalf("atomic admission: successes=%d replays=%d; want 1 and %d", wins, replays, n-1)
	}
	_, count, err := base.GetKey(ctx, keyID)
	if err != nil || count != 11 {
		t.Fatalf("counter=%d err=%v", count, err)
	}
}

// TestVerifyAssertion_ConcurrentLowerCannotRegressCounter ensures a lower
// signCount PutKey cannot win a race after a higher advance and reopen the
// higher assertion (free OCR replay).
func TestVerifyAssertion_ConcurrentLowerCannotRegressCounter(t *testing.T) {
	ctx := context.Background()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	const keyID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	store := NewMemStore()
	registerKey(t, store, keyID, key, 10)

	clientData := []byte("image-for-regress-race")
	lowAuth := buildAuthData(testAppID, 11)
	highAuth := buildAuthData(testAppID, 12)
	lowIn := AssertionInput{
		KeyID:        keyID,
		AssertionB64: base64.StdEncoding.EncodeToString(signAssertion(t, key, lowAuth, clientData)),
		ClientData:   clientData,
		AppID:        testAppID,
	}
	highIn := AssertionInput{
		KeyID:        keyID,
		AssertionB64: base64.StdEncoding.EncodeToString(signAssertion(t, key, highAuth, clientData)),
		ClientData:   clientData,
		AppID:        testAppID,
	}

	// Run many interleaved attempts so a non-atomic PutKey regression would
	// occasionally leave signCount at 11 after 12 had already succeeded.
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = VerifyAssertion(ctx, highIn, store)
		}()
		go func() {
			defer wg.Done()
			_ = VerifyAssertion(ctx, lowIn, store)
		}()
	}
	wg.Wait()

	_, sc, err := store.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if sc != 12 {
		t.Fatalf("signCount = %d, want 12 (must not regress to 11)", sc)
	}

	// Higher assertion is consumed; replaying it must fail.
	if err := VerifyAssertion(ctx, highIn, store); err == nil {
		t.Fatal("expected REPLAY on consumed high assertion")
	}
}
