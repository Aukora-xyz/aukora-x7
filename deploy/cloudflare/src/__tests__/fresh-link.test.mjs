/**
 * FRESH LINK v0 (EXPERIMENTAL, wired to nothing): the whole handshake between two synthetic identities, the frames and
 * the chained transcript, every tamper class, the peer rule, local misuse, and the rule that nothing imports the module.
 * Pure: no network, no storage, no paid call. The identities are made here from fixed seeds (test keys only).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { FRESHLINK_SUITES, identityId, initiate, initiatorFinish, respond, responderFinish } from '../fresh-link.mjs'

const FAILED = 'FRESHLINK_HANDSHAKE_FAILED'
const CONTEXT = new TextEncoder().encode('freshlink/v0')
const text = value => new TextEncoder().encode(value)
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
const hex = bytes => Buffer.from(bytes).toString('hex')

/** A synthetic long-term identity: the secret keys stay HERE; the library only ever sees `signer`. */
function identity(seedByte) {
  const edSecret = new Uint8Array(32).fill(seedByte)
  const ml = ml_dsa65.keygen(new Uint8Array(32).fill(seedByte ^ 0x5a))
  const publicKeys = { ed25519: ed25519.getPublicKey(edSecret), mlDsa65: ml.publicKey }
  const signWith = message => ({ ed25519: ed25519.sign(message, edSecret), mlDsa65: ml_dsa65.sign(message, ml.secretKey, { context: CONTEXT }) })
  return { publicKeys, signWith, signer: { publicKeys, sign: async message => signWith(message) }, idK: new Uint8Array([...publicKeys.ed25519, ...publicKeys.mlDsa65]) }
}

const ALICE = identity(0x11), BOB = identity(0x22), MALLORY = identity(0x33)
const ALICE_ID = await identityId(ALICE.idK), BOB_ID = await identityId(BOB.idK)
const accepts = id => async peerId => equal(peerId, id)

/** One whole handshake; `mutate` changes a message on the wire. Returns both sessions, or throws. */
async function handshake({ initiator = ALICE, responder = BOB, expectPeerId = BOB_ID, acceptInitiator = accepts(ALICE_ID), mutate = {}, allowSuites = [1] } = {}) {
  const started = await initiate({ suite: 1, signer: initiator.signer, expectPeerId })
  const m1 = mutate.m1 ? mutate.m1(started.m1) : started.m1
  const answered = await respond({ m1, signer: responder.signer, allowSuites, acceptPeer: acceptInitiator })
  const m2 = mutate.m2 ? mutate.m2(answered.m2) : answered.m2
  const finished = await initiatorFinish({ state: started.state, m2 })
  const m3 = mutate.m3 ? mutate.m3(finished.m3) : finished.m3
  const { session } = await responderFinish({ state: answered.state, m3 })
  return { i: finished.session, r: session, m1: started.m1, m2: answered.m2, m3: finished.m3 }
}

/** The one peer-caused refusal: one code, no detail, no cause, nothing but the code on the error. */
async function refused(promise, code = FAILED) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.deepEqual(Object.keys(error), ['code'])
    assert.equal(error.cause, undefined)
    return true
  })
}

const flip = (position, mask = 0x01) => bytes => { const copy = bytes.slice(); copy[position] ^= mask; return copy }
/** First, middle and last byte of every field, from a list of [name, size] (the middle only where it is a third byte). */
function positions(fields, offset = 0) {
  const out = []
  for (const [name, size] of fields) {
    out.push([`${name} first`, offset], [`${name} last`, offset + size - 1])
    if (size >= 3) out.push([`${name} middle`, offset + (size >> 1)])
    offset += size
  }
  return out
}
const SEALED = [['idK ed25519', 32], ['idK ml-dsa-65', 1952], ['signature ed25519', 64], ['signature ml-dsa-65', 3309], ['throwaway signature', 64], ['mac', 32], ['gcm tag', 16]]
const M1_FIELDS = [['magic', 2], ['version', 1], ['suite', 2], ['nI', 32], ['epk ml-kem', 1184], ['epk x25519', 32], ['throwaway key', 32]]
const M2_FIELDS = [['ct ml-kem', 1088], ['ct x25519', 32], ['nR', 32], ['throwaway key', 32], ...SEALED]

test('the menu: one frozen suite, 0x0001; the sizes are the brief\'s', async () => {
  assert.equal(FRESHLINK_SUITES.length, 1)
  assert.ok(Object.isFrozen(FRESHLINK_SUITES) && Object.isFrozen(FRESHLINK_SUITES[0]))
  assert.equal(FRESHLINK_SUITES[0].id, 0x0001)
  const run = await handshake()
  assert.equal(run.m1.length, 1285)
  assert.equal(run.m2.length, 1184 + 5453 + 16)
  assert.equal(run.m3.length, 5453 + 16)
  assert.deepEqual([...run.m1.subarray(0, 5)], [0x46, 0x4c, 0x00, 0x00, 0x01])
})

test('a whole handshake: the same session id and keys on both sides, the right peer ids, ten frames each way, one transcript', async () => {
  const { i, r, m1, m2 } = await handshake()
  assert.ok(equal(i.id, r.id) && i.id.length === 32)
  assert.ok(equal(i.peerId, BOB_ID) && equal(r.peerId, ALICE_ID))
  assert.ok(equal(r.peerThrowawayKey, m1.subarray(1253, 1285)) && equal(i.peerThrowawayKey, m2.subarray(1152, 1184)))
  for (let n = 0; n < 10; n++) {
    const there = await i.send(text(`to bob ${n}`), text('meta'))
    assert.equal(new TextDecoder().decode(await r.receive(there, text('meta'))), `to bob ${n}`)
    const back = await r.send(text(`to alice ${n}`))
    assert.equal(new TextDecoder().decode(await i.receive(back)), `to alice ${n}`)
  }
  const both = await i.transcript()
  assert.equal(both.length, 32)
  assert.ok(equal(both, await r.transcript()))
  assert.match(await i.fingerprint(), /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
  assert.equal(await i.fingerprint(), await r.fingerprint())
  assert.equal(await i.fingerprint(), [hex(both.subarray(0, 2)), hex(both.subarray(2, 4)), hex(both.subarray(4, 6))].join('-'))
  // One more frame: the sender's transcript moves at once, the receiver's when it has handled it.
  const extra = await i.send(text('one more'))
  assert.ok(!equal(await i.transcript(), both))
  assert.ok(!equal(await i.transcript(), await r.transcript()))
  await r.receive(extra)
  assert.ok(equal(await i.transcript(), await r.transcript()))
  // The same keys both ways: a frame under the wrong caller aad or to the wrong direction does not open.
  const wrongAad = await i.send(text('x'), text('a'))
  await refused(r.receive(wrongAad, text('b')), 'FRESHLINK_FRAME_FAILED')
})

test('every byte class of m1, m2 and m3 tampered: the one code, and no session exists', async () => {
  const cases = [
    ...positions(M1_FIELDS).map(([name, at]) => [`m1 ${name}`, { m1: flip(at) }]),
    ...positions(M2_FIELDS).map(([name, at]) => [`m2 ${name}`, { m2: flip(at) }]),
    ...positions(SEALED).map(([name, at]) => [`m3 ${name}`, { m3: flip(at) }]),
    ['m1 one byte short', { m1: bytes => bytes.subarray(0, 1284) }], ['m1 one byte long', { m1: bytes => new Uint8Array([...bytes, 0]) }],
    ['m2 one byte short', { m2: bytes => bytes.subarray(0, bytes.length - 1) }], ['m3 one byte long', { m3: bytes => new Uint8Array([...bytes, 0]) }],
    ['m1 not bytes', { m1: () => 'FL' }], ['m2 empty', { m2: () => new Uint8Array(0) }],
  ]
  assert.ok(cases.length >= 77, String(cases.length))
  for (const [name, mutate] of cases) {
    let sessions = null
    await assert.rejects(handshake({ mutate }).then(made => { sessions = made }), error => {
      assert.equal(error.code, FAILED, name)
      assert.deepEqual(Object.keys(error), ['code'], name)
      return true
    }, name)
    assert.equal(sessions, null, name)
  }
})

test('the X25519 public key bit X25519 ignores is still bound: flipping the top bit of epk refuses', async () => {
  await refused(handshake({ mutate: { m1: flip(1252, 0x80) } }))
})

test('a signature dropped (zeroed), either one, from either side: refused', async () => {
  const dropping = (who, which) => ({ ...who, signer: { publicKeys: who.publicKeys, sign: async message => ({ ...who.signWith(message), [which]: new Uint8Array(which === 'ed25519' ? 64 : 3309) }) } })
  for (const which of ['ed25519', 'mlDsa65']) {
    await refused(handshake({ responder: dropping(BOB, which) }))
    await refused(handshake({ initiator: dropping(ALICE, which) }))
  }
})

test('signatures swapped between roles (made under the other role\'s label) and m2\'s signatures reflected in m3: refused', async () => {
  const relabel = (who, from, to) => ({ ...who, signer: { publicKeys: who.publicKeys, sign: async message => {
    const head = text(from)
    assert.ok(equal(message.subarray(0, head.length), head))
    return who.signWith(new Uint8Array([...text(to), ...message.subarray(head.length)]))
  } } })
  await refused(handshake({ responder: relabel(BOB, 'freshlink/v0 sig R\0', 'freshlink/v0 sig I\0') }))
  await refused(handshake({ initiator: relabel(ALICE, 'freshlink/v0 sig I\0', 'freshlink/v0 sig R\0') }))
  // Reflection: one identity on both sides (so the keys match), and the initiator answers with what the responder signed.
  let captured = null
  const responder = { ...ALICE, signer: { publicKeys: ALICE.publicKeys, sign: async message => (captured = ALICE.signWith(message)) } }
  const reflector = { ...ALICE, signer: { publicKeys: ALICE.publicKeys, sign: async () => captured } }
  await refused(handshake({ initiator: reflector, responder, expectPeerId: ALICE_ID, acceptInitiator: accepts(ALICE_ID) }))
  // The control: the same shared identity, signing honestly, completes.
  const fine = await handshake({ initiator: ALICE, responder: ALICE, expectPeerId: ALICE_ID, acceptInitiator: accepts(ALICE_ID) })
  assert.ok(equal(fine.i.id, fine.r.id))
})

test('the peer rule is never implicit: an unexpected peer fails on either side; there is no default that accepts anyone', async () => {
  await refused(handshake({ responder: MALLORY }))
  await refused(handshake({ initiator: MALLORY }))
  await refused(handshake({ acceptInitiator: async () => 1 }))
  await refused(handshake({ acceptInitiator: async () => { throw new Error('no') } }))
  await refused(initiate({ suite: 1, signer: ALICE.signer }), 'FRESHLINK_PEER_RULE_REQUIRED')
  await refused(initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID, acceptPeer: async () => true }), 'FRESHLINK_PEER_RULE_REQUIRED')
  await refused(initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID.subarray(0, 31) }), 'FRESHLINK_PEER_RULE_REQUIRED')
  const { m1 } = await initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID })
  await refused(respond({ m1, signer: BOB.signer, allowSuites: [1] }), 'FRESHLINK_PEER_RULE_REQUIRED')
  // An initiator that names its peer by an acceptPeer function: it is called with the id and the identity keys.
  const calls = []
  const started = await initiate({ suite: 1, signer: ALICE.signer, acceptPeer: async (id, idK) => { calls.push([hex(id), hex(idK)]); return true } })
  const answered = await respond({ m1: started.m1, signer: BOB.signer, allowSuites: [1], acceptPeer: accepts(ALICE_ID) })
  await initiatorFinish({ state: started.state, m2: answered.m2 })
  assert.deepEqual(calls, [[hex(BOB_ID), hex(BOB.idK)]])
})

test('a suite not allowed or not on the menu fails with the one code; no negotiation, no fallback', async () => {
  const suite = id => bytes => { const copy = bytes.slice(); copy[3] = id >> 8; copy[4] = id & 0xff; return copy }
  const { m1 } = await initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID })
  for (const id of [0x0000, 0x0002, 0x0100, 0xffff]) {
    // The responder itself refuses (not only the transcript later).
    await refused(respond({ m1: suite(id)(m1), signer: BOB.signer, allowSuites: [1], acceptPeer: accepts(ALICE_ID) }))
    await refused(handshake({ mutate: { m1: suite(id) } }))
  }
  for (const at of [0, 1, 2]) await refused(respond({ m1: flip(at)(m1), signer: BOB.signer, allowSuites: [1], acceptPeer: accepts(ALICE_ID) }))
  await refused(handshake({ allowSuites: [] }), 'FRESHLINK_INPUT_INVALID')
  await refused(handshake({ allowSuites: [2] }), 'FRESHLINK_INPUT_INVALID')
  await refused(initiate({ suite: 2, signer: ALICE.signer, expectPeerId: BOB_ID }), 'FRESHLINK_SUITE_UNKNOWN')
})

test('a frame repeated, skipped, reordered or tampered kills the session for good', async () => {
  const fresh = async () => { const { i, r } = await handshake(); return { i, r, f0: await i.send(text('zero')), f1: await i.send(text('one')), f2: await i.send(text('two')) } }
  { // repeated
    const { r, f0, f1 } = await fresh()
    await r.receive(f0)
    await refused(r.receive(f0), 'FRESHLINK_FRAME_FAILED')
    await refused(r.receive(f1), 'FRESHLINK_SESSION_CLOSED')
  }
  { // skipped
    const { r, f0, f1 } = await fresh()
    await refused(r.receive(f1), 'FRESHLINK_FRAME_FAILED')
    await refused(r.receive(f0), 'FRESHLINK_SESSION_CLOSED')
  }
  { // reordered
    const { r, f0, f1, f2 } = await fresh()
    await r.receive(f0)
    await refused(r.receive(f2), 'FRESHLINK_FRAME_FAILED')
    await refused(r.receive(f1), 'FRESHLINK_SESSION_CLOSED')
    await refused(r.send(text('after')), 'FRESHLINK_SESSION_CLOSED')
  }
  const { f0 } = await fresh()
  const frameAt = positions([['counter', 8], ['ciphertext', 4], ['gcm tag', 16]])
  assert.equal(f0.length, 8 + 4 + 16)
  for (const [name, at] of frameAt) {
    const { r, f0: genuine } = await fresh()
    await refused(r.receive(flip(at)(genuine)), 'FRESHLINK_FRAME_FAILED')
    await refused(r.receive(genuine), 'FRESHLINK_SESSION_CLOSED').catch(error => { throw new Error(`${name}: ${error.message}`) })
  }
  { // too short, and not bytes
    const { r } = await fresh()
    await refused(r.receive(new Uint8Array(23)), 'FRESHLINK_FRAME_FAILED')
    const other = await fresh()
    await refused(other.r.receive('frame'), 'FRESHLINK_FRAME_FAILED')
  }
  { // a frame of one session is refused by another
    const a = await fresh(), b = await fresh()
    await refused(b.r.receive(a.f0), 'FRESHLINK_FRAME_FAILED')
  }
  { // a frame sent back to its own sender (wrong direction)
    const { i, f0 } = await fresh()
    await refused(i.receive(f0), 'FRESHLINK_FRAME_FAILED')
  }
})

test('a state is single use, and a state of the other role is refused; close() ends the session', async () => {
  const started = await initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID })
  const answered = await respond({ m1: started.m1, signer: BOB.signer, allowSuites: [1], acceptPeer: accepts(ALICE_ID) })
  await refused(initiatorFinish({ state: answered.state, m2: answered.m2 }), 'FRESHLINK_STATE_INVALID')
  await refused(responderFinish({ state: started.state, m3: new Uint8Array(5469) }), 'FRESHLINK_STATE_INVALID')
  await refused(initiatorFinish({ state: {}, m2: answered.m2 }), 'FRESHLINK_STATE_INVALID')
  const { m3, session } = await initiatorFinish({ state: started.state, m2: answered.m2 })
  await refused(initiatorFinish({ state: started.state, m2: answered.m2 }), 'FRESHLINK_STATE_USED')
  await responderFinish({ state: answered.state, m3 })
  await refused(responderFinish({ state: answered.state, m3 }), 'FRESHLINK_STATE_USED')
  // A failed finish uses the state up too: no second try on the same state.
  const s2 = await initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID })
  const a2 = await respond({ m1: s2.m1, signer: BOB.signer, allowSuites: [1], acceptPeer: accepts(ALICE_ID) })
  await refused(initiatorFinish({ state: s2.state, m2: flip(2000)(a2.m2) }))
  await refused(initiatorFinish({ state: s2.state, m2: a2.m2 }), 'FRESHLINK_STATE_USED')
  // State objects carry nothing readable.
  assert.deepEqual(Object.keys(s2.state), [])
  session.close()
  await refused(session.send(text('x')), 'FRESHLINK_SESSION_CLOSED')
  await refused(session.transcript(), 'FRESHLINK_SESSION_CLOSED')
})

test('close() while a send or a receive is already in flight: neither returns a frame or plaintext after close', async () => {
  // Every pause from "not started yet" to "long finished": microtask turns, then event-loop turns (WebCrypto settles there).
  const pauses = [...Array.from({ length: 13 }, (_, n) => ({ ticks: n, turns: 0 })), ...Array.from({ length: 8 }, (_, n) => ({ ticks: 0, turns: n + 1 }))]
  const pause = async ({ ticks, turns }) => {
    for (let n = 0; n < ticks; n++) await Promise.resolve()
    for (let n = 0; n < turns; n++) await new Promise(resolve => setImmediate(resolve))
  }
  let pendingAtClose = 0, settledBeforeClose = 0
  for (const when of pauses) {
    const { i, r } = await handshake()
    const inbound = await i.send(text('to be received'))
    const ops = [['send', i.send(text('in flight'))], ['receive', r.receive(inbound)]].map(([name, pending]) => {
      const op = { name, settled: false }
      op.outcome = pending.then(() => 'returned', error => error.code).finally(() => { op.settled = true })
      return op
    })
    await pause(when)
    const settledAtClose = ops.map(op => op.settled)
    i.close()
    r.close()
    for (const [n, op] of ops.entries()) {
      const outcome = await op.outcome
      if (settledAtClose[n]) { settledBeforeClose++; assert.equal(outcome, 'returned', `${op.name} finished before close`); continue }
      pendingAtClose++
      // Not finished when close() ran: it must not hand back a frame or plaintext afterwards.
      assert.equal(outcome, 'FRESHLINK_SESSION_CLOSED', `${op.name} after ${JSON.stringify(when)}`)
    }
    await refused(i.transcript(), 'FRESHLINK_SESSION_CLOSED')
  }
  // The pauses reach both sides of the race: some operations were still pending at close, some had finished.
  assert.ok(pendingAtClose >= 20 && settledBeforeClose >= 2, `${pendingAtClose} pending, ${settledBeforeClose} settled`)
})

test('local misuse has its own codes and no key material in any error', async () => {
  await refused(initiate({ suite: 1, signer: { publicKeys: { ed25519: new Uint8Array(31), mlDsa65: new Uint8Array(1952) }, sign: async () => ({}) }, expectPeerId: BOB_ID }), 'FRESHLINK_SIGNER_INVALID')
  await refused(initiate({ suite: 1, signer: { publicKeys: ALICE.publicKeys }, expectPeerId: BOB_ID }), 'FRESHLINK_SIGNER_INVALID')
  await refused(initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID, random: n => new Uint8Array(n - 1) }), 'FRESHLINK_RANDOM_INVALID')
  const shortSigner = { publicKeys: BOB.publicKeys, sign: async message => ({ ...BOB.signWith(message), ed25519: new Uint8Array(63) }) }
  const { m1 } = await initiate({ suite: 1, signer: ALICE.signer, expectPeerId: BOB_ID })
  await refused(respond({ m1, signer: shortSigner, allowSuites: [1], acceptPeer: accepts(ALICE_ID) }), 'FRESHLINK_SIGNER_INVALID')
  const { i } = await handshake()
  await refused(i.send('not bytes'), 'FRESHLINK_INPUT_INVALID')
  await refused(i.send(text('x'), 'aad'), 'FRESHLINK_INPUT_INVALID')
  await i.send(text('still alive after local misuse'))
})

test('two runs with real randomness share no key, nonce or throwaway key', async () => {
  const a = await handshake(), b = await handshake()
  const parts = run => ({ nI: run.m1.subarray(5, 37), epk: run.m1.subarray(37, 1253), tI: run.m1.subarray(1253, 1285),
    ct: run.m2.subarray(0, 1120), nR: run.m2.subarray(1120, 1152), tR: run.m2.subarray(1152, 1184), m2b: run.m2.subarray(1184), m3: run.m3, id: run.i.id })
  const pa = parts(a), pb = parts(b)
  for (const name of Object.keys(pa)) assert.ok(!equal(pa[name], pb[name]), name)
  assert.ok(!equal(pa.tI, pa.tR) && !equal(pb.tI, pb.tR))
  // The keys differ: a frame of one run does not open in the other (checked in the frame test); and the ids differ.
  const fa = await a.i.send(text('same words')), fb = await b.i.send(text('same words'))
  assert.ok(!equal(fa, fb))
})

test('wired to nothing: no file in the repository imports or names fresh-link.mjs except its own tests and docs, and the Worker graph does not reach it', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '../../../..')
  const own = new Set(['deploy/cloudflare/src/fresh-link.mjs', 'deploy/cloudflare/src/fresh-link.vectors.json', 'docs/auma/fresh-link.md'])
  const ownTest = path => /^deploy\/cloudflare\/src\/__tests__\/fresh-link[^/]*\.test\.mjs$/.test(path)
  const SOURCE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|json|jsonc|toml|ya?ml|html)$/
  // The one place outside this lane that may NAME the module: the verifier census in proof-failure-rule.test.mjs, which
  // must classify every file that calls a verifier. Only its single NOT_IDENTITY entry line is set aside; any other
  // mention in that file, and any import of the module from it, still fails below.
  const CLASSIFIED = new Map([['deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs', /^[ \t]*'fresh-link\.mjs':[ \t]*'[^'\n]*',?[ \t]*$/gm]])
  const IMPORTING = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])[^'"`\n]*fresh-?link[^'"`\n]*\1/i
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean)
  const naming = [], importing = []
  for (const path of tracked) {
    if (!SOURCE.test(path) || own.has(path) || ownTest(path)) continue
    let body
    try { body = readFileSync(join(root, path), 'utf8') } catch { continue }
    if (IMPORTING.test(body)) importing.push(path)
    const entry = CLASSIFIED.get(path)
    const rest = entry ? body.replace(entry, '') : body
    if (/fresh-link|freshlink/i.test(rest)) naming.push(path)
  }
  assert.deepEqual(importing, [])
  assert.deepEqual(naming, [])
  // The set-aside bites: the census line alone is allowed, an import or a second mention in the same file is not.
  const census = "const NOT_IDENTITY = {\n  'fresh-link.mjs': 'experimental, imported by nothing',\n}\n"
  const [censusPath, censusEntry] = [...CLASSIFIED][0]
  assert.ok(!/fresh-link|freshlink/i.test(census.replace(censusEntry, '')))
  assert.ok(/fresh-link|freshlink/i.test(`${census}// see freshlink docs\n`.replace(censusEntry, '')), censusPath)
  assert.ok(IMPORTING.test(`${census}import { initiate } from '../fresh-link.mjs'\n`))
  assert.ok(IMPORTING.test("const m = await import('./fresh-link.mjs')") && IMPORTING.test("require(`../src/fresh-link.mjs`)"))
  // The Worker's static and dynamic relative import graph from worker.mjs.
  const start = join(root, 'deploy/cloudflare/src/worker.mjs'), seen = new Set(), queue = [start]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let body
    try { body = readFileSync(file, 'utf8') } catch { continue }
    for (const match of body.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) queue.push(join(dirname(file), match[2]))
  }
  assert.ok(seen.size > 20, String(seen.size))
  const reached = [...seen].map(file => relative(root, file))
  assert.ok(reached.includes('deploy/cloudflare/src/owner-grant-policy.mjs'), 'the walk follows imports')
  assert.equal(reached.filter(path => path.includes('fresh-link')).length, 0)
})
