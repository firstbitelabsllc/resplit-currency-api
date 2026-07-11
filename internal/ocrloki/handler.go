package ocrloki

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxPubSubBodyBytes = 1 << 20
	maxLogEntryBytes   = 512 << 10
	defaultTimeout     = 10 * time.Second
)

var (
	safeID            = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	hexID             = regexp.MustCompile(`^[0-9a-fA-F]{16,64}$`)
	correlationID     = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	safeClientVersion = regexp.MustCompile(`^(?:[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}(?:[ +()-][0-9A-Za-z.+()_-]{1,24})?|deploy-canary|ocr-lab-cron|unknown)$`)
	safeRevision      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	grafanaLokiHost   = regexp.MustCompile(`^logs-prod-[0-9]{3}\.grafana\.net$`)

	safeMessages = map[string]struct{}{
		"[OCR_MONITORING] scan":                          {},
		"[OCR_MONITORING] scan blocked":                  {},
		"attestation rejected":                           {},
		"azure provider unavailable, using stub":         {},
		"firestore store unavailable, using in-memory":   {},
		"ocr provider failed":                            {},
		"ocr service listening":                          {},
		"ocr spend gate failed closed":                   {},
		"otel setup failed, telemetry disabled":          {},
		"otel shutdown error":                            {},
		"otel telemetry enabled":                         {},
		"otlp exporters unavailable, telemetry disabled": {},
		"panic recovered":                                {},
		"request completed":                              {},
		"scan rejected":                                  {},
		"server exited with error":                       {},
		"shutdown signal received, draining":             {},
	}
	safePaths = map[string]struct{}{
		"/health":        {},
		"/ocr/attest":    {},
		"/ocr/challenge": {},
		"/ocr/scan":      {},
	}
)

type Config struct {
	LokiURL             string
	AuthorizationHeader string
	HTTPClient          *http.Client
	Timeout             time.Duration
	Logger              *slog.Logger
	AllowTestEndpoint   bool
	Revision            string
}

func ConfigFromEnv() Config {
	return Config{
		LokiURL:             os.Getenv("LOKI_URL"),
		AuthorizationHeader: os.Getenv("LOKI_AUTH_HEADER"),
		Revision:            os.Getenv("K_REVISION"),
	}
}

type handler struct {
	lokiURL       string
	authorization string
	client        *http.Client
	timeout       time.Duration
	logger        *slog.Logger
	mux           *http.ServeMux
	revision      string
}

type pubSubEnvelope struct {
	Message struct {
		Data        string `json:"data"`
		MessageID   string `json:"messageId"`
		PublishTime string `json:"publishTime"`
	} `json:"message"`
	Subscription string `json:"subscription"`
}

type cloudLogEntry struct {
	InsertID    string         `json:"insertId"`
	JSONPayload map[string]any `json:"jsonPayload"`
	LogName     string         `json:"logName"`
	Severity    string         `json:"severity"`
	Timestamp   string         `json:"timestamp"`
	Trace       string         `json:"trace"`
	Resource    struct {
		Type   string         `json:"type"`
		Labels map[string]any `json:"labels"`
	} `json:"resource"`
}

type lokiPush struct {
	Streams []lokiStream `json:"streams"`
}

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

func NewHandler(cfg Config) (http.Handler, error) {
	parsedURL, err := url.Parse(cfg.LokiURL)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" ||
		parsedURL.User != nil || parsedURL.RawQuery != "" || parsedURL.Fragment != "" ||
		parsedURL.Path != "/loki/api/v1/push" {
		return nil, errors.New("invalid Loki endpoint configuration")
	}
	if !grafanaLokiHost.MatchString(parsedURL.Hostname()) &&
		!(cfg.AllowTestEndpoint && (parsedURL.Hostname() == "127.0.0.1" || parsedURL.Hostname() == "localhost")) {
		return nil, errors.New("untrusted Loki endpoint configuration")
	}
	authorization, err := parseAuthorizationHeader(cfg.AuthorizationHeader)
	if err != nil {
		return nil, errors.New("invalid Loki authorization configuration")
	}
	if cfg.Revision != "" && !safeRevision.MatchString(cfg.Revision) {
		return nil, errors.New("invalid Cloud Run revision configuration")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	client = &clientCopy
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	h := &handler{
		lokiURL:       parsedURL.String(),
		authorization: authorization,
		client:        client,
		timeout:       timeout,
		logger:        logger,
		mux:           http.NewServeMux(),
		revision:      cfg.Revision,
	}
	h.mux.HandleFunc("GET /health", h.health)
	h.mux.HandleFunc("POST /pubsub/push", h.push)
	return h, nil
}

func parseAuthorizationHeader(raw string) (string, error) {
	const prefix = "Authorization=Basic%20"
	if !strings.HasPrefix(raw, prefix) || len(raw) <= len(prefix) {
		return "", errors.New("unsupported authorization format")
	}
	encoded := strings.TrimPrefix(raw, prefix)
	if strings.ContainsAny(encoded, "\r\n%") {
		return "", errors.New("unsafe authorization encoding")
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) < 3 || len(decoded) > 4096 || !strings.Contains(string(decoded), ":") {
		return "", errors.New("invalid basic authorization payload")
	}
	return "Basic " + encoded, nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func (h *handler) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"service": "ocr-loki-forwarder",
		"status":  "ok",
	})
}

func (h *handler) push(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPubSubBodyBytes)
	defer r.Body.Close()

	var envelope pubSubEnvelope
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&envelope); err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		http.Error(w, http.StatusText(status), status)
		return
	}
	if err := requireEOF(decoder); err != nil {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	if !safeID.MatchString(envelope.Message.MessageID) {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	rawEntry, err := base64.StdEncoding.DecodeString(envelope.Message.Data)
	if err != nil || len(rawEntry) == 0 || len(rawEntry) > maxLogEntryBytes {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	var entry cloudLogEntry
	if err := json.Unmarshal(rawEntry, &entry); err != nil {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	timestamp, line, err := sanitizeEntry(entry, envelope.Message.MessageID)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	if h.revision != "" {
		line["forwarder_revision"] = h.revision
	}

	lineJSON, err := json.Marshal(line)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	pushBody, err := json.Marshal(lokiPush{Streams: []lokiStream{{
		Stream: map[string]string{
			"environment":  "production",
			"service_name": "ocr",
			"source":       "gcp_cloud_logging",
		},
		Values: [][2]string{{strconv.FormatInt(timestamp.UnixNano(), 10), string(lineJSON)}},
	}}})
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.lokiURL, strings.NewReader(string(pushBody)))
	if err != nil {
		http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	req.Header.Set("Authorization", h.authorization)
	req.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(req)
	if err != nil {
		h.logger.Warn("loki delivery failed", slog.String("message_id", envelope.Message.MessageID))
		http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusNoContent {
		h.logger.Warn("loki delivery rejected",
			slog.String("message_id", envelope.Message.MessageID),
			slog.Int("status", response.StatusCode))
		http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	if h.revision != "" {
		w.Header().Set("X-Resplit-Forwarder-Revision", h.revision)
	}
	w.WriteHeader(http.StatusNoContent)
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func sanitizeEntry(entry cloudLogEntry, messageID string) (time.Time, map[string]any, error) {
	if entry.Resource.Type != "cloud_run_revision" || stringField(entry.Resource.Labels, "service_name") != "ocr" {
		return time.Time{}, nil, errors.New("unexpected log resource")
	}
	if !strings.HasSuffix(entry.LogName, "/logs/run.googleapis.com%2Fstdout") {
		return time.Time{}, nil, errors.New("unexpected log name")
	}
	timestamp, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
	if err != nil {
		return time.Time{}, nil, errors.New("invalid log timestamp")
	}
	message, ok := entry.JSONPayload["message"].(string)
	if !ok {
		return time.Time{}, nil, errors.New("missing log message")
	}
	if _, ok := safeMessages[message]; !ok {
		return time.Time{}, nil, errors.New("unreviewed log message")
	}

	line := map[string]any{
		"insert_id":  cleanID(entry.InsertID),
		"message":    message,
		"message_id": messageID,
		"severity":   cleanSeverity(entry.Severity),
		"timestamp":  timestamp.Format(time.RFC3339Nano),
	}
	if traceID := traceIDFromResource(entry.Trace); traceID != "" {
		line["trace_id"] = traceID
	}

	for _, key := range []string{"request_id", "scan_id"} {
		if value, ok := entry.JSONPayload[key].(string); ok && correlationID.MatchString(value) {
			line[key] = value
		}
	}
	copyEnum(line, entry.JSONPayload, "method", "GET", "HEAD", "POST")
	if value, ok := entry.JSONPayload["path"].(string); ok {
		if _, reviewed := safePaths[value]; reviewed {
			line["path"] = value
		} else {
			line["path"] = "unmatched"
		}
	}
	copyEnum(line, entry.JSONPayload, "signal", "scan")
	copyEnum(line, entry.JSONPayload, "status", "ok", "provider_error", "rate_limited")
	copyEnum(line, entry.JSONPayload, "attest", "pass", "soft_fail")
	copyEnum(line, entry.JSONPayload, "reason", "budget_kill_switch", "duplicate_scan", "idempotency_error", "rate_cap", "rate_error")
	copyEnum(line, entry.JSONPayload, "provider", "azure-di")
	if value, ok := entry.JSONPayload["client_version"].(string); ok && safeClientVersion.MatchString(value) {
		line["client_version"] = value
	}
	if count, ok := safeNumber(entry.JSONPayload["count"]); ok {
		line["count"] = count
	}
	if status, ok := safeNumber(entry.JSONPayload["status"]); ok {
		line["status"] = status
	}
	return timestamp, line, nil
}

func copyEnum(target map[string]any, source map[string]any, key string, allowed ...string) {
	value, ok := source[key].(string)
	if !ok {
		return
	}
	for _, candidate := range allowed {
		if value == candidate {
			target[key] = value
			return
		}
	}
}

func traceIDFromResource(trace string) string {
	const marker = "/traces/"
	index := strings.LastIndex(trace, marker)
	if index < 0 {
		return ""
	}
	value := trace[index+len(marker):]
	if !hexID.MatchString(value) {
		return ""
	}
	return strings.ToLower(value)
}

func cleanID(value string) string {
	if safeID.MatchString(value) {
		return value
	}
	return ""
}

func cleanSeverity(value string) string {
	switch value {
	case "DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY":
		return value
	default:
		return "DEFAULT"
	}
}

func safeNumber(value any) (any, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case json.Number:
		return number, true
	default:
		return nil, false
	}
}

func stringField(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}

func ValidateConfigFromEnv() error {
	_, err := NewHandler(ConfigFromEnv())
	if err != nil {
		return fmt.Errorf("forwarder configuration: %w", err)
	}
	return nil
}
