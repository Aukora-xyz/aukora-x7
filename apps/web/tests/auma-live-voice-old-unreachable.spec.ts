// @vitest-environment jsdom
/**
 * THE OLDER VOICE CAN NO LONGER START. The
 * managed voice is the voice. aumalive.js is mounted whole in jsdom, staged as the page spec stages it (its `/app/`
 * imports made relative; the managed module is the REAL managed-voice/browser.mjs with its SDK import faked), with two
 * test seams written into the staged copy only: the managed module's path can be pointed at a file that does not exist,
 * and the older channel's `openChannel` counts its calls. Around the page: a counting `AudioContext`, a recording
 * `speechSynthesis` and a counting `getUserMedia`. No network, no provider, no microphone.
 *
 * Every case here failed on the page before this change (the older channel opened, or an audio context was built, or the
 * browser's speech was used) and passes after it.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type Answer = () => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const webDir = ['apps/web', '.'].map(dir => resolve(process.cwd(), dir)).find(dir => existsSync(join(dir, 'public/app/aumalive.js'))) ?? 'apps/web'
const appDir = join(webDir, 'public/app')
const managedDir = join(webDir, 'scripts/stock-apps/managed-voice')
let stage = ''

const policy = await import(pathToFileURL(join(managedDir, 'policy.mjs')).href) as {
  LINES: Record<string, string>
  REFUSAL_LINES: Record<string, string>
}
const SIGN_IN = 'My voice needs your fingerprint sign-in on this browser. Typing works.'
const UNREACHABLE = 'My voice is not reachable right now. Typing works.'
const NOT_SET_UP = 'My voice is not set up on this host yet. Typing works.'
const CANVAS = 'Voice lives in Auma Live.'
const OLD_FIRST_WORDS = 'requesting microphone access…'

/** Everything the older voice would touch, counted; reset before each case. */
const seen = {
  answer: (): Response | Promise<Response> => json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400),
  voiceAsks: 0,
  sdkCalls: 0,
  audioContexts: 0,
  getUserMedia: 0,
  speech: [] as string[],
  speechArmed: false,
}
const counters = globalThis as unknown as { __openChannelCalls?: number; __managedVoicePath?: string }

let mountAumaLive: (root: HTMLElement, options?: Record<string, unknown>) => void = () => {}

const waitFor = async (check: () => boolean, what: string, ms = 4000) => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => { setTimeout(done, 5) })
  }
}
const settle = async (ms = 60) => { await new Promise((done) => { setTimeout(done, ms) }) }

beforeAll(async () => {
  stage = mkdtempSync(join(webDir, '.voice-old-unreachable-'))
  for (const name of readdirSync(appDir).filter(file => file.endsWith('.js') && file !== 'managed-voice.js')) {
    let source = readFileSync(join(appDir, name), 'utf8').replaceAll(' from \'/app/', ' from \'./')
    if (name === 'aumalive.js') {
      const seam = 'const MANAGED_VOICE_MODULE = \'/app/managed-voice.js\';'
      const load = 'import(MANAGED_VOICE_MODULE)'
      const channel = '  async function openChannel() {\n'
      for (const text of [seam, load, channel]) expect(source).toContain(text)
      source = source
        .replace(seam, `const MANAGED_VOICE_MODULE = ${JSON.stringify(join(stage, 'managed-voice.js'))};`)
        .replace(load, 'import(globalThis.__managedVoicePath ?? MANAGED_VOICE_MODULE)')
        .replace(channel, `${channel}    globalThis.__openChannelCalls = (globalThis.__openChannelCalls ?? 0) + 1;\n`)
    }
    writeFileSync(join(stage, name), source)
  }
  for (const name of ['controller.mjs', 'governed-turn.mjs', 'policy.mjs']) writeFileSync(join(stage, name), readFileSync(join(managedDir, name)))
  const sdkImport = 'import { Conversation } from \'@elevenlabs/client\''
  const browser = readFileSync(join(managedDir, 'browser.mjs'), 'utf8')
  expect(browser).toContain(sdkImport)
  writeFileSync(join(stage, 'browser.mjs'), browser.replace(sdkImport, 'const Conversation = globalThis.__managedVoiceSdk'))
  writeFileSync(join(stage, 'managed-voice.js'), 'export * from \'./browser.mjs\'\n')

  ;(globalThis as Record<string, unknown>).__managedVoiceSdk = {
    startSession: async () => { seen.sdkCalls += 1; return new Promise(() => {}) },
  }
  ;(window as unknown as Record<string, unknown>).__DSH_TRANSPORT__ = {
    fetch: async () => json({}, 503),
    openStream: () => { throw new Error('no stream in this test') },
  }
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
    if (path === '/_host/voice' && init?.body === '{"action":"managed_session"}') {
      seen.voiceAsks += 1
      const signal = init.signal
      return await new Promise<Response>((done, refuse) => {
        signal?.addEventListener('abort', () => { refuse(new DOMException('aborted', 'AbortError')) }, { once: true })
        Promise.resolve().then(seen.answer).then(done, refuse)
      })
    }
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }
  window.fetch = fakeFetch
  globalThis.fetch = fakeFetch
  window.requestAnimationFrame = () => 0
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => { seen.getUserMedia += 1; return new Promise<MediaStream>(() => {}) } },
  })
  // The older voice's audio graph: any construction is counted.
  class FakeAudioContext {
    state = 'running'
    destination = {}
    audioWorklet = { addModule: async () => {} }
    constructor() { seen.audioContexts += 1 }
    addEventListener() {}
    removeEventListener() {}
    async resume() {}
    async close() {}
  }
  class FakeWorkletNode {
    port = { postMessage: () => {}, onmessage: null }
    connect() {}
    disconnect() {}
  }
  Object.assign(window, { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode })
  // The browser's own speech: every read or write of it, once armed (the page lists its voices at mount), is recorded.
  const synth = new Proxy({}, {
    get(_target, key) {
      if (seen.speechArmed) seen.speech.push(String(key))
      if (key === 'getVoices') return () => []
      if (key === 'speaking') return false
      return () => {}
    },
    set(_target, key) { if (seen.speechArmed) seen.speech.push(`set ${String(key)}`); return true },
  })
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
  ;(window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
    text: string
    constructor(text = '') {
      this.text = text
      if (seen.speechArmed) seen.speech.push('new SpeechSynthesisUtterance')
    }
  }

  const managed = await import(pathToFileURL(join(stage, 'managed-voice.js')).href) as Record<string, unknown>
  expect(typeof managed.createManagedVoice).toBe('function')
  mountAumaLive = (await import(pathToFileURL(join(stage, 'aumalive.js')).href) as { mountAumaLive: typeof mountAumaLive }).mountAumaLive
})

afterAll(() => {
  if (stage) rmSync(stage, { recursive: true, force: true })
  delete counters.__managedVoicePath
  delete counters.__openChannelCalls
})

beforeEach(() => {
  seen.voiceAsks = 0; seen.sdkCalls = 0; seen.audioContexts = 0; seen.getUserMedia = 0; seen.speech = []; seen.speechArmed = false
  counters.__openChannelCalls = 0
  delete counters.__managedVoicePath
  localStorage.clear()
})

function mount(options: Record<string, unknown> = {}) {
  document.body.innerHTML = ''
  const root = document.createElement('div')
  document.body.append(root)
  mountAumaLive(root, options)
  const pick = (selector: string): HTMLElement => {
    const found = root.querySelector(selector)
    if (!(found instanceof HTMLElement)) throw new Error(`no ${selector}`)
    return found
  }
  const orb = pick('.alv-orb')
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
  const transcript = () => [...root.querySelectorAll('.alv-log-row')].map(row => [
    row.classList.contains('you') ? 'you' : 'auma', row.querySelector('.alv-log-txt')?.textContent ?? '',
  ])
  // From here on, anything that reads or writes the browser's speech is the older voice at work.
  seen.speechArmed = true
  return { root, orb, status, lines, type, transcript }
}

/** Nothing of the older voice ran: no channel, no audio context, no browser speech, no microphone, no provider call. */
function nothingOld(p: ReturnType<typeof mount>) {
  expect(counters.__openChannelCalls).toBe(0)
  expect(seen.audioContexts).toBe(0)
  expect(seen.speech).toEqual([])
  expect(seen.getUserMedia).toBe(0)
  expect(seen.sdkCalls).toBe(0)
  expect(p.lines).not.toContain(OLD_FIRST_WORDS)
}

describe('a managed voice that cannot start never starts another voice', () => {
  it('the page\'s copy of the "not reachable" line is the controller\'s own, and the two new lines are in its closed list', () => {
    expect(policy.LINES.unreachable).toBe(UNREACHABLE)
    expect(policy.LINES.signIn).toBe(SIGN_IN)
    expect(policy.REFUSAL_LINES.VOICE_NOT_CONFIGURED).toBe(NOT_SET_UP)
    expect(readFileSync(join(appDir, 'aumalive.js'), 'utf8')).toContain(`const VOICE_UNREACHABLE_LINE = '${UNREACHABLE}';`)
  })

  it('the managed module fails to load: the orb rests with "not reachable"; the next press asks for the module again', async () => {
    counters.__managedVoicePath = join(stage, 'no-such-managed-voice.js')
    const p = mount()
    p.orb.click()
    await waitFor(() => p.status.textContent === UNREACHABLE, 'the "not reachable" line')
    await settle()
    expect(p.orb.getAttribute('aria-busy')).toBe('false')
    expect(p.orb.getAttribute('aria-label')).toBe('Start Voice')
    expect(p.orb.className).not.toContain('live')
    expect(seen.voiceAsks).toBe(0)
    nothingOld(p)
    // The module is there again: the next press loads it and asks the edge.
    delete counters.__managedVoicePath
    seen.answer = () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
    p.orb.click()
    await waitFor(() => seen.voiceAsks === 1, 'the edge to be asked')
    await waitFor(() => p.status.textContent === SIGN_IN, 'the sign-in line')
    nothingOld(p)
  })

  it.each([
    ['401', () => json({ ok: false }, 401), SIGN_IN],
    ['403', () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403), SIGN_IN],
    ['500', () => new Response('boom', { status: 500 }), UNREACHABLE],
    ['a bad body', () => new Response('{"token":"short","maxDurationSeconds":"600"}', { status: 200 }), UNREACHABLE],
    ['the switch off (VOICE_MANAGED "0")', () => json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400), NOT_SET_UP],
  ] as Array<[string, Answer, string]>)('the edge answers %s: the orb rests with its one line and nothing older starts', async (_name, answer, line) => {
    seen.answer = answer
    const p = mount()
    p.orb.click()
    await waitFor(() => p.status.textContent === line, line)
    await settle()
    expect(seen.voiceAsks).toBe(1)
    expect(p.orb.getAttribute('aria-busy')).toBe('false')
    expect(p.orb.getAttribute('aria-label')).toBe('Start Voice')
    expect(p.orb.className).not.toContain('live')
    nothingOld(p)
  })

  it('the edge does not answer in 12 s: the orb rests with "not reachable" and nothing older starts', async () => {
    seen.answer = () => new Promise<Response>(() => {})
    // The controller's 12 s wait for the edge is shortened here (only that one number); every other timer is real.
    const realSetTimeout = globalThis.setTimeout
    const shortened = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 12_000 ? 20 : ms, ...rest)) as typeof setTimeout
    globalThis.setTimeout = shortened
    try {
      const p = mount()
      p.orb.click()
      await waitFor(() => p.status.textContent === UNREACHABLE, 'the "not reachable" line')
      await settle()
      expect(seen.voiceAsks).toBe(1)
      expect(p.orb.getAttribute('aria-busy')).toBe('false')
      nothingOld(p)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

describe('a typed turn outside a call is text only', () => {
  it('builds no audio context and nothing reads her answer aloud; her answer is in the transcript', async () => {
    const p = mount()
    p.type('what is on my list today')
    expect(p.transcript()[0]).toEqual(['you', 'what is on my list today'])
    // Her carrier refuses everything here, so her answer is the page's own sentence for it, written in the transcript.
    await waitFor(() => p.transcript().some(([role]) => role === 'auma'), 'her answer in the transcript', 9000)
    await settle()
    nothingOld(p)
  }, 15_000)
})

describe('the "her voice" picker is not shown', () => {
  const surfaces = [['Auma Live', {}], ['Auma Canvas', { mode: 'canvas' }]] as Array<[string, Record<string, unknown>]>
  it.each(surfaces)('in %s the gear panel has no voice list', (_name, options) => {
    const p = mount(options)
    const panel = p.root.querySelector('.alv-panel')
    expect(panel).toBeInstanceOf(HTMLElement)
    expect(p.root.querySelector('.alv-vlist')).toBeNull()
    expect([...p.root.querySelectorAll('.alv-group-k')].map(node => node.textContent)).not.toContain('her voice')
  })

  it('Auma Live keeps her mind in the gear panel', () => {
    const p = mount()
    expect([...p.root.querySelectorAll('.alv-group-k')].map(node => node.textContent)).toContain('her mind')
  })
})

describe('Auma Canvas has no voice of its own', () => {
  it('no microphone control, an orb that says where voice lives, and a press that starts nothing', async () => {
    const p = mount({ mode: 'canvas' })
    expect(p.root.querySelector('.alv-mute')).toBeNull()
    expect(p.orb.getAttribute('aria-label')).toBe(CANVAS)
    expect(p.orb.title).toBe(CANVAS)
    p.orb.click()
    await waitFor(() => p.status.textContent === CANVAS, 'the canvas line')
    await settle()
    expect(p.orb.getAttribute('aria-label')).toBe(CANVAS)
    expect(seen.voiceAsks).toBe(0)
    nothingOld(p)
  })

  it('its gear panel offers no PersonaPlex microphone control and identifies the active voice UI', () => {
    const canvas = mount({ mode: 'canvas' })
    const canvasPanel = canvas.root.querySelector('.alv-panel')
    expect(canvasPanel).toBeInstanceOf(HTMLElement)
    expect(canvas.root.querySelector('.alv-persona-form')).toBeNull()
    expect([...canvas.root.querySelectorAll('button')].map(node => node.textContent)).not.toContain('Start full duplex')
    expect(canvasPanel?.textContent).toContain(CANVAS)
    const live = mount()
    expect(live.root.querySelector('.alv-persona-form')).toBeInstanceOf(HTMLElement)
    expect(live.root.querySelector('.alv-panel')?.textContent).not.toContain(CANVAS)
  })

  it('framed inside Aukora, a typed turn reaches the selected Agent with no audio context and nothing read aloud', async () => {
    // The page as Aukora frames it: a parent window that is not this one (it records what the page posts), and a live
    // selection, so the typed turn goes past the "open it inside Aukora" stop to the Agent call.
    const posted: unknown[] = []
    const fakeParent = { postMessage: (message: unknown) => { posted.push(message) }, navigator: {} }
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent')
    Object.defineProperty(window, 'parent', { configurable: true, get: () => fakeParent })
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'canvas-thread' }))
    // The page's Agent carrier is genesis-live.js's single instance; its streamTurn is replaced for this case only.
    const live = await import(pathToFileURL(join(stage, 'genesis-live.js')).href) as {
      genesisLiveFetch: (fetch: typeof window.fetch) => { streamTurn: (options: Record<string, unknown>) => Promise<unknown> }
    }
    const carrier = live.genesisLiveFetch(window.fetch)
    const realStreamTurn = carrier.streamTurn
    const turns: Array<Record<string, unknown>> = []
    carrier.streamTurn = async (options) => {
      turns.push(options)
      ;(options.onToken as (value: string) => void)('The garden is drawn.')
      return { reason: 'done' }
    }
    try {
      expect(window.parent).not.toBe(window)
      const p = mount({ mode: 'canvas' })
      p.type('draw the garden')
      await waitFor(() => p.transcript().some(([role]) => role === 'auma'), 'her answer in the transcript')
      await settle()
      expect(turns).toHaveLength(1)
      expect(turns[0]).toMatchObject({ sessionId: 'canvas-thread', text: 'draw the garden', visual: true })
      expect(p.transcript()).toContainEqual(['auma', 'The garden is drawn.'])
      expect(p.lines).not.toContain('Open Auma Canvas inside Aukora so it can reach the selected Agent.')
      expect(posted.length).toBeGreaterThan(0)
      nothingOld(p)
    } finally {
      carrier.streamTurn = realStreamTurn
      if (parentDescriptor) Object.defineProperty(window, 'parent', parentDescriptor)
      else delete (window as unknown as Record<string, unknown>).parent
    }
  })

  it('typing works exactly as before: the line is in the transcript and the canvas says where its turns go', async () => {
    const p = mount({ mode: 'canvas' })
    p.type('draw the garden')
    expect(p.transcript()[0]).toEqual(['you', 'draw the garden'])
    await waitFor(() => p.status.textContent === 'Open Auma Canvas inside Aukora so it can reach the selected Agent.', 'the canvas typed-turn line')
    await settle()
    nothingOld(p)
  })
})
