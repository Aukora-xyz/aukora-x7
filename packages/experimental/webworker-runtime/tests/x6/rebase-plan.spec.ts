/**
 * The pure rebase plan (`planRebase`), the changes answer's parser and the `chrome-wins` planner, with no
 * IndexedDB and no network. Every named refusal is reached; each refusal says why and changes nothing (the plan is pure).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CHROME_WINS_OVERRIDES, CLOUD_WAKE_CHECKPOINT_PATH, JOURNAL_BACKUP_ROOT, REBASE_LIMITS, parseRebaseChanges, planChromeWins, planRebase,
  rebaseBackupPath, type Entry, type MirrorBatch, type MirrorMeta, type RebaseChanges, type RebaseInput, type RebaseVersion, type WireEntry,
} from '../../src/storage/idb-persist.ts'

type Json = Record<string, unknown>
const edge = async (relative: string): Promise<Json> =>
  await import(new URL(`../../../../../deploy/cloudflare/src/${relative}`, import.meta.url).href) as Json
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const LINEAGE = '5e000005-0000-4000-8000-000000000005'
const CLIENT = '5e000006-0000-4000-8000-000000000006'
const NOTE = '/dsh/home/auma/notes/note-001.md'
const file = (bytes: Uint8Array, mode = 0o600): Entry => ({ kind: 'file', bytes, mode, mtimeMs: 1 })
const wireFile = (bytes: Uint8Array, mode = 0o600): WireEntry => ({ kind: 'file', b64: b64(bytes), mode, mtimeMs: 1 })
const LINE1 = text('{"schema":"aukora.cloud-wake-checkpoint.v1","id":"1"}\n')
const LINE2 = text('{"schema":"aukora.cloud-wake-checkpoint.v1","id":"2"}\n')
const both = new Uint8Array([...LINE1, ...LINE2])

function meta(revision = 2083, acknowledged = 40, seq = 41): MirrorMeta {
  return { kind: 'mirror-meta', clientId: CLIENT, seq, cloudBase: { lineageId: LINEAGE, revision }, cloudAcknowledgedSeq: acknowledged }
}
function queued(seq: number, revision: number, path = NOTE, bytes = text('note\n')): MirrorBatch {
  const batch: MirrorBatch['batch'] = { clientId: CLIENT, seq, id: `${CLIENT}:${String(seq)}`, entries: [[path, wireFile(bytes, 0o644)]], cloudBase: { lineageId: LINEAGE, revision } }
  return { kind: 'mirror-batch', batch, digest: sha(JSON.stringify(batch)) }
}
const wakeVersion = (revision: number, seq: number): RebaseVersion => ({ revision, writer: 'wake', client: 'aba73f74', seq, digest: 'd'.repeat(64),
  acknowledgedAt: 1_762_950_000_000 + revision, applied: 1, paths: [CLOUD_WAKE_CHECKPOINT_PATH] })
const browserVersion = (revision: number, seq: number): RebaseVersion => ({ revision, writer: 'browser', client: '9a0c33e1', seq, digest: 'e'.repeat(64),
  acknowledgedAt: 1_762_950_000_000 + revision, applied: 2, paths: null })
function changes(overrides: Partial<RebaseChanges> = {}): RebaseChanges {
  const revisions = Array.from({ length: 7 }, (_, index) => wakeVersion(2084 + index, 10 + index))
  return { lineageId: LINEAGE, revision: 2090, since: 2083, complete: true, revisions,
    entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: wireFile(both) },
    tooLarge: false, clientHeadSeq: 40, mode: 'apply', ...overrides }
}
const HERS: ReadonlyMap<string, Entry> = new Map([[CLOUD_WAKE_CHECKPOINT_PATH, file(LINE1)]])
function input(overrides: Partial<RebaseInput> = {}, local: ReadonlyMap<string, Entry> = HERS): RebaseInput {
  return { meta: meta(), queue: [queued(41, 2083)], changes: changes(), local: path => local.get(path) ?? null,
    held: { tombstones: [], resets: [], journals: [] }, ...overrides }
}

describe('the changes answer is checked field by field', () => {
  const answer = (patch: Json = {}): string => JSON.stringify({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision: 2090, since: 2083,
    complete: true, revisions: changes().revisions, entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: wireFile(both) }, clientHeadSeq: 40, mode: 'report', ...patch })
  it('a well-formed answer parses', () => {
    const parsed = parseRebaseChanges(answer())
    expect(parsed?.revisions).toHaveLength(7)
    expect(parsed?.mode).toBe('report')
    expect(parseRebaseChanges(answer({ entries: null, tooLarge: true }))?.tooLarge).toBe(true)
  })
  it('anything malformed is null (the tab then stays exactly as today)', () => {
    const bad: Json[] = [{ ok: false }, { protocol: 'x' }, { lineageId: 'nope' }, { since: 2091 }, { mode: 'on' }, { complete: 'yes' }, { clientHeadSeq: -1 },
      { revisions: [wakeVersion(2085, 1), wakeVersion(2084, 2)] }, { revisions: [{ ...wakeVersion(2084, 1), writer: 'phone' }] },
      { revisions: [{ ...wakeVersion(2084, 1), paths: ['/etc/passwd'] }] }, { revisions: [wakeVersion(2091, 1)] },
      { entries: {} }, { entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: { kind: 'file', mode: 0o600, mtimeMs: 1, b64: 'QQ' } } },
      { entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: { kind: 'file', mode: 0o1000, mtimeMs: 1, b64: '' } } },
      { entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: wireFile(both), '/dsh/home/x': { kind: 'dir', mode: 0o755 } } }, { entries: null }]
    for (const patch of bad) expect(parseRebaseChanges(answer(patch)), JSON.stringify(patch)).toBeNull()
    expect(parseRebaseChanges('not json')).toBeNull()
  })
})

describe('planRebase', () => {
  it('seven wake checkpoints whose file extends hers: ready, adopts the checkpoint file only, drops her refused save', () => {
    const plan = planRebase(input())
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect([plan.from, plan.to, plan.ack, plan.lineageId]).toEqual([2083, 2090, 40, LINEAGE])
    expect(plan.adopt.map(item => item.path)).toEqual([CLOUD_WAKE_CHECKPOINT_PATH])
    expect(plan.adopt[0]?.cloudSha).toBe(sha(both))
    expect(plan.adopt[0]?.localSha).toBe(sha(LINE1))
    expect(plan.dropped.map(item => [item.seq, item.paths])).toEqual([[41, [NOTE]]])
    expect(plan.versions.every(item => item.writer === 'wake')).toBe(true)
  })
  it('a checkpoint file she does not have is adopted; one equal to the cloud\'s is converged', () => {
    const absent = planRebase(input({}, new Map()))
    expect(absent.kind === 'ready' && absent.adopt[0]?.local).toBeNull()
    const same = planRebase(input({}, new Map([[CLOUD_WAKE_CHECKPOINT_PATH, file(both)]])))
    expect(same.kind === 'ready' && [same.adopt.length, same.converged]).toEqual([0, [CLOUD_WAKE_CHECKPOINT_PATH]])
  })
  it('REBASE_LINEAGE and REBASE_BASE_MISMATCH', () => {
    expect(planRebase(input({ changes: changes({ lineageId: '11111111-1111-4111-8111-111111111111' }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_LINEAGE' })
    expect(planRebase(input({ changes: changes({ since: 2082 }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_BASE_MISMATCH' })
    expect(planRebase(input({ meta: undefined }))).toMatchObject({ kind: 'refused', code: 'REBASE_BASE_MISMATCH' })
    // A queue that is not intact (a batch on the wrong fence) is never rebased.
    expect(planRebase(input({ queue: [queued(41, 2080)] }))).toMatchObject({ kind: 'refused', code: 'REBASE_BASE_MISMATCH' })
  })
  it('REBASE_OWN_SAVE_APPLIED, and its one exception: her own first queued saves are her lost acknowledgements', () => {
    expect(planRebase(input({ changes: changes({ clientHeadSeq: 41 }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_OWN_SAVE_APPLIED' })
    const mine = queued(41, 2083)
    const own: RebaseVersion = { revision: 2084, writer: 'self', client: CLIENT.slice(0, 8), seq: 41, digest: mine.digest, acknowledgedAt: 1, applied: 1, paths: null }
    const revisions = [own, ...Array.from({ length: 6 }, (_, index) => wakeVersion(2085 + index, 10 + index))]
    const ready = planRebase(input({ queue: [mine, queued(42, 2084, '/dsh/home/auma/notes/other.md')], meta: meta(2083, 40, 42), changes: changes({ revisions, clientHeadSeq: 41 }) }))
    expect(ready).toMatchObject({ kind: 'ready', ack: 41 })
    expect(ready.kind === 'ready' && ready.dropped.map(item => item.seq)).toEqual([42])
    const wrong = { ...own, digest: 'f'.repeat(64) }
    expect(planRebase(input({ queue: [mine], changes: changes({ revisions: [wrong, ...revisions.slice(1)], clientHeadSeq: 41 }) })))
      .toMatchObject({ kind: 'refused', code: 'REBASE_OWN_SAVE_APPLIED' })
    // Every version is one of her own queued saves: nothing to rebase; the drain confirms them.
    expect(planRebase(input({ queue: [mine], changes: changes({ revision: 2084, revisions: [own], entries: {}, clientHeadSeq: 41 }) }))).toMatchObject({ kind: 'not-needed' })
  })
  it('REBASE_RECEIPTS_INCOMPLETE, REBASE_CHANGES_UNKNOWN (with each version\'s writer and time), REBASE_TOO_LARGE', () => {
    expect(planRebase(input({ changes: changes({ complete: false }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_RECEIPTS_INCOMPLETE', ack: 40 })
    const wakes = Array.from({ length: 5 }, (_, index) => wakeVersion(2086 + index, 10 + index))
    const phone = [browserVersion(2084, 1), browserVersion(2085, 2), ...wakes]
    const unknown = planRebase(input({ changes: changes({ revisions: phone }) }))
    expect(unknown).toMatchObject({ kind: 'refused', code: 'REBASE_CHANGES_UNKNOWN', ack: 40 })
    expect(unknown.kind === 'refused' && unknown.detail).toContain('2084 by browser 9a0c33e1 at 2025-')
    expect(unknown.kind === 'refused' && unknown.dropped.map(item => item.seq)).toEqual([41])
    expect(planRebase(input({ changes: changes({ entries: null, tooLarge: true }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_TOO_LARGE' })
  })
  it('REBASE_WITHHELD and REBASE_DELETION_UNSUPPORTED', () => {
    expect(planRebase(input({ changes: changes({ entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: { kind: 'withheld' } } }) }))).toMatchObject({ kind: 'refused', code: 'REBASE_WITHHELD' })
    const secret = '/dsh/home/auma/.credentials.yaml'
    const secretVersions = [{ ...wakeVersion(2084, 1), paths: [secret] }]
    expect(planRebase(input({ changes: changes({ revision: 2084, revisions: secretVersions, entries: { [secret]: wireFile(text('x')) } }) })))
      .toMatchObject({ kind: 'refused', code: 'REBASE_WITHHELD' })
    expect(planRebase(input({ changes: changes({ entries: { [CLOUD_WAKE_CHECKPOINT_PATH]: { kind: 'missing', reset: true } } }) })))
      .toMatchObject({ kind: 'refused', code: 'REBASE_DELETION_UNSUPPORTED' })
  })
  it('REBASE_CONFLICT lists each path with why, the version, and both digests and sizes', () => {
    const diverged = planRebase(input({}, new Map([[CLOUD_WAKE_CHECKPOINT_PATH, file(text('{"other":1}\n'))]])))
    expect(diverged).toMatchObject({ kind: 'refused', code: 'REBASE_CONFLICT' })
    expect(diverged.kind === 'refused' && diverged.conflicts[0]).toMatchObject({ path: CLOUD_WAKE_CHECKPOINT_PATH, revision: 2090, writer: 'wake',
      cloudSha: sha(both), cloudBytes: both.byteLength, localSha: sha('{"other":1}\n'), localBytes: 12 })
    const queuedOverlap = planRebase(input({ queue: [queued(41, 2083, CLOUD_WAKE_CHECKPOINT_PATH, LINE1)] }))
    expect(queuedOverlap).toMatchObject({ kind: 'refused', code: 'REBASE_CONFLICT' })
    expect(queuedOverlap.kind === 'refused' && queuedOverlap.conflicts[0]?.why).toContain('this browser changed it')
    expect(planRebase(input({ held: { tombstones: [], resets: ['/dsh/home/auma/seed'], journals: [] } }))).toMatchObject({ kind: 'refused', code: 'REBASE_CONFLICT' })
    // A path some tab code writes is never adopted, even when she holds none of it.
    const other = '/dsh/home/auma/wake/steps.jsonl'
    const versions = [{ ...wakeVersion(2084, 1), paths: [other] }]
    expect(planRebase(input({ changes: changes({ revision: 2084, revisions: versions, entries: { [other]: wireFile(text('a\n')) } }) }, new Map())))
      .toMatchObject({ kind: 'refused', code: 'REBASE_CONFLICT' })
  })
  it('chrome-wins takes over only attribution and overlap refusals', () => {
    expect([...CHROME_WINS_OVERRIDES].sort()).toEqual(['REBASE_CHANGES_UNKNOWN', 'REBASE_CONFLICT', 'REBASE_DELETION_UNSUPPORTED', 'REBASE_RECEIPTS_INCOMPLETE', 'REBASE_TOO_LARGE'])
  })
})

describe('planChromeWins', () => {
  const CHECKPOINTS = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
  const LATEST = '/dsh/home/auma/snapshots/LATEST.json'
  const ONLY_CLOUD = '/dsh/home/auma/notes/phone-only.md'
  const rows = (): Map<string, Entry> => new Map<string, Entry>([
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], [NOTE, file(text('hers\n'), 0o644)], [LATEST, file(text('{"hers":1}'), 0o644)],
    [CLOUD_WAKE_CHECKPOINT_PATH, file(LINE1)], [CHECKPOINTS, file(both, 0o644)]])
  const cloud = (): Map<string, Entry> => new Map<string, Entry>([
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], [NOTE, file(text('phone\n'), 0o644)], [LATEST, file(text('{"phone":1}'), 0o644)],
    [CLOUD_WAKE_CHECKPOINT_PATH, file(both)], [CHECKPOINTS, file(LINE1, 0o644)], [ONLY_CLOUD, file(text('phone only\n'), 0o644)]])
  it('adopts only the journal the cloud extended, records every overridden path with the cloud\'s bytes kept, leaves cloud-only files alone', () => {
    const plan = planChromeWins(rows(), new Set(), cloud(), 2090)
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.adopt.map(item => item.path)).toEqual([CLOUD_WAKE_CHECKPOINT_PATH])
    // Her checkpoints journal extends the cloud's: hers is sent (an append the cloud takes), and it is an override on record.
    expect(plan.overridden.map(item => item.path)).toEqual([NOTE, CHECKPOINTS, LATEST])
    expect(plan.overridden.find(item => item.path === NOTE)).toMatchObject({ cloudSha: sha('phone\n'), cloudBytes: 6, localSha: sha('hers\n'), localBytes: 5 })
    expect(plan.overridden.every(item => item.cloudBackup?.startsWith(`${JOURNAL_BACKUP_ROOT}/rebase-2190/cloud/`))).toBe(true)
    expect(plan.cloudBackups.map(([path]) => path)).toEqual(plan.overridden.map(item => item.cloudBackup))
    expect(plan.overridden.some(item => item.path === ONLY_CLOUD)).toBe(false)
  })
  it('refuses when the cloud would refuse her copy, when the resync would refuse, or for a deletion no tombstone explains', () => {
    const diverged = rows(); diverged.set(CLOUD_WAKE_CHECKPOINT_PATH, file(text('{"mine":1}\n')))
    expect(planChromeWins(diverged, new Set(), cloud(), 2090)).toMatchObject({ kind: 'refused', code: 'REBASE_JOURNAL_DIVERGED', paths: [CLOUD_WAKE_CHECKPOINT_PATH] })
    const dag = `/dsh/home/auma/memory/dag/${'a'.repeat(64)}.json`
    const withDag = rows(); withDag.set(dag, file(text('{"a":1}')))
    const cloudDag = cloud(); cloudDag.set(dag, file(text('{"a":2}')))
    expect(planChromeWins(withDag, new Set(), cloudDag, 2090)).toMatchObject({ kind: 'refused', code: 'REBASE_JOURNAL_DIVERGED', paths: [dag] })
    // A file tombstone this browser recorded is carried out at her cloud, with the cloud's bytes kept.
    const deleting = rows(); deleting.set(ONLY_CLOUD, { kind: 'gone' })
    const deleted = planChromeWins(deleting, new Set(), cloud(), 2090)
    expect(deleted.kind).toBe('ready')
    if (deleted.kind === 'ready') {
      const removed = deleted.overridden.find(item => item.path === ONLY_CLOUD)
      expect(removed).toMatchObject({ localSha: null, localBytes: null, cloudSha: sha('phone only\n'), cloudBytes: 11 })
      expect(removed?.cloudBackup).not.toBeNull()
      expect(deleted.cloudBackups.map(([path]) => path)).toContain(removed?.cloudBackup)
    }
    // A reset root is not a deletion: it records that this browser's rows for the subtree are unknown, so it still refuses.
    expect(planChromeWins(rows(), new Set(['/dsh/home/auma/notes']), cloud(), 2090)).toMatchObject({ kind: 'refused', code: 'REBASE_DELETION_UNSUPPORTED' })
    const cleared = rows(); cleared.set('/dsh/home', { kind: 'gone' })
    expect(planChromeWins(cleared, new Set(), cloud(), 2090)).toMatchObject({ kind: 'refused', code: 'REBASE_RESYNC_REFUSED' })
  })
  it('keeps the cloud\'s bytes only within the changes route\'s bound; a quarantined file is never an override', () => {
    const big = new Uint8Array(9 * 1024 * 1024).fill(0x61)
    const mine = rows(), theirs = cloud()
    for (const name of ['a', 'b']) { mine.set(`/dsh/home/auma/notes/${name}.md`, file(text(name), 0o644)); theirs.set(`/dsh/home/auma/notes/${name}.md`, file(big, 0o644)) }
    const journal = '/dsh/home/sessions/p/main/session.v4.jsonl'
    mine.set(journal, file(new Uint8Array(24 * 1024 * 1024 + 1).fill(0x62), 0o644)); theirs.set(journal, file(text('old\n'), 0o644))
    const plan = planChromeWins(mine, new Set(), theirs, 2090)
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.overridden.filter(item => item.path.endsWith('/a.md') || item.path.endsWith('/b.md')).map(item => item.cloudBackup === null)).toEqual([false, true])
    expect(plan.cloudBackups.reduce((sum, [, entry]) => sum + entry.bytes.byteLength, 0)).toBeLessThanOrEqual(REBASE_LIMITS.fileBytes)
    expect(plan.overridden.some(item => item.path === journal)).toBe(false)
  })
  it('backup paths are local-only rows under the conflict-backup root', () => {
    expect(rebaseBackupPath(2090, 'local', CLOUD_WAKE_CHECKPOINT_PATH, LINE1)).toBe(`${JOURNAL_BACKUP_ROOT}/rebase-2190/cloud-wake-checkpoints.v1.jsonl.${sha(LINE1).slice(0, 16)}.bak`)
    expect(rebaseBackupPath(2090, 'cloud', NOTE, LINE1)).toBe(`${JOURNAL_BACKUP_ROOT}/rebase-2190/cloud/note-001.md.${sha(NOTE).slice(0, 8)}.${sha(LINE1).slice(0, 16)}.bak`)
  })
})

describe('twins of the edge', () => {
  it('the checkpoint path and the answer bounds are the edge\'s own', async () => {
    const head = await edge('head-do.mjs'), mirror = await edge('mirror-do.mjs')
    expect(CLOUD_WAKE_CHECKPOINT_PATH).toBe(head.CLOUD_WAKE_CHECKPOINT_PATH)
    expect({ paths: REBASE_LIMITS.paths, fileBytes: REBASE_LIMITS.fileBytes }).toEqual(mirror.MIRROR_CHANGES_LIMITS)
    expect(mirror.REBASE_MODES).toEqual(['off', 'report', 'apply', 'chrome-wins'])
  })
})
