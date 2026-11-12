// @vitest-environment jsdom
/**
 * The host's `/__x6/facts`, read once per poll with a deadline and a size cap, and set beside this tab's own
 * recomputation. The fixture is a host's facts answer (synthetic).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LiveChannel, LiveSocket } from '../src/client/spatial/work/autonomy.ts'
import {
  compareTabToHost, forecastWords, HOST_FACTS_PATH, hostCheckpointWords, hostFactsWords, parseHostFacts, parseSurvivor, provenanceWords,
  hostRowSuffix, nodeWords, parseNodeFacts, readHostFacts, signerWords, taskWords, useHostFacts, type FactsAgreement, type HostFactsRead,
  type TabFacts,
} from '../src/client/spatial/work/host-facts.ts'
import { failureKind, tabFactsOf, WORK_SURFACE, WorkSurface, type FileRead } from '../src/client/spatial/work/WorkSurface.tsx'
import type { BridgePhase, BridgeReceipts } from '../src/client/spatial/work/bridge.ts'
import { en } from '../src/client/spatial/work/labels.ts'
import { ownerGrantRefusal, type OwnerGrantTerms } from '../src/client/spatial/work/owner-grant-terms.ts'
import { BALL_HEAD_PATH } from '../src/client/spatial/work/work-model.ts'
import {
  approvalsWords, fetchMirrorSnapshot, ownerAuthorityOf, promotionStateOf, readHeadOf,
  SNAPSHOT_ROUTE, snapshotFileName, snapshotWords, SOVEREIGNTY_SURFACE, SovereigntySurface, type PromotionContext,
} from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { chainCardOf, keysCardOf } from '../src/client/spatial/portal/sovereignty-cards.ts'
import { AuraPentoraSurface, arithmeticWords } from '../src/client/spatial/aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE } from '../src/client/spatial/aura/model.ts'
import { AURA_PATH } from '../src/client/spatial-components.tsx'
import { PENTORA36_URL } from '../src/client/spatial/aura/pentora-wasm.ts'
import { AumlokSurface, aumlokStateRead, ownerKeyWords, passkeyWords } from '../src/client/spatial/aumlok/AumlokSurface.tsx'
import { AUMLOK_NO_CONTROLLER, type AumlokControlProjectionState } from '../src/client/spatial/aumlok/control-state.ts'
import { en as AUMLOK_EN } from '../src/client/spatial/aumlok/locales.ts'
import {
  AUMLOK_KDF_ITERATIONS, AUMLOK_NODE_DOMAIN, AUMLOK_OUTCOME_UNKNOWN, AUMLOK_PHRASE_SPACE, AUMLOK_SETTLED_AS_THIS_CEREMONY,
  AUMLOK_SETTLED_BY_STATUS, AUMLOK_VOCABULARY,
  aumlokCeremonyAvailability,
  aumlokCommitment, aumlokPhraseAt,
  aumlokPhraseIndex, createBrowserCeremony, generateAumlokPhrase, parseAumlokPhrase, parseAumlokStatus, uniformBelow, uniformIndex,
  type AumlokHostCall, type AumlokHostStatus, type AumlokPlatform,
} from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import {
  AUMLOK_SEAL_ITERATIONS, aumlokMlDsaSeedOf, aumlokNodeOf, openAumlokRoot, parseSealedRoot, sealAumlokRoot, type AumlokSealedRoot,
} from '../src/client/spatial/aumlok/aumlok-root.ts'
import {
  approveClass3, canonicalJson as pageCanonicalJson, CLASS3_APPROVAL_HEADER, class3Action, sendApprovedClass3,
} from '../src/client/spatial/aumlok/class3-approval.ts'
import {
  classifyHeadTransition, describeGovernanceChange, headPromotionBinding, manifestIdMatches, manifestProblem, parseStagedPromotion,
  publishApprovedPromotion, STAGED_PROMOTION_PATH, type HeadEntry,
} from '../src/client/spatial/aumlok/head-promotion.ts'
import type { HostAnswer } from '../src/client/spatial/apps/identity/host.ts'
import { base64url, readChallenge, type PasskeyResponseJson } from '../src/client/spatial/apps/identity/webauthn.ts'
import { handoffOf, projectPearl, suiteDigests } from '../../../../apps/web/src/spatial/superagent/aura.ts'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, pbkdf2Sync } from 'node:crypto'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

/** Approval cards draw open (Lane B2): a card is opened only if it is closed, never toggled shut. */
const openCell = (cell: Element | null | undefined): void => {
  const head = cell?.querySelector('button')
  if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
}
/** The card's check is older than FRESH_CHECK_MS, so the click checks again first (Safari's fast path does not apply). */
const ageCards = (): void => { const real = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000) }


class FakeChannel implements LiveChannel {
  onmessage: LiveChannel['onmessage'] = null
  close() {}
}
class FakeSocket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  close() {}
}
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const BALL = '8c1f5e34f0136fc915dac89da2918f783ad21bc84f6ec6772d7abf08e4101f90'
/** A host's facts answer (synthetic; receiptsByKind trimmed to the fields the page reads). */
const LIVE = {
  ok: true, runtime: 'local', epoch: 9, ballId: BALL, organCount: 26, activeOrganCount: 26, receiptTotal: 97, receiptsVerified: 97,
  receiptsByKind: { 'aura.signal': 3, 'tree.patch': 30 }, checkpointsTotal: 5, lastCheckpointSeq: 5, lastCheckpointReceiptCount: 95,
  dagReachable: 3, dagDeclared: 3, auraStatus: 'alert', wakeUrgency: 1, receiptVerification: 'hash-and-chain',
  checkpointVerification: 'signature-and-receipt-prefix', checkpointSignerTrust: 'unpinned', evidenceStatus: 'complete',
  organCounts: 'declared-enabled-not-runtime-health', ownerApproval: false, independentAudit: false,
}
/** `projectVerifiedFacts('local', null)`: what either host answers (503 on the local host) while its evidence is incomplete. */
const INCOMPLETE = {
  ok: false, runtime: 'local', epoch: null, ballId: null, organCount: null, activeOrganCount: null, receiptTotal: null,
  receiptsVerified: null, receiptsByKind: null, checkpointsTotal: null, lastCheckpointSeq: null, lastCheckpointReceiptCount: null,
  dagReachable: null, dagDeclared: null, auraStatus: 'incomplete', wakeUrgency: null, evidenceStatus: 'incomplete',
  organCounts: 'declared-enabled-not-runtime-health', ownerApproval: false, independentAudit: false,
}
/**
 * ONE TYPED SEAM FOR FIXTURES (Round 20), in place of a double cast at every fixture. `fixture<T>(fields)` is a value
 * the code under test reads only in part. Fields written inline must exist on T with a compatible type (functions must
 * match exactly), so a misspelt or mistyped inline field is a type error; fields left out are left out on purpose.
 * Prebuilt objects get no excess-field check, which is how the readout's undeclared `pearl` and `head` travel (as they
 * do from her status file), so the prebuilt values the tests lean on are typed where they are declared. It is an
 * overload whose implementation takes and returns `unknown`.
 */
type Fixture<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly Fixture<U>[]
    : T extends object ? { [K in keyof T]?: Fixture<T[K]> }
      : T
function fixture<T>(fields: Fixture<T>): T
function fixture(fields: unknown): unknown { return fields }
const EN_LABELS = new Map<string, string>(Object.entries(en))
/** The session hooks the surfaces read, bound to real snapshot stores as the app binds them. */
type StatusSnapshot = Parameters<Parameters<Parameters<typeof AuraPentoraSurface>[0]['useSessionStatus']>[0]>[0]
const sessionHooks = (ids: readonly string[]) => {
  const list: SessionListState = {
    ids: ids.map(id => id as SessionId),
    byId: Object.fromEntries(ids.map(id => [id, { id: id as SessionId, displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false,
      updatedAt: 1 }])),
    phase: 'ready',
    projectionsBySession: {},
  }
  return {
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<StatusSnapshot>(new Map())),
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const answering = (response: () => Response) => vi.fn(async (_path: string, _init?: RequestInit) => response())
const ok = (facts = LIVE): HostFactsRead => {
  const parsed = parseHostFacts(facts)
  if (parsed === null) throw new Error('fixture does not parse')
  return { kind: 'ok', facts: parsed }
}
const TAB: TabFacts = { verify: 'verified', receipts: 97, checkpoints: 5, lastCheckpointReceiptCount: 95, epoch: 9, ballId: BALL }
const NOTHING: TabFacts = { verify: 'pending', receipts: null, checkpoints: null, lastCheckpointReceiptCount: null, epoch: null, ballId: null }

describe('parsing the host’s facts', () => {
  it('reads the live Mac answer field by field', () => {
    expect(parseHostFacts(LIVE)).toMatchObject({
      runtime: 'local', complete: true, epoch: 9, ballId: BALL, receiptsVerified: 97, receiptTotal: 97, checkpointsTotal: 5,
      lastCheckpointSeq: 5, lastCheckpointReceiptCount: 95, dagReachable: 3, dagDeclared: 3, checkpointSignerTrust: 'unpinned',
    })
    expect(parseHostFacts(INCOMPLETE)).toMatchObject({ complete: false, receiptsVerified: null, epoch: null })
  })
  it('refuses a body whose fields have the wrong type or contradict each other, whole', () => {
    for (const changed of [
      { runtime: 'mac' }, { ok: 'true' }, { epoch: -1 }, { epoch: 9.5 }, { receiptsVerified: '97' }, { ballId: 'short' },
      { receiptsVerified: 98 }, { lastCheckpointReceiptCount: 98 }, { activeOrganCount: 27 }, { lastCheckpointSeq: 6 },
      { checkpointSignerTrust: 'Pinned by the owner!' }, { auraStatus: 42 },
    ]) expect(parseHostFacts({ ...LIVE, ...changed }), JSON.stringify(changed)).toBeNull()
    expect(parseHostFacts(null)).toBeNull()
    expect(parseHostFacts([LIVE])).toBeNull()
  })
  it('ok without complete evidence is incomplete, never a healthy zero', () => {
    expect(parseHostFacts({ ...LIVE, evidenceStatus: 'incomplete' })?.complete).toBe(false)
  })
})

describe('reading /__x6/facts once, bounded', () => {
  it('asks this page’s own host, same-origin, without cache', async () => {
    const fetchMock = answering(() => json(LIVE))
    expect(await readHostFacts(fetchMock)).toMatchObject({ kind: 'ok', facts: { receiptsVerified: 97 } })
    const [path, init] = fetchMock.mock.calls[0] ?? []
    expect(path).toBe(HOST_FACTS_PATH)
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
  })
  it('names each other answer for what it is', async () => {
    expect(await readHostFacts(answering(() => json(INCOMPLETE, 503)))).toMatchObject({ kind: 'incomplete', facts: { complete: false } })
    expect(await readHostFacts(answering(() => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)))).toEqual({ kind: 'signed-out' })
    expect(await readHostFacts(answering(() => new Response('nope', { status: 404 })))).toEqual({ kind: 'absent' })
    expect(await readHostFacts(answering(() => json({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503))))
      .toEqual({ kind: 'unavailable', reason: '/__x6/facts answered 503 BOOTSTRAP_REQUIRED' })
    expect(await readHostFacts(answering(() => json({ ...LIVE, receiptsVerified: 99 }))))
      .toEqual({ kind: 'unavailable', reason: '/__x6/facts is not the expected shape' })
    expect(await readHostFacts(vi.fn(async () => { throw new TypeError('offline') })))
      .toEqual({ kind: 'unavailable', reason: '/__x6/facts did not answer' })
  })
  it('stops reading a body past the cap, and gives up at the deadline', async () => {
    const huge = answering(() => new Response(JSON.stringify({ ...LIVE, padding: 'x'.repeat(70_000) }), { status: 200 }))
    expect(await readHostFacts(huge)).toEqual({ kind: 'unavailable', reason: '/__x6/facts answered more than 65536 bytes' })
    const hanging = vi.fn(async (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    expect(await readHostFacts(hanging, undefined, 20)).toEqual({ kind: 'unavailable', reason: '/__x6/facts did not answer in time' })
  })
  it('a caller abort is passed on, never reported as the host failing', async () => {
    const controller = new AbortController()
    const hanging = vi.fn(async (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    const pending = readHostFacts(hanging, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})

describe('this tab beside the host', () => {
  it('a tab that counts what the host counts matches', () => {
    expect(compareTabToHost(TAB, ok())).toEqual({ kind: 'match', compared: 5, headCompared: true })
    expect(compareTabToHost({ ...TAB, epoch: null, ballId: null }, ok())).toEqual({ kind: 'match', compared: 3, headCompared: false })
  })
  it('the lag is said at once: a tab on 64 receipts behind a host on 97', () => {
    const lag = compareTabToHost({ ...TAB, receipts: 64, checkpoints: 4, lastCheckpointReceiptCount: 64 }, ok())
    expect(lag.kind).toBe('lag')
    expect(lag.kind === 'lag' && lag.notes).toEqual([
      'TAB BEHIND HOST by 33 receipts (tab 64, host 97)',
      'checkpoints differ (tab 4, host 5)',
      'last checkpoint covers 64 receipts in the tab, 95 on the host',
    ])
  })
  it('a tab ahead of the host, or on another Pearl, is said too', () => {
    const ahead = compareTabToHost({ ...TAB, receipts: 99 }, ok())
    expect(ahead.kind === 'lag' && ahead.notes[0]).toMatch(/^TAB AHEAD OF HOST by 2 receipts/)
    const other = compareTabToHost({ ...TAB, epoch: 10, ballId: 'f'.repeat(64) }, ok())
    expect(other.kind === 'lag' && other.notes).toEqual(['tab on Pearl epoch 10, host on 9'])
    const forked = compareTabToHost({ ...TAB, ballId: 'f'.repeat(64) }, ok())
    expect(forked.kind === 'lag' && forked.notes).toEqual(['same epoch, different Pearl (tab ffffffffffff, host 8c1f5e34f013)'])
  })
  it('nothing is compared against an incomplete host, or a tab that has not counted yet', () => {
    const incomplete = parseHostFacts(INCOMPLETE)
    expect(incomplete).not.toBeNull()
    if (incomplete === null) return
    expect(compareTabToHost(TAB, { kind: 'incomplete', facts: incomplete }).kind).toBe('unknown')
    expect(compareTabToHost(TAB, { kind: 'signed-out' }).kind).toBe('unknown')
    expect(compareTabToHost(NOTHING, ok())).toEqual({ kind: 'unknown', reason: 'this tab has not verified its own receipts yet' })
  })
  it('an agreeing head alone is not a match: agreement needs this tab’s own verified receipt count', () => {
    expect(compareTabToHost({ ...NOTHING, epoch: 9, ballId: BALL }, ok()))
      .toEqual({ kind: 'unknown', reason: 'this tab has not verified its own receipts yet (its Pearl head agrees)' })
    const older = compareTabToHost({ ...NOTHING, epoch: 8 }, ok())
    expect(older.kind === 'lag' && older.notes).toEqual(['tab on Pearl epoch 8, host on 9'])
  })
  it('a tab whose own verify was refused is said to be refused, and its counts are never compared', () => {
    const refused = compareTabToHost({ ...TAB, verify: 'rejected' }, ok())
    expect(refused.kind === 'lag' && refused.notes).toEqual(["this tab's own receipt verify was REFUSED; the host verified 97 receipts"])
    expect(compareTabToHost({ ...TAB, verify: 'pending' }, ok()).kind).toBe('unknown')
  })
})

describe('which of this tab’s numbers are counted (Work)', () => {
  const verified: Extract<BridgeReceipts, { kind: 'verified' }> = {
    kind: 'verified', merkleRoot: 'a'.repeat(64), checkpointHash: null, receiptsVerified: 97, checkpointsVerified: 5,
  }
  const pearl = {
    retentionTotal: 1, retentionPassed: 1, scarsCount: 0,
    checkpoint: { count: 5, lastReceiptCount: 95, receiptTotal: 97, lastSigned: true },
  }
  const snapshot = { observedAt: '2026-11-09T00:00:00.000Z', survivedRestart: null, mandates: [], tickets: [], assignments: [], attention: [], pearl }
  const head = { ballId: BALL, parentBallId: null, epoch: 9 }
  it('a fresh readout whose verify passed gives its counts, and the signed checkpoint coverage', () => {
    const phase = fixture<BridgePhase>({ kind: 'snapshot', snapshot, receipts: verified, empty: false, refreshing: false })
    expect(tabFactsOf(phase, head)).toEqual(TAB)
  })
  it('an unsigned last checkpoint gives no coverage; a held stale readout gives no counts at all', () => {
    const unsigned = { ...snapshot, pearl: { ...pearl, checkpoint: { ...pearl.checkpoint, lastSigned: false } } }
    const phase = fixture<BridgePhase>({ kind: 'snapshot', snapshot: unsigned, receipts: verified, empty: false, refreshing: false })
    expect(tabFactsOf(phase, head).lastCheckpointReceiptCount).toBeNull()
    const stale = fixture<BridgePhase>({ kind: 'stale-snapshot', snapshot, receipts: verified, failure: null, aged: true, refreshing: false })
    expect(tabFactsOf(stale, head)).toEqual({ ...NOTHING, epoch: 9, ballId: BALL })
  })
  it('a refused verify is carried as refused, with no counts', () => {
    const phase = fixture<BridgePhase>({ kind: 'failure', failure: { kind: 'x' }, receipts: { kind: 'rejected', stage: 'chain' }, refreshing: false })
    expect(tabFactsOf(phase, null)).toEqual({ ...NOTHING, verify: 'rejected' })
    expect(tabFactsOf(null, null)).toEqual(NOTHING)
  })
})

describe('how often the host is asked', () => {
  const Probe = ({ fetchImpl, live }: { readonly fetchImpl: (input: string) => Promise<Response>; readonly live: boolean }) => {
    const read = useHostFacts(true, 0, fetchImpl, live)
    return <span data-read={read.kind} />
  }
  it('once per opening for a one-shot view; every 30 s for a live one', async () => {
    vi.useFakeTimers()
    try {
      const once = vi.fn(async () => json(LIVE))
      const polled = vi.fn(async () => json(LIVE))
      render(<><Probe fetchImpl={once} live={false} /><Probe fetchImpl={polled} live /></>)
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      expect([once.mock.calls.length, polled.mock.calls.length]).toEqual([1, 1])
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect([once.mock.calls.length, polled.mock.calls.length]).toEqual([1, 2])
    } finally { vi.useRealTimers() }
  })
})

describe('the host’s facts in words', () => {
  it('says what the host checked and that it does not pin the checkpoint signer', () => {
    const read = ok()
    expect(hostFactsWords(read)).toBe('host (Mac): 97/97 receipts verified · checkpoint 5 covers 95 of 97 receipts · '
      + 'signature and receipt prefix checked, signer not pinned on the host · Pearl 9 · 8c1f5e34f013')
    expect(read.kind === 'ok' && hostCheckpointWords({ ...read.facts, checkpointsTotal: 0 })).toBe('no checkpoint yet')
    const incomplete = parseHostFacts(INCOMPLETE)
    if (incomplete === null) throw new Error('fixture does not parse')
    expect(hostFactsWords({ kind: 'incomplete', facts: incomplete })).toMatch(/evidence is incomplete/)
  })
  it('Sovereignty’s receipt chain card shows the host’s counts; a count the host did not give is no row, never a zero', () => {
    const unknown: FactsAgreement = { kind: 'unknown', reason: 'not compared' }
    const card = chainCardOf(ok(), unknown, null)
    expect(Object.fromEntries(card.rows)['host check']).toBe('97 of 97 receipts verified · checkpoint 5 covers 95')
    expect(card.details).toContainEqual(['memory DAG reachable', '3 of 3'])
    expect(card.details).toContainEqual(['organs declared', '26 (26 enabled)'])
    expect([card.badge, card.summary]).toEqual(['HOST VERIFIED', '97 receipts · 5 checkpoints'])
    const incomplete = parseHostFacts(INCOMPLETE)
    if (incomplete === null) throw new Error('fixture')
    const partial = chainCardOf({ kind: 'incomplete', facts: incomplete }, unknown, null)
    // Round 25 review: incomplete evidence and a refusal are live states, in the card's line and badge, not only in the fold.
    expect(partial.rows).toEqual([['host check', 'INCOMPLETE: the host says its evidence is incomplete right now, so it gives no counts']])
    expect([partial.badge, partial.tone, partial.summary]).toEqual(['HOST INCOMPLETE', 'gold', 'host evidence INCOMPLETE'])
    const her = { kind: 'verified', receiptsVerified: 97, checkpointsVerified: 5, merkleRoot: null }
    const refused = chainCardOf({ kind: 'unavailable', reason: '/__x6/facts answered 503 LOCAL_MESSAGES_UNAVAILABLE' }, unknown, her)
    expect(Object.fromEntries(refused.rows)['host check']).toBe('did not answer here (/__x6/facts answered 503 LOCAL_MESSAGES_UNAVAILABLE)')
    expect([refused.badge, refused.tone, refused.summary]).toEqual(['VERIFIED · HOST NOT READ', 'gold', '97 receipts · 5 checkpoints · host check did not answer'])
    expect(chainCardOf({ kind: 'incomplete', facts: incomplete }, unknown, her).badge).toBe('VERIFIED · HOST INCOMPLETE')
    expect(chainCardOf({ kind: 'signed-out' }, unknown, null).rows).toEqual([])
  })
  it('her checkpoint-policy refusal is a rejection with its code; a policy she could not read is no verdict, named', () => {
    const unknown: FactsAgreement = { kind: 'unknown', reason: 'not compared' }
    const mismatch = { kind: 'rejected', stage: 'checkpoint-policy', error: 'CHECKPOINT_SIGNER_POLICY_MISMATCH' }
    const card = chainCardOf(ok(), unknown, mismatch)
    // Not "could not check" beside a blue HOST VERIFIED: her verifier refused a signer the owner's policy does not admit.
    expect([card.badge, card.tone]).toEqual(['REJECTED', 'red'])
    expect(Object.fromEntries(card.rows)['her verifier']).toBe('REJECTED her receipt chain at checkpoint-policy: CHECKPOINT_SIGNER_POLICY_MISMATCH')
    const keys = keysCardOf({ kind: 'reading' }, ok(), { kind: 'reading' }, mismatch)
    expect(keys.badge).toBe('CHAIN NOT VERIFIED')
    expect(Object.fromEntries(keys.rows)['chain']).toContain('CHECKPOINT_SIGNER_POLICY_MISMATCH')
    const expired = chainCardOf(ok(), unknown, { ...mismatch, error: 'CHECKPOINT_SIGNER_POLICY_EXPIRED' })
    expect(expired.badge).toBe('REJECTED')
    const unread = chainCardOf(ok(), unknown, { ...mismatch, error: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE' })
    expect(Object.fromEntries(unread.rows)['her verifier']).toBe('could not check her chain (checkpoint-policy: CHECKPOINT_SIGNER_POLICY_UNAVAILABLE)')
    expect(unread.badge).not.toBe('REJECTED')
    const unnamed = chainCardOf(ok(), unknown, { kind: 'rejected', stage: null, error: 'CHECKPOINT_SIGNER_POLICY_MISMATCH' })
    expect(Object.fromEntries(unnamed.rows)['her verifier']).toBe('could not check her chain (CHECKPOINT_SIGNER_POLICY_MISMATCH)')
  })
  it('Work says the code her organ refused its status with, not only "refused"', () => {
    const refused = { kind: 'refused', detail: 'MANDATE_EXPIRY_INVALID', truncated: false }
    expect(failureKind(fixture<BridgePhase>({ kind: 'failure', failure: refused, receipts: { kind: 'idle' }, refreshing: false }))).toBe('MANDATE_EXPIRY_INVALID')
    expect(failureKind(fixture<BridgePhase>({ kind: 'stale-snapshot', snapshot: {}, receipts: { kind: 'idle' }, failure: refused, aged: false,
      refreshing: false }))).toBe('MANDATE_EXPIRY_INVALID')
    expect(failureKind(fixture<BridgePhase>({ kind: 'failure', failure: { kind: 'timeout' }, receipts: { kind: 'idle' }, refreshing: false }))).toBe('timeout')
    expect(failureKind(fixture<BridgePhase>({ kind: 'failure', failure: { kind: 'refused', detail: null }, receipts: { kind: 'idle' }, refreshing: false })))
      .toBe('refused')
    // Free text from a refusal is never put in this row; only a named code is (Round 26 review).
    expect(failureKind(fixture<BridgePhase>({ kind: 'failure', failure: { kind: 'refused', detail: 'verified just now \u202e owner-anchored' },
      receipts: { kind: 'idle' }, refreshing: false }))).toBe('refused')
  })
})

describe('the Work view’s Host check row', () => {
  const routes = (facts: unknown, status = 200) => vi.fn(async (input: string) => {
    if (input === '/__x6/facts') return json(facts, status)
    if (input === '/__x6/status') return json({ ok: true, runtime: 'local' })
    return new Response('nope', { status: 404 })
  })
  const mount = (head: unknown) => {
    const props = {
      activeSurface: WORK_SURFACE,
      useSessions: sessionHooks(['s1']).useSessions,
      reader: {
        whole: async (_session: unknown, path: string): Promise<FileRead> => (path === BALL_HEAD_PATH && head !== null
          ? { ok: true, text: JSON.stringify(head) } : { ok: false, reason: 'not-found' }),
      },
      labels: (key: string) => EN_LABELS.get(key) ?? key,
      t: (key: string) => key,
    }
    return render(<WorkSurface {...fixture<Parameters<typeof WorkSurface>[0]>(props)} />)
  }
  it('shows the host’s facts and flags a tab on an older Pearl, inline (no dialog)', async () => {
    vi.stubGlobal('fetch', routes(LIVE))
    const { container } = mount({ ballId: 'a'.repeat(64), parentBallId: null, epoch: 8 })
    await waitFor(() => { expect(container.querySelector('[data-work-host-facts="ok"]')).not.toBeNull() })
    await waitFor(() => { expect(container.querySelector('[data-work-host-lag]')?.textContent).toBe('tab on Pearl epoch 8, host on 9') })
    expect(container.querySelector('[data-work-host-facts]')?.getAttribute('data-work-host-agreement')).toBe('lag')
    expect(container.querySelector('[data-work-host-facts]')?.textContent).toMatch(/^host \(Mac\): 97\/97 receipts verified/)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('a matching head with no verified receipts in this tab is not called a match', async () => {
    vi.stubGlobal('fetch', routes(LIVE))
    const { container } = mount({ ballId: BALL, parentBallId: null, epoch: 9 })
    await waitFor(() => { expect(container.querySelector('[data-work-host-facts="ok"]')).not.toBeNull() })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(container.querySelector('[data-work-host-facts]')?.getAttribute('data-work-host-agreement')).toBe('unknown')
    expect(container.querySelector('[data-work-host-facts]')?.textContent).not.toMatch(/agree with the host/)
    expect(container.querySelector('[data-work-host-lag]')).toBeNull()
  })
  it('an incomplete host is said, and nothing is compared', async () => {
    vi.stubGlobal('fetch', routes(INCOMPLETE, 503))
    const { container } = mount({ ballId: BALL, parentBallId: null, epoch: 8 })
    await waitFor(() => { expect(container.querySelector('[data-work-host-facts="incomplete"]')).not.toBeNull() })
    expect(container.querySelector('[data-work-host-facts]')?.getAttribute('data-work-host-agreement')).toBe('unknown')
    expect(container.querySelector('[data-work-host-lag]')).toBeNull()
  })
})

describe('Survivor readout: three series, each read on its own', () => {
  it('today the host sends none of them: each says "not reported", and the core facts still parse', () => {
    const facts = parseHostFacts(LIVE)
    expect(facts?.survivor.task).toBe('absent')
    expect(facts?.survivor.forecast).toBe('absent')
    expect(facts?.survivor.provenance.signerTrust).toBe('unpinned')
    expect(facts === null ? '' : provenanceWords(facts.survivor.provenance))
      .toBe('checkpoint signer not pinned on the host · gates not reported by this host · model attribution not reported by this host')
    expect(facts === null ? '' : taskWords(facts.survivor.task)).toBe('not reported by this host')
  })
  it('reads each series when present, with qualification separate from the winner and receipt_error separate from success', () => {
    const survivor = parseSurvivor({
      ...LIVE,
      taskOutcome: { status: 'complete', retentionPassed: 18, retentionTotal: 18, qualifiedForPromotion: true, graderControlsPassed: true, routeEvidenceStatus: 'checked' },
      predictionCalibration: { status: 'complete', version: 'receipt_error-v1', samples: 4, minSamples: 3, receiptErrorMean: 0, receiptErrorLast: 0.25 },
      gates: { status: 'current' },
      modelAttribution: { evidenceQuality: 'gateway-observed', requestedModel: 'deepseek-chat', providerReportedModel: 'deepseek-chat', immutableRevision: null },
    })
    expect(taskWords(survivor.task)).toBe('retention 18/18 · qualified for promotion: yes · grader controls: passed · route evidence: checked')
    expect(forecastWords(survivor.forecast)).toBe('receipt_error mean 0.000 · last 0.250 · 4 samples · receipt_error-v1')
    expect(provenanceWords(survivor.provenance)).toBe('checkpoint signer not pinned on the host · gates current · '
      + 'model attribution gateway-observed (deepseek-chat) · revision unknown')
  })
  it('incomplete and insufficient samples are said, with no number standing in', () => {
    const survivor = parseSurvivor({ taskOutcome: { status: 'incomplete' }, predictionCalibration: { status: 'insufficient-samples', samples: 1, minSamples: 3 } })
    expect(taskWords(survivor.task)).toBe('INCOMPLETE · no pass count shown')
    expect(forecastWords(survivor.forecast)).toBe('INSUFFICIENT SAMPLES (1 of 3)')
    expect(forecastWords(parseSurvivor({ predictionCalibration: { status: 'incomplete', receiptErrorMean: 0 } }).forecast)).toBe('INCOMPLETE · no error shown')
  })
  it('a malformed series is unreadable on its own and never blanks the core facts or the other series', () => {
    const body = { ...LIVE, taskOutcome: { status: 'complete', retentionPassed: 19, retentionTotal: 18 }, predictionCalibration: { status: 'complete', receiptErrorMean: -1 },
      gates: 'current', modelAttribution: { evidenceQuality: 'CRYPTOGRAPHICALLY-ATTESTED!' } }
    const facts = parseHostFacts(body)
    expect(facts?.receiptsVerified).toBe(97)
    expect([facts?.survivor.task, facts?.survivor.forecast, facts?.survivor.provenance.gates, facts?.survivor.provenance.attribution])
      .toEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable'])
    expect(parseSurvivor({ taskOutcome: { retentionPassed: 1 } }).task).toBe('unreadable')
  })
  it('only "complete" is a finished reading: other statuses lead the line, too few samples is insufficient, contradictions are unreadable', () => {
    const odd = parseSurvivor({ taskOutcome: { status: 'provisional', retentionPassed: 3, retentionTotal: 3 },
      predictionCalibration: { status: 'complete', samples: 2, minSamples: 5, receiptErrorMean: 0 } })
    expect(taskWords(odd.task)).toMatch(/^PROVISIONAL · retention 3\/3/)
    expect(forecastWords(odd.forecast)).toBe('INSUFFICIENT SAMPLES (2 of 5)')
    expect(forecastWords(parseSurvivor({ predictionCalibration: { status: 'drifting', receiptErrorMean: 0.1 } }).forecast)).toBe('DRIFTING · no error shown')
    expect(parseSurvivor({ taskOutcome: { status: 'complete', retentionPassed: 17, retentionTotal: 18, qualifiedForPromotion: true } }).task).toBe('unreadable')
    expect(parseSurvivor({ taskOutcome: { status: 'complete', qualifiedForPromotion: true, graderControlsPassed: false } }).task).toBe('unreadable')
  })
  it('Sovereignty keeps a series the host reports in the chain card’s details, and none it does not', () => {
    const unknown: FactsAgreement = { kind: 'unknown', reason: 'not compared' }
    expect(chainCardOf(ok(), unknown, null).details.map(([name]) => name)).not.toContain('task accomplishment')
    const reported = parseHostFacts(ROUND20)
    if (reported === null) throw new Error('fixture')
    const names = chainCardOf({ kind: 'ok', facts: reported }, unknown, null).details.map(([name]) => name)
    expect(names).toContain('task accomplishment')
    expect(names).toContain('forecast calibration')
  })
})

/**
 * What `projectVerifiedFacts` adds in Round 20 (Lane 2, read from its working tree before it landed): a task outcome
 * that is self-attested at most and never qualifies, a forecast 'observed' with no sample floor, gates unverified, model
 * attribution unknown, and the checkpoint signer checked against the pin.
 */
const ROUND20 = {
  ...LIVE,
  checkpointsTotal: 6, lastCheckpointSeq: 6, lastCheckpointReceiptCount: 97, checkpointSignerTrust: 'pinned',
  taskOutcome: { status: 'self-attested', retentionPassed: 18, retentionTotal: 18, qualifiedForPromotion: null,
    graderControlsPassed: true, routeEvidenceStatus: 'checked' },
  predictionCalibration: { status: 'observed', version: 'receipt-error-v1', samples: 1, minSamples: null, receiptErrorMean: 0, receiptErrorLast: 0 },
  gates: { status: 'unverified' },
  modelAttribution: { evidenceQuality: 'unknown', requestedModel: null, providerReportedModel: null, immutableRevision: null },
}

describe('the four series as the host now sends them', () => {
  it('reads each one, and says what each is rather than what it would be if settled', () => {
    const facts = parseHostFacts(ROUND20)
    if (facts === null) throw new Error('the Round 20 body does not parse')
    expect(taskWords(facts.survivor.task))
      .toBe('SELF-ATTESTED · retention 18/18 · qualified for promotion: not granted (self-attested) · grader controls: passed · route evidence: checked')
    expect(forecastWords(facts.survivor.forecast)).toBe('OBSERVED (no sample floor) · receipt_error mean 0.000 · last 0.000 · 1 sample · receipt-error-v1')
    expect(forecastWords(parseSurvivor({ predictionCalibration: { status: 'insufficient-samples', samples: 0, minSamples: null } }).forecast))
      .toBe('INSUFFICIENT SAMPLES (0 samples, no floor set)')
    expect(provenanceWords(facts.survivor.provenance))
      .toBe('checkpoint signer matches the pinned key · gates unverified · model attribution unknown · revision unknown')
    expect(hostCheckpointWords(facts)).toBe('checkpoint 6 covers 97 of 97 receipts · signature and receipt prefix checked, signer matches the pinned key')
  })
  it('a series with nothing recorded is its status alone', () => {
    const empty = { status: 'not-recorded', retentionPassed: null, retentionTotal: null, qualifiedForPromotion: null,
      graderControlsPassed: null, routeEvidenceStatus: null }
    expect(taskWords(parseSurvivor({ taskOutcome: empty }).task)).toBe('NOT-RECORDED · no pass count shown')
    expect(taskWords(parseSurvivor({ taskOutcome: { ...empty, status: 'unverified' } }).task)).toBe('UNVERIFIED · no pass count shown')
    expect(forecastWords(parseSurvivor({ predictionCalibration: { status: 'unavailable', version: 'receipt-error-v1', samples: null,
      minSamples: null, receiptErrorMean: null, receiptErrorLast: null } }).forecast)).toBe('UNAVAILABLE · no error shown')
  })
  it('a checkpoint signer that is not the pinned key, or a pin the host cannot read, outranks counts agreeing', () => {
    const match: FactsAgreement = { kind: 'match', compared: 5, headCompared: true }
    const facts = parseHostFacts({ ...ROUND20, checkpointSignerTrust: 'mismatch' })
    if (facts === null) throw new Error('the mismatch body does not parse')
    const read: HostFactsRead = { kind: 'ok', facts }
    // Sovereignty (Round 25): the Keys and trust badge says it, ahead of the passkey's own state.
    const keys = (read: HostFactsRead) => keysCardOf({ kind: 'reading' }, read, { kind: 'reading' }, null)
    expect([keys(read).badge, keys(read).tone]).toEqual(['CHECKPOINT SIGNER MISMATCH', 'gold'])
    expect(keys({ kind: 'incomplete', facts }).badge).toBe('CHECKPOINT SIGNER MISMATCH')
    const invalid = parseHostFacts({ ...ROUND20, checkpointSignerTrust: 'invalid-pin' })
    if (invalid === null) throw new Error('the invalid-pin body does not parse')
    expect(keys({ kind: 'ok', facts: invalid }).badge).toBe('CHECKPOINT SIGNER PIN INVALID')
    expect(hostCheckpointWords(invalid)).toMatch(/signer pin on the host is invalid, so the signer was not checked$/)
    expect(keys(ok()).badge).toBe('READING')
    // The same ranking on Work's host row: a matching tab never reads as agreeing with a host whose signer is wrong.
    expect(hostRowSuffix(read, match)).toEqual({ kind: 'alarm', text: 'CHECKPOINT SIGNER MISMATCH' })
    expect(hostRowSuffix(ok(), match)).toEqual({ kind: 'match' })
    expect(hostRowSuffix(ok(), { kind: 'unknown', reason: 'not compared' })).toBeNull()
  })
  it('Sovereignty names who signs the checkpoints only as far as the host checked it (Keys and trust)', () => {
    const signer = (trust: string) => {
      const facts = parseHostFacts({ ...ROUND20, checkpointSignerTrust: trust })
      if (facts === null) throw new Error('fixture')
      return Object.fromEntries(keysCardOf({ kind: 'reading' }, { kind: 'ok', facts }, { kind: 'reading' }, null).rows)['checkpoint signer']
    }
    expect(signer('pinned')).toBe('each checkpoint is signed by a key the host’s pin names')
    expect(signer('mismatch')).toBe('MISMATCH: a checkpoint is signed by a key the host’s pin does not name')
    expect(signer('invalid-pin')).toMatch(/pin is invalid/)
    expect(signer('unpinned')).toBe('not pinned on this host (or no checkpoint yet)')
    expect(keysCardOf({ kind: 'reading' }, { kind: 'signed-out' }, { kind: 'reading' }, null).rows.map(([name]) => name)).toEqual(['passkey'])
  })
  it('the Work view leaves the three lines and the node line to Sovereignty, and keeps a signer mismatch on its host row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/__x6/facts' ? json({ ...ROUND20, checkpointSignerTrust: 'mismatch' })
      : input === '/__x6/status' ? json({ ok: true, runtime: 'local' }) : new Response('nope', { status: 404 }))))
    const props = {
      activeSurface: WORK_SURFACE,
      useSessions: sessionHooks(['s1']).useSessions,
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
      labels: (key: string) => EN_LABELS.get(key) ?? key,
      t: (key: string) => key,
    }
    const { container } = render(<WorkSurface {...fixture<Parameters<typeof WorkSurface>[0]>(props)} />)
    await waitFor(() => { expect(container.querySelector('[data-work-host-facts="ok"]')).not.toBeNull() })
    // The alarm is a live bad state. Round 27: Work's host row sits in the closed Her records card, and the alarm is also
    // said in sight above the cards, while that card's own head turns to NOT VERIFIED.
    expect(container.querySelector('[data-work-host-facts]')?.textContent).toMatch(/ · CHECKPOINT SIGNER MISMATCH$/)
    const said = container.querySelector('[data-work-trouble="host"]')
    expect(said?.textContent).toMatch(/ · CHECKPOINT SIGNER MISMATCH$/)
    expect(said?.closest('details')).toBeNull()
    expect(container.querySelector('[data-work-details] > summary')?.textContent).toContain('NOT VERIFIED')
    // Task, forecast, provenance and node are Sovereignty's rows (the same /__x6/facts read); Work does not repeat them.
    expect(container.querySelector('[data-work-survivor]')).toBeNull()
    expect(container.querySelector('[data-work-series]')).toBeNull()
    expect(container.querySelector('[data-work-node]')).toBeNull()
    expect(container.textContent).not.toMatch(/Task accomplishment|Forecast calibration|Evidence & provenance/)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('Sovereignty compares the full head from its own one-shot read', () => {
  const verified: Extract<BridgeReceipts, { kind: 'verified' }> = {
    kind: 'verified', merkleRoot: 'a'.repeat(64), checkpointHash: null, receiptsVerified: 97, checkpointsVerified: 5,
  }
  const pearl = {
    retentionTotal: 1, retentionPassed: 1, scarsCount: 0,
    checkpoint: { count: 5, lastReceiptCount: 95, receiptTotal: 97, lastSigned: true },
  }
  const snapshot = (head: unknown) => ({ observedAt: '2026-11-09T00:00:00.000Z', survivedRestart: null, mandates: [], tickets: [], assignments: [], attention: [], pearl, head })
  const summary = { kind: 'summary', ballId: BALL, epoch: 9, parentBallId: null }
  it('the tab head comes from the read itself, never from the host route', () => {
    const phase = fixture<BridgePhase>({ kind: 'snapshot', snapshot: snapshot(summary), receipts: verified, empty: false, refreshing: false })
    expect(readHeadOf(phase)).toEqual({ ballId: BALL, epoch: 9, parentBallId: null })
    const withHead = (head: unknown) => fixture<BridgePhase>({ kind: 'snapshot', snapshot: snapshot(head), receipts: verified, empty: false, refreshing: false })
    expect(readHeadOf(withHead({ kind: 'unavailable' }))).toBeNull()
    expect(readHeadOf(withHead({ ...summary, epoch: '9' }))).toBeNull()
    expect(compareTabToHost(tabFactsOf(phase, readHeadOf(phase), true), ok())).toEqual({ kind: 'match', compared: 5, headCompared: true })
  })
  it('a one-shot read counts its receipts even when her status file is old or her status call failed', () => {
    const stale = fixture<BridgePhase>({ kind: 'stale-snapshot', snapshot: snapshot(summary), receipts: verified, failure: null, aged: true, refreshing: false })
    expect(tabFactsOf(stale, readHeadOf(stale), true)).toEqual(TAB)
    expect(tabFactsOf(stale, readHeadOf(stale)).receipts).toBeNull()
    const failed = fixture<BridgePhase>({ kind: 'failure', failure: { kind: 'x' }, receipts: verified, refreshing: false })
    const counted = tabFactsOf(failed, readHeadOf(failed), true)
    expect([counted.receipts, counted.epoch, counted.lastCheckpointReceiptCount]).toEqual([97, null, null])
    expect(compareTabToHost(counted, ok())).toMatchObject({ kind: 'match', headCompared: false })
  })
  it('a tab on another Pearl in the same read is a difference, not counts agreeing', () => {
    const other = fixture<BridgePhase>({ kind: 'snapshot', snapshot: snapshot({ ...summary, ballId: 'f'.repeat(64) }), receipts: verified, empty: false, refreshing: false })
    const result = compareTabToHost(tabFactsOf(other, readHeadOf(other), true), ok())
    expect(result.kind === 'lag' && result.notes).toEqual(['same epoch, different Pearl (tab ffffffffffff, host 8c1f5e34f013)'])
  })
})

describe('Aura Coherence: PENTORA36 honesty, and only what is fed', () => {
  // The real pinned module, from the repo root (vitest runs there) or from this package.
  const WASM_PATH = ['apps/web/public/seed-library/pentora/pentora36.wasm', '../../../apps/web/public/seed-library/pentora/pentora36.wasm']
    .map(path => resolve(process.cwd(), path)).find(path => existsSync(path)) ?? ''
  const wasm = readFileSync(WASM_PATH)
  const serveWasm = () => vi.fn(async (input: string) => (input.endsWith(PENTORA36_URL)
    ? new Response(wasm, { headers: { 'content-type': 'application/wasm' } })
    : new Response('nope', { status: 404 })))
  const notFound = async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' })
  const mount = (ids: readonly string[] = [], whole: (session: unknown, path: string) => Promise<FileRead> = notFound) => {
    const props = { activeSurface: AURA_SURFACE, closeSurface: () => {}, ...sessionHooks(ids), reader: { whole } }
    return render(<AuraPentoraSurface {...fixture<Parameters<typeof AuraPentoraSurface>[0]>(props)} />)
  }
  /** Open one of the surface's portals by its title. */
  const openPortal = (container: HTMLElement, title: string) => {
    const head = [...container.querySelectorAll<HTMLButtonElement>('button.ak-portal__head')]
      .find(button => button.querySelector('.ak-portal__title')?.textContent === title)
    if (head === undefined) throw new Error(`no ${title} portal`)
    fireEvent.click(head)
    return head.closest('.ak-portal')
  }
  it('words: the arithmetic self-check counts its own checks', () => {
    const checks = Array.from({ length: 9 }, (_, i) => ({ name: `c${String(i)}`, ok: true, detail: '' }))
    const result = fixture<NonNullable<Parameters<typeof arithmeticWords>[0]>>({ state: 'verified', reason: '', sha256: null, bytes: null, loader: null, ms: 1, checks })
    expect(arithmeticWords(result)).toBe('Arithmetic self-check: 9/9 verified')
    expect(arithmeticWords(null)).toBe('Arithmetic self-check: running')
  })
  it('the real pinned module verifies 9/9 inside How it works, and never says LIVE', async () => {
    const fetchWasm = serveWasm()
    vi.stubGlobal('fetch', fetchWasm)
    const { container } = mount()
    // It runs when the surface opens; a pass shows only inside How it works.
    await waitFor(() => { expect(fetchWasm.mock.calls.some(([input]) => input.endsWith(PENTORA36_URL))).toBe(true) })
    expect(container.querySelector('[data-pentora36-failed]')).toBeNull()
    const how = openPortal(container, 'How it works')
    await waitFor(() => { expect(how?.textContent).toContain('Arithmetic self-check: 9/9 verified') }, { timeout: 4000 })
    expect(how?.textContent).toContain('it checks the module, not Auma')
    // NORTH-STAR §18.2: the self-check is said apart from health, inside the fold only.
    expect(how?.querySelector('[data-aura-health-unconnected]')?.textContent).toBe('Health observations: not connected (sequence 0). No cube is ever shown healthy.')
    expect(container.textContent).not.toContain('geometry verified')
    for (const pill of container.querySelectorAll('.ak-pill')) expect(pill.textContent).not.toBe('LIVE')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('a module that is not the pinned one fails in plain sight, under the figure, not in a fold', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input.endsWith(PENTORA36_URL)
      ? new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { 'content-type': 'application/wasm' } })
      : new Response('nope', { status: 404 }))))
    // A fresh module instance: the page runs the self-check once per load, and an earlier test already ran it.
    vi.resetModules()
    const { AuraPentoraSurface: Fresh } = await import('../src/client/spatial/aura/AuraPentoraSurface.tsx')
    const props = { activeSurface: AURA_SURFACE, closeSurface: () => {}, ...sessionHooks([]), reader: { whole: notFound } }
    const { container } = render(<Fresh {...fixture<Parameters<typeof Fresh>[0]>(props)} />)
    await waitFor(() => { expect(container.querySelector('[data-pentora36-failed]')?.textContent).toContain('failed') }, { timeout: 4000 })
  })
  it('the never-fed health map is gone, and every live part stays', () => {
    vi.stubGlobal('fetch', serveWasm())
    const { container } = mount()
    // Gone: no host serves a health snapshot and the registration injects none, so all of it only ever said "not connected".
    expect(container.querySelectorAll('[data-aura-portal]')).toHaveLength(0)
    for (const gone of ['Health observations', 'not connected', 'Not connected', 'Shared corners', 'private checks', 'Health cells']) {
      expect(container.textContent).not.toContain(gone)
    }
    expect(container.querySelector('.ak-footnote')).toBeNull()
    expect(container.querySelector('[data-aura-coherence-surface]')?.hasAttribute('data-aura-posture')).toBe(false)
    // Kept: the title and read-only badge, the live figure, the vitals and Pearl arena, Live activity and the live Pearl.
    expect(container.querySelector('.ak-header__title')?.textContent).toBe('Aura Coherence')
    expect(container.querySelector('.ak-badge')?.textContent).toBe('Read-only')
    expect(container.querySelector('figure svg')).not.toBeNull()
    expect(container.querySelectorAll('figure svg line[data-a]')).toHaveLength(120)
    expect(container.querySelector('[data-aura-strip]')).not.toBeNull()
    expect(container.querySelector('[data-pearl-arena]')).not.toBeNull()
    // Round 27: one grid of cards under the figure, and no sub-button named for an organ (Kira, Gate, Network, Body).
    expect([...container.querySelectorAll('.ak-portal__title')].map(title => title.textContent))
      .toEqual(['Live activity', 'Live Pearl', 'How it works'])
    for (const title of container.querySelectorAll('.ak-portal__title')) expect(title.textContent).not.toMatch(/Kira|Gate|Network|Body/u)
  })
  it('her vitals, focus and alerts are Portal cards under the figure; her own file stays her words', async () => {
    vi.stubGlobal('fetch', serveWasm())
    const ball = 'ab'.repeat(32)
    const file = JSON.stringify({
      schema: 'aukora.aura.v1', computedAt: 1, ballId: ball, epoch: 162, scorer: 'rules-v1', authorityTier: 'peripheral-hint',
      vector: { coherence: 1, surprisePressure: 0, driftRisk: 0.4, wakeUrgency: 1 },
      salience: [{ kind: 'stale-ticket', targetId: ball, score: 1, code: 'stale-heartbeat' }], recommendedFocus: 'escalate-to-owner',
    })
    const { container } = mount(['s1'], async (_session, path) => (path === AURA_PATH ? { ok: true, text: file } : notFound()))
    await waitFor(() => { expect(container.querySelectorAll('[data-aura-axis]')).toHaveLength(4) })
    expect([...container.querySelectorAll('[data-aura-strip] .ak-portal__title')].map(title => title.textContent))
      .toEqual(['Coherence', 'Surprise Pressure', 'Drift Risk', 'Wake Urgency', 'Recommended focus', 'Salience alerts'])
    // Only her file was read: every card says NOT RECOMPUTED, and her focus and alert are her file's words, not a pill.
    expect(container.querySelectorAll('[data-aura-strip] .ak-portal__end .ak-pill')).toHaveLength(6)
    for (const pill of container.querySelectorAll('[data-aura-strip] .ak-portal__end .ak-pill')) expect(pill.textContent).toBe('NOT RECOMPUTED')
    expect(container.querySelector('[data-aura-focus="undetermined"] [data-aura-self-asserted]')?.textContent).toBe('her file: escalate-to-owner')
    expect(container.querySelector('[data-aura-salience] [data-aura-self-asserted]')?.textContent).toBe('her file: stale-ticket · 1.00')
    expect(container.textContent).not.toMatch(/FOCUS · |STATE · /u)
    expect(container.querySelector('[data-aura-strip] .ak-meter i')).toBeNull()
    // Opening a card explains the vital; nothing in it acts.
    openPortal(container, 'Wake Urgency')
    expect(container.querySelector('[data-aura-axis="wakeUrgency"]')?.textContent).toContain('At 0.70 or more she asks for you')
    for (const button of container.querySelectorAll('[data-aura-strip] button')) expect(button.classList.contains('ak-portal__head')).toBe(true)
  })
  it('How it works keeps only the true lines: the organs and their colours, the flash, the faster turn', () => {
    vi.stubGlobal('fetch', serveWasm())
    const { container } = mount()
    const how = openPortal(container, 'How it works')?.querySelector('.ak-portal__body')?.textContent ?? ''
    expect(how).toContain('AUMLOK gold, Gate & Aura blue, Kira violet, Network mint, Body silver')
    expect(how).toContain('A cube flashes and shakes loose')
    expect(how).toContain('turns faster while she works')
    for (const gone of ['corner', 'drift', 'pulse', 'Bright', 'Canon']) expect(how).not.toContain(gone)
  })
  it('Live activity says "nothing yet" once, in its summary; no empty row repeats it', () => {
    vi.stubGlobal('fetch', serveWasm())
    const { container } = mount()
    const live = openPortal(container, 'Live activity')
    expect(live?.querySelector('.ak-portal__summary')?.textContent).toBe('nothing since you opened this view; it moves when Auma works')
    expect(live?.querySelectorAll('.ak-row')).toHaveLength(0)
    expect(live?.textContent).not.toContain('Nothing yet')
  })
  it('the live Pearl reads her head alone: no seed manifest read, the badge rests on HEAD, a bad head still says so', async () => {
    vi.stubGlobal('fetch', serveWasm())
    const entries = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`organ-${String(i)}`, { disabled: false }]))
    const text = JSON.stringify({ ballId: BALL, parentBallId: null, epoch: 9, entries })
    const paths: string[] = []
    const { container } = mount(['s1'], async (_session, path) => {
      paths.push(path)
      return path === BALL_HEAD_PATH ? { ok: true, text } : notFound()
    })
    const head = container.querySelector('[data-aura-live-head]')
    await waitFor(() => { expect(head?.textContent).toContain('Pearl 9 · 8c1f5e34f013 · 26 organs in her Pearl') })
    expect(head?.textContent).toContain('read from her head file')
    expect(head?.textContent).not.toContain('seed manifest')
    expect(paths).toContain(BALL_HEAD_PATH)
    expect(paths.filter(path => path.endsWith('/seed/manifest.json'))).toEqual([])
    cleanup()
    const broken = mount(['s1'], async (_session, path) => (path === BALL_HEAD_PATH ? { ok: false, reason: 'not-found' } : notFound()))
    const unread = broken.container.querySelector('[data-aura-live-head]')
    await waitFor(() => { expect(unread?.textContent).toContain('head unreadable · organs unreadable') })
    expect(unread?.textContent).toContain('not read')
    openPortal(broken.container, 'Live Pearl')
    expect(broken.container.textContent).toContain(`Could not read ${BALL_HEAD_PATH}: not-found`)
  })
  it('the periphery\'s empty trend mark is hidden on this surface only, and a real arrow is not', () => {
    // From the repo root (vitest runs there) or from this package, like the module above.
    const CSS_PATH = ['packages/client/ui-layout/src/client/spatial/aura/AuraPentora.module.css', 'src/client/spatial/aura/AuraPentora.module.css']
      .map(path => resolve(process.cwd(), path)).find(path => existsSync(path)) ?? ''
    const css = readFileSync(CSS_PATH, 'utf8')
    expect(css).toContain(":global([data-aura-coherence-surface] [data-aura-axis][data-aura-trend='unknown'] .ak-aura__trend) { display: none; }")
    expect(css.match(/ak-aura__trend/gu)).toHaveLength(1)
  })
})

describe('AUMLOK: the three states and the node’s owner, read and never assumed', () => {
  const OWNER_HEX = '962cbbeae62a10e41036fb4c569b44f1f87e312134b6a59301c99cbc617c1e80'
  const AUMLOK_LABELS = new Map<string, string>(Object.entries(AUMLOK_EN))
  // A Response body can be read once, so every answer is made fresh per request.
  const key = () => json({ ok: true, publicKeyHex: OWNER_HEX, keyId: `owner-ed25519-${OWNER_HEX.slice(0, 12)}` })
  const host = (status: () => Response, ownerKey: () => Response = key) => vi.fn(async (input: string) => {
    if (input === '/__x6/status') return status()
    if (input === '/_host/owner-key') return ownerKey()
    return new Response('nope', { status: 404 })
  })
  /** The value beside one label of the owner card. */
  const row = (container: HTMLElement, label: string): string => [...container.querySelectorAll('[data-aumlok-owner-state] dt')]
    .find(dt => dt.textContent === label)?.nextElementSibling?.textContent ?? ''
  const mount = (projection: AumlokControlProjectionState = AUMLOK_NO_CONTROLLER, ceremonyAvailable = false) => {
    const props = {
      activeSurface: 'aumlok',
      closeSurface: () => {},
      t: (key: string) => AUMLOK_LABELS.get(key) ?? key,
      // X6.1's real injection by default: no controller, no ceremony bridge.
      useControlProjection: <S,>(select: (state: AumlokControlProjectionState) => S): S => select(projection),
      ceremonyAvailable,
      drawPhrase: async () => ({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
      submitPhrase: async () => ({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
      refreshControlStatus: () => {},
    }
    return render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(props)} />)
  }
  it('on her Mac: the three states with none marked (nothing was read), why nothing can be bound, and only what the host answers', async () => {
    vi.stubGlobal('fetch', host(() => json({ ok: true, runtime: 'local' })))
    const { container } = mount()
    await waitFor(() => { expect(row(container, 'owner key')).toBe('public key on this host · owner-ed25519-962cbbeae62a') })
    await waitFor(() => { expect(row(container, 'passkey')).toBe('not on this host yet') })
    await waitFor(() => { expect(row(container, 'owner sign-in')).toBe('this Mac’s host: this page holds its local session; no owner sign-in is read here') })
    expect([...container.querySelectorAll('[data-aumlok-state-step]')].map(step => step.getAttribute('data-aumlok-state-step')))
      .toEqual(['unbound', 'bound', 'refresh'])
    expect(container.querySelectorAll('[aria-current]')).toHaveLength(0)
    expect(container.querySelector('[data-aumlok-states]')?.getAttribute('data-aumlok-states')).toBe('not-read')
    expect(row(container, 'states')).toContain('not read: no binding service on this host')
    expect(container.querySelector('[data-aumlok-ceremony-absent]')?.textContent).toContain('does not run on this host yet')
    // Nothing was read, so the header names no state, and no handle is asked for where no ceremony runs.
    expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('not-read')
    expect(container.querySelector('[data-aumlok-handle-input]')).toBeNull()
    expect(row(container, 'phrase ceremony')).toBe('not on this host yet')
    expect(row(container, 'binding')).toBe('not reported by this host')
    expect(row(container, 'invites')).toBe('not reported by this host')
    expect(row(container, 'node identity')).toBe('not reported by this host')
    expect(container.querySelector('[data-aumlok-identity-rule]')).toBeNull()
    // The ceremony's own control is the one button this screen may hold; with no ceremony here there is none.
    expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(0)
    const details = container.querySelector('details[data-aumlok-runtime-status]')
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.textContent).toContain('No controller in this composition')
    expect(container.querySelector('[data-edge-signin]')).toBeNull()
    expect(container.querySelector('[data-aumlok-bind-button]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('on the edge without the owner pass: says so, shows the key route refused, and adds no control or dialog', async () => {
    const refused = () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
    vi.stubGlobal('fetch', host(refused, refused))
    const { container } = mount()
    await waitFor(() => { expect(row(container, 'owner sign-in')).toBe('not signed in on this edge (sign in on the Work or Sovereignty screen)') })
    await waitFor(() => { expect(row(container, 'owner key')).toBe('refused (OWNER_ACCESS_REQUIRED)') })
    expect(container.querySelector('[data-edge-signin]')).toBeNull()
    expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('a controller that answered "no owner bound" is UNBOUND read: marked, with its handle field and ceremony', async () => {
    vi.stubGlobal('fetch', host(() => json({ ok: true, runtime: 'local' })))
    const { container } = mount({ status: 'not-connected', reason: 'controller-absent' }, true)
    await waitFor(() => { expect(row(container, 'owner key')).toBe('public key on this host · owner-ed25519-962cbbeae62a') })
    expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('unbound')
    expect([...container.querySelectorAll('[aria-current="step"]')].map(step => step.getAttribute('data-aumlok-state-step'))).toEqual(['unbound'])
    expect(container.querySelector('[data-aumlok-handle-input]')).not.toBeNull()
    expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(1)
    expect(container.querySelector('[data-aumlok-ceremony-absent]')).toBeNull()
  })
  it('which projections are a reading, and what an unread one says', () => {
    expect(aumlokStateRead({ status: 'not-connected', reason: 'adapter-unbound' })).toEqual({ read: true, note: '' })
    expect(aumlokStateRead(AUMLOK_NO_CONTROLLER)).toEqual({ read: false, note: 'not read: no binding service on this host' })
    expect(aumlokStateRead({ status: 'not-connected', reason: 'control-unreadable' }).note).toBe('not read: the binding record could not be read')
    expect(aumlokStateRead({ status: 'not-connected' })).toEqual({ read: false, note: 'not read' })
  })
  it('a key of the wrong shape, a refusal or a missing route is never drawn as a key or a passkey', () => {
    expect(ownerKeyWords({ kind: 'live', route: '/_host/owner-key', body: { publicKeyHex: OWNER_HEX, keyId: 'owner-ed25519-000000000000' } }))
      .toBe('not the expected shape')
    expect(ownerKeyWords({ kind: 'refused', route: '/_host/owner-key', status: 403, code: 'OWNER_ROUTE_FORBIDDEN', message: 'no' }))
      .toBe('refused (OWNER_ROUTE_FORBIDDEN)')
    expect(passkeyWords({ kind: 'absent', route: '/_host/passkey', detail: 'the host answers 404 for /_host/passkey' })).toBe('not on this host yet')
    expect(passkeyWords({ kind: 'live', route: '/_host/passkey', body: { ok: true, registered: true } }))
      .toBe('the host answers; this screen does not read passkey status yet')
    // A host that did not answer at all is unknown, never "not on this host yet".
    const down = { kind: 'absent', route: '/_host/passkey', detail: 'the host did not answer (fetch failed)' } as const
    expect(passkeyWords(down)).toBe('unknown (the host did not answer (fetch failed))')
    expect(ownerKeyWords({ ...down, route: '/_host/owner-key' })).toBe('unknown (the host did not answer (fetch failed))')
    // A missing route (404, or the edge's 501) is "not reported"; a 405 proves the route exists, so it is unknown.
    for (const status of [404, 501]) {
      expect(ownerKeyWords({ kind: 'absent', route: '/_host/owner-key', detail: `the host answers ${String(status)} for /_host/owner-key` }))
        .toBe('not reported by this host')
    }
    expect(passkeyWords({ kind: 'absent', route: '/_host/passkey', detail: 'the host answers 405 for /_host/passkey' }))
      .toBe('unknown (the host answers 405 for /_host/passkey)')
  })
})

/** A seeded generator for draws that must repeat (xorshift32); production draws use crypto.getRandomValues. */
const seeded = (seed: number) => {
  let state = seed >>> 0 || 1
  return (array: Uint32Array<ArrayBuffer>): Uint32Array<ArrayBuffer> => {
    for (let index = 0; index < array.length; index += 1) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0
      array[index] = state
    }
    return array
  }
}
const hexOf = (bytes: Buffer): string => bytes.toString('hex')
const bytesOfHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16))
const fromB64url = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
/** Whether an Ed25519 signature (base64url) by `pubkeyHex` covers exactly `message`. */
const signedBy = async (pubkeyHex: string, signature: string, message: string): Promise<boolean> => {
  const key = await crypto.subtle.importKey('raw', bytesOfHex(pubkeyHex), { name: 'Ed25519' }, false, ['verify'])
  return crypto.subtle.verify('Ed25519', key, fromB64url(signature), new TextEncoder().encode(message))
}

describe('AUMLOK phrase: the canonical lists, the draw, and the check', () => {
  it('carries the owner’s canonical lists: 92 anchors, ROOT 942, UNITE 1170, RISE 1258, bucketed by first letter', () => {
    const size = (band: 'root' | 'unite' | 'rise') => [...AUMLOK_VOCABULARY.bands[band].values()].reduce((sum, bucket) => sum + bucket.length, 0)
    expect([AUMLOK_VOCABULARY.anchors.length, size('root'), size('unite'), size('rise')]).toEqual([92, 942, 1170, 1258])
    // PROVENANCE.md bucket sizes for b and s: ROOT 67/91, UNITE 65/121, RISE 52/91.
    expect(['root', 'unite', 'rise'].map(band => AUMLOK_VOCABULARY.bands[band as 'root'].get('b')?.length)).toEqual([67, 65, 52])
    expect(['root', 'unite', 'rise'].map(band => AUMLOK_VOCABULARY.bands[band as 'root'].get('s')?.length)).toEqual([91, 121, 91])
    expect(AUMLOK_VOCABULARY.anchors.every(anchor => /^[a-z]{6}$/.test(anchor))).toBe(true)
  })
  it('every draw is seven words whose first letters after the anchor spell it, from Root, Root, Unite, Unite, Rise, Rise', () => {
    const random = seeded(2026)
    const bands = ['root', 'root', 'unite', 'unite', 'rise', 'rise'] as const
    for (let draw = 0; draw < 300; draw += 1) {
      const words = generateAumlokPhrase(random)
      expect(words).toHaveLength(7)
      const [anchor = '', ...rest] = words
      expect(rest.map(word => word.charAt(0)).join('')).toBe(anchor)
      rest.forEach((word, slot) => { expect(AUMLOK_VOCABULARY.bands[bands[slot] ?? 'rise'].get(anchor.charAt(slot))).toContain(word) })
      expect(parseAumlokPhrase(words).ok).toBe(true)
    }
  })
  it('an index is uniform by rejection: a draw past the last whole multiple is thrown away', () => {
    const values = [2 ** 32 - 1, 7]
    const random = (array: Uint32Array<ArrayBuffer>) => { array[0] = values.shift() ?? 0; return array }
    expect(uniformIndex(3, random)).toBe(1)
    expect(values).toHaveLength(0)
  })
  it('a typed phrase is NFKC, lower-cased and split on spaces; a wrong count, anchor, band, word or acrostic is refused', () => {
    const words = generateAumlokPhrase(seeded(7))
    const canonical = words.join(' ')
    const wide = canonical.toUpperCase().replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0xfee0))
    expect(parseAumlokPhrase(`  ${wide.replace(/ /g, '\n')}  `)).toEqual({ ok: true, words, canonical })
    expect(parseAumlokPhrase(words.slice(0, 6))).toEqual({ ok: false, code: 'phrase-length' })
    expect(parseAumlokPhrase(['zzzzzz', ...words.slice(1)])).toEqual({ ok: false, code: 'phrase-anchor' })
    expect(parseAumlokPhrase([words[0] ?? '', `${words[1] ?? ''}zz`, ...words.slice(2)])).toEqual({ ok: false, code: 'phrase-word' })
    // The right first letter from the wrong band (a Unite word in a Root slot) is not a phrase.
    const anchor = words[0] ?? ''
    const roots = AUMLOK_VOCABULARY.bands.root.get(anchor.charAt(0)) ?? []
    const unite = (AUMLOK_VOCABULARY.bands.unite.get(anchor.charAt(0)) ?? []).find(word => !roots.includes(word))
    if (unite !== undefined) expect(parseAumlokPhrase([anchor, unite, ...words.slice(2)])).toEqual({ ok: false, code: 'phrase-word' })
    expect(parseAumlokPhrase([anchor, words[2] ?? '', words[1] ?? '', ...words.slice(3)]).ok).toBe(words[1] === words[2])
  })
  it('the commitment is PBKDF2-SHA256 over the domain tag and the words, salted with the node key, matching Node’s own PBKDF2', async () => {
    const canonical = generateAumlokPhrase(seeded(11)).join(' ')
    const node = 'ab'.repeat(32)
    const expected = hexOf(pbkdf2Sync(Buffer.from(`aukora.aumlok.v1\0${canonical}`, 'utf8'), Buffer.from(`aukora.aumlok.v1\0${node}`, 'utf8'), 2000, 32, 'sha256'))
    expect(await aumlokCommitment(canonical, node, 2000)).toBe(expected)
    expect(await aumlokCommitment(canonical, 'cd'.repeat(32), 2000)).not.toBe(expected)
    expect(AUMLOK_KDF_ITERATIONS).toBe(600_000)
  })
})

/** The host's real AUMLOK store (Lanes 2-3, deploy/cloudflare/src/aumlok.mjs) over memory, at the edge's origin. */
const ORIGIN = 'https://node.example.invalid'
type MemoryTx = { get: (key: string) => Promise<unknown>; put: (key: string, next: unknown) => Promise<void> }
const memoryStorage = () => {
  let value: unknown
  const tx: MemoryTx = {
    get: async () => (value === undefined ? undefined : structuredClone(value)),
    put: async (_key, next) => { value = structuredClone(next) },
  }
  return { transaction: async <T,>(operation: (inner: MemoryTx) => Promise<T>): Promise<T> => operation(tx) }
}
/** The host's modules are plain JavaScript: the functions these tests call, with their shapes stated. */
interface AumlokStore {
  readonly status: () => Promise<unknown>
  readonly challenge: (input: Record<string, unknown>, origin: string, transport?: unknown) => Promise<unknown>
  readonly complete: (purpose: string, input: Record<string, unknown>, origin: string, transport?: unknown) => Promise<unknown>
}
interface HostModules {
  readonly createAumlokStore: (storage: unknown, options: Record<string, unknown>) => AumlokStore
  readonly projectAumlokStatus: (value: unknown) => Record<string, unknown>
  readonly projectVerifiedFacts: (runtime: string, input: unknown, options: Record<string, unknown>) => unknown
  /** AUMLOK v2 (Round 22): the host's Class 3 binding; null on a v1 host, whose tests of the sealed root are skipped. */
  readonly aumlokClass3Binding: ((input: Record<string, unknown>) => Promise<unknown>) | null
  /** The host's canonical JSON (`owner-grant-policy.mjs`). */
  readonly canonicalJson: ((value: unknown) => string) | null
  /** The host's owner-grant term check (`owner-grant-policy.mjs`); it throws an error carrying `code` on a refusal. */
  readonly normalizeOwnerGrantBinding: ((input: unknown, options: { now: number }) => unknown) | null
  /** Round 23 (Lanes 2-3): HEAD's own Class 3 rule and promotion binding; null where the host does not have them yet. */
  readonly classifyHeadTransition: ((previous: unknown, candidate: unknown) => unknown) | null
  readonly headPromotionBinding: ((input: unknown) => Promise<unknown>) | null
}
/**
 * The host lane's own AUMLOK store and facts projection, loaded from the repo when they are there (they land in a
 * separate commit). Until both exist with these exports, the tests that run against them are skipped, never failed.
 */
const loadHostModules = async (): Promise<HostModules | null> => {
  const at = (path: string): string => ['', '../../../'].map(prefix => resolve(process.cwd(), prefix + path)).find(existsSync) ?? ''
  const aumlokPath = at('deploy/cloudflare/src/aumlok.mjs')
  const factsPath = at('server/verified-facts.mjs')
  if (aumlokPath === '' || factsPath === '') return null
  const aumlok: unknown = await import(pathToFileURL(aumlokPath).href)
  const facts: unknown = await import(pathToFileURL(factsPath).href)
  const fn = (module: unknown, name: string): unknown => {
    const value = typeof module === 'object' && module !== null ? (module as Record<string, unknown>)[name] : undefined
    return typeof value === 'function' ? value : null
  }
  const store = fn(aumlok, 'createAumlokStore'), status = fn(facts, 'projectAumlokStatus'), project = fn(facts, 'projectVerifiedFacts')
  if (store === null || status === null || project === null) return null
  const policyPath = at('deploy/cloudflare/src/owner-grant-policy.mjs')
  const policy: unknown = policyPath === '' ? null : await import(pathToFileURL(policyPath).href)
  return {
    createAumlokStore: store as HostModules['createAumlokStore'],
    projectAumlokStatus: status as HostModules['projectAumlokStatus'],
    projectVerifiedFacts: project as HostModules['projectVerifiedFacts'],
    aumlokClass3Binding: fn(aumlok, 'aumlokClass3Binding') as HostModules['aumlokClass3Binding'],
    canonicalJson: fn(policy, 'canonicalJson') as HostModules['canonicalJson'],
    normalizeOwnerGrantBinding: fn(policy, 'normalizeOwnerGrantBinding') as HostModules['normalizeOwnerGrantBinding'],
    classifyHeadTransition: fn(policy, 'classifyHeadTransition') as HostModules['classifyHeadTransition'],
    headPromotionBinding: fn(policy, 'headPromotionBinding') as HostModules['headPromotionBinding'],
  }
}
const HOST = await loadHostModules()
/** Whether the host in this tree is AUMLOK v2 (sealed-root escrow, Class 3 by passkey). */
const HOST_V2 = HOST?.aumlokClass3Binding != null
/** The owner's verified Cloudflare Access session, as the Worker passes it to the store (a first binding needs one). */
const OWNER_TRANSPORT = { access: { type: 'owner', email: 'owner@aukora.test', expires: Math.floor(Date.UTC(2030, 0, 1) / 1000) }, ip: '127.0.0.1' }
const host = (): HostModules => { if (HOST === null) throw new Error('the host lane’s modules are not in this tree'); return HOST }
/** The owner's public key the host is configured with (Round 23 stores refuse enrollment and Class 3 without one; older ones ignore it). */
const OWNER_KEY = '0a'.repeat(32)
const OWNED = { origins: [ORIGIN], ownerPublicKeyHex: OWNER_KEY }
const approveAll = async ({ intentHash }: { intentHash: string }) => ({ authorized: true, intentHash })
const statusBody = async (store: { status: () => Promise<unknown> }): Promise<Record<string, unknown>> => {
  const body = await store.status()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('status is not an object')
  return body as Record<string, unknown>
}

/** A host stand-in for the completion steps (which need a real authenticator): it records every body and answers as the store does. */
interface CeremonyHostOptions {
  readonly bind?: 'refuse' | 'absent'
  readonly tamperIntent?: boolean
  readonly sealedRoot?: AumlokSealedRoot
  readonly node?: string
}
function ceremonyHost(options: CeremonyHostOptions = {}) {
  const requests: Array<{ route: string; body: Record<string, unknown> }> = []
  let bindCalls = 0
  let nodePubkeyHex = ''
  let registrationIntent = ''
  const assertion = (purpose: string, intentHash: string) => ({ ok: true, phase: 'PENDING_ASSERTION', challengeId: `${purpose}-assertion-0001`, purpose,
    intentHash, nodeProofPreimage: options.tamperIntent === true ? 'aukora.aumlok.node-possession.v1\nsomething-else' : AUMLOK_NODE_DOMAIN + intentHash,
    publicKey: { challenge: base64url(new Uint8Array(32).fill(3)), rpId: 'node.example.invalid', userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: 'Y3JlZGVudGlhbC1pZC0wMQ' }] } })
  const call: AumlokHostCall = async (route, _signal, body) => {
    requests.push({ route, body: body ?? {} })
    const ok = (value: Record<string, unknown>): HostAnswer => ({ kind: 'live', route, body: value })
    if (route === '/_host/aumlok/challenge') {
      if (body?.purpose === 'bind') {
        nodePubkeyHex = String(body.nodePubkeyHex)
        registrationIntent = 'a'.repeat(64)
        return ok({ ok: true, phase: 'PENDING_REGISTRATION', challengeId: 'bind-registration-0001', purpose: 'bind', intentHash: registrationIntent,
          nodeProofPreimage: AUMLOK_NODE_DOMAIN + registrationIntent, publicKey: { challenge: base64url(new Uint8Array(32).fill(1)),
            rp: { id: 'node.example.invalid', name: 'AUKORA' }, user: { id: 'dXNlci1pZA', name: 'bind-registration-0001', displayName: 'AUMLOK identity' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none' } })
      }
      return ok(body?.purpose === 'unseal' ? assertion('unseal', 'e'.repeat(64)) : assertion('refresh', 'c'.repeat(64)))
    }
    if (route === '/_host/aumlok/unseal') {
      return options.sealedRoot === undefined ? { kind: 'refused', route, status: 503, code: 'AUMLOK_ESCROW_CORRUPT', message: 'no' }
        : ok({ ok: true, phase: 'BOUND', bound: true, sealedRoot: options.sealedRoot })
    }
    if (route === '/_host/aumlok/bind') {
      if (options.bind === 'absent') return { kind: 'absent', route, detail: 'the host answers 404 for /_host/aumlok/bind' }
      if (options.bind === 'refuse') return { kind: 'refused', route, status: 503, code: 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE', message: 'no' }
      bindCalls += 1
      if (bindCalls === 1) return ok(assertion('bind', 'b'.repeat(64)))
      const signature = String(body?.nodeSignature)
      return await signedBy(nodePubkeyHex, signature, AUMLOK_NODE_DOMAIN + 'b'.repeat(64))
        ? ok({ ok: true, phase: 'BOUND', bound: true }) : { kind: 'refused', route, status: 403, code: 'AUMLOK_NODE_PROOF_INVALID', message: 'no' }
    }
    if (route === '/_host/aumlok/refresh') {
      return await signedBy(options.node ?? '', String(body?.nodeSignature), AUMLOK_NODE_DOMAIN + 'c'.repeat(64))
        ? ok({ ok: true, phase: 'BOUND', bound: true }) : { kind: 'refused', route, status: 403, code: 'AUMLOK_NODE_PROOF_INVALID', message: 'no' }
    }
    return { kind: 'absent', route, detail: `the host answers 404 for ${route}` }
  }
  return { call, requests }
}
/** Client data the host can decode (its shape check parses it); the stand-in attestation and signature fail verification only. */
/**
 * The stand-in attestation object: WELL-FORMED CBOR, { fmt: 'packed', attStmt: { alg: -7, sig: 8 zero bytes }, authData: 37
 * zero bytes }, shaped as a real authenticator's 'packed' attestation. The host takes only 'none', so its real store refuses
 * it as AUMLOK_ATTESTATION_UNSUPPORTED. (The old stand-in, the ASCII text "attestation", decodes as a CBOR text string, not
 * an attestation object at all: that is malformed, AUMLOK_PROOF_INVALID.)
 */
const PACKED_ATTESTATION = 'o2NmbXRmcGFja2VkZ2F0dFN0bXSiY2FsZyZjc2lnSAAAAAAAAAAAaGF1dGhEYXRhWCUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const clientDataOf = (type: string): string => base64url(new TextEncoder().encode(JSON.stringify({ type, challenge: 'AQ', origin: ORIGIN })))
const REGISTRATION: PasskeyResponseJson = { id: 'Y3JlZGVudGlhbC1pZC0wMQ', rawId: 'Y3JlZGVudGlhbC1pZC0wMQ', type: 'public-key', authenticatorAttachment: null,
  response: { clientDataJSON: clientDataOf('webauthn.create'), attestationObject: PACKED_ATTESTATION, transports: ['internal'] }, clientExtensionResults: {} }
const ASSERTION: PasskeyResponseJson = { id: 'Y3JlZGVudGlhbC1pZC0wMQ', rawId: 'Y3JlZGVudGlhbC1pZC0wMQ', type: 'public-key', authenticatorAttachment: 'platform',
  response: { clientDataJSON: clientDataOf('webauthn.get'), authenticatorData: 'YXV0aC1kYXRh', signature: 'c2lnbmF0dXJl', userHandle: null },
  clientExtensionResults: {} }
const PLATFORM: AumlokPlatform = {
  passkeyBlocker: () => null,
  passkey: async step => (step.kind === 'register' ? REGISTRATION : ASSERTION),
  nodeKeys: async () => true,
}
/** A bound node made the way a binding makes one: a fixed root sealed under known words (a low work factor, for speed). */
const FIXTURE_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const CURRENT_WORDS = generateAumlokPhrase(seeded(5))
const FIXTURE_NODE = await aumlokNodeOf(FIXTURE_ROOT)
const FIXTURE_SEALED = await sealAumlokRoot(FIXTURE_ROOT.slice(), CURRENT_WORDS.join(' '), FIXTURE_NODE.nodePubkeyHex, { iterations: 1000 })
const SEALED_KEYS = ['ivB64', 'kdfIterations', 'kdfSaltB64', 'sealedRootKeyB64']
const sealedOf = (body: Record<string, unknown>): AumlokSealedRoot | null =>
  parseSealedRoot(Object.fromEntries(SEALED_KEYS.map(key => [key, body[key]])), 1000)
const UNBOUND: AumlokHostStatus = { state: 'unbound', passkeyVerified: false, nodePubkeyHex: null, commitmentSha256: null, boundAt: null,
  enrollmentAvailable: true, blockers: [], identityIsKey: true, domainIsPointer: true, invites: { issued: 0, limit: 3, month: '2026-11' },
  keyCommitmentId: null, rotationSeq: null, approvedGrants: [], lastRotationChallengeId: null,
  pepperSeparated: null, checksPhraseOnline: false }
const BOUND: AumlokHostStatus = { ...UNBOUND, state: 'bound', passkeyVerified: true, nodePubkeyHex: FIXTURE_NODE.nodePubkeyHex, boundAt: 1 }

describe('AUMLOK ceremony in this page, on the host’s own contract (Class 4)', () => {
  const fast = { iterations: 1000, sealIterations: 1000, random: seeded(42), platform: PLATFORM } as const
  it('binds in three requests that carry only the commitment, the node key, the sealed root, the passkey’s public proofs and the node’s signature', async () => {
    const host = ceremonyHost()
    const ceremony = createBrowserCeremony({ ...fast, call: host.call })
    const drawn = await ceremony.draw('bind', UNBOUND)
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    expect(await ceremony.submit('bind', drawn.words.map(word => word.toUpperCase()))).toEqual({ ok: true })
    const [challenge, register, assert] = host.requests
    expect(host.requests.map(request => request.route)).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/bind', '/_host/aumlok/bind'])
    expect(Object.keys(challenge?.body ?? {}).sort()).toEqual(['commitmentSha256', 'nodePubkeyHex', 'purpose', 'requestId', ...SEALED_KEYS].sort())
    const node = String(challenge?.body.nodePubkeyHex)
    const sealed = sealedOf(challenge?.body ?? {})
    if (sealed === null) throw new Error('no sealed root in the bind request')
    expect(challenge?.body).toEqual({ purpose: 'bind', requestId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown, nodePubkeyHex: node,
      commitmentSha256: hexOf(pbkdf2Sync(Buffer.from(`aukora.aumlok.v1\0${drawn.words.join(' ')}`), Buffer.from(`aukora.aumlok.v1\0${node}`), 1000, 32, 'sha256')),
      ...sealed })
    // THE SEALED ROOT OPENS WITH THE DRAWN WORDS, AND ONLY THEM, INTO THE NODE THAT SIGNED.
    const opened = await openAumlokRoot(sealed, drawn.words.join(' '), node)
    expect(opened.ok && opened.node.nodePubkeyHex).toBe(node)
    expect(await openAumlokRoot(sealed, generateAumlokPhrase(seeded(99)).join(' '), node)).toEqual({ ok: false, code: 'aumlok:words-do-not-open' })
    // The credential crosses in the exact shape the host validates: no null attachment, no extension results.
    expect(register?.body).toEqual({ challengeId: 'bind-registration-0001', credential: { id: REGISTRATION.id, rawId: REGISTRATION.rawId,
      type: 'public-key', response: REGISTRATION.response, clientExtensionResults: {} } })
    expect(Object.keys(assert?.body ?? {}).sort()).toEqual(['challengeId', 'credential', 'nodeSignature'])
    expect(await signedBy(node, String(assert?.body.nodeSignature), AUMLOK_NODE_DOMAIN + 'b'.repeat(64))).toBe(true)
    for (const request of host.requests) expect(JSON.stringify(request.body)).not.toContain(drawn.words.join(' '))
  })
  it('rotates from the words in use: the passkey releases the sealed root, the words open it, the SAME root is sealed under the new words', async () => {
    const node = FIXTURE_NODE.nodePubkeyHex
    const host = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node })
    const ceremony = createBrowserCeremony({ ...fast, call: host.call })
    expect(await ceremony.draw('refresh', BOUND)).toEqual({ ok: false, reason: 'aumlok:current-words-needed' })
    const drawn = await ceremony.draw('refresh', BOUND, CURRENT_WORDS.map(word => word.toUpperCase()))
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    expect(await ceremony.submit('refresh', drawn.words)).toEqual({ ok: true })
    // The status read just before the rotation's challenge is a plain GET; the four POSTs are the ceremony.
    expect(host.requests.map(request => request.route)).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/unseal', '/_host/aumlok/status',
      '/_host/aumlok/challenge', '/_host/aumlok/refresh'])
    expect(host.requests[0]?.body).toEqual({ purpose: 'unseal', requestId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown })
    expect(Object.keys(host.requests[1]?.body ?? {}).sort()).toEqual(['challengeId', 'credential'])
    const rotate = host.requests[3]?.body ?? {}
    expect(Object.keys(rotate).sort()).toEqual(['commitmentSha256', 'purpose', 'requestId', ...SEALED_KEYS].sort())
    expect(rotate.commitmentSha256).toBe(await aumlokCommitment(drawn.words.join(' '), node, 1000))
    // THE NODE KEEPS ITS KEY: the new seal opens with the new words into the same root, and the old words no longer open it.
    const sealed = sealedOf(rotate)
    if (sealed === null) throw new Error('no sealed root in the rotation')
    const reopened = await openAumlokRoot(sealed, drawn.words.join(' '), node)
    expect(reopened.ok ? [...reopened.root] : null).toEqual([...FIXTURE_ROOT])
    expect(await openAumlokRoot(sealed, CURRENT_WORDS.join(' '), node)).toEqual({ ok: false, code: 'aumlok:words-do-not-open' })
    const refresh = host.requests[4]?.body ?? {}
    expect(Object.keys(refresh).sort()).toEqual(['challengeId', 'credential', 'nodeSignature'])
    expect(await signedBy(node, String(refresh.nodeSignature), AUMLOK_NODE_DOMAIN + 'c'.repeat(64))).toBe(true)
    for (const { body } of host.requests) {
      expect(JSON.stringify(body)).not.toContain(drawn.words.join(' '))
      expect(JSON.stringify(body)).not.toContain(CURRENT_WORDS.join(' '))
    }
    expect(await ceremony.draw('refresh', UNBOUND, CURRENT_WORDS)).toEqual({ ok: false, reason: 'aumlok:not-bound' })
    expect(await ceremony.draw('bind', BOUND)).toEqual({ ok: false, reason: 'aumlok:already-bound' })
  })
  it('a rotation stops before any new words exist when the words in use are not a phrase, do not open the root, or open another node', async () => {
    const invalid = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: FIXTURE_NODE.nodePubkeyHex })
    expect(await createBrowserCeremony({ ...fast, call: invalid.call }).draw('refresh', BOUND, ['not', 'a', 'phrase']))
      .toEqual({ ok: false, reason: 'aumlok:current-words-invalid' })
    expect(invalid.requests).toHaveLength(0)
    const wrong = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: FIXTURE_NODE.nodePubkeyHex })
    expect(await createBrowserCeremony({ ...fast, call: wrong.call }).draw('refresh', BOUND, generateAumlokPhrase(seeded(99))))
      .toEqual({ ok: false, reason: 'aumlok:words-do-not-open' })
    expect(wrong.requests.map(request => request.route)).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/unseal'])
    // A root sealed for the bound key's name that makes a different node is refused after it opens.
    const other = 'ef'.repeat(32)
    const forged = await sealAumlokRoot(FIXTURE_ROOT.slice(), CURRENT_WORDS.join(' '), other, { iterations: 1000 })
    const swapped = ceremonyHost({ sealedRoot: forged, node: other })
    expect(await createBrowserCeremony({ ...fast, call: swapped.call }).draw('refresh', { ...BOUND, nodePubkeyHex: other }, CURRENT_WORDS))
      .toEqual({ ok: false, reason: 'aumlok:root-is-another-node' })
    const lost = ceremonyHost({ node: FIXTURE_NODE.nodePubkeyHex })
    expect(await createBrowserCeremony({ ...fast, call: lost.call }).draw('refresh', BOUND, CURRENT_WORDS))
      .toEqual({ ok: false, reason: 'aumlok:AUMLOK_ESCROW_CORRUPT' })
  })
  it('a valid phrase that is not the drawn one is refused here with no request, and the draw stays for another try', async () => {
    const host = ceremonyHost()
    const ceremony = createBrowserCeremony({ ...fast, call: host.call })
    const drawn = await ceremony.draw('bind', UNBOUND)
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    const other = generateAumlokPhrase(seeded(99))
    expect(parseAumlokPhrase(other).ok).toBe(true)
    expect(await ceremony.submit('bind', other)).toEqual({ ok: false, reason: 'aumlok:words-differ' })
    expect(host.requests).toHaveLength(0)
    expect(await ceremony.submit('bind', drawn.words)).toEqual({ ok: true })
  })
  it('every failure after the commitment spends the draw and drops it with its node key: a missing route, a refusal, a tampered intent', async () => {
    for (const [options, reason] of [
      [{ bind: 'absent' }, 'aumlok:route-absent'],
      [{ bind: 'refuse' }, 'aumlok:AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'],
      [{ tamperIntent: true }, 'aumlok:intent-mismatch'],
    ] as const) {
      const host = ceremonyHost(options)
      let prompts = 0
      const counting: AumlokPlatform = {
        ...PLATFORM, passkey: async (step, signal) => { prompts += 1; return PLATFORM.passkey(step, signal) },
      }
      const ceremony = createBrowserCeremony({ ...fast, call: host.call, platform: counting })
      const drawn = await ceremony.draw('bind', UNBOUND)
      if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
      expect(await ceremony.submit('bind', drawn.words)).toEqual({ ok: false, reason, drawSpent: true })
      // The node never signs a string the host chose, and a malformed intent never asks for the second passkey.
      if ('tamperIntent' in options) {
        expect(host.requests.filter(request => request.route === '/_host/aumlok/bind')).toHaveLength(1)
        expect(prompts).toBe(1)
      }
      expect(await ceremony.submit('bind', drawn.words)).toEqual({ ok: false, reason: 'aumlok:no-draw', drawSpent: true })
    }
    const absent = createBrowserCeremony({ ...fast, call: async route => ({ kind: 'absent', route, detail: 'the host answers 404' }) })
    expect(await absent.draw('refresh', BOUND, CURRENT_WORDS)).toEqual({ ok: false, reason: 'aumlok:route-absent' })
    expect(await absent.submit('refresh', CURRENT_WORDS)).toEqual({ ok: false, reason: 'aumlok:no-draw', drawSpent: true })
  })
  it('closing the screen aborts: a draw in flight never becomes the ceremony, and a submit in flight sends nothing', async () => {
    const host = ceremonyHost()
    const ceremony = createBrowserCeremony({ ...fast, call: host.call })
    const late = ceremony.draw('bind', UNBOUND)
    ceremony.reset()
    expect(await late).toEqual({ ok: false, reason: 'aumlok:draw-superseded' })
    const drawn = await ceremony.draw('bind', UNBOUND)
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    const submitting = ceremony.submit('bind', drawn.words)
    ceremony.reset()
    expect(await submitting).toEqual({ ok: false, reason: 'aumlok:closed', drawSpent: true })
    expect(host.requests).toHaveLength(0)
  })
  it('reads the host’s status only in its schema: a phase that disagrees with bound, or a bound node with no key, is unreadable', () => {
    expect(parseAumlokStatus({ phase: 'BOUND', bound: false })).toBeNull()
    expect(parseAumlokStatus({ phase: 'BOUND', bound: true, nodePubkeyHex: null, commitmentSha256: 'a'.repeat(64) })).toBeNull()
    // AUMLOK v2 serves no commitment (it is peppered at the host): a bound node with its key reads, the commitment null.
    expect(parseAumlokStatus({ phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ab'.repeat(32), commitmentSha256: null }))
      .toMatchObject({ state: 'bound', passkeyVerified: true, nodePubkeyHex: 'ab'.repeat(32), commitmentSha256: null })
    expect(parseAumlokStatus({ state: 'BOUND' })).toBeNull()
    expect(parseAumlokStatus({ phase: 'UNBOUND', bound: false, words: ['ignored'] })).toEqual({ state: 'unbound', passkeyVerified: false,
      nodePubkeyHex: null, commitmentSha256: null, boundAt: null, enrollmentAvailable: false, blockers: [], identityIsKey: false,
      domainIsPointer: false, invites: null, keyCommitmentId: null, rotationSeq: null, approvedGrants: [], lastRotationChallengeId: null,
      pepperSeparated: null, checksPhraseOnline: false })
  })
})

/** A platform authenticator stand-in: the browser classes runPasskey checks, and client data naming the exact challenge and origin. */
function stubAuthenticator() {
  class FakeAttestation {
    constructor(readonly clientDataJSON: ArrayBuffer, readonly attestationObject: ArrayBuffer) {}
    getTransports(): string[] { return ['internal'] }
  }
  class FakeAssertion {
    constructor(readonly clientDataJSON: ArrayBuffer, readonly authenticatorData: ArrayBuffer, readonly signature: ArrayBuffer,
      readonly userHandle: ArrayBuffer | null) {}
  }
  class FakeCredential {
    readonly type = 'public-key'
    readonly authenticatorAttachment = 'platform'
    readonly id: string
    constructor(readonly rawId: ArrayBuffer, readonly response: unknown) { this.id = base64url(new Uint8Array(rawId)) }
    getClientExtensionResults(): Record<string, unknown> { return {} }
  }
  const rawId = new Uint8Array(16).fill(7).buffer
  const bytesOf = (source: BufferSource): Uint8Array => new Uint8Array(source instanceof ArrayBuffer ? source : source.buffer)
  const clientData = (type: string, challenge: BufferSource): ArrayBuffer =>
    new TextEncoder().encode(JSON.stringify({ type, challenge: base64url(bytesOf(challenge)), origin: location.origin })).buffer
  vi.stubGlobal('PublicKeyCredential', FakeCredential)
  vi.stubGlobal('AuthenticatorAttestationResponse', FakeAttestation)
  vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertion)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
    create: async ({ publicKey }: { publicKey: PublicKeyCredentialCreationOptions }) =>
      new FakeCredential(rawId, new FakeAttestation(clientData('webauthn.create', publicKey.challenge), new Uint8Array([1, 2, 3]).buffer)),
    get: async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) =>
      new FakeCredential(rawId, new FakeAssertion(clientData('webauthn.get', publicKey.challenge), new Uint8Array([4]).buffer, new Uint8Array([5]).buffer, null)),
  } })
  return () => {
    Reflect.deleteProperty(window, 'isSecureContext')
    Reflect.deleteProperty(navigator, 'credentials')
  }
}
/** The host's assertion challenge for the on-screen tests (the page's own origin, the stubbed authenticator's id). */
const screenAssertion = (purpose: string, intent: string) => ({ ok: true, phase: 'PENDING_ASSERTION', challengeId: `${purpose}-0001`, purpose,
  intentHash: intent, nodeProofPreimage: AUMLOK_NODE_DOMAIN + intent, publicKey: { challenge: base64url(new Uint8Array(32).fill(4)), rpId: 'localhost',
    userVerification: 'required', allowCredentials: [{ type: 'public-key', id: base64url(new Uint8Array(16).fill(7)) }] } })
const AUMLOK_PROPS = {
  activeSurface: 'aumlok',
  closeSurface: () => {},
  t: (key: string) => new Map<string, string>(Object.entries(AUMLOK_EN)).get(key) ?? key,
  useControlProjection: <S,>(select: (projection: AumlokControlProjectionState) => S): S => select(AUMLOK_NO_CONTROLLER),
  ceremonyAvailable: false,
  drawPhrase: async () => ({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
  submitPhrase: async () => ({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
  refreshControlStatus: () => {},
}
const hostStatusBody = (phase: 'BOUND' | 'UNBOUND', enrollmentAvailable: boolean, node = 'ef'.repeat(32)) => ({ ok: true, schema: 'aukora.aumlok.status.v1',
  phase, bound: phase === 'BOUND', passkeyVerified: phase === 'BOUND', aumlokId: phase === 'BOUND' ? 'd'.repeat(64) : null,
  nodePubkeyHex: phase === 'BOUND' ? node : null, commitmentSha256: phase === 'BOUND' ? '1'.repeat(64) : null,
  boundAt: phase === 'BOUND' ? Date.UTC(2026, 10, 9) : null, lastVerifiedAt: phase === 'BOUND' ? Date.UTC(2026, 10, 9) : null,
  authorityAvailable: phase === 'BOUND' || enrollmentAvailable, enrollmentAvailable, blockers: phase === 'BOUND' || enrollmentAvailable ? [] : ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'],
  biometricVerified: false, phraseRecoveryAvailable: false, identityIsKey: true, domainIsPointer: true,
  invite: { quotaMonth: '2026-11', issuedThisMonth: 0, limit: 3, revokedCount: 0 } })

describe('the AUMLOK screen on a host that serves /_host/aumlok', () => {
  it('as the hosts are today (no trusted owner approval): UNBOUND read, the reason said, no control, the node’s rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/_host/aumlok/status' ? json(hostStatusBody('UNBOUND', false))
      : input === '/__x6/status' ? json({ ok: true, runtime: 'local' }) : new Response('nope', { status: 404 }))))
    const { container } = render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(AUMLOK_PROPS)} />)
    await waitFor(() => { expect(container.querySelector('[data-aumlok-ceremony-absent]')?.textContent).toContain('trusted owner approval') })
    expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('unbound')
    expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(0)
    const owner = container.querySelector('[data-aumlok-owner-state]')?.textContent ?? ''
    expect(owner).toContain('no node key yet (unbound)')
    expect(owner).toContain('0 of 3 issued in 2026-11 · aukora.invite.v1')
    expect(container.querySelector('[data-aumlok-identity-rule]')?.textContent).toBe('Node identity = cryptographic key · Domain = rotatable pointer')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('draw, type back, confirm, bind: two passkey prompts and a node signature; the words never leave; BOUND after', async () => {
    const restore = stubAuthenticator()
    let phase: 'BOUND' | 'UNBOUND' = 'UNBOUND'
    let node = ''
    const bodies: Array<{ route: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (init?.method === 'POST') bodies.push({ route: input, body })
      if (input === '/_host/aumlok/status') return json(hostStatusBody(phase, true, node || undefined))
      if (input === '/__x6/status') return json({ ok: true, runtime: 'local' })
      if (input === '/_host/aumlok/challenge') {
        node = String(body.nodePubkeyHex)
        return json({ ok: true, phase: 'PENDING_REGISTRATION', challengeId: 'bind-registration-0001', purpose: 'bind', intentHash: 'a'.repeat(64),
          nodeProofPreimage: AUMLOK_NODE_DOMAIN + 'a'.repeat(64), publicKey: { challenge: base64url(new Uint8Array(32).fill(1)),
            rp: { id: 'localhost', name: 'AUKORA' }, user: { id: 'dXNlci1pZA', name: 'bind-registration-0001', displayName: 'AUMLOK identity' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none' } })
      }
      if (input === '/_host/aumlok/bind' && body.nodeSignature === undefined) {
        return json({ ok: true, phase: 'PENDING_ASSERTION', challengeId: 'bind-assertion-0002', purpose: 'bind', intentHash: 'b'.repeat(64),
          nodeProofPreimage: AUMLOK_NODE_DOMAIN + 'b'.repeat(64), publicKey: { challenge: base64url(new Uint8Array(32).fill(2)), rpId: 'localhost',
            userVerification: 'required', allowCredentials: [{ type: 'public-key', id: base64url(new Uint8Array(16).fill(7)) }] } })
      }
      if (input === '/_host/aumlok/bind') {
        if (!await signedBy(node, String(body.nodeSignature), AUMLOK_NODE_DOMAIN + 'b'.repeat(64))) return json({ ok: false, code: 'AUMLOK_NODE_PROOF_INVALID' }, 403)
        phase = 'BOUND'
        return json(hostStatusBody('BOUND', true, node))
      }
      return new Response('nope', { status: 404 })
    }))
    try {
      const { container } = render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(AUMLOK_PROPS)} />)
      const button = () => container.querySelector('[data-aumlok-bind-button]')
      await waitFor(() => { expect(button()).not.toBeNull() })
      expect(container.querySelector('[data-aumlok-handle-input]')).toBeNull()
      expect(container.querySelector('[data-aumlok-passkey-note]')?.textContent).toContain('passkey twice')
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-face="word"]')).not.toBeNull() }, { timeout: 10_000 })
      const anchor = [...container.querySelectorAll('[data-aumlok-anchor-box-kind="letter"]')].map(box => box.textContent).join('')
      const words = [anchor, ...[...container.querySelectorAll('span[data-aumlok-tile-face="word"]')].map(span => span.textContent ?? '')]
      expect(parseAumlokPhrase(words).ok).toBe(true)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      words.forEach((word, position) => {
        const input = container.querySelector(`[data-aumlok-tile-input="${String(position)}"]`)
        if (input === null) throw new Error(`no tile ${String(position)}`)
        fireEvent.change(input, { target: { value: word } })
      })
      fireEvent.click(button() as Element)
      const box = container.querySelector('[data-aumlok-confirm-checkbox]')
      if (box === null) throw new Error('no confirmation box')
      fireEvent.click(box)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('bound') }, { timeout: 15_000 })
      expect(bodies.map(entry => `${entry.route} ${Object.keys(entry.body).sort().join(',')}`)).toEqual([
        '/_host/aumlok/challenge commitmentSha256,ivB64,kdfIterations,kdfSaltB64,nodePubkeyHex,purpose,requestId,sealedRootKeyB64',
        '/_host/aumlok/bind challengeId,credential',
        '/_host/aumlok/bind challengeId,credential,nodeSignature',
      ])
      // The page seals at the production work factor, the host's floor.
      expect(bodies[0]?.body.kdfIterations).toBe(AUMLOK_SEAL_ITERATIONS)
      for (const { body } of bodies) expect(JSON.stringify(body)).not.toContain(words.join(' '))
      // The typed words leave the screen's state with the success.
      expect([...container.querySelectorAll('input[data-aumlok-tile-input]')].every(input => (input as HTMLInputElement).value === '')).toBe(true)
      // Bound now, the screen checks again (Ed25519 included, for a rotation) before it offers its one control.
      await waitFor(() => { expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(1) })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { restore() }
  }, 40_000)
  it('rotation on screen: the words in use first, Touch ID releases the sealed root, new words, BOUND with the same node key', async () => {
    const restore = stubAuthenticator()
    const root = Uint8Array.from({ length: 32 }, (_, index) => 200 - index)
    const node = (await aumlokNodeOf(root)).nodePubkeyHex
    const current = generateAumlokPhrase(seeded(31))
    const sealedNow = await sealAumlokRoot(root.slice(), current.join(' '), node)
    const bodies: Array<{ route: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (init?.method === 'POST') bodies.push({ route: input, body })
      if (input === '/_host/aumlok/status') return json({ ...hostStatusBody('BOUND', true, node), commitmentSha256: null })
      if (input === '/__x6/status') return json({ ok: true, runtime: 'local' })
      if (input === '/_host/aumlok/challenge') return json(screenAssertion(String(body.purpose), body.purpose === 'unseal' ? 'e'.repeat(64) : 'c'.repeat(64)))
      if (input === '/_host/aumlok/unseal') return json({ ...hostStatusBody('BOUND', true, node), sealedRoot: sealedNow })
      if (input === '/_host/aumlok/refresh') {
        return await signedBy(node, String(body.nodeSignature), AUMLOK_NODE_DOMAIN + 'c'.repeat(64))
          ? json(hostStatusBody('BOUND', true, node)) : json({ ok: false, code: 'AUMLOK_NODE_PROOF_INVALID' }, 403)
      }
      return new Response('nope', { status: 404 })
    }))
    const type = (container: HTMLElement, words: readonly string[]) => {
      words.forEach((word, position) => {
        const input = container.querySelector(`[data-aumlok-tile-input="${String(position)}"]`)
        if (input === null) throw new Error(`no tile ${String(position)}`)
        fireEvent.change(input, { target: { value: word } })
      })
    }
    try {
      const { container } = render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(AUMLOK_PROPS)} />)
      const button = () => container.querySelector('[data-aumlok-bind-button]')
      await waitFor(() => { expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('bound') })
      expect(container.querySelector('[data-aumlok-receipt-root]')?.textContent).toBe(node)
      await waitFor(() => { expect(button()).not.toBeNull() })
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      expect(button()?.textContent).toBe('Open my root with these words')
      expect(container.querySelector('[data-aumlok-passkey-note]')?.textContent).toContain('seven words you use now')
      type(container, current)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-face="word"]')).not.toBeNull() }, { timeout: 10_000 })
      const anchor = [...container.querySelectorAll('[data-aumlok-anchor-box-kind="letter"]')].map(box => box.textContent).join('')
      const words = [anchor, ...[...container.querySelectorAll('span[data-aumlok-tile-face="word"]')].map(span => span.textContent ?? '')]
      expect(parseAumlokPhrase(words).ok).toBe(true)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      type(container, words)
      fireEvent.click(button() as Element)
      const box = container.querySelector('[data-aumlok-confirm-checkbox]')
      if (box === null) throw new Error('no confirmation box')
      fireEvent.click(box)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(bodies.some(entry => entry.route === '/_host/aumlok/refresh')).toBe(true) }, { timeout: 15_000 })
      await waitFor(() => { expect(container.querySelector('[data-aumlok-binding-refused]')).toBeNull() })
      expect(bodies.map(entry => `${entry.route} ${Object.keys(entry.body).sort().join(',')}`)).toEqual([
        '/_host/aumlok/challenge purpose,requestId',
        '/_host/aumlok/unseal challengeId,credential',
        '/_host/aumlok/challenge commitmentSha256,ivB64,kdfIterations,kdfSaltB64,purpose,requestId,sealedRootKeyB64',
        '/_host/aumlok/refresh challengeId,credential,nodeSignature',
      ])
      const resealed = parseSealedRoot(Object.fromEntries(SEALED_KEYS.map(key => [key, bodies[2]?.body[key]])))
      if (resealed === null) throw new Error('no sealed root in the rotation')
      const opened = await openAumlokRoot(resealed, words.join(' '), node)
      expect(opened.ok ? [...opened.root] : null).toEqual([...root])
      for (const { body } of bodies) {
        expect(JSON.stringify(body)).not.toContain(words.join(' '))
        expect(JSON.stringify(body)).not.toContain(current.join(' '))
      }
      expect([...container.querySelectorAll('input[data-aumlok-tile-input]')].every(input => (input as HTMLInputElement).value === '')).toBe(true)
      expect(container.querySelectorAll('[data-aumlok-surface] button')).toHaveLength(1)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { restore() }
  }, 60_000)
})

describe.skipIf(HOST === null)('against the host lane’s own AUMLOK store (Round 21; skipped until it is in this tree)', () => {
  // The seal keeps the production work factor here: the host refuses a sealed root below its 600 000 floor.
  const fast = { iterations: 1000, random: seeded(43), platform: PLATFORM } as const
  it('the host’s real store: its status reads here, and a first binding here says it needs the host’s trusted owner approval', async () => {
    const parsed = parseAumlokStatus(await statusBody(host().createAumlokStore(memoryStorage(), OWNED)))
    expect(parsed).toMatchObject({ state: 'unbound', enrollmentAvailable: false, blockers: ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'],
      identityIsKey: true, domainIsPointer: true, invites: { issued: 0, limit: 3 } })
    if (parsed === null) throw new Error('unreadable')
    expect(await aumlokCeremonyAvailability(parsed, PLATFORM)).toEqual({ ok: false,
      reason: 'this host has no trusted owner approval for a first binding yet (AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE)' })
    expect(await aumlokCeremonyAvailability({ ...parsed, enrollmentAvailable: true }, { ...PLATFORM, passkeyBlocker: () => 'no WebAuthn' }))
      .toEqual({ ok: false, reason: 'no WebAuthn; binding here needs a passkey' })
    expect(await aumlokCeremonyAvailability(BOUND, PLATFORM)).toEqual({ ok: true })
  })
  it.skipIf(!HOST_V2)('AUMLOK v2: the host’s real store accepts this page’s sealed-root challenge and registration by shape; only the stand-in attestation is refused', async () => {
    const store = host().createAumlokStore(memoryStorage(), { ...OWNED, authorizeEnrollment: approveAll })
    const answers: Array<Record<string, unknown>> = []
    const call: AumlokHostCall = async (route, _signal, body) => {
      if (body === undefined) return { kind: 'absent', route, detail: `the host answers 404 for ${route}` }
      const answer = (route === '/_host/aumlok/challenge' ? await store.challenge(body, ORIGIN, OWNER_TRANSPORT)
        : await store.complete('bind', body, ORIGIN, OWNER_TRANSPORT)) as Record<string, unknown>
      answers.push(answer)
      return answer.ok === true ? { kind: 'live', route, body: answer }
        : { kind: 'refused', route, status: Number(answer.status), code: String(answer.code), message: 'refused' }
    }
    const ceremony = createBrowserCeremony({ ...fast, call })
    const drawn = await ceremony.draw('bind', parseAumlokStatus(await statusBody(store)))
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    expect(await ceremony.submit('bind', drawn.words)).toEqual({ ok: false, reason: 'aumlok:AUMLOK_ATTESTATION_UNSUPPORTED', drawSpent: true })
    const [challenge, registration] = answers
    expect(challenge).toMatchObject({ ok: true, phase: 'PENDING_REGISTRATION', purpose: 'bind' })
    expect(challenge?.nodeProofPreimage).toBe(AUMLOK_NODE_DOMAIN + String(challenge?.intentHash))
    expect(readChallenge('register', challenge).kind).toBe('register')
    // The store reaches its attestation-format check only after the body's keys and the credential's shape are accepted
    // (a wrong shape is AUMLOK_REQUEST_INVALID or AUMLOK_PROOF_INVALID first); the stand-in attestation stops it there.
    expect(registration).toMatchObject({ ok: false, code: 'AUMLOK_ATTESTATION_UNSUPPORTED' })
  })
})

describe.skipIf(HOST === null)('the node in the host’s facts (Round 21; skipped until the host lane’s projection is in this tree)', () => {
  it('reads organ source and AUMLOK as projectVerifiedFacts sends them, and says what each is', async () => {
    const aumlok = host().projectAumlokStatus(await statusBody(host().createAumlokStore(memoryStorage(), OWNED)))
    const node = parseNodeFacts({ organSourceCommit: 'ca9fcd15a1bfebedac574ef524efe9c955073214', organSourceEvidence: 'recorded-build-info', aumlok })
    expect(node).toEqual({ organSourceCommit: 'ca9fcd15a1bfebedac574ef524efe9c955073214', organSourceEvidence: 'recorded-build-info', aumlok: 'unbound',
      passkeyVerified: false, enrollmentAvailable: false })
    expect(nodeWords(node)).toBe('organ source: build image recorded at ca9fcd15 (not proof the running organs came from it) · '
      + 'AUMLOK: UNBOUND · first binding needs a trusted owner approval this host does not have yet')
    expect(parseNodeFacts({ organSourceCommit: null, organSourceEvidence: 'invalid', aumlok: host().projectAumlokStatus(undefined) }))
      .toEqual({ organSourceCommit: null, organSourceEvidence: 'invalid', aumlok: null, passkeyVerified: null, enrollmentAvailable: null })
    const facts = parseHostFacts({ ...LIVE, organSourceCommit: 'ca9fcd15a1bfebedac574ef524efe9c955073214', organSourceEvidence: 'recorded-build-info', aumlok })
    if (facts === null) throw new Error('fixture')
    // Sovereignty (Round 25): the organ source sits in the chain card's details; AUMLOK is the Keys and trust card's, not repeated.
    const unknown: FactsAgreement = { kind: 'unknown', reason: 'not compared' }
    const details = chainCardOf({ kind: 'ok', facts }, unknown, null).details
    expect(details).toContainEqual(['organ source', 'build image recorded at ca9fcd15 (not proof the running organs came from it)'])
    expect(details.map(([name]) => name)).not.toContain('AUMLOK')
    expect(signerWords('rotated-pinned')).toBe('signer rotated-pinned')
    // The host's own projection of an incomplete read: BUILD_INFO was never reached, so it is "not read", not "none".
    const incomplete = parseHostFacts(host().projectVerifiedFacts('local', null, { aumlokStatus: await host().createAumlokStore(memoryStorage(), OWNED).status() }))
    if (incomplete === null) throw new Error('the host’s incomplete projection does not parse')
    expect(incomplete.complete).toBe(false)
    expect(nodeWords(incomplete.node, incomplete.complete)).toBe('organ source: not read (the host’s evidence is incomplete) · '
      + 'AUMLOK: UNBOUND · first binding needs a trusted owner approval this host does not have yet')
    expect(chainCardOf({ kind: 'incomplete', facts: incomplete }, unknown, null).details.map(([name]) => name)).not.toContain('organ source')
  })
})

describe('Aura reads HANDOFF and Pearl as Auma writes them, never garbage (aura.ts)', () => {
  const BALL_ID = '8c1f5e34f0136fc915dac89da2918f783ad21bc84f6ec6772d7abf08e4101f90'
  it('HANDOFF: a bold epoch with or without a bold label, a ballId prefix of 8-64 hex, notes after the cell, labels in the first cell only', () => {
    const read = (text: string) => handoffOf({ handoffText: text }, 9, BALL_ID)
    expect(read(`| epoch | **9** |\n| ballId | \`${BALL_ID}\` |`)).toBe(false)
    expect(read('| **epoch** | **9** (26 entries) |\n| ballId | `8c1f5e34f013…` (head) |')).toBe(false)
    expect(read('| epoch | **9** |\n| ballId | `8C1F5E34` |')).toBe(false)
    expect(read('| epoch | **9** |\n| ballId | `ffffffff` |')).toBe(true)
    expect(read('| epoch | **8** |\n| ballId | `8c1f5e34` |')).toBe(true)
    expect(read(`| parentBallId | \`${'a'.repeat(64)}\` |\n| epoch | **9** |\n| ballId | \`${BALL_ID}\` |`)).toBe(false)
    expect(read('| previous ballId | `ffffffff` |\n| headEpoch | **3** |\n| epoch | **9** |\n| ballId | `8c1f5e34` |')).toBe(false)
    expect(read('| epoch | **9** |\n| ballId | `8c1f5e3` |')).toBeNull()
    for (const garbage of ['{broken', 'missing', '| epoch | 9 |\n| ballId | 8c1f5e34f013 |']) expect(read(garbage)).toBeNull()
  })
  it('Pearl: a result recorded before cases were staged binds; the executable digest matches the runtime’s; other suites never bind', () => {
    const suite = { schema: 'aukora.retention-suite.v1', note: 'n', cases: [{ id: 'a', expected: true }, { id: 'b', expected: true }],
      pendingCases: [{ id: 'c', expected: true }] }
    const digests = [...suiteDigests(suite)]
    expect(digests).toHaveLength(3)
    const { pendingCases: _staged, ...beforeStaging } = suite
    expect(digests).toContain([...suiteDigests(beforeStaging)][0])
    // The runtime's executable digest (scion-growth.ts retentionSuiteDigest): all six keys, a missing one as null, keys
    // sorted, no whitespace, sha256. Mirrored here because the runtime package is outside this project's type check.
    const sorted = (value: unknown): string => (Array.isArray(value) ? `[${value.map(sorted).join(',')}]`
      : value !== null && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sorted((value as Record<string, unknown>)[key])}`).join(',')}}`
        : JSON.stringify(value))
    const executable = Object.fromEntries(['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures']
      .map(key => [key, (suite as Record<string, unknown>)[key] ?? null]))
    expect(digests).toContain(createHash('sha256').update(sorted(executable)).digest('hex'))
    expect(suiteDigests({ cases: [{ id: 'a' }] }).has(digests[0] ?? '')).toBe(false)
    expect(projectPearl(suite, [], [], { ballId: BALL_ID, epoch: 9 }).gaps).toContain('retention-results')
  })
})

describe('AUMLOK phrase space: the entropy gate and a uniform draw', () => {
  const bandSizes = (anchor: string): number[] => (['root', 'root', 'unite', 'unite', 'rise', 'rise'] as const)
    .map((band, slot) => AUMLOK_VOCABULARY.bands[band].get(anchor.charAt(slot))?.length ?? 0)
  it('ENTROPY GATE: log2 of every valid phrase (sum over anchors of the product of its six bucket sizes) is at least 43 bits', () => {
    // Counted here from the lists themselves, independently of the module's own count.
    const total = AUMLOK_VOCABULARY.anchors.reduce((sum, anchor) => sum + bandSizes(anchor).reduce((product, size) => product * size, 1), 0)
    expect(total).toBe(11_253_636_424_086)
    expect(AUMLOK_PHRASE_SPACE.total).toBe(total)
    expect(Math.log2(total)).toBeGreaterThanOrEqual(43)
    expect(AUMLOK_PHRASE_SPACE.bits).toBeCloseTo(43.355, 3)
    // An anchor-first draw (anchor 1 in 92, then a phrase under it) makes the weakest anchor's phrases likeliest: its
    // min-entropy is log2(92) + log2(that anchor's 2^34.98 phrases) = 41.50 bits, under the gate. The uniform draw is not.
    expect(AUMLOK_PHRASE_SPACE.weakestAnchorBits).toBeCloseTo(34.980, 3)
    expect(Math.log2(AUMLOK_VOCABULARY.anchors.length) + AUMLOK_PHRASE_SPACE.weakestAnchorBits).toBeCloseTo(41.503, 3)
    expect(Number.isSafeInteger(total)).toBe(true)
  })
  it('every position is one phrase and back: the first, the last, each anchor’s first and last, and random positions', () => {
    const total = AUMLOK_PHRASE_SPACE.total
    const random = seeded(77)
    const positions = [0, 1, total - 2, total - 1, ...Array.from({ length: 300 }, () => uniformBelow(total, random))]
    let start = 0
    for (const anchor of AUMLOK_VOCABULARY.anchors) {
      const weight = bandSizes(anchor).reduce((product, size) => product * size, 1)
      expect(aumlokPhraseAt(start)[0]).toBe(anchor)
      expect(aumlokPhraseAt(start + weight - 1)[0]).toBe(anchor)
      positions.push(start, start + weight - 1)
      start += weight
    }
    for (const position of positions) {
      const words = aumlokPhraseAt(position)
      expect(parseAumlokPhrase(words).ok).toBe(true)
      expect(aumlokPhraseIndex(words)).toBe(position)
    }
    expect(() => aumlokPhraseAt(total)).toThrow(RangeError)
    expect(() => aumlokPhraseAt(-1)).toThrow(RangeError)
    expect(aumlokPhraseIndex(['not', 'a', 'phrase'])).toBeNull()
  })
  it('the 53-bit draw is uniform by rejection: a draw past the last whole multiple of the space is thrown away', () => {
    const values = [0xffff_ffff, 0xffff_ffff, 0, 5]
    const random = (array: Uint32Array<ArrayBuffer>) => { array.set(values.splice(0, array.length)); return array }
    expect(uniformBelow(AUMLOK_PHRASE_SPACE.total, random)).toBe(5)
    expect(values).toHaveLength(0)
    const again = [0, 5]
    expect(generateAumlokPhrase((array) => { array.set(again.splice(0, array.length)); return array })).toEqual(aumlokPhraseAt(5))
    expect(uniformBelow(7, (array) => { array[0] = 3; return array })).toBe(3)
  })
})

describe('AUMLOK root sealed by the seven words (aumlok-root.ts)', () => {
  const words = generateAumlokPhrase(seeded(3)).join(' ')
  it('the node key is the crate’s: Ed25519 from SHA-256(aukora:aumlok-root-key:v1\\0 || root), as Node derives it; its private half cannot be exported', async () => {
    const seed = createHash('sha256').update(Buffer.concat([Buffer.from('aukora:aumlok-root-key:v1\0'), Buffer.from(FIXTURE_ROOT)])).digest()
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
    const spki = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' })
    expect(FIXTURE_NODE.nodePubkeyHex).toBe(spki.subarray(12).toString('hex'))
    expect(FIXTURE_NODE.signingKey.extractable).toBe(false)
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', FIXTURE_NODE.signingKey, new TextEncoder().encode('x')))
    expect(await signedBy(FIXTURE_NODE.nodePubkeyHex, base64url(signature), 'x')).toBe(true)
  })
  it('the ML-DSA-65 seed is SHA-256 under its own domain, and is not the Ed25519 seed', async () => {
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from('aukora:aumlok-root-ml-dsa-65:v1\0'), Buffer.from(FIXTURE_ROOT)])).digest('hex')
    const seed = await aumlokMlDsaSeedOf(FIXTURE_ROOT)
    expect(hexOf(Buffer.from(seed))).toBe(expected)
    expect(expected).not.toBe(createHash('sha256').update(Buffer.concat([Buffer.from('aukora:aumlok-root-key:v1\0'), Buffer.from(FIXTURE_ROOT)])).digest('hex'))
  })
  it('the seal is standard AES-256-GCM under PBKDF2-SHA256 of the words: Node opens it, and the host’s sizes hold (48, 32, 12 bytes)', async () => {
    const sealed = await sealAumlokRoot(FIXTURE_ROOT.slice(), words, FIXTURE_NODE.nodePubkeyHex, { iterations: 1000 })
    expect([sealed.sealedRootKeyB64.length, sealed.kdfSaltB64.length, sealed.ivB64.length, sealed.kdfIterations])
      .toEqual([64, 43, 16, 1000])
    const key = pbkdf2Sync(Buffer.from(`aukora.aumlok.seal.v1\0${words}`), fromB64url(sealed.kdfSaltB64), 1000, 32, 'sha256')
    const sealedBytes = Buffer.from(fromB64url(sealed.sealedRootKeyB64))
    const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(sealed.ivB64))
    decipher.setAAD(Buffer.from(`aukora.aumlok.sealed-root.v1\0${FIXTURE_NODE.nodePubkeyHex}`))
    decipher.setAuthTag(sealedBytes.subarray(32))
    expect([...Buffer.concat([decipher.update(sealedBytes.subarray(0, 32)), decipher.final()])]).toEqual([...FIXTURE_ROOT])
    // Two seals of one root never share a salt or IV.
    const again = await sealAumlokRoot(FIXTURE_ROOT.slice(), words, FIXTURE_NODE.nodePubkeyHex, { iterations: 1000 })
    expect([again.kdfSaltB64 === sealed.kdfSaltB64, again.ivB64 === sealed.ivB64]).toEqual([false, false])
    expect(AUMLOK_SEAL_ITERATIONS).toBe(600_000)
  })
  it('a sealed root is read only in the host’s exact shape and never below the work-factor floor', () => {
    expect(parseSealedRoot(FIXTURE_SEALED, 1000)).toEqual(FIXTURE_SEALED)
    expect(parseSealedRoot(FIXTURE_SEALED)).toBeNull()
    expect(parseSealedRoot({ ...FIXTURE_SEALED, kdfIterations: 600_000 })).not.toBeNull()
    expect(parseSealedRoot({ ...FIXTURE_SEALED, kdfIterations: 2_000_001 })).toBeNull()
    expect(parseSealedRoot({ ...FIXTURE_SEALED, extra: 1 }, 1000)).toBeNull()
    expect(parseSealedRoot({ ...FIXTURE_SEALED, kdfSaltB64: FIXTURE_SEALED.ivB64 }, 1000)).toBeNull()
    expect(parseSealedRoot(null)).toBeNull()
  })
})

describe.skipIf(!HOST_V2)('AUMLOK v2 against the host lane’s own modules (Round 22; skipped on a v1 host)', () => {
  it('the page’s Class 3 binding and canonical JSON are byte-identical to the host’s for the same request', async () => {
    const body = { mandateId: 'm-1', ticketId: null, scope: { organs: ['seed-pearl'], candidateSha256: 'fa5df625'.repeat(8), z: [1, undefined, 'é'], a: undefined },
      ballId: 'ab'.repeat(32), epoch: 163, expiresAt: Date.UTC(2026, 10, 10), identity: 'owner' }
    const request = { audience: ORIGIN, method: 'POST', pathname: '/_host/owner-grant', body } as const
    expect(await class3Action(request)).toEqual(await host().aumlokClass3Binding?.(request))
    expect(pageCanonicalJson(body)).toBe(host().canonicalJson?.(body))
  })
  it('the host’s real store takes an approval challenge only for a bound node, and only for its own origin', async () => {
    const store = host().createAumlokStore(memoryStorage(), { ...OWNED, authorizeEnrollment: approveAll })
    const binding = await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/owner-grant', body: { a: 1 } })
    await expect(store.challenge({ purpose: 'approve', requestId: 'A'.repeat(22), binding }, ORIGIN, OWNER_TRANSPORT))
      .rejects.toMatchObject({ code: 'AUMLOK_NOT_BOUND' })
  })
})

const CLASS3_ACTION = await class3Action({ audience: 'http://localhost:3000', method: 'POST', pathname: '/_host/owner-grant', body: { b: 2, a: [1] } })
describe('Class 3 by the bound passkey, on the exact bytes (class3-approval.ts)', () => {
  const action = CLASS3_ACTION
  const token = base64url(new Uint8Array(32).fill(9))
  const approveHost = (echo: unknown = action) => {
    const requests: Array<{ route: string; body: Record<string, unknown> }> = []
    const call: AumlokHostCall = async (route, _signal, body) => {
      requests.push({ route, body: body ?? {} })
      if (route === '/_host/aumlok/challenge') {
        return { kind: 'live', route, body: { ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-0001', purpose: 'approve', intentHash: 'f'.repeat(64),
          binding: echo, publicKey: { challenge: base64url(new Uint8Array(32).fill(6)), rpId: 'localhost', userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: 'Y3JlZGVudGlhbC1pZC0wMQ' }] } } }
      }
      return { kind: 'live', route, body: { ok: true, phase: 'BOUND', bound: true, approvalToken: token, expiresAt: 1_800_000_000_000, binding: action,
        lastVerifiedAt: 1_799_999_900_000 } }
    }
    return { call, requests }
  }
  it('binds {audience, method, pathname, SHA-256 of the canonical body}: key order does not change it, any other byte does', async () => {
    expect(action).toEqual({ schema: 'aukora.class3.action.v1', audience: 'http://localhost:3000', method: 'POST', pathname: '/_host/owner-grant',
      bodySha256: createHash('sha256').update('{"a":[1],"b":2}').digest('hex') })
    expect(await class3Action({ audience: 'http://localhost:3000', method: 'POST', pathname: '/_host/owner-grant', body: { a: [1], b: 2 } })).toEqual(action)
    expect((await class3Action({ audience: 'http://localhost:3000', method: 'POST', pathname: '/_host/owner-grant', body: { a: [1], b: 3 } })).bodySha256)
      .not.toBe(action.bodySha256)
  })
  it('one passkey assertion over the host’s approve challenge gives a single-use approval, sent in its header with the exact body', async () => {
    const host = approveHost()
    let prompts = 0
    const platform: AumlokPlatform = { ...PLATFORM, passkey: async (step, signal) => {
      prompts += 1
      return PLATFORM.passkey(step, signal)
    } }
    const approval = await approveClass3(action, { call: host.call, platform, signal: new AbortController().signal })
    // The time left is read on the host's own clock (its completion time), never against this page's clock.
    expect(approval).toMatchObject({ ok: true, token, expiresAt: 1_800_000_000_000, action, hostRemainingMs: 100_000 })
    expect(prompts).toBe(1)
    expect(host.requests.map(request => `${request.route} ${Object.keys(request.body).sort().join(',')}`)).toEqual([
      '/_host/aumlok/challenge binding,purpose,requestId', '/_host/aumlok/approve challengeId,credential'])
    expect(host.requests[0]?.body.binding).toEqual(action)
    if (!approval.ok) throw new Error('not approved')
    const sent: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return json({ ok: true, authorization: 'bound-passkey-exact-action', binding: { a: [1], b: 2 } })
    }) as unknown as typeof fetch
    expect(await sendApprovedClass3(approval, { b: 2, a: [1] }, new AbortController().signal, fakeFetch))
      .toEqual({ status: 200, body: { ok: true, authorization: 'bound-passkey-exact-action', binding: { a: [1], b: 2 } } })
    expect(sent[0]?.url).toBe('/_host/owner-grant')
    expect(sent[0]?.init.method).toBe('POST')
    expect((sent[0]?.init.headers as Record<string, string>)[CLASS3_APPROVAL_HEADER]).toBe(token)
    expect(createHash('sha256').update(pageCanonicalJson(JSON.parse(String(sent[0]?.init.body)))).digest('hex')).toBe(action.bodySha256)
  })
  it('an echo that differs in any byte asks the passkey for nothing; no passkey here, or a host refusal, approves nothing', async () => {
    let prompts = 0
    const platform: AumlokPlatform = { ...PLATFORM, passkey: async (step, signal) => {
      prompts += 1
      return PLATFORM.passkey(step, signal)
    } }
    const tampered = approveHost({ ...action, pathname: '/_head/ball' })
    expect(await approveClass3(action, { call: tampered.call, platform, signal: new AbortController().signal }))
      .toEqual({ ok: false, reason: 'class3:binding-mismatch' })
    expect(prompts).toBe(0)
    expect(await approveClass3(action, { call: approveHost().call, platform: { ...PLATFORM, passkeyBlocker: () => 'no WebAuthn' },
      signal: new AbortController().signal })).toEqual({ ok: false, reason: 'class3:no-passkey-here no WebAuthn' })
    const refusing: AumlokHostCall = async route => ({ kind: 'refused', route, status: 409, code: 'AUMLOK_NOT_BOUND', message: 'no' })
    expect(await approveClass3(action, { call: refusing, platform, signal: new AbortController().signal }))
      .toEqual({ ok: false, reason: 'class3:AUMLOK_NOT_BOUND' })
  })
})

describe('Sovereignty: the live mirror snapshot and the owner’s passkey', () => {
  it('the file is aukora-mirror-epoch-<N>.json, N the Pearl’s epoch; anything else is "unknown"', () => {
    expect(snapshotFileName('9')).toBe('aukora-mirror-epoch-9.json')
    expect(snapshotFileName(163)).toBe('aukora-mirror-epoch-163.json')
    expect(snapshotFileName(null)).toBe('aukora-mirror-epoch-unknown.json')
    expect(snapshotFileName('../x')).toBe('aukora-mirror-epoch-unknown.json')
    expect(snapshotWords({ kind: 'handed', name: 'aukora-mirror-epoch-9.json', bytes: 45_088_768 }))
      .toBe('Handed aukora-mirror-epoch-9.json (43.0 MB) to this browser’s download; this page cannot see whether it was saved')
  })
  it('only a JSON answer from the snapshot route is saved: HTML, a refusal or a failure saves nothing', async () => {
    const urls: string[] = []
    const answer = (response: Response) => (async (url: string) => { urls.push(url); return response }) as unknown as typeof fetch
    const ok = await fetchMirrorSnapshot(new AbortController().signal, answer(json({ ok: true, entries: [] })))
    expect(ok.kind === 'ok' ? await ok.blob.text() : null).toBe('{"ok":true,"entries":[]}')
    expect(urls[0]).toBe(SNAPSHOT_ROUTE)
    expect(await fetchMirrorSnapshot(new AbortController().signal, answer(new Response('<html>', { headers: { 'content-type': 'text/html' } }))))
      .toEqual({ kind: 'failed', reason: 'the host did not answer JSON' })
    expect(await fetchMirrorSnapshot(new AbortController().signal, answer(json({ ok: false }, 401))))
      .toEqual({ kind: 'failed', reason: 'the host answered 401' })
  })
  it('the passkey part of Keys and trust says what the host’s AUMLOK status says, and nothing more', () => {
    const bound = ownerAuthorityOf({ kind: 'live', status: BOUND })
    expect([bound.badge, bound.bound, bound.summary]).toEqual(['PASSKEY BOUND', true, 'passkey bound'])
    // Only what the host reports: no pepper row from a host that does not say it, no approvals row with none held.
    expect(bound.rows).toEqual([['passkey', 'bound and verified (user verification required)']])
    expect(bound.details).toEqual([['node key', FIXTURE_NODE.nodePubkeyHex]])
    expect(ownerAuthorityOf({ kind: 'live', status: { ...UNBOUND, enrollmentAvailable: false, blockers: ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'] } }).rows)
      .toEqual([['passkey', 'none bound; first binding is not open on this host (AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE)']])
    expect(ownerAuthorityOf({ kind: 'absent', detail: '404' })).toMatchObject({ badge: 'NOT CONNECTED YET', bound: false })
  })
})

describe('the Work view: a mandate approved by the bound passkey on the exact owner-grant bytes', () => {
  it('with a bound passkey the sheet shows the exact body, Touch ID approves its hash once, and the host’s answer is shown inline', async () => {
    const restore = stubAuthenticator()
    const head = { ballId: 'ab'.repeat(32), parentBallId: null, epoch: 162 }
    const expiresAt = Date.UTC(2030, 0, 1)
    const state = { mandates: [{ id: 'm-pearl', title: 'Promote seed-pearl', strength: 'explicit', confirmed: false,
      scope: { organs: ['seed-pearl'], candidateSha256: 'fa5df62571b34d59aadc4e32ac75d2cbff51b58cc5799c8abfecd2ca164a9292', expiresAt } }],
    tickets: [{ id: 't-pearl', mandateId: 'm-pearl', title: 'Epoch 163', state: 'open' }], assignments: [], attention: [] }
    const posts: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    let approved: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (init?.method === 'POST') posts.push({ url: input, body, headers: { ...(init.headers as Record<string, string>) } })
      if (input === '/_host/aumlok/status') return json({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null })
      // The edge: the Mac takes no owner grant (Round 25), so the passkey path is the edge's.
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      if (input === '/_host/aumlok/challenge') {
        approved = body.binding
        return json({ ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-0001', purpose: 'approve', intentHash: 'f'.repeat(64),
          nodeProofPreimage: AUMLOK_NODE_DOMAIN + 'f'.repeat(64), binding: body.binding, publicKey: { challenge: base64url(new Uint8Array(32).fill(8)),
            rpId: 'localhost', userVerification: 'required', allowCredentials: [{ type: 'public-key', id: base64url(new Uint8Array(16).fill(7)) }] } })
      }
      if (input === '/_host/aumlok/approve') return json({ ok: true, phase: 'BOUND', approvalToken: base64url(new Uint8Array(32).fill(9)), expiresAt, binding: approved })
      if (input === '/_host/owner-grant') return json({ ok: true, authorization: 'bound-passkey-exact-action', binding: body })
      return new Response('nope', { status: 404 })
    }))
    try {
      const props = {
        activeSurface: WORK_SURFACE,
        useSessions: sessionHooks(['s1']).useSessions,
        reader: {
          whole: async (_session: unknown, path: string): Promise<FileRead> => (path === BALL_HEAD_PATH
            ? { ok: true, text: JSON.stringify(head) }
            : path === '/dsh/home/auma/superagent/state.json' ? { ok: true, text: JSON.stringify(state) } : { ok: false, reason: 'not-found' }),
        },
        labels: (key: string) => EN_LABELS.get(key) ?? key,
        t: (key: string) => key,
      }
      const { container } = render(<WorkSurface {...fixture<Parameters<typeof WorkSurface>[0]>(props)} />)
      const open = () => container.querySelector('[data-work-confirm="m-pearl"]')
      await waitFor(() => { expect(open()?.hasAttribute('disabled')).toBe(false) })
      fireEvent.click(open() as Element)
      const sheet = container.querySelector('[data-work-confirm-terms="m-pearl"]')
      expect(sheet?.getAttribute('data-work-confirm-path')).toBe('passkey')
      const exact = { mandateId: 'm-pearl', ticketId: 't-pearl', scope: state.mandates[0]?.scope, ballId: head.ballId, epoch: 162, expiresAt, identity: 'owner' }
      expect(JSON.parse(sheet?.querySelector('pre')?.textContent ?? 'null')).toEqual(exact)
      expect(sheet?.textContent).toContain('Your bound passkey (Touch ID) approves exactly these terms')
      const approve = [...(sheet?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Approve with my passkey')
      if (approve === undefined) throw new Error('no approve button')
      fireEvent.click(approve)
      await waitFor(() => { expect(container.querySelector('[data-work-outcome="ok"]')?.textContent).toContain('bound-passkey-exact-action') })
      expect(posts.map(post => post.url)).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/approve', '/_host/owner-grant'])
      const binding = posts[0]?.body.binding as Record<string, unknown>
      expect(binding).toMatchObject({ schema: 'aukora.class3.action.v1', audience: location.origin, method: 'POST', pathname: '/_host/owner-grant' })
      expect(posts[2]?.body).toEqual(exact)
      expect(createHash('sha256').update(pageCanonicalJson(posts[2]?.body)).digest('hex')).toBe(binding.bodySha256)
      expect(posts[2]?.headers['x-x6-class3-approval']).toBe(base64url(new Uint8Array(32).fill(9)))
      // Her organ is not told: no tool call went through the worker tunnel.
      expect(posts.some(post => post.url.includes('call-tool'))).toBe(false)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { restore() }
  }, 30_000)
})

/** Type seven words into the AUMLOK tiles. */
const typeTiles = (container: HTMLElement, words: readonly string[]) => {
  words.forEach((word, position) => {
    const field = container.querySelector(`[data-aumlok-tile-input="${String(position)}"]`)
    if (field === null) throw new Error(`no tile ${String(position)}`)
    fireEvent.change(field, { target: { value: word } })
  })
}
describe('the last step of a ceremony cannot be taken back', () => {
  const fast = { iterations: 1000, sealIterations: 1000, random: seeded(42), platform: PLATFORM } as const
  /** The stand-in host, with the rotation's last answer lost `times` times; after that it commits, or refuses a replay. */
  const lossy = (times: number, after: 'commit' | 'used' | 'expired' = 'commit', how: 'network' | 'cloud-503' | 'cut' = 'network',
    statuses?: readonly Record<string, unknown>[]) => {
    const inner = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: FIXTURE_NODE.nodePubkeyHex })
    let lost = 0
    let reads = 0
    const finals: Array<Record<string, unknown>> = []
    const call: AumlokHostCall = async (route, signal, body) => {
      // Status reads answer in order (the one before the challenge, then the one after the lost answers); the last repeats.
      if (route === '/_host/aumlok/status' && statuses !== undefined && statuses.length > 0) {
        const answer = statuses[Math.min(reads, statuses.length - 1)] ?? {}
        reads += 1
        return { kind: 'live', route, body: answer }
      }
      if (route !== '/_host/aumlok/refresh') return inner.call(route, signal, body)
      finals.push(body ?? {})
      if (lost < times) {
        lost += 1
        return how === 'network' ? { kind: 'absent', route, detail: 'the host did not answer (network down)' }
          : how === 'cut' ? { kind: 'absent', route, detail: `${route} answered 200 without JSON` }
            : { kind: 'refused', route, status: 503, code: 'CLOUD_REQUEST_FAILED', message: 'the edge lost its Durable Object call' }
      }
      if (after !== 'commit' && finals.length > 1) {
        return { kind: 'refused', route, status: 409, code: after === 'used' ? 'AUMLOK_CHALLENGE_USED' : 'AUMLOK_CHALLENGE_EXPIRED', message: 'no' }
      }
      return inner.call(route, signal, body)
    }
    return { call, finals }
  }
  const rotate = async (call: AumlokHostCall, from: AumlokHostStatus = BOUND) => {
    const ceremony = createBrowserCeremony({ ...fast, call })
    const drawn = await ceremony.draw('refresh', from, CURRENT_WORDS)
    if (!drawn.ok || drawn.words === undefined) throw new Error('no draw')
    return { ceremony, words: drawn.words }
  }
  it('a lost answer is asked again once with the SAME body: committed reads as done, a refused replay as refused', async () => {
    const host = lossy(1)
    const { ceremony, words } = await rotate(host.call)
    expect(await ceremony.submit('refresh', words)).toEqual({ ok: true })
    expect(host.finals).toHaveLength(2)
    expect(host.finals[1]).toBe(host.finals[0])
    const refused = lossy(1, 'used')
    const second = await rotate(refused.call)
    expect(await second.ceremony.submit('refresh', second.words)).toEqual({ ok: false, reason: 'aumlok:AUMLOK_CHALLENGE_USED', drawSpent: true })
  })
  it('a 5xx from the edge or a cut body is not a refusal: it is asked again, and a commit behind it reads as done', async () => {
    for (const how of ['cloud-503', 'cut'] as const) {
      const host = lossy(1, 'commit', how)
      const { ceremony, words } = await rotate(host.call)
      expect([how, await ceremony.submit('refresh', words)]).toEqual([how, { ok: true }])
      expect(host.finals).toHaveLength(2)
    }
    const twice = lossy(2, 'commit', 'cloud-503')
    const third = await rotate(twice.call)
    expect(await third.ceremony.submit('refresh', third.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
  })
  it('still unclear, the status settles a rotation only when the revision is exactly one step on from just before it', async () => {
    const boundBody = (keyCommitmentId: string, rotationSeq: number) => ({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null,
      keyCommitmentId, rotationSeq })
    // The revision is read fresh just before the challenge (4), then after the lost answers (5): settled, and said to be.
    const oneStep = lossy(2, 'commit', 'network', [boundBody('a1'.repeat(16), 4), boundBody('b2'.repeat(16), 5)])
    const first = await rotate(oneStep.call)
    expect(await first.ceremony.submit('refresh', first.words)).toEqual({ ok: true, reason: AUMLOK_SETTLED_BY_STATUS })
    // Two steps on means another rotation also landed: not attributable, so unknown.
    const twoSteps = lossy(2, 'commit', 'network', [boundBody('a1'.repeat(16), 4), boundBody('c3'.repeat(16), 6)])
    const second = await rotate(twoSteps.call)
    expect(await second.ceremony.submit('refresh', second.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    // The screen's old status does not count: a rotation from another device before this one began is not this one.
    const stale = lossy(2, 'commit', 'network', [boundBody('b2'.repeat(16), 5), boundBody('b2'.repeat(16), 5)])
    const third = await rotate(stale.call, { ...BOUND, keyCommitmentId: 'a1'.repeat(16), rotationSeq: 4 })
    expect(await third.ceremony.submit('refresh', third.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    // When the fresh read before the challenge fails, nothing can settle it later, however the revision moves.
    const failedRead = lossy(2, 'commit', 'network', [{ unreadable: true }, boundBody('b2'.repeat(16), 5)])
    const blind = await rotate(failedRead.call, { ...BOUND, keyCommitmentId: 'a1'.repeat(16), rotationSeq: 4 })
    expect(await blind.ceremony.submit('refresh', blind.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    // A host that sends no revision cannot settle it either.
    const silent = lossy(2, 'commit', 'network', [{ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null }])
    const fourth = await rotate(silent.call)
    expect(await fourth.ceremony.submit('refresh', fourth.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    expect(parseAumlokStatus(boundBody('b2'.repeat(16), 5))).toMatchObject({ keyCommitmentId: 'b2'.repeat(16), rotationSeq: 5 })
  })
  it('still unclear, a host that names its last committed rotation settles it as THIS ceremony’s, or not at all', async () => {
    const boundBody = (keyCommitmentId: string, rotationSeq: number, lastRotationChallengeId?: string) => ({
      ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null, keyCommitmentId, rotationSeq,
      ...(lastRotationChallengeId === undefined ? {} : { lastRotationChallengeId }) })
    // The host names this ceremony's own challenge (the id the page sent its last step under): this device's rotation.
    const ours = lossy(2, 'commit', 'network', [boundBody('a1'.repeat(16), 4), boundBody('b2'.repeat(16), 5, 'refresh-assertion-0001')])
    const first = await rotate(ours.call)
    expect(await first.ceremony.submit('refresh', first.words)).toEqual({ ok: true, reason: AUMLOK_SETTLED_AS_THIS_CEREMONY })
    expect(ours.finals[0]?.challengeId).toBe('refresh-assertion-0001')
    // Exactly one step on, but the host names ANOTHER ceremony: the Round 23 rule alone would have settled it; now unknown.
    const other = lossy(2, 'commit', 'network', [boundBody('a1'.repeat(16), 4), boundBody('b2'.repeat(16), 5, 'refresh-assertion-9999')])
    const second = await rotate(other.call)
    expect(await second.ceremony.submit('refresh', second.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    // The id needs no revision read before the challenge, and holds however far the count moved.
    const blind = lossy(2, 'commit', 'network', [{ unreadable: true }, boundBody('c3'.repeat(16), 7, 'refresh-assertion-0001')])
    const third = await rotate(blind.call, { ...BOUND, keyCommitmentId: 'a1'.repeat(16), rotationSeq: 4 })
    expect(await third.ceremony.submit('refresh', third.words)).toEqual({ ok: true, reason: AUMLOK_SETTLED_AS_THIS_CEREMONY })
    // The new status fields, read only in their own shapes.
    expect(parseAumlokStatus({ ...boundBody('b2'.repeat(16), 5, 'refresh-assertion-0001'), pepperSeparated: true }))
      .toMatchObject({ lastRotationChallengeId: 'refresh-assertion-0001', pepperSeparated: true })
    expect(parseAumlokStatus({ ...boundBody('b2'.repeat(16), 5, 'not an id!'), pepperSeparated: 'yes' }))
      .toMatchObject({ lastRotationChallengeId: null, pepperSeparated: null })
  })
  it('the words’ commitment rides the unseal step only to a host that checks it online', async () => {
    const unsealBodies: Array<Record<string, unknown>> = []
    const watching = (): AumlokHostCall => {
      const inner = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: FIXTURE_NODE.nodePubkeyHex })
      return async (route, signal, body) => {
        if (route === '/_host/aumlok/unseal') unsealBodies.push(body ?? {})
        return inner.call(route, signal, body)
      }
    }
    // A Round 24 host (it says pepperSeparated) gets the commitment of the words in use, salted with the bound node key.
    const online = await rotate(watching(), { ...BOUND, pepperSeparated: true, checksPhraseOnline: true })
    expect(online.words).toHaveLength(7)
    const canonical = parseAumlokPhrase(CURRENT_WORDS)
    if (!canonical.ok) throw new Error('fixture words do not parse')
    expect(unsealBodies[0]?.commitmentSha256).toBe(await aumlokCommitment(canonical.canonical, FIXTURE_NODE.nodePubkeyHex, 1000))
    // An older host refuses unknown fields: it gets the step as before.
    await rotate(watching(), BOUND)
    expect(Object.keys(unsealBodies[1] ?? {}).sort()).toEqual(['challengeId', 'credential'])
    expect(parseAumlokStatus({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), pepperSeparated: false })?.checksPhraseOnline).toBe(true)
    expect(parseAumlokStatus(hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex))?.checksPhraseOnline).toBe(false)
  })
  it('the store’s own 4xx refusal of the last step is definite: it is not asked again', async () => {
    const inner = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: 'ef'.repeat(32) })
    let finals = 0
    const call: AumlokHostCall = async (route, signal, body) => {
      if (route === '/_host/aumlok/refresh') finals += 1
      return inner.call(route, signal, body)
    }
    // The stand-in checks the node signature against another key, so it refuses AUMLOK_NODE_PROOF_INVALID (403).
    const { ceremony, words } = await rotate(call)
    expect(await ceremony.submit('refresh', words)).toEqual({ ok: false, reason: 'aumlok:AUMLOK_NODE_PROOF_INVALID', drawSpent: true })
    expect(finals).toBe(1)
  })
  it('lost twice, or a replay the host can no longer match, is UNKNOWN: never "failed" and never "unchanged"', async () => {
    const twice = lossy(2)
    const first = await rotate(twice.call)
    expect(await first.ceremony.submit('refresh', first.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
    const expired = lossy(1, 'expired')
    const second = await rotate(expired.call)
    expect(await second.ceremony.submit('refresh', second.words)).toEqual({ ok: false, reason: AUMLOK_OUTCOME_UNKNOWN, drawSpent: true })
  })
  it('closing the screen during the last step does not abort it; its result is kept for the next opening, once', async () => {
    const inner = ceremonyHost({ sealedRoot: FIXTURE_SEALED, node: FIXTURE_NODE.nodePubkeyHex })
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finalSignal: AbortSignal | null = null
    const call: AumlokHostCall = async (route, signal, body) => {
      if (route !== '/_host/aumlok/refresh') return inner.call(route, signal, body)
      finalSignal = signal
      await gate
      return inner.call(route, signal, body)
    }
    const { ceremony, words } = await rotate(call)
    let told = 0
    const off = ceremony.onSettled(() => { told += 1 })
    const submitting = ceremony.submit('refresh', words)
    await vi.waitFor(() => { expect(finalSignal).not.toBeNull() })
    ceremony.reset()
    expect((finalSignal as AbortSignal | null)?.aborted).toBe(false)
    release()
    expect(await submitting).toEqual({ ok: false, reason: 'aumlok:closed', drawSpent: true })
    expect(told).toBe(1)
    off()
    expect(ceremony.takeSettled()).toEqual({ intent: 'refresh', result: { ok: true } })
    expect(ceremony.takeSettled()).toBeNull()
  })
  it('the screen says UNKNOWN in words when the last answer is lost, and reads the status again', async () => {
    const restore = stubAuthenticator()
    const root = Uint8Array.from({ length: 32 }, (_, index) => 90 + index)
    const node = (await aumlokNodeOf(root)).nodePubkeyHex
    const current = generateAumlokPhrase(seeded(41))
    const sealedNow = await sealAumlokRoot(root.slice(), current.join(' '), node)
    let statusReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (input === '/_host/aumlok/status') { statusReads += 1; return json({ ...hostStatusBody('BOUND', true, node), commitmentSha256: null }) }
      if (input === '/__x6/status') return json({ ok: true, runtime: 'local' })
      if (input === '/_host/aumlok/challenge') return json(screenAssertion(String(body.purpose), body.purpose === 'unseal' ? 'e'.repeat(64) : 'c'.repeat(64)))
      if (input === '/_host/aumlok/unseal') return json({ ...hostStatusBody('BOUND', true, node), sealedRoot: sealedNow })
      if (input === '/_host/aumlok/refresh') throw new TypeError('network down')
      return new Response('nope', { status: 404 })
    }))
    try {
      const { container } = render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(AUMLOK_PROPS)} />)
      const button = () => container.querySelector('[data-aumlok-bind-button]')
      await waitFor(() => { expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('bound') })
      await waitFor(() => { expect(button()).not.toBeNull() })
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      typeTiles(container, current)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-face="word"]')).not.toBeNull() }, { timeout: 10_000 })
      const anchor = [...container.querySelectorAll('[data-aumlok-anchor-box-kind="letter"]')].map(box => box.textContent).join('')
      const words = [anchor, ...[...container.querySelectorAll('span[data-aumlok-tile-face="word"]')].map(span => span.textContent ?? '')]
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      typeTiles(container, words)
      fireEvent.click(button() as Element)
      const box = container.querySelector('[data-aumlok-confirm-checkbox]')
      if (box === null) throw new Error('no confirmation box')
      fireEvent.click(box)
      const before = statusReads
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-notice="unknown"]')?.textContent).toContain('Keep both phrases') }, { timeout: 15_000 })
      expect(container.querySelector('[data-aumlok-binding-refused]')).toBeNull()
      await waitFor(() => { expect(statusReads).toBeGreaterThan(before) })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { restore() }
  }, 60_000)
  it('the screen says the new phrase is in force when the host names this rotation as its last, though the answer was lost', async () => {
    const restore = stubAuthenticator()
    const root = Uint8Array.from({ length: 32 }, (_, index) => 90 + index)
    const node = (await aumlokNodeOf(root)).nodePubkeyHex
    const current = generateAumlokPhrase(seeded(41))
    const sealedNow = await sealAumlokRoot(root.slice(), current.join(' '), node)
    let refreshSent = false
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (input === '/_host/aumlok/status') {
        return json({ ...hostStatusBody('BOUND', true, node), commitmentSha256: null, ...(refreshSent ? { lastRotationChallengeId: 'refresh-0001' } : {}) })
      }
      if (input === '/__x6/status') return json({ ok: true, runtime: 'local' })
      if (input === '/_host/aumlok/challenge') return json(screenAssertion(String(body.purpose), body.purpose === 'unseal' ? 'e'.repeat(64) : 'c'.repeat(64)))
      if (input === '/_host/aumlok/unseal') return json({ ...hostStatusBody('BOUND', true, node), sealedRoot: sealedNow })
      if (input === '/_host/aumlok/refresh') { refreshSent = true; throw new TypeError('network down') }
      return new Response('nope', { status: 404 })
    }))
    try {
      const { container } = render(<AumlokSurface {...fixture<Parameters<typeof AumlokSurface>[0]>(AUMLOK_PROPS)} />)
      const button = () => container.querySelector('[data-aumlok-bind-button]')
      await waitFor(() => { expect(container.querySelector('[data-aumlok-badge]')?.getAttribute('data-aumlok-badge')).toBe('bound') })
      await waitFor(() => { expect(button()).not.toBeNull() })
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      typeTiles(container, current)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-face="word"]')).not.toBeNull() }, { timeout: 10_000 })
      const anchor = [...container.querySelectorAll('[data-aumlok-anchor-box-kind="letter"]')].map(box => box.textContent).join('')
      const words = [anchor, ...[...container.querySelectorAll('span[data-aumlok-tile-face="word"]')].map(span => span.textContent ?? '')]
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-tile-input="0"]')).not.toBeNull() })
      typeTiles(container, words)
      fireEvent.click(button() as Element)
      const box = container.querySelector('[data-aumlok-confirm-checkbox]')
      if (box === null) throw new Error('no confirmation box')
      fireEvent.click(box)
      fireEvent.click(button() as Element)
      await waitFor(() => { expect(container.querySelector('[data-aumlok-notice="settled-here"]')?.textContent).toContain('made on this device') },
        { timeout: 15_000 })
      expect(container.querySelector('[data-aumlok-notice="settled-here"]')?.textContent).not.toContain('keep both phrases')
      expect(container.querySelector('[data-aumlok-binding-refused]')).toBeNull()
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { restore() }
  }, 60_000)
})

describe('no ceremony or approval is offered where it can only fail', () => {
  it('a locked host (a blocker on a bound node) offers no rotation and reads LOCKED, not PASSKEY BOUND', async () => {
    const locked = { ...BOUND, blockers: ['AUMLOK_GUARDIAN_QUORUM_REQUIRED'] }
    expect(await aumlokCeremonyAvailability(locked, PLATFORM)).toEqual({ ok: false,
      reason: 'this host refuses ceremonies now (AUMLOK_GUARDIAN_QUORUM_REQUIRED)' })
    expect(ownerAuthorityOf({ kind: 'live', status: locked })).toMatchObject({ badge: 'LOCKED', bound: false })
    expect(await aumlokCeremonyAvailability(BOUND, { ...PLATFORM, nodeKeys: async () => false }))
      .toEqual({ ok: false, reason: 'this browser cannot make an Ed25519 node key' })
  })
  it('a browser that opens the root but cannot make the Ed25519 key wipes it and says so, without blaming the passkey', async () => {
    const original = crypto.subtle.importKey.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((format: string, ...rest: unknown[]) => {
      if (format === 'pkcs8') return Promise.reject(new DOMException('no Ed25519', 'NotSupportedError'))
      return (original as (...args: unknown[]) => Promise<CryptoKey>)(format, ...rest)
    }) as typeof crypto.subtle.importKey)
    try {
      expect(await openAumlokRoot(FIXTURE_SEALED, CURRENT_WORDS.join(' '), FIXTURE_NODE.nodePubkeyHex)).toEqual({ ok: false, code: 'aumlok:no-node-key-here' })
    } finally { spy.mockRestore() }
  })
})

describe('owner-grant terms the host would refuse are refused before any passkey', () => {
  const NOW = Date.UTC(2026, 10, 9, 12)
  const later = NOW + 3_600_000
  const base: OwnerGrantTerms = { mandateId: 'm-1', ticketId: 't-1', scope: { organs: ['auma-notes'], expiresAt: later }, ballId: 'ab'.repeat(32),
    epoch: 162, expiresAt: later, identity: 'owner' }
  const pearl = { organs: ['seed-pearl'], candidateSha256: 'fa5df62571b34d59aadc4e32ac75d2cbff51b58cc5799c8abfecd2ca164a9292', expiresAt: later }
  const CASES: ReadonlyArray<readonly [string, OwnerGrantTerms, string | null]> = [
    ['an ordinary organ', base, null],
    ['the staged seed-pearl, with its candidate, ticket and expiry', { ...base, scope: pearl }, null],
    ['an exact organ file path', { ...base, scope: { paths: ['/dsh/home/auma/seed/organs/auma-notes.js'], expiresAt: later } }, null],
    ['an expired mandate', { ...base, expiresAt: NOW - 1, scope: { organs: ['auma-notes'], expiresAt: NOW - 1 } }, 'OWNER_GRANT_INVALID_EXPIRY'],
    ['a glob path (her real "docs/**")', { ...base, scope: { paths: ['docs/**'], expiresAt: later } }, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED'],
    ['a plain path outside the organ roots', { ...base, scope: { paths: ['deploy/cloudflare/x.mjs'], expiresAt: later } }, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED'],
    ['a governance organ with no candidate digest', { ...base, scope: { organs: ['seed-pearl'], expiresAt: later } }, 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED'],
    ['a governance organ with no ticket', { ...base, ticketId: null, scope: pearl }, 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED'],
    ['two governance organs', { ...base, scope: { ...pearl, organs: ['seed-pearl', 'seed-aura'] } }, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED'],
    ['tools only', { ...base, scope: { tools: ['x'], expiresAt: later } }, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED'],
    ['no scope', { ...base, scope: null }, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED'],
    ['a scope expiry that differs', { ...base, scope: { organs: ['auma-notes'], expiresAt: later + 1 } }, 'OWNER_GRANT_INVALID_EXPIRY'],
    ['a bad candidate digest', { ...base, scope: { ...pearl, candidateSha256: 'xyz' } }, 'OWNER_GRANT_INVALID_CANDIDATE'],
    ['a tab identity', { ...base, identity: 'spatial-tab' }, 'OWNER_GRANT_IDENTITY_REJECTED'],
    ['a short ball id', { ...base, ballId: 'ab' }, 'OWNER_GRANT_INVALID_BALL'],
    ['a negative epoch', { ...base, epoch: -1 }, 'OWNER_GRANT_INVALID_EPOCH'],
    ['a scope nested 20 deep', { ...base, scope: { organs: ['auma-notes'], expiresAt: later,
      deep: Array.from({ length: 20 }).reduce<Record<string, unknown>>(inner => ({ inner }), {}) } }, 'OWNER_GRANT_TOO_COMPLEX'],
    ['1100 tools', { ...base, scope: { organs: ['auma-notes'], expiresAt: later, tools: Array.from({ length: 1100 }, (_, i) => `t${String(i)}`) } },
      'OWNER_GRANT_TOO_COMPLEX'],
    ['100 tools of 190 characters', { ...base, scope: { organs: ['auma-notes'], expiresAt: later,
      tools: Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(187)}`) } }, 'REQUEST_BODY_TOO_LARGE'],
  ]
  /** One named organ (`scope.organ`), as the host reads it since an earlier commit (Round 24 review). */
  const CASES_ORGAN: ReadonlyArray<readonly [string, OwnerGrantTerms, string | null]> = [
    ['one named ordinary organ', { ...base, scope: { organ: 'auma-notes', expiresAt: later } }, null],
    ['a named organ that is not the one listed', { ...base, scope: { organ: 'auma-notes', organs: ['auma-docs'], expiresAt: later } },
      'OWNER_GRANT_INVALID_SCOPE'],
    ['a named organ that is not an organ id', { ...base, scope: { organ: 'Seed Pearl', expiresAt: later } }, 'OWNER_GRANT_INVALID_SCOPE'],
    ['a named governance organ with no candidate', { ...base, scope: { organ: 'seed-pearl', expiresAt: later } },
      'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED'],
    ['a named governance organ with its candidate', { ...base, scope: { organ: 'seed-pearl', candidateSha256: pearl.candidateSha256, expiresAt: later } },
      null],
  ]
  /** Round 24 (F1): four more organs are governance, by name, for a grant as for a publish. */
  const CASES_F1: ReadonlyArray<readonly [string, OwnerGrantTerms, string | null]> = [
    ['seed-recall with no candidate digest', { ...base, scope: { organs: ['seed-recall'], expiresAt: later } }, 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED'],
    ['auma-body-map by its file path, no candidate', { ...base, scope: { paths: ['/dsh/home/auma/seed/organs/auma-body-map.js'], expiresAt: later } },
      'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED'],
    ['seed-predict with its candidate, ticket and expiry', { ...base, scope: { ...pearl, organs: ['seed-predict'] } }, null],
  ]
  const HOST_F1 = HOST?.classifyHeadTransition != null
    && (HOST.classifyHeadTransition({ entries: {} }, { entries: { 'seed-predict': { specifier: 'inline:x' } } }) as { class?: number }).class === 3
  it('names the code the host would answer for each case', () => {
    for (const [name, terms, code] of [...CASES, ...CASES_ORGAN, ...CASES_F1]) {
      expect([name, ownerGrantRefusal(terms, NOW)]).toEqual([name, code])
    }
  })
  it.skipIf(HOST?.normalizeOwnerGrantBinding == null)('agrees with the host’s own normalizeOwnerGrantBinding on every case', () => {
    const normalize = host().normalizeOwnerGrantBinding
    if (normalize == null) throw new Error('no host check')
    // The Round 24 cases are compared only with a host that has the Round 24 set (F1).
    for (const [name, terms] of [...CASES, ...CASES_ORGAN, ...(HOST_F1 ? CASES_F1 : [])]) {
      let code: string | null = null
      try { normalize(structuredClone(terms), { now: NOW }) } catch (error) { code = String((error as { code?: unknown }).code) }
      expect([name, ownerGrantRefusal(terms, NOW)]).toEqual([name, code])
    }
  })
})

describe('the Work view offers no passkey approval the host would refuse', () => {
  const mountWith = async (expiresAt: number) => {
    const head = { ballId: 'ab'.repeat(32), parentBallId: null, epoch: 162 }
    const state = { mandates: [{ id: 'm-soon', title: 'Soon', strength: 'explicit', confirmed: false, scope: { organs: ['auma-notes'], expiresAt } }],
      tickets: [{ id: 't-soon', mandateId: 'm-soon', title: 'x', state: 'open' }], assignments: [], attention: [] }
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(input)
      if (input === '/_host/aumlok/status') return json({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null })
      // The edge: the Mac takes no owner grant (Round 25).
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      return new Response('nope', { status: 404 })
    }))
    const props = {
      activeSurface: WORK_SURFACE,
      useSessions: sessionHooks(['s1']).useSessions,
      reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === BALL_HEAD_PATH
        ? { ok: true, text: JSON.stringify(head) }
        : path === '/dsh/home/auma/superagent/state.json' ? { ok: true, text: JSON.stringify(state) } : { ok: false, reason: 'not-found' }) },
      labels: (key: string) => EN_LABELS.get(key) ?? key,
      t: (key: string) => key,
    }
    const { container } = render(<WorkSurface {...fixture<Parameters<typeof WorkSurface>[0]>(props)} />)
    await waitFor(() => { expect(container.querySelector('[data-work-confirm="m-soon"]')?.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(container.querySelector('[data-work-confirm="m-soon"]') as Element)
    const sheet = container.querySelector('[data-work-confirm-terms="m-soon"]')
    return { sheet, posts }
  }
  it('an expired mandate, or one expiring before an approval could land, says why and asks for no Touch ID', async () => {
    const restore = stubAuthenticator()
    try {
      for (const [expiresAt, code] of [[Date.now() - 60_000, 'OWNER_GRANT_INVALID_EXPIRY'], [Date.now() + 60_000, 'MANDATE_EXPIRES_DURING_APPROVAL']] as const) {
        const { sheet, posts } = await mountWith(expiresAt)
        expect(sheet?.getAttribute('data-work-confirm-path')).toBe('passkey')
        expect(sheet?.querySelector('[data-work-confirm-refused]')?.getAttribute('data-work-confirm-refused')).toBe(code)
        const approve = [...(sheet?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Approve with my passkey')
        expect(approve?.hasAttribute('disabled')).toBe(true)
        expect(posts).toHaveLength(0)
        cleanup()
      }
    } finally { restore() }
  })
})

/** A staged epoch 163: seed-pearl's bytes move to ball:fa5df625…; everything else is the published head. */
const STAGED_PEARL = 'fa5df62571b34d59aadc4e32ac75d2cbff51b58cc5799c8abfecd2ca164a9292'
const HEAD_62 = '7c01cb98514e4ae7a6aaa0dc29653282d94bc4717b85a18968b47aa4310120a8'
/** A manifest entry in HEAD's own shape (`validateManifest`). */
const entryOf = (id: string, specifier: string, extra: Record<string, unknown> = {}) =>
  ({ id, specifier, disabled: false, config: {}, previousSpecifiers: [] as string[], ...extra })
const PUBLISHED_ENTRIES = {
  'seed-pearl': entryOf('seed-pearl', `ball:${'1a'.repeat(32)}`),
  'auma-notes': entryOf('auma-notes', `ball:${'2b'.repeat(32)}`),
  'seed-aura': entryOf('seed-aura', `ball:${'3c'.repeat(32)}`),
}
/** HEAD's manifest id: SHA-256 of its contents (`manifestId`, head-do.mjs). */
interface BallContents {
  readonly parentBallId: string | null
  readonly epoch: number
  readonly entries: Record<string, unknown>
  readonly modules: Record<string, unknown>
}
const manifestIdOf = (ball: BallContents) => createHash('sha256').update(JSON.stringify({ version: 'x6.1-ball/v1',
  parentBallId: ball.parentBallId, epoch: ball.epoch, entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]) })).digest('hex')
/**
 * A staged body HEAD could take once the page puts a fresh writer lease in it: on the published head, its id the hash of
 * its contents, and carrying the lease it was staged with (generation 7), which has lapsed by now.
 */
interface StagedExtra {
  readonly lease?: { ownerPeerId: string; generation: number }
  readonly codeBySha?: Record<string, string>
}
const stagedFile = (entries: Record<string, unknown>, extra: StagedExtra = {}) => {
  const contents = { version: 'x6.1-ball/v1', parentBallId: HEAD_62, epoch: 163, authorPeerId: 'peer-1', entries,
    modules: Object.fromEntries(Object.values(entries).map(entry => String((entry as { specifier: string }).specifier).slice(5))
      .filter(sha => /^[0-9a-f]{64}$/u.test(sha)).map(sha => [sha, { sha256: sha, specifier: `ball:${sha}` }])) }
  return { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 9, 9), body: {
    ball: { ...contents, ballId: manifestIdOf(contents) }, codeBySha: extra.codeBySha ?? {}, expectedParentBallId: HEAD_62,
    expectedEpoch: 162,
    writerLease: extra.lease ?? { ownerPeerId: 'peer-1', generation: 7 } } }
}
const STAGED_63 = stagedFile({ ...PUBLISHED_ENTRIES, 'seed-pearl': entryOf('seed-pearl', `ball:${STAGED_PEARL}`) })
const LIVE_LEASE = (now: number) => ({ ownerPeerId: 'peer-1', generation: 7, expiresAt: now + 29_000 })
const CONTEXT = (now: number, extra: Partial<PromotionContext> = {}): PromotionContext => ({
  published: { entries: PUBLISHED_ENTRIES, ballId: HEAD_62, epoch: 162 }, lease: LIVE_LEASE(now), canQualify: true, runtime: 'cloudflare',
  audience: 'http://localhost:3000', now, ...extra })

describe('a staged governance Pearl, said in words and approved only when HEAD could take it (Epoch 163)', () => {
  const audience = 'http://localhost:3000'
  it('HEAD’s own rule: only a governance organ’s execution change is Class 3, and the binding names its ball bytes', async () => {
    const staged = parseStagedPromotion(JSON.stringify(STAGED_63))
    if (staged === null) throw new Error('staged file does not parse')
    expect(classifyHeadTransition(PUBLISHED_ENTRIES, staged.ball.entries)).toEqual({ class: 3, entryIds: ['seed-pearl'] })
    expect(classifyHeadTransition(PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': { specifier: `ball:${'9f'.repeat(32)}` } }))
      .toEqual({ class: 1, entryIds: [] })
    // Round 24 (F1): eight organs by name, and any entry that declares governance, on either side of the change.
    expect(classifyHeadTransition(PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'seed-predict': { specifier: `ball:${'9f'.repeat(32)}` } }))
      .toEqual({ class: 3, entryIds: ['seed-predict'] })
    const declared = { ...PUBLISHED_ENTRIES['auma-notes'], config: { governance: true } }
    expect(classifyHeadTransition(PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': declared })).toEqual({ class: 3, entryIds: ['auma-notes'] })
    expect(classifyHeadTransition({ ...PUBLISHED_ENTRIES, 'auma-notes': declared }, PUBLISHED_ENTRIES)).toEqual({ class: 3, entryIds: ['auma-notes'] })
    expect(classifyHeadTransition(PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': { ...declared, config: { governance: false } } }))
      .toEqual({ class: 1, entryIds: [] })
    expect(describeGovernanceChange(PUBLISHED_ENTRIES['auma-notes'], { ...PUBLISHED_ENTRIES['auma-notes'], governance: true }))
      .toEqual(['changes its governance declaration: null → true'])
    expect(await headPromotionBinding({ audience, ball: staged.ball, entryId: 'seed-pearl' })).toEqual({ schema: 'aukora.class3.head-promotion.v1',
      audience, action: 'head.promote', ballId: STAGED_63.body.ball.ballId, epoch: 163, organId: 'seed-pearl', candidateSha256: STAGED_PEARL })
    expect(await manifestIdMatches(STAGED_63.body.ball)).toBe(true)
    expect(await manifestIdMatches({ ...STAGED_63.body.ball, epoch: 164 })).toBe(false)
    // HEAD's whole manifest check: entry shape and ids, module records, the id.
    expect(await manifestProblem(STAGED_63.body.ball)).toBeNull()
    const withoutId = { ...STAGED_63.body.ball, entries: { ...STAGED_63.body.ball.entries, 'auma-notes': { specifier: `ball:${'2b'.repeat(32)}`, disabled: false, config: {} } } }
    expect(await manifestProblem(withoutId)).toBe('INVALID_ENTRY')
    expect(await manifestProblem({ ...STAGED_63.body.ball, modules: {} })).toBe('MODULE_MISSING')
    expect(await manifestProblem({ ...STAGED_63.body.ball, version: 'x6.1-ball/v2' })).toBe('INVALID_MANIFEST')
    const removal = await headPromotionBinding({ audience, ball: { ...staged.ball, entries: Object.create(null) as Record<string, never> }, entryId: 'seed-aura' })
    expect(removal.candidateSha256).toBe(createHash('sha256').update('null').digest('hex'))
    expect(STAGED_PROMOTION_PATH).toBe('/dsh/home/auma/staged/head-promotion.json')
  })
  it('the change is said in words: code replaced, disabled, re-enabled, config changed, removed, added', () => {
    const before = { specifier: `ball:${'1a'.repeat(32)}`, disabled: false, config: {} }
    expect(describeGovernanceChange(before, { ...before, specifier: `ball:${STAGED_PEARL}` })).toEqual(['replaces its code: ball:1a1a1a1a… → ball:fa5df625…'])
    expect(describeGovernanceChange(before, { ...before, disabled: true })).toEqual(['DISABLES it'])
    expect(describeGovernanceChange({ ...before, disabled: true }, before)).toEqual(['re-enables it'])
    expect(describeGovernanceChange(before, { ...before, config: { strict: false } })).toEqual(['changes its config: strict added: false'])
    expect(describeGovernanceChange(before, undefined)).toEqual(['removes the organ (it runs ball:1a1a1a1a… now)'])
    expect(describeGovernanceChange(undefined, before)).toEqual(['adds the organ (ball:1a1a1a1a…)'])
  })
  it('a malformed file is not read: a reserved entry id, a bad epoch, or a date that is not a date', () => {
    const proto = JSON.parse(JSON.stringify(STAGED_63).replace('"auma-notes"', '"__proto__"')) as unknown
    expect(parseStagedPromotion(JSON.stringify(proto))).toBeNull()
    expect(parseStagedPromotion('{"schema":"other"}')).toBeNull()
    const negative = { ...STAGED_63, body: { ...STAGED_63.body, ball: { ...STAGED_63.body.ball, epoch: -1 } } }
    expect(parseStagedPromotion(JSON.stringify(negative))).toBeNull()
    expect(parseStagedPromotion(JSON.stringify({ ...STAGED_63, stagedAt: 9007199254740991 }))?.stagedAt).toBeNull()
  })
  it.skipIf(HOST?.headPromotionBinding == null || HOST.classifyHeadTransition == null)(
    'is byte-identical to the host’s classifyHeadTransition and headPromotionBinding', async () => {
      const staged = parseStagedPromotion(JSON.stringify(STAGED_63))
      if (staged === null) throw new Error('staged file does not parse')
      const ball = STAGED_63.body.ball
      expect(classifyHeadTransition(PUBLISHED_ENTRIES, staged.ball.entries))
        .toEqual(host().classifyHeadTransition?.({ entries: PUBLISHED_ENTRIES }, ball))
      const pearlEntry = ball.entries['seed-pearl'] as Record<string, unknown>
      const variants: Record<string, unknown>[] = [ball.entries, {}, { ...ball.entries, 'seed-pearl': { ...pearlEntry, config: { a: 1 } } }]
      for (const entries of variants) {
        const page = Object.assign(Object.create(null) as Record<string, HeadEntry>, entries)
        expect(await headPromotionBinding({ audience, ball: { ...staged.ball, entries: page }, entryId: 'seed-pearl' }))
          .toEqual(await host().headPromotionBinding?.({ audience, ball: { ...ball, entries }, entryId: 'seed-pearl' }))
      }
    })
  it.skipIf(HOST?.classifyHeadTransition == null || HOST.headPromotionBinding == null
    || (HOST.classifyHeadTransition({ entries: {} }, { entries: { 'seed-predict': { specifier: 'inline:x' } } }) as { class?: number }).class !== 3)(
    'follows the host’s Round 24 governance set (F1): named organs and declarations, classified and bound alike', async () => {
      const staged = parseStagedPromotion(JSON.stringify(STAGED_63))
      if (staged === null) throw new Error('staged file does not parse')
      const declared = { ...PUBLISHED_ENTRIES['auma-notes'], config: { governance: true } }
      const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'seed-predict': entryOf('seed-predict', `ball:${'9f'.repeat(32)}`) }],
        [PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': declared }],
        [{ ...PUBLISHED_ENTRIES, 'auma-notes': declared }, PUBLISHED_ENTRIES],
        [PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': { ...declared, config: { governance: false } } }],
        [PUBLISHED_ENTRIES, { ...PUBLISHED_ENTRIES, 'auma-notes': { ...PUBLISHED_ENTRIES['auma-notes'], governance: 'yes', specifier: 'inline:x' } }],
      ]
      for (const [previous, candidate] of pairs) {
        const pagePrevious = Object.assign(Object.create(null) as Record<string, HeadEntry>, previous)
        const pageCandidate = Object.assign(Object.create(null) as Record<string, HeadEntry>, candidate)
        const page = classifyHeadTransition(pagePrevious, pageCandidate)
        expect(page).toEqual(host().classifyHeadTransition?.({ entries: previous }, { entries: candidate }))
        for (const entryId of page.entryIds) {
          const pageBall = { ...staged.ball, entries: pageCandidate }
          expect(await headPromotionBinding({ audience, ball: pageBall, entryId, previous: pagePrevious }))
            .toEqual(await host().headPromotionBinding?.({ audience, ball: { ...STAGED_63.body.ball, entries: candidate }, entryId,
              previous: { entries: previous } }))
        }
      }
    })
  it('Touch ID is offered only when nothing this page can check stands in the way, and each reason is said', async () => {
    const now = Date.UTC(2026, 10, 9, 10)
    const staged = parseStagedPromotion(JSON.stringify(STAGED_63))
    const ready = await promotionStateOf(staged, CONTEXT(now))
    expect(ready).toMatchObject({ kind: 'staged', reasons: [], bytes: 'absent', others: [], codeChanged: true,
      change: ['replaces its code: ball:1a1a1a1a… → ball:fa5df625…'] })
    // A host that does not say it can qualify a governance Pearl is offered no passkey (the cloud build today).
    const unqualified = await promotionStateOf(staged, CONTEXT(now, { canQualify: false }))
    expect(unqualified.kind === 'staged' ? unqualified.reasons.join(' | ') : '').toContain('PEARL_QUALIFICATION_UNVERIFIABLE')
    const onHead = { published: { entries: PUBLISHED_ENTRIES, ballId: STAGED_63.body.ball.ballId, epoch: 163 } }
    expect(await promotionStateOf(staged, CONTEXT(now, onHead)))
      .toEqual({ kind: 'on-head', ballId: STAGED_63.body.ball.ballId })
    const reasonsOf = async (context: PromotionContext, file: unknown = STAGED_63) => {
      const state = await promotionStateOf(parseStagedPromotion(JSON.stringify(file)), context)
      return state.kind === 'staged' ? state.reasons.join(' | ') : state.kind
    }
    expect(await reasonsOf(CONTEXT(now, { runtime: 'local' }))).toContain('this Mac host lands no governance Pearl')
    expect(await reasonsOf(CONTEXT(now, { published: { entries: PUBLISHED_ENTRIES, ballId: 'ef'.repeat(32), epoch: 162 } }))).toContain('REBASE_REQUIRED')
    // Round 24: the lease it was staged with is never a reason (it has always lapsed: the page takes a fresh one after Touch
    // ID), and a lease someone holds right now is not one either (it lapses within 60 s, and the page waits for it).
    expect(await reasonsOf(CONTEXT(now, { lease: null }))).toBe('')
    expect(await reasonsOf(CONTEXT(now, { lease: { ...LIVE_LEASE(now), generation: 8 } }))).toBe('')
    expect(await reasonsOf(CONTEXT(now, { lease: { ownerPeerId: 'peer-9', generation: 8, expiresAt: now + 5_000 } }))).toBe('')
    // Only a manifest with no author HEAD can lease to stands in the way.
    const authorless = { ...STAGED_63, body: { ...STAGED_63.body, ball: { ...STAGED_63.body.ball, authorPeerId: null } } }
    expect(await reasonsOf(CONTEXT(now), authorless)).toContain('INVALID_WRITER_LEASE')
    // HEAD's own reason for not landing one is said as HEAD gave it.
    expect(await reasonsOf(CONTEXT(now, { canQualify: false, qualifyBlocker: 'CLASS3_WEBAUTHN_REQUIRED' })))
      .toContain('(HEAD: CLASS3_WEBAUTHN_REQUIRED)')
    // An entry changed after the id was computed: HEAD's id no longer matches the contents.
    const tampered = { ...STAGED_63, body: { ...STAGED_63.body, ball: { ...STAGED_63.body.ball,
      entries: { ...STAGED_63.body.ball.entries, 'auma-notes': { ...PUBLISHED_ENTRIES['auma-notes'], config: { quiet: true } } } } } }
    expect(await reasonsOf(CONTEXT(now), tampered)).toContain('MANIFEST_HASH_MISMATCH')
    // Module bytes are checked the way HEAD checks them.
    const code = 'export default { pearl: 163 }'
    const sha = createHash('sha256').update(code).digest('hex')
    const withBytes = stagedFile({ ...PUBLISHED_ENTRIES, 'seed-pearl': entryOf('seed-pearl', `ball:${sha}`) }, { codeBySha: { [sha]: code } })
    expect(await promotionStateOf(parseStagedPromotion(JSON.stringify(withBytes)), CONTEXT(now))).toMatchObject({ bytes: 'verified', reasons: [] })
    const wrongBytes = stagedFile({ ...PUBLISHED_ENTRIES, 'seed-pearl': entryOf('seed-pearl', `ball:${sha}`) }, { codeBySha: { [sha]: `${code} ` } })
    expect(await reasonsOf(CONTEXT(now), wrongBytes)).toContain('MODULE_HASH_MISMATCH')
    // A disable keeps the same bytes; the card says so in words, not as new bytes.
    const disabled = stagedFile({ ...PUBLISHED_ENTRIES, 'seed-pearl': { ...PUBLISHED_ENTRIES['seed-pearl'], disabled: true } })
    expect(await promotionStateOf(parseStagedPromotion(JSON.stringify(disabled)), CONTEXT(now))).toMatchObject({ change: ['DISABLES it'], codeChanged: false })
    const both = stagedFile({ ...PUBLISHED_ENTRIES, 'seed-pearl': entryOf('seed-pearl', `ball:${STAGED_PEARL}`), 'seed-aura': entryOf('seed-aura', `ball:${'4d'.repeat(32)}`) })
    expect(await promotionStateOf(parseStagedPromotion(JSON.stringify(both)), CONTEXT(now))).toEqual({ kind: 'several', entryIds: ['seed-pearl', 'seed-aura'] })
    expect(await promotionStateOf(null, CONTEXT(now))).toEqual({ kind: 'absent' })
  })
  it('a staged Pearl HEAD could not be read against still shows, as not checked', async () => {
    const now = Date.now()
    const staged = parseStagedPromotion(JSON.stringify(STAGED_63))
    expect(await promotionStateOf(staged, CONTEXT(now, { published: { entries: null, ballId: null, epoch: null } })))
      .toEqual({ kind: 'unreadable', staged: true, why: 'the published Pearl could not be read, so the change cannot be classified' })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      if (input === '/_head/ball') return json({ ok: false, code: 'HEAD_BUSY' }, 503)
      return new Response('nope', { status: 404 })
    }))
    const { container } = render(<SovereigntySurface {...{
      activeSurface: SOVEREIGNTY_SURFACE,
      useSessions: sessionHooks(['s1']).useSessions,
      reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === STAGED_PROMOTION_PATH
        ? { ok: true, text: JSON.stringify(STAGED_63) } : { ok: false, reason: 'not-found' }) },
    } as unknown as Parameters<typeof SovereigntySurface>[0]}
    />)
    const cell = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(cell()?.textContent).toContain('a Pearl is staged; not checked: the published Pearl was not read') }, { timeout: 10_000 })
    expect(cell()?.textContent).toContain('NOT CHECKED')
    expect(cell()?.querySelector('[data-sovereignty-promote]')).toBeNull()
  }, 30_000)
  it('the host’s durable approvals are read from its status and said in words', () => {
    const parsed = parseAumlokStatus({ ...hostStatusBody('BOUND', true), approvedGrants: [
      { schema: 'aumlok.approval.v1', approvalId: 'A'.repeat(22), binding: { action: 'head.promote', organId: 'seed-pearl', epoch: 163 },
        generation: 1, approvedAt: 1000, expiresAt: 301_000, consumedAt: null, recordMac: 'f'.repeat(64) },
      { schema: 'other' }] })
    expect(parsed?.approvedGrants).toEqual([{ approvalId: 'A'.repeat(22), binding: { action: 'head.promote', organId: 'seed-pearl', epoch: 163 },
      approvedAt: 1000, expiresAt: 301_000, consumedAt: null }])
    expect(approvalsWords(parsed?.approvedGrants ?? [], 2000)).toBe('1 live of 1 · head.promote seed-pearl epoch 163')
    expect(approvalsWords([], 2000)).toBe('none held by this host')
  })
  it('on screen: Touch ID approves the exact binding, then a FRESH lease, then her staged bytes go to HEAD under it', async () => {
    const restore = stubAuthenticator()
    const posts: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    let echoed: unknown = null
    let landed = false
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (init?.method === 'POST') posts.push({ url: input, body, headers: { ...(init.headers as Record<string, string>) } })
      if (input === '/_host/aumlok/status') return json({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null })
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      // The host says it can qualify a governance Pearl; no lease is held (the one she staged with lapsed long ago). Its
      // answer names the head HEAD holds, the landed Pearl once it landed (a lease answer naming
      // another head than the one the page read is no longer taken as "on HEAD").
      if (input === '/_head/lease' && init?.method !== 'POST') {
        return json({ ok: true, governancePromotion: true, lease: null, ...(landed ? { ballId: STAGED_63.body.ball.ballId, epoch: 163 }
          : { ballId: HEAD_62, epoch: 162 }) })
      }
      if (input === '/_head/lease' && body.action === 'acquire') {
        const at = Date.now()
        return json({ ok: true, lease: { ownerPeerId: body.ownerPeerId, generation: 12, expiresAt: at + 30_000, deadlineAt: at + 60_000 },
          ballId: HEAD_62, epoch: 162 })
      }
      if (input === '/_head/lease' && body.action === 'release') return json({ ok: true, released: true })
      if (input === '/_head/ball' && init?.method !== 'POST') {
        const head = landed ? { ballId: STAGED_63.body.ball.ballId, parentBallId: HEAD_62, epoch: 163,
          entries: STAGED_63.body.ball.entries }
          : { ballId: HEAD_62, parentBallId: null, epoch: 162, entries: PUBLISHED_ENTRIES }
        return json({ ok: true, buildSha: 'b'.repeat(40), head, modules: {}, peers: [] })
      }
      if (input === '/_host/aumlok/challenge') {
        echoed = body.binding
        return json({ ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-0001', purpose: 'approve', intentHash: 'f'.repeat(64),
          binding: body.binding, publicKey: { challenge: base64url(new Uint8Array(32).fill(8)), rpId: 'localhost', userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: base64url(new Uint8Array(16).fill(7)) }] } })
      }
      if (input === '/_host/aumlok/approve') {
        const approvedAt = Date.now()
        return json({ ok: true, approvalToken: base64url(new Uint8Array(32).fill(9)), approvedAt, expiresAt: approvedAt + 300_000,
          binding: echoed })
      }
      if (input === '/_head/ball') { landed = true; return json({ ok: true, ballId: STAGED_63.body.ball.ballId, epoch: 163 }) }
      return new Response('nope', { status: 404 })
    }))
    try {
      const props = {
        activeSurface: SOVEREIGNTY_SURFACE,
        useSessions: sessionHooks(['s1']).useSessions,
        reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === STAGED_PROMOTION_PATH
          ? { ok: true, text: JSON.stringify(STAGED_63) } : { ok: false, reason: 'not-found' }) },
      }
      const { container } = render(<SovereigntySurface {...fixture<Parameters<typeof SovereigntySurface>[0]>(props)} />)
      const cell = () => container.querySelector('[data-sovereignty-portal="promotion"]')
      await waitFor(() => { expect(cell()?.textContent).toContain('HEAD could take it') }, { timeout: 10_000 })
      const head = cell()?.querySelector('button')
      if (head === null || head === undefined) throw new Error('no card head')
      // The waiting card draws open (Lane B2): opened only if it is not.
      if (head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
      const promote = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
      await waitFor(() => { expect(promote()?.disabled).toBe(false) })
      expect(cell()?.textContent).toContain('replaces its code: ball:1a1a1a1a… → ball:fa5df625…')
      // The lease sits in the card's closed Details fold (Round 25).
      expect(cell()?.textContent).not.toContain('free now')
      const details = [...(cell()?.querySelectorAll('button') ?? [])].find(button => button.textContent?.startsWith('Details'))
      if (details === undefined) throw new Error('no Details fold')
      fireEvent.click(details)
      expect(cell()?.textContent).toContain('free now: right after Touch ID this page takes a fresh one for peer-1')
      expect(promote()?.textContent).toBe('Approve Staged Governance Pearl (seed-pearl fa5df625…) with Touch ID')
      fireEvent.click(promote() as Element)
      await waitFor(() => { expect(container.querySelector('[data-sovereignty-promotion-outcome="ok"]')).not.toBeNull() }, { timeout: 10_000 })
      expect(posts.map(post => post.url)).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/approve', '/_head/lease', '/_head/ball', '/_head/lease'])
      expect(posts[0]?.body.binding).toEqual({ schema: 'aukora.class3.head-promotion.v1', audience: location.origin, action: 'head.promote',
        ballId: STAGED_63.body.ball.ballId, epoch: 163, organId: 'seed-pearl', candidateSha256: STAGED_PEARL })
      // The fresh lease is asked for after the approval, for the Pearl's author.
      expect(posts[2]?.body).toEqual({ action: 'acquire', ownerPeerId: 'peer-1', ttlMs: 30_000 })
      // HEAD receives her exact staged bytes with the FRESH lease in place of the lapsed one, and the approval beside them.
      expect(posts[3]?.body).toEqual({ ...STAGED_63.body, writerLease: { ownerPeerId: 'peer-1', generation: 12 } })
      expect(posts[3]?.body.ball).toEqual(STAGED_63.body.ball)
      expect(posts[3]?.headers['x-x6-class3-approval']).toBe(base64url(new Uint8Array(32).fill(9)))
      // The lease is given back.
      expect(posts[4]?.body).toEqual({ action: 'release', ownerPeerId: 'peer-1', generation: 12 })
      // Landed: the card reads the head again, shows the Pearl on HEAD, and offers nothing more.
      // Round 25 review: the card stays with his approval's outcome until Refresh, then goes (nothing is left to approve).
      await waitFor(() => { expect(cell()?.textContent).toContain('on HEAD: it is the published Pearl') }, { timeout: 10_000 })
      expect(cell()?.textContent).toContain('ON HEAD')
      expect(promote()).toBeNull()
      expect(container.querySelector('[data-sovereignty-promotion-outcome="ok"]')?.textContent).toMatch(/HEAD took it/u)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      fireEvent.click(container.querySelector('[data-sovereignty-refresh]') as Element)
      await waitFor(() => { expect(cell()).toBeNull() }, { timeout: 10_000 })
    } finally { restore() }
  }, 30_000)
  it('checked again at the click: HEAD that stopped saying it can qualify one asks for no passkey', async () => {
    const restore = stubAuthenticator()
    const posts: string[] = []
    let canQualify = true
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(input)
      if (input === '/_host/aumlok/status') return json({ ...hostStatusBody('BOUND', true, FIXTURE_NODE.nodePubkeyHex), commitmentSha256: null })
      if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
      if (input === '/_head/lease') return json({ ok: true, governancePromotion: canQualify, lease: null })
      if (input === '/_head/ball') {
        return json({ ok: true, buildSha: 'b'.repeat(40), head: { ballId: HEAD_62, parentBallId: null, epoch: 162, entries: PUBLISHED_ENTRIES }, modules: {}, peers: [] })
      }
      return new Response('nope', { status: 404 })
    }))
    try {
      const props = {
        activeSurface: SOVEREIGNTY_SURFACE,
        useSessions: sessionHooks(['s1']).useSessions,
        reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === STAGED_PROMOTION_PATH
          ? { ok: true, text: JSON.stringify(STAGED_63) } : { ok: false, reason: 'not-found' }) },
      }
      const { container } = render(<SovereigntySurface {...fixture<Parameters<typeof SovereigntySurface>[0]>(props)} />)
      const cell = () => container.querySelector('[data-sovereignty-portal="promotion"]')
      await waitFor(() => { expect(cell()?.textContent).toContain('HEAD could take it') }, { timeout: 10_000 })
      openCell(cell())
      const promote = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
      await waitFor(() => { expect(promote()?.disabled).toBe(false) })
      canQualify = false
      ageCards()
      fireEvent.click(promote() as Element)
      await waitFor(() => { expect(cell()?.textContent).toContain('Checked again just now: HEAD would refuse it') })
      expect(cell()?.textContent).toContain('PEARL_QUALIFICATION_UNVERIFIABLE')
      expect(posts).toEqual([])
    } finally { restore() }
  }, 30_000)
  it('HEAD’s answer: only its own 4xx is a refusal; a 5xx or no answer is unclear unless the new Pearl is now on HEAD', async () => {
    const ballId = STAGED_63.body.ball.ballId
    const answers = (first: Response | Error, head: unknown) => (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { if (first instanceof Error) throw first; return first }
      return json({ ok: true, head })
    }) as unknown as typeof fetch
    const signal = new AbortController().signal
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(json({ ok: true, ballId, epoch: 163 }), null)))
      .toEqual({ kind: 'landed' })
    // Round 31: an ok is landed only when HEAD names THIS Pearl. One that names another, or none, is checked on HEAD.
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(json({ ok: true, ballId: HEAD_62, epoch: 162 }), { ballId: HEAD_62 })))
      .toEqual({ kind: 'unclear', detail: 'HEAD answered 200', headRead: 'not-on-head' })
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(json({ ok: true }), { ballId }))).toEqual({ kind: 'landed' })
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(json({ ok: false, code: 'REBASE_REQUIRED' }, 409), null)))
      .toEqual({ kind: 'refused', code: 'REBASE_REQUIRED' })
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, 503), { ballId })))
      .toEqual({ kind: 'landed' })
    expect(await publishApprovedPromotion(STAGED_63.body, 'tok', ballId, signal, answers(new TypeError('network down'), { ballId: HEAD_62 })))
      .toEqual({ kind: 'unclear', detail: 'HEAD did not answer', headRead: 'not-on-head' })
  })
})
