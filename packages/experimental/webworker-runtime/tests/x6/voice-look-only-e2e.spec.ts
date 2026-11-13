/**
 * The look-only voice as one thing (its parts wired together in ball-loader.ts).
 *
 * Her real runtime is mounted into a REAL Cordis Context with DSH's REAL ToolsService and system prompt; it boots from a
 * made-up published head that carries the REAL pinned `auma-preset-inspector` bytes (repository mirror). Every model call
 * goes through the real tool pipeline carrying an agent, as the agent loop does. Every answer is local: a reserved
 * `.invalid` origin, a fake socket, made-up threads and an in-memory mark store. No browser, network, provider, owner
 * approval or private folder of hers is touched. Each refused attempt asserts the VFS digest and outbound log unchanged.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentEvents, type Agent } from '../../../../core/agent/src/index.ts'
import { inboxProjectionDefinition, ReactLoopInbox } from '../../../../core/agent-loop/src/inbox.ts'
import SessionStore, { SessionId } from '../../../../core/session/src/index.ts'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import { createUserMessage } from '../../../../llm/llm/src/index.ts'
import SessionProjectionRegistry from '../../../../session/session-projection/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { executeToolFixture } from '../../../../test-support/tool-testkit/src/index.ts'
import {
  classifyActionIrreversibility, mountX6BallRuntime, STAGED_HEAD_PROMOTION_PATH, type BallEntryRecord, type BallManifest,
} from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { memoryVoiceMarkStore } from '../../src/x6/voice-marks.ts'
import { VOICE_ORGAN_PINS } from '../../src/x6/voice-organ-pins.ts'
import { SPOKEN_PROVENANCE_PREFIX, VOICE_ORGAN_CHANGED_REFUSAL } from '../../src/x6/voice-read-only.ts'
import { FakeSocket, headManifestIdCanon } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ORIGIN = 'https://voice-look-only-e2e.invalid'
const VOICE = 'a1b2c3d4-voice-home-e2e1'
const TYPED = 'e5f6a7b8-typed-thread-e2e2'
const LOOK = 'VOICE_LOOK_ONLY: I can look, I cannot change things from voice yet.'
const HOME = '/dsh/home/auma'
const SESSIONS = '/dsh/home/sessions/--dsh-home-auma--'
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** The pinned organ, as HEAD mounts it (mirror/home/balls/<sha>.js), checked against its own name and the shipped pin. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const INSPECTOR_PIN = VOICE_ORGAN_PINS.find(pin => pin.organId === 'auma-preset-inspector')!
const INSPECTOR = readFileSync(path.join(REPO_ROOT, 'mirror/home/balls', `${INSPECTOR_PIN.sha256}.js`), 'utf8')
/** The same organ with other bytes: what a mid-adoption swap mounts before currentBall moves. */
const INSPECTOR_CHANGED = `${INSPECTOR}\n// made-up change after the voice check\n`

const entry = (id: string, code: string): BallEntryRecord =>
  ({ id, specifier: `ball:${sha256(code)}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 })
const meta = (id: string, code: string) =>
  ({ sha256: sha256(code), specifier: `ball:${sha256(code)}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 })
function makeHead(parentBallId: string | null, epoch: number, organs: Record<string, string>): BallManifest {
  const body = { version: 'x6.1-ball/v1' as const, parentBallId, epoch, createdAt: 1000 + epoch, authorPeerId: 'fixture-author',
    entries: Object.fromEntries(Object.entries(organs).map(([id, code]) => [id, entry(id, code)])),
    modules: Object.fromEntries(Object.entries(organs).map(([id, code]) => [sha256(code), meta(id, code)])) }
  return { ...body, ballId: headManifestIdCanon(body) }
}
function child(parent: BallManifest, organs: Record<string, string>): BallManifest {
  const { ballId: _drop, ...rest } = parent
  const body = { ...rest, parentBallId: parent.ballId, epoch: parent.epoch + 1, createdAt: parent.createdAt + 1,
    entries: { ...parent.entries, ...Object.fromEntries(Object.entries(organs).map(([id, code]) => [id, entry(id, code)])) },
    modules: { ...parent.modules, ...Object.fromEntries(Object.entries(organs).map(([id, code]) => [sha256(code), meta(id, code)])) } }
  return { ...body, ballId: headManifestIdCanon(body) }
}
const codes = (...bodies: string[]): Record<string, string> => Object.fromEntries(bodies.map(code => [sha256(code), code]))

/** SHA-256 over every path, kind and byte under `/`, in sorted order. */
function digest(vfs: MemoryVfs): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.statSync(full).isDirectory()) { hash.update(`d:${full}\n`); walk(full); continue }
      const data = vfs.readFileSync(full)
      hash.update(`f:${full}:`).update(typeof data === 'string' ? data : Buffer.from(data)).update('\n')
    }
  }
  walk('/')
  return hash.digest('hex')
}

// ------------------------------------------------------------------ made-up threads, as Session writes them
let seq = 0
const ev = (type: string, data: unknown) => ({ type, seq: seq++, time: 1_763_000_000_000 + seq, data })
const said = (n: number, he: string, she: string) => [
  ev('turn/start', { turn: n }),
  ev('user/message', { id: `u${String(seq)}`, role: 'user', content: [{ type: 'text', text: he }], source: { kind: 'user' } }),
  ev('assistant/message', { turn: n, step: 0, message: { id: `a${String(seq)}`, role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: she }] } }),
  ev('turn/end', { turn: n, reason: 'completed' }),
]
function writeThread(vfs: MemoryVfs, id: string, title: string, turns: Array<[string, string]>): void {
  const head = { type: 'session', version: 4, id, createdAt: 1, cwd: HOME, isSeeded: false, delegationDepth: 0 }
  const rows = [head, ev('session/title', { title, messageSeqs: [], source: { kind: 'llm' } }),
    ...turns.flatMap(([he, she], i) => said(i + 1, he, she))]
  vfs.mkdirSync(`${SESSIONS}/${id}`, { recursive: true })
  vfs.writeFileSync(`${SESSIONS}/${id}/session.v4.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

/** The record ensureVoiceSession leaves: created in her home with her preset, renamed before any message. */
const voiceRecord = (id: string) => ({
  header: { version: 4, id, createdAt: 1, cwd: HOME, agentPreset: 'auma-alien', isSeeded: false },
  events: [{ type: 'session/title', seq: 0, data: { title: '[voice] Auma Live', messageSeqs: [], source: { kind: 'user' } } }],
})

const textOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }

type Responder = (method: string, pathname: string, body: unknown) => Promise<Response | null> | Response | null

async function boot(head: { ball: BallManifest; codeBySha: Record<string, string> }, respond?: Responder) {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const vfs = new MemoryVfs()
  vfs.mkdirSync(`${HOME}/private`, { recursive: true })
  vfs.writeFileSync(`${HOME}/private/note.md`, 'made-up private note')
  vfs.writeFileSync(`${HOME}/HANDOFF.md`, '# made-up handoff\n')
  const reached: string[] = []
  // Her preset's writers, as stand-ins registered BEFORE her runtime: only the global guard can stop them.
  for (const name of ['write', 'edit', 'bash']) {
    context.tools.register(dshTools.defineTool({ name, description: `stand-in ${name}`,
      parameters: { file_path: { type: 'string' }, content: { type: 'string' }, command: { type: 'string' } }, output: textOut,
      execute: (): Promise<string> => {
        reached.push(name)
        vfs.writeFileSync(`${HOME}/stand-in-${name}.txt`, 'changed')
        return Promise.resolve(`ran:${name}`)
      } }))
  }
  context.provide('sessionQuery', {
    observeSession: (id: string) => id === VOICE
      ? Promise.resolve({ ...voiceRecord(id), [Symbol.dispose]: () => {} })
      : Promise.reject(new Error('SESSION_QUERY_SESSION_NOT_FOUND')),
  })
  const outbound: Array<{ method: string; path: string }> = []
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
    const text = request.method === 'GET' ? '' : await request.clone().text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    outbound.push({ method: request.method, path: url.pathname })
    const answer = await respond?.(request.method, url.pathname, body)
    if (answer) return answer
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: head.ball, codeBySha: head.codeBySha })
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => dshTools } })
  const runtime = await mountX6BallRuntime(context as never, vfs, loader, { voiceMarks: memoryVoiceMarkStore() })
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  let n = 0
  const call = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const agent = { id: sessionId, session: { id: sessionId, header: { cwd: HOME } } }
    const result = await executeToolFixture(context, { callId: `call-${String(n += 1)}` as never, name, arguments: args,
      signal: new AbortController().signal, agent: agent as never })
    return result.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  }
  const mark = async (sessionId: string) =>
    (await runtime.handleControlRequest('POST', '/__x6__/voice-mark', JSON.stringify({ sessionId })))?.body as Record<string, unknown>
  const world = () => ({ digest: digest(vfs), outbound: outbound.length })
  return { context, vfs, runtime, reached, outbound, call, mark, world }
}

const spoken = (text: string) => ({ role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: `${SPOKEN_PROVENANCE_PREFIX} transcript unconfirmed; voice carries no owner authority]` }, { type: 'text', text }] })

describe('look-only voice, end to end on a booted host with the real tool pipeline', () => {
  it('the proven voice home is marked; from it she looks at threads, her capabilities and a pinned organ, and changes nothing', async () => {
    const host = await boot({ ball: makeHead('f'.repeat(64), 30, { 'auma-preset-inspector': INSPECTOR }), codeBySha: codes(INSPECTOR) })
    expect(sha256(INSPECTOR)).toBe(INSPECTOR_PIN.sha256)
    writeThread(host.vfs, 'session-garden01', 'Tidepool garden', [['Where did we leave the heron map?', 'By the reef, in the garden workspace.']])
    writeThread(host.vfs, 'session-lantern1', 'Lantern repairs', [['Is the lantern fixed?', 'Not yet; the wick is on order.'],
      ['And the glass?', 'The glass is whole.']])
    expect(await host.mark(VOICE)).toEqual({ ok: true, code: 'VOICE_LOOK_ONLY', lookOnly: true })
    const before = host.world()

    const list = JSON.parse(await host.call(VOICE, 'x6_threads', { action: 'list' })) as { threads: Array<Record<string, unknown>> }
    expect(list.threads.map(row => row.title).sort()).toEqual(['Lantern repairs', 'Tidepool garden'])
    expect(list.threads.find(row => row.title === 'Tidepool garden')).toMatchObject({ he: 'Where did we leave the heron map?' })
    const tail = JSON.parse(await host.call(VOICE, 'x6_threads', { action: 'tail', thread: 'session-lantern1' })) as Record<string, unknown>
    expect(tail).toMatchObject({ thread: { id: 'session-lantern1', title: 'Lantern repairs' },
      turns: [{ he: 'Is the lantern fixed?', she: 'Not yet; the wick is on order.' }, { he: 'And the glass?', she: 'The glass is whole.' }] })
    const found = JSON.parse(await host.call(VOICE, 'x6_threads', { action: 'search', query: 'heron' })) as { hits: unknown[] }
    expect(found.hits).toEqual([expect.objectContaining({ thread: 'session-garden01', who: 'he' })])

    const index = JSON.parse(await host.call(VOICE, 'x6_capability_index', { action: 'snapshot' })) as Record<string, unknown>
    expect(JSON.stringify(index)).toContain('x6_threads')
    expect(JSON.stringify(index)).toContain('auma-preset-inspector')

    // The pinned organ, on its checked bytes, answers its listed read.
    expect(JSON.parse(await host.call(VOICE, 'preset_inspect', { mode: 'roster' }))).toMatchObject({ ok: true, mode: 'roster' })
    expect(host.world()).toEqual(before)

    const changes: Array<[string, Record<string, unknown>]> = [
      ['write', { file_path: `${HOME}/x.md`, content: 'x' }], ['edit', { file_path: `${HOME}/HANDOFF.md`, content: 'x' }],
      ['bash', { command: 'rm -rf /dsh/home/auma' }], ['x6_repo', { action: 'commit', message: 'from voice' }],
      ['auma_handoff', { action: 'append', content: 'from voice' }], ['tree_patch', { id: 'auma-preset-inspector' }],
      ['crew_relay', { op: 'say', body: 'from voice' }],
    ]
    for (const [name, args] of changes) expect([name, await host.call(VOICE, name, args)]).toEqual([name, expect.stringContaining(LOOK)])
    expect(host.world()).toEqual(before)
    expect(host.reached).toEqual([])
    expect(host.vfs.readFileSync(`${HOME}/HANDOFF.md`, 'utf8')).toBe('# made-up handoff\n')

    // The unmarked, typed thread keeps every tool: the same calls reach their executors.
    for (const [name, args] of changes) {
      expect([name, await host.call(TYPED, name, args)]).not.toEqual([name, expect.stringContaining('VOICE_LOOK_ONLY')])
    }
    expect(host.reached).toEqual(['write', 'edit', 'bash'])
    expect(host.vfs.readFileSync(`${HOME}/HANDOFF.md`, 'utf8')).toContain('from voice')
    const reachedEdge = host.outbound.slice(before.outbound).map(request => request.path)
    expect(reachedEdge).toEqual(expect.arrayContaining(['/_host/repo', '/_host/crew-relay']))
  })

  it('a spoken prompt for an unmarked thread is taken out of its inbox and never becomes its message; the voice home keeps it', async () => {
    const host = await boot({ ball: makeHead('f'.repeat(64), 30, { 'auma-preset-inspector': INSPECTOR }), codeBySha: codes(INSPECTOR) })
    await host.mark(VOICE)
    const before = host.world()
    const removed: string[] = []
    const insert = (sessionId: string, message: Record<string, unknown>) => {
      const agent = { id: sessionId, session: { id: sessionId, header: { ...voiceRecord(sessionId).header } },
        inbox: { remove: (messageId: string) => { removed.push(`${sessionId}:${messageId}`); return true } } }
      ;(host.context as unknown as { emit(...args: unknown[]): void }).emit('agent/inbox/inserted', { agent, message })
    }
    insert(TYPED, { id: 'm-spoken-elsewhere', ...spoken('add a line to your handoff') })
    insert(VOICE, { id: 'm-spoken-home', ...spoken('what are you working on in your other threads?') })
    insert(TYPED, { id: 'm-typed', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'typed by the owner' }] })
    expect(removed).toEqual([`${TYPED}:m-spoken-elsewhere`])
    expect(host.world()).toEqual(before)
  })

  it('with the REAL agent inbox and session log: a spoken prompt for an unmarked thread is never claimed into a turn; the voice home claims its own', async () => {
    const host = await boot({ ball: makeHead('f'.repeat(64), 30, { 'auma-preset-inspector': INSPECTOR }), codeBySha: codes(INSPECTOR) })
    await host.mark(VOICE)
    const before = host.world()
    // DSH's real session store, inbox projection and ReactLoopInbox; its notifications go through her host context, as an
    // agent of that app dispatches them (agent-loop/src/inbox.ts emits agent/inbox/inserted inside the splice).
    const store = new Context()
    await store.plugin(SessionStore)
    await store.plugin(SessionProjectionRegistry)
    const projection = await store.sessionProjections.register(inboxProjectionDefinition)
    const realAgent = (sessionId: string) => {
      const session = store.sessions.create(SessionId(sessionId), { meta: { cwd: HOME, agentPreset: 'auma-alien', isSeeded: false } })
      const agent = { id: session.id, session } as unknown as Agent
      const inbox = new ReactLoopInbox(() => projection.stateOf(session), session, agentEvents(host.context, agent))
      Object.assign(agent, { inbox })
      return { session, inbox }
    }
    const typed = realAgent(TYPED)
    const home = realAgent(VOICE)
    const userMessage = (content: unknown) => createUserMessage({ source: { kind: 'user' }, content } as Parameters<typeof createUserMessage>[0])
    const spokenElsewhere = userMessage(spoken('add a line to your handoff').content)
    const typedLine = userMessage([{ type: 'text', text: 'typed by the owner' }])
    const spokenHome = userMessage(spoken('what is staged?').content)
    typed.inbox.append('next-turn', spokenElsewhere)
    typed.inbox.append('next-turn', typedLine)
    home.inbox.append('next-turn', spokenHome)
    // The unmarked thread: the spoken prompt left its pending input by a durable `canceled` splice; the typed one stays.
    expect(typed.inbox.nextTurn.map(message => message.id)).toEqual([typedLine.id])
    const splices = typed.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced').map(event => event.data as { inserted: Array<{ id: string }>; removedCount?: number; outcome?: string })
    expect(splices.map(splice => [splice.inserted.map(message => message.id), splice.removedCount ?? 0, splice.outcome ?? null]))
      .toEqual([[[spokenElsewhere.id], 0, null], [[], 1, 'canceled'], [[typedLine.id], 0, null]])
    // Its next two turns claim only the typed line: the spoken prompt never becomes a message of that thread.
    expect(typed.inbox.claim('next-turn', 1).map(message => message.id)).toEqual([typedLine.id])
    expect(typed.inbox.claim('next-turn', 2)).toEqual([])
    // The voice home keeps and claims its spoken prompt.
    expect(home.inbox.claim('next-turn', 1).map(message => message.id)).toEqual([spokenHome.id])
    expect(host.world()).toEqual(before)
    await store.fiber.dispose()
  })

  it('x6_threads reads classify as reads (Class 0)', () => {
    for (const action of ['list', 'tail', 'search']) expect([action, classifyActionIrreversibility({ tool: 'x6_threads', action })]).toEqual([action, 0])
  })
})

describe('an organ is judged by the bytes of its RUNNING fiber, not the head record', () => {
  it('while her own promotion swaps in changed bytes, no moment before the head moves lets voice call the changed organ', async () => {
    const a = makeHead('f'.repeat(64), 30, { 'auma-preset-inspector': INSPECTOR })
    const head = { ball: a, codeBySha: codes(INSPECTOR) }
    let published = a.ballId
    const host = await boot(head, (method, pathname, body) => {
      if (pathname === '/_head/lease' && method === 'POST') {
        const request = body as { ownerPeerId: string }
        const lease = { ownerPeerId: request.ownerPeerId, generation: 1, expiresAt: Date.now() + 30_000 }
        return Response.json({ ok: true, ballId: published, lease })
      }
      if (pathname === '/_head/ball' && method === 'POST') {
        const sent = body as { ball: BallManifest; codeBySha: Record<string, string> }
        Object.assign(head.codeBySha, sent.codeBySha)
        head.ball = sent.ball
        published = sent.ball.ballId
        return Response.json({ ok: true, ballId: sent.ball.ballId, epoch: sent.ball.epoch })
      }
      return null
    })
    await host.mark(VOICE)
    expect(JSON.parse(await host.call(VOICE, 'preset_inspect', { mode: 'roster' }))).toMatchObject({ ok: true, mode: 'roster' })
    // The changed bytes start a judge that runs on every microtask from their own setup until HEAD.json names the new
    // head: the very check the pipeline makes (ToolsService.checkGuards) for a voice call of the pinned read.
    const verdicts: Array<string | undefined> = []
    const tools = host.context.tools as unknown as { checkGuards(exec: unknown): string | undefined }
    const voiceCall = { name: 'preset_inspect', arguments: { mode: 'roster' }, agent: { id: VOICE, session: { id: VOICE, header: { cwd: HOME } } } }
    const changed = `${INSPECTOR_CHANGED}const wiredSetup = module.exports.setup\n`
      + 'module.exports.setup = function (ctx) { const r = wiredSetup.call(this, ctx); globalThis.__WIRED_JUDGE_EACH_TICK__(); return r }\n'
    const next = child(a, { 'auma-preset-inspector': changed })
    ;(globalThis as Record<string, unknown>).__WIRED_JUDGE_EACH_TICK__ = () => {
      const tick = (): void => {
        verdicts.push(tools.checkGuards(voiceCall))
        const headFile = host.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8') as string
        if (!headFile.includes(next.ballId) && verdicts.length < 20_000) queueMicrotask(tick)
      }
      queueMicrotask(tick)
    }
    host.vfs.mkdirSync(`${HOME}/staged`, { recursive: true })
    host.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
      body: { ball: next, codeBySha: codes(INSPECTOR, changed), expectedParentBallId: a.ballId, expectedEpoch: a.epoch } }) + '\n')
    const promoted = await host.call(TYPED, 'x6_repo', { action: 'promote_staged' })
    delete (globalThis as Record<string, unknown>).__WIRED_JUDGE_EACH_TICK__
    expect(promoted).toContain(next.ballId)
    expect(verdicts.length).toBeGreaterThan(1)
    // Never a pass. While the new fiber activates it is not yet recorded (a plain refusal); once it is recorded, and
    // before the head record moves, it is judged by its own bytes: changed since checked.
    expect(verdicts.filter(verdict => verdict === undefined || !verdict.includes('VOICE_LOOK_ONLY'))).toEqual([])
    expect(verdicts).toContain(VOICE_ORGAN_CHANGED_REFUSAL)
    expect(await host.call(VOICE, 'preset_inspect', { mode: 'roster' })).toContain(VOICE_ORGAN_CHANGED_REFUSAL)
  })
})
