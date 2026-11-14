// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The capsule record `aukora.capsule.v1` (CONTRACT.md draft 7, section 4, closed): a synthetic record that
 * passes complete; one mutation per schema rule, each refused with its class; the unsupported cases reported alone; the
 * five-value agreement rule recomputed; the null rule's three cases; a failed source; the five always-excluded rows (present
 * and excluded, they leave a record complete; they are constants); the closed lists (evidence scopes, authorityRequired
 * exactly the three, inventory id forms and the kind each form fixes); the record-* rows of the vectors file; tampering against a
 * new record (3.6: the raw bytes are hashed first); determinism; item bytes; the producer label; the schema table.
 * Every byte here is made and hashed by ../capsule-canon.mjs (the rule scan, capsule-rule.test.mjs).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import VECTORS from '../capsule-canon.vectors.json' with { type: 'json' }
import { DOMAINS, digest, encode, parse, rawSha256 } from '../capsule-canon.mjs'
import {
  AUTHORITY_CODES, CAPSULE_CODES, EVIDENCE_SCOPES, EXCLUDED_CONSTANTS, INVENTORY_KINDS, NULL_SOURCES, PRODUCER_LABEL, REASON_CODES, REQUIRED_EXCLUDED, SCHEMA_RULES, SCHEMA_TABLE, SOURCE_NAMES,
  STAGED_STATES, agreementOf, verifyRecord,
} from '../capsule-envelope.mjs'

const H = char => char.repeat(64)
const ascii = text => new Uint8Array(Buffer.from(text, 'latin1'))
const ITEM = ascii('abc')
/** Draft 7 ruling 5: the five always-excluded rows are constants, each with its own reason (written out here, not read from the module). */
const FIVE_REASONS = { ownerBinding: 'EXCLUDED_AUTHORITY', messages: 'EXCLUDED_PRIVATE', turnJournal: 'EXCLUDED_PRIVATE', providerBudget: 'EXCLUDED_HOST_SPECIFIC', headHistory: 'EXCLUDED_NOT_PORTABLE' }
const excluded = id => ({ id, kind: 'other', byteLength: null, digest: null, digestKind: null, disposition: 'excluded', reason: FIVE_REASONS[id] })

/** A record that passes every rule, complete; each call is a fresh copy. */
async function base() {
  return {
    schema: 'aukora.capsule.v1',
    state: {
      lineageId: H('1'),
      parentCapsuleId: null,
      heads: {
        local: { ballId: H('a'), ballIdForm: 'canonical', epoch: 176, parentBallId: H('b') },
        published: { ballId: H('a'), ballIdForm: 'canonical', epoch: 176 },
        staged: null,
        agreement: 'agree',
      },
      producer: { builder: 'host/capsule-record', builderVersion: 1, sourceRevision: 'c'.repeat(40), runtimeArtifactSha256: H('c'), claim: 'self-asserted' },
      inventory: [
        { id: 'file:docs/a.md', kind: 'file', byteLength: 3, digest: await rawSha256(ITEM), digestKind: 'sha256-raw', disposition: 'included', reason: null },
        { id: 'file:vault/provider', kind: 'other', byteLength: null, digest: null, digestKind: null, disposition: 'excluded', reason: 'EXCLUDED_SECRET' },
        excluded('headHistory'),
        excluded('messages'),
        { id: 'organ:seed-judge', kind: 'organ-entry', byteLength: null, digest: `ball:${H('d')}`, digestKind: 'native-id', disposition: 'included', reason: null },
        excluded('ownerBinding'),
        excluded('providerBudget'),
        excluded('turnJournal'),
      ],
      roots: {
        receipts: { count: 118, lastLeafHash: H('e'), checkpointSeq: 9 },
        memory: null,
        suite: { digest: H('f'), cases: 12 },
        baseline: { digest: H('0') },
        policy: null,
      },
      pending: [
        { actionId: H('2'), intentId: '3'.repeat(32), seq: 4, state: 'intent' },
        { actionId: H('4'), intentId: '5'.repeat(32), seq: 5, state: 'sent' },
      ],
      evidence: {
        retention: [],
        receipts: [{ ref: 'receipt:118', issuer: 'head', scope: 'nostr-receipts-head', status: 'verified', digest: H('6') }],
        checkpoints: [{ ref: 'checkpoint:9', issuer: 'head', scope: 'checkpoint', status: 'unverified', digest: null }],
      },
      compatibility: { readerMin: 1, canon: 'aukora.canon.v1', unsupported: [] },
      authorityRequired: ['OWNER_APPROVED_MOVE', 'OWNER_SESSION', 'WRITER_LEASE'],
      extensions: {},
    },
    observation: {
      capturedAtMs: 1794441600075,
      attempt: 1,
      sources: [
        { name: 'head.staged', ok: true, code: null, observedAtMs: 1794441600070 },
        { name: 'lineage', ok: true, code: null, observedAtMs: 1794441600071 },
        { name: 'memory', ok: true, code: null, observedAtMs: 1794441600072 },
        { name: 'policy', ok: true, code: null, observedAtMs: 1794441600073 },
      ],
    },
  }
}

/** A problem's rule name: the words before its first colon. */
const ruleName = problem => (problem.rule ?? '').split(':')[0]
const listed = problems => problems.map(problem => `${problem.code} ${problem.path} ${problem.rule ?? ''}`).join('; ')
const codesOf = result => result.problems.map(problem => problem.code)
async function verdict(mutate, options) {
  const body = await base()
  mutate(body)
  return verifyRecord(encode(body), options)
}

test('the synthetic record passes, complete, with its id and state root recomputed and the producer label', async () => {
  const body = await base()
  const bytes = encode(body)
  const result = await verifyRecord(bytes)
  assert.deepEqual(result.problems, [])
  assert.deepEqual(Object.keys(result), ['ok', 'complete', 'id', 'stateRoot', 'problems', 'labels'])
  assert.equal(result.ok, true)
  assert.equal(result.complete, true)
  assert.equal(result.id, await digest(DOMAINS.capsule, bytes))
  assert.equal(result.stateRoot, await digest(DOMAINS.state, encode(body.state)))
  assert.notEqual(result.id, result.stateRoot)
  assert.deepEqual(result.labels, [PRODUCER_LABEL])
  assert.equal((await verifyRecord(bytes, { expectId: result.id })).complete, true)
})

/** One mutation per rule: [name, mutate, the code it must produce]. */
const MUTATIONS = [
  // closed objects
  ['a missing state field', body => { delete body.state.roots }, 'SCHEMA'],
  ['a missing body field', body => { delete body.observation }, 'SCHEMA'],
  ['an unknown state field', body => { body.state.note = 'x' }, 'SCHEMA'],
  ['an unknown body field (no wrapper, no signature inside)', body => { body.signature = H('9') }, 'SCHEMA'],
  ['an unknown head field', body => { body.state.heads.local.live = true }, 'SCHEMA'],
  ['an unknown inventory field', body => { body.state.inventory[0].path = '/srv/x' }, 'SCHEMA'],
  // the schema name, the reader, the canon, extensions (reported alone)
  ['another schema name', body => { body.schema = 'aukora.capsule.v2' }, 'CAPSULE_SCHEMA_UNSUPPORTED'],
  ['a schema that is not a string', body => { body.schema = 1 }, 'SCHEMA'],
  ['readerMin above 1', body => { body.state.compatibility.readerMin = 2 }, 'CAPSULE_SCHEMA_UNSUPPORTED'],
  ['readerMin below 1', body => { body.state.compatibility.readerMin = 0 }, 'SCHEMA'],
  ['another canon', body => { body.state.compatibility.canon = 'aukora.canon.v2' }, 'CAPSULE_SCHEMA_UNSUPPORTED'],
  ['a non-empty extensions', body => { body.state.extensions = { x: 1 } }, 'CAPSULE_SCHEMA_UNSUPPORTED'],
  ['extensions not an object', body => { body.state.extensions = [] }, 'SCHEMA'],
  // types and formats
  ['lineageId in upper case', body => { body.state.lineageId = H('A') }, 'SCHEMA'],
  ['parentCapsuleId too short', body => { body.state.parentCapsuleId = H('1').slice(1) }, 'SCHEMA'],
  ['a ball id that is not hex64', body => { body.state.heads.local.ballId = 'ball-176' }, 'SCHEMA'],
  ['a ballIdForm outside its list', body => { body.state.heads.local.ballIdForm = 'other' }, 'SCHEMA'],
  ['a negative epoch', body => { body.state.heads.published.epoch = -1 }, 'SCHEMA'],
  ['an epoch that is a string', body => { body.state.heads.local.epoch = '176' }, 'SCHEMA'],
  ['an agreement outside its list', body => { body.state.heads.agreement = 'live' }, 'SCHEMA'],
  ['a staged head without its state', body => { body.state.heads.staged = { ballId: H('a'), ballIdForm: 'canonical', epoch: 177 } }, 'SCHEMA'],
  ['a staged state outside the closed list', body => { body.state.heads.staged = { ballId: H('a'), ballIdForm: 'canonical', epoch: 177, state: 'pending' } }, 'SCHEMA'],
  ['another builder', body => { body.state.producer.builder = 'organ/capsule-inspect' }, 'SCHEMA'],
  ['another builder version', body => { body.state.producer.builderVersion = 2 }, 'SCHEMA'],
  ['a claim other than self-asserted', body => { body.state.producer.claim = 'host-built' }, 'SCHEMA'],
  ['a source revision that is not 40 hex', body => { body.state.producer.sourceRevision = H('c') }, 'SCHEMA'],
  ['a runtime artifact digest that is not hex64', body => { body.state.producer.runtimeArtifactSha256 = 'c'.repeat(63) }, 'SCHEMA'],
  ['an inventory kind outside its list', body => { body.state.inventory[0].kind = 'secret' }, 'SCHEMA'],
  ['a disposition outside its list', body => { body.state.inventory[0].disposition = 'partial' }, 'SCHEMA'],
  ['a reason outside the closed list', body => { body.state.inventory[1].reason = 'EXCLUDED_BECAUSE' }, 'SCHEMA'],
  ['a negative byteLength', body => { body.state.inventory[0].byteLength = -1 }, 'SCHEMA'],
  ['a digestKind outside its list', body => { body.state.inventory[0].digestKind = 'sha1' }, 'SCHEMA'],
  ['a lastLeafHash that is null (not nullable)', body => { body.state.roots.receipts.lastLeafHash = null }, 'SCHEMA'],
  ['a receipts count that is a boolean', body => { body.state.roots.receipts.count = true }, 'SCHEMA'],
  ['a policy version that is a string (an integer from 0)', body => { body.state.roots.policy = { version: 'aukora.capsule-policy.v0', digest: H('7') } }, 'SCHEMA'],
  ['a negative policy version', body => { body.state.roots.policy = { version: -1, digest: H('7') } }, 'SCHEMA'],
  ['an intentId of 64 hex digits', body => { body.state.pending[0].intentId = H('3') }, 'SCHEMA'],
  ['a pending seq of 0', body => { body.state.pending[0].seq = 0 }, 'SCHEMA'],
  ['a pending state outside its list', body => { body.state.pending[0].state = 'committed' }, 'SCHEMA'],
  ['an evidence status outside its list', body => { body.state.evidence.receipts[0].status = 'trusted' }, 'SCHEMA'],
  ['an evidence ref of 129 characters', body => { body.state.evidence.receipts[0].ref = 'r'.repeat(129) }, 'SCHEMA'],
  ['an empty id', body => { body.state.evidence.receipts[0].issuer = '' }, 'SCHEMA'],
  ['a code in lower case', body => { body.state.authorityRequired = ['owner_session'] }, 'SCHEMA'],
  ['a code of 129 characters', body => { body.state.compatibility.unsupported = [`A${'B'.repeat(128)}`] }, 'SCHEMA'],
  ['authorityRequired not an array', body => { body.state.authorityRequired = 'OWNER_SESSION' }, 'SCHEMA'],
  ['an authorityRequired code outside its closed list of three', body => { body.state.authorityRequired = ['CAPSULE_AUTHORITY_REQUIRED'] }, 'SCHEMA'],
  ['an authorityRequired code that is a grant, not a need', body => { body.state.authorityRequired = ['OWNER_APPROVED'] }, 'SCHEMA'],
  ['an evidence scope outside the closed list', body => { body.state.evidence.receipts[0].scope = 'epoch-176' }, 'SCHEMA'],
  ['a receipt row carrying the checkpoint scope', body => { body.state.evidence.receipts[0].scope = 'checkpoint' }, 'SCHEMA'],
  ['a checkpoint row carrying the retention scope', body => { body.state.evidence.checkpoints[0].scope = 'behavioral-retention-only' }, 'SCHEMA'],
  ['a retention row carrying the receipts scope', body => { body.state.evidence.retention = [{ ref: 'r1', issuer: 'host', scope: 'nostr-receipts-head', status: 'verified', digest: null }] }, 'SCHEMA'],
  ['an inventory id with no fixed form', body => { body.state.inventory[1].id = 'vault:provider'; body.state.inventory.sort((a, b) => (a.id < b.id ? -1 : 1)) }, 'SCHEMA'],
  ['a module id that is not module:<sha256>', body => { body.state.inventory[0].id = 'module:abc' }, 'SCHEMA'],
  ['an organ id with nothing after organ:', body => { body.state.inventory[4].id = 'organ:' }, 'SCHEMA'],
  ['a file id with nothing after file:', body => { body.state.inventory[0].id = 'file:' }, 'SCHEMA'],
  ['a fixed name in another case', body => { body.state.inventory[3].id = 'Messages'; body.state.inventory.sort((a, b) => (a.id < b.id ? -1 : 1)) }, 'SCHEMA'],
  ['an attempt of 4', body => { body.observation.attempt = 4 }, 'SCHEMA'],
  ['an attempt of 0', body => { body.observation.attempt = 0 }, 'SCHEMA'],
  ['a negative capture time', body => { body.observation.capturedAtMs = -1 }, 'SCHEMA'],
  ['a source ok that is not a boolean', body => { body.observation.sources[0].ok = 1 }, 'SCHEMA'],
  ['a source name outside the closed list of section 5', body => { body.observation.sources.push({ name: 'roots.memory', ok: true, code: null, observedAtMs: 1 }) }, 'SCHEMA'],
  // ordering rules
  ['inventory not sorted by id', body => { body.state.inventory.reverse() }, 'SCHEMA'],
  ['an inventory id twice', body => { body.state.inventory[3].id = body.state.inventory[2].id }, 'SCHEMA'],
  ['pending not sorted by seq', body => { body.state.pending.reverse() }, 'SCHEMA'],
  ['a pending seq twice', body => { body.state.pending[1].seq = 4 }, 'SCHEMA'],
  ['evidence not sorted by ref', body => { body.state.evidence.receipts.push({ ...body.state.evidence.receipts[0], ref: 'a' }) }, 'SCHEMA'],
  ['sources not sorted by name', body => { body.observation.sources.reverse() }, 'SCHEMA'],
  ['codes not sorted', body => { body.state.compatibility.unsupported = ['Z_CODE', 'A_CODE'] }, 'SCHEMA'],
  ['a code twice', body => { body.state.authorityRequired = ['OWNER_SESSION', 'OWNER_SESSION'] }, 'SCHEMA'],
  ['authorityRequired not sorted', body => { body.state.authorityRequired = ['WRITER_LEASE', 'OWNER_SESSION'] }, 'SCHEMA'],
  // the list bounds
  ['inventory above 2,048 items', body => {
    body.state.inventory = Array.from({ length: 2049 }, (_, index) => ({ id: `file:i${String(index).padStart(4, '0')}`, kind: 'file', byteLength: null, digest: null, digestKind: null, disposition: 'included', reason: null }))
  }, 'SCHEMA'],
  ['pending above 1,024 rows', body => {
    body.state.pending = Array.from({ length: 1025 }, (_, index) => ({ actionId: H('2'), intentId: '3'.repeat(32), seq: index + 1, state: 'sent' }))
  }, 'SCHEMA'],
  ['an evidence list above 1,024 rows', body => {
    body.state.evidence.retention = Array.from({ length: 1025 }, (_, index) => ({ ref: `r${String(index).padStart(4, '0')}`, issuer: 'head', scope: 'behavioral-retention-only', status: 'failed', digest: null }))
  }, 'SCHEMA'],
  ['a code list above 64', body => { body.state.compatibility.unsupported = Array.from({ length: 65 }, (_, index) => `C${String(index).padStart(3, '0')}`) }, 'SCHEMA'],
  // cross-field rules
  ['"agree" stored while the published epoch differs', body => { body.state.heads.published.epoch = 175 }, 'SCHEMA'],
  ['"agree" stored across a legacy and a canonical id', body => { body.state.heads.published.ballIdForm = 'legacy' }, 'SCHEMA'],
  ['"agree" stored with no published head', body => { body.state.heads.published = null; body.observation.sources.unshift({ name: 'head.published', ok: true, code: null, observedAtMs: 1 }) }, 'SCHEMA'],
  ['"diverged" stored while the heads agree', body => { body.state.heads.agreement = 'diverged' }, 'SCHEMA'],
  ['a digest with no digestKind', body => { body.state.inventory[0].digestKind = null }, 'SCHEMA'],
  ['a sha256-raw digest that is not hex64', body => { body.state.inventory[4].digestKind = 'sha256-raw' }, 'SCHEMA'],
  ['included with a reason', body => { body.state.inventory[0].reason = 'EXCLUDED_SECRET' }, 'SCHEMA'],
  ['excluded with an UNKNOWN_ reason', body => { body.state.inventory[1].reason = 'UNKNOWN_NO_SOURCE' }, 'SCHEMA'],
  ['excluded with no reason', body => { body.state.inventory[1].reason = null }, 'SCHEMA'],
  ['a failed source with no code', body => { body.state.roots.memory = { root: H('8'), nodes: 1 }; body.observation.sources[2] = { ...body.observation.sources[2], ok: false } }, 'SCHEMA'],
  ['a good source with a code', body => { body.observation.sources[0].code = 'UNKNOWN_SOURCE_FAILED' }, 'SCHEMA'],
  ['a null with no row for its source', body => { body.observation.sources = body.observation.sources.filter(row => row.name !== 'memory') }, 'SCHEMA'],
  ['a null lineage with no lineage row', body => { body.state.lineageId = null; body.observation.sources = body.observation.sources.filter(row => row.name !== 'lineage'); body.state.parentCapsuleId = H('9') }, 'SCHEMA'],
]

test('one mutation per schema rule, each refused with its class, and nothing else', async () => {
  for (const [name, mutate, code] of MUTATIONS) {
    const result = await verdict(mutate)
    assert.equal(result.ok, false, name)
    assert.ok(codesOf(result).includes(code), `${name}: ${listed(result.problems)}`)
    assert.ok(result.problems.every(problem => problem.code === code), `${name}: only ${code} (${listed(result.problems)})`)
  }
})

test('CAPSULE_SCHEMA_UNSUPPORTED is reported alone, without field checks, and with ok false', async () => {
  const all = await verdict(body => {
    body.schema = 'aukora.capsule.v9'
    body.state.compatibility.readerMin = 3
    body.state.compatibility.canon = 'other'
    body.state.extensions = { x: 1 }
    body.observation.attempt = 99 // a field error that is NOT reported
    delete body.state.roots // and another
  })
  assert.equal(all.ok, false)
  assert.deepEqual(codesOf(all), Array.from({ length: 4 }, () => 'CAPSULE_SCHEMA_UNSUPPORTED'))
  assert.deepEqual(all.labels, [], 'another schema name is not a v1 record')
  const reader = await verdict(body => { body.state.compatibility.readerMin = 2; body.state.inventory = 'not a list' })
  assert.deepEqual(reader.problems.map(problem => [problem.code, problem.path]), [['CAPSULE_SCHEMA_UNSUPPORTED', 'state.compatibility.readerMin']])
  assert.deepEqual(reader.labels, [PRODUCER_LABEL])
})

test('agreement: the five-value rule, recomputed from local and published; the staged head does not enter it', () => {
  const head = (ballId, epoch, ballIdForm = 'canonical') => ({ ballId: H(ballId), ballIdForm, epoch })
  assert.equal(agreementOf(head('a', 5), null), 'unknown')
  assert.equal(agreementOf(head('a', 5), head('a', 5, 'legacy')), 'unknown')
  assert.equal(agreementOf(head('a', 5), head('a', 5)), 'agree')
  assert.equal(agreementOf(head('a', 6), head('b', 5)), 'local-ahead')
  assert.equal(agreementOf(head('a', 5), head('b', 6)), 'published-ahead')
  assert.equal(agreementOf(head('a', 5), head('b', 5)), 'diverged')
  assert.equal(agreementOf(head('a', 5), head('a', 6)), 'diverged')
})

test('three heads are kept apart: each stored agreement passes only when it is the recomputed one', async () => {
  const cases = [
    ['local-ahead', { ballId: H('a'), ballIdForm: 'canonical', epoch: 177, parentBallId: H('b') }, { ballId: H('b'), ballIdForm: 'canonical', epoch: 176 }],
    ['published-ahead', { ballId: H('a'), ballIdForm: 'canonical', epoch: 175, parentBallId: H('b') }, { ballId: H('b'), ballIdForm: 'canonical', epoch: 176 }],
    ['diverged', { ballId: H('a'), ballIdForm: 'canonical', epoch: 176, parentBallId: H('b') }, { ballId: H('b'), ballIdForm: 'canonical', epoch: 176 }],
    ['unknown', { ballId: H('a'), ballIdForm: 'canonical', epoch: 177, parentBallId: H('b') }, { ballId: H('b'), ballIdForm: 'legacy', epoch: 176 }],
  ]
  for (const [agreement, local, published] of cases) {
    const body = await base()
    Object.assign(body.state.heads, { local, published, agreement, staged: { ballId: H('c'), ballIdForm: 'canonical', epoch: 178, state: 'awaiting_owner' } })
    const result = await verifyRecord(encode(body))
    assert.equal(result.complete, true, `${agreement}: ${listed(result.problems)}`)
    const heads = parse(encode(body)).state.heads
    assert.deepEqual([heads.local.epoch, heads.published.epoch, heads.staged.epoch], [local.epoch, published.epoch, 178])
    for (const other of ['agree', 'local-ahead', 'published-ahead', 'diverged', 'unknown'].filter(value => value !== agreement)) {
      body.state.heads.agreement = other
      assert.deepEqual(codesOf(await verifyRecord(encode(body))), ['SCHEMA'], `${agreement} stored as ${other}`)
    }
  }
  for (const state of STAGED_STATES) {
    const body = await base()
    body.state.heads.staged = { ballId: H('c'), ballIdForm: 'canonical', epoch: 177, state }
    assert.equal((await verifyRecord(encode(body))).complete, true, state)
  }
})

test('the closed lists of section 4 (draft 7 rulings 2, 4, 6): evidence scopes, authorityRequired exactly the three, inventory id forms', async () => {
  assert.deepEqual({ ...EVIDENCE_SCOPES }, { retention: 'behavioral-retention-only', receipts: 'nostr-receipts-head', checkpoints: 'checkpoint' })
  assert.deepEqual([...AUTHORITY_CODES], ['OWNER_APPROVED_MOVE', 'OWNER_SESSION', 'WRITER_LEASE'])
  assert.ok(Object.isFrozen(EVIDENCE_SCOPES) && Object.isFrozen(AUTHORITY_CODES))
  for (const code of AUTHORITY_CODES) assert.ok(!CAPSULE_CODES.includes(code), `${code} is closed in section 4, not in section 16`)
  // Draft 7 ruling 6: a v1 record carries all three, always; any other list is SCHEMA (rule authority-required).
  for (const list of [[], ['OWNER_SESSION'], ['OWNER_APPROVED_MOVE', 'WRITER_LEASE'], ['OWNER_APPROVED_MOVE', 'OWNER_SESSION']]) {
    const result = await verdict(body => { body.state.authorityRequired = list })
    assert.deepEqual(result.problems.map(problem => [problem.code, problem.path, ruleName(problem)]), [['SCHEMA', 'state.authorityRequired', 'authority-required']], list.join())
  }
  const retention = await verdict(body => { body.state.evidence.retention = [{ ref: 'admission:1', issuer: 'host', scope: 'behavioral-retention-only', status: 'verified', digest: H('9') }] })
  assert.equal(retention.complete, true)
  // One id of each fixed form (organ:, module:<sha256>, file:, and the five names) in one complete record.
  const inventory = await verdict(body => {
    body.state.inventory.push({ id: `module:${H('d')}`, kind: 'module', byteLength: 10, digest: H('d'), digestKind: 'sha256-raw', disposition: 'included', reason: null })
    body.state.inventory.sort((a, b) => (a.id < b.id ? -1 : 1))
  })
  assert.equal(inventory.complete, true, listed(inventory.problems))
  assert.deepEqual(parse(encode((await base()))).state.inventory.map(item => item.id.split(':')[0]), ['file', 'file', 'headHistory', 'messages', 'organ', 'ownerBinding', 'providerBudget', 'turnJournal'])
})

test('the null rule: a source row ok true is complete, ok false is CAPSULE_INCOMPLETE, no row is SCHEMA', async () => {
  const read = await verdict(() => {})
  assert.equal(read.complete, true, 'staged, memory, policy and parent are null with ok:true rows')
  const failed = await verdict(body => { body.observation.sources[2] = { name: 'memory', ok: false, code: 'UNKNOWN_SOURCE_FAILED', observedAtMs: 3 } })
  assert.deepEqual(failed.problems.map(problem => [problem.code, problem.path]), [['CAPSULE_INCOMPLETE', 'observation.sources[2]'], ['CAPSULE_INCOMPLETE', 'state.roots.memory']])
  assert.equal(failed.ok, true)
  assert.equal(failed.complete, false)
  const none = await verdict(body => { body.observation.sources = body.observation.sources.filter(row => row.name !== 'memory') })
  assert.deepEqual(none.problems.map(problem => [problem.code, problem.path]), [['SCHEMA', 'state.roots.memory']])
  assert.equal(none.ok, false)
  // One row explains every null of its source (producer: both fields).
  const producer = await verdict(body => {
    body.state.producer.sourceRevision = null
    body.state.producer.runtimeArtifactSha256 = null
    body.observation.sources.push({ name: 'producer', ok: false, code: 'UNKNOWN_NO_SOURCE', observedAtMs: 4 })
  })
  assert.deepEqual(producer.problems.map(problem => problem.path), ['observation.sources[4]', 'state.producer.sourceRevision', 'state.producer.runtimeArtifactSha256'])
  assert.deepEqual(codesOf(producer), ['CAPSULE_INCOMPLETE', 'CAPSULE_INCOMPLETE', 'CAPSULE_INCOMPLETE'])
  // Draft 6: "no failed source". A failed source that explains no null still leaves the record incomplete (ok true).
  const unexplained = await verdict(body => { body.observation.sources.unshift({ name: 'files', ok: false, code: 'UNKNOWN_SOURCE_FAILED', observedAtMs: 1 }) })
  assert.deepEqual(unexplained.problems.map(problem => [problem.code, problem.path, problem.rule]), [['CAPSULE_INCOMPLETE', 'observation.sources[0]', 'failed-source: source "files" failed (UNKNOWN_SOURCE_FAILED)']])
  assert.deepEqual([unexplained.ok, unexplained.complete], [true, false])
  // A good source that explains no null changes nothing.
  assert.equal((await verdict(body => { body.observation.sources.unshift({ name: 'files', ok: true, code: null, observedAtMs: 1 }) })).complete, true)
  assert.equal(Object.keys(NULL_SOURCES).length, 12)
  for (const source of Object.values(NULL_SOURCES)) assert.ok(SOURCE_NAMES.includes(source), source)
  assert.equal(SOURCE_NAMES.length, 18)
  assert.equal(REASON_CODES.length, 9)
  assert.equal(CAPSULE_CODES.length, 26)
})

test('CAPSULE_CODES is exactly the closed table of section 16 of the contract on this branch, in its order', () => {
  const contract = readFileSync(new URL('../../../../docs/capsule/CONTRACT.md', import.meta.url), 'utf8')
  const section = contract.slice(contract.indexOf('\n## 16.'))
  assert.ok(section.length > 8, 'the contract has a section 16')
  const table = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)].map(match => match[1])
  assert.ok(table.includes('PROOF_SUPERSEDED') && table.includes('CAPSULE_GENERATION_STALE'), 'the contract is draft 4 or later')
  assert.deepEqual([...CAPSULE_CODES], table)
})

test('CAPSULE_INCOMPLETE is reported, not a failure: an unknown row, and the five always-excluded rows', async () => {
  const unknown = await verdict(body => {
    body.state.inventory.push({ id: 'file:logs/not-captured', kind: 'log', byteLength: null, digest: null, digestKind: null, disposition: 'unknown', reason: 'UNKNOWN_NOT_CAPTURED' })
    body.state.inventory.sort((a, b) => (a.id < b.id ? -1 : 1))
  })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.complete, false)
  assert.deepEqual(codesOf(unknown), ['CAPSULE_INCOMPLETE'])
  assert.deepEqual([...REQUIRED_EXCLUDED], ['ownerBinding', 'messages', 'turnJournal', 'providerBudget', 'headHistory'])
  // Draft 6: the five always-excluded rows, present and excluded, do not make a record incomplete (the base record has
  // them and is complete), and every other excluded row leaves it complete too.
  const base5 = await verdict(() => {})
  assert.equal(base5.complete, true)
  assert.equal((await base()).state.inventory.filter(item => item.disposition === 'excluded').length, 6)
  for (const name of REQUIRED_EXCLUDED) {
    const missing = await verdict(body => { body.state.inventory = body.state.inventory.filter(item => item.id !== name) })
    assert.deepEqual(missing.problems.map(problem => [problem.code, problem.rule]), [['CAPSULE_INCOMPLETE', `required-excluded: no row ${name}`]], name)
    assert.equal(missing.ok, true, name)
    // Draft 7 ruling 5: present but not the constant is SCHEMA (was CAPSULE_INCOMPLETE in draft 6).
    const included = await verdict(body => { Object.assign(body.state.inventory.find(item => item.id === name), { disposition: 'included', reason: null }) })
    assert.deepEqual(included.problems.map(problem => [problem.code, ruleName(problem)]), [['SCHEMA', 'excluded-constant']], `${name} included`)
  }
  // Completeness is judged only on a body that passed the field check: a schema problem is reported alone, ok false.
  const both = await verdict(body => { body.state.inventory = body.state.inventory.slice(0, 1); body.observation.attempt = 9 })
  assert.equal(both.ok, false)
  assert.deepEqual(codesOf(both), ['SCHEMA'])
})

test('draft 7 ruling 4: inventory ids by form, the 1-to-128 rule after the prefix, and the kind each form fixes', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(INVENTORY_KINDS).map(([form, kinds]) => [form, [...kinds]])), { 'organ:': ['organ-entry'], 'module:': ['module'], 'file:': ['file', 'log', 'root', 'other'] })
  const item = (id, kind) => ({ id, kind, byteLength: null, digest: null, digestKind: null, disposition: 'included', reason: null })
  const withItems = items => verdict(body => { body.state.inventory.push(...items); body.state.inventory.sort((a, b) => (a.id < b.id ? -1 : 1)) })
  // At the bound after the prefix: 128 characters after `organ:` and after `file:` (134 and 133 in all) are accepted.
  const atBound = await withItems([item(`organ:${'o'.repeat(128)}`, 'organ-entry'), item(`file:${'f'.repeat(128)}`, 'root'), item(`module:${H('d')}`, 'module')])
  assert.equal(atBound.complete, true, listed(atBound.problems))
  for (const kind of ['file', 'log', 'root', 'other']) assert.equal((await withItems([item(`file:k/${kind}`, kind)])).complete, true, kind)
  // One past it, an empty part, a module id that is not hex64, no fixed form: SCHEMA by the field rule inventory-id.
  for (const id of [`organ:${'o'.repeat(129)}`, `file:${'f'.repeat(129)}`, 'organ:', 'file:', `module:${H('D')}`, `module:${H('d')}0`, 'vault:x', 'messages:x', 'ORGAN:x']) {
    const result = await withItems([item(id, 'other')])
    assert.deepEqual(result.problems.map(problem => [problem.code, ruleName(problem)]), [['SCHEMA', 'inventory-id']], id)
  }
  // The form fixes the kind: anything else is SCHEMA by the cross-field rule inventory-kind.
  for (const [id, kind] of [
    ['organ:a', 'module'], ['organ:a', 'file'], ['organ:a', 'other'], [`module:${H('d')}`, 'organ-entry'], [`module:${H('d')}`, 'file'],
    ['file:a', 'organ-entry'], ['file:a', 'module'],
  ]) {
    const result = await withItems([item(id, kind)])
    assert.deepEqual(result.problems.map(problem => [problem.code, ruleName(problem)]), [['SCHEMA', 'inventory-kind']], `${id} as ${kind}`)
    assert.match(result.problems[0].path, /^state\.inventory\[\d+\]\.kind$/, `${id} as ${kind}`)
  }
})

test('draft 7 ruling 5: the five always-excluded rows are constants; any other value is SCHEMA, a missing one CAPSULE_INCOMPLETE', async () => {
  assert.deepEqual({ ...EXCLUDED_CONSTANTS }, FIVE_REASONS)
  assert.ok(Object.isFrozen(EXCLUDED_CONSTANTS))
  for (const name of REQUIRED_EXCLUDED) {
    for (const [field, value] of [['kind', 'file'], ['byteLength', 0], ['digest', H('1')], ['digestKind', 'native-id'], ['disposition', 'included'], ['reason', 'EXCLUDED_SECRET']]) {
      const result = await verdict(body => {
        const row = body.state.inventory.find(entry => entry.id === name)
        row[field] = value
        // Keep the pairs of the other rules whole, so only the constant rule speaks.
        if (field === 'digest') row.digestKind = 'native-id'
        if (field === 'digestKind') row.digest = 'ball:x'
        if (field === 'disposition') row.reason = null
      })
      assert.deepEqual(result.problems.map(problem => [problem.code, ruleName(problem)]), [['SCHEMA', 'excluded-constant']], `${name}.${field}`)
    }
    // Every other EXCLUDED_ reason than its own.
    for (const reason of REASON_CODES.filter(code => code.startsWith('EXCLUDED_') && code !== FIVE_REASONS[name])) {
      const result = await verdict(body => { body.state.inventory.find(entry => entry.id === name).reason = reason })
      assert.deepEqual(result.problems.map(problem => [problem.code, ruleName(problem)]), [['SCHEMA', 'excluded-constant']], `${name} ${reason}`)
    }
  }
  // An ordinary excluded file row may carry any EXCLUDED_ reason (the constants bind only the five names).
  assert.equal((await verdict(body => { body.state.inventory[1].reason = 'EXCLUDED_PRIVATE' })).complete, true)
})

test('the record-* rows of the vectors file (draft 7 rulings 4, 5, 6): the verifier gives each row its verdict', async () => {
  const records = VECTORS.rows.filter(entry => entry.shape?.check === 'record')
  assert.deepEqual(records.map(entry => entry.name).sort(), [
    'record-authority-required-two-codes', 'record-complete', 'record-excluded-row-another-reason', 'record-excluded-row-missing',
    'record-inventory-id-forms', 'record-inventory-module-id-with-organ-kind', 'record-inventory-organ-id-129-after-prefix',
  ])
  for (const entry of records) {
    assert.ok(entry.name.startsWith('record-'), entry.name)
    assert.equal(entry.expect.ok, true, `${entry.name}: a canonical text; the record verdict is the shape`)
    const result = await verifyRecord(ascii(Buffer.from(entry.inputHex, 'hex').toString('latin1')))
    assert.equal(result.ok, entry.shape.ok, `${entry.name}: ${listed(result.problems)}`)
    assert.equal(result.complete, entry.shape.complete, `${entry.name}: ${listed(result.problems)}`)
    assert.equal(result.id, entry.expect.digests['aukora.capsule.v1'], entry.name)
    if (entry.shape.complete) assert.deepEqual(result.problems, [], entry.name)
    else {
      assert.ok(result.problems.length > 0, entry.name)
      for (const problem of result.problems) assert.deepEqual([problem.code, ruleName(problem)], [entry.shape.code, entry.shape.rule], `${entry.name}: ${listed(result.problems)}`)
    }
  }
  const byRule = new Map(records.map(entry => [entry.shape.rule ?? 'complete', entry.name]))
  for (const rule of ['complete', 'inventory-id', 'inventory-kind', 'excluded-constant', 'required-excluded', 'authority-required']) assert.ok(byRule.has(rule), rule)
})

test('tampering against a new record (3.6): the raw bytes are hashed first; a mismatch is reported alone and never parsed', async () => {
  const bytes = encode(await base())
  const id = await digest(DOMAINS.capsule, bytes)
  const text = Buffer.from(bytes).toString('latin1')
  const changed = ascii(text.replace('"capturedAtMs":1794441600075', '"capturedAtMs":1794441600076'))
  assert.equal(changed.length, bytes.length)
  const underOriginal = await verifyRecord(changed, { expectId: id })
  assert.deepEqual(codesOf(underOriginal), ['CAPSULE_BYTES_MISMATCH'])
  assert.equal(underOriginal.ok, false)
  const alone = await verifyRecord(changed)
  assert.equal(alone.complete, true, 'a new record is not a failed verification')
  assert.notEqual(alone.id, id)
  assert.equal((await verifyRecord(changed, { expectId: alone.id })).complete, true)
  for (const broken of [bytes.slice(0, -1), ascii(text.replace('"attempt":1', '"attempt": 1'))]) {
    const underOld = await verifyRecord(broken, { expectId: id })
    assert.deepEqual(codesOf(underOld), ['CAPSULE_BYTES_MISMATCH'], 'never parsed: the mismatch alone')
    // Non-canonical bytes under their own correct digest: refused by their class, not as a mismatch.
    const underOwn = await verifyRecord(broken, { expectId: await digest(DOMAINS.capsule, broken) })
    assert.deepEqual(codesOf(underOwn), ['SYNTAX'])
    assert.equal(typeof underOwn.problems[0].at, 'number')
  }
  assert.deepEqual(codesOf(await verifyRecord(bytes, { expectId: id.toUpperCase() })), ['CAPSULE_BYTES_MISMATCH'])
})

test('determinism: two captures that differ only in observation share a state root and differ in id', async () => {
  const first = await base()
  const second = await base()
  second.observation.capturedAtMs += 60000
  second.observation.attempt = 2
  second.observation.sources[0].observedAtMs += 60000
  const [one, two] = await Promise.all([verifyRecord(encode(first)), verifyRecord(encode(second))])
  assert.equal(one.complete && two.complete, true)
  assert.equal(one.stateRoot, two.stateRoot)
  assert.notEqual(one.id, two.id)
  assert.equal((await verifyRecord(encode(await base()))).id, one.id)
  const third = await base()
  third.state.roots.suite.cases = 13
  assert.notEqual((await verifyRecord(encode(third))).stateRoot, one.stateRoot)
})

test('oversized and malformed input is refused before any schema check; the label only on a v1 record', async () => {
  const oversized = await verifyRecord(new Uint8Array(262145).fill(0x7b))
  assert.deepEqual(oversized.problems.map(problem => [problem.code, problem.at]), [['LIMIT', 262144]])
  assert.equal(oversized.ok, false)
  assert.deepEqual(oversized.labels, [])
  assert.deepEqual(codesOf(await verifyRecord('{}')), ['TYPE'])
  assert.deepEqual(codesOf(await verifyRecord('{}', { expectId: H('0') })), ['TYPE'])
  const empty = await verifyRecord(ascii('{}'))
  assert.deepEqual(empty.problems.map(problem => [problem.code, problem.path]), [['SCHEMA', 'schema'], ['SCHEMA', 'state'], ['SCHEMA', 'observation']])
  assert.equal(typeof empty.id, 'string')
  assert.deepEqual(empty.labels, [])
})

test('item bytes: each sha256-raw item is checked against its bytes; an item with no bytes is reported, never verified', async () => {
  const bytes = encode(await base())
  const good = await verifyRecord(bytes, { itemBytes: new Map([['file:docs/a.md', ITEM]]) })
  assert.equal(good.complete, true, listed(good.problems))
  assert.equal((await verifyRecord(bytes, { itemBytes: { 'file:docs/a.md': ITEM, 'organ:seed-judge': ascii('not hashed: native-id') } })).complete, true)
  const wrong = await verifyRecord(bytes, { itemBytes: { 'file:docs/a.md': ascii('abd') } })
  assert.deepEqual(wrong.problems.map(problem => [problem.code, problem.path]), [['CAPSULE_BYTES_MISMATCH', 'state.inventory[0].digest']])
  const truncated = await verifyRecord(bytes, { itemBytes: { 'file:docs/a.md': ascii('ab') } })
  assert.deepEqual(truncated.problems.map(problem => problem.path), ['state.inventory[0].byteLength', 'state.inventory[0].digest'])
  assert.ok(truncated.problems.every(problem => problem.rule.includes('file:docs/a.md')), 'the mismatch names the item')
  const none = await verifyRecord(bytes, { itemBytes: {} })
  assert.deepEqual(none.problems.map(problem => [problem.code, problem.path]), [['CAPSULE_INCOMPLETE', 'state.inventory[0]']])
  assert.match(none.problems[0].rule, /no bytes supplied/)
  assert.equal(none.ok, true)
  assert.equal(none.complete, false)
  // Without itemBytes nothing is claimed about the items either way.
  assert.equal((await verifyRecord(bytes)).complete, true)
})

test('the schema table: frozen, one row per field with a bound and a reason, and docs/capsule/SCHEMA.md holds the same rows', () => {
  assert.ok(Object.isFrozen(SCHEMA_TABLE) && SCHEMA_TABLE.every(row => Object.isFrozen(row)))
  assert.ok(SCHEMA_TABLE.length >= 70, String(SCHEMA_TABLE.length))
  assert.equal(new Set(SCHEMA_TABLE.map(row => row.path)).size, SCHEMA_TABLE.length)
  for (const row of SCHEMA_TABLE) for (const field of ['path', 'type', 'bound', 'why']) assert.ok(typeof row[field] === 'string' && row[field].length > 0, `${row.path} ${field}`)
  const doc = readFileSync(new URL('../../../../docs/capsule/SCHEMA.md', import.meta.url), 'utf8')
  for (const row of SCHEMA_TABLE) assert.ok(doc.includes(`| \`${row.path}\` | ${row.type} | ${row.bound} |`), `SCHEMA.md lacks ${row.path}`)
  for (const rule of SCHEMA_RULES) assert.ok(doc.includes(`**${rule.rule}**`), `SCHEMA.md lacks rule ${rule.rule}`)
  for (const [path, source] of Object.entries(NULL_SOURCES)) assert.ok(doc.includes(`| \`${path}\` | \`${source}\` |`), `SCHEMA.md lacks source ${path}`)
  // Every record field is mapped to the window field it is computed from (section 4: the record is a pure function of it).
  for (const row of SCHEMA_TABLE) if (row.path !== '(body)') assert.ok(doc.includes(`| \`${row.path}\` | `) && doc.split(`| \`${row.path}\` | `).length >= 3, `SCHEMA.md maps ${row.path} to the window`)
})
