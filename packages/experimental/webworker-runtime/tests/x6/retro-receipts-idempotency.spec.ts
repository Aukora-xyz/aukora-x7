import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  createSerializedPromotionReceiptAppender,
  hasPromotionReceiptInJsonl,
  planIdempotentRetroReceipts,
} from '../../src/x6/ball-loader.ts'

const requireFromHere = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const SEED_RECEIPTS_PATH = path.join(REPO_ROOT, 'mirror/home/auma/seed/organs/seed-receipts.js')

function loadSeedReceiptsOrgan(): {
  run: (args: Record<string, unknown>, ctx: { fs: MemoryVfs }) => Promise<Record<string, unknown>>
} {
  const code = readFileSync(SEED_RECEIPTS_PATH, 'utf8')
  const mod = { exports: {} as Record<string, unknown> }
  const fn = new Function('require', 'module', 'exports', code)
  fn(requireFromHere, mod, mod.exports)
  return mod.exports as {
    run: (args: Record<string, unknown>, ctx: { fs: MemoryVfs }) => Promise<Record<string, unknown>>
  }
}

describe('ensureRetroPromotionReceipts strict cold-boot idempotency (C1)', () => {
  const laterBall = {
    epoch: 167,
    ballId: 'ead2e32f5fbe169cdc751ccd575225c4735332fd5b0e76acdf8445bd313d91be',
    parentBallId: '0d8a2461e922bbe3d88f2ae01d451c7cb224d9ab6daccb6f6c13ff70dcd7af0',
    entries: {
      'seed-pearl': { specifier: 'ball:3f990d30355989282f489f25c200b75caba33864ffdbf5e16fdc45ac1323788c' },
      'seed-recall': { specifier: 'ball:7af77b062d261473a60a216aef97cbc6d19c8a22b237ba24d33d45f2d9e43758' },
    },
  }

  it('produces identical receipt count and frozen Merkle root across repeated cold boots', async () => {
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
    const organ = loadSeedReceiptsOrgan()
    const receiptsPath = '/dsh/home/auma/seed/receipts.v3.jsonl'

    const simulateBootReconciliation = async (lastPublishOutcome: {
      ok?: boolean
      resultingBallId?: string | null
      resultingEpoch?: number | null
      hasApprovalToken?: boolean
    } | null): Promise<{ recovered: string[]; merkleRoot: string; totalReceipts: number }> => {
      const verifyBefore = await organ.run({ action: 'verify' }, { fs: vfs })
      expect(verifyBefore.ok).toBe(true)
      const rawText = vfs.existsSync(receiptsPath) ? (vfs.readFileSync(receiptsPath, 'utf8') as string) : ''
      const planned = planIdempotentRetroReceipts({
        currentBall: laterBall,
        existingReceiptsText: rawText,
        persistenceReady: true,
        chainVerified: verifyBefore.ok === true,
        cloudTotalReceipts: rawText ? rawText.trim().split('\n').length : 0,
        lastPublishOutcome,
        changedEntriesHint: ['seed-recall'],
      })
      const recovered: string[] = []
      for (const candidate of planned) {
        const latest = vfs.existsSync(receiptsPath) ? (vfs.readFileSync(receiptsPath, 'utf8') as string) : ''
        if (hasPromotionReceiptInJsonl(latest, candidate.epoch, candidate.ballId)) continue
        const appended = await organ.run({
          action: 'append',
          kind: 'head.promote',
          data: candidate.data,
        }, { fs: vfs })
        expect(appended.ok).toBe(true)
        recovered.push(candidate.label)
      }
      const verifyAfter = await organ.run({ action: 'verify' }, { fs: vfs })
      expect(verifyAfter.ok).toBe(true)
      return {
        recovered,
        merkleRoot: String(verifyAfter.merkleRoot),
        totalReceipts: Number(verifyAfter.totalReceipts ?? verifyAfter.receiptsVerified),
      }
    }

    const publishOutcomeT1 = {
      ok: true,
      resultingBallId: laterBall.ballId,
      resultingEpoch: 167,
      hasApprovalToken: false,
    }

    const boot1 = await simulateBootReconciliation(publishOutcomeT1)
    // Only the adopted head's own receipt: nothing is planned for an epoch this node never promoted.
    expect(boot1.recovered).toEqual([
      'epoch-167:seed-recall',
    ])
    expect(boot1.totalReceipts).toBe(1)

    // Second and third cold boots must append ZERO receipts and preserve the exact Merkle root.
    const boot2 = await simulateBootReconciliation(publishOutcomeT1)
    expect(boot2.recovered).toEqual([])
    expect(boot2.totalReceipts).toBe(boot1.totalReceipts)
    expect(boot2.merkleRoot).toBe(boot1.merkleRoot)

    const boot3 = await simulateBootReconciliation(null)
    expect(boot3.recovered).toEqual([])
    expect(boot3.totalReceipts).toBe(boot1.totalReceipts)
    expect(boot3.merkleRoot).toBe(boot1.merkleRoot)
  })

  it('refuses to append retro receipts before cloud hydration or on a stale local receipt prefix', () => {
    const emptyLog = ''
    expect(planIdempotentRetroReceipts({
      currentBall: laterBall,
      existingReceiptsText: emptyLog,
      persistenceReady: false,
      chainVerified: true,
      cloudTotalReceipts: null,
    })).toEqual([])

    // Packaged VFS prefix has 0 receipts while cloud MirrorDO reports 145 verified receipts.
    expect(planIdempotentRetroReceipts({
      currentBall: laterBall,
      existingReceiptsText: emptyLog,
      persistenceReady: true,
      chainVerified: true,
      cloudTotalReceipts: 145,
    })).toEqual([])
  })

  it('deduplicates across both ball.promote and head.promote and derives T1/T2 approval honestly', () => {
    const existing = [
      JSON.stringify({ schema: 'aukora.receipt.v3', seq: 1, kind: 'ball.promote', data: { epoch: 63, ballId: '90b6e125748baa5b' } }),
      JSON.stringify({ schema: 'aukora.receipt.v3', seq: 2, kind: 'head.promote', data: { epoch: 64, ballId: '05e739c37236c35a16b3baa92a9a5f526db26da56761d254b73675138490bb96' } }),
      JSON.stringify({ schema: 'aukora.receipt.v3', seq: 3, kind: 'head.promote', data: { epoch: 65, ballId: '98b06a0eb5458ddcdf14577168edadf2b03a861a698fb44c07c72b7bce7d6dcd' } }),
    ].join('\n') + '\n'

    // Without matching lastPublishOutcome for epoch 167, post-65 headAdopt does not invent a receipt.
    expect(planIdempotentRetroReceipts({
      currentBall: laterBall,
      existingReceiptsText: existing,
      persistenceReady: true,
      chainVerified: true,
      cloudTotalReceipts: 3,
      lastPublishOutcome: null,
    })).toEqual([])

    // With T1 publish outcome, records hasApprovalToken: false and tier: 'T1'.
    const t1Planned = planIdempotentRetroReceipts({
      currentBall: laterBall,
      existingReceiptsText: existing,
      persistenceReady: true,
      chainVerified: true,
      cloudTotalReceipts: 3,
      lastPublishOutcome: {
        ok: true,
        resultingBallId: laterBall.ballId,
        resultingEpoch: 167,
        hasApprovalToken: false,
      },
      changedEntriesHint: ['seed-recall'],
    })
    expect(t1Planned).toHaveLength(1)
    expect(t1Planned[0]?.data.tier).toBe('T1')
    expect(t1Planned[0]?.data.hasApprovalToken).toBe(false)

    // Once recorded, promote_staged check sees it and skips duplicate append.
    const afterAppend = existing + JSON.stringify({
      schema: 'aukora.receipt.v3',
      seq: 4,
      kind: 'head.promote',
      data: t1Planned[0]?.data,
    }) + '\n'
    expect(hasPromotionReceiptInJsonl(afterAppend, 167, laterBall.ballId)).toBe(true)
  })

  it('serializes concurrent promotion receipt emitters so 0ms/89ms races emit at most one receipt per (epoch, ballId)', async () => {
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
    const organ = loadSeedReceiptsOrgan()
    const receiptsPath = '/dsh/home/auma/seed/receipts.v3.jsonl'
    const appendOnce = createSerializedPromotionReceiptAppender({
      readReceiptsJsonl: () => (vfs.existsSync(receiptsPath) ? (vfs.readFileSync(receiptsPath, 'utf8') as string) : ''),
      appendReceipt: async (kind, data) => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return await organ.run({ action: 'append', kind, data }, { fs: vfs }) as { ok?: boolean }
      },
    })
    const ballId = '7c4938450b882917000000000000000000000000000000000000000000000067'
    const [first, second, third] = await Promise.all([
      appendOnce({
        kind: 'ball.promote',
        epoch: 167,
        ballId,
        data: { entryId: 'seed-recall', ballId, parentBallId: 'a'.repeat(64), epoch: 167, tier: 'T1' },
      }),
      appendOnce({
        kind: 'head.promote',
        epoch: 167,
        ballId,
        data: { entryId: 'seed-recall', ballId, parentBallId: 'a'.repeat(64), epoch: 167, tier: 'T1', adopted: true },
      }),
      appendOnce({
        kind: 'head.promote',
        epoch: 167,
        ballId,
        data: { entryId: 'seed-recall', ballId, parentBallId: 'a'.repeat(64), epoch: 167, tier: 'T1' },
      }),
    ])
    expect(first).toEqual({ ok: true, deduplicated: false })
    expect(second).toEqual({ ok: true, deduplicated: true })
    expect(third).toEqual({ ok: true, deduplicated: true })
    const lines = (vfs.readFileSync(receiptsPath, 'utf8') as string).trim().split('\n')
    expect(lines).toHaveLength(1)
  })
  it('rejects malformed new receipt identifiers and tiers without poisoning subsequent appends', async () => {
    const emitted: Record<string, unknown>[] = []
    const append = createSerializedPromotionReceiptAppender({ readReceiptsJsonl: () => '',
      appendReceipt: async (_kind, data) => { emitted.push(data); return { ok: true } } })
    const ballId = 'b'.repeat(64)
    const data = { ballId, parentBallId: 'a'.repeat(64), epoch: 151, tier: 'T1' }
    for (const invalid of [{ ballId: 'short' }, { ballId: 'z'.repeat(64) }, { parentBallId: null },
      { parentBallId: '90b6e125748baa5b' }, { parentBallId: 'g'.repeat(64) }, { tier: 'T3' }, { tier: undefined }]) {
      expect(await append({ kind: 'head.promote', epoch: 151, ballId, data: { ...data, ...invalid } }))
        .toEqual({ ok: false, deduplicated: false })
    }
    expect(await append({ kind: 'head.promote', epoch: 151, ballId: 'short', data }))
      .toEqual({ ok: false, deduplicated: false })
    expect(emitted).toEqual([])
    expect(await append({ kind: 'head.promote', epoch: 151, ballId, data })).toEqual({ ok: true, deduplicated: false })
    expect(await append({ kind: 'ball.promote', epoch: 152, ballId: 'c'.repeat(64),
      data: { ...data, ballId: 'c'.repeat(64), tier: 'T2' } })).toEqual({ ok: true, deduplicated: false })
  })

  it('preserves seq 1 through 150 including the historical short-id epoch-63 leaf at seq 134', async () => {
    const original = Array.from({ length: 150 }, (_, index) => JSON.stringify({ schema: 'aukora.receipt.v3', seq: index + 1,
      kind: index === 133 ? 'head.promote' : 'synthetic',
      data: index === 133 ? { epoch: 63, ballId: '90b6e125748baa5b' } : {} })).join('\n') + '\n'
    let text = original
    const append = createSerializedPromotionReceiptAppender({ readReceiptsJsonl: () => text,
      appendReceipt: async (kind, data) => { text += JSON.stringify({ kind, data }) + '\n'; return { ok: true } } })
    // The planner invents no receipt for an epoch this node never promoted itself.
    expect(planIdempotentRetroReceipts({ currentBall: laterBall, existingReceiptsText: '', persistenceReady: true, chainVerified: true })).toEqual([])
    const recovered63 = { ballId: '456250574f46538598d5eac5bd4c455c4857a6a397edd110e1742ade2e36aa77', data: { entryId: 'seed-receipts', ballId: '456250574f46538598d5eac5bd4c455c4857a6a397edd110e1742ade2e36aa77', parentBallId: 'a'.repeat(64), epoch: 63, tier: 'T1' } }
    for (let boot = 0; boot < 3; boot++) {
      expect(await append({ kind: 'head.promote', epoch: 63, ballId: recovered63.ballId, data: recovered63.data }))
        .toEqual({ ok: true, deduplicated: true })
    }
    expect(text).toBe(original)
  })

})
