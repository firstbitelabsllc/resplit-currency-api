// Command fx-publish is the Resplit FX publish Cloud Run Job. Cloud Scheduler ->
// Pub/Sub triggers it on a cadence; it fetches the latest EUR-base rates from
// multiple providers, reconciles them with a 2-of-N quorum (the fix for the
// May-2026 single-source outage), precomputes one per-currency JSON artifact, and
// writes each to the GCS artifacts bucket behind Cloud CDN.
//
// As a Cloud Run Job it runs to completion: there is NO HTTP server and it does
// not read PORT. Success = exit 0; any gate failure or write error = exit 1 so
// the Job is marked failed and the prior (good) artifacts stay live.
//
// Environment:
//
//	FX_ARTIFACTS_BUCKET  (required) GCS bucket name for /latest/<ccy>.min.json
//	FX_MIN_AGREE         (optional) quorum threshold, default 2
//	FX_MAX_RATE_AGE      (optional) Go duration, default 96h
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"cloud.google.com/go/storage"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/fx"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/httpx"
)

const (
	envBucket     = "FX_ARTIFACTS_BUCKET"
	envMinAgree   = "FX_MIN_AGREE"
	envMaxRateAge = "FX_MAX_RATE_AGE"

	defaultMinAgree = 2
	// jobDeadline bounds the whole publish run so a hung provider can't keep a
	// Job alive indefinitely (it would otherwise burn until Cloud Run's task
	// timeout).
	jobDeadline = 60 * time.Second
	// fetchTimeout bounds each provider's HTTP roundtrip via the shared client.
	fetchTimeout = 15 * time.Second
)

func main() {
	logger := httpx.NewLogger(slog.LevelInfo)
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("fx-publish failed", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	bucket := os.Getenv(envBucket)
	if bucket == "" {
		return fmt.Errorf("missing required env %s", envBucket)
	}

	cfg := fx.PublishConfig{
		MinAgree:   minAgreeFromEnv(),
		MaxRateAge: maxRateAgeFromEnv(),
	}

	// Cloud Run Jobs deliver SIGTERM on shutdown; bound the run with both a
	// deadline and signal cancellation.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, jobDeadline)
	defer cancel()

	httpClient := &http.Client{Timeout: fetchTimeout}
	sources := []fx.Source{
		fx.NewERAPISource(httpClient),
		fx.NewFrankfurterSource(httpClient),
	}

	writer, closeWriter, err := newGCSWriter(ctx, bucket)
	if err != nil {
		return fmt.Errorf("init artifact writer: %w", err)
	}
	defer closeWriter()

	logger.Info("fx-publish starting",
		slog.String("bucket", bucket),
		slog.Int("min_agree", cfg.MinAgree),
		slog.Duration("max_rate_age", cfg.MaxRateAge),
		slog.Int("sources", len(sources)),
	)

	result, err := fx.PublishLatest(ctx, sources, writer, cfg)
	if err != nil {
		return err
	}

	logger.Info("fx-publish complete",
		slog.String("base", result.Base),
		slog.String("date", result.Date),
		slog.Any("sources", result.Sources),
		slog.Int("currency_objects", result.CurrencyCount),
		slog.Any("failed_quorum", result.FailedQuorum),
	)
	return nil
}

func minAgreeFromEnv() int {
	if raw := os.Getenv(envMinAgree); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 {
			return n
		}
	}
	return defaultMinAgree
}

func maxRateAgeFromEnv() time.Duration {
	if raw := os.Getenv(envMaxRateAge); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return fx.DefaultMaxRateAge
}

// gcsWriter is the production fx.ObjectWriter backed by a GCS bucket. Tests never
// construct this; they pass a fake fx.ObjectWriter to fx.PublishLatest directly.
type gcsWriter struct {
	bucket *storage.BucketHandle
}

// WriteObject implements fx.ObjectWriter against Cloud Storage. A GCS object
// write becomes durable + atomic only on Close, so a mid-write error leaves the
// previous object untouched.
//
// TODO(gcp): requires Application Default Credentials with
// roles/storage.objectAdmin on FX_ARTIFACTS_BUCKET (wired via the publish-job
// service account in the terraform spine). No-creds runs fail at newGCSWriter.
func (g *gcsWriter) WriteObject(ctx context.Context, objectPath string, body []byte, contentType, cacheControl string) error {
	obj := g.bucket.Object(objectPath)
	w := obj.NewWriter(ctx)
	w.ContentType = contentType
	w.CacheControl = cacheControl
	if _, err := w.Write(body); err != nil {
		// Abort the resumable upload so we don't leave a half-written object.
		_ = w.CloseWithError(err)
		return err
	}
	return w.Close()
}

// newGCSWriter constructs the Cloud Storage-backed writer and returns a closer
// for the underlying client.
//
// TODO(gcp): storage.NewClient uses Application Default Credentials; in Cloud Run
// that is the Job's attached service account. Locally it needs
// `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS.
func newGCSWriter(ctx context.Context, bucket string) (fx.ObjectWriter, func(), error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, func() {}, fmt.Errorf("storage.NewClient: %w", err)
	}
	closer := func() {
		if cerr := client.Close(); cerr != nil && !errors.Is(cerr, context.Canceled) {
			slog.Default().Warn("storage client close", slog.Any("error", cerr))
		}
	}
	return &gcsWriter{bucket: client.Bucket(bucket)}, closer, nil
}
