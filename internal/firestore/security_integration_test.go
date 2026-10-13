//go:build integration

package firestore

import (
	"bytes"
	"context"
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

	"github.com/firstbitelabsllc/resplit-currency-api/internal/attest"
)

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
