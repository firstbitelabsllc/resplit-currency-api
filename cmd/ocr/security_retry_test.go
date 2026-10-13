package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
)

type pausedReservation struct {
	*memorySpendStore
	once     sync.Once
	reserved chan struct{}
	resume   chan struct{}
}

func (p *pausedReservation) ReserveOCR(ctx context.Context, id, hash string, ttl time.Duration) (bool, error) {
	fresh, err := p.memorySpendStore.ReserveOCR(ctx, id, hash, ttl)
	if fresh {
		p.once.Do(func() { close(p.reserved); <-p.resume })
	}
	return fresh, err
}

func retryRequest(h http.Handler, ctx context.Context) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/ocr/scan", strings.NewReader("same-receipt")).WithContext(ctx)
	r.RemoteAddr = "203.0.113.31:1234"
	r.Header.Set(headerSoftFail, "true")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestScanConcurrentRetryJoinsReservationAndResult(t *testing.T) {
	t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
	store := &pausedReservation{memorySpendStore: newMemorySpendStore(time.Now), reserved: make(chan struct{}), resume: make(chan struct{})}
	gate := &ocrSpendGate{store: store, idempotencyTTL: time.Hour}
	provider := &countingProvider{}
	h := newServerWithGate(attest.NewMemStore(), provider, slog.Default(), nil, gate).routes()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- retryRequest(h, ctx) }()
	<-store.reserved
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() { second <- retryRequest(h, ctx) }()
	select {
	case w := <-second:
		close(store.resume)
		<-first
		t.Fatalf("retry returned before reserved request completed: status=%d body=%s", w.Code, w.Body.String())
	case <-time.After(100 * time.Millisecond):
	}
	close(store.resume)
	a, b := <-first, <-second
	if a.Code != 200 || b.Code != 200 || provider.calls != 1 {
		t.Fatalf("statuses=%d/%d provider=%d", a.Code, b.Code, provider.calls)
	}
}

func TestScanAzureFailureReservationBoundary(t *testing.T) {
	for _, tc := range []struct {
		name      string
		submit    int
		poll      int
		wantRetry int
		wantPosts int64
	}{
		{"explicit rejection", 429, 200, 200, 2},
		{"accepted poll failure", 202, 503, 429, 1},
		{"ambiguous server failure", 503, 200, 429, 1},
		{"ambiguous transport failure", 0, 200, 429, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
			var posts atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					n := posts.Add(1)
					if n == 1 && tc.submit == 0 {
						conn, _, err := w.(http.Hijacker).Hijack()
						if err == nil {
							conn.Close()
						}
						return
					}
					if n == 1 && tc.submit != 202 {
						w.WriteHeader(tc.submit)
						return
					}
					w.Header().Set("Operation-Location", "http://"+r.Host+"/poll")
					w.WriteHeader(202)
					return
				}
				if tc.poll != 200 {
					w.WriteHeader(tc.poll)
					return
				}
				io.WriteString(w, `{"status":"succeeded","analyzeResult":{}}`)
			}))
			defer upstream.Close()
			provider, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "test", PollInterval: time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), idempotencyTTL: time.Hour}
			h := newServerWithGate(attest.NewMemStore(), provider, slog.Default(), nil, gate).routes()
			a := retryRequest(h, context.Background())
			b := retryRequest(h, context.Background())
			wantFirst := 502
			if tc.submit == 429 {
				wantFirst = 429
			}
			if a.Code != wantFirst || b.Code != tc.wantRetry || posts.Load() != tc.wantPosts {
				t.Fatalf("statuses=%d/%d POSTs=%d, want502/%d/%d", a.Code, b.Code, posts.Load(), tc.wantRetry, tc.wantPosts)
			}
		})
	}
}

type heldProvider struct {
	calls   atomic.Int64
	started chan struct{}
	finish  chan struct{}
}

func (p *heldProvider) Scan(context.Context, []byte) ([]byte, error) {
	p.calls.Add(1)
	close(p.started)
	<-p.finish
	return []byte(`{"status":"succeeded"}`), nil
}
func TestScanCancelledWaiterCannotReleaseOwnerReservation(t *testing.T) {
	t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
	p := &heldProvider{started: make(chan struct{}), finish: make(chan struct{})}
	gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), idempotencyTTL: time.Hour}
	srv := newServerWithGate(attest.NewMemStore(), p, slog.Default(), nil, gate)
	h := srv.routes()
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- retryRequest(h, context.Background()) }()
	<-p.started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	waiter := retryRequest(h, ctx)
	if waiter.Code != 502 {
		close(p.finish)
		<-first
		t.Fatalf("cancelled waiter=%d", waiter.Code)
	}
	close(p.finish)
	if w := <-first; w.Code != 200 {
		t.Fatalf("owner=%d", w.Code)
	}
	// Simulate process/cache loss: the durable spend reservation still blocks.
	srv.coalescer = newScanCoalescer(time.Minute, nil)
	retry := retryRequest(h, context.Background())
	if retry.Code != 429 || p.calls.Load() != 1 {
		t.Fatalf("retry=%d provider calls=%d", retry.Code, p.calls.Load())
	}
}
