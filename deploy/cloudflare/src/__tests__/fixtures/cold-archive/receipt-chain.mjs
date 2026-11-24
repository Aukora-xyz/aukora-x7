/** Fixed synthetic receipt history; checkpoint signing keys exist only for each test invocation. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson } from '../../../owner-grant-policy.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest()
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

function merkleRoot(receipts) {
  let level = receipts.map(row => Buffer.from(row.leafHash, 'hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? hash(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]]))
        : level[i])
    }
    level = next
  }
  return level[0].toString('hex')
}

/**
 * Build 87 deterministic receipts and six signed prefix checkpoints without reading an owner's home.
 * @returns {{ receiptsText: string, checkpointsText: string }} In-memory JSONL files for the archive mirror.
 */
export function createReceiptChainFixture() {
  const receipts = []
  let prevHash = '0'.repeat(64)
  for (let seq = 1; seq <= 87; seq++) {
    const payload = {
      schema: 'aukora.receipt.v3', seq, at: '2026-01-01T00:00:00.000Z',
      kind: 'synthetic.cold-archive', prevHash, data: { message: `Test receipt ${seq}` },
    }
    const leafHash = hash(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))])).toString('hex')
    receipts.push({ ...payload, leafHash })
    prevHash = leafHash
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const checkpoints = []
  for (const receiptCount of [1, 16, 32, 48, 64, 87]) {
    const body = {
      schema: 'aukora.edge-checkpoint.v1', seq: checkpoints.length + 1, at: '2026-01-01T00:00:00.000Z',
      receiptCount, lastReceiptHash: receipts[receiptCount - 1].leafHash,
      merkleRoot: merkleRoot(receipts.slice(0, receiptCount)),
      prevCheckpointHash: checkpoints.at(-1)?.checkpointHash ?? null,
    }
    const signatureHex = sign(null, Buffer.from('aukora.x5.edge-head.v1\0' + canonicalJson(body)), privateKey).toString('hex')
    const checkpoint = { body, publicKeyHex, signatureHex }
    checkpoints.push({ ...checkpoint, checkpointHash: hash(canonicalJson(checkpoint)).toString('hex') })
  }
  return { receiptsText: jsonl(receipts), checkpointsText: jsonl(checkpoints) }
}
