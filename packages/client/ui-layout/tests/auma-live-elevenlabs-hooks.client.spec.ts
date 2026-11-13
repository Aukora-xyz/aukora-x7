/**
 * The VOICE hooks in Auma Live's page scripts. aumalive.js and genesis-live.js cannot run here whole, so the hooks are
 * read as text (exactly twelve marked lines in aumalive.js, five in the player worklet, none in genesis-live.js, and the
 * Deepgram path's pinned lines still there byte for byte), and then RUN: aumalive.js's own VoiceLink, speech handlers,
 * speakChunk, bargeIn and voice-picker click are lifted from its text and driven together with the real wrapper
 * (elevenlabs-voice.js) and the real player worklet (aumalive-audio.js), so "no sample of turn A is played after turn B's
 * first sample" is checked on the samples the player actually puts out.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const appFile = (name: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`)).find(existsSync) ?? `apps/web/public/app/${name}`
const page = readFileSync(appFile('aumalive.js'), 'utf8')
const live = readFileSync(appFile('genesis-live.js'), 'utf8')
const worklet = readFileSync(appFile('aumalive-audio.js'), 'utf8')
const marked = (text: string) => text.split('\n').map((line, index) => ({ line, index })).filter(entry => entry.line.includes('VOICE hook'))
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`not found: ${start} … ${end}`)
  return text.slice(from, to)
}

describe('the hooks in aumalive.js', () => {
  it('are exactly twelve lines, each where it belongs', () => {
    const lines = marked(page).map(entry => entry.line.trim())
    expect(lines).toEqual([
      'import { speechSocketFor, phraseCut, showHerVoiceLine, ELEVEN_VOICE_PICK } from \'/app/elevenlabs-voice.js\'; // VOICE hook',
      'try { ws = speechSocketFor(`${SIDECAR_WS}?owner=${encodeURIComponent(this.owner)}`, { inner: voiceSocketFor }); } catch { this.retry(); return; } // VOICE hook',
      'let speechTurn = 0; const herVoiceOffered = () => voice.voices.some(v => v?.id === ELEVEN_VOICE_PICK); '
        + '// VOICE hook: the player\'s speech turn, counted only while her ElevenLabs voice is offered',
      'if (herVoiceOffered()) { playerNode.port.postMessage({ cmd: \'push\', pcm: arrayBuf, turn: speechTurn }, [arrayBuf]); return; } // VOICE hook',
      'function cutSpeechTurn() { speechTurn += 1; playerNode?.port.postMessage({ cmd: \'turn\', turn: speechTurn }); '
        + 'if (ttsRequests.size > 0) staleSpeech = true; dropHer(); } '
        + '// VOICE hook: a turn-scoped cut, at once, before a replacement turn is admitted',
      'if (voice.ws?.herEcho?.(text, herStillAudible(), isSelfEcho)) { duplexGate.selfEchoes = (duplexGate.selfEchoes || 0) + 1; return; } // VOICE hook',
      'speech_notice(m) { if (typeof m.say === \'string\' && m.say) toast(m.say.slice(0, 160), 7000); }, // VOICE hook',
      'if (herVoiceOffered()) { bargeIn(); cutSpeechTurn(); } // VOICE hook',
      'showHerVoiceLine(voiceList, voice.ws); // VOICE hook',
      'if (panelOpen) showHerVoiceLine(voiceList, voice.ws); // VOICE hook',
      'if (first && duplex && herVoiceOffered()) cutSpeechTurn(); // VOICE hook',
      'if (chosenVoice === ELEVEN_VOICE_PICK) { const phraseEnd = phraseCut(tail, firstFlush); if (phraseEnd > 0) { speakChunk(tail.slice(0, phraseEnd), firstFlush); sentTo += phraseEnd; firstFlush = false; } return; } // VOICE hook',
    ])
    // Placement: the state beside lastSpoken; the tagged push right after the player check; the cut before cutHerVoice
    // (outside what the stale-tail spec lifts); the echo check before the existing one; the picker cut first in its click;
    // the turn cut in speakChunk before anything of the new turn is asked for.
    const at = (index: number) => marked(page)[index]?.line ?? '?'
    expect(page).toContain(`  let lastSpokenAt = Number.NEGATIVE_INFINITY;\n${at(2)}\n`)
    expect(page).toContain(`    if (!ctx || !playerNode) return;\n${at(3)}\n`)
    expect(page).toContain(`${at(4)}\n\n  function cutHerVoice() {\n`)
    expect(page).toContain(`      if (!text) return;\n${at(5)}\n      // HER OWN SENTENCE IS NOT A USER TURN`)
    expect(page).toContain(`      b.addEventListener('click', async () => {\n${at(7)}\n        chosenVoice = v.id; voicePicked = true;\n`)
    expect(page).toContain(`    lastSpoken = t;\n    lastSpokenAt = performance.now();\n${at(10)}\n    if (duplex) {\n`)
    expect(page.match(/voiceSocketFor\(/g) ?? []).toHaveLength(0)
    expect(page.match(/speechSocketFor\(/g)).toHaveLength(1)
  })

  it('the cadence hook sits after the end-of-turn line and before the Flux cadence, which is untouched', () => {
    const endOfTurn = page.indexOf('      if (endOfTurn) { speakChunk(tail, firstFlush); sentTo = full.length; firstFlush = false; return; }\n')
    const hook = page.indexOf('      if (chosenVoice === ELEVEN_VOICE_PICK) {')
    const flux = page.indexOf('      if (!firstFlush && tail.length < 900) return;')
    expect(endOfTurn).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(endOfTurn)
    expect(flux).toBeGreaterThan(hook)
    expect(page.slice(endOfTurn, hook).split('\n')).toHaveLength(2)
    for (const pinned of [
      '        const firstMatch = tail.match(/[.!?…]["\'”’»)\\]]?(?=\\s|$)/);',
      '        if (cut < 0 && tail.length > 180) { const c = tail.lastIndexOf(\', \'); if (c > 80) cut = c + 1; }',
      '        for (const m of tail.matchAll(/[.!?…]["\'”’»)\\]]?(?=\\s|$)/g)) {',
      '      if (cut > 0) { speakChunk(tail.slice(0, cut), firstFlush); sentTo += cut; firstFlush = false; }',
    ]) expect(page).toContain(pinned)
  })

  it('the notice handler follows err(m), and the pinned anchors and the Deepgram import are byte for byte', () => {
    const errAt = page.indexOf('    err(m) {')
    const noticeAt = page.indexOf('    speech_notice(m) {')
    expect(noticeAt).toBeGreaterThan(errAt)
    expect(page.slice(errAt, noticeAt)).not.toContain('\n    }\n')
    expect(page).toContain('import { voiceSocketFor, forgetNoPass, voiceInputPlan, ORGAN_WAIT_MS } from \'/app/deepgram-voice.js\';\n')
    for (const anchor of ['    tts_begin(m) {', '    err(m) {', '  function cutHerVoice() {', '  // ---- sidecar events ----', '    vad(m) {', '    final(m) {',
      'const echoWindowOpen = herStillAudible() || (performance.now() - lastSpokenAt) <= 1500;',
      '      if (echoWindowOpen && isSelfEcho(text, lastSpoken)) {', '    lastSpoken = t;\n',
      'const selfIndex = createSelfIndexReader({ transport: () => findTransport() });']) expect(page).toContain(anchor)
    expect(marked(page)[6]?.line).toContain('toast(m.say.slice(0, 160), 7000)')
  })

  it('the player worklet gains one message type, "turn", and the frames carry their turn to play time', () => {
    expect(marked(worklet).map(entry => entry.line.trim())).toEqual([
      expect.stringMatching(/^this\.turn = 0; \/\/ VOICE hook/),
      'if (Number.isSafeInteger(m.turn) && m.turn < this.turn) return; // VOICE hook',
      'if (Number.isSafeInteger(m.turn)) pcm.turn = m.turn; // VOICE hook',
      'else if (m.cmd === \'turn\') { if (Number.isSafeInteger(m.turn) && m.turn > this.turn) { this.turn = m.turn; this.clear(); } } '
        + '// VOICE hook: a new speech turn drops every queued frame at once',
      'if (head.turn !== undefined && head.turn < this.turn) { this.available -= head.length - this.qi; this.q.shift(); this.qi = 0; continue; } // VOICE hook',
    ])
    expect([...worklet.matchAll(/m\.cmd === '(\w+)'/g)].map(match => match[1])).toEqual(['begin', 'push', 'end', 'cut', 'clear', 'turn'])
  })
})

describe('genesis-live.js carries no hook', () => {
  it('no marked line, and no model selection from Auma Live', () => {
    expect(marked(live)).toEqual([])
    expect(live).not.toContain('session/selectModel')
    expect(live).not.toContain('deepseek-flash')
  })
})

// SHOULD 2: the three behavioural cases, restored beside the literal checks above. genesis-live.js RUNS here
// against a fake DSH: `/minds` finds or makes the voice session, keeps its identity, and calls no settings RPC.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const genesis = await import(pathToFileURL(appFile('genesis-live.js')).href) as {
  createGenesisLive: (options: Record<string, unknown>) => { fetch: (url: string, init?: RequestInit) => Promise<Response> }
  AUMA_LIVE_VOICE_SESSION_KEY: string
  AUMA_LIVE_VOICE_TITLE: string
}
const memory = () => {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } }
}
const fakeDsh = (items: Array<{ sessionId: string; title?: string }>, selectModel: () => Promise<Response> | Response) => {
  const rpcs: Array<{ method: string; args: Record<string, unknown> }> = []
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      const method = path.replace('/api/', '')
      const args = (JSON.parse(init.body) as { payload: { args: Record<string, unknown> } }).payload.args
      rpcs.push({ method, args })
      if (method === 'session/list') return json({ result: { ok: true, value: { items } } })
      if (method === 'session/create') { items.push({ sessionId: 's-new' }); return json({ result: { ok: true, value: { sessionId: 's-new' } } }) }
      if (method === 'session/selectModel') return await selectModel()
      return json({ result: { ok: true, value: {} } })
    },
    openStream: () => { throw new Error('unexpected stream') },
  }
  return { transport, rpcs }
}
const homeOf = async (g: { fetch: (url: string) => Promise<Response> }) => ((await (await g.fetch('http://localhost/api/auma-live/minds')).json()) as { homeSession?: string }).homeSession

describe('opening Auma Live never changes the model of any thread', () => {
  for (const [name, items, storedId, expected] of [
    ['a created session', [], null, 's-new'],
    ['a titled session', [{ sessionId: 's-titled', title: '[voice] Auma Live' }], null, 's-titled'],
    ['the stored session', [{ sessionId: 's-stored', title: '[voice] Auma Live' }], 's-stored', 's-stored'],
  ] as const) {
    it(`${name}: the voice session is found or made, and no model is selected`, async () => {
      expect(genesis.AUMA_LIVE_VOICE_TITLE).toBe('[voice] Auma Live')
      const storage = memory()
      if (storedId) storage.setItem(genesis.AUMA_LIVE_VOICE_SESSION_KEY, storedId)
      const { transport, rpcs } = fakeDsh([...items], () => json({ result: { ok: true, value: {} } }))
      const g = genesis.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}, 404), storage })
      expect(await homeOf(g)).toBe(expected)
      expect(await homeOf(g)).toBe(expected)
      // The identity is kept: the session found or made is the one stored for the next opening.
      expect(storage.getItem(genesis.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(expected)
      expect(rpcs.map(call => call.method).filter(method => !['session/list', 'session/create', 'session/rename'].includes(method))).toEqual([])
    })
  }
})

// ---- the real player worklet ----
type PlayerMessage = { cmd: string; pcm?: ArrayBuffer; turn?: number; id?: number; sampleRate?: number }
function makePlayer() {
  interface PlayerNode {
    port: { onmessage: ((event: { data: PlayerMessage }) => void) | null }
    process: (inputs: unknown[], outputs: Float32Array[][]) => boolean
  }
  const registered = new Map<string, new () => PlayerNode>()
  class AudioWorkletProcessor { port = { onmessage: null as ((event: { data: PlayerMessage }) => void) | null, postMessage: () => {} } }
  const registerProcessor = (name: string, cls: never) => { registered.set(name, cls) }
  runInNewContext(worklet, { AudioWorkletProcessor, registerProcessor, sampleRate: 24000, Number, Math, Int16Array, Float32Array })
  const Player = registered.get('alv-player')
  if (!Player) throw new Error('alv-player not registered')
  const node = new Player()
  const played: number[] = []
  return {
    port: { postMessage: (message: PlayerMessage) => { node.port.onmessage?.({ data: message }) } },
    /** Renders `blocks` render quanta and keeps every sample put out, as the Int16 value it came from. */
    render(blocks: number) {
      for (let block = 0; block < blocks; block += 1) {
        const out = [new Float32Array(128)]
        node.process([], [out])
        for (const sample of out[0] ?? []) if (sample !== 0) played.push(Math.round(sample * 32768))
      }
    },
    played,
  }
}
const pcmOf = (value: number, samples: number) => {
  const words = new Int16Array(samples).fill(value)
  return new Uint8Array(words.buffer)
}

describe('the player worklet: a turn cut is at once, and checked again at play time', () => {
  it('a "turn" drops every queued frame of the old turn at once; a late frame of it is refused; untagged frames play as before', () => {
    const player = makePlayer()
    player.port.postMessage({ cmd: 'begin', id: 1, sampleRate: 24000 })
    player.port.postMessage({ cmd: 'push', pcm: pcmOf(1000, 6000).buffer, turn: 1 })
    player.render(10)
    expect(player.played.every(value => value === 1000)).toBe(true)
    expect(player.played.length).toBeGreaterThan(0)
    player.port.postMessage({ cmd: 'turn', turn: 2 })
    player.port.postMessage({ cmd: 'push', pcm: pcmOf(1000, 500).buffer, turn: 1 })
    player.port.postMessage({ cmd: 'begin', id: 2, sampleRate: 24000 })
    player.port.postMessage({ cmd: 'push', pcm: pcmOf(2000, 6000).buffer, turn: 2 })
    player.render(40)
    const firstB = player.played.indexOf(2000)
    expect(firstB).toBeGreaterThan(0)
    expect(player.played.slice(firstB).every(value => value === 2000)).toBe(true)
    // Exactly what had played of turn 1 before the cut, and not one sample more.
    expect(player.played.slice(0, firstB).length).toBe(1280)
    const plain = makePlayer()
    plain.port.postMessage({ cmd: 'begin', id: 1, sampleRate: 24000 })
    plain.port.postMessage({ cmd: 'push', pcm: pcmOf(3000, 4400).buffer })
    plain.port.postMessage({ cmd: 'turn', turn: 5 })
    plain.port.postMessage({ cmd: 'begin', id: 2, sampleRate: 24000 })
    plain.port.postMessage({ cmd: 'push', pcm: pcmOf(3000, 4400).buffer })
    plain.port.postMessage({ cmd: 'end', id: 2 })
    plain.render(40)
    expect(plain.played).toHaveLength(4400)
  })
})

// ---- aumalive.js's own voice path, lifted and run with the real wrapper and the real player ----
const eleven = await import(pathToFileURL(appFile('elevenlabs-voice.js')).href) as {
  speechSocketFor: (url: string, deps: Record<string, unknown>) => unknown
  showHerVoiceLine: (list: unknown, socket: unknown) => void
  ELEVEN_VOICE_PICK: string
}
const duplexModule = await import(pathToFileURL(appFile('aumalive-duplex.js')).href) as { isSelfEcho: (heard: string, spoken: string) => boolean }

async function until(condition: () => boolean, label: string, limitMs = 2000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (condition()) return
    if (Date.now() - started > limitMs) throw new Error(`timed out after ${String(limitMs)} ms waiting for: ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

class Upstream {
  static all: Upstream[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) { Upstream.all.push(this) }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  audio(context: string, value: number, samples: number) { this.onmessage?.({ data: JSON.stringify({ audio: Buffer.from(pcmOf(value, samples)).toString('base64'), contextId: context }) }) }
}

function stage() {
  Upstream.all = []
  let passRead = false
  const inner = {
    readyState: 1, cloud: 'Deepgram', sent: [] as string[],
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send(data: string) { inner.sent.push(data); if ((JSON.parse(data) as { t: string }).t === 'tts_cancel') inner.emit({ t: 'tts_cancelled' }) },
    close() {},
    emit(message: unknown) { inner.onmessage?.({ data: JSON.stringify(message) }) },
    pcm(value: number, samples: number) { inner.onmessage?.({ data: pcmOf(value, samples).buffer }) },
  }
  const fetchImpl = async (_path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { action: string }
    if (body.action === 'speech_pass') {
      const response = Response.json({ ok: true, provider: 'deepgram', accessToken: 'p'.repeat(40), expiresInSeconds: 30, herVoice: { configured: true } })
      const clone = response.clone.bind(response)
      const copied = () => {
        const copy = clone()
        const json = copy.json.bind(copy)
        return Object.assign(copy, { json: () => json().finally(() => { passRead = true }) })
      }
      return Object.assign(response, { clone: copied })
    }
    if (body.action === 'speech_usage') return Response.json({ ok: true, action: 'speech_usage' })
    return Response.json({ ok: true, provider: 'elevenlabs', pass: 'sutkn_' + 'q'.repeat(30), voiceId: 'VoiceId_12345', modelId: 'eleven_flash_v2_5', reservation: '2026-11-13.1',
      usage: { day: '2026-11-13', chars: 0, counted: 5000, maxChars: 100000, cost: 0, maxCost: 4, pricePer1k: 0.04, slice: 5000 } })
  }
  const player = makePlayer()
  const turns: string[] = []
  const context: Record<string, unknown> = {
    SIDECAR_WS: 'wss://x61.example.invalid/stock-apps/auma-live/voice', ELEVEN_VOICE_PICK: eleven.ELEVEN_VOICE_PICK,
    voiceSocketFor: (_url: string, deps: { fetchImpl: typeof fetchImpl }) => { void deps.fetchImpl('/_host/voice', { body: JSON.stringify({ action: 'speech_pass' }) }).then(r => r.json()); return inner },
    speechSocketFor: (url: string, deps: Record<string, unknown>) => eleven.speechSocketFor(url, {
      ...deps, WebSocketImpl: Upstream, fetchImpl, now: () => Date.UTC(2026, 10, 13, 12), setTimer: () => ({}), clearTimer: () => {},
    }),
    showHerVoiceLine: eleven.showHerVoiceLine, isSelfEcho: duplexModule.isSelfEcho,
    setTimeout, clearTimeout, performance: { now: () => 1 }, ctx: {}, playerNode: player,
    duplexGate: { herSpeaking: () => {}, selfEchoes: 0 },
    clearReplyWatchdog: () => {}, armReplyWatchdog: () => {}, stopBrowserVoice: () => {},
    speakFallback: () => {}, toast: () => {}, organName: () => 'Deepgram cloud voice', settleIfDone: () => {}, sanitizeForVoice: (text: string) => text,
    requestTurn: (text: string) => { turns.push(text) },
    populateVoices: () => {}, setOrb: () => {}, stopRecog: () => {}, ensureAudio: async () => {},
    voiceList: { children: [] }, micMuted: false, channel: true, JSON, Number, Map, encodeURIComponent,
  }
  const pick = between(page, '      b.addEventListener(\'click\', async () => {\n', '\n      });\n      voiceList.append(b);').split('\n').slice(1).join('\n')
  const script = [
    'let duplex = false, herAudible = false, ttsPending = 0, ttsId = 0, staleSpeech = false, lastSpoken = "", lastSpokenAt = Number.NEGATIVE_INFINITY;',
    'let ttsQueueFb = 0, chosenVoice = "auma", voicePicked = false, curAbort = null, playbackLeaseRefresh = 0; const ttsRequests = new Map();',
    between(page, 'const voice = {\n', '\n};\n') + '\n};',
    marked(page)[2]?.line ?? '',
    between(page, '  function pushPcm(arrayBuf) {', '  function refreshPlaybackLeases() {'),
    between(page, '  function dropHer() {', '  // ---- sidecar events ----'),
    between(page, '  voice.on = {', '\n  };\n') + '\n  };',
    between(page, '  function speakChunk(text, first) {', '  function voiceChunks('),
    between(page, '  function herStillAudible()', '\n'),
    between(page, '  function bargeIn() {', '  // one honest announcement'),
    `async function pick(v, b) {\n${pick}\n}`,
    '({ voice, speakChunk, bargeIn, pick, state: () => ({ ttsRequests, staleSpeech, speechTurn, chosenVoice }) })',
  ].join('\n')
  const page_ = runInNewContext(script, context) as {
    voice: {
      enable: (owner: string) => void
      ws: unknown
      ready: boolean
      voices: Array<{ id: string }>
      on: Record<string, (m: unknown) => void>
    }
    speakChunk: (text: string, first: boolean) => void
    pick: (v: { id: string }, b: unknown) => Promise<void>
    state: () => { ttsRequests: Map<number, unknown>; speechTurn: number; chosenVoice: string }
  }
  return { page: page_, inner, player, turns, passRead: () => passRead }
}
const herSocket = () => Upstream.all.find(socket => socket.url.startsWith('wss://api.elevenlabs.io/'))
const ready = async () => {
  const s = stage()
  s.page.voice.enable('0000000000001:a:000001')
  await until(s.passRead, 'the pass answer read')
  s.inner.emit({ t: 'ready', voices: [{ id: 'flux-sienna-en', label: 'Sienna', hint: '', engine: 'deepgram' }], default_voice: 'flux-sienna-en', cloud: 'Deepgram' })
  expect(s.page.voice.ready).toBe(true)
  expect(s.page.voice.voices[0]?.id).toBe(eleven.ELEVEN_VOICE_PICK)
  await until(() => herSocket() !== undefined, 'her socket opened')
  herSocket()?.open()
  return s
}

describe('MUST 4 and 5, run: no sample of turn A is played after turn B\'s first sample', () => {
  it('his first sequence: turn A\'s audio is queued, turn B arrives with first: true and no cancel from the page', async () => {
    const s = await ready()
    s.page.speakChunk('Turn A starts here.', true)
    herSocket()?.audio('auma-1', 1000, 6000)
    s.player.render(10)
    expect(s.player.played.length).toBe(1280)
    s.page.speakChunk('Turn B.', true)
    herSocket()?.audio('auma-1', 1000, 600)            // a late frame of A's context
    herSocket()?.audio('auma-2', 2000, 6000)
    s.player.render(60)
    const firstB = s.player.played.indexOf(2000)
    expect(firstB).toBe(1280)
    expect(s.player.played.slice(firstB).every(value => value === 2000)).toBe(true)
    expect(s.page.state().speechTurn).toBe(2)
  })

  it('his second sequence: her reply plays, the owner picks a Deepgram voice, and its preview never plays beside her', async () => {
    const s = await ready()
    s.page.speakChunk('Her reply goes on and on.', true)
    herSocket()?.audio('auma-1', 1000, 6000)
    s.player.render(10)
    await s.page.pick({ id: 'flux-sienna-en' }, {})
    expect(s.page.state().chosenVoice).toBe('flux-sienna-en')
    // Her reply was cut first: the wrapper closed its context and the inner socket was told to cancel, then the preview.
    expect(herSocket()?.sent.map(data => JSON.parse(data) as Record<string, unknown>).at(-1)).toEqual({ context_id: 'auma-1', close_context: true })
    expect(s.inner.sent.map(data => (JSON.parse(data) as { t: string }).t).filter(t => t.startsWith('tts'))).toEqual(['tts_cancel', 'tts'])
    herSocket()?.audio('auma-1', 1000, 600)             // her audio still on the wire
    const preview = JSON.parse(s.inner.sent.at(-1) ?? '{}') as { id: number }
    s.inner.emit({ t: 'tts_begin', id: preview.id, sr: 24000 })
    s.inner.pcm(3000, 6000)
    s.inner.emit({ t: 'tts_end', id: preview.id })
    s.player.render(60)
    const firstDeepgram = s.player.played.indexOf(3000)
    expect(firstDeepgram).toBeGreaterThan(0)
    expect(s.player.played.slice(firstDeepgram).every(value => value === 3000)).toBe(true)
    expect(s.player.played.slice(0, firstDeepgram).every(value => value === 1000)).toBe(true)
  })

  it('MUST 6, run: while her phrases are spoken, the recogniser\'s "Good morning" is not a turn; "Stop" still is', async () => {
    const s = await ready()
    s.page.speakChunk('Good morning.', true)
    s.page.speakChunk('Rain is coming later.', false)
    herSocket()?.audio('auma-1', 1000, 600)
    s.page.voice.on.final?.({ text: 'Good morning' })
    expect(s.turns).toEqual([])
    s.page.voice.on.final?.({ text: 'Stop.' })
    expect(s.turns).toEqual(['Stop.'])
  })
})
