/**
 * An ordinary organ repair that Pearl admitted publishes at the edge.
 *
 * Her REAL runtime (seed-pearl challenge -> qualificationId -> treePatch) wired to a REAL X61HeadDurableObject with
 * production wiring (no options; PUBLIC_HOST + OWNER_PUBLIC_KEY_HEX set), the x-x6-verified-access header as the Worker
 * sets it for a passkey session, and the runtime's own writer lease. The edge admits a no-fingerprint ordinary organ
 * update only under the canonical id (server/ball-transition.mjs NON_CANONICAL_MANIFEST_ID), so treePatch must give
 * every candidate `computeCanonicalBallId`. Before the fix it gave an ordinary organ the old-style id and the edge
 * answered 403 PEARL_QUALIFICATION_UNVERIFIABLE.
 * Negative controls: every refusal the fix must not open, each from a runtime-built candidate against the same head.
 * The parent is FROZEN (fixtures/frozen-head: her epoch-173 manifest and the organ sources read here), never
 * the live mirror, which is re-synced to main on every published epoch; epochs are relative (parent N, published N + 1).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { FakeSocket, headManifestIdCanon, mountE4, putBall, type Call } from './e4-fixture.ts'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'
import { retentionSuiteDigest } from '../../src/x6/scion-growth.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { STAGED_HEAD_PROMOTION_PATH, type BallManifest } from '../../src/x6/ball-loader.ts'
import * as shadowModule from '../../src/x6/nucleus-shadow.ts'
import { TOUCH_ID_TIER_REFLEX_DIGEST, TOUCH_ID_TIER_REFLEX_PATH } from '../../src/x6/nucleus-shadow.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { disposeCellHosts, realCellHost, REFLEX_BYTES, removedShadow, standInHost, VARIANTS, WRONG_REFLEX,
  type Variant } from './nucleus-fixture.ts'

/** The edge's own HEAD (deploy/cloudflare/src/head-do.mjs) and the cloud mirror's head check (deploy/ci/mirror-copy.mjs). */
interface HeadStore {
  bootstrapPrepare(payload: unknown): Promise<{ ok: boolean }>
  bootstrapCommit(seedId: string, mirror: unknown): Promise<{ ok: boolean }>
  read(): Promise<{ head: BallManifest }>
}
interface HeadObject { fetch(request: Request): Promise<Response>; store: HeadStore }
const headModule = (await import(new URL('../../../../../deploy/cloudflare/src/head-do.mjs', import.meta.url).href)) as {
  X61HeadDurableObject: new (state: unknown, env: Record<string, string>) => HeadObject
  BOOTSTRAP_VERSION: string
  canonicalBootstrap: (input: unknown) => string
  digest: (input: string) => Promise<string>
  manifestIdCanon: (ball: unknown) => Promise<string>
}
const mirrorCopy = (await import(new URL('../../../../../deploy/ci/mirror-copy.mjs', import.meta.url).href)) as {
  headProblem: (ball: unknown) => Promise<string | null>
}
const { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } = headModule

const root = new URL('../../../../..', import.meta.url)
const W = root.pathname.replace(/\/$/, '')
const FIXTURE = W + '/packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head'
const HEAD = JSON.parse(readFileSync(FIXTURE + '/HEAD.json', 'utf8')) as BallManifest
const N = HEAD.epoch
const headSource = (id: string): string => {
  const sha = HEAD.entries[id]!.specifier.slice(5)
  const code = readFileSync(`${FIXTURE}/balls/${sha}.js`, 'utf8')
  if (sha256HexSync(code) !== sha) throw new Error(`frozen organ ${id} does not match its sha`)
  return code
}
if (await manifestIdCanon(HEAD) !== HEAD.ballId || !HEAD.ballId.startsWith('060c73c2')) throw new Error('the frozen parent head is not its own canonical manifest')
const APPROVED_TEXT = readFileSync(W + '/packages/experimental/webworker-runtime/tests/x6/fixtures/retention-suite-approved.json', 'utf8')
const APPROVED = JSON.parse(APPROVED_TEXT) as { organs: string[]; cases: Array<{ args: { organ: string } }> }
const SUITE_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const PEARL = "module.exports = { name: 'seed-pearl', run(args, ctx) { return ctx.scion.trialRetentionCandidate(args) } }"
const ALL = [...new Set([...APPROVED.organs, ...APPROVED.cases.map(row => row.args.organ)])]
const fix = (src: string, re: RegExp, to: string): string => { const out = src.replace(re, to); if (out === src) throw new Error('edit did not apply'); return out }
const HONEST = {
  'auma-eyes': fix(headSource('auma-eyes'), /(\n\s*)(const res = await fetch\()/, "$1if (origin === 'http://127.0.0.1:4610') throw new Error('EYES_ORIGIN_UNAVAILABLE');$1$2"),
  'auma-cortex': fix(headSource('auma-cortex'), /name:\s*'auma_cortex'/, "name: 'auma-cortex'"),
  'seed-continuity': fix(headSource('seed-continuity'), /name:\s*'seed_continuity'/, "name: 'seed-continuity'"),
}
const PUBLIC_HOST = 'lane-e4-fixture.invalid'
const env = { PUBLIC_HOST, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }

function storageFixture() {
  let data = new Map<string, unknown>(), tail: Promise<unknown> = Promise.resolve()
  const view = (map: Map<string, unknown>) => ({
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (key: string, value: unknown) => { map.set(key, structuredClone(value)) },
    delete: async (key: string) => map.delete(key),
    list: async ({ prefix = '', limit = Infinity }: { prefix?: string; limit?: number } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage: Record<string, unknown> = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm']
    .map(method => [method, (...args: unknown[]) => (view(data) as Record<string, (...a: unknown[]) => unknown>)[method]!(...args)]))
  storage.transaction = (operation: (tx: unknown) => Promise<unknown>) => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const out = await operation(view(copy))
      data = copy
      return out
    })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

/** Her head (the organs Pearl's approved suite reads, from the frozen parent), at the parent epoch N, canonical id. */
function parentHead() {
  const sources: Record<string, string> = { 'seed-pearl': PEARL }
  for (const id of ALL) sources[id] = headSource(id)
  sources['auma-eyes'] = HONEST['auma-eyes']; sources['seed-continuity'] = HONEST['seed-continuity']
  const entries: Record<string, BallManifest['entries'][string]> = {}, modules: Record<string, BallManifest['modules'][string]> = {}, codeBySha: Record<string, string> = {}
  for (const [id, code] of Object.entries(sources)) {
    const sha = sha256HexSync(code)
    entries[id] = { id, specifier: 'ball:' + sha, config: { ...HEAD.entries[id]?.config }, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
    modules[sha] = { sha256: sha, specifier: 'ball:' + sha, name: id, description: 'verify-1', size: code.length, createdAt: 1000 }
    codeBySha[sha] = code
  }
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: N, createdAt: 1000, authorPeerId: 'fixture', entries, modules }
  return { ball: { ...body, ballId: headManifestIdCanon(body) } as BallManifest, codeBySha }
}

type Session = 'valid' | 'none' | 'expired'
type Posted = { ball: BallManifest; status: number; answer: Record<string, unknown> }

/**
 * A REAL head with production wiring, seeded at the parent epoch N. `session` is the x-x6-verified-access the Worker would set on
 * the publish; `tamper` changes the runtime-built candidate after it is built and re-identifies it canonically, so a
 * refusal is the edge's own and never an id mismatch.
 */
async function realHead(options: { session?: Session; tamper?: (ball: BallManifest) => BallManifest } = {}) {
  const head = parentHead()
  const edge = new X61HeadDurableObject({ storage: storageFixture(), getWebSockets: () => [] }, env)
  const payload = { version: BOOTSTRAP_VERSION, ball: head.ball, codeBySha: head.codeBySha, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  expect((await edge.store.bootstrapPrepare({ ...payload, seedId })).ok).toBe(true)
  expect((await edge.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: head.ball.ballId, epoch: N, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok).toBe(true)
  const posted: Posted[] = []
  const headers = (session: Session): Record<string, string> => {
    const base: Record<string, string> = { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: 'https://' + PUBLIC_HOST, 'sec-fetch-site': 'same-origin' }
    if (session === 'none') return base
    const expires = Math.floor(Date.now() / 1000) + (session === 'valid' ? 3600 : -60)
    return { ...base, 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires }) }
  }
  /** What the Worker forwards to HEAD: lease and publish POSTs, and the cold boot's / reload check's GET. */
  const respond = async (call: Call): Promise<Response | null> => {
    if (call.method === 'GET' && call.path === '/_head/ball') {
      const response: Response = await edge.fetch(new Request(`https://${PUBLIC_HOST}/_head/ball`, { method: 'GET', headers: headers('valid') }))
      return Response.json(await response.json(), { status: response.status })
    }
    if (call.method !== 'POST' || (call.path !== '/_head/lease' && call.path !== '/_head/ball')) return null
    const json = structuredClone(call.body) as { ball?: BallManifest }
    if (call.path === '/_head/ball' && options.tamper && json.ball) {
      const changed = options.tamper(json.ball)
      json.ball = { ...changed, ballId: headManifestIdCanon(changed as unknown as Record<string, unknown>) }
    }
    const response: Response = await edge.fetch(new Request(`https://${PUBLIC_HOST}${call.path}`, { method: 'POST', body: JSON.stringify(json),
      headers: { ...headers(call.path === '/_head/ball' ? options.session ?? 'valid' : 'valid'), 'content-type': 'application/json' } }))
    const answer = await response.json() as Record<string, unknown>
    if (call.path === '/_head/ball') posted.push({ ball: json.ball!, status: response.status, answer })
    return Response.json(answer, { status: response.status })
  }
  const selected = async (): Promise<{ ballId: string; epoch: number }> => {
    const read = await edge.store.read()
    return { ballId: read.head.ballId, epoch: read.head.epoch }
  }
  return { head, edge, posted, respond, selected }
}

/** Her tab: the real host (Cordis Context, DSH ToolsService), the approved Pearl suite pinned, the real head behind it. */
async function herTab(world: Awaited<ReturnType<typeof realHead>>, extra: (call: Call) => Response | null = () => null) {
  const context = new Context()
  onTestFinished(async () => {
    await context.fiber.dispose()
    FakeSocket.instances.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const baseline = JSON.parse(APPROVED_TEXT) as Record<string, unknown>
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma/seed/pearl', { recursive: true })
  vfs.writeFileSync(SUITE_PATH, APPROVED_TEXT)
  const f = await mountE4({ head: world.head, vfs, nodeBuiltins: true, host: { context, dshTools },
    buildIdentity: { retentionBaselineSuite: baseline, retentionBaselineDigest: retentionSuiteDigest(baseline) },
    respond: call => extra(call) ?? (call.path === '/_host/eyes' ? Response.json({ ok: true, fixture: 'eyes-callable' }) : world.respond(call)) })
  const services = (globalThis as { __X6_SERVICES__?: Record<string, unknown> }).__X6_SERVICES__!
  const organs = services.organs as { call(n: string, a: Record<string, unknown>): Promise<Record<string, unknown>> }
  return { f, organs }
}

/** Another tab (or a cold boot): a fresh VFS whose only source of her head is the real head's GET /_head/ball. */
async function otherTab(world: Awaited<ReturnType<typeof realHead>>) {
  return mountE4({ head: world.head, vfs: new MemoryVfs(), respond: call => world.respond(call) })
}

/** The Pearl-admitted ordinary repair Auma made: challenge, then treePatch with the admission. */
async function admittedRepair(tab: Awaited<ReturnType<typeof herTab>>, patch: { config?: Record<string, unknown> } = {}) {
  const challenge = await tab.organs.call('seed-pearl', { action: 'challenge', organId: 'auma-cortex', candidateSource: HONEST['auma-cortex'] })
  expect(challenge).toMatchObject({ qualifiedForPromotion: true })
  const sha = putBall(tab.f.vfs, HONEST['auma-cortex'])
  return tab.f.runtime.treePatch({ id: 'auma-cortex', specifier: 'ball:' + sha, qualificationId: String(challenge.qualificationId), ...patch })
}

describe('real runtime -> real production head', () => {
  it('a Pearl-admitted ordinary auma-cortex repair publishes: remoteSaved, the head is at epoch N + 1, tier T1, canonical id', async () => {
    const world = await realHead()
    const tab = await herTab(world)
    const patch = await admittedRepair(tab)
    const cand = patch.ball
    expect(cand.epoch).toBe(N + 1)
    expect(cand.parentBallId).toBe(world.head.ball.ballId)
    expect(await manifestIdCanon(cand)).toBe(cand.ballId)
    // Her tab runs the candidate (this harness has no IndexedDB, so `localSaved` is not the claim here).
    expect((JSON.parse(tab.f.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8') as string) as BallManifest).ballId).toBe(cand.ballId)
    expect(patch.mutation.errors.remote ?? null).toBeNull()
    expect(patch.mutation.remoteSaved).toBe(true)
    expect(world.posted).toHaveLength(1)
    expect(world.posted[0]).toMatchObject({ status: 200, answer: { ok: true, ballId: cand.ballId, epoch: N + 1, tier: 'T1' } })
    expect(await world.selected()).toEqual({ ballId: cand.ballId, epoch: N + 1 })

    // Every other reader of a tree_patch candidate's id takes the canonical ordinary candidate unchanged.
    expect(patch.mutation.errors.receipt).toBeUndefined() // the receipt names the canonical id
    expect(tab.f.vfs.readFileSync('/dsh/home/auma/seed/receipts.v3.jsonl', 'utf8') as string).toContain(cand.ballId)
    const services = (globalThis as { __X6_SERVICES__?: { snapshots: { create(label: string): { ball: BallManifest } } } }).__X6_SERVICES__!
    expect(services.snapshots.create('repair-after-publish').ball.ballId).toBe(cand.ballId) // manifestIdMatches
    expect(tab.f.vfs.existsSync(`/dsh/home/balls/history/${cand.ballId}.json`)).toBe(true) // history file, named by the id
    expect(await mirrorCopy.headProblem(cand)).toBeNull() // the cloud mirror's HEAD.json writer (cloud-brokers.mjs head sync)
  }, 120_000)

  it('after the publish a cold boot selects epoch N + 1, and a second tab still on epoch N accepts the published head as one reload away', async () => {
    const world = await realHead()
    const second = await otherTab(world)
    expect(await second.status()).toMatchObject({ epoch: N, ballId: world.head.ball.ballId, headFetchError: null })
    const tab = await herTab(world)
    const patch = await admittedRepair(tab)
    expect(patch.mutation.remoteSaved).toBe(true)
    const published = patch.ball

    const cold = await otherTab(world)
    expect(await cold.status()).toMatchObject({ epoch: N + 1, ballId: published.ballId, headFetchError: null, authorityError: null })

    const check = await second.tool('head_adopt').execute({}) as Record<string, unknown>
    expect(check).toMatchObject({ ok: true, adopted: false, alreadyCurrent: false,
      running: { ballId: world.head.ball.ballId, epoch: N }, published: { ballId: published.ballId, epoch: N + 1 },
      headLag: { newer: true, reloadBrings: true, published: { ballId: published.ballId, epoch: N + 1 } } })
  }, 120_000)
})

describe('negative controls: runtime-built candidates the same production head must still refuse', () => {
  it('a protected organ (seed-pearl) patch stages for the owner and the head does not move', async () => {
    const world = await realHead()
    const tab = await herTab(world)
    const sha = putBall(tab.f.vfs, PEARL + '\n// protected-organ control\n')
    await expect(tab.f.runtime.treePatch({ id: 'seed-pearl', specifier: 'ball:' + sha })).rejects.toThrow(/CLASS3_WEBAUTHN_REQUIRED/)
    const staged = JSON.parse(tab.f.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string) as { body: { ball: BallManifest } }
    expect(staged.body.ball.entries['seed-pearl']!.specifier).toBe('ball:' + sha)
    expect(staged.body.ball.parentBallId).toBe(world.head.ball.ballId)
    expect(world.posted).toEqual([])
    expect(await world.selected()).toEqual({ ballId: world.head.ball.ballId, epoch: N })
  }, 120_000)

  it('a config change with the admission is refused by the runtime, and one smuggled in after the build is refused by the head', async () => {
    const world = await realHead()
    const tab = await herTab(world)
    await expect(admittedRepair(tab, { config: { repair: 1 } })).rejects.toThrow(/PEARL_QUALIFICATION_SCOPE_REFUSED/)
    expect(world.posted).toEqual([])
    expect(await world.selected()).toEqual({ ballId: world.head.ball.ballId, epoch: N })

    const smuggled = await realHead({ tamper: ball => ({ ...ball,
      entries: { ...ball.entries, 'auma-cortex': { ...ball.entries['auma-cortex']!, config: { repair: 1 } } } }) })
    const second = await herTab(smuggled)
    const patch = await admittedRepair(second)
    expect(patch.mutation.remoteSaved).toBe(false)
    expect(smuggled.posted).toHaveLength(1)
    expect(smuggled.posted[0]).toMatchObject({ status: 403, answer: { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE' } })
    expect(await smuggled.selected()).toEqual({ ballId: smuggled.head.ball.ballId, epoch: N })
  }, 120_000)

  it('two entries changed is refused and the head does not move', async () => {
    const world = await realHead({ tamper: ball => ({ ...ball, entries: { ...ball.entries,
      'seed-continuity': { ...ball.entries['seed-continuity']!, updatedAt: ball.entries['seed-continuity']!.updatedAt + 1 } } }) })
    const tab = await herTab(world)
    const patch = await admittedRepair(tab)
    expect(patch.mutation.remoteSaved).toBe(false)
    expect(world.posted).toHaveLength(1)
    expect(world.posted[0]).toMatchObject({ status: 403, answer: { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE' } })
    expect(await world.selected()).toEqual({ ballId: world.head.ball.ballId, epoch: N })
  }, 120_000)

  it('no session header: refused and the head does not move', async () => {
    const world = await realHead({ session: 'none' })
    const tab = await herTab(world)
    const patch = await admittedRepair(tab)
    expect(await manifestIdCanon(patch.ball)).toBe(patch.ball.ballId)
    expect(patch.mutation.remoteSaved).toBe(false)
    expect(patch.mutation.errors.remote).toContain('HTTP 403')
    expect(world.posted).toHaveLength(1)
    expect(world.posted[0]).toMatchObject({ status: 403, answer: { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE' } })
    expect(await world.selected()).toEqual({ ballId: world.head.ball.ballId, epoch: N })
  }, 120_000)

  it('an expired session: refused and the head does not move', async () => {
    const world = await realHead({ session: 'expired' })
    const tab = await herTab(world)
    const patch = await admittedRepair(tab)
    expect(await manifestIdCanon(patch.ball)).toBe(patch.ball.ballId)
    expect(patch.mutation.remoteSaved).toBe(false)
    expect(patch.mutation.errors.remote).toContain('HTTP 403')
    expect(world.posted).toHaveLength(1)
    expect(world.posted[0]).toMatchObject({ status: 403, answer: { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE' } })
    expect(await world.selected()).toEqual({ ballId: world.head.ball.ballId, epoch: N })
  }, 120_000)
})

/**
 * A tree_patch commit is a head the edge judges (POST /_head/ball, classifyTransition), so her
 * runtime consults the nucleus before it leaves, in shadow. Run against this REAL production head: the commit's request
 * bytes, the head it selects and her result (but for the `nucleus` answer and the wall-clock `elapsedMs`) are identical
 * whatever the consult answers; the tally compares with the head's own `tier: "T1"`.
 */
describe('nucleus shadow on the commit path: consulted before the publish leaves, read by nothing', () => {
  const ORIGIN = 'https://' + PUBLIC_HOST
  const FIXED_NOW = Date.now()
  const reflexServed = (variant: Variant) => (call: Call): Response | null =>
    call.method === 'GET' && call.path === TOUCH_ID_TIER_REFLEX_PATH && variant !== 'removed' && variant !== 'reflex-missing'
      ? new Response(variant === 'reflex-wrong' ? WRONG_REFLEX : REFLEX_BYTES, { headers: { 'content-type': 'application/json' } })
      : null
  const withoutNucleus = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutNucleus)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'nucleus').map(([key, child]) => [key, withoutNucleus(child)]))
  }
  const EXPECTED: Record<Variant, unknown> = {
    removed: { consult: null, reason: 'REMOVED' },
    T1: { decision: 256, reasons: ['T1'], escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 79 },
    escalation: { decision: 4, reasons: ['T2_PROTECTED_ORGAN'], escalate: 1, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 79 },
    null: { consult: null, reason: 'CELL_REFUSED:FUEL' },
    throw: { consult: null, reason: 'CELL_FAILED' },
    hang: { consult: null, reason: 'TIMEOUT' },
    'reflex-missing': { consult: null, reason: 'REFLEX_UNAVAILABLE' },
    'reflex-wrong': { consult: null, reason: 'REFLEX_DIGEST_MISMATCH' },
  }

  async function commitOnce(variant: Variant, options: { realCell?: boolean; session?: Session } = {}) {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
    vi.spyOn(Math, 'random').mockReturnValue(0.4242)
    const asked: unknown[] = []
    if (variant === 'removed') vi.spyOn(shadowModule, 'createNucleusShadow').mockReturnValue(removedShadow)
    else vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(options.realCell ? realCellHost(ORIGIN)
      : standInHost(variant === 'reflex-missing' || variant === 'reflex-wrong' ? 'T1' : variant, asked))
    const world = await realHead(options.session ? { session: options.session } : {})
    const tab = await herTab(world, reflexServed(variant))
    tab.f.calls.length = 0
    const patch = await admittedRepair(tab)
    const calls = tab.f.calls.map(call => ({ method: call.method, path: call.path, body: JSON.stringify(call.body),
      headers: [...call.headers.entries()].filter(([name]) => name !== 'x-x6-operation-id').sort() }))
    const shadow = (await tab.f.tool('x6_self_state').execute({}) as Record<string, unknown>).nucleusShadow as Record<string, unknown>
    const selected = await world.selected()
    vi.restoreAllMocks()
    return { patch, calls, shadow, selected, asked, posted: world.posted }
  }

  it('the publish of an admitted repair: identical bytes, head and result whatever the consult answers', async () => {
    onTestFinished(disposeCellHosts)
    const runs = new Map<Variant, Awaited<ReturnType<typeof commitOnce>>>()
    for (const variant of VARIANTS) runs.set(variant, await commitOnce(variant))
    const base = runs.get('removed')!
    const edgeBound = (run: typeof base) => run.calls.filter(call => !call.path.startsWith('/cells/'))
    expect(edgeBound(base).filter(call => call.method === 'POST' && call.path === '/_head/ball')).toHaveLength(1)
    expect(base.calls.filter(call => call.path.startsWith('/cells/'))).toEqual([])
    expect(base.patch.mutation.remoteSaved).toBe(true)
    expect(base.posted).toHaveLength(1)
    expect(base.posted[0]).toMatchObject({ status: 200, answer: { ok: true, tier: 'T1' } })
    for (const variant of VARIANTS) {
      const run = runs.get(variant)!
      // The bytes the head receives, in order, and every header but the per-operation id: identical; no `nucleus` in them.
      expect(edgeBound(run), variant).toEqual(edgeBound(base))
      expect(edgeBound(run).some(call => call.body.includes('"nucleus"')), variant).toBe(false)
      expect(run.selected, variant).toEqual(base.selected)
      expect(run.selected.epoch, variant).toBe(N + 1)
      // Her result: identical but for the consult's own answer (and elapsedMs, a wall clock the consult itself spends).
      expect(withoutNucleus({ ball: run.patch.ball, entry: run.patch.entry, mutation: run.patch.mutation }), variant)
        .toEqual(withoutNucleus({ ball: base.patch.ball, entry: base.patch.entry, mutation: base.patch.mutation }))
      expect(run.patch.mutation.nucleus, variant).toEqual(EXPECTED[variant])
      if (variant === 'removed') continue
      // The one extra read is her reflex file, once; the cell is asked only when that file is the pinned one.
      expect(run.calls.filter(call => call.path.startsWith('/cells/')).map(call => `${call.method} ${call.path}`), variant)
        .toEqual([`GET ${TOUCH_ID_TIER_REFLEX_PATH}`])
      expect(run.asked.length, variant).toBe(variant.startsWith('reflex-') ? 0 : 1)
      const said = variant === 'T1' ? 256 : variant === 'escalation' ? 4 : null
      expect(run.shadow, variant).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 1, agree: Number(said === 256),
        mismatch: Number(said === 4), unknown: Number(said === null), lastMismatches: expect.any(Array) as unknown[] })
    }
  }, 120_000)

  it('her real nucleus cell agrees with the real head on a T1 repair; a refused publish counts unknown', async () => {
    onTestFinished(disposeCellHosts)
    const agreed = await commitOnce('T1', { realCell: true })
    expect(agreed.patch.mutation.remoteSaved).toBe(true)
    expect(agreed.patch.mutation.nucleus).toEqual(EXPECTED.T1)
    expect(agreed.shadow).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 1, agree: 1, mismatch: 0, unknown: 0,
      lastMismatches: [] })
    const refused = await commitOnce('T1', { realCell: true, session: 'none' })
    expect(refused.patch.mutation.remoteSaved).toBe(false)
    expect(refused.posted[0]).toMatchObject({ status: 403 })
    expect(refused.patch.mutation.nucleus).toEqual(EXPECTED.T1)
    expect(refused.shadow).toEqual({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 1, agree: 0, mismatch: 0, unknown: 1,
      lastMismatches: [] })
  }, 120_000)
})
