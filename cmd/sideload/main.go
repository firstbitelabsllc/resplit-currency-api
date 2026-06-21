// Command sideload is the Resplit FX sideload Cloud Run service. It is the
// low-traffic, scale-to-zero half of the OCR+sideload blast-radius split: it
// accepts raw per-source FX snapshots (the "sideload" ingestion path that
// complements the scheduled publish Job), runs them through the 2-of-3 quorum
// reconciler, and returns the agreed rate table plus the list of outlier
// currencies. It holds no Apple App Attest secret and no Azure key; its only
// dependency is internal/fx, so it can run min-instances=0.
//
// Routes:
//
//	GET  /healthz       liveness/readiness probe
//	POST /fx/reconcile  reconcile N source snapshots into one agreed table
//	POST /fx/cross      derive a single cross rate from a base table
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/fx"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/httpx"
)

const (
	defaultPort       = "8080"
	maxBodyBytes      = 1 << 20 // 1 MiB cap on snapshot JSON payloads
	defaultMinAgree   = 2       // 2-of-3 quorum default
	shutdownGracePeri = 10 * time.Second
)

func main() {
	logger := httpx.NewLogger(slog.LevelInfo)
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("server exited with error", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	// TODO(gcp): construct a *storage.Client to read source snapshots from the
	// fx-artifacts bucket and a *firestore.Client for publish-state bookkeeping.
	// The pure-fx reconcile path below needs neither, so the binary stays
	// buildable and /healthz green until those clients land.
	srv := newServer(logger)

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
		logger.Info("sideload service listening", slog.String("addr", httpSrv.Addr))
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

// server holds the request-scoped dependencies for the sideload routes.
type server struct {
	logger *slog.Logger
}

func newServer(logger *slog.Logger) *server {
	return &server{logger: logger}
}

// routes builds the mux and wraps it in shared middleware.
func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /fx/reconcile", s.handleReconcile)
	mux.HandleFunc("POST /fx/cross", s.handleCross)

	return httpx.Middleware(s.logger)(mux)
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "sideload",
	})
}

// reconcileRequest is the POST /fx/reconcile body. minAgree defaults to 2 (the
// 2-of-3 quorum) when omitted or non-positive.
type reconcileRequest struct {
	MinAgree int                 `json:"minAgree"`
	Sources  []fx.SourceSnapshot `json:"sources"`
}

// reconcileResponse mirrors fx.Reconcile's (agreed, outliers) result.
type reconcileResponse struct {
	MinAgree int                `json:"minAgree"`
	Rates    map[string]float64 `json:"rates"`
	Outliers []string           `json:"outliers"`
}

// handleReconcile runs the 2-of-3 quorum reconciler over the posted snapshots.
func (s *server) handleReconcile(w http.ResponseWriter, r *http.Request) {
	log := httpx.LoggerFrom(r.Context())

	req, err := decodeJSON[reconcileRequest](r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid reconcile body")
		return
	}
	if len(req.Sources) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "no source snapshots supplied")
		return
	}

	minAgree := req.MinAgree
	if minAgree <= 0 {
		minAgree = defaultMinAgree
	}

	rates, outliers, err := fx.Reconcile(req.Sources, minAgree)
	if err != nil {
		log.Warn("reconcile failed", slog.Any("error", err), slog.Int("sources", len(req.Sources)))
		httpx.WriteError(w, http.StatusUnprocessableEntity, "reconcile failed: "+err.Error())
		return
	}

	if outliers == nil {
		outliers = []string{}
	}
	httpx.WriteJSON(w, http.StatusOK, reconcileResponse{
		MinAgree: minAgree,
		Rates:    rates,
		Outliers: outliers,
	})
}

// crossRequest is the POST /fx/cross body: a base rate table plus the pair.
type crossRequest struct {
	Rates map[string]float64 `json:"rates"`
	From  string             `json:"from"`
	To    string             `json:"to"`
}

// crossResponse carries the derived cross rate for the requested pair.
type crossResponse struct {
	From string  `json:"from"`
	To   string  `json:"to"`
	Rate float64 `json:"rate"`
}

// handleCross derives a single cross rate from a base table via fx.CrossRate.
func (s *server) handleCross(w http.ResponseWriter, r *http.Request) {
	log := httpx.LoggerFrom(r.Context())

	req, err := decodeJSON[crossRequest](r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid cross body")
		return
	}
	if req.From == "" || req.To == "" {
		httpx.WriteError(w, http.StatusBadRequest, "from and to are required")
		return
	}

	rate, err := fx.CrossRate(req.Rates, req.From, req.To)
	if err != nil {
		log.Warn("cross rate failed", slog.Any("error", err),
			slog.String("from", req.From), slog.String("to", req.To))
		httpx.WriteError(w, http.StatusUnprocessableEntity, "cross rate failed: "+err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, crossResponse{From: req.From, To: req.To, Rate: rate})
}

// decodeJSON reads up to maxBodyBytes from r.Body and unmarshals into T, with
// unknown fields rejected so malformed payloads fail loudly.
func decodeJSON[T any](r *http.Request) (T, error) {
	var v T
	defer func() { _ = r.Body.Close() }()
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBodyBytes))
	if err != nil {
		return v, err
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return v, err
	}
	return v, nil
}
