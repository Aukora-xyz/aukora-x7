/**
 * Rule R6: a reader starts no turn and changes nothing at the edge. The `the thread sync` block at
 * the top of worker-host.ts's fetch wrapper refuses, while this page is a reader, every model door (a provider URL the
 * wrapper would send to a door, and any `/door/` URL) and every same-origin request that is not a GET or HEAD, with the
 * reader sentence, and the inner fetch is never called. Any other page goes through the wrapper exactly as before.
 *
 * The wrapper is the real one: worker-host.ts installs it on import over this worker scope's `fetch` and `location`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { READER_OLDER_FOOTER } from '../../src/storage/thread-sync.ts'

const ORIGIN = 'https://node.example.invalid'
interface Seen { input: unknown; init: RequestInit | undefined }
let seen: Seen[] = []
/** The reader gate of the module instance the wrapper reads (a fresh one per import of worker-host.ts). */
let threadReader: { footer: string | null } = { footer: null }

async function wrapped(): Promise<typeof fetch> {
  seen = []
  const inner = vi.fn(async (input: unknown, init?: RequestInit) => { seen.push({ input, init }); return new Response('inner') })
  delete (globalThis as { __x5Door?: boolean }).__x5Door
  vi.stubGlobal('location', { origin: ORIGIN, hostname: 'node.example.invalid', href: `${ORIGIN}/` })
  vi.stubGlobal('fetch', inner)
  vi.resetModules()
  await import('../../src/worker-host.ts')
  threadReader = (await import('../../src/storage/thread-sync.ts')).threadReader
  const installed = globalThis.fetch
  expect(installed).not.toBe(inner)
  return installed
}

afterEach(() => {
  threadReader.footer = null
  delete (globalThis as { __x5Door?: boolean }).__x5Door
  vi.unstubAllGlobals()
})

describe('as a reader, the wrapper refuses doors and same-origin writes with the reader sentence', () => {
  it.each([
    ['a provider URL (sent to a door)', 'https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }],
    ['a provider URL, GET', 'https://api.openai.com/v1/models', undefined],
    ['a /door/ URL', `${ORIGIN}/door/openrouter/v1/chat/completions`, { method: 'POST', body: '{}' }],
    ['a /door/ URL, GET', `${ORIGIN}/door/openai/v1/models`, undefined],
    ['a home save', `${ORIGIN}/_mirror/delta`, { method: 'POST', body: '{}' }],
    ['the lease', `${ORIGIN}/_mirror/lease`, { method: 'POST', body: '{}' }],
    ['an append', `${ORIGIN}/_thread/append?id=x&at=0&p=1`, { method: 'POST', body: 'x\n' }],
    ['her head lease', `${ORIGIN}/_head/lease`, { method: 'POST', body: '{}' }],
    ['her eyes', `${ORIGIN}/_host/eyes`, { method: 'POST', body: '{}' }],
    ['a relative same-origin PUT', '/_vault/blob/abc', { method: 'PUT', body: 'x' }],
    ['a DELETE', `${ORIGIN}/_vault/rescue/x`, { method: 'delete' }],
  ])('%s', async (_name, url, init) => {
    const wrappedFetch = await wrapped()
    threadReader.footer = READER_OLDER_FOOTER
    await expect(wrappedFetch(url, init)).rejects.toThrow(new TypeError(READER_OLDER_FOOTER))
    expect(seen).toEqual([])
  })

  it('a Request object: its own method decides, and init overrides it', async () => {
    const wrappedFetch = await wrapped()
    threadReader.footer = READER_OLDER_FOOTER
    await expect(wrappedFetch(new Request(`${ORIGIN}/_head/lease`, { method: 'POST', body: '{}' }))).rejects.toThrow(READER_OLDER_FOOTER)
    await expect(wrappedFetch(new Request(`${ORIGIN}/api/snapshot`), { method: 'POST' })).rejects.toThrow(READER_OLDER_FOOTER)
    await expect(wrappedFetch(new Request('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' }))).rejects.toThrow(READER_OLDER_FOOTER)
    expect(seen).toEqual([])
  })

  it('same-origin GET and HEAD pass, unchanged', async () => {
    const wrappedFetch = await wrapped()
    threadReader.footer = READER_OLDER_FOOTER
    const get = { method: 'GET', credentials: 'same-origin' as const }
    expect(await (await wrappedFetch(`${ORIGIN}/_thread/index?limit=200`, get)).text()).toBe('inner')
    await wrappedFetch(`${ORIGIN}/_mirror/status?compact=1`)
    await wrappedFetch(`${ORIGIN}/_head/ball`, { method: 'head' })
    expect(seen.map(call => call.input)).toEqual([`${ORIGIN}/_thread/index?limit=200`, `${ORIGIN}/_mirror/status?compact=1`, `${ORIGIN}/_head/ball`])
    expect(seen[0]?.init).toBe(get)
  })

  it('the sentence is whatever the reader footer is now (after a pull)', async () => {
    const wrappedFetch = await wrapped()
    threadReader.footer = 'Reading her from her cloud, read at 09:41. She answers in Chrome on the Mac. Nothing typed here is saved.'
    await expect(wrappedFetch('https://api.x.ai/v1/chat/completions', { method: 'POST' })).rejects.toThrow(threadReader.footer)
  })
})

describe('as a writer, or with no role, the wrapper behaves as before', () => {
  it('a provider URL goes to its door with same-origin credentials; the placeholder key is dropped', async () => {
    const wrappedFetch = await wrapped()
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{"a":1}', headers: { 'x-api-key': 'x5-edge-door' } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.input).toBe(`${ORIGIN}/door/anthropic/v1/messages`)
    expect(seen[0]?.init).toMatchObject({ method: 'POST', body: '{"a":1}', credentials: 'same-origin' })
    expect(new Headers(seen[0]?.init?.headers).has('x-api-key')).toBe(false)
  })

  it('same-origin writes and door URLs pass through untouched', async () => {
    const wrappedFetch = await wrapped()
    const save = { method: 'POST', body: '{}' }
    await wrappedFetch(`${ORIGIN}/_mirror/delta`, save)
    await wrappedFetch(`${ORIGIN}/door/openai/v1/chat/completions`, save)
    const request = new Request(`${ORIGIN}/_head/lease`, { method: 'POST', body: '{}' })
    await wrappedFetch(request)
    expect(seen).toEqual([
      { input: `${ORIGIN}/_mirror/delta`, init: save },
      { input: `${ORIGIN}/door/openai/v1/chat/completions`, init: save },
      { input: request, init: undefined },
    ])
    expect(seen[0]?.init).toBe(save)
  })
})
