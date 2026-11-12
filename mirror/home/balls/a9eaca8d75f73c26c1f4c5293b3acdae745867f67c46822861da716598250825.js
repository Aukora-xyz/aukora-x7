// auma-cortex v1 — the read-only awareness organ for Auma's live voice.
//
// Authority law: every return carries voiceAuthority:'none' and mutating:false. There is no
// write/stage/promote/approve/secret verb in the action surface, and no code path mutates state.
// That is enforced by the surface being closed, not by a sentence in a prompt.
//
// Zero imports. Zero clock. Zero randomness. All external truth is INJECTED (ctx.cortex / args.*)
// so the organ can be graded offline and can never invent a source it was not given.

const DIGEST_ALGO = 'fnv1a64-noncrypto'
const NOT_VISIBLE = [
  'host-side secrets and provider keys',
  '/dsh/home/auma/private/** beyond existence and size',
  "another tab's local state",
  'the DOM unless auma_eyes projects it',
  'anything the owner has not exposed to this body',
]

// Unambiguous state-changing verbs: if one appears anywhere in the utterance, refuse.
const MUTATION_ANYWHERE = /\b(approve|promote|promotion|stage|staged|push|publish|delete|destroy|spend|pay|sign|redeem|invite|mint|rotate|revoke|rollback|upgrade|mount|unmount)\b/i
// Anchored imperatives: only dangerous at the start of the sentence.
const MUTATION_IMPERATIVE = /^\s*(please\s+)?(add|attach|append|edit|modify|change|set|write|commit|patch|disable|enable|grant|execute|run|do|make|fix)\b/i
const SECRET_SHAPED = /\b(passkey|private\s*key|seed\s*phrase|mnemonic|api\s*key|secret|token|credential|owner-grant|aumlok|keychain)\b/i

function isStr(v) { return typeof v === 'string' }

function fnv1a64(text) {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i) & 0xff)
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
}

function seal(payload) {
  return Object.assign({ voiceAuthority: 'none', mutating: false }, payload)
}

function deny(code, detail, extra) {
  return seal(Object.assign({ ok: false, refused: true, code, detail }, extra || {}))
}

function sourceOf(args, ctx) {
  return (ctx && ctx.cortex) || (args && args.cortex) || null
}

function readerOf(args, ctx) {
  const s = sourceOf(args, ctx)
  if (s && s.fs && typeof s.fs.readFileSync === 'function') return s.fs
  if (args && args.fs && typeof args.fs.readFileSync === 'function') return args.fs
  if (ctx && ctx.fs && typeof ctx.fs.readFileSync === 'function') return ctx.fs
  return null
}

// ---- Tier A: resident truth. Re-read every call. There is no cache to go stale. ----
function resident(args, ctx) {
  const headPath = (args && args.headPath) || '/dsh/home/balls/HEAD.json'
  const injected = (args && args.head) || (sourceOf(args, ctx) || {}).head
  if (injected && typeof injected === 'object') {
    return seal({
      ok: true, tier: 'A', cache: 'none', source: injected.source || 'injected',
      epoch: injected.epoch, ballId: injected.ballId, parentBallId: injected.parentBallId || null,
      entries: injected.entries ? Object.keys(injected.entries).length : null,
    })
  }
  const reader = readerOf(args, ctx)
  if (!reader) return deny('CORTEX_HEAD_UNREADABLE', 'no ctx.fs / ctx.cortex.head supplied; cannot state the live epoch')
  let head
  try { head = JSON.parse(String(reader.readFileSync(headPath, 'utf8'))) } catch (e) {
    return deny('CORTEX_HEAD_UNREADABLE', 'HEAD.json did not parse: ' + ((e && e.message) || 'unknown'))
  }
  if (!head || typeof head.epoch !== 'number') return deny('CORTEX_HEAD_UNREADABLE', 'HEAD.json carries no numeric epoch')
  return seal({
    ok: true, tier: 'A', cache: 'none', source: headPath,
    epoch: head.epoch, ballId: head.ballId, parentBallId: head.parentBallId || null,
    entries: head.entries ? Object.keys(head.entries).length : null,
  })
}

// ---- Derived capability index. Never hand-authored. Carries its own digest and a staleness test. ----
function buildIndex(args, ctx) {
  const s = sourceOf(args, ctx) || {}
  const tools = Array.isArray(args && args.tools) ? args.tools : (Array.isArray(s.tools) ? s.tools : [])
  const organs = Array.isArray(args && args.organs) ? args.organs : (Array.isArray(s.organs) ? s.organs : [])
  const routes = Array.isArray(args && args.routes) ? args.routes : (Array.isArray(s.routes) ? s.routes : [])
  const head = (args && args.head) || s.head || null
  if (!tools.length && !organs.length) return { ok: false, code: 'CORTEX_INDEX_UNSOURCED', detail: 'no tool or organ inventory supplied; refusing to describe a body it cannot see' }

  const t = tools.map(x => ({
    name: String(x && x.name || ''),
    readOnly: Boolean(x && (x.readOnly === true || x.mutating === false)),
    keys: Array.isArray(x && x.schemaKeys) ? x.schemaKeys.slice().sort() : [],
  })).filter(x => x.name).sort((a, b) => a.name < b.name ? -1 : 1)
  const o = organs.map(x => ({
    id: String(x && x.id || ''),
    specifier: String(x && (x.specifier || x.ball) || ''),
    bytes: typeof (x && x.bytes) === 'number' ? x.bytes : null,
    authority: (x && x.authority) || 'unspecified',
  })).filter(x => x.id).sort((a, b) => a.id < b.id)

  const body = {
    schema: 'aukora.cortex.capability-index.v1',
    epoch: head && typeof head.epoch === 'number' ? head.epoch : null,
    ballId: (head && head.ballId) || null,
    tools: t, organs: o,
    routes: routes.map(r => ({ path: String(r && r.path || ''), method: String(r && r.method || ''), auth: String(r && r.auth || '') })),
    writeTools: t.filter(x => !x.readOnly).map(x => x.name),
  }
  const digest = fnv1a64(canonical(body))
  const expected = (args && args.expectedDigest) || s.expectedDigest || null
  const stale = expected !== null && expected !== digest
  return { ok: true, index: body, digest, digestAlgo: DIGEST_ALGO, expectedDigest: expected, stale }
}

function index(args, ctx) {
  const built = buildIndex(args, ctx)
  if (!built.ok) return deny(built.code, built.detail)
  if (built.stale) return deny('CORTEX_INDEX_STALE', 'derived index digest ' + built.digest + ' != pinned ' + built.expectedDigest + '; capability claims are withheld rather than served stale', { digestAlgo: built.digestAlgo, computed: built.digest })
  return seal({
    ok: true, tier: 'A', cache: 'none', digestAlgo: built.digestAlgo, digest: built.digest,
    epoch: built.index.epoch, ballId: built.index.ballId,
    tools: built.index.tools.length, organs: built.index.organs.length,
    writeToolsOnCortexSurface: 0, index: built.index,
  })
}

// ---- Unknown-capability refusal: the case that catches every prompt-only version. ----
function explain(args, ctx) {
  const built = buildIndex(args, ctx)
  if (!built.ok) return deny(built.code, built.detail)
  const target = (args && (args.target || args.query)) || ''
  const names = new Set(built.index.tools.map(x => x.name).concat(built.index.organs.map(x => x.id)))
  const asked = String(target).match(/`([^`]+)`/) ? String(target).match(/`([^`]+)`/)[1] : String(target).trim()
  if (!asked) return deny('CORTEX_TARGET_REQUIRED', 'no target named')
  if (!names.has(asked)) {
    return deny('CORTEX_UNKNOWN_CAPABILITY', 'no such surface in the derived index: ' + asked, {
      target: asked, known: false, fabricated: false, indexDigest: built.digest,
    })
  }
  const asTool = built.index.tools.find(x => x.name === asked)
  if (asTool) return seal({ ok: true, tier: 'B', cache: 'none', target: asked, kind: 'tool', readOnly: asTool.readOnly, keys: asTool.keys, source: 'derived-index', indexDigest: built.digest })
  const asOrgan = built.index.organs.find(x => x.id === asked)
  return seal({ ok: true, tier: 'B', cache: 'none', target: asked, kind: 'organ', authority: asOrgan.authority, bytes: asOrgan.bytes, specifier: asOrgan.specifier, source: 'derived-index', indexDigest: built.digest })
}

// ---- Tier C: bounded bit ledger. Counts, and names what it cannot see. ----
function bitLedger(args, ctx) {
  const s = sourceOf(args, ctx) || {}
  const inventory = (args && args.inventory) || s.inventory || null
  if (!inventory || typeof inventory !== 'object') return deny('CORTEX_LEDGER_UNSOURCED', 'no bounded inventory supplied; refusing to enumerate a body it cannot see')
  const limit = Math.max(1, Math.min(Number((args && args.limit) || 50), 200))
  const rows = []
  for (const key of Object.keys(inventory).sort()) {
    if (rows.length >= limit) break
    const v = inventory[key]
    rows.push({ key, value: (typeof v === 'number' || typeof v === 'string') ? v : '[object]' })
  }
  return seal({
    ok: true, tier: 'C', cache: 'none', trust: 'tool-output', source: s.ledgerSource || 'injected-inventory',
    rows, truncated: Object.keys(inventory).length > rows.length,
    notVisible: NOT_VISIBLE.slice(),
  })
}

// ---- Federation. Returns hits with trust labels, never opinions. ----
function search(args, ctx) {
  const s = sourceOf(args, ctx) || {}
  const readers = Array.isArray(s.readers) ? s.readers : (Array.isArray(args && args.readers) ? args.readers : [])
  const q = String((args && args.query) || '').trim()
  if (!q) return deny('CORTEX_QUERY_REQUIRED', 'no query supplied')
  if (!readers.length) return deny('CORTEX_SEARCH_UNSOURCED', 'no federated readers supplied; refusing to answer from imagination')
  const limit = Math.max(1, Math.min(Number((args && args.limit) || 8), 40))
  const hits = []
  const failures = []
  for (const r of readers) {
    if (typeof r.search !== 'function') { failures.push(String(r.name || 'unnamed') + ':not-searchable'); continue }
    try {
      const out = r.search(q, limit) || []
      for (const h of out) {
        if (hits.length >= limit) break
        hits.push({
          sourceKind: String(h.sourceKind || r.kind || 'tool-output'),
          trust: String(h.trust || r.trust || 'tool-output'),
          path: h.path || null, line: h.line || null, seq: h.seq || null,
          sha: h.sha || null, text: String(h.text || '').slice(0, 240),
        })
      }
    } catch (e) { failures.push(String(r.name || 'unnamed') + ':' + ((e && e.message) || 'error')) }
  }
  return seal({ ok: true, tier: 'C', cache: 'none', query: q, hits, failures, attributable: hits.length > 0 })
}

// ---- Threads: resolve real conversations only. ----
function threads(args, ctx) {
  const s = sourceOf(args, ctx) || {}
  const list = Array.isArray(s.threads) ? s.threads : (Array.isArray(args && args.threads) ? args.threads : [])
  if (!list.length) return deny('CORTEX_THREADS_UNSOURCED', 'no session/transcript index supplied; cannot resolve a thread without inventing one')
  const limit = Math.max(1, Math.min(Number((args && args.limit) || 5), 20))
  return seal({
    ok: true, tier: 'B', cache: 'none', trust: 'carrier-file', source: s.threadSource || 'injected-session-index',
    threads: list.slice(0, limit).map(t => ({ id: String(t.id || ''), title: String(t.title || ''), lastAt: t.lastAt || null, turns: t.turns || null })),
  })
}

// ---- The gate every utterance passes through before any work is done. ----
function intentGate(text) {
  if (!isStr(text)) return null
  if (SECRET_SHAPED.test(text)) return deny('CORTEX_SECRET_REFUSED', 'secret-shaped request; nothing spoken can expose a credential, and this surface holds none', { known: false })
  if (MUTATION_ANYWHERE.test(text) || MUTATION_IMPERATIVE.test(text)) {
    return deny('CORTEX_AUTHORITY_DENIED', 'this surface has no write authority; spoken words cannot change body state — a draft may be offered for the owner to act on with a passkey', { requires: 'owner-passkey', tier: 'Class 3' })
  }
  return null
}

const ACTIONS = ['resident', 'index', 'explain', 'search', 'threads', 'bitLedger']

async function run(args, ctx) {
  const a = args || {}
  const utterance = [a.query, a.target, a.text].filter(isStr).join(' ')
  const gated = intentGate(utterance)
  if (gated) return gated
  switch (a.action) {
    case 'resident': return resident(a, ctx)
    case 'index': return index(a, ctx)
    case 'explain': return explain(a, ctx)
    case 'search': return search(a, ctx)
    case 'threads': return threads(a, ctx)
    case 'bitLedger': return bitLedger(a, ctx)
    default: return deny('CORTEX_ACTION_UNKNOWN', 'unknown action; surface is exactly ' + ACTIONS.join('|'), { actions: ACTIONS.slice() })
  }
}

module.exports = {
  name: 'auma_cortex',
  description: 'Read-only awareness surface for Auma Live voice: resident epoch truth, a derived capability index with digest and staleness gate, federated search with trust labels, bounded bit ledger, and thread resolution. Zero write authority.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      query: { type: 'string' },
      target: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['action'],
  },
  run,
  // exported for offline grading only — not part of the mounted tool surface
  _internals: { buildIndex, fnv1a64, canonical, intentGate, ACTIONS, NOT_VISIBLE },
}
