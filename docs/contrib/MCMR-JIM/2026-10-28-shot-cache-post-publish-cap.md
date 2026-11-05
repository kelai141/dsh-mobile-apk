# Enforce screenshot cache bounds after publishing

## Finding

The screenshot cache was pruned before creating the new PNG. A directory at its file-count limit therefore exceeded that limit immediately after every successful capture, and byte usage could likewise remain above the configured cap.

## Change

Prune after writing while protecting the capture being returned. If a single capture exceeds the total-byte limit, delete it and return a cache-limit failure instead of returning a path to an over-limit artifact.

## Verification

- Focused `ShotCachePolicyTest` coverage checks post-publish count and byte limits, retains the current capture, and rejects an oversized capture.
- No device verification; this is a bounded private-file retention policy change.
