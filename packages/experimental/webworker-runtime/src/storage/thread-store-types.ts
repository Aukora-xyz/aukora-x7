/**
 * The shapes thread sync (thread-sync.ts) works with, kept apart so the lane marks (page side) and the tests can name
 * them without importing the worker code. Types only: nothing here runs.
 * @module thread-store-types
 */
import type { HydrationFacts } from './idb-persist.ts'

/** The edge's sync setting, read from the `sync` field of `GET /_thread/index`. Anything else reads as `off`. */
export type ThreadSyncMode = 'off' | 'pull' | 'on'

/**
 * What this page is for her threads, from local facts only (never from the mode):
 * - `reader`: never saved anything of its own and holds her cloud's home; read-only for this page load.
 * - `writer`: her one writer (never set by job 1).
 * - `none`: anything else (a browser that saved before and is not her writer, or local facts that could not be read).
 */
export type ThreadSyncRole = 'reader' | 'writer' | 'none'

/**
 * What the local store says, from the facts attach recorded while hydrating (`persistence.hydration`), before anything
 * else is decided:
 * - `saved-before`: this browser saved work of its own (seq above 0, a queued batch, a held save, unsent paths).
 * - `never-saved-cloud-home`: it never saved and holds her cloud's home (a revision above 0, stored or answered).
 * - `unconfirmed`: it never saved and her cloud did not answer at this boot, or answered something its fence does not
 *   match: unknown is not a writer, so it reads.
 * - `empty-node`: it never saved and her cloud answered, at this boot, that her home is empty (revision 0): a new world.
 * - `local`: the Mac host's loopback transport. `unknown`: no facts (no IndexedDB, or attach did not run).
 */
export type ThreadLocalFacts = 'never-saved-cloud-home' | 'saved-before' | 'unconfirmed' | 'empty-node' | 'local' | 'unknown'

/** The worker's word on BroadcastChannel `aukora-x6-thread-sync`. `footer` is plain text, 200 characters at most. */
export interface ThreadSyncStateMessage {
  readonly v: 1
  readonly kind: 'state'
  readonly at: number
  readonly mode: ThreadSyncMode
  readonly role: ThreadSyncRole
  readonly footer: string
  /** The page id this worker's page gave it at init (the d3marks SHOULD): a page shows only its own. */
  readonly worker?: string
}

/** The page's question on the same channel; answered with the latest state. */
export interface ThreadSyncAskMessage {
  readonly v: 1
  readonly kind: 'ask'
  /** The asking page's id; only the worker that page started answers it (a page that gave no id sends none). */
  readonly worker?: string
}

/** One thread as `GET /_thread/index` lists it (the fields thread sync reads). */
export interface ThreadIndexEntry {
  readonly id: string
  readonly path: string
  readonly bytes: number
  readonly activeAt?: number | null
  readonly updatedAt?: number | null
}

/** The lease as the index shows it: who holds her turn, if anyone. */
export interface ThreadIndexLease {
  readonly label?: string
  readonly live?: boolean
}

/** One answer from her edge, read whole and bounded: status, headers and body bytes. Status 0 is no answer. */
export interface ThreadNetReply {
  readonly status: number
  readonly headers: Headers
  readonly bytes: Uint8Array
}

/**
 * The network thread sync uses: same-origin GETs only, each with its own deadline in milliseconds and a cap on the
 * reply's bytes. Never rejects: no answer, a deadline or a reply over the cap is status 0.
 */
export interface ThreadNet {
  get(path: string, deadlineMs: number, maxBytes?: number): Promise<ThreadNetReply>
}

/** The part of the in-memory file system thread sync touches: read, and seed (silent, never persisted). */
export interface ThreadStore {
  existsSync(path: string): boolean
  statSync(path: string): { isFile(): boolean }
  readFileSync(path: string): string | Uint8Array
  seed(path: string, data: Uint8Array, options?: { mtimeMs?: number }): void
}

/** The part of idb-persist's `persistence` thread sync reads and sets. It never calls `inspect`. */
export interface ThreadPersistenceView {
  readOnly: boolean
  /** What attach recorded while hydrating; null when it did not run. */
  readonly hydration: HydrationFacts | null
  /** Checked before every append of her writer (job 2 A3 (4)). */
  readonly conflict?: string | null
  readonly localSave?: { readonly error: string | null }
}

/** The part of the in-memory file system her writer reads: stat and read only, never a write (job 2 A1). */
export interface ThreadReadStore {
  existsSync(path: string): boolean
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number | bigint }
  readdirSync(path: string): readonly unknown[]
  readFileSync(path: string): string | Uint8Array
}
