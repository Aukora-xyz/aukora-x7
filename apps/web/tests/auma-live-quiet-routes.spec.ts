/**
 * Auma Live's peek and its field report asked routes no host defines, the peek every 2.5 s, forever.
 * The first "no such route" answer (404, 405, 501) now stops each for the page; a transient failure does not. Both
 * files are page scripts that cannot be imported, so the exact functions are lifted from the files' own text and RUN
 * here against fakes (the same method as the ui-layout Auma Live courts).
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../public/app/${name}`, import.meta.url), 'utf8')

/** lane-bridge.js's peek, from its marker to the end of the file, over a fake fetch and fake timers. */
function peek(statuses: number[]) {
  const source = read('lane-bridge.js')
  const block = source.slice(source.indexOf('// ── TARGET CHAT PEEK'))
  const requests: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const announced: string[] = []
  const context = {
    fetch: async (endpoint: string) => {
      requests.push(endpoint)
      const status = statuses.shift() ?? 200
      if (status === 0) throw new TypeError('network down')
      return new Response(JSON.stringify({ turns: [{ role: 'auma', text: 'hello', ts: 1 }] }), { status })
    },
    setInterval: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id },
    clearInterval: (id: number) => { timers.delete(id) },
    announceLaneTurn: (lane: string) => { announced.push(lane) },
    encodeURIComponent,
    Set,
    Array,
  }
  const api = runInNewContext(`
    let SESSION_ID = 'session-1';
    const TARGET_CHAT_ENDPOINT = '/api/auma-live/chat/recent';
    let targetChatTurns = [];
    ${block}
    ({ refresh: refreshTargetChatTurns, state: () => ({ absent: targetChatRouteAbsent, timer: targetChatTimer, turns: targetChatTurns.length }) })
  `, context) as {
    refresh: () => Promise<void>
    state: () => { absent: boolean; timer: number | null; turns: number }
  }
  const tick = async (): Promise<void> => {
    for (const callback of [...timers.values()]) callback()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { api, requests, timers, announced, tick }
}

describe('lane-bridge: the chat peek stops asking a route no host defines', () => {
  it('a 501 at load stops the 2.5 s polling; nothing more is sent, even when the bridge is asked again', async () => {
    const p = peek([501])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(p.requests).toEqual(['/api/auma-live/chat/recent?session=session-1'])
    expect(p.api.state()).toEqual({ absent: true, timer: null, turns: 0 })
    expect(p.timers.size).toBe(0)
    await p.api.refresh()
    expect(p.requests).toHaveLength(1)
  })

  it('404 and 405 also mean "no such route"', async () => {
    for (const status of [404, 405]) {
      const p = peek([status])
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(p.api.state().absent).toBe(true)
      expect(p.timers.size).toBe(0)
    }
  })

  it('a transient failure (503, a dropped connection) keeps polling, and a later answer fills the peek', async () => {
    const p = peek([503, 0, 200])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(p.api.state()).toMatchObject({ absent: false, turns: 0 })
    expect(p.timers.size).toBe(1)
    await p.tick()
    await p.tick()
    expect(p.requests).toHaveLength(3)
    expect(p.api.state()).toMatchObject({ absent: false, turns: 1 })
    expect(p.announced).toEqual(['chat'])
  })
})

/** aumalive.js's field report, lifted from its declaration to the next function, over a fake fetch and console. */
function fieldReport(statuses: number[]) {
  const source = read('aumalive.js')
  const block = source.slice(source.indexOf('  let fieldReportRoute = true;'), source.indexOf('  function swapCanvas() {'))
  const posts: string[] = []
  const printed: string[] = []
  const context = {
    fetch: async (path: string, init: { body: string }) => {
      posts.push(`${path} ${init.body}`)
      return new Response('{"ok":false}', { status: statuses.shift() ?? 200 })
    },
    console: { info: (line: string) => { printed.push(line) } },
    boundSessionId: 'session-1',
    Date: { now: () => 42 },
    JSON,
    String,
  }
  const api = runInNewContext(`${block}\n({ post: postFieldDegraded, route: () => fieldReportRoute })`, context) as {
    post: (reason: string, scale: number) => void
    route: () => boolean
  }
  return { api, posts, printed }
}

describe('aumalive: the field report is always printed, and posted only while a host answers its route', () => {
  it('after a 501 the next degradation is printed but not posted', async () => {
    const f = fieldReport([501])
    f.api.post('slow-frames', 0.75)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.api.route()).toBe(false)
    f.api.post('slow-frames', 0.5)
    expect(f.posts).toEqual(['/api/auma-live/field-degraded {"kind":"field-degraded","reason":"slow-frames","scale":0.75,"at":42,"session":"session-1"}'])
    expect(f.printed).toEqual([
      'auma-live: field degraded (slow-frames, render scale 0.75)',
      'auma-live: field degraded (slow-frames, render scale 0.5)',
    ])
  })

  it('a host that answers keeps receiving reports', async () => {
    const f = fieldReport([200, 503])
    f.api.post('a', 1); await new Promise(resolve => setTimeout(resolve, 0))
    f.api.post('b', 1); await new Promise(resolve => setTimeout(resolve, 0))
    f.api.post('c', 1)
    expect(f.posts).toHaveLength(3)
    expect(f.api.route()).toBe(true)
  })
})
