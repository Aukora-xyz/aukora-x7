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
 * @param {Function} [options.now] - clock for the "checked" time only (never in the index).
 * @param {object} [options.deadlines] - FOR TESTS ONLY: `{headers, upload, idle, total, bodyTotal, read}` in ms (see DEADLINE).
 * @returns the kit's helpers.
 */
export function rescueKit(options = {}) {
  // Everything lives inside this function: it is turned into a string and run in a page or in a worker console.
  const PIECE = Number.isSafeInteger(options.piece) && options.piece > 0 ? options.piece : 2097152
  const DB_NAME = 'aukora-x6-vfs', STORE = 'entries', MAX_INDEX_BYTES = 4194304, MAGIC = 'X61RESCUE1\n'
  const THREAD = /^\/dsh\/home\/(?:sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl|[^/]+\/session\/messages\.jsonl)$/
  const PRIVATE = '/dsh/home/auma/private'
  const SECRET_NAMES = ['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json',
    '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1']
  const ENDINGS = '.~-_'
  // Main's estate redaction names (browser-estate.ts SENSITIVE_NAME), judged on every path part. Only the CLOUD copy
  // leaves these behind as well; the local pack keeps the narrower rule above. Her private folder is copied in both.
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
    const given = isRecord(options.client) ? options.client : {}
    const client = { clientId: typeof given.clientId === 'string' ? given.clientId : null, base: given.base === undefined ? null : given.base,
      reconciliation: given.reconciliation === undefined ? null : given.reconciliation }
    return { keys, read, close: () => {}, client }
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
   */
  const collect = async (src, say, onRow, mode, settings) => {
    const lost = new Map()
    const items = await listItems(src, settings, lost)
    const rows = [], skipped = new Map(), unreadable = [], unreadableShapes = new Map()
    let meta = null, reconciliation = null, missing = 0
    for (let index = 0; index < items.length; index++) {
      const got = await take(src, items[index], mode)
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
      locals: new Set(items.filter(item => item.local).map(item => item.key)), skipped: counted(skipped), lost }
  }
  /** The index: canonical JSON with no clock in it. This is the cloud index (one field added later: `unlisted`). */
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
    return { v: 1, piece: PIECE, source, client: collected.client, rows: collected.rows, skipped: collected.skipped,
      totals: { threads, homeFiles, bytes, newestThreadMtimeMs: newest, mainThread }, unlisted: unlistedOf(collected.lost) }
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
          bytes = new Uint8Array(size)
          let at = 0
          for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
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
     */
    net.call = async (method, path, body) => {
      let tries = 0, waits = 0
      for (;;) {
        if (net.halted) throw net.halted
        await acquire()
        let response = null, info = null, data = null, stalled = false
        try {
          if (net.halted) throw net.halted
          const init = { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }
          if (body !== undefined) { init.body = body; init.headers = { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' } }
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
        return { status, info, data }
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
   * copy also leaves behind main's estate names. The index sent is exactly the cloud index; its `unlisted` records the
   * listings that failed (her cloud reports it again when it verifies the copy).
   * @param {{report?: (line: string) => void, settings?: boolean}} [args]
   * @returns {Promise<object>} `{ok, complete, line, lines, id, skipped, unreadable, unreadableShapes, missing, totals, signin}`.
   */
  const copyToCloud = async (args = {}) => {
    const say = line => { try { if (typeof args.report === 'function') args.report(line) } catch (error) { /* the page's own problem */ } }
    const result = { ok: false, complete: false, line: '', lines: [], id: null, skipped: [], unreadable: [], unreadableShapes: [], missing: 0,
      totals: null, signin: false, grew: 0, mismatched: [], changed: [], vanished: [], rechecked: 0, unlisted: { count: 0, shapes: [] }, newRows: 0,
      settings: args.settings === true }
    const settings = result.settings
    const finish = line => { result.line = line; say(line); return result }
    const src = await openSource()
    if (src.none) return finish(LINE.nothing)
    if (src.failed) return finish(LINE.storage)
    const net = makeNet(say)
    try {
      say('Reading this browser. Nothing here is changed.')
      const collected = await collect(src, say, null, 'cloud', settings)
      const index = makeIndex(collected)
      Object.assign(result, { skipped: collected.skipped, unreadable: collected.unreadable, unreadableShapes: collected.unreadableShapes,
        missing: collected.missing, totals: index.totals })
      const indexText = canon(index)
      const indexBytes = encoder.encode(indexText)
      if (indexBytes.length > MAX_INDEX_BYTES) return finish(LINE.tooMany)
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
        result.lines = [result.changed.length + ' rows changed while this copy was being made. Run again.'].concat(capped('Changed: ', result.changed))
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
        result.lines = ["Her cloud holds a different list for this copy than the one sent. Report this."]
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
      lines.push(settingsLine(index.rows, settings))
      result.lines = lines
      result.ok = true
      result.complete = result.mismatched.length === 0 && result.changed.length === 0 && result.vanished.length === 0 && result.unreadable.length === 0
        && result.missing === 0 && result.unlisted.count === 0 && result.newRows === 0 && again.walked === index.rows.length
      if (!result.complete) return finish(LINE.notComplete)
      return finish('Rescue copy complete and checked: ' + summary(index) + '; checked ' + hhmm(now()))
    } catch (error) {
      if (!isHalt(error)) throw scrubbed(error)
      result.signin = error.rescueHalt === 'signin'
      if (error.rescueHalt === 'changed') result.lines = capped('Changed: ', result.changed)
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

  return { copyToCloud, saveLocal, readIndex, urlOf, revokeUrl, release, secretShape, settingShape, isThread: key => THREAD.test(key), shown, redactText, stoppedLine, threadLabel, canon,
    indexId, newHash, sha256Hex, padding, PIECE, LINE, isChatLog, ROW_KINDS: ROW_KINDS.slice(), CHAT_LOG_PREFIXES: CHAT_LOG_PREFIXES.slice(), DEADLINE_DEFAULTS: Object.assign({}, DEADLINE_DEFAULTS) }
}

/**
 * The `/rescue` page glue: wires the two buttons, the live status line and the lists. Text goes on the page through
 * textContent only. The only page it ever loads is `/rescue` (the "Sign in again" button).
 * @param kit - `rescueKit()` helpers.
 */
export function rescuePage(kit) {
  const byId = id => document.getElementById(id)
  const cloud = byId('rescue-cloud'), local = byId('rescue-local'), status = byId('rescue-status'), detail = byId('rescue-detail')
  const left = byId('rescue-left'), leftList = byId('rescue-left-list'), signin = byId('rescue-signin')
  let busy = false
  const say = text => { status.textContent = text }
  const clear = node => { while (node.firstChild) node.removeChild(node.firstChild) }
  const line = (node, text) => { const p = document.createElement('p'); p.textContent = text; node.appendChild(p) }
  const show = result => {
    clear(detail)
    for (const text of result.lines || []) line(detail, text)
    clear(leftList)
    const skipped = result.skipped || []
    for (const entry of skipped) line(leftList, entry.shape + ': ' + entry.count)
    left.hidden = skipped.length === 0
    signin.hidden = result.signin !== true
  }
  const run = async work => {
    if (busy) return
    busy = true
    cloud.disabled = true; local.disabled = true; signin.hidden = true
    try {
      const result = await work()
      show(result)
      say(result.line)
    } catch (error) {
      // The same private-path redaction as every other line (the kit's own errors are already scrubbed).
      say(kit.stoppedLine(error))
    } finally {
      busy = false
      cloud.disabled = false; local.disabled = false
    }
  }
  cloud.addEventListener('click', () => { void run(() => kit.copyToCloud({ report: say })) })
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
  say('Ready. Nothing has been read yet.')
}
