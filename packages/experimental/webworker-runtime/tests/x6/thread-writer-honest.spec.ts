/**
 * CARD 1.5 (the honest lane): the live sentence is measured, names its conversation, and never says "saved".
 *
 * This is a NEW file on purpose: `thread-writer.spec.ts` and `thread-writer-live.spec.ts` are frozen by the path fence, so
 * the defect fixed here can only be pinned here. The first case IS the defect. `planFor` returns before it counts
 * anything while a conversation is inside the settle window, so the planner's `pending` is 0 — and card 1's lane answered
 * "nothing new" or "saved" out of that 0. The lane must answer from the file's size and her cloud's own word instead.
 */
import { describe, expect, it } from 'vitest'

import { createThreadWriter, threadLabel } from '../../src/storage/thread-writer.ts'
import { threadSyncState } from '../../src/storage/thread-sync.ts'
import type { ThreadNetReply, ThreadPersistenceView, ThreadReadStore } from '../../src/storage/thread-store-types.ts'

const FILE = '/dsh/home/auma/session/messages.jsonl'
const ID = 'a'.repeat(64)
const TAIL = 'f'.repeat(64)
const CHAIN = 'e'.repeat(64)

const json = (value: unknown): ThreadNetReply => ({ status: 200, headers: new Headers(), bytes: new TextEncoder().encode(JSON.stringify(value)) })

/**
 * One journal the thread routes carry (`/dsh/home/<name>/session/messages.jsonl`), `size` bytes of plain lines. With
 * `measured: false` its size cannot be read at all, which is the case a lane used to report as "nothing new".
 */
const oneThread = (size: number, measured = true): ThreadReadStore => {
  const data = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) data[index] = index % 97 === 0 ? 0x0a : 0x61
  const dir = (path: string): boolean => path === '/dsh/home' || path === '/dsh/home/sessions' || path === '/dsh/home/auma' || path === '/dsh/home/auma/session'
  return {
    existsSync: (path: string) => path === FILE || dir(path),
    statSync: (path: string) => {
      if (path !== FILE) return { isFile: () => false, isDirectory: () => true, size: 0 }
      if (!measured) throw new Error('EIO')
      return { isFile: () => true, isDirectory: () => false, size }
    },
    readdirSync: (path: string) => path === '/dsh/home' ? ['auma'] : [],
    readFileSync: () => data,
  }
}

/** The live writer over one journal, with her cloud holding `cloudBytes` of it (null: nothing at all). */
const writerFor = (vfs: ThreadReadStore, cloudBytes: number | null, published: string[]): { step: () => Promise<string> } => {
  const cloud = new Map<string, { id: string; bytes: number; lineEnd: number; sealedBytes: number; chain: string; tailSha: string; activeAt: number }>()
  if (cloudBytes !== null) cloud.set(FILE, { id: ID, bytes: cloudBytes, lineEnd: cloudBytes, sealedBytes: 0, chain: CHAIN, tailSha: TAIL, activeAt: 1 })
  const persistence: ThreadPersistenceView = { readOnly: false, hydration: null, conflict: null }
  const writer = createThreadWriter({
    vfs,
    persistence,
    net: {
      get: async (path) => path.startsWith('/_thread/index') ? json({ sync: 'on', threads: [] }) : json({}),
      post: async (path) => path === '/_mirror/lease' ? json({ lease: { leaseId: 'b'.repeat(32), generation: 1 } }) : json({}),
    },
    boot: { publish: (_mode, footer) => { published.push(footer) } },
    now: () => Date.UTC(2026, 10, 15, 2, 41, 0),
    live: true,
    clientId: 'c'.repeat(32),
    cloud,
  })
  return { step: async () => await writer.step() }
}

describe('her lane, measured instead of guessed', () => {
  it('a conversation still being written is counted from its size, not from the planner\'s zero, and it is named', async () => {
    const published: string[] = []
    // The plan returned early (the file changed inside the settle window): nothing in it counted these 20 bytes.
    expect(await writerFor(oneThread(120), 100, published).step()).toBe('idle')
    const sentence = published[published.length - 1] ?? ''
    expect(sentence).toContain('auma is still changing: 20 bytes of it are not in her cloud yet.')
    expect(sentence).toContain('Copying starts once it has gone 2 s without changing.')
    expect(sentence).not.toContain('Saved')
    expect(sentence).not.toContain('Nothing new to send')
    // The same fact, in the number `x6_self_state` shows: bytes, because a byte is a measurement and a line is not, here.
    expect(threadSyncState.pendingBytes).toBe(20)
  })

  it('a conversation wholly in her cloud says so from her listing, and still names it', async () => {
    const published: string[] = []
    expect(await writerFor(oneThread(100), 100, published).step()).toBe('idle')
    const sentence = published[published.length - 1] ?? ''
    expect(sentence).toContain('Nothing new to send.')
    expect(sentence).toContain('Largest: auma (100 bytes listed, tail ffffffff)')
    expect(threadSyncState.pendingBytes).toBe(0)
  })

  it('a file shorter than her cloud\'s copy is not called caught up', async () => {
    const published: string[] = []
    expect(await writerFor(oneThread(90), 100, published).step()).toBe('idle')
    const sentence = published[published.length - 1] ?? ''
    expect(sentence).toContain('1 conversation stopped copying and needs your card.')
    expect(sentence).not.toContain('Nothing new to send')
  })

  it('a conversation whose size cannot be read is reported as unmeasured, never as nothing new', async () => {
    const published: string[] = []
    expect(await writerFor(oneThread(120, false), 100, published).step()).toBe('idle')
    const sentence = published[published.length - 1] ?? ''
    expect(sentence).toContain('This browser could not measure 1 of its conversations')
    expect(sentence).not.toContain('Nothing new to send')
    expect(sentence).not.toContain('Nothing is queued')
  })
})

describe('the conversation a sentence names', () => {
  it('is the folder for a session journal, the folder above `session/` for messages, and never a control character', () => {
    expect(threadLabel('/dsh/home/sessions/aukora/01H2/session.v4.jsonl')).toBe('01H2')
    expect(threadLabel('/dsh/home/auma/session/messages.jsonl')).toBe('auma')
    expect(threadLabel('/dsh/home/x\u0007/session/messages.jsonl')).toBe('x')
    expect(threadLabel('/dsh/home/x/session/messages.jsonl')).toBe('x')
    expect(threadLabel(`/dsh/home/${'n'.repeat(40)}/session/messages.jsonl`)).toHaveLength(24)
  })
})
