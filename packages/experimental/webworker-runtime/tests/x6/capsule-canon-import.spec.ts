/**
 * The runtime reaches the ONE canonical file by relative path,
 * never a transcribed copy. This spec proves the test path only: vitest resolves `deploy/cloudflare/src/capsule-canon.mjs`
 * from the runtime's tests, round-trips vectors of the committed file, and computes the digest with the runtime's own
 * synchronous sha256 (`sha256HexSync`, module-loader.ts) injected into `digestSync`. Whether the worker BUNDLE (tsdown,
 * src/worker.ts) resolves the same import is not proven here (no runtime source imports it yet; that is M1's build check).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The canonical file is plain ESM without declarations; only its exports are read here.
import * as untypedCanon from '../../../../../deploy/cloudflare/src/capsule-canon.mjs'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'

/** The four exports this spec reads, as the canonical file defines them. */
interface Canon {
  parse(bytes: Uint8Array): Record<string, unknown>
  encode(value: unknown): Uint8Array
  digest(domain: string, bytes: Uint8Array): Promise<string>
  digestSync(domain: string, bytes: Uint8Array, sha256: (message: Uint8Array) => string): string
}
const canon = untypedCanon as Canon
interface Expectation { ok: boolean; digests?: Record<string, string>; class?: string; at?: number }
interface Row { name: string; inputHex: string; expect: Expectation }
// The vectors file is read as data (this spec is outside the rule scan's folders; it decides nothing with the platform parser).
const vectors = JSON.parse(readFileSync(new URL('../../../../../deploy/cloudflare/src/capsule-canon.vectors.json', import.meta.url), 'utf8')) as { rows: Row[] }
const row = (name: string): Row => {
  const found = vectors.rows.find(entry => entry.name === name)
  if (!found) throw new Error(`no vector ${name}`)
  return found
}
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16))
const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

describe('the runtime reaches the one canonical file by relative path', () => {
  it('round-trips an accepted vector and matches its digests, async and with the runtime sha256 injected', async () => {
    const vector = row('keys-10-before-2')
    const input = fromHex(vector.inputHex)
    const value = canon.parse(input)
    // An accepted text is its own canonical form (contract draft 3, 3.4 and 3.8): encode(parse(t)) == t.
    expect(toHex(canon.encode(value))).toBe(vector.inputHex)
    expect(Object.keys(vector.expect.digests ?? {}).length).toBeGreaterThan(0)
    expect(Object.getPrototypeOf(value)).toBe(null)
    for (const [domain, hex] of Object.entries(vector.expect.digests ?? {})) {
      expect(await canon.digest(domain, input)).toBe(hex)
      expect(canon.digestSync(domain, input, sha256HexSync)).toBe(hex)
    }
  })

  it('refuses a refused vector with the same class and offset', () => {
    const vector = row('keys-2-before-10')
    expect(() => canon.parse(fromHex(vector.inputHex)))
      .toThrow(expect.objectContaining({ code: vector.expect.class, at: vector.expect.at }))
  })
})
