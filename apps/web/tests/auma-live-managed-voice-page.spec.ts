// @vitest-environment jsdom
/**
 * THE MANAGED VOICE'S SEAM, ON THE MOUNTED PAGE.
 * aumalive.js is mounted whole in jsdom: the page's own files are staged in a scratch folder inside the worktree with
 * their `/app/` imports made relative, and the managed module the orb loads is the REAL managed-voice/browser.mjs
 * (with its controller, governed turn and policy) whose one SDK import is replaced by a fake `Conversation`. The orb,
 * the mute button, the composer, the status line and the transcript are the page's own elements. The older voice would be
 * seen starting by its first words ('requesting microphone access…'); since 2026-11-14 it never does (the guard cases are
 * in auma-live-voice-old-unreachable.spec.ts). No network, no provider, no microphone.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type Frame = Record<string, unknown> & { t: string }
type Session = {
  endSession: () => Promise<void>
  setMicMuted: (muted: boolean) => void
  getInputVolume: () => number
  getOutputVolume: () => number
  sendUserMessage: (text: string) => void
  sendUserActivity: () => void
  getId: () => string
}
type SessionConfig = Record<string, unknown> & {
  micMuted: boolean
  onConversationCreated: (value: Session) => void
  onConnect: () => void
  onAgentResponseCorrection: (correction: Record<string, unknown>) => void
}
type Answer = () => Response

const CONV = 'conv_page_1'
const PASS = 'p'.repeat(64)
const TODAY = 'requesting microphone access…'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// jsdom replaces URL, so paths are found from the working directory (the repo root, or apps/web), as the page specs do.
const webDir = ['apps/web', '.'].map(dir => resolve(process.cwd(), dir)).find(dir => existsSync(join(dir, 'public/app/aumalive.js'))) ?? 'apps/web'
const appDir = join(webDir, 'public/app')
const managedDir = join(webDir, 'scripts/stock-apps/managed-voice')
let stage = ''

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(text: string) { this.sent.push(JSON.parse(text) as Frame) }
  close() { this.readyState = 3 }
  addEventListener() { /* today's voice is never driven here */ }
  removeEventListener() { /* today's voice is never driven here */ }
  open() { this.readyState = 1; this.onopen?.() }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  frames(kind: string) { return this.sent.filter(frame => frame.t === kind) }
}

/** What the fake SDK and the fake edge saw, reset before each case. */
const seen = {
  answer: (): Response => json({ ok: false, code: 'VOICE_MANAGED_OFF' }, 409),
  configs: [] as SessionConfig[],
  muteCalls: [] as boolean[],
  typed: [] as string[],
  ended: 0,
  voiceAsks: 0,
  hidden: false,
}
const fakeSession: Session = {
  endSession: async () => { seen.ended += 1 },
  setMicMuted: (muted) => { seen.muteCalls.push(muted) },
  getInputVolume: () => 0.1,
  getOutputVolume: () => 0.1,
  sendUserMessage: (text) => { seen.typed.push(text) },
  sendUserActivity: () => {},
  getId: () => CONV,
}

let mountAumaLive: (root: HTMLElement, options?: Record<string, unknown>) => void = () => {}
let unconfirmedSay = ''

const waitFor = async (check: () => boolean, what: string, ms = 4000) => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

beforeAll(async () => {
  // The page's files, staged with their absolute `/app/` imports made relative (the browser resolves them by origin).
  stage = mkdtempSync(join(webDir, '.managed-voice-page-'))
  for (const name of readdirSync(appDir).filter(file => file.endsWith('.js') && file !== 'managed-voice.js')) {
    let source = readFileSync(join(appDir, name), 'utf8').replaceAll(' from \'/app/', ' from \'./')
    if (name === 'aumalive.js') {
      const seam = 'const MANAGED_VOICE_MODULE = \'/app/managed-voice.js\';'
      expect(source).toContain(seam)
      // A file path, not a relative one: under jsdom the runner resolves a computed import() against jsdom's URL.
      source = source.replace(seam, `const MANAGED_VOICE_MODULE = ${JSON.stringify(join(stage, 'managed-voice.js'))};`)
    }
    writeFileSync(join(stage, name), source)
  }
  // The managed module as the build bundles it (browser.mjs and what it imports), with the SDK import faked.
  for (const name of ['controller.mjs', 'governed-turn.mjs', 'policy.mjs']) writeFileSync(join(stage, name), readFileSync(join(managedDir, name)))
  const sdkImport = 'import { Conversation } from \'@elevenlabs/client\''
  const browser = readFileSync(join(managedDir, 'browser.mjs'), 'utf8')
  expect(browser).toContain(sdkImport)
  writeFileSync(join(stage, 'browser.mjs'), browser.replace(sdkImport, 'const Conversation = globalThis.__managedVoiceSdk'))
  writeFileSync(join(stage, 'managed-voice.js'), 'export * from \'./browser.mjs\'\n')

  ;(globalThis as Record<string, unknown>).__managedVoiceSdk = {
    startSession: async (config: SessionConfig) => {
      seen.configs.push(config)
      config.onConversationCreated(fakeSession)
      config.onConnect()
      return fakeSession
    },
  }
  // Her DSH carrier refuses everything: a bridged turn cannot confirm her look-only home and says so.
  ;(window as unknown as Record<string, unknown>).__DSH_TRANSPORT__ = {
    fetch: async () => json({}, 503),
    openStream: () => { throw new Error('no stream in this test') },
  }
  // The page binds `window.fetch`; the managed module calls the global `fetch`: both are this one fake.
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
    if (path === '/_host/voice' && init?.body === '{"action":"managed_session"}') { seen.voiceAsks += 1; return seen.answer() }
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }
  window.fetch = fakeFetch
  globalThis.fetch = fakeFetch
  ;(globalThis as Record<string, unknown>).WebSocket = FakeSocket
  window.requestAnimationFrame = () => 0
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => new Promise<MediaStream>(() => {}) },
  })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => seen.hidden })

  // The module the orb will load must load (the page answers a failed load with its "not reachable" line).
  const managed = await import(pathToFileURL(join(stage, 'managed-voice.js')).href) as Record<string, unknown>
  expect(Object.keys(managed).sort()).toEqual(['MANAGED_VOICE', 'correctionMatches', 'createArrivalRunner', 'createGovernedTurnRunner', 'createManagedVoice', 'markCut'])
  const page = await import(pathToFileURL(join(stage, 'aumalive.js')).href) as { mountAumaLive: typeof mountAumaLive }
  mountAumaLive = page.mountAumaLive
  unconfirmedSay = (await import(pathToFileURL(join(stage, 'genesis-live.js')).href) as { VOICE_UNCONFIRMED_SAY: string }).VOICE_UNCONFIRMED_SAY
})

afterAll(() => {
  if (stage) rmSync(stage, { recursive: true, force: true })
})

beforeEach(() => {
  seen.configs = []; seen.muteCalls = []; seen.typed = []; seen.ended = 0; seen.voiceAsks = 0; seen.hidden = false
  FakeSocket.all = []
  localStorage.clear()
})

/** A freshly mounted page (each mount cleans up the one before it), with every status line it shows recorded. */
function mount() {
  document.body.innerHTML = ''
  const root = document.createElement('div')
  document.body.append(root)
  mountAumaLive(root)
  const pick = (selector: string): HTMLElement => {
    const found = root.querySelector(selector)
    if (!(found instanceof HTMLElement)) throw new Error(`no ${selector}`)
    return found
  }
  const orb = pick('.alv-orb')
  const mute = pick('.alv-mute')
  const status = pick('.alv-status')
  const compose = pick('.alv-log-compose')
  const input = compose.querySelector('input')
  if (!input) throw new Error('no composer input')
  const lines: string[] = []
  new MutationObserver(() => { lines.push(status.textContent ?? '') }).observe(status, { childList: true, characterData: true, subtree: true })
  const type = (text: string) => {
    input.value = text
    compose.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  const herLines = () => [...root.querySelectorAll('.alv-log-txt')].map(node => node.textContent ?? '')
  return { root, orb, mute, status, lines, type, herLines }
}

describe('the seam on the mounted page', () => {
  it('muted before the first press: the call starts muted, and unmuting reaches the same call', async () => {
    seen.answer = () => json({ token: PASS, maxDurationSeconds: 600 })
    const p = mount()
    p.mute.click()
    p.orb.click()
    await waitFor(() => seen.configs.length === 1, 'the call to start')
    expect(seen.configs[0]?.micMuted).toBe(true)
    expect(seen.muteCalls).not.toContain(false)
    p.mute.click()
    expect(seen.muteCalls.at(-1)).toBe(false)
    expect(seen.configs).toHaveLength(1)
    expect(p.lines).not.toContain(TODAY)
  })

  it('muted while the module is still loading: the call starts muted', async () => {
    const p = mount()
    seen.answer = () => json({ token: PASS, maxDurationSeconds: 600 })
    p.orb.click()
    p.mute.click()
    await waitFor(() => seen.configs.length === 1, 'the call to start')
    expect(seen.configs[0]?.micMuted).toBe(true)
    expect(seen.muteCalls).not.toContain(false)
  })

  it('the switch off, a 404, a 403 and an edge error rest the orb with one true line; no other voice starts, the provider is never called', async () => {
    // the managed voice is the voice. None of these starts the older voice any more.
    for (const [answer, line] of [
      [() => json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400), 'My voice is not set up on this host yet. Typing works.'],
      [() => json({ ok: false, code: 'NOT_FOUND' }, 404), 'My voice is not set up on this host yet. Typing works.'],
      [() => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403), 'My voice needs your fingerprint sign-in on this browser. Typing works.'],
      [() => new Response('upstream', { status: 502 }), 'My voice is not reachable right now. Typing works.'],
    ] as Array<[Answer, string]>) {
      seen.answer = answer
      const p = mount()
      p.orb.click()
      await waitFor(() => p.status.textContent === line, line)
      expect(p.lines).not.toContain(TODAY)
      expect(p.orb.getAttribute('aria-busy')).toBe('false')
      expect(p.orb.className).not.toContain('live')
      expect(p.orb.getAttribute('aria-label')).toBe('Start Voice')
      expect(seen.voiceAsks).toBe(1)
      expect(seen.configs).toEqual([])
      seen.voiceAsks = 0
    }
  })

  it('a refusal rests the orb with its one line, starts nothing, and typing still reaches her transcript', async () => {
    seen.answer = () => json({ ok: false, code: 'VOICE_QUOTA' }, 429)
    const p = mount()
    p.orb.click()
    await waitFor(() => p.status.textContent === 'My voice is resting for today. We can keep talking in text.', 'the refusal line')
    expect(p.orb.getAttribute('aria-busy')).toBe('false')
    expect(p.orb.className).not.toContain('live')
    expect(p.orb.getAttribute('aria-label')).toBe('Start Voice')
    expect(p.lines).not.toContain(TODAY)
    expect(seen.configs).toEqual([])
    p.type('still here in text')
    expect(p.root.textContent).toContain('still here in text')
    expect(seen.typed).toEqual([])
    expect(seen.voiceAsks).toBe(1)
  })

  it('a live call takes typing into the same conversation, and hiding the page ends it', async () => {
    seen.answer = () => json({ token: PASS, maxDurationSeconds: 600 })
    const p = mount()
    p.orb.click()
    await waitFor(() => FakeSocket.all.length === 1, 'the tab door')
    expect(p.orb.getAttribute('aria-label')).toBe('Stop Voice')
    p.type('typed into the call')
    expect(seen.typed).toEqual(['typed into the call'])
    seen.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen.ended).toBe(1)
    expect(p.orb.getAttribute('aria-label')).toBe('Start Voice')
    expect(p.lines).not.toContain(TODAY)
  })

  it('a sentence the page says for a turn ends in done; a correction for another response leaves her lines alone', async () => {
    seen.answer = () => json({ token: PASS, maxDurationSeconds: 600 })
    const p = mount()
    p.orb.click()
    await waitFor(() => FakeSocket.all.length === 1, 'the tab door')
    const socket = FakeSocket.all[0] as FakeSocket
    expect(socket.url).toMatch(/\/_host\/voice\/bridge$/)
    socket.open()
    expect(socket.sent[0]).toEqual({ t: 'hello', conv: CONV })
    socket.deliver({ t: 'ready', conv: CONV, maxDurationSeconds: 600 })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_page_1:1', eventId: 1, transcript: 'open the garden gate' })
    await waitFor(() => socket.frames('done').length + socket.frames('fail').length > 0, 'the turn to end')
    // Her look-only home could not be confirmed: the page's sentence is the turn's reply, and the edge is told `done`.
    expect(socket.frames('delta').map(frame => frame.text).join('')).toBe(unconfirmedSay)
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_page_1:1' }])
    expect(socket.frames('fail')).toEqual([])
    expect(p.herLines()).toContain(unconfirmedSay)

    // The edge's own "one sec" was cut: that correction is not hers, and her stored line stays as she said it.
    const config = seen.configs[0] as SessionConfig
    config.onAgentResponseCorrection({ original_agent_response: 'one sec...', corrected_agent_response: 'one sec' })
    expect(p.herLines()).toContain(unconfirmedSay)
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i) ?? '') ?? '').join('\n')
    expect(stored).toContain(unconfirmedSay.slice(0, 30))

    // A correction for her own line marks where she was cut.
    config.onAgentResponseCorrection({ original_agent_response: unconfirmedSay, corrected_agent_response: 'My voice could not confirm' })
    expect(p.herLines()).toContain('My voice could not confirm —')
    expect(p.herLines()).not.toContain(unconfirmedSay)
  })
})
