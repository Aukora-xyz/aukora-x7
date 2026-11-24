/**
 * Lane E2: the cold-boot head read is honest. A refused, broken or poisoned answer from
 * GET /_head/ball is surfaced as a typed `headFetchError` (mirrored into `authorityError`), is never read as "no head",
 * and never requests the first-bootstrap writer lease; a poisoned `codeBySha` set is refused whole, before any VFS write.
 * No browser, real network, secrets or selected-head writes: fetch is a local stub on a reserved `.invalid` origin.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountX6BallRuntime, verifyCodeBySha, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const ORIGIN = 'https://cold-boot-fixture.invalid'
const SEED_DIR = '/dsh/home/auma/seed/organs'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const manifestId = (ball: BallManifest): string => hash(JSON.stringify({
  version: ball.version, parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(id => ball.entries[id]),
  modules: Object.keys(ball.modules).sort().map(sha => ball.modules[sha]) }))

/** A valid selected head with two modules, so a bad digest on either one must refuse both. */
function selectedHead() {
  const codeA = 'module.exports = { apply() {} }; // cold-boot organ A'
  const codeB = 'module.exports = { apply() {} }; // cold-boot organ B'
  const shaA = hash(codeA), shaB = hash(codeB)
  const meta = (sha: string, name: string, code: string) => ({ sha256: sha, specifier: `ball:${sha}`, name, description: 'Synthetic module',
    size: Buffer.byteLength(code), createdAt: 1000 })
  const entry = (id: string, sha: string): BallEntryRecord => ({ id, specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 })
  const draft: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 7, createdAt: 1000, authorPeerId: 'fixture-author',
    entries: { 'organ-a': entry('organ-a', shaA), 'organ-b': entry('organ-b', shaB) },
    modules: { [shaA]: meta(shaA, 'organ-a', codeA), [shaB]: meta(shaB, 'organ-b', codeB) } }
  return { ball: { ...draft, ballId: manifestId(draft) }, codeA, codeB, shaA, shaB }
}

type Responder = () => Response | Promise<Response>

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** Mount her runtime against a stubbed host whose GET /_head/ball answers with `respond`. */
async function coldBoot(respond: Responder) {
  const vfs = new MemoryVfs()
  // A Seed organ on disk makes the first-bootstrap path reachable: without one the lease is never wanted at all.
  vfs.mkdirSync(SEED_DIR, { recursive: true })
  vfs.writeFileSync(`${SEED_DIR}/seed-cold-boot.js`, 'module.exports = { apply() {} }; // seed')
  const writes: string[] = []
  const write = vfs.writeFileSync.bind(vfs)
  vi.spyOn(vfs, 'writeFileSync').mockImplementation((path, data, options) => { writes.push(String(path)); write(path, data, options) })
  const requests: Array<{ method: string; path: string }> = []
  const provided = new Map<string, unknown>()
  class Tools {
    readonly registry = new Map<string, { name: string }>()
    register(definition: unknown) {
      const tool = definition as { name: string }
      this.registry.set(tool.name, tool)
      return () => { this.registry.delete(tool.name) }
    }
    get(name: string) { return this.registry.get(name) }
    definitions() { return [...this.registry.values()] }
  }
  const context = { tools: new Tools(), get: (name: string) => provided.get(name),
    provide: (name: string, value?: unknown) => { provided.set(name, value) },
    plugin: async () => ({ dispose() {} }) }
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  const errors: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    requests.push({ method: request.method, path: url.pathname })
    if (url.pathname === '/_head/ball' && request.method === 'GET') return respond()
    if (url.pathname === '/_head/lease' && request.method === 'POST') {
      const input = await request.json() as { ownerPeerId: string }
      return Response.json({ ok: true, ballId: null,
        lease: { ownerPeerId: input.ownerPeerId, generation: 1, expiresAt: Date.now() + 30000 } })
    }
    return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  const runtime = await mountX6BallRuntime(context as unknown as Parameters<typeof mountX6BallRuntime>[0], vfs, loader)
  const reply = await runtime.handleControlRequest('GET', '/__x6__/status', '')
  const status = reply?.body as {
    headFetchError: string | null
    authorityError: string | null
    seedCandidates: Record<string, string>
    epoch: number
  }
  const leaseRequests = requests.filter(r => r.path === '/_head/lease' || r.path.startsWith('/_head/bootstrap'))
  return { vfs, writes, requests, leaseRequests, status, errors }
}

const html = '<!doctype html><html><head><title>Sign in</title></head><body><form action="/_auth/owner"></form></body></html>'

describe('Probe 11: a failed cold-boot head read is never "no head"', () => {
  const cases: Array<[string, Responder, RegExp]> = [
    ['HTTP 401 owner sign-in required', () => Response.json({ ok: false, code: 'OWNER_SESSION_REQUIRED' }, { status: 401 }), /^HEAD_FETCH_FAILED: HTTP 401$/],
    ['HTTP 401 HTML sign-in page', () => new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }), /^HEAD_FETCH_FAILED: HTTP 401$/],
    ['HTTP 403 origin refused', () => Response.json({ ok: false, code: 'ORIGIN_REFUSED' }, { status: 403 }), /^HEAD_FETCH_FAILED: HTTP 403$/],
    ['HTTP 501 not implemented', () => new Response('Not Implemented', { status: 501 }), /^HEAD_FETCH_FAILED: HTTP 501$/],
    ['HTTP 503 head unavailable', () => Response.json({ ok: false, code: 'HEAD_UNAVAILABLE' }, { status: 503 }), /^HEAD_FETCH_FAILED: HTTP 503$/],
    ['200 HTML error page', () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), /^HEAD_FETCH_FAILED: non-JSON body \(text\/html; charset=utf-8\)$/],
    ['200 truncated JSON', () => new Response('{"ok":true,"ball":', { status: 200, headers: { 'content-type': 'application/json' } }), /^HEAD_FETCH_FAILED: non-JSON body \(application\/json\)$/],
    ['200 empty body', () => new Response('', { status: 200 }), /^HEAD_FETCH_FAILED: non-JSON body/],
    ['200 JSON array', () => Response.json([]), /^HEAD_FETCH_FAILED: body is not a JSON object$/],
    ['200 JSON null', () => Response.json(null), /^HEAD_FETCH_FAILED: body is not a JSON object$/],
    ['200 { ok: false } with a code', () => Response.json({ ok: false, code: 'HEAD_STORE_UNREADABLE' }), /^HEAD_FETCH_FAILED: HEAD_STORE_UNREADABLE$/],
    ['200 { ok: false } without a code', () => Response.json({ ok: false }), /^HEAD_FETCH_FAILED: ok:false$/],
    ['200 unknown manifest version', () => Response.json({ ok: true, ball: { version: 'x9-ball/v0', ballId: 'f'.repeat(64) } }), /^HEAD_FETCH_FAILED: unrecognised ball manifest$/],
    ['network failure', () => { throw new TypeError('Failed to fetch') }, /^HEAD_FETCH_UNREACHABLE: Failed to fetch$/],
  ]

  it.each(cases)('%s: typed headFetchError, mirrored authorityError, no bootstrap lease', async (_label, respond, expected) => {
    const boot = await coldBoot(respond)
    expect(boot.status.headFetchError).toMatch(expected)
    expect(boot.status.authorityError).toBe(boot.status.headFetchError)
    expect(boot.requests.filter(r => r.path === '/_head/ball')).toHaveLength(1)
    expect(boot.leaseRequests).toEqual([])
    // Nothing was adopted or bootstrapped: the local genesis stays at epoch 0 with no Seed candidates staged.
    expect(boot.status.epoch).toBe(0)
    expect(boot.status.seedCandidates).toEqual({})
    expect(boot.writes.filter(path => path.startsWith('/dsh/home/balls/') && path.endsWith('.js'))).toEqual([])
    expect(boot.errors.some(args => String(args[0]).includes('head fetch did not yield a selected head'))).toBe(true)
  })

  it('control: an explicit 200 { ok: true, ball: null } IS "no head" and does request the first-bootstrap lease', async () => {
    const boot = await coldBoot(() => Response.json({ ok: true, ball: null, codeBySha: {} }))
    expect(boot.status.headFetchError).toBeNull()
    expect(boot.leaseRequests.length).toBeGreaterThan(0)
    expect(boot.leaseRequests[0]).toEqual({ method: 'POST', path: '/_head/lease' })
  })

  it('control: a valid selected head is adopted as a remote head (no lease, no error)', async () => {
    const head = selectedHead()
    const codeBySha = { [head.shaA]: head.codeA, [head.shaB]: head.codeB }
    const boot = await coldBoot(() => Response.json({ ok: true, ball: head.ball, codeBySha }))
    expect(boot.status.headFetchError).toBeNull()
    expect(boot.leaseRequests).toEqual([])
    expect(boot.writes).toContain(`/dsh/home/balls/${head.shaA}.js`)
    expect(boot.writes).toContain(`/dsh/home/balls/${head.shaB}.js`)
  })
})

describe('Probe 10: BALL_CODE_HASH_MISMATCH refuses the whole codeBySha set before any VFS write', () => {
  const poisoned: Array<[string, (h: ReturnType<typeof selectedHead>) => Record<string, unknown>]> = [
    ['one body tampered', h => ({ [h.shaA]: h.codeA, [h.shaB]: 'tampered' })],
    ['bodies swapped between keys', h => ({ [h.shaA]: h.codeB, [h.shaB]: h.codeA })],
    ['uppercase key', h => ({ [h.shaA]: h.codeA, [h.shaB.toUpperCase()]: h.codeB })],
    ['short key', h => ({ [h.shaA]: h.codeA, [h.shaB.slice(0, 63)]: h.codeB })],
    ['non-string body', h => ({ [h.shaA]: h.codeA, [h.shaB]: { code: h.codeB } })],
  ]

  it.each(poisoned)('%s: cold boot refuses every module, writes none of them and never leases', async (_label, poison) => {
    const head = selectedHead()
    const boot = await coldBoot(() => Response.json({ ok: true, ball: head.ball, codeBySha: poison(head) }))
    expect(boot.status.headFetchError).toMatch(/^BALL_CODE_HASH_MISMATCH: /)
    expect(boot.status.authorityError).toBe(boot.status.headFetchError)
    expect(boot.leaseRequests).toEqual([])
    // Not even the module whose digest was correct reached the VFS, under its name or anywhere else.
    expect(boot.writes.filter(path => path.toLowerCase().includes(head.shaA) || path.toLowerCase().includes(head.shaB))).toEqual([])
    for (const sha of [head.shaA, head.shaB]) {
      expect(boot.vfs.existsSync(`/dsh/home/balls/${sha}.js`)).toBe(false)
      expect(boot.vfs.existsSync(`/dsh/home/organs/${sha}.js`)).toBe(false)
    }
    expect(boot.status.epoch).toBe(0)
  })

  it('verifyCodeBySha: all-or-nothing on the pure helper', () => {
    const head = selectedHead()
    expect(verifyCodeBySha({ [head.shaA]: head.codeA, [head.shaB]: head.codeB }))
      .toEqual([[head.shaA, head.codeA], [head.shaB, head.codeB]])
    expect(verifyCodeBySha(undefined)).toEqual([])
    expect(verifyCodeBySha(null)).toEqual([])
    expect(() => verifyCodeBySha({ [head.shaA]: head.codeA, [head.shaB]: 'tampered' })).toThrow(/^BALL_CODE_HASH_MISMATCH: /)
    expect(() => verifyCodeBySha([head.codeA])).toThrow('BALL_CODE_HASH_MISMATCH: codeBySha is not a record')
    expect(() => verifyCodeBySha('code')).toThrow('BALL_CODE_HASH_MISMATCH: codeBySha is not a record')
  })
})
