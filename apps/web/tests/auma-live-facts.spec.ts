/**
 * Auma Live's status strip read two routes no host defines, so it said "unknown" and the edge
 * answered 501 every 30 s. The page now answers both from the edge's own facts. What the facts establish becomes known
 * on the strip; everything else stays unknown. No zero, no empty list, no dollar figure is invented.
 */
import { describe, expect, it } from 'vitest'
import {
  AUMA_LIVE_MINDS_PATH, AUMA_LIVE_STATUS_PATH, EDGE_HEALTH_PATH, EDGE_HEALTH_REUSE_MS, EDGE_WAKE_PATH, installAumaLiveFacts, mindsFromPage,
  statusFromEdgeFacts,
} from '../src/spatial/auma-live-facts.ts'
import { readFileSync } from 'node:fs'

/** The strip's own module (ui-layout auma-status.ts), read as text: apps/web does not depend on that package. */
const STRIP = readFileSync(new URL('../../../packages/client/ui-layout/src/client/spatial/auma-status.ts', import.meta.url), 'utf8')

const ORIGIN = 'https://node.example.invalid'
const health = { ok: true, capabilities: { providerDoors: { openrouter: true, anthropic: true, deepseek: false, openai: false } } }
/** GET /_host/wake answers the HEAD's wake view at top level (head-do.mjs wakeView). */
const wake = { ok: true, enabled: true, lastWakeOutcome: 'probe_succeeded', lastWakeAt: 1_762_900_000_000, wakeCount: 3 }

describe('the status answer is built from edge facts only', () => {
  it('the paths are the ones the strip reads', () => {
    expect(STRIP).toContain(`export const AUMA_STATUS_PATH = '${AUMA_LIVE_STATUS_PATH}'`)
    expect(STRIP).toContain(`export const AUMA_MINDS_PATH = '${AUMA_LIVE_MINDS_PATH}'`)
  })

  it('the edge\'s configured provider keys are said as exactly that, never as hands; the last wake is the edge wake view\'s', () => {
    expect(statusFromEdgeFacts(health, wake)).toEqual({
      source: 'page: from edge facts',
      edgeProviderKeys: ['anthropic', 'openrouter'],
      lastWake: { decision: 'probe succeeded', at: new Date(1_762_900_000_000).toISOString() },
    })
  })

  it('a fact that could not be read is left out, never filled in', () => {
    expect(statusFromEdgeFacts(null, null)).toEqual({ source: 'page: from edge facts' })
    expect(statusFromEdgeFacts({ ok: true }, { ok: true, lastWakeOutcome: null, lastWakeAt: null }))
      .toEqual({ source: 'page: from edge facts' })
    expect(statusFromEdgeFacts(null, { lastWakeOutcome: 'Probe <b>', lastWakeAt: 5 }))
      .toEqual({ source: 'page: from edge facts' })
    expect(statusFromEdgeFacts(null, { lastWakeOutcome: 'probe_busy', lastWakeAt: -1 }))
      .toEqual({ source: 'page: from edge facts', lastWake: { decision: 'probe busy' } })
  })

  it('carries no field the strip would read as home session, CORE, spend or lanes (the strip court is in ui-layout)', () => {
    const answer = statusFromEdgeFacts(health, wake)
    for (const field of ['homeSession', 'homeLive', 'core', 'spend', 'lanes']) expect(Object.hasOwn(answer, field)).toBe(false)
    // A configured key is not a hand that resolves (a revoked or blank key still counts in health): no `hands` field.
    expect(Object.hasOwn(answer, 'hands')).toBe(false)
    // The minds answer carries no `waiting` field, so the waiting badge stays unknown rather than "nobody is waiting".
    expect(Object.hasOwn(mindsFromPage(), 'waiting')).toBe(false)
  })
})

describe('the page answers the two reads, and nothing else', () => {
  function page(answers: Record<string, Response | Error | (() => Response | Promise<Response>)>, clock: { now: number } = { now: 0 }, document: { visibilityState: string } = { visibilityState: 'visible' }) {
    const calls: string[] = []
    const scope = {
      location: { origin: ORIGIN },
      document,
      now: () => clock.now,
      fetch: async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
        calls.push(`${url.pathname}${url.search}`)
        const given = answers[url.pathname]
        const answer = typeof given === 'function' ? await given() : given
        if (answer instanceof Error) throw answer
        return answer ?? new Response('{"ok":false}', { status: 501 })
      },
    }
    installAumaLiveFacts(scope)
    return { scope, calls }
  }

  it('the status read becomes two edge fact reads and a 200 answer', async () => {
    const { scope, calls } = page({ [EDGE_HEALTH_PATH]: Response.json(health), [EDGE_WAKE_PATH]: Response.json(wake) })
    const response = await scope.fetch(AUMA_LIVE_STATUS_PATH, { credentials: 'same-origin' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(statusFromEdgeFacts(health, wake))
    expect(calls.sort()).toEqual([EDGE_WAKE_PATH, EDGE_HEALTH_PATH])
  })

  // The network is mocked here: this counts the requests the page makes, not what each costs at the edge.
  it('requests per poll: never the estate projection, the wake on each poll, the health answer reused for a while', async () => {
    const clock = { now: 1_000 }
    const { scope, calls } = page({ [EDGE_HEALTH_PATH]: () => Response.json(health), [EDGE_WAKE_PATH]: () => Response.json(wake) }, clock)
    for (let poll = 0; poll < 3; poll++) {
      expect(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json()).toEqual(statusFromEdgeFacts(health, wake))
      clock.now += 30_000
    }
    expect(calls.filter(path => path === '/_host/estate')).toEqual([])
    expect(calls.filter(path => path === EDGE_WAKE_PATH)).toHaveLength(3)
    expect(calls.filter(path => path === EDGE_HEALTH_PATH)).toHaveLength(1)
    clock.now = 1_000 + EDGE_HEALTH_REUSE_MS + 1
    await scope.fetch(AUMA_LIVE_STATUS_PATH)
    expect(calls.filter(path => path === EDGE_HEALTH_PATH)).toHaveLength(2)
  })

  it('while the page is hidden no fact is read: the poll gets the last answer again, and reading resumes when shown', async () => {
    const document = { visibilityState: 'hidden' }
    const answers = { [EDGE_HEALTH_PATH]: () => Response.json(health), [EDGE_WAKE_PATH]: () => Response.json(wake) }
    const { scope, calls } = page(answers, { now: 0 }, document)
    // Hidden from the start: nothing known yet, so every fact stays unknown, and nothing is read.
    expect(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json()).toEqual({ source: 'page: from edge facts' })
    expect(calls).toEqual([])
    document.visibilityState = 'visible'
    expect(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json()).toEqual(statusFromEdgeFacts(health, wake))
    expect(calls).toHaveLength(2)
    document.visibilityState = 'hidden'
    for (let poll = 0; poll < 5; poll++) {
      expect(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json()).toEqual(statusFromEdgeFacts(health, wake))
    }
    expect(calls).toHaveLength(2)
    document.visibilityState = 'visible'
    await scope.fetch(AUMA_LIVE_STATUS_PATH)
    expect(calls.filter(path => path === EDGE_WAKE_PATH)).toHaveLength(2)
  })

  it('one refresh in flight at most: polls that arrive meanwhile share it', async () => {
    let release: () => void = () => {}
    const slowWake = new Promise<void>((resolve) => { release = resolve })
    const { scope, calls } = page({
      [EDGE_HEALTH_PATH]: () => Response.json(health),
      [EDGE_WAKE_PATH]: async () => { await slowWake; return Response.json(wake) },
    })
    const polls = [scope.fetch(AUMA_LIVE_STATUS_PATH), scope.fetch(AUMA_LIVE_STATUS_PATH), scope.fetch(AUMA_LIVE_STATUS_PATH)]
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    release()
    for (const poll of await Promise.all(polls)) expect(await poll.json()).toEqual(statusFromEdgeFacts(health, wake))
    expect(calls.filter(path => path === EDGE_WAKE_PATH)).toHaveLength(1)
    expect(calls.filter(path => path === EDGE_HEALTH_PATH)).toHaveLength(1)
    // Once it settles, the next poll refreshes again.
    await scope.fetch(AUMA_LIVE_STATUS_PATH)
    expect(calls.filter(path => path === EDGE_WAKE_PATH)).toHaveLength(2)
  })

  it('a failed health read is not reused: the next poll asks again', async () => {
    let healthy = false
    const { scope, calls } = page({ [EDGE_HEALTH_PATH]: () => healthy ? Response.json(health) : new Response('', { status: 503 }), [EDGE_WAKE_PATH]: () => Response.json(wake) })
    expect(Object.hasOwn(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json() as object, 'edgeProviderKeys')).toBe(false)
    healthy = true
    expect(await (await scope.fetch(AUMA_LIVE_STATUS_PATH)).json()).toEqual(statusFromEdgeFacts(health, wake))
    expect(calls.filter(path => path === EDGE_HEALTH_PATH)).toHaveLength(2)
  })

  it('a refused or failed fact read leaves its fields out', async () => {
    const { scope } = page({ [EDGE_HEALTH_PATH]: new Response('', { status: 401 }), [EDGE_WAKE_PATH]: new TypeError('offline') })
    expect(await (await scope.fetch(`${ORIGIN}${AUMA_LIVE_STATUS_PATH}`)).json()).toEqual({ source: 'page: from edge facts' })
  })

  it('the minds read is answered without any request', async () => {
    const { scope, calls } = page({})
    const response = await scope.fetch(new Request(`${ORIGIN}${AUMA_LIVE_MINDS_PATH}`))
    expect(await response.json()).toEqual(mindsFromPage())
    expect(calls).toEqual([])
  })

  it('every other request, method or origin goes to the network unchanged', async () => {
    const { scope, calls } = page({})
    await scope.fetch('/api/auma-live/chat/recent?session=s')
    await scope.fetch(AUMA_LIVE_STATUS_PATH, { method: 'POST', body: '{}' })
    await scope.fetch(`https://elsewhere.example${AUMA_LIVE_STATUS_PATH}`)
    // An unparseable address is not answered here: the network fetch refuses it as it always did.
    await expect(scope.fetch('http://[bad')).rejects.toThrow()
    expect(calls).toEqual(['/api/auma-live/chat/recent?session=s', AUMA_LIVE_STATUS_PATH, AUMA_LIVE_STATUS_PATH])
  })

  it('installing twice wraps once; a page without fetch or location is left alone', async () => {
    const { scope, calls } = page({})
    const wrapped = scope.fetch
    installAumaLiveFacts(scope)
    expect(scope.fetch).toBe(wrapped)
    await scope.fetch(AUMA_LIVE_MINDS_PATH)
    expect(calls).toEqual([])
    const bare = { fetch: undefined as unknown as typeof fetch }
    installAumaLiveFacts(bare)
    expect(bare.fetch).toBeUndefined()
  })
})
