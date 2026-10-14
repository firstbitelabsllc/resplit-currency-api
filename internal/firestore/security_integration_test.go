//go:build integration

package firestore

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gfs "cloud.google.com/go/firestore"
	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

func TestEmulatorCertifiedAliasHistoryPreservation(t *testing.T) {
	if !strings.HasPrefix(os.Getenv("FIRESTORE_EMULATOR_HOST"), "127.0.0.1:") {
		t.Fatal("loopback emulator required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub, _ := key.PublicKey.ECDH()
	hash := sha256.Sum256(pub.Bytes())
	id := base64.StdEncoding.EncodeToString(hash[:])
	spki, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	aliases, err := attest.KeyIDAliases(id)
	if err != nil {
		t.Fatal(err)
	}
	alias1, alias2 := aliases[1], aliases[2] // unpadded and nonzero trailing pad bits
	cli := a.docs.(*clientDocStore)
	for alias, count := range map[string]int64{alias1: 17, alias2: 23} {
		if _, err := cli.document(collAttestKeys, alias).Set(ctx, map[string]any{fieldPubSPKI: spki, fieldSignCount: count}); err != nil {
			t.Fatal(err)
		}
	}
	ws := windowStartUnix(time.Now(), time.Hour)
	for alias, count := range map[string]int64{alias1: 5, alias2: 7} {
		if _, err := cli.document(collRateCaps, rateCapID("attest:"+alias, ws)).Set(ctx, map[string]any{fieldCount: count}); err != nil {
			t.Fatal(err)
		}
	}
	identity := "attest:" + id
	if _, err := cli.document(collOCRIdempotency, idempotencyID("attest:"+alias1, "old-receipt")).Set(ctx, map[string]any{fieldCreatedAt: time.Now(), fieldExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	// The production caller supplies SPKI only after current certificate/key binding.
	if err := a.CreateKey(ctx, id, spki, 0); err != nil {
		t.Fatal(err)
	}
	if _, count, err := b.GetKey(ctx, id); err != nil || count != 23 {
		t.Fatalf("canonical counter=%d/%v", count, err)
	}
	if err := b.AdvanceSignCount(ctx, id, 23); err == nil {
		t.Fatal("legacy counter replay accepted")
	}
	var wins atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := b.CreateKey(ctx, id, spki, 0); err != nil && !errors.Is(err, attest.ErrAlreadyExists) {
				errs <- err
			}
		}()
		go func() {
			defer wg.Done()
			err := a.AdvanceSignCount(ctx, id, 24)
			if err == nil {
				wins.Add(1)
			} else {
				var e *attest.Error
				if !errors.As(err, &e) || e.Code != "REPLAY" {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if wins.Load() != 1 {
		t.Fatalf("atomic advance winners=%d", wins.Load())
	}
	if _, count, err := b.GetKey(ctx, id); err != nil || count != 24 {
		t.Fatalf("re-registration reset=%d/%v", count, err)
	}
	if fresh, err := b.ReserveOCR(ctx, identity, "old-receipt", time.Hour); err != nil || fresh {
		t.Fatalf("legacy billed again=%v/%v", fresh, err)
	}
	if exists, err := b.HasOCRReservation(ctx, identity, "old-receipt"); err != nil || !exists {
		t.Fatalf("legacy recovery reservation=%v/%v", exists, err)
	}
	if allowed, count, err := b.AllowRate(ctx, identity, time.Hour, 12); err != nil || allowed || count != 13 {
		t.Fatalf("alias rate reset=%v/%d/%v", allowed, count, err)
	}
	if _, count, err := a.AllowRate(ctx, identity, time.Hour, 100); err != nil || count != 14 {
		t.Fatalf("rate double copied=%d/%v", count, err)
	}
	// A trusted old spelling advancing later is still part of the atomic floor.
	if _, err := cli.document(collAttestKeys, alias2).Set(ctx, map[string]any{fieldSignCount: int64(31)}, gfs.MergeAll); err != nil {
		t.Fatal(err)
	}
	if err := a.AdvanceSignCount(ctx, id, 30); err == nil {
		t.Fatal("later legacy advance was ignored")
	}
	if err := a.AdvanceSignCount(ctx, id, 32); err != nil {
		t.Fatal(err)
	}
	// Original rows remain byte/state authoritative; no deletion or namespace migration.
	for alias, count := range map[string]uint32{alias1: 17, alias2: 31} {
		if _, got, err := b.GetKey(ctx, alias); err != nil || got != count {
			t.Errorf("old alias=%d want%d err%v", got, count, err)
		}
	}
	wins.Store(0)
	wg = sync.WaitGroup{}
	errs = make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fresh, err := a.ReserveOCR(ctx, identity, "new-receipt", time.Hour)
			if err != nil {
				errs <- err
			} else if fresh {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if wins.Load() != 1 {
		t.Fatalf("reservation winners=%d", wins.Load())
	}
	// A conflicting legacy SPKI makes the entire certified-registration transaction
	// refuse; it cannot create a fresh canonical counter over untrusted history.
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	otherPub, _ := other.PublicKey.ECDH()
	otherHash := sha256.Sum256(otherPub.Bytes())
	otherID := base64.StdEncoding.EncodeToString(otherHash[:])
	otherSPKI, _ := x509.MarshalPKIXPublicKey(&other.PublicKey)
	otherAliases, _ := attest.KeyIDAliases(otherID)
	if _, err := cli.document(collAttestKeys, otherAliases[1]).Set(ctx, map[string]any{fieldPubSPKI: spki, fieldSignCount: int64(29)}); err != nil {
		t.Fatal(err)
	}
	if err := b.CreateKey(ctx, otherID, otherSPKI, 0); err == nil {
		t.Fatal("conflicting key provenance merged")
	}
	if _, _, err := b.GetKey(ctx, otherID); !errors.Is(err, attest.ErrUnknownKey) {
		t.Fatal("conflict minted canonical row")
	}
}

func TestEmulatorOCROperationReservationContinuity(t *testing.T) {
	if !strings.HasPrefix(os.Getenv("FIRESTORE_EMULATOR_HOST"), "127.0.0.1:") {
		t.Fatal("loopback emulator required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	defer a.docs.(*clientDocStore).cli.Close()
	defer b.docs.(*clientDocStore).cli.Close()
	now := time.Now().Truncate(time.Microsecond)
	raw := bytes.Repeat([]byte{255}, 32)
	binary.BigEndian.PutUint64(raw[24:], uint64(now.UnixNano()))
	flatID := "attest:" + base64.StdEncoding.EncodeToString(raw)
	nestedID := "attest:legacy/" + strconv.FormatInt(now.UnixNano(), 10) + "/key"
	for _, identity := range []string{flatID, nestedID} {
		ref := a.docs.(*clientDocStore).document(collOCRIdempotency, idempotencyID(identity, "accepted-image"))
		expires := now.Add(time.Hour)
		if _, err := ref.Set(ctx, map[string]any{fieldCreatedAt: now, fieldExpiresAt: expires}); err != nil {
			t.Fatal(err)
		}
		if op, err := b.GetOCROperation(ctx, identity, "accepted-image"); err != nil || op != "" {
			t.Fatalf("old reservation invented recovery=%q/%v", op, err)
		}
		if fresh, err := b.ReserveOCR(ctx, identity, "accepted-image", time.Hour); err != nil || fresh {
			t.Fatalf("old reservation rebilled=%v/%v", fresh, err)
		}
		if err := a.RecordOCROperation(ctx, identity, "accepted-image", "known-local-accepted-operation"); err != nil {
			t.Fatal(err)
		}
		if op, err := b.GetOCROperation(ctx, identity, "accepted-image"); err != nil || op != "known-local-accepted-operation" {
			t.Fatalf("separate SDK reference=%q/%v", op, err)
		}
		snap, err := ref.Get(ctx)
		if err != nil || !snap.Data()[fieldExpiresAt].(time.Time).Equal(expires) || !snap.Data()[fieldCreatedAt].(time.Time).Equal(now) {
			t.Fatalf("existing path/expiry changed: %v", err)
		}
		if err := b.RecordOCROperation(ctx, identity, "accepted-image", "conflicting-operation"); !errors.Is(err, ErrOCRRecovery) {
			t.Fatalf("conflicting operation accepted=%v", err)
		}
		b.now = func() time.Time { return expires.Add(time.Second) }
		if _, err := b.GetOCROperation(ctx, identity, "accepted-image"); !errors.Is(err, ErrOCRRecovery) {
			t.Fatalf("expired operation recovered=%v", err)
		}
		if fresh, err := b.ReserveOCR(ctx, identity, "accepted-image", time.Hour); err != nil || fresh {
			t.Fatalf("expired document rebilled=%v/%v", fresh, err)
		}
		b.now = time.Now
	}
	t.Log("separate real SDK clients preserve flat/nested reservations, old no-reference fence, accepted reference, original expiry, conflict refusal and no-resubmit after expiry")
}

func TestEmulatorSecurityPersistence(t *testing.T) {
	if !strings.HasPrefix(os.Getenv("FIRESTORE_EMULATOR_HOST"), "127.0.0.1:") {
		t.Fatal("explicit loopback emulator required; never production")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	a, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewFirestoreStore(ctx, "resplit-security-local")
	if err != nil {
		t.Fatal(err)
	}
	// A standard base64 key can contain slash characters. The real SDK must
	// address it as one document, including all related accounting documents.
	raw := bytes.Repeat([]byte{255}, 32)
	binary.BigEndian.PutUint64(raw[24:], uint64(time.Now().UnixNano()))
	id := base64.StdEncoding.EncodeToString(raw)
	if err := a.CreateKey(ctx, id, []byte("spki"), 0); err != nil {
		t.Fatalf("canonical key create: %v", err)
	}
	var wins atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := a
			if i%2 == 1 {
				s = b
			}
			err := s.AdvanceSignCount(ctx, id, 9)
			if err == nil {
				wins.Add(1)
			} else {
				var e *attest.Error
				if !errors.As(err, &e) || e.Code != "REPLAY" {
					errs <- err
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if wins.Load() != 1 {
		t.Fatalf("advance winners=%d, want1", wins.Load())
	}
	if err := b.CreateKey(ctx, id, []byte("spki"), 0); !errors.Is(err, attest.ErrAlreadyExists) {
		t.Fatalf("create-only retry=%v", err)
	}
	if _, count, err := b.GetKey(ctx, id); err != nil || count != 9 {
		t.Fatalf("persisted counter=%d err=%v", count, err)
	}
	// A historically valid nested SDK path retains its original data/counter.
	legacy := "legacy/" + strconv.FormatInt(time.Now().UnixNano(), 10) + "/key"
	legacy = strings.ReplaceAll(legacy, "=", "x")
	_, err = a.docs.(*clientDocStore).cli.Collection(collAttestKeys).Doc(legacy).Set(ctx, map[string]any{fieldPubSPKI: []byte("legacy"), fieldSignCount: int64(17)})
	if err != nil {
		t.Fatal(err)
	}
	if _, count, err := b.GetKey(ctx, legacy); err != nil || count != 17 {
		t.Fatalf("legacy counter=%d err=%v", count, err)
	}
	// Accounting also existed in nested SDK paths before this repair. Preserve
	// both durable spend reservations and rate counts rather than mint a second
	// flat namespace that could bill again or reset the daily cap.
	legacyIdentity := "attest:legacy/" + strconv.FormatInt(time.Now().UnixNano(), 10) + "/key"
	legacyReservation := a.docs.(*clientDocStore).cli.Collection(collOCRIdempotency).Doc(idempotencyID(legacyIdentity, "old-hash"))
	_, err = legacyReservation.Set(ctx, map[string]any{fieldCreatedAt: time.Now(), fieldExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if fresh, err := b.ReserveOCR(ctx, legacyIdentity, "old-hash", time.Hour); err != nil || fresh {
		t.Fatalf("legacy spend reservation lost: %v/%v", fresh, err)
	}
	legacyRate := a.docs.(*clientDocStore).cli.Collection(collRateCaps).Doc(rateCapID(legacyIdentity, windowStartUnix(time.Now(), time.Hour)))
	_, err = legacyRate.Set(ctx, map[string]any{fieldCount: int64(17)})
	if err != nil {
		t.Fatal(err)
	}
	if allowed, count, err := b.AllowRate(ctx, legacyIdentity, time.Hour, 17); err != nil || allowed || count != 18 {
		t.Fatalf("legacy daily cap reset: %v/%d/%v", allowed, count, err)
	}
	if strings.Contains(a.docs.(*clientDocStore).document(collOCRIdempotency, idempotencyID("attest:"+id, "new-hash")).ID, "/") {
		t.Fatal("invalid base64 accounting ID was not escaped")
	}

	identity := "attest:" + id
	fresh, err := a.ReserveOCR(ctx, identity, "receipt-hash", time.Hour)
	if err != nil || !fresh {
		t.Fatalf("reserve=%v/%v", fresh, err)
	}
	fresh, err = b.ReserveOCR(ctx, identity, "receipt-hash", time.Hour)
	if err != nil || fresh {
		t.Fatalf("duplicate=%v/%v", fresh, err)
	}
	if err := a.ReleaseOCR(ctx, identity, "receipt-hash"); err != nil {
		t.Fatal(err)
	}
	fresh, err = b.ReserveOCR(ctx, identity, "receipt-hash", time.Hour)
	if err != nil || !fresh {
		t.Fatalf("released reserve=%v/%v", fresh, err)
	}
	for i := int64(1); i <= 3; i++ {
		allow, count, err := a.AllowRate(ctx, identity, time.Hour, 2)
		if err != nil || count != i || allow != (i <= 2) {
			t.Fatalf("rate=%v/%d/%v at%d", allow, count, err, i)
		}
	}
}
