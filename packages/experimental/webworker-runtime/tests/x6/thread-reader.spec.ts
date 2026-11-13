/**
 * `x6_threads` (A4, R8), a bounded, tail-first, read-only reader of every thread in this
 * browser. Made-up content only. Proves: discovery the way the app's session list finds threads (voice and blank threads
 * marked, not hidden; private folder never opened); only his and her words leave (tool calls by name, no tool results,
 * no reasoning, no voice framing); secret-shaped runs withheld; an explicit action; every answer within its byte bound;
 * nothing written, no fetch, no read buffer changed; and on a 120 MiB sparse thread `tail` and `search` stay within their
 * byte budgets (bytes read are asserted, not wall clock).
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  discoverThreads, readThreads, registerThreadTools, THREAD_ACTIONS, THREAD_LIMITS, threadStoreView, VOICE_THREAD_TITLE,
  type ThreadStoreView,
} from '../../src/x6/thread-reader.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ROOT = '/dsh/home/sessions'
const NOW = 1_763_000_000_000
const PRIVATE_MARKER = 'synthetic-private-folder-words'
const RESULT_MARKER = 'synthetic-tool-result-body'
const REASONING_MARKER = 'synthetic-hidden-reasoning'
const SYSTEM_MARKER = 'synthetic-system-prompt-body'
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq\n-----END PRIVATE KEY-----'
const NSEC = 'nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqh0p9x'
const SK = 'sk-made-up-0123456789abcdefABCDEF'
const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w'
const HEX = 'a3f1c2d4e5b6a7980a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'

type Event = Record<string, unknown>
let seq = 0
const ev = (type: string, data: unknown, time = NOW - 60_000): Event => ({ type, seq: seq++, time, data })
const header = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'session', version: 4, id, createdAt: NOW - 3_600_000, cwd: '/dsh/home/auma', isSeeded: false, delegationDepth: 0, ...extra })
const userMsg = (text: string | string[], kind = 'user') => ({ id: `m${String(seq)}`, role: 'user',
  content: (Array.isArray(text) ? text : [text]).map(item => ({ type: 'text', text: item })), source: { kind } })
const herMsg = (turn: number, text: string, tools: string[] = []) => ({ turn, step: 0, stream: [{ t: 0, d: 'stream-bytes' }], message: {
  id: `a${String(seq)}`, role: 'assistant', source: { kind: 'model' },
  content: [{ type: 'reasoning', text: REASONING_MARKER }, { type: 'text', text }, ...tools.map((name, i) => ({ type: 'tool-call', id: `c${String(i)}`, name, arguments: `{"path":"${RESULT_MARKER}"}` }))] } })

/** One whole turn as Session writes it. */
function turn(n: number, he: string | string[], she: string, tools: string[] = [], time = NOW - 60_000): Event[] {
  return [
    ev('turn/start', { turn: n }, time),
    ev('user/message', userMsg(he), time),
    ev('system/message', { turn: n, step: 0, message: { id: 's', role: 'system', content: [{ type: 'text', text: SYSTEM_MARKER }], source: { kind: 'system-prompt' } } }, time),
    ev('assistant/message', herMsg(n, she, tools), time + 1000),
    ...tools.map((name, i) => ev('tool/call', { turn: n, step: 0, callId: `c${String(i)}`, name, arguments: '{}' }, time + 1100)),
    ...tools.map((_, i) => ev('tool/result', { turn: n, step: 0, message: { id: `r${String(i)}`, role: 'tool', toolCallId: `c${String(i)}`, content: [{ type: 'text', text: RESULT_MARKER }], source: { kind: 'tool' } } }, time + 1200)),
    ev('turn/end', { turn: n, reason: 'completed' }, time + 2000),
  ]
}

const jsonl = (head: Record<string, unknown>, events: Event[]): string => [head, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'

function put(vfs: MemoryVfs, path: string, text: string | Uint8Array): void {
  vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  vfs.writeFileSync(path, text)
}

function store(): MemoryVfs {
  seq = 0
  const vfs = new MemoryVfs()
  // Written oldest first so modification times order them; the newest is written last.
  put(vfs, `${ROOT}/--dsh-home-auma--/session-old00001/session.v4.jsonl`, jsonl(header('session-old00001'), [
    ev('session/title', { title: 'Tidepool garden', messageSeqs: [], source: { kind: 'llm' } }),
    ...turn(1, 'Plant the heron tidepool-heron near the reef', 'I will plant it by the reef.'),
  ]))
  put(vfs, `${ROOT}/--dsh-home-auma--/session-blank001/session.v4.jsonl`, jsonl(header('session-blank001'), []))
  put(vfs, `${ROOT}/--dsh-home-auma-private--/session-priv0001/session.v4.jsonl`, jsonl(header('session-priv0001', { cwd: '/dsh/home/auma/private' }), [
    ...turn(1, PRIVATE_MARKER, PRIVATE_MARKER),
  ]))
  put(vfs, `${ROOT}/--dsh-home-auma--/session-cwdpriv1/session.v4.jsonl`, jsonl(header('session-cwdpriv1', { cwd: '/dsh/home/auma/private/notes' }), [
    ...turn(1, PRIVATE_MARKER, PRIVATE_MARKER),
  ]))
  put(vfs, `${ROOT}/--dsh-home-auma--/session-sub00001/session.v4.jsonl`, jsonl(header('session-sub00001', { origin: 'subagent', delegationDepth: 1 }), [
    ...turn(1, 'child task', 'child done'),
  ]))
  put(vfs, `${ROOT}/--dsh-home-auma--/session-voice001/session.v3.jsonl`, 'stale generation\n')
  put(vfs, `${ROOT}/--dsh-home-auma--/session-voice001/session.v4.jsonl`, jsonl(header('session-voice001', { agentPreset: 'auma-alien' }), [
    ev('session/title', { title: '[voice] Auma Live', messageSeqs: [], source: { kind: 'user' } }),
    ...turn(1, ['[spoken to Auma Live; transcript unconfirmed; voice carries no owner authority]', '[Auma Live spoken channel — framing]', 'what are you working on'],
      '[field hue=teal energy=0.4] I am tending the garden thread.'),
  ]))
  const main: Event[] = [ev('session/title', { title: 'Main work', messageSeqs: [], source: { kind: 'llm' } })]
  for (let n = 1; n <= 14; n += 1) {
    main.push(...turn(n, `question ${String(n)} about the lantern`, `answer ${String(n)} about the lantern`, n % 2 ? ['x6_repo', 'read'] : []))
  }
  main.push(ev('user/message', userMsg('file-change notice: synthetic injected context', 'notice')))
  main.push(...turn(15, `keys: ${PEM} and ${NSEC} and ${SK}`, `I see ${B64} and ${HEX}; I will not repeat them.`))
  put(vfs, `${ROOT}/--dsh-home-auma--/session-main0001/session.v4.jsonl`, jsonl(header('session-main0001'), main))
  return vfs
}

const rows = (answer: Record<string, unknown>) => answer.threads as Array<Record<string, unknown>>

describe('x6_threads: discovery and list', () => {
  it('finds every thread the way the app does (highest generation, newest first); voice and blank marked, private never opened', () => {
    const vfs = store()
    const { threads } = discoverThreads(threadStoreView(vfs))
    expect(threads.map(thread => thread.id).sort()).toEqual(['session-blank001', 'session-cwdpriv1', 'session-main0001', 'session-old00001',
      'session-priv0001', 'session-sub00001', 'session-voice001'])
    expect(threads.find(thread => thread.id === 'session-voice001')?.path).toMatch(/session\.v4\.jsonl$/)
    expect(threads.find(thread => thread.id === 'session-priv0001')).toMatchObject({ withheld: 'private', path: null })

    const answer = readThreads(threadStoreView(vfs), { action: 'list' }, NOW)
    expect(answer).toMatchObject({ ok: true, action: 'list', readOnly: true, voiceAuthority: 'none', total: 7, listed: 7 })
    const byId: Record<string, Record<string, unknown>> = Object.fromEntries(rows(answer).map(row => [String(row.id), row]))
    expect(byId['session-voice001']).toMatchObject({ voice: true, title: '[voice] Auma Live', he: 'what are you working on', she: 'I am tending the garden thread.' })
    expect(byId['session-blank001']).toMatchObject({ blank: true })
    expect(byId['session-sub00001']).toMatchObject({ subagent: true })
    expect(byId['session-old00001']).toMatchObject({ title: 'Tidepool garden', he: 'Plant the heron tidepool-heron near the reef' })
    expect(byId['session-priv0001']).toMatchObject({ withheld: 'private' })
    expect(byId['session-cwdpriv1']).toMatchObject({ withheld: 'private' })
    const text = JSON.stringify(answer)
    expect(text).not.toContain(PRIVATE_MARKER)
    expect(text).not.toContain('stale generation')
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.listAnswerBytes)
    for (const row of rows(answer)) {
      for (const key of ['he', 'she'] as const) {
        const line = row[key]
        if (typeof line === 'string') expect(line.length).toBeLessThanOrEqual(THREAD_LIMITS.listLineChars)
      }
    }
  })

  it('lists at most 50 threads and keeps the answer within 6 KiB', () => {
    seq = 0
    const vfs = new MemoryVfs()
    for (let i = 0; i < 70; i += 1) {
      const id = `session-${String(i).padStart(8, '0')}`
      put(vfs, `${ROOT}/--dsh-home-auma--/${id}/session.v4.jsonl`, jsonl(header(id), [
        ev('session/title', { title: `Thread ${String(i)} ${'w'.repeat(100)}`, messageSeqs: [], source: { kind: 'llm' } }),
        ...turn(1, `he says ${'long words '.repeat(40)}`, `she says ${'long words '.repeat(40)}`)]))
    }
    const answer = readThreads(threadStoreView(vfs), { action: 'list' }, NOW)
    expect(answer).toMatchObject({ ok: true, total: 70, more: 20 })
    expect(rows(answer).length).toBeLessThanOrEqual(THREAD_LIMITS.listThreads)
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.listAnswerBytes)
    expect(answer.trimmed).toBeDefined()
  })

  /** 50 threads of about 600 KiB, each titled in its head (never in its 64 KiB tail); the oldest is the voice thread. */
  function largeStore(): MemoryVfs {
    seq = 0
    const vfs = new MemoryVfs()
    const filler: Event[] = []
    for (let n = 1; n <= 500; n += 1) filler.push(...turn(n, `he asks about stones ${'s'.repeat(400)}`, `she answers about stones ${'t'.repeat(400)}`))
    const body = filler.map(row => JSON.stringify(row)).join('\n') + '\n'
    expect(body.length).toBeGreaterThan(THREAD_LIMITS.headerBytes + THREAD_LIMITS.listTailBytes + 512 * 1024)
    for (let i = 0; i < 50; i += 1) {
      const id = i === 0 ? 'session-zvoice00' : `session-big${String(i).padStart(5, '0')}`
      const title = i === 0 ? VOICE_THREAD_TITLE : `Large ${String(i)}`
      put(vfs, `${ROOT}/--dsh-home-auma--/${id}/session.v4.jsonl`,
        `${JSON.stringify(header(id))}\n${JSON.stringify(ev('session/title', { title, messageSeqs: [], source: { kind: 'llm' } }))}\n${body}`)
    }
    return vfs
  }

  it('lists 50 large threads titled near the head: every row has its title or says it was not read; the voice thread is marked', () => {
    const answer = readThreads(threadStoreView(largeStore()), { action: 'list' }, NOW)
    expect(answer).toMatchObject({ ok: true, total: 50, listed: 50 })
    for (const row of rows(answer)) expect({ id: row.id, titled: typeof row.title === 'string' || row.notRead === 'budget' }).toEqual({ id: row.id, titled: true })
    expect(rows(answer).every(row => typeof row.title === 'string')).toBe(true)
    expect(rows(answer).find(row => row.id === 'session-zvoice00')).toMatchObject({ title: VOICE_THREAD_TITLE, voice: true })
    expect(Number(answer.bytesRead)).toBeLessThanOrEqual(THREAD_LIMITS.listTotalBytes)
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.listAnswerBytes)
    // The arithmetic: 50 x (4 KiB header + 64 KiB tail + 256 KiB title probe) = 16,200 KiB, within the 16 MiB budget.
    expect(THREAD_LIMITS.listThreads * (THREAD_LIMITS.headerBytes + THREAD_LIMITS.listTailBytes + THREAD_LIMITS.listTitleProbeBytes))
      .toBeLessThanOrEqual(THREAD_LIMITS.listTotalBytes)
  })

  it('a title past the full head probe and outside the tail says titleNotRead: probe; a thread read end to end with no title is plainly untitled', () => {
    seq = 0
    const vfs = new MemoryVfs()
    const fill = (from: number, bytes: number): string => {
      const lines: string[] = []
      let size = 0
      for (let n = from; size < bytes; n += 1) {
        for (const row of turn(n, `he asks about shells ${'s'.repeat(400)}`, `she answers about shells ${'t'.repeat(400)}`)) {
          const line = JSON.stringify(row)
          lines.push(line)
          size += line.length + 1
        }
      }
      return lines.join('\n') + '\n'
    }
    // A thread whose first message carried a large paste: its title row sits about 300 KiB in, in a 1 MiB file.
    const before = `${JSON.stringify(header('session-deep0001'))}\n${fill(1, 300 * 1024)}`
    const titleRow = `${JSON.stringify(ev('session/title', { title: 'Deep shell title', messageSeqs: [], source: { kind: 'llm' } }))}\n`
    const deep = before + titleRow + fill(1000, 700 * 1024)
    expect(before.length).toBeGreaterThan(THREAD_LIMITS.listTitleProbeBytes)
    expect(deep.length - before.length).toBeGreaterThan(THREAD_LIMITS.listTailBytes)
    put(vfs, `${ROOT}/--dsh-home-auma--/session-deep0001/session.v4.jsonl`, deep)
    // A large thread with no title anywhere: its middle was never read, so it is not called untitled either.
    put(vfs, `${ROOT}/--dsh-home-auma--/session-none0001/session.v4.jsonl`, `${JSON.stringify(header('session-none0001'))}\n${fill(1, 1024 * 1024)}`)
    // A thread where the head probe and the tail window meet (neither alone is the whole file): read end to end, it truly
    // has no title.
    const small = `${JSON.stringify(header('session-small001'))}\n${fill(1, 290 * 1024)}`
    expect(small.length).toBeLessThan(THREAD_LIMITS.listTitleProbeBytes + THREAD_LIMITS.listTailBytes)
    expect(small.length).toBeGreaterThan(THREAD_LIMITS.listTitleProbeBytes)
    put(vfs, `${ROOT}/--dsh-home-auma--/session-small001/session.v4.jsonl`, small)
    const byId: Record<string, Record<string, unknown>> = Object.fromEntries(
      rows(readThreads(threadStoreView(vfs), { action: 'list' }, NOW)).map(row => [String(row.id), row]))
    expect(byId['session-deep0001']).toMatchObject({ title: null, titleNotRead: 'probe' })
    expect(byId['session-none0001']).toMatchObject({ title: null, titleNotRead: 'probe' })
    expect(byId['session-small001']?.title).toBeNull()
    expect(byId['session-small001']?.titleNotRead).toBeUndefined()
    expect(byId['session-small001']?.notRead).toBeUndefined()
    // `tail` probes 512 KiB for one thread: it finds the title at 300 KiB.
    expect(readThreads(threadStoreView(vfs), { action: 'tail', thread: 'session-deep0001', turns: 1 }, NOW))
      .toMatchObject({ thread: { title: 'Deep shell title' } })
  })

  it('when the budget is spent before a thread is read, that row and every row after it say notRead: budget', () => {
    const vfs = largeStore()
    const counter = { bytes: 0 }
    const base = THREAD_LIMITS.headerBytes + THREAD_LIMITS.listTailBytes
    // A budget (callers may lower it, never raise it) that holds five threads' header and tail and nothing more.
    const answer = readThreads(threadStoreView(vfs, counter), { action: 'list' }, NOW, { listTotalBytes: 5 * base })
    const listed = rows(answer)
    expect(listed).toHaveLength(50)
    const first = listed.findIndex(row => row.notRead === 'budget')
    expect(first).toBe(5)
    for (const row of listed.slice(first)) {
      expect(row).toMatchObject({ notRead: 'budget' })
      expect(row.title).toBeUndefined()
      expect(row.he).toBeUndefined()
    }
    // The five that were read had no budget left for a head probe, and say so instead of looking untitled.
    for (const row of listed.slice(0, first)) expect(row).toMatchObject({ title: null, titleNotRead: 'budget' })
    expect(counter.bytes).toBeLessThanOrEqual(5 * base)
    expect(listed.find(row => row.id === 'session-zvoice00')).toMatchObject({ notRead: 'budget' })
    // A larger figure is clamped to the built-in budget.
    const clamped = readThreads(threadStoreView(vfs), { action: 'list' }, NOW, { listTotalBytes: 1e12 })
    expect(Number(clamped.bytesRead)).toBeLessThanOrEqual(THREAD_LIMITS.listTotalBytes)
  })
})

describe('x6_threads: tail', () => {
  it('returns his and her words only: tool calls by name, no results, reasoning, system prompt or injected notices', () => {
    const vfs = store()
    const answer = readThreads(threadStoreView(vfs), { action: 'tail', thread: 'session-main' }, NOW)
    expect(answer).toMatchObject({ ok: true, action: 'tail', thread: { id: 'session-main0001', title: 'Main work' } })
    const turns = answer.turns as Array<Record<string, unknown>>
    expect(turns).toHaveLength(THREAD_LIMITS.tailDefaultTurns)
    expect(turns.map(item => item.turn)).toEqual([10, 11, 12, 13, 14, 15])
    expect(turns.find(item => item.turn === 13)).toMatchObject({ he: 'question 13 about the lantern', she: 'answer 13 about the lantern', tools: ['x6_repo', 'read'] })
    expect(turns.find(item => item.turn === 12)?.tools).toBeUndefined()
    const text = JSON.stringify(answer)
    for (const marker of [RESULT_MARKER, REASONING_MARKER, SYSTEM_MARKER, 'synthetic injected context', 'stream-bytes']) expect(text).not.toContain(marker)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.tailAnswerBytes)
  })

  it('clamps turns to 12, removes the voice framing, and refuses private, unknown and ambiguous threads in words', () => {
    const vfs = store()
    const view = threadStoreView(vfs)
    const many = readThreads(view, { action: 'tail', thread: 'session-main0001', turns: 99 }, NOW)
    expect((many.turns as unknown[]).length).toBe(THREAD_LIMITS.tailMaxTurns)
    expect(new TextEncoder().encode(JSON.stringify(many)).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.tailAnswerBytes)
    const voice = readThreads(view, { action: 'tail', thread: 'session-voice001' }, NOW)
    expect(voice).toMatchObject({ thread: { voice: true }, turns: [{ turn: 1, he: 'what are you working on', she: 'I am tending the garden thread.', spoken: true }] })
    expect(JSON.stringify(voice)).not.toContain('framing')
    expect(readThreads(view, { action: 'tail', thread: 'session-priv0001' })).toMatchObject({ ok: false, code: 'THREAD_PRIVATE' })
    expect(readThreads(view, { action: 'tail', thread: 'session-cwdpriv1' })).toMatchObject({ ok: false, code: 'THREAD_PRIVATE' })
    expect(JSON.stringify(readThreads(view, { action: 'tail', thread: 'session-cwdpriv1' }))).not.toContain(PRIVATE_MARKER)
    expect(readThreads(view, { action: 'tail', thread: 'session-nope' })).toMatchObject({ ok: false, code: 'THREAD_NOT_FOUND' })
    expect(readThreads(view, { action: 'tail', thread: 'session' })).toMatchObject({ ok: false, code: 'THREAD_AMBIGUOUS' })
    expect(readThreads(view, { action: 'tail' })).toMatchObject({ ok: false, code: 'THREAD_REQUIRED' })
  })
})

describe('x6_threads: secrets, actions, read-only', () => {
  it('withholds PEM blocks, nsec1, sk- and long base64 or hex runs everywhere they could leave', () => {
    // The shape table itself lives in secret-shapes.spec.ts (one filter, shared with x6_browser_estate search).
    const vfs = store()
    const view = threadStoreView(vfs)
    const outputs = [
      readThreads(view, { action: 'list' }, NOW),
      readThreads(view, { action: 'tail', thread: 'session-main0001', turns: 1 }, NOW),
      readThreads(view, { action: 'search', query: 'keys' }, NOW),
      readThreads(view, { action: 'search', query: 'I see' }, NOW),
    ]
    expect((outputs[2]?.hits as unknown[]).length).toBeGreaterThan(0)
    expect((outputs[3]?.hits as unknown[]).length).toBeGreaterThan(0)
    for (const output of outputs) {
      const text = JSON.stringify(output)
      for (const piece of ['MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq', NSEC, SK, B64, HEX, NSEC.slice(0, 30), B64.slice(0, 30)]) expect(text).not.toContain(piece)
    }
    // A secret cannot be probed: searching for part of one finds nothing.
    expect(readThreads(view, { action: 'search', query: NSEC.slice(0, 20) }, NOW)).toMatchObject({ ok: true, hits: [] })
  })

  it('requires an explicit, exact action', () => {
    const view = threadStoreView(store())
    for (const args of [{}, { action: 'Tail' }, { action: ' list' }, { action: ['list'] }, { action: { name: 'list' } }, { action: 'read' }, null, 'list']) {
      expect(readThreads(view, args)).toMatchObject({ ok: false, code: 'THREADS_ACTION_REQUIRED', actions: [...THREAD_ACTIONS] })
    }
    expect(readThreads(view, { action: 'search' })).toMatchObject({ ok: false, code: 'THREADS_QUERY_INVALID' })
    expect(readThreads(view, { action: 'search', query: 'x'.repeat(129) })).toMatchObject({ ok: false, code: 'THREADS_QUERY_INVALID' })
  })

  it('writes nothing, fetches nothing and never changes a buffer a read returned', async () => {
    const vfs = store()
    const fetchSpy = vi.fn(() => { throw new Error('no fetch expected') })
    vi.stubGlobal('fetch', fetchSpy)
    const paths: string[] = []
    const walk = (dir: string) => { for (const name of vfs.readdirSync(dir).map(String)) { const path = `${dir}/${name}`; if ((vfs.statSync(path) as { isDirectory(): boolean }).isDirectory()) walk(path); else paths.push(path) } }
    walk(ROOT)
    const digest = () => paths.map(path => `${path}:${createHash('sha256').update(vfs.readFileSync(path) as Uint8Array).digest('hex')}`).join('\n')
    const before = digest()
    const mutations: unknown[] = []
    const stop = vfs.subscribe((change) => { mutations.push(change) })
    const returned: Array<{ view: Uint8Array; copy: Uint8Array }> = []
    const inner = threadStoreView(vfs)
    const watching: ThreadStoreView = {
      ...inner,
      read: (path, position, length) => {
        const view = inner.read(path, position, length)
        returned.push({ view, copy: view.slice() })
        return view
      },
    }
    const calls: Array<Record<string, unknown>> = [{ action: 'list' }, { action: 'tail', thread: 'session-main0001', turns: 12 }, { action: 'search', query: 'lantern' }, { action: 'search', query: 'heron', thread: 'session-old00001' }]
    for (const args of calls) expect(readThreads(watching, args, NOW).ok).toBe(true)
    const tool: { execute?: (args: Record<string, unknown>) => Promise<unknown> } = {}
    registerThreadTools((spec) => { Object.assign(tool, spec) }, { vfs, output: { schema: { type: 'json' } } })
    expect(await tool.execute?.({ action: 'list' })).toMatchObject({ ok: true })
    stop()
    expect(mutations).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(digest()).toBe(before)
    expect(returned.length).toBeGreaterThan(0)
    for (const { view, copy } of returned) expect(Buffer.from(view).equals(Buffer.from(copy))).toBe(true)
  })

  it('registers x6_threads with exactly three required actions', () => {
    const specs: Array<Record<string, unknown>> = []
    registerThreadTools((spec) => { specs.push(spec) }, { vfs: new MemoryVfs(), output: 'out' })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ name: 'x6_threads', output: 'out', parameters: { action: { type: 'string', required: true, enum: ['list', 'tail', 'search'] } } })
    expect(String(specs[0]?.description)).toContain('carries text from other threads')
  })
})

describe('x6_threads: search', () => {
  it('searches newest first, reports coverage per thread, and finds a phrase in an older thread', () => {
    const vfs = store()
    const answer = readThreads(threadStoreView(vfs), { action: 'search', query: 'TIDEPOOL-HERON' }, NOW)
    expect(answer).toMatchObject({ ok: true, action: 'search', hits: [{ thread: 'session-old00001', who: 'he' }] })
    const coverage = answer.coverage as Array<Record<string, unknown>>
    expect(coverage.find(row => row.id === 'session-old00001')).toMatchObject({ hits: 1 })
    expect(coverage.find(row => row.id === 'session-priv0001')).toMatchObject({ searched: 0, withheld: 'private' })
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_MARKER)
    expect(readThreads(threadStoreView(vfs), { action: 'search', query: PRIVATE_MARKER }, NOW)).toMatchObject({ hits: [] })
    // Tool results are not searched: only his and her words.
    expect(readThreads(threadStoreView(vfs), { action: 'search', query: RESULT_MARKER }, NOW)).toMatchObject({ hits: [] })
  })

  it('stops at 12 hits of at most 200 characters and keeps the answer within 6 KiB', () => {
    const vfs = store()
    const answer = readThreads(threadStoreView(vfs), { action: 'search', query: 'lantern' }, NOW)
    const hits = answer.hits as Array<{ snippet: string }>
    expect(hits).toHaveLength(THREAD_LIMITS.searchHits)
    expect(answer.stoppedAt).toBe('hits')
    for (const hit of hits) expect(hit.snippet.length).toBeLessThanOrEqual(THREAD_LIMITS.searchSnippetChars + 1)
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.searchAnswerBytes)
  })
})

/**
 * A sparse 120 MiB thread: bytes are generated for whatever range is read, never stored. Each block is one whole turn of
 * fixed length with its own turn number, so any window holds real, distinct turns.
 */
function sparseView(base: MemoryVfs,
  options: { size: number; lastLineBytes?: number }): { view: ThreadStoreView; counter: { bytes: number }; path: string } {
  const path = `${ROOT}/--dsh-home-auma--/session-huge0001/session.v4.jsonl`
  const enc = new TextEncoder()
  const head = enc.encode(JSON.stringify(header('session-huge0001')) + '\n')
  const block = (index: number): Uint8Array => {
    const n = String(index).padStart(9, '0')
    const rows = [
      { type: 'turn/start', seq: 0, time: NOW, data: { turn: Number(n) } },
      { type: 'user/message', seq: 0, time: NOW, data: { id: 'm', role: 'user', content: [{ type: 'text', text: `big thread question ${n}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 0, time: NOW, data: { turn: Number(n), step: 0, stream: [], message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `big thread answer ${n}` }] } } },
      { type: 'turn/end', seq: 0, time: NOW, data: { turn: Number(n), reason: 'completed' } },
    ]
    const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    return enc.encode(text.padEnd(1024 - 1, ' ').slice(0, 1023) + '\n')
  }
  const blockBytes = 1024
  const lastLine = options.lastLineBytes ? enc.encode(JSON.stringify({ type: 'assistant/message', seq: 0, time: NOW, data: { turn: 999_999_999, step: 0, stream: [], message: { id: 'z', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'h'.repeat(options.lastLineBytes) }] } } }) + '\n') : new Uint8Array()
  const bodyEnd = options.size - lastLine.byteLength
  const byteAt = (position: number): number => {
    if (position < head.byteLength) return head[position] as number
    if (position >= bodyEnd) return lastLine[position - bodyEnd] as number
    const offset = position - head.byteLength
    return (block(Math.floor(offset / blockBytes))[offset % blockBytes]) as number
  }
  const counter = { bytes: 0 }
  const inner = threadStoreView(base)
  const newest = Date.now() + 60_000
  const view: ThreadStoreView = {
    list: (dir) => {
      const names = [...inner.list(dir)]
      if (dir === `${ROOT}/--dsh-home-auma--` && !names.includes('session-huge0001')) names.push('session-huge0001')
      if (dir === `${ROOT}/--dsh-home-auma--/session-huge0001`) return ['session.v4.jsonl']
      if (dir === ROOT && !names.includes('--dsh-home-auma--')) names.push('--dsh-home-auma--')
      return names
    },
    stat: (target) => {
      if (target === path) return { size: options.size, mtimeMs: newest, dir: false }
      if (target === `${ROOT}/--dsh-home-auma--/session-huge0001`) return { size: 0, mtimeMs: newest, dir: true }
      return inner.stat(target)
    },
    read: (target, position, length) => {
      if (target !== path) { const out = inner.read(target, position, length); counter.bytes += out.byteLength; return out }
      const end = Math.min(options.size, position + length)
      const out = new Uint8Array(Math.max(0, end - position))
      // Fill by blocks for speed.
      let at = position
      while (at < end) {
        if (at < head.byteLength || at >= bodyEnd) { out[at - position] = byteAt(at); at += 1; continue }
        const offset = at - head.byteLength
        const index = Math.floor(offset / blockBytes)
        const bytes = block(index)
        const from = offset % blockBytes
        const take = Math.min(blockBytes - from, end - at, bodyEnd - at)
        out.set(bytes.subarray(from, from + take), at - position)
        at += take
      }
      counter.bytes += out.byteLength
      return out
    },
  }
  return { view, counter, path }
}

describe('x6_threads on a 120 MiB thread (sparse)', () => {
  const SIZE = 120 * 1024 * 1024

  it('tail reads only the newest window: the last 6 turns from at most 256 KiB of lines', () => {
    const { view, counter } = sparseView(store(), { size: SIZE })
    const answer = readThreads(view, { action: 'tail', thread: 'session-huge0001' }, NOW)
    const turns = answer.turns as Array<Record<string, unknown>>
    expect(turns).toHaveLength(6)
    expect(String(turns.at(-1)?.he)).toMatch(/^big thread question \d{9}$/)
    // No title in the tail nor in the 512 KiB head probe, and the middle was never read: it says so.
    expect(answer.thread).toMatchObject({ title: null, titleNotRead: 'probe' })
    expect((answer.coverage as { bytesRead: number }).bytesRead).toBeLessThanOrEqual(THREAD_LIMITS.tailFirstBytes)
    // Plus the header and, because no title is in the tail, one byte scan of the head for it.
    expect(counter.bytes).toBeLessThanOrEqual(THREAD_LIMITS.tailFirstBytes + THREAD_LIMITS.headerBytes + THREAD_LIMITS.tailTitleProbeBytes)
  })

  it('tail doubles its window past a 3 MiB last line and never reads more than 4 MiB of lines', () => {
    const { view, counter } = sparseView(store(), { size: SIZE, lastLineBytes: 3 * 1024 * 1024 })
    const answer = readThreads(view, { action: 'tail', thread: 'session-huge0001', turns: 12 }, NOW)
    const coverage = answer.coverage as { bytesRead: number; reachedStart: boolean }
    expect(coverage.bytesRead).toBeGreaterThan(3 * 1024 * 1024)
    expect(coverage.bytesRead).toBeLessThanOrEqual(THREAD_LIMITS.tailMaxBytes)
    expect(coverage.reachedStart).toBe(false)
    expect(counter.bytes).toBeLessThanOrEqual(THREAD_LIMITS.tailMaxBytes + THREAD_LIMITS.headerBytes + THREAD_LIMITS.tailTitleProbeBytes)
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(THREAD_LIMITS.tailAnswerBytes)
  })

  it('search reads the newest 4 MiB of the huge thread, skips its remainder and goes on to find the phrase in an older thread', () => {
    const { view, counter } = sparseView(store(), { size: SIZE })
    const answer = readThreads(view, { action: 'search', query: 'tidepool-heron' }, NOW)
    expect(answer.hits).toEqual([expect.objectContaining({ thread: 'session-old00001', who: 'he' })])
    const coverage = answer.coverage as Array<Record<string, unknown>>
    expect(coverage[0]).toMatchObject({ id: 'session-huge0001', bytes: SIZE, searched: THREAD_LIMITS.searchFileBytes, partial: true })
    expect(Number(answer.bytesRead)).toBeLessThanOrEqual(THREAD_LIMITS.searchTotalBytes)
    expect(counter.bytes).toBeLessThanOrEqual(THREAD_LIMITS.searchTotalBytes)
    expect(counter.bytes).toBeLessThan(THREAD_LIMITS.searchFileBytes + 1024 * 1024)
  })

  it('list reads at most its tail window and title probe for the huge thread', () => {
    const { view, counter } = sparseView(store(), { size: SIZE })
    const answer = readThreads(view, { action: 'list' }, NOW)
    expect(rows(answer)[0]).toMatchObject({ id: 'session-huge0001', bytes: SIZE })
    expect(String(rows(answer)[0]?.he)).toMatch(/^big thread question/)
    expect(Number(answer.bytesRead)).toBeLessThanOrEqual(THREAD_LIMITS.listTotalBytes)
    expect(counter.bytes).toBeLessThanOrEqual(THREAD_LIMITS.listTotalBytes)
  })
})
