/**
 * One bounded status read for World and Self.
 *
 * The reader calls the existing `/__x6__/call-tool` route twice per refresh:
 * `auma_superagent` or, only after that name is unregistered, `auma.superagent`,
 * with `{ action: 'status' }`, and `seed_receipts` with `{ action: 'verify' }`.
 * It does not call `connectWorkerHost`, does not create a session, and does not poll.
 * A refresh aborts the previous page wait. `stop` is terminal.
 * VFS evidence uses bounded whole-file reads bracketed by matching rereads;
 * wake metadata uses a separate, read-only, same-origin `/_host/wake` GET.
 *
 * The current worker control handler starts tool execution with its own
 * `AbortController`, so aborting the page request ends the wait and sends the
 * tunnel abort frame. It does not prove the worker finished the tool.
 */
import {
  BALL_HEAD_PATH, CHECKPOINTS_PATH, DAG_HEAD_PATH, RECEIPTS_LOG_PATH, STALE_HEARTBEAT_MS, applyEvidence,
  type EvidenceFile,
} from './authority.ts'
import { AURA_DAG_LIMIT, auraDagHeads, auraDagParents, projectAura, projectPearl } from './aura.ts'
import { projectDiscoveryCorpus } from './prediction.ts'
import { sha256Hex, verifyReceiptChain } from './lineage.ts'
import { canonManifestPreimage, loaderManifestPreimage } from './manifest.ts'
import {
  CALL_TOOL_PATH, MAX_TOOL_BODY_CHARS, READ_TIMEOUT_MS, RECEIPT_TOOL_NAME, RECEIPT_VERIFY_ARGS,
  STATUS_READ_ARGS, SUPERAGENT_TOOL_NAMES, classifyToolBody, observationIsAged, pageTunnelFetch,
  parseReceipt, parseStatus, snapshotIsEmpty,
  type ReceiptRead, type StatusFailure, type StatusSnapshot, type SuperagentPhase, type ToolBody, type ToolResponse, type TunnelFetch,
} from './contract.ts'

/** Options for {@link createSuperagentRead}. */
export interface SuperagentReadOptions {
  /** Tunnel fetch. Omit to use the page transport on each attempt. Pass null to force host-unavailable. */
  readonly fetch?: TunnelFetch | null
  /** Clock for observation age. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Page-side deadline for one paired read. */
  readonly timeoutMs?: number
  /** Heartbeat age strictly above this is stale. Defaults to 120000 ms. */
  readonly staleAfterMs?: number
  /**
   * Whole-file reader. The caller can pass the existing `workspaceFiles` read.
   * When omitted, a provided `sessionId` uses `POST /api/workspaceFiles/read`.
   * Injected readers own upstream allocation; returned text is capped before parsing.
   */
  readonly readText?: (path: string, signal: AbortSignal) => Promise<EvidenceFile>
  /** Host GET transport, separate from WorkerTunnel.fetch. Null disables wake reads. Defaults to browser fetch. */
  readonly hostFetch?: WakeFetch | null
  /** Already-authorized wake metadata reader. When omitted, use the host GET transport. */
  readonly readWake?: (signal: AbortSignal) => Promise<unknown>
  /** Existing Session id. This readout does not create one. */
  readonly sessionId?: string
  /**
   * Owner public keys from outside this module. The caller may pass keys from
   * `GET /_host/owner-key`. This readout does not fetch them and does not
   * copy a key out of an attestation, a grant, or the receipt signers.
   * Supplying the list trusts that channel. It is not a passkey ceremony.
   */
  readonly trustedOwnerKeys?: readonly string[]
  /** Owner-grant envelopes the caller already holds. Not read from model status. */
  readonly ownerAttestations?: readonly unknown[]
}

/** Host metadata transport; no worker calls, writes, or session creation. */
export type WakeFetch = (path: string, init: { method: 'GET'; credentials: 'same-origin'; cache: 'no-store'; signal: AbortSignal }) => Promise<ToolResponse>

/** Fixed admission budgets for one refresh, including coherence rereads. */
export const EVIDENCE_READ_LIMITS = { fileBytes: 262_144, totalBytes: 4_194_304, records: 5000, concurrency: 4, files: 530 } as const
const HANDOFF_PATH = '/dsh/home/auma/HANDOFF.md'
const AURA_PATH = '/dsh/home/auma/seed/aura.v1.json'
const SCARS_PATH = '/dsh/home/auma/seed/scars.jsonl'
const RETENTION_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const DISCOVERY_PATH = '/dsh/home/auma/seed/discovery-corpus.v1.jsonl'
const DAG_NODES_PATH = '/dsh/home/auma/memory/dag/nodes/'
const DAG_FLAT_PATH = '/dsh/home/auma/memory/dag/'
const FILE_PATHS = [
  RECEIPTS_LOG_PATH, CHECKPOINTS_PATH, BALL_HEAD_PATH, DAG_HEAD_PATH, HANDOFF_PATH, AURA_PATH, SCARS_PATH, RETENTION_PATH, DISCOVERY_PATH,
] as const

interface ReadEvidence {
  receipts: EvidenceFile
  checkpoints: EvidenceFile
  head: EvidenceFile
  dag: EvidenceFile
  handoff: EvidenceFile
  storedAura: EvidenceFile
  scars: EvidenceFile
  retention: EvidenceFile
  discovery: EvidenceFile
  dagNodes: readonly unknown[] | null
  wake: unknown
  coherent: boolean
}

/** A single in-flight SuperAgent readout. */
export interface SuperagentRead {
  /** Latest phase. */
  current(): SuperagentPhase
  /** Replace the in-flight read with one new paired read. */
  refresh(): void
  /** Abort the in-flight read and ignore later results. */
  stop(): void
  /**
   * Receive phase changes, including the current phase.
   * @param listener - Called synchronously, then after each settled read.
   * @returns Removes the listener.
   */
  subscribe(listener: (phase: SuperagentPhase) => void): () => void
}

interface Deadline {
  signal: AbortSignal
  cancel(): void
}

/**
 * Start one readout. The first read begins immediately.
 * @param options - Transport, clock, and timeout.
 * @returns The reader. Call `stop` when the rooms leave the page.
 */
export function createSuperagentRead(options: SuperagentReadOptions = {}): SuperagentRead {
  const now = options.now ?? (() => Date.now())
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
  let phase: SuperagentPhase = { kind: 'loading', refreshing: false }
  let generation = 0
  let stopped = false
  let held: StatusSnapshot | null = null
  let heldReceipts: ReceiptRead = { kind: 'idle' }
  let abort: AbortController | null = null
  const listeners = new Set<(next: SuperagentPhase) => void>()

  const publish = (next: SuperagentPhase): void => {
    phase = next
    for (const listener of listeners) listener(phase)
  }

  const resolveFetch = (): TunnelFetch | null => {
    if (options.fetch === null) return null
    return options.fetch ?? pageTunnelFetch()
  }

  const run = (): void => {
    if (stopped) return
    const gen = ++generation
    abort?.abort()
    const caller = new AbortController()
    abort = caller
    const source = resolveFetch()
    if (source === null) {
      publish(held === null
        ? { kind: 'failure', failure: { kind: 'host-unavailable' }, receipts: heldReceipts, refreshing: false }
        : { kind: 'stale-snapshot', snapshot: held, receipts: heldReceipts, failure: { kind: 'host-unavailable' }, aged: observationIsAged(held.observedAt, now()), refreshing: false })
      return
    }
    const clock = now()
    publish(held === null
      ? { kind: 'loading', refreshing: false }
      : retain(held, heldReceipts, null, true, clock))
    const deadline = startDeadline(timeoutMs, caller.signal)
    void readPair(source, deadline.signal, clock, options).then((result) => {
      if (stopped || gen !== generation) return
      if (result.kind === 'aborted') return
      const reduced = reducePair(result.status, result.receipts, held, clock)
      if (reduced.kind === 'snapshot' || reduced.kind === 'stale-snapshot') held = reduced.snapshot
      if (reduced.kind !== 'loading' && reduced.kind !== 'stopped') heldReceipts = reduced.receipts
      publish(reduced)
    }, () => {
      if (stopped || gen !== generation) return
      publish(failHeld(held, { kind: 'transport', detail: null, truncated: false }, { kind: 'transport', detail: null, truncated: false }, now()))
    }).finally(() => {
      deadline.cancel()
    })
  }

  run()
  return {
    current: () => phase,
    refresh: () => { if (!stopped) run() },
    stop: () => {
      stopped = true
      generation += 1
      abort?.abort()
      publish({ kind: 'stopped' })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(phase)
      return () => { listeners.delete(listener) }
    },
  }
}

async function readPair(fetch: TunnelFetch, signal: AbortSignal, clock: number, options: SuperagentReadOptions): Promise<{ kind: 'ok'; status: StatusAttempt; receipts: ReceiptRead } | { kind: 'aborted' }> {
  try {
    const [status, receipts, evidence] = await Promise.all([
      readStatus(fetch, signal, clock),
      readReceipts(fetch, signal),
      readEvidence(fetch, signal, options),
    ])
    if (status.kind === 'aborted' || receipts.kind === 'aborted') return { kind: 'aborted' }
    if (status.kind === 'snapshot') {
      return {
        kind: 'ok',
        receipts,
        status: {
          kind: 'snapshot',
          snapshot: attachAura(await applyEvidence(status.snapshot, evidence, clock, options.staleAfterMs ?? STALE_HEARTBEAT_MS, {
            trustedKeys: options.trustedOwnerKeys ?? [],
            attestations: options.ownerAttestations ?? [],
          }), evidence, clock),
        },
      }
    }
    return { kind: 'ok', status, receipts }
  } catch (error) {
    if (isAbort(error) || signal.aborted) return { kind: 'aborted' }
    throw error
  }
}

async function readEvidence(
  fetch: TunnelFetch,
  signal: AbortSignal,
  options: SuperagentReadOptions,
): Promise<ReadEvidence> {
  const sessionId = options.sessionId
  const read = options.readText ?? (sessionId === undefined
    ? null
    : (path: string, fileSignal: AbortSignal) => readWorkspaceText(fetch, sessionId, path, fileSignal))
  const unavailable: EvidenceFile = { kind: 'unavailable' }
  let bytes = 0
  let files = 0
  const boundedRead = async (path: string): Promise<EvidenceFile> => {
    if (read === null || signal.aborted) return unavailable
    if (++files > EVIDENCE_READ_LIMITS.files || bytes >= EVIDENCE_READ_LIMITS.totalBytes) return { kind: 'bounded' }
    let file: EvidenceFile
    try { file = await abortable(() => read(path, signal), signal, unavailable) }
    catch (error) { void error; return unavailable }
    if (file.kind !== 'ok') return file
    if (file.text.length > EVIDENCE_READ_LIMITS.fileBytes) return { kind: 'bounded' }
    const size = new TextEncoder().encode(file.text).length
    bytes += size
    return size > EVIDENCE_READ_LIMITS.fileBytes || bytes > EVIDENCE_READ_LIMITS.totalBytes ? { kind: 'bounded' } : file
  }
  const wakePromise = readWake(options, signal)
  // The initial selected HEAD brackets all other evidence. Node filenames are content hashes.
  const initialHead = await boundedRead(BALL_HEAD_PATH)
  const initial = await mapBounded(FILE_PATHS, path => path === BALL_HEAD_PATH ? Promise.resolve(initialHead) : boundedRead(path))
  const get = (path: typeof FILE_PATHS[number]): EvidenceFile => initial[FILE_PATHS.indexOf(path)] ?? unavailable
  const dag = get(DAG_HEAD_PATH)
  const dagHead = parseJson(dag)
  const heads = auraDagHeads(dagHead)
  const nodes: unknown[] = []
  const seen = new Set<string>()
  let pending = heads ?? []
  let dagValid = heads !== null
  let nestedComplete = true
  let flatComplete = true
  while (dagValid && pending.length > 0 && !signal.aborted) {
    const batch = [...new Set(pending)].filter(id => !seen.has(id))
    pending = []
    if (seen.size + batch.length > AURA_DAG_LIMIT) { dagValid = false; break }
    const loaded = await mapBounded(batch, async (id) => {
      const nested = await boundedRead(`${DAG_NODES_PATH}${id}.json`)
      const flat = await boundedRead(`${DAG_FLAT_PATH}${id}.json`)
      const node = parseJson(nested.kind === 'ok' ? nested : flat)
      const nestedValid = nested.kind === 'ok' && auraDagParents(parseJson(nested), id) !== null
      const flatValid = flat.kind === 'ok' && auraDagParents(parseJson(flat), id) !== null
      return { id, node, parents: auraDagParents(node, id), nestedValid, flatValid,
        conflict: (nested.kind !== 'missing' && flat.kind !== 'missing') || (nested.kind !== 'missing' && !nestedValid) || (flat.kind !== 'missing' && !flatValid) }
    })
    for (const item of loaded) {
      seen.add(item.id)
      nestedComplete &&= item.nestedValid
      flatComplete &&= item.flatValid
      if (item.parents === null || item.conflict) { dagValid = false; continue }
      nodes.push(item.node)
      pending.push(...item.parents)
    }
  }
  if (!isRecord(dagHead) || dagHead.count !== nodes.length || signal.aborted || (!nestedComplete && !flatComplete)) dagValid = false
  const final = await mapBounded(FILE_PATHS, boundedRead)
  const coherent = initial.every((file, index) => sameFile(file, final[index] ?? unavailable))
  return {
    receipts: coherent ? get(RECEIPTS_LOG_PATH) : unavailable,
    checkpoints: coherent ? get(CHECKPOINTS_PATH) : unavailable,
    head: coherent ? initialHead : unavailable,
    dag: coherent ? dag : unavailable,
    handoff: get(HANDOFF_PATH), storedAura: get(AURA_PATH), scars: get(SCARS_PATH),
    retention: get(RETENTION_PATH), discovery: get(DISCOVERY_PATH),
    dagNodes: coherent && dagValid ? nodes : null, wake: await wakePromise, coherent,
  }
}

async function mapBounded<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < items.length; offset += EVIDENCE_READ_LIMITS.concurrency) {
    results.push(...await Promise.all(items.slice(offset, offset + EVIDENCE_READ_LIMITS.concurrency).map(read)))
  }
  return results
}

function sameFile(left: EvidenceFile, right: EvidenceFile): boolean {
  return left.kind === right.kind && (left.kind !== 'ok' || (right.kind === 'ok' && left.text === right.text))
}

async function readWake(options: SuperagentReadOptions, signal: AbortSignal): Promise<unknown> {
  try {
    const read = options.readWake
    if (read !== undefined) return await abortable(() => read(signal), signal, null)
    const fetch = options.hostFetch === undefined ? (typeof window === 'undefined' ? null : globalThis.fetch.bind(globalThis)) : options.hostFetch
    if (fetch === null) return null
    return await abortable(async () => {
      const response = await fetch('/_host/wake', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
      if (response.status !== 200) return null
      const text = await boundedResponseText(response, signal)
      if (text === null) return null
      return JSON.parse(text) as unknown
    }, signal, null)
  } catch (error) { void error; return null }
}

async function boundedResponseText(response: ToolResponse, signal: AbortSignal): Promise<string | null> {
  if (response.body === undefined || response.body === null) {
    const text = await abortable(() => response.text(), signal, null)
    if (text === null || text.length > EVIDENCE_READ_LIMITS.fileBytes) return null
    return new TextEncoder().encode(text).length > EVIDENCE_READ_LIMITS.fileBytes ? null : text
  }
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch((error: unknown) => { void error }) }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  let complete = false
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal, null)
      if (chunk === null) { cancel(); return null }
      if (chunk.done) { complete = true; return text + decoder.decode() }
      bytes += chunk.value.byteLength
      if (bytes > EVIDENCE_READ_LIMITS.fileBytes) { cancel(); return null }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { if (!complete) cancel(); reader.releaseLock() }
}

function abortable<T>(work: () => Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); resolve(fallback) }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => signal.aborted ? fallback : work()).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function readWorkspaceText(fetch: TunnelFetch, sessionId: string, path: string, signal: AbortSignal): Promise<EvidenceFile> {
  if (sessionId.length === 0) return { kind: 'unavailable' }
  try {
    const response = await fetch('/api/workspaceFiles/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: mintRpcId(),
        method: 'workspaceFiles/read',
        payload: { args: { workspaceFileScopeId: sessionId, path, range: { offset: 1, limit: 5000 } } },
      }),
      signal,
    })
    if (response.status !== 200) return { kind: 'unavailable' }
    const text = await boundedResponseText(response, signal)
    if (text === null) return { kind: 'bounded' }
    const body = JSON.parse(text) as unknown
    if (!isRecord(body) || body.type !== 'server-response' || !isRecord(body.result)) return { kind: 'unavailable' }
    const result = body.result
    if (result.ok !== true || !isRecord(result.value) || typeof result.value.text !== 'string') {
      const code = isRecord(result.error) ? result.error.code : null
      return { kind: code === 'workspace-file/not-found' ? 'missing' : 'unavailable' }
    }
    if (result.value.eof === false) return { kind: 'bounded' }
    return { kind: 'ok', text: result.value.text }
  } catch (error) {
    if (isAbort(error) || signal.aborted) throw error
    return { kind: 'unavailable' }
  }
}

function attachAura(
  snapshot: StatusSnapshot,
  evidence: ReadEvidence,
  now: number,
): StatusSnapshot {
  const receipts = parseJsonl(evidence.receipts)
  const head = parseJson(evidence.head)
  const predictions = predictionEvidence(receipts, parseJsonl(evidence.discovery))
  const running = snapshot.assignments.filter(assignment => assignment.state === 'running')
  const pulsesKnown = !observationIsAged(snapshot.observedAt, now) && running.every(assignment => assignment.heartbeat.availability === 'fresh' || assignment.heartbeat.availability === 'stale')
  const stale = running.filter(assignment => assignment.heartbeat.availability === 'stale')
  const evidenceGaps: string[] = []
  if (!evidence.coherent) evidenceGaps.push('evidence-changed')
  const manifestValid = manifestMatches(head)
  if (!manifestValid) evidenceGaps.push('manifest')
  if (!dagReceiptsMatch(evidence.dagNodes, receipts)) evidenceGaps.push('dag-receipts')
  const storedAura = parseJson(evidence.storedAura)
  if (!isRecord(storedAura)) evidenceGaps.push('stored-aura')
  if (predictions === null) evidenceGaps.push('discovery')
  return {
    ...snapshot,
    aura: projectAura({
      computedAt: now, dagHead: parseJson(evidence.dag), dagNodes: evidence.dagNodes,
      handoffText: evidence.handoff.kind === 'ok' ? evidence.handoff.text : null,
      observationScores: predictions?.scores,
      unanchoredPredictions: predictions?.unanchored,
      pendingWakes: pendingWakes(evidence.wake), wake: evidence.wake,
      staleHeartbeatRatio: pulsesKnown ? stale.length / Math.max(running.length, 1) : null,
      staleTickets: pulsesKnown ? new Set(stale.map(assignment => assignment.ticketId)).size : null,
      storedAura, evidenceGaps,
    }, receipts, head),
    pearl: {
      ...projectPearl(evidence.coherent ? parseJson(evidence.retention) : null,
        evidence.coherent ? parseJsonl(evidence.scars) : null, receipts, manifestValid ? head : null),
      checkpoint: snapshot.checkpoints ?? null,
    },
  }
}

function dagReceiptsMatch(nodes: readonly unknown[] | null, receipts: unknown): boolean {
  if (nodes === null || !Array.isArray(receipts)) return false
  const chain = verifyReceiptChain(receipts)
  if (chain.status !== 'verified') return false
  return nodes.every((node) => {
    if (!isRecord(node)) return false
    const append = chain.receipts.find(receipt => receipt.kind === 'memory.dag.append' && (receipt.data.nodeId === node.id || receipt.data.id === node.id))
    if (append === undefined) return false
    if ((append.data.content !== undefined && append.data.content !== node.content)
      || (append.data.summary !== undefined && append.data.summary !== node.summary)) return false
    if (node.receiptHash === null || node.receiptHash === undefined) return true
    return chain.receipts.some(receipt => receipt.leafHash === node.receiptHash && receipt.seq < append.seq)
  })
}

function manifestMatches(head: unknown): boolean {
  try {
    if (!isRecord(head) || !isRecord(head.entries) || !isRecord(head.modules)
      || Object.keys(head.entries).length > 256 || Object.keys(head.modules).length > 512) return false
    const modules = head.modules
    const validEntry = (entry: unknown): entry is Record<string, unknown> & { specifier: string } => isRecord(entry) && typeof entry.specifier === 'string'
      && entry.specifier.length > 0 && typeof entry.disabled === 'boolean' && isRecord(entry.config)
    for (const [id, entry] of Object.entries(head.entries)) {
      if (!validEntry(entry) || entry.id !== id || !nonemptyStrings(entry.previousSpecifiers)) return false
      const previous = entry.previousVersions === undefined ? [] : entry.previousVersions
      if (!Array.isArray(previous) || !previous.every(validEntry)) return false
      const specifiers = [entry.specifier, ...previous.map(value => value.specifier), ...entry.previousSpecifiers]
      if (specifiers.some(value => value.startsWith('ball:') && (!/^[0-9a-f]{64}$/.test(value.slice(5)) || !Object.hasOwn(modules, value.slice(5))))) return false
    }
    for (const [sha, module] of Object.entries(modules)) {
      if (!/^[0-9a-f]{64}$/.test(sha) || !isRecord(module) || module.sha256 !== sha || module.specifier !== `ball:${sha}`) return false
    }
    return [loaderManifestPreimage(head), canonManifestPreimage(head)]
      .some(preimage => preimage !== null && sha256Hex(new TextEncoder().encode(preimage)) === head.ballId)
  } catch (error) { void error; return false }
}

function nonemptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}

function pendingWakes(wake: unknown): number | null {
  if (!isRecord(wake) || wake.ok !== true || typeof wake.probePending !== 'boolean') return null
  const count = wake.consecutiveUnacknowledgedWakes
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || Object.is(count, -0)) return null
  if (typeof wake.wakeCount !== 'number' || !Number.isSafeInteger(wake.wakeCount) || wake.wakeCount < count) return null
  const pending = count + (wake.probePending ? 1 : 0)
  return Number.isSafeInteger(pending) ? pending : null
}

function predictionEvidence(receipts: unknown, discovery: unknown): { scores: number[]; unanchored: number } | null {
  if (!Array.isArray(receipts) || !Array.isArray(discovery)) return null
  const chain = verifyReceiptChain(receipts)
  if (chain.status !== 'verified') return null
  const corpus = projectDiscoveryCorpus(receipts)
  const byId = new Map(corpus.records.map(record => [record.trajectoryId, record]))
  const seen = new Set<string>()
  for (const item of discovery) {
    if (!isRecord(item) || typeof item.trajectoryId !== 'string' || seen.has(item.trajectoryId)) return null
    const record = byId.get(item.trajectoryId)
    if (record === undefined || item.registerReceiptHash !== record.registerReceiptHash
      || item.promotionReceiptHash !== record.promotionReceiptHash
      || item.observeReceiptHash !== record.observeReceiptHash || item.predicted !== record.predicted || item.observed !== record.observed
      || item.pearlId !== record.pearlId || item.epochBefore !== record.epochBefore || item.epochAfter !== record.epochAfter) return null
    seen.add(item.trajectoryId)
  }
  if (seen.size !== corpus.records.length) return null
  const anchored = new Set(corpus.records.flatMap(record => [record.registerReceiptHash, record.observeReceiptHash]))
  const predictions = chain.receipts.filter(receipt => receipt.kind === 'prediction.register' || receipt.kind === 'prediction.observe')
  if (predictions.some(receipt => receipt.kind === 'prediction.observe' && !anchored.has(receipt.leafHash))) return null
  const order = new Map(chain.receipts.map(receipt => [receipt.leafHash, receipt.seq]))
  const scores = [...corpus.records]
    .sort((left, right) => (order.get(left.observeReceiptHash) ?? 0) - (order.get(right.observeReceiptHash) ?? 0))
    .map(record => record.surpriseScore)
  return { scores, unanchored: predictions.filter(receipt => !anchored.has(receipt.leafHash)).length }
}

function parseJsonl(file: EvidenceFile): unknown {
  if (file.kind !== 'ok') return null
  try {
    if (file.text === '') return []
    if (!file.text.endsWith('\n')) return null
    const lines = file.text.slice(0, -1).split('\n')
    if (lines.length > EVIDENCE_READ_LIMITS.records || lines.some(line => line.trim() === '')) return null
    return lines.map(line => JSON.parse(line) as unknown)
  } catch (error) {
    void error
    return null
  }
}

function parseJson(file: EvidenceFile): unknown {
  if (file.kind !== 'ok') return null
  try {
    return JSON.parse(file.text)
  } catch (error) {
    void error
    return null
  }
}

function mintRpcId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type StatusAttempt =
  | { kind: 'snapshot'; snapshot: StatusSnapshot }
  | { kind: 'failure'; failure: StatusFailure }

async function readStatus(fetch: TunnelFetch, signal: AbortSignal, clock: number): Promise<StatusAttempt | { kind: 'aborted' }> {
  let sawMissing = false
  for (const name of SUPERAGENT_TOOL_NAMES) {
    const body = await callTool(fetch, name, STATUS_READ_ARGS, signal)
    if (body.kind === 'aborted') return body
    if (body.kind === 'missing') {
      sawMissing = true
      continue
    }
    if (body.kind === 'bounded') return { kind: 'failure', failure: { kind: 'bound' } }
    if (body.kind !== 'ok') return { kind: 'failure', failure: failureFromBody(body) }
    const parsed = parseStatus(body.value, name, clock)
    if (!parsed.ok) return { kind: 'failure', failure: parsed.failure }
    return { kind: 'snapshot', snapshot: parsed.snapshot }
  }
  return sawMissing
    ? { kind: 'failure', failure: { kind: 'backend-missing' } }
    : { kind: 'failure', failure: { kind: 'unreadable' } }
}

async function readReceipts(fetch: TunnelFetch, signal: AbortSignal): Promise<ReceiptRead | { kind: 'aborted' }> {
  const body = await callTool(fetch, RECEIPT_TOOL_NAME, RECEIPT_VERIFY_ARGS, signal)
  if (body.kind === 'aborted') return body
  if (body.kind === 'ok') return parseReceipt(body.value)
  if (body.kind === 'missing') return { kind: 'missing' }
  if (body.kind === 'control-unavailable') return { kind: 'control-unavailable' }
  if (body.kind === 'timeout') return { kind: 'timeout' }
  if (body.kind === 'bounded') return { kind: 'unreadable' }
  if (body.kind === 'transport') return { kind: 'transport', detail: body.detail, truncated: body.truncated }
  if (body.kind === 'refused') return { kind: 'refused', detail: body.detail, truncated: body.truncated }
  return { kind: 'unreadable' }
}

async function callTool(fetch: TunnelFetch, name: string, args: { readonly action: string }, signal: AbortSignal): Promise<ToolBody | { kind: 'aborted' }> {
  if (signal.aborted) return { kind: 'aborted' }
  let response: ToolResponse | null
  try {
    response = await abortable(() => fetch(CALL_TOOL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args }),
      signal,
    }), signal, null)
  } catch (error) {
    if (isAbort(error) || signal.aborted) return cancellation(signal)
    return { kind: 'transport', detail: null, truncated: false }
  }
  if (readAborted(signal) || response === null) return cancellation(signal)
  try {
    const text = await boundedResponseText(response, signal)
    if (text === null) return readAborted(signal) ? cancellation(signal) : { kind: 'bounded' }
    if (text.length > MAX_TOOL_BODY_CHARS) return { kind: 'bounded' }
    return classifyToolBody(response.status, text)
  } catch (error) {
    if (isAbort(error) || signal.aborted) return cancellation(signal)
    return { kind: 'unreadable' }
  }
}

function readAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function cancellation(signal: AbortSignal): { kind: 'timeout' } | { kind: 'aborted' } {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? { kind: 'timeout' }
    : { kind: 'aborted' }
}

function reducePair(status: StatusAttempt, receipts: ReceiptRead, held: StatusSnapshot | null, now: number): SuperagentPhase {
  if (status.kind === 'snapshot') {
    const aged = observationIsAged(status.snapshot.observedAt, now)
    if (aged) {
      return { kind: 'stale-snapshot', snapshot: status.snapshot, receipts, failure: null, aged: true, refreshing: false }
    }
    return {
      kind: 'snapshot',
      snapshot: status.snapshot,
      receipts,
      empty: snapshotIsEmpty(status.snapshot),
      refreshing: false,
    }
  }
  return failHeld(held, status.failure, receipts, now)
}

function failHeld(held: StatusSnapshot | null, failure: StatusFailure, receipts: ReceiptRead, now: number): SuperagentPhase {
  if (held === null) return { kind: 'failure', failure, receipts, refreshing: false }
  return {
    kind: 'stale-snapshot',
    snapshot: held,
    receipts,
    failure,
    aged: observationIsAged(held.observedAt, now),
    refreshing: false,
  }
}

function retain(
  snapshot: StatusSnapshot,
  receipts: ReceiptRead,
  failure: StatusFailure | null,
  refreshing: boolean,
  now: number,
): SuperagentPhase {
  const aged = observationIsAged(snapshot.observedAt, now)
  if (aged || failure) {
    return { kind: 'stale-snapshot', snapshot, receipts, failure, aged, refreshing }
  }
  return { kind: 'snapshot', snapshot, receipts, empty: snapshotIsEmpty(snapshot), refreshing }
}

function failureFromBody(body: Exclude<ToolBody, { kind: 'ok' | 'missing' | 'bounded' }>): StatusFailure {
  if (body.kind === 'control-unavailable') return { kind: 'control-unavailable' }
  if (body.kind === 'timeout') return { kind: 'timeout' }
  if (body.kind === 'transport') return { kind: 'transport', detail: body.detail, truncated: body.truncated }
  if (body.kind === 'refused') return { kind: 'refused', detail: body.detail, truncated: body.truncated }
  return { kind: 'unreadable' }
}

function startDeadline(timeoutMs: number, parent: AbortSignal): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The status read timed out.', 'TimeoutError'))
  }, timeoutMs)
  const onParent = (): void => { controller.abort(parent.reason) }
  if (parent.aborted) controller.abort(parent.reason)
  else parent.addEventListener('abort', onParent, { once: true })
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParent)
    },
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
