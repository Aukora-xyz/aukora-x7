/** Imported policy regressions, with synthetic manifests and no network, credentials or live state. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T2_ONLY_ORGANS, canonicalJson as transitionCanonical, classifyTransition,
} from '../../../../server/ball-transition.mjs'
import {
  OWNER_GOVERNANCE_ORGANS, canonicalJson, classifyHeadTransition, headPromotionBinding,
  normalizeOwnerGrantBinding, ownerGrantCanonical,
} from '../owner-grant-policy.mjs'
import { ownerGrantCanonical as browserCanonical } from '../../../../apps/web/src/spatial/superagent/owner-grant.ts'

const NOW = 1794000000000
const PARENT = 'a'.repeat(64), CANDIDATE = 'b'.repeat(64)
const OLD_MODULE = 'c'.repeat(64), NEW_MODULE = 'd'.repeat(64)
const EXPECTED_GOVERNANCE = [
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot',
]
function manifests(id = 'seed-calc') {
  const entry = { id, specifier: `ball:${OLD_MODULE}`, disabled: false, config: {}, previousSpecifiers: [] }
  const previous = { ballId: PARENT, epoch: 7, entries: { [id]: entry } }
  const candidate = { ballId: CANDIDATE, parentBallId: PARENT, epoch: 8,
    entries: { [id]: { ...entry, specifier: `ball:${NEW_MODULE}` } } }
  return { previous, candidate }
}
function sessionOptions(organs = ['seed-calc']) {
  return { canonicalManifestMatches: true, ownerSessionApproved: true, now: NOW,
    ownerSession: { ballId: PARENT, epoch: 7, expiresAt: NOW + 60000, scope: { organs } } }
}
function grant(overrides = {}) {
  return { mandateId: 'synthetic-owner-mandate', ticketId: 'synthetic-ticket', scope: { organs: ['seed-calc'] },
    ballId: PARENT, epoch: 7, expiresAt: NOW + 60000, identity: 'synthetic-owner', ...overrides }
}
const normalize = input => normalizeOwnerGrantBinding(input, { now: NOW })

test('grant and transition governance use one fixed protected set, including compiler and boot', async () => {
  assert.equal(OWNER_GOVERNANCE_ORGANS, T2_ONLY_ORGANS)
  assert.deepEqual(T2_ONLY_ORGANS, EXPECTED_GOVERNANCE)
  assert.ok(Object.isFrozen(T2_ONLY_ORGANS))
  for (const organ of EXPECTED_GOVERNANCE) for (const id of [organ, `${organ}:${OLD_MODULE}`]) {
    const { previous, candidate } = manifests(id)
    // Request-controlled labels cannot lower a protected organ's tier.
    for (const entry of [previous.entries[id], candidate.entries[id]]) {
      entry.governance = false; entry.config.governance = false; entry.class = 1
    }
    for (const [before, after] of [[previous, candidate], [null, candidate], [previous, { ...candidate, entries: {} }]]) {
      const tier = classifyTransition(before, after, sessionOptions([organ]))
      assert.equal(tier.tier, 'T2', id)
      assert.equal(tier.isEdgeT1OrganUpdate, false, id)
      assert.ok(tier.t2Reasons.includes('T2_PROTECTED_ORGAN'), id)
      assert.deepEqual(classifyHeadTransition(before, after), { class: 3, entryIds: [id] })
      const binding = await headPromotionBinding({ audience: 'https://fixture.example', ball: after, previous: before, entryId: id })
      assert.equal(binding.organId, organ)
      assert.equal(binding.epoch, 8)
    }
    assert.throws(() => normalize(grant({ scope: { organs: [organ] } })), { code: 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED' })
    assert.doesNotThrow(() => normalize(grant({ scope: { organs: [organ], candidateSha256: NEW_MODULE } })))
  }
})

test('governance declarations remain T2 when removed or malformed on either manifest', () => {
  for (const value of [true, null, 'false', 0, [], {}]) for (const location of ['entry', 'config']) {
    const { previous, candidate } = manifests()
    ;(location === 'entry' ? previous.entries['seed-calc'] : previous.entries['seed-calc'].config).governance = value
    candidate.entries['seed-calc'].config = { governance: false }
    candidate.entries['seed-calc'].governance = false
    for (const [before, after] of [[previous, candidate], [candidate, previous]]) {
      assert.equal(classifyTransition(before, after, sessionOptions()).tier, 'T2')
      assert.equal(classifyHeadTransition(before, after).class, 3)
    }
  }
})

test('T1 needs canonical module replacement and an explicit live epoch-fenced owner session', () => {
  const { previous, candidate } = manifests()
  const options = sessionOptions()
  const accepted = classifyTransition(previous, candidate, options)
  assert.equal(accepted.tier, 'T1')
  assert.equal(accepted.isEdgeT1OrganUpdate, true)
  assert.equal(classifyHeadTransition(previous, candidate).class, 1)
  assert.ok(Object.isFrozen(accepted) && Object.isFrozen(accepted.changedEntryIds))
  assert.equal(classifyTransition(previous, candidate, { ownerSessionApproved: true }).isEdgeT1OrganUpdate, false)
  for (const mutate of [
    o => { delete o.ownerSession }, o => { o.ownerSessionApproved = false },
    o => { delete o.canonicalManifestMatches }, o => { o.canonicalManifestMatches = false },
    o => { o.ownerSession.ballId = CANDIDATE }, o => { o.ownerSession.epoch = 8 },
    o => { o.ownerSession.expiresAt = NOW }, o => { o.ownerSession.expiresAt = null },
    o => { o.ownerSession.expiresAt = NOW + 0.5 }, o => { o.ownerSession.expiresAt = Number.MAX_SAFE_INTEGER + 1 },
    o => { o.now = NOW + 60000 }, o => { o.now = NaN }, o => { o.now = -0 }, o => { o.now = NOW + 0.5 },
    o => { o.ownerSession.scope = null }, o => { o.ownerSession.scope = {} },
    o => { o.ownerSession.scope.organs = [] }, o => { o.ownerSession.scope.organs = ['*'] },
    o => { o.ownerSession.scope.organs = ['seed-calc', 'seed-calc'] },
    o => { o.ownerSession.scope.organs = ['seed-wish'] },
    o => { o.ownerSession.scope.organs.push('seed-boot') },
    o => { o.ownerSession.scope.paths = ['deploy/cloudflare/src/worker.mjs'] },
    o => { o.ownerSession.approved = true },
  ]) {
    const altered = structuredClone(options); mutate(altered)
    assert.equal(classifyTransition(previous, candidate, altered).isEdgeT1OrganUpdate, false, mutate.toString())
  }
  for (const mutate of [
    b => { b.parentBallId = CANDIDATE }, b => { b.epoch = 9 }, b => { b.epoch = 8.5 },
    b => { b.epoch = Number.MAX_SAFE_INTEGER + 1 }, b => { b.epoch = -0 },
  ]) {
    const altered = structuredClone(candidate); mutate(altered)
    assert.equal(classifyTransition(previous, altered, options).isEdgeT1OrganUpdate, false)
  }
  const next = { ...candidate, ballId: 'e'.repeat(64), parentBallId: CANDIDATE, epoch: 9,
    entries: { 'seed-calc': { ...candidate.entries['seed-calc'], specifier: `ball:${OLD_MODULE}` } } }
  assert.equal(classifyTransition(candidate, next, options).isEdgeT1OrganUpdate, false, 'Captured session cannot follow a newer epoch')
  assert.equal(classifyTransition(previous, candidate, { ...options, now: NOW + 59999 }).isEdgeT1OrganUpdate, true)
})

test('T1 does not admit added, disabled, configuration, multi-organ or metadata-only changes', () => {
  const { previous, candidate } = manifests()
  for (const mutate of [
    b => { b.entries['seed-calc'].disabled = true }, b => { b.entries['seed-calc'].config = { altered: true } },
    b => { b.entries['seed-wish'] = { ...b.entries['seed-calc'], id: 'seed-wish' } },
    b => { delete b.entries['seed-calc'] }, b => { b.entries['seed-calc'].specifier = './seed-calc.js' },
    b => { b.entries['seed-calc'].specifier = `ball:${OLD_MODULE}`; b.entries['seed-calc'].updatedAt = NOW },
  ]) {
    const altered = structuredClone(candidate); mutate(altered)
    const result = classifyTransition(previous, altered, sessionOptions())
    assert.equal(result.tier, 'T2')
    assert.equal(result.isEdgeT1OrganUpdate, false)
  }
  assert.equal(classifyTransition(null, candidate, sessionOptions()).tier, 'T2')
  assert.equal(classifyTransition(previous, previous, sessionOptions()).tier, 'T2')
  const prototypeName = manifests('constructor')
  assert.ok(classifyTransition(prototypeName.previous, { ...prototypeName.candidate, entries: {} }, sessionOptions()).t2Reasons.includes('ORGAN_ADDED_OR_REMOVED'))
})

test('owner grant numeric authority fields reject non-integer, unsafe and alternate scalar values', () => {
  for (const epoch of [-1, -0, 7.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    assert.throws(() => normalize(grant({ epoch })), { code: 'OWNER_GRANT_INVALID_EPOCH' })
  }
  for (const expiresAt of [-1, -0, NOW, NOW + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, `${NOW + 60000}`]) {
    assert.throws(() => normalize(grant({ expiresAt })), { code: 'OWNER_GRANT_INVALID_EXPIRY' })
  }
  for (const now of [-1, -0, NOW + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, `${NOW}`]) {
    assert.throws(() => normalizeOwnerGrantBinding(grant(), { now }), { code: 'OWNER_GRANT_INVALID_EXPIRY' })
  }
  assert.equal(normalize(grant({ epoch: 0, expiresAt: Number.MAX_SAFE_INTEGER })).epoch, 0)
  assert.equal(normalize(grant({ ticketId: null, expiresAt: null })).expiresAt, null)
  assert.equal(normalize(grant({ scope: { organs: ['seed-calc'], threshold: 0.25 } })).scope.threshold, 0.25)
})

test('accepted grant serialization is identical across policy, browser and persisted JSON', () => {
  assert.equal(canonicalJson, transitionCanonical)
  for (const input of [grant(), grant({ epoch: 0 }), grant({ epoch: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER }),
    grant({ ticketId: null, expiresAt: null }), grant({ scope: { organs: ['seed-calc'], nested: { enabled: false, count: 1, nullable: null } } })]) {
    const binding = normalize(input)
    const persisted = JSON.parse(JSON.stringify(binding))
    assert.equal(ownerGrantCanonical(binding), ownerGrantCanonical(persisted))
    assert.equal(ownerGrantCanonical(binding), browserCanonical(binding))
    assert.equal(canonicalJson(binding), canonicalJson(persisted))
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.scope) && Object.isFrozen(binding.scope.organs))
  }
})

test('governance approval terms reject invalid numeric epochs before serialization', async () => {
  const { candidate } = manifests('seed-boot')
  for (const epoch of [-1, -0, 8.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8']) {
    await assert.rejects(headPromotionBinding({ audience: 'https://fixture.example', ball: { ...candidate, epoch }, entryId: 'seed-boot' }), { code: 'CLASS3_ACTION_INVALID' })
  }
})
