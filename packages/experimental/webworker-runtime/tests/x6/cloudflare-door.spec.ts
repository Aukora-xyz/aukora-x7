/** Her `x6_cloudflare` tool. Every host answer is a local fixture; no Cloudflare, key or approval is real. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, mountX6BallRuntime, STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const ORIGIN = 'https://cloudflare-door-fixture.invalid'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
type Args = Record<string, unknown>
interface Tool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Args): Promise<unknown> }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mounted(respond: (body: Args) => Response | Promise<Response>) {
  const source = 'module.exports = { apply() {} }', sha = hash(source)
  const seed: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 1, createdAt: 1000, authorPeerId: 'synthetic',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'fixture', description: 'Synthetic', size: source.length, createdAt: 1000 } } }
  const data: BallManifest = { ...seed, ballId: hash(JSON.stringify({
    version: seed.version, parentBallId: seed.parentBallId, epoch: seed.epoch,
    entries: Object.values(seed.entries), modules: Object.values(seed.modules) })) }
  const vfs = new MemoryVfs(), definitions = new Map<string, Tool>(), services = new Map<string, unknown>(), sent: Args[] = []
  const tools = { register(value: unknown) {
    const tool = value as Tool
    definitions.set(tool.name, tool)
    return () => { definitions.delete(tool.name) }
  } }
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: data, codeBySha: { [sha]: source } })
    if (url.pathname === '/_head/lease' && request.method === 'POST') {
      const body = await request.json() as Args
      return Response.json({ ok: true, ballId: data.ballId,
        lease: { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30000 } })
    }
    if (url.pathname !== '/_host/cloudflare') throw new Error('Unexpected request: ' + url.pathname)
    const body = await request.json() as Args
    sent.push(body)
    return await respond(body)
  })
  const context = { tools, get: (name: string) => services.get(name),
    provide: (name: string, value?: unknown) => { services.set(name, value) },
    plugin: async () => ({ dispose() {} }), effect: (register: () => () => void) => { cleanups.push(register()) } }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  await mountX6BallRuntime(context, vfs, loader)
  return { cloudflare: definitions.get('x6_cloudflare')!, vfs, sent }
}

describe('x6_cloudflare reaches the whole Cloudflare API through the edge', () => {
  it('offers status, versions and api (wrangler is gone: api replaces it), with the api fields and no authority inputs', async () => {
    const { cloudflare } = await mounted(() => Response.json({ ok: true }))
    expect(cloudflare.parameters.action).toMatchObject({ enum: ['status', 'versions', 'api'] })
    for (const key of ['method', 'path', 'query', 'body', 'bodyKind', 'contentType', 'parts', 'remote']) expect(cloudflare.parameters).toHaveProperty(key)
    for (const key of ['args', 'cwd', 'approvalToken', 'headers', 'authorization', 'token']) expect(cloudflare.parameters).not.toHaveProperty(key)
    for (const words of ['{account}', '/zones', 'dns_records', 'CLASS3_WEBAUTHN_REQUIRED', 'wrangler', 'multipart', 'application/javascript+module',
      'main_module', 'bindings', 'account-wide-unclassified', 'stagedForOwner', 'Touch ID']) expect(cloudflare.description).toContain(words)
    expect(cloudflare.description).not.toMatch(/token/i)
  })

  // Job 7: this test asked for under 120 words, the word `open` and "Keys never come back to you".
  // The text no longer names the level (`status` says which is in force) nor promises every key back stays out: the
  // account's own credential stays at the edge, credential-looking answers are withheld, an ordinary value cannot be told.
  it('job 7: her words come first, at most 140: everything is hers but the five that ask, `status` says the level, the credential stays at the edge, what to do when held', async () => {
    const { cloudflare } = await mounted(() => Response.json({ ok: true }))
    const marker = 'How to call it.'
    expect(cloudflare.description.split(marker)).toHaveLength(2)
    const plain = cloudflare.description.split(marker)[0]!.trim()
    expect(plain.split(/\s+/u).length).toBeLessThanOrEqual(140)
    expect(plain.startsWith('Your Cloudflare door.')).toBe(true)
    expect(plain).toContain('everything in the owner\'s Cloudflare account is yours to read and change, except five things that ask for his fingerprint')
    // The five, by name and in order (C1 to C5 of deploy/cloudflare/src/cloudflare-door.mjs CLOUDFLARE_CORE).
    const five = ['1. anything on example.invalid, the live Worker your-node, or a switch that acts on every zone', '2. your live home\'s storage',
      '3. keys, secrets and sign-in', '4. deleting a whole zone or account', '5. anything that commits him to a charge']
    for (const item of five) expect(plain).toContain(item)
    expect(five.map(item => plain.indexOf(item))).toEqual(five.map(item => plain.indexOf(item)).sort((a, b) => a - b))
    expect(plain).toContain('`status` says which level is in force.')
    expect(plain).not.toMatch(/`open`|`guarded`|not in force/u)
    expect(plain).toContain('The account\'s own credential stays at the edge')
    expect(plain).toContain('an answer that looks like a credential comes back withheld')
    expect(plain).toContain('an ordinary value that happens to be one cannot be recognised')
    expect(plain).not.toContain('Keys never come back')
    expect(plain).toContain('When a request is held, tell the owner what you wanted and why, and stop.')
    expect(plain).toContain('Never try another spelling of the same request.')
    expect(plain).not.toMatch(/token/iu)
    expect(cloudflare.description).not.toContain('(not in force now)')
  })

  it('classifies reads as reads and every other api call as a write the edge decides; wrangler stays owner-only', () => {
    const cf = (more: Args) => classifyActionIrreversibility({ tool: 'x6_cloudflare', action: 'api', ...more })
    expect(cf({ method: 'GET', path: '/zones' })).toBe(0)
    expect(cf({ method: 'get', path: '/accounts/{account}/workers/scripts' })).toBe(0)
    expect(cf({ method: 'POST', path: '/graphql', body: { query: '{ viewer { zones { zoneTag } } }' } })).toBe(0)
    expect(cf({ method: 'POST', path: '/zones/z/dns_records', body: { name: 'a.example.org' } })).toBe(1)
    expect(cf({ method: 'DELETE', path: '/zones/z' })).toBe(1)
    expect(cf({ method: 'PATCH', path: '/accounts/{account}/workers/scripts/your-node/settings' })).toBe(1)
    expect(classifyActionIrreversibility({ tool: 'x6_cloudflare', action: 'wrangler' })).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'x6_cloudflare', action: 'status' })).toBe(0)
  })

  it('sends a read and an open write to the edge as-is and returns its answer', async () => {
    const { cloudflare, sent, vfs } = await mounted(body => Response.json({ ok: true, action: 'api', method: body.method, path: body.path, status: 200, success: true, result: [] }))
    const read = { action: 'api', method: 'GET', path: '/zones', query: { per_page: 50 } }
    expect(await cloudflare.execute(read)).toMatchObject({ ok: true, path: '/zones' })
    const write = { action: 'api', method: 'POST', path: '/zones/abc/dns_records', body: { type: 'A', name: 'docs.example.org', content: '192.0.2.1' } }
    expect(await cloudflare.execute(write)).toMatchObject({ ok: true, method: 'POST' })
    expect(sent).toEqual([read, write])
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })

  it('stages a protected write the edge refused without the passkey, as the exact bytes, with why it needs his fingerprint', async () => {
    const { cloudflare, sent, vfs } = await mounted(() => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', macFallback: false,
      protection: { family: 'P1', reason: 'live-zone' } }, { status: 403 }))
    const write = { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } }
    const answer = await cloudflare.execute(write)
    expect(answer).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: true, stagedPath: STAGED_OUTWARD_PATH, sent: false,
      protection: { family: 'P1', reason: 'live-zone' } })
    expect(sent).toEqual([write])
    const staged = JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string) as Args
    expect(staged).toMatchObject({ schema: STAGED_OUTWARD_SCHEMA, tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare', body: write,
      protection: { family: 'P1', reason: 'live-zone' } })
    expect(Object.keys(staged).sort()).toEqual(['body', 'method', 'pathname', 'protection', 'schema', 'stagedAt', 'tool'])
  })

  it('an account-wide write not yet classified is staged with the family the edge named; a multipart write is staged as her parts', async () => {
    const { cloudflare, vfs } = await mounted(body => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', macFallback: false,
      protection: body.path === '/accounts/{account}/load_balancers/pools'
        ? { family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'load_balancers', extra: 'dropped' }
        : { family: 'P1', reason: 'live-worker' } }, { status: 403 }))
    const pool = { action: 'api', method: 'POST', path: '/accounts/{account}/load_balancers/pools', body: { name: 'p' } }
    expect(await cloudflare.execute(pool)).toMatchObject({ stagedForOwner: true })
    expect(JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)).toMatchObject({ body: pool,
      protection: { family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'load_balancers' } })
    expect((JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string) as Args).protection).not.toHaveProperty('extra')
    const module = { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node', bodyKind: 'multipart',
      parts: [{ name: 'worker.js', contentType: 'application/javascript+module', text: 'export default {}' }] }
    expect(await cloudflare.execute(module)).toMatchObject({ stagedForOwner: true })
    expect(JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)).toMatchObject({ body: module, protection: { family: 'P1', reason: 'live-worker' } })
  })

  it('keeps a GitHub or repo request already waiting in the one slot, names it, and stages nothing', async () => {
    const { cloudflare, vfs } = await mounted(() => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', macFallback: false,
      protection: { family: 'P1', reason: 'live-zone' } }, { status: 403 }))
    const write = { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } }
    for (const [waitingFile, named] of [
      [{ tool: 'x6_github', pathname: '/_host/github', body: { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 't', body: 'b' } } },
        'a GitHub request (POST repos/your_org_x/your-node/issues)'],
      [{ tool: 'x6_repo', pathname: '/_host/repo', body: { action: 'write', path: 'docs/x.md', content: 'x' } }, 'a repository change (write docs/x.md)'],
    ] as const) {
      const waiting = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, method: 'POST', ...waitingFile }, null, 2) + '\n'
      vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
      vfs.writeFileSync(STAGED_OUTWARD_PATH, waiting)
      const answer = await cloudflare.execute(write) as Args
      expect(answer).toMatchObject({ code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: false, sent: false, waiting: named })
      expect(answer).not.toHaveProperty('stagedPath')
      expect(String(answer.next)).toContain(named)
      expect(String(answer.next)).toContain('kept')
      // Review: the card hides a sent request but the file stays, so the answer says how to empty the slot.
      expect(String(answer.next)).toContain('x6_repo { action: "clear_staged_outward" }')
      expect(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8')).toBe(waiting)
    }
    // A Cloudflare request already waiting is replaced, as the slot does for every door.
    vfs.writeFileSync(STAGED_OUTWARD_PATH, JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_cloudflare', method: 'POST',
      pathname: '/_host/cloudflare', body: { action: 'api', method: 'DELETE', path: '/zones/old' }, protection: { family: 'P3', reason: 'zone-deletion' } }))
    expect(await cloudflare.execute(write)).toMatchObject({ stagedForOwner: true })
    expect(JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string)).toMatchObject({ body: write })
  })

  it('job 7: stages every reason the edge gave (`also`), exactly', async () => {
    const protection = { family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }, { family: 'P2', reason: 'app-secret' }] }
    const { cloudflare, vfs } = await mounted(() => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', protection }, { status: 403 }))
    expect(await cloudflare.execute({ action: 'api', method: 'PUT', path: '/accounts/{account}/registrar/domains/example.invalid', body: { auto_renew: true } })).toMatchObject({ stagedForOwner: true })
    expect((JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string) as Args).protection).toEqual(protection)
  })

  it('stages nothing when the edge does not say why, or says it in a shape the contract does not allow (no card can show it)', async () => {
    const also = (...pairs: Array<[string, string]>) => ({ family: 'P1', reason: 'live-zone', also: pairs.map(([family, reason]) => ({ family, reason })) })
    for (const protection of [undefined, { family: 'P9', reason: 'x' }, { family: 'P1' }, { family: 'P1', reason: 'Live Zone!' },
      // Job 7: an `also` that is empty, unsorted, repeated, carries the primary pair, an extra member, more than eight, or is not a list.
      also(), also(['P4', 'billing'], ['P1', 'live-host']), also(['P1', 'live-host'], ['P1', 'live-host']), also(['P1', 'live-zone']),
      { family: 'P1', reason: 'live-zone', also: [{ family: 'P1', reason: 'live-host', extra: 1 }] },
      also(...Array.from({ length: 9 }, (_, index): [string, string] => ['P1', 'r' + 'abcdefghi'[index]!])), { family: 'P1', reason: 'live-zone', also: 'live-host' }]) {
      const { cloudflare, vfs } = await mounted(() => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', protection }, { status: 403 }))
      const answer = await cloudflare.execute({ action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', body: { value: 'full' } }) as Args
      expect([protection, answer.stagedForOwner, answer.sent]).toEqual([protection, false, false])
      expect(String(answer.next)).toContain('Nothing was sent')
      expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
    }
  })

  it('never carries approval or credential material from the model, and does not stage other refusals', async () => {
    const { cloudflare, sent, vfs } = await mounted(() => Response.json({ ok: false, code: 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED', next: 'dashboard' }, { status: 403 }))
    for (const key of ['approvalToken', 'authorization', 'headers', 'token', 'clientSecret']) {
      await expect(cloudflare.execute({ action: 'api', method: 'GET', path: '/zones', [key]: 'x' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
    }
    expect(sent).toHaveLength(0)
    expect(await cloudflare.execute({ action: 'api', method: 'GET', path: '/accounts/{account}/cfd_tunnel/t/token' })).toMatchObject({ code: 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED' })
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
    await expect(cloudflare.execute({ action: 'wrangler', args: ['whoami'] })).rejects.toThrow('CLASS3_OWNER_SIGNATURE_REQUIRED')
  })
})

// Review: the door end to end from her tool call. Job 7: the card sends the
// staged body with `expect`, the staged protection, and the approval covers that object. The tool above is wired to the real edge
// broker (deploy/cloudflare/src/cloud-brokers.mjs) at the level in force (`open`), whose only network is a fake
// Cloudflare below. For each core family and three open requests: her call, the edge's hold or pass, what is staged for
// The owner, the staged bytes sent again with the suite's synthetic approval (what his card does), the request the fake
// Cloudflare receives, and the answer. A held request that is not approved reaches Cloudflare zero times.
const edgeFunction = async (file: string, name: string): Promise<(...args: unknown[]) => unknown> => {
  const source: unknown = await import(new URL(`../../../../../deploy/cloudflare/src/${file}`, import.meta.url).href)
  const value: unknown = source && typeof source === 'object' && name in source ? (source as Record<string, unknown>)[name] : undefined
  if (typeof value !== 'function') throw new Error(`${file} has no ${name}`)
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args) as unknown
}
const canonical = async (value: unknown): Promise<string> => {
  const text = (await edgeFunction('owner-grant-policy.mjs', 'canonicalJson'))(value)
  if (typeof text !== 'string') throw new Error('canonicalJson did not return text')
  return text
}
const ACCOUNT = '0123456789abcdef0123456789abcdef', LIVE_ZONE = 'f'.repeat(32), OTHER_ZONE = 'e'.repeat(32)
const HEAD_NS = '5ead0000000000000000000000000a01', MIRROR_NS = '5ead0000000000000000000000000a02', VOICE_NS = '5ead0000000000000000000000000a04', KV_LIVE = '6b76' + '0'.repeat(26) + 'b1'
const CF = 'https://api.cloudflare.com/client/v4'
const EDGE_ENV = { CLOUDFLARE_API_TOKEN: 'synthetic-global-key-fixture-0000', CLOUDFLARE_EMAIL: 'owner@example.org', CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_DOOR_LEVEL: 'open', SOURCE_REVISION: 'a'.repeat(40) }
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: 'synthetic-seed' }, mirror: { phase: 'ready' } }
// The live Worker's settings as wrangler.toml binds it today, plus one KV namespace that only its settings name (C2 by the read).
const SETTINGS = { success: true, errors: [], messages: [], result: { tail_consumers: [], bindings: [{ type: 'assets', name: 'ASSETS' },
  { type: 'durable_object_namespace', name: 'HEAD', class_name: 'X61HeadDurableObject' },
  { type: 'durable_object_namespace', name: 'MIRROR', class_name: 'MirrorDO' },
  { type: 'durable_object_namespace', name: 'VOICE_BRIDGE', class_name: 'VoiceBridgeDO' },
  { type: 'r2_bucket', name: 'ARCHIVE_BUCKET', bucket_name: 'your-node-archive' }, { type: 'kv_namespace', name: 'NOTES', namespace_id: KV_LIVE }] } }
const NAMESPACES = { success: true, errors: [], messages: [],
  result_info: { page: 1, per_page: 1000, count: 3, total_count: 3, total_pages: 1 },
  // The managed voice's bridge is the live Worker's third Durable Object class (wrangler.toml).
  result: [{ id: HEAD_NS, script: 'your-node', class: 'X61HeadDurableObject' }, { id: MIRROR_NS, script: 'your-node', class: 'MirrorDO' },
    { id: VOICE_NS, script: 'your-node', class: 'VoiceBridgeDO' }] }
const ZONE_NAMES: Record<string, string> = { [LIVE_ZONE]: 'example.invalid', [OTHER_ZONE]: 'example.org' }
const ROUTE_ERROR = { success: false, errors: [{ code: 7003, message: 'Could not route' }], messages: [], result: null }
interface Sent { url: string; method: string; body: unknown }

function fakeEdge() {
  const writes: Sent[] = [], reads: string[] = [], grants = new Map<string, Args>()
  let current: Request | null = null, asked = 0, consumed = 0
  const networkFetch = (url: string, init: RequestInit): Response => {
    const target = new URL(url), path = target.pathname.slice('/client/v4'.length)
    if (target.origin !== 'https://api.cloudflare.com') throw new Error('External network is forbidden')
    if (init.method === 'GET') {
      reads.push(path)
      if (/^\/accounts\/[0-9a-f]{32}\/workers\/durable_objects\/namespaces$/u.test(path)) return Response.json(NAMESPACES)
      if (/^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/your-node\/settings$/u.test(path)) return Response.json(SETTINGS)
      // Job 7: the zones by name, for the live zone's id.
      if (path === '/zones' && target.searchParams.has('name')) {
        const wanted = target.searchParams.get('name'), found = Object.entries(ZONE_NAMES).find(([, name]) => name === wanted)
        return Response.json({ success: true, errors: [], messages: [], result: found ? [{ id: found[0], name: found[1] }] : [] })
      }
      const zone = /^\/zones\/([0-9a-f]{32})$/u.exec(path)?.[1]
      const name = zone === undefined ? undefined : ZONE_NAMES[zone]
      if (name !== undefined) return Response.json({ success: true, errors: [], messages: [], result: { id: zone, name } })
      return Response.json(ROUTE_ERROR, { status: 404 })
    }
    writes.push({ url, method: String(init.method), body: init.body })
    return Response.json({ success: true, errors: [], messages: [], result: { id: 'created' } })
  }
  // HEAD's consumer as the edge wires it: no approval header is a refusal; an approval is spent once, on its exact bytes.
  const authorizeClass3 = async (input: unknown): Promise<Args> => {
    asked++
    const id = current?.headers.get('x-x6-class3-approval') ?? '', grant = grants.get(id)
    if (grant === undefined) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    if ((grant.binding as Args).bodySha256 !== hash(await canonical(input))) return { ok: false }
    grants.delete(id)
    consumed++
    return structuredClone(grant)
  }
  return { writes, reads, get asked() { return asked }, get consumed() { return consumed },
    async grant(body: unknown): Promise<string> {
      const id = 'approval-' + String(grants.size + consumed)
      grants.set(id, { ok: true, expiresAt: Date.now() + 60000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST',
        pathname: '/_host/cloudflare', bodySha256: hash(await canonical(body)) } })
      return id
    },
    async send(body: unknown, approval?: string): Promise<Response> {
      current = new Request(ORIGIN + '/_host/cloudflare', { method: 'POST', body: JSON.stringify(body),
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
          ...(approval === undefined ? {} : { 'x-x6-class3-approval': approval }) } })
      const broker = await edgeFunction('cloud-brokers.mjs', 'handleCloudBroker')
      const context = { bootstrap: BOOTSTRAP, now: () => Date.now(), authorizeClass3, networkFetch }
      const response: unknown = await broker(current, EDGE_ENV, context)
      if (!(response instanceof Response)) throw new Error('the broker did not answer a Response')
      return response
    } }
}

const LIFECYCLE = { rules: [{ id: 'expire-old', enabled: true, conditions: { prefix: 'tmp/' },
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } }] }
const cfCall = (method: string, path: string, more: Args = {}): Args => ({ action: 'api', method, path, ...more })
type Expected = { family: string; reason: string } | 'open'
const TOOL_ROWS: Array<[string, Args, Expected, string?]> = [
  ['C1 live zone', cfCall('PATCH', `/zones/${LIVE_ZONE}/settings/ssl`, { body: { value: 'flexible' } }), { family: 'P1', reason: 'live-zone' }],
  ['C1 account switch', cfCall('POST', '/accounts/{account}/rulesets', { body: { kind: 'custom', phase: 'http_request_firewall_custom',
    rules: [{ expression: '(ip.src==192.0.2.1)', action: 'block' }] } }), { family: 'P1', reason: 'account-switch' }],
  ['C2 storage by name', cfCall('PUT', '/accounts/{account}/r2/buckets/your-node-archive/lifecycle', { body: LIFECYCLE }),
    { family: 'P1', reason: 'bound-storage' }],
  ['C2 storage the live Worker binds (from its settings)', cfCall('DELETE', `/accounts/{account}/storage/kv/namespaces/${KV_LIVE}`),
    { family: 'P1', reason: 'bound-storage' }, 'settings'],
  ['C3 credentials', cfCall('POST', '/accounts/{account}/members', { body: { email: 'friend@example.org', roles: [ACCOUNT], status: 'pending' } }),
    { family: 'P2', reason: 'members' }],
  ['C4 deletion', cfCall('DELETE', `/zones/${OTHER_ZONE}`), { family: 'P3', reason: 'zone-deletion' }],
  ['C5 charge', cfCall('POST', '/accounts/{account}/subscriptions', { body: { rate_plan: { id: 'business' }, frequency: 'monthly' } }),
    { family: 'P4', reason: 'paid-subscription' }],
  ['open: another zone\'s DNS record', cfCall('POST', `/zones/${OTHER_ZONE}/dns_records`,
    { body: { type: 'CNAME', name: 'docs.example.org', content: 'notes-site.example.net', proxied: true } }), 'open'],
  ['open: her own Worker\'s code', cfCall('PUT', '/accounts/{account}/workers/scripts/notes-site',
    { body: "export default { fetch() { return new Response('notes') } }", bodyKind: 'text', contentType: 'application/javascript' }), 'open', 'settings'],
  ['open: an R2 bucket not bound to the live home', cfCall('PUT', '/accounts/{account}/r2/buckets/notes-photos/lifecycle', { body: LIFECYCLE }),
    'open', 'settings'],
]

describe('from her tool call through the edge to a fake Cloudflare, at `open`', () => {
  it.each(TOOL_ROWS)('%s', async (name, call, expected, read) => {
    const edge = fakeEdge()
    const { cloudflare, sent, vfs } = await mounted(async body => await edge.send(body))
    const target = CF + String(call.path).replace('{account}', ACCOUNT)
    const bytes = call.body === undefined ? undefined : call.bodyKind === 'text' ? call.body : await canonical(call.body)
    const answer = await cloudflare.execute(call) as Args
    expect(sent).toEqual([call])
    if (read === 'settings') expect(edge.reads.filter(path => path.endsWith('/workers/scripts/your-node/settings'))).toHaveLength(1)
    let after: Args = answer
    if (expected === 'open') {
      expect([name, edge.asked, vfs.existsSync(STAGED_OUTWARD_PATH)]).toEqual([name, 0, false])
    } else {
      expect(answer).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: true, sent: false, protection: expected })
      expect([name, edge.writes.length]).toEqual([name, 0])
      const staged = JSON.parse(vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string) as Args
      expect(staged).toMatchObject({ schema: STAGED_OUTWARD_SCHEMA, tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare',
        body: call, protection: expected })
      // Not approved, approved for other bytes, or approved with another reason: it reaches Cloudflare zero times.
      const card = { ...(staged.body as Args), expect: staged.protection }
      expect((await edge.send(staged.body)).status).toBe(403)
      expect((await edge.send(card, await edge.grant({ ...card, path: String(call.path) + '-other' }))).status).toBe(403)
      const swapped = { ...card, expect: { family: 'P1', reason: 'not-the-reason' } }
      expect((await edge.send(swapped, await edge.grant(swapped))).status).toBe(409)
      expect([name, edge.writes.length, edge.consumed]).toEqual([name, 0, 0])
      // The owner's approval of the staged bytes with their reason (the suite's synthetic one): sent once, the approval spent.
      const approved = await edge.send(card, await edge.grant(card))
      expect([name, approved.status, edge.consumed]).toEqual([name, 200, 1])
      after = await approved.json() as Args
    }
    // What the fake Cloudflare received: one write, to the path she named (account filled in), with the canonical bytes.
    expect(edge.writes).toEqual([{ url: target, method: call.method, body: bytes }])
    // The answer she gets after the screen.
    expect(after).toMatchObject({ ok: true, method: call.method, path: call.path, result: { id: 'created' } })
    expect(JSON.stringify(after)).not.toMatch(/synthetic-global-key|owner@example\.org|x-auth-|authorization/iu)
  })
})
