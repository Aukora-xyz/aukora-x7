---
kind: upgrade-guide
description: "Round 23 changes escrow wrapping, Class 3 approval lifetime, governance publication and checkpoint signer admission."
---
# Round 23 security bridge

English | [中文](guide.zh.md)

## Change

SOURCE: Host operators and checkpoint producers must preserve existing custody state while adopting fresh five-minute approvals, host-classified governance transitions and independently configured signer windows. These source changes do not establish deployment or production readiness.

## Migration

1. Preserve existing AUMLOK state and pepper. [Custody](../../../../deploy/cloudflare/src/aumlok.mjs) writes `aukora.aumlok.escrow.v3` with HKDF-SHA256 and AES-GCM; existing HMAC-wrapped v2 escrow remains readable without status-triggered rewriting. Legacy v1 still requires explicit migration; never reset it to reenroll. The pepper remains colocated with ciphertext: full-state exfiltration still enables offline attacks.
2. Configure the independent `OWNER_PUBLIC_KEY_HEX` and exact-intent `authorizeEnrollment` approver. Enrollment requires verified Owner Access, registration, assertion, node-key possession, unbound state and zero enrollments. Its audit record and binding commit atomically. Reject repeated enrollment and node keys equal to either owner authority or an Ed25519 WebAuthn credential. Access alone is insufficient; no production enrollment approver is installed.
3. Send `x-x6-class3-approval` separately from the mutation body. Fresh approval expires at `approvedAt + 300000`, independently of the 120-second challenge. Inspect `rotationSeq` and opaque `keyCommitmentId` after uncertain rotation responses. `approvedGrants` and public IDs are metadata, never authorization. Never send bearers through WorkerTunnel: same-realm organs can observe that shared channel.
4. [Cloudflare publication](../../../../deploy/cloudflare/src/head-do.mjs) independently classifies changes/removals to protected organs' `specifier`, `disabled` or `config` as Class 3. Preserve `scope.organ` and `scope.candidateSha256`; approval binds audience, `head.promote`, candidate ball, epoch, organ and hash. Host verification does not consume; direct browser-to-Cloudflare publication consumes once atomically with HEAD selection and rechecks expiry. Multiple protected-entry changes remain refused. Runtime bearer handoff is unsupported; `seed-superagent` confirmation requires a separately installed trusted provider. Local protected publication still refuses Class 3; atomic local promotion and production Pearl verification remain unavailable. The checkout lacks `mirror/home/auma/seed/candidates/seed-pearl.js`; the next epoch's promotion is not ready.
5. Configure finite `CHECKPOINT_SIGNER_POLICY` ranges or a finite `CHECKPOINT_SIGNER_PIN.validToCheckpoint` independently of mirror files. [Verification](../../../../server/verified-facts.mjs) requires each v2 entry's outgoing-key countersignature over `aukora.checkpoint-signer-bridge.v2\0` plus canonical entry fields, excluding the countersignature. Never trust the brief's mistyped key or self-supplied pins. [Checkpoint producer](../../../../mirror/home/auma/seed/organs/seed-receipts.js) requires an authenticated host policy for checkpoint 15+, matching finite v1 windows and the existing signing identity. Hybrid cutover fails closed until a hybrid signer exists; never resume v1 afterward. No real keys, pins or state are migrated.
6. Public HTTPS fetch still defaults to `PUBLIC_NETWORK_GUARD_UNAVAILABLE`. The [Node helper](../../../../server/public-https-transport.mjs) is IPv4-only, rejects any nonpublic DNS answer, pins the selected address while retaining the original TLS hostname, rejects redirects, and limits requests to ten seconds and 256 KiB. Neither host installs this helper. Before activation, validate enrollment, approval replay/races and signer cutover. [Offline contract checks](../../../../server/verify-contracts.test.mjs) contain unresolved TODOs, not full closure.

UNVERIFIED: No production settings, deployment, live data or epoch promotion changed.
