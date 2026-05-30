package attest

import (
	"context"
	"strconv"
	"sync"
)

// MemStore is an in-memory Store used to keep the OCR service buildable and
// runnable (e.g. /healthz) before Firestore is wired in. It implements the
// free-function Store interface: keyID -> (SPKI public key, signCount).
//
// TODO(gcp): replace with a *firestore.Client-backed Store reading/writing the
// attest_keys collection (keyId document id, fields publicKey + signCount).
type MemStore struct {
	mu      sync.RWMutex
	records map[string]memRecord
}

type memRecord struct {
	spki      []byte
	signCount uint32
}

// NewMemStore returns an empty in-memory Store.
func NewMemStore() *MemStore {
	return &MemStore{records: make(map[string]memRecord)}
}

// GetKey returns the stored SPKI public key and signCount, or ErrUnknownKey.
func (m *MemStore) GetKey(_ context.Context, keyID string) ([]byte, uint32, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.records[keyID]
	if !ok {
		return nil, 0, ErrUnknownKey
	}
	return r.spki, r.signCount, nil
}

// PutKey persists (or replaces) a key with the given SPKI and signCount.
func (m *MemStore) PutKey(_ context.Context, keyID string, pubSPKI []byte, signCount uint32) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records[keyID] = memRecord{spki: pubSPKI, signCount: signCount}
	return nil
}

// StubOCRProvider is a placeholder OCR backend that echoes a fixed shape so the
// service builds and the scan route is wired end to end.
//
// TODO(gcp): replace with an Azure Document Intelligence client. This service is
// the only secret-holder for the Azure DI key (Secret Manager); enforce the
// budget kill-switch before invoking the provider.
type StubOCRProvider struct{}

// NewStubOCRProvider returns a no-op OCR provider.
func NewStubOCRProvider() *StubOCRProvider { return &StubOCRProvider{} }

// Scan returns a placeholder result describing the byte count received.
func (StubOCRProvider) Scan(_ context.Context, image []byte) ([]byte, error) {
	// TODO(gcp): POST image to Azure DI prebuilt-receipt and return the analysis.
	return []byte(`{"provider":"stub","status":"not_implemented","bytes":` +
		strconv.Itoa(len(image)) + `}`), nil
}
