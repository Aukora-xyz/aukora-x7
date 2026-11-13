/** Add the loaded build's retention obligations without erasing local suite work. */
import { retentionSuiteDigest, retentionSuiteExtendsBaseline } from './scion-growth.ts'
import { sha256HexSync } from '../module-system/module-loader.ts'

export const RETENTION_BOOT_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const MAX_BYTES = 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : object(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
function fail(code: string): never { throw new Error(code) }
function bounded(text: string): string {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('RETENTION_BOOT_LIMIT')
  return text
}
function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bounded(text))
  if (!object(value) || !retentionSuiteExtendsBaseline(value, value)) fail('RETENTION_BOOT_INVALID')
  return value
}

/** Merge two orders without changing either; a cycle is a conflict, never a reorder. */
function orderedUnion(left: string[], right: string[]): string[] {
  const names = [...new Set([...left, ...right])]
  const edges = new Map(names.map(name => [name, new Set<string>()]))
  const degree = new Map(names.map(name => [name, 0]))
  const successors = (name: string): Set<string> => {
    const found = edges.get(name)
    if (!found) fail('RETENTION_BOOT_ORDER_CONFLICT')
    return found
  }
  for (const list of [left, right]) {
    let previous: string | undefined
    for (const name of list) {
      if (previous !== undefined && !successors(previous).has(name)) {
        successors(previous).add(name); degree.set(name, (degree.get(name) ?? 0) + 1)
      }
      previous = name
    }
  }
  const result: string[] = []
  const ready = names.filter(name => degree.get(name) === 0)
  for (const name of ready) {
    result.push(name)
    for (const next of successors(name)) {
      degree.set(next, (degree.get(next) ?? 0) - 1)
      if (degree.get(next) === 0) ready.push(next)
    }
  }
  if (result.length !== names.length) fail('RETENTION_BOOT_ORDER_CONFLICT')
  return result
}

/**
 * Preserve all local rows, fixtures, metadata and both orders; refuse ambiguous changes.
 * @param currentText - Current bytes, or null only for a verified absent file.
 * @param baseline - Detached build-authenticated six-field baseline.
 * @returns Unchanged bytes or a validated additive successor (not the original repository file bytes).
 */
export function planRetentionSuiteBoot(currentText: string | null, baseline: Record<string, unknown>): string {
  if (!retentionSuiteExtendsBaseline(baseline, baseline)) fail('RETENTION_BOOT_BASELINE_INVALID')
  if (currentText === null) return bounded(JSON.stringify(baseline, null, 2) + '\n')
  const current = parse(currentText)
  if (retentionSuiteExtendsBaseline(current, baseline)) return currentText
  for (const key of ['schema', 'harness', 'fixedNow']) {
    if (canonical(current[key] ?? null) !== canonical(baseline[key] ?? null)) fail('RETENTION_BOOT_SETTINGS_CONFLICT')
  }
  const currentCases = current.cases as Record<string, unknown>[]
  const baselineCases = baseline.cases as Record<string, unknown>[]
  const rows = new Map(currentCases.map(row => [row.id as string, row]))
  for (const row of baselineCases) {
    const id = row.id as string
    if (rows.has(id) && canonical(rows.get(id)) !== canonical(row)) fail('RETENTION_BOOT_CASE_CONFLICT')
    rows.set(id, row)
  }
  const fixtures = { ...(current.fixtures as Record<string, unknown>) }
  for (const [name, fixture] of Object.entries(baseline.fixtures as Record<string, unknown>)) {
    if (Object.hasOwn(fixtures, name) && canonical(fixtures[name]) !== canonical(fixture)) fail('RETENTION_BOOT_FIXTURE_CONFLICT')
    Object.defineProperty(fixtures, name, { value: fixture, enumerable: true, configurable: true, writable: true })
  }
  const merged = { ...current,
    organs: orderedUnion(baseline.organs as string[], current.organs as string[]),
    cases: orderedUnion(baselineCases.map(row => row.id as string), currentCases.map(row => row.id as string)).map(id => rows.get(id)),
    fixtures,
  }
  if (!retentionSuiteExtendsBaseline(merged, baseline) || !retentionSuiteExtendsBaseline(merged, current)) fail('RETENTION_BOOT_INVALID')
  return bounded(JSON.stringify(merged, null, 2) + '\n')
}

export interface RetentionBootIO {
  /** Return null only for absence; other read failures must throw. */
  read(path: string): string | null
  write(path: string, text: string): void
  /** Durable local writer, without conflict or a local-save error. */
  writable(): boolean
  /** No local paths remain awaiting acknowledgement. */
  saved(): boolean
  flush(): Promise<void>
}
export interface RetentionBootResult {
  status: 'unchanged' | 'installed' | 'extended' | 'blocked' | 'persistence-unconfirmed'
  code?: string
  baselineDigest: string | null
  beforeSha256?: string | null
  afterSha256?: string
}
/**
 * Boot-only migration: preserve a durably acknowledged backup, then compare-and-write once.
 * @param io - Local persistence adapter; never downloads or touches head/session data.
 * @param baseline - The loaded bundle's authenticated baseline, or null when unavailable.
 * @returns Bounded status and hashes, never suite contents or arbitrary exception text.
 */
export async function migrateRetentionSuiteAtBoot(
  io: RetentionBootIO, baseline: Record<string, unknown> | null,
): Promise<RetentionBootResult> {
  const baselineDigest = baseline === null ? null : retentionSuiteDigest(baseline)
  let wroteSuite = false
  let beforeSha256: string | null | undefined
  let afterSha256: string | undefined
  try {
    if (baseline === null) fail('RETENTION_BOOT_BASELINE_UNAVAILABLE')
    const before = io.read(RETENTION_BOOT_PATH)
    if (before !== null) bounded(before)
    const after = planRetentionSuiteBoot(before, baseline)
    beforeSha256 = before === null ? null : sha256HexSync(before)
    afterSha256 = sha256HexSync(after)
    if (before === after) return { status: 'unchanged', baselineDigest, beforeSha256, afterSha256 }
    if (!io.writable()) fail('RETENTION_BOOT_PERSISTENCE_UNAVAILABLE')
    // Runtime mount may already have created history directories. Drain those authorized
    // startup writes before our backup, then refuse any concurrent suite change.
    if (!io.saved()) await io.flush()
    if (!io.writable() || !io.saved()) fail('RETENTION_BOOT_PERSISTENCE_UNAVAILABLE')
    if (io.read(RETENTION_BOOT_PATH) !== before) fail('RETENTION_BOOT_CHANGED')
    if (before !== null) {
      const backupPath = RETENTION_BOOT_PATH + '.before-' + beforeSha256
      const backup = io.read(backupPath)
      if (backup !== null && backup !== before) fail('RETENTION_BOOT_BACKUP_CONFLICT')
      if (backup === null) io.write(backupPath, before)
      await io.flush()
      if (!io.writable() || !io.saved() || io.read(backupPath) !== before) fail('RETENTION_BOOT_BACKUP_UNCONFIRMED')
    }
    // No await between this comparison and the suite write; concurrent changes never get overwritten.
    if (!io.writable() || !io.saved()) fail('RETENTION_BOOT_PERSISTENCE_UNAVAILABLE')
    if (io.read(RETENTION_BOOT_PATH) !== before) fail('RETENTION_BOOT_CHANGED')
    io.write(RETENTION_BOOT_PATH, after)
    wroteSuite = true
    await io.flush()
    if (!io.writable() || !io.saved() || io.read(RETENTION_BOOT_PATH) !== after) fail('RETENTION_BOOT_SAVE_UNCONFIRMED')
    return { status: before === null ? 'installed' : 'extended', baselineDigest, beforeSha256, afterSha256 }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const code = /^RETENTION_BOOT_[A-Z_]+$/.test(message) ? message : 'RETENTION_BOOT_IO_OR_PARSE_ERROR'
    return { status: wroteSuite ? 'persistence-unconfirmed' : 'blocked', code, baselineDigest,
      ...(beforeSha256 === undefined ? {} : { beforeSha256 }), ...(afterSha256 === undefined ? {} : { afterSha256 }) }
  }
}
