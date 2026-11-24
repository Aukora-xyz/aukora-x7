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

describe('every voice answer is screened, so ordinary ids, slugs and paths are kept; secrets still are not', () => {
  const SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d'
  const DIGEST = 'a3f1c2d4e5b6a7980a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'
  const UUID = '5e0000012-0000-4000-8000-0000000000012'

  it('x6_repo log keeps commits[].sha and headSha; promotion_status keeps ballId and stagedSha256', () => {
    const log = JSON.stringify({ ok: true, headSha: SHA, commits: [{ sha: SHA, subject: 'voice: fixes' }], stdout: `${SHA.slice(0, 8)} voice: fixes` })
    expect(withholdSecrets(log)).toBe(log)
    const staged = [{ ballId: DIGEST, sha256: DIGEST }]
    const status = JSON.stringify({ ballId: DIGEST, parentBallId: DIGEST, stagedSha256: DIGEST, stagedFiles: staged })
    expect(withholdSecrets(status)).toBe(status)
    expect(withholdSecrets(`commit ${SHA}\nAuthor: Example Org`)).toBe(`commit ${SHA}\nAuthor: Example Org`)
  })

  it('a checkpoint capture keeps threadId, row id, chain and tailSha; x6_self_state keeps sourceRevision', () => {
    const capture = JSON.stringify({ threadId: `thread-${UUID}`, row: { id: DIGEST }, chain: DIGEST, tailSha: DIGEST, route: `/manifest?id=${DIGEST}` })
    expect(withholdSecrets(capture)).toBe(capture)
    const state = JSON.stringify({ runtime: { sourceRevision: SHA }, edge: { sourceRevision: SHA }, organs: [{ id: 'voice', sha256: DIGEST }] })
    expect(withholdSecrets(state)).toBe(state)
  })

  it('keeps Linear slugs, prefixed UUIDs, lower-case paths and commit URLs', () => {
    for (const plain of ['YOURTEAM-1-voice-reads-everything-from-the-fast-voice'.toLowerCase(), `thread-${UUID}`,
      'deploy/cloudflare/src/voicebridge/fastvoice/tests/review', `https://github.com/example-org/your-node/commit/${SHA}`,
      'packages/experimental/webworkerruntime/src/x6/secretshapes']) {
      expect([plain, withholdSecrets(plain)]).toEqual([plain, plain])
    }
  })

  it('still withholds an id-shaped run named as a key or secret, an id with no name before it, and mixed-case runs', () => {
    expect(withholdSecrets(JSON.stringify({ sha: 'x', secret: DIGEST }))).toBe(JSON.stringify({ sha: 'x', secret: WITHHELD }))
    expect(withholdSecrets(`nostr private ${DIGEST}`)).toBe(`nostr private ${WITHHELD}`)
    expect(withholdSecrets(`the value ${DIGEST} end`)).toBe(`the value ${WITHHELD} end`)
    expect(withholdSecrets(JSON.stringify({ apiKey: SHA }))).toBe(JSON.stringify({ apiKey: WITHHELD }))
    expect(withholdSecrets(`sha ${B64}`)).toBe(`sha ${WITHHELD}`)
    expect(withholdSecrets('a/B/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn')).toBe(WITHHELD)
  })

  it('an unterminated BEGIN line inside a JSON string withholds the rest of that string only: the JSON stays whole', () => {
    const comments = JSON.stringify({ result: [{ id: 'c1', body: 'hello -----BEGIN NOTE----- and more text' }, { id: 'c2', body: 'the anchor' }] })
    const out = withholdSecrets(comments)
    expect(JSON.parse(out)).toEqual({ result: [{ id: 'c1', body: `hello ${WITHHELD}` }, { id: 'c2', body: 'the anchor' }] })
    // An escaped quote does not end it early; a whole block in a row is withheld as before.
    expect(JSON.parse(withholdSecrets(JSON.stringify({ body: '-----BEGIN X----- a "quoted" b', next: 'kept' })))).toEqual({ body: WITHHELD, next: 'kept' })
    expect(withholdSecrets(`a ${PEM_IN_ROW} b`)).toBe(`a ${WITHHELD} b`)
  })

  it('withholds the value of a key-like UPPER_CASE assignment whatever its length', () => {
    expect(withholdSecrets('CF_API_KEY=0123456789abcdef0123456789abcdef012\nPORT=8080')).toBe(`CF_API_KEY=${WITHHELD}\nPORT=8080`)
    expect(withholdSecrets('GITHUB_TOKEN: "a1b2c3d4e5f6a7b8c9d0e1f2"')).toBe(`GITHUB_TOKEN: "${WITHHELD}"`)
    // A name pointing at a binding, or a short limit, is not a secret value.
    for (const plain of ['const key = env.DEEPSEEK_API_KEY', 'TOKEN_LIMIT=4096', 'API_KEY_NAME: DEEPSEEK_API_KEY']) expect(withholdSecrets(plain)).toBe(plain)
  })
})
