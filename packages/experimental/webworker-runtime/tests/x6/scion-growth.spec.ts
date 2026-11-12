import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sha256HexSync, WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { growScionOrgan, primeScionTrialScript, retentionSuiteDigest, retentionSuiteExtendsBaseline, trialScionCandidate, trialScionRetention } from '../../src/x6/scion-growth.ts'
import { classifyActionIrreversibility, hydrateNamedOrganSources, mountX6BallRuntime, readX6Facts, STAGED_HEAD_PROMOTION_PATH, type BallManifest } from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { SCION_COMPILER } from '../../src/x6/scion-pins.ts'

/** Admit only the named callable from an untyped repository fixture; callers validate its result. */
async function fixtureFunction(relative: string, name: string): Promise<(...args: unknown[]) => unknown> {
  const namespace: unknown = await import(new URL(relative, import.meta.url).href)
  if (!namespace || typeof namespace !== 'object' || !(name in namespace)) throw new Error('Fixture export missing: ' + name)
  const callable = (namespace as Record<string, unknown>)[name]
  if (typeof callable !== 'function') throw new Error('Fixture export is not callable: ' + name)
  return (...args) => Reflect.apply(callable, undefined, args)
}

describe('trialScionCandidate & growScionOrgan isolated worker trial', () => {
  it('classifies reads, bounded drafts, append-only history and protected candidate-qualified targets', () => {
    for (const action of ['read', 'draft', 'compute', 'x6_facts', 'ball_status', 'self_facts']) expect(classifyActionIrreversibility(action)).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'ball_put', promote: false })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'ball_put', promote: true })).toBe(1)
    expect(classifyActionIrreversibility({ tool: 'seed-receipts', action: 'append' })).toBe(2)
    expect(classifyActionIrreversibility({ action: 'delete', path: '/dsh/home/balls/history/x.json' })).toBe(2)
    for (const id of ['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura']) {
      expect(classifyActionIrreversibility({ action: 'tree_patch', id: id + ':' + 'a'.repeat(64) })).toBe(3)
    }
    for (const action of ['send_message', 'spend', 'mint_authority']) expect(classifyActionIrreversibility(action)).toBe(3)
    for (const action of ['read_private_key', 'raw_7_word_phrase', 'read_biometrics']) expect(classifyActionIrreversibility(action)).toBe(4)
    expect(classifyActionIrreversibility('unknown_operation')).toBe(1)
    const untyped = { toString() { throw new Error('Object coercion must not execute') } }
    expect(classifyActionIrreversibility({ tool: untyped, action: untyped, target: untyped, path: untyped })).toBe(1)
  })

  it('binds only executable retention suite inputs, including harness, and ignores pending proposals', () => {
    const suite = { schema: 'fixture', harness: 'runtime', organs: ['seed-fixture'], fixedNow: 1, cases: [{ id: 'one', expect: true }], fixtures: {} }
    const digest = retentionSuiteDigest(suite)
    expect(retentionSuiteDigest({ ...suite, pendingCases: [{ id: 'future' }] })).toBe(digest)
    expect(retentionSuiteDigest(JSON.parse(JSON.stringify(suite, null, 2)) as Record<string, unknown>)).toBe(digest)
    for (const key of ['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures']) expect(retentionSuiteDigest({ ...suite, [key]: null })).not.toBe(digest)
  })

  it('retains baseline case order, complete fixtures and execution settings while admitting additions', () => {
    const baseline = { schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention/v1', fixedNow: 1,
      organs: ['seed-first', 'seed-second'], fixtures: { base: { '/fixture/file': 'retained bytes' } }, cases: [
        { id: 'one', args: { organ: 'seed-first', fixture: 'base' }, expect: true, routePolicy: { policyId: 'pinned' } },
        { id: 'two', args: { organ: 'seed-second', fixture: 'base' }, expectError: 'REFUSED' },
      ] }
    const grown = { ...baseline, organs: [...baseline.organs, 'seed-third'], fixtures: { ...baseline.fixtures, additional: { '/new': 'bytes' } },
      cases: [...baseline.cases, { id: 'three', args: { organ: 'seed-third', fixture: 'additional' }, expect: true }] }
    expect(retentionSuiteExtendsBaseline(baseline, baseline)).toBe(true)
    expect(retentionSuiteExtendsBaseline(grown, baseline)).toBe(true)
    expect(retentionSuiteDigest(grown)).not.toBe(retentionSuiteDigest(baseline))
    for (const weakened of [
      { ...grown, schema: 'other' }, { ...grown, harness: 'other' }, { ...grown, fixedNow: 2 },
      { ...grown, organs: ['seed-first', 'seed-third'] }, { ...grown, organs: ['seed-second', 'seed-first', 'seed-third'] },
      { ...grown, organs: [...grown.organs, 'seed-first'] }, { ...grown, cases: grown.cases.slice(1) },
      { ...grown, cases: [grown.cases[1], grown.cases[0], grown.cases[2]] }, { ...grown, cases: [...grown.cases, grown.cases[0]] },
      { ...grown, cases: [{ ...grown.cases[0], expect: false }, ...grown.cases.slice(1)] },
      { ...grown, cases: [{ ...grown.cases[0], routePolicy: {} }, ...grown.cases.slice(1)] },
      { ...grown, fixtures: { additional: grown.fixtures.additional } },
      { ...grown, fixtures: { ...grown.fixtures, base: { '/fixture/file': 'replaced bytes' } } },
      { ...grown, fixtures: { ...grown.fixtures, base: { '/fixture/./file': 'retained bytes' } } },
      { ...grown, fixtures: { ...grown.fixtures, base: { ...baseline.fixtures.base, '/fixture/file/': 'alias' } } },
    ]) expect(retentionSuiteExtendsBaseline(weakened, baseline)).toBe(false)
    expect(retentionSuiteExtendsBaseline(grown, { ...baseline, cases: [] })).toBe(false)
    expect(retentionSuiteExtendsBaseline(grown, { ...baseline, cases: [...baseline.cases, baseline.cases[0]] })).toBe(false)
  })

  it('stamps the build with the same executable digest and excludes nonexecutable proposals', async () => {
    const buildIdentity = await fixtureFunction('../../../../../apps/web/vite.config.ts', 'retentionBuildIdentity')
    const suite = { schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention/v1', fixedNow: 1, organs: ['seed-fixture'],
      fixtures: { empty: {} }, cases: [{ id: 'one', args: { organ: 'seed-fixture', fixture: 'empty' }, expect: true }], pendingCases: ['ignored'] }
    const stamp = await buildIdentity(JSON.stringify(suite, null, 2))
    expect(stamp).toEqual({ retentionBaselineSuite: Object.fromEntries(Object.entries(suite).filter(([key]) => key !== 'pendingCases')),
      retentionBaselineDigest: retentionSuiteDigest(suite) })
    expect(() => buildIdentity(JSON.stringify({ ...suite, cases: [suite.cases[0], suite.cases[0]] }))).toThrow('PEARL_SUITE_INVALID')
    expect(() => buildIdentity(JSON.stringify({ ...suite, fixtures: [] }))).toThrow('PEARL_SUITE_INVALID')
    expect(() => buildIdentity(' '.repeat(1024 * 1024 + 1))).toThrow('PEARL_SUITE_LIMIT')
  })

  it('reads same-origin facts without relay or private fields, preferring sufficient metadata', async () => {
    const calls: Request[] = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init); calls.push(request)
      if (new URL(request.url).pathname === '/_mirror/status') return Response.json({ ok: true, protocol: 'x61-cloud-mirror/v1',
        lineageId: '00000000-0000-0000-0000-000000000001', revision: 4, privateKey: 'must-not-appear' })
      return Response.json({ ok: true, ballId: 'a'.repeat(64), epoch: 4, receiptTotal: 3, evidenceStatus: 'complete',
        privateKey: 'must-not-appear', codeBySha: { private: 'must-not-appear' }, files: ['must-not-appear'] })
    })
    try {
      const result = await readX6Facts('https://facts-fixture.invalid', { organSourceCommit: 'b'.repeat(40), secret: 'must-not-appear' })
      expect(result.ok).toBe(true)
      expect(calls.map(call => new URL(call.url).pathname + new URL(call.url).search)).toEqual(['/__x6/facts', '/_mirror/status?compact=1'])
      expect(calls.every(call => call.method === 'GET' && call.credentials === 'same-origin' && call.mode === 'same-origin' && call.redirect === 'error')).toBe(true)
      expect(JSON.stringify(result)).not.toContain('must-not-appear')
      expect(result.ownerApproval).toBe(false)
      expect(result.mirror).toEqual({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: '00000000-0000-0000-0000-000000000001', revision: 4 })
    } finally { vi.unstubAllGlobals() }
  })

  it.each([
    {}, { ok: true }, { ok: false },
    { ok: true, ballId: 'a'.repeat(64), epoch: 1 },
    { ok: true, ballId: 'bad', epoch: 1, evidenceStatus: 'complete' },
    { ok: true, ballId: 'a'.repeat(64), epoch: '1', evidenceStatus: 'complete' },
    { ok: true, ballId: 'a'.repeat(64), epoch: -1, evidenceStatus: 'complete' },
    { ok: true, ballId: 'a'.repeat(64), epoch: 1, evidenceStatus: 'incomplete' },
  ])('rejects malformed HTTP200 facts payload %# without asserting host evidence', async (payload) => {
    vi.stubGlobal('fetch', async () => Response.json(payload))
    try {
      const result = await readX6Facts('https://facts-fixture.invalid', { organSourceCommit: 'b'.repeat(40) })
      expect(result.ok).toBe(false)
      expect(result.facts).toEqual({ ok: false, error: 'X6_FACTS_INVALID' })
      expect(result.mirror).toEqual({ ok: false, error: 'X6_FACTS_INVALID' })
      expect(result.evidence).toBe('local-build-fallback-unverified')
    } finally { vi.unstubAllGlobals() }
  })

  it('reports failed or oversized fact reads without echoing responses, exceptions or claiming fallback verification', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL) => {
      const url = new URL(resource instanceof Request ? resource.url : resource); calls.push(url.pathname + url.search)
      if (url.pathname === '/__x6/facts') return new Response('s'.repeat(70 * 1024))
      if (url.pathname === '/_head/ball') return Response.json({ ok: true, ball: { ballId: 'c'.repeat(64), epoch: 2, config: { secret: 'never-echo' } } })
      throw new Error('never-echo')
    })
    try {
      const result = await readX6Facts('https://facts-fixture.invalid', { organSourceCommit: 'd'.repeat(40), builtAt: '2026-01-01T00:00:00.000Z' })
      expect(result.ok).toBe(false)
      expect(result.evidence).toBe('local-build-fallback-unverified')
      expect(result.facts).toEqual({ ok: false, error: 'X6_FACTS_BYTE_LIMIT' })
      expect(result.head).toEqual({ ok: true, head: { ballId: 'c'.repeat(64), epoch: 2 } })
      expect(result.mirror).toEqual({ ok: false, error: 'X6_FACTS_UNAVAILABLE' })
      expect(calls).toContain('/_head/ball?meta=1')
      expect(JSON.stringify(result)).not.toContain('never-echo')
      expect((await readX6Facts(undefined, {})).ok).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })

  it('makes Pearl ties inconclusive, binds both digests and qualifies only a passing differential', async () => {
    const source = await readFile(new URL('../../../../../mirror/home/auma/seed/organs/seed-pearl.js', import.meta.url), 'utf8')
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma/seed/pearl', { recursive: true })
    vfs.mkdirSync('/dsh/home/balls', { recursive: true })
    const suitePath = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
    const original = 'module.exports = { run() { return false } }'
    const candidate = 'module.exports = { run() { return true } }'
    const input = { action: 'challenge', organId: 'seed-pearl', candidateSource: candidate, candidateAuthor: 'candidate-author' }
    const suiteText = JSON.stringify({ cases: [{ id: 'one', author: 'case-author', args: { organ: 'seed-pearl' }, expect: true }], fixtures: {}, harness: 'fixture', fixedNow: 1 })
    vfs.writeFileSync(suitePath, suiteText)
    vfs.writeFileSync('/dsh/home/balls/HEAD.json', JSON.stringify({ ballId: 'head', epoch: 1, entries: { 'seed-pearl': { specifier: 'ball:' + sha256HexSync(original) } } }))
    vfs.writeFileSync('/dsh/home/balls/' + sha256HexSync(original) + '.js', original)
    const module = { exports: {} }
    runInNewContext(source, { module, Buffer, require: (id: string) => {
      if (id === 'node:fs') return vfs
      if (id === 'node:crypto') return { createHash }
      throw new Error('Unexpected dependency: ' + id)
    } })
    const pearl = module.exports as { run(args: unknown, ctx: unknown): Promise<Record<string, unknown>> }
    const receipts: Record<string, unknown>[] = []
    let changeSuite = false
    let trialOk = false
    let baselinePasses = true
    let comparisonComplete = true
    let comparisons = 0
    let mismatchedArm: 'suiteDigest' | 'suiteBytesDigest' | 'headBallId' | null = null
    const ctx = { scion: { trialRetentionCandidate: async (request: Record<string, unknown>) => {
      comparisons++
      expect(request).not.toHaveProperty('baseline')
      if (changeSuite) vfs.writeFileSync(suitePath, JSON.stringify({ ...JSON.parse(suiteText), fixedNow: 2 }))
      const arm = (baseline: boolean) => ({ ok: trialOk, qualifiedForPromotion: !baseline, qualificationId: baseline ? null : 'runtime-issued', results: [{ id: 'one', pass: !baseline || baselinePasses }], durationMs: baseline ? 2 : 1,
        organs: { 'seed-pearl': sha256HexSync(baseline ? original : candidate) }, targetCovered: true,
        headBallId: 'head', suiteDigest: retentionSuiteDigest(JSON.parse(suiteText) as Record<string, unknown>),
        suiteBytesDigest: sha256HexSync(suiteText), suiteAdmission: 'build-pinned',
        graderControls: { allPassed: true, knownGoodAccepted: true, knownBadRejected: true, acceptAllRejected: true, rejectAllRejected: true }, routeEvidence: { status: 'checked' },
        ...(baseline && mismatchedArm ? { [mismatchedArm]: 'different' } : {}) })
      return { ...arm(false), baselineResult: arm(true), comparisonComplete, targetImproved: !baselinePasses, winnerId: baselinePasses ? null : 'candidate' }
    } }, organs: { call: async (_name: string, request: { data: Record<string, unknown> }) => {
      receipts.push(request.data)
      return { ok: true, receipt: { seq: 1, leafHash: 'fixture' } }
    } } }
    const result = await pearl.run(input, ctx)
    expect(comparisons).toBe(1)
    expect(result.winnerId).toBeNull()
    expect(result.decidedBy).toBe('inconclusive')
    expect(result.qualifiedForPromotion).toBe(false)
    expect(result.qualificationId).toBeNull()
    expect((receipts[0]?.candidates as { trialOk: boolean }[]).map(row => row.trialOk)).toEqual([false, false])
    trialOk = true
    const passingTie = await pearl.run(input, ctx)
    expect(passingTie).toMatchObject({ winnerId: null, decidedBy: 'inconclusive', qualifiedForPromotion: false, qualificationId: null })
    expect(receipts[1]).toMatchObject({ winnerId: null, decidedBy: 'inconclusive', qualifiedForPromotion: false })
    baselinePasses = false
    const differential = await pearl.run(input, ctx)
    expect(differential).toMatchObject({ winnerId: 'candidate', decidedBy: 'retention-passes', qualifiedForPromotion: true, qualificationId: null,
      passkeyPromotionEligible: true, standingGrantEligible: false, authorityVerified: false,
      suiteDigest: retentionSuiteDigest(JSON.parse(suiteText) as Record<string, unknown>), suiteBytesDigest: sha256HexSync(suiteText) })
    comparisonComplete = false
    expect(await pearl.run(input, ctx)).toMatchObject({ winnerId: null, decidedBy: 'inconclusive', qualifiedForPromotion: false, qualificationId: null })
    comparisonComplete = true
    expect(await pearl.run({ ...input, baselineSpecifier: 'ball:' + 'a'.repeat(64) }, ctx)).toMatchObject({ error: 'PEARL_BASELINE_OVERRIDE_REFUSED' })
    for (const mismatch of ['suiteDigest', 'suiteBytesDigest', 'headBallId'] as const) {
      mismatchedArm = mismatch
      expect(await pearl.run(input, ctx)).toMatchObject({ error: 'PEARL_CHALLENGE_INPUT_CHANGED', qualifiedForPromotion: false, qualificationId: null })
    }
    mismatchedArm = null
    changeSuite = true
    const stale = await pearl.run(input, ctx)
    expect(stale.error).toBe('PEARL_CHALLENGE_INPUT_CHANGED')
    expect(stale.qualifiedForPromotion).toBe(false)
    expect(receipts).toHaveLength(4)
    expect((await pearl.run({ action: 'challenge' }, {})).error).toBe('PEARL_TRIAL_UNAVAILABLE')
  })

  it('runs Pearl structural refusals through the real retention harness using each case VFS', async () => {
    const pearl = await readFile(new URL('../../../../../mirror/home/auma/seed/organs/seed-pearl.js', import.meta.url), 'utf8')
    const incumbent = 'module.exports = { run() { return false } }'.padEnd(1000, ' ')
    const candidate = 'module.exports = { run() { return true } }'.padEnd(1000, ' ')
    const suitePath = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
    const grantPath = '/dsh/home/auma/seed/owner-grant.v1.json'
    const suite = { cases: [{ id: 'target', author: 'case-author', args: { organ: 'seed-pearl' }, expect: true }], fixtures: {} }
    const base = {
      [suitePath]: JSON.stringify(suite),
      '/dsh/home/balls/HEAD.json': JSON.stringify({ ballId: 'a'.repeat(64), epoch: 1, entries: { 'seed-pearl': { specifier: 'ball:' + sha256HexSync(incumbent) } } }),
      ['/dsh/home/balls/' + sha256HexSync(incumbent) + '.js']: incumbent,
    }
    const input = { action: 'challenge', organId: 'seed-pearl', candidateSource: candidate, candidateAuthor: 'candidate-author' }
    const rows = [
      { id: 'growth', fixture: 'base', input: { ...input, candidateSource: candidate + ' '.repeat(101) }, error: 'ORGAN_SIZE_GROWTH_UNJUSTIFIED' },
      { id: 'authorship', fixture: 'base', input: { ...input, candidateAuthor: 'case-author' }, error: 'ARENA_CROSS_AUTHORSHIP_REQUIRED' },
      { id: 'legacy-authors', fixture: 'legacy', input, error: 'ARENA_CROSS_AUTHORSHIP_REQUIRED' },
      { id: 'ceiling', fixture: 'restricted', input, error: 'AUTHORITY_CEILING_REFUSED' },
      { id: 'invalid-grant', fixture: 'invalid', input, error: 'GRANT_FILE_INVALID' },
      { id: 'no-nested-trial', fixture: 'base', input, error: 'PEARL_TRIAL_UNAVAILABLE' },
    ]
    const result = await trialScionRetention({ 'seed-pearl': pearl }, { fixedNow: 1000,
      fixtures: { base, legacy: { ...base, [suitePath]: JSON.stringify({ ...suite, cases: [{ id: 'target', args: { organ: 'seed-pearl' }, expect: true }] }) },
        restricted: { ...base, [grantPath]: '{"governanceScopeCeiling":"class1_2_only"}' }, invalid: { ...base, [grantPath]: '{' } },
      cases: rows.map(row => ({ id: row.id, args: { organ: 'seed-pearl', fixture: row.fixture, input: row.input, pick: ['error', 'authorityVerified', 'qualificationId'] },
        expect: { ok: false, error: row.error, authorityVerified: false, qualificationId: null } })),
    })
    expect(result.results.map(row => ({ id: row.id, pass: row.pass, got: row.got }))).toEqual(rows.map(row => ({ id: row.id, pass: true,
      got: { ok: false, error: row.error, authorityVerified: false, qualificationId: null } })))
    expect(result.ok).toBe(true)
    expect(result.graderControls?.allPassed).toBe(true)
    expect(result.routeEvidence?.unsupportedProperties).toContain('execution-containment')
  })

  it.each(['baseline', 'legacy', 'missing', 'mismatched'])('requires fresh build-pinned runtime admission before promotion (pin: %s)', async (pin) => {
    const pinned = pin === 'baseline' || pin === 'legacy'
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/balls', { recursive: true })
    vfs.mkdirSync('/dsh/home/auma/seed/pearl', { recursive: true })
    const original = 'module.exports = { name: "seed-new", run(args) { return { ok: true, value: args.value + 1 }; } };'
    const uncovered = 'module.exports = { name: "seed-uncovered", run(args) { return { ok: true, value: args.value + 1 }; } };'
    const uncoveredCandidate = uncovered.replace('args.value + 1', 'args.value')
    const candidate = original.replace('args.value + 1', 'args.value') + '\n// candidate revision'
    const badCandidate = 'module.exports = { name: "seed-new", run() { return { ok: false }; } };'
    const originalSha = sha256HexSync(original)
    const badSha = sha256HexSync(badCandidate)
    const uncoveredSha = sha256HexSync(uncovered)
    const candidateSha = sha256HexSync(candidate)
    let head: BallManifest = { version: 'x6.1-ball/v1', ballId: 'a'.repeat(64), parentBallId: null, epoch: 1, createdAt: 1, authorPeerId: 'fixture',
      entries: { 'seed-new': { id: 'seed-new', specifier: 'ball:' + originalSha, config: {}, disabled: false, previousSpecifiers: ['ball:' + sha256HexSync(badCandidate)], updatedAt: 1 },
        'seed-uncovered': { id: 'seed-uncovered', specifier: 'ball:' + uncoveredSha, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1 } }, modules: {} }
    head = { ...head, modules: { [originalSha]: { sha256: originalSha, specifier: 'ball:' + originalSha, name: 'seed-new', description: 'fixture', size: original.length, createdAt: 1 },
      [badSha]: { sha256: badSha, specifier: 'ball:' + badSha, name: 'seed-new', description: 'historical fixture', size: badCandidate.length, createdAt: 1 },
      [uncoveredSha]: { sha256: uncoveredSha, specifier: 'ball:' + uncoveredSha, name: 'seed-uncovered', description: 'fixture', size: uncovered.length, createdAt: 1 } } }
    head = { ...head, ballId: sha256HexSync(JSON.stringify({ version: head.version, parentBallId: head.parentBallId, epoch: head.epoch,
      entries: Object.keys(head.entries).sort().map(id => head.entries[id]),
      modules: Object.keys(head.modules).sort().map(sha => head.modules[sha]) })) }
    const suitePath = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
    let suiteText = JSON.stringify({ schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention/v1', organs: ['seed-new'], fixedNow: 1000, fixtures: { empty: {} }, cases: [
      { id: 'retained', args: { organ: 'seed-new', fixture: 'empty', input: { value: 42 }, pick: ['value'] }, expect: { ok: true, value: 42 } },
    ] })
    vfs.writeFileSync(suitePath, suiteText)
    vfs.writeFileSync('/dsh/home/balls/' + candidateSha + '.js', candidate)
    vfs.writeFileSync('/dsh/home/balls/' + sha256HexSync(badCandidate) + '.js', badCandidate)
    const provided = new Map<string, unknown>()
    let activations = 0
    type FixtureTool = {
      name: string
      description: string
      parameters: Record<string, unknown>
      execute(args: unknown, exec?: unknown): Promise<unknown>
    }
    class FixtureTools {
      readonly registry = new Map<string, FixtureTool>()
      register(definition: unknown) {
        const tool = definition as FixtureTool
        this.registry.set(tool.name, tool)
        return () => { this.registry.delete(tool.name) }
      }
      get(name: string) { return this.registry.get(name) }
      definitions() { return [...this.registry.values()] }
    }
    const tools = new FixtureTools()
    const context = { get: (key: string) => provided.get(key), provide: (key: string, value?: unknown) => { provided.set(key, value) },
      tools, plugin: async () => { activations++; return { dispose() {} } } }
    vi.stubGlobal('location', { origin: 'https://runtime-fixture.invalid' })
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('WebSocket', undefined)
    vi.stubGlobal('__X6_SERVICES__', {})
    const baselineSuite = JSON.parse(suiteText) as Record<string, unknown>
    const buildStamp: Record<string, unknown> = pin === 'baseline' || pin === 'mismatched'
      ? { retentionBaselineSuite: baselineSuite, retentionBaselineDigest: pin === 'mismatched' ? '0'.repeat(64) : retentionSuiteDigest(baselineSuite),
        retentionSuiteDigest: retentionSuiteDigest(baselineSuite) }
      : pin === 'legacy' ? { retentionSuiteDigest: retentionSuiteDigest(baselineSuite) } : {}
    vi.stubGlobal('__X6_BUILD_IDENTITY__', buildStamp)
    let networkCalls = 0
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      networkCalls++
      const request = new Request(resource, init)
      expect(request.headers.has('x-x6-class3-approval')).toBe(false)
      const url = new URL(request.url)
      const input = request.body ? await request.clone().json() as Record<string, unknown> : {}
      if (url.origin !== 'https://runtime-fixture.invalid') throw new Error('Unmocked network origin: ' + url.origin)
      if (url.pathname === '/_head/lease') return Response.json({ ok: true, ballId: head.ballId,
        lease: { ownerPeerId: input.ownerPeerId, generation: 1, expiresAt: Date.now() + 60_000 } })
      if (url.pathname === '/_head/ball' && request.method === 'POST') {
        head = input.ball as BallManifest
        return Response.json({ ok: true, ballId: head.ballId })
      }
      if (url.pathname === '/_head/ball') return Response.json({ ball: head, codeBySha: { [originalSha]: original, [uncoveredSha]: uncovered, [badSha]: badCandidate } })
      throw new Error('Unmocked network operation: ' + url.href)
    })
    try {
      const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
      const runtime = await mountX6BallRuntime(context, vfs, loader)
      expect(provided.get('organs')).not.toHaveProperty('__mount')
      expect(provided.has('governance')).toBe(false)
      const beforeRefusal = networkCalls
      const writes = vi.spyOn(vfs, 'writeFileSync')
      // This tests handler refusal, not confidentiality of the global worker channel.
      // Production callers must never send ceremony bearers through that channel.
      const approvalToken = 'q'.repeat(43)
      const promotionBinding = { schema: 'aukora.class3.head-promotion.v1', audience: 'https://runtime-fixture.invalid', action: 'head.promote',
        ballId: 'b'.repeat(64), epoch: 2, organId: 'seed-pearl', candidateSha256: 'c'.repeat(64) }
      for (const body of ['{invalid JSON', JSON.stringify({ approvalToken, binding: promotionBinding })]) {
        const refused = await runtime.handleControlRequest('POST', '/__x6__/governance-approval', body)
        expect(refused).toEqual({ status: 403, body: { ok: false, code: 'CLASS3_PRIVATE_TRANSPORT_UNAVAILABLE' } })
        expect(JSON.stringify(refused)).not.toContain(approvalToken)
      }
      expect(networkCalls).toBe(beforeRefusal)
      expect(writes).not.toHaveBeenCalled()
      writes.mockRestore()
      let confirmations = 0
      tools.register({ name: 'auma_superagent', description: 'synthetic protected confirmation', parameters: {},
        execute: async () => { confirmations++; return { ok: true } } })
      await expect(tools.get('auma_superagent')!.execute({ action: 'confirm', promotionBinding })).rejects.toThrow('CLASS3_OWNER_SIGNATURE_REQUIRED')
      expect(confirmations).toBe(0)
      for (const name of ['seed_calc', 'read_file', 'web_search']) {
        tools.register({ name, description: 'synthetic read/computation', parameters: {}, execute: async () => ({ ok: true, answer: 42 }) })
        expect(await tools.get(name)!.execute({})).toEqual({ ok: true, answer: 42 })
      }
      expect(await tools.get('ball_status')!.execute({ includeManifest: true })).toHaveProperty('entries.seed-new')
      await expect(tools.get('x6_github')!.execute({ action: 'api', method: 'POST' })).rejects.toThrow('CLASS3_OWNER_SIGNATURE_REQUIRED')
      tools.register({ name: 'checkpoint_store', description: 'synthetic historical writer', parameters: {}, execute: async () => ({ ok: true }) })
      await expect(tools.get('checkpoint_store')!.execute({ action: 'delete' })).rejects.toThrow('X6_HISTORY_APPEND_ONLY')
      const service = (globalThis as { __X6_SERVICES__?: Record<string, unknown> }).__X6_SERVICES__!.scion as {
        trialRetentionCandidate(input: {
          organId: string
          candidateSource?: string
          baseline?: boolean
          baselineSpecifier?: string
        }): Promise<{
          qualifiedForPromotion: boolean
          qualificationId: string | null
          organs: Record<string, string>
          trialOk: boolean
          admissionError?: string
          suiteDigest: string
          suiteBytesDigest: string
          suiteAdmission: string
          baselineResult: { organs: Record<string, string> } | null
        }>
      }
      const baseline = await service.trialRetentionCandidate({ organId: 'seed-new', baseline: true })
      expect(baseline.organs['seed-new']).toBe(originalSha)
      expect(baseline.trialOk).toBe(false)
      expect(baseline).toMatchObject({ qualificationId: null, qualifiedForPromotion: false, baselineResult: null })
      await expect(service.trialRetentionCandidate({ organId: 'seed-new', candidateSource: candidate, baselineSpecifier: 'ball:' + sha256HexSync(badCandidate) })).rejects.toThrow('PEARL_BASELINE_OVERRIDE_REFUSED')
      expect(await service.trialRetentionCandidate({ organId: 'seed-new', candidateSource: original })).toMatchObject({ qualificationId: null, qualifiedForPromotion: false, winnerId: null, decidedBy: 'inconclusive' })
      const bad = await service.trialRetentionCandidate({ organId: 'seed-new', candidateSource: badCandidate })
      expect(bad.qualifiedForPromotion).toBe(false)
      expect(bad.qualificationId).toBeNull()
      const admit = () => service.trialRetentionCandidate({ organId: 'seed-new', candidateSource: candidate })
      let admission = await admit()
      if (!pinned) {
        expect(admission.qualifiedForPromotion).toBe(false)
        expect(admission.qualificationId).toBeNull()
        expect(admission.admissionError).toBe('PEARL_SUITE_PIN_UNAVAILABLE')
        await expect(runtime.treePatch({ id: 'seed-new', specifier: 'ball:' + candidateSha })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
        return
      }
      expect(admission.qualificationId).toBeTypeOf('string')
      expect(admission.baselineResult?.organs['seed-new']).toBe(originalSha)
      expect(admission).toMatchObject({ comparisonComplete: true, targetImproved: true, winnerId: 'candidate' })
      expect(admission.suiteDigest).toBe(retentionSuiteDigest(JSON.parse(suiteText) as Record<string, unknown>))
      expect(admission.suiteBytesDigest).toBe(sha256HexSync(suiteText))
      const callerReport = { qualifiedForPromotion: true, comparisonComplete: true, baselineResult: { results: [{ id: 'retained', pass: false }] } }
      expect(await service.trialRetentionCandidate({ ...callerReport, organId: 'seed-new', candidateSource: original })).toMatchObject({ qualifiedForPromotion: false, qualificationId: null, winnerId: null })
      if (pin === 'baseline') {
        const rawSuite = Buffer.concat([Buffer.from(suiteText.slice(0, -1) + ',"note":"'), Buffer.from([0xff]), Buffer.from('"}')])
        vfs.writeFileSync(suitePath, rawSuite)
        expect(await admit()).toMatchObject({ qualifiedForPromotion: true, suiteBytesDigest: sha256HexSync(rawSuite) })
        expect(sha256HexSync(rawSuite)).not.toBe(sha256HexSync(vfs.readFileSync(suitePath, 'utf8')))
        vfs.writeFileSync(suitePath, suiteText)
        for (const fault of ['incomplete', 'timeout', 'suite-change', 'raw-change', 'restored-after-candidate'] as const) {
          let arm = 0
          class InterruptedWorker {
            readonly baseline = ++arm === 2
            readonly listeners = new Map<string, (event: { data: unknown }) => void>()
            addEventListener(event: string, callback: (event: { data: unknown }) => void) { this.listeners.set(event, callback) }
            terminate() {}
            postMessage(message: { id: string; input: { cases: { id: string; expect: unknown }[] } }) {
              if (fault === 'suite-change' && this.baseline) vfs.writeFileSync(suitePath, JSON.stringify({ ...JSON.parse(suiteText), fixedNow: 2000 }))
              if (fault === 'raw-change' && this.baseline) vfs.writeFileSync(suitePath, JSON.stringify(JSON.parse(suiteText), null, 2))
              if (fault === 'restored-after-candidate') vfs.writeFileSync(suitePath, this.baseline ? suiteText : JSON.stringify({ ...JSON.parse(suiteText), fixedNow: 2000 }))
              const results = this.baseline && (fault === 'incomplete' || fault === 'timeout') ? []
                : message.input.cases.map(test => ({ id: test.id, pass: true, got: this.baseline ? { ok: true, value: 43 } : test.expect }))
              this.listeners.get('message')?.({ data: { t: 'scion-trial-result', id: message.id,
                result: { ok: true, durationMs: 1, results, ...(this.baseline && fault === 'timeout' ? { error: 'CANDIDATE_TRIAL_TIMEOUT' } : {}) } } })
            }
          }
          const descriptors = ['Worker', 'self'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
          try {
            Object.defineProperty(globalThis, 'Worker', { configurable: true, value: InterruptedWorker })
            Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: 'https://trial.invalid/worker.js' } } })
            const admitted = await admit()
            expect(admitted).toMatchObject({
              qualifiedForPromotion: false, qualificationId: null, comparisonComplete: false, winnerId: null,
            })
            // Round 37: a baseline that observed no case is refused by name, not scored as a zero.
            if (fault === 'incomplete' || fault === 'timeout') {
              expect((admitted as { arenaRefusal?: string }).arenaRefusal).toMatch(/^ARENA_ZERO_OBSERVATIONS: the baseline arm ran no case/)
              // The candidate arm's own error is untouched (Pearl reports it per arm).
              expect(String((admitted as { error?: string }).error ?? '')).not.toContain('ARENA_ZERO_OBSERVATIONS')
            } else expect((admitted as { arenaRefusal?: string }).arenaRefusal).toBeUndefined()
            expect(arm).toBe(2)
          } finally {
            for (const [key, descriptor] of descriptors) {
              if (descriptor) Object.defineProperty(globalThis, key, descriptor)
              else Reflect.deleteProperty(globalThis, key)
            }
            vfs.writeFileSync(suitePath, suiteText)
          }
        }
      }
      expect(await service.trialRetentionCandidate({ organId: 'seed-uncovered', candidateSource: uncovered })).toMatchObject({ targetCovered: false, qualifiedForPromotion: false, qualificationId: null })
      const grownSuite = { ...baselineSuite, organs: ['seed-new', 'seed-uncovered'], fixtures: { empty: {}, extra: {} }, cases: [...(baselineSuite.cases as unknown[]),
        { id: 'added', args: { organ: 'seed-new', fixture: 'extra', input: { value: 43 }, pick: ['value'] }, expect: { ok: true, value: 43 } }] }
      const grownText = JSON.stringify(grownSuite, null, 2)
      vfs.writeFileSync(suitePath, grownText)
      const grownAdmission = await admit()
      if (pin === 'baseline') {
        expect(grownAdmission).toMatchObject({ qualifiedForPromotion: true, suiteAdmission: 'build-pinned', suiteDigest: retentionSuiteDigest(grownSuite), suiteBytesDigest: sha256HexSync(grownText) })
        suiteText = grownText
        admission = grownAdmission
        // Neither changing the mutable suite nor mutating the original stamp can repin this runtime.
        const weakened = { ...grownSuite, cases: [grownSuite.cases[1]] }
        baselineSuite.cases = weakened.cases
        buildStamp.retentionBaselineDigest = retentionSuiteDigest(baselineSuite)
        vfs.writeFileSync(suitePath, JSON.stringify(weakened))
        expect(await admit()).toMatchObject({ qualifiedForPromotion: false, qualificationId: null, admissionError: 'PEARL_SUITE_PIN_MISMATCH' })
      } else {
        expect(grownAdmission).toMatchObject({ qualifiedForPromotion: false, qualificationId: null, admissionError: 'PEARL_SUITE_PIN_MISMATCH' })
      }
      vfs.writeFileSync(suitePath, suiteText)
      const patch = { id: 'seed-new', specifier: 'ball:' + candidateSha, qualificationId: admission.qualificationId! }
      const before = activations
      await expect(runtime.treePatch({ id: patch.id, specifier: patch.specifier })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      let stagedReview: string | null = null
      for (const id of ['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura']) {
        await expect(runtime.treePatch({ ...patch, id: id + ':' + candidateSha })).rejects.toThrow(
          stagedReview === null ? 'CLASS3_WEBAUTHN_REQUIRED' : 'STAGED_PROMOTION_REVIEW_CONFLICT')
        const review = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
        if (stagedReview === null) {
          stagedReview = review
          const staged = JSON.parse(review) as { body: { ball: BallManifest; writerLease?: unknown } }
          expect(staged.body.ball.entries[id + ':' + candidateSha]?.specifier).toBe(patch.specifier)
          expect(staged.body.ball.parentBallId).toBe(head.ballId)
          expect(staged.body).not.toHaveProperty('writerLease')
        } else expect(review).toBe(stagedReview)
        expect(runtime.status().ballId).toBe(head.ballId)
        expect(activations).toBe(before)
      }
      await expect(runtime.treePatch({ ...patch, id: 'private-key-export' })).rejects.toThrow('CLASS4_UNREACHABLE_BY_CONSTRUCTION')
      await expect(runtime.treeUndo({ id: 'seed-new' })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      await expect(runtime.treePatch({ ...patch, qualificationId: 'caller-forged' })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      await expect(runtime.treePatch({ ...patch, specifier: 'ball:' + originalSha })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      await expect(runtime.treePatch({ ...patch, id: 'another-entry' })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      await expect(runtime.treePatch({ ...patch, config: {} })).rejects.toThrow('PEARL_QUALIFICATION_SCOPE_REFUSED')
      await expect(runtime.treePatch({ ...patch, disabled: false })).rejects.toThrow('PEARL_QUALIFICATION_SCOPE_REFUSED')
      vfs.writeFileSync(suitePath, JSON.stringify({ ...JSON.parse(suiteText), fixedNow: 2000 }))
      await expect(runtime.treePatch(patch)).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      expect(activations).toBe(before)
      vfs.writeFileSync(suitePath, suiteText)
      admission = await admit()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1)
      try { await expect(runtime.treePatch({ ...patch, qualificationId: admission.qualificationId! })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE') }
      finally { clock.mockRestore() }
      admission = await admit()
      const sameHeadAdmission = await admit()
      vfs.writeFileSync(suitePath, JSON.stringify({ ...JSON.parse(suiteText), pendingCases: [{ id: 'proposal-only' }] }, null, 2))
      const snapshots = provided.get('snapshots') as { list(): { snapshotId: string }[] }
      const snapshotPath = '/dsh/home/auma/snapshots/' + snapshots.list()[0]!.snapshotId + '.json'
      const savedSnapshot = vfs.readFileSync(snapshotPath, 'utf8') as string
      const corrupted = JSON.parse(savedSnapshot) as Record<string, unknown>
      vfs.writeFileSync(snapshotPath, JSON.stringify({ ...corrupted, handoffMd: 'forged recovery state' }))
      await expect(runtime.treePatch({ ...patch, qualificationId: admission.qualificationId! })).rejects.toThrow('X6_HISTORY_APPEND_ONLY')
      expect(activations).toBe(before)
      vfs.writeFileSync(snapshotPath, savedSnapshot)
      const result = await runtime.treePatch({ ...patch, qualificationId: admission.qualificationId! })
      expect(result.entry.specifier).toBe('ball:' + candidateSha)
      // Live persistence remains explicitly unconfirmed in this in-memory fixture.
      expect(result.mutation.localSaved).toBe(false)
      await expect(runtime.treePatch({ ...patch, qualificationId: sameHeadAdmission.qualificationId! })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      await expect(runtime.treePatch({ ...patch, qualificationId: admission.qualificationId! })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
      // A fresh direct comparison cannot bypass a passing incumbent by choosing its weak predecessor.
      expect(await service.trialRetentionCandidate({ organId: 'seed-new', candidateSource: candidate + '\n// tied revision' })).toMatchObject({
        comparisonComplete: true, qualifiedForPromotion: false, qualificationId: null, winnerId: null, decidedBy: 'inconclusive',
        baselineResult: { organs: { 'seed-new': candidateSha } },
      })
      expect(await service.trialRetentionCandidate({ organId: 'seed-new', baseline: true })).toMatchObject({ trialOk: true, qualificationId: null, qualifiedForPromotion: false })
      if (pin === 'baseline') {
        expect(await service.trialRetentionCandidate({ organId: 'seed-uncovered', candidateSource: uncoveredCandidate })).toMatchObject({ targetCovered: false, qualifiedForPromotion: false, qualificationId: null })
        vfs.writeFileSync(suitePath, JSON.stringify({ ...grownSuite, cases: [...grownSuite.cases,
          { id: 'cover-new-organ', args: { organ: 'seed-uncovered', fixture: 'extra', input: { value: 44 }, pick: ['value'] }, expect: { ok: true, value: 44 } }] }))
        expect(await service.trialRetentionCandidate({ organId: 'seed-uncovered', candidateSource: uncoveredCandidate })).toMatchObject({ targetCovered: true, qualifiedForPromotion: true, suiteAdmission: 'build-pinned', targetImproved: true })
      }
    } finally { vi.unstubAllGlobals() }
  })

  it('collects only verified active Seed image files, excluding dirty copies and private backups', async () => {
    const collectSeedImageFiles = await fixtureFunction('../../../../../server/build-preview.mjs', 'collectSeedImageFiles')
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pearl-image-fixture-')))
    const code = 'module.exports = { name: "seed-fixture" };'
    const digest = sha256HexSync(code)
    try {
      for (const directory of ['home/balls', 'home/auma/seed/organs', 'home/auma/seed/pearl', 'home/auma/seed/.conflict-backup']) await mkdir(path.join(root, 'mirror', directory), { recursive: true })
      const write = (name: string, text: string) => writeFile(path.join(root, 'mirror', name), text)
      await write('home/balls/HEAD.json', JSON.stringify({ version: 'x6.1-ball/v1', entries: { 'seed-fixture': { specifier: 'ball:' + digest } } }))
      await write('home/balls/' + digest + '.js', code)
      await write('home/auma/seed/organs/seed-fixture.js', '// unpublished working copy')
      await write('home/auma/seed/pearl/retention-suite.v1.json', '{"cases":[]}')
      await write('home/auma/seed/scars.jsonl', '{"id":"synthetic"}\n')
      await write('home/auma/seed/.conflict-backup/private.json', 'fixture-private')
      await write('home/auma/seed/receipts.v3.jsonl', 'fixture-receipts')
      const collected = await collectSeedImageFiles(root)
      if (!collected || typeof collected !== 'object' || Array.isArray(collected)
        || !Object.values(collected).every(bytes => bytes instanceof Uint8Array)) throw new Error('Fixture returned invalid Seed image files')
      const files = collected as Record<string, Uint8Array>
      expect(Object.keys(files).sort()).toEqual(['home/auma/seed/organs/seed-fixture.js', 'home/auma/seed/pearl/retention-suite.v1.json', 'home/auma/seed/scars.jsonl'])
      expect(Buffer.from(files['home/auma/seed/organs/seed-fixture.js']!).toString()).toBe(code)
      await write('home/balls/' + digest + '.js', 'wrong bytes')
      await expect(collectSeedImageFiles(root)).rejects.toThrow('hash mismatch')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('attaches bounded gateway model headers without consuming an open SSE response', async () => {
    const createWorker = await fixtureFunction('../../../../../deploy/cloudflare/src/worker.mjs', 'createWorker')
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let calls = 0
    let reservations = 0
    const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { upstreamController = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n')) } })
    const binding = (phase: string) => ({ idFromName: () => 'test', get: () => ({ fetch: async (request: Request) => {
      if (new URL(request.url).pathname === '/_head/provider-budget') {
        reservations++
        const input = await request.json() as { provider: string; tokens: number }
        expect(input.provider).toBe('openai')
        expect(input.tokens).toBeGreaterThan(32)
        return Response.json({ ok: true, reservedTokens: input.tokens })
      }
      // Real-shaped ids: since an earlier commit the edge counts itself booted only when HEAD and the mirror name a valid seed and Pearl.
      return Response.json({ ok: true, phase, seedId: 'b'.repeat(64), ballId: 'a'.repeat(64), epoch: 1 })
    } }) })
    const env = { PUBLIC_HOST: 'provider-fixture.example.invalid', OWNER_EMAIL: 'fixture@example.invalid', ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture',
      HEAD: binding('complete'), MIRROR: binding('ready'), OPENAI_API_KEY: 'synthetic-key',
      PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '10', PROVIDER_BUDGET_TOKENS: '10000', PROVIDER_MAX_OUTPUT_TOKENS: '1000' }
    const worker = createWorker({ verifyAccess: async () => true, networkFetch: async () => {
      calls++
      return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream', 'openai-model': 'reported-model-v2' } })
    } })
    if (!worker || typeof worker !== 'object' || !('fetch' in worker) || typeof worker.fetch !== 'function') throw new Error('Fixture returned invalid Worker')
    const response: unknown = await worker.fetch(new Request('https://' + env.PUBLIC_HOST + '/door/openai/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-model': 'caller-spoof' },
      body: JSON.stringify({ model: 'requested-alias', messages: [{ role: 'user', content: 'Synthetic text' }], stream: true, max_tokens: 32 }),
    }), env)
    if (!(response instanceof Response)) throw new Error('Fixture returned invalid response')
    expect(response.status).toBe(200)
    expect(calls).toBe(1)
    expect(reservations).toBe(1)
    expect(response.body).toBe(upstreamBody)
    expect(JSON.parse(response.headers.get('x-x6-model-attribution')!)).toEqual({ requestedModel: 'requested-alias', providerReportedModel: 'reported-model-v2', immutableRevision: null, evidenceQuality: 'gateway-observed' })
    upstreamController!.close()
    expect(await response.text()).toBe('data: first\n\n')
  })

  it('runs four bound grader controls independently of a positive or negative candidate verdict', async () => {
    const code = 'module.exports = { name: "seed-control", run() { return { ok: true, value: 7 }; } };'
    for (const value of [7, 9]) {
      const result = await trialScionCandidate({ name: 'seed-control', code, cases: [{ id: 'value', expect: { ok: true, value } }] })
      expect(result.ok).toBe(value === 7)
      expect(result.graderControls).toMatchObject({
        knownGoodAccepted: true, knownBadRejected: true, acceptAllRejected: true, rejectAllRejected: true, allPassed: true,
      })
      expect(result.graderControls?.caseSetDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.routeEvidence).toMatchObject({ status: 'checked', candidateDigest: sha256HexSync(code), unsupportedProperties: ['execution-containment'] })
      expect(result.negativeControlRejected).toBe(true)
    }
  })

  it('does not promote unsupported capability declarations into route compliance', async () => {
    const result = await trialScionCandidate({ name: 'seed-route', code: 'module.exports = { name: "seed-route", run() { return true; } };',
      cases: [{ id: 'route', expect: true, routePolicy: { policyId: 'no-ambient/v1', requiredExports: ['run'], allowedCapabilities: [], forbidEnvKeys: ['SECRET'], heldOutPerturbations: [] } }] })
    expect(result.ok).toBe(true)
    expect(result.routeEvidence?.status).toBe('unsupported')
    expect(result.routeEvidence?.checkedProperties).not.toContain('only-approved-export-and-fixtures-used')
    expect(result.routeEvidence?.unsupportedProperties).toContain('allowedCapabilities')
    const invalid = await trialScionCandidate({ name: 'seed-route', code: 'module.exports = {};', cases: [{ expect: true, routePolicy: { requiredExports: ['x'.repeat(129)] } }] })
    expect(invalid.ok).toBe(false)
    expect(invalid.routeEvidence?.status).toBe('inconclusive')
  })

  it('ignores forged worker pass flags, controls and digest claims when regrading outputs', async () => {
    class ForgedWorker {
      listeners = new Map<string, (event: { data: unknown }) => void>()
      addEventListener(event: string, callback: (event: { data: unknown }) => void) { this.listeners.set(event, callback) }
      terminate() {}
      postMessage(message: { id: string }) {
        this.listeners.get('message')?.({ data: { t: 'scion-trial-result', id: message.id, result: {
          ok: true, durationMs: 1, results: [{ id: 'must-fail', pass: true, got: false }],
          graderControls: { allPassed: true, runnerDigest: 'forged' }, routeEvidence: { status: 'checked', candidateDigest: 'forged' },
        } } })
      }
    }
    vi.stubGlobal('Worker', ForgedWorker)
    vi.stubGlobal('self', { location: { href: 'https://trial.invalid/worker.js' } })
    try {
      const result = await trialScionCandidate({ name: 'seed-forged', code: 'module.exports = {};', cases: [{ id: 'must-fail', expect: true }] })
      expect(result.ok).toBe(false)
      expect(result.results[0]?.pass).toBe(false)
      expect(result.graderControls?.runnerDigest).not.toBe('forged')
      expect(result.routeEvidence?.candidateDigest).toBe(sha256HexSync('module.exports = {};'))
    } finally { vi.unstubAllGlobals() }
  })

  it('starts trials from the boot copy of the worker bundle once a deploy retires its URL, and names an empty trial', async () => {
    const href = 'https://trial.invalid/worker-retired-by-deploy.js'
    const started: string[] = []
    class RetiredUrlWorker {
      readonly listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>()
      constructor(readonly url: string) { started.push(url) }
      addEventListener(event: string, callback: (event: { data?: unknown; message?: string }) => void) {
        this.listeners.set(event, callback)
      }
      terminate() {}
      postMessage(message: { id: string; input: { cases: { id: string; expect: unknown }[] } }) {
        queueMicrotask(() => {
          // The served URL is gone after the deploy; only the in-memory copy still loads.
          if (!this.url.startsWith('blob:')) { this.listeners.get('error')?.({ message: '' }); return }
          this.listeners.get('message')?.({ data: { t: 'scion-trial-result', id: message.id, result: {
            ok: true, durationMs: 1, results: message.input.cases.map(test => ({ id: test.id, pass: true, got: test.expect })),
          } } })
        })
      }
    }
    const cases = [{ id: 'one', args: {}, expect: { ok: true } }]
    vi.stubGlobal('Worker', RetiredUrlWorker)
    vi.stubGlobal('self', { location: { href } })
    try {
      const retired = await trialScionCandidate({ name: 'seed-copy', code: 'module.exports = {};', cases })
      expect(started).toEqual([href])
      expect(retired.ok).toBe(false)
      expect(retired.results).toEqual([])
      expect(retired.error).toBe('CANDIDATE_TRIAL_EMPTY: CANDIDATE_TRIAL_WORKER_FAILED: the trial worker did not load or crashed')
      const reads: string[] = []
      vi.stubGlobal('fetch', async (resource: RequestInfo | URL) => {
        reads.push(String(resource))
        return new Response('/* the running worker bundle */', { headers: { 'content-type': 'text/javascript' } })
      })
      const copy = await primeScionTrialScript()
      expect(reads).toEqual([href])
      expect(copy).toMatch(/^blob:/)
      expect(await primeScionTrialScript()).toBe(copy)
      const result = await trialScionCandidate({ name: 'seed-copy', code: 'module.exports = {};', cases })
      expect(started).toEqual([href, copy])
      expect(result.error).toBeUndefined()
      expect(result.results.map(row => row.pass)).toEqual([true])
      expect(reads).toEqual([href])
      // A boot copy still downloading never holds a trial: it starts from the served URL within the trial's own time.
      const stalled = 'https://trial.invalid/worker-still-downloading.js'
      vi.stubGlobal('self', { location: { href: stalled } })
      vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
      void primeScionTrialScript()
      const started0 = Date.now()
      const waited = await trialScionCandidate({ name: 'seed-copy', code: 'module.exports = {};', cases, timeoutMs: 300 })
      expect(started.at(-1)).toBe(stalled)
      expect(waited.error).toMatch(/^CANDIDATE_TRIAL_EMPTY: CANDIDATE_TRIAL_WORKER_FAILED/)
      expect(Date.now() - started0).toBeLessThan(2000)
    } finally { vi.unstubAllGlobals() }
  })

  it('uses the runtime retention harness for arbitrary named organs and all cases', async () => {
    const build = { 'seed-new-organ': 'module.exports = { name: "seed-new-organ", run(args) { return { ok: true, value: args.value }; } };' }
    const result = await trialScionRetention(build, { fixedNow: 1000, fixtures: { empty: {} }, cases: [
      { id: 'one', args: { organ: 'seed-new-organ', fixture: 'empty', input: { value: 1 }, pick: ['value'] }, expect: { ok: true, value: 1 } },
      { id: 'two', args: { organ: 'seed-new-organ', fixture: 'empty', input: { value: 2 }, pick: ['value'] }, expect: { ok: true, value: 3 } },
    ] })
    expect(result.ok).toBe(false)
    expect(result.results.map(row => row.pass)).toEqual([true, false])
    expect(result.graderControls?.allPassed).toBe(true)
  })

  it('hydrates missing active named sources without replacing dirty files or accepting corrupt content', () => {
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/balls', { recursive: true })
    const old = 'module.exports = { name: "seed-probe" };'
    const next = 'module.exports = { name: "seed-probe", version: 2 };'
    const manifest = (code: string): BallManifest => ({ version: 'x6.1-ball/v1', ballId: sha256HexSync(code), parentBallId: null, epoch: 1, createdAt: 1, authorPeerId: 'test', modules: {},
      entries: { 'seed-probe': { id: 'seed-probe', specifier: 'ball:' + sha256HexSync(code), config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1 } } })
    const source = '/dsh/home/auma/seed/organs/seed-probe.js'
    vfs.writeFileSync('/dsh/home/balls/' + sha256HexSync(old) + '.js', old)
    vfs.writeFileSync('/dsh/home/balls/' + sha256HexSync(next) + '.js', next)
    expect(hydrateNamedOrganSources(vfs, manifest(old)).written).toEqual(['seed-probe'])
    expect(hydrateNamedOrganSources(vfs, manifest(next), manifest(old)).written).toEqual(['seed-probe'])
    expect(vfs.readFileSync(source, 'utf8')).toBe(next)
    vfs.writeFileSync(source, '// pending edit')
    expect(hydrateNamedOrganSources(vfs, manifest(old), manifest(next)).preserved).toEqual(['seed-probe'])
    expect(vfs.readFileSync(source, 'utf8')).toBe('// pending edit')
    vfs.writeFileSync('/dsh/home/balls/' + sha256HexSync(old) + '.js', 'corrupt')
    expect(hydrateNamedOrganSources(vfs, manifest(old)).unavailable).toEqual(['seed-probe'])
  })

  it('isolates globalThis and Object.prototype mutations in a disposable worker realm', async () => {
    const code = `
      module.exports = {
        name: 'seed-probe',
        async run(args) {
          globalThis.pwnedByCandidate = 'yes';
          Object.prototype.pollutedByCandidate = 'yes';
          return { ok: true, echoed: args.value };
        }
      };
    `
    const res = await trialScionCandidate({
      name: 'seed-probe',
      code,
      cases: [{ id: 'c1', args: { value: 42 }, expect: { ok: true, echoed: 42 } }],
    })
    expect(res.ok).toBe(true)
    expect((globalThis as Record<string, unknown>).pwnedByCandidate).toBeUndefined()
    expect(({} as Record<string, unknown>).pollutedByCandidate).toBeUndefined()
  })

  it('blocks network, filesystem, process, and live-organ mutations inside the trial worker', async () => {
    const code = `
      module.exports = {
        name: 'seed-escape',
        async run(args, ctx) {
          if (args.mode === 'fetch') return await fetch('https://example.com');
          if (args.mode === 'fs') return require('node:fs').readFileSync('/etc/passwd', 'utf8');
          if (args.mode === 'proc') return process.getBuiltinModule('node:fs');
          if (args.mode === 'organ') return await ctx.organs.install({});
          return { ok: true };
        }
      };
    `
    const res = await trialScionCandidate({
      name: 'seed-escape',
      code,
      cases: [
        { id: 'block-fetch', args: { mode: 'fetch' }, expectError: 'CANDIDATE_TRIAL_IO_FORBIDDEN' },
        { id: 'block-fs', args: { mode: 'fs' }, expectError: 'CANDIDATE_TRIAL_IMPORT_BLOCKED' },
        { id: 'block-proc', args: { mode: 'proc' }, expectError: 'CANDIDATE_TRIAL_PROCESS_FORBIDDEN' },
        { id: 'block-organ', args: { mode: 'organ' }, expectError: 'CANDIDATE_TRIAL_MUTATION_FORBIDDEN' },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.results).toHaveLength(4)
  })

  it('terminates synchronous infinite loops via worker timeout without hanging caller', async () => {
    const code = `
      module.exports = {
        name: 'seed-hang',
        run() {
          while (true) {}
        }
      };
    `
    const res = await trialScionCandidate({
      name: 'seed-hang',
      code,
      cases: [{ id: 'loop', args: {}, expect: { ok: true } }],
      timeoutMs: 150,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('CANDIDATE_TRIAL_TIMEOUT')
  })

  it('refuses growScionOrgan during mandatory candidate-trial before live cycle is invoked', async () => {
    const badCode = `
      module.exports = {
        name: 'seed-bad',
        async run() { return { ok: true, wrong: 1 }; }
      };
    `
    const sha256 = sha256HexSync(badCode)
    let cycleCalled = false
    const result = await growScionOrgan(
      {
        name: 'seed-bad',
        entry: 'index.ts',
        files: { 'index.ts': 'export default {}' },
        cases: [{ id: 'must-match', args: {}, expect: { ok: true, wrong: 2 } }],
      },
      {
        head: () => 'head-1',
        writable: () => true,
        active: () => false,
        prepare: async () => ({
          ok: true,
          compiled: true,
          prepared: true,
          activated: false,
          localSaved: true,
          code: badCode,
          sha256,
          specifier: `ball:${sha256}`,
          inputRoot: 'root-1',
          compiler: SCION_COMPILER,
          modules: 1,
          warnings: [],
        }),
        cycle: async () => {
          cycleCalled = true
          return { ok: true, phase: 'grown' }
        },
      },
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('candidate-trial')
    expect(result.activationAttempted).toBe(false)
    expect(cycleCalled).toBe(false)
  })

  // Attack 1: the result frame must come from the trial runner, never from candidate code.
  it('node trial: candidate cannot reach parentPort or the real require to post a forged passing result', async () => {
    const code = `
      const forged = { ok: true, results: [{ id: 'must-fail', pass: true, got: { ok: true } }], durationMs: 1 };
      const tried = [];
      try { parentPort.postMessage(forged); tried.push('parentPort'); } catch (e) { tried.push('parentPort:' + e.constructor.name); }
      try { require('node:worker_threads').parentPort.postMessage(forged); tried.push('require'); } catch (e) { tried.push('require:blocked'); }
      try { globalThis.require('node:worker_threads').parentPort.postMessage(forged); tried.push('global-require'); } catch (e) { tried.push('global-require:blocked'); }
      try { workerData.cases.length = 0; tried.push('workerData'); } catch (e) { tried.push('workerData:' + e.constructor.name); }
      module.exports = { name: 'seed-forge', run() { return { ok: false, tried }; } };
    `
    const res = await trialScionCandidate({
      name: 'seed-forge', code, cases: [{ id: 'must-fail', args: {}, expect: { ok: true } }],
    })
    expect(res.ok).toBe(false)
    expect(res.results).toHaveLength(1)
    expect(res.results[0]?.pass).toBe(false)
    expect(res.results[0]?.got).toEqual({
      ok: false, tried: ['parentPort:ReferenceError', 'require:blocked', 'global-require:blocked', 'workerData:ReferenceError'],
    })
  })

  it('node trial: a candidate cannot poison JSON or Array intrinsics to fake a passing comparison', async () => {
    const code = `
      module.exports = {
        name: 'seed-poison',
        run() {
          const tried = [];
          for (const [label, attack] of [
            ['json', () => { JSON.stringify = () => '"same"'; }],
            ['every', () => { Array.prototype.every = () => true; }],
            ['global-json', () => { globalThis.JSON = { stringify: () => '"same"', parse: x => x }; }],
          ]) { try { 'use strict'; attack(); tried.push(label + ':applied'); } catch (e) { tried.push(label + ':refused'); } }
          return { ok: false, wrong: true, tried: JSON.stringify(tried) === '"same"' ? 'poisoned' : 'intact' };
        },
      };
    `
    const res = await trialScionCandidate({
      name: 'seed-poison', code, cases: [{ id: 'cmp', args: {}, expect: { ok: true } }],
    })
    expect(res.ok).toBe(false)
    expect(res.results[0]?.pass).toBe(false)
    expect(res.results[0]?.got).toEqual({ ok: false, wrong: true, tried: 'intact' })
  })

  // Attack 2: import() bypasses safeRequire, so it is refused before evaluation and cannot be
  // assembled at run time from strings.
  it('rejects dynamic import() before evaluation and refuses every string-to-code route at run time', async () => {
    for (const source of [
      'module.exports = { name: "seed-imp", run() { return import("node:fs"); } };',
      'module.exports = { name: "seed-imp", run() { return import /* gap */ ("node:fs"); } };',
      `module.exports = { name: 'seed-imp', run() { return import // gap
        ('node:fs'); } };`,
    ]) {
      const res = await trialScionCandidate({ name: 'seed-imp', code: source, cases: [{ id: 'x', args: {}, expect: { ok: true } }] })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('CANDIDATE_TRIAL_IMPORT_BLOCKED')
    }
    const code = `
      module.exports = {
        name: 'seed-gen',
        async run(args) {
          const im = 'imp' + 'ort';
          if (args.mode === 'eval') return eval(im + '("node:fs")');
          if (args.mode === 'indirect') return (0, globalThis.eval)(im + '("node:fs")');
          if (args.mode === 'function') return Function('return ' + im + '("node:fs")')();
          if (args.mode === 'ctor') return (() => {}).constructor('return ' + im + '("node:fs")')();
          if (args.mode === 'async') return (async () => {}).constructor('return ' + im + '("node:fs")')();
          if (args.mode === 'gen') return (function* () {}).constructor('yield 1')().next();
          if (args.mode === 'timer') return setTimeout(im + '("node:fs")', 0);
          return { ok: true, imported: false };
        },
      };
    `
    const modes = ['eval', 'indirect', 'function', 'ctor', 'async', 'gen', 'timer']
    const res = await trialScionCandidate({
      name: 'seed-gen',
      code,
      cases: [
        ...modes.map(mode => ({ id: mode, args: { mode }, expectError: 'CANDIDATE_TRIAL_EVAL_FORBIDDEN' })),
        { id: 'plain', args: {}, expect: { ok: true, imported: false } },
      ],
    })
    expect(res.results.map(result => [result.id, result.pass])).toEqual([...modes, 'plain'].map(id => [id, true]))
    expect(res.ok).toBe(true)
  })

  it('does not mistake identifiers or members named like import for a dynamic import', async () => {
    const code = `
      const reimport = x => x;
      const loader = { import: x => x };
      module.exports = { name: 'seed-names', run() { return { ok: true, a: reimport(1), b: loader.import(2) }; } };
    `
    const res = await trialScionCandidate({ name: 'seed-names', code, cases: [{ id: 'n', args: {}, expect: { ok: true, a: 1, b: 2 } }] })
    expect(res.ok).toBe(true)
  })

  it('browser trial worker: candidate cannot post a forged frame, even knowing the request id', async () => {
    const module = fileURLToPath(new URL('../../src/x6/scion-growth.ts', import.meta.url))
    // A dedicated worker realm stands in for DedicatedWorkerGlobalScope: postMessage/close live on the
    // scope's prototype, as they do in a browser, and every frame is forwarded to this test.
    const script = `
      const { parentPort, workerData } = require('node:worker_threads');
      class Scope {
        postMessage(frame) { parentPort.postMessage({ frame }); }
        close() { parentPort.postMessage({ closed: true }); }
        addEventListener() {}
        removeEventListener() {}
      }
      const scope = Object.create(Scope.prototype);
      for (const key of ['postMessage', 'close']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: Scope.prototype[key].bind(scope) });
      Object.setPrototypeOf(globalThis, Object.create(Scope.prototype));
      globalThis.self = globalThis;
      import(workerData.module).then(m => m.runScionTrialWorker(workerData.data, {}));
    `
    const forgery = '{ t: "scion-trial-result", id: "known-id", result: { ok: true, results: [{ id: "c", pass: true }], durationMs: 1 } }'
    const code = `
      const tried = [];
      for (const [label, post] of [
        ['self', () => self.postMessage(${forgery})],
        ['global', () => postMessage(${forgery})],
        ['proto', () => Object.getPrototypeOf(Object.getPrototypeOf(self)).postMessage.call(self, ${forgery})],
        ['close', () => self.close()],
        ['onmessage', () => { self.onmessage = () => {}; }],
      ]) { try { post(); tried.push(label + ':sent'); } catch (e) { tried.push(label + ':' + (String(e.message).includes('CANDIDATE_TRIAL_IO_FORBIDDEN') ? 'forbidden' : e.message)); } }
      module.exports = { name: 'seed-frame', run() { return { ok: false, tried }; } };
    `
    const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const seen: Record<string, unknown>[] = []
      const worker = new Worker(script, {
        eval: true,
        workerData: { module, data: { t: 'scion-trial-start', id: 'known-id', input: { name: 'seed-frame', code, cases: [{ id: 'c', args: {}, expect: { ok: true } }] } } },
      })
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('trial worker did not finish')) }, 10_000)
      worker.on('error', reject)
      worker.on('message', (message: Record<string, unknown>) => {
        seen.push(message)
        if (message.closed === true) { clearTimeout(timer); void worker.terminate(); resolve(seen) }
      })
    })
    const results = frames.filter(message => message.frame !== undefined)
    expect(results).toHaveLength(1)
    const frame = results[0]?.frame as { id: string; result: { ok: boolean; results: { got: unknown }[] } }
    expect(frame.id).toBe('known-id')
    expect(frame.result.ok).toBe(false)
    expect(frame.result.results[0]?.got).toEqual({
      ok: false, tried: ['self:forbidden', 'global:forbidden', 'proto:forbidden', 'close:forbidden', 'onmessage:forbidden'],
    })
    expect(frames.filter(message => message.closed === true)).toHaveLength(1)
  })
})
