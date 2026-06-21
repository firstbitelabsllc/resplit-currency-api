package firestore

import (
	"context"
	"fmt"

	gfs "cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// NewFirestoreStore is the production constructor cmd/ocr calls. It opens a
// Firestore client for projectID (Application Default Credentials + the (default)
// database, both resolved from the Cloud Run metadata server) and returns a
// FirestoreStore backed by the real collections.
//
// The returned store holds the *firestore.Client for the lifetime of the
// process; Cloud Run tears the instance down on scale-to-zero, so no explicit
// Close is wired. A failure here is surfaced to the caller, which falls back to
// the in-memory store with a warning (see cmd/ocr/main.go) — telemetry and the
// scan path keep working; only cross-instance attest replay durability is lost.
func NewFirestoreStore(ctx context.Context, projectID string) (*FirestoreStore, error) {
	cli, err := gfs.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("firestore: new client for %q: %w", projectID, err)
	}
	return NewStore(&clientDocStore{cli: cli}), nil
}

// clientDocStore adapts a *firestore.Client onto the docStore seam that
// FirestoreStore depends on. Each method targets a single document by
// (collection, id) and maps Firestore's gRPC status codes onto the package's
// ErrNotFound / ErrAlreadyExists sentinels so the store logic stays
// backend-agnostic.
type clientDocStore struct {
	cli *gfs.Client
}

var _ docStore = (*clientDocStore)(nil)

// Get reads a document's fields, translating a Firestore NotFound into the
// package's ErrNotFound sentinel.
func (a *clientDocStore) Get(ctx context.Context, coll, id string) (map[string]any, error) {
	snap, err := a.cli.Collection(coll).Doc(id).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return snap.Data(), nil
}

// Set overwrites (or creates) a document with the given fields.
func (a *clientDocStore) Set(ctx context.Context, coll, id string, fields map[string]any) error {
	_, err := a.cli.Collection(coll).Doc(id).Set(ctx, fields)
	return err
}

// Create writes a document only if it does not already exist, mapping
// Firestore's AlreadyExists into ErrAlreadyExists — the idempotency primitive
// ReserveOCR relies on.
func (a *clientDocStore) Create(ctx context.Context, coll, id string, fields map[string]any) error {
	_, err := a.cli.Collection(coll).Doc(id).Create(ctx, fields)
	if err != nil && status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

// Increment atomically adds delta to an integer field and returns the new value.
// It runs a Firestore transaction (read-modify-write) rather than the fire-and-
// forget firestore.Increment so the caller gets the post-increment count back —
// required by AllowRate to compare against a cap. Firestore retries the closure
// on contention, keeping the counter correct across concurrent Cloud Run
// instances.
func (a *clientDocStore) Increment(ctx context.Context, coll, id, field string, delta int64) (int64, error) {
	ref := a.cli.Collection(coll).Doc(id)
	var newVal int64
	err := a.cli.RunTransaction(ctx, func(_ context.Context, tx *gfs.Transaction) error {
		var cur int64
		snap, err := tx.Get(ref)
		if err != nil {
			if status.Code(err) != codes.NotFound {
				return err
			}
			// Absent document: counter starts at zero.
		} else if v, derr := snap.DataAt(field); derr == nil {
			switch n := v.(type) {
			case int64:
				cur = n
			case int:
				cur = int64(n)
			case float64:
				cur = int64(n)
			}
		}
		newVal = cur + delta
		return tx.Set(ref, map[string]any{field: newVal}, gfs.MergeAll)
	})
	if err != nil {
		return 0, fmt.Errorf("firestore increment %s/%s.%s: %w", coll, id, field, err)
	}
	return newVal, nil
}
