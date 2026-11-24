/**
 * `x6_host_facts`, a bounded read-only tool over her host's own reports. Unit level over the projections and
 * the reader, then on the mounted runtime (e4 fixture, reserved `.invalid` origin): it is registered, the capability
 * index lists it read-only, it makes only same-origin GETs to the three named paths, writes nothing, and returns no
 * envelope, module code, public key, id or commitment. Local fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_FACTS_SOURCES, projectAumlokStatus, projectPromotionStatus, projectX6Facts, readHostFacts,
} from '../../src/x6/host-facts.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const BALL = 'b'.repeat(64), STAGED = 'c'.repeat(64)
const NODE_KEY = 'd'.repeat(64), COMMIT = 'e'.repeat(64)
const promotionRaw = () => ({
  ok: true, lease: { ownerPeerId: 'peer-1', generation: 3, expiresAt: 1_000 }, ballId: BALL, epoch: 170,
  governancePromotionPolicy: 'owner-passkey-canonical-single-entry-v1', governancePromotion: true,
  // The producer's shapes (head-do.mjs readStaged record + `head:last-publish-outcome`).
  staged: { schema: 'aukora.staged-head-promotion.v1', ballId: STAGED, epoch: 171, parentBallId: BALL, authorPeerId: 'tab-1',
    stagedAt: 1_762_866_600_000, state: 'awaiting_owner', stagedForOwner: true,
    changedEntries: ['seed-nostr-anchor'], tier: 'T2', t2Reasons: ['ORGAN_ADDED_OR_REMOVED'], governanceClass: 3,
    binding: { audience: 'x', bodySha256: 'f'.repeat(64) }, candidateDigest: 'a'.repeat(64), compactModuleShas: [STAGED],
    envelope: { schema: 'aukora.staged-head-promotion.v1', body: { ball: { entries: {} }, codeBySha: { [STAGED]: 'module.exports = "' + 'x'.repeat(40_000) + '"' } } } },
  supersededStaged: null,
  lastPublishOutcome: { at: 5, ok: true, code: 'PUBLISHED', status: 200, candidateBallId: BALL, candidateEpoch: 170,
    expectedParentBallId: 'a'.repeat(64), expectedEpoch: 169, ownerSessionApproved: true, hasApprovalToken: true,
    resultingBallId: BALL, resultingEpoch: 170, privateNote: 'never' },
  repoProposal: { token: 'never-returned' },
  peers: [{ peerId: 'p1' }, { peerId: 'p2' }],
})
const aumlokRaw = () => ({
  ok: true, schema: 'aukora.aumlok.status.v1', phase: 'BOUND', bound: true, passkeyVerified: true, aumlokId: 'aumlok-secret-id', nodePubkeyHex: NODE_KEY,
  boundAt: 10, lastVerifiedAt: 20, enrollmentCount: 1, rotationSeq: 0, pepperSeparated: false, pepperMigrationRequired: false,
  keyCommitmentId: COMMIT, approvedGrants: [{ approvalId: 'g1' }], authorityAvailable: true, enrollmentAvailable: false,
  blockers: [], phraseBlockers: [], invite: { quotaMonth: '2026-11', issuedThisMonth: 1, limit: 3, revokedCount: 0, lifetimeIssuedCount: 2 },
})
const factsRaw = () => ({ ok: true, epoch: 170, ballId: BALL, evidenceStatus: 'complete', receiptTotal: 153, receiptsVerified: 153,
  checkpointsTotal: 6, auraStatus: 'ok', ownerJwt: 'never', note: 'free text never' })

describe('projections keep named facts and drop everything else', () => {
  it('promotion-status: head, lease, staged summary; never the envelope, module code, binding body or repo token', () => {
    const out = projectPromotionStatus(promotionRaw())
    expect(out).toEqual({
      ballId: BALL, epoch: 170, lease: { held: true, generation: 3, expiresAt: 1_000 }, governancePromotion: true,
      governancePromotionPolicy: 'owner-passkey-canonical-single-entry-v1',
      staged: { ballId: STAGED, epoch: 171, parentBallId: BALL, state: 'awaiting_owner', stagedAt: 1_762_866_600_000, stagedForOwner: true,
        bindingPresent: true, changedEntries: ['seed-nostr-anchor'], tier: 'T2', t2Reasons: ['ORGAN_ADDED_OR_REMOVED'], governanceClass: 3 },
      supersededStaged: null,
      lastPublishOutcome: { ok: true, code: 'PUBLISHED', status: 200, at: 5, candidateBallId: BALL, candidateEpoch: 170,
        expectedParentBallId: 'a'.repeat(64), expectedEpoch: 169, resultingBallId: BALL, resultingEpoch: 170, ownerSessionApproved: true,
        hasApprovalToken: true },
      peers: 2,
    })
    const text = JSON.stringify(out)
    for (const leaked of ['module.exports', 'envelope', 'codeBySha', 'never-returned', 'peer-1', 'privateNote', 'f'.repeat(64)]) expect(text).not.toContain(leaked)
  })

  it('aumlok status: phase, blockers and counts; never the node key, AUMLOK id or key commitment', () => {
    const out = projectAumlokStatus(aumlokRaw())
    expect(out).toMatchObject({ phase: 'BOUND', bound: true, pepperSeparated: false, approvedGrantCount: 1, blockers: [], invite: { issuedThisMonth: 1, limit: 3 } })
    const text = JSON.stringify(out)
    for (const leaked of [NODE_KEY, COMMIT, 'aumlok-secret-id', 'g1', '2026-11']) expect(text).not.toContain(leaked)
  })

  it('facts: the verified-facts allowlist only', () => {
    expect(projectX6Facts(factsRaw())).toEqual({ epoch: 170, ballId: BALL, evidenceStatus: 'complete', receiptTotal: 153, receiptsVerified: 153,
      checkpointsTotal: 6, auraStatus: 'ok' })
  })

  it('a refusal or a foreign shape projects to nothing', () => {
    for (const project of [projectPromotionStatus, projectAumlokStatus, projectX6Facts]) {
      expect(project({ ok: false, code: 'OWNER_SESSION_REQUIRED' })).toBeNull()
      expect(project('nope')).toBeNull()
    }
  })
})

type Seen = { url: string; method: string | undefined; credentials: RequestCredentials | undefined; redirect: RequestRedirect | undefined }
function fakeFetch(answers: Record<string, () => Response>) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method, credentials: init?.credentials, redirect: init?.redirect })
    const path = new URL(url).pathname
    return answers[path]?.() ?? Response.json({ ok: false }, { status: 404 })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}
const ORIGIN = 'https://her.invalid'

describe('the reader', () => {
  it('reads the three paths with same-origin GETs only, and says voiceAuthority none, mutating false', async () => {
    const f = fakeFetch({ '/_head/promotion-status': () => Response.json(promotionRaw()), '/_host/aumlok/status': () => Response.json(aumlokRaw()),
      '/__x6/facts': () => Response.json(factsRaw()) })
    const out = await readHostFacts(undefined, { origin: ORIGIN, fetch: f.fetchImpl, now: () => 42 })
    expect(out).toMatchObject({ schema: 'aukora.host-facts.v1', voiceAuthority: 'none', mutating: false, ok: true, readAt: 42,
      promotion: { ok: true, source: '/_head/promotion-status', epoch: 170 }, aumlok: { ok: true, phase: 'BOUND' }, facts: { ok: true, receiptTotal: 153 } })
    expect(f.seen.map(item => [item.url, item.method, item.credentials, item.redirect]).sort()).toEqual([
      [`${ORIGIN}/__x6/facts`, 'GET', 'same-origin', 'error'], [`${ORIGIN}/_head/promotion-status`, 'GET', 'same-origin', 'error'],
      [`${ORIGIN}/_host/aumlok/status`, 'GET', 'same-origin', 'error']])
    expect(new TextEncoder().encode(JSON.stringify(out)).byteLength).toBeLessThan(16 * 1024)
  })

  it('each source fails by its own code and the others still answer', async () => {
    const f = fakeFetch({ '/_head/promotion-status': () => Response.json(promotionRaw()), '/_host/aumlok/status': () => Response.json({ ok: false }, { status: 403 }),
      '/__x6/facts': () => new Response('x'.repeat(HOST_FACTS_SOURCES.facts.maxBytes + 1)) })
    const out = await readHostFacts(undefined, { origin: ORIGIN, fetch: f.fetchImpl })
    expect(out.ok).toBe(false)
    expect(out.promotion).toMatchObject({ ok: true, epoch: 170 })
    expect(out.aumlok).toEqual({ ok: false, code: 'HOST_FACTS_UNAUTHORIZED', status: 403, source: '/_host/aumlok/status' })
    expect(out.facts).toEqual({ ok: false, code: 'HOST_FACTS_BYTE_LIMIT', source: '/__x6/facts' })
  })

  it('reads only the sections asked for, and refuses an unknown one by name without any fetch', async () => {
    const f = fakeFetch({ '/__x6/facts': () => Response.json(factsRaw()) })
    const one = await readHostFacts(['facts'], { origin: ORIGIN, fetch: f.fetchImpl })
    expect(Object.keys(one)).not.toContain('promotion')
    expect(f.seen).toHaveLength(1)
    for (const bad of [['facts', 'secrets'], [], 'facts', { a: 1 }]) {
      expect(await readHostFacts(bad, { origin: ORIGIN, fetch: f.fetchImpl })).toMatchObject({ ok: false, code: 'HOST_FACTS_SECTION_UNKNOWN', mutating: false })
    }
    expect(f.seen).toHaveLength(1)
  })

  it('no origin, a network failure and malformed JSON are codes, never throws', async () => {
    expect(await readHostFacts(['facts'], { origin: undefined })).toMatchObject({ facts: { ok: false, code: 'HOST_FACTS_ORIGIN_UNAVAILABLE' } })
    const broken = (async () => { throw new TypeError('offline') }) as unknown as typeof fetch
    expect(await readHostFacts(['aumlok'], { origin: ORIGIN, fetch: broken })).toMatchObject({ aumlok: { ok: false, code: 'HOST_FACTS_UNAVAILABLE' } })
    const garbage = (async () => new Response('{not json')) as unknown as typeof fetch
    expect(await readHostFacts(['promotion'], { origin: ORIGIN, fetch: garbage })).toMatchObject({ promotion: { ok: false, code: 'HOST_FACTS_UNAVAILABLE' } })
  })
})

describe('x6_host_facts on the mounted runtime', () => {
  it('is registered, listed read-only in the capability index, GETs only, and writes nothing', async () => {
    const m = await mountE4({
      respond: (call) => {
        if (call.method !== 'GET') return null
        if (call.path === '/_head/promotion-status') return Response.json(promotionRaw())
        if (call.path === '/_host/aumlok/status') return Response.json(aumlokRaw())
        if (call.path === '/__x6/facts') return Response.json(factsRaw())
        return null
      },
    })
    const tool = m.tool('x6_host_facts')
    expect(Object.keys((tool as unknown as { parameters: Record<string, unknown> }).parameters)).toEqual(['sections'])
    const index = m.runtime.capabilityIndex()
    expect(index.registeredTools.find(item => item.name === 'x6_host_facts')).toMatchObject({ readOnly: true, mutating: false })
    const callsBefore = m.calls.length
    const filesBefore = JSON.stringify(m.vfs.readdirSync('/dsh/home/balls'))
    const out = await tool.execute({}, undefined) as Record<string, unknown>
    expect(out).toMatchObject({ ok: true, voiceAuthority: 'none', mutating: false, promotion: { epoch: 170 }, aumlok: { phase: 'BOUND' }, facts: { receiptTotal: 153 } })
    const made = m.calls.slice(callsBefore)
    expect(made.map(call => `${call.method} ${call.path}`).sort()).toEqual(['GET /__x6/facts', 'GET /_head/promotion-status', 'GET /_host/aumlok/status'])
    expect(made.every(call => call.credentials === 'same-origin')).toBe(true)
    expect(JSON.stringify(m.vfs.readdirSync('/dsh/home/balls'))).toBe(filesBefore)
    for (const leaked of [NODE_KEY, COMMIT, 'module.exports', 'aumlok-secret-id', 'never']) expect(JSON.stringify(out)).not.toContain(leaked)
  })
})
