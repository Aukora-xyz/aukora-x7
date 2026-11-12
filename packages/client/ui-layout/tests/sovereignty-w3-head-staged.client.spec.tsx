/**
 * Wave 3, Seam 2: the promotion HEAD holds itself, as the page reads and promotes it (aumlok/head-promotion.ts). The whole
 * path against the real Worker and HEAD (stage, read back, Touch ID, promote) is in r29-edge-e2e.client.spec.tsx; this
 * file holds the edges that path cannot reach: a record that disagrees with its own bytes, a held lease, a lost answer.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  candidateDigestOf, classifyHeadTransition, configChangeWords, describeGovernanceChange, GOVERNANCE_ORGANS, headPromotionBinding,
  headRecordProblems, parseHeadStaged, promoteStagedOnHead, PROMOTION_STATUS_MAX_BYTES, readHeadStaged, STAGED_PROMOTION_MAX_BYTES,
  type HeadStagedRecord, type LandStep,
} from '../src/client/spatial/aumlok/head-promotion.ts'
import { headPromotionStateOf, headRecordRows, landStepWords, type PromotionContext } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { parseLiveMessage } from '../src/client/spatial/work/autonomy.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const ORIGIN = 'https://x61.example.invalid'

// HEAD's own canonical JSON, loaded from this checkout: the digest this page recomputes is HEAD's digest, byte for byte.
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as {
  canonicalJson: (value: unknown) => string
  T2_ONLY_ORGANS: readonly string[]
}
const serverCanonicalJson = transition.canonicalJson

const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const entryOf = (id: string, code: string) => ({ id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] })
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id, entryOf(id, code)]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  // The canonical id (head-do.mjs manifestIdCanon): the hash of every field but the id, keys sorted.
  return { ...contents, ballId: sha(serverCanonicalJson(contents)) }
}
const V62 = { 'seed-pearl': codeOf('seed-pearl', 162), 'auma-notes': codeOf('auma-notes', 1) }
const GENESIS = ballOf(null, 162, V62)
const V63 = { ...V62, 'seed-pearl': codeOf('seed-pearl', 163) }
const NEXT = ballOf(GENESIS.ballId, 163, V63)

/** HEAD's answer for NEXT staged on GENESIS, in the shape head-do.mjs `readStaged` and the promotion-status route build. */
const statusBody = async (over: Record<string, unknown> = {}) => {
  const fields = { ballId: NEXT.ballId, epoch: 163, parentBallId: GENESIS.ballId, changedEntries: ['seed-pearl'], t2Reasons: ['T2_PROTECTED_ORGAN'] }
  const binding = await headPromotionBinding({ audience: ORIGIN, ball: { ...NEXT, entries: NEXT.entries }, entryId: 'seed-pearl', previous: GENESIS.entries })
  return { ok: true, lease: null, ballId: GENESIS.ballId, epoch: 162, staged: {
    schema: 'aukora.staged-head-promotion.v1', ...fields, authorPeerId: 'auma-writer', tier: 'T2', governanceClass: 3, binding,
    candidateDigest: sha(serverCanonicalJson(fields)), compactModuleShas: [sha(V63['seed-pearl'])], stagedAt: Date.UTC(2026, 10, 11, 1),
    state: 'awaiting_owner', stagedForOwner: true,
    envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 11, 1), body: { ball: NEXT,
      codeBySha: { [sha(V63['seed-pearl'])]: V63['seed-pearl'] }, expectedParentBallId: GENESIS.ballId, expectedEpoch: 162 } },
    ...over,
  }, supersededStaged: null, lastPublishOutcome: null, peers: [] }
}
const recordOf = async (over: Record<string, unknown> = {}): Promise<HeadStagedRecord> => {
  const read = await parseHeadStaged(await statusBody(over))
  if (read.kind !== 'staged') throw new Error(`not staged: ${read.kind}`)
  return read.record
}
const context = (over: Partial<PromotionContext> = {}): PromotionContext => ({
  published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 162 }, lease: null, canQualify: true, runtime: 'cloudflare',
  audience: ORIGIN, now: 1, freshHead: { ballId: GENESIS.ballId, epoch: 162 }, leaseUnread: null,
  requirements: { canonicalManifest: true, unchangedOtherEntries: true }, ...over })

describe('HEAD\'s own staged record, as the page reads it (Wave 3)', () => {
  it('reads the record, the staged bytes beside it, and recomputes HEAD\'s digest with HEAD\'s own canonical JSON', async () => {
    const record = await recordOf()
    expect(record).toMatchObject({ ballId: NEXT.ballId, epoch: 163, parentBallId: GENESIS.ballId, changedEntries: ['seed-pearl'],
      t2Reasons: ['T2_PROTECTED_ORGAN'], tier: 'T2', governanceClass: 3, digestMatches: true })
    expect(record.candidateDigest).toBe(await candidateDigestOf(record))
    expect(record.promotion?.ball.ballId).toBe(NEXT.ballId)
    // The digest names no clock: staged again later, it is the same.
    expect((await recordOf({ stagedAt: Date.UTC(2027, 0, 1) })).candidateDigest).toBe(record.candidateDigest)
    const state = await headPromotionStateOf(record, context())
    expect(state).toMatchObject({ kind: 'staged', source: 'head', reasons: [], binding: record.binding })
    expect(headRecordRows(record).rows).toEqual([
      ['held on HEAD', 'epoch 163 · changes seed-pearl'],
      ['why HEAD holds it', 'T2_PROTECTED_ORGAN'],
      ['candidate digest', `${String(record.candidateDigest)} (the hash of the fields above, checked here)`],
    ])
  })

  it('nothing staged, a superseded record, and an answer that is not HEAD\'s are told apart', async () => {
    expect(await parseHeadStaged({ ok: true, staged: null, supersededStaged: null })).toEqual({ kind: 'none', superseded: null })
    expect(await parseHeadStaged({ ok: true, staged: null, supersededStaged: { ballId: NEXT.ballId, epoch: 163,
      parentBallId: GENESIS.ballId,
      state: 'published', stagedAt: 1 } })).toEqual({ kind: 'none', superseded: { ballId: NEXT.ballId, epoch: 163, state: 'published' } })
    for (const body of [null, 7, { ok: false, code: 'NOT_FOUND' }, { ok: true }, { ok: true, staged: { ballId: 'short', epoch: 1 } }]) {
      expect((await parseHeadStaged(body)).kind).toBe('unread')
    }
    const signal = new AbortController().signal
    // A host with no such route (the Mac host, an older edge) is not a failed read: nothing is missing there.
    expect(await readHeadStaged(signal, async () => json({ ok: false, code: 'NOT_FOUND' }, 404))).toEqual({ kind: 'absent' })
    expect(await readHeadStaged(signal, async () => json({ ok: false, code: 'CLOUD_CAPABILITY_UNAVAILABLE' }, 501))).toEqual({ kind: 'absent' })
    // A route that exists and fails is: what HEAD holds is then not known.
    expect(await readHeadStaged(signal, async () => json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503)))
      .toEqual({ kind: 'unread', why: 'it answered 503' })
    expect(await readHeadStaged(signal, async () => new Response('<html>', { status: 200 })))
      .toEqual({ kind: 'unread', why: 'its answer was not JSON' })
    expect(await readHeadStaged(signal, async () => { throw new TypeError('offline') }))
      .toEqual({ kind: 'unread', why: 'it did not answer' })
    // The same fixed ceiling before JSON.parse as her staged file.
    expect(PROMOTION_STATUS_MAX_BYTES).toBeGreaterThan(STAGED_PROMOTION_MAX_BYTES)
    const huge = (async () => new Response(' '.repeat(PROMOTION_STATUS_MAX_BYTES + 1), { status: 200 })) as unknown as typeof fetch
    expect(await readHeadStaged(signal, huge)).toEqual({ kind: 'unread', why: 'its answer was larger than a staged promotion can be' })
  })

  it('a record that disagrees with the bytes beside it, or with the terms the page computes, is never offered', async () => {
    const good = await recordOf()
    const computed = good.binding
    if (computed === null) throw new Error('no binding')
    expect(headRecordProblems(good, computed)).toEqual([])
    // HEAD's record names other terms than the bytes it serves: the passkey is not asked for terms the page only received.
    const otherTerms = await recordOf({ binding: { ...computed, candidateSha256: 'ee'.repeat(32) } })
    const stopped = await headPromotionStateOf(otherTerms, context())
    expect(stopped.kind === 'staged' ? stopped.reasons : stopped.kind)
      .toEqual(['the passkey terms HEAD recorded differ from the terms this page computes from the staged bytes, so nothing is asked'])
    // The page asks for its own computed terms only: the binding on the card is never the record's.
    expect(stopped.kind === 'staged' ? stopped.binding : null).toEqual(computed)
    const noTerms = await recordOf({ binding: null, governanceClass: 1 })
    expect(headRecordProblems(noTerms, computed)).toEqual(['HEAD recorded no passkey terms for it (its own governance class: 1), so this page asks for none'])
    const wrongDigest = await recordOf({ candidateDigest: 'aa'.repeat(32) })
    expect(headRecordProblems(wrongDigest, computed)).toEqual(['HEAD\'s candidate digest is not the hash of the fields it is served with'])
    expect(headRecordRows(wrongDigest).rows[2]?.[1]).toContain('NOT the hash of the fields above')
    // A record that names one Pearl beside the bytes of another.
    const wrongBytes = await recordOf({ ballId: 'ab'.repeat(32) })
    expect(headRecordProblems(wrongBytes, computed)).toContain('the staged bytes HEAD serves are not the Pearl its record names')
    // No bytes served at all: shown as held, nothing offered.
    expect(await headPromotionStateOf(await recordOf({ envelope: null }), context())).toMatchObject({ kind: 'head-blocked' })
    // HEAD moved on since the card read the published head: the same reason as for her staged file.
    const moved = await headPromotionStateOf(good, context({ freshHead: { ballId: 'cd'.repeat(32), epoch: 163 } }))
    expect(moved.kind === 'staged' ? moved.reasons.join(' | ') : moved.kind).toContain('HEAD has moved on since this card read it')
  })

  it('the page names the same governance organs as HEAD, so the two classify a change alike', async () => {
    // HEAD's list (server/ball-transition.mjs T2_ONLY_ORGANS, the edge's OWNER_GOVERNANCE_ORGANS). A widening there fails here.
    expect([...GOVERNANCE_ORGANS]).toEqual([...transition.T2_ONLY_ORGANS])
    expect(GOVERNANCE_ORGANS).toHaveLength(15)
    // An organ HEAD added after Round 24 is a governance change to the page too (it was "no passkey needed" before).
    for (const organ of ['auma-scion', 'seed-boot', 'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys']) {
      const before = { [organ]: { specifier: `ball:${'a'.repeat(64)}`, disabled: false, config: {} } }
      const after = { [organ]: { specifier: `ball:${'b'.repeat(64)}`, disabled: false, config: {} } }
      expect(classifyHeadTransition(before, after)).toEqual({ class: 3, entryIds: [organ] })
    }
    expect(classifyHeadTransition({ 'auma-notes': { specifier: 'x' } }, { 'auma-notes': { specifier: 'y' } }).class).toBe(1)
    // HEAD's record saying class 3 while the page reads none is said as a disagreement, never as HEAD's own rule.
    const plainCodes = { ...V62, 'auma-notes': codeOf('auma-notes', 2) }
    const plain = ballOf(GENESIS.ballId, 163, plainCodes)
    const disagree = await recordOf({ ballId: plain.ballId, governanceClass: 3, envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: 1,
      body: { ball: plain, codeBySha: {}, expectedParentBallId: GENESIS.ballId, expectedEpoch: 162 } } })
    const state = await headPromotionStateOf(disagree, context())
    expect(state.kind === 'head-blocked' ? state.why : state.kind).toContain('HEAD\'s record calls this a governance change (class 3), but this '
      + 'page\'s own reading of the staged bytes finds none')
  })

  it('a config change is always shown as a difference, however long the config', () => {
    expect(configChangeWords({}, { strict: false })).toBe('changes its config: strict added: false')
    expect(configChangeWords({ strict: true, mode: 'a' }, { mode: 'b' })).toBe('changes its config: mode: "a" → "b"; strict removed (was true)')
    // Two long configs that differ only past any clip: the words still show where.
    const long = { allow: Array.from({ length: 60 }, (_unused, index) => `path-${String(index)}`) }
    const longer = { allow: [...long.allow.slice(0, 59), 'path-EVIL'] }
    const words = configChangeWords(long, longer)
    const [left, right] = words.replace('changes its config: allow: ', '').split(' → ')
    expect(left).not.toBe(right?.replace(/ \(\d+ → \d+ characters\)$/u, ''))
    expect(words).toContain('path-EVIL')
    expect(words).toMatch(/\(\d+ → \d+ characters\)$/u)
    // A difference that runs past what is shown is said; and every changed key is named, however many.
    const wide = configChangeWords({ note: 'a'.repeat(300) }, { note: 'b'.repeat(300) })
    expect(wide).toContain('more of it differs beyond what is shown')
    const many = Object.fromEntries(Array.from({ length: 9 }, (_unused, index) => [`k${String(index)}`, index]))
    expect(configChangeWords({}, many)).toContain('; also changes k6, k7, k8')
    expect(configChangeWords('a', ['a'])).toBe('changes its config: "a" → ["a"]')
    const entry = { specifier: 'ball:x', disabled: false, config: long }
    expect(describeGovernanceChange(entry, { ...entry, config: longer })[0]).toContain('path-EVIL')
  })

  it('a `head:staged` push is only the fact of a staging: nothing in the frame is read', () => {
    expect(parseLiveMessage({ type: 'head:staged', staged: { ballId: NEXT.ballId } })).toEqual({ kind: 'head-staged' })
    expect(parseLiveMessage(JSON.stringify({ type: 'head:staged', staged: { ballId: NEXT.ballId, epoch: 163 } }))).toEqual({ kind: 'head-staged' })
    // Not valid JSON past its first bytes: still only the fact (the frame is never parsed).
    expect(parseLiveMessage('{"type":"head:staged","staged":{')).toEqual({ kind: 'head-staged' })
    expect(parseLiveMessage({ type: 'head:promoted' })).toBeNull()
  })
})

type Answer = readonly [number, unknown] | Error
/** HEAD's promote route, scripted answer by answer; `/_head/lease` names the head when asked. */
const scripted = (promotes: readonly Answer[], headBallId: string | null = GENESIS.ballId,
  lease: { ownerPeerId: string; generation: number; expiresAt: number } | null = null) => {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []
  let next = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
      headers: { ...(init?.headers as Record<string, string> | undefined) } })
    if (url === '/_head/promote' && method === 'POST') {
      const answer = promotes[Math.min(next, promotes.length - 1)]
      next += 1
      if (answer === undefined) throw new Error('no scripted answer')
      if (answer instanceof Error) throw answer
      return json(answer[1], answer[0])
    }
    if (url === '/_head/lease' && method === 'GET') {
      return headBallId === null ? json({ ok: false }, 503)
        : json({ ok: true, lease, ballId: headBallId, epoch: headBallId === NEXT.ballId ? 163 : 162 })
    }
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, promotes: () => calls.filter(call => call.url === '/_head/promote') }
}
const clocked = (start = 1_000_000) => {
  let at = start
  const end = start + 300_000
  return { now: () => at, wait: async (ms: number) => { at += ms }, left: () => end - at }
}
const LANDED: Answer = [200, { ok: true, ballId: NEXT.ballId, epoch: 163, tier: 'T2' }]
/** What HEAD's promote route really answers a held lease (head-do.mjs): the code alone, the lease not named. */
const HELD: Answer = [423, { ok: false, code: 'WRITER_LEASE_HELD', status: 423 }]
const promote = (head: ReturnType<typeof scripted>, clock = clocked(), steps: LandStep[] = []) => promoteStagedOnHead({ ballId: NEXT.ballId,
  token: 'tok', approvalLeftMs: clock.left, signal: new AbortController().signal, fetchImpl: head.fetchImpl, now: clock.now, wait: clock.wait,
  onStep: (step) => { steps.push(step) } })

describe('asking HEAD to promote the Pearl it holds (POST /_head/promote)', () => {
  it('sends the Pearl\'s id and the approval, nothing else, and lands only as that Pearl', async () => {
    const head = scripted([LANDED])
    const steps: LandStep[] = []
    expect(await promote(head, clocked(), steps)).toEqual({ kind: 'landed' })
    expect(head.calls).toHaveLength(1)
    expect(head.calls[0]).toMatchObject({ url: '/_head/promote', method: 'POST', body: { ballId: NEXT.ballId },
      headers: { 'x-x6-class3-approval': 'tok', 'content-type': 'application/json' } })
    expect(steps).toEqual([{ kind: 'promoting' }])
    expect(landStepWords({ kind: 'promoting' })).toBe('Approved. Asking HEAD to promote the Pearl it holds…')
    // An ok that names another Pearl is not taken as this one: HEAD is read again, and this Pearl is not on it.
    const other = scripted([[200, { ok: true, ballId: 'ab'.repeat(32), epoch: 163 }]])
    expect(await promote(other)).toEqual({ kind: 'unclear', detail: 'HEAD answered 200', headRead: 'not-on-head' })
  })

  it('a writer lease someone holds is waited for (her worker writing), and the approval is not used meanwhile', async () => {
    const clock = clocked()
    // The route does not name the lease, so the page reads it (GET /_head/lease) for the holder and the lapse.
    const head = scripted([HELD, HELD, LANDED], GENESIS.ballId, { ownerPeerId: 'auma-writer', generation: 9, expiresAt: clock.now() + 4_000 })
    const steps: LandStep[] = []
    expect(await promote(head, clock, steps)).toEqual({ kind: 'landed' })
    expect(head.promotes()).toHaveLength(3)
    expect(steps.filter(step => step.kind === 'waiting')).toEqual([{ kind: 'waiting', heldBy: 'auma-writer', seconds: 5 },
      { kind: 'waiting', heldBy: 'auma-writer', seconds: 1 }])
    // An answer that does name the lease is used as it is, with no second read.
    const named = scripted([[423, { ok: false, code: 'WRITER_LEASE_HELD', lease: { ownerPeerId: 'other', generation: 3, expiresAt: clock.now() + 2_000 } }],
      LANDED])
    const namedSteps: LandStep[] = []
    expect(await promote(named, clock, namedSteps)).toEqual({ kind: 'landed' })
    expect(namedSteps.find(step => step.kind === 'waiting')).toMatchObject({ heldBy: 'other' })
    expect(named.calls.filter(call => call.url === '/_head/lease')).toHaveLength(0)
    // A held lease that cannot be read is asked for again every 5 s, never every second.
    // A lease that is free again by the time it is read is asked for at once, and a head that already is this Pearl
    // (another window's approval landed it) is a landing.
    const freed = scripted([HELD, LANDED])
    const freedSteps: LandStep[] = []
    expect(await promote(freed, clocked(), freedSteps)).toEqual({ kind: 'landed' })
    expect(freedSteps.find(step => step.kind === 'waiting')).toEqual({ kind: 'waiting', heldBy: null, seconds: 1 })
    const landedMeanwhile = scripted([HELD], NEXT.ballId)
    expect(await promote(landedMeanwhile)).toEqual({ kind: 'landed' })
    expect(landedMeanwhile.promotes()).toHaveLength(1)
    const blind = scripted([HELD, LANDED], null)
    const blindSteps: LandStep[] = []
    expect(await promote(blind, clocked(), blindSteps)).toEqual({ kind: 'landed' })
    expect(blindSteps.find(step => step.kind === 'waiting')).toEqual({ kind: 'waiting', heldBy: null, seconds: 5 })
    // Held until the approval is nearly over: nothing more is sent, and the card says who held it.
    const late = clocked()
    const busy = scripted([HELD], GENESIS.ballId, { ownerPeerId: 'auma-writer', generation: 9, expiresAt: late.now() + 600_000 })
    expect(await promote(busy, late)).toEqual({ kind: 'not-sent', why: 'lease-busy', heldBy: 'auma-writer' })
    expect(late.left()).toBeGreaterThanOrEqual(10_000)
  })

  it('HEAD\'s own refusals are refusals; a record already published as this Pearl is a landing; an expiring approval is not sent', async () => {
    for (const code of ['CANDIDATE_UNKNOWN', 'CANDIDATE_SUPERSEDED', 'CLASS3_WEBAUTHN_REQUIRED', 'REBASE_REQUIRED']) {
      expect(await promote(scripted([[code === 'CANDIDATE_UNKNOWN' ? 404 : 409, { ok: false, code }]]))).toEqual({ kind: 'refused', code })
    }
    // HEAD no longer holding it may mean another window's approval landed it (HEAD drops its record on a landing): the
    // Pearl is looked for on HEAD before that is called a refusal.
    for (const code of ['CANDIDATE_UNKNOWN', 'CANDIDATE_SUPERSEDED']) {
      const landedElsewhere = scripted([[code === 'CANDIDATE_UNKNOWN' ? 404 : 409, { ok: false, code }]], NEXT.ballId)
      expect(await promote(landedElsewhere)).toEqual({ kind: 'landed' })
      expect(landedElsewhere.calls.map(call => call.url)).toEqual(['/_head/promote', '/_head/lease'])
    }
    expect(await promote(scripted([[507, { ok: false, code: 'PEARL_QUALIFICATION_CAPACITY' }]]))).toEqual({ kind: 'refused', code: 'PEARL_QUALIFICATION_CAPACITY' })
    expect(await promote(scripted([[409, { ok: false, code: 'ALREADY_PUBLISHED', supersededStaged: { ballId: NEXT.ballId, state: 'published' } }]])))
      .toEqual({ kind: 'landed' })
    // ALREADY_PUBLISHED for another Pearl is HEAD's refusal of this one.
    expect(await promote(scripted([[409, { ok: false, code: 'ALREADY_PUBLISHED', supersededStaged: { ballId: 'ab'.repeat(32), state: 'published' } }]])))
      .toEqual({ kind: 'refused', code: 'ALREADY_PUBLISHED' })
    const nearlyOver = scripted([LANDED])
    expect(await promoteStagedOnHead({ ballId: NEXT.ballId, token: 'tok', approvalLeftMs: () => 9_999, signal: new AbortController().signal,
      fetchImpl: nearlyOver.fetchImpl })).toEqual({ kind: 'not-sent', why: 'approval-expiring' })
    expect(nearlyOver.calls).toEqual([])
    const stopped = new AbortController()
    stopped.abort()
    expect(await promoteStagedOnHead({ ballId: NEXT.ballId, token: 'tok', approvalLeftMs: () => 300_000, signal: stopped.signal,
      fetchImpl: nearlyOver.fetchImpl })).toEqual({ kind: 'not-sent', why: 'stopped' })
  })

  it('a lost or 5xx answer may hide a commit: HEAD is read again, and the Pearl looked for', async () => {
    // The commit happened and the answer was lost.
    expect(await promote(scripted([new TypeError('connection lost')], NEXT.ballId))).toEqual({ kind: 'landed' })
    // It did not: said as unclear, with what the second read showed.
    expect(await promote(scripted([new TypeError('connection lost')]))).toEqual({ kind: 'unclear', detail: 'HEAD did not answer', headRead: 'not-on-head' })
    expect(await promote(scripted([[503, { ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }]], null)))
      .toEqual({ kind: 'unclear', detail: 'HEAD answered 503 HEAD_STORAGE_UNAVAILABLE', headRead: 'unread' })
  })
})
