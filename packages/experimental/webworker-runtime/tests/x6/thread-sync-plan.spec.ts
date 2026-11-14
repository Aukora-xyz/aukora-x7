import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferredJournal } from '../../src/storage/idb-persist.ts'
import {
  classifyThreadReply, halve, lastLineEnd, laneFooter, laneMark, localFacts, mayStartTurn, nextHave, partHashes, partsForAppend,
  planThread, rollingChain, tailShaOf, threadIdFor, threadPathAllowed, withOverlap, ZERO_CHAIN,
  type LocalThreadFacts, type ThreadCursor, type ThreadLaneMark, type ThreadManifest, type ThreadPair, type ThreadReplyKind,
  type ThreadRun, type ThreadStep,
} from '../../src/storage/thread-sync-plan.ts'

// Small pieces through the parameter; the hashes below are computed with node:crypto, independently of the module.
const P = 16
const ME = 'browser-me'
const OTHER = 'browser-other'
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const concat = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])
const startsWith = (whole: Uint8Array, head: Uint8Array): boolean => whole.byteLength >= head.byteLength
  && sameBytes(whole.subarray(0, head.byteLength), head)
const commonPrefix = (a: Uint8Array, b: Uint8Array): number => {
  let n = 0
  while (n < a.byteLength && n < b.byteLength && a[n] === b[n]) n++
  return n
}
/** Four-byte lines: "a00\n", "a01\n", ... */
const stream = (letter: string, count: number, start = 0): string =>
  Array.from({ length: count }, (_, i) => `${letter}${String(start + i).padStart(2, '0')}\n`).join('')
const S = enc(stream('a', 30)) // 120 bytes
const chainOf = (parts: readonly string[]): string => {
  let chain = Buffer.alloc(32)
  for (const part of parts) chain = createHash('sha256').update(Buffer.concat([chain, Buffer.from(part, 'hex')])).digest()
  return chain.toString('hex')
}
interface ManifestOptions { sealed?: number; run?: ThreadRun; keptCount?: number; piece?: number }
/** The edge's manifest for these cloud bytes, with `sealed` bytes sealed (default: the fewest leaving an open end under 2 P). */
function manifestOf(cloud: Uint8Array, opts: ManifestOptions = {}): ThreadManifest {
  const piece = opts.piece ?? P
  const sealed = opts.sealed ?? Math.max(0, Math.floor(cloud.byteLength / piece) - 1) * piece
  if (sealed % piece !== 0 || sealed > cloud.byteLength || cloud.byteLength - sealed >= 2 * piece) throw new Error('bad seal in fixture')
  const parts = Array.from({ length: sealed / piece }, (_, i) => sha(cloud.subarray(i * piece, (i + 1) * piece)))
  return {
    piece, bytes: cloud.byteLength, lineEnd: cloud.lastIndexOf(10) + 1, sealedBytes: sealed, partCount: parts.length, parts,
    chain: chainOf(parts), tailSha: sha(cloud.subarray(sealed)), run: opts.run ?? { client: OTHER, from: 0 },
    keptCount: opts.keptCount ?? 0,
  }
}
const pairOf = (m: ThreadPair): ThreadPair =>
  ({ bytes: m.bytes, lineEnd: m.lineEnd, sealedBytes: m.sealedBytes, chain: m.chain, tailSha: m.tailSha })
interface PlanExtra { cursor?: ThreadCursor | null; me?: string; isWriter?: boolean; wanted?: boolean; now?: number }
const plan = (local: LocalThreadFacts | null, cloud: ThreadManifest | null, extra: PlanExtra = {}): ThreadStep =>
  planThread({ local, cloud, cursor: null, me: ME, isWriter: true, wanted: true, now: 10_000, ...extra })

afterEach(() => { vi.restoreAllMocks() })

describe('hashing helpers', () => {
  it('rollingChain matches hand-computed values for 0, 1 and 3 parts', async () => {
    const parts = [
      'fed7f05c10bc95d597e6f8103228c4c10798b5f77215f718a854534da563dc9e', // sha256("part one")
      'ea5683cba58035f4f3b937023cba704f0be4766baca5dd4deee460bdd1091741', // sha256("part two")
      'ada50775354632e4d20ff4c942ccb785bc1b5f15a699586eeb6eaa34d2a5f835', // sha256("part three")
    ]
    expect(await rollingChain([])).toBe('0000000000000000000000000000000000000000000000000000000000000000')
    expect(await rollingChain([])).toBe(ZERO_CHAIN)
    expect(await rollingChain(parts.slice(0, 1))).toBe('f3136c77b7ae6cb29843aad885c36bc8afdb47564c18530d11da13179810540c')
    expect(await rollingChain(parts)).toBe('bb60795892c86fd6751481c122868c31bacc3d45021f350f767820fa8a6a7874')
    await expect(rollingChain(['not-hex'])).rejects.toThrow(/SHA-256/)
  })

  it('threadPathAllowed agrees with the journal lane rule of idb-persist on 12 paths', () => {
    const paths = [
      '/dsh/home/sessions/proj/abc/session.v4.jsonl',
      '/dsh/home/sessions/proj/abc/session.v10.jsonl',
      '/dsh/home/auma/session/messages.jsonl',
      '/dsh/home/sessions/proj/session.v4.jsonl',
      '/dsh/home/sessions/proj/abc/def/session.v4.jsonl',
      '/dsh/home/sessions/proj/abc/session.vx.jsonl',
      '/dsh/home/sessions/proj/abc/session.v4.json',
      '/dsh/home/auma/private/session/messages.jsonl',
      '/dsh/home/auma/session/messages.jsonl.bak',
      'dsh/home/sessions/p/i/session.v4.jsonl',
      '/dsh/home/sessions//abc/session.v4.jsonl',
      '/dsh/workspace/sessions/p/i/session.v4.jsonl',
    ]
    for (const path of paths) expect([path, threadPathAllowed(path)]).toEqual([path, deferredJournal(path, 3 * 1024 * 1024)])
    expect(paths.filter(threadPathAllowed)).toHaveLength(3)
  })

  it('threadIdFor, partHashes, tailShaOf and lastLineEnd', async () => {
    const path = '/dsh/home/sessions/p/i/session.v4.jsonl'
    expect(await threadIdFor(path)).toBe(sha(enc(path)))
    expect(await partHashes(S, P)).toEqual(Array.from({ length: 7 }, (_, i) => sha(S.subarray(i * P, (i + 1) * P))))
    expect(await partHashes(S.subarray(0, 15), P)).toEqual([])
    expect(await tailShaOf(S, 96, 120)).toBe(sha(S.subarray(96, 120)))
    expect(await tailShaOf(S, 96, 96)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(lastLineEnd(enc('a\nbc'))).toBe(2)
    expect(lastLineEnd(enc('abc'))).toBe(0)
    expect(lastLineEnd(enc('a\n'))).toBe(2)
  })

  it('localFacts with cachedParts gives the same answer and hashes fewer bytes; no byte is hashed more than twice', async () => {
    const cloud = manifestOf(S, { sealed: 96 })
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const hashed = (): number => digest.mock.calls.reduce((sum, call) => sum + (call[1] as Uint8Array).byteLength, 0)
    const cold = await localFacts(S, cloud)
    const coldCalls = digest.mock.calls.length
    const coldBytes = hashed()
    digest.mockClear()
    const warm = await localFacts(S, cloud, { cachedParts: cold.parts })
    expect(warm).toEqual(cold)
    expect(cold.extendsCloud).toBe(true)
    expect(coldCalls).toBe(8) // 7 full pieces and the cloud's open end
    expect(digest.mock.calls.length).toBe(1)
    expect(hashed()).toBeLessThan(coldBytes)
    expect(coldBytes).toBeLessThanOrEqual(2 * S.byteLength)
  })

  it('nextHave is <chain>.<tailSha> of the reply', () => {
    const m = manifestOf(S)
    expect(nextHave({ ...pairOf(m) })).toBe(`${m.chain}.${m.tailSha}`)
    expect(() => nextHave({ chain: 'x', tailSha: m.tailSha })).toThrow()
  })
})

describe('planThread: one step per row', () => {
  it('first upload: no cloud copy, append from 0 to the last newline', async () => {
    const local = await localFacts(concat(S, enc('torn')), null, { piece: P })
    expect(plan(local, null)).toEqual({ do: 'append', from: 0, to: 120 })
    expect(plan(local, null, { isWriter: false })).toEqual({ do: 'reader' })
  })

  it('a plain append stops at the last newline: a torn last line is never sent', async () => {
    const bytes = concat(S, enc('b00\nb01\nhalf a li'))
    const cloud = manifestOf(S)
    const local = await localFacts(bytes, cloud)
    expect(local.extendsCloud).toBe(true)
    const step = plan(local, cloud)
    expect(step).toEqual({ do: 'append', from: 120, to: 128 })
    expect(step.do === 'append' && step.to).not.toBe(bytes.byteLength)
  })

  it('nothing when equal, when only a torn line is new, or when both are absent', async () => {
    const cloud = manifestOf(S)
    expect(plan(await localFacts(S, cloud), cloud)).toEqual({ do: 'nothing' })
    expect(plan(await localFacts(concat(S, enc('torn')), cloud), cloud)).toEqual({ do: 'nothing' })
    expect(plan(null, null)).toEqual({ do: 'nothing' })
  })

  it('a reader with unsent lines keeps them here', async () => {
    const cloud = manifestOf(S)
    const local = await localFacts(concat(S, enc('b00\n')), cloud)
    expect(plan(local, cloud, { isWriter: false })).toEqual({ do: 'reader' })
  })

  it('pull from zero only when wanted; otherwise only the card', () => {
    const cloud = manifestOf(S)
    expect(plan(null, cloud, { wanted: true })).toEqual({ do: 'pull', from: 0, compareTo: 0 })
    expect(plan(null, cloud, { wanted: false })).toEqual({ do: 'card-only' })
  })

  it('pull for a shorter file starts at provenBytes and compares up to local.bytes, in three shapes', async () => {
    const cloud = manifestOf(S, { sealed: 96 })
    const insideSealed = await localFacts(S.subarray(0, 40), cloud)
    expect(insideSealed.provenBytes).toBe(32)
    expect(plan(insideSealed, cloud)).toEqual({ do: 'pull', from: 32, compareTo: 40 })
    const insideOpen = await localFacts(S.subarray(0, 100), cloud)
    expect(insideOpen.provenBytes).toBe(96)
    expect(plan(insideOpen, cloud)).toEqual({ do: 'pull', from: 96, compareTo: 100 })
    const onBoundary = await localFacts(S.subarray(0, 64), cloud)
    expect(onBoundary.provenBytes).toBe(64)
    expect(plan(onBoundary, cloud)).toEqual({ do: 'pull', from: 64, compareTo: 64 })
    for (const facts of [insideSealed, insideOpen, onBoundary]) expect(plan(facts, cloud, { isWriter: false }).do).toBe('pull')
  })

  it('cloudExtendsLocal is false for a true prefix ending inside a piece, true on a sealed boundary with equal hashes', async () => {
    const cloud = manifestOf(S, { sealed: 96 })
    const inside = await localFacts(S.subarray(0, 40), cloud)
    expect(sameBytes(S.subarray(0, 40), S.subarray(0, 40))).toBe(true)
    expect(inside).toMatchObject({ extendsCloud: false, cloudExtendsLocal: false, forkAt: null, provenBytes: 32 })
    const open = await localFacts(S.subarray(0, 100), cloud)
    expect(open).toMatchObject({ extendsCloud: false, cloudExtendsLocal: false, forkAt: null })
    expect(await localFacts(S.subarray(0, 64), cloud)).toMatchObject({ extendsCloud: false, cloudExtendsLocal: true, forkAt: null })
  })

  it('a shorter file that forks inside its last partial piece is never extended: compare, then keep-mine', async () => {
    const cloudBytes = S
    const cloud = manifestOf(cloudBytes, { sealed: 96 })
    const bytes = concat(S.subarray(0, 36), enc('zz\n')) // pieces 0 and 1 match; the fork is in partial piece 2
    const before = bytes.slice()
    const local = await localFacts(bytes, cloud)
    expect(local).toMatchObject({ forkAt: null, provenBytes: 32, cloudExtendsLocal: false })
    const step = plan(local, cloud)
    expect(step).toEqual({ do: 'pull', from: 32, compareTo: 39 })
    // The model caller: compare the overlap, add nothing when it differs, report it.
    if (step.do !== 'pull') throw new Error('expected a pull')
    const equal = sameBytes(bytes.subarray(step.from, step.compareTo), cloudBytes.subarray(step.from, step.compareTo))
    expect(equal).toBe(false)
    const reported = withOverlap(local, { from: step.from, to: step.compareTo, equal })
    expect(reported.forkAt).toBe(32)
    expect(plan(reported, cloud)).toEqual({ do: 'keep-mine', forkAt: 32, then: 'pull' })
    expect(plan(reported, cloud, { isWriter: false })).toEqual({ do: 'reader' })
    expect(sameBytes(bytes, before)).toBe(true)
  })

  it('an overlap reported equal proves the file; a stale report changes nothing', async () => {
    const cloud = manifestOf(S, { sealed: 96 })
    const local = await localFacts(S.subarray(0, 40), cloud)
    const proven = withOverlap(local, { from: 32, to: 40, equal: true })
    expect(proven).toMatchObject({ provenBytes: 40, cloudExtendsLocal: true, forkAt: null })
    expect(plan(proven, cloud)).toEqual({ do: 'pull', from: 40, compareTo: 40 })
    expect(withOverlap(local, { from: 16, to: 40, equal: false })).toBe(local)
    expect(withOverlap(local, { from: 32, to: 39, equal: false })).toBe(local)
    expect(withOverlap(local, { from: 32, to: 44, equal: true })).toBe(local)
    const forked = withOverlap(local, { from: 32, to: 40, equal: false })
    expect(withOverlap(forked, { from: 32, to: 40, equal: true })).toBe(forked)
  })

  it('roll-back: wait before 2 s (by now), then retract this browser\'s own lines', async () => {
    const cloud = manifestOf(S, { sealed: 96, run: { client: ME, from: 100 } })
    const local = await localFacts(S.subarray(0, 108), cloud)
    const cursor = { acked: 120, settledAt: 1_000 }
    expect(plan(local, cloud, { cursor, now: 2_999 })).toEqual({ do: 'wait' })
    expect(plan(local, cloud, { cursor, now: 3_000 })).toEqual({ do: 'retract', forkAt: 108 })
    expect(plan(local, cloud, { cursor, now: 3_000, isWriter: false })).toEqual({ do: 'pull', from: 96, compareTo: 108 })
    expect(plan(local, cloud, { cursor, now: 3_000, me: OTHER })).toEqual({ do: 'pull', from: 96, compareTo: 108 })
    expect(plan(local, cloud, { cursor: { acked: 116, settledAt: 1_000 }, now: 1_500 })).toEqual({ do: 'pull', from: 96, compareTo: 108 })
  })

  it('a fork inside this browser\'s own newest run gives retract', async () => {
    const cloud = manifestOf(S, { sealed: 96, run: { client: ME, from: 96 } })
    const local = await localFacts(concat(S.subarray(0, 100), enc(stream('b', 6))), cloud)
    expect(local.forkAt).toBe(96)
    expect(plan(local, cloud)).toEqual({ do: 'retract', forkAt: 96 })
  })

  it('a fork in another client\'s lines, or in sealed parts, gives keep-mine then pull', async () => {
    const foreign = manifestOf(S, { sealed: 96, run: { client: OTHER, from: 96 } })
    const local = await localFacts(concat(S.subarray(0, 100), enc(stream('b', 6))), foreign)
    expect(plan(local, foreign)).toEqual({ do: 'keep-mine', forkAt: 96, then: 'pull' })
    const own = manifestOf(S, { sealed: 96, run: { client: ME, from: 0 } })
    const changed = S.slice()
    changed[20] = 'z'.charCodeAt(0)
    const sealedFork = await localFacts(changed, own)
    expect(sealedFork.forkAt).toBe(16)
    expect(plan(sealedFork, own)).toEqual({ do: 'keep-mine', forkAt: 16, then: 'pull' })
  })

  it('a non-writer never gets append or retract', async () => {
    const cases: Array<[Uint8Array | null, ThreadManifest | null, ThreadCursor | null]> = [
      [S, null, null],
      [concat(S, enc('b00\n')), manifestOf(S), null],
      [concat(S.subarray(0, 100), enc(stream('b', 6))), manifestOf(S, { sealed: 96, run: { client: ME, from: 96 } }), null],
      [S.subarray(0, 108), manifestOf(S, { sealed: 96, run: { client: ME, from: 100 } }), { acked: 120, settledAt: 0 }],
      [null, manifestOf(S), null],
    ]
    for (const [bytes, cloud, cursor] of cases) {
      const local = bytes === null ? null : await localFacts(bytes, cloud, { piece: P })
      for (const now of [500, 10_000]) {
        expect(['append', 'retract', 'keep-mine']).not.toContain(plan(local, cloud, { cursor, now, isWriter: false }).do)
      }
    }
  })
})

describe('mayStartTurn', () => {
  it('false for a reader, a writer behind the cloud, a writer that forks; true when equal, ahead or alone', async () => {
    const behindCloud = manifestOf(enc(stream('a', 248)).subarray(0, 992), { run: { client: OTHER, from: 0 } })
    const behind = await localFacts(enc(stream('a', 48)), behindCloud) // 200 lines behind, proven to its end
    expect(behind.cloudExtendsLocal).toBe(true)
    expect(mayStartTurn({ local: behind, cloud: behindCloud, isWriter: true })).toBe(false)
    const cloud = manifestOf(S)
    const equal = await localFacts(S, cloud)
    expect(mayStartTurn({ local: equal, cloud, isWriter: false })).toBe(false)
    const forked = await localFacts(concat(S.subarray(0, 100), enc(stream('b', 6))), cloud)
    expect(mayStartTurn({ local: forked, cloud, isWriter: true })).toBe(false)
    expect(mayStartTurn({ local: equal, cloud, isWriter: true })).toBe(true)
    expect(mayStartTurn({ local: await localFacts(concat(S, enc('b00\n')), cloud), cloud, isWriter: true })).toBe(true)
    expect(mayStartTurn({ local: await localFacts(S, null, { piece: P }), cloud: null, isWriter: true })).toBe(true)
    expect(mayStartTurn({ local: null, cloud: null, isWriter: true })).toBe(true)
    expect(mayStartTurn({ local: null, cloud, isWriter: true })).toBe(false)
  })
})

describe('a seal in the middle of an append', () => {
  it('the reply pair moves sealedBytes; facts against it still extend the cloud; the next step appends with nextHave', async () => {
    const cloudBytes = S.subarray(0, 40)
    const manifest = manifestOf(cloudBytes, { sealed: 16, run: { client: ME, from: 0 } })
    const local72 = await localFacts(S.subarray(0, 72), manifest)
    expect(plan(local72, manifest)).toEqual({ do: 'append', from: 40, to: 72 })
    // The edge applies it and seals two more parts in the same request.
    const after = manifestOf(S.subarray(0, 72), { sealed: 48, run: { client: ME, from: 0 } })
    const reply = { code: 'APPLIED', ...pairOf(after) }
    expect(reply.sealedBytes).not.toBe(manifest.sealedBytes)
    expect(classifyThreadReply(200, reply.code)).toBe('done')
    const merged: ThreadManifest = { ...manifest, ...pairOf(reply) } // its parts list is now stale
    const grown = S.subarray(0, 80)
    const facts = await localFacts(grown, merged)
    expect(facts.extendsCloud).toBe(true)
    expect(plan(facts, merged)).toEqual({ do: 'append', from: 72, to: 80 })
    const have = `${await rollingChain(facts.parts.slice(0, 3))}.${await tailShaOf(grown, 48, 72)}`
    expect(nextHave(reply)).toBe(have)
  })
})

/** A deterministic generator (mulberry32). */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface World { local: Uint8Array | null; cloud: Uint8Array | null; sealed: number; run: ThreadRun; piece: number }
interface Drive { me: string; isWriter: boolean; wanted: boolean; cursor: ThreadCursor | null; now: number }

/**
 * A model caller that follows the steps to the end against a model edge, asserting the two promises at every step:
 * local bytes only grow, except bytes from a keep-mine's forkAt after the keep is acknowledged (and kept); a pull adds
 * only after an overlap compared equal, and what it adds leaves no splice (the file then equals the cloud's).
 */
async function follow(world: World, drive: Drive): Promise<ThreadStep[]> {
  const steps: ThreadStep[] = []
  let override: LocalThreadFacts | null = null
  for (let round = 0; round < 40; round++) {
    const cloud = world.cloud === null ? null : manifestOf(world.cloud, { sealed: world.sealed, run: world.run, piece: world.piece })
    const facts = override ?? (world.local === null ? null : await localFacts(world.local, cloud, { piece: world.piece }))
    override = null
    if (facts !== null && world.local !== null && world.cloud !== null) {
      expect(facts.provenBytes).toBeLessThanOrEqual(commonPrefix(world.local, world.cloud))
    }
    const step = planThread({ local: facts, cloud, ...drive })
    steps.push(step)
    const before = world.local
    switch (step.do) {
      case 'nothing':
        if (drive.isWriter && facts !== null && cloud !== null) expect(facts.extendsCloud).toBe(true)
        return steps
      case 'reader':
      case 'card-only':
      case 'wait':
        return steps
      case 'append': {
        expect(drive.isWriter).toBe(true)
        const local = before!
        expect(step.from).toBe(world.cloud?.byteLength ?? 0)
        expect(startsWith(local, world.cloud ?? new Uint8Array())).toBe(true) // the edge's `have` check would pass
        expect(step.to).toBeLessThanOrEqual(facts!.lineEnd)
        expect(local[step.to - 1]).toBe(10)
        world.cloud = concat(world.cloud ?? new Uint8Array(), local.subarray(step.from, step.to))
        if (world.run.client !== drive.me) world.run = { client: drive.me, from: step.from }
        world.sealed = Math.max(world.sealed, Math.max(0, Math.floor(world.cloud.byteLength / world.piece) - 1) * world.piece)
        break
      }
      case 'retract': {
        expect(drive.isWriter).toBe(true)
        expect(step.forkAt).toBeGreaterThanOrEqual(world.sealed)
        expect(step.forkAt).toBeGreaterThanOrEqual(world.run.from)
        expect(world.run.client).toBe(drive.me)
        world.cloud = world.cloud!.slice(0, step.forkAt)
        world.run = { client: world.run.client, from: Math.min(world.run.from, step.forkAt) }
        break
      }
      case 'keep-mine': {
        expect(drive.isWriter).toBe(true)
        const local = before!
        const kept = local.slice(step.forkAt) // stored in the vault; the model edge acknowledges the keep
        expect(sameBytes(local.subarray(0, step.forkAt), world.cloud!.subarray(0, step.forkAt))).toBe(true)
        world.local = concat(local.subarray(0, step.forkAt), world.cloud!.subarray(step.forkAt))
        expect(sameBytes(concat(world.local.subarray(0, step.forkAt), kept), local)).toBe(true)
        break
      }
      case 'pull': {
        const cloudNow = world.cloud!
        if (before === null) {
          expect([step.from, step.compareTo]).toEqual([0, 0])
          world.local = cloudNow.slice()
          break
        }
        expect(step.from).toBeLessThanOrEqual(facts!.provenBytes)
        expect(step.compareTo).toBe(before.byteLength)
        expect(step.compareTo - step.from).toBeLessThan(2 * world.piece)
        const equal = sameBytes(before.subarray(step.from, step.compareTo), cloudNow.subarray(step.from, step.compareTo))
        if (equal) {
          world.local = concat(before, cloudNow.subarray(step.compareTo))
          expect(sameBytes(world.local, cloudNow)).toBe(true) // no spliced line
        } else {
          override = withOverlap(facts!, { from: step.from, to: step.compareTo, equal: false })
          expect(override.forkAt).toBe(step.from)
        }
        break
      }
    }
    if (step.do !== 'keep-mine' && before !== null && world.local !== null) expect(startsWith(world.local, before)).toBe(true)
  }
  throw new Error(`no end after 40 steps: ${JSON.stringify(steps.slice(-4))}`)
}

describe('property: 500 seeded (local, cloud) pairs with real bytes on both sides', () => {
  it('provenBytes never passes the true common prefix; pulls never start past it; the model caller loses nothing', async () => {
    const random = seeded(0x5eed_2026)
    const int = (n: number): number => Math.floor(random() * n)
    const lines = (count: number, alphabet: string): string => Array.from({ length: count }, () =>
      Array.from({ length: 1 + int(5) }, () => alphabet[int(alphabet.length)]).join('') + '\n').join('')
    const seen = new Set<string>()
    for (let trial = 0; trial < 500; trial++) {
      const piece = [4, 8, 16][int(3)]!
      const base = enc(lines(int(30), 'ab'))
      const shared = int(base.byteLength + 1)
      const forks = random() < 0.5
      let localBytes: Uint8Array | null = forks ? concat(base.subarray(0, shared), enc(lines(int(6), 'abc'))) : base.subarray(0, int(base.byteLength + 1))
      if (random() < 0.3) localBytes = concat(localBytes, enc('torn'.slice(0, 1 + int(4))))
      let cloudBytes: Uint8Array | null = forks ? concat(base.subarray(0, shared), enc(lines(int(6), 'abd'))) : base.subarray(0, base.lastIndexOf(10, int(base.byteLength + 1)) + 1)
      if (random() < 0.1) localBytes = null
      if (random() < 0.1) cloudBytes = null
      let sealed = 0
      if (cloudBytes !== null) {
        const most = Math.floor(cloudBytes.byteLength / piece)
        sealed = Math.max(0, most - int(2)) * piece
        if (cloudBytes.byteLength - sealed >= 2 * piece) sealed = most * piece
      }
      const cloudLength = cloudBytes?.byteLength ?? 0
      const run = { client: random() < 0.5 ? ME : OTHER, from: int(cloudLength + 1) }
      const cursor = random() < 0.4 ? { acked: random() < 0.7 ? cloudLength : int(cloudLength + 1), settledAt: 1_000 } : null
      const drive: Drive = { me: ME, isWriter: random() < 0.7, wanted: random() < 0.7, cursor, now: 1_000 + int(4_000) }

      if (localBytes !== null && cloudBytes !== null) {
        const facts = await localFacts(localBytes, manifestOf(cloudBytes, { sealed, run, piece }))
        const common = commonPrefix(localBytes, cloudBytes)
        expect(facts.provenBytes).toBeLessThanOrEqual(common)
        if (facts.extendsCloud) expect(startsWith(localBytes, cloudBytes)).toBe(true)
        if (facts.cloudExtendsLocal) expect(startsWith(cloudBytes, localBytes)).toBe(true)
        if (facts.forkAt !== null) {
          expect(facts.forkAt).toBeLessThanOrEqual(common)
          expect(common).toBeLessThan(Math.min(localBytes.byteLength, cloudBytes.byteLength))
        }
      }
      const steps = await follow({ local: localBytes, cloud: cloudBytes, sealed, run, piece }, drive)
      for (const step of steps) seen.add(step.do)
    }
    // The seeds reach every step.
    expect([...seen].sort()).toEqual(['append', 'card-only', 'keep-mine', 'nothing', 'pull', 'reader', 'retract', 'wait'])
  })
})

describe('classifyThreadReply', () => {
  const MEMBERS: readonly ThreadReplyKind[] = [
    'done', 'resend-from', 'locate', 'reader', 'smaller', 'again', 'wait-until', 'cloud-full', 'reload', 'sign-in', 'held',
  ]
  /** Exhaustive with no default branch: a new member (say, a stop for good) fails to compile here. */
  const meaning = (kind: ThreadReplyKind): string => {
    switch (kind) {
      case 'done': return 'applied'
      case 'resend-from': return 'resend from the cloud length'
      case 'locate': return 'recompute facts, plan again'
      case 'reader': return 'read only'
      case 'smaller': return 'halve the slice'
      case 'again': return 'retry'
      case 'wait-until': return 'retry at the time given'
      case 'cloud-full': return 'keep here, cloud is full'
      case 'reload': return 'reload the app'
      case 'sign-in': return 'sign in again'
      case 'held': return 'keep here until Send now'
    }
  }

  it('every status from 200 to 599 with seven codes is a member of the list', () => {
    const codes = [undefined, null, 'APPLIED', 'ALREADY', 'GAP', 'DIVERGED', 'OWNER_SESSION_UNAVAILABLE']
    for (let status = 200; status <= 599; status++) {
      for (const code of codes) expect(MEMBERS).toContain(classifyThreadReply(status, code))
    }
    expect(MEMBERS.map(meaning)).toHaveLength(11)
  })

  it('maps each named answer', () => {
    expect(classifyThreadReply(200, 'APPLIED')).toBe('done')
    expect(classifyThreadReply(200, 'ALREADY')).toBe('done')
    expect(classifyThreadReply(409, 'GAP')).toBe('resend-from')
    expect(classifyThreadReply(409, 'DIVERGED')).toBe('locate')
    for (const code of ['LEASE', undefined]) expect(classifyThreadReply(423, code)).toBe('reader')
    expect(classifyThreadReply(410)).toBe('reader')
    expect(classifyThreadReply(413)).toBe('smaller')
    expect(classifyThreadReply(408)).toBe('again')
    for (const code of ['SEAL_PENDING', 'THREAD_MOVED', 'OWNER_SESSION_UNAVAILABLE']) expect(classifyThreadReply(503, code)).toBe('again')
    for (const status of [500, 502, 504, 599]) expect(classifyThreadReply(status)).toBe('again')
    expect(classifyThreadReply(0)).toBe('again') // a network error
    expect(classifyThreadReply(429)).toBe('wait-until')
    expect(classifyThreadReply(507, 'ANY')).toBe('cloud-full')
    expect(classifyThreadReply(426)).toBe('reload')
    expect(classifyThreadReply(401)).toBe('sign-in')
    expect(classifyThreadReply(200, 'SOMETHING_NEW')).toBe('again')
    expect(classifyThreadReply(409, 'SOMETHING_NEW')).toBe('again')
  })

  it('400, 403, 404, 422, 424 are held and never again; 503 OWNER_SESSION_UNAVAILABLE is again, never sign-in', () => {
    for (const status of [400, 403, 404, 422, 424]) {
      for (const code of [undefined, 'X', 'OWNER_SESSION_UNAVAILABLE']) {
        expect(classifyThreadReply(status, code)).toBe('held')
        expect(classifyThreadReply(status, code)).not.toBe('again')
      }
    }
    expect(classifyThreadReply(503, 'OWNER_SESSION_UNAVAILABLE')).toBe('again')
    expect(classifyThreadReply(503, 'OWNER_SESSION_UNAVAILABLE')).not.toBe('sign-in')
  })
})

describe('lane marks', () => {
  const at = (hours: number, minutes: number): number => new Date(2026, 10, 12, hours, minutes).getTime()
  const base = { lastReply: null, retryAt: null, isWriter: true, loading: null, now: at(14, 2) }

  it('shows each exact text', async () => {
    const cloud = manifestOf(S)
    const equal = await localFacts(S, cloud)
    const ahead = await localFacts(concat(S, enc('b00\nb01\nb02\ntorn')), cloud)
    const texts: ThreadLaneMark[] = [
      laneMark({ ...base, local: equal, cloud, lastReply: { kind: 'done', at: at(14, 2) }, now: at(15, 30) })!,
      laneMark({ ...base, local: ahead, cloud })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'again', at: 1 } })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'sign-in', at: 1 } })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'wait-until', at: 1 }, retryAt: at(9, 0) })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'cloud-full', at: 1 } })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'held', at: 1 } })!,
      laneMark({ ...base, local: null, cloud })!,
      laneMark({ ...base, local: null, cloud, loading: { received: 40_200_000, total: 96_497_618 } })!,
      laneMark({ ...base, local: ahead, cloud, isWriter: false })!,
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'held', code: 'HOME_PENDING', at: 1 } })!,
      laneMark({ ...base, local: equal, cloud: { ...cloud, keptCount: 2 } })!,
    ]
    expect(texts.map(mark => [mark.text, mark.action])).toEqual([
      ['In the cloud · 14:02', undefined],
      ['Saving · 3 lines to go', undefined],
      ['Only in this browser · offline', 'Send now'],
      ['Only in this browser · sign in again', 'Send now'],
      ['Only in this browser · until 09:00', 'Send now'],
      ['Only in this browser · cloud is full', 'Send now'],
      ['Only in this browser · held', 'Send now'],
      ['In the cloud · not on this device yet', undefined],
      ['Loading this thread: 40 of 96 MB', undefined],
      ['Answering in another browser', undefined],
      ['This browser is not saving to her cloud', undefined],
      ['2 messages kept beside', 'Show'],
    ])
    for (const mark of texts) expect(mark.text.toLowerCase()).not.toContain(['to', 'ken'].join(''))
    expect(laneMark({ ...base, local: null, cloud: null })).toBeNull()
  })

  it('refuses "In the cloud" when cloud.lineEnd is behind, even after a done reply', async () => {
    const cloud = manifestOf(S)
    const ahead = await localFacts(concat(S, enc('b00\n')), cloud)
    const mark = laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'done', at: at(14, 2) } })!
    expect(mark.text).not.toMatch(/^In the cloud/)
    expect(mark.counts).toBe('browser')
    const forked = await localFacts(concat(S.subarray(0, 100), enc(stream('b', 6))), cloud)
    expect(laneMark({ ...base, local: forked, cloud, lastReply: { kind: 'done', at: 1 } })!.text).not.toMatch(/^In the cloud/)
  })

  it('the footer counts threads, the ones in the cloud and the ones only here', async () => {
    const cloud = manifestOf(S)
    const equal = await localFacts(S, cloud)
    const ahead = await localFacts(concat(S, enc('b00\n')), cloud)
    const marks = [
      ...Array.from({ length: 16 }, () => laneMark({ ...base, local: equal, cloud })),
      laneMark({ ...base, local: ahead, cloud, lastReply: { kind: 'again', at: 1 } }),
      laneMark({ ...base, local: null, cloud: null }),
    ]
    expect(laneFooter(marks)).toBe('17 threads · 16 in the cloud · 1 only in this browser')
  })
})

describe('append slices', () => {
  it('partsForAppend gives consecutive slices of at most a piece, the last ending at to; halve never goes under 64 KiB', () => {
    expect(partsForAppend(10, 45, 16)).toEqual([{ from: 10, to: 26 }, { from: 26, to: 42 }, { from: 42, to: 45 }])
    expect(partsForAppend(0, 32, 16)).toEqual([{ from: 0, to: 16 }, { from: 16, to: 32 }])
    expect(partsForAppend(5, 5, 16)).toEqual([])
    expect(() => partsForAppend(6, 5, 16)).toThrow()
    expect(halve(2_097_152)).toBe(1_048_576)
    expect(halve(100_000)).toBe(65_536)
    expect(halve(65_536)).toBe(65_536)
  })
})
