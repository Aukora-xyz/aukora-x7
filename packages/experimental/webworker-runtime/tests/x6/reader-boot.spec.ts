/**
 * Her tree boots cleanly in a browser that only reads her. While this page is a reader the
 * worker's fetch wrapper refuses every same-origin call that is not a GET or HEAD (and the GETs that change her node),
 * so `POST /_head/lease` (the first-bootstrap lease) never leaves. Her runtime mounts anyway: with a head it adopts it
 * as a remote head (no lease wanted); with no head it asks for the lease, the refusal is caught, and it goes on at epoch
 * 0 with nothing written to her edge. `x6_self_state` then says `threadSync.role: reader`.
 * The fetch stub applies `readerRefusal` exactly as worker-host.ts's the thread sync reader block does. No network.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountX6BallRuntime, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { READER_OLDER_FOOTER, readerRefusal, threadReader, threadSyncState, threadSyncSwitch } from '../../src/storage/thread-sync.ts'

const ORIGIN = 'https://reader-boot-fixture.invalid'
const SEED_DIR = '/dsh/home/auma/seed/organs'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const manifestId = (ball: BallManifest): string => hash(JSON.stringify({
  version: ball.version, parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(id => ball.entries[id]),
  modules: Object.keys(ball.modules).sort().map(sha => ball.modules[sha]) }))

function selectedHead() {
  const code = 'module.exports = { apply() {} }; // reader-boot organ'
  const sha = hash(code)
  const entry: BallEntryRecord = { id: 'organ-a', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
  const draft: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 7, createdAt: 1000, authorPeerId: 'fixture-author',
    entries: { 'organ-a': entry }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'organ-a', description: 'Synthetic module', size: Buffer.byteLength(code), createdAt: 1000 } } }
  return { ball: { ...draft, ballId: manifestId(draft) }, code, sha }
}

afterEach(() => {
  threadReader.footer = null; threadSyncState.role = null; threadSyncSwitch.on = false
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function readerBoot(head: Response | (() => Response)) {
  // A reader exists only while thread sync is switched on (bootThreadSyncIfOn sets this switch).
  threadSyncSwitch.on = true
  threadReader.footer = READER_OLDER_FOOTER
  threadSyncState.role = 'reader'
  const vfs = new MemoryVfs()
  vfs.mkdirSync(SEED_DIR, { recursive: true })
  vfs.writeFileSync(`${SEED_DIR}/seed-reader-boot.js`, 'module.exports = { apply() {} }; // seed')
  const reached: Array<{ method: string; path: string }> = []
  const refused: Array<{ method: string; path: string }> = []
  const provided = new Map<string, unknown>()
  class Tools {
    readonly registry = new Map<string, { name: string; execute?: (args: unknown) => Promise<unknown> }>()
    register(definition: unknown) {
      const tool = definition as { name: string }
      this.registry.set(tool.name, tool)
      return () => { this.registry.delete(tool.name) }
    }
    get(name: string) { return this.registry.get(name) }
    definitions() { return [...this.registry.values()] }
  }
  const context = { tools: new Tools(), get: (name: string) => provided.get(name),
    provide: (name: string, value?: unknown) => { provided.set(name, value) },
    plugin: async () => ({ dispose() {} }) }
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    // worker-host.ts the thread sync reader block, exactly: the reader's refusal, before anything leaves.
    const said = readerRefusal(request.url, ORIGIN, init?.method ?? request.method)
    if (said !== null) { refused.push({ method: request.method, path: url.pathname }); throw new TypeError(said) }
    reached.push({ method: request.method, path: url.pathname })
    if (url.pathname === '/_head/ball' && request.method === 'GET') return typeof head === 'function' ? head() : head.clone()
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  const runtime = await mountX6BallRuntime(context as unknown as Parameters<typeof mountX6BallRuntime>[0], vfs, loader)
  const status = (await runtime.handleControlRequest('GET', '/__x6__/status', ''))?.body as { epoch: number; headFetchError: string | null }
  const selfState = await context.tools.get('x6_self_state')?.execute?.({}) as { threadSync?: unknown } | undefined
  return { reached, refused, status, selfState, tools: context.tools }
}

describe('a reader\'s tree boots cleanly', () => {
  it('no head in her cloud: the bootstrap lease POST is refused before it leaves, the runtime mounts at epoch 0, and nothing but GETs reached her edge', async () => {
    const boot = await readerBoot(() => Response.json({ ok: true, ball: null, codeBySha: {} }))
    expect(boot.refused.some(call => call.method === 'POST' && call.path === '/_head/lease')).toBe(true)
    expect(boot.reached.every(call => call.method === 'GET' || call.method === 'HEAD')).toBe(true)
    expect(boot.status.epoch).toBe(0)
    expect(boot.tools.get('x6_self_state')).toBeDefined()
    expect(boot.selfState?.threadSync).toMatchObject({ role: 'reader' })
  })

  it('her head in her cloud: adopted as a remote head with no lease asked and nothing refused that she needed', async () => {
    const head = selectedHead()
    const boot = await readerBoot(() => Response.json({ ok: true, ball: head.ball, codeBySha: { [head.sha]: head.code } }))
    expect(boot.status.headFetchError).toBeNull()
    expect(boot.status.epoch).toBe(7)
    expect(boot.refused.filter(call => call.path === '/_head/lease')).toEqual([])
    expect(boot.reached.every(call => call.method === 'GET' || call.method === 'HEAD')).toBe(true)
  })
})
