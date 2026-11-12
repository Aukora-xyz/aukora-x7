/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** The page event the worker's boot steps arrive on (webworker-runtime client.ts BOOT_PHASE_EVENT). */
export const BOOT_PHASE_EVENT = 'dsh:boot-phase'
/**
 * With nothing at all arriving for this long (no boot step, no bytes, no plugin), the page says she is still starting,
 * how long so far, and offers Reload. Never a verdict: only a named failure says she could not load.
 */
export const BOOT_STALL_MS = 45_000
/** While that notice shows, its "so far" time is refreshed this often. */
const STALL_REFRESH_MS = 5_000

/** What each worker boot step is called while it runs, and in the stall sentence. */
const PHASE_WORDS: Readonly<Record<string, { readonly hint: string; readonly doing: string }>> = Object.freeze({
  image: { hint: 'Loading her seed image…', doing: 'fetching her seed image' },
  storage: { hint: 'Opening her memory…', doing: 'opening her memory' },
  plugins: { hint: 'Loading plugins…', doing: 'loading her plugins' },
  head: { hint: 'Reading her head…', doing: 'reading her head' },
  serving: { hint: 'Loading plugins…', doing: 'loading her plugins' },
})

/** Plain sentences for the named boot failures the worker raises (idle-fetch.ts codes). */
const FAILURE_WORDS: ReadonlyArray<readonly [code: string, sentence: string]> = Object.freeze([
  ['BOOT_IMAGE_STALLED', 'She could not load: the network stopped answering while fetching her seed image. Reload to try again.'],
  ['BOOT_ARCHIVE_STALLED', 'She could not load: the network stopped answering while fetching part of her image. Reload to try again.'],
])

/**
 * The refusal a page below the engine floor rejects the boot gate with (webworker-runtime `client/engine-floor.ts`
 * BROWSER_BELOW_FLOOR): the code, a colon, then the missing capabilities, comma-separated.
 */
export const BROWSER_BELOW_FLOOR = 'BROWSER_BELOW_FLOOR'

/**
 * The plain sentence for a browser below the engine floor, or undefined for any other failure.
 * @param failure - The boot failure message.
 * @returns What the boot page says instead of "Failed to load plugins".
 */
export function belowFloorSentence(failure: string | undefined): string | undefined {
  const prefix = `${BROWSER_BELOW_FLOOR}:`
  if (failure?.startsWith(prefix) !== true) return undefined
  const missing = failure.slice(prefix.length).split(',').map(name => name.trim()).filter(name => name !== '')
  const last = missing.pop()
  const list = last === undefined ? 'a capability she needs' : missing.length === 0 ? last : `${missing.join(', ')} and ${last}`
  return `This browser cannot run her: it lacks ${list}. Open her in a current Chrome, Firefox or Safari.`
}

/**
 * What this browser answered about itself (apps/web `browser-facts.ts`): the page global it is kept on, and the event
 * each new fact is announced with. The boot page says them while she starts; they never stop or fail the boot.
 */
export const BROWSER_FACTS_GLOBAL = '__AUKORA_BROWSER__'
export const BROWSER_FACTS_EVENT = 'aukora:browser-facts'

/** The capabilities a browser can lack and still run her (webworker-runtime `client/engine-floor.ts` ceremonyGaps). */
const CEREMONY_WORDS: ReadonlyArray<readonly [name: string, consequence: string]> = Object.freeze([
  ['WebCrypto Ed25519', 'you cannot bind her or approve her changes in it'],
  ['WebAuthn passkeys', 'you cannot bind her or approve her changes in it'],
  ['WebCrypto digests', 'her Wasm cells cannot run in it'],
])

/** The browser's answer to "keep her local store", one sentence each. */
const STORAGE_KEEP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'kept': 'This browser keeps her local store.',
  'not-kept': 'This browser did not agree to keep her local store; if it clears it, she reloads her memory from the edge.',
  'unsupported': 'This browser cannot be asked to keep her local store; if it clears it, she reloads her memory from the edge.',
  'unanswered': 'This browser has not said whether it will keep her local store.',
})

/** Join names as "a", "a and b", "a, b and c". */
function spoken(names: readonly string[]): string {
  const head = names.slice(0, -1)
  const last = names.at(-1) ?? ''
  return head.length === 0 ? last : `${head.join(', ')} and ${last}`
}

/**
 * The plain sentences for what this browser answered about itself. Only names it knows are said; anything else is
 * left out rather than echoed.
 * @param facts - The recorded browser facts (`{ storageKeep, ceremonyGaps }`), or anything else.
 * @param secureContext - Whether this page is a secure context (browsers withhold WebAuthn and digests otherwise).
 * @returns Zero, one or two sentences.
 */
export function browserFactNotes(facts: unknown, secureContext: boolean): string[] {
  if (facts === null || typeof facts !== 'object') return []
  const { ceremonyGaps, storageKeep } = facts as { ceremonyGaps?: unknown; storageKeep?: unknown }
  const notes: string[] = []
  const gaps = Array.isArray(ceremonyGaps) ? CEREMONY_WORDS.filter(([name]) => ceremonyGaps.includes(name)) : []
  if (gaps.length > 0) {
    const consequences = [...new Set(gaps.map(([, consequence]) => consequence))]
    const why = secureContext ? '' : ' This page is not served over HTTPS, and browsers withhold these from such pages.'
    notes.push(`She runs in this browser, but it lacks ${spoken(gaps.map(([name]) => name))}, so ${consequences.join(' and ')}.${why}`)
  }
  const kind = storageKeep !== null && typeof storageKeep === 'object' ? (storageKeep as { kind?: unknown }).kind : undefined
  if (typeof kind === 'string' && Object.hasOwn(STORAGE_KEEP_WORDS, kind)) notes.push(STORAGE_KEEP_WORDS[kind] ?? '')
  return notes
}

/** Boot page seams; production uses the defaults. */
export interface BootPageOptions {
  /** Silence (ms) before the stall notice; default BOOT_STALL_MS. */
  readonly stallMs?: number
  /** What Reload does; default `location.reload()`. */
  readonly reload?: () => void
  /** Where boot-step events arrive; default the page's global scope. */
  readonly events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  /** Whether this page is a secure context; default `globalThis.isSecureContext` (true where the browser omits it). */
  readonly secureContext?: boolean
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined
  private phase: string | undefined
  private stalled = false
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  private observing = true
  private readonly startedAt = Date.now()
  private readonly stallMs: number
  private readonly reload: () => void
  private readonly events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined
  private readonly secureContext: boolean
  /** What this browser answered about itself, said under the hint while she starts (never a failure). */
  private notes: HTMLDivElement[] = []
  private readonly onFacts = (event: Event): void => {
    if (!this.observing) return
    this.showFacts((event as CustomEvent<unknown>).detail)
  }
  private readonly onPhase = (event: Event): void => {
    if (!this.observing) return
    const raw: unknown = (event as CustomEvent<unknown>).detail
    if (raw === null || typeof raw !== 'object') return
    const detail = raw as { phase?: unknown; bytes?: unknown }
    if (typeof detail.phase !== 'string') return
    this.phase = detail.phase
    const words = PHASE_WORDS[detail.phase]
    const megabytes = typeof detail.bytes === 'number' && Number.isFinite(detail.bytes) && detail.bytes > 0
      ? ` ${String(Math.round(detail.bytes / (1024 * 1024)))} MB` : ''
    if (words !== undefined) this.hint.textContent = `${words.hint}${megabytes}`
    this.updateProgress()
    this.progressed()
  }

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement, options: BootPageOptions = {}) {
    this.stallMs = options.stallMs ?? BOOT_STALL_MS
    this.reload = options.reload ?? (() => { globalThis.location.reload() })
    this.events = options.events ?? (typeof globalThis.addEventListener === 'function' ? globalThis : undefined)
    this.secureContext = options.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext !== false
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, 'HARNESS')
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
    // The worker's boot steps (image, storage, plugins, head, serving) and the image's arriving bytes count as progress.
    this.events?.addEventListener(BOOT_PHASE_EVENT, this.onPhase)
    // Browser facts already recorded before this page existed are said now; later ones arrive on their event.
    this.events?.addEventListener(BROWSER_FACTS_EVENT, this.onFacts)
    this.showFacts((globalThis as Record<string, unknown>)[BROWSER_FACTS_GLOBAL])
    this.armStall()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    if (!this.observing) return
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    if (!this.observing) return
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.progressed()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    if (!this.observing) return
    this.failure = message
    clearTimeout(this.stallTimer)
    this.render()
  }

  /**
   * The UI renderer has the mount point: boot is over, so the page stops observing it. No stall clock and no
   * boot-step listener survive a successful mount, and every mutator (setTotal, setState, fail) is a no-op after it.
   */
  handoff(): void {
    this.observing = false
    this.stalled = false
    clearTimeout(this.stallTimer)
    this.stallTimer = undefined
    this.events?.removeEventListener(BOOT_PHASE_EVENT, this.onPhase)
    this.events?.removeEventListener(BROWSER_FACTS_EVENT, this.onFacts)
  }

  /** Replace the browser-fact notes with what `facts` says, and redraw. Not progress: the stall clock is untouched. */
  private showFacts(facts: unknown): void {
    this.notes = browserFactNotes(facts, this.secureContext).map((sentence) => {
      const note = div(css.hint, sentence)
      note.dataset.dshBootNote = ''
      return note
    })
    this.render(true)
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.handoff()
    this.root.remove()
  }

  /** Something arrived: a still-starting notice clears, and the silence clock restarts. Never marks a boot failed. */
  private progressed(): void {
    this.stalled = false
    if (this.failure === undefined) this.armStall()
    this.render()
  }

  private armStall(): void {
    clearTimeout(this.stallTimer)
    if (!this.observing) return
    this.stallTimer = setTimeout(() => { this.showStillStarting() }, this.stallMs)
  }

  /** Long silence: say she is still starting and for how long, refreshed while it lasts. */
  private showStillStarting(): void {
    if (!this.observing || this.failure !== undefined) return
    this.stalled = true
    this.render()
    this.stallTimer = setTimeout(() => { this.showStillStarting() }, STALL_REFRESH_MS)
  }

  /** A Reload control for the stall and failure views. */
  private reloadButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshBootReload = ''
    button.textContent = 'Reload'
    button.addEventListener('click', () => { this.reload() })
    return button
  }

  /**
   * Redraw the state-dependent content below the wordmark.
   * @param notesChanged - The browser-fact notes changed, so the loading view is rebuilt even if its shape is the same.
   */
  private render(notesChanged = false): void {
    // After the handoff the renderer owns the mount point: nothing more is drawn into the boot page.
    if (!this.observing) return
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.stalled) {
        // Nothing new for stallMs, and no failure established: she is still starting (plugin activation and slow
        // networks can be quiet). Said plainly with the time so far; Reload is an option, not a verdict.
        const doing = PHASE_WORDS[this.phase ?? 'plugins']?.doing ?? 'loading'
        const seconds = Math.round((Date.now() - this.startedAt) / 1000)
        const notice = div(css.hint)
        notice.dataset.dshBootStalled = ''
        notice.append(div(undefined,
          `She is still starting (${String(seconds)} s so far, ${doing}). Nothing new for a while; you can wait or reload.`))
        notice.append(this.reloadButton())
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint, ...this.notes, notice)
        return
      }
      if (notesChanged || this.card.childElementCount !== 3 + this.notes.length || this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint, ...this.notes)
      }
      return
    }
    const report = div(css.failed)
    // Below the engine floor nothing failed to load: the browser lacks what she needs, and the page says which.
    const floor = belowFloorSentence(this.failure)
    if (floor !== undefined) {
      report.dataset.dshBootFloor = ''
      report.append(div(css.failedTitle, floor), this.reloadButton())
      this.card.replaceChildren(this.wordmark, report)
      return
    }
    const plain = this.failure === undefined ? undefined : FAILURE_WORDS.find(([code]) => this.failure?.includes(code))?.[1]
    if (plain !== undefined) report.append(div(css.failedTitle, plain))
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    report.append(this.reloadButton())
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    if (!this.observing) return
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    // Plugin activation progress, where the page has it (the client roster after the worker serves).
    if (this.total > 0 && (this.phase === undefined || this.phase === 'plugins' || this.phase === 'serving')) {
      this.hint.textContent = `Loading plugins… ${String(Math.min(this.active.size, this.total))}/${String(this.total)}`
    }
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
