/**
 * THE CAPSULE "ONCE" MODEL (contract milestone M2), for the capsule contract DRAFT 7 (the capsule contract, draft 7). Draft 7 wrote this model's F8 and F9 into 7.4 steps 3 and 5:
 * the sound model (DEFAULT_AMEND, the strict-reading switch off) is draft 7's text; `amend: []` is draft 6's. An explicit-state model of section 6 (the destination ledger,
 * the procedure of 6.7, the table of 6.8) and section 7 (the act key chain of the holder's installation key, and the
 * client of 7.4 read literally), explored breadth first with a visited set.
 *
 * It is a SPECIFICATION, not a test of an implementation: it imports nothing and nothing imports it but its own test.
 * Keys, ids and digests are symbolic (small integers, short deterministic hashes). No randomness, no clock: the same
 * configuration explores the same states in the same order every time.
 *
 * A state is plain JSON:
 *   d    the destination: holder generation and installation key, the lease {held, gen}, the policy, the chain row
 *        {owner, first, used[], cur, start, last, locked}, burned[], the ledger (rows, heads), the valid sessions
 *   b    the bodies: installation key, session, the 7.4 store {cur, next, j, seen, oi} (durable; `oi` is the open
 *        intent, kept apart from the signed request `j`), her notes `cmds` (wishes and the commands she made for them),
 *        hold (volatile), tabs
 *   net  requests and answers in flight; `log` keeps every request sent (for late duplicates)
 *   n    fresh-name counters and per-trace event budgets
 *   g    GHOST state that only the invariants read: effects, filled positions, verified envelopes and their answers,
 *        the ghost chain instance (its keys, rotations, whether a fork has reached it), taints, wish -> intent id, flags
 * Where the text did not determine the model, the reading is marked AMBIGUITY and listed in docs/capsule/MODEL.md.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The faulty protocols of section 8 of draft 6 (32 names), in the order the contract lists them. Each is a switch; the
// sound model has none.
export const CONTRACT_FAULTS = Object.freeze([
  'EpochScopedKey', 'NoFenceAtCommit', 'DedupeByIdOnly', 'ForgetRows', 'NewIntentOnRetry', 'PendingAnsweredAsDone',
  'SecondEnvelopeAccepted', 'ProofOmitsVerb', 'CapBlocksResolution', 'RotateOnUnverified', 'SendBeforeStore',
  'NoLockOnFork', 'SessionInEnvelope', 'GateOnlyAtIntent', 'SameKeyRestartAfterLock', 'FenceBeforeReplay',
  'AbandonGated', 'SuccessorCheckBeforeRetry', 'ChainPerGeneration', 'SecondEnvelopeIsFork', 'StaleGenerationRotates',
  'ThumbOnlyPromotion', 'SingleLeaseCheck', 'ActSkipsInheritedLock', 'FirstKeyForgotten', 'SilentOriginal',
  'NextKeyMayRepeat', 'StoredAnswerForAnyEnvelope', 'LeaseCheckAfterWrite', 'BurnedAtWriteOnly', 'HoldOnEarlierStay',
  'IntentForgottenOnReset',
])
/**
 * This lane's faults for the outside reviewer's three conflicts in draft 5, each the
 * careless reading draft 6 rules out:
 *   LeaseOnlyWithJournal        7.4: a missing lease is taken only when a journal entry exists (draft 5's step 2)
 *   GenerationsComparedInStep5  7.4 step 5 also compares the answer's holder generation with the entry's (draft 5)
 *   SecondCheckOnlyOnSuccess    6.7 step 7 runs only when nothing above refused (draft 5)
 *   ActDenyDropsRow             an act whose commit gate says DENY answers CAPSULE_GATE_DENIED and drops the new row
 *   ActDenyAnswersPending       ... answers `pending` (draft 5's table) and keeps the row
 *   ActCreationDenyKeepsRow     an act whose CREATION gate says DENY answers CAPSULE_GATE_DENIED and keeps a pending row
 *                               (6.8's commit-DENY exception applied to the wrong call; draft 7: "a DENY at creation
 *                               makes no row")
 */
export const OWN_FAULTS = Object.freeze([
  'LeaseOnlyWithJournal', 'GenerationsComparedInStep5', 'SecondCheckOnlyOnSuccess', 'ActDenyDropsRow',
  'ActDenyAnswersPending', 'ActCreationDenyKeepsRow',
])
/** Retired from the bench, with the reason (section 8 of draft 6). */
export const RETIRED_FAULTS = Object.freeze({
  PromoteWithoutGenCheck: 'the envelope digest binds its generations: an answer that matches the journal digest names them',
})
/**
 * The other reading of an ambiguity of draft 6, as a switch (`readings`), so that a test can show what it does:
 *   RetireOnlyOnTerminal  7.4 step 5, first bullet, "Nothing else retires it" read strictly: an open intent refused at
 *                         creation (it never got a row: gate DENY, ledger full) is never retired.
 */
export const READINGS = Object.freeze(['RetireOnlyOnTerminal'])
/**
 * Amendments this model proposes to draft 6 (each a switch; `amend: []` is the text as written). None is on by default
 * unless listed in DEFAULT_AMEND.
 *   ResolveOtherPendingFirst  7.4 step 3: while `status` shows a pending row that is not the open intent's, the body
 *                             first commits or abandons that row under a journal entry of its own, keeping its open intent.
 */
export const AMENDMENTS = Object.freeze(['ResolveOtherPendingFirst'])
export const DEFAULT_AMEND = Object.freeze(['ResolveOtherPendingFirst'])

// ---------------------------------------------------------------------------------------------------------------------
// Symbolic digests (cyrb53, 53 bits; ids are 8 hex digits, checked for collisions).
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (2097152 * (h2 >>> 0) + (h1 >>> 0)).toString(16).padStart(14, '0')
}
const DIGESTS = new Map()
function digest(prefix, canonical) {
  const id = prefix + cyrb53(canonical).slice(0, 8)
  const seen = DIGESTS.get(id)
  if (seen === undefined) DIGESTS.set(id, canonical)
  else if (seen !== canonical) throw new Error(`model digest collision: ${id}`)
  return id
}
/** A state's identity in the visited set: two independent 53-bit hashes of its JSON (cyrb53, seeds 1 and 2, in one pass). */
export function stateKey(json) {
  let a1 = 0xdeadbeef ^ 1
  let a2 = 0x41c6ce57 ^ 1
  let b1 = 0xdeadbeef ^ 2
  let b2 = 0x41c6ce57 ^ 2
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i)
    a1 = Math.imul(a1 ^ ch, 2654435761)
    a2 = Math.imul(a2 ^ ch, 1597334677)
    b1 = Math.imul(b1 ^ ch, 2654435761)
    b2 = Math.imul(b2 ^ ch, 1597334677)
  }
  const fin = (h1, h2) => {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (2097152 * (h2 >>> 0) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return fin(a1, a2) + fin(b1, b2)
}

export const GENESIS = 'g0'
/** Counters the test reads (never state): how often a verified answer for a journal entry named another holder
 * generation than the entry's (draft 6, 7.4 step 5: it cannot; GenerationsComparedInStep5 would act on it). */
export const PROBES = { verifiedOtherGeneration: 0 }
const STRANGER_KEY = 0

/** 6.3: a command's id is the digest of its bytes {seq, prev, intentId, payload} (op and target are fixed). */
export function commandId(cmd) {
  return digest('c', `aukora.act.v1|L|${cmd.seq}|${cmd.prev}|${cmd.iid}|${cmd.pay}`)
}
/** 6.4: the envelope's digest covers every field of the envelope (and the session, under SessionInEnvelope only). */
export function envDigest(env) {
  return digest('e', `aukora.proof.v3|${env.v}|L|${env.hg}|${env.lg}|${env.aid}|${env.by}|${env.nx}|${env.ss ?? ''}`)
}
const signature = (key, env) => `${key}:${envDigest(env)}`

// ---------------------------------------------------------------------------------------------------------------------
// Configuration.
const BUDGET_KEYS = ['moves', 'crashes', 'losses', 'expiries', 'sessions', 'dups', 'policies', 'copies',
  'strangers', 'tampers', 'seen', 'rogue', 'bodyBacks', 'destBacks', 'forgets']

export function makeConfig(over) {
  const budget = Object.fromEntries(BUDGET_KEYS.map(k => [k, 0]))
  return {
    name: 'custom', bodies: ['A', 'B'], cmds: 1, payloads: ['safe'], cap: 4, kept: 2, depth: 8, tabs: 1, lock: true,
    splitSend: false, honest: true, progress: false, progressDepth: 14, actOnPending: true, faults: [], readings: [],
    amend: [], burnCap: 1024, preBurned: [], ...over, budget: { ...budget, ...over.budget },
  }
}

/**
 * The explored scenarios. `gate` is the depth the node test explores; `deep` is the manual bound behind
 * CAPSULE_MODEL_DEEP=1. Every scenario starts with A holding (installation key k1, generation 1, lease generation 1
 * held, no chain row yet) and B an owner body with installation key k2. `kept` scales the 32 retained used keys down
 * (as `cap` scales the 1,024 rows, and `burnCap` the 1,024 burned thumbs).
 * Payloads: `safe` (v0 ALLOW at both calls; v1 ESCALATE), `bad` (DENY), and two whose two gate calls differ (section 8:
 * a throw, a result outside the shape or an unreadable input is DENY): `flaky` (creation ALLOW, commit DENY) and `rev`
 * (creation DENY, commit ALLOW: it can never commit, since no row is made).
 */
export const SCENARIOS = Object.freeze({
  // honest: the list of 7.5 (lost answers, crashes, a new sign-in, network duplication, a lease expiry, a move)
  honest: { gate: 9, deep: 10, honest: true, progress: true, budget: { moves: 1, crashes: 1, losses: 1, sessions: 1, dups: 1, expiries: 1 } },
  // moves: moves that keep the key, moves away and back, late envelopes from an earlier stay, re-issued requests
  moves: { gate: 11, deep: 12, honest: true, progress: true, budget: { moves: 2, losses: 1, dups: 1 } },
  // tabs: two tabs of A under the Web Lock
  tabs: { gate: 8, deep: 9, honest: true, progress: true, tabs: 2, budget: { moves: 1, crashes: 1, losses: 1, expiries: 1 } },
  // full: a ledger of one row, a gate-denied payload, a policy change between intent and commit
  full: { gate: 9, deep: 10, honest: true, progress: true, cap: 1, payloads: ['safe', 'bad'], budget: { moves: 1, losses: 1, policies: 1, expiries: 1 } },
  // gate: the two gate calls of one act disagree (6.7 steps 5(e), 6, 7; 6.8), with a lease expiry between the checks
  gate: { gate: 8, deep: 9, honest: true, progress: true, payloads: ['flaky', 'rev'], budget: { moves: 1, losses: 1, expiries: 1 } },
  // copy: a whole-profile copy at any step of 7.4 (prepare and send apart), a move, a lost answer
  copy: { gate: 9, deep: 10, honest: false, splitSend: true, budget: { copies: 1, moves: 1, losses: 1 } },
  // fork: a copy and a move, one retained used key: the fork, lock and inherited-row traces
  fork: { gate: 9, deep: 10, honest: false, kept: 1, budget: { copies: 1, moves: 1 } },
  // wire: a stranger, a captured request duplicated, one field changed in flight, a body naming a seen key
  wire: { gate: 8, deep: 9, honest: false, budget: { moves: 1, strangers: 1, dups: 1, tampers: 1, seen: 1 } },
  // forget: her memory of a command goes back (her notes, not the act store); two moves (away and back)
  forget: { gate: 10, deep: 11, honest: false, budget: { forgets: 1, losses: 1, moves: 2 } },
  // inherit: A's storage goes back (no copy), the chain locks, the owner moves to B: the row A left behind
  inherit: { gate: 10, deep: 11, honest: false, kept: 1, budget: { bodyBacks: 1, moves: 1 } },
  // limits (goal searches only): two tabs without the lock; a body or the destination going back one step
  tabsUnlocked: { gate: 10, deep: 11, honest: false, tabs: 2, lock: false, budget: { losses: 1 } },
  bodyBack: { gate: 8, deep: 9, honest: false, budget: { bodyBacks: 1 } },
  destBack: { gate: 11, deep: 12, honest: false, kept: 1, budget: { copies: 1, destBacks: 1 } },
  staleCopy: { gate: 12, deep: 13, honest: false, kept: 1, cmds: 2, budget: { copies: 1, rogue: 1 } },
})
export const SOUND_SCENARIOS = Object.freeze(['honest', 'moves', 'tabs', 'full', 'gate', 'copy', 'fork', 'wire', 'forget', 'inherit'])

export function scenario(name, { deep = false, faults = [], amend = DEFAULT_AMEND, readings = [], depth, budget, over = {} } = {}) {
  const sc = SCENARIOS[name]
  return makeConfig({ ...sc, ...over, name, depth: depth ?? (deep ? sc.deep : sc.gate), faults: [...faults], amend: [...amend], readings: [...readings], budget: { ...sc.budget, ...budget } })
}

function newBody(name, ik, holder, cfg, tabs) {
  return {
    ik, sess: `s${name}`, st: { cur: ik, next: null, j: null, seen: [holder ? 1 : 0, 0, GENESIS], oi: null }, cmds: [], hold: null,
    tabs, snaps: tabs > 1 && !cfg.lock ? Array.from({ length: tabs }, () => null) : null, vol: null, back: null,
  }
}

export function initialState(cfg) {
  const b = {}
  cfg.bodies.forEach((name, i) => { b[name] = newBody(name, i + 1, i === 0, cfg, i === 0 ? cfg.tabs : 1) })
  return {
    d: {
      gen: 1, hkey: 1, hname: cfg.bodies[0], lease: { held: true, gen: 1 }, policy: 0, chain: null, burned: [...cfg.preBurned],
      rows: [], heads: [[0, 0, GENESIS]], sess: cfg.bodies.map(nm => `s${nm}`).sort(), back: null,
    },
    b,
    net: { req: [], ans: [], log: [] },
    n: { key: 10, iid: 1, wish: 1, sid: 1, ...Object.fromEntries(BUDGET_KEYS.map(k => [k, 0])) },
    g: {
      eff: [], filled: [], placed: [], acked: [], flags: [], verAns: [], rotDigs: [], inst: 0, instKey: null,
      instStart: 0, keysCur: [], rotBy: [], forkLive: false, forkedKeys: [], rowInst: [], tainted: [], forked: 0,
      copy: null, named: [], div: false, effAfterDiv: [], held: [], sentSigs: [], destBack: false, wishIid: [],
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers.
const has = (cfg, f) => cfg.faults.includes(f)
const amended = (cfg, a) => cfg.amend.includes(a)
const reading = (cfg, r) => cfg.readings.includes(r)
/**
 * The platform serialiser and parser, each called exactly once in this file (the capsule rule scan counts them: the
 * protocol model serialises abstract states for the explorer's visited set and copies them; no capsule or act bytes pass
 * through this file). Every other call site goes through these three.
 *   keyText   an abstract state (or a request, an answer, an event) as its key text: the visited set hashes it
 *             (stateKey), and the explorer passes states between events as this text
 *   fromKey   a fresh, independent copy of the abstract state a key text holds
 *   deepCopy  a deep copy of a plain value: its key text read back
 */
export const keyText = x => JSON.stringify(x)
export const fromKey = text => JSON.parse(text)
export const deepCopy = x => fromKey(keyText(x))
const byJson = (x, y) => { const a = keyText(x); const b = keyText(y); return a < b ? -1 : a > b ? 1 : 0 }
function sortByJson(arr) {
  if (arr.length < 2) return
  const keyed = arr.map(x => [keyText(x), x])
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  for (let i = 0; i < arr.length; i++) arr[i] = keyed[i][1]
}
function normalise(s) {
  sortByJson(s.net.req)
  sortByJson(s.net.ans)
  sortByJson(s.net.log)
  s.d.rows.sort((x, y) => x.ns - y.ns || x.seq - y.seq)
  s.d.heads.sort((x, y) => x[0] - y[0])
  return s
}
function flag(s, invariant, message) {
  if (!s.g.flags.some(f => f[0] === invariant)) s.g.flags.push([invariant, message])
}
const ledgerNs = (cfg, d) => (has(cfg, 'EpochScopedKey') ? d.gen : 0)
function headOf(d, ns) {
  const h = d.heads.find(x => x[0] === ns)
  return h ? { seq: h[1], id: h[2] } : { seq: 0, id: GENESIS }
}
function setHead(d, ns, seq, id) { d.heads = d.heads.filter(x => x[0] !== ns).concat([[ns, seq, id]]) }
export const pendingRow = (d, cfg) => d.rows.find(r => r.ns === ledgerNs(cfg, d) && r.st === 'P') ?? null
const leaseLive = (lease, env) => lease.held && lease.gen === env.lg
/** The client's view of its own store: the in-memory copy ahead of the store exists only under SendBeforeStore. */
const view = B => B.vol ?? B.st

/** 7.2 chain selection: the stored row if its first key is the holder's installation key, else a new (virtual) chain. */
export function select(d, cfg) {
  const c = d.chain
  if (c !== null && c.owner === d.hkey && !(has(cfg, 'ChainPerGeneration') && c.start !== d.gen)) {
    const recs = (c.first ? [c.first] : []).concat(c.used)
    const newest = c.used.length > 0 ? c.used[0][0] : c.first ? c.first[0] : null
    return { row: true, cur: c.cur, owner: c.owner, recs, newest, start: c.start, locked: c.locked, burned: false, last: c.last }
  }
  // 7.2: "when it is full a further lock cannot be lifted, which fails closed": the locked chain cannot be replaced.
  if (c !== null && c.locked && !d.burned.includes(c.owner) && d.burned.length >= cfg.burnCap) {
    return { row: false, cur: d.hkey, owner: d.hkey, recs: [], newest: null, start: null, locked: true, burned: false, last: null, full: true }
  }
  return { row: false, cur: d.hkey, owner: d.hkey, recs: [], newest: null, start: null, locked: false, burned: d.burned.includes(d.hkey), last: null }
}

/** 6.5 `status`, as the selected chain reads (a burned holder key reads as locked). */
export function statusOf(d, cfg) {
  const sel = select(d, cfg)
  const h = headOf(d, ledgerNs(cfg, d))
  const p = pendingRow(d, cfg)
  return {
    gen: d.gen, hkey: d.hkey, lease: { ...d.lease }, cur: sel.cur, last: sel.last ? sel.last.dig : null,
    locked: sel.locked || sel.burned, head: [h.seq, h.id], pend: p ? { id: p.id, cmd: p.cmd, wish: p.wish } : null,
  }
}
/** 6.5 `row`: any retained row by action id or intent id. */
export function rowRead(d, { aid, iid }) {
  const r = d.rows.find(x => (aid !== undefined && x.id === aid) || (iid !== undefined && x.iid === iid))
  return r ? { st: r.st, seq: r.seq, id: r.id, by: r.by, res: r.res } : 'none'
}

// ---------------------------------------------------------------------------------------------------------------------
// The gate (section 8) as two calls, at creation and at commit, whose verdicts can differ. Policy v0 and a later policy
// v1 (the "policy change between intent and commit"): v0 allows exactly the safe payload, v1 escalates it. `flaky` is a
// payload whose second call fails (a throw is DENY): creation ALLOW, commit DENY; `rev` the reverse. Else DENY.
export function gate(policy, payload, phase) {
  if (payload === 'flaky') return phase === 'creation' ? 'ALLOW' : 'DENY'
  if (payload === 'rev') return phase === 'creation' ? 'DENY' : 'ALLOW'
  if (payload !== 'safe') return 'DENY'
  return policy === 0 ? 'ALLOW' : 'ESCALATE'
}

// ---------------------------------------------------------------------------------------------------------------------
// The destination: 6.7 in one transaction. `between` is the clock: the lease expires between the two lease checks.
function door(s, req, cfg, between) {
  const d = s.d
  const env = req.env
  const dig = envDigest(env)
  const T = env.by
  const verb = has(cfg, 'ProofOmitsVerb') ? req.rv : env.v
  const answer = (o) => {
    const sel = select(d, cfg)
    const r = d.rows.find(x => x.ns === ledgerNs(cfg, d) && x.id === env.aid)
    return { dig, ver: false, res: 'refused', code: null, row: r ? r.st : null, hg: d.gen, cur: sel.cur, last: sel.last ? sel.last.dig : null, lk: sel.locked || sel.burned, head: [headOf(d, ledgerNs(cfg, d)).seq, headOf(d, ledgerNs(cfg, d)).id], ...o }
  }
  const refuse = code => ({ ans: answer({ code }) })
  // 6.1 admission: a current owner session (the session is never in the envelope).
  if (req.via === null || !d.sess.includes(req.via)) return { ans: { dig, route: 'NO_SESSION' } }
  if (has(cfg, 'SessionInEnvelope') && env.ss !== req.via) return { ans: { dig, route: 'NO_SESSION' } }
  // 6.7 step 1: shape; the command hashes to the stated id (null for commit and abandon). Step 2: one lineage.
  const needsCmd = verb === 'intent' || verb === 'act'
  if (needsCmd ? (req.cmd === null || commandId(req.cmd) !== env.aid) : req.cmd !== null) return refuse('CAPSULE_ACTION_ID_MISMATCH')
  if (has(cfg, 'FenceBeforeReplay') && !leaseLive(d.lease, env)) return refuse('WRITER_LEASE_REQUIRED')
  // 6.7 step 3: the key step, 7.3's rows in order.
  const sel = select(d, cfg)
  const sigOk = req.sig === `${T}:${dig}`
  if (sel.burned || sel.locked) return refuse('BODY_KEY_FORKED')
  if (env.hg > d.gen || (sel.start !== null && env.hg < sel.start)) return refuse('CAPSULE_INSTANCE_REVOKED')
  const seenKey = k => k === sel.cur || k === sel.owner || sel.recs.some(r => r[0] === k)
  if (has(cfg, 'SuccessorCheckBeforeRetry') && sigOk && seenKey(env.nx)) return refuse('PROOF_INVALID')
  const rec = sel.recs.find(r => r[0] === T)
  let fromUsed = false
  if (rec !== undefined) {
    if (!sigOk) return refuse('PROOF_INVALID')
    const anyForNewest = has(cfg, 'StoredAnswerForAnyEnvelope') && T === sel.newest
    if (rec[1] === dig || anyForNewest) {
      if (T === sel.newest) return { ans: { ...sel.last }, stored: true }
      return refuse('PROOF_REPLAYED')
    }
    if (has(cfg, 'SecondEnvelopeAccepted')) fromUsed = true
    else if (env.nx === rec[2] && !has(cfg, 'SecondEnvelopeIsFork')) return refuse('PROOF_SUPERSEDED')
    else {
      if (!has(cfg, 'NoLockOnFork')) d.chain.locked = true
      s.g.forked++
      return refuse('BODY_KEY_FORKED')
    }
  } else if (T === sel.cur) {
    if (env.hg !== d.gen) {
      if (has(cfg, 'StaleGenerationRotates') && sigOk) {
        const a = answer({ code: 'CAPSULE_GENERATION_STALE' })
        rotate(s, sel, env, dig, a, cfg)
        return { ans: a }
      }
      return refuse('CAPSULE_GENERATION_STALE')
    }
    const badNext = !has(cfg, 'NextKeyMayRepeat') && seenKey(env.nx)
    if (!sigOk || badNext) {
      if (has(cfg, 'RotateOnUnverified')) {
        const a = answer({ code: 'PROOF_INVALID' })
        rotate(s, sel, env, dig, a, cfg)
        return { ans: a }
      }
      return refuse('PROOF_INVALID')
    }
  } else {
    return refuse('CAPSULE_INSTANCE_REVOKED')
  }
  // Verified (or, under SecondEnvelopeAccepted, accepted from a used key). Steps 4 to 8.
  const skipFence = has(cfg, 'NoFenceAtCommit') && verb === 'commit'
  let out
  if (!skipFence && !leaseLive(d.lease, env)) {
    out = { res: 'refused', code: 'WRITER_LEASE_REQUIRED' }
  } else {
    const L = ledger(s, verb, env, req, cfg, sel)
    out = L.out
    // Step 7: whenever a ledger effect is staged, whatever the answer is going to be (draft 6).
    if (L.staged) {
      if (between) d.lease = { ...d.lease, held: false }
      const second = !has(cfg, 'SingleLeaseCheck') && !skipFence && !(has(cfg, 'SecondCheckOnlyOnSuccess') && out.res === 'refused')
      if (second && !leaseLive(d.lease, env)) {
        out = { res: 'refused', code: 'WRITER_LEASE_REQUIRED' }
        if (has(cfg, 'LeaseCheckAfterWrite')) L.apply()
      } else L.apply()
    }
  }
  const a = answer({ ver: true, ...out })
  rotate(s, sel, env, dig, a, cfg)
  return { ans: a, verified: true, fromUsed }
}

/** Step 8's chain change: the verified key is recorded, `nextKey` becomes current, the answer is stored. */
function rotate(s, sel, env, dig, ans, cfg) {
  const d = s.d
  const rec = [env.by, dig, env.nx]
  if (!sel.row) {
    if (d.chain !== null && d.chain.locked && !d.burned.includes(d.chain.owner) && d.burned.length < cfg.burnCap) d.burned.push(d.chain.owner)
    const forget = has(cfg, 'FirstKeyForgotten')
    d.chain = { owner: d.hkey, first: forget ? null : rec, used: forget ? [rec] : [], cur: env.nx, start: env.hg, last: null, locked: false }
  } else {
    d.chain.used = [rec, ...d.chain.used].slice(0, cfg.kept)
    d.chain.cur = env.nx
  }
  const after = select(d, cfg)
  ans.cur = after.cur
  ans.last = dig
  ans.lk = after.locked || after.burned
  d.chain.last = { ...ans }
}

/** Steps 5 and 6 on a draft of the ledger; `staged` says whether a ledger effect is staged; `apply` writes it (step 8). */
function ledger(s, verb, env, req, cfg, sel) {
  const d = s.d
  const ns = ledgerNs(cfg, d)
  const draft = { rows: d.rows.map(r => ({ ...r })), heads: d.heads.map(h => [...h]) }
  const head = headOf(draft, ns)
  let staged = false
  const apply = () => { d.rows = draft.rows; d.heads = draft.heads }
  const done = out => ({ out, staged, apply })
  const refused = code => ({ out: { res: 'refused', code }, staged: false, apply: () => {} })
  const by = [env.by, env.hg, sel.owner]
  // The chain a row's placer belonged to was locked: its first key is burned (or is burned by this very request).
  const lockedOwners = has(cfg, 'BurnedAtWriteOnly') || sel.row || d.chain === null || !d.chain.locked ? d.burned : [...d.burned, d.chain.owner]
  const commitTransition = (row, viaAct) => {
    if (!(viaAct && has(cfg, 'ActSkipsInheritedLock')) && lockedOwners.includes(row.by[2])) return { refused: 'CAPSULE_INHERITED_LOCKED' }
    const verdict = has(cfg, 'GateOnlyAtIntent') ? 'ALLOW' : gate(d.policy, row.cmd.pay, 'commit')
    if (verdict === 'DENY') return { refused: 'CAPSULE_GATE_DENIED' }
    if (verdict === 'ESCALATE') return { pending: true }
    row.st = 'C'
    row.res = [env.by, env.hg]
    setHead(draft, ns, row.seq, row.id)
    staged = true
    return { committed: true }
  }
  if (has(cfg, 'CapBlocksResolution') && draft.rows.length >= cfg.cap) return refused('CAPSULE_LEDGER_FULL')
  let row = draft.rows.find(r => r.ns === ns && r.id === env.aid)
  if (verb === 'commit' || verb === 'abandon') {
    if (row === undefined) return refused('CAPSULE_ACTION_UNKNOWN')
    if (row.st === 'C') return verb === 'commit' ? done({ res: 'committed' }) : refused('CAPSULE_ACTION_COMMITTED')
    if (row.st === 'A') return verb === 'abandon' ? done({ res: 'abandoned' }) : refused('CAPSULE_ACTION_ABANDONED')
    if (verb === 'abandon') {
      if (has(cfg, 'AbandonGated') && gate(d.policy, row.cmd.pay, 'commit') !== 'ALLOW') return refused('CAPSULE_GATE_DENIED')
      row.st = 'A'
      row.res = [env.by, env.hg]
      setHead(draft, ns, row.seq, row.id)
      staged = true
      return done({ res: 'abandoned' })
    }
    const t = commitTransition(row, false)
    if (t.refused) return refused(t.refused)
    return done({ res: t.committed ? 'committed' : 'pending' })
  }
  // intent, act
  if (row !== undefined) {
    if (row.st === 'C') return done({ res: 'committed' })
    if (row.st === 'A') return done({ res: 'abandoned' })
    if (verb === 'intent') return done({ res: has(cfg, 'PendingAnsweredAsDone') ? 'committed' : 'pending' })
    const t = commitTransition(row, true)
    if (t.refused) return refused(t.refused)
    return done({ res: t.committed ? 'committed' : 'pending' })
  }
  const cmd = req.cmd
  // creation (a) the intent index
  const placed = draft.rows.find(r => r.ns === ns && r.iid === cmd.iid && r.id !== env.aid)
  if (placed !== undefined && !has(cfg, 'DedupeByIdOnly')) return refused('CAPSULE_INTENT_ALREADY_PLACED')
  // (b) the position
  const pend = draft.rows.find(r => r.ns === ns && r.st === 'P')
  if (cmd.seq <= head.seq || (pend !== undefined && pend.id !== env.aid)) return refused('CAPSULE_ACTION_CONFLICT')
  if (cmd.seq > head.seq + 1 || cmd.prev !== head.id) return refused('CAPSULE_POSITION_STALE')
  // (c) the cap; (d) the creation gate
  if (draft.rows.length >= cfg.cap) return refused('CAPSULE_LEDGER_FULL')
  const v0 = gate(d.policy, cmd.pay, 'creation')
  if (v0 === 'DENY') {
    // 6.8, creation DENY: CAPSULE_GATE_DENIED, no row. The fault keeps a pending row as if the commit had been denied.
    if (has(cfg, 'ActCreationDenyKeepsRow') && verb === 'act') {
      draft.rows.push({ ns, seq: cmd.seq, id: env.aid, iid: cmd.iid, st: 'P', cmd: { ...cmd }, by, res: null, wish: req.w })
      staged = true
      return done({ res: 'refused', code: 'CAPSULE_GATE_DENIED' })
    }
    return refused('CAPSULE_GATE_DENIED')
  }
  row = { ns, seq: cmd.seq, id: env.aid, iid: cmd.iid, st: 'P', cmd: { ...cmd }, by, res: null, wish: req.w }
  draft.rows.push(row)
  staged = true
  if (verb === 'intent') return done({ res: has(cfg, 'PendingAnsweredAsDone') ? 'committed' : 'pending' })
  // (e) act with ALLOW at creation: step 6 on the new row, in the same transaction
  if (v0 !== 'ALLOW') return done({ res: 'pending' })
  const t = commitTransition(row, true)
  if (t.refused) {
    // 6.8, `act` with no row, commit DENY: CAPSULE_GATE_DENIED, and the row just created stays pending.
    if (has(cfg, 'ActDenyDropsRow')) return refused(t.refused)
    if (has(cfg, 'ActDenyAnswersPending')) return done({ res: 'pending' })
    return done({ res: 'refused', code: t.refused })
  }
  return done({ res: t.committed ? 'committed' : 'pending' })
}

// ---------------------------------------------------------------------------------------------------------------------
// The ghost (read by the invariants only). Independent of the door's own bookkeeping where it can be.
/** Would the contract verify this envelope now? (7.2 selection, 7.3 "T is the current key, otherwise".) */
/** Admitted, well formed and signed by the key it names: what reaches the key step (6.1, 6.7 steps 1 and 2). */
function ghostReachesKeyStep(s, req) {
  const env = req.env
  if (req.via === null || !s.d.sess.includes(req.via)) return false
  const verb = env.v ?? req.rv
  if ((verb === 'intent' || verb === 'act') ? (req.cmd === null || commandId(req.cmd) !== env.aid) : req.cmd !== null) return false
  return req.sig === `${env.by}:${envDigest(env)}`
}

function ghostVerifiable(s, req, cfg) {
  const d = s.d
  const env = req.env
  if (!ghostReachesKeyStep(s, req)) return false
  if (env.hg !== d.gen) return false
  const g = s.g
  const sameInst = g.instKey === d.hkey
  if (sameInst && g.forkLive) return false
  if (!sameInst && g.forkedKeys.includes(d.hkey)) return false
  const cur = sameInst ? g.keysCur[g.keysCur.length - 1] : d.hkey
  if (env.by !== cur) return false
  const seen = sameInst ? g.keysCur : [d.hkey]
  return !seen.includes(env.nx)
}

function ghostBefore(s, req, cfg) {
  const d = s.d
  const g = s.g
  const env = req.env
  const dig = envDigest(env)
  // A fork reaches the destination: a signed envelope under a key of this ghost chain instance that the chain still
  // retains (its first key, or one of the `kept` newest others), within the instance's generations, naming another
  // successor than the one that key was verified with.
  if (g.instKey === d.hkey && ghostReachesKeyStep(s, req) && env.hg <= d.gen && env.hg >= g.instStart) {
    const rots = g.rotBy
    const idx = rots.findIndex(r => r[0] === env.by)
    const retained = idx === 0 || (idx > 0 && idx >= rots.length - cfg.kept)
    if (idx >= 0 && retained && rots[idx][1] !== env.nx && !g.forkLive) {
      g.forkLive = true
      if (!g.forkedKeys.includes(g.instKey)) g.forkedKeys.push(g.instKey)
      for (const [id, inst] of g.rowInst) if (inst === g.inst && !g.tainted.includes(id)) g.tainted.push(id)
    }
  }
  if (cfg.trackDiv && ghostReachesKeyStep(s, req)) {
    if (!g.named.some(x => x[0] === env.by && x[1] === env.nx && x[2] === req.who)) g.named.push([env.by, env.nx, req.who])
    if (!g.div && g.named.some(x => g.named.some(y => x[0] === y[0] && x[1] !== y[1] && x[2] !== y[2]))) g.div = true
  }
}

/** After the door: effects, rotations, and every invariant that is checked at a transition. */
function ghostAfter(s, req, cfg, before, res) {
  const d = s.d
  const g = s.g
  const env = req.env
  const dig = envDigest(env)
  const ans = res.ans
  // Ledger effects: rows created or changed (a terminal row that disappears is the ForgetRows fault, seen elsewhere).
  const effects = []
  for (const r of d.rows) {
    const old = before.rows.find(x => x.ns === r.ns && x.id === r.id)
    if (old === undefined) effects.push(['create', r])
    else if (old.st !== r.st) effects.push(['resolve', r, old.st])
  }
  const rotated = d.chain !== null && d.chain.last !== null && d.chain.last.dig === dig && before.lastDig !== dig
  // S9: no ledger effect and no rotation by an envelope that was not verified under the chain's current key.
  if ((effects.length > 0 || rotated) && !before.verifiable) {
    flag(s, 'effectOrRotationOnlyVerified', `${env.v}(${env.aid ?? '-'}) signed by k${env.by} at generation ${env.hg} ${rotated ? 'rotated the chain' : 'wrote the ledger'} without being verifiable`)
  }
  // A rotation happens on a newly verified current-key envelope, exactly once for each.
  if (before.verifiable && !rotated && ans.route === undefined) flag(s, 'rotationOncePerVerified', `a verifiable ${env.v} by k${env.by} did not rotate the chain (answer ${ans.code ?? ans.res})`)
  if (rotated && g.rotDigs.includes(dig)) flag(s, 'rotationOncePerVerified', `envelope ${dig} rotated the chain twice`)
  // (d) A refusal has no ledger effect (the one exception, 6.8: an act whose creation gate says ALLOW and whose commit
  // gate says DENY keeps the row it just created, pending; the two verdicts are read from the ghost gate, so a creation
  // DENY that keeps a row is caught: ActCreationDenyKeepsRow); a rotation stores the answer it gave.
  const verbNow = has(cfg, 'ProofOmitsVerb') ? req.rv : env.v
  const createAllowCommitDeny = req.cmd !== null && gate(d.policy, req.cmd.pay, 'creation') === 'ALLOW' && gate(d.policy, req.cmd.pay, 'commit') === 'DENY'
  const denyKeepsRow = ans.code === 'CAPSULE_GATE_DENIED' && verbNow === 'act' && createAllowCommitDeny && effects.length === 1 &&
    effects[0][0] === 'create' && effects[0][1].id === env.aid && effects[0][1].st === 'P'
  if (ans.route === undefined && ans.res === 'refused' && effects.length > 0 && !denyKeepsRow) flag(s, 'refusalHasNoEffect', `answer ${ans.code} came with a ledger effect`)
  // 6.8, the `act` row with no row for its id: both gates ALLOW -> committed; creation ALLOW and commit DENY ->
  // CAPSULE_GATE_DENIED with the new row pending. Read from the ghost gate, not from the door's own bookkeeping.
  if (ans.route === undefined && ans.ver === true && verbNow === 'act' && req.cmd !== null && !before.rows.some(r => r.ns === ledgerNs(cfg, d) && r.id === env.aid)) {
    const twoCalls = gate(d.policy, req.cmd.pay, 'creation') === 'ALLOW' && gate(d.policy, req.cmd.pay, 'commit') === 'DENY'
    const created = effects.some(([k, r]) => k === 'create' && r.id === env.aid)
    if (twoCalls && created && ans.code !== 'CAPSULE_GATE_DENIED') flag(s, 'actCommitDenyAsTable', `act(${env.aid}): creation ALLOW, commit DENY, answered ${ans.code ?? ans.res} (6.8: CAPSULE_GATE_DENIED)`)
    if (twoCalls && ans.code === 'CAPSULE_GATE_DENIED' && !created) flag(s, 'actCommitDenyAsTable', `act(${env.aid}): creation ALLOW, commit DENY, answered CAPSULE_GATE_DENIED but no pending row was kept (6.8)`)
  }
  if (rotated && (d.chain.last.res !== ans.res || d.chain.last.code !== ans.code)) flag(s, 'refusalHasNoEffect', 'the stored answer is not the answer given')
  // A stored answer is returned only for the envelope it answers.
  if (ans.route === undefined && ans.dig !== dig) flag(s, 'storedAnswerMatches', `envelope ${dig} was answered with the answer of ${ans.dig}`)
  if (rotated) {
    g.rotDigs.push(dig)
    g.verAns.push([dig, ans.res, ans.code])
    // ghost chain instance: a new one starts when the holder key is not this instance's key
    if (g.instKey !== d.hkey) {
      g.inst++
      g.instKey = d.hkey
      g.instStart = env.hg
      g.keysCur = [env.by]
      g.rotBy = []
      g.forkLive = false
    }
    // A key is used once: no key names two accepted successors, and no key becomes current twice.
    if (g.rotBy.some(r => r[0] === env.by)) flag(s, 'oneSuccessorPerKey', `k${env.by} was accepted naming a second successor k${env.nx}`)
    if (g.keysCur.includes(env.nx)) flag(s, 'keyUsedOnce', `k${env.nx} became current a second time in one chain`)
    g.rotBy.push([env.by, env.nx, env.hg])
    g.keysCur.push(env.nx)
  }
  const instNow = g.instKey === d.hkey ? g.inst : -1
  for (const [kind, r, oldSt] of effects) {
    // S16: a ledger effect needs a live lease at both checks.
    if (!leaseLive(before.lease, env) || !leaseLive(d.lease, env)) flag(s, 'leaseLiveAtBothChecks', `${kind} of ${r.id} with the lease ${leaseLive(before.lease, env) ? 'expired before the second check' : 'not live at the first check'}`)
    // S15: once a fork has reached the destination, no ledger effect until a move to an unburned key.
    if (g.forkLive && g.instKey === d.hkey) flag(s, 'forkStopsEffects', `${kind} of ${r.id} after a fork reached the destination`)
    if (cfg.trackDiv && g.div && !g.effAfterDiv.includes(req.who)) g.effAfterDiv.push(req.who)
    if (kind === 'create') {
      g.rowInst.push([r.id, instNow])
      if (g.placed.some(p => p[0] === r.iid && p[1] !== r.seq)) flag(s, 'onePositionPerIntent', `intent i${r.iid} placed at a second position ${r.seq}`)
      if (!g.placed.some(p => p[0] === r.iid && p[1] === r.seq)) g.placed.push([r.iid, r.seq])
    }
    if (r.st !== 'P') {
      if (oldSt !== undefined && oldSt !== 'P') flag(s, 'terminalRowNeverChanges', `row ${r.id} changed from ${oldSt} to ${r.st}`)
      if (g.filled.some(f => f[1] === r.seq)) flag(s, 'positionFilledOnce', `position ${r.seq} filled a second time (by ${r.id})`)
      g.filled.push([r.ns, r.seq, r.id, r.st])
    }
    if (r.st === 'C') {
      g.eff.push([r.id, r.wish])
      if (g.tainted.includes(r.id)) flag(s, 'inheritedLockedNeverCommits', `row ${r.id}, placed under a chain that was later locked, committed`)
      if (gate(d.policy, r.cmd.pay, 'commit') !== 'ALLOW') flag(s, 'gatePassedAtCommit', `row ${r.id} committed though policy v${d.policy} says ${gate(d.policy, r.cmd.pay, 'commit')} at commit`)
    }
  }
  if (ans.route === undefined && ans.res === 'committed' && !g.acked.includes(env.aid)) { g.acked.push(env.aid); g.acked.sort() }
  if (ans.route === undefined && ans.code === 'BODY_KEY_FORKED') g.forked = Math.max(g.forked, 1)
  // S26: an envelope made for one verb is never accepted for another.
  if (rotated && ans.ver && req.sv !== (has(cfg, 'ProofOmitsVerb') ? req.rv : env.v)) flag(s, 'proofVerbBound', `an envelope signed for ${req.sv} was accepted as ${req.rv}`)
  // (i) PROOF_SUPERSEDED for the live journal entry of an honest body.
  if (cfg.honest && ans.code === 'PROOF_SUPERSEDED') {
    for (const [nm, B] of Object.entries(s.b)) {
      const j = view(B).j
      if (j !== null && j.dig === dig) flag(s, 'honestNeverSupersededLive', `${nm}'s live journal entry ${dig} was answered PROOF_SUPERSEDED`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The client (7.4), read literally from draft 6. Its store: the current key, at most one next key, at most one OPEN
// INTENT `oi` (the command bytes with their intent id; `re` marks "issue it again at the head"), at most one journal
// entry `j` for it (the signed request), what it last saw. Writes go to the store in one transaction; under
// SendBeforeStore they go to memory first. Her notes `cmds` (one per wish) are outside the contract.
function writeStore(B, st, cfg, splitPersist) {
  if (cfg.budget.bodyBacks > 0) B.back = deepCopy(B.st)
  if (splitPersist) B.vol = st
  else { B.st = st; B.vol = null }
}

const noteOf = (B, wish) => B.cmds.find(c => c.wish === wish)
const oiOfRow = (r, wish) => ({ id: r.id, iid: r.iid, seq: r.seq, prev: r.cmd.prev, pay: r.cmd.pay, wish, re: false })
const atHead = (oi, stt, iid) => {
  const cmd = { seq: stt.head[0] + 1, prev: stt.head[1], iid, pay: oi.pay }
  return { ...cmd, id: commandId(cmd), wish: oi.wish, re: false }
}

/** GHOST (l): one intent id per wish, whoever holds the wish. */
function ghostIntent(s, wish, iid) {
  const seen = s.g.wishIid.find(x => x[0] === wish)
  if (seen === undefined) s.g.wishIid.push([wish, iid])
  else if (seen[1] !== iid) flag(s, 'oneIntentPerWish', `wish w${wish} was given a second intent id i${iid} (it had i${seen[1]})`)
}

/** GHOST (l): after a client event, an open intent that is gone (or replaced by another intent id) left a recorded
 * outcome in her notes that the destination confirms: a terminal row for its intent id, or no row at all for a refusal
 * at creation. Computed from the states alone, whatever code path the client took. */
function ghostOpenIntent(s0, s, cfg) {
  if (s.g.destBack) return
  for (const [name, B] of Object.entries(s.b)) {
    const Bs0 = s0.b[name]
    if (Bs0 === undefined) continue
    const o0 = view(Bs0).oi
    const o1 = view(B).oi
    if (o0 === null || (o1 !== null && o1.iid === o0.iid)) continue
    const note = noteOf(B, o0.wish)
    const out = note ? note.out : null
    const terminal = (out === 'committed' || out === 'abandoned') && s.d.rows.some(r => r.iid === o0.iid && r.st === out[0].toUpperCase())
    const norow = ['denied', 'full', 'unknown-id'].includes(out) && !s.d.rows.some(r => r.id === o0.id)
    if (!terminal && !norow) flag(s, 'openIntentRetiredWithOutcome', `${name}'s open intent i${o0.iid} (wish w${o0.wish}) was ${o1 === null ? 'dropped' : `replaced by i${o1.iid}`} with no recorded outcome (her notes: ${out})`)
  }
}

/** Promotion (7.4 step 5, or step 1 through `status`): the next key becomes current, the journal is cleared. */
function promote(s, name, st, evidence) {
  const j = st.j
  const ok = s.g.verAns.some(v => v[0] === j.dig)
  if (!ok || (evidence.via === 'answer' && evidence.dig !== j.dig)) {
    flag(s, 'clientPromotesOnlyOwnVerified', `${name} promoted k${st.next} on ${evidence.via === 'answer' ? `an answer for ${evidence.dig}` : 'status'} though its journal entry ${j.dig} ${ok ? 'was not what it answered' : 'was never verified'}`)
  }
  st.cur = st.next
  st.next = null
  st.j = null
  return j
}

/** 7.4 step 5: one rule per verified outcome. `keep` = the open intent stays and nothing else happens. */
function outcomeKind(res, code, row) {
  if (res === 'committed' || res === 'abandoned' || res === 'pending') return res
  switch (code) {
    case 'CAPSULE_POSITION_STALE': case 'CAPSULE_ACTION_CONFLICT': return 'stale'
    case 'CAPSULE_INTENT_ALREADY_PLACED': return 'placed'
    case 'CAPSULE_ACTION_COMMITTED': return 'committed'
    case 'CAPSULE_ACTION_ABANDONED': return 'abandoned'
    case 'CAPSULE_GATE_DENIED': return row === 'P' ? 'pending' : 'denied'
    case 'CAPSULE_LEDGER_FULL': return 'full'
    case 'CAPSULE_ACTION_UNKNOWN': return 'unknown-id'
    default: return 'keep' // WRITER_LEASE_REQUIRED (go to step 1), CAPSULE_INHERITED_LOCKED (abandon it)
  }
}

/** A row read for the open intent (by intent id): its outcome is the intent's. Returns what it found. */
function fromRow(s, name, st, r) {
  const oi = st.oi
  const note = noteOf(s.b[name], oi.wish)
  if (r === undefined) { st.oi = { ...oi, re: true }; return 'none' }
  if (r.st === 'P') { st.oi = oiOfRow(r, oi.wish); if (note) note.out = 'pending'; return 'pending' }
  const out = r.st === 'C' ? 'committed' : 'abandoned'
  if (note) note.out = out
  st.oi = null
  return out
}

/** Apply a verified outcome to the open intent, when the answered entry was for it. */
function settle(s, name, st, j, kind, cfg) {
  const oi = st.oi
  if (oi === null || j.env.aid !== oi.id) return
  const note = noteOf(s.b[name], oi.wish)
  const mark = out => { if (note) note.out = out }
  switch (kind) {
    case 'committed': case 'abandoned': mark(kind); st.oi = null; return // the open intent is retired
    case 'pending': mark('pending'); return // the next request for it is commit or abandon
    case 'stale': mark('stale'); st.oi = { ...oi, re: true }; return // the same intent, its intent id, at the new position
    case 'placed': fromRow(s, name, st, s.d.rows.find(r => r.ns === ledgerNs(cfg, s.d) && r.iid === oi.iid)); return
    case 'denied': case 'full': case 'unknown-id':
      // AMBIGUITY (draft 6, 7.4 step 5): "Nothing else retires it" against "stays until its row is terminal or it never
      // got one". Modelled: an intent refused at creation never got a row and is retired with that outcome.
      mark(kind)
      if (!reading(cfg, 'RetireOnlyOnTerminal')) st.oi = null
      return
    default: // 'keep', 'none'
  }
}

function seenMax(st, stt) {
  if (stt.gen > st.seen[0]) st.seen = [stt.gen, st.seen[1], st.seen[2]]
  if (stt.head[0] > st.seen[1]) st.seen = [st.seen[0], stt.head[0], stt.head[1]]
}
export const behind = (st, stt) => stt.gen < st.seen[0] || stt.head[0] < st.seen[1] || (stt.head[0] === st.seen[1] && stt.head[1] !== st.seen[2])

function buildEnvelope(s, B, st, stt, choice, nx, cfg) {
  const env = { v: has(cfg, 'ProofOmitsVerb') ? null : choice.verb, hg: stt.gen, lg: stt.lease.gen, aid: choice.aid, by: st.cur, nx }
  if (has(cfg, 'SessionInEnvelope')) env.ss = B.sess
  return { env, cmd: choice.cmd, verb: choice.verb, sig: signature(st.cur, env), dig: envDigest(env), w: choice.wish }
}

function sendJ(s, name, tab, j) {
  const B = s.b[name]
  const req = { env: j.env, cmd: j.cmd, sig: j.sig, via: B.sess, from: [name, tab], who: name, rv: j.verb, sv: j.verb, w: j.w }
  s.net.req.push(req)
  if (s.n.splitOn && !s.g.sentSigs.some(x => x[0] === name && x[1] === j.sig)) s.g.sentSigs.push([name, j.sig])
  if (s.n.dupsOn && !s.net.log.some(r => byJson(r, { ...req, from: null }) === 0)) s.net.log.push({ ...req, from: null })
}

const bytesOf = oi => ({ seq: oi.seq, prev: oi.prev, iid: oi.iid, pay: oi.pay })

/**
 * One 7.4 cycle, under the Web Lock: steps 0 and 1 on a fresh read (the lease is taken there when none is held), then
 * step 2 or steps 3 and 4. Returns the next states (one per choice of what to do). `snap` replaces the fresh read for a
 * tab without the lock.
 */
function cycle(json, name, tab, cfg, fair, snap) {
  const out = []
  const s = fromKey(json)
  const B = s.b[name]
  const d = s.d
  if (!d.sess.includes(B.sess)) return out // step 0: CAPSULE_AUTHORITY_REQUIRED
  let stt = snap ? snap.stt : statusOf(d, cfg)
  if (B.hold !== null) {
    if (stt.gen > B.hold) B.hold = null
    else return out
  }
  const st = deepCopy(snap ? snap.st : view(B))
  // The cycle that sent this tab's journal entry is still waiting for its answer (it holds the lock): no new cycle.
  if (st.j !== null && s.net.req.some(r => r.from !== null && r.from[0] === name && r.from[1] === tab && r.sig === st.j.sig)) return out
  if (behind(st, stt)) return out // DESTINATION_BEHIND: hold
  if (stt.hkey !== B.ik || stt.locked) return out
  const notes = []
  seenMax(st, stt)
  if (stt.cur === st.cur) {
    // in step
  } else if (st.next !== null && stt.cur === st.next && st.j !== null && stt.last === st.j.dig) {
    const j = promote(s, name, st, { via: 'status' })
    const r = rowRead(d, { aid: j.env.aid })
    settle(s, name, st, j, r === 'none' ? 'none' : r.st === 'P' ? 'pending' : r.st === 'C' ? 'committed' : 'abandoned', cfg)
    notes.push(`promotes through status (row read: ${r === 'none' ? 'none' : r.st})`)
  } else if (has(cfg, 'SilentOriginal')) {
    B.hold = stt.gen
    s.g.held.push([name, 'out of step'])
    writeStore(B, st, cfg, false)
    out.push({ ev: { actor: name, tab, kind: 'cycle', step: 'out of step: holds silently' }, s })
    return out
  } else {
    st.cur = B.ik
    st.next = null
    st.j = null
    notes.push(`out of step: back to its installation key k${B.ik}`)
    if (st.oi !== null && has(cfg, 'IntentForgottenOnReset')) {
      // the fault: the open intent goes with the signed request; the wish is still wanted and gets a new command
      const oi = st.oi
      st.oi = null
      const note = noteOf(B, oi.wish)
      if (note !== undefined) Object.assign(note, { iid: s.n.iid++, out: 'new' })
      notes.push(`drops its open intent i${oi.iid} with the signed request`)
    } else if (st.oi !== null) {
      const found = fromRow(s, name, st, d.rows.find(r => r.ns === ledgerNs(cfg, d) && r.iid === st.oi.iid))
      notes.push(`keeps its open intent and reads it by intent id: ${found}`)
    }
  }
  // Step 1, last: no lease is held: take it now, with the existing lease verb, before anything is sent.
  const adoptable = c => c.out === 'new' || c.out === 'stale'
  const wants = st.j !== null || st.oi !== null || stt.pend !== null || (!fair && B.cmds.some(adoptable))
  if (!stt.lease.held && wants && (st.j !== null || !has(cfg, 'LeaseOnlyWithJournal'))) {
    d.lease = { held: true, gen: d.lease.gen + 1 }
    stt = { ...stt, lease: { ...d.lease } }
    notes.push(`takes the lease (generation ${d.lease.gen})`)
  }
  const splitPersist = has(cfg, 'SendBeforeStore')
  const finish = (st2, kind, extra, sendIt) => {
    const s2 = deepCopy(s)
    const B2 = s2.b[name]
    writeStore(B2, st2, cfg, splitPersist)
    if (snap) B2.snaps[tab] = null
    if (sendIt) sendJ(s2, name, tab, st2.j)
    out.push({ ev: { actor: name, tab, kind, ...(notes.length ? { notes: notes.join('; ') } : {}), ...extra }, s: s2 })
  }
  if (st.j !== null) {
    // step 2
    const j = st.j
    const sessionChanged = has(cfg, 'SessionInEnvelope') && j.env.ss !== B.sess
    if (j.env.hg !== stt.gen || sessionChanged) {
      const nj = buildEnvelope(s, B, st, stt, { verb: j.verb, aid: j.env.aid, cmd: j.cmd, wish: j.w }, st.next, cfg)
      st.j = nj
      finish(st, 'cycle', { step: 're-issue', verb: nj.verb, aid: nj.env.aid, by: nj.env.by, nx: nj.env.nx, hg: nj.env.hg, req: nj.dig }, !cfg.splitSend || splitPersist)
      return out
    }
    finish(st, 'cycle', { step: 're-send', verb: j.verb, aid: j.env.aid, by: j.env.by, nx: j.env.nx, hg: j.env.hg, req: j.dig }, true)
    return out
  }
  // steps 3 and 4: what the open intent needs next. `oi` is the open intent after the choice; `sync` says whether her
  // note follows it.
  const choices = []
  const p = stt.pend
  const oi = st.oi
  const verbsFor = () => (fair ? ['act'] : ['intent', 'act'])
  const retryIid = old => (has(cfg, 'NewIntentOnRetry') ? s.n.iid++ : old)
  if (p !== null && (oi === null || oi.id === p.id || oi.iid === p.cmd.iid)) {
    // the pending row is the open intent's, or (with no open intent) the body takes it as its open intent
    const noi = oiOfRow({ id: p.id, iid: p.cmd.iid, seq: p.cmd.seq, cmd: p.cmd }, p.wish)
    for (const verb of ['commit', 'abandon', ...(cfg.actOnPending && !fair ? ['act'] : [])]) {
      choices.push({ verb, aid: p.id, cmd: verb === 'act' ? p.cmd : null, wish: p.wish, oi: noi, sync: true })
    }
  } else if (p !== null) {
    // a pending row that is not the open intent's
    if (amended(cfg, 'ResolveOtherPendingFirst')) {
      for (const verb of ['commit', 'abandon']) choices.push({ verb, aid: p.id, cmd: null, wish: p.wish, oi, sync: false })
    } else if (!oi.re) {
      for (const verb of verbsFor()) choices.push({ verb, aid: oi.id, cmd: bytesOf(oi), wish: oi.wish, oi, sync: true })
    }
    // else: the same intent at the new position, which a pending row still holds ("do not retry that position")
  } else if (oi !== null) {
    const noi = oi.re ? atHead(oi, stt, retryIid(oi.iid)) : oi
    for (const verb of verbsFor()) choices.push({ verb, aid: noi.id, cmd: bytesOf(noi), wish: noi.wish, oi: noi, sync: true })
  } else if (!fair) {
    // no open intent: her next wish becomes one (built at the head she reads; a note she must re-place keeps its id)
    for (const c of B.cmds) {
      if (!adoptable(c)) continue
      const noi = atHead(c, stt, c.out === 'stale' ? retryIid(c.iid) : c.iid)
      for (const verb of verbsFor()) choices.push({ verb, aid: noi.id, cmd: bytesOf(noi), wish: noi.wish, oi: noi, sync: true })
    }
  }
  if (choices.length === 0) {
    if (notes.length) finish(st, 'cycle', { step: 'sync' }, false)
    return out
  }
  const nx = s.n.key++
  for (const ch of choices) {
    const st2 = deepCopy(st)
    const j = buildEnvelope(s, B, st2, stt, ch, nx, cfg)
    st2.next = nx
    st2.j = j
    st2.oi = ch.oi
    const s2 = deepCopy(s)
    const B2 = s2.b[name]
    if (ch.sync) {
      const note = noteOf(B2, ch.oi.wish)
      const bytes = { ...bytesOf(ch.oi), id: ch.oi.id }
      if (note === undefined) B2.cmds.push({ ...bytes, wish: ch.oi.wish, out: 'sent', adopted: true })
      else Object.assign(note, bytes, { out: note.out === 'pending' ? 'pending' : 'sent' })
      ghostIntent(s2, ch.oi.wish, ch.oi.iid)
    }
    writeStore(B2, st2, cfg, splitPersist)
    if (snap) B2.snaps[tab] = null
    const sendNow = !cfg.splitSend || splitPersist
    if (sendNow) sendJ(s2, name, tab, j)
    out.push({ ev: { actor: name, tab, kind: 'cycle', step: sendNow ? 'prepare-and-send' : 'prepare', ...(notes.length ? { notes: notes.join('; ') } : {}), verb: ch.verb, aid: ch.aid, by: j.env.by, nx, hg: j.env.hg, req: j.dig }, s: s2 })
  }
  return out
}

/** 7.4 steps 5 and 6: an answer reaches the tab that sent the request. */
function receive(s, name, a, cfg) {
  const B = s.b[name]
  const st = deepCopy(view(B))
  const j = st.j
  const splitPersist = has(cfg, 'SendBeforeStore')
  if (B.hold !== null) return 'ignores it (holding: its keys and journal stay untouched, 6.10)'
  if (has(cfg, 'ThumbOnlyPromotion') && j !== null && st.next !== null && a.route === undefined && a.cur === st.next) {
    promote(s, name, st, { via: 'answer', dig: a.dig })
    settle(s, name, st, j, outcomeKind(a.res, a.code, a.row), cfg)
    writeStore(B, st, cfg, splitPersist)
    return `promotes k${st.cur} on the thumb alone`
  }
  if (j === null || a.dig !== j.dig) return 'ignores it (not its journal entry)'
  if (a.route !== undefined) return 'keeps the entry (route answer; the same bytes later)'
  if (a.ver) {
    // step 5: the digest binds the generations; nothing else is compared (draft 6)
    if (a.hg !== j.env.hg) {
      PROBES.verifiedOtherGeneration++
      if (has(cfg, 'GenerationsComparedInStep5')) return 'ignores it (other generations)'
    }
    promote(s, name, st, { via: 'answer', dig: a.dig })
    seenMax(st, { gen: a.hg, head: a.head })
    const kind = outcomeKind(a.res, a.code, a.row)
    settle(s, name, st, j, kind, cfg)
    writeStore(B, st, cfg, splitPersist)
    return `promotes k${st.cur} (${kind})`
  }
  // step 6
  if (a.code === 'CAPSULE_GENERATION_STALE') return 'goes to step 1'
  if (!has(cfg, 'HoldOnEarlierStay') && a.hg !== j.env.hg && a.code !== 'BODY_KEY_FORKED') return 'goes to step 1 (the entry names an earlier generation)'
  B.hold = a.hg
  if (cfg.honest && s.d.hname === name) s.g.held.push([name, a.code])
  return `holds (${a.code})`
}

// ---------------------------------------------------------------------------------------------------------------------
// Events. Each returns [{ ev, s }]: `ev` is plain data (the trace step), `s` the next state.
export function successors(json, cfg, opts = {}) {
  const fair = opts.fair === true
  const s0 = fromKey(json)
  const out = []
  const push = (ev, s) => {
    if (ev.kind === 'cycle' || ev.kind === 'receive') ghostOpenIntent(s0, s, cfg)
    out.push({ ev, s: normalise(s) })
  }
  const budget = k => s0.n[k] < cfg.budget[k]
  const names = Object.keys(s0.b)
  const holder = s0.d.hname

  // --- the destination processes one in-flight request (each distinct one); the lease may expire between checks ---
  const seenReq = new Set()
  s0.net.req.forEach((r, i) => {
    const k = keyText(r)
    if (seenReq.has(k)) return
    seenReq.add(k)
    for (const between of fair || !budget('expiries') || !s0.d.lease.held ? [false] : [false, true]) {
      const s = fromKey(json)
      const req = s.net.req.splice(i, 1)[0]
      if (cfg.budget.destBacks > 0) { const back = deepCopy(s.d); back.back = null; s.d.back = back }
      const before = {
        rows: s.d.rows.map(x => ({ ns: x.ns, id: x.id, st: x.st, seq: x.seq, wish: x.wish })), lease: { ...s.d.lease },
        lastDig: s.d.chain && s.d.chain.last ? s.d.chain.last.dig : null, verifiable: ghostVerifiable(s, req, cfg),
      }
      ghostBefore(s, req, cfg)
      const res = door(s, req, cfg, between)
      if (between) {
        if (s.d.lease.held) continue // the expiry did not fall inside this transaction
        s.n.expiries++
      }
      ghostAfter(s, req, cfg, before, res)
      if (has(cfg, 'ForgetRows')) s.d.rows = s.d.rows.filter(r => r.st === 'P')
      if (req.from !== null) s.net.ans.push({ ...res.ans, to: req.from })
      const a = res.ans
      push({ actor: 'destination', kind: between ? 'process-lease-expires-between-checks' : 'process', from: req.from, who: req.who, verb: req.rv, aid: req.env.aid, by: req.env.by, nx: req.env.nx, hg: req.env.hg, req: envDigest(req.env), answer: a.route ?? a.code ?? a.res, verified: a.ver === true, stored: res.stored === true }, s)
    }
  })
  // --- an answer is delivered, or lost ---
  const seenAns = new Set()
  s0.net.ans.forEach((a, i) => {
    const k = keyText(a)
    if (seenAns.has(k)) return
    seenAns.add(k)
    const [name, tab] = a.to
    if (!fair || name === holder) {
      const s = fromKey(json)
      s.net.ans.splice(i, 1)
      const result = receive(s, name, a, cfg)
      push({ actor: name, tab, kind: 'receive', req: a.dig, answer: a.route ?? a.code ?? a.res, verified: a.ver === true, result }, s)
    }
    if (!fair && budget('losses')) {
      const s = fromKey(json)
      s.net.ans.splice(i, 1)
      s.n.losses++
      push({ actor: 'network', kind: 'lose-answer', to: a.to, req: a.dig, answer: a.route ?? a.code ?? a.res }, s)
    }
  })

  for (const name of names) {
    const Bs0 = s0.b[name]
    if (fair && name !== holder) continue
    for (let tab = 0; tab < Bs0.tabs; tab++) {
      if (Bs0.snaps === null) {
        for (const o of cycle(json, name, tab, cfg, fair, null)) push(o.ev, o.s)
      } else if (!fair) {
        // two tabs WITHOUT the lock: a tab reads the store and the status, and later acts on what it read
        if (Bs0.snaps[tab] === null) {
          const s = fromKey(json)
          s.b[name].snaps[tab] = { st: deepCopy(view(s.b[name])), stt: statusOf(s.d, cfg) }
          push({ actor: name, tab, kind: 'tab-reads', cur: view(Bs0).cur }, s)
        } else {
          for (const o of cycle(json, name, tab, cfg, fair, s0.b[name].snaps[tab])) push(o.ev, o.s)
        }
      }
      // --- splitSend: the end of the cycle that prepared an entry (7.4 step 4, "only then send"), as its own event ---
      const j0 = view(Bs0).j
      if (cfg.splitSend && j0 !== null && !s0.g.sentSigs.some(x => x[0] === name && x[1] === j0.sig)) {
        const s = fromKey(json)
        sendJ(s, name, tab, view(s.b[name]).j)
        push({ actor: name, tab, kind: 'send', req: j0.dig }, s)
      }
      // --- a tab or body crashes and restarts with only its durable store ---
      if (!fair && budget('crashes')) {
        const s = fromKey(json)
        const B = s.b[name]
        s.n.crashes++
        B.vol = null
        B.hold = null
        if (B.snaps) B.snaps[tab] = null
        s.net.req = s.net.req.map(r => (r.from !== null && r.from[0] === name && r.from[1] === tab ? { ...r, from: null } : r))
        s.net.ans = s.net.ans.filter(a => !(a.to[0] === name && a.to[1] === tab))
        push({ actor: name, tab, kind: B.tabs > 1 ? 'tab-closes' : 'crash-restart' }, s)
      }
    }
    // --- SendBeforeStore only: the in-memory entry reaches the store after it was sent ---
    if (Bs0.vol !== null) {
      const s = fromKey(json)
      s.b[name].st = s.b[name].vol
      s.b[name].vol = null
      push({ actor: name, kind: 'persist-after-send' }, s)
    }
    // (The lease is taken only inside a 7.4 cycle, step 1: draft 6. Lease verbs and proof v2 are unchanged.)
    if (fair) continue
    // --- she makes a command at the head she reads ---
    if (Bs0.ik === s0.d.hkey && Bs0.cmds.filter(c => !c.adopted).length < cfg.cmds) {
      for (const pay of cfg.payloads) {
        const s = fromKey(json)
        const B = s.b[name]
        const h = statusOf(s.d, cfg).head
        const cmd = { seq: h[0] + 1, prev: h[1], iid: s.n.iid++, pay }
        const c = { ...cmd, id: commandId(cmd), wish: s.n.wish++, out: 'new' }
        B.cmds.push(c)
        push({ actor: name, kind: 'make-command', aid: c.id, seq: c.seq, iid: c.iid, pay, wish: c.wish }, s)
      }
    }
    // --- her memory of one command goes back (a restore of her own notes; not the act store): she knows the wish and
    // its intent id, not that it was placed, so she will issue it again at the head she reads ---
    if (budget('forgets')) {
      const oi = view(Bs0).oi
      for (const c0 of Bs0.cmds) {
        if (!['pending', 'committed', 'abandoned', 'denied', 'full'].includes(c0.out) || (oi !== null && oi.wish === c0.wish)) continue
        const s = fromKey(json)
        s.n.forgets++
        s.b[name].cmds.find(x => x.wish === c0.wish).out = 'stale'
        push({ actor: name, kind: 'forgets-outcome', aid: c0.id, was: c0.out }, s)
      }
    }
    // --- a new sign-in between send and retry: a new session (the old one stays valid for its 8 hours) ---
    if (budget('sessions')) {
      const s = fromKey(json)
      const B = s.b[name]
      const sid = `s${name}${s.n.sid++}`
      s.d.sess = s.d.sess.concat([sid]).sort()
      B.sess = sid
      s.n.sessions++
      push({ actor: name, kind: 'new-session' }, s)
    }
    // --- the holder's whole profile is copied into a new body (same installation key, store, session, commands) ---
    if (budget('copies') && name === holder) {
      const s = fromKey(json)
      s.n.copies++
      const B = s.b[name]
      const copy = deepCopy(B)
      copy.st = deepCopy(view(B))
      copy.vol = null
      copy.hold = null
      copy.tabs = 1
      copy.snaps = null
      const j = copy.st.j
      const phase = j === null ? (s.g.rotDigs.length > 0 ? 'after-an-accepted-envelope' : 'before-preparing') : !cfg.splitSend || s.g.sentSigs.some(x => x[1] === j.sig) ? 'next-key-stored-entry-sent' : 'next-key-stored-entry-unsent'
      s.b[`${name}c`] = copy
      s.g.copy = { of: name, name: `${name}c`, phase }
      push({ actor: 'world', kind: 'copy-profile', of: name, as: `${name}c`, phase }, s)
    }
    // --- a body's storage goes back one step (a restore, a lost write) ---
    if (budget('bodyBacks') && Bs0.back !== null) {
      const s = fromKey(json)
      s.n.bodyBacks++
      s.b[name].st = s.b[name].back
      s.b[name].back = null
      s.b[name].vol = null
      push({ actor: name, kind: 'storage-goes-back' }, s)
    }
    // --- a body that does not follow 7.4: it signs with its stored key and sends, without reading status ---
    if (budget('rogue') && name.endsWith('c')) {
      const s = fromKey(json)
      s.n.rogue++
      const B = s.b[name]
      const st = view(B)
      const stt = statusOf(s.d, cfg)
      const c = B.cmds.find(x => !['committed', 'abandoned', 'replaced'].includes(x.out)) ?? B.cmds[0]
      if (c) {
        const nx = s.n.key++
        const bytes = { seq: c.seq, prev: c.prev, iid: c.iid, pay: c.pay }
        const j = buildEnvelope(s, B, st, stt, { verb: 'intent', aid: c.id, cmd: bytes, wish: c.wish }, nx, cfg)
        sendJ(s, name, 0, j)
        push({ actor: name, kind: 'stale-copy-signs', by: st.cur, nx, req: j.dig }, s)
      }
    }
    // --- a buggy body names a key the chain has seen as its next key (adversarial) ---
    if (budget('seen') && Bs0.ik === s0.d.hkey && view(Bs0).j === null) {
      const stt = statusOf(s0.d, cfg)
      const c = Bs0.cmds.find(x => x.seq === stt.head[0] + 1 && x.prev === stt.head[1])
      if (c && stt.lease.held) {
        const sel = select(s0.d, cfg)
        const seenKeys = [...new Set([view(Bs0).cur, Bs0.ik, ...sel.recs.map(r => r[0])])]
        for (const nx of seenKeys) {
          const s = fromKey(json)
          s.n.seen++
          const B = s.b[name]
          const bytes = { seq: c.seq, prev: c.prev, iid: c.iid, pay: c.pay }
          const j = buildEnvelope(s, B, view(B), stt, { verb: 'intent', aid: c.id, cmd: bytes, wish: c.wish }, nx, cfg)
          sendJ(s, name, 0, j)
          push({ actor: name, kind: 'names-a-seen-key', by: j.env.by, nx, req: j.dig }, s)
        }
      }
    }
  }
  if (fair) return out

  // --- the owner moves the holder by passkey: generation + 1, the lease ended; the target's key may be the same ---
  if (budget('moves')) {
    for (const name of names) {
      if (name.endsWith('c')) continue
      const s = fromKey(json)
      s.n.moves++
      const d = s.d
      const sameKey = s.b[name].ik === d.hkey
      if (has(cfg, 'SameKeyRestartAfterLock') && sameKey && d.chain !== null && d.chain.locked) d.chain = null
      d.gen += 1
      d.hkey = s.b[name].ik
      d.hname = name
      d.lease = { held: false, gen: d.lease.gen }
      push({ actor: 'owner', kind: 'move', to: name, key: d.hkey, gen: d.gen, sameKey }, s)
    }
  }
  // --- the lease expires (or anyone with a session reserves it) ---
  if (budget('expiries') && s0.d.lease.held) {
    const s = fromKey(json)
    s.n.expiries++
    s.d.lease = { ...s.d.lease, held: false }
    push({ actor: 'clock', kind: 'lease-expires', gen: s.d.lease.gen }, s)
  }
  // --- the policy in force changes (a reviewed landing): v0 -> v1 ---
  if (budget('policies')) {
    const s = fromKey(json)
    s.n.policies++
    s.d.policy = 1
    push({ actor: 'build', kind: 'policy-change', to: 1 }, s)
  }
  // --- the destination's storage goes back one transaction ---
  if (budget('destBacks') && s0.d.back !== null) {
    const s = fromKey(json)
    s.n.destBacks++
    s.d = s.d.back
    s.g.destBack = true
    push({ actor: 'world', kind: 'destination-goes-back' }, s)
  }
  // --- a stranger sends its own envelope (no session, or a stolen one) ---
  if (budget('strangers')) {
    for (const via of [null, s0.b[holder].sess]) {
      const s = fromKey(json)
      s.n.strangers++
      const h = statusOf(s.d, cfg).head
      const cmd = { seq: h[0] + 1, prev: h[1], iid: 900, pay: 'safe' }
      const env = { v: has(cfg, 'ProofOmitsVerb') ? null : 'act', hg: s.d.gen, lg: s.d.lease.gen, aid: commandId(cmd), by: STRANGER_KEY, nx: 999 }
      s.net.req.push({ env, cmd, sig: signature(STRANGER_KEY, env), via, from: null, who: 'stranger', rv: 'act', sv: 'act', w: 900 })
      push({ actor: 'stranger', kind: 'send-own-envelope', session: via === null ? 'none' : 'stolen', req: envDigest(env) }, s)
    }
  }
  // --- a late duplicate of any request ever sent, verified or refused (the answer goes to its sender) ---
  if (budget('dups')) {
    s0.net.log.forEach(r => {
      const s = fromKey(json)
      s.n.dups++
      const live = s.b[r.who] ? [r.who, 0] : null
      s.net.req.push({ ...r, from: live })
      push({ actor: 'network', kind: 'late-duplicate', who: r.who, req: envDigest(r.env) }, s)
    })
  }
  // --- one field of an in-flight request is changed without a new signature ---
  if (budget('tampers')) {
    const swap = { intent: 'act', act: 'intent', commit: 'abandon', abandon: 'commit' }
    const done = new Set()
    s0.net.req.forEach((r, i) => {
      if (done.has(r.sig)) return
      done.add(r.sig)
      const variants = []
      if (has(cfg, 'ProofOmitsVerb')) variants.push(['verb', { ...r, rv: swap[r.rv] }])
      else variants.push(['verb', { ...r, env: { ...r.env, v: swap[r.env.v] }, rv: swap[r.env.v] }])
      variants.push(['nextKey', { ...r, env: { ...r.env, nx: 998 } }])
      if (r.cmd !== null) variants.push(['payload', { ...r, cmd: { ...r.cmd, pay: r.cmd.pay === 'safe' ? 'bad' : 'safe' } }])
      for (const [field, t] of variants) {
        const s = fromKey(json)
        s.n.tampers++
        s.net.req.splice(i, 1, { ...t, from: null })
        push({ actor: 'stranger', kind: 'change-one-field', field, req: envDigest(r.env), as: envDigest(t.env) }, s)
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// SAFETY invariants, each its own named function: state -> null | message. Transition invariants read flags the ghost
// raised at the transition; state invariants are computed here.
const flagged = name => s => { const f = s.g.flags.find(x => x[0] === name); return f ? f[1] : null }
export const INVARIANTS = Object.freeze({
  /** S8, S10: one effect per action id. */
  oneEffectPerActionId(s) {
    const ids = s.g.eff.map(e => e[0])
    const dup = ids.find((id, i) => ids.indexOf(id) !== i)
    return dup === undefined ? null : `action ${dup} took effect twice`
  },
  /** S8: one row per position. */
  positionFilledOnce: flagged('positionFilledOnce'),
  /** S13: a terminal row never changes and is never forgotten. */
  terminalRowNeverChanges(s) {
    const f = flagged('terminalRowNeverChanges')(s)
    if (f) return f
    for (const [ns, seq, id, st] of s.g.filled) {
      const row = s.d.rows.find(r => r.ns === ns && r.seq === seq && r.id === id)
      if (row === undefined && !s.g.destBack) return `terminal row ${id} at position ${seq} is gone`
    }
    return null
  },
  /** S8: one position per intent id. */
  onePositionPerIntent: flagged('onePositionPerIntent'),
  /** One effect per human wish (the client keeps its intent id on a retry, 6.9). */
  oneEffectPerWish(s) {
    const ws = s.g.eff.map(e => e[1])
    const dup = ws.find((w, i) => ws.indexOf(w) !== i)
    return dup === undefined ? null : `wish w${dup} took effect twice`
  },
  /** 7.1: a key is used once: it names one accepted successor ... */
  oneSuccessorPerKey: flagged('oneSuccessorPerKey'),
  /** ... and never becomes current twice in one chain. */
  keyUsedOnce: flagged('keyUsedOnce'),
  /** S9: no ledger effect and no rotation by an envelope that was not verified under the chain's current key. */
  effectOrRotationOnlyVerified: flagged('effectOrRotationOnlyVerified'),
  /** 6.9: a rotation comes only from a newly verified current-key envelope, exactly one for each. */
  rotationOncePerVerified: flagged('rotationOncePerVerified'),
  /** (d): a refusal has no ledger effect, and a rotation stores the answer it gave. */
  refusalHasNoEffect: flagged('refusalHasNoEffect'),
  /** 6.4: a stored answer is returned only for the envelope it answers. */
  storedAnswerMatches: flagged('storedAnswerMatches'),
  /** S11, S12: an acknowledged commit stays committed. */
  acknowledgedCommitStays(s) {
    if (s.g.destBack) return null
    for (const id of s.g.acked) if (!s.d.rows.some(r => r.id === id && r.st === 'C')) return `${id} was answered 'committed' but is not committed`
    return null
  },
  /** S26: an envelope made for one verb is never accepted for another. */
  proofVerbBound: flagged('proofVerbBound'),
  /** S15 and 7.5: once a fork has reached the destination, the chain reads as locked ("from then on the destination
   * refuses every act envelope") and there is no ledger effect until a move to an unburned key. */
  forkStopsEffects(s, cfg) {
    const f = flagged('forkStopsEffects')(s)
    if (f) return f
    const g = s.g
    if (!g.forkLive || g.instKey !== s.d.hkey) return null
    return statusOf(s.d, cfg).locked ? null : `a fork of k${g.instKey}'s chain reached the destination but the chain is not locked`
  },
  /** 7.3: a row placed under a chain that was locked is never committed, by commit or by act. */
  inheritedLockedNeverCommits: flagged('inheritedLockedNeverCommits'),
  /** Section 8: every committed row passed the gate under the policy in force at its commit. */
  gatePassedAtCommit: flagged('gatePassedAtCommit'),
  /** S16: a ledger effect needs a live lease at both checks. */
  leaseLiveAtBothChecks: flagged('leaseLiveAtBothChecks'),
  /** 6.8 and 6.7 steps 5(e) to 7: an act whose creation gate says ALLOW and whose commit gate says DENY answers
   * CAPSULE_GATE_DENIED and leaves its new row pending (when the lease holds at both checks). */
  actCommitDenyAsTable: flagged('actCommitDenyAsTable'),
  /** (l), 7.4: an open intent leaves the store only with a recorded outcome the destination confirms. */
  openIntentRetiredWithOutcome: flagged('openIntentRetiredWithOutcome'),
  /** (l), 7.4 and 6.9: a wish is given one intent id, never a second. */
  oneIntentPerWish: flagged('oneIntentPerWish'),
  /** 7.4 step 5: the client promotes only on a verified answer for its own journal digest. */
  clientPromotesOnlyOwnVerified: flagged('clientPromotesOnlyOwnVerified'),
  /** HONEST ONLY. S25: an honest schedule never produces BODY_KEY_FORKED and never locks. */
  honestNeverForked(s) {
    if (s.g.forked > 0) return 'an honest schedule produced BODY_KEY_FORKED'
    if (s.d.chain !== null && s.d.chain.locked) return 'an honest schedule locked the chain'
    return null
  },
  /** HONEST ONLY. S25: the holder never loses a stored next key: the chain's current key is in its store. */
  honestKeepsNextKey(s, cfg) {
    const B = s.b[s.d.hname]
    const sel = select(s.d, cfg)
    if (!sel.row) return null // a new chain starts at the installation key, which never leaves the store
    if (sel.cur === B.st.cur || sel.cur === B.st.next) return null
    return `the holder ${s.d.hname}'s store holds k${B.st.cur} (next ${B.st.next === null ? 'none' : `k${B.st.next}`}) but the chain is at k${sel.cur}`
  },
  /** HONEST ONLY. The honest holder never holds (6.10) on an answer to its own request. */
  honestHolderNeverHolds(s) {
    const B = s.b[s.d.hname]
    if (B.hold !== null && B.hold >= s.d.gen) return `the holder ${s.d.hname} holds${s.g.held.length ? ` on ${s.g.held[s.g.held.length - 1][1]}` : ''} at generation ${s.d.gen}`
    return null
  },
  /** HONEST ONLY. (i): PROOF_SUPERSEDED never answers an honest body's live journal entry. */
  honestNeverSupersededLive: flagged('honestNeverSupersededLive'),

})
export const HONEST_ONLY = Object.freeze(['honestNeverForked', 'honestKeepsNextKey', 'honestHolderNeverHolds', 'honestNeverSupersededLive'])

export function checkInvariants(s, cfg) {
  for (const [name, fn] of Object.entries(INVARIANTS)) {
    if (!cfg.honest && HONEST_ONLY.includes(name)) continue
    if (cfg.ignore && cfg.ignore.includes(name)) continue // for a story test only: look past an earlier invariant
    const msg = fn(s, cfg)
    if (msg !== null) return { invariant: name, message: msg }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// PROGRESS (honest scenarios only, under its assumptions: storage available, no crash, loss, move or expiry; the
// holder keeps acting). The goal: no pending row, and the holder is in step with an empty journal and no open intent
// (its wish has a recorded outcome), holding nothing.
export function ready(s, cfg) {
  if (pendingRow(s.d, cfg) !== null) return false
  const B = s.b[s.d.hname]
  const st = view(B)
  const sel = select(s.d, cfg)
  if (sel.locked || sel.burned) return false
  return st.j === null && st.oi === null && (B.hold === null || B.hold < s.d.gen) && (st.cur === sel.cur || !sel.row)
}

/** Progress is checked from every quiescent state (nothing in flight) that is not ready, and every state where the
 * holder holds: a state with messages in flight reaches a quiescent one by fair events that the explorer also takes. */
export function needsProgress(s, cfg) {
  if (ready(s, cfg)) return false
  const h = s.b[s.d.hname].hold
  return (h !== null && h >= s.d.gen) || (s.net.req.length === 0 && s.net.ans.length === 0)
}

export function progressFrom(json, cfg, memo) {
  const goal = s => ready(s, cfg)
  if (goal(fromKey(json))) return { ok: true, steps: 0 }
  const PRIORITY = ['process', 'receive', 'cycle']
  const rank = ev => {
    const r = PRIORITY.indexOf(ev.kind)
    const verbRank = ev.verb === 'abandon' ? 0 : ev.verb === 'commit' ? 1 : 2
    return (r < 0 ? 9 : r) * 4 + (ev.kind === 'cycle' ? verbRank : 0)
  }
  let cur = json
  for (let step = 1; step <= cfg.progressDepth; step++) {
    const options = successors(cur, cfg, { fair: true })
    if (options.length === 0) break
    let best = options[0]
    for (const o of options) if (rank(o.ev) < rank(best.ev)) best = o
    if (goal(best.s)) return { ok: true, steps: step }
    cur = keyText(best.s)
    if (memo.has(stateKey(cur))) return { ok: true, steps: step }
  }
  let layer = [json]
  const seen = new Set([stateKey(json)])
  for (let depth = 1; depth <= cfg.progressDepth; depth++) {
    const next = []
    for (const j of layer) {
      for (const { s: n } of successors(j, cfg, { fair: true })) {
        const nj = keyText(n)
        const k = stateKey(nj)
        if (seen.has(k)) continue
        seen.add(k)
        if (goal(n) || memo.has(k)) { memo.add(stateKey(json)); return { ok: true, steps: depth } }
        next.push(nj)
      }
    }
    layer = next
    if (layer.length === 0) break
  }
  return { ok: false, steps: cfg.progressDepth }
}

/** The initial state as the explorer starts it. */
export function startJson(cfg) {
  const init = initialState(cfg)
  init.n.dupsOn = cfg.budget.dups > 0
  init.n.splitOn = cfg.splitSend
  return keyText(normalise(init))
}

/**
 * Replay a trace given as event patterns (each a partial event: every key must match, a function value is a predicate)
 * through the same `successors`: the first matching event is taken at each step. Used for the reviewers' sequences
 * and the recorded limits, and the shape the conformance job will replay against the real door.
 */
export function replay(cfg, patterns) {
  let json = startJson(cfg)
  const trace = []
  for (const [i, p] of patterns.entries()) {
    const next = successors(json, cfg).find(({ ev }) => Object.entries(p).every(([k, v]) => (typeof v === 'function' ? v(ev[k], ev) : ev[k] === v)))
    if (next === undefined) {
      const options = successors(json, cfg).map(o => describe(o.ev)).join('\n    ')
      throw new Error(`replay step ${i + 1} ${keyText(p)} is not enabled; after:\n${formatTrace(trace)}\n  enabled:\n    ${options}`)
    }
    trace.push(next.ev)
    json = keyText(next.s)
  }
  return { trace, s: fromKey(json), json }
}

// ---------------------------------------------------------------------------------------------------------------------
// The explorer: breadth first, a visited set, the shortest trace to the first violation (or to a goal).
export function explore(cfg, opts = {}) {
  const stopAtFirst = opts.stopAtFirst !== false
  const start = startJson(cfg)
  const index = new Map([[stateKey(start), 0]])
  const parent = [-1]
  const label = [null]
  const memo = new Set()
  let layer = [[start, 0]]
  let depth = 0
  let edges = 0
  let progressChecked = 0
  const violations = []
  const traceOf = idx => { const steps = []; for (let i = idx; parent[i] !== -1; i = parent[i]) steps.push(label[i]); return steps.reverse() }
  const report = (idx, v) => violations.push({ ...v, trace: traceOf(idx) })
  if (opts.onState) opts.onState(fromKey(start), start, 0)
  outer: while (layer.length > 0 && depth < cfg.depth) {
    depth++
    const next = []
    for (const [json, idx] of layer) {
      for (const { ev, s } of successors(json, cfg)) {
        edges++
        const nj = keyText(s)
        const k = stateKey(nj)
        if (index.has(k)) continue
        const ni = parent.length
        index.set(k, ni)
        parent.push(idx)
        label.push(ev)
        if (opts.onState) opts.onState(s, nj, depth)
        if (opts.goal) {
          if (opts.goal(s)) { report(ni, { invariant: 'goal', message: 'reached' }); if (stopAtFirst) break outer; continue }
          next.push([nj, ni])
          continue
        }
        const v = checkInvariants(s, cfg)
        if (v !== null) {
          report(ni, v)
          if (stopAtFirst) break outer
          continue
        }
        if (cfg.progress && cfg.honest && needsProgress(s, cfg)) {
          progressChecked++
          const p = progressFrom(nj, cfg, memo)
          if (!p.ok) {
            report(ni, { invariant: 'progress', message: `no fair path of ${p.steps} events lets the holder act again` })
            if (stopAtFirst) break outer
            continue
          }
        }
        next.push([nj, ni])
      }
    }
    layer = next
  }
  const result = { config: cfg.name, faults: cfg.faults, amend: cfg.amend, states: parent.length, edges, depthReached: depth, frontierOpen: layer.length, progressChecked, violation: violations[0] ?? null, violations }
  if (opts.keepTraces) result.traceOf = traceOf
  return result
}

/** Every explored trace, as data, for the later conformance job that replays them against the real door. */
export function* exploredTraces(cfg) {
  const r = explore(cfg, { keepTraces: true, stopAtFirst: false })
  for (let i = 1; i < r.states; i++) yield { index: i, steps: r.traceOf(i) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a trace.
const who = f => (f === null || f === undefined ? 'nobody (sender gone)' : f[1] > 0 ? `${f[0]} tab ${f[1]}` : f[0])
export function describe(ev) {
  const tab = ev.tab !== undefined && ev.tab > 0 ? ` (tab ${ev.tab})` : ''
  const env = `${ev.verb}(${ev.aid ?? '-'}) k${ev.by}->k${ev.nx} gen ${ev.hg} [${ev.req}]`
  switch (ev.kind) {
    case 'make-command': return `${ev.actor} makes command ${ev.aid} (position ${ev.seq}, intent i${ev.iid}, ${ev.pay}, wish w${ev.wish})`
    case 'cycle': return `${ev.actor}${tab} runs 7.4${ev.notes ? ` (${ev.notes})` : ''}: ${ev.step}${ev.verb ? ` ${env}` : ''}`
    case 'send': return `${ev.actor}${tab} sends its prepared entry [${ev.req}]`
    case 'tab-reads': return `${ev.actor} tab ${ev.tab} reads the store and status WITHOUT the lock`
    case 'process': case 'process-lease-expires-between-checks':
      return `destination${ev.kind === 'process' ? '' : ' (the lease expires between its two checks)'} processes ${ev.who}'s ${env} -> ${ev.answer}${ev.verified ? ' (verified)' : ''}${ev.stored ? ' (stored answer)' : ''}`
    case 'receive': return `${ev.actor}${tab} receives ${ev.answer}${ev.verified ? ' (verified)' : ''} for [${ev.req}] and ${ev.result}`
    case 'lose-answer': return `the answer ${ev.answer} for [${ev.req}] is lost`
    case 'crash-restart': return `${ev.actor} crashes and restarts with its durable store`
    case 'tab-closes': return `${ev.actor} tab ${ev.tab} closes`
    case 'persist-after-send': return `${ev.actor} writes the entry it already sent to its store`
    case 'forgets-outcome': return `${ev.actor}'s memory of ${ev.aid} goes back (it was ${ev.was}; now she would place it again)`
    case 'new-session': return `${ev.actor} signs in again (a new session; requests already sent carry the old one)`
    case 'copy-profile': return `the whole profile of ${ev.of} is copied into ${ev.as} (${ev.phase})`
    case 'storage-goes-back': return `${ev.actor}'s storage goes back one step`
    case 'stale-copy-signs': return `${ev.actor} (not following 7.4) signs with its stored key k${ev.by} naming k${ev.nx} and sends [${ev.req}]`
    case 'names-a-seen-key': return `${ev.actor} (buggy) signs with k${ev.by} naming the seen key k${ev.nx} [${ev.req}]`
    case 'move': return `the owner moves the holder to ${ev.to} (key k${ev.key}${ev.sameKey ? ', the same key' : ''}, generation ${ev.gen}; the lease ends)`
    case 'lease-expires': return `the lease (generation ${ev.gen}) expires`
    case 'policy-change': return `a build with policy v${ev.to} lands`
    case 'destination-goes-back': return 'the destination\'s storage goes back one transaction'
    case 'send-own-envelope': return `a stranger (session: ${ev.session}) sends its own envelope [${ev.req}]`
    case 'late-duplicate': return `the network delivers a late duplicate of ${ev.who}'s [${ev.req}]`
    case 'change-one-field': return `one field (${ev.field}) of [${ev.req}] is changed in flight without a new signature [${ev.as}]`
    default: return keyText(ev)
  }
}
export function formatTrace(steps) { return steps.map((ev, i) => `  ${i + 1}. ${describe(ev)}`).join('\n') }
