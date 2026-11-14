// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE ACT SHAPES (CONTRACT.md draft 7, sections 6.2 to 6.5a and 8): pure closed-schema checks and builders for the act
 * lineage, the command, a key's thumb, the proof v3 envelope, the write request, the shapes of 6.5a (the verdict, a row,
 * the chain, the answer, a read, the status, the row read), the gate's inputs for each of its two calls, and the frozen
 * policy v0. Every refusal is `SCHEMA` with a short rule name, except where the contract names another code
 * (`CAPSULE_ACTION_ID_MISMATCH`) or the bytes are refused by their canon class (section 3.3).
 *
 * Imports only ./capsule-canon.mjs: every byte it reads, encodes or hashes goes through that one file (section 3.7).
 * NO signature verification here and no WebCrypto verify: that is M4's, in world-holder.mjs. Nothing imports this file
 * yet; the act door and the gate will.
 *
 * Draft 7: the four state members of an answer and a status (`answer.state`, `status.state`), what
 * every row obeys (`row.resolvedBy.state`, `row.gate.commit.state`, `row.gate.commit.allow`, `row.command`,
 * `row.actionId.digest`), the row in an answer (`answer.row`), and `logicalTime.rows` from 1 in a commit call
 * (`logicalTime.rows.call`). A row's id is the digest of its command, so `checkRow`, `checkAnswer` and `checkRowRead` are
 * async (they hash through the canonical file).
 *
 * Checks return `{ ok: true, ... }` or `{ ok: false, code, rule, at? }`; builders throw an Error with `code` and `rule`.
 * A host value is checked as the encoder reads it (`closed` below: own enumerable string-keyed DATA members only), and a
 * whole message (a request, an answer, a read, a status, a row read) built from a host value is checked on
 * `parse(encode(value))`, so the fields judged are exactly the bytes hashed or sent.
 */
import { DOMAINS, LIMITS, digest, domainMessage, encode, parse } from './capsule-canon.mjs'

export const COMMAND_SCHEMA = 'aukora.act.v1'
export const ENVELOPE_SCHEMA = 'aukora.proof.v3'
export const REQUEST_SCHEMA = 'aukora.act-request.v1'
export const POLICY_SCHEMA = 'aukora.capsule-policy.v0'
export const ANSWER_SCHEMA = 'aukora.act-answer.v1'
export const READ_SCHEMA = 'aukora.act-read.v1'
export const STATUS_SCHEMA = 'aukora.act-status.v1'
export const ROW_READ_SCHEMA = 'aukora.act-row.v1'
/** Section 6.2: the world name inside the lineage. */
export const ACT_WORLD = 'node-main-v1'
/** Section 6.4: the verbs of the act door. */
export const VERBS = Object.freeze(['intent', 'act', 'commit', 'abandon'])
/** Section 8: the verbs the gate is asked about (never `abandon`). */
export const GATE_VERBS = Object.freeze(['intent', 'act', 'commit'])
/** Section 8: the gate's two calls, and the verbs each may carry (creation: the request's verb; commit: `commit`). */
export const GATE_CALLS = Object.freeze({ creation: Object.freeze(['intent', 'act']), commit: Object.freeze(['commit']) })
export const DECISIONS = Object.freeze(['ALLOW', 'ESCALATE', 'DENY'])
/** Section 6.5a: a row's states, an answer's results, a read's verbs. */
export const ROW_STATES = Object.freeze(['pending', 'committed', 'abandoned'])
export const RESULTS = Object.freeze(['pending', 'committed', 'abandoned', 'refused'])
export const READ_VERBS = Object.freeze(['status', 'pending', 'row'])
/**
 * Section 6.5a: the code of a refused answer is one of the act-door rows of section 16, exactly: the rows whose "who
 * says it" is the act door, in the table's order. Not the verifier's or record route's codes, not the client's.
 */
export const ACT_DOOR_CODES = Object.freeze([
  'CAPSULE_ACTION_ID_MISMATCH', 'CAPSULE_LINEAGE_MISMATCH', 'PROOF_INVALID', 'PROOF_REPLAYED', 'PROOF_SUPERSEDED',
  'CAPSULE_GENERATION_STALE', 'CAPSULE_INSTANCE_REVOKED', 'BODY_KEY_FORKED', 'WRITER_LEASE_REQUIRED',
  'CAPSULE_INTENT_ALREADY_PLACED', 'CAPSULE_ACTION_CONFLICT', 'CAPSULE_POSITION_STALE', 'CAPSULE_ACTION_UNKNOWN',
  'CAPSULE_ACTION_ABANDONED', 'CAPSULE_ACTION_COMMITTED', 'CAPSULE_INHERITED_LOCKED', 'CAPSULE_GATE_DENIED',
  'CAPSULE_LEDGER_FULL',
])
/**
 * Draft 7 ruling 9: the two refusals of steps 1 and 2 of 6.7. No ledger, chain or holder state has been read, so an
 * answer with one of these codes has `head`, `holderGeneration`, `holderKeyThumb` and `chain` all null, and no other
 * answer has.
 */
export const NO_STATE_CODES = Object.freeze(['CAPSULE_ACTION_ID_MISMATCH', 'CAPSULE_LINEAGE_MISMATCH'])
/** Draft 7 ruling 9: the one answer a world with no holder gives (the first row of 7.3). */
export const NO_HOLDER_CODE = 'CAPSULE_INSTANCE_REVOKED'
/** Section 6.1 and 6.6: a request at most 4,096 bytes, a payload at most 512 hex digits, the ledger cap 1,024 rows. */
export const ACT_LIMITS = Object.freeze({ requestBytes: 4096, payloadHexDigits: 512, ledgerRows: 1024, policyRules: 64 })
/** Section 8: the one safe payload, 24 bytes ("capsule-v0.3-safe-action"). */
export const SAFE_PAYLOAD_HEX = '63617073756c652d76302e332d736166652d616374696f6e'

/** Section 8: policy v0, human-authored, pinned in the build. One rule; everything else is DENY. */
export const POLICY_V0 = Object.freeze({
  schema: POLICY_SCHEMA,
  version: 0,
  rules: Object.freeze([Object.freeze({ op: 'ledger.note.append', target: 'test-ledger', payloadHex: SAFE_PAYLOAD_HEX, needsBudget: false, decision: 'ALLOW' })]),
})
/** The digest of POLICY_V0's canonical bytes under `aukora.capsule-policy.v0`, pinned (the test recomputes it with node:crypto). */
export const POLICY_V0_DIGEST = 'cb9cc3d997a67844fd765f6079c9f9e6724e3daf11674b848b9027432d9a481c'

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const HEX128 = /^[0-9a-f]{128}$/
const PAYLOAD = /^(?:[0-9a-f]{2}){0,256}$/
const KEY_NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const CODE = /^[A-Z][A-Z0-9_]{0,127}$/
/** mirror-do.mjs:42: MIRROR's lineage id is a lowercase UUID, minted once at random (mirror-do.mjs:95). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A raw P-256 public key (65 bytes, 0x04 || X || Y) in its one base64url spelling: 87 characters, no padding. */
const KEY_SPELLING = /^[A-Za-z0-9_-]{87}$/
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const ok = extra => ({ ok: true, ...extra })
const no = (rule, code = 'SCHEMA') => ({ ok: false, code, rule })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integerFrom = (value, min, max = LIMITS.integerMagnitude) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max
/**
 * Exactly these own members, no more and no fewer, read the way the encoder reads them (capsule-canon.mjs, 3.4): a plain
 * object (prototype Object.prototype or none) whose every own key is a string naming an enumerable DATA property. A
 * symbol key, an accessor or a non-enumerable member is refused, so the members checked here are exactly the members
 * that reach the canonical bytes (a hidden member would be checked here and dropped from the bytes that are hashed).
 */
const closed = (value, names) => {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return false
  const own = Reflect.ownKeys(value)
  if (own.length !== names.length) return false
  for (const key of own) {
    if (typeof key !== 'string' || !names.includes(key)) return false
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor.enumerable || !('value' in descriptor)) return false
  }
  return true
}

function refusal(rule, code = 'SCHEMA') {
  const error = new Error(`${code}: ${rule}`)
  error.name = 'ActShapeRefusal'
  error.code = code
  error.rule = rule
  return error
}

/**
 * Decode a raw P-256 public key from its one base64url spelling, or null: 87 characters of the base64url alphabet, the
 * two unused bits of the last character zero, 65 bytes starting 0x04 (uncompressed, as WebCrypto exports `raw`).
 * @param {unknown} text
 * @returns {Uint8Array | null}
 */
function rawKeyOf(text) {
  if (typeof text !== 'string' || !KEY_SPELLING.test(text)) return null
  const bytes = new Uint8Array(65)
  let bits = 0
  let buffer = 0
  let at = 0
  for (const char of text) {
    buffer = (buffer << 6) | BASE64URL.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (buffer >> bits) & 0xff
    }
  }
  if (at !== 65 || (buffer & ((1 << bits) - 1)) !== 0) return null
  return bytes[0] === 0x04 ? bytes : null
}

/** Whether a string is a raw P-256 public key in its one base64url spelling (no curve check: that needs the key import). */
export const isRawKeySpelling = text => rawKeyOf(text) !== null

/**
 * Section 6.2: `digest("aukora.act-lineage.v1", {"mirror": <MIRROR's lineage id>, "world": <world>})`. Derived, never minted.
 * @param {string} mirrorLineageId
 * @param {string} [world]
 * @returns {Promise<string>}
 */
export async function actLineageId(mirrorLineageId, world = ACT_WORLD) {
  if (typeof mirrorLineageId !== 'string' || !UUID.test(mirrorLineageId)) throw refusal('lineage.mirror')
  if (typeof world !== 'string' || !KEY_NAME.test(world)) throw refusal('lineage.world')
  return digest(DOMAINS.lineage, encode({ mirror: mirrorLineageId, world }))
}

/**
 * Section 6.3: a command, `{ schema, lineageId, seq, prev, intentId, op, target, payloadHex }`, closed.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, rule: string }}
 */
export function checkCommand(value) {
  if (!isObject(value)) return no('command.object')
  if (!closed(value, ['schema', 'lineageId', 'seq', 'prev', 'intentId', 'op', 'target', 'payloadHex'])) return no('command.fields')
  if (value.schema !== COMMAND_SCHEMA) return no('command.schema')
  if (typeof value.lineageId !== 'string' || !HEX64.test(value.lineageId)) return no('command.lineageId')
  if (!integerFrom(value.seq, 1)) return no('command.seq')
  if (typeof value.prev !== 'string' || !HEX64.test(value.prev)) return no('command.prev')
  if (typeof value.intentId !== 'string' || !HEX32.test(value.intentId)) return no('command.intentId')
  if (typeof value.op !== 'string' || !KEY_NAME.test(value.op)) return no('command.op')
  if (typeof value.target !== 'string' || !KEY_NAME.test(value.target)) return no('command.target')
  if (typeof value.payloadHex !== 'string' || !PAYLOAD.test(value.payloadHex)) return no('command.payloadHex')
  return ok()
}

/**
 * Section 6.3: a command's id is the digest of its bytes (`aukora.act.v1`). Hashes the bytes it is given; never parses.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export function commandId(bytes) {
  return digest(DOMAINS.act, bytes)
}

/**
 * Section 3.5: a key's thumb, `digest("aukora.key.v1", {"key": <the raw P-256 public key in its one base64url spelling>})`.
 * @param {string} rawPublicKeyBase64url
 * @returns {Promise<string>}
 */
export async function keyThumb(rawPublicKeyBase64url) {
  if (!isRawKeySpelling(rawPublicKeyBase64url)) throw refusal('key.spelling')
  return digest(DOMAINS.key, encode({ key: rawPublicKeyBase64url }))
}

/**
 * Section 6.4: the proof v3 envelope, `{ schema, verb, lineageId, holderGeneration, leaseGeneration, actionId,
 * signerThumb, nextKey }`, closed. No time and no session in it.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, rule: string }}
 */
export function checkEnvelope(value) {
  if (!isObject(value)) return no('envelope.object')
  if (!closed(value, ['schema', 'verb', 'lineageId', 'holderGeneration', 'leaseGeneration', 'actionId', 'signerThumb', 'nextKey'])) return no('envelope.fields')
  if (value.schema !== ENVELOPE_SCHEMA) return no('envelope.schema')
  if (!VERBS.includes(value.verb)) return no('envelope.verb')
  if (typeof value.lineageId !== 'string' || !HEX64.test(value.lineageId)) return no('envelope.lineageId')
  if (!integerFrom(value.holderGeneration, 0)) return no('envelope.holderGeneration')
  if (!integerFrom(value.leaseGeneration, 0)) return no('envelope.leaseGeneration')
  if (typeof value.actionId !== 'string' || !HEX64.test(value.actionId)) return no('envelope.actionId')
  if (typeof value.signerThumb !== 'string' || !HEX64.test(value.signerThumb)) return no('envelope.signerThumb')
  if (!isRawKeySpelling(value.nextKey)) return no('envelope.nextKey')
  return ok()
}

/**
 * The envelope's digest (`aukora.proof.v3`): every comparison of envelopes is on it, never on signature bytes (6.4).
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export function envelopeDigest(bytes) {
  return digest(DOMAINS.proof, bytes)
}

/**
 * The exact bytes the act key signs (6.4): `ascii("aukora.proof.v3") || 0x00 || envelope bytes`. ECDSA P-256 with SHA-256
 * over them signs the envelope's digest. Nothing is parsed or hashed here.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function envelopeSigningMessage(bytes) {
  return domainMessage(DOMAINS.proof, bytes)
}

/**
 * Parse bytes (a request on the wire) or encode a host value (a request being built): the canonical bytes and the value
 * READ BACK FROM THOSE BYTES. A host value is never checked as itself: every later check judges `parse(encode(value))`,
 * so what is checked is exactly what is hashed and sent.
 */
function canonicalOf(input, name = 'request', maxBytes = ACT_LIMITS.requestBytes) {
  try {
    if (input instanceof Uint8Array) {
      if (input.length > maxBytes) return { refused: no(`${name}.size`) }
      return { bytes: input, value: parse(input) }
    }
    const bytes = encode(input)
    if (bytes.length > maxBytes) return { refused: no(`${name}.size`) }
    return { bytes, value: parse(bytes) }
  } catch (error) {
    if (typeof error?.code !== 'string') throw error
    return { refused: { ok: false, code: error.code, rule: `${name}.canon`, ...(error.at === undefined ? {} : { at: error.at }) } }
  }
}

/**
 * Section 6.4 and step 1 of 6.7: a write request, `{ schema, command, envelope, signature }`, closed, at most 4,096 bytes.
 * The command is present for `intent` and `act` and must hash to `envelope.actionId` (else CAPSULE_ACTION_ID_MISMATCH);
 * it is null for `commit` and `abandon`. The signature is 128 lowercase hex digits (raw r || s) and is NOT verified here.
 * @param {Uint8Array | unknown} input The request bytes, or a host value that is encoded first.
 * @returns {Promise<{ ok: true, verb: string, actionId: string, envelopeDigest: string } | { ok: false, code: string, rule: string, at?: number }>}
 */
export async function checkRequest(input) {
  const { refused, value } = canonicalOf(input)
  if (refused) return refused
  if (!isObject(value)) return no('request.object')
  if (!closed(value, ['schema', 'command', 'envelope', 'signature'])) return no('request.fields')
  if (value.schema !== REQUEST_SCHEMA) return no('request.schema')
  const envelope = checkEnvelope(value.envelope)
  if (!envelope.ok) return envelope
  if (typeof value.signature !== 'string' || !HEX128.test(value.signature)) return no('request.signature')
  const { verb, actionId } = value.envelope
  if (verb === 'intent' || verb === 'act') {
    if (value.command === null) return no('request.command')
    const command = checkCommand(value.command)
    if (!command.ok) return command
    if ((await commandId(encode(value.command))) !== actionId) return no('request.actionId', 'CAPSULE_ACTION_ID_MISMATCH')
  } else if (value.command !== null) {
    return no('request.commandNull')
  }
  return ok({ verb, actionId, envelopeDigest: await envelopeDigest(encode(value.envelope)) })
}

/** Every gate input that is an object must be an `aukora.canon.v1` object (section 8). */
function canonFails(value, name) {
  try {
    encode(value)
    return null
  } catch (error) {
    if (typeof error?.code !== 'string') throw error
    return { ok: false, code: error.code, rule: `${name}.canon` }
  }
}

function checkPolicyRule(rule) {
  if (!isObject(rule) || !closed(rule, ['op', 'target', 'payloadHex', 'needsBudget', 'decision'])) return no('policy.rule')
  if (typeof rule.op !== 'string' || !KEY_NAME.test(rule.op)) return no('policy.rule.op')
  if (typeof rule.target !== 'string' || !KEY_NAME.test(rule.target)) return no('policy.rule.target')
  if (typeof rule.payloadHex !== 'string' || !PAYLOAD.test(rule.payloadHex)) return no('policy.rule.payloadHex')
  if (typeof rule.needsBudget !== 'boolean') return no('policy.rule.needsBudget')
  if (!DECISIONS.includes(rule.decision)) return no('policy.rule.decision')
  return ok()
}

/**
 * Section 8: the gate's inputs, `{ proposal, capability, policy, courtResult, lease, logicalTime }`, each closed, for one
 * of its two calls. At `creation`, `proposal.verb` is the request's verb (`intent` or `act`) and
 * `capability.rowGeneration` is null; at `commit` (also the second call inside an `act`), `proposal.verb` is `commit`
 * and `rowGeneration` is the integer generation that placed the row. In both, `courtResult` is null, `ownerBound` is a
 * boolean (the door always passes true; her bench passes false too) and `lease` is `{ held, generation }`. The
 * destination builds them from what it read itself; a refusal here makes the gate DENY.
 * @param {unknown} inputs
 * @param {'creation' | 'commit'} call
 * @returns {{ ok: true } | { ok: false, code: string, rule: string }}
 */
export function checkGateInputs(inputs, call) {
  if (!Object.hasOwn(GATE_CALLS, call)) return no('gate.call')
  if (!isObject(inputs) || !closed(inputs, ['proposal', 'capability', 'policy', 'courtResult', 'lease', 'logicalTime'])) return no('gate.inputs')
  const { proposal, capability, policy, courtResult, lease, logicalTime } = inputs

  if (!isObject(proposal) || !closed(proposal, ['verb', 'command'])) return no('proposal.fields')
  if (!GATE_VERBS.includes(proposal.verb)) return no('proposal.verb')
  if (!GATE_CALLS[call].includes(proposal.verb)) return no('proposal.verb.call')
  const command = checkCommand(proposal.command)
  if (!command.ok) return command
  const proposalCanon = canonFails(proposal, 'proposal')
  if (proposalCanon) return proposalCanon

  if (!isObject(capability) || !closed(capability, ['holderGeneration', 'rowGeneration', 'ownerBound', 'budget'])) return no('capability.fields')
  if (!integerFrom(capability.holderGeneration, 0)) return no('capability.holderGeneration')
  if (capability.rowGeneration !== null && !integerFrom(capability.rowGeneration, 0)) return no('capability.rowGeneration')
  if ((call === 'creation') !== (capability.rowGeneration === null)) return no('capability.rowGeneration.call')
  if (typeof capability.ownerBound !== 'boolean') return no('capability.ownerBound')
  if (capability.budget !== null) return no('capability.budget')

  if (!isObject(policy) || !closed(policy, ['schema', 'version', 'rules'])) return no('policy.fields')
  if (policy.schema !== POLICY_SCHEMA) return no('policy.schema')
  if (policy.version !== 0) return no('policy.version')
  if (!Array.isArray(policy.rules) || policy.rules.length > ACT_LIMITS.policyRules) return no('policy.rules')
  for (const rule of policy.rules) {
    const checked = checkPolicyRule(rule)
    if (!checked.ok) return checked
  }
  const policyCanon = canonFails(policy, 'policy')
  if (policyCanon) return policyCanon

  if (courtResult !== null) return no('courtResult.null')

  if (!isObject(lease) || !closed(lease, ['held', 'generation'])) return no('lease.fields')
  if (typeof lease.held !== 'boolean') return no('lease.held')
  if (!integerFrom(lease.generation, 0)) return no('lease.generation')

  if (!isObject(logicalTime) || !closed(logicalTime, ['seq', 'rows'])) return no('logicalTime.fields')
  if (!integerFrom(logicalTime.seq, 0)) return no('logicalTime.seq')
  if (!integerFrom(logicalTime.rows, 0, ACT_LIMITS.ledgerRows)) return no('logicalTime.rows')
  // Draft 7 ruling 13: at commit the row being committed is counted, so `rows` is at least 1; at creation it is from 0.
  if (call === 'commit' && logicalTime.rows < 1) return no('logicalTime.rows.call')
  return ok()
}

/**
 * Sections 8 and 6.5a: a verdict (the gate's output, and what a row keeps of each call), `{ decision, reason,
 * policyDigest }`, closed. The reason list is hers (her decision contract); until it exists a reason is any code of the
 * form `[A-Z][A-Z0-9_]{0,127}`.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, rule: string }}
 */
export function checkVerdict(value, name = 'verdict') {
  if (!isObject(value) || !closed(value, ['decision', 'reason', 'policyDigest'])) return no(`${name}.fields`)
  if (!DECISIONS.includes(value.decision)) return no(`${name}.decision`)
  if (typeof value.reason !== 'string' || !CODE.test(value.reason)) return no(`${name}.reason`)
  if (typeof value.policyDigest !== 'string' || !HEX64.test(value.policyDigest)) return no(`${name}.policyDigest`)
  return ok()
}

const isHex64 = value => typeof value === 'string' && HEX64.test(value)

/** 6.5a `head: { seq, id }`: the last terminal row's position and id (genesis: 0 and 64 zeros). */
function checkHead(value, name) {
  if (!isObject(value) || !closed(value, ['seq', 'id'])) return no(`${name}.fields`)
  if (!integerFrom(value.seq, 0)) return no(`${name}.seq`)
  if (!isHex64(value.id)) return no(`${name}.id`)
  return ok()
}

/**
 * Section 6.5a: a ledger row, `{ seq, actionId, intentId, state, command, intentBy, resolvedBy, gate }`, closed. `command`
 * is the command object of 6.3; `intentBy` is `{ keyThumb, holderGeneration, chainFirstThumb }`; `resolvedBy` is
 * `{ keyThumb, holderGeneration }` or null; `gate` is `{ creation: verdict, commit: verdict | null }`. Then what every row
 * obeys (draft 7 rulings 10 and 12), each `SCHEMA` when broken, in this order: `resolvedBy` is null exactly when `state` is
 * `pending` (`row.resolvedBy.state`); `gate.commit` is present exactly when `state` is `committed`
 * (`row.gate.commit.state`); a stored commit verdict is ALLOW, since one that is not is never stored
 * (`row.gate.commit.allow`); `seq` and `intentId` are the command's (`row.command`); `actionId` is the digest of the
 * command's canonical bytes (`row.actionId.digest`).
 * @param {unknown} value
 * @returns {Promise<{ ok: true } | { ok: false, code: string, rule: string }>}
 */
export async function checkRow(value) {
  if (!isObject(value) || !closed(value, ['seq', 'actionId', 'intentId', 'state', 'command', 'intentBy', 'resolvedBy', 'gate'])) return no('row.fields')
  if (!integerFrom(value.seq, 1)) return no('row.seq')
  if (!isHex64(value.actionId)) return no('row.actionId')
  if (typeof value.intentId !== 'string' || !HEX32.test(value.intentId)) return no('row.intentId')
  if (!ROW_STATES.includes(value.state)) return no('row.state')
  const command = checkCommand(value.command)
  if (!command.ok) return command
  const intentBy = value.intentBy
  if (!isObject(intentBy) || !closed(intentBy, ['keyThumb', 'holderGeneration', 'chainFirstThumb'])) return no('row.intentBy.fields')
  if (!isHex64(intentBy.keyThumb)) return no('row.intentBy.keyThumb')
  if (!integerFrom(intentBy.holderGeneration, 0)) return no('row.intentBy.holderGeneration')
  if (!isHex64(intentBy.chainFirstThumb)) return no('row.intentBy.chainFirstThumb')
  const resolvedBy = value.resolvedBy
  if (resolvedBy !== null) {
    if (!isObject(resolvedBy) || !closed(resolvedBy, ['keyThumb', 'holderGeneration'])) return no('row.resolvedBy.fields')
    if (!isHex64(resolvedBy.keyThumb)) return no('row.resolvedBy.keyThumb')
    if (!integerFrom(resolvedBy.holderGeneration, 0)) return no('row.resolvedBy.holderGeneration')
  }
  const gate = value.gate
  if (!isObject(gate) || !closed(gate, ['creation', 'commit'])) return no('row.gate.fields')
  const creation = checkVerdict(gate.creation, 'row.gate.creation')
  if (!creation.ok) return creation
  if (gate.commit !== null) {
    const commit = checkVerdict(gate.commit, 'row.gate.commit')
    if (!commit.ok) return commit
  }
  if ((resolvedBy === null) !== (value.state === 'pending')) return no('row.resolvedBy.state')
  if ((gate.commit !== null) !== (value.state === 'committed')) return no('row.gate.commit.state')
  if (gate.commit !== null && gate.commit.decision !== 'ALLOW') return no('row.gate.commit.allow')
  if (value.seq !== value.command.seq || value.intentId !== value.command.intentId) return no('row.command')
  if ((await commandId(encode(value.command))) !== value.actionId) return no('row.actionId.digest')
  return ok()
}

/**
 * Section 6.5a: the chain after a request, `{ firstThumb, currentThumb, lastDigest, locked }`, closed. `lastDigest` is the
 * digest of the envelope most recently verified, or null.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, rule: string }}
 */
export function checkChain(value) {
  if (!isObject(value) || !closed(value, ['firstThumb', 'currentThumb', 'lastDigest', 'locked'])) return no('chain.fields')
  if (!isHex64(value.firstThumb)) return no('chain.firstThumb')
  if (!isHex64(value.currentThumb)) return no('chain.currentThumb')
  if (value.lastDigest !== null && !isHex64(value.lastDigest)) return no('chain.lastDigest')
  if (typeof value.locked !== 'boolean') return no('chain.locked')
  return ok()
}

/** A whole message (bytes, or a host value judged on parse(encode(value))): bounded only by section 3.2. */
const messageOf = (input, name) => canonicalOf(input, name, LIMITS.textBytes)

/**
 * Sections 6.4 and 6.5a: the answer of the act door, `{ schema, envelopeDigest, verified, result, code, row, head,
 * holderGeneration, holderKeyThumb, chain }`, closed. `code` is null unless `result` is `refused`, and is then one of
 * ACT_DOOR_CODES (rule `answer.code`). `row`, `head`, `holderGeneration`, `holderKeyThumb` and `chain` are each their shape
 * or null; which may be null is ruling 9 of draft 7 (rule `answer.state`): all four state members null exactly when the
 * code is one of NO_STATE_CODES; `holderKeyThumb` and `chain` null with `head` and `holderGeneration` present only in a
 * refused CAPSULE_INSTANCE_REVOKED (a world with no holder); in every other answer all four present, and `holderKeyThumb`
 * null exactly when `chain` is null. The row (ruling 11, rule `answer.row`): with `result` `pending`, `committed` or
 * `abandoned` it is present and its state is the result; refused with a NO_STATE_CODES code it is null; refused otherwise
 * it may be null or a row (which row cannot be checked from the answer alone).
 * @param {Uint8Array | unknown} input The answer's bytes, or a host value that is encoded first.
 * @returns {Promise<{ ok: true } | { ok: false, code: string, rule: string, at?: number }>}
 */
export async function checkAnswer(input) {
  const { refused, value } = messageOf(input, 'answer')
  if (refused) return refused
  if (!isObject(value) || !closed(value, ['schema', 'envelopeDigest', 'verified', 'result', 'code', 'row', 'head', 'holderGeneration', 'holderKeyThumb', 'chain'])) return no('answer.fields')
  if (value.schema !== ANSWER_SCHEMA) return no('answer.schema')
  if (!isHex64(value.envelopeDigest)) return no('answer.envelopeDigest')
  if (typeof value.verified !== 'boolean') return no('answer.verified')
  if (!RESULTS.includes(value.result)) return no('answer.result')
  if (value.result === 'refused' ? !ACT_DOOR_CODES.includes(value.code) : value.code !== null) return no('answer.code')
  if (value.row !== null) {
    const row = await checkRow(value.row)
    if (!row.ok) return row
  }
  if (value.head !== null) {
    const head = checkHead(value.head, 'answer.head')
    if (!head.ok) return head
  }
  if (value.holderGeneration !== null && !integerFrom(value.holderGeneration, 0)) return no('answer.holderGeneration')
  if (value.holderKeyThumb !== null && !isHex64(value.holderKeyThumb)) return no('answer.holderKeyThumb')
  if (value.chain !== null) {
    const chain = checkChain(value.chain)
    if (!chain.ok) return chain
  }
  const noState = NO_STATE_CODES.includes(value.code)
  const nulls = [value.head, value.holderGeneration, value.holderKeyThumb, value.chain].filter(member => member === null).length
  if (noState ? nulls !== 4 : !stateMembersOk(value)) return no('answer.state')
  if (value.result === 'refused' ? noState && value.row !== null : value.row === null || value.row.state !== value.result) return no('answer.row')
  return ok()
}

/**
 * Ruling 9 for an answer that read state: `head` and `holderGeneration` present; `holderKeyThumb` null exactly when `chain`
 * is null; and both null (a world with no holder) only in a refused CAPSULE_INSTANCE_REVOKED.
 */
function stateMembersOk(value) {
  if (value.head === null || value.holderGeneration === null) return false
  if ((value.holderKeyThumb === null) !== (value.chain === null)) return false
  return value.chain !== null || (value.result === 'refused' && value.code === NO_HOLDER_CODE)
}

/**
 * Section 6.5a: a read, `{ schema, verb, actionId, intentId }`, closed. `row` takes exactly one of `actionId` (hex64) and
 * `intentId` (32 lowercase hex) and the other is null; `status` and `pending` take both null (rule `read.ids`).
 * @param {Uint8Array | unknown} input
 * @returns {{ ok: true, verb: string } | { ok: false, code: string, rule: string, at?: number }}
 */
export function checkRead(input) {
  const { refused, value } = messageOf(input, 'read')
  if (refused) return refused
  if (!isObject(value) || !closed(value, ['schema', 'verb', 'actionId', 'intentId'])) return no('read.fields')
  if (value.schema !== READ_SCHEMA) return no('read.schema')
  if (!READ_VERBS.includes(value.verb)) return no('read.verb')
  if (value.actionId !== null && !isHex64(value.actionId)) return no('read.actionId')
  if (value.intentId !== null && (typeof value.intentId !== 'string' || !HEX32.test(value.intentId))) return no('read.intentId')
  const given = Number(value.actionId !== null) + Number(value.intentId !== null)
  if (given !== (value.verb === 'row' ? 1 : 0)) return no('read.ids')
  return ok({ verb: value.verb })
}

/**
 * Sections 6.5 and 6.5a: the status read's answer, `{ schema, lineageId, holderGeneration, holderKeyThumb, lease: { held,
 * generation }, chain, head: { seq, id }, pending }`, closed; `pending` is true or false; `lease.generation` is an integer
 * from 0 whether or not a lease is held. Ruling 9 of draft 7 (rule `status.state`): `holderKeyThumb` is null exactly when
 * `chain` is null (a world with no holder; `head` and `holderGeneration` are always present).
 * @param {Uint8Array | unknown} input
 * @returns {{ ok: true } | { ok: false, code: string, rule: string, at?: number }}
 */
export function checkStatus(input) {
  const { refused, value } = messageOf(input, 'status')
  if (refused) return refused
  if (!isObject(value) || !closed(value, ['schema', 'lineageId', 'holderGeneration', 'holderKeyThumb', 'lease', 'chain', 'head', 'pending'])) return no('status.fields')
  if (value.schema !== STATUS_SCHEMA) return no('status.schema')
  if (!isHex64(value.lineageId)) return no('status.lineageId')
  if (!integerFrom(value.holderGeneration, 0)) return no('status.holderGeneration')
  if (value.holderKeyThumb !== null && !isHex64(value.holderKeyThumb)) return no('status.holderKeyThumb')
  const lease = value.lease
  if (!isObject(lease) || !closed(lease, ['held', 'generation'])) return no('status.lease.fields')
  if (typeof lease.held !== 'boolean') return no('status.lease.held')
  if (!integerFrom(lease.generation, 0)) return no('status.lease.generation')
  if (value.chain !== null) {
    const chain = checkChain(value.chain)
    if (!chain.ok) return chain
  }
  const head = checkHead(value.head, 'status.head')
  if (!head.ok) return head
  if (typeof value.pending !== 'boolean') return no('status.pending')
  if ((value.holderKeyThumb === null) !== (value.chain === null)) return no('status.state')
  return ok()
}

/**
 * Section 6.5a: the answer to a `pending` or a `row` read, `{ schema, row }`, closed; `row` is a row or null (none).
 * @param {Uint8Array | unknown} input
 * @returns {Promise<{ ok: true } | { ok: false, code: string, rule: string, at?: number }>}
 */
export async function checkRowRead(input) {
  const { refused, value } = messageOf(input, 'rowread')
  if (refused) return refused
  if (!isObject(value) || !closed(value, ['schema', 'row'])) return no('rowread.fields')
  if (value.schema !== ROW_READ_SCHEMA) return no('rowread.schema')
  return value.row === null ? ok() : checkRow(value.row)
}

/**
 * The shapes of 6.5a and the gate's call rule, one row per field, for people (docs/capsule/SCHEMA.md holds the same rows;
 * capsule-act-shapes.test.mjs fails if one is missing there). `rule` is the rule name a refusal of that field carries.
 */
export const ACT_SHAPE_TABLE = Object.freeze([
  ['verdict', 'decision', 'one of ALLOW, ESCALATE, DENY', 'verdict.decision'],
  ['verdict', 'reason', 'a code, `[A-Z][A-Z0-9_]{0,127}` (her closed list, once written)', 'verdict.reason'],
  ['verdict', 'policyDigest', 'hex64', 'verdict.policyDigest'],
  ['row', 'seq', 'integer from 1', 'row.seq'],
  ['row', 'actionId', 'hex64', 'row.actionId'],
  ['row', 'intentId', '32 lowercase hex', 'row.intentId'],
  ['row', 'state', 'one of pending, committed, abandoned', 'row.state'],
  ['row', 'command', 'the command object of 6.3', 'command.*'],
  ['row', 'intentBy', '{ keyThumb: hex64, holderGeneration: integer from 0, chainFirstThumb: hex64 }', 'row.intentBy.*'],
  ['row', 'resolvedBy', '{ keyThumb: hex64, holderGeneration: integer from 0 } or null', 'row.resolvedBy.*'],
  ['row', 'gate', '{ creation: verdict, commit: verdict or null }', 'row.gate.*'],
  ['row', '(resolvedBy, state)', 'resolvedBy is null exactly when state is pending', 'row.resolvedBy.state'],
  ['row', '(gate.commit, state)', 'gate.commit is present exactly when state is committed', 'row.gate.commit.state'],
  ['row', 'gate.commit.decision', 'ALLOW: a commit verdict that is not ALLOW is never stored', 'row.gate.commit.allow'],
  ['row', '(seq, intentId)', 'the command\'s seq and intentId', 'row.command'],
  ['row', '(actionId, command)', 'actionId is the digest of the command (aukora.act.v1)', 'row.actionId.digest'],
  ['chain', 'firstThumb', 'hex64', 'chain.firstThumb'],
  ['chain', 'currentThumb', 'hex64', 'chain.currentThumb'],
  ['chain', 'lastDigest', 'hex64 or null', 'chain.lastDigest'],
  ['chain', 'locked', 'boolean', 'chain.locked'],
  ['answer', 'schema', '"aukora.act-answer.v1"', 'answer.schema'],
  ['answer', 'envelopeDigest', 'hex64', 'answer.envelopeDigest'],
  ['answer', 'verified', 'boolean', 'answer.verified'],
  ['answer', 'result', 'one of pending, committed, abandoned, refused', 'answer.result'],
  ['answer', 'code', 'null unless result is refused; then one of the 18 act-door codes of section 16', 'answer.code'],
  ['answer', 'row', 'row or null', 'row.*'],
  ['answer', 'head', '{ seq: integer from 0, id: hex64 } or null', 'answer.head.*'],
  ['answer', 'holderGeneration', 'integer from 0 or null', 'answer.holderGeneration'],
  ['answer', 'holderKeyThumb', 'hex64 or null', 'answer.holderKeyThumb'],
  ['answer', 'chain', 'chain or null', 'chain.*'],
  ['answer', '(head, holderGeneration, holderKeyThumb, chain)', 'all four null exactly when code is CAPSULE_ACTION_ID_MISMATCH or CAPSULE_LINEAGE_MISMATCH; holderKeyThumb and chain null (head and holderGeneration present) only in a refused CAPSULE_INSTANCE_REVOKED; otherwise all four present', 'answer.state'],
  ['answer', '(row, result)', 'pending, committed, abandoned: a row whose state is the result; refused with one of the two codes above: null; refused otherwise: a row or null', 'answer.row'],
  ['read', 'schema', '"aukora.act-read.v1"', 'read.schema'],
  ['read', 'verb', 'one of status, pending, row', 'read.verb'],
  ['read', 'actionId', 'hex64 or null', 'read.actionId'],
  ['read', 'intentId', '32 lowercase hex or null', 'read.intentId'],
  ['read', '(actionId, intentId)', 'row: exactly one of the two is set; status and pending: both null', 'read.ids'],
  ['status', 'schema', '"aukora.act-status.v1"', 'status.schema'],
  ['status', 'lineageId', 'hex64', 'status.lineageId'],
  ['status', 'holderGeneration', 'integer from 0', 'status.holderGeneration'],
  ['status', 'holderKeyThumb', 'hex64 or null', 'status.holderKeyThumb'],
  ['status', 'lease', '{ held: boolean, generation: integer from 0 }', 'status.lease.*'],
  ['status', 'chain', 'chain or null', 'chain.*'],
  ['status', 'head', '{ seq: integer from 0, id: hex64 }', 'status.head.*'],
  ['status', 'pending', 'boolean', 'status.pending'],
  ['status', '(holderKeyThumb, chain)', 'both null (a world with no holder) or both present', 'status.state'],
  ['rowread', 'schema', '"aukora.act-row.v1"', 'rowread.schema'],
  ['rowread', 'row', 'row or null (none)', 'row.*'],
  ['gate inputs', '(call)', 'creation or commit', 'gate.call'],
  ['gate inputs', 'proposal.verb', 'creation: intent or act; commit: commit', 'proposal.verb.call'],
  ['gate inputs', 'capability.rowGeneration', 'creation: null; commit: integer from 0', 'capability.rowGeneration.call'],
  ['gate inputs', 'capability.ownerBound', 'boolean (the door passes true; her bench may pass false)', 'capability.ownerBound'],
  ['gate inputs', 'courtResult', 'null', 'courtResult.null'],
  ['gate inputs', 'lease', '{ held: boolean, generation: integer from 0 }', 'lease.*'],
  ['gate inputs', 'logicalTime.rows', 'creation: from 0; commit: from 1 (the row being committed is counted); at most 1,024', 'logicalTime.rows.call'],
].map(([shape, field, type, rule]) => Object.freeze({ shape, field, type, rule })))

/**
 * A policy's digest (`aukora.capsule-policy.v0` over its canonical bytes).
 * @param {unknown} policy
 * @returns {Promise<string>}
 */
export function policyDigest(policy) {
  return digest(DOMAINS.policy, encode(policy))
}
