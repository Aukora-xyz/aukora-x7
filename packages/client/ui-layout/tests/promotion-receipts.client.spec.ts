/**
 * Wave 7, Sovereignty: a provisional promotion leaf that an authoritative (Touch ID) leaf supersedes is one promotion
 * with it, never a second promotion row. The rule is her worker's own (browser-estate.ts `supersededByAuthoritative`).
 */
import { describe, expect, it } from 'vitest'
import { promotionReceiptsOf, promotionRowsOf, promotionWords, RECEIPTS_MAX_CHARS } from '../src/client/spatial/portal/promotion-receipts.ts'

const leaf = (seq: number, data: Record<string, unknown>, kind = 'head.promote') => JSON.stringify({ seq, kind, prevHash: 'x', leafHash: 'y', data })
const BALL_68 = '79fd695c'.padEnd(64, '0')
const BALL_69 = '688d831c'.padEnd(64, '0')

describe('Sovereignty: promotion receipts', () => {
  const ledger = [
    leaf(130, { epoch: 167, ballId: 'a'.repeat(64), entryId: 'seed-voice-slot', tier: 'T1', hasApprovalToken: false }),
    leaf(137, { epoch: 168, ballId: BALL_68, entryId: 'seed-continuity', tier: 'T1', hasApprovalToken: false }),
    JSON.stringify({ seq: 138, kind: 'wake.tick', data: { epoch: 168 } }),
    leaf(139, { epoch: 168, ballId: BALL_68, entryId: 'seed-continuity', tier: 'T2', hasApprovalToken: true, adopted: true }),
    'not json at all',
    leaf(141, { ballId: BALL_69, entryId: 'seed-pearl', tier: 'T1', hasApprovalToken: false }),
    leaf(142, { epoch: 169, ballId: BALL_69, entryId: 'seed-pearl', tier: 'T2', hasApprovalToken: true }),
    leaf(150, { epoch: 170, ballId: 'b'.repeat(64), entryId: 'seed-repo-forge', tier: 'T1', hasApprovalToken: false }, 'ball.promote'),
  ].join('\n')

  it('marks a provisional leaf superseded when a Touch ID leaf exists for the same epoch or the same Pearl', () => {
    const leaves = promotionReceiptsOf(ledger) ?? []
    expect(leaves.map(row => [row.seq, row.hasApprovalToken, row.supersededByAuthoritative])).toEqual([
      [130, false, false], [137, false, true], [139, true, false], [141, false, true], [142, true, false], [150, false, false]])
  })

  it('draws one row per promotion, newest first: the authoritative record, saying what it supersedes', () => {
    const rows = promotionRowsOf(promotionReceiptsOf(ledger) ?? [])
    // Six leaves, four promotions: epochs 168 and 169 are ONE row each, not two.
    expect(rows.map(row => [row.receipt.epoch, row.receipt.seq, row.replaces]))
      .toEqual([[170, 150, 0], [169, 142, 1], [168, 139, 1], [167, 130, 0]])
    expect(promotionWords(rows[1] as never)).toBe('approved with Touch ID · T2 · supersedes 1 provisional record of the same promotion')
    expect(promotionWords(rows[0] as never)).toBe('no Touch ID on this record · T1')
    expect(rows.some(row => row.receipt.supersededByAuthoritative)).toBe(false)
    expect(promotionRowsOf(promotionReceiptsOf(ledger) ?? [], 2).map(row => row.receipt.epoch)).toEqual([170, 169])
  })

  it('a provisional leaf with no authoritative record stays a row of its own; an oversize ledger is not half read', () => {
    const alone = promotionRowsOf(promotionReceiptsOf(leaf(1, { epoch: 171, ballId: 'c'.repeat(64), hasApprovalToken: false })) ?? [])
    expect(alone.map(row => [row.receipt.epoch, row.replaces])).toEqual([[171, 0]])
    // Leaves that name neither an epoch nor a Pearl never match each other.
    const nameless = promotionReceiptsOf([leaf(1, { hasApprovalToken: false }), leaf(2, { hasApprovalToken: true })].join('\n')) ?? []
    expect(nameless.map(row => row.supersededByAuthoritative)).toEqual([false, false])
    expect(promotionReceiptsOf('x'.repeat(RECEIPTS_MAX_CHARS + 1))).toBeNull()
    expect(promotionReceiptsOf('')).toEqual([])
  })
})
