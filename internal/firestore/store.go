// Package firestore provides the Firestore-backed state for the OCR Cloud Run
// service: the App Attest device-key store (attest.Store), an OCR idempotency
// guard, and per-device rate caps.
//
// The Firestore SDK (cloud.google.com/go/firestore) is heavy and needs
// Application Default Credentials at runtime, neither of which a unit test
// should require. So every Firestore document operation this package needs is
// expressed through the small docStore interface below, and FirestoreStore is
// built over that seam. Tests drive a pure in-memory docStore; production wires
// a *firestore.Client-backed docStore (see NewFirestoreStore + the TODO(gcp)
// adapter at the bottom of this file).
//
// Collections owned here:
//
//	attest_keys       doc id = keyID                 { pubSPKI []byte, signCount int64 }
//	ocr_idempotency   doc id = deviceID:hash         { createdAt, expiresAt (TTL field) }
//	rate_caps         doc id = deviceID:windowStart  { count (firestore.Increment) }
package firestore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

// Collection + field names. Kept as constants so the live adapter and the tests
// agree on the exact Firestore shape.
const (
	collAttestKeys     = "attest_keys"
	collOCRIdempotency = "ocr_idempotency"
	collRateCaps       = "rate_caps"

	fieldPubSPKI   = "pubSPKI"
	fieldSignCount = "signCount"
	fieldCreatedAt = "createdAt"
	fieldExpiresAt = "expiresAt" // Firestore TTL policy field on ocr_idempotency
	fieldCount     = "count"
	fieldOperation = "acceptedOperation"
)

// ErrNotFound is the sentinel a docStore returns when a document is absent. It
// is an implementation detail of this package: GetKey translates it into
// attest.ErrUnknownKey so callers switch on the attest sentinel, not ours.
var ErrNotFound = errors.New("firestore: document not found")

// docStore is the minimal Firestore surface FirestoreStore depends on. Each
// method targets a single document by (collection, id).
//
// Get/Set/Create/Delete own single-document I/O; Transact preserves the
// alias group atomically for registration, counter advance and accounting.
type docStore interface {
	Get(ctx context.Context, coll, id string) (map[string]any, error)
	Set(ctx context.Context, coll, id string, fields map[string]any) error
	Create(ctx context.Context, coll, id string, fields map[string]any) error
	Delete(ctx context.Context, coll, id string) error
	Transact(ctx context.Context, fn func(docTransaction) error) error
}

type docTransaction interface {
	GetAll(coll string, ids []string) (map[string]map[string]any, error)
	Set(coll, id string, fields map[string]any) error
	Create(coll, id string, fields map[string]any) error
}

func keyAliases(id string) []string {
	aliases, err := attest.KeyIDAliases(id)
	if err != nil {
		return []string{id}
	}
	return aliases
}

func identityAliases(id string) []string {
	if !strings.HasPrefix(id, "attest:") {
		return []string{id}
	}
	aliases := keyAliases(strings.TrimPrefix(id, "attest:"))
	for i := range aliases {
		aliases[i] = "attest:" + aliases[i]
	}
	return aliases
}

// ErrAlreadyExists is returned by docStore.Create when the document is already
// present. ReserveOCR maps it to a non-error "already seen" signal.
var ErrAlreadyExists = errors.New("firestore: document already exists")

// ErrConflict is returned by AdvanceInt64IfGreater when the stored value is
// already greater than or equal to next (lost race or stale assertion).
var ErrConflict = errors.New("firestore: advance conflict")

// ErrOCRRecovery retains the spend fence when durable recovery state is
// expired, malformed or inconsistent. It never authorizes another submission.
var ErrOCRRecovery = errors.New("firestore: ocr recovery state unavailable")

// FirestoreStore implements attest.Store and hosts the idempotency + rate-cap
// helpers over a docStore.
type FirestoreStore struct {
	docs docStore
	// now is injectable so TTL/window math is deterministic under test.
	now func() time.Time
}

// NewStore builds a FirestoreStore over an arbitrary docStore. Production passes
// the *firestore.Client adapter; tests pass an in-memory fake.
func NewStore(docs docStore) *FirestoreStore {
	return &FirestoreStore{docs: docs, now: time.Now}
}

// compile-time assertion that FirestoreStore satisfies the attest.Store contract.
var _ attest.Store = (*FirestoreStore)(nil)

// ---- attest.Store ------------------------------------------------------------

// GetKey loads the attested key's SPKI and signCount from attest_keys/{keyID}.
// A missing document is reported as attest.ErrUnknownKey so the verifier path
// can switch on the shared sentinel.
func (s *FirestoreStore) GetKey(ctx context.Context, keyID string) ([]byte, uint32, error) {
	fields, err := s.docs.Get(ctx, collAttestKeys, keyID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, 0, attest.ErrUnknownKey
		}
		return nil, 0, fmt.Errorf("firestore get key %q: %w", keyID, err)
	}

	spki, err := bytesField(fields, fieldPubSPKI)
	if err != nil {
		return nil, 0, fmt.Errorf("firestore key %q: %w", keyID, err)
	}
	count, err := uint32Field(fields, fieldSignCount)
	if err != nil {
		return nil, 0, fmt.Errorf("firestore key %q: %w", keyID, err)
	}
	return spki, count, nil
}

// PutKey writes (or replaces) attest_keys/{keyID}. signCount is stored as int64
// because Firestore has no native unsigned integer type; GetKey narrows it back.
func (s *FirestoreStore) PutKey(ctx context.Context, keyID string, pubSPKI []byte, signCount uint32) error {
	fields := map[string]any{
		fieldPubSPKI:   pubSPKI,
		fieldSignCount: int64(signCount),
	}
	if err := s.docs.Set(ctx, collAttestKeys, keyID, fields); err != nil {
		return fmt.Errorf("firestore put key %q: %w", keyID, err)
	}
	return nil
}

// AdvanceSignCount atomically moves attest_keys/{keyID}.signCount to next when
// the stored counter is strictly less than next. Maps a missing document to
// attest.ErrUnknownKey and a lost race / stale next onto a REPLAY *Error so
// VerifyAssertion fails closed without regressing the counter.
func (s *FirestoreStore) AdvanceSignCount(ctx context.Context, keyID string, next uint32) error {
	err := s.docs.Transact(ctx, func(tx docTransaction) error {
		all, err := tx.GetAll(collAttestKeys, keyAliases(keyID))
		if err != nil {
			return err
		}
		canonical, ok := all[keyID]
		if !ok {
			return ErrNotFound
		}
		spki, err := bytesField(canonical, fieldPubSPKI)
		if err != nil {
			return err
		}
		var maximum uint32
		for _, fields := range all {
			old, err := bytesField(fields, fieldPubSPKI)
			if err != nil {
				return err
			}
			if !bytes.Equal(old, spki) {
				return &attest.Error{Code: "ALREADY", Msg: "legacy public key conflict"}
			}
			count, err := uint32Field(fields, fieldSignCount)
			if err != nil {
				return err
			}
			if count > maximum {
				maximum = count
			}
		}
		if next <= maximum {
			return ErrConflict
		}
		return tx.Set(collAttestKeys, keyID, map[string]any{fieldSignCount: int64(next)})
	})
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return attest.ErrUnknownKey
	case errors.Is(err, ErrConflict):
		return &attest.Error{Code: "REPLAY", Msg: fmt.Sprintf("signCount %d did not advance", next)}
	default:
		return fmt.Errorf("firestore advance signCount %q: %w", keyID, err)
	}
}

// ---- idempotency -------------------------------------------------------------

// idempotencyID is the ocr_idempotency document id: deviceID:hash. hash is the
// caller's content hash of the scanned image (e.g. hex SHA-256), so a retried
// upload of the same bytes from the same device collapses to one record.
func idempotencyID(deviceID, hash string) string {
	return deviceID + ":" + hash
}

// ReserveOCR claims the (deviceID, hash) pair for one OCR spend. It returns
// fresh=true when this is the first time the pair is seen (the caller SHOULD
// proceed to call Azure DI) and fresh=false when a prior record exists within
// its TTL (the caller SHOULD skip the spend — it is a duplicate scan).
//
// The reservation document carries an expiresAt field; a Firestore TTL policy on
// ocr_idempotency.expiresAt reaps it after the window so the collection does not
// grow unbounded. ttl is how long a claim suppresses duplicates.
func (s *FirestoreStore) ReserveOCR(ctx context.Context, deviceID, hash string, ttl time.Duration) (fresh bool, err error) {
	now := s.now()
	fields := map[string]any{
		fieldCreatedAt: now,
		fieldExpiresAt: now.Add(ttl),
	}
	err = s.docs.Transact(ctx, func(tx docTransaction) error {
		fresh = false
		ids := identityAliases(deviceID)
		for i := range ids {
			ids[i] = idempotencyID(ids[i], hash)
		}
		all, err := tx.GetAll(collOCRIdempotency, ids)
		if err != nil {
			return err
		}
		if len(all) > 0 {
			return nil
		}
		fresh = true
		return tx.Create(collOCRIdempotency, idempotencyID(deviceID, hash), fields)
	})
	if err != nil {
		return false, fmt.Errorf("firestore reserve ocr: %w", err)
	}
	return fresh, nil
}

// HasOCRReservation reads the same durable record that ReserveOCR treats as
// authoritative. Expiration alone does not delete a Firestore reservation.
func (s *FirestoreStore) HasOCRReservation(ctx context.Context, deviceID, hash string) (bool, error) {
	for _, alias := range identityAliases(deviceID) {
		_, err := s.docs.Get(ctx, collOCRIdempotency, idempotencyID(alias, hash))
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return false, fmt.Errorf("firestore read ocr reservation: %w", err)
		}
	}
	return false, nil
}

// RecordOCROperation attaches the accepted provider reference to existing own
// reservations atomically. Neither their namespace nor expiry is changed.
func (s *FirestoreStore) RecordOCROperation(ctx context.Context, deviceID, hash, operation string) error {
	if operation == "" || len(operation) > 2048 {
		return ErrOCRRecovery
	}
	_, err := s.ocrOperation(ctx, deviceID, hash, operation)
	return err
}

// GetOCROperation reads only the authenticated principal's reservation group.
// Old reservations without an accepted reference remain a no-resubmit fence.
func (s *FirestoreStore) GetOCROperation(ctx context.Context, deviceID, hash string) (string, error) {
	return s.ocrOperation(ctx, deviceID, hash, "")
}

func (s *FirestoreStore) ocrOperation(ctx context.Context, deviceID, hash, record string) (string, error) {
	var operation string
	err := s.docs.Transact(ctx, func(tx docTransaction) error {
		operation = ""
		ids := identityAliases(deviceID)
		for i := range ids {
			ids[i] = idempotencyID(ids[i], hash)
		}
		all, err := tx.GetAll(collOCRIdempotency, ids)
		if err != nil {
			return err
		}
		if len(all) == 0 {
			if record != "" {
				return ErrOCRRecovery
			}
			return nil
		}
		for _, fields := range all {
			expires, ok := fields[fieldExpiresAt].(time.Time)
			if !ok || !expires.After(s.now()) {
				return ErrOCRRecovery
			}
			if value, exists := fields[fieldOperation]; exists {
				op, ok := value.(string)
				if !ok || op == "" || len(op) > 2048 || (operation != "" && operation != op) {
					return ErrOCRRecovery
				}
				operation = op
			}
		}
		if record == "" {
			return nil
		}
		if operation != "" && operation != record {
			return ErrOCRRecovery
		}
		for id := range all {
			if err := tx.Set(collOCRIdempotency, id, map[string]any{fieldOperation: record}); err != nil {
				return err
			}
		}
		operation = record
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("firestore ocr recovery: %w", err)
	}
	return operation, nil
}

// ReleaseOCR removes a prior ReserveOCR claim so a failed provider attempt can
// retry the same (deviceID, hash) without waiting for Firestore TTL. Missing
// documents are treated as already released.
func (s *FirestoreStore) ReleaseOCR(ctx context.Context, deviceID, hash string) error {
	id := idempotencyID(deviceID, hash)
	if err := s.docs.Delete(ctx, collOCRIdempotency, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return fmt.Errorf("firestore release ocr %q: %w", id, err)
	}
	return nil
}

// ---- rate caps ---------------------------------------------------------------

// windowStartUnix floors t to the start of its fixed window and returns the unix
// seconds of that boundary, used as the rate_caps document suffix so all calls
// inside one window share a counter.
func windowStartUnix(t time.Time, window time.Duration) int64 {
	if window <= 0 {
		return t.Unix()
	}
	w := int64(window / time.Second)
	if w <= 0 {
		return t.Unix()
	}
	return (t.Unix() / w) * w
}

// rateCapID is the rate_caps document id: deviceID:windowStart.
func rateCapID(deviceID string, windowStart int64) string {
	return fmt.Sprintf("%s:%d", deviceID, windowStart)
}

// IncrementRate atomically bumps the per-device counter for the current window
// and returns the new count. The atomic increment (firestore.Increment in the
// live adapter) makes the counter correct under concurrent Cloud Run instances.
//
// The caller compares the returned count against its cap: count > limit means
// the device has exceeded its quota for this window.
func (s *FirestoreStore) IncrementRate(ctx context.Context, deviceID string, window time.Duration) (int64, error) {
	ws := windowStartUnix(s.now(), window)
	id := rateCapID(deviceID, ws)
	var count int64
	err := s.docs.Transact(ctx, func(tx docTransaction) error {
		count = 0
		var canonical int64
		ids := identityAliases(deviceID)
		for i := range ids {
			ids[i] = rateCapID(ids[i], ws)
		}
		all, err := tx.GetAll(collRateCaps, ids)
		if err != nil {
			return err
		}
		for alias, fields := range all {
			n, ok := fields[fieldCount].(int64)
			if !ok || n < 0 || n >= int64(^uint64(0)>>1)-count {
				return errors.New("invalid legacy rate count")
			}
			count += n
			if alias == id {
				canonical = n
			}
		}
		count++
		return tx.Set(collRateCaps, id, map[string]any{fieldCount: canonical + 1})
	})
	if err != nil {
		return 0, fmt.Errorf("firestore increment rate %q: %w", id, err)
	}
	return count, nil
}

// AllowRate is a convenience over IncrementRate: it increments and reports
// whether the device is still within limit for the current window.
func (s *FirestoreStore) AllowRate(ctx context.Context, deviceID string, window time.Duration, limit int64) (allowed bool, count int64, err error) {
	count, err = s.IncrementRate(ctx, deviceID, window)
	if err != nil {
		return false, 0, err
	}
	return count <= limit, count, nil
}

// ---- field decoding ----------------------------------------------------------

// bytesField extracts a []byte field. Firestore decodes byte fields to []byte,
// but a hand-built fake (or a JSON round-trip) may surface a string; accept both.
func bytesField(fields map[string]any, key string) ([]byte, error) {
	v, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("missing field %q", key)
	}
	switch b := v.(type) {
	case []byte:
		return b, nil
	case string:
		return []byte(b), nil
	default:
		return nil, fmt.Errorf("field %q has type %T, want bytes", key, v)
	}
}

// uint32Field extracts an unsigned-32 field. Firestore integers decode to int64;
// accept the common numeric shapes and reject out-of-range values.
func uint32Field(fields map[string]any, key string) (uint32, error) {
	v, ok := fields[key]
	if !ok {
		return 0, fmt.Errorf("missing field %q", key)
	}
	var n int64
	switch x := v.(type) {
	case int64:
		n = x
	case int:
		n = int64(x)
	case uint32:
		return x, nil
	case float64:
		n = int64(x)
	default:
		return 0, fmt.Errorf("field %q has type %T, want integer", key, v)
	}
	if n < 0 || n > int64(^uint32(0)) {
		return 0, fmt.Errorf("field %q value %d out of uint32 range", key, n)
	}
	return uint32(n), nil
}

func (s *FirestoreStore) CreateKey(ctx context.Context, keyID string, pubSPKI []byte, signCount uint32) error {
	// The caller has just verified Apple's certificate and key hash. Reconcile
	// only equivalent header-safe encodings with that identical certified SPKI;
	// preserve old records and their largest counter in one transaction.
	var existing bool
	err := s.docs.Transact(ctx, func(tx docTransaction) error {
		existing = false
		maximum := signCount
		all, err := tx.GetAll(collAttestKeys, keyAliases(keyID))
		if err != nil {
			return err
		}
		for alias, fields := range all {
			if alias == keyID {
				existing = true
			}
			old, err := bytesField(fields, fieldPubSPKI)
			if err != nil {
				return err
			}
			if !bytes.Equal(old, pubSPKI) {
				return &attest.Error{Code: "ALREADY", Msg: "legacy public key conflict"}
			}
			count, err := uint32Field(fields, fieldSignCount)
			if err != nil {
				return err
			}
			if count > maximum {
				maximum = count
			}
		}
		return tx.Set(collAttestKeys, keyID, map[string]any{fieldPubSPKI: pubSPKI, fieldSignCount: int64(maximum)})
	})
	if err != nil {
		return fmt.Errorf("firestore reconcile certified key: %w", err)
	}
	if existing {
		return attest.ErrAlreadyExists
	}
	return nil
}
