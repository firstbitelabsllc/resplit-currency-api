package ocrloki

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAuthorization = "Basic dXNlcjp0b2tlbg=="

type capturedLokiRequest struct {
	Authorization string
	ContentType   string
	Body          []byte
}

func TestHealth(t *testing.T) {
	loki := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("health must not call Loki")
	}))
	defer loki.Close()

	h := mustHandler(t, Config{
		LokiURL:             loki.URL + "/loki/api/v1/push",
		AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
		HTTPClient:          loki.Client(),
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "ocr-loki-forwarder" {
		t.Fatalf("health body = %#v", body)
	}
}

func TestPubSubPushForwardsOnlySafeFieldsSynchronously(t *testing.T) {
	captured := make(chan capturedLokiRequest, 1)
	loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read Loki body: %v", err)
		}
		captured <- capturedLokiRequest{
			Authorization: r.Header.Get("Authorization"),
			ContentType:   r.Header.Get("Content-Type"),
			Body:          body,
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer loki.Close()

	h := mustHandler(t, Config{
		LokiURL:             loki.URL + "/loki/api/v1/push",
		AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
		HTTPClient:          loki.Client(),
	})

	timestamp := time.Date(2026, 7, 11, 1, 3, 27, 123456789, time.UTC)
	entry := validLogEntry(timestamp)
	entry["textPayload"] = "FULL RECEIPT: SECRET LATTE 99.99"
	entry["httpRequest"] = map[string]any{"remoteIp": "203.0.113.42"}
	payload := entry["jsonPayload"].(map[string]any)
	payload["merchant"] = "SECRET LATTE"
	payload["receipt_text"] = "FULL RECEIPT 99.99"
	payload["customer_email"] = "person@example.com"
	payload["remote_ip"] = "203.0.113.42"
	payload["error"] = "provider echoed FULL RECEIPT 99.99"

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", pubSubBody(t, entry)))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
	}
	var got capturedLokiRequest
	select {
	case got = <-captured:
	default:
		t.Fatal("handler returned before the synchronous Loki request completed")
	}
	if got.Authorization != testAuthorization {
		t.Fatalf("Authorization = %q, want parsed Basic header", got.Authorization)
	}
	if got.ContentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got.ContentType)
	}

	var push struct {
		Streams []struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(got.Body, &push); err != nil {
		t.Fatalf("decode Loki push: %v (raw: %s)", err, got.Body)
	}
	if len(push.Streams) != 1 || len(push.Streams[0].Values) != 1 {
		t.Fatalf("push shape = %#v, want one stream/value", push)
	}
	wantLabels := map[string]string{
		"environment":  "production",
		"service_name": "ocr",
		"source":       "gcp_cloud_logging",
	}
	if !equalStringMap(push.Streams[0].Stream, wantLabels) {
		t.Fatalf("labels = %#v, want fixed %#v", push.Streams[0].Stream, wantLabels)
	}
	if _, ok := push.Streams[0].Stream["request_id"]; ok {
		t.Fatal("request_id must be a JSON field, not a Loki label")
	}
	if _, ok := push.Streams[0].Stream["trace_id"]; ok {
		t.Fatal("trace_id must be a JSON field, not a Loki label")
	}
	if gotTS := push.Streams[0].Values[0][0]; gotTS != strconv.FormatInt(timestamp.UnixNano(), 10) {
		t.Fatalf("Loki timestamp = %q, want %d", gotTS, timestamp.UnixNano())
	}

	var line map[string]any
	if err := json.Unmarshal([]byte(push.Streams[0].Values[0][1]), &line); err != nil {
		t.Fatalf("decode Loki JSON line: %v", err)
	}
	for key, want := range map[string]any{
		"timestamp":      timestamp.Format(time.RFC3339Nano),
		"severity":       "INFO",
		"message":        "[OCR_MONITORING] scan",
		"method":         "POST",
		"path":           "/ocr/scan",
		"request_id":     "00112233445566778899aabbccddeeff",
		"trace_id":       "ffeeddccbbaa99887766554433221100",
		"signal":         "scan",
		"status":         "ok",
		"attest":         "pass",
		"provider":       "azure-di",
		"scan_id":        "0123456789abcdef0123456789abcdef",
		"client_version": "2.2.0 (3801)",
	} {
		if gotValue := line[key]; gotValue != want {
			t.Errorf("line[%q] = %#v, want %#v", key, gotValue, want)
		}
	}

	serialized := string(got.Body)
	for _, forbidden := range []string{
		"SECRET LATTE",
		"FULL RECEIPT",
		"person@example.com",
		"203.0.113.42",
		"merchant",
		"receipt_text",
		"customer_email",
		"remote_ip",
		"httpRequest",
		"textPayload",
		"error",
	} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("Loki payload leaked forbidden field/value %q: %s", forbidden, serialized)
		}
	}
}

func TestSanitizeEntryRedactsUnreviewedValuesFromOtherwiseSafeRecords(t *testing.T) {
	entryMap := validLogEntry(time.Now().UTC())
	payload := entryMap["jsonPayload"].(map[string]any)
	payload["method"] = "PERSON@example.com"
	payload["path"] = "/receipts/person@example.com"
	payload["signal"] = "person@example.com"
	payload["status"] = "person@example.com"
	payload["attest"] = "person@example.com"
	payload["reason"] = "person@example.com"
	payload["provider"] = "person@example.com"
	payload["client_version"] = "person@example.com"
	payload["request_id"] = "Alice.Smith:5551234567"
	payload["scan_id"] = "Alice.Smith:5551234567"

	raw, err := json.Marshal(entryMap)
	if err != nil {
		t.Fatalf("encode entry: %v", err)
	}
	var entry cloudLogEntry
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatalf("decode entry: %v", err)
	}
	_, line, err := sanitizeEntry(entry, "1234567890")
	if err != nil {
		t.Fatalf("sanitize entry: %v", err)
	}
	if got := line["path"]; got != "unmatched" {
		t.Fatalf("path = %#v, want low-cardinality unmatched marker", got)
	}
	for _, key := range []string{"method", "signal", "status", "attest", "reason", "provider", "client_version", "request_id", "scan_id"} {
		if _, ok := line[key]; ok {
			t.Errorf("unreviewed %s value survived: %#v", key, line[key])
		}
	}
	serialized, err := json.Marshal(line)
	if err != nil {
		t.Fatalf("encode sanitized line: %v", err)
	}
	if strings.Contains(string(serialized), "person@example.com") {
		t.Fatalf("sanitized line leaked unreviewed input: %s", serialized)
	}
}

func TestPubSubPushReturns503UntilLokiAccepts(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		http.Error(w, "tenant unavailable", http.StatusBadGateway)
	}))
	defer loki.Close()

	h := mustHandler(t, Config{
		LokiURL:             loki.URL + "/loki/api/v1/push",
		AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
		HTTPClient:          loki.Client(),
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", pubSubBody(t, validLogEntry(time.Now().UTC()))))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 so Pub/Sub retries (body: %s)", rec.Code, rec.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("Loki calls = %d, want 1", calls)
	}
}

func TestPubSubPushRejectsRedirectAndNonLokiSuccessWithoutAcknowledging(t *testing.T) {
	tests := []struct {
		name   string
		status int
	}{
		{name: "redirect", status: http.StatusFound},
		{name: "generic 200", status: http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			redirectTargetCalls := 0
			loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/login" {
					redirectTargetCalls++
					w.WriteHeader(http.StatusOK)
					return
				}
				if tc.status == http.StatusFound {
					http.Redirect(w, r, "/login", http.StatusFound)
					return
				}
				w.WriteHeader(tc.status)
			}))
			defer loki.Close()

			h := mustHandler(t, Config{
				LokiURL:             loki.URL + "/loki/api/v1/push",
				AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
				HTTPClient:          loki.Client(),
			})
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", pubSubBody(t, validLogEntry(time.Now().UTC()))))

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 so Pub/Sub retains the message", rec.Code)
			}
			if redirectTargetCalls != 0 {
				t.Fatalf("redirect target calls = %d, want 0", redirectTargetCalls)
			}
		})
	}
}

func TestPubSubPushRejectsPoisonWithoutCallingLoki(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer loki.Close()

	h := mustHandler(t, Config{
		LokiURL:             loki.URL + "/loki/api/v1/push",
		AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
		HTTPClient:          loki.Client(),
	})

	tests := []struct {
		name       string
		body       func(t *testing.T) io.Reader
		wantStatus int
	}{
		{
			name: "invalid base64",
			body: func(t *testing.T) io.Reader {
				return strings.NewReader(`{"message":{"data":"%%%"},"subscription":"projects/p/subscriptions/s"}`)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "wrong service",
			body: func(t *testing.T) io.Reader {
				entry := validLogEntry(time.Now().UTC())
				entry["resource"].(map[string]any)["labels"].(map[string]any)["service_name"] = "not-ocr"
				return pubSubBody(t, entry)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "wrong log",
			body: func(t *testing.T) io.Reader {
				entry := validLogEntry(time.Now().UTC())
				entry["logName"] = "projects/resplit-fx-prod/logs/run.googleapis.com%2Frequests"
				return pubSubBody(t, entry)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "unknown message",
			body: func(t *testing.T) io.Reader {
				entry := validLogEntry(time.Now().UTC())
				entry["jsonPayload"].(map[string]any)["message"] = "receipt from Alice at Secret Cafe"
				return pubSubBody(t, entry)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "invalid timestamp",
			body: func(t *testing.T) io.Reader {
				entry := validLogEntry(time.Now().UTC())
				entry["timestamp"] = "not-a-timestamp"
				return pubSubBody(t, entry)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "oversized wrapper",
			body: func(t *testing.T) io.Reader {
				return strings.NewReader(`{"message":{"data":"` +
					strings.Repeat("x", maxPubSubBodyBytes+1) + `"}}`)
			},
			wantStatus: http.StatusRequestEntityTooLarge,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", tc.body(t)))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}

	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("poison messages reached Loki %d times, want 0", calls)
	}
}

func TestHandlerUsesBoundedLokiTimeout(t *testing.T) {
	loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer loki.Close()

	h := mustHandler(t, Config{
		LokiURL:             loki.URL + "/loki/api/v1/push",
		AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
		HTTPClient:          loki.Client(),
		Timeout:             20 * time.Millisecond,
	})
	started := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", pubSubBody(t, validLogEntry(time.Now().UTC()))))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", rec.Code, rec.Body.String())
	}
	if elapsed := time.Since(started); elapsed > 120*time.Millisecond {
		t.Fatalf("downstream timeout took %s, want bounded near 20ms", elapsed)
	}
}

func TestNewHandlerRejectsInsecureURLAndMalformedSecretWithoutEcho(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{
			name: "http Loki URL",
			cfg: Config{
				LokiURL:             "http://loki.example/loki/api/v1/push",
				AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
			},
		},
		{
			name: "untrusted HTTPS host",
			cfg: Config{
				LokiURL:             "https://evil.example/loki/api/v1/push",
				AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==",
			},
		},
		{
			name: "malformed authorization secret",
			cfg: Config{
				LokiURL:             "https://logs-prod-036.grafana.net/loki/api/v1/push",
				AuthorizationHeader: "Authorization=Basic%20TOP-SECRET-NOT-BASE64",
			},
		},
		{
			name: "header injection",
			cfg: Config{
				LokiURL:             "https://logs-prod-036.grafana.net/loki/api/v1/push",
				AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==%0d%0aX-Leak:secret",
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewHandler(tc.cfg)
			if err == nil {
				t.Fatal("NewHandler succeeded, want configuration error")
			}
			for _, secret := range []string{"TOP-SECRET", "dXNlcjp0b2tlbg==", "X-Leak"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("configuration error echoed secret material: %v", err)
				}
			}
		})
	}
}

func TestAuthorizationParserPreservesPlusInBase64(t *testing.T) {
	credential := "u:tok~"
	encoded := base64.StdEncoding.EncodeToString([]byte(credential))
	if !strings.Contains(encoded, "+") {
		t.Fatalf("test credential base64 %q must exercise literal plus", encoded)
	}
	got, err := parseAuthorizationHeader("Authorization=Basic%20" + encoded)
	if err != nil {
		t.Fatalf("parse authorization: %v", err)
	}
	if want := "Basic " + encoded; got != want {
		t.Fatalf("authorization = %q, want %q", got, want)
	}
}

func mustHandler(t *testing.T, cfg Config) http.Handler {
	t.Helper()
	cfg.AllowTestEndpoint = true
	h, err := NewHandler(cfg)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h
}

func pubSubBody(t *testing.T, entry map[string]any) io.Reader {
	t.Helper()
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("encode log entry: %v", err)
	}
	wrapper := map[string]any{
		"message": map[string]any{
			"data":        base64.StdEncoding.EncodeToString(data),
			"messageId":   "1234567890",
			"publishTime": "2026-07-11T01:03:28Z",
		},
		"subscription": "projects/resplit-fx-prod/subscriptions/ocr-loki-push",
	}
	body, err := json.Marshal(wrapper)
	if err != nil {
		t.Fatalf("encode Pub/Sub wrapper: %v", err)
	}
	return bytes.NewReader(body)
}

func validLogEntry(timestamp time.Time) map[string]any {
	return map[string]any{
		"insertId": "abc123",
		"jsonPayload": map[string]any{
			"timestamp":      timestamp.Format(time.RFC3339Nano),
			"message":        "[OCR_MONITORING] scan",
			"method":         "POST",
			"path":           "/ocr/scan",
			"request_id":     "00112233445566778899aabbccddeeff",
			"signal":         "scan",
			"status":         "ok",
			"attest":         "pass",
			"provider":       "azure-di",
			"scan_id":        "0123456789abcdef0123456789abcdef",
			"client_version": "2.2.0 (3801)",
		},
		"labels": map[string]any{
			"instanceId": "00bf4bf02d1f-secret-high-cardinality-instance",
		},
		"logName":   "projects/resplit-fx-prod/logs/run.googleapis.com%2Fstdout",
		"severity":  "INFO",
		"timestamp": timestamp.Format(time.RFC3339Nano),
		"trace":     "projects/resplit-fx-prod/traces/ffeeddccbbaa99887766554433221100",
		"resource": map[string]any{
			"type": "cloud_run_revision",
			"labels": map[string]any{
				"configuration_name": "ocr",
				"location":           "us-central1",
				"project_id":         "resplit-fx-prod",
				"revision_name":      "ocr-00014-poz",
				"service_name":       "ocr",
			},
		},
	}
}

func equalStringMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}
