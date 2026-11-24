/** The owner mandate in HEAD. One passkey on the exact terms; a closed scope set; per-day bounds with hard
 * ceilings; every use decided and written in one transaction (one receipt and one count, or nothing); revoke without a
 * passkey; status with nothing secret. Nothing consumes a mandate yet: these tests call HEAD's store directly. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { aumlokClass3Binding } from '../aumlok.mjs'
import {
  OWNER_MANDATE_CEILINGS, OWNER_MANDATE_DEFAULT_PER_DAY, OWNER_MANDATE_KINDS, OWNER_MANDATE_MAX_LIFETIME_MS, OWNER_MANDATE_SCHEMA, OWNER_MANDATE_SCOPES,
  OWNER_MANDATE_KIND_SCOPE, normalizeOwnerMandateTerms, ownerMandateCovers, ownerMandateNextDay, ownerMandatePlainWords,
} from '../owner-mandate.mjs'

const ORIGIN = 'https://mandate.example.invalid'
const OWNER = 'owner@example.invalid'
const ROUTE = '/_head/mandate'
const DAY = 24 * 60 * 60 * 1000
const SHA = 'ab'.repeat(32)

function storageFixture() {
  let data = new Map(), tail = Promise.resolve(), fault = () => {}
  const view = (map, transactional = false) => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); if (transactional) await fault('put', key, value) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity, reverse = false } = {}) => {
      const rows = [...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      if (reverse) rows.reverse()
      return new Map(rows.slice(0, limit).map(([key, value]) => [key, structuredClone(value)]))
    },
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

const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32) }

async function fixture({ start = Date.UTC(2026, 10, 14, 12, 0, 0) } = {}) {
  const storage = storageFixture()
  const clock = { now: start }
  const make = () => {
    const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('External network forbidden') }, now: () => clock.now })
    head.aumlokStore = approvalStore
    return head
  }
  // AS AUMLOK DOES: an approval is minted for ONE exact binding and is spent once, inside the caller's transaction.
  const approvals = [], minted = new Map()
  let mints = 0
  const approvalStore = { consumeApprovalInTransaction: async (tx, token, binding) => {
    const refuse = () => { throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }) }
    if (!minted.has(token) || minted.get(token) !== canonicalJson(binding)) refuse()
    if (await tx.get(`fixture:spent:${token}`) !== undefined) refuse()
    await tx.put(`fixture:spent:${token}`, binding)
    approvals.push(binding)
    return { ok: true, binding, expiresAt: Date.now() + 60000 }
  } }
  let head = make()
  const code = 'export const organ = "ordinary-a";', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', epoch: 169, parentBallId: null, authorPeerId: 'fixture-writer',
    entries: { 'ordinary-a': { id: 'ordinary-a', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: code.length } } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const mint = binding => { const token = `fixture-approval-${String(++mints)}`; minted.set(token, canonicalJson(binding)); return token }
  const tokenFor = async body => mint(await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: ROUTE, body }))
  const ownerAccess = () => JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 })
  const call = async (body, extra = {}, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': ownerAccess(), ...extra })
    const response = await head.fetch(new Request(ORIGIN + ROUTE, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  let ids = 0
  const terms = (overrides = {}) => ({ schema: OWNER_MANDATE_SCHEMA, id: `mandate-${String(++ids).padStart(16, '0')}`, principal: 'owner', agent: 'auma',
    scopes: [...OWNER_MANDATE_SCOPES], perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY }, issuedAt: clock.now, expiresAt: clock.now + 7 * DAY,
    nonce: 'nonce-0123456789abcdef', ...overrides })
  const issueAnswer = async (overrides, headers) => {
    const body = { action: 'issue', terms: terms(overrides) }
    const answer = await call(body, headers ?? { 'x-x6-class3-approval': await tokenFor(body) })
    return { ...answer, sent: body }
  }
  const mandateKeys = () => [...storage.snapshot().keys()].filter(key => key.startsWith('head:owner-mandate')).sort()
  return { storage, clock, get head() { return head }, renew: () => { head = make(); return head }, call, terms, issueAnswer, tokenFor, approvals, mandateKeys }
}

const use = (f, input) => f.head.store.useOwnerMandate({ scope: 'repo.write.branch', kind: 'commits', units: 1, actionSha256: SHA, ...input })

test('issue without a passkey approval is refused and writes nothing', async () => {
  const f = await fixture()
  const answer = await f.issueAnswer({}, {})
  assert.equal(answer.status, 403); assert.equal(answer.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(f.mandateKeys(), [])
  assert.deepEqual((await f.call()).body, { ok: true, mandate: null })
})

test('an approval for other bytes is refused (one byte of the body changed), and the approval is not spent', async () => {
  const f = await fixture()
  const body = { action: 'issue', terms: f.terms() }
  const token = await f.tokenFor(body)
  const changed = structuredClone(body)
  changed.terms.nonce = changed.terms.nonce.slice(0, -1) + 'g'
  assert.equal(canonicalJson(changed).length, canonicalJson(body).length)
  const refused = await f.call(changed, { 'x-x6-class3-approval': token })
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(f.mandateKeys(), [])
  assert.equal(f.approvals.length, 0)
  // The approval for the exact bytes still works once.
  assert.equal((await f.call(body, { 'x-x6-class3-approval': token })).status, 200)
})

test('the same approval used twice is refused; the record and its one issue receipt stand', async () => {
  const f = await fixture()
  const body = { action: 'issue', terms: f.terms() }
  const token = await f.tokenFor(body)
  const first = await f.call(body, { 'x-x6-class3-approval': token })
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.mandate.state, 'active')
  const before = f.storage.snapshot()
  const again = await f.call(body, { 'x-x6-class3-approval': token })
  assert.equal(again.body.ok, false); assert.ok([403, 409].includes(again.status))
  assert.deepEqual(f.storage.snapshot(), before)
  assert.equal(f.approvals.length, 1)
  // A fresh body (new id) carrying the spent approval is refused by the binding and the spend both.
  const other = { action: 'issue', terms: f.terms() }
  const reused = await f.call(other, { 'x-x6-class3-approval': token })
  assert.equal(reused.status, 403); assert.equal(reused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(f.storage.snapshot(), before)
})

test('terms are closed: an unknown scope, a bound over its ceiling, more than 30 days, and extra fields are refused before any approval is spent', async () => {
  const f = await fixture()
  for (const scope of ['merge', 'deploy', 'secrets', 'repo.delete', 'domains', 'passkeys', 'head.promote', 'REPO.READ', '']) {
    const answer = await f.issueAnswer({ scopes: ['repo.read', scope] })
    assert.equal(answer.status, 403, scope); assert.equal(answer.body.code, 'MANDATE_SCOPE_UNKNOWN', scope)
  }
  for (const kind of OWNER_MANDATE_KINDS) {
    const answer = await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, [kind]: OWNER_MANDATE_CEILINGS[kind] + 1 } })
    assert.equal(answer.status, 403, kind); assert.equal(answer.body.code, 'MANDATE_BOUND_REFUSED', kind)
    const atCeiling = normalizeOwnerMandateTerms(f.terms({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, [kind]: OWNER_MANDATE_CEILINGS[kind] } }), { now: f.clock.now })
    assert.equal(atCeiling.perDay[kind], OWNER_MANDATE_CEILINGS[kind])
  }
  const long = await f.issueAnswer({ expiresAt: f.clock.now + OWNER_MANDATE_MAX_LIFETIME_MS + 1 })
  assert.equal(long.status, 403); assert.equal(long.body.code, 'MANDATE_LIFETIME_REFUSED')
  assert.equal((await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, merges: 1 } })).body.code, 'MANDATE_TERMS_INVALID')
  assert.equal((await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, commits: 1.5 } })).body.code, 'MANDATE_TERMS_INVALID')
  assert.equal((await f.issueAnswer({ scopes: ['repo.read', 'repo.read'] })).body.code, 'MANDATE_TERMS_INVALID')
  assert.equal((await f.issueAnswer({ agent: 'someone' })).body.code, 'MANDATE_TERMS_INVALID')
  assert.equal((await f.issueAnswer({ extra: 1 })).body.code, 'MANDATE_TERMS_INVALID')
  assert.equal((await f.issueAnswer({ expiresAt: f.clock.now - 1 })).body.code, 'MANDATE_EXPIRED')
  assert.equal((await f.issueAnswer({ issuedAt: f.clock.now - DAY })).body.code, 'MANDATE_ISSUED_AT_REFUSED')
  assert.equal(f.approvals.length, 0)
  assert.deepEqual(f.mandateKeys(), [])
  // Exactly 30 days is allowed.
  assert.equal((await f.issueAnswer({ expiresAt: f.clock.now + OWNER_MANDATE_MAX_LIFETIME_MS })).status, 200)
})

test('useMandate refuses with no mandate, expired, revoked, a scope not granted and the bound + 1, each by its code, writing NOTHING', async () => {
  const f = await fixture()
  let before = f.storage.snapshot()
  assert.deepEqual(await use(f), { ok: false, code: 'MANDATE_REQUIRED', status: 403 })
  assert.deepEqual(f.storage.snapshot(), before)

  assert.equal((await f.issueAnswer({ scopes: ['repo.read', 'repo.write.branch'], perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, commits: 2 } })).status, 200)
  before = f.storage.snapshot()
  for (const input of [{ scope: 'exec.run', kind: 'execRuns' }, { scope: 'repo.write.branch', kind: 'execRuns' }, { scope: 'merge', kind: 'commits' },
    { scope: 'repo.read', kind: 'commits' }, { scope: 'repo.write.branch', kind: 'merges' }]) {
    assert.equal((await use(f, input)).code, 'MANDATE_OUT_OF_SCOPE', JSON.stringify(input))
  }
  assert.equal((await use(f, { units: 0 })).code, 'MANDATE_USE_INVALID')
  assert.equal((await use(f, { actionSha256: 'not-a-sha' })).code, 'MANDATE_USE_INVALID')
  assert.deepEqual(f.storage.snapshot(), before)

  assert.equal((await use(f)).ok, true)
  assert.equal((await use(f)).ok, true)
  before = f.storage.snapshot()
  const reached = await use(f)
  assert.deepEqual(reached, { ok: false, code: 'MANDATE_BOUND_REACHED', status: 429, kind: 'commits', retryAt: ownerMandateNextDay(f.clock.now) })
  assert.deepEqual(f.storage.snapshot(), before)

  f.clock.now += 7 * DAY
  before = f.storage.snapshot()
  assert.equal((await use(f)).code, 'MANDATE_EXPIRED')
  assert.deepEqual(f.storage.snapshot(), before)

  f.clock.now -= 7 * DAY - 60_000
  const id = (await f.call()).body.mandate.terms.id
  assert.equal((await f.call({ action: 'revoke', id })).status, 200)
  before = f.storage.snapshot()
  assert.equal((await use(f)).code, 'MANDATE_REVOKED')
  assert.deepEqual(f.storage.snapshot(), before)
})

test('a use writes exactly one receipt and one count in one transaction; a failing write leaves neither', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer()).status, 200)
  const before = new Set(f.storage.snapshot().keys())
  const used = await use(f, { scope: 'exec.run', kind: 'execMinutes', units: 30 })
  assert.equal(used.ok, true)
  const added = [...f.storage.snapshot().keys()].filter(key => !before.has(key)).sort()
  assert.equal(added.length, 2, JSON.stringify(added))
  assert.match(added[0], /^head:owner-mandate:count:mandate-0+1:2026-11-14$/)
  assert.match(added[1], /^head:owner-mandate:use:mandate-0+1:2026-11-14:0001$/)
  assert.deepEqual(f.storage.snapshot().get(added[1]), used.receipt)
  assert.equal(f.storage.snapshot().get(added[0]).execMinutes, 30)

  // The count write fails after the receipt landed in the transaction: neither survives.
  const snapshot = f.storage.snapshot()
  f.storage.inject((op, key) => { if (key.includes(':count:')) throw new Error('disk full') })
  await assert.rejects(use(f), /disk full/)
  f.storage.inject(() => {})
  assert.deepEqual(f.storage.snapshot(), snapshot)
  // And the receipt write failing leaves the count as it was.
  f.storage.inject((op, key) => { if (key.includes(':use:')) throw new Error('disk full') })
  await assert.rejects(use(f), /disk full/)
  f.storage.inject(() => {})
  assert.deepEqual(f.storage.snapshot(), snapshot)
})

test('counts survive a new HEAD instance over the same storage; the day rolls over at UTC midnight', async () => {
  const f = await fixture({ start: Date.UTC(2026, 10, 14, 23, 50, 0) })
  assert.equal((await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, branchCreates: 2 } })).status, 200)
  const branch = { scope: 'repo.write.branch', kind: 'branchCreates' }
  assert.equal((await use(f, branch)).ok, true)
  f.renew()
  assert.equal((await use(f, branch)).ok, true)
  f.renew()
  f.clock.now = Date.UTC(2026, 10, 14, 23, 59, 59, 999)
  const reached = await use(f, branch)
  assert.equal(reached.code, 'MANDATE_BOUND_REACHED'); assert.equal(reached.retryAt, Date.UTC(2026, 10, 15))
  f.clock.now = Date.UTC(2026, 10, 15)
  const next = await use(f, branch)
  assert.equal(next.ok, true); assert.equal(next.receipt.day, '2026-11-15'); assert.equal(next.receipt.seq, 1)
  const status = (await f.call()).body
  assert.equal(status.today.day, '2026-11-15'); assert.equal(status.today.branchCreates, 1)
})

test('revoke needs no passkey and a revoked mandate refuses at once; a new issue replaces the old only with its own approval', async () => {
  const f = await fixture()
  const first = await f.issueAnswer()
  assert.equal(first.status, 200)
  const id = first.body.mandate.terms.id
  // A second issue without an approval leaves the first standing.
  const unapproved = await f.issueAnswer({}, {})
  assert.equal(unapproved.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await f.call()).body.mandate.terms.id, id)
  // With its own approval it replaces the first, and says so.
  const second = await f.issueAnswer()
  assert.equal(second.status, 200); assert.equal(second.body.mandate.replaces, id)
  assert.ok(f.storage.snapshot().has(`head:owner-mandate:receipt:${id}:replaced`))
  const secondId = second.body.mandate.terms.id
  assert.equal((await use(f)).ok, true)
  const approvalsBefore = f.approvals.length
  const revoked = await f.call({ action: 'revoke', id: secondId })
  assert.equal(revoked.status, 200); assert.equal(revoked.body.mandate.state, 'revoked')
  assert.equal(f.approvals.length, approvalsBefore)
  assert.equal((await use(f)).code, 'MANDATE_REVOKED')
  assert.equal((await f.call({ action: 'revoke', id: secondId })).body.idempotent, true)
  assert.equal((await f.call({ action: 'revoke', id: 'mandate-unknown-000000' })).body.code, 'MANDATE_REQUIRED')
  assert.equal((await f.call()).body.mandate.state, 'revoked')
})

test('status: the record, today\'s counts and the newest 20 receipts, and never a secret-shaped value', async () => {
  const f = await fixture()
  const body = { action: 'issue', terms: f.terms() }
  const token = await f.tokenFor(body)
  assert.equal((await f.call(body, { 'x-x6-class3-approval': token })).status, 200)
  for (let index = 0; index < 23; index++) assert.equal((await use(f, { actionSha256: (index % 10).toString(16).repeat(64) })).ok, true)
  const answer = await f.call()
  assert.equal(answer.status, 200)
  const { mandate, today, receipts } = answer.body
  assert.equal(mandate.state, 'active')
  assert.deepEqual(mandate.plainWords, [...ownerMandatePlainWords(mandate.terms)])
  assert.equal(today.commits, 23)
  assert.equal(receipts.length, 20)
  assert.deepEqual(receipts.map(row => row.seq), Array.from({ length: 20 }, (_, index) => 23 - index))
  const text = JSON.stringify(answer.body)
  assert.equal(text.includes(token), false)
  assert.doesNotMatch(text, /Bearer|sk-[A-Za-z0-9]|ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}/)
  const keys = []
  const walk = value => { if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner) } }
  walk(answer.body)
  assert.deepEqual(keys.filter(key => /secret|password|token|cookie|authorization|credential|apikey|bearer|session/i.test(key)), [])
})

test('HEAD re-checks the owner: another identity, another email, a stale session or none reach no storage', async () => {
  const f = await fixture()
  const before = f.storage.snapshot()
  for (const access of [{ type: 'access', email: OWNER, expires: Date.now() / 1000 + 3600 }, { type: 'owner', email: 'other@example.invalid', expires: Date.now() / 1000 + 3600 },
    { type: 'owner', email: OWNER, expires: Date.now() / 1000 - 1 }, null]) {
    for (const body of [undefined, { action: 'revoke', id: 'mandate-0000000000000001' }, { action: 'issue', terms: f.terms() }]) {
      const answer = await f.call(body, { 'x-x6-verified-access': JSON.stringify(access) })
      assert.equal(answer.status, 403, JSON.stringify(access)); assert.equal(answer.body.code, 'OWNER_ACCESS_REQUIRED')
    }
  }
  assert.deepEqual(f.storage.snapshot(), before)
})

test('the plain words carry the terms: the day bounds, the date and what never happens without his fingerprint', () => {
  const now = Date.UTC(2026, 10, 14)
  const words = ownerMandatePlainWords(normalizeOwnerMandateTerms({ schema: OWNER_MANDATE_SCHEMA, id: 'mandate-0123456789abcdef', principal: 'owner', agent: 'auma',
    scopes: [...OWNER_MANDATE_SCOPES], perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY }, issuedAt: now, expiresAt: now + 7 * DAY, nonce: 'nonce-0123456789abcdef' }, { now }))
  assert.equal(words[0], 'Let Auma work while I am away.')
  assert.equal(words[1], 'Until 2026-11-21 00:00 UTC.')
  assert.match(words[3], /^Each day at most: 24 commits on her own branches, 8 new branches, 24 runner jobs \(240 minutes\), 12 proposal cards, 24 comments/)
  assert.equal(words[4], 'Never without my fingerprint: merge, deploy, keys, deletes.')
  assert.doesNotMatch(words.join(' '), /token/i)
})

test('the read-only cover check never stands in for a use: a counted scope answers MANDATE_USE_REQUIRED and writes nothing', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer()).status, 200)
  const counted = [...new Set(Object.values(OWNER_MANDATE_KIND_SCOPE))].sort()
  assert.deepEqual(counted, ['exec.run', 'linear.comment', 'proposal.stage', 'relay.post', 'repo.write.branch'])
  const before = f.storage.snapshot()
  for (const scope of counted) {
    assert.deepEqual(await f.head.store.checkOwnerMandate({ scope }), { ok: false, code: 'MANDATE_USE_REQUIRED', status: 409 }, scope)
  }
  assert.deepEqual(f.storage.snapshot(), before)
  assert.deepEqual((await f.call()).body.today.commits, 0)
  // Only the scopes with no counted kind are covered by the check.
  for (const scope of ['repo.read', 'model.call']) assert.equal((await f.head.store.checkOwnerMandate({ scope })).ok, true, scope)
  // The pure check says the same, even with no record at all (a counted scope is never a cover question).
  assert.equal(ownerMandateCovers({ record: undefined, scope: 'exec.run', now: f.clock.now }).code, 'MANDATE_USE_REQUIRED')
  assert.equal(ownerMandateCovers({ record: undefined, scope: 'repo.read', now: f.clock.now }).code, 'MANDATE_REQUIRED')
})

const job = (f, input) => f.head.store.useOwnerMandateExecJob({ minutes: 30, actionSha256: SHA, ...input })

test('a runner job is ONE use: both bounds checked, both counts and one receipt written in one transaction', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer()).status, 200)
  const before = new Set(f.storage.snapshot().keys())
  const used = await job(f)
  assert.equal(used.ok, true)
  const added = [...f.storage.snapshot().keys()].filter(key => !before.has(key)).sort()
  assert.equal(added.length, 2, JSON.stringify(added))
  assert.match(added[0], /^head:owner-mandate:count:mandate-0+1:2026-11-14$/)
  assert.match(added[1], /^head:owner-mandate:use:mandate-0+1:2026-11-14:0001$/)
  const count = f.storage.snapshot().get(added[0])
  assert.equal(count.execRuns, 1); assert.equal(count.execMinutes, 30); assert.equal(count.seq, 1)
  assert.deepEqual(f.storage.snapshot().get(added[1]), used.receipt)
  assert.equal(used.receipt.scope, 'exec.run'); assert.equal(used.receipt.use, 'execJob')
  assert.deepEqual(used.receipt.units, { execRuns: 1, execMinutes: 30 })
  // Malformed minutes or hash: refused, nothing written.
  const snapshot = f.storage.snapshot()
  for (const input of [{ minutes: 0 }, { minutes: 601 }, { minutes: 1.5 }, { actionSha256: 'nope' }]) assert.equal((await job(f, input)).code, 'MANDATE_USE_INVALID', JSON.stringify(input))
  assert.deepEqual(f.storage.snapshot(), snapshot)
})

test('a runner job at the runs bound is refused whole: neither count moves and no receipt is written', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, execRuns: 1 } })).status, 200)
  assert.equal((await job(f)).ok, true)
  const before = f.storage.snapshot()
  assert.deepEqual(await job(f), { ok: false, code: 'MANDATE_BOUND_REACHED', status: 429, kind: 'execRuns', retryAt: ownerMandateNextDay(f.clock.now) })
  assert.deepEqual(f.storage.snapshot(), before)
})

test('a runner job at the minutes bound is refused whole: the run is not spent either', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer({ perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY, execMinutes: 40 } })).status, 200)
  assert.equal((await job(f)).ok, true)
  const before = f.storage.snapshot()
  assert.deepEqual(await job(f), { ok: false, code: 'MANDATE_BOUND_REACHED', status: 429, kind: 'execMinutes', retryAt: ownerMandateNextDay(f.clock.now) })
  assert.deepEqual(f.storage.snapshot(), before)
  const today = (await f.call()).body.today
  assert.equal(today.execRuns, 1); assert.equal(today.execMinutes, 30)
  // A mandate without exec.run refuses the job as out of scope.
  assert.equal((await f.issueAnswer({ scopes: ['repo.read'] })).status, 200)
  assert.equal((await job(f)).code, 'MANDATE_OUT_OF_SCOPE')
})

test('a runner job whose write fails leaves neither count nor receipt', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer()).status, 200)
  const snapshot = f.storage.snapshot()
  f.storage.inject((op, key) => { if (key.includes(':count:')) throw new Error('disk full') })
  await assert.rejects(job(f), /disk full/)
  f.storage.inject(() => {})
  assert.deepEqual(f.storage.snapshot(), snapshot)
  f.storage.inject((op, key) => { if (key.includes(':use:')) throw new Error('disk full') })
  await assert.rejects(job(f), /disk full/)
  f.storage.inject(() => {})
  assert.deepEqual(f.storage.snapshot(), snapshot)
  assert.equal((await job(f)).ok, true)
})

test('a malformed stored day-count row refuses every use with MANDATE_STATE_INVALID (503) and writes nothing; never counted from zero', async () => {
  const f = await fixture()
  assert.equal((await f.issueAnswer()).status, 200)
  assert.equal((await use(f)).ok, true)
  const key = f.mandateKeys().find(name => name.includes(':count:'))
  await f.storage.transaction(async tx => { await tx.put(key, { ...(await tx.get(key)), commits: -1 }) })
  const before = f.storage.snapshot()
  assert.deepEqual(await use(f), { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  assert.deepEqual(await job(f), { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  assert.deepEqual(f.storage.snapshot(), before)
})
