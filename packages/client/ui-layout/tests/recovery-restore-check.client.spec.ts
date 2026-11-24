/**
 * Checking a recovery snapshot against a live edge (Continuity, Estate card): every part against its SHA-256, then her
 * HEAD, receipts and memory compared with the edge's. It writes nothing; the stubbed fetch proves only GETs are made.
 */
import { describe, expect, it } from 'vitest'
import { buildRecoverySnapshot, missingPart, recoveryPartOf, type RecoveryPart } from '../src/client/spatial/portal/recovery-snapshot.ts'
import { checkRecoveryAgainstEdge, leftOutWords, recoveryCheckWords, verifyRecoveryFile } from '../src/client/spatial/portal/recovery-restore.ts'

const b64 = (text: string): string => btoa(text)
const receipts = (count: number): string => Array.from({ length: count }, (_, index) =>
  JSON.stringify({ schema: 'aukora.receipt.v3', seq: index + 1, hash: String(index + 1).padStart(64, 'a') })).join('\n') + '\n'
const ballBody = (epoch: number) => ({ ok: true, head: { version: 'x6.1-ball/v1', epoch, ballId: String(epoch).padStart(64, 'b'), modules: {}, entries: {} },
  modules: {}, ball: null, codeBySha: {}, peers: [] })
type WireRow = [string, Record<string, unknown>]
const mirrorBody = (count: number, note = 'she remembers', extra: { entries?: WireRow[]; resetPaths?: string[] } = {}) => ({ ok: true,
  protocol: 'x61-mirror/v2', lineageId: '11111111-1111-4111-8111-111111111111',
  revision: 3, snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [...(extra.resetPaths ?? [])].sort(), entries: ([
    ['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory/note.md', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: b64(note) }],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', { kind: 'file', mode: 0o600, mtimeMs: 2, b64: b64(receipts(count)) }],
    ...(extra.entries ?? []),
  ] as WireRow[]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)) })
const bytesOf = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value))

async function snapshotOf(epoch: number, count: number, note?: string, extra?: Parameters<typeof mirrorBody>[2]) {
  const parts: RecoveryPart[] = [
    await recoveryPartOf('/_head/ball', 200, 'application/json', bytesOf(ballBody(epoch))),
    await recoveryPartOf('/__x6/facts', 200, 'application/json', bytesOf({ ok: true, runtime: 'cloudflare', epoch })),
    missingPart('/_host/estate', 403, 'answered 403'),
    await recoveryPartOf('/_mirror/export', 200, 'application/json', bytesOf(mirrorBody(count, note, extra))),
  ]
  return JSON.parse(JSON.stringify(await buildRecoverySnapshot(parts, 'https://edge.example.invalid', 1794000000000))) as Record<string, unknown>
}

function edge(epoch: number, count: number, { runtime = 'cloudflare', note }: { runtime?: string; note?: string } = {}) {
  const asked: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const route = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    asked.push(`${init?.method ?? 'GET'} ${route}`)
    if (route === '/__x6/status') return Response.json({ ok: true, runtime, head: { epoch } })
    if (route === '/_head/ball') return Response.json(ballBody(epoch))
    if (route === '/_mirror/export') return Response.json(mirrorBody(count, note))
    return Response.json({ ok: false }, { status: 404 })
  }
  return { fetchImpl, asked }
}
const signal = (): AbortSignal => new AbortController().signal

describe('checkRecoveryAgainstEdge', () => {
  it('the same HEAD, receipts and memory: she is already here, and only GETs were made', async () => {
    const live = edge(169, 5)
    const result = await checkRecoveryAgainstEdge(await snapshotOf(169, 5), signal(), live.fetchImpl)
    expect(result).toMatchObject({ ok: true, verdict: 'already-here', file: { epoch: 169 }, live: { epoch: 169 } })
    expect(recoveryCheckWords(result)).toMatch(/^She is already here/u)
    expect(live.asked).toEqual(['GET /__x6/status', 'GET /_head/ball', 'GET /_mirror/export'])
  })

  it('a newer or different edge is shown side by side and never written over', async () => {
    const newer = await checkRecoveryAgainstEdge(await snapshotOf(169, 5), signal(), edge(170, 6).fetchImpl)
    expect(newer).toMatchObject({ ok: true, verdict: 'live-newer', file: { epoch: 169, highWater: { receiptCount: 5 } }, live: { epoch: 170, highWater: { receiptCount: 6 } } })
    expect(recoveryCheckWords(newer)).toContain('Nothing was written')
    const differs = await checkRecoveryAgainstEdge(await snapshotOf(169, 5), signal(), edge(169, 5, { note: 'something else' }).fetchImpl)
    expect(differs).toMatchObject({ ok: true, verdict: 'live-differs' })
  })

  it('only the Cloudflare edge is compared', async () => {
    const mac = edge(169, 5, { runtime: 'local' })
    const result = await checkRecoveryAgainstEdge(await snapshotOf(169, 5), signal(), mac.fetchImpl)
    expect(result).toMatchObject({ ok: false, code: 'RECOVERY_EDGE_REQUIRED' })
    expect(mac.asked).toEqual(['GET /__x6/status'])
  })

  it('a tampered part is named and the edge is never asked', async () => {
    for (const [index, route] of [[0, '/_head/ball'], [1, '/__x6/facts'], [3, '/_mirror/export']] as const) {
      const snapshot = await snapshotOf(169, 5)
      const parts = snapshot.parts as Record<string, unknown>[]
      parts[index] = { ...parts[index], body: { ...(parts[index]?.body as object), tampered: true } }
      const live = edge(169, 5)
      expect(await checkRecoveryAgainstEdge(snapshot, signal(), live.fetchImpl)).toEqual({ ok: false, code: 'RECOVERY_PART_HASH_MISMATCH', part: route })
      expect(live.asked).toEqual([])
    }
    const noMirror = await snapshotOf(169, 5)
    ;(noMirror.parts as unknown[])[3] = missingPart('/_mirror/export', 503, 'answered 503')
    expect(await verifyRecoveryFile(noMirror)).toEqual({ ok: false, code: 'RECOVERY_PART_MISSING', part: '/_mirror/export' })
    const swapped = await snapshotOf(169, 5)
    swapped.manifestSha256 = 'f'.repeat(64)
    expect(await verifyRecoveryFile(swapped)).toEqual({ ok: false, code: 'RECOVERY_MANIFEST_MISMATCH' })
    expect(await verifyRecoveryFile({ schema: 'something-else' })).toEqual({ ok: false, code: 'RECOVERY_SCHEMA_INVALID' })
  })
})

describe('a file saved before the secret-shaped rule', () => {
  const temp: WireRow = ['/dsh/home/.credentials.yaml.77aa00.tmp', { kind: 'file', mode: 0o600, mtimeMs: 9, b64: b64('records: SYNTHETIC') }]
  const pepper: WireRow = ['/dsh/home/auma/pepper.v1', { kind: 'file', mode: 0o600, mtimeMs: 10, b64: b64('SYNTHETIC-PEPPER') }]
  const markers = ['/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp', '/dsh/home/.credentials.yaml.lock']

  it('leaves out what the edge no longer takes, so she is still already here, with the same memory digest', async () => {
    const plain = await verifyRecoveryFile(await snapshotOf(169, 5))
    const old = await verifyRecoveryFile(await snapshotOf(169, 5, undefined, { entries: [temp, pepper], resetPaths: markers }))
    expect(old).toMatchObject({ ok: true, withheld: 4 })
    expect(plain).toMatchObject({ ok: true, withheld: 0 })
    if (!old.ok || !plain.ok) throw new Error('both files verify')
    expect(old.mirrorSha256).toBe(plain.mirrorSha256)
    const live = edge(169, 5)
    const file = await snapshotOf(169, 5, undefined, { entries: [temp], resetPaths: markers })
    const result = await checkRecoveryAgainstEdge(file, signal(), live.fetchImpl)
    expect(result).toMatchObject({ ok: true, verdict: 'already-here' })
    expect(live.asked).toEqual(['GET /__x6/status', 'GET /_head/ball', 'GET /_mirror/export'])
  })

  it('keeps an ordinary deletion marker, and never drops a path the edge refused before (it still counts)', async () => {
    const plain = await verifyRecoveryFile(await snapshotOf(169, 5))
    const marked = await verifyRecoveryFile(await snapshotOf(169, 5, undefined, { resetPaths: ['/dsh/workspace/old'] }))
    const forged = await verifyRecoveryFile(await snapshotOf(169, 5, undefined, { entries: [['/dsh/home/auma/.ssh', { kind: 'dir', mode: 0o700 }]] }))
    if (!plain.ok || !marked.ok || !forged.ok) throw new Error('all three files verify')
    expect([marked.withheld, forged.withheld]).toEqual([0, 0])
    expect(marked.mirrorSha256).not.toBe(plain.mirrorSha256)
    expect(forged.mirrorSha256).not.toBe(plain.mirrorSha256)
  })

  it('job 3: the card names what a restore of the file leaves out, by kind and count, and nothing else', async () => {
    const live = edge(169, 5)
    const oldFile = await snapshotOf(169, 5, undefined, { entries: [temp, pepper], resetPaths: markers })
    const old = await checkRecoveryAgainstEdge(oldFile, signal(), live.fetchImpl)
    if (!old.ok) throw new Error('the old file checks')
    // Job 4: the words name the rule, never "copies of secret files" (the rule may also match an ordinary name).
    const sentence = '2 entries and 2 deletion markers matching the secret-path rule in this recovery file were left out: '
      + 'the edge does not keep paths matching that rule'
    expect(old.leftOut).toBe(sentence)
    const words = recoveryCheckWords(old)
    expect(words).toMatch(/^She is already here/u)
    expect(words).toContain(`${sentence}.`)
    for (const name of ['credentials', 'pepper', '.tmp', '.lock', 'SYNTHETIC', '/dsh/', 'copies of secret', 'secret files']) expect(words.includes(name)).toBe(false)
    // A newer edge: the comparison still says what the file leaves out.
    const newer = await checkRecoveryAgainstEdge(await snapshotOf(169, 5, undefined, { entries: [temp] }), signal(), edge(170, 6).fetchImpl)
    expect(recoveryCheckWords(newer)).toContain('1 entry matching the secret-path rule in this recovery file was left out: ')
    // A file with nothing left out reads exactly as before.
    const plain = await checkRecoveryAgainstEdge(await snapshotOf(169, 5), signal(), edge(169, 5).fetchImpl)
    if (!plain.ok) throw new Error('the plain file checks')
    expect(plain.leftOut).toBeNull()
    expect(recoveryCheckWords(plain)).not.toContain('left out')
    expect(recoveryCheckWords(plain)).toMatch(/Pearl b{12}…\. Nothing to write\.$/u)
  })

  it('job 3: the words count each kind, singular and plural, and say nothing when nothing is left out', () => {
    expect(leftOutWords(0, 0)).toBeNull()
    expect(leftOutWords(1, 0)).toMatch(/^1 entry matching the secret-path rule in this recovery file was left out: /u)
    expect(leftOutWords(0, 1)).toMatch(/^1 deletion marker matching the secret-path rule in this recovery file was left out: /u)
    expect(leftOutWords(5, 0)).toMatch(/^5 entries matching the secret-path rule in this recovery file were left out: /u)
    expect(leftOutWords(1, 1))
      .toMatch(/^1 entry and 1 deletion marker matching the secret-path rule in this recovery file were left out: /u)
  })
})
