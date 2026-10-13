package firestore

import (
	"context"
	"fmt"
	"strings"

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
// Close is wired. A failure here is surfaced to the caller. cmd/ocr fails closed
// when GCP_PROJECT_ID is set: a MemStore fallback would silently disable
// cross-instance App Attest replay durability and the spend gate.
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

type clientTransaction struct {
	a  *clientDocStore
	tx *gfs.Transaction
}

func (a *clientDocStore) Transact(ctx context.Context, fn func(docTransaction) error) error {
	return a.cli.RunTransaction(ctx, func(_ context.Context, tx *gfs.Transaction) error { return fn(&clientTransaction{a, tx}) })
}

func (t *clientTransaction) GetAll(coll string, ids []string) (map[string]map[string]any, error) {
	refs := make([]*gfs.DocumentRef, len(ids))
	for i, id := range ids {
		refs[i] = t.a.document(coll, id)
	}
	snaps, err := t.tx.GetAll(refs)
	if err != nil {
		return nil, err
	}
	all := map[string]map[string]any{}
	for i, snap := range snaps {
		if snap.Exists() {
			all[ids[i]] = snap.Data()
		}
	}
	return all, nil
}
func (t *clientTransaction) Set(coll, id string, fields map[string]any) error {
	return t.tx.Set(t.a.document(coll, id), fields, gfs.MergeAll)
}
func (t *clientTransaction) Create(coll, id string, fields map[string]any) error {
	return t.tx.Create(t.a.document(coll, id), fields)
}

// document preserves existing valid SDK paths and escapes slash characters only
// when the old path could never address a Firestore document. Standard base64
// App Attest identities contain '/', including in accounting IDs. Blind Doc(id)
// fails for an even number of path segments or an empty segment. Existing valid
// nested paths must keep their stored replay counters; this is not a migration.
// Canonical base64 identities contain no percent characters, so escaped invalid
// identities cannot collide with the existing canonical identity namespace.
func (a *clientDocStore) document(coll, id string) *gfs.DocumentRef {
	parts := strings.Split(id, "/")
	valid := len(parts)%2 == 1
	for _, part := range parts {
		if part == "" {
			valid = false
		}
	}
	if !valid {
		id = strings.ReplaceAll(id, "/", "%2F")
	}
	return a.cli.Collection(coll).Doc(id)
}

// Get reads a document's fields, translating a Firestore NotFound into the
// package's ErrNotFound sentinel.
func (a *clientDocStore) Get(ctx context.Context, coll, id string) (map[string]any, error) {
	snap, err := a.document(coll, id).Get(ctx)
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
	_, err := a.document(coll, id).Set(ctx, fields)
	return err
}

// Create writes a document only if it does not already exist, mapping
// Firestore's AlreadyExists into ErrAlreadyExists — the idempotency primitive
// ReserveOCR relies on.
func (a *clientDocStore) Create(ctx context.Context, coll, id string, fields map[string]any) error {
	_, err := a.document(coll, id).Create(ctx, fields)
	if err != nil && status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

// Delete removes a document, mapping Firestore NotFound onto ErrNotFound.
func (a *clientDocStore) Delete(ctx context.Context, coll, id string) error {
	_, err := a.document(coll, id).Delete(ctx)
	if err != nil && status.Code(err) == codes.NotFound {
		return ErrNotFound
	}
	return err
}
