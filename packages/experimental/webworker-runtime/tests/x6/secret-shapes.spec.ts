/**
 * The one secret-shape filter that `x6_threads` and `x6_browser_estate` search both pass their text through.
 * One implementation, one table. Made-up values only.
 */
import { describe, expect, it } from 'vitest'
import { withholdSecrets, WITHHELD } from '../../src/x6/secret-shapes.ts'

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq\n-----END PRIVATE KEY-----'
/** The same block as it sits inside a JSON row: its line breaks are the two characters backslash and n. */
const PEM_IN_ROW = JSON.stringify(PEM).slice(1, -1)
const NSEC = 'nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqh0p9x'
const SK = 'sk-made-up-0123456789abcdefABCDEF'
const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w'
const HEX = 'a3f1c2d4e5b6a7980a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'

describe('withholdSecrets (shared by x6_threads and x6_browser_estate)', () => {
  it('withholds PEM blocks, nsec1, sk- and long base64 or hex runs', () => {
    expect(WITHHELD).toBe('[withheld]')
    for (const secret of [PEM, PEM_IN_ROW, NSEC, NSEC.toUpperCase(), SK, B64, HEX]) {
      expect(withholdSecrets(`before ${secret} after`)).toBe('before [withheld] after')
    }
    expect(withholdSecrets(`${NSEC}, ${SK}; ${HEX}`)).toBe('[withheld], [withheld]; [withheld]')
  })

  it('leaves ordinary words and paths alone, and gives the same answer on every call', () => {
    for (const plain of ['/dsh/home/sessions/--dsh-home-auma--/session-00000000', 'we spoke of tidepools and the lantern',
      'sk-short', 'nsec1abc', 'a'.repeat(39)]) {
      expect(withholdSecrets(plain)).toBe(plain)
    }
    // The shapes are global regular expressions: a second call must not resume where the first stopped.
    expect(withholdSecrets(`x ${HEX}`)).toBe('x [withheld]')
    expect(withholdSecrets(`x ${HEX}`)).toBe('x [withheld]')
  })
})
