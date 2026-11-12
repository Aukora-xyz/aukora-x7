---
kind: upgrade-guide
description: "Owner-grant and self-build consumers must handle separate approval, bounded retention, incomplete Aura evidence, and separated prediction-score scales."
---
# Round 19 self-build admission

English | [中文](guide.zh.md)

## Change

Local `POST /_host/owner-grant` returns `OWNER_APPROVAL_REQUIRED` by default; browser headers are not consent. A separately authenticated provider must approve exact canonical terms and their domain-prefixed hash; the issuer checks current `ballId`, `epoch`, and expiry. Scope paths cannot authorize approval or HEAD rebinding.

Grant issuance rejects null, empty, tools-only, wildcard and arbitrary-path scopes, including previously accepted non-self-build requests. Governance targets `seed-receipts`, `seed-superagent`, `seed-pearl` and `seed-aura` require exactly one target, non-null `ticketId`, finite future `expiresAt` and lowercase 64-hex `scope.candidateSha256`. Signed fields and promotion consumers are unchanged; consumers must preserve and enforce candidate bindings. Older grants are not revoked.

Asset capture can remove old, unpinned runtime closures. It preserves the selected release, every still-cached runtime-head history reference, explicit pins, the incoming release, and the five newest releases. Protected history can still exhaust the budget. Open candidate tabs have no retention leases.

Aura treats zero DAG/receipt/organ denominators as incomplete instead of substituting one, while preserving independent verified counts. Negative-zero numeric inputs are invalid rather than clean-state evidence.

`seed-predict` reports `receipt_error` and `surpriseScore` as relative error: `abs(observed - expected) / max(abs(expected), 1)`. The former 0–100 heuristic is `legacyPenaltyV0`. Calibration requires a verified register→promotion→observe receipt sequence; ambiguous duplicate or conflicting receipts remain unanchored. Neither score measures task accomplishment.

Pearl's parent runner compares outputs using good/bad and accept-all/reject-all comparator controls. Supplied qualification IDs are single-use, bound to runtime/entry/source/HEAD/suite, and confer no owner consent. Named organ hydration preserves edits and unknown ancestry.

The [offline gate runner](../../../../server/gate-audit.mjs) executes committed tests with host permissions, without an OS sandbox. Verification requires an independently pinned runner key's admission signature and matching runner/source/suite digests. Source publication is not deployment or activation.

## Migration

1. Handle grant refusal. Use `organs` IDs or exact `.js` `paths` under `/dsh/home/auma/seed/organs/` or `mirror/home/auma/seed/organs/`. Integrate trusted `approveOwnerGrant` through [the owner handler](../../../../server/owner-grant.mjs) before relying on signing. Using isolated temporary keys, confirm missing approval, altered bindings, and moved HEAD are rejected.
2. Use owner JWTs without `sub`/`iat`. The owner-approved maximum/default expands from 12 to 24 hours, increasing [stolen-bearer exposure](../../../../deploy/cloudflare/README.md). The optional [minter](../../../../server/mint-owner-jwt.mjs) accepts 1–24 hours and requires existing private JSON key `~/.aukora-x6-vault/owner-ed25519.json`; it neither provisions nor migrates keys. Credential issuance requires separate authorization.
3. Use [the cache's `pinRelease`](../../../../server/asset-cache.mjs) to preserve older candidates needed by tabs or rollback. Handle `ASSET_CACHE_BUDGET_EXHAUSTED`; pruning cannot remove protected history. Verify retention with temporary cache fixtures before deployment.
4. Read [prediction `trajectory_export`](../../../../mirror/home/auma/seed/organs/seed-predict.js): use `receipt_error` when `calibrationStatus` is `receipt-anchored`, and display `legacyPenaltyV0` separately. Do not relabel historical `surpriseScore` or rewrite logs. Verify unanchored receipts and negative-zero/zero-denominator [Aura inputs](../../../../server/aura-rules.mjs) without fabricating scores or counts.
5. Pair updated `seed-pearl.js` with a [runtime](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts) providing `ctx.scion.trialRetentionCandidate`; older runtimes return `PEARL_TRIAL_UNAVAILABLE`. Obtain fresh trials after candidate/suite changes. Supplied `qualificationId` must retain its exact binding. Verify edited named sources survive hydration. Existing raw promotion routes remain outside this guarantee; route evidence certifies neither containment nor production coverage.
