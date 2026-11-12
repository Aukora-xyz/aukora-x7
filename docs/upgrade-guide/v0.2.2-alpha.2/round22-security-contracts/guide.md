---
kind: upgrade-guide
description: "Round 22 replaces ambient owner authority and legacy AUMLOK persistence with explicit approval and versioned verification."
---
# Round 22 security contracts

English | [中文](guide.zh.md)

## Change

SOURCE: Worker-held owner signing keys are replaced by client-signed hybrid grants or explicit bound-passkey approvals. Protected mutations require fresh Class 3 approval. Generic hybrid verification does not complete identity migration.

This is a scoped protocol objective, not an unconditional guarantee: “The phrase alone is inert by protocol; offline verification is impossible without infrastructure compromise; online guessing is rate-limited and audited; and the residual risk is written down.”

It assumes inaccessible pepper-wrapped escrow contents. Exposed client AES-GCM ciphertext permits offline guessing. Public invite `inviteeCommitmentSha256` may also permit offline guessing. Browser/storage compromise or ciphertext copying defeats this assumption; online limits cannot constrain offline attacks.

## Migration

1. Preserve `aumlok:v1` storage. [AUMLOK](../../../../deploy/cloudflare/src/aumlok.mjs) rejects legacy v1 with `AUMLOK_STATE_MIGRATION_REQUIRED`; no migration tool exists. Never reset to reenroll. Keep pepper, commitments, and escrow private. Raw words fail with `CLASS4_RAW_SECRET_FORBIDDEN`. Ceremony clients must supply `sealedRootKeyB64`, `kdfSaltB64`, `kdfIterations`, and `ivB64`.
2. Genesis requires independently approved exact intent, verified Owner Access, registration, assertion, and node-key possession; software-authenticator claims alone are insufficient. No production approver is installed. Rotation preserves the node key; unseal requires fresh bound-passkey verification. Five failures/hour, exponential backoff and ten cumulative failures apply; hard lockout has no guardian recovery service. Audit retains newest 256 rows, lifetime/pruned counts and a hash commitment, not full archival or external tamper proof. Older-v2 reads never write; pruning, time and success never reset failure counters.
3. Send `x-x6-class3-approval` for protected head changes, messages and broker mutations. Single-use tokens expire five minutes after approval, independently of the 120-second challenge. Generic actions bind origin, generation, method, path and complete-body digest; governance uses the [promotion binding](../round23-security-bridge/guide.md). See [host enforcement](../../../../deploy/cloudflare/src/head-do.mjs).
4. Use [hybrid verification](../../../../deploy/cloudflare/src/owner-grant-policy.mjs): Ed25519 plus Pure ML-DSA-65, context `aukora.v2`, domain `aukora.hybrid.v2\0`, canonical envelope fields, both signatures mandatory. Resolve the handoff/checkpoint key mismatch independently before pinning; envelopes/mirror cannot establish trust. **Block hybrid activation pending migration:** [facts](../../../../server/verified-facts.mjs) and [seed-receipts](../../../../mirror/home/auma/seed/organs/seed-receipts.js) allow checkpoint 15+ v1 only in independently configured finite windows; v2 requires an outgoing-key countersignature and an available hybrid signer. Downstream governance/browser grants remain v1; invites/revocations remain Ed25519 v1.
5. Configure `PROVIDER_BUDGET_WINDOW_MS`, `PROVIDER_BUDGET_REQUESTS`, `PROVIDER_BUDGET_TOKENS` and `PROVIDER_MAX_OUTPUT_TOKENS` on both hosts. Bounded inline function tools remain supported; hidden-cost request forms are refused. Reservations are not billing caps. Arbitrary public fetch fails with `PUBLIC_NETWORK_GUARD_UNAVAILABLE`; exact local read-only probes and fixed bounded search remain. Candidate execution refuses `GATE_CONFINED_RUNNER_REQUIRED`; no confinement service exists.
6. Use a non-watch rebuild with [Vite baseline stamping](../../../../apps/web/vite.config.ts); retain baseline cases/fixtures unchanged. [Runtime comparison](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts) owns both candidate/incumbent runs against unchanged inputs and refuses `baselineSpecifier`. Consume `suiteDigest`, `suiteBytesDigest`, `baselineResult`, `comparisonComplete`, `targetImproved` and `winnerId`; ties, incomplete runs and diagnostic calls never qualify promotion. Verify valid/invalid fixtures before activation.

UNVERIFIED: Source/tests do not establish deployed behavior. No production keys, pins, deployment or activation are supplied.
