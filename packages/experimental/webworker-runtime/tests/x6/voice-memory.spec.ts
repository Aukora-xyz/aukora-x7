/**
 * the voice memory to N4: her voice memory in her home (storage/voice-memory.ts). The record format of DESIGN.md checked
 * against the edge lane's vectors (copied beside this spec as voice-memory.vectors.json);
 * the append rules of her home's two files; the verifier's closed verdicts. Fakes only: a MemoryVfs, a made-up edge.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  appendVoiceMemory, canonical, commitment, createVoiceMemoryStore, linkDigest, opens, recordDigest, runVoiceMemoryTool, validGap,
  validRecord, validWords, voiceMemoryHead, VOICE_MEMORY_CHAIN, VOICE_MEMORY_LIMITS, VOICE_MEMORY_SCOPE, VOICE_MEMORY_WORDS,
  VOICE_MEMORY_ZERO,
  type VoiceMemoryExchange, type VoiceMemoryWords,
} from '../../src/storage/voice-memory.ts'

/** The edge lane's first vector (VECTORS.json records[0]), word for word. */
const V1 = {
  record: { v: 1, seq: 1, prev: VOICE_MEMORY_ZERO, at: 1763294400000, conv: 'conv_vector1', turn: 'eleven:conv_vector1:1', kind: 'exchange',
    heardC: '74623c7047db747754926b9cf8f699b87c6f0457b55aefa4e1fbc4558041a4a1',
    saidC: 'e47fbc3f3c4b64b27d0eeb73461c0382958140e1fcba5c7ecbf03ce0107f6be7',
    ended: 'answered', path: 'fast',
    calls: [{ id: 'eleven:conv_vector1:1.fast', req: 'a'.repeat(64), res: 'b'.repeat(64), model: 'claude-fable-5-2', effort: 'low', rid: 'req_011CVector1' }] },
  words: { seq: 1, salt: '1'.repeat(32), heard: 'What did we decide about the chain?', said: 'We chain every exchange: each record names the hash of the one before.' },
}
/** The edge side's vectors, copied byte for byte beside this spec. */
const VECTORS_PATH = new URL('./voice-memory.vectors.json', import.meta.url)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const salt = (n: number): string => n.toString(16).padStart(2, '0').repeat(16)
async function exchange(seq: number, prev: string, heard: string, said: string, at = 1_763_294_400_000 + seq * 60_000) {
  const words: VoiceMemoryWords = { seq, salt: salt(seq), heard, said }
  const record: VoiceMemoryExchange = { v: 1, seq, prev, at, conv: 'conv_a', turn: `eleven:conv_a:${String(seq)}`, kind: 'exchange',
    heardC: await commitment(words.salt, 0, heard), saidC: await commitment(words.salt, 1, said), ended: 'answered', path: 'fast', calls: [] }
  return { record, words }
}
async function chainOf(count: number) {
  const items = []
  let prev = VOICE_MEMORY_ZERO
  for (let seq = 1; seq <= count; seq += 1) {
    const item = await exchange(seq, prev, `heard ${String(seq)} about the garden`, `said ${String(seq)}`)
    items.push(item)
    prev = await recordDigest(item.record)
  }
  return items
}
const files = (vfs: MemoryVfs) => [VOICE_MEMORY_CHAIN, VOICE_MEMORY_WORDS].map(path => (vfs.existsSync(path) ? String(vfs.readFileSync(path, 'utf8')) : null))

describe('N1: the record format matches the edge lane\'s vectors', () => {
  it('canonical bytes, digest and commitments of vector 1', async () => {
    const text = canonical(V1.record)
    expect(text.startsWith('{"at":1763294400000,"calls":[{"effort":"low","id":')).toBe(true)
    expect(validRecord(V1.record)).toBe(true)
    expect(validWords(V1.words)).toBe(true)
    expect(await opens(V1.record as VoiceMemoryExchange, V1.words)).toBe(true)
    expect(await recordDigest(V1.record)).toBe(sha(text))
  })

  it('every vector in VECTORS.json: canonical text, UTF-8 hex, digest, the commitments open, the chain links (gap included)', async () => {
    const { readFileSync } = await import('node:fs')
    const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
      records: Array<{
        record: VoiceMemoryExchange
        words: VoiceMemoryWords
        canonicalText: string
        canonicalUtf8Hex: string
        digest: string
      }>
      gap: { record: unknown; canonicalText: string; digest: string }
    }
    let prev = VOICE_MEMORY_ZERO
    for (const vector of vectors.records) {
      expect(canonical(vector.record)).toBe(vector.canonicalText)
      expect(Buffer.from(canonical(vector.record), 'utf8').toString('hex')).toBe(vector.canonicalUtf8Hex)
      expect(await recordDigest(vector.record)).toBe(vector.digest)
      expect(validRecord(vector.record) && validWords(vector.words)).toBe(true)
      expect(await opens(vector.record, vector.words)).toBe(true)
      expect(vector.record.prev).toBe(prev)
      prev = vector.digest
    }
    expect(validGap(vectors.gap.record)).toBe(true)
    expect(canonical(vectors.gap.record)).toBe(vectors.gap.canonicalText)
    expect(await recordDigest(vectors.gap.record)).toBe(vectors.gap.digest)
  })

  it('outside the form: floats, -0, undefined, holes, extra keys, a salt in the record, words over the cap', async () => {
    for (const bad of [1.5, -0, undefined, [1, , 2], new Date(0), () => 1]) expect(() => canonical(bad)).toThrow(/VOICE_MEMORY_CANON/)
    expect(validRecord({ ...V1.record, salt: V1.words.salt })).toBe(false)
    expect(validRecord({ ...V1.record, seq: 2 })).toBe(true)
    expect(validRecord({ ...V1.record, prev: 'f'.repeat(64) })).toBe(false)
    expect(validWords({ ...V1.words, heard: 'x'.repeat(VOICE_MEMORY_LIMITS.heardChars + 1) })).toBe(false)
    expect(validWords({ ...V1.words, said: 'x'.repeat(VOICE_MEMORY_LIMITS.saidChars + 1) })).toBe(false)
    expect(await opens(V1.record as VoiceMemoryExchange, { ...V1.words, said: `${V1.words.said}!` })).toBe(false)
    expect(validRecord({ ...V1.record, calls: Array.from({ length: 9 }, () => V1.record.calls[0]) })).toBe(false)
  })
})

describe('N2: her home keeps the chain (append and head)', () => {
  it('head on an empty home is seq 0 and 64 zeros', async () => {
    expect(await voiceMemoryHead(new MemoryVfs())).toEqual({ ok: true, seq: 0, digest: VOICE_MEMORY_ZERO })
  })

  it('in order: both files grow by one line per item; the folder is made on first use; a resend of the same bytes is skipped', async () => {
    const vfs = new MemoryVfs()
    const items = await chainOf(3)
    const store = createVoiceMemoryStore(vfs)
    const first = await store.append(items.slice(0, 2))
    expect(first).toEqual({ ok: true, seq: 2, digest: await recordDigest(items[1]?.record) })
    expect(await store.append(items.slice(1, 3))).toEqual({ ok: true, seq: 3, digest: await recordDigest(items[2]?.record) })
    const [chain, words] = files(vfs)
    expect(chain?.split('\n')).toEqual([...items.map(item => canonical(item.record)), ''])
    expect(words?.split('\n')).toEqual([...items.map(item => canonical(item.words)), ''])
    expect(await store.head()).toEqual({ ok: true, seq: 3, digest: await recordDigest(items[2]?.record) })
  })

  const refusals: Array<[string, (items: Awaited<ReturnType<typeof chainOf>>) => Promise<unknown[]>, string]> = [
    ['a gap', items => Promise.resolve([items[3]]), 'GAP'],
    ['a fork (another record at a seq her home has)', async items => [await exchange(2, items[0]?.record ? await recordDigest(items[0].record) : '', 'other', 'other')], 'FORK'],
    ['a fork (the next seq naming another prev)', async () => [await exchange(3, 'e'.repeat(64), 'x', 'y')], 'FORK'],
    ['a wrong commitment', async items => [{ record: (await exchange(3, await recordDigest(items[1]?.record), 'a', 'b')).record,
      words: { seq: 3, salt: salt(3), heard: 'a', said: 'changed' } }], 'COMMITMENT'],
    ['an over-cap item', async items => [await exchange(3, await recordDigest(items[1]?.record), 'x'.repeat(VOICE_MEMORY_LIMITS.heardChars + 1), 'y')], 'ITEM_INVALID'],
    ['a good item then a bad one (nothing of the frame is written)', async items => [items[2], { record: items[3]?.record, words: { ...items[3]?.words, said: 'no' } }], 'COMMITMENT'],
    ['nine items', async items => Array.from({ length: 9 }, () => items[2]), 'TOO_MANY_ITEMS'],
  ]
  for (const [name, make, code] of refusals) {
    it(`${name}: both files unchanged; answers ${code} with her home's head`, async () => {
      const vfs = new MemoryVfs()
      const items = await chainOf(4)
      await appendVoiceMemory(vfs, items.slice(0, 2))
      const before = files(vfs)
      const answer = await appendVoiceMemory(vfs, await make(items))
      expect(answer).toEqual({ ok: false, code, seq: 2, digest: await recordDigest(items[1]?.record) })
      expect(files(vfs)).toEqual(before)
    })
  }

  it('a failed chain write puts the words file back as it was', async () => {
    const vfs = new MemoryVfs()
    const items = await chainOf(3)
    await appendVoiceMemory(vfs, items.slice(0, 1))
    const before = files(vfs)
    const write = vfs.writeFileSync.bind(vfs)
    vfs.writeFileSync = (path: string, data: string | Uint8Array) => { if (path === VOICE_MEMORY_CHAIN) throw new Error('disk full'); write(path, data) }
    const answer = await appendVoiceMemory(vfs, items.slice(1, 2))
    expect(answer).toMatchObject({ ok: false, code: 'WRITE_FAILED', seq: 1 })
    expect(files(vfs)).toEqual(before)
  })

  it('a gap record starts a new segment: no words; the head names its prev; the next record links to that', async () => {
    const vfs = new MemoryVfs()
    const items = await chainOf(5)
    await appendVoiceMemory(vfs, items.slice(0, 1))
    const edgeDigestAt3 = await recordDigest(items[2]?.record)
    const gap = { v: 1, kind: 'gap', seq: 3, prev: edgeDigestAt3, at: 1, missingFrom: 2, missingTo: 3 }
    const answer = await appendVoiceMemory(vfs, [{ record: gap, words: null }, items[3]])
    expect(answer).toEqual({ ok: true, seq: 4, digest: await recordDigest(items[3]?.record) })
    expect(await linkDigest(gap as never)).toBe(edgeDigestAt3)
    expect(files(vfs)[1]?.split('\n').length).toBe(3)
  })
})

describe('N4: the verifier x6_voice_memory', () => {
  const now = 1_763_294_400_000 + 3 * 3600_000
  const edgeAt = async (items: Awaited<ReturnType<typeof chainOf>>, seq: number) => ({
    ok: true, switch: 'on', memory: { seq, digest12: seq === 0 ? '0'.repeat(12) : (await recordDigest(items[seq - 1]?.record)).slice(0, 12), synced: seq, unsynced: 0,
      gapFrom: null, adoptedFromHome: false, fork: false } })
  async function home(count: number) {
    const vfs = new MemoryVfs()
    const items = await chainOf(count)
    await appendVoiceMemory(vfs, items)
    return { vfs, items }
  }
  const run = (vfs: MemoryVfs, status: () => Promise<unknown>, args: Record<string, unknown>) =>
    runVoiceMemoryTool({ vfs, edgeStatus: status, nowMs: () => now }, args)

  it('an intact chain in step with the edge; behind; ahead; every answer ends with the fixed sentence', async () => {
    const { vfs, items } = await home(4)
    const same = await run(vfs, () => edgeAt(items, 4), { action: 'verify' })
    expect(same.verdict).toBe('INTACT_MATCHES_EDGE')
    expect(String(same.compared)).toContain('first 12 hex')
    const longer = await chainOf(6)
    const behind = await run(vfs, async () => ({ switch: 'on', memory: { ...(await edgeAt(longer, 6)).memory } }), { action: 'verify' })
    expect(behind).toMatchObject({ verdict: 'INTACT_HOME_BEHIND', behind: 2 })
    expect(await run(vfs, () => edgeAt(items, 2), { action: 'verify' })).toMatchObject({ verdict: 'INTACT_EDGE_BEHIND', ahead: 2 })
    expect(await run(vfs, () => edgeAt(items, 0), { action: 'verify' })).toMatchObject({ verdict: 'INTACT_EDGE_BEHIND', ahead: 4 })
    for (const answer of [same, behind]) {
      expect(Object.keys(answer).at(-1)).toBe('note')
      expect(answer.note).toBe(VOICE_MEMORY_SCOPE)
    }
  })

  it('a different digest at the edge\'s seq is FORK_AT that seq', async () => {
    const { vfs } = await home(3)
    expect(await run(vfs, () => Promise.resolve({ switch: 'on', memory: { seq: 2, digest12: 'abcdefabcdef', fork: false } }), { action: 'verify' }))
      .toMatchObject({ verdict: 'FORK_AT', seq: 2 })
  })

  it('one changed byte in a chain line is BROKEN_AT', async () => {
    const { vfs, items } = await home(4)
    const chain = String(vfs.readFileSync(VOICE_MEMORY_CHAIN, 'utf8'))
    vfs.writeFileSync(VOICE_MEMORY_CHAIN, chain.replace('"conv":"conv_a"', '"conv":"conv_b"'))
    const answer = await run(vfs, () => edgeAt(items, 4), { action: 'verify' })
    expect(answer).toMatchObject({ verdict: 'BROKEN_AT', seq: 2 })
    expect(answer.note).toBe(VOICE_MEMORY_SCOPE)
  })

  it('a words line removed is WORDS_MISSING with its seq', async () => {
    const { vfs, items } = await home(4)
    const lines = String(vfs.readFileSync(VOICE_MEMORY_WORDS, 'utf8')).split('\n')
    vfs.writeFileSync(VOICE_MEMORY_WORDS, lines.filter((_, index) => index !== 2).join('\n'))
    expect(await run(vfs, () => edgeAt(items, 4), { action: 'verify' })).toMatchObject({ verdict: 'WORDS_MISSING', seqs: [3] })
  })

  it('the edge unreachable (or answering without its memory head) is EDGE_UNREACHABLE: unknown, never a pass', async () => {
    const { vfs } = await home(2)
    for (const status of [() => Promise.reject(new Error('offline')), () => Promise.resolve({ ok: true }), () => Promise.resolve({ memory: { seq: 2, digest12: 'XYZ' } })]) {
      const answer = await run(vfs, status, { action: 'verify' })
      expect(answer.verdict).toBe('EDGE_UNREACHABLE')
      expect(String(answer.verdict).startsWith('INTACT')).toBe(false)
    }
  })

  it('tail, search and head read; an unknown action is refused by the tool with a closed code', async () => {
    const { vfs } = await home(4)
    const tail = await run(vfs, () => Promise.reject(new Error('unused')), { action: 'tail', n: 2 })
    expect(tail.exchanges).toEqual([
      { seq: 3, age: '2 h ago', ended: 'answered', path: 'fast', heard: 'heard 3 about the garden', said: 'said 3' },
      { seq: 4, age: '2 h ago', ended: 'answered', path: 'fast', heard: 'heard 4 about the garden', said: 'said 4' },
    ])
    const found = await run(vfs, () => Promise.reject(new Error('unused')), { action: 'search', q: 'GARDEN' })
    expect((found.hits as Array<{ seq: number }>).map(hit => hit.seq)).toEqual([4, 3, 2, 1])
    expect(await run(vfs, () => Promise.reject(new Error('unused')), { action: 'head' })).toMatchObject({ ok: true, seq: 4 })
    for (const args of [{ action: 'delete' }, {}, { action: 'tail', n: 21 }, { action: 'search', q: '' }]) {
      const answer = await run(vfs, () => Promise.reject(new Error('unused')), args)
      expect(answer.ok).toBe(false)
      expect(String(answer.code)).toMatch(/^VOICE_MEMORY_[A-Z_]+$/)
      expect(answer.note).toBe(VOICE_MEMORY_SCOPE)
    }
  })
})

describe('the verifier never reports a comparison that did not happen', () => {
  const now = 1_763_294_400_000 + 3 * 3600_000
  /** The edge's managed_status as voice-bridge.mjs handleManagedStatus answers it (switch, then the memory block). */
  const status = async (items: Awaited<ReturnType<typeof chainOf>>, seq: number, extra: Record<string, unknown> = {}) => ({
    switch: 'on', live: 0, memory: { seq, digest12: seq === 0 ? '0'.repeat(12) : (await recordDigest(items[seq - 1]?.record)).slice(0, 12), synced: seq,
      unsynced: 0, gapFrom: null, adoptedFromHome: false, fork: false, ...extra } })
  const run = (vfs: MemoryVfs, edge: () => Promise<unknown>, args: Record<string, unknown>) =>
    runVoiceMemoryTool({ vfs, edgeStatus: edge, nowMs: () => now }, args)
  /** The default block the edge sends when it never read the bridge (voice-bridge.mjs VOICE_MEMORY_EMPTY). */
  const EMPTY = { seq: 0, digest12: '000000000000', synced: 0, unsynced: 0, gapFrom: null, adoptedFromHome: false, fork: false }

  it('home 1: the switch off (the bridge never read) is EDGE_UNREACHABLE, with an empty home and with a home ahead', async () => {
    const empty = new MemoryVfs()
    expect(await run(empty, async () => ({ switch: 'off', live: 0, memory: EMPTY }), { action: 'verify' })).toMatchObject({ verdict: 'EDGE_UNREACHABLE' })
    const vfs = new MemoryVfs()
    await appendVoiceMemory(vfs, await chainOf(3))
    for (const edge of [{ switch: 'off', live: 0, memory: EMPTY }, { live: 0, memory: EMPTY }, { switch: 'on', memory: null }]) {
      const answer = await run(vfs, async () => edge, { action: 'verify' })
      expect(answer.verdict).toBe('EDGE_UNREACHABLE')
    }
  })

  it('home 2: an exchange replaced by a gap record is named in every verify answer (gaps and their count), and in tail and search', async () => {
    const vfs = new MemoryVfs()
    const items = await chainOf(3)
    await appendVoiceMemory(vfs, items)
    const chain = String(vfs.readFileSync(VOICE_MEMORY_CHAIN, 'utf8')).split('\n')
    const gap = { v: 1, kind: 'gap', seq: 2, prev: await recordDigest(items[1]?.record), at: 0, missingFrom: 2, missingTo: 2 }
    chain[1] = canonical(gap)
    vfs.writeFileSync(VOICE_MEMORY_CHAIN, chain.join('\n'))
    const words = String(vfs.readFileSync(VOICE_MEMORY_WORDS, 'utf8')).split('\n')
    vfs.writeFileSync(VOICE_MEMORY_WORDS, words.filter((_, index) => index !== 1).join('\n'))
    const answer = await run(vfs, () => status(items, 3), { action: 'verify' })
    expect(answer).toMatchObject({ gaps: [{ from: 2, to: 2 }], gapCount: 1 })
    expect(String(answer.gapsWhy)).toContain('no digest')
    // In step with an edge that holds no gap: still names it.
    const tail = await run(vfs, () => Promise.reject(new Error('unused')), { action: 'tail', n: 5 })
    expect(tail.gaps).toEqual([{ from: 2, to: 2 }])
    const found = await run(vfs, () => Promise.reject(new Error('unused')), { action: 'search', q: 'garden' })
    expect(found.gaps).toEqual([{ from: 2, to: 2 }])
    // A chain without a gap says so: an empty list, a zero count.
    const clean = new MemoryVfs()
    await appendVoiceMemory(clean, items)
    expect(await run(clean, () => status(items, 3), { action: 'verify' })).toMatchObject({ verdict: 'INTACT_MATCHES_EDGE', gaps: [], gapCount: 0 })
  })

  it('home 4: the edge marking a fork is FORK_AT its seq, even when the digest at that seq matches', async () => {
    const vfs = new MemoryVfs()
    const items = await chainOf(3)
    await appendVoiceMemory(vfs, items)
    const answer = await run(vfs, () => status(items, 1, { fork: true }), { action: 'verify' })
    expect(answer).toMatchObject({ verdict: 'FORK_AT', seq: 1 })
    expect(String(answer.verdict).startsWith('INTACT')).toBe(false)
  })
})
