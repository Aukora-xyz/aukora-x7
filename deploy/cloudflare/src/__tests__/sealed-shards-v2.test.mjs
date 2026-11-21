// SEALED SHARDS v2: the data key sealed to an X25519 PUBLIC key with HPKE (RFC 9180, base mode),
// so a machine can lock a copy without holding a secret. The body lock, the cut and the piece hashes are the v1 ones
// (sealed-shards.test.mjs). Experimental and wired to nothing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import {
  HPKE_BASE, SEALED_SHARDS_CODES, SEALED_SHARDS_SCHEMA, SEALED_SHARDS_SCHEMA_V2,
  checkShard, openFromShards, openFromShardsWith, sealToShards, sealToShardsFor,
} from '../sealed-shards.mjs'

const VECTORS = JSON.parse(readFileSync(new URL('../sealed-shards.vectors.json', import.meta.url), 'utf8'))
const hex = bytes => Buffer.from(bytes).toString('hex')
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const utf8 = text => new TextEncoder().encode(text)

/** Test data only: a small fixed generator, so a red run can be repeated. Keys made from it are fixture keys. */
function generator(seed) {
  let state = seed >>> 0 || 1
  const next = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state }
  return { next, bytes: length => Uint8Array.from({ length }, () => next() & 0xff) }
}
async function keyPair(seed) {
  const privateKey = generator(seed).bytes(32)
  return { privateKey, publicKey: await HPKE_BASE.publicKeyOf(privateKey) }
}
function choices(n, k) {
  const out = []
  const walk = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return }
    for (let at = start; at <= n - (k - picked.length); at++) { picked.push(at); walk(at + 1, picked); picked.pop() }
  }
  walk(0, [])
  return out
}
const offer = (shards, indexes) => indexes.map(index => ({ index, bytes: shards[index] }))
function refused(answer, code) {
  assert.equal(answer.ok, false, JSON.stringify(answer))
  assert.equal(answer.code, code)
  assert.ok(SEALED_SHARDS_CODES.includes(answer.code))
  assert.equal(Object.hasOwn(answer, 'plain'), false)
  assert.equal(JSON.stringify(answer).includes('"bytes"'), false)
}
const flip = text => (text[0] === '0' ? '1' : '0') + text.slice(1)
const wrapAad = (k, n, plainBytes) => utf8(JSON.stringify([SEALED_SHARDS_SCHEMA_V2, 'wrap', k, n, plainBytes]))

// Public keys whose X25519 answer is all zero for every private key. Each was also refused by Python's cryptography
// X25519 (RAN, by a separate probe script, not in this repository): 0, 1, an order-8 point, p - 1, p and p + 1.
const LOW_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]

test('RFC 9180 Appendix A.1 (X25519, HKDF-SHA256, AES-128-GCM, base mode): the same code gives every published value', async () => {
  const a1 = VECTORS.v2.rfc9180A1
  assert.match(a1.source, /^RFC 9180 Appendix A\.1 /)
  assert.deepEqual([a1.mode, a1.kem_id, a1.kdf_id, a1.aead_id], [0, HPKE_BASE.KEM_ID, HPKE_BASE.KDF_ID, HPKE_BASE.AES_128_GCM])
  const ephemeral = await HPKE_BASE.deriveKeyPair(unhex(a1.ikmE))
  assert.equal(hex(ephemeral.privateKey), a1.skEm)
  assert.equal(hex(ephemeral.publicKey), a1.pkEm)
  const recipient = await HPKE_BASE.deriveKeyPair(unhex(a1.ikmR))
  assert.equal(hex(recipient.privateKey), a1.skRm)
  assert.equal(hex(recipient.publicKey), a1.pkRm)
  assert.equal(hex(await HPKE_BASE.publicKeyOf(unhex(a1.skRm))), a1.pkRm)
  const encapsulated = await HPKE_BASE.encap(unhex(a1.pkRm), unhex(a1.ikmE))
  assert.equal(hex(encapsulated.enc), a1.enc)
  assert.equal(hex(encapsulated.sharedSecret), a1.shared_secret)
  assert.equal(hex(await HPKE_BASE.decap(unhex(a1.enc), unhex(a1.skRm))), a1.shared_secret)
  const schedule = await HPKE_BASE.keySchedule(a1.aead_id, unhex(a1.shared_secret), unhex(a1.info))
  assert.equal(hex(schedule.key), a1.key)
  assert.equal(hex(schedule.baseNonce), a1.base_nonce)
  const first = a1.encryption0
  assert.equal(first.sequence_number, 0)
  assert.equal(hex(HPKE_BASE.nonceFor(schedule.baseNonce, 0)), first.nonce)
  const sealed = await HPKE_BASE.seal(a1.aead_id, unhex(a1.pkRm), unhex(a1.info), unhex(first.aad), unhex(first.pt), unhex(a1.ikmE))
  assert.equal(hex(sealed.enc), a1.enc)
  assert.equal(hex(sealed.ct), first.ct)
  assert.equal(hex(await HPKE_BASE.open(a1.aead_id, unhex(a1.skRm), unhex(a1.enc), unhex(a1.info), unhex(first.aad), unhex(first.ct))), first.pt)
  // The nonce rule beyond sequence 0: base_nonce XOR I2OSP(seq, 12).
  const twoFiftySeven = HPKE_BASE.nonceFor(schedule.baseNonce, 257)
  assert.equal(hex(twoFiftySeven.subarray(0, 10)), a1.base_nonce.slice(0, 20))
  assert.deepEqual([...twoFiftySeven.subarray(10)], [schedule.baseNonce[10] ^ 1, schedule.baseNonce[11] ^ 1])
  // The suite parameter is the only difference: the same shared secret under AES-256-GCM gives a 32-byte key.
  assert.equal((await HPKE_BASE.keySchedule(HPKE_BASE.AES_256_GCM, unhex(a1.shared_secret), unhex(a1.info))).key.length, 32)
  await assert.rejects(() => HPKE_BASE.keySchedule(0x0003, unhex(a1.shared_secret), unhex(a1.info)), RangeError)
})

test('v2: a file comes back byte for byte from every choice of k pieces, for many shapes and sizes', async () => {
  const random = generator(31)
  for (const [k, n] of [[1, 1], [1, 3], [2, 3], [2, 4], [3, 5], [5, 5]]) {
    const { privateKey, publicKey } = await keyPair(k * 100 + n)
    for (const size of [0, 1, 15, 16, 17, 31, 1000, 65537]) {
      const plain = random.bytes(size)
      const sealed = await sealToShardsFor(plain, { publicKey, k, n })
      assert.equal(sealed.ok, true, JSON.stringify(sealed))
      assert.equal(sealed.manifest.schema, SEALED_SHARDS_SCHEMA_V2)
      assert.equal(sealed.manifest.kdf, 'HPKE-X25519-HKDF-SHA256')
      assert.equal(sealed.manifest.wrap.to, sha256(publicKey))
      assert.equal(sealed.manifest.shardBytes, Math.max(1, Math.ceil((size + 16) / k)))
      assert.ok(sealed.shards.every(piece => piece.length === sealed.manifest.shardBytes))
      const sets = size > 1000 ? choices(n, k).slice(-2) : choices(n, k)
      for (const picked of sets) {
        const opened = await openFromShardsWith({ manifest: sealed.manifestJson, shards: offer(sealed.shards, picked).reverse(), privateKey })
        assert.equal(opened.ok, true, `${k} of ${n}, size ${size}, pieces ${picked}: ${JSON.stringify({ ...opened, plain: undefined })}`)
        assert.ok(same(opened.plain, plain))
        assert.deepEqual(opened.used, picked)
        assert.deepEqual(opened.rejected, [])
        assert.equal(opened.manifestSha256, sealed.manifestSha256)
      }
    }
  }
})

test('v2: the manifest has the v1 keys in the v1 order, with wrap { to, enc, key } and nothing secret in it', async () => {
  const { privateKey, publicKey } = await keyPair(40)
  const sealed = await sealToShardsFor(generator(40).bytes(100), { publicKey, k: 2, n: 3 })
  const v1 = await sealToShards(generator(40).bytes(100), { secret: generator(41).bytes(32), k: 2, n: 3 })
  assert.deepEqual(Object.keys(JSON.parse(sealed.manifestJson)), Object.keys(JSON.parse(v1.manifestJson)))
  assert.deepEqual(Object.keys(sealed.manifest.wrap), ['to', 'enc', 'key'])
  assert.equal(sealed.manifest.wrap.enc.length, 64)
  assert.equal(sealed.manifest.wrap.key.length, 96)
  assert.equal(JSON.stringify(sealed.manifest), sealed.manifestJson)
  assert.equal(sealed.manifestJson.includes(hex(privateKey)), false)
  assert.equal(sealed.manifestJson.includes(hex(publicKey)), false, 'the manifest names the key by its SHA-256 only')
})

test('v2: the wrong private key is refused; a key that is not 32 bytes is refused before anything is read', async () => {
  const { privateKey, publicKey } = await keyPair(50)
  const plain = generator(50).bytes(64)
  const sealed = await sealToShardsFor(plain, { publicKey, k: 2, n: 3 })
  const shards = offer(sealed.shards, [0, 1, 2])
  for (let at = 0; at < 32; at += 5) {
    const near = Uint8Array.from(privateKey); near[at] ^= 0x40
    refused(await openFromShardsWith({ manifest: sealed.manifest, shards, privateKey: near }), 'SHARDS_SECRET')
  }
  refused(await openFromShardsWith({ manifest: sealed.manifest, shards, privateKey: (await keyPair(51)).privateKey }), 'SHARDS_SECRET')
  // A stranger's key that the manifest is changed to name still cannot open the sealed key.
  const stranger = await keyPair(52)
  const renamed = { ...structuredClone(sealed.manifest), wrap: { ...sealed.manifest.wrap, to: sha256(stranger.publicKey) } }
  refused(await openFromShardsWith({ manifest: renamed, shards, privateKey: stranger.privateKey }), 'SHARDS_SECRET')
  for (const bad of [privateKey.subarray(0, 31), new Uint8Array(33), new Uint8Array(0), hex(privateKey), [...privateKey], undefined, null]) {
    const opening = await openFromShardsWith({ manifest: sealed.manifest, shards, privateKey: bad })
    refused(opening, 'SHARDS_INPUT'); assert.equal(opening.why, 'privateKey')
  }
  for (const bad of [publicKey.subarray(0, 31), new Uint8Array(33), new Uint8Array(0), hex(publicKey), [...publicKey], undefined, null]) {
    const sealing = await sealToShardsFor(plain, { publicKey: bad, k: 2, n: 3 })
    refused(sealing, 'SHARDS_INPUT'); assert.equal(sealing.why, 'publicKey')
  }
  // The right key still opens it after all that.
  assert.equal((await openFromShardsWith({ manifest: sealed.manifestJson, shards, privateKey })).ok, true)
})

test('v2: a changed enc, key, to, k, n or plainBytes is refused, each with its code', async () => {
  const { privateKey, publicKey } = await keyPair(60)
  const plain = generator(60).bytes(700)
  const sealed = await sealToShardsFor(plain, { publicKey, k: 3, n: 5 })
  const shards = offer(sealed.shards, [0, 1, 2, 3, 4])
  const edit = change => { const copy = structuredClone(sealed.manifest); change(copy); return copy }
  // The ciphertext as it would be cut for one more plain byte (the pieces carry a zero pad byte there).
  const longer = new Uint8Array(sealed.manifest.k * sealed.manifest.shardBytes)
  sealed.shards.slice(0, 3).forEach((piece, at) => longer.set(piece, at * sealed.manifest.shardBytes))
  const longerSha = sha256(longer.subarray(0, 701 + 16))
  const expected = [
    ['enc', m => { m.wrap.enc = flip(m.wrap.enc) }, 'SHARDS_SECRET'],
    ['enc, last byte', m => { m.wrap.enc = m.wrap.enc.slice(0, -2) + (m.wrap.enc.endsWith('00') ? '01' : '00') }, 'SHARDS_SECRET'],
    ...LOW_ORDER.map(point => [`enc low order ${point.slice(0, 8)}`, m => { m.wrap.enc = point }, 'SHARDS_SECRET']),
    ['sealed key', m => { m.wrap.key = flip(m.wrap.key) }, 'SHARDS_SECRET'],
    ['sealed key tag', m => { m.wrap.key = m.wrap.key.slice(0, -1) + (m.wrap.key.endsWith('0') ? '1' : '0') }, 'SHARDS_SECRET'],
    ['short sealed key', m => { m.wrap.key = m.wrap.key.slice(2) }, 'SHARDS_MANIFEST'],
    ['short enc', m => { m.wrap.enc = m.wrap.enc.slice(2) }, 'SHARDS_MANIFEST'],
    ['to', m => { m.wrap.to = flip(m.wrap.to) }, 'SHARDS_SECRET'],
    ['to upper case', m => { m.wrap.to = m.wrap.to.toUpperCase().replace(/^[0-9]/, 'A') }, 'SHARDS_MANIFEST'],
    ['k alone', m => { m.k = 2 }, 'SHARDS_MANIFEST'],
    ['k with its piece length', m => { m.k = 2; m.shardBytes = Math.ceil((700 + 16) / 2) }, 'SHARDS_TOO_FEW'],
    ['n alone', m => { m.n = 6 }, 'SHARDS_MANIFEST'],
    ['n with one more hash (n is bound to the wrap)', m => { m.n = 6; m.shards.push(m.shards[0]) }, 'SHARDS_SECRET'],
    ['plainBytes, same piece length', m => { m.plainBytes = 701 }, 'SHARDS_CIPHERTEXT'],
    ['plainBytes with the body hash to match (plainBytes is bound to the wrap)', m => { m.plainBytes = 701; m.body.sha256 = longerSha }, 'SHARDS_SECRET'],
    ['body nonce', m => { m.body.iv = flip(m.body.iv) }, 'SHARDS_CIPHERTEXT'],
    ['an extra key in wrap', m => { m.wrap.salt = '00'.repeat(32) }, 'SHARDS_MANIFEST'],
    ['the v1 kdf name', m => { m.kdf = 'HKDF-SHA-256' }, 'SHARDS_MANIFEST'],
  ]
  for (const [name, change, code] of expected) {
    const answer = await openFromShardsWith({ manifest: edit(change), shards, privateKey })
    assert.equal(answer.code, code, `${name}: ${JSON.stringify({ ...answer, plain: undefined })}`)
    refused(answer, code)
  }
  // Every bound number, one at a time, straight at the HPKE open: the sealed key opens under the exact associated
  // data only (k cannot be changed through a manifest without changing every piece, so it is checked here).
  const enc = unhex(sealed.manifest.wrap.enc), ct = unhex(sealed.manifest.wrap.key)
  const open = (aad, info = HPKE_BASE.V2_INFO) => HPKE_BASE.open(HPKE_BASE.AES_256_GCM, privateKey, enc, info, aad, ct)
  assert.equal((await open(wrapAad(3, 5, 700))).length, 32)
  for (const aad of [wrapAad(2, 5, 700), wrapAad(4, 5, 700), wrapAad(3, 6, 700), wrapAad(3, 5, 701),
    utf8(JSON.stringify([SEALED_SHARDS_SCHEMA, 'wrap', 3, 5, 700])), utf8(JSON.stringify([SEALED_SHARDS_SCHEMA_V2, 'body', 3, 5, 700])), new Uint8Array(0)]) {
    assert.equal(await open(aad), null, new TextDecoder().decode(aad))
  }
  assert.equal(await open(wrapAad(3, 5, 700), utf8('aukora.sealed-shards.v1 key-wrap')), null)
  assert.equal(await open(wrapAad(3, 5, 700), new Uint8Array(0)), null)
})

test('v1 and v2 never open each other: each call refuses the other format as SHARDS_MANIFEST, whatever is renamed', async () => {
  const { privateKey, publicKey } = await keyPair(70)
  const secret = generator(71).bytes(32), plain = generator(70).bytes(300)
  const v1 = await sealToShards(plain, { secret, k: 2, n: 4 })
  const v2 = await sealToShardsFor(plain, { publicKey, k: 2, n: 4 })
  const v1Shards = offer(v1.shards, [0, 1, 2, 3]), v2Shards = offer(v2.shards, [0, 1, 2, 3])
  // Each format's own manifest to the other call, as an object and as its text.
  for (const manifest of [v1.manifest, v1.manifestJson]) refused(await openFromShardsWith({ manifest, shards: v1Shards, privateKey }), 'SHARDS_MANIFEST')
  for (const manifest of [v2.manifest, v2.manifestJson]) refused(await openFromShards({ manifest, shards: v2Shards, secret }), 'SHARDS_MANIFEST')
  // Renamed to pass as the other: a schema, a kdf, or both, never enough.
  const rename = (manifest, fields) => ({ ...structuredClone(manifest), ...fields })
  for (const fields of [{ schema: SEALED_SHARDS_SCHEMA }, { kdf: 'HKDF-SHA-256' }, { schema: SEALED_SHARDS_SCHEMA, kdf: 'HKDF-SHA-256' }]) {
    refused(await openFromShards({ manifest: rename(v2.manifest, fields), shards: v2Shards, secret }), 'SHARDS_MANIFEST')
  }
  for (const fields of [{ schema: SEALED_SHARDS_SCHEMA_V2 }, { kdf: 'HPKE-X25519-HKDF-SHA256' }, { schema: SEALED_SHARDS_SCHEMA_V2, kdf: 'HPKE-X25519-HKDF-SHA256' }]) {
    refused(await openFromShardsWith({ manifest: rename(v1.manifest, fields), shards: v1Shards, privateKey }), 'SHARDS_MANIFEST')
  }
  // A v2 wrap carried inside a v1-shaped manifest (and the reverse) is not a v1 (or v2) manifest either.
  refused(await openFromShards({ manifest: rename(v1.manifest, { wrap: v2.manifest.wrap }), shards: v1Shards, secret }), 'SHARDS_MANIFEST')
  refused(await openFromShardsWith({ manifest: rename(v2.manifest, { wrap: v1.manifest.wrap }), shards: v2Shards, privateKey }), 'SHARDS_MANIFEST')
  // Each still opens with its own call.
  assert.ok(same((await openFromShards({ manifest: v1.manifestJson, shards: v1Shards, secret })).plain, plain))
  assert.ok(same((await openFromShardsWith({ manifest: v2.manifestJson, shards: v2Shards, privateKey })).plain, plain))
  // checkShard reads both formats, with no secret and no key.
  for (const sealed of [v1, v2]) {
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(await checkShard(sealed.manifestJson, index, sealed.shards[index]), { ok: true })
      assert.equal((await checkShard(sealed.manifest, index, sealed.shards[(index + 1) % 4])).why, 'hash')
    }
  }
  refused(await checkShard({ ...v2.manifest, kdf: 'HKDF-SHA-256' }, 0, v2.shards[0]), 'SHARDS_MANIFEST')
})

test('v2: the all-zero and other low-order public keys are refused when locking', async () => {
  const plain = generator(80).bytes(50)
  for (const point of LOW_ORDER) {
    const answer = await sealToShardsFor(plain, { publicKey: unhex(point), k: 2, n: 3 })
    refused(answer, 'SHARDS_INPUT'); assert.equal(answer.why, 'publicKey', point)
    assert.equal(await HPKE_BASE.encap(unhex(point), generator(81).bytes(32)), null, point)
  }
})

test('v2: a public key that is not the canonical encoding (top bit set, or u >= p) is refused when locking, before any draw', async () => {
  const plain = generator(82).bytes(50)
  const { privateKey, publicKey } = await keyPair(83)
  const high = Uint8Array.from(publicKey); high[31] |= 0x80 // the same point to X25519, but bytes the owner never recomputes
  const p = unhex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')
  const plusTen = Uint8Array.from(p); plusTen[0] += 10 // p + 10: reduces to 10, not low order
  const all = new Uint8Array(32).fill(0xff) // 2^256 - 1: both faults at once
  for (const bad of [high, plusTen, all]) {
    const asked = []
    const answer = await sealToShardsFor(plain, { publicKey: bad, k: 2, n: 3, random: length => { asked.push(length); return generator(84).bytes(length) } })
    refused(answer, 'SHARDS_INPUT'); assert.equal(answer.why, 'publicKey', hex(bad))
    assert.deepEqual(asked, [], 'refused before any random draw')
  }
  // The edge just under p is canonical (p - 4 is not low order), and the owner's own key still locks and opens.
  const under = Uint8Array.from(p); under[0] -= 4
  assert.equal((await sealToShardsFor(plain, { publicKey: under, k: 2, n: 3 })).ok, true)
  const sealed = await sealToShardsFor(plain, { publicKey, k: 2, n: 3 })
  const opened = await openFromShardsWith({ manifest: sealed.manifestJson, shards: offer(sealed.shards, [0, 2]), privateKey })
  assert.equal(opened.ok, true); assert.ok(same(opened.plain, plain))
})

test('v2: the random draws are asked in this order and these sizes (ephemeral seed 32, data key 32, body nonce 12), and a bad source is refused', async () => {
  const { publicKey } = await keyPair(90)
  const plain = generator(90).bytes(10)
  const asked = []
  const sealed = await sealToShardsFor(plain, { publicKey, k: 1, n: 2, random: length => { asked.push(length); return generator(asked.length).bytes(length) } })
  assert.equal(sealed.ok, true)
  assert.deepEqual(asked, [32, 32, 12], 'the order and sizes of the random draws are part of the format')
  // The third draw is the body nonce, the first one seeds enc.
  assert.equal(sealed.manifest.body.iv, hex(generator(3).bytes(12)))
  assert.equal(sealed.manifest.wrap.enc, hex((await HPKE_BASE.deriveKeyPair(generator(1).bytes(32))).publicKey))
  for (const random of [() => new Uint8Array(8), length => Array.from({ length }, () => 0), () => null, 'crypto']) {
    refused(await sealToShardsFor(plain, { publicKey, k: 1, n: 2, random }), 'SHARDS_INPUT')
  }
  // Fresh randomness by default: two seals of the same file share no enc, sealed key, nonce or piece.
  const [one, two] = [await sealToShardsFor(plain, { publicKey, k: 1, n: 2 }), await sealToShardsFor(plain, { publicKey, k: 1, n: 2 })]
  assert.notEqual(one.manifest.wrap.enc, two.manifest.wrap.enc)
  assert.notEqual(one.manifest.wrap.key, two.manifest.wrap.key)
  assert.notEqual(one.manifest.body.iv, two.manifest.body.iv)
  assert.equal(one.manifest.wrap.to, two.manifest.wrap.to)
  assert.equal(one.manifest.shards.some(hash => two.manifest.shards.includes(hash)), false)
})

test('v2 pinned vectors: the same inputs give the same bytes, and every vector opens from its LAST k pieces', async () => {
  assert.deepEqual(VECTORS.v2.vectors.map(vector => `${vector.k} of ${vector.n}`), ['3 of 5', '1 of 3', '20 of 80'])
  for (const vector of VECTORS.v2.vectors) {
    assert.equal(hex(await HPKE_BASE.publicKeyOf(unhex(vector.recipient.privateKey))), vector.recipient.publicKey, vector.name)
    const draws = [vector.draws.ephemeralSeed, vector.draws.dataKey, vector.draws.bodyIv].map(unhex)
    const asked = []
    const sealed = await sealToShardsFor(unhex(vector.plain), { publicKey: unhex(vector.recipient.publicKey), k: vector.k, n: vector.n,
      random: length => { asked.push(length); return draws[asked.length - 1] } })
    assert.deepEqual(asked, [32, 32, 12])
    assert.equal(sealed.manifestJson, vector.manifestJson, vector.name)
    assert.equal(sealed.manifestSha256, vector.manifestSha256, vector.name)
    assert.equal(sha256(utf8(vector.manifestJson)), vector.manifestSha256, vector.name)
    assert.deepEqual(sealed.shards.map(hex), vector.shards, vector.name)
    assert.equal(sealed.manifest.wrap.enc, vector.enc)
    assert.equal(sealed.manifest.wrap.key, vector.sealedKey)
    assert.equal(sealed.manifest.wrap.to, sha256(unhex(vector.recipient.publicKey)))
    assert.equal(sealed.manifest.body.iv, vector.draws.bodyIv)
    const last = Array.from({ length: vector.k }, (_, at) => vector.n - vector.k + at)
    const opened = await openFromShardsWith({ manifest: vector.manifestJson, privateKey: unhex(vector.recipient.privateKey),
      shards: last.map(index => ({ index, bytes: unhex(vector.shards[index]) })) })
    assert.equal(opened.ok, true, vector.name)
    assert.equal(hex(opened.plain), vector.plain, vector.name)
    // The sealed data key opens straight from HPKE to the recorded data key.
    const dataKey = await HPKE_BASE.open(HPKE_BASE.AES_256_GCM, unhex(vector.recipient.privateKey), unhex(vector.enc), HPKE_BASE.V2_INFO,
      wrapAad(vector.k, vector.n, vector.plain.length / 2), unhex(vector.sealedKey))
    assert.equal(hex(dataKey), vector.draws.dataKey, vector.name)
  }
})

test('v2: a piece is locked bytes, and a changed piece is set aside and replaced as in v1', async () => {
  const marker = utf8('AUMA-MARKER-0123')
  const plain = new Uint8Array(4096); for (let at = 0; at < plain.length; at += marker.length) plain.set(marker, at)
  const { privateKey, publicKey } = await keyPair(100)
  const sealed = await sealToShardsFor(plain, { publicKey, k: 4, n: 8 })
  for (const piece of sealed.shards) assert.equal(Buffer.from(piece).includes(Buffer.from(marker)), false)
  const pieces = offer(sealed.shards, [0, 1, 2, 3, 4, 5, 6, 7]).map(piece => ({ index: piece.index, bytes: Uint8Array.from(piece.bytes) }))
  pieces[1].bytes[0] ^= 1
  const opened = await openFromShardsWith({ manifest: sealed.manifest, shards: pieces, privateKey })
  assert.ok(same(opened.plain, plain))
  assert.deepEqual(opened.rejected, [{ index: 1, why: 'hash' }])
  assert.deepEqual(opened.used, [0, 2, 3, 4])
  const few = await openFromShardsWith({ manifest: sealed.manifest, shards: pieces.slice(0, 4), privateKey })
  refused(few, 'SHARDS_TOO_FEW'); assert.equal(few.good, 3)
  refused(await openFromShardsWith({ manifest: sealed.manifest, privateKey, shards: 'none' }), 'SHARDS_INPUT')
  refused(await openFromShardsWith(), 'SHARDS_INPUT')
  refused(await sealToShardsFor(plain), 'SHARDS_INPUT')
  for (const [k, n] of [[0, 3], [4, 3], [1, 256]]) assert.equal((await sealToShardsFor(plain, { publicKey, k, n })).why, 'shape')
})

test('wired to nothing, v2 too: no source file at the edge names the module or its v2 calls', () => {
  const directory = new URL('../', import.meta.url)
  const named = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !['sealed-shards.mjs', 'sealed-shards.vectors.json'].includes(entry.name))
    .filter(entry => /sealed-shards|sealToShardsFor|openFromShardsWith|HPKE_BASE/.test(readFileSync(new URL(entry.name, directory), 'utf8')))
    .map(entry => entry.name)
  assert.deepEqual(named, [])
})
