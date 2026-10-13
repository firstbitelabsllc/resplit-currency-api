package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// Same-image scan recovery (P1 SCAN RECOVERY, 2026-07-27).
//
// The problem this solves, precisely: `ocrSpendGate.Allow` reserves the image
// hash BEFORE the provider runs and answers `duplicate_scan` on any repeat.
// That reservation is never released and never becomes a stored answer, so when
// a client loses transport mid-upload and retries the SAME image, the server
// replies 429 rate_limited. Production event
// 82d20dc195dd466a80ba6c552434d486 (2.0.0+5072) is that shape.
//
// Adding a client retry without fixing this would make it strictly worse: every
// retry would 429. Hence the PLAN's fixed sequencing — server first.
//
// Two mechanisms, both keyed on sha256(image):
//
//   - COALESCE: concurrent requests for the same image share ONE provider
//     execution. The second caller waits on the first rather than spending again.
//   - CACHE: a completed result is retained briefly, so a retry that arrives
//     AFTER the original finished (response lost in transit) is served from
//     memory with no provider call at all.
//
// Together they give the property the row demands: one provider execution per
// image, while a retry still returns a completed receipt.
//
// Deliberately NOT persisted across instances. This is a recovery window for a
// transport blip measured in seconds, not a durable cache; a cross-instance
// store would add a failure mode (stale/poisoned results surviving a deploy)
// far worse than the occasional duplicate it would prevent. The existing
// per-identity spend reservation remains the durable spend guard.
type scanCoalescer struct {
	mu       sync.Mutex
	inFlight map[string]*scanCall
	done     map[string]*scanEntry
	ttl      time.Duration
	now      func() time.Time
}

type scanCall struct {
	wg     sync.WaitGroup
	result []byte
	err    error
}

type scanEntry struct {
	result  []byte
	expires time.Time
}

func newScanCoalescer(ttl time.Duration, now func() time.Time) *scanCoalescer {
	if now == nil {
		now = time.Now
	}
	if ttl <= 0 {
		ttl = defaultScanCoalesceTTL
	}
	return &scanCoalescer{
		inFlight: make(map[string]*scanCall),
		done:     make(map[string]*scanEntry),
		ttl:      ttl,
		now:      now,
	}
}

// Do returns the provider result for `key`, running `fn` at most once for any
// set of overlapping or closely-spaced callers.
//
// The bool reports whether this caller executed fn rather than joining or
// replaying an existing result. Admission and provider calls use distinct keys.
func (c *scanCoalescer) Do(ctx context.Context, key string, fn func() ([]byte, error)) ([]byte, bool, error) {
	c.mu.Lock()

	// Completed recently: serve it. This is the lost-response retry path.
	if e, ok := c.done[key]; ok {
		if c.now().Before(e.expires) {
			result := e.result
			c.mu.Unlock()
			return result, false, nil
		}
		delete(c.done, key)
	}

	// Already running: wait for the in-flight execution instead of starting a
	// second one. This is the concurrent-retry path.
	if call, ok := c.inFlight[key]; ok {
		c.mu.Unlock()
		result, err := waitScanCall(ctx, call)
		return result, false, err
	}

	call := &scanCall{}
	call.wg.Add(1)
	c.inFlight[key] = call
	c.mu.Unlock()

	call.result, call.err = fn()
	call.wg.Done()

	c.mu.Lock()
	delete(c.inFlight, key)
	if call.err == nil {
		c.done[key] = &scanEntry{result: call.result, expires: c.now().Add(c.ttl)}
	}
	// Failed results are not cached. The durable per-identity reservation,
	// rather than this short-lived cache, decides whether resubmission is safe.
	c.sweepLocked()
	c.mu.Unlock()

	return call.result, true, call.err
}

// Recover can only join or replay existing work. Capturing the call under the
// same lock as its success entry prevents a capped retry racing into new work.
func (c *scanCoalescer) Recover(ctx context.Context, key string) ([]byte, bool, error) {
	c.mu.Lock()
	if e, ok := c.done[key]; ok && c.now().Before(e.expires) {
		c.mu.Unlock()
		return e.result, true, nil
	}
	call, ok := c.inFlight[key]
	c.mu.Unlock()
	if !ok {
		return nil, false, nil
	}
	result, err := waitScanCall(ctx, call)
	return result, true, err
}

func waitScanCall(ctx context.Context, call *scanCall) ([]byte, error) {
	waited := make(chan struct{})
	go func() { call.wg.Wait(); close(waited) }()
	select {
	case <-waited:
		return call.result, call.err
	case <-ctx.Done():
		// A waiter cannot cancel another request's paid provider execution.
		return nil, ctx.Err()
	}
}

// sweepLocked drops expired entries. Called under c.mu on each completed scan,
// which is frequent enough to bound the map without a background goroutine.
func (c *scanCoalescer) sweepLocked() {
	now := c.now()
	for k, e := range c.done {
		if !now.Before(e.expires) {
			delete(c.done, k)
		}
	}
}

// Lookup returns a completed result for `key` if one is still within the
// recovery window. Used by the duplicate-scan path to replay an answer whose
// response was lost in transit, without touching the provider.
func (c *scanCoalescer) Lookup(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.done[key]
	if !ok {
		return nil, false
	}
	if !c.now().Before(e.expires) {
		delete(c.done, key)
		return nil, false
	}
	return e.result, true
}

// scanImageKey is the coalescing key: sha256 over the exact image bytes.
func scanImageKey(image []byte) string {
	sum := sha256.Sum256(image)
	return hex.EncodeToString(sum[:])
}
