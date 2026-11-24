/**
 * `x6_self_state` `threadSync` (mode, role, sent, pending, lastOkAtMs, lastError) over the pure projection.
 * Absent from the registry: no key (answers of other lanes' registries are unchanged); a value of the wrong shape: null
 * with one `unknown` row; a long error is cut, never a secret shape passed through unchecked.
 */
import { describe, expect, it } from 'vitest'
import { projectSelfState, threadSyncView, type SelfStateRegistry } from '../../src/x6/self-state.ts'

const registry = (over: Partial<SelfStateRegistry> = {}): SelfStateRegistry => ({
  sourceRevision: '1'.repeat(40), bootedAtMs: 1_000, head: null, organs: [], staged: [], tools: ['x6_self_state'],
  cloudflareDoor: { registered: false, status: null }, ...over,
})
const observe = (value: SelfStateRegistry) => ({ registry: value, store: {}, edge: { sourceRevision: null, reason: 'unreachable' as const }, organFilter: null })

describe('x6_self_state threadSync', () => {
  it('her writer\'s facts are shown as they are, with fixed keys, before `unknown`', () => {
    const facts = { mode: 'on', role: 'writer', sent: 12, pending: 3, lastOkAtMs: 1_763_000_000_000, lastError: null }
    const answer = projectSelfState(observe(registry({ threadSync: facts })))
    expect(answer.threadSync).toEqual(facts)
    const keys = Object.keys(answer)
    expect(keys.indexOf('threadSync')).toBe(keys.indexOf('unknown') - 1)
    expect((answer.unknown as Array<{ field: string }>).some(row => row.field === 'threadSync')).toBe(false)
  })

  it('a reader before the mode was read: mode null, role reader', () => {
    expect(threadSyncView({ mode: null, role: 'reader', sent: 0, pending: 0, lastOkAtMs: null, lastError: null }))
      .toEqual({ mode: null, role: 'reader', sent: 0, pending: 0, lastOkAtMs: null, lastError: null })
  })

  it('no threadSync in the registry: no key at all (unchanged answers)', () => {
    expect(Object.keys(projectSelfState(observe(registry())))).not.toContain('threadSync')
  })

  it('a value of the wrong shape is null with one unknown row', () => {
    for (const bad of [null, { mode: 'everything', role: 'writer', sent: 0, pending: 0, lastOkAtMs: null, lastError: null },
      { mode: 'on', role: 'king', sent: 0, pending: 0, lastOkAtMs: null, lastError: null },
      { mode: 'on', role: 'writer', sent: -1, pending: 0, lastOkAtMs: null, lastError: null },
      { mode: 'on', role: 'writer', sent: 0, pending: 0, lastOkAtMs: null, lastError: 7 }]) {
      const answer = projectSelfState(observe(registry({ threadSync: bad as never })))
      expect(answer.threadSync).toBeNull()
      expect(answer.unknown).toContainEqual({ field: 'threadSync', reason: 'read-failed' })
    }
  })

  it('a long error is cut to 200 characters', () => {
    const view = threadSyncView({ mode: 'on', role: 'writer', sent: 0, pending: 0, lastOkAtMs: null, lastError: 'x'.repeat(5_000) })
    expect(String(view?.lastError).length).toBeLessThanOrEqual(201)
  })
})
