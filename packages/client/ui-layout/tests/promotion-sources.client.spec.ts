// @vitest-environment jsdom
/**
 * Lane B3: the two sources of a staged governance Pearl (her file, HEAD's record), merged by the one rule Sovereignty and
 * the chat's Fingerprint card share (portal/promotion-sources.ts), and the pieces both cards read with: the live-change
 * paths, the shared approval keys, the shared record of outward requests sent. Pure: no edge, no rendering. The whole path
 * against the real Worker is in r29-edge-e2e.client.spec.tsx.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  headPromotionBinding, parseHeadStaged, parseStagedPromotion, sameStagedBody, STAGED_PROMOTION_CHANGE, STAGED_PROMOTION_MAX_BYTES,
  STAGED_PROMOTION_PATH, type HeadLeaseRead, type HeadStagedRead, type HeadStagedRecord, type StagedPromotion,
} from '../src/client/spatial/aumlok/head-promotion.ts'
import {
  readStagedOutward, STAGED_OUTWARD_CHANGE, STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA,
} from '../src/client/spatial/aumlok/outward-class3.ts'
import { markSent, onSentChange, SENT_KEY, wasSent } from '../src/client/spatial/aumlok/outward-sent.ts'
import { mergePromotionSources, promotionContextOf, readHomePromotion } from '../src/client/spatial/portal/promotion-sources.ts'
import {
  headPromotionStateOf, promotionStateOf, type PromotionContext, type PromotionState,
} from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { mergeApprovalKey, outwardApprovalKey, pearlApprovalKey } from '../src/client/spatial/portal/touch-id-timing.ts'
import { createWorkReaderDoor } from '../src/client/spatial/work/index.ts'
import type { FileRead, WorkReader } from '../src/client/spatial/work/WorkSurface.tsx'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const ORIGIN = 'https://x61.example.invalid'

// HEAD's own canonical JSON, loaded from this checkout: the Pearl ids below are HEAD's canonical ids, byte for byte.
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as {
  canonicalJson: (value: unknown) => string
}

const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const entryOf = (id: string, code: string) => ({
  id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[],
})
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id, entryOf(id, code)]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  return { ...contents, ballId: sha(transition.canonicalJson(contents)) }
}
const V62 = { 'seed-pearl': codeOf('seed-pearl', 162), 'auma-notes': codeOf('auma-notes', 1) }
const GENESIS = ballOf(null, 162, V62)
const V63 = { ...V62, 'seed-pearl': codeOf('seed-pearl', 163) }
const NEXT = ballOf(GENESIS.ballId, 163, V63)
// Another Epoch 163 she might stage instead: the same organ, other code.
const V63B = { ...V62, 'seed-pearl': codeOf('seed-pearl', 6300) }
const OTHER = ballOf(GENESIS.ballId, 163, V63B)

/** Her staged file for a Pearl on GENESIS (`over` changes the body: a fault of the file alone). */
const fileOf = (ball = NEXT, codes: Record<string, string> = V63, over: Record<string, unknown> = {}) => JSON.stringify({
  schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 11, 2), body: { ball,
    codeBySha: { [sha(codes['seed-pearl'] ?? '')]: codes['seed-pearl'] }, expectedParentBallId: GENESIS.ballId, expectedEpoch: 162,
    writerLease: { ownerPeerId: 'auma-writer', generation: 1 }, ...over } })
const stagedOf = (text: string): StagedPromotion => {
  const staged = parseStagedPromotion(text)
  if (staged === null) throw new Error('not a staged promotion')
  return staged
}

/** HEAD's answer for NEXT staged on GENESIS, in the shape head-do.mjs builds it. */
const recordOf = async (over: Record<string, unknown> = {}): Promise<HeadStagedRecord> => {
  const fields = { ballId: NEXT.ballId, epoch: 163, parentBallId: GENESIS.ballId, changedEntries: ['seed-pearl'],
    t2Reasons: ['T2_PROTECTED_ORGAN'] }
  const binding = await headPromotionBinding({ audience: ORIGIN, ball: { ...NEXT, entries: NEXT.entries }, entryId: 'seed-pearl',
    previous: GENESIS.entries })
  const read = await parseHeadStaged({ ok: true, staged: {
    schema: 'aukora.staged-head-promotion.v1', ...fields, authorPeerId: 'auma-writer', tier: 'T2', governanceClass: 3, binding,
    candidateDigest: sha(transition.canonicalJson(fields)), stagedAt: Date.UTC(2026, 10, 11, 1), state: 'awaiting_owner',
    stagedForOwner: true,
    envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 11, 1), body: { ball: NEXT,
      codeBySha: { [sha(V63['seed-pearl'])]: V63['seed-pearl'] }, expectedParentBallId: GENESIS.ballId, expectedEpoch: 162 } },
    ...over,
  }, supersededStaged: null })
  if (read.kind !== 'staged') throw new Error(`not staged: ${read.kind}`)
  return read.record
}
const context = (over: Partial<PromotionContext> = {}): PromotionContext => ({
  published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 162 }, lease: null, canQualify: true, runtime: 'cloudflare',
  audience: ORIGIN, now: 1, freshHead: { ballId: GENESIS.ballId, epoch: 162 }, leaseUnread: null,
  requirements: { canonicalManifest: true, unchangedOtherEntries: true }, ...over })

/** Her file's card, classified as Sovereignty classifies it. */
const homeOf = async (text: string) => {
  const staged = stagedOf(text)
  return { state: await promotionStateOf(staged, context()), staged }
}
const held = async (over: Record<string, unknown> = {}): Promise<HeadStagedRead> => ({ kind: 'staged', record: await recordOf(over) })
/** HEAD's record, classified against the same context; counts the calls (her file's ready card never needs it). */
const classifier = () => {
  const calls: string[] = []
  return { calls, classify: async (record: HeadStagedRecord): Promise<PromotionState> => {
    calls.push(record.ballId)
    return headPromotionStateOf(record, context())
  } }
}
const readerOf = (files: Record<string, FileRead | Error>): WorkReader => ({
  whole: async (_session: unknown, path: string): Promise<FileRead> => {
    const file = files[path] ?? { ok: false, reason: 'not-found' }
    if (file instanceof Error) throw file
    return file
  },
})
const S1 = 's1' as SessionId
const signal = new AbortController().signal

afterEach(() => { vi.restoreAllMocks() })

describe('one Pearl from two sources, merged by Sovereignty\'s rule (Lane B3)', () => {
  it('HEAD holding none: her file\'s ready card is marked staged in this window only, and HEAD is not classified', async () => {
    const home = await homeOf(fileOf())
    expect(home.state).toMatchObject({ kind: 'staged', reasons: [] })
    const { calls, classify } = classifier()
    const state = await mergePromotionSources(home, { kind: 'none', superseded: null }, classify)
    expect(state).toMatchObject({ kind: 'staged', edgeEmpty: true, binding: { ballId: NEXT.ballId } })
    expect(state.kind === 'staged' ? state.source : 'not staged').toBeUndefined()
    expect(calls).toEqual([])
  })

  it('the same Pearl at home and on HEAD, her file\'s copy ready: her file\'s card, HEAD\'s record beside it', async () => {
    const record = await recordOf()
    const { calls, classify } = classifier()
    const state = await mergePromotionSources(await homeOf(fileOf()), { kind: 'staged', record }, classify)
    expect(state).toMatchObject({ kind: 'staged', reasons: [], onHead: { ballId: NEXT.ballId } })
    expect(state.kind === 'staged' ? [state.source, state.edgeEmpty] : state.kind).toEqual([undefined, undefined])
    // The page sends her file's bytes: HEAD's own copy is not even classified.
    expect(calls).toEqual([])
  })

  it('the same Pearl with a fault in her file\'s copy alone: HEAD\'s card, which HEAD promotes', async () => {
    const home = await homeOf(fileOf(NEXT, V63, { expectedEpoch: 161 }))
    expect(home.state.kind === 'staged' ? home.state.reasons.join(' | ') : home.state.kind).toContain('REBASE_REQUIRED')
    const { calls, classify } = classifier()
    const state = await mergePromotionSources(home, await held(), classify)
    expect(state).toMatchObject({ kind: 'staged', source: 'head', reasons: [] })
    expect(state.kind === 'staged' ? state.otherInHome : 'not staged').toBeUndefined()
    expect(calls).toEqual([NEXT.ballId])
  })

  it('the same Pearl, faulted at home and not ready on HEAD either: her file\'s card with its reasons, never offered', async () => {
    const home = await homeOf(fileOf(NEXT, V63, { expectedEpoch: 161 }))
    const state = await mergePromotionSources(home, await held({ candidateDigest: 'aa'.repeat(32) }), classifier().classify)
    expect(state).toMatchObject({ kind: 'staged', onHead: { ballId: NEXT.ballId } })
    expect(state.kind === 'staged' ? [state.source, state.reasons.length > 0] : state.kind).toEqual([undefined, true])
  })

  it('a different Pearl at home: HEAD\'s card, the other one named beside it (never offered)', async () => {
    const state = await mergePromotionSources(await homeOf(fileOf(OTHER, V63B)), await held(), classifier().classify)
    expect(state).toMatchObject({ kind: 'staged', source: 'head', reasons: [], binding: { ballId: NEXT.ballId },
      otherInHome: { ballId: OTHER.ballId, epoch: 163 } })
  })

  it('HEAD holding one while her file is malformed, absent or not read: HEAD\'s card alone', async () => {
    for (const home of [{ kind: 'malformed' } as const, { kind: 'absent' } as const, { kind: 'unreadable', why: 'no answer' } as const]) {
      const state = await mergePromotionSources({ state: home, staged: null }, await held(), classifier().classify)
      expect(state).toMatchObject({ kind: 'staged', source: 'head', reasons: [] })
      expect(state.kind === 'staged' ? state.otherInHome : 'not staged').toBeUndefined()
    }
  })

  it('HEAD not read: her file\'s card as it is (no edgeEmpty); with nothing of its own, "not known", never "nothing staged"', async () => {
    const unread: HeadStagedRead = { kind: 'unread', why: 'it answered 503' }
    const home = await homeOf(fileOf())
    const kept = await mergePromotionSources(home, unread, classifier().classify)
    expect(kept).toBe(home.state)
    expect(await mergePromotionSources({ state: { kind: 'absent' }, staged: null }, unread, classifier().classify))
      .toEqual({ kind: 'head-unread', why: 'it answered 503' })
    expect(await mergePromotionSources({ state: { kind: 'unreadable', why: 'her home could not be read (EIO)' }, staged: null }, unread,
      classifier().classify)).toEqual({ kind: 'head-unread', why: 'it answered 503', homeWhy: 'her home could not be read (EIO)' })
    // A host without the route says nothing: her file's card stands as it is, never marked as this window's only.
    const absent = await mergePromotionSources(home, { kind: 'absent' }, classifier().classify)
    expect(absent).toBe(home.state)
  })

  it('the classification context: the published head as read, HEAD\'s lease answer, nothing guessed', () => {
    const lease: HeadLeaseRead = { lease: null, canQualify: true, qualifyBlocker: null, head: { ballId: GENESIS.ballId, epoch: 162 },
      unread: null, requirements: { canonicalManifest: true, unchangedOtherEntries: true } }
    expect(promotionContextOf({ published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: '162' }, lease, runtime: 'cloudflare',
      audience: ORIGIN, now: 7 })).toEqual(context({ now: 7, qualifyBlocker: null }))
    // A published id or epoch not in HEAD's form is null; a head not read has no entries.
    const unread = { entries: null, ballId: '—', epoch: '—' }
    expect(promotionContextOf({ published: unread, lease, runtime: 'local', audience: ORIGIN, now: 7 }).published)
      .toEqual({ entries: null, ballId: null, epoch: null })
    expect(promotionContextOf({ published: null, lease, runtime: 'other', audience: ORIGIN, now: 7 })).toMatchObject({
      published: { entries: null, ballId: null, epoch: null }, runtime: 'other' })
  })
})

describe('her staged files, read the one way every card reads them (Lane B3)', () => {
  it('her staged Pearl: absent, not read, malformed, too large, or the Pearl', async () => {
    const at = (file: FileRead | Error) => readHomePromotion(readerOf({ [STAGED_PROMOTION_PATH]: file }), S1, signal)
    expect(await readHomePromotion(readerOf({}), undefined, signal))
      .toEqual({ kind: 'unreadable', why: 'no session is open to read her home' })
    expect(await readHomePromotion(readerOf({}), S1, signal)).toEqual({ kind: 'absent' })
    expect(await at({ ok: false, reason: 'EACCES' })).toEqual({ kind: 'unreadable', why: 'her home could not be read (EACCES)' })
    expect(await at(new Error('gone'))).toEqual({ kind: 'unreadable', why: 'her home could not be read (no answer)' })
    expect(await at({ ok: true, text: '{"schema":"something else"}' })).toEqual({ kind: 'malformed' })
    expect(await at({ ok: true, text: ' '.repeat(STAGED_PROMOTION_MAX_BYTES + 1) }))
      .toEqual({ kind: 'malformed', why: 'larger than 4 MiB, the most her worker stages' })
    expect(await at({ ok: true, text: fileOf() })).toMatchObject({ kind: 'staged', staged: { ball: { ballId: NEXT.ballId, epoch: 163 } } })
  })

  it('two reads of her Pearl are the same bytes but for the writer lease the page replaces', () => {
    const first = stagedOf(fileOf())
    expect(sameStagedBody(first, stagedOf(fileOf(NEXT, V63, { writerLease: { ownerPeerId: 'auma-writer', generation: 9 } })))).toBe(true)
    expect(sameStagedBody(first, stagedOf(fileOf(NEXT, V63, { expectedEpoch: 161 })))).toBe(false)
    expect(sameStagedBody(first, stagedOf(fileOf(OTHER, V63B)))).toBe(false)
  })

  it('her outward request: none, malformed, or the request', async () => {
    const args = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'Unit', body: 'x' } }
    const request = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_github', method: 'POST',
      pathname: '/_host/github', body: args })
    const at = (file: FileRead | Error) => readStagedOutward(readerOf({ [STAGED_OUTWARD_PATH]: file }), S1, signal)
    expect(await readStagedOutward(readerOf({}), undefined, signal)).toEqual({ kind: 'none' })
    expect(await readStagedOutward(readerOf({}), S1, signal)).toEqual({ kind: 'none' })
    expect(await at(new Error('gone'))).toEqual({ kind: 'none' })
    expect(await at({ ok: true, text: '{}' })).toEqual({ kind: 'malformed' })
    expect(await at({ ok: true, text: request }))
      .toMatchObject({ kind: 'staged', staged: { tool: 'x6_github', pathname: '/_host/github' } })
  })

  it('live changes: her staged Pearl or her head file, and her outward request, named with or without the /dsh root', () => {
    for (const path of ['home/auma/staged/head-promotion.json', '/dsh/home/auma/staged/head-promotion.json', 'home/balls/HEAD.json',
      '/dsh/home/balls/HEAD.json']) expect(STAGED_PROMOTION_CHANGE.test(path)).toBe(true)
    for (const path of ['home/auma/memory/dag/HEAD.json', 'home/auma/staged/outward-class3.json',
      'home/auma/staged/head-promotion.json.tmp', 'xhome/auma/staged/head-promotion.json']) {
      expect(STAGED_PROMOTION_CHANGE.test(path)).toBe(false)
    }
    for (const path of ['home/auma/staged/outward-class3.json', '/dsh/home/auma/staged/outward-class3.json']) {
      expect(STAGED_OUTWARD_CHANGE.test(path)).toBe(true)
    }
    expect(STAGED_OUTWARD_CHANGE.test('home/auma/staged/head-promotion.json')).toBe(false)
  })
})

describe('what the chat card and Sovereignty share for an outward request (Lane B3)', () => {
  it('one approval key per item, the same in every card', () => {
    expect(outwardApprovalKey('{"a":1}')).toBe('outward:{"a":1}')
    expect(pearlApprovalKey('ab')).toBe('pearl:ab')
    expect(mergeApprovalKey('c')).toBe('merge:c')
  })

  it('a request marked sent is sent for every card on the page, which is told at once', () => {
    const told: number[] = []
    const off = onSentChange(() => { told.push(1) })
    expect(wasSent('{"unit":"one"}')).toBe(false)
    markSent('{"unit":"one"}')
    expect(wasSent('{"unit":"one"}')).toBe(true)
    expect(told).toEqual([1])
    // Other tabs read it from localStorage.
    expect(JSON.parse(globalThis.localStorage.getItem(SENT_KEY) ?? '[]')).toContain('{"unit":"one"}')
    off()
    markSent('{"unit":"two"}')
    expect(told).toEqual([1])
  })

  it('with localStorage refused (a private window), the page\'s own record still holds', () => {
    const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse)
    expect(wasSent('{"unit":"private"}')).toBe(false)
    markSent('{"unit":"private"}')
    expect(wasSent('{"unit":"private"}')).toBe(true)
  })
})

describe('the chat lane finds the page\'s reader of her files (Lane B3)', () => {
  it('through a door: empty until the files service is there, and every watcher is told when it comes and goes', () => {
    const door = createWorkReaderDoor()
    expect(door.current()).toBeNull()
    const told: (WorkReader | null)[] = []
    const off = door.subscribe(() => { told.push(door.current()) })
    const reader = readerOf({})
    door.set(reader)
    door.set(null)
    expect(told).toEqual([reader, null])
    off()
    door.set(reader)
    expect(told).toHaveLength(2)
    expect(door.current()).toBe(reader)
  })
})
