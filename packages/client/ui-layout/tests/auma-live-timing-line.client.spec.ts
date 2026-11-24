/**
 * The timing line: where the time of one Auma Live voice turn goes, measured before anything is made faster.
 *
 * Two things are proved here. First, the recorder (`createTurnTimes` / `timingLine`, apps/web/public/app/deepgram-voice.js)
 * turns scripted stamps into exactly the drawer's line, shows "?" for a stage not measured yet, shows nothing before the
 * first measured turn, keeps 20 turns, counts the cut-off sign, and does no I/O. Second, the page: aumalive.js cannot be
 * loaded here, so its voice-turn path (VoiceLink's handlers, requestTurn, speakChunk, speakFallback, transmit, endTurn,
 * bargeIn and the player's level report) is lifted from its own text and RUN twice over the same scripted conversation: once as it is,
 * and once with every line marked `// timing stamp` taken out. Every request, every message to the voice organ and the
 * player, every transcript entry and every timer must be identical; only the line differs. All content is made up.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const appFile = (name: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`)).find(existsSync) ?? `apps/web/public/app/${name}`
const page = readFileSync(appFile('aumalive.js'), 'utf8')
const voiceSource = readFileSync(appFile('deepgram-voice.js'), 'utf8')

interface Turn {
  heard: number
  claimed: boolean
  againBefore: boolean
  againAfter: boolean
  [stage: string]: unknown
}
interface TurnTimes {
  heard: (at: number, busy?: boolean) => void
  spokeAgain: (at: number, busy?: boolean) => void
  claim: () => Turn | null
  mark: (turn: Turn | null, stage: string, at: number) => void
  frame: (turn: Turn | null, event: unknown, at: number) => void
  audio: (stage: string, at: number) => void
  close: () => void
  line: () => string
  turns: () => Turn[]
}
const dg = await import(pathToFileURL(appFile('deepgram-voice.js')).href) as {
  createTurnTimes: (options?: { onChange?: (line: string) => void; endOfSpeechMs?: number }) => TurnTimes
  timingLine: (turns: unknown, endOfSpeechMs?: number) => string
  END_OF_SPEECH_MS: number
  TIMING_TURNS_KEPT: number
  SPOKE_AGAIN_AFTER_MS: number
}
const directives = await import(pathToFileURL(appFile('field-directives.js')).href) as { makeDirectiveFilter: (apply: (tag: string) => void) => unknown }
const duplexModule = await import(pathToFileURL(appFile('aumalive-duplex.js')).href) as { isSelfEcho: (heard: string, spoken: string) => boolean }
const eleven = await import(pathToFileURL(appFile('elevenlabs-voice.js')).href) as { phraseCut: unknown; ELEVEN_VOICE_PICK: string }

/** One whole spoken turn, stamped at the given times (ms on the page clock). */
const turn = (t: TurnTimes, at: { heard: number; started?: number; firstText: number; firstAudio: number; firstSound: number }) => {
  t.heard(at.heard, false)
  const clock = t.claim()
  t.mark(clock, 'sent', at.heard)
  if (at.started !== undefined) t.frame(clock, { t: 'mark', v: 'started' }, at.started)
  t.mark(clock, 'firstText', at.firstText)
  t.mark(clock, 'firstPhrase', at.firstText)
  t.audio('firstAudio', at.firstAudio)
  t.audio('firstSound', at.firstSound)
  return clock
}

describe('the recorder: scripted stamps make exactly the drawer\'s line', () => {
  it('no line before the first measured turn; then the brief\'s own example, to the tenth of a second', () => {
    const shown: string[] = []
    const t = dg.createTurnTimes({ onChange: (line) => { shown.push(line) } })
    expect(t.line()).toBe('')
    t.heard(10_000, false)
    const clock = t.claim()
    t.mark(clock, 'sent', 10_004)
    t.frame(clock, { t: 'mark', v: 'started' }, 10_300)
    t.mark(clock, 'firstText', 11_900)
    t.mark(clock, 'firstPhrase', 11_900)
    t.audio('firstAudio', 12_200)
    expect(t.line()).toBe('')                       // her audio arrived, but no sound yet: still nothing shown
    expect(shown).toEqual([])
    t.audio('firstSound', 12_400)
    const line = 'last reply 2.4 s to first sound (plus 0.8 s end-of-speech wait): hand-off 0.3, thinking 1.6, voice 0.5; usual 2.4 s over 1'
    expect(t.line()).toBe(line)
    expect(shown).toEqual([line])
    expect(dg.END_OF_SPEECH_MS).toBe(800)
  })

  it('a stage not measured yet shows as "?": until the session adapter sends its marks, hand-off and thinking are "?"', () => {
    const t = dg.createTurnTimes()
    turn(t, { heard: 1_000, firstText: 2_900, firstAudio: 3_150, firstSound: 3_300 })
    expect(t.line()).toBe('last reply 2.3 s to first sound (plus 0.8 s end-of-speech wait): hand-off ?, thinking ?, voice 0.4; usual 2.3 s over 1')
    // The constant shown is the one given, so a later change to the wait shows on the line by itself.
    const u = dg.createTurnTimes({ endOfSpeechMs: 500 })
    turn(u, { heard: 1_000, started: 1_200, firstText: 2_000, firstAudio: 2_300, firstSound: 2_400 })
    expect(u.line()).toBe('last reply 1.4 s to first sound (plus 0.5 s end-of-speech wait): hand-off 0.2, thinking 0.8, voice 0.4; usual 1.4 s over 1')
  })

  it('"usual" is the median over the measured turns kept; the last 20 are kept and no more; an unmeasured turn is not "usual"', () => {
    const t = dg.createTurnTimes()
    turn(t, { heard: 0, started: 100, firstText: 1_000, firstAudio: 1_900, firstSound: 2_000 })        // 2.0
    turn(t, { heard: 10_000, started: 10_100, firstText: 13_000, firstAudio: 13_900, firstSound: 14_000 }) // 4.0
    turn(t, { heard: 20_000, started: 20_100, firstText: 22_500, firstAudio: 22_900, firstSound: 23_000 }) // 3.0
    expect(t.line()).toMatch(/^last reply 3\.0 s .*; usual 3\.0 s over 3$/)
    turn(t, { heard: 30_000, started: 30_100, firstText: 34_000, firstAudio: 34_900, firstSound: 35_000 }) // 5.0
    expect(t.line()).toMatch(/; usual 3\.5 s over 4$/)                                                   // (3.0 + 4.0) / 2
    // A turn sent and still open (no sound yet, not closed) is kept, but the line still shows the last measured one.
    t.heard(60_000, false); t.claim()
    expect(t.line()).toMatch(/^last reply 5\.0 s .*; usual 3\.5 s over 4$/)
    for (let index = 0; index < 30; index += 1) {
      const at = 100_000 + index * 10_000
      turn(t, { heard: at, started: at + 100, firstText: at + 900, firstAudio: at + 1_100, firstSound: at + 1_200 })
    }
    expect(t.turns()).toHaveLength(dg.TIMING_TURNS_KEPT)
    expect(dg.TIMING_TURNS_KEPT).toBe(20)
    expect(t.line()).toBe('last reply 1.2 s to first sound (plus 0.8 s end-of-speech wait): hand-off 0.1, thinking 0.8, voice 0.3; usual 1.2 s over 20')
  })

  it('the cut-off sign: he spoke again after a final and before her first sound while her reply was on its way, or within 2 s after it', () => {
    const t = dg.createTurnTimes()
    // Before her first sound, while she thinks: a SpeechStarted, then a second final.
    t.heard(1_000, false)
    const first = t.claim()
    t.mark(first, 'sent', 1_000)
    t.spokeAgain(1_500, true)
    expect(t.turns()[0]).toMatchObject({ againBefore: true, againAfter: false })
    t.heard(1_700, true)                                           // the second final: a new turn
    const second = t.claim()
    expect(second).not.toBe(first)
    turn(t, { heard: 5_000, firstText: 6_000, firstAudio: 6_200, firstSound: 6_300 })
    // Within 2 s after her first sound: counted. At 2 s and 1 ms: not.
    t.spokeAgain(6_300 + dg.SPOKE_AGAIN_AFTER_MS, false)
    expect(t.turns().at(-1)).toMatchObject({ againBefore: false, againAfter: true })
    turn(t, { heard: 20_000, firstText: 21_000, firstAudio: 21_200, firstSound: 21_300 })
    t.spokeAgain(21_300 + dg.SPOKE_AGAIN_AFTER_MS + 1, false)
    // A final long after a reply that never sounded, with nothing on its way, is not a sign.
    t.heard(40_000, false); t.claim()
    t.heard(60_000, false)
    expect(t.turns().map(item => [item.againBefore, item.againAfter])).toEqual([
      [true, false], [false, false], [false, true], [false, false], [false, false], [false, false]])
    expect(dg.SPOKE_AGAIN_AFTER_MS).toBe(2000)
    expect(t.line()).toMatch(/; usual 1\.3 s over 2; you spoke again early in 2 of 6$/)
  })

  it('stamps that are not hers are refused: audio before her phrase, a sound before her audio, a turn not yet sent; the first stamp wins', () => {
    const t = dg.createTurnTimes()
    t.heard(1_000, false)
    t.audio('firstAudio', 1_100)                                   // the newest turn was not sent yet: not its audio
    const clock = t.claim()
    t.audio('firstSound', 1_200)                                   // no audio of hers yet: the last reply's sound
    t.audio('firstAudio', 1_300)                                   // no phrase of hers yet: not her audio
    t.mark(clock, 'firstText', 2_000)
    t.mark(clock, 'firstText', 2_500)
    t.mark(clock, 'firstPhrase', 2_000)
    t.audio('firstAudio', 2_400)
    t.audio('firstAudio', 2_600)
    t.audio('firstSound', 2_700)
    t.audio('heard', 2_800)
    t.mark(clock, 'nonsense', 2_900)
    t.mark(clock, 'firstToken', Number.NaN)
    t.heard(Number.POSITIVE_INFINITY, false)
    t.mark({ heard: 0, claimed: true, againBefore: false, againAfter: false }, 'firstText', 1)  // a turn it does not hold
    expect(t.turns()).toEqual([{ heard: 1_000, claimed: true, againBefore: false, againAfter: false,
      firstText: 2_000, firstPhrase: 2_000, firstAudio: 2_400, firstSound: 2_700 }])
  })

  it('a mark frame: the three stages, and model, effort, tool rounds and prompt bytes, bounded; anything else is ignored', () => {
    const t = dg.createTurnTimes()
    t.heard(1_000, false)
    const clock = t.claim()
    t.frame(clock, { t: 'mark', v: 'journaled', model: `  ${'m'.repeat(200)} `, effort: 'low', toolRounds: 2, promptBytes: 81_441 }, 1_100)
    t.frame(clock, { t: 'mark', v: 'accepted' }, 1_200)
    t.frame(clock, { t: 'mark', v: 'started', toolRounds: 3 }, 1_300)
    t.frame(clock, { t: 'mark', v: 'firstSound' }, 1_400)          // not a mark stage
    t.frame(clock, { t: 'mark', v: 'started' }, 9_999)            // the first stamp wins
    t.frame(clock, { t: 'mark', toolRounds: -1, promptBytes: 1.5, effort: 7, model: '' }, 1_500)
    t.frame(clock, 'not a frame', 1_600)
    t.frame(null, { t: 'mark', v: 'started' }, 1_700)
    expect(t.turns()[0]).toEqual({ heard: 1_000, claimed: true, againBefore: false, againAfter: false,
      journaled: 1_100, accepted: 1_200, started: 1_300, model: 'm'.repeat(80), effort: 'low', toolRounds: 3, promptBytes: 81_441 })
    expect(t.line()).toBe('')
  })

  it('the review\'s order, scripted: a turn closed before her first sound takes no later turn\'s sound, says it was cut, and is not "usual"', () => {
    const t = dg.createTurnTimes()
    turn(t, { heard: 0, started: 100, firstText: 1_000, firstAudio: 1_900, firstSound: 2_000 })      // 2.0
    // He speaks turn A; its first phrase is handed to the voice; before its audio he types: A is cut, the typed turn
    // goes out unclaimed, and the typed reply's audio and sound arrive 40 s later.
    t.heard(10_000, false)
    const a = t.claim()
    t.mark(a, 'sent', 10_000); t.frame(a, { t: 'mark', v: 'started' }, 10_300); t.mark(a, 'firstText', 11_000); t.mark(a, 'firstPhrase', 11_000)
    t.close()                                                      // A is cut
    t.close()                                                      // the typed turn is sent with no clock
    t.audio('firstAudio', 50_000); t.audio('firstSound', 51_100)   // the typed reply's: credited to no turn
    expect(t.turns().at(-1)).toEqual({ heard: 10_000, claimed: true, againBefore: false, againAfter: false,
      sent: 10_000, started: 10_300, firstText: 11_000, firstPhrase: 11_000, cut: true })
    expect(t.line()).toBe('last reply: cut before first sound; usual 2.0 s over 1')
    // The same when the turn's audio arrived but the player had not yet reported it audible.
    t.heard(60_000, false)
    const b = t.claim()
    t.mark(b, 'firstText', 61_000); t.mark(b, 'firstPhrase', 61_000); t.audio('firstAudio', 61_200)
    t.close()
    t.audio('firstSound', 101_000)
    expect(t.turns().at(-1)).toMatchObject({ heard: 60_000, firstAudio: 61_200, cut: true })
    expect(t.turns().at(-1)).not.toHaveProperty('firstSound')
    expect(t.line()).toBe('last reply: cut before first sound; usual 2.0 s over 1')
    // A normal turn after the cut ones is measured as itself; the cut ones stay out of "usual": median of 2.0 and 1.4.
    turn(t, { heard: 120_000, started: 120_200, firstText: 121_000, firstAudio: 121_300, firstSound: 121_400 })
    expect(t.line()).toBe('last reply 1.4 s to first sound (plus 0.8 s end-of-speech wait): hand-off 0.2, thinking 0.8, voice 0.4; usual 1.7 s over 2')
  })

  it('claiming a turn closes the one before it; a turn that sounded stays measured when closed; with nothing measured the cut line stands alone', () => {
    const t = dg.createTurnTimes()
    t.close()                                                      // nothing playing: nothing happens
    expect(t.line()).toBe('')
    t.heard(1_000, false)
    const a = t.claim()
    t.mark(a, 'firstPhrase', 1_500)
    t.heard(3_000, false)
    t.claim()                                                      // the next turn is sent: A's sound can no longer be A's
    t.audio('firstAudio', 3_200)                                   // no phrase of the new turn yet: nobody's
    expect(t.turns()[0]).toEqual({ heard: 1_000, claimed: true, againBefore: false, againAfter: false, firstPhrase: 1_500, cut: true })
    expect(t.turns()[1]).toEqual({ heard: 3_000, claimed: true, againBefore: false, againAfter: false })
    expect(t.line()).toBe('last reply: cut before first sound')
    const u = dg.createTurnTimes()
    turn(u, { heard: 0, firstText: 500, firstAudio: 700, firstSound: 800 })
    u.close()
    expect(u.turns()[0]).not.toHaveProperty('cut')
    expect(u.line()).toMatch(/^last reply 0\.8 s .*; usual 0\.8 s over 1$/)
    expect(dg.timingLine([{ heard: 0, cut: true }, { heard: 5, cut: 'yes' }])).toBe('last reply: cut before first sound')
  })

  it('it does no I/O, and a broken view never stops a turn', () => {
    const from = voiceSource.indexOf('// ---- the timing line')
    expect(from).toBeGreaterThan(0)
    const code = voiceSource.slice(from).split('\n').filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n')
    const io = new RegExp(['fetch', 'Storage', 'indexedDB', 'cookie', 'setTimeout', 'setInterval', 'postMessage', 'WebSocket', 'sendBeacon',
      'document', 'window', 'navigator', 'console', '\\.send\\('].join('|'))
    expect(code).not.toMatch(io)
    const t = dg.createTurnTimes({ onChange: () => { throw new Error('the drawer is gone') } })
    expect(() => turn(t, { heard: 0, firstText: 1, firstAudio: 2, firstSound: 3 })).not.toThrow()
    expect(t.line()).toMatch(/^last reply 0\.0 s/)
    expect(dg.timingLine('nonsense')).toBe('')
    expect(dg.timingLine([null, 7, { heard: 5, firstSound: 4 }])).toBe('')
  })
})

describe('the page (aumalive.js, as text): every timing-stamp line only stamps', () => {
  const lines = page.split('\n')
  const tagged = lines.filter(line => /\/\/ timing stamp$/.test(line))
  it('nineteen marked lines; turnTimes and the line\'s element are named nowhere else', () => {
    expect(tagged).toHaveLength(19)
    const named = /\bturnTimes\b|\blogTiming\b|\bherAudioIn\b|\bhisSpeechIn\b/
    expect(lines.filter(line => named.test(line) && !tagged.includes(line))).toEqual([])
    expect(page).toContain('import { voiceSocketFor, forgetNoPass, voiceInputPlan, ORGAN_WAIT_MS } from \'/app/deepgram-voice.js\';\n')
    expect(page).toContain('import { createTurnTimes, END_OF_SPEECH_MS } from \'/app/deepgram-voice.js\'; // timing stamp\n')
  })

  it('no marked line asks for, sends, says, schedules, stores or cancels anything', () => {
    const acts = new RegExp(['fetch', '\\.say\\(', '\\.send\\(', 'postMessage', 'setTimeout', 'setInterval', 'Storage', 'indexedDB', 'addTurn', 'toast',
      'requestTurn\\(', 'transmit\\(', 'bargeIn', 'abort', 'cancel', '\\bspeak\\w*\\(', 'endTurn', 'setMode'].join('|'))
    for (const line of tagged) {
      const code = line.replace(/\/\/ timing stamp$/, '')
      expect(code, line).not.toMatch(acts)
    }
  })

  it('the line sits in the drawer\'s header, in the existing style of the "who is listening" line, and starts hidden', () => {
    expect(page).toContain('  logHead.append(logVoice);\n')
    expect(page).toContain('const logTiming = el(\'div\', \'alv-log-voice alv-log-timing\'); logTiming.hidden = true; logHead.append(logTiming); // timing stamp')
    expect(page).not.toMatch(/\.alv-log-timing\s*\{/)                // no style of its own: no new colour, nothing floating
  })
})

// ---- the voice-turn path, lifted from aumalive.js and run with and without the timing-stamp lines ----
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`not found: ${start} … ${end}`)
  return text.slice(from, to)
}
async function until(condition: () => boolean, label: string, limitMs = 2000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (condition()) return
    if (Date.now() - started > limitMs) throw new Error(`timed out after ${String(limitMs)} ms waiting for: ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
const settle = async () => { for (let tick = 0; tick < 12; tick += 1) await new Promise(resolve => setImmediate(resolve)) }

function liftedScript(withStamps: boolean) {
  const taggedLine = (start: string) => page.split('\n').find(line => line.trimStart().startsWith(start) && line.endsWith('// timing stamp')) ?? ''
  const parts = [
    'let channel = true, streaming = false, curAbort = null, duplex = true, herAudible = false, ttsPending = 0, ttsId = 0, staleSpeech = false;',
    'let lastSpoken = "", lastSpokenAt = Number.NEGATIVE_INFINITY, ttsQueueFb = 0, micMuted = false, chosenVoice = "flux-sienna-en";',
    'let presenceBlocked = false, canvasRequestId = "", announcedAgentWait = "", playbackLeaseRefresh = 0, lastMicRms = 0;',
    'const ttsRequests = new Map();',
    page.split('\n').find(line => line.includes('let speechTurn = 0;')) ?? '',
    taggedLine('const logTiming = '),
    taggedLine('const turnTimes = '),
    page.slice(page.indexOf('function sanitizeForVoice(s) {'), page.indexOf('\n}\n', page.indexOf('function sanitizeForVoice(s) {')) + 3),
    between(page, '  function dropHer() {', '  // ---- sidecar events ----'),
    between(page, '  function speakFallback(text) {', '  // fallback STT'),
    between(page, '  voice.on = {', '  if (surfaceActive && channel) voice.enable(voiceClaim);'),
    between(page, '  let pendingTurn = null;', '  // one honest announcement'),
    `const lvl = ${between(page, '      playerNode.port.onmessage = ', '\n      return true;')}`,
    '({ requestTurn, lvl, streaming: () => streaming, times: typeof turnTimes === "undefined" ? null : turnTimes })',
  ].join('\n')
  if (withStamps) return parts
  const stripped = parts.split('\n').filter(line => !/\/\/ timing stamp$/.test(line)).join('\n')
  expect(stripped).not.toMatch(/\bturnTimes\.|\blogTiming\b|\bclock\b/)
  return stripped
}

/** The fakes around the lifted code; `log` records everything the voice loop does, in order. */
function stage(withStamps: boolean) {
  const clock = { at: 0 }
  const log: unknown[] = []
  const streams: Array<{ send: (frame: unknown) => void; close: () => void }> = []
  const encoder = new TextEncoder()
  const timingEl = { className: '', hidden: true, textContent: '' }
  const refused = new Set<string>()                 // phrases the voice organ refuses: the page speaks them in the browser's voice
  const voice = {
    on: {} as Record<string, (message: unknown) => void>, voices: [] as unknown[], ws: null,
    say: (...args: unknown[]) => { log.push(['say', ...args]); return !refused.has(String(args[1])) },
    cancel: () => { log.push(['cancel']) },
    her: (on: boolean) => { log.push(['her', on]) },
  }
  const presenceFetch = async (path: string, init: { method: string; body: string; signal: AbortSignal; headers: unknown }) => {
    log.push(['presence', path, init.method, init.headers, JSON.parse(init.body)])
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let closed = false
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const open = {
      send: (frame: unknown) => { if (!closed) controller?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)) },
      close: () => { if (!closed) { closed = true; controller?.close() } },
    }
    // As the in-page session adapter does (genesis-live.js presence): an abort is answered at once with `done`.
    init.signal.addEventListener('abort', () => { open.send({ t: 'done', reason: 'aborted' }); open.close() }, { once: true })
    streams.push(open)
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  }
  const context: Record<string, unknown> = {
    performance: { now: () => clock.at }, Date, JSON, Number, Map, Math, String, Error, Promise, AbortController, TextDecoder,
    setTimeout: (_fn: unknown, ms: number) => { log.push(['timer', ms]); return 1 }, clearTimeout: () => {},
    voice, logHead: { append: () => {} },
    el: (_tag: string, cls: string) => { timingEl.className = cls; return timingEl },
    createTurnTimes: dg.createTurnTimes, END_OF_SPEECH_MS: dg.END_OF_SPEECH_MS,
    makeDirectiveFilter: directives.makeDirectiveFilter, isSelfEcho: duplexModule.isSelfEcho,
    phraseCut: eleven.phraseCut, ELEVEN_VOICE_PICK: eleven.ELEVEN_VOICE_PICK,
    canvasMode: false, closed: false, surfaceActive: true, chosenMind: 'balanced',
    voiceSession: { sessionId: 'voice-1', voiceSessionToken: 'v'.repeat(32), expiresAt: Number.POSITIVE_INFINITY },
    home: { id: 'home-1', answered: true, waitForHome: async () => '' },
    turnSessionNow: () => 'voice-1', turnSessionId: () => 'voice-1',
    bindTranscript: (id: string) => { log.push(['bind', id]) },
    settleTurnSession: (id: string, entries: unknown[]) => { log.push(['settle', id, entries.length]) },
    addTurn: (role: string, text: string, replyId?: string) => { log.push(['addTurn', role, text, replyId]); return { role, text } },
    toast: (text: string) => { log.push(['toast', text]) },
    setMode: (mode: string) => { log.push(['mode', mode]) },
    field: { burst: 0, think: 0, sayEnv: 0, micEnv: 0, alien: (tag: string) => { log.push(['field', tag]) } },
    ensureAudio: async () => true,
    duplexGate: { herSpeaking: (on: boolean) => { log.push(['gate', on]) }, selfEchoes: 0, strict: false, threshold: 0.1 },
    playerNode: { port: { postMessage: (message: unknown) => { log.push(['player', message]) } } },
    pushPcm: (buffer: ArrayBuffer) => { log.push(['pcm', buffer.byteLength]) },
    armReplyWatchdog: () => {}, clearReplyWatchdog: () => {}, refreshPlaybackLeases: () => { log.push(['lease']) },
    organName: () => 'Deepgram cloud voice', fbChosen: null, fbKeep: 0, fbKeepAlive: () => {}, clearInterval: () => {},
    window: { speechSynthesis: { speak: (u: { text: string }) => { log.push(['fallback', u.text]) }, cancel: () => {} } },
    SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text } },
    classifySelfQuestion: (text: string) => (text === 'who are you' ? { kind: 'identity' } : null),
    selfIndex: { gather: async () => ({ name: 'Auma' }) },
    answerSelfQuestion: () => ({ status: 'answered' }),
    renderSelfAnswer: (_answer: unknown, form: string) => (form === 'spoken' ? 'I am Auma.' : 'I am Auma, from my own index.'),
    speechWouldDelete: () => false,
    presenceFetch, PRESENCE_ENDPOINT: '/api/auma-live/presence/stream', PRESENCE_FIRST_EVENT_TIMEOUT_MS: 18000, PRESENCE_IDLE_TIMEOUT_MS: 22000,
    headerSessionId: () => '', SESSION_HEADER: 'x-auma-live-session', FALLBACK_HEADER: 'x-auma-live-fallback', REFUSAL_HEADER: 'x-auma-live-refusal',
    refusalSentence: () => 'refused', fallbackSentence: () => '',
    providerState: { textContent: '' },
  }
  const lifted = runInNewContext(liftedScript(withStamps), context) as {
    requestTurn: (text: string, spoken?: boolean) => void
    lvl: (event: { data: unknown }) => void
    streaming: () => boolean
    times: TurnTimes | null
  }
  return { lifted, voice, clock, log, streams, logTiming: timingEl, refused }
}

/** One scripted conversation: a whole reply; a cut-off after her first sound; a cut-off before it; a self answer. */
async function conversation(withStamps: boolean) {
  const s = stage(withStamps)
  const on = s.voice.on
  const sound = (audible: boolean) => { s.lifted.lvl({ data: { t: 'lvl', rms: audible ? 0.05 : 0, buffered: audible ? 480 : 0, audible } }) }
  const said = () => s.log.filter(entry => (entry as unknown[])[0] === 'say').length
  // Turn 1: heard at 10.0 s, her turn started at 10.3, her first word at 11.9, her audio at 12.2, her sound at 12.4.
  s.clock.at = 10_000
  on.final?.({ text: 'what is staged for me' })
  await until(() => s.streams.length === 1, 'turn 1 sent')
  s.clock.at = 10_300; s.streams[0]?.send({ t: 'mark', v: 'started', model: 'deepseek-flash', effort: 'max', toolRounds: 0, promptBytes: 81_441 }); await settle()
  s.clock.at = 11_800; s.streams[0]?.send({ t: 'tok', v: '[field teal energy=0.3] ' }); await settle()
  s.clock.at = 11_900; s.streams[0]?.send({ t: 'tok', v: 'Two cards are waiting. ' }); await until(() => said() === 1, 'her first phrase')
  s.clock.at = 12_200; on.tts_begin?.({ id: 1, sr: 24000 }); on.pcm?.(new ArrayBuffer(4))
  s.clock.at = 12_400; sound(true)
  s.streams[0]?.send({ t: 'tok', v: 'Both came from Pearl.' }); s.streams[0]?.send({ t: 'done', reason: 'completed' })
  s.streams[0]?.send({ t: 'manifested', replyId: 'reply-1' }); s.streams[0]?.close()
  await until(() => !s.lifted.streaming(), 'turn 1 ended')
  on.tts_end?.({ id: 1 }); on.tts_begin?.({ id: 2, sr: 24000 }); on.pcm?.(new ArrayBuffer(6)); on.tts_end?.({ id: 2 })
  sound(false)
  // Turn 2: he speaks again 0.8 s after her first sound; then, while she thinks, again: that turn is cut and replaced.
  s.clock.at = 13_200; on.vad?.({ t: 'vad', speaking: true })
  s.clock.at = 13_600; on.final?.({ text: 'and the deploy' })
  await until(() => s.streams.length === 2, 'turn 2 sent')
  s.clock.at = 13_700; s.streams[1]?.send({ t: 'mark', v: 'started' }); await settle()
  s.clock.at = 14_000; on.vad?.({ t: 'vad', speaking: true })
  s.clock.at = 14_200; on.final?.({ text: 'from this morning' })
  await until(() => s.streams.length === 3, 'the replacing turn sent')
  s.clock.at = 14_300; s.streams[2]?.send({ t: 'mark', v: 'started' }); await settle()
  s.clock.at = 15_000; s.streams[2]?.send({ t: 'tok', v: 'It ran at nine. ' }); await until(() => said() === 3, 'the replacing reply\'s first phrase')
  s.clock.at = 15_400; on.tts_begin?.({ id: 3, sr: 24000 }); on.pcm?.(new ArrayBuffer(4))
  s.clock.at = 15_500; sound(true)
  s.streams[2]?.send({ t: 'done', reason: 'completed' }); s.streams[2]?.close()
  await until(() => !s.lifted.streaming(), 'the replacing turn ended')
  on.tts_end?.({ id: 3 }); sound(false)
  // Turn 3: a question about herself, answered from her own index (no model).
  s.clock.at = 20_000; on.final?.({ text: 'who are you' })
  await until(() => said() === 4, 'her self answer')
  s.clock.at = 20_250; on.tts_begin?.({ id: 4, sr: 24000 }); on.pcm?.(new ArrayBuffer(4))
  s.clock.at = 20_300; sound(true)
  on.tts_end?.({ id: 4 }); sound(false)
  await settle()
  return s
}

describe('the voice loop, run: identical with and without the stamps; the line matches the scripted stamps', () => {
  it('every request, voice message, player message, transcript entry and timer is the same; only the line differs', async () => {
    const plain = await conversation(false)
    const stamped = await conversation(true)
    expect(plain.lifted.times).toBeNull()
    expect(stamped.log).toEqual(plain.log)
    // The run did what it says: three requests, four phrases asked of the voice, one cut. As the sceptic found (B4), the
    // half already sent is aborted and the second final goes out ALONE: the join rule joins queued requests only.
    const requests = plain.log.filter(entry => (entry as unknown[])[0] === 'presence') as Array<[string, string, string, unknown, { text: string; spoken: boolean }]>
    expect(requests.map(entry => [entry[1], entry[2], entry[4].text, entry[4].spoken])).toEqual([
      ['/api/auma-live/presence/stream', 'POST', 'what is staged for me', true],
      ['/api/auma-live/presence/stream', 'POST', 'and the deploy', true],
      ['/api/auma-live/presence/stream', 'POST', 'from this morning', true],
    ])
    expect(plain.log.filter(entry => (entry as unknown[])[0] === 'say').map(entry => (entry as unknown[])[2]))
      .toEqual(['Two cards are waiting.', 'Both came from Pearl.', 'It ran at nine.', 'I am Auma.'])
    expect(plain.log.filter(entry => (entry as unknown[])[0] === 'cancel').length).toBeGreaterThan(0)
    expect(plain.logTiming.textContent).toBe('')
    expect(plain.logTiming.hidden).toBe(true)

    const times = stamped.lifted.times
    expect(times?.turns()).toEqual([
      { heard: 10_000, claimed: true, againBefore: false, againAfter: true, sent: 10_000, started: 10_300, model: 'deepseek-flash', effort: 'max', toolRounds: 0,
        promptBytes: 81_441, firstToken: 11_800, firstText: 11_900, firstPhrase: 11_900, firstAudio: 12_200, firstSound: 12_400 },
      { heard: 13_600, claimed: true, againBefore: true, againAfter: false, sent: 13_600, started: 13_700, cut: true },
      { heard: 14_200, claimed: true, againBefore: false, againAfter: false, sent: 14_200, started: 14_300,
        firstToken: 15_000, firstText: 15_000, firstPhrase: 15_000, firstAudio: 15_400, firstSound: 15_500 },
      { heard: 20_000, claimed: true, againBefore: false, againAfter: false,
        firstText: 20_000, firstPhrase: 20_000, firstAudio: 20_250, firstSound: 20_300 },
    ])
    const line = 'last reply 0.3 s to first sound (plus 0.8 s end-of-speech wait): hand-off ?, thinking ?, voice 0.3; usual 1.3 s over 3; you spoke again early in 2 of 4'
    expect(times?.line()).toBe(line)
    expect(stamped.logTiming.textContent).toBe(line)
    expect(stamped.logTiming.hidden).toBe(false)
    expect(stamped.logTiming.className).toBe('alv-log-voice alv-log-timing')
  })
})

/**
 * The review's two sequences, run through the page's own code: a spoken turn cut by typing before its audio (and one cut
 * after its audio, before the player heard it), and a spoken turn whose reply went out in the browser's own voice; each
 * followed by a typed turn whose audio must not be credited to it. Then a normal spoken turn, measured as itself.
 */
async function reviewSequences(withStamps: boolean) {
  const s = stage(withStamps)
  const on = s.voice.on
  const sound = (audible: boolean) => { s.lifted.lvl({ data: { t: 'lvl', rms: audible ? 0.05 : 0, buffered: audible ? 480 : 0, audible } }) }
  const says = () => s.log.filter(entry => (entry as unknown[])[0] === 'say') as unknown[][]
  const lastId = () => Number(says().at(-1)?.[1])
  const play = (at: number) => { s.clock.at = at; on.tts_begin?.({ id: lastId(), sr: 24000 }); on.pcm?.(new ArrayBuffer(4)) }
  const finish = async (index: number) => {
    s.streams[index]?.send({ t: 'done', reason: 'completed' }); s.streams[index]?.close()
    await until(() => !s.lifted.streaming(), `stream ${String(index)} ended`)
  }
  // A: heard at 10.0 s, her first phrase at 11.9; at 12.0, before her audio, he types in the drawer.
  s.clock.at = 10_000; on.final?.({ text: 'what is staged for me' })
  await until(() => s.streams.length === 1, 'A sent')
  s.clock.at = 10_300; s.streams[0]?.send({ t: 'mark', v: 'started' }); await settle()
  s.clock.at = 11_900; s.streams[0]?.send({ t: 'tok', v: 'Two cards are waiting. ' }); await until(() => says().length === 1, 'A\'s first phrase')
  s.clock.at = 12_000; s.lifted.requestTurn('and the deploy', false)
  await until(() => s.streams.length === 2, 'the typed turn sent')
  s.clock.at = 12_100; on.tts_begin?.({ id: 1, sr: 24000 }); on.pcm?.(new ArrayBuffer(4)); on.tts_end?.({ id: 1 })   // A's audio, stale
  s.clock.at = 50_000; s.streams[1]?.send({ t: 'tok', v: 'It ran at nine. ' }); await until(() => says().length === 2, 'the typed reply')
  play(51_000); s.clock.at = 51_100; sound(true)
  await finish(1); on.tts_end?.({ id: lastId() }); sound(false)
  const afterTyping = s.lifted.times?.line() ?? ''
  // B: heard at 60.0 s; its audio arrives at 61.2; at 61.25, before the player reports it audible, he types.
  s.clock.at = 60_000; on.final?.({ text: 'and the cards' })
  await until(() => s.streams.length === 3, 'B sent')
  s.clock.at = 61_000; s.streams[2]?.send({ t: 'tok', v: 'Pearl made both. ' }); await until(() => says().length === 3, 'B\'s first phrase')
  play(61_200)
  s.clock.at = 61_250; s.lifted.requestTurn('stop there', false)
  await until(() => s.streams.length === 4, 'the second typed turn sent')
  s.clock.at = 70_000; s.streams[3]?.send({ t: 'tok', v: 'Stopped. ' }); await until(() => says().length === 4, 'the second typed reply')
  play(70_200); s.clock.at = 70_300; sound(true)
  await finish(3); on.tts_end?.({ id: lastId() }); sound(false)
  // C: heard at 80.0 s; the voice organ refuses her phrase, so it goes out in the browser's voice; then he types.
  s.refused.add('The plan has three steps.')
  s.clock.at = 80_000; on.final?.({ text: 'read me the plan' })
  await until(() => s.streams.length === 5, 'C sent')
  s.clock.at = 81_000; s.streams[4]?.send({ t: 'tok', v: 'The plan has three steps. ' }); await until(() => says().length === 5, 'C\'s phrase')
  await finish(4)
  s.clock.at = 85_000; s.lifted.requestTurn('thanks', false)
  await until(() => s.streams.length === 6, 'the third typed turn sent')
  s.clock.at = 90_000; s.streams[5]?.send({ t: 'tok', v: 'You are welcome. ' }); await until(() => says().length === 6, 'the third typed reply')
  play(90_200); s.clock.at = 90_300; sound(true)
  await finish(5); on.tts_end?.({ id: lastId() }); sound(false)
  // D: a normal spoken turn: heard at 100.0, started 100.2, first word 101.0, audio 101.3, sound 101.4.
  s.clock.at = 100_000; on.final?.({ text: 'and after that' })
  await until(() => s.streams.length === 7, 'D sent')
  s.clock.at = 100_200; s.streams[6]?.send({ t: 'mark', v: 'started' }); await settle()
  s.clock.at = 101_000; s.streams[6]?.send({ t: 'tok', v: 'Then we ship. ' }); await until(() => says().length === 7, 'D\'s first phrase')
  play(101_300); s.clock.at = 101_400; sound(true)
  await finish(6); on.tts_end?.({ id: lastId() }); sound(false)
  await settle()
  return { s, afterTyping }
}

describe('the review\'s finding, run: a turn cut before her first sound is never credited with another turn\'s sound', () => {
  it('typed after a spoken turn, browser voice, a cut after her audio: each closed turn reads "cut before first sound"; the next spoken turn is measured as itself', async () => {
    const plain = await reviewSequences(false)
    const stamped = await reviewSequences(true)
    expect(stamped.s.log).toEqual(plain.s.log)                     // the stamps change nothing the voice loop does
    expect(plain.s.log.filter(entry => (entry as unknown[])[0] === 'fallback')).toEqual([['fallback', 'The plan has three steps.']])
    const requests = plain.s.log.filter(entry => (entry as unknown[])[0] === 'presence') as Array<[string, string, string, unknown, { text: string; spoken: boolean }]>
    expect(requests.map(entry => [entry[4].text, entry[4].spoken])).toEqual([
      ['what is staged for me', true], ['and the deploy', false], ['and the cards', true], ['stop there', false],
      ['read me the plan', true], ['thanks', false], ['and after that', true]])
    // Before the fix, A took the typed reply's sound: "last reply 41.1 s to first sound".
    expect(stamped.afterTyping).toBe('last reply: cut before first sound')
    expect(stamped.s.lifted.times?.turns()).toEqual([
      { heard: 10_000, claimed: true, againBefore: false, againAfter: false, sent: 10_000, started: 10_300,
        firstToken: 11_900, firstText: 11_900, firstPhrase: 11_900, cut: true },
      { heard: 60_000, claimed: true, againBefore: false, againAfter: false, sent: 60_000,
        firstToken: 61_000, firstText: 61_000, firstPhrase: 61_000, firstAudio: 61_200, cut: true },
      { heard: 80_000, claimed: true, againBefore: false, againAfter: false, sent: 80_000,
        firstToken: 81_000, firstText: 81_000, firstPhrase: 81_000, cut: true },
      { heard: 100_000, claimed: true, againBefore: false, againAfter: false, sent: 100_000, started: 100_200,
        firstToken: 101_000, firstText: 101_000, firstPhrase: 101_000, firstAudio: 101_300, firstSound: 101_400 },
    ])
    const line = 'last reply 1.4 s to first sound (plus 0.8 s end-of-speech wait): hand-off 0.2, thinking 0.8, voice 0.4; usual 1.4 s over 1'
    expect(stamped.s.lifted.times?.line()).toBe(line)
    expect(stamped.s.logTiming.textContent).toBe(line)
    expect(plain.s.logTiming.textContent).toBe('')
  })
})
