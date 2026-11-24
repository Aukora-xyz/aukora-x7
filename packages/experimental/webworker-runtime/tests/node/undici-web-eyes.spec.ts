/**
 * Her worker's Node `fetch` (the undici shim) goes through the web-eyes broker the edge answers,
 * `POST /_host/web-eyes {action:'fetch'}`, instead of `/api/fetch`, which only the Mac answered. The broker's limits are
 * the shim's limits, and every refusal rejects in words.
 *
 * Review: the deployment's transport is decided once, by a probe that reads no target; the Mac host is read
 * only through its raw relay, and a relay failure rejects. Its lossy web-eyes content is never returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Shim = typeof import('../../src/node/external_packages/undici.ts')

const ORIGIN = 'https://node.example.invalid'
let calls: { url: string; init: RequestInit }[]
let answer: () => Response
let shim: Shim
/** The JSON body a call sent, or null for a call without one. */
const bodyOf = (call: { init: RequestInit } | undefined): Record<string, unknown> | null =>
  typeof call?.init.body === 'string' ? JSON.parse(call.init.body) as Record<string, unknown> : null
/** The transport probe: an action neither host performs. */
const isProbe = (call: { init: RequestInit }): boolean => bodyOf(call)?.action === 'transport'
/** Every call except the transport probe. */
const reads = (): { url: string; init: RequestInit }[] => calls.filter(call => !isProbe(call))
/** The JSON body of the n-th non-probe call. */
const sent = (index: number): Record<string, unknown> => bodyOf(reads()[index]) ?? {}
/** The edge's refusal of the probe (cloud-brokers.mjs: WEB_EYES_REQUEST_INVALID, 400, macFallback: false). */
const edgeProbeAnswer = (): Response => Response.json({ ok: false, code: 'WEB_EYES_REQUEST_INVALID', macFallback: false }, { status: 400 })
/** The Mac host's refusal of the probe (server/local-host.mjs: unknown action, 400, no macFallback). */
const macProbeAnswer = (): Response => Response.json({ ok: false, error: 'Unknown /_host/web-eyes action: transport' }, { status: 400 })

beforeEach(async () => {
  calls = []
  // The edge's exact success shape (cloud-brokers.mjs webEyes): every edge answer, refusals too, says macFallback: false.
  answer = () => Response.json({ ok: true, action: 'fetch', capability: 'public-web-fetch', url: 'https://example.com/a.json', status: 200, contentType: 'application/json', content: '{"a":1}', bytes: 7, macFallback: false })
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return isProbe(call) ? edgeProbeAnswer() : answer()
  })
  // The decided transport is kept per module instance: each test loads the shim fresh.
  vi.resetModules()
  shim = await import('../../src/node/external_packages/undici.ts')
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the undici shim fetches through the web-eyes broker', () => {
  it('posts the exact broker contract to the same origin and returns the page as served', async () => {
    const response = await shim.fetch('https://example.com/a.json')
    expect(reads()).toHaveLength(1)
    expect(reads()[0]?.url).toBe(`${ORIGIN}/_host/web-eyes`)
    expect(reads()[0]?.init.method).toBe('POST')
    expect(reads()[0]?.init.credentials).toBe('same-origin')
    expect(sent(0)).toEqual({ action: 'fetch', url: 'https://example.com/a.json', format: 'raw' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ a: 1 })
    expect(shim.default.fetch).toBe(shim.fetch)
  })

  it('accepts a URL or a GET Request, and answers HEAD without a body', async () => {
    await shim.fetch(new URL('https://example.com/u'))
    await shim.fetch(new Request('https://example.com/r'))
    const head = await shim.fetch('https://example.com/h', { method: 'HEAD' })
    expect(reads().map((_call, index) => sent(index).url)).toEqual(['https://example.com/u', 'https://example.com/r', 'https://example.com/h'])
    expect(head.body).toBeNull()
  })

  it('on the edge (macFallback: false) never calls the Mac-only relay', async () => {
    await shim.fetch('https://example.com/a.json')
    expect(calls.some(call => call.url.includes('/api/fetch'))).toBe(false)
  })

  it('refuses a write in words, without calling anything (the broker only reads)', async () => {
    await expect(shim.fetch('https://example.com/a', { method: 'POST', body: 'x' })).rejects.toThrow(/POST is not available here/)
    await expect(shim.fetch(new Request('https://example.com/a', { method: 'PUT', body: 'x' }))).rejects.toThrow(/PUT is not available/)
    expect(calls).toHaveLength(0)
  })

  it('a broker refusal rejects with its code, like undici\'s own "fetch failed"', async () => {
    answer = () => Response.json({ ok: false, code: 'WEB_EYES_URL_REFUSED', macFallback: false }, { status: 403 })
    await expect(shim.fetch('http://127.0.0.1/')).rejects.toThrow('fetch failed: WEB_EYES_URL_REFUSED from /_host/web-eyes for http://127.0.0.1/')
    answer = () => Response.json({ ok: false, error: 'web-eyes fetch requires `url`' }, { status: 400 })
    await expect(shim.fetch('https://example.com/')).rejects.toThrow(/web-eyes fetch requires/)
    answer = () => new Response('<html>no route</html>', { status: 501 })
    await expect(shim.fetch('https://example.com/')).rejects.toThrow('fetch failed: HTTP 501 from /_host/web-eyes')
    answer = () => Response.json({ ok: true, status: 200 })
    await expect(shim.fetch('https://example.com/')).rejects.toThrow(/fetch failed/)
  })

  it('an odd upstream status reads as 200, and content with no stated type reads as text', async () => {
    answer = () => Response.json({ ok: true, status: 99, content: 'plain', macFallback: false })
    const response = await shim.fetch('https://example.com/p')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    expect(await response.text()).toBe('plain')
  })

  it('passes the caller\'s abort signal to the broker call', async () => {
    const controller = new AbortController()
    await shim.fetch('https://example.com/a.json', { signal: controller.signal })
    expect(reads()[0]?.init.signal).toBe(controller.signal)
  })

  it('a network failure of the broker rejects plainly, and nothing else is tried', async () => {
    await shim.fetch('https://example.com/a.json')
    answer = () => { throw new TypeError('network down') }
    await expect(shim.fetch('https://example.com/b.json')).rejects.toThrow('network down')
    expect(calls.some(call => call.url.includes('/api/fetch'))).toBe(false)
  })
})

describe('the transport is decided once, and no target is read to decide it', () => {
  it('one probe for many fetches; the probe names no target and asks for nothing', async () => {
    await Promise.all([shim.fetch('https://example.com/1'), shim.fetch('https://example.com/2')])
    await shim.fetch('https://example.com/3')
    const probes = calls.filter(isProbe)
    expect(probes).toHaveLength(1)
    expect(bodyOf(probes[0])).toEqual({ action: 'transport' })
    expect(probes[0]?.url).toBe(`${ORIGIN}/_host/web-eyes`)
    // Each target is read exactly once.
    expect(reads().map((_call, index) => sent(index).url)).toEqual(['https://example.com/1', 'https://example.com/2', 'https://example.com/3'])
  })

  it('an answer that decides nothing (signed out, or the probe cannot reach the host) rejects and is not kept', async () => {
    let probe: () => Response = () => Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 403 })
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const call = { url: String(url), init }
      calls.push(call)
      return isProbe(call) ? probe() : answer()
    })
    await expect(shim.fetch('https://example.com/a')).rejects.toThrow('fetch failed: HTTP 403 from /_host/web-eyes decides no transport')
    probe = () => { throw new TypeError('offline') }
    await expect(shim.fetch('https://example.com/a')).rejects.toThrow(/could not be reached to choose a transport/)
    expect(reads()).toHaveLength(0)
    probe = edgeProbeAnswer
    expect((await shim.fetch('https://example.com/a')).status).toBe(200)
    expect(calls.filter(isProbe)).toHaveLength(3)
  })

  it('a caller who stops while the transport is being decided is answered at once', async () => {
    let release: () => void = () => {}
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const call = { url: String(url), init }
      calls.push(call)
      if (isProbe(call)) { await new Promise<void>((resolve) => { release = resolve }); return edgeProbeAnswer() }
      return answer()
    })
    const controller = new AbortController()
    const pending = shim.fetch('https://example.com/a', { signal: controller.signal })
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(pending).rejects.toThrow('stopped')
    release()
    // The shared decision still lands for the next caller.
    expect((await shim.fetch('https://example.com/b')).status).toBe(200)
    expect(calls.filter(isProbe)).toHaveLength(1)
  })
})

describe('on the Mac host, whose web-eyes is lossy, the shim uses only the Mac\'s raw relay', () => {
  /** The Mac host's web-eyes answer (server/local-host.mjs): no `capability`, no `macFallback`, text cut at 80,000. */
  const macWebEyes = () => Response.json({ ok: true, url: 'https://registry.npmjs.org/x', status: 200, contentType: 'application/json', content: '{"cut' + '\\n\\n[...truncated at 80000 chars]' })
  const big = JSON.stringify({ versions: 'v'.repeat(90_000) })

  function macHost(relay: (url: URL, init: RequestInit) => Response) {
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const call = { url: String(url), init }
      calls.push(call)
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/fetch') return relay(parsed, init)
      return isProbe(call) ? macProbeAnswer() : macWebEyes()
    })
  }

  it('the bytes and headers as served come back whole, read once, never through web-eyes', async () => {
    macHost(() => new Response(big, { status: 200, headers: { 'x-relay': '1', 'x-relay-status': '200', 'x-relay-h-content-type': 'application/json' } }))
    const response = await shim.fetch('https://registry.npmjs.org/x', { headers: { accept: 'application/json' } })
    // The probe, then the relay: the target is never asked of the lossy web-eyes.
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/_host/web-eyes', '/api/fetch'])
    expect(isProbe(calls[0] as { init: RequestInit })).toBe(true)
    expect(new URL(calls[1]?.url ?? '').searchParams.get('url')).toBe('https://registry.npmjs.org/x')
    expect(new Headers(calls[1]?.init.headers).get('x-relay-accept')).toBe('application/json')
    expect(calls[1]?.init.method).toBe('GET')
    expect(calls[1]?.init.credentials).toBe('same-origin')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(await response.text())).toEqual(JSON.parse(big))
    // The next fetch goes straight to the relay.
    await shim.fetch('https://registry.npmjs.org/y')
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/_host/web-eyes', '/api/fetch', '/api/fetch'])
  })

  it('the upstream status the relay reports is kept', async () => {
    macHost(() => new Response('gone', { status: 200, headers: { 'x-relay': '1', 'x-relay-status': '404' } }))
    expect((await shim.fetch('https://example.com/gone')).status).toBe(404)
  })

  it('a relay that fails or is not there rejects; the lossy web-eyes content is never returned', async () => {
    macHost(() => { throw new TypeError('relay connection reset') })
    await expect(shim.fetch('https://registry.npmjs.org/x')).rejects.toThrow('relay connection reset')
    macHost(() => new Response('<html>app</html>', { status: 200 }))
    await expect(shim.fetch('https://example.com/a')).rejects.toThrow('fetch relay unavailable (HTTP 200 from /api/fetch)')
    // Only the one probe ever went to web-eyes; no target did.
    expect(calls.filter(call => new URL(call.url).pathname === '/_host/web-eyes').every(isProbe)).toBe(true)
  })
})
