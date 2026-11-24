/**
 * checkpoint-verify-tool.ts — the look-only built-in `x6_checkpoint_verify` (card 1, thread kind).
 *
 * Shapes are the edge's own, not assumed (read from deploy/cloudflare/src/thread-log.mjs:265-290,
 * head-do.mjs:1275-1286, mirror-do.mjs:1145-1148):
 *   GET /_thread/index          { ok, threads: [{ id, path, bytes, lineEnd, partCount, keptCount, chain, tailSha, ... }] }
 *                               the row id is the THREAD id (sha256 of the path); the session id lives in the path.
 *   GET /_thread/manifest?id=   { ok, thread, page, pages, parts, kept }  — parts are SHA-256 NAMES (strings)
 *   GET /_thread/tail?id=       { ok, ... }  — the open-end bytes only; never needed to hash the head
 *   GET /_head/status           { ok, lease: { generation, ... } | null, ballId, epoch }
 *   GET /_mirror/status         { ok, lineageId, revision, ... }  — carries NO lease generation.
 *
 * A gather that reads the index twice and sees the row change is NOT torn by a lease; it is simply
 * unstable, and the tool says so instead of inventing two generations to make a verdict fit.
 */
import { verifyCheckpoint, type ThreadExpected, type ThreadPiece } from './checkpoint-verify.ts'

export interface RouteAnswer {
  readonly status: number
  readonly body: unknown
}

export interface CheckpointVerifyDeps {
  /** Same-origin, credentialed, no-store GET. Body is null when the answer is not JSON. */
  readonly get: (path: string) => Promise<RouteAnswer>
  readonly nowMs: () => number
}

/** A sealed piece is exactly this many bytes; the open end is whatever is left. */
const SEALED_PIECE_BYTES = 2_097_152

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

interface IndexRow {
  id: string
  path: string
  bytes: number
  lineEnd: number
  chain: string
  tailSha: string
}

function rowOf(body: unknown, idOrSession: string): IndexRow | null {
  const threads = record(body) && Array.isArray(body.threads) ? (body.threads as unknown[]) : []
  for (const candidate of threads) {
    if (!record(candidate)) continue
    const id = str(candidate.id)
    const path = str(candidate.path) ?? ''
    if (id === null) continue
    if (id !== idOrSession && !path.includes(idOrSession)) continue
    const bytes = num(candidate.bytes)
    const lineEnd = num(candidate.lineEnd)
    const chain = str(candidate.chain)
    const tailSha = str(candidate.tailSha)
    if (bytes === null || lineEnd === null || chain === null || tailSha === null) return null
    return { id, path, bytes, lineEnd, chain, tailSha }
  }
  return null
}

const sameRow = (a: IndexRow, b: IndexRow): boolean =>
  a.bytes === b.bytes && a.lineEnd === b.lineEnd && a.chain === b.chain && a.tailSha === b.tailSha

/** Every manifest part is a SEALED piece: exactly SEALED_PIECE_BYTES. The open end is never a part, so a
 * part list that would reach past the byte count contradicts the row and is refused instead of being
 * turned into an invented short last piece. */
function piecesOf(parts: readonly string[], bytes: number): ThreadPiece[] | null {
  if (parts.length * SEALED_PIECE_BYTES > bytes) return null
  const out: ThreadPiece[] = []
  for (const sha of parts) out.push({ bytes: SEALED_PIECE_BYTES, sha })
  return out
}

type Gathered =
  | { kind: 'expected'; expected: ThreadExpected; notes: string[] }
  | { kind: 'absent'; notes: string[]; forbidden: string[] }
  | { kind: 'unstable'; before: IndexRow; after: IndexRow }
  | { kind: 'unreadable'; notes: string[]; forbidden: string[] }

async function gather(deps: CheckpointVerifyDeps, idOrSession: string): Promise<Gathered> {
  const notes: string[] = []
  const forbidden: string[] = []
  // A failed read is neither an absence nor a stable fact. Each route reports `reached` separately so a
  // 403 or a 5xx can never be mistaken for "the edge has no such thread".
  const getJson = async (path: string): Promise<{ reached: boolean; body: unknown }> => {
    const answer = await deps.get(path)
    if (answer.status === 403) {
      forbidden.push(path)
      return { reached: false, body: null }
    }
    if (answer.status !== 200) {
      notes.push(`${path} answered ${String(answer.status)}`)
      return { reached: false, body: null }
    }
    return { reached: true, body: answer.body }
  }

  const first = await getJson('/_thread/index')
  // (e) A forbidden or failed index leaves no fact at all; only a REACHED index may report an absence.
  if (!first.reached) return { kind: 'unreadable', notes, forbidden }
  // (d) The index answer may be one page of several; that limit is recorded, never hidden.
  if (record(first.body) && str(first.body.next) !== null) {
    notes.push('/_thread/index answered with a next page, so this read saw only its first page')
  }
  const row = rowOf(first.body, idOrSession)
  if (row === null) return { kind: 'absent', notes, forbidden }

  // (a) The edge is zero-indexed: the first manifest page is page 0, never page 1.
  const manifestAnswer = await getJson(`/_thread/manifest?id=${encodeURIComponent(row.id)}&page=0`)
  if (!manifestAnswer.reached) return { kind: 'unreadable', notes, forbidden }
  const manifestRecord = record(manifestAnswer.body) ? manifestAnswer.body : null
  const partsSource = manifestRecord !== null && Array.isArray(manifestRecord.parts) ? (manifestRecord.parts as unknown[]) : []
  const parts = partsSource.map(str).filter((value): value is string => value !== null)
  const pieces = parts.length === 0 ? [] : piecesOf(parts, row.bytes)
  if (pieces === null) notes.push('the manifest parts do not fit inside the byte count')

  // (g) HEAD owns the writer lease. It is read on BOTH sides of the gather: one read cannot show a bump
  // between them, so the torn check would be decorative if the same value were used twice.
  const headBefore = await getJson('/_head/status')
  if (!headBefore.reached) return { kind: 'unreadable', notes, forbidden }
  const leaseBefore = record(headBefore.body) && record(headBefore.body.lease) ? headBefore.body.lease : null
  const generationBefore = leaseBefore === null ? null : num(leaseBefore.generation)

  // The instability check needs the index REACHABLE both times to mean anything.
  const second = await getJson('/_thread/index')
  if (!second.reached) return { kind: 'unreadable', notes, forbidden }
  const after = rowOf(second.body, idOrSession)
  // (f) A row that vanished between two successful reads is a change, not a stable fact.
  if (after === null) {
    notes.push('the second index read no longer listed this thread')
    return { kind: 'unreadable', notes, forbidden }
  }
  if (!sameRow(row, after)) return { kind: 'unstable', before: row, after }

  const headAfter = await getJson('/_head/status')
  if (!headAfter.reached) return { kind: 'unreadable', notes, forbidden }
  const leaseAfter = record(headAfter.body) && record(headAfter.body.lease) ? headAfter.body.lease : null
  const generationAfter = leaseAfter === null ? null : num(leaseAfter.generation)

  // (c) The edge's tailSha covers the OPEN end only. A sealed thread is the only case where a candidate's
  // closed tail can be compared to it, so an open thread records that limit instead of assuming equality.
  if (row.lineEnd !== row.bytes) {
    notes.push('the edge tailSha covers the open end, so a sealed candidate cannot be compared to it')
  }

  const expected: ThreadExpected = {
    id: row.id,
    bytes: row.bytes,
    lineEnd: row.lineEnd,
    chain: row.chain,
    tailSha: row.tailSha,
    parts: pieces ?? [],
    // The committed boundary is the whole byte count only when nothing sits past it.
    sealed: row.lineEnd === row.bytes,
    observedAtMs: notes.length === 0 ? deps.nowMs() : null,
    leaseGenerationBefore: generationBefore,
    leaseGenerationAfter: generationAfter,
    ...(forbidden.length > 0 ? { forbiddenRoutes: forbidden } : {}),
  }
  return { kind: 'expected', expected, notes }
}

export function checkpointVerifyToolSpec(deps: () => CheckpointVerifyDeps) {
  return {
    name: 'x6_checkpoint_verify',
    description:
      'Verify a thread checkpoint with no writes and no signature. Two claims are kept apart: bytes, proven here by hashing the bytes themselves, and position, which is edge-scoped and says only what this edge listed while it was read. A 403 forbids a verdict; it never becomes an absence.',
    // FLAT descriptors: the dialect every built-in in ball-loader.ts uses. `defineTool` throws on a
    // JSON-Schema object, and registerBuiltin's catch then drops the tool with one console line — which
    // is exactly how x6_checkpoint_verify failed to exist while this file was already on main.
    // No top-level type / properties / required / additionalProperties; `required: true` rides inside
    // the descriptor that needs it.
    parameters: {
      action: { type: 'string', description: '`verify` (default) judges a candidate; `capture` returns the raw edge answers verbatim and judges nothing.' },
      id: { type: 'string', required: true, description: 'The session id the edge names the conversation by — the path segment, not a substring of the path.' },
      page: { type: 'number', description: 'Manifest page to read, 0-based (the edge answers page 0 first). Leave it out for the first page.' },
      body: { type: 'string', required: true, description: 'The candidate bytes as text, copied exactly. There is no file parameter: megabytes do not fit an argument, so a large candidate is checked by hashing it elsewhere first.' },
      lineEnd: { type: 'number', description: 'Byte offset of the last complete line in the candidate.' },
      claimedBytes: { type: 'number', description: 'The byte count the candidate claims (default: the candidate length).' },
      tailSha: { type: 'string', description: 'The digest the candidate claims.' },
      chain: { type: 'string', description: 'The chain the candidate claims.' },
    },
    async execute(args: Record<string, unknown>) {
      const id = str(args.id)
      if (id === null) {
        return { ok: false, code: 'CHECKPOINT_INPUT_INVALID', next: 'id is required' }
      }
      const reads = deps()

      // `capture` judges nothing and copies nothing. It resolves the id to a thread id, then returns
      // SHAPES: the one index row for that id with her `title` and `preview` removed, the page's row
      // count, and the manifest's shape. Never journal bytes, never a tail body, never another row.
      if (str(args.action) === 'capture') {
        const page = num(args.page) ?? 0
        const routes: Array<Record<string, unknown>> = []
        const indexAnswer = await reads.get('/_thread/index')
        const threads = record(indexAnswer.body) && Array.isArray(indexAnswer.body.threads)
          ? (indexAnswer.body.threads as unknown[])
          : []
        routes.push({ path: '/_thread/index', status: indexAnswer.status, rowCount: threads.length })
        // (i) A substring match is a bug: `id` "abc" must not match a path whose parent is "abcd".
        // The session id also travels inside a folder name with `~XXXX` escapes, so decode those
        // before comparing — a segment must be equal, never merely contained.
        const decodesTo = (part: string): boolean => {
          if (part === id) return true
          return part.replace(/~([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) === id
        }
        const match = threads.find((candidate) => {
          if (!record(candidate)) return false
          if (str(candidate.id) === id) return true
          const path = str(candidate.path)
          if (path === null) return false
          return path.split('/').some(decodesTo)
        })
        const threadId = record(match) ? str(match.id) : null
        let row: Record<string, unknown> | null = null
        if (record(match)) {
          row = {}
          for (const key of ['id', 'bytes', 'lineEnd', 'partCount', 'keptCount', 'chain', 'tailSha']) {
            if (match[key] !== undefined) row[key] = match[key]
          }
        }
        let manifest: Record<string, unknown> | null = null
        if (threadId !== null) {
          const path = `/_thread/manifest?id=${encodeURIComponent(threadId)}&page=${String(page)}`
          const answer = await reads.get(path)
          routes.push({ path, status: answer.status })
          const body = record(answer.body) ? answer.body : null
          const parts = body !== null && Array.isArray(body.parts) ? body.parts : []
          manifest = {
            page: body !== null ? body.page ?? null : null,
            pages: body !== null ? body.pages ?? null : null,
            partCount: Array.isArray(parts) ? parts.length : null,
            firstPartPrefix: typeof parts[0] === 'string' ? parts[0].slice(0, 8) : null,
          }
        }
        return {
          ok: true,
          action: 'capture',
          judged: false,
          threadId,
          page,
          row,
          manifest,
          routes,
          withheld: ['title', 'preview', '/_thread/tail — an octet-stream answer arrives as null through a JSON dep, so it cannot be hashed here'],
          note: 'scrubbed shapes only; no journal bytes, no verdict, and no verification may be inferred from this alone',
        }
      }

      const body = str(args.body)
      const lineEnd = num(args.lineEnd)
      if (body === null || lineEnd === null) {
        return { ok: false, code: 'CHECKPOINT_INPUT_INVALID', next: 'for verify: id, body and lineEnd are required' }
      }
      const gathered = await gather(reads, id)
      if (gathered.kind === 'absent') {
        return { ok: false, code: 'CHECKPOINT_GATHER_ABSENT', notes: gathered.notes,
          ...(gathered.forbidden.length > 0 ? { forbiddenRoutes: gathered.forbidden } : {}),
          next: 'this edge listed no thread for that id; nothing here can be verified against' }
      }
      // A refused or failed route is not an absence: no verdict may be produced from a read that never happened.
      if (gathered.kind === 'unreadable') {
        return { ok: false, code: 'CHECKPOINT_GATHER_UNREADABLE', notes: gathered.notes,
          ...(gathered.forbidden.length > 0 ? { forbiddenRoutes: gathered.forbidden } : {}),
          next: 'a route this verdict needs was refused or failed; nothing was proven and nothing may be inferred from its absence' }
      }
      if (gathered.kind === 'unstable') {
        return { ok: false, code: 'CHECKPOINT_GATHER_UNSTABLE',
          before: { bytes: gathered.before.bytes, lineEnd: gathered.before.lineEnd, tailSha: gathered.before.tailSha },
          after: { bytes: gathered.after.bytes, lineEnd: gathered.after.lineEnd, tailSha: gathered.after.tailSha },
          next: 'the thread changed while it was read; read again, do not judge this gather' }
      }
      const answer = verifyCheckpoint({
        kind: 'thread',
        candidate: {
          id: gathered.expected.id,
          body,
          claimed: {
            bytes: num(args.claimedBytes) ?? new TextEncoder().encode(body).length,
            lineEnd,
            chain: str(args.chain) ?? '',
            tailSha: str(args.tailSha) ?? '',
          },
        },
        identity: { kind: 'edge-session', sessionId: id },
        expected: gathered.expected,
        nowMs: reads.nowMs(),
      })
      return { ...answer, ...(gathered.notes.length > 0 ? { gatherNotes: gathered.notes } : {}) }
    },
  }
}
