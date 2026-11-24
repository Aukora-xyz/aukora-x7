/**
 * BROWSER FACTS: what this browser actually answered, kept where the boot page, Continuity or a person reading the
 * console can see it (`globalThis.__AUKORA_BROWSER__`, refreshed with an `aukora:browser-facts` event).
 *
 * - `storageKeep`: after her worker has attached its local store, the page asks the browser to keep
 *   that store (`navigator.storage.persist()`), and records the TRUE answer: kept, not kept, unsupported, or no answer.
 *   It is asked once per load, never blocks boot, and is never retried in a loop. A browser that answers after the wait
 *   (Firefox asks the person, who may take minutes) has its answer recorded when it comes: the timeout is only the
 *   interim fact. Only the page can ask: `persist()` is
 *   a Window method, absent in workers. If the store is evicted anyway, the worker rehydrates from the edge mirror on
 *   the next load (`webworker-runtime/src/storage/idb-persist.ts`, a browser with no durable history reads the whole
 *   `/api/snapshot`).
 * - `ceremonyGaps` (B12): the capabilities she can start without but cannot bind, approve or run Wasm cells without.
 *   The boot page says both while she starts (`dsh-client-web` boot-page.ts browserFactNotes, same event and global).
 * @module apps/web/src/browser-facts
 */

/** The page global the facts are kept on. */
export const BROWSER_FACTS_GLOBAL = '__AUKORA_BROWSER__'
/** Dispatched on the page whenever a fact is recorded. */
export const BROWSER_FACTS_EVENT = 'aukora:browser-facts'
/** How long the keep request may take before it is recorded as unanswered (Firefox asks the person first). */
export const STORAGE_KEEP_WAIT_MS = 60_000

/** The browser's answer to "keep her local store". */
export type StorageKeep =
  | { readonly kind: 'kept'; readonly asked: boolean }
  | { readonly kind: 'not-kept' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unanswered'; readonly reason: string }

/** Everything recorded so far; null means not yet known. */
export interface BrowserFacts {
  readonly storageKeep: StorageKeep | null
  readonly ceremonyGaps: readonly string[] | null
}

/** The slice of `navigator.storage` the keep request uses. */
export interface KeepableStorage {
  readonly persisted?: () => Promise<boolean>
  readonly persist?: () => Promise<boolean>
}

type FactsScope = { [BROWSER_FACTS_GLOBAL]?: BrowserFacts; dispatchEvent?: (event: Event) => boolean }

/**
 * Record one or more facts and announce them.
 * @param patch - The facts to set.
 * @param scope - The page global; specs pass their own.
 * @returns The facts after the update.
 */
export function recordBrowserFacts(patch: Partial<BrowserFacts>, scope: FactsScope = globalThis): BrowserFacts {
  const next: BrowserFacts = Object.freeze({
    storageKeep: null, ceremonyGaps: null, ...scope[BROWSER_FACTS_GLOBAL], ...patch,
  })
  scope[BROWSER_FACTS_GLOBAL] = next
  try {
    scope.dispatchEvent?.(new CustomEvent(BROWSER_FACTS_EVENT, { detail: next }))
  } catch { /* a page without CustomEvent still keeps the global */ }
  return next
}

/**
 * Ask the browser to keep her local store, and say what it answered. Never throws, never waits past `waitMs`.
 * A store the browser already keeps is not asked again (Firefox would otherwise prompt on every load).
 * @param storage - `navigator.storage`, or undefined where the browser has none.
 * @param waitMs - How long to wait for the answer.
 * @param onLate - Given the browser's eventual answer when it comes after `waitMs` (the returned `unanswered` was only
 *   the interim fact). Never called when the answer came in time, nor when it never comes.
 * @returns The browser's answer, or `unanswered` when it has not answered within `waitMs`.
 */
export async function askToKeepLocalStore(
  storage: KeepableStorage | undefined, waitMs: number = STORAGE_KEEP_WAIT_MS, onLate?: (answer: StorageKeep) => void,
): Promise<StorageKeep> {
  if (typeof storage?.persist !== 'function') return { kind: 'unsupported' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const late = new Promise<StorageKeep>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ kind: 'unanswered', reason: `no answer within ${String(Math.round(waitMs / 1000))} s` })
    }, waitMs)
  })
  const ask = async (): Promise<StorageKeep> => {
    try {
      if (typeof storage.persisted === 'function' && await storage.persisted()) return { kind: 'kept', asked: false }
      return (await storage.persist?.()) === true ? { kind: 'kept', asked: true } : { kind: 'not-kept' }
    } catch (error) {
      return { kind: 'unanswered', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const answer = ask()
  // The eventual answer, published once it arrives if the wait ran out first. Not awaited by anything.
  void answer.then((eventual) => { if (timedOut) onLate?.(eventual) })
  try {
    return await Promise.race([answer, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The one line the console gets for each answer. */
export function storageKeepLine(answer: StorageKeep): string {
  switch (answer.kind) {
    case 'kept': return answer.asked
      ? 'x6-storage: this browser agreed to keep her local store'
      : 'x6-storage: this browser already keeps her local store'
    case 'not-kept': return 'x6-storage: this browser did not agree to keep her local store; it may clear it, and she then reloads her memory from the edge'
    case 'unsupported': return 'x6-storage: this browser cannot be asked to keep her local store; if it clears it, she reloads her memory from the edge'
    case 'unanswered': return `x6-storage: asking this browser to keep her local store got no answer (${answer.reason})`
  }
}
