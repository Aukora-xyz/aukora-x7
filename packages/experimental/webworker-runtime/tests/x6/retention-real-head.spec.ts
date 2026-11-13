import { readFileSync } from 'node:fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { FakeSocket, headManifestIdCanon, mountE4, putBall } from './e4-fixture.ts'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'
import { retentionSuiteDigest } from '../../src/x6/scion-growth.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { BallManifest } from '../../src/x6/ball-loader.ts'

const root = new URL('../../../../..', import.meta.url)
const W = root.pathname.replace(/\/$/, '')
const HEAD = JSON.parse(readFileSync(W + '/mirror/home/auma/HEAD.json', 'utf8')) as { entries: Record<string, { specifier: string; config: Record<string, unknown> }> }
const headSource = (id: string): string => readFileSync(`${W}/mirror/home/balls/${HEAD.entries[id]!.specifier.slice(5)}.js`, 'utf8')
const APPROVED_TEXT = readFileSync(W + '/packages/experimental/webworker-runtime/tests/x6/fixtures/retention-suite-approved.json', 'utf8')
const APPROVED = JSON.parse(APPROVED_TEXT) as {
  organs: string[]
  fixedNow: number
  fixtures: Record<string, unknown>
  cases: Array<{
    id: string
    author?: string
    args: { organ: string; input?: Record<string, unknown> }
    expect?: Record<string, unknown>
    expectError?: string
  }>
}
const SUITE_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const TARGETS = ['auma-eyes', 'auma-cortex', 'seed-continuity'] as const
type Target = typeof TARGETS[number]
const ALL = [...new Set([...APPROVED.organs, ...APPROVED.cases.map(row => row.args.organ)])]

// Honest fixes: the smallest edit of the HEAD source that answers the owner's row.
const must = (before: string, after: string, what: string): string => {
  if (before === after) throw new Error('probe edit did not apply: ' + what)
  return after
}
const HONEST: Record<Target, string> = {
  'auma-eyes': must(headSource('auma-eyes'), headSource('auma-eyes').replace(/(\n\s*)(const res = await fetch\()/,
    "$1if (origin === 'http://127.0.0.1:4610') throw new Error('EYES_ORIGIN_UNAVAILABLE');$1$2"), 'eyes refuses without a page origin'),
  'auma-cortex': must(headSource('auma-cortex'), headSource('auma-cortex').replace(/name:\s*'auma_cortex'/, "name: 'auma-cortex'"), 'cortex export name'),
  'seed-continuity': must(headSource('seed-continuity'), headSource('seed-continuity').replace(/name:\s*'seed_continuity'/, "name: 'seed-continuity'"), 'continuity export name'),
}
const PEARL = "module.exports = { name: 'seed-pearl', run(args, ctx) { return ctx.scion.trialRetentionCandidate(args) } }"
const realHead = (): Record<string, string> => {
  const sources: Record<string, string> = { 'seed-pearl': PEARL }
  for (const id of ALL) sources[id] = headSource(id)
  return sources
}
const bestCaseHead = (target: Target): Record<string, string> => {
  const sources = realHead()
  for (const other of TARGETS) if (other !== target) sources[other] = HONEST[other]
  return sources
}
async function mount(sources: Record<string, string>, suiteText = APPROVED_TEXT) {
  const context = new Context()
  onTestFinished(async () => {
    await context.fiber.dispose()
    FakeSocket.instances.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const entries: Record<string, BallManifest['entries'][string]> = {}
  const modules: Record<string, BallManifest['modules'][string]> = {}, codeBySha: Record<string, string> = {}
  for (const [id, code] of Object.entries(sources)) {
    const sha = sha256HexSync(code)
    entries[id] = { id, specifier: 'ball:' + sha, config: { ...HEAD.entries[id]?.config }, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
    modules[sha] = { sha256: sha, specifier: 'ball:' + sha, name: id, description: 'verify-1', size: code.length, createdAt: 1000 }
    codeBySha[sha] = code
  }
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: 20, createdAt: 1000, authorPeerId: 'fixture', entries, modules }
  const head = { ball: { ...body, ballId: headManifestIdCanon(body) }, codeBySha }
  // The pin exactly as the build would stamp it for the approved suite.
  const baseline = JSON.parse(suiteText) as Record<string, unknown>
  const buildIdentity = { retentionBaselineSuite: baseline, retentionBaselineDigest: retentionSuiteDigest(baseline) }
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma/seed/pearl', { recursive: true })
  vfs.writeFileSync(SUITE_PATH, suiteText)
  const mounted = await mountE4({ head, vfs, buildIdentity, nodeBuiltins: true, host: { context, dshTools },
    respond: call => call.path === '/_host/eyes' ? Response.json({ ok: true, fixture: 'eyes-callable' })
      : call.path === '/_head/lease' ? Response.json({ ok: true, ballId: head.ball.ballId,
        lease: { ownerPeerId: (call.body as { ownerPeerId?: string } | null)?.ownerPeerId,
          generation: 1, expiresAt: Date.now() + 60_000 } }) : null })
  const services = (globalThis as { __X6_SERVICES__?: Record<string, unknown> }).__X6_SERVICES__!
  const organs = services.organs as { call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> }
  return { ...mounted, organs, vfs }
}

const challenge = (f: Awaited<ReturnType<typeof mount>>, organId: string, candidateSource: string) =>
  f.organs.call('seed-pearl', { action: 'challenge', organId, candidateSource })

describe('J1 real HEAD repairs and incumbent infrastructure', () => {
  it.each(TARGETS)('Q1/Q5b repairs real HEAD %s when other live obligations already pass', async (target) => {
    const f = await mount(bestCaseHead(target))
    const result = await challenge(f, target, HONEST[target])
    expect(result).toMatchObject({ comparisonComplete: true, targetImproved: true, qualifiedForPromotion: true })
    expect(result.qualificationId).toBeTypeOf('string')
    // Even a fresh patch admission cannot authorize undo, which has no executable issuer.
    await expect(f.runtime.treeUndo({ id: target })).rejects.toThrow('no executable admission issuer for this operation')
    const sha = putBall(f.vfs, HONEST[target])
    if (target === 'seed-continuity') {
      expect(HEAD.entries[target]?.config.governance).toBe(true)
      const before = f.runtime.status().ballId
      await expect(f.runtime.treePatch({ id: target, specifier: 'ball:' + sha,
        qualificationId: String(result.qualificationId) })).rejects.toMatchObject({
        message: expect.stringContaining('CLASS3_OWNER_SIGNATURE_REQUIRED'), notApplied: true,
      })
      expect(f.runtime.status().ballId).toBe(before)
      return
    }
    await expect(f.runtime.treePatch({ id: target, specifier: 'ball:' + sha,
      qualificationId: String(result.qualificationId) })).resolves.toMatchObject({ entry: { specifier: 'ball:' + sha } })
    const row = APPROVED.cases.find(test => test.args.organ === target)!
    const called = f.organs.call(target, row.args.input ?? {})
    if (target === 'auma-eyes') await expect(called).resolves.toEqual({ ok: true, fixture: 'eyes-callable' })
    else {
      if (!row.expect) throw new Error('Approved cortex row has no expected output')
      await expect(called).resolves.toMatchObject(row.expect)
    }
  })

  it('Q8 still admits an ordinary record-free improvement', async () => {
    const sources = bestCaseHead('auma-eyes')
    sources['auma-eyes'] = "module.exports = { name: 'auma-eyes', run() { return { ok: false, error: 'WRONG' } } }"
    const f = await mount(sources)
    expect(await challenge(f, 'auma-eyes', HONEST['auma-eyes'])).toMatchObject({
      comparisonComplete: true, targetImproved: true, qualifiedForPromotion: true,
    })
  })

  it.each(TARGETS)('repairs only %s while unchanged broken HEAD rows remain failures', async (target) => {
    const f = await mount(realHead())
    expect(await challenge(f, target, HONEST[target])).toMatchObject({
      qualifiedForPromotion: true, comparisonComplete: true, ok: true, trialOk: false,
    })
  })

  const quietPeer = "module.exports = { name: 'seed-peer', run() { return { ok: true } } }"
  const refusingCandidate = "module.exports = { name: 'seed-target', run() { throw new Error('UNKNOWN_ACTION') } }"
  const edges = [
    ['E1 peer guard and correct target refusal',
      "async run(args, ctx) { await ctx.organs.call('seed-peer', {}); throw new Error('UNKNOWN_ACTION') }",
      "module.exports = { name: 'seed-peer', async run() { try { await fetch('http://127.0.0.1:9/') } catch {} return { ok: true } } }", false],
    ['E2 own guard and correct target refusal',
      "async run() { try { await fetch('http://127.0.0.1:9/') } catch {} throw new Error('UNKNOWN_ACTION') }", quietPeer, false],
    ['E3 peer export failure',
      "async run(args, ctx) { try { await ctx.organs.call('seed-peer', {}) } catch {} throw new Error('UNKNOWN_ACTION') }",
      "module.exports = { name: 'seed_peer', run() { return { ok: true } } }", false],
    ['E4 own guard is wrong refusal answer',
      "async run() { await fetch('http://127.0.0.1:9/'); throw new Error('UNKNOWN_ACTION') }", quietPeer, true],
    ['peer guard and wrong target answer remains incomplete',
      "async run(args, ctx) { await ctx.organs.call('seed-peer', {}); return { ok: false, error: 'WRONG' } }",
      "module.exports = { name: 'seed-peer', async run() { try { await fetch('http://127.0.0.1:9/') } catch {} return { ok: true } } }", false],
    ...[63, 64].map(count => [
      `C${count} guards cannot hide a later missing dependency`,
      `async run(args, ctx) { for (let i = 0; i < ${count}; i++) { try { await fetch('http://127.0.0.1:9/') } catch {} }
        try { await ctx.organs.call('seed-missing', {}) } catch {} return { ok: false, error: 'WRONG' } }`, quietPeer, false,
    ] as const),
  ] as const
  it.each(edges)('%s', async (_label, run, peer, allowed) => {
    const suiteText = JSON.stringify({ schema: 'aukora.pearl.retention-suite.v1', harness: 'pearl-retention/v1',
      organs: ['seed-target', 'seed-peer'], fixedNow: 1000, fixtures: { empty: {} }, cases: [
        { id: 'refusal', author: 'dot', args: { organ: 'seed-target', fixture: 'empty', input: {} }, expectError: 'UNKNOWN_ACTION' },
      ] })
    const f = await mount({ 'seed-pearl': PEARL, 'seed-target': `module.exports = { name: 'seed-target', ${run} }`,
      'seed-peer': peer }, suiteText)
    const result = await challenge(f, 'seed-target', refusingCandidate)
    expect(result).toMatchObject({ comparisonComplete: allowed, targetImproved: allowed, qualifiedForPromotion: allowed })
    if (allowed) expect(result.qualificationId).toBeTypeOf('string')
    else expect(result).toMatchObject({ qualificationId: null, admissionError: 'PEARL_SUITE_COMPARISON_INCOMPLETE' })
  })
})
