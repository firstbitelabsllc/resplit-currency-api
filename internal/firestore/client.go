package firestore

import (
	"context"
	"errors"
)

// ErrClientNotWired is returned by NewFirestoreStore until the live
// *firestore.Client adapter below is implemented. It keeps the package buildable
// and go-vet clean without pulling the heavy cloud.google.com/go/firestore tree
// into the unit-test build, while still giving cmd/ocr a single real entry point
// to call once credentials + the SDK dependency are added.
var ErrClientNotWired = errors.New("firestore: live client adapter not wired (TODO(gcp))")

// NewFirestoreStore is the production constructor cmd/ocr will call. It opens a
// Firestore client for projectID and returns a FirestoreStore backed by the
// real collections.
//
// TODO(gcp): implement against cloud.google.com/go/firestore. Sketch:
//
//	import gfs "cloud.google.com/go/firestore"
//
//	cli, err := gfs.NewClient(ctx, projectID)
//	if err != nil { return nil, err }
//	return NewStore(&clientDocStore{cli: cli}), nil
//
// The clientDocStore adapter (below, as a doc comment so this file needs no SDK
// import) maps the docStore methods onto Firestore operations:
//
//	Get:       cli.Collection(coll).Doc(id).Get(ctx) → snap.Data(); status.Code==NotFound → ErrNotFound
//	Set:       cli.Collection(coll).Doc(id).Set(ctx, fields)
//	Create:    cli.Collection(coll).Doc(id).Create(ctx, fields); AlreadyExists → ErrAlreadyExists
//	Increment: cli.Collection(coll).Doc(id).Set(ctx,
//	             map[string]any{field: gfs.Increment(delta)}, gfs.MergeAll)
//	           then re-Get to read back the new count (or run it in a transaction).
//
// Until that lands, the constructor signals the gap explicitly rather than
// returning a half-working store.
func NewFirestoreStore(ctx context.Context, projectID string) (*FirestoreStore, error) {
	_ = ctx
	_ = projectID
	return nil, ErrClientNotWired
}
