/**
 * Her hand-off note stops multiplying. The runtime-context snapshot (`auma:live-state-map`) carries the
 * note whole only up to 12 KiB; a longer note is carried as its first section (at most 4 KiB, cut at a line), one
 * pointer line, and its last 8 KiB (cut forward to a line start). `auma_handoff read` gains optional `offset` and
 * `bytes`. Nothing in her home is removed or rewritten by the map.
 */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { HANDOFF_MAP_LIMITS, liveMapHandoffText, mountX6BallRuntime } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const enc = new TextEncoder()
const size = (text: string): number => enc.encode(text).length
const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)
const pointer = (note: string): string => `[hand-off note: ${String(size(note))} bytes, sha256 ${sha12(note)}; the middle `
  + 'is not shown here. Read it with auma_handoff (action read, optional offset and bytes).]'

/** A note shaped like hers: a header, a first section, then many numbered sections, entries appended at the end. */
function longNote(sections = 550): string {
  const head = '# Auma hand-off map\n\nWho I am and where things are.\n- line one\n- line two\n'
  const body: string[] = []
  for (let i = 0; i < sections; i += 1) body.push(`## Section ${String(i)}\n- entry ${String(i)}: ${'word '.repeat(40).trim()}\n`)
  return `${head}\n${body.join('\n')}\n## Latest\n- the newest entry, written last\n`
}

describe('liveMapHandoffText: what the snapshot carries of the note', () => {
  it('the limits are the brief\'s: whole up to 12 KiB, first section up to 4 KiB, last 8 KiB', () => {
    expect(HANDOFF_MAP_LIMITS).toEqual({ wholeBytes: 12 * 1024, headBytes: 4 * 1024, tailBytes: 8 * 1024 })
  })

  it('a note of 12 KiB or less is carried whole (trimmed, as before), with no pointer line', () => {
    const note = `# small map\n${'x'.repeat(12 * 1024 - 20)}\n`
    expect(size(note)).toBeLessThanOrEqual(12 * 1024)
    expect(liveMapHandoffText(note)).toBe(note.trim())
    expect(liveMapHandoffText('')).toBe('')
    expect(liveMapHandoffText('  \n')).toBe('')
  })

  it('a long note is carried as its first section, one pointer line, and its last 8 KiB from a line start', () => {
    const note = longNote()
    expect(size(note)).toBeGreaterThan(100 * 1024)
    const text = liveMapHandoffText(note)
    const firstSection = note.slice(0, note.indexOf('\n## ')).trimEnd()
    const tailStart = (() => {
      const bytes = enc.encode(note)
      let at = bytes.length - 8 * 1024
      while (at < bytes.length && bytes[at - 1] !== 0x0a) at += 1
      return new TextDecoder().decode(bytes.slice(at))
    })()
    expect(text).toBe(`${firstSection}\n\n${pointer(note)}\n\n${tailStart.trimEnd()}`)
    expect(size(text)).toBeLessThan(13 * 1024)
    expect(text).toContain('- the newest entry, written last')
    expect(text).not.toContain('## Section 1\n')
    expect(text.split('\n').filter(line => line.startsWith('[hand-off note:'))).toHaveLength(1)
  })

  it('a first section over 4 KiB is cut at a line, never mid-line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- header line ${String(i)} ${'y'.repeat(30)}`)
    const note = `# map\n${lines.join('\n')}\n## Next\n${'z\n'.repeat(20_000)}`
    const text = liveMapHandoffText(note)
    const head = text.slice(0, text.indexOf('\n\n[hand-off note:'))
    expect(size(head)).toBeLessThanOrEqual(4 * 1024)
    expect(note.startsWith(`${head}\n`)).toBe(true)
  })

  it('cuts count bytes, not characters, and never split a character', () => {
    const note = `# карта\n${'ж'.repeat(3000)}\n## Next\n${'é line\n'.repeat(3000)}`
    expect(size(note)).toBeGreaterThan(12 * 1024)
    const text = liveMapHandoffText(note)
    expect(text).not.toContain('�')
    expect(text).toContain(pointer(note))
    const tail = text.slice(text.indexOf(pointer(note)) + pointer(note).length + 2)
    expect(size(tail)).toBeLessThanOrEqual(8 * 1024)
  })

  it('a newest entry whose last line is longer than the tail is still carried (review fix), never dropped', () => {
    const latest = `## 2026-11-17 latest\n${'newest words '.repeat(800).trim()}\n`
    const note = `${longNote(100)}${latest}`
    expect(size(latest)).toBeGreaterThan(8 * 1024)
    const text = liveMapHandoffText(note)
    expect(text).not.toMatch(/\]$/)
    expect(text).toContain('newest words newest words')
    expect(text).not.toContain('�')
    const tail = text.slice(text.indexOf(pointer(note)) + pointer(note).length + 2)
    expect(size(tail)).toBeLessThanOrEqual(8 * 1024)
    expect(note.trimEnd().endsWith(tail)).toBe(true)
  })

  it('a middle edit leaves the carried text unchanged; an appended entry changes only the tail and the pointer', () => {
    const note = longNote()
    const middle = note.replace('- entry 200:', '- entry 200 (edited):')
    expect(liveMapHandoffText(middle).replace(pointer(middle), '')).toBe(liveMapHandoffText(note).replace(pointer(note), ''))
  })
})

describe('the live state map carries the cut note; her home keeps the whole note', () => {
  const HOME = '/dsh/home/auma'
  async function boot(note: string) {
    const context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime)
    const vfs = new MemoryVfs()
    vfs.mkdirSync(HOME, { recursive: true })
    vfs.writeFileSync(`${HOME}/HANDOFF.md`, note)
    const contexts = new Map<string, () => string>()
    const sys = context.get('systemPrompt') as unknown as { context(input: { name: string; text: () => string }): () => void }
    const original = sys.context.bind(sys)
    sys.context = (input) => { contexts.set(input.name, input.text); return original(input) }
    vi.stubGlobal('location', { origin: 'https://handoff-map.invalid' })
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
      if (url.origin !== 'https://handoff-map.invalid') throw new Error('External network is forbidden')
      if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: null, codeBySha: {} })
      return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
    })
    const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => dshTools } })
    await mountX6BallRuntime(context as never, vfs, loader)
    for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
    return { vfs, map: () => contexts.get('auma:live-state-map')?.() ?? '' }
  }

  it('a long note: the map holds the first section, the pointer and the tail; the file is untouched', async () => {
    const note = longNote()
    const host = await boot(note)
    const map = host.map()
    expect(map).toContain('# Auma X6.1 Live Runtime State Map')
    expect(map).toContain(liveMapHandoffText(note))
    expect(map).toContain(pointer(note))
    expect(map).not.toContain('## Section 200\n')
    expect(size(map)).toBeLessThan(16 * 1024)
    expect(host.vfs.readFileSync(`${HOME}/HANDOFF.md`, 'utf8')).toBe(note)
  })

  it('a short note: the map holds it whole, with no pointer line', async () => {
    const host = await boot('# small map\n- one\n')
    expect(host.map()).toContain('\n\n# small map\n- one')
    expect(host.map()).not.toContain('[hand-off note:')
  })
})

describe('auma_handoff read: optional offset and bytes, total size always said', () => {
  async function withNote(note: string) {
    const mounted = await mountE4()
    mounted.vfs.mkdirSync('/dsh/home/auma', { recursive: true })
    mounted.vfs.writeFileSync('/dsh/home/auma/HANDOFF.md', note)
    return (args: Record<string, unknown>) => mounted.tool('auma_handoff').execute({ action: 'read', ...args }) as Promise<Record<string, unknown>>
  }

  it('no offset and no bytes: the whole note, as today, with its total size', async () => {
    const note = longNote(50)
    const read = await withNote(note)
    expect(await read({})).toMatchObject({ ok: true, path: '/dsh/home/auma/HANDOFF.md', content: note, totalBytes: size(note), offset: 0, bytes: size(note) })
  })

  it('offset and bytes return that byte range', async () => {
    const note = longNote(50)
    const read = await withNote(note)
    const bytes = enc.encode(note)
    const expected = new TextDecoder().decode(bytes.slice(100, 600))
    expect(await read({ offset: 100, bytes: 500 }))
      .toMatchObject({ ok: true, content: expected, totalBytes: bytes.length, offset: 100, bytes: 500 })
    // Offset alone reads to the end; bytes alone reads from the start.
    expect(await read({ offset: bytes.length - 10 })).toMatchObject({ content: new TextDecoder().decode(bytes.slice(-10)), bytes: 10 })
    expect(await read({ bytes: 20 })).toMatchObject({ content: note.slice(0, 20), offset: 0, bytes: 20 })
    // A range running past the end stops at the end.
    expect(await read({ offset: bytes.length - 5, bytes: 500 }))
      .toMatchObject({ content: new TextDecoder().decode(bytes.slice(-5)), bytes: 5 })
    expect(await read({ offset: bytes.length })).toMatchObject({ ok: true, content: '', bytes: 0, totalBytes: bytes.length })
  })

  it('a range edge inside a character moves to the character boundary and says where it landed', async () => {
    const note = 'ab' + 'ж'.repeat(10)
    const read = await withNote(note)
    // 'ж' is two bytes; offset 3 is inside the first one.
    expect(await read({ offset: 3, bytes: 4 })).toMatchObject({ ok: true, content: 'ж', offset: 4, bytes: 2 })
  })

  it('a range smaller than the character at offset returns that whole character, so paging never stalls (review fix)', async () => {
    const note = '日本x'
    const read = await withNote(note)
    expect(await read({ offset: 0, bytes: 1 })).toMatchObject({ ok: true, content: '日', offset: 0, bytes: 3 })
    // Paging one byte at a time with offset += bytes reaches the end.
    let offset = 0
    const seen: string[] = []
    for (let i = 0; i < 10 && offset < size(note); i += 1) {
      const answer = await read({ offset, bytes: 1 })
      expect(answer.bytes as number).toBeGreaterThan(0)
      seen.push(answer.content as string)
      offset = (answer.offset as number) + (answer.bytes as number)
    }
    expect(seen.join('')).toBe(note)
  })

  it('out-of-bounds or malformed ranges are refused, naming the total size', async () => {
    const note = longNote(5)
    const read = await withNote(note)
    for (const args of [{ offset: -1 }, { offset: size(note) + 1 }, { offset: 1.5 }, { bytes: 0 }, { bytes: -3 }, { bytes: 2.5 }, { offset: '10' }]) {
      const answer = await read(args)
      expect(answer).toMatchObject({ ok: false, code: 'HANDOFF_RANGE_INVALID', totalBytes: size(note) })
    }
  })

  it('the description no longer says the whole note is injected, and names the new arguments', async () => {
    const mounted = await mountE4()
    const tool = mounted.tool('auma_handoff') as unknown as { description: string; parameters: Record<string, unknown> }
    expect(tool.description).not.toMatch(/automatically injected/i)
    expect(tool.description).toMatch(/first section/)
    expect(tool.description).toMatch(/last 8 KiB/)
    expect(Object.keys(tool.parameters)).toEqual(['action', 'content', 'offset', 'bytes'])
  })
})
