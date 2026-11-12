---
kind: upgrade-guide
description: "Runtime mutations require independent approval or build-pinned qualification; cloud publication, identity ceremonies, and history writes enforce narrower requests."
---
# Round 21 brokered authority

English | [中文](guide.zh.md)

## Change

Runtime and host clients must handle refusals where mutation requests previously reached executors without independent qualification. Authentication, browser booleans, commitments, and recorded success are not owner approval. Reads and idempotent same-HEAD publication remain available. These source contracts do not establish deployment or live activation.

Cloud brokers provide bounded, owner-authenticated, same-origin reads. GitHub access is fixed to the repository's `main` branch. Each `write`, `commit`, or `push` publishes atomically; these are not staging operations. AUMLOK requires verified WebAuthn registration, a subsequent assertion, separate Ed25519 node-key possession, and trusted enrollment approval. Browser integration and live ceremonies remain unverified; enrollment is unavailable by default without a trusted approver.

Local brokers retain metadata status and bounded no-follow source reads. Repo `log`/`diff` return HTTP 503 `LOCAL_REPO_READ_UNAVAILABLE`; GitHub GET API returns HTTP 503 `LOCAL_GITHUB_READ_UNAVAILABLE`. Generic shell/`gh`/Wrangler commands, pushes, and unqualified source writes are refused. Cloud repo `log`/`diff` remain available.

Named runtime action checks do not confine arbitrary JavaScript, raw filesystem access, or global `fetch`.

## Migration

1. Use `/_host/repo`, `/_host/github`, and `/_host/cloudflare` according to [the broker implementation](../../../../deploy/cloudflare/src/cloud-brokers.mjs). Keep `GITHUB_TOKEN` and `CLOUDFLARE_API_TOKEN` server-side. Publication accepts only explicit `mirror/home/auma/seed/organs/*.js` files, `expectedHeadSha`, `idempotencyKey`, and a message. Integrate independently trusted `approveRepoPublication` for the exact canonical request; production installs none. GitHub GraphQL `expectedHeadOid` prevents moved-HEAD publication. Reconcile an unknown outcome with the identical request before changing it.
2. Update clients to [AUMLOK's two-step ceremony](../../../../deploy/cloudflare/src/aumlok.mjs). Trusted process configuration must supply `authorizeEnrollment`; no request flag enables it. Keep raw words and biometric data out of requests. Neither user verification nor `verifyAumlokInviteReceipt` establishes biometric identity, phrase recovery, current invitation eligibility, or redemption.
3. Build [the runtime](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts) with immutable `__X6_BUILD_IDENTITY__.retentionSuiteDigest` computed by [the suite digest helper](../../../../packages/experimental/webworker-runtime/src/x6/scion-growth.ts). The current builder omits it, so promotion admissions remain unavailable. Obtain fresh, single-use qualifications for exact candidate, entry, HEAD, and suite within five minutes. [HeadDO](../../../../deploy/cloudflare/src/head-do.mjs) and [the local host](../../../../server/local-host.mjs) lack trusted transition issuers; new publication, local recovery writes, and `POST /_head/runtime` selection remain refused; runtime `GET` remains available. Snapshot creation requires every declared and historical module's verified bytes; it does not acknowledge durable backup.
4. Preserve exact existing prefixes of `seed/receipts.v3.jsonl` and `seed/checkpoints.v1.jsonl`, plus existing content-addressed `memory/dag/` files under `/dsh/home/auma/`; [MirrorDO](../../../../deploy/cloudflare/src/mirror-do.mjs) refuses history rewrites or deletion. Supply checkpoint trust independently through `checkpointSignerPolicy`, with finite contiguous `firstSeq`–`lastSeq` ranges starting at one. Do not combine it with `checkpointSignerPin` or trust VFS-supplied keys. Without independent configuration, signers remain unpinned.
5. Treat [facts](../../../../server/verified-facts.mjs) `organSourceEvidence: recorded-build-info` as recorded metadata, not running-code proof. Preserve unknown values; invitation signature helpers are not an aggregate eligibility check. Before activation, the deployment owner must verify refusal without approvers, rejection of stale bindings, and unchanged retained data using isolated fixtures, then separately verify the deployed build.
