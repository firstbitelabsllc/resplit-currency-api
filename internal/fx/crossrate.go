// Package fx implements the foreign-exchange read-path and publish-path
// primitives for the GCP rewrite of resplit-currency-api.
//
// Rates throughout this package are EUR-base: every value is "units of the
// currency per 1 EUR" (e.g. rates["USD"] == 1.0850 means 1 EUR = 1.0850 USD).
// EUR itself is implicitly 1.0 and may be present explicitly as rates["EUR"].
package fx

import (
	"errors"
	"fmt"
)

// ErrUnknownCurrency is returned when a requested currency code is not present
// in the rate table.
var ErrUnknownCurrency = errors.New("fx: unknown currency")

// CrossRate computes the from->to exchange rate from an EUR-base rate table.
//
// Because rates are units-per-EUR, converting an amount in `from` to `to` is:
//
//	amount_to = amount_from * (rates[to] / rates[from])
//
// so the from->to rate is rates[to] / rates[from].
//
// Rules:
//   - from == to returns 1 with no lookup (identity, even for unknown codes is
//     intentionally NOT allowed — both codes must be valid for a real pair, but
//     an identity pair short-circuits before lookup).
//   - A missing `from` or `to` currency returns ErrUnknownCurrency (wrapped with
//     the offending code for diagnostics).
//   - A non-positive base rate is treated as corrupt data and returns an error
//     rather than producing Inf/NaN.
func CrossRate(rates map[string]float64, from, to string) (float64, error) {
	if from == to {
		return 1, nil
	}

	fromRate, ok := rates[from]
	if !ok {
		return 0, fmt.Errorf("%w: %q (source)", ErrUnknownCurrency, from)
	}
	toRate, ok := rates[to]
	if !ok {
		return 0, fmt.Errorf("%w: %q (target)", ErrUnknownCurrency, to)
	}

	if fromRate <= 0 {
		return 0, fmt.Errorf("fx: invalid base rate %g for %q", fromRate, from)
	}
	if toRate <= 0 {
		return 0, fmt.Errorf("fx: invalid base rate %g for %q", toRate, to)
	}

	return toRate / fromRate, nil
}
