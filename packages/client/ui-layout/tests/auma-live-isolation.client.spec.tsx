// @vitest-environment jsdom
/**
 * Auma Live voice channel isolation & end-to-end spoken pipeline invariants:
 *   1. Speaking in Auma Live routes through its own dedicated hidden `auma-alien` Cordis session (`[voice] Auma Live`),
 *      never hijacking `dsh.sessions.current` (the open engineering chat thread in the left lane).
 *   2. `[voice] Auma Live` never renders as a card in `ThreadsLane`, whether matched by stored session id or title.
 *   3. `presence` (`visual: true`) keeps `VOICE_PROVENANCE` intact AND injects `AUMA_LIVE_ALIEN_VOICE_DIRECTIVE` so
 *      Auma speaks in full alien presence with live `[field ...]` WebGL aurora body-language tags.
 *   4. Deepgram Nova-3 listens with `endpointing=800` and `keyterm=Auma` (no more `"Omar"` mis-transcription), and
 *      `aumalive.js` never cancels silent thinking on `vad` events.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  AUMA_LIVE_VOICE_SESSION_KEY,
  AUMA_LIVE_VOICE_TITLE,
  ThreadsLane,
  type ThreadListState,
  type ThreadSummary,
} from '../src/client/spatial/portal/ThreadsLane.tsx'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const appFile = (name: string) => ['', '../../../']
  .map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`))
  .find(existsSync) ?? `apps/web/public/app/${name}`

const genesis = await import(pathToFileURL(appFile('genesis-live.js')).href) as {
  createGenesisLive: (deps: Record<string, unknown>) => {
    fetch: (input: string, init?: RequestInit) => Promise<Response>
    streamTurn: (input: Record<string, unknown>) => Promise<{ reason: string; text: string; message?: string }>
  }
  AUMA_LIVE_VOICE_SESSION_KEY: string
  AUMA_LIVE_VOICE_TITLE: string
  AUMA_LIVE_AUTO_HOME: string
  AUMA_LIVE_ALIEN_VOICE_DIRECTIVE: string
  VOICE_PROVENANCE: string
  GENESIS_PROVIDER: string
  GENESIS_VOICE_CLASSES: readonly string[]
}

const dg = await import(pathToFileURL(appFile('deepgram-voice.js')).href) as {
  voiceSocketFor: (url: string, deps: Record<string, unknown>) => { readyState: number }
  forgetNoPass: () => void
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const sid = (value: string): SessionId => value as SessionId
const row = (id: string, displayTitle: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: sid(id),
  displayTitle,
  running: false,
  blank: false,
  updatedAt: 10,
  retainedBy: {},
  ...extra,
})

describe('Auma Live voice channel isolation and spoken Alien presence', () => {
  it('provisions and reuses a dedicated auma-alien voice session without ever touching dsh.sessions.current', async () => {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 's-open-engineering-thread' }))
    const items: Array<{ sessionId: string; title?: string; displayTitle?: string }> = [
      { sessionId: 's-open-engineering-thread', title: 'Epoch 169 verification', displayTitle: 'Epoch 169 verification' },
    ]
    const rpcs: Array<{ method: string; args: Record<string, unknown> }> = []
    const transport = {
      fetch: async (path: string, init: { body: string }) => {
        const method = path.replace('/api/', '')
        const args = (JSON.parse(init.body) as { payload: { args: Record<string, unknown> } }).payload.args
        rpcs.push({ method, args })
        if (method === 'session/list') return json({ result: { ok: true, value: { items } } })
        if (method === 'session/create') {
          items.push({ sessionId: 's-voice-1', displayTitle: 'auma' })
          return json({ result: { ok: true, value: { sessionId: 's-voice-1', agentPreset: 'auma-alien' } } })
        }
        if (method === 'session/rename') {
          const req = args.request as { sessionId: string; title: string }
          const target = items.find(entry => entry.sessionId === req.sessionId)
          if (target) {
            target.title = req.title
            target.displayTitle = req.title
          }
          return json({ result: { ok: true, value: { title: req.title, seq: 1 } } })
        }
        return json({ result: { ok: true, value: {} } })
      },
      openStream: () => { throw new Error('unexpected stream') },
    }
    const g = genesis.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}, 404) })

    const mindsRes = await g.fetch('http://localhost/api/auma-live/minds')
    const mindsBody = await mindsRes.json() as { homeSession?: string }
    expect(mindsBody.homeSession).toBe('s-voice-1')
    expect(mindsBody.homeSession).not.toBe('s-open-engineering-thread')
    expect(localStorage.getItem(AUMA_LIVE_VOICE_SESSION_KEY)).toBe('s-voice-1')
    expect(rpcs.find(call => call.method === 'session/create')?.args).toEqual({
      request: { cwd: '/dsh/home/auma', agentPreset: 'auma-alien' },
    })
    expect(rpcs.find(call => call.method === 'session/rename')?.args).toEqual({
      request: { sessionId: 's-voice-1', title: AUMA_LIVE_VOICE_TITLE },
    })

    // Start Voice with autoHome reuses the same dedicated voice session without creating a second one.
    const grantRes = await g.fetch('http://localhost/api/auma-live/presence/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'start-voice',
        sessionId: genesis.AUMA_LIVE_AUTO_HOME,
        autoHome: true,
        recipient: genesis.GENESIS_PROVIDER,
        classes: genesis.GENESIS_VOICE_CLASSES,
      }),
    })
    const grant = await grantRes.json() as { sessionId: string; voiceSessionToken: string }
    expect(grantRes.status).toBe(200)
    expect(grant.sessionId).toBe('s-voice-1')
    expect(rpcs.filter(call => call.method === 'session/create')).toHaveLength(1)
  })

  it('ThreadsLane hides [voice] Auma Live by stored id and by durable title while keeping regular chat threads', () => {
    localStorage.setItem(AUMA_LIVE_VOICE_SESSION_KEY, 's-voice-stored')
    const store = createSnapshotStore<ThreadListState>({
      ids: [sid('s-chat-1'), sid('s-voice-stored'), sid('s-voice-titled')],
      byId: {
        [sid('s-chat-1')]: row('s-chat-1', 'Night run prep', { title: 'Night run prep', updatedAt: 30 }),
        [sid('s-voice-stored')]: row('s-voice-stored', 'auma', { updatedAt: 40 }),
        [sid('s-voice-titled')]: row('s-voice-titled', AUMA_LIVE_VOICE_TITLE, { title: AUMA_LIVE_VOICE_TITLE, updatedAt: 50 }),
      },
      phase: 'ready',
    })
    const view = render(
      <ThreadsLane useSessions={bindSnapshotSelector(store)} openThread={() => {}} openConversation={() => {}} />,
    )
    const renderedIds = [...view.container.querySelectorAll<HTMLElement>('[data-thread-id]')]
      .map(el => el.getAttribute('data-thread-id'))
    expect(renderedIds).toEqual(['s-chat-1'])
    expect(view.container.textContent).not.toContain(AUMA_LIVE_VOICE_TITLE)
  })

  it('spoken presence turns include VOICE_PROVENANCE and AUMA_LIVE_ALIEN_VOICE_DIRECTIVE ([field ...] grammar)', async () => {
    const prompts: Array<Record<string, unknown>> = []
    const streamDriver: { push: ((frame: unknown) => void) | null } = { push: null }
    const transport = {
      fetch: async (path: string, init: { body: string }) => {
        const method = path.replace('/api/', '')
        const args = (JSON.parse(init.body) as { payload: { args: Record<string, unknown> } }).payload.args
        if (method === 'session/list') {
          return json({ result: { ok: true, value: { items: [{ sessionId: 's-voice-1', title: AUMA_LIVE_VOICE_TITLE }] } } })
        }
        if (method === 'session/prompt') prompts.push(args.request as Record<string, unknown>)
        return json({ result: { ok: true, value: { accepted: true } } })
      },
      openStream: () => ({
        [Symbol.asyncIterator]: () => {
          let step = 0
          return {
            next: async () => {
              step += 1
              if (step === 1) return { done: false, value: { type: 'snapshot', records: [], cursor: 0, hasMore: false, projections: {} } }
              return await new Promise<{ done: boolean; value: unknown }>((resolvePromise) => {
                streamDriver.push = (frame) => {
                  resolvePromise(frame === null ? { done: true, value: undefined } : { done: false, value: frame })
                }
              })
            },
            return: async () => ({ done: true, value: undefined }),
          }
        },
      }),
    }
    const g = genesis.createGenesisLive({
      transport: Promise.resolve(transport),
      nativeFetch: async (_path: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { turnId: string }
        return json({ ok: true, action: 'dispatch_turn', turnId: body.turnId, voiceAuthority: 'none', savedBeforeDispatch: true })
      },
    })
    const grantRes = await g.fetch('http://localhost/api/auma-live/presence/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'start-voice',
        sessionId: 's-voice-1',
        recipient: genesis.GENESIS_PROVIDER,
        classes: genesis.GENESIS_VOICE_CLASSES,
      }),
    })
    const grant = await grantRes.json() as { voiceSessionToken: string }
    const streamRes = await g.fetch('http://localhost/api/auma-live/presence/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's-voice-1',
        text: 'Auma, can you hear me?',
        visual: true,
        spoken: true,
        voiceSessionToken: grant.voiceSessionToken,
      }),
    })
    const reader = streamRes.body?.getReader()
    await new Promise((r) => { setTimeout(r, 20) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionId).toBe('s-voice-1')
    expect(prompts[0]?.content).toEqual([
      { type: 'text', text: genesis.VOICE_PROVENANCE },
      { type: 'text', text: genesis.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE },
      { type: 'text', text: 'Auma, can you hear me?' },
    ])
    expect(genesis.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE).toContain('[field hue=')
    streamDriver.push?.(null)
    await reader?.cancel()
  })

  it('opens Deepgram Nova-3 with 800ms endpointing and Auma keyterms, and never aborts silent thinking on vad', async () => {
    dg.forgetNoPass()
    const openedUrls: string[] = []
    class FakeWS {
      binaryType = ''
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: unknown = null
      onclose: unknown = null
      onerror: unknown = null
      constructor(url: string) { openedUrls.push(url) }
      send() {}
      close() {}
    }
    dg.voiceSocketFor('wss://node.example.invalid/stock-apps/auma-live/voice?owner=1', {
      WebSocketImpl: FakeWS,
      BroadcastChannelImpl: undefined,
      fetchImpl: async () => json({ ok: true, provider: 'deepgram', accessToken: 'p'.repeat(40), expiresInSeconds: 30 }),
    })
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    const listenUrl = openedUrls.find(url => url.includes('/v1/listen')) ?? ''
    expect(listenUrl).toContain('endpointing=800')
    expect(listenUrl).toContain('keyterm=Auma')
    expect(listenUrl).toContain('keyterm=Aukora')
    expect(listenUrl).toMatch(/&mip_opt_out=true$/u)

    const aumaliveSource = readFileSync(appFile('aumalive.js'), 'utf8')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    const vadBlock = aumaliveSource.slice(aumaliveSource.indexOf('    vad(m) {'), aumaliveSource.indexOf('    final(m) {'))
    expect(vadBlock).not.toContain('bargeIn()')
    expect(vadBlock).not.toContain('streaming')
    expect(aumaliveSource).toContain('const echoWindowOpen = herStillAudible() || (performance.now() - lastSpokenAt) <= 1500;')
  })
})
