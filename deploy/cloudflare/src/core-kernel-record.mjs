import { coreSha256, readAckHead } from './core-ack-head.mjs'

export const CORE_RECORD_SCHEMA = 'auma.kernel.v1'
export const coreId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export async function projectCoreRecord(source) {
  const head = readAckHead(source?.head)
  if (head === null || !coreId(source?.threadId) || !coreId(source?.chain) ||
      typeof source.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(source.sourceRevision)) return null
  // Hash only a fixed scalar shape and order, not arbitrary source JSON.
  const record = { schema: CORE_RECORD_SCHEMA, sourceRevision: source.sourceRevision,
    threadId: source.threadId, chain: source.chain, head }
  return { fingerprint: await coreSha256(CORE_RECORD_SCHEMA, JSON.stringify(record)), record }
}
