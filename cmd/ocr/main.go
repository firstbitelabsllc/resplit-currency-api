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
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/httpx"
)

const (
	defaultPort       = "8080"
	maxScanBytes      = 12 << 20 // 12 MiB cap on uploaded image bytes
	maxCBORBodyBytes  = 64 << 10 // 64 KiB cap on attest/assertion CBOR payloads
	headerKeyID       = "X-Attest-Key-Id"
	headerChallenge   = "X-Attest-Challenge"
	headerAssertion   = "X-Attest-Assertion"
	shutdownGracePeri = 10 * time.Second
)

// OCRProvider abstracts the receipt OCR backend (Azure Document Intelligence).
//
// TODO(gcp): provide an Azure DI-backed implementation reading the key from
// Secret Manager; only this service holds that secret.
type OCRProvider interface {
	// Scan runs OCR over the raw image bytes and returns a provider-defined JSON
	// document describing the parsed receipt.
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
	// TODO(gcp): construct a *firestore.Client-backed Store and an Azure DI
	// OCRProvider (Azure key from Secret Manager). Stubs keep the binary
	// buildable and /healthz green until those clients land.
	store := attest.NewMemStore()
	provider := attest.NewStubOCRProvider()

	srv := newServer(store, provider, logger)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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

// server holds the request-scoped dependencies for the OCR routes.
type server struct {
	store    attest.Store
	provider OCRProvider
	logger   *slog.Logger
}

func newServer(store attest.Store, provider OCRProvider, logger *slog.Logger) *server {
	return &server{store: store, provider: provider, logger: logger}
}

// routes builds the mux and wraps it in shared middleware.
func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /ocr/challenge", s.handleChallenge)
	mux.HandleFunc("POST /ocr/attest", s.handleAttest)
	mux.HandleFunc("POST /ocr/scan", s.handleScan)

	return httpx.Middleware(s.logger)(mux)
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "ocr",
	})
}

// handleChallenge issues a fresh per-device App Attest challenge. The device
// signs over this when attesting; for assertions the signed clientData is the
// image body itself.
//
// TODO(gcp): persist the issued challenge (Firestore, short TTL) so /ocr/attest
// can confirm it was server-issued and unused.
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

// handleAttest performs the one-time device attestation via
// attest.VerifyAttestation.
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

	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "attested"})
}

// handleScan verifies the per-request assertion (attest.VerifyAssertion) and
// runs OCR over the image. The CBOR assertion is supplied in the
// X-Attest-Assertion header (base64url); the request body is the raw image bytes
// (= the signed clientData).
func (s *server) handleScan(w http.ResponseWriter, r *http.Request) {
	log := httpx.LoggerFrom(r.Context())

	keyID := r.Header.Get(headerKeyID)
	if keyID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing key id")
		return
	}
	assertionB64 := r.Header.Get(headerAssertion)
	if assertionB64 == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing or invalid assertion")
		return
	}

	// TODO(gcp): consult the budget kill-switch + per-device rate_caps (Firestore)
	// and the ocr_idempotency record (keyed deviceId:hash) before spending Azure DI.
	image, err := readBody(r, maxScanBytes)
	if err != nil {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, "image body too large")
		return
	}
	if len(image) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "empty image body")
		return
	}

	in := attest.AssertionInput{
		KeyID:        keyID,
		AssertionB64: assertionB64,
		ClientData:   image,
		AppID:        attest.AppID,
	}
	if err := attest.VerifyAssertion(r.Context(), in, s.store); err != nil {
		log.Warn("scan rejected", slog.Any("error", err))
		httpx.WriteError(w, attestStatus(err), "scan failed")
		return
	}

	// TODO(gcp): this Azure DI call stays a stub until the provider is wired.
	result, err := s.provider.Scan(r.Context(), image)
	if err != nil {
		log.Error("ocr provider failed", slog.Any("error", err))
		httpx.WriteError(w, http.StatusBadGateway, "ocr provider failed")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

// readBody reads up to limit bytes from the request body.
func readBody(r *http.Request, limit int64) ([]byte, error) {
	defer func() { _ = r.Body.Close() }()
	return io.ReadAll(http.MaxBytesReader(nil, r.Body, limit))
}

// attestStatus maps verification errors onto HTTP status codes by inspecting the
// structured *attest.Error code.
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
