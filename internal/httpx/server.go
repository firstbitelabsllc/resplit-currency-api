// Package httpx provides small, dependency-light net/http helpers shared across
// the GCP Cloud Run services: a JSON response writer, request-id middleware,
// slog JSON logging enriched with Cloud Trace context, and panic recovery.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"time"
)

// HeaderRequestID is the canonical request-id header echoed back to callers.
const HeaderRequestID = "X-Request-Id"

// headerCloudTrace carries the Cloud Run / Cloud Trace propagation value:
//
//	TRACE_ID/SPAN_ID;o=TRACEFLAG
//
// We extract TRACE_ID to correlate slog records with Cloud Trace.
const headerCloudTrace = "X-Cloud-Trace-Context"

type ctxKey int

const (
	ctxKeyRequestID ctxKey = iota
	ctxKeyLogger
)

// NewLogger builds a slog JSON logger writing to stdout, suitable for Cloud
// Logging (it parses structured JSON on stdout automatically).
func NewLogger(level slog.Level) *slog.Logger {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// Map slog's "msg"/"level"/"time" onto Cloud Logging's preferred keys.
			switch a.Key {
			case slog.MessageKey:
				a.Key = "message"
			case slog.LevelKey:
				a.Key = "severity"
				a.Value = slog.StringValue(cloudSeverity(a.Value.Any()))
			case slog.TimeKey:
				a.Key = "timestamp"
			}
			return a
		},
	})
	return slog.New(handler)
}

func cloudSeverity(v any) string {
	lvl, ok := v.(slog.Level)
	if !ok {
		return "DEFAULT"
	}
	switch {
	case lvl >= slog.LevelError:
		return "ERROR"
	case lvl >= slog.LevelWarn:
		return "WARNING"
	case lvl >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// LoggerFrom returns the per-request logger, falling back to slog.Default.
func LoggerFrom(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKeyLogger).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// RequestIDFrom returns the request id bound to the context, if any.
func RequestIDFrom(ctx context.Context) string {
	if id, ok := ctx.Value(ctxKeyRequestID).(string); ok {
		return id
	}
	return ""
}

// Middleware composes request-id assignment, trace-aware logging, and panic
// recovery around an http.Handler. base is the root logger (from NewLogger).
func Middleware(base *slog.Logger) func(http.Handler) http.Handler {
	if base == nil {
		base = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			reqID := r.Header.Get(HeaderRequestID)
			if reqID == "" {
				reqID = newRequestID()
			}
			w.Header().Set(HeaderRequestID, reqID)

			log := base.With(
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
			)
			if trace := traceID(r); trace != "" {
				// "logging.googleapis.com/trace" links the record in Cloud Trace.
				log = log.With(slog.String("logging.googleapis.com/trace", trace))
			}

			ctx := context.WithValue(r.Context(), ctxKeyRequestID, reqID)
			ctx = context.WithValue(ctx, ctxKeyLogger, log)
			r = r.WithContext(ctx)

			sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}

			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic recovered",
						slog.Any("panic", rec),
						slog.String("stack", string(debug.Stack())),
					)
					if !sw.wrote {
						WriteError(sw, http.StatusInternalServerError, "internal error")
					}
				}
				log.Info("request completed",
					slog.Int("status", sw.status),
					slog.Duration("duration", time.Since(start)),
				)
			}()

			next.ServeHTTP(sw, r)
		})
	}
}

// traceID extracts the Cloud Trace id (the portion before '/') from the
// X-Cloud-Trace-Context header.
func traceID(r *http.Request) string {
	raw := r.Header.Get(headerCloudTrace)
	if raw == "" {
		return ""
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] == '/' {
			return raw[:i]
		}
	}
	return raw
}

func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is unexpected; fall back to a timestamp token.
		return "req-" + time.Now().UTC().Format("20060102T150405.000000000")
	}
	return hex.EncodeToString(b[:])
}

// statusWriter records the response status code and whether a body was written.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.wrote = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}

// WriteJSON serializes v as JSON with the given status code. On marshal failure
// it emits a 500 with a generic error body.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"failed to encode response"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteError writes a {"error": msg} JSON body with the given status code.
func WriteError(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]string{"error": msg})
}
