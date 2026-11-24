import { describe, expect, it } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'

// Her live report (2026-11-16): x6_checkpoint_verify answered X6_HISTORY_APPEND_ONLY on every call. The tool only reads,
// but its name holds "checkpoint", and the classifier's last rule takes any label holding receipt, checkpoint, history or
// dag as an append-only history write unless the operation is a known read verb.
describe('x6_checkpoint_verify is a read for the invocation gate', () => {
  it('every action of the tool, and no action at all, is class 0', () => {
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify', action: 'verify', id: 'sess-1', body: 'x' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify', action: 'capture', id: 'sess-1' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6-checkpoint-verify', action: 'capture' })).toBe(0)
  })

  it('only the two declared actions are reads: any other operation word is not class 0', () => {
    for (const action of ['delete', 'write', 'append', 'promote', 'run', 'anything-else']) {
      expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify', action }), action).not.toBe(0)
    }
    // `kind` and `type` are read as the operation too when `action` is absent.
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify', kind: 'delete' })).not.toBe(0)
  })

  it('a promote flag is never a read', () => {
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_verify', action: 'capture', promote: true })).not.toBe(0)
  })

  it('the history rule itself is unchanged for every other name', () => {
    expect(classifyActionIrreversibility({ tool: 'seed_receipts', action: 'append' })).toBe(2)
    expect(classifyActionIrreversibility({ tool: 'seed_receipts', action: 'checkpoint' })).toBe(2)
    expect(classifyActionIrreversibility({ tool: 'x6_checkpoint_write', action: 'capture' })).toBe(2)
    expect(classifyActionIrreversibility({ tool: 'some_tool', action: 'capture', path: '/dsh/home/history/x' })).toBe(2)
  })
})
