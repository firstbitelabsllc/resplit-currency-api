package main

import (
	"testing"
	"time"
)

func TestSnapshotAge(t *testing.T) {
	now := time.Date(2026, time.August, 2, 12, 0, 0, 0, time.UTC)

	age, err := snapshotAge("2026-08-01", now)
	if err != nil {
		t.Fatalf("snapshotAge returned error: %v", err)
	}
	if want := 36 * time.Hour; age != want {
		t.Fatalf("snapshotAge = %s, want %s", age, want)
	}

	age, err = snapshotAge("2026-08-03", now)
	if err != nil {
		t.Fatalf("future snapshotAge returned error: %v", err)
	}
	if age != 0 {
		t.Fatalf("future snapshotAge = %s, want 0", age)
	}
}

func TestSnapshotAgeRejectsUnparseableDate(t *testing.T) {
	_, err := snapshotAge("not-a-date", time.Now())
	if err == nil {
		t.Fatal("snapshotAge accepted an unparseable date")
	}
}
