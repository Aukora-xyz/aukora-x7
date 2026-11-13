/**
 * Her cloud records which browser is her body, and her body is a KEY.
 * MIRROR's half runs through the REAL `leaseAction` over a storage whose transaction really rolls back, runs ONE AT A TIME
 * (as MIRROR does) and can list; the Worker's half through the real `createThreadMount` with a vault bucket in memory and
 * a MIRROR fake that runs that same `leaseAction` behind MIRROR's 1,024-byte reader. Installation keys are made here with
 * node's WebCrypto (ECDSA P-256, private key non-extractable). Rule 1 (inert) is proved against world-lease.mjs,
 * world-home.mjs and mirror-slot-tombstone.mjs as they are at an earlier commit (read with `git show`): answers, final storage AND
 * the list of storage operations of every call. No network, no build.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { HOLDER_START_LIMITS, WORLD_LEASE, checkLease, holderStartUp, leaseAction, leaseStillNamed, leaseSummary } from '../world-lease.mjs'
import { homeSummary, worldStatus } from '../world-home.mjs'
import * as holder from '../world-holder.mjs'
import { THREAD_EMPTY_SHA, THREAD_LIMITS, THREAD_ZERO_CHAIN, bytesToBase64, threadCommit, threadIdForPath } from '../thread-log.mjs'
import { createThreadMount } from '../thread-mount.mjs'
import { retireClientSlot } from '../mirror-client-slots.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { AUMLOK_STORAGE_KEY, aumlokClass3Binding } from '../aumlok.mjs'

const { HOLDER_WORDS, WORLD_HOLDER, WORLD_HOLDER_LOG, WORLD_SEALED, holderProofMessage, holderProofValid, holderWord, logMark, logMarkOf, needsList } = holder
const BASE = 'be552705'
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLIENTS = [A, B, C]
const LEASE = 'world:v1:lease'
const PENDING = 'world:v1:home-pending'
const T0 = 1_800_000_000_000
const ORIGIN = 'https://holder.example.invalid'
const WORLD = 'node-main-v1'
const PATH = '/dsh/home/auma/session/messages.jsonl'
const OTHER_PATH = '/dsh/home/sessions/s1/t1/session.v1.jsonl'
const encoder = new TextEncoder()
const shaHex = value => createHash('sha256').update(value).digest('hex')
const tabOf = id => `tab-${id[0]}`
const labelOf = id => ({ [A]: 'Chrome on the Mac', [B]: 'Firefox', [C]: 'Safari' })[id] ?? 'Elsewhere'
const { subtle } = globalThis.crypto

/** An installation key as her body's browser makes it: P-256, the private half non-extractable. */
async function makeDevice() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const key = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  return { key, sign: async text => Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encoder.encode(text))).toString('base64url') }
}
const devices = Object.fromEntries(await Promise.all(CLIENTS.map(async id => [id, await makeDevice()])))
const stranger = await makeDevice()
/**
 * job 3: each browser's signed-in session has its own public id (`sid`), which the Worker alone puts on the input
 * (thread-mount.mjs); a request is always in the session of the browser that SENDS it. `STRANGER_SID`: another session.
 */
const SID = Object.fromEntries(CLIENTS.map((id, i) => [id, String(i + 1).repeat(32)]))
const STRANGER_SID = '9'.repeat(32)
const SESSION_ACTIONS = new Set(['status', 'acquire', 'renew', 'take', 'release', 'seal', 'reserve'])

/**
 * In-memory storage: a transaction really rolls back when its closure throws, and transactions run ONE AT A TIME (MIRROR
 * serializes its requests). `list` honours start and startAfter. `record` (an array) receives every operation.
 */
function createRollbackStorage(initial = {}, { record = null } = {}) {
  let data = new Map(Object.entries(structuredClone(initial)))
  let queue = Promise.resolve()
  const viewOf = read => ({
    get: async key => { record?.push(`get ${key}`); return read().has(key) ? structuredClone(read().get(key)) : undefined },
    put: async (key, value) => { record?.push(`put ${key} ${JSON.stringify(value)}`); read().set(key, structuredClone(value)) },
    delete: async key => { record?.push(`delete ${key}`); return read().delete(key) },
    list: async (options = {}) => {
      record?.push(`list ${JSON.stringify(options)}`)
      const { prefix = '', start, startAfter, limit = Infinity } = options
      const out = new Map()
      for (const key of [...read().keys()].sort()) {
        if (!key.startsWith(prefix) || (start !== undefined && key < start) || (startAfter !== undefined && key <= startAfter)) continue
        if (out.size >= limit) break
        out.set(key, structuredClone(read().get(key)))
      }
      return out
    },
  })
  return {
    ...viewOf(() => data),
    transaction(fn) {
      const run = queue.then(async () => {
        const staged = new Map([...data].map(([key, value]) => [key, structuredClone(value)]))
        const result = await fn(viewOf(() => staged))
        data = staged
        return result
      })
      queue = run.catch(() => {})
      return run
    },
    snapshot: () => structuredClone(Object.fromEntries([...data].sort(([a], [b]) => (a < b ? -1 : 1)))),
  }
}

const clock = { now: T0 }
const tick = ms => { clock.now += ms }
const fresh = (initial = {}) => { clock.now = T0; return createRollbackStorage(initial) }
/**
 * A browser signs each credential request with a ts greater than its last (the contract: max(own clock + offset, last + 1)).
 * After a test sets the clock back (fresh), the next ts starts again from the clock.
 */
let lastTs = 0
const nextTs = () => { lastTs = lastTs + 1 > clock.now && lastTs + 1 <= clock.now + 60000 ? lastTs + 1 : clock.now; return lastTs }
const call = (storage, input, { approved = false, homeFreeze } = {}) => leaseAction(storage, input, { now: clock.now, ownerApproved: approved, homeFreeze })
const who = id => ({ clientId: id, tabId: tabOf(id), label: labelOf(id) })
const proofOf = async (device, input, ts = nextTs()) => ({ ts, sig: await device.sign(holderProofMessage(input, ts)) })
/** The session a request is sent in: `as` (a client id) when it names one, else `id`; a bare key is another browser's. */
const sidOf = (id, as) => (typeof as === 'string' ? SID[as] : as && typeof as === 'object' ? STRANGER_SID : SID[id])
/** A lease request; `as` names whose installation key signs it (null: no proof), and in whose session it is sent. */
async function lease(storage, action, id, extra = {}, { approved = false, homeFreeze, as = null, sid = sidOf(id, as) } = {}) {
  const input = { action, ...who(id), ...(SESSION_ACTIONS.has(action) && sid ? { sid } : {}), ...extra }
  return call(storage, as ? { ...input, proof: await proofOf(devices[as] ?? as, input) } : input, { approved, homeFreeze })
}
/** Her body speaking: the request signed by its own id's key. */
const own = (storage, action, id, extra = {}, options = {}) => lease(storage, action, id, extra, { ...options, as: id })
const markOf = storage => storage.transaction(tx => logMark(tx))
const copyOf = maker => ({ verified: true, maker })
/** THE PREVIEW: status with a checkpoint key (and, with `as`, her body's proof). */
async function preview(storage, id, checkpoint, copy, { as = null } = {}) {
  const input = { action: 'status', ...who(id), sid: sidOf(id, as), checkpoint }
  const signed = as ? { ...input, proof: await proofOf(devices[as], input) } : input
  return call(storage, { ...signed, ...(checkpoint === null ? {} : { copy }) })
}
/** `reserve`, signed by the target's own key (the proof of possession). */
async function reserve(storage, id, { expect, checkpoint = null, copy, accept = [], log, device = devices[id] } = {}) {
  const input = { action: 'reserve', ...who(id), sid: SID[id], expect, checkpoint, log: log ?? await markOf(storage), accept, key: device.key }
  return call(storage, { ...input, proof: await proofOf(device, input), ...(checkpoint === null ? {} : { copy }) })
}
/**
 * job 4: the passkey-approved move of `descriptor`. By default it is sent as the target's page sends it:
 * with the target key's proof (in the target's session) beside the descriptor, so the answer may say `you`;
 * `{proof: false}` sends the descriptor alone (then `you` is absent).
 */
const deviceOfKey = key => [...Object.values(devices), stranger].find(device => device.key === key)
async function provenMove(descriptor) {
  const device = deviceOfKey(descriptor.key)
  if (!device || !SID[descriptor.clientId]) return descriptor
  const input = { ...descriptor, sid: SID[descriptor.clientId] }
  return { ...input, proof: await proofOf(device, input) }
}
const commit = async (storage, descriptor, approved = true, { proof = true } = {}) => call(storage, proof ? await provenMove(descriptor) : descriptor, { approved })
/** reserve, then the passkey-approved move of the descriptor it answered. */
async function move(storage, id, options = {}) {
  const reserved = await reserve(storage, id, options)
  if (reserved.status !== 200) return reserved
  return commit(storage, reserved.body.descriptor, options.approved ?? true)
}
const claim = (storage, id, expect, accept = []) => move(storage, id, { expect, accept })
async function seal(storage, id, checkpoint, rev, { copy = copyOf(id), as = id } = {}) {
  const input = { action: 'seal', ...who(id), sid: sidOf(id, as), checkpoint, cut: { rev } }
  return call(storage, { ...input, ...(as ? { proof: await proofOf(devices[as], input) } : {}), copy })
}
const cp = n => n.toString(16).padStart(32, '0')
const thumbOf = key => shaHex(Buffer.from(key, 'base64url'))
/** A holder row as `move` writes it, for a seeded state; the lease row beside it carries the marker (same transaction). */
const holderRow = (id, generation, extra = {}) => ({ v: 1, generation, body: { clientId: id, label: labelOf(id), key: devices[id].key, thumb: thumbOf(devices[id].key),
  checkpoint: null, sealed: false, since: T0 - 20 }, reservation: null, done: [], top: null, ...extra })
const MARKED = { leaseId: null, generation: 0, holder: null, acquiredAt: null, seenAt: T0 - 30, expiresAt: T0 - 30, asked: null, onehome: true }

/** A real thread append under a real lease (the thread log's own op, judged by the real checkLease). */
async function append(storage, ref, text, path = PATH, mode = 'observe') {
  const id = await threadIdForPath(path)
  return storage.transaction(async tx => {
    const t = await tx.get(`thread:v1:index:${id}`)
    const at = t ? t.bytes : 0
    const have = t ? `${t.chain}.${t.tailSha}` : `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`
    const body = encoder.encode(text)
    return threadCommit(tx, 'append', { lease: ref, id, path, at, have, bodySha: shaHex(body), body: bytesToBase64(body) },
      { checkLease: (t2, r) => checkLease(t2, r, clock.now, { mode }), budget: { charge: async () => ({ ok: true }) }, now: clock.now })
  })
}
const refOf = grant => ({ leaseId: grant.body.lease.leaseId, generation: grant.body.lease.generation })

/** Every answer must hold no client id, no key, no `conflictCode`, and a lease id only inside a grant. */
function assertClean(body, label = '') {
  const text = JSON.stringify(body)
  for (const id of CLIENTS) assert.ok(!text.includes(id), `${label}: an answer names a client id: ${text}`)
  for (const device of [...Object.values(devices), stranger]) assert.ok(!text.includes(device.key), `${label}: an answer names a key`)
  assert.ok(!text.includes('conflictCode'), `${label}: conflictCode in ${text}`)
  const leaseIds = text.match(/"leaseId"/g)?.length ?? 0
  assert.ok(leaseIds === 0 || (body.ok === true && body.lease?.leaseId && leaseIds === 1), `${label}: a lease id outside a grant: ${text}`)
}

/** A seeded generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)]

// ── Rule 1 and SHOULD 1: inert, operation for operation. ──────────────────────────────────────────────────────

/** world-lease.mjs and its imports as they are at BASE, in a folder of their own (TMPDIR). */
async function loadBase(t) {
  try { execFileSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', BASE, 'HEAD'], { stdio: 'ignore' }) }
  catch { throw new Error(`world-holder: ${BASE} is not an ancestor of HEAD in ${REPO}`) }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'holder-base-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const file of ['world-lease.mjs', 'world-home.mjs', 'mirror-slot-tombstone.mjs']) {
    await writeFile(path.join(dir, file), execFileSync('git', ['-C', REPO, 'show', `${BASE}:deploy/cloudflare/src/${file}`]))
  }
  return { lease: await import(pathToFileURL(path.join(dir, 'world-lease.mjs')).href), home: await import(pathToFileURL(path.join(dir, 'world-home.mjs')).href) }
}

/** Fixed random bytes for a lease id, the same on both sides of a comparison (key making happens before this). */
function withSeededRandom(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'getRandomValues')
  let next = rng(1)
  Object.defineProperty(globalThis.crypto, 'getRandomValues', { configurable: true, writable: true, value: array => { for (let i = 0; i < array.length; i++) array[i] = Math.floor(next() * 256); return array } })
  t.after(() => { if (original) Object.defineProperty(globalThis.crypto, 'getRandomValues', original); else delete globalThis.crypto.getRandomValues })
  return seed => { next = rng(seed) }
}

test('rule 1 + SHOULD 1 (+ SHOULD 2, sid; job 4 R1e: started as MIRROR starts it, one read): with no holder ever claimed, 3,000 random lease calls (some with the Worker\'s sid, some over a malformed lease row) make the same storage operations, answers and storage as be552705', async t => {
  const base = await loadBase(t)
  const reseed = withSeededRandom(t)
  const rand = rng(7)
  const counted = { status: 0, acquire: 0, take: 0, index: 0 }
  for (let run = 0; run < 20; run++) {
    const initial = rand() < 0.4 ? { [PENDING]: rand() < 0.8 ? { rescue: cp(9), clientId: pick(rand, CLIENTS), since: T0 - 5, verifiedAt: T0 - 5 } : 'garbage' } : {}
    // SHOULD 2: a malformed lease row with no holder row (and no marker) costs exactly main's operations too.
    if (run % 7 === 3) initial[LEASE] = [{ garbage: true }, 'x', { leaseId: 'bad', generation: -1, holder: null }][(run - 3) / 7]
    const oldOps = [], newOps = []
    const oldStore = createRollbackStorage(initial, { record: oldOps })
    const newStore = createRollbackStorage(initial, { record: newOps })
    // job 4 (R1e): the joined side is started as mirror-do.mjs starts its object; the start-up is counted here, and
    // it is the ONE operation an unclaimed world pays more than main: one get of the holder row, nothing per request.
    await holderStartUp(newStore)
    assert.deepEqual(newOps, [`get ${WORLD_HOLDER}`], 'the start-up: one read')
    newOps.length = 0
    let now = T0
    const leaseIds = [cp(1)]
    for (let step = 0; step < 150; step++) {
      now += pick(rand, [0, 1000, 20000, 95000])
      const id = pick(rand, CLIENTS)
      const action = pick(rand, ['status', 'acquire', 'acquire', 'renew', 'ask', 'release', 'take', 'resurrect'])
      const input = { action, clientId: id, tabId: pick(rand, ['t1', 't2']), label: pick(rand, ['', 'A laptop', 'B phone']) }
      if (['renew', 'release'].includes(action) || rand() < 0.1) input.leaseId = pick(rand, leaseIds)
      const options = { now, ownerApproved: rand() < 0.5, homeFreeze: rand() < 0.5 ? 'enforce' : undefined }
      const seed = Math.floor(rand() * 1e9)
      // job 3: the Worker puts the session's public id on the status and on any proven request; main has none.
      const sidded = SESSION_ACTIONS.has(action) && rand() < 0.5 ? { ...input, sid: SID[id] } : input
      oldOps.length = 0; newOps.length = 0
      reseed(seed)
      const before = await base.lease.leaseAction(oldStore, structuredClone(input), options)
      reseed(seed)
      const after = await leaseAction(newStore, structuredClone(sidded), options)
      const label = `run ${run} step ${step} ${JSON.stringify(input)}`
      assert.equal(JSON.stringify(after), JSON.stringify(before), label)
      assert.deepEqual(newOps, oldOps, `the storage operations of ${label}`)
      if (action in counted) counted[action]++
      if (after.body.lease?.leaseId) leaseIds.push(after.body.lease.leaseId)
      assert.equal(JSON.stringify(newStore.snapshot()), JSON.stringify(oldStore.snapshot()), `storage after ${label}`)
    }
    // The thread index, as mirror-do.mjs reads it: leaseSummary, then worldStatus, in one transaction.
    for (const freeze of [undefined, 'enforce']) {
      oldOps.length = 0; newOps.length = 0
      const was = await oldStore.transaction(async tx => base.home.worldStatus(tx, { lease: await base.lease.leaseSummary(tx, now), freeze }))
      const is = await newStore.transaction(async tx => worldStatus(tx, { lease: await leaseSummary(tx, now), freeze }))
      assert.equal(JSON.stringify(is), JSON.stringify(was))
      assert.deepEqual(newOps, oldOps, 'the index reads exactly what be552705 reads')
      assert.deepEqual(Object.keys(is.home), ['pending', 'rescue', 'freeze'])
      counted.index++
    }
  }
  for (const [name, n] of Object.entries(counted)) assert.ok(n >= 40, `${name} compared ${n} times`)
  // A MARKED malformed lease row beside a holder row is never taken as "no holder": the index still reads the holder row.
  const ops = []
  const marked = createRollbackStorage({ [LEASE]: { garbage: true, onehome: true }, [WORLD_HOLDER]: holderRow(A, 2) }, { record: ops })
  const index = await marked.transaction(async tx => worldStatus(tx, { lease: await leaseSummary(tx, T0), freeze: undefined }))
  assert.ok(ops.includes(`get ${WORLD_HOLDER}`), ops.join('; '))
  assert.deepEqual(index.home.holder, { label: 'Chrome on the Mac', generation: 2, since: T0 - 20 })
})

test('rule 1: the literal bodies world-lease.test.mjs pins are unchanged; a new key on an old action is still 400; a proof with no holder is ignored', async () => {
  const storage = fresh()
  assert.deepEqual((await lease(storage, 'status', B)).body, { ok: true, lease: null })
  assert.deepEqual((await lease(storage, 'ask', B)).body, { ok: true, free: true })
  const a = await lease(storage, 'acquire', A)
  assert.deepEqual(Object.keys(a.body.lease), ['leaseId', 'generation', 'expiresAt'])
  assert.deepEqual([a.status, a.body.lease.generation, a.body.lease.expiresAt], [200, 1, T0 + WORLD_LEASE.ttlMs])
  const renewed = await lease(storage, 'renew', A, { leaseId: a.body.lease.leaseId })
  assert.deepEqual(renewed.body, { ok: true, lease: { leaseId: a.body.lease.leaseId, generation: 1, expiresAt: T0 + WORLD_LEASE.ttlMs }, asked: null })
  assert.deepEqual((await lease(storage, 'ask', B)).body, { ok: true, asked: true, holder: { label: 'Chrome on the Mac', since: T0, seenAt: T0 } })
  assert.deepEqual((await lease(storage, 'status', B)).body, { ok: true, lease: { label: 'Chrome on the Mac', since: T0, seenAt: T0, live: true, asked: { label: 'Firefox', at: T0 } } })
  assert.deepEqual((await lease(storage, 'take', B)).body, { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.deepEqual((await lease(storage, 'release', B, { leaseId: a.body.lease.leaseId })).body, { ok: true, released: false })
  assert.deepEqual((await lease(storage, 'release', A, { leaseId: a.body.lease.leaseId })).body, { ok: true, released: true })
  assert.deepEqual((await lease(storage, 'status', B)).body, { ok: true, lease: null })
  const taken = await lease(storage, 'take', B, {}, { approved: true })
  assert.deepEqual([taken.status, taken.body.lease.generation], [200, 2])
  assert.equal(await storage.get(WORLD_HOLDER), undefined)
  assert.equal(await storage.get(WORLD_SEALED), undefined)
  assert.equal((await storage.get(LEASE)).onehome, undefined, 'no marker before a holder row')
  const home = await storage.transaction(tx => homeSummary(tx, undefined))
  assert.deepEqual(home, { pending: false, rescue: null, freeze: 'record' })
  for (const extra of [{ expect: 0 }, { log: 'a'.repeat(64) }, { accept: [] }, { copy: copyOf(A) }, { checkpoint: null }, { key: devices[A].key }, { cut: { rev: 1 } }, { until: T0 }, { proof: { ts: T0, sig: 'x' } }]) {
    assert.deepEqual(await lease(storage, 'acquire', A, extra), { status: 400, body: { ok: false, code: 'LEASE_REQUEST_INVALID' } }, JSON.stringify(extra))
  }
  // With no holder row nothing asks for a proof: a well-formed one changes no answer, even a stranger's.
  const plain = fresh(), signed = fresh()
  const withoutId = got => ({ ...got, body: { ...got.body, lease: { ...got.body.lease, leaseId: typeof got.body.lease?.leaseId } } })
  assert.deepEqual(withoutId(await lease(signed, 'acquire', A, {}, { as: stranger })), withoutId(await lease(plain, 'acquire', A)))
  assert.deepEqual(await lease(signed, 'status', B, {}, { as: B }), await lease(plain, 'status', B))
  assert.deepEqual(Object.keys(signed.snapshot()), Object.keys(plain.snapshot()))
})

// ── MUST 1: her body is a KEY. ────────────────────────────────────────────────────────────────────────────────

test('MUST 1, his sequence: B reads A\'s id and asks status, acquire, seal with it: you false, 423, 423, as for any browser', async () => {
  const storage = fresh()
  assert.equal((await claim(storage, A, 0)).status, 200)
  assert.equal((await seal(storage, A, cp(1), 5)).status, 200)
  const a = await own(storage, 'acquire', A)
  assert.equal(a.status, 200)
  const start = storage.snapshot()
  // B, signed in, typed A's clientId (and A's tab name); without a proof, and with B's own key.
  for (const as of [null, B]) {
    const status = await lease(storage, 'status', A, {}, { as })
    assert.equal(status.body.holder.you, false)
    assert.ok(status.body.sealed.every(entry => entry.yours === false), 'no sealed entry is "yours" without the key')
    const acquired = await lease(storage, 'acquire', A, {}, { as })
    const sealed = await seal(storage, A, cp(1), 6, { as })
    const sealedNew = await seal(storage, A, cp(2), 6, { as })
    const asOther = await lease(storage, 'acquire', C, {}, { as: C })
    const holderShown = { label: 'Chrome on the Mac', since: T0, generation: 1 }
    for (const got of [acquired, sealed, sealedNew, asOther]) assert.deepEqual(got, { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown } })
    for (const action of ['renew', 'release']) {
      assert.deepEqual(await lease(storage, action, A, { leaseId: a.body.lease.leaseId }, { as }), asOther, `${action} with A's id is answered as any browser`)
    }
    assert.deepEqual(await lease(storage, 'take', A, {}, { as, approved: true }), asOther)
    assert.deepEqual(storage.snapshot(), start, 'nothing written')
  }
  // Her body itself: you true, its own entries yours; its renew and release work.
  const mine = await own(storage, 'status', A)
  assert.equal(mine.body.holder.you, true)
  assert.deepEqual(mine.body.sealed.map(entry => entry.yours), [true])
  assert.equal((await own(storage, 'renew', A, { leaseId: a.body.lease.leaseId })).status, 200)
  assert.deepEqual((await own(storage, 'release', A, { leaseId: a.body.lease.leaseId })).body, { ok: true, released: true })
  assertClean(mine.body)
})

test('MUST 1: a stale ts, a proof for another action, another tab\'s proof on a different body, a tampered or foreign signature: refused; her own valid proof: accepted', async () => {
  const storage = fresh()
  assert.equal((await claim(storage, A, 0)).status, 200)
  const elsewhere = { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: { label: 'Chrome on the Mac', since: T0, generation: 1 } } }
  const input = { action: 'acquire', ...who(A), sid: SID[A] }
  for (const skew of [-120001, 120001]) {
    assert.deepEqual(await call(storage, { ...input, proof: await proofOf(devices[A], input, clock.now + skew) }), elsewhere, `ts ${skew}`)
  }
  const statusProof = await proofOf(devices[A], { action: 'status', ...who(A), sid: SID[A] })
  assert.deepEqual(await call(storage, { ...input, proof: statusProof }), elsewhere, 'a status proof used for acquire')
  const tabProof = await proofOf(devices[A], input)
  assert.deepEqual(await call(storage, { ...input, tabId: 'tab-other', proof: tabProof }), elsewhere, 'another tab replays it')
  assert.deepEqual(await call(storage, { ...input, label: 'Firefox', proof: tabProof }), elsewhere, 'a different body')
  const flipped = { ...tabProof, sig: (tabProof.sig[0] === 'A' ? 'B' : 'A') + tabProof.sig.slice(1) }
  assert.deepEqual(await call(storage, { ...input, proof: flipped }), elsewhere, 'a tampered signature')
  assert.deepEqual(await call(storage, { ...input, proof: await proofOf(stranger, input) }), elsewhere, 'a key that is not hers')
  // The edge of the window is accepted; then her proof now (a later ts).
  assert.equal((await call(storage, { ...input, proof: await proofOf(devices[A], input, clock.now - 120000) })).status, 200)
  const granted = await call(storage, { ...input, proof: tabProof })
  assert.equal(granted.status, 200)
  // job 3: the same proof from another session (B sends A's signed body unchanged): refused as no proof.
  assert.deepEqual(await call(storage, { ...input, sid: SID[B], proof: await proofOf(devices[A], input) }), elsewhere, 'another session')
})

test('MUST 1 + job 3 MUST 2: the three version-2 proof vectors for lanes BRING and SYNC (P-256, SHA-256, P1363, base64url, the session named) verify, and nothing else does', async () => {
  const key = 'BJ4GIuc7ReR-jCtBpdyLm0aBupWtCdXT3j3cXuMsnQWsj3hu8A2sK2YzoiUdlV9WdDXAAWwBls72rs4zGjgaNWw'
  const ts = 1800000000000
  const sid = 'feedfacecafebeef0011223344556677'
  const vectors = [
    [{ action: 'status', clientId: A, tabId: 'tab-a', label: 'Chrome on the Mac', sid },
      `aukora-x6-holder-proof/2\n1800000000000\n${sid}\n{"action":"status","clientId":"${A}","label":"Chrome on the Mac","tabId":"tab-a"}`,
      'NnbureU-y8rfx5yz2BLwwhe_b09ZeAQJIPjgX_Y8_HYqvnhnC9fYwtCY4jmc0IsiDTuA58pT-owNsAJaALoMTQ'],
    [{ action: 'acquire', clientId: A, tabId: 'tab-a', label: 'Chrome on the Mac', sid },
      `aukora-x6-holder-proof/2\n1800000000000\n${sid}\n{"action":"acquire","clientId":"${A}","label":"Chrome on the Mac","tabId":"tab-a"}`,
      '8OQcr0UxcvAvrGHUb_RBGWGjpjlRKKnm_K15jnljQ-a4CqXVK7yvKx7XfgJuX31oKSCVcIMTcQsnYkAh8Osk5g'],
    [{ action: 'seal', clientId: A, tabId: 'tab-a', label: 'Chrome on the Mac', checkpoint: '0123456789abcdef0123456789abcdef', cut: { rev: 2183 }, sid },
      `aukora-x6-holder-proof/2\n1800000000000\n${sid}\n{"action":"seal","checkpoint":"0123456789abcdef0123456789abcdef","clientId":"${A}","cut":{"rev":2183},"label":"Chrome on the Mac","tabId":"tab-a"}`,
      'jz3Pm39zXfhKzMjy91LeUlDVycOHxhxo1luX14OX7ubbCz7m7YP6bQpUpFXSpSSryJWedW-8E-KjAFrnmvqx_w'],
  ]
  for (const [input, message, sig] of vectors) {
    assert.equal(holderProofMessage(input, ts), message)
    // The proof's own field and the Worker's words never enter the JSON part; key order never matters.
    assert.equal(holderProofMessage({ copy: copyOf(A), proof: { ts, sig }, ...Object.fromEntries(Object.entries(input).reverse()) }, ts), message)
    assert.equal(await holderProofValid(key, input, { ts, sig }, ts), true)
    assert.equal(await holderProofValid(key, input, { ts, sig }, ts + 120000), true)
    assert.equal(await holderProofValid(key, input, { ts, sig }, ts + 120001), false, 'stale')
    assert.equal(await holderProofValid(key, input, { ts: ts + 1, sig }, ts), false, 'another ts')
    assert.equal(await holderProofValid(key, { ...input, tabId: 'tab-b' }, { ts, sig }, ts), false, 'another tab')
    assert.equal(await holderProofValid(key, { ...input, sid: 'feedfacecafebeef0011223344556678' }, { ts, sig }, ts), false, 'another session')
    const { sid: _sid, ...sessionless } = input
    assert.equal(await holderProofValid(key, sessionless, { ts, sig }, ts), false, 'no session: no proof can verify')
    assert.equal(await holderProofValid(stranger.key, input, { ts, sig }, ts), false, 'another key')
  }
  for (const bad of ['', key.slice(1), `${key.slice(0, -1)}5`, `A${key.slice(1)}`, 'x'.repeat(87)]) assert.equal(holder.holderKeyValid(bad), false, bad)
  assert.equal(holder.holderKeyValid(key), true)
})

// ── MUST 2: reserve, approve, commit. ─────────────────────────────────────────────────────────────────────────

test('MUST 2: reserve refuses (no approval asked) on a missing or bad key proof; answers the exact descriptor; move without the passkey is 403 and writes nothing', async () => {
  const storage = fresh()
  const log = await markOf(storage)
  const input = { action: 'reserve', ...who(B), sid: SID[B], expect: 0, checkpoint: null, log, accept: [], key: devices[B].key }
  assert.equal((await call(storage, input)).status, 400, 'no proof')
  assert.equal((await call(storage, { ...input, key: undefined, proof: await proofOf(devices[B], input) })).status, 400, 'no key')
  assert.deepEqual(await call(storage, { ...input, proof: await proofOf(stranger, input) }), { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: T0, sid: SID[B] } })
  assert.deepEqual(await call(storage, { ...input, proof: await proofOf(devices[B], input, clock.now - 120001) }), { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: T0, sid: SID[B] } })
  // job 3: B's own signed reserve sent from another session verifies as no proof.
  assert.deepEqual(await call(storage, { ...input, sid: SID[C], proof: await proofOf(devices[B], input) }), { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: T0, sid: SID[C] } })
  assert.deepEqual(storage.snapshot(), {})
  const reserved = await reserve(storage, B, { expect: 0 })
  assert.equal(reserved.status, 200)
  const until = T0 + 90000
  const descriptor = { action: 'move', ...who(B), expect: 0, checkpoint: null, log, accept: [], key: devices[B].key, copy: null, until }
  assert.deepEqual(reserved.body, { ok: true, reserved: true, descriptor, descriptorHash: shaHex(holder.canonicalJson(descriptor)), until })
  const held = storage.snapshot()
  assert.deepEqual(await commit(storage, descriptor, false), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
  assert.deepEqual(storage.snapshot(), held)
  // A descriptor nobody reserved: 409, unapproved or approved.
  for (const changed of [{ ...descriptor, label: 'Safari' }, { ...descriptor, until: until + 1 }, { ...descriptor, accept: ['not-newest'] }]) {
    assert.deepEqual(await commit(storage, changed, false), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } })
  }
  assert.deepEqual(storage.snapshot(), held)
  const moved = await commit(storage, descriptor)
  assert.deepEqual(moved, { status: 200, body: { ok: true, holder: { label: 'Firefox', generation: 1, since: T0, checkpoint: null, sealed: false, you: true } } })
  const row = await storage.get(WORLD_HOLDER)
  assert.deepEqual(row.body, { clientId: B, label: 'Firefox', key: devices[B].key, thumb: thumbOf(devices[B].key), checkpoint: null, sealed: false, since: T0 })
  assert.deepEqual([row.reservation, row.done], [null, [{ descriptorHash: reserved.body.descriptorHash, generation: 1 }]])
  // A repeat of the same move after it applied: 200 already, unapproved or approved; nothing written.
  const after = storage.snapshot()
  for (const approved of [false, true]) assert.deepEqual(await commit(storage, descriptor, approved), { status: 200, body: { ok: true, already: true, moved: true, generation: 1 } })
  assert.deepEqual(storage.snapshot(), after)
})

test('MUST 2: during a reservation no lease is granted, no thread commit lands, no seal and no other reserve; after it lapses they succeed', async () => {
  // First claim (no body yet): A works under a lease.
  const storage = fresh()
  const a = await lease(storage, 'acquire', A)
  assert.equal((await append(storage, refOf(a), '{"t":1}\n')).status, 200)
  const r = await reserve(storage, B, { expect: 0 })
  assert.equal(r.status, 200)
  assert.deepEqual((await lease(storage, 'acquire', A)).body, { ok: false, code: 'MOVE_RESERVED', age: 0 })
  tick(1000)
  for (const id of CLIENTS) assert.deepEqual(await own(storage, 'acquire', id), { status: 423, body: { ok: false, code: 'MOVE_RESERVED', age: 1000 } })
  assert.deepEqual((await own(storage, 'take', A, {}, { approved: true })).body.code, 'MOVE_RESERVED')
  assert.deepEqual((await lease(storage, 'renew', A, { leaseId: a.body.lease.leaseId })).body, { ok: false, code: 'WRITER_GONE' })
  const appended = await append(storage, refOf(a), '{"t":2}\n')
  assert.equal(appended.status, 410, JSON.stringify(appended))
  const other = await reserve(storage, C, { expect: 0 })
  assert.deepEqual(other, { status: 409, body: { ok: false, code: 'MOVE_RESERVED', age: 1000 } })
  assert.equal((await lease(storage, 'status', C)).body.reserved.until, T0 + 90000)
  // Review: the blocked preview still names what a reserve must carry.
  assert.deepEqual((await preview(storage, C, null)).body.move, { refused: 'MOVE_RESERVED', expect: 0, needs: [], log: await markOf(storage) })
  // It lapses: with no body, main's answers come back; the log moves again.
  tick(89001)
  const again = await lease(storage, 'acquire', A)
  assert.equal(again.status, 200)
  assert.equal((await append(storage, refOf(again), '{"t":3}\n')).status, 200)
  // The lapsed reservation's own descriptor is never committed, approved or not.
  assert.deepEqual(await commit(storage, r.body.descriptor), { status: 409, body: { ok: false, code: 'MOVE_APPROVAL_SPENT', moved: false, next: 'reserve and approve again' } })
  // With a body: her own seal waits for the reservation, then works.
  assert.equal((await claim(storage, A, 0)).status, 200)
  const r2 = await reserve(storage, B, { expect: 1, accept: ['not-newest'] })
  assert.equal(r2.status, 200)
  assert.equal((await seal(storage, A, cp(4), 1)).body.code, 'MOVE_RESERVED')
  assert.equal((await own(storage, 'acquire', A)).body.code, 'MOVE_RESERVED')
  tick(90001)
  assert.equal((await seal(storage, A, cp(4), 1)).status, 200)
  const back = await own(storage, 'acquire', A)
  assert.equal(back.status, 200)
  assert.equal((await append(storage, refOf(back), '{"t":4}\n')).status, 200)
})

test('MUST 2, controlled overlaps: two reserves racing, reserve against acquire, move against move (same and different descriptors)', async () => {
  for (let round = 0; round < 10; round++) {
    const storage = fresh()
    const log = await markOf(storage)
    const [one, two] = await Promise.all([reserve(storage, A, { expect: 0, log }), reserve(storage, B, { expect: 0, log })])
    assert.deepEqual([one.status, two.status].sort(), [200, 409])
    const loser = one.status === 409 ? one : two
    assert.deepEqual(loser.body, { ok: false, code: 'MOVE_RESERVED', age: 0 })
    const winner = one.status === 200 ? one : two
    // The same move twice at once: one commits, the other is `already`; never two generations.
    const both = await Promise.all([commit(storage, winner.body.descriptor), commit(storage, winner.body.descriptor)])
    assert.deepEqual(both.map(got => got.body.already === true).sort(), [false, true])
    assert.equal((await storage.get(WORLD_HOLDER)).generation, 1)
    // Reserve against acquire: whichever lands first, no lease is live while the reservation lives.
    const body = winner === one ? A : B
    const target = body === A ? B : A
    const order = round % 2 === 0
    const raced = order
      ? await Promise.all([own(storage, 'acquire', body), reserve(storage, target, { expect: 1, accept: ['not-newest'], log })])
      : (await Promise.all([reserve(storage, target, { expect: 1, accept: ['not-newest'], log }), own(storage, 'acquire', body)])).reverse()
    const [acquired, reserved] = raced
    assert.equal(reserved.status, 200)
    const row = await storage.get(LEASE)
    assert.ok(!(row.holder && row.expiresAt > clock.now), `a live lease during a reservation: ${JSON.stringify(row)} after ${acquired.status}`)
    if (acquired.status === 200) assert.equal((await append(storage, refOf(acquired), '{"x":1}\n')).status, 410)
    else assert.equal(acquired.body.code, 'MOVE_RESERVED')
    // A different descriptor racing the reserved one: only the reserved one commits.
    const forged = { ...reserved.body.descriptor, label: 'Elsewhere' }
    const pair = await Promise.all([commit(storage, forged), commit(storage, reserved.body.descriptor)])
    assert.deepEqual(pair.map(got => got.status), [409, 200])
    assert.equal(pair[0].body.code, 'MOVE_APPROVAL_SPENT')
    assert.equal((await storage.get(WORLD_HOLDER)).body.clientId, target)
  }
})

test('review: a reserve that lapses unapproved makes the next one wait, doubling to at most 1 h; her body acquires and writes in every wait; a commit starts again', async () => {
  const storage = fresh()
  assert.equal((await claim(storage, A, 0)).status, 200)
  const waits = []
  let r
  for (let round = 0; round < 9; round++) {
    r = await reserve(storage, B, { expect: 1, accept: ['not-newest'] })
    if (r.status === 409) {
      assert.equal(r.body.code, 'MOVE_RESERVED', JSON.stringify(r.body))
      waits.push(r.body.wait)
      // While B waits: her body acquires and writes; the preview says so; any other reserve (hers too) waits as well.
      const mine = await own(storage, 'acquire', A)
      assert.equal(mine.status, 200, JSON.stringify(mine.body))
      assert.equal((await append(storage, refOf(mine), `{"r":${round}}\n`)).status, 200)
      assert.deepEqual((await preview(storage, B, null)).body.move, { refused: 'MOVE_RESERVED', wait: r.body.wait, expect: 1, needs: ['not-newest'], log: await markOf(storage) })
      assert.equal((await reserve(storage, A, { expect: 1 })).body.code, 'MOVE_RESERVED')
      tick(r.body.wait)
      r = await reserve(storage, B, { expect: 1, accept: ['not-newest'] })
    } else waits.push(0)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    if (round < 8) tick(90000)
  }
  assert.deepEqual(waits, [0, 0, 90000, 180000, 360000, 720000, 1440000, 2880000, 3600000])
  // A commit sets the count back: the next reservation's lapse costs nothing.
  assert.equal((await commit(storage, r.body.descriptor)).status, 200)
  assert.equal((await reserve(storage, A, { expect: 2, accept: ['not-newest'] })).status, 200)
  tick(90000)
  assert.equal((await reserve(storage, A, { expect: 2, accept: ['not-newest'] })).status, 200)
})

test('review: the edge clock is in every status of a marked world and in KEY_PROOF_INVALID; her body with a clock 3 minutes off signs again with it', async () => {
  const storage = fresh()
  assert.equal((await claim(storage, A, 0)).status, 200)
  const off = clock.now + 180000
  const skewed = async (action, ts) => {
    const input = { action, ...who(A), sid: SID[A] }
    return call(storage, { ...input, proof: await proofOf(devices[A], input, ts) })
  }
  assert.equal((await skewed('acquire', off)).status, 423)
  const seen = await skewed('status', off)
  assert.deepEqual([seen.body.holder.you, seen.body.now], [false, clock.now])
  const input = { action: 'reserve', ...who(B), sid: SID[B], expect: 1, checkpoint: null, log: await markOf(storage), accept: ['not-newest'], key: devices[B].key }
  assert.deepEqual(await call(storage, { ...input, proof: await proofOf(devices[B], input, off) }), { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: clock.now, sid: SID[B] } })
  tick(5000)
  // Its own clock read `off` when the status answered; 5 s later it reads off + 5000. It keeps the offset and signs with it.
  const offset = seen.body.now - off
  assert.equal((await skewed('acquire', off + 5000)).status, 423, 'its own clock is still refused')
  assert.equal((await skewed('acquire', off + 5000 + offset)).status, 200)
  // A world never claimed: status is main's, no clock added.
  assert.deepEqual((await lease(fresh(), 'status', B)).body, { ok: true, lease: null })
})

// ── MUST 3: an older cut never becomes the newest seal. ──────────────────────────────────────────────────────

test('MUST 3, his sequence: C1, C2, seal C2, seal C1 is 409 SEAL_OLDER_THAN_NEWEST; newest is by (generation, rev); an evicted seal never comes back', async () => {
  const storage = fresh()
  assert.equal((await claim(storage, A, 0)).status, 200)
  const C1 = cp(1), C2 = cp(2)
  assert.deepEqual(await seal(storage, A, C2, 20), { status: 200, body: { ok: true, sealed: true, already: false } })
  const sealedC2 = storage.snapshot()
  assert.deepEqual(await seal(storage, A, C1, 10), { status: 409, body: { ok: false, code: 'SEAL_OLDER_THAN_NEWEST', rev: 10, newest: 20 } })
  assert.deepEqual(storage.snapshot(), sealedC2)
  assert.deepEqual((await preview(storage, B, C1, copyOf(A))).body.move.needs, ['not-newest', 'unsealed'])
  assert.deepEqual((await preview(storage, B, C2, copyOf(A))).body.move.needs, [])
  assert.equal((await move(storage, B, { expect: 1, checkpoint: C1, copy: copyOf(A), accept: [] })).body.code, 'MOVE_NEEDS')
  // The same rev (one cut, sealed twice) is not older.
  assert.equal((await seal(storage, A, cp(3), 20)).status, 200)
  // Eight newer seals push C2 out; sealing it again is refused, so it never comes back as newest.
  for (let n = 0; n < 8; n++) assert.equal((await seal(storage, A, cp(10 + n), 30 + n)).status, 200)
  assert.ok(!(await storage.get(WORLD_SEALED)).some(entry => entry.checkpoint === C2))
  assert.deepEqual((await seal(storage, A, C2, 20)).body, { ok: false, code: 'SEAL_OLDER_THAN_NEWEST', rev: 20, newest: 37 })
  // Newest is by (generation, rev), never by the order of seal calls.
  const list = [{ checkpoint: C1, generation: 2, rev: 3 }, { checkpoint: C2, generation: 1, rev: 50 }]
  assert.deepEqual(needsList({ holder: null, sealed: list, pending: null, checkpoint: C1, maker: A }), [])
  assert.deepEqual(needsList({ holder: null, sealed: list, pending: null, checkpoint: C2, maker: A }), ['not-newest'])
  const seeded = fresh({ [LEASE]: MARKED, [WORLD_HOLDER]: holderRow(A, 2, { top: { generation: 2, rev: 3 } }),
    [WORLD_SEALED]: list.map(entry => ({ ...entry, clientId: A, label: 'x', at: T0 - 9 })).reverse() })
  assert.deepEqual((await preview(seeded, B, C1, copyOf(A))).body.move.needs, [])
  assert.deepEqual((await preview(seeded, B, C2, copyOf(A))).body.move.needs, ['not-newest'])
  // A new generation starts its own line of cuts: after a move and a claim back, a lower rev of the new store seals.
  assert.equal((await move(storage, B, { expect: 1, checkpoint: cp(17), copy: copyOf(A), accept: [] })).status, 200)
  assert.equal((await claim(storage, A, 2, ['not-newest'])).status, 200)
  assert.equal((await seal(storage, A, cp(40), 1)).status, 200)
  assert.deepEqual((await preview(storage, B, cp(40), copyOf(A))).body.move.needs, [])
})

// ── MUST 4: the old settings cannot lock her out once a holder exists. ───────────────────────────────────────

test('MUST 4: HOME_FREEZE=enforce and WRITER_LEASE=enforce: after a move the new body acquires and writes; nobody else does', async () => {
  const storage = fresh({ [PENDING]: { rescue: cp(9), clientId: A, since: T0 - 5, verifiedAt: T0 - 5 } })
  const enforce = { homeFreeze: 'enforce' }
  assert.deepEqual((await preview(storage, A, null)).body.move.needs, [])
  assert.equal((await claim(storage, A, 0)).status, 200)
  assert.equal((await own(storage, 'acquire', A, {}, enforce)).status, 200)
  assert.equal((await seal(storage, A, cp(1), 3)).status, 200)
  assert.equal((await move(storage, B, { expect: 1, checkpoint: cp(1), copy: copyOf(A), accept: [] })).status, 200)
  const b = await own(storage, 'acquire', B, {}, enforce)
  assert.equal(b.status, 200, JSON.stringify(b.body))
  assert.equal((await append(storage, refOf(b), '{"b":1}\n', PATH, 'enforce')).status, 200)
  for (const [id, as] of [[A, A], [C, C], [B, null], [B, C]]) {
    const got = await lease(storage, 'acquire', id, {}, { ...enforce, as })
    assert.equal(got.body.code, 'HOLDER_ELSEWHERE', `${id} as ${as}`)
    assert.equal((await lease(storage, 'take', id, {}, { ...enforce, as, approved: true })).body.code, 'HOLDER_ELSEWHERE')
  }
  // The pending guard still judges with no body (main's answer before any claim).
  const before = fresh({ [PENDING]: { rescue: cp(9), clientId: A, since: T0 - 5, verifiedAt: T0 - 5 } })
  assert.equal((await lease(before, 'acquire', B, {}, enforce)).body.code, 'HOME_PENDING')
  // A stale live lease of another browser never refuses her proven body.
  const stale = fresh({ [WORLD_HOLDER]: holderRow(B, 3), [LEASE]: { leaseId: cp(5), generation: 4, holder: { clientId: C, tabId: 'tab-c', label: 'Safari' }, acquiredAt: T0, seenAt: T0, expiresAt: T0 + 90000, asked: null, onehome: true } })
  assert.equal((await own(stale, 'acquire', B, {}, enforce)).status, 200)
})

test('MUST 4 (his SHOULD 3): with MIRROR_SLOT_RETIRE=retire and a full client table, slot retirement never retires her body or a reserved target', async () => {
  const DAY = 86400000
  const idOf = i => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const LINEAGE = '12345678-1234-4234-8234-123456789abc'
  // A full table: 256 browsers, each with one old acknowledged save; B is the oldest (the one retirement would choose).
  const ids = [B, ...Array.from({ length: 255 }, (_, i) => idOf(i + 1))]
  const clients = new Map(ids.map(id => [id, { seq: 1, digest: shaHex(id) }]))
  const ordered = ids.map((id, i) => [`mirror:v2:receipt:${id}:1`, { ok: true, clientId: id, seq: 1, id: `${id}:1`, digest: shaHex(id), lineageId: LINEAGE, revision: i + 1, acknowledgedAt: T0 - 400 * DAY + i }])
  const replay = { clients, receipts: new Map(ordered), ordered }
  const retire = storage => storage.transaction(tx => retireClientSlot(tx, replay, { incomingClientId: C, now: T0 }))
  // Without a holder row the oldest idle browser, B, is retired (main's rule).
  assert.equal((await retire(fresh())).retired, B)
  // B is her body: spared; the next oldest goes.
  const body = fresh({ [LEASE]: MARKED, [WORLD_HOLDER]: holderRow(B, 2) })
  assert.equal((await retire(body)).retired, idOf(1))
  // B is the target of a live reservation (no body yet): spared too.
  const target = fresh()
  assert.equal((await reserve(target, B, { expect: 0 })).status, 200)
  assert.equal((await retire(target)).retired, idOf(1))
  // An unreadable holder row retires nothing (the caller keeps 507).
  const broken = fresh({ [LEASE]: MARKED, [WORLD_HOLDER]: { v: 1 } })
  assert.equal(await retire(broken), null)
  // After the move B, never retired, acquires.
  assert.equal((await own(body, 'acquire', B)).status, 200)
})

// ── MUST 5: the log mark covers every thread the edge accepts. ───────────────────────────────────────────────

test('MUST 5: at an accepted THREAD_MAX of 12,801 distinct threads (and at the default), the mark covers them all; preview and move work', async () => {
  const z = '0'.repeat(64)
  for (const count of [THREAD_LIMITS.threads, 12801]) {
    const rows = {}
    const summaries = []
    for (let i = 0; i < count; i++) {
      const id = shaHex(`t${i}`)
      rows[`thread:v1:index:${id}`] = { id, path: `/p${i}`, bytes: i, lineEnd: i, partCount: 0, keptCount: 0, chain: z, tailSha: shaHex(`x${i}`), title: '', preview: '', activeAt: 0, updatedAt: 0, idle: null }
      summaries.push({ id, bytes: i, chain: z, tailSha: shaHex(`x${i}`) })
    }
    // thread-log.mjs keeps the count of every thread it admitted (and refuses one past THREAD_MAX).
    rows['thread:v1:world'] = { threads: count, tailBytes: 0 }
    const storage = fresh(rows)
    assert.ok(holder.logMarkPages(count) * holder.WORLD_HOLDER_LIMITS.indexPage >= count + holder.WORLD_HOLDER_LIMITS.indexPage)
    const expected = await logMarkOf(summaries)
    const seen = await preview(storage, A, null)
    assert.deepEqual(seen.body.move, { expect: 0, needs: [], log: expected }, `count ${count}`)
    const moved = await claim(storage, A, 0)
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
  }
  // An index longer than the count the log keeps is not trusted: unavailable, never a mark over part of it.
  const rows = { 'thread:v1:world': { threads: 1, tailBytes: 0 } }
  for (let i = 0; i < THREAD_LIMITS.threads + 401; i++) {
    const id = shaHex(`u${i}`)
    rows[`thread:v1:index:${id}`] = { id, path: `/q${i}`, bytes: 1, lineEnd: 1, partCount: 0, keptCount: 0, chain: z, tailSha: z, title: '', preview: '', activeAt: 0, updatedAt: 0, idle: null }
  }
  const short = fresh(rows)
  assert.deepEqual((await preview(short, A, null)).body.move, { refused: 'LOG_MARK_UNAVAILABLE' })
})

test('the log mark: the hash of one line per thread in id order; three vectors for lane BRING', async () => {
  const z = '0'.repeat(64), e = THREAD_EMPTY_SHA
  const one = { id: '1'.repeat(64), bytes: 8, chain: z, tailSha: 'a'.repeat(64) }
  const two = { id: 'f'.repeat(64), bytes: 2097160, chain: 'c'.repeat(64), tailSha: e }
  assert.equal(await logMarkOf([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await logMarkOf([one]), '3ea57c5cb4a49b7aa16cfe0a70fa3219fc1cd4137213cf4a36b1889a8ff0405a')
  assert.equal(await logMarkOf([two, one]), '8a11d3f963f1ef68bef47374744d0593acebe10a17b31de5ff8f59a592e0f1aa')
  assert.equal(await logMarkOf([one]), shaHex(`${'1'.repeat(64)}:8:${z}.${'a'.repeat(64)}\n`))
  assert.equal(await markOf(fresh()), shaHex(''))
})

// ── The job-1 rules, on the new wire. ─────────────────────────────────────────────────────────────────────────

test('rule 2: seal needs her body (its key), the Worker word that the copy is its own, and cut.rev; a repeat is already', async () => {
  const storage = fresh()
  const empty = storage.snapshot()
  assert.deepEqual(await seal(storage, A, cp(1), 1), { status: 409, body: { ok: false, code: 'NO_HOLDER' } })
  assert.deepEqual(storage.snapshot(), empty)
  assert.equal((await claim(storage, A, 0)).status, 200)
  const claimed = storage.snapshot()
  const refusals = [
    [await seal(storage, A, cp(1), 1, { copy: { verified: false, maker: null } }), 409, 'CHECKPOINT_NOT_VERIFIED'],
    [await seal(storage, A, cp(1), 1, { copy: copyOf(B) }), 409, 'CHECKPOINT_NOT_YOURS'],
    [await seal(storage, B, cp(1), 1, { copy: copyOf(B) }), 423, 'HOLDER_ELSEWHERE'],
    [await seal(storage, A, cp(1), 1, { as: null }), 423, 'HOLDER_ELSEWHERE'],
  ]
  for (const [got, status, code] of refusals) {
    assert.deepEqual([got.status, got.body.code], [status, code])
    assertClean(got.body, code)
    assert.deepEqual(storage.snapshot(), claimed, `${code} wrote nothing`)
  }
  const noCut = { action: 'seal', ...who(A), sid: SID[A], checkpoint: cp(1) }
  assert.equal((await call(storage, { ...noCut, proof: await proofOf(devices[A], noCut), copy: copyOf(A) })).status, 400)
  tick(5)
  assert.deepEqual(await seal(storage, A, cp(1), 7), { status: 200, body: { ok: true, sealed: true, already: false } })
  assert.deepEqual(await storage.get(WORLD_SEALED), [{ checkpoint: cp(1), clientId: A, label: 'Chrome on the Mac', at: T0 + 5, generation: 1, rev: 7 }])
  const once = storage.snapshot()
  assert.deepEqual(await seal(storage, A, cp(1), 7), { status: 200, body: { ok: true, sealed: true, already: true } })
  // job 3 (MUST 2c): nothing else is written; the holder row records that this seal's proof is used up.
  assert.deepEqual(storage.snapshot(), { ...once, [WORLD_HOLDER]: { ...once[WORLD_HOLDER], proofTs: lastTs } })
  for (let n = 2; n <= 12; n++) assert.equal((await seal(storage, A, cp(n), 7 + n)).status, 200)
  assert.deepEqual((await storage.get(WORLD_SEALED)).map(entry => entry.checkpoint), [5, 6, 7, 8, 9, 10, 11, 12].map(cp))
  assert.deepEqual(Object.keys(storage.snapshot()).sort(), [LEASE, WORLD_HOLDER, WORLD_HOLDER_LOG, WORLD_SEALED].sort())
})

test('the needs list: every combination of holder, sealed list, pending row and checkpoint or claim, each line of the definition', async () => {
  const M = A, O = B, N = C // M makes the copy, O is another browser, N asks for the copy
  const CP = cp(1), OTHER = cp(2)
  const sealedOf = { empty: [], last: [OTHER, CP], earlier: [CP, OTHER], absent: [OTHER] }
  const entry = (checkpoint, rev) => ({ checkpoint, clientId: M, label: 'Chrome on the Mac', at: T0 - 10, generation: 1, rev })
  const pendingOf = { none: undefined, maker: { rescue: cp(3), clientId: M, since: T0 - 9, verifiedAt: T0 - 9 }, other: { rescue: cp(3), clientId: O, since: T0 - 9, verifiedAt: T0 - 9 }, unreadable: { rescue: 'x' } }
  let rows = 0
  for (const holderKind of ['none', 'maker', 'other']) {
    for (const sealed of Object.keys(sealedOf)) {
      for (const pending of Object.keys(pendingOf)) {
        for (const kind of ['checkpoint', 'claim']) {
          const checkpoint = kind === 'checkpoint' ? CP : null
          const unsealed = checkpoint !== null && (sealed === 'empty' || sealed === 'absent')
          const lineA = holderKind === 'other'
          const lineB = checkpoint !== null && (sealed === 'earlier' || sealed === 'absent')
          const lineC = holderKind === 'none' && (pending === 'other' || pending === 'unreadable')
          const expected = [...(lineA || lineB || lineC ? ['not-newest'] : []), ...(unsealed ? ['unsealed'] : [])]
          const list = sealedOf[sealed].map((checkpoint, i) => entry(checkpoint, i + 1))
          const initial = {}
          if (holderKind !== 'none') Object.assign(initial, { [LEASE]: MARKED, [WORLD_HOLDER]: holderRow(holderKind === 'maker' ? M : O, 4) })
          if (sealed !== 'empty') initial[WORLD_SEALED] = list
          if (pendingOf[pending]) initial[PENDING] = pendingOf[pending]
          const label = `${holderKind}/${sealed}/${pending}/${kind}`
          const pure = needsList({ holder: initial[WORLD_HOLDER]?.body ?? null, sealed: list, checkpoint, maker: M,
            pending: pending === 'none' ? null : pending === 'unreadable' ? { unreadable: true } : { clientId: pendingOf[pending].clientId } })
          assert.deepEqual(pure, expected, label)
          const storage = fresh(initial)
          const caller = kind === 'claim' ? M : N
          // A claim by her body itself is proven by its key; anyone else's claim names another browser.
          const seen = await preview(storage, caller, checkpoint, copyOf(M), { as: kind === 'claim' ? M : null })
          assert.equal(seen.status, 200, label)
          assert.deepEqual(seen.body.move.needs, expected, label)
          assert.equal(seen.body.move.expect, holderKind === 'none' ? 0 : 4, label)
          const moved = await move(storage, caller, { expect: seen.body.move.expect, checkpoint, copy: copyOf(M), accept: expected })
          assert.equal(moved.status, 200, `${label}: ${JSON.stringify(moved.body)}`)
          rows++
        }
      }
    }
  }
  assert.equal(rows, 96)
  assert.deepEqual(HOLDER_WORDS, ['not-newest', 'unsealed'])
  // Her body's id typed by another browser (with its own key) is not her body: its claim needs not-newest.
  const impostor = fresh({ [LEASE]: MARKED, [WORLD_HOLDER]: holderRow(M, 4) })
  assert.deepEqual((await preview(impostor, M, null, undefined, { as: null })).body.move.needs, ['not-newest'])
  assert.deepEqual((await move(impostor, M, { expect: 4, device: stranger })).body, { ok: false, code: 'MOVE_NEEDS', needs: ['not-newest'] })
})

test('rule 3: reserve refuses on a stale expect, an unverified copy, a moved log, an accept one word off; a good move frees a live lease', async () => {
  const storage = fresh()
  const a = await lease(storage, 'acquire', A)
  assert.equal((await append(storage, refOf(a), '{"t":1}\n')).status, 200)
  const start = storage.snapshot()
  const log = await markOf(storage)
  assert.deepEqual(await reserve(storage, B, { expect: 1, log }), { status: 409, body: { ok: false, code: 'HOLDER_MOVED', generation: 0 } })
  assert.deepEqual(await reserve(storage, B, { expect: 0, log, checkpoint: cp(1), copy: { verified: false, maker: null }, accept: ['unsealed'] }),
    { status: 409, body: { ok: false, code: 'CHECKPOINT_NOT_VERIFIED' } })
  const seen = await preview(storage, B, null)
  assert.deepEqual(seen.body.move, { expect: 0, needs: [], log })
  tick(1000)
  assert.equal((await append(storage, refOf(a), '{"t":2}\n')).status, 200)
  const appended = storage.snapshot()
  assert.notDeepEqual(appended, start)
  assert.deepEqual(await reserve(storage, B, { expect: 0, log: seen.body.move.log }), { status: 409, body: { ok: false, code: 'LOG_MOVED' } })
  for (const accept of [[], ['not-newest', 'unsealed']]) {
    assert.deepEqual(await reserve(storage, B, { expect: 0, checkpoint: cp(1), copy: copyOf(A), accept }), { status: 409, body: { ok: false, code: 'MOVE_NEEDS', needs: ['unsealed'] } })
  }
  assert.deepEqual(storage.snapshot(), appended, 'a refused reserve writes nothing')
  tick(1000)
  const moved = await move(storage, B, { expect: 0, checkpoint: cp(1), copy: copyOf(A), accept: ['unsealed'] })
  assert.deepEqual(moved, { status: 200, body: { ok: true, holder: { label: 'Firefox', generation: 1, since: clock.now, checkpoint: cp(1), sealed: false, you: true } } })
  assert.deepEqual(await storage.get(LEASE), { leaseId: null, generation: 1, holder: null, acquiredAt: null, seenAt: clock.now, expiresAt: clock.now, asked: null, onehome: true })
  const old = await storage.transaction(tx => checkLease(tx, refOf(a), clock.now, { mode: 'observe' }))
  assert.ok([410, 423].includes(old.status), JSON.stringify(old))
  assert.equal((await append(storage, refOf(a), '{"t":3}\n')).status, old.status)
  const log2 = await storage.get(WORLD_HOLDER_LOG)
  assert.equal(log2.length, 1)
  assert.deepEqual([log2[0].generation, log2[0].from, log2[0].accept, log2[0].to.thumb], [1, null, ['unsealed'], thumbOf(devices[B].key)])
  const changed = Object.keys(storage.snapshot()).filter(key => JSON.stringify(storage.snapshot()[key]) !== JSON.stringify(appended[key]))
  assert.deepEqual(changed.sort(), [LEASE, WORLD_HOLDER, WORLD_HOLDER_LOG].sort())
})

test('the walk in ONE-HOME N4r: claim in A, seal in A, move to B with the sealed copy, claim back in A with not-newest: 1, 2, 3', async () => {
  const storage = fresh()
  assert.deepEqual((await preview(storage, A, null)).body.move.needs, [])
  assert.equal((await claim(storage, A, 0)).body.holder.generation, 1)
  assert.equal((await seal(storage, A, cp(7), 11)).status, 200)
  const seen = await preview(storage, B, cp(7), copyOf(A))
  assert.deepEqual(seen.body.move.needs, [])
  assert.deepEqual(seen.body.sealed, [{ checkpoint: cp(7), label: 'Chrome on the Mac', at: T0, generation: 1, rev: 11, yours: false, byHolder: true }])
  const there = await move(storage, B, { expect: 1, checkpoint: cp(7), copy: copyOf(A), accept: [] })
  assert.deepEqual(there.body.holder, { label: 'Firefox', generation: 2, since: T0, checkpoint: cp(7), sealed: true, you: true })
  assert.deepEqual((await claim(storage, A, 2)).body, { ok: false, code: 'MOVE_NEEDS', needs: ['not-newest'] })
  assert.equal((await claim(storage, A, 2, ['not-newest'])).body.holder.generation, 3)
  const status = await own(storage, 'status', A)
  assert.deepEqual(status.body.holder, { label: 'Chrome on the Mac', generation: 3, since: T0, checkpoint: null, sealed: false, you: true })
  assert.deepEqual(status.body.sealed, [{ checkpoint: cp(7), label: 'Chrome on the Mac', at: T0, generation: 1, rev: 11, yours: true, byHolder: true }])
  assert.equal((await own(storage, 'status', B)).body.holder.you, false)
  const index = await storage.transaction(async tx => worldStatus(tx, { lease: await leaseSummary(tx, clock.now), freeze: undefined }))
  assert.deepEqual(index.home, { pending: false, rescue: null, freeze: 'record', holder: { label: 'Chrome on the Mac', generation: 3, since: T0 } })
  assert.equal((await storage.get(WORLD_HOLDER_LOG)).length, 3)
  for (const body of [status.body, index]) assertClean(body)
})

test('review: a browser whose slot was retired, or that reads again, is never named her body; a malformed tombstone is 503', async () => {
  const tomb = (id, state) => ({ v: 1, clientId: id, state, reason: 'idle', retiredAt: T0 - 1, lastSeenAt: T0 - 40 * 86400000, seq: 3, digest: 'd'.repeat(64),
    base: { lineageId: '12345678-1234-4234-8234-123456789abc', revision: 7 }, resurrectedAt: state === 'reader' ? T0 - 1 : null })
  for (const state of ['retired', 'reader']) {
    const storage = fresh({ [`world:v1:retired:${B}`]: tomb(B, state) })
    const before = storage.snapshot()
    const acquire = await lease(storage, 'acquire', B)
    assert.equal(acquire.body.code, 'CLIENT_SLOT_RETIRED')
    for (const out of [await claim(storage, B, 0), await move(storage, B, { expect: 0, checkpoint: cp(5), copy: copyOf(A), accept: ['unsealed'] })]) {
      assert.deepEqual(out, acquire, state)
      assertClean(out.body, state)
    }
    assert.deepEqual(storage.snapshot(), before)
    if (state === 'reader') assert.deepEqual((await preview(storage, B, null)).body.move, { refused: 'CLIENT_SLOT_RETIRED' })
    assert.equal((await claim(storage, A, 0)).status, 200)
  }
  const broken = fresh({ [`world:v1:retired:${B}`]: { v: 1, clientId: B } })
  const before = broken.snapshot()
  assert.deepEqual(await claim(broken, B, 0), { status: 503, body: { ok: false, code: 'SLOT_TOMBSTONE_UNAVAILABLE' } })
  assert.deepEqual(broken.snapshot(), before)
})

test('rule 9: an unreadable holder or sealed row fails closed and is never replaced; an unreadable pending row only adds not-newest', async () => {
  const good = holderRow(A, 2)
  const cases = [
    { [WORLD_HOLDER]: { ...good, generation: 0 } },
    { [WORLD_HOLDER]: { ...good, extra: 1 } },
    { [WORLD_HOLDER]: { ...good, body: { ...good.body, key: 'x' } } },
    { [WORLD_HOLDER]: 'garbage' },
    { [WORLD_HOLDER]: good, [WORLD_SEALED]: [{ checkpoint: 'x' }] },
    { [WORLD_HOLDER]: good, [WORLD_SEALED]: { not: 'a list' } },
  ]
  for (const initial of cases) {
    // The marker is written in the same transaction as any holder row, and never dropped.
    const storage = fresh({ [LEASE]: MARKED, ...initial })
    const start = storage.snapshot()
    const label = JSON.stringify(initial)
    for (const got of [await seal(storage, A, cp(1), 1), await claim(storage, A, 2), await own(storage, 'acquire', A), await own(storage, 'take', B, {}, { approved: true })]) {
      assert.deepEqual(got, { status: 503, body: { ok: false, code: 'HOLDER_STATE_UNAVAILABLE' } }, label)
      assert.deepEqual(storage.snapshot(), start, label)
    }
    const status = await own(storage, 'status', A)
    assert.deepEqual(status.body, { ok: true, lease: null, now: clock.now, sid: SID[A], holder: { unavailable: true } }, label)
    assert.deepEqual((await preview(storage, A, null)).body.move, { refused: 'HOLDER_STATE_UNAVAILABLE' })
    assert.deepEqual(storage.snapshot(), start, label)
  }
  const pending = fresh({ [PENDING]: { rescue: 'not hex' } })
  assert.deepEqual((await preview(pending, A, null)).body.move.needs, ['not-newest'])
  assert.equal((await claim(pending, A, 0)).body.code, 'MOVE_NEEDS')
  assert.equal((await claim(pending, A, 0, ['not-newest'])).status, 200)
  assert.deepEqual(await pending.get(PENDING), { rescue: 'not hex' })
})

test('rule 6: in 200 random states the preview answers exactly what reserve then demands, and reserve accepts exactly that', async () => {
  const rand = rng(11)
  for (let run = 0; run < 200; run++) {
    const initial = {}
    const holderId = pick(rand, [null, A, B, C])
    if (holderId) Object.assign(initial, { [LEASE]: MARKED, [WORLD_HOLDER]: holderRow(holderId, 1 + Math.floor(rand() * 9)) })
    const sealedCount = holderId ? Math.floor(rand() * 4) : 0
    if (sealedCount) initial[WORLD_SEALED] = Array.from({ length: sealedCount }, (_, i) => ({ checkpoint: cp(i + 1), clientId: pick(rand, CLIENTS), label: 'x', at: T0 - 10 + i, generation: 1, rev: Math.floor(rand() * 5) }))
    const pendingKind = pick(rand, ['none', 'none', 'row', 'bad'])
    if (pendingKind === 'row') initial[PENDING] = { rescue: cp(99), clientId: pick(rand, CLIENTS), since: T0 - 5, verifiedAt: T0 - 5 }
    if (pendingKind === 'bad') initial[PENDING] = 7
    const storage = fresh(initial)
    if (rand() < 0.5) {
      const holderNow = holderId ?? A
      if (!holderId) assert.equal((await claim(storage, A, 0, (await preview(storage, A, null)).body.move.needs)).status, 200)
      const g = await own(storage, 'acquire', holderNow)
      assert.equal(g.status, 200, JSON.stringify(g.body))
      for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) assert.equal((await append(storage, refOf(g), `{"r":${run},"i":${i}}\n`, pick(rand, [PATH, OTHER_PATH]))).status, 200)
    }
    const caller = pick(rand, CLIENTS)
    const self = rand() < 0.5
    const checkpoint = rand() < 0.4 ? null : cp(1 + Math.floor(rand() * 5))
    const copy = copyOf(pick(rand, [...CLIENTS, null]))
    const seen = await preview(storage, caller, checkpoint, copy, { as: self ? caller : null })
    assert.equal(seen.status, 200)
    const demand = seen.body.move
    assert.ok(demand.log === await markOf(storage) && Array.isArray(demand.needs), JSON.stringify(demand))
    // The reserve's key is the caller's own when the preview was proven, else another browser's.
    const device = self ? devices[caller] : stranger
    const before = storage.snapshot()
    const wrong = demand.needs.length ? [] : ['not-newest']
    assert.deepEqual(await reserve(storage, caller, { expect: demand.expect, checkpoint, copy, accept: wrong, log: demand.log, device }),
      { status: 409, body: { ok: false, code: 'MOVE_NEEDS', needs: demand.needs } }, `run ${run}`)
    assert.deepEqual(storage.snapshot(), before)
    const moved = await move(storage, caller, { expect: demand.expect, checkpoint, copy, accept: demand.needs, log: demand.log, device })
    assert.equal(moved.status, 200, `run ${run}: ${JSON.stringify(moved.body)}`)
    assert.equal(moved.body.holder.generation, demand.expect + 1)
  }
})

test('SHOULD 4: 200 random sequences with proofs: the live lease is only ever her body\'s, none lives during a reservation, the generation never falls', async () => {
  const rand = rng(23)
  let impostorTries = 0, ownerChecks = 0
  for (let run = 0; run < 200; run++) {
    const storage = fresh()
    let generation = 0
    const grants = {}
    for (let step = 0; step < 25; step++) {
      tick(pick(rand, [0, 500, 30000, 100000]))
      const id = pick(rand, CLIENTS)
      const op = pick(rand, ['claim', 'seal', 'move', 'acquire', 'impostor', 'release', 'status', 'append', 'reserve'])
      let got
      if (op === 'claim' || op === 'move' || op === 'reserve') {
        const checkpoint = op === 'claim' ? null : cp(1 + Math.floor(rand() * 4))
        const copy = copyOf(pick(rand, CLIENTS))
        const seen = await preview(storage, id, checkpoint, copy, { as: id })
        assertClean(seen.body, 'preview')
        if (seen.body.move.refused) continue
        const accept = rand() < 0.8 ? seen.body.move.needs : [...HOLDER_WORDS]
        const options = { expect: rand() < 0.9 ? seen.body.move.expect : 99, checkpoint, copy, accept, approved: rand() < 0.9 }
        got = op === 'reserve' ? await reserve(storage, id, options) : await move(storage, id, options)
        if (op === 'reserve' && got.status === 200) { assert.equal(got.body.descriptor.clientId, id); continue }
      } else if (op === 'seal') got = await seal(storage, id, cp(1 + Math.floor(rand() * 4)), Math.floor(rand() * 9))
      else if (op === 'acquire') { got = await own(storage, 'acquire', id); if (got.status === 200) grants[id] = got }
      else if (op === 'impostor') {
        // Another browser types this id and signs with its own key.
        got = await lease(storage, 'acquire', id, {}, { as: pick(rand, [stranger, ...CLIENTS.filter(other => other !== id).map(other => devices[other])]) })
        const row = await storage.get(WORLD_HOLDER)
        if (row?.body?.clientId === id) { assert.equal(got.status, 423); impostorTries++ }
        if (got.status === 200) grants[id] = got
      } else if (op === 'release') got = await own(storage, 'release', id, { leaseId: grants[id]?.body.lease.leaseId ?? cp(5) })
      else if (op === 'append') { if (grants[id]) assertClean((await append(storage, refOf(grants[id]), `{"s":${step}}\n`)).body, 'append'); continue }
      else got = await own(storage, 'status', id)
      assertClean(got.body, `${op} run ${run} step ${step}`)
      const row = await storage.get(WORLD_HOLDER)
      const leased = await storage.get(LEASE)
      const live = Boolean(leased?.holder) && leased.expiresAt > clock.now
      if (row?.body && live) { assert.equal(leased.holder.clientId, row.body.clientId, 'the live lease is her body\'s'); ownerChecks++ }
      if (row?.reservation && row.reservation.until > clock.now) assert.equal(live, false, 'no live lease during a reservation')
      if (row) assert.equal(leased?.onehome, true, 'a holder row never exists without the marker')
      const now = row?.generation ?? 0
      assert.ok(now >= generation, `the generation fell: ${generation} -> ${now}`)
      generation = now
      const sealed = await storage.get(WORLD_SEALED)
      assert.ok(sealed === undefined || (sealed.length <= 8 && row?.body), 'no sealed row without a body; 8 at most')
    }
  }
  assert.ok(impostorTries > 20 && ownerChecks > 50, `${impostorTries} impostor tries, ${ownerChecks} owner checks`)
})

// ── Through the mount: the Worker's word and the passkey. ────────────────────────────────────────────────────

function vaultBucket() {
  const objects = new Map(), sizes = new Map(), calls = []
  const stream = bytes => new ReadableStream({ start(controller) { if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes)); controller.close() } })
  return {
    objects, sizes, calls,
    async head(key) { calls.push(['head', key]); const v = objects.get(key); return v ? { key, size: v.byteLength } : null },
    async put(key) { calls.push(['put', key]); return null },
    async get(key) { calls.push(['get', key]); const v = objects.get(key); return v ? { key, size: sizes.get(key) ?? v.byteLength, body: stream(v) } : null },
  }
}

/** A rescue in the vault's shape (pending.json, manifest.json naming its SHA-256). */
function storeCopy(bucket, { clientId, verified = true, tag = '' }) {
  const index = encoder.encode(JSON.stringify({ v: 1, piece: 2097152, source: 'indexeddb', client: { clientId, base: null, reconciliation: null }, rows: [], skipped: [], totals: { rows: 0 }, tag }))
  const indexSha = shaHex(index), id = indexSha.slice(0, 32)
  bucket.objects.set(`w/${WORLD}/rescue/${id}/pending.json`, index)
  bucket.objects.set(`w/${WORLD}/rescue/${id}/manifest.json`, encoder.encode(JSON.stringify({ verified, verifiedAt: '2026-11-13T00:12:00.000Z', indexSha })))
  return id
}

/** The Worker's mount over a MIRROR fake that is MIRROR's lease route: 1,024 bytes, exactly {input, ownerApproved}, the real leaseAction. */
/**
 * `cut`: for each approved MIRROR post in turn, 'before' fails it before MIRROR runs it and 'after' loses MIRROR's answer
 * after it ran (a commit cut off). `approve`: whether HEAD's check passes (false: HEAD refuses it, 403, as for an approval
 * already consumed). job 3: `head` is a HEAD stand-in that keeps each approval (by its bearer, the header) with
 * the exact body it approves and whether it was consumed: `authorize` consumes it (asked = consumed), and its read-only
 * `/_head/class3-inspect` answers consumed / unconsumed / other / none. `answer(card)` may replace HEAD's answer to the
 * passkey ask ('lost': it consumed and the answer never came; 'malformed'; 'late'; 'refused'). `inspect` may replace the
 * inspection's answer. Each browser's session is its own (`access.session`); `as` sends from another browser's session.
 */
function mountRig({ onApprove = null, cut = [], approve = () => true, answer = null, inspect = null } = {}) {
  const storage = fresh()
  const bucket = vaultBucket()
  const posts = [], asked = [], inspected = []
  const approvals = new Map()
  const fetch = async request => {
    const text = await request.text()
    posts.push({ bytes: Buffer.byteLength(text), body: JSON.parse(text) })
    const body = JSON.parse(text)
    if (Buffer.byteLength(text) > 1024 || Object.keys(body).sort().join() !== 'input,ownerApproved') return Response.json({ ok: false, code: 'LEASE_REQUEST_INVALID' }, { status: 400 })
    const fault = body.ownerApproved === true ? cut.shift() : undefined
    if (fault === 'before') throw new Error('cut off before MIRROR')
    const out = await leaseAction(storage, body.input, { now: clock.now, ownerApproved: body.ownerApproved === true })
    if (fault === 'after') throw new Error('cut off after MIRROR')
    return Response.json(out.body, { status: out.status })
  }
  const headFetch = async request => {
    const { token, binding } = await request.json()
    inspected.push(binding.bodySha256)
    if (request.headers.get('x-x6-internal-authorized') !== '1' || new URL(request.url).pathname !== '/_head/class3-inspect') return Response.json({ ok: false }, { status: 401 })
    const forced = inspect?.()
    if (forced === 'throw') throw new Error('HEAD unreachable')
    if (forced) return forced instanceof Response ? forced : Response.json({ ok: true, approval: forced })
    const held = approvals.get(token)
    const approval = !held ? 'none' : held.bodySha256 !== binding.bodySha256 ? 'other' : held.consumed ? 'consumed' : 'unconsumed'
    return Response.json({ ok: true, approval })
  }
  const env = { ARCHIVE_BUCKET: bucket, MIRROR: { idFromName: value => value, get: () => ({ fetch }) }, HEAD: { idFromName: value => value, get: () => ({ fetch: headFetch }) } }
  const mount = createThreadMount()
  /** The owner approves this exact body with his passkey: a bearer HEAD keeps (as aumlok's approve ceremony does). */
  const approveBody = body => {
    const token = `card-${approvals.size + 1}`
    approvals.set(token, { bodySha256: shaHex(holder.canonicalJson(body)), consumed: false })
    return token
  }
  // `sessionless`: the request arrives with owner access that carries no session (an owner-pass sign-in: worker.mjs's ambient JWT).
  // `access` (job 4 review): the owner access exactly as the Worker hands it; `headers` collects each answer's retry-after.
  const send = async (body, { approval = false, token = null, as = body.clientId, sessionless = false, access = null, headers = null } = {}) => {
    const card = token ?? (approval ? approveBody(body) : null)
    const request = new Request(ORIGIN + '/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(card ? { 'x-x6-class3-approval': card } : {}) }, body: JSON.stringify(body) })
    const out = await mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: access ?? (sessionless ? { type: 'owner' } : { type: 'owner', session: sessionOf(as) }), now: () => clock.now,
      // In the real Worker this is HEAD's check (edgeClass3), and it CONSUMES the approval: asked = consumed.
      authorize: async approved => {
        asked.push(approved)
        await onApprove?.() // job 4: a hook may race a request in while the passkey is asked (awaited)
        const held = approvals.get(card)
        const fit = held && !held.consumed && held.bodySha256 === shaHex(holder.canonicalJson(approved)) && approve()
        const forced = answer?.(approved)
        if (forced === 'refused' || !fit) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
        held.consumed = true
        if (forced === 'lost') throw Object.assign(new Error('BOOTSTRAP_TIMEOUT'), { code: 'BOOTSTRAP_TIMEOUT', status: 503 })
        if (forced === 'malformed') return { ok: true }
        if (forced === 'late') return { ok: true, expiresAt: clock.now }
        return { ok: true, expiresAt: clock.now + 60000 }
      } })
    headers?.push(out.headers.get('retry-after'))
    return { status: out.status, body: await out.json() }
  }
  const reserveBody = async (id, fields, device = devices[id]) => {
    const input = { action: 'reserve', ...who(id), ...fields, key: device.key }
    // The proof names the session the Worker will put on it (its public id, derived from the session).
    return { ...input, proof: await proofOf(device, { ...input, sid: await sidFromSession(sessionOf(id)) }) }
  }
  return { storage, bucket, posts, asked, inspected, approvals, send, reserveBody, approveBody }
}
/** Each browser's signed-in session MAC (what worker.mjs hands on as `access.session`), and its public id as the Worker derives it. */
const sessionOf = id => shaHex(`session of ${id}`)
const sidFromSession = async session => shaHex(Buffer.concat([Buffer.from('aukora-x6-session-id/1'), Buffer.from([0]), Buffer.from(session)])).slice(0, 32)
/** A body signed in `id`'s session by `device` (as the page signs it: the session's `sid` named, not sent). */
async function signedBody(id, fields, device = devices[id]) {
  const input = { ...fields }
  return { ...input, proof: await proofOf(device, { ...input, sid: await sidFromSession(sessionOf(id)) }) }
}

test('MUST 2 through the mount: each of his examples is refused at reserve, before any passkey: asked and consumed both zero', async () => {
  const rig = mountRig()
  const mine = storeCopy(rig.bucket, { clientId: A })
  const log = await markOf(rig.storage)
  assert.equal((await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] }))).status, 200)
  const r = (await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] })))
  assert.equal(r.body.code, 'MOVE_RESERVED')
  tick(90001)
  // Lapsed unclaimed; claim properly, then seal.
  const claimR = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] }))
  assert.equal((await rig.send(claimR.body.descriptor, { approval: true })).status, 200)
  assert.equal((await rig.send(await signedBody(A, { action: 'seal', ...who(A), checkpoint: mine, cut: { rev: 4 } }))).status, 200)
  rig.asked.length = 0
  const good = { expect: 1, checkpoint: mine, log, accept: [] }
  const examples = [
    ['generation moved', { ...good, expect: 0 }, 409, 'HOLDER_MOVED'],
    ['unknown copy', { ...good, checkpoint: cp(77), accept: ['not-newest', 'unsealed'] }, 409, 'CHECKPOINT_NOT_VERIFIED'],
    ['bad shape', { ...good, accept: ['unsealed', 'not-newest'] }, 400, 'LEASE_REQUEST_INVALID'],
    ['changed log', { ...good, log: 'f'.repeat(64) }, 409, 'LOG_MOVED'],
    ['wrong accept', { ...good, accept: ['not-newest'] }, 409, 'MOVE_NEEDS'],
  ]
  for (const [name, fields, status, code] of examples) {
    const got = await rig.send(await rig.reserveBody(B, fields), { approval: true })
    assert.deepEqual([got.status, got.body.code], [status, code], name)
    assert.equal(rig.asked.length, 0, `${name}: no passkey asked or consumed`)
  }
  // A move whose descriptor nobody reserved: 409, the passkey never asked.
  const forged = { action: 'move', ...who(B), ...good, key: devices[B].key, copy: copyOf(A), until: clock.now + 1000 }
  assert.deepEqual(await rig.send(forged, { approval: true }), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } })
  // A browser body carrying the Worker's field outside a move's descriptor: 400.
  assert.equal((await rig.send({ ...(await rig.reserveBody(B, good)), copy: copyOf(A) }, { approval: true })).status, 400)
  assert.equal(rig.asked.length, 0)
  // The good one: the passkey is asked once, over the descriptor, which carries the Worker's copy facts (his SHOULD 2).
  const reserved = await rig.send(await rig.reserveBody(B, good))
  assert.equal(reserved.status, 200)
  assert.deepEqual(reserved.body.descriptor.copy, { verified: true, maker: A })
  assert.deepEqual(await rig.send(reserved.body.descriptor), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
  assert.equal(rig.asked.length, 0, 'no header: no passkey')
  const moved = await rig.send(reserved.body.descriptor, { approval: true })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  assert.deepEqual(rig.asked, [reserved.body.descriptor])
  assert.deepEqual(rig.posts.at(-1).body, { input: reserved.body.descriptor, ownerApproved: true })
  // Replay after success: 200 already, no passkey.
  assert.deepEqual(await rig.send(reserved.body.descriptor, { approval: true }), { status: 200, body: { ok: true, already: true, moved: true, generation: 2 } })
  assert.equal(rig.asked.length, 1)
  // A browser `ownerApproved` is never approval.
  assert.equal((await rig.send({ ...reserved.body.descriptor, ownerApproved: true }, { approval: true })).body.already, true)
})

test('MUST 2 through the mount: the reservation lapses between the passkey and the commit: 409 MOVE_APPROVAL_SPENT, moved false, nothing moved', async () => {
  let late = false
  const rig = mountRig({ onApprove: () => { if (late) tick(90001) } })
  const log = await markOf(rig.storage)
  const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] }))
  assert.equal(reserved.status, 200)
  late = true
  assert.deepEqual(await rig.send(reserved.body.descriptor, { approval: true }),
    { status: 409, body: { ok: false, code: 'MOVE_APPROVAL_SPENT', moved: false, next: 'reserve and approve again' } })
  assert.equal(rig.asked.length, 1)
  assert.equal((await rig.storage.get(WORLD_HOLDER)).body, null, 'nothing moved')
  // Reserve and approve again.
  late = false
  const again = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] }))
  assert.equal((await rig.send(again.body.descriptor, { approval: true })).status, 200)
})

test('mount: seal of a copy that is unverified, not this browser, or unreadable never reaches MIRROR; its own verified copy seals', async () => {
  const rig = mountRig()
  const mine = storeCopy(rig.bucket, { clientId: A })
  const theirs = storeCopy(rig.bucket, { clientId: B })
  const unverified = storeCopy(rig.bucket, { clientId: A, verified: false, tag: 'u' })
  const unreadable = storeCopy(rig.bucket, { clientId: A, tag: 'r' })
  rig.bucket.sizes.set(`w/${WORLD}/rescue/${unreadable}/manifest.json`, 1 << 20)
  const body = checkpoint => signedBody(A, { action: 'seal', ...who(A), checkpoint, cut: { rev: 1 } })
  assert.deepEqual(await rig.send(await body(unverified)), { status: 409, body: { ok: false, code: 'CHECKPOINT_NOT_VERIFIED' } })
  assert.deepEqual(await rig.send(await body(cp(77))), { status: 409, body: { ok: false, code: 'CHECKPOINT_NOT_VERIFIED' } })
  assert.deepEqual(await rig.send(await body(theirs)), { status: 409, body: { ok: false, code: 'CHECKPOINT_NOT_YOURS' } })
  assert.deepEqual(await rig.send(await body(unreadable)), { status: 503, body: { ok: false, code: 'CHECKPOINT_UNAVAILABLE' } })
  assert.equal(rig.posts.length, 0, 'nothing reached MIRROR')
  assert.deepEqual(await rig.send(await body(mine)), { status: 409, body: { ok: false, code: 'NO_HOLDER' } })
  assert.deepEqual(rig.posts.at(-1).body.input.copy, { verified: true, maker: A })
  const log = await markOf(rig.storage)
  const claimed = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log, accept: [] }))
  assert.equal((await rig.send(claimed.body.descriptor, { approval: true })).status, 200)
  assert.deepEqual(await rig.send(await body(mine)), { status: 200, body: { ok: true, sealed: true, already: false } })
  const seen = await rig.send({ action: 'status', ...who(B), checkpoint: mine })
  assert.deepEqual(seen.body.move, { expect: 1, needs: [], log })
  assert.deepEqual((await rig.send({ action: 'status', ...who(B), checkpoint: unverified })).body.move, { refused: 'CHECKPOINT_NOT_VERIFIED' })
  assertClean(seen.body)
})

test('mount: the largest honest reserve and move wrappers fit 1,024 bytes; one over is 413 before the passkey', async t => {
  const rig = mountRig()
  const maker = 'abcdef01-2345-4678-89ab-cdef01234567'
  const copy = storeCopy(rig.bucket, { clientId: maker })
  const label = '\u{1D538}'.repeat(48) // 4 bytes each in UTF-8, printable, kept unescaped by JSON
  const fields = { clientId: C, tabId: 'T'.repeat(64), label, expect: Number.MAX_SAFE_INTEGER, checkpoint: copy, log: 'f'.repeat(64), accept: ['not-newest', 'unsealed'], key: devices[C].key }
  const reserveBody = { action: 'reserve', ...fields, proof: { ts: Number.MAX_SAFE_INTEGER, sig: 'A'.repeat(86) } }
  // job 3: the Worker adds its two words, the copy facts and the session's public id.
  const reserveWire = Buffer.byteLength(JSON.stringify({ input: { ...reserveBody, copy: { verified: true, maker }, sid: 'f'.repeat(32) }, ownerApproved: false }))
  const moveBody = { action: 'move', ...fields, copy: { verified: false, maker: null }, until: Number.MAX_SAFE_INTEGER }
  moveBody.copy = { verified: true, maker }
  const moveWire = Buffer.byteLength(JSON.stringify({ input: moveBody, ownerApproved: false }))
  t.diagnostic(`largest honest reserve wrapper: ${reserveWire} bytes; move wrapper: ${moveWire} bytes`)
  assert.ok(reserveWire <= 1024 && moveWire <= 1024, `${reserveWire}, ${moveWire}`)
  const out = await rig.send(reserveBody)
  assert.deepEqual(out, { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: clock.now, sid: await sidFromSession(sessionOf(C)) } }, 'it reached MIRROR whole')
  assert.ok(rig.posts.at(-1).bytes <= 1024)
  assert.deepEqual(await rig.send(moveBody, { approval: true }), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } })
  const posts = rig.posts.length
  assert.deepEqual(await rig.send({ ...moveBody, label: '\u{1D538}'.repeat(200) }, { approval: true }), { status: 413, body: { ok: false, code: 'LEASE_REQUEST_TOO_LARGE', limit: 1024 } })
  assert.deepEqual([rig.asked.length, rig.posts.length], [0, posts])
})

test('review: the 1,024-byte check is made on the final reserve wrapper with the Worker word, before MIRROR (body 941, wrapper 1,045)', async () => {
  const rig = mountRig()
  const maker = 'abcdef01-2345-4678-89ab-cdef01234567'
  const copy = storeCopy(rig.bucket, { clientId: maker })
  const body = { action: 'reserve', clientId: C, tabId: 'T'.repeat(64), label: '\u{1D538}'.repeat(95), expect: Number.MAX_SAFE_INTEGER, checkpoint: copy, log: 'f'.repeat(64),
    accept: ['not-newest', 'unsealed'], key: devices[C].key, proof: { ts: Number.MAX_SAFE_INTEGER, sig: 'A'.repeat(86) } }
  // Under the browser body cap, and the wrapper would fit WITHOUT the word; only the word takes it over.
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 941)
  assert.equal(Buffer.byteLength(JSON.stringify({ input: body, ownerApproved: false })), 973)
  assert.equal(Buffer.byteLength(JSON.stringify({ input: { ...body, copy: { verified: true, maker } }, ownerApproved: false })), 1045)
  const reads = rig.bucket.calls.length
  assert.deepEqual(await rig.send(body, { approval: true }), { status: 413, body: { ok: false, code: 'LEASE_REQUEST_TOO_LARGE', limit: 1024 } })
  assert.deepEqual([rig.asked.length, rig.posts.length], [0, 0], 'no passkey asked, nothing forwarded')
  assert.ok(rig.bucket.calls.slice(reads).some(([, key]) => key.includes(`/rescue/${copy}/`)), 'the vault was read: the refusal is the wrapper check')
})

test('review + MUST 3: a move commit cut off after the passkey is sent once more; still unanswered it is 503 MOVE_OUTCOME_UNKNOWN, and a repeat with the same approval finishes it or tells the truth', async () => {
  // job 4: these commits carry no proof, so the answer is the holder's public summary, `you` absent.
  const claimed = { ok: true, holder: { label: 'Chrome on the Mac', generation: 1, since: T0, checkpoint: null, sealed: false } }
  const unknown = { status: 503, body: { ok: false, code: 'MOVE_OUTCOME_UNKNOWN', approval: 'spent', next: 'repeat the same move' } }
  const start = async options => {
    const rig = mountRig(options)
    const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    assert.equal(reserved.status, 200)
    return { rig, descriptor: reserved.body.descriptor, token: rig.approveBody(reserved.body.descriptor) }
  }
  const approvedPosts = rig => rig.posts.filter(p => p.body.ownerApproved === true).length
  const generation = async rig => (await rig.storage.get(WORLD_HOLDER)).generation
  // Cut off before MIRROR ran it: the second send commits. Cut off after: the second send is `already`. One passkey each.
  {
    const { rig, descriptor, token } = await start({ cut: ['before'] })
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 200, body: claimed })
    assert.deepEqual([rig.asked.length, approvedPosts(rig), await generation(rig)], [1, 2, 1])
  }
  {
    const { rig, descriptor, token } = await start({ cut: ['after'] })
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 200, body: { ok: true, already: true, moved: true, generation: 1 } })
    assert.deepEqual([rig.asked.length, approvedPosts(rig), await generation(rig)], [1, 2, 1])
  }
  // Both sends unanswered, nothing applied: 503 MOVE_OUTCOME_UNKNOWN. MUST 3: a repeat with THE SAME approval asks HEAD
  // whether it was consumed for this descriptor: it was, so the live reservation is committed, with no second passkey.
  {
    const { rig, descriptor, token } = await start({ cut: ['before', 'before'] })
    assert.deepEqual(await rig.send(descriptor, { token }), unknown)
    assert.deepEqual([rig.asked.length, approvedPosts(rig), (await rig.storage.get(WORLD_HOLDER)).body], [1, 2, null])
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 200, body: claimed })
    assert.deepEqual([rig.asked.length, approvedPosts(rig), await generation(rig)], [1, 3, 1])
    // And once more: `already`, nothing asked.
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 200, body: { ok: true, already: true, moved: true, generation: 1 } })
    assert.equal(rig.asked.length, 1)
  }
  // The reservation lapsed before the repeat: the edge knows nothing moved and HEAD that this approval was spent on it.
  {
    const { rig, descriptor, token } = await start({ cut: ['before', 'before'] })
    assert.deepEqual(await rig.send(descriptor, { token }), unknown)
    tick(90001)
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 409, body: { ok: false, code: 'MOVE_APPROVAL_SPENT', moved: false, next: 'reserve and approve again' } })
    assert.deepEqual([rig.asked.length, (await rig.storage.get(WORLD_HOLDER)).body], [1, null])
    // Without the header the same lapsed descriptor is simply not reserved.
    assert.deepEqual(await rig.send(descriptor), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } })
  }
  // Both unanswered but the first applied: 503 MOVE_OUTCOME_UNKNOWN; the repeat answers `already`, no passkey.
  {
    const { rig, descriptor, token } = await start({ cut: ['after', 'after'] })
    assert.deepEqual(await rig.send(descriptor, { token }), unknown)
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 200, body: { ok: true, already: true, moved: true, generation: 1 } })
    assert.deepEqual([rig.asked.length, await generation(rig)], [1, 1])
  }
})

test('holderWord: nothing is read for an action without a checkpoint, nor for a move; a missing bucket or a late read is 503', async () => {
  let reads = 0
  const rescues = { get: async () => { reads++; return null } }
  for (const input of [{ action: 'acquire' }, { action: 'status' }, { action: 'status', checkpoint: null }, { action: 'reserve', checkpoint: null }, { action: 'seal', checkpoint: 'nope' }, { action: 'move', checkpoint: cp(1), copy: copyOf(A) }]) {
    assert.deepEqual(await holderWord({ ...input }, input, rescues, 50), {})
  }
  assert.equal(reads, 0)
  assert.deepEqual(await holderWord({ copy: null }, { action: 'acquire' }, rescues, 50), { refusal: { status: 400, code: 'LEASE_REQUEST_INVALID' } })
  assert.deepEqual(await holderWord({}, { action: 'reserve', checkpoint: cp(1) }, null, 50), { refusal: { status: 503, code: 'CHECKPOINT_UNAVAILABLE' } })
  const late = { get: () => new Promise(() => {}) }
  assert.deepEqual(await holderWord({}, { action: 'status', checkpoint: cp(1) }, late, 20), { refusal: { status: 503, code: 'CHECKPOINT_UNAVAILABLE' } })
  assert.deepEqual(await holderWord({}, { action: 'reserve', checkpoint: cp(1) }, rescues, 50), { copy: { verified: false, maker: null } })
})

// ── job 3: the outside reviewer's second HOLD (five MUST, two SHOULD). ──────────────────────────────────

/** Files of `rev` (and every file they import, relatively), in a folder of their own (TMPDIR); `entries` are repo paths. */
async function loadAt(t, rev, entries) {
  try { execFileSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', rev, 'HEAD'], { stdio: 'ignore' }) }
  catch { throw new Error(`world-holder: ${rev} is not an ancestor of HEAD in ${REPO}`) }
  const root = await mkdtemp(path.join(os.tmpdir(), `holder-${rev}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  await symlink(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const seen = new Set(), todo = [...entries]
  const specifiers = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = execFileSync('git', ['-C', REPO, 'show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
    await mkdir(path.join(root, path.dirname(file)), { recursive: true })
    await writeFile(path.join(root, file), text)
    for (const match of text.matchAll(specifiers)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec.startsWith('.')) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
    }
  }
  return Object.fromEntries(await Promise.all(entries.map(async entry => [path.basename(entry, '.mjs'), await import(pathToFileURL(path.join(root, entry)).href)])))
}

const MIRROR_SEED = 'a'.repeat(64)
/** A seeded, ready MIRROR world (as mirror-world-mount.test.mjs seeds one). */
const seededMirrorRows = () => ({
  'mirror:bootstrap:v1': { phase: 'ready', seedId: MIRROR_SEED, lineageId: '11111111-1111-4111-8111-111111111111', revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 },
  'mirror:v2:global-fence': { lineageId: '11111111-1111-4111-8111-111111111111', revision: 1 },
})
/** One internal POST to the REAL MirrorDO's lease route. */
async function mirrorLease(mirror, input, ownerApproved = false) {
  const response = await mirror.fetch(new Request('https://x61.internal/_mirror/lease', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': MIRROR_SEED }, body: JSON.stringify({ input, ownerApproved }) }))
  return { status: response.status, body: await response.json() }
}
/** A MIRROR-level input as the Worker forwards it: in `id`'s session, signed by `device`. */
async function signedInput(id, fields, device = devices[id]) {
  const input = { ...who(id), sid: SID[id], ...fields }
  return { ...input, proof: await proofOf(device, input) }
}
const holderShown = (generation = 1, since = T0, label = 'Chrome on the Mac') => ({ label, since, generation })

test('MUST 1, his sequence: claim, acquire, the lease row rewritten the way e728dce2 writes it, MIRROR restarted: B\'s acquire without a proof is 423 again', async t => {
  const old = await loadAt(t, 'e728dce2', ['deploy/cloudflare/src/world-lease.mjs'])
  t.mock.method(Date, 'now', () => clock.now)
  const storage = fresh(seededMirrorRows())
  const first = new MirrorDO({ storage }, {})
  const reserved = await mirrorLease(first, await signedInput(A, { action: 'reserve', expect: 0, checkpoint: null, log: await markOf(storage), accept: [], key: devices[A].key }))
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body))
  assert.equal((await mirrorLease(first, reserved.body.descriptor, true)).status, 200)
  const a = await mirrorLease(first, await signedInput(A, { action: 'acquire' }))
  assert.equal(a.status, 200)
  assert.equal((await storage.get(LEASE)).onehome, true)
  // The rollback: an earlier commit (no holder module) releases A's lease, then grants B one on its typed id alone.
  tick(1000)
  assert.deepEqual((await old['world-lease'].leaseAction(storage, { action: 'release', ...who(A), leaseId: a.body.lease.leaseId }, { now: clock.now })).body, { ok: true, released: true })
  const stolen = await old['world-lease'].leaseAction(storage, { action: 'acquire', ...who(B) }, { now: clock.now })
  assert.equal(stolen.status, 200)
  assert.equal(Object.hasOwn(await storage.get(LEASE), 'onehome'), false, 'the old build wrote the lease row without the marker')
  // Roll forward: a NEW MIRROR object over the same storage. Its start reads the holder row before it serves anything: the
  // lease the old build granted without her key is over, the row is marked again, and B is refused as before.
  tick(1000)
  const restarted = new MirrorDO({ storage }, {})
  assert.deepEqual(await mirrorLease(restarted, { action: 'acquire', ...who(B), sid: SID[B] }), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } })
  assert.deepEqual(await mirrorLease(restarted, { action: 'take', ...who(B), sid: SID[B] }, true), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } })
  const row = await storage.get(LEASE)
  assert.deepEqual([row.holder, row.onehome, row.generation, row.expiresAt], [null, true, stolen.body.lease.generation, T0 + 2000])
  assert.equal((await append(storage, refOf(stolen), '{"b":1}\n')).status, 410, 'B\'s old lease writes nothing more')
  // Her body: acquires with its proof; its status is hers, B's is not.
  const back = await mirrorLease(restarted, await signedInput(A, { action: 'acquire' }))
  assert.equal(back.status, 200)
  assert.equal((await append(storage, refOf(back), '{"a":1}\n')).status, 200)
  assert.equal((await mirrorLease(restarted, await signedInput(A, { action: 'status' }))).body.holder.you, true)
  assert.equal((await mirrorLease(restarted, await signedInput(B, { action: 'status' }))).body.holder.you, false)
})

test('MUST 1: while the object lives the marker is only a cache: a holder row found at start (or written here) keeps the lease paths held; with none the start costs one get', async t => {
  t.mock.method(Date, 'now', () => clock.now)
  // No holder row: one get, no transaction, no write.
  const ops = []
  const none = createRollbackStorage({}, { record: ops })
  let transactions = 0
  const open = none.transaction
  none.transaction = fn => { transactions++; return open(fn) }
  await holderStartUp(none)
  assert.deepEqual([ops, transactions], [[`get ${WORLD_HOLDER}`], 0])
  // A holder row found at start, then the marker lost while the object runs: still held; the next write puts it back.
  const { onehome: _mark, ...bare } = MARKED
  const storage = fresh({ [WORLD_HOLDER]: holderRow(A, 1), [LEASE]: MARKED })
  await holderStartUp(storage)
  assert.deepEqual(await storage.get(LEASE), MARKED, 'a marked row is left as it is')
  await storage.put(LEASE, bare)
  const elsewhere = { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown(1, T0 - 20) } }
  assert.deepEqual(await lease(storage, 'acquire', B), elsewhere)
  assert.deepEqual(await lease(storage, 'take', B, {}, { approved: true }), elsewhere)
  assert.equal((await lease(storage, 'status', B)).body.holder.you, false)
  assert.equal((await own(storage, 'acquire', A)).status, 200)
  assert.equal((await storage.get(LEASE)).onehome, true, 'written back on the next write')
  // A start that cannot read is taken as held.
  const broken = fresh({ [WORLD_HOLDER]: holderRow(A, 1), [LEASE]: bare })
  const get = broken.get
  broken.get = async () => { throw new Error('storage down') }
  await holderStartUp(broken)
  broken.get = get
  assert.deepEqual(await lease(broken, 'acquire', B), elsewhere)
  // The object that wrote the first holder row knows it from then on.
  const claimed = fresh()
  assert.equal((await claim(claimed, A, 0)).status, 200)
  await claimed.put(LEASE, { ...bare, generation: 0 })
  assert.equal((await lease(claimed, 'acquire', B)).body.code, 'HOLDER_ELSEWHERE')
  // A malformed lease row beside a holder row only gains the marker; its own reads still answer 503.
  const malformed = fresh({ [WORLD_HOLDER]: holderRow(A, 1), [LEASE]: { garbage: true } })
  await holderStartUp(malformed)
  assert.deepEqual(await malformed.get(LEASE), { garbage: true, onehome: true })
  assert.deepEqual(await lease(malformed, 'acquire', B), { status: 503, body: { ok: false, code: 'LEASE_STATE_UNAVAILABLE' } })
  // An absent lease row beside a holder row is written free and marked.
  const absent = fresh({ [WORLD_HOLDER]: holderRow(A, 1) })
  await holderStartUp(absent)
  assert.deepEqual(await absent.get(LEASE), { leaseId: null, generation: 0, holder: null, acquiredAt: null, seenAt: T0, expiresAt: T0, asked: null, onehome: true })
})

test('MUST 2, his sequence: B submits A\'s signed bodies unchanged from its own session: not her body; A sends them a second time from its own: used up (409 only to A)', async () => {
  const rig = mountRig()
  const mine = storeCopy(rig.bucket, { clientId: A })
  const r = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(r.body.descriptor, { approval: true })).status, 200)
  // The status tells each session its own public id; the Worker set it from the session the gate verified.
  const sidA = (await rig.send({ action: 'status', ...who(A) })).body.sid
  assert.equal(sidA, await sidFromSession(sessionOf(A)))
  assert.equal((await rig.send({ action: 'status', ...who(A) }, { as: B })).body.sid, await sidFromSession(sessionOf(B)))
  const bodies = {
    status: await signedBody(A, { action: 'status', ...who(A) }),
    acquire: await signedBody(A, { action: 'acquire', ...who(A) }),
    seal: await signedBody(A, { action: 'seal', ...who(A), checkpoint: mine, cut: { rev: 3 } }),
  }
  const elsewhere = { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } }
  // B, signed in in its own session, sends A's bodies unchanged (it captured them): refused exactly as no proof.
  const before = rig.storage.snapshot()
  const seenByB = await rig.send(bodies.status, { as: B })
  assert.deepEqual([seenByB.body.holder.you, seenByB.body.sealed], [false, []])
  assert.deepEqual(await rig.send(bodies.acquire, { as: B }), elsewhere)
  assert.deepEqual(await rig.send(bodies.seal, { as: B }), elsewhere)
  assert.deepEqual(rig.storage.snapshot(), before, 'nothing written')
  // A, in its own session: each is accepted once.
  assert.equal((await rig.send(bodies.status)).body.holder.you, true)
  const granted = await rig.send(bodies.acquire)
  assert.equal(granted.status, 200)
  assert.deepEqual(await rig.send(bodies.seal), { status: 200, body: { ok: true, sealed: true, already: false } })
  const top = (await rig.storage.get(WORLD_HOLDER)).proofTs
  assert.equal(top, bodies.seal.proof.ts)
  // The same bodies a second time from A's own session: 409 PROOF_REPLAYED (it proved the key); from B's still 423.
  const replayed = { status: 409, body: { ok: false, code: 'PROOF_REPLAYED', after: top } }
  const held = rig.storage.snapshot()
  assert.deepEqual(await rig.send(bodies.acquire), replayed)
  assert.deepEqual(await rig.send(bodies.seal), replayed)
  assert.deepEqual(await rig.send(bodies.acquire, { as: B }), elsewhere)
  assert.deepEqual(rig.storage.snapshot(), held, 'a replay writes nothing')
  // A status is a read: asked again it still says `you`.
  assert.equal((await rig.send(bodies.status)).body.holder.you, true)
  // renew and release: once each.
  const renew = await signedBody(A, { action: 'renew', ...who(A), leaseId: granted.body.lease.leaseId })
  assert.deepEqual(await rig.send(renew, { as: B }), elsewhere)
  assert.equal((await rig.send(renew)).status, 200)
  assert.equal((await rig.send(renew)).body.code, 'PROOF_REPLAYED')
  const release = await signedBody(A, { action: 'release', ...who(A), leaseId: granted.body.lease.leaseId })
  assert.deepEqual((await rig.send(release)).body, { ok: true, released: true })
  assert.equal((await rig.send(release)).body.code, 'PROOF_REPLAYED')
  // A passkey-approved take, signed once: its repeat is refused before the passkey is asked.
  const take = await signedBody(A, { action: 'take', ...who(A) })
  assert.equal((await rig.send(take, { approval: true })).status, 200)
  const asked = rig.asked.length
  assert.equal((await rig.send(take, { approval: true })).body.code, 'PROOF_REPLAYED')
  assert.equal(rig.asked.length, asked)
  // A reserve by her body (its own key) is a credential request too.
  const again = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: [] })
  assert.equal((await rig.send(again)).status, 200)
  assert.equal((await rig.send(again)).body.code, 'PROOF_REPLAYED')
  // The browser never names the session itself.
  for (const body of [{ action: 'status', ...who(A), sid: sidA }, { ...bodies.acquire, sid: sidA }, { ...r.body.descriptor, sid: sidA }]) {
    assert.deepEqual(await rig.send(body), { status: 400, body: { ok: false, code: 'LEASE_REQUEST_INVALID' } })
  }
})

test('MUST 2a: with no session id from the Worker (a Worker without the REQUEST line, or another kind of access) no proof verifies: nothing can be claimed', async () => {
  const storage = fresh()
  const input = { action: 'reserve', ...who(A), expect: 0, checkpoint: null, log: await markOf(storage), accept: [], key: devices[A].key }
  const proof = await proofOf(devices[A], { ...input, sid: SID[A] })
  assert.deepEqual(await call(storage, { ...input, proof }), { status: 403, body: { ok: false, code: 'KEY_PROOF_INVALID', now: T0, sid: null } })
  assert.deepEqual(storage.snapshot(), {})
  // A status carries `sid: null` then (marked world or preview).
  assert.equal((await call(storage, { action: 'status', ...who(A), checkpoint: null })).body.sid, null)
})

test('MUST 3 through the mount: an uncertain passkey answer is 503 MOVE_OUTCOME_UNKNOWN ("may be spent"), never "no approval"; the same approval repeated finishes the move or tells the truth', async () => {
  const mayBeSpent = { status: 503, body: { ok: false, code: 'MOVE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'repeat the same move' } }
  // job 4: these commits carry no proof, so the answer is the holder's public summary, `you` absent.
  const claimed = { status: 200, body: { ok: true, holder: { label: 'Chrome on the Mac', generation: 1, since: T0, checkpoint: null, sealed: false } } }
  const start = async options => {
    const rig = mountRig(options)
    const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    assert.equal(reserved.status, 200)
    return { rig, descriptor: reserved.body.descriptor, token: rig.approveBody(reserved.body.descriptor) }
  }
  const unapprovedAfter = (rig, from) => rig.posts.slice(from).filter(p => p.body.ownerApproved === false).length
  for (const kind of ['lost', 'malformed', 'late']) {
    // HEAD consumed the approval, but its answer is lost, malformed or late.
    let fault = kind
    const { rig, descriptor, token } = await start({ answer: () => { const out = fault; fault = null; return out } })
    const from = rig.posts.length
    assert.deepEqual(await rig.send(descriptor, { token }), mayBeSpent, kind)
    assert.equal(rig.approvals.get(token).consumed, true)
    assert.equal(unapprovedAfter(rig, from), 1, `${kind}: only the first (preflight) send; no unapproved request in its place`)
    assert.equal(rig.posts.slice(from).filter(p => p.body.ownerApproved === true).length, 0)
    assert.equal((await rig.storage.get(WORLD_HOLDER)).body, null, 'nothing moved')
    // The repeat: HEAD says this approval was consumed for this very descriptor: the live reservation is committed.
    assert.deepEqual(await rig.send(descriptor, { token }), claimed, kind)
    assert.equal(rig.asked.length, 1, `${kind}: the passkey was asked once`)
  }
  {
    // Lost, then the reservation lapses: the edge knows nothing moved, HEAD that the approval was spent on it.
    const { rig, descriptor, token } = await start({ answer: () => 'lost' })
    assert.deepEqual(await rig.send(descriptor, { token }), mayBeSpent)
    tick(90001)
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 409, body: { ok: false, code: 'MOVE_APPROVAL_SPENT', moved: false, next: 'reserve and approve again' } })
    assert.equal(rig.asked.length, 1)
  }
  {
    // A clear refusal: nothing was spent; MIRROR judges the unapproved descriptor (403 while it is reserved).
    const { rig, descriptor, token } = await start({ answer: () => 'refused' })
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
    assert.equal(rig.approvals.get(token).consumed, false)
  }
  {
    // An approval consumed for a DIFFERENT body is never accepted for this one, and nothing is asked.
    const { rig, descriptor } = await start()
    const other = rig.approveBody({ ...descriptor, label: 'Elsewhere' })
    rig.approvals.get(other).consumed = true
    assert.deepEqual(await rig.send(descriptor, { token: other }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
    assert.deepEqual([rig.asked.length, (await rig.storage.get(WORLD_HOLDER)).body], [0, null])
    // An unused approval of another body: HEAD's own check refuses it (403); this descriptor still lives.
    const unused = rig.approveBody({ ...descriptor, label: 'Elsewhere too' })
    assert.deepEqual(await rig.send(descriptor, { token: unused }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
    assert.equal(rig.approvals.get(unused).consumed, false)
    // A bearer HEAD does not know: asked, refused, 403.
    assert.deepEqual(await rig.send(descriptor, { token: 'never-issued' }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
    // Its own approval commits.
    assert.deepEqual(await rig.send(descriptor, { approval: true }), claimed)
  }
  for (const reply of ['throw', new Response('{"ok":true,"approval":"maybe"}'), new Response('not json'), new Response('{}', { status: 503 })]) {
    // HEAD cannot say (unreachable, malformed, refused): 503 "may be spent", the passkey not asked, nothing forwarded approved.
    const { rig, descriptor, token } = await start({ inspect: () => (reply instanceof Response ? reply.clone() : reply) })
    assert.deepEqual(await rig.send(descriptor, { token }), mayBeSpent)
    assert.deepEqual([rig.asked.length, rig.approvals.get(token).consumed, rig.posts.filter(p => p.body.ownerApproved === true).length], [0, false, 0])
  }
  {
    // The inspection is asked over the exact descriptor bytes the passkey approves.
    const { rig, descriptor, token } = await start()
    assert.deepEqual(await rig.send(descriptor, { token }), claimed)
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_mirror/lease', body: descriptor })
    assert.deepEqual(rig.inspected, [binding.bodySha256])
  }
})

// The real HeadDO, for the inspection itself: a bound owner, a real approve ceremony with a synthetic passkey.
function headStorageInMemory() {
  let rows = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key), list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(rows)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = structuredClone(rows), output = await operation(view(copy)); rows = copy; return output })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

test('MUST 3 through the REAL HeadDO: /_head/class3-inspect answers unconsumed, then consumed for this exact action, other for another, none for an unknown bearer, unknown when unreadable; it writes nothing', async () => {
  const origin = 'https://holder-head.example.invalid', OWNER = 'owner@example.invalid'
  const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  const assertionFor = challenge => {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
    const auth = Buffer.alloc(37)
    createHash('sha256').update(new URL(origin).hostname).digest().copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(clientDataJSON).digest()]), passkey.privateKey)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
  }
  const at = Date.now()
  const storage = headStorageInMemory()
  const env = { PUBLIC_HOST: new URL(origin).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('no network in this test') } })
  // A seeded HEAD (the inspection, like the consumption beside it, answers only a seeded world).
  const code = 'export const fixture = true;', moduleSha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } }, modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [moduleSha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId, ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  await storage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: credentialId, counter: 0, publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const descriptor = { action: 'move', ...who(A), expect: 0, checkpoint: null, log: 'f'.repeat(64), accept: [], key: devices[A].key, copy: null, until: at + 90000 }
  const binding = await aumlokClass3Binding({ audience: origin, method: 'POST', pathname: '/_mirror/lease', body: descriptor })
  const context = { access: { type: 'owner', email: OWNER, expires: Math.floor(at / 1000) + 3600 } }
  const challenge = await head.aumlokStore.challenge({ purpose: 'approve', requestId: 'approve-1', binding }, origin, context)
  const approved = await head.aumlokStore.complete('approve', { challengeId: challenge.challengeId, credential: assertionFor(challenge.publicKey.challenge) }, origin, context)
  assert.equal(typeof approved.approvalToken, 'string', JSON.stringify(approved))
  const token = approved.approvalToken
  const internal = (path, body, headers = { 'x-x6-internal-authorized': '1' }) => head.fetch(new Request('https://x61.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  const inspect = async (body, headers) => { const response = await internal('/_head/class3-inspect', body, headers); return { status: response.status, body: await response.json() } }
  const verdict = approval => ({ status: 200, body: { ok: true, approval } })
  const before = await storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual(await inspect({ token, binding }), verdict('unconsumed'))
  assert.deepEqual(await storage.get(AUMLOK_STORAGE_KEY), before, 'the inspection writes nothing (no consumption, no audit row)')
  // The consumption beside it (the Worker's edgeClass3), then the same question.
  const consumed = await internal('/_head/class3-authorize', { token, binding })
  assert.equal(consumed.status, 200, await consumed.clone().text())
  const after = await storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual(await inspect({ token, binding }), verdict('consumed'))
  const other = await aumlokClass3Binding({ audience: origin, method: 'POST', pathname: '/_mirror/lease', body: { ...descriptor, label: 'Elsewhere' } })
  assert.deepEqual(await inspect({ token, binding: other }), verdict('other'))
  // job 4: a bearer of HEAD's own shape with no live record may be one whose history was discarded: never
  // none. Review: `forgotten` (HEAD read its store and keeps no live record), apart from `unknown` (its own read failed).
  // `none` only where HEAD can show it was never consumed: a bearer of a shape HEAD never issues, another origin.
  assert.deepEqual(await inspect({ token: randomBytes(32).toString('base64url'), binding }), verdict('forgotten'))
  assert.deepEqual(await inspect({ token: 'card-1', binding }), verdict('none'))
  assert.deepEqual(await inspect({ token, binding: { ...binding, audience: 'https://elsewhere.example.invalid' } }), verdict('none'))
  assert.deepEqual(await storage.get(AUMLOK_STORAGE_KEY), after, 'no inspection writes')
  // Without the internal mark (a public request never reaches HEAD's routes this way): 401.
  assert.equal((await internal('/_head/class3-inspect', { token, binding }, {})).status, 401)
  // A tampered approval record: the store's own check refuses it: unknown, never consumed.
  await storage.put(AUMLOK_STORAGE_KEY, { ...after, approvals: after.approvals.map(item => ({ ...item, recordMac: '0'.repeat(64) })) })
  assert.deepEqual(await inspect({ token, binding }), verdict('unknown'))
})

test('MUST 4, his sequence with main\'s own request shape: a passkey-approved take while another browser is her body (or a move is reserved) spends nothing', async () => {
  const rig = mountRig()
  const r = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(r.body.descriptor, { approval: true })).status, 200)
  const asked = rig.asked.length
  // job 4 (R1b): a holder-aware page signs every take in a claimed world with its OWN installation key (its status
  // showed it the holder); B, and B typing A's id (signed by B's key): refused before the passkey, nothing consumed.
  for (const body of [await signedBody(B, { action: 'take', ...who(B) }), await signedBody(B, { action: 'take', ...who(A) }, devices[B])]) {
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token, as: B }), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } })
    assert.deepEqual([rig.asked.length, rig.approvals.get(token).consumed], [asked, false], 'nothing asked, nothing consumed')
  }
  // Main's bundle sends exactly {action, clientId, tabId, label}; B, and B typing A's id. (Job 4 review, MUST 2: restored as
  // job 3 asserted it: every take with an approval is sent unapproved first, so nothing is asked and nothing consumed.)
  for (const body of [{ action: 'take', ...who(B) }, { action: 'take', ...who(A) }]) {
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token, as: B }), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } })
    assert.deepEqual([rig.asked.length, rig.approvals.get(token).consumed], [asked, false], 'nothing asked, nothing consumed')
  }
  // A move reserved: 423 MOVE_RESERVED, nothing asked, even for her own proven take.
  assert.equal((await rig.send(await rig.reserveBody(C, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] }))).status, 200)
  for (const body of [{ action: 'take', ...who(B) }, await signedBody(B, { action: 'take', ...who(B) }), await signedBody(A, { action: 'take', ...who(A) })]) {
    const token = rig.approveBody(body)
    const got = await rig.send(body, { token })
    assert.deepEqual([got.status, got.body.code], [423, 'MOVE_RESERVED'])
    assert.deepEqual([rig.asked.length, rig.approvals.get(token).consumed], [asked, false])
  }
  // Lapsed: her own proven take asks the passkey once and takes the lease.
  tick(90001)
  const mine = await rig.send(await signedBody(A, { action: 'take', ...who(A) }), { approval: true })
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.equal(rig.asked.length, asked + 1)
})

test('MUST 4 + job 4 R1e + review MUST 2: with no holder row, take through the Worker answers byte for byte as on be552705 and stores the same; with an approval header it adds exactly one unapproved MIRROR call that only reads, and asks the passkey only when that call says it is needed; the start-up read is the one other extra', async t => {
  const base = await loadAt(t, 'be552705', ['deploy/cloudflare/src/thread-mount.mjs', 'deploy/cloudflare/src/world-lease.mjs'])
  const reseed = withSeededRandom(t)
  const side = (mountModule, leaseModule, initial, homeFreeze, start = null) => {
    const ops = []
    const storage = createRollbackStorage(initial, { record: ops })
    // job 4 (R1e): the joined side's MIRROR started as mirror-do.mjs starts it: its operations are counted apart.
    const started = start ? start(storage) : null
    const startOps = [...ops]
    ops.length = 0
    const asked = [], calls = [], codes = []
    const fetch = async request => {
      const body = await request.json()
      calls.push(body.ownerApproved)
      const out = await leaseModule.leaseAction(storage, body.input, { now: clock.now, ownerApproved: body.ownerApproved === true, homeFreeze })
      codes.push(out.body.code ?? out.status)
      return Response.json(out.body, { status: out.status })
    }
    const env = { MIRROR: { idFromName: value => value, get: () => ({ fetch }) } }
    const mount = mountModule.createThreadMount()
    const send = async (body, { approval = null, verdict = 'ok' } = {}) => {
      const request = new Request(ORIGIN + '/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(approval ? { 'x-x6-class3-approval': approval } : {}) }, body: JSON.stringify(body) })
      const out = await mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner', session: sessionOf(body.clientId ?? A) }, now: () => clock.now,
        authorize: async card => { asked.push(card); if (verdict === 'refuse') throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }); return { expiresAt: clock.now + 60000 } } })
      return { status: out.status, text: await out.text(), headers: JSON.stringify([...out.headers].sort()) }
    }
    return { storage, ops, asked, calls, codes, send, started, startOps }
  }
  const tomb = { v: 1, clientId: C, state: 'retired', reason: 'idle', retiredAt: T0 - 1, lastSeenAt: T0 - 40 * 86400000, seq: 3, digest: 'd'.repeat(64), base: { lineageId: '12345678-1234-4234-8234-123456789abc', revision: 7 }, resurrectedAt: null }
  const worlds = [
    ['empty', {}, undefined],
    ['a live lease of C', { [LEASE]: { leaseId: cp(5), generation: 4, holder: { clientId: C, tabId: 'tab-c', label: 'Safari' }, acquiredAt: T0, seenAt: T0, expiresAt: T0 + 90000, asked: null } }, undefined],
    ['a pending home under HOME_FREEZE=enforce', { [PENDING]: { rescue: cp(9), clientId: A, since: T0 - 5, verifiedAt: T0 - 5 } }, 'enforce'],
    ['C retired', { [`world:v1:retired:${C}`]: tomb }, undefined],
    ['a malformed lease row', { [LEASE]: { garbage: true } }, undefined],
  ]
  let compared = 0
  const branches = { main: 0, asked: 0, answered: 0 }
  for (const [name, initial, homeFreeze] of worlds) {
    clock.now = T0
    const was = side(base['thread-mount'], base['world-lease'], initial, homeFreeze)
    const is = side({ createThreadMount }, { leaseAction }, initial, homeFreeze, holderStartUp)
    await is.started
    assert.deepEqual(is.startOps, [`get ${WORLD_HOLDER}`], 'the start-up: exactly one read, no transaction, no write')
    const requests = [
      [{ action: 'take', ...who(B) }, { approval: 'card' }],
      [{ action: 'take', ...who(C) }, { approval: 'card' }],
      [{ action: 'take', ...who(B) }, { approval: 'card', verdict: 'refuse' }],
      [{ action: 'take', ...who(B) }, {}],
      [{ action: 'take', ...who(B), ownerApproved: true }, { approval: 'card' }],
      [{ action: 'take', ...who(A) }, { approval: 'card' }],
    ]
    for (const [i, [body, options]] of requests.entries()) {
      tick(1000)
      const label = `${name}, request ${i} ${JSON.stringify(body)} ${JSON.stringify(options)}`
      was.ops.length = 0; is.ops.length = 0; was.calls.length = 0; is.calls.length = 0; is.codes.length = 0
      was.asked.length = 0; is.asked.length = 0
      reseed(1000 + i)
      const before = await was.send(body, options)
      reseed(1000 + i)
      const after = await is.send(body, options)
      assert.deepEqual(after, before, `the answer: ${label}`)
      assert.deepEqual(is.storage.snapshot(), was.storage.snapshot(), `MIRROR's storage: ${label}`)
      // Job 4 review: with an approval header (and no browser `ownerApproved`) the take is first sent unapproved.
      const preflight = Boolean(options.approval) && !Object.hasOwn(body, 'ownerApproved')
      branches[!preflight ? 'main' : is.codes[0] === 'CLASS3_WEBAUTHN_REQUIRED' ? 'asked' : 'answered']++
      if (!preflight) {
        assert.deepEqual([is.asked, is.calls, is.ops], [was.asked, was.calls, was.ops], `main's asks, calls and operations, exactly: ${label}`)
      } else if (is.codes[0] === 'CLASS3_WEBAUTHN_REQUIRED') {
        // The preflight says the passkey is needed: main's asks; then main's own call when the passkey approved (the
        // preflight's reads before it), or, when it refused, the preflight IS main's unapproved call.
        assert.deepEqual(is.asked, was.asked, `the passkey asks: ${label}`)
        assert.equal(is.calls[0], false, label)
        if (was.calls[0] === true) {
          assert.deepEqual(is.calls, [false, ...was.calls], `one unapproved call, then main's: ${label}`)
          const extra = is.ops.slice(0, is.ops.length - was.ops.length)
          assert.deepEqual(is.ops.slice(is.ops.length - was.ops.length), was.ops, `main's storage operations, in order: ${label}`)
          assert.ok(extra.length > 0 && extra.every(op => op.startsWith('get ')), `the preflight only reads: ${extra.join('; ')}`)
        } else assert.deepEqual([is.calls, is.ops], [was.calls, was.ops], `a refused passkey: main's call exactly: ${label}`)
      } else {
        // Any other answer is the answer (main's own, as the test above asserts), and nothing is asked: no fingerprint spent
        // for a refusal the passkey cannot change. One unapproved call, reads only.
        assert.deepEqual([is.asked, is.calls], [[], [false]], `nothing asked: ${label}`)
        assert.ok(was.asked.length === 1, `main asked (and spent) here: ${label}`)
        assert.ok(is.ops.every(op => op.startsWith('get ')), `the preflight only reads: ${is.ops.join('; ')}`)
      }
      compared++
    }
  }
  assert.equal(compared, 30)
  assert.deepEqual(branches, { main: 10, asked: 12, answered: 8 }, 'every path is walked')
})

test('MUST 5: a repeat of a move whose outcome may have left the last 16 is 409 MOVE_OUTCOME_FORGOTTEN (moved unknown, who holds her now); moved:false only when the edge knows', async () => {
  assert.equal(holder.WORLD_HOLDER_LIMITS.done, 16)
  const storage = fresh()
  const first = await reserve(storage, A, { expect: 0 })
  const D1 = first.body.descriptor
  assert.equal((await commit(storage, D1)).status, 200)
  // Another descriptor for the same step never applied: the kept outcome of generation 1 names D1.
  const notMoved = { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } }
  assert.deepEqual(await commit(storage, { ...D1, label: 'Elsewhere' }, false), notMoved)
  assert.deepEqual(await commit(storage, { ...D1, label: 'Elsewhere' }), { status: 409, body: { ok: false, code: 'MOVE_APPROVAL_SPENT', moved: false, next: 'reserve and approve again' } })
  // Sixteen more moves (each to another browser): generation 17; the outcome of generation 1 is no longer kept.
  let generation = 1
  for (let i = 0; i < 16; i++) {
    tick(1000)
    const r = await reserve(storage, [B, C, A][i % 3], { expect: generation, accept: ['not-newest'] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await commit(storage, r.body.descriptor)).status, 200)
    generation++
  }
  const row = await storage.get(WORLD_HOLDER)
  assert.deepEqual([row.generation, row.done.length, row.done[0].generation], [17, 16, 2])
  const forgotten = { status: 409, body: { ok: false, code: 'MOVE_OUTCOME_FORGOTTEN', moved: 'unknown', holder: { label: labelOf(row.body.clientId), since: row.body.since, generation: 17 } } }
  for (const approved of [false, true]) {
    assert.deepEqual(await commit(storage, D1, approved), forgotten, 'D1 applied, but the edge no longer keeps it')
    assert.deepEqual(await commit(storage, { ...D1, label: 'Elsewhere' }, approved), forgotten, 'nor whether this one did')
  }
  // Still known: a descriptor for generation 16 -> 17 that is not the kept one, and one for a step not yet made.
  const kept = row.done.at(-1)
  const lastStep = { ...D1, expect: 16, label: 'Elsewhere' }
  assert.notEqual(shaHex(holder.canonicalJson(lastStep)), kept.descriptorHash)
  assert.deepEqual(await commit(storage, lastStep, false), notMoved)
  assert.deepEqual(await commit(storage, { ...D1, expect: 17 }, false), notMoved)
  assert.deepEqual(await commit(storage, { ...D1, expect: 40 }, false), notMoved)
  assertClean(forgotten.body)
})

test('SHOULD 1: B re-reserving in a loop cannot stop the owner\'s approved reserve from A; an unapproved reserve keeps the growing wait', async () => {
  const rig = mountRig()
  // C is her body (then, say, it died). B, signed in without the passkey, keeps the next opening; A is his recovery browser.
  const c = await rig.send(await rig.reserveBody(C, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(c.body.descriptor, { approval: true })).status, 200)
  const reserveOf = async id => rig.reserveBody(id, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
  let live = 0, waits = 0
  for (let round = 0; round < 4; round++) {
    const b = await rig.send(await reserveOf(B))
    const asked = rig.asked.length
    // A, unapproved: refused while B's reservation lives, and in B's back-off alike; nothing asked.
    assert.equal((await rig.send(await reserveOf(A))).body.code, 'MOVE_RESERVED')
    assert.equal(rig.asked.length, asked)
    // A with the owner's passkey over its exact reserve body: never blocked.
    const won = await rig.send(await reserveOf(A), { approval: true })
    assert.equal(won.status, 200, JSON.stringify(won.body))
    assert.equal(rig.asked.length, asked + 1)
    if (b.status === 409) {
      // B was in the growing wait (the back-off): it does not hold the owner back either.
      assert.ok(b.body.code === 'MOVE_RESERVED' && b.body.wait > 0, JSON.stringify(b.body))
      waits++
    } else {
      // B held a live reservation: replaced. B's descriptor names no reservation any more; its move is refused unasked.
      assert.equal(b.status, 200, JSON.stringify(b.body))
      assert.equal((await rig.send(b.body.descriptor, { approval: true })).body.code, 'MOVE_NOT_RESERVED')
      assert.equal(rig.asked.length, asked + 1)
      live++
    }
    tick(90001)
  }
  assert.ok(live >= 2 && waits >= 2, `A's approved reserve replaced ${live} live reservations of B and won in ${waits} of B's waits`)
  // A clear passkey refusal of A's reserve leaves B's live reservation: 409 MOVE_RESERVED; a lost answer is 503, never 409.
  for (const [answer, expected] of [['refused', 409], ['lost', 503]]) {
    const other = mountRig({ answer: () => answer })
    const b = await other.send(await other.reserveBody(B, { expect: 0, checkpoint: null, log: await markOf(other.storage), accept: [] }))
    assert.equal(b.status, 200)
    const a = await other.send(await other.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(other.storage), accept: [] }), { approval: true })
    assert.deepEqual([a.status, a.body.code], [expected, expected === 409 ? 'MOVE_RESERVED' : 'APPROVAL_OUTCOME_UNKNOWN'])
    if (expected === 503) assert.deepEqual(a.body, { ok: false, code: 'APPROVAL_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'reserve again' })
    assert.equal((await other.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, B)
  }
  // Finally: A's approved reserve, then its approved move: A is her body.
  const won = await rig.send(await reserveOf(A), { approval: true })
  assert.equal(won.status, 200)
  assert.equal((await rig.send(won.body.descriptor, { approval: true })).status, 200)
  assert.equal((await rig.storage.get(WORLD_HOLDER)).body.clientId, A)
})

// ── Review follow-up. ───────────────────────────────────────────────────────────────────────────────────────

test('during B\'s live reservation an owner-approved reserve that would be refused anyway (accept, expect, log, unverified copy) asks nothing; the blocked preview names expect, needs and log', async () => {
  const rig = mountRig()
  // C is her body; B holds a live reservation; A is the owner's recovery browser.
  const c = await rig.send(await rig.reserveBody(C, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(c.body.descriptor, { approval: true })).status, 200)
  const log = await markOf(rig.storage)
  assert.equal((await rig.send(await rig.reserveBody(B, { expect: 1, checkpoint: null, log, accept: ['not-newest'] }))).status, 200)
  // The preview still says what a reserve must carry, beside the refusal.
  const seen = await rig.send({ action: 'status', ...who(A), checkpoint: null })
  assert.deepEqual(seen.body.move, { refused: 'MOVE_RESERVED', expect: 1, needs: ['not-newest'], log })
  const unverified = storeCopy(rig.bucket, { clientId: A, verified: false })
  const reservation = (await rig.storage.get(WORLD_HOLDER)).reservation
  const cases = [
    [{ expect: 1, checkpoint: null, log, accept: [] }, { status: 409, body: { ok: false, code: 'MOVE_NEEDS', needs: ['not-newest'] } }],
    [{ expect: 0, checkpoint: null, log, accept: ['not-newest'] }, { status: 409, body: { ok: false, code: 'HOLDER_MOVED', generation: 1 } }],
    [{ expect: 1, checkpoint: null, log: 'f'.repeat(64), accept: ['not-newest'] }, { status: 409, body: { ok: false, code: 'LOG_MOVED' } }],
    [{ expect: 1, checkpoint: unverified, log, accept: ['not-newest', 'unsealed'] }, { status: 409, body: { ok: false, code: 'CHECKPOINT_NOT_VERIFIED' } }],
  ]
  for (const [fields, expected] of cases) {
    const asked = rig.asked.length
    const body = await rig.reserveBody(A, fields)
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token }), expected, JSON.stringify(fields))
    assert.equal(rig.asked.length, asked, `no passkey asked for ${expected.body.code}`)
    assert.equal(rig.approvals.get(token).consumed, false, 'the approval is not spent')
    assert.deepEqual((await rig.storage.get(WORLD_HOLDER)).reservation, reservation, 'B\'s reservation untouched')
  }
  // The one that would pass: asked once, and it wins.
  const asked = rig.asked.length
  const won = await rig.send(await rig.reserveBody(A, { expect: 1, checkpoint: null, log, accept: ['not-newest'] }), { approval: true })
  assert.equal(won.status, 200, JSON.stringify(won.body))
  assert.equal(rig.asked.length, asked + 1)
})

test('a request whose owner access has no session (the owner pass) cannot prove her key; her own body is told sid null, never only "elsewhere"', async () => {
  const rig = mountRig()
  const r = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(r.body.descriptor, { approval: true })).status, 200)
  const acquire = await signedBody(A, { action: 'acquire', ...who(A) })
  // Her own body, signed in by the owner pass only: refused (fail closed), and the refusal says the session has no id.
  assert.deepEqual(await rig.send(acquire, { sessionless: true }), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown(), sid: null } })
  assert.equal((await rig.send({ action: 'status', ...who(A) }, { sessionless: true })).body.sid, null)
  // A request with no proof is answered as before (nothing about the session).
  assert.deepEqual(await rig.send({ action: 'acquire', ...who(B) }, { sessionless: true }), { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown() } })
  // With the passkey session the same body is hers.
  assert.equal((await rig.send(acquire)).status, 200)
})

test('a start-up whose marking write failed: slot retirement still spares her body, and her world\'s first lease request ends the old lease and marks the row, so the index shows her again', async t => {
  t.mock.method(Date, 'now', () => clock.now)
  const DAY = 86400000
  const idOf = i => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const LINEAGE = '12345678-1234-4234-8234-123456789abc'
  // A full client table in which A, her body, is the oldest idle browser.
  const ids = [A, ...Array.from({ length: 255 }, (_, i) => idOf(i + 1))]
  const ordered = ids.map((id, i) => [`mirror:v2:receipt:${id}:1`, { ok: true, clientId: id, seq: 1, id: `${id}:1`, digest: shaHex(id), lineageId: LINEAGE, revision: i + 1, acknowledgedAt: T0 - 400 * DAY + i }])
  const replay = { clients: new Map(ids.map(id => [id, { seq: 1, digest: shaHex(id) }])), receipts: new Map(ordered), ordered }
  // An older build wrote the lease row without the marker and granted B a lease on its typed id.
  const oldLease = { leaseId: cp(5), generation: 4, holder: { clientId: B, tabId: tabOf(B), label: labelOf(B) }, acquiredAt: T0, seenAt: T0, expiresAt: T0 + 90000, asked: null }
  const storage = fresh({ [WORLD_HOLDER]: holderRow(A, 1), [LEASE]: oldLease })
  const open = storage.transaction
  let failNext = true
  storage.transaction = fn => { if (failNext) { failNext = false; return Promise.reject(new Error('storage write failed')) } return open(fn) }
  await holderStartUp(storage)
  assert.deepEqual(await storage.get(LEASE), oldLease, 'the start-up could not mark the row')
  // Slot retirement decides on the holder row, not on the missing marker: A is spared, the next oldest goes.
  assert.equal((await storage.transaction(tx => retireClientSlot(tx, replay, { incomingClientId: C, now: T0 }))).retired, idOf(1))
  // The first lease request (any browser's status) repairs the row as the start-up would have.
  tick(1000)
  assert.equal((await lease(storage, 'status', B)).status, 200)
  assert.deepEqual(await storage.get(LEASE), { leaseId: null, generation: 4, holder: null, acquiredAt: null, seenAt: T0 + 1000, expiresAt: T0 + 1000, asked: null, onehome: true })
  assert.equal((await append(storage, { leaseId: cp(5), generation: 4 }, '{"b":1}\n')).status, 410, 'B\'s old lease writes nothing more')
  const index = await storage.transaction(async tx => worldStatus(tx, { lease: await leaseSummary(tx, clock.now), freeze: undefined }))
  assert.deepEqual(index.home.holder, { label: 'Chrome on the Mac', generation: 1, since: T0 - 20 })
  assert.equal((await own(storage, 'acquire', A)).status, 200)
  // A world with no holder row is never touched by the repair (main's operations): nothing written by a status.
  const plain = fresh({ [LEASE]: oldLease })
  await holderStartUp(plain)
  await lease(plain, 'status', B)
  assert.deepEqual(await plain.get(LEASE), oldLease)
})

// ── job 4: the outside reviewer's third HOLD (R1 to R5). ───────────────────────────────

/** One internal POST to the REAL MirrorDO's thread route (as thread-mount.mjs sends it). */
async function mirrorThread(mirror, op, input) {
  const response = await mirror.fetch(new Request('https://x61.internal/_mirror/thread', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': MIRROR_SEED }, body: JSON.stringify({ op, input }) }))
  return { status: response.status, body: await response.json() }
}
/** The append input of `text` at the end of PATH, read from `storage` (the thread log's own row). */
async function appendInput(storage, ref, text, threadPath = PATH) {
  const id = await threadIdForPath(threadPath)
  const t = await storage.get(`thread:v1:index:${id}`)
  const body = encoder.encode(text)
  return { lease: ref, id, path: threadPath, at: t ? t.bytes : 0, have: t ? `${t.chain}.${t.tailSha}` : `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`, bodySha: shaHex(body), body: bytesToBase64(body) }
}
/**
 * Her world claimed by A, then the reviewer's rollback: an earlier commit (no holder module) releases A's lease and grants B a live,
 * UNMARKED one on its typed id. Returns the storage (no MIRROR object running on it) and B's stolen lease reference.
 */
async function rolledBack(t) {
  const old = await loadAt(t, 'e728dce2', ['deploy/cloudflare/src/world-lease.mjs'])
  const storage = fresh(seededMirrorRows())
  const first = new MirrorDO({ storage }, {})
  const reserved = await mirrorLease(first, await signedInput(A, { action: 'reserve', expect: 0, checkpoint: null, log: await markOf(storage), accept: [], key: devices[A].key }))
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body))
  assert.equal((await mirrorLease(first, reserved.body.descriptor, true)).status, 200)
  const a = await mirrorLease(first, await signedInput(A, { action: 'acquire' }))
  assert.equal(a.status, 200)
  tick(1000)
  assert.deepEqual((await old['world-lease'].leaseAction(storage, { action: 'release', ...who(A), leaseId: a.body.lease.leaseId }, { now: clock.now })).body, { ok: true, released: true })
  const stolen = await old['world-lease'].leaseAction(storage, { action: 'acquire', ...who(B) }, { now: clock.now })
  assert.equal(stolen.status, 200)
  assert.equal(Object.hasOwn(await storage.get(LEASE), 'onehome'), false)
  return { storage, stolen: refOf(stolen) }
}
/** Make the holder row unreadable (a direct read and a read inside a transaction alike) while `down.holder` is true. */
function holderOutage(storage, down) {
  const get = storage.get
  storage.get = async key => { if (key === WORLD_HOLDER && down.holder) throw new Error('storage down'); return get(key) }
  const open = storage.transaction
  storage.transaction = fn => open(tx => {
    const read = tx.get
    tx.get = async key => { if (key === WORLD_HOLDER && down.holder) throw new Error('storage down'); return read(key) }
    return fn(tx)
  })
}

test('job 4 R2, his sequence: holder A, roll back, B granted an unmarked lease, roll forward, the start-up read fails ONCE: B appends before any lease request: refused; the index says the holder; A acquires', async t => {
  t.mock.method(Date, 'now', () => clock.now)
  const { storage, stolen } = await rolledBack(t)
  const down = { holder: true }
  holderOutage(storage, down)
  tick(1000)
  const restarted = new MirrorDO({ storage }, {})
  await restarted.queue
  down.holder = false // storage recovers: the read failed once, at start
  // B's FIRST request after the roll forward is a thread append with its old lease: the start-up state is unknown, so the
  // holder row is read again in that transaction; it is there: B's lease ends (as the start-up would have ended it): 410.
  const before = await storage.get(`thread:v1:index:${await threadIdForPath(PATH)}`)
  const appended = await mirrorThread(restarted, 'append', await appendInput(storage, stolen, '{"b":1}\n'))
  assert.deepEqual([appended.status, appended.body.code], [410, 'WRITER_GONE'], JSON.stringify(appended.body))
  assert.deepEqual(await storage.get(`thread:v1:index:${await threadIdForPath(PATH)}`), before, 'nothing B sent landed')
  const row = await storage.get(LEASE)
  assert.deepEqual([row.holder, row.onehome, row.generation], [null, true, stolen.generation], 'B\'s lease ended, the row marked')
  // The index says who her body is.
  const index = await mirrorThread(restarted, 'index', {})
  assert.equal(index.status, 200)
  assert.deepEqual(index.body.home.holder, holderShown(1, T0))
  assert.equal(index.body.lease, null)
  // A acquires with its proof; B is refused as any browser.
  assert.equal((await mirrorLease(restarted, await signedInput(A, { action: 'acquire' }))).status, 200)
  assert.equal((await mirrorLease(restarted, { action: 'acquire', ...who(B), sid: SID[B] })).body.code, 'HOLDER_ELSEWHERE')
})

test('job 4 R1a + R2: while the holder row stays unreadable after a failed start, B\'s append, the index, lease requests and retirement are refused 503 HOLDER_STATE_UNAVAILABLE (retry), never served on a guess; after recovery the first of them repairs', async t => {
  t.mock.method(Date, 'now', () => clock.now)
  const { storage, stolen } = await rolledBack(t)
  const down = { holder: true }
  holderOutage(storage, down)
  tick(1000)
  const restarted = new MirrorDO({ storage }, {})
  await restarted.queue
  const unavailable = { ok: false, code: 'HOLDER_STATE_UNAVAILABLE' }
  const held = storage.snapshot()
  const appended = await mirrorThread(restarted, 'append', await appendInput(storage, stolen, '{"b":1}\n'))
  assert.deepEqual(appended, { status: 503, body: unavailable })
  assert.deepEqual(await mirrorThread(restarted, 'index', {}), { status: 503, body: unavailable })
  assert.deepEqual(await mirrorLease(restarted, { action: 'status', ...who(B), sid: SID[B] }), { status: 503, body: unavailable })
  assert.deepEqual(await mirrorLease(restarted, { action: 'acquire', ...who(B), sid: SID[B] }), { status: 503, body: unavailable })
  assert.deepEqual(await storage.transaction(async tx => (await import('../world-lease.mjs')).leaseHolderClientId(tx)), { corrupt: true }, 'retirement retires nothing')
  assert.deepEqual(storage.snapshot(), held, 'nothing written while unknown')
  // Recovered: the next request (an index) asks again, ends B's lease, marks the row, and shows her.
  down.holder = false
  const index = await mirrorThread(restarted, 'index', {})
  assert.equal(index.status, 200, JSON.stringify(index.body))
  assert.deepEqual(index.body.home.holder, holderShown(1, T0))
  assert.equal((await storage.get(LEASE)).onehome, true)
  assert.equal((await mirrorThread(restarted, 'append', await appendInput(storage, stolen, '{"b":2}\n'))).status, 410)
  assert.equal((await mirrorLease(restarted, await signedInput(A, { action: 'acquire' }))).status, 200)
})

test('job 4 R1a: the start-up read has a 1 s deadline: a read that never answers holds MIRROR\'s first request at most that long, and the state is then unknown (asked again by the request itself)', async () => {
  assert.equal(HOLDER_START_LIMITS.readMs, 1000)
  const storage = fresh({ ...seededMirrorRows(), [WORLD_HOLDER]: holderRow(A, 1), [LEASE]: MARKED })
  const get = storage.get
  let hang = true
  storage.get = key => (key === WORLD_HOLDER && hang ? new Promise(() => {}) : get(key))
  const started = performance.now()
  const mirror = new MirrorDO({ storage }, {})
  hang = false
  const seen = await mirrorLease(mirror, { action: 'acquire', ...who(B), sid: SID[B] })
  const waited = performance.now() - started
  assert.ok(waited >= 900 && waited < 5000, `the first request waited ${Math.round(waited)} ms`)
  // The marked row decides here; an unmarked one would have had the holder row read again in this request.
  assert.deepEqual(seen, { status: 423, body: { ok: false, code: 'HOLDER_ELSEWHERE', holder: holderShown(1, T0 - 20) } })
})

test('job 4 R1e: an unclaimed world, started as MIRROR starts it: thread appends (and their final lease check), the index and slot retirement make exactly be552705\'s storage operations and answers', async t => {
  const base = await loadAt(t, 'be552705', ['deploy/cloudflare/src/world-lease.mjs', 'deploy/cloudflare/src/mirror-client-slots.mjs', 'deploy/cloudflare/src/world-home.mjs'])
  const DAY = 86400000
  const LINEAGE = '12345678-1234-4234-8234-123456789abc'
  const idOf = i => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const ids = [A, ...Array.from({ length: 255 }, (_, i) => idOf(i + 1))]
  const ordered = ids.map((id, i) => [`mirror:v2:receipt:${id}:1`, { ok: true, clientId: id, seq: 1, id: `${id}:1`, digest: shaHex(id), lineageId: LINEAGE, revision: i + 1, acknowledgedAt: T0 - 400 * DAY + i }])
  const replay = () => ({ clients: new Map(ids.map(id => [id, { seq: 1, digest: shaHex(id) }])), receipts: new Map(ordered), ordered })
  const liveLease = { leaseId: cp(5), generation: 4, holder: { clientId: A, tabId: tabOf(A), label: labelOf(A) }, acquiredAt: T0, seenAt: T0, expiresAt: T0 + 90000, asked: null }
  const oldOps = [], newOps = []
  const initial = { [LEASE]: liveLease }
  const oldStore = createRollbackStorage(initial, { record: oldOps })
  const newStore = createRollbackStorage(initial, { record: newOps })
  await holderStartUp(newStore)
  assert.deepEqual(newOps, [`get ${WORLD_HOLDER}`], 'the one read an unclaimed world pays, at start')
  clock.now = T0 + 1000
  const appendWith = (storage, lease, ref, text) => storage.transaction(async tx => {
    const id = await threadIdForPath(PATH)
    const row = await tx.get(`thread:v1:index:${id}`)
    const body = encoder.encode(text)
    const out = await threadCommit(tx, 'append', { lease: ref, id, path: PATH, at: row ? row.bytes : 0, have: row ? `${row.chain}.${row.tailSha}` : `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`, bodySha: shaHex(body), body: bytesToBase64(body) },
      { checkLease: (t2, r) => lease.checkLease(t2, r, clock.now, { mode: 'observe' }), budget: { charge: async () => ({ ok: true }) }, now: clock.now })
    // The final lease check, as MIRROR's thread route makes it (its transaction's last await).
    return { out, named: await lease.leaseStillNamed(tx, ref) }
  })
  const cases = [['her lease', { leaseId: cp(5), generation: 4 }], ['another lease id', { leaseId: cp(6), generation: 4 }], ['an old generation', { leaseId: cp(5), generation: 3 }]]
  for (const [name, ref] of cases) {
    oldOps.length = 0; newOps.length = 0
    const was = await appendWith(oldStore, base['world-lease'], ref, `{"${name}":1}\n`)
    const is = await appendWith(newStore, { checkLease, leaseStillNamed }, ref, `{"${name}":1}\n`)
    assert.deepEqual(is, was, name)
    assert.deepEqual(newOps, oldOps, `the append's operations: ${name}`)
  }
  oldOps.length = 0; newOps.length = 0
  const indexWas = await oldStore.transaction(async tx => base['world-home'].worldStatus(tx, { lease: await base['world-lease'].leaseSummary(tx, clock.now), freeze: undefined }))
  const indexIs = await newStore.transaction(async tx => worldStatus(tx, { lease: await leaseSummary(tx, clock.now), freeze: undefined }))
  assert.equal(JSON.stringify(indexIs), JSON.stringify(indexWas))
  assert.deepEqual(newOps, oldOps, 'the index\'s operations')
  oldOps.length = 0; newOps.length = 0
  const retiredWas = await oldStore.transaction(tx => base['mirror-client-slots'].retireClientSlot(tx, replay(), { incomingClientId: C, now: clock.now }))
  const retiredIs = await newStore.transaction(tx => retireClientSlot(tx, replay(), { incomingClientId: C, now: clock.now }))
  assert.deepEqual(retiredIs, retiredWas)
  assert.ok(retiredIs?.retired, 'a slot was retired')
  assert.deepEqual(newOps, oldOps, 'retirement\'s operations: no holder lookup')
  assert.equal(JSON.stringify(newStore.snapshot()), JSON.stringify(oldStore.snapshot()))
})

test('job 4 R3, take: a lost passkey answer is TAKE_OUTCOME_UNKNOWN, and the same body with the same approval finishes it through the inspection; a race after the consumption is APPROVAL_SPENT_NOTHING_CHANGED; never CLASS3_WEBAUTHN_REQUIRED after a consumption', async () => {
  const claimedRig = async options => {
    const rig = mountRig(options)
    const r = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    assert.equal((await rig.send(r.body.descriptor, { approval: true })).status, 200)
    return rig
  }
  {
    // His first sequence: A's valid take passes the preflight, HEAD consumes, its answer is lost.
    let fault = null
    const rig = await claimedRig({ answer: () => { const out = fault; fault = null; return out } })
    fault = 'lost'
    const take = await signedBody(A, { action: 'take', ...who(A) })
    const token = rig.approveBody(take)
    const first = await rig.send(take, { token })
    assert.deepEqual(first, { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'repeat the same take' } })
    assert.equal(rig.approvals.get(token).consumed, true)
    assert.equal(rig.posts.filter(p => p.body.ownerApproved === true && p.body.input.action === 'take').length, 0, 'MIRROR was not asked')
    // The repeat: HEAD refuses the used approval; the inspection says it was used for THIS body: the take is sent approved.
    const again = await rig.send(take, { token })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(rig.approvals.get(token).consumed, true)
    assert.equal((await rig.send(await signedBody(A, { action: 'status', ...who(A) }))).body.lease.label, labelOf(A))
    // Once more: its ts was used: the take may have landed: the status says (never "approve" or "nothing asked").
    assert.deepEqual(await rig.send(take, { token }), { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'spent', next: 'read the status' } })
  }
  {
    // His second sequence: the preflight passes; A's second tab acquires with a later ts; HEAD consumes; the take's ts is old.
    let rig = null
    const tabTwo = async () => { const got = await rig.send(await signedBody(A, { action: 'acquire', ...who(A), tabId: 'tab-two' })); assert.equal(got.status, 200) }
    let race = false
    rig = await claimedRig({ onApprove: () => { if (race) { race = false; return tabTwo() } } })
    const take = await signedBody(A, { action: 'take', ...who(A) })
    // The second tab's acquire must be signed AFTER the take (a greater ts): signedBody draws the next ts.
    const token = rig.approveBody(take)
    race = true
    const got = await rig.send(take, { token })
    assert.deepEqual(got, { status: 409, body: { ok: false, code: 'APPROVAL_SPENT_NOTHING_CHANGED', approval: 'spent', reason: 'PROOF_REPLAYED',
      next: 'Your approval was used and nothing changed, because another tab of this browser acted first. Approve again.' } })
    assert.equal(rig.approvals.get(token).consumed, true)
  }
  {
    // A clear refusal (an approval of another body): nothing spent, main's path: 403 from MIRROR.
    const rig = await claimedRig()
    const take = await signedBody(A, { action: 'take', ...who(A) })
    assert.deepEqual(await rig.send(take, { token: rig.approveBody({ ...take, label: 'Elsewhere' }) }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
    // HEAD cannot say on the repeat: unknown, never 403.
    const mode = { answer: null, inspect: null }
    const lost = await claimedRig({ answer: () => mode.answer, inspect: () => mode.inspect })
    mode.answer = 'lost'
    const body = await signedBody(A, { action: 'take', ...who(A) })
    const token = lost.approveBody(body)
    assert.equal((await lost.send(body, { token })).body.code, 'TAKE_OUTCOME_UNKNOWN')
    mode.inspect = 'unknown'
    assert.deepEqual(await lost.send(body, { token }), { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'repeat the same take' } })
  }
  {
    // A take without a proof (a world never claimed): the passkey's answer lost: nothing was taken (only the unapproved
    // preflight reached MIRROR, job 4 review MUST 2); its repeat is never resolved by the inspection (nothing would stop a
    // used approval from taking again): approve again.
    const rig = mountRig({ answer: () => 'lost' })
    const body = { action: 'take', ...who(B) }
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token }), { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'approve again' } })
    assert.deepEqual(rig.posts.map(p => p.body), [{ input: body, ownerApproved: false }], 'MIRROR was asked only the preflight')
    assert.equal(rig.inspected.length, 0, 'no inspection')
  }
})

test('job 4 R3, reserve: the owner\'s override whose answer was lost is never answered a plain MOVE_RESERVED on its repeat; a competing move after the consumption is APPROVAL_SPENT_NOTHING_CHANGED', async () => {
  const setUp = async options => {
    const rig = mountRig(options)
    const c = await rig.send(await rig.reserveBody(C, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    assert.equal((await rig.send(c.body.descriptor, { approval: true })).status, 200)
    const b = await rig.send(await rig.reserveBody(B, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] }))
    assert.equal(b.status, 200)
    return { rig, b: b.body.descriptor }
  }
  {
    let fault = null
    const { rig } = await setUp({ answer: () => { const out = fault; fault = null; return out } })
    fault = 'lost'
    const body = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token }), { status: 503, body: { ok: false, code: 'APPROVAL_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'reserve again' } })
    assert.equal((await rig.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, B, 'nothing changed yet')
    // The repeat reads the inspection first: consumed for this body, and the live reservation is not A's own (job 4
    // review, SHOULD: the brief's "answers unknown or spent"): spent, nothing changed; never re-sent, never MOVE_RESERVED.
    const asked = rig.asked.length
    assert.deepEqual(await rig.send(body, { token }), { status: 409, body: { ok: false, code: 'APPROVAL_SPENT_NOTHING_CHANGED', approval: 'spent', reason: 'MOVE_RESERVED',
      next: 'Your approval was used and nothing changed, because a move was reserved meanwhile. Approve again.' } })
    assert.equal(rig.asked.length, asked)
    assert.equal((await rig.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, B)
  }
  {
    // MIRROR reserved for A, and its answer was lost: the repeat finds A's OWN live reservation: renewed, no passkey again.
    const cut = []
    const { rig } = await setUp({ cut })
    cut.push('after')
    const body = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
    const token = rig.approveBody(body)
    assert.deepEqual(await rig.send(body, { token }), { status: 503, body: { ok: false, code: 'APPROVAL_OUTCOME_UNKNOWN', approval: 'spent', next: 'reserve again' } })
    assert.equal((await rig.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, A, 'it landed')
    const asked = rig.asked.length
    tick(1000)
    const again = await rig.send(body, { token })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.descriptor.clientId, A)
    assert.equal(Object.hasOwn(again.body, 'ownReservation'), false)
    assert.equal(rig.asked.length, asked)
  }
  {
    // HEAD cannot say on the repeat: unknown, never MOVE_RESERVED.
    let fault = null
    let inspection = null
    const { rig } = await setUp({ answer: () => { const out = fault; fault = null; return out }, inspect: () => inspection })
    fault = 'lost'
    const body = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
    const token = rig.approveBody(body)
    assert.equal((await rig.send(body, { token })).body.code, 'APPROVAL_OUTCOME_UNKNOWN')
    inspection = 'unknown'
    assert.deepEqual(await rig.send(body, { token }), { status: 503, body: { ok: false, code: 'APPROVAL_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'reserve again' } })
  }
  {
    // A competing move between the override's preflight and its execution: B's reservation is committed while the passkey
    // is asked: the approved reserve's expect is stale: HOLDER_MOVED after the consumption: spent, nothing changed.
    let rig = null, b = null, race = false
    ;({ rig, b } = await setUp({ onApprove: () => { if (race) { race = false; return leaseAction(rig.storage, b, { now: clock.now, ownerApproved: true }) } } }))
    const body = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
    const token = rig.approveBody(body)
    race = true
    assert.deepEqual(await rig.send(body, { token }), { status: 409, body: { ok: false, code: 'APPROVAL_SPENT_NOTHING_CHANGED', approval: 'spent', reason: 'HOLDER_MOVED',
      next: 'Your approval was used and nothing changed, because her body moved meanwhile. Approve again.' } })
    assert.equal(rig.approvals.get(token).consumed, true)
    assert.equal((await rig.storage.get(WORLD_HOLDER)).body.clientId, B)
  }
})

test('job 4 R3 + R4, move: a 503 after the consumption is MOVE_OUTCOME_UNKNOWN (spent) and the repeat commits; an approval whose record HEAD no longer holds is unknown, never "ask again"', async () => {
  const start = async options => {
    const rig = mountRig(options)
    const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    assert.equal(reserved.status, 200)
    return { rig, descriptor: reserved.body.descriptor, token: rig.approveBody(reserved.body.descriptor) }
  }
  {
    let broken = false
    const box = {}
    const s = await start({ onApprove: () => { if (broken) return box.rig.storage.put(WORLD_SEALED, 'unreadable') } })
    const rig = s.rig
    box.rig = rig
    broken = true
    assert.deepEqual(await rig.send(s.descriptor, { token: s.token }), { status: 503, body: { ok: false, code: 'MOVE_OUTCOME_UNKNOWN', approval: 'spent', next: 'repeat the same move' } })
    broken = false
    await rig.storage.delete(WORLD_SEALED)
    const again = await rig.send(s.descriptor, { token: s.token })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(rig.asked.length, 1, 'the passkey was asked once')
  }
  {
    // His R4 sequence at the Worker: consumed, the answer lost, then the approving device removed (HEAD no longer holds the
    // record): the inspection answers unknown: 503 "may be spent", the passkey is NOT asked again, nothing moved.
    let inspection = null, fault = 'lost'
    const { rig, descriptor, token } = await start({ answer: () => fault, inspect: () => inspection })
    assert.equal((await rig.send(descriptor, { token })).body.code, 'MOVE_OUTCOME_UNKNOWN')
    rig.approvals.delete(token)
    inspection = 'unknown'
    const asked = rig.asked.length
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 503, body: { ok: false, code: 'MOVE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'repeat the same move' } })
    assert.deepEqual([rig.asked.length, (await rig.storage.get(WORLD_HOLDER)).body], [asked, null])
    // A new approval of the same descriptor commits it.
    inspection = null
    fault = null
    assert.equal((await rig.send(descriptor, { approval: true })).status, 200)
  }
})

test('job 4 R4 through the REAL HeadDO: once its record is gone (the approving device removed) or no longer live (expired), the inspection is forgotten (review: HEAD answered, no live record), never none', async t => {
  const origin = 'https://holder-head.example.invalid', OWNER = 'owner@example.invalid'
  const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  const assertionFor = challenge => {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
    const auth = Buffer.alloc(37)
    createHash('sha256').update(new URL(origin).hostname).digest().copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(clientDataJSON).digest()]), passkey.privateKey)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
  }
  const real = Date.now()
  const time = { now: real }
  t.mock.method(Date, 'now', () => time.now)
  const storage = headStorageInMemory()
  const env = { PUBLIC_HOST: new URL(origin).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('no network in this test') } })
  const code = 'export const fixture = true;', moduleSha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } }, modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [moduleSha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId, ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  await storage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: credentialId, counter: 0, publicKeyB64 }, boundAt: real, lastVerifiedAt: real, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const descriptor = { action: 'move', ...who(A), expect: 0, checkpoint: null, log: 'f'.repeat(64), accept: [], key: devices[A].key, copy: null, until: real + 90000 }
  const binding = await aumlokClass3Binding({ audience: origin, method: 'POST', pathname: '/_mirror/lease', body: descriptor })
  const context = { access: { type: 'owner', email: OWNER, expires: Math.floor(real / 1000) + 3600 } }
  const challenge = await head.aumlokStore.challenge({ purpose: 'approve', requestId: 'approve-1', binding }, origin, context)
  const approved = await head.aumlokStore.complete('approve', { challengeId: challenge.challengeId, credential: assertionFor(challenge.publicKey.challenge) }, origin, context)
  const token = approved.approvalToken
  const internal = (path, body) => head.fetch(new Request('https://x61.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1' }, body: JSON.stringify(body) }))
  const inspect = async body => (await (await internal('/_head/class3-inspect', body)).json()).approval
  assert.equal((await internal('/_head/class3-authorize', { token, binding })).status, 200, 'consumed (its answer, say, lost on the way)')
  assert.equal(await inspect({ token, binding }), 'consumed')
  const consumed = await storage.get(AUMLOK_STORAGE_KEY)
  // The approving device removed: removal deletes its approvals with it (aumlok.mjs). The record is gone: unknown.
  await storage.put(AUMLOK_STORAGE_KEY, { ...consumed, approvals: [] })
  assert.equal(await inspect({ token, binding }), 'forgotten')
  // Expiry: the record kept but no longer live (past the approval's 5 minutes): forgotten.
  await storage.put(AUMLOK_STORAGE_KEY, consumed)
  time.now = real + 300001
  assert.equal(await inspect({ token, binding }), 'forgotten')
  // A bearer of a shape HEAD never issues, or a binding for another origin: HEAD can show it was never consumed: none.
  assert.equal(await inspect({ token: 'not-a-bearer', binding }), 'none')
  assert.equal(await inspect({ token, binding: { ...binding, audience: 'https://elsewhere.example.invalid' } }), 'none')
})

test('job 4 R5, his sequence: B submits A\'s captured descriptor (and its proof) with A\'s approval from B\'s session: the move commits (A\'s reservation, approved by the owner) and B is told no `you`; A\'s signed status says you:true, B\'s you:false', async t => {
  const rig = mountRig()
  const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal(reserved.status, 200)
  const descriptor = reserved.body.descriptor
  const token = rig.approveBody(descriptor)
  // A's page would send the descriptor with A's proof; B captured both, and the approval header.
  const captured = await signedBody(A, descriptor)
  const committed = await rig.send(captured, { token, as: B })
  assert.deepEqual(committed, { status: 200, body: { ok: true, holder: { label: 'Chrome on the Mac', generation: 1, since: T0, checkpoint: null, sealed: false } } })
  assert.equal(Object.hasOwn(committed.body.holder, 'you'), false)
  assert.equal((await rig.send(await signedBody(A, { action: 'status', ...who(A) }))).body.holder.you, true)
  assert.equal((await rig.send(await signedBody(B, { action: 'status', ...who(B) }))).body.holder.you, false)
  assert.equal((await rig.storage.get(WORLD_HOLDER)).body.clientId, A)
  // A's own page, with its proof in its own session: `you: true` on the commit itself.
  const own = mountRig()
  const mine = await own.send(await own.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(own.storage), accept: [] }))
  const sent = await signedBody(A, mine.body.descriptor)
  const done = await own.send(sent, { token: own.approveBody(mine.body.descriptor) })
  assert.deepEqual(done, { status: 200, body: { ok: true, holder: { label: 'Chrome on the Mac', generation: 1, since: T0, checkpoint: null, sealed: false, you: true } } })
  // The passkey approved the descriptor alone (the proof is not part of it), and MIRROR named the reservation by it.
  assert.deepEqual(own.asked, [mine.body.descriptor])
  // The largest honest move with its proof and the Worker's sid still fits MIRROR's 1,024 bytes.
  const maker = 'abcdef01-2345-4678-89ab-cdef01234567'
  const largest = { action: 'move', clientId: C, tabId: 'T'.repeat(64), label: '\u{1D538}'.repeat(48), expect: Number.MAX_SAFE_INTEGER, checkpoint: cp(1), log: 'f'.repeat(64),
    accept: ['not-newest', 'unsealed'], key: devices[C].key, copy: { verified: true, maker }, until: Number.MAX_SAFE_INTEGER, proof: { ts: Number.MAX_SAFE_INTEGER, sig: 'A'.repeat(86) }, sid: 'f'.repeat(32) }
  const wire = Buffer.byteLength(JSON.stringify({ input: largest, ownerApproved: false }))
  t.diagnostic(`largest honest move wrapper with its proof: ${wire} bytes`)
  assert.ok(wire <= 1024, String(wire))
})

// ── job 4 review (of bc786adc): each finding as a test that fails on bc786adc. ─────────────────────────────
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const claimedBy = async (rig, id) => {
  const r = await rig.send(await rig.reserveBody(id, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
  assert.equal((await rig.send(r.body.descriptor, { approval: true })).status, 200)
}
const spent = (reason, because) => ({ status: 409, body: { ok: false, code: 'APPROVAL_SPENT_NOTHING_CHANGED', approval: 'spent', reason,
  next: `Your approval was used and nothing changed, because ${because}. Approve again.` } })
const forgottenAnswer = { status: 409, body: { ok: false, code: 'APPROVAL_SPENT_NOTHING_CHANGED', approval: 'may be spent', reason: 'APPROVAL_FORGOTTEN',
  next: 'Your approval may have been used and nothing changed, because it is no longer on record. Approve again.' } }

test('job 4 review MUST 1, his sequence: in a world with no holder body, a take carrying a proof is never re-sent on a spent approval (three times): HEAD\'s refusal stands, the lease stays where the owner put it', async () => {
  const rig = mountRig()
  // X (B) sends a take with a proof nobody checks (no holder body: any signature of the right shape) and the owner's
  // approval of that exact body: it takes the lease, the passkey asked once.
  const x = { action: 'take', ...who(B), proof: { ts: clock.now, sig: 'A'.repeat(86) } }
  const token = rig.approveBody(x)
  assert.equal((await rig.send(x, { token })).status, 200)
  assert.equal(rig.asked.length, 1)
  // The owner then approves a take for Y (C): C holds the lease.
  assert.equal((await rig.send({ action: 'take', ...who(C) }, { approval: true })).status, 200)
  for (let round = 0; round < 3; round++) {
    tick(1000)
    const asked = rig.asked.length
    const approved = rig.posts.filter(post => post.body.ownerApproved === true).length
    assert.deepEqual(await rig.send(x, { token }), { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } }, `round ${round}`)
    assert.equal(rig.asked.length, asked + 1, 'HEAD was asked and refused the used approval')
    assert.equal(rig.posts.filter(post => post.body.ownerApproved === true).length, approved, 'nothing was sent approved')
    assert.equal((await rig.storage.get(LEASE)).holder.clientId, C, 'C still holds the lease')
  }
  assert.equal(await rig.storage.get(WORLD_HOLDER), undefined, 'no holder row written')
  assert.equal(rig.posts.some(post => Object.hasOwn(post.body.input, 'bodyProven')), false)
})

// A guard (it also passes on bc786adc): the fix of MUST 1 keeps her own body's lost-answer repeat.
test('job 4 review MUST 1: a take carrying her body\'s VALID proof in a claimed world still resolves a lost answer once (MIRROR\'s word bodyProven), and that word never reaches the browser', async () => {
  let fault = null
  const rig = mountRig({ answer: () => { const out = fault; fault = null; return out } })
  await claimedBy(rig, A)
  const take = await signedBody(A, { action: 'take', ...who(A) })
  const token = rig.approveBody(take)
  // Refused once by a clear refusal of another approval: the 403 the browser sees carries no bodyProven.
  const other = await rig.send(take, { token: rig.approveBody({ ...take, label: 'Elsewhere' }) })
  assert.deepEqual(other, { status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } })
  fault = 'lost'
  assert.equal((await rig.send(take, { token })).body.next, 'repeat the same take')
  const again = await rig.send(take, { token })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(Object.hasOwn(again.body, 'bodyProven'), false)
})

test('job 4 review SHOULD (reserve), his sequence: a spent override approval never displaces a later reservation the owner approved', async () => {
  const rig = mountRig()
  await claimedBy(rig, C)
  const fields = async () => ({ expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
  // Y (B) reserves unapproved; X's (A's) override is approved once: reserved for A.
  assert.equal((await rig.send(await rig.reserveBody(B, await fields()))).status, 200)
  const x = await rig.reserveBody(A, await fields())
  const token = rig.approveBody(x)
  assert.equal((await rig.send(x, { token })).status, 200)
  // The owner then approves Z's (D's) override: reserved for D.
  assert.equal((await rig.send(await rig.reserveBody(D, await fields(), stranger), { approval: true })).status, 200)
  assert.equal((await rig.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, D)
  // X re-sends its same body with its spent approval within the proof's 120 s: spent, nothing changed; D keeps it.
  tick(1000)
  const asked = rig.asked.length
  assert.deepEqual(await rig.send(x, { token }), spent('MOVE_RESERVED', 'a move was reserved meanwhile'))
  assert.equal(rig.asked.length, asked)
  assert.equal((await rig.storage.get(WORLD_HOLDER)).reservation.descriptor.clientId, D, 'D\'s reservation stands')
})

test('job 4 review SHOULD (move), his sequence: a lapsed move whose approval HEAD cannot account for (unknown or forgotten) says it may be spent; only HEAD\'s "never consumed" leaves MIRROR\'s plain answer', async () => {
  for (const seen of ['unknown', 'forgotten']) {
    let fault = 'lost', inspection = null
    const rig = mountRig({ answer: () => fault, inspect: () => inspection })
    const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    const descriptor = reserved.body.descriptor
    const token = rig.approveBody(descriptor)
    assert.equal((await rig.send(descriptor, { token })).body.code, 'MOVE_OUTCOME_UNKNOWN')
    fault = null
    tick(90001)
    inspection = seen
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, approval: 'may be spent', next: 'reserve and approve again' } }, seen)
    inspection = 'none'
    assert.deepEqual(await rig.send(descriptor, { token }), { status: 409, body: { ok: false, code: 'MOVE_NOT_RESERVED', moved: false, next: 'reserve' } })
    assert.equal((await rig.storage.get(WORLD_HOLDER))?.body ?? null, null, 'nothing moved')
  }
})

test('job 4 review SHOULD (forgotten): HEAD answered and keeps no record of the approval: a take or a live move says "may be spent, approve again", never "repeat"; a failed read still says repeat', async () => {
  {
    let fault = null, inspection = null
    const rig = mountRig({ answer: () => { const out = fault; fault = null; return out }, inspect: () => inspection })
    await claimedBy(rig, A)
    const take = await signedBody(A, { action: 'take', ...who(A) })
    const token = rig.approveBody(take)
    fault = 'lost'
    assert.equal((await rig.send(take, { token })).body.code, 'TAKE_OUTCOME_UNKNOWN')
    inspection = 'forgotten'
    assert.deepEqual(await rig.send(take, { token }), forgottenAnswer)
    inspection = 'unknown'
    assert.deepEqual(await rig.send(take, { token }), { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'repeat the same take' } })
  }
  {
    let fault = 'lost', inspection = null
    const rig = mountRig({ answer: () => fault, inspect: () => inspection })
    const reserved = await rig.send(await rig.reserveBody(A, { expect: 0, checkpoint: null, log: await markOf(rig.storage), accept: [] }))
    const token = rig.approveBody(reserved.body.descriptor)
    assert.equal((await rig.send(reserved.body.descriptor, { token })).body.code, 'MOVE_OUTCOME_UNKNOWN')
    fault = null
    inspection = 'forgotten'
    const asked = rig.asked.length
    assert.deepEqual(await rig.send(reserved.body.descriptor, { token }), forgottenAnswer)
    assert.deepEqual([rig.asked.length, (await rig.storage.get(WORLD_HOLDER)).body], [asked, null])
  }
  {
    // A reserve's repeat: forgotten is never re-sent and never asks.
    let inspection = null
    const rig = mountRig({ inspect: () => inspection })
    await claimedBy(rig, C)
    inspection = 'forgotten'
    assert.equal((await rig.send(await rig.reserveBody(B, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] }))).status, 200)
    const body = await rig.reserveBody(A, { expect: 1, checkpoint: null, log: await markOf(rig.storage), accept: ['not-newest'] })
    const asked = rig.asked.length
    assert.deepEqual(await rig.send(body, { token: rig.approveBody(body) }), forgottenAnswer)
    assert.equal(rig.asked.length, asked)
  }
})

test('job 4 review (three endings): an approved take without a proof whose MIRROR answer is lost says the approval was spent and the take may have landed; a refusal after the passkey says spent', async () => {
  for (const fault of ['before', 'after']) {
    const rig = mountRig({ cut: [fault] })
    const body = { action: 'take', ...who(B) }
    assert.deepEqual(await rig.send(body, { approval: true }), { status: 503, body: { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'spent', next: 'read the status' } }, fault)
    assert.equal((await rig.storage.get(LEASE))?.holder?.clientId ?? null, fault === 'after' ? B : null)
  }
  // B's browser is retired while the passkey is asked: the approved take is refused after the consumption.
  const box = {}
  const rig = mountRig({ onApprove: () => box.rig.storage.put(`world:v1:retired:${B}`, { v: 1, clientId: B, state: 'retired', reason: 'idle', retiredAt: T0 - 1,
    lastSeenAt: T0 - 40 * 86400000, seq: 3, digest: 'd'.repeat(64), base: { lineageId: '12345678-1234-4234-8234-123456789abc', revision: 7 }, resurrectedAt: null }) })
  box.rig = rig
  const got = await rig.send({ action: 'take', ...who(B) }, { approval: true })
  assert.deepEqual([got.status, got.body.code, got.body.approval, got.body.reason], [409, 'APPROVAL_SPENT_NOTHING_CHANGED', 'spent', 'CLIENT_SLOT_RETIRED'], JSON.stringify(got.body))
})

test('job 4 review SHOULD (session lookup): an owner-pass browser whose passkey session cannot be looked up now is told 503 retry, never "sign in with the passkey"; no session at all is still sid null', async () => {
  const rig = mountRig()
  await claimedBy(rig, A)
  const body = await signedBody(A, { action: 'acquire', ...who(A) })
  for (const lookup of [async () => ({ unavailable: true }), async () => ({ unavailable: true, bootstrap: true }), async () => { throw new Error('key read busy') }]) {
    const posts = rig.posts.length
    const headers = []
    assert.deepEqual(await rig.send(body, { access: { type: 'owner', sessionLookup: lookup }, headers }), { status: 503, body: { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' } })
    assert.deepEqual(headers, ['1'])
    assert.equal(rig.posts.length, posts, 'nothing forwarded')
  }
  const none = await rig.send(body, { access: { type: 'owner', sessionLookup: async () => null } })
  assert.deepEqual([none.status, none.body.code, none.body.sid], [423, 'HOLDER_ELSEWHERE', null])
  assert.equal((await rig.send(body, { access: { type: 'owner', sessionLookup: async () => ({ type: 'owner', session: sessionOf(A) }) } })).status, 200)
})
