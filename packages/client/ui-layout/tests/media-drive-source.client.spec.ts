/**
 * Media and Documents, her drive: the read channel. Listing is her own read-only estate tool through the page bridge;
 * stat and byte windows are the stock `remote.workspaceFiles` service. Both are faked here; every file is made up.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDriveSource, homeSessionOf, readAll, type DriveFiles } from '../src/client/spatial/apps/media/drive-source.ts'
import { WINDOW } from '../src/client/spatial/apps/media/drive-model.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const ROOT = '/dsh/home/auma/docs'
const MiB = 1024 * 1024
type Call = { name: string; args: Record<string, unknown> }
const estate = (entries: unknown[], nextCursor: number | null, extra: Record<string, unknown> = {}) => ({
  kind: 'ok' as const,
  value: { ok: true, schema: 'aukora.browser-estate.v1', vfs: { root: ROOT, entries, page: { nextCursor }, private: { present: false }, ...extra } },
})
const sid = (value: string) => value as never

function fakeFiles(disk: Record<string, Uint8Array>, versions: (path: string, call: number) => string = () => 'v1') {
  const log: string[] = []
  let reads = 0
  const stat = vi.fn(async (_s: unknown, path: string) => {
    log.push(`stat ${path}`)
    const data = disk[path]
    return data === undefined ? { ok: false as const, error: { code: 'workspace-file/not-found' } }
      : { ok: true as const, value: { absolutePath: path, version: versions(path, 0), bytes: data.byteLength } }
  })
  const readBytes = vi.fn(async (_s: unknown, path: string, options: { range?: { offset?: number; length?: number } }) => {
    reads += 1
    log.push(`read ${path} ${String(options.range?.offset)} ${String(options.range?.length)}`)
    const data = disk[path]
    if (data === undefined) return { ok: false as const, error: { code: 'workspace-file/not-found' } }
    const offset = options.range?.offset ?? 0
    const slice = data.subarray(offset, offset + (options.range?.length ?? data.byteLength))
    const eof = offset + slice.byteLength >= data.byteLength
    return { ok: true as const, value: { data: slice, version: versions(path, reads), eof } }
  })
  const list = vi.fn(async () => ({ ok: true as const, value: { entries: [], truncated: false } }))
  const files = { stat, readBytes, list } as unknown as DriveFiles
  return { files, log, stat, readBytes }
}

describe('the drive source', () => {
  it('S1 lists through her estate tool with the exact read-only arguments, follows the cursor, and drops what is never shown', async () => {
    const calls: Call[] = []
    const pages: Record<number, ReturnType<typeof estate>> = {
      0: estate([
        { path: ROOT, type: 'dir' },
        { path: `${ROOT}/PENTORA.v0.md`, type: 'file', size: 120, mtimeMs: 1_800_000_000_000, sha256: null },
        { path: `${ROOT}/pentora`, type: 'dir' },
        { path: `${ROOT}/credentials.yaml.bak`, type: 'file', size: 9, mtimeMs: 1 },
        { path: `${ROOT}/device-keypair.json`, type: 'file', size: 9, redacted: 'sensitive-name', sha256: null },
        { path: `${ROOT}/secrets`, type: 'dir', redacted: 'sensitive-name' },
        { path: `${ROOT}/credentials/notes.md`, type: 'file', size: 3, mtimeMs: 2 },
      ], 200),
      200: estate([{ path: `${ROOT}/photo.png`, type: 'file', size: 2048, mtimeMs: 5 }], null, { private: { present: true } }),
    }
    const source = createDriveSource({
      callTool: async (name, args) => { calls.push({ name, args }); return pages[args.cursor as number] ?? { kind: 'refused' } },
      files: null, sessionId: () => undefined, homeSessionId: () => undefined,
    })
    const result = await source.tree(ROOT, new AbortController().signal)
    expect(calls).toEqual([
      { name: 'x6_browser_estate', args: { sections: ['vfs'], root: ROOT, cursor: 0, limit: 200, perFileHashBytes: 0 } },
      { name: 'x6_browser_estate', args: { sections: ['vfs'], root: ROOT, cursor: 200, limit: 200, perFileHashBytes: 0 } },
    ])
    expect(result).toEqual({ ok: true, value: {
      entries: [
        { path: `${ROOT}/PENTORA.v0.md`, name: 'PENTORA.v0.md', type: 'file', size: 120, modifiedMs: 1_800_000_000_000 },
        { path: `${ROOT}/pentora`, name: 'pentora', type: 'directory', size: null, modifiedMs: null },
        { path: `${ROOT}/photo.png`, name: 'photo.png', type: 'file', size: 2048, modifiedMs: 5 },
      ],
      truncated: false,
      privatePresent: true,
    } })

    // Ten pages at most, then it says more exist.
    let count = 0
    const endless = createDriveSource({
      callTool: async (_n, args) => { count += 1; return estate([{ path: `${ROOT}/f${String(args.cursor)}.md`, type: 'file', size: 1, mtimeMs: 1 }], (args.cursor as number) + 200) },
      files: null, sessionId: () => undefined, homeSessionId: () => undefined,
    })
    const capped = await endless.tree(ROOT, new AbortController().signal)
    expect(count).toBe(10)
    expect(capped.ok && capped.value.truncated).toBe(true)
    expect(capped.ok && capped.value.entries.length).toBe(10)
  })

  it('S2 names every bridge failure, refuses without a bridge, gives up after 15 s, and halves the page on an oversize answer', async () => {
    const kinds: [string, string][] = [
      ['control-unavailable', 'not-running'], ['transport', 'not-running'], ['missing', 'missing-tool'], ['refused', 'refused'],
      ['unreadable', 'refused'], ['timeout', 'refused'],
    ]
    for (const [kind, reason] of kinds) {
      const source = createDriveSource({
        callTool: async () => ({ kind }), files: null, sessionId: () => undefined, homeSessionId: () => undefined,
      })
      expect(await source.tree(ROOT, new AbortController().signal), kind).toEqual({ ok: false, reason })
    }
    const refusedInside = createDriveSource({ callTool: async () => ({ kind: 'ok', value: { ok: false, code: 'ESTATE_SECTION_UNKNOWN' } }), files: null, sessionId: () => undefined, homeSessionId: () => undefined })
    expect(await refusedInside.tree(ROOT, new AbortController().signal)).toEqual({ ok: false, reason: 'refused' })
    const none = createDriveSource({ callTool: null, files: null, sessionId: () => undefined, homeSessionId: () => undefined })
    expect(await none.tree(ROOT, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })

    vi.useFakeTimers()
    let seen: AbortSignal | null = null
    const slow = createDriveSource({
      callTool: (_n, _a, signal) => {
        seen = signal
        return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ kind: 'aborted' }) }) })
      },
      files: null, sessionId: () => undefined, homeSessionId: () => undefined,
    })
    const pending = slow.tree(ROOT, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(14_999)
    expect((seen as AbortSignal | null)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ ok: false, reason: 'busy' })
    vi.useRealTimers()

    const limits: [number, number][] = []
    const bounded = createDriveSource({
      callTool: async (_n, args) => { limits.push([args.cursor as number, args.limit as number]); return { kind: 'bounded' } },
      files: null, sessionId: () => undefined, homeSessionId: () => undefined,
    })
    expect(await bounded.tree(ROOT, new AbortController().signal)).toEqual({ ok: false, reason: 'refused' })
    expect(limits).toEqual([[0, 200], [0, 100], [0, 50], [0, 25]])
  })

  it('S3 reads one window of at most 2 MiB through the shown thread', async () => {
    const { files, readBytes } = fakeFiles({ '/dsh/home/auma/docs/a.md': new Uint8Array(5 * MiB) })
    const source = createDriveSource({ callTool: null, files, sessionId: () => sid('shown'), homeSessionId: () => sid('home') })
    const window = await source.read('/dsh/home/auma/docs/a.md', { offset: 0, length: 5 * MiB }, new AbortController().signal)
    expect(window.ok && window.value.data.byteLength).toBe(WINDOW)
    expect(readBytes).toHaveBeenCalledTimes(1)
    const [session, path, options] = readBytes.mock.calls[0] ?? []
    expect([session, path, options]).toEqual(['shown', '/dsh/home/auma/docs/a.md', { range: { offset: 0, length: WINDOW } }])
  })

  it('S4 lists Private children through the home-folder thread only', async () => {
    const list = vi.fn(async (_s: unknown, _p: string) => ({ ok: true as const, value: {
      entries: [{ name: 'zeta.md', type: 'file' as const, size: 4 }, { name: 'alpha', type: 'directory' as const },
        { name: '.ssh', type: 'directory' as const }, { name: 'sock', type: 'other' as const }, { name: 'my-password.txt', type: 'file' as const, size: 1 }],
      truncated: false,
    } }))
    const files = { ...fakeFiles({}).files, list } as DriveFiles
    const source = createDriveSource({ callTool: null, files, sessionId: () => sid('shown'), homeSessionId: () => sid('home') })
    expect(await source.children('/dsh/home/auma/private', new AbortController().signal)).toEqual({ ok: true, value: {
      entries: [
        { path: '/dsh/home/auma/private/alpha', name: 'alpha', type: 'directory', size: null, modifiedMs: null },
        { path: '/dsh/home/auma/private/zeta.md', name: 'zeta.md', type: 'file', size: 4, modifiedMs: null },
      ],
      truncated: false,
    } })
    expect(list.mock.calls[0]?.[0]).toBe('home')
    list.mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/outside-workspace' } } as never)
    expect(await source.children('/dsh/home/auma/private', new AbortController().signal)).toEqual({ ok: false, reason: 'no-home-thread' })
    const homeless = createDriveSource({ callTool: null, files, sessionId: () => sid('shown'), homeSessionId: () => undefined })
    expect(await homeless.children('/dsh/home/auma/private', new AbortController().signal)).toEqual({ ok: false, reason: 'no-home-thread' })

    const sessions = {
      ids: ['preview-1', 'a1', 'h1', 'h2'],
      byId: {
        'preview-1': { id: 'preview-1', cwd: '/dsh/home/auma', retainedBy: { mainView: 1 } },
        a1: { id: 'a1', cwd: '/dsh/home/auma-one', retainedBy: {} },
        h1: { id: 'h1', cwd: '/dsh/home/auma', retainedBy: {} },
        h2: { id: 'h2', cwd: '/dsh/home/auma', retainedBy: { mainView: 1 } },
      },
    }
    expect(homeSessionOf(sessions as never)).toBe('h2')
    expect(homeSessionOf({ ...sessions, byId: { ...sessions.byId, h2: { ...sessions.byId.h2, retainedBy: {} } } } as never)).toBe('h1')
    expect(homeSessionOf({ ids: ['a1'], byId: { a1: sessions.byId.a1 } } as never)).toBeUndefined()
  })

  it('S5 says not-found, no door and no thread plainly', async () => {
    const { files, stat } = fakeFiles({ '/dsh/home/auma/docs/a.md': new Uint8Array(7) })
    const source = createDriveSource({ callTool: null, files, sessionId: () => sid('s1'), homeSessionId: () => undefined })
    expect(await source.stat('/dsh/home/auma/docs/a.md', new AbortController().signal))
      .toEqual({ ok: true, value: { size: 7, version: 'v1', absolutePath: '/dsh/home/auma/docs/a.md' } })
    expect(await source.stat('/dsh/home/auma/docs/gone.md', new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    stat.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/lookup-not-found' } } as never)
    expect(await source.stat('/dsh/home/auma/docs/a.md', new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    stat.mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/not-regular-file' } } as never)
    expect(await source.stat('/dsh/home/auma/docs/a.md', new AbortController().signal)).toEqual({ ok: false, reason: 'refused' })
    const noDoor = createDriveSource({ callTool: null, files: null, sessionId: () => sid('s1'), homeSessionId: () => undefined })
    expect(await noDoor.stat('/dsh/home/auma/docs/a.md', new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await noDoor.read('/dsh/home/auma/docs/a.md', { offset: 0, length: 1 }, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
    const noThread = createDriveSource({ callTool: null, files, sessionId: () => undefined, homeSessionId: () => undefined })
    expect(await noThread.stat('/dsh/home/auma/docs/a.md', new AbortController().signal)).toEqual({ ok: false, reason: 'no-thread' })
    expect(await noThread.read('/dsh/home/auma/docs/a.md', { offset: 0, length: 1 }, new AbortController().signal)).toEqual({ ok: false, reason: 'no-thread' })
  })

  it('S6 reads a whole file in ordered windows, stops on a change, and refuses oversize or re-pointed files before reading', async () => {
    const big = new Uint8Array(5 * MiB).map((_v, i) => i % 251)
    const { files, log, stat } = fakeFiles({ '/dsh/home/auma/docs/big.bin': big })
    const source = createDriveSource({ callTool: null, files, sessionId: () => sid('s1'), homeSessionId: () => undefined })
    const whole = await readAll(source, '/dsh/home/auma/docs/big.bin', 64 * MiB, new AbortController().signal)
    expect(whole.ok && Buffer.from(whole.value).equals(Buffer.from(big))).toBe(true)
    expect(log).toEqual([
      'stat /dsh/home/auma/docs/big.bin',
      `read /dsh/home/auma/docs/big.bin 0 ${String(WINDOW)}`,
      `read /dsh/home/auma/docs/big.bin ${String(WINDOW)} ${String(WINDOW)}`,
      `read /dsh/home/auma/docs/big.bin ${String(2 * WINDOW)} ${String(MiB)}`,
    ])

    const changing = fakeFiles({ '/dsh/home/auma/docs/big.bin': big }, (_p, call) => (call >= 2 ? 'v2' : 'v1'))
    const moving = createDriveSource({ callTool: null, files: changing.files, sessionId: () => sid('s1'), homeSessionId: () => undefined })
    expect(await readAll(moving, '/dsh/home/auma/docs/big.bin', 64 * MiB, new AbortController().signal)).toEqual({ ok: false, reason: 'changed' })
    expect(changing.log.filter(line => line.startsWith('read'))).toHaveLength(2)

    log.length = 0
    expect(await readAll(source, '/dsh/home/auma/docs/big.bin', 5 * MiB - 1, new AbortController().signal)).toEqual({ ok: false, reason: 'too-large' })
    expect(log.filter(line => line.startsWith('read'))).toEqual([])

    for (const absolutePath of ['/dsh/home/auma/private/diary.md', '/dsh/home/auma/docs/.ssh/config', '/dsh/home/auma/docs/../private/x', '/dsh/home/owner/a.md']) {
      stat.mockResolvedValueOnce({ ok: true, value: { absolutePath, version: 'v1', bytes: 4 } } as never)
      log.length = 0
      expect(await readAll(source, '/dsh/home/auma/docs/link.md', 64 * MiB, new AbortController().signal), absolutePath).toEqual({ ok: false, reason: 'refused' })
      expect(log.filter(line => line.startsWith('read')), absolutePath).toEqual([])
    }
  })

  it('S7 the drive can only read: no write, rename, delete, navigation, unsafe Blob type, or tool other than the estate', () => {
    const dir = new URL('../src/client/spatial/apps/media/', import.meta.url)
    const sources = ['drive-rule.ts', 'drive-model.ts', 'drive-source.ts', 'DriveView.tsx']
      .map(name => [name, readFileSync(new URL(name, dir), 'utf8')] as const)
    for (const [name, text] of sources) {
      const banned = /writeBytes|deleteFile|rename|mkdir|rmSync|unlink|location\.(?:href|assign|replace)|history\.|image\/svg|text\/html/u
      expect(text, name).not.toMatch(banned)
      const writes = text.match(/[\w.]*writeText\(/gu) ?? []
      for (const write of writes) expect(write, name).toBe('navigator.clipboard.writeText(')
      const tools = text.match(/'[a-z0-9]+_[a-z0-9_]+'/gu) ?? []
      for (const tool of tools) expect(tool, name).toBe("'x6_browser_estate'")
      for (const call of text.match(/callTool\(\s*([^,)]+)/gu) ?? []) expect(call, name).toMatch(/callTool\(\s*ESTATE_TOOL$/u)
    }
    expect(sources.find(([name]) => name === 'drive-source.ts')?.[1]).toContain("const ESTATE_TOOL = 'x6_browser_estate'")
  })
})
