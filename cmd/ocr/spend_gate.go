package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

type ocrSpendStore interface {
	AllowRate(ctx context.Context, deviceID string, window time.Duration, limit int64) (allowed bool, count int64, err error)
	ReserveOCR(ctx context.Context, deviceID, hash string, ttl time.Duration) (fresh bool, err error)
}

type ocrSpendGate struct {
	store          ocrSpendStore
	mem            *memorySpendStore
	killSwitch     bool
	window         time.Duration
	idempotencyTTL time.Duration
	attestedLimit  int64
	softFailLimit  int64
}

func newOCRSpendGate(store attest.Store) *ocrSpendGate {
	var spendStore ocrSpendStore
	if s, ok := store.(ocrSpendStore); ok {
		spendStore = s
	}
	return &ocrSpendGate{
		store:          spendStore,
		mem:            newMemorySpendStore(time.Now),
		killSwitch:     envBool("OCR_SCAN_KILL_SWITCH"),
		window:         envDuration("OCR_SCAN_RATE_WINDOW", defaultScanWindow),
		idempotencyTTL: envDuration("OCR_IDEMPOTENCY_TTL", defaultIdempotencyTTL),
		attestedLimit:  envInt64("OCR_SCAN_DAILY_LIMIT", defaultAttestedScanLimit),
		softFailLimit:  envInt64("OCR_SOFT_FAIL_DAILY_LIMIT", defaultSoftFailScanLimit),
	}
}

func (g *ocrSpendGate) Allow(ctx context.Context, identity string, image []byte, softFail bool) (bool, string, int64, error) {
	if g.killSwitch {
		return false, "budget_kill_switch", 0, nil
	}
	if identity == "" {
		identity = "unknown"
	}

	limit := g.attestedLimit
	if softFail {
		limit = g.softFailLimit
	}
	if limit > 0 {
		allowed, count, err := g.spendStore().AllowRate(ctx, identity, g.window, limit)
		if err != nil {
			return false, "rate_error", count, err
		}
		if !allowed {
			return false, "rate_cap", count, nil
		}
	}

	hash := sha256.Sum256(image)
	fresh, err := g.spendStore().ReserveOCR(ctx, identity, hex.EncodeToString(hash[:]), g.idempotencyTTL)
	if err != nil {
		return false, "idempotency_error", 0, err
	}
	if !fresh {
		return false, "duplicate_scan", 0, nil
	}
	return true, "allowed", 0, nil
}

func (g *ocrSpendGate) spendStore() ocrSpendStore {
	if g.store != nil {
		return g.store
	}
	if g.mem == nil {
		g.mem = newMemorySpendStore(time.Now)
	}
	return g.mem
}

type memorySpendStore struct {
	mu    sync.Mutex
	now   func() time.Time
	rates map[string]int64
	seen  map[string]time.Time
}

func newMemorySpendStore(now func() time.Time) *memorySpendStore {
	if now == nil {
		now = time.Now
	}
	return &memorySpendStore{now: now, rates: make(map[string]int64), seen: make(map[string]time.Time)}
}

func (m *memorySpendStore) ReserveOCR(_ context.Context, deviceID, hash string, ttl time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	key := deviceID + ":" + hash
	if expiresAt, ok := m.seen[key]; ok && expiresAt.After(now) {
		return false, nil
	}
	if ttl <= 0 {
		ttl = defaultIdempotencyTTL
	}
	m.seen[key] = now.Add(ttl)
	return true, nil
}

func (m *memorySpendStore) AllowRate(_ context.Context, deviceID string, window time.Duration, limit int64) (bool, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := rateMemoryKey(deviceID, m.now(), window)
	m.rates[key]++
	count := m.rates[key]
	return count <= limit, count, nil
}

func rateMemoryKey(deviceID string, now time.Time, window time.Duration) string {
	return deviceID + ":" + strconv.FormatInt(scanWindowStartUnix(now, window), 10)
}

func scanWindowStartUnix(t time.Time, window time.Duration) int64 {
	if window <= 0 {
		return t.Unix()
	}
	w := int64(window / time.Second)
	if w <= 0 {
		return t.Unix()
	}
	return (t.Unix() / w) * w
}

func scanGateIdentity(r *http.Request, softFail bool, keyID string) string {
	if !softFail && keyID != "" {
		return "attest:" + keyID
	}
	return "soft:" + clientIP(r)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func envInt64(name string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err == nil {
		return d
	}
	seconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}
