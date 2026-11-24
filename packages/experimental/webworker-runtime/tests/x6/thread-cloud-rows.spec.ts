// CARD 3a: a reader lists what her cloud's index holds, with the index's own
// title, and her writer sends that title with every append. These cases pin the two halves that can be checked without
// a browser: the index row's title survives parsing, and the append header carries the newest title and words.
import { describe, expect, it } from 'vitest'
import { cloudRows, parseIndexPage, threadMetaHeader, THREAD_SYNC_LIMITS, type ThreadSyncLimits } from '../../src/storage/thread-sync.ts'
import type { ThreadNetReply, ThreadStore } from '../../src/storage/thread-store-types.ts'

const limits: ThreadSyncLimits = { ...THREAD_SYNC_LIMITS }

const hex = (n: number): string => n.toString(16).padStart(64, '0')
const at = (id: string): string => `/dsh/home/sessions/auma/${id}/session.v4.jsonl`

const answer = (body: unknown): Pick<ThreadNetReply, 'status' | 'bytes'> => ({
  status: 200,
  bytes: new TextEncoder().encode(JSON.stringify(body)),
})

/** A store holding exactly the journals it is given, at those sizes; nothing else exists. */
const store = (files: Record<string, number>): ThreadStore => ({
  existsSync: (path: string) => path in files,
  statSync: (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`)
    return { isFile: () => true, size: files[path] }
  },
  readFileSync: () => new Uint8Array(0),
  seed: () => undefined,
})

const line = (type: string, data: Record<string, unknown>): string => `${JSON.stringify({ type, data })}\n`
const span = (...rows: string[]): Uint8Array => new TextEncoder().encode(rows.join(''))

/** The header's payload, decoded the way the edge decodes it (base64url without padding). */
function payload(headers: Record<string, string>): Record<string, unknown> | null {
  const value = headers['x-thread-meta']
  if (value === undefined) return null
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  // The header carries UTF-8 bytes, base64url'd; her edge reads them back as UTF-8, so decode the same way here
  // (`atob` alone hands back one char per byte, which turns "✨" into mojibake and would test the wrong thing).
  const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

describe('the index row carries the title', () => {
  it('keeps the title and the preview the row states', () => {
    const page = parseIndexPage(answer({
      sync: 'on',
      threads: [{ id: hex(1), path: at('one'), bytes: 10, activeAt: 5, title: 'Long thread ✨', preview: 'the words' }],
    }))
    expect(page?.threads[0]?.title).toBe('Long thread ✨')
    expect(page?.threads[0]?.preview).toBe('the words')
    expect(page?.threads[0]?.activeAt).toBe(5)
  })

  it('drops control characters and cuts a title to what the lane may show', () => {
    const page = parseIndexPage(answer({
      sync: 'on',
      threads: [{ id: hex(2), path: at('two'), bytes: 1, title: `a\u0000b\nc ${'x'.repeat(400)}` }],
    }))
    const title = page?.threads[0]?.title ?? ''
    expect(title.length).toBeLessThanOrEqual(200)
    expect(title.startsWith('abc')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
    expect(/[\u0000-\u001f]/u.test(title)).toBe(false)
  })

  it('a row the edge has no title for reads null, not an empty name', () => {
    const page = parseIndexPage(answer({ sync: 'on', threads: [{ id: hex(3), path: at('three'), bytes: 1 }] }))
    expect(page?.threads[0]?.title).toBeNull()
    expect(page?.threads[0]?.preview).toBeNull()
  })
})

describe('every index row becomes a row for the lane', () => {
  const entry = (id: string, bytes: number, extra: { title?: string; activeAt?: number; updatedAt?: number } = {}) => ({
    id, path: at(id), bytes, ...extra,
  })

  it('a conversation this browser has no journal for is listed, with her cloud count and no local size', () => {
    const rows = cloudRows([entry(hex(4), 190_000_000, { title: 'Long thread ✨' })], limits, store({}))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.bytes).toBe(190_000_000)
    expect(rows[0]?.local).toBeNull()
    expect(rows[0]?.long).toBe(rows[0]?.bytes! > limits.readerMaxThreadBytes)
  })

  it('a copy here is measured, so a smaller one can be marked an older copy', () => {
    const path = at(hex(5))
    const rows = cloudRows([entry(hex(5), 100)], limits, store({ [path]: 40 }))
    expect(rows[0]?.local).toBe(40)
    expect(rows[0]?.long).toBe(false)
  })

  it('a stat that throws leaves the row in the list with no local size', () => {
    const path = at(hex(6))
    const hostile: ThreadStore = {
      existsSync: () => true,
      statSync: () => { throw new Error('EIO') },
      readFileSync: () => new Uint8Array(0),
      seed: () => undefined,
    }
    const rows = cloudRows([entry(hex(6), 100)], limits, store({ [path]: 1 }))
    expect(rows[0]?.local).toBe(1)
    expect(cloudRows([entry(hex(6), 100)], limits, hostile)[0]?.local).toBeNull()
  })

  it('the time her cloud states is the row time, and an older row falls back to updatedAt', () => {
    const rows = cloudRows([
      entry(hex(7), 1, { activeAt: 9 }),
      entry(hex(8), 1, { updatedAt: 4 }),
    ], limits, store({}))
    expect(rows[0]?.activeAt).toBe(9)
    expect(rows[1]?.activeAt).toBe(4)
  })
})

describe('the row carries the session id from its path', () => {
  it('the <id> folder before session.vN.jsonl is the id, not the index thread id', () => {
    const rows = cloudRows([{ id: hex(9), path: at(hex(9)), bytes: 10 }], limits, store({}))
    expect(rows[0]?.id).toBe(hex(9))
  })

  it('a row this build cannot name is carried with an empty id, so the page can withhold its claim', () => {
    const rows = cloudRows([
      { id: hex(10), path: '/dsh/home/auma-one/session/messages.jsonl', bytes: 5 },
      { id: hex(11), path: '/dsh/home/sessions/--dsh-home-auma-private--/session-x/session.v4.jsonl', bytes: 5 },
    ], limits, store({}))
    expect(rows.map(row => row.id)).toEqual(['', ''])
  })

  it('a ~XXXX segment is decoded back to its character', () => {
    const rows = cloudRows([{ id: hex(12), path: '/dsh/home/sessions/auma/session~002D1/session.v4.jsonl', bytes: 5 }], limits, store({}))
    expect(rows[0]?.id).toBe('session-1')
  })
})

describe('the append header her writer sends', () => {
  it('carries the newest title and the newest words in the span being appended', () => {
    const head = threadMetaHeader(span(
      line('session/title', { title: 'first name' }),
      line('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] }),
      line('session/title', { title: 'Long thread ✨' }),
    ), 1_700_000_000_000)
    const meta = payload(head)
    expect(meta?.title).toBe('Long thread ✨')
    expect(meta?.preview).toBe('hello there')
    expect(meta?.activeAt).toBe(1_700_000_000_000)
  })

  it('is base64url only and inside the edge header budget', () => {
    const value = threadMetaHeader(span(
      line('session/title', { title: 'é'.repeat(300) }),
      line('assistant/message', { content: [{ type: 'text', text: 'y'.repeat(400) }] }),
    ), 5)['x-thread-meta'] ?? ''
    expect(value.length).toBeLessThanOrEqual(4096)
    expect(/^[A-Za-z0-9_-]+$/u.test(value)).toBe(true)
  })

  it('takes her own row time for activeAt, so a span written long ago is not called active now', () => {
    const old = 1_700_000_000_000 - 60_000
    const head = threadMetaHeader(new TextEncoder().encode(
      `{"type":"assistant/message","time":${String(old)},"data":{"content":[{"type":"text","text":"old words"}]}}\n`,
    ), 1_700_000_000_000)
    expect(payload(head)?.activeAt).toBe(old)
  })

  it('a span with no title and no words sends only its time, so her cloud keeps the title it has', () => {
    const meta = payload(threadMetaHeader(span(line('turn/end', {})), 11))
    expect(meta).toEqual({ activeAt: 11 })
  })

  it('a span of nothing but noise still yields a valid header', () => {
    const head = threadMetaHeader(new TextEncoder().encode('{"type":"x"\nnot a row\n'), 3)
    expect(payload(head)).toEqual({ activeAt: 3 })
  })
})
