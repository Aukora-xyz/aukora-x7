import { describe, expect, it } from 'vitest'
// @ts-expect-error The cloud mirror is plain ESM without declarations; only its frozen limits are read here.
import { MIRROR_LIMITS, mirrorPathExcluded } from '../../../../../deploy/cloudflare/src/mirror-do.mjs'
import { CLOUD_MIRROR_LIMITS, snapshotDumpExcluded } from '../../src/storage/idb-persist.ts'

describe('browser cloud outbox and cloud mirror share one set of limits', () => {
  it('admits exactly what the mirror Durable Object admits', () => {
    const cloud = MIRROR_LIMITS as Record<string, number>
    expect(CLOUD_MIRROR_LIMITS).toEqual({
      requestBytes: cloud.requestBytes, entries: cloud.batchEntries, fileBytes: cloud.fileBytes, snapshotBytes: cloud.snapshotBytes,
    })
  })

  it('fits the largest admissible file, base64-encoded with its envelope, into one request', () => {
    const encoded = Math.ceil(CLOUD_MIRROR_LIMITS.fileBytes / 3) * 4
    const envelope = new TextEncoder().encode(JSON.stringify({
      v: 2, digest: 'f'.repeat(64),
      batch: { clientId: 'f'.repeat(36), seq: Number.MAX_SAFE_INTEGER, id: `${'f'.repeat(36)}:${String(Number.MAX_SAFE_INTEGER)}`,
        cloudBase: { revision: Number.MAX_SAFE_INTEGER, digest: 'f'.repeat(64) },
        entries: [[`/dsh/home/${'p'.repeat(4000)}`, { kind: 'file', b64: '', mode: 0o644, mtimeMs: Number.MAX_SAFE_INTEGER }]] },
    })).byteLength
    expect(encoded + envelope).toBeLessThanOrEqual(CLOUD_MIRROR_LIMITS.requestBytes)
  })

  it('drops the same snapshot dumps as mirrorPathExcluded and keeps LATEST.json', () => {
    const exclude = mirrorPathExcluded as (path: string) => boolean
    for (const path of [
      '/dsh/home/auma/snapshots/d3620ad73f50553db7d3d967b97701023316ec29ebc858020e9915e2c7a2cd79.json',
      '/dsh/home/auma/snapshots/nested/again.json',
      '/dsh/home/auma/snapshots/LATEST.json',
      '/dsh/home/auma/snapshots',
      '/dsh/home/auma/snapshots-elsewhere/x.json',
      '/dsh/home/auma/seed/receipts.v3.jsonl',
    ]) expect([path, snapshotDumpExcluded(path)]).toEqual([path, exclude(path)])
  })
})
