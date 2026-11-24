/**
 * Wave 7, Auma Live: ZERO STALE TAIL. After a barge-in (or a new utterance) cuts her reply, nothing of the abandoned turn
 * may speak: not audio the organ is still sending for a cut sentence, and not words of the cut reply that arrive on the
 * stream afterwards. aumalive.js is one page script that cannot be imported, so its three speech handlers are lifted from
 * the file's own text and RUN here against fakes, and the reply's flush guard is pinned in the text.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/aumalive.js`)).find(existsSync) ?? ''
const page = readFileSync(path, 'utf8')

/** The page's own tts_begin / tts_end / pcm handlers and cutHerVoice, running over fakes. */
function stage() {
  const handlers = page.slice(page.indexOf('    tts_begin(m) {'), page.indexOf('    err(m) {'))
  const cut = page.slice(page.indexOf('  function cutHerVoice() {'), page.indexOf('  // ---- sidecar events ----'))
  const played: string[] = []
  const context = {
    ttsRequests: new Map<number, { text: string; started: boolean; failed?: boolean }>(), ttsPending: 0, ttsQueueFb: 0, herAudible: true,
    staleSpeech: false, cancels: 0,
    playerNode: { port: { postMessage: (message: { cmd: string; id?: number }) => { played.push(`${message.cmd}${message.id === undefined ? '' : `:${String(message.id)}`}`) } } },
    voice: { her: () => {}, cancel: () => { context.cancels += 1 } },
    pushPcm: (buffer: ArrayBuffer) => { played.push(`pcm:${String(buffer.byteLength)}`) },
    armReplyWatchdog: () => {}, clearReplyWatchdog: () => {}, settleIfDone: () => {}, herStillAudible: () => false,
    dropHer: () => { context.ttsPending = 0; context.ttsRequests.clear() }, stopBrowserVoice: () => {},
  }
  const on = runInNewContext(`${cut}\n({ cutHerVoice, on: {\n${handlers}\n} })`, context) as {
    cutHerVoice: () => void
    on: { tts_begin: (m: { id: number; sr: number }) => void; tts_end: (m: { id: number }) => void; pcm: (buffer: ArrayBuffer) => void }
  }
  const ask = (id: number) => { context.ttsRequests.set(id, { text: `sentence ${String(id)}`, started: false }); context.ttsPending += 1 }
  return { ...on, context, played, ask }
}
const pcm = (bytes: number) => new ArrayBuffer(bytes)

describe('Auma Live: zero stale tail after an interruption', () => {
  it('a sentence the page asked for plays from begin to end, and is counted once', () => {
    const s = stage()
    s.ask(1)
    s.on.tts_begin({ id: 1, sr: 24000 }); s.on.pcm(pcm(4)); s.on.pcm(pcm(6)); s.on.tts_end({ id: 1 })
    expect(s.played).toEqual(['begin:1', 'pcm:4', 'pcm:6', 'end:1'])
    expect(s.context.ttsPending).toBe(0)
  })

  it('after a cut, audio still arriving for the cut sentence is dropped, and its late end takes nothing from the next turn', () => {
    const s = stage()
    s.ask(1)
    s.on.tts_begin({ id: 1, sr: 24000 }); s.on.pcm(pcm(4))
    // She is cut mid-sentence (a barge-in, or a new utterance): the player is cut and the organ is told to cancel.
    s.cutHerVoice()
    expect(s.played.slice(-1)).toEqual(['cut'])
    expect(s.context.cancels).toBe(1)
    const after = s.played.length
    // The organ had more of the cut sentence on the wire, and a queued sentence of the same abandoned turn behind it.
    s.on.pcm(pcm(8)); s.on.tts_end({ id: 1 })
    s.on.tts_begin({ id: 2, sr: 24000 }); s.on.pcm(pcm(8)); s.on.tts_end({ id: 2 })
    expect(s.played.slice(after)).toEqual([])
    // Her next turn is asked for and plays cleanly; the stale ends above took no pending count from it.
    s.ask(3)
    s.on.tts_begin({ id: 3, sr: 24000 }); s.on.pcm(pcm(2))
    expect(s.context.ttsPending).toBe(1)
    s.on.tts_end({ id: 3 })
    expect(s.played.slice(after)).toEqual(['begin:3', 'pcm:2', 'end:3'])
    expect(s.context.ttsPending).toBe(0)
  })

  it('a stale end arriving while the next turn is already pending does not make her look finished', () => {
    const s = stage()
    s.ask(1); s.on.tts_begin({ id: 1, sr: 24000 })
    s.cutHerVoice()
    s.ask(2)
    s.on.tts_end({ id: 1 })
    expect(s.context.ttsPending).toBe(1)
    expect(s.context.ttsRequests.has(2)).toBe(true)
  })

  it('the reply stream hands nothing to the voice once its turn is cut or replaced; every spoken sentence is one the page asked for', () => {
    const code = page.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')
    const flush = code.slice(code.indexOf('const flushSpeech = (endOfTurn) => {'), code.indexOf('const flushSpeech = (endOfTurn) => {') + 400)
    // The guard is the first statement of the flush: before any text is looked at.
    const guard = /^const flushSpeech = \(endOfTurn\) => \{\n\s*if \(abortCtl\.signal\.aborted \|\| curAbort !== abortCtl\) return;/
    expect(flush).toMatch(guard)
    // A barge-in aborts the turn that is speaking, then cuts her voice.
    const barge = code.slice(code.indexOf('function bargeIn() {'), code.indexOf('function bargeIn() {') + 220)
    expect(barge.indexOf('curAbort.abort()')).toBeGreaterThan(0)
    expect(barge.indexOf('cutHerVoice();')).toBeGreaterThan(barge.indexOf('curAbort.abort()'))
    // Every voice.say in the page is preceded by a request for that id (so its audio is not taken for a stale tail).
    const says = [...code.matchAll(/voice\.say\((\w+|\+\+ttsId),/g)]
    expect(says.length).toBeGreaterThanOrEqual(2)
    for (const say of says) {
      expect(say[1]).toBe('id')
      expect(code.slice(Math.max(0, (say.index ?? 0) - 400), say.index)).toContain('ttsRequests.set(id,')
    }
  })
})
