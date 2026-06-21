package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	store := attest.NewMemStore()
	provider := attest.NewStubOCRProvider()
	// nil scanCounter -> newServer installs a no-op counter; keeps tests
	// network- and telemetry-free.
	return newServer(store, provider, slog.Default(), nil).routes()
}

func TestRoutes(t *testing.T) {
	handler := newTestServer(t)

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
		// check is an optional assertion on the decoded JSON body.
		check func(t *testing.T, body map[string]any)
	}{
		{
			name:       "healthz ok",
			method:     http.MethodGet,
			path:       "/healthz",
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body map[string]any) {
				if body["status"] != "ok" {
					t.Errorf("status = %v, want ok", body["status"])
				}
				if body["service"] != "ocr" {
					t.Errorf("service = %v, want ocr", body["service"])
				}
			},
		},
		{
			name:       "challenge issues a token",
			method:     http.MethodGet,
			path:       "/ocr/challenge",
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body map[string]any) {
				ch, ok := body["challenge"].(string)
				if !ok || ch == "" {
					t.Errorf("challenge missing or empty: %v", body["challenge"])
				}
			},
		},
		{
			name:       "attest without key id is rejected",
			method:     http.MethodPost,
			path:       "/ocr/attest",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown route is 404",
			method:     http.MethodGet,
			path:       "/nope",
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if rec.Header().Get("X-Request-Id") == "" {
				t.Errorf("missing X-Request-Id header on response")
			}
			if tc.check != nil {
				var body map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("decode body: %v (raw: %s)", err, rec.Body.String())
				}
				tc.check(t, body)
			}
		})
	}
}

// errProvider is a test OCRProvider that fails with a fixed error, used to
// exercise the provider_error / rate_limited scan-counter paths.
type errProvider struct{ err error }

func (p errProvider) Scan(_ context.Context, _ []byte) ([]byte, error) { return nil, p.err }

// findScanCount sums the ocr_scans_total data points whose attributes match the
// requested status + attest labels, after collecting from the manual reader.
func findScanCount(t *testing.T, reader *metric.ManualReader, status, attest string) int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	var total int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "ocr_scans_total" {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("ocr_scans_total has unexpected data type %T", m.Data)
			}
			for _, dp := range sum.DataPoints {
				gotStatus, _ := dp.Attributes.Value("status")
				gotAttest, _ := dp.Attributes.Value("attest")
				if gotStatus.AsString() == status && gotAttest.AsString() == attest {
					total += dp.Value
				}
			}
		}
	}
	return total
}

// TestScanCounterRecordsTerminalOutcomes is the regression test for the new
// ocr_scans_total metric: a soft-fail success increments {status=ok,
// attest=soft_fail} and a provider error increments {status=provider_error,...}.
// It proves the counter is wired through handleScan with the documented labels.
func TestScanCounterRecordsTerminalOutcomes(t *testing.T) {
	reader := metric.NewManualReader()
	mp := metric.NewMeterProvider(metric.WithReader(reader))
	counter, err := mp.Meter("test").Int64Counter("ocr_scans_total")
	if err != nil {
		t.Fatalf("build counter: %v", err)
	}

	// Success path (soft-fail so no assertion gate): status=ok, attest=soft_fail.
	okSrv := newServer(attest.NewMemStore(), attest.NewStubOCRProvider(), slog.Default(), counter)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ocr/scan", strings.NewReader("image-bytes"))
	req.Header.Set(headerSoftFail, "true")
	okSrv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("scan status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := findScanCount(t, reader, "ok", "soft_fail"); got != 1 {
		t.Fatalf("ocr_scans_total{status=ok,attest=soft_fail} = %d, want 1", got)
	}

	// Provider-error path: status=provider_error, attest=soft_fail.
	errSrv := newServer(attest.NewMemStore(), errProvider{err: errors.New("azure: analyze failed")}, slog.Default(), counter)
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/ocr/scan", strings.NewReader("image-bytes"))
	req2.Header.Set(headerSoftFail, "true")
	errSrv.routes().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusBadGateway {
		t.Fatalf("scan status = %d, want 502", rec2.Code)
	}
	if got := findScanCount(t, reader, "provider_error", "soft_fail"); got != 1 {
		t.Fatalf("ocr_scans_total{status=provider_error,attest=soft_fail} = %d, want 1", got)
	}

	// Rate-limited classification: a 429 provider error maps to status=rate_limited.
	rlSrv := newServer(attest.NewMemStore(), errProvider{err: errors.New("azure: analyze returned 429: quota")}, slog.Default(), counter)
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/ocr/scan", strings.NewReader("image-bytes"))
	req3.Header.Set(headerSoftFail, "true")
	rlSrv.routes().ServeHTTP(rec3, req3)
	if got := findScanCount(t, reader, "rate_limited", "soft_fail"); got != 1 {
		t.Fatalf("ocr_scans_total{status=rate_limited,attest=soft_fail} = %d, want 1", got)
	}
}

func TestChallengeUnique(t *testing.T) {
	handler := newTestServer(t)
	seen := make(map[string]struct{})
	for i := 0; i < 16; i++ {
		req := httptest.NewRequest(http.MethodGet, "/ocr/challenge", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("challenge #%d status = %d", i, rec.Code)
		}
		var body struct {
			Challenge string `json:"challenge"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if _, dup := seen[body.Challenge]; dup {
			t.Fatalf("duplicate challenge issued: %q", body.Challenge)
		}
		seen[body.Challenge] = struct{}{}
	}
}
