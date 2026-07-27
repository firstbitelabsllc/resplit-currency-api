package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Gates for P1 SCAN RECOVERY. The property under test is the one the PLAN row
// names: ONE provider execution per image, while a retry still completes.

func TestCoalescer_ConcurrentSameImage_RunsProviderOnce(t *testing.T) {
	c := newScanCoalescer(time.Minute, nil)
	var calls atomic.Int64
	release := make(chan struct{})

	// Hold the first call open so the others are genuinely concurrent rather
	// than serialised into cache hits — this exercises the in-flight path, not
	// the completed path.
	fn := func() ([]byte, error) {
		calls.Add(1)
		<-release
		return []byte(`{"ok":true}`), nil
	}

	const n = 8
	var wg sync.WaitGroup
	results := make([][]byte, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], _, errs[i] = c.Do(context.Background(), "img-a", fn)
		}(i)
	}
	// Let every goroutine reach Do before the first is allowed to finish.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("provider executed %d times, want exactly 1 — duplicate OCR/LLM spend", got)
	}
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d errored: %v", i, errs[i])
		}
		if string(results[i]) != `{"ok":true}` {
			t.Fatalf("caller %d got %q, want the shared provider result", i, results[i])
		}
	}
}

func TestCoalescer_SequentialRetry_ServesCacheWithoutProvider(t *testing.T) {
	// The lost-response case: the first scan completed but the client never saw
	// it. The retry must return a completed receipt with NO new provider spend.
	c := newScanCoalescer(time.Minute, nil)
	var calls atomic.Int64
	fn := func() ([]byte, error) {
		calls.Add(1)
		return []byte(`{"receipt":1}`), nil
	}

	first, executed, err := c.Do(context.Background(), "img-b", fn)
	if err != nil || !executed {
		t.Fatalf("first call: executed=%v err=%v, want executed=true nil", executed, err)
	}
	second, executed2, err := c.Do(context.Background(), "img-b", fn)
	if err != nil {
		t.Fatalf("retry errored: %v", err)
	}
	if executed2 {
		t.Fatal("retry executed the provider — that is the duplicate spend this row exists to prevent")
	}
	if string(first) != string(second) {
		t.Fatalf("retry got %q, want the original %q", second, first)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("provider executed %d times across original+retry, want 1", got)
	}

	// Lookup is the path handleScan uses on duplicate_scan.
	cached, ok := c.Lookup("img-b")
	if !ok || string(cached) != `{"receipt":1}` {
		t.Fatalf("Lookup returned (%q,%v), want the cached result", cached, ok)
	}
}

func TestCoalescer_FailedScanIsNotCached_StaysRetryable(t *testing.T) {
	// Caching a failure would turn one transient provider error into a window
	// where every retry of that image fails without reaching the provider —
	// strictly worse than the bug being fixed.
	c := newScanCoalescer(time.Minute, nil)
	var calls atomic.Int64
	boom := errors.New("provider exploded")
	fn := func() ([]byte, error) {
		calls.Add(1)
		if calls.Load() == 1 {
			return nil, boom
		}
		return []byte(`{"ok":true}`), nil
	}

	if _, _, err := c.Do(context.Background(), "img-c", fn); !errors.Is(err, boom) {
		t.Fatalf("first call err=%v, want the provider error", err)
	}
	if _, ok := c.Lookup("img-c"); ok {
		t.Fatal("a failed scan was cached — retries would be served a failure without touching the provider")
	}
	result, executed, err := c.Do(context.Background(), "img-c", fn)
	if err != nil || !executed || string(result) != `{"ok":true}` {
		t.Fatalf("retry after failure: result=%q executed=%v err=%v — must reach the provider again", result, executed, err)
	}
}

func TestCoalescer_DistinctImagesDoNotShare(t *testing.T) {
	c := newScanCoalescer(time.Minute, nil)
	var calls atomic.Int64
	mk := func(body string) func() ([]byte, error) {
		return func() ([]byte, error) { calls.Add(1); return []byte(body), nil }
	}
	a, _, _ := c.Do(context.Background(), "img-x", mk(`{"a":1}`))
	b, _, _ := c.Do(context.Background(), "img-y", mk(`{"b":2}`))
	if string(a) == string(b) {
		t.Fatal("distinct images shared a result — coalescing key is too coarse")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("provider executed %d times for 2 distinct images, want 2", got)
	}
}

func TestCoalescer_ExpiredEntryReachesProviderAgain(t *testing.T) {
	// The window is a transport-blip recovery, not a durable cache: a genuine
	// re-scan after the window must produce a fresh provider call.
	now := time.Unix(1000, 0)
	c := newScanCoalescer(30*time.Second, func() time.Time { return now })
	var calls atomic.Int64
	fn := func() ([]byte, error) { calls.Add(1); return []byte(`{"v":1}`), nil }

	c.Do(context.Background(), "img-d", fn)
	now = now.Add(31 * time.Second)
	if _, ok := c.Lookup("img-d"); ok {
		t.Fatal("entry survived past its TTL")
	}
	if _, executed, _ := c.Do(context.Background(), "img-d", fn); !executed {
		t.Fatal("post-expiry scan was served from cache; it must reach the provider")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("provider executed %d times, want 2 (one per window)", got)
	}
}

func TestCoalescer_WaiterCancellationDoesNotKillTheProviderCall(t *testing.T) {
	// A waiter giving up must not cancel the paid call the first requester is
	// still waiting on.
	c := newScanCoalescer(time.Minute, nil)
	var calls atomic.Int64
	release := make(chan struct{})
	fn := func() ([]byte, error) {
		calls.Add(1)
		<-release
		return []byte(`{"ok":true}`), nil
	}

	// Synchronise on a channel rather than sleeping and reading shared vars —
	// the sleep-then-read version is itself a data race and -race rightly
	// rejected it.
	type outcome struct {
		result []byte
		err    error
	}
	firstDone := make(chan outcome, 1)
	started := make(chan struct{})
	go func() {
		close(started)
		res, _, err := c.Do(context.Background(), "img-e", fn)
		firstDone <- outcome{result: res, err: err}
	}()
	<-started
	time.Sleep(30 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := c.Do(ctx, "img-e", fn); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter err=%v, want context.Canceled", err)
	}

	close(release)
	got := <-firstDone
	if got.err != nil || string(got.result) != `{"ok":true}` {
		t.Fatalf("original requester got result=%q err=%v — a waiter's cancellation killed it", got.result, got.err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("provider executed %d times, want 1", got)
	}
}
