// Package azure implements the live OCR provider backed by Azure Document
// Intelligence (prebuilt-receipt model). It is pure net/http — no Azure SDK — so
// it builds with stdlib only and is fully testable against an httptest.Server.
//
// Azure DI's analyze API is asynchronous:
//
//  1. POST  {endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze
//     ?api-version=<v>&_overload=analyzeDocument
//     with the raw image bytes → 202 Accepted + an Operation-Location header.
//  2. GET   Operation-Location (poll) until the JSON body's "status" is
//     "succeeded" (or "failed"). The succeeded body is the raw analyzeResults
//     document we return verbatim to the caller.
//
// The subscription key is read once from AZURE_OCR_KEY (Secret-Manager-injected
// at runtime) and sent as the Ocp-Apim-Subscription-Key header. The whole
// submit+poll dance is bounded by the caller's context deadline.
package azure

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OCRProvider is the receipt-OCR contract cmd/ocr wires (stub or live). It
// mirrors the interface cmd/ocr already declares, so *Client is drop-in.
type OCRProvider interface {
	Scan(ctx context.Context, image []byte) ([]byte, error)
}

// Default Azure DI request parameters.
const (
	defaultAPIVersion = "2024-11-30"
	modelPath         = "documentintelligence/documentModels/prebuilt-receipt:analyze"
	headerKey         = "Ocp-Apim-Subscription-Key"
	headerOpLocation  = "Operation-Location"

	envKey = "AZURE_OCR_KEY"

	defaultPollInterval = 750 * time.Millisecond
)

// ErrMissingKey is returned by NewFromEnv when AZURE_OCR_KEY is unset/empty.
var ErrMissingKey = errors.New("azure: " + envKey + " not set")

// Config configures a Client. Endpoint and Key are required; the rest default.
type Config struct {
	// Endpoint is the Azure DI resource base URL, e.g.
	// https://<resource>.cognitiveservices.azure.com (no trailing path).
	Endpoint string
	// Key is the subscription key (from Secret Manager via AZURE_OCR_KEY).
	Key string
	// APIVersion overrides the default api-version query parameter.
	APIVersion string
	// HTTPClient lets callers inject timeouts/transport; defaults to a client
	// with no per-request timeout (the context deadline governs instead).
	HTTPClient *http.Client
	// PollInterval is the delay between poll attempts; defaults to 750ms.
	PollInterval time.Duration
}

// Client is a live Azure Document Intelligence OCR provider.
type Client struct {
	endpoint     string
	key          string
	apiVersion   string
	httpClient   *http.Client
	pollInterval time.Duration
}

// compile-time assertion that *Client satisfies OCRProvider.
var _ OCRProvider = (*Client)(nil)

// New builds a Client from an explicit Config.
func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, errors.New("azure: empty endpoint")
	}
	if strings.TrimSpace(cfg.Key) == "" {
		return nil, ErrMissingKey
	}
	apiVersion := cfg.APIVersion
	if apiVersion == "" {
		apiVersion = defaultAPIVersion
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{}
	}
	poll := cfg.PollInterval
	if poll <= 0 {
		poll = defaultPollInterval
	}
	return &Client{
		endpoint:     strings.TrimRight(cfg.Endpoint, "/"),
		key:          cfg.Key,
		apiVersion:   apiVersion,
		httpClient:   hc,
		pollInterval: poll,
	}, nil
}

// NewFromEnv builds a Client reading the subscription key from AZURE_OCR_KEY.
// endpoint is supplied by config/env separately because it is not a secret.
//
// keyLookup is normally os.Getenv; it is a parameter so callers (and tests) can
// substitute without mutating process env.
func NewFromEnv(endpoint string, keyLookup func(string) string) (*Client, error) {
	if keyLookup == nil {
		return nil, errors.New("azure: nil key lookup")
	}
	key := strings.TrimSpace(keyLookup(envKey))
	if key == "" {
		return nil, ErrMissingKey
	}
	return New(Config{Endpoint: endpoint, Key: key})
}

// analyzeStatus is the minimal poll-response envelope we inspect. The full
// succeeded body (with analyzeResult) is returned to the caller verbatim, so we
// only decode the status discriminator here.
type analyzeStatus struct {
	Status string          `json:"status"`
	Error  json.RawMessage `json:"error"`
}

// Scan submits image to Azure DI prebuilt-receipt, polls to completion, and
// returns the raw succeeded analyzeResults JSON. The full operation is bounded
// by ctx; cancel/deadline aborts the poll loop.
func (c *Client) Scan(ctx context.Context, image []byte) ([]byte, error) {
	if len(image) == 0 {
		return nil, errors.New("azure: empty image")
	}

	opLocation, err := c.submit(ctx, image)
	if err != nil {
		return nil, err
	}
	return c.poll(ctx, opLocation)
}

// submit POSTs the image and returns the Operation-Location poll URL.
func (c *Client) submit(ctx context.Context, image []byte) (string, error) {
	url := fmt.Sprintf("%s/%s?api-version=%s", c.endpoint, modelPath, c.apiVersion)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(image))
	if err != nil {
		return "", fmt.Errorf("azure: build analyze request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set(headerKey, c.key)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("azure: analyze POST: %w", err)
	}
	defer drainClose(resp.Body)

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return "", fmt.Errorf("azure: analyze returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	op := resp.Header.Get(headerOpLocation)
	if op == "" {
		return "", errors.New("azure: analyze response missing Operation-Location header")
	}
	return op, nil
}

// poll GETs opLocation on an interval until the operation reaches a terminal
// status, honouring ctx. The succeeded body is returned unmodified.
func (c *Client) poll(ctx context.Context, opLocation string) ([]byte, error) {
	for {
		body, err := c.pollOnce(ctx, opLocation)
		if err != nil {
			return nil, err
		}

		var st analyzeStatus
		if err := json.Unmarshal(body, &st); err != nil {
			return nil, fmt.Errorf("azure: decode poll status: %w", err)
		}

		switch strings.ToLower(st.Status) {
		case "succeeded":
			return body, nil
		case "failed":
			return nil, fmt.Errorf("azure: analyze failed: %s", strings.TrimSpace(string(st.Error)))
		case "", "notstarted", "running":
			// not terminal — wait and retry, unless the context is done.
		default:
			return nil, fmt.Errorf("azure: unexpected analyze status %q", st.Status)
		}

		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("azure: poll aborted: %w", ctx.Err())
		case <-time.After(c.pollInterval):
		}
	}
}

// pollOnce performs a single GET against the poll URL and returns the raw body.
func (c *Client) pollOnce(ctx context.Context, opLocation string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, opLocation, nil)
	if err != nil {
		return nil, fmt.Errorf("azure: build poll request: %w", err)
	}
	req.Header.Set(headerKey, c.key)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("azure: poll GET: %w", err)
	}
	defer drainClose(resp.Body)

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("azure: read poll body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("azure: poll returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// drainClose drains and closes a response body so the connection can be reused.
func drainClose(rc io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(rc, 4<<10))
	_ = rc.Close()
}
