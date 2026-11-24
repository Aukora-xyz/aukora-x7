/**
 * Lane E4 shared fixture: mount her real runtime against a synthetic, reserved `.invalid` origin. Every HTTP answer is
 * local (`respond`), WebSocket is a local fake, and no provider, owner approval or live DO is touched.
 */
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { mountX6BallRuntime, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import * as moduleLoader from '../../src/module-system/module-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import * as activeVfs from '../../src/storage/active.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

export const ORIGIN = 'https://lane-e4-fixture.invalid'
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** HEAD's own `canonicalBootstrap` (deploy/cloudflare/src/head-do.mjs), reimplemented independently for the test. */
export function canonicalBootstrap(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalBootstrap).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalBootstrap((value as Record<string, unknown>)[key])).join(',') + '}'
  }
  throw new Error('BOOTSTRAP_INVALID_VALUE')
}
/** HEAD's `manifestIdCanon`: sha256 of the canonical manifest without ballId. */
export function headManifestIdCanon(ball: Record<string, unknown>): string {
  const { ballId: _ignored, ...rest } = ball
  return sha256(canonicalBootstrap(rest))
}

export const ORGAN_A = 'module.exports = { apply() {} }; // lane-e4 organ-a v1'
export const ORGAN_A2 = 'module.exports = { apply() {} }; // lane-e4 organ-a v2'
export const PEARL_V1 = 'module.exports = { apply() {} }; // lane-e4 seed-pearl v1'
export const PEARL_V2 = 'module.exports = { apply() {} }; // lane-e4 seed-pearl v2'

/** A canonical-id live head at epoch 7 with one ordinary organ and one governance organ (`seed-pearl`). */
export function liveHead(overrides: { entries?: Record<string, unknown> } = {}) {
  const shaA = sha256(ORGAN_A), shaL = sha256(PEARL_V1)
  const entry = (id: string, sha: string): BallEntryRecord => ({ id, specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 })
  const body = {
    version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: 7, createdAt: 1000, authorPeerId: 'fixture-author',
    entries: { 'organ-a': entry('organ-a', shaA), 'seed-pearl': entry('seed-pearl', shaL), ...(overrides.entries ?? {}) } as Record<string, BallEntryRecord>,
    modules: {
      [shaA]: { sha256: shaA, specifier: `ball:${shaA}`, name: 'organ-a', description: 'Synthetic', size: ORGAN_A.length, createdAt: 1000 },
      [shaL]: { sha256: shaL, specifier: `ball:${shaL}`, name: 'seed-pearl', description: 'Synthetic governance', size: PEARL_V1.length, createdAt: 1000 },
    },
  }
  const ball = { ...body, ballId: headManifestIdCanon(body) } as BallManifest
  return { ball, codeBySha: { [shaA]: ORGAN_A, [shaL]: PEARL_V1 } as Record<string, string> }
}

/** A WebSocket stand-in with both handler styles. */
export class FakeSocket {
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
  send(data: string): void { if (this.readyState !== 1) throw new Error('InvalidStateError'); this.sent.push(data) }
  private fire(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  open(): void { this.readyState = 1; this.fire('open', {}); this.onopen?.() }
  receive(data: string): void { this.fire('message', { data }); this.onmessage?.({ data }) }
  close(code = 1006): void { this.readyState = 3; this.fire('close', { code }); this.onclose?.({ code }) }
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}
export interface Call { method: string; path: string; credentials: RequestCredentials; headers: Headers; body: unknown }
export type Responder = (call: Call) => Response | Promise<Response | null> | null

/**
 * Mount the runtime. `respond` answers first; GET /_head/ball falls back to `head`; anything else is 404 NOT_IN_FIXTURE.
 */
export async function mountE4(options: {
  head?: ReturnType<typeof liveHead>
  respond?: Responder
  vfs?: MemoryVfs
  /** Stands in for Cordis `ctx.plugin` (default: every plugin loads, and its fiber disposes as a no-op). */
  plugin?: (plugin: unknown, config: unknown) => unknown
  /** The worker's own node builtins (`fs`, `path`, `crypto`, ...) over this VFS, as worker.ts gives her loader. */
  nodeBuiltins?: boolean
  /** A synthetic build pin, installed before runtime boot. */
  buildIdentity?: Record<string, unknown>
  /** A REAL host instead of the stand-ins: a Cordis Context with DSH's ToolsService mounted, and the
   *  real `@deepseek-ai/dsh-tools` module for her loader's `defineTool`. `plugin` is then unused. */
  host?: { context: { tools: { get(name: string): unknown } }; dshTools: unknown }
} = {}) {
  const vfs = options.vfs ?? new MemoryVfs()
  const head = options.head ?? liveHead()
  const calls: Call[] = []
  const provided = new Map<string, unknown>()
  class Tools {
    readonly registry = new Map<string, Tool>()
    register(definition: unknown) {
      const tool = definition as Tool
      this.registry.set(tool.name, tool)
      return () => { this.registry.delete(tool.name) }
    }
    get(name: string) { return this.registry.get(name) }
    definitions() { return [...this.registry.values()] }
  }
  const tools = new Tools()
  const standIn = { tools, get: (name: string) => provided.get(name),
    provide: (name: string, value?: unknown) => { provided.set(name, value) },
    // Cordis `ctx.effect` runs its setup synchronously and rethrows (vendor/cordis/lib/index.js:541-556), so tools her
    // runtime registers inside an effect (scion_grow, x6_host_facts, ...) are registered here too.
    effect: (setup: () => unknown): (() => void) => {
      const dispose = setup()
      return typeof dispose === 'function' ? dispose as () => void : () => {}
    },
    plugin: options.plugin ?? (async () => ({ dispose() {} })) }
  const context = options.host?.context ?? standIn
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', options.buildIdentity)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    const text = request.method === 'GET' ? '' : await request.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    const call: Call = { method: request.method, path: url.pathname, credentials: init?.credentials ?? request.credentials,
      headers: request.headers, body }
    calls.push(call)
    const answer = await options.respond?.(call)
    if (answer) return answer
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: head.ball, codeBySha: head.codeBySha })
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { ...(options.nodeBuiltins ? createNodeBuiltins() : {}),
    '@deepseek-ai/dsh-tools': () => options.host?.dshTools ?? { defineTool: (value: unknown) => value } } })
  if (options.nodeBuiltins) {
    vi.spyOn(moduleLoader, 'requireActiveModuleLoader').mockReturnValue(loader)
    vi.spyOn(activeVfs, 'requireActiveVfs').mockReturnValue(vfs)
  }
  const runtime = await mountX6BallRuntime(context as unknown as Parameters<typeof mountX6BallRuntime>[0], vfs, loader)
  const tool = (name: string): Tool => {
    const found = options.host ? options.host.context.tools.get(name) as Tool | undefined : tools.registry.get(name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }
  const status = async (): Promise<Record<string, unknown>> => {
    const reply = await runtime.handleControlRequest('GET', '/__x6__/status', '')
    return reply?.body as Record<string, unknown>
  }
  return { runtime, vfs, calls, tool, status, head }
}

/** Write module bytes into her SHA-keyed ball store, as ball_put does. */
export function putBall(vfs: MemoryVfs, code: string): string {
  const sha = sha256(code)
  vfs.mkdirSync('/dsh/home/balls', { recursive: true })
  vfs.writeFileSync(`/dsh/home/balls/${sha}.js`, code)
  return sha
}
