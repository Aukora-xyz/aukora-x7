/**
 * QA-0 (2026-11-16): her kernel organ is a fixed protected id. A change to it always needs the owner's passkey; her
 * everyday read of it (`auma_kernel`, no arguments) keeps the class it had.
 */
import { describe, expect, it } from 'vitest'
import {
  T2_ONLY_ORGANS, classifyActionIrreversibility, classifyEntryGovernance, classifyHeadManifestTransition,
} from '../../src/x6/ball-loader.ts'

const sha = (c: string): string => c.repeat(64)
const kernel = (module: string): Record<string, unknown> => ({ id: 'auma-kernel', specifier: `ball:${module}`, disabled: false,
  config: { expectedCapsuleDigest: sha('e') }, previousSpecifiers: [] })
const entries = { 'auma-kernel': kernel(sha('a')) } as never

describe('QA-0: the kernel is protected by name', () => {
  it('is in the fixed list, last, and is class 3 whatever its entry declares', () => {
    expect(T2_ONLY_ORGANS).toHaveLength(16)
    expect(T2_ONLY_ORGANS.at(-1)).toBe('auma-kernel')
    for (const entry of [undefined, {}, { config: {} }, { governance: false, config: { governance: false } }]) {
      expect(classifyEntryGovernance('auma-kernel', entry)).toBe(3)
      expect(classifyEntryGovernance(`auma-kernel:${sha('b')}`, entry)).toBe(3)
    }
  })

  it('a bytes-only change of the kernel is T2: it needs the passkey (it was T1 until this day)', () => {
    const previous = { ballId: sha('1'), epoch: 80, entries: { 'auma-kernel': kernel(sha('a')) } }
    const candidate = { ballId: sha('2'), parentBallId: sha('1'), epoch: 81, entries: { 'auma-kernel': kernel(sha('b')) } }
    const tier = classifyHeadManifestTransition(previous as never, candidate as never, { canonicalManifestMatches: true } as never)
    expect(tier.tier).toBe('T2')
    expect(tier.requiresPasskey).toBe(true)
    expect(tier.t2Reasons).toEqual(['T2_PROTECTED_ORGAN'])
  })

  it('her own read of the kernel keeps its class (1), and no word turns that into a way to change it', () => {
    expect(classifyActionIrreversibility({ tool: 'auma_kernel' }, entries)).toBe(1)
    // Anything that names an operation, a target or `promote` is judged by the rules for everyone: never by the hook.
    expect(classifyActionIrreversibility({ tool: 'auma_kernel', promote: true }, entries)).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'auma_kernel', action: 'update' }, entries)).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'auma_kernel', id: 'auma-kernel' }, entries)).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'ball_put', action: 'update', id: 'auma-kernel' }, entries)).toBe(3)
    expect(classifyActionIrreversibility({ action: 'organ-remove', organId: 'auma_kernel' }, entries)).toBe(3)
  })
})
