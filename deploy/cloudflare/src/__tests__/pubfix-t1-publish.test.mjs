/** Edge pin. An ordinary Pearl-admitted organ update, built as her runtime's treePatch builds it,
 * published to a REAL X61HeadDurableObject with production wiring (no options; PUBLIC_HOST + OWNER_PUBLIC_KEY_HEX present),
 * the mirrored epoch-173 head installed, a live writer lease, and the passkey-session x-x6-verified-access header.
 * It guards the edge side of the fix: the edge admits a no-fingerprint ordinary organ update only under the canonical id
 * (server/ball-transition.mjs NON_CANONICAL_MANIFEST_ID). The old-style id (no createdAt, no authorPeerId) binds neither
 * author nor time, so it stays refused here: the fix lives in the runtime (ball-loader.ts treePatch), never at the edge. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon, manifestId } from '../head-do.mjs'
import { classifyTransition, isT2OnlyOrgan, stripOrganHashSuffix } from '../../../../server/ball-transition.mjs'

const W = new URL('../../../../', import.meta.url).pathname
const ORIGIN = 'https://head.example.invalid'
const HEAD = JSON.parse(readFileSync(W + 'mirror/home/auma/HEAD.json', 'utf8'))
const code = sha => readFileSync(`${W}mirror/home/balls/${sha}.js`, 'utf8')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const TARGET = 'auma-cortex'

// Mirrors ball-loader.ts computeBallId: the old-style id treePatch gave a NON-governance candidate before the fix.
function runtimeLegacyBallId(parentBallId, epoch, entries, modules) {
  return sha256(JSON.stringify({ version: 'x6.1-ball/v1', parentBallId, epoch,
    entries: Object.keys(entries).sort().map(k => entries[k]), modules: Object.keys(modules).sort().map(k => modules[k]) }))
}

// Mirrors treePatch (ball-loader.ts) for { id, specifier, qualificationId } with config/disabled undefined.
function buildCandidate({ canonicalId = false, peerId = 'auma-peer' } = {}) {
  const prevEntry = HEAD.entries[TARGET]
  const source = code(prevEntry.specifier.slice(5)).replace(/name:\s*'auma_cortex'/, "name: 'auma-cortex'") + '\n// repair\n'
  const sha = sha256(source), specifier = `ball:${sha}`
  const nextEntry = {
    id: TARGET, specifier,
    config: JSON.parse(JSON.stringify(prevEntry.config ?? {})),
    disabled: prevEntry.disabled ?? false,
    ...(prevEntry.governance === undefined ? {} : { governance: prevEntry.governance }),
    previousSpecifiers: [...prevEntry.previousSpecifiers, prevEntry.specifier],
    previousVersions: [...(prevEntry.previousVersions ?? []), { specifier: prevEntry.specifier, config: JSON.parse(JSON.stringify(prevEntry.config)), disabled: prevEntry.disabled }],
    updatedAt: Date.now(),
  }
  const entries = { ...HEAD.entries, [TARGET]: nextEntry }
  const staged = { sha256: sha, specifier, name: TARGET, description: `Cordis ball plugin ${TARGET}`, size: Buffer.byteLength(source), createdAt: Date.now() }
  const modules = { ...HEAD.modules, [sha]: staged }
  const body = { version: 'x6.1-ball/v1', parentBallId: HEAD.ballId, epoch: HEAD.epoch + 1, createdAt: Date.now(), authorPeerId: peerId, entries, modules }
  const ballId = canonicalId ? sha256(canonicalBootstrap(body)) : runtimeLegacyBallId(HEAD.ballId, HEAD.epoch + 1, entries, modules)
  return { ball: { ...body, ballId }, codeBySha: { [sha]: source } }
}

function storageFixture() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = structuredClone(data); const out = await operation(view(copy)); data = copy; return out })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function productionHead() {
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const head = new X61HeadDurableObject({ storage: storageFixture(), getWebSockets: () => [] }, env) // production: no options
  const codeBySha = Object.fromEntries(Object.keys(HEAD.modules).map(sha => [sha, code(sha)]))
  const payload = { version: BOOTSTRAP_VERSION, ball: HEAD, codeBySha, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: HEAD.ballId, epoch: HEAD.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const call = async (path, body) => {
    const response = await head.fetch(new Request(ORIGIN + path, { method: 'POST', body: JSON.stringify(body), headers: {
      'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }) } }))
    return { status: response.status, body: await response.json() }
  }
  return { head, call }
}

async function publish(candidate, peerId = 'auma-peer') {
  const { call } = await productionHead()
  const lease = await call('/_head/lease', { action: 'acquire', ownerPeerId: peerId, ttlMs: 30000 })
  assert.equal(lease.body.ok, true, JSON.stringify(lease.body))
  // Exactly the body broadcastCommit sends (ball-loader.ts), minus presence `peer`.
  return call('/_head/ball', { type: 'ball:commit', fromPeerId: peerId, ball: candidate.ball, codeBySha: candidate.codeBySha,
    expectedParentBallId: candidate.ball.parentBallId, expectedEpoch: candidate.ball.epoch - 1, writerLease: lease.body.lease })
}

const ownerSessionFor = parent => ({ ballId: parent.ballId, epoch: parent.epoch, expiresAt: Date.now() + 3_600_000,
  scope: { organs: [...new Set(Object.keys(parent.entries).map(stripOrganHashSuffix).filter(id => /^[a-z][a-z0-9-]{0,40}$/.test(id) && !isT2OnlyOrgan(id)))] } })

test('classifyTransition: the old-style id is T2 NON_CANONICAL_MANIFEST_ID; the canonical id is an edge T1 organ update', async () => {
  const legacy = buildCandidate({ canonicalId: false }).ball
  assert.equal(await manifestId(legacy), legacy.ballId)
  assert.notEqual(await manifestIdCanon(legacy), legacy.ballId)
  const refused = classifyTransition(HEAD, legacy, { ownerSessionApproved: true, ownerSession: ownerSessionFor(HEAD), canonicalManifestMatches: false, now: Date.now() })
  assert.equal(refused.tier, 'T2')
  assert.equal(refused.isEdgeT1OrganUpdate, false)
  assert.deepEqual(refused.changedEntryIds, [TARGET])
  assert.deepEqual(refused.t2Reasons, ['NON_CANONICAL_MANIFEST_ID'])

  const canonical = buildCandidate({ canonicalId: true }).ball
  assert.equal(await manifestIdCanon(canonical), canonical.ballId)
  const admitted = classifyTransition(HEAD, canonical, { ownerSessionApproved: true, ownerSession: ownerSessionFor(HEAD), canonicalManifestMatches: true, now: Date.now() })
  assert.equal(admitted.tier, 'T1')
  assert.equal(admitted.isEdgeT1OrganUpdate, true)
  assert.deepEqual(admitted.changedEntryIds, [TARGET])
  assert.deepEqual(admitted.t2Reasons, [])
})

test('production head: an ordinary single-entry update under the OLD-STYLE id is refused 403 and the head stays at epoch 173', async () => {
  const { call } = await productionHead()
  const lease = await call('/_head/lease', { action: 'acquire', ownerPeerId: 'auma-peer', ttlMs: 30000 })
  assert.equal(lease.body.ok, true, JSON.stringify(lease.body))
  const candidate = buildCandidate({ canonicalId: false })
  const out = await call('/_head/ball', { type: 'ball:commit', fromPeerId: 'auma-peer', ball: candidate.ball, codeBySha: candidate.codeBySha,
    expectedParentBallId: candidate.ball.parentBallId, expectedEpoch: candidate.ball.epoch - 1, writerLease: lease.body.lease })
  assert.equal(out.status, 403)
  assert.equal(out.body.ok, false)
  assert.equal(out.body.code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  const after = await call('/_head/lease', { action: 'release', ownerPeerId: 'auma-peer', generation: lease.body.lease.generation })
  assert.equal(after.body.ok, true)
  const reacquired = await call('/_head/lease', { action: 'acquire', ownerPeerId: 'auma-peer', ttlMs: 30000 })
  assert.equal(reacquired.body.ballId, HEAD.ballId)
  assert.equal(reacquired.body.epoch, 173)
})

test('production head: the same candidate with ONLY the ballId made canonical is accepted as T1 at epoch 174', async () => {
  const candidate = buildCandidate({ canonicalId: true })
  const out = await publish(candidate)
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(out.body.ok, true)
  assert.equal(out.body.tier, 'T1')
  assert.equal(out.body.epoch, 174)
  assert.equal(out.body.ballId, candidate.ball.ballId)
})
