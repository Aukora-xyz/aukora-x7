// CARD 3a: the lane joins her index rows to this browser's sessions by SESSION id. That seam is the
// one the worker spec cannot see, and the one that made every reader say "only in this browser" for every conversation
// while listing every index row as cloud-only. These cases pin the join and the four claims built on it.
import { describe, expect, it } from 'vitest'
import { joinCloudRows, type ThreadCloudLocal, type ThreadCloudRow } from '../src/client/spatial/portal/thread-sync-marks.ts'

const SESSION = 'session-5e000009-0000-4000-8000-000000000009'
const OTHER = 'session-5e000008-0000-4000-8000-000000000008'
/** What her worker's index calls a thread's `id`: sha256 of the journal path, 64 hex. It is NOT a SessionId. */
const THREAD_ID = 'a'.repeat(64)

const row = (session: string, over: Partial<ThreadCloudRow> = {}): ThreadCloudRow => ({
  id: session,
  path: `/dsh/home/sessions/auma/${session}/session.v4.jsonl`,
  bytes: 100,
  activeAt: 1_700_000_000_000,
  title: null,
  local: null,
  long: false,
  ...over,
})

const local = (id: string, hidden = false): ThreadCloudLocal => ({ id, hidden })

describe('the lane joins her index rows by session id', () => {
  it('a held conversation takes the index title and time, and is neither cloud-only nor local-only', () => {
    const joined = joinCloudRows([row(SESSION, { title: 'Long thread ✨', bytes: 190_000_000, local: 190_000_000 })], [local(SESSION)])
    expect(joined.bySession.get(SESSION)?.title).toBe('Long thread ✨')
    expect(joined.bySession.get(SESSION)?.activeAt).toBe(1_700_000_000_000)
    expect(joined.cloudOnly).toHaveLength(0)
    expect(joined.localOnly).toHaveLength(0)
    expect(joined.olderCopies).toHaveLength(0)
  })

  it('a row this browser has no session for is listed, and a named one keeps its name', () => {
    const joined = joinCloudRows([row(OTHER, { title: 'Main build', bytes: 70_000_000, long: true })], [local(SESSION)])
    expect(joined.cloudOnly.map(entry => entry.id)).toEqual([OTHER])
    expect(joined.cloudOnly[0]?.title).toBe('Main build')
    expect(joined.cloudOnly[0]?.long).toBe(true)
    expect(joined.localOnly).toEqual([SESSION])
  })

  it('a local session her index does not list is the only thing under "only in this browser"', () => {
    const joined = joinCloudRows([], [local(SESSION)])
    expect(joined.localOnly).toEqual([SESSION])
    expect(joined.cloudOnly).toHaveLength(0)
  })

  it('a blank, subagent or voice session is never called "only in this browser"', () => {
    const joined = joinCloudRows([], [local(SESSION, true), local(OTHER)])
    expect(joined.localOnly).toEqual([OTHER])
  })

  it('a smaller copy here is an older copy, never a deletion', () => {
    const joined = joinCloudRows([row(SESSION, { bytes: 100, local: 40 })], [local(SESSION)])
    expect(joined.olderCopies.map(entry => [entry.id, entry.local, entry.bytes])).toEqual([[SESSION, 40, 100]])
    expect(joined.localOnly).toHaveLength(0)
  })

  it('the thread id is not a session id: joining on it would say everything is cloud-only and everything local-only', () => {
    // The shape the lane had before ad872eb2 was fixed: the row carried the 64-hex thread id.
    const joined = joinCloudRows([row(THREAD_ID, { title: 'Long thread ✨' })], [local(SESSION)])
    expect(joined.bySession.get(SESSION)).toBeUndefined()
    expect(joined.cloudOnly).toHaveLength(1)
    expect(joined.localOnly).toEqual([SESSION])
  })
})
