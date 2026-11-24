/**
 * The page's half (client/reader-window.ts): the page marks itself a reader only on its
 * OWN worker's word, clears the mark on any other role, and clears an old mark when it starts.
 */
import { describe, expect, it } from 'vitest'
import {
  mintPageId, READER_WINDOW_COOKIE, READER_WINDOW_GLOBAL, servedThreadSync, startPageThreadSync, startReaderWindow, THREAD_SYNC_META,
  THREAD_SYNC_PAGE_GLOBAL, type ThreadSyncDocument,
} from '../../src/client/reader-window.ts'
import { WorkerTunnel } from '../../src/client/client.ts'

function fakes() {
  const cookies: string[] = []
  const posted: unknown[] = []
  const listeners: Array<(event: { data: unknown }) => void> = []
  let closed = false
  const global: Record<string, unknown> = {}
  const scope = {
    global, setCookie: (cookie: string) => { cookies.push(cookie) },
    channel: () => ({ postMessage: (message: unknown) => { posted.push(message) }, addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void) => { listeners.push(listener) }, close: () => { closed = true } }),
  }
  const deliver = (data: unknown) => { for (const listener of listeners) listener({ data }) }
  return { cookies, posted, global, scope, deliver, closed: () => closed }
}
const READER = 'Reading an older copy of her from her cloud. She answers in the browser that holds her home. Nothing typed here is saved.'

describe('reader-window: the page marks itself only on its own worker\'s word', () => {
  it('the mark is the __Host- cookie her edge reads (deploy/cloudflare/src/reader-window.mjs): no other origin can set it', () => {
    expect(READER_WINDOW_COOKIE).toBe('__Host-aukora_window')
  })

  it('a page id is 32 lowercase hex characters, new each time', () => {
    const a = mintPageId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(mintPageId()).not.toBe(a)
  })

  it('starts by clearing any old mark and asks once; then reader sets the sentence and the cookie, none clears both', () => {
    const f = fakes()
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const stop = startReaderWindow(id, f.scope)
    expect(f.global[THREAD_SYNC_PAGE_GLOBAL]).toBe(id)
    expect(f.cookies).toEqual(['__Host-aukora_window=; Max-Age=0; Path=/; Secure; SameSite=Strict'])
    expect(f.global[READER_WINDOW_GLOBAL]).toBeUndefined()
    expect(f.posted).toEqual([{ v: 1, kind: 'ask', worker: id }])
    f.deliver({ v: 1, kind: 'state', at: 10, mode: 'off', role: 'reader', footer: READER, worker: id })
    expect(f.global[READER_WINDOW_GLOBAL]).toBe(READER)
    expect(f.cookies.at(-1)).toBe('__Host-aukora_window=reader; Path=/; Secure; SameSite=Strict')
    f.deliver({ v: 1, kind: 'state', at: 11, mode: 'on', role: 'none', footer: '', worker: id })
    expect(f.global[READER_WINDOW_GLOBAL]).toBeUndefined()
    expect(f.cookies.at(-1)).toBe('__Host-aukora_window=; Max-Age=0; Path=/; Secure; SameSite=Strict')
    stop()
    expect(f.closed()).toBe(true)
  })

  it('another tab\'s worker, a message with no id, an older message and a malformed one change nothing', () => {
    const f = fakes()
    const id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    startReaderWindow(id, f.scope)
    const before = f.cookies.length
    f.deliver({ v: 1, kind: 'state', at: 10, mode: 'off', role: 'reader', footer: READER, worker: 'c'.repeat(32) })
    f.deliver({ v: 1, kind: 'state', at: 10, mode: 'off', role: 'reader', footer: READER })
    f.deliver({ v: 1, kind: 'state', at: 10, mode: 'off', role: 'reader', footer: 'x\u0007', worker: id })
    f.deliver({ v: 2, kind: 'state', at: 10, mode: 'off', role: 'reader', footer: READER, worker: id })
    expect(f.cookies).toHaveLength(before)
    expect(f.global[READER_WINDOW_GLOBAL]).toBeUndefined()
    f.deliver({ v: 1, kind: 'state', at: 20, mode: 'off', role: 'reader', footer: READER, worker: id })
    f.deliver({ v: 1, kind: 'state', at: 19, mode: 'on', role: 'none', footer: '', worker: id })
    expect(f.global[READER_WINDOW_GLOBAL]).toBe(READER)
  })

  it('no BroadcastChannel: the old mark is still cleared and nothing throws', () => {
    const f = fakes()
    const stop = startReaderWindow('d'.repeat(32), { ...f.scope, channel: () => null })
    expect(f.cookies).toHaveLength(1)
    expect(() => { stop() }).not.toThrow()
  })
})

// The switch reaches the page in its boot document, and with it unset the page does nothing at all.
/** A document holding the given `<meta name="aukora-thread-sync">` contents (none: no such meta, as an old document). */
const docWith = (...contents: Array<string | null>): ThreadSyncDocument & { asked: string[] } => {
  const asked: string[] = []
  return { asked, querySelector: (selectors: string) => {
    asked.push(selectors)
    return selectors === `meta[name="${THREAD_SYNC_META}"]` && contents.length > 0 ? { getAttribute: (name: string) => (name === 'content' ? contents[0] ?? null : null) } : null
  } }
}

describe('the page reads the switch from its own boot document, synchronously, and does nothing while it is not on', () => {
  it('`on` only for the exact meta her edge adds; an old document (no meta), another word or no document is null', () => {
    expect(THREAD_SYNC_META).toBe('aukora-thread-sync')
    expect(servedThreadSync(docWith('on'))).toBe('on')
    for (const content of ['off', 'pull', 'ON', ' on', 'on ', '', null]) expect(servedThreadSync(docWith(content))).toBeNull()
    expect(servedThreadSync(docWith())).toBeNull()
    expect(servedThreadSync(null)).toBeNull()
    expect(servedThreadSync(undefined)).toBeNull()
    expect(servedThreadSync({ querySelector: () => { throw new Error('no DOM') } })).toBeNull()
  })

  it('(a, the page half) switch unset: no page id, no cookie written (no mark, not even a clear), no global, no channel, no post', () => {
    for (const served of [servedThreadSync(docWith()), servedThreadSync(docWith('pull'))]) {
      const f = fakes()
      let opened = 0
      const scope = { ...f.scope, channel: () => { opened += 1; return f.scope.channel() } }
      expect(startPageThreadSync(served, scope)).toBeUndefined()
      expect(f.cookies).toEqual([])
      expect(f.global).toEqual({})
      expect(opened).toBe(0)
      expect(f.posted).toEqual([])
    }
  })

  it('(a, the page half) switch unset: the init frame its worker gets is exactly main\'s; switched on it carries the page id and `threadSync: on`', () => {
    const sent: unknown[] = []
    const port = { addEventListener: () => {}, postMessage: (frame: unknown) => { sent.push(frame) } }
    const tunnel = new WorkerTunnel(port as unknown as Worker)
    tunnel.init('https://x.invalid/image.tar.gz', [], startPageThreadSync(servedThreadSync(docWith())))
    expect(sent).toEqual([{ t: 'init', image: 'https://x.invalid/image.tar.gz', overlays: [], features: ['boot-phase'] }])
    const f = fakes()
    const id = startPageThreadSync(servedThreadSync(docWith('on')), f.scope)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    tunnel.init('https://x.invalid/image.tar.gz', [], id)
    expect(sent[1]).toEqual({ t: 'init', image: 'https://x.invalid/image.tar.gz', overlays: [], features: ['boot-phase'], page: id, threadSync: 'on' })
    // Switched on, the reader window starts exactly as built: the old mark cleared, one ask.
    expect(f.cookies).toEqual(['__Host-aukora_window=; Max-Age=0; Path=/; Secure; SameSite=Strict'])
    expect(f.posted).toEqual([{ v: 1, kind: 'ask', worker: id }])
  })

  it('(c, the page half) an old document with no meta, whatever her edge says now: the page is as main and never marks itself', () => {
    const f = fakes()
    expect(startPageThreadSync(servedThreadSync(docWith()), f.scope)).toBeUndefined()
    f.deliver({ v: 1, kind: 'state', at: 10, mode: 'on', role: 'reader', footer: READER, worker: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(f.cookies).toEqual([])
    expect(f.global[READER_WINDOW_GLOBAL]).toBeUndefined()
  })
})
