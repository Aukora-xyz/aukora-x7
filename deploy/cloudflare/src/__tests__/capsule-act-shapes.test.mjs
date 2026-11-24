// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The act shapes (CONTRACT.md draft 7, sections 6.2 to 6.5a and 8): one accepted example and one mutation per rule for
 * every shape (the command, the envelope, the request, the verdict, a row, the chain, the answer, a read, the status, the
 * row read, the gate's inputs for each of its two calls); the act-door codes against section 16; the safe payload and
 * that payload plus one byte; the policy v0 digest pinned; a stated id that is the digest of other bytes; the act-* rows
 * of the vectors file, each shape row judged by its check, whose digests this test recomputes with node:crypto (one
 * helper, `sha256`, on the allow-list of capsule-rule.test.mjs), never with the module.
 * The module verifies no signature; this test signs once with node:crypto only to show which bytes a key signs.
 */
import assert from 'node:assert/strict'
import { createECDH, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import VECTORS from '../capsule-canon.vectors.json' with { type: 'json' }
import { encode, parse } from '../capsule-canon.mjs'
import {
  ACT_DOOR_CODES, ACT_LIMITS, ACT_SHAPE_TABLE, ACT_WORLD, GATE_CALLS, POLICY_V0, POLICY_V0_DIGEST, SAFE_PAYLOAD_HEX, actLineageId,
  checkAnswer, checkChain, checkCommand, checkEnvelope, checkGateInputs, checkRead, checkRequest, checkRow, checkRowRead,
  checkStatus, checkVerdict, commandId, envelopeDigest, envelopeSigningMessage, isRawKeySpelling, keyThumb, policyDigest,
} from '../capsule-act-shapes.mjs'
import { CAPSULE_CODES } from '../capsule-envelope.mjs'

/** The independent sha256 (node:crypto), never the module's. */
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const independent = (domain, bytes) => sha256(Buffer.concat([Buffer.from(domain, 'ascii'), Buffer.from([0]), Buffer.from(bytes)]))
const ascii = text => new Uint8Array(Buffer.from(text, 'latin1'))
const H = char => char.repeat(64)
const row = name => {
  const found = VECTORS.rows.find(entry => entry.name === name)
  assert.ok(found, name)
  return found
}
const fromHex = hex => new Uint8Array(Buffer.from(hex, 'hex'))

// The fixed test world of the vectors file (gen-vectors.mjs, the capsule canon).
const MIRROR = '0f8fad5b-d9cb-469f-a165-70867728950e'
const keyPair = scalar => {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.alloc(32, scalar))
  const raw = ecdh.getPublicKey()
  const jwk = { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }
  return { raw: raw.toString('base64url'), privateKey: createPrivateKey({ key: { ...jwk, d: ecdh.getPrivateKey().toString('base64url') }, format: 'jwk' }), publicKey: createPublicKey({ key: jwk, format: 'jwk' }) }
}
const KEY1 = keyPair(1)
const KEY2 = keyPair(2)
const LINEAGE = independent('aukora.act-lineage.v1', ascii(`{"mirror":"${MIRROR}","world":"node-main-v1"}`))
const THUMB1 = independent('aukora.key.v1', ascii(`{"key":"${KEY1.raw}"}`))

const command = (payloadHex = SAFE_PAYLOAD_HEX) => ({
  schema: 'aukora.act.v1', lineageId: LINEAGE, seq: 1, prev: H('0'), intentId: '0123456789abcdef'.repeat(2), op: 'ledger.note.append', target: 'test-ledger', payloadHex,
})
const SAFE_ID = independent('aukora.act.v1', encode(command()))
const PLUS_ID = independent('aukora.act.v1', encode(command(`${SAFE_PAYLOAD_HEX}00`)))
const envelope = (verb = 'intent', actionId = SAFE_ID) => ({
  schema: 'aukora.proof.v3', verb, lineageId: LINEAGE, holderGeneration: 1, leaseGeneration: 1, actionId, signerThumb: THUMB1, nextKey: KEY2.raw,
})
const request = (verb = 'intent', commandValue = command(), actionId = SAFE_ID) => ({ schema: 'aukora.act-request.v1', command: commandValue, envelope: envelope(verb, actionId), signature: 'ab'.repeat(64) })
const gateInputs = () => ({
  proposal: { verb: 'act', command: command() },
  capability: { holderGeneration: 1, rowGeneration: null, ownerBound: true, budget: null },
  policy: structuredClone({ ...POLICY_V0, rules: POLICY_V0.rules.map(rule => ({ ...rule })) }),
  courtResult: null,
  lease: { held: true, generation: 1 },
  logicalTime: { seq: 0, rows: 0 },
})
/** The second call: the commit of a row placed at generation 1. */
const commitInputs = () => ({ ...gateInputs(), proposal: { verb: 'commit', command: command() }, capability: { holderGeneration: 2, rowGeneration: 1, ownerBound: true, budget: null }, logicalTime: { seq: 0, rows: 1 } })

// The shapes of 6.5a, as host values.
const THUMB2 = independent('aukora.key.v1', ascii(`{"key":"${KEY2.raw}"}`))
const verdict = (decision = 'ALLOW') => ({ decision, reason: 'RULE_MATCH', policyDigest: POLICY_V0_DIGEST })
const ledgerRow = (state = 'pending') => ({
  seq: 1, actionId: SAFE_ID, intentId: '0123456789abcdef'.repeat(2), state, command: command(),
  intentBy: { keyThumb: THUMB1, holderGeneration: 1, chainFirstThumb: THUMB1 },
  resolvedBy: state === 'pending' ? null : { keyThumb: THUMB1, holderGeneration: 1 },
  gate: { creation: verdict(), commit: state === 'committed' ? verdict() : null },
})
const chain = (lastDigest = H('e')) => ({ firstThumb: THUMB1, currentThumb: THUMB2, lastDigest, locked: false })
const answer = (result = 'committed', code = null) => ({
  schema: 'aukora.act-answer.v1', envelopeDigest: H('e'), verified: result !== 'refused', result, code,
  row: result === 'refused' ? null : ledgerRow(result), head: { seq: result === 'committed' ? 1 : 0, id: result === 'committed' ? SAFE_ID : H('0') },
  holderGeneration: 1, holderKeyThumb: THUMB1, chain: chain(),
})
/** Draft 7 ruling 9: the two refusals of steps 1 and 2 of 6.7 read no state, so all four state members are null. */
const NO_STATE_CODES = ['CAPSULE_ACTION_ID_MISMATCH', 'CAPSULE_LINEAGE_MISMATCH']
const noState = code => ({ ...answer('refused', code), head: null, holderGeneration: null, holderKeyThumb: null, chain: null })
/** A world with no holder (the first row of 7.3): thumb and chain null, head and generation present. */
const noHolder = (code = 'CAPSULE_INSTANCE_REVOKED') => ({ ...answer('refused', code), holderGeneration: 0, holderKeyThumb: null, chain: null })
const read = (verb = 'row', actionId = SAFE_ID, intentId = null) => ({ schema: 'aukora.act-read.v1', verb, actionId, intentId })
const status = () => ({
  schema: 'aukora.act-status.v1', lineageId: LINEAGE, holderGeneration: 1, holderKeyThumb: THUMB1, lease: { held: true, generation: 1 },
  chain: { firstThumb: THUMB1, currentThumb: THUMB1, lastDigest: null, locked: false }, head: { seq: 0, id: H('0') }, pending: false,
})
const rowRead = (row = ledgerRow()) => ({ schema: 'aukora.act-row.v1', row })

/** Apply a mutation to a fresh value and return it. */
const mutated = (make, mutate) => { const value = make(); mutate(value); return value }
const refusedWith = (result, rule, code = 'SCHEMA') => {
  assert.equal(result.ok, false, `${rule}: refused`)
  assert.equal(result.code, code, `${rule}: got ${result.code} ${result.rule}`)
  assert.equal(result.rule, rule, `${rule}: got ${result.code} ${result.rule}`)
}

test('the lineage (6.2): derived from MIRROR\'s lineage id and the world, under aukora.act-lineage.v1', async () => {
  assert.equal(ACT_WORLD, 'node-main-v1')
  assert.equal(await actLineageId(MIRROR), LINEAGE)
  assert.equal(await actLineageId(MIRROR, 'node-main-v1'), row('act-lineage').expect.digests['aukora.act-lineage.v1'])
  assert.notEqual(await actLineageId('00000000-0000-4000-8000-000000000000'), LINEAGE, 'a reset world has a new lineage')
  // Draft 7 ruling 7: 8-4-4-4-12 lowercase hex with its dashes; the version and variant digits are not checked.
  for (const mirror of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '0f8fad5b-d9cb-f69f-0165-70867728950e']) {
    assert.match(await actLineageId(mirror), /^[0-9a-f]{64}$/, mirror)
  }
  for (const [mirror, world, rule] of [
    [MIRROR.toUpperCase(), 'node-main-v1', 'lineage.mirror'], ['not-a-uuid', 'node-main-v1', 'lineage.mirror'], [42, 'node-main-v1', 'lineage.mirror'],
    [MIRROR.replaceAll('-', ''), 'node-main-v1', 'lineage.mirror'], [`{${MIRROR}}`, 'node-main-v1', 'lineage.mirror'], [`${MIRROR.slice(0, -1)}g`, 'node-main-v1', 'lineage.mirror'],
    [MIRROR, 'x61 main', 'lineage.world'], [MIRROR, '', 'lineage.world'], [MIRROR, 'w'.repeat(65), 'lineage.world'],
  ]) await assert.rejects(actLineageId(mirror, world), error => error.code === 'SCHEMA' && error.rule === rule, rule)
})

test('the command (6.3): one accepted example and one mutation per rule; its id is the digest of its bytes', async () => {
  assert.deepEqual(checkCommand(command()), { ok: true })
  assert.equal(await commandId(encode(command())), SAFE_ID)
  assert.equal(SAFE_ID, row('act-command-safe-payload').expect.digests['aukora.act.v1'])
  assert.equal(PLUS_ID, row('act-command-safe-payload-plus-one-byte').expect.digests['aukora.act.v1'])
  assert.equal(Buffer.from(fromHex(SAFE_PAYLOAD_HEX)).toString('latin1'), 'capsule-v0.3-safe-action')
  assert.equal(fromHex(SAFE_PAYLOAD_HEX).length, 24)
  assert.deepEqual(checkCommand(command(`${SAFE_PAYLOAD_HEX}00`)), { ok: true }, 'the payload plus one byte is a valid shape (the gate denies it)')
  assert.notEqual(SAFE_ID, PLUS_ID)
  assert.deepEqual(checkCommand(command('ab'.repeat(256))), { ok: true }, '512 hex digits')
  for (const [rule, mutate] of [
    ['command.fields', value => { delete value.prev }], ['command.fields', value => { value.at = 1 }],
    ['command.schema', value => { value.schema = 'aukora.act.v2' }], ['command.lineageId', value => { value.lineageId = H('A') }],
    ['command.seq', value => { value.seq = 0 }], ['command.seq', value => { value.seq = 1.5 }], ['command.seq', value => { value.seq = '1' }],
    ['command.prev', value => { value.prev = H('0').slice(1) }], ['command.intentId', value => { value.intentId = H('3') }],
    ['command.intentId', value => { value.intentId = 'ABCDEF'.repeat(5).slice(0, 32) }], ['command.op', value => { value.op = '' }],
    ['command.op', value => { value.op = 'o'.repeat(65) }], ['command.target', value => { value.target = 'test ledger' }],
    ['command.payloadHex', value => { value.payloadHex = 'abc' }], ['command.payloadHex', value => { value.payloadHex = 'AB' }],
    ['command.payloadHex', value => { value.payloadHex = 'ab'.repeat(257) }], ['command.payloadHex', value => { value.payloadHex = 'zz' }],
  ]) refusedWith(checkCommand(mutated(command, mutate)), rule)
  refusedWith(checkCommand([command()]), 'command.object')
  refusedWith(checkCommand(null), 'command.object')
  // The id hashes whatever bytes it is given: other bytes, another id.
  assert.equal(await commandId(ascii('{ }')), independent('aukora.act.v1', ascii('{ }')))
})

test('the key thumb (3.5): a raw P-256 public key in its one base64url spelling', async () => {
  assert.equal(KEY1.raw.length, 87)
  assert.equal(await keyThumb(KEY1.raw), THUMB1)
  assert.equal(THUMB1, row('act-key-thumb').expect.digests['aukora.key.v1'])
  assert.equal(isRawKeySpelling(KEY2.raw), true)
  const bytes = Buffer.from(KEY1.raw, 'base64url')
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  // The last character carries 4 bits of the key and 2 unused bits: setting an unused bit gives another spelling of the same bytes.
  const otherLast = KEY1.raw.slice(0, -1) + ALPHABET[ALPHABET.indexOf(KEY1.raw.at(-1)) ^ 1]
  assert.ok(Buffer.from(otherLast, 'base64url').equals(bytes) && otherLast !== KEY1.raw, 'node reads the other spelling as the same bytes')
  for (const [name, spelling] of [
    ['one character short', KEY1.raw.slice(0, -1)], ['one character long', `${KEY1.raw}A`], ['padded', `${KEY1.raw}=`],
    ['a standard-base64 character', `+${KEY1.raw.slice(1)}`], ['a slash', `${KEY1.raw.slice(0, 40)}/${KEY1.raw.slice(41)}`], ['a non-zero unused bit (another spelling of the same bytes)', otherLast],
    ['not 0x04 first', Buffer.concat([Buffer.from([5]), bytes.subarray(1)]).toString('base64url')], ['not a string', 42], ['a compressed key', Buffer.concat([Buffer.from([2]), bytes.subarray(1, 33)]).toString('base64url')],
  ]) {
    assert.equal(isRawKeySpelling(spelling), false, name)
    await assert.rejects(keyThumb(spelling), error => error.code === 'SCHEMA' && error.rule === 'key.spelling', name)
  }
})

test('the envelope (6.4): one accepted example and one mutation per rule; its digest; the exact bytes the key signs', async () => {
  assert.deepEqual(checkEnvelope(envelope()), { ok: true })
  for (const verb of ['intent', 'act', 'commit', 'abandon']) assert.deepEqual(checkEnvelope(envelope(verb)), { ok: true }, verb)
  for (const [rule, mutate] of [
    ['envelope.fields', value => { delete value.nextKey }], ['envelope.fields', value => { value.session = 's' }], ['envelope.fields', value => { value.atMs = 1 }],
    ['envelope.schema', value => { value.schema = 'aukora.proof.v2' }], ['envelope.verb', value => { value.verb = 'reserve' }],
    ['envelope.lineageId', value => { value.lineageId = 'x' }], ['envelope.holderGeneration', value => { value.holderGeneration = -1 }],
    ['envelope.leaseGeneration', value => { value.leaseGeneration = 'lease-1' }], ['envelope.actionId', value => { value.actionId = H('g') }],
    ['envelope.signerThumb', value => { value.signerThumb = KEY1.raw }], ['envelope.nextKey', value => { value.nextKey = THUMB1 }],
  ]) refusedWith(checkEnvelope(mutated(envelope, mutate)), rule)
  refusedWith(checkEnvelope('envelope'), 'envelope.object')
  const bytes = encode(envelope())
  assert.equal(await envelopeDigest(bytes), independent('aukora.proof.v3', bytes))
  assert.equal(await envelopeDigest(bytes), row('act-envelope-intent').expect.digests['aukora.proof.v3'])
  const message = envelopeSigningMessage(bytes)
  assert.deepEqual(Buffer.from(message), Buffer.concat([Buffer.from('aukora.proof.v3', 'ascii'), Buffer.from([0]), Buffer.from(bytes)]))
  assert.equal(sha256(message), await envelopeDigest(bytes), 'ECDSA with SHA-256 over these bytes signs the envelope digest')
  // Shown with node:crypto only (the module verifies nothing): a raw r || s signature over the message is 128 hex digits.
  const signature = sign('sha256', message, { key: KEY1.privateKey, dsaEncoding: 'ieee-p1363' })
  assert.equal(signature.length, 64)
  assert.equal(verify('sha256', message, { key: KEY1.publicKey, dsaEncoding: 'ieee-p1363' }, signature), true)
  assert.equal(verify('sha256', bytes, { key: KEY1.publicKey, dsaEncoding: 'ieee-p1363' }, signature), false, 'never the bare envelope bytes')
  assert.equal((await checkRequest({ ...request(), signature: signature.toString('hex') })).ok, true)
})

test('the request (6.4, step 1 of 6.7): closed, at most 4,096 bytes, the command hashing to the stated id', async () => {
  const good = await checkRequest(request())
  assert.deepEqual(good, { ok: true, verb: 'intent', actionId: SAFE_ID, envelopeDigest: independent('aukora.proof.v3', encode(envelope())) })
  const bytes = encode(request())
  assert.equal(bytes.length <= ACT_LIMITS.requestBytes, true)
  assert.deepEqual(await checkRequest(bytes), good, 'the same answer from the bytes')
  assert.equal(independent('aukora.capsule.v1', bytes), row('act-request-intent').expect.digests['aukora.capsule.v1'])
  assert.equal((await checkRequest(request('act'))).ok, true)
  assert.equal((await checkRequest(request('commit', null))).ok, true)
  assert.equal(independent('aukora.capsule.v1', encode(request('commit', null))), row('act-request-commit').expect.digests['aukora.capsule.v1'])
  assert.equal((await checkRequest(request('abandon', null))).ok, true)
  // A stated id that is the digest of other bytes (the payload plus one byte).
  refusedWith(await checkRequest(request('intent', command(), PLUS_ID)), 'request.actionId', 'CAPSULE_ACTION_ID_MISMATCH')
  refusedWith(await checkRequest(request('act', command(`${SAFE_PAYLOAD_HEX}00`), SAFE_ID)), 'request.actionId', 'CAPSULE_ACTION_ID_MISMATCH')
  assert.equal((await checkRequest(request('act', command(`${SAFE_PAYLOAD_HEX}00`), PLUS_ID))).ok, true, 'the plus-one payload under its own id is a valid shape')
  for (const [rule, value] of [
    ['request.fields', mutated(request, value => { delete value.signature })], ['request.fields', mutated(request, value => { value.session = 'x' })],
    ['request.schema', mutated(request, value => { value.schema = 'aukora.act-request.v2' })],
    ['envelope.verb', mutated(request, value => { value.envelope.verb = 'reserve' })],
    ['request.signature', mutated(request, value => { value.signature = 'ab'.repeat(63) })], ['request.signature', mutated(request, value => { value.signature = 'AB'.repeat(64) })],
    ['request.command', request('act', null)], ['request.command', request('intent', null)],
    ['command.payloadHex', mutated(request, value => { value.command.payloadHex = 'abc' })],
    ['request.commandNull', request('commit', command())], ['request.commandNull', request('abandon', command())],
  ]) refusedWith(await checkRequest(value), rule)
  // Too large: by the bytes, before any parse; and as a value, after encoding.
  refusedWith(await checkRequest(new Uint8Array(ACT_LIMITS.requestBytes + 1).fill(0x20)), 'request.size')
  refusedWith(await checkRequest(mutated(request, value => { value.command.op = 'o'.repeat(64); value.signature = 'ab'.repeat(64); value.padA = 'p'.repeat(2048); value.padB = 'p'.repeat(2048) })), 'request.size')
  // Not canonical: refused by its class and position (step 1 parses under 3.3).
  const spaced = ascii(Buffer.from(bytes).toString('latin1').replace('"seq":1', '"seq": 1'))
  const canon = await checkRequest(spaced)
  assert.deepEqual([canon.ok, canon.code, canon.rule, typeof canon.at], [false, 'SYNTAX', 'request.canon', 'number'])
  assert.equal((await checkRequest([request()])).code, 'TYPE')
})

test('the gate\'s inputs for its two calls and its output (section 8): one accepted example and one mutation per rule', () => {
  assert.deepEqual(checkGateInputs(gateInputs(), 'creation'), { ok: true })
  assert.deepEqual(checkGateInputs(commitInputs(), 'commit'), { ok: true })
  assert.deepEqual(Object.keys(GATE_CALLS), ['creation', 'commit'])
  for (const verb of ['intent', 'act']) assert.deepEqual(checkGateInputs(mutated(gateInputs, value => { value.proposal.verb = verb }), 'creation'), { ok: true }, verb)
  for (const ownerBound of [true, false]) {
    assert.deepEqual(checkGateInputs(mutated(gateInputs, value => { value.capability.ownerBound = ownerBound }), 'creation'), { ok: true }, `ownerBound ${ownerBound}`)
    assert.deepEqual(checkGateInputs(mutated(commitInputs, value => { value.capability.ownerBound = ownerBound }), 'commit'), { ok: true }, `ownerBound ${ownerBound}`)
  }
  // The call rule: creation is intent or act with no row generation; commit is commit with the row's generation.
  for (const [call, make, rule, mutate] of [
    ['creation', gateInputs, 'proposal.verb.call', value => { value.proposal.verb = 'commit' }],
    ['commit', commitInputs, 'proposal.verb.call', value => { value.proposal.verb = 'act' }],
    ['commit', commitInputs, 'proposal.verb.call', value => { value.proposal.verb = 'intent' }],
    ['creation', gateInputs, 'capability.rowGeneration.call', value => { value.capability.rowGeneration = 1 }],
    ['commit', commitInputs, 'capability.rowGeneration.call', value => { value.capability.rowGeneration = null }],
    ['commit', commitInputs, 'courtResult.null', value => { value.courtResult = { verdict: 'ALLOW' } }],
  ]) refusedWith(checkGateInputs(mutated(make, mutate), call), rule)
  // Draft 7 ruling 13: in a commit call logicalTime.rows is at least 1 (the row being committed is counted); at creation, from 0.
  refusedWith(checkGateInputs(mutated(commitInputs, value => { value.logicalTime.rows = 0 }), 'commit'), 'logicalTime.rows.call')
  assert.deepEqual(checkGateInputs(mutated(commitInputs, value => { value.logicalTime.rows = ACT_LIMITS.ledgerRows }), 'commit'), { ok: true })
  assert.deepEqual(checkGateInputs(mutated(gateInputs, value => { value.logicalTime.rows = 0 }), 'creation'), { ok: true }, 'creation counts the rows before it: 0 in an empty ledger')
  for (const call of [undefined, 'act', 'Creation', 'abandon', 'toString', '__proto__']) refusedWith(checkGateInputs(gateInputs(), call), 'gate.call')
  for (const [rule, mutate] of [
    ['gate.inputs', value => { delete value.logicalTime }], ['gate.inputs', value => { value.clock = 1 }],
    ['proposal.fields', value => { value.proposal.note = 'x' }], ['proposal.verb', value => { value.proposal.verb = 'abandon' }],
    ['proposal.verb', value => { value.proposal.verb = 'reserve' }],
    ['command.seq', value => { value.proposal.command.seq = 0 }],
    ['capability.fields', value => { delete value.capability.budget }], ['capability.holderGeneration', value => { value.capability.holderGeneration = -1 }],
    ['capability.rowGeneration', value => { value.capability.rowGeneration = 'g1' }], ['capability.ownerBound', value => { value.capability.ownerBound = null }],
    ['capability.budget', value => { value.capability.budget = { remaining: 1 } }],
    ['policy.fields', value => { value.policy.note = 'x' }], ['policy.schema', value => { value.policy.schema = 'aukora.capsule-policy.v1' }],
    ['policy.version', value => { value.policy.version = 1 }], ['policy.rules', value => { value.policy.rules = {} }],
    ['policy.rules', value => { value.policy.rules = Array.from({ length: 65 }, () => ({ ...POLICY_V0.rules[0] })) }],
    ['policy.rule', value => { value.policy.rules[0].extra = 1 }], ['policy.rule.op', value => { value.policy.rules[0].op = '' }],
    ['policy.rule.target', value => { value.policy.rules[0].target = 'a b' }], ['policy.rule.payloadHex', value => { value.policy.rules[0].payloadHex = 'A' }],
    ['policy.rule.needsBudget', value => { value.policy.rules[0].needsBudget = 0 }], ['policy.rule.decision', value => { value.policy.rules[0].decision = 'allow' }],
    ['courtResult.null', value => { value.courtResult = { verdict: 'ALLOW' } }],
    ['lease.fields', value => { value.lease.id = 'bearer' }], ['lease.held', value => { value.lease.held = 'yes' }], ['lease.generation', value => { value.lease.generation = 1.5 }],
    ['logicalTime.fields', value => { value.logicalTime.atMs = 1 }], ['logicalTime.seq', value => { value.logicalTime.seq = -1 }],
    ['logicalTime.rows', value => { value.logicalTime.rows = ACT_LIMITS.ledgerRows + 1 }],
  ]) refusedWith(checkGateInputs(mutated(gateInputs, mutate), 'creation'), rule)
  assert.equal(checkGateInputs(mutated(gateInputs, value => { value.proposal.command.op = 'ledger.note.append' }), 'creation').ok, true)
  const output = verdict()
  assert.deepEqual(checkVerdict(output), { ok: true })
  for (const decision of ['ESCALATE', 'DENY']) assert.deepEqual(checkVerdict({ ...output, decision }), { ok: true })
  for (const [rule, value] of [
    ['verdict.fields', { ...output, confidence: 1 }], ['verdict.fields', { decision: 'DENY', reason: 'X' }],
    ['verdict.decision', { ...output, decision: 'MAYBE' }], ['verdict.reason', { ...output, reason: 'safe' }],
    ['verdict.policyDigest', { ...output, policyDigest: H('Z') }], ['verdict.fields', null],
  ]) refusedWith(checkVerdict(value), rule)
})

test('policy v0: frozen, one rule, the safe payload exactly; its digest pinned and recomputed with node:crypto', async () => {
  const text = `{"rules":[{"decision":"ALLOW","needsBudget":false,"op":"ledger.note.append","payloadHex":"${SAFE_PAYLOAD_HEX}","target":"test-ledger"}],"schema":"aukora.capsule-policy.v0","version":0}`
  assert.equal(Buffer.from(encode(POLICY_V0)).toString('latin1'), text)
  assert.equal(POLICY_V0_DIGEST, independent('aukora.capsule-policy.v0', ascii(text)))
  assert.equal(POLICY_V0_DIGEST, 'cb9cc3d997a67844fd765f6079c9f9e6724e3daf11674b848b9027432d9a481c')
  assert.equal(await policyDigest(POLICY_V0), POLICY_V0_DIGEST)
  assert.equal(row('act-policy-v0').expect.digests['aukora.capsule-policy.v0'], POLICY_V0_DIGEST)
  assert.ok(Object.isFrozen(POLICY_V0) && Object.isFrozen(POLICY_V0.rules) && Object.isFrozen(POLICY_V0.rules[0]))
  assert.equal(POLICY_V0.rules.length, 1)
  assert.equal(POLICY_V0.rules[0].payloadHex, SAFE_PAYLOAD_HEX)
  assert.notEqual(await policyDigest({ ...POLICY_V0, rules: [{ ...POLICY_V0.rules[0], payloadHex: `${SAFE_PAYLOAD_HEX}00` }] }), POLICY_V0_DIGEST)
})

test('the act-* rows of the vectors file are the examples of this test', () => {
  const names = VECTORS.rows.filter(entry => entry.name.startsWith('act-')).map(entry => entry.name).sort()
  assert.deepEqual(names, [
    'act-answer-committed', 'act-answer-committed-with-a-pending-row', 'act-answer-committed-without-a-row', 'act-answer-lineage-mismatch-with-a-row',
    'act-answer-lineage-mismatch-with-state', 'act-answer-no-holder-shape-with-another-code', 'act-answer-pending-with-a-code', 'act-answer-pending-with-its-row',
    'act-answer-refused-code-outside-list', 'act-answer-refused-conflict-with-a-row', 'act-answer-refused-gate-denied', 'act-answer-refused-lineage-mismatch-no-state',
    'act-answer-refused-no-holder', 'act-answer-thumb-without-chain',
    'act-chain', 'act-chain-locked-not-a-boolean', 'act-command-safe-payload', 'act-command-safe-payload-plus-one-byte', 'act-command-under-its-own-id',
    'act-command-under-the-id-of-other-bytes', 'act-envelope-intent', 'act-gate-inputs-commit', 'act-gate-inputs-commit-verb-at-creation',
    'act-gate-inputs-commit-without-row-generation', 'act-gate-inputs-commit-zero-rows', 'act-gate-inputs-creation', 'act-key-thumb', 'act-lineage', 'act-policy-v0',
    'act-read-row-both-ids', 'act-read-row-by-intent-id', 'act-read-status', 'act-read-status-with-an-id', 'act-request-commit',
    'act-request-commit-with-a-command', 'act-request-intent', 'act-row-abandoned', 'act-row-action-id-of-other-bytes', 'act-row-committed',
    'act-row-committed-with-an-escalate-verdict', 'act-row-committed-without-a-commit-verdict', 'act-row-pending', 'act-row-pending-with-a-deny-commit-verdict',
    'act-row-pending-with-a-resolver', 'act-row-seq-not-the-commands', 'act-row-state-outside-list',
    'act-rowread-none', 'act-rowread-none-as-a-string', 'act-rowread-pending', 'act-status-chain-without-thumb', 'act-status-no-holder',
    'act-status-null-last-digest', 'act-status-pending-not-a-boolean',
    'act-verdict', 'act-verdict-decision-outside-list',
  ])
  assert.equal(row('act-command-safe-payload').inputHex, Buffer.from(encode(command())).toString('hex'))
  assert.equal(row('act-envelope-intent').inputHex, Buffer.from(encode(envelope())).toString('hex'))
  assert.equal(row('act-key-thumb').inputHex, Buffer.from(`{"key":"${KEY1.raw}"}`).toString('hex'))
  assert.equal(row('act-policy-v0').inputHex, Buffer.from(encode(POLICY_V0)).toString('hex'))
  assert.equal(row('act-command-under-the-id-of-other-bytes').presentedUnder.id, PLUS_ID)
})

test('a host value is checked exactly as the encoder reads it: no hidden, accessor, symbol-keyed or foreign members', async () => {
  // The reviewer's case: seven enumerable fields plus an enumerable `z`, and `payloadHex` hidden (non-enumerable).
  const hidden = () => {
    const value = command()
    delete value.payloadHex
    value.z = 'evil'
    Object.defineProperty(value, 'payloadHex', { value: SAFE_PAYLOAD_HEX, enumerable: false })
    return value
  }
  assert.ok(Buffer.from(encode(hidden())).toString('latin1').includes('"z":"evil"'), 'the bytes carry z')
  assert.ok(!Buffer.from(encode(hidden())).toString('latin1').includes('payloadHex'), 'the bytes do not carry payloadHex')
  refusedWith(checkCommand(hidden()), 'command.fields')
  refusedWith(checkGateInputs(mutated(gateInputs, inputs => { inputs.proposal.command = hidden() }), 'creation'), 'command.fields')
  refusedWith(await checkRequest(request('intent', hidden(), independent('aukora.act.v1', encode(hidden())))), 'command.fields')
  // A hidden extra member, an accessor, a symbol key, a foreign prototype: each refused where the fields are checked.
  let ran = false
  const variants = [
    ['a hidden extra member', value => Object.defineProperty(value, 'z', { value: 1, enumerable: false })],
    ['an accessor field', value => { delete value.op; Object.defineProperty(value, 'op', { get() { ran = true; return 'ledger.note.append' }, enumerable: true }) }],
    ['a symbol key', value => { value[Symbol('s')] = 1 }],
  ]
  for (const [name, mutate] of variants) {
    assert.equal(checkCommand(mutated(command, mutate)).rule, 'command.fields', name)
    assert.equal(checkEnvelope(mutated(envelope, mutate)).rule, 'envelope.fields', name)
    assert.equal(checkGateInputs(mutated(gateInputs, inputs => mutate(inputs.lease)), 'creation').rule, 'lease.fields', name)
    assert.equal(checkVerdict(mutated(verdict, mutate)).rule, 'verdict.fields', name)
    assert.equal((await checkRow(mutated(ledgerRow, row => mutate(row.intentBy)))).rule, 'row.intentBy.fields', name)
    assert.equal(checkChain(mutated(chain, mutate)).rule, 'chain.fields', name)
    // A whole message from a host value is judged on parse(encode(value)): a hidden or symbol member is not in the bytes,
    // and an accessor is refused by the encoder (TYPE) before any field is read.
    const message = await checkAnswer(mutated(answer, mutate))
    assert.ok(message.ok || (message.code === 'TYPE' && message.rule === 'answer.canon'), `${name}: ${message.code} ${message.rule}`)
  }
  class Shaped { constructor(fields) { Object.assign(this, fields) } }
  refusedWith(checkCommand(new Shaped(command())), 'command.fields')
  assert.equal(ran, false, 'no getter ran')
  // A null-prototype object (what parse returns) is a plain object.
  assert.deepEqual(checkCommand(Object.assign(Object.create(null), command())), { ok: true })
  // On the host path the request is judged on parse(encode(value)): a hidden member never reaches the checks.
  const hiddenRequest = request()
  Object.defineProperty(hiddenRequest, 'note', { value: 1, enumerable: false })
  assert.equal((await checkRequest(hiddenRequest)).ok, true, 'a hidden member is not in the bytes, so it is not in the request')
})

test('ACT_DOOR_CODES are exactly the act-door rows of section 16, in the table\'s order, and within CAPSULE_CODES', () => {
  const contract = readFileSync(new URL('../../../../docs/capsule/CONTRACT.md', import.meta.url), 'utf8')
  const section = contract.slice(contract.indexOf('\n## 16.'))
  const rows = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)`[^|]*\| ([^|]*) \|/gm)].map(match => [match[1], match[2]])
  assert.ok(rows.length >= 26, String(rows.length))
  assert.deepEqual([...ACT_DOOR_CODES], rows.filter(([, who]) => who.includes('act door')).map(([code]) => code))
  assert.equal(ACT_DOOR_CODES.length, 18)
  assert.ok(Object.isFrozen(ACT_DOOR_CODES))
  for (const code of ACT_DOOR_CODES) assert.ok(CAPSULE_CODES.includes(code), code)
  for (const code of ['CAPSULE_BYTES_MISMATCH', 'CAPSULE_INCOMPLETE', 'CAPSULE_AUTHORITY_REQUIRED', 'CAPSULE_OUTCOME_UNKNOWN', 'DESTINATION_BEHIND', 'SCHEMA']) {
    assert.ok(!ACT_DOOR_CODES.includes(code), `${code} is not said by the act door`)
  }
})

test('6.5a: the verdict, a row and the chain, one accepted example and one mutation per rule', async () => {
  for (const state of ['pending', 'committed', 'abandoned']) assert.deepEqual(await checkRow(ledgerRow(state)), { ok: true }, state)
  assert.deepEqual(await checkRow(Object.assign(Object.create(null), ledgerRow())), { ok: true }, 'a prototype-less row (what parse returns)')
  for (const [rule, mutate] of [
    ['row.fields', row => { delete row.gate }], ['row.fields', row => { row.note = 'x' }],
    ['row.seq', row => { row.seq = 0 }], ['row.actionId', row => { row.actionId = H('A') }], ['row.intentId', row => { row.intentId = H('3') }],
    ['row.state', row => { row.state = 'open' }], ['row.state', row => { row.state = 'refused' }], ['command.payloadHex', row => { row.command.payloadHex = 'A' }],
    ['row.intentBy.fields', row => { delete row.intentBy.chainFirstThumb }], ['row.intentBy.keyThumb', row => { row.intentBy.keyThumb = KEY1.raw }],
    ['row.intentBy.holderGeneration', row => { row.intentBy.holderGeneration = -1 }], ['row.intentBy.chainFirstThumb', row => { row.intentBy.chainFirstThumb = null }],
    ['row.resolvedBy.fields', row => { row.resolvedBy = { keyThumb: THUMB1 } }], ['row.resolvedBy.keyThumb', row => { row.resolvedBy = { keyThumb: 'x', holderGeneration: 1 } }],
    ['row.resolvedBy.holderGeneration', row => { row.resolvedBy = { keyThumb: THUMB1, holderGeneration: '1' } }],
    ['row.gate.fields', row => { row.gate = { creation: verdict() } }], ['row.gate.creation.fields', row => { row.gate.creation = null }],
    ['row.gate.creation.decision', row => { row.gate.creation.decision = 'allow' }], ['row.gate.commit.policyDigest', row => { row.gate.commit = { ...verdict(), policyDigest: 'x' } }],
  ]) refusedWith(await checkRow(mutated(ledgerRow, mutate)), rule)
  refusedWith(await checkRow([ledgerRow()]), 'row.fields')
  assert.deepEqual(checkChain(chain()), { ok: true })
  assert.deepEqual(checkChain(chain(null)), { ok: true }, 'lastDigest null: nothing verified yet')
  for (const [rule, mutate] of [
    ['chain.fields', value => { value.used = [] }], ['chain.fields', value => { delete value.locked }], ['chain.firstThumb', value => { value.firstThumb = null }],
    ['chain.currentThumb', value => { value.currentThumb = H('G') }], ['chain.lastDigest', value => { value.lastDigest = '' }], ['chain.locked', value => { value.locked = 1 }],
  ]) refusedWith(checkChain(mutated(chain, mutate)), rule)
})

test('6.5a: the answer, one accepted example per result and one mutation per rule; a refused code is an act-door code', async () => {
  for (const result of ['pending', 'committed', 'abandoned']) assert.deepEqual(await checkAnswer(answer(result)), { ok: true }, result)
  // Every act-door code, with the state members as ruling 9 places them (the two shape refusals of steps 1 and 2: all null).
  for (const code of ACT_DOOR_CODES) assert.deepEqual(await checkAnswer(NO_STATE_CODES.includes(code) ? noState(code) : answer('refused', code)), { ok: true }, code)
  assert.deepEqual(await checkAnswer(mutated(answer, value => { value.chain.lastDigest = null })), { ok: true })
  assert.deepEqual(await checkAnswer(encode(answer())), { ok: true }, 'the same verdict from the bytes')
  // `code` is null unless refused, and then one of the act-door codes: never another code of section 16, never null.
  for (const code of [null, 'CAPSULE_BYTES_MISMATCH', 'CAPSULE_INCOMPLETE', 'CAPSULE_OUTCOME_UNKNOWN', 'DESTINATION_BEHIND', 'SCHEMA', 'NOT_A_CODE', 7]) {
    refusedWith(await checkAnswer(answer('refused', code)), 'answer.code')
  }
  for (const result of ['pending', 'committed', 'abandoned']) refusedWith(await checkAnswer(answer(result, 'CAPSULE_GATE_DENIED')), 'answer.code')
  for (const [rule, mutate] of [
    ['answer.fields', value => { delete value.chain }], ['answer.fields', value => { value.signature = 'ab' }],
    ['answer.schema', value => { value.schema = 'aukora.act-answer.v2' }], ['answer.envelopeDigest', value => { value.envelopeDigest = H('E') }],
    ['answer.verified', value => { value.verified = 'true' }], ['answer.result', value => { value.result = 'done' }],
    ['row.seq', value => { value.row.seq = 0 }], ['answer.head.fields', value => { value.head = { seq: 1 } }], ['answer.head.seq', value => { value.head.seq = -1 }],
    ['answer.head.id', value => { value.head.id = null }], ['answer.holderGeneration', value => { value.holderGeneration = '1' }],
    ['answer.holderGeneration', value => { value.holderGeneration = -1 }],
    ['answer.holderKeyThumb', value => { value.holderKeyThumb = '' }], ['chain.locked', value => { value.chain.locked = null }],
  ]) refusedWith(await checkAnswer(mutated(answer, mutate)), rule)
  const canon = await checkAnswer(ascii(Buffer.from(encode(answer())).toString('latin1').replace('"verified":true', '"verified": true')))
  assert.deepEqual([canon.ok, canon.code, canon.rule, typeof canon.at], [false, 'SYNTAX', 'answer.canon', 'number'])
  assert.equal((await checkAnswer(answer('committed', Number.NaN))).rule, 'answer.canon', 'a host value the encoder refuses')
})

test('draft 7 ruling 9 (6.5a): when the four state members of an answer and a status are null', async () => {
  // All four null exactly with the two codes of steps 1 and 2 (no ledger, chain or holder state was read).
  for (const code of NO_STATE_CODES) {
    assert.deepEqual(await checkAnswer(noState(code)), { ok: true }, code)
    refusedWith(await checkAnswer(answer('refused', code)), 'answer.state')
    for (const member of ['head', 'holderGeneration', 'holderKeyThumb', 'chain']) {
      refusedWith(await checkAnswer(mutated(() => noState(code), value => { value[member] = answer()[member] })), 'answer.state')
    }
  }
  for (const member of ['head', 'holderGeneration']) {
    refusedWith(await checkAnswer(mutated(() => answer('refused', 'PROOF_INVALID'), value => { value[member] = null })), 'answer.state')
    refusedWith(await checkAnswer(mutated(() => noHolder(), value => { value[member] = null })), 'answer.state')
  }
  // A world with no holder: thumb and chain null, head and generation present, only refused CAPSULE_INSTANCE_REVOKED.
  assert.deepEqual(await checkAnswer(noHolder()), { ok: true })
  for (const code of ACT_DOOR_CODES.filter(code => code !== 'CAPSULE_INSTANCE_REVOKED')) refusedWith(await checkAnswer(noHolder(code)), 'answer.state')
  for (const result of ['pending', 'committed', 'abandoned']) {
    refusedWith(await checkAnswer(mutated(() => answer(result), value => { value.holderKeyThumb = null; value.chain = null })), 'answer.state')
  }
  // holderKeyThumb is null exactly when chain is null.
  refusedWith(await checkAnswer(mutated(answer, value => { value.holderKeyThumb = null })), 'answer.state')
  refusedWith(await checkAnswer(mutated(answer, value => { value.chain = null })), 'answer.state')
  refusedWith(await checkAnswer(mutated(() => answer('refused', 'CAPSULE_INSTANCE_REVOKED'), value => { value.chain = null })), 'answer.state')
  // The status: no holder is simply that world's status; otherwise all present.
  assert.deepEqual(checkStatus(mutated(status, value => { value.holderKeyThumb = null; value.chain = null; value.lease = { held: false, generation: 0 } })), { ok: true })
  refusedWith(checkStatus(mutated(status, value => { value.holderKeyThumb = null })), 'status.state')
  refusedWith(checkStatus(mutated(status, value => { value.chain = null })), 'status.state')
  // lease.generation is an integer from 0 whether or not a lease is held.
  assert.deepEqual(checkStatus(mutated(status, value => { value.lease = { held: false, generation: 7 } })), { ok: true })
  refusedWith(checkStatus(mutated(status, value => { value.lease = { held: false, generation: null } })), 'status.lease.generation')
})

test('draft 7 ruling 11 (6.5a): the row in an answer', async () => {
  // pending, committed, abandoned: the row is present and its state is the result.
  for (const result of ['pending', 'committed', 'abandoned']) {
    refusedWith(await checkAnswer(mutated(() => answer(result), value => { value.row = null })), 'answer.row')
    for (const other of ['pending', 'committed', 'abandoned'].filter(state => state !== result)) {
      refusedWith(await checkAnswer(mutated(() => answer(result), value => { value.row = ledgerRow(other) })), 'answer.row')
    }
  }
  // refused: null with the two codes of ruling 9; with any other code a row or null.
  for (const code of NO_STATE_CODES) refusedWith(await checkAnswer(mutated(() => noState(code), value => { value.row = ledgerRow() })), 'answer.row')
  for (const code of ACT_DOOR_CODES.filter(code => !NO_STATE_CODES.includes(code))) {
    for (const row of [null, ledgerRow(), ledgerRow('committed'), ledgerRow('abandoned')]) {
      const value = mutated(() => answer('refused', code), entry => { entry.row = row })
      assert.deepEqual(await checkAnswer(value), { ok: true }, `${code} with ${row?.state ?? 'no row'}`)
    }
  }
})

test('draft 7 rulings 10 and 12 (6.5a, 6.7, 6.8): what every row obeys; a commit verdict that is not ALLOW is never stored', async () => {
  // resolvedBy is null exactly when the state is pending.
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.resolvedBy = { keyThumb: THUMB1, holderGeneration: 1 } })), 'row.resolvedBy.state')
  for (const state of ['committed', 'abandoned']) refusedWith(await checkRow(mutated(() => ledgerRow(state), row => { row.resolvedBy = null })), 'row.resolvedBy.state')
  // gate.commit is present exactly when the state is committed.
  refusedWith(await checkRow(mutated(() => ledgerRow('committed'), row => { row.gate.commit = null })), 'row.gate.commit.state')
  for (const state of ['pending', 'abandoned']) {
    for (const decision of ['ALLOW', 'ESCALATE', 'DENY']) refusedWith(await checkRow(mutated(() => ledgerRow(state), row => { row.gate.commit = verdict(decision) })), 'row.gate.commit.state')
  }
  // Ruling 12: a stored commit verdict is ALLOW.
  for (const decision of ['ESCALATE', 'DENY']) refusedWith(await checkRow(mutated(() => ledgerRow('committed'), row => { row.gate.commit = verdict(decision) })), 'row.gate.commit.allow')
  // The creation verdict a row keeps is what 6.8 can leave on it: ALLOW or ESCALATE (no ruling closes it further; see the handoff).
  for (const decision of ['ALLOW', 'ESCALATE']) assert.deepEqual(await checkRow(mutated(ledgerRow, row => { row.gate.creation = verdict(decision) })), { ok: true }, decision)
  // seq and intentId are the command's; actionId is the digest of the command.
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.seq = 2 })), 'row.command')
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.intentId = 'f'.repeat(32) })), 'row.command')
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.command.seq = 2 })), 'row.command')
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.actionId = PLUS_ID })), 'row.actionId.digest')
  refusedWith(await checkRow(mutated(ledgerRow, row => { row.command.payloadHex = `${SAFE_PAYLOAD_HEX}00` })), 'row.actionId.digest')
  assert.deepEqual(await checkRow(mutated(ledgerRow, row => { row.command.payloadHex = `${SAFE_PAYLOAD_HEX}00`; row.actionId = PLUS_ID })), { ok: true })
  const second = { ...command(), seq: 2, prev: SAFE_ID }
  assert.deepEqual(await checkRow(mutated(ledgerRow, row => { row.command = second; row.seq = 2; row.actionId = independent('aukora.act.v1', encode(second)) })), { ok: true })
  // A row inside an answer and a row read is checked by the same rules.
  refusedWith(await checkAnswer(mutated(answer, value => { value.row.actionId = PLUS_ID })), 'row.actionId.digest')
  refusedWith(await checkRowRead(rowRead(mutated(ledgerRow, row => { row.resolvedBy = { keyThumb: THUMB1, holderGeneration: 1 } }))), 'row.resolvedBy.state')
})

test('6.5a: a read takes exactly one id for row and none for status or pending; the status; the row read', async () => {
  assert.deepEqual(checkRead(read('row', SAFE_ID, null)), { ok: true, verb: 'row' })
  assert.deepEqual(checkRead(read('row', null, '0123456789abcdef'.repeat(2))), { ok: true, verb: 'row' })
  for (const verb of ['status', 'pending']) assert.deepEqual(checkRead(read(verb, null, null)), { ok: true, verb })
  for (const [verb, actionId, intentId] of [
    ['row', SAFE_ID, '0123456789abcdef'.repeat(2)], ['row', null, null], ['status', SAFE_ID, null], ['status', null, '0123456789abcdef'.repeat(2)], ['pending', SAFE_ID, null],
  ]) refusedWith(checkRead(read(verb, actionId, intentId)), 'read.ids')
  for (const [rule, mutate] of [
    ['read.fields', value => { delete value.intentId }], ['read.fields', value => { value.envelope = null }], ['read.schema', value => { value.schema = 'aukora.act-read.v0' }],
    ['read.verb', value => { value.verb = 'head' }], ['read.actionId', value => { value.actionId = '0123456789abcdef'.repeat(2) }],
    ['read.intentId', value => { value.actionId = null; value.intentId = SAFE_ID }],
  ]) refusedWith(checkRead(mutated(read, mutate)), rule)
  assert.deepEqual(checkStatus(status()), { ok: true })
  assert.deepEqual(checkStatus(mutated(status, value => { value.pending = true; value.holderKeyThumb = null; value.chain = null; value.lease = { held: false, generation: 0 } })), { ok: true })
  for (const [rule, mutate] of [
    ['status.fields', value => { delete value.lineageId }], ['status.fields', value => { value.leaseId = 'bearer' }], ['status.schema', value => { value.schema = 'aukora.act-answer.v1' }],
    ['status.lineageId', value => { value.lineageId = null }], ['status.holderGeneration', value => { value.holderGeneration = '1' }],
    ['status.holderKeyThumb', value => { value.holderKeyThumb = KEY1.raw }], ['status.lease.fields', value => { value.lease.id = 'x' }],
    ['status.lease.held', value => { value.lease.held = null }], ['status.lease.generation', value => { value.lease.generation = null }],
    ['chain.fields', value => { value.chain = [] }], ['status.state', value => { value.chain = null }],
    ['status.head.seq', value => { value.head.seq = '0' }], ['status.pending', value => { value.pending = 0 }],
  ]) refusedWith(checkStatus(mutated(status, mutate)), rule)
  for (const row of [ledgerRow(), ledgerRow('committed'), null]) assert.deepEqual(await checkRowRead(rowRead(row)), { ok: true }, String(row?.state))
  for (const [rule, value] of [
    ['rowread.fields', { schema: 'aukora.act-row.v1' }], ['rowread.fields', { ...rowRead(), pending: true }], ['rowread.schema', { ...rowRead(), schema: 'aukora.act-read.v1' }],
    ['row.fields', rowRead('none')], ['row.state', rowRead(ledgerRow('refused'))],
  ]) refusedWith(await checkRowRead(value), rule)
})

test('every act-* shape row of the vectors file: its check gives the row\'s verdict; its digest recomputed with node:crypto', async () => {
  const checks = { verdict: checkVerdict, row: checkRow, chain: checkChain, answer: checkAnswer, read: checkRead, status: checkStatus, rowread: checkRowRead }
  const shaped = VECTORS.rows.filter(entry => entry.shape && entry.shape.check !== 'record')
  assert.ok(shaped.length >= 45, String(shaped.length))
  const seen = new Set()
  for (const entry of shaped) {
    assert.ok(entry.name.startsWith('act-'), entry.name)
    const bytes = fromHex(entry.inputHex)
    assert.equal(entry.expect.ok, true, `${entry.name}: the text is canonical; a shape refusal is SCHEMA, never a canon class`)
    assert.equal(entry.expect.digests['aukora.capsule.v1'], independent('aukora.capsule.v1', bytes), `${entry.name}: digest`)
    const { check, call, ok: expected, rule } = entry.shape
    const value = parse(bytes)
    const result = check === 'gateInputs' ? checkGateInputs(value, call) : check === 'request' ? await checkRequest(bytes) : await checks[check](check in { answer: 1, read: 1, status: 1, rowread: 1 } ? bytes : value)
    assert.equal(result.ok, expected, `${entry.name}: ${result.code} ${result.rule}`)
    if (!expected) {
      assert.equal(result.code, 'SCHEMA', entry.name)
      assert.equal(result.rule, rule, entry.name)
    }
    seen.add(`${check}:${expected}`)
  }
  for (const check of ['verdict', 'row', 'chain', 'answer', 'read', 'status', 'rowread', 'gateInputs']) {
    assert.ok(seen.has(`${check}:true`) && seen.has(`${check}:false`), `${check}: one accepted and one refused row`)
  }
  // The four the brief names, by name.
  assert.equal(row('act-answer-refused-code-outside-list').shape.rule, 'answer.code')
  assert.equal(row('act-read-row-both-ids').shape.rule, 'read.ids')
  assert.equal(row('act-request-commit-with-a-command').shape.rule, 'request.commandNull')
  assert.equal(parse(fromHex(row('act-status-null-last-digest').inputHex)).chain.lastDigest, null)
  assert.equal(row('act-status-null-last-digest').shape.ok, true)
  // The host values of this test and the file's texts are one world: the same bytes.
  assert.equal(row('act-gate-inputs-creation').inputHex, Buffer.from(encode(gateInputs())).toString('hex'))
  assert.equal(row('act-status-null-last-digest').inputHex, Buffer.from(encode(status())).toString('hex'))
  assert.equal(row('act-rowread-pending').inputHex, Buffer.from(encode(rowRead())).toString('hex'))
  // Draft 7: each ruling a row can show has an accepted and a refused row, by rule.
  const refusedRules = new Set(shaped.filter(entry => !entry.shape.ok).map(entry => entry.shape.rule))
  for (const rule of ['answer.state', 'status.state', 'answer.row', 'row.resolvedBy.state', 'row.gate.commit.state', 'row.actionId.digest', 'row.command',
    'row.gate.commit.allow', 'logicalTime.rows.call']) assert.ok(refusedRules.has(rule), `a refused row for ${rule}`)
  for (const name of ['act-answer-refused-lineage-mismatch-no-state', 'act-answer-refused-no-holder', 'act-status-no-holder', 'act-row-abandoned',
    'act-answer-pending-with-its-row', 'act-answer-refused-conflict-with-a-row', 'act-row-committed', 'act-gate-inputs-commit']) assert.equal(row(name).shape.ok, true, name)
})

test('the 6.5a shape table: frozen, every row named, and docs/capsule/SCHEMA.md holds the same rows', () => {
  assert.ok(Object.isFrozen(ACT_SHAPE_TABLE) && ACT_SHAPE_TABLE.every(entry => Object.isFrozen(entry)))
  const doc = readFileSync(new URL('../../../../docs/capsule/SCHEMA.md', import.meta.url), 'utf8')
  for (const entry of ACT_SHAPE_TABLE) assert.ok(doc.includes(`| ${entry.shape} | \`${entry.field}\` | ${entry.type} | \`${entry.rule}\` |`), `SCHEMA.md lacks ${entry.shape}.${entry.field}`)
  for (const shape of ['verdict', 'row', 'chain', 'answer', 'read', 'status', 'rowread', 'gate inputs']) assert.ok(ACT_SHAPE_TABLE.some(entry => entry.shape === shape), shape)
})
