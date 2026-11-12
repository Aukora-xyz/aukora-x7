---
kind: upgrade-guide
description: "Cloud mirror paths containing an exact .conflict-backup segment are rejected instead of being synchronized."
---
# Keep conflict backups out of the cloud mirror

English | [中文](guide.zh.md)

## Change

Cloud mirror validation previously admitted `.conflict-backup` directories and their contents. It now rejects any path containing that exact segment. Bootstrap scanning excludes those directories before reading their contents. Similar names such as `.conflict-backup-old` are not excluded by this rule. Local recovery backup creation and local-host mirror transport remain unchanged.

Incoming bootstrap batches and deltas at excluded paths fail with `INVALID_MIRROR_PATH`. Existing cloud entries or reset records at these paths make unconditional snapshot and full status reads fail with HTTP 400 and the same code, rather than disappearing from snapshots. Compact status and bodyless HTTP 304 responses do not validate all stored paths. The change does not remove stored data, reconcile immutable queued batches, or repair historical named rollback recovery. Source behavior does not establish production activation.

## Migration

1. Before deployment, review whether existing cloud state, saved seed packages or pending cloud batches contain a `.conflict-backup` path segment. Verify that the browser's cloud outbox blocks excluded paths before transmission, including in already queued batches; server rejection alone does not prevent upload. Preserve local recovery backups, pending output and delivery evidence. Do not read or transmit private backup contents merely to check path eligibility.
2. If such state exists, stop deployment and obtain separate authorization for a reviewed reconciliation. Do not silently filter stored entries or resets, delete backups, rewrite an immutable batch or seed package, or reset client fences and lineage. No automatic migration is provided.
3. For a fresh bootstrap, prepare a new package through the [bootstrap driver](../../../../deploy/cloudflare/README.md); do not alter an already approved or partially uploaded package. Confirm the prepared entries exclude `.conflict-backup` and retain eligible neighboring paths. Transmission still requires approval for the exact package.
4. Before activation, verify that cloud admission rejects excluded paths, existing excluded records fail closed without mutation, and local recovery backups remain usable. Deployment and live access checks require separate authorization.
