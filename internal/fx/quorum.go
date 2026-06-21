package fx

import (
	"errors"
	"fmt"
	"sort"
)

// QuorumTolerance is the maximum relative spread allowed between two sources'
// values for the same currency before they are considered to disagree. Two
// rates a and b agree when |a-b| / min(a,b) <= QuorumTolerance.
//
// 0.5% absorbs normal provider jitter (different snapshot times, rounding)
// while still rejecting a source that has drifted or gone stale.
const QuorumTolerance = 0.005

// ErrInsufficientSources is returned when fewer than minAgree snapshots are
// supplied, so quorum can never be reached for any currency.
var ErrInsufficientSources = errors.New("fx: insufficient sources for quorum")

// SourceSnapshot is one provider's full EUR-base rate table for a given date.
type SourceSnapshot struct {
	Source string             // provider identifier, e.g. "ecb", "openexchange"
	Date   string             // ISO-8601 date the snapshot represents
	Rates  map[string]float64 // units-per-EUR, same convention as CrossRate
}

// Reconcile fuses multiple source snapshots into a single trusted rate table.
//
// For each currency it finds the largest cluster of sources whose values agree
// pairwise-with-the-cluster-median within QuorumTolerance. If that cluster has
// at least minAgree members the currency passes quorum and its reconciled value
// is the MEDIAN of the agreeing sources (median is robust to a single outlier
// and, unlike the mean, never invents a value outside the agreeing range).
//
// Returns:
//   - rates:  reconciled per-currency median for every currency that passed.
//   - failed: sorted list of currencies that appeared but failed quorum
//     (too few agreeing sources, or a hopeless split).
//   - err:    ErrInsufficientSources if len(snaps) < minAgree, since no currency
//     could possibly reach quorum in that case.
//
// This is the fix for the May-2026 single-source SPOF: a single provider can no
// longer move a published rate on its own.
func Reconcile(snaps []SourceSnapshot, minAgree int) (rates map[string]float64, failed []string, err error) {
	if minAgree < 1 {
		return nil, nil, fmt.Errorf("fx: minAgree must be >= 1, got %d", minAgree)
	}
	if len(snaps) < minAgree {
		return nil, nil, fmt.Errorf("%w: have %d, need %d", ErrInsufficientSources, len(snaps), minAgree)
	}

	// Collect every currency seen across all snapshots, and per-currency the
	// list of values reported by sources that actually carry that currency.
	valuesByCurrency := make(map[string][]float64)
	for _, snap := range snaps {
		for code, v := range snap.Rates {
			if v <= 0 {
				// Corrupt/missing value from this source; it simply doesn't
				// vote for this currency.
				continue
			}
			valuesByCurrency[code] = append(valuesByCurrency[code], v)
		}
	}

	rates = make(map[string]float64)
	for code, vals := range valuesByCurrency {
		agreeing := largestAgreeingCluster(vals)
		if len(agreeing) >= minAgree {
			rates[code] = median(agreeing)
		} else {
			failed = append(failed, code)
		}
	}

	sort.Strings(failed)
	return rates, failed, nil
}

// largestAgreeingCluster returns the largest subset of vals whose members are
// all within QuorumTolerance of the subset's median.
//
// Approach: sort the values, then for each value treated as a cluster anchor,
// grow a contiguous run (sorted order keeps agreeing values adjacent) and keep
// the run whose every member agrees with the run median. We test every
// contiguous window and keep the longest valid one. n is the number of sources
// (tiny — single digits), so the O(n^3) window scan is irrelevant in practice.
func largestAgreeingCluster(vals []float64) []float64 {
	if len(vals) <= 1 {
		out := make([]float64, len(vals))
		copy(out, vals)
		return out
	}

	sorted := make([]float64, len(vals))
	copy(sorted, vals)
	sort.Float64s(sorted)

	var best []float64
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j <= len(sorted); j++ {
			window := sorted[i:j]
			if windowAgrees(window) && len(window) > len(best) {
				best = window
			}
		}
	}

	out := make([]float64, len(best))
	copy(out, best)
	return out
}

// windowAgrees reports whether every value in window is within QuorumTolerance
// of the window's median.
func windowAgrees(window []float64) bool {
	m := median(window)
	for _, v := range window {
		if relDiff(v, m) > QuorumTolerance {
			return false
		}
	}
	return true
}

// relDiff returns the relative difference between a and b, normalized by the
// smaller magnitude so the tolerance is symmetric.
func relDiff(a, b float64) float64 {
	if a == b {
		return 0
	}
	denom := a
	if b < a {
		denom = b
	}
	if denom <= 0 {
		// Should not happen for positive rates; guard against div-by-zero.
		return 1
	}
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff / denom
}

// median returns the median of vals. It does not mutate the caller's slice.
// vals must be non-empty.
func median(vals []float64) float64 {
	sorted := make([]float64, len(vals))
	copy(sorted, vals)
	sort.Float64s(sorted)

	n := len(sorted)
	mid := n / 2
	if n%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}
