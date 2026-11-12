/**
 * Who hears the owner in Auma Live when her voice organ is not here (apps/web/public/app/deepgram-voice.js,
 * `voiceInputPlan`, and the page that asks it, apps/web/public/app/aumalive.js).
 *
 * THE RULE UNDER TEST: the browser's own speech recogniser is the browser vendor's
 * service, so it is a FALLBACK reached only by a choice. The choice is Start Voice, authorized by the host, in this page
 * session; or the older flag `window.AUMA_LIVE_ALLOW_CLOUD_VOICE === true`. It is the path only while the organ is not
 * ready, and the screen says so for as long as it is. Where it cannot be used either, the transcript drawer opens and
 * says voice input is unavailable here and typing works.
 *
 * aumalive.js is one page script that cannot be loaded here, so the decision is a pure function, tested in every
 * combination, and the page is checked AS TEXT for the three things that make the function the decision: the browser's
 * constructor is named in one gate only, consent is set in one place only (after the host authorized the press), and
 * the recogniser is started only through the plan. What is NOT tested here is the page running in a browser.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const appFile = (name: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`)).find(existsSync)
  ?? `apps/web/public/app/${name}`
interface Facts {
  consented?: boolean
  flagAllowed?: boolean
  organReady?: boolean
  organPending?: boolean
  recogniserAvailable?: boolean
  recogniserDenied?: boolean
}
interface Plan { path: 'organ' | 'browser-recogniser' | 'typing'; status: string | null; openDrawer: boolean }
const mod = await import(pathToFileURL(appFile('deepgram-voice.js')).href) as {
  voiceInputPlan: (facts?: Facts) => Plan
  BROWSER_RECOGNISER_STATUS: string
  VOICE_INPUT_UNAVAILABLE_STATUS: string
  ORGAN_WAIT_MS: number
  PASS_TIMEOUT_MS: number
}
const page = readFileSync(appFile('aumalive.js'), 'utf8')
/** The page without its whole-line comments: what runs. */
const code = page.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length

const ORGAN: Plan = { path: 'organ', status: null, openDrawer: false }
const BROWSER: Plan = { path: 'browser-recogniser', status: 'The browser\'s own recogniser is listening. It is the browser vendor\'s service.',
  openDrawer: true }
const TYPING: Plan = { path: 'typing', status: 'Voice input is unavailable here. Typing works.', openDrawer: true }
const KEYS = ['consented', 'flagAllowed', 'organReady', 'organPending', 'recogniserAvailable', 'recogniserDenied'] as const
/** All 64 combinations of the six facts. */
const everyCombination = (): Facts[] => Array.from({ length: 2 ** KEYS.length }, (_, bits) =>
  Object.fromEntries(KEYS.map((key, index) => [key, (bits & (1 << index)) !== 0])) as Facts)

describe('Auma Live voice input: the browser recogniser is a consented fallback, and the screen says who listens', () => {
  it('the words on screen are these two sentences, short and plain, and the plan is their only source', () => {
    expect(mod.BROWSER_RECOGNISER_STATUS).toBe(BROWSER.status)
    expect(mod.VOICE_INPUT_UNAVAILABLE_STATUS).toBe(TYPING.status)
    expect(mod.BROWSER_RECOGNISER_STATUS.length).toBeLessThanOrEqual(90)
    // The page shows what the plan returns: neither sentence is written a second time in what runs.
    expect(code).not.toContain('recogniser is listening')
    expect(code).not.toContain('vendor\'s service')
    expect(code).not.toContain('Voice input is unavailable')
    expect(code).not.toContain('Typing works')
  })

  it('organ ready: the organ hears her, nothing is said, whatever else is so', () => {
    for (const facts of everyCombination().filter(each => each.organReady)) expect(mod.voiceInputPlan(facts)).toEqual(ORGAN)
  })

  it('organ not ready, Start Voice consented, the browser has a recogniser: it listens, and the screen says whose service it is', () => {
    const plan = mod.voiceInputPlan({ consented: true, flagAllowed: false, organReady: false, recogniserAvailable: true,
      recogniserDenied: false })
    expect(plan).toEqual(BROWSER)
    expect(plan.status).toContain('browser\'s own recogniser is listening')
    expect(plan.status).toContain('browser vendor\'s service')
    // The drawer opens for this path too: its line is the one lasting notice of who is listening (a toast is replaced by
    // the next toast within a second or two).
    expect(plan.openDrawer).toBe(true)
    // Each call answers the same, and what it returns cannot be edited into saying something else.
    expect(Object.isFrozen(plan)).toBe(true)
    expect(mod.voiceInputPlan({ consented: true, recogniserAvailable: true })).toEqual(BROWSER)
  })

  it('consent is for a FALLBACK: while the organ is still being asked for, nothing else listens and nothing is said', () => {
    const waiting = { consented: true, flagAllowed: false, organReady: false, organPending: true }
    expect(mod.voiceInputPlan({ ...waiting, recogniserAvailable: true, recogniserDenied: false })).toEqual(ORGAN)
    // Nothing is called missing before the organ has answered: no "unavailable", no drawer.
    expect(mod.voiceInputPlan({ ...waiting, recogniserAvailable: false })).toEqual(ORGAN)
    expect(mod.voiceInputPlan({ ...waiting, recogniserAvailable: true, recogniserDenied: true })).toEqual(ORGAN)
    expect(mod.voiceInputPlan({ organPending: true })).toEqual(ORGAN)
    // The answer "not here" is what lets the fallback listen.
    expect(mod.voiceInputPlan({ ...waiting, organPending: false, recogniserAvailable: true })).toEqual(BROWSER)
    // The wait is bounded, and longer than the pass request it contains.
    expect(mod.ORGAN_WAIT_MS).toBe(8000)
    expect(mod.ORGAN_WAIT_MS).toBeGreaterThan(mod.PASS_TIMEOUT_MS)
  })

  it('the flag still works as before: with it the recogniser listens from the moment the channel opens, consent or not', () => {
    for (const consented of [false, true]) {
      for (const organPending of [false, true]) {
        const facts = { consented, flagAllowed: true, organReady: false, organPending, recogniserAvailable: true }
        expect(mod.voiceInputPlan(facts)).toEqual(BROWSER)
      }
    }
    // And it is still only a fallback: an organ that is ready is the path.
    expect(mod.voiceInputPlan({ flagAllowed: true, organReady: true, recogniserAvailable: true })).toEqual(ORGAN)
  })

  it('no consent and no flag: the browser recogniser is never the path, in any combination; typing is', () => {
    const without = everyCombination().filter(each => !each.consented && !each.flagAllowed)
    expect(without).toHaveLength(16)
    for (const facts of without) {
      const plan = mod.voiceInputPlan(facts)
      expect(plan.path).not.toBe('browser-recogniser')
      expect(plan.status).not.toBe(BROWSER.status)
      if (!facts.organReady && !facts.organPending) expect(plan).toEqual(TYPING)
    }
    // Even where the browser has a recogniser and has refused nothing.
    const refusedNothing = { consented: false, flagAllowed: false, organReady: false, recogniserAvailable: true, recogniserDenied: false }
    expect(mod.voiceInputPlan(refusedNothing)).toEqual(TYPING)
    // A fact left out, or one that is not exactly true, is a no: nothing truthy-but-not-true opens the vendor's service.
    expect(mod.voiceInputPlan()).toEqual(TYPING)
    expect(mod.voiceInputPlan({})).toEqual(TYPING)
    const loose = { consented: 'yes', flagAllowed: 1, recogniserAvailable: true } as unknown as Facts
    expect(mod.voiceInputPlan(loose)).toEqual(TYPING)
    expect(mod.voiceInputPlan(null as unknown as Facts)).toEqual(TYPING)
  })

  it('no recogniser in this browser, or the browser refused it: typing, the drawer opens, and the screen says so', () => {
    for (const allowed of [{ consented: true }, { flagAllowed: true }, { consented: true, flagAllowed: true }]) {
      // No SpeechRecognition constructor.
      expect(mod.voiceInputPlan({ ...allowed, organReady: false, recogniserAvailable: false, recogniserDenied: false })).toEqual(TYPING)
      // 'not-allowed' / 'service-not-allowed', or a recogniser that failed.
      expect(mod.voiceInputPlan({ ...allowed, organReady: false, recogniserAvailable: true, recogniserDenied: true })).toEqual(TYPING)
      expect(mod.voiceInputPlan({ ...allowed, organReady: false, recogniserAvailable: false, recogniserDenied: true })).toEqual(TYPING)
    }
    expect(TYPING.status).toContain('Voice input is unavailable here')
    expect(TYPING.status).toContain('Typing works')
    expect(TYPING.openDrawer).toBe(true)
  })

  it('every combination gives one of exactly three answers, and the browser recogniser only on its full condition', () => {
    for (const facts of everyCombination()) {
      const plan = mod.voiceInputPlan(facts)
      const browser = !facts.organReady && (facts.consented || facts.flagAllowed) && facts.recogniserAvailable && !facts.recogniserDenied
        && (facts.flagAllowed || !facts.organPending)
      const expected = facts.organReady ? ORGAN : browser ? BROWSER : facts.organPending ? ORGAN : TYPING
      expect(plan, JSON.stringify(facts)).toEqual(expected)
    }
  })

  describe('the page (aumalive.js, read as text) does what the plan says', () => {
    it('names the browser\'s recogniser constructor in ONE gate only, which does not look for it without consent or the flag', () => {
      // In what runs, the constructor is named twice, both times in the gate's one line. Nothing else reaches it.
      expect(count(code, /SpeechRecognition/g)).toBe(2)
      const gate = new RegExp(['function recogniserCtor\\(\\) \\{', 'if \\(!CLOUD_VOICE_FLAG && !voiceConsent\\) return undefined;',
        'return window\\.SpeechRecognition \\|\\| window\\.webkitSpeechRecognition;', '\\}'].join('\\n\\s*')).exec(code)?.[0]
      expect(gate).toBeDefined()
      expect(count(code, /const CLOUD_VOICE_FLAG = window\.AUMA_LIVE_ALLOW_CLOUD_VOICE === true;/g)).toBe(1)
      // The flag is read once, from the page, and the gate is the only reader of the constructor.
      expect(count(code, /AUMA_LIVE_ALLOW_CLOUD_VOICE/g)).toBe(1)
      expect(count(code, /recogniserCtor\(\)/g)).toBe(3)
      expect(code).toContain('recogniserAvailable: typeof recogniserCtor() === \'function\'')
      // THE GATE ITSELF, RUN: without consent and without the flag it does not so much as read the window.
      const run = (window: object, flag: boolean, consent: boolean): unknown =>
        runInNewContext(`${gate ?? ''}\nrecogniserCtor();`, { window, CLOUD_VOICE_FLAG: flag, voiceConsent: consent })
      let looked = 0
      const Recogniser = () => 'a recogniser'
      const browser = {
        get SpeechRecognition() { looked += 1; return undefined },
        get webkitSpeechRecognition() { looked += 1; return Recogniser },
      }
      expect(run(browser, false, false)).toBeUndefined()
      expect(looked).toBe(0)
      expect(run(browser, false, true)).toBe(Recogniser)
      expect(run(browser, true, false)).toBe(Recogniser)
      expect(looked).toBe(4)
      expect(run({}, true, true)).toBeUndefined()
    })

    it('consent is set in one place, after the host authorized THIS Start Voice press, and is kept nowhere else', () => {
      // Declared off, read by the gate and by the plan's facts, set true once, and cleared when the channel closes: five
      // mentions, no more.
      expect(count(code, /\bvoiceConsent\b/g)).toBe(5)
      // STOP VOICE ENDS THE CONSENT: the next Start Voice has to give it again.
      const closing = code.slice(code.indexOf('function closeChannel()'), code.indexOf('function closeChannel()') + 1600)
      expect(closing).toContain('voiceConsent = false;')
      expect(closing.indexOf('voiceConsent = false;')).toBeLessThan(closing.indexOf('voice.disconnect();'))
      expect(count(code, /let voiceConsent = false;/g)).toBe(1)
      expect(count(code, /voiceConsent = true/g)).toBe(1)
      expect(code).toContain('consented: voiceConsent, flagAllowed: CLOUD_VOICE_FLAG, organReady: duplex, organPending: !organAbsent,')
      const opening = code.slice(code.indexOf('async function openChannel()'), code.indexOf('function closeChannel()'))
      const authorized = opening.indexOf('if (!await authorizeStartVoice(attempt) || !isCurrentMicAttempt(attempt)) return;')
      const consent = opening.indexOf('if (voiceSession?.attempt === attempt) voiceConsent = true;')
      const open = opening.indexOf('channel = true;')
      expect(authorized).toBeGreaterThan(0)
      expect(consent).toBeGreaterThan(authorized)
      expect(open).toBeGreaterThan(consent)
      // Never persisted: no line that touches the consent touches storage.
      expect(code.split('\n').filter(line => /voiceConsent/.test(line) && /storage|cookie|indexedDB/i.test(line))).toEqual([])
    })

    it('starts the recogniser only through the plan, keeping the guards it always had', () => {
      expect(page).toMatch(/import \{[^}]*\bvoiceInputPlan\b[^}]*\} from '\/app\/deepgram-voice\.js';/)
      expect(count(code, /voiceInputPlan\(/g)).toBe(1)
      const start = code.slice(code.indexOf('function startRecog() {'), code.indexOf('function stopRecog() {'))
      const guards = start.indexOf('if (recogOn || duplex || recogDead || micMuted) return;')
      const planned = start.indexOf('if (voiceInput().path !== \'browser-recogniser\') return;')
      const reached = start.indexOf('const SR = recogniserCtor();')
      const made = start.indexOf('const instance = new SR();')
      expect(guards).toBeGreaterThan(0)
      expect(planned).toBeGreaterThan(guards)
      expect(reached).toBeGreaterThan(planned)
      expect(made).toBeGreaterThan(reached)
      // One recogniser is ever constructed, there.
      expect(count(code, /new SR\(\)/g)).toBe(1)
      expect(count(code, /\bSR\b/g)).toBe(3)
    })

    it('shows the plan\'s status in the transcript drawer\'s header and opens the drawer when the plan says so', () => {
      // The line lives in the drawer's header, not over the orb.
      expect(code).toContain('const logVoice = el(\'div\', \'alv-log-voice\'); logVoice.hidden = true;')
      expect(code).toContain('logHead.append(logVoice);')
      const show = code.slice(code.indexOf('function showVoiceInput() {'), code.indexOf('function recogFail(msg) {'))
      expect(show).toContain('const status = voiceInputStatus();')
      expect(show).toContain('logVoice.textContent = status ?? \'\';')
      expect(show).toContain('logVoice.hidden = status === null;')
      expect(show).toContain('if (voiceInput().openDrawer) toggleLog(true);')
      // "Listening" is said only while the recogniser is running, and nothing is said with no channel open.
      expect(code).toContain('return plan.path === \'browser-recogniser\' && !recogOn ? null : plan.status;')
      expect(code).toMatch(/const voiceInputStatus = \(\) => \{\n\s*if \(!channel\) return null;/)
      // "Typing works" is not said in the canvas, whose drawer has no typing box.
      expect(code).toContain('if (plan.path === \'typing\' && canvasMode) return null;')
      expect(code).toContain('.alv-canvas-mode .alv-log-compose { display:none; }')
      // Kept true as things change: when it starts, when it stops, when the browser refuses it, when the organ answers.
      for (const within of [['function startRecog() {', 'function stopRecog() {'], ['function stopRecog() {', 'function fallbackVadTick('],
        ['function recogFail(msg) {', 'function scheduleSend('], ['    unavailable() {', '    down() {'],
        ['    down() {', '    owner_lost() {']] as const) {
        expect(code.slice(code.indexOf(within[0]), code.indexOf(within[1])), within[0]).toContain('showVoiceInput();')
      }
      // A refusal ('not-allowed' / 'service-not-allowed') goes through recogFail, which marks the recogniser denied.
      const refused = code.slice(code.indexOf('function recogFail(msg) {'), code.indexOf('function scheduleSend('))
      expect(refused.indexOf('recogDead = true;')).toBeLessThan(refused.indexOf('showVoiceInput();'))
      expect(code).toContain('recogniserDenied: recogDead,')
      expect(code).toMatch(/if \(kind === 'not-allowed' \|\| kind === 'service-not-allowed'\) \{\n\s*recogFail\(/)
      // A recogniser that cannot hear at all does not restart forever under a line that says it listens.
      expect(code).toMatch(/else if \(kind === 'audio-capture' \|\| kind === 'language-not-supported'\) \{\n\s*recogFail\(/)
      // NEVER BESIDE THE ORGAN, NEVER AFTER STOP OR MUTE: the recogniser is stopped when the organ is ready, when the
      // channel closes, and when the owner mutes.
      const ready = code.slice(code.indexOf('    ready() {'), code.indexOf('    unavailable() {'))
      expect(ready).toContain('stopRecog();')
      expect(ready.indexOf('stopRecog();')).toBeLessThan(ready.indexOf('toast('))
      expect(code.slice(code.indexOf('function closeChannel()'), code.indexOf('function closeChannel()') + 1600)).toContain('stopRecog();')
      const mute = code.slice(code.indexOf('function setMute('), code.indexOf('function setMute(') + 900)
      expect(mute).toContain('stopRecog()')
    })

    it('lets the fallback listen only once the organ has answered that it is not here, or has not answered in time', () => {
      // organAbsent: off at declaration, off for each fresh channel and at close, on by `unavailable`, `down` and the wait.
      expect(count(code, /organAbsent = true;/g)).toBe(3)
      const unavailable = code.slice(code.indexOf('    unavailable() {'), code.indexOf('    down() {'))
      expect(unavailable).toContain('if (!channel || duplex) return;')
      expect(unavailable.indexOf('organAbsent = true;')).toBeLessThan(unavailable.indexOf('if (!micMuted) startRecog();'))
      const down = code.slice(code.indexOf('    down() {'), code.indexOf('    owner_lost() {'))
      expect(down.indexOf('organAbsent = true;')).toBeGreaterThan(0)
      expect(down.indexOf('organAbsent = true;')).toBeLessThan(down.indexOf('if (!micMuted) startRecog();'))
      const opening = code.slice(code.indexOf('async function openChannel()'), code.indexOf('function closeChannel()'))
      expect(opening.indexOf('organAbsent = false;')).toBeGreaterThan(0)
      expect(opening.indexOf('organAbsent = false;')).toBeLessThan(opening.indexOf('voice.enable(owner);'))
      const wait = opening.slice(opening.indexOf('organWaitTimer = setTimeout(() => {'), opening.indexOf('}, ORGAN_WAIT_MS);'))
      expect(wait).toContain('if (!channel || duplex || organAbsent || !isCurrentMicAttempt(attempt)) return;')
      expect(wait.indexOf('organAbsent = true;')).toBeLessThan(wait.indexOf('if (!micMuted) startRecog();'))
      expect(opening).toContain('}, ORGAN_WAIT_MS);')
      const closing = code.slice(code.indexOf('function closeChannel() {'), code.indexOf('orb.addEventListener(\'click\''))
      expect(closing).toContain('clearTimeout(organWaitTimer); organWaitTimer = 0; organAbsent = false;')
    })
  })
})
