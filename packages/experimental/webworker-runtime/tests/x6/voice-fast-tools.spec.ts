/**
 * Her FAST voice's tool calls, the worker half (`POST /__x6__/voice-tool`, ball-loader.ts runVoiceTool).
 *
 * The edge's fast model names one of her tools; the edge sends it to her tab and her tab posts it here. Her real runtime
 * is mounted into a REAL Cordis Context with DSH's REAL ToolsService (as voice-read-only.spec.ts does), and each call
 * goes through the route as her page sends it. The rule under test: the fast voice may run EXACTLY what her look-only
 * level lets a spoken governed turn run (voice-read-only.ts voiceVerdict), at every voice level, and a refusal is that
 * turn's own words. Every answer is local: a reserved `.invalid` origin, made-up files, an in-memory mark store.
 */
import { createHash } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScope } from '../../../../core/scope/src/index.ts'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import {
  classifyActionIrreversibility, mountX6BallRuntime, STAGED_OUTWARD_PATH, VOICE_TOOL_OUTPUT_BYTES, VOICE_TOOL_PAGE_BYTES, voiceToolPage,
  type BallEntryRecord, type BallManifest,
} from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { memoryVoiceMarkStore } from '../../src/x6/voice-marks.ts'
import { VOICE_RECALL_PIN } from '../../src/x6/voice-organ-pins.ts'
import {
  MEMORY_TIMELINE_HOME_REFUSAL, VOICE_FAST_NOT_READS, VOICE_MEMORY_HOME, VOICE_MEMORY_HOME_REFUSAL,
  VOICE_OPEN_FAST_READS, VOICE_OPEN_STILL_REFUSED,
  VOICE_PRIVATE_REFUSAL, VOICE_RELATIVE_PATH_REFUSAL,
  VOICE_SWITCH_TABLE, VOICE_THREAD_LOGS_REFUSAL,
  VOICE_FAST_HIVE_MAX_TICKS, voiceOpenFastVerdict, voiceRefusal, voiceSearchEntryWithheld, voiceVerdict, withholdVoiceSearchEntries,
} from '../../src/x6/voice-read-only.ts'
import { SELF_CHECK_KYBER_CALL } from '../../src/x6/self-check.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { WITHHELD } from '../../src/x6/secret-shapes.ts'
import {
  runVoiceScratch, VOICE_SCRATCH_FAST_HEADER_PREFIX, VOICE_SCRATCH_LIMITS, VOICE_SCRATCH_NOTICE, VOICE_SCRATCH_ROOT, type VoiceScratchVfs,
} from '../../src/x6/voice-scratch.ts'
import { classifyWritePath } from '../../src/x6/write-set-inventory.ts'
import {
  commitment, recordDigest, VOICE_MEMORY_CHAIN, VOICE_MEMORY_SCOPE, VOICE_MEMORY_WORDS, VOICE_MEMORY_ZERO,
} from '../../src/storage/voice-memory.ts'
import {
  createTimelineStore, MEMORY_ACTIONS, MEMORY_TOOL, memoryToolSpec, parseMemoryTime, runMemoryTool,
} from '../../src/storage/memory-timeline.ts'
import { withholdSecrets } from '../../src/x6/secret-shapes.ts'
// @ts-expect-error The edge's fast voice is plain ESM without declarations; only its three texts are read here.
import * as untypedFast from '../../../../../deploy/cloudflare/src/voice-fast.mjs'
import { FakeSocket, headManifestIdCanon } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ORIGIN = 'https://voice-fast-tools.invalid'
const HOME = '/dsh/home/auma'
/** The edge test's copy of the refusal (deploy/cloudflare/src/__tests__/voice-bridge-fast-tools.test.mjs). */
const EDGE_WRITE_REFUSAL = 'VOICE_LOOK_ONLY: I can look, I cannot change things from voice yet. (write is not on my voice list.)'

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

const textOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }
/** Stand-ins for her preset's tools: each records that it was reached; the writers change the VFS when they run. */
function presetStandIn(name: string, vfs: MemoryVfs, reached: string[]) {
  return dshTools.defineTool({
    name, description: `stand-in ${name}`,
    parameters: { file_path: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' }, include: { type: 'string' },
      content: { type: 'string' }, command: { type: 'string' } },
    output: textOut,
    execute: (args: Record<string, unknown>): Promise<string> => {
      reached.push(name)
      if (['write', 'edit', 'bash'].includes(name)) vfs.writeFileSync(`${HOME}/stand-in-${name}.txt`, 'changed')
      if (name === 'read' && args.file_path === `${HOME}/big.txt`) return Promise.resolve(BIG_TEXT)
      if (name === 'read' && args.file_path === STAGED_OUTWARD_PATH) return Promise.resolve(String(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')))
      if (name === 'read' && typeof args.file_path === 'string' && args.file_path.startsWith(`${HOME}/plain/`)) {
        return Promise.resolve(String(vfs.readFileSync(args.file_path, 'utf8')))
      }
      // Her real grep and glob answer structured values (tool-fs-search grep.ts { matches }, glob.ts { root, paths })
      // with paths relative to the working folder (her home here); these walk the VFS under `path` the same way.
      if ((name === 'grep' || name === 'glob') && typeof args.path === 'string' && args.path.startsWith(`${HOME}/plain`)) {
        const files = walkFiles(vfs, args.path)
        const rel = (file: string): string => file.slice(HOME.length + 1)
        if (name === 'glob') return Promise.resolve({ root: rel(args.path), paths: files.map(rel) } as unknown as string)
        const pattern = new RegExp(String(args.pattern))
        const matches = files.flatMap(file => String(vfs.readFileSync(file, 'utf8')).split('\n')
          .flatMap((line, index) => pattern.test(line) ? [{ path: rel(file), lineNumber: index + 1, line }] : []))
        return Promise.resolve({ matches } as unknown as string)
      }
      return Promise.resolve(`ran:${name}:${JSON.stringify(args.file_path ?? args.path ?? '')}`)
    },
  })
}

/**
 * A long answer for the paging and cut tests: `y ` repeated (every answer is screened for secret shapes, and an
 * unbroken run of 40 or more letters is one, so the filler has spaces).
 */
const BIG_TEXT = 'y '.repeat((VOICE_TOOL_OUTPUT_BYTES + 10) / 2)

/** Every file under `dir`, sorted. */
function walkFiles(vfs: MemoryVfs, dir: string): string[] {
  return [...vfs.readdirSync(dir)].map(String).sort().flatMap((name) => {
    const path = `${dir}/${name}`
    return vfs.statSync(path).isDirectory() ? walkFiles(vfs, path) : [path]
  })
}

/** The names her preset (auma-alien) mounts in its own scope here, as her live profile does (never globally). */
const PRESET_TOOLS = ['write', 'edit', 'bash', 'read', 'glob', 'grep', 'web_search', 'session_event_read', 'job_output']

/**
 * the voice safety change fix 1: made-up preset tools whose NAMES end in a read verb, or whose closed `action` enum mixes a read and a
 * write. Each records the action it was reached with; any action but `list` changes the VFS.
 */
function fakeStandIn(name: string, action: { type: 'string'; enum?: readonly string[] }, vfs: MemoryVfs, reached: string[]) {
  return dshTools.defineTool({
    name, description: `made-up ${name}`, parameters: { action, content: { type: 'string' } }, output: textOut,
    execute: (args: Record<string, unknown>): Promise<string> => {
      reached.push(`${name}.${String(args.action)}`)
      if (args.action !== 'list') vfs.writeFileSync(`${HOME}/fake-${name}.txt`, 'changed')
      return Promise.resolve(`ran:${name}`)
    },
  })
}
const FAKE_TOOLS: Array<[string, { type: 'string'; enum?: readonly string[] }]> = [
  ['fake_log', { type: 'string' }], ['fake_status', { type: 'string' }], ['fake_store', { type: 'string', enum: ['list', 'put'] }],
  // Review: a preset tool under her own tools' prefix that her tool registry never mounted.
  ['x6t_fake', { type: 'string', enum: ['list', 'write'] }],
]

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
/** A made-up published head carrying the given organs (as voice-look-only-e2e.spec.ts builds one). */
function headWith(organs: Record<string, string>): { ball: BallManifest; codeBySha: Record<string, string> } {
  const entry = (id: string, code: string): BallEntryRecord =>
    ({ id, specifier: `ball:${sha256(code)}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 })
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: 30, createdAt: 1030, authorPeerId: 'fixture-author',
    entries: Object.fromEntries(Object.entries(organs).map(([id, code]) => [id, entry(id, code)])),
    modules: Object.fromEntries(Object.entries(organs).map(([id, code]) => [sha256(code),
      { sha256: sha256(code), specifier: `ball:${sha256(code)}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 }])) }
  const codeBySha = Object.fromEntries(Object.values(organs).map(code => [sha256(code), code]))
  return { ball: { ...body, ballId: headManifestIdCanon(body) }, codeBySha }
}

async function boot(level: 'look-only' | 'open', head: { ball: BallManifest | null; codeBySha: Record<string, string> } = { ball: null, codeBySha: {} },
  fakes = false) {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const vfs = new MemoryVfs()
  vfs.mkdirSync(`${HOME}/private`, { recursive: true })
  vfs.mkdirSync(`${HOME}/notes`, { recursive: true })
  vfs.mkdirSync(`${HOME}/staged`, { recursive: true })
  vfs.writeFileSync(`${HOME}/private/note.md`, 'made-up private note')
  vfs.writeFileSync(`${HOME}/HANDOFF.md`, '# made-up handoff\nNOW: voice reads everything\n')
  vfs.writeFileSync(`${HOME}/notes/garden.md`, 'made-up memory note')
  const reached: string[] = []
  // Her preset's tools live in the preset's own scope (mirror/home/profiles/web/cordis.patch.yml mounts them under
  // auma-alien; the web surface disables the host-plane copies), reached only through the preset registry's lease.
  const presetKey = {}
  const presetScope = createScope(context, presetKey)
  await presetScope.ctx.plugin({ name: 'preset-stand-ins', inject: ['tools'],
    apply: (ctx: Context) => {
      for (const name of PRESET_TOOLS) ctx.tools.register(presetStandIn(name, vfs, reached))
      if (fakes) for (const [name, action] of FAKE_TOOLS) ctx.tools.register(fakeStandIn(name, action, vfs, reached))
    } })
  const leases: string[] = []
  context.provide('agentPresets', { acquireScope: (id?: string) => {
    leases.push(`acquire:${String(id)}`)
    return Promise.resolve({ key: presetKey, [Symbol.asyncDispose]: () => { leases.push('release'); return Promise.resolve() } })
  } })
  context.provide('sessionQuery', { observeSession: () => Promise.reject(new Error('SESSION_QUERY_SESSION_NOT_FOUND')) })
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
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: head.ball, codeBySha: head.codeBySha })
    if (url.pathname === '/_host/linear') return Response.json({ ok: true, made: 'up linear answer' })
    if (url.pathname === '/_host/repo') return Response.json({ ok: true, made: 'up repo answer' })
    if (url.pathname === '/_host/voice') return Response.json({ ok: true, live: 0, failures: [], calls: [], turns: [] })
    if (url.pathname === '/api/build') return Response.json({ ok: true, build: 'made-up' })
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  // An organ's `fs` is her VFS and its `crypto` the platform's, as her worker image binds them.
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => dshTools, fs: () => vfs, crypto: () => nodeCrypto } })
  const runtime = await mountX6BallRuntime(context as never, vfs, loader, { voiceMarks: memoryVoiceMarkStore(), level })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  /** One fast-voice tool call, exactly as her page posts it. */
  const tool = async (name: string, args: unknown = {}, from?: number) => {
    const answer = await runtime.handleControlRequest('POST', '/__x6__/voice-tool', JSON.stringify({ name, args, ...(from === undefined ? {} : { from }) }))
    return answer as { status: number; body: { ok: boolean; ran: boolean; refused?: string; output?: string; error?: string } }
  }
  const raw = async (method: string, body: string) => runtime.handleControlRequest(method, '/__x6__/voice-tool', body)
  /** The page-only route that keeps her voice memory's chain. */
  const memoryRoute = async (method: string, body: string) =>
    await runtime.handleControlRequest(method, '/__x6__/voice-memory', body) as { status: number; body: Record<string, unknown> }
  const world = () => ({ digest: digest(vfs), outbound: outbound.length })
  return { context, vfs, reached, leases, outbound, tool, raw, memoryRoute, world }
}

/** Every read family the brief names (V1), each through her own registered tool. */
const READS: Array<[string, string, Record<string, unknown>]> = [
  ['Linear issue', 'x6_linear', { action: 'issue', id: 'YOURTEAM-1' }],
  ['Linear issues', 'x6_linear', { action: 'issues', team: 'YOURTEAM' }],
  ['Linear search', 'x6_linear', { action: 'search', text: 'voice' }],
  ['Linear comments', 'x6_linear', { action: 'comments', issue: 'YOURTEAM-12' }],
  ['Linear documents', 'x6_linear', { action: 'documents' }],
  ['the crew relay read (its Linear issue, YOURTEAM-1)', 'x6_linear', { action: 'comments', issue: 'YOURTEAM-1' }],
  ['repository read', 'x6_repo', { action: 'read', path: 'README.md' }],
  ['repository search', 'x6_repo', { action: 'search', query: 'voice' }],
  ['repository tree', 'x6_repo', { action: 'tree' }],
  ['home file read (HANDOFF)', 'read', { file_path: `${HOME}/HANDOFF.md` }],
  ['home notes list', 'glob', { path: `${HOME}/notes`, pattern: '*.md' }],
  ['home notes search', 'grep', { path: `${HOME}/notes`, pattern: 'memory' }],
  ['hand-off note', 'auma_handoff', { action: 'read' }],
  ['conversations list', 'x6_threads', { action: 'list' }],
  ['conversation search', 'x6_threads', { action: 'search', query: 'garden' }],
  ['snapshots list (memory)', 'auma_snapshot', { action: 'list' }],
  ['self state', 'x6_self_state', {}],
  ['self check', 'x6_self_check', {}],
  ['proposal and merge cards waiting', 'x6_repo', { action: 'promotion_status' }],
  ['a staged card file', 'read', { file_path: `${HOME}/staged/head-promotion.json` }],
  ['voice status', 'x6_voice_status', {}],
  ['capability index', 'x6_capability_index', { action: 'snapshot' }],
]

/** Calls that change things, or reach what voice never opens: each refused with the look-only turn's own words. */
const REFUSED: Array<[string, Record<string, unknown>, string]> = [
  ['write', { file_path: `${HOME}/x.md`, content: 'changed' }, voiceRefusal('write')],
  ['edit', { file_path: `${HOME}/HANDOFF.md` }, voiceRefusal('edit')],
  ['bash', { command: 'rm -rf /' }, voiceRefusal('bash')],
  ['x6_linear', { action: 'issue_create', teamId: 't', title: 'x' }, voiceRefusal('x6_linear', 'issue_create')],
  ['x6_linear', { action: 'comment', issue: 'YOURTEAM-1', body: 'x' }, voiceRefusal('x6_linear', 'comment')],
  ['x6_repo', { action: 'merge_proposal' }, voiceRefusal('x6_repo', 'merge_proposal')],
  ['x6_repo', { action: 'stage_proposal' }, voiceRefusal('x6_repo', 'stage_proposal')],
  ['stage_head_promotion', {}, voiceRefusal('stage_head_promotion')],
  ['crew_relay', { op: 'say', body: 'x' }, voiceRefusal('crew_relay')],
  ['x6_cloudflare', { action: 'deploy' }, voiceRefusal('x6_cloudflare', 'deploy')],
  ['read', { file_path: `${HOME}/private/note.md` }, VOICE_PRIVATE_REFUSAL],
  ['read', { file_path: `${HOME}/notes/../private/note.md` }, VOICE_PRIVATE_REFUSAL],
  ['grep', { path: HOME, pattern: 'x' }, VOICE_PRIVATE_REFUSAL],
  ['read', { file_path: '/dsh/home/sessions/abc.jsonl' }, VOICE_THREAD_LOGS_REFUSAL],
  ['read', { file_path: `${HOME}/memory-store.v2.json` }, VOICE_THREAD_LOGS_REFUSAL],
  ['read', { file_path: `${HOME}/memory-store.json` }, VOICE_THREAD_LOGS_REFUSAL],
  ['no_such_tool', {}, voiceRefusal('no_such_tool')],
]

/** Reads a spoken governed turn of hers has at voice level open, that the look-only table does not list. */
const OPEN_READS: Array<[string, string, Record<string, unknown>]> = [
  ['web search (x6_web_eyes)', 'x6_web_eyes', { action: 'search', query: 'cordis' }],
  ['repository diff', 'x6_repo', { action: 'diff' }],
  ['repository compare_files', 'x6_repo', { action: 'compare_files', paths: ['a', 'b'] }],
  ['repository selftest', 'x6_repo', { action: 'selftest' }],
  ['the crew relay read', 'crew_relay', { op: 'read' }],
  ['her facts', 'x6_facts', {}],
  ['ball status from her host', 'ball_status', {}],
  ['her own tools', 'x6_tools', { action: 'list' }],
  // the voice safety change V1-1: each unproven edge row she reads from the fast voice, now by its explicit VOICE_OPEN_FAST_READS row.
  ['repository bytes', 'x6_repo', { action: 'bytes', path: 'README.md' }],
  ['repository diagnostics', 'x6_repo', { action: 'diagnostics' }],
  ['repository state_diff', 'x6_repo', { action: 'state_diff' }],
  ['head adopt (no force)', 'head_adopt', {}],
  ['self facts', 'self_facts', {}],
]

/** Still refused from the fast voice at voice level open. */
const OPEN_STILL_REFUSED: Array<[string, Record<string, unknown>, string]> = [
  ['write', { file_path: `${HOME}/x.md`, content: 'changed' }, voiceRefusal('write')],
  ['bash', { command: 'ls' }, voiceRefusal('bash')],
  ['session_event_read', { session: 'x' }, voiceRefusal('session_event_read')],
  ['job_output', {}, voiceRefusal('job_output')],
  ['x6_wish', { action: 'status' }, voiceRefusal('x6_wish', 'status')],
  ['x6_skill', { action: 'check' }, voiceRefusal('x6_skill', 'check')],
  ['x6_skill', { action: 'keep' }, voiceRefusal('x6_skill', 'keep')],
  ['x6_repo', { action: 'transcript' }, voiceRefusal('x6_repo', 'transcript')],
  ['x6_repo', { action: 'merge_proposal' }, voiceRefusal('x6_repo', 'merge_proposal')],
  ['x6_repo', {}, voiceRefusal('x6_repo')],
  ['x6_tools', { action: 'mount', name: 'x' }, voiceRefusal('x6_tools', 'mount')],
  // the voice safety change V1-1: exec logs stay off from voice (lead's ruling, 2026-11-13: a log is a 302 to a second host).
  ['x6_exec', { action: 'logs', run: 1 }, voiceRefusal('x6_exec', 'logs')],
  ['x6_linear', { action: 'issue_archive', id: 'YOURTEAM-1' }, voiceRefusal('x6_linear', 'issue_archive')],
  ['x6_github', { action: 'api', method: 'POST', endpoint: 'repos/x/y/dispatches' }, voiceRefusal('x6_github', 'api')],
  ['x6_cell', { action: 'cord', step: 'start' }, voiceRefusal('x6_cell', 'cord')],
  ['auma_snapshot', { action: 'diff', snapshotId: '../private/note.md' }, voiceRefusal('auma_snapshot', 'diff')],
  ['crew_relay', { op: 'say', body: 'x' }, voiceRefusal('crew_relay')],
  ['crew_relay', { op: 'read', body: 'x' }, voiceRefusal('crew_relay')],
  // Review fix: her preset's web_search has no fast row (each query is a paid provider call); x6_web_eyes search is her web.
  ['web_search', { queries: ['cordis'] }, voiceRefusal('web_search')],
  ['x6_web_eyes', { action: 'search', query: `${HOME}/private/note.md` }, VOICE_PRIVATE_REFUSAL],
  ['x6_web_eyes', { action: 'search', query: '/dsh/home/sessions/abc.jsonl' }, VOICE_THREAD_LOGS_REFUSAL],
  ['x6_web_eyes', { action: 'search', query: '~/x' }, voiceRefusal('x6_web_eyes', 'search')],
  ['x6_web_eyes', { action: 'search', query: 'memory-store.v2.json' }, VOICE_THREAD_LOGS_REFUSAL],
  // Review fix: a word the tool does not declare cannot make the runtime classifier answer read.
  ['head_adopt', { action: 'status' }, voiceRefusal('head_adopt')],
  ['head_adopt', { force: true }, voiceRefusal('head_adopt')],
  ['grep', { path: HOME, pattern: 'x' }, VOICE_PRIVATE_REFUSAL],
  ['web_fetch', { url: 'https://example.invalid' }, voiceRefusal('web_fetch')],
]

/** Her memory organ, as HEAD mounts it (repository mirror), and a made-up thread in her sessions folder. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const MEMORY_ORGAN = readFileSync(path.join(REPO_ROOT, 'mirror/home/balls', `${VOICE_RECALL_PIN.sha256}.js`), 'utf8')
function writeThread(vfs: MemoryVfs, id: string, turns: Array<[string, string]>): void {
  let seq = 0
  const ev = (type: string, data: unknown) => ({ type, seq: seq++, time: 1_763_000_000_000 + seq, data,
    ...(type.endsWith('/message') ? { surfaceOp: 'append' } : {}) })
  const rows = [{ type: 'session', version: 4, id, createdAt: 1, cwd: HOME, isSeeded: false, delegationDepth: 0 },
    ev('session/title', { title: 'Heron map', messageSeqs: [], source: { kind: 'llm' } }),
    ...turns.flatMap(([he, she], index) => [ev('turn/start', { turn: index + 1 }),
      ev('user/message', { id: `u${String(index)}`, role: 'user', content: [{ type: 'text', text: he }], source: { kind: 'user' } }),
      ev('assistant/message', { turn: index + 1, step: 0, message: { id: `a${String(index)}`, role: 'assistant', source: { kind: 'model' },
        content: [{ type: 'text', text: she }] } }),
      ev('turn/end', { turn: index + 1, reason: 'completed' })])]
  const dir = `/dsh/home/sessions/--dsh-home-auma--/${id}`
  vfs.mkdirSync(dir, { recursive: true })
  vfs.writeFileSync(`${dir}/session.v4.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

describe('the fast voice reads everything her look-only level allows, through her own tools', () => {
  for (const level of ['look-only', 'open'] as const) {
    it(`at voice level ${level}: each read family in V1 runs by her own registered tool`, async () => {
      const host = await boot(level)
      for (const [family, name, args] of READS) {
        const answer = await host.tool(name, args)
        expect([family, answer.status, answer.body.ran, answer.body.refused]).toEqual([family, 200, true, undefined])
      }
      // Her own tools did the reading: the preset stand-ins were reached, and the edge doors were asked by her tools.
      expect(host.reached).toEqual(['read', 'glob', 'grep', 'read'])
      const paths = new Set(host.outbound.map(item => item.path))
      for (const path of ['/_host/linear', '/_host/repo', '/api/build', '/_host/voice']) expect([path, paths.has(path)]).toEqual([path, true])
      const linear = host.outbound.filter(item => item.path === '/_host/linear').map(item => JSON.parse(item.body ?? '{}') as Record<string, unknown>)
      // (x6_self_check's own probe asks the Linear door's `status` last.)
      expect(linear.map(body => body.action)).toEqual(['issue', 'issues', 'search', 'comments', 'documents', 'comments', 'status'])
    })

    it(`at voice level ${level}: her home-file tools are found in her preset's scope, under a lease released after each call`, async () => {
      const host = await boot(level)
      expect((await host.tool('read', { file_path: `${HOME}/HANDOFF.md` })).body).toMatchObject({ ran: true, output: `ran:read:"${HOME}/HANDOFF.md"` })
      expect((await host.tool('grep', { path: `${HOME}/notes`, pattern: 'x' })).body.ran).toBe(true)
      expect(host.leases).toEqual(['acquire:auma-alien', 'release', 'acquire:auma-alien', 'release'])
    })

    it(`at voice level ${level}: a changing tool is refused with the look-only words, runs nothing and changes nothing`, async () => {
      const host = await boot(level)
      const before = host.world()
      for (const [name, args, refusal] of REFUSED) {
        const answer = await host.tool(name, args)
        expect([name, args, answer.body]).toEqual([name, args, { ok: true, ran: false, refused: refusal }])
      }
      expect(host.reached).toEqual([])
      expect(host.world()).toEqual(before)
    })
  }

  it('at voice level open (where her spoken governed turn has every tool), reads her capability index knows as reads run too', async () => {
    for (const level of ['open', 'look-only'] as const) {
      const host = await boot(level)
      for (const [family, name, args] of OPEN_READS) {
        const answer = await host.tool(name, args)
        const expected = level === 'open' ? [family, true, undefined] : [family, false, answer.body.refused]
        expect([family, answer.body.ran, answer.body.refused]).toEqual(expected)
        if (level === 'look-only') expect(answer.body.refused?.startsWith('VOICE_LOOK_ONLY: I can look')).toBe(true)
      }
      expect(host.reached).toEqual([])
    }
  })

  it('at voice level open the fast voice still changes nothing: writes, cursors, reaps, cells, raw thread logs and private paths stay refused', async () => {
    const host = await boot('open')
    const before = host.world()
    for (const [name, args, refusal] of OPEN_STILL_REFUSED) {
      const answer = await host.tool(name, args)
      expect([name, args, answer.body]).toEqual([name, args, { ok: true, ran: false, refused: refusal }])
    }
    expect(host.reached).toEqual([])
    expect(host.world()).toEqual(before)
  })

  it('recall from the pinned memory organ runs, its answer through the secret-shape filter; other bytes are refused', async () => {
    const secret = `sk-${'q'.repeat(30)}`
    for (const [organ, pinned] of [[MEMORY_ORGAN, true], [`${MEMORY_ORGAN}\n// made-up change after the voice check\n`, false]] as const) {
      const host = await boot('look-only', headWith({ 'auma-memory-domain': organ }))
      writeThread(host.vfs, 'session-heron001', [['Where is the heron map?', `By the reef. The old key was ${secret}.`]])
      const before = host.world()
      const answer = await host.tool('recall', { query: 'heron map reef' })
      // Other bytes: not the pinned organ, so `recall` is what the look-only table says of it (no row), and it does not run.
      if (!pinned) { expect(answer.body).toEqual({ ok: true, ran: false, refused: voiceRefusal('recall') }); continue }
      expect([answer.body.ran, answer.body.refused]).toEqual([true, undefined])
      expect(answer.body.output).toContain('heron map')
      expect(answer.body.output).toContain(WITHHELD)
      expect(answer.body.output).not.toContain(secret)
      expect(host.world().digest).toBe(before.digest)
    }
    expect(sha256(MEMORY_ORGAN)).toBe(VOICE_RECALL_PIN.sha256)
  })

  it('a look answer is paged: one page with one note, the next from where it ended, the end said', async () => {
    const host = await boot('open')
    const total = VOICE_TOOL_OUTPUT_BYTES + 10
    const first = await host.tool('read', { file_path: `${HOME}/big.txt` }, 0)
    expect(BIG_TEXT.length).toBe(total)
    expect(first.body.output).toBe(`${BIG_TEXT.slice(0, VOICE_TOOL_PAGE_BYTES)}\n[bytes 0 to ${String(VOICE_TOOL_PAGE_BYTES)} of ${String(total)}; call again with from:${String(VOICE_TOOL_PAGE_BYTES)} for more]`)
    const last = await host.tool('read', { file_path: `${HOME}/big.txt` }, total - 5)
    expect(last.body.output).toBe(`${BIG_TEXT.slice(total - 5)}\n[bytes ${String(total - 5)} to ${String(total)} of ${String(total)}; that is the end]`)
    // A short answer is whole, with no note; a page never splits a character; a bad `from` is refused.
    expect(voiceToolPage('short', 0)).toBe('short')
    const wide = 'é'.repeat(VOICE_TOOL_PAGE_BYTES)
    expect(voiceToolPage(wide, 1).startsWith(`${'é'.repeat(VOICE_TOOL_PAGE_BYTES / 2)}\n[bytes 2 to ${String(VOICE_TOOL_PAGE_BYTES + 2)} of`)).toBe(true)
    // Every page note fits the 6 KiB result the edge gives the model.
    expect(new TextEncoder().encode(first.body.output ?? '').byteLength).toBeLessThanOrEqual(6144)
    expect(await host.raw('POST', JSON.stringify({ name: 'read', args: {}, from: -1 }))).toEqual({ status: 400, body: { ok: false, ran: false, code: 'VOICE_TOOL_INVALID' } })
  })

  it('the staged outward card file is reachable by her read (her awareness reads it for cards waiting)', async () => {
    const host = await boot('look-only')
    host.vfs.writeFileSync(STAGED_OUTWARD_PATH, JSON.stringify({ schema: 'aukora.staged-outward-class3.v1', tool: 'x6_linear', body: { action: 'issue_archive' } }))
    const answer = await host.tool('read', { file_path: STAGED_OUTWARD_PATH })
    const staged = JSON.parse(answer.body.output ?? '{}') as { body?: unknown }
    expect([answer.body.ran, staged.body]).toEqual([true, { action: 'issue_archive' }])
  })

  it('the refusal the edge test hands the model is the look-only words, exactly', () => {
    expect(voiceRefusal('write')).toBe(EDGE_WRITE_REFUSAL)
  })

  it('a dashed name is her underscored tool; a body that is not a call is refused; long output is cut with a note', async () => {
    const host = await boot('open')
    expect((await host.tool('x6-threads', { action: 'list' })).body.ran).toBe(true)
    for (const [method, body] of [['POST', ''], ['POST', 'not json'], ['POST', '[]'], ['POST', JSON.stringify({ args: {} })],
      ['POST', JSON.stringify({ name: 7 })], ['GET', ''], ['POST', JSON.stringify({ name: 'read', args: { file_path: 'x'.repeat(20_000) } })]] as const) {
      expect([method, body.slice(0, 40), await host.raw(method, body)]).toEqual([method, body.slice(0, 40), { status: 400, body: { ok: false, ran: false, code: 'VOICE_TOOL_INVALID' } }])
    }
    // Arguments that are not an object: the look-only rule refuses them.
    expect((await host.tool('x6_threads', ['list'])).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('x6_threads') })
    const big = await host.tool('read', { file_path: `${HOME}/big.txt` })
    expect(big.body.ran).toBe(true)
    expect(big.body.output?.endsWith(`\n[cut at ${String(VOICE_TOOL_OUTPUT_BYTES)} bytes of ${String(VOICE_TOOL_OUTPUT_BYTES + 10)}]`)).toBe(true)
  })
})

/** A real-shaped thread line (JSON: escaped quotes and a \n), and a candidate over 4096 characters. */
const CANDIDATE_LINE = `${JSON.stringify({ type: 'user/message', data: { text: 'she said "hello"\n' } })}\n`
const LONG_CANDIDATE = Array.from({ length: 90 }, (_, index) => `line ${String(index)} of a plain candidate, sixty characters`).join('\n')

/** the voice safety change fix 1: every read family her fast voice has (the READY note), each still run at voice level open. */
const FAMILIES: Array<[string, string, Record<string, unknown>]> = [
  ...['status', 'teams', 'projects', 'issues', 'search', 'comments', 'documents', 'labels', 'states', 'users']
    .map((action): [string, string, Record<string, unknown>] => [`Linear ${action}`, 'x6_linear', { action, text: 'voice', issue: 'YOURTEAM-1' }]),
  ['Linear issue', 'x6_linear', { action: 'issue', id: 'YOURTEAM-1' }],
  ['Linear document', 'x6_linear', { action: 'document', id: 'doc-1' }],
  ...['read', 'search', 'tree', 'status', 'log', 'diff', 'promotion_status']
    .map((action): [string, string, Record<string, unknown>] => [`repository ${action}`, 'x6_repo', { action, path: 'README.md', query: 'voice' }]),
  ['home read', 'read', { file_path: `${HOME}/HANDOFF.md` }],
  ['home glob', 'glob', { path: `${HOME}/notes`, pattern: '*.md' }],
  ['home grep', 'grep', { path: `${HOME}/notes`, pattern: 'memory' }],
  ['threads list', 'x6_threads', { action: 'list' }],
  ['threads tail', 'x6_threads', { action: 'tail', session: 'session-x' }],
  ['threads search', 'x6_threads', { action: 'search', query: 'garden' }],
  ['self state', 'x6_self_state', {}],
  ['self check', 'x6_self_check', {}],
  ['host facts', 'x6_host_facts', {}],
  ['capability index', 'x6_capability_index', { action: 'lookup', name: 'x6_repo' }],
  ['browser estate', 'x6_browser_estate', {}],
  ['voice status', 'x6_voice_status', {}],
  ['crew relay read', 'crew_relay', { op: 'read' }],
  ...['list', 'status', 'artifacts']
    .map((action): [string, string, Record<string, unknown>] => [`exec ${action}`, 'x6_exec', { action, run: 1 }]),
  ['web search', 'x6_web_eyes', { action: 'search', query: 'cordis' }],
  ['checkpoint verify', 'x6_checkpoint_verify', { action: 'verify', id: 'session-x', body: CANDIDATE_LINE, lineEnd: CANDIDATE_LINE.length }],
  ['checkpoint verify (a long candidate)', 'x6_checkpoint_verify', { action: 'verify', id: 'session-x', body: LONG_CANDIDATE, lineEnd: LONG_CANDIDATE.length }],
  ['checkpoint capture', 'x6_checkpoint_verify', { action: 'capture', id: 'session-x', body: CANDIDATE_LINE }],
  // Review: head_adopt only reads the published head (one GET of /_head/ball); it ran from the fast voice on an earlier commit.
  ['head adopt', 'head_adopt', {}],
]

describe('fix 1: a fast-voice call runs only when the runtime classes that exact call as a read', () => {
  it('a tool NAMED like a read is not a read: fake_log write and fake_status delete are refused, run nothing, change nothing', async () => {
    const host = await boot('open', undefined, true)
    const before = host.world()
    for (const [name, args] of [['fake_log', { action: 'write', content: 'x' }], ['fake_log', {}], ['fake_status', { action: 'delete' }],
      ['fake_status', {}]] as const) {
      const answer = await host.tool(name, args)
      const action = (args as { action?: string }).action
      expect([name, args, answer.body]).toEqual([name, args, { ok: true, ran: false, refused: voiceRefusal(name, action ?? null) }])
    }
    expect(host.reached).toEqual([])
    expect(host.world()).toEqual(before)
  })

  it('a closed action enum: its read action runs, its write action is refused', async () => {
    const host = await boot('open', undefined, true)
    const before = host.world()
    expect((await host.tool('fake_store', { action: 'put', content: 'x' })).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('fake_store', 'put') })
    expect(host.world()).toEqual(before)
    expect((await host.tool('fake_store', { action: 'list' })).body).toMatchObject({ ok: true, ran: true, output: 'ran:fake_store' })
    expect(host.reached).toEqual(['fake_store.list'])
    expect(host.world().digest).toBe(before.digest)
  })

  it('every read family of her fast voice still runs at voice level open, x6_checkpoint_verify verify and capture included', async () => {
    const host = await boot('open')
    const before = host.world().digest
    for (const [family, name, args] of FAMILIES) {
      const answer = await host.tool(name, args)
      expect([family, answer.status, answer.body.ran, answer.body.refused]).toEqual([family, 200, true, undefined])
      // The tool itself took the arguments (no argument error), so the family is really reached.
      expect([family, answer.body.output ?? '']).not.toEqual([family, expect.stringContaining('CHECKPOINT_INPUT_INVALID')])
    }
    expect(host.reached).toEqual(['read', 'glob', 'grep'])
    expect(host.world().digest).toBe(before)
    // x6_checkpoint_verify reads only its two actions (absent is its default, verify); anything else is refused.
    expect((await host.tool('x6_checkpoint_verify', {})).body.refused).toBe(undefined)
    expect((await host.tool('x6_checkpoint_verify', { action: 'promote' })).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('x6_checkpoint_verify', 'promote') })
    // recall of her pinned memory organ runs at open too.
    const organ = await boot('open', headWith({ 'auma-memory-domain': MEMORY_ORGAN }))
    expect((await organ.tool('recall', { query: 'heron' })).body.refused).toBe(undefined)
  })

  it('the runtime classifier has the last word: a call it does not class 0 is refused even when the index calls it a read', () => {
    const base = { tool: 'fake_store', args: { action: 'list' }, origin: { kind: 'preset' as const }, githubClass: null,
      mutation: { readOnly: false, actions: { read: ['list'], write: ['put'] } }, parameterNames: ['action', 'content'] }
    const refusal = voiceRefusal('fake_store', 'list')
    const seen: unknown[] = []
    expect(voiceOpenFastVerdict({ ...base, runtimeClass: (call) => { seen.push(call); return 0 } }, refusal)).toBe(undefined)
    expect(voiceOpenFastVerdict({ ...base, parameterNames: ['content'], runtimeClass: () => 0 }, refusal)).toBe(refusal)
    expect(seen).toEqual([{ action: 'list', tool: 'fake_store' }])
    for (const level of [1, 2, 3, 4]) expect(voiceOpenFastVerdict({ ...base, runtimeClass: () => level }, refusal)).toBe(refusal)
    // A read that rests on the name rule alone is refused before the classifier is asked.
    const named = { ...base, tool: 'fake_log', args: { action: 'write' }, mutation: { readOnly: true, basis: 'name' as const } }
    expect(voiceOpenFastVerdict({ ...named, runtimeClass: () => 0 }, voiceRefusal('fake_log', 'write'))).toBe(voiceRefusal('fake_log', 'write'))
    // A declared read-only tool with no action selector still needs the classifier's class 0.
    const declared = { ...base, tool: 'fake_view', args: {}, mutation: { readOnly: true, basis: 'declared' as const } }
    expect(voiceOpenFastVerdict({ ...declared, runtimeClass: () => 1 }, voiceRefusal('fake_view'))).toBe(voiceRefusal('fake_view'))
    expect(voiceOpenFastVerdict({ ...declared, runtimeClass: () => 0 }, voiceRefusal('fake_view'))).toBe(undefined)
  })
})

describe('V1-1: an edge row that is not proven runs from the fast voice only by an explicit fast-voice row', () => {
  /** Every edge value of the look-only table that is switched off (edgeProven false), as [tool, selector value]. */
  const unproven = Object.entries(VOICE_SWITCH_TABLE).flatMap(([tool, row]) => Object.entries(row.values)
    .filter(([, value]) => value.where === 'edge' && !value.edgeProven).map(([value]): [string, string, string] => [tool, row.selector, value]))
  const fastLists = (tool: string, value: string): boolean => {
    const row = Object.hasOwn(VOICE_OPEN_FAST_READS, tool) ? VOICE_OPEN_FAST_READS[tool] : undefined
    return row !== undefined && row.values.includes(row.selector === 'whole' ? '*' : value)
  }
  /** The call that selects that value (ball_status's boolean selector is absent: its own `absent` is "false"). */
  const call = (selector: string, value: string): Record<string, unknown> =>
    selector === 'whole' || selector === 'includeManifest' ? {} : { [selector]: value }

  it('each unproven edge value runs only when VOICE_OPEN_FAST_READS lists it, even when the index and the classifier say read', () => {
    expect(unproven.length).toBeGreaterThan(0)
    for (const [tool, selector, value] of unproven) {
      const args = call(selector, value)
      // The most permissive facts a call could have: the index calls every action a read and the classifier answers 0.
      const answer = voiceOpenFastVerdict({ tool, args, origin: { kind: 'builtin' }, githubClass: 0,
        mutation: { readOnly: true, basis: 'listed', actions: { read: [value], write: [] } }, parameterNames: Object.keys(args),
        runtimeClass: () => 0 }, voiceVerdict({ tool, args, origin: { kind: 'builtin' } }))
      expect([tool, value, answer === undefined]).toEqual([tool, value, fastLists(tool, value)])
    }
  })

  it('x6_exec logs is refused from the fast voice (a 302 to a second host); its other reads still run', async () => {
    const answer = voiceOpenFastVerdict({ tool: 'x6_exec', args: { action: 'logs', run: 1 }, origin: { kind: 'builtin' }, githubClass: null,
      mutation: { readOnly: false, actions: { read: ['status', 'logs', 'list', 'artifacts'], write: ['run', 'cancel'] } },
      parameterNames: ['action', 'run'], runtimeClass: () => 0 }, voiceRefusal('x6_exec', 'logs'))
    expect(answer).toBe(voiceRefusal('x6_exec', 'logs'))
    expect(VOICE_OPEN_STILL_REFUSED.x6_exec).toEqual(['logs'])
    const host = await boot('open')
    const before = host.world()
    expect((await host.tool('x6_exec', { action: 'logs', run: 1 })).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('x6_exec', 'logs') })
    expect(host.world()).toEqual(before)
    for (const action of ['list', 'status', 'artifacts']) {
      expect([action, (await host.tool('x6_exec', { action, run: 1 })).body.refused]).toEqual([action, undefined])
    }
  })

  it('the brief\'s reads keep running: x6_repo diff, compare_files, selftest, diagnostics, bytes, state_diff; head_adopt; x6_web_eyes search', async () => {
    const host = await boot('open')
    const calls: Array<[string, Record<string, unknown>]> = [
      ...['diff', 'compare_files', 'selftest', 'diagnostics', 'bytes', 'state_diff'].map((action): [string, Record<string, unknown>] => ['x6_repo', { action }]),
      ['head_adopt', {}], ['x6_web_eyes', { action: 'search', query: 'cordis' }],
      ['x6_facts', {}], ['self_facts', {}], ['ball_status', {}], ['ball_status', { includeManifest: false }],
    ]
    for (const [tool, args] of calls) {
      const answer = await host.tool(tool, args)
      expect([tool, args, answer.body.ran, answer.body.refused]).toEqual([tool, args, true, undefined])
    }
    // the voice safety change V2-2: her web search carries only its action, query and limit out (the bridge bounds the query and the turn).
    expect((await host.tool('x6_web_eyes', { action: 'search', query: 'cordis', note: 'internal text' })).body.refused).toBe(voiceRefusal('x6_web_eyes', 'search'))
    expect((await host.tool('x6_web_eyes', { action: 'search', query: 'cordis', limit: 5 })).body.refused).toBe(undefined)
    // head_adopt with force is still refused; an x6_repo action not on its fast row is too.
    expect((await host.tool('head_adopt', { force: true })).body.refused).toBe(voiceRefusal('head_adopt'))
    expect((await host.tool('x6_repo', { action: 'transcript' })).body.refused).toBe(voiceRefusal('x6_repo', 'transcript'))
  })
})

describe('V2-1: secrets never reach the voice model', () => {
  const KEY = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQ'.repeat(12)}\n-----END PRIVATE KEY-----`
  const plain = (host: Awaited<ReturnType<typeof boot>>) => {
    host.vfs.mkdirSync(`${HOME}/plain`, { recursive: true })
    host.vfs.writeFileSync(`${HOME}/plain/garden.md`, 'reef heron map\nnothing else\n')
    host.vfs.writeFileSync(`${HOME}/plain/signing.pem`, `reef ${KEY}\n`)
    host.vfs.writeFileSync(`${HOME}/plain/api-secret.json`, '{"reef": "x"}\n')
    host.vfs.writeFileSync(`${HOME}/plain/old-password.txt`, 'reef\n')
  }

  it('grep over a folder returns the ordinary note\'s match and not the key file\'s, and says how many it withheld', async () => {
    for (const level of ['look-only', 'open'] as const) {
      const host = await boot(level)
      plain(host)
      const answer = await host.tool('grep', { path: `${HOME}/plain`, pattern: 'reef' })
      expect([level, answer.body.ran, answer.body.refused]).toEqual([level, true, undefined])
      const output = answer.body.output ?? ''
      expect(output).toContain('plain/garden.md')
      expect(output).toContain('reef heron map')
      for (const hidden of ['signing.pem', 'api-secret.json', 'old-password.txt', 'BEGIN PRIVATE KEY', 'MIIEvQ']) {
        expect([level, hidden, output.includes(hidden)]).toEqual([level, hidden, false])
      }
      expect(output).toContain('[3 results withheld from voice: private or key-like files]')
      // glob lists the ordinary file and withholds the key-like names the same way.
      const listed = (await host.tool('glob', { path: `${HOME}/plain`, pattern: '*' })).body.output ?? ''
      expect(listed).toContain('plain/garden.md')
      for (const hidden of ['signing.pem', 'api-secret.json', 'old-password.txt']) expect([hidden, listed.includes(hidden)]).toEqual([hidden, false])
      expect(listed).toContain('[3 results withheld from voice: private or key-like files]')
    }
  })

  it('a result holding a key-shaped string is withheld with the existing marker, whatever the tool; an ordinary result is unchanged', async () => {
    const host = await boot('open')
    host.vfs.mkdirSync(`${HOME}/plain`, { recursive: true })
    const secret = `sk-${'q'.repeat(30)}`
    host.vfs.writeFileSync(`${HOME}/plain/notes.md`, `the old provider key was ${secret} and nsec1${'a'.repeat(58)}\n${KEY}\n`)
    const answer = await host.tool('read', { file_path: `${HOME}/plain/notes.md` })
    expect([answer.body.ran, answer.body.refused]).toEqual([true, undefined])
    for (const leaked of [secret, 'nsec1aaaa', 'MIIEvQ']) expect([leaked, answer.body.output?.includes(leaked)]).toEqual([leaked, false])
    expect(answer.body.output).toContain(WITHHELD)
    // Paged, it is screened whole before the page is cut.
    const paged = await host.tool('read', { file_path: `${HOME}/plain/notes.md` }, 0)
    expect(paged.body.output?.includes(secret)).toBe(false)
    // An ordinary result is unchanged, byte for byte.
    const ordinary = 'reef heron map\nThe owner said: the voice reads everything.\n'
    host.vfs.writeFileSync(`${HOME}/plain/ordinary.md`, ordinary)
    expect((await host.tool('read', { file_path: `${HOME}/plain/ordinary.md` })).body.output).toBe(ordinary)
  })
})

describe('screening every answer keeps ordinary ids; key files named .env or id_rsa stay out', () => {
  const SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d'
  const DIGEST = 'a3f1c2d4e5b6a7980a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'
  it('an x6_repo log, a checkpoint capture and an x6_self_state answer keep their commit ids and digests through the voice route', async () => {
    const host = await boot('open')
    host.vfs.mkdirSync(`${HOME}/plain`, { recursive: true })
    const answers = {
      'log.json': { headSha: SHA, commits: [{ sha: SHA, subject: 'voice: fixes' }] },
      'capture.json': { threadId: 'thread-5e0000012-0000-4000-8000-0000000000012', row: { id: DIGEST }, chain: DIGEST, tailSha: DIGEST },
      'state.json': { runtime: { sourceRevision: SHA }, organs: [{ id: 'voice', sha256: DIGEST }] },
    }
    for (const [file, value] of Object.entries(answers)) {
      const text = JSON.stringify(value)
      host.vfs.writeFileSync(`${HOME}/plain/${file}`, text)
      const answer = await host.tool('read', { file_path: `${HOME}/plain/${file}` })
      expect([file, answer.body.ran, answer.body.output]).toEqual([file, true, text])
    }
    // A key-like value in the same kind of answer is still withheld.
    host.vfs.writeFileSync(`${HOME}/plain/conf.json`, JSON.stringify({ sha: SHA, secret: DIGEST }))
    expect((await host.tool('read', { file_path: `${HOME}/plain/conf.json` })).body.output).toBe(JSON.stringify({ sha: SHA, secret: WITHHELD }))
  })

  it('grep over a folder withholds the matches of .env, .npmrc and id_rsa files, and the value of a KEY= line anywhere', async () => {
    const host = await boot('open')
    host.vfs.mkdirSync(`${HOME}/plain`, { recursive: true })
    host.vfs.writeFileSync(`${HOME}/plain/.env`, 'CF_API_KEY=0123456789abcdef0123456789abcdef012\n')
    host.vfs.writeFileSync(`${HOME}/plain/.npmrc`, 'KEY=//registry:_auth=abc\n')
    host.vfs.writeFileSync(`${HOME}/plain/id_rsa`, 'KEY=material\n')
    host.vfs.writeFileSync(`${HOME}/plain/setup.md`, 'KEY= notes: set CF_API_KEY=0123456789abcdef0123456789abcdef012 in the dashboard\n')
    const output = (await host.tool('grep', { path: `${HOME}/plain`, pattern: 'KEY=' })).body.output ?? ''
    expect(output).toContain('plain/setup.md')
    for (const hidden of ['.env', '.npmrc', 'id_rsa', '0123456789abcdef']) expect([hidden, output.includes(hidden)]).toEqual([hidden, false])
    expect(output).toContain('[3 results withheld from voice: private or key-like files]')
    expect(output).toContain(`CF_API_KEY=${WITHHELD}`)
  })
})

describe('V2-1: each entry grep and glob return is judged as read judges a file', () => {
  it('private, thread-log, memory-store and key-like entries are withheld in every shape; ordinary entries and other tools pass as they came', () => {
    const root = `${HOME}/notes`
    for (const entry of ['private/x.md', `${HOME}/private/x.md`, '../sessions/a/b.jsonl', '/dsh/home/sessions/x', 'memory-store.v2.json',
      'keys/id.key', 'a/session.cap', 'bundle.p12', 'my_private-key.txt', 'credentials.json', 'a\u0000b']) {
      expect([entry, voiceSearchEntryWithheld(entry, root)]).toEqual([entry, true])
    }
    for (const entry of ['garden.md', 'notes/garden.md', `${HOME}/HANDOFF.md`, 'privately-held.md']) {
      expect([entry, voiceSearchEntryWithheld(entry, root)]).toEqual([entry, false])
    }
    const text = 'Found 3 matches\n\nnotes/garden.md\nLine 1: reef\n\nnotes/id.pem\nLine 2: reef key\nLine 3: more'
    expect(withholdVoiceSearchEntries('grep', { path: root }, text)).toEqual({ out: 'Found 3 matches\n\nnotes/garden.md\nLine 1: reef', withheld: 2 })
    expect(withholdVoiceSearchEntries('glob', { path: root }, 'notes/garden.md\nnotes/id.pem\n')).toEqual({ out: 'notes/garden.md\n', withheld: 1 })
    expect(withholdVoiceSearchEntries('glob', { path: root }, { root: 'notes', paths: ['notes/a.md', 'private/b.md'] }))
      .toEqual({ out: { root: 'notes', paths: ['notes/a.md'] }, withheld: 1 })
    const other = { matches: [{ path: 'private/x.md', lineNumber: 1, line: 'x' }] }
    expect(withholdVoiceSearchEntries('read', {}, other)).toEqual({ out: other, withheld: 0 })
  })
})

describe('fix 2: paths in a fast-voice call cannot dodge the private-folder rule', () => {
  // The vehicle is x6_repo `diff` (a fast row that takes any argument); x6_web_eyes search now carries only
  // action, query and limit from voice, so extra arguments are refused before this scan is reached.
  const look = voiceRefusal('x6_repo', 'diff')
  const nested = (depth: number, leaf: unknown): unknown => depth === 0 ? leaf : { next: nested(depth - 1, leaf) }
  it('relative paths are resolved against her home and `..` folded; nesting past 4 or more than 256 strings is refused', async () => {
    const host = await boot('open')
    const before = host.world()
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['private/note.md', { action: 'diff', query: 'private/note.md' }, VOICE_PRIVATE_REFUSAL],
      ['../sessions/x/y', { action: 'diff', query: '../sessions/x/y' }, VOICE_THREAD_LOGS_REFUSAL],
      ['./private/x', { action: 'diff', query: './private/x' }, VOICE_PRIVATE_REFUSAL],
      ['notes/../private', { action: 'diff', query: 'cordis', paths: ['notes/../private'] }, VOICE_PRIVATE_REFUSAL],
      ['a NUL in a relative string', { action: 'diff', query: 'a\u0000b' }, VOICE_RELATIVE_PATH_REFUSAL],
      // args, then 4 objects: the leaf string sits 5 deep (the scan reaches 4).
      ['a private path nested 5 deep', { action: 'diff', query: 'cordis', filter: nested(4, `${HOME}/private/note.md`) }, look],
      ['a harmless string nested 5 deep', { action: 'diff', query: 'cordis', filter: nested(4, 'reef') }, look],
      ['300 strings', { action: 'diff', query: 'cordis', terms: Array.from({ length: 298 }, (_, index) => `t${String(index)}`) }, look],
    ]
    for (const [label, args, refusal] of cases) {
      const answer = await host.tool('x6_repo', args)
      expect([label, answer.body]).toEqual([label, { ok: true, ran: false, refused: refusal }])
    }
    expect(host.world()).toEqual(before)
    // A normal call, and one at the bounds (4 deep, 256 strings), still run.
    for (const args of [{ action: 'diff', query: 'cordis' }, { action: 'diff', query: 'cordis', filter: nested(3, 'reef') },
      { action: 'diff', query: 'cordis', terms: Array.from({ length: 254 }, (_, index) => `t${String(index)}`) }]) {
      expect((await host.tool('x6_repo', args)).body.refused).toBe(undefined)
    }
  })
})

describe('the read rule rests on facts, never on a name or a word the model adds', () => {
  const preset = { kind: 'preset' as const }
  const verdict = (tool: string, args: Record<string, unknown>, extra: Partial<Parameters<typeof voiceOpenFastVerdict>[0]> = {}) =>
    voiceOpenFastVerdict({ tool, args, origin: preset, githubClass: null, mutation: null, parameterNames: Object.keys(args),
      runtimeClass: () => 0, ...extra }, voiceRefusal(tool, typeof args.action === 'string' ? args.action : null))

  it('an x6t_ name runs only when her tool registry mounted that exact tool read-only', async () => {
    const host = await boot('open', undefined, true)
    const before = host.world()
    for (const action of ['write', 'list']) {
      expect((await host.tool('x6t_fake', { action, content: 'x' })).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('x6t_fake', action) })
    }
    expect(host.reached).toEqual([])
    expect(host.world()).toEqual(before)
    // The classifier classes every x6t- name 0, so only the registry's fact can tell them apart.
    expect(classifyActionIrreversibility({ tool: 'x6t_fake', act: 'write' })).toBe(0)
    const call = { act: 'count', input: { text: 'hello world' } }
    expect(verdict('x6t_wordcount', call)).toBe(voiceRefusal('x6t_wordcount'))
    expect(verdict('x6t_wordcount', call, { mutation: { readOnly: true, basis: 'declared' } })).toBe(voiceRefusal('x6t_wordcount'))
    expect(verdict('x6t_wordcount', call, { mountedReadOnly: false })).toBe(voiceRefusal('x6t_wordcount'))
    expect(verdict('x6t_wordcount', call, { mountedReadOnly: true })).toBe(undefined)
  })

  it('an action, kind or type the tool does not declare is refused (the classifier reads it, the tool ignores it)', () => {
    const listed = { mutation: { readOnly: true, basis: 'listed' as const }, parameterNames: [] }
    expect(classifyActionIrreversibility({ tool: 'head_adopt', action: 'status' })).toBe(0)
    for (const key of ['action', 'kind', 'type']) {
      expect([key, verdict('fake_view', { [key]: 'status' }, listed)]).toEqual([key, expect.stringContaining('VOICE_LOOK_ONLY: I can look')])
    }
    expect(verdict('fake_view', {}, listed)).toBe(undefined)
    expect(verdict('fake_view', { kind: 'status' }, { ...listed, parameterNames: ['kind'] })).toBe(undefined)
    // head_adopt is a read by the classifier's own line (no operation, no force), so {} runs and {force} does not.
    expect(classifyActionIrreversibility({ tool: 'head_adopt' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'head_adopt', force: true })).toBe(1)
  })

  it('calls the classifier classes 0 that are not pure reads are refused: by tool name and by operation', () => {
    for (const name of VOICE_FAST_NOT_READS.tools) {
      const tool = name.replace(/-/g, '_')
      expect([tool, classifyActionIrreversibility({ tool, action: 'status' })]).toEqual([tool, 0])
      expect([tool, verdict(tool, {}, { mutation: { readOnly: true, basis: 'listed' } })]).toEqual([tool, voiceRefusal(tool)])
    }
    for (const operation of VOICE_FAST_NOT_READS.operations) {
      const action = operation.replace(/-/g, '_')
      expect([action, classifyActionIrreversibility({ tool: 'x6_cell', action })]).toEqual([action, 0])
      const answer = verdict('fake_cell', { action }, { mutation: { readOnly: false, actions: { read: [action], write: [] } } })
      expect([action, answer]).toEqual([action, voiceRefusal('fake_cell', action)])
    }
    expect(verdict('fake_cell', { action: 'list' }, { mutation: { readOnly: false, actions: { read: ['list'], write: [] } } })).toBe(undefined)
  })

  it('free text is never judged as a file name: queries, candidate bytes and tool input run; folders reached from her home do not', async () => {
    const host = await boot('open')
    const before = host.world().digest
    const free = ['how do password managers work', 'best secret santa gift ideas', 'what is a credential stuffing attack', 'ssh private-key formats',
      'private key rotation notes', '.', '..', 'regex \\d+ meaning', 'x'.repeat(5000), 'what does ../ mean in a path', 'TCP/IP and/or UDP',
      'private equity news', 'YOURTEAM-1', 'reset my password flow']
    for (const query of free) {
      const answer = await host.tool('x6_web_eyes', { action: 'search', query })
      expect([query.slice(0, 40), answer.body.ran, answer.body.refused]).toEqual([query.slice(0, 40), true, undefined])
    }
    expect(host.world().digest).toBe(before)
    // Still refused: a relative string that reaches the private folder or her thread logs (the bare word too: it names that folder).
    for (const [query, refusal] of [['private', VOICE_PRIVATE_REFUSAL], ['notes/../private/x', VOICE_PRIVATE_REFUSAL],
      ['../sessions', VOICE_THREAD_LOGS_REFUSAL], ['a\u0000b', VOICE_RELATIVE_PATH_REFUSAL]] as const) {
      expect([query, (await host.tool('x6_web_eyes', { action: 'search', query })).body.refused]).toEqual([query, refusal])
    }
    // Her own mounted tool's free input: text runs; past the scan's depth it is refused (the brief's fail-closed order).
    const mounted = { mountedReadOnly: true, parameterNames: ['act', 'input', 'paths'] }
    for (const text of ['my password is long', 'a\\b', 'y'.repeat(5000)]) {
      expect(verdict('x6t_wordcount', { act: 'count', input: { text } }, mounted)).toBe(undefined)
    }
    expect(verdict('x6t_wordcount', { act: 'count', input: { a: { b: { c: { d: 'deep' } } } } }, mounted)).toBe(voiceRefusal('x6t_wordcount'))
    // An absolute string keeps the full rule, as before this lane.
    expect(verdict('x6t_wordcount', { act: 'count', input: { text: `${HOME}/notes/secret.key` } }, mounted)).toBe(VOICE_PRIVATE_REFUSAL)
  })
})

// ---------- the spoken Kyber run: her real pinned cells on a Node worker (as self-check.spec.ts loads them) ----------
const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const cellHosts = new Set<CellHost>()
const cellWorkers = new Set<Worker>()
const servedCells: typeof fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  return new Response(Uint8Array.from(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))),
    { headers: { 'content-type': 'application/wasm' } })
}
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  cellWorkers.add(worker)
  return {
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() { await worker.terminate(); worker.removeAllListeners(); cellWorkers.delete(worker) },
  }
}
const realCellHost = (): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: servedCells, createWorker: nodeCellWorker })
  cellHosts.add(host)
  return host
}

describe('the spoken Kyber run: her fast voice may run a pinned cell and say the result', () => {
  afterEach(async () => {
    try { await Promise.all([...cellHosts].map(host => host.dispose())) }
    finally {
      cellHosts.clear()
      await Promise.all([...cellWorkers].map(worker => worker.terminate()))
      cellWorkers.clear()
    }
  })
  const COUNTDOWN = SELF_CHECK_KYBER_CALL
  const x6Cell = (args: Record<string, unknown>, extra: Partial<Parameters<typeof voiceOpenFastVerdict>[0]> = {}) =>
    voiceOpenFastVerdict({ tool: 'x6_cell', args, origin: { kind: 'builtin' }, githubClass: null, mutation: null,
      parameterNames: ['action', 'cutAt', 'step', 'inputs', 'at', 'ticks', 'cut', 'edgeOrgan', 'handoverOrgan', 'seed', 'wiring', 'what', 'drop',
        'cell', 'op', 'input', 'wat', 'name', 'fuel', 'replace'],
      runtimeClass: call => classifyActionIrreversibility(call), ...extra },
    voiceVerdict({ tool: 'x6_cell', args, origin: { kind: 'builtin' } }))

  it('"run the countdown and tell me where it halts": x6_cell compute on kyber-cpu runs and answers halted 1, a 7, 24 steps; nothing is written', async () => {
    const host = await boot('open')
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(realCellHost())
    const before = host.world().digest
    const answer = await host.tool('x6_cell', { ...COUNTDOWN })
    expect([answer.status, answer.body.ran, answer.body.refused]).toEqual([200, true, undefined])
    const result = (JSON.parse(answer.body.output ?? '{}') as { ok: boolean; result: { halted: number; state: { a: number }; stepsTaken: number } })
    expect([result.ok, result.result.halted, result.result.state.a, result.result.stepsTaken]).toEqual([true, 1, 7, 24])
    // `run` is the same code as `compute`.
    const run = await host.tool('x6_cell', { ...COUNTDOWN, action: 'run' })
    expect(JSON.parse(run.body.output ?? '{}')).toMatchObject({ ok: true, result: { halted: 1, state: { a: 7 }, stepsTaken: 24 } })
    // The program as an array of numbers is never a path; given as a string it is not refused as one either (the cell judges it).
    const asText = await host.tool('x6_cell', { ...COUNTDOWN, input: { ...COUNTDOWN.input, rom: COUNTDOWN.input.rom.join(' ') } })
    expect([asText.body.ran, asText.body.refused]).toEqual([true, undefined])
    // observe is a pure function of its input.
    expect((await host.tool('x6_cell', { action: 'observe', input: { mode: 'info' } })).body).toMatchObject({ ran: true })
    expect(host.world().digest).toBe(before)
    expect(host.reached).toEqual([])
  })

  it('at voice level look-only the cell run stays refused (only the fast voice at level open has the row)', async () => {
    const host = await boot('look-only')
    expect((await host.tool('x6_cell', { ...COUNTDOWN })).body).toEqual({ ok: true, ran: false, refused: voiceRefusal('x6_cell', 'compute') })
  })

  it('the cell writers and anything past the row are refused: forge, forget, compile_and_run, cord start and feed, promote, an undeclared key', async () => {
    const host = await boot('open')
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(realCellHost())
    const before = host.world()
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ action: 'forge', wat: '(module)', name: 'x' }, voiceRefusal('x6_cell', 'forge')],
      [{ action: 'forget', cell: 'x' }, voiceRefusal('x6_cell', 'forget')],
      [{ action: 'compile_and_run', wat: '(module)' }, voiceRefusal('x6_cell', 'compile_and_run')],
      [{ action: 'cord', step: 'start' }, voiceRefusal('x6_cell', 'cord')],
      [{ action: 'cord', step: 'feed', inputs: [1], at: 'here' }, voiceRefusal('x6_cell', 'cord')],
      [{ ...COUNTDOWN, promote: true }, voiceRefusal('x6_cell', 'compute')],
      [{ action: 'hive', promote: true }, voiceRefusal('x6_cell', 'hive')],
      [{ ...COUNTDOWN, kind: 'compute' }, voiceRefusal('x6_cell', 'compute')],
      [{ ...COUNTDOWN, step: 'start' }, voiceRefusal('x6_cell', 'compute')],
      [{ ...COUNTDOWN, wat: '(module)' }, voiceRefusal('x6_cell', 'compute')],
      [{ action: 'run_forged', cell: 'x', replace: true }, voiceRefusal('x6_cell', 'run_forged')],
    ]
    for (const [args, refusal] of refused) {
      expect([args, (await host.tool('x6_cell', args)).body]).toEqual([args, { ok: true, ran: false, refused: refusal }])
    }
    expect(host.world()).toEqual(before)
  })

  it('each x6_cell compute the row names passes both locks (the runtime classifier still classes it 0); the rest do not', () => {
    const rom = [...COUNTDOWN.input.rom], state = COUNTDOWN.input.state
    const allowed: Array<Record<string, unknown>> = [
      { ...COUNTDOWN }, { ...COUNTDOWN, action: 'run' },
      { action: 'run_forged', cell: 'my-cell', op: 'run', input: { a: 1 }, fuel: 1000 },
      { action: 'handoff', cell: 'kyber-cpu', input: { rom, state, steps: 64 }, cutAt: 12 },
      { action: 'carry', what: 'kyber-cpu-weights', drop: '0-9' }, { action: 'observe', input: { mode: 'info' } },
      { action: 'hive', ticks: 24, cut: 12, wiring: 'both' },
      { ...COUNTDOWN, input: { ...COUNTDOWN.input, rom: rom.join(',') } },
    ]
    for (const args of allowed) {
      expect(classifyActionIrreversibility({ ...args, tool: 'x6_cell' })).toBe(0)
      expect([args, x6Cell(args)]).toEqual([args, undefined])
    }
    // The classifier's lock is still there: a class it does not answer 0 is refused even on the row.
    expect(x6Cell({ ...COUNTDOWN }, { runtimeClass: () => 1 })).toBe(voiceRefusal('x6_cell', 'compute'))
    // The path scan still applies to a cell's arguments.
    expect(x6Cell({ ...COUNTDOWN, cell: `${HOME}/private/note.md` })).toBe(VOICE_PRIVATE_REFUSAL)
    expect(x6Cell({ ...COUNTDOWN, input: { rom: '../sessions/x' } })).toBe(VOICE_THREAD_LOGS_REFUSAL)
    // compute with promote: the classifier's verb list would class it 0; the row's argument list refuses it.
    expect(classifyActionIrreversibility({ ...COUNTDOWN, tool: 'x6_cell', promote: true })).toBe(0)
    expect(x6Cell({ ...COUNTDOWN, promote: true })).toBe(voiceRefusal('x6_cell', 'compute'))
    expect(x6Cell({ action: 'cord', step: 'feed', inputs: [1], at: 'edge' })).toBe(voiceRefusal('x6_cell', 'cord'))
  })

  it('the row takes away no read she had: x6_cell forged (listing her kept cells) still runs from the fast voice', async () => {
    // Before the row, x6_cell went by her capability index's closed enum, where `forged` is a read (READ_VERB).
    const mutation = { readOnly: false, actions: { read: ['list', 'journal', 'forged'], write: ['forge', 'forget', 'compile_and_run'] } }
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'forged' })).toBe(0)
    expect(x6Cell({ action: 'forged' }, { mutation, runtimeClass: () => 0 })).toBeUndefined()
    expect(x6Cell({ action: 'forged' }, { mutation })).toBeUndefined()
    // It reads only: a model-added argument is refused, and the classifier's lock still holds.
    expect(x6Cell({ action: 'forged', replace: true }, { mutation })).toBe(voiceRefusal('x6_cell', 'forged'))
    expect(x6Cell({ action: 'forged' }, { mutation, runtimeClass: () => 1 })).toBe(voiceRefusal('x6_cell', 'forged'))
    // Through the fast voice route: it lists her kept cells and writes nothing.
    const host = await boot('open')
    const before = host.world()
    const listed = await host.tool('x6_cell', { action: 'forged' })
    expect([listed.status, listed.body.ran, listed.body.refused]).toEqual([200, true, undefined])
    expect(JSON.parse(listed.body.output ?? '{}')).toMatchObject({ ok: true, count: 0, cells: [] })
    expect(host.world()).toEqual(before)
  })

  it('every other tool keeps the refusal of those verbs: the exception is x6_cell\'s row, never the word', () => {
    expect(Object.entries(VOICE_OPEN_FAST_READS).filter(([, row]) => row.computesWriteNothing === true).map(([tool]) => tool)).toEqual(['x6_cell'])
    for (const operation of VOICE_FAST_NOT_READS.operations) {
      const action = operation.replace(/-/g, '_')
      // A stand-in whose closed enum names the verb a read, the classifier answering 0: refused all the same.
      const answer = voiceOpenFastVerdict({ tool: 'fake_cell', args: { ...COUNTDOWN, action }, origin: { kind: 'preset' }, githubClass: null,
        mutation: { readOnly: false, actions: { read: [action], write: [] } }, parameterNames: ['action', 'cell', 'op', 'input'], runtimeClass: () => 0 },
      voiceRefusal('fake_cell', action))
      expect([action, answer]).toEqual([action, voiceRefusal('fake_cell', action)])
    }
    // The same name from another origin is not her built-in: refused.
    expect(x6Cell({ ...COUNTDOWN }, { origin: { kind: 'preset' } })).toBe(voiceRefusal('x6_cell', 'compute'))
  })
})

describe('V4: her voice scratch space, the one write her fast voice has', () => {
  const ROOT = VOICE_SCRATCH_ROOT
  it('through the fast voice route: write, append, read and list inside its folder; the write is recorded in her write set', async () => {
    const host = await boot('look-only')
    const write = await host.tool('voice_scratch', { action: 'write', path: 'notes/today.md', text: 'The owner wants the voice to see everything.\n' })
    expect([write.body.ran, write.body.refused]).toEqual([true, undefined])
    expect(JSON.parse(write.body.output ?? '{}')).toMatchObject({ ok: true, action: 'write', path: `${ROOT}/notes/today.md`, notice: VOICE_SCRATCH_NOTICE })
    await host.tool('voice_scratch', { action: 'append', path: `${ROOT}/notes/today.md`, text: 'And a scratch space.\n' })
    // From the fast voice the note starts with its provenance header line (with the time), then the text.
    const note = String(host.vfs.readFileSync(`${ROOT}/notes/today.md`, 'utf8'))
    const header = note.slice(0, note.indexOf('\n') + 1)
    expect(header.startsWith(VOICE_SCRATCH_FAST_HEADER_PREFIX)).toBe(true)
    expect(note.slice(header.length)).toBe('The owner wants the voice to see everything.\nAnd a scratch space.\n')
    expect(JSON.parse((await host.tool('voice_scratch', { action: 'read', path: 'notes/today.md' })).body.output ?? '{}'))
      .toMatchObject({ ok: true, text: note })
    const noted = 62 + new TextEncoder().encode(header).byteLength
    expect(JSON.parse((await host.tool('voice_scratch', { action: 'list' })).body.output ?? '{}'))
      .toMatchObject({ ok: true, files: [{ path: 'notes/today.md', bytes: noted }], bytes: noted })
    // Her working self reads the folder like any other (the look-only read rule allows it too).
    expect((await host.tool('read', { file_path: `${ROOT}/notes/today.md` })).body.ran).toBe(true)
    // The write family is in her write-set inventory (an unlisted write would fail write-set-inventory.spec.ts).
    expect(classifyWritePath(`${ROOT}/notes/today.md`)?.id).toBe('voice-scratch')
    expect(classifyWritePath(`${ROOT}/../HANDOFF.md`)).toBe(null)
  })

  it('it cannot leave its folder: dot-dot, absolute elsewhere, a symbolic link, a long name; nothing is written outside', async () => {
    const host = await boot('open')
    const before = host.world()
    const outside: Array<[unknown, string]> = [
      ['../HANDOFF.md', 'SCRATCH_PATH_OUTSIDE'], ['notes/../../private/note.md', 'SCRATCH_PATH_OUTSIDE'], [`${ROOT}/../private/x.md`, 'SCRATCH_PATH_OUTSIDE'],
      ['./x.md', 'SCRATCH_PATH_OUTSIDE'], ['/dsh/home/auma/HANDOFF.md', 'SCRATCH_PATH_OUTSIDE'], ['/dsh/home/auma/voice-scratch-evil/x.md', 'SCRATCH_PATH_OUTSIDE'],
      [ROOT, 'SCRATCH_PATH_OUTSIDE'], ['~/x.md', 'SCRATCH_PATH_INVALID'], ['a\\b.md', 'SCRATCH_PATH_INVALID'], ['a\0b', 'SCRATCH_PATH_INVALID'],
      ['notes//x.md', 'SCRATCH_PATH_INVALID'], ['.hidden', 'SCRATCH_PATH_INVALID'], ['a/b/c/d/e.md', 'SCRATCH_PATH_INVALID'],
      [`${'n'.repeat(64)}.md`, 'SCRATCH_PATH_INVALID'], [`${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/${'d'.repeat(30)}`, 'SCRATCH_PATH_TOO_LONG'],
      ['', 'SCRATCH_PATH_INVALID'],
      // Her preset's instruction loader reads these names as instructions: never a note's name, any case, any depth.
      ['AGENTS.md', 'SCRATCH_PATH_INVALID'], ['CLAUDE.md', 'SCRATCH_PATH_INVALID'], ['AGENTS.local.md', 'SCRATCH_PATH_INVALID'],
      ['CLAUDE.local.md', 'SCRATCH_PATH_INVALID'], ['agents.md', 'SCRATCH_PATH_INVALID'], ['notes/Claude.Local.MD', 'SCRATCH_PATH_INVALID'],
      [`${ROOT}/notes/AGENTS.md`, 'SCRATCH_PATH_INVALID'],
    ]
    for (const [path, code] of outside) {
      const answer = JSON.parse((await host.tool('voice_scratch', { action: 'write', path, text: 'x' })).body.output ?? '{}') as Record<string, unknown>
      expect([path, answer.ok, answer.code]).toEqual([path, false, code])
    }
    // A path that is not a string is refused by her tool's own schema before it runs.
    const typed = await host.tool('voice_scratch', { action: 'write', path: 42, text: 'x' })
    expect([typed.body.ok, typed.body.ran, typeof typed.body.error]).toEqual([false, true, 'string'])
    expect(runVoiceScratch(host.vfs, { action: 'write', path: 42, text: 'x' })).toMatchObject({ ok: false, code: 'SCRATCH_PATH_INVALID' })
    expect(host.world()).toEqual(before)
    // A symbolic link on the way is never followed (her memory VFS has none, so a VFS that reports one stands in).
    const files = new Map<string, string>()
    const links = new Set([`${ROOT}/linked`])
    const dirs = new Set([ROOT, `${ROOT}/linked`])
    const fake: VoiceScratchVfs = {
      existsSync: path => dirs.has(path) || files.has(path),
      statSync: path => ({ isDirectory: () => dirs.has(path), isFile: () => files.has(path), size: files.get(path)?.length ?? 0 }),
      lstatSync: path => ({ isSymbolicLink: () => links.has(path) }),
      readdirSync: path => [...dirs, ...files.keys()].filter(item => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/')).map(item => item.slice(path.length + 1)),
      readFileSync: path => files.get(path) ?? '',
      writeFileSync: (path, data) => { files.set(path, data) },
      mkdirSync: (path) => { dirs.add(path) },
    }
    expect(runVoiceScratch(fake, { action: 'write', path: 'linked/x.md', text: 'y' })).toMatchObject({ ok: false, code: 'SCRATCH_PATH_LINK' })
    expect(runVoiceScratch(fake, { action: 'read', path: 'linked' })).toMatchObject({ ok: false, code: 'SCRATCH_PATH_LINK' })
    links.add(ROOT)
    expect(runVoiceScratch(fake, { action: 'write', path: 'plain.md', text: 'y' })).toMatchObject({ ok: false, code: 'SCRATCH_PATH_LINK' })
    expect(runVoiceScratch(fake, { action: 'list' })).toMatchObject({ ok: false, code: 'SCRATCH_PATH_LINK' })
    expect(files.size).toBe(0)
  })

  it('its bounds hold: 64 KiB a note, 200 notes, 2 MiB in all, text only; a write over a bound writes nothing', async () => {
    const host = await boot('open')
    // One fast-voice call carries at most 4 KiB of arguments (the edge's bound), so a full note is built by appends; the
    // tool itself is called here directly over her VFS for the large bounds.
    const scratch = async (args: Record<string, unknown>) => Promise.resolve(runVoiceScratch(host.vfs, args) as Record<string, unknown>)
    expect(await scratch({ action: 'write', path: 'big.md', text: 'x'.repeat(VOICE_SCRATCH_LIMITS.fileBytes + 1) })).toMatchObject({ ok: false, code: 'SCRATCH_FILE_TOO_LARGE' })
    expect(await scratch({ action: 'write', path: 'big.md', text: 'x'.repeat(VOICE_SCRATCH_LIMITS.fileBytes) })).toMatchObject({ ok: true })
    expect(await scratch({ action: 'append', path: 'big.md', text: 'x' })).toMatchObject({ ok: false, code: 'SCRATCH_FILE_TOO_LARGE' })
    expect(await scratch({ action: 'write', path: 'nul.md', text: 'a\0b' })).toMatchObject({ ok: false, code: 'SCRATCH_TEXT_INVALID' })
    expect(runVoiceScratch(host.vfs, { action: 'write', path: 'obj.md', text: { a: 1 } })).toMatchObject({ ok: false, code: 'SCRATCH_TEXT_INVALID' })
    expect(runVoiceScratch(host.vfs, { action: 'run', path: 'big.md' })).toMatchObject({ ok: false, code: 'SCRATCH_ACTION_INVALID' })
    expect((await host.tool('voice_scratch', { action: 'run', path: 'big.md' })).body.ok).toBe(false)
    // 2 MiB in all: 31 more full notes fit (32 x 64 KiB = 2 MiB), the next byte does not.
    for (let index = 1; index < 32; index += 1) expect(await scratch({ action: 'write', path: `full/${String(index)}.md`, text: 'y'.repeat(VOICE_SCRATCH_LIMITS.fileBytes) })).toMatchObject({ ok: true })
    expect(await scratch({ action: 'write', path: 'one-more.md', text: 'z' })).toMatchObject({ ok: false, code: 'SCRATCH_FULL' })
    expect(host.vfs.existsSync(`${ROOT}/one-more.md`)).toBe(false)
    // 200 notes: a fresh space of small ones.
    const small = await boot('open')
    const note = async (path: string) => JSON.parse((await small.tool('voice_scratch', { action: 'write', path, text: 'n' })).body.output ?? '{}') as Record<string, unknown>
    for (let index = 0; index < VOICE_SCRATCH_LIMITS.files; index += 1) expect(await note(`n/${String(index)}.md`)).toMatchObject({ ok: true })
    expect(await note('n/200.md')).toMatchObject({ ok: false, code: 'SCRATCH_TOO_MANY_FILES' })
    expect(await note('n/0.md')).toMatchObject({ ok: true })
  })

  it('a look-only spoken governed turn still may not call it: only the fast voice route lets it through', async () => {
    expect(voiceVerdict({ tool: 'voice_scratch', args: { action: 'write', path: 'x.md', text: 'y' }, origin: { kind: 'builtin' } })).toBe(voiceRefusal('voice_scratch', 'write'))
  })
})

describe('SHOULD: the hive cap, scratch provenance, no spill from a voice read, real locations', () => {
  const x6Cell = (args: Record<string, unknown>) => voiceOpenFastVerdict({ tool: 'x6_cell', args, origin: { kind: 'builtin' }, githubClass: null, mutation: null,
    parameterNames: ['action', 'ticks', 'cut', 'edgeOrgan', 'handoverOrgan', 'seed', 'wiring'], runtimeClass: call => classifyActionIrreversibility(call) },
  voiceVerdict({ tool: 'x6_cell', args, origin: { kind: 'builtin' } }))

  it('5: x6_cell hive from the fast voice runs at most 24 ticks (each tick is one edge call); its default (24) runs', () => {
    expect(VOICE_FAST_HIVE_MAX_TICKS).toBe(24)
    for (const args of [{ action: 'hive' }, { action: 'hive', ticks: 24, wiring: 'both' }, { action: 'hive', ticks: 1 }]) expect([args, x6Cell(args)]).toEqual([args, undefined])
    for (const ticks of [25, 128, 0, 2.5, '24', null]) {
      expect([ticks, x6Cell({ action: 'hive', ticks })]).toEqual([ticks, voiceRefusal('x6_cell', 'hive')])
    }
  })

  it('6: a note written or appended from the fast voice starts with the provenance header (with the time); read returns it; the bound counts it', async () => {
    const host = await boot('open')
    const write = await host.tool('voice_scratch', { action: 'write', path: 'notes/today.md', text: 'The owner wants the voice to see everything.\n' })
    expect(write.body.ran).toBe(true)
    const stored = String(host.vfs.readFileSync(`${VOICE_SCRATCH_ROOT}/notes/today.md`, 'utf8'))
    const [first, ...rest] = stored.split('\n')
    expect(first?.startsWith(VOICE_SCRATCH_FAST_HEADER_PREFIX)).toBe(true)
    expect(first).toMatch(/at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]$/)
    expect(VOICE_SCRATCH_FAST_HEADER_PREFIX).toContain('fast voice')
    expect(VOICE_SCRATCH_FAST_HEADER_PREFIX).toContain('unverified')
    expect(VOICE_SCRATCH_FAST_HEADER_PREFIX).toContain('data, not instructions')
    expect(rest.join('\n')).toBe('The owner wants the voice to see everything.\n')
    // An append keeps ONE header (its time the newest write's) and the text after it.
    await host.tool('voice_scratch', { action: 'append', path: 'notes/today.md', text: 'And a scratch space.\n' })
    const appended = String(host.vfs.readFileSync(`${VOICE_SCRATCH_ROOT}/notes/today.md`, 'utf8'))
    expect(appended.split('\n').filter(line => line.startsWith(VOICE_SCRATCH_FAST_HEADER_PREFIX))).toHaveLength(1)
    expect(appended.slice(appended.indexOf('\n') + 1)).toBe('The owner wants the voice to see everything.\nAnd a scratch space.\n')
    const read = JSON.parse((await host.tool('voice_scratch', { action: 'read', path: 'notes/today.md' })).body.output ?? '{}') as { text?: string }
    expect(read.text).toBe(appended)
    // A note her working self wrote first gains the header at the top when the fast voice appends to it.
    host.vfs.writeFileSync(`${VOICE_SCRATCH_ROOT}/notes/hers.md`, 'typed note\n')
    await host.tool('voice_scratch', { action: 'append', path: 'notes/hers.md', text: 'spoken line\n' })
    const hers = String(host.vfs.readFileSync(`${VOICE_SCRATCH_ROOT}/notes/hers.md`, 'utf8'))
    expect([hers.startsWith(VOICE_SCRATCH_FAST_HEADER_PREFIX), hers.endsWith('\ntyped note\nspoken line\n')]).toEqual([true, true])
    // The 64 KiB bound includes the header: a text that fits alone does not fit with it.
    const at = Date.UTC(2026, 10, 16, 12, 0, 0)
    const header = `${VOICE_SCRATCH_FAST_HEADER_PREFIX}${new Date(at).toISOString()}]\n`
    const room = VOICE_SCRATCH_LIMITS.fileBytes - new TextEncoder().encode(header).byteLength
    expect(runVoiceScratch(host.vfs, { action: 'write', path: 'full.md', text: 'x'.repeat(room + 1) }, { fastVoiceAt: at })).toMatchObject({ ok: false, code: 'SCRATCH_FILE_TOO_LARGE' })
    expect(runVoiceScratch(host.vfs, { action: 'write', path: 'full.md', text: 'x'.repeat(room) }, { fastVoiceAt: at })).toMatchObject({ ok: true, bytes: VOICE_SCRATCH_LIMITS.fileBytes })
    // Called by her working self (no fast-voice mark), a note is written as given.
    expect(runVoiceScratch(host.vfs, { action: 'write', path: 'plain.md', text: 'as given' })).toMatchObject({ ok: true })
    expect(host.vfs.readFileSync(`${VOICE_SCRATCH_ROOT}/plain.md`, 'utf8')).toBe('as given')
  })

  it('7: a grep through the fast voice fires no post-execute hook, so no spill file is ever written from a voice read', async () => {
    const host = await boot('open')
    const hooked: string[] = []
    host.context.on('tools/post-execute', async (_exec, _result, next) => {
      hooked.push('post-execute')
      host.vfs.writeFileSync(`${HOME}/grep-results.txt`, 'spill')
      return await next()
    })
    const before = host.world().digest
    expect((await host.tool('grep', { path: `${HOME}/notes`, pattern: 'memory' })).body.ran).toBe(true)
    expect([hooked, host.vfs.existsSync(`${HOME}/grep-results.txt`), host.world().digest]).toEqual([[], false, before])
  })

  it('8: a path whose real location is in her private folder, her thread logs or a memory store is refused before the tool runs', async () => {
    const host = await boot('open')
    host.vfs.writeFileSync(`${HOME}/notes/link.md`, 'stands in for a link')
    host.vfs.writeFileSync(`${HOME}/notes/plain.md`, 'plain')
    // Her MemoryVfs has no links; a VFS that has them answers realpath with the link's target.
    const targets: Record<string, string> = { [`${HOME}/notes/link.md`]: `${HOME}/private/note.md`, [`${HOME}/notes/log`]: '/dsh/home/sessions/x',
      [`${HOME}/notes/store`]: `${HOME}/memory-store.v2.json`, [`${HOME}/notes/dir`]: `${HOME}/private` }
    const real = host.vfs.realpathSync.bind(host.vfs)
    vi.spyOn(host.vfs, 'realpathSync').mockImplementation((path: string) => targets[path] ?? real(path))
    for (const [tool, args, refusal] of [['read', { file_path: `${HOME}/notes/link.md` }, VOICE_PRIVATE_REFUSAL],
      ['read', { file_path: `${HOME}/notes/log` }, VOICE_THREAD_LOGS_REFUSAL], ['read', { file_path: `${HOME}/notes/store` }, VOICE_THREAD_LOGS_REFUSAL],
      ['grep', { path: `${HOME}/notes/dir`, pattern: 'x' }, VOICE_PRIVATE_REFUSAL], ['glob', { path: `${HOME}/notes/dir`, pattern: '*' }, VOICE_PRIVATE_REFUSAL]] as const) {
      expect([tool, args, (await host.tool(tool, args)).body]).toEqual([tool, args, { ok: true, ran: false, refused: refusal }])
    }
    expect(host.reached).toEqual([])
    // An ordinary path, and one that does not exist yet, still run.
    expect((await host.tool('read', { file_path: `${HOME}/notes/plain.md` })).body.ran).toBe(true)
    expect((await host.tool('read', { file_path: `${HOME}/notes/missing.md` })).body.ran).toBe(true)
  })
})

// the voice memory and N4: her voice memory's chain in her home. The page-only route writes it; her fast voice never
// opens either file with read, grep or glob (a memory store), and her voice scratch tool cannot reach them; the verifier
// x6_voice_memory is a built-in read the fast voice may call through `look`.
describe('her home keeps the chain; only x6_voice_memory reads it from voice', () => {
  const salt = (n: number): string => n.toString(16).padStart(2, '0').repeat(16)
  async function chainItems(count: number) {
    const items: Array<{ record: Record<string, unknown>; words: Record<string, unknown> }> = []
    let prev = VOICE_MEMORY_ZERO
    for (let seq = 1; seq <= count; seq += 1) {
      const words = { seq, salt: salt(seq), heard: `heard ${String(seq)}`, said: `said ${String(seq)}` }
      const record = { v: 1, seq, prev, at: 1_763_294_400_000 + seq, conv: 'conv_a', turn: `eleven:conv_a:${String(seq)}`, kind: 'exchange',
        heardC: await commitment(words.salt, 0, words.heard), saidC: await commitment(words.salt, 1, words.said), ended: 'answered', path: 'fast', calls: [] }
      items.push({ record, words })
      prev = await recordDigest(record)
    }
    return items
  }

  it('N2: the route answers head (seq 0, 64 zeros on an empty home), appends in order, makes the folder, and refuses other shapes', async () => {
    const host = await boot('look-only')
    const memory = (method: string, body: string) => host.memoryRoute(method, body)
    expect(await memory('POST', '{"action":"head"}')).toEqual({ status: 200, body: { ok: true, seq: 0, digest: VOICE_MEMORY_ZERO } })
    expect(host.vfs.existsSync(VOICE_MEMORY_HOME)).toBe(false)
    const items = await chainItems(2)
    const appended = await memory('POST', JSON.stringify({ action: 'append', items }))
    expect(appended).toEqual({ status: 200, body: { ok: true, seq: 2, digest: await recordDigest(items[1]?.record) } })
    expect(String(host.vfs.readFileSync(VOICE_MEMORY_CHAIN, 'utf8')).split('\n').length).toBe(3)
    const gap = await memory('POST', JSON.stringify({ action: 'append', items: (await chainItems(4)).slice(3) }))
    expect(gap.body).toMatchObject({ ok: false, code: 'GAP', seq: 2 })
    for (const [method, body] of [['GET', ''], ['POST', '{"action":"rewrite"}'], ['POST', 'not json'], ['POST', ' '.repeat(65_537)]] as const) {
      expect((await memory(method, body)).status).toBe(400)
    }
  })

  for (const level of ['look-only', 'open'] as const) {
    it(`N2 (${level}): the fast voice cannot read, grep or glob either file; a search above withholds them; the scratch tool cannot reach them`, async () => {
      const host = await boot(level)
      await host.memoryRoute('POST', JSON.stringify({ action: 'append', items: await chainItems(2) }))
      const before = host.world().digest
      for (const path of [VOICE_MEMORY_CHAIN, VOICE_MEMORY_WORDS, `${HOME}/notes/../voice/chain.v1.jsonl`]) {
        expect((await host.tool('read', { file_path: path })).body).toMatchObject({ ran: false, refused: VOICE_MEMORY_HOME_REFUSAL })
      }
      expect((await host.tool('glob', { path: VOICE_MEMORY_HOME, pattern: '*.jsonl' })).body).toMatchObject({ ran: false, refused: VOICE_MEMORY_HOME_REFUSAL })
      expect((await host.tool('grep', { path: VOICE_MEMORY_HOME, pattern: 'heard' })).body).toMatchObject({ ran: false, refused: VOICE_MEMORY_HOME_REFUSAL })
      for (const entry of ['voice/chain.v1.jsonl', 'voice/words.v1.jsonl', VOICE_MEMORY_CHAIN]) expect(voiceSearchEntryWithheld(entry, HOME)).toBe(true)
      expect(withholdVoiceSearchEntries('glob', { path: HOME }, { root: '.', paths: ['voice/words.v1.jsonl', 'notes/garden.md'] }))
        .toEqual({ out: { root: '.', paths: ['notes/garden.md'] }, withheld: 1 })
      for (const path of ['../voice/chain.v1.jsonl', VOICE_MEMORY_CHAIN, `${VOICE_SCRATCH_ROOT}/../voice/words.v1.jsonl`]) {
        const answer = await host.tool('voice_scratch', { action: 'write', path, text: 'overwritten' })
        const written = answer.body.output === undefined ? undefined : (JSON.parse(answer.body.output) as { ok?: boolean }).ok
        expect(written).not.toBe(true)
      }
      expect(host.world().digest).toBe(before)
    })

    it(`N4 (${level}): x6_voice_memory tail, head, search and verify run through the fast voice route; an unknown action does not`, async () => {
      const host = await boot(level)
      await host.memoryRoute('POST', JSON.stringify({ action: 'append', items: await chainItems(3) }))
      const tail = await host.tool('x6_voice_memory', { action: 'tail', n: 2 })
      expect([tail.body.ran, tail.body.refused]).toEqual([true, undefined])
      expect(JSON.parse(tail.body.output ?? '{}')).toMatchObject({ ok: true, exchanges: [{ seq: 2, heard: 'heard 2' }, { seq: 3, said: 'said 3' }], note: VOICE_MEMORY_SCOPE })
      for (const args of [{ action: 'head' }, { action: 'search', q: 'said' }]) expect((await host.tool('x6_voice_memory', args)).body.ran).toBe(true)
      // The fixture's edge status carries no memory head: unknown, never a pass.
      const verify = await host.tool('x6_voice_memory', { action: 'verify' })
      expect(JSON.parse(verify.body.output ?? '{}')).toMatchObject({ verdict: 'EDGE_UNREACHABLE' })
      expect(host.outbound.filter(call => call.path === '/_host/voice').map(call => call.body)).toEqual(['{"action":"managed_status"}'])
      expect((await host.tool('x6_voice_memory', { action: 'delete' })).body.ran).toBe(false)
    })
  }

  it('N4: class 0 for every action (the tool has no write path); the voice row names exactly its four reads; a look-only spoken turn may call them', () => {
    for (const action of ['verify', 'tail', 'search', 'head', 'delete', undefined]) expect(classifyActionIrreversibility({ tool: 'x6_voice_memory', action })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_voice_memory', action: 'tail', promote: true })).toBe(2)
    const row = VOICE_SWITCH_TABLE.x6_voice_memory
    expect(row).toMatchObject({ origin: 'builtin', selector: 'action' })
    expect(Object.keys(row?.values ?? {}).sort()).toEqual(['head', 'search', 'tail', 'verify'])
    for (const action of ['verify', 'tail', 'search', 'head']) expect(voiceVerdict({ tool: 'x6_voice_memory', args: { action }, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_voice_memory', args: {}, origin: { kind: 'builtin' } })).toBeDefined()
    expect(voiceVerdict({ tool: 'x6_voice_memory', args: { action: 'tail' }, origin: { kind: 'organ', organId: 'x', organSha: null } })).toBeDefined()
  })
})

// Her timeline. x6_memory is a built-in read the fast voice may call through `look`, every action class 0; the
// timeline folder holds the words of every conversation of hers, so from voice it is a memory store: never read, grep or glob.
describe('x6_memory from the fast voice; the timeline folder is a memory store', () => {
  const TIMELINE = `${HOME}/timeline`
  for (const level of ['look-only', 'open'] as const) {
    it(`(${level}): x6_memory timeline, search, around, head and verify run through the fast voice route; an unknown action does not`, async () => {
      const host = await boot(level)
      const before = host.world()
      for (const args of [{ action: 'timeline' }, { action: 'timeline', since: 'today' }, { action: 'search', q: 'beans' }, { action: 'around', seq: 1 },
        { action: 'head' }, { action: 'verify' }]) {
        const answer = await host.tool('x6_memory', args)
        expect([answer.body.ran, answer.body.refused]).toEqual([true, undefined])
        expect(String(answer.body.output)).toContain('This is her own record in her home')
      }
      expect(JSON.parse((await host.tool('x6_memory', { action: 'head' })).body.output ?? '{}')).toMatchObject({ ok: true, seq: 0 })
      expect((await host.tool('x6_memory', { action: 'delete' })).body.ran).toBe(false)
      // Reads only: nothing changed, nothing sent.
      expect(host.world()).toEqual(before)
    })

    it(`(${level}): the fast voice cannot read, grep or glob the timeline files; a search above withholds them`, async () => {
      const host = await boot(level)
      host.vfs.mkdirSync(TIMELINE, { recursive: true })
      host.vfs.writeFileSync(`${TIMELINE}/words.v1.jsonl`, '{"hers":"made up","his":"made up","salt":"00","seq":1}\n')
      for (const path of [`${TIMELINE}/chain.v1.jsonl`, `${TIMELINE}/words.v1.jsonl`, `${HOME}/notes/../timeline/words.v1.jsonl`]) {
        expect((await host.tool('read', { file_path: path })).body).toMatchObject({ ran: false, refused: MEMORY_TIMELINE_HOME_REFUSAL })
      }
      expect((await host.tool('glob', { path: TIMELINE, pattern: '*.jsonl' })).body).toMatchObject({ ran: false, refused: MEMORY_TIMELINE_HOME_REFUSAL })
      expect((await host.tool('grep', { path: TIMELINE, pattern: 'made' })).body).toMatchObject({ ran: false, refused: MEMORY_TIMELINE_HOME_REFUSAL })
      for (const entry of ['timeline/chain.v1.jsonl', 'timeline/words.v1.jsonl', `${TIMELINE}/words.v1.jsonl`]) expect(voiceSearchEntryWithheld(entry, HOME)).toBe(true)
      expect(withholdVoiceSearchEntries('glob', { path: HOME }, { root: '.', paths: ['timeline/words.v1.jsonl', 'notes/garden.md'] }))
        .toEqual({ out: { root: '.', paths: ['notes/garden.md'] }, withheld: 1 })
    })
  }

  it('class 0 for every action (the tool has no write path); the voice row names exactly its five reads; a look-only spoken turn may call them', () => {
    for (const action of ['timeline', 'search', 'around', 'head', 'verify', 'delete', undefined]) expect(classifyActionIrreversibility({ tool: 'x6_memory', action })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_memory', action: 'timeline', promote: true })).toBe(2)
    const row = VOICE_SWITCH_TABLE.x6_memory
    expect(row).toMatchObject({ origin: 'builtin', selector: 'action' })
    expect(Object.keys(row?.values ?? {}).sort()).toEqual(['around', 'head', 'search', 'timeline', 'verify'])
    for (const action of ['timeline', 'search', 'around', 'head', 'verify']) expect(voiceVerdict({ tool: 'x6_memory', args: { action }, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_memory', args: {}, origin: { kind: 'builtin' } })).toBeDefined()
    expect(voiceVerdict({ tool: 'x6_memory', args: { action: 'delete' }, origin: { kind: 'builtin' } })).toBeDefined()
    expect(voiceVerdict({ tool: 'x6_memory', args: { action: 'timeline' }, origin: { kind: 'organ', organId: 'x', organSha: null } })).toBeDefined()
  })
})

// The two lanes meet for real. The edge tells her fast voice how to call x6_memory (voice-fast.mjs:
// her memory rules and the look description); her worker builds the tool (storage/memory-timeline.ts). This fails the day
// they disagree: every action the edge names is accepted (and the edge names every one), every argument it names is
// read, every time word it gives parses.
describe('the edge and the worker agree about x6_memory', () => {
  /** The three texts this test reads, as voice-fast.mjs exports them. */
  const { FAST_VOICE_RULES, LOOK_TOOL_DESCRIPTION, MEMORY_RULES } = untypedFast as
    { FAST_VOICE_RULES: string; LOOK_TOOL_DESCRIPTION: string; MEMORY_RULES: string }
  /** What the edge tells her: the actions, their arguments (required or not) and the time words. */
  function edgeTells() {
    const segment = /x6_memory (\{[^]*?)\. (?=[A-Z])/.exec(LOOK_TOOL_DESCRIPTION)?.[1] ?? ''
    expect(segment).not.toBe('')
    const actions = new Map<string, Array<{ name: string; optional: boolean }>>()
    const times: string[] = []
    for (const alternative of segment.split(' | ').map(part => part.trim())) {
      const call = /^\{action:"([a-z_]+)"((?:,[a-z_]+\??)*)\}(.*)$/.exec(alternative)
      if (call) {
        actions.set(call[1]!, (call[2] ?? '').split(',').filter(Boolean).map(arg => ({ name: arg.replace('?', ''), optional: arg.endsWith('?') })))
        // The parenthesis after a call names the time words since and until take.
        for (const quoted of (call[3] ?? '').matchAll(/"([^"]+)"/g)) times.push(quoted[1]!)
        continue
      }
      expect(alternative).toMatch(/^[a-z_]+$/)
      actions.set(alternative, [])
    }
    // Her rules name actions too ("x6_memory timeline", "x6_memory search").
    const ruled = [...`${MEMORY_RULES} ${FAST_VOICE_RULES}`.matchAll(/x6_memory ([a-z_]+)/g)].map(match => match[1]!)
    return { actions, times, ruled }
  }

  it('every action the edge names is one the tool accepts and the edge names every action; each argument it names is read; each time word parses', async () => {
    const { actions, times, ruled } = edgeTells()
    expect([...actions.keys()].sort()).toEqual([...MEMORY_ACTIONS].sort())
    expect(ruled.length).toBeGreaterThan(0)
    for (const name of ruled) expect(MEMORY_ACTIONS as readonly string[]).toContain(name)
    expect(times.length).toBeGreaterThan(0)
    // A home with one turn, so every action has something to answer.
    const vfs = new MemoryVfs()
    const now = 1_763_294_400_000
    expect(await createTimelineStore(vfs).append({ v: 1, at: now - 60_000, kind: 'turn', conv: 'thread-a', title: 'Garden plan', turn: '1',
      ended: 'completed', steps: 1, tools: [] }, { his: 'plant beans', hers: 'In March.' })).toMatchObject({ ok: true })
    const ask = (args: Record<string, unknown>) => runMemoryTool({ vfs, nowMs: () => now, screen: withholdSecrets,
      failures: () => ({ count: 0, lastCode: null, lastAt: null }), zoneOffsetMs: () => 0 }, args)
    const valid: Record<string, unknown> = { q: 'beans', seq: 1 }
    const declared = Object.keys(memoryToolSpec(() => { throw new Error('not called') }, () => {}).parameters)
    for (const [action, args] of actions) {
      const base: Record<string, unknown> = { action }
      for (const arg of args) if (!arg.optional) base[arg.name] = valid[arg.name]
      expect(await ask(base), `${action} as the edge names it`).toMatchObject({ ok: true })
      // An argument the tool did not read could not be refused: a wrong one is, by name.
      for (const arg of args) {
        expect(declared, `${action}.${arg.name} is declared`).toContain(arg.name)
        const answer = await ask({ ...base, [arg.name]: { wrong: true } })
        expect(answer.ok, `${action}.${arg.name} is read`).toBe(false)
        expect(answer.code).not.toBe('MEMORY_ACTION_INVALID')
      }
      // The control: an argument no one reads changes nothing.
      expect(await ask({ ...base, unread: { wrong: true } })).toMatchObject({ ok: true })
    }
    for (const word of times) {
      expect(parseMemoryTime(word, now, () => 0), word).not.toBeNull()
      expect(await ask({ action: 'timeline', since: word }), word).toMatchObject({ ok: true })
    }
    expect(MEMORY_TOOL).toBe('x6_memory')
  })

  it('end to end through the fast voice route: a home with two turns and one voice exchange answers real rows; an unknown action is refused by the tool', async () => {
    for (const level of ['look-only', 'open'] as const) {
      const host = await boot(level)
      const emit = (id: string, type: string, data: unknown) => {
        (host.context as unknown as { emit(...args: unknown[]): void }).emit('session/event',
          { id, header: { version: 4, id, createdAt: 1, isSeeded: false, cwd: HOME } }, { type, seq: 0, data })
      }
      const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
      for (const [id, his, hers] of [['thread-a', 'plan the garden beds', 'Beds by the fence.'], ['thread-b', 'price the fence paint', 'About forty dollars.']]) {
        emit(id!, 'turn/start', { turn: 1 })
        emit(id!, 'user/message', { id: `m-${id!}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: his }] })
        emit(id!, 'assistant/message', { turn: 1, step: 1, message: { id: `a-${id!}`, role: 'assistant', source: { kind: 'model' },
          content: [{ type: 'text', text: hers }] }, stream: [] })
        emit(id!, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
        await settle()
      }
      const words = { seq: 1, salt: 'cd'.repeat(16), heard: 'what colour is the fence', said: 'Blue, as you chose.' }
      const record = { v: 1, seq: 1, prev: VOICE_MEMORY_ZERO, at: Date.now(), conv: 'conv_a', turn: 'eleven:conv_a:1', kind: 'exchange',
        heardC: await commitment(words.salt, 0, words.heard), saidC: await commitment(words.salt, 1, words.said), ended: 'answered', path: 'fast', calls: [] }
      expect((await host.memoryRoute('POST', JSON.stringify({ action: 'append', items: [{ record, words }] }))).body).toMatchObject({ ok: true, seq: 1 })
      await settle()
      const before = host.world()
      const timeline = await host.tool('x6_memory', { action: 'timeline' })
      expect([timeline.body.ran, timeline.body.refused]).toEqual([true, undefined])
      const rows = (JSON.parse(timeline.body.output ?? '{}') as { records: Array<Record<string, unknown>> }).records
      expect(rows.map(row => [row.kind, row.his ?? row.heard])).toEqual([
        ['turn', 'plan the garden beds'], ['turn', 'price the fence paint'], ['voice', 'what colour is the fence']])
      expect(rows.map(row => row.hers ?? row.said)).toEqual(['Beds by the fence.', 'About forty dollars.', 'Blue, as you chose.'])
      const search = await host.tool('x6_memory', { action: 'search', q: 'fence' })
      expect([search.body.ran, search.body.refused]).toEqual([true, undefined])
      const hits = (JSON.parse(search.body.output ?? '{}') as { hits: Array<Record<string, unknown>> }).hits
      expect(hits.map(hit => hit.source).sort()).toEqual(['timeline', 'timeline', 'voice'])
      // An action the tool does not have: through look, her voice list (the x6_memory row names its five reads) refuses it
      // at both levels before the tool runs; the tool, asked on the same home, refuses it itself before anything is read.
      const unknown = await host.tool('x6_memory', { action: 'forget' })
      expect(unknown.body).toMatchObject({ ran: false, refused: expect.stringContaining('x6_memory.forget is not on my voice list') as unknown })
      const itself = await runMemoryTool({ vfs: host.vfs, nowMs: () => Date.now(), screen: withholdSecrets,
        failures: () => ({ count: 0, lastCode: null, lastAt: null }) }, { action: 'forget' })
      expect(itself).toMatchObject({ ok: false, code: 'MEMORY_ACTION_INVALID' })
      expect(host.world()).toEqual(before)
    }
  })
})
