package fx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Source fetches one provider's EUR-base rate snapshot.
//
// Each implementation owns exactly one upstream provider and an injected
// *http.Client so tests can supply a stub transport (or a fake Source entirely)
// without touching the network. The returned SourceSnapshot is normalized to the
// package-wide EUR-base, units-per-EUR convention (see crossrate.go).
type Source interface {
	// Fetch returns the latest EUR-base snapshot from this provider. It must
	// honor ctx cancellation/deadline and must NOT return a partially-zeroed
	// snapshot: an error is preferable to silently voting with bad data, since
	// Reconcile drops non-positive rates per-currency anyway.
	Fetch(ctx context.Context) (SourceSnapshot, error)
}

// HTTPDoer is the minimal slice of *http.Client the sources depend on. Accepting
// the interface (rather than *http.Client) is what makes the sources testable
// with a fake round-tripper or a fake doer.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// maxRatePayloadBytes caps how much of a provider response we read. The rate
// tables are a few KiB; this guards against a hostile/buggy upstream streaming
// unbounded bytes into memory inside a Cloud Run Job.
const maxRatePayloadBytes = 1 << 20 // 1 MiB

// --- open.er-api.com (Exchange Rate API) --------------------------------------

// erAPIDefaultURL is the EUR-base latest endpoint for open.er-api.com. The path
// already pins the base currency, so the response "rates" are units-per-EUR.
const erAPIDefaultURL = "https://open.er-api.com/v6/latest/EUR"

// ERAPISource fetches EUR-base rates from open.er-api.com/v6/latest/EUR.
type ERAPISource struct {
	Client HTTPDoer
	URL    string // overridable for tests; defaults to erAPIDefaultURL.
}

// NewERAPISource builds an open.er-api.com source over the given doer. A nil
// doer falls back to http.DefaultClient so callers can omit it in production.
func NewERAPISource(client HTTPDoer) *ERAPISource {
	if client == nil {
		client = http.DefaultClient
	}
	return &ERAPISource{Client: client, URL: erAPIDefaultURL}
}

// erAPIResponse is the subset of the open.er-api.com payload we consume.
type erAPIResponse struct {
	Result            string             `json:"result"`
	TimeLastUpdateUTC string             `json:"time_last_update_utc"`
	BaseCode          string             `json:"base_code"`
	Rates             map[string]float64 `json:"rates"`
}

// Fetch implements Source.
func (s *ERAPISource) Fetch(ctx context.Context) (SourceSnapshot, error) {
	url := s.URL
	if url == "" {
		url = erAPIDefaultURL
	}
	body, err := getJSON(ctx, s.Client, url)
	if err != nil {
		return SourceSnapshot{}, fmt.Errorf("er-api: %w", err)
	}

	var raw erAPIResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return SourceSnapshot{}, fmt.Errorf("er-api: decode: %w", err)
	}
	if raw.Result != "" && raw.Result != "success" {
		return SourceSnapshot{}, fmt.Errorf("er-api: upstream result %q", raw.Result)
	}
	if base := strings.ToUpper(raw.BaseCode); base != "" && base != "EUR" {
		return SourceSnapshot{}, fmt.Errorf("er-api: unexpected base %q, want EUR", base)
	}
	if len(raw.Rates) == 0 {
		return SourceSnapshot{}, fmt.Errorf("er-api: empty rate table")
	}

	return SourceSnapshot{
		Source: "er-api",
		Date:   normalizeERAPIDate(raw.TimeLastUpdateUTC),
		Rates:  upperKeys(raw.Rates),
	}, nil
}

// --- frankfurter.app (ECB) ----------------------------------------------------

// frankfurterDefaultURL is the EUR-base latest endpoint backed by ECB reference
// rates. Frankfurter is EUR-base by default, so no base param is needed.
const frankfurterDefaultURL = "https://api.frankfurter.app/latest?base=EUR"

// FrankfurterSource fetches EUR-base ECB reference rates from frankfurter.app.
type FrankfurterSource struct {
	Client HTTPDoer
	URL    string // overridable for tests; defaults to frankfurterDefaultURL.
}

// NewFrankfurterSource builds a frankfurter.app/ECB source over the given doer.
func NewFrankfurterSource(client HTTPDoer) *FrankfurterSource {
	if client == nil {
		client = http.DefaultClient
	}
	return &FrankfurterSource{Client: client, URL: frankfurterDefaultURL}
}

// frankfurterResponse is the subset of the frankfurter.app payload we consume.
type frankfurterResponse struct {
	Base  string             `json:"base"`
	Date  string             `json:"date"`
	Rates map[string]float64 `json:"rates"`
}

// Fetch implements Source.
func (s *FrankfurterSource) Fetch(ctx context.Context) (SourceSnapshot, error) {
	url := s.URL
	if url == "" {
		url = frankfurterDefaultURL
	}
	body, err := getJSON(ctx, s.Client, url)
	if err != nil {
		return SourceSnapshot{}, fmt.Errorf("frankfurter: %w", err)
	}

	var raw frankfurterResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return SourceSnapshot{}, fmt.Errorf("frankfurter: decode: %w", err)
	}
	if base := strings.ToUpper(raw.Base); base != "" && base != "EUR" {
		return SourceSnapshot{}, fmt.Errorf("frankfurter: unexpected base %q, want EUR", base)
	}
	if len(raw.Rates) == 0 {
		return SourceSnapshot{}, fmt.Errorf("frankfurter: empty rate table")
	}

	rates := upperKeys(raw.Rates)
	// Frankfurter omits the base from its own rate table; make EUR explicit so a
	// per-currency loop over reconciled rates includes the identity entry.
	if _, ok := rates["EUR"]; !ok {
		rates["EUR"] = 1
	}

	return SourceSnapshot{
		Source: "frankfurter",
		Date:   raw.Date, // already ISO-8601 (YYYY-MM-DD)
		Rates:  rates,
	}, nil
}

// --- shared HTTP plumbing -----------------------------------------------------

// getJSON performs a GET and returns the (bounded) response body, mapping
// non-2xx and transport failures to errors. It never returns a nil error with an
// empty body.
func getJSON(ctx context.Context, client HTTPDoer, url string) ([]byte, error) {
	if client == nil {
		client = http.DefaultClient
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "resplit-fx-publish/1 (+https://resplit.app)")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("transport: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRatePayloadBytes))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("empty response body")
	}
	return body, nil
}

// upperKeys returns a copy of m with all keys upper-cased, so currency codes are
// compared on a single canonical case across providers.
func upperKeys(m map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(m))
	for k, v := range m {
		out[strings.ToUpper(k)] = v
	}
	return out
}

// normalizeERAPIDate maps open.er-api.com's RFC1123-ish time_last_update_utc
// (e.g. "Fri, 30 May 2026 00:00:01 +0000") to an ISO-8601 date when possible,
// falling back to the raw string so we never drop provenance.
func normalizeERAPIDate(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	for _, layout := range []string{
		"Mon, 02 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"Mon, 02 Jan 2006 15:04:05 MST",
	} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC().Format("2006-01-02")
		}
	}
	return raw
}
