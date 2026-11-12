/**
 * In-memory stand-ins for the rescue kit's three outsides, exports only (no test here): a later job imports them to run
 * the real kit against the vault's real handler.
 *  - FakeIndexedDb: one factory that records every open, every transaction (with its mode) and every request; `open`
 *    without a version creates a version 1 database with no store unless its upgrade is aborted, as a browser does.
 *    Every open gives its OWN connection over the shared database, so one close() closes only that connection (her tab
 *    and the kit can be open side by side), and a version change is told to every open connection. `hooks.hold` makes a
 *    request that never answers; a transaction aborted by anyone is marked `aborted` in the log.
 *  - FakeLocalStorage: records every write.
 *  - fakeFsFromEntries: the worker file system face (`readdirSync`, `statSync`, `readFileSync`), read-only.
 *  - createFakeVault: the `/_vault/*` routes as strict as the real edge: it stores BYTES, refuses (400) an index row that
 *    breaks the row rule, an index whose id is not its hash, and a verify call with no or an unknown `cursor`.
 * @module rescue-fakes
 */
import { createHash } from 'node:crypto'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const keyOrder = (a, b) => {
  const [x, y] = [typeof a === 'string', typeof b === 'string']
  if (x !== y) return x ? 1 : -1
  return a < b ? -1 : a > b ? 1 : 0
}
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

class FakeRequest {
  result = undefined
  error = null
  transaction = null
  onsuccess = null
  onerror = null
  onupgradeneeded = null
  onblocked = null
}

class FakeTx {
  constructor(db, storeName, mode, entry) {
    Object.assign(this, { db, storeName, mode, entry, pending: 0, finished: false, error: null, oncomplete: null, onabort: null, onerror: null })
    this.settle()
  }
  objectStore(name) {
    if (name !== this.storeName || !this.db.stores.has(name)) throw new DOMException('no such store', 'NotFoundError')
    return new FakeObjectStore(this, name)
  }
  run(method, key, work) {
    if (this.finished) throw new DOMException('transaction finished', 'TransactionInactiveError')
    const factory = this.db.factory
    this.entry.requests.push(method)
    const count = factory.log.requests.filter(request => request.method === method).length + 1
    factory.log.requests.push({ method, key, mode: this.mode })
    const request = new FakeRequest()
    this.pending += 1
    // `hooks.hold(method, key, tx)` true: this request is never answered (a stuck read); only an abort ends its transaction.
    if (factory.hooks.hold && factory.hooks.hold(method, key, this)) { this.entry.held = true; return request }
    setTimeout(() => {
      this.pending -= 1
      if (this.finished) return
      try { if (factory.hooks.beforeRequest) factory.hooks.beforeRequest(method, key, count, this.db) } catch (error) { /* a hook never breaks the store */ }
      try { request.result = work(this.db.stores.get(this.storeName)); request.onsuccess?.({ target: request }) } catch (error) {
        request.error = error; request.onerror?.({ target: request }); this.abort(error); return
      }
      this.settle()
    }, 0)
    return request
  }
  settle() {
    setTimeout(() => {
      if (this.finished || this.pending > 0) return
      this.finished = true
      this.oncomplete?.({ target: this })
    }, 0)
  }
  abort(error) {
    if (this.finished) return
    this.finished = true
    this.entry.aborted = true
    this.error = error ?? new DOMException('aborted', 'AbortError')
    setTimeout(() => { this.onabort?.({ target: this }) }, 0)
  }
}

class FakeObjectStore {
  constructor(tx, name) { this.tx = tx; this.name = name }
  #write(method, key, work) {
    if (this.tx.mode === 'readonly') {
      this.tx.db.factory.log.requests.push({ method, key, mode: this.tx.mode, refused: true })
      throw new DOMException('read-only transaction', 'ReadOnlyError')
    }
    return this.tx.run(method, key, work)
  }
  get(key) { return this.tx.run('get', key, data => (data.has(key) ? structuredClone(data.get(key)) : undefined)) }
  getAllKeys() { return this.tx.run('getAllKeys', null, data => Array.from(data.keys()).sort(keyOrder)) }
  getAll() { return this.tx.run('getAll', null, data => Array.from(data.keys()).sort(keyOrder).map(key => structuredClone(data.get(key)))) }
  count() { return this.tx.run('count', null, data => data.size) }
  openCursor() { return this.tx.run('openCursor', null, () => null) }
  openKeyCursor() { return this.tx.run('openKeyCursor', null, () => null) }
  put(value, key) { return this.#write('put', key, data => { data.set(key, structuredClone(value)); return key }) }
  add(value, key) { return this.#write('add', key, data => { data.set(key, structuredClone(value)); return key }) }
  delete(key) { return this.#write('delete', key, data => { data.delete(key) }) }
  clear() { return this.#write('clear', null, data => { data.clear() }) }
}

/** The database itself: the stores every connection shares. */
class FakeDb {
  constructor(factory, name, version) {
    Object.assign(this, { factory, name, version, stores: new Map(), connections: new Set() })
  }
  /** Her app asking for a newer version: every open connection is told. */
  fireVersionChange() {
    for (const connection of Array.from(this.connections)) connection.onversionchange?.({ target: connection, oldVersion: this.version, newVersion: this.version + 1 })
  }
}

/** One open connection: its own `closed`, its own `onversionchange`, the shared stores. */
class FakeConnection {
  constructor(db) {
    Object.assign(this, { db, closed: false, onversionchange: null, onclose: null })
    db.connections.add(this)
  }
  get factory() { return this.db.factory }
  get name() { return this.db.name }
  get version() { return this.db.version }
  get stores() { return this.db.stores }
  get objectStoreNames() {
    const names = Array.from(this.db.stores.keys())
    return { length: names.length, contains: name => names.includes(name), item: index => names[index] ?? null }
  }
  transaction(storeName, mode = 'readonly') {
    if (this.closed) throw new DOMException('connection closed', 'InvalidStateError')
    const entry = { store: storeName, mode, requests: [], connection: this }
    this.factory.log.transactions.push(entry)
    return new FakeTx(this, storeName, mode, entry)
  }
  createObjectStore(name) {
    this.factory.log.created.push(name)
    this.db.stores.set(name, new Map())
    return {}
  }
  close() { if (!this.closed) { this.closed = true; this.db.connections.delete(this); this.factory.log.closes += 1 } }
  /** Her app asking for a newer version: every open connection (this one included) is told. */
  fireVersionChange() { this.db.fireVersionChange() }
}

/** An in-memory IndexedDB factory that records everything done to it. */
export class FakeIndexedDb {
  /** @param {{listsDatabases?: boolean}} [options] - false: no `databases()` method, as in older engines. */
  constructor({ listsDatabases = true } = {}) {
    this.dbs = new Map()
    this.log = { opens: [], transactions: [], requests: [], created: [], aborted: 0, closes: 0 }
    this.hooks = { beforeRequest: null, hold: null }
    if (listsDatabases) this.databases = async () => Array.from(this.dbs.values(), db => ({ name: db.name, version: db.version }))
  }
  /** Seed a database as her app leaves it: version 2, store `entries`. */
  seed(name, entries, { version = 2, store = 'entries' } = {}) {
    const db = new FakeDb(this, name, version)
    if (store) db.stores.set(store, new Map(entries.map(([key, value]) => [key, structuredClone(value)])))
    this.dbs.set(name, db)
    return db
  }
  /** The live map behind a store (tests change it between reads). */
  data(name = 'aukora-x6-vfs', store = 'entries') { return this.dbs.get(name)?.stores.get(store) }
  open(name, ...rest) {
    const version = rest[0]
    this.log.opens.push({ name, version, withVersion: rest.length > 0 })
    const request = new FakeRequest()
    setTimeout(() => {
      let db = this.dbs.get(name)
      const created = db === undefined
      const oldVersion = created ? 0 : db.version
      const newVersion = version === undefined ? (created ? 1 : db.version) : version
      if (!created && newVersion < oldVersion) {
        request.error = new DOMException('lower version', 'VersionError'); request.onerror?.({ target: request, preventDefault() {} }); return
      }
      if (newVersion > oldVersion) {
        if (created) { db = new FakeDb(this, name, newVersion); this.dbs.set(name, db) } else db.version = newVersion
        const tx = { mode: 'versionchange', aborted: false, abort() { this.aborted = true } }
        this.log.transactions.push({ store: null, mode: 'versionchange', requests: [] })
        request.transaction = tx
        request.result = new FakeConnection(db)
        request.onupgradeneeded?.({ target: request, oldVersion, newVersion })
        request.transaction = null
        if (tx.aborted) {
          this.log.aborted += 1
          request.result.close()
          if (created) this.dbs.delete(name); else db.version = oldVersion
          request.result = undefined
          request.error = new DOMException('upgrade aborted', 'AbortError')
          request.onerror?.({ target: request, preventDefault() {} })
          return
        }
      }
      if (!(request.result instanceof FakeConnection) || request.result.closed) request.result = new FakeConnection(db)
      request.onsuccess?.({ target: request })
    }, 0)
    return request
  }
  /** Requests by method name, and the transactions that were not `readonly`. */
  count(method) { return this.log.requests.filter(request => request.method === method).length }
  writableTransactions() { return this.log.transactions.filter(tx => tx.mode !== 'readonly' && tx.mode !== 'versionchange') }
}

/** A localStorage stand-in that records every write. */
export class FakeLocalStorage {
  constructor(entries = []) { this.map = new Map(entries); this.writes = [] }
  get length() { return this.map.size }
  key(index) { return Array.from(this.map.keys())[index] ?? null }
  getItem(name) { return this.map.has(name) ? this.map.get(name) : null }
  setItem(name, value) { this.writes.push(['setItem', name]); this.map.set(name, String(value)) }
  removeItem(name) { this.writes.push(['removeItem', name]); this.map.delete(name) }
  clear() { this.writes.push(['clear']); this.map.clear() }
}

/**
 * The worker file system face over IndexedDB-shaped entries (`file` and `dir` only), read-only. `readFileSync` hands out
 * the stored array itself, as her memory file system does, so a kit that wrote into it would be caught.
 * @param {Array<[string, object]>} entries
 */
export function fakeFsFromEntries(entries) {
  const nodes = new Map(entries.filter(([, value]) => value.kind === 'file' || value.kind === 'dir'))
  const reads = []
  const stat = path => {
    const node = nodes.get(path)
    if (!node) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' })
    return node
  }
  return {
    reads,
    nodes,
    statSync(path) {
      const node = stat(path)
      return { size: node.kind === 'file' ? node.bytes.length : 0, mtimeMs: node.mtimeMs ?? 0, mode: node.mode, isDirectory: () => node.kind === 'dir' }
    },
    readdirSync(path) {
      if (stat(path).kind !== 'dir') throw Object.assign(new Error('ENOTDIR: ' + path), { code: 'ENOTDIR' })
      const prefix = path.endsWith('/') ? path : path + '/'
      return Array.from(nodes.keys()).filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(key => key.slice(prefix.length)).sort()
    },
    readFileSync(path) {
      const node = stat(path)
      if (node.kind !== 'file') throw Object.assign(new Error('EISDIR: ' + path), { code: 'EISDIR' })
      reads.push(path)
      return node.bytes
    },
  }
}

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const HEX64 = /^[0-9a-f]{64}$/
const ROW_TYPES = new Set(['file', 'dir', 'gone', 'meta', 'local'])

/**
 * The row rule, word for word: a dir or gone row has `bytes: 0`, `sha256: null`, `pieces: []`; file, meta and local rows
 * have all three, `sha256` 64 lower hex and `Math.ceil(bytes / piece)` pieces (none for zero bytes).
 */
export function rowBreaksRule(row, piece) {
  if (row === null || typeof row !== 'object' || typeof row.key !== 'string' || !ROW_TYPES.has(row.type)) return true
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Array.isArray(row.pieces)) return true
  if (row.type === 'dir' || row.type === 'gone') return row.bytes !== 0 || row.sha256 !== null || row.pieces.length !== 0
  return !HEX64.test(row.sha256 ?? '') || row.pieces.length !== Math.ceil(row.bytes / piece) || !row.pieces.every(hash => HEX64.test(hash))
}

/**
 * The `/_vault/*` routes in memory. `vault.hook(request)` may answer first (return a Response) to inject failures.
 * Each answer comes in its own task, so concurrency is observable: `overlapAfter408` turns true if any request starts
 * while another is in flight after the first 408 was answered.
 * @param {{piece?: number, step?: number}} [options] - the index's required piece size; rows walked per verify call.
 */
export function createFakeVault({ piece = 2097152, step = 2 } = {}) {
  const vault = {
    piece, step, blobs: new Map(), rescues: new Map(), cursors: new Map(), log: [], events: [], inFlight: 0, maxInFlight: 0,
    seen408: false, overlapAfter408: false, verifyCalls: [], hook: null,
  }
  vault.flip = hash => { const bytes = vault.blobs.get(hash); bytes[0] ^= 0xff }
  vault.tamperIndex = id => { const bytes = vault.rescues.get(id); bytes[bytes.length - 2] ^= 0x01 }
  vault.puts = () => vault.log.filter(entry => entry.method === 'PUT' && entry.path.startsWith('/_vault/blob/'))
  const route = (method, url, body) => {
    const path = url.pathname
    let match = /^\/_vault\/blob\/([0-9a-f]{64})$/.exec(path)
    if (match) {
      const hash = match[1], held = vault.blobs.get(hash)
      if (method === 'HEAD') return new Response(null, { status: held ? 200 : 404 })
      if (method === 'GET') return held ? new Response(held.slice(), { status: 200, headers: { 'content-type': 'application/octet-stream' } }) : json({ ok: false, code: 'BLOB_UNKNOWN' }, 404)
      if (method === 'PUT') {
        if (!body || sha256(body) !== hash) return json({ ok: false, code: 'VAULT_REQUEST_INVALID' }, 400)
        if (held) return json({ ok: true }, 200)
        vault.blobs.set(hash, body.slice())
        return json({ ok: true }, 201)
      }
      return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
    }
    match = /^\/_vault\/rescue\/([0-9a-f]{32})(\/verify)?$/.exec(path)
    if (!match) return json({ ok: false, code: 'NOT_FOUND' }, 404)
    const id = match[1]
    if (match[2]) {
      if (method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
      const call = { sent: url.searchParams.get('cursor'), status: 0, next: null }
      vault.verifyCalls.push(call)
      const answer = (body, status) => { call.status = status; return json(body, status) }
      const held = vault.rescues.get(id)
      if (!held) return answer({ ok: false, code: 'RESCUE_UNKNOWN' }, 404)
      if (call.sent === null) return answer({ ok: false, code: 'VAULT_REQUEST_INVALID' }, 400)
      const position = call.sent === '0' ? 0 : vault.cursors.get(id + ':' + call.sent)
      if (position === undefined) return answer({ ok: false, code: 'VAULT_REQUEST_INVALID' }, 400)
      const rows = JSON.parse(new TextDecoder().decode(held)).rows
      const end = Math.min(rows.length, position + vault.step)
      for (let at = position; at < end; at++) {
        for (const hash of rows[at].pieces) if (!vault.blobs.has(hash)) return answer({ ok: false, code: 'RESCUE_BLOB_MISSING', sha256: hash }, 424)
      }
      if (end >= rows.length) return answer({ ok: true, done: true, cursor: null }, 200)
      // Opaque to the kit: it must send back exactly what it was given.
      call.next = end * 1000 + 7
      vault.cursors.set(id + ':' + String(call.next), end)
      return answer({ ok: true, done: false, cursor: call.next }, 200)
    }
    if (method === 'GET') return vault.rescues.has(id) ? new Response(vault.rescues.get(id).slice(), { status: 200, headers: { 'content-type': 'application/json' } }) : json({ ok: false, code: 'RESCUE_UNKNOWN' }, 404)
    if (method !== 'PUT') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
    let index
    try { index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch (error) { return json({ ok: false, code: 'VAULT_REQUEST_INVALID' }, 400) }
    if (sha256(body).slice(0, 32) !== id || index?.v !== 1 || index.piece !== vault.piece || !Array.isArray(index.rows)
      || index.rows.some(row => rowBreaksRule(row, vault.piece))
      || index.rows.some((row, at) => at > 0 && !(index.rows[at - 1].key < row.key))) return json({ ok: false, code: 'VAULT_REQUEST_INVALID' }, 400)
    if (vault.rescues.has(id)) return json({ ok: true }, 200)
    vault.rescues.set(id, body.slice())
    return json({ ok: true }, 201)
  }
  vault.fetch = async (input, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase()
    const url = new URL(String(input), 'https://edge.test')
    const entry = { n: vault.log.length, method, path: url.pathname, cursor: url.searchParams.get('cursor') }
    vault.log.push(entry)
    if (vault.seen408 && vault.inFlight > 0) vault.overlapAfter408 = true
    vault.inFlight += 1
    vault.maxInFlight = Math.max(vault.maxInFlight, vault.inFlight)
    vault.events.push(['start', entry.n])
    try {
      await later(0)
      const raw = init.body
      const body = raw === undefined || raw === null ? null : typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw).slice()
      let response = vault.hook ? await vault.hook({ method, path: url.pathname, url, body, entry }) : undefined
      if (!response) response = route(method, url, body)
      if (method === 'HEAD' && response.body) response = new Response(null, { status: response.status, headers: response.headers })
      entry.status = response.status
      if (response.status === 408) vault.seen408 = true
      return response
    } finally {
      vault.inFlight -= 1
      vault.events.push(['end', entry.n])
    }
  }
  return vault
}

/** Her store's rows, the way idb-persist writes them. */
export const fileEntry = (bytes, mtimeMs = 1700000000000, mode = 0o644) => ({ kind: 'file', bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, mode, mtimeMs })
export const dirEntry = (mode = 0o755) => ({ kind: 'dir', mode })
export const goneEntry = () => ({ kind: 'gone' })
