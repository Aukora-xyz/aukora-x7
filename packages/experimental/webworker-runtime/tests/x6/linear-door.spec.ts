/** Her `x6_linear` tool. Every host answer is a local fixture; no Linear, key or approval is real. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { executeToolFixture } from '../../../../test-support/tool-testkit/src/index.ts'
import { classifyActionIrreversibility, LINEAR_CORE_ACTIONS, LINEAR_READ_ACTIONS, LINEAR_UNSTAGED_NEXT, mountX6BallRuntime, STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { memoryVoiceMarkStore } from '../../src/x6/voice-marks.ts'
import { voiceRefusal, voiceVerdict, VOICE_SWITCH_TABLE } from '../../src/x6/voice-read-only.ts'
// @ts-expect-error The edge door is plain ESM without declarations; only its action table is read here.
import * as untypedDoor from '../../../../../deploy/cloudflare/src/linear-door.mjs'
// The owner's card reads what this tool stages (the same parser the Sovereignty card and the chat card use).
import { outwardWords, parseStagedOutward } from '../../../../client/ui-layout/src/client/spatial/aumlok/outward-class3.ts'
import { FakeSocket } from './e4-fixture.ts'

/** The exports this spec reads, as linear-door.mjs defines them. */
interface Door {
  LINEAR_ACTIONS: Record<string, { kind: string; fields: Record<string, unknown> }>
  LINEAR_READS: readonly string[]
  LINEAR_CORE: readonly string[]
}
const { LINEAR_ACTIONS, LINEAR_CORE, LINEAR_READS } = untypedDoor as Door
const ORIGIN = 'https://linear-door-fixture.invalid'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
type Args = Record<string, unknown>
interface Tool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Args): Promise<unknown> }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const HELD = { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', reason: 'delete', level: 'open', macFallback: false }
const UUID1 = '11111111-1111-4111-8111-111111111111'

async function mounted(respond: (body: Args) => Response | Promise<Response>) {
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
    // A protected Cloudflare write, held by the edge with why it needs the fingerprint (cloudflare-door.mjs): staged for his card.
    if (url.pathname === '/_host/cloudflare' && request.method === 'POST') {
      return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', macFallback: false, protection: { family: 'P1', reason: 'live-zone' } }, { status: 403 })
    }
    if (url.pathname !== '/_host/linear' || request.method !== 'POST') throw new Error('Unexpected request: ' + url.pathname)
    const body = await request.json() as Args
    sent.push(body)
    return await respond(body)
  })
  const context = { tools, get: (name: string) => services.get(name),
    provide: (name: string, value?: unknown) => { services.set(name, value) },
    plugin: async () => ({ dispose() {} }), effect: (register: () => () => void) => { cleanups.push(register()) } }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  await mountX6BallRuntime(context, vfs, loader)
  return { linear: definitions.get('x6_linear')!, cloudflare: definitions.get('x6_cloudflare')!, vfs, sent }
}

describe('x6_linear reaches her Linear door at the edge', () => {
  it('offers exactly the edge\'s closed action list, and no authority inputs', async () => {
    const { linear } = await mounted(() => Response.json({ ok: true }))
    expect((linear.parameters.action as { enum: string[] }).enum).toEqual(Object.keys(LINEAR_ACTIONS))
    expect([...LINEAR_READ_ACTIONS]).toEqual([...LINEAR_READS])
    // What this tool stages for his card is exactly the edge's core.
    expect([...LINEAR_CORE_ACTIONS]).toEqual([...LINEAR_CORE])
    for (const key of ['query', 'mutation', 'graphql', 'variables', 'approvalToken', 'headers', 'authorization', 'token', 'apiKey']) {
      expect(linear.parameters).not.toHaveProperty(key)
    }
    // Every field the edge accepts for any action is a parameter of the tool (and requestId for writes).
    const fields = new Set(Object.values(LINEAR_ACTIONS).flatMap(spec => Object.keys(spec.fields)))
    for (const field of [...fields, 'requestId']) expect(linear.parameters).toHaveProperty(field)
  })

  it('her words come first, under 120 words: hers to read and write, what asks, what is not offered, the key, crew_relay', async () => {
    const { linear } = await mounted(() => Response.json({ ok: true }))
    const marker = 'How to call it.'
    expect(linear.description.split(marker)).toHaveLength(2)
    const plain = linear.description.split(marker)[0]!.trim()
    expect(plain.split(/\s+/u).length).toBeLessThan(120)
    expect(plain.startsWith('Your Linear door.')).toBe(true)
    for (const words of ['Everything in the owner\'s Linear workspace is yours to read and write', 'Three things ask for his fingerprint',
      'archiving or deleting an issue, document, project or team', 'changing a project\'s or a team\'s settings or members', 'moving an issue to another team',
      'The door does not offer workspace settings, members, invitations, roles, API keys, OAuth apps, webhooks, integrations, billing or raw GraphQL',
      'The key stays at the edge and never comes to you.', 'crew_relay stays the crew\'s channel on YOURTEAM-398.',
      'When a request is held, tell the owner what you wanted and why, and stop.']) expect(plain).toContain(words)
    expect(linear.description).not.toMatch(/token/iu)
    // Her powers as they are, whatever level the edge runs at: the reference never claims a level, `status` names it.
    expect(linear.description).not.toMatch(/not in force|the owner reads the exact request on his card|One request waits at a time/u)
    expect(linear.description).toContain('`status` names the level in force')
    // A held core write is on his card now.
    expect(linear.description).not.toContain('his card cannot show a Linear request yet')
    expect(linear.description).toContain('`stagedForOwner: true`: nothing was sent; his card shows it; one tap.')
  })

  it('classifies every read as a read and every other action as a write the edge decides', () => {
    for (const action of Object.keys(LINEAR_ACTIONS)) {
      expect([action, classifyActionIrreversibility({ tool: 'x6_linear', action, id: 'YOURTEAM-398' })])
        .toEqual([action, LINEAR_READS.includes(action) ? 0 : 1])
    }
  })

  it('sends a read and an open write to the edge as-is and returns its answer; nothing is staged', async () => {
    const { linear, sent, vfs } = await mounted(body => Response.json({ ok: true, action: body.action, result: [] }))
    const read = { action: 'issues', team: 'YOURTEAM', first: 5 }
    expect(await linear.execute(read)).toEqual({ ok: true, action: 'issues', result: [] })
    const write = { action: 'comment', requestId: 'request-0001-abcdef', issue: 'YOURTEAM-398', body: 'Hello.' }
    expect(await linear.execute(write)).toEqual({ ok: true, action: 'comment', result: [] })
    expect(sent).toEqual([read, write])
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })

  it('a held core write is staged for his card, exactly as she sent it, and his card reads it', async () => {
    const { linear, sent, vfs } = await mounted(() => Response.json(HELD, { status: 403 }))
    const write = { action: 'issue_delete', requestId: 'request-0002-abcdef', id: UUID1 }
    const answer = await linear.execute(write) as Args
    expect(answer).toEqual({ ...HELD, stagedForOwner: true, stagedPath: STAGED_OUTWARD_PATH, sent: false,
      next: expect.any(String) as unknown })
    expect(sent).toEqual([write])
    // The staged file's exact shape: the one request, her bytes as the body, no reason object.
    const text = vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string
    const staged = JSON.parse(text) as Args
    expect(staged).toEqual({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: expect.any(Number) as unknown, tool: 'x6_linear', method: 'POST', pathname: '/_host/linear', body: write })
    expect(Object.keys(staged)).toEqual(['schema', 'stagedAt', 'tool', 'method', 'pathname', 'body'])
    expect(text).toBe(JSON.stringify(staged, null, 2) + '\n')
    const card = parseStagedOutward(text)
    expect(card).toMatchObject({ tool: 'x6_linear', pathname: '/_host/linear', approved: write })
    expect(outwardWords(card!).rows[0]).toEqual(['does', `Delete issue ${UUID1} from Linear. This cannot be undone.`])
    // A move to another team is the core too.
    vfs.unlinkSync(STAGED_OUTWARD_PATH)
    const move = { action: 'issue_update', requestId: 'request-0005-abcdef', id: 'YOURTEAM-398', teamId: 'team-made-up-2' }
    expect(await linear.execute(move)).toMatchObject({ stagedForOwner: true })
    expect(parseStagedOutward(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)?.body).toEqual(move)
  })

  it('a second held write while one waits is not staged: the waiting one is kept and named, as the Cloudflare door does', async () => {
    const { linear, vfs } = await mounted(() => Response.json(HELD, { status: 403 }))
    // A Cloudflare request waiting for the owner is kept exactly as it was.
    const waiting = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare',
      body: { action: 'api', method: 'DELETE', path: '/zones/z' }, protection: { family: 'P3', reason: 'zone-deletion' } }, null, 2) + '\n'
    vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    vfs.writeFileSync(STAGED_OUTWARD_PATH, waiting)
    expect(await linear.execute({ action: 'team_delete', requestId: 'request-0003-abcdef', id: UUID1 }))
      .toMatchObject({ code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: false, sent: false, waiting: 'a Cloudflare request' })
    expect(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')).toBe(waiting)
    // So is a Linear request waiting for him.
    vfs.unlinkSync(STAGED_OUTWARD_PATH)
    expect(await linear.execute({ action: 'issue_delete', requestId: 'request-0006-abcdef', id: UUID1 })).toMatchObject({ stagedForOwner: true })
    const first = vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')
    const second = await linear.execute({ action: 'project_delete', requestId: 'request-0007-abcdef', id: UUID1 }) as Args
    expect(second).toMatchObject({ stagedForOwner: false, sent: false, waiting: 'a Linear request (issue_delete)' })
    expect(second.next).toContain('with the same requestId')
    expect(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')).toBe(first)
  })

  it('an ordinary write held at level guarded is not staged (his card shows only the core): nothing sent, say it in words', async () => {
    const guarded = { ...HELD, reason: 'guarded-level', level: 'guarded' }
    const { linear, vfs } = await mounted(() => Response.json(guarded, { status: 403 }))
    for (const write of [{ action: 'comment', requestId: 'request-0008-abcdef', issue: 'YOURTEAM-398', body: 'x' },
      { action: 'issue_update', requestId: 'request-0009-abcdef', id: 'YOURTEAM-398', title: 'not a move' }]) {
      expect(await linear.execute(write)).toEqual({ ...guarded, stagedForOwner: false, sent: false, next: LINEAR_UNSTAGED_NEXT })
    }
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })

  it('a staged Linear write is a request his card reads, so a Cloudflare write after it is kept waiting, not jammed', async () => {
    const { linear, cloudflare, vfs } = await mounted(() => Response.json(HELD, { status: 403 }))
    expect(await linear.execute({ action: 'issue_archive', requestId: 'request-0010-abcdef', id: UUID1 })).toMatchObject({ stagedForOwner: true })
    const text = vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string
    expect(parseStagedOutward(text)).not.toBeNull()
    const write = { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } }
    expect(await cloudflare.execute(write)).toMatchObject({ stagedForOwner: false, sent: false, waiting: 'a Linear request (issue_archive)' })
    expect(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')).toBe(text)
  })

  it('a held Linear write never jams his Cloudflare card: a protected Cloudflare write after it is staged as usual', async () => {
    const { linear, cloudflare, vfs } = await mounted(() => Response.json(HELD, { status: 403 }))
    expect(await linear.execute({ action: 'issue_create', requestId: 'request-0004-abcdef', teamId: UUID1, title: 'x' })).toMatchObject({ stagedForOwner: false })
    const write = { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } }
    expect(await cloudflare.execute(write)).toMatchObject({ code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: true, stagedPath: STAGED_OUTWARD_PATH })
    expect(JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)).toMatchObject({ tool: 'x6_cloudflare', pathname: '/_host/cloudflare', body: write })
  })

  it('an answer over 256 KiB or not JSON is a code, never a crash', async () => {
    const big = await mounted(() => new Response('x'.repeat(256 * 1024 + 1)))
    expect(await big.linear.execute({ action: 'teams' })).toEqual({ ok: false, code: 'LINEAR_ANSWER_TOO_LARGE', status: 200 })
    vi.unstubAllGlobals()
    const html = await mounted(() => new Response('<html>'))
    expect(await html.linear.execute({ action: 'teams' })).toEqual({ ok: false, code: 'LINEAR_ANSWER_NOT_JSON', status: 200 })
  })

  it('refuses authority inputs before anything is sent', async () => {
    const { linear, sent } = await mounted(() => Response.json({ ok: true }))
    await expect(linear.execute({ action: 'teams', authorization: 'x' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
    await expect(linear.execute({ action: 'teams', token: 'x' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
    expect(sent).toEqual([])
  })
})

// ---- voice: reads are allowed in a look-only voice turn; writes are not -------------------------------------------------
const VOICE = 'a1b2c3d4-voice-home-0001'
const TYPED = 'e5f6a7b8-typed-thread-0003'
const HOME = '/dsh/home/auma'

function digest(vfs: MemoryVfs): string {
  const h = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) { h.update(`d:${path}\n`); walk(path); continue }
      const data = vfs.readFileSync(path)
      h.update(`f:${path}:`).update(typeof data === 'string' ? data : Buffer.from(data)).update('\n')
    }
  }
  walk('/')
  return h.digest('hex')
}
const voiceRecord = (id: string) => ({
  header: { version: 4, id, createdAt: 1, cwd: HOME, agentPreset: 'auma-alien', isSeeded: false },
  events: [{ type: 'session/title', seq: 0, data: { title: '[voice] Auma Live', messageSeqs: [], source: { kind: 'user' } } }],
})

async function bootVoice() {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const vfs = new MemoryVfs()
  vfs.mkdirSync(`${HOME}/private`, { recursive: true })
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
    // The edge holds every Linear write for the passkey here, so a write that reached it would also try to stage.
    if (url.pathname === '/_host/linear') {
      const body = JSON.parse(await request.text()) as Args
      return typeof body.action === 'string' && LINEAR_READS.includes(body.action)
        ? Response.json({ ok: true, action: body.action, result: [] }) : Response.json(HELD, { status: 403 })
    }
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

const READ_ARGS: Record<string, Args> = { status: {}, teams: {}, projects: {}, issue: { id: 'YOURTEAM-398' }, issues: { team: 'YOURTEAM' }, search: { text: 'voice' },
  comments: { issue: 'YOURTEAM-398' }, documents: {}, document: { id: UUID1 }, labels: {}, states: {}, users: {} }

describe('x6_linear from a look-only voice session', () => {
  it('the voice table lists exactly the reads, each proven at the edge; no write is on it', () => {
    expect(Object.keys(VOICE_SWITCH_TABLE.x6_linear?.values ?? {}).sort()).toEqual([...LINEAR_READS].sort())
    for (const row of Object.values(VOICE_SWITCH_TABLE.x6_linear!.values)) expect(row).toMatchObject({ where: 'edge', edgeProven: true })
    for (const action of Object.keys(LINEAR_ACTIONS).filter(name => !LINEAR_READS.includes(name))) {
      expect(voiceVerdict({ tool: 'x6_linear', args: { action }, origin: { kind: 'builtin' } })).toBe(voiceRefusal('x6_linear', action))
    }
    expect(voiceVerdict({ tool: 'x6_linear', args: {}, origin: { kind: 'builtin' } })).toBe(voiceRefusal('x6_linear', null))
    expect(voiceVerdict({ tool: 'x6_linear', args: { action: 'graphql' }, origin: { kind: 'builtin' } })).toBe(voiceRefusal('x6_linear', 'graphql'))
  })

  it('every read passes from voice and sends exactly its one request to the edge', async () => {
    const host = await bootVoice()
    expect(await host.mark(VOICE)).toMatchObject({ ok: true, lookOnly: true })
    for (const [action, args] of Object.entries(READ_ARGS)) {
      const from = host.outbound.length
      const body = { action, ...args }
      expect([action, await host.call(VOICE, 'x6_linear', body)]).not.toEqual([action, expect.stringContaining('VOICE_LOOK_ONLY')])
      expect(host.outbound.slice(from)).toEqual([{ method: 'POST', path: '/_host/linear', body: JSON.stringify(body) }])
    }
  })

  it('every write is refused from voice with the look-only sentence: nothing is sent, nothing is staged', async () => {
    const host = await bootVoice()
    await host.mark(VOICE)
    const before = host.world()
    for (const action of Object.keys(LINEAR_ACTIONS).filter(name => !LINEAR_READS.includes(name))) {
      const args = { action, requestId: 'request-voice-000001', id: UUID1, issue: 'YOURTEAM-398', body: 'from voice' }
      expect([action, await host.call(VOICE, 'x6_linear', args)]).toEqual([action, expect.stringContaining(voiceRefusal('x6_linear', action))])
    }
    expect(host.outbound.filter(request => request.path === '/_host/linear')).toEqual([])
    expect(host.world()).toEqual(before)
  })

  it('control: the same write from a typed thread reaches the edge and is held (look-only is per session)', async () => {
    const host = await bootVoice()
    await host.mark(VOICE)
    const answer = await host.call(TYPED, 'x6_linear', { action: 'issue_delete', requestId: 'request-typed-000001', id: UUID1 })
    expect(answer).not.toContain('VOICE_LOOK_ONLY')
    expect(answer).toContain('CLASS3_WEBAUTHN_REQUIRED')
    expect(answer).toContain('stagedForOwner')
    expect(host.outbound.filter(request => request.path === '/_host/linear')).toHaveLength(1)
    // A held core write from a typed thread is staged for his card (a voice turn never stages: see above).
    expect(JSON.parse(host.vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)).toMatchObject({ tool: 'x6_linear', pathname: '/_host/linear',
      body: { action: 'issue_delete', requestId: 'request-typed-000001', id: UUID1 } })
  })
})
