package sideload

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

// fakeSigner is a deterministic Signer for tests — no GCP creds required. It
// records the last string-to-sign so assertions can inspect the canonical V4
// input, and returns a fixed signature.
type fakeSigner struct {
	keyName  string
	sig      []byte
	lastSign []byte
	signErr  error
}

func (f *fakeSigner) KeyName() string { return f.keyName }

func (f *fakeSigner) Sign(_ context.Context, toSign []byte) ([]byte, error) {
	f.lastSign = append([]byte(nil), toSign...)
	if f.signErr != nil {
		return nil, f.signErr
	}
	return f.sig, nil
}

func newFakeSigner() *fakeSigner {
	return &fakeSigner{
		keyName: "sideload-run@resplit-fx-prod.iam.gserviceaccount.com",
		sig:     []byte{0xde, 0xad, 0xbe, 0xef},
	}
}

// fixedClock pins the V4 timestamp so the produced URL is deterministic.
var fixedClock = time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)

func TestBuildSignedURL_UploadShape(t *testing.T) {
	signer := newFakeSigner()

	object, err := ObjectKey("KEY-ABC", "20260531T120000-0011223344")
	if err != nil {
		t.Fatalf("ObjectKey: %v", err)
	}

	got, err := BuildSignedURL(context.Background(), signer, SignRequest{
		Bucket:  "resplit-sideload-prod",
		Object:  object,
		Method:  MethodPut,
		Expires: 15 * time.Minute,
		SignedHeaders: map[string]string{
			"content-type":   "image/jpeg",
			"content-length": "204800",
		},
		now: fixedClock,
	})
	if err != nil {
		t.Fatalf("BuildSignedURL: %v", err)
	}

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("produced URL does not parse: %v (%q)", err, got)
	}

	// Virtual-hosted host = bucket + storage.googleapis.com.
	if want := "resplit-sideload-prod.storage.googleapis.com"; u.Host != want {
		t.Errorf("host = %q, want %q", u.Host, want)
	}
	if u.Scheme != "https" {
		t.Errorf("scheme = %q, want https", u.Scheme)
	}

	// Per-device namespace must appear in the path.
	wantPrefix := "/users/" + DeviceNamespace("KEY-ABC") + "/photos/"
	if !strings.HasPrefix(u.Path, wantPrefix) {
		t.Errorf("path = %q, want prefix %q", u.Path, wantPrefix)
	}

	q := u.Query()
	checks := map[string]string{
		"X-Goog-Algorithm": "GOOG4-RSA-SHA256",
		"X-Goog-Expires":   "900",
		"X-Goog-Date":      "20260531T120000Z",
	}
	for k, want := range checks {
		if got := q.Get(k); got != want {
			t.Errorf("query %s = %q, want %q", k, got, want)
		}
	}

	// Credential scope = SA / date / auto / storage / goog4_request.
	cred := q.Get("X-Goog-Credential")
	if !strings.HasPrefix(cred, signer.keyName+"/20260531/auto/storage/goog4_request") {
		t.Errorf("X-Goog-Credential = %q, missing expected scope", cred)
	}

	// content-type + content-length are baked into the SIGNED headers.
	signed := q.Get("X-Goog-SignedHeaders")
	for _, h := range []string{"content-length", "content-type", "host"} {
		if !strings.Contains(signed, h) {
			t.Errorf("X-Goog-SignedHeaders = %q, missing %q", signed, h)
		}
	}

	// Signature is the hex of the fake signer's output.
	if got := q.Get("X-Goog-Signature"); got != "deadbeef" {
		t.Errorf("X-Goog-Signature = %q, want deadbeef", got)
	}

	// The signer must have been asked to sign a GOOG4 string-to-sign whose
	// first line is the algorithm and whose third line is the credential scope.
	sts := string(signer.lastSign)
	lines := strings.Split(sts, "\n")
	if len(lines) != 4 {
		t.Fatalf("string-to-sign should have 4 lines, got %d: %q", len(lines), sts)
	}
	if lines[0] != "GOOG4-RSA-SHA256" {
		t.Errorf("string-to-sign line0 = %q, want GOOG4-RSA-SHA256", lines[0])
	}
	if lines[1] != "20260531T120000Z" {
		t.Errorf("string-to-sign line1 = %q, want timestamp", lines[1])
	}
	if lines[2] != "20260531/auto/storage/goog4_request" {
		t.Errorf("string-to-sign line2 = %q, want credential scope", lines[2])
	}
}

func TestBuildSignedURL_GetAndDelete(t *testing.T) {
	signer := newFakeSigner()
	object, _ := ObjectKey("device-1", "photo-xyz")

	for _, m := range []Method{MethodGet, MethodDelete} {
		got, err := BuildSignedURL(context.Background(), signer, SignRequest{
			Bucket: "b", Object: object, Method: m, Expires: 10 * time.Minute, now: fixedClock,
		})
		if err != nil {
			t.Fatalf("method %s: %v", m, err)
		}
		if !strings.HasPrefix(got, "https://b.storage.googleapis.com/users/") {
			t.Errorf("method %s url = %q, unexpected prefix", m, got)
		}
		if !strings.Contains(got, "X-Goog-Signature=deadbeef") {
			t.Errorf("method %s url = %q, missing signature", m, got)
		}
	}
}

func TestBuildSignedURL_Clamps(t *testing.T) {
	signer := newFakeSigner()
	object, _ := ObjectKey("k", "p")

	got, err := BuildSignedURL(context.Background(), signer, SignRequest{
		Bucket: "b", Object: object, Method: MethodGet,
		Expires: 30 * 24 * time.Hour, // over the 7-day max
		now:     fixedClock,
	})
	if err != nil {
		t.Fatalf("BuildSignedURL: %v", err)
	}
	u, _ := url.Parse(got)
	if got := u.Query().Get("X-Goog-Expires"); got != "604800" {
		t.Errorf("expiry not clamped to 7d: X-Goog-Expires = %q, want 604800", got)
	}
}

func TestBuildSignedURL_Validation(t *testing.T) {
	signer := newFakeSigner()
	cases := []struct {
		name string
		req  SignRequest
	}{
		{"empty bucket", SignRequest{Object: "users/x/photos/y", Method: MethodGet}},
		{"empty object", SignRequest{Bucket: "b", Method: MethodGet}},
		{"bad method", SignRequest{Bucket: "b", Object: "users/x/photos/y", Method: Method("POST")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := BuildSignedURL(context.Background(), signer, tc.req); err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
		})
	}

	if _, err := BuildSignedURL(context.Background(), nil, SignRequest{
		Bucket: "b", Object: "users/x/photos/y", Method: MethodGet,
	}); err == nil {
		t.Fatal("expected error for nil signer")
	}
}

func TestObjectKey_Namespacing(t *testing.T) {
	a, err := ObjectKey("keyA", "p1")
	if err != nil {
		t.Fatalf("ObjectKey A: %v", err)
	}
	b, err := ObjectKey("keyB", "p1")
	if err != nil {
		t.Fatalf("ObjectKey B: %v", err)
	}
	// Same photo id under different keys must land in different namespaces.
	if a == b {
		t.Fatalf("namespaces collided across keys: %q == %q", a, b)
	}
	wantA := "users/" + DeviceNamespace("keyA") + "/photos/p1"
	if a != wantA {
		t.Errorf("ObjectKey(keyA, p1) = %q, want %q", a, wantA)
	}
	// Namespace segment is a fixed-length sha256 hex (64 chars).
	if len(DeviceNamespace("keyA")) != 64 {
		t.Errorf("DeviceNamespace length = %d, want 64", len(DeviceNamespace("keyA")))
	}
}

func TestObjectKey_RejectsTraversal(t *testing.T) {
	bad := []string{"", ".", "..", "../escape", "a/b", ".hidden", "has space", "x\x00y", strings.Repeat("a", 200)}
	for _, id := range bad {
		if _, err := ObjectKey("key", id); err == nil {
			t.Errorf("ObjectKey accepted unsafe id %q", id)
		}
	}
	if _, err := ObjectKey("", "ok"); err == nil {
		t.Error("ObjectKey accepted empty key id")
	}
}

func TestSignerError_Propagates(t *testing.T) {
	signer := newFakeSigner()
	signer.signErr = context.DeadlineExceeded
	object, _ := ObjectKey("k", "p")
	if _, err := BuildSignedURL(context.Background(), signer, SignRequest{
		Bucket: "b", Object: object, Method: MethodGet, now: fixedClock,
	}); err == nil {
		t.Fatal("expected signer error to propagate")
	}
}
