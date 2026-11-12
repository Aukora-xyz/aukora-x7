/**
 * KIRA (AURA HANDOFF-5 contract): `stage_organ_set_promotion` stages a PURE ADD of 1..8 ordinary organs for one Touch ID.
 * The candidate is built from balls already in her store by sha, never inline bytes; every published entry and module is
 * cloned verbatim; each organ gets the fixed entry; `codeBySha` carries new modules only; HEAD must record the set.
 * `serializeStagedHeadPromotion` accepts such a set and still refuses everything it refused before. Local fixture only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOrganSetPromotion, manifestStructureProblem, organAdditionSetOf, serializeStagedHeadPromotion, STAGED_HEAD_PROMOTION_PATH,
  type BallManifest,
} from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, headManifestIdCanon, liveHead, mountE4, ORGAN_A, PEARL_V1, PEARL_V2, putBall, sha256, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const EYES = 'module.exports = { apply() {} }; // kira organ-set eyes'
const EARS = 'module.exports = { apply() {} }; // kira organ-set ears'
const deps = (codes: Record<string, string> = {}) => ({ authorPeerId: 'tab-kira', now: 9000, readCode: (sha: string) => codes[sha] ?? null })
const store = (...codes: string[]) => Object.fromEntries(codes.map(code => [sha256(code), code]))
const organ = (id: string, code: string, extra: Record<string, unknown> = {}) => ({ id, specifier: `ball:${sha256(code)}`, ...extra })
/** Verified bytes for a sha, as the runtime's store would answer. */
const codeOf = (...codes: string[]) => (sha: string) => codes.find(code => sha256(code) === sha) ?? null
const ALL = codeOf(ORGAN_A, PEARL_V1, EYES, EARS)

describe('buildOrganSetPromotion: the pure add HEAD records', () => {
  it('clones the head verbatim, adds each organ with the fixed entry, ids it canonically, and carries only new modules', () => {
    const live = liveHead()
    const plan = buildOrganSetPromotion(live, { organs: [organ('eyes', EYES, { description: 'sees' }), organ('ears', EARS)] }, deps(store(EYES, EARS)))
    expect(plan.ball.parentBallId).toBe(live.ball.ballId)
    expect(plan.ball.epoch).toBe(8)
    expect(plan.ball.ballId).toBe(headManifestIdCanon(plan.ball as unknown as Record<string, unknown>))
    expect(manifestStructureProblem(plan.ball)).toBeNull()
    for (const [id, entry] of Object.entries(live.ball.entries)) expect(plan.ball.entries[id]).toEqual(entry)
    for (const [sha, meta] of Object.entries(live.ball.modules)) expect(plan.ball.modules[sha]).toEqual(meta)
    expect(plan.ball.entries.eyes).toEqual({ id: 'eyes', specifier: `ball:${sha256(EYES)}`, disabled: false, config: {}, previousSpecifiers: [] })
    expect(plan.ball.modules[sha256(EYES)]).toEqual({ sha256: sha256(EYES), specifier: `ball:${sha256(EYES)}`, name: 'eyes', description: 'sees',
      size: EYES.length, createdAt: 9000 })
    expect(plan.ball.modules[sha256(EARS)]?.description).toBe('Seed organ ears')
    expect(plan.organs).toEqual([{ organId: 'ears', sha256: sha256(EARS), bytes: EARS.length }, { organId: 'eyes', sha256: sha256(EYES), bytes: EYES.length }])
    const envelope = JSON.parse(plan.text) as { body: { codeBySha: Record<string, string>; expectedEpoch: number } }
    expect(Object.keys(envelope.body.codeBySha).sort()).toEqual([sha256(EYES), sha256(EARS)].sort())
    expect(envelope.body.expectedEpoch).toBe(7)
  })

  // The builder rebuilt fixed root fields, so a live manifest with an unchanged extra root field
  // (label: "kept") failed ORGAN_SET_NOT_A_PURE_ADD. The whole live manifest is cloned; only permitted fields change.
  it('keeps an unchanged extra root field of the live manifest, byte for byte, and stays a pure add', () => {
    const live = liveHead()
    const labelled = { ...live.ball, label: 'kept' } as Record<string, unknown>
    delete labelled.ballId
    const labelledBall = { ...labelled, ballId: headManifestIdCanon(labelled) } as unknown as BallManifest
    const liveWithLabel = { ball: labelledBall, codeBySha: live.codeBySha }
    const plan = buildOrganSetPromotion(liveWithLabel, { organs: [organ('eyes', EYES)] }, deps(store(EYES)))
    expect((plan.ball as unknown as Record<string, unknown>).label).toBe('kept')
    expect(plan.ball.ballId).toBe(headManifestIdCanon(plan.ball as unknown as Record<string, unknown>))
    expect(plan.organs).toEqual([{ organId: 'eyes', sha256: sha256(EYES), bytes: EYES.length }])
  })

  it('an organ whose module is already in the head adds the entry only and ships no bytes for it', () => {
    const live = liveHead()
    const plan = buildOrganSetPromotion(live, { organs: [organ('organ-twin', ORGAN_A)] }, deps())
    expect(plan.newModules).toEqual([])
    expect((JSON.parse(plan.text) as { body: { codeBySha: object } }).body.codeBySha).toEqual({})
  })

  it.each([
    ['an id already in the head', { organs: [organ('organ-a', EYES)] }, 'ORGAN_SET_NOT_AN_ADD'],
    ['a fixed governance organ', { organs: [organ('seed-pearl-two', EYES), organ('seed-receipts', EARS)] }, 'ORGAN_SET_GOVERNANCE_REFUSED'],
    ['no organs', { organs: [] }, 'ORGAN_SET_INPUT_INVALID'],
    ['nine organs', { organs: Array.from({ length: 9 }, (_, index) => organ(`o${String(index)}`, EYES)) }, 'ORGAN_SET_INPUT_INVALID'],
    ['a duplicate id', { organs: [organ('eyes', EYES), organ('eyes', EARS)] }, 'ORGAN_SET_INPUT_INVALID'],
    ['an id that is not lower kebab', { organs: [organ('Eyes', EYES)] }, 'ORGAN_SET_INPUT_INVALID'],
    ['an id over 41 characters', { organs: [organ(`e${'x'.repeat(41)}`, EYES)] }, 'ORGAN_SET_INPUT_INVALID'],
    ['a bare sha specifier', { organs: [{ id: 'eyes', specifier: sha256(EYES) }] }, 'ORGAN_SET_INPUT_INVALID'],
    ['a config input', { organs: [organ('eyes', EYES, { config: { governance: true } })] }, 'ORGAN_SET_INPUT_INVALID'],
    ['a disabled input', { organs: [organ('eyes', EYES, { disabled: true })] }, 'ORGAN_SET_INPUT_INVALID'],
    ['inline code', { organs: [organ('eyes', EYES, { code: EYES })] }, 'ORGAN_SET_INPUT_INVALID'],
    ['an extra top-level key', { organs: [organ('eyes', EYES)], governance: true }, 'ORGAN_SET_INPUT_INVALID'],
  ])('refuses %s', (_label, input, code) => {
    expect(() => buildOrganSetPromotion(liveHead(), input, deps(store(EYES, EARS)))).toThrow(new RegExp(`^${code}`))
  })

  it('refuses a module not in the store, and bytes that do not hash to their sha', () => {
    expect(() => buildOrganSetPromotion(liveHead(), { organs: [organ('eyes', EYES)] }, deps())).toThrow(/^BALL_CODE_MISSING/)
    expect(() => buildOrganSetPromotion(liveHead(), { organs: [organ('eyes', EYES)] }, deps({ [sha256(EYES)]: EARS }))).toThrow(/^BALL_CODE_HASH_MISMATCH/)
  })
})

describe('the pure-add rule and serializeStagedHeadPromotion', () => {
  const fullInput = (live: ReturnType<typeof liveHead>, ball: BallManifest, extra: Record<string, string>) => ({
    ball, codeBySha: { ...live.codeBySha, ...extra }, expectedParentBallId: live.ball.ballId, expectedEpoch: live.ball.epoch })

  it('accepts a pure add of ordinary organs', () => {
    const live = liveHead()
    const plan = buildOrganSetPromotion(live, { organs: [organ('eyes', EYES), organ('ears', EARS)] }, deps(store(EYES, EARS)))
    expect(organAdditionSetOf(live.ball, plan.ball, ALL)).toEqual(plan.organs)
    expect(() => serializeStagedHeadPromotion(live.ball, fullInput(live, plan.ball, store(EYES, EARS)), 1)).not.toThrow()
  })

  type Editable = { entries: Record<string, Record<string, unknown>>; modules: Record<string, unknown> } & Record<string, unknown>
  const editable = (ball: BallManifest): Editable => JSON.parse(JSON.stringify(ball)) as Editable
  const rehash = (ball: Editable): BallManifest => {
    const { ballId: _drop, ...body } = ball
    return { ...body, ballId: headManifestIdCanon(body) } as unknown as BallManifest
  }

  it('still refuses a candidate that changes nothing, and a rider beside an add', () => {
    const live = liveHead()
    const unchanged = editable(live.ball)
    unchanged.parentBallId = live.ball.ballId
    unchanged.epoch = 8
    expect(() => serializeStagedHeadPromotion(live.ball, fullInput(live, rehash(unchanged), {}), 1))
      .toThrow(/^STAGED_PROMOTION_SINGLE_GOVERNANCE_REQUIRED/)
    const plan = buildOrganSetPromotion(live, { organs: [organ('eyes', EYES)] }, deps(store(EYES)))
    const rider = editable(plan.ball)
    rider.entries['organ-a'] = { ...rider.entries['organ-a'], disabled: true }
    const riderBall = rehash(rider)
    expect(organAdditionSetOf(live.ball, riderBall, ALL)).toBeNull()
    expect(() => serializeStagedHeadPromotion(live.ball, fullInput(live, riderBall, store(EYES)), 1))
      .toThrow(/^STAGED_PROMOTION_SINGLE_GOVERNANCE_REQUIRED/)
  })

  it('the rule refuses a disabled add, a governance declaration, a removal and a stray module', () => {
    const live = liveHead()
    const base = buildOrganSetPromotion(live, { organs: [organ('eyes', EYES)] }, deps(store(EYES))).ball
    const variant = (edit: (ball: Editable) => void): Editable => {
      const copy = editable(base)
      edit(copy)
      return copy
    }
    expect(organAdditionSetOf(live.ball,
      variant((ball) => { ball.entries.eyes = { ...ball.entries.eyes, disabled: true } }), ALL)).toBeNull()
    const declared = variant((ball) => { ball.entries.eyes = { ...ball.entries.eyes, config: { governance: true } } })
    expect(organAdditionSetOf(live.ball, declared, ALL)).toBeNull()
    expect(organAdditionSetOf(live.ball, variant((ball) => { delete ball.entries['organ-a'] }), ALL)).toBeNull()
    expect(organAdditionSetOf(live.ball, variant((ball) => {
      ball.modules[sha256(EARS)] = { sha256: sha256(EARS), specifier: `ball:${sha256(EARS)}`, name: 'x', description: 'x', size: 1, createdAt: 1 }
    }), ALL)).toBeNull()
  })

  // The worker accepted config/history variants the edge refused, reported a stored size
  // (999) instead of the verified bytes (34), and missed an unlisted module or extra root metadata.
  it('every size is derived from verified bytes, never a stored number', () => {
    const live = liveHead()
    const shaA = sha256(ORGAN_A)
    const stale = editable(live.ball)
    ;(stale.modules[shaA] as Record<string, unknown>).size = 999
    const liveStale = { ball: rehash(stale), codeBySha: live.codeBySha }
    const plan = buildOrganSetPromotion(liveStale, { organs: [organ('organ-twin', ORGAN_A)] }, deps())
    expect(plan.organs).toEqual([{ organId: 'organ-twin', sha256: shaA, bytes: ORGAN_A.length }])
    expect(organAdditionSetOf(liveStale.ball, plan.ball, ALL)?.[0]?.bytes).toBe(ORGAN_A.length)
  })

  it.each([
    ['a non-empty config', (ball: Editable) => { ball.entries.eyes = { ...ball.entries.eyes, config: { depth: 1 } } }],
    ['a previousSpecifiers history', (ball: Editable) => { ball.entries.eyes = { ...ball.entries.eyes, previousSpecifiers: [`ball:${sha256(ORGAN_A)}`] } }],
    ['a previousVersions history', (ball: Editable) => { ball.entries.eyes = { ...ball.entries.eyes, previousVersions: [{ specifier: 'x', config: {}, disabled: false }] } }],
    ['a governance:false key', (ball: Editable) => { ball.entries.eyes = { ...ball.entries.eyes, governance: false } }],
    ['a negative updatedAt', (ball: Editable) => { ball.entries.eyes = { ...ball.entries.eyes, updatedAt: -1 } }],
    ['an added root field valued null', (ball: Editable) => { ball.extra = null }],
    ['an unlisted extra module', (ball: Editable) => {
      ball.modules[sha256(EARS)] = { sha256: sha256(EARS), specifier: `ball:${sha256(EARS)}`, name: 'ears', description: 'x', size: EARS.length, createdAt: 1 }
    }],
    ['a new module shared by two added entries', (ball: Editable) => { ball.entries.twin = { ...ball.entries.eyes, id: 'twin' } }],
    ['extra root metadata', (ball: Editable) => { ball.note = 'unlisted' }],
    ['a changed version', (ball: Editable) => { ball.version = 'x6.1-ball/v2' }],
    ['a new module whose declared size is not its verified size', (ball: Editable) => {
      (ball.modules[sha256(EYES)] as Record<string, unknown>).size = 999
    }],
  ])('refuses %s, as the edge does', (_label, edit) => {
    const live = liveHead()
    const copy = editable(buildOrganSetPromotion(live, { organs: [organ('eyes', EYES)] }, deps(store(EYES))).ball)
    edit(copy)
    expect(organAdditionSetOf(live.ball, rehash(copy), ALL)).toBeNull()
  })

  it('refuses an add whose module bytes are not available or do not hash to the sha', () => {
    const live = liveHead()
    const ball = buildOrganSetPromotion(live, { organs: [organ('eyes', EYES)] }, deps(store(EYES))).ball
    expect(organAdditionSetOf(live.ball, ball, () => null)).toBeNull()
    expect(organAdditionSetOf(live.ball, ball, () => EARS)).toBeNull()
  })
})

describe('stage_organ_set_promotion tool', () => {
  const stageAnswer = (organSet: unknown) => (call: Call) => call.path === '/_head/stage' && call.method === 'POST'
    ? Response.json({ ok: true, staged: { state: 'awaiting_owner', stagedForOwner: true, ballId: (call.body as { body: { ball: { ballId: string } } }).body.ball.ballId,
      epoch: 8, tier: 'T2', governanceClass: 1, binding: null, organSet } })
    : null

  it('reads her store by sha, writes the review file, POSTs /_head/stage and returns HEAD\'s organ set', async () => {
    const vfs = new MemoryVfs()
    putBall(vfs, EYES)
    putBall(vfs, EARS)
    const organSet = { schema: 'aukora.head-organ-set.v1', organs: [{ organId: 'ears' }, { organId: 'eyes' }] }
    const { tool, calls } = await mountE4({ vfs, respond: stageAnswer(organSet) })
    calls.length = 0
    const result = await tool('stage_organ_set_promotion').execute({ organs: [organ('eyes', EYES), organ('ears', EARS)] }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, staged: true, edgeStaged: true, epoch: 8, organSet, hint: 'Awaiting one Touch ID on the Add organs card.' })
    expect((result.hops as Array<{ hop: string }>).map(hop => hop.hop)).toEqual(['live-head', 'built', 'local-staged', 'idb-flushed', 'edge-staged'])
    expect(calls.map(call => `${call.method} ${call.path}`).filter(line => !line.includes('promotion-status') && !line.includes('facts')))
      .toEqual(['GET /_head/ball', 'POST /_head/stage'])
    const written = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    expect(calls.find(call => call.path === '/_head/stage')!.body).toEqual(JSON.parse(written))
  })

  it('HEAD staging it without recording an organ set is ORGAN_SET_NOT_RECORDED, never presented as the Add card', async () => {
    const vfs = new MemoryVfs()
    putBall(vfs, EYES)
    const { tool } = await mountE4({ vfs, respond: stageAnswer(null) })
    const result = await tool('stage_organ_set_promotion').execute({ organs: [organ('eyes', EYES)] }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, staged: false, code: 'ORGAN_SET_NOT_RECORDED', edgeStaged: true, organSet: null })
  })

  it('HEAD codes pass through, and a refused build never touches the review file or HEAD', async () => {
    const vfs = new MemoryVfs()
    putBall(vfs, EYES)
    const { tool, calls } = await mountE4({ vfs, respond: call => call.path === '/_head/stage'
      ? Response.json({ ok: false, code: 'REBASE_REQUIRED' }, { status: 409 }) : null })
    expect(await tool('stage_organ_set_promotion').execute({ organs: [organ('eyes', EYES)] })).toMatchObject({ ok: false, code: 'REBASE_REQUIRED' })
    calls.length = 0
    vfs.unlinkSync(STAGED_HEAD_PROMOTION_PATH)
    expect(await tool('stage_organ_set_promotion').execute({ organs: [organ('organ-a', EYES)] })).toMatchObject({ ok: false, code: 'ORGAN_SET_NOT_AN_ADD', failedHop: 'built' })
    expect(vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(false)
    expect(calls.some(call => call.path === '/_head/stage')).toBe(false)
  })

  // The guard had changed this path's error and cut its dry-run diagnostics; both are restored.
  it('promote_staged keeps its own error and dry run for a multi-organ set, and names the Add organs card', async () => {
    const vfs = new MemoryVfs()
    putBall(vfs, EYES)
    putBall(vfs, EARS)
    const { tool, runtime, calls } = await mountE4({ vfs, respond: stageAnswer({ organs: [] }) })
    await tool('stage_organ_set_promotion').execute({ organs: [organ('eyes', EYES), organ('ears', EARS)] })
    calls.length = 0
    const call = async (args: Record<string, unknown>) => ((await runtime.handleControlRequest('POST', '/__x6__/call-tool',
      JSON.stringify({ name: 'x6_repo', args: { action: 'promote_staged', ...args } })))?.body as { raw?: Record<string, unknown> }).raw
    const dry = await call({ dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, committed: false, changedEntries: ['eyes', 'ears'], unchangedOtherEntries: false,
      organSet: [{ organId: 'ears' }, { organId: 'eyes' }] })
    expect(dry).toHaveProperty('t2Reasons')
    expect(dry).toHaveProperty('modulesToWrite')
    const real = await call({})
    expect(real).toMatchObject({ ok: false, code: 'UNCHANGED_OTHER_ENTRIES_REQUIRED', failedHop: 'validated-t1', changedEntries: ['eyes', 'ears'],
      organSet: [{ organId: 'ears' }, { organId: 'eyes' }] })
    expect(calls.some(item => item.path === '/_head/promote')).toBe(false)
  })

  it('a single governance organ still goes through stage_organ_promotion unchanged', async () => {
    const vfs = new MemoryVfs()
    putBall(vfs, PEARL_V2)
    const { tool } = await mountE4({ vfs })
    expect(await tool('stage_organ_set_promotion').execute({ organs: [organ('seed-pearl', PEARL_V2)] }))
      .toMatchObject({ ok: false, code: 'ORGAN_SET_NOT_AN_ADD' })
  })
})
