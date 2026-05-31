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
