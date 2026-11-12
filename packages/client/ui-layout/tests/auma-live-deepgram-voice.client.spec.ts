/**
 * Auma Live's voice organ over Deepgram (apps/web/public/app/deepgram-voice.js): the page-side answer to the sidecar
 * protocol `VoiceLink` (aumalive.js) already speaks. The Deepgram stand-in below answers exactly as Deepgram was observed
 * to (SpeechStarted / Results with is_final and speech_final / UtteranceEnd on the listening stream; audio
 * frames, Flushed, and Clear answered by Cleared on an Aura-2 speaking stream). Her default voice is Sienna, Deepgram's
 * Flux `flux-sienna-en` on /v2/speak, answered here in Flux's own frames exactly as Deepgram sent them to a
 * browser-equivalent socket with a pass (Connected 'sienna'; per sentence SpeechStarted, Flushed before the audio, audio,
 * SpeechMetadata; Interrupt answered by SpeechInterrupted; Clear refused; idle streams closed at 60 s unless sent a Flush).
 * What is tested is the translation and its failure paths; the runs against Deepgram are recorded in the file's header.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

const modulePath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/deepgram-voice.js`)).find(existsSync)
interface VoiceSocket {
  binaryType: string
  readyState: number
  cloud: string | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}
const mod = await import(pathToFileURL(modulePath ?? 'apps/web/public/app/deepgram-voice.js').href) as {
  voiceSocketFor: (url: string, deps: Record<string, unknown>) => VoiceSocket
  forgetNoPass: () => void
  DEEPGRAM_VOICES: readonly { id: string; label: string; hint: string; engine: string }[]
  DEEPGRAM_DEFAULT_VOICE: string
  speakUrlFor: (voice: string) => string
  NO_PASS_MEMORY_MS: number
  SPEAK_TIMEOUT_MS: number
  SPEAK_PIECE_CHARS: number
  DISCARD_MS: number
  FLUX_KEEPALIVE_MS: number
}

/** A socket as the adapter opens them; the test plays Deepgram (or the old sidecar) on the other end. */
class Upstream {
  static all: Upstream[] = []
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<string | ArrayBuffer> = []
  constructor(readonly url: string, readonly protocols?: string[]) { Upstream.all.push(this) }
  send(data: string | ArrayBuffer) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  json(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  audio(bytes: number[]) { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }) }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
  get said() { return this.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item) as Record<string, unknown>) }
}
const PASS = 'p'.repeat(40)
const URL_ = 'wss://x61.example.invalid/stock-apps/auma-live/voice?owner=0000000000001:a:000001'
const flush = async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve() }
const harness = (options: { pass?: unknown; status?: number; raw?: string } = {}) => {
  const asked: unknown[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let at = 1_000
  const deps = {
    WebSocketImpl: Upstream,
    BroadcastChannelImpl: undefined,
    now: () => at,
    setTimer: (fn: () => void, ms: number) => { const timer = { fn, ms }; timers.push(timer); return timer },
    clearTimer: (handle: unknown) => { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1) },
    fetchImpl: async (path: string, init: { body: string }) => {
      asked.push([path, JSON.parse(init.body)])
      // `raw` is a body sent as it is (a gateway's plain-text 503, say); otherwise the body is JSON.
      return new Response(options.raw ?? JSON.stringify('pass' in options ? options.pass
        : { ok: true, provider: 'deepgram', accessToken: PASS, expiresInSeconds: 30 }), { status: options.status ?? 200 })
    },
  }
  const received: unknown[] = []
  const closes: number[] = []
  const socket = mod.voiceSocketFor(URL_, deps)
  socket.onmessage = (event) => { received.push(typeof event.data === 'string' ? JSON.parse(event.data) : new Uint8Array(event.data as ArrayBuffer)) }
  socket.onclose = (event) => { closes.push(event.code) }
  const types = () => received.map(item => (item instanceof Uint8Array ? `pcm:${String(item.length)}` : (item as { t: string }).t))
  return { socket, deps, asked, timers, received, closes, types, advance: (ms: number) => { at += ms } }
}
const listening = () => Upstream.all.find(socket => socket.url.includes('/v1/listen'))
/** Every speaking stream opened, Flux (/v2/speak) and Aura-2 (/v1/speak) alike, in order. */
const speaking = () => Upstream.all.filter(socket => /\/v[12]\/speak\?/.test(socket.url))
const SIENNA = 'flux-sienna-en'
const THALIA = 'aura-2-thalia-en'
const SIENNA_URL = 'wss://api.deepgram.com/v2/speak?model=flux-sienna-en&encoding=linear16&sample_rate=24000&mip_opt_out=true'
const auraUrl = (voice: string) => `wss://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=24000&mip_opt_out=true`
/** Flux says it is ready, in the voice it was opened in (AUKORA.xyz's fixture gives the short name). */
const connected = (stream: Upstream | undefined, modelName = 'sienna') => { stream?.json({ type: 'Connected', model_name: modelName }) }
/** Open the organ: the pass, the listening stream, and the Sienna stream it warms up. */
const live = async (options?: Parameters<typeof harness>[0]) => {
  const h = harness(options)
  await flush()
  listening()?.open()
  await flush()
  speaking()[0]?.open()
  connected(speaking()[0])
  await flush()
  return h
}
/** Ask for one sentence in an Aura-2 voice and open the stream it needs (its own pass, then the socket). */
const aura = async (h: ReturnType<typeof harness>, id: number, text: string, voice = THALIA) => {
  h.socket.send(JSON.stringify({ t: 'tts', id, text, voice, speed: 1, first: id === 1 }))
  await flush()
  const stream = speaking().at(-1)
  if (stream?.readyState === 0) { stream.open(); await flush() }
  return stream
}

beforeEach(() => { Upstream.all = []; mod.forgetNoPass() })

describe('Auma Live voice over Deepgram: the sidecar protocol, answered in the page', () => {
  it('asks its own host for a pass, opens Deepgram with it and never with a key, and says it is a cloud organ', async () => {
    const h = await live()
    expect(h.asked).toEqual([['/_host/voice', { action: 'speech_pass' }], ['/_host/voice', { action: 'speech_pass' }]])
    const listen = listening()
    expect(listen?.url).toContain('wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1')
    expect(listen?.url).toMatch(/&mip_opt_out=true$/)
    expect(listen?.protocols).toEqual(['bearer', PASS])
    // Her voice is Sienna, as on AUKORA.xyz, and its stream is opened at once, on Flux, with the same kind of pass.
    expect(mod.DEEPGRAM_DEFAULT_VOICE).toBe(SIENNA)
    expect(speaking().map(stream => [stream.url, stream.protocols])).toEqual([[SIENNA_URL, ['bearer', PASS]]])
    expect(mod.DEEPGRAM_VOICES.map(voice => [voice.id, voice.label])).toEqual([[SIENNA, 'Sienna'], [THALIA, 'Thalia'],
      ['aura-2-andromeda-en', 'Andromeda'], ['aura-2-helena-en', 'Helena'], ['aura-2-apollo-en', 'Apollo']])
    expect(mod.DEEPGRAM_VOICES[0]?.hint).toBe('natural and expressive · Deepgram')
    expect(mod.DEEPGRAM_VOICES.map(voice => mod.speakUrlFor(voice.id)))
      .toEqual([SIENNA_URL, ...mod.DEEPGRAM_VOICES.slice(1).map(voice => auraUrl(voice.id))])
    expect(Upstream.all.every(socket => !socket.url.includes(PASS) && !socket.url.includes('token'))).toBe(true)
    expect(h.socket.readyState).toBe(1)
    expect(h.socket.cloud).toBe('Deepgram')
    expect(h.received[0]).toEqual({ t: 'ready', voices: mod.DEEPGRAM_VOICES, default_voice: mod.DEEPGRAM_DEFAULT_VOICE, cloud: 'Deepgram' })
    // The picker's shape, and no entry posing as one of the local sidecar's engines.
    expect(mod.DEEPGRAM_VOICES.every(voice => voice.engine === 'deepgram' && voice.hint.includes('Deepgram'))).toBe(true)
  })

  it('microphone frames go to Deepgram as they are; one `final` per utterance, joined from the stretches it is sure of', async () => {
    const h = await live()
    const frame = new Int16Array(640).fill(7).buffer
    h.socket.send(frame)
    expect(listening()?.sent).toEqual([frame])
    const results = (transcript: string, isFinal: boolean, speechFinal: boolean) => ({ type: 'Results', is_final: isFinal, speech_final: speechFinal,
      channel: { alternatives: [{ transcript }] } })
    listening()?.json({ type: 'SpeechStarted', timestamp: 0.1 })
    listening()?.json(results('The head is', false, false))
    listening()?.json(results('The head is at epoch 167.', true, false))
    listening()?.json(results('and waits', false, false))
    listening()?.json(results('And waits for you.', true, true))
    // Interim text never reaches the app; the utterance arrives once, whole.
    expect(h.types()).toEqual(['ready', 'vad', 'final'])
    expect(h.received[2]).toEqual({ t: 'final', text: 'The head is at epoch 167. And waits for you.' })
    // Deepgram's own end-of-utterance mark closes one that had no speech_final; an empty one is not a turn.
    listening()?.json(results('One more thing.', true, false))
    listening()?.json({ type: 'UtteranceEnd' })
    listening()?.json({ type: 'UtteranceEnd' })
    listening()?.json(results('', true, true))
    expect(h.types().slice(3)).toEqual(['final'])
    // A RESET FORGETS WHAT WAS HALF-HEARD (the app sends it on mute, "so it never fires"): what the page already holds,
    // AND what Deepgram still holds. Deepgram is told to finalize, and everything up to that finalized result is thrown away.
    listening()?.json(results('half a thought', true, false))
    h.socket.send(JSON.stringify({ t: 'reset' }))
    expect(listening()?.said.at(-1)).toEqual({ type: 'Finalize' })
    listening()?.json(results('half a thought that Deepgram', false, false))
    listening()?.json({ type: 'UtteranceEnd' })
    listening()?.json({ ...results('half a thought that Deepgram still held.', true, true), from_finalize: true })
    expect(h.types().slice(4)).toEqual([])
    // What is said after that is heard again.
    listening()?.json(results('Now listen.', true, true))
    expect(h.received.at(-1)).toEqual({ t: 'final', text: 'Now listen.' })
    // A finalized result that never comes cannot leave the organ deaf: the discard ends on its own.
    h.socket.send(JSON.stringify({ t: 'reset' }))
    h.timers.find(timer => timer.ms === mod.DISCARD_MS)?.fn()
    listening()?.json(results('Still here.', true, true))
    expect(h.received.at(-1)).toEqual({ t: 'final', text: 'Still here.' })
  })

  it('Aura-2: her sentences are spoken in order, one at a time: tts_begin with the rate, whole samples, tts_end', async () => {
    const h = await live()
    const speak = await aura(h, 1, ' Epoch sixty eight is staged. ')
    expect(speak?.url).toBe(auraUrl(THALIA))
    h.socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'It waits for you.', voice: THALIA, speed: 1, first: false }))
    await flush()
    // Only the first has been asked for: Deepgram's audio carries no id, so sentences never overlap.
    expect(speak?.said).toEqual([{ type: 'Speak', text: 'Epoch sixty eight is staged.' }, { type: 'Flush' }])
    speak?.audio([1, 2, 3])
    speak?.audio([4, 5, 6])
    speak?.json({ type: 'Flushed', sequence_id: 0 })
    await flush()
    // An odd byte is held back and joined to the next frame: every frame passed on is whole 16-bit samples.
    expect(h.types().slice(1)).toEqual(['tts_begin', 'pcm:2', 'pcm:4', 'tts_end'])
    expect(h.received[1]).toEqual({ t: 'tts_begin', id: 1, sr: 24000 })
    expect(h.received[4]).toEqual({ t: 'tts_end', id: 1 })
    expect(speak?.said.slice(2)).toEqual([{ type: 'Speak', text: 'It waits for you.' }, { type: 'Flush' }])
    speak?.audio([9, 9])
    speak?.json({ type: 'Flushed', sequence_id: 1 })
    expect(h.types().slice(5)).toEqual(['tts_begin', 'pcm:2', 'tts_end'])
  })

  it('Aura-2: a cancel (the owner spoke over her) drops what was queued and plays nothing more of the cut sentence', async () => {
    const h = await live()
    const speak = await aura(h, 5, 'A long sentence.')
    h.socket.send(JSON.stringify({ t: 'tts', id: 6, text: 'Never spoken.', voice: THALIA }))
    await flush()
    speak?.audio([1, 1])
    h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
    expect(speak?.said.at(-1)).toEqual({ type: 'Clear' })
    expect(h.types().slice(1)).toEqual(['tts_begin', 'pcm:2', 'tts_cancelled'])
    // Audio Deepgram had already sent for the cut sentence, and its Flushed, are not hers to play.
    speak?.audio([2, 2, 2, 2])
    speak?.json({ type: 'Flushed', sequence_id: 0 })
    expect(h.types().slice(4)).toEqual([])
    expect(speak?.said.filter(message => message.type === 'Speak')).toHaveLength(1)
    speak?.json({ type: 'Cleared', sequence_id: 0 })
    // The next sentence after the cut is clean.
    h.socket.send(JSON.stringify({ t: 'tts', id: 7, text: 'Yes?', voice: THALIA }))
    await flush()
    speak?.audio([3, 3])
    speak?.json({ type: 'Flushed', sequence_id: 1 })
    expect(h.types().slice(4)).toEqual(['tts_begin', 'pcm:2', 'tts_end'])
    expect(h.received.at(-1)).toEqual({ t: 'tts_end', id: 7 })
  })

  it('a sentence Deepgram does not speak is reported, so the app speaks it itself: no audio, a timeout, a dropped stream, another voice', async () => {
    const h = await live()
    const speak = await aura(h, 1, 'Silence.')
    speak?.json({ type: 'Flushed', sequence_id: 0 })
    // err, THEN tts_end for the same id: the app speaks the sentence itself on err, and stops counting it as pending only
    // on tts_end (aumalive.js err() and tts_end()). An err alone left it pending, her "audible", and the microphone dropped.
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 1 }, { t: 'tts_end', id: 1 }])
    h.socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'Never answered.', voice: THALIA }))
    await flush()
    const timeout = h.timers.find(timer => timer.ms === mod.SPEAK_TIMEOUT_MS)
    timeout?.fn()
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 2 }, { t: 'tts_end', id: 2 }])
    // The stream that hung is given up; the next sentence opens a fresh one, in the voice asked for.
    h.socket.send(JSON.stringify({ t: 'tts', id: 3, text: 'Again.', voice: 'aura-2-apollo-en' }))
    await flush()
    const fresh = speaking().at(-1)
    expect(fresh?.url).toContain('model=aura-2-apollo-en')
    fresh?.open()
    await flush()
    fresh?.audio([1, 1])
    // The timeout is for a stream gone quiet: audio arriving restarts it (a long sentence is not a failure).
    expect(h.timers.filter(timer => timer.ms === mod.SPEAK_TIMEOUT_MS)).toHaveLength(1)
    fresh?.drop()
    await flush()
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 3 }, { t: 'tts_end', id: 3 }])
    // A voice id that is not one of hers is never put into a Deepgram URL: the default (Sienna) is used.
    h.socket.send(JSON.stringify({ t: 'tts', id: 4, text: 'Hello.', voice: 'x&model=evil' }))
    await flush()
    expect(speaking().at(-1)?.url).toBe(SIENNA_URL)
    expect(Upstream.all.every(stream => !stream.url.includes('evil'))).toBe(true)
    h.socket.send(JSON.stringify({ t: 'tts', id: 5, text: '   ' }))
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 5 }, { t: 'tts_end', id: 5 }])
    // Every sentence asked for was answered to its end, exactly once.
    const ended = h.received.filter((item): item is { t: string; id: number } => !(item instanceof Uint8Array) && (item as { t: string }).t === 'tts_end')
    expect(ended.map(item => item.id)).toEqual([1, 2, 3, 5])
    // Sentence 4 is still waiting for its Sienna stream, which never said it was connected: it fails, and is answered too.
    speaking().at(-1)?.open()
    await flush()
    h.timers.filter(timer => timer.ms === mod.SPEAK_TIMEOUT_MS).forEach((timer) => { timer.fn() })
    await flush()
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 4 }, { t: 'tts_end', id: 4 }])
  })

  it('a long sentence is sent whole, in pieces cut at spaces; and a sentence is never spoken in a voice it was not asked in', async () => {
    const h = await live()
    const long = Array.from({ length: 700 }, (_unused, index) => `word${String(index)}`).join(' ')
    h.socket.send(JSON.stringify({ t: 'tts', id: 1, text: long, voice: mod.DEEPGRAM_DEFAULT_VOICE }))
    await flush()
    const pieces = speaking()[0]?.said.filter(message => message.type === 'Speak').map(message => String(message.text)) ?? []
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every(piece => piece.length <= mod.SPEAK_PIECE_CHARS)).toBe(true)
    expect(pieces.join('')).toBe(long)
    expect(speaking()[0]?.said.at(-1)).toEqual({ type: 'Flush' })
    // The warm-up stream is being opened in the default voice when a sentence asks for another: it is not borrowed.
    Upstream.all = []
    mod.forgetNoPass()
    const other = harness()
    await flush()
    listening()?.open()
    await flush()
    other.socket.send(JSON.stringify({ t: 'tts', id: 9, text: 'This is me.', voice: 'aura-2-apollo-en' }))
    await flush()
    const warm = speaking()[0]
    expect(warm?.url).toContain(`model=${mod.DEEPGRAM_DEFAULT_VOICE}`)
    warm?.open()
    connected(warm)
    // (The second stream needs its own pass first: a few more turns of the event loop.)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(warm?.said).toEqual([])
    const apollo = speaking().at(-1)
    expect(apollo?.url).toContain('model=aura-2-apollo-en')
    apollo?.open()
    await flush()
    expect(apollo?.said).toEqual([{ type: 'Speak', text: 'This is me.' }, { type: 'Flush' }])
  })

  it('Sienna on Flux: nothing is sent before Connected; SpeechStarted, whole samples, then SpeechMetadata ends each sentence', async () => {
    const h = harness()
    await flush()
    listening()?.open()
    await flush()
    const sienna = speaking()[0]
    expect(sienna?.url).toBe(SIENNA_URL)
    sienna?.open()
    h.socket.send(JSON.stringify({ t: 'tts', id: 1, text: 'Epoch sixty eight is staged.', voice: SIENNA, speed: 1, first: true }))
    h.socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'It waits for you.', voice: SIENNA, speed: 1, first: false }))
    await flush()
    // Open, but Flux has not said it is ready: nothing is sent yet (AUKORA.xyz waits the same way).
    expect(sienna?.sent).toEqual([])
    connected(sienna)
    await flush()
    expect(sienna?.said).toEqual([{ type: 'Speak', text: 'Epoch sixty eight is staged.' }, { type: 'Flush' }])
    sienna?.json({ type: 'SpeechStarted', speech_id: 'turn-1' })
    // Flux's Flushed comes BEFORE the audio (as Deepgram sent it): it ends nothing.
    sienna?.json({ type: 'Flushed', speech_id: 'turn-1' })
    sienna?.audio([1, 2, 3])
    sienna?.audio([4, 5, 6])
    expect(h.types().slice(1)).toEqual(['tts_begin', 'pcm:2', 'pcm:4'])
    sienna?.json({ type: 'SpeechMetadata', speech_id: 'turn-1' })
    await flush()
    expect(h.received.slice(1)).toEqual([{ t: 'tts_begin', id: 1, sr: 24000 }, Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5, 6]), { t: 'tts_end', id: 1 }])
    expect(sienna?.said.slice(2)).toEqual([{ type: 'Speak', text: 'It waits for you.' }, { type: 'Flush' }])
    // A late frame about the first sentence never ends the second.
    sienna?.json({ type: 'SpeechMetadata', speech_id: 'turn-1' })
    sienna?.json({ type: 'SpeechStarted', speech_id: 'turn-2' })
    sienna?.audio([9, 9])
    sienna?.json({ type: 'SpeechMetadata', speech_id: 'turn-1' })
    expect(h.types().slice(5)).toEqual(['tts_begin', 'pcm:2'])
    sienna?.json({ type: 'SpeechMetadata', speech_id: 'turn-2' })
    expect(h.types().slice(5)).toEqual(['tts_begin', 'pcm:2', 'tts_end'])
    expect(h.received.at(-1)).toEqual({ t: 'tts_end', id: 2 })
    // One stream served both; closing says Close to it.
    expect(speaking()).toHaveLength(1)
    h.socket.close()
    expect(sienna?.said.at(-1)).toEqual({ type: 'Close' })
  })

  it('Sienna on Flux: a cancel sends Interrupt, never Clear; the cut turn never plays, even under the next sentence', async () => {
    const tts = (h: ReturnType<typeof harness>, id: number, text: string) => { h.socket.send(JSON.stringify({ t: 'tts', id, text, voice: SIENNA })) }
    // 1. Flux announced the cut turn and is still sending it when her next sentence goes out (before SpeechInterrupted).
    {
      const h = await live()
      const sienna = speaking()[0]
      tts(h, 5, 'A long sentence.')
      tts(h, 6, 'Never spoken.')
      await flush()
      sienna?.json({ type: 'SpeechStarted', speech_id: 'cut' })
      sienna?.audio([1, 1])
      h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
      // Flux has no Clear (Deepgram answers it with a parse Error and closes the stream): it is told Interrupt.
      expect(sienna?.said.at(-1)).toEqual({ type: 'Interrupt' })
      expect(sienna?.said.some(message => message.type === 'Clear')).toBe(false)
      expect(h.types().slice(1)).toEqual(['tts_begin', 'pcm:2', 'tts_cancelled'])
      tts(h, 7, 'Yes?')
      await flush()
      expect(sienna?.said.slice(-2)).toEqual([{ type: 'Speak', text: 'Yes?' }, { type: 'Flush' }])
      // A few frames of the cut turn still come after the Interrupt (as Deepgram sent them): sentence 7 is current, and
      // none of them is played as it.
      sienna?.audio([2, 2, 2, 2])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'cut' })
      expect(h.types().slice(4)).toEqual([])
      sienna?.json({ type: 'SpeechInterrupted', audio_played_ms: 5200, metadata: { speech_id: 'cut' } })
      sienna?.json({ type: 'SpeechStarted', speech_id: 'yes' })
      sienna?.audio([3, 3])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'yes' })
      expect(h.types().slice(4)).toEqual(['tts_begin', 'pcm:2', 'tts_end'])
      expect(h.received.slice(4)).toEqual([{ t: 'tts_begin', id: 7, sr: 24000 }, Uint8Array.from([3, 3]), { t: 'tts_end', id: 7 }])
      expect(sienna?.said.filter(message => message.type === 'Speak').map(message => message.text)).toEqual(['A long sentence.', 'Yes?'])
    }
    // 2. The cut came before Flux had any audio, so Flux ignores the Interrupt (Warning NO_AUDIO_GENERATED) and the cut turn,
    //    not yet announced, is said in full before her next sentence: all of it is the cut turn's.
    {
      Upstream.all = []
      mod.forgetNoPass()
      const h = await live()
      const sienna = speaking()[0]
      tts(h, 5, 'Cut before a sound.')
      await flush()
      h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
      expect(sienna?.said.at(-1)).toEqual({ type: 'Interrupt' })
      tts(h, 7, 'Yes?')
      await flush()
      sienna?.json({ type: 'Warning', code: 'NO_AUDIO_GENERATED', description: 'The Interrupt is ignored.' })
      sienna?.json({ type: 'SpeechStarted', speech_id: 'cut' })
      sienna?.json({ type: 'Flushed', speech_id: 'cut' })
      sienna?.audio([9, 9, 9, 9])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'cut' })
      expect(h.types().slice(1)).toEqual(['tts_cancelled'])
      sienna?.json({ type: 'SpeechStarted', speech_id: 'yes' })
      sienna?.audio([3, 3])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'yes' })
      expect(h.received.slice(2)).toEqual([{ t: 'tts_begin', id: 7, sr: 24000 }, Uint8Array.from([3, 3]), { t: 'tts_end', id: 7 }])
    }
    // 3. The cut turn was interrupted before Flux announced it: its SpeechInterrupted accounts for it, and the next
    //    announcement is the next sentence's.
    {
      Upstream.all = []
      mod.forgetNoPass()
      const h = await live()
      const sienna = speaking()[0]
      tts(h, 5, 'Cut unannounced.')
      await flush()
      h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
      tts(h, 7, 'Yes?')
      await flush()
      sienna?.json({ type: 'SpeechInterrupted', audio_played_ms: 0, metadata: { speech_id: 'never-announced' } })
      sienna?.json({ type: 'SpeechStarted', speech_id: 'yes' })
      sienna?.audio([4, 4])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'yes' })
      expect(h.received.slice(2)).toEqual([{ t: 'tts_begin', id: 7, sr: 24000 }, Uint8Array.from([4, 4]), { t: 'tts_end', id: 7 }])
    }
    // 4. Flux repeats the last turn's id in a SpeechInterrupted for an Interrupt with no active turn (as Deepgram did):
    //    arriving while a later sentence plays, it disturbs nothing.
    {
      Upstream.all = []
      mod.forgetNoPass()
      const h = await live()
      const sienna = speaking()[0]
      tts(h, 1, 'First.')
      await flush()
      sienna?.json({ type: 'SpeechStarted', speech_id: 'a' })
      sienna?.audio([1, 1])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'a' })
      tts(h, 2, 'Second.')
      await flush()
      sienna?.json({ type: 'SpeechStarted', speech_id: 'b' })
      sienna?.audio([2, 2])
      sienna?.json({ type: 'SpeechInterrupted', audio_played_ms: 900, metadata: { speech_id: 'a' } })
      sienna?.audio([3, 3])
      sienna?.json({ type: 'SpeechMetadata', speech_id: 'b' })
      expect(h.types().slice(1)).toEqual(['tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'pcm:2', 'tts_end'])
    }
    // 5. A cut sentence whose words never went out (its stream was still opening) asks Flux to interrupt nothing.
    {
      Upstream.all = []
      mod.forgetNoPass()
      const h = harness()
      await flush()
      listening()?.open()
      await flush()
      tts(h, 5, 'Not yet sent.')
      await flush()
      h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
      const sienna = speaking()[0]
      sienna?.open()
      connected(sienna)
      await flush()
      expect(sienna?.sent).toEqual([])
      expect(h.received.at(-1)).toEqual({ t: 'tts_cancelled' })
    }
  })

  it('Sienna on Flux: an idle stream is kept open with a Flush that speaks nothing, never while a sentence is in flight', async () => {
    const h = await live()
    const sienna = speaking()[0]
    // The newest beat armed (the fake timer list keeps timers that already ran).
    const beat = () => h.timers.filter(timer => timer.ms === mod.FLUX_KEEPALIVE_MS).at(-1)
    expect(mod.FLUX_KEEPALIVE_MS).toBeLessThan(60_000)
    // Idle: a Flush goes out (Flux answers NO_ACTIVE_SPEECH and keeps the stream), and the next beat is armed.
    beat()?.fn()
    expect(sienna?.said).toEqual([{ type: 'Flush' }])
    sienna?.json({ type: 'Warning', code: 'NO_ACTIVE_SPEECH', description: 'There is no active turn. The request will be ignored.' })
    expect(h.timers.filter(timer => timer.ms === mod.FLUX_KEEPALIVE_MS)).toHaveLength(2)
    // While a sentence is in flight, the beat sends nothing (a Flush would end her sentence early).
    h.socket.send(JSON.stringify({ t: 'tts', id: 1, text: 'Still here.', voice: SIENNA }))
    await flush()
    beat()?.fn()
    expect(sienna?.said.slice(1)).toEqual([{ type: 'Speak', text: 'Still here.' }, { type: 'Flush' }])
    sienna?.json({ type: 'SpeechStarted', speech_id: 'a' })
    sienna?.audio([5, 5])
    sienna?.json({ type: 'SpeechMetadata', speech_id: 'a' })
    expect(h.received.at(-1)).toEqual({ t: 'tts_end', id: 1 })
    // A stream Flux closed for being idle fails nothing; the next sentence gets a fresh one, and the old beat stops.
    const armed = beat()
    sienna?.json({ type: 'Error', code: 'NET-0004', description: 'inactivity' })
    sienna?.drop(1011)
    await flush()
    expect(h.received.at(-1)).toEqual({ t: 'tts_end', id: 1 })
    expect(h.timers.includes(armed as never)).toBe(false)
    h.socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'Back.', voice: SIENNA }))
    await flush()
    expect(speaking()).toHaveLength(2)
  })

  it('Sienna on Flux: a stream in another voice, one that never says Connected, or an Error, fails the sentence so the app speaks it', async () => {
    const h = harness()
    await flush()
    listening()?.open()
    await flush()
    // Connected in a voice it was not opened in: never spoken in, closed, and the sentence is answered as failed.
    const wrong = speaking()[0]
    wrong?.open()
    h.socket.send(JSON.stringify({ t: 'tts', id: 1, text: 'Hello.', voice: SIENNA }))
    await flush()
    connected(wrong, 'wrong-voice')
    await flush()
    expect(wrong?.sent).toEqual([])
    expect(wrong?.readyState).toBe(3)
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 1 }, { t: 'tts_end', id: 1 }])
    // Open, and silent: given up when the wait runs out, with nothing sent.
    h.socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'Anyone there?', voice: SIENNA }))
    await flush()
    const silent = speaking().at(-1)
    expect(silent).not.toBe(wrong)
    silent?.open()
    await flush()
    h.timers.filter(timer => timer.ms === mod.SPEAK_TIMEOUT_MS).forEach((timer) => { timer.fn() })
    await flush()
    expect(silent?.sent).toEqual([])
    expect(silent?.readyState).toBe(3)
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 2 }, { t: 'tts_end', id: 2 }])
    // Flux reports an Error mid-sentence: that sentence fails, and the next one gets a fresh stream.
    h.socket.send(JSON.stringify({ t: 'tts', id: 3, text: 'Third.', voice: SIENNA }))
    await flush()
    const third = speaking().at(-1)
    third?.open()
    connected(third, SIENNA)
    await flush()
    expect(third?.said).toEqual([{ type: 'Speak', text: 'Third.' }, { type: 'Flush' }])
    third?.json({ type: 'Error', description: 'synthesis failed' })
    await flush()
    expect(h.received.slice(-2)).toEqual([{ t: 'err', where: 'tts', id: 3 }, { t: 'tts_end', id: 3 }])
    expect(third?.readyState).toBe(3)
    h.socket.send(JSON.stringify({ t: 'tts', id: 4, text: 'Fourth.', voice: SIENNA }))
    await flush()
    expect(speaking().at(-1)).not.toBe(third)
  })

  it('a pass request that failed on the way is not remembered as "this host gives none"', async () => {
    for (const status of [500, 503, 429]) {
      Upstream.all = []
      mod.forgetNoPass()
      const first = harness({ status, pass: { ok: false } })
      await flush()
      // This attempt has no pass, so it tries the sidecar; the next attempt asks the host again.
      expect(Upstream.all.map(socket => socket.url)).toEqual([URL_])
      expect(first.asked).toHaveLength(1)
      const again = harness()
      await flush()
      expect(again.asked).toHaveLength(1)
      expect(listening()?.url).toContain('api.deepgram.com')
    }
    Upstream.all = []
    mod.forgetNoPass()
    const thrown = mod.voiceSocketFor(URL_, { WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl: async () => { throw new TypeError('offline') } })
    await flush()
    expect(thrown.readyState).toBe(0)
    const after = harness()
    await flush()
    expect(after.asked).toHaveLength(1)
  })

  it('a host that gives no pass opens the real sidecar socket exactly as before, and is not asked again for a minute', async () => {
    for (const options of [{ status: 404, pass: 'nope' }, { status: 400, pass: { ok: false, code: 'VOICE_ACTION_INVALID' } },
      { pass: { ok: true, provider: 'someone-else', accessToken: PASS } }, { pass: { ok: true, provider: 'deepgram', accessToken: 'short' } }]) {
      Upstream.all = []
      mod.forgetNoPass()
      const h = harness(options)
      await flush()
      expect(Upstream.all.map(socket => socket.url)).toEqual([URL_])
      const sidecar = Upstream.all[0]
      sidecar?.open()
      sidecar?.json({ t: 'ready', voices: [{ id: 'aurora', label: 'Aurora', engine: 'pocket' }], default_voice: 'aurora' })
      expect(h.received[0]).toMatchObject({ t: 'ready', default_voice: 'aurora' })
      expect(h.socket.cloud).toBeNull()
      const frame = new Int16Array(640).buffer
      h.socket.send(frame)
      h.socket.send(JSON.stringify({ t: 'tts', id: 1, text: 'hi', voice: 'aurora' }))
      expect(sidecar?.sent).toEqual([frame, JSON.stringify({ t: 'tts', id: 1, text: 'hi', voice: 'aurora' })])
      // The sidecar's own "a newer window took the voice" reaches the app untouched.
      sidecar?.drop(4001)
      expect(h.closes).toEqual([4001])
      // VoiceLink reconnects every 4 s: the host is not asked for a pass again within the minute.
      const again = harness(options)
      await flush()
      expect(again.asked).toEqual([])
      expect(Upstream.all.at(-1)?.url).toBe(URL_)
    }
    expect(mod.NO_PASS_MEMORY_MS).toBe(60_000)
  })

  it('a host with no Deepgram key says so (503 SPEECH_PROVIDER_UNCONFIGURED): the sidecar path, never a Deepgram socket, and not asked again for a minute', async () => {
    // What the edge answers when DEEPGRAM_API_KEY is not set (deploy/cloudflare/src/voice-director.mjs).
    const unconfigured = { status: 503, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } }
    const h = harness(unconfigured)
    await flush()
    expect(h.asked).toEqual([['/_host/voice', { action: 'speech_pass' }]])
    expect(Upstream.all.map(socket => socket.url)).toEqual([URL_])
    // FALLBACK, THEN THE ORGAN: where a sidecar answers that socket it is her organ exactly as before, heard and spoken
    // through it alone.
    const sidecar = Upstream.all[0]
    sidecar?.open()
    sidecar?.json({ t: 'ready', voices: [{ id: 'aurora', label: 'Aurora', engine: 'pocket' }], default_voice: 'aurora' })
    expect(h.received).toEqual([{ t: 'ready', voices: [{ id: 'aurora', label: 'Aurora', engine: 'pocket' }], default_voice: 'aurora' }])
    expect(h.socket.readyState).toBe(1)
    expect(h.socket.cloud).toBeNull()
    const frame = new Int16Array(640).fill(3).buffer
    const sentence = JSON.stringify({ t: 'tts', id: 1, text: 'Here.', voice: SIENNA, speed: 1, first: true })
    h.socket.send(frame)
    h.socket.send(sentence)
    await flush()
    expect(sidecar?.sent).toEqual([frame, sentence])
    sidecar?.json({ t: 'final', text: 'Are you there?' })
    expect(h.received.at(-1)).toEqual({ t: 'final', text: 'Are you there?' })
    // VoiceLink reconnects every 4 s. An unconfigured host is not asked again within the minute, and nothing was ever
    // opened to Deepgram: not a listening stream, not a speaking one, not for the sentence in her Deepgram voice.
    sidecar?.drop()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = harness(unconfigured)
      await flush()
      expect(again.asked).toEqual([])
    }
    expect(Upstream.all.map(socket => socket.url)).toEqual([URL_, URL_, URL_, URL_])
    expect(h.asked).toHaveLength(1)
    // The memory is a minute, not for ever: after it the host is asked again.
    const later: unknown[] = []
    const ask = async (path: string) => { later.push(path); return new Response(JSON.stringify(unconfigured.pass), { status: 503 }) }
    const at = (clock: number) => ({ WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl: ask, now: () => clock })
    mod.voiceSocketFor(URL_, at(999 + mod.NO_PASS_MEMORY_MS))
    await flush()
    expect(later).toEqual([])
    mod.voiceSocketFor(URL_, at(1_000 + mod.NO_PASS_MEMORY_MS))
    await flush()
    expect(later).toEqual(['/_host/voice'])
    expect(Upstream.all.every(socket => socket.url === URL_)).toBe(true)
  })

  it('forgetNoPass() makes an unconfigured host be asked again at once (Start Voice calls it: the key may have been set since)', async () => {
    const unconfigured = { status: 503, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } }
    const first = harness(unconfigured)
    await flush()
    expect(first.asked).toHaveLength(1)
    const remembered = harness()
    await flush()
    expect(remembered.asked).toEqual([])
    expect(listening()).toBeUndefined()
    mod.forgetNoPass()
    // The host has a key now: asked again, and this time it is Deepgram.
    const configured = harness()
    await flush()
    expect(configured.asked).toEqual([['/_host/voice', { action: 'speech_pass' }]])
    expect(listening()?.url).toContain('api.deepgram.com')
  })

  it('any other 503 is still nothing learned: a plain one, one with another code, and that code on another status', async () => {
    const notLearned: Array<Parameters<typeof harness>[0]> = [
      { status: 503, raw: 'Service Unavailable' },
      { status: 503, raw: '' },
      { status: 503, raw: '<html>SPEECH_PROVIDER_UNCONFIGURED</html>' },
      { status: 503, pass: 'SPEECH_PROVIDER_UNCONFIGURED' },
      { status: 503, pass: { ok: false } },
      { status: 503, pass: { ok: false, code: 'SPEECH_PROVIDER_UNAVAILABLE' } },
      { status: 503, pass: { ok: false, code: 'SPEECH_PASS_BUDGET_UNAVAILABLE' } },
      { status: 503, pass: { ok: false, code: ['SPEECH_PROVIDER_UNCONFIGURED'] } },
      { status: 503, pass: { ok: false, error: { code: 'SPEECH_PROVIDER_UNCONFIGURED' } } },
      // The code means "definitely none" only on the status the edge sends it with.
      { status: 500, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } },
      { status: 502, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } },
      { status: 504, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } },
      { status: 429, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } },
      { status: 408, pass: { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } },
    ]
    for (const options of notLearned) {
      Upstream.all = []
      mod.forgetNoPass()
      const first = harness(options)
      await flush()
      // No pass this time, so the sidecar is tried; the very next attempt asks the host again.
      expect(first.asked).toHaveLength(1)
      expect(Upstream.all.map(socket => socket.url)).toEqual([URL_])
      const again = harness()
      await flush()
      expect(again.asked).toHaveLength(1)
      expect(listening()?.url).toContain('api.deepgram.com')
    }
    // THE BODY IS READ ONCE, AND A BODY THAT CANNOT BE READ TEACHES NOTHING (and breaks nothing).
    Upstream.all = []
    mod.forgetNoPass()
    let reads = 0
    const unreadable = { ok: false, status: 503, json: async () => { reads += 1; throw new TypeError('body stream already read') } }
    const broken = mod.voiceSocketFor(URL_, { WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl: async () => unreadable })
    await flush()
    expect(reads).toBe(1)
    expect(broken.readyState).toBe(0)
    expect(Upstream.all.map(socket => socket.url)).toEqual([URL_])
    const after = harness()
    await flush()
    expect(after.asked).toHaveLength(1)
    reads = 0
    const configured = { ok: false, status: 503, json: async () => { reads += 1; return { ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' } } }
    mod.voiceSocketFor(URL_, { WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl: async () => configured })
    await flush()
    expect(reads).toBe(1)
  })

  it('Deepgram going away tells the app its organ is down; closing closes both streams; a quiet stream is kept alive', async () => {
    const h = await live()
    const beat = h.timers.find(timer => timer.ms === 4000)
    beat?.fn()
    expect(listening()?.said.at(-1)).toEqual({ type: 'KeepAlive' })
    listening()?.drop(1011)
    expect(h.closes).toEqual([1011])
    expect(speaking()[0]?.readyState).toBe(3)
    // Nothing reaches the app from a closed organ.
    const before = h.received.length
    speaking()[0]?.audio([1, 1])
    expect(h.received).toHaveLength(before)
    Upstream.all = []
    const second = await live()
    second.socket.close()
    // Both streams are told they are done, then closed.
    expect(listening()?.said.at(-1)).toEqual({ type: 'CloseStream' })
    expect(speaking()[0]?.said.at(-1)).toEqual({ type: 'Close' })
    expect(Upstream.all.map(socket => socket.readyState)).toEqual([3, 3])
    expect(second.closes).toEqual([1000])
    // A pass that arrives after the app closed opens nothing.
    Upstream.all = []
    const late = harness()
    late.socket.close()
    await flush()
    expect(Upstream.all).toEqual([])
  })

  it('one window owns the voice: a newer owner makes the older one let go with the sidecar\'s own code', async () => {
    class Channel {
      static open: Channel[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor(readonly name: string) { Channel.open.push(this) }
      postMessage(data: unknown) { for (const other of Channel.open) if (other !== this) other.onmessage?.({ data }) }
      close() { Channel.open = Channel.open.filter(channel => channel !== this) }
    }
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true, provider: 'deepgram', accessToken: PASS }))
    const older = mod.voiceSocketFor(URL_, { WebSocketImpl: Upstream, BroadcastChannelImpl: Channel, fetchImpl })
    const olderCloses: number[] = []
    older.onclose = (event) => { olderCloses.push(event.code) }
    await flush()
    listening()?.open()
    const newer = mod.voiceSocketFor(URL_.replace('0000000000001:a:000001', '0000000000002:b:000001'), { WebSocketImpl: Upstream,
      BroadcastChannelImpl: Channel, fetchImpl })
    const newerCloses: number[] = []
    newer.onclose = (event) => { newerCloses.push(event.code) }
    await flush()
    Upstream.all.filter(socket => socket.url.includes('/v1/listen')).at(-1)?.open()
    expect(olderCloses).toEqual([4001])
    expect(newerCloses).toEqual([])
    // An older claim that announces itself late is answered by the newer owner, and lets go.
    const late = mod.voiceSocketFor(URL_.replace('0000000000001:a:000001', '0000000000000:z:000009'), { WebSocketImpl: Upstream,
      BroadcastChannelImpl: Channel, fetchImpl })
    const lateCloses: number[] = []
    late.onclose = (event) => { lateCloses.push(event.code) }
    await flush()
    Upstream.all.filter(socket => socket.url.includes('/v1/listen')).at(-1)?.open()
    expect(lateCloses).toEqual([4001])
    expect(newerCloses).toEqual([])
  })
})
