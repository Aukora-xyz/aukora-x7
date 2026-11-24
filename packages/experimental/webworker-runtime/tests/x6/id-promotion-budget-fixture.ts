import { sha256HexSync } from '../../src/module-system/module-loader.ts'

/** Explicit authority stand-in for activation fixtures, not evidence of durable enforcement. */
export function idPromotionBudgetReply(input: unknown): Response | null {
  if (!input || typeof input !== 'object' || !('action' in input) || input.action !== 'reserve-id-promotion') return null
  const fields = input as Record<string, unknown>
  const { candidateSha, expectedBallId, organId } = fields
  const reservedAt = Date.now()
  return Response.json({ ok: true, candidateSha, expectedBallId, organId,
    operationId: sha256HexSync(JSON.stringify({ candidateSha, expectedBallId, organId, schema: 'aukora.id-promotion-operation.v1' })),
    used: 1, limit: 12, windowMs: 43_200_000, reservedAt, authorityNow: reservedAt,
    expiresAt: reservedAt + 43_200_000, retryAt: reservedAt + 43_200_000, idempotent: false })
}
