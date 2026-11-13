/**
 * Lane E4 task 3: x6_browser_estate is a read-only, bounded inventory of her browser estate with no GitHub or Mac
 * dependency. /dsh/home/auma/private/** is reported by existence and size only: no digest, no content, no name leak in
 * search. Synthetic VFS only.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeSessionWorkspace, ESTATE_LIMITS, estateRedaction, inspectBrowserEstate } from '../../src/x6/browser-estate.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const PRIVATE_TEXT = 'synthetic-private-marker-do-not-leak'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** One row of his or her words, as Session writes it. */
const said = (text: string, who: 'he' | 'she' = 'he'): string => JSON.stringify(who === 'he'
  ? { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
  : { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 0, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } })

function estate(): MemoryVfs {
  const vfs = new MemoryVfs()
  const put = (path: string, text: string) => { vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); vfs.writeFileSync(path, text) }
  put('/dsh/home/auma/WISH.md', '- [ ] grow\n')
  put('/dsh/home/auma/workspaces/garden/notes.md', 'garden notes')
  put('/dsh/home/auma/private/owner.json', PRIVATE_TEXT)
  put('/dsh/home/auma/keys/device-keypair.json', 'synthetic key material')
  put('/dsh/home/sessions/--dsh-home-auma--/s1/session.v1.jsonl', JSON.stringify({ type: 'session', id: 's1', title: 'Root talk' }) + `\n${said('we spoke of tidepools')}\n`)
  put('/dsh/home/sessions/--dsh-home-auma-one--/s0/session.v1.jsonl', JSON.stringify({ type: 'session', id: 's0', title: 'Legacy' })
    + `\n${JSON.stringify({ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, content: [{ type: 'text', text: 'tidepools again' }], source: {} } })}\n`)
  put('/dsh/home/sessions/--dsh-home-auma-workspaces-garden--/s2/session.v1.jsonl', JSON.stringify({ type: 'session', id: 's2' }) + '\n')
  const leaf = (seq: number, prevHash: string | null, kind: string, data: Record<string, unknown>) =>
    JSON.stringify({ schema: 'aukora.receipt.v3', seq, kind, prevHash, leafHash: `leaf-${String(seq)}`, data })
  put('/dsh/home/auma/seed/receipts.v3.jsonl', [leaf(1, null, 'tree.patch', {}),
    leaf(2, 'leaf-1', 'head.promote', { epoch: 8, ballId: 'a'.repeat(64), entryId: 'organ-a', tier: 'T1', hasApprovalToken: false, operationId: 'op-12345678', transitionKind: 'head.promote' })].join('\n') + '\n')
  put('/dsh/home/auma/seed/checkpoints.v1.jsonl', JSON.stringify({ seq: 2, root: 'r'.repeat(64) }) + '\n')
  return vfs
}

describe('browser estate (pure)', () => {
  it('redaction and legacy session decoding', () => {
    expect(estateRedaction('/dsh/home/auma/private/x')).toBe('private')
    expect(estateRedaction('/dsh/home/auma/private')).toBe('private')
    expect(estateRedaction('/dsh/home/auma/privateer.md')).toBeNull()
    expect(estateRedaction('/dsh/home/auma/keys/device-keypair.json')).toBe('sensitive-name')
    expect(decodeSessionWorkspace('--dsh-home-auma--')).toMatchObject({ form: 'auma-root', workspace: '/dsh/home/auma' })
    expect(decodeSessionWorkspace('--dsh-home-auma-one--')).toMatchObject({ form: 'legacy-auma-one' })
    expect(decodeSessionWorkspace('--dsh-home-auma-workspaces-garden--')).toMatchObject({ form: 'auma-subworkspace', workspace: '/dsh/home/auma/workspaces/garden' })
  })

  it('reports every section, digests public files, and withholds private content', async () => {
    const vfs = estate()
    const report = await inspectBrowserEstate(vfs, { query: 'tidepools' }, {
      persistence: () => ({ durable: true }), persistenceInspect: async () => ({ available: true, queuedBatches: 0 }),
      cordis: () => ({ activeFibers: [], fiberHealth: {}, mountedOrgans: [], registeredTools: ['x6_browser_estate'], services: [], head: { ballId: 'h', epoch: 1, entries: 0, modules: 0 } }),
    })
    expect(report).toMatchObject({ ok: true, readOnly: true, dependencies: { github: false, mac: false, network: false } })
    const text = JSON.stringify(report)
    expect(text).not.toContain(PRIVATE_TEXT)
    expect(text).not.toContain(sha(PRIVATE_TEXT))
    expect(text).not.toContain('synthetic key material')
    const entries = (report.vfs as { entries: Array<Record<string, unknown>> }).entries
    expect(text).not.toContain('owner.json')
    expect(entries.find(entry => entry.path === '/dsh/home/auma/private')).toEqual({ path: '/dsh/home/auma/private', type: 'dir', redacted: 'private' })
    expect(entries.find(entry => entry.path === '/dsh/home/auma/keys/device-keypair.json')).toMatchObject({ redacted: 'sensitive-name', sha256: null })
    expect(entries.find(entry => entry.path === '/dsh/home/auma/WISH.md')).toMatchObject({ sha256: sha('- [ ] grow\n'), size: 11 })
    expect(report.vfs).toMatchObject({ private: { present: true, files: 1, bytes: PRIVATE_TEXT.length, policy: 'existence-and-size-only' },
      workspaces: [{ name: 'garden', files: 1, bytes: 12 }] })
    expect(report.sessions).toMatchObject({ totals: { sessions: 3 }, legacyDirsPresent: { '--dsh-home-auma-one--': true, '--dsh-home-auma--': true } })
    expect((report.search as { hits: unknown[] }).hits).toHaveLength(2)
    expect(report.persistence).toMatchObject({ status: { durable: true }, queue: { available: true } })
    expect(report.cordis).toMatchObject({ registeredTools: ['x6_browser_estate'] })
    expect((report.wasm as { pins: unknown[] }).pins.length).toBeGreaterThan(0)
    expect(report.receipts).toMatchObject({ receipts: { count: 2, structuralLinkage: 'linked',
      promotions: [{ epoch: 8, operationId: 'op-12345678', transitionKind: 'head.promote' }] }, checkpoints: { count: 1 } })
  })

  it('search never reads the private tree, and unknown sections are typed', async () => {
    const vfs = estate()
    const report = await inspectBrowserEstate(vfs, { sections: ['search'], query: 'synthetic-private-marker' })
    expect((report.search as { hits: unknown[] }).hits).toEqual([])
    expect(await inspectBrowserEstate(vfs, { sections: ['everything'] })).toMatchObject({ ok: false, code: 'ESTATE_SECTION_UNKNOWN' })
    expect(await inspectBrowserEstate(vfs, { sections: ['search'] })).toMatchObject({ search: { ok: false, code: 'ESTATE_QUERY_INVALID' } })
  })

  it('search skips the rest of a file over budget and goes on: a big newest file does not hide a match in an older one', async () => {
    const vfs = estate()
    const line = new TextEncoder().encode(`${said('filler words in the big newest thread').padEnd(255, ' ')}\n`)
    const big = new Uint8Array(40 * 1024 * 1024)
    for (let at = 0; at + line.byteLength <= big.byteLength; at += line.byteLength) big.set(line, at)
    big.set(new TextEncoder().encode(`${said('lighthouse in the big thread tail', 'she').padEnd(255, ' ')}\n`), big.byteLength - 256)
    vfs.mkdirSync('/dsh/home/sessions/--dsh-home-auma--/s9', { recursive: true })
    await new Promise(resolve => setTimeout(resolve, 5))
    vfs.writeFileSync('/dsh/home/sessions/--dsh-home-auma--/s9/session.v4.jsonl', big)
    const report = await inspectBrowserEstate(vfs, { sections: ['search'], query: 'tidepools' })
    type Partial = { path: string; bytes: number; searchedFromByte: number }
    const search = report.search as { hits: Array<{ path: string }>; bytesScanned: number; truncated: boolean; partialFiles: Partial[] }
    // Both older threads were still searched after the 40 MiB file.
    expect(search.hits.map(hit => hit.path).sort()).toEqual(['/dsh/home/sessions/--dsh-home-auma--/s1/session.v1.jsonl', '/dsh/home/sessions/--dsh-home-auma-one--/s0/session.v1.jsonl'])
    expect(search.partialFiles).toEqual([{ path: '/dsh/home/sessions/--dsh-home-auma--/s9/session.v4.jsonl', bytes: big.byteLength, searchedFromByte: big.byteLength - ESTATE_LIMITS.searchTailBytes }])
    expect(search.bytesScanned).toBeLessThanOrEqual(ESTATE_LIMITS.searchBytes)
    expect(search.truncated).toBe(true)
    // The newest part of the big file is searched, from its first whole line.
    const tail = await inspectBrowserEstate(vfs, { sections: ['search'], query: 'lighthouse' })
    expect((tail.search as { hits: Array<Record<string, unknown>> }).hits).toEqual([expect.objectContaining({
      path: '/dsh/home/sessions/--dsh-home-auma--/s9/session.v4.jsonl', lineFrom: 'window', windowFromByte: big.byteLength - ESTATE_LIMITS.searchTailBytes })])
  })

  it('search and the session list never open a thread in her private folder; a key in an older thread leaves as [withheld]', async () => {
    const vfs = estate()
    const NSEC = 'nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqh0p9x'
    const HEX = 'a3f1c2d4e5b6a7980a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'
    const put = (path: string, text: string) => { vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); vfs.writeFileSync(path, text) }
    const privateThread = '/dsh/home/sessions/--dsh-home-auma-private--/sp/session.v4.jsonl'
    const cwdPrivate = '/dsh/home/sessions/--dsh-home-auma--/sc/session.v4.jsonl'
    const older = '/dsh/home/sessions/--dsh-home-auma-one--/s5/session.v1.jsonl'
    put(privateThread, `${JSON.stringify({ type: 'session', id: 'sp', title: 'synthetic private title', cwd: '/dsh/home/auma/private' })}\n${said(`lantern ${PRIVATE_TEXT}`)}\n`)
    put(cwdPrivate, `${JSON.stringify({ type: 'session', id: 'sc', title: 'synthetic cwd title', cwd: '/dsh/home/auma/private/notes' })}\n${said('lantern synthetic-cwd-private-words')}\n`)
    // The key sits in an OLDER ordinary thread, past a newer one: the search reaches it, the key does not leave.
    // The hex key starts inside the 80 characters after the needle and ends past them: cut first, its first 38 characters
    // would be too short for any shape and would leave. The whole line is withheld before any cut.
    const words = ', and then some ordinary words said here, '
    put(older, `${JSON.stringify({ type: 'session', id: 's5', title: 'Older work' })}\n${said(`key ${NSEC} lantern${words}${HEX} done`)}\n`)
    await new Promise(resolve => setTimeout(resolve, 5))
    put('/dsh/home/sessions/--dsh-home-auma--/s6/session.v4.jsonl', `${JSON.stringify({ type: 'session', id: 's6', title: 'Newer' })}\n${said('the lantern is lit', 'she')}\n`)
    const reads = vi.spyOn(vfs, 'readFileSync')
    const report = await inspectBrowserEstate(vfs, { sections: ['search', 'sessions'], query: 'lantern' })
    expect(reads.mock.calls.map(call => call[0])).not.toContain(privateThread)
    const text = JSON.stringify(report)
    for (const piece of [PRIVATE_TEXT, 'synthetic private title', 'synthetic cwd title', 'synthetic-cwd-private-words', NSEC.slice(0, 12), HEX.slice(0, 20)]) {
      expect(text).not.toContain(piece)
    }
    type Hit = { path: string; snippet: string }
    const search = report.search as { hits: Hit[]; withheld: { private: number } }
    expect(search.hits.map(hit => hit.path).sort()).toEqual(['/dsh/home/sessions/--dsh-home-auma--/s6/session.v4.jsonl', older])
    expect(80 - words.length).toBeLessThan(40)
    expect(search.hits.find(hit => hit.path === older)?.snippet).toBe(`key [withheld] lantern${words}[withheld] done`)
    expect(search.withheld).toEqual({ private: 2 })
    // Neither guard is a hiding place for a probe: part of a key finds nothing, and the query itself is not echoed back.
    const probe = await inspectBrowserEstate(vfs, { sections: ['search'], query: NSEC.slice(0, 24) })
    expect(probe.search).toMatchObject({ ok: true, hits: [], query: '[withheld]' })
    expect(JSON.stringify(probe)).not.toContain(NSEC.slice(0, 12))
  })

  it('search lets out only his and her words and titles: a private file\'s text in a tool result of an ordinary thread never leaves', async () => {
    const vfs = estate()
    const JOURNAL = 'synthetic-journal-line tidepool dream of the reef'
    const put = (path: string, text: string) => { vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); vfs.writeFileSync(path, text) }
    const row = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, seq: 1, time: 1, data })
    // An ordinary thread (her root folder) in which a tool read /dsh/home/auma/private/journal.md: the file's text sits in
    // the tool result row, in the call's arguments, in a system prompt and in an injected notice. None of it is his or
    // her words, and the journal text is not key-shaped, so only the row filter keeps it in.
    put('/dsh/home/sessions/--dsh-home-auma--/sj/session.v4.jsonl', [
      JSON.stringify({ type: 'session', version: 4, id: 'sj', cwd: '/dsh/home/auma' }),
      row('session/title', { title: 'Tidepool walk' }),
      said('read my tidepool notes'),
      row('assistant/message', { turn: 1, step: 0, message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [
        { type: 'reasoning', text: `tidepool ${JOURNAL}` }, { type: 'text', text: 'Here is the tidepool note.' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: `{"path":"/dsh/home/auma/private/journal.md","echo":"tidepool ${JOURNAL}"}` }] } }),
      row('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: `{"path":"/dsh/home/auma/private/journal.md","echo":"tidepool ${JOURNAL}"}` }),
      row('tool/result', { turn: 1, step: 0, message: { id: 'r1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool' },
        content: [{ type: 'text', text: JOURNAL }] } }),
      row('system/message', { turn: 1, step: 0, message: { id: 's', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: JOURNAL }] } }),
      row('user/message', { id: 'n', role: 'user', source: { kind: 'notice' }, content: [{ type: 'text', text: `file changed: ${JOURNAL}` }] }),
      JSON.stringify({ text: `an untyped line ${JOURNAL}` }),
    ].join('\n') + '\n')
    const report = await inspectBrowserEstate(vfs, { sections: ['search'], query: 'tidepool' })
    const search = report.search as { hits: Array<{ path: string; snippet: string; who: string }> }
    const mine = search.hits.filter(hit => hit.path.endsWith('/sj/session.v4.jsonl'))
    expect(mine.map(hit => [hit.who, hit.snippet]).sort()).toEqual([
      ['he', 'read my tidepool notes'], ['she', 'Here is the tidepool note.'], ['title', 'Tidepool walk']])
    expect(JSON.stringify(report)).not.toContain('synthetic-journal-line')
    const direct = await inspectBrowserEstate(vfs, { sections: ['search'], query: 'synthetic-journal-line' })
    expect(direct.search).toMatchObject({ ok: true, hits: [] })
  })

  it('pages and bounds its output', async () => {
    const vfs = estate()
    for (let i = 0; i < 1500; i += 1) {
      vfs.mkdirSync('/dsh/home/auma/bulk', { recursive: true })
      vfs.writeFileSync(`/dsh/home/auma/bulk/file-${String(i).padStart(4, '0')}-${'x'.repeat(120)}.txt`, String(i))
    }
    const first = await inspectBrowserEstate(vfs, { sections: ['vfs'], limit: 50 })
    const page = (first.vfs as { page: { returned: number; nextCursor: number | null } }).page
    expect(page).toMatchObject({ returned: 50, nextCursor: 50 })
    const second = await inspectBrowserEstate(vfs, { sections: ['vfs'], limit: 50, cursor: 50 })
    type Page = { entries: Array<{ path: string }> }
    expect((second.vfs as Page).entries[0]!.path).not.toBe((first.vfs as Page).entries[0]!.path)
    const huge = await inspectBrowserEstate(vfs, { sections: ['vfs'], limit: 1000 })
    expect(Number(huge.outputBytes)).toBeLessThanOrEqual(ESTATE_LIMITS.outputBytes)
    expect(huge.outputTrimmed).toEqual(['vfs.entries'])
  })
})

describe('x6_browser_estate tool (mounted)', () => {
  it('is registered, Class 0, makes no network request, and reports live Cordis and persistence views', async () => {
    const vfs = estate()
    const { tool, calls } = await mountE4({ vfs })
    calls.length = 0
    const report = await tool('x6_browser_estate').execute({ sections: ['cordis', 'persistence', 'vfs'], limit: 10 }) as Record<string, unknown>
    expect(report.ok).toBe(true)
    expect(calls).toEqual([])
    expect(report.cordis).toMatchObject({ head: { epoch: 7 }, registeredTools: expect.arrayContaining(['x6_browser_estate', 'stage_organ_promotion']) as unknown })
    expect((report.cordis as { activeFibers: Array<{ id: string }> }).activeFibers.map(fiber => fiber.id).sort()).toEqual(['organ-a', 'seed-pearl'])
    expect(report.persistence).toMatchObject({ queue: { available: false, code: 'PERSISTENCE_NOT_INITIALIZED' } })
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT)
  })
})
