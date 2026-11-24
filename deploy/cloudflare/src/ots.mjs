/**
 * THE OPENTIMESTAMPS PROOF FORMAT. Pure: no storage, no network, no clock. The format as the reference client and
 * server write it (python-opentimestamps core/serialize.py, op.py, notary.py, timestamp.py; read for the lane's research):
 *
 *  - A detached proof (`.ots`): the 31-byte magic, the major version 01, the file-hash op 08 (SHA-256), the 32-byte
 *    digest, then one timestamp tree, then nothing.
 *  - Varuint: little-endian base 128, the high bit means "more", at most 9 bytes; varbytes = varuint length + bytes.
 *  - A tree node is one or more children; every child but the last is preceded by ff (the fork rule). A child is an
 *    attestation (00, an 8-byte tag, varbytes payload) or an op (its tag, its argument if it has one, then the node it
 *    leads to). Ops: append f0 and prepend f1 (varbytes argument), sha1 02, ripemd160 03, sha256 08, keccak256 67,
 *    reverse f2, hexlify f3. Attestations: pending 83dfe30d2ef90c8e (payload varbytes(uri)), Bitcoin 0588960d73d71901
 *    (payload varuint(height)); any other tag is kept as opaque bytes and written back unchanged.
 *  - Children keep the order they were read in, so parse then serialize gives back the input byte for byte.
 *
 * Executing ops (the message at each node): sha256, sha1 (WebCrypto), append, prepend, reverse and hexlify run here.
 * ripemd160 and keccak256 are not in WebCrypto and no hash library resolves from this folder, so they run only when the
 * caller injects them (`hashes: { ripemd160, keccak256 }`); otherwise the computation refuses OTS_OP_UNAVAILABLE.
 *
 * Every refusal is an Error whose `code` is one of OTS_CODES; no other error ever leaves an exported function.
 */

export const OTS_LIMITS = Object.freeze({
  proofBytes: 16 * 1024, replyBytes: 10000, uriChars: 1000, depth: 256, nodes: 1024, argBytes: 4096, messageBytes: 4096,
  payloadBytes: 8192, varuintBytes: 9, calendarTrees: 8,
})
export const OTS_CODES = Object.freeze([
  'OTS_INPUT_INVALID', 'OTS_TRUNCATED', 'OTS_TRAILING_BYTES', 'OTS_HEADER_INVALID', 'OTS_VERSION_UNSUPPORTED',
  'OTS_FILE_HASH_UNSUPPORTED', 'OTS_PROOF_LIMIT', 'OTS_DEPTH_LIMIT', 'OTS_NODE_LIMIT', 'OTS_OP_UNKNOWN', 'OTS_OP_UNAVAILABLE',
  'OTS_ARG_LIMIT', 'OTS_MESSAGE_LIMIT', 'OTS_PAYLOAD_LIMIT', 'OTS_VARUINT_INVALID', 'OTS_URI_INVALID', 'OTS_ATTESTATION_INVALID',
  'OTS_COMMITMENT_NOT_FOUND', 'OTS_MALFORMED',
])
export const OTS_HEADER = Object.freeze([0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94])
export const OTS_PENDING_TAG = '83dfe30d2ef90c8e'
export const OTS_BITCOIN_TAG = '0588960d73d71901'
export const OTS_OPS = Object.freeze({ sha1: 0x02, ripemd160: 0x03, sha256: 0x08, keccak256: 0x67, append: 0xf0, prepend: 0xf1, reverse: 0xf2, hexlify: 0xf3 })

const VERSION = 0x01
const FILE_HASH_SHA256 = 0x08
const ATTESTATION = 0x00
const FORK = 0xff
const BINARY_OPS = new Set([OTS_OPS.append, OTS_OPS.prepend])
const UNARY_OPS = new Set([OTS_OPS.sha1, OTS_OPS.ripemd160, OTS_OPS.sha256, OTS_OPS.keccak256, OTS_OPS.reverse, OTS_OPS.hexlify])
const URI_RE = /^[A-Za-z0-9.\-_/:]{1,1000}$/
const CODES = new Set(OTS_CODES)

const refuse = code => { throw Object.assign(new Error(code), { code }) }
/** Run `operation`; any error that is not already a closed OTS refusal becomes OTS_MALFORMED. */
function closed(operation) {
  try {
    const result = operation()
    return result instanceof Promise ? result.catch(error => { throw closedError(error) }) : result
  } catch (error) { throw closedError(error) }
}
const closedError = error => CODES.has(error?.code) ? error : Object.assign(new Error('OTS_MALFORMED'), { code: 'OTS_MALFORMED' })

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = text => {
  if (typeof text !== 'string' || text.length % 2 || !/^[0-9a-f]*$/.test(text)) refuse('OTS_INPUT_INVALID')
  return Uint8Array.from(text.match(/../g) ?? [], pair => Number.parseInt(pair, 16))
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}
const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index])
const bytesInput = value => {
  if (!(value instanceof Uint8Array)) refuse('OTS_INPUT_INVALID')
  return value
}

/** varuint(value): little-endian base 128. */
export function encodeVaruint(value) {
  return closed(() => {
    if (!Number.isSafeInteger(value) || value < 0) refuse('OTS_INPUT_INVALID')
    const out = []
    do {
      let byte = value % 128
      value = Math.floor(value / 128)
      if (value) byte |= 0x80
      out.push(byte)
    } while (value)
    return Uint8Array.from(out)
  })
}
/** varbytes(bytes) = varuint(length) || bytes. */
export const encodeVarbytes = bytes => closed(() => concat(encodeVaruint(bytesInput(bytes).length), bytes))

/** A bounded reader over one byte array; reading past its end refuses OTS_TRUNCATED. */
function reader(bytes, { truncated = 'OTS_TRUNCATED' } = {}) {
  let offset = 0
  const take = count => {
    if (offset + count > bytes.length) refuse(truncated)
    const out = bytes.subarray(offset, offset + count)
    offset += count
    return out
  }
  return {
    get offset() { return offset },
    atEnd: () => offset === bytes.length,
    byte: () => take(1)[0],
    bytes: take,
    varuint() {
      let value = 0, scale = 1
      for (let index = 0; ; index++) {
        if (index >= OTS_LIMITS.varuintBytes) refuse('OTS_VARUINT_INVALID')
        const byte = take(1)[0]
        value += (byte & 0x7f) * scale
        scale *= 128
        if (!(byte & 0x80)) {
          // Only the shortest form: a later byte of zero would not write back the same bytes.
          if (index > 0 && byte === 0) refuse('OTS_VARUINT_INVALID')
          break
        }
      }
      if (!Number.isSafeInteger(value)) refuse('OTS_VARUINT_INVALID')
      return value
    },
    varbytes(limit, code) {
      const length = this.varuint()
      if (length > limit) refuse(code)
      return take(length)
    },
  }
}

function attestationFrom(tagBytes, payload) {
  const tag = toHex(tagBytes)
  if (tag === OTS_PENDING_TAG) {
    let uri
    try {
      const inner = reader(payload, { truncated: 'OTS_URI_INVALID' })
      const raw = inner.varbytes(OTS_LIMITS.uriChars, 'OTS_URI_INVALID')
      if (!inner.atEnd()) refuse('OTS_URI_INVALID')
      uri = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch (_error) { refuse('OTS_URI_INVALID') }
    if (!URI_RE.test(uri)) refuse('OTS_URI_INVALID')
    return { kind: 'attestation', tag, payload, uri }
  }
  if (tag === OTS_BITCOIN_TAG) {
    let height
    try {
      const inner = reader(payload, { truncated: 'OTS_ATTESTATION_INVALID' })
      height = inner.varuint()
      if (!inner.atEnd()) refuse('OTS_ATTESTATION_INVALID')
    } catch (_error) { refuse('OTS_ATTESTATION_INVALID') }
    return { kind: 'attestation', tag, payload, height }
  }
  return { kind: 'attestation', tag, payload }
}

/** One node read from `r`: its children in order (the fork rule), each op leading to its own node. */
function readNode(r, depth, budget) {
  if (depth > OTS_LIMITS.depth) refuse('OTS_DEPTH_LIMIT')
  const children = []
  let tag = r.byte()
  while (tag === FORK) {
    children.push(readChild(r, r.byte(), depth, budget))
    tag = r.byte()
  }
  children.push(readChild(r, tag, depth, budget))
  return { children }
}
function readChild(r, tag, depth, budget) {
  if (++budget.nodes > OTS_LIMITS.nodes) refuse('OTS_NODE_LIMIT')
  if (tag === ATTESTATION) {
    const tagBytes = r.bytes(8)
    return attestationFrom(tagBytes, r.varbytes(OTS_LIMITS.payloadBytes, 'OTS_PAYLOAD_LIMIT'))
  }
  if (BINARY_OPS.has(tag)) {
    const arg = r.varbytes(OTS_LIMITS.argBytes, 'OTS_ARG_LIMIT')
    return { kind: 'op', tag, arg, node: readNode(r, depth + 1, budget) }
  }
  if (UNARY_OPS.has(tag)) return { kind: 'op', tag, node: readNode(r, depth + 1, budget) }
  refuse('OTS_OP_UNKNOWN')
}

function writeNode(node, out, depth = 0) {
  if (depth > OTS_LIMITS.depth) refuse('OTS_DEPTH_LIMIT')
  if (!node || !Array.isArray(node.children) || node.children.length === 0) refuse('OTS_INPUT_INVALID')
  node.children.forEach((child, index) => {
    if (index < node.children.length - 1) out.push(Uint8Array.of(FORK))
    if (child?.kind === 'attestation') {
      out.push(Uint8Array.of(ATTESTATION), fromHex(child.tag), encodeVarbytes(child.payload))
    } else if (child?.kind === 'op' && BINARY_OPS.has(child.tag)) {
      out.push(Uint8Array.of(child.tag), encodeVarbytes(child.arg))
      writeNode(child.node, out, depth + 1)
    } else if (child?.kind === 'op' && UNARY_OPS.has(child.tag)) {
      out.push(Uint8Array.of(child.tag))
      writeNode(child.node, out, depth + 1)
    } else refuse('OTS_INPUT_INVALID')
  })
}

/** A bare timestamp tree (a calendar's reply: no header), read to its end. At most OTS_LIMITS.replyBytes. */
export function parseTree(bytes) {
  return closed(() => {
    bytesInput(bytes)
    if (bytes.length > OTS_LIMITS.replyBytes) refuse('OTS_PROOF_LIMIT')
    const r = reader(bytes)
    const node = readNode(r, 0, { nodes: 0 })
    if (!r.atEnd()) refuse('OTS_TRAILING_BYTES')
    return node
  })
}

/** The bytes of a tree node. */
export function serializeTree(node) {
  return closed(() => {
    const out = []
    writeNode(node, out)
    return concat(...out)
  })
}

/** A detached proof: `{ digest, tree }`. At most OTS_LIMITS.proofBytes; only the SHA-256 file hash. */
export function parseOts(bytes) {
  return closed(() => {
    bytesInput(bytes)
    if (bytes.length > OTS_LIMITS.proofBytes) refuse('OTS_PROOF_LIMIT')
    const r = reader(bytes)
    if (!sameBytes(r.bytes(Math.min(OTS_HEADER.length, bytes.length) || 1), OTS_HEADER)) {
      refuse(bytes.length < OTS_HEADER.length ? 'OTS_TRUNCATED' : 'OTS_HEADER_INVALID')
    }
    if (r.byte() !== VERSION) refuse('OTS_VERSION_UNSUPPORTED')
    if (r.byte() !== FILE_HASH_SHA256) refuse('OTS_FILE_HASH_UNSUPPORTED')
    const digest = new Uint8Array(r.bytes(32))
    const tree = readNode(r, 0, { nodes: 0 })
    if (!r.atEnd()) refuse('OTS_TRAILING_BYTES')
    return { digest, tree }
  })
}

/** The bytes of a detached proof. */
export function serializeOts(ots) {
  return closed(() => {
    if (!(ots?.digest instanceof Uint8Array) || ots.digest.length !== 32) refuse('OTS_INPUT_INVALID')
    const out = [Uint8Array.from(OTS_HEADER), Uint8Array.of(VERSION, FILE_HASH_SHA256), ots.digest]
    writeNode(ots.tree, out)
    const bytes = concat(...out)
    if (bytes.length > OTS_LIMITS.proofBytes) refuse('OTS_PROOF_LIMIT')
    return bytes
  })
}

const asProof = ots => ots instanceof Uint8Array ? parseOts(ots) : ots
const asTree = tree => tree instanceof Uint8Array ? parseTree(tree) : (Array.isArray(tree?.children) ? tree : refuse('OTS_INPUT_INVALID'))

/**
 * One node holding the children of all `nodes`, in first-seen order, merged recursively: op children with the same tag
 * (and, for append/prepend, the same argument) become ONE op child leading to the union of their nodes, so no node ever
 * has two sibling children with the same op (the reference reader keys a node's ops by op and would keep only one);
 * attestation children are kept once each, by their bytes. The inputs are never changed.
 */
function unionNode(nodes, depth = 0) {
  if (depth > OTS_LIMITS.depth) refuse('OTS_DEPTH_LIMIT')
  const children = [], ops = new Map(), seen = new Set()
  for (const node of nodes) for (const child of node.children) {
    if (child?.kind === 'op') {
      const key = BINARY_OPS.has(child.tag) ? `${child.tag}:${toHex(child.arg)}` : String(child.tag)
      const group = ops.get(key)
      if (group) { group.nodes.push(child.node); continue }
      const merged = { ...child, nodes: [child.node] }
      ops.set(key, merged)
      children.push(merged)
      continue
    }
    const key = toHex(serializeTree({ children: [child] }))
    if (seen.has(key)) continue
    seen.add(key)
    children.push(child)
  }
  return { children: children.map(child => {
    if (child.kind !== 'op') return child
    const { nodes: group, ...op } = child
    return { ...op, node: group.length === 1 ? group[0] : unionNode(group, depth + 1) }
  }) }
}

/** sha256(digest || nonce): the 32 bytes the reference client submits to a calendar (the nonce blinds the digest). */
export async function stampCommitment(digest32, nonce16) {
  return closed(async () => {
    if (!(digest32 instanceof Uint8Array) || digest32.length !== 32 || !(nonce16 instanceof Uint8Array) || nonce16.length !== 16) refuse('OTS_INPUT_INVALID')
    return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(digest32, nonce16)))
  })
}

/**
 * The `.ots` bytes for `digest32`, blinded by `nonce16` as the reference client does: header, 01, 08, digest, f0 10 nonce,
 * 08, then the calendars' trees merged into one node (the union of their children, written by the fork rule).
 * @param {Uint8Array} digest32 The digest stamped.
 * @param {Uint8Array} nonce16 The nonce appended before the SHA-256 that was submitted.
 * @param {Array<Uint8Array|object>} calendarTrees Each calendar's reply (bytes or a parsed node), in calendar order.
 */
export function buildDetached(digest32, nonce16, calendarTrees) {
  return closed(() => {
    if (!(digest32 instanceof Uint8Array) || digest32.length !== 32 || !(nonce16 instanceof Uint8Array) || nonce16.length !== 16
      || !Array.isArray(calendarTrees) || calendarTrees.length < 1 || calendarTrees.length > OTS_LIMITS.calendarTrees) refuse('OTS_INPUT_INVALID')
    const merged = unionNode(calendarTrees.map(asTree))
    const tree = { children: [{ kind: 'op', tag: OTS_OPS.append, arg: new Uint8Array(nonce16), node: { children: [{ kind: 'op', tag: OTS_OPS.sha256, node: merged }] } }] }
    return serializeOts({ digest: new Uint8Array(digest32), tree })
  })
}

async function runOp(child, message, hashes) {
  let out
  switch (child.tag) {
    case OTS_OPS.append: out = concat(message, child.arg); break
    case OTS_OPS.prepend: out = concat(child.arg, message); break
    case OTS_OPS.sha256: out = new Uint8Array(await crypto.subtle.digest('SHA-256', message)); break
    case OTS_OPS.sha1: out = new Uint8Array(await crypto.subtle.digest('SHA-1', message)); break
    case OTS_OPS.reverse: out = Uint8Array.from(message).reverse(); break
    case OTS_OPS.hexlify: out = new TextEncoder().encode(toHex(message)); break
    case OTS_OPS.ripemd160: case OTS_OPS.keccak256: {
      const run = hashes?.[child.tag === OTS_OPS.ripemd160 ? 'ripemd160' : 'keccak256']
      if (typeof run !== 'function') refuse('OTS_OP_UNAVAILABLE')
      out = await run(message)
      if (!(out instanceof Uint8Array) || out.length !== (child.tag === OTS_OPS.ripemd160 ? 20 : 32)) refuse('OTS_OP_UNAVAILABLE')
      out = new Uint8Array(out)
      break
    }
    default: refuse('OTS_OP_UNKNOWN')
  }
  if (out.length > OTS_LIMITS.messageBytes) refuse('OTS_MESSAGE_LIMIT')
  return out
}

/** Visit every node with the message at it (depth first, children in order). */
async function walk(node, message, hashes, visit) {
  const stack = [{ node, message }]
  while (stack.length) {
    const { node: current, message: at } = stack.pop()
    visit(current, at)
    const next = []
    for (const child of current.children) if (child.kind === 'op') next.push({ node: child.node, message: await runOp(child, at, hashes) })
    stack.push(...next.reverse())
  }
}

/**
 * Each pending attestation in the proof: its calendar URI and the commitment to ask it about (the lower-case hex of the
 * message at the node holding it), in tree order.
 */
export async function pendingLeaves(ots, { hashes } = {}) {
  return closed(async () => {
    const proof = asProof(ots), found = []
    await walk(proof.tree, proof.digest, hashes, (node, message) => {
      for (const child of node.children) if (child.kind === 'attestation' && child.tag === OTS_PENDING_TAG) found.push({ uri: child.uri, commitment: toHex(message) })
    })
    return found
  })
}

/** Each Bitcoin attestation: its block height and the message at its node (the block's merkle root, header byte order). */
export async function bitcoinAttestations(ots, { hashes } = {}) {
  return closed(async () => {
    const proof = asProof(ots), found = []
    await walk(proof.tree, proof.digest, hashes, (node, message) => {
      for (const child of node.children) if (child.kind === 'attestation' && child.tag === OTS_BITCOIN_TAG) found.push({ height: child.height, merkleRoot: toHex(message) })
    })
    return found
  })
}

/** Whether a tree holds a Bitcoin attestation anywhere (structure only; no op is executed). */
export function treeHasBitcoin(tree) {
  return closed(() => {
    const stack = [asTree(tree)]
    while (stack.length) for (const child of stack.pop().children) {
      if (child.kind === 'attestation' && child.tag === OTS_BITCOIN_TAG) return true
      if (child.kind === 'op') stack.push(child.node)
    }
    return false
  })
}

/** The Bitcoin heights a tree holds (structure only), lowest first. */
export function treeBitcoinHeights(tree) {
  return closed(() => {
    const heights = [], stack = [asTree(tree)]
    while (stack.length) for (const child of stack.pop().children) {
      if (child.kind === 'attestation' && child.tag === OTS_BITCOIN_TAG) heights.push(child.height)
      if (child.kind === 'op') stack.push(child.node)
    }
    return heights.sort((a, b) => a - b)
  })
}

/** Whether a tree holds a pending attestation anywhere (structure only). */
export function treeHasPending(tree) {
  return closed(() => {
    const stack = [asTree(tree)]
    while (stack.length) for (const child of stack.pop().children) {
      if (child.kind === 'attestation' && child.tag === OTS_PENDING_TAG) return true
      if (child.kind === 'op') stack.push(child.node)
    }
    return false
  })
}

/**
 * Splice a calendar's upgrade into the proof where the pending leaf for `commitment` was: at every node whose message is
 * `commitment` and that holds a pending attestation, the pending attestations are removed and the upgrade tree's children
 * are added (each distinct child once). The upgrade tree starts from `commitment`, as a calendar's GET answer does.
 * @returns {Promise<Uint8Array>} The new `.ots` bytes.
 */
export async function spliceUpgrade(ots, commitment, tree, { hashes } = {}) {
  return closed(async () => {
    const proof = asProof(ots), upgrade = asTree(tree)
    if (typeof commitment !== 'string' || !/^[0-9a-f]{2,8192}$/.test(commitment)) refuse('OTS_INPUT_INVALID')
    const targets = []
    await walk(proof.tree, proof.digest, hashes, (node, message) => {
      if (toHex(message) === commitment && node.children.some(child => child.kind === 'attestation' && child.tag === OTS_PENDING_TAG)) targets.push(node)
    })
    if (!targets.length) refuse('OTS_COMMITMENT_NOT_FOUND')
    for (const node of targets) {
      const kept = node.children.filter(child => !(child.kind === 'attestation' && child.tag === OTS_PENDING_TAG))
      node.children = unionNode([{ children: kept }, upgrade]).children
    }
    return serializeOts(proof)
  })
}
