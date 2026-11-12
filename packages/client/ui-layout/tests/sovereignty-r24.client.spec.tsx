// @vitest-environment jsdom
/**
 * Round 24, Lane 4: a staged governance Pearl lands under a FRESH writer lease taken right after Touch ID; and the
 * Sovereignty view shows who signs her checkpoints (and how far that key is anchored), whether the AUMLOK pepper is kept
 * apart, and every wake, with one click that pauses them all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireWriterLease, headPromotionBinding, landApprovedPromotion, parseStagedPromotion, promotionReadiness, publishApprovedPromotion,
  STAGED_PROMOTION_MAX_BYTES, stagedPromotionTooLarge,
  readHeadLease, writerLeaseWords, type LandStep, type StagedPromotion,
} from '../src/client/spatial/aumlok/head-promotion.ts'
import { parseHostFacts, parseSignerAnchoring, type HostFactsRead } from '../src/client/spatial/work/host-facts.ts'
import { parseWake, type WakeRead } from '../src/client/spatial/work/autonomy.ts'
import {
  createScheduleDoor, everyWords, hostTimerWords, readSchedules, keyTableWords, lastWakeWords, parseCheckpointPolicy, pepperWords,
  scheduleRowsOf, scheduleWords,
  wakeStateOf, wakeSummaryWords, type ScheduleActiveEdit, type ScheduleRead,
} from '../src/client/spatial/portal/sovereignty-panels.ts'
import { setScheduleActive } from '../src/client/spatial/portal/WakeCell.tsx'
import { chainCardOf, keysCardOf } from '../src/client/spatial/portal/sovereignty-cards.ts'
import {
  CONTINUITY_SURFACE, ContinuitySurface, landStepWords, ownerAuthorityOf, promotionOutcomeWords, promotionStateOf, SOVEREIGNTY_SURFACE,
  SovereigntySurface,
} from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { parseAumlokStatus } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

/** Approval cards draw open (Lane B2): a card is opened only if it is closed, never toggled shut. */
const openCell = (cell: Element | null | undefined): void => {
  const head = cell?.querySelector('button')
  if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
}
/** The card's check is older than FRESH_CHECK_MS, so the click checks again first (Safari's fast path does not apply). */
const ageCards = (): void => { const real = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000) }


class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const ORIGIN = 'http://localhost:3000'

// ---------------------------------------------------------------------------------------------------------------------
// A real manifest, in HEAD's own shape, with real module bytes (so HEAD's own store can take it).
// ---------------------------------------------------------------------------------------------------------------------
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const entryOf = (id: string, code: string) => ({ id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] })
interface BallContents {
  readonly parentBallId: string | null
  readonly epoch: number
  readonly entries: Record<string, unknown>
  readonly modules: Record<string, unknown>
}
const manifestIdOf = (ball: BallContents) => sha(JSON.stringify({ version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]) }))
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>, authorPeerId: string | null = 'peer-1') => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id, entryOf(id, code)]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId, entries, modules }
  return { ...contents, ballId: manifestIdOf(contents) }
}
const GENESIS_CODES = { 'seed-pearl': codeOf('seed-pearl', 162), 'auma-notes': codeOf('auma-notes', 1) }
const GENESIS = ballOf(null, 0, GENESIS_CODES)
const NEXT_CODES = { ...GENESIS_CODES, 'seed-pearl': codeOf('seed-pearl', 63) }
const NEXT = ballOf(GENESIS.ballId, 1, NEXT_CODES)
/** What Auma stages: the publish body, with the writer lease she held then (generation 1), which has long lapsed. */
const STAGED_FILE = { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 9, 9), body: {
  ball: NEXT, codeBySha: { [sha(NEXT_CODES['seed-pearl'])]: NEXT_CODES['seed-pearl'] }, expectedParentBallId: GENESIS.ballId, expectedEpoch: 0,
  writerLease: { ownerPeerId: 'peer-1', generation: 1 } } }
const staged = (): StagedPromotion => {
  const parsed = parseStagedPromotion(JSON.stringify(STAGED_FILE))
  if (parsed === null) throw new Error('staged file does not parse')
  return parsed
}

/** A HEAD stand-in, scripted answer by answer, that records every request. */
type Answer = readonly [number, unknown]
/** HEAD's success names the Pearl it committed (head-do.mjs): the stand-in answers the same. */
const LANDED: Answer = [200, { ok: true, ballId: NEXT.ballId, epoch: NEXT.epoch }]
const scripted = (acquires: ReadonlyArray<Answer | Error>, publish: Answer = LANDED) => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  let next = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push({ url, method, body, headers: { ...(init?.headers as Record<string, string> | undefined) } })
    if (url === '/_head/lease' && method === 'POST' && body.action === 'acquire') {
      const answer = acquires[Math.min(next, acquires.length - 1)]
      next += 1
      if (answer === undefined) throw new Error('no scripted answer')
      if (answer instanceof Error) throw answer
      return json(answer[1], answer[0])
    }
    if (url === '/_head/lease' && method === 'POST') return json({ ok: true, released: true })
    if (url === '/_head/lease') return json({ ok: true, lease: null, governancePromotion: true })
    if (url === '/_head/ball' && method === 'POST') return json(publish[1], publish[0])
    if (url === '/_head/ball') return json({ ok: true, head: { ballId: GENESIS.ballId } })
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, posts: () => calls.filter(call => call.method === 'POST') }
}
const GRANT = (generation: number, at: number, extra: Record<string, unknown> = {}) => [200, { ok: true,
  lease: { ownerPeerId: 'peer-1', generation, expiresAt: at + 30_000, deadlineAt: at + 60_000 }, ballId: GENESIS.ballId, epoch: 0, ...extra }] as const
const HELD = (owner: string, expiresAt: number) => [423, { ok: false, code: 'WRITER_LEASE_HELD', lease: { ownerPeerId: owner, generation: 40, expiresAt } }] as const
/** A clock the waits move, and an approval that ends five minutes after it starts. */
const clocked = (start = 1_000_000) => {
  let at = start
  const end = start + 300_000
  return { now: () => at, wait: async (ms: number) => { at += ms }, left: () => end - at, advance: (ms: number) => { at += ms } }
}

describe('a staged Pearl lands under a fresh writer lease taken right after Touch ID (Round 24)', () => {
  it('takes a lease for the author, sends her exact Pearl with THAT lease in place of the lapsed one, and gives it back', async () => {
    const clock = clocked()
    const head = scripted([GRANT(12, clock.now())])
    const steps: LandStep[] = []
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      onStep: (step) => { steps.push(step) }, fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'landed' })
    expect(head.posts().map(post => [post.url, post.body.action ?? 'publish'])).toEqual([['/_head/lease', 'acquire'], ['/_head/ball', 'publish'],
      ['/_head/lease', 'release']])
    expect(head.posts()[0]?.body).toEqual({ action: 'acquire', ownerPeerId: 'peer-1', ttlMs: 30_000 })
    const sent = head.posts()[1]
    // FAILS WITHOUT ROUND 24: the staged body went as it was, with generation 1, and HEAD answered WRITER_LEASE_REQUIRED.
    expect(sent?.body.writerLease).toEqual({ ownerPeerId: 'peer-1', generation: 12 })
    expect(sent?.body).toEqual({ ...STAGED_FILE.body, writerLease: { ownerPeerId: 'peer-1', generation: 12 } })
    expect(sent?.headers['x-x6-class3-approval']).toBe('tok')
    // The lease sits beside the Pearl: its id and the approved terms are the staged ones.
    const parsed = parseStagedPromotion(JSON.stringify({ ...STAGED_FILE, body: sent?.body }))
    if (parsed === null) throw new Error('sent body does not parse')
    expect(parsed.ball.ballId).toBe(NEXT.ballId)
    expect(await headPromotionBinding({ audience: ORIGIN, ball: parsed.ball, entryId: 'seed-pearl' }))
      .toEqual(await headPromotionBinding({ audience: ORIGIN, ball: staged().ball, entryId: 'seed-pearl' }))
    expect(head.posts()[2]?.body).toEqual({ action: 'release', ownerPeerId: 'peer-1', generation: 12 })
    expect(steps.map(step => step.kind)).toEqual(['taking-lease', 'sending'])
    expect(landStepWords({ kind: 'sending', generation: 12 })).toBe('Sending her staged Pearl to HEAD under writer lease generation 12…')
  })
  it('a staged file over the ceiling her worker stages under is never parsed (Round 25)', () => {
    expect(STAGED_PROMOTION_MAX_BYTES).toBe(4 * 1024 * 1024)
    const padded = (bytes: number) => JSON.stringify({ ...STAGED_FILE, padding: 'x'.repeat(Math.max(0, bytes - JSON.stringify(STAGED_FILE).length - 13)) })
    expect([padded(STAGED_PROMOTION_MAX_BYTES).length, padded(STAGED_PROMOTION_MAX_BYTES + 1).length])
      .toEqual([STAGED_PROMOTION_MAX_BYTES, STAGED_PROMOTION_MAX_BYTES + 1])
    expect(stagedPromotionTooLarge(padded(STAGED_PROMOTION_MAX_BYTES))).toBe(false)
    expect(parseStagedPromotion(padded(STAGED_PROMOTION_MAX_BYTES))).not.toBeNull()
    expect(stagedPromotionTooLarge(padded(STAGED_PROMOTION_MAX_BYTES + 1))).toBe(true)
    expect(parseStagedPromotion(padded(STAGED_PROMOTION_MAX_BYTES + 1))).toBeNull()
    // Counted in UTF-8 bytes: 1.5 Mi three-byte characters are 4.5 MiB, though the string is shorter than the ceiling.
    expect(stagedPromotionTooLarge('…'.repeat(1_572_864))).toBe(true)
  })
  it('a body her worker staged with no writer lease at all (Lanes 2-3 write none) is ready, and lands under a fresh one', async () => {
    const { writerLease: _lapsed, ...bare } = STAGED_FILE.body
    const parsed = parseStagedPromotion(JSON.stringify({ ...STAGED_FILE, body: bare }))
    if (parsed === null) throw new Error('a body with no lease does not parse')
    expect(promotionReadiness({ staged: parsed, published: { ballId: GENESIS.ballId, epoch: 0 }, runtime: 'cloudflare', manifestProblem: null,
      canQualify: true, bytes: 'verified' })).toEqual([])
    const clock = clocked()
    const head = scripted([GRANT(5, clock.now())])
    expect(await landApprovedPromotion({ staged: parsed, token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })).toEqual({ kind: 'landed' })
    expect(head.posts()[1]?.body).toEqual({ ...bare, writerLease: { ownerPeerId: 'peer-1', generation: 5 } })
  })
  it('never takes over a lease someone holds: it waits for it to lapse, then takes its own', async () => {
    const clock = clocked()
    const head = scripted([HELD('peer-9', clock.now() + 4_000), GRANT(41, clock.now() + 4_250)])
    const steps: LandStep[] = []
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      onStep: (step) => { steps.push(step) }, fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'landed' })
    expect(steps).toEqual([{ kind: 'taking-lease', ownerPeerId: 'peer-1' }, { kind: 'waiting', heldBy: 'peer-9', seconds: 5 },
      { kind: 'taking-lease', ownerPeerId: 'peer-1' }, { kind: 'sending', generation: 41 }])
    // Nothing renewed or released the other writer's lease.
    expect(head.posts().filter(post => post.body.action === 'renew' || (post.body.action === 'release' && post.body.generation === 40))).toEqual([])
    // The wait is when the page asks again, never a claim about when HEAD's lease lapses.
    expect(landStepWords(steps[1] as LandStep)).toBe('Approved. HEAD\'s writer lease is held by peer-9; asking again in 5 s…')
  })
  it('a lease held for as long as the approval lasts: nothing is sent, and the approval is not used', async () => {
    const clock = clocked()
    clock.advance(280_000)
    const head = scripted([HELD('peer-9', clock.now() + 25_000)])
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'not-sent', why: 'lease-busy', heldBy: 'peer-9' })
    expect(head.posts().some(post => post.url === '/_head/ball')).toBe(false)
    expect(promotionOutcomeWords(outcome, { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: NEXT.ballId,
      epoch: 1, organId: 'seed-pearl', candidateSha256: sha(NEXT_CODES['seed-pearl']) })).toContain('was still held by peer-9 at the last ask')
  })
  it('HEAD moved on while the card was open: the lease is given back and nothing is sent', async () => {
    const clock = clocked()
    const head = scripted([GRANT(12, clock.now(), { ballId: 'ee'.repeat(32), epoch: 1 })])
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    // The page saw it in the grant, before sending: said as nothing sent, never as HEAD's own refusal.
    expect(outcome).toEqual({ kind: 'not-sent', why: 'head-moved' })
    expect(head.posts().map(post => post.body.action)).toEqual(['acquire', 'release'])
  })
  it('an approval with under 10 s left is never sent; a manifest with no author asks for no lease', async () => {
    const clock = clocked()
    clock.advance(291_000)
    const head = scripted([GRANT(12, clock.now())])
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })).toEqual({ kind: 'not-sent', why: 'approval-expiring' })
    expect(head.posts()).toEqual([])
    const authorless = { ...staged(), ball: { ...staged().ball, authorPeerId: null } }
    expect(await landApprovedPromotion({ staged: authorless, token: 'tok', approvalLeftMs: () => 300_000, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl })).toEqual({ kind: 'not-sent', why: 'no-author' })
    expect(head.calls).toEqual([])
  })
  it('a lease request with no clear answer is never sent under: it waits for any lease to lapse, then asks again', async () => {
    const clock = clocked()
    const head = scripted([new TypeError('network down'), GRANT(13, clock.now() + 500)])
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })).toEqual({ kind: 'landed' })
    expect(head.calls.map(call => `${call.method} ${call.url} ${String(call.body.action ?? '')}`.trim())).toEqual(['POST /_head/lease acquire',
      'GET /_head/lease', 'POST /_head/lease acquire', 'POST /_head/ball', 'POST /_head/lease release'])
  })
  it('a page clock far from HEAD’s, or a lease given back early, costs a few seconds, never the approval', async () => {
    // The page clock 60 s AHEAD of HEAD: every expiresAt looks past, so the page asks again each second, not 24 times and out.
    const ahead = clocked()
    const heldAhead = Array.from({ length: 40 }, () => HELD('peer-9', ahead.now() - 60_000))
    const fast = scripted([...heldAhead, GRANT(50, ahead.now())])
    const waits: number[] = []
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: ahead.left, signal: new AbortController().signal,
      fetchImpl: fast.fetchImpl, now: ahead.now, wait: async (ms) => { waits.push(ms); await ahead.wait(ms) } })).toEqual({ kind: 'landed' })
    expect(waits).toHaveLength(40)
    expect(waits.every(ms => ms === 1_000)).toBe(true)
    // The page clock BEHIND: a lease that looks 60 s long is asked about again within 5 s (it may be given back early).
    const behind = clocked()
    const slow = scripted([HELD('peer-9', behind.now() + 60_000), GRANT(51, behind.now())])
    const longest: number[] = []
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: behind.left, signal: new AbortController().signal,
      fetchImpl: slow.fetchImpl, now: behind.now, wait: async (ms) => { longest.push(ms); await behind.wait(ms) } })).toEqual({ kind: 'landed' })
    expect(longest).toEqual([5_000])
  })
  it('lease asks that never get a clear answer are said as such, never as a lease someone holds', async () => {
    const clock = clocked()
    const head = scripted([new TypeError('network down')])
    const steps: LandStep[] = []
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      onStep: (step) => { steps.push(step) }, fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'not-sent', why: 'lease-unclear', detail: 'HEAD did not answer the lease request' })
    expect(head.posts().some(post => post.url === '/_head/ball')).toBe(false)
    const waiting = steps.find(step => step.kind === 'waiting')
    expect(waiting === undefined ? '' : landStepWords(waiting))
      .toBe('Approved. HEAD gave no clear answer to the lease request (HEAD did not answer the lease request); asking again in 1 s…')
    expect(promotionOutcomeWords(outcome, { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: NEXT.ballId,
      epoch: 1, organId: 'seed-pearl', candidateSha256: sha(NEXT_CODES['seed-pearl']) })).toContain('HEAD gave no clear answer to the last writer lease request')
  })
  it('a lease held at first and unanswered at the end is said by its last answer, the earlier "held" named as earlier', async () => {
    const clock = clocked()
    clock.advance(270_000)
    const head = scripted([HELD('peer-9', clock.now() + 60_000), HELD('peer-9', clock.now() + 60_000), new TypeError('network down')])
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'not-sent', why: 'lease-unclear', detail: 'HEAD did not answer the lease request', heldBy: 'peer-9' })
    expect(promotionOutcomeWords(outcome, { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: NEXT.ballId,
      epoch: 1, organId: 'seed-pearl', candidateSha256: sha(NEXT_CODES['seed-pearl']) }))
      .toContain('no clear answer to the last writer lease request (HEAD did not answer the lease request); earlier it said the lease was held by peer-9')
  })
  it('the check at the click: a fresh HEAD that is the staged Pearl is already landed; one that moved on stands in the way', async () => {
    const page = staged()
    const published = { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 0 }
    const context = (freshHead: { ballId: string; epoch: number } | null) => ({ published,
      lease: null, canQualify: true, runtime: 'cloudflare' as const, audience: ORIGIN, now: 1, freshHead })
    expect(await promotionStateOf(page, context({ ballId: NEXT.ballId, epoch: 1 }))).toEqual({ kind: 'on-head', ballId: NEXT.ballId })
    const moved = await promotionStateOf(page, context({ ballId: 'cd'.repeat(32), epoch: 1 }))
    expect(moved.kind === 'staged' ? moved.reasons.join(' | ') : moved.kind).toContain('HEAD has moved on since this card read it (now epoch 1 · cdcdcdcdcdcd)')
    expect(await promotionStateOf(page, context({ ballId: GENESIS.ballId, epoch: 0 }))).toMatchObject({ kind: 'staged', reasons: [] })
  })
  it('a lease answer not read is the only obstacle: the card says not checked, never that HEAD would refuse it', async () => {
    const page = staged()
    const state = await promotionStateOf(page, { published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 0 }, lease: null,
      canQualify: false, runtime: 'cloudflare', audience: ORIGIN, now: 1, freshHead: null, leaseUnread: 'it answered 503' })
    expect(state).toMatchObject({ kind: 'staged', leaseUnread: 'it answered 503',
      reasons: ['HEAD\'s lease answer was not read just now (it answered 503), so whether it can land a governance Pearl is not known'] })
  })
  it('HEAD’s answer is shown at once: a release that never answers does not hold it back', async () => {
    const clock = clocked()
    const base = scripted([GRANT(12, clock.now())])
    let releases = 0
    const hanging = (async (url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('"release"')) { releases += 1; return new Promise<Response>(() => {}) }
      return base.fetchImpl(url, init)
    }) as unknown as typeof fetch
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: hanging, now: clock.now, wait: clock.wait })).toEqual({ kind: 'landed' })
    expect(releases).toBe(1)
  })
  it('an approval stopped between the grant and the send sends nothing, and the lease is given back', async () => {
    const clock = clocked()
    const controller = new AbortController()
    const head = scripted([GRANT(12, clock.now())])
    const outcome = await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: controller.signal,
      onStep: (step) => { if (step.kind === 'taking-lease') controller.abort() }, fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })
    expect(outcome).toEqual({ kind: 'not-sent', why: 'stopped' })
    expect(head.posts().map(post => post.body.action ?? 'publish')).toEqual(['acquire', 'release'])
  })
  it('HEAD’s own refusals pass through, and the lease is still given back', async () => {
    const clock = clocked()
    const head = scripted([GRANT(12, clock.now())], [403, { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE' }])
    expect(await landApprovedPromotion({ staged: staged(), token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal,
      fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait })).toEqual({ kind: 'refused', code: 'PEARL_QUALIFICATION_UNVERIFIABLE' })
    expect(head.posts().at(-1)?.body).toEqual({ action: 'release', ownerPeerId: 'peer-1', generation: 12 })
    const refusedLease = scripted([[400, { ok: false, code: 'INVALID_WRITER_LEASE' }]])
    expect(await acquireWriterLease('peer-1', new AbortController().signal, refusedLease.fetchImpl)).toEqual({ kind: 'refused', code: 'INVALID_WRITER_LEASE' })
  })
  it('the lease in words, and HEAD’s own reason for not landing one read from its lease answer', async () => {
    const now = 1_000_000
    expect(writerLeaseWords(null, 'peer-1', now)).toBe('free now: right after Touch ID this page takes a fresh one for peer-1')
    expect(writerLeaseWords({ ownerPeerId: 'peer-1', generation: 3, expiresAt: now + 12_500 }, 'peer-1', now))
      .toContain('held by peer-1 (the Pearl\'s author\'s name: perhaps her worker writing, or an earlier lease) when read, with about 13 s left')
    // A page clock far behind HEAD's would name more than a lease can live: no seconds are said then.
    expect(writerLeaseWords({ ownerPeerId: 'peer-9', generation: 3, expiresAt: now + 45_000 }, 'peer-1', now))
      .toBe('held by peer-9 when read (a lease lasts at most 60 s); after Touch ID this page waits for it to lapse, then takes a fresh one')
    // A lease field that is there but not a lease is not read, never "free".
    const odd = (async () => json({ ok: true, lease: { ownerPeerId: 'peer-9' }, ballId: GENESIS.ballId, epoch: 0 })) as unknown as typeof fetch
    expect((await readHeadLease(new AbortController().signal, odd)).unread).toBe('its lease field was not the expected shape')
    // HEAD names only a live lease (by its own clock): one this page's clock thinks has lapsed is still held, without seconds.
    expect(writerLeaseWords({ ownerPeerId: 'peer-9', generation: 3, expiresAt: now - 1 }, 'peer-1', now))
      .toBe('held by peer-9 when read (a lease lasts at most 60 s); after Touch ID this page waits for it to lapse, then takes a fresh one')
    const answer = (async () => json({ ok: true, lease: null, governancePromotion: false, governancePromotionBlocker: 'PEARL_QUALIFICATION_UNVERIFIABLE' })) as unknown as typeof fetch
    expect(await readHeadLease(new AbortController().signal, answer))
      .toEqual({ lease: null, canQualify: false, qualifyBlocker: 'PEARL_QUALIFICATION_UNVERIFIABLE', head: null, unread: null, requirements: null })
    // Round 29: what HEAD says a passkey-only governance Pearl must be is read as HEAD says it, and only as booleans.
    const passkeyOnly = (async () => json({ ok: true, lease: null, governancePromotion: true,
      governancePromotionRequirements: { canonicalManifest: true, unchangedOtherEntries: true, behavioralQualification: false },
    })) as unknown as typeof fetch
    expect((await readHeadLease(new AbortController().signal, passkeyOnly)).requirements)
      .toEqual({ canonicalManifest: true, unchangedOtherEntries: true })
    const notBooleans = (async () => json({ ok: true, lease: null, governancePromotion: true,
      governancePromotionRequirements: { canonicalManifest: 'yes', unchangedOtherEntries: true } })) as unknown as typeof fetch
    expect((await readHeadLease(new AbortController().signal, notBooleans)).requirements).toBeNull()
    // A Pearl that also changes an ordinary entry is stopped before the passkey, in HEAD's own words.
    expect(promotionReadiness({ staged: staged(), published: { ballId: GENESIS.ballId, epoch: 0 }, runtime: 'cloudflare', manifestProblem: null,
      canQualify: true, bytes: 'verified', requirements: { canonicalManifest: true, unchangedOtherEntries: true }, canonicalId: true,
      others: ['auma-notes'] })).toEqual(['it also changes auma-notes, which a passkey alone does not carry past Pearl '
      + '(HEAD: PEARL_QUALIFICATION_UNVERIFIABLE); Auma must stage the governance organ on its own'])
    // An answer not read is never put in HEAD's mouth: no qualification word, no "free" lease.
    const down = (async () => json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503)) as unknown as typeof fetch
    const unread = await readHeadLease(new AbortController().signal, down)
    expect(unread.unread).toBe('it answered 503')
    expect(promotionReadiness({ staged: staged(), published: { ballId: GENESIS.ballId, epoch: 0 }, runtime: 'cloudflare', manifestProblem: null,
      canQualify: false, leaseUnread: unread.unread, bytes: 'verified' }))
      .toEqual(['HEAD\'s lease answer was not read just now (it answered 503), so whether it can land a governance Pearl is not known'])
    const namedBody = { ok: true, lease: null, ballId: GENESIS.ballId, epoch: 0, governancePromotion: true }
    const named = (async () => json(namedBody)) as unknown as typeof fetch
    expect((await readHeadLease(new AbortController().signal, named)).head).toEqual({ ballId: GENESIS.ballId, epoch: 0 })
    expect(promotionReadiness({ staged: staged(), published: { ballId: GENESIS.ballId, epoch: 0 }, runtime: 'cloudflare', manifestProblem: null,
      canQualify: true, bytes: 'verified' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The same flow against HEAD's own store code (deploy/cloudflare/src/head-do.mjs), with an in-memory Durable Object.
// ---------------------------------------------------------------------------------------------------------------------
type HeadStore = {
  lease: (input: unknown) => Promise<Record<string, unknown>>
  inspectLease: () => Promise<Record<string, unknown>>
  publish: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
  read: () => Promise<Record<string, unknown>>
}
const loadHeadStore = async (): Promise<((storage: unknown, options: unknown) => HeadStore) | null> => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/head-do.mjs`)).find(existsSync)
  if (path === undefined) return null
  try {
    const module = await import(pathToFileURL(path).href) as { createDurableHeadStore?: (storage: unknown, options: unknown) => HeadStore }
    return typeof module.createDurableHeadStore === 'function' ? module.createDurableHeadStore : null
  } catch { return null }
}
const CREATE_HEAD_STORE = await loadHeadStore()
/** A Durable Object's transactional storage, in memory: a failed transaction leaves nothing behind. */
const memoryStorage = () => {
  let rows = new Map<string, unknown>()
  let queue: Promise<unknown> = Promise.resolve()
  const copy = <T,>(value: T): T => (value === undefined ? value : structuredClone(value))
  const adapter = (map: Map<string, unknown>) => ({
    get: async (key: string) => copy(map.get(key)),
    put: async (key: string, value: unknown) => { map.set(key, copy(value)) },
    delete: async (key: string) => map.delete(key),
    list: async ({ prefix = '', limit = Infinity }: { prefix?: string; limit?: number } = {}) =>
      new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  })
  return {
    transaction: (operation: (tx: ReturnType<typeof adapter>) => Promise<unknown>) => {
      const pending = queue.then(async () => {
        const staging = new Map([...rows].map(([key, value]) => [key, copy(value)]))
        const result = await operation(adapter(staging))
        rows = staging
        return result
      })
      queue = pending.catch(() => undefined)
      return pending
    },
  }
}
/** The page's fetch, answered by HEAD's store the way the Durable Object routes it. */
const throughHead = (store: HeadStore) => (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const headers = { ...(init?.headers as Record<string, string> | undefined) }
  const answer = url === '/_head/lease' ? (method === 'POST' ? await store.lease(body) : await store.inspectLease())
    : url === '/_head/ball' && method === 'POST'
      ? await store.publish({ ...body, codeBySha: body.codeBySha ?? body.modules ?? {} }, { approvalToken: headers['x-x6-class3-approval'] ?? null, audience: ORIGIN })
      : url === '/_head/ball' ? await store.read() : { ok: false, code: 'NOT_FOUND', status: 404 }
  return json(answer, typeof answer.status === 'number' ? answer.status : 200)
}) as unknown as typeof fetch

describe.skipIf(CREATE_HEAD_STORE === null)('against HEAD’s own store code: the staged Pearl lands only under a fresh lease (Round 24)', () => {
  it('as staged it is refused for its lapsed lease; after the approval, under a fresh one, HEAD commits it and spends the approval once', async () => {
    const consumed: unknown[] = []
    let expected: unknown = null
    const store = (CREATE_HEAD_STORE as NonNullable<typeof CREATE_HEAD_STORE>)(memoryStorage(), {
      verifyTransitionQualification: async (terms: { transitionSha256: string; candidateBallId: string }) =>
        ({ transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: Date.now() + 60_000 }),
      consumeGovernanceApproval: async (_tx: unknown, token: string, binding: unknown) => {
        consumed.push({ token, binding })
        if (token === 'GENESIS') return { ok: true, expiresAt: Date.now() + 10_000 }
        return token === 'tok' && JSON.stringify(binding) === JSON.stringify(expected) ? { ok: true, expiresAt: Date.now() + 10_000 } : { ok: false }
      },
    })
    // The published head (epoch 0), written the way any writer writes it: under its own lease.
    const first = await store.lease({ action: 'acquire', ownerPeerId: 'peer-1' })
    const firstLease = first.lease as { ownerPeerId: string; generation: number }
    const genesisCode = Object.fromEntries(Object.values(GENESIS_CODES).map(code => [sha(code), code]))
    expect(await store.publish({ ball: GENESIS, codeBySha: genesisCode, expectedParentBallId: null, expectedEpoch: -1,
      writerLease: { ownerPeerId: 'peer-1', generation: firstLease.generation } }, { approvalToken: 'GENESIS', audience: ORIGIN })).toMatchObject({ ok: true })
    await store.lease({ action: 'release', ownerPeerId: 'peer-1', generation: firstLease.generation })
    // Auma staged epoch 1 under that lease; it has lapsed (released) since. The page's terms are HEAD's terms.
    const page = staged()
    expect(page.body.writerLease).toEqual({ ownerPeerId: 'peer-1', generation: firstLease.generation })
    expected = await headPromotionBinding({ audience: ORIGIN, ball: page.ball, entryId: 'seed-pearl' })
    const fetchImpl = throughHead(store)
    // WITHOUT A FRESH LEASE (Round 23): HEAD refuses the staged body as it is, and the approval is not spent.
    expect(await publishApprovedPromotion(page.body, 'tok', page.ball.ballId, new AbortController().signal, fetchImpl))
      .toEqual({ kind: 'refused', code: 'WRITER_LEASE_REQUIRED' })
    expect(consumed).toHaveLength(1)
    // WITH ONE: HEAD commits the exact staged Pearl, spending the approval once, and the lease is given back.
    expect(await landApprovedPromotion({ staged: page, token: 'tok', approvalLeftMs: () => 290_000, signal: new AbortController().signal, fetchImpl }))
      .toEqual({ kind: 'landed' })
    expect(consumed).toEqual([expect.objectContaining({ token: 'GENESIS' }), { token: 'tok', binding: expected }])
    const head = await store.read() as { head?: { ballId?: string; epoch?: number } }
    expect(head.head).toMatchObject({ ballId: NEXT.ballId, epoch: 1 })
    expect((await store.inspectLease()).lease).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Sovereignty: the checkpoint signer, the pepper, and every wake (zero shelfware).
// ---------------------------------------------------------------------------------------------------------------------
const FACTS = {
  ok: true, runtime: 'cloudflare', epoch: 162, ballId: 'ab'.repeat(32), organCount: 24, activeOrganCount: 24, receiptTotal: 120, receiptsVerified: 120,
  checkpointsTotal: 12, lastCheckpointSeq: 12, lastCheckpointReceiptCount: 119, dagReachable: 5, dagDeclared: 5, auraStatus: 'calm',
  receiptVerification: 'hash-and-chain', checkpointVerification: 'signature-and-receipt-prefix', checkpointSignerTrust: 'pinned',
  evidenceStatus: 'complete',
}
const factsRead = (body: Record<string, unknown>): HostFactsRead => {
  const facts = parseHostFacts(body)
  if (facts === null) throw new Error('facts do not parse')
  return { kind: 'ok', facts } as HostFactsRead
}
const POLICY = { ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: [
  { firstSeq: 1, lastSeq: 1, envelope: 'v1', publicKeyHex: 'baf94a77'.repeat(8) },
  { firstSeq: 2, lastSeq: 6, envelope: 'v1', publicKeyHex: 'a2ddc722'.repeat(8) },
  { firstSeq: 7, lastSeq: 12, envelope: 'v2', publicKeyHex: 'cb7a1af0'.repeat(8) }] }

describe('Sovereignty shows who signs the checkpoints: a chain that verifies is not a key the owner anchored (Rounds 24-25)', () => {
  it('reads the anchoring words wherever the host puts them, and never refuses the core facts for an odd one', () => {
    expect(parseSignerAnchoring({ chainSigned: true, signerAnchored: false, signerStatus: 'historical-sandbox' }))
      .toEqual({ chainSigned: true, signerAnchored: false, signerStatus: 'historical-sandbox' })
    expect(parseSignerAnchoring({ checkpointSigner: { chainSigned: true, signerAnchored: true, signerStatus: 'owner-anchored' } }))
      .toEqual({ chainSigned: true, signerAnchored: true, signerStatus: 'owner-anchored' })
    expect(parseSignerAnchoring({ chainSigned: 'yes', signerStatus: 'Owner Anchored!' })).toEqual({ chainSigned: null, signerAnchored: null, signerStatus: null })
    expect(parseHostFacts({ ...FACTS, signerAnchored: 'yes' })?.anchoring.signerAnchored).toBeNull()
    expect(parseCheckpointPolicy(POLICY)).toHaveLength(3)
    expect(parseCheckpointPolicy({ ...POLICY, ranges: [{ firstSeq: 3, lastSeq: 2, envelope: 'v1', publicKeyHex: 'aa'.repeat(32) }] })).toBeNull()
    expect(keyTableWords(parseCheckpointPolicy(POLICY) ?? [])).toBe('seq 1 v1 baf94a77… · seq 2–6 v1 a2ddc722… · seq 7–12 v2 cb7a1af0…')
  })
  it('Keys and trust: each check only as far as a source says it, alarms first, nothing for what nobody says (Round 25)', () => {
    const table = { kind: 'ok' as const, ranges: parseCheckpointPolicy(POLICY) ?? [] }
    const bound = parseAumlokStatus({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32) })
    if (bound === null) throw new Error('status does not parse')
    const live = { kind: 'live' as const, status: bound }
    // Today's host: pinned keys and no word on the owner's anchor: no anchor row at all, and the key table in the details.
    const today = keysCardOf(live, factsRead(FACTS), table, null)
    expect([today.badge, today.tone, today.summary]).toEqual(['PASSKEY BOUND', 'mint', 'passkey bound · signer pinned'])
    expect(today.rows.map(([name]) => name)).toEqual(['passkey', 'checkpoint signer'])
    expect(Object.fromEntries(today.details)['checkpoint keys']).toBe(keyTableWords(table.ranges))
    // A host that says the signer is not the owner's: said, and never shown as anchored.
    const sandbox = keysCardOf(live, factsRead({ ...FACTS, chainSigned: true, signerAnchored: false, signerStatus: 'historical-sandbox' }), table, null)
    expect(Object.fromEntries(sandbox.rows)['signer anchored']).toBe('NO: not the owner’s key (historical-sandbox) · the host says')
    expect(sandbox.summary).toBe('passkey bound · signer pinned · NOT owner-anchored')
    const anchored = keysCardOf(live, factsRead({ ...FACTS, signerAnchored: true, signerStatus: 'owner-anchored' }), table, null)
    expect(Object.fromEntries(anchored.rows)['signer anchored']).toBe('yes, by the owner (owner-anchored) · the host says')
    // A chain that does not verify outranks the passkey badge; a signer mismatch outranks everything.
    const broken = keysCardOf(live, factsRead({ ...FACTS, chainSigned: false, signerAnchored: true }), table, null)
    expect([broken.badge, broken.tone]).toEqual(['CHAIN NOT VERIFIED', 'gold'])
    expect(Object.fromEntries(broken.rows).chain).toBe('NOT verified: the signatures or roots over her receipt chain do not verify')
    const mismatch = keysCardOf(live, factsRead({ ...FACTS, checkpointSignerTrust: 'mismatch', chainSigned: false }), table, null)
    expect(mismatch.badge).toBe('CHECKPOINT SIGNER MISMATCH')
    // Her own verifier: a rejection where it judged the chain breaks it; a key it could not read is no verdict on the chain.
    const rejected = keysCardOf(live, factsRead(FACTS), table, { kind: 'rejected', stage: 'checkpoint-signer' })
    expect([rejected.badge, Object.fromEntries(rejected.rows).chain])
      .toEqual(['CHAIN NOT VERIFIED', 'NOT verified: her verifier REJECTED it at checkpoint-signer'])
    expect(keysCardOf(live, factsRead(FACTS), table, { kind: 'rejected', stage: 'signing-key-unreadable' }).badge).toBe('PASSKEY BOUND')
    // "unpinned" can mean no checkpoint yet: said as the host says it, nothing more read into it.
    const unpinned = keysCardOf(live, factsRead({ ...FACTS, checkpointSignerTrust: 'unpinned' }), table, null)
    expect(Object.fromEntries(unpinned.rows)['checkpoint signer']).toBe('not pinned on this host (or no checkpoint yet)')
    // Nothing read: one passkey line, no signer rows, no key table.
    const blank = keysCardOf({ kind: 'reading' }, { kind: 'reading' } as HostFactsRead, { kind: 'failed', reason: 'answered 403' }, null)
    expect([blank.rows, blank.details]).toEqual([[['passkey', 'reading…']], []])
  })
  it('Receipt chain: her verifier beside the host, a rejection first, no row for a source that said nothing (Round 25)', () => {
    const counted = { kind: 'verified', merkleRoot: 'ab'.repeat(32), checkpointHash: null, receiptsVerified: 120, checkpointsVerified: 12 }
    const match = { kind: 'match' as const, compared: 3, headCompared: true }
    const agree = chainCardOf(factsRead(FACTS), match, counted)
    expect([agree.badge, agree.tone, agree.summary]).toEqual(['VERIFIED · AGREE', 'mint', '120 receipts · 12 checkpoints · tab and host agree'])
    expect(agree.rows).toEqual([['her verifier', 'verified 120 receipts and 12 checkpoints'],
      ['host check', '120 of 120 receipts verified · checkpoint 12 covers 119']])
    expect(Object.fromEntries(agree.details)['merkle root']).toBe('ab'.repeat(32))
    const rejected = chainCardOf(factsRead(FACTS), match, { kind: 'rejected', stage: 'merkle-root' })
    expect([rejected.badge, rejected.tone, rejected.summary]).toEqual(['REJECTED', 'red', 'her verifier REJECTED the chain at merkle-root'])
    const lag = chainCardOf(factsRead(FACTS), { kind: 'lag', notes: ['TAB BEHIND HOST'] }, counted)
    expect([lag.badge, lag.notes]).toEqual(['TAB AND HOST DIFFER', ['TAB BEHIND HOST']])
    const unknown = { kind: 'unknown' as const, reason: 'not compared' }
    expect(Object.fromEntries(chainCardOf(factsRead(FACTS), unknown, { kind: 'rejected', stage: 'signing-key-unreadable' }).rows)['her verifier'])
      .toBe('could not check her chain (signing-key-unreadable)')
    expect(Object.fromEntries(chainCardOf(factsRead(FACTS), unknown, { kind: 'timeout' }).rows)['her verifier']).toBe('gave no verdict here (timeout)')
    // Neither said anything yet: one line, no rows.
    expect(chainCardOf({ kind: 'reading' } as HostFactsRead, unknown, null)).toMatchObject({ summary: 'Reading…', rows: [], badge: 'READING' })
  })
  it('the pepper is said as the host says it, under Owner authority', () => {
    expect(pepperWords(null)).toBe('not reported by this host')
    expect(pepperWords(true)).toContain('separated: kept apart from the store that holds your sealed root (the host says)')
    expect(pepperWords(false)).toContain('NOT separated')
    expect(pepperWords(false, false)).toBe('nothing is sealed on this host yet, so there is no pepper to keep apart')
    const status = parseAumlokStatus({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), pepperSeparated: true })
    if (status === null) throw new Error('status does not parse')
    expect(Object.fromEntries(ownerAuthorityOf({ kind: 'live', status }).rows).pepper).toBe(pepperWords(true))
  })
})

const WAKE_ON = { ok: true, enabled: true, intervalMs: 86_400_000, lastWakeAt: 1_762_600_000_000, lastWakeOutcome: 'probe-only', wakeCount: 3,
  nextWakeAt: 1_762_686_400_000, consecutiveUnacknowledgedWakes: 0, autoPaused: false, receipts: [
    { wakeId: 'wake-seed-1', at: 1_762_400_000_000, trigger: 'manual', headEpoch: 161, headBallId: 'aa'.repeat(32), headStatus: 'available', status: 'probe-only' },
    { wakeId: 'wake-seed-3', at: 1_762_600_000_000, trigger: 'alarm', headEpoch: 162, headBallId: 'ab'.repeat(32), headStatus: 'available', status: 'probe-only' }] }
const SCHEDULE = { id: 'schedule-5e000001-0000-4000-8000-000000000001', kind: 'every', title: 'Daily wake', prompt: 'wake', everySeconds: 86_400,
  scheduledAt: '2026-11-10T00:00:00Z', status: 'active', updatedAt: '2026-11-09T01:00:00.000Z',
  lastDelivery: { scheduledAt: '2026-11-09T00:00:00Z', deliveredAt: '2026-11-09T00:00:02Z', messageId: 'm-1', targetSessionId: 's-1' } }

describe('Sovereignty shows every wake, with one click that pauses them all (Round 24)', () => {
  it('reads the host timer, its last wake receipt, and her schedules in words', () => {
    const on = parseWake(WAKE_ON)
    if (on === null) throw new Error('wake does not parse')
    const host: WakeRead = { kind: 'ok', status: on }
    expect(on.lastReceipt).toEqual({ wakeId: 'wake-seed-3', at: 1_762_600_000_000, trigger: 'alarm', headEpoch: 162, status: 'probe-only' })
    expect(hostTimerWords(host)).toBe('ACTIVE: every 24 h, next 2025-11-09T11:06:40Z')
    expect(lastWakeWords(host)).toBe('wake-seed-3 · 2025-11-08T11:06:40Z · alarm · Pearl epoch 162 · probe-only')
    const paused = parseWake({ ...WAKE_ON, enabled: false, nextWakeAt: null, autoPaused: true })
    if (paused === null) throw new Error('wake does not parse')
    expect(hostTimerWords({ kind: 'ok', status: paused })).toBe('PAUSED by the host itself, after wakes nobody acknowledged')
    const rows = scheduleRowsOf([SCHEDULE, { id: '' }, 'odd'])
    expect(rows.unread).toBe(2)
    expect(rows.rows[0] === undefined ? '' : scheduleWords(rows.rows[0]))
      .toBe('ACTIVE · every 24 h, next 2026-11-10T00:00:00Z · last delivered 2026-11-09T00:00:02Z')
    const read: ScheduleRead = { kind: 'ok', ...rows }
    const off: WakeRead = { kind: 'ok', status: paused }
    expect(wakeStateOf(off, read).kind).toBe('active')
    expect(wakeStateOf(off, { kind: 'ok', rows: [], unread: 0 })).toEqual({ kind: 'paused', timer: 'off', activeTasks: 0, tasks: 'read' })
    // NEVER "ALL PAUSED" ON A FAILED READ: a refused timer, an unreadable catalog, or tasks the page cannot read.
    expect(wakeStateOf({ kind: 'refused', status: 503, detail: 'WAKE_STORAGE_UNAVAILABLE' }, { kind: 'ok', rows: [], unread: 0 }).kind).toBe('unconfirmed')
    expect(wakeStateOf(off, { kind: 'unavailable', reason: 'gateway' }).kind).toBe('unconfirmed')
    expect(wakeStateOf(off, { kind: 'ok', rows: [], unread: 1 }).kind).toBe('unconfirmed')
    expect(wakeStateOf({ kind: 'absent', detail: 'not served' }, { kind: 'ok', rows: [], unread: 0 }).kind).toBe('paused')
    expect(wakeSummaryWords(wakeStateOf(off, read))).toBe('timer paused · 1 active task (some not read)')
    expect(wakeSummaryWords(wakeStateOf(off, { kind: 'unavailable', reason: 'gateway' }))).toBe('timer paused · tasks not read')
    expect(wakeSummaryWords(wakeStateOf(host, { kind: 'reading' }))).toBe('timer ON · tasks reading…')
    expect([everyWords(86_400_000), everyWords(5_400_000), everyWords(90_000)]).toEqual(['24 h', '90 min', '90 s'])
    const missing = parseWake({ ...WAKE_ON, scheduleStatus: 'alarm_missing' })
    if (missing === null) throw new Error('wake does not parse')
    expect(hostTimerWords({ kind: 'ok', status: missing })).toBe('ON, every 24 h, but the host says no alarm is set (alarm_missing): it may not wake her')
  })

  it('a pause that loses a race with a delivery reads the task again: paused if still active, never "paused" once it finished', async () => {
    const door = createScheduleDoor()
    let stored: Record<string, unknown> = { ...SCHEDULE }
    let bumps = 1
    const edits: ScheduleActiveEdit[] = []
    door.set({
      catalog: async () => ({ ok: true, value: [stored] }),
      edit: async (request) => {
        edits.push(request)
        // A delivery lands between the read and the pause: the revision moves once.
        if (bumps > 0) { bumps -= 1; stored = { ...stored, updatedAt: '2026-11-09T01:30:00.000Z' }; return { ok: true, value: { id: request.id, code: 'schedule_conflict' } } }
        if (request.expectedUpdatedAt !== stored.updatedAt) return { ok: true, value: { id: request.id, code: 'schedule_conflict' } }
        stored = { ...stored, status: 'paused' }
        return { ok: true, value: stored }
      },
    })
    const row = scheduleRowsOf([SCHEDULE]).rows[0]
    if (row === undefined) throw new Error('no row')
    expect(await setScheduleActive(door, row, false)).toBe('Daily wake: paused')
    expect(edits.map(edit => edit.expectedUpdatedAt)).toEqual([SCHEDULE.updatedAt, '2026-11-09T01:30:00.000Z'])
    // A one-off task that finished while the pause waited: said as finished, and left as the host has it.
    stored = { ...SCHEDULE }
    bumps = 1
    door.set({
      catalog: async () => ({ ok: true, value: [stored] }),
      edit: async (request) => {
        if (bumps > 0) { bumps -= 1; stored = { ...stored, status: 'ended', updatedAt: '2026-11-09T01:31:00.000Z' }; return { ok: true, value: { id: request.id, code: 'schedule_conflict' } } }
        throw new Error('a finished task must not be edited')
      },
    })
    expect(await setScheduleActive(door, row, false)).toBe('Daily wake: finished on its own; nothing to pause')
    // A resume that loses a race is reported, never retried.
    stored = { ...SCHEDULE, status: 'paused' }
    const conflict = async (request: ScheduleActiveEdit) => ({ ok: true as const, value: { id: request.id, code: 'schedule_conflict' } })
    door.set({ catalog: async () => ({ ok: true, value: [stored] }), edit: conflict })
    expect(await setScheduleActive(door, { ...row, status: 'paused' }, true)).toBe('Daily wake: NOT resumed: it changed since it was read; read again')
  })
  // The wake card lives on the Continuity screen since Wave 5 (the same component, its `continuity` view).
  it('a timer change the host answers with a 5xx is no clear answer, and a 60 s timer resumes at 60 s', async () => {
    let timer: Record<string, unknown> = { ...WAKE_ON, enabled: false, intervalMs: 60_000, nextWakeAt: null }
    const posts: Array<Record<string, unknown>> = []
    const failPost = true
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/_host/wake' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posts.push(body)
        if (failPost) return json({ ok: false, code: 'WAKE_STORAGE_UNAVAILABLE' }, 503)
        timer = { ...timer, enabled: body.enabled, intervalMs: body.intervalMs ?? timer.intervalMs, nextWakeAt: 1 }
        return json(timer)
      }
      if (input === '/_host/wake') return json(timer)
      return new Response('nope', { status: 404 })
    }))
    const door = createScheduleDoor()
    door.set({ catalog: async () => ({ ok: true, value: [] }), edit: async () => ({ ok: true, value: {} }) })
    const props = {
      activeSurface: CONTINUITY_SURFACE,
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState)),
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
      schedules: door,
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    const { container } = render(<ContinuitySurface {...props} />)
    const wake = () => container.querySelector('[data-sovereignty-portal="wake"]')
    await waitFor(() => { expect(wake()?.textContent).toContain('ALL WAKES PAUSED') }, { timeout: 10_000 })
    fireEvent.click(wake()?.querySelector('button') as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-resume="host"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-sovereignty-wake-resume="host"]') as Element)
    expect(container.querySelector('[data-sovereignty-wake-confirm]')?.textContent).toContain('every 1 min.')
    fireEvent.click(container.querySelector('[data-sovereignty-wake-resume-confirm]') as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-answer]')?.textContent)
      .toBe('host timer: no clear answer (WAKE_STORAGE_UNAVAILABLE); read again') })
    expect(posts).toEqual([{ action: 'configure', enabled: true, intervalMs: 60_000 }])
  }, 30_000)
  it('a schedule service that never answers is given up on, with that said', async () => {
    vi.useFakeTimers()
    try {
      const door = createScheduleDoor()
      door.set({ catalog: () => new Promise(() => {}), edit: () => new Promise(() => {}) })
      const reading = readSchedules(door)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await reading).toEqual({ kind: 'unavailable', reason: 'no answer within 10 s' })
    } finally { vi.useRealTimers() }
  })
  it('on screen: one click pauses the host timer and her active schedule; resuming one asks once more first', async () => {
    let wake: Record<string, unknown> = { ...WAKE_ON }
    let schedule: Record<string, unknown> = { ...SCHEDULE }
    const wakePosts: Array<Record<string, unknown>> = []
    const edits: ScheduleActiveEdit[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (input === '/_host/wake' && init?.method === 'POST') {
        wakePosts.push(body)
        wake = { ...wake, enabled: body.enabled, nextWakeAt: body.enabled === true ? 1_762_686_400_000 : null }
        return json(wake)
      }
      if (input === '/_host/wake') return json(wake)
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      if (input === '/__x6/facts') return json({ ...FACTS, chainSigned: true, signerAnchored: false, signerStatus: 'historical-sandbox' })
      if (input === '/_host/checkpoint-policy') return json(POLICY)
      if (input === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), pepperSeparated: false })
      return new Response('nope', { status: 404 })
    }))
    const door = createScheduleDoor()
    door.set({
      catalog: async () => ({ ok: true, value: [schedule] }),
      edit: async (request) => {
        edits.push(request)
        if (request.expectedUpdatedAt !== schedule.updatedAt) {
          return { ok: true, value: { id: request.id, code: 'schedule_conflict' } }
        }
        schedule = { ...schedule, status: request.patch.active ? 'active' : 'paused', updatedAt: `2026-11-09T02:00:0${String(edits.length)}.000Z` }
        return { ok: true, value: schedule }
      },
    })
    const list: SessionListState = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
      retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as SessionListState
    const props = {
      activeSurface: CONTINUITY_SURFACE,
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
      schedules: door,
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    // Both screens: the wake card is on Continuity, the keys card (checked at the end) on Sovereignty.
    const { container } = render(<><SovereigntySurface {...props} activeSurface={SOVEREIGNTY_SURFACE} /><ContinuitySurface {...props} /></>)
    const cell = (name: string) => container.querySelector(`[data-sovereignty-portal="${name}"]`)
    // The pause is one click from the closed card.
    await waitFor(() => { expect(cell('wake')?.textContent).toContain('WAKES ACTIVE') }, { timeout: 10_000 })
    const pause = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-wake-pause]')
    expect(pause()?.textContent).toBe('Pause every wake now')
    fireEvent.click(pause() as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-answer]')?.textContent).toBe('host timer: paused · Daily wake: paused') })
    // The timer's pause sends no interval (the host keeps its own); the task's pause carries the revision it was read at.
    expect(wakePosts).toEqual([{ action: 'configure', enabled: false }])
    expect(edits).toEqual([{ id: SCHEDULE.id, action: 'update', patch: { active: false }, expectedUpdatedAt: SCHEDULE.updatedAt }])
    await waitFor(() => { expect(cell('wake')?.textContent).toContain('ALL WAKES PAUSED') })
    expect(pause()).toBeNull()
    // Resuming is inside the card, one wake at a time, and asks once more.
    fireEvent.click(cell('wake')?.querySelector('button') as Element)
    await waitFor(() => { expect(container.querySelector(`[data-sovereignty-wake-resume="${SCHEDULE.id}"]`)).not.toBeNull() })
    expect(cell('wake')?.textContent).toContain('wake-seed-3 · 2025-11-08T11:06:40Z · alarm · Pearl epoch 162 · probe-only')
    fireEvent.click(container.querySelector(`[data-sovereignty-wake-resume="${SCHEDULE.id}"]`) as Element)
    expect(container.querySelector('[data-sovereignty-wake-confirm]')?.textContent).toContain('Resume "Daily wake"? It starts delivering again (every 24 h).')
    expect(edits).toHaveLength(1)
    fireEvent.click(container.querySelector('[data-sovereignty-wake-resume-confirm]') as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-answer]')?.textContent).toBe('Daily wake: resumed') })
    expect(edits.at(-1)).toMatchObject({ patch: { active: true }, expectedUpdatedAt: '2026-11-09T02:00:01.000Z' })
    expect(wakePosts).toHaveLength(1)
    // The host timer resumes at exactly the interval its confirm named.
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-resume="host"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-sovereignty-wake-resume="host"]') as Element)
    expect(container.querySelector('[data-sovereignty-wake-confirm]')?.textContent).toContain('It starts waking her again, every 24 h.')
    fireEvent.click(container.querySelector('[data-sovereignty-wake-resume-confirm]') as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-answer]')?.textContent).toBe('host timer: resumed') })
    expect(wakePosts.at(-1)).toEqual({ action: 'configure', enabled: true, intervalMs: 86_400_000 })
    // The signer and the pepper are on the same view.
    // Keys and trust says both in its one line (Round 25): the signer is not the owner's, and the pepper is not kept apart.
    await waitFor(() => { expect(cell('keys')?.textContent).toContain('NOT owner-anchored') })
    expect(cell('keys')?.textContent).toContain('pepper NOT separated')
    fireEvent.click(cell('keys')?.querySelector('button') as Element)
    await waitFor(() => { expect(cell('keys')?.textContent).toContain('NOT separated: kept in the same store as your sealed root') })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }, 30_000)

  it('a host with no schedule service says so, and pauses what it can see', async () => {
    let timer: Record<string, unknown> = { ...WAKE_ON }
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/_host/wake' && init?.method === 'POST') { timer = { ...timer, enabled: false, nextWakeAt: null }; return json(timer) }
      if (input === '/_host/wake') return json(timer)
      return new Response('nope', { status: 404 })
    }))
    const props = {
      activeSurface: CONTINUITY_SURFACE,
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState)),
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    const { container } = render(<ContinuitySurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-pause]')).not.toBeNull() }, { timeout: 10_000 })
    fireEvent.click(container.querySelector('[data-sovereignty-portal="wake"] button') as Element)
    // No schedule service here: the card's one line says the tasks were not read, with no row that only says so.
    expect(container.querySelector('[data-sovereignty-portal="wake"]')?.textContent).toContain('tasks not read')
    expect(container.querySelector('[data-sovereignty-portal="wake"]')?.textContent).not.toContain('this page has no schedule service')
    fireEvent.click(container.querySelector('[data-sovereignty-wake-pause]') as Element)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-wake-answer]')?.textContent)
      .toBe('host timer: paused · scheduled tasks: not read here, so not paused (this page has no schedule service on this host)') })
    // The tasks were never read here, so the card never says every wake is paused, and keeps the pause offered.
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="wake"]')?.textContent).toContain('NOT ALL READ') })
    expect(container.querySelector('[data-sovereignty-wake-pause]')).not.toBeNull()
  }, 30_000)
})

describe('the check at the click reads HEAD fresh (Round 24 review)', () => {
  it('HEAD moved on while the card was open: no Touch ID is asked for, and nothing is sent', async () => {
    let headNow = GENESIS.ballId
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(input)
      if (input === '/_host/aumlok/status') {
        return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
      }
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      // The lease answer names HEAD's selected Pearl; the full head read happens once, when the card opens.
      if (input === '/_head/lease') return json({ ok: true, lease: null, ballId: headNow, epoch: headNow === GENESIS.ballId ? 0 : 1, governancePromotion: true })
      if (input === '/_head/ball') {
        return json({ ok: true, buildSha: 'b'.repeat(40), head: { ballId: GENESIS.ballId, parentBallId: null, epoch: 0, entries: GENESIS.entries },
          modules: {}, peers: [] })
      }
      return new Response('nope', { status: 404 })
    }))
    const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
      phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
    const props = {
      activeSurface: SOVEREIGNTY_SURFACE,
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
      reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === '/dsh/home/auma/staged/head-promotion.json'
        ? { ok: true, text: JSON.stringify(STAGED_FILE) } : { ok: false, reason: 'not-found' }) },
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    const { container } = render(<SovereigntySurface {...props} />)
    const cell = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(cell()?.textContent).toContain('CLASS 3') }, { timeout: 10_000 })
    openCell(cell())
    const promote = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(promote()?.disabled).toBe(false) })
    headNow = 'cd'.repeat(32)
    ageCards()
    fireEvent.click(promote() as Element)
    await waitFor(() => { expect(cell()?.textContent).toContain('Checked again just now: HEAD would refuse it') })
    expect(cell()?.textContent).toContain('REBASE_REQUIRED')
    expect(posts).toEqual([])
  }, 30_000)
})

describe('Round 27: what the host says is never dropped or misread', () => {
  it('a host blocker that is not an AUMLOK_ code still blocks, so Keys and trust never offers a passkey HEAD would refuse', () => {
    const blocked = parseAumlokStatus({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32),
      blockers: ['NODE_KEY_IS_NOT_OWNER_KEY', 'free text, not a code', 'lower_case'] })
    if (blocked === null) throw new Error('status does not parse')
    // A named code is kept whatever its prefix; anything that is not a code is still dropped.
    expect(blocked.blockers).toEqual(['NODE_KEY_IS_NOT_OWNER_KEY'])
    const table = { kind: 'ok' as const, ranges: parseCheckpointPolicy(POLICY) ?? [] }
    const card = keysCardOf({ kind: 'live', status: blocked }, factsRead(FACTS), table, null)
    expect(card.badge).not.toBe('PASSKEY BOUND')
    expect(card.summary).toContain('passkey LOCKED')
    expect(JSON.stringify(card.rows)).toContain('NODE_KEY_IS_NOT_OWNER_KEY')
  })
  it('HEAD\'s two pre-commit 5xx refusals are refusals with their code; any other 5xx still reads HEAD again', async () => {
    const ballId = 'aa'.repeat(32)
    const answering = (status: number, code: string) => vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ ok: false, code }), { status })
      : new Response(JSON.stringify({ ok: true, head: { ballId: 'cc'.repeat(32), epoch: 162 } }), { status: 200 })))
    const signal = new AbortController().signal
    for (const [status, code] of [[507, 'PEARL_QUALIFICATION_CAPACITY'], [503, 'PEARL_QUALIFICATION_STATE_INVALID']] as const) {
      const fetchImpl = answering(status, code)
      expect(await publishApprovedPromotion({}, 'tok', ballId, signal, fetchImpl)).toEqual({ kind: 'refused', code })
      // A refusal is final: HEAD is not read again to look for a commit that cannot have happened.
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
    const other = answering(503, 'DURABLE_OBJECT_RESET')
    expect(await publishApprovedPromotion({}, 'tok', ballId, signal, other)).toMatchObject({ kind: 'unclear', headRead: 'not-on-head' })
    expect(other).toHaveBeenCalledTimes(2)
  })
})
