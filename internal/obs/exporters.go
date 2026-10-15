package obs

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Exporters supplies the OTLP-to-GCP export pipeline to Setup. Splitting it
// behind an interface is what makes the package build + vet clean with no cloud
// SDK: the live Cloud Trace / Google Managed Prometheus exporters need GCP
// credentials and the github.com/GoogleCloudPlatform/opentelemetry-operations-go
// modules, while the rest of obs needs neither.
//
// Either method may return nil. A nil span exporter makes Setup build the trace
// provider with no span processor; a nil metric exporter makes it build the
// meter provider with no reader. Both nil = a fully inert, no-credential setup —
// the local-dev / test default.
type Exporters interface {
	// SpanExporter returns the trace exporter (Cloud Trace), or nil to disable
	// trace export.
	SpanExporter() sdktrace.SpanExporter
	// MetricExporter returns the metric exporter (Google Managed Prometheus /
	// Cloud Monitoring), or nil to disable metric export.
	MetricExporter() sdkmetric.Exporter
}

// staticExporters is a trivial Exporters holding pre-built exporters (or nils).
type staticExporters struct {
	span   sdktrace.SpanExporter
	metric sdkmetric.Exporter
}

func (e staticExporters) SpanExporter() sdktrace.SpanExporter { return e.span }
func (e staticExporters) MetricExporter() sdkmetric.Exporter  { return e.metric }

// NoopExporters returns an Exporters with no span and no metric exporter. Passed
// to Setup it yields inert providers: instruments record nothing is collected,
// no spans are processed, and no network or credentials are touched. This is the
// correct value for `go test`, local `go run`, and any environment without GCP
// credentials.
func NoopExporters() Exporters { return staticExporters{} }

// NewExporters wraps already-constructed exporters (either may be nil). Use it
// when the caller builds the GCP exporters itself and wants to hand them to
// Setup.
func NewExporters(span sdktrace.SpanExporter, metric sdkmetric.Exporter) Exporters {
	return staticExporters{span: span, metric: metric}
}

// OTLPHTTPExporters builds OTLP/HTTP trace + metric exporters for any
// OTLP-compatible backend (Grafana Cloud, the OpenTelemetry Collector, etc.).
//
// Both exporters read the standard OTEL_EXPORTER_OTLP_* environment variables —
// OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS in particular — so
// the endpoint and auth (e.g. a Grafana Cloud Basic-auth token) are injected at
// deploy time and never hardcoded. No options are passed here on purpose: the
// SDK's env config is the single source of truth.
//
// Callers should only invoke this when OTEL_EXPORTER_OTLP_ENDPOINT is set; with
// it unset the exporters would still construct but ship to localhost:4318, which
// is not what local dev/tests want. Pair this with a caller-side env check and
// fall back to NoopExporters() otherwise, preserving the graceful-degradation
// contract: missing config means nothing is exported, never a failed Setup.
func OTLPHTTPExporters(ctx context.Context) (Exporters, error) {
	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("obs: build otlp trace exporter: %w", err)
	}
	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("obs: build otlp metric exporter: %w", err)
	}
	return NewExporters(traceExp, metricExp), nil
}
