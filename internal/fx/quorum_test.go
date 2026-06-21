package fx

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestReconcile(t *testing.T) {
	const eps = 1e-9

	tests := []struct {
		name       string
		snaps      []SourceSnapshot
		minAgree   int
		wantRates  map[string]float64
		wantFailed []string
		wantErr    error
	}{
		{
			name:     "2 of 3 agreement yields median of agreeing sources",
			minAgree: 2,
			snaps: []SourceSnapshot{
				{Source: "ecb", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0850, "JPY": 168.50}},
				{Source: "oxr", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0853, "JPY": 168.55}},
				{Source: "fxa", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0848, "JPY": 168.40}},
			},
			// All three agree within 0.5%, so median of three values.
			wantRates: map[string]float64{
				"USD": 1.0850, // median(1.0848, 1.0850, 1.0853)
				"JPY": 168.50, // median(168.40, 168.50, 168.55)
			},
			wantFailed: nil,
		},
		{
			name:     "one outlier source rejected, median of the agreeing two",
			minAgree: 2,
			snaps: []SourceSnapshot{
				{Source: "ecb", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0850}},
				{Source: "oxr", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0852}},
				// Outlier: ~10% high, outside the 0.5% tolerance.
				{Source: "bad", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.20}},
			},
			wantRates: map[string]float64{
				"USD": (1.0850 + 1.0852) / 2, // median of the two agreeing sources
			},
			wantFailed: nil,
		},
		{
			name:     "currency fails quorum when only one source agrees",
			minAgree: 2,
			snaps: []SourceSnapshot{
				{Source: "ecb", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0850}},
				{Source: "oxr", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.30}},
				{Source: "fxa", Date: "2026-05-30", Rates: map[string]float64{"USD": 0.90}},
			},
			// No two of {1.0850, 1.30, 0.90} agree within 0.5%.
			wantRates:  map[string]float64{},
			wantFailed: []string{"USD"},
		},
		{
			name:     "insufficient sources returns error",
			minAgree: 2,
			snaps: []SourceSnapshot{
				{Source: "ecb", Date: "2026-05-30", Rates: map[string]float64{"USD": 1.0850}},
			},
			wantErr: ErrInsufficientSources,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRates, gotFailed, err := Reconcile(tt.snaps, tt.minAgree)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("Reconcile() err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Reconcile() unexpected err = %v", err)
			}

			if len(gotRates) != len(tt.wantRates) {
				t.Fatalf("Reconcile() rates = %v, want %v", gotRates, tt.wantRates)
			}
			for code, want := range tt.wantRates {
				got, ok := gotRates[code]
				if !ok {
					t.Fatalf("Reconcile() missing currency %q in rates %v", code, gotRates)
				}
				if math.Abs(got-want) > eps {
					t.Fatalf("Reconcile() rates[%q] = %v, want %v", code, got, want)
				}
			}

			if len(gotFailed) != 0 || len(tt.wantFailed) != 0 {
				if !reflect.DeepEqual(gotFailed, tt.wantFailed) {
					t.Fatalf("Reconcile() failed = %v, want %v", gotFailed, tt.wantFailed)
				}
			}
		})
	}
}

func TestReconcileMinAgreeValidation(t *testing.T) {
	if _, _, err := Reconcile(nil, 0); err == nil {
		t.Fatal("expected error for minAgree < 1, got nil")
	}
}
