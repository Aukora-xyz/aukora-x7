import { sha256HexSync } from '../module-system/module-loader.ts'

const WINDOW_MS = 12 * 60 * 60 * 1000
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** Reserve before activation; missing or mismatched authority never permits a local promotion. */
export async function reserveIdPromotionBudget(input: {
  expectedBallId: string
  organId: string
  candidateSha: string
  writerLease: { ownerPeerId: string; generation: number } | null
}, request: (body: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const { expectedBallId, organId, candidateSha, writerLease } = input
  if (!writerLease || !Number.isSafeInteger(writerLease.generation) || writerLease.generation < 1
    || typeof writerLease.ownerPeerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(writerLease.ownerPeerId)
    || !/^[a-f0-9]{64}$/.test(expectedBallId) || !/^[a-f0-9]{64}$/.test(candidateSha)
    || !/^[a-z][a-z0-9-]{0,63}$/.test(organId)) throw new Error('ID_PROMOTION_AUTHORITY_REQUIRED')
  const operationId = sha256HexSync(JSON.stringify({ candidateSha, expectedBallId, organId, schema: 'aukora.id-promotion-operation.v1' }))
  let reply: unknown
  try {
    reply = await request({ action: 'reserve-id-promotion', ownerPeerId: writerLease.ownerPeerId,
      generation: writerLease.generation, expectedBallId, organId, candidateSha })
  } catch (error) {
    if (error instanceof Error && error.message === 'ID_PROMOTION_AUTHORITY_MISSING') {
      throw new Error('ID_PROMOTION_AUTHORITY_MISSING: Ordinary id-promotions are paused until the owner approves a Class 3 publication by passkey.',
        { cause: error })
    }
    if (error instanceof Error && /^ID_PROMOTION_[A-Z_]+$/.test(error.message)) throw error
    throw new Error('ID_PROMOTION_AUTHORITY_UNAVAILABLE', { cause: error })
  }
  if (!record(reply) || reply.ok !== true || reply.operationId !== operationId || reply.expectedBallId !== expectedBallId
    || reply.organId !== organId || reply.candidateSha !== candidateSha || reply.limit !== 12 || reply.windowMs !== WINDOW_MS
    || !Number.isSafeInteger(reply.used) || Number(reply.used) < 1 || Number(reply.used) > 12
    || typeof reply.idempotent !== 'boolean' || !time(reply.reservedAt) || !time(reply.authorityNow) || !time(reply.expiresAt)
    || reply.expiresAt !== reply.reservedAt + WINDOW_MS || reply.authorityNow < reply.reservedAt
    || reply.authorityNow >= reply.expiresAt) throw new Error('ID_PROMOTION_AUTHORITY_INVALID')
}
