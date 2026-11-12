---
kind: upgrade-guide
description: "Configured owner sessions can authorize first enrollment, and single-organ passkey promotion requires canonical manifests."
---
# Owner-session enrollment and passkey head promotion

English | [中文](guide.zh.md)

## Change

Configured Cloudflare hosts default to `owner-access-genesis-v1` when `AUMLOK_ENROLLMENT_MODE` is absent. First enrollment requires an authenticated owner session, verified registration and separate WebAuthn assertion, node-key possession, exact origin, fresh expiry and atomic unbound/zero-enrollment state. The session is now the pre-existing identity anchor: a holder of a valid owner session can enroll a new credential. This does not attest hardware or biometrics. Explicit `owner-signature-v1` retains the additional exact-intent signature requirement; unknown modes refuse.

The default two-argument head constructor supports owner-passkey authorization for a single governance-organ change without separate Pearl qualification. It creates no qualification record or behavioral-success claim. The passkey-only path requires a canonical full-manifest ID and unchanged sibling entries, plus existing hashes, parent/epoch checks, writer lease and atomic single-use approval. Ordinary Class 1 changes still require qualification; explicitly supplied qualifier callbacks remain mandatory, and explicit null/undefined overrides keep that path closed.

Runtime snapshot and staging-parent readers accept both valid legacy and canonical IDs. Newly constructed governance candidates use canonical IDs; existing staged candidates are not rewritten. Older runtime bundles may reject canonical heads, so deployment must pair the compatible runtime and edge code. Existing UI readers can still offer approval for a legacy or mixed-sibling candidate before the server refuses it; server admission metadata is not itself client preflight enforcement.

Worker `node` commands retain the bounded lifetime rules: directly injected timers and returned promises share a 30-second deadline, timeout exits nonzero, and owned timers are cleaned up. External workers/module timers remain untracked; synchronous work cannot be preempted.

## Migration

1. Preserve custody, pepper and enrollment records. Never reset them to reenroll. Review the default session-trust policy before deployment; use explicit `owner-signature-v1` if the additional independent signature is required. That mode still needs a producer of the exact proof defined by [the verifier](../../../../deploy/cloudflare/src/enrollment-approval.mjs).
2. Local enrollment additionally requires `X6_AUMLOK_ORIGIN`, `X6_OWNER_EMAIL` and `X6_OWNER_PUBLIC_KEY_HEX`; `X6_AUMLOK_ENROLLMENT_MODE` is optional. The origin must exactly match an allowed loopback origin. Supply a genuinely signed owner JWT with that host:port audience. A local capability cookie alone is insufficient; no credential is created by this change.
3. Before promotion, load the compatible runtime and prepare a canonical candidate with only the intended governance entry changed. Restage legacy candidates explicitly; do not alter live staged artifacts automatically. Keep sequential owner approvals for multiple governance organs. The server can refuse `CLASS3_CANONICAL_MANIFEST_REQUIRED` before spending approval.
4. Align client preflight with the server's admission policy. Test valid first bind once, wrong/expired sessions, forged/replayed approvals, malformed modules, stale leases, competing commits and transaction rollback. Synthetic success does not establish a live ceremony or deployment.
5. Return completion promises for external work in `node -e`; inspect potentially continuing work before retrying a timeout. Verify the actual loaded release separately from Git and test results.
