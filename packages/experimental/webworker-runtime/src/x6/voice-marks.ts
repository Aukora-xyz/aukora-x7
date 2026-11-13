/**
 * Look-only voice: which sessions are look-only, kept where no model tool can reach it, and the
 * one judge every tool call of every session passes.
 *
 * The marks live in their own IndexedDB database (`aukora-x6-voice-look-only`, object store `marks`, key = session id),
 * outside the MemoryVfs and outside her cloud mirror: no file under /dsh/home holds them, so write, edit, bash and every
 * x6 tool cannot touch them (worker `node:vm` code cannot name `indexedDB` either, node/builtin_modules/implemented/vm.ts:5).
 * Marks only accumulate: nothing here removes one; the way back is a later owner-fingerprint action.
 *
 * A turn is "spoken" when one of its user messages carries the spoken provenance (voice-read-only.ts). A spoken prompt for
 * a session that is not look-only is taken out of its inbox as it enters (ball-loader.ts, `agent/inbox/inserted`), and
 * should one get through anyway, every tool call of its turn is refused in words.
 *
 * A mark is PENDING from the moment its session is proven until a write of it is confirmed: it guards the session at once
 * (the closed side), it is never reported saved, and every later mark retries it: first, or, for the re-mark of a session
 * already settled (saved, or over the cap), queued right after that answer, so a stuck write never stalls a saved voice
 * home. Marking is serialized,
 * so the cap is decided once per mark and cannot be passed by concurrent marks; a proven session refused for the cap is
 * guarded in this body all the same, never saved. Reload honours every stored mark: the cap bounds new marks, never the
 * reading of old ones. No mark is ever retired.
 *
 * Until the stored marks are known (still loading after the 2 s bound, or the store failed to load) a session that could
 * be the voice home by its own header (couldBeVoiceHome) is never treated as unmarked: while the load is still running its
 * tool calls wait in words; if the load failed it is judged look-only (stricter, never looser). A late load is used.
 */
import {
  couldBeVoiceHome, isSpokenUserMessage, voiceHomeProof, voiceVerdict, VOICE_LOADING_REFUSAL, VOICE_SPOKEN_ELSEWHERE_REFUSAL,
  type VoiceHomeRecord, type VoiceVerdictInput,
} from './voice-read-only.ts'

/** Persistent, add-only storage of look-only session ids. */
export interface VoiceMarkStore {
  load(): Promise<readonly string[]>
  add(sessionId: string): Promise<void>
}

export const VOICE_MARKS_DB = 'aukora-x6-voice-look-only'
export const VOICE_MARKS_STORE = 'marks'
/** The cap on NEW marks (accepted: saved or pending). Never applied to marks read back from the store. */
export const VOICE_MARKS_MAX = 64
/** Bound on each step inside the serialized mark section (record read, one store write), so one stuck step frees the rest. */
export const VOICE_MARK_STEP_MS = 10_000
/** A session id the voice route accepts: the page's v4-shaped ids and the host's own (letters, digits, `-`, `_`). */
export const VOICE_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/
/** The probe id the worker uses to prove its guard is consulted for every agent (never a real session id). */
export const VOICE_PROBE_SESSION = 'x6:voice-look-only-probe'
export const VOICE_PROBE_REFUSAL = 'VOICE_LOOK_ONLY_PROBE'

/** The worker's IndexedDB store, or null where IndexedDB does not exist (then nothing can be marked: voice fails closed). */
export function indexedDbVoiceMarkStore(
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
): VoiceMarkStore | null {
  if (!idb) return null
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = idb.open(VOICE_MARKS_DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(VOICE_MARKS_STORE)) req.result.createObjectStore(VOICE_MARKS_STORE)
    }
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('voice marks: open failed')) }
    req.onblocked = () => { reject(new Error('voice marks: open blocked')) }
  })
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(VOICE_MARKS_STORE, mode)
        const req = body(tx.objectStore(VOICE_MARKS_STORE))
        tx.oncomplete = () => { resolve(req.result) }
        tx.onerror = () => { reject(tx.error ?? new Error('voice marks: transaction failed')) }
        tx.onabort = () => { reject(tx.error ?? new Error('voice marks: transaction aborted')) }
      })
    } finally { db.close() }
  }
  return {
    load: async () => (await run('readonly', store => store.getAllKeys())).filter((key): key is string => typeof key === 'string'),
    add: async (sessionId) => { await run('readwrite', store => store.put({ markedAt: Date.now() }, sessionId)) },
  }
}

/** An in-memory store (tests, and the shape a simulated worker restart reloads from). */
export function memoryVoiceMarkStore(initial: readonly string[] = []): VoiceMarkStore & { readonly ids: Set<string> } {
  const ids = new Set(initial)
  return { ids, load: () => Promise.resolve([...ids]), add: (sessionId) => { ids.add(sessionId); return Promise.resolve() } }
}

/**
 * `loading`: marks not loaded, within the 2 s bound (every agent call waits). `loading-late`: past the bound, the load
 * still running (a session that could be the voice home waits). `ready`: loaded. `store-failed`: the load failed (a
 * session that could be the voice home is look-only). `unavailable`: no store at all, so no mark can exist here.
 */
export type VoiceLookOnlyState = 'loading' | 'loading-late' | 'ready' | 'store-failed' | 'unavailable'
/**
 * `ok` is true only when THIS session's mark is confirmed saved. `lookOnly`: this session is guarded in this body.
 * `unsaved`: present only when sessions guarded here still have no confirmed save (after this call's retries; a session
 * already saved or over the cap is answered at once and its retries run after the answer).
 * `next`: what to do next, on a refusal that has one.
 */
export interface VoiceMarkAnswer {
  readonly ok: boolean
  readonly code: string
  readonly lookOnly: boolean
  readonly say?: string
  readonly unsaved?: readonly string[]
  readonly next?: string
}
/** The page says this, word for word, when it cannot confirm look-only (A2). */
export const VOICE_UNCONFIRMED_SAY = 'My voice could not confirm it is look-only, so I did not send that.'
/** The `next` sentence of a VOICE_MARKS_FULL refusal. */
export const VOICE_MARKS_FULL_NEXT = `Voice already holds ${String(VOICE_MARKS_MAX)} saved look-only homes, the most it keeps; `
  + 'this thread stays look-only until the app restarts but is not saved. Speak in a voice home that is already saved; '
  + 'clearing old homes needs an owner fingerprint action that does not exist yet.'

export interface VoiceLookOnly {
  state(): VoiceLookOnlyState
  /** Resolves once the stored marks are loaded, or loading failed, or the 2 s bound passed (the load may still finish). */
  readonly ready: Promise<void>
  /** Guarded look-only in this body: saved, pending, or proven and refused for the cap. */
  isMarked(sessionId: string): boolean
  /** Look-only for this session now: marked, or (marks not known) its header says it could be the voice home. */
  looksOnly(sessionId: string, header: unknown): boolean
  /** May a spoken prompt enter this session? Only a look-only one. */
  admitsSpoken(sessionId: string, header: unknown): boolean
  marked(): readonly string[]
  /** Guarded sessions whose mark has no confirmed save (pending, or refused for the cap), oldest first. */
  unsaved(): readonly string[]
  /**
   * Mark a session look-only if its own record proves it is the voice home. Serialized: one mark at a time, pending
   * saves retried first. `ok: true` only once this session's write is confirmed.
   */
  mark(sessionId: unknown, readRecord: (sessionId: string) => Promise<VoiceHomeRecord | null>): Promise<VoiceMarkAnswer>
  /** Feed every session event (`session/event`): tracks whether the session's current turn was spoken. */
  noteSessionEvent(sessionId: string, event: { type?: unknown; data?: unknown }): void
  spokenTurn(sessionId: string): boolean
  /**
   * The one judge: undefined, or the refusal for a call by `sessionId`'s agent. `input` is built only when needed.
   * `header` is the session's own header (agent.session.header); it matters only while the marks are not known.
   */
  judge(sessionId: string, input: () => VoiceVerdictInput, header: unknown): string | undefined
  /** Switch marking off for good in this worker (its guard was not proven to cover every agent). */
  disable(reason: string): void
  disabledReason(): string | null
}

export function createVoiceLookOnly(
  options: { store: VoiceMarkStore | null; loadTimeoutMs?: number; stepTimeoutMs?: number },
): VoiceLookOnly {
  /** Every session guarded look-only in this body (the judge reads only this). */
  const marks = new Set<string>()
  /** Confirmed in the store: loaded from it, or a write of it resolved. */
  const saved = new Set<string>()
  /** Proven and accepted under the cap, write not yet confirmed (oldest first): retried by every later mark. */
  const pending = new Set<string>()
  /** Proven, refused for the cap: guarded while this body runs, never written. */
  const overCap = new Set<string>()
  const spoken = new Map<string, boolean>()
  let state: VoiceLookOnlyState = options.store ? 'loading' : 'unavailable'
  let disabled: string | null = options.store ? null : 'no-store'
  const store = options.store
  const ready = store ? new Promise<void>((resolve) => {
    const timer = setTimeout(() => { if (state === 'loading') state = 'loading-late'; resolve() }, options.loadTimeoutMs ?? 2000)
    // A load that finishes after the bound is still used: the state moves on from `loading-late` either way.
    store.load().then((ids) => {
      // Every stored mark is honoured, past the cap too (F2): the cap bounds new marks only.
      for (const id of ids) if (VOICE_SESSION_ID.test(id)) { marks.add(id); saved.add(id) }
      if (state === 'loading' || state === 'loading-late') state = 'ready'
    }, () => { if (state === 'loading' || state === 'loading-late') state = 'store-failed' }).finally(() => { clearTimeout(timer); resolve() })
  }) : Promise.resolve()

  /** The marks are not known, but they may exist (a store is configured): loading, late, or failed to load. */
  const marksUnknown = (): boolean => state === 'loading' || state === 'loading-late' || state === 'store-failed'
  const looksOnly = (id: string, header: unknown): boolean => marks.has(id) || (marksUnknown() && couldBeVoiceHome(header))

  const unsavedNow = (): string[] => [...pending, ...overCap]
  /** `unsaved` rides on an answer only when something guarded here has no confirmed save. */
  const withUnsaved = (answer: VoiceMarkAnswer): VoiceMarkAnswer => {
    const unsaved = unsavedNow()
    return unsaved.length === 0 ? answer : { ...answer, unsaved }
  }
  const refuse = (code: string, extra: Partial<VoiceMarkAnswer> = {}): VoiceMarkAnswer =>
    withUnsaved({ ok: false, code, lookOnly: false, say: VOICE_UNCONFIRMED_SAY, ...extra })
  const confirmed = (): VoiceMarkAnswer => withUnsaved({ ok: true, code: 'VOICE_LOOK_ONLY', lookOnly: true })

  const stepMs = options.stepTimeoutMs ?? VOICE_MARK_STEP_MS
  /** `work`, or `onLate` once the step bound passes (the work may still finish; nothing here depends on it then). */
  const bounded = <T>(work: () => Promise<T>, onLate: () => T): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { resolve(onLate()) }, stepMs)
    let begun: Promise<T>
    try { begun = work() } catch (error) { begun = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    begun.then(resolve, reject).finally(() => { clearTimeout(timer) })
  })
  /** One write; true only when the store confirmed it. A write past the bound counts as unconfirmed (retried later). */
  const write = async (sessionId: string): Promise<boolean> => {
    if (!store) return false
    try {
      if (!await bounded(() => store.add(sessionId).then(() => true), () => false)) return false
    } catch { return false }
    saved.add(sessionId)
    pending.delete(sessionId)
    return true
  }
  /**
   * Pending marks get one more write, oldest first, until one is not confirmed (F1: the next mark retries). Stopping there
   * keeps a mark to a few bounded steps when the store itself is failing; the rest wait for the next mark.
   */
  const retryPending = async (): Promise<void> => { for (const id of [...pending]) if (!await write(id)) return }

  /** The serialized section: one mark runs at a time, so the cap is checked and re-checked without a race (F2). */
  let tail: Promise<unknown> = Promise.resolve()
  const serialized = <T>(body: () => Promise<T>): Promise<T> => {
    const run = tail.then(body, body)
    tail = run.catch(() => undefined)
    return run
  }
  /**
   * A retry of the pending marks queued in the serialized section without waiting for it: the per-turn re-mark of a
   * saved (or over-cap) session is answered at once, never behind another session's stuck write. At most one is queued.
   */
  let retryQueued = false
  const queueRetry = (): void => {
    if (retryQueued || pending.size === 0) return
    retryQueued = true
    serialized(async () => { retryQueued = false; await retryPending() }).catch(() => undefined)
  }
  const accepted = (): number => saved.size + pending.size
  const markOne = async (
    sessionId: string, readRecord: (sessionId: string) => Promise<VoiceHomeRecord | null>,
  ): Promise<VoiceMarkAnswer> => {
    await retryPending()
    if (saved.has(sessionId)) return confirmed()
    if (pending.has(sessionId)) return refuse('VOICE_MARK_NOT_SAVED', { lookOnly: true })
    // Checked before the record is read (cheap) and re-checked after the proof, both inside this one section.
    let full = accepted() >= VOICE_MARKS_MAX
    let record: VoiceHomeRecord | null
    try { record = await bounded(() => readRecord(sessionId), () => null) } catch { record = null }
    if (record === null) return refuse('VOICE_SESSION_NOT_FOUND', { lookOnly: marks.has(sessionId) })
    const proof = voiceHomeProof(record)
    if (!proof.ok) return refuse('VOICE_HOME_UNPROVEN', { code: `VOICE_HOME_UNPROVEN:${proof.reason}`, lookOnly: marks.has(sessionId) })
    full ||= accepted() >= VOICE_MARKS_MAX
    // Look-only at once in this worker, before any write: a failed or refused write leaves it stricter, never looser.
    marks.add(sessionId)
    if (full) {
      overCap.add(sessionId)
      return refuse('VOICE_MARKS_FULL', { lookOnly: true, next: VOICE_MARKS_FULL_NEXT })
    }
    overCap.delete(sessionId)
    pending.add(sessionId)
    return await write(sessionId) ? confirmed() : refuse('VOICE_MARK_NOT_SAVED', { lookOnly: true })
  }

  return {
    state: () => state,
    ready,
    isMarked: id => marks.has(id),
    looksOnly,
    admitsSpoken: looksOnly,
    marked: () => [...marks],
    unsaved: unsavedNow,
    async mark(sessionId, readRecord) {
      if (typeof sessionId !== 'string' || !VOICE_SESSION_ID.test(sessionId)) return refuse('VOICE_SESSION_INVALID')
      await ready
      // A guard not proven global (or no known store) confirms nothing, a stored mark included.
      if (disabled !== null || state !== 'ready' || !store) return refuse('VOICE_LOOK_ONLY_UNAVAILABLE', { lookOnly: marks.has(sessionId) })
      // Settled answers need no section: `saved` only grows, and once a mark was refused for the cap the accepted count
      // (saved + pending, which only grows) is still at the cap. Pending retries are queued, not awaited.
      if (saved.has(sessionId)) { const answer = confirmed(); queueRetry(); return answer }
      if (overCap.has(sessionId)) {
        const answer = refuse('VOICE_MARKS_FULL', { lookOnly: true, next: VOICE_MARKS_FULL_NEXT })
        queueRetry()
        return answer
      }
      return serialized(() => markOne(sessionId, readRecord))
    },
    noteSessionEvent(sessionId, event) {
      if (event.type === 'turn/start') spoken.set(sessionId, false)
      else if (event.type === 'user/message' && isSpokenUserMessage(event.data)) spoken.set(sessionId, true)
      // Bounded: only turns that were NOT spoken are forgotten, so a spoken mark is never dropped to make room.
      if (spoken.size > 512) for (const [key, value] of spoken) if (!value) spoken.delete(key)
    },
    spokenTurn: id => spoken.get(id) === true,
    judge(sessionId, input, header) {
      if (sessionId === VOICE_PROBE_SESSION) return VOICE_PROBE_REFUSAL
      if (state === 'loading') return VOICE_LOADING_REFUSAL
      if (marks.has(sessionId)) return voiceVerdict(input())
      if (marksUnknown() && couldBeVoiceHome(header)) return state === 'loading-late' ? VOICE_LOADING_REFUSAL : voiceVerdict(input())
      if (spoken.get(sessionId) === true) return VOICE_SPOKEN_ELSEWHERE_REFUSAL
      return undefined
    },
    disable(reason) { disabled ??= reason },
    disabledReason: () => disabled,
  }
}
