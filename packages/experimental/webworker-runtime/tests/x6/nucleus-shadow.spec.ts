/**
 * The shadow consult. Before a promotion she stages leaves for the edge, her runtime asks the pinned
 * `nucleus` cell what the shipped Touch ID tier reflex says, shows the answer beside her local result and tallies it
 * against the edge's own classification. It decides nothing:
 *  - the tier facts (src/x6/nucleus-tier.ts) never guess: an unknown fact is a closed `FACT_UNKNOWN:<name>`;
 *  - through the real cell on a Node worker, the consult answers as the real classifyTransition, and every failure
 *    (host throws, never answers, refuses, reflex missing or wrong digest) is `{ consult: null, reason }`;
 *  - every promotion fixture, run with the consult returning T1, an escalation, null, a throw, a hang, a missing and a
 *    wrong reflex, sends the edge exactly the bytes it sends with the consult removed, and ends the same way;
 *  - `x6_self_state` shows the tally (`nucleusShadow`) after one agreeing and one disagreeing promotion.
 * Local only: a reserved `.invalid` origin, the e4 fixture's local answers, Node worker_threads for her cell worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STAGED_HEAD_PROMOTION_PATH, T2_ONLY_ORGANS, type BallManifest } from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import * as shadowModule from '../../src/x6/nucleus-shadow.ts'
import { createNucleusShadow, NUCLEUS_CONSULT_BUDGET_MS, NUCLEUS_SHADOW_MISMATCHES_KEPT, TOUCH_ID_TIER_REFLEX_DIGEST,
  TOUCH_ID_TIER_REFLEX_PATH, TOUCH_ID_TIER_REFLEX_SHA256, type NucleusShadow } from '../../src/x6/nucleus-shadow.ts'
import { NUCLEUS_TIER_FACT_NAMES, NUCLEUS_TIER_PROTECTED, nucleusTierDecisionOf, nucleusTierFacts, nucleusTierReasons } from '../../src/x6/nucleus-tier.ts'
import { nucleusShadowView, projectSelfState, SELF_STATE_RESULT_BYTES } from '../../src/x6/self-state.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { type CellHost } from '../../src/x6/wasm-cells.ts'
import { FakeSocket, headManifestIdCanon, liveHead, mountE4, ORGAN_A2, PEARL_V2, putBall, sha256, type Call } from './e4-fixture.ts'
import { disposeCellHosts, realCellHost, REFLEX_BYTES, removedShadow, standInHost, VARIANTS, WRONG_REFLEX,
  type Variant } from './nucleus-fixture.ts'

type J = Record<string, unknown>
const ORIGIN = 'https://lane-e4-fixture.invalid'
interface RealTier { tier: string; requiresPasskey: boolean; t2Reasons: readonly string[] }
interface RealTransition { classifyTransition: (p: unknown, c: unknown, o: unknown) => RealTier; T2_ONLY_ORGANS: readonly string[] }
const real = await import(new URL('../../../../../server/ball-transition.mjs', import.meta.url).href) as unknown as RealTransition

const realHost = (): CellHost => realCellHost(ORIGIN)
afterEach(async () => {
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await disposeCellHosts()
})

// ---------- manifests ----------
const head = liveHead().ball
const childOf = (parent: BallManifest, change: (entries: Record<string, J>) => void): BallManifest => {
  const { ballId: _drop, ...rest } = structuredClone(parent) as unknown as J & { entries: Record<string, J> }
  change(rest.entries)
  const body = { ...rest, parentBallId: parent.ballId, epoch: parent.epoch + 1 }
  return { ...body, ballId: headManifestIdCanon(body) } as unknown as BallManifest
}
const pearlSha = sha256(PEARL_V2), a2Sha = sha256(ORGAN_A2)
const withModule = (ball: BallManifest, id: string, code: string): BallManifest => {
  const sha = sha256(code)
  const { ballId: _drop, ...rest } = structuredClone(ball)
  const body = { ...rest, modules: { ...rest.modules, [sha]: { sha256: sha, specifier: `ball:${sha}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 } } }
  return { ...body, ballId: headManifestIdCanon(body) }
}
const organAUpdate = withModule(childOf(head, (entries) => { entries['organ-a'] = { ...entries['organ-a']!, specifier: `ball:${a2Sha}` } }), 'organ-a', ORGAN_A2)
const pearlUpdate = withModule(childOf(head, (entries) => { entries['seed-pearl'] = { ...entries['seed-pearl']!, specifier: `ball:${pearlSha}` } }), 'seed-pearl', PEARL_V2)

describe('the tier facts: what classifyTransition reads, and never a guess', () => {
  it('protects exactly the organs the judge protects', () => {
    expect([...NUCLEUS_TIER_PROTECTED]).toEqual([...real.T2_ONLY_ORGANS])
    expect([...NUCLEUS_TIER_PROTECTED]).toEqual([...T2_ONLY_ORGANS])
  })

  it('reads one organ update, a governance update, no change and several changes as the judge does', () => {
    const cases: Array<[BallManifest, BallManifest]> = [[head, organAUpdate], [head, pearlUpdate], [head, head],
      [head, childOf(head, (entries) => { entries['organ-a'] = { ...entries['organ-a']!, disabled: true }; entries['seed-pearl'] = { ...entries['seed-pearl']!, config: { a: 1 } } })],
      [head, childOf(head, (entries) => { Reflect.deleteProperty(entries, 'organ-a') })]]
    for (const [previous, candidate] of cases) {
      for (const canonical of [true, false]) {
        const facts = nucleusTierFacts(previous, candidate, { canonicalManifestMatches: canonical })
        expect(facts.ok).toBe(true)
        const judged = real.classifyTransition(previous, candidate, { canonicalManifestMatches: canonical })
        // The reflex's own outcome for this row is the judge's: checked on 20,000 pairs in nucleus-cell.spec.ts.
        expect(nucleusTierDecisionOf(judged.tier, judged.t2Reasons)).not.toBeNull()
        if (facts.ok) expect(facts.facts[6]).toBe(canonical ? 1 : 0)
      }
    }
    expect(nucleusTierFacts(head, organAUpdate, { canonicalManifestMatches: true }))
      .toEqual({ ok: true, facts: [1, 0, 0, 1, 1, 1, 1], row: 79 })
    expect(nucleusTierFacts(head, pearlUpdate, { canonicalManifestMatches: true }))
      .toEqual({ ok: true, facts: [1, 1, 0, 1, 1, 1, 1], row: 111 })
  })

  it('answers FACT_UNKNOWN for a fact it cannot know, and never guesses it', () => {
    expect(nucleusTierFacts(head, organAUpdate)).toEqual({ ok: false, reason: 'FACT_UNKNOWN:canonicalId' })
    expect(nucleusTierFacts(head, organAUpdate, { canonicalManifestMatches: 'true' })).toEqual({ ok: false, reason: 'FACT_UNKNOWN:canonicalId' })
    expect(nucleusTierFacts(head, { ...organAUpdate, entries: null }, { canonicalManifestMatches: true })).toEqual({ ok: false, reason: 'FACT_UNKNOWN:entries' })
    expect(nucleusTierFacts(null, organAUpdate, { canonicalManifestMatches: true })).toEqual({ ok: false, reason: 'FACT_UNKNOWN:entries' })
  })

  it('names outcome bits and reads an edge classification, refusing what the reflex does not speak', () => {
    expect(nucleusTierReasons(256)).toEqual(['T1'])
    expect(nucleusTierReasons(4 | 64)).toEqual(['T2_PROTECTED_ORGAN', 'ORGAN_CONFIG_CHANGED'])
    expect(nucleusTierDecisionOf('T1', [])).toBe(256)
    expect(nucleusTierDecisionOf('T2', ['ORGAN_CONFIG_CHANGED', 'T2_PROTECTED_ORGAN'])).toBe(68)
    for (const [tier, reasons] of [['T1', ['T2_PROTECTED_ORGAN']], ['T2', []], ['T2', ['SOMETHING_NEW']], ['T2', ['T1']], ['T3', []], ['T2', 'x'], [undefined, undefined]] as const) {
      expect(nucleusTierDecisionOf(tier, reasons)).toBeNull()
    }
  })
})

describe('the consult: through her real cell, and every failure a closed null', () => {
  const shadowWith = (cells: () => CellHost, loadReflex: () => Promise<Uint8Array | string> = () => Promise.resolve(REFLEX_BYTES),
    budgetMs?: number) =>
    createNucleusShadow({ loadReflex, cells, now: () => 1_700_000_000_000, ...(budgetMs === undefined ? {} : { budgetMs }) })

  it('answers as the judge on the real cell, loads the reflex once, and tallies agree, mismatch and unknown', async () => {
    const host = realHost()
    const loadReflex = vi.fn(() => Promise.resolve(REFLEX_BYTES))
    const shadow = shadowWith(() => host, loadReflex, 30_000)
    const one = await shadow.consult(head, organAUpdate, { canonicalManifestMatches: true })
    expect(one).toEqual({ nucleus: { decision: 256, reasons: ['T1'], escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 79 }, facts: [1, 0, 0, 1, 1, 1, 1] })
    const judged = real.classifyTransition(head, organAUpdate, { canonicalManifestMatches: true })
    expect(shadow.settle(one, judged)).toBe('agree')
    expect(shadow.settle(one, judged)).toBe('already-settled')
    const two = await shadow.consult(head, pearlUpdate, { canonicalManifestMatches: true })
    expect(two.nucleus).toEqual({ decision: 4, reasons: ['T2_PROTECTED_ORGAN'], escalate: 1, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 111 })
    expect(shadow.settle(two, real.classifyTransition(head, pearlUpdate, { canonicalManifestMatches: true }))).toBe('agree')
    // An edge that said something else: a mismatch, kept with the facts and both outcomes, and nothing more.
    expect(shadow.settle(await shadow.consult(head, pearlUpdate, { canonicalManifestMatches: true }), { tier: 'T1', t2Reasons: [] })).toBe('mismatch')
    expect(shadow.settle(await shadow.consult(head, organAUpdate, { canonicalManifestMatches: true }), null)).toBe('unknown')
    expect(shadow.settle(await shadow.consult(head, organAUpdate, {}), judged)).toBe('unknown')
    expect(loadReflex).toHaveBeenCalledTimes(1)
    const tally = shadow.snapshot()
    expect(tally).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 5, agree: 2, mismatch: 1, unknown: 2, lastMismatches: [{
      at: 1_700_000_000_000,
      facts: { changedOrgans: 1, protected: 1, missing: 0, moduleUpdated: 1, disabledClean: 1, configSame: 1, canonicalId: 1 },
      nucleus: { decision: 4, reasons: ['T2_PROTECTED_ORGAN'], escalate: 1 }, edge: { tier: 'T1', reasons: ['T1'] } }] })
    expect(nucleusShadowView(tally)).toEqual(tally)
    // At most the last eight mismatches are kept.
    for (let n = 0; n < 10; n += 1) shadow.settle(await shadow.consult(head, pearlUpdate, { canonicalManifestMatches: true }), { tier: 'T1', t2Reasons: [] })
    expect(shadow.snapshot()).toMatchObject({ consulted: 15, mismatch: 11 })
    expect(shadow.snapshot().lastMismatches).toHaveLength(NUCLEUS_SHADOW_MISMATCHES_KEPT)
  }, 60_000)

  it('a host that throws, refuses or never answers, and a reflex missing or changed, are each a closed null; it never rejects', async () => {
    const asked = async (shadow: NucleusShadow) => (await shadow.consult(head, organAUpdate, { canonicalManifestMatches: true })).nucleus
    expect(await asked(shadowWith(() => standInHost('throw')))).toEqual({ consult: null, reason: 'CELL_FAILED' })
    expect(await asked(shadowWith(() => { throw new Error('no host') }))).toEqual({ consult: null, reason: 'CELL_FAILED' })
    expect(await asked(shadowWith(() => standInHost('null')))).toEqual({ consult: null, reason: 'CELL_REFUSED:FUEL' })
    const started = performance.now()
    expect(await asked(shadowWith(() => standInHost('hang')))).toEqual({ consult: null, reason: 'TIMEOUT' })
    const waited = performance.now() - started
    expect(waited).toBeGreaterThanOrEqual(NUCLEUS_CONSULT_BUDGET_MS - 50)
    expect(waited).toBeLessThan(NUCLEUS_CONSULT_BUDGET_MS + 1000)
    expect(await asked(shadowWith(() => standInHost('T1'), () => Promise.reject(new Error('404'))))).toEqual({ consult: null, reason: 'REFLEX_UNAVAILABLE' })
    const changed = Uint8Array.from(REFLEX_BYTES)
    changed[100] = changed[100]! ^ 1
    expect(await asked(shadowWith(() => standInHost('T1'), () => Promise.resolve(changed)))).toEqual({ consult: null, reason: 'REFLEX_DIGEST_MISMATCH' })
    expect(await asked(shadowWith(() => standInHost('T1'), () => new Promise(() => {}), 200))).toEqual({ consult: null, reason: 'TIMEOUT' })
    // A cell answer that names another reflex, or another row, is not taken.
    const lying = (result: J): CellHost => ({ ...standInHost('T1'), invoke: () => Promise.resolve({ ok: true, cell: 'nucleus', op: 'reflex.run', fuelUsed: 1, sha256: 'x', result }) })
    expect(await asked(shadowWith(() => lying({ decision: 256, escalate: 0, reflex: 'a'.repeat(64), row: 79 })))).toEqual({ consult: null, reason: 'REFLEX_DIGEST_MISMATCH' })
    expect(await asked(shadowWith(() => lying({ decision: 256, escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 78 })))).toEqual({ consult: null, reason: 'ANSWER_INVALID' })
    expect(TOUCH_ID_TIER_REFLEX_SHA256).toBe(sha256(new TextDecoder().decode(REFLEX_BYTES)))
    expect(TOUCH_ID_TIER_REFLEX_DIGEST).toBe(sha256(new TextDecoder().decode(REFLEX_BYTES).slice(0, -1)))
  }, 30_000)

  it('a reflex read that failed is tried again at the next consult; a file that is not the pinned reflex stays refused (review)', async () => {
    const asked = async (shadow: NucleusShadow) => (await shadow.consult(head, organAUpdate, { canonicalManifestMatches: true })).nucleus
    // The first promotion of the session lands in a network drop: that consult says so, the next one reads again.
    let down = true
    const flaky = vi.fn(() => down ? Promise.reject(new Error('dns drop')) : Promise.resolve(REFLEX_BYTES))
    const shadow = shadowWith(() => standInHost('T1'), flaky)
    expect(await asked(shadow)).toEqual({ consult: null, reason: 'REFLEX_UNAVAILABLE' })
    expect(await asked(shadow)).toEqual({ consult: null, reason: 'REFLEX_UNAVAILABLE' })
    down = false
    expect(await asked(shadow)).toEqual({ decision: 256, reasons: ['T1'], escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 79 })
    expect(await asked(shadow)).toMatchObject({ decision: 256 })
    expect(flaky).toHaveBeenCalledTimes(3) // two failed reads, then one good read kept for the session
    // A read still in flight is shared, never doubled.
    let release: (bytes: Uint8Array) => void = () => {}
    const slow = vi.fn(() => new Promise<Uint8Array>((resolve) => { release = resolve }))
    const shared = shadowWith(() => standInHost('T1'), slow)
    const both = Promise.all([asked(shared), asked(shared)])
    await new Promise(resolve => setTimeout(resolve, 10))
    release(REFLEX_BYTES)
    expect((await both).map(answer => 'decision' in answer ? answer.decision : null)).toEqual([256, 256])
    expect(slow).toHaveBeenCalledTimes(1)
    // A file that arrived but is not the pinned reflex (or not a table over the tier domain) is refused for the session.
    for (const [bytes, reason] of [[WRONG_REFLEX, 'REFLEX_DIGEST_MISMATCH']] as const) {
      const wrong = vi.fn(() => Promise.resolve(bytes))
      const refused = shadowWith(() => standInHost('T1'), wrong)
      expect(await asked(refused)).toEqual({ consult: null, reason })
      expect(await asked(refused)).toEqual({ consult: null, reason })
      expect(wrong).toHaveBeenCalledTimes(1)
    }
  }, 30_000)
})

// ---------- the authority property, through her mounted runtime ----------
const EYES = 'module.exports = { apply() {} }; // nucleus-shadow eyes'
const EARS = 'module.exports = { apply() {} }; // nucleus-shadow ears'
const EXPECTED: Record<Variant, unknown> = {
  removed: { consult: null, reason: 'REMOVED' },
  T1: expect.objectContaining({ decision: 256, reasons: ['T1'], escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST }),
  escalation: expect.objectContaining({ decision: 4, reasons: ['T2_PROTECTED_ORGAN'], escalate: 1, reflex: TOUCH_ID_TIER_REFLEX_DIGEST }),
  null: { consult: null, reason: 'CELL_REFUSED:FUEL' },
  throw: { consult: null, reason: 'CELL_FAILED' },
  hang: { consult: null, reason: 'TIMEOUT' },
  'reflex-missing': { consult: null, reason: 'REFLEX_UNAVAILABLE' },
  'reflex-wrong': { consult: null, reason: 'REFLEX_DIGEST_MISMATCH' },
}

/** HEAD's answers: /_head/stage classified by the REAL classifyTransition, a lease, and a T1 publish. */
function edgeAnswers(variant: Variant): (call: Call) => Response | null {
  return (call) => {
    if (call.method === 'GET' && call.path === TOUCH_ID_TIER_REFLEX_PATH) {
      if (variant === 'reflex-missing' || variant === 'removed') return null
      return new Response(variant === 'reflex-wrong' ? WRONG_REFLEX : REFLEX_BYTES, { headers: { 'content-type': 'application/json' } })
    }
    if (call.method === 'POST' && call.path === '/_head/stage') {
      const ball = (call.body as { body: { ball: BallManifest } }).body.ball
      const judged = real.classifyTransition(head, ball, { canonicalManifestMatches: true })
      const added = Object.keys(ball.entries).filter(id => !Object.hasOwn(head.entries, id)).sort()
      return Response.json({ ok: true, staged: { state: 'awaiting_owner', stagedForOwner: true, ballId: ball.ballId, epoch: ball.epoch,
        tier: judged.tier, t2Reasons: [...judged.t2Reasons], governanceClass: Object.hasOwn(ball.entries, 'seed-pearl')
          && JSON.stringify(ball.entries['seed-pearl']) !== JSON.stringify(head.entries['seed-pearl']) ? 3 : 1,
        binding: null, organSet: added.length ? { schema: 'aukora.head-organ-set.v1', organs: added.map(organId => ({ organId })) } : null } })
    }
    if (call.method === 'POST' && call.path === '/_head/lease') {
      const body = call.body as { action: string; ownerPeerId: string }
      return Response.json(body.action === 'acquire'
        ? { ok: true, ballId: head.ballId, epoch: head.epoch,
          lease: { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: 1_700_000_030_000 } }
        : { ok: true, released: true })
    }
    if (call.method === 'POST' && call.path === '/_head/ball') {
      const ball = (call.body as { ball: BallManifest }).ball
      return Response.json({ ok: true, ballId: ball.ballId, epoch: ball.epoch, tier: 'T1' })
    }
    return null
  }
}

/** `edge`: the decision the edge's answer stands for (real classifyTransition on a stage; the publish's T1). */
type Fixture = { name: string; edge: number; run: (m: Awaited<ReturnType<typeof mountE4>>) => Promise<J> }
const stageFile = (m: Awaited<ReturnType<typeof mountE4>>, ball: BallManifest, codeBySha: Record<string, string>) => {
  m.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
  m.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, `${JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
    body: { ball, codeBySha, expectedParentBallId: head.ballId, expectedEpoch: head.epoch } })}\n`)
}
const FIXTURES: readonly Fixture[] = [
  { name: 'stage_organ_promotion, an ordinary organ', edge: 256, run: async (m) => {
    putBall(m.vfs, ORGAN_A2)
    return await m.tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${a2Sha}` }) as J
  } },
  { name: 'stage_organ_promotion, a governance organ', edge: 4, run: async (m) => {
    putBall(m.vfs, PEARL_V2)
    return await m.tool('stage_organ_promotion').execute({ id: 'seed-pearl', specifier: `ball:${pearlSha}` }) as J
  } },
  { name: 'stage_organ_set_promotion', edge: 2, run: async (m) => {
    putBall(m.vfs, EYES)
    putBall(m.vfs, EARS)
    return await m.tool('stage_organ_set_promotion').execute({ organs: [{ id: 'eyes', specifier: `ball:${sha256(EYES)}` },
      { id: 'ears', specifier: `ball:${sha256(EARS)}` }] }) as J
  } },
  { name: 'promote_staged, a T2 candidate (staged for Touch ID)', edge: 4, run: async (m) => {
    stageFile(m, pearlUpdate, { [pearlSha]: PEARL_V2 })
    return await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
  } },
  { name: 'promote_staged, a T1 candidate (lease and publish)', edge: 256, run: async (m) => {
    stageFile(m, organAUpdate, { [a2Sha]: ORGAN_A2 })
    return await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
  } },
]

/** Everything but the consult's own answer, with the per-operation random ids taken out. */
const withoutNucleus = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNucleus)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'nucleus' && key !== 'operationId').map(([key, child]) => [key, withoutNucleus(child)]))
}
async function runOnce(fixture: Fixture, variant: Variant) {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  vi.spyOn(Math, 'random').mockReturnValue(0.4242)
  const asked: unknown[] = []
  if (variant === 'removed') vi.spyOn(shadowModule, 'createNucleusShadow').mockReturnValue(removedShadow)
  else vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(standInHost(variant === 'reflex-missing' || variant === 'reflex-wrong' ? 'T1' : variant, asked))
  const m = await mountE4({ vfs: new MemoryVfs(), respond: edgeAnswers(variant) })
  m.calls.length = 0
  const result = await fixture.run(m)
  const calls = m.calls.map(call => ({ method: call.method, path: call.path, body: JSON.stringify(call.body),
    headers: [...call.headers.entries()].filter(([name]) => name !== 'x-x6-operation-id').sort() }))
  const review = m.vfs.existsSync(STAGED_HEAD_PROMOTION_PATH) ? m.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string : null
  const selfState = await m.tool('x6_self_state').execute({}) as J
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  return { result, calls, review, asked, shadow: selfState.nucleusShadow as J }
}

describe('nothing in her authority path reads the consult: identical requests and outcomes whatever it answers', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: the consult removed, T1, an escalation, null, a throw, a hang, a missing and a wrong reflex`, async () => {
      const runs = new Map<Variant, Awaited<ReturnType<typeof runOnce>>>()
      for (const variant of VARIANTS) runs.set(variant, await runOnce(fixture, variant))
      const base = runs.get('removed')!
      const edgeBound = (run: typeof base) => run.calls.filter(call => !call.path.startsWith('/cells/'))
      expect(edgeBound(base).some(call => call.method === 'POST')).toBe(true)
      expect(base.calls.filter(call => call.path.startsWith('/cells/'))).toEqual([])
      expect(base.result.ok === true || base.result.edgeStaged === true).toBe(true)
      for (const variant of VARIANTS) {
        const run = runs.get(variant)!
        // The bytes the edge receives, in order, and every header but the per-operation id: identical.
        expect(edgeBound(run), variant).toEqual(edgeBound(base))
        // Her result and her review file: identical but for the `nucleus` answer itself.
        expect(withoutNucleus(run.result), variant).toEqual(withoutNucleus(base.result))
        expect(run.review, variant).toBe(base.review)
        expect(run.result.nucleus, variant).toEqual(EXPECTED[variant])
        // The one extra read is her own reflex file, once; the cell is asked only when that file is the pinned one.
        if (variant !== 'removed') {
          expect(run.calls.filter(call => call.path.startsWith('/cells/')).map(call => `${call.method} ${call.path}`), variant)
            .toEqual([`GET ${TOUCH_ID_TIER_REFLEX_PATH}`])
          expect(run.asked.length, variant).toBe(variant.startsWith('reflex-') ? 0 : 1)
          const said = variant === 'T1' ? 256 : variant === 'escalation' ? 4 : null
          expect(run.shadow, variant).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 1, agree: Number(said === fixture.edge),
            mismatch: Number(said !== null && said !== fixture.edge), unknown: Number(said === null),
            lastMismatches: expect.any(Array) as unknown[] })
        }
      }
    }, 120_000)
  }
})

describe('x6_self_state shows the tally', () => {
  it('after one agreeing promotion, then one the edge classified otherwise', async () => {
    const host = realHost()
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
    let lie = false
    const answers = edgeAnswers('T1')
    const m = await mountE4({ vfs: new MemoryVfs(), respond: (call) => {
      if (lie && call.method === 'POST' && call.path === '/_head/stage') {
        const ball = (call.body as { body: { ball: BallManifest } }).body.ball
        // An edge that classified the config change as T1: what the tally exists to catch (it changes nothing here).
        return Response.json({ ok: true, staged: { state: 'awaiting_owner', ballId: ball.ballId, epoch: ball.epoch, tier: 'T1', t2Reasons: [] } })
      }
      return answers(call)
    } })
    putBall(m.vfs, ORGAN_A2)
    const first = await m.tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${a2Sha}` }) as J
    expect(first).toMatchObject({ ok: true, edgeStaged: true, tier: 'T1',
      nucleus: { decision: 256, reasons: ['T1'], escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 79 } })
    const agreed = (await m.tool('x6_self_state').execute({}) as J).nucleusShadow
    expect(agreed).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 1, agree: 1, mismatch: 0, unknown: 0, lastMismatches: [] })
    lie = true
    const second = await m.tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${a2Sha}`, config: { depth: 2 },
      expectedStagedSha256: first.stagedSha256 }) as J
    expect(second).toMatchObject({ ok: true, edgeStaged: true, nucleus: { decision: 64, reasons: ['ORGAN_CONFIG_CHANGED'], escalate: 1, row: 77 } })
    const answer = await m.tool('x6_self_state').execute({}) as J
    expect(answer.nucleusShadow).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 2, agree: 1, mismatch: 1, unknown: 0,
      lastMismatches: [{
        at: expect.any(Number) as number,
        facts: { changedOrgans: 1, protected: 0, missing: 0, moduleUpdated: 1, disabledClean: 1, configSame: 0, canonicalId: 1 },
        nucleus: { decision: 64, reasons: ['ORGAN_CONFIG_CHANGED'], escalate: 1 }, edge: { tier: 'T1', reasons: ['T1'] } }] })
    expect(Object.keys(answer)).toEqual(['schema', 'runtime', 'edge', 'head', 'organs', 'staged', 'tools', 'doors', 'nucleusShadow',
      'cellCount', 'cells', 'cellJournal', 'forgedCells', 'skills', 'unknown'])
    expect(answer.unknown).not.toContainEqual(expect.objectContaining({ field: 'nucleusShadow' }))
    // Each consult is one journal line on her cell host, labelled as the nucleus shadow's call.
    const journal = await host.journal()
    expect(journal.lines.map(line => [line.cell, line.op, line.status, line.caller])).toEqual([
      ['nucleus', 'reflex.run', 'ok', 'nucleus-shadow'], ['nucleus', 'reflex.run', 'ok', 'nucleus-shadow']])
    expect(answer.cellJournal).toEqual({ calls: 2, rootSha256: journal.rootSha256 })
  }, 60_000)

  it('cuts the oldest mismatches before any organ row when the answer would pass 16 KiB, and never cuts the counts (review)', () => {
    // Enough organs that, with the tally's counts and no mismatches, the organ list just fits (the counts are never cut).
    const organ = (n: number) => ({ id: `organ-${String(n).padStart(3, '0')}`, specifier: `ball:${sha256(`organ ${String(n)}`)}`,
      loaded: { sha256: sha256(`organ ${String(n)}`), bytes: 1000 + n }, state: 'running' })
    const base = { sourceRevision: null, bootedAtMs: 1, head: null, staged: [], tools: [],
      cloudflareDoor: { registered: false, status: null } }
    const observe = (organs: J[], extra: J = {}) => ({ registry: { ...base, organs, ...extra } as unknown as Parameters<typeof projectSelfState>[0]['registry'],
      store: Object.fromEntries(organs.map(item => [item.id as string, (item.loaded as { sha256: string }).sha256])),
      edge: { sourceRevision: null, reason: 'unreachable' as const }, organFilter: null })
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    const mismatch = (at: number) => ({ at, facts: Object.fromEntries(NUCLEUS_TIER_FACT_NAMES.map(name => [name, 1])),
      nucleus: { decision: 64, reasons: ['ORGAN_CONFIG_CHANGED'], escalate: 1 }, edge: { tier: 'T1', reasons: ['T1'] } })
    const tally = { reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 20, agree: 9, mismatch: 8, unknown: 3,
      lastMismatches: Array.from({ length: NUCLEUS_SHADOW_MISMATCHES_KEPT }, (_v, n) => mismatch(1_700_000_000_000 + n)) }
    const countsOnly = { ...tally, lastMismatches: [] }
    let count = 1
    const organsCut = (n: number) => (projectSelfState(observe(Array.from({ length: n }, (_v, i) => organ(i)),
      { nucleusShadow: countsOnly })).unknown as J[]).some(row => row.field === 'organs')
    while (!organsCut(count + 1)) count += 1
    const organs = Array.from({ length: count }, (_v, n) => organ(n))
    const plain = projectSelfState(observe(organs, { nucleusShadow: countsOnly }))
    expect((plain.organs as J[]).length).toBe(count)
    // Nearly full: far less room than the eight mismatches need, yet room for the one row that says the list was cut.
    expect(SELF_STATE_RESULT_BYTES - bytes(plain)).toBeLessThan(bytes(tally.lastMismatches) / 2)
    expect(SELF_STATE_RESULT_BYTES - bytes(plain)).toBeGreaterThan(bytes({ field: 'nucleusShadow.lastMismatches', reason: 'too-many' }))
    const answer = projectSelfState(observe(organs, { nucleusShadow: tally }))
    expect(bytes(answer)).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    // Every organ row stays; no organ is cut for the tally.
    expect((answer.organs as J[]).length).toBe(count)
    expect(answer.unknown).not.toContainEqual(expect.objectContaining({ field: 'organs' }))
    // The counts are whole; the list keeps its newest entries and says it was cut, in one row.
    const shown = answer.nucleusShadow as typeof tally
    expect({ ...shown, lastMismatches: [] }).toEqual({ ...tally, lastMismatches: [] })
    expect(shown.lastMismatches.length).toBeLessThan(NUCLEUS_SHADOW_MISMATCHES_KEPT / 2)
    expect(shown.lastMismatches).toEqual(tally.lastMismatches.slice(tally.lastMismatches.length - shown.lastMismatches.length))
    expect((answer.unknown as J[]).filter(row => String(row.field).startsWith('nucleusShadow')))
      .toEqual([{ field: 'nucleusShadow.lastMismatches', reason: 'too-many' }])
    // With room, the whole list is shown and no row is added.
    const roomy = projectSelfState(observe(organs.slice(0, 4), { nucleusShadow: tally }))
    expect(roomy.nucleusShadow).toEqual(tally)
    expect(roomy.unknown).not.toContainEqual(expect.objectContaining({ field: 'nucleusShadow.lastMismatches' }))
  })

  it('projects a malformed tally as null with one unknown row, and leaves the answer without the key when the loader keeps none', () => {
    const registry = { sourceRevision: null, bootedAtMs: 1, head: null, organs: [], staged: [], tools: [],
      cloudflareDoor: { registered: false, status: null } }
    const observe = (extra: J) => ({ registry: { ...registry, ...extra } as Parameters<typeof projectSelfState>[0]['registry'], store: {}, edge: { sourceRevision: null, reason: 'unreachable' as const }, organFilter: null })
    expect(Object.keys(projectSelfState(observe({})))).not.toContain('nucleusShadow')
    const bad = projectSelfState(observe({ nucleusShadow: { reflex: 'x', consulted: -1 } }))
    expect(bad.nucleusShadow).toBeNull()
    expect(bad.unknown).toContainEqual({ field: 'nucleusShadow', reason: 'read-failed' })
    const good = removedShadow.snapshot()
    expect(projectSelfState(observe({ nucleusShadow: good })).nucleusShadow).toEqual(good)
  })
})
