// SEALED SHARDS: lock a file, split it into n pieces, bring it back from any k. Experimental and
// wired to nothing. The restore drill through the real recovery kit lives in recovery-restore.test.mjs.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import {
  SEALED_SHARDS_CODES, SEALED_SHARDS_LIMITS, SEALED_SHARDS_SCHEMA,
  checkShard, codeRow, encodePieces, gfInv, gfMul, openFromShards, rebuildData, sealToShards,
} from '../sealed-shards.mjs'

const VECTORS = JSON.parse(readFileSync(new URL('../sealed-shards.vectors.json', import.meta.url), 'utf8'))
const hex = bytes => Buffer.from(bytes).toString('hex')
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

/** Test data only (never a key): a small fixed generator, so a red run can be repeated. */
function generator(seed) {
  let state = seed >>> 0 || 1
  const next = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state }
  return { next, bytes: length => Uint8Array.from({ length }, () => next() & 0xff), below: bound => next() % bound }
}
const secretOf = seed => generator(seed).bytes(32)

/** Every way to choose `k` of the numbers 0..n-1. */
function choices(n, k) {
  const out = []
  const walk = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return }
    for (let at = start; at <= n - (k - picked.length); at++) { picked.push(at); walk(at + 1, picked); picked.pop() }
  }
  walk(0, [])
  return out
}
function someChoice(random, n, k) {
  const all = Array.from({ length: n }, (_, at) => at)
  for (let at = n - 1; at > 0; at--) { const swap = random.below(at + 1); [all[at], all[swap]] = [all[swap], all[at]] }
  return all.slice(0, k).sort((a, b) => a - b)
}
const offer = (shards, indexes) => indexes.map(index => ({ index, bytes: shards[index] }))
/** A refusal is one of the closed codes and never carries bytes. */
function refused(answer, code) {
  assert.equal(answer.ok, false, JSON.stringify(answer))
  assert.equal(answer.code, code)
  assert.ok(SEALED_SHARDS_CODES.includes(answer.code))
  assert.equal(Object.hasOwn(answer, 'plain'), false)
  assert.equal(JSON.stringify(answer).includes('"bytes"'), false)
}

test('the field: every product equals a slow shift-and-reduce multiply, and every non-zero element has its inverse', () => {
  const slow = (a, b) => {
    let out = 0
    for (let bit = 0; bit < 8; bit++) { if (b & (1 << bit)) out ^= a << bit }
    for (let bit = 15; bit >= 8; bit--) { if (out & (1 << bit)) out ^= 0x11d << (bit - 8) }
    return out
  }
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) assert.equal(gfMul(a, b), slow(a, b), `${a} * ${b}`)
  for (let a = 1; a < 256; a++) assert.equal(gfMul(a, gfInv(a)), 1)
  assert.throws(() => gfInv(0), RangeError)
})

test('the code: the first k rows are the identity, and data comes back from every choice of k pieces', () => {
  const random = generator(11)
  for (const [k, n] of [[1, 1], [1, 4], [2, 4], [3, 5], [3, 6], [4, 7], [5, 5]]) {
    for (let index = 0; index < k; index++) assert.deepEqual([...codeRow(index, k)], Array.from({ length: k }, (_, at) => Number(at === index)))
    const data = Array.from({ length: k }, () => random.bytes(9))
    const pieces = encodePieces(data, n)
    assert.equal(pieces.length, n)
    for (const picked of choices(n, k)) {
      const back = rebuildData(picked, picked.map(index => pieces[index]), k)
      assert.ok(back !== null && back.every((piece, at) => same(piece, data[at])), `${k} of ${n}, pieces ${picked}`)
    }
  }
  // Wide shapes, sampled: 20 of 80 (the example the owner was given) and the widest the format allows.
  for (const [k, n, rounds] of [[20, 80, 150], [10, 255, 60], [128, 255, 6]]) {
    const data = Array.from({ length: k }, () => random.bytes(5))
    const pieces = encodePieces(data, n)
    for (let round = 0; round < rounds; round++) {
      const picked = someChoice(random, n, k)
      const back = rebuildData(picked, picked.map(index => pieces[index]), k)
      assert.ok(back !== null && back.every((piece, at) => same(piece, data[at])), `${k} of ${n}, round ${round}`)
    }
  }
})

test('a file comes back byte for byte from every choice of k pieces, for many sizes', async () => {
  const random = generator(23)
  for (const [k, n] of [[1, 1], [1, 3], [2, 3], [3, 5], [5, 5]]) {
    for (const size of [0, 1, 2, 3, 15, 16, 17, 31, 1000, 65537]) {
      const plain = random.bytes(size), secret = secretOf(size * 31 + k)
      const sealed = await sealToShards(plain, { secret, k, n })
      assert.equal(sealed.ok, true, JSON.stringify(sealed))
      assert.equal(sealed.shards.length, n)
      assert.equal(sealed.manifest.shardBytes, Math.max(1, Math.ceil((size + 16) / k)))
      assert.ok(sealed.shards.every(piece => piece.length === sealed.manifest.shardBytes))
      const sets = size > 1000 ? choices(n, k).slice(-2) : choices(n, k)
      for (const picked of sets) {
        const opened = await openFromShards({ manifest: sealed.manifestJson, shards: offer(sealed.shards, picked).reverse(), secret })
        assert.equal(opened.ok, true, `${k} of ${n}, size ${size}, pieces ${picked}: ${JSON.stringify({ ...opened, plain: undefined })}`)
        assert.ok(same(opened.plain, plain))
        assert.deepEqual(opened.used, picked)
        assert.deepEqual(opened.rejected, [])
        assert.equal(opened.manifestSha256, sealed.manifestSha256)
      }
    }
  }
})

test('k - 1 pieces are refused, and the refusal says how many are needed and how many were good', async () => {
  const plain = generator(5).bytes(300), secret = secretOf(5)
  const sealed = await sealToShards(plain, { secret, k: 3, n: 5 })
  for (const picked of choices(5, 2)) {
    const answer = await openFromShards({ manifest: sealed.manifest, shards: offer(sealed.shards, picked), secret })
    refused(answer, 'SHARDS_TOO_FEW')
    assert.equal(answer.need, 3)
    assert.equal(answer.good, 2)
  }
  refused(await openFromShards({ manifest: sealed.manifest, shards: [], secret }), 'SHARDS_TOO_FEW')
})

test('a changed piece is set aside by its hash and another is used; too few good ones left is a refusal', async () => {
  const plain = generator(6).bytes(2000), secret = secretOf(6)
  const sealed = await sealToShards(plain, { secret, k: 3, n: 5 })
  for (let spoiledAt = 0; spoiledAt < 5; spoiledAt++) {
    for (const flipAt of [0, sealed.manifest.shardBytes - 1]) {
      const pieces = offer(sealed.shards, [0, 1, 2, 3, 4]).map(piece => ({ index: piece.index, bytes: Uint8Array.from(piece.bytes) }))
      pieces[spoiledAt].bytes[flipAt] ^= 0x80
      const opened = await openFromShards({ manifest: sealed.manifest, shards: pieces, secret })
      assert.equal(opened.ok, true)
      assert.ok(same(opened.plain, plain))
      assert.deepEqual(opened.rejected, [{ index: spoiledAt, why: 'hash' }])
      assert.equal(opened.used.includes(spoiledAt), false)
      // The same spoiled piece with only two good ones beside it.
      const others = pieces.filter(piece => piece.index !== spoiledAt).slice(0, 2)
      const answer = await openFromShards({ manifest: sealed.manifest, shards: [pieces[spoiledAt], ...others], secret })
      refused(answer, 'SHARDS_TOO_FEW')
      assert.equal(answer.good, 2)
      assert.deepEqual(answer.rejected, [{ index: spoiledAt, why: 'hash' }])
    }
  }
})

test('pieces offered at the wrong place, twice, short, long, out of range or not as bytes are set aside and named', async () => {
  const plain = generator(7).bytes(500), secret = secretOf(7)
  const sealed = await sealToShards(plain, { secret, k: 2, n: 4 })
  const [a, b, c, d] = sealed.shards
  const opened = await openFromShards({ manifest: sealed.manifest, secret, shards: [
    { index: 1, bytes: a },                       // piece 0 offered as piece 1
    { index: 2, bytes: c }, { index: 2, bytes: c }, // the same piece twice: the second is set aside
    { index: 3, bytes: d.subarray(1) },           // short
    { index: 0, bytes: new Uint8Array(a.length + 1) }, // long
    { index: 4, bytes: a }, { index: -1, bytes: a }, { index: 1.5, bytes: b }, // out of range
    { index: 3, bytes: [...d] }, null, 'piece',   // not bytes, not a piece
    { index: 1, bytes: b },
  ] })
  assert.equal(opened.ok, true)
  assert.ok(same(opened.plain, plain))
  assert.deepEqual(opened.used, [1, 2])
  assert.deepEqual(opened.rejected, [
    { index: 1, why: 'hash' }, { index: 2, why: 'duplicate' }, { index: 3, why: 'length' }, { index: 0, why: 'length' },
    { index: 4, why: 'index' }, { index: -1, why: 'index' }, { index: null, why: 'index' }, { index: 3, why: 'length' },
    { index: null, why: 'index' }, { index: null, why: 'index' },
  ])
})

test('the wrong secret is refused; a secret that is not 32 random bytes is refused before anything is read', async () => {
  const plain = generator(8).bytes(64), secret = secretOf(8)
  const sealed = await sealToShards(plain, { secret, k: 2, n: 3 })
  const shards = offer(sealed.shards, [0, 1, 2])
  for (let at = 0; at < 32; at += 5) {
    const near = Uint8Array.from(secret); near[at] ^= 1
    refused(await openFromShards({ manifest: sealed.manifest, shards, secret: near }), 'SHARDS_SECRET')
  }
  for (const bad of [secret.subarray(0, 31), new Uint8Array(33), new Uint8Array(0), 'correct horse battery staple twelve', [...secret], undefined, null]) {
    const opening = await openFromShards({ manifest: sealed.manifest, shards, secret: bad })
    refused(opening, 'SHARDS_INPUT'); assert.equal(opening.why, 'secret')
    const sealing = await sealToShards(plain, { secret: bad, k: 2, n: 3 })
    refused(sealing, 'SHARDS_INPUT'); assert.equal(sealing.why, 'secret')
  }
  assert.equal(SEALED_SHARDS_LIMITS.secretBytes, 32)
})

test('a changed manifest never gives other bytes: it is refused, or it opens to exactly the same file', async () => {
  const plain = generator(9).bytes(700), secret = secretOf(9)
  const sealed = await sealToShards(plain, { secret, k: 3, n: 5 })
  const shards = offer(sealed.shards, [0, 1, 2, 3, 4])
  const flip = text => (text[0] === '0' ? '1' : '0') + text.slice(1)
  const edit = change => { const copy = structuredClone(sealed.manifest); change(copy); return copy }
  const expected = [
    ['schema', m => { m.schema = 'aukora.sealed-shards.v2' }, 'SHARDS_MANIFEST'],
    ['cipher', m => { m.cipher = 'AES-128-GCM' }, 'SHARDS_MANIFEST'],
    ['kdf', m => { m.kdf = 'PBKDF2' }, 'SHARDS_MANIFEST'],
    ['code', m => { m.code = 'xor' }, 'SHARDS_MANIFEST'],
    ['k alone', m => { m.k = 2 }, 'SHARDS_MANIFEST'],
    ['k with its piece length', m => { m.k = 2; m.shardBytes = Math.ceil((700 + 16) / 2) }, 'SHARDS_TOO_FEW'],
    ['k above n', m => { m.k = 6 }, 'SHARDS_MANIFEST'],
    ['n alone', m => { m.n = 6 }, 'SHARDS_MANIFEST'],
    ['n with one more hash', m => { m.n = 6; m.shards.push(m.shards[0]) }, 'SHARDS_SECRET'],
    ['n over the limit', m => { m.n = 256; m.shards = Array.from({ length: 256 }, () => m.shards[0]) }, 'SHARDS_MANIFEST'],
    ['plain length, same piece length', m => { m.plainBytes = 701 }, 'SHARDS_CIPHERTEXT'],
    ['plain length, other piece length', m => { m.plainBytes = 720 }, 'SHARDS_MANIFEST'],
    ['negative length', m => { m.plainBytes = -1 }, 'SHARDS_MANIFEST'],
    ['piece length', m => { m.shardBytes += 1 }, 'SHARDS_MANIFEST'],
    ['wrap salt', m => { m.wrap.salt = flip(m.wrap.salt) }, 'SHARDS_SECRET'],
    ['wrap nonce', m => { m.wrap.iv = flip(m.wrap.iv) }, 'SHARDS_SECRET'],
    ['wrapped key', m => { m.wrap.key = flip(m.wrap.key) }, 'SHARDS_SECRET'],
    ['wrapped key tag', m => { m.wrap.key = m.wrap.key.slice(0, -1) + (m.wrap.key.endsWith('0') ? '1' : '0') }, 'SHARDS_SECRET'],
    ['short wrapped key', m => { m.wrap.key = m.wrap.key.slice(2) }, 'SHARDS_MANIFEST'],
    ['body nonce', m => { m.body.iv = flip(m.body.iv) }, 'SHARDS_CIPHERTEXT'],
    ['body hash', m => { m.body.sha256 = flip(m.body.sha256) }, 'SHARDS_CIPHERTEXT'],
    ['upper-case hex', m => { m.body.sha256 = m.body.sha256.toUpperCase().replace(/^[0-9]/, 'A') }, 'SHARDS_MANIFEST'],
    ['an extra key', m => { m.epoch = 80 }, 'SHARDS_MANIFEST'],
    ['an extra key in wrap', m => { m.wrap.hint = 'x' }, 'SHARDS_MANIFEST'],
    ['a missing key', m => { delete m.code }, 'SHARDS_MANIFEST'],
    ['a hash that is not text', m => { m.shards[2] = 7 }, 'SHARDS_MANIFEST'],
    ['three piece hashes changed', m => { for (const at of [0, 1, 2]) m.shards[at] = flip(m.shards[at]) }, 'SHARDS_TOO_FEW'],
  ]
  for (const [name, change, code] of expected) {
    const answer = await openFromShards({ manifest: edit(change), shards, secret })
    assert.equal(answer.code, code, `${name}: ${JSON.stringify({ ...answer, plain: undefined })}`)
    refused(answer, code)
  }
  // Two piece hashes changed: three good pieces are left, so it opens, to the same file, under ANOTHER manifest digest.
  const two = await openFromShards({ manifest: edit(m => { m.shards[0] = flip(m.shards[0]); m.shards[4] = flip(m.shards[4]) }), shards, secret })
  assert.equal(two.ok, true)
  assert.ok(same(two.plain, plain))
  assert.deepEqual(two.used, [1, 2, 3])
  assert.notEqual(two.manifestSha256, sealed.manifestSha256)
  // Text that is not the canonical text is refused; the same object with its keys in another order is the same manifest.
  for (const text of [` ${sealed.manifestJson}`, JSON.stringify(sealed.manifest, null, 1), sealed.manifestJson.replace('"k":3', '"k":3.0'), '{', '[]', 'null', '']) {
    refused(await openFromShards({ manifest: text, shards, secret }), 'SHARDS_MANIFEST')
  }
  for (const value of [null, undefined, 7, [], [sealed.manifest]]) refused(await openFromShards({ manifest: value, shards, secret }), 'SHARDS_MANIFEST')
  const reordered = Object.fromEntries(Object.entries(sealed.manifest).reverse())
  const again = await openFromShards({ manifest: reordered, shards, secret })
  assert.equal(again.ok, true)
  assert.equal(again.manifestSha256, sealed.manifestSha256)
  assert.equal(JSON.stringify(sealed.manifest), sealed.manifestJson)
})

test('the pinned vectors: the same inputs give the same bytes, and every vector opens from its LAST k pieces', async () => {
  assert.equal(VECTORS.schema, 'aukora.sealed-shards.vectors.v1')
  assert.deepEqual(VECTORS.vectors.map(vector => `${vector.k} of ${vector.n}`), ['3 of 5', '1 of 3', '4 of 10', '20 of 80'])
  for (const vector of VECTORS.vectors) {
    const draws = [vector.draws.wrapSalt, vector.draws.wrapIv, vector.draws.dataKey, vector.draws.bodyIv].map(unhex)
    const asked = []
    const sealed = await sealToShards(unhex(vector.plain), { secret: unhex(vector.secret), k: vector.k, n: vector.n,
      random: length => { asked.push(length); return draws[asked.length - 1] } })
    assert.deepEqual(asked, [32, 12, 32, 12], 'the order and sizes of the random draws are part of the format')
    assert.equal(sealed.manifestJson, vector.manifestJson, vector.name)
    assert.equal(sealed.manifestSha256, vector.manifestSha256, vector.name)
    assert.deepEqual(sealed.shards.map(hex), vector.shards, vector.name)
    assert.equal(sealed.manifest.schema, SEALED_SHARDS_SCHEMA)
    const last = Array.from({ length: vector.k }, (_, at) => vector.n - vector.k + at)
    const opened = await openFromShards({ manifest: vector.manifestJson, secret: unhex(vector.secret),
      shards: last.map(index => ({ index, bytes: unhex(vector.shards[index]) })) })
    assert.equal(opened.ok, true, vector.name)
    assert.equal(hex(opened.plain), vector.plain, vector.name)
  }
})

test('fresh randomness every time: two seals of the same file share no piece, key or nonce', async () => {
  const plain = generator(10).bytes(400), secret = secretOf(10)
  const [one, two] = [await sealToShards(plain, { secret, k: 2, n: 4 }), await sealToShards(plain, { secret, k: 2, n: 4 })]
  assert.notEqual(one.manifestSha256, two.manifestSha256)
  for (const key of ['salt', 'iv', 'key']) assert.notEqual(one.manifest.wrap[key], two.manifest.wrap[key])
  assert.notEqual(one.manifest.body.iv, two.manifest.body.iv)
  assert.equal(one.manifest.shards.some(hash => two.manifest.shards.includes(hash)), false)
  // A random source that answers the wrong size, or not bytes, is refused rather than used.
  for (const random of [() => new Uint8Array(8), length => Array.from({ length }, () => 0), () => null, 'crypto']) {
    refused(await sealToShards(plain, { secret, k: 2, n: 4, random }), 'SHARDS_INPUT')
  }
})

test('shapes outside the format are refused: n over 255, k over n, k below 1, numbers that are not whole, a file that is not bytes', async () => {
  const plain = new Uint8Array(10), secret = secretOf(12)
  for (const [k, n] of [[0, 3], [4, 3], [1, 256], [200, 300], [1.5, 3], [2, 3.5], ['2', 3], [2, '3'], [undefined, 3], [2, undefined], [-1, -1], [Number.NaN, 3]]) {
    const answer = await sealToShards(plain, { secret, k, n })
    refused(answer, 'SHARDS_INPUT'); assert.equal(answer.why, 'shape')
  }
  for (const file of ['text', [1, 2, 3], null, undefined, new ArrayBuffer(4), { length: 4 }]) {
    const answer = await sealToShards(file, { secret, k: 1, n: 1 })
    refused(answer, 'SHARDS_INPUT'); assert.equal(answer.why, 'plain')
  }
  const widest = await sealToShards(plain, { secret, k: 255, n: 255 })
  assert.equal(widest.ok, true)
  assert.equal(widest.manifest.shardBytes, 1)
  refused(await openFromShards({ manifest: widest.manifest, secret, shards: 'none' }), 'SHARDS_INPUT')
  refused(await openFromShards(), 'SHARDS_INPUT')
  refused(await sealToShards(plain), 'SHARDS_INPUT')
})

test('a piece is locked bytes: no piece of a file full of one marker holds the marker, and the manifest holds no secret', async () => {
  const marker = new TextEncoder().encode('AUMA-MARKER-0123')
  const plain = new Uint8Array(4096); for (let at = 0; at < plain.length; at += marker.length) plain.set(marker, at)
  const secret = secretOf(13)
  const sealed = await sealToShards(plain, { secret, k: 4, n: 8 })
  for (const piece of sealed.shards) assert.equal(Buffer.from(piece).includes(Buffer.from(marker)), false)
  assert.equal(sealed.manifestJson.includes(hex(secret)), false)
  assert.equal(sealed.manifestJson.includes(hex(marker)), false)
})

test('checkShard says yes to the named piece and no to any other, with no secret', async () => {
  const sealed = await sealToShards(generator(14).bytes(90), { secret: secretOf(14), k: 2, n: 3 })
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await checkShard(sealed.manifestJson, index, sealed.shards[index]), { ok: true })
    const other = await checkShard(sealed.manifest, index, sealed.shards[(index + 1) % 3])
    assert.equal(other.ok, false); assert.equal(other.why, 'hash')
  }
  assert.equal((await checkShard(sealed.manifest, 3, sealed.shards[0])).why, 'index')
  assert.equal((await checkShard(sealed.manifest, 0, sealed.shards[0].subarray(1))).why, 'length')
  refused(await checkShard({ ...sealed.manifest, k: 9 }, 0, sealed.shards[0]), 'SHARDS_MANIFEST')
})

test('wired to nothing: no source file at the edge imports or names the module (an experiment until the owner says go)', () => {
  const directory = new URL('../', import.meta.url)
  const named = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !['sealed-shards.mjs', 'sealed-shards.vectors.json'].includes(entry.name))
    .filter(entry => /sealed-shards|sealToShards|openFromShards/.test(readFileSync(new URL(entry.name, directory), 'utf8')))
    .map(entry => entry.name)
  assert.deepEqual(named, [])
})
