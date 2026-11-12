/** Night grant: one passkey, bounded uses of ordinary organ promotions, every refusal falls back to the biometric card. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NIGHT_GRANT_ATTEMPTS, NIGHT_GRANT_ATTEMPT_WINDOW_MS, X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { aumlokClass3Binding } from '../aumlok.mjs'
import { NIGHT_GRANT_MAX_LIFETIME_MS, NIGHT_GRANT_RECORD_SCHEMA, NIGHT_GRANT_SCHEMA, NIGHT_GRANT_SCOPE, nightGrantCovers, nightGrantPlainWords, normalizeNightGrantTerms } from '../night-grant.mjs'

const ORIGIN = 'https://night-grant.example.invalid'
const OWNER = 'owner@example.invalid'
const APPROVAL = { 'x-x6-class3-approval': 'fixture-approval' }

function storageFixture() {
  let data = new Map(), tail = Promise.resolve(), fault = () => {}
  // Transactional writes call `fault` after they land in the transaction's copy: a test may move the clock or throw there.
  const view = (map, transactional = false) => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); if (transactional) await fault('put', key, value) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.snapshot = () => structuredClone(data)
  storage.inject = callback => { fault = callback }
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const value = await operation(view(copy, true))
      data = copy
      return value
    })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

async function organ(name) {
  const code = `export const organ = ${JSON.stringify(name)};`, sha = await digest(code)
  return { code, sha, entry: { id: name, specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] },
    module: { sha256: sha, specifier: `ball:${sha}`, size: code.length } }
}

async function fixture({ env: extraEnv = {}, options = {}, clock = null } = {}) {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), ...extraEnv }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('External network forbidden') }, ...(clock ? { now: () => clock.now } : {}), ...options })
  const base = await organ('ordinary-a')
  const ball = { version: 'x6.1-ball/v1', epoch: 169, parentBallId: null, authorPeerId: 'fixture-writer',
    entries: { 'ordinary-a': base.entry }, modules: { [base.sha]: base.module } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [base.sha]: base.code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  // AS AUMLOK DOES: a token is minted for ONE exact binding and is spent once, inside the caller's
  // transaction, so a rolled-back transaction leaves it unspent.
  const approvals = [], minted = new Map()
  let mints = 0
  const mint = binding => { const token = `fixture-approval-${String(++mints)}`; minted.set(token, canonicalJson(binding)); return token }
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding) => {
    const refuse = () => { throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }) }
    if (!minted.has(token) || minted.get(token) !== canonicalJson(binding)) refuse()
    if (await tx.get(`fixture:spent:${token}`) !== undefined) refuse()
    await tx.put(`fixture:spent:${token}`, binding)
    approvals.push(binding)
    return { ok: true, binding, expiresAt: Date.now() + 60000 }
  } }
  const issueBody = async overrides => ({ action: 'issue', terms: await terms(overrides) })
  const tokenFor = async body => mint(await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/night-grant', body }))
  const call = async (path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }), ...extra })
    const response = await head.fetch(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  const terms = async (overrides = {}) => {
    const status = (await call('/_head/status')).body
    return { schema: NIGHT_GRANT_SCHEMA, grantId: 'grant-0123456789abcdef', audience: ORIGIN, scope: NIGHT_GRANT_SCOPE,
      issuedAtHead: { ballId: status.ballId, epoch: status.epoch }, notAfter: Date.now() + 60 * 60 * 1000, maxUses: 12, maxOrgansPerUse: 8, ...overrides }
  }
  /** Issue with a token minted for exactly this body, unless the test passes its own headers. */
  const issue = async (overrides, headers) => {
    const body = await issueBody(overrides)
    return call('/_head/night-grant', body, headers ?? { 'x-x6-class3-approval': await tokenFor(body) })
  }
  /** Stage a candidate built from the selected head by `edit(next, add)`. */
  const stage = async edit => {
    const raw = (await call('/_head/ball')).body
    const prev = raw.ball ?? raw
    const next = { ...structuredClone(prev), epoch: prev.epoch + 1, parentBallId: prev.ballId, authorPeerId: 'fixture-writer' }
    delete next.ballId
    const codeBySha = {}
    const add = async (name, extra = {}) => {
      const made = await organ(name)
      next.entries[name] = { ...made.entry, ...extra }
      next.modules[made.sha] = made.module
      codeBySha[made.sha] = made.code
      return made
    }
    await edit(next, add)
    next.ballId = await manifestIdCanon(next)
    const staged = await call('/_head/stage', { ball: next, codeBySha, expectedParentBallId: prev.ballId, expectedEpoch: prev.epoch })
    assert.equal(staged.status, 200, JSON.stringify(staged.body))
    return next
  }
  const promote = (ball, extra = {}) => call('/_head/night-grant/promote', { ballId: ball.ballId }, extra)
  return { storage, head, call, terms, issue, issueBody, tokenFor, stage, promote, approvals, ball }
}

// The promote route acquires and releases a writer lease before HEAD decides (existing behavior), and the grant route
// counts every attempt in its own throttle whatever the outcome; grant and head keys are compared.
const withoutFixtureApprovals = snapshot => new Map([...snapshot].filter(([key]) => !key.startsWith('fixture:')
  && !['generation', 'lease', 'head:night-grant:attempts'].includes(key)))

test('issue: the passkey binds the exact body, and the record starts with every use', async () => {
  const fx = await fixture()
  const issued = await fx.issue()
  assert.equal(issued.status, 200, JSON.stringify(issued.body))
  assert.equal(issued.body.nightGrant.usesLeft, 12)
  assert.equal(issued.body.nightGrant.state, 'active')
  assert.equal(fx.approvals.length, 1)
  assert.equal(fx.approvals[0].schema, 'aukora.class3.action.v1')
  assert.equal(fx.approvals[0].pathname, '/_head/night-grant')
  assert.equal(fx.approvals[0].bodySha256, await digest(canonicalJson({ action: 'issue', terms: issued.body.nightGrant.terms })))
  assert.ok(issued.body.nightGrant.plainWords.some(line => line.includes('Governance organs')))
  const status = await fx.call('/_head/night-grant')
  assert.equal(status.body.nightGrant.state, 'active')
  assert.equal(status.body.receipts[0].kind, 'issue')
})

test('issue refusals never spend an approval or write state', async () => {
  const cases = [
    [{ extra: true }, 'NIGHT_GRANT_TERMS_INVALID'],
    [{ schema: 'aukora.night-grant.v2' }, 'NIGHT_GRANT_TERMS_INVALID'],
    [{ grantId: 'short' }, 'NIGHT_GRANT_TERMS_INVALID'],
    [{ audience: 'https://other.example.invalid' }, 'NIGHT_GRANT_AUDIENCE_MISMATCH'],
    [{ scope: 'all-organs' }, 'NIGHT_GRANT_SCOPE_REFUSED'],
    [{ issuedAtHead: { ballId: 'ab'.repeat(32), epoch: 169 } }, 'NIGHT_GRANT_STALE_HEAD'],
    [{ notAfter: Date.now() - 1 }, 'NIGHT_GRANT_EXPIRED'],
    [{ notAfter: Date.now() + NIGHT_GRANT_MAX_LIFETIME_MS + 60000 }, 'NIGHT_GRANT_LIFETIME_REFUSED'],
    [{ maxUses: 13 }, 'NIGHT_GRANT_USES_REFUSED'],
    [{ maxUses: 0 }, 'NIGHT_GRANT_USES_REFUSED'],
    [{ maxUses: 1.5 }, 'NIGHT_GRANT_USES_REFUSED'],
    [{ maxOrgansPerUse: 9 }, 'NIGHT_GRANT_SCOPE_REFUSED'],
  ]
  for (const [overrides, code] of cases) {
    const fx = await fixture()
    const before = fx.storage.snapshot()
    const refused = await fx.issue(overrides)
    assert.equal(refused.body.code, code, JSON.stringify(overrides))
    assert.equal(fx.approvals.length, 0)
    assert.deepEqual(fx.storage.snapshot(), before)
  }
})

test('issue without a passkey, or with a refused one, writes nothing', async () => {
  for (const headers of [{}, { 'x-x6-class3-approval': 'forged' }]) {
    const fx = await fixture()
    const before = fx.storage.snapshot()
    const refused = await fx.issue({}, headers)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.deepEqual(fx.storage.snapshot(), before)
  }
})

test('a Pearl-qualifying deployment never accepts a night grant', async () => {
  const fx = await fixture({ options: { verifyTransitionQualification: async () => { throw new Error('no qualification in this test') } } })
  const refused = await fx.issue()
  assert.equal(refused.body.code, 'NIGHT_GRANT_UNAVAILABLE')
  assert.equal(fx.approvals.length, 0)
})

test('one active grant at a time, and a grant id is never reused', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue()).status, 200)
  assert.equal((await fx.issue({ grantId: 'grant-second-0000000' })).body.code, 'NIGHT_GRANT_ACTIVE')
  assert.equal((await fx.call('/_head/night-grant', { action: 'revoke', grantId: 'grant-0123456789abcdef' })).status, 200)
  assert.equal((await fx.issue()).body.code, 'NIGHT_GRANT_ID_REUSED')
  assert.equal((await fx.issue({ grantId: 'grant-second-0000000' })).status, 200)
  assert.equal(fx.approvals.length, 2)
})

test('a use promotes five added ordinary organs atomically, with a receipt naming grant and uses left', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue()).status, 200)
  const ball = await fx.stage(async (_next, add) => {
    for (const name of ['nostr-anchor', 'voice-slot', 'repo-forge', 'auma-cortex', 'adversary']) await add(name)
  })
  const used = await fx.promote(ball)
  assert.equal(used.status, 200, JSON.stringify(used.body))
  assert.deepEqual(used.body.nightGrant, { grantId: 'grant-0123456789abcdef', use: 1, usesLeft: 11 })
  const status = (await fx.call('/_head/status')).body
  assert.equal(status.ballId, ball.ballId)
  const grant = (await fx.call('/_head/night-grant')).body
  assert.equal(grant.nightGrant.usesLeft, 11)
  const receipt = grant.receipts.find(row => row.kind === 'use')
  assert.equal(receipt.grantId, 'grant-0123456789abcdef')
  assert.equal(receipt.usesLeft, 11)
  assert.equal(receipt.ballId, ball.ballId)
  assert.deepEqual(receipt.organs.map(row => row.organId), ['adversary', 'auma-cortex', 'nostr-anchor', 'repo-forge', 'voice-slot'])
  assert.ok(receipt.organs.every(row => row.kind === 'add' && /^[0-9a-f]{64}$/.test(row.sha256) && row.size > 0))
  assert.deepEqual((await fx.storage.get('head:last-publish-outcome')).nightGrant, { grantId: 'grant-0123456789abcdef', use: 1, usesLeft: 11 })
})

/** A code-only update of ordinary-a as the stager writes it: history appended from the selected head. */
const codeUpdate = (tweak = () => {}) => async (next, add) => {
  const made = await add('ordinary-a-v2')
  delete next.entries['ordinary-a-v2']
  const prev = next.entries['ordinary-a']
  const entry = { ...prev, specifier: made.entry.specifier, previousSpecifiers: [...prev.previousSpecifiers, prev.specifier],
    previousVersions: [...(prev.previousVersions ?? []), { specifier: prev.specifier, config: prev.config, disabled: prev.disabled }], updatedAt: 1 }
  tweak(entry, prev, made)
  next.entries['ordinary-a'] = entry
}

test('an ordinary code-only update, with the history HEAD derives, is covered', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue()).status, 200)
  const ball = await fx.stage(codeUpdate())
  const used = await fx.promote(ball)
  assert.equal(used.status, 200, JSON.stringify(used.body))
  assert.equal(used.body.nightGrant.usesLeft, 11)
})

for (const [label, edit, code] of [
  ['an erased history', codeUpdate((entry) => { entry.previousSpecifiers = []; entry.previousVersions = [] }), 'NIGHT_GRANT_HISTORY_REFUSED'],
  ['a substituted rollback module', codeUpdate((entry, _prev, made) => { entry.previousSpecifiers = [made.entry.specifier] }), 'NIGHT_GRANT_HISTORY_REFUSED'],
  ['a substituted rollback config', codeUpdate((entry) => { entry.previousVersions = [{ ...entry.previousVersions[0], config: { evil: true } }] }), 'NIGHT_GRANT_HISTORY_REFUSED'],
  ['a config change with new code', codeUpdate((entry) => { entry.config = { mode: 'wide' } }), 'NIGHT_GRANT_CONFIG_CHANGE_REFUSED'],
  ['a config-only update', async (next) => { next.entries['ordinary-a'] = { ...next.entries['ordinary-a'], config: { mode: 'wide' } } }, 'NIGHT_GRANT_CONFIG_CHANGE_REFUSED'],
  ['an extra field on the update', codeUpdate((entry) => { entry.note = 'x' }), 'NIGHT_GRANT_HISTORY_REFUSED'],
  ['an add carrying its own rollback history', async (next, add) => {
    const made = await add('history-organ')
    next.entries['history-organ'] = { ...made.entry, previousSpecifiers: [next.entries['ordinary-a'].specifier] }
  }, 'NIGHT_GRANT_ADD_SHAPE_REFUSED'],
  ['an add with settings', async (_next, add) => { await add('configured-organ', { config: { mode: 'wide' } }) }, 'NIGHT_GRANT_ADD_SHAPE_REFUSED'],
]) {
  test(`A grant use refuses ${label}`, async () => {
    const fx = await fixture()
    assert.equal((await fx.issue()).status, 200)
    const ball = await fx.stage(edit)
    const before = (await fx.call('/_head/status')).body.ballId
    const refused = await fx.promote(ball)
    assert.equal(refused.body.code, code)
    assert.equal((await fx.call('/_head/status')).body.ballId, before)
    assert.equal((await fx.call('/_head/night-grant')).body.nightGrant.usesLeft, 12)
  })
}

for (const [label, edit, code] of [
  ['a fixed governance organ', async (_next, add) => { await add('grant-ledger') }, 'NIGHT_GRANT_GOVERNANCE_REFUSED'],
  ['a governance declaration on the entry', async (_next, add) => { await add('quiet-judge', { governance: true }) }, 'NIGHT_GRANT_GOVERNANCE_REFUSED'],
  ['a governance declaration in config', async (_next, add) => { await add('quiet-judge', { config: { governance: 'owner' } }) }, 'NIGHT_GRANT_GOVERNANCE_REFUSED'],
  ['a removal', async next => { delete next.entries['ordinary-a'] }, 'NIGHT_GRANT_REMOVAL_REFUSED'],
  ['a disable', async next => { next.entries['ordinary-a'] = { ...next.entries['ordinary-a'], disabled: true } }, 'NIGHT_GRANT_DISABLED_STATE_REFUSED'],
  ['an added disabled organ', async (_next, add) => { await add('sleeper', { disabled: true }) }, 'NIGHT_GRANT_DISABLED_STATE_REFUSED'],
  ['more organs than maxOrgansPerUse', async (_next, add) => { for (let i = 0; i < 9; i++) await add(`organ-${i}`) }, 'NIGHT_GRANT_SCOPE_REFUSED'],
]) {
  test(`use refuses ${label}, writes nothing, and leaves the candidate for the biometric card`, async () => {
    const fx = await fixture()
    assert.equal((await fx.issue()).status, 200)
    const ball = await fx.stage(edit)
    const before = withoutFixtureApprovals(fx.storage.snapshot())
    const refused = await fx.promote(ball)
    assert.equal(refused.body.code, code)
    assert.deepEqual(withoutFixtureApprovals(fx.storage.snapshot()), before)
    const { staged } = await fx.head.store.readStaged()
    assert.equal(staged?.ballId, ball.ballId)
  })
}

test('missing, revoked and exhausted grants refuse and never open', async () => {
  const fx = await fixture()
  const first = await fx.stage(async (_next, add) => { await add('first-organ') })
  assert.equal((await fx.promote(first)).body.code, 'NIGHT_GRANT_MISSING')
  assert.equal((await fx.issue({ maxUses: 1 })).status, 200)
  assert.equal((await fx.promote(first)).status, 200)
  const second = await fx.stage(async (_next, add) => { await add('second-organ') })
  assert.equal((await fx.promote(second)).body.code, 'NIGHT_GRANT_EXHAUSTED')
  assert.equal((await fx.issue({ grantId: 'grant-revoked-000000' })).status, 200)
  assert.equal((await fx.call('/_head/night-grant', { action: 'revoke', grantId: 'grant-revoked-000000' })).status, 200)
  assert.equal((await fx.promote(second)).body.code, 'NIGHT_GRANT_REVOKED')
  assert.equal((await fx.call('/_head/status')).body.ballId, first.ballId)
})

test('the grant route refuses passkey headers and extra fields; the passkey route never consults the grant', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue()).status, 200)
  const ball = await fx.stage(async (_next, add) => { await add('route-organ') })
  assert.equal((await fx.promote(ball, APPROVAL)).body.code, 'NIGHT_GRANT_ROUTE_INVALID')
  assert.equal((await fx.call('/_head/night-grant/promote', { ballId: ball.ballId, extra: 1 })).body.code, 'NIGHT_GRANT_ROUTE_INVALID')
  const passkeyRoute = await fx.call('/_head/promote', { ballId: ball.ballId })
  assert.equal(passkeyRoute.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
})

test('failed grant uses never count toward the owner passkey lockout', async () => {
  const fx = await fixture()
  const ball = await fx.stage(async (_next, add) => { await add('lockout-organ') })
  for (let i = 0; i < 8; i++) assert.equal((await fx.promote(ball)).body.code, 'NIGHT_GRANT_MISSING')
  assert.equal((await fx.storage.get('gate-lockout:v1')), undefined)
})

test('policy: expiry, audience, stale head and module removal refuse; plain words state the limits', async () => {
  const now = 1_800_000_000_000
  const head = { ballId: 'aa'.repeat(32), epoch: 169 }
  const terms = normalizeNightGrantTerms({ schema: NIGHT_GRANT_SCHEMA, grantId: 'grant-policy-0000000', audience: ORIGIN, scope: NIGHT_GRANT_SCOPE,
    issuedAtHead: head, notAfter: now + 3600000, maxUses: 12, maxOrgansPerUse: 8 }, { now, audience: ORIGIN, head })
  const record = { schema: NIGHT_GRANT_RECORD_SCHEMA, terms, usesLeft: 12, revokedAt: null }
  const add = await organ('policy-organ'), base = await organ('base-organ')
  const previous = { version: 'x6.1-ball/v1', ballId: head.ballId, epoch: 169, entries: { 'base-organ': base.entry }, modules: { [base.sha]: base.module } }
  const candidate = { ...structuredClone(previous), ballId: 'bb'.repeat(32), parentBallId: head.ballId, epoch: 170 }
  candidate.entries['policy-organ'] = add.entry
  candidate.modules[add.sha] = add.module
  assert.equal(nightGrantCovers({ record, previous, candidate, now, audience: ORIGIN }).ok, true)
  assert.equal(nightGrantCovers({ record, previous, candidate, now: now + 3600000, audience: ORIGIN }).code, 'NIGHT_GRANT_EXPIRED')
  assert.equal(nightGrantCovers({ record, previous, candidate, now, audience: 'https://other.example.invalid' }).code, 'NIGHT_GRANT_AUDIENCE_MISMATCH')
  assert.equal(nightGrantCovers({ record, previous, candidate: { ...candidate, epoch: 171 }, now, audience: ORIGIN }).code, 'NIGHT_GRANT_STALE_HEAD')
  assert.equal(nightGrantCovers({ record, previous, candidate: { ...candidate, parentBallId: 'cc'.repeat(32) }, now, audience: ORIGIN }).code, 'NIGHT_GRANT_STALE_HEAD')
  const dropped = structuredClone(candidate)
  delete dropped.modules[base.sha]
  dropped.entries['base-organ'] = { ...base.entry }
  assert.equal(nightGrantCovers({ record, previous, candidate: dropped, now, audience: ORIGIN }).code, 'NIGHT_GRANT_MODULE_REMOVAL_REFUSED')
  assert.equal(nightGrantCovers({ record: { ...record, usesLeft: 0 }, previous, candidate, now, audience: ORIGIN }).code, 'NIGHT_GRANT_EXHAUSTED')
  assert.equal(nightGrantCovers({ record: { ...record, revokedAt: now }, previous, candidate, now, audience: ORIGIN }).code, 'NIGHT_GRANT_REVOKED')
  assert.equal(nightGrantCovers({ record: undefined, previous, candidate, now, audience: ORIGIN }).code, 'NIGHT_GRANT_MISSING')
  const words = nightGrantPlainWords(terms).join(' ')
  for (const fact of ['at most 12 times', 'at most 8 organs', 'never covered', 'revoke it at any time', 'grant-policy-0000000', 'settings and undo history never change']) assert.ok(words.includes(fact), fact)
})

for (const lastKey of ['head:night-grant', 'head', 'head:last-publish-outcome']) {
  test(`A use whose writes reach notAfter (clock moves at ${lastKey}) rolls everything back`, async () => {
    const clock = { now: Date.now() }
    const fx = await fixture({ clock })
    // Inside the 30 s writer lease, so only the grant deadline is crossed.
    const notAfter = clock.now + 5_000
    assert.equal((await fx.issue({ notAfter })).status, 200)
    const ball = await fx.stage(async (_next, add) => { await add('late-organ') })
    const before = fx.storage.snapshot()
    fx.storage.inject((operation, key) => { if (operation === 'put' && key === lastKey) clock.now = notAfter })
    const refused = await fx.promote(ball)
    fx.storage.inject(() => {})
    assert.equal(refused.body.code, 'NIGHT_GRANT_EXPIRED')
    const after = fx.storage.snapshot()
    for (const key of ['head', 'head:night-grant', 'head:last-publish-outcome']) assert.deepEqual(after.get(key), before.get(key), key)
    assert.equal([...after.keys()].some(key => key.startsWith('head:night-grant:receipt:grant-0123456789abcdef:01')), false)
  })
}

// Lease bookkeeping, the passkey gate and the grant route's attempt counter persist by design whatever the outcome.
const durable = snapshot => new Map([...snapshot].filter(([key]) => !['generation', 'lease', 'gate-lockout:v1', 'head:night-grant:attempts'].includes(key)))

test('An issuance approval is spent once, and only for the body it was minted for', async () => {
  const fx = await fixture()
  const body = await fx.issueBody()
  const token = await fx.tokenFor(body)
  // Minted for body A, offered with body B: refused, and A's token stays unspent.
  const other = await fx.issueBody({ grantId: 'grant-other-00000000' })
  assert.equal((await fx.call('/_head/night-grant', other, { 'x-x6-class3-approval': token })).body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await fx.call('/_head/night-grant', body, { 'x-x6-class3-approval': token })).status, 200)
  assert.equal((await fx.call('/_head/night-grant', { action: 'revoke', grantId: body.terms.grantId })).status, 200)
  // Replaying the exact body is refused (the grant id is burned), and the token is recorded spent: it cannot pass the
  // approval check again for any body, since it was minted for this one only.
  assert.equal((await fx.call('/_head/night-grant', body, { 'x-x6-class3-approval': token })).body.code, 'NIGHT_GRANT_ID_REUSED')
  assert.notEqual(fx.storage.snapshot().get(`fixture:spent:${token}`), undefined)
  assert.equal(fx.approvals.length, 1)
})

for (const failAt of ['fixture:spent:', 'head:night-grant:issued:', 'head:night-grant', 'head:night-grant:receipt:']) {
  test(`An issuance that fails after writing ${failAt} keeps nothing, and its approval stays unspent`, async () => {
    const fx = await fixture()
    const body = await fx.issueBody()
    const token = await fx.tokenFor(body)
    const before = durable(fx.storage.snapshot())
    fx.storage.inject((operation, key) => { if (operation === 'put' && (failAt === 'head:night-grant' ? key === failAt : key.startsWith(failAt))) throw new Error('fixture write fault') })
    assert.notEqual((await fx.call('/_head/night-grant', body, { 'x-x6-class3-approval': token })).status, 200)
    fx.storage.inject(() => {})
    assert.deepEqual(durable(fx.storage.snapshot()), before)
    assert.equal((await fx.call('/_head/night-grant', body, { 'x-x6-class3-approval': token })).status, 200)
  })
}

for (const failAt of ['head:night-grant', 'head:night-grant:receipt:', 'head', 'head:last-publish-outcome']) {
  test(`A use that fails after writing ${failAt} rolls back the decrement, receipt and head`, async () => {
    const fx = await fixture()
    assert.equal((await fx.issue()).status, 200)
    const ball = await fx.stage(async (_next, add) => { await add('fault-organ') })
    const before = durable(fx.storage.snapshot())
    const exact = ['head:night-grant', 'head', 'head:last-publish-outcome'].includes(failAt)
    fx.storage.inject((operation, key) => { if (operation === 'put' && (exact ? key === failAt : key.startsWith(failAt))) throw new Error('fixture write fault') })
    assert.notEqual((await fx.promote(ball)).status, 200)
    fx.storage.inject(() => {})
    const after = durable(fx.storage.snapshot())
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (key.startsWith('module:') || key.startsWith('manifest:')) continue
      assert.deepEqual(after.get(key), before.get(key), key)
    }
    assert.equal((await fx.call('/_head/night-grant')).body.nightGrant.usesLeft, 12)
    assert.equal((await fx.promote(ball)).status, 200)
  })
}

test('Two simultaneous uses of the last remaining use: exactly one spends it', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue({ maxUses: 1 })).status, 200)
  const ball = await fx.stage(async (_next, add) => { await add('race-organ') })
  const [a, b] = await Promise.all([fx.promote(ball), fx.promote(ball)])
  const spent = [a, b].filter(answer => answer.body.nightGrant !== undefined)
  assert.equal(spent.length, 1)
  assert.deepEqual(spent[0].body.nightGrant, { grantId: 'grant-0123456789abcdef', use: 1, usesLeft: 0 })
  const grant = (await fx.call('/_head/night-grant')).body
  assert.equal(grant.nightGrant.usesLeft, 0)
  assert.equal(grant.receipts.filter(row => row.kind === 'use').length, 1)
  const next = await fx.stage(async (_next, add) => { await add('after-race') })
  assert.equal((await fx.promote(next)).body.code, 'NIGHT_GRANT_EXHAUSTED')
})

test('The grant route has its own throttle, which never charges the passkey lockout', async () => {
  const clock = { now: Date.now() }
  const fx = await fixture({ clock })
  const ball = await fx.stage(async (_next, add) => { await add('throttle-organ') })
  for (let i = 0; i < NIGHT_GRANT_ATTEMPTS; i++) assert.equal((await fx.promote(ball)).body.code, 'NIGHT_GRANT_MISSING')
  const throttled = await fx.promote(ball)
  assert.equal(throttled.status, 429)
  assert.equal(throttled.body.code, 'NIGHT_GRANT_THROTTLED')
  assert.equal(fx.storage.snapshot().get('gate-lockout:v1'), undefined)
  // The owner's passkey route is not throttled by it.
  assert.equal((await fx.call('/_head/promote', { ballId: ball.ballId })).body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  clock.now += NIGHT_GRANT_ATTEMPT_WINDOW_MS + 1
  assert.equal((await fx.promote(ball)).body.code, 'NIGHT_GRANT_MISSING')
})

test('An issued grant refuses an unlisted module or extra root metadata riding with an add', async () => {
  for (const [variant, code] of [['module', 'NIGHT_GRANT_UNLISTED_MODULE_REFUSED'], ['root', 'NIGHT_GRANT_ROOT_FIELD_REFUSED']]) {
    const fx = await fixture()
    assert.equal((await fx.issue()).status, 200)
    const ball = await fx.stage(async (next, add) => {
      await add('voice-slot')
      if (variant === 'module') { await add('stowaway'); delete next.entries.stowaway }
      else next.note = 'extra root metadata'
    })
    const refused = await fx.promote(ball)
    assert.equal(refused.body.code, code, variant)
    assert.equal((await fx.call('/_head/night-grant')).body.nightGrant.usesLeft, 12)
  }
})

test('A use receipt records each organ\'s size from its hash-verified bytes, never the declared one', async () => {
  const fx = await fixture()
  assert.equal((await fx.issue()).status, 200)
  const code = `export const organ = ${JSON.stringify('sized-organ')};`
  const ball = await fx.stage(async (next, add) => {
    const made = await add('sized-organ')
    const { size: _declared, ...rest } = next.modules[made.sha]
    next.modules[made.sha] = rest
  })
  assert.equal((await fx.promote(ball)).status, 200)
  const use = (await fx.call('/_head/night-grant')).body.receipts.find(row => row.kind === 'use')
  assert.equal(use.organs[0].size, Buffer.byteLength(code))
  // Probe: 30-odd bytes of code declared as 999 is refused outright, and leaves no receipt.
  const lying = await fx.stage(async (next, add) => {
    const made = await add('lying-organ')
    next.modules[made.sha] = { ...next.modules[made.sha], size: 999 }
  })
  assert.equal((await fx.promote(lying)).body.code, 'NIGHT_GRANT_MODULE_SIZE_REFUSED')
  assert.equal((await fx.call('/_head/night-grant')).body.receipts.filter(row => row.kind === 'use').length, 1)
})
