package fx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

// ObjectWriter abstracts the artifact sink (in prod: a GCS bucket). It exists so
// PublishLatest can be unit-tested with a fake writer instead of hitting real
// GCS. The real implementation lives in cmd/fx-publish (behind a TODO(gcp)
// constructor) and wraps cloud.google.com/go/storage.
type ObjectWriter interface {
	// WriteObject uploads body to objectPath with the given contentType and
	// cacheControl header. It must overwrite any existing object atomically from
	// the reader's perspective (GCS object writes are atomic on Close).
	WriteObject(ctx context.Context, objectPath string, body []byte, contentType, cacheControl string) error
}

// Publish-path tuning knobs.
const (
	// ObjectContentType is the MIME type stamped on every precomputed object.
	ObjectContentType = "application/json; charset=utf-8"

	// ObjectCacheControl is the Cache-Control header for the precomputed objects
	// behind Cloud CDN. 5-minute edge cache + SWR keeps the read path warm while
	// the next publish cycle (Cloud Scheduler) refreshes the origin.
	ObjectCacheControl = "public, max-age=300, stale-while-revalidate=86400"

	// DefaultMaxRateAge is how stale a source snapshot's Date may be before the
	// freshness gate refuses to publish. ECB publishes on business days, so we
	// allow a weekend-plus-holiday cushion.
	DefaultMaxRateAge = 96 * time.Hour
)

// ErrCoverageGate is returned when fewer than minAgree sources passed quorum, so
// the 2-of-N quorum that fixes the May-2026 SPOF cannot be satisfied.
var ErrCoverageGate = errors.New("fx: coverage gate failed")

// ErrStaleGate is returned when every usable source snapshot is older than the
// configured freshness window, so we refuse to republish stale rates.
var ErrStaleGate = errors.New("fx: freshness gate failed")

// ErrEmptyReconcile is returned when reconciliation produced no rates at all
// (nothing passed quorum), which would yield an empty/garbage artifact set.
var ErrEmptyReconcile = errors.New("fx: reconciliation produced no rates")

// PublishConfig parameterizes a publish run.
type PublishConfig struct {
	// MinAgree is the quorum threshold forwarded to Reconcile (2 = the 2-of-N
	// fix for the May-2026 single-source outage).
	MinAgree int

	// MaxRateAge bounds snapshot staleness. Zero defaults to DefaultMaxRateAge.
	MaxRateAge time.Duration

	// Now is injected for deterministic tests. Nil defaults to time.Now.
	Now func() time.Time
}

func (c PublishConfig) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now().UTC()
}

func (c PublishConfig) maxRateAge() time.Duration {
	if c.MaxRateAge > 0 {
		return c.MaxRateAge
	}
	return DefaultMaxRateAge
}

// CurrencyObject is the precomputed per-currency artifact shape written to
// /latest/<ccy>.min.json. It is EUR-base: Rates maps every other currency code
// to units-per-1-<Base>, derived from the reconciled EUR-base table via
// CrossRate so iOS can convert without a second lookup.
type CurrencyObject struct {
	Base        string             `json:"base"`         // this object's base currency (upper-case)
	Date        string             `json:"date"`         // reconciled snapshot date (ISO-8601)
	GeneratedAt string             `json:"generated_at"` // RFC3339 publish timestamp
	Sources     []string           `json:"sources"`      // provider ids that contributed to quorum
	Rates       map[string]float64 `json:"rates"`        // <Base>->code, units-per-1-Base
}

// PublishResult summarizes a completed publish run for the caller's logs.
type PublishResult struct {
	Base          string   // EUR — the reconciliation base
	Date          string   // reconciled snapshot date
	Sources       []string // sources that contributed
	CurrencyCount int      // number of per-currency objects written
	FailedQuorum  []string // currencies that appeared but missed quorum
}

// PublishLatest is the publish-path entrypoint shared by the Cloud Run Job.
//
// Pipeline:
//  1. Fetch every source concurrently (a single source error is tolerated as
//     long as the coverage gate still passes).
//  2. Run the freshness gate over the snapshots that fetched.
//  3. Reconcile via the 2-of-N quorum (Reconcile).
//  4. Apply the coverage gate (>= minAgree sources actually contributed).
//  5. Precompute one EUR-base CurrencyObject per currency and write each to the
//     artifact sink as /latest/<ccy>.min.json.
//
// It never publishes a partial set: if any gate fails, nothing is written and
// the prior (good) artifacts stay live behind the CDN.
func PublishLatest(ctx context.Context, sources []Source, w ObjectWriter, cfg PublishConfig) (PublishResult, error) {
	if cfg.MinAgree < 1 {
		return PublishResult{}, fmt.Errorf("fx: MinAgree must be >= 1, got %d", cfg.MinAgree)
	}
	if w == nil {
		return PublishResult{}, errors.New("fx: nil object writer")
	}

	snaps := fetchAll(ctx, sources)

	// Coverage gate (pre-reconcile): we must have at least minAgree usable
	// snapshots, else quorum can never be reached. This is the gate that turns a
	// single-source day into a no-publish day instead of a wrong-rate day.
	if len(snaps) < cfg.MinAgree {
		return PublishResult{}, fmt.Errorf("%w: %d usable sources, need %d",
			ErrCoverageGate, len(snaps), cfg.MinAgree)
	}

	// Freshness gate: at least one snapshot must be within the staleness window.
	// A snapshot with an unparseable/blank date is treated as "fresh enough" so a
	// provider that omits a date can still anchor a publish, but it cannot be the
	// SOLE basis — coverage above already guarantees >= minAgree sources.
	if !anyFresh(snaps, cfg.now(), cfg.maxRateAge()) {
		return PublishResult{}, fmt.Errorf("%w: all %d snapshots older than %s",
			ErrStaleGate, len(snaps), cfg.maxRateAge())
	}

	rates, failed, err := Reconcile(snaps, cfg.MinAgree)
	if err != nil {
		return PublishResult{}, fmt.Errorf("fx: reconcile: %w", err)
	}
	if len(rates) == 0 {
		return PublishResult{}, ErrEmptyReconcile
	}

	contributing := snapshotSources(snaps)
	date := reconciledDate(snaps)
	generatedAt := cfg.now().UTC().Format(time.RFC3339)

	objects, err := PrecomputeObjects(rates, contributing, date, generatedAt)
	if err != nil {
		return PublishResult{}, fmt.Errorf("fx: precompute: %w", err)
	}

	for _, obj := range objects {
		body, marshalErr := json.Marshal(obj.payload)
		if marshalErr != nil {
			return PublishResult{}, fmt.Errorf("fx: marshal %s: %w", obj.path, marshalErr)
		}
		if writeErr := w.WriteObject(ctx, obj.path, body, ObjectContentType, ObjectCacheControl); writeErr != nil {
			return PublishResult{}, fmt.Errorf("fx: write %s: %w", obj.path, writeErr)
		}
	}

	return PublishResult{
		Base:          "EUR",
		Date:          date,
		Sources:       contributing,
		CurrencyCount: len(objects),
		FailedQuorum:  failed,
	}, nil
}

// precomputed pairs an object path with its marshalable payload.
type precomputed struct {
	path    string
	payload CurrencyObject
}

// PrecomputeObjects builds one EUR-base CurrencyObject per currency present in
// the reconciled table. Each object's Rates are base->code derived via CrossRate
// so the read path needs no second division. Object path is /latest/<ccy>.min.json
// with a lower-case currency code.
func PrecomputeObjects(rates map[string]float64, sources []string, date, generatedAt string) ([]precomputed, error) {
	// EUR is implicitly 1.0 in the EUR-base table; make it explicit so it gets
	// its own object even when no source listed it.
	base := make(map[string]float64, len(rates)+1)
	for k, v := range rates {
		base[k] = v
	}
	if _, ok := base["EUR"]; !ok {
		base["EUR"] = 1
	}

	codes := make([]string, 0, len(base))
	for code := range base {
		codes = append(codes, code)
	}
	sort.Strings(codes) // deterministic object order for stable diffs/tests

	out := make([]precomputed, 0, len(codes))
	for _, from := range codes {
		objRates := make(map[string]float64, len(base))
		for _, to := range codes {
			rate, err := CrossRate(base, from, to)
			if err != nil {
				return nil, fmt.Errorf("crossrate %s->%s: %w", from, to, err)
			}
			objRates[to] = rate
		}
		out = append(out, precomputed{
			path: ObjectPath(from),
			payload: CurrencyObject{
				Base:        from,
				Date:        date,
				GeneratedAt: generatedAt,
				Sources:     sources,
				Rates:       objRates,
			},
		})
	}
	return out, nil
}

// ObjectPath returns the artifact object key for a currency code, e.g.
// "USD" -> "latest/usd.min.json". The code is lower-cased to match the read-path
// URL convention (/latest/<ccy>.min.json).
func ObjectPath(code string) string {
	return "latest/" + toLowerASCII(code) + ".min.json"
}

// --- internal helpers ---------------------------------------------------------

// fetchResult carries one source's outcome off the worker goroutines.
type fetchResult struct {
	snap SourceSnapshot
	err  error
}

// fetchAll fetches every source concurrently and returns the snapshots that
// succeeded. Per-source errors are dropped here on purpose: the coverage gate in
// PublishLatest is the single place that decides whether enough sources survived.
func fetchAll(ctx context.Context, sources []Source) []SourceSnapshot {
	if len(sources) == 0 {
		return nil
	}

	results := make(chan fetchResult, len(sources))
	for _, src := range sources {
		go func(s Source) {
			snap, err := s.Fetch(ctx)
			results <- fetchResult{snap: snap, err: err}
		}(src)
	}

	snaps := make([]SourceSnapshot, 0, len(sources))
	for range sources {
		r := <-results
		if r.err != nil || len(r.snap.Rates) == 0 {
			continue
		}
		snaps = append(snaps, r.snap)
	}
	return snaps
}

// anyFresh reports whether at least one snapshot's Date is within maxAge of now.
// A blank/unparseable date counts as fresh (provenance unknown, not provably
// stale) so a date-less provider can still anchor a publish.
func anyFresh(snaps []SourceSnapshot, now time.Time, maxAge time.Duration) bool {
	for _, snap := range snaps {
		d, ok := parseSnapshotDate(snap.Date)
		if !ok {
			return true
		}
		if now.Sub(d) <= maxAge {
			return true
		}
	}
	return false
}

// parseSnapshotDate parses a snapshot Date as an ISO-8601 date (or RFC3339),
// returning false when it can't be interpreted.
func parseSnapshotDate(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// snapshotSources returns the sorted, de-duplicated list of contributing source
// ids for provenance stamping.
func snapshotSources(snaps []SourceSnapshot) []string {
	seen := make(map[string]struct{}, len(snaps))
	out := make([]string, 0, len(snaps))
	for _, snap := range snaps {
		if snap.Source == "" {
			continue
		}
		if _, ok := seen[snap.Source]; ok {
			continue
		}
		seen[snap.Source] = struct{}{}
		out = append(out, snap.Source)
	}
	sort.Strings(out)
	return out
}

// reconciledDate picks the most recent parseable snapshot date as the published
// date, falling back to the first non-empty raw date, then to "" .
func reconciledDate(snaps []SourceSnapshot) string {
	var best time.Time
	var bestRaw string
	var fallback string
	for _, snap := range snaps {
		if snap.Date == "" {
			continue
		}
		if fallback == "" {
			fallback = snap.Date
		}
		if d, ok := parseSnapshotDate(snap.Date); ok && d.After(best) {
			best = d
			bestRaw = snap.Date
		}
	}
	if bestRaw != "" {
		return bestRaw
	}
	return fallback
}

// toLowerASCII lower-cases an ASCII currency code without importing strings for
// this hot, single-purpose path. Currency codes are always ASCII letters.
func toLowerASCII(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
