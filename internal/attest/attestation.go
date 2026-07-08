// App Attest once-per-device ATTESTATION verification (the heavy path).
//
// Validates that a Secure-Enclave key was genuinely produced by an unmodified
// instance of THIS app on a real Apple device: CBOR decode -> X.509 chain to
// Apple's App Attest root -> nonce extension -> authData/rpId checks. Runs ONCE
// per install at /ocr/attest, never on the per-scan hot path.
//
// Faithful port of worker/src/ocr/attestation.mjs, swapping @peculiar/x509 for
// Go's crypto/x509 + crypto/ecdsa. No third-party X.509 dependency — this file is
// the proof that the Go standard library replaces the @peculiar/x509 hack
// cleanly. The shared primitives (parseAuthData, nonceFromCert, decodeBase64,
// publicKeyFromCOSE, the nonce OID, concat, the Error type) live in attest.go.

package attest

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/pem"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// appleAppAttestRootCAPEM is the Apple App Attest Root CA (P-384 / ECDSA-SHA384),
// a public certificate. https://www.apple.com/certificateauthority/
//
// This is the single embedded copy of the root used by the whole package.
const appleAppAttestRootCAPEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEA3QdpV7nMrLgQ8cVjVe2lUgF4MzqYI7uFNrLn
1cCVi8q5OY7vJSXvOZsxNF1aQ8h2
-----END CERTIFICATE-----`

// appleRootPool lazily parses the embedded Apple root into a verify pool. A
// parse failure here is a build-time programming error in the embedded constant.
var appleRootPool = func() *x509.CertPool {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(appleAppAttestRootCAPEM)) {
		panic("attest: failed to parse embedded Apple App Attest root CA")
	}
	return pool
}()

// appleRootPEMBlock is a defensive sanity hook: decodes the embedded PEM so a
// malformed constant surfaces immediately during package init if ever edited.
var _ = func() *pem.Block {
	b, _ := pem.Decode([]byte(appleAppAttestRootCAPEM))
	if b == nil {
		panic("attest: embedded Apple root PEM is malformed")
	}
	return b
}()

// AttestationInput is the once-per-device payload verified at /ocr/attest.
type AttestationInput struct {
	// KeyID identifies the new device key (becomes the Firestore doc id).
	KeyID string
	// AttestationObjectB64 is the base64 (std or url) CBOR attestationObject.
	AttestationObjectB64 string
	// Challenge is the server-issued challenge string the client attested over.
	Challenge string
	// AppID is the Apple App ID, e.g. "QSL6XFT438.com.superfit.Resplit".
	AppID string
}

// attestationObject is the decoded App Attest attestationObject.
type attestationObject struct {
	Fmt      string               `cbor:"fmt"`
	AttStmt  attestationStatement `cbor:"attStmt"`
	AuthData []byte               `cbor:"authData"`
}

// attestationStatement is the apple-appattest attStmt: an x5c cert array plus a
// receipt we don't consume here.
type attestationStatement struct {
	X5C     [][]byte `cbor:"x5c"`
	Receipt []byte   `cbor:"receipt"`
}

// VerifyAttestation verifies a device attestation and registers its P-256 public
// key in the Store. Runs ONCE per install.
//
// Steps (faithful to the Worker):
//  1. CBOR decode; fmt must be "apple-appattest".
//  2. x5c[0] (credCert) chains to the embedded Apple App Attest root.
//  3. nonce = SHA256(authData || SHA256(challenge)) equals the credCert nonce
//     extension (OID 1.2.840.113635.100.8.2; nonce = trailing 32 bytes).
//  4. authData: rpIdHash == SHA256(appID), signCount == 0, attested key present.
//  5. Extract the COSE EC2 P-256 key, store as SPKI with signCount 0.
func VerifyAttestation(ctx context.Context, in AttestationInput, store Store) error {
	raw, err := decodeBase64(in.AttestationObjectB64)
	if err != nil {
		return attestErr("ATT_B64", "attestationObject not valid base64: %v", err)
	}

	var att attestationObject
	if err := cbor.Unmarshal(raw, &att); err != nil {
		return attestErr("CBOR_BAD", "attestationObject CBOR decode failed: %v", err)
	}
	if att.Fmt != "apple-appattest" {
		return attestErr("FMT", "unexpected fmt %q", att.Fmt)
	}
	if len(att.AttStmt.X5C) < 1 || len(att.AuthData) == 0 {
		return attestErr("ATT_SHAPE", "attestation missing x5c/authData")
	}

	// 1. credCert chains to the Apple App Attest root (via any provided
	//    intermediates).
	credCert, err := x509.ParseCertificate(att.AttStmt.X5C[0])
	if err != nil {
		return attestErr("CHAIN", "credCert parse failed: %v", err)
	}
	intermediates := x509.NewCertPool()
	for _, der := range att.AttStmt.X5C[1:] {
		ic, err := x509.ParseCertificate(der)
		if err != nil {
			return attestErr("CHAIN", "intermediate parse failed: %v", err)
		}
		intermediates.AddCert(ic)
	}
	if _, err := credCert.Verify(x509.VerifyOptions{
		Roots:         appleRootPool,
		Intermediates: intermediates,
		// App Attest leaf certs carry no EKU; allow any so chain-building does
		// not reject on extended-key-usage mismatch.
		KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
		CurrentTime: time.Now(),
	}); err != nil {
		return attestErr("CHAIN", "cert chain did not validate to Apple root: %v", err)
	}

	// 2. nonce = SHA256(authData || SHA256(challenge)) == credCert extension.
	challengeHash := sha256.Sum256([]byte(in.Challenge))
	expectedNonce := sha256.Sum256(concat(att.AuthData, challengeHash[:]))
	extNonce, ok := nonceFromCert(credCert)
	if !ok {
		return attestErr("NONCE", "missing app-attest nonce extension")
	}
	if subtle.ConstantTimeCompare(extNonce, expectedNonce[:]) != 1 {
		return attestErr("NONCE", "nonce mismatch")
	}

	// 3. authData checks.
	ad, err := parseAuthData(att.AuthData)
	if err != nil {
		return err
	}
	expectedRPID := sha256.Sum256([]byte(in.AppID))
	if subtle.ConstantTimeCompare(ad.rpIDHash, expectedRPID[:]) != 1 {
		return attestErr("RPID", "rpIdHash != sha256(appId)")
	}
	if ad.signCount != 0 {
		return attestErr("COUNT", "initial signCount must be 0 (got %d)", ad.signCount)
	}
	if !ad.hasCredential || len(ad.publicKeyCOSE) == 0 {
		return attestErr("NOKEY", "attested credential data missing")
	}

	// 4. Extract the COSE EC2 P-256 key and store its SPKI encoding.
	pub, err := publicKeyFromCOSE(ad.publicKeyCOSE)
	if err != nil {
		return err
	}
	spki, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return attestErr("KEY", "SPKI marshal failed: %v", err)
	}
	if err := store.PutKey(ctx, in.KeyID, spki, 0); err != nil {
		return attestErr("STORE", "store PutKey failed: %v", err)
	}
	return nil
}
