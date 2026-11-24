/** The voice memory record and its chain (voice-memory.mjs), against fixed vectors. The canonical bytes
 * and the digests below are fixed text; each digest is also recomputed here with node:crypto (an oracle outside the
 * module). The same three records, salts, words, canonical bytes and digests are written to
 * an earlier repository for the page lane. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  MEMORY_LIMITS, ZERO_DIGEST, answerDigest, canonical, commit, makeExchange, makeGap, opens, recordDigest, sha256hex, validGap, validRecord, validWords,
} from '../voice-memory.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const utf8 = text => new TextEncoder().encode(text)
const saltOf = byte => new Uint8Array(16).fill(byte)

/** The three vector exchanges (fixed salts, times and words). */
export const VECTOR_INPUTS = Object.freeze([
  { seq: 1, at: 1763294400000, conv: 'conv_vector1', turn: 'eleven:conv_vector1:1', heard: 'What did we decide about the chain?', said: 'We chain every exchange: each record names the hash of the one before.', ended: 'answered', path: 'fast',
    calls: [{ id: 'eleven:conv_vector1:1.fast', req: 'a'.repeat(64), res: 'b'.repeat(64), model: 'claude-fable-5-2', effort: 'low', rid: 'req_011CVector1' }], salt: saltOf(0x11) },
  { seq: 2, at: 1763294460000, conv: 'conv_vector1', turn: 'eleven:conv_vector1:2', heard: 'Say it with an accent: café, naïve, 日本, 🙂 and "quotes"\nand a new line.', said: 'Café, naïve, 日本, 🙂 — "quoted" (cut off here)', ended: 'cut', path: 'fast',
    calls: [], salt: saltOf(0x22) },
  { seq: 3, at: 1763301660000, conv: 'conv_vector2', turn: 'eleven:conv_vector2:7', heard: 'Hand that to your working self.', said: 'Handing it to my working self now.', ended: 'handed', path: 'governed',
    calls: [{ id: 'eleven:conv_vector2:7.fast', req: 'c'.repeat(64), res: '', model: '', effort: '', rid: '' }, { id: 'eleven:conv_vector2:7.fast2', req: 'd'.repeat(64), res: 'e'.repeat(64), model: 'claude-fable-5-2', effort: 'high', rid: '' }],
    salt: saltOf(0x33) },
])

async function vectorChain() {
  const out = []
  let prev = ZERO_DIGEST
  for (const input of VECTOR_INPUTS) {
    const made = await makeExchange({ ...input, prev })
    const digest = await recordDigest(made.record)
    out.push({ ...made, digest, canonical: canonical(made.record) })
    prev = digest
  }
  return out
}

test('canonical JSON: keys sorted by code unit, no whitespace, integers only, UTF-8; floats, undefined and -0 refused', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], A: { z: -3, y: '' } }), '{"A":{"y":"","z":-3},"a":[true,null,"x"],"b":1}')
  assert.equal(canonical({ 'é': 1, z: 2, Z: 3 }), '{"Z":3,"z":2,"é":1}')
  assert.equal(canonical({ s: 'line\n"q"\\   日本' }), '{"s":"line\\n\\"q\\"\\\\   日本"}')
  for (const bad of [{ n: 1.5 }, { n: NaN }, { n: Infinity }, { n: -0 }, { u: undefined }, { n: 2 ** 53 }, { f: () => 1 }, [undefined]]) {
    assert.throws(() => canonical(bad), /VOICE_MEMORY_CANON/)
  }
})

test('the commitments: sha256(salt || 0x00 || heard) and sha256(salt || 0x01 || said), checked against node:crypto', async () => {
  const salt = saltOf(0x11)
  const bytes = tag => new Uint8Array([...salt, tag, ...utf8('héllo')])
  assert.equal(await commit(salt, 0, 'héllo'), sha256(bytes(0)))
  assert.equal(await commit(salt, 1, 'héllo'), sha256(bytes(1)))
  assert.notEqual(await commit(salt, 0, 'héllo'), await commit(salt, 1, 'héllo'))
  assert.equal(await sha256hex(utf8('abc')), sha256(utf8('abc')))
})

test('the three vector records: fixed canonical bytes and digests, chained, each opening with its words', async () => {
  const chain = await vectorChain()
  assert.equal(chain[0].canonical, '{"at":1763294400000,"calls":[{"effort":"low","id":"eleven:conv_vector1:1.fast","model":"claude-fable-5-2","req":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","res":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rid":"req_011CVector1"}],"conv":"conv_vector1","ended":"answered","heardC":"' + chain[0].record.heardC + '","kind":"exchange","path":"fast","prev":"0000000000000000000000000000000000000000000000000000000000000000","saidC":"' + chain[0].record.saidC + '","seq":1,"turn":"eleven:conv_vector1:1","v":1}')
  // Fixed values (computed once and pinned; the page lane checks the same bytes).
  assert.deepEqual(chain.map(item => item.record.heardC), PINNED.heardC)
  assert.deepEqual(chain.map(item => item.record.saidC), PINNED.saidC)
  assert.deepEqual(chain.map(item => item.digest), PINNED.digests)
  for (const [index, item] of chain.entries()) {
    // The oracle: node:crypto over the canonical bytes.
    assert.equal(item.digest, sha256(utf8(item.canonical)))
    assert.equal(item.record.prev, index === 0 ? ZERO_DIGEST : chain[index - 1].digest)
    assert.equal(validRecord(item.record), true)
    assert.equal(validWords(item.words), true)
    assert.equal(await opens(item.record, item.words), true)
    assert.equal(item.words.salt, Buffer.from(VECTOR_INPUTS[index].salt).toString('hex'))
    // The salt lives only in the words record.
    assert.equal(Object.hasOwn(item.record, 'salt'), false)
    assert.equal(JSON.stringify(item.record).includes(item.words.salt), false)
  }
  // A changed word, a changed salt, or another record's words do not open.
  assert.equal(await opens(chain[0].record, { ...chain[0].words, heard: chain[0].words.heard + ' ' }), false)
  assert.equal(await opens(chain[0].record, { ...chain[0].words, salt: '00'.repeat(16) }), false)
  assert.equal(await opens(chain[0].record, chain[1].words), false)
})

test('a fresh exchange draws 16 random bytes of salt; the words are cut to their caps; shapes are closed', async () => {
  const a = await makeExchange({ ...VECTOR_INPUTS[0], salt: undefined, prev: ZERO_DIGEST })
  const b = await makeExchange({ ...VECTOR_INPUTS[0], salt: undefined, prev: ZERO_DIGEST })
  assert.match(a.words.salt, /^[0-9a-f]{32}$/)
  assert.notEqual(a.words.salt, b.words.salt)
  assert.notEqual(a.record.heardC, b.record.heardC)
  const long = await makeExchange({ ...VECTOR_INPUTS[0], prev: ZERO_DIGEST, heard: 'h'.repeat(5000), said: `${'s'.repeat(MEMORY_LIMITS.saidChars - 1)}🙂🙂` })
  assert.equal(long.words.heard.length, MEMORY_LIMITS.heardChars)
  // Never cut inside a surrogate pair.
  assert.equal(long.words.said.length, MEMORY_LIMITS.saidChars - 1)
  assert.equal(await opens(long.record, long.words), true)
  const good = (await vectorChain())[0].record
  for (const bad of [{ ...good, extra: 1 }, { ...good, v: 2 }, { ...good, seq: 0 }, { ...good, prev: 'x' }, { ...good, ended: 'done' }, { ...good, path: 'other' },
    { ...good, kind: 'gap' }, { ...good, conv: 'c'.repeat(81) }, { ...good, turn: 't'.repeat(161) }, { ...good, at: 1.5 },
    { ...good, calls: Array.from({ length: 9 }, () => good.calls[0]) }, { ...good, calls: [{ ...good.calls[0], rid: 'bad id!' }] },
    { ...good, calls: [{ ...good.calls[0], res: 'nothex' }] }, { ...good, calls: [{ ...good.calls[0], effort: 'turbo' }] }, { ...good, calls: [{ ...good.calls[0], extra: 1 }] }]) {
    assert.equal(validRecord(bad), false, JSON.stringify(bad).slice(0, 120))
  }
  const words = (await vectorChain())[0].words
  for (const bad of [{ ...words, extra: 1 }, { ...words, salt: 'ab' }, { ...words, heard: 'h'.repeat(4001) }, { ...words, said: 's'.repeat(6001) }, { ...words, seq: '1' }]) {
    assert.equal(validWords(bad), false)
  }
  await assert.rejects(() => makeExchange({ ...VECTOR_INPUTS[0], prev: ZERO_DIGEST, ended: 'done' }), /VOICE_MEMORY_RECORD_INVALID/)
})

test('the gap record: it stands for the missing span and carries the edge prev of the first resent record', async () => {
  const chain = await vectorChain()
  const gap = makeGap({ missingFrom: 1, missingTo: 2, prev: chain[2].record.prev, at: 1763301700000 })
  assert.deepEqual(gap, { v: 1, kind: 'gap', seq: 2, prev: chain[1].digest, at: 1763301700000, missingFrom: 1, missingTo: 2 })
  assert.equal(validGap(gap), true)
  assert.equal(validRecord(gap), false)
  assert.equal(validGap({ ...gap, missingTo: 0 }), false)
  assert.equal(canonical(gap), `{"at":1763301700000,"kind":"gap","missingFrom":1,"missingTo":2,"prev":"${chain[1].digest}","seq":2,"v":1}`)
})

test('the answer digest: the canonical answer blocks and stop reason, or the chat text and tool calls; a float is no digest', async () => {
  const blocks = [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'Hi.' }]
  const claude = await answerDigest({ blocks, stop: 'end_turn' })
  assert.equal(claude, sha256(utf8(canonical({ blocks, stop: 'end_turn' }))))
  assert.notEqual(claude, await answerDigest({ blocks, stop: 'tool_use' }))
  const chat = await answerDigest({ text: 'Hi.', calls: [{ name: 'look', args: '{}' }] })
  assert.equal(chat, sha256(utf8(canonical({ text: 'Hi.', calls: [{ name: 'look', args: '{}' }] }))))
  assert.equal(await answerDigest({ blocks: [{ type: 'tool_use', id: 't', name: 'look', input: { n: 1.5 } }], stop: 'tool_use' }), '')
  assert.equal(await answerDigest(null), '')
})

// Two of these commitments were also checked once with Python's hashlib (an oracle outside Node).
export const PINNED = Object.freeze({
  heardC: ['74623c7047db747754926b9cf8f699b87c6f0457b55aefa4e1fbc4558041a4a1', 'd1f76408ba469d6df14e08dd0e36bb2641e5eeb5376764b39103d42c538a85f4',
    'e314fd36d856f076a93fd31f8721b5912739551bc172dd28899acc55042e99ef'],
  saidC: ['e47fbc3f3c4b64b27d0eeb73461c0382958140e1fcba5c7ecbf03ce0107f6be7', 'bb3753e328a7732ff52252d2e875968533051880d518ce08c73d961688521534',
    '47c8af3a192a411a76659161f7c55868c8c1bc65ee3e36dd8ca4a6c4b40c05f5'],
  digests: ['f040100821a69703fbec761eef9c24dab4317cc050e2e5ba5fbc2f1dbd7223b4', 'c8e56f84d1001653ec162c30f7c44e9754417a1c79e0ca7235ca5659f8886b9b',
    'efc9364cebd974d13d838b0de5b5b3de52163bc0266d978dce027a7ee338674e'],
})
