/**
 * CARD 1 (her sender): the LIVE path of `storage/thread-writer.ts`, the one `worker-host.ts` asks for by name.
 *
 * The existing `thread-writer.spec.ts` is main's and is not touched by this card: every default in the module — the
 * eligibility answers, the footer sentences, the 8 MiB create gate, the store gate — is unchanged when `live` is not
 * passed, and that spec keeps pinning it. This file pins only what `live: true` adds.
 */
import { describe, expect, it } from 'vitest'

import { createThreadWriter, writerEligible } from '../../src/storage/thread-writer.ts'
import type { ThreadNetReply, ThreadPersistenceView, ThreadReadStore } from '../../src/storage/thread-store-types.ts'

/** `mintTabId` is twelve random bytes in hex: the lease's tab alphabet, 24 characters. */
const HEX24 = /^[0-9a-f]{24}$/
const json = (value: unknown): ThreadNetReply => ({
  status: 200,
  headers: new Headers(),
  bytes: new TextEncoder().encode(JSON.stringify(value)),
})
const answer = (value: unknown, status = 200): ThreadNetReply => ({
  status,
  headers: new Headers(),
  bytes: new TextEncoder().encode(JSON.stringify(value)),
})

/** The facts attach records; `cloud` and `seq` are the mirror's, which the live path deliberately does not read. */
const hydration = (over: Record<string, unknown> = {}): never => ({
  transport: 'indexeddb', clientId: null, seq: 0, queuedBatches: 0, heldPaths: 0, reconciliation: false,
  storedRows: 1, storedRevision: 3, cloudRevision: 3, cloud: 'diverged', localSave: null, ...over,
} as never)

/** No journal at all: enough for the store gate and for the footer that answers from her cloud's index. */
const emptyVfs = (): ThreadReadStore => ({
  existsSync: () => false,
  statSync: () => ({ isFile: () => false, isDirectory: () => true, size: 0 }),
  readdirSync: () => [],
  readFileSync: () => new Uint8Array(0),
})

describe('her sender, live: the mirror fence is not the log\'s guard', () => {
  it('a browser her cloud did not confirm, and with no save of its own, is refused by main and accepted live', () => {
    const facts = hydration()
    // Main's answers, unchanged: the fence, the stored seq and the client id are all asked.
    expect(writerEligible(facts)).toEqual({ ok: false, why: 'this browser has not saved her before' })
    // Main asks the fence BEFORE the seq, so this case confirms the fence and leaves seq at 0 to reach the seq sentence.
    const saved = hydration({ seq: 0, queuedBatches: 1, cloud: 'confirmed', clientId: 'a'.repeat(32) })
    expect(writerEligible(saved)).toEqual({ ok: false, why: 'this browser has no acknowledged save of its own' })
    const diverged = hydration({ seq: 7, cloud: 'diverged', clientId: 'a'.repeat(32) })
    expect(writerEligible(diverged)).toEqual({
      ok: false, why: 'her cloud did not confirm this browser\'s last save at this boot (diverged)',
    })
    // The live path asks only for the client id that names the lease holder.
    expect(writerEligible(diverged, true)).toEqual({ ok: true, clientId: 'a'.repeat(32) })
    expect(writerEligible(facts, true)).toEqual({ ok: false, why: 'this browser has not saved her before' })
  })

  it('a browser with no mirror client id gets one for this page load, and the lease, not the id, is the guard', () => {
    const eligible = writerEligible(hydration({ seq: 3, cloud: 'confirmed', clientId: null }), true)
    expect(eligible.ok).toBe(true)
    if (eligible.ok) expect(HEX24.test(eligible.clientId)).toBe(true)
  })
})

describe('her sender, live: what the lane is told', () => {
  /** The writer with a cloud index that holds nothing, and a recorder for every sentence it publishes. */
  const writerWith = async (persistence: Partial<ThreadPersistenceView>, published: string[], posted: string[]): Promise<{
    step: () => Promise<string>
  }> => {
    const view: ThreadPersistenceView = { readOnly: false, hydration: null, conflict: null, ...persistence }
    const writer = createThreadWriter({
      vfs: emptyVfs(),
      persistence: view,
      net: {
        get: async (path) => (path.startsWith('/_thread/index') ? json({ sync: 'on', threads: [] }) : answer({}, 404)),
        post: async (path) => { posted.push(path); return path === '/_mirror/lease' ? json({ lease: { leaseId: 'b'.repeat(32), generation: 1 } }) : answer({}, 404) },
      },
      boot: { publish: (_mode, footer) => { published.push(footer) } },
      now: () => Date.UTC(2026, 10, 15, 2, 41, 0),
      live: true,
      clientId: 'c'.repeat(32),
      cloud: new Map(),
    })
    return { step: async () => await writer.step() }
  }

  it('with nothing new it answers from her cloud\'s index and its time, not from silence', async () => {
    const published: string[] = []
    const writer = await writerWith({}, published, [])
    expect(await writer.step()).toBe('idle')
    const sentence = published[published.length - 1] ?? ''
    // The reload case the owner would otherwise read as "not saved": the index said so at 10:41 local time.
    expect(sentence).toContain('Her cloud\'s index held 0 bytes of 0 conversations at')
    expect(sentence).not.toContain('has not acknowledged anything')
  })

  it('a local multi-tab conflict stops this tab and says why (persistence.conflict is not the mirror fence)', async () => {
    const published: string[] = []
    const posted: string[] = []
    const writer = await writerWith({ conflict: 'DURABLE_CONTENT_CONFLICT' }, published, posted)
    expect(await writer.step()).toBe('stopped')
    expect(published[published.length - 1]).toBe('Copying to her cloud is paused. New lines stay in this browser.')
    // It never asked for her turn: a tab in conflict does not take the lease from the live one.
    expect(posted).toEqual([])
  })
})
