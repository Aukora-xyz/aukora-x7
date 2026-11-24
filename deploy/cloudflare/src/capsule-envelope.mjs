// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE CAPSULE RECORD VERIFIER, `aukora.capsule.v1` (CONTRACT.md draft 7, section 4, closed). A record is its
 * canonical body bytes; its id is always recomputed (domain `aukora.capsule.v1`), its state root is the digest of
 * `body.state` (domain `aukora.capsule.state.v1`). It gates nothing (D5): it checks a claim and describes it.
 *
 * Imports only ./capsule-canon.mjs: every byte it reads, encodes or hashes goes through that one file (section 3.7).
 * Nothing imports this file yet (M1 changes nothing in her live body). The per-field table is SCHEMA_TABLE below, the
 * same table for people in docs/capsule/SCHEMA.md.
 *
 * `verifyRecord` returns `{ ok, complete, id, stateRoot, problems, labels }`, in this order of work:
 *   1. Presented under an id: the raw bytes are hashed and compared FIRST (3.6); a mismatch is CAPSULE_BYTES_MISMATCH
 *      alone and the bytes are not parsed.
 *   2. Parse (3.3): a refusal is its class with its position, alone.
 *   3. Another schema name, `readerMin` above 1, another `canon`, or a non-empty `extensions`: CAPSULE_SCHEMA_UNSUPPORTED,
 *      reported alone, without field checks.
 *   4. The closed field check: SCHEMA.
 *   5. Only on a body that passed it: the cross-field rules (SCHEMA: `agreement` recomputed by the five-value rule, the
 *      digest, reason and source-code pairs, a null with no row for its source, the kind an inventory id's form fixes,
 *      the five always-excluded rows as constants, `authorityRequired` exactly the three codes) and the completeness
 *      reports (CAPSULE_INCOMPLETE: an `unknown` row, a failed source, a null whose source row says `ok: false`, one of
 *      the five always-excluded rows missing, and with `itemBytes` a `sha256-raw` item with no bytes supplied);
 *      with `itemBytes`, each supplied item is checked (CAPSULE_BYTES_MISMATCH).
 * `ok` is false on any problem but CAPSULE_INCOMPLETE; `complete` is ok with no problem at all, and speaks only about the
 * record as declared (section 4): nothing unknown, no failed source, every required row present. The five
 * always-excluded rows, present and excluded, do not make a record incomplete; no v1 record is her whole self, because
 * it always leaves those five out and says so. Every record whose schema is `aukora.capsule.v1` carries the label
 * CAPSULE_PRODUCER_UNVERIFIED (D12): a label, never a problem.
 */
import { DOMAINS, LIMITS, digest, encode, parse, rawSha256 } from './capsule-canon.mjs'

export const RECORD_SCHEMA = 'aukora.capsule.v1'
export const CANON_PROFILE = 'aukora.canon.v1'

/** Section 4: reason codes, a closed list. */
export const REASON_CODES = Object.freeze([
  'EXCLUDED_AUTHORITY', 'EXCLUDED_SECRET', 'EXCLUDED_PRIVATE', 'EXCLUDED_HOST_SPECIFIC', 'EXCLUDED_NOT_PORTABLE',
  'UNKNOWN_NO_SOURCE', 'UNKNOWN_SOURCE_FAILED', 'UNKNOWN_SIGNER_UNPINNED', 'UNKNOWN_NOT_CAPTURED',
])

/** Section 16 (drafts 4 to 6, unchanged): the one closed table of codes this work introduces or reuses, in the table's order (the canon classes are not in it). */
export const CAPSULE_CODES = Object.freeze([
  'CAPSULE_BYTES_MISMATCH', 'CAPSULE_SCHEMA_UNSUPPORTED', 'CAPSULE_INCOMPLETE', 'CAPSULE_PRODUCER_UNVERIFIED',
  'CAPSULE_CAPTURE_CHANGED', 'CAPSULE_ACTION_ID_MISMATCH', 'CAPSULE_LINEAGE_MISMATCH', 'PROOF_INVALID', 'PROOF_REPLAYED',
  'PROOF_SUPERSEDED', 'CAPSULE_GENERATION_STALE', 'CAPSULE_INSTANCE_REVOKED', 'BODY_KEY_FORKED', 'WRITER_LEASE_REQUIRED', 'CAPSULE_INTENT_ALREADY_PLACED',
  'CAPSULE_ACTION_CONFLICT', 'CAPSULE_POSITION_STALE', 'CAPSULE_ACTION_UNKNOWN', 'CAPSULE_ACTION_ABANDONED',
  'CAPSULE_ACTION_COMMITTED', 'CAPSULE_INHERITED_LOCKED', 'CAPSULE_GATE_DENIED', 'CAPSULE_LEDGER_FULL',
  'CAPSULE_AUTHORITY_REQUIRED', 'CAPSULE_OUTCOME_UNKNOWN', 'DESTINATION_BEHIND',
])

/** Section 4: `authorityRequired[]` holds codes from this closed list; descriptive only, never a grant (D5). */
export const AUTHORITY_CODES = Object.freeze(['OWNER_APPROVED_MOVE', 'OWNER_SESSION', 'WRITER_LEASE'])

/** Section 4: `evidence.scope` is closed, one value per evidence list (retention, receipts, checkpoints). */
export const EVIDENCE_SCOPES = Object.freeze({
  retention: 'behavioral-retention-only',
  receipts: 'nostr-receipts-head',
  checkpoints: 'checkpoint',
})

/** The label every v1 record carries (D12): every field is a claim. */
export const PRODUCER_LABEL = 'CAPSULE_PRODUCER_UNVERIFIED'

/** Section 5: the source names, a closed list (`observation.sources[].name` is one of them). */
export const SOURCE_NAMES = Object.freeze([
  'baseline', 'evidence', 'files', 'head.local', 'head.published', 'head.staged', 'holder', 'journal', 'lease', 'lineage',
  'memory', 'modules', 'organs', 'owner', 'policy', 'producer', 'receipts', 'suite',
])

/** Section 4: the five inventory rows that are always present and always `excluded` (Rescue's exclusions). */
export const REQUIRED_EXCLUDED = Object.freeze(['ownerBinding', 'messages', 'turnJournal', 'providerBudget', 'headHistory'])

/**
 * Draft 7 ruling 5: the five always-excluded rows are constants: kind `other`, `byteLength`, `digest` and `digestKind`
 * null, disposition `excluded`, and this reason each. A row with one of the five names and any other value is SCHEMA.
 */
export const EXCLUDED_CONSTANTS = Object.freeze({
  ownerBinding: 'EXCLUDED_AUTHORITY',
  messages: 'EXCLUDED_PRIVATE',
  turnJournal: 'EXCLUDED_PRIVATE',
  providerBudget: 'EXCLUDED_HOST_SPECIFIC',
  headHistory: 'EXCLUDED_NOT_PORTABLE',
})

/**
 * Draft 7 ruling 4: the form of an inventory id fixes its kind. `organ:` goes with `organ-entry`, `module:` with `module`,
 * `file:` with the kind of its window row (`file`, `log`, `root` or `other`). The five fixed names are ruling 5's.
 */
export const INVENTORY_KINDS = Object.freeze({
  'organ:': Object.freeze(['organ-entry']),
  'module:': Object.freeze(['module']),
  'file:': Object.freeze(['file', 'log', 'root', 'other']),
})

/**
 * `heads.staged.state`, a closed list taken from the source: the three values HEAD gives the `state` of its staged
 * promotion record. deploy/cloudflare/src/head-do.mjs:1049 and :1139 (`awaiting_owner`, the held candidate) and :1123
 * (`published` or `superseded`, a record the head has moved past).
 */
export const STAGED_STATES = Object.freeze(['awaiting_owner', 'published', 'superseded'])

/**
 * Section 4 ("every nullable field names its source in a fixed table"): the source row that explains a null. A null with
 * a row that says `ok: true` was read and nothing is there (complete); a row that says `ok: false` is unknown
 * (CAPSULE_INCOMPLETE); no row for the source is SCHEMA. Nulls that are part of a row's own shape (an inventory item's
 * digest and byte length, a source's code, an evidence row's digest) are explained by that row and are not listed.
 */
export const NULL_SOURCES = Object.freeze({
  'state.lineageId': 'lineage',
  'state.parentCapsuleId': 'lineage',
  'state.heads.local.parentBallId': 'head.local',
  'state.heads.published': 'head.published',
  'state.heads.staged': 'head.staged',
  'state.producer.sourceRevision': 'producer',
  'state.producer.runtimeArtifactSha256': 'producer',
  'state.roots.receipts': 'receipts',
  'state.roots.memory': 'memory',
  'state.roots.suite': 'suite',
  'state.roots.baseline': 'baseline',
  'state.roots.policy': 'policy',
})

const MAX = LIMITS.integerMagnitude
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const HEX32 = /^[0-9a-f]{32}$/
const CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const PRINTABLE = /^[\x20-\x7e]+$/
/** The form of an inventory id: its prefix, or null for one of the five fixed names. */
const formOf = value => Object.keys(INVENTORY_KINDS).find(prefix => value.startsWith(prefix)) ?? null
/**
 * Section 4 and draft 7 ruling 4: `organ:<organ id>`, `module:<sha256>` (hex64), `file:<path id>`, or one of the five fixed
 * names. The 1-to-128 rule applies to the part AFTER the prefix (so `organ:` with 128 characters after it is an id).
 */
function inventoryIdOk(value) {
  if (!PRINTABLE.test(value)) return false
  if (REQUIRED_EXCLUDED.includes(value)) return true
  const form = formOf(value)
  if (form === null) return false
  const rest = value.slice(form.length)
  if (form === 'module:') return HEX64.test(rest)
  return rest.length >= 1 && rest.length <= 128
}

// Field kinds. `why` is the one-line reason for a bound (section 4 "Types, fixed now", or the source it was taken from).
const hex64 = (why = 'section 4: hex64 is the type of every hash, root and digest') => ({ kind: 'string', format: 'hex64', bound: '64 lowercase hex digits', why })
const id = (why = 'section 4: ids are 1 to 128 printable characters') => ({ kind: 'string', format: 'id', bound: '1..128 printable ASCII characters', why })
const code = (why = 'section 4: codes match [A-Z][A-Z0-9_]{0,127}') => ({ kind: 'string', format: 'code', bound: '[A-Z][A-Z0-9_]{0,127}', why })
const oneOf = (values, why = 'section 4 closed list') => ({ kind: 'string', format: 'enum', values: Object.freeze(values), bound: `one of ${values.join(', ')}`, why })
const literal = (value, why = 'section 4 literal') => ({ kind: typeof value === 'number' ? 'integer' : 'string', format: 'literal', value, bound: shown(value), why })
const integer = (min, max, why) => ({ kind: 'integer', min, max, bound: `${min}..${max}`, why })
const boolean = () => ({ kind: 'boolean', bound: 'true or false', why: 'section 4' })
const nullable = spec => ({ ...spec, nullable: true })
const object = fields => ({ kind: 'object', fields })
const array = (of, max, order, why) => ({ kind: 'array', of, max, order, bound: `at most ${max} items; strictly ascending by ${order}`, why })
function shown(value) { return typeof value === 'string' ? `"${value}"` : String(value) }

const FROM_ZERO = 'section 4: epochs, counts, times and policy.version are integers from 0'
const epoch = () => integer(0, MAX, FROM_ZERO)
const count = () => integer(0, MAX, FROM_ZERO)
const timeMs = () => integer(0, MAX, FROM_ZERO)
const head = extra => object({ ballId: hex64('section 4: hex64 (both ball id forms are 64 lowercase hex; carried verbatim, 3.5)'), ballIdForm: oneOf(['canonical', 'legacy']), epoch: epoch(), ...extra })
const evidenceRow = list => object({
  ref: id(),
  issuer: id(),
  scope: oneOf([EVIDENCE_SCOPES[list]], `section 4: evidence.scope is closed; ${list} rows carry "${EVIDENCE_SCOPES[list]}"`),
  status: oneOf(['verified', 'unverified', 'failed']),
  digest: nullable(hex64()),
})

/** The closed schema of section 4, as a tree. */
const SCHEMA = object({
  schema: literal(RECORD_SCHEMA, 'another schema name is CAPSULE_SCHEMA_UNSUPPORTED, reported alone'),
  state: object({
    lineageId: nullable(hex64('section 6.2: the act lineage is a digest')),
    parentCapsuleId: nullable(hex64('a record id: a digest under aukora.capsule.v1')),
    heads: object({
      local: head({ parentBallId: nullable(hex64('a ball id, as ballId')) }),
      published: nullable(head({})),
      staged: nullable(head({ state: oneOf(STAGED_STATES, 'closed list from the source: head-do.mjs:1049, :1123, :1139') })),
      agreement: oneOf(['agree', 'local-ahead', 'published-ahead', 'diverged', 'unknown'], 'section 4 closed list; recomputed from the heads (rule agreement)'),
    }),
    producer: object({
      builder: literal('host/capsule-record'),
      builderVersion: literal(1),
      sourceRevision: nullable({ kind: 'string', format: 'hex40', bound: '40 lowercase hex digits', why: 'section 4: sourceRevision is 40 lowercase hex' }),
      runtimeArtifactSha256: nullable(hex64()),
      claim: literal('self-asserted'),
    }),
    inventory: array(object({
      id: { kind: 'string', format: 'inventory-id', bound: `organ:<1..128 printable>, module:<hex64>, file:<1..128 printable>, or one of ${REQUIRED_EXCLUDED.join(', ')}`, why: 'section 4: inventory ids have a fixed form; the 1-to-128 rule applies after the prefix (draft 7 ruling 4)' },
      kind: oneOf(['organ-entry', 'module', 'file', 'log', 'root', 'other']),
      byteLength: nullable(count()),
      digest: nullable({ kind: 'string', format: 'digest', bound: '64 lowercase hex for sha256-raw; an id for native-id', why: 'rule digest-pair' }),
      digestKind: nullable(oneOf(['sha256-raw', 'native-id'])),
      disposition: oneOf(['included', 'excluded', 'unknown']),
      reason: nullable(oneOf(REASON_CODES, 'section 4 closed list; rule reason-pair')),
    }), 2048, 'id', 'section 4: inventory 2,048'),
    roots: object({
      receipts: nullable(object({ count: count(), lastLeafHash: hex64(), checkpointSeq: count() })),
      memory: nullable(object({ root: hex64(), nodes: count() })),
      suite: nullable(object({ digest: hex64(), cases: count() })),
      baseline: nullable(object({ digest: hex64() })),
      policy: nullable(object({ version: integer(0, MAX, FROM_ZERO), digest: hex64() })),
    }),
    pending: array(object({
      actionId: hex64('section 4: actionId is hex64'),
      intentId: { kind: 'string', format: 'hex32', bound: '32 lowercase hex digits', why: 'section 4: intentId is 32 lowercase hex' },
      seq: integer(1, MAX, 'section 4: seq is at least 1'),
      state: oneOf(['intent', 'sent', 'unknown']),
    }), 1024, 'seq', 'section 4: pending 1,024'),
    evidence: object({
      retention: array(evidenceRow('retention'), 1024, 'ref', 'section 4: each evidence list 1,024'),
      receipts: array(evidenceRow('receipts'), 1024, 'ref', 'section 4: each evidence list 1,024'),
      checkpoints: array(evidenceRow('checkpoints'), 1024, 'ref', 'section 4: each evidence list 1,024'),
    }),
    compatibility: object({
      readerMin: integer(1, 1, 'section 4: readerMin is 1 (above 1: CAPSULE_SCHEMA_UNSUPPORTED, reported alone)'),
      canon: literal(CANON_PROFILE, 'another canon is CAPSULE_SCHEMA_UNSUPPORTED, reported alone'),
      unsupported: array(code(), 64, 'value', 'section 4: code lists 64; sorted and unique'),
    }),
    authorityRequired: array(oneOf(AUTHORITY_CODES, 'section 4: a closed list of three codes'), 64, 'value', 'section 4: code lists 64; sorted and unique; exactly the three in a v1 record (rule authority-required); descriptive, never a grant (D5)'),
    extensions: { kind: 'object', format: 'empty', bound: '{} (non-empty: CAPSULE_SCHEMA_UNSUPPORTED, reported alone)', why: 'section 4: must be empty in v1' },
  }),
  observation: object({
    capturedAtMs: timeMs(),
    attempt: integer(1, 3, 'section 4: attempt is 1 to 3'),
    sources: array(object({ name: oneOf(SOURCE_NAMES, 'section 5: source names, a closed list'), ok: boolean(), code: nullable(code()), observedAtMs: timeMs() }),
      64, 'name', 'section 4: sources 64'),
  }),
})

/** Flatten the tree into the schema table (one row per field). */
function tableOf(spec, path, rows) {
  if (spec.kind === 'object' && spec.fields) {
    rows.push(Object.freeze({ path: path || '(body)', type: spec.nullable ? 'object or null' : 'object', bound: 'exactly these members', why: 'section 4 (closed)' }))
    for (const [name, field] of Object.entries(spec.fields)) tableOf(field, path ? `${path}.${name}` : name, rows)
    return rows
  }
  if (spec.kind === 'array') {
    rows.push(Object.freeze({ path, type: 'array', bound: spec.bound, why: spec.why }))
    tableOf(spec.of, `${path}[]`, rows)
    return rows
  }
  rows.push(Object.freeze({ path, type: spec.nullable ? `${spec.kind} or null` : spec.kind, bound: spec.bound, why: spec.why }))
  return rows
}

/** Every field of the record with its type, bound and reason (docs/capsule/SCHEMA.md is the same table for people). */
export const SCHEMA_TABLE = Object.freeze(tableOf(SCHEMA, '', []))

/** The cross-field rules of section 4, each with its source (also in docs/capsule/SCHEMA.md). */
export const SCHEMA_RULES = Object.freeze([
  Object.freeze({ rule: 'agreement', text: 'the stored agreement equals the one recomputed from local and published: unknown if published is null or the two id forms differ; agree if ids and epochs are equal; diverged if exactly one of id and epoch is equal; otherwise local-ahead or published-ahead by the larger epoch. A stored value that differs is SCHEMA; the staged head does not enter the rule', why: 'section 4 "three heads, never one"; S4' }),
  Object.freeze({ rule: 'digest-pair', text: 'digest is null exactly when digestKind is null; sha256-raw needs 64 lowercase hex, native-id an id', why: 'section 4 types; 3.5' }),
  Object.freeze({ rule: 'reason-pair', text: 'included has reason null; excluded has an EXCLUDED_ reason; unknown has an UNKNOWN_ reason', why: 'section 4 types' }),
  Object.freeze({ rule: 'source-code', text: 'a sources row with ok true has code null; with ok false it has a code', why: 'section 4 types' }),
  Object.freeze({ rule: 'failed-source', text: 'every sources row with ok false is CAPSULE_INCOMPLETE: a record with a failed source is not complete, whether or not a null names it', why: 'section 4: complete means nothing unknown, no failed source, every required row present; draft 7 ruling 3' }),
  Object.freeze({ rule: 'null-source', text: 'a null field of the source table: its source row with ok true is complete, with ok false is CAPSULE_INCOMPLETE; no row for its source is SCHEMA', why: 'section 4 "unknown is null plus a sources row"' }),
  Object.freeze({ rule: 'inventory-id', text: 'an inventory id is organ:<id>, module:<hex64>, file:<id> or one of the five fixed names; the 1-to-128 rule applies to the part after the prefix; anything else is SCHEMA (a field rule, checked with the field)', why: 'section 4; draft 7 ruling 4' }),
  Object.freeze({ rule: 'inventory-kind', text: 'the form fixes the kind: organ: with organ-entry, module: with module, file: with file, log, root or other; anything else is SCHEMA', why: 'section 4; draft 7 ruling 4' }),
  Object.freeze({ rule: 'excluded-constant', text: 'a row named ownerBinding, messages, turnJournal, providerBudget or headHistory is the constant: kind other; byteLength, digest and digestKind null; disposition excluded; reason EXCLUDED_AUTHORITY for ownerBinding, EXCLUDED_PRIVATE for messages and turnJournal, EXCLUDED_HOST_SPECIFIC for providerBudget, EXCLUDED_NOT_PORTABLE for headHistory; any other value is SCHEMA', why: 'section 4 "those five rows are constants"; draft 7 ruling 5' }),
  Object.freeze({ rule: 'required-excluded', text: 'a record without one of the five rows ownerBinding, messages, turnJournal, providerBudget, headHistory is CAPSULE_INCOMPLETE', why: 'section 4 "required rows"; draft 7 ruling 5 ("as before")' }),
  Object.freeze({ rule: 'authority-required', text: 'authorityRequired is exactly OWNER_APPROVED_MOVE, OWNER_SESSION, WRITER_LEASE; any other list is SCHEMA', why: 'section 4 "a v1 record carries all three, always"; draft 7 ruling 6' }),
  Object.freeze({ rule: 'item-bytes', text: 'with item bytes supplied, each sha256-raw item is checked against its bytes (a changed byte or a truncation is CAPSULE_BYTES_MISMATCH naming the item); an item with no bytes supplied is CAPSULE_INCOMPLETE and never counted as verified', why: 'section 4 "the verifier"' }),
])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const typeName = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

/** Check one value against its spec, pushing SCHEMA problems. */
function check(spec, value, path, problems) {
  const problem = rule => problems.push({ code: 'SCHEMA', path, rule })
  if (value === null) {
    if (!spec.nullable) problem(`null where ${spec.kind} is required`)
    return
  }
  switch (spec.kind) {
    case 'object': {
      if (!isObject(value)) return problem(`${typeName(value)} where object is required`)
      if (spec.format === 'empty') {
        if (Object.keys(value).length) problem('extensions must be empty in v1')
        return
      }
      for (const name of Object.keys(spec.fields)) {
        if (!Object.hasOwn(value, name)) { problems.push({ code: 'SCHEMA', path: path ? `${path}.${name}` : name, rule: 'missing field' }); continue }
        check(spec.fields[name], value[name], path ? `${path}.${name}` : name, problems)
      }
      for (const name of Object.keys(value)) if (!Object.hasOwn(spec.fields, name)) problems.push({ code: 'SCHEMA', path: path ? `${path}.${name}` : name, rule: 'unknown field' })
      return
    }
    case 'array': {
      if (!Array.isArray(value)) return problem(`${typeName(value)} where array is required`)
      if (value.length > spec.max) problem(`more than ${spec.max} items`)
      let previous
      value.forEach((item, index) => {
        check(spec.of, item, `${path}[${index}]`, problems)
        const sortKey = spec.order === 'value' ? item : isObject(item) ? item[spec.order] : undefined
        if (typeof sortKey !== 'string' && typeof sortKey !== 'number') return
        if (previous !== undefined && typeof previous === typeof sortKey && !(previous < sortKey)) problems.push({ code: 'SCHEMA', path: `${path}[${index}]`, rule: `not strictly ascending by ${spec.order}` })
        previous = sortKey
      })
      return
    }
    case 'boolean':
      if (typeof value !== 'boolean') problem(`${typeName(value)} where boolean is required`)
      return
    case 'integer': {
      if (typeof value !== 'number') return problem(`${typeName(value)} where integer is required`)
      if (spec.format === 'literal') { if (value !== spec.value) problem(`must be ${spec.value}`); return }
      if (value < spec.min || value > spec.max) problem(`outside ${spec.bound}`)
      return
    }
    case 'string': {
      if (typeof value !== 'string') return problem(`${typeName(value)} where string is required`)
      switch (spec.format) {
        case 'literal': if (value !== spec.value) problem(`must be "${spec.value}"`); return
        case 'enum': if (!spec.values.includes(value)) problem(`not ${spec.bound}`); return
        case 'hex64': if (!HEX64.test(value)) problem('not 64 lowercase hex digits'); return
        case 'hex40': if (!HEX40.test(value)) problem('not 40 lowercase hex digits'); return
        case 'hex32': if (!HEX32.test(value)) problem('not 32 lowercase hex digits'); return
        case 'id': if (value.length < 1 || value.length > 128) problem('not 1..128 characters'); return
        case 'code': if (!CODE.test(value)) problem('not a code'); return
        case 'digest': if (value.length < 1 || value.length > 128) problem('not 1..128 characters'); return
        case 'inventory-id': if (!inventoryIdOk(value)) problem('inventory-id: not an inventory id of section 4 (organ:<1..128>, module:<hex64>, file:<1..128>, or a fixed name)'); return
        default: problem('unknown format')
      }
    }
  }
}

/**
 * The five-value agreement rule of section 4, from the record's own local and published heads.
 * @param {{ ballId: string, ballIdForm: string, epoch: number }} local
 * @param {{ ballId: string, ballIdForm: string, epoch: number } | null} published
 * @returns {'agree' | 'local-ahead' | 'published-ahead' | 'diverged' | 'unknown'}
 */
export function agreementOf(local, published) {
  if (published === null || local.ballIdForm !== published.ballIdForm) return 'unknown'
  const sameId = local.ballId === published.ballId
  const sameEpoch = local.epoch === published.epoch
  if (sameId && sameEpoch) return 'agree'
  if (sameId !== sameEpoch) return 'diverged'
  return local.epoch > published.epoch ? 'local-ahead' : 'published-ahead'
}

/** The reasons a record is not judged by this reader (section 4), read before any field check. */
function unsupportedOf(body) {
  const found = []
  if (typeof body.schema === 'string' && body.schema !== RECORD_SCHEMA) found.push({ path: 'schema', rule: `schema ${body.schema.slice(0, 64)}` })
  const state = isObject(body.state) ? body.state : null
  const compatibility = state && isObject(state.compatibility) ? state.compatibility : null
  if (compatibility && typeof compatibility.readerMin === 'number' && compatibility.readerMin > 1) found.push({ path: 'state.compatibility.readerMin', rule: 'readerMin above 1' })
  if (compatibility && typeof compatibility.canon === 'string' && compatibility.canon !== CANON_PROFILE) found.push({ path: 'state.compatibility.canon', rule: `canon ${compatibility.canon.slice(0, 64)}` })
  if (state && isObject(state.extensions) && Object.keys(state.extensions).length) found.push({ path: 'state.extensions', rule: 'extensions must be empty in v1' })
  return found.map(entry => ({ code: 'CAPSULE_SCHEMA_UNSUPPORTED', ...entry }))
}

/** The cross-field rules (SCHEMA_RULES) and the CAPSULE_INCOMPLETE reports, on a body that passed the field check. */
function crossRules(body, problems) {
  const { state, observation } = body
  const heads = state.heads
  const recomputed = agreementOf(heads.local, heads.published)
  if (heads.agreement !== recomputed) problems.push({ code: 'SCHEMA', path: 'state.heads.agreement', rule: `agreement: stored ${heads.agreement}, recomputed ${recomputed}` })
  state.inventory.forEach((item, index) => {
    const path = `state.inventory[${index}]`
    if ((item.digest === null) !== (item.digestKind === null)) problems.push({ code: 'SCHEMA', path, rule: 'digest-pair: digest and digestKind are both null or both set' })
    else if (item.digestKind === 'sha256-raw' && !HEX64.test(item.digest)) problems.push({ code: 'SCHEMA', path: `${path}.digest`, rule: 'digest-pair: sha256-raw needs 64 lowercase hex digits' })
    const reasonOk = item.disposition === 'included' ? item.reason === null
      : item.disposition === 'excluded' ? typeof item.reason === 'string' && item.reason.startsWith('EXCLUDED_')
        : typeof item.reason === 'string' && item.reason.startsWith('UNKNOWN_')
    if (!reasonOk) problems.push({ code: 'SCHEMA', path: `${path}.reason`, rule: `reason-pair: ${item.disposition} with reason ${item.reason}` })
    const form = formOf(item.id)
    if (form !== null && !INVENTORY_KINDS[form].includes(item.kind)) problems.push({ code: 'SCHEMA', path: `${path}.kind`, rule: `inventory-kind: ${form} goes with ${INVENTORY_KINDS[form].join(' or ')}, not ${item.kind}` })
    if (Object.hasOwn(EXCLUDED_CONSTANTS, item.id)) {
      const constant = item.kind === 'other' && item.byteLength === null && item.digest === null && item.digestKind === null &&
        item.disposition === 'excluded' && item.reason === EXCLUDED_CONSTANTS[item.id]
      if (!constant) problems.push({ code: 'SCHEMA', path, rule: `excluded-constant: ${item.id} is kind other, no bytes or digest, excluded, ${EXCLUDED_CONSTANTS[item.id]}` })
    }
  })
  if (state.authorityRequired.join() !== AUTHORITY_CODES.join()) problems.push({ code: 'SCHEMA', path: 'state.authorityRequired', rule: `authority-required: exactly ${AUTHORITY_CODES.join(', ')}` })
  const sources = new Map()
  observation.sources.forEach((row, index) => {
    sources.set(row.name, row)
    if (row.ok === (row.code !== null)) problems.push({ code: 'SCHEMA', path: `observation.sources[${index}].code`, rule: 'source-code: ok true has code null; ok false has a code' })
  })
  observation.sources.forEach((row, index) => {
    if (row.ok === false && row.code !== null) problems.push({ code: 'CAPSULE_INCOMPLETE', path: `observation.sources[${index}]`, rule: `failed-source: source "${row.name}" failed (${row.code})` })
  })
  for (const [path, source] of Object.entries(NULL_SOURCES)) {
    const value = path.split('.').reduce((at, name) => (isObject(at) ? at[name] : undefined), body)
    if (value !== null) continue
    const row = sources.get(source)
    if (row === undefined) problems.push({ code: 'SCHEMA', path, rule: `null-source: a null with no sources row "${source}"` })
    else if (row.ok === false) problems.push({ code: 'CAPSULE_INCOMPLETE', path, rule: `null-source: source "${source}" failed (${row.code})` })
  }
  state.inventory.forEach((item, index) => {
    if (item.disposition === 'unknown') problems.push({ code: 'CAPSULE_INCOMPLETE', path: `state.inventory[${index}]`, rule: 'an unknown row' })
  })
  // Draft 7 ruling 5: a missing row is CAPSULE_INCOMPLETE; a present row that is not the constant is SCHEMA (above).
  for (const name of REQUIRED_EXCLUDED) {
    if (!state.inventory.some(item => item.id === name)) problems.push({ code: 'CAPSULE_INCOMPLETE', path: 'state.inventory', rule: `required-excluded: no row ${name}` })
  }
}

/**
 * Verify one capsule record (section 4).
 * @param {Uint8Array} bytes The record's canonical body bytes.
 * @param {{ expectId?: string, itemBytes?: Map<string, Uint8Array> | Record<string, Uint8Array> }} [options]
 *   `expectId`: the id the bytes are presented under. `itemBytes`: raw bytes by inventory id, for the sha256-raw items.
 * @returns {Promise<{ ok: boolean, complete: boolean, id: string | null, stateRoot: string | null, problems: { code: string, path: string, rule?: string, at?: number }[], labels: string[] }>}
 */
export async function verifyRecord(bytes, { expectId, itemBytes } = {}) {
  const problems = []
  const labels = []
  const done = (recordId, stateRoot) => {
    const ok = problems.every(problem => problem.code === 'CAPSULE_INCOMPLETE')
    return { ok, complete: ok && problems.length === 0, id: recordId, stateRoot, problems, labels }
  }
  if (!(bytes instanceof Uint8Array)) {
    problems.push({ code: 'TYPE', path: '', at: 0, rule: 'input is not a Uint8Array' })
    return done(null, null)
  }
  // 3.6: hash the raw bytes and compare first; a mismatch is reported alone and the bytes are never parsed.
  if (expectId !== undefined && (await digest(DOMAINS.capsule, bytes)) !== expectId) {
    problems.push({ code: 'CAPSULE_BYTES_MISMATCH', path: '', rule: 'the bytes do not hash to the id they are presented under' })
    return done(null, null)
  }
  let body
  try {
    body = parse(bytes)
  } catch (error) {
    problems.push({ code: error.code, path: '', at: error.at, rule: 'not a canonical text' })
    return done(null, null)
  }
  const recordId = await digest(DOMAINS.capsule, bytes)
  const stateRoot = isObject(body.state) ? await digest(DOMAINS.state, encode(body.state)) : null
  if (body.schema === RECORD_SCHEMA) labels.push(PRODUCER_LABEL)
  const unsupported = unsupportedOf(body)
  if (unsupported.length) {
    problems.push(...unsupported)
    return done(recordId, stateRoot)
  }
  check(SCHEMA, body, '', problems)
  if (problems.length === 0) {
    crossRules(body, problems)
    if (itemBytes !== undefined) await checkItems(body.state.inventory, itemBytes, problems)
  }
  return done(recordId, stateRoot)
}

async function checkItems(inventory, itemBytes, problems) {
  const lookup = itemBytes instanceof Map ? key => itemBytes.get(key) : key => (Object.hasOwn(itemBytes, key) ? itemBytes[key] : undefined)
  for (const [index, item] of inventory.entries()) {
    if (item.digestKind !== 'sha256-raw') continue
    const path = `state.inventory[${index}]`
    const raw = lookup(item.id)
    if (raw === undefined) { problems.push({ code: 'CAPSULE_INCOMPLETE', path, rule: `item-bytes: no bytes supplied for ${item.id}` }); continue }
    if (!(raw instanceof Uint8Array)) { problems.push({ code: 'CAPSULE_BYTES_MISMATCH', path, rule: `item-bytes: the bytes supplied for ${item.id} are not a Uint8Array` }); continue }
    if (item.byteLength !== null && item.byteLength !== raw.length) problems.push({ code: 'CAPSULE_BYTES_MISMATCH', path: `${path}.byteLength`, rule: `item-bytes: the bytes supplied for ${item.id} have another length` })
    if ((await rawSha256(raw)) !== item.digest) problems.push({ code: 'CAPSULE_BYTES_MISMATCH', path: `${path}.digest`, rule: `item-bytes: the bytes supplied for ${item.id} do not hash to its sha256-raw digest` })
  }
}
