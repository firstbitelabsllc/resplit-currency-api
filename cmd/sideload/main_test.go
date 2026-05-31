package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	return newServer(slog.Default()).routes()
}

func TestHealthz(t *testing.T) {
	handler := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["service"] != "sideload" {
		t.Errorf("service = %v, want sideload", body["service"])
	}
}

func TestReconcile(t *testing.T) {
	handler := newTestServer(t)

	// Three sources agree on USD (2-of-3 quorum holds); GBP appears in only one
	// source, so it fails to reach the agreement threshold and is an outlier.
	raw := []byte(`{
		"minAgree": 2,
		"sources": [
			{"Source": "ecb", "Date": "2026-05-30", "Rates": {"USD": 1.0850, "GBP": 0.8600}},
			{"Source": "boe", "Date": "2026-05-30", "Rates": {"USD": 1.0851}},
			{"Source": "oer", "Date": "2026-05-30", "Rates": {"USD": 1.0849}}
		]
	}`)

	req := httptest.NewRequest(http.MethodPost, "/fx/reconcile", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp reconcileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, ok := resp.Rates["USD"]; !ok {
		t.Errorf("USD missing from agreed rates: %v", resp.Rates)
	}
	if _, ok := resp.Rates["GBP"]; ok {
		t.Errorf("GBP should be an outlier, not agreed: %v", resp.Rates)
	}
}

func TestReconcileEmptyRejected(t *testing.T) {
	handler := newTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/fx/reconcile", bytes.NewReader([]byte(`{"sources":[]}`)))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for empty sources", rec.Code)
	}
}

func TestCross(t *testing.T) {
	handler := newTestServer(t)

	raw := []byte(`{"rates": {"USD": 1.0850, "GBP": 0.8600}, "from": "USD", "to": "GBP"}`)
	req := httptest.NewRequest(http.MethodPost, "/fx/cross", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp crossResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	// USD->GBP = rates[GBP]/rates[USD] = 0.8600 / 1.0850 ≈ 0.79263.
	want := 0.8600 / 1.0850
	if diff := resp.Rate - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("rate = %v, want ~%v", resp.Rate, want)
	}
}

func TestCrossUnknownCurrency(t *testing.T) {
	handler := newTestServer(t)

	raw := []byte(`{"rates": {"USD": 1.0850}, "from": "USD", "to": "JPY"}`)
	req := httptest.NewRequest(http.MethodPost, "/fx/cross", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for unknown currency", rec.Code)
	}
}
