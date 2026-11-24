# Direction

## Proposed work

| Direction | Evidence and status |
| --- | --- |
| Continuity Diamond | DIRECTION, and nothing of it is built. See [the status inventory](WHAT-IS-BUILT.md). |
| Edge authority checks in Wasm | Unbuilt. See the implementation inventory in [What is built](WHAT-IS-BUILT.md). |
| Production on another cloud host | IDEA. Local Node host in `server/local-host.mjs`. Production on another cloud has no recorded run here. |
| Independent approval display | Unbuilt in this export. See [security limits](../SECURITY.md). |
| Restore from distributed pieces into an empty deployed edge | The fixture restores an empty test edge from a reconstructed snapshot. A deployed run remains unverified. See `deploy/cloudflare/src/__tests__/recovery-restore.test.mjs`. |
| Action exchange between independently owned nodes | Unbuilt. See [the draft ARK contract](../ark/CONTRACT.md). |

## Current reference points

- The merge-card handler sends a Git ref update naming main and the proposal branch at [deploy/cloudflare/src/cloud-brokers.mjs:1978](../deploy/cloudflare/src/cloud-brokers.mjs#L1978). Head sync defers when the readable staged base matches main at [deploy/cloudflare/src/cloud-brokers.mjs:2641](../deploy/cloudflare/src/cloud-brokers.mjs#L2641).
- Repository door level. This tree sets `open` in [deploy/ci/frozen-paths.mjs:40](../deploy/ci/frozen-paths.mjs#L40).
- At the voice level the tree sets (`open`), the configuration is recorded in [packages/experimental/webworker-runtime/src/x6/voice-marks.ts:57](../packages/experimental/webworker-runtime/src/x6/voice-marks.ts#L57).
- Wake act configuration. `WAKE_ACTS_ENABLED = "1"` in [deploy/cloudflare/wrangler.toml:92](../deploy/cloudflare/wrangler.toml#L92). Live completion remains unverified.

[Module-change walkthrough](ARCHITECTURE-MAP.md) · [Capability inventory](WHAT-IS-BUILT.md) · [Review and merge code](../deploy/cloudflare/src/cloud-brokers.mjs).

The component notice states, “The authors own pentora36.wasm and ship it without source and without a separate licence.” See the separate notice at `apps/web/public/seed-library/pentora/LICENSE.binaries`.

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
