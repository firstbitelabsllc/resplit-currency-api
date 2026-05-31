package main

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// newPhotoID returns a server-assigned, collision-resistant photo id within the
// safe id charset enforced by sideload.ObjectKey. The leading timestamp keeps
// objects roughly sortable by upload time; the random suffix guarantees
// uniqueness. Falls back to a pure-timestamp id if crypto/rand is unavailable
// (never expected on Cloud Run).
func newPhotoID() string {
	ts := time.Now().UTC().Format("20060102T150405")
	var b [10]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ts
	}
	return ts + "-" + hex.EncodeToString(b[:])
}
