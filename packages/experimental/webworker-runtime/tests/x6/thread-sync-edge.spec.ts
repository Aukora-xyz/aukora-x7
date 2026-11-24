/**
 * The reader's pull against wave 3's REAL edge code, in process. Imported, not copied:
 * the real `handleThreadRequest` whose `mirror.call` runs the real `threadCommit` in MIRROR's storage, the real
 * `leaseAction` and `checkLease`, the real vault (`createVaultFetch` over `handleVaultRequest`), and the exported fakes
 * of the outsides only (rescue-fakes.mjs: MIRROR's storage, R2's ranged get; vault-fakes.mjs: the bucket, the budget,
 * a rescue built the kit's way). The glue below is the one rescue-thread-join.test.mjs `edge()` uses (worker.mjs
 * does that), plus ONE stand-in: the index answer carries `sync`, as lane the edge setting's hook will add it (not on an earlier commit).
 * The thread is put in her cloud the way Join puts it there: a checked rescue, then `POST /_thread/import`.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { bootThreadSync, READER_OLDER_FOOTER, threadReader } from '../../src/storage/thread-sync.ts'
import type { ThreadPersistenceView } from '../../src/storage/thread-store-types.ts'
import { journal } from './thread-sync-fixture.ts'

// The edge modules are JavaScript; each is imported whole and named here by the members this spec calls.
type Json = Record<string, unknown>
interface MirrorStorage { transaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown>; snapshot(): Map<string, unknown> }
interface VaultBucket { objects: Map<string, { bytes: Uint8Array }>; calls: Array<{ op: string }> }
interface Rescue { id: string; indexBytes: Uint8Array; pieces: Map<string, Uint8Array> }
interface LeaseAnswer { status: number; body: Json }
interface EdgeModules {
  createR2PartStore(bucket: unknown, world: string): unknown
  handleThreadRequest(options: Json): Promise<Response>
  threadCommit(tx: unknown, op: string, input: unknown, ctx: Json): Promise<unknown>
  threadIdForPath(path: string): Promise<string>
  threadLimits(env: Json): unknown
  checkLease(tx: unknown, ref: unknown, at: unknown, options: Json): Promise<unknown>
  leaseAction(storage: unknown, input: Json, options: Json): Promise<LeaseAnswer>
  chargeWorldBudgetIn(tx: unknown, call: Json): Promise<unknown>
  createMirrorStorage(): MirrorStorage
  rangedBucket(bucket: unknown): unknown
  buildRescue(input: Json): Promise<Rescue>
  createVaultBucket(): VaultBucket
  createVaultBudget(options: Json): unknown
  createVaultFetch(options: Json): (path: string, init: RequestInit) => Promise<Response>
}
const edgeModule = async (relative: string): Promise<Json> => {
  const loaded: unknown = await import(new URL(`../../../../../deploy/cloudflare/src/${relative}`, import.meta.url).href)
  return loaded as Json
}
const E = Object.assign({}, ...await Promise.all(['thread-log.mjs', 'world-lease.mjs', 'world-budget.mjs', '__tests__/rescue-fakes.mjs',
  '__tests__/vault-fakes.mjs'].map(edgeModule))) as EdgeModules

const ORIGIN = 'https://node.example.invalid'
const WORLD = 'node-main-v1'
const PIECE = 4096
const HIS = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const PATH = '/dsh/home/sessions/--dsh-home-auma--/session-five/session.v4.jsonl'
const T0 = new Date(2026, 10, 13, 9, 30, 0).getTime()
const PULLED_NO_HOLDER = new RegExp('^Reading her from her cloud, read at \\d\\d:\\d\\d\\. '
  + 'She answers in the browser that holds her home\\. Nothing typed here is saved\\.$')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

interface Logged { method: string; path: string }

/** Her edge in memory, wired as rescue-thread-join.test.mjs wires it; `mode` is the index's `sync` (the edge setting stand-in). */
function herEdge(mode: string) {
  const clock = { t: T0 }
  const bucket = E.createVaultBucket()
  const budget = E.createVaultBudget({ now: () => clock.t })
  const vaultFetch = E.createVaultFetch({ bucket, budget, world: WORLD, now: () => clock.t, limits: { piece: PIECE } })
  const mirror = E.createMirrorStorage()
  const protocol = { piece: PIECE, row: 128 }
  const parts = E.createR2PartStore(E.rangedBucket(bucket), WORLD)
  const rescues = {
    get(id: string) {
      const manifest = bucket.objects.get(`w/${WORLD}/rescue/${id}/manifest.json`)
      const pending = bucket.objects.get(`w/${WORLD}/rescue/${id}/pending.json`)
      if (!manifest || !pending) return null
      const facts = JSON.parse(new TextDecoder().decode(manifest.bytes)) as Json
      if (facts.verified !== true || sha(pending.bytes) !== facts.indexSha) return null
      return { index: JSON.parse(new TextDecoder().decode(pending.bytes)) as unknown, verifiedAt: facts.verifiedAt }
    },
  }
  const threadMirror = {
    async call(op: string, input: unknown) {
      const copy = JSON.parse(JSON.stringify(input)) as unknown
      const answer: unknown = await mirror.transaction((tx: unknown) => E.threadCommit(tx, op, copy, {
        checkLease: (t: unknown, ref: unknown, at: unknown) => E.checkLease(t, ref, at, { mode: 'observe' }),
        budget: { charge: (t: unknown, ask: Json) => E.chargeWorldBudgetIn(t, { ...ask, now: clock.t }) },
        limits: E.threadLimits({}), protocol, now: () => clock.t,
      }))
      return JSON.parse(JSON.stringify(answer)) as unknown
    },
  }
  const log: Logged[] = []
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
    const method = (init.method ?? 'GET').toUpperCase()
    log.push({ method, path: url.pathname + url.search })
    if (url.pathname.startsWith('/_vault/')) return await vaultFetch(url.pathname + url.search, init)
    if (url.pathname.startsWith('/_thread/')) {
      const headers = { ...(init.headers as Record<string, string> | undefined ?? {}), origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
      const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? null : init.body ?? null })
      // As thread-mount.mjs passes it, `tailInsideLine` is true only while THREAD_SYNC is exactly on.
      const response: Response = await E.handleThreadRequest({ request, url, mirror: threadMirror, parts, rescues, protocol, tailInsideLine: mode === 'on' })
      if (url.pathname !== '/_thread/index' || response.status !== 200) return response
      // The index answer carries the sync setting.
      return Response.json({ ...(await response.json() as Json), sync: mode }, { status: 200 })
    }
    if (url.pathname === '/_mirror/lease' && method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json
      const answer = await E.leaseAction(mirror, body, { now: clock.t, ownerApproved: false, homeFreeze: 'record' })
      return Response.json(answer.body, { status: answer.status })
    }
    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }
  return { clock, bucket, mirror, fetch, log }
}

/** Put a thread in her cloud the way Join does (rescue-thread-join.test.mjs `cloudThread`): a checked copy, then an import. */
async function joined(edge: ReturnType<typeof herEdge>, path: string, bytes: Uint8Array): Promise<void> {
  const rescue = await E.buildRescue({ piece: PIECE, rows: [{ key: path, type: 'file', bytes }], clientId: HIS })
  for (const [name, part] of rescue.pieces) {
    expect([200, 201]).toContain((await edge.fetch(`/_vault/blob/${name}`, { method: 'PUT', body: new Uint8Array(part) })).status)
  }
  const index = new TextDecoder().decode(rescue.indexBytes)
  expect([200, 201]).toContain((await edge.fetch(`/_vault/rescue/${rescue.id}`, { method: 'PUT', body: index })).status)
  for (let cursor = 0; ;) {
    const answer = await (await edge.fetch(`/_vault/rescue/${rescue.id}/verify?cursor=${String(cursor)}`, { method: 'POST' })).json() as Json
    if (answer.done === true) break
    cursor = answer.cursor as number
  }
  const acquired = await E.leaseAction(edge.mirror, { action: 'acquire', clientId: HIS, tabId: 'join', label: 'Chrome on the Mac' }, { now: edge.clock.t })
  const lease = (acquired.body as { lease: { leaseId: string; generation: number } }).lease
  const imported = await (await edge.fetch('/_thread/import', { method: 'POST', body: JSON.stringify({ path, rescue: rescue.id }),
    headers: { 'content-type': 'application/json', 'x-thread-lease': `${lease.leaseId}.${String(lease.generation)}` } })).json() as Json
  expect(imported.outcome, JSON.stringify(imported)).toBe('imported')
  const release = { action: 'release', clientId: HIS, tabId: 'join', label: 'Chrome on the Mac', leaseId: lease.leaseId }
  await E.leaseAction(edge.mirror, release, { now: edge.clock.t })
}

/** A browser that never saved and holds her cloud's home (the hydration facts idb-persist records for it). */
const reader = (): ThreadPersistenceView => ({ readOnly: false, hydration: { transport: 'cloud', storedRows: true, seq: 0,
  clientId: '9a7c1e55-2b3d-4f60-8a91-b2c3d4e5f607', storedRevision: 2190, queuedBatches: 0, reconciliation: false, heldPaths: 0,
  cloud: 'confirmed', cloudRevision: 2190 } })
const snapshot = (mirror: { snapshot(): Map<string, unknown> }): string => JSON.stringify([...mirror.snapshot()].sort())

afterEach(() => { threadReader.footer = null; vi.unstubAllGlobals() })

describe('a reader against wave 3\'s real thread log', () => {
  it('a five-part thread Join put in her cloud pulls byte-identical, with GETs only, and the edge is unchanged after', async () => {
    const edge = herEdge('pull')
    const bytes = journal(5 * PIECE + 1500, 'five')
    await joined(edge, PATH, bytes)
    const id = await E.threadIdForPath(PATH)
    const row = edge.mirror.snapshot().get(`thread:v1:index:${id}`) as { partCount: number; bytes: number; run: { client: string } }
    expect([row.partCount, row.bytes, row.run.client]).toEqual([5, bytes.byteLength, HIS])
    const before = snapshot(edge.mirror)
    const writes = edge.bucket.calls.filter((call: { op: string }) => call.op === 'put').length
    const from = edge.log.length

    // The production network (edgeNet) over this edge, as the worker's global fetch.
    vi.stubGlobal('fetch', edge.fetch)
    const vfs = new MemoryVfs()
    const view = reader()
    const boot = await bootThreadSync({ vfs, persistence: view, origin: ORIGIN, log: () => {} })
    const { mode, report } = await boot.settled
    expect([boot.role, view.readOnly, mode]).toEqual(['reader', true, 'pull'])
    expect(report).toMatchObject({ wanted: 1, seeded: [PATH], failed: [] })
    expect(sha(new Uint8Array(vfs.readFileSync(PATH) as Uint8Array))).toBe(sha(bytes))
    const calls = edge.log.slice(from)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
    expect(calls.filter(call => call.path.startsWith('/_vault/blob/'))).toHaveLength(5)
    expect(calls[0]?.path).toBe('/_thread/index?limit=200')
    expect(calls.filter(call => call.path.startsWith('/_thread/tail')).length).toBeGreaterThan(0)
    // The reader changed nothing at the edge: MIRROR's rows (lease, threads, budget) and the bucket's writes are as before.
    expect(snapshot(edge.mirror)).toBe(before)
    expect(edge.bucket.calls.filter((call: { op: string }) => call.op === 'put')).toHaveLength(writes)
    expect(threadReader.footer).toMatch(PULLED_NO_HOLDER)
  })

  it('a line in the open end longer than one tail answer is read whole: the real edge answers a `before` inside a line as a partial slice, so both threads pull byte-identical', async () => {
    // Scaled down: the client asks `tail` for 512 bytes at a time (production 262,144) and the open end holds a
    // 2,000-byte line. Before the thread sync, routeTail snapped a `before` inside that line back to the line end before it,
    // so the line's first bytes were never answered and this thread stayed in her cloud (it failed closed). Now the
    // edge answers the bytes ending at `before`, marked partial, and every byte is still checked against `tailSha`.
    // That answer exists only while THREAD_SYNC is exactly on, so this edge is switched on.
    const edge = herEdge('on')
    const enc = new TextEncoder()
    const longLine = enc.encode(`{"role":"tool","text":"${'x'.repeat(1974)}"}\n`)
    expect(longLine.byteLength).toBe(2000)
    const LONG = '/dsh/home/sessions/--dsh-home-auma--/session-long/session.v4.jsonl'
    const longBytes = new Uint8Array([...journal(PIECE, 'sealed'), ...journal(300, 'before'), ...longLine, ...journal(300, 'after')])
    const good = journal(2 * PIECE + 77, 'good')
    await joined(edge, LONG, longBytes)
    await joined(edge, PATH, good)
    vi.stubGlobal('fetch', edge.fetch)
    const vfs = new MemoryVfs()
    const lines: string[] = []
    const boot = await bootThreadSync({ vfs, persistence: reader(), origin: ORIGIN, log: (line) => { lines.push(line) },
      limits: { tailMax: 512 }, now: () => T0 })
    const { report } = await boot.settled
    expect([...(report?.seeded ?? [])].sort()).toEqual([LONG, PATH].sort())
    expect(report?.failed).toEqual([])
    expect(sha(new Uint8Array(vfs.readFileSync(LONG) as Uint8Array))).toBe(sha(longBytes))
    expect(sha(new Uint8Array(vfs.readFileSync(PATH) as Uint8Array))).toBe(sha(good))
    expect(lines.some(line => line.includes(LONG))).toBe(false)
    // At least one answer was a partial slice ending inside the long line.
    expect(edge.log.some((call: { path: string }) => call.path.startsWith('/_thread/tail'))).toBe(true)
    expect(threadReader.footer).toBe('Reading her from her cloud, read at 09:30. She answers in the browser that holds her home. '
      + 'Nothing typed here is saved.')
  })

  it('a torn open end that the edge answers partially is still refused when one byte is wrong (the tail hash holds)', async () => {
    const edge = herEdge('on') // The partial answer exists only while THREAD_SYNC is exactly on
    const enc = new TextEncoder()
    const longLine = enc.encode(`{"role":"tool","text":"${'y'.repeat(1974)}"}\n`)
    const LONG = '/dsh/home/sessions/--dsh-home-auma--/session-long2/session.v4.jsonl'
    const longBytes = new Uint8Array([...journal(PIECE, 'sealed'), ...longLine])
    await joined(edge, LONG, longBytes)
    const real = edge.fetch
    // Flip one byte inside the long line in every tail answer: the slices still meet end to end, the hash does not.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init)
      const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
      if (url.pathname !== '/_thread/tail' || response.status !== 200) return response
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > 10) bytes[5] = (bytes[5] ?? 0) ^ 0x01
      return new Response(bytes, { status: 200, headers: response.headers })
    })
    const vfs = new MemoryVfs()
    const boot = await bootThreadSync({ vfs, persistence: reader(), origin: ORIGIN, log: () => {},
      limits: { tailMax: 512 }, now: () => T0 })
    const { report } = await boot.settled
    expect(report?.seeded).toEqual([])
    expect(report?.failed).toEqual([`${LONG}: its open end does not match its SHA-256`])
    expect(vfs.existsSync(LONG)).toBe(false)
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
  })

  it('mode off from the real index: one GET, nothing pulled, still a reader', async () => {
    const edge = herEdge('off')
    await joined(edge, PATH, journal(2 * PIECE + 10, 'off'))
    const from = edge.log.length
    vi.stubGlobal('fetch', edge.fetch)
    const vfs = new MemoryVfs()
    const view = reader()
    const boot = await bootThreadSync({ vfs, persistence: view, origin: ORIGIN, log: () => {} })
    expect(await boot.settled).toEqual({ mode: 'off', report: null })
    expect(edge.log.slice(from)).toEqual([{ method: 'GET', path: '/_thread/index?limit=200' }])
    expect([view.readOnly, vfs.existsSync(PATH)]).toEqual([true, false])
  })
})
