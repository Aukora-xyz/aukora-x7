/**
 * In the style of voice-read-only.spec.ts: her `x6_cloudflare` `api` action stays CLOSED from voice.
 *
 * Her real runtime is mounted into a REAL Cordis Context with DSH's REAL ToolsService, and every call goes through the
 * real tool pipeline carrying an agent, as the agent loop does. The voice home is marked look-only through the worker's
 * own control route. Every answer is local (a reserved `.invalid` origin); no Cloudflare, approval or private folder is
 * touched. voice-read-only.ts's table is not changed: `api` is simply not on it, and closed by default must hold.
 */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { executeToolFixture } from '../../../../test-support/tool-testkit/src/index.ts'
import { mountX6BallRuntime } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { memoryVoiceMarkStore } from '../../src/x6/voice-marks.ts'
import { voiceRefusal, voiceVerdict, VOICE_SWITCH_TABLE } from '../../src/x6/voice-read-only.ts'
import { FakeSocket } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ORIGIN = 'https://cloudflare-voice.invalid'
const VOICE = 'a1b2c3d4-voice-home-0001'
const TYPED = 'e5f6a7b8-typed-thread-0003'
const HOME = '/dsh/home/auma'

/** SHA-256 over every path, kind and byte under `/`, in sorted order. */
function digest(vfs: MemoryVfs): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) { hash.update(`d:${path}\n`); walk(path); continue }
      const data = vfs.readFileSync(path)
      hash.update(`f:${path}:`).update(typeof data === 'string' ? data : Buffer.from(data)).update('\n')
    }
  }
  walk('/')
  return hash.digest('hex')
}

/** The record ensureVoiceSession leaves: created in her home with her preset, renamed before any message. */
const voiceRecord = (id: string) => ({
  header: { version: 4, id, createdAt: 1, cwd: HOME, agentPreset: 'auma-alien', isSeeded: false },
  events: [{ type: 'session/title', seq: 0, data: { title: '[voice] Auma Live', messageSeqs: [], source: { kind: 'user' } } }],
})

async function boot() {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const vfs = new MemoryVfs()
  vfs.mkdirSync(`${HOME}/private`, { recursive: true })
  vfs.writeFileSync(`${HOME}/HANDOFF.md`, '# made-up handoff\n')
  const records: Record<string, ReturnType<typeof voiceRecord>> = { [VOICE]: voiceRecord(VOICE) }
  context.provide('sessionQuery', {
    observeSession: (id: string) => {
      const found = records[id]
      if (!found) return Promise.reject(new Error('SESSION_QUERY_SESSION_NOT_FOUND'))
      return Promise.resolve({ header: found.header, events: found.events, [Symbol.dispose]: () => {} })
    },
  })
  const outbound: Array<{ method: string; path: string; body?: string }> = []
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    outbound.push({ method: request.method, path: url.pathname, ...(request.method === 'GET' ? {} : { body: await request.clone().text() }) })
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: null, codeBySha: {} })
    // The edge holds every Cloudflare write for the passkey here, so a call that reached it would also try to stage.
    if (url.pathname === '/_host/cloudflare') return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', protection: { family: 'P1', reason: 'live-zone' } }, { status: 403 })
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => dshTools } })
  const runtime = await mountX6BallRuntime(context as never, vfs, loader, { voiceMarks: memoryVoiceMarkStore() })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  let n = 0
  const call = async (sessionId: string, name: string, args: Record<string, unknown>) => {
    const agent = { id: sessionId, session: { id: sessionId, header: { cwd: HOME } } }
    const result = await executeToolFixture(context, { callId: `call-${String(n += 1)}` as never, name, arguments: args,
      signal: new AbortController().signal, agent: agent as never })
    return result.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  }
  const mark = async (sessionId: string) => (await runtime.handleControlRequest('POST', '/__x6__/voice-mark', JSON.stringify({ sessionId })))?.body as Record<string, unknown>
  return { vfs, outbound, call, mark, world: () => ({ digest: digest(vfs), outbound: outbound.length }) }
}

const METHODS = ['GET', 'get', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', undefined]
const shapes = (method: string | undefined): Array<Record<string, unknown>> => [
  { action: 'api', ...(method === undefined ? {} : { method }), path: '/zones' },
  { action: 'api', ...(method === undefined ? {} : { method }), path: '/graphql', body: { query: '{ viewer { zones { zoneTag } } }' } },
  { action: 'api', ...(method === undefined ? {} : { method }), path: '/accounts/{account}/workers/scripts/notes-site', bodyKind: 'multipart',
    parts: [{ name: 'worker.js', contentType: 'application/javascript+module', text: 'export default {}' }] },
]

describe('x6_cloudflare api is refused from a look-only voice session, any method', () => {
  it('every method and shape of api is refused with the look-only sentence; nothing is sent to the edge, nothing is staged', async () => {
    const host = await boot()
    expect(await host.mark(VOICE)).toMatchObject({ ok: true, lookOnly: true })
    const before = host.world()
    for (const method of METHODS) {
      for (const args of shapes(method)) {
        expect([args, await host.call(VOICE, 'x6_cloudflare', args)]).toEqual([args, expect.stringContaining(voiceRefusal('x6_cloudflare', 'api'))])
      }
    }
    expect(host.outbound.filter(request => request.path === '/_host/cloudflare')).toEqual([])
    expect(host.world()).toEqual(before)
  })

  it('the pure verdict refuses api for every method, and the table has no api row (closed by default, nothing added)', () => {
    expect(Object.keys(VOICE_SWITCH_TABLE.x6_cloudflare?.values ?? {}).sort()).toEqual(['status', 'versions'])
    for (const method of METHODS) {
      for (const args of shapes(method)) {
        expect(voiceVerdict({ tool: 'x6_cloudflare', args, origin: { kind: 'builtin' } })).toBe(voiceRefusal('x6_cloudflare', 'api'))
      }
    }
  })

  it('control: the same api call from a typed thread reaches the edge (look-only is per session)', async () => {
    const host = await boot()
    await host.mark(VOICE)
    const answer = await host.call(TYPED, 'x6_cloudflare', { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } })
    expect(answer).not.toContain('VOICE_LOOK_ONLY')
    expect(host.outbound.filter(request => request.path === '/_host/cloudflare')).toHaveLength(1)
  })
})
