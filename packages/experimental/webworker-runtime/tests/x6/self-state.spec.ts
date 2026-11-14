/**
 * `x6_self_state`, one read-only tool that says what her running session actually loaded.
 *
 * Unit level over the pure projection (a made-up registry: every null explained, the 16 KiB bound, a stable key order,
 * the secret-shape filter) and the one edge read, then on her mounted runtime (e4 fixture, reserved `.invalid` origin):
 * `sha256Loaded` is the hash of the text her loader evaluated (recorded then, never recomputed from a file), it changes
 * with that text although the store file does not, the call writes nothing (write-set recorder, live recorder, VFS
 * digest), touches no IndexedDB or storage and sends exactly one GET /api/build; the capability index lists it
 * read-only and a look-only voice turn may call it. Local fixtures only.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BallEntryRecord, BallManifest } from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  forgedCellsView, keptSkillsView, projectSelfState, readEdgeBuild, readSelfState, SELF_STATE_EDGE_TIMEOUT_MS, SELF_STATE_RESULT_BYTES,
  type SelfStateObservation, type SelfStateRegistry,
} from '../../src/x6/self-state.ts'
import { FORGED_CELLS_MAX, SKILLS_MAX } from '../../src/x6/ball-loader.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import { createWriteSetRecorder, liveWriteSet } from '../../src/x6/write-set-inventory.ts'
import { FakeSocket, headManifestIdCanon, mountE4, ORGAN_A, ORGAN_A2, PEARL_V1, sha256 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const A = 'a'.repeat(64), B = 'b'.repeat(64), S = 'c'.repeat(64), STORE_A = 'd'.repeat(64)
const REV = '1'.repeat(40), EDGE_REV = '2'.repeat(40)

/** Two organs (organ-a's store file differs, organ-b's is missing), one staged module, no head, the door unregistered. */
const madeUp = (overrides: Partial<SelfStateRegistry> = {}): SelfStateRegistry => ({
  sourceRevision: REV, bootedAtMs: 1_000, head: null,
  organs: [
    { id: 'organ-b', specifier: `ball:${B}`, loaded: { sha256: B, bytes: 20 }, state: 'running' },
    { id: 'organ-a', specifier: `ball:${A}`, loaded: { sha256: A, bytes: 10 }, state: 'running' },
  ],
  staged: [{ sha256: S, name: 'organ-a' }],
  tools: ['x6_self_state', 'ball_status'],
  cloudflareDoor: { registered: false, status: null },
  ...overrides,
})
const observe = (registry: SelfStateRegistry, extra: Partial<SelfStateObservation> = {}): SelfStateObservation => ({
  registry, store: { 'organ-a': STORE_A, 'organ-b': null }, edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null, ...extra,
})

/** Every null in the answer, by the field name its `unknown` row uses. */
function nullFields(answer: Record<string, unknown>): string[] {
  const out: string[] = []
  const runtime = answer.runtime as Record<string, unknown>, edge = answer.edge as Record<string, unknown>
  if (runtime.sourceRevision === null) out.push('runtime.sourceRevision')
  if (edge.sourceRevision === null) out.push('edge.sourceRevision')
  if (answer.head === null) out.push('head')
  for (const organ of answer.organs as Array<Record<string, unknown>>) {
    for (const key of ['sha256Loaded', 'bytes', 'storeSha256', 'matchesStore']) if (organ[key] === null) out.push(`organs[${String(organ.id)}].${key}`)
  }
  if (answer.tools === null) out.push('tools')
  if ((answer.doors as Record<string, unknown>).cloudflare === null) out.push('doors.cloudflare')
  return out.sort()
}

describe('the projection from a made-up registry', () => {
  it('gives exactly the expected object, in a fixed key order, every null explained by one row', () => {
    const answer = projectSelfState(observe(madeUp()))
    const expected = {
      schema: 'aukora.self-state.v1',
      runtime: { sourceRevision: REV, bootedAtMs: 1_000 },
      edge: { sourceRevision: null },
      head: null,
      organs: [
        { id: 'organ-a', specifier: `ball:${A}`, sha256Loaded: A, bytes: 10, storeSha256: STORE_A, matchesStore: false, state: 'running' },
        { id: 'organ-b', specifier: `ball:${B}`, sha256Loaded: B, bytes: 20, storeSha256: null, matchesStore: null, state: 'running' },
      ],
      staged: [{ sha256: S, name: 'organ-a' }],
      tools: ['ball_status', 'x6_self_state'],
      doors: { cloudflare: null },
      unknown: [
        { field: 'doors.cloudflare', reason: 'not-registered' },
        { field: 'edge.sourceRevision', reason: 'unreachable' },
        { field: 'head', reason: 'not-recorded' },
        { field: 'organs[organ-b].matchesStore', reason: 'read-failed' },
        { field: 'organs[organ-b].storeSha256', reason: 'read-failed' },
      ],
    }
    // String equality checks key order too.
    expect(JSON.stringify(answer)).toBe(JSON.stringify(expected))
    const rows = answer.unknown as Array<{ field: string }>
    expect(rows.map(row => row.field)).toEqual(nullFields(answer))
  })

  it('a value the loader does not hold is null with its reason, never a default', () => {
    const answer = projectSelfState(observe(madeUp({
      sourceRevision: null, tools: null, head: { ballId: A, epoch: 7, origin: 'host' },
      organs: [{ id: 'organ-a', specifier: `ball:${A}`, loaded: null, state: 'not-running' }],
      cloudflareDoor: { registered: true, status: null },
    }), { edge: { sourceRevision: null, reason: 'not-recorded' } }))
    expect(answer.head).toEqual({ ballId: A, epoch: 7, origin: 'host' })
    expect(answer.organs).toEqual([{ id: 'organ-a', specifier: `ball:${A}`, sha256Loaded: null, bytes: null, storeSha256: STORE_A, matchesStore: null, state: 'not-running' }])
    expect(answer.unknown).toEqual([
      { field: 'doors.cloudflare', reason: 'not-recorded' },
      { field: 'edge.sourceRevision', reason: 'not-recorded' },
      { field: 'organs[organ-a].bytes', reason: 'not-recorded' },
      { field: 'organs[organ-a].matchesStore', reason: 'not-recorded' },
      { field: 'organs[organ-a].sha256Loaded', reason: 'not-recorded' },
      { field: 'runtime.sourceRevision', reason: 'not-recorded' },
      { field: 'tools', reason: 'read-failed' },
    ])
    expect((answer.unknown as Array<{ field: string }>).map(row => row.field)).toEqual(nullFields(answer))
  })

  it('a registry of 300 organs is cut with a too-many row, never an oversized answer', () => {
    const organs = Array.from({ length: 300 }, (_, i) => {
      const sha = createHash('sha256').update(String(i)).digest('hex')
      return { id: `organ-${String(i).padStart(3, '0')}`, specifier: `ball:${sha}`, loaded: { sha256: sha, bytes: 100 + i }, state: 'running' }
    })
    const store = Object.fromEntries(organs.map(organ => [organ.id, organ.loaded.sha256]))
    const answer = projectSelfState(observe(madeUp({ organs }), { store }))
    const size = new TextEncoder().encode(JSON.stringify(answer)).byteLength
    expect(size).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    const shown = answer.organs as Array<{ id: string }>
    expect(shown.length).toBeGreaterThan(10)
    expect(shown.length).toBeLessThan(300)
    expect(shown.map(organ => organ.id)).toEqual(organs.map(organ => organ.id).sort().slice(0, shown.length))
    expect(answer.unknown).toContainEqual({ field: 'organs', reason: 'too-many' })
    // Narrowed, the same registry answers in full for the ids asked.
    const narrowed = projectSelfState(observe(madeUp({ organs }), { store, organFilter: ['organ-299', 'organ-007', 'no-such-organ'] }))
    expect((narrowed.organs as Array<{ id: string }>).map(organ => organ.id)).toEqual(['organ-007', 'organ-299'])
    expect(narrowed.unknown).toContainEqual({ field: 'organs[no-such-organ]', reason: 'not-registered' })
    expect(narrowed.unknown).not.toContainEqual({ field: 'organs', reason: 'too-many' })
  })

  it('more than 64 staged modules are cut with a too-many row, sorted by sha256', () => {
    const staged = Array.from({ length: 70 }, (_, i) => ({ sha256: createHash('sha256').update(`s${String(i)}`).digest('hex'), name: `m${String(i)}` }))
    const answer = projectSelfState(observe(madeUp({ staged })))
    const shown = answer.staged as Array<{ sha256: string }>
    expect(shown).toHaveLength(64)
    expect(shown.map(item => item.sha256)).toEqual(staged.map(item => item.sha256).sort().slice(0, 64))
    expect(answer.unknown).toContainEqual({ field: 'staged', reason: 'too-many' })
  })

  it('key order and content are stable whatever order the registry lists things in', () => {
    const one = madeUp()
    const two = madeUp({ organs: [...one.organs].reverse(), tools: [...(one.tools ?? [])].reverse() })
    expect(JSON.stringify(projectSelfState(observe(two)))).toBe(JSON.stringify(projectSelfState(observe(one))))
    expect(Object.keys(projectSelfState(observe(one)))).toEqual(['schema', 'runtime', 'edge', 'head', 'organs', 'staged', 'tools', 'doors', 'unknown'])
  })

  it('free text passes the secret-shape filter; no private path, no key-shaped run leaves', () => {
    const key = 'sk-' + 'x'.repeat(48)
    const answer = projectSelfState(observe(madeUp({
      organs: [{ id: 'organ-a', specifier: '/dsh/home/auma/private/plugin.js', loaded: null, state: 'running' }],
      staged: [{ sha256: S, name: `named ${key}` }],
      cloudflareDoor: { registered: true, status: { level: 'open', configured: true } },
    })))
    const text = JSON.stringify(answer)
    expect(text).not.toContain(key)
    expect(text).not.toContain('/private/')
    expect((answer.organs as Array<{ specifier: string }>)[0]?.specifier).toBe('[withheld]')
    expect(answer.staged).toEqual([{ sha256: S, name: 'named [withheld]' }])
    expect(answer.doors).toEqual({ cloudflare: { level: 'open', configured: true } })
  })
})

describe('the one edge read', () => {
  const answer = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }))
  it('GET /api/build, same origin, says the revision, or null with why', async () => {
    const fetch = answer({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: EDGE_REV })
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch })).toEqual({ sourceRevision: EDGE_REV, reason: null })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect([url, init.method, init.mode, init.credentials, init.redirect]).toEqual(['https://x.invalid/api/build', 'GET', 'same-origin', 'same-origin', 'error'])
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch: answer({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null }) }))
      .toEqual({ sourceRevision: null, reason: 'not-recorded' })
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch: answer({ ok: false }, 502) })).toEqual({ sourceRevision: null, reason: 'unreachable' })
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch: answer({ ok: true, schema: 'other', sourceRevision: EDGE_REV }) }))
      .toEqual({ sourceRevision: null, reason: 'read-failed' })
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch: vi.fn(async () => new Response('not json')) }))
      .toEqual({ sourceRevision: null, reason: 'read-failed' })
    expect(await readEdgeBuild({ origin: 'https://x.invalid', fetch: vi.fn(async () => { throw new TypeError('offline') }) }))
      .toEqual({ sourceRevision: null, reason: 'unreachable' })
    expect(await readEdgeBuild({ origin: undefined })).toEqual({ sourceRevision: null, reason: 'unreachable' })
  })

  it('gives up after its deadline and says unreachable', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    const pending = readEdgeBuild({ origin: 'https://x.invalid', fetch: fetch as unknown as typeof globalThis.fetch })
    await vi.advanceTimersByTimeAsync(SELF_STATE_EDGE_TIMEOUT_MS)
    expect(await pending).toEqual({ sourceRevision: null, reason: 'unreachable' })
  })

  it('an organs argument that is not a list of ids is refused by name', async () => {
    const deps = { origin: undefined, registry: () => madeUp(), readFile: () => { throw new Error('ENOENT') } }
    await expect(readSelfState('organ-a', deps)).rejects.toThrow('SELF_STATE_ORGANS_INVALID')
    await expect(readSelfState([], deps)).rejects.toThrow('SELF_STATE_ORGANS_INVALID')
    await expect(readSelfState([1], deps)).rejects.toThrow('SELF_STATE_ORGANS_INVALID')
  })
})

/** A canonical head with the given organ texts (organ-a and seed-pearl, as the e4 head). */
function headOf(organs: Record<string, string>, epoch = 7): { ball: BallManifest; codeBySha: Record<string, string> } {
  const entries: Record<string, BallEntryRecord> = {}
  const modules: Record<string, BallManifest['modules'][string]> = {}
  for (const [id, code] of Object.entries(organs)) {
    const sha = sha256(code)
    entries[id] = { id, specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
    modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: id, description: 'Synthetic', size: code.length, createdAt: 1000 }
  }
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch, createdAt: 1000, authorPeerId: 'fixture-author', entries, modules }
  const ball: BallManifest = { ...body, ballId: headManifestIdCanon(body) }
  return { ball, codeBySha: Object.fromEntries(Object.values(organs).map(code => [sha256(code), code])) }
}

/** Her edited organ-a: the store file she changed, which is neither organ-a text the heads below run. */
const EDITED_A = 'module.exports = { apply() {} }; // organ-a as she edited it in her store'
const STORE_PATH_A = '/dsh/home/auma/seed/organs/organ-a.js'

/** Boot her runtime over a recorded VFS that already holds her edited store file. */
async function boot(organATextInHead: string) {
  const raw = new MemoryVfs()
  raw.mkdirSync('/dsh/home/auma/seed/organs', { recursive: true })
  raw.writeFileSync(STORE_PATH_A, EDITED_A)
  const recorder = createWriteSetRecorder(raw)
  const m = await mountE4({
    vfs: recorder.vfs as unknown as MemoryVfs,
    head: headOf({ 'organ-a': organATextInHead, 'seed-pearl': PEARL_V1 }),
    buildIdentity: { sourceRevision: REV, sourceDirty: false, builtAt: null, runtimeArtifactSha256: null },
    respond: call => call.method === 'GET' && call.path === '/api/build'
      ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: EDGE_REV }) : null,
  })
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  return { m, raw, recorder }
}

/** Digest over every path, kind and byte. */
function digest(vfs: MemoryVfs): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) { hash.update(`d:${path}\n`); walk(path); continue }
      const data = vfs.readFileSync(path)
      hash.update(`f:${path}:`).update(typeof data === 'string' ? data : Buffer.from(data)).update('\n')
    }
  }
  walk('/')
  return hash.digest('hex')
}

/** A store that records every touch and serves nothing. */
function touchRecorder(name: string, touched: string[]): unknown {
  return new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} touched`) } } })
}

interface Organ {
  id: string
  specifier: string
  sha256Loaded: string | null
  bytes: number | null
  storeSha256: string | null
  matchesStore: boolean | null
  state: string
}

describe('on her mounted runtime', () => {
  it('reports what the loader evaluated, against her store as it is now, and writes, stores and sends nothing else', async () => {
    const { m, raw, recorder } = await boot(ORGAN_A)
    const before = { writes: recorder.inventory().counters.writes, live: liveWriteSet.snapshot().counters.writes,
      digest: digest(raw), calls: m.calls.length }
    const touched: string[] = []
    vi.stubGlobal('indexedDB', touchRecorder('indexedDB', touched))
    vi.stubGlobal('localStorage', touchRecorder('localStorage', touched))
    vi.stubGlobal('sessionStorage', touchRecorder('sessionStorage', touched))
    const answer = await m.tool('x6_self_state').execute({}) as Record<string, unknown>
    // Zero writes: the write-set recorder under her VFS, the runtime's own live recorder, and the bytes themselves.
    expect(recorder.inventory().counters.writes).toBe(before.writes)
    expect(liveWriteSet.snapshot().counters.writes).toBe(before.live)
    expect(digest(raw)).toBe(before.digest)
    expect(touched).toEqual([])
    // Exactly one request: GET /api/build on her own origin.
    expect(m.calls.slice(before.calls).map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/build'])

    expect(answer.runtime).toEqual({ sourceRevision: REV, bootedAtMs: expect.any(Number) as number })
    expect(answer.edge).toEqual({ sourceRevision: EDGE_REV })
    expect(answer.head).toEqual({ ballId: m.head.ball.ballId, epoch: 7, origin: 'host' })
    const organs = answer.organs as Organ[]
    expect(organs.map(organ => organ.id)).toEqual(['organ-a', 'seed-pearl'])
    // organ-a: the loader evaluated the head's text; her store holds her edit, so they differ.
    expect(organs[0]).toMatchObject({ specifier: `ball:${sha256(ORGAN_A)}`, sha256Loaded: sha256(ORGAN_A), bytes: ORGAN_A.length,
      storeSha256: sha256(EDITED_A), matchesStore: false })
    // seed-pearl: its store file was hydrated from the head, so they match.
    expect(organs[1]).toMatchObject({ sha256Loaded: sha256(PEARL_V1), storeSha256: sha256(PEARL_V1), matchesStore: true })
    // Her edited file was put (inert) at boot and is not active.
    expect(answer.staged).toEqual([{ sha256: sha256(EDITED_A), name: 'organ-a' }])
    expect(answer.tools).toContain('x6_self_state')
    expect(answer.tools).toEqual([...(answer.tools as string[])].sort())
    expect(answer.doors).toEqual({ cloudflare: null })
    expect(answer.unknown).toEqual([{ field: 'doors.cloudflare', reason: 'not-recorded' }])
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
  })

  it('sha256Loaded is recorded at evaluation: a later change to the file on disk changes only storeSha256', async () => {
    const { m, raw } = await boot(ORGAN_A)
    const organA = async () => ((await m.tool('x6_self_state').execute({ organs: ['organ-a'] }) as { organs: Organ[] }).organs[0])
    expect(await organA()).toMatchObject({ sha256Loaded: sha256(ORGAN_A), storeSha256: sha256(EDITED_A) })
    // Her store file changes again, and the content-addressed module file is damaged: neither is what was evaluated.
    raw.writeFileSync(STORE_PATH_A, ORGAN_A)
    raw.writeFileSync(`/dsh/home/balls/${sha256(ORGAN_A)}.js`, 'damaged')
    expect(await organA()).toMatchObject({ sha256Loaded: sha256(ORGAN_A), bytes: ORGAN_A.length, storeSha256: sha256(ORGAN_A),
      matchesStore: true })
    raw.unlinkSync(STORE_PATH_A)
    const gone = await m.tool('x6_self_state').execute({ organs: ['organ-a'] }) as { organs: Organ[]; unknown: unknown[] }
    expect(gone.organs[0]).toMatchObject({ sha256Loaded: sha256(ORGAN_A), storeSha256: null, matchesStore: null })
    expect(gone.unknown).toEqual(expect.arrayContaining([{ field: 'organs[organ-a].storeSha256', reason: 'read-failed' },
      { field: 'organs[organ-a].matchesStore', reason: 'read-failed' }]))
  })

  it('sha256Loaded follows the evaluated text: a session running other organ-a text says so, with the store file unchanged', async () => {
    const first = await boot(ORGAN_A)
    const one = (await first.m.tool('x6_self_state').execute({ organs: ['organ-a'] }) as { organs: Organ[] }).organs[0]
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const second = await boot(ORGAN_A2)
    const two = (await second.m.tool('x6_self_state').execute({ organs: ['organ-a'] }) as { organs: Organ[] }).organs[0]
    expect(one?.storeSha256).toBe(sha256(EDITED_A))
    expect(two?.storeSha256).toBe(sha256(EDITED_A))
    expect(one?.sha256Loaded).toBe(sha256(ORGAN_A))
    expect(two?.sha256Loaded).toBe(sha256(ORGAN_A2))
  })

  it('the capability index lists it read-only, and a look-only voice turn may call it', async () => {
    const { m } = await boot(ORGAN_A)
    const index = await m.tool('x6_capability_index').execute({ action: 'lookup', name: 'x6_self_state' }) as { ok: boolean; tool: { readOnly: boolean; mutating: boolean } }
    expect(index).toMatchObject({ ok: true, tool: { readOnly: true, mutating: false } })
    expect(voiceVerdict({ tool: 'x6_self_state', args: {}, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_self_state', args: { organs: ['organ-a'] }, origin: { kind: 'builtin' } })).toBeUndefined()
    // Only as her own built-in: a preset or organ tool of that name is not her read.
    expect(voiceVerdict({ tool: 'x6_self_state', args: {}, origin: { kind: 'preset' } })).toContain('VOICE_LOOK_ONLY')
  })

  it('a Cloudflare door status she read is reported as level and configured, never more', async () => {
    const door = await mountE4({ respond: call => call.path === '/_host/cloudflare'
      ? Response.json({ ok: true, action: 'status', level: 'open', brokerConfigured: true, accountConfigured: true, authKind: 'api-key', whoami: 'x' })
      : call.path === '/api/build' ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null }) : null })
    expect((await door.tool('x6_self_state').execute({}) as { doors: unknown }).doors).toEqual({ cloudflare: null })
    await door.tool('x6_cloudflare').execute({ action: 'status' })
    const after = await door.tool('x6_self_state').execute({}) as { doors: unknown; unknown: unknown[] }
    expect(after.doors).toEqual({ cloudflare: { level: 'open', configured: true } })
    expect(JSON.stringify(after)).not.toContain('api-key')
    expect(after.unknown).not.toContainEqual(expect.objectContaining({ field: 'doors.cloudflare' }))
  })
})

describe('a full shelf still shows in her self-state', () => {
  const hex = (n: number): string => createHash('sha256').update(String(n)).digest('hex')
  it('takes 128 kept forged cells (was 64) and 256 kept skills (was 64), at least the shelves she may keep; one more is not that shape', () => {
    expect([FORGED_CELLS_MAX, SKILLS_MAX]).toEqual([128, 256])
    const cells = (count: number) => Array.from({ length: count }, (_v, n) => ({ name: `cell-${String(n)}`, sha256: hex(n), bytes: 10 }))
    const skills = (count: number) => Array.from({ length: count }, (_v, n) => ({ name: `skill-${String(n)}`, id: hex(n) }))
    expect(forgedCellsView(cells(FORGED_CELLS_MAX))).toHaveLength(128)
    expect(forgedCellsView(cells(FORGED_CELLS_MAX + 1))).toBeNull()
    expect(keptSkillsView(skills(SKILLS_MAX))).toHaveLength(256)
    expect(keptSkillsView(skills(SKILLS_MAX + 1))).toBeNull()
  })
})
