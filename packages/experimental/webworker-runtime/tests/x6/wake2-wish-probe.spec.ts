/** Her `x6_wish probe` is the read-only self-test, and `status` names her kept failures. Every host answer is a local fixture. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountX6BallRuntime, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const ORIGIN = 'https://wish-fixture.invalid'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
type Args = Record<string, unknown>
interface Tool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Args): Promise<unknown> }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mounted() {
  const source = 'module.exports = { apply() {} }', sha = hash(source)
  const seed: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 1, createdAt: 1000, authorPeerId: 'synthetic',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'fixture', description: 'Synthetic', size: source.length, createdAt: 1000 } } }
  const data: BallManifest = { ...seed, ballId: hash(JSON.stringify({
    version: seed.version, parentBallId: seed.parentBallId, epoch: seed.epoch,
    entries: Object.values(seed.entries), modules: Object.values(seed.modules) })) }
  const vfs = new MemoryVfs(), definitions = new Map<string, Tool>(), services = new Map<string, unknown>(), sent: Args[] = []
  const tools = { register(value: unknown) {
    const tool = value as Tool
    definitions.set(tool.name, tool)
    return () => { definitions.delete(tool.name) }
  } }
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: data, codeBySha: { [sha]: source } })
    if (url.pathname === '/_head/lease' && request.method === 'POST') {
      const body = await request.json() as Args
      return Response.json({ ok: true, ballId: data.ballId,
        lease: { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30000 } })
    }
    if (url.pathname !== '/_head/transcript' || request.method !== 'POST') throw new Error('Unexpected request: ' + url.pathname)
    const body = await request.json() as Args
    sent.push(body)
    return Response.json({ ok: true, wish: { everySeconds: body.everySeconds ?? 60 } })
  })
  const context = { tools, get: (name: string) => services.get(name),
    provide: (name: string, value?: unknown) => { services.set(name, value) },
    plugin: async () => ({ dispose() {} }), effect: (register: () => () => void) => { cleanups.push(register()) } }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  await mountX6BallRuntime(context, vfs, loader)
  return { wish: definitions.get('x6_wish')!, sent }
}

describe('x6_wish probe asks the edge for the self-test', () => {
  it('offers probe, sends wish_probe, and never writes WISH.md for it', async () => {
    const { wish, sent } = await mounted()
    expect((wish.parameters.action as { enum: string[] }).enum).toContain('probe')
    expect(wish.description).toContain('`probe`')
    expect(wish.description).toContain('spends no step and calls no model')
    expect(wish.description).toContain('`stepFailures`')
    await wish.execute({ action: 'probe' })
    expect(sent.at(-1)).toMatchObject({ action: 'wish_probe' })
    expect(sent.at(-1)).not.toHaveProperty('intent')
  })
})
