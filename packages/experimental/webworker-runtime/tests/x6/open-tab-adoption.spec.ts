/**
 * An open tab never hot-swaps to a head published elsewhere; it says so, and one reload brings the new head.
 *
 * Case: the edge publishes epoch N+1 while a tab is open on epoch N, and `head_adopt` answers
 * `MANIFEST_RECOVERY_FAILED: selected head retained`. Live adoption is not safe: a failed recovery can leave organs of
 * the refused head running, and an adoption does not drain in-flight organ calls. So a publication announced on the
 * HEAD socket, and `head_adopt`, only re-read the published head (bounded), check it is well formed, record the lag in
 * one place, and mount or dispose NOTHING. The app shows the lag with its Reload button (ui-layout portal/build-notice.ts).
 * And `x6_repo` hands the edge's REPO_PROPOSAL_REQUIRED refusal back unchanged, never as a Touch ID card.
 * Every answer is local (reserved `.invalid` origin, fake socket); no provider, owner approval or live DO is touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STAGED_HEAD_PROMOTION_PATH, STAGED_OUTWARD_PATH, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { FakeSocket, ORGAN_A, headManifestIdCanon, mountE4, sha256, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
const until = async (done: () => Promise<boolean>) => { for (let i = 0; i < 50 && !(await done()); i += 1) await settle() }

const ORGAN_B = 'module.exports = { apply() {} }; // open-tab organ-b'
const ORGAN_A_NEXT = 'module.exports = { apply() {} }; // open-tab organ-a, next version'

const entry = (id: string, code: string): BallEntryRecord => ({ id, specifier: `ball:${sha256(code)}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 })
const meta = (id: string, code: string) => ({ sha256: sha256(code), specifier: `ball:${sha256(code)}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 })

function makeHead(parentBallId: string | null, epoch: number, organs: Record<string, string>): BallManifest {
  const body = { version: 'x6.1-ball/v1' as const, parentBallId, epoch, createdAt: 1000 + epoch, authorPeerId: 'fixture-author',
    entries: Object.fromEntries(Object.entries(organs).map(([id, code]) => [id, entry(id, code)])),
    modules: Object.fromEntries(Object.entries(organs).map(([id, code]) => [sha256(code), meta(id, code)])) }
  return { ...body, ballId: headManifestIdCanon(body) }
}
/** The next head after `parent`, replacing or adding `organs`. */
function child(parent: BallManifest, organs: Record<string, string>): BallManifest {
  const { ballId: _drop, ...rest } = parent
  const body = { ...rest, parentBallId: parent.ballId, epoch: parent.epoch + 1, createdAt: parent.createdAt + 1,
    entries: { ...parent.entries, ...Object.fromEntries(Object.entries(organs).map(([id, code]) => [id, entry(id, code)])) },
    modules: { ...parent.modules, ...Object.fromEntries(Object.entries(organs).map(([id, code]) => [sha256(code), meta(id, code)])) } }
  return { ...body, ballId: headManifestIdCanon(body) }
}
const codes = (...bodies: string[]): Record<string, string> => Object.fromEntries(bodies.map(code => [sha256(code), code]))
interface Lag {
  published: { ballId: string; epoch: number }
  running: { ballId: string; epoch: number }
  newer: boolean
  reloadBrings: boolean
  say: string
}

/** A tab at epoch 30 whose every plugin load and fiber disposal is counted. */
async function openTab(organs: Record<string, string>, respond?: (call: Call) => Response | Promise<Response | null> | null) {
  const a = makeHead('f'.repeat(64), 30, organs)
  const life = { loads: 0, disposals: 0 }
  const plugin = async () => { life.loads += 1; return { dispose() { life.disposals += 1 } } }
  const m = await mountE4({ head: { ball: a, codeBySha: codes(...Object.values(organs)) }, plugin, ...(respond ? { respond } : {}) })
  /** The edge publishes `next` and announces it on the HEAD socket, as head-do.mjs does after every commit. */
  const publish = (next: BallManifest, bodies: Record<string, string>) => {
    m.head.ball = next
    Object.assign(m.head.codeBySha, bodies)
    const socket = FakeSocket.instances.at(-1)!
    if (socket.readyState !== 1) socket.open()
    socket.receive(JSON.stringify({ type: 'ball:commit', fromPeerId: 'cloud-head', ball: { ballId: next.ballId } }))
  }
  return { a, m, life, publish }
}
const headJson = (m: Awaited<ReturnType<typeof mountE4>>) => m.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8') as string

describe('a head published while a tab is open', () => {
  it('mounts and disposes nothing, keeps the head it runs, and records the lag in one sentence', async () => {
    const { a, m, life, publish } = await openTab({ 'organ-a': ORGAN_A })
    const before = await m.status()
    expect(before).toMatchObject({ ballId: a.ballId, epoch: 30, headLag: null })
    const loads = life.loads, disposals = life.disposals, head = headJson(m)

    const b = child(a, { 'organ-a': ORGAN_A_NEXT, 'organ-b': ORGAN_B })
    publish(b, codes(ORGAN_A_NEXT, ORGAN_B))
    await until(async () => (await m.status()).headLag !== null)
    const after = await m.status()
    expect(after).toMatchObject({ ballId: a.ballId, epoch: 30 })
    expect(after.activeFibers).toEqual(before.activeFibers)
    expect([life.loads, life.disposals]).toEqual([loads, disposals])
    expect(headJson(m)).toBe(head)
    // Nothing of the published head is stored here either: a reload fetches it, verified, as any cold boot does.
    expect(m.vfs.existsSync(`/dsh/home/balls/${sha256(ORGAN_B)}.js`)).toBe(false)
    const lag = after.headLag as Lag
    expect(lag).toMatchObject({ newer: true, reloadBrings: true,
      published: { ballId: b.ballId, epoch: 31 }, running: { ballId: a.ballId, epoch: 30 } })
    expect(lag.say).toBe('A newer Auma is published (epoch 31); this tab runs epoch 30. One reload brings her.')
    // The same record reaches her facts answer and the page's notice route.
    expect(await m.tool('x6_facts').execute({})).toMatchObject({ headLag: { say: lag.say } })
    const route = await m.runtime.handleControlRequest('GET', '/__x6__/head-lag', '')
    expect(route).toEqual({ status: 200, body: { ok: true, headLag: lag, buildMismatch: null } })
  })

  it('head_adopt changes nothing and says a newer Auma is published and one reload brings her; force is refused', async () => {
    const { a, m, life } = await openTab({ 'organ-a': ORGAN_A })
    const b = child(a, { 'organ-b': ORGAN_B })
    m.head.ball = b
    m.head.codeBySha[sha256(ORGAN_B)] = ORGAN_B
    const loads = life.loads, disposals = life.disposals
    const adopt = m.tool('head_adopt')
    const answer = await adopt.execute({}) as Record<string, unknown> & { headLag: Lag }
    expect(answer).toMatchObject({ ok: true, adopted: false, alreadyCurrent: false,
      running: { ballId: a.ballId, epoch: 30 }, published: { ballId: b.ballId, epoch: 31 },
      say: 'A newer Auma is published (epoch 31); this tab runs epoch 30. One reload brings her.' })
    expect(answer.headLag).toMatchObject({ newer: true, published: { epoch: 31 } })
    const forced = await adopt.execute({ force: true }) as Record<string, unknown>
    expect(forced).toMatchObject({ ok: false, adopted: false, code: 'HEAD_ADOPT_FORCE_REFUSED' })
    expect(forced.say).toBe('force is not accepted: an open tab never hot-swaps to a published head. '
      + 'A newer Auma is published (epoch 31); this tab runs epoch 30. One reload brings her.')
    expect(await m.status()).toMatchObject({ ballId: a.ballId, epoch: 30 })
    expect([life.loads, life.disposals]).toEqual([loads, disposals])
    expect(adopt.parameters).toEqual({})
    expect(adopt.description).toContain('never hot-swaps')
    expect(adopt.description).toContain('one reload')
    // The snapshots service an organ can reach answers the same, and mounts nothing either.
    const services = (globalThis as { __X6_SERVICES__?: { snapshots?: { adoptHostHead(o?: unknown): Promise<unknown> } } }).__X6_SERVICES__
    expect(await services?.snapshots?.adoptHostHead()).toMatchObject({ adopted: false, published: { epoch: 31 } })
    expect((await m.status()).ballId).toBe(a.ballId)

    // When the published head is the one this tab runs, the answer says so and no lag is kept.
    m.head.ball = a
    expect(await adopt.execute({})).toMatchObject({ ok: true, adopted: false, alreadyCurrent: true, headLag: null,
      say: 'This tab runs the published Auma (epoch 30).' })
    expect((await m.status()).headLag).toBeNull()
  })

  it('a published manifest that does not hash to its ballId is not recorded as her head', async () => {
    const { a, m } = await openTab({ 'organ-a': ORGAN_A })
    m.head.ball = { ...child(a, { 'organ-b': ORGAN_B }), ballId: '0'.repeat(64) }
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: false, adopted: false, code: 'HEAD_MANIFEST_MALFORMED', headLag: null })
    expect(await m.status()).toMatchObject({ ballId: a.ballId, headLag: null })
  })

  it('a stalled edge read ends with HEAD_READ_STALLED (the cold boot\'s idle deadline) and blocks nothing', async () => {
    let stall = false
    const { a, m } = await openTab({ 'organ-a': ORGAN_A },
      call => stall && call.path === '/_head/ball' && call.method === 'GET' ? new Promise<null>(() => {}) : null)
    stall = true
    vi.stubGlobal('__X6_HEAD_READ_IDLE_MS__', 30)
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: false, code: 'HEAD_READ_STALLED', adopted: false })
    expect((await m.status()).ballId).toBe(a.ballId)
  })

  it('promote_staged and head_rollback from a tab behind the published head say one reload comes first', async () => {
    const { a, m } = await openTab({ 'organ-a': ORGAN_A })
    m.head.ball = child(a, { 'organ-b': ORGAN_B })
    const repo = m.tool('x6_repo')
    const promote = await repo.execute({ action: 'promote_staged' }) as Record<string, unknown>
    expect(promote).toMatchObject({ ok: false, code: 'HEAD_RELOAD_REQUIRED', failedHop: 'origin-check',
      say: 'A newer Auma is published (epoch 31); this tab runs epoch 30. One reload brings her.' })
    expect(await repo.execute({ action: 'head_rollback', to: a.ballId })).toMatchObject({ ok: false, code: 'HEAD_RELOAD_REQUIRED' })
    expect(m.calls.some(call => call.method === 'POST' && call.path === '/_head/ball')).toBe(false)
  })

  it('an organ write from a tab behind the published head mounts and disposes nothing and says one reload comes first', async () => {
    // HEAD grants the writer lease naming the head it has selected: the one published elsewhere, not the one this tab runs.
    let selected = ''
    const leases: string[] = []
    const { a, m, life } = await openTab({ 'organ-a': ORGAN_A }, (call) => {
      if (call.path !== '/_head/lease') return null
      const body = call.body as { action: string; ownerPeerId: string }
      leases.push(body.action)
      const lease = { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30_000 }
      return Response.json({ ok: true, ballId: selected, lease })
    })
    const b = child(a, { 'organ-a': ORGAN_A_NEXT, 'organ-b': ORGAN_B })
    m.head.ball = b
    Object.assign(m.head.codeBySha, codes(ORGAN_A_NEXT, ORGAN_B))
    selected = b.ballId
    const before = await m.status()
    const loads = life.loads, disposals = life.disposals, head = headJson(m)

    await expect(m.tool('tree_undo').execute({ id: 'organ-a' }))
      .rejects.toThrow('HEAD_RELOAD_REQUIRED: A newer Auma is published (epoch 31); this tab runs epoch 30. One reload brings her.')
    const after = await m.status()
    expect([life.loads, life.disposals]).toEqual([loads, disposals])
    expect(after).toMatchObject({ ballId: a.ballId, epoch: 30, retainedLocalFork: before.retainedLocalFork })
    expect(after.activeFibers).toEqual(before.activeFibers)
    expect(headJson(m)).toBe(head)
    expect(m.vfs.existsSync(`/dsh/home/balls/${sha256(ORGAN_B)}.js`)).toBe(false)
    expect(after.headLag).toMatchObject({ newer: true, published: { ballId: b.ballId, epoch: 31 } })
    // The lease was taken and given back; nothing was published.
    expect(leases).toEqual(['acquire', 'release'])
    expect(m.calls.some(call => call.method === 'POST' && call.path === '/_head/ball')).toBe(false)
  })

  it('a read that fails is recorded where status shows it, and one later read records the published head', async () => {
    let down = false
    const { a, m, publish } = await openTab({ 'organ-a': ORGAN_A },
      call => down && call.path === '/_head/ball' && call.method === 'GET' ? Response.json({ ok: false }, { status: 503 }) : null)
    vi.stubGlobal('__X6_HEAD_RETRY_MS__', 250)
    down = true
    const b = child(a, { 'organ-b': ORGAN_B })
    publish(b, codes(ORGAN_B))
    await until(async () => (await m.status()).headCheckFailure != null)
    expect(await m.status()).toMatchObject({ headLag: null, headCheckFailure: { code: 'HEAD_FETCH_FAILED', error: 'HTTP 503' } })
    down = false
    await until(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return (await m.status()).headLag !== null })
    const after = await m.status()
    expect(after).toMatchObject({ ballId: a.ballId, headCheckFailure: null, headLag: { published: { ballId: b.ballId, epoch: 31 } } })
  })

  it('an earlier read that succeeds is recorded when a later read fails', async () => {
    let gate: Promise<void> | null = null
    let open = (): void => {}
    let fail = false
    const { a, m } = await openTab({ 'organ-a': ORGAN_A }, async (call) => {
      if (call.path !== '/_head/ball' || call.method !== 'GET') return null
      if (fail) return Response.json({ ok: false }, { status: 503 })
      if (gate) { const held = gate; gate = null; await held }
      return null
    })
    const b = child(a, { 'organ-b': ORGAN_B })
    m.head.ball = b
    // Read 1 is held at the edge; read 2 starts after it and fails at once; then read 1's answer arrives.
    gate = new Promise<void>((resolve) => { open = resolve })
    const adopt = m.tool('head_adopt')
    const first = adopt.execute({})
    await until(async () => gate === null)
    fail = true
    expect(await adopt.execute({})).toMatchObject({ ok: false, code: 'HEAD_FETCH_FAILED' })
    expect((await m.status()).headCheckFailure).toMatchObject({ code: 'HEAD_FETCH_FAILED' })
    open()
    expect(await first).toMatchObject({ ok: true, published: { ballId: b.ballId, epoch: 31 } })
    expect(await m.status())
      .toMatchObject({ ballId: a.ballId, headCheckFailure: null, headLag: { published: { ballId: b.ballId, epoch: 31 } } })
  })
})

/**
 * This tab's adoption after ITS OWN promotion binds to the
 * ballId it published. If another writer published after it (its 30 s lease can expire before the read), nothing is
 * stored or mounted; the head is recorded and one reload brings it.
 */
describe('this tab adopts only the head it published', () => {
  async function promote(winner: 'mine' | 'another') {
    let me: Awaited<ReturnType<typeof openTab>> | null = null
    let other: BallManifest | null = null
    const leases: string[] = []
    me = await openTab({ 'organ-a': ORGAN_A }, async (call) => {
      if (call.path === '/_head/lease' && call.method === 'POST') {
        const body = call.body as { action: string; ownerPeerId: string }
        leases.push(body.action)
        const lease = { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30_000 }
        return Response.json({ ok: true, ballId: me!.m.head.ball.ballId, lease })
      }
      if (call.path === '/_head/ball' && call.method === 'POST') {
        const body = call.body as { ball: BallManifest; codeBySha: Record<string, string> }
        Object.assign(me!.m.head.codeBySha, body.codeBySha)
        me!.m.head.ball = body.ball
        if (winner === 'another') {
          // Another writer publishes right after this tab, before this tab reads the head back.
          other = child(body.ball, { 'organ-b': ORGAN_B })
          Object.assign(me!.m.head.codeBySha, codes(ORGAN_B))
          me!.m.head.ball = other
        }
        return Response.json({ ok: true, ballId: body.ball.ballId, epoch: body.ball.epoch })
      }
      return null
    })
    const { a, m, life } = me
    const mine = child(a, { 'organ-a': ORGAN_A_NEXT })
    m.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    m.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
      body: { ball: mine, codeBySha: codes(ORGAN_A, ORGAN_A_NEXT), expectedParentBallId: a.ballId, expectedEpoch: a.epoch } }) + '\n')
    const loads = life.loads
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged' }) as Record<string, unknown>
    return { a, m, life, mine, other: other as BallManifest | null, loads, result, leases }
  }

  it('adopts the head it published', async () => {
    const { m, life, mine, loads, result } = await promote('mine')
    expect(result).toMatchObject({ ok: true, promoted: true, ballId: mine.ballId,
      adopted: { ok: true, adopted: true, to: { ballId: mine.ballId } } })
    expect(life.loads).toBe(loads + 1)
    expect(await m.status()).toMatchObject({ ballId: mine.ballId, epoch: 31, headLag: null })
  })

  it('a head another writer published after it is recorded, never stored or mounted, and one reload brings it', async () => {
    const { a, m, life, mine, other, loads, result } = await promote('another')
    expect(other).not.toBeNull()
    expect(result).toMatchObject({ ok: true, promoted: true, ballId: mine.ballId,
      adopted: { ok: true, adopted: false, alreadyCurrent: false, code: 'HEAD_ADOPT_PUBLISHED_MOVED', to: { ballId: other!.ballId, epoch: 32 } } })
    expect((result.adopted as { say: string }).say).toContain('A newer Auma is published (epoch 32); this tab runs epoch 30. One reload brings her.')
    expect(life.loads).toBe(loads)
    expect(life.disposals).toBe(0)
    expect(m.vfs.existsSync(`/dsh/home/balls/${sha256(ORGAN_B)}.js`)).toBe(false)
    expect(await m.status())
      .toMatchObject({ ballId: a.ballId, epoch: 30, headLag: { newer: true, published: { ballId: other!.ballId, epoch: 32 } } })
    expect(headJson(m)).toContain(a.ballId)
  })
})

describe('every read of the published head is recorded in one order', () => {
  it('a late snapshots.checkHostHead answer never overwrites a later read', async () => {
    let gate: Promise<void> | null = null
    let open = (): void => {}
    const { a, m } = await openTab({ 'organ-a': ORGAN_A }, async (call) => {
      if (call.path !== '/_head/ball' || call.method !== 'GET' || !gate) return null
      const held = gate, answer = Response.json({ ok: true, ball: m.head.ball, codeBySha: m.head.codeBySha })
      gate = null
      await held
      return answer
    })
    const b = child(a, { 'organ-b': ORGAN_B })
    const c = child(b, { 'organ-a': ORGAN_A_NEXT })
    m.head.ball = b
    // The body map's read starts first and is held with B; then head_adopt reads C and records it; then B arrives.
    gate = new Promise<void>((resolve) => { open = resolve })
    type Services = { __X6_SERVICES__?: { snapshots?: { checkHostHead: () => Promise<unknown> } } }
    const snapshots = (globalThis as Services).__X6_SERVICES__!.snapshots!
    const late = snapshots.checkHostHead()
    await until(async () => gate === null)
    m.head.ball = c
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: true, published: { ballId: c.ballId, epoch: 32 } })
    open()
    await late
    expect(await m.status()).toMatchObject({ ballId: a.ballId, headLag: { published: { ballId: c.ballId, epoch: 32 } } })
  })
})

describe('a failed read is retried with bounded backoff while the failure remains', () => {
  it('reads again at 1x, 2x, 4x ... the base delay, at most six times, and stops at the first recorded success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let down = false
    let reads = 0
    const { a, m, publish } = await openTab({ 'organ-a': ORGAN_A }, (call) => {
      if (call.path !== '/_head/ball' || call.method !== 'GET') return null
      reads += 1
      return down ? Response.json({ ok: false }, { status: 503 }) : null
    })
    vi.stubGlobal('__X6_HEAD_RETRY_MS__', 1000)
    await vi.advanceTimersByTimeAsync(0)
    down = true
    const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
    const b = child(a, { 'organ-b': ORGAN_B })
    const before = reads
    publish(b, codes(ORGAN_B))
    await vi.waitFor(() => { expect(reads).toBe(before + 1) })
    // Retries at 1 s, then 2 s, 4 s, 8 s, 16 s, 32 s after each failure: six in all.
    for (const [delay, expected] of [[999, 1], [1, 2], [2000, 3], [4000, 4], [8000, 5], [16_000, 6], [32_000, 7], [600_000, 7]] as const) {
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
      expect(reads - before).toBe(expected)
    }
    expect((await m.status()).headCheckFailure).toMatchObject({ code: 'HEAD_FETCH_FAILED' })
    // A new announcement that fails starts a fresh chain; the first success ends it.
    publish(b, {})
    await vi.waitFor(() => { expect(reads - before).toBe(8) })
    down = false
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(reads - before).toBe(9)
    await vi.advanceTimersByTimeAsync(600_000)
    await flush()
    expect(reads - before).toBe(9)
    expect(await m.status())
      .toMatchObject({ ballId: a.ballId, headCheckFailure: null, headLag: { published: { ballId: b.ballId, epoch: 31 } } })
  })
})

describe('a recorded success ends a pending retry chain', () => {
  it('an announcement fails, a manual read succeeds, then a later outage: the retry already scheduled reads nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let down = false
    let reads = 0
    const { a, m, publish } = await openTab({ 'organ-a': ORGAN_A }, (call) => {
      if (call.path !== '/_head/ball' || call.method !== 'GET') return null
      reads += 1
      return down ? Response.json({ ok: false }, { status: 503 }) : null
    })
    vi.stubGlobal('__X6_HEAD_RETRY_MS__', 1000)
    await vi.advanceTimersByTimeAsync(0)
    const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
    down = true
    const b = child(a, { 'organ-b': ORGAN_B })
    const before = reads
    publish(b, codes(ORGAN_B))
    await vi.waitFor(async () => { expect((await m.status()).headCheckFailure).toMatchObject({ code: 'HEAD_FETCH_FAILED' }) })
    expect(reads - before).toBe(1)
    // A retry is now pending (1 s). A manual read succeeds before it fires.
    down = false
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: true, published: { ballId: b.ballId, epoch: 31 } })
    expect(reads - before).toBe(2)
    expect((await m.status()).headCheckFailure).toBeNull()
    // Another outage: the retry scheduled for the first failure must not fire into it and resume a chain.
    down = true
    await vi.advanceTimersByTimeAsync(600_000)
    await flush()
    expect(reads - before).toBe(2)
    expect(await m.status()).toMatchObject({ headCheckFailure: null, headLag: { published: { ballId: b.ballId, epoch: 31 } } })
  })
})

describe('a fiber that fails to load is not left registered', () => {
  it('a boot mount whose activation rejects disposes that fiber', async () => {
    const LEAKY = "module.exports = { leaky: true, apply() { throw new Error('apply fails') } }; // open-tab leaky"
    const a = makeHead('f'.repeat(64), 30, { 'organ-a': ORGAN_A, 'organ-leaky': LEAKY })
    const disposed: string[] = []
    const plugin = (candidate: unknown) => {
      const leaky = (candidate as { leaky?: boolean }).leaky === true
      const fiber = { dispose() { disposed.push(leaky ? 'leaky' : 'other') } }
      // Cordis returns the fiber at once, thenable; awaiting it rejects when apply() threw.
      return leaky ? Object.assign(Object.create(fiber) as object, { then: (_ok: unknown, fail: (e: unknown) => unknown) => fail(new Error('apply fails')) }) : Promise.resolve(fiber)
    }
    const m = await mountE4({ head: { ball: a, codeBySha: codes(ORGAN_A, LEAKY) }, plugin })
    const status = await m.status()
    expect(status.activeFibers).toContain('organ-a')
    expect(status.activeFibers).not.toContain('organ-leaky')
    expect(disposed).toEqual(['leaky'])
  })
})

describe('the app\'s build mismatch is recorded where /__x6__/status shows it', () => {
  it('a well-formed report is kept and shown; anything else is refused', async () => {
    const m = await mountE4()
    const report = { page: 'a'.repeat(40), edge: 'b'.repeat(40) }
    const answer = await m.runtime.handleControlRequest('POST', '/__x6__/build-mismatch', JSON.stringify(report))
    expect(answer).toMatchObject({ status: 200, body: { ok: true, buildMismatch: report } })
    expect((await m.status()).buildMismatch).toMatchObject({ ...report,
      say: `After a reload the edge still names build ${'b'.repeat(12)} while this page's bundle is stamped ${'a'.repeat(12)}; its notice is not shown again this session.` })
    for (const body of ['{', JSON.stringify({ page: 'a'.repeat(40), edge: 'a'.repeat(40) }), JSON.stringify({ page: 'x', edge: 'b'.repeat(40) }),
      JSON.stringify({ page: 'a'.repeat(40), edge: 'b'.repeat(40), pad: 'p'.repeat(2000) })]) {
      expect(await m.runtime.handleControlRequest('POST', '/__x6__/build-mismatch', body)).toMatchObject({ status: 400, body: { ok: false } })
    }
    expect(await m.runtime.handleControlRequest('GET', '/__x6__/build-mismatch', '')).toMatchObject({ status: 400 })
    expect((await m.status()).buildMismatch).toMatchObject(report)
  })
})

describe('x6_repo: a deployed-path commit to main is a proposal, never a Touch ID card', () => {
  const refusal = { ok: false, code: 'REPO_PROPOSAL_REQUIRED', paths: ['deploy/cloudflare/src/worker.mjs'],
    next: 'Put this change on auma/proposal/<slug>, then stage_proposal; the owner approves the merge in Sovereignty.' }
  const commit = { action: 'commit', branch: 'main', message: 'fix the edge',
    changes: [{ path: 'deploy/cloudflare/src/worker.mjs', content: 'export default {}\n' }] }

  for (const status of [403, 409]) {
    it(`hands the edge's REPO_PROPOSAL_REQUIRED (HTTP ${String(status)}) back unchanged, next included, and stages nothing`, async () => {
      const m = await mountE4({ respond: (call: Call) => call.path === '/_host/repo' ? Response.json(refusal, { status }) : null })
      expect(await m.tool('x6_repo').execute(commit)).toEqual(refusal)
      expect(m.vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
    })
  }

  it('a real Class 3 answer on main still stages the outward card, and the description names the proposal rule', async () => {
    const m = await mountE4({ respond: (call: Call) => call.path === '/_host/repo' ? Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 }) : null })
    const repo = m.tool('x6_repo')
    expect(await repo.execute(commit)).toMatchObject({ code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: true, sent: false })
    expect(m.vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(true)
    expect(repo.description).toContain('REPO_PROPOSAL_REQUIRED')
    expect(repo.description).toContain('stages no Touch ID card')
  })
})
