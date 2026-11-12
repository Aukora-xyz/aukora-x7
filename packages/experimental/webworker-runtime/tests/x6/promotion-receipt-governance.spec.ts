/**
 * Lane E4 task 1 (completeMutation) + task 4 (WO-3): a governance promotion never gets a premature
 * `tier:'T1', hasApprovalToken:false` leaf. Promotion leaves dedupe on (epoch, ballId), so the first writer wins forever:
 * the old local writer's T1 leaf made the later authoritative T2 outcome unrecordable. Proven against the real
 * seed-receipts organ; every leaf carries operationId + transitionKind.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { classifyEntryGovernance, createSerializedPromotionReceiptAppender, planIdempotentRetroReceipts } from '../../src/x6/ball-loader.ts'
import { createTransitionContext, isTransitionKind, planPromotionReceipt, transitionFields, TRANSITION_KINDS } from '../../src/x6/transition-context.ts'

const requireFromHere = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'

function seedReceipts() {
  const code = readFileSync(path.join(REPO_ROOT, 'mirror/home/auma/seed/organs/seed-receipts.js'), 'utf8')
  const mod = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', code)(requireFromHere, mod, mod.exports)
  return mod.exports as { run: (args: Record<string, unknown>, ctx: { fs: MemoryVfs }) => Promise<Record<string, unknown>> }
}

const head = { ballId: 'a'.repeat(64), parentBallId: 'b'.repeat(64), epoch: 168 }

function harness() {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
  const organ = seedReceipts()
  const read = () => vfs.existsSync(RECEIPTS) ? vfs.readFileSync(RECEIPTS, 'utf8') as string : ''
  const append = createSerializedPromotionReceiptAppender({
    readReceiptsJsonl: read,
    appendReceipt: async (kind, data) => await organ.run({ action: 'append', kind, data }, { fs: vfs }) as { ok?: boolean },
  })
  const leaves = () => read().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; data: Record<string, unknown> })
  return { organ, vfs, append, leaves }
}

describe('transition context (WO-3)', () => {
  it('mints op- ids, validates kinds and refuses malformed ids', () => {
    const context = createTransitionContext('head.promote')
    expect(context.operationId).toMatch(/^op-[A-Za-z0-9._:-]{8,120}$/)
    expect(transitionFields(context)).toEqual({ operationId: context.operationId, transitionKind: 'head.promote' })
    expect(createTransitionContext('wake.step', context.operationId).operationId).toBe(context.operationId)
    expect(() => createTransitionContext('head.yolo')).toThrow('TRANSITION_CONTEXT_INVALID')
    expect(() => createTransitionContext('head.stage', 'nope')).toThrow('TRANSITION_CONTEXT_INVALID')
    expect(TRANSITION_KINDS).toEqual(expect.arrayContaining(['tree.patch', 'head.promote', 'head.adopt', 'head.stage', 'wake.acknowledge', 'wake.step']))
    expect(isTransitionKind('ball.promote')).toBe(true)
    expect(isTransitionKind('x')).toBe(false)
  })
})

describe('governance promotion receipts: no premature T1 leaf', () => {
  it('defers a governance leaf until the edge reports the outcome for exactly this head', () => {
    const context = createTransitionContext('head.promote')
    expect(classifyEntryGovernance('seed-pearl')).toBe(3)
    expect(planPromotionReceipt({ entryId: 'seed-pearl', manifest: head, governance: true, context }))
      .toEqual({ write: false, reason: 'GOVERNANCE_AWAITS_AUTHORITATIVE_OUTCOME' })
    // An outcome for another head never vouches for this one.
    expect(planPromotionReceipt({ entryId: 'seed-pearl', manifest: head, governance: true, context,
      authoritative: { ok: true, resultingBallId: 'c'.repeat(64), resultingEpoch: 168, hasApprovalToken: true } }).write).toBe(false)
    // A T1 outcome (no token) for a governance head is also not written locally.
    expect(planPromotionReceipt({ entryId: 'seed-pearl', manifest: head, governance: true, context,
      authoritative: { ok: true, resultingBallId: head.ballId, resultingEpoch: 168, hasApprovalToken: false } }).write).toBe(false)
    const t2 = planPromotionReceipt({ entryId: 'seed-pearl', manifest: head, governance: true, context,
      authoritative: { ok: true, resultingBallId: head.ballId, resultingEpoch: 168, hasApprovalToken: true } })
    expect(t2).toEqual({ write: true, data: { entryId: 'seed-pearl', ballId: head.ballId, parentBallId: head.parentBallId, epoch: 168,
      tier: 'T2', hasApprovalToken: true, operationId: context.operationId, transitionKind: 'head.promote' } })
    // Ordinary organs still get their T1 leaf immediately, now attributed.
    const t1 = planPromotionReceipt({ entryId: 'organ-a', manifest: head, governance: false, context })
    expect(t1).toMatchObject({ write: true, data: { tier: 'T1', hasApprovalToken: false, operationId: context.operationId, transitionKind: 'head.promote' } })
  })

  it('end to end with the real seed-receipts organ: the authoritative T2 leaf lands, and only once', async () => {
    const { append, leaves, organ, vfs } = harness()
    const local = createTransitionContext('head.promote')
    // The local completeMutation path for a governance transition writes nothing.
    const premature = planPromotionReceipt({ entryId: 'seed-pearl', manifest: head, governance: true, context: local })
    expect(premature.write).toBe(false)
    expect(leaves()).toEqual([])
    // ensureRetroPromotionReceipts then records the authoritative outcome, attributed to its own head.adopt operation.
    const adopt = createTransitionContext('head.adopt')
    const planned = planIdempotentRetroReceipts({
      currentBall: { ...head, entries: { 'seed-pearl': { specifier: 'ball:' + 'd'.repeat(64) } } },
      existingReceiptsText: '', persistenceReady: true, chainVerified: true, cloudTotalReceipts: 0,
      lastPublishOutcome: { ok: true, resultingBallId: head.ballId, resultingEpoch: 168, hasApprovalToken: true },
      changedEntriesHint: ['seed-pearl'], context: adopt,
    }).filter(candidate => candidate.epoch === 168)
    expect(planned).toHaveLength(1)
    for (const candidate of planned) await append({ kind: 'head.promote', epoch: candidate.epoch, ballId: candidate.ballId, data: candidate.data })
    // A late local writer cannot overwrite it.
    const late = await append({ kind: 'head.promote', epoch: 168, ballId: head.ballId, data: { entryId: 'seed-pearl', ballId: head.ballId, parentBallId: head.parentBallId, epoch: 168, tier: 'T1', hasApprovalToken: false } })
    expect(late.deduplicated).toBe(true)
    const promotions = leaves().filter(leaf => leaf.kind === 'head.promote')
    expect(promotions).toHaveLength(1)
    expect(promotions[0]!.data).toMatchObject({ epoch: 168, ballId: head.ballId, tier: 'T2', hasApprovalToken: true,
      operationId: adopt.operationId, transitionKind: 'head.adopt' })
    expect((await organ.run({ action: 'verify' }, { fs: vfs })).ok).toBe(true)
  })

  it('Lane E5 keep-authoritative: a provisional T1 leaf (pre-E4 writer) no longer locks the epoch at T1', async () => {
    const { append, leaves } = harness()
    const first = await append({ kind: 'head.promote', epoch: 168, ballId: head.ballId, data: { entryId: 'seed-pearl', ballId: head.ballId, parentBallId: head.parentBallId, epoch: 168, tier: 'T1', hasApprovalToken: false } })
    expect(first).toEqual({ ok: true, deduplicated: false })
    const out = await append({ kind: 'head.promote', epoch: 168, ballId: head.ballId, data: { entryId: 'seed-pearl', ballId: head.ballId, parentBallId: head.parentBallId, epoch: 168, tier: 'T2', hasApprovalToken: true } })
    expect(out).toEqual({ ok: true, deduplicated: false })
    expect(leaves().filter(leaf => leaf.kind === 'head.promote').map(leaf => leaf.data.tier)).toEqual(['T1', 'T2'])
  })
})
