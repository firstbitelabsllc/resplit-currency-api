package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/ocrloki"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	handler, err := ocrloki.NewHandler(ocrloki.Config{
		LokiURL:             os.Getenv("LOKI_URL"),
		AuthorizationHeader: os.Getenv("LOKI_AUTH_HEADER"),
		Logger:              logger,
	})
	if err != nil {
		logger.Error("forwarder configuration invalid")
		os.Exit(1)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("forwarder shutdown failed")
		}
	}()
	logger.Info("ocr Loki forwarder listening", slog.String("addr", server.Addr))
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("forwarder server failed")
		os.Exit(1)
	}
}
