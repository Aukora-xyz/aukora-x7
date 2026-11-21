/**
 * FRESH LINK v0: fresh keys and a throwaway identity for every connection. EXPERIMENTAL AND UNREVIEWED: no cryptographer
 * has reviewed this composition, no second implementation has been run against its vectors outside this repository's own
 * test, and NOTHING USES IT (no route, no object, no app imports this module; __tests__/fresh-link.test.mjs keeps that
 * true). Docs: docs/auma/fresh-link.md.
 *
 * INVENTS NOTHING. Every primitive is a vetted one called through its library: X-Wing (X25519 + ML-KEM-768,
 * draft-connolly-cfrg-xwing-kem-11) from @noble/post-quantum; Ed25519 from @noble/curves; ML-DSA-65 from
 * @noble/post-quantum; SHA-256, HKDF-SHA-256 (RFC 5869), HMAC-SHA-256 and AES-256-GCM from WebCrypto. The shape is SIGMA
 * as TLS 1.3 and IKEv2 use it: an ephemeral key exchange, each side signs the transcript, each side sends a MAC under a
 * key from the exchange. The protocol text is the lane brief's, field for field (docs/auma/fresh-link.md repeats it).
 *
 * Pure functions and small state objects: no I/O, no storage, no global state. Long-term SECRET keys never enter this
 * module: the caller's `signer` signs. The throwaway Ed25519 key of each connection is made here from 32 random bytes and
 * dropped with the handshake state.
 *
 * Errors: every handshake failure a peer can cause is ONE code, FRESHLINK_HANDSHAKE_FAILED; every frame a peer can spoil
 * is ONE code, FRESHLINK_FRAME_FAILED (and kills the session); local misuse has its own codes. No error carries a detail,
 * a cause, a secret or key material: only `code`.
 *
 * Wiping: close() and the end of a handshake overwrite the byte arrays this module holds with zeros. That is best
 * effort: a JavaScript runtime copies freely and cannot promise memory is wiped, and WebCrypto keys cannot be overwritten
 * (they are only dropped).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'

/** The menu. One entry today; a responder accepts only suites in its own allowed set (no negotiation, no fallback). */
export const FRESHLINK_SUITES = Object.freeze([Object.freeze({
  id: 0x0001,
  name: 'freshlink/v0 suite 0x0001',
  kem: 'X-Wing (X25519 + ML-KEM-768), draft-connolly-cfrg-xwing-kem-11',
  signatures: 'Ed25519 AND ML-DSA-65 (context freshlink/v0), both required',
  throwaway: 'Ed25519, fresh per connection',
  hash: 'SHA-256', kdf: 'HKDF-SHA-256', mac: 'HMAC-SHA-256', aead: 'AES-256-GCM',
})])

export const FRESHLINK_HANDSHAKE_FAILED = 'FRESHLINK_HANDSHAKE_FAILED'
export const FRESHLINK_FRAME_FAILED = 'FRESHLINK_FRAME_FAILED'

const SUITE_IDS = new Set(FRESHLINK_SUITES.map(suite => suite.id))
const encoder = new TextEncoder()
const label = value => encoder.encode(value)
const LABEL = Object.freeze({
  id: label('freshlink/v0 id'), th1: label('freshlink/v0 th1'), th2: label('freshlink/v0 th2'), th2f: label('freshlink/v0 th2f'),
  th3: label('freshlink/v0 th3'), th4: label('freshlink/v0 th4'),
  hsR: label('freshlink/v0 hs R'), hsI: label('freshlink/v0 hs I'), finR: label('freshlink/v0 fin R'), finI: label('freshlink/v0 fin I'),
  sigR: label('freshlink/v0 sig R\0'), sigI: label('freshlink/v0 sig I\0'), tidR: label('freshlink/v0 tid R\0'), tidI: label('freshlink/v0 tid I\0'),
  macR: label('freshlink/v0 mac R'), macI: label('freshlink/v0 mac I'), appI2R: label('freshlink/v0 app I2R'), appR2I: label('freshlink/v0 app R2I'),
  chain: label('freshlink/v0 chain'), transcript: label('freshlink/v0 transcript'),
})
const ML_DSA_CONTEXT = label('freshlink/v0')

const SIZE = Object.freeze({ nonce: 32, epk: 1216, ct: 1120, edPk: 32, mlPk: 1952, edSig: 64, mlSig: 3309, mac: 32, tag: 16 })
const ID_K = SIZE.edPk + SIZE.mlPk
const SEALED = ID_K + SIZE.edSig + SIZE.mlSig + SIZE.edSig + SIZE.mac
const M1 = 2 + 1 + 2 + SIZE.nonce + SIZE.epk + SIZE.edPk
const M2A = SIZE.ct + SIZE.nonce + SIZE.edPk
const M2 = M2A + SEALED + SIZE.tag
const M3 = SEALED + SIZE.tag
const VERSION = 0x00
const ZERO_IV = new Uint8Array(12)
const FRAME_MIN = 8 + SIZE.tag
const DIRECTION_LIMIT = 2 ** 32

function failure(code) {
  const error = new Error(code)
  error.code = code
  throw error
}
const handshakeFailed = () => failure(FRESHLINK_HANDSHAKE_FAILED)

const isBytes = value => value instanceof Uint8Array
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
const u64 = n => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(n)); return out }
const wipe = (...arrays) => { for (const array of arrays) if (isBytes(array)) array.fill(0) }
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

// ── WebCrypto ──────────────────────────────────────────────────────────────────────────────────────────────────────
const sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)))
/** HKDF-SHA-256 (RFC 5869) through WebCrypto: Expand(Extract(salt, ikm), info, 32). */
async function hkdf(ikm, salt, info) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256))
}
const hmacKey = raw => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
const hmac = async (raw, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(raw), data))
/** HMAC check in constant time (WebCrypto's own verify). A false or a throw is "not valid". */
async function macValid(raw, mac, data) {
  try { return (await crypto.subtle.verify('HMAC', await hmacKey(raw), mac, data)) === true } catch { return false }
}
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
const seal = async (key, iv, aad, plaintext) => new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext))
/** AES-256-GCM open; null when it does not authenticate. */
async function unseal(key, iv, aad, sealed) {
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, sealed)) } catch { return null }
}

// ── Signatures (noble) ───────────────────────────────────────────────────────────────────────────────────────────────
/** Ed25519 in the strict RFC 8032 / FIPS 186-5 mode (zip215 off). A false or a throw is "not valid". */
function edValid(publicKey, signature, message) {
  try { return ed25519.verify(signature, message, publicKey, { zip215: false }) === true } catch { return false }
}
function mlValid(publicKey, signature, message) {
  try { return ml_dsa65.verify(signature, message, publicKey, { context: ML_DSA_CONTEXT }) === true } catch { return false }
}

/** Identity id = SHA-256("freshlink/v0 id" || idK), idK = Ed25519 public key (32) || ML-DSA-65 public key (1952). */
export async function identityId(idK) {
  if (!isBytes(idK) || idK.length !== ID_K) failure('FRESHLINK_INPUT_INVALID')
  return sha256(LABEL.id, idK)
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function signerOf(signer) {
  const keys = signer?.publicKeys
  if (typeof signer?.sign !== 'function' || !isBytes(keys?.ed25519) || keys.ed25519.length !== SIZE.edPk
    || !isBytes(keys?.mlDsa65) || keys.mlDsa65.length !== SIZE.mlPk) failure('FRESHLINK_SIGNER_INVALID')
  const idK = concat(keys.ed25519, keys.mlDsa65)
  return { idK, sign: message => signer.sign(message.slice()) }
}

/** The caller signs; this module only checks that both signatures came back at their exact sizes. */
async function signBoth(signer, message) {
  let signed
  try { signed = await signer.sign(message) } catch { failure('FRESHLINK_SIGNER_FAILED') }
  if (!isBytes(signed?.ed25519) || signed.ed25519.length !== SIZE.edSig || !isBytes(signed?.mlDsa65) || signed.mlDsa65.length !== SIZE.mlSig) failure('FRESHLINK_SIGNER_INVALID')
  return { ed: signed.ed25519.slice(), ml: signed.mlDsa65.slice() }
}

function randomOf(random) {
  if (random === undefined) return n => crypto.getRandomValues(new Uint8Array(n))
  if (typeof random !== 'function') failure('FRESHLINK_INPUT_INVALID')
  return n => {
    const bytes = random(n)
    if (!isBytes(bytes) || bytes.length !== n) failure('FRESHLINK_RANDOM_INVALID')
    return bytes.slice()
  }
}

/** The peer rule, never implicit: exactly one of a 32-byte expected id or an acceptPeer function. */
function peerRuleOf({ expectPeerId, acceptPeer }, allowExpect) {
  const hasExpect = expectPeerId !== undefined, hasAccept = acceptPeer !== undefined
  if (hasExpect && allowExpect && !hasAccept && isBytes(expectPeerId) && expectPeerId.length === 32) return { expect: expectPeerId.slice() }
  if (hasAccept && !hasExpect && typeof acceptPeer === 'function') return { accept: acceptPeer }
  return failure('FRESHLINK_PEER_RULE_REQUIRED')
}
async function peerAccepted(rule, peerId, idK) {
  if (rule.expect) return sameBytes(rule.expect, peerId)
  try { return (await rule.accept(peerId.slice(), idK.slice())) === true } catch { return false }
}

// ── State objects: opaque handles; what they hold lives here and is used once ───────────────────────────────────────
const STATES = new WeakMap()
function handle(role, held) {
  const state = Object.freeze(Object.create(null))
  STATES.set(state, { role, used: false, held })
  return state
}
function take(state, role) {
  const entry = (state !== null && typeof state === 'object') ? STATES.get(state) : undefined
  if (!entry || entry.role !== role) failure('FRESHLINK_STATE_INVALID')
  if (entry.used) failure('FRESHLINK_STATE_USED')
  entry.used = true
  const held = entry.held
  entry.held = null
  return held
}

/** The four handshake keys: X(label) = HKDF-Expand(PRK, label, 32), PRK = HKDF-Extract(salt = TH1, ikm = ss). */
async function handshakeKeys(ss, TH1) {
  return { hsR: await hkdf(ss, TH1, LABEL.hsR), hsI: await hkdf(ss, TH1, LABEL.hsI), fkR: await hkdf(ss, TH1, LABEL.finR), fkI: await hkdf(ss, TH1, LABEL.finI) }
}

/** Parse idK || sig_ed || sig_ml || tsig || mac. */
function splitSealed(plain) {
  let at = 0
  const next = n => plain.subarray(at, at += n)
  return { idK: next(ID_K), ed: next(SIZE.edSig), ml: next(SIZE.mlSig), tsig: next(SIZE.edSig), mac: next(SIZE.mac) }
}

/** Verify everything the peer sent under its role's labels; all four are evaluated, one answer. */
async function peerProves({ th, fields, throwawayKey, finishKey, sigLabel, tidLabel, macLabel }) {
  const signed = concat(sigLabel, th)
  const ed = edValid(fields.idK.subarray(0, SIZE.edPk), fields.ed, signed)
  const ml = mlValid(fields.idK.subarray(SIZE.edPk), fields.ml, signed)
  const tid = edValid(throwawayKey, fields.tsig, concat(tidLabel, th))
  const mac = await macValid(finishKey, fields.mac, concat(macLabel, th, fields.ed, fields.ml, fields.tsig))
  return ed && ml && tid && mac
}

// ── The handshake ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Start a connection. Randomness order (for the vectors): nI (32), X-Wing seed (32), throwaway seed (32).
 * @param {{ suite: number, signer: object, expectPeerId?: Uint8Array, acceptPeer?: Function, random?: Function }} options
 * @returns {Promise<{ state: object, m1: Uint8Array }>}
 */
export async function initiate({ suite, signer, expectPeerId, acceptPeer, random } = {}) {
  if (!SUITE_IDS.has(suite)) failure('FRESHLINK_SUITE_UNKNOWN')
  const own = signerOf(signer)
  const rule = peerRuleOf({ expectPeerId, acceptPeer }, true)
  const draw = randomOf(random)
  const nI = draw(SIZE.nonce)
  const xwingSeed = draw(32)
  const throwawaySeed = draw(32)
  const pair = ml_kem768_x25519.keygen(xwingSeed)
  const epk = pair.publicKey, esk = pair.secretKey.slice()
  wipe(xwingSeed, pair.secretKey)
  const tIpk = ed25519.getPublicKey(throwawaySeed)
  const m1 = concat(Uint8Array.of(0x46, 0x4c, VERSION, suite >> 8, suite & 0xff), nI, epk, tIpk)
  return { state: handle('initiator', { own, rule, m1, esk, throwawaySeed }), m1: m1.slice() }
}

/**
 * Answer an m1. Randomness order (for the vectors): X-Wing eseed (64), nR (32), throwaway seed (32).
 * @param {{ m1: Uint8Array, signer: object, allowSuites: number[], acceptPeer: Function, random?: Function }} options
 * @returns {Promise<{ state: object, m2: Uint8Array }>}
 */
export async function respond({ m1, signer, allowSuites, acceptPeer, random } = {}) {
  const own = signerOf(signer)
  const rule = peerRuleOf({ acceptPeer }, false)
  if (!Array.isArray(allowSuites) || allowSuites.length === 0 || !allowSuites.every(id => SUITE_IDS.has(id))) failure('FRESHLINK_INPUT_INVALID')
  const draw = randomOf(random)
  if (!isBytes(m1) || m1.length !== M1 || m1[0] !== 0x46 || m1[1] !== 0x4c || m1[2] !== VERSION
    || !allowSuites.includes((m1[3] << 8) | m1[4])) handshakeFailed()
  const m1Copy = m1.slice()
  const epk = m1Copy.subarray(37, 37 + SIZE.epk), tIpk = m1Copy.subarray(37 + SIZE.epk)
  const eseed = draw(64)
  let ct, ss
  try { ({ cipherText: ct, sharedSecret: ss } = ml_kem768_x25519.encapsulate(epk, eseed)) } catch { wipe(eseed); handshakeFailed() }
  wipe(eseed)
  const nR = draw(SIZE.nonce)
  const throwawaySeed = draw(32)
  const m2a = concat(ct, nR, ed25519.getPublicKey(throwawaySeed))
  const TH1 = await sha256(LABEL.th1, m1Copy, m2a)
  const keys = await handshakeKeys(ss, TH1)
  const TH2 = await sha256(LABEL.th2, TH1, own.idK)
  const sig = await signBoth(own, concat(LABEL.sigR, TH2))
  const tsig = ed25519.sign(concat(LABEL.tidR, TH2), throwawaySeed)
  wipe(throwawaySeed)
  const mac = await hmac(keys.fkR, concat(LABEL.macR, TH2, sig.ed, sig.ml, tsig))
  const m2b = await seal(await aesKey(keys.hsR), ZERO_IV, TH1, concat(own.idK, sig.ed, sig.ml, tsig, mac))
  const TH2f = await sha256(LABEL.th2f, TH2, sig.ed, sig.ml, tsig, mac)
  wipe(keys.hsR, keys.fkR)
  return { state: handle('responder', { rule, ss, TH1, TH2f, hsI: keys.hsI, fkI: keys.fkI, tIpk: tIpk.slice() }), m2: concat(m2a, m2b) }
}

/**
 * Finish as the initiator: open and check m2, then answer with m3.
 * @returns {Promise<{ m3: Uint8Array, session: object }>}
 */
export async function initiatorFinish({ state, m2 } = {}) {
  const held = take(state, 'initiator')
  const secrets = [held.esk, held.throwawaySeed]
  try {
    if (!isBytes(m2) || m2.length !== M2) handshakeFailed()
    const m2Copy = m2.slice()
    const ct = m2Copy.subarray(0, SIZE.ct), tRpk = m2Copy.subarray(SIZE.ct + SIZE.nonce, M2A)
    let ss
    try { ss = ml_kem768_x25519.decapsulate(ct, held.esk) } catch { handshakeFailed() }
    secrets.push(ss)
    const TH1 = await sha256(LABEL.th1, held.m1, m2Copy.subarray(0, M2A))
    const keys = await handshakeKeys(ss, TH1)
    secrets.push(keys.hsR, keys.hsI, keys.fkR, keys.fkI)
    const plain = await unseal(await aesKey(keys.hsR), ZERO_IV, TH1, m2Copy.subarray(M2A))
    if (!plain) handshakeFailed()
    secrets.push(plain)
    const peer = splitSealed(plain)
    const TH2 = await sha256(LABEL.th2, TH1, peer.idK)
    const proved = await peerProves({ th: TH2, fields: peer, throwawayKey: tRpk, finishKey: keys.fkR, sigLabel: LABEL.sigR, tidLabel: LABEL.tidR, macLabel: LABEL.macR })
    if (!proved) handshakeFailed()
    const peerId = await sha256(LABEL.id, peer.idK)
    if (!await peerAccepted(held.rule, peerId, peer.idK)) handshakeFailed()
    const TH2f = await sha256(LABEL.th2f, TH2, peer.ed, peer.ml, peer.tsig, peer.mac)
    const TH3 = await sha256(LABEL.th3, TH2f, held.own.idK)
    const sig = await signBoth(held.own, concat(LABEL.sigI, TH3))
    const tsig = ed25519.sign(concat(LABEL.tidI, TH3), held.throwawaySeed)
    const mac = await hmac(keys.fkI, concat(LABEL.macI, TH3, sig.ed, sig.ml, tsig))
    const m3 = await seal(await aesKey(keys.hsI), ZERO_IV, TH2f, concat(held.own.idK, sig.ed, sig.ml, tsig, mac))
    const TH4 = await sha256(LABEL.th4, TH3, sig.ed, sig.ml, tsig, mac)
    const session = await openSession({ initiator: true, ss, TH1, TH4, peerId, peerThrowawayKey: tRpk.slice() })
    return { m3, session }
  } finally {
    wipe(...secrets)
  }
}

/**
 * Finish as the responder: open and check m3.
 * @returns {Promise<{ session: object }>}
 */
export async function responderFinish({ state, m3 } = {}) {
  const held = take(state, 'responder')
  try {
    if (!isBytes(m3) || m3.length !== M3) handshakeFailed()
    const plain = await unseal(await aesKey(held.hsI), ZERO_IV, held.TH2f, m3.slice())
    if (!plain) handshakeFailed()
    const peer = splitSealed(plain)
    const TH3 = await sha256(LABEL.th3, held.TH2f, peer.idK)
    const proved = await peerProves({ th: TH3, fields: peer, throwawayKey: held.tIpk, finishKey: held.fkI, sigLabel: LABEL.sigI, tidLabel: LABEL.tidI, macLabel: LABEL.macI })
    if (!proved) handshakeFailed()
    const peerId = await sha256(LABEL.id, peer.idK)
    if (!await peerAccepted(held.rule, peerId, peer.idK)) handshakeFailed()
    const TH4 = await sha256(LABEL.th4, TH3, peer.ed, peer.ml, peer.tsig, peer.mac)
    return { session: await openSession({ initiator: false, ss: held.ss, TH1: held.TH1, TH4, peerId, peerThrowawayKey: held.tIpk.slice() }) }
  } finally {
    wipe(held.ss, held.hsI, held.fkI)
  }
}

// ── The session ─────────────────────────────────────────────────────────────────────────────────────────────────────
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Application keys kI2R / kR2I = HKDF-Expand(PRK, "freshlink/v0 app I2R|R2I" || TH4, 32). A frame is counter (8, big-endian)
 * || AES-256-GCM(key, iv = 4 zero bytes || counter, aad = TH4 || counter || callerAad, plaintext). The receiver accepts
 * only exactly the next counter; any failure kills the session for good; a direction closes before 2^32 frames.
 */
async function openSession({ initiator, ss, TH1, TH4, peerId, peerThrowawayKey }) {
  const rawI2R = await hkdf(ss, TH1, concat(LABEL.appI2R, TH4))
  const rawR2I = await hkdf(ss, TH1, concat(LABEL.appR2I, TH4))
  const keyI2R = await aesKey(rawI2R), keyR2I = await aesKey(rawR2I)
  wipe(rawI2R, rawR2I)
  const live = { closed: false, dead: false, sendKey: initiator ? keyI2R : keyR2I, receiveKey: initiator ? keyR2I : keyI2R,
    th4: TH4.slice(), chain: { I2R: TH4.slice(), R2I: TH4.slice() }, count: { I2R: 0, R2I: 0 }, tail: Promise.resolve() }
  const out = initiator ? 'I2R' : 'R2I', inbound = initiator ? 'R2I' : 'I2R'
  const usable = () => { if (live.closed || live.dead) failure('FRESHLINK_SESSION_CLOSED') }
  const aadOf = aad => {
    if (aad === undefined) return new Uint8Array(0)
    if (!isBytes(aad)) failure('FRESHLINK_INPUT_INVALID')
    return aad.slice()
  }
  /** One operation at a time, in call order, so counters and chains move together. */
  const serial = work => {
    const run = live.tail.then(work)
    live.tail = run.then(() => undefined, () => undefined)
    return run
  }
  /** Moves the chain; re-checked after every await, so close() during the work is never undone by a late write. */
  const step = async (direction, counter, frame) => {
    const framed = await sha256(frame)
    usable()
    const next = await sha256(LABEL.chain, live.chain[direction], u64(counter), framed)
    usable()
    live.chain[direction] = next
    live.count[direction] = counter + 1
  }
  const kill = () => { live.dead = true; failure(FRESHLINK_FRAME_FAILED) }

  const send = async (plaintext, aad) => {
    usable()
    if (!isBytes(plaintext)) failure('FRESHLINK_INPUT_INVALID')
    const callerAad = aadOf(aad), body = plaintext.slice()
    return serial(async () => {
      usable()
      const counter = live.count[out]
      if (counter >= DIRECTION_LIMIT) failure('FRESHLINK_DIRECTION_CLOSED')
      const ctr = u64(counter)
      const frame = concat(ctr, await seal(live.sendKey, concat(new Uint8Array(4), ctr), concat(live.th4, ctr, callerAad), body))
      usable()
      await step(out, counter, frame)
      usable()
      return frame
    })
  }
  const receive = async (frame, aad) => {
    usable()
    const callerAad = aadOf(aad)
    const bytes = isBytes(frame) ? frame.slice() : null
    return serial(async () => {
      usable()
      if (!bytes || bytes.length < FRAME_MIN) kill()
      const expected = live.count[inbound]
      if (expected >= DIRECTION_LIMIT) kill()
      const ctr = bytes.subarray(0, 8)
      if (new DataView(ctr.buffer, ctr.byteOffset, 8).getBigUint64(0) !== BigInt(expected)) kill()
      const plain = await unseal(live.receiveKey, concat(new Uint8Array(4), ctr), concat(live.th4, ctr, callerAad), bytes.subarray(8))
      usable()
      if (!plain) kill()
      await step(inbound, expected, bytes)
      usable()
      return plain
    })
  }
  /** SHA-256("freshlink/v0 transcript" || C_I2R || C_R2I || nI2R(8) || nR2I(8)), after every call already made has settled. */
  const transcript = async () => {
    if (live.closed) failure('FRESHLINK_SESSION_CLOSED')
    await live.tail
    if (live.closed) failure('FRESHLINK_SESSION_CLOSED')
    return sha256(LABEL.transcript, live.chain.I2R, live.chain.R2I, u64(live.count.I2R), u64(live.count.R2I))
  }
  const fingerprint = async () => {
    const digest = await transcript()
    return [hex(digest.subarray(0, 2)), hex(digest.subarray(2, 4)), hex(digest.subarray(4, 6))].join('-')
  }
  /** Best effort: overwrites the byte arrays held here and drops the keys (WebCrypto keys cannot be overwritten). */
  const close = () => {
    live.closed = true
    wipe(live.th4, live.chain.I2R, live.chain.R2I)
    live.sendKey = null
    live.receiveKey = null
  }
  return Object.freeze({ id: TH4.slice(), peerId: peerId.slice(), peerThrowawayKey, send, receive, transcript, fingerprint, close })
}
