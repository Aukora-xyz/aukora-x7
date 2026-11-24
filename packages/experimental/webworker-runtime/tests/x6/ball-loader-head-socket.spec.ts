/**
 * Lane E3: her runtime reports its own /_head/ws socket on GET /__x6__/status as `headSocket`, because Playwright
 * cannot see a dedicated worker's frames. 'open' only for the active socket with readyState 1, not closed, and at least
 * one frame on that socket; 'connecting' before a frame; 'closed' after close or error; 'absent' with no WebSocket or
 * no origin. A reconnect resets the per-socket frame counters (old frames never vouch for a new socket).
 * No browser or network: WebSocket is a local fake and fetch answers a valid selected head on a reserved `.invalid` origin.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountX6BallRuntime, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { createHeadSocketTracker, type HeadSocketTelemetry, type TrackedSocket } from '../../src/x6/head-socket-telemetry.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const ORIGIN = 'https://head-socket-fixture.invalid'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const manifestId = (ball: BallManifest): string => hash(JSON.stringify({
  version: ball.version, parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(id => ball.entries[id]),
  modules: Object.keys(ball.modules).sort().map(sha => ball.modules[sha]) }))

function selectedHead() {
  const code = 'module.exports = { apply() {} }; // head-socket organ'
  const sha = hash(code)
  const entry: BallEntryRecord = { id: 'organ-a', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
  const draft: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 3, createdAt: 1000, authorPeerId: 'fixture-author',
    entries: { 'organ-a': entry },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'organ-a', description: 'Synthetic module', size: Buffer.byteLength(code), createdAt: 1000 } } }
  return { ball: { ...draft, ballId: manifestId(draft) }, codeBySha: { [sha]: code } }
}

/** A WebSocket stand-in with the browser's send-before-open refusal and both handler styles. */
class FakeSocket {
  static readonly instances: FakeSocket[] = []
  readyState = 0
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: send() before open')
    this.sent.push(data)
  }
  private fire(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  open(): void { this.readyState = 1; this.fire('open', {}); this.onopen?.() }
  receive(data: string): void { this.fire('message', { data }); this.onmessage?.({ data }) }
  error(): void { this.fire('error', {}) }
  close(code = 1006): void { this.readyState = 3; this.fire('close', { code }); this.onclose?.({ code }) }
}

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function boot(options: { webSocket?: unknown; origin?: string } = {}) {
  const vfs = new MemoryVfs()
  const provided = new Map<string, unknown>()
  class Tools {
    readonly registry = new Map<string, { name: string }>()
    register(definition: unknown) {
      const tool = definition as { name: string }
      this.registry.set(tool.name, tool)
      return () => { this.registry.delete(tool.name) }
    }
    get(name: string) { return this.registry.get(name) }
    definitions() { return [...this.registry.values()] }
  }
  const context = { tools: new Tools(), get: (name: string) => provided.get(name),
    provide: (name: string, value?: unknown) => { provided.set(name, value) }, plugin: async () => ({ dispose() {} }) }
  const origin = options.origin ?? ORIGIN
  vi.stubGlobal('location', { origin })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', 'webSocket' in options ? options.webSocket : FakeSocket)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const head = selectedHead()
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: head.ball, codeBySha: head.codeBySha })
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  const runtime = await mountX6BallRuntime(context as unknown as Parameters<typeof mountX6BallRuntime>[0], vfs, loader)
  const status = async (): Promise<HeadSocketTelemetry> => {
    const reply = await runtime.handleControlRequest('GET', '/__x6__/status', '')
    return (reply?.body as { headSocket: HeadSocketTelemetry }).headSocket
  }
  return { runtime, status }
}

describe('GET /__x6__/status headSocket: her worker socket, by the observer\'s honesty rule', () => {
  it('connecting with zero frames, open only after a frame crossed the open socket', async () => {
    const { status } = await boot()
    expect(FakeSocket.instances).toHaveLength(1)
    const socket = FakeSocket.instances[0]!
    expect(new URL(socket.url).pathname).toBe('/_head/ws')
    expect(await status()).toMatchObject({ state: 'connecting', framesReceived: 0, framesSent: 0, errors: 0, reconnects: 0, readyState: 0 })
    // readyState 1 alone (no frame either way yet) is still not proof of an open socket.
    socket.readyState = 1
    expect((await status()).state).toBe('connecting')
    socket.readyState = 0
    socket.open() // onopen sends presence:hello: one real, accepted frame.
    expect(socket.sent.map(frame => (JSON.parse(frame) as { type: string }).type)).toEqual(['presence:hello'])
    expect(await status()).toMatchObject({ state: 'open', framesSent: 1, framesReceived: 0, readyState: 1 })
    socket.receive(JSON.stringify({ type: 'presence:noop' }))
    expect(await status()).toMatchObject({ state: 'open', framesSent: 1, framesReceived: 1, totalFramesReceived: 1, totalFramesSent: 1 })
  })

  it('a received greeting alone proves open (HEAD greets every socket with ball:commit)', async () => {
    const { status } = await boot()
    const socket = FakeSocket.instances[0]!
    socket.readyState = 1
    socket.receive(JSON.stringify({ type: 'presence:noop' }))
    expect(await status()).toMatchObject({ state: 'open', framesReceived: 1, framesSent: 0 })
  })

  it('errored then closed is closed; the reconnect starts at zero frames (connecting) and counts one reconnect', async () => {
    const { status } = await boot()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(JSON.stringify({ type: 'presence:noop' }))
    expect((await status()).state).toBe('open')
    first.error()
    first.close(1011)
    expect(await status()).toMatchObject({ state: 'closed', errors: 1, lastCloseCode: 1011, readyState: 3 })
    vi.advanceTimersByTime(3000)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(await status()).toMatchObject({ state: 'connecting', framesReceived: 0, framesSent: 0, reconnects: 1, errors: 1,
      totalFramesReceived: 1, totalFramesSent: 1, lastCloseCode: null })
    // A late frame on the dead socket never vouches for the new one.
    first.receive(JSON.stringify({ type: 'presence:noop' }))
    expect((await status()).state).toBe('connecting')
    FakeSocket.instances[1]!.open()
    expect(await status()).toMatchObject({ state: 'open', framesSent: 1, reconnects: 1 })
  })

  it('a closing socket (readyState 2) is closed even with frames', async () => {
    const { status } = await boot()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.readyState = 2
    expect((await status()).state).toBe('closed')
  })

  it('absent without WebSocket, and absent on an opaque origin', async () => {
    expect(await (await boot({ webSocket: undefined })).status()).toMatchObject({ state: 'absent', framesReceived: 0, framesSent: 0, readyState: null })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    FakeSocket.instances.length = 0
    const opaque = await boot({ origin: 'null' }).catch((error: unknown) => error)
    if (opaque instanceof Error) {
      // A 'null' origin cannot fetch a head either; the socket must still never have been opened.
      expect(FakeSocket.instances).toHaveLength(0)
    } else {
      expect(await (opaque as Awaited<ReturnType<typeof boot>>).status()).toMatchObject({ state: 'absent' })
      expect(FakeSocket.instances).toHaveLength(0)
    }
  })
})

describe('createHeadSocketTracker (pure)', () => {
  const socket = (): TrackedSocket & { fire(type: string, event?: unknown): void; readyState: number } => {
    const listeners = new Map<string, Array<(event: { code?: number }) => void>>()
    return {
      readyState: 0,
      send() {},
      addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]) },
      fire(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event as { code?: number }) },
    }
  }

  it('is absent until marked available and attached; send failures are not counted', () => {
    const tracker = createHeadSocketTracker()
    expect(tracker.snapshot().state).toBe('absent')
    const s = socket()
    tracker.attach(s)
    expect(tracker.snapshot().state).toBe('absent')
    tracker.markAvailable()
    expect(tracker.snapshot().state).toBe('connecting')
    s.send = (() => { throw new Error('not open') }) as never
    const refusing = socket()
    refusing.send = () => { throw new Error('InvalidStateError') }
    tracker.attach(refusing)
    expect(() => { refusing.send('x') }).toThrow('InvalidStateError')
    expect(tracker.snapshot()).toMatchObject({ state: 'connecting', framesSent: 0, reconnects: 1 })
    tracker.noteError()
    expect(tracker.snapshot().errors).toBe(1)
  })
})
