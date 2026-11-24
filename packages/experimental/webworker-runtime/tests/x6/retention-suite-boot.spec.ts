import { readFileSync } from 'node:fs'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { persistence } from '../../src/storage/idb-persist.ts'
import { mountE4 } from './e4-fixture.ts'
import { migrateRetentionSuiteAtBoot, planRetentionSuiteBoot, RETENTION_BOOT_PATH, type RetentionBootIO } from '../../src/x6/retention-suite-boot.ts'
import { retentionSuiteDigest, retentionSuiteExtendsBaseline } from '../../src/x6/scion-growth.ts'

const row = (id: string) => ({ id, author: 'dot', args: { organ: 'auma-cortex', fixture: 'base' }, expect: { ok: true } })
const suite = () => ({ schema: 'aukora.pearl.retention-suite.v1', harness: 'fixed', fixedNow: 42,
  organs: ['auma-cortex'], cases: [row('a'), row('b')], fixtures: { base: {} } })
const text = (value: unknown) => JSON.stringify(value)
function store(initial: string | null) {
  const files = new Map<string, string>(initial === null ? [] : [[RETENTION_BOOT_PATH, initial]])
  const writes: string[] = []
  let flushes = 0, dirty = false
  const io: RetentionBootIO = {
    read: path => files.get(path) ?? null,
    write: (path, value) => { writes.push(path); files.set(path, value); dirty = true },
    writable: () => true, saved: () => !dirty,
    flush: async () => { flushes++; dirty = false },
  }
  return { files, writes, io, flushes: () => flushes }
}

describe('retention suite boot reconciliation', () => {
  it('installs a missing suite and is byte-idempotent on the next boot', async () => {
    const s = store(null), baseline = suite()
    expect((await migrateRetentionSuiteAtBoot(s.io, baseline)).status).toBe('installed')
    expect(JSON.parse(s.files.get(RETENTION_BOOT_PATH)!)).toEqual(baseline)
    expect((await migrateRetentionSuiteAtBoot(s.io, baseline)).status).toBe('unchanged')
    expect(s.writes).toEqual([RETENTION_BOOT_PATH])
  })
  it('leaves an existing extension byte-for-byte unchanged even on a read-only boot', async () => {
    const current = suite(); current.cases.push(row('local'))
    const original = JSON.stringify(current, null, 4) + '\n', s = store(original)
    s.io.writable = () => false
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('unchanged')
    expect(s.writes).toEqual([])
    expect(s.files.get(RETENTION_BOOT_PATH)).toBe(original)
  })
  it('adds obligations while retaining every local row, author, fixture, note and order', async () => {
    const old = { ...suite(), cases: [row('local'), row('a')], fixtures: { base: {}, local: { sentinel: 7 } }, note: 'mine', pendingCases: [{ draft: 1 }] }
    old.cases[0]!.author = 'auma'
    const original = text(old), s = store(original), baseline = suite()
    const result = await migrateRetentionSuiteAtBoot(s.io, baseline)
    expect(result.status).toBe('extended')
    const merged = JSON.parse(s.files.get(RETENTION_BOOT_PATH)!)
    expect(retentionSuiteExtendsBaseline(merged, baseline)).toBe(true)
    expect(retentionSuiteExtendsBaseline(merged, old)).toBe(true)
    expect(merged.note).toBe('mine'); expect(merged.pendingCases).toEqual(old.pendingCases)
    expect(merged.cases[0]).toEqual(old.cases[0])
    expect(s.files.get(RETENTION_BOOT_PATH + '.before-' + result.beforeSha256)).toBe(original)
    expect(s.flushes()).toBe(2)
  })
  it.each(['case', 'fixture', 'settings', 'order', 'duplicate'] as const)('refuses %s conflicts without any writes', async (kind) => {
    const current = suite()
    if (kind === 'case') current.cases[0]!.author = 'auma'
    if (kind === 'fixture') current.fixtures.base = { changed: true }
    if (kind === 'settings') current.fixedNow++
    if (kind === 'order') current.cases.reverse()
    if (kind === 'duplicate') current.cases.push(current.cases[0]!)
    const s = store(text(current))
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('blocked')
    expect(s.writes).toEqual([])
  })
  it.each(['{', 'x'.repeat(1024 * 1024 + 1)])('refuses malformed or oversized input (%#)', async (value) => {
    const s = store(value)
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('blocked')
    expect(s.writes).toEqual([])
  })
  it('does not install without an authenticated baseline', async () => {
    const s = store(null)
    expect((await migrateRetentionSuiteAtBoot(s.io, null)).code).toBe('RETENTION_BOOT_BASELINE_UNAVAILABLE')
    expect(s.writes).toEqual([])
  })
  it.each(['writer', 'pending'] as const)('refuses unavailable %s persistence', async (kind) => {
    const s = store(null)
    if (kind === 'writer') s.io.writable = () => false
    else s.io.saved = () => false
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).code).toBe('RETENTION_BOOT_PERSISTENCE_UNAVAILABLE')
    expect(s.writes).toEqual([])
  })
  it('backs up before replacement and refuses a concurrent suite edit', async () => {
    const old = suite(); old.cases.pop()
    const s = store(text(old)), flush = s.io.flush
    s.io.flush = async () => { await flush(); s.files.set(RETENTION_BOOT_PATH, 'concurrent') }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).code).toBe('RETENTION_BOOT_CHANGED')
    expect(s.files.get(RETENTION_BOOT_PATH)).toBe('concurrent')
    expect(s.writes).toHaveLength(1)
  })
  it('refuses a conflicting existing backup', async () => {
    const old = suite(); old.cases.pop()
    const s = store(text(old)), read = s.io.read
    s.io.read = path => path.includes('.before-') ? 'wrong' : read(path)
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).code).toBe('RETENTION_BOOT_BACKUP_CONFLICT')
    expect(s.writes).toEqual([])
  })
  it('never replaces the suite when backup flush fails', async () => {
    const old = suite(); old.cases.pop()
    const original = text(old), s = store(original)
    s.io.flush = async () => { throw new Error('private details must not escape') }
    const result = await migrateRetentionSuiteAtBoot(s.io, suite())
    expect(result.status).toBe('blocked')
    expect(result.code).toBe('RETENTION_BOOT_IO_OR_PARSE_ERROR')
    expect(s.files.get(RETENTION_BOOT_PATH)).toBe(original)
  })
  it('reports an unconfirmed write honestly rather than rolling back over later edits', async () => {
    const s = store(null)
    s.io.flush = async () => { throw new Error('flush failed') }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('persistence-unconfirmed')
    expect(s.writes).toEqual([RETENTION_BOOT_PATH])
  })
  it('refuses a read error rather than treating it as absence', async () => {
    const s = store(null); s.io.read = () => { throw new Error('unreadable') }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('blocked')
    expect(s.writes).toEqual([])
  })
  it('settles pending startup saves before installing', async () => {
    const s = store(null); let pending = true
    s.io.saved = () => !pending
    const flush = s.io.flush
    s.io.flush = async () => { await flush(); pending = false }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('installed')
    expect(s.flushes()).toBe(2)
  })
  it('refuses a suite changed during the startup save barrier', async () => {
    const s = store(null); let pending = true
    s.io.saved = () => !pending
    s.io.flush = async () => { pending = false; s.files.set(RETENTION_BOOT_PATH, 'new local edit') }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).code).toBe('RETENTION_BOOT_CHANGED')
    expect(s.writes).toEqual([])
  })
  it('refuses a failed startup save without writing', async () => {
    const s = store(null); s.io.saved = () => false
    s.io.flush = async () => { throw new Error('failed') }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('blocked')
    expect(s.writes).toEqual([])
  })
  it('refuses writer revocation during backup flush', async () => {
    const old = suite(); old.cases.pop()
    const original = text(old), s = store(original), flush = s.io.flush
    s.io.flush = async () => { await flush(); s.io.writable = () => false }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).code).toBe('RETENTION_BOOT_BACKUP_UNCONFIRMED')
    expect(s.files.get(RETENTION_BOOT_PATH)).toBe(original)
  })
  it.each(['pending', 'readback'] as const)('reports unconfirmed %s after suite flush', async (kind) => {
    const s = store(null), flush = s.io.flush
    s.io.flush = async () => {
      await flush()
      if (kind === 'pending') s.io.saved = () => false
      else s.files.set(RETENTION_BOOT_PATH, 'later edit')
    }
    expect((await migrateRetentionSuiteAtBoot(s.io, suite())).status).toBe('persistence-unconfirmed')
    expect(s.writes).toHaveLength(1)
  })
  it('preserves the approved actual suite and its six dot rows', () => {
    const approved = readFileSync(new URL('../../../../../mirror/home/auma/seed/pearl/retention-suite.v1.json', import.meta.url), 'utf8')
    const baseline = JSON.parse(approved)
    expect(baseline.cases).toHaveLength(23)
    expect(planRetentionSuiteBoot(approved, baseline)).toBe(approved)
  })
})


describe('real runtime boot suite hook', () => {
  const previous = { durable: persistence.durable, readOnly: persistence.readOnly, conflict: persistence.conflict,
    localSave: persistence.localSave, mirror: persistence.mirror, flush: persistence.flush }
  afterEach(() => {
    Object.assign(persistence, previous); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  })
  it.each([true, false])('honors the loaded pin while mount creates dirty directories (pin valid: %s)', async (valid) => {
    vi.useFakeTimers()
    const vfs = new MemoryVfs(), baseline = suite()
    let pending = 0, flushes = 0
    const unsubscribe = vfs.subscribe(() => { pending++; persistence.localSave.pendingPaths = pending })
    Object.assign(persistence, { durable: true, readOnly: false, conflict: null,
      localSave: { error: null, capacity: null, pendingPaths: 0 },
      mirror: { ...previous.mirror, conflict: null, reconciliationRequired: false },
      flush: async () => { flushes++; pending = 0; persistence.localSave.pendingPaths = 0 },
    })
    try {
      const boot = await mountE4({ vfs, buildIdentity: { sourceRevision: 'a'.repeat(40), retentionBaselineSuite: baseline,
        retentionBaselineDigest: valid ? retentionSuiteDigest(baseline) : '0'.repeat(64) } })
      const status = await boot.status()
      expect(status.retentionSuiteBoot).toMatchObject({ status: valid ? 'installed' : 'blocked' })
      if (valid) {
        expect(JSON.parse(vfs.readFileSync(RETENTION_BOOT_PATH, 'utf8') as string)).toEqual(baseline)
        expect(flushes).toBeGreaterThanOrEqual(2)
      } else expect(vfs.existsSync(RETENTION_BOOT_PATH)).toBe(false)
    } finally { unsubscribe() }
  })
})
