// @vitest-environment jsdom
/**
 * The portable recovery snapshot on the Continuity screen: one JSON file made of what the host answers on four read
 * routes, each part with the SHA-256 of the exact bytes, and a manifest digest over the parts.
 *
 * The builder is tested as pure functions against digests worked out here with WebCrypto and node's own hash. The
 * surface test mounts the real Continuity screen over a stubbed `fetch`, presses the button, and reads the file the page
 * handed to the browser's download (the object URL and the anchor's click are the only things stubbed).
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import { CONTINUITY_SURFACE, ContinuitySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import {
  buildRecoverySnapshot, captureRecoverySnapshot, fetchRecoveryPart, missingPart, RECOVERY_NOTE, RECOVERY_PART_MAX_BYTES, RECOVERY_ROUTES,
  RECOVERY_SCHEMA, recoveryFileName, recoveryManifestSha256, recoveryMaxBytesFor, recoveryPartOf, recoveryStateOf, recoveryWords,
  type RecoveryPart, type RecoverySnapshot,
} from '../src/client/spatial/portal/recovery-snapshot.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
/** The blobs the page handed to the browser's download, and the name each anchor carried. */
const handed: { blob: Blob; name: string }[] = []
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  handed.length = 0
  // jsdom has no object URLs and cannot follow a download: these two are the browser's part, stubbed.
  let pending: Blob | null = null
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { pending = blob; return 'blob:test' } })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    if (pending !== null) handed.push({ blob: pending, name: this.download })
    pending = null
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const subtleHex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const nodeHex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal
const NOW = Date.UTC(2026, 10, 11, 23, 59, 30)

describe('The recovery snapshot builder', () => {
  it('a part carries the SHA-256 of the exact bytes, their length, and the body parsed when it is JSON', async () => {
    // Spacing and key order as a host might send them: the digest is of THESE bytes, not of a re-serialised body.
    const text = '{ "ok": true,\n  "head": {"epoch": 168, "ballId": "aa"} }'
    const bytes = bytesOf(text)
    const part = await recoveryPartOf('/_head/ball', 200, 'application/json; charset=utf-8', bytes)
    expect(part).toEqual({ route: '/_head/ball', status: 200, ok: true, sha256: await subtleHex(bytes), bytes: bytes.length,
      contentType: 'application/json; charset=utf-8', encoding: 'json', body: { ok: true, head: { epoch: 168, ballId: 'aa' } } })
    expect(part.sha256).toBe(nodeHex(bytes))
    expect(part.sha256).not.toBe(nodeHex(JSON.stringify(JSON.parse(text))))
  })

  it('an answer that is not JSON, or says JSON and is not, is kept as base64 of the exact bytes', async () => {
    const raw = Uint8Array.from({ length: 70_000 }, (_unused, index) => (index * 31) % 256)
    const binary = await recoveryPartOf('/_mirror/export', 200, 'application/octet-stream', raw)
    if (!binary.ok) throw new Error('not captured')
    expect(binary.encoding).toBe('base64')
    expect(Buffer.from(binary.body as string, 'base64').equals(Buffer.from(raw))).toBe(true)
    expect(binary.sha256).toBe(await subtleHex(raw))
    expect(binary.bytes).toBe(70_000)
    // The host said JSON and it does not parse (the edge cuts a mirror stream short on purpose): NOT captured, no body.
    const broken = await recoveryPartOf('/__x6/facts', 200, 'application/json', bytesOf('<html>not json'))
    expect(broken).toMatchObject({ ok: false, sha256: null, bytes: null })
    expect('body' in broken).toBe(false)
    const cut = await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf('{"files":[{"path":"a","data":"AAAA'))
    expect(cut).toMatchObject({ ok: false, reason: 'said JSON but does not parse (cut short, or not JSON)' })
    const pearl = await recoveryPartOf('/_head/ball', 200, 'application/json', bytesOf('{"ok":true,"head":{"epoch":168}}'))
    expect((await buildRecoverySnapshot([pearl, cut], 'https://node.example.invalid', 1_000, 400)).complete).toBe(false)
    const whole = await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf('{"files":[]}'))
    const full = await buildRecoverySnapshot([pearl, whole], 'https://node.example.invalid', 1_000, 400)
    expect([full.complete, full.startedAt, full.createdAt]).toEqual([true, '1970-01-01T00:00:00.400Z', '1970-01-01T00:00:01.000Z'])
    // The mirror may weigh what the edge may serve for it (96 MiB); every other part stays at 64 MiB.
    expect([recoveryMaxBytesFor('/_mirror/export'), recoveryMaxBytesFor('/_head/ball')]).toEqual([96 * 1024 * 1024, 64 * 1024 * 1024])
    const untyped = await recoveryPartOf('/__x6/facts', 200, null, bytesOf('{"a":1}'))
    expect(untyped).toMatchObject({ ok: true, encoding: 'base64', contentType: null })
  })

  it('the manifest digest is the SHA-256 of the canonical [route, sha256, bytes] list: stable, and moved by any part', async () => {
    const ball = await recoveryPartOf('/_head/ball', 200, 'application/json', bytesOf('{"head":{"epoch":7}}'))
    const gone = missingPart('/_host/estate', 404, 'answered 404')
    const mirror = await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf('{"entries":[]}'))
    const parts = [ball, gone, mirror]
    const expected = nodeHex(canonicalJson([['/_head/ball', ball.sha256, ball.bytes], ['/_host/estate', null, null],
      ['/_mirror/export', mirror.sha256, mirror.bytes]]))
    expect(await recoveryManifestSha256(parts)).toBe(expected)
    expect(await recoveryManifestSha256(structuredClone(parts))).toBe(expected)
    const built = await buildRecoverySnapshot(parts, 'https://node.example.invalid', NOW)
    expect(built.manifestSha256).toBe(expected)
    // The body is not what the manifest covers (the part's own sha256 covers the bytes); a changed digest, length, route or
    // order moves it, and so does dropping a part that was not captured.
    const other = await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf('{"entries":[1]}'))
    for (const changed of [[ball, gone, other], [mirror, gone, ball], [ball, mirror], [ball, { ...gone, route: '/x' }, mirror]]) {
      expect(await recoveryManifestSha256(changed)).not.toBe(expected)
    }
  })

  it('the file names its epoch from the Pearl part it holds and its UTC date, and says what it is and is not', async () => {
    expect(recoveryFileName('168', NOW)).toBe('auma-recovery-epoch-168-2026-11-11.json')
    expect(recoveryFileName(163, Date.UTC(2027, 0, 1, 0, 0, 1))).toBe('auma-recovery-epoch-163-2027-01-01.json')
    for (const bad of [null, '', '../x', '6 8', '-1', '1e3']) expect(recoveryFileName(bad, NOW)).toBe('auma-recovery-epoch-unknown-2026-11-11.json')
    const ball = await recoveryPartOf('/_head/ball', 200, 'application/json', bytesOf('{"ok":true,"head":{"epoch":168}}'))
    const mirror = await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf('{"entries":[]}'))
    const whole = await buildRecoverySnapshot([ball, mirror], 'https://node.example.invalid', NOW)
    expect(whole).toMatchObject({ schema: 'aukora.recovery-snapshot.v1', createdAt: '2026-11-11T23:59:30.000Z', origin: 'https://node.example.invalid',
      epoch: '168', complete: true, note: RECOVERY_NOTE })
    expect(RECOVERY_SCHEMA).toBe('aukora.recovery-snapshot.v1')
    expect(Object.keys(whole).sort()).toEqual(['complete', 'createdAt', 'epoch', 'manifestSha256', 'note', 'origin', 'parts', 'schema', 'startedAt'])
    expect(RECOVERY_NOTE).toContain('No restore from this file has been tested')
    // Without the Pearl part the epoch is not guessed, and the file is not complete; the same without the mirror.
    const noBall = await buildRecoverySnapshot([missingPart('/_head/ball', 401, 'answered 401'), mirror], 'https://node.example.invalid', NOW)
    expect([noBall.epoch, noBall.complete]).toEqual(['unknown', false])
    expect((await buildRecoverySnapshot([ball, missingPart('/_mirror/export', 404, 'answered 404')], 'o', NOW)).complete).toBe(false)
    // A Pearl answer that names no epoch (or a hostile one) reads as unknown.
    const odd = await recoveryPartOf('/_head/ball', 200, 'application/json', bytesOf('{"head":{"epoch":"../../etc"}}'))
    expect((await buildRecoverySnapshot([odd, mirror], 'o', NOW)).epoch).toBe('unknown')
  })

  it('a part that did not answer 2xx is recorded with its status, ok false and NO body, and its refusal body is not read', async () => {
    const secret = 'refusal-body-that-must-not-be-kept'
    const refused = new Response(JSON.stringify({ ok: false, code: 'OWNER_ACCESS_REQUIRED', detail: secret }), { status: 401,
      headers: { 'content-type': 'application/json' } })
    const part = await fetchRecoveryPart('/_host/estate', signal(), { fetchImpl: async () => refused })
    expect(part).toEqual({ route: '/_host/estate', status: 401, ok: false, sha256: null, bytes: null, contentType: null, reason: 'answered 401' })
    expect(Object.hasOwn(part, 'body')).toBe(false)
    expect(JSON.stringify(part)).not.toContain(secret)
    // A host that does not answer at all has no status.
    const silent = await fetchRecoveryPart('/_head/ball', signal(), { fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
    expect(silent).toEqual({ route: '/_head/ball', status: null, ok: false, sha256: null, bytes: null, contentType: null, reason: 'did not answer' })
    // An aborted read is not a missing part: it throws, so no file is made from a closed read.
    const stopped = new AbortController()
    stopped.abort()
    await expect(fetchRecoveryPart('/_head/ball', stopped.signal, { fetchImpl: async () => { throw new DOMException('aborted', 'AbortError') } }))
      .rejects.toThrow('aborted')
  })

  it('a part over the bound is refused with a plain reason, whether the host declares its size or not; the bound is 64 MiB', async () => {
    expect(RECOVERY_PART_MAX_BYTES).toBe(64 * 1024 * 1024)
    const big = bytesOf(JSON.stringify({ entries: 'x'.repeat(4096) }))
    expect(await recoveryPartOf('/_mirror/export', 200, 'application/json', big, 1024)).toEqual({ route: '/_mirror/export', status: 200,
      ok: false, sha256: null, bytes: null, contentType: null, reason: 'over 0 MiB' })
    expect(await recoveryPartOf('/_mirror/export', 200, 'application/json', new Uint8Array(RECOVERY_PART_MAX_BYTES + 1)))
      .toMatchObject({ ok: false, reason: 'over 64 MiB' })
    // Declared too large: refused from the header, the body never read.
    let pulled = 0
    const stream = () => new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(600)) } })
    const declared = new Response(stream(), { headers: { 'content-type': 'application/json', 'content-length': '999999' } })
    expect(await fetchRecoveryPart('/_mirror/export', signal(), { fetchImpl: async () => declared, maxBytes: 1024 }))
      .toMatchObject({ ok: false, status: 200, reason: 'over 0 MiB' })
    const pulledForDeclared = pulled
    // Not declared (an endless stream): the read stops once it is over the bound.
    pulled = 0
    const endless = new Response(stream(), { headers: { 'content-type': 'application/json' } })
    const part = await fetchRecoveryPart('/_mirror/export', signal(), { fetchImpl: async () => endless, maxBytes: 1024 })
    expect(part).toMatchObject({ ok: false, status: 200, reason: 'over 0 MiB' })
    expect(Object.hasOwn(part, 'body')).toBe(false)
    expect(pulledForDeclared).toBeLessThanOrEqual(2)
    expect(pulled).toBeLessThan(10)
    // Exactly at the bound it is kept.
    expect(await fetchRecoveryPart('/x', signal(), { fetchImpl: async () => new Response(new Uint8Array(1024)), maxBytes: 1024 }))
      .toMatchObject({ ok: true, bytes: 1024 })
  })

  it('a capture reads the four routes once each, same-origin and uncached, and puts nothing in the file but their bodies', async () => {
    const answers: Record<string, () => Response> = {
      '/_head/ball': () => json({ ok: true, head: { epoch: 168, ballId: 'aa'.repeat(32) }, modules: {} }),
      '/__x6/facts': () => json({ ok: true, receiptTotal: 120 }),
      '/_host/estate': () => new Response(JSON.stringify({ ok: true, schema: 'aukora.edge-estate.v1' }), { headers: {
        'content-type': 'application/json', 'set-cookie': 'CF_Authorization=cookie-value', 'x-secret-header': 'header-value' } }),
      '/_mirror/export': () => json({ ok: true, format: 'x61-mirror-snapshot/v2', entries: [{ path: '/dsh/home/a', text: 'hello' }] }),
    }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      (typeof input === 'string' ? answers[input]?.() : undefined) ?? new Response('nope', { status: 404 }))
    const seen: string[] = []
    const capture = await captureRecoverySnapshot(signal(), { fetchImpl, origin: 'https://node.example.invalid', now: () => NOW,
      onRoute: (route) => { seen.push(route) } })
    expect(fetchImpl.mock.calls.map(([route]) => route)).toEqual([...RECOVERY_ROUTES])
    expect(seen).toEqual([...RECOVERY_ROUTES])
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
      expect(Object.keys(init ?? {}).sort()).toEqual(['cache', 'credentials', 'signal'])
    }
    expect(capture.name).toBe('auma-recovery-epoch-168-2026-11-11.json')
    const file = JSON.parse(capture.json) as RecoverySnapshot
    expect(file).toEqual(capture.snapshot)
    expect(file.parts.map(part => [part.route, part.status, part.ok])).toEqual(RECOVERY_ROUTES.map(route => [route, 200, true]))
    expect(file.complete).toBe(true)
    for (const part of file.parts) {
      if (!part.ok) throw new Error('not captured')
      const sent = await answers[part.route]?.().arrayBuffer() ?? new ArrayBuffer(0)
      expect(part.sha256).toBe(await subtleHex(new Uint8Array(sent)))
      expect(part.bytes).toBe(sent.byteLength)
      expect(part.body).toEqual(JSON.parse(new TextDecoder().decode(sent)))
      expect(Object.keys(part).sort()).toEqual(['body', 'bytes', 'contentType', 'encoding', 'ok', 'route', 'sha256', 'status'])
    }
    expect(file.manifestSha256).toBe(nodeHex(canonicalJson(file.parts.map(part => [part.route, part.sha256, part.bytes]))))
    // No cookie and no header but each part's content type.
    expect(capture.json).not.toMatch(/cookie-value|header-value|set-cookie|CF_Authorization/u)
  })

  it('the words say exactly which parts are in the file and which are not, and never that it was saved or restorable', async () => {
    const ok = async (route: string) => recoveryPartOf(route, 200, 'application/json', bytesOf('{"head":{"epoch":168}}'))
    const all = await Promise.all(RECOVERY_ROUTES.map(ok))
    const name = 'auma-recovery-epoch-168-2026-11-11.json'
    expect(recoveryWords({ kind: 'saved', name, bytes: 2_097_152, parts: all })).toBe(`Handed ${name} (2.0 MB) to this browser’s download; `
      + 'this page cannot see whether it was saved. No restore from this file has been tested. '
      + 'Captured all 4 parts: /_head/ball, /__x6/facts, /_host/estate, /_mirror/export.')
    const noEstate = [all[0], all[1], missingPart('/_host/estate', 404, 'answered 404'), all[3]] as RecoveryPart[]
    expect(recoveryWords({ kind: 'saved', name, bytes: 1, parts: noEstate }))
      .toContain('Captured: /_head/ball, /__x6/facts, /_mirror/export. NOT captured: /_host/estate (answered 404).')
    const noMirror = [all[0], all[1], all[2], missingPart('/_mirror/export', 200, 'over 64 MiB')] as RecoveryPart[]
    const words = recoveryWords({ kind: 'incomplete', name, bytes: 1, parts: noMirror })
    expect(words.startsWith('INCOMPLETE. NOT captured: /_mirror/export (over 64 MiB). Captured: /_head/ball, /__x6/facts, /_host/estate. '))
      .toBe(true)
    expect(words).toContain('to this browser’s download all the same, so what was read is not lost')
    expect(words).toContain('No restore from this file has been tested.')
    expect(recoveryWords({ kind: 'reading', route: '/_mirror/export' })).toBe('Reading /_mirror/export from this host…')
    // The state a capture leaves: complete, incomplete, or (nothing captured at all) failed with every reason named.
    const state = async (parts: RecoveryPart[]) => recoveryStateOf({ snapshot: await buildRecoverySnapshot(parts, 'o', NOW), name, json: '' }, 1)
    expect((await state(all)).kind).toBe('saved')
    expect((await state(noEstate)).kind).toBe('saved')
    expect((await state(noMirror)).kind).toBe('incomplete')
    const none = await state(RECOVERY_ROUTES.map(route => missingPart(route, 401, 'answered 401')))
    expect(none).toEqual({ kind: 'failed', reason: 'no part was captured: /_head/ball (answered 401), /__x6/facts (answered 401), '
      + '/_host/estate (answered 401), /_mirror/export (answered 401)' })
    expect(recoveryWords(none)).toMatch(/^Not saved: no part was captured/u)
  })
})

// ── The button on the real Continuity screen ───────────────────────────────────────────────────────────────────────────

const HEAD = '7c01cb98514e4ae7a6aaa0dc29653282d94bc4717b85a18968b47aa4310120a8'
const BALL = { ok: true, buildSha: 'c'.repeat(40), head: { ballId: HEAD, parentBallId: 'aa'.repeat(32), epoch: 162, entries: {} }, modules: { x: {} }, peers: [] }
const FACTS = { ok: true, runtime: 'cloudflare', epoch: 162, ballId: HEAD, receiptTotal: 120, receiptsVerified: 120, evidenceStatus: 'complete' }
const ESTATE = { ok: true, schema: 'aukora.edge-estate.v1', head: { epoch: 162 }, mirror: { entryCount: 2 } }
const MIRROR = { ok: true, format: 'x61-mirror-snapshot/v2', entries: [{ path: '/dsh/home/notes.md', text: 'she remembers' }] }
/** The edge as the Continuity screen reads it, with the four recovery routes; every call is kept with its init. */
const host = (overrides: Record<string, () => Response> = {}) => vi.fn(async (input: string, _init?: RequestInit) => {
  if (Object.hasOwn(overrides, input)) return (overrides[input] as () => Response)()
  if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
  if (input === '/__x6/facts') return json(FACTS)
  if (input === '/_head/ball') return json(BALL)
  if (input === '/_host/estate') return json(ESTATE)
  if (input === '/_mirror/export') return json(MIRROR)
  if (input === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
  if (input === '/_head/lease') return json({ ok: true, lease: null, ballId: HEAD, epoch: 162 })
  return new Response('nope', { status: 404 })
})
const mount = () => {
  const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: CONTINUITY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
  } as unknown as Parameters<typeof ContinuitySurface>[0]
  return render(<ContinuitySurface {...props} />)
}
/** Open the Published Pearl card and press the recovery button; returns how many requests had been made before the press. */
const pressRecovery = async (container: HTMLElement, fetch: ReturnType<typeof host>): Promise<number> => {
  const card = container.querySelector('[data-sovereignty-portal="head"]')
  await waitFor(() => { expect(card?.textContent).toContain('Pearl 162') }, { timeout: 10_000 })
  fireEvent.click(card?.querySelector('button') as Element)
  const button = card?.querySelector<HTMLButtonElement>('[data-continuity-recovery]')
  expect(button?.textContent).toBe('Download Portable Recovery Snapshot')
  expect(button?.getAttribute('data-continuity-recovery-state')).toBe('idle')
  expect(card?.querySelector('[data-continuity-recovery-words]')).toBeNull()
  // The existing mirror download stays beside it.
  expect(card?.querySelector('[data-sovereignty-snapshot]')).not.toBeNull()
  const before = fetch.mock.calls.length
  fireEvent.click(button as HTMLButtonElement)
  return before
}
const stateOf = (container: HTMLElement): string | null =>
  container.querySelector('[data-continuity-recovery]')?.getAttribute('data-continuity-recovery-state') ?? null
const wordsOf = (container: HTMLElement): string => container.querySelector('[data-continuity-recovery-words]')?.textContent ?? ''

describe('Continuity: Download Portable Recovery Snapshot', () => {
  it('one press reads the four routes once each and hands over one file with every part, its digests and the manifest', async () => {
    const fetch = host()
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    const before = await pressRecovery(container, fetch)
    await waitFor(() => { expect(stateOf(container)).toBe('saved') }, { timeout: 10_000 })
    // The four routes, once each, in order, with the page's own cookie and never from a cache; nothing else was asked.
    const asked = fetch.mock.calls.slice(before).filter(([route]) => (RECOVERY_ROUTES as readonly string[]).includes(route))
    expect(asked.map(([route]) => route)).toEqual([...RECOVERY_ROUTES])
    for (const [, init] of asked) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(fetch.mock.calls.filter(([route]) => route === '/_mirror/export')).toHaveLength(1)
    // One file, named for the epoch the Pearl answer carried and today's UTC date.
    expect(handed).toHaveLength(1)
    const file = JSON.parse(await handed[0]?.blob.text() ?? '') as RecoverySnapshot
    expect(handed[0]?.name).toBe(`auma-recovery-epoch-162-${file.createdAt.slice(0, 10)}.json`)
    expect(handed[0]?.name).toMatch(/^auma-recovery-epoch-162-\d{4}-\d{2}-\d{2}\.json$/u)
    expect(Math.abs(Date.parse(file.createdAt) - Date.now())).toBeLessThan(60_000)
    expect(file).toMatchObject({ schema: 'aukora.recovery-snapshot.v1', origin: globalThis.location.origin, epoch: '162', complete: true })
    const bodies: Record<string, unknown> = { '/_head/ball': BALL, '/__x6/facts': FACTS, '/_host/estate': ESTATE, '/_mirror/export': MIRROR }
    for (const part of file.parts) {
      const sent = bytesOf(JSON.stringify(bodies[part.route]))
      expect(part).toEqual({ route: part.route, status: 200, ok: true, sha256: await subtleHex(sent), bytes: sent.length,
        contentType: 'application/json', encoding: 'json', body: bodies[part.route] })
    }
    expect(file.parts.map(part => part.route)).toEqual([...RECOVERY_ROUTES])
    expect(file.manifestSha256).toBe(nodeHex(canonicalJson(file.parts.map(part => [part.route, part.sha256, part.bytes]))))
    // The line says what is in the file, that it was only handed over, and that no restore was tested.
    const words = wordsOf(container)
    expect(words).toContain(`Handed ${handed[0]?.name ?? ''} (`)
    expect(words).toContain('this page cannot see whether it was saved')
    expect(words).toContain('Captured all 4 parts: /_head/ball, /__x6/facts, /_host/estate, /_mirror/export.')
    expect(words).toContain('No restore from this file has been tested.')
    expect(words).not.toMatch(/INCOMPLETE|NOT captured/u)
    expect(container.querySelector<HTMLButtonElement>('[data-continuity-recovery]')?.disabled).toBe(false)
  }, 30_000)

  it('a host without the mirror export still hands over what it read, and says INCOMPLETE and exactly what is missing', async () => {
    // The Mac host today (SOURCE: server/local-host.mjs has no /_mirror/export and no /_host/estate).
    const fetch = host({ '/_mirror/export': () => new Response('nope', { status: 404 }),
      '/_host/estate': () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED', hint: 'refusal-detail' }, 403) })
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    const before = await pressRecovery(container, fetch)
    await waitFor(() => { expect(stateOf(container)).toBe('incomplete') }, { timeout: 10_000 })
    const routes: readonly string[] = RECOVERY_ROUTES
    const asked = fetch.mock.calls.slice(before).map(([route]) => route).filter(route => routes.includes(route))
    expect(asked).toEqual([...RECOVERY_ROUTES])
    expect(handed).toHaveLength(1)
    const text = await handed[0]?.blob.text() ?? ''
    const file = JSON.parse(text) as RecoverySnapshot
    expect(file.complete).toBe(false)
    expect(file.parts.map(part => [part.route, part.status, part.ok])).toEqual([['/_head/ball', 200, true], ['/__x6/facts', 200, true],
      ['/_host/estate', 403, false], ['/_mirror/export', 404, false]])
    for (const part of file.parts.filter(candidate => !candidate.ok)) expect(Object.hasOwn(part, 'body')).toBe(false)
    expect(text).not.toContain('refusal-detail')
    expect(wordsOf(container)).toMatch(new RegExp('^INCOMPLETE\\. NOT captured: /_host/estate \\(answered 403\\), /_mirror/export \\(answered 404\\)\\. '
      + 'Captured: /_head/ball, /__x6/facts\\. Handed auma-recovery-epoch-162-\\d{4}-\\d{2}-\\d{2}\\.json \\(', 'u'))
    expect(wordsOf(container)).toContain('so what was read is not lost')
  }, 30_000)

  it('when no part answers nothing is handed over, and the line says so with each reason', async () => {
    const refuse = () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
    const answers = { '/_head/ball': json(BALL) }
    // The card opens on a Pearl that read; then the host signs the page out before the press.
    let signedOut = false
    const fetch = vi.fn(async (input: string, _init?: RequestInit) => (signedOut ? refuse()
      : input === '/_head/ball' ? answers['/_head/ball'].clone() : new Response('nope', { status: 404 })))
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    const card = container.querySelector('[data-sovereignty-portal="head"]')
    await waitFor(() => { expect(card?.textContent).toContain('Pearl 162') }, { timeout: 10_000 })
    fireEvent.click(card?.querySelector('button') as Element)
    signedOut = true
    fireEvent.click(card?.querySelector('[data-continuity-recovery]') as HTMLButtonElement)
    await waitFor(() => { expect(stateOf(container)).toBe('failed') }, { timeout: 10_000 })
    expect(handed).toHaveLength(0)
    expect(wordsOf(container)).toBe('Not saved: no part was captured: /_head/ball (answered 401), /__x6/facts (answered 401), '
      + '/_host/estate (answered 401), /_mirror/export (answered 401)')
  }, 30_000)
})
