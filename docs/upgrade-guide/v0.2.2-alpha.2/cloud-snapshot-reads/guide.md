---
kind: upgrade-guide
description: "Cloud snapshot consumers must handle bounded, revision-checked response streams and stricter status request validation."
---
# Revision-checked cloud snapshot reads

English | [中文](guide.zh.md)

## Change

Cloud snapshot responses no longer hold the mutation queue until streaming finishes. Each successful complete snapshot contains one captured lineage and revision. Concurrent mutation can terminate the body with `MIRROR_SNAPSHOT_CHANGED` after HTTP 200; callers may observe a stream or JSON parsing failure rather than an HTTP error response. No historical revision is retained for retry.

Each MirrorDO instance admits at most two active snapshot streams, each with a 60-second total deadline. Additional full reads return HTTP 503 `MIRROR_SNAPSHOT_BUSY`; compact status and unchanged conditional requests remain available. A cancelled or timed-out stream retains its slot until any pending storage read settles. Conflict downloads retain their serialized behavior.

`/_mirror/status` accepts only bodyless GET with no query or exactly `?compact=1`. Other methods return HTTP 405; unsupported or duplicate queries, fragments and nonzero body lengths return HTTP 400. Full status retains its existing fields. Compact status and bodyless HTTP 304 snapshot responses report revision metadata, not content validation.

## Migration

1. For lightweight polling, request authenticated `GET /_mirror/status?compact=1` after bootstrap. Read `lineageId`, `revision`, `snapshotFormat` and `snapshotETag`; compact status does not include file lists or counts. See [cloud mirror transport](../../../../deploy/cloudflare/README.md).
2. Fetch `/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2`. Use the returned strong `ETag` in `If-None-Match` only when retaining its complete validated snapshot; HTTP 304 has no body. Use `If-Match` to require a known revision; a stale or weak validator returns HTTP 412 `MIRROR_SNAPSHOT_PRECONDITION_FAILED`. Existing resets still require the v2 format, including on conditional reads.
3. Keep byte limits and cancellation active through the entire response body. Apply no partial snapshot. On truncation, timeout, cancellation, HTTP 412 or `MIRROR_SNAPSHOT_BUSY`, preserve local pending work and retry a fresh whole snapshot within a bounded retry policy. Persistent writes can prevent completion.
4. Before activation, verify complete-body validation, unchanged HTTP 304 handling, stale-validator rejection and concurrent-write cancellation with isolated fixtures. Source changes do not establish deployment or live verification.
