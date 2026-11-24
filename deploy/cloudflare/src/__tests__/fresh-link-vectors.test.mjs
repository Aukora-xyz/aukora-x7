/**
 * FRESH LINK v0 (EXPERIMENTAL, wired to nothing): the vectors, checked TWO ways.
 *   1. The three official X-Wing vectors (draft-connolly-cfrg-xwing-kem-11, copied into fresh-link.vectors.json), byte for
 *      byte through @noble/post-quantum, and what that library does with a malformed or all-zero X25519 public key.
 *   2. A SECOND, INDEPENDENT implementation of the whole protocol in this file, built on node:crypto (createHash,
 *      createHmac, hkdfSync, createCipheriv) and the noble primitives only, never on fresh-link.mjs's helpers. It
 *      recomputes every value in the file from the file's fixed randomness and recorded signatures; then the library,
 *      given the same randomness, must produce the same bytes.
 *   3. Forged peers built with that second implementation: a wrong throwaway signature, a wrong MAC, a MAC under the
 *      other role's key. An honest forged peer (the control) completes with the library on the other side.
 */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ml_kem768_x25519 as XWING } from '@noble/post-quantum/hybrid.js'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { identityId, initiate, initiatorFinish, respond, responderFinish } from '../fresh-link.mjs'

const FILE = JSON.parse(readFileSync(new URL('../fresh-link.vectors.json', import.meta.url), 'utf8'))
const V = FILE.handshake
const CONTEXT = new TextEncoder().encode('freshlink/v0')
const L = label => Buffer.from(label, 'latin1')
const B = (...parts) => Buffer.concat(parts.map(part => Buffer.from(part)))
const H = value => Buffer.from(value, 'hex')
const hex = bytes => Buffer.from(bytes).toString('hex')
const sha = (...parts) => createHash('sha256').update(B(...parts)).digest()
const hmac = (key, ...parts) => createHmac('sha256', Buffer.from(key)).update(B(...parts)).digest()
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), 32))
const ZERO12 = Buffer.alloc(12)
const seal = (key, iv, aad, plaintext) => { const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(aad); return B(c.update(plaintext), c.final(), c.getAuthTag()) }
const unseal = (key, iv, aad, sealed) => { const d = createDecipheriv('aes-256-gcm', key, iv); d.setAAD(aad); d.setAuthTag(sealed.subarray(-16)); return B(d.update(sealed.subarray(0, -16)), d.final()) }
const u64 = n => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(n)); return out }
const FAILED = 'FRESHLINK_HANDSHAKE_FAILED'

// ── The second implementation (node:crypto + noble primitives only) ───────────────────────────────────────────────
function schedule(ss, m1, m2a) {
  const TH1 = sha(L('freshlink/v0 th1'), m1, m2a)
  const PRK = hmac(TH1, ss)
  const expand = label => hmac(PRK, L(label), Buffer.from([1]))
  const keys = { hsR: hkdf(ss, TH1, L('freshlink/v0 hs R')), hsI: hkdf(ss, TH1, L('freshlink/v0 hs I')), fkR: hkdf(ss, TH1, L('freshlink/v0 fin R')), fkI: hkdf(ss, TH1, L('freshlink/v0 fin I')) }
  // RFC 5869 Expand for one block, by hand: the same 32 bytes as hkdfSync (a third way, for PRK itself).
  assert.ok(keys.hsR.equals(expand('freshlink/v0 hs R')) && keys.fkI.equals(expand('freshlink/v0 fin I')))
  return { TH1, PRK, ...keys }
}
const appKeys = (ss, TH1, TH4) => ({ kI2R: hkdf(ss, TH1, B(L('freshlink/v0 app I2R'), TH4)), kR2I: hkdf(ss, TH1, B(L('freshlink/v0 app R2I'), TH4)) })
const SEALED_LENGTH = 1984 + 64 + 3309 + 64 + 32
function split(plain) {
  assert.equal(plain.length, SEALED_LENGTH)
  return { idK: plain.subarray(0, 1984), ed: plain.subarray(1984, 2048), ml: plain.subarray(2048, 5357), tsig: plain.subarray(5357, 5421), mac: plain.subarray(5421, 5453) }
}

function indInitiate({ nI, xwingSeed, throwawaySeed }) {
  const { publicKey: epk, secretKey: esk } = XWING.keygen(xwingSeed)
  const m1 = B(L('FL'), [0], [0, 1], nI, epk, ed25519.getPublicKey(throwawaySeed))
  return { m1, esk, throwawaySeed }
}

function indRespond(m1, { eseed, nR, throwawaySeed, identity, edit = {} }) {
  const { cipherText: ct, sharedSecret: ss } = XWING.encapsulate(m1.subarray(37, 1253), eseed)
  const m2a = B(ct, nR, ed25519.getPublicKey(throwawaySeed))
  const k = schedule(ss, m1, m2a)
  const idK = edit.idK ?? identity.idK
  const TH2 = sha(L('freshlink/v0 th2'), k.TH1, idK)
  const sig = edit.sig ? edit.sig(null, B(L('freshlink/v0 sig R\0'), TH2)) : identity.signWith(B(L('freshlink/v0 sig R\0'), TH2))
  const tsig = edit.tsig ? edit.tsig(TH2, throwawaySeed) : Buffer.from(ed25519.sign(B(L('freshlink/v0 tid R\0'), TH2), throwawaySeed))
  const macKey = edit.macKey ? edit.macKey(k) : k.fkR
  let mac = hmac(macKey, L('freshlink/v0 mac R'), TH2, sig.ed25519, sig.mlDsa65, tsig)
  if (edit.mac) mac = edit.mac(mac)
  const m2 = B(m2a, seal(k.hsR, ZERO12, k.TH1, B(idK, sig.ed25519, sig.mlDsa65, tsig, mac)))
  const TH2f = sha(L('freshlink/v0 th2f'), TH2, sig.ed25519, sig.mlDsa65, tsig, mac)
  return { m2, m2a, ss, ...k, TH2, TH2f, sig, tsig, mac, tIpk: m1.subarray(1253, 1285) }
}

function indInitiatorFinish(start, m2, { identity, edit = {} }) {
  const m2a = m2.subarray(0, 1184)
  const ss = Buffer.from(XWING.decapsulate(m2.subarray(0, 1120), start.esk))
  const k = schedule(ss, start.m1, m2a)
  const peer = split(unseal(k.hsR, ZERO12, k.TH1, m2.subarray(1184)))
  const TH2 = sha(L('freshlink/v0 th2'), k.TH1, peer.idK)
  const TH2f = sha(L('freshlink/v0 th2f'), TH2, peer.ed, peer.ml, peer.tsig, peer.mac)
  const idK = edit.idK ?? identity.idK
  const TH3 = sha(L('freshlink/v0 th3'), TH2f, idK)
  const sig = edit.sig ? edit.sig(peer, B(L('freshlink/v0 sig I\0'), TH3)) : identity.signWith(B(L('freshlink/v0 sig I\0'), TH3))
  const tsig = edit.tsig ? edit.tsig(TH3, start.throwawaySeed) : Buffer.from(ed25519.sign(B(L('freshlink/v0 tid I\0'), TH3), start.throwawaySeed))
  const macKey = edit.macKey ? edit.macKey(k) : k.fkI
  let mac = hmac(macKey, L('freshlink/v0 mac I'), TH3, sig.ed25519, sig.mlDsa65, tsig)
  if (edit.mac) mac = edit.mac(mac)
  const m3 = seal(k.hsI, ZERO12, TH2f, B(idK, sig.ed25519, sig.mlDsa65, tsig, mac))
  const TH4 = sha(L('freshlink/v0 th4'), TH3, sig.ed25519, sig.mlDsa65, tsig, mac)
  return { m3, ss, ...k, TH2, TH2f, TH3, TH4, sig, tsig, mac, peer, ...appKeys(ss, k.TH1, TH4) }
}

function indResponderFinish(r, m3) {
  const peer = split(unseal(r.hsI, ZERO12, r.TH2f, m3))
  const TH3 = sha(L('freshlink/v0 th3'), r.TH2f, peer.idK)
  const TH4 = sha(L('freshlink/v0 th4'), TH3, peer.ed, peer.ml, peer.tsig, peer.mac)
  return { TH3, TH4, peer, ...appKeys(r.ss, r.TH1, TH4) }
}

const frameOf = (key, TH4, counter, plaintext, aad) => B(u64(counter), seal(key, B([0, 0, 0, 0], u64(counter)), B(TH4, u64(counter), aad), plaintext))
const chainStep = (previous, counter, frame) => sha(L('freshlink/v0 chain'), previous, u64(counter), sha(frame))

/** A recorded identity: public keys from the file; `signWith` hands back the recorded signatures for exactly one message. */
function recorded(role, expected) {
  const keys = V.identities[role], sigs = V.signatures[role]
  const idK = B(H(keys.ed25519PublicKey), H(keys.mlDsa65PublicKey))
  const signWith = message => {
    assert.equal(hex(message), hex(expected()), `${role} is asked to sign exactly the file's preimage`)
    return { ed25519: H(sigs.ed25519), mlDsa65: H(sigs.mlDsa65) }
  }
  return { idK, signWith, signer: { publicKeys: { ed25519: H(keys.ed25519PublicKey), mlDsa65: H(keys.mlDsa65PublicKey) }, sign: async message => signWith(message) } }
}
const RESPONDER = recorded('responder', () => B(L('freshlink/v0 sig R\0'), H(V.TH2)))
const INITIATOR = recorded('initiator', () => B(L('freshlink/v0 sig I\0'), H(V.TH3)))
const RANDOM_I = { nI: H(V.random.initiator.nI), xwingSeed: H(V.random.initiator.xwingSeed), throwawaySeed: H(V.random.initiator.throwawaySeed) }
const RANDOM_R = { eseed: H(V.random.responder.eseed), nR: H(V.random.responder.nR), throwawaySeed: H(V.random.responder.throwawaySeed) }
/** The library's randomness, in the order the file states: initiator nI, X-Wing seed, throwaway seed; responder eseed, nR, throwaway seed. */
const queue = parts => { const list = parts.map(part => Uint8Array.from(part)); return n => { const next = list.shift(); assert.equal(next?.length, n); return next } }

// ── 1. X-Wing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('the three official X-Wing vectors (draft 11), byte for byte: keygen, encapsulate with the given eseed, decapsulate', () => {
  assert.equal(FILE.xwing.length, 3)
  for (const [n, v] of FILE.xwing.entries()) {
    const { publicKey, secretKey } = XWING.keygen(H(v.seed))
    assert.equal(hex(publicKey), v.pk, `vector ${n} pk`)
    assert.equal(hex(secretKey), v.sk, `vector ${n} sk`)
    const { cipherText, sharedSecret } = XWING.encapsulate(publicKey, H(v.eseed))
    assert.equal(hex(cipherText), v.ct, `vector ${n} ct`)
    assert.equal(hex(sharedSecret), v.ss, `vector ${n} ss`)
    assert.equal(hex(XWING.decapsulate(H(v.ct), H(v.sk))), v.ss, `vector ${n} decapsulate`)
  }
})

test('a malformed X-Wing public key is refused by the library, and by the responder with the one code', async () => {
  const good = XWING.keygen(H(FILE.xwing[0].seed)).publicKey
  const modulus = Uint8Array.from(good); modulus[0] = 0xff; modulus[1] = 0xff
  const zeroX = Uint8Array.from(good); zeroX.fill(0, 1184)
  assert.throws(() => XWING.encapsulate(good.subarray(0, 1215)), /length/)
  assert.throws(() => XWING.encapsulate(modulus), /modulus/)
  // What the library does with an all-zero X25519 part: X25519 gives the all-zero point and noble throws (it refuses).
  assert.throws(() => XWING.encapsulate(zeroX), /invalid private or public key/)
  // A zero X25519 ciphertext at decapsulation: the same refusal.
  const { cipherText } = XWING.encapsulate(good)
  const zeroCt = Uint8Array.from(cipherText); zeroCt.fill(0, 1088)
  assert.throws(() => XWING.decapsulate(zeroCt, H(FILE.xwing[0].sk)), /invalid private or public key/)
  // Through the handshake: an m1 carrying either malformed key is refused with the one code.
  const { m1 } = indInitiate({ nI: randomBytes(32), xwingSeed: randomBytes(32), throwawaySeed: randomBytes(32) })
  for (const epk of [modulus, zeroX]) {
    const bad = B(m1.subarray(0, 37), epk, m1.subarray(1253))
    await assert.rejects(respond({ m1: bad, signer: RESPONDER.signer, allowSuites: [1], acceptPeer: async () => true }), error => error.code === FAILED)
  }
  // An m2 whose X25519 ciphertext is all zero: the initiator refuses with the one code.
  const started = await initiate({ suite: 1, signer: INITIATOR.signer, acceptPeer: async () => true })
  const forged = indRespond(started.m1, { ...RANDOM_R, identity: identityOf(0x44) })
  const m2 = Uint8Array.from(forged.m2); m2.fill(0, 1088, 1120)
  await assert.rejects(initiatorFinish({ state: started.state, m2 }), error => error.code === FAILED)
})

// ── 2. The key schedule, two ways ───────────────────────────────────────────────────────────────────────────────────
test('the file, recomputed by the second implementation (node:crypto): m1, m2a, TH1, PRK, the four handshake keys, TH2..TH4, the application keys, frames and transcript', () => {
  const start = indInitiate(RANDOM_I)
  assert.equal(hex(start.m1), V.m1)
  const r = indRespond(start.m1, { ...RANDOM_R, identity: RESPONDER })
  for (const name of ['m2a', 'ss', 'TH1', 'PRK', 'hsR', 'hsI', 'fkR', 'fkI', 'TH2', 'TH2f']) assert.equal(hex(r[name]), V[name], name)
  assert.equal(hex(r.tsig), V.tsigR)
  assert.equal(hex(r.mac), V.macR)
  assert.equal(hex(sha(r.m2)), V.m2Sha256)
  // The recorded signatures are real and bound to this transcript (both algorithms, the context string for ML-DSA).
  const keysR = V.identities.responder, keysI = V.identities.initiator
  const msgR = B(L('freshlink/v0 sig R\0'), H(V.TH2)), msgI = B(L('freshlink/v0 sig I\0'), H(V.TH3))
  assert.ok(ed25519.verify(H(V.signatures.responder.ed25519), msgR, H(keysR.ed25519PublicKey), { zip215: false }))
  assert.ok(ml_dsa65.verify(H(V.signatures.responder.mlDsa65), msgR, H(keysR.mlDsa65PublicKey), { context: CONTEXT }))
  assert.ok(ed25519.verify(H(V.signatures.initiator.ed25519), msgI, H(keysI.ed25519PublicKey), { zip215: false }))
  assert.ok(ml_dsa65.verify(H(V.signatures.initiator.mlDsa65), msgI, H(keysI.mlDsa65PublicKey), { context: CONTEXT }))
  const f = indInitiatorFinish(start, r.m2, { identity: INITIATOR })
  for (const name of ['TH3', 'TH4', 'kI2R', 'kR2I']) assert.equal(hex(f[name]), V[name], name)
  assert.equal(hex(f.tsig), V.tsigI)
  assert.equal(hex(f.mac), V.macI)
  assert.equal(hex(sha(f.m3)), V.m3Sha256)
  const back = indResponderFinish(r, f.m3)
  assert.equal(hex(back.TH4), V.TH4)
  assert.equal(hex(sha(L('freshlink/v0 id'), RESPONDER.idK)), V.responderId)
  assert.equal(hex(sha(L('freshlink/v0 id'), INITIATOR.idK)), V.initiatorId)
  // Frames and the chained transcript.
  const TH4 = H(V.TH4), chains = { I2R: TH4, R2I: TH4 }, counts = { I2R: 0, R2I: 0 }
  for (const frame of V.frames) {
    const key = frame.direction === 'I2R' ? f.kI2R : f.kR2I
    const bytes = frameOf(key, TH4, frame.counter, Buffer.from(frame.plaintext, 'utf8'), Buffer.from(frame.aad, 'utf8'))
    assert.equal(hex(bytes), frame.frame, `${frame.direction} ${frame.counter}`)
    assert.equal(frame.counter, counts[frame.direction]++)
    chains[frame.direction] = chainStep(chains[frame.direction], frame.counter, bytes)
  }
  const transcript = sha(L('freshlink/v0 transcript'), chains.I2R, chains.R2I, u64(counts.I2R), u64(counts.R2I))
  assert.equal(hex(transcript), V.transcript)
  assert.equal(V.fingerprint, `${hex(transcript.subarray(0, 2))}-${hex(transcript.subarray(2, 4))}-${hex(transcript.subarray(4, 6))}`)
})

test('the library, given the file\'s randomness and signatures, produces the same bytes: m1, m2, m3, session ids, frames, transcript', async () => {
  const started = await initiate({ suite: 1, signer: INITIATOR.signer, expectPeerId: H(V.responderId), random: queue([RANDOM_I.nI, RANDOM_I.xwingSeed, RANDOM_I.throwawaySeed]) })
  assert.equal(hex(started.m1), V.m1)
  const answered = await respond({ m1: started.m1, signer: RESPONDER.signer, allowSuites: [1], acceptPeer: async id => hex(id) === V.initiatorId,
    random: queue([RANDOM_R.eseed, RANDOM_R.nR, RANDOM_R.throwawaySeed]) })
  assert.equal(hex(answered.m2.subarray(0, 1184)), V.m2a)
  assert.equal(hex(sha(answered.m2)), V.m2Sha256)
  // The library's TH1, hsR and fkR are the file's: m2b opens with them here, and its MAC is the file's MAC under fkR.
  const opened = split(unseal(H(V.hsR), ZERO12, H(V.TH1), Buffer.from(answered.m2.subarray(1184))))
  assert.equal(hex(opened.mac), hex(hmac(H(V.fkR), L('freshlink/v0 mac R'), H(V.TH2), opened.ed, opened.ml, opened.tsig)))
  assert.equal(hex(opened.tsig), V.tsigR)
  const { m3, session: i } = await initiatorFinish({ state: started.state, m2: answered.m2 })
  assert.equal(hex(sha(m3)), V.m3Sha256)
  const openedI = split(unseal(H(V.hsI), ZERO12, H(V.TH2f), Buffer.from(m3)))
  assert.equal(hex(openedI.mac), V.macI)
  const { session: r } = await responderFinish({ state: answered.state, m3 })
  assert.equal(hex(i.id), V.TH4)
  assert.equal(hex(r.id), V.TH4)
  assert.equal(hex(i.peerId), V.responderId)
  assert.equal(hex(r.peerId), V.initiatorId)
  assert.equal(hex(await identityId(RESPONDER.idK)), V.responderId)
  for (const frame of V.frames) {
    const [from, to] = frame.direction === 'I2R' ? [i, r] : [r, i]
    const bytes = await from.send(Buffer.from(frame.plaintext, 'utf8'), Buffer.from(frame.aad, 'utf8'))
    assert.equal(hex(bytes), frame.frame)
    assert.equal(Buffer.from(await to.receive(bytes, Buffer.from(frame.aad, 'utf8'))).toString('utf8'), frame.plaintext)
  }
  assert.equal(hex(await i.transcript()), V.transcript)
  assert.equal(hex(await r.transcript()), V.transcript)
  assert.equal(await i.fingerprint(), V.fingerprint)
})

// ── 3. Forged peers ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A fresh synthetic identity for forged peers (test keys, real signatures). */
function identityOf(seedByte) {
  const edSecret = new Uint8Array(32).fill(seedByte)
  const ml = ml_dsa65.keygen(new Uint8Array(32).fill(seedByte ^ 0x5a))
  const publicKeys = { ed25519: ed25519.getPublicKey(edSecret), mlDsa65: ml.publicKey }
  const signWith = message => ({ ed25519: ed25519.sign(message, edSecret), mlDsa65: ml_dsa65.sign(message, ml.secretKey, { context: CONTEXT }) })
  /** One part at a time, for forgeries: the Ed25519 signature, or the ML-DSA-65 one under any context (or none). */
  const edSign = message => ed25519.sign(message, edSecret)
  const mlSign = (message, context) => ml_dsa65.sign(message, ml.secretKey, context === undefined ? {} : { context })
  return { idK: B(publicKeys.ed25519, publicKeys.mlDsa65), signWith, edSign, mlSign, signer: { publicKeys, sign: async message => signWith(message) } }
}
const CAROL = identityOf(0x55), DAVE = identityOf(0x66), EVE = identityOf(0x77)
/**
 * Forgeries inside a VALID seal, each spoiling exactly one long-term check (the MAC, the throwaway signature and the
 * transcript are all made consistently by the forger, who is a real party to the key exchange). `me` signs; EVE is the
 * identity someone else holds.
 */
const innerForgeries = me => ({
  'key substitution: claims EVE\'s idK, signs with its own keys': { idK: EVE.idK, sig: (_, message) => me.signWith(message) },
  'ML-DSA-65 signed with no context': { sig: (_, message) => ({ ed25519: me.edSign(message), mlDsa65: me.mlSign(message) }) },
  'ML-DSA-65 signed under another context': { sig: (_, message) => ({ ed25519: me.edSign(message), mlDsa65: me.mlSign(message, new TextEncoder().encode('freshlink/v1')) }) },
  'ML-DSA-65 signed under an empty context': { sig: (_, message) => ({ ed25519: me.edSign(message), mlDsa65: me.mlSign(message, new Uint8Array(0)) }) },
  'Ed25519 over the right message under EVE\'s key': { sig: (_, message) => ({ ed25519: EVE.edSign(message), mlDsa65: me.mlSign(message, CONTEXT) }) },
  'ML-DSA-65 over the right message under EVE\'s key': { sig: (_, message) => ({ ed25519: me.edSign(message), mlDsa65: EVE.mlSign(message, CONTEXT) }) },
})
const fresh = () => ({ eseed: randomBytes(64), nR: randomBytes(32), throwawaySeed: randomBytes(32) })

test('forged responders: the honest control completes; a wrong throwaway signature, a wrong MAC, a MAC under fkI: refused with the one code', async () => {
  const run = async edit => {
    const started = await initiate({ suite: 1, signer: CAROL.signer, acceptPeer: async () => true })
    const forged = indRespond(started.m1, { ...fresh(), identity: DAVE, edit })
    return { result: initiatorFinish({ state: started.state, m2: forged.m2 }), forged }
  }
  const control = await run({})
  const { m3, session } = await control.result
  const back = indResponderFinish(control.forged, Buffer.from(m3))
  assert.equal(hex(session.id), hex(back.TH4))
  // The second implementation's application keys open the library's frame: the keys agree.
  const frame = await session.send(Buffer.from('to the forger'))
  assert.equal(unseal(back.kI2R, B([0, 0, 0, 0], frame.subarray(0, 8)), B(back.TH4, frame.subarray(0, 8)), Buffer.from(frame.subarray(8))).toString(), 'to the forger')
  const other = randomBytes(32)
  const cases = {
    'throwaway signature by another key': { tsig: TH2 => Buffer.from(ed25519.sign(B(L('freshlink/v0 tid R\0'), TH2), other)) },
    'throwaway signature under the initiator label': { tsig: (TH2, seed) => Buffer.from(ed25519.sign(B(L('freshlink/v0 tid I\0'), TH2), seed)) },
    'throwaway signature zeroed': { tsig: () => Buffer.alloc(64) },
    'MAC flipped': { mac: mac => { const copy = Buffer.from(mac); copy[31] ^= 1; return copy } },
    'MAC under fkI': { macKey: k => k.fkI },
    'MAC under hsR': { macKey: k => k.hsR },
    ...innerForgeries(DAVE),
  }
  for (const [name, edit] of Object.entries(cases)) await assert.rejects((await run(edit)).result, error => error.code === FAILED && Object.keys(error).length === 1, name)
})

test('forged initiators: the honest control completes; a wrong throwaway signature, a wrong MAC, m2\'s signatures reflected: refused', async () => {
  const run = async (edit, identity = CAROL) => {
    const start = indInitiate({ nI: randomBytes(32), xwingSeed: randomBytes(32), throwawaySeed: randomBytes(32) })
    const answered = await respond({ m1: Uint8Array.from(start.m1), signer: DAVE.signer, allowSuites: [1], acceptPeer: async () => true })
    const forged = indInitiatorFinish(start, Buffer.from(answered.m2), { identity, edit })
    return { result: responderFinish({ state: answered.state, m3: Uint8Array.from(forged.m3) }), forged }
  }
  const control = await run({})
  const { session } = await control.result
  assert.equal(hex(session.id), hex(control.forged.TH4))
  const frame = await session.send(Buffer.from('to the forger'))
  assert.equal(unseal(control.forged.kR2I, B([0, 0, 0, 0], frame.subarray(0, 8)), B(control.forged.TH4, frame.subarray(0, 8)), Buffer.from(frame.subarray(8))).toString(), 'to the forger')
  const cases = {
    'throwaway signature by another key': { tsig: TH3 => Buffer.from(ed25519.sign(B(L('freshlink/v0 tid I\0'), TH3), randomBytes(32))) },
    'MAC flipped': { mac: mac => { const copy = Buffer.from(mac); copy[0] ^= 1; return copy } },
    'MAC under fkR': { macKey: k => k.fkR },
    ...innerForgeries(CAROL),
  }
  for (const [name, edit] of Object.entries(cases)) await assert.rejects((await run(edit)).result, error => error.code === FAILED && Object.keys(error).length === 1, name)
  // Reflection with the responder's own identity: m3 carries DAVE's identity and DAVE's signatures from m2.
  await assert.rejects((await run({ sig: peer => ({ ed25519: peer.ed, mlDsa65: peer.ml }) }, DAVE)).result, error => error.code === FAILED, 'reflection')
})
