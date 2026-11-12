// @vitest-environment jsdom
/**
 * The Sovereignty durability and continuity strip: the pure projection (portal/durability.ts) from the reads the surface
 * already makes, and the strip as the surface draws it. Every body below is shaped like what a host serves today, and is
 * read through the same parser the page uses (parseEdgeHealth, parseAumlokStatus, parseHostFacts).
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  COLD_BACKUP_UNSUPPORTED, durabilityNoteOf, durabilityTilesOf, edgeAuraOf, englishDurability, healthHeadsOf, PROVIDER_MIN_RESERVATION,
  providerUsageOf,
  type DurabilityInput, type DurabilityTile,
} from '../src/client/spatial/portal/durability.ts'
import { CONTINUITY_SURFACE, ContinuitySurface, SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { parseEdgeHealth, type HostMode } from '../src/client/spatial-components.tsx'
import { parseAumlokStatus, type AumlokHostStatus } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { parseHostFacts } from '../src/client/spatial/work/host-facts.ts'
import { keysCardOf } from '../src/client/spatial/portal/sovereignty-cards.ts'
import { en, zh } from '../src/client/spatial/locales.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

const HEAD = '7c01cb98514e4ae7a6aaa0dc29653282d94bc4717b85a18968b47aa4310120a8'
const SOURCE = '5ba508cc0f1e2d3c4b5a69788796a5b4c3d2e1f0'
/** The edge's `unsupported` list as deploy/cloudflare/src/worker.mjs answers it today (public web fetch bound). */
const TODAY_UNSUPPORTED = ['native-shell', 'local-repository', 'eyes', 'no-tab-agent-loop', 'runtime-recovery', 'cold-r2-backup',
  'provider-request-deduplication', 'session-turn-lease']
const healthBody = (unsupported: readonly string[], buildSha: string = SOURCE) => ({ ok: true, ready: true, runtime: 'cloudflare',
  macDependency: false, buildSha, capabilities: { head: true, mirror: true, providerDoors: { deepseek: true } }, unsupported })
const FACTS = {
  ok: true, runtime: 'cloudflare', epoch: 12, ballId: HEAD, organCount: 26, activeOrganCount: 26, receiptTotal: 120, receiptsVerified: 120,
  checkpointsTotal: 6, lastCheckpointSeq: 6, lastCheckpointReceiptCount: 115, dagReachable: 3, dagDeclared: 3, auraStatus: 'calm',
  receiptVerification: 'hash-and-chain', checkpointVerification: 'signature-and-receipt-prefix', checkpointSignerTrust: 'pinned',
  evidenceStatus: 'complete',
}
const AUMLOK_BOUND = { ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] }
/** The edge Aura as GET /__x6/status returns it (head-do.mjs readCloudAuraInputs `.aura`), for a clean state. */
const AURA_CALM = { schema: 'aukora.aura.v1', scorer: 'rules-v1', status: 'calm', authorityTier: 'peripheral-hint', computedAt: 1, ballId: HEAD,
  epoch: 12, vector: { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 }, recommendedFocus: 'rest',
  salience: [{ kind: 'clean-state', targetId: HEAD, score: 1, code: 'all-signals-clear' }], gaps: [], selectionIsNotHealthProof: true }
const statusBody = (aura: unknown = AURA_CALM) => ({ ok: true, head: { ballId: HEAD, epoch: 12 }, aura, runtime: 'cloudflare' })

const status = (body: Record<string, unknown>): AumlokHostStatus => {
  const parsed = parseAumlokStatus(body)
  if (parsed === null) throw new Error('fixture is not an AUMLOK status')
  return parsed
}
const edgeMode = (unsupported: readonly string[], buildSha?: string): HostMode =>
  ({ kind: 'cloudflare', host: 'node.example.invalid', edge: parseEdgeHealth(healthBody(unsupported, buildSha)), edgeTrouble: null })
const facts = (body: Record<string, unknown> = FACTS): DurabilityInput['facts'] => {
  const parsed = parseHostFacts(body)
  if (parsed === null) throw new Error('fixture is not host facts')
  return parsed.complete ? { kind: 'ok', facts: parsed } : { kind: 'incomplete', facts: parsed }
}
const LIVE: DurabilityInput = {
  head: { kind: 'ok', value: { epoch: '12', ballId: HEAD, buildSha: '—' } },
  aumlok: { kind: 'live', status: status(AUMLOK_BOUND) },
  receipts: { kind: 'verified', merkleRoot: 'ab'.repeat(32), checkpointHash: null, receiptsVerified: 120, checkpointsVerified: 6 },
  receiptsStale: false,
  facts: facts(),
  host: edgeMode(TODAY_UNSUPPORTED),
  status: { kind: 'ok', body: statusBody() },
  health: { kind: 'ok', body: healthBody(TODAY_UNSUPPORTED) },
}
const tiles = (input: Partial<DurabilityInput>) => durabilityTilesOf({ ...LIVE, ...input }, englishDurability)
const tile = (all: readonly DurabilityTile[], id: DurabilityTile['id']): DurabilityTile => {
  const found = all.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no ${id} tile`)
  return found
}
const view = (all: readonly DurabilityTile[]) => Object.fromEntries(all.map(entry => [entry.id, `${entry.state}: ${entry.value}`]))

describe('durability strip projection', () => {
  it('every field present: HEAD epoch and Pearl, passkey, counts, cold backup as the edge lists it, the stamped source revision', () => {
    const all = tiles({})
    expect(all.map(entry => entry.name)).toEqual(['Live HEAD (epoch · Pearl)', 'Aura drift', 'Passkey (AUMLOK)', 'Receipts', 'Checkpoints',
      'R2 cold backup', 'Provider window', 'Edge source revision (stamped)'])
    expect(view(all)).toEqual({
      'head': `live: 12 · ${HEAD.slice(0, 8)}`,
      'aura': 'live: in step',
      'passkey': 'live: bound',
      'receipts': 'live: 120',
      'checkpoints': 'live: 6',
      'cold-backup': 'not-built: not built',
      'spend': 'unavailable: not served',
      'source': `live: ${SOURCE.slice(0, 12)}`,
    })
    expect(tile(all, 'passkey').tone).toBe('mint')
    // The full Pearl id and commit ride on the title, never only on a clipped line.
    expect(tile(all, 'head').title).toBe(`epoch 12 · Pearl ${HEAD}`)
    // The one field this edge does not serve yet is said in the line under the strip, never hidden.
    expect(durabilityNoteOf(all, englishDurability)).toBe('Not read: Provider window: /api/health has no providerUsage field yet')
  })

  it('the edge buildSha is a hand-stamped SOURCE_REVISION: named as stamped, a neutral tone, never "GitHub" or a deployed commit', () => {
    const source = tile(tiles({}), 'source')
    expect(source).toMatchObject({ name: 'Edge source revision (stamped)', tone: 'blue', state: 'live' })
    expect(source.title).toBe(`${SOURCE} (SOURCE_REVISION, hand-stamped; not proof of the deployed commit)`)
    expect(source.name).not.toMatch(/github/iu)
    expect(zh['sovereignty.durability.source']).toContain('手工标注')
  })

  it('cold backup is keyed off /api/health unsupported only: listed is "not built yet", unlisted says exactly that', () => {
    expect(TODAY_UNSUPPORTED).toContain(COLD_BACKUP_UNSUPPORTED)
    const today = tile(tiles({ host: edgeMode(TODAY_UNSUPPORTED) }), 'cold-backup')
    expect(today).toMatchObject({ state: 'not-built', value: 'not built', tone: 'muted' })
    const later = tile(tiles({ host: edgeMode(TODAY_UNSUPPORTED.filter(name => name !== COLD_BACKUP_UNSUPPORTED)) }), 'cold-backup')
    expect(later).toMatchObject({ state: 'live', value: 'unlisted',
      detail: 'the edge no longer lists cold-r2-backup as unsupported; no field says it is built' })
    // An edge with no SOURCE_REVISION answers 'UNVERIFIED': never shown as a commit.
    expect(tile(tiles({ host: edgeMode(TODAY_UNSUPPORTED, 'UNVERIFIED') }), 'source')).toMatchObject({ value: 'not stamped', tone: 'gold' })
  })

  it('AUMLOK missing or unbound: the passkey tile says so, and the rest stays live', () => {
    const absent = tiles({ aumlok: { kind: 'absent', detail: 'answered 404' } })
    expect(tile(absent, 'passkey')).toMatchObject({ state: 'unavailable', value: 'unavailable', detail: 'this host serves no AUMLOK status' })
    expect(tile(absent, 'head').state).toBe('live')
    expect(durabilityNoteOf(absent, englishDurability)).toContain('Not read: Passkey (AUMLOK): this host serves no AUMLOK status')
    const unbound = tiles({ aumlok: { kind: 'live', status: status({ ok: true, phase: 'UNBOUND', bound: false, passkeyVerified: false,
      nodePubkeyHex: null, blockers: [], enrollmentAvailable: true }) } })
    expect(tile(unbound, 'passkey')).toMatchObject({ state: 'live', value: 'not bound', tone: 'muted' })
    const locked = tiles({ aumlok: { kind: 'live', status: status({ ...AUMLOK_BOUND, blockers: ['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED'] }) } })
    expect(tile(locked, 'passkey')).toMatchObject({ value: 'locked', tone: 'gold', detail: 'bound, locked by AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED' })
    expect(durabilityNoteOf(locked, englishDurability)).toContain('Note: Passkey (AUMLOK): bound, locked by AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED')
    const unverified = tiles({ aumlok: { kind: 'live', status: status({ ...AUMLOK_BOUND, passkeyVerified: false }) } })
    expect(tile(unverified, 'passkey')).toMatchObject({ value: 'unverified', tone: 'gold', detail: 'bound, but the passkey is not verified' })
    expect(tile(tiles({ aumlok: { kind: 'refused', code: 'OWNER_ACCESS_REQUIRED' } }), 'passkey').state).toBe('unavailable')
  })

  it('every read failed: each tile says "unavailable" and no number is shown, the line under it says why', () => {
    const all = tiles({
      head: { kind: 'failed', reason: 'answered 503' },
      aumlok: { kind: 'unreadable' },
      receipts: { kind: 'bridge-unavailable' },
      facts: { kind: 'unavailable', reason: 'answered 503' },
      host: { kind: 'unknown', host: 'node.example.invalid', reason: '/__x6/status answered 503' },
      status: { kind: 'failed', reason: '/__x6/status answered 503' },
      health: { kind: 'reading' },
    })
    for (const entry of all) {
      expect(entry.state).toBe('unavailable')
      expect(entry.value).toBe('unavailable')
      expect(entry.value).not.toMatch(/\d/u)
    }
    const note = durabilityNoteOf(all, englishDurability) ?? ''
    expect(note).toContain('Live HEAD (epoch · Pearl): /_head/ball answered 503')
    expect(note).toContain('Receipts: her verifier gave no verdict (bridge-unavailable); /__x6/facts answered 503')
    expect(note).toContain('R2 cold backup: /__x6/status answered 503')
    expect(note).toContain('Aura drift: /__x6/status answered 503')
    expect(note).toContain('Provider window: /__x6/status answered 503')
  })

  it('a stale tab read is never shown as live: the host count wins, else the stale count is said as stale', () => {
    const fresher = facts({ ...FACTS, receiptsVerified: 121, receiptTotal: 121, checkpointsTotal: 7 })
    const withHost = tiles({ receiptsStale: true, facts: fresher })
    expect(tile(withHost, 'receipts').value).toBe('121')
    expect(tile(withHost, 'checkpoints').value).toBe('7')
    const alone = tiles({ receiptsStale: true, facts: { kind: 'unavailable', reason: 'answered 503' } })
    expect(tile(alone, 'receipts')).toMatchObject({ value: '120', tone: 'gold', detail: 'not the latest read', title: '120 — not the latest read' })
    expect(tile(alone, 'checkpoints')).toMatchObject({ value: '6', tone: 'gold', detail: 'not the latest read' })
    // The stale mark is in the line under the strip, which wraps, so it is never clipped away.
    expect(durabilityNoteOf(alone, englishDurability)).toContain('Note: Receipts: not the latest read · Checkpoints: not the latest read')
  })

  it('a live bad state shows: a rejected chain, host evidence incomplete, receipts not all verified', () => {
    const rejected = tiles({ receipts: { kind: 'rejected', stage: 'receipt-chain', error: 'RECEIPT_CHAIN_BROKEN' } })
    expect(tile(rejected, 'receipts')).toMatchObject({ state: 'alarm', value: 'REJECTED', tone: 'red',
      detail: 'her verifier REJECTED the receipt chain at receipt-chain: RECEIPT_CHAIN_BROKEN' })
    const incomplete = tiles({ receipts: null, facts: facts({ ...FACTS, evidenceStatus: 'incomplete' }) })
    expect(tile(incomplete, 'receipts')).toMatchObject({ value: '120', tone: 'gold', detail: 'host evidence incomplete' })
    const partial = tiles({ receipts: null, facts: facts({ ...FACTS, receiptsVerified: 118 }) })
    expect(tile(partial, 'receipts')).toMatchObject({ value: '118 of 120', tone: 'gold', detail: 'only 118 of 120 receipts verify' })
  })

  it('a count is never good while the Keys card raises a chain or signer alarm: the strip says NOT VERIFIED with the reason', () => {
    const herOk = { kind: 'verified', merkleRoot: 'ab'.repeat(32), checkpointHash: null, receiptsVerified: 120, checkpointsVerified: 6 }
    const cases: { label: string; body: Record<string, unknown>; receipts: unknown; why: string }[] = [
      { label: 'signer mismatch, host only', body: { ...FACTS, checkpointSignerTrust: 'mismatch' }, receipts: null,
        why: 'checkpoint signer MISMATCH: a key the host’s pin does not name' },
      { label: 'signer pin invalid', body: { ...FACTS, checkpointSignerTrust: 'invalid-pin' }, receipts: null,
        why: 'checkpoint signer pin INVALID: no checkpoint key is checked' },
      { label: 'host chainSigned false', body: { ...FACTS, chainSigned: false }, receipts: null,
        why: 'the host says the signatures or roots over the receipt chain do not verify' },
      { label: 'her verify fresh, host mismatch', body: { ...FACTS, checkpointSignerTrust: 'mismatch' }, receipts: herOk,
        why: 'checkpoint signer MISMATCH: a key the host’s pin does not name' },
      { label: 'her own answer chainSigned false', body: FACTS, receipts: { ...herOk, chainSigned: false },
        why: 'her verifier says the signatures or roots over the receipt chain do not verify' },
    ]
    for (const entry of cases) {
      const read = facts(entry.body)
      const all = tiles({ facts: read, receipts: entry.receipts })
      // The Keys card on the same screen raises its alarm for each of these.
      expect(keysCardOf({ kind: 'reading' }, read, { kind: 'reading' }, entry.receipts).tone, entry.label).toBe('gold')
      for (const id of ['receipts', 'checkpoints'] as const) {
        const count = tile(all, id)
        expect(count, `${entry.label} ${id}`).toMatchObject({ state: 'alarm', value: 'NOT VERIFIED', tone: 'gold', detail: entry.why })
        expect(count.tone).not.toBe('mint')
      }
      expect(durabilityNoteOf(all, englishDurability)).toContain(`Receipts: ${entry.why}`)
    }
    // A rejection outranks the rest and keeps the other reasons beside it.
    const both = tiles({ facts: facts({ ...FACTS, chainSigned: false }), receipts: { kind: 'rejected', stage: 'receipt-chain' } })
    expect(tile(both, 'receipts')).toMatchObject({ value: 'REJECTED', tone: 'red',
      detail: 'her verifier REJECTED the receipt chain at receipt-chain; the host says the signatures or roots over the receipt chain do not verify' })
    // A pinned signer and signed chain stay quiet.
    expect(tile(tiles({ facts: facts({ ...FACTS, chainSigned: true }) }), 'receipts')).toMatchObject({ value: '120', tone: 'mint' })
  })

  it('tile values stay short enough for one clipped line, in English and Chinese; anything longer goes to the note and title', () => {
    const translateZh = (key: keyof typeof zh, params?: Record<string, unknown>) => zh[key].replace(/\{(\w+)\}/gu,
      (match, name: string) => (params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : match))
    const scenarios: Partial<DurabilityInput>[] = [
      {},
      { receiptsStale: true, facts: { kind: 'unavailable', reason: 'answered 503' } },
      { receipts: null, facts: facts({ ...FACTS, evidenceStatus: 'incomplete' }) },
      { receipts: null, facts: facts({ ...FACTS, receiptsVerified: 118 }) },
      { facts: facts({ ...FACTS, checkpointSignerTrust: 'mismatch' }) },
      { receipts: { kind: 'rejected', stage: 'receipt-chain' } },
      { aumlok: { kind: 'live', status: status({ ...AUMLOK_BOUND, passkeyVerified: false }) } },
      { aumlok: { kind: 'live', status: status({ ...AUMLOK_BOUND, blockers: ['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED'] }) } },
      { host: edgeMode(TODAY_UNSUPPORTED.filter(name => name !== COLD_BACKUP_UNSUPPORTED), 'UNVERIFIED') },
      { head: { kind: 'failed', reason: 'answered 503' }, host: { kind: 'unknown', host: 'node.example.invalid', reason: 'down' } },
      { status: { kind: 'ok', body: statusBody({ ...AURA_CALM, status: 'alert', vector: { ...AURA_CALM.vector, driftRisk: 0.4, wakeUrgency: 0.7 },
        recommendedFocus: 'escalate-to-owner', salience: [{ kind: 'handoff-drift', targetId: HEAD, score: 0.4, code: 'epoch-mismatch' }] }) } },
      { status: { kind: 'ok', body: statusBody({ ...AURA_CALM, status: 'strained', vector: { ...AURA_CALM.vector, driftRisk: 0.9 } }) } },
    ]
    for (const scenario of scenarios) {
      for (const entry of durabilityTilesOf({ ...LIVE, ...scenario }, englishDurability)) {
        expect(entry.value.length, `${entry.id}: ${entry.value}`).toBeLessThanOrEqual(13)
        if (entry.detail !== null) expect(entry.title).toContain(entry.detail)
      }
      for (const entry of durabilityTilesOf({ ...LIVE, ...scenario }, translateZh)) {
        const wide = entry.value.match(/[^\u0000-\u00ff]/gu)?.length ?? 0
        expect(wide, `${entry.id}: ${entry.value}`).toBeLessThanOrEqual(5)
      }
    }
  })

  it('reading, and the Mac host: no /api/health there, so the checkout commit is named as the Mac\'s, never GitHub\'s', () => {
    const first = tiles({ head: { kind: 'idle' }, aumlok: { kind: 'reading' }, receipts: null, facts: { kind: 'reading' }, host: { kind: 'reading' },
      status: { kind: 'reading' }, health: { kind: 'reading' } })
    expect(first.every(entry => entry.state === 'reading' && entry.value === 'reading…')).toBe(true)
    const mac = tiles({ host: { kind: 'local', host: '127.0.0.1:3099' }, head: { kind: 'ok', value: { epoch: '12', ballId: HEAD, buildSha: '7c493845' } } })
    expect(tile(mac, 'source')).toMatchObject({ name: 'Mac checkout', value: '7c493845', state: 'live', tone: 'blue' })
    expect(tile(mac, 'cold-backup')).toMatchObject({ state: 'unavailable', detail: 'the Mac host serves no /api/health' })
    expect(tile(mac, 'spend')).toMatchObject({ state: 'unavailable', detail: 'the Mac host serves no /api/health' })
    const macUnknown = tiles({ host: { kind: 'local', host: '127.0.0.1:3099' }, head: { kind: 'ok', value: { epoch: '12', ballId: HEAD, buildSha: 'unknown' } } })
    expect(tile(macUnknown, 'source').state).toBe('unavailable')
  })

  it('every strip key is in both dictionaries, and the surface\'s translator is what names the tiles', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('sovereignty.durability.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) expect(Object.hasOwn(zh, key)).toBe(true)
    const marked = durabilityTilesOf(LIVE, key => `[${key}]`)
    expect(marked.map(entry => entry.name)).toContain('[sovereignty.durability.head]')
  })
})

// The edge's own Aura scorer, loaded from this checkout, so the tile is checked against the rules that score it.
const auraRulesPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/aura-rules.mjs`))
  .find(existsSync)
type AuraRules = { computeAura: (input: Record<string, unknown>) => Record<string, unknown> }
const auraRules = await import(pathToFileURL(auraRulesPath ?? 'server/aura-rules.mjs').href) as AuraRules
const CLEAN_SIGNALS = {
  reachableDagNodes: 3, declaredDagNodes: 3, verifiedReceipts: 120, totalReceipts: 120, activeOrgans: 26, declaredOrgans: 26,
  unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 9, handOffEpochMismatch: false, observedSurpriseScores: [],
  staleHeartbeatRatio: 0, ballId: HEAD, epoch: 12, computedAt: 1,
}
/** What the status route returns for these signals: the scorer's vector, salience and focus inside `aura` (no raw signals). */
const scored = (signals: Record<string, unknown>) => statusBody({ ...AURA_CALM, ...auraRules.computeAura({ ...CLEAN_SIGNALS, ...signals }), status: 'strained' })
const auraTileFor = (body: unknown) => tile(tiles({ status: { kind: 'ok', body } }), 'aura')

describe('Aura drift tile (edge vs HANDOFF.md epoch)', () => {
  it('reads the real scorer: a handoff epoch mismatch is an alarm, and without one the drift risk proves the handoff is in step', () => {
    const mismatch = auraTileFor(scored({ handOffEpochMismatch: true }))
    expect(mismatch).toMatchObject({ state: 'alarm', value: 'HANDOFF≠HEAD', tone: 'red' })
    expect(mismatch.detail).toContain('epoch-mismatch')
    expect(auraTileFor(scored({}))).toMatchObject({ state: 'live', value: 'in step', tone: 'mint' })
    // The proof is the scorer's own arithmetic: a mismatch alone scores 0.4, so any lower drift risk has none.
    const alone = edgeAuraOf(scored({ handOffEpochMismatch: true }))
    expect(alone?.driftRisk).toBeGreaterThanOrEqual(0.4)
    expect(edgeAuraOf(scored({}))?.driftRisk).toBeLessThan(0.4)
  })

  it('escalate-to-owner is an alarm on its own, and both reasons are kept when the handoff also drifts', () => {
    const escalate = auraTileFor(scored({ staleHeartbeatRatio: 1 }))
    expect(escalate).toMatchObject({ state: 'alarm', value: 'ESCALATE', tone: 'red' })
    expect(escalate.detail).toContain('she is asking for you')
    const both = auraTileFor(scored({ staleHeartbeatRatio: 1, handOffEpochMismatch: true }))
    expect(both.value).toBe('HANDOFF≠HEAD')
    expect(both.detail).toContain('epoch-mismatch')
    expect(both.detail).toContain('escalate-to-owner')
  })

  it('a high drift risk whose cause is not among the top three signals is said as undetermined, never as in step', () => {
    const crowded = statusBody({ ...AURA_CALM, status: 'strained', vector: { ...AURA_CALM.vector, driftRisk: 0.5 },
      salience: [{ kind: 'unanchored-claim', targetId: HEAD, score: 0.4, code: 'unanchored-predictions' }] })
    expect(auraTileFor(crowded)).toMatchObject({ state: 'live', value: 'risk 0.50', tone: 'gold' })
    expect(auraTileFor(crowded).detail).toContain('not determined')
  })

  it('incomplete evidence, a missing aura or a failed read show unavailable with the reason, never a state', () => {
    const incomplete = auraTileFor(statusBody({ ...AURA_CALM, status: 'incomplete', vector: null, gaps: ['AURA_HEAD_CHANGED'] }))
    expect(incomplete).toMatchObject({ state: 'unavailable', value: 'unavailable',
      detail: 'her Aura on this host has incomplete evidence (AURA_HEAD_CHANGED)' })
    // A vector with no valid wake urgency, or an Aura that names no head, is not read as a verdict either.
    expect(auraTileFor(statusBody({ ...AURA_CALM, vector: { ...AURA_CALM.vector, wakeUrgency: 'x' } })).state).toBe('unavailable')
    expect(auraTileFor(statusBody({ ...AURA_CALM, epoch: null }))).toMatchObject({ state: 'unavailable',
      detail: 'the Aura names no head it was computed for' })
    expect(auraTileFor({ ok: true, runtime: 'local' })).toMatchObject({ state: 'unavailable', detail: '/__x6/status carries no aukora.aura.v1' })
    expect(tile(tiles({ status: { kind: 'failed', reason: '/__x6/status answered 503' } }), 'aura').detail).toBe('/__x6/status answered 503')
  })

  it('an Aura computed for another head than the HEAD shown is never a verdict about it, and only rules-v1 proves in step', () => {
    // The HEAD tile has moved on (a live commit) while the Aura is still the one read at opening.
    const moved = tiles({ head: { kind: 'ok', value: { epoch: '13', ballId: 'bb'.repeat(32), buildSha: '—' } } })
    expect(tile(moved, 'aura')).toMatchObject({ state: 'live', value: 'other head', tone: 'gold',
      detail: `the Aura was computed for epoch 12 · Pearl ${HEAD.slice(0, 8)}, not the HEAD shown; Refresh reads it again` })
    // Same for an alarm: an old head's mismatch is not said about the new head.
    const oldAlarm = tiles({ head: { kind: 'ok', value: { epoch: '13', ballId: 'bb'.repeat(32), buildSha: '—' } },
      status: { kind: 'ok', body: scored({ handOffEpochMismatch: true }) } })
    expect(tile(oldAlarm, 'aura').value).toBe('other head')
    // Another scorer's numbers prove nothing about HANDOFF.md.
    const other = auraTileFor(statusBody({ ...AURA_CALM, scorer: 'rules-v2' }))
    expect(other).toMatchObject({ value: 'risk 0.00', tone: 'gold', detail: 'scorer rules-v2 is not rules-v1, so the drift risk proves nothing about HANDOFF.md' })
  })

  it('provider window: "not served" until /api/health carries providerUsage, and an unknown shape is never guessed', () => {
    expect(tile(tiles({}), 'spend')).toMatchObject({ state: 'unavailable', value: 'not served', tone: 'muted',
      detail: '/api/health has no providerUsage field yet' })
    const later = tile(tiles({ health: { kind: 'ok', body: { ...healthBody(TODAY_UNSUPPORTED), providerUsage: { anything: 1 } } } }), 'spend')
    expect(later.state).toBe('unavailable')
    expect(later.value).not.toMatch(/\d/u)
  })
})

// The edge's own provider budget code, loaded from this checkout: the tile is checked against the body the edge really
// answers (deploy/cloudflare/src/provider-budget.mjs readProviderBudgetUsage), never a hand-written guess at its shape.
const budgetPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/provider-budget.mjs`)).find(existsSync)
type Budget = {
  readProviderBudgetUsage: (storage: unknown, env: unknown) => Promise<Record<string, unknown>>
  reserveProviderBudget: (storage: unknown, input: unknown, limits: unknown, now: number) => Promise<unknown>
  providerBudgetLimits: (env: unknown) => unknown
}
const budget = await import(pathToFileURL(budgetPath ?? 'deploy/cloudflare/src/provider-budget.mjs').href) as Budget
const BUDGET_ENV = { PROVIDER_BUDGET_WINDOW_MS: '600000', PROVIDER_BUDGET_REQUESTS: '10', PROVIDER_BUDGET_TOKENS: '100000', PROVIDER_MAX_OUTPUT_TOKENS: '8000' }
const T0 = Date.UTC(2026, 10, 11, 1, 0, 0)
const budgetStorage = () => {
  const rows = new Map<string, unknown>()
  return { transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
    get: async (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
  }) }
}
/** `/api/health` as the edge answers it after these reservations (each `[provider, model tokens, when]`). */
const usageAfter = async (reservations: ReadonlyArray<readonly [string, number, number]>, env: unknown = BUDGET_ENV) => {
  const storage = budgetStorage()
  const limits = budget.providerBudgetLimits(BUDGET_ENV)
  for (const [provider, tokens, at] of reservations) await budget.reserveProviderBudget(storage, { provider, tokens }, limits, at)
  return JSON.parse(JSON.stringify(await budget.readProviderBudgetUsage(storage, env))) as Record<string, unknown>
}
const spendFor = (providerUsage: unknown, now: number, extra: Record<string, unknown> = {}) =>
  tile(tiles({ now, health: { kind: 'ok', body: { ...healthBody(TODAY_UNSUPPORTED), providerUsage, ...extra } } }), 'spend')

describe('Aura drift tile reads the host\'s own handOffEpochMismatch when it serves one', () => {
  it('true is the alarm, false is in step in the host\'s word under any scorer, null or absent infers as before', () => {
    expect(edgeAuraOf(statusBody({ ...AURA_CALM, handOffEpochMismatch: true }))?.mismatchSaid).toBe(true)
    expect(edgeAuraOf(statusBody({ ...AURA_CALM, handOffEpochMismatch: null }))?.mismatchSaid).toBeNull()
    expect(edgeAuraOf(statusBody(AURA_CALM))?.mismatchSaid).toBeNull()
    expect(auraTileFor(statusBody({ ...AURA_CALM, handOffEpochMismatch: true }))).toMatchObject({ state: 'alarm', value: 'HANDOFF≠HEAD', tone: 'red' })
    // Said outright, so no proof from the drift risk is needed: a high risk under another scorer is still in step.
    const said = auraTileFor(statusBody({ ...AURA_CALM, scorer: 'rules-v9', vector: { ...AURA_CALM.vector, driftRisk: 0.9 }, handOffEpochMismatch: false }))
    expect(said).toMatchObject({ state: 'live', value: 'in step', tone: 'mint' })
    expect(said.title).toBe('in step: this host reports handOffEpochMismatch false at epoch 12, so HANDOFF.md names that HEAD')
    // A salience entry that says drift still alarms beside a false boolean: either witness is enough.
    expect(auraTileFor(scored({ handOffEpochMismatch: true })).state).toBe('alarm')
    const both = scored({ handOffEpochMismatch: true }) as { aura: Record<string, unknown> }
    expect(auraTileFor({ ...both, aura: { ...both.aura, handOffEpochMismatch: false } }).state).toBe('alarm')
    // Escalate stays an alarm whatever the boolean says, and null falls back to the inference.
    expect(auraTileFor(statusBody({ ...AURA_CALM, recommendedFocus: 'escalate-to-owner', vector: { ...AURA_CALM.vector, wakeUrgency: 0.8 },
      handOffEpochMismatch: false }))).toMatchObject({ state: 'alarm', value: 'ESCALATE' })
    expect(auraTileFor(statusBody({ ...AURA_CALM, handOffEpochMismatch: null }))).toMatchObject({ value: 'in step' })
  })
})

describe('Provider window tile (the edge\'s own reservation window)', () => {
  it('shows the fullest current provider\'s share of its limit, as reserved (never spent), with the numbers in the note', async () => {
    const usage = await usageAfter([['anthropic', 30_000, T0], ['anthropic', 12_000, T0 + 1_000], ['deepseek', 5_000, T0 + 2_000]])
    expect(providerUsageOf({ providerUsage: usage })).toMatchObject({ kind: 'ok', windowMs: 600_000, requestLimit: 10, tokenLimit: 100_000,
      windows: [{ provider: 'anthropic', requests: 2, tokens: 42_000, resetAt: T0 + 600_000 }, { provider: 'deepseek', requests: 1, tokens: 5_000 }] })
    const spend = spendFor(usage, T0 + 60_000)
    expect(spend).toMatchObject({ state: 'live', value: '42% reserved', tone: 'mint' })
    expect(spend.detail).toBe('anthropic: as of this read (01:01:00 UTC), 2 of 10 requests and 42,000 of 100,000 model tokens reserved in the '
      + 'window that resets 01:10:00 UTC. These are conservative reservations the provider door makes before each request it forwards, not '
      + 'billing or exact metering; a request larger than what is left is refused; the edge’s own wake steps call a provider without a '
      + 'reservation and are not counted here. Refresh reads again; others: deepseek 10%')
    // THE TIME OF THE READ, not of the drawing: with no override the tile is judged at the health answer's own time, so it
    // says the same thing however long the page stays open.
    const atRead = (readAt: number) => tile(durabilityTilesOf({ ...LIVE, health: { kind: 'ok', readAt,
      body: { ...healthBody(TODAY_UNSUPPORTED), providerUsage: usage } } }, englishDurability), 'spend')
    expect(atRead(T0 + 60_000).value).toBe('42% reserved')
    // anthropic's window (opened at T0) has ended by then; deepseek's (opened 2 s later) is the one still running.
    expect(atRead(T0 + 600_001).value).toBe('10% reserved')
    expect(atRead(T0 + 700_000).value).toBe('idle')
    expect(`${spend.value} ${String(spend.detail)}`).not.toMatch(/spent|cost|\$/iu)
    // The share is the larger of the two limits: eight requests of ten is 80%, whatever the model tokens say.
    const busy = await usageAfter(Array.from({ length: 8 }, (_unused, index) => ['xai', 10, T0 + index] as const))
    expect(spendFor(busy, T0 + 60_000)).toMatchObject({ value: '80% reserved', tone: 'gold' })
  })

  it('a window the edge would refuse in is EXHAUSTED (red), and one that has ended no longer counts', async () => {
    const full = await usageAfter(Array.from({ length: 10 }, (_unused, index) => ['anthropic', 100, T0 + index] as const))
    const spend = spendFor(full, T0 + 60_000)
    expect(spend).toMatchObject({ state: 'alarm', value: 'EXHAUSTED', tone: 'red' })
    expect(spend.detail).toBe('as of this read (01:01:00 UTC), anthropic has no room left for a model request in its window: the edge refuses '
      + 'its model requests (PROVIDER_BUDGET_EXHAUSTED) until it resets 01:10:00 UTC')
    // The edge's own answer in that window, so "refuses" is the edge's word and not this page's.
    const storage = budgetStorage()
    const limits = budget.providerBudgetLimits(BUDGET_ENV)
    for (let index = 0; index < 10; index += 1) await budget.reserveProviderBudget(storage, { provider: 'anthropic', tokens: 100 }, limits, T0 + index)
    await expect(budget.reserveProviderBudget(storage, { provider: 'anthropic', tokens: 100 }, limits, T0 + 60_000))
      .rejects.toMatchObject({ code: 'PROVIDER_BUDGET_EXHAUSTED' })
    // The edge reads the rows without a clock: after the window's end the same body means nothing is reserved now.
    const after = spendFor(full, T0 + 600_001)
    expect(after).toMatchObject({ state: 'live', value: 'idle', tone: 'mint' })
    expect(after.detail).toBe('as of this read (01:10:00 UTC), no provider request is reserved in a window still running (limit: 10 requests '
      + 'and 100,000 model tokens per provider every 10 min); the edge’s own wake steps are not counted here. Refresh reads again')
    expect(spendFor(await usageAfter([]), T0)).toMatchObject({ value: 'idle' })
    // THE EDGE'S OWN RULE for model tokens: it refuses when the request does not fit, so a window with less room than the
    // smallest request reserves is exhausted, long before "100%".
    expect(PROVIDER_MIN_RESERVATION).toBe(1281)
    const tight = budgetStorage()
    for (const tokens of [50_000, 48_800]) await budget.reserveProviderBudget(tight, { provider: 'xai', tokens }, limits, T0)
    const noRoom = JSON.parse(JSON.stringify(await budget.readProviderBudgetUsage(tight, BUDGET_ENV))) as unknown
    expect(spendFor(noRoom, T0 + 1)).toMatchObject({ state: 'alarm', value: 'EXHAUSTED' })
    await expect(budget.reserveProviderBudget(tight, { provider: 'xai', tokens: PROVIDER_MIN_RESERVATION }, limits, T0 + 1))
      .rejects.toMatchObject({ code: 'PROVIDER_BUDGET_EXHAUSTED' })
    // With room for one more smallest request it is not exhausted yet, and the edge agrees.
    const room = budgetStorage()
    await budget.reserveProviderBudget(room, { provider: 'xai', tokens: 100_000 - PROVIDER_MIN_RESERVATION }, limits, T0)
    expect(spendFor(JSON.parse(JSON.stringify(await budget.readProviderBudgetUsage(room, BUDGET_ENV))) as unknown, T0 + 1).value).toBe('98% reserved')
    await expect(budget.reserveProviderBudget(room, { provider: 'xai', tokens: PROVIDER_MIN_RESERVATION }, limits, T0 + 1)).resolves.toMatchObject({ ok: true })
    // An exhausted provider is named first even when another is fuller by share, and never drawn as a percentage in the list.
    const mixed = await usageAfter([...Array.from({ length: 10 }, (_unused, index) => ['anthropic', 100, T0 + index] as const),
      ['deepseek', 90_000, T0]])
    expect(spendFor(mixed, T0 + 60_000).detail).toContain('anthropic has no room left')
    expect(spendFor(mixed, T0 + 60_000).detail).toContain('others: deepseek 90%')
  })

  it('no budget configured, a null field, and a shape that is not the edge\'s are each said, never drawn as a number', async () => {
    const unconfigured = await usageAfter([], {})
    expect(unconfigured).toMatchObject({ configured: false, limits: null })
    expect(spendFor(unconfigured, T0)).toMatchObject({ state: 'live', value: 'not set', tone: 'gold',
      detail: 'no provider budget is configured on this edge, so it refuses every provider request (PROVIDER_BUDGET_UNCONFIGURED)' })
    expect(spendFor(null, T0)).toMatchObject({ state: 'unavailable', value: 'unavailable',
      detail: 'the edge could not read its provider window this time (providerUsage is null)' })
    const usage = await usageAfter([['anthropic', 30_000, T0]])
    const broken = { ...usage, providers: { anthropic: { requestsReserved: 'many', tokensReserved: 1, windowResetAt: T0 + 1 } } }
    for (const body of [broken, { ...usage, limits: null }, { ...usage, windowMs: 0 }, { configured: 'yes' }, 7]) {
      const spend = spendFor(body, T0)
      expect([spend.state, spend.value]).toEqual(['unavailable', 'unavailable'])
      expect(spend.detail).toBe('/api/health providerUsage is not the shape this screen reads')
    }
  })

  it('every provider-window value fits the tile\'s one clipped line, in English and Chinese', async () => {
    const zhT: typeof englishDurability = (key, params) => zh[key].replace(/\{(\w+)\}/gu, (match, name: string) =>
      (params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : match))
    const full = await usageAfter(Array.from({ length: 10 }, (_unused, index) => ['anthropic', 100, T0 + index] as const))
    const nearly = await usageAfter(Array.from({ length: 9 }, (_unused, index) => ['anthropic', 10_900, T0 + index] as const))
    for (const t of [englishDurability, zhT]) {
      const cases = [[full, T0 + 1], [nearly, T0 + 1], [full, T0 + 700_000], [await usageAfter([], {}), T0], [null, T0]] as const
      for (const [usage, now] of cases) {
        const spend = durabilityTilesOf({ ...LIVE, now, health: { kind: 'ok', body: { ...healthBody(TODAY_UNSUPPORTED), providerUsage: usage } } }, t)
          .find(entry => entry.id === 'spend')
        expect(spend?.value.length).toBeLessThanOrEqual(13)
      }
    }
    // 98,100 of 100,000 is 98% (nine of ten requests is 90%): "100%" is only ever said by EXHAUSTED.
    expect(spendFor(nearly, T0 + 1).value).toBe('98% reserved')
  })
})

describe('Live HEAD tile and /api/health liveHead', () => {
  const NEWER = 'ab'.repeat(32)
  const SEEDED = 'cd'.repeat(32)
  const headWith = (health: Record<string, unknown>, head: DurabilityInput['head'] = LIVE.head) =>
    tile(tiles({ head, health: { kind: 'ok', body: { ...healthBody(TODAY_UNSUPPORTED), ...health } } }), 'head')
  it('reads both heads the health body names, and nothing else as a head', () => {
    expect(healthHeadsOf({ liveHead: { ballId: HEAD, epoch: 12 }, bootstrap: { ready: true, head: { ballId: SEEDED, epoch: 7 } } }))
      .toEqual({ live: { epoch: '12', ballId: HEAD }, bootstrap: { epoch: '7', ballId: SEEDED } })
    expect(healthHeadsOf({ liveHead: { ballId: 'short', epoch: 12 }, bootstrap: {} })).toEqual({ live: null, bootstrap: null })
    expect(healthHeadsOf({ liveHead: { ballId: HEAD, epoch: -1 } }).live).toBeNull()
  })
  it('the same head, an older one, or the seeding-time head never changes what /_head/ball said', () => {
    for (const liveHead of [{ ballId: HEAD, epoch: 12 }, { ballId: SEEDED, epoch: 7 }, null]) {
      expect(headWith({ liveHead, bootstrap: { ready: true, head: { ballId: SEEDED, epoch: 7 } } }))
        .toMatchObject({ state: 'live', value: `12 · ${HEAD.slice(0, 8)}`, tone: 'mint', detail: null })
    }
  })
  it('a newer live head in the same opening\'s health read marks the head shown as behind, until Refresh', () => {
    expect(headWith({ liveHead: { ballId: NEWER, epoch: 13 } })).toMatchObject({ state: 'live', value: `12 · ${HEAD.slice(0, 8)}`, tone: 'gold',
      detail: '/api/health names a newer live head (epoch 13); Refresh reads it' })
  })
  it('the same epoch under another Pearl id is never drawn as agreement', () => {
    expect(headWith({ liveHead: { ballId: NEWER, epoch: 12 } })).toMatchObject({ state: 'live', value: `12 · ${HEAD.slice(0, 8)}`, tone: 'gold',
      detail: '/api/health names another Pearl at this epoch (abababab); Refresh reads both again' })
  })
  it('when /_head/ball did not answer, liveHead is shown only if it is provably not the edge\'s seeding-time fallback', () => {
    const failed: DurabilityInput['head'] = { kind: 'failed', reason: 'answered 503' }
    // The worker answers `bootstrap.head` under the name liveHead when its telemetry read fails (worker.mjs): never shown as live.
    expect(headWith({ liveHead: { ballId: SEEDED, epoch: 7 }, bootstrap: { ready: true, head: { ballId: SEEDED, epoch: 7 } } }, failed))
      .toMatchObject({ state: 'unavailable', value: 'unavailable', detail: '/_head/ball answered 503' })
    expect(headWith({ liveHead: { ballId: HEAD, epoch: 12 }, bootstrap: { ready: true, head: { ballId: SEEDED, epoch: 7 } } }, failed))
      .toMatchObject({ state: 'live', value: `12 · ${HEAD.slice(0, 8)}`, tone: 'gold',
        detail: '/_head/ball answered 503; shown from /api/health liveHead' })
    expect(headWith({}, failed)).toMatchObject({ state: 'unavailable' })
  })
})

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const edgeFetch = (overrides: Record<string, () => Response> = {}) => vi.fn(async (input: string) => {
  if (Object.hasOwn(overrides, input)) return overrides[input]?.() as Response
  if (input === '/__x6/status') return json(statusBody())
  if (input === '/api/health') return json(healthBody(TODAY_UNSUPPORTED))
  if (input === '/__x6/facts') return json(FACTS)
  if (input === '/_host/checkpoint-policy') return json({ ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: [] })
  if (input === '/_host/aumlok/status') return json(AUMLOK_BOUND)
  if (input === '/_head/ball') return json({ ok: true, head: { ballId: HEAD, parentBallId: 'aa'.repeat(32), epoch: 12, entries: {} }, modules: {}, peers: [] })
  if (input === '/_head/runtime') return json({ ok: false, code: 'CLOUD_CAPABILITY_UNAVAILABLE' }, 501)
  if (input === '/_host/wake') return json({ ok: true, enabled: false, intervalMs: 86_400_000, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null, receipts: [] })
  if (input === '/_head/lease') return json({ ok: true, lease: null, ballId: HEAD, epoch: 12 })
  return new Response('nope', { status: 404 })
})
/** The strip lives on the Continuity screen since Wave 5; Sovereignty keeps the approvals, the keys and the receipts. */
const mount = (view: 'continuity' | 'sovereignty' = 'continuity') => {
  const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: view === 'continuity' ? CONTINUITY_SURFACE : SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  return render(view === 'continuity' ? <ContinuitySurface {...props} /> : <SovereigntySurface {...props} />)
}
const strip = (container: HTMLElement) => container.querySelector('[data-sovereignty-durability]')

describe('durability strip on the Continuity surface', () => {
  it('draws the eight tiles from the reads it already makes, above its cards; Sovereignty keeps the keys and the chain', async () => {
    const fetchMock = edgeFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = mount()
    await waitFor(() => { expect(strip(container)?.textContent).toContain(SOURCE.slice(0, 12)) }, { timeout: 10_000 })
    await waitFor(() => { expect(strip(container)?.textContent).toContain('120') }, { timeout: 10_000 })
    const text = strip(container)?.textContent ?? ''
    expect(text).toContain('Durability and continuity')
    expect(text).toContain(`12 · ${HEAD.slice(0, 8)}`)
    expect(text).toContain('bound')
    expect(text).toContain('not built')
    expect(text).toContain('Edge source revision (stamped)')
    expect(text).not.toContain('GitHub')
    expect(text).toContain('in step')
    expect(text).toContain('not served')
    expect(container.querySelectorAll('[data-sovereignty-durability] .ak-stat')).toHaveLength(8)
    // Each value carries its whole text as a title, so nothing it means lives only on the clipped line.
    expect(container.querySelector('[data-durability-tile="head"]')?.getAttribute('title')).toBe(`epoch 12 · Pearl ${HEAD}`)
    expect(container.querySelector('[data-durability-tile="source"]')?.getAttribute('title')).toContain('hand-stamped')
    // No read of its own: the strip asks no route the surface's cards do not already ask (the staged card reads HEAD's
    // own promotion record since Wave 3).
    const asked = new Set(fetchMock.mock.calls.map(([input]) => input))
    expect([...asked].every(path => ['/__x6/status', '/api/health', '/__x6/facts', '/_host/checkpoint-policy', '/_host/aumlok/status',
      '/_head/ball', '/_head/runtime', '/_host/wake', '/_head/lease', '/_head/promotion-status', '/_host/estate'].includes(path))).toBe(true)
    // Continuity draws no approval card, so it reads none of what they need: no promotion status, no lease.
    expect(asked.has('/_head/promotion-status') || asked.has('/_head/lease')).toBe(false)
    // Continuity: the published Pearl, the wake schedule and the host's estate (the one new read, `/_host/estate`).
    const portals = (root: HTMLElement) => [...root.querySelectorAll('[data-sovereignty-portal]')].map(cell => cell.getAttribute('data-sovereignty-portal'))
    expect(portals(container)).toEqual(['head', 'wake', 'estate'])
    expect(container.querySelector('[data-continuity-surface]')?.textContent).toContain('Continuity')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    // Sovereignty holds only what is approved, trusted and receipted: no strip, no Pearl card, no wake.
    cleanup()
    const sovereignty = mount('sovereignty')
    await waitFor(() => { expect(portals(sovereignty.container)).toEqual(['keys', 'chain']) }, { timeout: 10_000 })
    expect(strip(sovereignty.container)).toBeNull()
    expect(sovereignty.container.querySelector('[data-sovereignty-surface]')?.textContent).toContain('Sovereignty')
  }, 30_000)

  it('every route failing: the strip shows "unavailable" in every tile and no number', async () => {
    const down = () => json({ ok: false, code: 'CLOUD_REQUEST_FAILED' }, 503)
    vi.stubGlobal('fetch', edgeFetch(Object.fromEntries(['/__x6/status', '/api/health', '/__x6/facts', '/_host/aumlok/status', '/_head/ball']
      .map(path => [path, down]))))
    const { container } = mount()
    await waitFor(() => {
      const values = [...container.querySelectorAll('[data-sovereignty-durability] .ak-stat__value')].map(node => node.textContent)
      expect(values).toEqual(Array.from({ length: 8 }, () => 'unavailable'))
    }, { timeout: 10_000 })
    expect(container.querySelector('[data-sovereignty-durability-note]')?.textContent).toContain('Not read:')
  }, 30_000)
})
