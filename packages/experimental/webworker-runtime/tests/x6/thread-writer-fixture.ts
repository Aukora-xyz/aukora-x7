/**
 * Her edge in memory with the REAL thread log, world lease and budget
 * (deploy/cloudflare/src, imported whole, wired as thread-sync-edge.spec.ts and rescue-thread-join.test.mjs wire them),
 * plus `/_mirror/status` (the fence idb-persist reads at boot) and a `sync` field on the index. `joined` puts a thread
 * in her cloud the way Join does. Every call is logged.
 */
import { createHash } from 'node:crypto'
import type { ThreadNetReply } from '../../src/storage/thread-store-types.ts'
import type { ThreadWriterNet } from '../../src/storage/thread-writer.ts'

type Json = Record<string, unknown>
interface MirrorStorage { transaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown>; snapshot(): Map<string, unknown> }
interface VaultBucket { objects: Map<string, { bytes: Uint8Array }>; calls: Array<{ op: string }> }
interface Rescue { id: string; indexBytes: Uint8Array; pieces: Map<string, Uint8Array> }
interface LeaseAnswer { status: number; body: Json }
interface EdgeModules {
  createR2PartStore(bucket: unknown, world: string): unknown
  handleThreadRequest(options: Json): Promise<Response>
  threadCommit(tx: unknown, op: string, input: unknown, ctx: Json): Promise<unknown>
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

export const EDGE_ORIGIN = 'https://node.example.invalid'
export const EDGE_PIECE = 4096
export const HELD_CLIENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
export const EDGE_LINEAGE = '5e000005-0000-4000-8000-000000000005'
const WORLD = 'node-main-v1'
export const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export interface Logged { method: string; path: string }

/** Her edge in memory. `mode` is the index's `sync` and can be changed between steps. */
export function herEdge(options: { mode: string; fence?: { lineageId: string; revision: number } }) {
  const state = { mode: options.mode }
  const fence = options.fence ?? { lineageId: EDGE_LINEAGE, revision: 2190 }
  const clock = { t: new Date(2026, 10, 14, 9, 30, 0).getTime() }
  const bucket = E.createVaultBucket()
  const budget = E.createVaultBudget({ now: () => clock.t })
  const vaultFetch = E.createVaultFetch({ bucket, budget, world: WORLD, now: () => clock.t, limits: { piece: EDGE_PIECE } })
  const mirror = E.createMirrorStorage()
  const protocol = { piece: EDGE_PIECE, row: 128 }
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
    const url = new URL(input instanceof Request ? input.url : String(input), EDGE_ORIGIN)
    const method = (init.method ?? 'GET').toUpperCase()
    log.push({ method, path: url.pathname + url.search })
    if (url.pathname === '/_mirror/status' && method === 'GET') {
      return Response.json({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: fence.lineageId, revision: fence.revision, runtime: 'cloudflare' })
    }
    if (url.pathname.startsWith('/_vault/')) return await vaultFetch(url.pathname + url.search, init)
    if (url.pathname.startsWith('/_thread/')) {
      const headers = { ...(init.headers as Record<string, string> | undefined ?? {}), origin: EDGE_ORIGIN, 'sec-fetch-site': 'same-origin' }
      const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? null : (init.body as BodyInit | null | undefined) ?? null })
      const response: Response = await E.handleThreadRequest({ request, url, mirror: threadMirror, parts, rescues, protocol })
      if (url.pathname !== '/_thread/index' || response.status !== 200) return response
      return Response.json({ ...(await response.json() as Json), sync: state.mode }, { status: 200 })
    }
    if (url.pathname === '/_mirror/lease' && method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json
      const answer = await E.leaseAction(mirror, body, { now: clock.t, ownerApproved: false, homeFreeze: 'record' })
      return Response.json(answer.body, { status: answer.status })
    }
    return Response.json({ ok: false, code: 'MIRROR_OWNER_PASS_REQUIRED' }, { status: 401 })
  }
  /** What her cloud holds of one thread now, read back whole (manifest parts + open end), for the tests. */
  const cloudBytes = async (id: string): Promise<Uint8Array | null> => {
    const manifest = await fetch(`/_thread/manifest?id=${id}&page=0`)
    if (manifest.status !== 200) return null
    const body = await manifest.json() as { thread: { bytes: number; sealedBytes: number; lineEnd: number }; parts: string[] }
    const out = new Uint8Array(body.thread.bytes)
    for (const [k, name] of body.parts.entries()) {
      const blob = new Uint8Array(await (await fetch(`/_vault/blob/${name}`)).arrayBuffer())
      out.set(blob, k * EDGE_PIECE)
    }
    // The open end through the thread log's own range read (the tail route answers whole lines up to lineEnd).
    for (let before = body.thread.lineEnd; before > body.thread.sealedBytes;) {
      const tail = await fetch(`/_thread/tail?id=${id}&before=${String(before)}&max=262144`)
      const from = Number(tail.headers.get('x-thread-from'))
      const bytes = new Uint8Array(await tail.arrayBuffer())
      const start = Math.max(from, body.thread.sealedBytes)
      out.set(bytes.subarray(start - from), start)
      before = from
    }
    return out.subarray(0, body.thread.lineEnd)
  }
  return { state, clock, bucket, mirror, fetch, log, cloudBytes }
}
export type HerEdge = ReturnType<typeof herEdge>

/** Put a thread in her cloud the way Join does: a checked copy in her vault, then one import under a lease. */
export async function joined(edge: HerEdge, path: string, bytes: Uint8Array, clientId = HELD_CLIENT): Promise<void> {
  const rescue = await E.buildRescue({ piece: EDGE_PIECE, rows: [{ key: path, type: 'file', bytes }], clientId })
  for (const [name, part] of rescue.pieces) await edge.fetch(`/_vault/blob/${name}`, { method: 'PUT', body: new Uint8Array(part) })
  await edge.fetch(`/_vault/rescue/${rescue.id}`, { method: 'PUT', body: new TextDecoder().decode(rescue.indexBytes) })
  for (let cursor = 0; ;) {
    const answer = await (await edge.fetch(`/_vault/rescue/${rescue.id}/verify?cursor=${String(cursor)}`, { method: 'POST' })).json() as Json
    if (answer.done === true) break
    cursor = answer.cursor as number
  }
  const acquired = await E.leaseAction(edge.mirror, { action: 'acquire', clientId, tabId: 'join', label: 'Rescue page' }, { now: edge.clock.t })
  const lease = (acquired.body as { lease: { leaseId: string; generation: number } }).lease
  const imported = await (await edge.fetch('/_thread/import', { method: 'POST', body: JSON.stringify({ path, rescue: rescue.id }),
    headers: { 'content-type': 'application/json', 'x-thread-lease': `${lease.leaseId}.${String(lease.generation)}` } })).json() as Json
  if (imported.outcome !== 'imported') throw new Error(`joined: ${JSON.stringify(imported)}`)
  await E.leaseAction(edge.mirror, { action: 'release', clientId, tabId: 'join', label: 'Rescue page', leaseId: lease.leaseId }, { now: edge.clock.t })
}

/** The writer's net over this edge, with an optional hook that can drop an answer after the edge applied it. */
export function edgeWriterNet(edge: HerEdge, hook?: { dropAnswerOf?: (path: string) => boolean }): ThreadWriterNet & { posts: string[] } {
  const posts: string[] = []
  const read = async (response: Response): Promise<ThreadNetReply> =>
    ({ status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) })
  return {
    posts,
    get: async path => await read(await edge.fetch(`${EDGE_ORIGIN}${path}`, { method: 'GET' })),
    async post(path, body, headers) {
      posts.push(path)
      const response = await edge.fetch(`${EDGE_ORIGIN}${path}`, { method: 'POST', headers: { ...headers }, body: body as BodyInit })
      const reply = await read(response)
      if (hook?.dropAnswerOf?.(path) === true) return { status: 0, headers: new Headers(), bytes: new Uint8Array(0) }
      return reply
    },
  }
}

/** JSONL lines of `size` bytes in all, each a whole line, content from `tag`. */
export function lines(size: number, tag: string): Uint8Array {
  const out = new Uint8Array(size)
  const encoder = new TextEncoder()
  let at = 0
  let n = 0
  while (at < size) {
    const left = size - at
    const length = left < 160 ? left : 80
    const head = encoder.encode(`{"t":"${tag}","n":${String(n)},"p":"`)
    const line = new Uint8Array(length)
    line.fill(0x78)
    line.set(head.subarray(0, Math.max(0, length - 3)))
    if (length >= 3) { line[length - 3] = 0x22; line[length - 2] = 0x7d }
    line[length - 1] = 0x0a
    out.set(line, at)
    at += length
    n += 1
  }
  return out
}
