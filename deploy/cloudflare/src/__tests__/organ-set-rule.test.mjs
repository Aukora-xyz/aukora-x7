/** The shared organ-set rule (deploy/cloudflare/src/organ-set-rule.mjs) against the shared vectors: HEAD's organ-set body and the night
 * grant must reach the same verdict on every case. The card (organ-set.client.spec.tsx) runs the same file. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { organRemoval, organRemovePromotionBody, organSetOf, organSetPromotionBody, ORGAN_REMOVE_PATH, ORGAN_REMOVE_SCHEMA, ORGAN_SET_PATH } from '../owner-grant-policy.mjs'
import { nightGrantCovers, NIGHT_GRANT_RECORD_SCHEMA, NIGHT_GRANT_SCHEMA, NIGHT_GRANT_SCOPE } from '../night-grant.mjs'

const vectors = JSON.parse(readFileSync(new URL('../../../../server/organ-set-rule.vectors.json', import.meta.url), 'utf8'))
const ORIGIN = 'https://vectors.example.invalid'
const now = 1_800_000_000_000
const record = { schema: NIGHT_GRANT_RECORD_SCHEMA, usesLeft: 12, revokedAt: null, terms: { schema: NIGHT_GRANT_SCHEMA, grantId: 'grant-vectors-000000',
  audience: ORIGIN, scope: NIGHT_GRANT_SCOPE, issuedAtHead: { ballId: vectors.previous.ballId, epoch: vectors.previous.epoch }, notAfter: now + 3_600_000,
  maxUses: 12, maxOrgansPerUse: 8 } }

test('the vectors cover both verdicts and the review probes', () => {
  assert.ok(vectors.cases.length >= 20)
  for (const name of ['an unlisted extra module', 'an extra root field', 'a changed root field', 'an add reusing a published module',
    'an added root field valued null', 'an add with previousVersions: []', 'an add with a valid updatedAt', 'a new module whose declared size is wrong']) {
    assert.ok(vectors.cases.some(item => item.name === name), name)
  }
})

for (const item of vectors.cases) {
  test(`shared rule: ${item.name}`, () => {
    // Sizes from hash-verified code only, as HEAD computes them.
    const code = { ...vectors.publishedCode, ...item.codeBySha }
    const bytesOf = sha => (typeof code[sha] === 'string' && createHash('sha256').update(code[sha]).digest('hex') === sha ? Buffer.byteLength(code[sha]) : null)
    const organs = organSetOf(vectors.previous, item.candidate, bytesOf)
    if (item.expect === null) assert.equal(organs, null)
    else assert.deepEqual(organSetPromotionBody(item.candidate, organs, bytesOf).organs, item.expect)
    // The night grant's binding check reaches the same verdict on every vector (none is a valid code update), and its
    // receipt sizes are the verified ones.
    const cover = nightGrantCovers({ record, previous: vectors.previous, candidate: item.candidate, now, audience: ORIGIN, bytesOf })
    assert.equal(cover.ok, item.expect !== null, cover.code)
    if (cover.ok) assert.deepEqual(cover.organs.map(organ => organ.size), item.expect.map(organ => organ.bytes))
  })
}

// The one-organ removal rule against its own shared vectors (the card and the worker run the same file).
const removeVectors = JSON.parse(readFileSync(new URL('../../../../server/organ-remove-rule.vectors.json', import.meta.url), 'utf8'))

test('the removal vectors cover both verdicts and every case the brief names', () => {
  for (const name of ['a plain removal', 'a removal of an organ with history', 'two removed', 'one removed plus one changed',
    'one removed plus one added', 'a governance organ by id', 'a governance organ by declaration', 'a root field changed',
    'a module of another organ dropped', 'a module added']) {
    assert.ok(removeVectors.cases.some(item => item.name === name), name)
  }
  assert.ok(removeVectors.cases.some(item => item.expect !== null))
  assert.ok(removeVectors.cases.some(item => item.expect === null))
})

for (const item of removeVectors.cases) {
  test(`shared removal rule: ${item.name}`, () => {
    const removal = organRemoval(removeVectors.previous, item.candidate)
    assert.deepEqual(removal, item.expect)
    if (removal !== null) {
      assert.deepEqual(organRemovePromotionBody(item.candidate, removal), { schema: ORGAN_REMOVE_SCHEMA, ballId: item.candidate.ballId,
        epoch: item.candidate.epoch, parentBallId: item.candidate.parentBallId, organ: item.expect })
    }
    // Never both: a removal is never an organ set, and the night grant still refuses every removal.
    assert.equal(organSetOf(removeVectors.previous, item.candidate, () => 1), null)
    const removalRecord = { ...record, terms: { ...record.terms, issuedAtHead: { ballId: removeVectors.previous.ballId, epoch: removeVectors.previous.epoch } } }
    assert.equal(nightGrantCovers({ record: removalRecord, previous: removeVectors.previous, candidate: item.candidate, now, audience: ORIGIN, bytesOf: () => 1 }).ok, false)
  })
}

test('the removal binds its own path and schema, never the organ set\'s', () => {
  assert.notEqual(ORGAN_REMOVE_PATH, ORGAN_SET_PATH)
  assert.notEqual(ORGAN_REMOVE_SCHEMA, 'aukora.head-organ-set.v1')
})
