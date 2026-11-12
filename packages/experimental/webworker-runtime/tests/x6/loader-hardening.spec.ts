/** Loader hardening exercised through real Cordis fibers and the real ToolsService; only the edge is local. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { persistence } from '../../src/storage/idb-persist.ts'
import { STAGED_HEAD_PROMOTION_PATH, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { FakeSocket, headManifestIdCanon, mountE4, sha256, type Responder } from './e4-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PLAIN = 'module.exports = { apply() {} } // hardening plain'
const NEXT = 'module.exports = { apply() {} } // hardening next'
const SUPPORT = 'module.exports = { helper() { return 1 } } // hardening support'
const WRONG = "module.exports = { name: 'other-name', run() {} } // hardening mismatch"
const FAIL = "throw new Error('FAILED_MODULE: ' + 'x'.repeat(200)) // hardening failure"
const builtIns = ['scion_grow', 'ball_put', 'tree_patch', 'tree_undo', 'ball_status', 'head_adopt', 'x6_repo', 'x6_nostr']
type Organ = [string, string, Partial<BallEntryRecord>?]
function makeHead(organs: Organ[], epoch = 30, parentBallId = 'f'.repeat(64)): BallManifest {
  const entries = Object.fromEntries(organs.map(([id, code, extra]) => [id, {
    id, specifier: `ball:${sha256(code)}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000, ...extra,
  }]))
  const modules = Object.fromEntries(organs.map(([id, code]) => [sha256(code), {
    sha256: sha256(code), specifier: `ball:${sha256(code)}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000,
  }]))
  const body = { version: 'x6.1-ball/v1' as const, parentBallId, epoch, createdAt: 1000 + epoch, authorPeerId: 'hardening-fixture', entries, modules }
  return { ...body, ballId: headManifestIdCanon(body) }
}
async function boot(organs: Organ[], options: { respond?: Responder; beforeMount?: (context: Context) => void } = {}) {
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  options.beforeMount?.(context)
  const ball = makeHead(organs)
  const head = { ball, codeBySha: Object.fromEntries(organs.map(([, code]) => [sha256(code), code])) }
  const m = await mountE4({ head, host: { context, dshTools }, nodeBuiltins: true,
    ...(options.respond ? { respond: options.respond } : {}) })
  expect((await m.status()).ballId).toBe(ball.ballId)
  return { ...m, context }
}
type Mounted = Awaited<ReturnType<typeof boot>>
type States = Record<string, { state: string; reason?: string }>
const states = async (m: Mounted) => ((await m.status()).fiberHealth as { entries: States }).entries
type SnapshotServices = { __X6_SERVICES__?: { snapshots: { checkHostHead(): Promise<unknown> } } }
const snapshots = () => (globalThis as SnapshotServices).__X6_SERVICES__!.snapshots

/** Drive the same post-publish reconciliation as x6_repo, with every edge response confined to the fixture. */
async function promotionFixture(organs: Organ[]) {
  const m: Mounted = await boot(organs, { respond: (call) => {
    if (call.path === '/_head/lease') {
      const body = call.body as { ownerPeerId: string }
      return Response.json({ ok: true, ballId: m.head.ball.ballId,
        lease: { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30_000 } })
    }
    if (call.path === '/_head/ball' && call.method === 'POST') {
      const body = call.body as { ball: BallManifest; codeBySha: Record<string, string> }
      m.head.ball = body.ball
      Object.assign(m.head.codeBySha, body.codeBySha)
      return Response.json({ ok: true, ballId: body.ball.ballId, epoch: body.ball.epoch })
    }
    return null
  } })
  const promote = async (id: string, code: string) => {
    const parent = m.head.ball
    const sha = sha256(code)
    const body = { ...parent, parentBallId: parent.ballId, epoch: parent.epoch + 1, createdAt: parent.createdAt + 1,
      entries: { ...parent.entries, [id]: { ...parent.entries[id]!, specifier: `ball:${sha}`, updatedAt: parent.createdAt + 1 } },
      modules: { ...parent.modules, [sha]: { sha256: sha, specifier: `ball:${sha}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 } } }
    const candidate = { ...body, ballId: headManifestIdCanon(body) }
    const codeBySha = { ...m.head.codeBySha, [sha]: code }
    m.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    m.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
      body: { ball: candidate, codeBySha, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch } }))
    const result = await m.tool('x6_repo').execute({ action: 'promote_staged' })
    return { candidate, result }
  }
  return { m, promote }
}

describe('built-in tool registration is earlier than HEAD and independently contained', () => {
  it('HEAD cannot take a built-in name or remove the later built-ins', async () => {
    const collision = "module.exports = { name: 'scion-grow', run() { return 'head-owned' } }"
    const m = await boot([['scion-grow', collision], ['ordinary', PLAIN]])
    const names = m.context.tools.definitions().map(tool => tool.name)
    expect(builtIns.filter(name => !names.includes(name))).toEqual([])
    expect(m.context.tools.get('scion_grow')?.description).toContain('Compile supplied TypeScript')
    expect((await states(m))['scion-grow']).toMatchObject({ state: 'not-running', reason: 'TOOL_REGISTRATION_REFUSED' })
    expect((await states(m)).ordinary).toEqual({ state: 'running' })
  })

  it('an existing host collision is reported without skipping other registrations, and effects dispose', async () => {
    const m = await boot([['ordinary', PLAIN]], { beforeMount: (context) => {
      context.tools.register(dshTools.defineTool({ name: 'scion_grow', description: 'Existing host tool', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] }, execute: async () => ({ host: true }) }))
    } })
    expect(builtIns.filter(name => !m.context.tools.get(name))).toEqual([])
    expect(m.context.tools.get('scion_grow')?.description).toBe('Existing host tool')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('scion_grow'), expect.any(Error))
    const tools = m.context.tools
    await m.context.fiber.dispose()
    expect(tools.definitions()).toEqual([])
  })
})

describe('boot registration does not start background processing before HEAD is ready', () => {
  it('opens the presence socket only after a suspended real Cordis apply completes', async () => {
    let release = (): void => {}, started = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    vi.stubGlobal('__loaderBootGate', async () => { started(); await gate })
    const slow = 'module.exports = { async apply() { await globalThis.__loaderBootGate() } }'
    const pending = boot([['slow-organ', slow]])
    try {
      await entered
      expect(FakeSocket.instances).toHaveLength(0)
    } finally {
      release()
      await pending
    }
    const m = await pending
    expect(FakeSocket.instances).toHaveLength(1)
    expect((await states(m))['slow-organ']).toEqual({ state: 'running' })
  })
})

describe('HEAD reconciliation preserves unchanged nonmounting siblings', () => {
  it.each([['mismatch', WRONG], ['support', SUPPORT], ['load-failure', FAIL]])('%s does not reject a valid sibling update', async (_kind, code) => {
    const { m, promote } = await promotionFixture([['known-entry', code], ['ordinary', PLAIN]])
    const before = (await states(m))['known-entry']
    const { candidate, result } = await promote('ordinary', NEXT)
    expect(result).toMatchObject({ ok: true, promoted: true, adopted: { ok: true, adopted: true } })
    expect((await m.status()).ballId).toBe(candidate.ballId)
    expect((await states(m))['known-entry']).toEqual(before)
    expect((await states(m)).ordinary).toEqual({ state: 'running' })
  })

  it('retries a changed failed entry rather than preserving its old failure', async () => {
    const { m, promote } = await promotionFixture([['known-entry', WRONG]])
    const { result } = await promote('known-entry', PLAIN)
    expect(result).toMatchObject({ adopted: { ok: true, adopted: true } })
    expect((await states(m))['known-entry']).toEqual({ state: 'running' })
  })

  it('restores the old nonmounted diagnosis when its changed candidate fails', async () => {
    const { m, promote } = await promotionFixture([['known-entry', WRONG]])
    const before = (await states(m))['known-entry']
    const selected = (await m.status()).ballId
    const { result } = await promote('known-entry', FAIL)
    expect(result).toMatchObject({ adopted: { ok: false, adopted: false } })
    expect((result as { adopted: { error: string } }).adopted.error).toContain('FAILED_MODULE')
    expect(JSON.stringify(result)).not.toContain('MANIFEST_RECOVERY_FAILED')
    expect((await m.status()).ballId).toBe(selected)
    expect((await states(m))['known-entry']).toEqual(before)
  })

  it('a plugin replaced by a support module disposes its effects and leaves no fiber', async () => {
    vi.stubGlobal('__loaderDisposed', false)
    const plugin = 'module.exports = { apply(ctx) { ctx.effect(() => () => { globalThis.__loaderDisposed = true }) } }'
    const { m, promote } = await promotionFixture([['ordinary', plugin]])
    const { result } = await promote('ordinary', SUPPORT)
    expect(result).toMatchObject({ adopted: { ok: true, adopted: true } })
    expect((globalThis as { __loaderDisposed?: boolean }).__loaderDisposed).toBe(true)
    expect((await states(m)).ordinary).toEqual({ state: 'support-module', decidedBy: 'exports' })
    expect((await m.status()).activeFibers).not.toContain('ordinary')
  })

  it('an entry cannot forge the loader support-module decision', async () => {
    const { m, promote } = await promotionFixture([['ordinary', PLAIN]])
    const selected = (await m.status()).ballId
    const { result } = await promote('ordinary', "throw Object.assign(new Error('SUPPORT_MODULE'), { code: 'SUPPORT_MODULE', supportModule: true })")
    expect(result).toMatchObject({ adopted: { ok: false, adopted: false } })
    expect((await m.status()).ballId).toBe(selected)
    expect((await states(m)).ordinary).toEqual({ state: 'running' })
  })
})

describe('bounded status retains compact inventory and important warnings', () => {
  it('keeps all 300 compact states, running entries, head lag and persistence when details exceed 64 KiB', async () => {
    const savedError = persistence.localSave.error, mirrorError = persistence.mirror.error
    onTestFinished(() => { persistence.localSave.error = savedError; persistence.mirror.error = mirrorError })
    persistence.localSave.error = 'unsaved:' + 'x'.repeat(20_000)
    persistence.mirror.error = 'offline:' + 'y'.repeat(20_000)
    const organs: Organ[] = Array.from({ length: 280 }, (_, index) => [`failed-${index}`, `${FAIL} ${index}`])
    organs.push(...Array.from({ length: 20 }, (_, index): Organ => [`running-${index}`, `${PLAIN} ${index}`]))
    const m = await boot(organs)
    const published = makeHead(organs, 31, m.head.ball.ballId)
    m.head.ball = published
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: true, headLag: { newer: true } })
    m.head.ball = { ...published, ballId: '0'.repeat(64) }
    expect(await m.tool('head_adopt').execute({})).toMatchObject({ ok: false, code: 'HEAD_MANIFEST_MALFORMED' })
    const full = await m.status()
    const answer = await m.tool('ball_status').execute({ includeManifest: true }) as Record<string, unknown>
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(answer.headLag).toEqual(full.headLag)
    expect(answer.persistence).toMatchObject({ durable: false, readOnly: false,
      localSave: { error: ('unsaved:' + 'x'.repeat(20_000)).slice(0, 300) },
      mirror: { error: ('offline:' + 'y'.repeat(20_000)).slice(0, 300) } })
    expect(Object.keys((answer.fiberHealth as { entries: States }).entries)).toHaveLength(300)
    expect((answer.fiberHealth as { entries: States }).entries['failed-279']).toEqual({ state: 'not-running', reason: 'MODULE_LOAD_FAILED' })
    expect((answer.fiberHealth as { entries: States }).entries['running-19']).toEqual({ state: 'running' })
    expect(answer.headCheckFailure).toMatchObject({ code: 'HEAD_MANIFEST_MALFORMED' })
    expect(answer).toHaveProperty('manifestOmitted')
  })
})

describe('every successful head metadata read was validated', () => {
  it('rejects wrong version, epoch, identity and refused envelopes without replacing verified metadata', async () => {
    let response: unknown = null
    const m = await boot([['ordinary', PLAIN]], { respond: call =>
      response !== null && call.method === 'GET' && call.path === '/_head/ball' ? Response.json(response) : null })
    const valid = makeHead([['ordinary', PLAIN]], 31, m.head.ball.ballId)
    m.head.ball = valid
    await snapshots().checkHostHead()
    const trusted = await m.status()
    for (const invalid of [
      { ok: false, ball: valid },
      { ok: true, ball: { ...valid, version: 'wrong' } },
      { ok: true, ball: { ...valid, epoch: -1 } },
      { ok: true, ball: { ...valid, ballId: '0'.repeat(64) } },
      { ok: true, ball: { ...valid, modules: [] } },
    ]) {
      response = { ...invalid, buildSha: 'untrusted-build' }
      await snapshots().checkHostHead()
      const status = await m.status()
      expect(status.headLag).toEqual(trusted.headLag)
      expect(status.hostSourceSha).toEqual(trusted.hostSourceSha)
    }
  })

  it('body-map rejects malformed metadata without clearing the failure or cancelling its retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('__X6_HEAD_RETRY_MS__', 1000)
    const m = await boot([['ordinary', PLAIN]])
    const valid = makeHead([['ordinary', PLAIN]], 31, m.head.ball.ballId)
    m.head.ball = { ...valid, ballId: '0'.repeat(64) }
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    socket.receive(JSON.stringify({ type: 'ball:commit', fromPeerId: 'fixture', ball: { ballId: valid.ballId } }))
    await vi.waitFor(async () => { expect((await m.status()).headCheckFailure).toMatchObject({ code: 'HEAD_MANIFEST_MALFORMED' }) })
    const before = m.calls.filter(call => call.path === '/_head/ball').length
    await snapshots().checkHostHead()
    expect((await m.status()).headCheckFailure).toMatchObject({ code: 'HEAD_MANIFEST_MALFORMED' })
    m.head.ball = valid
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls.filter(call => call.path === '/_head/ball')).toHaveLength(before + 2)
    expect(await m.status()).toMatchObject({ headCheckFailure: null, headLag: { published: { ballId: valid.ballId, epoch: 31 } } })
  })
})
