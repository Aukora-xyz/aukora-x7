// @vitest-environment jsdom
/**
 * every staged Pearl is shown and counted exactly as before, with ONE exception: HEAD's own
 * promotion-status answer, the same answer the card is read from, names that exact Pearl as published (HEAD or one of its
 * 8 ancestors, `publishedBallIds`). Then it is not waiting, and one plain line says "already published as epoch N".
 *
 * The case: a staged file still held the published Epoch 171 while HEAD stood at Epoch 172, and the page counted
 * "1 WAITING FOR TOUCH ID" and raised the corner card. Here the same shape: Epoch 170 → 171 → 172, body-map changed at
 * each step, the file holding 171. Then every reproduction from the reviews, each proving the card IS shown and counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  candidateDigestOf, headPromotionBinding, parseHeadStaged, parseStagedPromotion, STAGED_PROMOTION_PATH, type HeadStagedRead,
  type StagedPromotion,
} from '../src/client/spatial/aumlok/head-promotion.ts'
import { readWaitingApprovals } from '../src/client/spatial/portal/FingerprintWaiting.tsx'
import { publishedPearlOf } from '../src/client/spatial/portal/promotion-sources.ts'
import { SOVEREIGNTY_SURFACE, SovereigntySurface, type PromotionState } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket {
  static open: FakeSocket[] = []
  onopen = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose = null
  closed = false
  constructor() { FakeSocket.open.push(this) }
  close() { this.closed = true }
}
/** A live message from the host, as its socket pushes it (it starts the page's quiet background read). */
const push = (message: unknown) => {
  for (const socket of FakeSocket.open.filter(open => !open.closed)) socket.onmessage?.({ data: JSON.stringify(message) })
}
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
// HEAD's own canonical JSON, from this checkout: the Pearl ids below are HEAD's canonical ids.
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as {
  canonicalJson: (value: unknown) => string
}
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id,
    { id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] }]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  return { ...contents, ballId: sha(transition.canonicalJson(contents)) }
}
type Ball = ReturnType<typeof ballOf>
const V70 = { 'auma-body-map': codeOf('auma-body-map', 170), 'auma-notes': codeOf('auma-notes', 1) }
const E70 = ballOf(null, 170, V70)
const V71 = { ...V70, 'auma-body-map': codeOf('auma-body-map', 171) }
const E71 = ballOf(E70.ballId, 171, V71)
const V72 = { ...V70, 'auma-body-map': codeOf('auma-body-map', 172) }
const E72 = ballOf(E71.ballId, 172, V72)
// A fork: another Epoch 171 on Epoch 170 (equal epoch, a different Pearl), never published.
const V71B = { ...V70, 'auma-body-map': codeOf('auma-body-map', 7100) }
const E71B = ballOf(E70.ballId, 171, V71B)
// The Pearl she would stage next on today's HEAD.
const V73 = { ...V72, 'auma-body-map': codeOf('auma-body-map', 173) }
const E73 = ballOf(E72.ballId, 173, V73)
const V74 = { ...V73, 'auma-body-map': codeOf('auma-body-map', 174) }
const E74 = ballOf(E73.ballId, 174, V74)
// After a restoration to Epoch 170: a valid next Epoch 171 that runs body-map's Epoch 172 code (review 3, the fourth case).
const E71R = ballOf(E70.ballId, 171, V72)

const fileOf = (ball: Ball, codes: Record<string, string>, parent: Ball) => JSON.stringify({
  schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 12, 0), body: { ball,
    codeBySha: { [sha(codes['auma-body-map'] ?? '')]: codes['auma-body-map'] }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch } })
const stagedOf = (text: string): StagedPromotion => {
  const staged = parseStagedPromotion(text)
  if (staged === null) throw new Error('not a staged promotion')
  return staged
}
const LEFTOVER = fileOf(E71, V71, E70)
// Her stager rewrote the file's entries and code but left published Epoch 171's id on it.
const FORGED_E71 = fileOf({ ...E71B, ballId: E71.ballId }, V71B, E70)
/** HEAD's chain as the edge names it (`publishedBallIds`), newest first. */
const chainOf = (...balls: Ball[]) => balls.map(ball => ball.ballId)
const E72_CHAIN = chainOf(E72, E71, E70)
/** HEAD's selected Pearl as the classification's lease read names it in the same round. */
const AT_E72 = { ballId: E72.ballId }

/** HEAD's record of `ball` staged on `parent`, as head-do.mjs `readStaged` serves it (one governance organ, body-map). */
const heldRecordOf = async (ball: Ball, parent: Ball, codes: Record<string, string>) => {
  const fields = { ballId: ball.ballId, epoch: ball.epoch, parentBallId: parent.ballId, changedEntries: ['auma-body-map'], t2Reasons: ['T2_PROTECTED_ORGAN'] }
  const binding = await headPromotionBinding({ audience: globalThis.location.origin, ball, entryId: 'auma-body-map', previous: parent.entries })
  const code = codes['auma-body-map'] ?? ''
  return { schema: 'aukora.staged-head-promotion.v1', ...fields, authorPeerId: 'auma-writer', tier: 'T2', governanceClass: 3, binding,
    candidateDigest: await candidateDigestOf(fields), compactModuleShas: [sha(code)], stagedAt: Date.UTC(2026, 10, 12, 1),
    state: 'awaiting_owner', stagedForOwner: true,
    envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 12, 1), body: { ball,
      codeBySha: { [sha(code)]: code }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch } } }
}
/** HEAD's promotion-status answer: HEAD at `head`, holding `staged` (or none), naming `chain` as published (absent: none). */
const statusOf = (head: Ball, staged: unknown, chain?: readonly string[]) => json({ ok: true, lease: null, ballId: head.ballId,
  epoch: head.epoch, staged, supersededStaged: null, lastPublishOutcome: null, peers: [],
  ...(chain === undefined ? {} : { publishedBallIds: chain }) })
/** The path a page's request names. */
const pathOf = (request: string | URL | Request) => (typeof request === 'string' ? request : request instanceof URL ? request.pathname
  : new URL(request.url).pathname)
/**
 * The page's host: `/_head/ball` serves `head` (what the page reads when it opens), `/_head/lease` names `lease` (or fails),
 * `/_head/promotion-status` answers whatever `status()` says at the moment it is asked.
 */
const hostFetch = (input: { head: Ball; lease: Ball | 'fail'; status: () => Response | Promise<Response> }) =>
  vi.fn(async (request: string | URL | Request) => {
    const path = pathOf(request)
    if (path === '/_head/promotion-status') return input.status()
    if (path === '/_head/lease') {
      return input.lease === 'fail' ? json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503)
        : json({ ok: true, lease: null, ballId: input.lease.ballId, epoch: input.lease.epoch, governancePromotion: true,
          governancePromotionRequirements: { canonicalManifest: true, unchangedOtherEntries: true } })
    }
    if (path === '/_head/ball') return json({ ok: true, buildSha: 'b'.repeat(40), head: input.head, modules: {}, peers: [] })
    if (path === '/_host/aumlok/status') {
      return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
    }
    if (path === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
    return new Response('nope', { status: 404 })
  })
/** Her home: the staged file holds `text` (null: none), or the read fails while `failing` is set. */
const homeReader = (text: string | null) => {
  const home = { text, failing: false, reads: 0 }
  return Object.assign(home, {
    whole: async (_session: unknown, path: string): Promise<FileRead> => {
      if (path === STAGED_PROMOTION_PATH) home.reads += 1
      if (home.failing) return { ok: false, reason: 'unavailable' } as unknown as FileRead
      return path === STAGED_PROMOTION_PATH && home.text !== null ? { ok: true, text: home.text } : { ok: false, reason: 'not-found' }
    },
  })
}
const mount = (reader: ReturnType<typeof homeReader>) => {
  const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
    phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader,
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  const { container } = render(<SovereigntySurface {...props} />)
  return {
    container,
    card: () => container.querySelector('[data-sovereignty-portal="promotion"]'),
    line: () => container.querySelector('[data-sovereignty-published-pearl]'),
    text: () => container.textContent,
  }
}
const homeOf = (reader: ReturnType<typeof homeReader>) => ({ reader, sessionId: 's1' as SessionId }) as unknown as
  Parameters<typeof readWaitingApprovals>[3]
const corner = (fetchImpl: ReturnType<typeof hostFetch>, reader: ReturnType<typeof homeReader>) =>
  readWaitingApprovals(new AbortController().signal, fetchImpl, Date.now, homeOf(reader))
const statusCalls = (fetchImpl: ReturnType<typeof hostFetch>) => fetchImpl.mock.calls
  .filter(([request]) => pathOf(request) === '/_head/promotion-status').length

describe('HEAD names what is published, and the page reads it whole or not at all', () => {
  it('parses `publishedBallIds` only as HEAD sends it; anything else is no word at all', async () => {
    const none = (chain: unknown) => parseHeadStaged({ ok: true, staged: null, supersededStaged: null, publishedBallIds: chain })
    expect(await none(E72_CHAIN)).toEqual({ kind: 'none', superseded: null, publishedBallIds: E72_CHAIN })
    // An older edge sends no list: the read is exactly what it was before.
    expect(await parseHeadStaged({ ok: true, staged: null, supersededStaged: null })).toEqual({ kind: 'none', superseded: null })
    for (const bad of [[...E72_CHAIN, 'nope'], [], 'list', Array.from({ length: 10 }, () => E70.ballId), [42]]) {
      expect(await none(bad)).toEqual({ kind: 'none', superseded: null })
    }
    const record = await heldRecordOf(E73, E72, V73)
    expect(await parseHeadStaged({ ok: true, staged: record, supersededStaged: null, publishedBallIds: E72_CHAIN }))
      .toMatchObject({ kind: 'staged', record: { ballId: E73.ballId }, publishedBallIds: E72_CHAIN })
  })

  it('hides only the exact Pearl the same answer names, and never on an answer older than her file', async () => {
    const held: HeadStagedRead = { kind: 'none', superseded: null, publishedBallIds: E72_CHAIN }
    const shown = { kind: 'staged', staged: stagedOf(LEFTOVER) } as unknown as PromotionState
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), held, true, AT_E72)).toEqual({ ballId: E71.ballId, epoch: 171 })
    // The answer was asked for before her file was read: it hides nothing.
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), held, false, AT_E72)).toBeNull()
    // No list (an older edge), a failed answer, or no answer: nothing is hidden.
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), { kind: 'none', superseded: null }, true, AT_E72)).toBeNull()
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), { kind: 'unread', why: 'it answered 503' }, true, AT_E72)).toBeNull()
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), { kind: 'absent' }, true, AT_E72)).toBeNull()
    // A fork with an equal epoch and a different ballId is never published.
    const fork = stagedOf(fileOf(E71B, V71B, E70))
    expect(await publishedPearlOf({ kind: 'staged', staged: fork } as unknown as PromotionState, fork, held, true, AT_E72)).toBeNull()
    // A state about no Pearl hides nothing.
    expect(await publishedPearlOf({ kind: 'unreadable', why: 'her home could not be read' }, null, held, true, AT_E72)).toBeNull()
  })

  it('her file keeps published Epoch 171\'s id over other entries: it is not that Pearl, and hides nothing', async () => {
    const held: HeadStagedRead = { kind: 'none', superseded: null, publishedBallIds: E72_CHAIN }
    const forged = stagedOf(FORGED_E71)
    expect(forged.ball.ballId).toBe(E71.ballId)
    expect(await publishedPearlOf({ kind: 'staged', staged: forged } as unknown as PromotionState, forged, held, true, AT_E72)).toBeNull()
    // Nor beside HEAD's own record of the real Epoch 171, in the same answer.
    const heldReal: HeadStagedRead = { kind: 'staged', record: await heldRecordOf(E71, E70, V71), publishedBallIds: E72_CHAIN } as unknown as HeadStagedRead
    expect(await publishedPearlOf({ kind: 'staged', staged: forged } as unknown as PromotionState, forged, heldReal, true, AT_E72)).toBeNull()
    // The real Epoch 171 in her file is still the published one.
    const real = stagedOf(LEFTOVER)
    expect(await publishedPearlOf({ kind: 'staged', staged: real } as unknown as PromotionState, real, held, true, AT_E72))
      .toEqual({ ballId: E71.ballId, epoch: 171 })
  })
})

describe('the owner\'s case: her file holds published Epoch 171, HEAD is at 172', () => {
  it('Sovereignty counts nothing, draws no waiting card, and says once that it is already published as epoch 171', async () => {
    vi.stubGlobal('fetch', hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) }))
    const page = mount(homeReader(LEFTOVER))
    await waitFor(() => { expect(page.line()).not.toBeNull() }, { timeout: 10_000 })
    expect(page.line()?.textContent).toBe(`The staged Pearl ${E71.ballId.slice(0, 12)} is already published as epoch 171: nothing waits for your passkey.`)
    expect(page.container.querySelectorAll('[data-sovereignty-published-pearl]')).toHaveLength(1)
    expect(page.card()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
    expect(page.text()).not.toContain('WAITING FOR TOUCH ID')
    expect(page.text()).toContain('0 WAITING · EPOCH 172')
    expect(page.text()).not.toContain('stage it again')
  }, 30_000)

  it('the corner card raises nothing for it; an older edge without the list still counts it, as before', async () => {
    const reader = homeReader(LEFTOVER)
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) })
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 0 })
    // Its first answer came before her file was read, so it asked HEAD once more, after: two answers, no more.
    expect(statusCalls(fetchImpl)).toBe(2)
    expect(await corner(hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null) }), reader)).toEqual({ ready: [], blocked: 1 })
  })

  it('the corner card: when the answer after her file does not read, nothing is hidden', async () => {
    let answers = 0
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => (++answers === 1 ? statusOf(E72, null, E72_CHAIN)
      : json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503)) })
    expect(await corner(fetchImpl, homeReader(LEFTOVER))).toEqual({ ready: [], blocked: 1 })
  })

  it('the Pearl she stages next is offered as before, in Sovereignty and the corner card', async () => {
    const reader = homeReader(fileOf(E73, V73, E72))
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) })
    const read = await corner(fetchImpl, reader)
    expect(read?.blocked).toBe(0)
    expect(read?.ready.map(item => item.kind)).toEqual(['home-pearl'])
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    await waitFor(() => { expect(page.card()?.textContent).toContain('CLASS 3') }, { timeout: 10_000 })
    expect(page.text()).toContain('1 WAITING FOR TOUCH ID')
    expect(page.line()).toBeNull()
  }, 30_000)

  it('her file keeps published Epoch 171\'s id over altered entries: shown, counted, CANNOT LAND for its canonical id',
    async () => {
    const reader = homeReader(FORGED_E71)
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) })
    // The corner card counts it, and does not ask HEAD again for a file that is not the Pearl it claims.
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    expect(statusCalls(fetchImpl)).toBe(1)
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    // Before: "0 WAITING" and "already published as epoch 171".
    await waitFor(() => { expect(page.card()?.textContent).toContain('CANNOT LAND') }, { timeout: 10_000 })
    expect(page.text()).toContain('1 WAITING FOR TOUCH ID')
    expect(page.card()?.textContent).toContain('only under its canonical manifest id')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)

  it('a fork (Epoch 171 on Epoch 170, never landed) is shown and counted, CANNOT LAND, never "published"', async () => {
    vi.stubGlobal('fetch', hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) }))
    const page = mount(homeReader(fileOf(E71B, V71B, E70)))
    await waitFor(() => { expect(page.card()?.textContent).toContain('CANNOT LAND') }, { timeout: 10_000 })
    expect(page.text()).toContain('1 WAITING FOR TOUCH ID')
    expect(page.line()).toBeNull()
  }, 30_000)
})

// ── EVERY REVIEWER REPRODUCTION : the card IS shown and counted ────────────────

describe('review 1 reproductions: shown and counted', () => {
  it('MUST 1: published E71 hidden under E72; HEAD stages E73 and the background read of HEAD answers 503', async () => {
    let failing = false
    vi.stubGlobal('fetch', hostFetch({ head: E72, lease: E72, status: () => (failing
      ? json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503) : statusOf(E72, null, E72_CHAIN)) }))
    const page = mount(homeReader(LEFTOVER))
    await waitFor(() => { expect(page.line()).not.toBeNull() }, { timeout: 10_000 })
    expect(page.text()).toContain('0 WAITING · EPOCH 172')
    failing = true
    push({ type: 'head:staged', staged: { ballId: E73.ballId, epoch: 173 } })
    // HEAD's answer did not read, so nothing is hidden: her file's card, as main shows it, counted.
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()).not.toBeNull()
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)

  it('MUST 2: the lease answer named E72 while HEAD published E73 and staged E74 (parent E73)', async () => {
    const record = await heldRecordOf(E74, E73, V74)
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => statusOf(E73, record, chainOf(E73, E72, E71, E70)) })
    expect(await corner(fetchImpl, homeReader(LEFTOVER))).toMatchObject({ blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(homeReader(LEFTOVER))
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()).not.toBeNull()
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)

  it('rollback: HEAD restored to E70 makes her E71 its valid next Pearl; the page read E72 and the lease fails', async () => {
    const reader = homeReader(LEFTOVER)
    const fetchImpl = hostFetch({ head: E72, lease: 'fail', status: () => statusOf(E70, null, chainOf(E70)) })
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()).not.toBeNull()
    expect(page.line()).toBeNull()
  }, 30_000)
})

describe('review 3 reproductions: shown and counted', () => {
  it('a failed home read: E71 hidden beneath E72; she stages home-only E73, her home does not read, HEAD answers none', async () => {
    const reader = homeReader(LEFTOVER)
    vi.stubGlobal('fetch', hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, null, E72_CHAIN) }))
    const page = mount(reader)
    await waitFor(() => { expect(page.line()).not.toBeNull() }, { timeout: 10_000 })
    reader.text = fileOf(E73, V73, E72)
    reader.failing = true
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    // Before: no card, no failure text, "0 WAITING". Now the card stays on screen, says it was not read again, and counts.
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('Not read again just now (her home could not be read')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)

  it('an older HEAD answer still holding E73 (now published) never stands in for her newer E74', async () => {
    // The lease names E73; HEAD's answer was taken while it still held E73; her home holds a valid E74 on E73.
    const record = await heldRecordOf(E73, E72, V73)
    const reader = homeReader(fileOf(E74, V74, E73))
    const fetchImpl = hostFetch({ head: E72, lease: E73, status: () => statusOf(E72, record, E72_CHAIN) })
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    // Before: HEAD's E73 read as on HEAD and replaced her card: no card, "0 WAITING".
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('epoch 174')
    expect(page.line()).toBeNull()
  }, 30_000)

  it('cached HEAD equality after a rollback: the page read E72, HEAD is back at E71, her E72 is valid again', async () => {
    const reader = homeReader(fileOf(E72, V72, E71))
    const fetchImpl = hostFetch({ head: E72, lease: E71, status: () => statusOf(E71, null, chainOf(E71, E70)) })
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    // Before: "on HEAD" by the cached id alone: hidden, "0 WAITING".
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('NOT CHECKED')
    expect(page.card()?.textContent).toContain('HEAD has moved on since this page read it (now epoch 171')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)

  it('the lease unread: the page read E72, HEAD is restored to E70, she stages E71 running E72\'s code', async () => {
    const reader = homeReader(fileOf(E71R, V72, E70))
    const fetchImpl = hostFetch({ head: E72, lease: 'fail', status: () => statusOf(E70, null, chainOf(E70)) })
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    // Before: compared with the cached E72's code it "changes no governance organ": hidden, "0 WAITING".
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('NOT CHECKED')
    expect(page.card()?.textContent).toContain('HEAD\'s lease answer was not read just now')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)
})

// ── REVIEW 6: the list never outranks a newer lease read, and HEAD's own record needs its bytes ──

/** HEAD's record of `ball` as it serves it, with the staged bytes beside it replaced (`undefined`: none served). */
const recordServing = async (ball: Ball, parent: Ball, codes: Record<string, string>, served?: Ball) => {
  const record = await heldRecordOf(ball, parent, codes)
  if (served === undefined) {
    const { envelope: _bytes, ...bare } = record
    return bare
  }
  return { ...record, envelope: { ...record.envelope, body: { ...record.envelope.body, ball: served } } }
}

describe('review 6: a published list is only HEAD\'s word while the lease read agrees', () => {
  it('unit: hidden only when the lease head read this round is the head the list starts with', async () => {
    const held: HeadStagedRead = { kind: 'none', superseded: null, publishedBallIds: E72_CHAIN }
    const shown = { kind: 'staged', staged: stagedOf(LEFTOVER) } as unknown as PromotionState
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), held, true, AT_E72)).toEqual({ ballId: E71.ballId, epoch: 171 })
    // The lease read observed a rollback to E70 after the answer listed [E72, E71, E70]: nothing is hidden.
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), held, true, { ballId: E70.ballId })).toBeNull()
    // The lease was not read (or named no head): nothing is hidden.
    expect(await publishedPearlOf(shown, stagedOf(LEFTOVER), held, true, null)).toBeNull()
  })

  it('MUST: her canonical E71 on E70; the page read E72; the answer lists [E72, E71, E70]; the lease read then says E70', async () => {
    const reader = homeReader(LEFTOVER)
    const fetchImpl = hostFetch({ head: E72, lease: E70, status: () => statusOf(E72, null, E72_CHAIN) })
    // Before: { ready: [], blocked: 0 } (hidden on the older list). Now counted, as main counts it.
    expect(await corner(fetchImpl, reader)).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(reader)
    // Before: "already published as epoch 171", "0 WAITING". Now the card stays, with the changed-head reason, counted.
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('HEAD has moved on since')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)
})

describe('review 6: HEAD\'s own record is the published Pearl only when its served bytes hash to its id', () => {
  it('unit: no bytes, or bytes that keep the id over other entries, hide nothing; the real bytes still do', async () => {
    const heldOf = async (served: Awaited<ReturnType<typeof recordServing>>) =>
      parseHeadStaged({ ok: true, staged: served, supersededStaged: null, publishedBallIds: E72_CHAIN })
    for (const served of [await recordServing(E71, E70, V71), await recordServing(E71, E70, V71, { ...E71B, ballId: E71.ballId })]) {
      const held = await heldOf(served)
      if (held.kind !== 'staged') throw new Error('not a staged answer')
      const blocked = { kind: 'head-blocked', record: held.record, why: 'x' } as unknown as PromotionState
      expect(await publishedPearlOf(blocked, null, held, false, AT_E72)).toBeNull()
    }
    const real = await heldOf(await heldRecordOf(E71, E70, V71))
    if (real.kind !== 'staged') throw new Error('not a staged answer')
    expect(await publishedPearlOf({ kind: 'head-blocked', record: real.record, why: 'x' } as unknown as PromotionState, null, real,
      false, AT_E72)).toEqual({ ballId: E71.ballId, epoch: 171 })
  })

  it('rendered: HEAD holds a listed id and serves no bytes for it; her home holds nothing: shown and counted, CANNOT LAND', async () => {
    const record = await recordServing(E71, E70, V71)
    const fetchImpl = hostFetch({ head: E72, lease: E72, status: () => statusOf(E72, record, E72_CHAIN) })
    // Before: { ready: [], blocked: 0 } and "already published as epoch 171" on its claimed id alone.
    expect(await corner(fetchImpl, homeReader(null))).toEqual({ ready: [], blocked: 1 })
    vi.stubGlobal('fetch', fetchImpl)
    const page = mount(homeReader(null))
    await waitFor(() => { expect(page.text()).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('CANNOT LAND')
    expect(page.card()?.textContent).toContain('served no staged bytes')
    expect(page.line()).toBeNull()
    expect(page.container.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)
})
