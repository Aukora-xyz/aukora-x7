/** Six J4 scripted-arm groups, not retention-suite rows. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { loadOrganUnderTest } from './fixtures/organs/pinned.mjs'
import { runInNewContext } from 'node:vm'
const source = loadOrganUnderTest('seed-pearl')
console.log('SOURCE_SHA256', createHash('sha256').update(source).digest('hex'))
const SUITE = '/dsh/home/auma/seed/pearl/retention-suite.v1.json', HEAD = '/dsh/home/balls/HEAD.json'
const hash = v => createHash('sha256').update(v).digest('hex')
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
const suiteDigest = s => hash(canonical(Object.fromEntries(['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures'].map(k => [k, s[k] ?? null]))))
function load(source) {
  const module = { exports: {} }
  runInNewContext(source, { module, Buffer, require(name) {
    if (name === 'node:crypto') return { createHash }
    if (name === 'node:fs') return { readFileSync() { throw new Error('MOUNTED_FS_MUST_NOT_BE_READ') } }
    throw new Error('Unexpected dependency: ' + name)
  } }, { timeout: 1000 })
  return module.exports
}
async function run(source, sc) {
  const incumbent = ('module.exports={name:"' + sc.organId + '",run(){return false}}').padEnd(400, ' ')
  const candidate = ('module.exports={name:"' + sc.organId + '",run(){return true}}').padEnd(400, ' ')
  const suite = { schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention', organs: [sc.organId, 'peer'], fixedNow: 1, fixtures: {},
    cases: [{ id: 'target', author: 'dot', args: { organ: sc.organId }, expect: true },
      { id: 'peer-row', author: 'dot', args: { organ: 'peer' }, expect: true }] }
  const entry = { specifier: 'ball:' + hash(incumbent), ...(sc.declared ? { config: { governance: true } } : {}) }
  const head = { ballId: 'a'.repeat(64), epoch: 1, entries: { [sc.organId]: entry } }
  const files = new Map([[SUITE, JSON.stringify(suite)], [HEAD, JSON.stringify(head)], ['/dsh/home/balls/' + hash(incumbent) + '.js', incumbent]])
  const fs = { readFileSync(file, enc) { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return enc ? files.get(file) : Buffer.from(files.get(file)) } }
  const receipts = []
  const arm = baseline => {
    const a = baseline ? sc.base : sc.cand
    return { ok: a.ok, trialOk: a.trialOk, qualifiedForPromotion: baseline ? false : a.q, qualificationId: baseline ? null : a.qid,
      organs: { [sc.organId]: hash(baseline ? incumbent : candidate) }, headBallId: head.ballId, totalCases: 2,
      suiteDigest: suiteDigest(suite), suiteBytesDigest: hash(files.get(SUITE)), suiteAdmission: sc.suiteAdmission ?? 'build-pinned',
      targetCovered: true, ...(baseline ? {} : { protectedSurface: Boolean(sc.runtimeProtected) }),
      results: [{ id: 'target', pass: a.rows.target }, { id: 'peer-row', pass: a.rows.peer }],
      graderControls: { allPassed: true, knownGoodAccepted: true, knownBadRejected: true, acceptAllRejected: true, rejectAllRejected: true },
      routeEvidence: { status: 'checked', unsupportedProperties: ['execution-containment'] } }
  }
  const ctx = { fs, scion: { async trialRetentionCandidate() { return { ...arm(false), baselineResult: arm(true), ...sc.comparison } } },
    organs: { async call(name, req) {
      assert.equal(name, 'seed-receipts')
      receipts.push(JSON.parse(JSON.stringify(req)))
      if (sc.receipt === 'throw') throw new Error('RECEIPT_ORGAN_CRASHED')
      return sc.receipt === 'refuse' ? { ok: false, error: 'SYNTHETIC_RECEIPT_REFUSAL' } : { ok: true, receipt: { seq: 7, leafHash: 'leaf' } }
    } } }
  const pearl = load(source)
  const r = JSON.parse(JSON.stringify(await pearl.run({ action: 'challenge', organId: sc.organId, candidateSource: candidate, candidateAuthor: 'auma', ...(sc.extraArgs ?? {}) }, ctx)))
  if (receipts.length !== 1) throw new Error('EXPECTED_ONE_RECEIPT_PAYLOAD')
  return { answer: r, receipts, data: receipts[0].data }
}

const win = { targetImproved: true, winnerId: 'candidate', comparisonComplete: true }
const tie = { targetImproved: false, winnerId: null, comparisonComplete: true }
const base = { ok: false, trialOk: false, rows: { target: false, peer: true } }
const good = { ok: true, trialOk: true, q: true, qid: 'q1', rows: { target: true, peer: true } }
const scenario = overrides => ({ organId: 'auma-eyes', base, cand: good, comparison: win, ...overrides })
function noReceiptId(out, ids) {
  assert.equal(out.receipts.length, 1)
  const rows = out.data.candidates
  assert.equal(rows.length, 2)
  for (const row of rows) assert.equal(Object.hasOwn(row, 'qualificationId'), false)
  for (const id of ids) assert.equal(JSON.stringify(out.receipts).includes(id), false)
}

test('dot J4 ordinary-id-out', async () => {
  const out = await run(source, scenario({ base: { ...base, rows: { target: false, peer: false } },
    cand: { ...good, trialOk: false, rows: { target: true, peer: false } } }))
  const r = out.answer
  assert.equal(r.ok, true)
  assert.equal(r.qualifiedForPromotion, true)
  assert.equal(r.qualificationId, 'q1')
  assert.equal(r.passkeyPromotionEligible, false)
  assert.equal(r.standingGrantEligible, false)
  assert.equal(r.trialOk, false)
  assert.equal(r.results.candidate.total, 2)
  assert.equal(r.results.candidate.passed, 1)
  assert.deepEqual(r.failures.candidate, ['peer-row'])
  assert.equal(out.data.qualifiedForPromotion, true)
  noReceiptId(out, ['q1'])
})

test('dot J4 protected-passkey-only', async t => {
  for (const target of [{ organId: 'seed-pearl', runtimeProtected: false },
    { organId: 'ordinary-runtime-protected', runtimeProtected: true },
    { organId: 'seed-boot', runtimeProtected: true },
    { organId: 'seed-continuity', declared: true, runtimeProtected: false }]) {
    await t.test(target.organId, async () => {
      const out = await run(source, scenario({ ...target, cand: { ...good, qid: 'q2' } }))
      assert.equal(out.answer.ok, true)
      assert.equal(out.answer.qualifiedForPromotion, true)
      assert.equal(out.answer.passkeyPromotionEligible, true)
      assert.equal(out.answer.standingGrantEligible, false)
      assert.equal(out.answer.qualificationId, null)
      noReceiptId(out, ['q2'])
    })
  }
})

test('dot J4 trial-ok-carried', async t => {
  await t.test('partial rows remain trialOk false when judge refuses', async () => {
    const out = await run(source, scenario({ comparison: tie,
      base: { ...base, rows: { target: true, peer: false } },
      cand: { ...good, q: false, trialOk: false, rows: { target: true, peer: false } } }))
    assert.equal(out.answer.trialOk, false)
    assert.equal(out.answer.qualifiedForPromotion, false)
    assert.equal(out.answer.qualificationId, null)
    noReceiptId(out, ['q1'])
  })
  await t.test('all green tie preserves runtime trialOk on both arms', async () => {
    const out = await run(source, scenario({ comparison: tie, base: { ...good }, cand: { ...good, q: false } }))
    assert.equal(out.answer.trialOk, true)
    assert.equal(out.answer.results.baseline.trialOk, true)
    assert.equal(out.answer.results.candidate.trialOk, true)
    assert.equal(out.answer.qualifiedForPromotion, false)
    assert.equal(out.answer.qualificationId, null)
    noReceiptId(out, ['q1'])
  })
})

test('dot J4 refused-id-null', async t => {
  for (const extraArgs of [{}, { qualificationId: 'q-forged', qualifiedForPromotion: true, approved: true,
    passkeyPromotionEligible: true, standingGrantEligible: true }]) {
    await t.test(Object.keys(extraArgs).length ? 'caller flags cannot authorize' : 'stale arm id', async () => {
      const out = await run(source, scenario({ cand: { ...good, q: false, qid: 'q-stale' }, extraArgs }))
      assert.equal(out.answer.qualifiedForPromotion, false)
      assert.equal(out.answer.qualificationId, null)
      noReceiptId(out, ['q-stale', 'q-forged'])
    })
  }
})

test('dot J4 failed-receipt', async t => {
  for (const receipt of ['refuse', 'throw']) await t.test(receipt, async () => {
    const out = await run(source, scenario({ receipt }))
    assert.equal(out.answer.ok, false)
    assert.equal(out.answer.qualifiedForPromotion, false)
    assert.equal(out.answer.qualificationId, null)
    noReceiptId(out, ['q1'])
  })
})

test('dot J4 unpinned-suite', async () => {
  const out = await run(source, scenario({ suiteAdmission: 'unverified' }))
  assert.equal(out.answer.results.candidate.qualifiedForPromotion, false)
  assert.equal(out.answer.qualifiedForPromotion, false)
  assert.equal(out.answer.qualificationId, null)
  noReceiptId(out, ['q1'])
})
