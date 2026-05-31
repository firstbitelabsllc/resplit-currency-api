package obs

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestSetupNoopPathSucceeds proves the credential-free default: Setup with
// NoopExporters never errors, returns a usable Telemetry, and Shutdown is clean.
func TestSetupNoopPathSucceeds(t *testing.T) {
	ctx := context.Background()
	tel, err := Setup(ctx, Config{ServiceName: "test-svc", ServiceVersion: "abc123", Environment: "test"}, NoopExporters())
	if err != nil {
		t.Fatalf("Setup returned error on no-op path: %v", err)
	}
	if tel == nil {
		t.Fatal("Setup returned nil Telemetry")
	}
	if tel.Tracer() == nil {
		t.Fatal("Tracer() returned nil")
	}
	// Exercise every recorder method; none may panic with inert providers.
	tel.RecordHTTPRequest(ctx, "/ocr/scan", 200, 12*time.Millisecond)
	tel.RecordHTTPRequest(ctx, "/fx/{base}", 503, 3*time.Second)
	tel.SetFXSnapshotAge(ctx, 90*time.Minute)
	tel.SetFXSnapshotAge(ctx, -5*time.Second) // clamped, must not panic
	tel.AddOCRScanCost(ctx, 0.015)
	tel.AddOCRScanCost(ctx, -1) // ignored
	tel.RecordAbuseRejection(ctx, "REPLAY")
	tel.RecordAbuseRejection(ctx, "")
	tel.SetFXSourceAvailable(ctx, "ecb", true)
	tel.SetFXSourceAvailable(ctx, "openexchange", false)

	shCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := tel.Shutdown(shCtx); err != nil {
		t.Fatalf("Shutdown error: %v", err)
	}
}

// TestNilTelemetryAndRecorderAreSafe proves the nil-receiver no-op contract so
// callers running with telemetry disabled need no guards.
func TestNilTelemetryAndRecorderAreSafe(t *testing.T) {
	ctx := context.Background()
	var tel *Telemetry
	if tel.Tracer() == nil {
		t.Fatal("nil Telemetry.Tracer() should fall back to global no-op tracer")
	}
	tel.RecordHTTPRequest(ctx, "/x", 200, time.Millisecond)
	tel.SetFXSnapshotAge(ctx, time.Hour)
	tel.AddOCRScanCost(ctx, 1)
	tel.RecordAbuseRejection(ctx, "X")
	tel.SetFXSourceAvailable(ctx, "ecb", true)
	if err := tel.Shutdown(ctx); err != nil {
		t.Fatalf("nil Shutdown should be nil, got %v", err)
	}

	var rec *Recorder
	rec.RecordHTTPRequest(ctx, "/x", 500, time.Second) // must not panic
}

func TestStatusClass(t *testing.T) {
	cases := map[int]string{
		100: "1xx", 200: "2xx", 204: "2xx", 301: "3xx",
		400: "4xx", 429: "4xx", 500: "5xx", 503: "5xx",
		0: "unknown", 600: "unknown", 99: "unknown",
	}
	for code, want := range cases {
		if got := statusClass(code); got != want {
			t.Errorf("statusClass(%d) = %q, want %q", code, got, want)
		}
	}
}

func TestAbuseReasonFromError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, ""},
		{"attest replay", errors.New("attest: REPLAY: signCount did not increase"), "REPLAY"},
		{"attest unknown key", errors.New("attest: UNKNOWN_KEY: attested key not found"), "UNKNOWN_KEY"},
		{"attest rpid", errors.New("attest: RPID: rpIdHash mismatch"), "RPID"},
		{"non-attest error", errors.New("boom"), "internal"},
		{"empty code", errors.New("attest: : msg"), "internal"},
	}
	for _, c := range cases {
		if got := AbuseReasonFromError(c.err); got != c.want {
			t.Errorf("%s: AbuseReasonFromError = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestHTTPMiddlewareRecords proves the middleware captures status + route
// without panicking and passes the request through unchanged.
func TestHTTPMiddlewareRecords(t *testing.T) {
	ctx := context.Background()
	tel, err := Setup(ctx, Config{ServiceName: "mw"}, NoopExporters())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer func() { _ = tel.Shutdown(ctx) }()

	var sawBody bool
	final := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sawBody = true
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("ok"))
	})
	routeFn := func(_ *http.Request) string { return "/ocr/scan" }
	h := tel.HTTPMiddleware(routeFn)(final)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ocr/scan", nil)
	h.ServeHTTP(rec, req)

	if !sawBody {
		t.Fatal("inner handler not invoked")
	}
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status not propagated: got %d", rec.Code)
	}

	// nil-recorder middleware must be a pass-through.
	var nilRec *Recorder
	passthrough := nilRec.HTTPMiddleware(routeFn)(final)
	rec2 := httptest.NewRecorder()
	passthrough.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec2.Code != http.StatusTeapot {
		t.Fatalf("nil-recorder passthrough broke status: %d", rec2.Code)
	}
}
