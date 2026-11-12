/**
 * The worker's organ-set rule (ball-loader.ts `organAdditionSetOf`) passes the SAME
 * shared vectors as HEAD's rule, the night grant and the Sovereignty card.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { organAdditionSetOf, type BallManifest } from '../../src/x6/ball-loader.ts'

/**
 * THE SHARED VECTORS (server/organ-set-rule.vectors.json), the same file HEAD's rule, the night grant and the
 * Sovereignty card run. This spec DEPENDS on AURA's commit: on a branch without it the file is absent and this block fails
 * to load it by design; on the integration branch it runs. Sizes come from hash-verified code only.
 */
const vectorsPath = ['', '../../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/organ-set-rule.vectors.json`)).find(existsSync)
const vectors = JSON.parse(readFileSync(vectorsPath ?? 'server/organ-set-rule.vectors.json', 'utf8')) as {
  schema: string
  previous: BallManifest
  publishedCode: Record<string, string>
  cases: Array<{
    name: string
    candidate: unknown
    codeBySha?: Record<string, string>
    expect: Array<{ organId: string; sha256: string; bytes: number }> | null
  }>
}

describe('the worker rule passes the shared organ-set vectors exactly', () => {
  it('reads the shared vectors file', () => {
    expect(vectors.schema).toBe('aukora.organ-set-rule.vectors.v1')
    expect(vectors.cases.length).toBeGreaterThanOrEqual(29)
  })
  for (const item of vectors.cases) {
    it(item.name, () => {
      const codeOf = (sha: string): string | null => item.codeBySha?.[sha] ?? vectors.publishedCode[sha] ?? null
      expect(organAdditionSetOf(vectors.previous, item.candidate, codeOf)).toEqual(item.expect)
    })
  }
})
