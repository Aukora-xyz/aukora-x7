/**
 * The read-only Receipt chain verdict (portal/receipt-chain-verdict.ts) against the membrane minimal verifier's own
 * self-test and vectors (copied from an earlier repository into tests/fixtures/membrane-minimal),
 * plus her tree shape: seed-receipts.js promotes an odd node, which must be the RFC 6962 tree for the proof to mean anything.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chainVerdictOf, chainVerdictWords, consistencyProof, merkleRoot, verifyConsistency,
} from '../src/client/spatial/portal/receipt-chain-verdict.ts'

const vector = (name: string): Record<string, unknown> => {
  const candidates = ['', 'packages/client/ui-layout/'].map(prefix => resolve(process.cwd(), `${prefix}tests/fixtures/membrane-minimal/${name}`))
  for (const path of candidates) {
    try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { /* try the next root */ }
  }
  throw new Error(`vector ${name} not found`)
}
const leafOf = (i: number) => createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(`leaf-${String(i)}`)])).digest('hex')
const node = (l: string, r: string) => createHash('sha256').update(Buffer.concat([Buffer.from([1]), Buffer.from(l, 'hex'), Buffer.from(r, 'hex')])).digest('hex')
/** RFC 6962 MTH, recursive, for comparison with her bottom-up tree. */
const mth = (leaves: string[]): string => {
  if (leaves.length === 1) return leaves[0] as string
  let k = 1
  while (k * 2 < leaves.length) k *= 2
  return node(mth(leaves.slice(0, k)), mth(leaves.slice(k)))
}

describe('membrane minimal verifier, ported', () => {
  const r5 = '6f7f213a4c7fe7c7b034c3879840a49918481b4796c7f8583d3604e09158fa4b'
  const r14 = '9fde8beaf87fd07070b5bc2068ef543e830653ab0245412e8a6d25a829db78de'
  const p514 = [
    '2117942a52d6136b5020766f489c4c95063c3dd7d050743685f1e58af4189c56',
    '9fd396c9621758169909f320cd76d6d13c47e1df1f2a52615e9c6968fed6eb43',
    'f54a41ca7a75620fad5c51ab8310dbf6ca91e9c56ed2e48be64297b9ca8b6b99',
    '90283eea2a3492d5a7219a00a16389e132f01600e947b06392b47dd95f7f1567',
    'e72cc2893ebac0de5b880d9ebe2dbb26f1fba9f5d8d4196295dd3e8f4c580e23',
  ]
  const r4 = '90283eea2a3492d5a7219a00a16389e132f01600e947b06392b47dd95f7f1567'
  const p414 = ['1ecf2a95d2edb667f8009d3d80730298b5375a959e62152e666ddc04aa9a181d', 'e72cc2893ebac0de5b880d9ebe2dbb26f1fba9f5d8d4196295dd3e8f4c580e23']

  it('passes verify.py --selftest, all four checks', async () => {
    expect((await verifyConsistency(5, 14, r5, r14, p514))[0]).toBe('APPEND_ONLY')
    expect((await verifyConsistency(4, 14, r4, r14, p414))[0]).toBe('APPEND_ONLY')
    expect((await verifyConsistency(5, 14, '00'.repeat(32), r14, p514))[0]).toBe('OBSERVATION_CONFLICT')
    expect(await verifyConsistency(4, 14, r4, r14, ['00'.repeat(32), ...p414.slice(1)])).toEqual(['UNDETERMINED', 'POWER_OF_TWO_PREFIX_NOT_INDEPENDENTLY_DERIVABLE'])
  })

  it('gives the CLAIM.md verdicts on the copied vectors', async () => {
    const run = async (retained: string, presented: string) => {
      const a = vector(retained), b = vector(presented)
      return (await verifyConsistency(a.treeSize, b.treeSize, a.root, b.root, b.proofFromPrevious))[0]
    }
    expect(await run('retained.json', 'append-only.json')).toBe('APPEND_ONLY')
    expect(await run('power-of-two-retained.json', 'power-of-two-presented.json')).toBe('APPEND_ONLY')
    expect(await run('retained.json', 'rewritten.json')).toBe('OBSERVATION_CONFLICT')
  })

  it('refuses malformed input as UNDETERMINED, never as a pass', async () => {
    expect((await verifyConsistency(0, 14, r5, r14, p514))[1]).toBe('missing_prior_observation')
    expect((await verifyConsistency(15, 14, r5, r14, p514))[1]).toBe('invalid_tree_sizes')
    expect((await verifyConsistency(5, 14, 'zz', r14, p514))[1]).toBe('root_is_not_a_digest')
    expect((await verifyConsistency(5, 14, r5, r14, p514.slice(0, 2)))[0]).toBe('UNDETERMINED')
    expect((await verifyConsistency(5, 14, r5, r14, [...p514, p514[0]]))[0]).toBe('UNDETERMINED')
    expect((await verifyConsistency(5, 14, r5, r14, []))[1]).toBe('empty_proof_for_different_sizes')
  })
})

describe('her receipt chain', () => {
  it('her bottom-up tree is the RFC 6962 tree, and every generated proof verifies', async () => {
    const leaves = Array.from({ length: 21 }, (_, i) => leafOf(i))
    for (let n = 1; n <= leaves.length; n++) expect(await merkleRoot(leaves.slice(0, n))).toBe(mth(leaves.slice(0, n)))
    for (let n = 2; n <= 13; n++) {
      for (let m = 1; m < n; m++) {
        const proof = await consistencyProof(m, leaves.slice(0, n))
        const verdict = await verifyConsistency(m, n, mth(leaves.slice(0, m)), mth(leaves.slice(0, n)), proof)
        expect(verdict[0], `m=${String(m)} n=${String(n)}`).toBe('APPEND_ONLY')
      }
    }
  })

  it('a rewritten prefix is a conflict, or unknown at a power of two, never append-only', async () => {
    const leaves = Array.from({ length: 12 }, (_, i) => leafOf(i))
    const rewritten = [...leaves]
    rewritten[1] = leafOf(99)
    for (const m of [3, 4, 5, 7, 8, 11]) {
      const [verdict] = await verifyConsistency(m, 12, mth(leaves.slice(0, m)), mth(rewritten), await consistencyProof(m, rewritten))
      expect(verdict).toBe((m & (m - 1)) === 0 ? 'UNDETERMINED' : 'OBSERVATION_CONFLICT')
    }
  })

  /** Rows exactly as seed-receipts.js writes them: v3 schema, seq, prevHash link, leafHash over the canonical row. */
  const rowsOf = (count: number) => {
    const rows: Record<string, unknown>[] = []
    let prevHash = '0'.repeat(64)
    for (let seq = 1; seq <= count; seq++) {
      const payload = { schema: 'aukora.receipt.v3', seq, prevHash, at: `2026-11-11T00:00:${String(seq).padStart(2, '0')}Z`, kind: 'test', data: { n: seq } }
      const leafHash = createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))])).digest('hex')
      rows.push({ ...payload, leafHash })
      prevHash = leafHash
    }
    return rows
  }
  const textOf = (rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const checkpointOf = (rows: Record<string, unknown>[], count: number) =>
    JSON.stringify({ body: { receiptCount: count, merkleRoot: mth(rows.slice(0, count).map(row => row.leafHash as string)) } }) + '\n'

  it('reads her two files, recomputes every leaf, and names the exact inputs', async () => {
    const rows = rowsOf(6)
    const receiptsText = textOf(rows), checkpointsText = checkpointOf(rows, 5)
    const good = await chainVerdictOf({ checkpointsText, receiptsText })
    expect(good.verdict).toBe('APPEND_ONLY')
    expect(good.inputHashes.presented).toBe(createHash('sha256').update(receiptsText).digest('hex'))
    expect(good.inputHashes.retained).toBe(createHash('sha256').update(checkpointsText).digest('hex'))
    const forged = JSON.stringify({ body: { receiptCount: 5, merkleRoot: 'ab'.repeat(32) } }) + '\n'
    expect((await chainVerdictOf({ checkpointsText: forged, receiptsText })).verdict).toBe('OBSERVATION_CONFLICT')
  })

  it('A receipt edited with its hash kept, a broken link or a broken sequence is never append-only', async () => {
    const rows = rowsOf(6)
    const checkpointsText = checkpointOf(rows, 5)
    const edited = rows.map((row, i) => (i === 2 ? { ...row, data: { n: 999 } } : row))
    const unlinked = rows.map((row, i) => (i === 4 ? { ...row, prevHash: 'cd'.repeat(32) } : row))
    const resequenced = rows.map((row, i) => (i === 1 ? { ...row, seq: 7 } : row))
    for (const [tampered, reason] of [[edited, 'receipt_3_contents_do_not_match_its_hash'], [unlinked, 'receipt_5_link_broken'],
      [resequenced, 'receipt_2_sequence_broken']] as const) {
      const verdict = await chainVerdictOf({ checkpointsText, receiptsText: textOf(tampered) })
      expect(verdict).toMatchObject({ verdict: 'UNDETERMINED', reason })
      expect(chainVerdictWords(verdict)).toMatch(/^Unknown:/)
    }
  })

  it('anything unread or unreadable is UNDETERMINED, worded as unknown', async () => {
    const cases = [
      { checkpointsText: null, receiptsText: '' },
      { checkpointsText: '', receiptsText: '' },
      { checkpointsText: '{"body":{"receiptCount":1,"merkleRoot":"' + 'ab'.repeat(32) + '"}}', receiptsText: null },
      { checkpointsText: '{"body":{"receiptCount":1,"merkleRoot":"' + 'ab'.repeat(32) + '"}}', receiptsText: 'not json\n' },
      { checkpointsText: '{"body":{"receiptCount":1,"merkleRoot":"' + 'ab'.repeat(32) + '"}}', receiptsText: '{"leafHash":"short"}\n' },
    ]
    for (const input of cases) {
      const verdict = await chainVerdictOf(input)
      expect(verdict.verdict).toBe('UNDETERMINED')
      expect(chainVerdictWords(verdict)).toMatch(/^Unknown:/)
    }
  })
})
