# Architecture actual

English | [中文](ARCHITECTURE-ACTUAL.zh.md)

This page pins files and symbols. It does not describe a live deployment. **UNPERFORMED.** No boot of the worker, the local host, or Cloudflare is recorded here. A local run reported by someone else is a **REPORTED RUN**.

## Browser WebWorker

**SOURCE.** `connectWorkerHost` is `packages/experimental/webworker-runtime/src/client/index.ts`. The ball manifest and mutations live in `packages/experimental/webworker-runtime/src/x6/ball-loader.ts`.

**SOURCE.** `computeBallId` hashes `JSON.stringify` of `{ version, parentBallId, epoch, entries, modules }`. Entry and module keys are sorted. Nested key order inside each value is kept. `version` is the string `x6.1-ball/v1`.

**SOURCE.** `completeMutation` appends a receipt by calling `seed-receipts` with `action: 'append'`. The kind is the mutation kind (`tree.patch`, `tree.undo`, `snapshot.restore`, or `seed.bootstrap` at its call sites). The data object is `{ entryId, ballId, parentBallId, epoch }`. That call is not kind `ball.promote`.

**SOURCE.** The page readout reads status with `POST /__x6__/call-tool`. That contract is the header of `apps/web/src/spatial/superagent/contract.ts`. The readout does not open a second session.

## Local host

**SOURCE.** `server/local-host.mjs` is the Node host. It imports `createBallHeadStore` from `server/ball-head.mjs`. The model door handler starts at `pathname.startsWith('/door/')`.

**SOURCE.** `server/ball-manifest.mjs` owns `legacyManifestPreimage` and `validateManifestStructure`, shared by the local and Cloudflare head adapters. The preimage preserves the `computeBallId` field order and nested key order. Structural validation preserves the first failure code and accepts unknown fields. `server/ball-head.mjs` keeps synchronous hashing and accepts either the legacy digest or `manifestIdCanon`, which hashes sorted-key JSON of every field except `ballId` and omits undefined object values.

**SOURCE.** `publish` in `server/ball-head.mjs` rejects a candidate unless `ball.parentBallId` is the selected ball and `ball.epoch` is the selected epoch plus one. The failure code is `REBASE_REQUIRED`. The same function also requires a writer lease. There is no Ed25519 check in `validateManifest` or `publish`.

## Cloudflare DO mirror

**SOURCE.** `deploy/cloudflare/src/worker.mjs` sends `/door/` to `providerDoor`. It forwards `/_head/ball`, `/_head/lease`, and `/_head/ws` to the head binding, and mirror routes to the mirror binding.

**SOURCE.** `deploy/cloudflare/src/head-do.mjs` uses the shared preimage and structural validator, with asynchronous hashing and validation. Its `manifestIdCanon` retains `canonicalBootstrap`, the bounded sorted-key walk used for seed identity and imported by `deploy/cloudflare/src/mirror-do.mjs`. Unlike the local canonical walk, it rejects undefined values, non-finite numbers, and excessive structure. These canonical policies remain distinct. The shared module performs no hashing, storage, or authorization; head selection, writer leases, and persistence remain adapter-owned. No Ed25519 manifest signature is read in these files.

## Model door

**SOURCE.** `packages/experimental/webworker-runtime/src/model-doors.ts` lists provider prefixes, including `https://api.deepseek.com/` mapped to door name `deepseek`. `modelDoorFor` rewrites a matching URL to `{origin}/door/{name}/...`.

**SOURCE.** The local host and the Cloudflare worker both have a `/door/` path, cited above. This page does not claim those two doors were observed to inject a key. The local host header says credentials stay outside the repo. This page does not copy that filesystem path.

## Receipts and checkpoints

**SOURCE.** `mirror/home/auma/seed/organs/seed-receipts.js` `append` writes `aukora.receipt.v3` with `prevHash` and a Merkle leaf. It does not sign that line. `checkpoint` signs `aukora.x5.edge-head.v1` plus a NUL plus canonical JSON of the checkpoint body, using Ed25519. The readout pins two public keys in `apps/web/src/spatial/superagent/authority.ts` (`PINNED_RECEIPT_SIGNERS`) and does not add a key that arrives inside a file.

**SOURCE.** The committed `mirror/home/balls/HEAD.json` is the genesis head: epoch 1, no parent, one entry and one module per seed organ. No receipts or checkpoints are committed; a node writes `receipts.v3.jsonl` and `checkpoints.v1.jsonl` at run time. These are checkout bytes, not a live host observation.

## Proposed manifest signature

**PROPOSED.** The readout helper in `apps/web/src/spatial/superagent/manifest.ts` checks this envelope. **UNPERFORMED.** `server/ball-head.mjs` and `deploy/cloudflare/src/head-do.mjs` do not accept or require it. A passing helper does not publish a ball.

```json
{
  "schema": "aukora.x6.manifest-signature.v1",
  "ballId": "<64 lowercase hex>",
  "idForm": "loader",
  "publicKeyHex": "<64 lowercase hex>",
  "signatureHex": "<128 lowercase hex>"
}
```

`idForm` is `loader` or `canon`. The signed message is UTF-8 of `aukora.x5.edge-head.v1\0` plus the preimage for that form. `loader` is the `computeBallId` / `manifestId` string. `canon` is the `manifestIdCanon` string. `ballId` must equal SHA-256 of that preimage. The helper trusts only the key list passed to it. The default list is the two pinned receipt signers. A key written on the manifest or in the envelope is not added. `unsigned-optional` with no envelope returns `verified: false` and status `unsigned`. `strict` with no envelope returns status `missing`. Neither status is verified.

**SOURCE.** `monotoneParent` in the same file names the host rule: parent id equals the selected ball, epoch equals selected epoch plus one. The server still reports `REBASE_REQUIRED` rather than these local reason strings.
