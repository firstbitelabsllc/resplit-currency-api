// Package attest implements the Apple App Attest verification flow used by the
// OCR service: a one-time device ATTESTATION (per device) and a per-request
// ASSERTION gate. The cryptographic logic is a faithful port of the working JS
// verifier under worker/src/ocr/.
//
// The package exposes two free functions — VerifyAttestation and
// VerifyAssertion — over a small Store interface, so it builds and is
// unit-testable without any cloud dependency. External state (Firestore) and the
// OCR provider (Azure Document Intelligence) live behind interfaces the caller
// supplies.
//
// This file owns the shared verification primitives: the Store interface, the
// Error type, AssertionInput + VerifyAssertion, authData parsing, COSE→ECDSA key
// conversion, base64 decoding, the nonce OID + nonceFromCert, and the
// constant-time/concat helpers. The once-per-device attestation path lives in
// attestation.go and reuses everything here.
package attest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"

	"github.com/fxamacker/cbor/v2"
)

// AppID is the Apple App ID (teamID.bundleID) bound into the attestation.
// rpIdHash in authenticator data must equal SHA256(AppID). teamID is the App ID
// prefix under the app's CURRENT team: ASC seedId QSL6XFT438 (FirstBite Labs LLC)
// is the source of truth. GXS8378HLM was the pre-transfer Superfit prefix and is
// STALE for attest — do not revert.
const AppID = "QSL6XFT438.com.superfit.Resplit"

// appAttestNonceOID is the certificate extension OID Apple stamps into the
// credCert carrying the attestation nonce. The nonce is the trailing 32 bytes of
// the DER extension value.
var appAttestNonceOID = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}

// Error is the structured verification failure returned by both verify paths.
// Code is a short, stable token (e.g. "REPLAY", "SIG", "UNKNOWN_KEY", "RPID")
// callers may switch on or map to HTTP status; Msg is human-readable detail.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return "attest: " + e.Code + ": " + e.Msg }

// attestErr builds an *Error with a formatted message.
func attestErr(code, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// ErrUnknownKey is returned by a Store when a keyID has no attested record.
// Store implementations should return this (wrapped or bare) from GetKey.
var ErrUnknownKey = &Error{Code: "UNKNOWN_KEY", Msg: "attested key not found"}

// Store abstracts the Firestore-backed attest_keys state.
//
// GetKey loads an attested key's SPKI public key and current signCount; it must
// surface ErrUnknownKey when the keyID is absent. PutKey persists (or replaces)
// a key with the given SPKI and signCount.
//
// TODO(gcp): provide a *firestore.Client-backed implementation in cmd/ocr.
type Store interface {
	GetKey(ctx context.Context, keyID string) (pubSPKI []byte, signCount uint32, err error)
	PutKey(ctx context.Context, keyID string, pubSPKI []byte, signCount uint32) error
}

// AssertionInput is the per-request payload verified at /ocr/scan.
type AssertionInput struct {
	// KeyID identifies the attested device key.
	KeyID string
	// AssertionB64 is the base64 (std or url) CBOR assertion
	// {signature, authenticatorData}.
	AssertionB64 string
	// ClientData is the raw bytes the device signed over (the image body).
	ClientData []byte
	// AppID is the Apple App ID; rpIdHash must equal SHA256(AppID).
	AppID string
}

// assertion is the CBOR map sent to /ocr/scan: a DER ECDSA signature plus the
// WebAuthn-style authenticatorData blob.
type assertion struct {
	Signature []byte `cbor:"signature"`
	AuthData  []byte `cbor:"authenticatorData"`
}

// VerifyAssertion verifies a per-request assertion and, on success, advances the
// stored signCount (replay guard). The signed message is
// (authenticatorData || SHA256(clientData)); the ECDSA-SHA256 signature is
// verified with ecdsa.VerifyASN1 over SHA256 of that message.
//
// Steps:
//  1. base64-decode + CBOR-decode the assertion.
//  2. parse authData; rpIdHash == SHA256(appID).
//  3. load the stored key; signCount must STRICTLY advance (replay guard).
//  4. verify ECDSA-SHA256(authData || SHA256(clientData)) against the stored key.
//  5. persist the advanced signCount.
func VerifyAssertion(ctx context.Context, in AssertionInput, store Store) error {
	raw, err := decodeBase64(in.AssertionB64)
	if err != nil {
		return attestErr("ASSERT_B64", "assertion not valid base64: %v", err)
	}

	var as assertion
	if err := cbor.Unmarshal(raw, &as); err != nil {
		return attestErr("CBOR_BAD", "assertion CBOR decode failed: %v", err)
	}
	if len(as.Signature) == 0 || len(as.AuthData) == 0 {
		return attestErr("ASSERT_SHAPE", "assertion missing signature/authenticatorData")
	}

	ad, err := parseAuthData(as.AuthData)
	if err != nil {
		return err
	}

	expectedRPID := sha256.Sum256([]byte(in.AppID))
	if subtle.ConstantTimeCompare(ad.rpIDHash, expectedRPID[:]) != 1 {
		return attestErr("RPID", "rpIdHash != sha256(appId)")
	}

	spki, signCount, err := store.GetKey(ctx, in.KeyID)
	if err != nil {
		// Preserve a structured *Error (e.g. ErrUnknownKey) when the Store
		// returns one; otherwise wrap as UNKNOWN_KEY.
		var ae *Error
		if errors.As(err, &ae) {
			return ae
		}
		return attestErr("UNKNOWN_KEY", "store GetKey failed: %v", err)
	}

	// signCount must strictly advance (replay guard).
	if ad.signCount <= signCount {
		return attestErr("REPLAY", "signCount %d does not advance stored %d", ad.signCount, signCount)
	}

	pub, err := parseECDSAPublicKey(spki)
	if err != nil {
		return attestErr("KEY", "stored SPKI parse failed: %v", err)
	}

	// signed message = authenticatorData || SHA256(clientData); verify
	// ECDSA-SHA256 over it (VerifyASN1 takes the SHA256 digest of that message).
	clientDataHash := sha256.Sum256(in.ClientData)
	digest := sha256.Sum256(concat(as.AuthData, clientDataHash[:]))
	if !ecdsa.VerifyASN1(pub, digest[:], as.Signature) {
		return attestErr("SIG", "assertion signature invalid")
	}

	if err := store.PutKey(ctx, in.KeyID, spki, ad.signCount); err != nil {
		return attestErr("STORE", "store PutKey failed: %v", err)
	}
	return nil
}

// ---- authenticator data ------------------------------------------------------

// authData is the parsed view of the WebAuthn-style authenticatorData blob,
// shared by both verify paths. For assertions only the 37-byte header is
// present; for attestations the attested-credential-data (AAGUID, credID, COSE
// public key) follows.
type authData struct {
	rpIDHash      []byte
	flags         byte
	signCount     uint32
	hasCredential bool
	aaguid        []byte
	credentialID  []byte
	publicKeyCOSE []byte
	raw           []byte
}

// parseAuthData parses the authenticatorData blob. The fixed header is
// rpIdHash(32) || flags(1) || signCount(4 big-endian) = 37 bytes. When the
// attested-credential-data flag (AT, bit 6 / 0x40) is set, the AAGUID, credId
// and COSE public key are parsed out as well.
func parseAuthData(raw []byte) (*authData, error) {
	if len(raw) < 37 {
		return nil, attestErr("AUTHDATA", "authData too short (%d bytes)", len(raw))
	}
	ad := &authData{
		rpIDHash:  raw[0:32],
		flags:     raw[32],
		signCount: binary.BigEndian.Uint32(raw[33:37]),
		raw:       raw,
	}

	// AT flag (bit 6) signals attested-credential-data presence.
	if ad.flags&0x40 == 0 {
		return ad, nil
	}

	// Attested credential data:
	// aaguid(16) || credIdLen(2) || credId(L) || COSE public key (rest).
	rest := raw[37:]
	if len(rest) < 18 {
		return nil, attestErr("AUTHDATA", "attested cred data too short")
	}
	ad.aaguid = rest[0:16]
	credIDLen := int(binary.BigEndian.Uint16(rest[16:18]))
	rest = rest[18:]
	if len(rest) < credIDLen {
		return nil, attestErr("AUTHDATA", "credId overruns authData")
	}
	ad.hasCredential = true
	ad.credentialID = rest[:credIDLen]
	ad.publicKeyCOSE = rest[credIDLen:]
	return ad, nil
}

// ---- COSE / SPKI key conversion ---------------------------------------------

// coseEC2Key is the subset of the COSE_Key map we care about for EC2 P-256.
// kty(1)=2 (EC2), alg(3)=-7 (ES256), crv(-1)=1 (P-256), x(-2), y(-3).
type coseEC2Key struct {
	Kty int    `cbor:"1,keyasint"`
	Alg int    `cbor:"3,keyasint"`
	Crv int    `cbor:"-1,keyasint"`
	X   []byte `cbor:"-2,keyasint"`
	Y   []byte `cbor:"-3,keyasint"`
}

// publicKeyFromCOSE converts a COSE EC2 P-256 key (from authData) into an
// *ecdsa.PublicKey.
func publicKeyFromCOSE(coseKey []byte) (*ecdsa.PublicKey, error) {
	var k coseEC2Key
	if err := cbor.Unmarshal(coseKey, &k); err != nil {
		return nil, attestErr("COSE", "cose key decode failed: %v", err)
	}
	if k.Kty != 2 || k.Crv != 1 {
		return nil, attestErr("COSE", "not an EC2 P-256 key (kty=%d crv=%d)", k.Kty, k.Crv)
	}
	if len(k.X) != 32 || len(k.Y) != 32 {
		return nil, attestErr("COSE", "bad EC point length (x=%d y=%d)", len(k.X), len(k.Y))
	}
	pub := &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(k.X),
		Y:     new(big.Int).SetBytes(k.Y),
	}
	if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
		return nil, attestErr("COSE", "point not on P-256")
	}
	return pub, nil
}

// parseECDSAPublicKey parses a DER SPKI public key into an *ecdsa.PublicKey,
// requiring a P-256 curve.
func parseECDSAPublicKey(spki []byte) (*ecdsa.PublicKey, error) {
	parsed, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return nil, err
	}
	pub, ok := parsed.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("stored key is not ECDSA")
	}
	if pub.Curve != elliptic.P256() {
		return nil, errors.New("stored key is not P-256")
	}
	return pub, nil
}

// ---- base64 ------------------------------------------------------------------

// decodeBase64 accepts both standard and URL-safe base64, padded or unpadded —
// mirroring the Worker's b64ToBytes which normalised -/_ before atob.
func decodeBase64(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.New("not valid standard or url-safe base64")
	}
	return b, nil
}

// ---- nonce extension + small helpers ----------------------------------------

// nonceFromCert pulls the 32-byte App Attest nonce from the credCert extension.
// The extension value is DER: SEQUENCE { [1] EXPLICIT OCTET STRING(nonce) }, so
// the nonce is the trailing 32 bytes — matching the Worker's slice logic.
func nonceFromCert(cert *x509.Certificate) ([]byte, bool) {
	for _, ext := range cert.Extensions {
		if ext.Id.Equal(appAttestNonceOID) {
			v := ext.Value
			if len(v) < sha256.Size {
				return nil, false
			}
			return v[len(v)-sha256.Size:], true
		}
	}
	return nil, false
}

// concat returns a fresh slice holding a followed by b.
func concat(a, b []byte) []byte {
	out := make([]byte, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}
