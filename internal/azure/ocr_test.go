package azure

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const cannedSuccess = `{
  "status": "succeeded",
  "analyzeResult": {
    "modelId": "prebuilt-receipt",
    "documents": [
      {"docType": "receipt", "fields": {"Total": {"valueCurrency": {"amount": 42.5}}}}
    ]
  }
}`

// newAzureTestServer simulates Azure DI's async analyze API: POST yields
// 202 + Operation-Location, GET polls return "running" until a configurable
// number of attempts, then the canned succeeded body.
func newAzureTestServer(t *testing.T, runningPolls int) (*httptest.Server, *int32) {
	t.Helper()
	var polls int32
	mux := http.NewServeMux()

	srv := httptest.NewServer(mux)

	mux.HandleFunc("/documentintelligence/documentModels/prebuilt-receipt:analyze", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get(headerKey) == "" {
			http.Error(w, "missing key", http.StatusUnauthorized)
			return
		}
		w.Header().Set(headerOpLocation, srv.URL+"/operations/op-123")
		w.WriteHeader(http.StatusAccepted)
	})

	mux.HandleFunc("/operations/op-123", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(headerKey) == "" {
			http.Error(w, "missing key", http.StatusUnauthorized)
			return
		}
		n := atomic.AddInt32(&polls, 1)
		w.Header().Set("Content-Type", "application/json")
		if int(n) <= runningPolls {
			_, _ = w.Write([]byte(`{"status":"running"}`))
			return
		}
		_, _ = w.Write([]byte(cannedSuccess))
	})

	t.Cleanup(srv.Close)
	return srv, &polls
}

func newTestClient(t *testing.T, endpoint string) *Client {
	t.Helper()
	c, err := New(Config{
		Endpoint:     endpoint,
		Key:          "test-key",
		PollInterval: time.Millisecond, // keep the test fast
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestClient_Scan_Success(t *testing.T) {
	srv, _ := newAzureTestServer(t, 0) // succeed on first poll
	c := newTestClient(t, srv.URL)

	out, err := c.Scan(context.Background(), []byte("\xff\xd8\xff image bytes"))
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	// Returned body is the raw succeeded analyzeResults JSON.
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("returned body not JSON: %v", err)
	}
	if doc["status"] != "succeeded" {
		t.Errorf("status: got %v want succeeded", doc["status"])
	}
	if _, ok := doc["analyzeResult"]; !ok {
		t.Errorf("analyzeResult missing from returned body: %s", out)
	}
}

func TestClient_Scan_PollsUntilSucceeded(t *testing.T) {
	srv, polls := newAzureTestServer(t, 2) // two "running" then succeeded
	c := newTestClient(t, srv.URL)

	if _, err := c.Scan(context.Background(), []byte("img")); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if got := atomic.LoadInt32(polls); got != 3 {
		t.Errorf("poll count: got %d want 3 (2 running + 1 succeeded)", got)
	}
}

func TestClient_Scan_Failed(t *testing.T) {
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()

	mux.HandleFunc("/documentintelligence/documentModels/prebuilt-receipt:analyze", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(headerOpLocation, srv.URL+"/operations/op-fail")
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("/operations/op-fail", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"failed","error":{"code":"InvalidImage","message":"bad image"}}`))
	})

	c := newTestClient(t, srv.URL)
	_, err := c.Scan(context.Background(), []byte("img"))
	if err == nil {
		t.Fatal("Scan: want error on failed analysis")
	}
	if !strings.Contains(err.Error(), "InvalidImage") {
		t.Errorf("error should carry the failure detail: %v", err)
	}
}

func TestClient_Scan_SubmitNon202(t *testing.T) {
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()
	mux.HandleFunc("/documentintelligence/documentModels/prebuilt-receipt:analyze", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"quota"}`, http.StatusTooManyRequests)
	})

	c := newTestClient(t, srv.URL)
	if _, err := c.Scan(context.Background(), []byte("img")); err == nil {
		t.Fatal("Scan: want error on non-202 submit")
	}
}

func TestClient_Scan_ContextCancel(t *testing.T) {
	srv, _ := newAzureTestServer(t, 1000) // never succeeds in time
	c := newTestClient(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := c.Scan(ctx, []byte("img"))
	if err == nil {
		t.Fatal("Scan: want error when context deadline exceeded")
	}
}

func TestClient_Scan_EmptyImage(t *testing.T) {
	c := newTestClient(t, "https://example.invalid")
	if _, err := c.Scan(context.Background(), nil); err == nil {
		t.Fatal("Scan: want error on empty image")
	}
}

func TestNewFromEnv(t *testing.T) {
	// Missing key.
	if _, err := NewFromEnv("https://e.example", func(string) string { return "" }); err != ErrMissingKey {
		t.Fatalf("NewFromEnv missing key: got %v want ErrMissingKey", err)
	}
	// Present key (Secret-Manager-injected via AZURE_OCR_KEY at runtime).
	lookup := func(k string) string {
		if k == envKey {
			return "secret-key"
		}
		return ""
	}
	c, err := NewFromEnv("https://e.example", lookup)
	if err != nil {
		t.Fatalf("NewFromEnv: %v", err)
	}
	if c.key != "secret-key" {
		t.Errorf("key: got %q want secret-key", c.key)
	}
}

// Satisfies the OCRProvider interface (compile + runtime check that cmd/ocr can
// wire *Client as the live provider).
func TestClient_ImplementsOCRProvider(t *testing.T) {
	var _ OCRProvider = newTestClient(t, "https://e.example")
}
