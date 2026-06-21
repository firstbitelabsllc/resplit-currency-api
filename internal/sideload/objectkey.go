package sideload

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// objectPrefix is the per-device namespace root. Each device's photos live under
// users/<sha256(keyId)>/photos/ so one compromised/leaked signed URL can never
// name another device's objects (the keyId hash is unforgeable without the
// attested key, and the assertion gate proves possession of that key).
const objectPrefix = "users"

// photosSegment is the collection segment under each device namespace.
const photosSegment = "photos"

// DeviceNamespace returns sha256(keyId) hex — the per-device path component.
// Hashing (rather than using the raw keyId) keeps Apple key identifiers out of
// object names and gives a fixed-length, filesystem-safe segment.
func DeviceNamespace(keyID string) string {
	sum := sha256.Sum256([]byte(keyID))
	return hex.EncodeToString(sum[:])
}

// ObjectKey builds the GCS object path for a device's photo id:
//
//	users/<sha256(keyId)>/photos/<photoID>
//
// photoID is validated to a conservative id charset so it cannot inject extra
// path segments (no '/'), escape the namespace ("..") or smuggle control bytes
// into the signed canonical URI.
func ObjectKey(keyID, photoID string) (string, error) {
	if keyID == "" {
		return "", errors.New("sideload: empty key id")
	}
	if err := validatePhotoID(photoID); err != nil {
		return "", err
	}
	return strings.Join([]string{objectPrefix, DeviceNamespace(keyID), photosSegment, photoID}, "/"), nil
}

// maxPhotoIDLen bounds the id to keep object paths well under GCS's 1024-byte
// object-name limit after the namespace prefix.
const maxPhotoIDLen = 128

// validatePhotoID enforces a safe id charset: A-Z a-z 0-9 and - _ . (no slash,
// no dot-dot traversal, no leading dot). This keeps the id a single path
// segment and blocks namespace escape.
func validatePhotoID(id string) error {
	if id == "" {
		return errors.New("sideload: empty photo id")
	}
	if len(id) > maxPhotoIDLen {
		return errors.New("sideload: photo id too long")
	}
	if id == "." || id == ".." || strings.Contains(id, "..") {
		return errors.New("sideload: photo id path traversal")
	}
	if strings.HasPrefix(id, ".") {
		return errors.New("sideload: photo id may not start with '.'")
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'A' && c <= 'Z',
			c >= 'a' && c <= 'z',
			c >= '0' && c <= '9',
			c == '-' || c == '_' || c == '.':
		default:
			return errors.New("sideload: photo id has invalid character")
		}
	}
	return nil
}
