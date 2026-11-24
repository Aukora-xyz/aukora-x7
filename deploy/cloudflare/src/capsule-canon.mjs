// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE ONE CANONICAL FORM, `aukora.canon.v1` (CONTRACT.md draft 7, section 3, normative). The only JavaScript
 * file that turns capsule and act values into bytes, reads them back, or hashes them (section 3.7; the rule scan is
 * deploy/cloudflare/src/__tests__/capsule-rule.test.mjs).
 *
 * PURE ON PURPOSE: no import of any kind, no Node module, and no global but what both the Workers runtime and a browser
 * worker have (`crypto.subtle`). The platform JSON functions are never called: the grammar is the canonical form (D11),
 * so a text that is not canonical is not in the language and there is no lenient mode. Strings are printable ASCII
 * (D10); there is no Unicode normalisation anywhere.
 *
 * `parse` follows section 3.3 word for word; a refusal is a class and a byte position `at`, and the first failure wins:
 *   1. LIMIT at 262144 if the text is longer than 262,144 bytes.
 *   2. BYTE_RANGE at the first byte outside 0x20..0x7E, anywhere in the text.
 *   3. TYPE at 0 if the text is empty or its first byte is not `{`.
 *   4. The pass.
 *      At a value position: (a) a byte that cannot start a value, or the end of the text: SYNTAX there; (b) the node
 *        count, and for an array item the item count: LIMIT there; (c) `{` or `[` past depth 16: LIMIT there; (d) a
 *        literal that is not exactly `true`, `false`, `null` (also cut off by the end): SYNTAX at its first byte; (e) the
 *        maximal run of `0-9 A-Z a-z + - .` that is not an integer of the grammar within 9007199254740991: NUMBER at the
 *        run's first byte.
 *      In a string: LIMIT at the first byte of the 2,049th character, before that character is judged; a backslash not
 *        followed by `"` or `\`, also at the end of the text: SYNTAX at the backslash; no closing quote: SYNTAX at the
 *        text length.
 *      At a member position: (a) anything but `"`, or the end: SYNTAX there; (b) the member count: LIMIT at the opening
 *        quote; (c) KEY at the first byte that is neither a key byte nor the closing quote, at the 65th key byte, or at
 *        the closing quote of an empty key; the end inside the key: SYNTAX at the text length; (d) KEY_ORDER at the
 *        opening quote; (e) `:`, else SYNTAX there.
 *      After a value: `,` or the container's close, else SYNTAX there (the end: at the text length); after the root
 *        object, any byte is SYNTAX there.
 *
 * `encode` follows section 3.4: it refuses with a class only (no position). Domain: null, booleans, numbers, strings,
 * true arrays without holes (prototype Array.prototype, own keys exactly the indices and `length`), and plain objects
 * (prototype Object.prototype or none) read by their own enumerable string-keyed data properties, without the prototype
 * chain (`__proto__` and `constructor` are ordinary keys; a non-enumerable data property is not read). Classes: BYTE_RANGE
 * (a string character outside U+0020..U+007E), NUMBER (a number that is not a safe integer, or is negative zero: NaN and
 * the infinities included), KEY (a key outside the key grammar), LIMIT (any bound of 3.2; a cycle ends as LIMIT by
 * depth), TYPE (a root that is not an object, and everything else: undefined, functions, symbols, big integers, dates,
 * maps, typed arrays, class instances, boxed values, accessor properties, symbol keys, holes). Order: depth first; members
 * in ascending key order by direct emission; items in index order; a separator is produced before the next member's or
 * item's counts; at each value the counts and the depth before the value's own checks; the text length as each byte is
 * produced; the first failure wins.
 *
 * `digest(domain, bytes)` hashes whatever bytes it is given and never parses (3.5); `checkPresented` hashes the raw bytes
 * and compares first, and only then parses (3.6).
 */

/** The bounds of section 3.2, each in its counting unit. */
export const LIMITS = Object.freeze({
  textBytes: 262144,
  depth: 16,
  nodes: 20000,
  stringChars: 2048,
  arrayItems: 8192,
  objectMembers: 8192,
  keyBytes: 64,
  integerMagnitude: 9007199254740991,
})

/** The eight digest domains of section 3.5, a closed list. */
export const DOMAINS = Object.freeze({
  capsule: 'aukora.capsule.v1',
  state: 'aukora.capsule.state.v1',
  act: 'aukora.act.v1',
  facts: 'aukora.capsule-facts.v1',
  policy: 'aukora.capsule-policy.v0',
  proof: 'aukora.proof.v3',
  key: 'aukora.key.v1',
  lineage: 'aukora.act-lineage.v1',
})

/** The refusal classes of section 3.3, in check order. */
export const CLASSES = Object.freeze(['LIMIT', 'BYTE_RANGE', 'TYPE', 'NUMBER', 'KEY', 'KEY_ORDER', 'SYNTAX'])

/** The classes the encoder reports (section 3.4); it never reports KEY_ORDER or SYNTAX. */
export const ENCODE_CLASSES = Object.freeze(['BYTE_RANGE', 'NUMBER', 'KEY', 'LIMIT', 'TYPE'])

const DOMAIN_NAMES = Object.freeze(Object.values(DOMAINS))
const MAX_TEXT = LIMITS.textBytes
const MAX_DEPTH = LIMITS.depth
const MAX_NODES = LIMITS.nodes
const MAX_STRING = LIMITS.stringChars
const MAX_ITEMS = LIMITS.arrayItems
const MAX_MEMBERS = LIMITS.objectMembers
const MAX_KEY = LIMITS.keyBytes
const MAX_MAGNITUDE = '9007199254740991'
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/
const KEY_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/
const HEX = '0123456789abcdef'

/**
 * A parser refusal: `code` is the class, `at` the byte offset of section 3.3.
 * @param {string} code
 * @param {number} at
 * @param {string} detail
 * @returns {Error}
 */
function refusal(code, at, detail) {
  const error = new Error(`${code} at ${at}: ${detail}`)
  error.name = 'CanonRefusal'
  error.code = code
  error.at = at
  return error
}

const isDigit = byte => byte >= 0x30 && byte <= 0x39
const isKeyByte = byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || isDigit(byte) || byte === 0x5f || byte === 0x2e || byte === 0x3a || byte === 0x2d
const isRunByte = byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e
const startsValue = byte => byte === 0x7b || byte === 0x5b || byte === 0x22 || byte === 0x2d || isDigit(byte) || byte === 0x74 || byte === 0x66 || byte === 0x6e

/** An own, enumerable, writable data property, so `__proto__` is an ordinary key on a prototype-less object. */
function define(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** ASCII bytes to a string, in chunks small enough for any engine's argument limit. */
function ascii(bytes, start, end) {
  let text = ''
  for (let index = start; index < end; index += 4096) text += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(end, index + 4096)))
  return text
}

/** Whether a run of digits (with an optional leading `-`) is within the integer bound. */
function withinMagnitude(run) {
  const digits = run.charCodeAt(0) === 0x2d ? run.slice(1) : run
  return digits.length < MAX_MAGNITUDE.length || (digits.length === MAX_MAGNITUDE.length && digits <= MAX_MAGNITUDE)
}

/**
 * Parse one canonical text (section 3.3). Never calls the platform JSON parser.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown>} A prototype-less object; nested objects are prototype-less too.
 * @throws {Error} `code` is the refusal class, `at` the byte offset.
 */
export function parse(bytes) {
  if (!(bytes instanceof Uint8Array)) throw refusal('TYPE', 0, 'input is not a Uint8Array')
  const length = bytes.length
  if (length > MAX_TEXT) throw refusal('LIMIT', MAX_TEXT, 'text longer than 262144 bytes')
  for (let index = 0; index < length; index++) {
    const byte = bytes[index]
    if (byte < 0x20 || byte > 0x7e) throw refusal('BYTE_RANGE', index, 'byte outside 0x20..0x7E')
  }
  if (length === 0 || bytes[0] !== 0x7b) throw refusal('TYPE', 0, 'the text is not an object')
  let pos = 0
  let nodes = 1

  const end = () => refusal('SYNTAX', length, 'unexpected end of text')

  const parseString = () => {
    pos++ // the opening quote
    let chars = 0
    let text = ''
    let runStart = pos
    for (;;) {
      if (pos >= length) throw end()
      const byte = bytes[pos]
      if (byte === 0x22) {
        text += ascii(bytes, runStart, pos)
        pos++
        return text
      }
      chars++
      if (chars > MAX_STRING) throw refusal('LIMIT', pos, 'string longer than 2048 characters')
      if (byte === 0x5c) {
        // A backslash at the end of the text is judged as an escape: SYNTAX at the backslash (3.3).
        const next = pos + 1 < length ? bytes[pos + 1] : -1
        if (next !== 0x22 && next !== 0x5c) throw refusal('SYNTAX', pos, 'escape other than \\" and \\\\')
        text += ascii(bytes, runStart, pos) + (next === 0x22 ? '"' : '\\')
        pos += 2
        runStart = pos
      } else {
        pos++
      }
    }
  }

  const parseNumber = () => {
    const start = pos
    while (pos < length && isRunByte(bytes[pos])) pos++
    const run = ascii(bytes, start, pos)
    if (!INTEGER.test(run) || !withinMagnitude(run)) throw refusal('NUMBER', start, `not an integer of the grammar: ${run.slice(0, 32)}`)
    return Number(run)
  }

  const literal = (word, value) => {
    for (let index = 0; index < word.length; index++) {
      if (pos + index >= length || bytes[pos + index] !== word.charCodeAt(index)) throw refusal('SYNTAX', pos, 'not a literal of the grammar')
    }
    pos += word.length
    return value
  }

  /** The value at `pos`, inside a container of depth `depth`; the caller has checked that a value starts here. */
  const parseValue = depth => {
    nodes++
    if (nodes > MAX_NODES) throw refusal('LIMIT', pos, 'more than 20000 nodes')
    const byte = bytes[pos]
    if (byte === 0x7b || byte === 0x5b) {
      if (depth + 1 > MAX_DEPTH) throw refusal('LIMIT', pos, 'deeper than 16')
      return byte === 0x7b ? parseObject(depth + 1) : parseArray(depth + 1)
    }
    if (byte === 0x22) return parseString()
    if (byte === 0x2d || isDigit(byte)) return parseNumber()
    if (byte === 0x74) return literal('true', true)
    if (byte === 0x66) return literal('false', false)
    return literal('null', null)
  }

  /** The value position after `[`, `,` or `:`: a byte must be there and must be able to start a value. */
  const valueStart = () => {
    if (pos >= length) throw end()
    if (!startsValue(bytes[pos])) throw refusal('SYNTAX', pos, 'no value starts here')
  }

  const parseArray = depth => {
    pos++ // `[`
    const items = []
    if (pos >= length) throw end()
    if (bytes[pos] === 0x5d) { pos++; return items }
    for (;;) {
      valueStart()
      if (items.length + 1 > MAX_ITEMS) throw refusal('LIMIT', pos, 'more than 8192 items')
      items.push(parseValue(depth))
      if (pos >= length) throw end()
      const byte = bytes[pos]
      if (byte === 0x2c) { pos++; continue }
      if (byte === 0x5d) { pos++; return items }
      throw refusal('SYNTAX', pos, 'expected , or ]')
    }
  }

  const parseObject = depth => {
    pos++ // `{`
    const out = Object.create(null)
    if (pos >= length) throw end()
    if (bytes[pos] === 0x7d) { pos++; return out }
    let members = 0
    let previous = null
    for (;;) {
      if (pos >= length) throw end()
      if (bytes[pos] !== 0x22) throw refusal('SYNTAX', pos, 'expected a key')
      members++
      if (members > MAX_MEMBERS) throw refusal('LIMIT', pos, 'more than 8192 members')
      const keyStart = pos
      pos++
      for (;;) {
        if (pos >= length) throw end()
        const byte = bytes[pos]
        if (byte === 0x22) break
        if (!isKeyByte(byte)) throw refusal('KEY', pos, 'byte not allowed in a key')
        if (pos - keyStart > MAX_KEY) throw refusal('KEY', pos, 'key longer than 64 bytes')
        pos++
      }
      if (pos === keyStart + 1) throw refusal('KEY', pos, 'empty key')
      const key = ascii(bytes, keyStart + 1, pos)
      pos++ // the closing quote
      if (previous !== null && !(previous < key)) throw refusal('KEY_ORDER', keyStart, 'key not strictly greater than the previous key')
      previous = key
      if (pos >= length) throw end()
      if (bytes[pos] !== 0x3a) throw refusal('SYNTAX', pos, 'expected :')
      pos++
      valueStart()
      define(out, key, parseValue(depth))
      if (pos >= length) throw end()
      const byte = bytes[pos]
      if (byte === 0x2c) { pos++; continue }
      if (byte === 0x7d) { pos++; return out }
      throw refusal('SYNTAX', pos, 'expected , or }')
    }
  }

  const root = parseObject(1)
  if (pos !== length) throw refusal('SYNTAX', pos, 'bytes after the root object')
  return root
}

const pathOf = (path, key) => `${path}/${key}`

/**
 * An encoder refusal: a class only (section 3.4 compares no position); `path` says where in the value, for people.
 * @param {string} code
 * @param {string} detail
 * @param {string} path
 * @returns {Error}
 */
function encodeRefusal(code, detail, path) {
  const error = new Error(`${code}: ${detail} (${path || 'root'})`)
  error.name = 'CanonRefusal'
  error.code = code
  error.path = path
  return error
}

/** A plain object of the domain: prototype Object.prototype or none, never an array. */
function plainObject(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const prototype = Object.getPrototypeOf(candidate)
  return prototype === null || prototype === Object.prototype
}

/**
 * Encode one host value as its canonical text (section 3.4). Never calls the platform JSON serialiser.
 * @param {unknown} value An object (the root must be one).
 * @returns {Uint8Array}
 * @throws {Error} `code` is the refusal class (no position), `path` where in the value.
 */
export function encode(value) {
  const parts = []
  let size = 0
  let nodes = 1
  /** Produce bytes; the text length is checked as they are produced. */
  const emit = (text, path) => {
    if (size + text.length > MAX_TEXT) throw encodeRefusal('LIMIT', 'text longer than 262144 bytes', path)
    size += text.length
    parts.push(text)
  }

  /** The node count of one member value or array item (3.2), checked before the value's own checks (3.4 order). */
  const countNode = path => {
    nodes++
    if (nodes > MAX_NODES) throw encodeRefusal('LIMIT', 'more than 20000 nodes', path)
  }

  /**
   * The members of a plain object in the order 3.4 reaches them: own enumerable string-keyed data members in byte order
   * of the key (never insertion order, which puts integer-like keys first; keys compare as UTF-16 code units, which is
   * byte order for the key grammar, and any other key is refused when it is reached), then every symbol key. An accessor
   * (enumerable or not) keeps its key's place and a symbol key comes after every string key: each is a TYPE refusal
   * DEFERRED to the moment its member is reached, so an earlier member's failure wins (first failure wins). A non-
   * enumerable data member is not read (it is not part of the value). A getter is never run.
   */
  const ownMembers = object => {
    const members = []
    const symbols = []
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
      if (typeof key === 'symbol') symbols.push({ key, refused: 'symbol key' })
      else if (!('value' in descriptor)) members.push({ key, refused: 'accessor property' })
      else if (descriptor.enumerable) members.push({ key, value: descriptor.value })
    }
    members.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    return members.concat(symbols)
  }

  const encodeString = (text, path) => {
    // The opening quote, then each character: the string count, its byte range, then its bytes; then the closing quote.
    emit('"', path)
    let out = ''
    let pending = size
    for (let index = 0; index < text.length; index++) {
      if (index >= MAX_STRING) throw encodeRefusal('LIMIT', 'string longer than 2048 characters', path)
      const code = text.charCodeAt(index)
      if (code < 0x20 || code > 0x7e) throw encodeRefusal('BYTE_RANGE', 'character outside 0x20..0x7E', path)
      const piece = code === 0x22 ? '\\"' : code === 0x5c ? '\\\\' : text[index]
      if (pending + piece.length > MAX_TEXT) throw encodeRefusal('LIMIT', 'text longer than 262144 bytes', path)
      pending += piece.length
      out += piece
    }
    emit(out, path)
    emit('"', path)
  }

  const encodeObject = (object, depth, path) => {
    const members = ownMembers(object)
    emit('{', path)
    for (let index = 0; index < members.length; index++) {
      const { key, value, refused } = members[index]
      if (index) emit(',', path)
      if (index >= MAX_MEMBERS) throw encodeRefusal('LIMIT', 'more than 8192 members', path)
      if (typeof key === 'symbol') throw encodeRefusal('TYPE', refused, path)
      if (!KEY_TEXT.test(key)) throw encodeRefusal('KEY', 'key outside the key grammar', pathOf(path, key))
      emit(`"${key}":`, path)
      if (refused) {
        // An accessor sits where its value would: the count first, then its own check (3.4 order).
        countNode(pathOf(path, key))
        throw encodeRefusal('TYPE', refused, pathOf(path, key))
      }
      encodeValue(value, depth, pathOf(path, key))
    }
    emit('}', path)
  }

  /** An array index key: the canonical decimal spelling of an integer below the array's length. */
  const isIndexKey = (key, length) => typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length

  const encodeArray = (array, depth, path) => {
    // A true array: Array.prototype, and no own member but its indices and `length` (the array's own checks, before
    // its items). A hole or an accessor item is refused when its index is reached, in index order (3.4).
    if (Object.getPrototypeOf(array) !== Array.prototype) throw encodeRefusal('TYPE', 'not a true array', path)
    for (const key of Reflect.ownKeys(array)) {
      if (key !== 'length' && !isIndexKey(key, array.length)) throw encodeRefusal('TYPE', 'array with an extra member', path)
    }
    emit('[', path)
    for (let index = 0; index < array.length; index++) {
      if (index) emit(',', path)
      if (index >= MAX_ITEMS) throw encodeRefusal('LIMIT', 'more than 8192 items', path)
      const descriptor = Reflect.getOwnPropertyDescriptor(array, index)
      if (!descriptor || !('value' in descriptor)) {
        countNode(pathOf(path, index))
        throw encodeRefusal('TYPE', descriptor ? 'accessor property' : 'array with a hole', pathOf(path, index))
      }
      encodeValue(descriptor.value, depth, pathOf(path, index))
    }
    emit(']', path)
  }

  /** A member value or an array item inside a container of depth `depth`: the count, then the depth, then its checks. */
  const encodeValue = (item, depth, path) => {
    countNode(path)
    if (item === null) return emit('null', path)
    if (item === true) return emit('true', path)
    if (item === false) return emit('false', path)
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw encodeRefusal('NUMBER', 'not a safe integer, or negative zero', path)
      return emit(String(item), path)
    }
    if (typeof item === 'string') return encodeString(item, path)
    if (Array.isArray(item)) {
      if (depth + 1 > MAX_DEPTH) throw encodeRefusal('LIMIT', 'deeper than 16', path)
      return encodeArray(item, depth + 1, path)
    }
    if (plainObject(item)) {
      if (depth + 1 > MAX_DEPTH) throw encodeRefusal('LIMIT', 'deeper than 16', path)
      return encodeObject(item, depth + 1, path)
    }
    throw encodeRefusal('TYPE', `not a value of the profile (${typeof item})`, path)
  }

  if (!plainObject(value)) throw encodeRefusal('TYPE', 'the root is not an object', '')
  encodeObject(value, 1, '')
  const text = parts.join('')
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index)
  return out
}

/** A refusal of the digest functions themselves (not a canon class): DOMAIN, DIGEST, or TYPE for an input. */
function digestRefusal(code, detail) {
  const error = new Error(`${code}: ${detail}`)
  error.name = 'CanonRefusal'
  error.code = code
  return error
}

/**
 * `ascii(domain) || 0x00 || bytes` (section 3.5): the message every digest hashes, and the exact bytes an act key signs
 * for `aukora.proof.v3` (section 6.4). The bytes are never parsed here.
 * @param {string} domain One of DOMAINS.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function domainMessage(domain, bytes) {
  if (!DOMAIN_NAMES.includes(domain)) throw digestRefusal('DOMAIN', `not one of the eight digest domains: ${String(domain).slice(0, 64)}`)
  if (!(bytes instanceof Uint8Array)) throw digestRefusal('TYPE', 'input is not a Uint8Array')
  const message = new Uint8Array(domain.length + 1 + bytes.length)
  for (let index = 0; index < domain.length; index++) message[index] = domain.charCodeAt(index)
  message[domain.length] = 0x00
  message.set(bytes, domain.length + 1)
  return message
}

function toHex(digestBytes) {
  const view = digestBytes instanceof Uint8Array ? digestBytes : new Uint8Array(digestBytes)
  if (view.length !== 32) throw digestRefusal('DIGEST', 'a sha256 is 32 bytes')
  let hex = ''
  for (const byte of view) hex += HEX[byte >> 4] + HEX[byte & 15]
  return hex
}

function syncHex(result) {
  if (typeof result === 'string') {
    if (!/^[0-9a-f]{64}$/.test(result)) throw digestRefusal('DIGEST', 'a sha256 is 64 lowercase hex digits')
    return result
  }
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) return toHex(result)
  throw digestRefusal('DIGEST', 'the injected sha256 returned neither bytes nor hex')
}

/**
 * `sha256(ascii(domain) || 0x00 || bytes)`, lowercase hex (section 3.5). Hashes whatever bytes it is given; never parses.
 * @param {string} domain One of DOMAINS.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function digest(domain, bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', domainMessage(domain, bytes)))
}

/**
 * The same digest with an injected synchronous sha256 (for a runtime that cannot await). Never parses.
 * @param {string} domain
 * @param {Uint8Array} bytes
 * @param {(message: Uint8Array) => Uint8Array | ArrayBuffer | string} sha256
 * @returns {string}
 */
export function digestSync(domain, bytes, sha256) {
  if (typeof sha256 !== 'function') throw digestRefusal('DIGEST', 'no sha256 was injected')
  return syncHex(sha256(domainMessage(domain, bytes)))
}

/**
 * The plain sha256 of an artifact's raw bytes, labelled `sha256-raw` in a record (section 3.5: an artifact carried from
 * elsewhere keeps its own identity and is never re-serialised).
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function rawSha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw digestRefusal('TYPE', 'input is not a Uint8Array')
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Bytes presented under an id (section 3.6). The digest of the RAW bytes is compared first: a mismatch is
 * CAPSULE_BYTES_MISMATCH whatever the bytes are, and they are not parsed. Bytes that match their id are then parsed and
 * may still be refused by their own class (`code` is the class, `at` its position). Valid bytes with their own correct id
 * are simply another text.
 * @param {string} domain
 * @param {Uint8Array} bytes
 * @param {string} id
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: string, id: string, at?: number }>}
 */
export async function checkPresented(domain, bytes, id) {
  const actual = await digest(domain, bytes)
  if (actual !== id) return { ok: false, code: 'CAPSULE_BYTES_MISMATCH', id: actual }
  try {
    parse(bytes)
  } catch (error) {
    if (!CLASSES.includes(error?.code)) throw error
    return { ok: false, code: error.code, at: error.at, id: actual }
  }
  return { ok: true, id: actual }
}
