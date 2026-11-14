// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * aukora.canon.v1 (CONTRACT.md draft 7, section 3): every vector of capsule-canon.vectors.json (long inputs expanded
 * from inputGen here, in both forms of 3.8); both round trips on the vectors, on 20,000 seeded random values and on
 * 20,000 seeded random byte strings; each limit at and one past its bound in the encoder, and the object-member bound in
 * both directions (in the file by the second inputGen form, and here); host-value rows for every encoder class (3.4); digests
 * recomputed here with node:crypto, independently of the module's own hashing. The two platform calls this file makes
 * (`sha256`, `platformParse`) are oracles, each on the allow-list of capsule-rule.test.mjs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import test from 'node:test'
import VECTORS from '../capsule-canon.vectors.json' with { type: 'json' }
import { CLASSES, DOMAINS, ENCODE_CLASSES, LIMITS, checkPresented, digest, digestSync, domainMessage, encode, parse, rawSha256 } from '../capsule-canon.mjs'

/** The independent sha256 (node:crypto), never the module's. */
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest())
/** The platform's JSON parser, used only as an oracle: every text the canon accepts, it must accept with the same value. */
const platformParse = text => JSON.parse(text)

const fromHex = hex => new Uint8Array(Buffer.from(hex, 'hex'))
const toHex = bytes => Buffer.from(bytes).toString('hex')
const bytesOf = text => new Uint8Array(Buffer.from(text, 'latin1'))
const textOf = bytes => Buffer.from(bytes).toString('latin1')
const refused = (fn, code, at) => assert.throws(fn, error => error.code === code && (at === undefined || error.at === at), `${code}${at === undefined ? '' : ` at ${at}`}`)
/** An encoder refusal: the class only; the encoder reports no position (3.4). */
const encodeRefused = (fn, code) => assert.throws(fn, error => error.code === code && !('at' in error), `encode ${code} (class only)`)
/**
 * A row's input: inputHex, or inputGen expanded as 3.8 says, in one of its two forms: { prefixHex, unitHex, count,
 * suffixHex } is prefix, the unit count times, suffix; { prefixHex, beforeHex, width, afterHex, sepHex, count, suffixHex }
 * is prefix, then for i from 0 to count - 1 the piece before + i as width zero-padded decimal digits + after, the pieces
 * joined by sep, then suffix.
 */
function inputOf(row) {
  const gen = row.inputGen
  if (!gen) return fromHex(row.inputHex)
  if ('unitHex' in gen) return fromHex(gen.prefixHex + gen.unitHex.repeat(gen.count) + gen.suffixHex)
  const digits = index => toHex(bytesOf(String(index).padStart(gen.width, '0')))
  const pieces = Array.from({ length: gen.count }, (_, index) => gen.beforeHex + digits(index) + gen.afterHex)
  return fromHex(gen.prefixHex + pieces.join(gen.sepHex) + gen.suffixHex)
}
const GEN_FORMS = [['count', 'prefixHex', 'suffixHex', 'unitHex'], ['afterHex', 'beforeHex', 'count', 'prefixHex', 'sepHex', 'suffixHex', 'width']]
const independent = (domain, bytes) => toHex(sha256(Buffer.concat([Buffer.from(domain, 'ascii'), Buffer.from([0]), Buffer.from(bytes)])))

/** Structural equality that ignores prototypes (parse returns prototype-less objects). */
function same(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) return left.length === right.length && left.every((item, index) => same(item, right[index]))
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]))
}

/** A small seeded generator (mulberry32), so every run sees the same 40,000 inputs. */
function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ROWS = VECTORS.rows
const VECTORS_FILE = new URL('../capsule-canon.vectors.json', import.meta.url)

test('the vectors file: at most 200 KB, unique names, every class at least six times, every row stores its input once', () => {
  assert.equal(VECTORS.profile, 'aukora.canon.v1')
  assert.ok(statSync(VECTORS_FILE).size <= 200000, `${statSync(VECTORS_FILE).size} bytes`)
  assert.ok(ROWS.length >= 140, String(ROWS.length))
  assert.equal(new Set(ROWS.map(row => row.name)).size, ROWS.length)
  const counts = {}
  for (const row of ROWS) {
    assert.equal(Number('inputHex' in row) + Number('inputGen' in row), 1, `${row.name}: one input field`)
    if (row.inputHex !== undefined) assert.match(row.inputHex, /^(?:[0-9a-f]{2})*$/, row.name)
    else {
      const keys = Object.keys(row.inputGen).sort()
      assert.ok(GEN_FORMS.some(form => form.join() === keys.join()), `${row.name}: one of the two inputGen forms (${keys})`)
      assert.ok(Number.isSafeInteger(row.inputGen.count) && row.inputGen.count > 0, row.name)
      if ('width' in row.inputGen) {
        assert.ok(Number.isSafeInteger(row.inputGen.width) && String(row.inputGen.count - 1).length <= row.inputGen.width, `${row.name}: every index fits its width, so the pieces differ`)
        for (const field of ['prefixHex', 'beforeHex', 'afterHex', 'sepHex', 'suffixHex']) assert.match(row.inputGen[field], /^(?:[0-9a-f]{2})*$/, `${row.name} ${field}`)
      }
    }
    if (row.expect.ok) {
      assert.equal('canonicalHex' in row.expect, false, `${row.name}: an accepted row stores no second copy of its bytes`)
      if (!row.presentedUnder) assert.match(row.expect.digests['aukora.capsule.v1'], /^[0-9a-f]{64}$/, row.name)
    } else counts[row.expect.class] = (counts[row.expect.class] ?? 0) + 1
  }
  for (const name of CLASSES) assert.ok(counts[name] >= 6, `${name}: ${counts[name] ?? 0}`)
  assert.ok(counts.CAPSULE_BYTES_MISMATCH >= 3, `CAPSULE_BYTES_MISMATCH: ${counts.CAPSULE_BYTES_MISMATCH}`)
})

test('the vectors file covers everything section 3.8 lists, by name; ball ids are not canon objects', () => {
  const names = new Set(ROWS.map(row => row.name))
  for (const name of [
    // each limit at and one past its bound
    'text-262144-bytes', 'text-262145-bytes', 'depth-16-arrays', 'depth-17-arrays', 'depth-16-objects', 'depth-17-objects', 'nodes-20000', 'nodes-20001',
    'string-2048-plain', 'string-2049-plain', 'string-2048-chars-of-escapes', 'string-2049-chars-of-escapes', 'array-8192-items', 'array-8193-items',
    'object-8192-members', 'object-8193-members', 'key-64-bytes', 'key-65-bytes',
    // precedence
    'precedence-limit-before-byte-range', 'precedence-key-order-before-later-number', 'precedence-number-before-later-key-order',
    'precedence-node-limit-before-number', 'precedence-string-limit-before-escape', 'precedence-string-limit-before-end-backslash',
    'precedence-unstartable-before-item-limit',
    // the named inputs
    'number-leading-zero-01', 'number-fraction-1.0', 'number-exponent-1e0', 'number-negative-zero', 'number-2-pow-53', 'syntax-NaN', 'number-minus-NaN',
    'syntax-plus-one', 'syntax-dot-five', 'number-1x', 'root-empty-text', 'syntax-unquoted-key', 'syntax-unquoted-second-key', 'syntax-truncated-in-key',
    'syntax-literal-misspelt-trUe', 'syntax-literal-cut-off-tr', 'syntax-escape-n', 'syntax-backslash-at-end-of-text',
    'key-duplicate', 'keys-10-before-2', 'keys-2-before-10', 'keys-proto-and-constructor',
    // 3.6
    'tamper-one-byte-under-original-id', 'tamper-truncation-under-original-id', 'tamper-one-byte-alone-is-another-record',
    'tamper-space-inserted-under-its-own-id', 'tamper-truncation-under-its-own-id',
    // the act rows and the safe payload
    'safe-payload-raw-bytes', 'safe-payload-raw-bytes-plus-one', 'act-command-safe-payload', 'act-command-safe-payload-plus-one-byte',
    'act-command-under-its-own-id', 'act-command-under-the-id-of-other-bytes', 'act-envelope-intent', 'act-key-thumb', 'act-lineage', 'act-policy-v0',
  ]) assert.ok(names.has(name), name)
  for (const name of names) assert.ok(!name.startsWith('ball-id'), `3.5: ball ids are not canon objects (${name})`)
  const payload = ROWS.find(row => row.name === 'safe-payload-raw-bytes')
  assert.equal(fromHex(payload.inputHex).length, 24)
  assert.equal(payload.inputHex, '63617073756c652d76302e332d736166652d616374696f6e')
})

/**
 * The runner: one row, judged by the members 3.8 names (`name`, `inputHex` or `inputGen`, `expect`, `presentedUnder`) and
 * nothing else. A member it does not know is ignored (draft 7, ruling 1): it is never read, so it can change nothing.
 */
async function runRow(row) {
  const input = inputOf(row)
  if (row.presentedUnder) {
    const verdict = await checkPresented(row.presentedUnder.domain, input, row.presentedUnder.id)
    assert.equal(verdict.ok, row.expect.ok, row.name)
    if (!row.expect.ok) {
      assert.equal(verdict.code, row.expect.class, row.name)
      assert.equal(verdict.at, row.expect.at, `${row.name}: position`)
    }
    assert.equal(verdict.id, independent(row.presentedUnder.domain, input), `${row.name}: the raw bytes were hashed`)
    return
  }
  if (!row.expect.ok) {
    refused(() => parse(input), row.expect.class, row.expect.at)
    return
  }
  const value = parse(input)
  assert.equal(toHex(encode(value)), toHex(input), `${row.name}: encode(parse(t)) == t`)
  assert.ok(same(parse(encode(value)), value), `${row.name}: parse(encode(v)) == v`)
  assert.ok(same(platformParse(textOf(input)), value), `${row.name}: the platform parser reads the same value`)
  for (const [domain, hex] of Object.entries(row.expect.digests)) {
    assert.equal(await digest(domain, input), hex, `${row.name} ${domain}`)
    assert.equal(digestSync(domain, input, sha256), hex, `${row.name} ${domain} (sync)`)
  }
}

test('every vector: verdict, class and position; an accepted text is its own canonical form; its digests, async and sync', async () => {
  for (const row of ROWS) await runRow(row)
})

test('3.8, draft 7 ruling 1: a runner ignores row members it does not know; the members the contract names keep their meaning', async () => {
  const NAMED = ['name', 'inputHex', 'inputGen', 'expect', 'presentedUnder']
  // This implementation's own annotation (`shape`, read by the act-shape and record tests) is also not a member of 3.8.
  const carriers = ROWS.filter(row => Object.keys(row).some(member => !NAMED.includes(member) && member !== 'shape'))
  assert.deepEqual(carriers.map(row => row.name).sort(), ['runner-unknown-member-accepted', 'runner-unknown-member-refused'])
  for (const row of carriers) {
    assert.equal(typeof row.comment, 'string', row.name)
    await runRow(row)
    // The same row without the member gets the same verdict, and with any other value of it too.
    const bare = { ...row }
    delete bare.comment
    await runRow(bare)
    await runRow({ ...bare, comment: { expect: { ok: !row.expect.ok }, inputHex: '' } })
  }
  assert.deepEqual(carriers.map(row => row.expect.ok).sort(), [false, true], 'one accepted and one refused row')
})

test('digests recomputed here with node:crypto, one per domain, independently of the module, and the contract anchor', async () => {
  const picks = [
    ['empty-object', DOMAINS.capsule], ['keys-10-before-2', DOMAINS.state], ['act-command-safe-payload', DOMAINS.act],
    ['keys-proto-and-constructor', DOMAINS.facts], ['act-policy-v0', DOMAINS.policy], ['act-envelope-intent', DOMAINS.proof],
    ['act-key-thumb', DOMAINS.key], ['act-lineage', DOMAINS.lineage], ['act-command-safe-payload-plus-one-byte', DOMAINS.act],
  ]
  for (const [name, domain] of picks) {
    const row = ROWS.find(entry => entry.name === name)
    const input = inputOf(row)
    const expected = independent(domain, input)
    assert.equal(row.expect.digests[domain], expected, `${name}: the file`)
    assert.equal(await digest(domain, input), expected, `${name}: the module`)
  }
  // CONTRACT.md 3.5 anchor (RAN by shell in two lanes; docs/capsule/VECTORS.md has the one-liner).
  assert.equal(await digest(DOMAINS.capsule, bytesOf('{}')), '1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691')
  for (const domain of Object.values(DOMAINS)) assert.equal(ROWS.find(row => row.name === 'empty-object').expect.digests[domain], independent(domain, bytesOf('{}')), domain)
  const [safe, plusOne] = ['act-command-safe-payload', 'act-command-safe-payload-plus-one-byte'].map(name => ROWS.find(row => row.name === name).expect.digests[DOMAINS.act])
  assert.notEqual(safe, plusOne)
})

test('digests: the eight domains, frozen; digest hashes whatever bytes it is given and never parses; raw sha256 is plain', async () => {
  assert.deepEqual(Object.values(DOMAINS), ['aukora.capsule.v1', 'aukora.capsule.state.v1', 'aukora.act.v1', 'aukora.capsule-facts.v1', 'aukora.capsule-policy.v0',
    'aukora.proof.v3', 'aukora.key.v1', 'aukora.act-lineage.v1'])
  assert.ok(Object.isFrozen(DOMAINS) && Object.isFrozen(LIMITS) && Object.isFrozen(CLASSES) && Object.isFrozen(ENCODE_CLASSES))
  await assert.rejects(digest('aukora.capsule.v2', bytesOf('{}')), error => error.code === 'DOMAIN')
  assert.throws(() => digestSync('sha256', bytesOf('{}'), sha256), error => error.code === 'DOMAIN')
  await assert.rejects(digest(DOMAINS.capsule, '{}'), error => error.code === 'TYPE')
  // Non-canonical bytes, and bytes that are no text at all, are hashed as given (3.5): the digest never parses.
  for (const text of ['{ }', '', '[]', '{"a":01}', 'capsule-v0.3-safe-action']) {
    assert.equal(await digest(DOMAINS.capsule, bytesOf(text)), independent(DOMAINS.capsule, bytesOf(text)), text)
    assert.equal(digestSync(DOMAINS.act, bytesOf(text), sha256), independent(DOMAINS.act, bytesOf(text)), text)
  }
  assert.deepEqual([...domainMessage(DOMAINS.proof, bytesOf('{}'))], [...Buffer.concat([Buffer.from('aukora.proof.v3'), Buffer.from([0]), Buffer.from('{}')])])
  assert.throws(() => digestSync(DOMAINS.capsule, bytesOf('{}'), () => 'not hex'), error => error.code === 'DIGEST')
  assert.throws(() => digestSync(DOMAINS.capsule, bytesOf('{}')), error => error.code === 'DIGEST')
  const raw = bytesOf('capsule-v0.3-safe-action')
  assert.equal(await rawSha256(raw), toHex(sha256(raw)))
  assert.equal(digestSync(DOMAINS.capsule, bytesOf('{}'), bytes => toHex(sha256(bytes))), '1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691')
  assert.deepEqual({ ...LIMITS }, { textBytes: 262144, depth: 16, nodes: 20000, stringChars: 2048, arrayItems: 8192, objectMembers: 8192, keyBytes: 64, integerMagnitude: 9007199254740991 })
})

test('3.6: the raw bytes are hashed and compared before any parse; matching bytes may still be refused by their class', async () => {
  const spaced = bytesOf('{ }')
  // Under another id: a mismatch, whatever the bytes are (never a parse class).
  assert.deepEqual(await checkPresented(DOMAINS.capsule, spaced, independent(DOMAINS.capsule, bytesOf('{}'))), { ok: false, code: 'CAPSULE_BYTES_MISMATCH', id: independent(DOMAINS.capsule, spaced) })
  // Under its own correct digest: refused by its class and position, not as a mismatch.
  assert.deepEqual(await checkPresented(DOMAINS.capsule, spaced, independent(DOMAINS.capsule, spaced)), { ok: false, code: 'SYNTAX', at: 1, id: independent(DOMAINS.capsule, spaced) })
  assert.deepEqual(await checkPresented(DOMAINS.capsule, bytesOf('{}'), independent(DOMAINS.capsule, bytesOf('{}'))), { ok: true, id: independent(DOMAINS.capsule, bytesOf('{}')) })
  // An oversized text under the wrong id is a mismatch (hashed, not parsed); under its own id it is LIMIT.
  const long = new Uint8Array(LIMITS.textBytes + 1).fill(0x20)
  assert.equal((await checkPresented(DOMAINS.capsule, long, '0'.repeat(64))).code, 'CAPSULE_BYTES_MISMATCH')
  assert.equal((await checkPresented(DOMAINS.capsule, long, independent(DOMAINS.capsule, long))).code, 'LIMIT')
})

test('the object-member bound in both directions: the two rows of the file (the second inputGen form) and the counted unit', () => {
  const members = n => '{' + Array.from({ length: n }, (_, index) => `"k${String(index).padStart(4, '0')}":0`).join(',') + '}'
  const at = members(8192).length - 1
  // The file's two rows expand to exactly these texts: 8,192 and 8,193 distinct members, the 8,193rd refused at its quote.
  const fileRow = name => ROWS.find(row => row.name === name)
  assert.equal(textOf(inputOf(fileRow('object-8192-members'))), members(8192))
  assert.equal(textOf(inputOf(fileRow('object-8193-members'))), members(8193))
  assert.deepEqual(fileRow('object-8193-members').expect, { ok: false, class: 'LIMIT', at: at + 1 })
  assert.equal(at + 1, 1 + 8192 * 10, 'each member is 9 bytes and its comma')
  assert.equal(fileRow('object-8192-members').expect.ok, true)
  assert.equal(Object.keys(parse(bytesOf(members(8192)))).length, 8192)
  refused(() => parse(bytesOf(members(8193))), 'LIMIT', at + 1)
  // The count wins over the key's own content at the same byte: an 8,193rd key that is out of order, or not a key.
  refused(() => parse(bytesOf(members(8192).slice(0, -1) + ',"a":0}')), 'LIMIT', at + 1)
  refused(() => parse(bytesOf(members(8192).slice(0, -1) + ',"a b":0}')), 'LIMIT', at + 1)
  // ... but a byte that is not a quote where the 8,193rd key belongs is SYNTAX first.
  refused(() => parse(bytesOf(members(8192).slice(0, -1) + ',a:0}')), 'SYNTAX', at + 1)
})

const KEY_ALPHABET = 'abcxyzABCZ0129_.:-'
const STRING_ALPHABET = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index)).join('')
const SPECIAL_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '10', '2', '0', '-1', '1.5']

function randomValue(random, depth) {
  const pick = random()
  if (depth >= 6 || pick < 0.55) {
    const scalar = random()
    if (scalar < 0.1) return null
    if (scalar < 0.2) return random() < 0.5
    if (scalar < 0.55) {
      const kind = random()
      if (kind < 0.1) return random() < 0.5 ? LIMITS.integerMagnitude : -LIMITS.integerMagnitude
      if (kind < 0.2) return 0
      const magnitude = kind < 0.6 ? Math.floor(random() * 1000) : Math.floor(random() * LIMITS.integerMagnitude)
      return magnitude === 0 ? 0 : random() < 0.5 ? -magnitude : magnitude
    }
    const length = random() < 0.01 ? LIMITS.stringChars : Math.floor(random() * 14)
    let text = ''
    for (let index = 0; index < length; index++) text += random() < 0.15 ? (random() < 0.5 ? '"' : '\\') : STRING_ALPHABET[Math.floor(random() * STRING_ALPHABET.length)]
    return text
  }
  if (pick < 0.75) return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(random, depth + 1))
  return randomObject(random, depth + 1)
}

function randomObject(random, depth) {
  const object = random() < 0.5 ? Object.create(null) : {}
  const count = Math.floor(random() * 6)
  for (let index = 0; index < count; index++) {
    let key
    if (random() < 0.2) key = SPECIAL_KEYS[Math.floor(random() * SPECIAL_KEYS.length)]
    else {
      key = ''
      const length = 1 + Math.floor(random() * 6)
      for (let at = 0; at < length; at++) key += KEY_ALPHABET[Math.floor(random() * KEY_ALPHABET.length)]
    }
    Object.defineProperty(object, key, { value: randomValue(random, depth), writable: true, enumerable: true, configurable: true })
  }
  return object
}

test('20,000 seeded random values: parse(encode(v)) == v and encode is idempotent; the platform parser agrees', () => {
  const random = generator(0x5eed1)
  let largest = 0
  for (let round = 0; round < 20000; round++) {
    const value = randomObject(random, 1)
    const bytes = encode(value)
    largest = Math.max(largest, bytes.length)
    const back = parse(bytes)
    assert.ok(same(back, value), `round ${round}`)
    assert.equal(toHex(encode(back)), toHex(bytes), `round ${round}`)
    assert.ok(same(platformParse(textOf(bytes)), back), `round ${round}`)
  }
  assert.ok(largest > 2048, String(largest))
})

test('20,000 seeded random byte strings: an accepted text round-trips exactly; a refusal has a class and an offset', () => {
  const random = generator(0xb17e5)
  const alphabet = bytesOf('{}[]",:-0123456789aetfnrulsxEN.+\\ ')
  const seeds = Array.from({ length: 64 }, () => encode(randomObject(random, 1)))
  let accepted = 0
  const classes = new Set()
  for (let round = 0; round < 20000; round++) {
    let input
    const mode = random()
    if (mode < 0.34) {
      input = new Uint8Array(Math.floor(random() * 30))
      for (let index = 0; index < input.length; index++) input[index] = random() < 0.01 ? Math.floor(random() * 256) : alphabet[Math.floor(random() * alphabet.length)]
      if (input.length && random() < 0.8) input[0] = 0x7b
    } else {
      const source = seeds[Math.floor(random() * seeds.length)]
      const at = Math.floor(random() * (source.length + 1))
      const byte = random() < 0.02 ? Math.floor(random() * 256) : alphabet[Math.floor(random() * alphabet.length)]
      const kind = random()
      if (kind < 0.25) input = Uint8Array.from([...source.slice(0, at), byte, ...source.slice(at + 1)])
      else if (kind < 0.5) input = Uint8Array.from([...source.slice(0, at), byte, ...source.slice(at)])
      else if (kind < 0.75) input = Uint8Array.from([...source.slice(0, at), ...source.slice(at + 1)])
      else if (kind < 0.9) input = source.slice(0, at)
      else input = Uint8Array.from([...source.slice(0, at), ...source.slice(at + 1, at + 2), ...source.slice(at, at + 1), ...source.slice(at + 2)])
    }
    let value
    try {
      value = parse(input)
    } catch (error) {
      assert.ok(CLASSES.includes(error.code), `round ${round}: ${error.code}`)
      assert.ok(Number.isInteger(error.at) && error.at >= 0 && error.at <= Math.max(input.length, 0), `round ${round}: at ${error.at}`)
      classes.add(error.code)
      continue
    }
    accepted++
    assert.equal(toHex(encode(value)), toHex(input), `round ${round}: encode(parse(t)) == t`)
    assert.ok(same(platformParse(textOf(input)), value), `round ${round}: the platform parser reads the same value`)
  }
  assert.ok(accepted > 500, `accepted ${accepted}`)
  for (const name of CLASSES.filter(name => name !== 'LIMIT')) assert.ok(classes.has(name), `the random inputs reached ${name}`)
})

test('the encoder: each limit at and one past its bound, in its counting unit; a refusal is a class only', () => {
  const nest = depth => { let value = 0; for (let index = 0; index < depth; index++) value = [value]; return value }
  assert.equal(textOf(encode({ a: nest(15) })), `{"a":${'['.repeat(15)}0${']'.repeat(15)}}`)
  encodeRefused(() => encode({ a: nest(16) }), 'LIMIT')
  let object = {}
  for (let index = 0; index < 15; index++) object = { a: object }
  encode(object)
  encodeRefused(() => encode({ a: object }), 'LIMIT')
  const zeros = n => Array.from({ length: n }, () => 0)
  assert.equal(encode({ a: zeros(8000), b: zeros(8000), c: zeros(3996) }).length > 0, true)
  encodeRefused(() => encode({ a: zeros(8000), b: zeros(8000), c: zeros(3997) }), 'LIMIT')
  encode({ s: 'x'.repeat(2048) })
  encodeRefused(() => encode({ s: 'x'.repeat(2049) }), 'LIMIT')
  assert.equal(encode({ s: '"'.repeat(2048) }).length, 8 + 4096)
  encodeRefused(() => encode({ s: '\\'.repeat(2049) }), 'LIMIT')
  encode({ a: zeros(8192) })
  encodeRefused(() => encode({ a: zeros(8193) }), 'LIMIT')
  const members = n => Object.fromEntries(Array.from({ length: n }, (_, index) => [`k${String(index).padStart(4, '0')}`, 0]))
  encode(members(8192))
  encodeRefused(() => encode(members(8193)), 'LIMIT')
  encode({ ['k'.repeat(64)]: 1 })
  encodeRefused(() => encode({ ['k'.repeat(65)]: 1 }), 'KEY')
  const big = last => ({ a: [...Array.from({ length: 127 }, () => 'x'.repeat(2048)), 'y'.repeat(last)] })
  assert.equal(encode(big(1657)).length, 262144)
  encodeRefused(() => encode(big(1658)), 'LIMIT')
  // The text length is checked as the bytes are produced: a string that crosses 262,144 bytes before a bad character is LIMIT.
  encodeRefused(() => encode({ a: [...Array.from({ length: 127 }, () => 'x'.repeat(2048)), `${'y'.repeat(1700)}\u0001`] }), 'LIMIT')
  encodeRefused(() => encode({ a: [...Array.from({ length: 127 }, () => 'x'.repeat(2048)), `${'y'.repeat(10)}\u0001`] }), 'BYTE_RANGE')
  assert.equal(textOf(encode({ n: LIMITS.integerMagnitude, m: -LIMITS.integerMagnitude })), '{"m":-9007199254740991,"n":9007199254740991}')
})

/** Host-value rows for every encoder class (3.4): [name, value, class]. */
const HOST_ROWS = (() => {
  let ran = false
  const getter = Object.defineProperty({}, 'g', { get() { ran = true; return 1 }, enumerable: true })
  const hiddenGetter = Object.defineProperty({}, 'g', { get() { ran = true; return 1 }, enumerable: false })
  class Thing { constructor() { this.a = 1 } }
  class List extends Array {}
  const sparse = [1]
  sparse[2] = 3
  const extra = Object.assign([1], { note: 'x' })
  const symbolOnArray = Object.assign([1], { [Symbol('s')]: 1 })
  const accessorItem = Object.defineProperty([0], 0, { get() { ran = true; return 1 }, enumerable: true })
  const cycle = {}
  cycle.self = cycle
  let deep16 = 0
  for (let index = 0; index < 16; index++) deep16 = [deep16]
  const wide = Object.fromEntries(Array.from({ length: 20001 }, (_, index) => [`k${index}`, null]))
  const rows = [
    ['a character above 0x7e', { s: 'é' }, 'BYTE_RANGE'], ['a decomposed accent', { s: 'e\u0301' }, 'BYTE_RANGE'], ['a newline', { s: '\n' }, 'BYTE_RANGE'],
    ['a tab', { s: '\t' }, 'BYTE_RANGE'], ['DEL', { s: '\u007f' }, 'BYTE_RANGE'], ['a lone surrogate', { s: '\ud800' }, 'BYTE_RANGE'], ['an emoji', { s: '\u{1f600}' }, 'BYTE_RANGE'],
    ['negative zero', { n: -0 }, 'NUMBER'], ['a fraction', { n: 1.5 }, 'NUMBER'], ['NaN', { n: Number.NaN }, 'NUMBER'], ['Infinity', { n: Number.POSITIVE_INFINITY }, 'NUMBER'],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }, 'NUMBER'], ['2^53', { n: 2 ** 53 }, 'NUMBER'], ['-(2^53)', { n: -(2 ** 53) }, 'NUMBER'], ['1e21', { n: 1e21 }, 'NUMBER'],
    ['an empty key', { '': 1 }, 'KEY'], ['a key with a space', { 'a b': 1 }, 'KEY'], ['a key of 65 bytes', { ['k'.repeat(65)]: 1 }, 'KEY'], ['a key outside ASCII', { 'é': 1 }, 'KEY'],
    ['a key with a slash', { 'a/b': 1 }, 'KEY'], ['a nested bad key', { a: { 'x y': 1 } }, 'KEY'],
    ['depth 17', { a: deep16 }, 'LIMIT'], ['a cycle', cycle, 'LIMIT'], ['20,001 nodes', wide, 'LIMIT'],
    ['2,049 characters', { s: 'x'.repeat(2049) }, 'LIMIT'], ['8,193 items', { a: Array.from({ length: 8193 }, () => 0) }, 'LIMIT'],
    ['the root is an array', [], 'TYPE'], ['the root is a string', 'x', 'TYPE'], ['the root is a number', 1, 'TYPE'], ['the root is null', null, 'TYPE'], ['the root is true', true, 'TYPE'],
    ['the root is undefined', undefined, 'TYPE'], ['undefined', { v: undefined }, 'TYPE'], ['a function', { v: () => 1 }, 'TYPE'], ['a symbol', { v: Symbol('s') }, 'TYPE'],
    ['a big integer', { v: 1n }, 'TYPE'], ['a date', { v: new Date(0) }, 'TYPE'], ['a map', { v: new Map() }, 'TYPE'], ['a set', { v: new Set() }, 'TYPE'],
    ['a typed array', { v: new Uint8Array(1) }, 'TYPE'], ['a class instance', { v: new Thing() }, 'TYPE'], ['an Array subclass', { v: List.from([1]) }, 'TYPE'],
    ['a boxed string', { v: Object('s') }, 'TYPE'], ['a boxed number', { v: Object(1) }, 'TYPE'], ['an accessor property', { v: getter }, 'TYPE'],
    ['a non-enumerable accessor', { v: hiddenGetter }, 'TYPE'], ['a symbol key', { [Symbol('k')]: 1 }, 'TYPE'], ['a hole', { v: sparse }, 'TYPE'],
    ['an extra array member', { v: extra }, 'TYPE'], ['a symbol on an array', { v: symbolOnArray }, 'TYPE'], ['an accessor item', { v: accessorItem }, 'TYPE'],
    ['a literal __proto__ (another prototype)', { __proto__: { a: 1 } }, 'TYPE'],
  ]
  return { rows, ran: () => ran }
})()

test('host-value rows for every encoder class (3.4): each refused with its class only, and no getter ever runs', () => {
  const seen = new Set()
  for (const [name, value, code] of HOST_ROWS.rows) {
    assert.throws(() => encode(value), error => error.code === code && !('at' in error), `${name}: ${code}`)
    seen.add(code)
  }
  assert.deepEqual([...seen].sort(), [...ENCODE_CLASSES].sort())
  assert.equal(HOST_ROWS.ran(), false)
})

test('host-value precedence between classes (3.4 order: depth first, members by key, items by index, first failure wins)', () => {
  let ran = false
  const getterAt = (object, key, enumerable = true) => Object.defineProperty(object, key, { get() { ran = true; return 1 }, enumerable })
  const holeThenNaN = [0]
  holeThenNaN[2] = Number.NaN
  const nanThenHole = [Number.NaN]
  nanThenHole[2] = 0
  const rows = [
    // A member reached before an accessor or a symbol key wins; an accessor reached first wins in its turn.
    ['NaN at a, an accessor at z', getterAt({ a: Number.NaN }, 'z'), 'NUMBER'],
    ['NaN at a, a hidden accessor at z', getterAt({ a: Number.NaN }, 'z', false), 'NUMBER'],
    ['NaN at a, a symbol key', { a: Number.NaN, [Symbol('s')]: 1 }, 'NUMBER'],
    ['a bad key "z z", then a symbol key (symbols come after every string key)', { 'z z': 1, [Symbol('s')]: 1 }, 'KEY'],
    ['an accessor at a, NaN at z', getterAt({ z: Number.NaN }, 'a'), 'TYPE'],
    ['a long string at a, an accessor at b', getterAt({ a: 'x'.repeat(2049) }, 'b'), 'LIMIT'],
    ['an accessor at a, a long string at b', getterAt({ b: 'x'.repeat(2049) }, 'a'), 'TYPE'],
    // Items in index order: a hole or an accessor item is reached at its index.
    ['NaN at 0, a hole at 1', { v: nanThenHole }, 'NUMBER'],
    ['a hole at 1, NaN at 2', { v: holeThenNaN }, 'TYPE'],
    ['NaN at 0, an accessor item at 1', { v: getterAt([Number.NaN, 0], 1) }, 'NUMBER'],
    ['an accessor item at 0, NaN at 1', { v: getterAt([0, Number.NaN], 0) }, 'TYPE'],
  ]
  for (const [name, value, code] of rows) assert.throws(() => encode(value), error => error.code === code, `${name}: ${code}`)
  assert.equal(ran, false)
})

test('the JavaScript traps of section 3.4', () => {
  // Integer-like keys: the language iterates "2" before "10"; the canonical form is byte order.
  const integerKeys = { 2: 'two', 10: 'ten' }
  assert.deepEqual(Object.keys(integerKeys), ['2', '10'])
  assert.equal(textOf(encode(integerKeys)), '{"10":"ten","2":"two"}')
  // __proto__ and constructor are ordinary keys, read and built without the prototype chain.
  const parsed = parse(bytesOf('{"__proto__":{"polluted":1},"constructor":{"prototype":2}}'))
  assert.equal(Object.getPrototypeOf(parsed), null)
  assert.equal(Object.getPrototypeOf(parsed.__proto__), null)
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'constructor'])
  assert.equal(parsed.__proto__.polluted, 1)
  assert.equal({}.polluted, undefined, 'Object.prototype is untouched')
  assert.equal(textOf(encode(parsed)), '{"__proto__":{"polluted":1},"constructor":{"prototype":2}}')
  assert.equal(textOf(encode({ ['__proto__']: 1, constructor: 2 })), '{"__proto__":1,"constructor":2}')
  assert.equal(textOf(encode({ n: 0 })), '{"n":0}')
  // A plain object is read by its own enumerable string-keyed data properties: a non-enumerable data property is not read.
  assert.equal(textOf(encode(Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }))), '{"a":1}')
  // Strings are printable ASCII only; there is no normalisation; the two escapes.
  assert.equal(textOf(encode({ s: 'a"b\\c' })), '{"s":"a\\"b\\\\c"}')
  // A frozen or prototype-less input is fine; the output never depends on insertion order.
  const left = Object.freeze({ b: 1, a: [true, null], c: Object.create(null) })
  const right = { c: {}, a: [true, null], b: 1 }
  assert.equal(toHex(encode(left)), toHex(encode(right)))
  // Input type: only a Uint8Array is a text.
  refused(() => parse('{}'), 'TYPE', 0)
  assert.equal(Object.keys(parse(new Uint8Array(Buffer.from('{"a":1}')))).length, 1)
})

test('refusals are deterministic and stop at the first failure in check order', () => {
  // LIMIT (length) beats BYTE_RANGE beats TYPE beats everything in the pass.
  const long = new Uint8Array(LIMITS.textBytes + 1).fill(0x00)
  refused(() => parse(long), 'LIMIT', LIMITS.textBytes)
  refused(() => parse(bytesOf('[\u0001')), 'BYTE_RANGE', 1)
  refused(() => parse(bytesOf('["a":01}')), 'TYPE', 0)
  // In the pass, the earlier byte wins, whatever the class.
  refused(() => parse(bytesOf('{"b":1,"a":01}')), 'KEY_ORDER', 7)
  refused(() => parse(bytesOf('{"b":01,"a":1}')), 'NUMBER', 5)
  refused(() => parse(bytesOf('{"a":1,"a b":01}')), 'KEY', 9)
  for (let round = 0; round < 3; round++) refused(() => parse(bytesOf('{"a":[1,2,0x10]}')), 'NUMBER', 10)
})
