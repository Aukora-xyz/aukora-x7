/**
 * Lane E5 / X65 WO-3, NORTH-STAR §24.4 Milestone G1 item 2: the runtime storage write-set, machine-readable.
 *
 * `RUNTIME_WRITE_SET` names every VFS path family the browser runtime (`src/x6/**`) writes, its class, and for authority
 * paths the transition kinds allowed to write it. `tests/x6/write-set-inventory.spec.ts` scans the source and fails when a
 * write site maps to no entry (an unanchored write path) or an entry has no site (a stale whitelist).
 * `createWriteSetRecorder` is the instrumented storage adapter: it attributes each write to the admitted transition
 * context in scope, records pre/post commitment roots over the authority store and refusal/effect counters, flags an
 * authority write outside an admitted context as unanchored, and on restart compares its starting root with the last
 * recorded one so out-of-band state drift is caught while plain reads change nothing.
 * Secret material (the receipt signing keypair) is listed so its writes are attributed, but its bytes are never hashed.
 * @module x6/write-set-inventory
 */
import type { Vfs } from '../storage/types.ts'
import { sha256HexSync } from '../module-system/module-loader.ts'
import { isTransitionKind, type TransitionContext, type TransitionKind } from './transition-context.ts'

export const WRITE_SET_SCHEMA = 'aukora.runtime-write-set.v1'

/**
 * `authority`: consequential control state; every write needs an admitted context of a listed kind.
 * `content-addressed`: bytes named by their own SHA-256 (verified on read); no context needed.
 * `continuity`: her self-authored working state, mirrored and restorable; attributed when a context is in scope.
 * `observation`: what she saw (page-eyes captures). `secret-material`: attributed, never hashed.
 */
export type WriteClass = 'authority' | 'content-addressed' | 'continuity' | 'observation' | 'secret-material'

export interface WriteSetEntry {
  readonly id: string
  readonly class: WriteClass
  /** Human-readable path family. */
  readonly pathPattern: string
  /** Anchored regular expression source matching every concrete path of the family. */
  readonly match: string
  /** For `authority`: the transition kinds admitted to write it. */
  readonly transitionKinds: readonly TransitionKind[]
  /** Source write sites: `file` under src/x6 and the exact target expression of the write call. */
  readonly writers: ReadonlyArray<{ readonly file: string; readonly target: string }>
  /** Writes performed by an organ through `ctx.fs` rather than a direct call in src/x6. */
  readonly via?: string
}

const HEAD_KINDS: readonly TransitionKind[] = ['seed.bootstrap', 'head.adopt', 'head.promote', 'ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore']
const BL = 'ball-loader.ts'
const w = (file: string, ...targets: string[]) => targets.map(target => ({ file, target }))

export const RUNTIME_WRITE_SET: readonly WriteSetEntry[] = Object.freeze([
  { id: 'head-manifest', class: 'authority', pathPattern: '/dsh/home/balls/HEAD.json', match: '^/dsh/home/balls/HEAD\\.json$',
    transitionKinds: HEAD_KINDS, writers: w(BL, 'HEAD_PATH') },
  { id: 'ball-history', class: 'authority', pathPattern: '/dsh/home/balls/history/{<ballId>,fork-<ballId>}.json (append-only)',
    match: '^/dsh/home/balls/history/(fork-)?[A-Za-z0-9]{1,128}\\.json$', transitionKinds: HEAD_KINDS,
    writers: w(BL, 'appendHistoricalFile:join(HISTORY_DIR, `fork-${currentBall.ballId}.json`)', 'appendHistoricalFile:join(HISTORY_DIR, `${currentBall.ballId}.json`)') },
  { id: 'receipt-chain', class: 'authority', pathPattern: '/dsh/home/auma/seed/{receipts.v3,checkpoints.v1}.jsonl',
    match: '^/dsh/home/auma/seed/(receipts\\.v3|checkpoints\\.v1)\\.jsonl$',
    transitionKinds: ['head.promote', 'ball.promote', 'head.adopt', 'head.stage', 'tree.patch', 'tree.undo', 'seed.bootstrap', 'snapshot.restore',
      'aura.attest', 'scion.compile'],
    writers: w(BL, 'seed-receipts:append'), via: 'seed-receipts organ (ctx.fs)' },
  { id: 'receipt-signing-key', class: 'secret-material', pathPattern: '/dsh/home/auma/seed/ed25519-keypair.json',
    match: '^/dsh/home/auma/seed/ed25519-keypair\\.json$', transitionKinds: [], writers: [], via: 'seed-receipts organ (ctx.fs), first append only' },
  { id: 'staged-head-promotion', class: 'authority', pathPattern: '/dsh/home/auma/staged/*.json (head promotion review envelopes)',
    match: '^/dsh/home/auma/staged/(?!outward-class3\\.json$)[A-Za-z0-9._-]{1,128}\\.json$', transitionKinds: ['head.stage', 'head.promote'],
    writers: w(BL, 'STAGED_HEAD_PROMOTION_PATH', 'rollbackStagePath', 'fullPath') },
  { id: 'staged-outward', class: 'authority', pathPattern: '/dsh/home/auma/staged/outward-class3.json',
    match: '^/dsh/home/auma/staged/outward-class3\\.json$', transitionKinds: ['outward.stage'], writers: w(BL, 'STAGED_OUTWARD_PATH') },
  { id: 'wake-steps', class: 'authority', pathPattern: '/dsh/home/auma/wake/steps.jsonl', match: '^/dsh/home/auma/wake/steps\\.jsonl$',
    transitionKinds: ['wake.step'], writers: w(BL, 'WAKE_STEPS_PATH') },
  { id: 'ball-code-store', class: 'content-addressed', pathPattern: '/dsh/home/balls/<sha256>.{js,meta.json}',
    match: '^/dsh/home/balls/[a-f0-9]{64}\\.(js|meta\\.json)$', transitionKinds: [],
    writers: w(BL, 'join(BALLS_DIR, `${sha}.js`)', 'join(BALLS_DIR, `${sha}.meta.json`)', 'join(BALLS_DIR, `${sha256}.meta.json`)',
      'ballFile', 'filePath', 'metaPath', 'ballPath', 'p') },
  { id: 'organ-store', class: 'content-addressed', pathPattern: '/dsh/home/organs/<sha256>.js', match: '^/dsh/home/organs/[a-f0-9]{64}\\.js$',
    transitionKinds: [], writers: w(BL, '`/dsh/home/organs/${meta.sha256}.js`', '`/dsh/home/organs/${sha}.js`', 'organFile', 'organStoreFile') },
  { id: 'named-organ-sources', class: 'continuity', pathPattern: '/dsh/home/auma/seed/organs/<id>.js',
    match: '^/dsh/home/auma/seed/organs/[a-z][a-z0-9-]{0,63}\\.js$', transitionKinds: [], writers: w(BL, 'named') },
  { id: 'snapshots', class: 'continuity', pathPattern: '/dsh/home/auma/snapshots/{<id>,LATEST}.json',
    match: '^/dsh/home/auma/snapshots/[A-Za-z0-9._-]{1,128}\\.json$', transitionKinds: [],
    writers: w(BL, 'LATEST_SNAPSHOT_PATH', 'appendHistoricalFile:snapshotPath') },
  { id: 'aura', class: 'continuity', pathPattern: '/dsh/home/auma/seed/aura{,-attest}.v1.json', match: '^/dsh/home/auma/seed/aura(-attest)?\\.v1\\.json$',
    transitionKinds: [], writers: w(BL, 'auraPath', 'attestPath') },
  { id: 'retention-suite-boot', class: 'continuity',
    pathPattern: '/dsh/home/auma/seed/pearl/retention-suite.v1.json[.before-<sha256>]',
    match: '^/dsh/home/auma/seed/pearl/retention-suite\\.v1\\.json(\\.before-[a-f0-9]{64})?$',
    transitionKinds: [], writers: w(BL, 'retentionBootPath') },
  { id: 'self-authored-state', class: 'continuity',
    pathPattern: '/dsh/home/auma/{prompt-sections.json,HANDOFF.md,WISH.md}, /dsh/home/auma-one/HANDOFF.md, /dsh/workspace/HANDOFF.md, cordis.patch.yml',
    match: '^(/dsh/home/auma/(prompt-sections\\.json|HANDOFF\\.md|WISH\\.md)|/dsh/home/auma-one/HANDOFF\\.md|/dsh/workspace/HANDOFF\\.md|/dsh/home/profiles/web/cordis\\.patch\\.yml)$',
    transitionKinds: [], writers: w(BL, 'PROMPT_SECTIONS_PATH', 'CORDIS_PATCH_PATH', 'HANDOFF_PATH', 'AUMA_ONE_HANDOFF_PATH', 'WORKSPACE_HANDOFF_PATH', 'WISH_PATH') },
  { id: 'page-eyes-captures', class: 'observation', pathPattern: '/dsh/home/{auma,auma-one}/captures/{latest.png,latest-projection.json,ring/*.png}',
    match: '^/dsh/home/(auma|auma-one)/captures/(latest\\.png|latest-projection\\.json|ring/[A-Za-z0-9-]{1,80}\\.png)$', transitionKinds: [],
    writers: w('page-eyes-bridge.ts', 'path', '`${CAPTURE_RING_DIR}/${name}`') },
] satisfies WriteSetEntry[])

/** Helpers whose own write call is not a site; their call sites are (scanned as `helper:target`). */
export const WRITE_HELPERS: ReadonlyArray<{ readonly file: string; readonly helper: string; readonly target: string }> = Object.freeze([
  { file: BL, helper: 'appendHistoricalFile', target: 'path' },
])

const compiled = RUNTIME_WRITE_SET.map(entry => ({ entry, re: new RegExp(entry.match) }))

/** The one inventory entry a concrete path belongs to, or null (uninventoried). */
export function classifyWritePath(path: string): WriteSetEntry | null {
  const hits = compiled.filter(item => item.re.test(path))
  return hits.length === 1 ? hits[0]?.entry ?? null : null
}

export interface WriteRecord {
  readonly seq: number
  readonly op: 'write' | 'append' | 'rename' | 'unlink' | 'rm'
  readonly path: string
  readonly entryId: string | null
  readonly class: WriteClass | 'uninventoried'
  readonly operationId: string | null
  readonly transitionKind: TransitionKind | null
  readonly anchored: boolean
  readonly reason: 'ADMITTED' | 'NOT_AUTHORITY' | 'NO_TRANSITION_CONTEXT' | 'TRANSITION_KIND_NOT_ADMITTED' | 'UNINVENTORIED_PATH'
  readonly preSha256: string | null
  readonly postSha256: string | null
}

export interface OperationRecord {
  readonly operationId: string
  readonly transitionKind: TransitionKind
  readonly preRoot: string
  readonly postRoot: string
  readonly writes: number
  readonly refusals: readonly string[]
  readonly effects: number
}

export interface WriteSetInventory {
  readonly schema: typeof WRITE_SET_SCHEMA
  readonly startRoot: string
  readonly finalRoot: string
  readonly resumed: { readonly previousFinalRoot: string; readonly drift: boolean } | null
  readonly operations: readonly OperationRecord[]
  readonly writes: readonly WriteRecord[]
  readonly unanchored: readonly WriteRecord[]
  readonly counters: {
    readonly writes: number
    readonly anchored: number
    readonly unanchored: number
    readonly refusals: number
    readonly effects: number
  }
}

const AUTHORITY_ROOTS = ['/dsh/home/balls', '/dsh/home/auma/seed', '/dsh/home/auma/staged', '/dsh/home/auma/wake']

const fileSha = (vfs: Vfs, path: string): string | null => {
  try {
    if (!vfs.existsSync(path)) return null
    const value = vfs.readFileSync(path) as unknown
    return sha256HexSync(typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array))
  } catch { return null }
}

const walk = (vfs: Vfs, dir: string, out: string[], depth = 0): void => {
  if (depth > 6) return
  let names: string[]
  try { names = (vfs.readdirSync(dir) as string[]).map(String) } catch { return }
  for (const name of names) {
    const full = `${dir}/${name}`
    let isDir = false
    try { isDir = vfs.statSync(full).isDirectory() } catch { continue }
    if (isDir) walk(vfs, full, out, depth + 1)
    else out.push(full)
  }
}

/**
 * Commitment root over the authority store: SHA-256 of the sorted `path NUL sha256` lines of every existing file whose
 * inventory class is `authority`. Secret material and other classes are excluded. Reading never changes it.
 */
export function authorityCommitmentRoot(vfs: Vfs): string {
  const files: string[] = []
  for (const root of AUTHORITY_ROOTS) walk(vfs, root, files)
  const lines = files.filter(path => classifyWritePath(path)?.class === 'authority').sort()
    .map(path => `${path}\u0000${fileSha(vfs, path) ?? 'absent'}`)
  return sha256HexSync(lines.join('\n'))
}

/**
 * Wrap a VFS so every write is attributed. `run(context, fn)` admits one transition for the duration of `fn`
 * (single-threaded worker: one admitted operation at a time; nested runs are refused).
 * @param vfs - the store to instrument.
 * @param options.previous - the last inventory recorded before a restart; its final root is compared with this start.
 */
export function createWriteSetRecorder(vfs: Vfs, options: { readonly previous?: WriteSetInventory } = {}): {
  readonly vfs: Vfs
  run<T>(context: TransitionContext, fn: () => T): T
  refuse(code: string): void
  effect(): void
  inventory(): WriteSetInventory
} {
  const startRoot = authorityCommitmentRoot(vfs)
  const writes: WriteRecord[] = []
  const operations: OperationRecord[] = []
  let current: { context: TransitionContext; preRoot: string; writes: number; refusals: string[]; effects: number } | null = null
  let seq = 0
  let refusalsTotal = 0
  let effectsTotal = 0
  const attribute = (op: WriteRecord['op'], path: string, mutate: () => void): void => {
    const entry = classifyWritePath(path)
    const secret = entry?.class === 'secret-material'
    const preSha256 = secret ? null : fileSha(vfs, path)
    mutate()
    const postSha256 = secret ? null : fileSha(vfs, path)
    const context = current?.context ?? null
    let reason: WriteRecord['reason']
    if (entry === null) reason = 'UNINVENTORIED_PATH'
    else if (entry.class !== 'authority') reason = 'NOT_AUTHORITY'
    else if (context === null) reason = 'NO_TRANSITION_CONTEXT'
    else reason = entry.transitionKinds.includes(context.transitionKind) ? 'ADMITTED' : 'TRANSITION_KIND_NOT_ADMITTED'
    const anchored = reason === 'ADMITTED' || (reason === 'NOT_AUTHORITY')
    seq += 1
    writes.push({ seq, op, path, entryId: entry?.id ?? null, class: entry?.class ?? 'uninventoried',
      operationId: context?.operationId ?? null, transitionKind: context?.transitionKind ?? null, anchored, reason, preSha256, postSha256 })
    if (current) current.writes += 1
  }
  const wrapped: Partial<Record<keyof Vfs, unknown>> = {
    writeFileSync: (path: string, ...rest: unknown[]) => { attribute('write', String(path), () => { (vfs.writeFileSync as (...a: unknown[]) => void)(path, ...rest) }) },
    appendFileSync: (path: string, data: string | Uint8Array) => { attribute('append', String(path), () => { vfs.appendFileSync(path, data) }) },
    unlinkSync: (path: string) => { attribute('unlink', String(path), () => { vfs.unlinkSync(path) }) },
    rmSync: (path: string, rmOptions?: { recursive?: boolean; force?: boolean }) => { attribute('rm', String(path), () => { vfs.rmSync(path, rmOptions) }) },
    renameSync: (from: string, to: string) => { attribute('rename', String(to), () => { vfs.renameSync(from, to) }) },
  }
  const proxy = new Proxy(vfs, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(wrapped, property)) return wrapped[property as keyof Vfs]
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  const close = (): void => {
    if (!current) return
    operations.push({ operationId: current.context.operationId, transitionKind: current.context.transitionKind, preRoot: current.preRoot,
      postRoot: authorityCommitmentRoot(vfs), writes: current.writes, refusals: [...current.refusals], effects: current.effects })
    current = null
  }
  return {
    vfs: proxy,
    run<T>(context: TransitionContext, fn: () => T): T {
      if (current) throw new Error('WRITE_SET_NESTED_TRANSITION')
      if (!isTransitionKind(context.transitionKind)) throw new Error('TRANSITION_CONTEXT_INVALID')
      current = { context, preRoot: authorityCommitmentRoot(vfs), writes: 0, refusals: [], effects: 0 }
      let result: T
      try { result = fn() } catch (error) { close(); throw error }
      if (result instanceof Promise) return result.finally(close) as T
      close()
      return result
    },
    refuse(code: string) { refusalsTotal += 1; current?.refusals.push(code.slice(0, 80)) },
    effect() { effectsTotal += 1; if (current) current.effects += 1 },
    inventory(): WriteSetInventory {
      const unanchored = writes.filter(record => !record.anchored)
      return {
        schema: WRITE_SET_SCHEMA,
        startRoot,
        finalRoot: authorityCommitmentRoot(vfs),
        resumed: options.previous
          ? { previousFinalRoot: options.previous.finalRoot, drift: options.previous.finalRoot !== startRoot }
          : null,
        operations: [...operations],
        writes: [...writes],
        unanchored,
        counters: { writes: writes.length, anchored: writes.length - unanchored.length, unanchored: unanchored.length,
          refusals: refusalsTotal, effects: effectsTotal },
      }
    },
  }
}

/** Lane E6: one live (runtime) write, classified against `RUNTIME_WRITE_SET` at the moment it happens. */
export interface LiveWriteRecord {
  readonly seq: number
  readonly at: number
  readonly op: WriteRecord['op']
  readonly path: string
  readonly entryId: string | null
  readonly class: WriteClass | 'uninventoried'
  readonly source: string
  /** True for a path no inventory entry names: flagged, never silently allowed into the ledger as known. */
  readonly flagged: boolean
}

export interface LiveWriteSetSnapshot {
  readonly schema: 'aukora.runtime-write-set.live.v1'
  readonly capacity: number
  readonly counters: { readonly writes: number; readonly flagged: number; readonly byClass: Readonly<Record<string, number>> }
  readonly recent: readonly LiveWriteRecord[]
  readonly flagged: readonly LiveWriteRecord[]
}

const LIVE_OPS: ReadonlyArray<readonly [string, WriteRecord['op'], number]> = [
  ['writeFileSync', 'write', 0], ['appendFileSync', 'append', 0], ['unlinkSync', 'unlink', 0], ['rmSync', 'rm', 0], ['renameSync', 'rename', 1],
]
const LIVE_WRAPPED = Symbol.for('aukora.x6.live-write-set')

/**
 * Lane E6 (G1 live): the bounded runtime recorder. `wrap(vfs, source)` returns a VFS whose write calls are recorded and
 * classified after they succeed (no hashing, O(1) per write, ring of `capacity` records plus at most `capacity`
 * flagged ones). Reads pass straight through. A path outside the inventory is flagged.
 */
export function createLiveWriteSetRecorder(capacity = 256) {
  const recent: LiveWriteRecord[] = []
  const flagged: LiveWriteRecord[] = []
  const byClass: Record<string, number> = {}
  let seq = 0
  let flaggedTotal = 0
  const record = (op: WriteRecord['op'], path: string, source: string): LiveWriteRecord => {
    const entry = classifyWritePath(path)
    seq += 1
    const item: LiveWriteRecord = Object.freeze({ seq, at: Date.now(), op, path: path.slice(0, 512), entryId: entry?.id ?? null,
      class: entry?.class ?? 'uninventoried', source, flagged: entry === null })
    byClass[item.class] = (byClass[item.class] ?? 0) + 1
    recent.push(item)
    if (recent.length > capacity) recent.shift()
    if (item.flagged) { flaggedTotal += 1; flagged.push(item); if (flagged.length > capacity) flagged.shift() }
    return item
  }
  const wrap = <V extends object>(vfs: V, source: string): V => {
    if ((vfs as Record<symbol, unknown>)[LIVE_WRAPPED] === true) return vfs
    return new Proxy(vfs, {
      get(target, property, receiver) {
        if (property === LIVE_WRAPPED) return true
        void receiver
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        const op = LIVE_OPS.find(([name]) => name === property)
        if (!op) return (value as (...a: unknown[]) => unknown).bind(target)
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          record(op[1], String(args[op[2]]), source)
          return result
        }
      },
    })
  }
  return {
    wrap,
    record,
    snapshot(): LiveWriteSetSnapshot {
      return Object.freeze({ schema: 'aukora.runtime-write-set.live.v1' as const, capacity,
        counters: Object.freeze({ writes: seq, flagged: flaggedTotal, byClass: Object.freeze({ ...byClass }) }),
        recent: Object.freeze([...recent]), flagged: Object.freeze([...flagged]) })
    },
  }
}

/** The one live recorder the runtime's own write paths (ball-loader, page-eyes bridge) report into. */
export const liveWriteSet = createLiveWriteSetRecorder()
