// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * HER PROMOTION RECEIPTS, AS SOVEREIGNTY LISTS THEM (Wave 7). Her receipt ledger (`/dsh/home/auma/seed/receipts.v3.jsonl`,
 * one JSON leaf per line) can hold TWO leaves for one promotion: a provisional one her worker wrote before the passkey
 * (`hasApprovalToken: false`), and the authoritative one written when HEAD took the owner's Touch ID (`hasApprovalToken: true`).
 * They are one promotion, not two. This is the same rule her worker's estate tool applies
 * (`packages/experimental/webworker-runtime/src/x6/browser-estate.ts`, `supersededByAuthoritative`): a leaf without the
 * token is superseded once a leaf WITH the token exists for the same epoch or the same Pearl. A superseded leaf is not
 * drawn as a promotion; the authoritative row says how many provisional records it replaces.
 *
 * Pure: it reads text and returns rows. It verifies nothing (the chain's hashes and signatures are the Receipt chain
 * card's own rows); a line that is not a promotion leaf is skipped.
 * @module portal/promotion-receipts
 */
export const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
/** The most ledger text this page reads for the list (8 MiB); a larger ledger is said as too large, never half read. */
export const RECEIPTS_MAX_CHARS = 8 * 1024 * 1024
/** How many promotions the card lists, newest first. */
export const PROMOTIONS_SHOWN = 8

export interface PromotionReceipt {
  readonly seq: number | null
  readonly epoch: number | null
  readonly ballId: string | null
  readonly entryId: string | null
  readonly tier: string | null
  readonly hasApprovalToken: boolean
  /** A provisional leaf for which an authoritative (token) leaf exists: the same epoch, or the same Pearl. */
  readonly supersededByAuthoritative: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null)
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * Read the promotion leaves of a ledger, in ledger order, each marked when an authoritative leaf supersedes it.
 * @param ledger - the ledger text (JSON lines).
 * @returns the leaves, or null when the ledger is larger than this page reads.
 */
export function promotionReceiptsOf(ledger: string): readonly PromotionReceipt[] | null {
  if (ledger.length > RECEIPTS_MAX_CHARS) return null
  const leaves: Omit<PromotionReceipt, 'supersededByAuthoritative'>[] = []
  for (const line of ledger.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (!isRecord(parsed) || (parsed.kind !== 'head.promote' && parsed.kind !== 'ball.promote') || !isRecord(parsed.data)) continue
    const data = parsed.data
    leaves.push({ seq: whole(parsed.seq), epoch: whole(data.epoch), ballId: text(data.ballId), entryId: text(data.entryId),
      tier: text(data.tier), hasApprovalToken: data.hasApprovalToken === true })
  }
  const same = (a: typeof leaves[number], b: typeof leaves[number]): boolean =>
    (a.epoch !== null && a.epoch === b.epoch) || (a.ballId !== null && a.ballId === b.ballId)
  return leaves.map(leaf => ({ ...leaf,
    supersededByAuthoritative: !leaf.hasApprovalToken && leaves.some(other => other.hasApprovalToken && same(other, leaf)) }))
}

/** One promotion as the card draws it: the leaf that stands for it, and the provisional leaves it replaces. */
export interface PromotionRow {
  readonly receipt: PromotionReceipt
  readonly replaces: number
}

/**
 * The promotions to draw, newest first: every leaf that is NOT superseded, each with the count of provisional leaves its
 * authoritative record replaces. A superseded leaf is never a row of its own.
 * @param receipts - the leaves, in ledger order.
 * @param shown - how many to return.
 * @returns the rows.
 */
export function promotionRowsOf(receipts: readonly PromotionReceipt[], shown: number = PROMOTIONS_SHOWN): readonly PromotionRow[] {
  const superseded = receipts.filter(receipt => receipt.supersededByAuthoritative)
  const rows = receipts.filter(receipt => !receipt.supersededByAuthoritative).map((receipt): PromotionRow => ({ receipt,
    replaces: !receipt.hasApprovalToken ? 0 : superseded.filter(other => (other.epoch !== null && other.epoch === receipt.epoch)
      || (other.ballId !== null && other.ballId === receipt.ballId)).length }))
  return rows.slice(-shown).reverse()
}

/** The one line for a promotion row. */
export function promotionWords(row: PromotionRow): string {
  const { receipt, replaces } = row
  const how = receipt.hasApprovalToken ? 'approved with Touch ID' : 'no Touch ID on this record'
  const tier = receipt.tier === null ? '' : ` · ${receipt.tier}`
  const folded = replaces === 0 ? '' : ` · supersedes ${String(replaces)} provisional record${replaces === 1 ? '' : 's'} of the same promotion`
  return `${how}${tier}${folded}`
}
