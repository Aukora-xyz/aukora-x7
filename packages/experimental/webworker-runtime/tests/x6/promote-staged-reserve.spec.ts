/**
 * `promote_staged` (and `head_rollback`, which runs the same function) reserves its id-promotion
 * budget slot before it publishes. Her epoch-80 fix was refused ID_PROMOTION_RESERVATION_REQUIRED at `head-committed`
 * because this path acquired the lease and published without the reservation HEAD requires (DIAG-RESERVATION.md).
 * The HEAD stand-in below enforces the reservation as head-do.mjs does: the same replacement predicate (the REAL
 * isT2OnlyOrgan from server/ball-transition.mjs), a row keyed by (expected head, organ, module sha) under the live lease,
 * and a publish refused 403 without it. Local only: a reserved `.invalid` origin and the e4 fixture's local answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { idPromotionReplacementsOf, STAGED_HEAD_PROMOTION_PATH, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { FakeSocket, headManifestIdCanon, liveHead, mountE4, ORGAN_A2, PEARL_V2, putBall, sha256, type Call } from './e4-fixture.ts'
import { idPromotionBudgetReply } from './id-promotion-budget-fixture.ts'

type J = Record<string, unknown>
interface RealTransition { isT2OnlyOrgan: (id: string, previous?: unknown, candidate?: unknown) => boolean }
const real = await import(new URL('../../../../../server/ball-transition.mjs', import.meta.url).href) as unknown as RealTransition

afterEach(() => {
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const head = liveHead().ball
const a2Sha = sha256(ORGAN_A2), pearlSha = sha256(PEARL_V2)
const EYES = 'module.exports = { apply() {} }; // promo1 eyes'
const childOf = (parent: BallManifest, change: (entries: Record<string, J>) => void, codes: string[] = []): BallManifest => {
  const { ballId: _drop, ...rest } = structuredClone(parent) as unknown as J & { entries: Record<string, J>; modules: Record<string, J> }
  change(rest.entries)
  for (const code of codes) {
    const sha = sha256(code)
    rest.modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: 'synthetic', description: 'Synthetic', size: code.length, createdAt: 1000 }
  }
  const body = { ...rest, parentBallId: parent.ballId, epoch: parent.epoch + 1 }
  return { ...body, ballId: headManifestIdCanon(body) } as unknown as BallManifest
}
const organAUpdate = childOf(head, (entries) => { entries['organ-a'] = { ...entries['organ-a']!, specifier: `ball:${a2Sha}` } }, [ORGAN_A2])
const pearlUpdate = childOf(head, (entries) => { entries['seed-pearl'] = { ...entries['seed-pearl']!, specifier: `ball:${pearlSha}` } }, [PEARL_V2])
const eyesAdd = childOf(head, (entries) => {
  entries.eyes = { id: 'eyes', specifier: `ball:${sha256(EYES)}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
}, [EYES])

/** HEAD's own replacement predicate (head-do.mjs publish, `idPromotionReplacements`), written over the REAL rule. */
const edgeReplacements = (previous: BallManifest, candidate: BallManifest): string[] => Object.keys(previous.entries ?? {})
  .filter(id => candidate.entries[id] && previous.entries[id]?.specifier !== candidate.entries[id].specifier
    && !real.isT2OnlyOrgan(id, previous.entries[id], candidate.entries[id]))

type Reserve = (body: J) => Response | null
interface Stand { reserves: J[]; publishes: unknown[]; rows: Set<string> }
/** HEAD stand-in that enforces the reservation as head-do.mjs does. `reserve`/`publish` override one answer. */
type Mounted = Awaited<ReturnType<typeof mountE4>>
function enforcingHead(m: () => Mounted, stand: Stand, options: { reserve?: Reserve; publish?: () => Response } = {}) {
  let lease: { ownerPeerId: string; generation: number } | null = null
  let generation = 0
  return (call: Call): Response | null => {
    if (call.method === 'POST' && call.path === '/_head/stage') {
      const ball = (call.body as { body: { ball: BallManifest } }).body.ball
      return Response.json({ ok: true, staged: { state: 'awaiting_owner', stagedForOwner: true, ballId: ball.ballId, epoch: ball.epoch } })
    }
    if (call.method === 'POST' && call.path === '/_head/lease') {
      const body = call.body as J
      if (body.action === 'acquire') {
        generation += 1
        lease = { ownerPeerId: String(body.ownerPeerId), generation }
        const selected = m().head.ball
        return Response.json({ ok: true, ballId: selected.ballId, epoch: selected.epoch,
          lease: { ...lease, expiresAt: Date.now() + 30_000 } })
      }
      if (body.action === 'release') { lease = null; return Response.json({ ok: true, released: true }) }
      if (body.action === 'reserve-id-promotion') {
        stand.reserves.push(body)
        const override = options.reserve?.(body)
        if (override) return override
        if (!lease || lease.ownerPeerId !== body.ownerPeerId || lease.generation !== body.generation) return Response.json({ ok: false, code: 'WRITER_LEASE_STALE' }, { status: 409 })
        const current = m().head.ball
        if (current.ballId !== body.expectedBallId) return Response.json({ ok: false, code: 'ID_PROMOTION_HEAD_STALE' }, { status: 409 })
        const entry = current.entries[String(body.organId)]
        if (!entry || (entry.disabled as unknown) !== false || real.isT2OnlyOrgan(String(body.organId), entry, entry)
          || entry.specifier === `ball:${String(body.candidateSha)}`) {
          return Response.json({ ok: false, code: 'ID_PROMOTION_SCOPE_REFUSED' }, { status: 403 })
        }
        stand.rows.add([body.expectedBallId, body.organId, body.candidateSha].map(String).join('|'))
        return idPromotionBudgetReply(body)
      }
    }
    if (call.method === 'POST' && call.path === '/_head/ball') {
      const body = call.body as { ball: BallManifest; codeBySha: Record<string, string>; writerLease: J }
      stand.publishes.push(body)
      if (options.publish) return options.publish()
      if (!lease || body.writerLease?.generation !== lease.generation) return Response.json({ ok: false, code: 'WRITER_LEASE_REQUIRED' }, { status: 423 })
      const current = m().head.ball
      for (const organId of edgeReplacements(current, body.ball)) {
        if (!stand.rows.has(`${current.ballId}|${organId}|${body.ball.entries[organId]!.specifier.slice(5)}`)) {
          return Response.json({ ok: false, code: 'ID_PROMOTION_RESERVATION_REQUIRED' }, { status: 403 })
        }
      }
      Object.assign(m().head.codeBySha, body.codeBySha)
      m().head.ball = body.ball
      return Response.json({ ok: true, ballId: body.ball.ballId, epoch: body.ball.epoch, tier: 'T1' })
    }
    return null
  }
}

async function mount(options: { reserve?: Reserve; publish?: () => Response } = {}) {
  const stand: Stand = { reserves: [], publishes: [], rows: new Set() }
  let mounted: Awaited<ReturnType<typeof mountE4>> | null = null
  mounted = await mountE4({ head: liveHead(), respond: enforcingHead(() => mounted!, stand, options) })
  mounted.calls.length = 0
  return { m: mounted, stand }
}
const stageFile = (m: Awaited<ReturnType<typeof mountE4>>, ball: BallManifest, codeBySha: Record<string, string>) => {
  m.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
  m.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, `${JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
    body: { ball, codeBySha, expectedParentBallId: head.ballId, expectedEpoch: head.epoch } })}\n`)
}
const hopNames = (result: J): string[] => (result.hops as Array<{ hop: string }>).map(hop => hop.hop)
const reserveCalls = (calls: Call[]) => calls.filter(call => call.path === '/_head/lease' && (call.body as J)?.action === 'reserve-id-promotion')
const publishIndex = (calls: Call[]) => calls.findIndex(call => call.path === '/_head/ball' && call.method === 'POST')

describe('the replacement predicate is the one HEAD charges (shared vectors over the real isT2OnlyOrgan)', () => {
  const entry = (id: string, sha: string, extra: J = {}): BallEntryRecord => ({ id, specifier: `ball:${sha}`, config: {}, disabled: false,
    previousSpecifiers: [], updatedAt: 1, ...extra })
  const ball = (entries: Record<string, BallEntryRecord>): BallManifest => ({ version: 'x6.1-ball/v1', ballId: 'a'.repeat(64),
    parentBallId: null, epoch: 0, createdAt: 1, authorPeerId: 'p', entries, modules: {} }) as unknown as BallManifest
  const x = '1'.repeat(64), y = '2'.repeat(64)
  const vectors: Array<[string, Record<string, BallEntryRecord>, Record<string, BallEntryRecord>]> = [
    ['ordinary replacement', { o: entry('o', x) }, { o: entry('o', y) }],
    ['unchanged specifier', { o: entry('o', x) }, { o: entry('o', x, { updatedAt: 2 }) }],
    ['fixed governance id', { 'seed-pearl': entry('seed-pearl', x) }, { 'seed-pearl': entry('seed-pearl', y) }],
    ['fixed governance id with a hash suffix', { [`seed-judge:${x}`]: entry('seed-judge', x) }, { [`seed-judge:${x}`]: entry('seed-judge', y) }],
    ['declared governance before', { o: entry('o', x, { governance: true }) }, { o: entry('o', y) }],
    ['declared governance after', { o: entry('o', x) }, { o: entry('o', y, { governance: 'class3' }) }],
    ['declared governance in config', { o: entry('o', x, { config: { governance: true } }) }, { o: entry('o', y) }],
    ['governance false is ordinary', { o: entry('o', x, { governance: false }) }, { o: entry('o', y, { config: { governance: false } }) }],
    ['added organ', { o: entry('o', x) }, { o: entry('o', x), n: entry('n', y) }],
    ['removed organ', { o: entry('o', x), n: entry('n', y) }, { o: entry('o', x) }],
    ['two replacements', { o: entry('o', x), p: entry('p', x) }, { o: entry('o', y), p: entry('p', y) }],
  ]
  it.each(vectors)('%s', (_name, before, after) => {
    expect(idPromotionReplacementsOf(ball(before), ball(after))).toEqual(edgeReplacements(ball(before), ball(after)))
  })
  it('the sample candidates: an ordinary update is one replacement, a governance change and a pure add are none', () => {
    expect(idPromotionReplacementsOf(head, organAUpdate)).toEqual(['organ-a'])
    expect(idPromotionReplacementsOf(head, pearlUpdate)).toEqual([])
    expect(idPromotionReplacementsOf(head, eyesAdd)).toEqual([])
  })
})

describe('promote_staged reserves its slot before it publishes', () => {
  it('(a) T1: one reserve with (parent ballId, organ, module sha) before the publish, then HEAD accepts it', async () => {
    const { m, stand } = await mount()
    stageFile(m, organAUpdate, { [a2Sha]: ORGAN_A2 })
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
    expect(result).toMatchObject({ ok: true, promoted: true, tier: 'T1', ballId: organAUpdate.ballId })
    const names = hopNames(result)
    expect(names.slice(names.indexOf('lease-acquired'), names.indexOf('head-committed') + 1))
      .toEqual(['lease-acquired', 'budget-reserved', 'authorized', 'head-committed'])
    const reserved = (result.hops as Array<{ hop: string; ok: boolean; detail?: string }>).find(hop => hop.hop === 'budget-reserved')!
    expect(reserved).toMatchObject({ ok: true, detail: 'organ-a:1/12' })
    expect((result.hops as Array<{ hop: string; detail?: string }>).find(hop => hop.hop === 'authorized')!.detail).toContain("tab's own check")
    const reserves = reserveCalls(m.calls)
    expect(reserves).toHaveLength(1)
    expect(reserves[0]!.body).toEqual({ action: 'reserve-id-promotion', ownerPeerId: organAUpdate.authorPeerId, generation: 1,
      expectedBallId: head.ballId, organId: 'organ-a', candidateSha: a2Sha })
    expect(m.calls.indexOf(reserves[0]!)).toBeLessThan(publishIndex(m.calls))
    expect(stand.publishes).toHaveLength(1)
    expect(m.calls.filter(call => (call.body as J)?.action === 'release')).toHaveLength(1)
  })

  it.each([
    ['ID_PROMOTION_LIMIT_REACHED', () => Response.json({ ok: false, code: 'ID_PROMOTION_LIMIT_REACHED', used: 12, limit: 12, windowMs: 43_200_000,
      retryAt: 1_900_000_000_000 }, { status: 429 }), 429],
    ['ID_PROMOTION_AUTHORITY_MISSING', () => Response.json({ ok: false, code: 'ID_PROMOTION_AUTHORITY_MISSING' }, { status: 503 }), 503],
    ['ID_PROMOTION_HEAD_STALE', () => Response.json({ ok: false, code: 'ID_PROMOTION_HEAD_STALE' }, { status: 409 }), 409],
    ['ID_PROMOTION_SCOPE_REFUSED', () => Response.json({ ok: false, code: 'ID_PROMOTION_SCOPE_REFUSED' }, { status: 403 }), 403],
    // A malformed acknowledgement is refused by the tab (id-promotion-budget.ts), not by an edge status.
    ['ID_PROMOTION_AUTHORITY_INVALID', () => Response.json({ ok: true, used: 1 }), null],
    // Review A-S1: a lost reply (a gateway page, no JSON): the edge may have charged; no edge status is known.
    ['ID_PROMOTION_AUTHORITY_UNAVAILABLE', () => new Response('<html>upstream gone</html>', { status: 502 }), null],
    // A known edge refusal under the wrapped code (the lease went stale): not uncertain, the edge code is named.
    ['ID_PROMOTION_AUTHORITY_UNAVAILABLE', () => Response.json({ ok: false, code: 'WRITER_LEASE_STALE' }, { status: 409 }), 409],
  ] as const)('(b) a reserve answered %s stops before any publish call, and the lease is released', async (code, answer, status) => {
    const { m, stand } = await mount({ reserve: answer })
    stageFile(m, organAUpdate, { [a2Sha]: ORGAN_A2 })
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
    expect(result).toMatchObject({ ok: false, code, failedHop: 'budget-reserved', status })
    if (code === 'ID_PROMOTION_LIMIT_REACHED') expect(result.retryAt).toBe(1_900_000_000_000)
    else expect(result).not.toHaveProperty('retryAt')
    // A-S1: only a lost or malformed reply (no edge status) says the slot may be charged.
    if (status === null) expect(result.budgetSlotUncertain).toBe(true)
    else expect(result).not.toHaveProperty('budgetSlotUncertain')
    if (status === 409 && code === 'ID_PROMOTION_AUTHORITY_UNAVAILABLE') expect(result.edgeCode).toBe('WRITER_LEASE_STALE')
    expect(hopNames(result).at(-1)).toBe('budget-reserved')
    expect(hopNames(result)).not.toContain('authorized')
    expect(stand.reserves).toHaveLength(1)
    expect(stand.publishes).toHaveLength(0)
    expect(publishIndex(m.calls)).toBe(-1)
    expect(m.calls.filter(call => (call.body as J)?.action === 'release')).toHaveLength(1)
    expect((await m.status()).ballId).toBe(head.ballId)
  })

  it('(c) reserved, then the publish is refused: the slot is said to be retained and nothing is adopted', async () => {
    const { m, stand } = await mount({ publish: () => Response.json({ ok: false, code: 'CLASS3_TRANSITION_EXPIRED' }, { status: 409 }) })
    stageFile(m, organAUpdate, { [a2Sha]: ORGAN_A2 })
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
    expect(result).toMatchObject({ ok: false, code: 'CLASS3_TRANSITION_EXPIRED', failedHop: 'head-committed', status: 409, budgetSlotRetained: true })
    expect(result).not.toHaveProperty('adopted')
    expect(stand.reserves).toHaveLength(1)
    expect(stand.publishes).toHaveLength(1)
    expect((await m.status()).ballId).toBe(head.ballId)
  })

  it('(d) head_rollback of an ordinary organ reserves through the same function and publishes', async () => {
    const { m } = await mount()
    putBall(m.vfs, ORGAN_A2)
    m.vfs.mkdirSync('/dsh/home/balls/history', { recursive: true })
    m.vfs.writeFileSync(`/dsh/home/balls/history/${organAUpdate.ballId}.json`, JSON.stringify(organAUpdate))
    const result = await m.tool('x6_repo').execute({ action: 'head_rollback', to: organAUpdate.ballId }) as J
    expect(result).toMatchObject({ ok: true, promoted: true, tier: 'T1', path: '/dsh/home/auma/staged/head-promotion.rollback.json' })
    const reserves = reserveCalls(m.calls)
    expect(reserves).toHaveLength(1)
    expect(reserves[0]!.body).toMatchObject({ expectedBallId: head.ballId, organId: 'organ-a', candidateSha: a2Sha })
    expect(m.calls.indexOf(reserves[0]!)).toBeLessThan(publishIndex(m.calls))
    expect(m.head.ball.entries['organ-a']!.specifier).toBe(`ball:${a2Sha}`)
  })

  it.each([['a governance-only change', pearlUpdate, { [pearlSha]: PEARL_V2 }], ['a pure add', eyesAdd, { [sha256(EYES)]: EYES }]] as const)(
    '(e) %s makes no reserve call (it is staged for the owner, untouched)', async (_name, ball, codeBySha) => {
      const { m } = await mount()
      stageFile(m, ball, codeBySha)
      const result = await m.tool('x6_repo').execute({ action: 'promote_staged' }) as J
      expect(result).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', tier: 'T2' })
      expect(reserveCalls(m.calls)).toHaveLength(0)
      expect(publishIndex(m.calls)).toBe(-1)
    })

  it('(f) the dry run reserves nothing and says the budget was not checked', async () => {
    const { m } = await mount()
    stageFile(m, organAUpdate, { [a2Sha]: ORGAN_A2 })
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged', dryRun: true }) as J
    expect(result).toMatchObject({ ok: true, dryRun: true, committed: false, wouldSucceedUnderT1: true, budgetChecked: false })
    expect(reserveCalls(m.calls)).toHaveLength(0)
    expect(m.calls.filter(call => call.method === 'POST')).toEqual([])
  })
})
