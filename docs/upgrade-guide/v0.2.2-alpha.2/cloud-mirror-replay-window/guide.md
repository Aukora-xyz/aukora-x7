---
kind: upgrade-guide
description: "Cloud mirror retries use a bounded acknowledgment window instead of permanent acknowledgment retention."
---
# Bounded cloud mirror replay window

English | [中文](guide.zh.md)

## Change

MirrorDO previously retained permanent protocol acknowledgments and stopped at 4,096 receipts. Its source publication path now integrates bounded retention. This is not evidence of production activation.

The window retains up to the newest 64 acknowledgments per client and 4,096 globally, protecting each client's newest acknowledgment; global pressure may trim a client's window below 64. A retry whose acknowledgment was pruned returns HTTP 409 `MIRROR_REPLAY_EXPIRED` and attempts to retain a conflict. Full conflict storage instead returns HTTP 507 `MIRROR_CONFLICT_CAPACITY_EXCEEDED` with `conflictCode: MIRROR_REPLAY_EXPIRED`. Neither outcome reapplies the batch or acknowledges successful delivery.

The integration preserves permanent client sequence/digest fences, global lineage/revision, content, tombstones, bootstrap state and user memory receipt journals. The 256-client cap and content/conflict limits remain unchanged. Valid fenced inventories of at most 4,096 acknowledgments reduce on the next successful publication. Malformed, incomplete or unfenced inventories must fail closed and require explicit audited recovery, not a guessed migration.

## Migration

1. Callers of `/_mirror/delta` must handle HTTP 409 `MIRROR_REPLAY_EXPIRED` and its HTTP 507 conflict-capacity fallback as unresolved delivery. Preserve pending local output and inspect the conflict and current cloud snapshot before manual resolution; do not blindly restamp, rebase or resend an old batch.
2. Retain existing client sequence/digest fences and global lineage/revision. Do not delete storage records to bypass validation or reset delivery history. There is no standalone migration command; publication applies pruning atomically with successful publication writes.
3. Before activation, verify that retained retries return original acknowledgments, expired retries never reapply batches, and unresolved delivery stays visible in the browser. Production verification requires separate deployment and access authorization.
