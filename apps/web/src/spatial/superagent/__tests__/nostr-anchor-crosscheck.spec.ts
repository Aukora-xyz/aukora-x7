/**
 * CROSS-CHECK: the page's own Nostr verifier against an event signed the way the edge signs her head.
 *
 * The fixture is built by the MOUNTED seed-nostr-anchor organ (found through mirror/home/balls/HEAD.json, its bytes checked
 * against its specifier), given a NIP-01 id (SHA-256 of the serialised array) and a BIP-340 signature from @noble/curves,
 * the library the edge signs with (deploy/cloudflare/src/messages-store.mjs). `projectNostrMicroverse` must call it
 * verified, and must refuse a one-byte change to the content, to a tag, and to the signature, whether or not the id is
 * recomputed after the change. Nothing here opens a socket or a relay.
 * Run: node --test apps/web/src/spatial/superagent/__tests__/nostr-anchor-crosscheck.spec.ts (from the repository root).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { nip01EventId, projectNostrMicroverse } from '../nostr-microverse.ts'

interface Organ {
  checkpointTags: (args: Record<string, unknown>) => { ok: boolean; kind: number; created_at: number; tags: string[][]; content: string }
}
interface Event {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const ROOT = resolve(process.cwd())
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const head = JSON.parse(readFileSync(`${ROOT}/mirror/home/balls/HEAD.json`, 'utf8')) as { entries: Record<string, { specifier: string }> }
const organSha = (head.entries['seed-nostr-anchor']?.specifier ?? '').replace(/^ball:/, '')
const organCode = readFileSync(`${ROOT}/mirror/home/balls/${organSha}.js`, 'utf8')
const organ = ((): Organ => {
  const module = { exports: {} as Organ }
  // The organ is CommonJS text; this runs exactly its bytes, in a context of its own.
  runInNewContext(organCode, { module, exports: module.exports })
  return module.exports
})()

const SECRET = hexToBytes('3'.repeat(64))
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET))
const idOf = (event: Omit<Event, 'id' | 'sig'>): string =>
  sha256Hex(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))

/** The edge's signing, as messages-store.mjs signTurn does it: id first, BIP-340 over the id bytes, verified after. */
function edgeSigned(): Event {
  const built = organ.checkpointTags({ headBallId: '7a'.repeat(32), epoch: 171, receiptsLeafHash: '5c'.repeat(32), nodePubkeyHex: PUBKEY,
    createdAt: 1_794_400_000 })
  assert.equal(built.ok, true)
  const unsigned = { pubkey: PUBKEY, created_at: built.created_at, kind: built.kind, tags: built.tags, content: built.content }
  const id = idOf(unsigned)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), SECRET))
  assert.equal(schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(PUBKEY)), true)
  return { ...unsigned, id, sig }
}

/** Change one byte of a string at `at` (a hex digit stays hex, any other character becomes another one). */
function oneByte(value: string, at: number): string {
  const char = value[at] ?? ''
  const swapped = /[0-9a-f]/.test(char) ? (char === '0' ? '1' : '0') : char === 'a' ? 'b' : 'a'
  return `${value.slice(0, at)}${swapped}${value.slice(at + 1)}`
}

const verdict = async (event: unknown) => (await projectNostrMicroverse({ event, tier: 'microverse-local' }))

void test('HEAD points at the anchor organ by the SHA-256 of its exact bytes', () => {
  assert.match(organSha, /^[0-9a-f]{64}$/)
  assert.equal(sha256Hex(organCode), organSha)
})

void test('the page verifier accepts the head event the edge signs', async () => {
  const event = edgeSigned()
  assert.equal(await nip01EventId(event), event.id)
  const result = await verdict(event)
  assert.equal(result.idValid, true)
  assert.equal(result.signatureValid, true)
  assert.equal(result.signatureStatus, 'verified')
})

void test('a one-byte change to the content is refused, with or without a recomputed id', async () => {
  const event = edgeSigned()
  const at = event.content.indexOf('"epoch":171') + '"epoch":7'.length
  const content = oneByte(event.content, at)
  assert.notEqual(content, event.content)
  assert.equal(Buffer.byteLength(content), Buffer.byteLength(event.content))
  const stale = await verdict({ ...event, content })
  assert.equal(stale.signatureValid, false)
  assert.equal(stale.idValid, false)
  const rehashed = await verdict({ ...event, content, id: idOf({ ...event, content }) })
  assert.equal(rehashed.idValid, true)
  assert.equal(rehashed.signatureValid, false)
  assert.equal(rehashed.signatureStatus, 'invalid')
})

void test('a one-byte change to a tag is refused, with or without a recomputed id', async () => {
  const event = edgeSigned()
  const tags = event.tags.map(tag => (tag[0] === 'head' ? [tag[0], oneByte(tag[1] ?? '', 0)] : [...tag]))
  assert.notDeepEqual(tags, event.tags)
  const stale = await verdict({ ...event, tags })
  assert.equal(stale.signatureValid, false)
  assert.equal(stale.idValid, false)
  const rehashed = await verdict({ ...event, tags, id: idOf({ ...event, tags }) })
  assert.equal(rehashed.idValid, true)
  assert.equal(rehashed.signatureValid, false)
  assert.equal(rehashed.signatureStatus, 'invalid')
})

void test('a one-byte change to the signature is refused, wherever the byte is', async () => {
  const event = edgeSigned()
  for (const at of [0, 63, 64, 127]) {
    const sig = oneByte(event.sig, at)
    assert.notEqual(sig, event.sig)
    const result = await verdict({ ...event, sig })
    assert.equal(result.idValid, true)
    assert.equal(result.signatureValid, false, `signature byte at hex ${String(at)}`)
    assert.notEqual(result.signatureStatus, 'verified')
  }
})
