# ADR 0002 — Snapshot-archive git growth: defer

- **Status:** Accepted (defer)
- **Date:** 2026-07-03

## Context

`snapshot-archive/` is an append-only, in-repo history: one immutable
`YYYY-MM-DD.json` per publish, committed daily by `run.yml` ("Commit snapshot
archive"). It is the source the pipeline rebuilds history/archive artifacts from.

Because every day adds one committed file forever, the directory grows without
bound and inflates clone/CI checkout size over the long run.

## Measurement (2026-07-03)

- **363 files**, `2025-07-04` → `2026-07-03` (≈ 1 year).
- **~2.3 MB** on disk, **~2.7 KB/file**.
- Growth ≈ **2.7 KB/day ≈ ~1 MB/year** (plus git history overhead).

## Decision

**Defer.** At ~1 MB/year this is not worth engineering time now. Committing the
history in-repo keeps the rebuild deterministic and reviewable, which is worth
more than the trivial size cost at this scale.

## Revisit trigger

Reconsider only if any of these becomes true:

- the directory exceeds **~50 MB**, or
- clone/CI checkout time becomes a felt pain, or
- retention/compaction is wanted for another reason.

## Options for later (not chosen now)

1. Roll old dailies into the existing per-year archive payloads and drop the
   individual day files past a retention window (the pipeline already builds
   `archive-years/`).
2. Move the raw archive to object storage (R2) and keep only a manifest in git.
3. `git gc --aggressive` / shallow-clone CI if only checkout time hurts.

Prune logic already exists (`pruneSnapshotArchive` / `snapshotRetentionDays` in
`currscript.js`); a retention window is the cheapest lever if this ever trips.
