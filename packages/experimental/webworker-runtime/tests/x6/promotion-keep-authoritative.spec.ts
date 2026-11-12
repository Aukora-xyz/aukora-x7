/**
 * Lane E5 task 2: promotion receipts dedupe keep-authoritative. Leaves are append-only and dedupe on (epoch, ballId); a
 * provisional `hasApprovalToken: false` leaf (for example one written by a pre-E4 local writer for a governance epoch) must
 * never block or outrank the authoritative `hasApprovalToken: true` leaf for the same head (Auma's Wave 5 red-team
 * finding). Proven against the real seed-receipts organ in an in-memory VFS.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  createSerializedPromotionReceiptAppender, planIdempotentRetroReceipts, promotionReceiptBlocks, promotionReceiptStatus,
  parseReceiptsJsonlForPromotion, selectAuthoritativePromotion,
} from '../../src/x6/ball-loader.ts'

const requireFromHere = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const head = { epoch: 169, ballId: 'c'.repeat(64), parentBallId: 'd'.repeat(64), entries: { 'seed-pearl': { specifier: 'ball:' + 'e'.repeat(64) } } }
const leaf = (data: Record<string, unknown>) => JSON.stringify({ schema: 'aukora.receipt.v3', kind: 'head.promote', data }) + '\n'
const provisional = { entryId: 'seed-pearl', ballId: head.ballId, parentBallId: head.parentBallId, epoch: 169, tier: 'T1', hasApprovalToken: false }
const authoritative = { ...provisional, tier: 'T2', hasApprovalToken: true }

function organHarness() {
  const code = readFileSync(path.join(REPO_ROOT, 'mirror/home/auma/seed/organs/seed-receipts.js'), 'utf8')
  const mod = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', code)(requireFromHere, mod, mod.exports)
  const organ = mod.exports as { run: (args: Record<string, unknown>, ctx: { fs: MemoryVfs }) => Promise<Record<string, unknown>> }
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
  const read = () => vfs.existsSync(RECEIPTS) ? vfs.readFileSync(RECEIPTS, 'utf8') as string : ''
  const leaves = () => read().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; data: Record<string, unknown> })
  return { organ, vfs, read, leaves }
}

describe('keep-authoritative promotion dedupe', () => {
  it('status distinguishes provisional, authoritative and historical leaves', () => {
    const rows = (text: string) => parseReceiptsJsonlForPromotion(text).promoteReceipts
    expect(promotionReceiptStatus(rows(''), 169, head.ballId)).toBe('none')
    expect(promotionReceiptStatus(rows(leaf(provisional)), 169, head.ballId)).toBe('provisional')
    expect(promotionReceiptStatus(rows(leaf(provisional) + leaf(authoritative)), 169, head.ballId)).toBe('authoritative')
    expect(promotionReceiptStatus(rows(leaf({ epoch: 169, ballId: head.ballId })), 169, head.ballId)).toBe('recorded')
    expect(promotionReceiptBlocks(leaf(provisional), 169, head.ballId, authoritative)).toBe(false)
    expect(promotionReceiptBlocks(leaf(provisional), 169, head.ballId, provisional)).toBe(true)
    expect(promotionReceiptBlocks(leaf(authoritative), 169, head.ballId, authoritative)).toBe(true)
    // A retroactive or historical leaf never takes the supersede path, and an unreadable log always blocks.
    expect(promotionReceiptBlocks(leaf(provisional), 169, head.ballId, { ...authoritative, retroactive: true })).toBe(true)
    expect(promotionReceiptBlocks(leaf({ epoch: 169, ballId: head.ballId }), 169, head.ballId, authoritative)).toBe(true)
    expect(promotionReceiptBlocks('{not json\n', 169, head.ballId, authoritative)).toBe(true)
  })

  it('the cold-boot planner records the consumed approval over a provisional leaf, once', () => {
    const plan = (existing: string, hasApprovalToken: boolean) => planIdempotentRetroReceipts({
      currentBall: head, existingReceiptsText: existing, persistenceReady: true, chainVerified: true,
      lastPublishOutcome: { ok: true, resultingBallId: head.ballId, resultingEpoch: 169, hasApprovalToken }, changedEntriesHint: ['seed-pearl'],
    }).filter(candidate => candidate.epoch === 169)
    const upgraded = plan(leaf(provisional), true)
    expect(upgraded).toHaveLength(1)
    expect(upgraded[0]!.data).toMatchObject({ tier: 'T2', hasApprovalToken: true, adopted: true, supersedesProvisional: true })
    expect(plan(leaf(provisional), false)).toEqual([])
    expect(plan(leaf(provisional) + leaf(authoritative), true)).toEqual([])
    expect(plan(leaf({ epoch: 169, ballId: head.ballId }), true)).toEqual([])
    expect(plan('', true)[0]!.data).not.toHaveProperty('supersedesProvisional')
  })

  it('end to end with seed-receipts: provisional then authoritative lands both; later writers of either kind dedupe', async () => {
    const { organ, vfs, read, leaves } = organHarness()
    const append = createSerializedPromotionReceiptAppender({ readReceiptsJsonl: read,
      appendReceipt: async (kind, data) => await organ.run({ action: 'append', kind, data }, { fs: vfs }) as { ok?: boolean } })
    expect(await append({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: provisional })).toEqual({ ok: true, deduplicated: false })
    expect(await append({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: provisional })).toEqual({ ok: true, deduplicated: true })
    expect(await append({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: authoritative })).toEqual({ ok: true, deduplicated: false })
    expect(await append({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: authoritative })).toEqual({ ok: true, deduplicated: true })
    expect(await append({ kind: 'ball.promote', epoch: 169, ballId: head.ballId, data: provisional })).toEqual({ ok: true, deduplicated: true })
    const promotions = leaves().filter(item => item.kind === 'head.promote')
    expect(promotions.map(item => [item.data.tier, item.data.hasApprovalToken, item.data.supersedesProvisional ?? null]))
      .toEqual([['T1', false, null], ['T2', true, true]])
    expect((await organ.run({ action: 'verify' }, { fs: vfs })).ok).toBe(true)
    expect(selectAuthoritativePromotion(read(), 169, head.ballId)).toMatchObject({ index: 1, matching: 2, provisionalSuperseded: true,
      data: { tier: 'T2', hasApprovalToken: true } })
  })

  it('a fresh appender (restart) over a provisional log, and an appender whose log read lags, both admit the authoritative leaf', async () => {
    const emitted: Record<string, unknown>[] = []
    const restarted = createSerializedPromotionReceiptAppender({ readReceiptsJsonl: () => leaf(provisional),
      appendReceipt: async (_kind, data) => { emitted.push(data); return { ok: true } } })
    expect(await restarted({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: provisional })).toEqual({ ok: true, deduplicated: true })
    expect(await restarted({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: authoritative })).toEqual({ ok: true, deduplicated: false })
    expect(emitted).toEqual([{ ...authoritative, supersedesProvisional: true }])
    const lagging: Record<string, unknown>[] = []
    const stale = createSerializedPromotionReceiptAppender({ readReceiptsJsonl: () => '',
      appendReceipt: async (_kind, data) => { lagging.push(data); return { ok: true } } })
    await stale({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: provisional })
    expect(await stale({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: authoritative })).toEqual({ ok: true, deduplicated: false })
    expect(await stale({ kind: 'head.promote', epoch: 169, ballId: head.ballId, data: authoritative })).toEqual({ ok: true, deduplicated: true })
    expect(lagging.map(data => data.hasApprovalToken)).toEqual([false, true])
  })

  it('a provisional leaf never outranks an authoritative one, whatever the order', () => {
    expect(selectAuthoritativePromotion(leaf(authoritative) + leaf(provisional), 169, head.ballId))
      .toMatchObject({ index: 0, data: { hasApprovalToken: true }, provisionalSuperseded: true })
    expect(selectAuthoritativePromotion(leaf(provisional), 169, head.ballId))
      .toMatchObject({ index: 0, data: { hasApprovalToken: false }, provisionalSuperseded: false })
    expect(selectAuthoritativePromotion('', 169, head.ballId)).toBeNull()
  })
})
