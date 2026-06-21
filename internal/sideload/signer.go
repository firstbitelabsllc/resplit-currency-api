// Package sideload implements the GCS V4 signed-URL minting used by the Resplit
// photo sideload service. The client never streams photo bytes through Cloud
// Run: the service mints a short-lived V4 signed URL and the device PUT/GETs the
// object directly against Google Cloud Storage. Cloud Run only signs.
//
// The actual byte-signing step (the part that needs the runtime service
// account's private key) lives behind the Signer interface so it can be:
//
//   - faked in tests (no GCP creds required), and
//   - backed in production by IAM Credentials signBlob against the Cloud Run
//     runtime service account (keyless — no JSON key on disk).
//
// The V4 canonical-request / string-to-sign construction in this file is a
// faithful, self-contained port of the AWS-SigV4-derived scheme Google uses for
// GCS (GOOG4-RSA-SHA256). It is identical to what cloud.google.com/go/storage's
// SignedURL produces; keeping it in stdlib avoids dragging the full GCS SDK (and
// its ~20 transitive modules) into the module for a single signing call.
//
// TODO(gcp): an alternative production path is to swap BuildSignedURL for
// storage.SignedURL(bucket, object, &storage.SignedURLOptions{ ... SignBytes:
// signer.Sign ... }); the Signer seam here maps 1:1 onto SignBytes. Until the
// SDK is vendored, this stdlib implementation is the live code path.
package sideload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// signingAlgorithm is the only V4 scheme GCS accepts for SA-signed URLs.
const signingAlgorithm = "GOOG4-RSA-SHA256"

// gcsHost is the virtual-hosted-style endpoint a signed URL targets. The bucket
// is the host's leftmost label so the canonical request matches what GCS
// validates on the wire.
const gcsHost = "storage.googleapis.com"

// unsignedPayload is the standard sentinel for V4 requests where the body hash
// is not pre-committed (the device streams arbitrary photo bytes on PUT).
const unsignedPayload = "UNSIGNED-PAYLOAD"

// Signer abstracts the private-key step of V4 signing: given the bytes of the
// string-to-sign, return the raw signature.
//
// Production: an IAM Credentials signBlob implementation that asks Google to
// sign with the Cloud Run runtime service account's managed key (no key
// material ever touches the process). Tests: a deterministic fake.
//
// KeyName is the fully-qualified signing identity that goes into the
// X-Goog-Credential scope — the runtime SA email for GCS V4.
type Signer interface {
	// KeyName returns the signing identity (the runtime SA email), e.g.
	// "sideload-run@resplit-fx-prod.iam.gserviceaccount.com".
	KeyName() string
	// Sign returns the signature over toSign. For GOOG4-RSA-SHA256 the result is
	// an RSASSA-PKCS1-v1_5 signature of SHA256(toSign); the returned bytes are
	// hex-encoded into the URL by the caller.
	Sign(ctx context.Context, toSign []byte) (signature []byte, err error)
}

// Method enumerates the HTTP verbs the device performs directly against GCS.
type Method string

const (
	// MethodPut mints an upload URL (device PUTs photo bytes straight to GCS).
	MethodPut Method = "PUT"
	// MethodGet mints a download URL.
	MethodGet Method = "GET"
	// MethodDelete mints a delete URL.
	MethodDelete Method = "DELETE"
)

// SignRequest is the input to BuildSignedURL.
type SignRequest struct {
	// Bucket is the destination GCS bucket (virtual-hosted host label).
	Bucket string
	// Object is the full object path within the bucket, e.g.
	// "users/<sha256(keyId)>/photos/<id>.jpg". It is percent-encoded per
	// segment by the signer; pass the raw path.
	Object string
	// Method is the HTTP verb the signed URL authorizes.
	Method Method
	// Expires is how long the URL stays valid; clamped to the V4 max of 7 days.
	Expires time.Duration
	// SignedHeaders are extra headers the device MUST send and that are baked
	// into the signature (e.g. content-type + content-length on upload). "host"
	// is always included automatically. Keys are canonicalised to lower-case.
	SignedHeaders map[string]string
	// now overrides the timestamp source (tests inject a fixed clock); zero ->
	// time.Now().UTC().
	now time.Time
}

// V4 bounds the signed-URL lifetime: GCS rejects anything over 7 days.
const (
	maxV4Expiry     = 7 * 24 * time.Hour
	defaultV4Expiry = 15 * time.Minute
)

// BuildSignedURL constructs a GOOG4-RSA-SHA256 V4 signed URL for the given
// request using signer for the private-key step. The returned URL is ready for
// the device to call directly; Cloud Run never proxies the bytes.
func BuildSignedURL(ctx context.Context, signer Signer, req SignRequest) (string, error) {
	if signer == nil {
		return "", errors.New("sideload: nil signer")
	}
	if req.Bucket == "" {
		return "", errors.New("sideload: empty bucket")
	}
	if req.Object == "" {
		return "", errors.New("sideload: empty object")
	}
	switch req.Method {
	case MethodPut, MethodGet, MethodDelete:
	default:
		return "", fmt.Errorf("sideload: unsupported method %q", req.Method)
	}

	expiry := req.Expires
	if expiry <= 0 {
		expiry = defaultV4Expiry
	}
	if expiry > maxV4Expiry {
		expiry = maxV4Expiry
	}

	now := req.now
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	timestamp := now.Format("20060102T150405Z")
	datestamp := now.Format("20060102")

	credentialScope := datestamp + "/auto/storage/goog4_request"
	credential := signer.KeyName() + "/" + credentialScope

	host := req.Bucket + "." + gcsHost

	// Canonical (lower-cased, sorted) signed-header set; "host" is mandatory.
	headers := map[string]string{"host": host}
	for k, v := range req.SignedHeaders {
		headers[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
	}
	signedHeaderNames := make([]string, 0, len(headers))
	for k := range headers {
		signedHeaderNames = append(signedHeaderNames, k)
	}
	sort.Strings(signedHeaderNames)
	signedHeadersList := strings.Join(signedHeaderNames, ";")

	var canonicalHeaders strings.Builder
	for _, name := range signedHeaderNames {
		canonicalHeaders.WriteString(name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(headers[name])
		canonicalHeaders.WriteByte('\n')
	}

	// Query parameters, sorted and individually percent-encoded.
	query := url.Values{}
	query.Set("X-Goog-Algorithm", signingAlgorithm)
	query.Set("X-Goog-Credential", credential)
	query.Set("X-Goog-Date", timestamp)
	query.Set("X-Goog-Expires", fmt.Sprintf("%d", int64(expiry.Seconds())))
	query.Set("X-Goog-SignedHeaders", signedHeadersList)
	canonicalQuery := encodeQueryV4(query)

	canonicalURI := encodeObjectPath(req.Object)

	canonicalRequest := strings.Join([]string{
		string(req.Method),
		canonicalURI,
		canonicalQuery,
		canonicalHeaders.String(),
		signedHeadersList,
		unsignedPayload,
	}, "\n")

	hashed := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		signingAlgorithm,
		timestamp,
		credentialScope,
		hex.EncodeToString(hashed[:]),
	}, "\n")

	sig, err := signer.Sign(ctx, []byte(stringToSign))
	if err != nil {
		return "", fmt.Errorf("sideload: sign string-to-sign: %w", err)
	}
	if len(sig) == 0 {
		return "", errors.New("sideload: signer returned empty signature")
	}

	signedURL := "https://" + host + canonicalURI + "?" + canonicalQuery +
		"&X-Goog-Signature=" + hex.EncodeToString(sig)
	return signedURL, nil
}

// encodeObjectPath percent-encodes each path segment of a GCS object key while
// preserving the slashes that namespace it (so "users/<h>/photos/<id>" stays a
// hierarchy). It matches GCS's canonical-URI rules (RFC 3986 unreserved set).
func encodeObjectPath(object string) string {
	segments := strings.Split(object, "/")
	for i, seg := range segments {
		segments[i] = encodeSegment(seg)
	}
	return "/" + strings.Join(segments, "/")
}

// encodeSegment percent-encodes a single path segment per RFC 3986, leaving
// the unreserved set (A-Z a-z 0-9 - _ . ~) intact — matching V4's stricter
// rules than url.PathEscape (which leaves several sub-delims unescaped).
func encodeSegment(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// encodeQueryV4 renders the query string with V4's exact encoding: keys sorted,
// each key and value percent-encoded with the unreserved set, joined by '&'.
func encodeQueryV4(values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		for _, v := range values[k] {
			parts = append(parts, encodeQueryComponent(k)+"="+encodeQueryComponent(v))
		}
	}
	return strings.Join(parts, "&")
}

// encodeQueryComponent percent-encodes a query key/value with the V4 unreserved
// set (note: '/' is NOT unreserved here, unlike in the path).
func encodeQueryComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// isUnreserved reports whether c is in RFC 3986's unreserved set.
func isUnreserved(c byte) bool {
	switch {
	case c >= 'A' && c <= 'Z',
		c >= 'a' && c <= 'z',
		c >= '0' && c <= '9':
		return true
	case c == '-' || c == '_' || c == '.' || c == '~':
		return true
	default:
		return false
	}
}

// ---- production signer (stubbed: needs runtime SA creds) --------------------

// IAMSignBlobSigner signs string-to-sign blobs via the IAM Credentials
// signBlob API against the Cloud Run runtime service account. This is the
// keyless production path: no private key material lives in the process — Google
// holds the SA's key and signs on request via Application Default Credentials.
//
// TODO(gcp): wire this against the IAM Credentials client. The minimal live
// implementation is:
//
//	import credentials "cloud.google.com/go/iam/credentials/apiv1"
//	import credentialspb "cloud.google.com/go/iam/credentials/apiv1/credentialspb"
//	c, _ := credentials.NewIamCredentialsClient(ctx)
//	resp, _ := c.SignBlob(ctx, &credentialspb.SignBlobRequest{
//	    Name:    "projects/-/serviceAccounts/" + saEmail,
//	    Payload: toSign,
//	})
//	return resp.SignedBlob, nil
//
// It is intentionally not constructed in the live server until that client +
// its transitive deps are vendored; BuildSignedURL takes any Signer, so the
// service runs today against an injected signer and swaps to this with no
// call-site change. The interface here maps 1:1 onto storage.SignedURLOptions's
// SignBytes/GoogleAccessID fields.
type IAMSignBlobSigner struct {
	// SAEmail is the runtime service account email used as GoogleAccessID.
	SAEmail string
}

// KeyName returns the runtime SA email (the V4 GoogleAccessID).
func (s *IAMSignBlobSigner) KeyName() string { return s.SAEmail }

// Sign asks IAM Credentials signBlob to sign toSign with the runtime SA key.
//
// TODO(gcp): replace the error with the SignBlob call above once the IAM
// Credentials client is vendored. Returning an error keeps the package honest:
// the live server must inject a working Signer, and tests inject a fake.
func (s *IAMSignBlobSigner) Sign(_ context.Context, _ []byte) ([]byte, error) {
	return nil, errors.New("sideload: IAMSignBlobSigner not wired — see TODO(gcp) (inject a Signer)")
}
