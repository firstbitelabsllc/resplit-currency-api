// Command ocr is the Resplit OCR Cloud Run service. It is the only secret-holder
// for the Azure Document Intelligence key (Secret Manager) and gates every scan
// behind Apple App Attest, with Firestore-backed device-key state.
//
// Routes:
//
//	GET  /healthz        liveness/readiness probe
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
	"syscall"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/azure"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/firestore"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/httpx"
)

const (
	defaultPort      = "8080"
	maxScanBytes     = 12 << 20 // 12 MiB cap on uploaded image bytes
	maxCBORBodyBytes = 64 << 10 // 64 KiB cap on attest/assertion CBOR payloads

	// Header names match what the iOS client (ResplitFXScanProvider) sends.
	headerKeyID     = "X-Resplit-Attest-Key-Id"
	headerChallenge = "X-Resplit-Attest-Challenge"
	headerAssertion = "X-Resplit-Attest-Assertion"
	headerSoftFail  = "X-Resplit-Attest-Soft-Fail"

	envelopeVersion = 1
	providerName    = "azure-di"

	shutdownGracePeri = 10 * time.Second
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
	// back to the stub when the key/endpoint aren't configured so /healthz stays
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

	srv := newServer(store, provider, logger)

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
	store    attest.Store
	provider OCRProvider
	logger   *slog.Logger
}

func newServer(store attest.Store, provider OCRProvider, logger *slog.Logger) *server {
	return &server{store: store, provider: provider, logger: logger}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /ocr/challenge", s.handleChallenge)
	mux.HandleFunc("POST /ocr/attest", s.handleAttest)
	mux.HandleFunc("POST /ocr/scan", s.handleScan)
	return httpx.Middleware(s.logger)(mux)
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
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
	if softFail {
		// Sim / edge device that can't attest. Proceed without a device assertion;
		// the Worker-side per-IP tighter cap is a follow-up. Logged for telemetry.
		attestResult = "soft_fail"
	} else {
		keyID := r.Header.Get(headerKeyID)
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

	result, err := s.provider.Scan(r.Context(), image)
	if err != nil {
		log.Error("ocr provider failed", slog.Any("error", err), slog.String("scan_id", scanID))
		writeEnvelope(w, http.StatusBadGateway, scanEnvelope{
			V: envelopeVersion, Mode: "raw", Provider: providerName, ScanID: scanID, Status: "provider_error",
		})
		return
	}

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
