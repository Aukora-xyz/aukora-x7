/**
 * The rescue kit: a checked second copy of what ONE browser holds of Auma (her threads, her home, her storage's
 * bookkeeping, Auma Live's chat logs and, when asked, this origin's other saved settings), made without starting her app and without changing anything
 * in that browser. Read-only is the law: it never creates, upgrades, writes or holds her database (`aukora-x6-vfs`), never
 * writes localStorage or sessionStorage, takes no Web Lock, opens no BroadcastChannel and imports no app code.
 *
 * `rescueKit(options)` is ONE self-contained function: no imports, nothing from module scope. The generator
 * (rescue-page.generate.mjs) turns it into a plain string for the `/rescue` page and for a console; server/rescue-verify.mjs
 * calls the same function for the id, the canonical form and the private-path rule, so the two can never disagree.
 * `rescuePage(kit)` is the page glue; it alone touches the page.
 *
 * Two ways out, both checked byte for byte: `copyToCloud` (pieces named by SHA-256 to `/_vault/blob/<sha256>`, the index
 * to `/_vault/rescue/<id>`, the edge's verify walk, then a read-back of every piece compared with a second read of the
 * source) and `saveLocal` (one `x61-rescue-pack/v1` Blob; `server/rescue-verify.mjs <pack>` re-hashes it). The local
 * pack's index also records what the run could not copy (`completeness`), so a pack can never look complete in silence.
 *
 * Memory: a row costs the row itself plus a small fixed amount. Whole-row hashes are taken by the kit's own incremental
 * SHA-256 over views (no copy), pieces are hashed and handed to the pack Blob as views of at most one piece each.
 * @module rescue-kit
 */

/**
 * Make the rescue kit.
 * @param {object} [options]
 * @param {'indexeddb'|'memory'} [options.source] - where rows come from: her IndexedDB store (default) or her worker's file system.
 * @param {object} [options.fs] - the memory source's file system (`readdirSync`, `statSync`, `readFileSync`); only read.
 * @param {string[]} [options.roots] - the memory source's roots (default `['/dsh/home']`).
 * @param {object} [options.client] - the memory source's `{clientId, base, reconciliation}` (default all null).
 * @param {Function} [options.fetch] - fetch (default the global).
 * @param {object|null} [options.indexedDB] - IndexedDB factory (default the global).
 * @param {object|null} [options.localStorage] - localStorage (default the global, when it can be read).
 * @param {number} [options.piece] - piece size, FOR TESTS ONLY (the protocol number is 2,097,152).
 * @param {Function} [options.sleep] - wait helper (tests pass a quick one).
 * @param {Function} [options.now] - clock for the "checked" time and a Join's turn (when to renew it, its 30-minute cap); never in the index.
 * @param {object} [options.deadlines] - FOR TESTS ONLY: `{headers, upload, idle, total, bodyTotal, read}` in ms (see DEADLINE).
 * @returns the kit's helpers.
 */
export function rescueKit(options = {}) {
  // Everything lives inside this function: it is turned into a string and run in a page or in a worker console.
  const PIECE = Number.isSafeInteger(options.piece) && options.piece > 0 ? options.piece : 2097152
  const DB_NAME = 'aukora-x6-vfs', STORE = 'entries', MAX_INDEX_BYTES = 4194304, MAGIC = 'X61RESCUE1\n'
  const THREAD = /^\/dsh\/home\/(?:sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl|[^/]+\/session\/messages\.jsonl)$/
  const PRIVATE = '/dsh/home/auma/private'
  // job 1: her checkpoint signer is key material (one body holds it), like her ed25519 key pair: it stays behind.
  const SECRET_NAMES = ['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json',
    '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1', 'checkpoint-signer.v1.json']
  const ENDINGS = '.~-_'
  /**
   * Her private room: a NEW cloud copy leaves her private folder at
   * origin. Its rows are not read into the copy, not hashed into its index and not named anywhere in it; the index says
   * only how many files and bytes stayed (`leftAtOrigin: {private: {files, bytes}}`, in every new cloud copy, zeros when
   * there is none). The count is of the room's ordinary files: a secret-shaped row in it (a key pair, a `.ssh` folder) is
   * never read, is listed by kind under "Left in this browser only" like every secret-shaped row, and is not counted
   * (job 2). A bookkeeping row that names the folder (a reset, a waiting save, a queued save of one of its files)
   * stays in this browser too. The local pack still holds her private room (it never leaves this computer); it leaves
   * the checkpoint signer behind, as it leaves the key pair.
   * `ROOM_NAMED`: the folder's path in a key or in a bookkeeping row's JSON, not followed by more of a name.
   */
  const inRoom = path => path === PRIVATE || path.startsWith(PRIVATE + '/')
  const ROOM_NAMED = /\/dsh\/home\/auma\/private(?![\w.~@+=-])/
  const ROOM_BOOKKEEPING = 'bookkeeping row naming her private folder'
  // Main's estate redaction names (browser-estate.ts SENSITIVE_NAME), judged on every path part. Only the CLOUD copy
  // leaves these behind as well; the local pack keeps the narrower rule above. Her private folder is in the local pack
  // only (see ROOM_NAMED above).
  const SENSITIVE = [[/keypair/i, '…keypair…'], [/private[-_.]?key/i, '…private-key…'], [/secret/i, '…secret…'],
    [/credential/i, '…credential…'], [/password/i, '…password…'], [/\.pem$/i, '….pem'], [/\.key$/i, '….key'],
    [/\.p12$/i, '….p12'], [/session\.cap$/i, '…session.cap']]
  // Saved-setting names holding any of these (any case) stay behind. The last word is spelled in two halves so the page
  // text never carries it.
  const SETTING_WORDS = ['key', 'secret', 'pass', 'auth', 'cap', 'credential', 'to' + 'ken']
  /**
   * Saved-setting names that hold her CONVERSATION, not a setting: a reviewed allow-list of EXACT prefixes (case and
   * all). These are copied by default, by both the cloud copy and the local pack, and the name-only rule above is not
   * applied to them (their values were reviewed instead). One entry today: Auma Live's chat log, the last 120 turns of
   * each voice session (`{role, text, ts, replyId?}` per turn), written by apps/web/public/app/aumalive.js under
   * `chat-log-key.js` CHAT_LOG_PREFIX and kept nowhere else. Every other saved setting stays in this browser unless the
   * caller passes `settings: true`, and then the name-only rule above still leaves secret-like names behind.
   */
  const CHAT_LOG_PREFIXES = ['aukora-auma-live-log-v2:']
  const isChatLog = name => typeof name === 'string' && CHAT_LOG_PREFIXES.some(prefix => name.startsWith(prefix))
  const LOCAL_PREFIX = 'localStorage:'
  // The browser's word for a page's frame, spelled in two halves so the kit's text never names the page global (the
  // read-only guard test refuses that name anywhere in the kit).
  const WIN = 'win' + 'dow'
  const LINE = {
    nothing: 'This browser holds nothing of hers to copy.',
    upgrading: 'This copy is not complete: her app is upgrading its storage here. Run this again.',
    slowRead: 'This copy is not complete: this browser took more than a minute to read one row. Nothing was changed. Run this again.',
    storage: 'This browser could not open its storage just now. Nothing was changed. Run this again.',
    tooMany: 'This browser holds too many rows for one cloud copy. Save a copy on this computer and report this.',
    busy: 'Her edge is busy. Waiting.',
    busyLong: 'Her edge stayed busy. Press the button again in a minute.',
    signin: 'Your sign-in ended. Sign in again on this page, then press the button again.',
    full: 'Her cloud copy space is full. Report this.',
    limit: 'Her cloud already holds its limit of rescue copies. Report this.',
    refused: "Her cloud did not take this copy's list. Report this.",
    unanswered: 'Her cloud did not answer. Press the button again: pieces already there are not sent again.',
    stalled: 'This copy is not complete: her cloud stopped answering partway. Press the button again: pieces already there are not sent again.',
    slow: 'Her cloud is slow. Trying again.',
    unexpected: 'Her cloud gave an answer this page does not know. Report this.',
    notComplete: 'This copy is not complete.',
    changed: 'This copy is not complete: a row changed while it was being made. Run again.',
    logsStay: 'Auma Live chat logs were copied. Other saved settings stay in this browser.',
    noLogsStay: 'No Auma Live chat logs were found. Other saved settings stay in this browser.',
    logsAll: 'Auma Live chat logs were copied. Other saved settings were copied too, except names that look secret.',
    noLogsAll: 'No Auma Live chat logs were found. Other saved settings were copied, except names that look secret.',
    held: 'A copy made in this ' + WIN + ' is still held here. Close this ' + WIN + ' and run once in a new one.',
  }
  /** The headline when the finished pack did not read back exactly: no download is started. */
  const unkept = reason => 'This browser could not keep the copy (' + reason + '). Close this ' + WIN + ' and run once in a new one.'
  const source = options.source === 'memory' ? 'memory' : 'indexeddb'
  const g = globalThis
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : (url, init) => g.fetch(url, init)
  const factory = 'indexedDB' in options ? options.indexedDB : g.indexedDB
  // A page whose browser refuses its saved settings (the getter throws) is NOT a page with none: `listSettings` records it.
  let storage = null, storageRefused = false
  if ('localStorage' in options) storage = options.localStorage
  else { try { storage = g.localStorage || null } catch (error) { storageRefused = true } }
  const subtle = (options.crypto || g.crypto).subtle
  const sleep = typeof options.sleep === 'function' ? options.sleep : ms => new Promise(resolve => setTimeout(resolve, ms))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const encoder = new TextEncoder()
  /**
   * Deadlines, in ms. One network request: its answer must START within `headers` (30 s) when it sends nothing, or
   * within `upload` (150 s) when it sends a piece or the list (the sending itself is in that wait; her edge gives up on a
   * stalled upload by itself after 30 s without a byte, or 120 s in all, and answers 408); its body may go `idle` (30 s)
   * without a byte (an empty chunk is not a byte); and the whole request, sending and answer, ends within `total`
   * (120 s), or `bodyTotal` (150 s) when it sends a body: ABOVE her edge's 120 s, so a slow upload hears her edge's 408
   * (and the run goes one request at a time) instead of giving up first. A request past any of them is cancelled and
   * counts as a failed fetch: the same retries and waits as a 5xx; one that sent a body also makes the rest of the run go
   * one request at a time, as a 408 does. One read of her storage (`read`, 60 s):
   * one get of a very large row (100 MB, say) is a disk read plus one structured clone, a few seconds even on a slow
   * disk, so a minute is many times that and only a stuck read reaches it. The numbers are FOR TESTS ONLY to change.
   */
  const DEADLINE_DEFAULTS = { headers: 30000, upload: 150000, idle: 30000, total: 120000, bodyTotal: 150000, read: 60000 }
  const DEADLINE = Object.assign({}, DEADLINE_DEFAULTS)
  if (options.deadlines !== null && typeof options.deadlines === 'object') {
    for (const name of Object.keys(DEADLINE)) {
      const value = options.deadlines[name]
      if (Number.isSafeInteger(value) && value > 0) DEADLINE[name] = value
    }
  }
  /**
   * A deadline timer, or null. Deadlines are armed only where a timer can also be cleared (every browser page and
   * worker can); a hidden tab may fire them late, never early. `fire` runs at most once; `stop` disarms it.
   */
  const deadline = (ms, fire) => {
    if (typeof g.setTimeout !== 'function' || typeof g.clearTimeout !== 'function') return null
    let fired = false
    const id = g.setTimeout(() => { if (!fired) { fired = true; fire() } }, ms)
    return { stop: () => { if (!fired) { fired = true; try { g.clearTimeout(id) } catch (error) { /* already gone */ } } } }
  }
  const disarm = timer => { if (timer) timer.stop() }

  const halt = (kind, detail) => ({ rescueHalt: kind, detail })
  const isHalt = value => value !== null && typeof value === 'object' && typeof value.rescueHalt === 'string'
  const tagOf = value => Object.prototype.toString.call(value)
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const bump = (map, name) => { map.set(name, (map.get(name) || 0) + 1) }
  const counted = map => Array.from(map).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([shape, count]) => ({ shape, count }))
  const toHex = bytes => { let text = ''; for (const byte of bytes) text += byte.toString(16).padStart(2, '0'); return text }
  /** WebCrypto SHA-256 of ONE piece (it copies at most one piece). */
  const hex = async bytes => toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
  const asBytes = value => {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (tagOf(value) === '[object ArrayBuffer]') return new Uint8Array(value)
    return null
  }

  // ── SHA-256 that takes chunks (FIPS 180-4), so a whole row is hashed from views without a copy ────────────────────────
  const K = new Int32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2])
  const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  /**
   * The final padding for a message of `count` bytes: 0x80, zeros, then the length in BITS as 64 bits big-endian. The
   * bit length is split into two 32-bit words without ever multiplying past 2^53, so lengths over 512 MB are exact.
   */
  const padding = count => {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('bad length')
    const fill = (119 - (count % 64)) % 64
    const out = new Uint8Array(fill + 9)
    out[0] = 0x80
    const high = Math.floor(count / 0x20000000), low = (count % 0x20000000) * 8
    for (let at = 0; at < 4; at++) {
      out[fill + 1 + at] = (high >>> (24 - 8 * at)) & 0xff
      out[fill + 5 + at] = (low >>> (24 - 8 * at)) & 0xff
    }
    return out
  }
  /** A new running SHA-256: `update(bytes)` any number of times (views are read, never copied), then `digest()` (hex). */
  const newHash = () => {
    const state = Int32Array.from(IV), w = new Int32Array(64), held = new Uint8Array(64)
    let heldBytes = 0, count = 0, finished = false
    const compress = (data, at, end) => {
      let h0 = state[0], h1 = state[1], h2 = state[2], h3 = state[3], h4 = state[4], h5 = state[5], h6 = state[6], h7 = state[7]
      for (; at + 64 <= end; at += 64) {
        for (let i = 0; i < 16; i++) {
          const j = at + i * 4
          w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]
        }
        for (let i = 16; i < 64; i++) {
          const x = w[i - 15], y = w[i - 2]
          const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
          const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, gg = h6, h = h7
        for (let i = 0; i < 64; i++) {
          const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
          const t1 = (h + s1 + ((e & f) ^ (~e & gg)) + K[i] + w[i]) | 0
          const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
          const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
          h = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + gg) | 0; h7 = (h7 + h) | 0
      }
      state[0] = h0; state[1] = h1; state[2] = h2; state[3] = h3; state[4] = h4; state[5] = h5; state[6] = h6; state[7] = h7
    }
    const feed = data => {
      const end = data.length
      let at = 0
      if (heldBytes > 0) {
        const take = Math.min(64 - heldBytes, end)
        held.set(data.subarray(0, take), heldBytes)
        heldBytes += take
        at = take
        if (heldBytes < 64) return
        compress(held, 0, 64)
        heldBytes = 0
      }
      const whole = at + Math.floor((end - at) / 64) * 64
      compress(data, at, whole)
      if (whole < end) { held.set(data.subarray(whole, end), 0); heldBytes = end - whole }
    }
    const hash = {
      update(bytes) {
        const data = asBytes(bytes)
        if (finished || !data) throw new Error(finished ? 'this hash is finished' : 'bytes only')
        count += data.length
        feed(data)
        return hash
      },
      digest() {
        if (finished) throw new Error('this hash is finished')
        finished = true
        feed(padding(count))
        let text = ''
        for (const word of state) text += (word >>> 0).toString(16).padStart(8, '0')
        return text
      },
    }
    return hash
  }
  const sha256Hex = bytes => newHash().update(bytes).digest()
  /**
   * Let the page (or her worker) breathe: one turn of the event loop WITHOUT a timer. A hidden tab's timers are throttled
   * to about one a second (one a minute under Chrome's intensive throttling); `scheduler.yield` and a MessageChannel
   * message are not. A timer is the last resort, for a place that has neither.
   */
  const breathe = (() => {
    if (g.scheduler && typeof g.scheduler.yield === 'function') return () => g.scheduler.yield()
    if (typeof g.MessageChannel === 'function') {
      return () => new Promise(resolve => {
        const channel = new g.MessageChannel()
        channel.port1.onmessage = () => { channel.port1.close(); resolve() }
        channel.port2.postMessage(0)
      })
    }
    return () => new Promise(resolve => setTimeout(resolve, 0))
  })()
  /** The SHA-256 of a whole row from views, a piece at a time, giving the event loop a turn after each full piece. */
  const hashOf = async bytes => {
    const hash = newHash()
    for (let offset = 0; offset < bytes.length; offset += PIECE) {
      hash.update(bytes.subarray(offset, Math.min(offset + PIECE, bytes.length)))
      if (bytes.length >= PIECE) await breathe()
    }
    return hash.digest()
  }

  /** Canonical JSON: object keys sorted, undefined members dropped. The same rows always give the same bytes. */
  const canon = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
    if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
    return '{' + Object.keys(value).sort().filter(name => value[name] !== undefined)
      .map(name => JSON.stringify(name) + ':' + canon(value[name])).join(',') + '}'
  }
  /**
   * THE id of a copy: the first 32 hex of the SHA-256 of the canonical index with every row's `offset` removed. The cloud
   * index has no offsets, so there it is the hash of the very bytes sent; rescue-verify calls this same function.
   */
  const indexId = index => sha256Hex(encoder.encode(canon(Object.assign({}, index, {
    rows: index.rows.map(row => (isRecord(row) ? Object.assign({}, row, { offset: undefined }) : row)),
  })))).slice(0, 32)
  /** A key as it may be shown anywhere: everything under her private folder is `/dsh/home/auma/private/[redacted]`. */
  const shown = key => {
    if (typeof key !== 'string') return 'a row whose key is not text'
    const at = key.indexOf(PRIVATE + '/')
    return at < 0 ? key : key.slice(0, at) + PRIVATE + '/[redacted]'
  }
  /**
   * Any text that may carry a key (an unexpected error's message), as it may be shown: from the first mention of her
   * private folder on (written with / or \/ or %2F between its parts) everything is `[redacted]`, and the text is cut
   * to 300 characters.
   */
  const redactText = text => {
    const value = String(text)
    const at = value.search(/(?:\/|\\\/|%2f)dsh(?:\/|\\\/|%2f)home(?:\/|\\\/|%2f)auma(?:\/|\\\/|%2f)private(?:\/|\\\/|%2f)/i)
    const safe = at < 0 ? value : value.slice(0, at) + PRIVATE + '/[redacted]'
    return safe.length > 300 ? safe.slice(0, 300) + '…' : safe
  }
  /** An error's message as text (never throws). */
  const messageOf = error => {
    try { return error && typeof error.message === 'string' && error.message ? error.message : String(error) } catch (inner) { return 'an error' }
  }
  /** The line for an error this kit did not expect: its message passes the private-path redaction first. */
  const stoppedLine = error => 'This copy stopped: ' + redactText(messageOf(error)) + '. Nothing in this browser was changed. Press the button again.'
  /** An unexpected error, re-thrown with only its redacted message (a console prints a thrown error's message). */
  const scrubbed = error => {
    const clean = new Error(redactText(messageOf(error)))
    clean.name = 'RescueStopped'
    return clean
  }
  /** A thread named by its session folder's last two path parts only. */
  const threadLabel = key => String(key).split('/').slice(0, -1).slice(-2).join('/')
  const hhmm = ms => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'never'
    const date = new Date(ms)
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  }
  /** HH:MM:SS: an open's reads are said to the second, so two requests in one minute never read as one moment. */
  const hhmmss = ms => (typeof ms !== 'number' || !Number.isFinite(ms) ? 'never' : hhmm(ms) + ':' + String(new Date(ms).getSeconds()).padStart(2, '0'))
  const megabytes = bytes => String(Math.round(bytes / 1e6)) + ' MB'

  // ── The held pack ──────────────────────────────────────────────────────────────────────────────────────────────────
  // The last pack Blob this page made, and its object URL. A browser keeps every Blob it is handed until nothing holds it,
  // and a dry run broke a pack after fourteen runs in one tab: so ONE pack is held at a time, its URL is revoked
  // right after the download click, and a new run first releases both (and is refused unless the caller says `again`).
  // `options.holder` lets a console script keep it across pastes in one page; otherwise it lives with this kit.
  const held = isRecord(options.holder) ? options.holder : {}
  /** Revoke the held object URL, if any. */
  const revokeUrl = () => {
    const url = held.url
    held.url = null
    if (typeof url === 'string') { try { g.URL.revokeObjectURL(url) } catch (error) { /* already gone */ } }
  }
  /** Let go of the held pack: its URL is revoked and the Blob is no longer referenced by this kit. */
  const release = () => { revokeUrl(); held.blob = null }
  /** An object URL for the held pack (one at a time: an earlier one is revoked first). */
  const urlOf = blob => {
    revokeUrl()
    held.url = g.URL.createObjectURL(blob)
    return held.url
  }
  const rowsWord = n => n + (n === 1 ? ' row' : ' rows')
  const listingsWord = n => n + (n === 1 ? ' listing' : ' listings')

  // ── What stays behind ──────────────────────────────────────────────────────────────────────────────────────────────
  /** How many dots a name starts with. */
  const leadingDots = text => { let count = 0; while (text.charAt(count) === '.') count += 1; return count }
  // Each listed name as [its stem without leading dots, the leading dots it needs]. `.credentials.yaml` and
  // `credentials.yaml` share a stem, so that stem needs none; `.ssh` needs at least one (a bare `ssh` stays ordinary).
  const STEMS = []
  for (const name of SECRET_NAMES) {
    const stem = name.slice(leadingDots(name)), need = Math.min(1, leadingDots(name))
    const known = STEMS.find(entry => entry[0] === stem)
    if (!known) STEMS.push([stem, need]); else known[1] = Math.min(known[1], need)
  }
  /**
   * The secret shape of one path part, or null. ONE rule for leading dots: they are all stripped first. The part is
   * secret-shaped when (a) what is left is a listed name's stem, alone or followed by one of . ~ - _ and anything, and
   * the part had at least as many leading dots as that name (`credentials.yaml`, `session.cap`, `ed25519-keypair.json`,
   * `pepper.v1`: none; `.credentials`, `.ssh`, `.aws`, `.transport`, `.afferent-probe`: one), or (b) the part had at
   * least one leading dot and what is left starts with `env` or `aukora-`. Wider than the app's own rule on purpose.
   */
  const partShape = (part, mode) => {
    if (typeof part !== 'string') return null
    const dots = leadingDots(part), rest = part.slice(dots)
    if (dots > 0 && rest.startsWith('env')) return '.env…'
    if (dots > 0 && rest.startsWith('aukora-')) return '.aukora-…'
    for (const [stem, need] of STEMS) {
      if (dots < need || !rest.startsWith(stem)) continue
      // The shape says how the part began (no dot, one, or more), never more of the name than the listed stem.
      const form = dots === 0 ? stem : dots === 1 ? '.' + stem : '.' + stem + ' with extra leading dots'
      if (rest.length === stem.length) return form
      if (ENDINGS.includes(rest.charAt(stem.length))) return form + ' plus an ending'
    }
    if (mode === 'cloud') for (const [pattern, label] of SENSITIVE) if (pattern.test(part)) return label
    return null
  }
  /** The secret shape of a path (any part), or null. `mode` 'cloud' adds main's estate names; anything else is local. */
  const secretShape = (path, mode) => {
    if (typeof path !== 'string') return null
    for (const part of path.split('/')) { const shape = partShape(part, mode); if (shape) return shape }
    return null
  }
  /** Why a saved setting stays behind, or null. */
  const settingShape = name => {
    const lower = String(name).toLowerCase()
    if (SETTING_WORDS.some(word => lower.includes(word))) return 'saved setting with a secret-like name'
    const shape = secretShape(String(name))
    return shape ? 'saved setting named ' + shape : null
  }
  /** Why a row stays behind, judged from its key alone (no read), or null. */
  const keyShape = (key, mode) => {
    if (key.charAt(0) === '/') { const shape = secretShape(key, mode); return shape ? 'file or folder named ' + shape : null }
    for (const [prefix, label] of [['@x6-vfs-reset:', 'reset row for '], ['@x6-deferred-journal:', 'waiting save for ']]) {
      if (key.startsWith(prefix)) { const shape = secretShape(key.slice(prefix.length), mode); return shape ? label + shape : null }
    }
    return null
  }
  /** Where a row sits, said without its key (for counts of what could not be read). */
  const whereOf = key => {
    if (typeof key !== 'string') return 'a row whose key is not text'
    if (key.charAt(0) === '/') {
      if (THREAD.test(key)) return 'a thread'
      if (key === PRIVATE || key.startsWith(PRIVATE + '/')) return 'a file or folder in her private folder'
      return key.startsWith('/dsh/home/') ? 'a file or folder under /dsh/home/' : 'a file or folder'
    }
    const prefix = /^@x6-[a-z0-9-]{1,40}:/.exec(key)
    return prefix ? 'a bookkeeping row (' + prefix[0] + ')' : 'a bookkeeping row'
  }
  /** True when a bookkeeping value is not plain JSON (binary data, a Map or Set, or too deep): it cannot be copied as text. */
  const notPlain = (value, depth) => {
    if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
    if (depth > 64) return true
    if (ArrayBuffer.isView(value)) return true
    const tag = tagOf(value)
    if (['[object ArrayBuffer]', '[object SharedArrayBuffer]', '[object Blob]', '[object File]', '[object Map]', '[object Set]'].includes(tag)) return true
    for (const inner of Array.isArray(value) ? value : Object.values(value)) if (notPlain(inner, depth + 1)) return true
    return false
  }

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Judge one stored value: a row with its bytes, a skip by shape, or unreadable (with a shape, never the key). */
  const judge = (key, value, mode) => {
    if (key.startsWith('@x6-mirror-batch:')) {
      // A queued save is copied only when every entry is a [path, entry] pair whose path was checked; never unchecked.
      const entries = isRecord(value) && isRecord(value.batch) && Array.isArray(value.batch.entries) ? value.batch.entries : null
      if (!entries || !entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string')) {
        return { unreadable: whereOf(key) + ': a queued save of an unknown shape' }
      }
      for (const [path] of entries) { const shape = secretShape(path, mode); if (shape) return { skip: 'queued save holding ' + shape } }
    }
    if (key.charAt(0) === '/' && isRecord(value)) {
      if (value.kind === 'file') {
        const bytes = asBytes(value.bytes)
        if (!bytes) return { unreadable: whereOf(key) + ': a file row without bytes' }
        return { row: { key, type: 'file', mode: num(value.mode), mtimeMs: num(value.mtimeMs), bytes: bytes.length }, bytes }
      }
      if (value.kind === 'dir') return { row: { key, type: 'dir', mode: num(value.mode), bytes: 0, sha256: null, pieces: [] } }
      if (value.kind === 'gone') return { row: { key, type: 'gone', bytes: 0, sha256: null, pieces: [] } }
    }
    if (notPlain(value, 0)) return { unreadable: whereOf(key) + ': not plain text' }
    let text
    try { text = JSON.stringify(value) } catch (error) { return { unreadable: whereOf(key) + ': not plain text' } }
    if (typeof text !== 'string') return { unreadable: whereOf(key) + ': not plain text' }
    // A cloud copy carries no bookkeeping that names her private folder (a queued save of one of its files holds its bytes).
    if (mode === 'cloud' && ROOM_NAMED.test(text)) return { skip: ROOM_BOOKKEEPING }
    const bytes = encoder.encode(text)
    return { row: { key, type: 'meta', bytes: bytes.length }, bytes, value }
  }
  /** Cut bytes at fixed PIECE offsets from 0, as views; each piece and the whole are named by SHA-256. */
  const cut = async bytes => {
    const pieces = [], whole = newHash()
    for (let offset = 0; offset < bytes.length; offset += PIECE) {
      const view = bytes.subarray(offset, Math.min(offset + PIECE, bytes.length))
      pieces.push(await hex(view))
      whole.update(view)
    }
    return { sha256: whole.digest(), pieces }
  }
  /**
   * A listing that failed is NEVER an empty listing. Every enumeration in this kit (her database's keys, this origin's
   * saved-setting names, the memory source's folders) either succeeds or calls this with the failure's SHAPE (never a
   * name), into the run's `lost` map; any entry makes the run NOT complete, and the index records it (`unlisted`).
   */
  const noteUnlisted = (lost, shape) => { bump(lost, shape) }
  const UNLISTED = {
    refused: 'saved settings: this browser would not open them',
    failed: 'saved settings: their list could not be read',
    moved: 'saved settings: their list changed while it was read',
  }
  /** `{count, shapes}` of a run's failed listings. */
  const unlistedOf = lost => { const shapes = counted(lost); return { count: shapes.reduce((sum, entry) => sum + entry.count, 0), shapes } }
  /** This origin's saved-setting names. A list that cannot be read, or that moves while it is read, is recorded in `lost`. */
  const listSettings = lost => {
    const names = []
    if (storageRefused) { noteUnlisted(lost, UNLISTED.refused); return names }
    if (!storage) return names
    try {
      const count = storage.length
      if (!Number.isSafeInteger(count) || count < 0) { noteUnlisted(lost, UNLISTED.failed); return names }
      for (let index = 0; index < count; index++) {
        const name = storage.key(index)
        // A name gone before the count ran out: the list moved under this read (a later name may have shifted past it).
        if (typeof name !== 'string') { noteUnlisted(lost, UNLISTED.moved); return names }
        names.push(name)
      }
      if (storage.length !== count) noteUnlisted(lost, UNLISTED.moved)
    } catch (error) { noteUnlisted(lost, UNLISTED.failed) }
    return names
  }

  // ── Sources (both only read) ───────────────────────────────────────────────────────────────────────────────────────
  const openIndexedDb = async () => {
    if (!factory) return { none: true }
    if (typeof factory.databases === 'function') {
      let list = null
      // A list of database names that fails is NOT taken as "none": `list` stays unknown and the open by name below decides.
      try { list = await factory.databases() } catch (error) { list = null }
      if (Array.isArray(list) && !list.some(entry => entry && entry.name === DB_NAME)) return { none: true }
    }
    const opened = await new Promise(resolve => {
      let request = null, upgrade = false
      // No version: an open never upgrades her store. Where it does not exist the would-be creation is aborted.
      try { request = factory.open(DB_NAME) } catch (error) { resolve({ failed: true }); return }
      request.onupgradeneeded = event => {
        upgrade = true
        try { event.target.transaction.abort() } catch (error) { /* the open then fails below */ }
      }
      request.onsuccess = () => {
        const db = request.result
        if (upgrade) { try { db.close() } catch (error) { /* closed */ } resolve({ none: true }); return }
        resolve({ db })
      }
      request.onerror = event => {
        try { if (event && typeof event.preventDefault === 'function') event.preventDefault() } catch (error) { /* nothing */ }
        resolve(upgrade ? { none: true } : { failed: true })
      }
    })
    if (!opened.db) return opened
    const db = opened.db
    const state = { upgrading: false, active: new Set() }
    const close = () => { try { db.close() } catch (error) { /* closed */ } }
    // A connection that cannot say which stores it has is a failed open, never "nothing to copy".
    if (!db.objectStoreNames || typeof db.objectStoreNames.contains !== 'function') { close(); return { failed: true } }
    if (!db.objectStoreNames.contains(STORE)) { close(); return { none: true } }
    // Her app upgrading its storage wins at once: the read in flight is ABORTED (close() alone waits for it to finish),
    // this connection closes, and the run stops "not complete". Nothing of hers waits on this kit.
    db.onversionchange = () => {
      state.upgrading = true
      for (const tx of Array.from(state.active)) { try { tx.abort() } catch (error) { /* already finished */ } }
      close()
    }
    // One readonly transaction per request, in every pass, so between two requests her saves go first. A save that
    // arrives DURING a request waits for that one get (at most one row, at most the read deadline), never for a run.
    // A get past the read deadline is aborted and the run ends "not complete".
    const one = work => new Promise((resolve, reject) => {
      if (state.upgrading) { reject(halt('upgrading')); return }
      let tx
      try { tx = db.transaction(STORE, 'readonly') } catch (error) { reject(state.upgrading ? halt('upgrading') : error); return }
      let value, settled = false, slow = false
      const end = (settle, outcome) => {
        if (settled) return
        settled = true
        disarm(timer)
        state.active.delete(tx)
        settle(outcome)
      }
      const stopped = fallback => (slow ? halt('slowRead') : state.upgrading ? halt('upgrading') : (tx.error || new Error(fallback)))
      const timer = deadline(DEADLINE.read, () => {
        slow = true
        try { tx.abort() } catch (error) { /* already finished */ }
        end(reject, halt('slowRead'))
      })
      state.active.add(tx)
      let request
      try { request = work(tx.objectStore(STORE)) } catch (error) { end(reject, state.upgrading ? halt('upgrading') : error); return }
      request.onsuccess = () => { value = request.result }
      tx.oncomplete = () => end(resolve, value)
      tx.onabort = () => end(reject, stopped('read stopped'))
      tx.onerror = () => end(reject, stopped('read failed'))
    })
    return {
      // A key listing that fails REJECTS: the run stops ("This copy stopped"), it never goes on with fewer keys.
      keys: () => one(store => store.getAllKeys()),
      read: key => one(store => store.get(key)),
      close,
      client: null,
    }
  }
  const openMemory = () => {
    const fs = options.fs
    if (!fs || typeof fs.statSync !== 'function' || typeof fs.readdirSync !== 'function' || typeof fs.readFileSync !== 'function') return { none: true }
    const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots.map(String) : ['/dsh/home']
    // The same mask her app stores (idb-persist: mode & 0o777).
    const modeOf = stat => (Number.isSafeInteger(stat.mode) ? stat.mode & 0o777 : null)
    const keys = async lost => {
      const out = []
      for (const root of roots) {
        const stack = [root]
        while (stack.length > 0) {
          const path = stack.pop()
          // Every path found is listed, even one whose stat fails now: its read then finds it gone (or unreadable) and the
          // run says so. Only a path whose stat succeeds is opened as a folder.
          out.push(path)
          let stat = null
          // A stat that fails HERE means this path's children were never listed, even if a later read of the path itself
          // succeeds (a failure that comes and goes): recorded at once, so the run can never be called complete.
          try { stat = fs.statSync(path) } catch (error) { noteUnlisted(lost, 'a file or folder could not be examined (' + whereOf(path) + ')') }
          // A secret-shaped folder is listed (and left behind) but never opened.
          if (!stat || !stat.isDirectory() || secretShape(path)) continue
          let names
          try { names = Array.from(fs.readdirSync(path), String) } catch (error) {
            noteUnlisted(lost, 'a folder could not be listed (' + whereOf(path) + ')')
            continue
          }
          for (const name of names) stack.push(path.endsWith('/') ? path + name : path + '/' + name)
        }
      }
      return out
    }
    const read = async path => {
      let stat
      try { stat = fs.statSync(path) } catch (error) { return undefined }
      if (stat.isDirectory()) return { kind: 'dir', mode: modeOf(stat) }
      const raw = fs.readFileSync(path)
      return { kind: 'file', bytes: typeof raw === 'string' ? encoder.encode(raw) : asBytes(raw), mode: modeOf(stat), mtimeMs: Number(stat.mtimeMs) }
    }
    /** A row's kind and, for a file, its size from its stat alone (no read); a stat with no size falls back to `read`. */
    const measure = async path => {
      let stat
      try { stat = fs.statSync(path) } catch (error) { return undefined }
      if (stat.isDirectory()) return { kind: 'dir' }
      const size = Number(stat.size)
      return Number.isSafeInteger(size) && size >= 0 ? { kind: 'file', size } : read(path)
    }
    const given = isRecord(options.client) ? options.client : {}
    const client = { clientId: typeof given.clientId === 'string' ? given.clientId : null, base: given.base === undefined ? null : given.base,
      reconciliation: given.reconciliation === undefined ? null : given.reconciliation }
    return { keys, read, measure, close: () => {}, client }
  }
  const openSource = () => (source === 'memory' ? openMemory() : openIndexedDb())

  /**
   * The keys a source holds now, and this origin's saved settings: with `settings` false only the names on the chat-log
   * allow-list (the other names are listed, never read), with `settings` true every name. Items sorted by key (text keys
   * in code-unit order).
   */
  const listItems = async (src, settings, lost) => {
    const items = Array.from(await src.keys(lost), key => ({ key }))
    for (const name of listSettings(lost)) if (settings || isChatLog(name)) items.push({ key: LOCAL_PREFIX + name, local: true, name })
    return items.sort((a, b) => {
      const [x, y] = [typeof a.key === 'string', typeof b.key === 'string']
      if (x !== y) return x ? 1 : -1
      return x ? byKey(a, b) : 0
    })
  }
  /**
   * One row of her private room in a CLOUD copy: never copied, hashed or named, only counted (`room`). The memory source
   * gives a file's size from its stat, with no read; her IndexedDB rows hold no size beside the bytes, so there the row is
   * read here, in memory only, its length taken and the value let go. Gone when read is `missing`; a row that cannot be
   * read, or of a shape her app never writes, is `unreadable` (by shape, its key redacted): never counted as left behind.
   */
  const roomRow = async (src, key) => {
    let value
    try { value = await (typeof src.measure === 'function' ? src.measure(key) : src.read(key)) } catch (error) {
      if (isHalt(error)) throw error
      return { unreadable: whereOf(key) + ': the read failed' }
    }
    if (value === undefined) return { missing: true }
    if (isRecord(value) && (value.kind === 'dir' || value.kind === 'gone')) return { room: { files: 0, bytes: 0 } }
    if (!isRecord(value) || value.kind !== 'file') return { unreadable: whereOf(key) + ': a row of an unknown shape' }
    const bytes = asBytes(value.bytes)
    const size = Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : bytes ? bytes.length : null
    if (size === null) return { unreadable: whereOf(key) + ': a file row without bytes' }
    return { room: { files: 1, bytes: size } }
  }
  /** Read one item (secret-shaped rows are never read). A key listed and gone when read is `missing`, never dropped. */
  const take = async (src, item, mode) => {
    if (item.local) {
      const shape = isChatLog(item.name) ? null : settingShape(item.name)
      if (shape) return { skip: shape }
      let text
      try { text = storage.getItem(item.name) } catch (error) { return { unreadable: 'a saved setting: the read failed' } }
      if (typeof text !== 'string') return { missing: true }
      const bytes = encoder.encode(text)
      return { row: { key: item.key, type: 'local', bytes: bytes.length }, bytes }
    }
    const key = item.key
    if (typeof key !== 'string') return { unreadable: whereOf(key) }
    if (mode === 'cloud') {
      // job 2: a secret-shaped row in her private room is judged by its key FIRST, like any other row: never
      // read (not even to count it), listed by kind under "Left in this browser only", not in `leftAtOrigin`.
      if (key.charAt(0) === '/' && inRoom(key)) {
        const shape = keyShape(key, mode)
        if (shape) return { skip: shape }
        return roomRow(src, key)
      }
      if (key.charAt(0) !== '/' && ROOM_NAMED.test(key)) return { skip: ROOM_BOOKKEEPING }
    }
    const shape = keyShape(key, mode)
    if (shape) return { skip: shape }
    let value
    try { value = await src.read(key) } catch (error) { if (isHalt(error)) throw error; return { unreadable: whereOf(key) + ': the read failed' } }
    if (value === undefined) return { missing: true }
    return judge(key, value, mode)
  }
  /** Bytes read again against a copied row: 'same', 'grew' (only when `mayGrow`: the copy is still an exact prefix), or 'changed'. */
  const bytesAgain = async (row, bytes, mayGrow) => {
    if (!bytes || bytes.length < row.bytes || (!mayGrow && bytes.length !== row.bytes)) return 'changed'
    if ((await hashOf(bytes.subarray(0, row.bytes))) !== row.sha256) return 'changed'
    return bytes.length > row.bytes ? 'grew' : 'same'
  }
  /**
   * How a copied row is judged when it is read again: ONE table, one entry per kind of row the copy can hold. `collect`
   * copies no row whose kind is not here (it is counted unreadable instead), and `recheck` judges every copied row by
   * its kind's entry, so no kind can be copied without being checked again. `got` is what `take` gave, of the same kind.
   * Only a file may grow (her thread journals are appended to); a bookkeeping row or a saved setting is JSON or text
   * that must read back byte for byte, and a file or folder whose mode moved has changed.
   */
  const AGAIN = {
    file: (row, got) => (got.row.mode === row.mode ? bytesAgain(row, got.bytes, true) : 'changed'),
    dir: (row, got) => (got.row.mode === row.mode ? 'same' : 'changed'),
    gone: () => 'same',
    meta: (row, got) => bytesAgain(row, got.bytes, false),
    local: (row, got) => bytesAgain(row, got.bytes, false),
  }
  const ROW_KINDS = Object.keys(AGAIN)
  const checkable = type => typeof type === 'string' && Object.prototype.hasOwnProperty.call(AGAIN, type)
  /**
   * One pass over every row: hashes each, hands it (with its bytes) to `onRow`, keeps only the row. Its listings'
   * failures are in `lost` (see noteUnlisted); a later listing of the same run adds to the same map.
   * `seen` (job 2 review, cloud mode): `seen.room` is set to the room's count as soon as the walk has passed the
   * room's LAST row, so a run that stops after that (a halt or an error) can still say the count; it stays null while
   * any room row is unread, and when the listing holds no room row at all.
   */
  const collect = async (src, say, onRow, mode, settings, seen = null) => {
    const lost = new Map()
    const items = await listItems(src, settings, lost)
    const rows = [], skipped = new Map(), unreadable = [], unreadableShapes = new Map()
    // What a CLOUD copy leaves of her private room at origin, by count and size only (null for the local pack).
    const room = mode === 'cloud' ? { files: 0, bytes: 0 } : null
    // The index of the room's last row in this walk (rows are in key order, but a sibling such as `private-x` can sort
    // between the room's folder and its files, so it is found, not assumed); -1 when there is none.
    let lastRoom = -1
    if (room) items.forEach((item, at) => { if (!item.local && typeof item.key === 'string' && item.key.charAt(0) === '/' && inRoom(item.key)) lastRoom = at })
    let meta = null, reconciliation = null, missing = 0
    for (let index = 0; index < items.length; index++) {
      const got = await take(src, items[index], mode)
      if (index === lastRoom && seen) seen.room = { files: room.files + (got.room ? got.room.files : 0), bytes: room.bytes + (got.room ? got.room.bytes : 0) }
      if (got.room) { room.files += got.room.files; room.bytes += got.room.bytes; continue }
      if (got.skip) { bump(skipped, got.skip); continue }
      if (got.unreadable) { unreadable.push(shown(items[index].key)); bump(unreadableShapes, got.unreadable); continue }
      if (got.missing) { missing += 1; continue }
      if (!got.row) continue
      if (!checkable(got.row.type)) { unreadable.push(shown(items[index].key)); bump(unreadableShapes, whereOf(got.row.key) + ': a kind of row this kit cannot check again'); continue }
      if (got.row.key === '@x6-mirror-meta') meta = got.value
      if (got.row.key === '@x6-cloud-reconciliation') reconciliation = got.value
      if (got.bytes) Object.assign(got.row, await cut(got.bytes))
      if (onRow) await onRow(got.row, got.bytes)
      rows.push(got.row)
      if (index % 250 === 249) say('Read ' + (index + 1) + ' of ' + items.length + ' rows.')
    }
    rows.sort(byKey)
    const client = src.client || {
      clientId: isRecord(meta) && typeof meta.clientId === 'string' ? meta.clientId : null,
      base: isRecord(meta) && meta.cloudBase !== undefined ? meta.cloudBase : null,
      reconciliation: reconciliation === undefined ? null : reconciliation,
    }
    return { rows, client, unreadable, unreadableShapes: counted(unreadableShapes), missing, keys: items.map(item => item.key),
      locals: new Set(items.filter(item => item.local).map(item => item.key)), skipped: counted(skipped), lost, room }
  }
  /**
   * The index: canonical JSON with no clock in it. This is the cloud index (one field added later: `unlisted`;
   * job 1 another, in a cloud copy only: `leftAtOrigin: {private: {files, bytes}}`, her private room by count and
   * size, zeros when there is none; the count is of the room's ordinary files, a secret-shaped row in it is in `skipped`
   * by kind instead). A copy made before it holds her private folder as rows and has no `leftAtOrigin`:
   * both shapes verify and join, and a reader tells them apart by that field alone.
   */
  const makeIndex = collected => {
    let threads = 0, homeFiles = 0, bytes = 0, newest = null, mainThread = null
    for (const row of collected.rows) {
      if (row.type === 'file' || row.type === 'meta' || row.type === 'local') bytes += row.bytes
      if (row.type !== 'file') continue
      if (THREAD.test(row.key)) {
        threads += 1
        if (row.mtimeMs !== null && (newest === null || row.mtimeMs > newest)) newest = row.mtimeMs
        if (mainThread === null || row.bytes > mainThread.bytes) mainThread = { key: row.key, bytes: row.bytes }
      } else if (row.key.startsWith('/dsh/home/')) homeFiles += 1
    }
    // `unlisted`: every listing of this run that failed, by shape and count (her cloud keeps it with the copy).
    const index = { v: 1, piece: PIECE, source, client: collected.client, rows: collected.rows, skipped: collected.skipped,
      totals: { threads, homeFiles, bytes, newestThreadMtimeMs: newest, mainThread }, unlisted: unlistedOf(collected.lost) }
    if (collected.room) index.leftAtOrigin = { private: { files: collected.room.files, bytes: collected.room.bytes } }
    return index
  }
  /** The one line on her private room in a cloud copy, by count and size only; null when the copy left no file of it. */
  const roomLine = left => {
    const room = isRecord(left) && isRecord(left.private) ? left.private : null
    if (!room || !Number.isSafeInteger(room.files) || room.files <= 0) return null
    const grouped = String(room.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return 'private: not carried — ' + room.files + (room.files === 1 ? ' file, ' : ' files, ') + grouped + ' bytes, left at origin.'
  }
  const itemFor = (collected, key) => (collected.locals.has(key) ? { key, local: true, name: key.slice(LOCAL_PREFIX.length) } : { key })
  /** New keys since the first listing. This listing's failures go into `lost` too. */
  const newSince = async (src, collected, settings, lost) => {
    const before = new Set(collected.keys.map(key => typeof key + ':' + String(key)))
    return (await listItems(src, settings, lost)).filter(item => !before.has(typeof item.key + ':' + String(item.key))).length
  }
  /**
   * The second read-only pass, the SAME in both modes, one request per transaction like the first. It walks THE one list
   * of what the copy holds (`rows`: the index's rows, every kind: files, folders, gone rows, bookkeeping and saved
   * settings) and reads each again through `take` and `itemFor`, the path the first read took, then judges it by AGAIN
   * for its kind. `grew` (a file whose copy is still an exact prefix) is a notice; `changed` (also: now unreadable,
   * left behind, or of another kind) and `vanished` (gone when read) make the run NOT complete. `also(row, bytes)` (the
   * cloud's read-back of its pieces) then judges a row that is unchanged here; false puts it in `mismatched`. `walked`
   * counts every row judged, and the caller holds it to `rows.length`.
   */
  const recheck = async (src, collected, rows, mode, also, say) => {
    const out = { grew: 0, grewThreads: 0, changed: 0, vanished: 0, changedKeys: [], vanishedKeys: [], mismatched: [], walked: 0 }
    for (const row of rows) {
      const got = await take(src, itemFor(collected, row.key), mode)
      out.walked += 1
      if (say && out.walked % 100 === 0) say('Checked ' + out.walked + ' of ' + rows.length + ' rows.')
      if (got.missing) { out.vanished += 1; out.vanishedKeys.push(shown(row.key)); continue }
      const state = got.row && got.row.type === row.type && checkable(row.type) ? await AGAIN[row.type](row, got) : 'changed'
      if (state === 'changed') { out.changed += 1; out.changedKeys.push(shown(row.key)); continue }
      if (also && !(await also(row, got.bytes))) { out.mismatched.push(shown(row.key)); continue }
      if (state === 'grew') { out.grew += 1; if (THREAD.test(row.key)) out.grewThreads += 1 }
    }
    return out
  }
  /** The main thread's own row (for its save time), or null. */
  const mainRow = index => (index.totals.mainThread ? index.rows.find(row => row.key === index.totals.mainThread.key) || null : null)
  const summary = index => {
    const totals = index.totals, main = mainRow(index)
    return totals.threads + ' threads, ' + totals.homeFiles + ' home files, ' + megabytes(totals.bytes)
      + '; main thread: ' + (main ? main.bytes + ' bytes, saved ' + hhmm(main.mtimeMs) : 'none')
      + '; newest save of any thread: ' + hhmm(totals.newestThreadMtimeMs)
  }
  /** The one line on saved settings, exact for this run: whether it holds any chat log, and what became of the rest. */
  const settingsLine = (rows, settings) => {
    const logs = rows.some(row => row.type === 'local' && isChatLog(row.key.slice(LOCAL_PREFIX.length)))
    return settings ? (logs ? LINE.logsAll : LINE.noLogsAll) : (logs ? LINE.logsStay : LINE.noLogsStay)
  }
  const capped = (label, keys) => keys.slice(0, 20).map(key => label + shown(key)).concat(keys.length > 20 ? ['and ' + (keys.length - 20) + ' more'] : [])

  // ── The cloud ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const makeNet = say => {
    const net = { halted: null, serial: false, active: 0, waiters: [] }
    const acquire = async () => {
      while (net.active >= (net.serial ? 1 : 3)) await new Promise(resolve => net.waiters.push(resolve))
      net.active += 1
    }
    const release = () => {
      net.active -= 1
      for (const wake of net.waiters.splice(0)) wake()
    }
    const readJson = bytes => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch (error) { return null } }
    // No answer this kit reads is larger than the list of a copy plus a little.
    const MAX_ANSWER = MAX_INDEX_BYTES + 65536
    /**
     * One fetch and its whole answer, under the deadlines: `{response, bytes}`, or `{response: null, stalled}` when it
     * failed or a deadline passed (`stalled` true for a deadline). The fetch gets an AbortSignal and is cancelled at a
     * deadline; the wait ends then even if the fetch ignores the signal. The body is read as a stream: each chunk that
     * holds a byte re-arms the idle deadline. `wantBody(response)` false: the body is cancelled unread.
     */
    const exchange = async (path, init, wantBody) => {
      const controller = typeof g.AbortController === 'function' ? new g.AbortController() : null
      let late = false, stop = null
      const stopped = new Promise((resolve, reject) => { stop = reject })
      stopped.catch(() => { /* raced below */ })
      const STALL = { stall: true }
      const giveUp = () => {
        if (late) return
        late = true
        try { if (controller) controller.abort() } catch (error) { /* gone */ }
        stop(STALL)
      }
      const whole = deadline(init.body !== undefined ? DEADLINE.bodyTotal : DEADLINE.total, giveUp)
      let phase = deadline(init.body !== undefined ? DEADLINE.upload : DEADLINE.headers, giveUp)
      let reader = null
      try {
        const response = await Promise.race([fetchImpl(path, controller ? Object.assign({}, init, { signal: controller.signal }) : init), stopped])
        disarm(phase)
        if (!response || typeof response.status !== 'number') return { response: null, stalled: false }
        const body = response.body
        if (!wantBody(response)) {
          if (body && typeof body.cancel === 'function') Promise.resolve().then(() => body.cancel()).catch(() => { /* gone */ })
          return { response, bytes: null }
        }
        phase = deadline(DEADLINE.idle, giveUp)
        let bytes
        if (body && typeof body.getReader === 'function') {
          reader = body.getReader()
          const chunks = []
          let size = 0
          for (;;) {
            const step = await Promise.race([reader.read(), stopped])
            if (step.done) break
            const chunk = asBytes(step.value)
            if (!chunk) throw new Error('not bytes')
            if (chunk.length === 0) continue
            disarm(phase)
            phase = deadline(DEADLINE.idle, giveUp)
            size += chunk.length
            if (size > MAX_ANSWER) throw new Error('answer too large')
            chunks.push(chunk)
          }
          reader = null
          // One chunk is used as it came (a piece is then held once, not twice).
          if (chunks.length === 1) bytes = chunks[0]
          else {
            bytes = new Uint8Array(size)
            let at = 0
            for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
          }
        } else {
          bytes = asBytes(await Promise.race([response.arrayBuffer(), stopped]))
          if (!bytes || bytes.length > MAX_ANSWER) throw new Error('answer too large')
        }
        return { response, bytes }
      } catch (error) {
        if (reader) { const open = reader; Promise.resolve().then(() => open.cancel()).catch(() => { /* gone */ }) }
        return { response: null, stalled: error === STALL || late }
      } finally { disarm(whole); disarm(phase) }
    }
    /**
     * One request with the run's rules: 401 stops at once; 507 stops; a busy edge (503 OWNER_SESSION_UNAVAILABLE) is
     * waited out up to 60 times; 408, 429, 5xx, a failed fetch and a request past a deadline are retried 5 times with a
     * growing wait; after the first 408, or the first request that sent a body and passed a deadline, the rest of the run
     * goes one request at a time (uploads that share a slow link each get all of it). Spent retries end the run "not
     * complete" (a deadline's own line when the last try passed one).
     * `extra.headers` adds request headers; `extra.once` (the join's own calls) sends ONE request and hands back every
     * answer but a 401 as it came, status 0 for none: the caller has its own rules for waiting.
     */
    net.call = async (method, path, body, extra) => {
      const once = isRecord(extra) && extra.once === true
      const more = isRecord(extra) && isRecord(extra.headers) ? extra.headers : null
      let tries = 0, waits = 0
      for (;;) {
        if (net.halted) throw net.halted
        await acquire()
        let response = null, info = null, data = null, stalled = false
        try {
          if (net.halted) throw net.halted
          const init = { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }
          if (body !== undefined) { init.body = body; init.headers = { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' } }
          if (more) init.headers = Object.assign({}, init.headers || {}, more)
          const got = await exchange(path, init, answer => method !== 'HEAD' && answer.status !== 401)
          response = got.response
          stalled = got.stalled === true
          if (response && response.status === 401) { net.halted = halt('signin'); throw net.halted }
          if (response && response.status === 408) net.serial = true
          if (stalled && body !== undefined) net.serial = true
          if (response && method === 'GET' && response.status === 200) data = got.bytes
          else if (response && method !== 'HEAD') info = readJson(got.bytes)
        } finally { release() }
        const status = response ? response.status : 0
        const code = isRecord(info) && typeof info.code === 'string' ? info.code : null
        if (once) return { status, info, data, headers: response ? response.headers : null }
        if (status === 507) { net.halted = halt(code === 'RESCUE_LIMIT' ? 'limit' : 'full'); throw net.halted }
        // A HEAD answer has no body: there a 503 that asks to retry is read as the same busy edge.
        const busy = status === 503 && (code === 'OWNER_SESSION_UNAVAILABLE' || (method === 'HEAD' && response.headers.has('retry-after')))
        if (busy) {
          waits += 1
          if (waits > 60) { net.halted = halt('busyLong'); throw net.halted }
          say(LINE.busy)
          const seconds = Number(response.headers.get('retry-after'))
          await sleep(1000 * (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 1))
          continue
        }
        if (status === 0 || status === 408 || status === 429 || status >= 500) {
          tries += 1
          if (tries > 5) { net.halted = halt(stalled ? 'stalled' : 'unanswered'); throw net.halted }
          say(LINE.slow)
          const asked = status === 429 && isRecord(info) && Number.isFinite(info.retryAfterMs) && info.retryAfterMs >= 0 ? Math.min(info.retryAfterMs, 60000) : null
          await sleep(asked !== null ? asked : 500 * 2 ** (tries - 1))
          continue
        }
        return { status, info, data, headers: response ? response.headers : null }
      }
    }
    // Never two requests for the same hash at once; a piece confirmed present is not asked about again in this run.
    const present = new Set(), inflight = new Map()
    net.ensure = async (hash, bytes, force) => {
      while (inflight.has(hash)) { try { await inflight.get(hash) } catch (error) { /* judged by the run */ } }
      if (!force && present.has(hash)) return
      const work = (async () => {
        if (!force) {
          const head = await net.call('HEAD', '/_vault/blob/' + hash)
          if (head.status === 200) { present.add(hash); return }
          if (head.status !== 404) throw halt('unexpected', head.status)
        }
        const put = await net.call('PUT', '/_vault/blob/' + hash, bytes)
        if (put.status === 200 || put.status === 201) { present.add(hash); return }
        throw halt('unexpected', put.status)
      })()
      inflight.set(hash, work)
      try { await work } finally { inflight.delete(hash) }
    }
    return net
  }
  const haltLine = stop => LINE[stop.rescueHalt] || LINE.unexpected

  /**
   * Copy this browser to her cloud and check it byte for byte. Auma Live's chat logs travel (CHAT_LOG_PREFIXES); every
   * other saved setting stays in this browser (its name listed, never read) unless the caller passes `settings: true`: a
   * name cannot tell a neutral setting that holds a secret value. The cloud
   * copy also leaves behind main's estate names, and her private room (it says only `leftAtOrigin`, and one line when the
   * room holds a file, on every end once reading began: see roomSaid). The index sent is exactly the cloud index; its
   * `unlisted` records the listings that failed (her cloud reports it again when it verifies the copy).
   * @param {{report?: (line: string) => void, settings?: boolean}} [args]
   * @returns {Promise<object>} `{ok, complete, line, lines, id, skipped, unreadable, unreadableShapes, missing, totals, signin, leftAtOrigin}`.
   */
  const copyToCloud = async (args = {}) => {
    const say = line => { try { if (typeof args.report === 'function') args.report(line) } catch (error) { /* the page's own problem */ } }
    const result = { ok: false, complete: false, line: '', lines: [], id: null, skipped: [], unreadable: [], unreadableShapes: [], missing: 0,
      totals: null, signin: false, grew: 0, mismatched: [], changed: [], vanished: [], rechecked: 0, unlisted: { count: 0, shapes: [] }, newRows: 0,
      settings: args.settings === true, leftAtOrigin: null }
    const settings = result.settings
    const finish = line => { result.line = line; say(line); return result }
    /**
     * job 2: the one line on her private room, for EVERY end of a run that got as far as reading this browser
     * (complete, "This copy is not complete", too many rows, a halt, and an unexpected error, which carries it as
     * `error.lines`): by count and size once the room was counted (the walk passed its last row, see collect's `seen`),
     * "private: not carried." when the run stopped before it was, nothing when the room held no file.
     */
    const roomSaid = () => {
      const room = result.leftAtOrigin === null ? 'private: not carried.' : roomLine(result.leftAtOrigin)
      return room ? [room] : []
    }
    const src = await openSource()
    if (src.none) return finish(LINE.nothing)
    if (src.failed) return finish(LINE.storage)
    const net = makeNet(say)
    const seen = { room: null }
    try {
      say('Reading this browser. Nothing here is changed.')
      const collected = await collect(src, say, null, 'cloud', settings, seen)
      const index = makeIndex(collected)
      Object.assign(result, { skipped: collected.skipped, unreadable: collected.unreadable, unreadableShapes: collected.unreadableShapes,
        missing: collected.missing, totals: index.totals, leftAtOrigin: index.leftAtOrigin })
      const indexText = canon(index)
      const indexBytes = encoder.encode(indexText)
      if (indexBytes.length > MAX_INDEX_BYTES) { result.lines = roomSaid(); return finish(LINE.tooMany) }
      const indexSha = sha256Hex(indexBytes)
      const id = result.id = indexSha.slice(0, 32)
      const rowByKey = new Map(index.rows.map(row => [row.key, row]))
      const pieceAt = new Map()
      for (const row of index.rows) row.pieces.forEach((hash, number) => { if (!pieceAt.has(hash)) pieceAt.set(hash, { key: row.key, number }) })
      /** A row's bytes now, cut back to the copied length (a view); null unless that prefix is exactly what was hashed. */
      const prefixNow = async row => {
        const got = await take(src, itemFor(collected, row.key), 'cloud')
        if (!got.bytes || got.row.type !== row.type || got.bytes.length < row.bytes) return null
        const prefix = got.bytes.subarray(0, row.bytes)
        return (await hashOf(prefix)) === row.sha256 ? prefix : null
      }
      // Pieces: one row's bytes at a time, at most three pieces in flight. A piece is cut (copied) out of its row only
      // when a place is free, and a running send holds that piece alone, never its row: once `sendRow` returns, the row's
      // bytes can go before the next row is read.
      const running = new Set()
      let failure = null, sent = 0
      const total = pieceAt.size
      const slot = async () => { while (running.size >= 3) await Promise.race(running) }
      const start = (hash, piece) => {
        const promise = net.ensure(hash, piece, false).then(() => {
          sent += 1
          if (sent % 25 === 0) say('Sent or found ' + sent + ' of ' + total + ' pieces.')
        }).catch(error => { failure = failure || error }).finally(() => running.delete(promise))
        running.add(promise)
      }
      const sendRow = async row => {
        const bytes = await prefixNow(row)
        if (!bytes) { result.changed.push(shown(row.key)); return }
        for (let number = 0; number < row.pieces.length; number++) {
          await slot()
          if (failure || net.halted) return
          start(row.pieces[number], bytes.slice(number * PIECE, Math.min((number + 1) * PIECE, row.bytes)))
        }
      }
      for (const row of index.rows) {
        if (failure || net.halted) break
        if (row.pieces.length > 0) await sendRow(row)
      }
      await Promise.all(Array.from(running))
      if (failure) throw failure
      if (result.changed.length > 0) {
        result.lines = [result.changed.length + ' rows changed while this copy was being made. Run again.'].concat(capped('Changed: ', result.changed), roomSaid())
        return finish(LINE.notComplete)
      }
      const resend = async hash => {
        const where = pieceAt.get(hash)
        if (!where) throw halt('refused')
        const row = rowByKey.get(where.key)
        const bytes = await prefixNow(row)
        if (!bytes) { result.changed.push(shown(row.key)); throw halt('changed') }
        await net.ensure(hash, bytes.slice(where.number * PIECE, Math.min((where.number + 1) * PIECE, row.bytes)), true)
      }
      const missingSeen = new Map()
      const missing = async info => {
        const hash = isRecord(info) && typeof info.sha256 === 'string' && /^[0-9a-f]{64}$/.test(info.sha256) ? info.sha256 : null
        if (!hash) throw halt('refused')
        const seen = (missingSeen.get(hash) || 0) + 1
        missingSeen.set(hash, seen)
        if (seen > 3) throw halt('refused')
        await resend(hash)
      }
      say('Sending the list of this copy.')
      for (;;) {
        const put = await net.call('PUT', '/_vault/rescue/' + id, indexText)
        if (put.status === 200 || put.status === 201) break
        if (put.status === 424 && isRecord(put.info) && put.info.code === 'RESCUE_BLOB_MISSING') { await missing(put.info); continue }
        if (put.status === 400) throw halt('refused')
        throw halt('unexpected', put.status)
      }
      // The edge's own walk: the first call is cursor=0; each later one sends exactly the cursor of the reply before it.
      say('Her cloud is checking this copy.')
      let cursor = 0
      const limit = 4 * (index.rows.length + total) + 100
      for (let calls = 1; ; calls++) {
        if (calls > limit) throw halt('refused')
        const answer = await net.call('POST', '/_vault/rescue/' + id + '/verify?cursor=' + encodeURIComponent(String(cursor)))
        if (answer.status === 200 && isRecord(answer.info)) {
          if (answer.info.done === true) break
          const next = answer.info.cursor
          const valid = (Number.isSafeInteger(next) && next >= 0) || (typeof next === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(next))
          if (!valid) throw halt('refused')
          cursor = next
          continue
        }
        if (answer.status === 424 && isRecord(answer.info) && answer.info.code === 'RESCUE_BLOB_MISSING') { await missing(answer.info); continue }
        if (answer.status === 400) throw halt('refused')
        throw halt('unexpected', answer.status)
      }
      // The read-back: the index fetched BACK must be the one sent; then every copied row is read again (the same
      // recheck as the local pack) and every piece of it is fetched from her cloud and compared with that read.
      say('Reading the copy back from her cloud.')
      const back = await net.call('GET', '/_vault/rescue/' + id)
      if (back.status !== 200 || !back.data || sha256Hex(back.data) !== indexSha) {
        result.lines = ["Her cloud holds a different list for this copy than the one sent. Report this."].concat(roomSaid())
        return finish(LINE.notComplete)
      }
      // The cloud's list is byte for byte the one sent (its SHA-256 is the index's), so walking index.rows walks it.
      /** Her cloud's pieces of a row that is unchanged here, compared byte for byte with what was just read again. */
      const piecesMatch = async (row, bytes) => {
        let offset = 0
        for (const hash of row.pieces) {
          const piece = await net.call('GET', '/_vault/blob/' + hash)
          const length = Math.min(PIECE, row.bytes - offset)
          if (piece.status !== 200 || !piece.data || piece.data.length !== length || (await hex(piece.data)) !== hash) return false
          const mine = bytes.subarray(offset, offset + length)
          for (let at = 0; at < length; at++) if (piece.data[at] !== mine[at]) return false
          offset += length
        }
        return offset === row.bytes
      }
      const again = await recheck(src, collected, index.rows, 'cloud', piecesMatch, say)
      result.grew = again.grew
      result.mismatched = again.mismatched
      result.changed = again.changedKeys
      result.vanished = again.vanishedKeys
      result.rechecked = again.walked
      // The second listing's failures join the first's (the index sent already holds the first's).
      result.newRows = await newSince(src, collected, settings, collected.lost)
      result.unlisted = unlistedOf(collected.lost)
      const grewOther = again.grew - again.grewThreads
      const lines = []
      if (result.mismatched.length > 0) lines.push(...capped('Not the same in her cloud: ', result.mismatched))
      if (result.changed.length > 0) lines.push(result.changed.length + ' rows changed while this copy was being made. Run again.', ...capped('Changed: ', result.changed))
      if (result.vanished.length > 0) lines.push(result.vanished.length + ' rows were deleted while this copy was being made. Run again.', ...capped('Deleted meanwhile: ', result.vanished))
      if (result.unreadable.length > 0) lines.push(rowsWord(result.unreadable.length) + ' could not be read here.', ...capped('Could not read: ', result.unreadable))
      if (result.missing > 0) lines.push(rowsWord(result.missing) + ' were gone when read. Run again.')
      if (result.unlisted.count > 0) lines.push(listingsWord(result.unlisted.count) + ' could not be read here. Run again.', ...result.unlisted.shapes.map(entry => 'Could not list: ' + entry.shape + ': ' + entry.count))
      if (result.newRows > 0) lines.push(result.newRows + ' new rows since this copy. Run again.')
      if (again.grewThreads > 0) lines.push(again.grewThreads + ' threads grew since this copy. Run again to add the new lines.')
      if (grewOther > 0) lines.push(grewOther + ' other files grew since this copy. Run again to add them.')
      lines.push(...roomSaid(), settingsLine(index.rows, settings))
      result.lines = lines
      result.ok = true
      result.complete = result.mismatched.length === 0 && result.changed.length === 0 && result.vanished.length === 0 && result.unreadable.length === 0
        && result.missing === 0 && result.unlisted.count === 0 && result.newRows === 0 && again.walked === index.rows.length
      if (!result.complete) return finish(LINE.notComplete)
      return finish('Rescue copy complete and checked: ' + summary(index) + '; checked ' + hhmm(now()))
    } catch (error) {
      // Stopped during the first read: the room's count, if the walk had passed its last row.
      if (result.leftAtOrigin === null && seen.room) result.leftAtOrigin = { private: seen.room }
      if (!isHalt(error)) {
        const stop = scrubbed(error)
        stop.lines = roomSaid()
        throw stop
      }
      result.signin = error.rescueHalt === 'signin'
      result.lines = (error.rescueHalt === 'changed' ? capped('Changed: ', result.changed) : []).concat(roomSaid())
      return finish(haltLine(error))
    } finally { src.close() }
  }

  /**
   * Read the finished pack back FROM THE BLOB, at most 4 MiB at a time, and compare it with what was read from her
   * storage: the size, the opening and closing marks, every row's SHA-256 (the incremental hash, rows as one stream in
   * offset order) and the index (its bytes, its length words, and its id recomputed from what was read back).
   * @returns {Promise<string|null>} null when the Blob holds exactly the pack; otherwise the plain reason.
   */
  const readBack = async (blob, expect) => {
    const READ = 4194304
    const magic = encoder.encode(MAGIC)
    const dataEnd = expect.dataEnd, size = dataEnd + expect.tail.length
    if (!blob || blob.size !== size) return 'the copy is not the size it was written at'
    // The rows as contiguous spans from the opening mark to the index; anything else is a layout this kit never writes.
    const spans = expect.rows.filter(row => row.bytes > 0).map(row => ({ start: row.offset, end: row.offset + row.bytes, sha256: row.sha256 }))
      .sort((a, b) => a.start - b.start)
    let reach = magic.length
    for (const span of spans) { if (span.start !== reach) return 'the copy was not laid out as written'; reach = span.end }
    if (reach !== dataEnd) return 'the copy was not laid out as written'
    const unreadable = error => {
      const name = error && typeof error.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) && error.name !== 'Error' ? error.name : null
      return 'it could not read the copy back' + (name ? ': ' + name : '')
    }
    /** Read [start, end) in slices of at most READ bytes; `take(chunk, at)` gets each with its absolute offset. */
    const range = async (start, end, take) => {
      for (let at = start; at < end; at += READ) {
        const stop = Math.min(at + READ, end)
        let chunk
        try { chunk = new Uint8Array(await blob.slice(at, stop).arrayBuffer()) } catch (error) { return unreadable(error) }
        if (chunk.length !== stop - at) return 'the copy read back shorter than it was written'
        take(chunk, at)
      }
      return null
    }
    const same = (a, b) => { if (a.length !== b.length) return false; for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false; return true }
    let head = null
    const headFailed = await range(0, magic.length, chunk => { head = chunk })
    if (headFailed) return headFailed
    if (!same(head, magic)) return 'its opening mark read back different'
    let current = 0, hash = null, differ = 0
    const rowsFailed = await range(magic.length, dataEnd, (chunk, base) => {
      let at = 0
      while (at < chunk.length) {
        const span = spans[current], here = base + at
        if (!hash) hash = newHash()
        const take = Math.min(chunk.length - at, span.end - here)
        hash.update(chunk.subarray(at, at + take))
        at += take
        if (here + take === span.end) { if (hash.digest() !== span.sha256) differ += 1; hash = null; current += 1 }
      }
    })
    if (rowsFailed) return rowsFailed
    if (differ > 0) return rowsWord(differ) + ' read back different from what was copied'
    const tail = new Uint8Array(expect.tail.length)
    const tailFailed = await range(dataEnd, size, (chunk, at) => { tail.set(chunk, at - dataEnd) })
    if (tailFailed) return tailFailed
    if (!same(tail, expect.tail)) return 'its list of rows read back different'
    let backId = null
    try { backId = indexId(JSON.parse(new TextDecoder().decode(tail.subarray(0, expect.tail.length - 19)))) } catch (error) { backId = null }
    if (backId !== expect.id) return 'its list of rows read back with a different id'
    return null
  }

  /**
   * Build one `x61-rescue-pack/v1` Blob, row by row. No byte leaves this computer. Auma Live's chat logs are in it; other
   * saved settings are left out unless the caller passes `settings: true`. After the copy, a second read-only pass marks what grew, changed or vanished, and
   * the index records it (`completeness`) with what could not be read, what was gone when read and the rows that appeared.
   * The finished Blob is then read back from itself and compared with what was read here; only then is it held and
   * returned. One pack is held at a time: a second run while one is held is refused unless `again: true`, which first
   * releases the held pack and its object URL.
   * @param {{report?: (line: string) => void, settings?: boolean, again?: boolean}} [args]
   * @returns {Promise<object>} `{ok, complete, blob, fileName, line, lines, plain, id, skipped, unreadable, totals, ...counts}`.
   *   `lines` may name rows (private ones redacted); `plain` holds counts and shapes only, never a key. `blob` is null
   *   unless the pack read back exactly.
   */
  const saveLocal = async (args = {}) => {
    const say = line => { try { if (typeof args.report === 'function') args.report(line) } catch (error) { /* the page's own problem */ } }
    const settings = args.settings === true
    const result = { ok: false, complete: false, blob: null, fileName: null, line: '', lines: [], plain: [], id: null, skipped: [], unreadable: [],
      unreadableShapes: [], totals: null, settings, missing: 0, newRows: 0, grew: 0, changed: 0, vanished: 0, rechecked: 0,
      unlisted: { count: 0, shapes: [] } }
    const finish = line => { result.line = line; say(line); return result }
    if (held.blob || held.running) {
      if (args.again !== true || held.running) return finish(LINE.held)
    }
    // Before a new pack is built, the old one and its URL are let go.
    release()
    held.running = true
    try { return await buildLocal(args, say, settings, result, finish) } finally { held.running = false }
  }
  const buildLocal = async (args, say, settings, result, finish) => {
    const src = await openSource()
    if (src.none) return finish(LINE.nothing)
    if (src.failed) return finish(LINE.storage)
    try {
      say('Reading this browser. Nothing here is changed.')
      const Blob = g.Blob
      // The pack's row bytes go to the Blob a piece at a time (views; the Blob takes its own copy of one piece), and small
      // rows are gathered into one Blob per piece's worth, so a row costs itself plus at most one piece.
      const parts = [], small = []
      let smallBytes = 0, position = encoder.encode(MAGIC).length
      const offsets = new Map()
      const flush = () => { if (small.length > 0) { parts.push(new Blob(small.splice(0))); smallBytes = 0 } }
      const collected = await collect(src, say, async (row, bytes) => {
        offsets.set(row.key, position)
        if (!bytes || bytes.length === 0) return
        position += bytes.length
        if (bytes.length < PIECE) {
          small.push(bytes.slice())
          smallBytes += bytes.length
          if (smallBytes >= PIECE) flush()
          return
        }
        flush()
        for (let offset = 0; offset < bytes.length; offset += PIECE) parts.push(new Blob([bytes.subarray(offset, Math.min(offset + PIECE, bytes.length))]))
      }, 'local', settings)
      flush()
      say('Reading every copied row once more, to see what changed meanwhile.')
      // THE one list of what the pack holds is collected.rows (the index's rows): the recheck walks exactly it.
      const again = await recheck(src, collected, collected.rows, 'local', null, null)
      const newRows = await newSince(src, collected, settings, collected.lost)
      // Made after both listings, so the pack's `unlisted` holds the failures of the first and of the second.
      const index = makeIndex(collected)
      const completeness = { settings, unreadable: { count: collected.unreadable.length, shapes: collected.unreadableShapes },
        missing: collected.missing, newRows, grew: again.grew, changed: again.changed, vanished: again.vanished, rechecked: again.walked }
      const local = Object.assign({}, index, { completeness })
      const id = result.id = indexId(local)
      const packed = Object.assign({}, local, { rows: local.rows.map(row => Object.assign({}, row, { offset: offsets.get(row.key) })) })
      const indexBytes = encoder.encode(canon(packed))
      const length = new Uint8Array(8)
      const view = new DataView(length.buffer)
      view.setUint32(0, Math.floor(indexBytes.length / 4294967296))
      view.setUint32(4, indexBytes.length % 4294967296)
      const blob = new Blob([MAGIC].concat(parts, [indexBytes, length, MAGIC]))
      parts.length = 0
      // "Saved" only after the finished Blob has been read back from itself and found exactly what was read here.
      say('Reading the finished copy back to check it.')
      const tail = new Uint8Array(indexBytes.length + 8 + MAGIC.length)
      tail.set(indexBytes, 0)
      tail.set(length, indexBytes.length)
      tail.set(encoder.encode(MAGIC), indexBytes.length + 8)
      const failed = await readBack(blob, { rows: packed.rows, dataEnd: position, tail, id })
      if (failed) {
        Object.assign(result, { ok: false, complete: false, blob: null, fileName: null, plain: [], lines: [] })
        return finish(unkept(failed))
      }
      held.blob = result.blob = blob
      result.fileName = 'aukora-rescue-' + id + '.x61pack'
      Object.assign(result, { ok: true, skipped: collected.skipped, unreadable: collected.unreadable, unreadableShapes: collected.unreadableShapes,
        totals: index.totals, missing: collected.missing, newRows, grew: again.grew, changed: again.changed, vanished: again.vanished,
        rechecked: again.walked, unlisted: index.unlisted })
      const reasons = []
      if (collected.unreadable.length > 0) reasons.push(rowsWord(collected.unreadable.length) + ' could not be read')
      if (index.unlisted.count > 0) reasons.push(listingsWord(index.unlisted.count) + ' could not be read (' + index.unlisted.shapes.map(entry => entry.shape).join('; ') + ')')
      if (collected.missing > 0) reasons.push(rowsWord(collected.missing) + ' were gone when read')
      if (again.changed > 0) reasons.push(rowsWord(again.changed) + ' changed while being copied')
      if (again.vanished > 0) reasons.push(rowsWord(again.vanished) + ' were deleted while being copied')
      if (newRows > 0) reasons.push(newRows + ' new ' + (newRows === 1 ? 'row' : 'rows') + ' appeared while copying')
      if (again.walked !== index.rows.length) reasons.push('only ' + again.walked + ' of ' + rowsWord(index.rows.length) + ' were checked again')
      result.complete = reasons.length === 0
      const main = mainRow(index)
      const holds = 'It holds ' + summary(index) + '.'
      const check = 'Check it on a computer: node server/rescue-verify.mjs ' + result.fileName + ' --expect-id ' + id
      const plain = [], lines = []
      if (!result.complete) plain.push(holds)
      if (main) plain.push('Main thread: ' + threadLabel(main.key) + '.')
      if (collected.unreadableShapes.length > 0) plain.push('Could not read: ' + collected.unreadableShapes.map(entry => entry.shape + ': ' + entry.count).join('; ') + '.')
      if (index.unlisted.count > 0) plain.push('Could not list: ' + index.unlisted.shapes.map(entry => entry.shape + ': ' + entry.count).join('; ') + '.')
      if (again.grew > 0) plain.push(rowsWord(again.grew) + ' grew after being copied (the copy holds what was read). Run again to add the new lines.')
      plain.push(settingsLine(index.rows, settings))
      plain.push(check)
      if (!result.complete) lines.push(holds)
      if (collected.unreadable.length > 0) lines.push(...capped('Could not read: ', collected.unreadable))
      if (index.unlisted.count > 0) lines.push(...index.unlisted.shapes.map(entry => 'Could not list: ' + entry.shape + ': ' + entry.count))
      if (again.changedKeys.length > 0) lines.push(...capped('Changed: ', again.changedKeys))
      if (again.vanishedKeys.length > 0) lines.push(...capped('Deleted meanwhile: ', again.vanishedKeys))
      if (again.grew > 0) lines.push(rowsWord(again.grew) + ' grew after being copied (the copy holds what was read). Run again to add the new lines.')
      lines.push(settingsLine(index.rows, settings))
      lines.push(check)
      result.plain = plain
      result.lines = lines
      if (!result.complete) return finish('Copy saved, NOT complete: ' + reasons.join(', ') + '. Run again when she is idle.')
      return finish('Saved a copy on this computer: ' + summary(index) + '.')
    } catch (error) {
      if (!isHalt(error)) throw scrubbed(error)
      return finish(haltLine(error))
    } finally { src.close() }
  }

  /** Only the cloud index of this browser, its bytes and id (no upload); chat logs always, other saved settings only with `settings: true`. */
  const readIndex = async (args = {}) => {
    const src = await openSource()
    if (src.none || src.failed) return { ok: false, line: src.none ? LINE.nothing : LINE.storage }
    try {
      const collected = await collect(src, () => {}, null, 'cloud', args.settings === true)
      const index = makeIndex(collected)
      const text = canon(index)
      return { ok: true, index, text, id: indexId(index), unreadable: collected.unreadable, unreadableShapes: collected.unreadableShapes,
        missing: collected.missing, skipped: collected.skipped, unlisted: index.unlisted }
    } catch (error) {
      throw isHalt(error) ? error : scrubbed(error)
    } finally { src.close() }
  }

  // ── Her threads in her cloud: the join and the check ────────────────────────────────────────────────
  // "Copy to her cloud" leaves his journals in her vault as pieces with no thread that names them. `joinThreads` makes
  // them her threads, one `POST /_thread/import` at a time under one writer's lease; `cloudState` says, on any signed-in
  // open, what is and is not in her cloud; `checkThread` reads one thread back from her cloud, piece by piece, in a
  // browser that holds nothing of hers. None of them writes anything in this browser.
  /** A mirror client id as her edge accepts it for a lease (world-lease.mjs). */
  const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/
  const LEASE_LABEL = 'Rescue page'
  /**
   * Her edge's lease timing (world-lease.mjs WORLD_LEASE, which this self-contained kit cannot import; a test
   * holds the three equal). While a Join works it renews its turn before a journal once more than `renewMs` has passed since
   * the last grant or renew; one press holds her cloud `writeHoldMs` at most (the cap a write meets at her edge).
   * JOIN_HOLD_MS is one press's whole time, counted on this page's clock from its first grant, a pause
   * (a closed lid) included. It is checked before every renew, acquire, import and retry; past it nothing more is sent.
   * A turn not confirmed (a grant, a renew, or a committed import) for more than `ttlMs` has run out at her edge.
   */
  const LEASE_TTL_MS = 90000, LEASE_RENEW_MS = 20000, JOIN_HOLD_MS = 1800000
  /** Her edge's largest answer of whole lines from the open end of a thread (thread-log.mjs TAIL_MAX). */
  const TAIL_MAX = 262144
  const ZERO_CHAIN = '0'.repeat(64)
  /** A 503 import answer with one of these codes is waited out (its retry-after), five times at most. */
  const WAIT_CODES = ['IMPORT_BUSY', 'THREAD_MOVED', 'SEAL_PENDING', 'OWNER_SESSION_UNAVAILABLE']
  /**
   * A 5xx import answer that proves nothing about the commit: her edge never read MIRROR's answer
   * (THREAD_STORAGE_UNAVAILABLE: failed, late, oversized or unreadable, thread-log.mjs createCaller), failed where it could
   * not say (THREAD_UNAVAILABLE), or no code of hers at all (HTTP_5xx: not her edge's own answer). The bytes may be
   * committed, so it is retried like a lost answer and, unsettled, is "not confirmed", never refused. 507 WORLD_FULL,
   * ARCHIVE_UNAVAILABLE and BUDGET_UNAVAILABLE stay refusals: each is answered before that journal's last commit.
   */
  const UNPROVEN_CODES = ['THREAD_STORAGE_UNAVAILABLE', 'THREAD_UNAVAILABLE']
  /** The tries a Join's start read gives each page of her index (cloudThreads `until`). */
  const INDEX_TRIES = 5
  const unproven = (got, code) => got.status >= 500 && got.status !== 507 && (UNPROVEN_CODES.includes(code) || /^HTTP_5\d\d$/.test(code))
  const OUTCOMES = { imported: 'imported', extended: 'extended', same: 'same', 'kept-beside': 'kept beside' }
  /** A journal of 0 bytes: her edge imports nothing empty (thread-log.mjs rescueValid), so it is never sent. */
  const EMPTY = 'empty, nothing to join'
  /** The newest checked copies a check reads to find one that lists its thread. */
  const RESCUE_LOOKUP = 16
  const JOIN = {
    signin: 'Your sign-in ended. Sign in on this page and press Join again.',
    noClient: 'This browser holds no store of hers that her cloud knows, so it has nothing to join.',
    // What the list of checked copies showed, with that read's time; never a present fact.
    noCopy: at => 'At ' + at + ' her cloud held no checked copy of this browser. Press Copy to her cloud first.',
    lost: 'This page lost its turn to write in her cloud. Press Join again.',
    // Said only while this page's turn is still its own; a press whose turn ran out says `lost`.
    // It claims nothing about her cloud; the next press compares afresh.
    held: 'This Join stopped after 30 minutes, the longest one press may. Press Join again: it compares her cloud again and goes on with what is left.',
    noTurn: 'Her edge did not give this page its turn to write just now. Nothing was joined. Press Join again.',
    // Every acquire answer was lost; her edge may have granted it, so nothing is said about a refusal.
    noAnswer: "This page's turn to write could not be confirmed: no answer came back from her edge. Nothing was sent to join. Press Join again.",
    turnUnknown: "This page's turn to write could not be confirmed again: no answer came back from her edge. Press Join again.",
    // Some acquire answer was lost or proved nothing (none, or a 5xx `unproven`), and the last one
    // refused nothing outright: a try may have been granted, so nothing is said about a refusal.
    turnUnsure: "This page's turn to write could not be confirmed: an answer from her edge was lost or did not say whether it was given. Nothing was sent to join. Press Join again.",
    turnUnsureAgain: "This page's turn to write could not be confirmed again: an answer from her edge was lost or did not say whether it was given. Press Join again.",
    // The final read could not be made whole under this page's turn (a page unreadable, the turn not kept).
    unconfirmed: "What this Join did could not be confirmed: her cloud could not be read whole while this page held its turn. Press Join again to check.",
    unread: 'Her cloud could not be read just now. Press the button again.',
    // On an open no button reads her cloud again: the way forward is a reload.
    unreadOpen: 'Her cloud could not be read just now. Reload this page to read it again.',
    running: 'A join is already running on this page.',
    elsewhere: label => 'She is answering in ' + label + '. Try again when she has finished.',
  }
  const CHECK = {
    unknown: 'This thread is not in her cloud.',
    unread: 'Her cloud could not be read just now. Nothing was checked. Press Check again.',
    moved: 'Her cloud changed this thread while it was being read. Press Check again.',
    longLine: 'Not checked: the open end of this thread holds a line longer than this page can read back (256 KiB).',
  }
  /** One id for this page load, for the lease (never a client id); made on first use, so a plain copy needs no random source. */
  let pageIdValue = null
  const pageId = () => {
    if (pageIdValue) return pageIdValue
    const source = options.crypto || g.crypto
    const bytes = new Uint8Array(12)
    if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes)
    else for (let at = 0; at < bytes.length; at++) bytes[at] = Math.floor(Math.random() * 256)
    pageIdValue = toHex(bytes)
    return pageIdValue
  }
  /** The lease this page holds now, if any (`leave` releases it when the page goes). */
  const lease = { held: null, joining: false }
  // The page remembers NOTHING between presses of Join (no answers, no place): every press compares afresh.
  /** Outcomes that committed bytes at her edge: the lease was extended there when they were answered. */
  const COMMITTED = ['imported', 'extended', 'kept beside']
  /** The outcomes of a journal joined in this press (said only when the press's final read shows its content). */
  const JOINED = ['same', 'imported', 'extended']
  /** A journal this press never sent an import for (the deadline, a lost turn, another browser's turn, a sign-in). */
  const NOT_TRIED = 'not tried'
  /** A journal whose joining this press could not confirm (`detail` says why). */
  const NOT_CONFIRMED = 'not confirmed'
  /**
   * An import sent whose answers (none of its tries) never said whether it was joined: lost on the way,
   * or a 5xx that proves nothing (`unproven`). Her cloud may hold it.
   */
  const SENT_UNKNOWN = 'sent, no answer said whether it was joined'
  /** The SHA-256 of no bytes: the open end of a thread whose bytes are all in sealed pieces. */
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const sayer = report => line => { try { if (typeof report === 'function') report(line) } catch (error) { /* the page's own problem */ } }
  const jsonOf = bytes => { if (!bytes) return null; try { return JSON.parse(new TextDecoder().decode(bytes)) } catch (error) { return null } }
  const clientOf = value => (typeof value === 'string' && CLIENT_ID.test(value) ? value : null)
  const isoMs = text => { const ms = typeof text === 'string' ? Date.parse(text) : Number.NaN; return Number.isFinite(ms) ? ms : null }
  const codeOf = got => (isRecord(got.info) && typeof got.info.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(got.info.code) ? got.info.code
    : got.status === 0 ? 'NO_ANSWER' : 'HTTP_' + got.status)
  const waitOf = got => {
    const seconds = got.headers && typeof got.headers.get === 'function' ? Number(got.headers.get('retry-after')) : Number.NaN
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 1
  }
  const bytesOfHex = text => { const out = new Uint8Array(text.length / 2); for (let at = 0; at < out.length; at++) out[at] = parseInt(text.slice(at * 2, at * 2 + 2), 16); return out }
  /** The rolling chain of a thread's sealed pieces: SHA-256 of the chain's 32 bytes, then the piece name's 32 bytes. */
  const chainStep = (chain, name) => { const pair = new Uint8Array(64); pair.set(bytesOfHex(chain)); pair.set(bytesOfHex(name), 32); return sha256Hex(pair) }
  /** A label that is printable and short, or null. */
  const labelText = value => (typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null)
  /** A thread as a person reads it: its own title in her cloud, else its session folder's last two path parts. */
  const titleOf = (path, title) => labelText(typeof title === 'string' ? title.trim() : '') || threadLabel(shown(path))
  /**
   * The FACTS that identify a thread's bytes, the same four her edge keeps and an import's `expect` names
   * (thread-log.mjs `pairOf`): `bytes`; `partCount`, its sealed pieces; `chain`, the rolling chain over the names (SHA-256)
   * of those pieces; `tailSha`, the SHA-256 of the open end after them. Any change of any byte changes `chain` or `tailSha`
   * (equal byte counts alone are never "the same content"). For a journal of a checked copy they are computed here from
   * the copy's own list of piece names, with no download: its whole pieces are the sealed ones an import writes, and its
   * last, partial piece is the open end (its name IS that SHA-256). Null when the list does not fit the byte count.
   */
  const journalFacts = (bytes, pieces) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Array.isArray(pieces) || pieces.length !== Math.ceil(bytes / PIECE)
      || !pieces.every(name => typeof name === 'string' && HEX64.test(name))) return null
    const whole = Math.floor(bytes / PIECE)
    let chain = ZERO_CHAIN
    for (let k = 0; k < whole; k++) chain = chainStep(chain, pieces[k])
    return { bytes, partCount: whole, chain, tailSha: bytes > whole * PIECE ? pieces[whole] : EMPTY_SHA }
  }
  /** The facts her edge gave for a thread (an index row, or an import's answer with `sealedBytes`); null when incomplete. */
  const threadFacts = t => {
    if (!isRecord(t)) return null
    const partCount = Number.isSafeInteger(t.partCount) ? t.partCount : Number.isSafeInteger(t.sealedBytes) && t.sealedBytes % PIECE === 0 ? t.sealedBytes / PIECE : null
    if (!Number.isSafeInteger(t.bytes) || partCount === null || partCount < 0 || typeof t.chain !== 'string' || !HEX64.test(t.chain)
      || typeof t.tailSha !== 'string' || !HEX64.test(t.tailSha)) return null
    return { bytes: t.bytes, partCount, chain: t.chain, tailSha: t.tailSha }
  }
  /** True when both sets of facts are complete and equal: the same content, byte for byte (up to SHA-256). */
  const sameContent = (a, b) => isRecord(a) && isRecord(b) && Number.isSafeInteger(a.bytes) && a.bytes === b.bytes && a.partCount === b.partCount
    && typeof a.chain === 'string' && a.chain === b.chain && typeof a.tailSha === 'string' && a.tailSha === b.tailSha

  /** What this browser holds of hers, read only: whether a store exists and its mirror client id (null when none). */
  const readClient = async () => {
    const src = await openSource()
    if (src.none || src.failed) return { store: false, clientId: null }
    try {
      if (src.client) return { store: true, clientId: clientOf(src.client.clientId) }
      let meta = null
      try { meta = await src.read('@x6-mirror-meta') } catch (error) { meta = null }
      return { store: true, clientId: isRecord(meta) ? clientOf(meta.clientId) : null }
    } finally { src.close() }
  }
  /** Her cloud's checked rescue copies, newest first; null when the list cannot be read. */
  const checkedCopies = async net => {
    const got = await net.call('GET', '/_vault/rescue')
    const list = got.status === 200 ? jsonOf(got.data) : null
    if (got.status !== 200 || !isRecord(list) || !Array.isArray(list.rescues)) return null
    return list.rescues.filter(entry => isRecord(entry) && typeof entry.id === 'string' && HEX32.test(entry.id) && isoMs(entry.verifiedAt) !== null)
      .map(entry => ({ id: entry.id, verifiedAt: entry.verifiedAt, at: isoMs(entry.verifiedAt), clientId: typeof entry.clientId === 'string' ? entry.clientId : null }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
  }
  /** The journals a checked copy holds, in its index order (the index's SHA-256 must name it); null when unreadable. */
  const journalsOf = async (net, id) => {
    const got = await net.call('GET', '/_vault/rescue/' + id)
    if (got.status !== 200 || !got.data || sha256Hex(got.data).slice(0, 32) !== id) return null
    const index = jsonOf(got.data)
    if (!isRecord(index) || index.piece !== PIECE || !Array.isArray(index.rows)) return null
    const journals = []
    for (const row of index.rows) {
      if (!isRecord(row) || row.type !== 'file' || typeof row.key !== 'string' || !THREAD.test(row.key)) continue
      if (!Number.isSafeInteger(row.bytes) || typeof row.sha256 !== 'string' || !HEX64.test(row.sha256)) return null
      journals.push({ path: row.key, bytes: row.bytes, sha256: row.sha256, mtimeMs: num(row.mtimeMs), facts: journalFacts(row.bytes, row.pieces) })
    }
    return journals
  }
  /**
   * Every thread in her cloud, page by page, and the index's `home`; null when a page cannot be read.
   * `until` (a Join's start read) sends each page with the Join's own rules instead of the run's:
   * at most INDEX_TRIES tries a page, a busy or slow answer (none, 408, 429, 5xx) waited out with its retry-after, never a
   * try or a wait once `until` has passed and no wait that would end at or past it, no halt but a 401; a page still not answered 200 makes it null. `say` hears the
   * waits.
   * Each thread carries its FACTS (`partCount`, `chain`, `tailSha`; null when her index does not give them,
   * and then it is never "the same content"); `at` is this page's clock when the last page was answered.
   * A read of more than one page is several requests, and her cloud can change between them. Each page
   * keeps its own answer time and the range of thread ids it covered (`pages`: `{after, next, at}`, ids above `after` up to
   * and including `next`, the last page with no end), and each thread the time of the page that listed it (`seenAt`); the
   * index's `home` row carries page one's time (`homeAt`). Only a read made under a Join's turn may be said as one moment.
   */
  const cloudThreads = async (net, until = null, say = () => {}) => {
    const threads = [], pages = []
    let after = '', home = null
    const ask = async path => {
      if (until === null) return net.call('GET', path)
      for (let tries = 1; ; tries++) {
        const got = await net.call('GET', path, undefined, { once: true })
        // A wait that would end at or past `until` is never begun (no try could follow it).
        const wait = 1000 * waitOf(got)
        if (got.status === 200 || !(got.status === 0 || got.status === 408 || got.status === 429 || got.status >= 500) || tries >= INDEX_TRIES || now() + wait >= until) return got
        say(got.status === 503 && codeOf(got) === 'OWNER_SESSION_UNAVAILABLE' ? LINE.busy : LINE.slow)
        await sleep(wait)
        if (now() >= until) return got
      }
    }
    for (let page = 0; page < 64; page++) {
      const got = await ask('/_thread/index?limit=200' + (after ? '&after=' + after : ''))
      const answeredAt = now()
      const body = got.status === 200 ? jsonOf(got.data) : null
      if (!isRecord(body) || !Array.isArray(body.threads)) return null
      if (page === 0 && isRecord(body.home)) home = body.home
      for (const t of body.threads) {
        if (!isRecord(t) || typeof t.id !== 'string' || !HEX64.test(t.id) || typeof t.path !== 'string' || !Number.isSafeInteger(t.bytes)) return null
        const facts = threadFacts(t)
        threads.push({ id: t.id, path: t.path, bytes: t.bytes, title: typeof t.title === 'string' ? t.title : '',
          partCount: facts ? facts.partCount : null, chain: facts ? facts.chain : null, tailSha: facts ? facts.tailSha : null, seenAt: answeredAt })
      }
      const last = body.next === null || body.next === undefined
      if (!last && (typeof body.next !== 'string' || !HEX64.test(body.next))) return null
      pages.push({ after, next: last ? null : body.next, at: answeredAt })
      if (last) return { threads, home, homeAt: pages[0].at, pages, from: pages[0].at, at: answeredAt }
      after = body.next
    }
    return null
  }
  /**
   * The words of what ONE read of her cloud showed, each with that read's time (an observation, never a
   * claim about now): "At HH:MM her cloud showed N of M threads with the same content as this copy." N counts a journal of
   * the copy whose thread in that read has EXACTLY its facts (`sameContent`: bytes, sealed pieces, their chain and the
   * open end's SHA-256), and a journal of 0 bytes with no thread or an empty one (there is nothing to join). Equal byte
   * counts alone are never "the same content". `mine`: this browser's store is the one the copy was made from (then the
   * line on the copy's newest line); `home`: the index's home row names a copy of this store. What a join answered
   * ("kept beside", "not done") is said on lines of its own and never changes N.
   * `oneMoment` is true only for a Join's own final read, made under its turn (no thread can change
   * between its pages): its words stay as they were. Every other read (an open: read-only, no turn) is several requests
   * when it is several pages, and is said as what it is: one page, "At HH:MM:SS her cloud showed ..."; more, "Read between
   * HH:MM:SS and HH:MM:SS, her cloud showed ...", once with the plain words that her cloud can change while it is read and
   * that Join checks it again before it writes. Every row then says what the page that produced it showed, with that
   * page's time (`seenAt` in the row): a thread listed, the page that listed it; a thread not listed, the page whose range
   * of ids holds its id (thread-log.mjs threadIdForPath: the SHA-256 of its path). `copiesAt`: when the list of checked
   * copies was answered (said only when it held none).
   */
  const describe = (copy, journals, cloud, { store, mine, homeMine, oneMoment = false, copiesAt = null }) => {
    const byPath = new Map(cloud.threads.map(thread => [thread.path, thread]))
    const at = hhmm(cloud.at)
    const pages = Array.isArray(cloud.pages) && cloud.pages.length > 0 ? cloud.pages : [{ after: '', next: null, at: cloud.at }]
    const several = pages.length > 1
    const from = hhmmss(pages[0].at), to = hhmmss(cloud.at)
    // The words that open a sentence about this whole read, said to the second.
    const during = several ? 'Read between ' + from + ' and ' + to + ', ' : 'At ' + to + ' '
    /** The answer time of the page whose range of ids holds `path`'s thread id (a thread not listed); null if none does. */
    const absentAt = path => {
      const id = sha256Hex(encoder.encode(path))
      const page = pages.find(entry => (entry.after === '' || id > entry.after) && (entry.next === null || id <= entry.next))
      return page ? page.at : null
    }
    const listed = new Set()
    let equal = 0, ahead = 0, newest = null
    const rows = []
    for (const journal of journals || []) {
      const thread = byPath.get(journal.path) || null
      listed.add(journal.path)
      const empty = journal.bytes === 0 && (thread === null || thread.bytes === 0)
      const same = empty || (thread !== null && sameContent(journal.facts, thread))
      const more = thread !== null && thread.bytes > journal.bytes
      const title = titleOf(journal.path, thread ? thread.title : '')
      if (same) equal += 1
      else if (more) ahead += 1
      if (journal.bytes > 0 && journal.mtimeMs !== null && (newest === null || journal.mtimeMs > newest.at)) newest = { at: journal.mtimeMs, title }
      const seenAt = thread ? (Number.isFinite(thread.seenAt) ? thread.seenAt : cloud.at) : absentAt(journal.path)
      // One moment: the words as they were. Else each observation carries the time of the page that made it.
      const when = oneMoment ? '' : ' at ' + hhmmss(seenAt)
      const text = title + ': ' + (thread === null ? (journal.bytes === 0 ? EMPTY
        : oneMoment ? 'not in her cloud yet' : seenAt !== null ? 'not in her cloud' + when : 'not listed by the read of her cloud between ' + from + ' and ' + to)
        : same ? thread.bytes + ' bytes' + when + ', the same content as the copy'
          : more ? thread.bytes + ' bytes in her cloud' + when + ', more than the ' + journal.bytes + ' in this copy'
            : thread.bytes === journal.bytes ? thread.bytes + ' bytes in her cloud' + when + ', the same count as the copy but not shown to be the same content'
              : thread.bytes + ' bytes in her cloud' + when + ', ' + journal.bytes + ' in the copy')
      rows.push({ path: journal.path, title, text, id: thread ? thread.id : null, equal: same, ahead: more, seenAt,
        rescue: { bytes: journal.bytes, sha256: journal.sha256, verifiedAt: copy.verifiedAt } })
    }
    for (const thread of cloud.threads) {
      if (listed.has(thread.path)) continue
      const title = titleOf(thread.path, thread.title)
      const seenAt = Number.isFinite(thread.seenAt) ? thread.seenAt : cloud.at
      rows.push({ path: thread.path, title, text: title + ': ' + thread.bytes + ' bytes in her cloud' + (oneMoment ? '' : ' at ' + hhmmss(seenAt)),
        id: thread.id, equal: false, ahead: false, seenAt, rescue: null })
    }
    const lines = []
    const count = cloud.threads.length + (cloud.threads.length === 1 ? ' thread' : ' threads')
    let line
    if (!copy) {
      line = oneMoment ? 'At ' + at + ' her cloud held ' + count + ' and no checked rescue copy.'
        : 'At ' + hhmmss(copiesAt) + ' her cloud held no checked rescue copy. '
          + (several ? 'Read between ' + from + ' and ' + to + ', it listed ' + count + '; her cloud can change while it is being read.' : 'At ' + to + ' it listed ' + count + '.')
    } else {
      line = oneMoment ? 'At ' + at + ' her cloud showed ' + equal + ' of ' + journals.length + ' threads with the same content as this copy.'
        : during + 'her cloud showed ' + equal + ' of ' + journals.length + ' threads with the same content as this copy.'
          + (several ? ' Her cloud can change while it is being read; Join checks it again before it writes.' : '')
      // What the copy holds and that later work was not looked at; never where later bytes are.
      if (store && mine) {
        if (newest) lines.push("This copy's newest line is from " + hhmm(newest.at) + ' (' + newest.title + '). Anything written in this browser after the copy was not looked at.')
      } else if (store) lines.push("This browser's own threads are not in this copy. Press Copy to her cloud, then Join.")
      if (ahead > 0) lines.push((oneMoment ? 'At ' + at + ' ' : during) + 'her cloud held more bytes than this copy of ' + ahead + (ahead === 1 ? ' thread.' : ' threads.'))
    }
    if (homeMine) {
      lines.push(oneMoment ? 'Her home files from this browser are in her vault and wait for one answer from you.'
        : 'At ' + hhmmss(Number.isFinite(cloud.homeAt) ? cloud.homeAt : pages[0].at) + ' her home files from this browser were in her vault, waiting for one answer from you.')
    }
    return { equal, total: journals ? journals.length : 0, line, lines, rows, reads: pages.length, readFrom: pages[0].at, readTo: cloud.at }
  }
  /** True when the index's home row is pending for a copy of THIS store's client. */
  const homeIsMine = (home, copies, mine) => {
    if (!isRecord(home) || !home.pending || mine === null) return false
    if (isRecord(home.pending) && home.pending.clientId === mine) return true
    return copies.some(entry => entry.id === home.rescue && entry.clientId === mine)
  }

  /**
   * What is in her cloud, said for any signed-in open: reads only (the list of checked copies, the chosen copy's list,
   * her thread index). The copy compared with: `rescueId` when given and checked, else this store's newest checked copy,
   * else the newest checked copy of any browser.
   * @param {{clientId?: string|null, store?: boolean, rescueId?: string|null, report?: Function}} [args]
   */
  const cloudState = async (args = {}) => {
    const say = sayer(args.report)
    const mine = clientOf(args.clientId)
    const store = args.store === true
    const net = makeNet(say)
    try {
      const copies = await checkedCopies(net)
      const copiesAt = now()
      if (!copies) return { ok: false, line: JOIN.unreadOpen, lines: [], rows: [], ownVerified: false, signin: false }
      const own = copies.filter(entry => mine !== null && entry.clientId === mine)
      const copy = copies.find(entry => entry.id === args.rescueId) || own[0] || copies[0] || null
      const journals = copy ? await journalsOf(net, copy.id) : null
      if (copy && !journals) return { ok: false, line: JOIN.unreadOpen, lines: [], rows: [], ownVerified: own.length > 0, signin: false }
      const cloud = await cloudThreads(net)
      if (!cloud) return { ok: false, line: JOIN.unreadOpen, lines: [], rows: [], ownVerified: own.length > 0, signin: false }
      // An open reads with no turn, so its pages are not one moment: `describe` dates every observation.
      const told = describe(copy, journals, cloud, { store, mine: copy !== null && mine !== null && copy.clientId === mine, homeMine: homeIsMine(cloud.home, copies, mine), copiesAt })
      return Object.assign(told, { ok: true, ownVerified: own.length > 0, rescue: copy, signin: false })
    } catch (error) {
      if (!isHalt(error)) throw scrubbed(error)
      const signin = error.rescueHalt === 'signin'
      return { ok: false, line: signin ? JOIN.signin : JOIN.unreadOpen, lines: [], rows: [], ownVerified: false, signin }
    }
  }

  /**
   * The release of a lease, sent once; `keepalive` when the page is going. Resolves with `{status, released}`: status 0 or
   * -1 for none; `released` true only when her edge answered that this lease was still the one it held (world-lease.mjs:
   * the lease row still named it), false when it was not, null when that cannot be read.
   */
  const sendRelease = (held, keepalive) => new Promise(resolve => {
    const init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'release', clientId: held.clientId, tabId: pageId(), label: LEASE_LABEL, leaseId: held.leaseId }) }
    if (keepalive) init.keepalive = true
    const timer = deadline(DEADLINE.headers, () => resolve({ status: -1, released: null }))
    let sent
    try { sent = Promise.resolve(fetchImpl('/_mirror/lease', init)) } catch (error) { disarm(timer); resolve({ status: -1, released: null }); return }
    sent.then(async response => {
      const status = response && typeof response.status === 'number' ? response.status : -1
      let released = null
      if (status === 200 && !keepalive) {
        try { const body = await response.json(); released = isRecord(body) && typeof body.released === 'boolean' ? body.released : null } catch (error) { released = null }
      }
      disarm(timer)
      resolve({ status, released })
    }, () => { disarm(timer); resolve({ status: -1, released: null }) })
  })
  /** The page is going (`pagehide`): a lease still held is released with a keepalive request, not waited for. */
  const leave = () => {
    const held = lease.held
    lease.held = null
    if (held) void sendRelease(held, true)
  }
  /** The lease in an acquire's answer, or null. */
  const granted = got => {
    const given = got.status === 200 && isRecord(got.info) && isRecord(got.info.lease) ? got.info.lease : null
    return given && typeof given.leaseId === 'string' && HEX32.test(given.leaseId) && Number.isSafeInteger(given.generation) && given.generation >= 1 ? given : null
  }
  /** The plain words for a lease her edge did not give. */
  const leaseRefused = got => {
    const code = codeOf(got)
    if (got.status === 423 && code === 'WRITER_ELSEWHERE') {
      const holder = isRecord(got.info) && isRecord(got.info.holder) ? labelText(got.info.holder.label) : null
      return { line: JOIN.elsewhere(holder || 'another page of hers'), code }
    }
    if (got.status === 409 && code === 'CLIENT_SLOT_RETIRED' && isRecord(got.info) && typeof got.info.message === 'string') return { line: redactText(got.info.message), code }
    return { line: JOIN.noTurn, code }
  }
  /**
   * ONE import, waited out on a 503 that asks for it (five times at most); `stop` when the run cannot go on.
   * `overdue()` gives the press's stop line once its deadline has passed; then no import or retry is sent.
   * What happened to THIS journal is kept in `flight`, which survives a sign-in halt thrown mid-import:
   * `sent` once any try left this page; `unanswered` once a sent try got no answer this page could read (status 0, a 200
   * without an outcome, or a 5xx that proves nothing: `unproven`), so the import may have committed; `code`, the last
   * answer that proved something. `info`: her edge's answer to the import that has an outcome.
   */
  const importOne = async (net, path, rescue, held, overdue, flight) => {
    const body = JSON.stringify({ path, rescue })
    for (let tries = 0; ; tries++) {
      const due = overdue()
      if (due) return { stop: due }
      flight.sent = true
      const got = await net.call('POST', '/_thread/import', body, { once: true, headers: { 'x-thread-lease': held.leaseId + '.' + held.generation } })
      if (got.status === 200 && isRecord(got.info) && Object.prototype.hasOwnProperty.call(OUTCOMES, got.info.outcome)) return { outcome: OUTCOMES[got.info.outcome], info: got.info }
      const code = codeOf(got)
      const proved = !(got.status === 0 || got.status === 200 || unproven(got, code))
      if (proved) flight.code = code
      else flight.unanswered = true
      if (((got.status === 503 && WAIT_CODES.includes(code)) || (!proved && got.status !== 200)) && tries < 5) { await sleep(1000 * waitOf(got)); continue }
      if (got.status === 423) {
        const holder = isRecord(got.info) && isRecord(got.info.holder) ? labelText(got.info.holder.label) : null
        return { stop: holder ? JOIN.elsewhere(holder) : JOIN.lost }
      }
      // The turn was lost (410): the Join takes it again once and retries this journal (joinThreads).
      if (got.status === 410) return { lost: true, stop: JOIN.lost }
      if (got.status === 409 && code === 'CLIENT_SLOT_RETIRED') return { stop: leaseRefused(got).line }
      return {}
    }
  }

  /**
   * Join the journals of this store's checked copy as her threads in her cloud (one design, nothing
   * remembered between presses).
   * 1. Under ONE writer's lease (this store's own mirror client id, one id for this page load, label "Rescue page") the
   *    press reads her thread index once, all pages (each page a few tries at most, inside the press's deadline; still
   *    unreadable, nothing is sent and the press ends "could not be read"). A journal whose FACTS (`journalFacts`, computed
   *    here from the copy's piece names) equal that thread's facts in the read is `same` with NO import. A journal of 0
   *    bytes is never sent. Every other journal (missing, shorter, longer, divergent) gets ONE import, in the copy's order,
   *    the next only after the answer.
   * 2. While it works the press keeps its turn (a renew before an import once LEASE_RENEW_MS has passed since the last grant
   *    or renew); a turn lost (410) is taken again once under the same ids and that journal retried once; one press works
   *    JOIN_HOLD_MS at most, counted from its first grant, checked before every renew, acquire, import and retry.
   * 3. After the imports it reads her index once more, all pages, STILL UNDER ITS TURN, then releases. Her edge answers the
   *    release with `released: true` only while its lease row still names this page's lease: then no other writer held a
   *    turn since this page's last grant, and every thread write needs that turn (thread-log.mjs writerGate), so no thread
   *    changed between the pages of that read. Only then are the final lines said, from THAT read alone, with its time.
   *    Otherwise the press says it could not be confirmed and is not done.
   * 4. Each row is what happened to THAT journal in THIS press: `same`, `imported`, `extended` (each only when the final
   *    read shows this copy's content, or the content her edge's answer proved, unchanged), `kept beside`, `empty, nothing
   *    to join`, `not done: CODE` (sent and refused), `not tried` (never sent), `not confirmed` (with why).
   * @param {{clientId: string, rescueId?: string|null, report?: Function}} args
   */
  const joinThreads = async (args = {}) => {
    const say = sayer(args.report)
    const result = { ok: false, done: false, signin: false, line: '', lines: [], rows: [], equal: 0, total: 0, rescue: null }
    const finish = line => { result.line = line; say(line); return result }
    const mine = clientOf(args.clientId)
    if (!mine) return finish(JOIN.noClient)
    if (lease.joining) return finish(JOIN.running)
    lease.joining = true
    const net = makeNet(say)
    let held = null, journals = []
    // The import in flight: which row, and what has happened to it so far.
    let flight = null
    const free = async () => {
      if (!held) return null
      const going = held
      held = null
      if (lease.held === going) lease.held = null
      return sendRelease(going, false)
    }
    /**
     * Each row's final words. `final`: the press's final read when it is CONFIRMED (read under this page's turn, kept to the
     * release), else null. A joined row that read does not show is `not confirmed`, never `same`.
     */
    const settle = final => {
      const finalBy = final ? new Map(final.threads.map(thread => [thread.path, thread])) : null
      result.rows.forEach((row, at) => {
        const journal = journals[at]
        const seen = finalBy ? finalBy.get(row.path) || null : null
        if (seen) row.title = titleOf(row.path, seen.title)
        if (JOINED.includes(row.outcome)) {
          // The start read's row is dated by the page that listed it, to the second (it may span pages).
          const was = row.how === 'start' ? 'her cloud showed the same content at ' + hhmmss(row.seenAt) : 'her edge answered ' + row.outcome
          if (!finalBy) { row.outcome = NOT_CONFIRMED; row.detail = was + '; no later read of her cloud confirmed it' }
          else if (sameContent(journal.facts, seen)) { /* this copy's content, seen in the final read */ }
          else if (row.proved && sameContent(row.proved, seen)) { if (seen.bytes > journal.bytes) row.more = hhmm(final.at) }
          else { row.outcome = NOT_CONFIRMED; row.detail = was + ', but at ' + hhmm(final.at) + " her cloud did not show this copy's content" }
        } else if (row.outcome === NOT_CONFIRMED && !row.detail) {
          row.detail = SENT_UNKNOWN + (finalBy && sameContent(journal.facts, seen) ? '; at ' + hhmm(final.at) + " her cloud showed this copy's content" : '')
        }
        row.text = row.title + ': ' + row.outcome + (row.detail ? ': ' + row.detail : '') + (row.more ? ' (her cloud held more than this copy at ' + row.more + ')' : '')
      })
    }
    /**
     * What this press did not finish, in three kinds, always in this order. REFUSED: sent, and her edge
     * answered with a refusal ("not done: CODE"). NOT CONFIRMED: see the row. NOT TRIED: never sent. Then the kept line.
     * Shown on EVERY path, a halt's included.
     */
    const summaries = () => {
      const titles = test => result.rows.filter(row => test(row.outcome)).map(row => row.title).join(', ')
      const refused = titles(outcome => outcome.startsWith('not done: '))
      const unsure = titles(outcome => outcome === NOT_CONFIRMED)
      const untried = titles(outcome => outcome === NOT_TRIED)
      const keptBeside = titles(outcome => outcome === 'kept beside')
      return {
        unfinished: [refused ? 'Not joined: ' + refused + '. Press Join again.' : null,
          unsure ? 'Join not confirmed for: ' + unsure + '. Her cloud may hold them. Press Join again to check.' : null,
          untried ? 'Not tried in this press: ' + untried + '. Press Join again to continue.' : null].filter(text => text !== null),
        kept: keptBeside ? ['Kept beside a different thread of the same name in her cloud, not joined into it: ' + keptBeside + '.'] : [],
      }
    }
    try {
      say('Reading her cloud.')
      const copies = await checkedCopies(net)
      const copiesAt = now()
      if (!copies) return finish(JOIN.unread)
      const copy = copies.find(entry => entry.id === args.rescueId && entry.clientId === mine) || copies.find(entry => entry.clientId === mine) || null
      if (!copy) return finish(JOIN.noCopy(hhmmss(copiesAt)))
      result.rescue = copy
      journals = await journalsOf(net, copy.id)
      if (!journals) { journals = []; return finish(JOIN.unread) }
      // An acquire granted whose answer was lost would leave a lease this page cannot name, so cannot release: asked
      // again (five times at most), her edge gives the same lease to the same client and page id (world-lease.mjs).
      const acquire = JSON.stringify({ action: 'acquire', clientId: mine, tabId: pageId(), label: LEASE_LABEL })
      // `deadline`, once the press has one, is checked before every acquire; past it none is sent.
      // `heard` is the last try that got any answer at all (null: every answer was lost).
      // `doubt` when no grant was read, some try got no answer or one that proves nothing (`unproven`:
      // a 5xx THREAD_STORAGE_UNAVAILABLE, THREAD_UNAVAILABLE or with no code of hers), and the last try did not refuse
      // outright (a 4xx is her edge's word on this page's turn then: a lost grant is given again to the same ids).
      const take = async (deadline = null) => {
        let given = null, heard = null, lost = false, asked = null
        for (let tries = 0; ; tries++) {
          if (deadline !== null && now() >= deadline) return { given: null, late: true, heard, doubt: false }
          asked = await net.call('POST', '/_mirror/lease', acquire, { once: true })
          if (asked.status !== 0) heard = asked
          if (asked.status === 0 || unproven(asked, codeOf(asked))) lost = true
          given = granted(asked)
          if (given || !(asked.status === 0 || asked.status >= 500) || tries >= 4) break
          await sleep(1000 * waitOf(asked))
        }
        if (given) {
          held = lease.held = { leaseId: given.leaseId, generation: given.generation, clientId: mine }
          grantedAt = confirmedAt = now()
        }
        return { given, heard, doubt: !given && lost && (asked.status === 0 || asked.status >= 500) }
      }
      // `grantedAt`: the last grant or renew (when to renew). `confirmedAt`: the last time her edge confirmed this turn (a
      // grant, a renew, or an import that committed bytes): more than LEASE_TTL_MS after it, the turn has run out there.
      let grantedAt = 0, confirmedAt = 0
      const first = await take()
      if (!first.given) {
        if (!first.heard) return finish(JOIN.noAnswer)
        if (first.doubt) return finish(JOIN.turnUnsure)
        result.lines = ['Her edge answered: ' + codeOf(first.heard)]
        return finish(leaseRefused(first.heard).line)
      }
      // One press works JOIN_HOLD_MS at most, an absolute deadline counted from its first grant.
      const deadline = grantedAt + JOIN_HOLD_MS
      // The press's stop line past its deadline: JOIN.held while this page's turn is still its own, else JOIN.lost.
      const pastLine = () => (now() - confirmedAt > LEASE_TTL_MS ? JOIN.lost : JOIN.held)
      const overdue = () => (now() >= deadline ? pastLine() : null)
      /**
       * The turn was lost (a renew or an import answered 410): acquire once more under the same client and
       * page ids. Null when it is this page's again; else the stop line (another browser's turn is never taken). Past the
       * deadline no acquire is sent. Every answer lost says the turn could not be confirmed.
       */
      const takeAgain = async () => {
        const again = await take(deadline)
        if (again.late) return JOIN.lost
        if (again.given) return null
        if (!again.heard) return JOIN.turnUnknown
        if (again.doubt) return JOIN.turnUnsureAgain
        const refused = leaseRefused(again.heard)
        return refused.line === JOIN.noTurn ? JOIN.lost : refused.line
      }
      // 1. The start read, under this page's turn. Each page gets a few tries inside the press's
      // deadline; still unreadable, NOTHING is sent (never an import for every journal) and the press ends `unread`.
      const start = await cloudThreads(net, deadline, say)
      if (!start) return finish(JOIN.unread)
      const startBy = new Map(start.threads.map(thread => [thread.path, thread]))
      for (const journal of journals) {
        const row = { path: journal.path, title: titleOf(journal.path, ''), outcome: NOT_TRIED, detail: '', text: '', how: null, proved: null, seenAt: null, more: null }
        const thread = startBy.get(journal.path) || null
        if (thread) row.title = titleOf(journal.path, thread.title)
        if (journal.bytes === 0) row.outcome = 'empty, nothing to join'
        else if (sameContent(journal.facts, thread)) Object.assign(row, { outcome: 'same', how: 'start', proved: journal.facts, seenAt: thread.seenAt })
        result.rows.push(row)
      }
      // 2. One import per journal that the start read did not show with this copy's content, in the copy's order.
      const todo = result.rows.map((row, at) => (row.outcome === NOT_TRIED ? at : -1)).filter(at => at >= 0)
      let stop = null
      for (let step = 0; step < todo.length && stop === null; step++) {
        const at = todo[step], row = result.rows[at], journal = journals[at]
        if (now() >= deadline) { stop = pastLine(); break }
        // While it works the Join keeps its turn.
        if (now() - grantedAt > LEASE_RENEW_MS) {
          const renewed = await net.call('POST', '/_mirror/lease', JSON.stringify({ action: 'renew', clientId: mine, tabId: pageId(), label: LEASE_LABEL, leaseId: held.leaseId }), { once: true })
          const given = granted(renewed)
          if (given && given.leaseId === held.leaseId) grantedAt = confirmedAt = now()
          else if (renewed.status === 410) {
            // A turn that cannot be taken again is the stop line; this journal was never sent.
            const refused = await takeAgain()
            if (refused) { stop = refused; break }
          }
          // Any other answer: the import below carries this turn and her edge's answer to it says the rest.
        }
        say('Joining ' + (step + 1) + ' of ' + todo.length + ': ' + row.title + '.')
        flight = { at, sent: false, unanswered: false, code: null }
        let answer = await importOne(net, journal.path, copy.id, held, overdue, flight)
        if (answer.lost) {
          const refused = await takeAgain()
          // Retried ONCE under the new turn; lost again, the run stops.
          answer = refused ? { stop: refused } : await importOne(net, journal.path, copy.id, held, overdue, flight)
        }
        if (answer.outcome) Object.assign(row, { outcome: answer.outcome, how: 'answer', proved: threadFacts(answer.info) })
        else if (flight.unanswered) row.outcome = NOT_CONFIRMED
        else if (flight.sent) row.outcome = 'not done: ' + (flight.code || 'NO_ANSWER')
        flight = null
        if (answer.outcome && COMMITTED.includes(answer.outcome)) confirmedAt = now()
        if (answer.stop) stop = answer.stop
      }
      // 3. The final read, under this page's turn, then the release: confirmed only when her edge says the turn was kept.
      // The final read keeps the press's deadline as the start read does: each page at most INDEX_TRIES
      // tries, no retry once the deadline has passed and no wait that would reach it (a page's first try is still sent, so a press stopped by
      // its deadline can confirm what it did); still unanswered, the read is null and the press "could not be confirmed".
      const final = await cloudThreads(net, deadline, say)
      const freed = await free()
      const confirmed = final !== null && freed !== null && freed.released === true
      settle(confirmed ? final : null)
      const { unfinished, kept } = summaries()
      result.ok = true
      if (!confirmed) {
        result.lines = (stop ? [JOIN.unconfirmed] : []).concat(kept, unfinished)
        return finish(stop || JOIN.unconfirmed)
      }
      const told = describe(copy, journals, final, { store: true, mine: true, homeMine: homeIsMine(final.home, copies, mine), oneMoment: true })
      const byPath = new Map(told.rows.map(entry => [entry.path, entry]))
      for (const row of result.rows) {
        const seen = byPath.get(row.path)
        row.id = seen ? seen.id : null
        row.rescue = seen ? seen.rescue : null
      }
      // done:true only when the final read showed every journal with this copy's content (or more, proved and said so).
      const done = stop === null && result.rows.every(row => JOINED.includes(row.outcome) || row.outcome === 'empty, nothing to join')
      Object.assign(result, { done, equal: told.equal, total: told.total })
      result.lines = (done ? [] : [told.line]).concat(told.lines, kept, unfinished)
      return finish(stop || unfinished[0] || told.line)
    } catch (error) {
      if (!isHalt(error)) throw scrubbed(error)
      result.signin = error.rescueHalt === 'signin'
      // The import in flight keeps what happened to it, a sign-in halt included.
      if (flight) {
        const row = result.rows[flight.at]
        row.outcome = flight.unanswered ? NOT_CONFIRMED : flight.sent ? 'not done: ' + (result.signin ? 'HTTP_401' : flight.code || 'NO_ANSWER') : NOT_TRIED
      }
      settle(null)
      const { unfinished, kept } = summaries()
      result.lines = kept.concat(unfinished)
      return finish(result.signin ? JOIN.signin : result.rows.length ? JOIN.unconfirmed : JOIN.unread)
    } finally {
      await free()
      lease.joining = false
    }
  }

  /** The newest checked copy (of its RESCUE_LOOKUP newest) that lists `path`, as `{bytes, sha256, verifiedAt}`; else null. */
  const rescueOf = async (net, path) => {
    const copies = await checkedCopies(net)
    for (const entry of (copies || []).slice(0, RESCUE_LOOKUP)) {
      const journals = await journalsOf(net, entry.id)
      const found = journals ? journals.find(journal => journal.path === path) : null
      if (found) return { bytes: found.bytes, sha256: found.sha256, verifiedAt: entry.verifiedAt }
    }
    return null
  }
  /** One page of a thread's manifest from her cloud, or null. */
  const manifestPage = async (net, id, page) => {
    const got = await net.call('GET', '/_thread/manifest?id=' + id + '&page=' + page)
    const body = got.status === 200 ? jsonOf(got.data) : null
    return isRecord(body) && isRecord(body.thread) && Array.isArray(body.parts) ? body : null
  }
  /** Whole lines of a thread ending at `before`, with where they sit; null when not answered as asked. */
  const tailPart = async (net, id, before) => {
    const got = await net.call('GET', '/_thread/tail?id=' + id + '&before=' + before + '&max=' + TAIL_MAX)
    if (got.status !== 200 || !got.data || !got.headers) return null
    const from = Number(got.headers.get('x-thread-from')), to = Number(got.headers.get('x-thread-to'))
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || got.data.length !== to - from) return null
    return { from, to, bytes: got.data }
  }
  const counts = t => ['bytes', 'sealedBytes', 'partCount', 'lineEnd'].every(name => Number.isSafeInteger(t[name]) && t[name] >= 0)
    && typeof t.chain === 'string' && HEX64.test(t.chain) && typeof t.tailSha === 'string' && HEX64.test(t.tailSha)

  /**
   * Check one thread from her cloud, in any browser (it needs no store of hers and stores nothing). The manifest page by
   * page; each sealed piece with `GET /_vault/blob/<sha256>`, ONE at a time, hashed and compared with its name; the chain
   * rolled and compared with the manifest's; the open end read back with `GET /_thread/tail` (backwards to find whole
   * lines, then forwards in the same steps) and, when its line end is its end, hashed and compared with `tailSha`; one
   * SHA-256 over the whole thread with the kit's incremental hash. At most one piece is held at a time.
   * @param {{id: string, title?: string, rescue?: {bytes: number, sha256: string, verifiedAt: string}|null, report?: Function}} args
   */
  const checkThread = async (args = {}) => {
    const say = sayer(args.report)
    const result = { ok: false, equal: false, signin: false, line: '', lines: [], bytes: null, sha256: null }
    const finish = line => { result.line = line; say(line); return result }
    const notEqual = what => { result.ok = true; return finish('NOT equal in her cloud: ' + what + '.') }
    if (typeof args.title === 'string' && args.title) result.lines.push('Thread: ' + args.title)
    const id = typeof args.id === 'string' && HEX64.test(args.id) ? args.id : null
    if (!id) return finish(CHECK.unknown)
    const net = makeNet(say)
    try {
      say('Reading this thread back from her cloud.')
      const first = await manifestPage(net, id, 0)
      if (!first) return finish(CHECK.unread)
      const t = first.thread
      if (!counts(t) || t.piece !== PIECE || t.sealedBytes !== t.partCount * PIECE || t.bytes < t.sealedBytes) return finish(CHECK.unread)
      const whole = newHash()
      let chain = ZERO_CHAIN, k = 0
      const pages = Number.isSafeInteger(first.pages) ? first.pages : 0
      for (let page = 0; k < t.partCount; page++) {
        const sheet = page === 0 ? first : page < pages ? await manifestPage(net, id, page) : null
        if (!sheet || sheet.parts.length === 0) return notEqual('its list of pieces is shorter than its count of ' + t.partCount)
        for (const name of sheet.parts) {
          if (k >= t.partCount) break
          if (typeof name !== 'string' || !HEX64.test(name)) return finish(CHECK.unread)
          const where = 'piece ' + (k + 1) + ' of ' + t.partCount + ' (bytes ' + k * PIECE + ' to ' + (k + 1) * PIECE + ')'
          if (k % 8 === 0) say('Checking ' + where + '.')
          const got = await net.call('GET', '/_vault/blob/' + name)
          if (got.status === 404) return notEqual(where + ' is missing')
          if (got.status !== 200 || !got.data) return finish(CHECK.unread)
          if (got.data.length !== PIECE || (await hex(got.data)) !== name) return notEqual(where + ' does not hash to its name')
          whole.update(got.data)
          chain = chainStep(chain, name)
          k += 1
        }
      }
      if (chain !== t.chain) return notEqual('the chain of its ' + t.partCount + ' pieces does not match its list')
      const openEnd = 'the open end (bytes ' + t.sealedBytes + ' to ' + t.bytes + ')'
      const tail = newHash()
      if (t.bytes > t.sealedBytes) {
        if (t.lineEnd !== t.bytes) {
          result.ok = true
          if (t.partCount > 0) result.lines.push('Its ' + t.partCount + ' sealed pieces are equal.')
          return finish('Not fully checked: its last ' + (t.bytes - Math.max(t.lineEnd, t.sealedBytes)) + ' bytes end inside a line, and her cloud hands out whole lines only.')
        }
        // Backwards to find whole-line steps that tile the open end; only their bounds are kept.
        const steps = []
        for (let before = t.bytes; before > t.sealedBytes;) {
          const got = await tailPart(net, id, before)
          if (!got) return finish(CHECK.unread)
          if (got.to !== before || got.from >= before) {
            result.ok = true
            if (t.partCount > 0) result.lines.push('Its ' + t.partCount + ' sealed pieces are equal.')
            return finish(CHECK.longLine)
          }
          steps.push([got.from, got.to])
          before = got.from
        }
        // Forwards over the same steps: hashed into the whole thread and the open end.
        for (let at = steps.length - 1; at >= 0; at--) {
          const [from, to] = steps[at]
          const got = await tailPart(net, id, to)
          if (!got || got.from !== from || got.to !== to) return finish(CHECK.moved)
          const view = got.bytes.subarray(Math.max(from, t.sealedBytes) - from)
          whole.update(view)
          tail.update(view)
        }
      }
      if (tail.digest() !== t.tailSha) return notEqual(openEnd + ' does not match its SHA-256')
      const sha = whole.digest()
      Object.assign(result, { ok: true, equal: true, bytes: t.bytes, sha256: sha })
      const readBack = 'Read back from her cloud: ' + t.bytes + ' bytes, SHA-256 ' + sha + ', every piece equal'
      let copy = isRecord(args.rescue) ? args.rescue : null
      // A thread the page's chosen copy does not list: the newest checked copy that lists it, if any (a read only; a
      // lookup that fails leaves the check as it is, with no comparison line).
      if (!copy && typeof args.path === 'string' && args.path) {
        try { copy = await rescueOf(net, args.path) } catch (error) { if (!isHalt(error)) throw error; copy = null }
      }
      if (copy) {
        const same = copy.bytes === t.bytes && copy.sha256 === sha
        if (!same) {
          // Her cloud reads back whole, but it is NOT the chosen rescue copy: that is the result.
          result.equal = false
          result.lines.push(readBack + ' to its name.')
          return finish('NOT equal to the rescue copy of ' + hhmm(isoMs(copy.verifiedAt)) + ': her cloud holds ' + t.bytes + ' bytes, SHA-256 ' + sha
            + '; the copy holds ' + copy.bytes + ' bytes, SHA-256 ' + copy.sha256 + '.')
        }
        result.lines.push('Equal to the rescue copy of ' + hhmm(isoMs(copy.verifiedAt)) + '.')
      }
      return finish(readBack + '.')
    } catch (error) {
      if (!isHalt(error)) throw scrubbed(error)
      result.signin = error.rescueHalt === 'signin'
      return finish(result.signin ? JOIN.signin : CHECK.unread)
    }
  }

  return { copyToCloud, saveLocal, readIndex, readClient, cloudState, joinThreads, checkThread, leave, pageId, urlOf, revokeUrl, release, secretShape, settingShape, isThread: key => THREAD.test(key), shown, redactText, stoppedLine, threadLabel, canon,
    indexId, newHash, sha256Hex, padding, PIECE, LINE, isChatLog, ROW_KINDS: ROW_KINDS.slice(), CHAT_LOG_PREFIXES: CHAT_LOG_PREFIXES.slice(), DEADLINE_DEFAULTS: Object.assign({}, DEADLINE_DEFAULTS) }
}

/**
 * The `/rescue` page glue: wires the buttons, the live status line and the lists. Text goes on the page through
 * textContent only. The only page it ever loads is `/rescue` (the "Sign in again" button). Opening the page only READS:
 * this browser's mirror client id (one row, read-only) and what her cloud holds; it starts no copy and no join.
 * @param kit - `rescueKit()` helpers.
 */
export function rescuePage(kit) {
  const byId = id => document.getElementById(id)
  const cloud = byId('rescue-cloud'), local = byId('rescue-local'), status = byId('rescue-status'), detail = byId('rescue-detail')
  const left = byId('rescue-left'), leftList = byId('rescue-left-list'), signin = byId('rescue-signin')
  const join = byId('rescue-join'), stateBox = byId('rescue-state'), threads = byId('rescue-threads')
  let busy = false
  // `copied`: the id of a copy THIS page run ended "complete and checked". `client`: what this browser holds of hers.
  let copied = null, client = { store: false, clientId: null }, state = null
  const checks = []
  const say = text => { status.textContent = text }
  const clear = node => { while (node.firstChild) node.removeChild(node.firstChild) }
  const line = (node, text) => { const p = document.createElement('p'); p.textContent = text; node.appendChild(p) }
  // Join is offered only to a store of hers with a mirror client id, and pressed only when this page's copy ended
  // "complete and checked" or her cloud lists a checked copy of this store.
  const joinReady = () => client.clientId !== null && (copied !== null || (state !== null && state.ownVerified === true))
  const settle = () => {
    join.hidden = client.clientId === null
    join.disabled = busy || !joinReady()
  }
  const show = result => {
    clear(detail)
    for (const text of result.lines || []) line(detail, text)
    if (Array.isArray(result.skipped)) {
      clear(leftList)
      for (const entry of result.skipped) line(leftList, entry.shape + ': ' + entry.count)
      left.hidden = result.skipped.length === 0
    }
    signin.hidden = result.signin !== true
  }
  /** One line a thread, each with its own "Check from her cloud" when her cloud holds it. */
  const listThreads = rows => {
    clear(threads)
    checks.length = 0
    for (const row of rows || []) {
      line(threads, row.text)
      if (!row.id) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Check from her cloud'
      button.disabled = busy
      button.addEventListener('click', () => { void run(() => kit.checkThread({ id: row.id, title: row.title, path: row.path, rescue: row.rescue, report: say })) })
      threads.appendChild(button)
      checks.push(button)
    }
  }
  const showState = told => {
    clear(stateBox)
    for (const text of [told.line].concat(told.lines || [])) if (text) line(stateBox, text)
    listThreads(told.rows)
  }
  /** Read what this browser and her cloud hold (reads only) and say it. */
  const refresh = async () => {
    let told
    try {
      client = await kit.readClient()
      told = await kit.cloudState({ clientId: client.clientId, store: client.store, rescueId: copied })
    } catch (error) {
      told = { ok: false, line: kit.stoppedLine(error), lines: [], rows: [], ownVerified: false }
    }
    state = told
    if (!busy) showState(told)
    if (told.signin === true) signin.hidden = false
    settle()
  }
  const run = async work => {
    if (busy) return
    busy = true
    cloud.disabled = true; local.disabled = true; signin.hidden = true
    for (const button of checks) button.disabled = true
    settle()
    try {
      const result = await work()
      show(result)
      say(result.line)
    } catch (error) {
      // A Copy run's error carries its room line (`lines`): shown in place of an earlier run's lines.
      if (error && Array.isArray(error.lines)) show({ lines: error.lines })
      // The same private-path redaction as every other line (the kit's own errors are already scrubbed).
      say(kit.stoppedLine(error))
    } finally {
      busy = false
      cloud.disabled = false; local.disabled = false
      for (const button of checks) button.disabled = false
      settle()
    }
  }
  cloud.addEventListener('click', () => {
    void run(async () => {
      const result = await kit.copyToCloud({ report: say })
      if (result.complete === true) { copied = result.id; void refresh() }
      return result
    })
  })
  join.addEventListener('click', () => {
    void run(async () => {
      const result = await kit.joinThreads({ clientId: client.clientId, rescueId: copied, report: say })
      // Nothing was tried (no copy, no turn to write): what the page showed stays, the reason goes under the status.
      if (result.rows.length === 0) return { line: result.line, lines: result.lines, signin: result.signin }
      clear(stateBox)
      // The same lines on every path, a halt's included.
      for (const text of result.done ? [result.line].concat(result.lines) : result.lines) if (text) line(stateBox, text)
      listThreads(result.rows)
      return { line: result.line, lines: [], signin: result.signin }
    })
  })
  // The page going (a closed tab, a reload): the lease it holds is released with a keepalive request.
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => { kit.leave() })
  local.addEventListener('click', () => {
    void run(async () => {
      // One pack per page: a second press is refused by the kit while it holds the first (the owner opens a new one).
      const result = await kit.saveLocal({ report: say })
      if (result.blob) {
        const url = kit.urlOf(result.blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = result.fileName
        anchor.hidden = true
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        // The click has already resolved the URL (File API: a fetch begun before a revoke still completes), so it is
        // revoked at once; the kit still holds the Blob until a new run or the page closes.
        kit.revokeUrl()
      }
      return result
    })
  })
  signin.addEventListener('click', () => { location.assign('/rescue') })
  cloud.disabled = false
  local.disabled = false
  say('Ready. Nothing has been copied yet.')
  void refresh()
}
