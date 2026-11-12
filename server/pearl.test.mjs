/** Source-only Pearl regressions: pinned organ fixture (server/fixtures/organs; the final structural test only loads the live organ's shape), synthetic VFS and explicitly mocked parent comparisons. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadOrganUnderTest } from './fixtures/organs/pinned.mjs'
import { assertLiveOrganShape } from './fixtures/organs/live-shape.mjs'

const SOURCE = loadOrganUnderTest('seed-pearl')
const SUITE = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const HEAD = '/dsh/home/balls/HEAD.json'
const GRANT = '/dsh/home/auma/seed/owner-grant.v1.json'
const hash = value => createHash('sha256').update(value).digest('hex')
const sourcePath = source => '/dsh/home/balls/' + hash(source) + '.js'
const ioError = code => Object.assign(new Error(code), { code })
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const suiteDigest = suite => hash(canonical(Object.fromEntries(['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures'].map(key => [key, suite[key] ?? null]))))

function fixture({ organId = 'seed-pearl', source = SOURCE, contextualFs = true } = {}) {
  const incumbent = 'module.exports={run(){return false}}'.padEnd(1000, ' ')
  const candidate = 'module.exports={run(){return true}}'.padEnd(1000, ' ')
  const suite = { schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention', organs: [organId, 'peer'], fixedNow: 1,
    cases: [{ id: 'target', author: 'case-author', args: { organ: organId }, expect: true },
      { id: 'retained-peer', author: 'candidate-author', args: { organ: 'peer' }, expectError: 'REFUSED' }], fixtures: {} }
  const head = { ballId: 'a'.repeat(64), epoch: 1, entries: { [organId]: { specifier: 'ball:' + hash(incumbent) } } }
  const files = new Map([[SUITE, JSON.stringify(suite)], [HEAD, JSON.stringify(head)], [sourcePath(incumbent), incumbent]])
  const errors = new Map(), reads = [], trialRequests = [], receipts = []
  const fs = { readFileSync(file, encoding) {
    reads.push(file)
    if (errors.has(file)) throw ioError(errors.get(file))
    if (!files.has(file)) throw ioError('ENOENT')
    return encoding ? String(files.get(file)) : Buffer.from(files.get(file))
  } }
  const module = { exports: {} }
  runInNewContext(source, { module, Buffer, require(name) {
    if (name === 'node:crypto') return { createHash }
    if (name === 'node:fs') return contextualFs ? { readFileSync() { throw new Error('MOUNTED_FS_MUST_NOT_BE_READ') } } : fs
    throw new Error('Unexpected dependency: ' + name)
  } }, { timeout: 1000 })
  const f = { files, errors, reads, trialRequests, receipts, suite, head, organId, incumbent, candidate,
    baselinePasses: false, candidatePasses: true, comparisonComplete: true, trialOk: true,
    receiptOk: true, duringTrial: () => {}, alterComparison: comparison => comparison }
  const ctx = { ...(contextualFs ? { fs } : {}), scion: { async trialRetentionCandidate(request) {
    trialRequests.push(request)
    const retained = JSON.parse(files.get(SUITE))
    const selected = JSON.parse(files.get(HEAD))
    const candidateSource = request.candidateSource ?? (request.candidateSpecifier ? files.get('/dsh/home/balls/' + request.candidateSpecifier.slice(5) + '.js') : incumbent)
    const arm = baseline => ({ ok: f.trialOk, qualifiedForPromotion: !baseline, qualificationId: 'unchecked-runtime-token',
      organs: { [organId]: hash(baseline ? incumbent : candidateSource) }, headBallId: selected.ballId,
      totalCases: retained.cases.length,
      suiteDigest: suiteDigest(retained), suiteBytesDigest: hash(files.get(SUITE)), suiteAdmission: 'build-pinned',
      targetCovered: true, protectedSurface: organId === 'seed-pearl',
      results: retained.cases.map(item => ({ id: item.id, pass: item.args.organ !== organId || (baseline ? f.baselinePasses : f.candidatePasses) })),
      graderControls: { allPassed: true, knownGoodAccepted: true, knownBadRejected: true, acceptAllRejected: true, rejectAllRejected: true },
      routeEvidence: { status: 'checked', unsupportedProperties: ['execution-containment'] } })
    const comparison = f.alterComparison({ ...arm(false), baselineResult: arm(true), comparisonComplete: f.comparisonComplete,
      targetImproved: !f.baselinePasses && f.candidatePasses, winnerId: f.baselinePasses === f.candidatePasses ? null : f.candidatePasses ? 'candidate' : 'baseline' })
    f.duringTrial()
    return comparison
  } }, organs: { async call(name, request) {
    assert.equal(name, 'seed-receipts')
    receipts.push(request)
    return f.receiptOk ? { ok: true, receipt: { seq: 1, leafHash: 'synthetic-only' } } : { ok: false, error: 'SYNTHETIC_RECEIPT_REFUSAL' }
  } } }
  f.ctx = ctx
  f.run = async (overrides = {}) => JSON.parse(JSON.stringify(await module.exports.run({ action: 'challenge', organId,
    candidateSource: candidate, candidateAuthor: 'candidate-author', ...overrides }, ctx)))
  f.updateSuite = transform => files.set(SUITE, JSON.stringify(transform(JSON.parse(files.get(SUITE)))))
  return f
}

function assertRefused(result, error) {
  assert.equal(result.ok, false)
  assert.equal(result.error, error)
  assert.equal(result.qualifiedForPromotion, false)
  assert.equal(result.qualificationId, null)
  assert.equal(result.standingGrantEligible, false)
  assert.equal(result.passkeyPromotionEligible, false)
  assert.equal(result.authorityVerified, false)
}

test('missing grants allow only protected behavioral review, without approval or a token', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.qualifiedForPromotion, true)
  assert.equal(result.passkeyPromotionEligible, true)
  assert.equal(result.standingGrantEligible, false)
  assert.equal(result.authorityVerified, false)
  assert.equal(result.qualificationId, null)
  assert.equal(result.ceilingError, 'NO_GRANT_PRESENT')
  assert.equal(result.eligibilityScope, 'review-only-host-authorization-required')
  assert.equal(f.receipts[0].data.isolationProved, false)
  assert.equal(f.receipts[0].data.authorityTier, 'self-attested')
  assert.equal(f.receipts[0].data.passkeyPromotionEligible, true)
  assert.ok(!JSON.stringify(f.receipts).includes('unchecked-runtime-token'))
  assert.deepEqual(Object.keys(f.trialRequests[0]).sort(), ['candidateSource', 'organId'])
  assert.ok(f.reads.includes(sourcePath(f.incumbent)))
  assert.ok(f.reads.includes(GRANT))
  assert.equal(result.results.candidate.total, 2)
})

for (const scenario of [
  { name: 'candidate win', baselinePasses: false, candidatePasses: true, comparisonComplete: true, winnerId: 'candidate', decidedBy: 'retention-passes', eligible: true },
  { name: 'baseline win', baselinePasses: true, candidatePasses: false, comparisonComplete: true, winnerId: 'baseline', decidedBy: 'baseline-retained', eligible: false },
  { name: 'passing tie', baselinePasses: true, candidatePasses: true, comparisonComplete: true, winnerId: null, decidedBy: 'inconclusive', eligible: false },
  { name: 'failing tie', baselinePasses: false, candidatePasses: false, comparisonComplete: true, winnerId: null, decidedBy: 'inconclusive', eligible: false },
  { name: 'incomplete candidate lead', baselinePasses: false, candidatePasses: true, comparisonComplete: false, winnerId: null, decidedBy: 'inconclusive', eligible: false },
  { name: 'incomplete baseline lead', baselinePasses: true, candidatePasses: false, comparisonComplete: false, winnerId: null, decidedBy: 'inconclusive', eligible: false },
]) {
  test('challenge and receipt report the retention verdict without changing authority: ' + scenario.name, async () => {
    const f = fixture()
    f.baselinePasses = scenario.baselinePasses
    f.candidatePasses = scenario.candidatePasses
    f.comparisonComplete = scenario.comparisonComplete
    const before = [...f.files]
    const result = await f.run()
    assert.equal(result.ok, true)
    assert.equal(f.receipts.length, 1)
    assert.equal(f.receipts[0].action, 'append')
    assert.equal(f.receipts[0].kind, 'pearl.challenge')
    const data = JSON.parse(JSON.stringify(f.receipts[0].data))
    for (const report of [result, data]) {
      assert.equal(report.winnerId, scenario.winnerId)
      assert.equal(report.winner, scenario.winnerId)
      assert.equal(report.decidedBy, scenario.decidedBy)
      assert.equal(report.candidateId, 'candidate')
      assert.equal(report.qualifiedForPromotion, scenario.eligible)
      assert.equal(report.passkeyPromotionEligible, scenario.eligible)
      assert.equal(report.standingGrantEligible, false)
      assert.equal(report.authorityVerified, false)
      assert.equal(report.eligibilityScope, 'review-only-host-authorization-required')
      assert.equal(report.results.candidate.passed, scenario.candidatePasses ? 2 : 1)
      assert.equal(report.results.baseline.passed, scenario.baselinePasses ? 2 : 1)
      assert.equal(report.results.candidate.total, 2)
      assert.equal(report.results.baseline.total, 2)
      assert.equal(report.suiteDigest, suiteDigest(f.suite))
      assert.equal(report.suiteBytesDigest, hash(f.files.get(SUITE)))
    }
    assert.equal(data.winnerLabel, scenario.winnerId)
    assert.equal(data.authorityTier, 'self-attested')
    assert.equal(data.isolationProved, false)
    assert.equal(data.admissionScope, 'behavioral-retention-only')
    assert.equal(result.qualificationId, null)
    assert.ok(!JSON.stringify(data).includes('unchecked-runtime-token'))
    assert.deepEqual(result.receipt, { seq: 1, leafHash: 'synthetic-only' })
    assert.deepEqual([...f.files], before)
  })
}

test('a named non-governance candidate cannot use absent grant as unattended or passkey admission', async () => {
  const f = fixture({ organId: 'seed-ordinary' })
  const result = await f.run({ passkeyPromotionEligible: true, standingGrantEligible: true, approved: true })
  assert.equal(result.ok, true)
  assert.equal(result.winnerId, 'candidate')
  assert.equal(result.qualifiedForPromotion, false)
  assert.equal(result.passkeyPromotionEligible, false)
  assert.equal(result.standingGrantEligible, false)
  assert.equal(result.qualificationId, null)
})

for (const declaration of [{ governance: true }, { config: { governance: true } }, { governance: 'malformed' }]) {
  test('selected declarative governance remains passkey-review-only: ' + JSON.stringify(declaration), async () => {
    const f = fixture({ organId: 'seed-declared' })
    f.files.set(HEAD, JSON.stringify({ ...f.head, entries: { [f.organId]: { ...f.head.entries[f.organId], ...declaration } } }))
    const result = await f.run()
    assert.equal(result.passkeyPromotionEligible, true)
    assert.equal(result.qualificationId, null)
    assert.equal(result.authorityVerified, false)
  })
}

for (const bytes of [1100, 1101, 1150, 1151]) {
  test('unjustified growth uses the conservative 10% byte boundary: ' + bytes, async () => {
    const f = fixture()
    const result = await f.run({ candidateSource: f.candidate.padEnd(bytes, ' ') })
    if (bytes === 1100) assert.equal(result.passkeyPromotionEligible, true)
    else { assertRefused(result, 'ORGAN_SIZE_GROWTH_UNJUSTIFIED'); assert.equal(f.trialRequests.length, 0); assert.equal(f.receipts.length, 0) }
  })
}

for (const justification of [undefined, null, 24, '', ' '.repeat(30), 'x'.repeat(23), ' ' + 'x'.repeat(23) + ' ']) {
  test('oversized candidates reject absent, non-text or short explanations: ' + JSON.stringify(justification), async () => {
    const f = fixture()
    assertRefused(await f.run({ candidateSource: f.candidate + ' '.repeat(101), sizeGrowthJustification: justification }), 'ORGAN_SIZE_GROWTH_UNJUSTIFIED')
  })
}

test('a 24-character justification can pass size admission but does not skip authorship', async () => {
  const f = fixture()
  const args = { candidateSource: f.candidate + ' '.repeat(101), sizeGrowthJustification: 'x'.repeat(24) }
  assert.equal((await f.run(args)).passkeyPromotionEligible, true)
  assertRefused(await f.run({ ...args, candidateAuthor: 'case-author' }), 'ARENA_CROSS_AUTHORSHIP_REQUIRED')
})

test('size compares UTF-8 bytes, not JavaScript string length', async () => {
  const f = fixture()
  const candidateSource = f.candidate.slice(0, 100) + 'é'.repeat(501)
  assert.ok(candidateSource.length < 1100)
  assertRefused(await f.run({ candidateSource }), 'ORGAN_SIZE_GROWTH_UNJUSTIFIED')
})

test('new targets need an explanation and still cannot invent an incumbent baseline', async () => {
  const f = fixture()
  f.files.set(HEAD, JSON.stringify({ ...f.head, entries: {} }))
  assertRefused(await f.run(), 'ORGAN_SIZE_GROWTH_UNJUSTIFIED')
  assertRefused(await f.run({ sizeGrowthJustification: 'A new case needs this explicit new implementation.' }), 'PEARL_ORGAN_ID_INVALID')
  assert.equal(f.trialRequests.length, 0)
})

for (const candidateAuthor of [undefined, null, '', '   ', 'case-author', ' case-author ']) {
  test('candidate identity cannot be absent or equal the target case author: ' + JSON.stringify(candidateAuthor), async () => {
    const f = fixture()
    assertRefused(await f.run({ candidateAuthor }), 'ARENA_CROSS_AUTHORSHIP_REQUIRED')
    assert.equal(f.trialRequests.length, 0)
  })
}

for (const author of [undefined, null, '', '   ', 'candidate-author', ' candidate-author ']) {
  test('every retained target case requires a distinct author: ' + JSON.stringify(author), async () => {
    const f = fixture()
    f.updateSuite(suite => ({ ...suite, cases: [...suite.cases, { id: 'second-target', author, args: { organ: f.organId }, expect: true }] }))
    assertRefused(await f.run({ challengerAgentId: 'claimed-independent' }), 'ARENA_CROSS_AUTHORSHIP_REQUIRED')
  })
}

test('historical suites without attribution refuse review and are never rewritten', async () => {
  const f = fixture()
  f.updateSuite(suite => ({ ...suite, cases: suite.cases.map(({ author, ...item }) => item) }))
  const before = f.files.get(SUITE)
  assertRefused(await f.run(), 'ARENA_CROSS_AUTHORSHIP_REQUIRED')
  assert.equal(f.files.get(SUITE), before)
  assert.equal(f.trialRequests.length, 0)
  assert.equal(f.receipts.length, 0)
})

for (const ceiling of ['class1_2_only', 0, 1, 2]) {
  test('a restrictive grant ceiling cannot qualify a candidate: ' + ceiling, async () => {
    const f = fixture()
    f.files.set(GRANT, JSON.stringify({ governanceScopeCeiling: ceiling }))
    assertRefused(await f.run({ governanceScopeCeiling: 3, approved: true }), 'AUTHORITY_CEILING_REFUSED')
    assert.equal(f.trialRequests.length, 0)
    assert.equal(f.receipts.length, 0)
  })
}

for (const grant of ['{', 'null', '[]', 'false', '0', '"grant"', '{}', '{"governanceScopeCeiling":3}', '{"governanceScopeCeiling":"self-modify","verified":true}', '{"governanceScopeCeiling":99}', '{"governanceScopeCeiling":-1}']) {
  test('malformed or unsupported grants cannot authenticate themselves: ' + grant, async () => {
    const f = fixture()
    f.files.set(GRANT, grant)
    assertRefused(await f.run(), 'GRANT_FILE_INVALID')
    assert.equal(f.receipts.length, 0)
  })
}

for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
  test('a failed grant read is not missing authority: ' + code, async () => {
    const f = fixture()
    f.errors.set(GRANT, code)
    assertRefused(await f.run(), 'GRANT_FILE_INVALID')
  })
}

test('gates run inside a trial before requiring a nested Scion service', async () => {
  const f = fixture()
  delete f.ctx.scion
  assertRefused(await f.run({ candidateSource: f.candidate + ' '.repeat(101) }), 'ORGAN_SIZE_GROWTH_UNJUSTIFIED')
  assertRefused(await f.run({ candidateAuthor: 'case-author' }), 'ARENA_CROSS_AUTHORSHIP_REQUIRED')
  f.files.set(GRANT, '{"governanceScopeCeiling":"class1_2_only"}')
  assertRefused(await f.run(), 'AUTHORITY_CEILING_REFUSED')
  f.files.delete(GRANT)
  assertRefused(await f.run(), 'PEARL_TRIAL_UNAVAILABLE')
})

test('injected module filesystem remains supported when no contextual VFS exists', async () => {
  assert.equal((await fixture({ contextualFs: false }).run()).passkeyPromotionEligible, true)
})

test('an invalid contextual VFS never falls back to the module filesystem', async () => {
  const f = fixture({ contextualFs: false })
  f.ctx.fs = {}
  assertRefused(await f.run(), 'PEARL_VFS_UNAVAILABLE')
  assert.equal(f.reads.length, 0)
})

test('candidate specifiers read and verify immutable trial bytes', async () => {
  const f = fixture()
  f.files.set(sourcePath(f.candidate), f.candidate)
  const input = { candidateSource: undefined, candidateSpecifier: 'ball:' + hash(f.candidate) }
  assert.equal((await f.run(input)).passkeyPromotionEligible, true)
  f.files.set(sourcePath(f.candidate), 'corrupt')
  assertRefused(await f.run(input), 'PEARL_MODULE_HASH_MISMATCH')
  f.files.delete(sourcePath(f.candidate))
  assertRefused(await f.run(input), 'PEARL_BUILD_UNAVAILABLE')
})

test('selected incumbent bytes are mandatory, hash-checked and never taken from named source', async () => {
  const f = fixture()
  f.files.set('/dsh/home/auma/seed/organs/seed-pearl.js', ' '.repeat(100000))
  f.files.set(sourcePath(f.incumbent), 'corrupt')
  assertRefused(await f.run(), 'PEARL_MODULE_HASH_MISMATCH')
  f.files.delete(sourcePath(f.incumbent))
  assertRefused(await f.run(), 'PEARL_BUILD_UNAVAILABLE')
})

test('conflicting candidate inputs and caller-selected baselines remain refused', async () => {
  const f = fixture()
  assertRefused(await f.run({ baselineSpecifier: 'ball:' + hash(f.candidate) }), 'PEARL_BASELINE_OVERRIDE_REFUSED')
  assertRefused(await f.run({ candidateSpecifier: 'ball:' + hash(f.candidate) }), 'PEARL_CANDIDATE_AMBIGUOUS')
  assert.equal(f.trialRequests.length, 0)
})

for (const input of ['suite', 'head', 'incumbent', 'candidate', 'grant-appears', 'grant-unreadable']) {
  test('changed trial inputs invalidate the result before any receipt: ' + input, async () => {
    const f = fixture()
    f.files.set(sourcePath(f.candidate), f.candidate)
    f.duringTrial = () => {
      if (input === 'suite') f.files.set(SUITE, f.files.get(SUITE) + ' ')
      if (input === 'head') f.files.set(HEAD, JSON.stringify({ ...f.head, epoch: 2 }))
      if (input === 'incumbent') f.files.delete(sourcePath(f.incumbent))
      if (input === 'candidate') f.files.set(sourcePath(f.candidate), 'changed')
      if (input === 'grant-appears') f.files.set(GRANT, '{}')
      if (input === 'grant-unreadable') f.errors.set(GRANT, 'EACCES')
    }
    assertRefused(await f.run({ candidateSource: undefined, candidateSpecifier: 'ball:' + hash(f.candidate) }), 'PEARL_CHALLENGE_INPUT_CHANGED')
    assert.equal(f.receipts.length, 0)
  })
}

for (const field of ['headBallId', 'suiteDigest', 'suiteBytesDigest', 'organs']) {
  for (const arm of ['candidate', 'baseline']) {
    test('both runtime arms must bind the checked inputs: ' + arm + ' ' + field, async () => {
      const f = fixture()
      f.alterComparison = comparison => { (arm === 'baseline' ? comparison.baselineResult : comparison)[field] = field === 'organs' ? {} : 'different'; return comparison }
      assertRefused(await f.run(), 'PEARL_CHALLENGE_INPUT_CHANGED')
      assert.equal(f.receipts.length, 0)
    })
  }
}

for (const weakness of ['tie', 'candidate-fails', 'trial-fails', 'incomplete-comparison', 'uncovered', 'no-target-improvement', 'unverified-suite', 'failed-controls', 'violated-route', 'inconclusive-route', 'missing-case']) {
  test('structural admission never overrides failed retention evidence: ' + weakness, async () => {
    const f = fixture()
    if (weakness === 'tie') f.baselinePasses = true
    if (weakness === 'candidate-fails') f.candidatePasses = false
    if (weakness === 'trial-fails') f.trialOk = false
    if (weakness === 'incomplete-comparison') f.comparisonComplete = false
    f.alterComparison = comparison => {
      if (weakness === 'uncovered') comparison.targetCovered = false
      if (weakness === 'no-target-improvement') comparison.targetImproved = false
      if (weakness === 'unverified-suite') comparison.suiteAdmission = 'unverified'
      if (weakness === 'failed-controls') comparison.graderControls.acceptAllRejected = false
      if (weakness === 'violated-route') comparison.routeEvidence.status = 'violated'
      if (weakness === 'inconclusive-route') comparison.routeEvidence.status = 'inconclusive'
      if (weakness === 'missing-case') comparison.results.pop()
      return comparison
    }
    const result = await f.run()
    assert.equal(result.qualifiedForPromotion, false)
    assert.equal(result.passkeyPromotionEligible, false)
    assert.equal(result.standingGrantEligible, false)
    assert.equal(result.qualificationId, null)
  })
}

test('unchanged sources and untargeted diagnostic comparisons never qualify', async () => {
  const f = fixture()
  assert.equal((await f.run({ candidateSource: f.incumbent })).qualifiedForPromotion, false)
  assert.equal((await f.run({ organId: undefined, candidateSource: undefined })).qualifiedForPromotion, false)
  assertRefused(await f.run({ organId: undefined }), 'PEARL_ORGAN_ID_REQUIRED')
})

test('missing baseline and failed receipt acknowledgments never return eligibility', async () => {
  const f = fixture()
  f.alterComparison = comparison => ({ ...comparison, baselineResult: null })
  assertRefused(await f.run(), 'PEARL_ARENA_UNAVAILABLE')
  f.alterComparison = comparison => comparison
  f.receiptOk = false
  const result = await f.run()
  assert.equal(result.error, 'SYNTHETIC_RECEIPT_REFUSAL')
  assert.equal(result.qualifiedForPromotion, false)
  assert.equal(result.passkeyPromotionEligible, false)
  assert.equal(result.qualificationId, null)
})

for (const arm of ['candidate', 'baseline']) {
  for (const malformed of ['empty-results', 'missing-case', 'sparse-results', 'duplicate-case', 'extra-case', 'reordered-cases', 'unknown-case', 'null-case', 'untyped-pass', 'missing-controls', 'failed-controls', 'missing-route', 'inconclusive-route', 'untyped-ok']) {
    test('both comparison arms need complete, typed, unique case evidence: ' + arm + ' ' + malformed, async () => {
      const f = fixture()
      f.alterComparison = comparison => {
        const result = arm === 'candidate' ? comparison : comparison.baselineResult
        if (malformed === 'empty-results') result.results = []
        if (malformed === 'missing-case') result.results.pop()
        if (malformed === 'sparse-results') delete result.results[1]
        if (malformed === 'duplicate-case') result.results[1] = { ...result.results[0] }
        if (malformed === 'extra-case') result.results.unshift({ id: 'target', pass: false })
        if (malformed === 'reordered-cases') result.results.reverse()
        if (malformed === 'unknown-case') result.results[0].id = 'unknown'
        if (malformed === 'null-case') result.results[0] = null
        if (malformed === 'untyped-pass') result.results[0].pass = 'true'
        if (malformed === 'missing-controls') delete result.graderControls
        if (malformed === 'failed-controls') result.graderControls.rejectAllRejected = false
        if (malformed === 'missing-route') delete result.routeEvidence
        if (malformed === 'inconclusive-route') result.routeEvidence.status = 'inconclusive'
        if (malformed === 'untyped-ok') result.ok = 'true'
        return comparison
      }
      assertRefused(await f.run(), ['empty-results', 'missing-controls', 'failed-controls'].includes(malformed)
        ? 'PEARL_ARENA_UNAVAILABLE' : 'PEARL_COMPARISON_INCOMPLETE')
      assert.equal(f.receipts.length, 0)
    })
  }
}

test('a complete losing baseline may report ok false without becoming an incomplete trial', async () => {
  const f = fixture()
  f.alterComparison = comparison => { comparison.baselineResult.ok = false; return comparison }
  assert.equal((await f.run()).passkeyPromotionEligible, true)
})

test('a peer-only improvement cannot impersonate a discriminating target case', async () => {
  const f = fixture()
  f.alterComparison = comparison => {
    comparison.baselineResult.results = [{ id: 'target', pass: true }, { id: 'retained-peer', pass: false }]
    return comparison
  }
  const result = await f.run()
  assert.equal(result.winnerId, 'candidate')
  assert.equal(result.passkeyPromotionEligible, false)
  assert.equal(result.qualifiedForPromotion, false)
  assert.equal(result.qualificationId, null)
})

function assertArenaUnavailable(result, f, before, arms) {
  assertRefused(result, 'PEARL_ARENA_UNAVAILABLE')
  assert.deepEqual(result.unavailableArms, arms)
  for (const field of ['results', 'candidates', 'winner', 'winnerId', 'decidedBy', 'receipt', 'passed', 'total']) {
    assert.equal(Object.hasOwn(result, field), false, field + ' must not imply an observed verdict')
  }
  assert.equal(f.trialRequests.length, 1)
  assert.equal(f.receipts.length, 0)
  assert.deepEqual([...f.files], before)
  assert.ok(!JSON.stringify(result).includes('unchecked-runtime-token'))
}

for (const arm of ['candidate', 'baseline']) {
  for (const unavailable of ['zero-total', 'zero-total-cases', 'missing-results', 'null-results', 'object-results', 'string-results', 'empty-results', 'missing-controls', 'null-controls',
    'allPassed', 'knownGoodAccepted', 'knownBadRejected', 'acceptAllRejected', 'rejectAllRejected']) {
    test('unavailable arena arms produce no verdict or receipt: ' + arm + ' ' + unavailable, async () => {
      const f = fixture()
      f.alterComparison = comparison => {
        const result = arm === 'candidate' ? comparison : comparison.baselineResult
        if (unavailable === 'zero-total') result.total = 0
        if (unavailable === 'zero-total-cases') result.totalCases = 0
        if (unavailable === 'missing-results') delete result.results
        if (unavailable === 'null-results') result.results = null
        if (unavailable === 'object-results') result.results = { length: 2 }
        if (unavailable === 'string-results') result.results = '[]'
        if (unavailable === 'empty-results') result.results = []
        if (unavailable === 'missing-controls') delete result.graderControls
        if (unavailable === 'null-controls') result.graderControls = null
        if (Object.hasOwn(result.graderControls || {}, unavailable)) result.graderControls[unavailable] = false
        result.error = 'CANDIDATE_TRIAL_TIMEOUT'
        return comparison
      }
      const before = [...f.files]
      let readsAfterTrial
      f.duringTrial = () => { readsAfterTrial = f.reads.length }
      const result = await f.run()
      assertArenaUnavailable(result, f, before, [arm])
      assert.deepEqual(result.trialErrors, { [arm]: 'CANDIDATE_TRIAL_TIMEOUT' })
      assert.equal(f.reads.length, readsAfterTrial)
    })
  }

  for (const flag of ['allPassed', 'knownGoodAccepted', 'knownBadRejected', 'acceptAllRejected', 'rejectAllRejected']) {
    test('canary admission requires literal true: ' + arm + ' ' + flag, async () => {
      for (const value of [undefined, null, 1, 'true']) {
        const f = fixture()
        f.alterComparison = comparison => {
          (arm === 'candidate' ? comparison : comparison.baselineResult).graderControls[flag] = value
          return comparison
        }
        const before = [...f.files]
        assertArenaUnavailable(await f.run(), f, before, [arm])
      }
    })
  }
}

test('two empty 20-case arms cannot become a numeric inconclusive verdict', async () => {
  const f = fixture()
  f.updateSuite(suite => ({ ...suite, cases: Array.from({ length: 20 }, (_, i) => ({ ...suite.cases[i % 2], id: 'case-' + i })) }))
  f.alterComparison = comparison => {
    for (const result of [comparison, comparison.baselineResult]) {
      result.results = []
      result.totalCases = 20
      result.passedCases = 0
      result.ok = false
    }
    comparison.error = 'CANDIDATE_TRIAL_EMPTY'
    comparison.baselineResult.error = 'CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE'
    return comparison
  }
  const before = [...f.files]
  const result = await f.run()
  assertArenaUnavailable(result, f, before, ['candidate', 'baseline'])
  assert.deepEqual(result.trialErrors, { candidate: 'CANDIDATE_TRIAL_EMPTY', baseline: 'CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE' })
})

for (const arm of ['candidate', 'baseline']) {
  test('arena availability precedes input and result validation: ' + arm, async () => {
    const f = fixture()
    f.alterComparison = comparison => {
      comparison.headBallId = 'changed'
      comparison.baselineResult.headBallId = 'changed'
      const result = arm === 'candidate' ? comparison : comparison.baselineResult
      result.results = []
      result.error = 'CANDIDATE_TRIAL_RESULTS_INCOMPLETE'
      return comparison
    }
    const before = [...f.files]
    const result = await f.run()
    assertArenaUnavailable(result, f, before, [arm])
    assert.deepEqual(result.trialErrors, { [arm]: 'CANDIDATE_TRIAL_RESULTS_INCOMPLETE' })
  })
}

for (const missing of [undefined, null, false, {}]) {
  test('missing comparison or baseline has no observed verdict: ' + JSON.stringify(missing), async () => {
    for (const arm of ['candidate', 'baseline']) {
      const f = fixture()
      f.alterComparison = comparison => arm === 'candidate' ? missing : { ...comparison, baselineResult: missing }
      const before = [...f.files]
      assertArenaUnavailable(await f.run(), f, before, arm === 'candidate' ? ['candidate', 'baseline'] : ['baseline'])
    }
  })
}

for (const [error, expected] of [
  ['CANDIDATE_TRIAL_TIMEOUT', 'CANDIDATE_TRIAL_TIMEOUT'],
  ['CANDIDATE_TRIAL_IMPORT_BLOCKED: dynamic import() secret-sentinel', 'CANDIDATE_TRIAL_IMPORT_BLOCKED'],
  ['CANDIDATE_TRIAL_EMPTY\nBearer secret-sentinel', 'CANDIDATE_TRIAL_EMPTY'],
  ['CANDIDATE_TRIAL_OUTPUT_LIMIT: ' + 'secret-sentinel'.repeat(1000), 'CANDIDATE_TRIAL_OUTPUT_LIMIT'],
  ['SCION_ORGAN_NAME_MISMATCH', 'SCION_ORGAN_NAME_MISMATCH'],
  ['CANDIDATE_TRIAL_TIMEOUT_secret-sentinel', 'TRIAL_ERROR_REDACTED'],
  ['worker load failed: https://example.invalid/?token=secret-sentinel', 'TRIAL_ERROR_REDACTED'],
  ['Authorization: Bearer secret-sentinel\r\nSet-Cookie: session=secret-sentinel', 'TRIAL_ERROR_REDACTED'],
  [{ message: 'secret-sentinel', toString() { throw new Error('must not coerce trial errors') } }, 'TRIAL_ERROR_REDACTED'],
]) {
  test('trial diagnostics expose only bounded known error codes: ' + expected + ' ' + typeof error, async () => {
    const f = fixture()
    f.alterComparison = comparison => {
      comparison.results = []
      comparison.error = error
      return comparison
    }
    const before = [...f.files]
    const result = await f.run()
    assertArenaUnavailable(result, f, before, ['candidate'])
    assert.deepEqual(result.trialErrors, { candidate: expected })
    assert.ok(!JSON.stringify(result).includes('secret-sentinel'))
  })
}

test('observed zero passes remain a retention result when every case and canary ran', async () => {
  const f = fixture()
  f.alterComparison = comparison => {
    for (const result of [comparison, comparison.baselineResult]) {
      result.total = f.suite.cases.length
      result.results.forEach(row => { row.pass = false })
      result.ok = false
    }
    return comparison
  }
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.decidedBy, 'inconclusive')
  assert.equal(result.qualifiedForPromotion, false)
  assert.equal(result.passkeyPromotionEligible, false)
  assert.equal(result.results.candidate.passed, 0)
  assert.equal(result.results.baseline.passed, 0)
  assert.equal(result.results.candidate.total, 2)
  assert.equal(result.results.baseline.total, 2)
  assert.equal(f.receipts.length, 1)
})

for (const [cause, expected] of [
  [new Error('CANDIDATE_TRIAL_TIMEOUT: secret-sentinel'), 'CANDIDATE_TRIAL_TIMEOUT'],
  ['CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE', 'CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE'],
  [new Error('worker failure: secret-sentinel'), 'TRIAL_ERROR_REDACTED'],
  [null, 'TRIAL_ERROR_REDACTED'],
]) {
  test('rejected trial calls report no verdict and only safe causes: ' + expected + ' ' + typeof cause, async () => {
    const f = fixture()
    f.ctx.scion.trialRetentionCandidate = async request => { f.trialRequests.push(request); throw cause }
    const before = [...f.files]
    const result = await f.run()
    assertArenaUnavailable(result, f, before, ['candidate', 'baseline'])
    assert.deepEqual(result.trialErrors, { candidate: expected })
    assert.ok(!JSON.stringify(result).includes('secret-sentinel'))
  })
}

// Structural tripwire over the LIVE mirror organ(s): load contract only, never behaviour (see fixtures/organs/live-shape.mjs).
test('live mirror organs keep their tool-module load contract (structural only)', async () => {
  for (const name of ['seed-pearl']) await assertLiveOrganShape(assert, name)
})
