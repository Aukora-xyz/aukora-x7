/**
 * the thread sync switch (brief test (a), the missing half): the real `createWorkerHost` boots with options built as
 * worker.ts builds them from an init frame that carries no `threadSync` (the switch unset, or an old boot document),
 * for a browser that never saved her (the one that becomes a reader while the switch is on). Its `start()` runs the
 * real image read, the real idb-persist attach and the real `bootThreadSyncIfOn` gate; the empty image then stops it at
 * the tree's first require, after the thread sync step. It makes the same edge calls as the attach alone (what main's
 * host does at that step), never asks a thread route, opens no channel, never becomes read-only and sets no mark.
 * The control boots the same host with `threadSync: 'on'` and a page id: it IS a reader, so the cases can fail.
 */
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeDb, FakeIndexedDb, FakeKeyRange, fakeEdge, journal, READER_LINEAGE, readerStore } from './thread-sync-fixture.ts'

const ORIGIN = 'https://node.example.invalid'
const MAIN_JOURNAL = '/dsh/home/sessions/--dsh-home-auma--/session-main/session.v4.jsonl'
const SETTLE_MS = 1_500
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
/** An empty ustar archive (two zero blocks), gzipped as the deployment serves its image. */
const EMPTY_IMAGE = gzipSync(new Uint8Array(1024))
/** Consecutive repeats of one call (timed retries) folded into one, so two runs compare by order. */
const folded = (calls: ReadonlyArray<{ method: string; path: string }>): string[] =>
  calls.map(call => `${call.method} ${call.path}`).filter((line, index, all) => index === 0 || all[index - 1] !== line)

interface Load {
  calls: Array<{ method: string; path: string }>
  channels: number
  readOnly: boolean
  switchOn: boolean
  footer: string | null
  selfState: Record<string, unknown>
  cookies: string[]
}

/** One page load of a never-saved browser, with fresh module instances: the host's boot, or main's step (attach only). */
async function load(how: 'host' | 'attach-only', frame: { threadSync?: 'on'; page?: string }): Promise<Load> {
  const idb = new FakeIndexedDb()
  const db = new FakeDb()
  db.data = readerStore([[MAIN_JOURNAL, journal(9_000, 'cloud-main')]])
  idb.dbs.set('aukora-x6-vfs', db)
  vi.stubGlobal('indexedDB', idb)
  vi.stubGlobal('IDBKeyRange', FakeKeyRange)
  vi.stubGlobal('location', { origin: ORIGIN, hostname: 'node.example.invalid', href: `${ORIGIN}/` })
  let channels = 0
  vi.stubGlobal('BroadcastChannel', class { constructor() { channels += 1 } postMessage() {} close() {} addEventListener() {} removeEventListener() {} onmessage = null })
  const cookies: string[] = []
  vi.stubGlobal('document', { get cookie() { return '' }, set cookie(value: string) { cookies.push(value) } })
  vi.resetModules()
  const persist = await import('../../src/storage/idb-persist.ts')
  const sync = await import('../../src/storage/thread-sync.ts')
  const edge = await fakeEdge({ origin: ORIGIN, piece: 4096, threads: [{ path: MAIN_JOURNAL, bytes: journal(9_000, 'cloud-main') }],
    fence: { lineageId: READER_LINEAGE, revision: 2190 }, readOnly: () => persist.persistence.readOnly, sync: 'on' })
  vi.stubGlobal('fetch', edge.fetch)
  if (how === 'host') {
    const { createWorkerHost } = await import('../../src/worker-host.ts')
    // Exactly worker.ts's spread of the init frame (worker.ts THREADSYNC hook and the thread sync switch line).
    const host = createWorkerHost({
      staticModules: {},
      requestListener: () => new Promise(() => {}),
      channel: { postMessage: () => {} },
      image: EMPTY_IMAGE,
      ...(typeof frame.page === 'string' ? { pageId: frame.page } : {}),
      ...(frame.threadSync === 'on' ? { threadSync: 'on' as const } : {}),
    })
    const realProcess = globalThis.process
    const started = host.start()
    // start() installs her process shim synchronously before its first await; the test runner needs Node's back.
    ;(globalThis as { process?: unknown }).process = realProcess
    await started.catch(() => {})
  } else {
    const { MemoryVfs } = await import('../../src/storage/memory.ts')
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home', { recursive: true })
    vfs.mkdirSync('/dsh/workspace', { recursive: true })
    await persist.attachIdbPersistence(vfs, ['/dsh/home', '/dsh/workspace'])
  }
  const readOnly = persist.persistence.readOnly
  await pause(SETTLE_MS)
  const result: Load = {
    calls: edge.calls.map(call => ({ method: call.method, path: call.path })),
    channels, readOnly, switchOn: sync.threadSyncSwitch.on, footer: sync.threadReader.footer,
    selfState: sync.threadSyncSelfStateField(), cookies,
  }
  persist.persistence.readOnly = true
  sync.threadSyncSwitch.on = false
  sync.threadReader.footer = null
  return result
}

afterEach(async () => {
  await pause(120)
  vi.unstubAllGlobals()
})

describe('the real worker host, booted from an init frame with no threadSync, is inert', () => {
  it.each([
    ['(a) the switch unset: no page id, no threadSync', {}],
    ['(c) an old document under an edge that is on: the same frame', {}],
    ['a frame naming a page but not the switch (never sent by this branch): still inert', { page: 'aaaaaaaaaaaaaaaa' }],
  ] as ReadonlyArray<readonly [string, { page?: string }]>)('%s', { timeout: 60_000 }, async (_name, frame) => {
    const main = await load('attach-only', {})
    const run = await load('host', frame)
    expect(folded(run.calls)).toEqual(folded(main.calls))
    expect(run.calls.filter(call => /^\/_(thread|vault|mirror\/lease)/.test(call.path))).toEqual([])
    expect(run.readOnly).toBe(false)
    expect(run.readOnly).toBe(main.readOnly)
    expect(run.channels).toBe(0)
    expect(run.switchOn).toBe(false)
    expect(run.footer).toBeNull()
    expect(run.selfState).toEqual({})
    expect(run.cookies).toEqual([])
  })

  it('control: the same host with threadSync on IS a reader and reads her index (so the cases above can fail)', { timeout: 60_000 }, async () => {
    const run = await load('host', { threadSync: 'on', page: 'aaaaaaaaaaaaaaaa' })
    expect(run.switchOn).toBe(true)
    expect(run.readOnly).toBe(true)
    expect(run.calls.some(call => call.path.startsWith('/_thread/index'))).toBe(true)
    expect(run.selfState).toHaveProperty('threadSync')
  })
})
