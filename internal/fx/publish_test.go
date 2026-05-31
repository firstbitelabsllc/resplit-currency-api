package fx

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"testing"
	"time"
)

// fakeSource is a test-only Source returning a canned snapshot or error. No
// network is involved.
type fakeSource struct {
	snap SourceSnapshot
	err  error
}

func (f fakeSource) Fetch(_ context.Context) (SourceSnapshot, error) {
	return f.snap, f.err
}

// fakeWriter is a test-only fx.ObjectWriter that records every write in memory.
// It never touches GCS.
type fakeWriter struct {
	objects map[string][]byte
	calls   int
	failOn  string // if set, WriteObject returns an error for this path
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{objects: make(map[string][]byte)}
}

func (w *fakeWriter) WriteObject(_ context.Context, objectPath string, body []byte, _, _ string) error {
	w.calls++
	if w.failOn != "" && objectPath == w.failOn {
		return errors.New("simulated GCS write failure")
	}
	cp := make([]byte, len(body))
	copy(cp, body)
	w.objects[objectPath] = cp
	return nil
}

// fixedNow returns a deterministic clock for the freshness gate.
func fixedNow(s string) func() time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return func() time.Time { return t }
}

// eurBaseSnap is a small EUR-base snapshot helper.
func eurBaseSnap(source, date string, usd, gbp, jpy float64) SourceSnapshot {
	return SourceSnapshot{
		Source: source,
		Date:   date,
		Rates:  map[string]float64{"EUR": 1, "USD": usd, "GBP": gbp, "JPY": jpy},
	}
}

func TestPublishLatest(t *testing.T) {
	const today = "2026-05-30"

	tests := []struct {
		name          string
		sources       []Source
		cfg           PublishConfig
		writerFailOn  string
		wantErr       error    // sentinel the error must wrap (nil = success)
		wantWrites    bool     // whether any object should have been written
		wantBaseCount int      // expected per-currency objects on success
		wantSources   []string // expected provenance on success
	}{
		{
			name: "two sources agree -> publishes per-currency objects",
			sources: []Source{
				fakeSource{snap: eurBaseSnap("er-api", today, 1.0850, 0.8550, 168.20)},
				fakeSource{snap: eurBaseSnap("frankfurter", today, 1.0853, 0.8548, 168.30)},
			},
			cfg:           PublishConfig{MinAgree: 2, Now: fixedNow(today)},
			wantWrites:    true,
			wantBaseCount: 4, // EUR, USD, GBP, JPY
			wantSources:   []string{"er-api", "frankfurter"},
		},
		{
			name: "single source fails the coverage gate -> nothing written",
			sources: []Source{
				fakeSource{snap: eurBaseSnap("er-api", today, 1.0850, 0.8550, 168.20)},
			},
			cfg:        PublishConfig{MinAgree: 2, Now: fixedNow(today)},
			wantErr:    ErrCoverageGate,
			wantWrites: false,
		},
		{
			name: "one source errors, one succeeds -> coverage gate still fails",
			sources: []Source{
				fakeSource{err: errors.New("upstream 503")},
				fakeSource{snap: eurBaseSnap("frankfurter", today, 1.0853, 0.8548, 168.30)},
			},
			cfg:        PublishConfig{MinAgree: 2, Now: fixedNow(today)},
			wantErr:    ErrCoverageGate,
			wantWrites: false,
		},
		{
			name: "two sources but both stale -> freshness gate fails",
			sources: []Source{
				fakeSource{snap: eurBaseSnap("er-api", "2026-01-01", 1.0850, 0.8550, 168.20)},
				fakeSource{snap: eurBaseSnap("frankfurter", "2026-01-01", 1.0853, 0.8548, 168.30)},
			},
			cfg:        PublishConfig{MinAgree: 2, MaxRateAge: 96 * time.Hour, Now: fixedNow(today)},
			wantErr:    ErrStaleGate,
			wantWrites: false,
		},
		{
			name: "two sources disagree wildly -> no currency reaches quorum",
			sources: []Source{
				fakeSource{snap: SourceSnapshot{Source: "a", Date: today, Rates: map[string]float64{"USD": 1.08}}},
				fakeSource{snap: SourceSnapshot{Source: "b", Date: today, Rates: map[string]float64{"USD": 2.50}}},
			},
			cfg:     PublishConfig{MinAgree: 2, Now: fixedNow(today)},
			wantErr: ErrEmptyReconcile,
		},
		{
			name: "writer failure aborts and surfaces the error",
			sources: []Source{
				fakeSource{snap: eurBaseSnap("er-api", today, 1.0850, 0.8550, 168.20)},
				fakeSource{snap: eurBaseSnap("frankfurter", today, 1.0853, 0.8548, 168.30)},
			},
			cfg:          PublishConfig{MinAgree: 2, Now: fixedNow(today)},
			writerFailOn: "latest/eur.min.json",
			wantErr:      errors.New("write"), // matched by substring below
			wantWrites:   true,                // some objects may have written before the failure
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newFakeWriter()
			w.failOn = tt.writerFailOn

			result, err := PublishLatest(context.Background(), tt.sources, w, tt.cfg)

			switch {
			case tt.wantErr == nil:
				if err != nil {
					t.Fatalf("expected success, got error: %v", err)
				}
			case errors.Is(tt.wantErr, ErrCoverageGate),
				errors.Is(tt.wantErr, ErrStaleGate),
				errors.Is(tt.wantErr, ErrEmptyReconcile):
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("expected error wrapping %v, got: %v", tt.wantErr, err)
				}
			default:
				// substring sentinel (writer-failure case)
				if err == nil || !containsSubstr(err.Error(), tt.wantErr.Error()) {
					t.Fatalf("expected error containing %q, got: %v", tt.wantErr.Error(), err)
				}
			}

			if !tt.wantWrites && len(w.objects) != 0 {
				t.Fatalf("expected zero writes, got %d objects", len(w.objects))
			}

			if tt.wantErr == nil {
				if got := len(w.objects); got != tt.wantBaseCount {
					t.Fatalf("expected %d objects, got %d", tt.wantBaseCount, got)
				}
				if result.CurrencyCount != tt.wantBaseCount {
					t.Fatalf("result.CurrencyCount = %d, want %d", result.CurrencyCount, tt.wantBaseCount)
				}
				if result.Base != "EUR" {
					t.Fatalf("result.Base = %q, want EUR", result.Base)
				}
				if !equalStrings(result.Sources, tt.wantSources) {
					t.Fatalf("result.Sources = %v, want %v", result.Sources, tt.wantSources)
				}
			}
		})
	}
}

// TestPublishLatest_PerCurrencyObjectShape asserts the precomputed object shape
// and that the cross-rates are correctly base-rebased (not just EUR-base copied).
func TestPublishLatest_PerCurrencyObjectShape(t *testing.T) {
	const today = "2026-05-30"
	w := newFakeWriter()

	sources := []Source{
		fakeSource{snap: eurBaseSnap("er-api", today, 1.0850, 0.8550, 168.20)},
		fakeSource{snap: eurBaseSnap("frankfurter", today, 1.0850, 0.8550, 168.20)},
	}
	cfg := PublishConfig{MinAgree: 2, Now: fixedNow(today)}

	if _, err := PublishLatest(context.Background(), sources, w, cfg); err != nil {
		t.Fatalf("publish failed: %v", err)
	}

	// The USD object must exist at the lower-cased path.
	body, ok := w.objects["latest/usd.min.json"]
	if !ok {
		t.Fatalf("missing latest/usd.min.json; have %v", sortedKeys(w.objects))
	}

	var obj CurrencyObject
	if err := json.Unmarshal(body, &obj); err != nil {
		t.Fatalf("usd object is not valid JSON: %v", err)
	}

	if obj.Base != "USD" {
		t.Fatalf("obj.Base = %q, want USD", obj.Base)
	}
	if obj.Date != today {
		t.Fatalf("obj.Date = %q, want %q", obj.Date, today)
	}
	if obj.GeneratedAt == "" {
		t.Fatalf("obj.GeneratedAt is empty")
	}
	if !equalStrings(obj.Sources, []string{"er-api", "frankfurter"}) {
		t.Fatalf("obj.Sources = %v, want [er-api frankfurter]", obj.Sources)
	}

	// USD->USD identity.
	if got := obj.Rates["USD"]; got != 1.0 {
		t.Fatalf("USD->USD = %v, want 1.0", got)
	}
	// USD->EUR = 1/1.0850 (rebased from EUR-base).
	wantUSDtoEUR := 1.0 / 1.0850
	if got := obj.Rates["EUR"]; math.Abs(got-wantUSDtoEUR) > 1e-9 {
		t.Fatalf("USD->EUR = %v, want %v", got, wantUSDtoEUR)
	}
	// USD->GBP = 0.8550 / 1.0850.
	wantUSDtoGBP := 0.8550 / 1.0850
	if got := obj.Rates["GBP"]; math.Abs(got-wantUSDtoGBP) > 1e-9 {
		t.Fatalf("USD->GBP = %v, want %v", got, wantUSDtoGBP)
	}

	// Every currency gets its own object, including the EUR base.
	for _, ccy := range []string{"eur", "usd", "gbp", "jpy"} {
		if _, ok := w.objects["latest/"+ccy+".min.json"]; !ok {
			t.Fatalf("missing object for %s", ccy)
		}
	}
}

func TestPrecomputeObjects_DeterministicAndComplete(t *testing.T) {
	rates := map[string]float64{"USD": 1.10, "GBP": 0.85}
	objs, err := PrecomputeObjects(rates, []string{"er-api", "frankfurter"}, "2026-05-30", "2026-05-30T00:00:00Z")
	if err != nil {
		t.Fatalf("precompute: %v", err)
	}
	// EUR injected + USD + GBP = 3 objects, sorted by code.
	if len(objs) != 3 {
		t.Fatalf("got %d objects, want 3", len(objs))
	}
	wantPaths := []string{"latest/eur.min.json", "latest/gbp.min.json", "latest/usd.min.json"}
	for i, want := range wantPaths {
		if objs[i].path != want {
			t.Fatalf("objs[%d].path = %q, want %q", i, objs[i].path, want)
		}
	}
}

func TestObjectPath(t *testing.T) {
	cases := map[string]string{
		"USD": "latest/usd.min.json",
		"eur": "latest/eur.min.json",
		"JPY": "latest/jpy.min.json",
	}
	for in, want := range cases {
		if got := ObjectPath(in); got != want {
			t.Fatalf("ObjectPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- small test helpers -------------------------------------------------------

func containsSubstr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
