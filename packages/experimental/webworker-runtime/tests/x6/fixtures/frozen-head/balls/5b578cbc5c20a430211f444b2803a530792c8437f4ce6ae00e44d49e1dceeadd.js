'use strict'
/**
 * seed-pearl: the Pearl Imagination Arena.
 *
 * A retention suite remembers what must never break again; scars record how each lesson was learned; a
 * challenge runs two candidate organ builds against the whole suite inside the isolated trial worker
 * (`ctx.scion.trialRetentionCandidate`: a disposable worker with test adapters, not proven containment) and records the outcome as a `pearl.challenge` receipt leaf.
 *
 * The candidates are real organ sources. A fixed harness (the same for every candidate) loads each organ
 * of a build against an in-memory file system seeded from the suite's fixtures, with a pinned clock, and
 * runs the case through the organ's own entry point (run, or the tool it registers). So a case checks
 * the organ's actual behaviour, not a stand-in. The default challenge compares the selected build of every
 * suite organ with the version it replaced (its last previousSpecifier).
 *
 * Everything here is self-attested: the receipt records what this organ ran and saw. It does not prove
 * the worker was isolated, and it is never authority.
 *
 * Actions: seed (write the suite and the first scars, once), observe, remember (engrave one scar),
 * challenge.
 */
const fs = require('node:fs')
const crypto = require('node:crypto')

const SEED = '/dsh/home/auma/seed'
const SUITE_FILE = SEED + '/pearl/retention-suite.v1.json'
const SCARS_FILE = SEED + '/scars.jsonl'
const RECEIPTS = SEED + '/receipts.v3.jsonl'
const OWNER_KEY_FILE = SEED + '/owner-key.v1.json'
const HEAD = '/dsh/home/balls/HEAD.json'
// --- contextual VFS ---
// The contract (server/pearl.test.mjs) hands this module a node:fs stub whose
// readFileSync THROWS whenever a contextual VFS is supplied. The module-level binding may exist,
// but it must never be the binding a read goes through when ctx.fs exists. The reader is resolved
// ONCE per action from ctx and threaded explicitly — not per call, and never from module state,
// because either of those can mix sources inside a single operation.
const nativeReader = fs
function readerFor(ctx) { return ctx && ctx.fs !== undefined ? ctx.fs : nativeReader }

/** Trial cases supply ctx.fs; a failed trial read must never fall back to the mounted body's files. */
function vfsReadWith(reader, file) {
  if (!reader || typeof reader.readFileSync !== 'function') throw new Error('PEARL_VFS_UNAVAILABLE')
  return reader.readFileSync(file, 'utf8')
}
function vfsRead(ctx, file) { return vfsReadWith(readerFor(ctx), file) }

// --- governance / grant constants (F3) ---
const GRANT_FILE = SEED + '/owner-grant.v1.json'
const GOVERNANCE_ORGANS = new Set(['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura', 'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map'])
const MAX_UNJUSTIFIED_GROWTH_PERCENT = 10
const MIN_GROWTH_JUSTIFICATION_LENGTH = 24

// The same six-key digest the suite pins: identity over the fields that decide what is graded,
// and null for any field the suite does not carry, so an absent field cannot change the digest.
function retentionSuiteDigest(suite) {
  const keys = ['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures']
  return sha256(canonicalJson(Object.fromEntries(keys.map((key) => [key, suite[key] ?? null]))))
}
const HARNESS_NAME = 'pearl-retention'
const INITIAL_SUITE_ORGANS = ['seed-receipts', 'auma-memory-domain', 'seed-superagent', 'seed-predict', 'seed-recall']
const FIXTURE_BALL = 'a'.repeat(64)
const FIXTURE_TARGET = 'b'.repeat(64)
const FIXTURE_EPOCH = 7
const FIXED_NOW = 1794200000000
const OWNER_GRANT_DOMAIN = 'aukora.x6.owner-grant.v1\0'

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const readJson = (file, reader = nativeReader) => JSON.parse(String(reader.readFileSync(file, 'utf8')))
function readRows(file, reader = nativeReader) {
  try {
    const text = String(reader.readFileSync(file, 'utf8'))
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}
function leaf(payload) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload), 'utf8')])).digest('hex')
}
function chainOf(rows) {
  let prevHash = '0'.repeat(64)
  return rows.map((row, index) => {
    const payload = { schema: 'aukora.receipt.v3', seq: index + 1, at: new Date(FIXED_NOW - 1000 * (rows.length - index)).toISOString(), kind: row.kind, prevHash, data: row.data }
    const record = { ...payload, leafHash: leaf(payload) }
    prevHash = record.leafHash
    return record
  })
}
const jsonl = (rows) => rows.map((row) => canonicalJson(row)).join('\n') + (rows.length ? '\n' : '')
function dagNode(fields) {
  const node = { ...fields }
  node.id = sha256(canonicalJson(fields))
  return node
}

// ----------------------------------------------------------------------------------------------------------
// The suite.

async function forgedEnvelopes(binding) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) throw new Error('WebCrypto unavailable')
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKeyHex = Buffer.from(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))).toString('hex')
  const text = canonicalJson({ schema: 'aukora.x6.owner-grant.v1', mandateId: binding.mandateId, ticketId: binding.ticketId, scope: binding.scope,
    ballId: binding.ballId, epoch: binding.epoch, expiresAt: binding.expiresAt, identity: binding.identity })
  const signatureHex = Buffer.from(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(OWNER_GRANT_DOMAIN + text)))).toString('hex')
  return { foreignKeyHex: publicKeyHex, foreign: { schema: 'aukora.x6.owner-grant.v1', ...binding, publicKeyHex, signatureHex } }
}

async function buildSuite(reader = nativeReader) {
  const ownerKeyText = String(reader.readFileSync(OWNER_KEY_FILE, 'utf8'))
  const ownerKey = JSON.parse(ownerKeyText).publicKeyHex
  const head = JSON.stringify({ version: 'x6.1-ball/v1', ballId: FIXTURE_BALL, parentBallId: null, epoch: FIXTURE_EPOCH, createdAt: 0, authorPeerId: 'pearl-fixture',
    entries: { 'seed-hello': { id: 'seed-hello', specifier: 'ball:' + 'c'.repeat(64), config: {}, disabled: false, previousSpecifiers: [] } }, modules: {} }, null, 2) + '\n'
  const binding = { mandateId: 'mnd_fixture', ticketId: null, scope: { paths: ['docs/**'] }, ballId: FIXTURE_BALL, epoch: FIXTURE_EPOCH, expiresAt: null, identity: 'owner' }
  const { foreignKeyHex, foreign } = await forgedEnvelopes(binding)
  const ownerClaimed = { ...foreign, publicKeyHex: ownerKey }
  const grantData = { mandateId: binding.mandateId, ticketId: null, scope: binding.scope, identity: binding.identity, ballId: FIXTURE_BALL, epoch: FIXTURE_EPOCH }
  const base = { [OWNER_KEY_FILE]: ownerKeyText, [HEAD]: head }

  const twoReceipts = chainOf([{ kind: 'self.edit', data: { note: 'fixture one' } }, { kind: 'self.edit', data: { note: 'fixture two' } }])
  const tampered = twoReceipts.map((row) => ({ ...row }))
  tampered[1] = { ...tampered[1], data: { note: 'rewritten after the fact' } }

  const root = dagNode({ parentIds: [], kind: 'fact', key: 'root', content: 'fixture root', tags: [], createdAt: FIXED_NOW - 2000, receiptHash: null, ticketId: null, tombstoneOf: null, memoryId: null })
  const aliasChild = dagNode({ schema: 'auma.memory.dag.node.v1', kind: 'episodic', createdAt: FIXED_NOW - 1000, parents: [root.id], summary: 'child linked by `parents`', tags: [], data: {} })
  const orphan = dagNode({ parentIds: [], kind: 'fact', key: 'orphan', content: 'nobody links here', tags: [], createdAt: FIXED_NOW - 500, receiptHash: null, ticketId: null, tombstoneOf: null, memoryId: null })
  const dagDir = '/dsh/home/auma/memory/dag'
  const dagFiles = (nodes, heads) => {
    const files = { [dagDir + '/HEAD.json']: JSON.stringify({ heads, count: nodes.length, updatedAt: FIXED_NOW }, null, 2) }
    for (const node of nodes) files[dagDir + '/' + node.id + '.json'] = JSON.stringify(node, null, 2)
    return files
  }
  const anchoredRoot = chainOf([{ kind: 'memory.dag.append', data: { nodeId: root.id, kind: root.kind, parentIds: [], payloadHash: sha256(canonicalJson({ kind: root.kind, key: root.key, content: root.content, tags: root.tags })) } }])
  const superagentState = JSON.stringify({ version: 1, updatedAt: FIXED_NOW, triggers: [], threads: [], tickets: [], assignments: [], attention: [], outbox: [],
    mandates: [{ id: binding.mandateId, title: 'fixture mandate', scope: binding.scope, strength: 'inferred', confirmed: false, confirmedBy: null, expiresAt: null, budgetSteps: 1 }] }, null, 2)
  const pendingPrediction = { prediction: 'fixture', expectedEpoch: null, expectedOrganCount: null, expectedBallId: null, expectedEntry: null, expectedPreviousCount: null, confidence: 0.5,
    metric: 'declaredOrgans', expected: 2, targetBallId: FIXTURE_TARGET, targetEpoch: FIXTURE_EPOCH + 1 }
  const pendingHash = sha256(canonicalJson(pendingPrediction))
  const pendingLog = canonicalJson({ kind: 'prediction.register', predictionHash: pendingHash, at: new Date(FIXED_NOW - 1000).toISOString(), headBallId: FIXTURE_BALL,
    headEpoch: FIXTURE_EPOCH, headOrganCount: 1, ...pendingPrediction }) + '\n'

  const fixtures = {
    base,
    'two-receipts': { ...base, [RECEIPTS]: jsonl(twoReceipts) },
    'tampered-chain': { ...base, [RECEIPTS]: jsonl(tampered) },
    'swapped-owner-key': { ...base, [OWNER_KEY_FILE]: JSON.stringify({ schema: 'aukora.owner-key.v1', keyId: 'attacker', algorithm: 'Ed25519', publicKeyHex: foreignKeyHex, domain: 'aukora.x6.owner-grant.v1' }, null, 2) + '\n' },
    'dag-parents-alias': { ...base, ...dagFiles([root, aliasChild], [aliasChild.id]) },
    'dag-orphan': { ...base, ...dagFiles([root, aliasChild, orphan], [aliasChild.id]) },
    'dag-unanchored': { ...base, ...dagFiles([root], [root.id]) },
    'dag-anchored': { ...base, ...dagFiles([root], [root.id]), [RECEIPTS]: jsonl(anchoredRoot) },
    'superagent-mandate': { ...base, '/dsh/home/auma/superagent/state.json': superagentState },
    'predict-pending': { ...base, '/dsh/home/auma/seed/predict/predictions.jsonl': pendingLog },
  }
  const grant = (envelope) => ({ action: 'append', kind: 'mandate.grant', data: grantData, ...(envelope ? { envelope } : {}) })
  const cases = [
    { id: 'receipts.append.event', scar: null, args: { organ: 'seed-receipts', fixture: 'base', input: { action: 'append', kind: 'self.edit', data: { note: 'x' } }, pick: ['receipt.seq'] }, expect: { ok: true, 'receipt.seq': 1 } },
    { id: 'receipts.chain.verify', scar: null, args: { organ: 'seed-receipts', fixture: 'two-receipts', input: { action: 'verify' }, pick: ['receiptsVerified'] }, expect: { ok: true, receiptsVerified: 2 } },
    { id: 'receipts.chain.tamper-refused', scar: null, args: { organ: 'seed-receipts', fixture: 'tampered-chain', input: { action: 'append', kind: 'self.edit', data: {} } }, expectError: 'RECEIPT_CHAIN_INVALID' },
    { id: 'receipts.grant.unsigned-refused', scar: 'scar-forged-mandate-grant', args: { organ: 'seed-receipts', fixture: 'base', input: grant(null), pick: ['reason'] }, expect: { ok: false, error: 'MANDATE_SIGNATURE_INVALID', reason: 'envelope-missing' } },
    { id: 'receipts.grant.foreign-key-refused', scar: 'scar-forged-mandate-grant', args: { organ: 'seed-receipts', fixture: 'base', input: grant(foreign), pick: ['reason'] }, expect: { ok: false, error: 'MANDATE_SIGNATURE_INVALID', reason: 'untrusted-key' } },
    { id: 'receipts.grant.owner-key-forged-signature', scar: 'scar-forged-mandate-grant', args: { organ: 'seed-receipts', fixture: 'base', input: grant(ownerClaimed), pick: ['reason'] }, expect: { ok: false, error: 'MANDATE_SIGNATURE_INVALID', reason: 'bad-signature' } },
    { id: 'receipts.grant.swapped-owner-key-refused', scar: 'scar-forged-mandate-grant', args: { organ: 'seed-receipts', fixture: 'swapped-owner-key', input: grant(foreign), pick: ['reason'] }, expect: { ok: false, error: 'MANDATE_SIGNATURE_INVALID', reason: 'owner-key-pin-mismatch' } },
    { id: 'dag.parents-alias-reachable', scar: 'scar-dag-parents-alias', args: { organ: 'auma-memory-domain', fixture: 'dag-parents-alias', tool: 'auma_memory_dag', input: { action: 'dag_verify' }, pick: ['reachableNodes', 'declaredCount'] }, expect: { ok: true, reachableNodes: 2, declaredCount: 2 } },
    { id: 'dag.orphan-fails-closed', scar: 'scar-dag-parents-alias', args: { organ: 'auma-memory-domain', fixture: 'dag-orphan', tool: 'auma_memory_dag', input: { action: 'dag_verify' }, pick: ['errorCodes'] }, expect: { ok: false, errorCodes: ['DAG_UNREACHABLE_ORPHANS'] } },
    { id: 'dag.write-anchored', scar: 'scar-unanchored-memory', args: { organ: 'auma-memory-domain', fixture: 'base', tool: 'auma_memory_dag', input: { action: 'dag_write', key: 'k', fact: 'pearl fixture fact' }, pick: ['anchor.anchored'] }, expect: { ok: true, 'anchor.anchored': 1 } },
    { id: 'superagent.eval-accept-explicit-refused', scar: 'scar-eval-accept-explicit', args: { organ: 'seed-superagent', fixture: 'superagent-mandate', tool: 'auma_superagent', input: { action: 'eval_accept', strength: 'explicit', title: 't', scope: { paths: ['docs/**'] } } }, expectError: 'EXPLICIT_REQUIRES_CONFIRM' },
    { id: 'superagent.confirm-unsigned-refused', scar: 'scar-eval-accept-explicit', args: { organ: 'seed-superagent', fixture: 'superagent-mandate', tool: 'auma_superagent', input: { action: 'confirm', mandateId: binding.mandateId, by: 'owner' } }, expectError: 'OWNER_SIGNATURE_REQUIRED' },
    { id: 'superagent.confirm-foreign-key-refused', scar: 'scar-forged-mandate-grant', args: { organ: 'seed-superagent', fixture: 'superagent-mandate', tool: 'auma_superagent', input: { action: 'confirm', mandateId: binding.mandateId, ownerGrant: foreign } }, expectError: 'OWNER_KEY_UNTRUSTED' },
    { id: 'predict.register-anchored', scar: 'scar-epoch-miss', args: { organ: 'seed-predict', fixture: 'base', input: { action: 'register', prediction: 'fixture', metric: 'declaredOrgans', expected: 2, targetBallId: FIXTURE_TARGET, targetEpoch: FIXTURE_EPOCH + 1 }, pick: ['receipt.seq'] }, expect: { ok: true, 'receipt.seq': 1 } },
    { id: 'predict.observe-waits-for-target', scar: 'scar-epoch-miss', args: { organ: 'seed-predict', fixture: 'predict-pending', input: { action: 'observe', predictionHash: pendingHash } }, expectError: 'PREDICTION_TARGET_NOT_SELECTED' },
    { id: 'recall.unanchored-not-clean', scar: 'scar-unanchored-memory', args: { organ: 'seed-recall', fixture: 'dag-unanchored', input: { action: 'context' }, pick: ['clean', 'unanchoredCount'] }, expect: { ok: true, clean: false, unanchoredCount: 1 } },
    { id: 'recall.anchored-clean', scar: 'scar-unanchored-memory', args: { organ: 'seed-recall', fixture: 'dag-anchored', input: { action: 'context' }, pick: ['clean', 'unanchoredCount'] }, expect: { ok: true, clean: true, unanchoredCount: 0 } },
  ]
  return {
    schema: 'aukora.pearl.retention-suite.v1',
    harness: HARNESS_NAME + '/v1',
    organs: INITIAL_SUITE_ORGANS,
    fixedNow: FIXED_NOW,
    note: 'Cumulative: cases are added, never removed. A genuine owner grant cannot be accepted here; that needs the owner key, which never enters her body.',
    cases,
    fixtures,
  }
}

const FIRST_SCARS = [
  { id: 'scar-dag-parents-alias', epoch: 1, lesson: 'A schema field name must never be able to orphan a memory; a DAG verifier must fail closed when the declared count differs from what it reaches.',
    failure: 'A node stored `parents` while the walker read `parentIds`. Two nodes fell out of reach and dag_verify still returned ok:true, errors:[].',
    checks: ['dag.parents-alias-reachable', 'dag.orphan-fails-closed'] },
  { id: 'scar-eval-accept-explicit', epoch: 1, lesson: 'Only the owner-signed confirm path may make a mandate explicit or confirmed.',
    failure: 'eval_accept could mint an explicit, confirmed mandate from the mere existence of a mandate.grant receipt.',
    checks: ['superagent.eval-accept-explicit-refused', 'superagent.confirm-unsigned-refused'] },
  { id: 'scar-forged-mandate-grant', epoch: 1, lesson: 'A mandate.grant leaf is judged by the owner signature it carries, against the pinned owner key, never by who is calling.',
    failure: 'An earlier epoch let any tool call append kind:"mandate.grant" and mint the owner; its first fix refused every grant, so seed-superagent wrote the log directly: two writers and a bypass.',
    checks: ['receipts.grant.unsigned-refused', 'receipts.grant.foreign-key-refused', 'receipts.grant.owner-key-forged-signature', 'receipts.grant.swapped-owner-key-refused', 'superagent.confirm-foreign-key-refused'] },
  { id: 'scar-epoch-miss', epoch: 1, lesson: 'Predict behaviour, not counters, and seal the prediction in the receipt chain before the act.',
    failure: 'Sealed with confidence 0.9: one promotion to the next epoch. Two promotions followed and observe scored surprise 50 on the epoch field, in a log that was not receipt-anchored.',
    checks: ['predict.register-anchored', 'predict.observe-waits-for-target'] },
  { id: 'scar-unanchored-memory', epoch: 1, lesson: 'A self-consistent memory is not an anchored one: a node is trusted only with a memory.dag.append leaf, and recall says so.',
    failure: 'Seven DAG nodes and every discovery trajectory verified only against themselves, so a minted node would have passed; the context file had to carry an UNAUTHENTICATED badge.',
    checks: ['dag.write-anchored', 'recall.unanchored-not-clean', 'recall.anchored-clean'] },
]

// ----------------------------------------------------------------------------------------------------------

async function appendReceipt(ctx, kind, data) {
  const organs = ctx && ctx.organs
  if (!organs || typeof organs.call !== 'function') return { ok: false, error: 'RECEIPTS_ORGAN_UNAVAILABLE' }
  const result = await organs.call('seed-receipts', { action: 'append', kind, data })
  return result && result.ok === true ? { ok: true, receipt: result.receipt } : { ok: false, error: (result && result.error) || 'RECEIPT_NOT_ACKNOWLEDGED' }
}

function readSuite(reader = nativeReader) {
  const suite = readJson(SUITE_FILE, reader)
  const ids = Array.isArray(suite.cases) ? suite.cases.map((c) => c && c.id) : null
  if (!ids || !ids.length || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length || !suite.fixtures) throw new Error('PEARL_SUITE_INVALID')
  return suite
}

async function remember(args, ctx) {
  const reader = readerFor(ctx)
  const scar = args && args.scar
  if (!scar || typeof scar.id !== 'string' || !/^scar-[a-z0-9-]{1,60}$/.test(scar.id) || typeof scar.lesson !== 'string' || !scar.lesson.trim() ||
      typeof scar.failure !== 'string' || !scar.failure.trim() || !Number.isSafeInteger(scar.epoch) || !Array.isArray(scar.checks)) {
    return { ok: false, error: 'PEARL_SCAR_INVALID', need: 'scar: { id: "scar-...", epoch, lesson, failure, checks: [caseId] }' }
  }
  const scars = readRows(SCARS_FILE, reader)
  if (scars.some((row) => row.id === scar.id)) return { ok: false, error: 'PEARL_SCAR_EXISTS', id: scar.id }
  let caseIds = []
  try { caseIds = readSuite(reader).cases.map((c) => c.id) } catch (_) { caseIds = [] }
  const missing = scar.checks.filter((id) => !caseIds.includes(id))
  if (missing.length) return { ok: false, error: 'PEARL_SCAR_CHECK_UNKNOWN', missing }
  const row = { schema: 'aukora.pearl.scar.v1', id: scar.id, epoch: scar.epoch, at: new Date().toISOString(), lesson: scar.lesson.trim(), failure: scar.failure.trim(), checks: scar.checks.slice() }
  reader.mkdirSync(SEED, { recursive: true })
  reader.appendFileSync(SCARS_FILE, canonicalJson(row) + '\n')
  const receipt = await appendReceipt(ctx, 'pearl.scar', { id: row.id, epoch: row.epoch, checks: row.checks, scarSha256: sha256(canonicalJson(row)) })
  return { ok: receipt.ok, action: 'remember', scar: row, receipt: receipt.ok ? { seq: receipt.receipt.seq, leafHash: receipt.receipt.leafHash } : null, error: receipt.ok ? undefined : receipt.error }
}

/**
 * Challenge any named organ against its selected baseline while retaining every suite case. The runtime
 * reads the suite and sources, constructs the fixed harness, regrades outputs and owns admission. A
 * receipt is only a projection; neither its booleans nor digests can mint a promotion admission.
 */

function parseSuite(text) {
  const suite = JSON.parse(text)
  const ids = Array.isArray(suite.cases) ? suite.cases.map((c) => c && c.id) : null
  if (!ids || !ids.length || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length || !suite.fixtures) throw new Error('PEARL_SUITE_INVALID')
  return suite
}

function challengeRefused(error) {
  return { ok: false, action: 'challenge', error, qualifiedForPromotion: false, qualificationId: null,
    standingGrantEligible: false, passkeyPromotionEligible: false, authorityVerified: false }
}

/** Trial errors may contain candidate-controlled secrets; only known machine codes may leave a failed arena. */
function safeTrialError(error) {
  const code = typeof error === 'string' && /^(CANDIDATE_TRIAL_(?:TIMEOUT|IMPORT_BLOCKED|ISOLATION_UNAVAILABLE|RESULTS_INCOMPLETE|OUTPUT_LIMIT|EMPTY)|SCION_ORGAN_NAME_MISMATCH)(?:$|[:\s])/.exec(error.slice(0, 128))
  return code ? code[1] : 'TRIAL_ERROR_REDACTED'
}

/** Missing observations or failed canaries invalidate both the numeric verdict and its receipt. */
function arenaUnavailable(arms) {
  const unavailableArms = arms.filter(([, result]) => {
    const controls = result && result.graderControls
    const controlsPassed = Boolean(controls && controls.allPassed === true && controls.knownGoodAccepted === true
      && controls.knownBadRejected === true && controls.acceptAllRejected === true && controls.rejectAllRejected === true)
    return !result || result.total === 0 || result.totalCases === 0 || !Array.isArray(result.results) || result.results.length === 0 || controlsPassed !== true
  }).map(([label]) => label)
  if (!unavailableArms.length) return null
  return { ...challengeRefused('PEARL_ARENA_UNAVAILABLE'), unavailableArms,
    trialErrors: Object.fromEntries(arms.filter(([, result]) => result && result.error !== undefined)
      .map(([label, result]) => [label, safeTrialError(result.error)])) }
}

function governanceTarget(organId, entry) {
  return GOVERNANCE_ORGANS.has(organId) || [entry, entry && entry.config].some(value => value &&
    Object.hasOwn(value, 'governance') && value.governance !== false)
}

/** An on-disk ceiling can restrict review, but cannot authenticate a standing grant. */
function grantCeiling(read) {
  let text
  try { text = read(GRANT_FILE) } catch (error) {
    return error && error.code === 'ENOENT' ? 'NO_GRANT_PRESENT' : 'GRANT_FILE_INVALID'
  }
  let grant
  try { grant = JSON.parse(text) } catch (error) { return 'GRANT_FILE_INVALID' }
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return 'GRANT_FILE_INVALID'
  const ceiling = grant.governanceScopeCeiling
  if (ceiling === 'class1_2_only' || (Number.isInteger(ceiling) && ceiling >= 0 && ceiling < 3)) return 'AUTHORITY_CEILING_REFUSED'
  // No runtime verifier for this persisted grant format exists. A claimed ceiling of 3,
  // signature, or caller-provided approval cannot turn this file into owner authority.
  return 'GRANT_FILE_INVALID'
}

function candidateGates(args, head, suite, read) {
  const organId = args.organId
  if (organId === undefined) {
    if (args.candidateSource !== undefined || args.candidateSpecifier !== undefined) throw new Error('PEARL_ORGAN_ID_REQUIRED')
    return { targeted: false, protectedSurface: false, ceilingError: null }
  }
  if (typeof organId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(organId)) throw new Error('PEARL_ORGAN_ID_INVALID')
  const entry = head.entries && Object.hasOwn(head.entries, organId) ? head.entries[organId] : null
  const justification = typeof args.sizeGrowthJustification === 'string' ? args.sizeGrowthJustification.trim() : ''
  const justified = justification.length >= MIN_GROWTH_JUSTIFICATION_LENGTH
  if (!entry) throw new Error(justified ? 'PEARL_ORGAN_ID_INVALID' : 'ORGAN_SIZE_GROWTH_UNJUSTIFIED')
  const sourceAt = specifier => {
    if (typeof specifier !== 'string' || !/^ball:[a-f0-9]{64}$/.test(specifier)) throw new Error('PEARL_BUILD_UNAVAILABLE')
    let source
    try { source = read('/dsh/home/balls/' + specifier.slice(5) + '.js') } catch (error) { throw new Error('PEARL_BUILD_UNAVAILABLE') }
    if (sha256(source) !== specifier.slice(5)) throw new Error('PEARL_MODULE_HASH_MISMATCH')
    return source
  }
  const incumbent = sourceAt(entry.specifier)
  const candidate = args.candidateSource !== undefined ? args.candidateSource
    : args.candidateSpecifier !== undefined ? sourceAt(args.candidateSpecifier) : incumbent
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('PEARL_SOURCE_INVALID')
  const incumbentBytes = Buffer.byteLength(incumbent, 'utf8')
  const candidateBytes = Buffer.byteLength(candidate, 'utf8')
  if (candidateBytes * 100 > incumbentBytes * (100 + MAX_UNJUSTIFIED_GROWTH_PERCENT) && !justified) throw new Error('ORGAN_SIZE_GROWTH_UNJUSTIFIED')
  const candidateAuthor = typeof args.candidateAuthor === 'string' ? args.candidateAuthor.trim() : ''
  const targetedCases = suite.cases.filter(test => test.args && test.args.organ === organId)
  if (!candidateAuthor || !targetedCases.length || targetedCases.some(test => typeof test.author !== 'string' || !test.author.trim() || test.author.trim() === candidateAuthor)) {
    throw new Error('ARENA_CROSS_AUTHORSHIP_REQUIRED')
  }
  const ceilingError = grantCeiling(read)
  if (ceilingError !== 'NO_GRANT_PRESENT') throw new Error(ceilingError)
  return { targeted: true, protectedSurface: governanceTarget(organId, entry), ceilingError,
    incumbentSha256: sha256(incumbent), candidateSha256: sha256(candidate), incumbentBytes, candidateBytes }
}

/**
 * Challenge any named organ against its selected baseline while retaining every suite case. The runtime
 * reads the suite and sources, constructs the fixed harness, regrades outputs and owns admission. A
 * receipt is only a projection; neither its booleans nor digests can mint a promotion admission.
 * Structural gates read the same trial VFS, require independently declared case authors and justify
 * growth over 10% with at least 24 characters. These declarations do not prove independent authorship.
 * Pearl checks no grant and grants nothing. The answer passes on the runtime's qualification id for an
 * ordinary organ; a protected organ's answer carries no id and its path is passkey review. Standing
 * admission is unavailable until a runtime grant verifier exists; approval belongs to the host.
 * Empty observations or failed grader canaries refuse with PEARL_ARENA_UNAVAILABLE, without a verdict
 * or receipt. Unavailable-arena causes expose only known machine codes, never raw error text or output.
 * The reader is resolved once here and every read in this operation, including the post-trial re-read,
 * goes through it: one operation cannot observe two filesystems.
 */
async function challenge(args, ctx) {
  if (args.candidateSource !== undefined && args.candidateSpecifier !== undefined) return challengeRefused('PEARL_CANDIDATE_AMBIGUOUS')
  if (args.baselineSpecifier !== undefined) return challengeRefused('PEARL_BASELINE_OVERRIDE_REFUSED')
  const reader = readerFor(ctx)
  const inputs = new Map()
  const read = file => {
    try {
      const text = String(vfsReadWith(reader, file))
      inputs.set(file, text)
      return text
    } catch (error) {
      if (error && error.code === 'ENOENT') inputs.set(file, null)
      throw error
    }
  }
  const suiteText = read(SUITE_FILE)
  const suite = parseSuite(suiteText)
  const suiteBytesDigest = sha256(suiteText)
  const suiteDigest = retentionSuiteDigest(suite)
  const head = JSON.parse(read(HEAD))
  const gates = candidateGates(args, head, suite, read)
  const trial = ctx && ctx.scion && ctx.scion.trialRetentionCandidate
  if (typeof trial !== 'function') return challengeRefused('PEARL_TRIAL_UNAVAILABLE')
  const request = Object.fromEntries(['organId', 'candidateSource', 'candidateSpecifier']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]))
  let comparison
  try { comparison = await trial(request) } catch (error) {
    const cause = error && typeof error.message === 'string' ? error.message : error
    return arenaUnavailable([['candidate', { error: cause }], ['baseline', null]])
  }
  const arms = [['candidate', comparison], ['baseline', comparison && comparison.baselineResult]]
  const unavailable = arenaUnavailable(arms)
  if (unavailable) return unavailable
  const ran = []
  for (const [label, result] of arms) {
    if (result.headBallId !== head.ballId || result.suiteDigest !== suiteDigest || result.suiteBytesDigest !== suiteBytesDigest) {
      return challengeRefused('PEARL_CHALLENGE_INPUT_CHANGED')
    }
    if (gates.targeted && (!result.organs || result.organs[args.organId] !== (label === 'candidate' ? gates.candidateSha256 : gates.incumbentSha256))) return challengeRefused('PEARL_CHALLENGE_INPUT_CHANGED')
    const controls = result.graderControls
    if (result.results.length !== suite.cases.length
      || !suite.cases.every((test, index) => { const row = result.results[index]; return row && row.id === test.id && typeof row.pass === 'boolean' })
      || typeof result.ok !== 'boolean' || !result.routeEvidence || !['checked', 'unsupported'].includes(result.routeEvidence.status)) {
      return challengeRefused('PEARL_COMPARISON_INCOMPLETE')
    }
    const retentionResults = result.results.map(row => ({ id: row.id, pass: row.pass }))
    const passedCases = retentionResults.filter(row => row.pass).length
    const qualifiedForPromotion = Boolean(result.qualifiedForPromotion === true && result.ok === true
      && result.suiteAdmission === 'build-pinned')
    ran.push({ label, organs: result.organs, passed: passedCases, passedCases,
      total: suite.cases.length, totalCases: suite.cases.length, trialOk: result.trialOk === true,
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
      qualifiedForPromotion, qualificationId: qualifiedForPromotion && typeof result.qualificationId === 'string' ? result.qualificationId : null,
      graderControls: controls || null, routeEvidence: result.routeEvidence || null,
      negativeControlRejected: result.negativeControlRejected === true,
      targetCovered: result.targetCovered === true, protectedSurface: result.protectedSurface === true,
      ...(typeof result.error === 'string' ? { trialError: result.error.slice(0, 200) } : {}), retentionResults })
  }
  for (const [file, expected] of inputs) {
    try {
      if (String(vfsReadWith(reader, file)) !== expected) return challengeRefused('PEARL_CHALLENGE_INPUT_CHANGED')
    } catch (error) {
      if (expected !== null || !error || error.code !== 'ENOENT') return challengeRefused('PEARL_CHALLENGE_INPUT_CHANGED')
    }
  }
  const ranked = ran.slice().sort((a, b) => b.passed - a.passed)
  const winner = ranked[0]
  const candidate = ran[0]
  const tie = !winner || !ranked[1] || ranked[1].passed === winner.passed
  const winnerId = tie || !winner || comparison.comparisonComplete !== true ? null : winner.label
  const targetImproved = gates.targeted && suite.cases.some((test, index) => test.args && test.args.organ === args.organId
    && ran[1].retentionResults[index].pass === false && candidate.retentionResults[index].pass === true)
  const behaviorQualified = gates.targeted && gates.candidateSha256 !== gates.incumbentSha256
    && targetImproved && comparison.targetImproved === true && candidate.targetCovered && winnerId === candidate.label
    && comparison.winnerId === candidate.label && candidate.qualifiedForPromotion
  const protectedSurface = gates.protectedSurface || candidate.protectedSurface
  const standingGrantEligible = false
  const passkeyPromotionEligible = behaviorQualified && protectedSurface && gates.ceilingError === 'NO_GRANT_PRESENT'
  const qualifiedForPromotion = behaviorQualified
  const suiteSha256 = sha256(canonicalJson(suite))
  const data = {
    headBallId: head.ballId, headEpoch: head.epoch, ballId: head.ballId, epoch: head.epoch,
    suiteSha256, retentionSuiteHash: suiteSha256, suiteDigest, suiteBytesDigest, harness: suite.harness,
    winnerId, winner: winnerId, winnerLabel: winnerId,
    candidateId: candidate.label, qualifiedForPromotion,
    standingGrantEligible, passkeyPromotionEligible, ceilingError: gates.ceilingError,
    authorityVerified: false, eligibilityScope: 'review-only-host-authorization-required',
    decidedBy: winnerId === null ? 'inconclusive' : winnerId === candidate.label ? 'retention-passes' : 'baseline-retained',
    candidates: ran.map(({ qualificationId, ...record }) => record),
    results: Object.fromEntries(ran.map(record => [record.label, {
      passed: record.passed, total: record.total, durationMs: record.durationMs, trialOk: record.trialOk,
      qualifiedForPromotion: record.qualifiedForPromotion, routeEvidence: record.routeEvidence, graderControls: record.graderControls,
    }])),
    realm: 'scion-trial-worker', authorityTier: 'self-attested', isolationProved: false,
    admissionScope: 'behavioral-retention-only', suiteAuthority: 'runtime-read-mutable-retention-suite',
  }
  const receipt = await appendReceipt(ctx, 'pearl.challenge', data)
  return { ok: receipt.ok, action: 'challenge', winnerId, winner: winnerId, candidateId: candidate.label,
    qualifiedForPromotion: receipt.ok && qualifiedForPromotion,
    qualificationId: receipt.ok && qualifiedForPromotion && !protectedSurface ? candidate.qualificationId : null,
    standingGrantEligible, passkeyPromotionEligible: receipt.ok && passkeyPromotionEligible,
    ceilingError: gates.ceilingError, authorityVerified: false, eligibilityScope: data.eligibilityScope,
    suiteDigest, suiteBytesDigest,
    candidateSpecifier: args.organId && candidate.organs ? 'ball:' + candidate.organs[args.organId] : null,
    expectedBallId: head.ballId, decidedBy: data.decidedBy, results: data.results,
    routeEvidence: candidate.routeEvidence, graderControls: candidate.graderControls, trialOk: candidate.trialOk,
    failures: Object.fromEntries(ran.map(record => [record.label, record.retentionResults.filter(row => !row.pass).map(row => row.id)])),
    receipt: receipt.ok ? { seq: receipt.receipt.seq, leafHash: receipt.receipt.leafHash } : null, error: receipt.ok ? undefined : receipt.error }
}

function observe(reader = nativeReader) {
  let suite = null
  try { suite = readSuite(reader) } catch (_) { suite = null }
  const scars = readRows(SCARS_FILE, reader)
  const receipts = readRows(RECEIPTS, reader)
  const latest = receipts.filter((r) => r.kind === 'pearl.challenge').at(-1) || null
  return {
    ok: true, action: 'observe', authorityTier: 'self-attested', isolationProved: false,
    suite: suite ? { cases: suite.cases.length, organs: suite.organs, sha256: sha256(canonicalJson(suite)) } : null,
    scars: scars.map((row) => ({ id: row.id, epoch: row.epoch, checks: row.checks.length })),
    latestChallenge: latest ? { seq: latest.seq, at: latest.at, headEpoch: latest.data.headEpoch, winner: latest.data.winnerLabel, results: latest.data.results } : null,
  }
}

module.exports = {
  name: 'seed-pearl',
  description:
    'The Pearl Imagination Arena. seed writes the retention suite and first scars (once); observe reports them and the latest challenge; remember ' +
    'engraves one scar (lesson, failure, the suite cases that check it); challenge runs the selected build of every suite organ and the versions ' +
    'they replaced against the whole suite, or one explicit candidate/baseline for any named organ. Records ranking separately from qualification. ' +
    'Use the runtime-issued qualificationId with tree_patch (or ball_put promote) for an ordinary organ; a protected organ gets passkey review instead. Admission is behavioral, not owner authority. Raw manual routes are unchanged.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['seed', 'observe', 'remember', 'challenge'] },
      organId: { type: 'string', description: 'For challenge: any currently selected organ; requires a retained case before qualification.' },
      candidateSource: { type: 'string', description: 'For challenge: explicit candidate JavaScript, instead of candidateSpecifier. Store these same bytes with ball_put before tree_patch.' },
      candidateSpecifier: { type: 'string', description: 'For challenge: prepared ball:<sha256>; default is the current selected source.' },
      candidateAuthor: { type: 'string', description: 'Declared candidate author, distinct from every retained target case author. Required for a targeted challenge; not an authenticated identity.' },
      sizeGrowthJustification: { type: 'string', description: 'For growth over 10%: at least 24 characters explaining additions, the retained case, and why a smaller change is insufficient.' },
      baselineSpecifier: { type: 'string', description: 'For challenge: explicit baseline; default is the predecessor, or the current source when no predecessor exists.' },
      scar: { type: 'object', description: 'For remember: { id: "scar-...", epoch, lesson, failure, checks: [suite case ids] }.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const reader = readerFor(ctx)
    const action = args && args.action
    try {
      if (action === 'observe') return observe(reader)
      if (action === 'remember') return await remember(args, ctx)
      if (action === 'challenge') return await challenge(args, ctx)
      if (action === 'seed') {
        if (reader.existsSync(SUITE_FILE)) return { ok: false, action, error: 'PEARL_SUITE_EXISTS', note: 'The suite only grows; it is never regenerated.' }
        const suite = await buildSuite(reader)
        reader.mkdirSync(SEED + '/pearl', { recursive: true })
        reader.writeFileSync(SUITE_FILE, JSON.stringify(suite, null, 2) + '\n')
        const suiteSha256 = sha256(canonicalJson(suite))
        const receipt = await appendReceipt(ctx, 'pearl.suite', { suiteSha256, cases: suite.cases.length, organs: suite.organs, harness: suite.harness })
        const engraved = []
        for (const scar of FIRST_SCARS) engraved.push(await remember({ scar }, ctx))
        return { ok: receipt.ok && engraved.every((r) => r.ok), action, suiteSha256, cases: suite.cases.length, scars: engraved.map((r) => (r.ok ? r.scar.id : r.error)) }
      }
      return { ok: false, error: 'UNKNOWN_ACTION', action: action || null }
    } catch (error) {
      if (action === 'challenge') return challengeRefused(String((error && error.message) || error))
      return { ok: false, action, error: String((error && error.message) || error) }
    }
  },
}
