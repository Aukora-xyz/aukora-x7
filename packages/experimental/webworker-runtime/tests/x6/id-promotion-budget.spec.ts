import { describe, expect, it, vi } from 'vitest'
import { reserveIdPromotionBudget } from '../../src/x6/id-promotion-budget.ts'
import { idPromotionBudgetReply } from './id-promotion-budget-fixture.ts'

const input = { expectedBallId: 'a'.repeat(64), organId: 'seed-target', candidateSha: 'b'.repeat(64),
  writerLease: { ownerPeerId: 'fixture', generation: 1 } }
const reply = async (): Promise<Record<string, unknown>> => {
  const result: unknown = await idPromotionBudgetReply({ ...input, action: 'reserve-id-promotion' })!.json()
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('invalid fixture')
  return result as Record<string, unknown>
}

describe('id promotion authority acknowledgement', () => {
  it.each([false, true])('accepts an exact active reservation (retry=%s)', async (idempotent) => {
    const request = vi.fn(async () => ({ ...await reply(), idempotent }))
    await expect(reserveIdPromotionBudget(input, request)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith({ action: 'reserve-id-promotion', ownerPeerId: 'fixture', generation: 1,
      expectedBallId: input.expectedBallId, organId: input.organId, candidateSha: input.candidateSha })
  })
  it.each([
    ['ok', false], ['operationId', 'c'.repeat(64)], ['expectedBallId', 'c'.repeat(64)],
    ['organId', 'other'], ['candidateSha', 'c'.repeat(64)], ['limit', 13], ['windowMs', 1],
    ['used', 0], ['used', 13], ['used', 1.5], ['used', '1'], ['idempotent', null],
    ['reservedAt', -1], ['authorityNow', 0], ['expiresAt', 0],
  ])('refuses malformed %s=%s', async (key, value) => {
    await expect(reserveIdPromotionBudget(input, async () => ({ ...await reply(), [String(key)]: value })))
      .rejects.toThrow('ID_PROMOTION_AUTHORITY_INVALID')
  })
  it('refuses an expired reservation using the authority clock', async () => {
    const result = await reply()
    await expect(reserveIdPromotionBudget(input, async () => ({ ...result, authorityNow: result.expiresAt })))
      .rejects.toThrow('ID_PROMOTION_AUTHORITY_INVALID')
  })
  it.each([null, undefined, [], true, { ok: true }])('refuses missing authority %s', async (result) => {
    await expect(reserveIdPromotionBudget(input, async () => result)).rejects.toThrow('ID_PROMOTION_AUTHORITY_INVALID')
  })
  it('preserves an authority limit refusal and normalizes transport failures', async () => {
    await expect(reserveIdPromotionBudget(input, () => Promise.reject(Error('ID_PROMOTION_LIMIT'))))
      .rejects.toThrow('ID_PROMOTION_LIMIT')
    await expect(reserveIdPromotionBudget(input, () => Promise.reject(Error('transport data'))))
      .rejects.toThrow('ID_PROMOTION_AUTHORITY_UNAVAILABLE')
  })
  it('never requests a slot without a writer lease', async () => {
    const request = vi.fn()
    await expect(reserveIdPromotionBudget({ ...input, writerLease: null }, request))
      .rejects.toThrow('ID_PROMOTION_AUTHORITY_REQUIRED')
    expect(request).not.toHaveBeenCalled()
  })
  it('names the owner initialization step when durable authority is missing', async () => {
    await expect(reserveIdPromotionBudget(input, () => Promise.reject(Error('ID_PROMOTION_AUTHORITY_MISSING'))))
      .rejects.toThrow('Ordinary id-promotions are paused until the owner approves a Class 3 publication by passkey.')
  })

})
