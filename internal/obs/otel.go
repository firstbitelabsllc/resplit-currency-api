// Package obs wires OpenTelemetry trace + metric providers for the GCP rewrite
// of resplit-currency-api and exposes typed helpers to record the service's
// golden signals.
//
// Two design rules keep this package safe in every environment:
//
//  1. Graceful no-op when credentials are absent. Setup never fails because GCP
//     is unreachable: with no exporter the SDK providers are built with no
//     reader / no span processor, so they record nothing and ship nothing. This
//     is exactly what we want for `go test`, local `go run`, and CI — zero
//     network, zero credentials, zero panics. In Cloud Run, an Exporters value
//     backed by Cloud Trace + Google Managed Prometheus is injected and the same
//     code path lights up.
//
//  2. The live GCP exporter construction is the only part that needs
//     credentials, so it lives behind the Exporters interface (see exporters.go)
//     with a TODO(gcp) for the real
//     github.com/GoogleCloudPlatform/opentelemetry-operations-go wiring. The rest
//     of the package — providers, instruments, recorders — is pure OTel SDK and
//     builds + vets with no cloud dependency.
//
// Golden signals recorded (Prometheus-style names; OTel maps dots/underscores
// for Managed Prometheus):
//
//	http_requests_total{route,status_class}        counter
//	http_request_duration_seconds{route}           histogram (seconds)
//	fx_snapshot_age_seconds                         gauge
//	ocr_scan_cost_usd_total                         counter (USD)
//	ocr_abuse_rejections_total{reason}              counter
//	fx_source_available{source}                     gauge (0|1)
package obs

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// instrumentationScope names the meter/tracer this package emits under.
const instrumentationScope = "github.com/firstbitelabsllc/resplit-currency-api/internal/obs"

// defaultMetricInterval is how often the periodic reader pushes metrics when a
// real exporter is present. Managed Prometheus scrapes at 60s by default; a
// 30s push keeps freshness gauges (fx_snapshot_age) usefully fresh without
// hammering the backend.
const defaultMetricInterval = 30 * time.Second

// latencyBucketsSeconds are explicit histogram boundaries (seconds) for
// http_request_duration_seconds, chosen to give clean p50/p95/p99 across the
// FX read-path (sub-50ms CDN-fronted) up to slow OCR scans (multi-second Azure
// DI round-trips).
var latencyBucketsSeconds = []float64{
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
}

// Config controls Setup. The zero value is a valid local/test configuration: no
// exporters, so providers are inert no-ops.
type Config struct {
	// ServiceName populates the service.name resource attribute. Defaults to
	// "resplit-currency-api" when empty.
	ServiceName string
	// ServiceVersion populates service.version when non-empty (e.g. the git SHA
	// or Cloud Run revision).
	ServiceVersion string
	// Environment populates deployment.environment when non-empty
	// (e.g. "prod", "staging").
	Environment string
	// MetricInterval overrides the periodic metric push interval. Defaults to
	// defaultMetricInterval when zero. Ignored when no metric exporter is set.
	MetricInterval time.Duration
}

func (c Config) serviceName() string {
	if c.ServiceName == "" {
		return "resplit-currency-api"
	}
	return c.ServiceName
}

func (c Config) metricInterval() time.Duration {
	if c.MetricInterval <= 0 {
		return defaultMetricInterval
	}
	return c.MetricInterval
}

// Telemetry is the live observability handle returned by Setup. It owns the
// provider Shutdown lifecycle and the recorder used to emit golden signals.
//
// A nil *Telemetry is safe to use: every method no-ops, so callers that skip
// Setup (or run with telemetry disabled) need no nil checks.
//
// Note: rec is NOT embedded. Embedding a *Recorder would promote its methods,
// but a promoted method on a nil *Telemetry dereferences the outer nil before
// the inner nil-guard runs (Go method-promotion semantics). Explicit forwarders
// below guard the receiver first, preserving the nil-safe contract.
type Telemetry struct {
	rec            *Recorder
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
}

// Recorder returns the underlying golden-signal recorder, or nil if telemetry
// is disabled. A nil *Recorder is itself safe to call.
func (t *Telemetry) Recorder() *Recorder {
	if t == nil {
		return nil
	}
	return t.rec
}

// RecordHTTPRequest forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) RecordHTTPRequest(ctx context.Context, route string, statusCode int, dur time.Duration) {
	if t == nil {
		return
	}
	t.rec.RecordHTTPRequest(ctx, route, statusCode, dur)
}

// SetFXSnapshotAge forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) SetFXSnapshotAge(ctx context.Context, age time.Duration) {
	if t == nil {
		return
	}
	t.rec.SetFXSnapshotAge(ctx, age)
}

// AddOCRScanCost forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) AddOCRScanCost(ctx context.Context, usd float64) {
	if t == nil {
		return
	}
	t.rec.AddOCRScanCost(ctx, usd)
}

// RecordAbuseRejection forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) RecordAbuseRejection(ctx context.Context, reason string) {
	if t == nil {
		return
	}
	t.rec.RecordAbuseRejection(ctx, reason)
}

// SetFXSourceAvailable forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) SetFXSourceAvailable(ctx context.Context, source string, available bool) {
	if t == nil {
		return
	}
	t.rec.SetFXSourceAvailable(ctx, source, available)
}

// HTTPMiddleware forwards to the recorder; nil-safe on the receiver.
func (t *Telemetry) HTTPMiddleware(routeFn func(*http.Request) string) func(http.Handler) http.Handler {
	var rec *Recorder
	if t != nil {
		rec = t.rec
	}
	return rec.HTTPMiddleware(routeFn) // nil *Recorder -> pass-through
}

// Tracer returns a tracer from the configured provider. Safe on a nil receiver
// (returns the global no-op tracer).
func (t *Telemetry) Tracer() trace.Tracer {
	if t == nil || t.tracerProvider == nil {
		return otel.Tracer(instrumentationScope)
	}
	return t.tracerProvider.Tracer(instrumentationScope)
}

// Shutdown flushes and stops the trace + metric providers. It blocks until both
// have drained or ctx is cancelled, and joins any errors. Safe on a nil
// receiver. Call once, typically from a deferred shutdown in main.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if t == nil {
		return nil
	}
	var errs []error
	if t.meterProvider != nil {
		if err := t.meterProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("obs: meter provider shutdown: %w", err))
		}
	}
	if t.tracerProvider != nil {
		if err := t.tracerProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("obs: tracer provider shutdown: %w", err))
		}
	}
	return errors.Join(errs...)
}

// Setup builds trace + metric providers from cfg and exp, registers them as the
// OTel globals (so otel.Tracer/otel.Meter and propagation work everywhere), and
// returns a Telemetry handle whose Shutdown the caller must defer.
//
// exp supplies the OTLP-to-GCP exporters. Pass NoopExporters() (or a zero
// Exporters with nil fields) for local dev/tests: the providers are then built
// with no reader / no span processor and record nothing — no credentials, no
// network. In Cloud Run, pass GCPExporters(ctx) (see exporters.go) to push
// traces to Cloud Trace and metrics to Google Managed Prometheus.
//
// Setup never returns an error for the no-op path; it only errors if a supplied
// exporter or the resource fails to construct.
func Setup(ctx context.Context, cfg Config, exp Exporters) (*Telemetry, error) {
	res, err := newResource(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("obs: build resource: %w", err)
	}

	// Trace provider. With no SpanExporter we add no SpanProcessor, so spans are
	// dropped at the source (the SDK's documented inert mode).
	traceOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if spanExp := exp.SpanExporter(); spanExp != nil {
		traceOpts = append(traceOpts, sdktrace.WithBatcher(spanExp))
	}
	tp := sdktrace.NewTracerProvider(traceOpts...)

	// Metric provider. With no Exporter we add no Reader, so instruments record
	// but nothing is ever collected or pushed.
	metricOpts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	if metricExp := exp.MetricExporter(); metricExp != nil {
		reader := sdkmetric.NewPeriodicReader(metricExp,
			sdkmetric.WithInterval(cfg.metricInterval()),
		)
		metricOpts = append(metricOpts, sdkmetric.WithReader(reader))
	}
	mp := sdkmetric.NewMeterProvider(metricOpts...)

	// Register as globals so otel.Tracer/otel.Meter and W3C+Cloud Trace
	// propagation work for any code that doesn't hold the handle directly.
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	rec, err := newRecorder(mp.Meter(instrumentationScope))
	if err != nil {
		// Roll back the providers we just built so a partial Setup leaves no
		// dangling global state to flush.
		_ = mp.Shutdown(ctx)
		_ = tp.Shutdown(ctx)
		return nil, fmt.Errorf("obs: build recorder: %w", err)
	}

	return &Telemetry{
		rec:            rec,
		tracerProvider: tp,
		meterProvider:  mp,
	}, nil
}

// newResource builds the OTel resource carrying service.name and friends. It
// merges over resource.Default() (which contributes telemetry.sdk.* and any
// OTEL_RESOURCE_ATTRIBUTES) so Cloud Run env-injected attributes survive.
func newResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
	attrs := []attribute.KeyValue{
		semconv.ServiceName(cfg.serviceName()),
	}
	if cfg.ServiceVersion != "" {
		attrs = append(attrs, semconv.ServiceVersion(cfg.ServiceVersion))
	}
	if cfg.Environment != "" {
		attrs = append(attrs, semconv.DeploymentEnvironment(cfg.Environment))
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(attrs...),
	)
	if err != nil {
		return nil, err
	}
	merged, err := resource.Merge(resource.Default(), res)
	if err != nil {
		// Schema-URL conflicts surface here; fall back to our own resource rather
		// than failing Setup outright.
		return res, nil
	}
	return merged, nil
}

// ---------------------------------------------------------------------------
// Recorder: typed golden-signal instruments.
// ---------------------------------------------------------------------------

// Recorder owns the OTel instruments for the service's golden signals and
// exposes a small, allocation-light API to record them. A nil *Recorder is
// safe: every method no-ops, so disabled telemetry needs no caller-side guards.
type Recorder struct {
	httpRequests    metric.Int64Counter
	httpDuration    metric.Float64Histogram
	fxSnapshotAge   metric.Float64Gauge
	ocrScanCostUSD  metric.Float64Counter
	ocrAbuseRejects metric.Int64Counter
	fxSourceUp      metric.Int64Gauge
}

// newRecorder constructs all instruments from m. Instrument construction only
// fails on a programming error (duplicate name with conflicting type), so any
// error is fatal to Setup and surfaced to the caller.
func newRecorder(m metric.Meter) (*Recorder, error) {
	var err error
	r := &Recorder{}

	if r.httpRequests, err = m.Int64Counter(
		"http_requests_total",
		metric.WithDescription("Total HTTP requests handled, partitioned by route and status class."),
		metric.WithUnit("{request}"),
	); err != nil {
		return nil, err
	}

	if r.httpDuration, err = m.Float64Histogram(
		"http_request_duration_seconds",
		metric.WithDescription("HTTP request handler latency in seconds, partitioned by route."),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(latencyBucketsSeconds...),
	); err != nil {
		return nil, err
	}

	if r.fxSnapshotAge, err = m.Float64Gauge(
		"fx_snapshot_age_seconds",
		metric.WithDescription("Age in seconds of the most recently published FX snapshot (now - snapshot time)."),
		metric.WithUnit("s"),
	); err != nil {
		return nil, err
	}

	if r.ocrScanCostUSD, err = m.Float64Counter(
		"ocr_scan_cost_usd_total",
		metric.WithDescription("Cumulative estimated OCR (Azure Document Intelligence) spend in USD."),
		metric.WithUnit("{usd}"),
	); err != nil {
		return nil, err
	}

	if r.ocrAbuseRejects, err = m.Int64Counter(
		"ocr_abuse_rejections_total",
		metric.WithDescription("OCR requests rejected by the abuse / App Attest gate, partitioned by reason."),
		metric.WithUnit("{rejection}"),
	); err != nil {
		return nil, err
	}

	if r.fxSourceUp, err = m.Int64Gauge(
		"fx_source_available",
		metric.WithDescription("Per-source FX provider availability: 1 = reachable+contributing, 0 = down/excluded."),
		metric.WithUnit("{status}"),
	); err != nil {
		return nil, err
	}

	return r, nil
}

// RecordHTTPRequest records one completed HTTP request: it increments
// http_requests_total{route,status_class} and observes
// http_request_duration_seconds{route}. route should be the low-cardinality
// route pattern (e.g. "/ocr/scan", "/fx/{base}"), NOT the raw path, to keep
// label cardinality bounded. statusCode is the response status; it is bucketed
// into a status class ("2xx".."5xx").
func (r *Recorder) RecordHTTPRequest(ctx context.Context, route string, statusCode int, dur time.Duration) {
	if r == nil {
		return
	}
	routeAttr := attribute.String("route", route)
	r.httpRequests.Add(ctx, 1, metric.WithAttributes(
		routeAttr,
		attribute.String("status_class", statusClass(statusCode)),
	))
	r.httpDuration.Record(ctx, dur.Seconds(), metric.WithAttributes(routeAttr))
}

// SetFXSnapshotAge sets fx_snapshot_age_seconds to age. Wire this from the
// publish path (and any liveness check) so the dead-man's-switch alert can fire
// when the latest snapshot goes stale. Negative ages are clamped to 0.
func (r *Recorder) SetFXSnapshotAge(ctx context.Context, age time.Duration) {
	if r == nil {
		return
	}
	secs := age.Seconds()
	if secs < 0 {
		secs = 0
	}
	r.fxSnapshotAge.Record(ctx, secs)
}

// AddOCRScanCost adds usd to ocr_scan_cost_usd_total. Call once per billed scan
// with the per-page Azure DI price. Non-positive values are ignored (a counter
// must be monotonic).
func (r *Recorder) AddOCRScanCost(ctx context.Context, usd float64) {
	if r == nil || usd <= 0 {
		return
	}
	r.ocrScanCostUSD.Add(ctx, usd)
}

// RecordAbuseRejection increments ocr_abuse_rejections_total{reason}. reason
// should be a stable, low-cardinality token — pass an attest error Code
// ("REPLAY", "SIG", "UNKNOWN_KEY", "RPID", "BUDGET", "RATE_CAP", ...). Use
// AbuseReasonFromError to derive it from an error.
func (r *Recorder) RecordAbuseRejection(ctx context.Context, reason string) {
	if r == nil {
		return
	}
	if reason == "" {
		reason = "unknown"
	}
	r.ocrAbuseRejects.Add(ctx, 1, metric.WithAttributes(
		attribute.String("reason", reason),
	))
}

// SetFXSourceAvailable sets fx_source_available{source} to 1 (up) or 0 (down).
// source is the provider id from fx.SourceSnapshot.Source ("ecb",
// "openexchange", ...). Call it for every configured source on each reconcile
// pass so a missing/failed source is observable as 0 rather than absent.
func (r *Recorder) SetFXSourceAvailable(ctx context.Context, source string, available bool) {
	if r == nil {
		return
	}
	var v int64
	if available {
		v = 1
	}
	r.fxSourceUp.Record(ctx, v, metric.WithAttributes(
		attribute.String("source", source),
	))
}

// ---------------------------------------------------------------------------
// HTTP middleware: zero-config golden-signal capture for any net/http handler.
// ---------------------------------------------------------------------------

// HTTPMiddleware returns net/http middleware that records RecordHTTPRequest for
// every request, using routeFn to derive the low-cardinality route label from
// the request. Pass a routeFn that returns the matched pattern (e.g. from the
// ServeMux) — never the raw r.URL.Path, which would explode label cardinality.
//
// It composes cleanly inside httpx.Middleware. Safe on a nil Recorder
// (returns a pass-through wrapper).
func (r *Recorder) HTTPMiddleware(routeFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if r == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			start := time.Now()
			sw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(sw, req)
			route := "unmatched"
			if routeFn != nil {
				if got := routeFn(req); got != "" {
					route = got
				}
			}
			r.RecordHTTPRequest(req.Context(), route, sw.status, time.Since(start))
		})
	}
}

// statusRecorder captures the response status code for the middleware.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// statusClass buckets an HTTP status code into "1xx".."5xx". Out-of-range
// codes collapse to "unknown" so the label set stays bounded.
func statusClass(code int) string {
	switch {
	case code >= 100 && code < 200:
		return "1xx"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "unknown"
	}
}

// AbuseReasonFromError derives the {reason} label for ocr_abuse_rejections_total
// from an error. It recognizes the attest.Error code shape
// (`attest: <CODE>: <msg>`) without importing the attest package, keeping obs
// dependency-free of the gate it observes; any other error collapses to
// "internal". A nil error yields "" (no rejection).
//
// The recognized shape is the stable contract from internal/attest: every
// verification failure stringifies as "attest: CODE: message".
func AbuseReasonFromError(err error) string {
	if err == nil {
		return ""
	}
	const prefix = "attest: "
	msg := err.Error()
	if len(msg) > len(prefix) && msg[:len(prefix)] == prefix {
		rest := msg[len(prefix):]
		for i := 0; i < len(rest); i++ {
			if rest[i] == ':' {
				if code := rest[:i]; code != "" {
					return code
				}
				break
			}
		}
	}
	return "internal"
}

// FormatUSD is a tiny helper for log lines that want to echo a recorded scan
// cost; kept here so callers don't re-implement money formatting. It is not on
// the hot metric path.
func FormatUSD(usd float64) string {
	return "$" + strconv.FormatFloat(usd, 'f', 4, 64)
}
