package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/ocrloki"
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

func TestScanInitiatorDisconnectKeepsAcceptedWorkForJoinerAndRetry(t *testing.T) {
	t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
	var posts atomic.Int64
	accepted := make(chan struct{})
	finish := make(chan struct{})
	var once sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.Header().Set("Operation-Location", "http://"+r.Host+"/poll")
			w.WriteHeader(202)
			return
		}
		once.Do(func() { close(accepted) })
		select {
		case <-finish:
			io.WriteString(w, `{"status":"succeeded","analyzeResult":{}}`)
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	provider, err := azure.New(azure.Config{Endpoint: upstream.URL, Key: "test", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), idempotencyTTL: time.Hour}
	srv := newServerWithGate(attest.NewMemStore(), provider, slog.Default(), nil, gate)
	h := srv.routes()
	ownerCtx, cancelOwner := context.WithCancel(context.Background())
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- retryRequest(h, ownerCtx) }()
	<-accepted
	// Different connected identity joins the same accepted image execution.
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest(http.MethodPost, "/ocr/scan", strings.NewReader("same-receipt"))
		r.RemoteAddr = "203.0.113.32:1234"
		r.Header.Set(headerSoftFail, "true")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		second <- w
	}()
	cancelOwner()
	select {
	case w := <-first:
		close(finish)
		<-second
		t.Fatalf("accepted owner work cancelled: status=%d", w.Code)
	case <-time.After(100 * time.Millisecond):
	}
	close(finish)
	a, b := <-first, <-second
	retry := retryRequest(h, context.Background())
	if a.Code != 200 || b.Code != 200 || retry.Code != 200 || posts.Load() != 1 {
		t.Fatalf("owner/joiner/retry=%d/%d/%d submits=%d", a.Code, b.Code, retry.Code, posts.Load())
	}
	srv.coalescer = newScanCoalescer(time.Minute, nil)
	if afterLoss := retryRequest(h, context.Background()); afterLoss.Code != 429 || posts.Load() != 1 {
		t.Fatalf("cache-loss=%d submits=%d", afterLoss.Code, posts.Load())
	}
}

func TestScanServerWorkHasDeadlineAndShutdown(t *testing.T) {
	for _, mode := range []string{"deadline", "work-cutoff"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
			p := &contextProvider{entered: make(chan struct{})}
			gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), idempotencyTTL: time.Hour}
			srv := newServerWithGate(attest.NewMemStore(), p, slog.Default(), nil, gate)
			shutdown, cancel := context.WithCancel(context.Background())
			defer cancel()
			srv.workContext = shutdown
			srv.workTimeout = 20 * time.Millisecond
			finished := make(chan *httptest.ResponseRecorder, 1)
			go func() { finished <- retryRequest(srv.routes(), context.Background()) }()
			<-p.entered
			if mode == "work-cutoff" {
				cancel()
			}
			select {
			case w := <-finished:
				if w.Code != 502 {
					t.Fatalf("status=%d", w.Code)
				}
			case <-time.After(time.Second):
				t.Fatal("server-owned work did not terminate")
			}
			fresh, err := gate.Reserve(context.Background(), "soft:203.0.113.31", []byte("same-receipt"))
			if err != nil || fresh {
				t.Fatalf("ambiguous timeout released reservation: %v/%v", fresh, err)
			}
		})
	}
}

// Exercise run's real signal wiring, HTTP drain, Azure HTTP polling and final
// OTLP export in an owned subprocess. No cloud credentials or provider calls.
func TestScanSIGTERMDrainsAcceptedWork(t *testing.T) {
	if os.Getenv("RESPLIT_TEST_SIGNAL_CHILD") == "1" {
		if err := run(slog.New(slog.NewJSONHandler(os.Stdout, nil))); err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, mode := range []string{"completes", "stalled"} {
		t.Run(mode, func(t *testing.T) {
			var posts atomic.Int64
			accepted, finish, pollingCancelled := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var once sync.Once
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					posts.Add(1)
					w.Header().Set("Operation-Location", "http://"+r.Host+"/poll")
					w.WriteHeader(202)
					return
				}
				once.Do(func() { close(accepted) })
				select {
				case <-finish:
					io.WriteString(w, `{"status":"succeeded","analyzeResult":{}}`)
				case <-r.Context().Done():
					close(pollingCancelled)
				}
			}))
			defer upstream.Close()
			metrics := make(chan []byte, 1)
			otlp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if r.URL.Path == "/v1/metrics" {
					metrics <- body
				}
				// Force the runtime to reserve actual time for final telemetry.
				time.Sleep(500 * time.Millisecond)
				w.Header().Set("Content-Type", "application/x-protobuf")
			}))
			defer otlp.Close()
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			listener.Close()
			childCtx, cancelChild := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancelChild()
			cmd := exec.CommandContext(childCtx, os.Args[0], "-test.run=^TestScanSIGTERMDrainsAcceptedWork$")
			for _, e := range os.Environ() {
				key, _, _ := strings.Cut(e, "=")
				if strings.HasPrefix(key, "OTEL_") || strings.HasPrefix(key, "OCR_") || strings.HasPrefix(key, "AZURE_") || key == "GCP_PROJECT_ID" || key == "K_SERVICE" || key == "FIRESTORE_EMULATOR_HOST" || key == "PORT" || key == "GORACE" {
					continue
				}
				cmd.Env = append(cmd.Env, e)
			}
			cmd.Env = append(cmd.Env, "RESPLIT_TEST_SIGNAL_CHILD=1", "OCR_ALLOW_SOFT_FAIL=true", "PORT="+fmt.Sprint(port), "AZURE_OCR_ENDPOINT="+upstream.URL, "AZURE_OCR_KEY=local-fixture", "OTEL_EXPORTER_OTLP_ENDPOINT="+otlp.URL, "GORACE=atexit_sleep_ms=0")
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			exited := make(chan error, 1)
			go func() { exited <- cmd.Wait() }()
			defer func() {
				cmd.Process.Kill() // only this test's owned child, already exited on success
			}()
			client := &http.Client{Timeout: 15 * time.Second}
			url := fmt.Sprintf("http://127.0.0.1:%d", port)
			until := time.Now().Add(5 * time.Second)
			for {
				resp, err := client.Get(url + "/health")
				if err == nil {
					resp.Body.Close()
					break
				}
				if time.Now().After(until) {
					t.Fatal("child did not listen")
				}
				time.Sleep(10 * time.Millisecond)
			}
			result := make(chan int, 1)
			go func() {
				r, _ := http.NewRequest(http.MethodPost, url+"/ocr/scan", strings.NewReader("signal-receipt"))
				r.Header.Set(headerSoftFail, "true")
				resp, err := client.Do(r)
				if err != nil {
					result <- 0
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				result <- resp.StatusCode
			}()
			select {
			case <-accepted:
			case <-time.After(5 * time.Second):
				t.Fatal("provider never accepted/polled")
			}
			started := time.Now()
			if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			want := 502
			if mode == "completes" {
				want = 200
				time.Sleep(100 * time.Millisecond)
				close(finish)
			}
			if got := <-result; got != want {
				t.Errorf("accepted scan status=%d, want%d", got, want)
			}
			if err := <-exited; err != nil {
				t.Fatalf("child exit=%v: %s", err, output.String())
			}
			elapsed := time.Since(started)
			if mode == "stalled" {
				<-pollingCancelled
				if elapsed < shutdownGracePeri-2500*time.Millisecond || elapsed >= shutdownGracePeri {
					t.Errorf("stalled work + final flush elapsed=%v, want within final platform grace after work drain", elapsed)
				}
			}
			select {
			case body := <-metrics:
				if !bytes.Contains(body, []byte("ocr_scans_total")) {
					t.Error("final telemetry lacks scan outcome")
				}
			default:
				t.Error("no final telemetry export before exit")
			}
			if posts.Load() != 1 {
				t.Errorf("provider submissions=%d", posts.Load())
			}
			t.Logf("SIGTERM mode=%s drain+flush=%v submits=%d", mode, elapsed, posts.Load())
		})
	}
}

type contextProvider struct{ entered chan struct{} }

func (p *contextProvider) Scan(ctx context.Context, image []byte) ([]byte, error) {
	close(p.entered)
	<-ctx.Done()
	return nil, ctx.Err()
}

type failedReservation struct{ *memorySpendStore }

func (p *failedReservation) ReserveOCR(context.Context, string, string, time.Duration) (bool, error) {
	return false, errors.New("synthetic firestore reservation unavailable")
}
func TestScanReservationFailureIsDiagnosableButResponseIsGeneric(t *testing.T) {
	t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
	var logs bytes.Buffer
	provider := &countingProvider{}
	gate := &ocrSpendGate{store: &failedReservation{newMemorySpendStore(time.Now)}}
	h := newServerWithGate(attest.NewMemStore(), provider, slog.New(slog.NewTextHandler(&logs, nil)), nil, gate).routes()
	w := retryRequest(h, context.Background())
	if w.Code != 429 || provider.calls != 0 || strings.Contains(w.Body.String(), "synthetic firestore") || !strings.Contains(logs.String(), "synthetic firestore reservation unavailable") {
		t.Fatalf("status=%d provider=%d body=%s logs=%s", w.Code, provider.calls, w.Body, logs.String())
	}
}

// Capture the real producer's record, then deliver it through the actual
// Pub/Sub handler to a TLS Loki endpoint. Sensitive diagnostics are planted in
// the producer and envelope; assertions inspect serialized outbound bytes.
func TestSpendGateProducerRecordsForwardWithRedaction(t *testing.T) {
	for _, mode := range []string{"blocked", "release-failure"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("OCR_ALLOW_SOFT_FAIL", "true")
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
				if a.Key == slog.MessageKey {
					a.Key = "message"
				}
				return a
			}}))
			gate := &ocrSpendGate{mem: newMemorySpendStore(time.Now), idempotencyTTL: time.Hour, killSwitch: mode == "blocked"}
			provider := &countingProvider{err: azure.ErrNotSubmitted}
			if mode == "release-failure" {
				gate.store = &releaseFailureStore{newMemorySpendStore(time.Now)}
			}
			w := retryRequest(newServerWithGate(attest.NewMemStore(), provider, logger, nil, gate).routes(), context.Background())
			want := 429
			if mode == "release-failure" {
				want = 502
			}
			if w.Code != want {
				t.Fatalf("scan response=%d", w.Code)
			}
			var payload map[string]any
			for _, line := range bytes.Split(logs.Bytes(), []byte("\n")) {
				var p map[string]any
				if json.Unmarshal(line, &p) != nil {
					continue
				}
				m, _ := p["message"].(string)
				if mode == "blocked" && (m == "ocr spend gate blocked" || m == "[OCR_MONITORING] scan blocked") || mode == "release-failure" && (m == "ocr spend gate release failed" || m == "ocr spend gate failed closed") {
					payload = p
					break
				}
			}
			if payload == nil {
				t.Fatalf("producer event missing: %s", logs.String())
			}
			payload["receipt_text"] = "PRIVATE RECEIPT"
			payload["nested"] = map[string]any{"name": "Alice Secret"}
			payload["key_id"] = "PRIVATE KEY"
			payload["remote_ip"] = "203.0.113.31"
			payload["count"] = float64(7)
			var sent []byte
			loki := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sent, _ = io.ReadAll(r.Body); w.WriteHeader(204) }))
			defer loki.Close()
			forwarder, err := ocrloki.NewHandler(ocrloki.Config{LokiURL: loki.URL + "/loki/api/v1/push", AuthorizationHeader: "Authorization=Basic%20dXNlcjp0b2tlbg==", HTTPClient: loki.Client(), AllowTestEndpoint: true})
			if err != nil {
				t.Fatal(err)
			}
			entry := map[string]any{"jsonPayload": payload, "resource": map[string]any{"type": "cloud_run_revision", "labels": map[string]any{"service_name": "ocr"}}, "logName": "projects/test/logs/run.googleapis.com%2Fstdout", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "severity": "WARNING"}
			raw, _ := json.Marshal(entry)
			body, _ := json.Marshal(map[string]any{"message": map[string]any{"data": base64.StdEncoding.EncodeToString(raw), "messageId": "1234567890"}})
			rec := httptest.NewRecorder()
			forwarder.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pubsub/push", bytes.NewReader(body)))
			if rec.Code != 204 || len(sent) == 0 {
				t.Fatalf("producer event rejected by forwarder: status=%d record=%v", rec.Code, payload)
			}
			for _, secret := range []string{"PRIVATE RECEIPT", "Alice Secret", "PRIVATE KEY", "203.0.113.31", "synthetic release PRIVATE"} {
				if bytes.Contains(sent, []byte(secret)) {
					t.Fatalf("Loki payload leaked %q: %s", secret, sent)
				}
			}
			var push struct {
				Streams []struct{ Values [][2]string }
			}
			if err := json.Unmarshal(sent, &push); err != nil {
				t.Fatal(err)
			}
			var out map[string]any
			if err := json.Unmarshal([]byte(push.Streams[0].Values[0][1]), &out); err != nil {
				t.Fatal(err)
			}
			if out["reason"] == nil || out["status"] == nil || out["signal"] != "scan" || out["count"] != float64(7) {
				t.Fatalf("safe rollout fields missing: %v", out)
			}
		})
	}
}

type releaseFailureStore struct{ *memorySpendStore }

func (p *releaseFailureStore) ReleaseOCR(context.Context, string, string) error {
	return errors.New("synthetic release PRIVATE")
}
