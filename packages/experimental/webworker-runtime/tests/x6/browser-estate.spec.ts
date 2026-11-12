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

function estate(): MemoryVfs {
  const vfs = new MemoryVfs()
  const put = (path: string, text: string) => { vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); vfs.writeFileSync(path, text) }
  put('/dsh/home/auma/WISH.md', '- [ ] grow\n')
  put('/dsh/home/auma/workspaces/garden/notes.md', 'garden notes')
  put('/dsh/home/auma/private/owner.json', PRIVATE_TEXT)
  put('/dsh/home/auma/keys/device-keypair.json', 'synthetic key material')
  put('/dsh/home/sessions/--dsh-home-auma--/s1/session.v1.jsonl', JSON.stringify({ type: 'session', id: 's1', title: 'Root talk' }) + '\n{"text":"we spoke of tidepools"}\n')
  put('/dsh/home/sessions/--dsh-home-auma-one--/s0/session.v1.jsonl', JSON.stringify({ type: 'session', id: 's0', title: 'Legacy' }) + '\n{"text":"tidepools again"}\n')
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
    expect(report.cordis).toMatchObject({ head: { epoch: 7 }, registeredTools: expect.arrayContaining(['x6_browser_estate', 'stage_organ_promotion']) })
    expect((report.cordis as { activeFibers: Array<{ id: string }> }).activeFibers.map(fiber => fiber.id).sort()).toEqual(['organ-a', 'seed-pearl'])
    expect(report.persistence).toMatchObject({ queue: { available: false, code: 'PERSISTENCE_NOT_INITIALIZED' } })
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT)
  })
})
