/** The OpenTimestamps proof format (ots.mjs). Two real proofs from the reference client's examples
 * (copied byte for byte into fixtures/ots/), proofs built here from synthetic calendar replies, an upgrade splice, and
 * every bound and malformed input. Hashes the edge cannot run (RIPEMD-160) come in from node:crypto through the injectable
 * `hashes` option; every expected value is recomputed here with node:crypto, never with the module's own helpers. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  OTS_CODES, OTS_LIMITS, bitcoinAttestations, buildDetached, parseOts, parseTree, pendingLeaves, serializeOts, serializeTree,
  spliceUpgrade, stampCommitment,
} from '../ots.mjs'

const fixture = name => new Uint8Array(readFileSync(new URL(`./fixtures/ots/${name}`, import.meta.url)))
const INCOMPLETE = fixture('incomplete.txt.ots')
const HELLO = fixture('hello-world.txt.ots')
const hex = bytes => Buffer.from(bytes).toString('hex')
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest())
const NODE_HASHES = Object.freeze({ ripemd160: bytes => new Uint8Array(createHash('ripemd160').update(bytes).digest()) })
const HEADER = unhex('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294')
const PENDING = 'https://alice.btc.calendar.opentimestamps.org'

/** A refusal with its closed code (and only a closed code). */
async function refuses(run, code) {
  let caught = null
  try { await run() } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code} (${caught.message})`)
  assert.ok(OTS_CODES.includes(caught.code))
}

/** Test-local encoders, written apart from the module's. */
const varuint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte) } while (value); return Uint8Array.from(out) }
const varbytes = bytes => cat(varuint(bytes.length), bytes)
const pendingAtt = uri => cat([0x00], unhex('83dfe30d2ef90c8e'), varbytes(varbytes(new TextEncoder().encode(uri))))
const bitcoinAtt = height => cat([0x00], unhex('0588960d73d71901'), varbytes(varuint(height)))
/** A calendar's reply as the reference server writes it: prepend 4 bytes, append 8, then a pending attestation. */
const calendarReply = (prefix, suffix, uri) => cat([0xf1], varbytes(prefix), [0xf0], varbytes(suffix), pendingAtt(uri))

test('vector 1 (incomplete.txt.ots, 175 bytes): parse then serialize is the input; its pending leaf is the research value', async () => {
  assert.equal(INCOMPLETE.length, 175)
  const parsed = parseOts(INCOMPLETE)
  assert.equal(hex(parsed.digest), '05c4f616a8e5310d19d938cfd769864d7f4ccdc2ca8b479b10af83564b097af9')
  assert.equal(hex(serializeOts(parsed)), hex(INCOMPLETE))
  const commitment = '57cfa5c4' + '6716df9bd9e83595bce439c58108d8fcc1678f30d4c6731c3f1fa6c79ed712c6' + '6fb1ac8d4e4eb0e7'
  // Recomputed here: digest -> append nonce -> sha256 -> append mac -> sha256 -> prepend 57cfa5c4 -> append 6fb1...
  const first = sha256(cat(parsed.digest, unhex('e754bf93806a7ebaa680ef7bd0114bf4')))
  assert.equal(hex(first), 'cd567f5aa9f68cfbece1ca17b4b72ad3079a3e4bff80efe131419bd02138e425')
  const second = sha256(cat(first, unhex('b573e8850cfd9e63d1f043fbb6fc250e')))
  assert.equal(hex(cat(unhex('57cfa5c4'), second, unhex('6fb1ac8d4e4eb0e7'))), commitment)
  assert.deepEqual(await pendingLeaves(INCOMPLETE), [{ uri: PENDING, commitment }])
  assert.deepEqual(await bitcoinAttestations(INCOMPLETE), [])
})

test('vector 2 (hello-world.txt.ots, 688 bytes): parse then serialize is the input; Bitcoin height 358391 at the research message', async () => {
  assert.equal(HELLO.length, 688)
  const parsed = parseOts(HELLO)
  assert.equal(hex(parsed.digest), hex(sha256(new TextEncoder().encode('Hello World!\n'))))
  assert.equal(hex(serializeOts(parsed)), hex(HELLO))
  assert.deepEqual(await bitcoinAttestations(HELLO, { hashes: NODE_HASHES }),
    [{ height: 358391, merkleRoot: '007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a' }])
  // The research's other check: the message is the block's merkle root as explorers show it, byte-reversed.
  assert.equal(hex(unhex('8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00').reverse()), '007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a')
  assert.deepEqual(await pendingLeaves(HELLO, { hashes: NODE_HASHES }), [])
  // RIPEMD-160 is not in WebCrypto: without an injected implementation the message computation refuses, closed.
  await refuses(() => bitcoinAttestations(HELLO), 'OTS_OP_UNAVAILABLE')
})

test('the submitted commitment is sha256(digest || nonce): the reference client\'s blinding', async () => {
  const digest = randomBytes(32), nonce = randomBytes(16)
  assert.equal(hex(await stampCommitment(digest, nonce)), hex(sha256(cat(digest, nonce))))
  await refuses(() => stampCommitment(digest.subarray(1), nonce), 'OTS_INPUT_INVALID')
  await refuses(() => stampCommitment(digest, nonce.subarray(1)), 'OTS_INPUT_INVALID')
})

for (const count of [2, 4]) {
  test(`a proof built from ${count} calendar replies parses back byte for byte and names each pending leaf`, async () => {
    const digest = randomBytes(32), nonce = randomBytes(16)
    const submitted = sha256(cat(digest, nonce))
    const replies = Array.from({ length: count }, (_, index) => ({ prefix: randomBytes(4), suffix: randomBytes(8), uri: `https://c${index}.btc.calendar.opentimestamps.org` }))
    const built = buildDetached(digest, nonce, replies.map(({ prefix, suffix, uri }) => calendarReply(prefix, suffix, uri)))
    // Independently assembled: header, 01, 08, digest, f0 10 nonce, 08, then the replies as a fork (ff before all but the last).
    const fork = cat(...replies.map(({ prefix, suffix, uri }, index) => cat(index < count - 1 ? [0xff] : [], calendarReply(prefix, suffix, uri))))
    assert.equal(hex(built), hex(cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], fork)))
    assert.equal(hex(serializeOts(parseOts(built))), hex(built))
    assert.deepEqual(await pendingLeaves(built), replies.map(({ prefix, suffix, uri }) => ({ uri, commitment: hex(cat(prefix, submitted, suffix)) })))
  })
}

test('a calendar reply that itself starts with a fork merges as the union of its branches', async () => {
  const digest = randomBytes(32), nonce = randomBytes(16), submitted = sha256(cat(digest, nonce))
  const a = calendarReply(unhex('01020304'), unhex('0102030405060708'), 'https://a.btc.calendar.opentimestamps.org')
  const b = calendarReply(unhex('11121314'), unhex('1112131415161718'), 'https://b.btc.calendar.opentimestamps.org')
  const c = calendarReply(unhex('21222324'), unhex('2122232425262728'), 'https://finney.calendar.eternitywall.com')
  const forked = cat([0xff], a, b) // one reply holding two branches
  const built = buildDetached(digest, nonce, [forked, c])
  assert.equal(hex(built), hex(cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], [0xff], a, [0xff], b, c)))
  assert.equal((await pendingLeaves(built)).length, 3)
  assert.equal((await pendingLeaves(built))[2].commitment, hex(cat(unhex('21222324'), submitted, unhex('2122232425262728'))))
  // The same branch twice is kept once.
  assert.equal(hex(buildDetached(digest, nonce, [a, a, b])), hex(cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], [0xff], a, b)))
  // A reply is a bare tree that must be read to its end.
  assert.equal(hex(serializeTree(parseTree(forked))), hex(forked))
  await refuses(() => parseTree(cat(a, [0x00])), 'OTS_TRAILING_BYTES')
})

test('replies that share their first op merge recursively: one op child holding the union of what follows it', async () => {
  const digest = randomBytes(32), nonce = randomBytes(16)
  const leaf = name => pendingAtt(`https://${name}.btc.calendar.opentimestamps.org`)
  // s1 and s2 both start with sha256, then append different bytes.
  const s1 = cat([0x08], [0xf0], varbytes(unhex('11')), leaf('s1'))
  const s2 = cat([0x08], [0xf0], varbytes(unhex('22')), leaf('s2'))
  const built = buildDetached(digest, nonce, [s1, s2])
  // One 08 child (no two siblings with the same op), under it a fork of the two appends.
  const merged = cat([0x08], [0xff], [0xf0], varbytes(unhex('11')), leaf('s1'), [0xf0], varbytes(unhex('22')), leaf('s2'))
  assert.equal(hex(built), hex(cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], merged)))
  assert.deepEqual((await pendingLeaves(built)).map(leaf => leaf.uri), ['https://s1.btc.calendar.opentimestamps.org', 'https://s2.btc.calendar.opentimestamps.org'])
  // The same op AND argument at two levels, and a reply that itself starts with a fork, still merge into one path.
  const s3 = cat([0xff], [0x08], [0xf0], varbytes(unhex('11')), leaf('s3'), [0xf1], varbytes(unhex('33')), leaf('s4'))
  const deep = buildDetached(digest, nonce, [s1, s3])
  const deepTree = cat([0xff], [0x08], [0xf0], varbytes(unhex('11')), [0xff], leaf('s1'), leaf('s3'), [0xf1], varbytes(unhex('33')), leaf('s4'))
  assert.equal(hex(deep), hex(cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], deepTree)))
  assert.equal((await pendingLeaves(deep)).length, 3)
  // The inputs are never changed by a merge.
  assert.equal(hex(serializeTree(parseTree(s1))), hex(s1))
})

test('an upgrade is spliced where the pending leaf was; the other calendar stays pending', async () => {
  const digest = randomBytes(32), nonce = randomBytes(16), submitted = sha256(cat(digest, nonce))
  const one = { prefix: unhex('aabbccdd'), suffix: unhex('0011223344556677'), uri: 'https://alice.btc.calendar.opentimestamps.org' }
  const two = { prefix: unhex('a1b1c1d1'), suffix: unhex('0f1f2f3f4f5f6f7f'), uri: 'https://bob.btc.calendar.opentimestamps.org' }
  const built = buildDetached(digest, nonce, [one, two].map(({ prefix, suffix, uri }) => calendarReply(prefix, suffix, uri)))
  const leaves = await pendingLeaves(built)
  const sibling = randomBytes(32)
  const upgrade = cat([0x08, 0xf0, 0x20], sibling, [0x08], bitcoinAtt(358391))
  const spliced = await spliceUpgrade(built, leaves[0].commitment, upgrade)
  const expected = cat(HEADER, [0x01, 0x08], digest, [0xf0, 0x10], nonce, [0x08], [0xff],
    [0xf1], varbytes(one.prefix), [0xf0], varbytes(one.suffix), upgrade, calendarReply(two.prefix, two.suffix, two.uri))
  assert.equal(hex(spliced), hex(expected))
  const root = sha256(cat(sha256(cat(one.prefix, submitted, one.suffix)), sibling))
  assert.deepEqual(await bitcoinAttestations(spliced), [{ height: 358391, merkleRoot: hex(root) }])
  assert.deepEqual(await pendingLeaves(spliced), [leaves[1]])
  await refuses(() => spliceUpgrade(built, 'ab'.repeat(44), upgrade), 'OTS_COMMITMENT_NOT_FOUND')
  await refuses(() => spliceUpgrade(built, leaves[0].commitment, cat(upgrade, [0x00])), 'OTS_TRAILING_BYTES')
})

test('every bound and a dozen malformed inputs refuse with closed codes', async () => {
  const proofWith = tree => cat(HEADER, [0x01, 0x08], new Uint8Array(32), tree)
  const cases = [
    ['not bytes', () => parseOts('not bytes'), 'OTS_INPUT_INVALID'],
    ['empty', () => parseOts(new Uint8Array(0)), 'OTS_TRUNCATED'],
    ['bad magic', () => parseOts(cat([0x01], INCOMPLETE.subarray(1))), 'OTS_HEADER_INVALID'],
    ['major version 2', () => parseOts(cat(HEADER, [0x02], INCOMPLETE.subarray(32))), 'OTS_VERSION_UNSUPPORTED'],
    ['file hash sha1', () => parseOts(cat(HEADER, [0x01, 0x02], INCOMPLETE.subarray(33))), 'OTS_FILE_HASH_UNSUPPORTED'],
    ['digest cut short', () => parseOts(INCOMPLETE.subarray(0, 50)), 'OTS_TRUNCATED'],
    ['tree cut short', () => parseOts(INCOMPLETE.subarray(0, INCOMPLETE.length - 1)), 'OTS_TRUNCATED'],
    ['uri length past its payload', () => parseOts(proofWith(cat([0x00], unhex('83dfe30d2ef90c8e'), varbytes(cat([0x09], new TextEncoder().encode('https://a')).subarray(0, 5))))), 'OTS_URI_INVALID'],
    ['a byte after the tree', () => parseOts(cat(INCOMPLETE, [0x00])), 'OTS_TRAILING_BYTES'],
    ['unknown op', () => parseOts(proofWith(cat([0x55], pendingAtt(PENDING)))), 'OTS_OP_UNKNOWN'],
    ['fork marker as a child', () => parseOts(proofWith(cat([0xff, 0xff], pendingAtt(PENDING)))), 'OTS_OP_UNKNOWN'],
    ['proof over 16 KiB', () => parseOts(proofWith(cat([0xf0], varbytes(new Uint8Array(4096)), ...Array.from({ length: 3 }, () => cat([0xf0], varbytes(new Uint8Array(4096)))), pendingAtt(PENDING)))), 'OTS_PROOF_LIMIT'],
    ['too deep', () => parseOts(proofWith(cat(new Uint8Array(OTS_LIMITS.depth + 1).fill(0x08), pendingAtt(PENDING)))), 'OTS_DEPTH_LIMIT'],
    ['too many nodes', () => parseOts(proofWith(cat(...Array.from({ length: OTS_LIMITS.nodes + 1 }, () => cat([0xff, 0x08], bitcoinAtt(1))), bitcoinAtt(1)))), 'OTS_NODE_LIMIT'],
    ['uri with a space', () => parseOts(proofWith(pendingAtt('https://alice btc.calendar.opentimestamps.org'))), 'OTS_URI_INVALID'],
    ['uri of 1,001 characters', () => parseOts(proofWith(pendingAtt('https://' + 'a'.repeat(993)))), 'OTS_URI_INVALID'],
    ['non-minimal varuint', () => parseOts(proofWith(cat([0xf0, 0x81, 0x00, 0x01], pendingAtt(PENDING)))), 'OTS_VARUINT_INVALID'],
    ['varuint of ten bytes', () => parseOts(proofWith(cat([0xf0], new Uint8Array(9).fill(0xff), [0x01], pendingAtt(PENDING)))), 'OTS_VARUINT_INVALID'],
    ['append argument over 4096', () => parseOts(proofWith(cat([0xf0], varbytes(new Uint8Array(4097)), pendingAtt(PENDING)))), 'OTS_ARG_LIMIT'],
    ['attestation payload over 8192', () => parseOts(proofWith(cat([0x00], unhex('0102030405060708'), varbytes(new Uint8Array(8193))))), 'OTS_PAYLOAD_LIMIT'],
    ['Bitcoin payload with a byte after the height', () => parseOts(proofWith(cat([0x00], unhex('0588960d73d71901'), varbytes(cat(varuint(5), [0x00]))))), 'OTS_ATTESTATION_INVALID'],
    ['message over 4096 while computing', () => pendingLeaves(proofWith(cat([0xf0], varbytes(new Uint8Array(4000)), [0xf0], varbytes(new Uint8Array(100)), pendingAtt(PENDING)))), 'OTS_MESSAGE_LIMIT'],
    ['keccak256 not available', () => pendingLeaves(proofWith(cat([0x67], pendingAtt(PENDING)))), 'OTS_OP_UNAVAILABLE'],
    ['a nonce of 15 bytes', () => buildDetached(new Uint8Array(32), new Uint8Array(15), [calendarReply(new Uint8Array(4), new Uint8Array(8), PENDING)]), 'OTS_INPUT_INVALID'],
    ['no calendar tree', () => buildDetached(new Uint8Array(32), new Uint8Array(16), []), 'OTS_INPUT_INVALID'],
    ['a calendar reply over 10,000 bytes', () => parseTree(cat([0xf0], varbytes(new Uint8Array(4096)), [0xf0], varbytes(new Uint8Array(4096)), [0xf0], varbytes(new Uint8Array(2000)), pendingAtt(PENDING))), 'OTS_PROOF_LIMIT'],
  ]
  assert.ok(cases.length >= 12)
  for (const [, run, code] of cases) await refuses(run, code)
  // An unknown attestation tag is kept as opaque bytes and written back unchanged.
  const unknown = proofWith(cat([0x00], unhex('0102030405060708'), varbytes(unhex('deadbeef'))))
  assert.equal(hex(serializeOts(parseOts(unknown))), hex(unknown))
  // The edge's sha1 runs through WebCrypto: a sha1 path computes without an injected hash.
  const sha1Path = proofWith(cat([0x02], pendingAtt(PENDING)))
  assert.equal((await pendingLeaves(sha1Path))[0].commitment, createHash('sha1').update(new Uint8Array(32)).digest('hex'))
})

test('no input ever escapes as a raw error: 600 random mutations of both vectors answer a closed code or parse', async () => {
  let seed = 7
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
  for (let round = 0; round < 600; round++) {
    const base = round % 2 ? HELLO : INCOMPLETE
    const bytes = new Uint8Array(base)
    const edits = 1 + next() % 4
    for (let edit = 0; edit < edits; edit++) bytes[next() % bytes.length] = next() % 256
    const cut = round % 5 === 0 ? bytes.subarray(0, next() % bytes.length) : bytes
    for (const run of [() => parseOts(cut), () => pendingLeaves(cut, { hashes: NODE_HASHES }), () => bitcoinAttestations(cut, { hashes: NODE_HASHES })]) {
      try { await run() } catch (error) { assert.ok(OTS_CODES.includes(error?.code), `raw error: ${error?.message}`) }
    }
  }
})
