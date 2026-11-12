---
kind: upgrade-guide
description: "Automatic wakes pause after three unacknowledged ticks and expose non-authoritative aura hints."
---
# Automatic wake pause and aura hints

English | [中文](guide.zh.md)

## Change

Local and Cloudflare wake schedules previously continued until explicitly disabled. They now pause after three automatic ticks without an explicit operator resume. Status exposes `consecutiveUnacknowledgedWakes` and `autoPaused`; a paused schedule has `enabled: false` and `nextWakeAt: null`. Manual ticks do not reset the count. Existing stores derive the count conservatively from retained automatic receipts and may therefore open paused.

Each tick records a head-bound `aura:latest` attention hint. Independently supplied healthy inputs can skip the probe with `probe_skipped_rest`; absent or invalid inputs produce a conservative `verify` hint. An urgent committed hint adds `wake.changed` alongside existing `wake:updated` notifications. Aura never grants authority or establishes runtime health.

## Migration

1. Keep existing wake stores. Do not delete receipts to resume a paused schedule. After inspecting status, use the existing authenticated wake configuration operation with `enabled: true` to reset the count and resume deliberately. `enabled: false` remains the kill switch.
2. Update status consumers to display `autoPaused` and the counter. Treat `wake.changed` as an attention notification, not permission to mutate state. Keep accepting `wake:updated`.
3. Local host integrators pass `readWake: () => localWake.status()` to `createLocalMessagesRequestHandler` in [server/local-host.mjs](../../../../server/local-host.mjs). Without that optional reader, the legacy status response remains unchanged. Both status aliases reject aura for a different selected head.
4. The local host supplies `readLocalAuraInputs` from bounded, coherent mirror reads and captured wake metadata. A missing, changing, oversized, corrupt, or unverified source produces `status: incomplete` with a null vector in fresh status responses. Enabled manifest entries are declarations, not observed organ health. Cloudflare still has no production metric reader, and neither host installs a probe executor automatically. Confirm with isolated fixtures that incomplete evidence stays unknown, three automatic ticks pause the schedule, explicit enable resets it, and a valid rest hint skips the probe without changing HEAD.
