/** One Bitcoin block header (bitcoin-header.mjs), checked against real blocks. Expected hashes are recomputed here
 * with node:crypto. Real bytes: the genesis block (hash and merkle root as the research file gives them; the 80 bytes are
 * the published genesis header, and they hash to that hash), block 125552 (the published "block hashing algorithm"
 * example; its 80 bytes hash to its own hash under its own target). The proofs' own attestations are tested in
 * ots.test.mjs on the reference client's example proofs. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { BITCOIN_HEADER_BYTES, headerHash, leadingZeroBits, meetsOwnTarget, parseHeader, rebuildHeader, targetFromBits } from '../bitcoin-header.mjs'

const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const rev = text => Buffer.from(text, 'hex').reverse().toString('hex')
const dsha = bytes => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest()

const GENESIS = {
  header: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
  hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  fields: { version: 1, prevHash: '0'.repeat(64), merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', time: 1231006505, bits: 486604799, nonce: 2083236893 },
}
const B125552 = {
  header: '0100000081cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122bc7f5d74df2b9441a42a14695',
  hash: '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d',
}

test('genesis: parsed field by field, hashed twice and shown reversed, under its own target, rebuilt from its JSON fields', async () => {
  const bytes = unhex(GENESIS.header)
  assert.equal(bytes.length, BITCOIN_HEADER_BYTES)
  const fields = parseHeader(bytes)
  assert.deepEqual(fields, { ...GENESIS.fields, merkleRootHeaderOrder: rev(GENESIS.merkleRoot) })
  assert.equal(fields.bits, 0x1d00ffff)
  assert.equal(await headerHash(bytes), GENESIS.hash)
  assert.equal(await headerHash(bytes), Buffer.from(dsha(bytes)).reverse().toString('hex'), 'recomputed with node:crypto')
  assert.equal(targetFromBits(0x1d00ffff), 0xffffn << 208n)
  assert.equal(await meetsOwnTarget(bytes), true)
  assert.equal(leadingZeroBits(GENESIS.hash), 43)
  assert.deepEqual(rebuildHeader(GENESIS.fields), bytes)
  // The research file's byte-order finding: the JSON merkle root is the header's bytes 36..68 reversed.
  assert.equal(Buffer.from(bytes.subarray(36, 68)).toString('hex'), rev(GENESIS.merkleRoot))
})

test('block 125552: a real header past 64 zero bits (67) still under the 72-bit floor the witness uses', async () => {
  const bytes = unhex(B125552.header)
  assert.equal(await headerHash(bytes), B125552.hash)
  assert.equal(await meetsOwnTarget(bytes), true)
  assert.equal(parseHeader(bytes).bits, 0x1a44b9f2)
  assert.equal(leadingZeroBits(B125552.hash), 67)
  assert.deepEqual(rebuildHeader(parseHeader(bytes)), bytes)
})

test('one changed byte: the hash changes and the header no longer meets its own target', async () => {
  const bytes = unhex(GENESIS.header)
  bytes[79] ^= 1
  assert.notEqual(await headerHash(bytes), GENESIS.hash)
  assert.equal(await meetsOwnTarget(bytes), false)
})

test('targetFromBits refuses a negative, overflowing or zero target; leadingZeroBits counts in display order', () => {
  for (const bad of [0x1d80ffff, 0x04800001, 0x23000001, 0x22000100, 0x21010000, 0x1d000000, 0x01000001, -1, 2 ** 32, 1.5, '486604799']) {
    assert.throws(() => targetFromBits(bad), { code: 'BITCOIN_BITS_INVALID' }, String(bad))
  }
  assert.equal(targetFromBits(0x03123456), 0x123456n)
  assert.equal(targetFromBits(0x02123400), 0x1234n)
  assert.equal(targetFromBits(0x207fffff), 0x7fffffn << 232n)
  assert.equal(leadingZeroBits('f' + '0'.repeat(63)), 0)
  assert.equal(leadingZeroBits('1' + '0'.repeat(63)), 3)
  assert.equal(leadingZeroBits('0'.repeat(64)), 256)
  assert.throws(() => leadingZeroBits('00'), { code: 'BITCOIN_HEADER_INVALID' })
})

test('parseHeader and rebuildHeader refuse anything but 80 bytes and exact fields', () => {
  for (const bad of [new Uint8Array(79), new Uint8Array(81), [0], null]) assert.throws(() => parseHeader(bad), { code: 'BITCOIN_HEADER_INVALID' })
  for (const change of [{ prevHash: 'x' }, { merkleRoot: GENESIS.merkleRoot.toUpperCase() }, { time: -1 }, { bits: 2 ** 32 }, { nonce: 1.5 }, { version: '1' }, { version: -(2 ** 31) - 1 }]) {
    assert.throws(() => rebuildHeader({ ...GENESIS.fields, ...change }), { code: 'BITCOIN_HEADER_INVALID' }, JSON.stringify(change))
  }
  // A version shown signed (as some explorers show the top bit) is the same 4 bytes.
  assert.deepEqual(rebuildHeader({ ...GENESIS.fields, version: -1 }).subarray(0, 4), Uint8Array.of(0xff, 0xff, 0xff, 0xff))
})
