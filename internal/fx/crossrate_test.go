package fx

import (
	"errors"
	"math"
	"testing"
)

func TestCrossRate(t *testing.T) {
	// EUR-base table: units per 1 EUR.
	rates := map[string]float64{
		"EUR": 1.0,
		"USD": 1.0850,
		"JPY": 168.50,
		"GBP": 0.8550,
	}

	const eps = 1e-9

	tests := []struct {
		name    string
		from    string
		to      string
		want    float64
		wantErr error
	}{
		{
			name: "USD to JPY cross-rate",
			from: "USD",
			to:   "JPY",
			// JPY/EUR divided by USD/EUR = 168.50 / 1.0850.
			want: 168.50 / 1.0850,
		},
		{
			name: "EUR to USD is the base rate",
			from: "EUR",
			to:   "USD",
			want: 1.0850,
		},
		{
			name: "identity same currency returns 1",
			from: "USD",
			to:   "USD",
			want: 1.0,
		},
		{
			name:    "missing source currency errors",
			from:    "XAU",
			to:      "USD",
			wantErr: ErrUnknownCurrency,
		},
		{
			name:    "missing target currency errors",
			from:    "USD",
			to:      "XAU",
			wantErr: ErrUnknownCurrency,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CrossRate(rates, tt.from, tt.to)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("CrossRate(%q,%q) err = %v, want %v", tt.from, tt.to, err, tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("CrossRate(%q,%q) unexpected err = %v", tt.from, tt.to, err)
			}
			if math.Abs(got-tt.want) > eps {
				t.Fatalf("CrossRate(%q,%q) = %v, want %v", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

func TestCrossRateInvalidBaseRate(t *testing.T) {
	rates := map[string]float64{
		"EUR": 1.0,
		"BAD": 0.0, // corrupt
		"USD": 1.0850,
	}

	if _, err := CrossRate(rates, "BAD", "USD"); err == nil {
		t.Fatal("expected error for non-positive source base rate, got nil")
	}
	if _, err := CrossRate(rates, "USD", "BAD"); err == nil {
		t.Fatal("expected error for non-positive target base rate, got nil")
	}
}
