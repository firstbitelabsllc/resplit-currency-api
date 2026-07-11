// Command ocr is the Resplit OCR Cloud Run service. It is the only secret-holder
// for the Azure Document Intelligence key (Secret Manager) and gates every scan
// behind Apple App Attest, with Firestore-backed device-key state.
//
// Routes:
//
//	GET  /health         liveness/readiness probe
//	GET  /ocr/challenge  issue an App Attest challenge (per device)
//	POST /ocr/attest     one-time device attestation (CBOR attestationObject)
//	POST /ocr/scan       per-request assertion + OCR over the image body
//
// The /ocr/scan response is the versioned, mode-discriminated envelope the iOS
// client (ResplitFXScanProvider) decodes:
//
//	{ "v":1, "mode":"raw", "provider":"azure-di", "scanId":"…",
//	  "status":"ok|rate_limited|provider_error", "raw":{…AnalyzeResultV4} }
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/firestore"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/httpx"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/obs"
)

const (
	defaultPort              = "8080"
	maxScanBytes             = 12 << 20 // 12 MiB cap on uploaded image bytes
	maxCBORBodyBytes         = 64 << 10 // 64 KiB cap on attest/assertion CBOR payloads
	defaultScanWindow        = 24 * time.Hour
	defaultIdempotencyTTL    = 24 * time.Hour
	defaultAttestedScanLimit = int64(100)
	defaultSoftFailScanLimit = int64(10)

	// Header names match what the iOS client (ResplitFXScanProvider) sends.
	headerKeyID     = "X-Resplit-Attest-Key-Id"
	headerChallenge = "X-Resplit-Attest-Challenge"
	headerAssertion = "X-Resplit-Attest-Assertion"
	headerSoftFail  = "X-Resplit-Attest-Soft-Fail"

	envelopeVersion = 1
	providerName    = "azure-di"

	shutdownGracePeri = 10 * time.Second

	// meterScope names the OTel meter this binary emits its own instruments
	// under (the ocr_scans_total counter). otelhttp emits its http.server.*
	// metrics under its own scope.
	meterScope = "github.com/firstbitelabsllc/resplit-currency-api/cmd/ocr"

	// defaultServiceName is the resource service.name when OTEL_SERVICE_NAME is
	// unset.
	defaultServiceName = "ocr"
)

// OCRProvider abstracts the receipt OCR backend (Azure Document Intelligence).
type OCRProvider interface {
	// Scan runs OCR over the raw image bytes and returns the provider's raw JSON
	// analyze result.
	Scan(ctx context.Context, image []byte) ([]byte, error)
}

func main() {
	logger := httpx.NewLogger(slog.LevelInfo)
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("server exited with error", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// OpenTelemetry: when OTEL_EXPORTER_OTLP_ENDPOINT is set (Cloud Run / Grafana
	// Cloud), stand up OTLP/HTTP trace + metric providers reading the standard
	// OTEL_EXPORTER_OTLP_* env (endpoint + auth headers are injected at deploy
	// time, never hardcoded). When unset, this no-ops so local dev / tests stay
	// network- and credential-free. Same graceful-fallback shape as the Firestore
	// and Azure wiring below.
	var tel *obs.Telemetry
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		exp, err := obs.OTLPHTTPExporters(ctx)
		if err != nil {
			logger.Warn("otlp exporters unavailable, telemetry disabled", slog.Any("error", err))
		} else {
			t, err := obs.Setup(ctx, obs.Config{ServiceName: otelServiceName()}, exp)
			if err != nil {
				logger.Warn("otel setup failed, telemetry disabled", slog.Any("error", err))
			} else {
				tel = t
				logger.Info("otel telemetry enabled", slog.String("service_name", otelServiceName()))
			}
		}
	}
	// Flush trace + metric providers on shutdown (SIGINT/SIGTERM). nil-safe.
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeri)
		defer cancel()
		if err := tel.Shutdown(flushCtx); err != nil {
			logger.Warn("otel shutdown error", slog.Any("error", err))
		}
	}()

	// ocr_scans_total counter, emitted from handleScan on every terminal outcome.
	// Uses the global meter set by obs.Setup; a no-op meter when telemetry is off.
	scanCounter, err := otel.Meter(meterScope).Int64Counter(
		"ocr_scans_total",
		metric.WithDescription("Total OCR scans, partitioned by terminal status and attestation outcome."),
		metric.WithUnit("{scan}"),
	)
	if err != nil {
		return err
	}

	// Live device-key store (Firestore) with a graceful fallback to an in-memory
	// store when no project / credentials are present (local dev, tests).
	var store attest.Store
	if pid := os.Getenv("GCP_PROJECT_ID"); pid != "" {
		fs, err := firestore.NewFirestoreStore(ctx, pid)
		if err != nil {
			logger.Warn("firestore store unavailable, using in-memory", slog.Any("error", err))
			store = attest.NewMemStore()
		} else {
			store = fs
		}
	} else {
		store = attest.NewMemStore()
	}

	// Live Azure DI provider (key from Secret Manager via AZURE_OCR_KEY). Falls
	// back to the stub when the key/endpoint aren't configured so /health stays
	// green locally.
	var provider OCRProvider
	if azClient, err := azure.New(azure.Config{
		Endpoint: os.Getenv("AZURE_OCR_ENDPOINT"),
		Key:      os.Getenv("AZURE_OCR_KEY"),
	}); err != nil {
		logger.Warn("azure provider unavailable, using stub", slog.Any("error", err))
		provider = attest.NewStubOCRProvider()
	} else {
		provider = azClient
	}

	srv := newServer(store, provider, logger, scanCounter)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("ocr service listening", slog.String("addr", httpSrv.Addr))
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeri)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}

type server struct {
	store       attest.Store
	provider    OCRProvider
	logger      *slog.Logger
	scanCounter metric.Int64Counter
	spendGate   *ocrSpendGate
}

func newServer(store attest.Store, provider OCRProvider, logger *slog.Logger, scanCounter metric.Int64Counter) *server {
	return newServerWithGate(store, provider, logger, scanCounter, newOCRSpendGate(store))
}

func newServerWithGate(store attest.Store, provider OCRProvider, logger *slog.Logger, scanCounter metric.Int64Counter, spendGate *ocrSpendGate) *server {
	if scanCounter == nil {
		// A nil counter would panic on Add; fall back to a no-op meter so tests
		// and telemetry-disabled runs stay safe.
		scanCounter, _ = noop.NewMeterProvider().Meter(meterScope).Int64Counter("ocr_scans_total")
	}
	if spendGate == nil {
		spendGate = newOCRSpendGate(store)
	}
	return &server{store: store, provider: provider, logger: logger, scanCounter: scanCounter, spendGate: spendGate}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	// WithRouteTag stamps the low-cardinality matched pattern as the http.route
	// attribute on the otelhttp span + http.server.* metrics, so the templated
	// route ("/ocr/scan") is recorded instead of the raw path.
	mux.Handle("GET /health", otelhttp.WithRouteTag("/health", http.HandlerFunc(s.handleHealth)))
	mux.Handle("GET /ocr/challenge", otelhttp.WithRouteTag("/ocr/challenge", http.HandlerFunc(s.handleChallenge)))
	mux.Handle("POST /ocr/attest", otelhttp.WithRouteTag("/ocr/attest", http.HandlerFunc(s.handleAttest)))
	mux.Handle("POST /ocr/scan", otelhttp.WithRouteTag("/ocr/scan", http.HandlerFunc(s.handleScan)))

	// Wrap the mux with otelhttp so every request emits a server span and the
	// standard http.server.* metrics (request count + duration). With the global
	// providers from obs.Setup this ships over OTLP; with the default no-op
	// providers (telemetry off) it records nothing.
	handler := otelhttp.NewHandler(mux, "ocr.http")
	return httpx.Middleware(s.logger)(handler)
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ocr"})
}

func (s *server) handleChallenge(w http.ResponseWriter, _ *http.Request) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "failed to generate challenge")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{
		"challenge": base64.RawURLEncoding.EncodeToString(buf),
	})
}

func (s *server) handleAttest(w http.ResponseWriter, r *http.Request) {
	log := httpx.LoggerFrom(r.Context())

	keyID := r.Header.Get(headerKeyID)
	if keyID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing key id")
		return
	}
	challenge := r.Header.Get(headerChallenge)
	if challenge == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing or invalid challenge")
		return
	}
	body, err := readBody(r, maxCBORBodyBytes)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "failed to read attestation body")
		return
	}
	in := attest.AttestationInput{
		KeyID:                keyID,
		AttestationObjectB64: base64.StdEncoding.EncodeToString(body),
		Challenge:            challenge,
		AppID:                attest.AppID,
	}
	if err := attest.VerifyAttestation(r.Context(), in, s.store); err != nil {
		log.Warn("attestation rejected", slog.Any("error", err))
		httpx.WriteError(w, attestStatus(err), "attestation failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// scanEnvelope is the versioned, mode-discriminated response the iOS client decodes.
type scanEnvelope struct {
	V        int             `json:"v"`
	Mode     string          `json:"mode"`
	Provider string          `json:"provider"`
	ScanID   string          `json:"scanId"`
	Status   string          `json:"status"`
	Raw      json.RawMessage `json:"raw,omitempty"`
}

func (s *server) handleScan(w http.ResponseWriter, r *http.Request) {
	log := httpx.LoggerFrom(r.Context())
	softFail := r.Header.Get(headerSoftFail) == "true"
	scanID := newScanID()

	image, err := readBody(r, maxScanBytes)
	if err != nil {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, "image body too large")
		return
	}
	if len(image) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "empty image body")
		return
	}

	attestResult := "pass"
	keyID := ""
	if softFail {
		// Sim / edge device that can't attest. Proceed without a device assertion;
		// the per-IP cap below is intentionally tighter than attested devices.
		attestResult = "soft_fail"
	} else {
		keyID = r.Header.Get(headerKeyID)
		assertionB64 := r.Header.Get(headerAssertion)
		if keyID == "" || assertionB64 == "" {
			httpx.WriteError(w, http.StatusBadRequest, "missing key id or assertion")
			return
		}
		in := attest.AssertionInput{KeyID: keyID, AssertionB64: assertionB64, ClientData: image, AppID: attest.AppID}
		if err := attest.VerifyAssertion(r.Context(), in, s.store); err != nil {
			log.Warn("scan rejected", slog.Any("error", err))
			httpx.WriteError(w, attestStatus(err), "scan failed")
			return
		}
	}

	identity := scanGateIdentity(r, softFail, keyID)
	allowed, reason, count, err := s.spendGate.Allow(r.Context(), identity, image, softFail)
	if err != nil {
		s.recordScan(r.Context(), "rate_limited", attestResult)
		log.Error("ocr spend gate failed closed", slog.Any("error", err), slog.String("scan_id", scanID), slog.String("reason", reason))
		writeEnvelope(w, http.StatusTooManyRequests, scanEnvelope{
			V: envelopeVersion, Mode: "raw", Provider: providerName, ScanID: scanID, Status: "rate_limited",
		})
		return
	}
	if !allowed {
		s.recordScan(r.Context(), "rate_limited", attestResult)
		log.Warn("[OCR_MONITORING] scan blocked",
			slog.String("signal", "scan"), slog.String("status", "rate_limited"),
			slog.String("attest", attestResult), slog.String("reason", reason),
			slog.Int64("count", count), slog.String("scan_id", scanID))
		writeEnvelope(w, http.StatusTooManyRequests, scanEnvelope{
			V: envelopeVersion, Mode: "raw", Provider: providerName, ScanID: scanID, Status: "rate_limited",
		})
		return
	}

	result, err := s.provider.Scan(r.Context(), image)
	if err != nil {
		status := scanErrorStatus(err)
		code := http.StatusBadGateway
		if status == "rate_limited" {
			code = http.StatusTooManyRequests
		}
		s.recordScan(r.Context(), status, attestResult)
		log.Error("ocr provider failed", slog.Any("error", err), slog.String("scan_id", scanID), slog.String("status", status))
		writeEnvelope(w, code, scanEnvelope{
			V: envelopeVersion, Mode: "raw", Provider: providerName, ScanID: scanID, Status: status,
		})
		return
	}

	s.recordScan(r.Context(), "ok", attestResult)

	// [OCR_MONITORING] structured log -> Cloud Logging -> Grafana Loki.
	log.Info("[OCR_MONITORING] scan",
		slog.String("signal", "scan"), slog.String("status", "ok"),
		slog.String("attest", attestResult), slog.String("provider", providerName),
		slog.String("scan_id", scanID), slog.String("client_version", r.Header.Get("X-Resplit-Client-Version")))

	writeEnvelope(w, http.StatusOK, scanEnvelope{
		V: envelopeVersion, Mode: "raw", Provider: providerName, ScanID: scanID, Status: "ok",
		Raw: json.RawMessage(result),
	})
}

func writeEnvelope(w http.ResponseWriter, code int, env scanEnvelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(env)
}

func newScanID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// otelServiceName resolves the resource service.name for telemetry, honoring the
// standard OTEL_SERVICE_NAME env and defaulting to "ocr".
func otelServiceName() string {
	if name := os.Getenv("OTEL_SERVICE_NAME"); name != "" {
		return name
	}
	return defaultServiceName
}

// recordScan increments ocr_scans_total{status,attest} for one terminal scan
// outcome. nil-safe via the no-op counter fallback in newServer.
func (s *server) recordScan(ctx context.Context, status, attestResult string) {
	s.scanCounter.Add(ctx, 1, metric.WithAttributes(
		attribute.String("status", status),
		attribute.String("attest", attestResult),
	))
}

// scanErrorStatus maps a provider error to the ocr_scans_total status label.
// The Azure DI provider surfaces a 429 as "azure: analyze returned 429: …", so
// a rate-limit shows up as status="rate_limited"; everything else is a generic
// provider_error.
func scanErrorStatus(err error) string {
	if err != nil && strings.Contains(err.Error(), "429") {
		return "rate_limited"
	}
	return "provider_error"
}

func readBody(r *http.Request, limit int64) ([]byte, error) {
	defer func() { _ = r.Body.Close() }()
	return io.ReadAll(http.MaxBytesReader(nil, r.Body, limit))
}

func attestStatus(err error) int {
	var ae *attest.Error
	if !errors.As(err, &ae) {
		return http.StatusInternalServerError
	}
	switch ae.Code {
	case "UNKNOWN_KEY":
		return http.StatusUnauthorized
	case "REPLAY", "SIG", "NONCE", "RPID", "CHAIN", "COUNT", "NOKEY", "FMT":
		return http.StatusForbidden
	case "CBOR_BAD", "ASSERT_B64", "ASSERT_SHAPE", "ATT_B64", "ATT_SHAPE", "AUTHDATA":
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}
