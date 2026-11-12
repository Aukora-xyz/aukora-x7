'use strict'
/**
 * seed-aura: the periphery, computed in-body.
 *
 * Computes `aukora.aura.v1` with the deterministic rules of server/aura-rules.mjs (`rules-v1`):
 *   coherence        = (reachable / declared DAG nodes) * (verified / total receipts) * (active / declared organs)
 *   surprisePressure = tanh(mean of the last 5 observed surprise scores / 25)
 *   driftRisk        = 0.4 handoff mismatch + 0.3 prediction evidence debt + 0.2 (>= 2 pending wakes)
 *                      + 0.1 (rollback < 3 epochs ago)
 *   wakeUrgency      = max(surprisePressure, driftRisk, staleHeartbeatRatio)
 * with the same salience ranking and recommendedFocus. authorityTier is always `peripheral-hint`: the vector
 * is a hint for attention, never authority, and every reader recomputes it rather than trusting this file.
 *
 * This version splits the single `unanchoredPredictions` count into the three states it conflated, because the
 * old number could not answer "do I owe an observation?":
 *
 *   pendingPredictions     the promised epoch has not arrived yet (or is now, with the promised ball head).
 *                          An open claim on the future. Self-terminating: the moment the head passes the
 *                          promised epoch it becomes superseded, by construction, without anyone acting.
 *   supersededPredictions  time closed it: the promised epoch is behind the head (or is now, without that
 *                          ball). Nothing can ever observe it truthfully. Includes the promoted-but-never-
 *                          observed registers, whose claim was true and whose record is missing.
 *   unanchoredPredictions  no promised epoch at all: a legacy claim with nothing to test it against. This
 *                          is the only one of the three that is an evidence gap.
 *
 * driftRisk keys off evidence debt, never off volume: 0.3 when an unanchored register exists OR when a
 * pending register has outlived PENDING_HORIZON_EPOCHS epochs since it was sealed. It never keys off
 * supersededPredictions, and a fresh pending register contributes 0. The argument:
 *   - a superseded register is a closed account. If it fed driftRisk, the append-only log could only ratchet
 *     drift upward with time: a metric that can never fall is a counter, not a risk. Nothing is owed on a
 *     superseded register (the sweep refuses even to write a reason for the promoted-unobserved ones), and
 *     the count stays visible in the return, so "superseded" reads as accounting, not as drift.
 *   - fresh pending is the loop working as designed. Charging drift for it would make every honest
 *     pre-registration look like a fault, and the newest prediction would always be the alarm.
 *   - pending that never resolves IS a fault, and it is precisely what the horizon catches: a register
 *     sealed at epoch 10 promising epoch 40 is still "pending" at epoch 12 while nothing is happening. The
 *     subset older than the horizon is the only pending pressure, and it shares the one 0.3 slot with
 *     unanchored predictions, so the weights still sum to 1 and the slot means one thing: claim not
 *     reconciled with evidence. Stale pending therefore cannot read as calm.
 *
 * Every input is read from her own files and checked the way the readers check it: the receipt chain is
 * recomputed, every DAG node must hash to its id and be anchored by a `memory.dag.append` leaf, the
 * discovery corpus must equal the trajectories derived from verified receipt leaves, and the prediction log
 * is the register authority (the receipt chain is the fallback when the log is absent). Pending wakes live
 * with the host, so they are an explicit argument. Whenever a decisive input is missing or fails a check,
 * the organ returns `status: 'incomplete'` with the gaps and writes nothing: there is no default vector.
 *
 * On a complete reading it writes /dsh/home/auma/seed/aura.v1.json and appends an `aura.signal` receipt
 * leaf through seed-receipts (the only receipt writer). The three counts are returned alongside the aura
 * object but are deliberately NOT written into aura.v1.json: the file keeps the reader-verified schema, and
 * the vector already encodes the decision the counts were used to reach.
 */
const fs = require('node:fs')
const crypto = require('node:crypto')

const SEED = '/dsh/home/auma/seed'
const AURA_FILE = SEED + '/aura.v1.json'
const RECEIPTS = SEED + '/receipts.v3.jsonl'
const CORPUS = SEED + '/discovery-corpus.v1.jsonl'
const PREDICTION_LOG = SEED + '/predict/predictions.jsonl'
const HEAD = '/dsh/home/balls/HEAD.json'
const HANDOFF = '/dsh/home/auma/HANDOFF.md'
const DAG_DIR = '/dsh/home/auma/memory/dag'
const SUPERAGENT_STATE = '/dsh/home/auma/superagent/state.json'
const STALE_HEARTBEAT_MS = 120000
const HEARTBEAT_FUTURE_SKEW_MS = 300000
// How many epochs a pre-registered claim may stay unresolved before "pending" stops being innocent. Three
// is the smallest horizon that tolerates one promotion round plus a retry round.
const PENDING_HORIZON_EPOCHS = 3
const COUNT_FIELDS = ['reachableDagNodes', 'declaredDagNodes', 'verifiedReceipts', 'totalReceipts', 'activeOrgans', 'declaredOrgans', 'unanchoredPredictions', 'pendingPredictions', 'supersededPredictions', 'pendingWakes', 'lastRollbackAgeEpochs']
// Later additions. Optional so a fixture written before them still grades instead of failing closed.
const OPTIONAL_COUNT_FIELDS = ['stalePendingPredictions']
const SIGNAL_FIELDS = [...COUNT_FIELDS, ...OPTIONAL_COUNT_FIELDS, 'observedSurpriseScores', 'handOffEpochMismatch', 'staleHeartbeatRatio']
const PROMOTIONS = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])
const KINDS = ['high-surprise', 'dag-orphan', 'handoff-drift', 'stale-ticket', 'unanchored-claim', 'clean-state']
const CODES = {
  'high-surprise': ['recent-surprise'],
  'dag-orphan': ['unreachable-dag'],
  'handoff-drift': ['epoch-mismatch', 'invalid-signals'],
  'stale-ticket': ['stale-heartbeat', 'pending-wakes', 'recent-rollback', 'inactive-organs'],
  'unanchored-claim': ['unanchored-predictions', 'stale-pending-predictions', 'pending-predictions', 'unverified-receipts'],
  'clean-state': ['all-signals-clear'],
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

const isNonnegativeFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

// Self-contained organ source cannot depend on a host filesystem module. The synthetic
// cross-runtime tests pin these pure rules to server/aura-rules.mjs.
function readSignals(inputs) {
  const signals = {}
  for (const key of SIGNAL_FIELDS) signals[key] = ownValue(inputs, key)
  for (const key of OPTIONAL_COUNT_FIELDS) if (signals[key] === undefined) signals[key] = 0
  if (!COUNT_FIELDS.every((key) => isCount(signals[key])) || signals.declaredDagNodes === 0 || signals.totalReceipts === 0 || signals.declaredOrgans === 0 ||
      signals.reachableDagNodes > signals.declaredDagNodes || signals.verifiedReceipts > signals.totalReceipts || signals.activeOrgans > signals.declaredOrgans ||
      typeof signals.handOffEpochMismatch !== 'boolean' || !isNonnegativeFinite(signals.staleHeartbeatRatio) || !Array.isArray(signals.observedSurpriseScores)) return null
  if (!OPTIONAL_COUNT_FIELDS.every((key) => isCount(signals[key]))) return null
  // stalePending is a subset of pending by definition; a fixture claiming otherwise is not admissible.
  if (signals.stalePendingPredictions > signals.pendingPredictions) return null
  const scores = signals.observedSurpriseScores
  const scoreCount = ownValue(scores, 'length')
  if (!isCount(scoreCount) || scoreCount > 10000) return null
  const recent = []
  for (let index = 0; index < scoreCount; index += 1) {
    const score = ownValue(scores, String(index))
    if (!isNonnegativeFinite(score)) return null
    if (index >= scoreCount - 5) recent.push(score)
  }
  signals.observedSurpriseScores = recent
  return signals
}

/** Pure signal admission; zero denominators and absent evidence are incomplete. */
function auraInputsComplete(inputs) {
  try { return isRecord(inputs) && readSignals(inputs) !== null } catch (_) { return false }
}

/** Canonical receipt calibration error, never a task-success score or a 0..100 penalty. */
function predictionError(expected, observed) {
  if (!Number.isFinite(expected) || !Number.isFinite(observed) || Object.is(expected, -0) || Object.is(observed, -0)) return null
  const error = Math.abs(observed - expected) / Math.max(Math.abs(expected), 1)
  return Number.isFinite(error) ? error : null
}

function readJson(file) { return JSON.parse(String(fs.readFileSync(file, 'utf8'))) }
function readRows(file) {
  const text = String(fs.readFileSync(file, 'utf8'))
  return text === '' ? [] : text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function verifiedReceipts() {
  const rows = readRows(RECEIPTS)
  let prev = '0'.repeat(64)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const payload = Object.assign({}, row)
    delete payload.leafHash
    const leaf = crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload), 'utf8')])).digest('hex')
    if (row.schema !== 'aukora.receipt.v3' || row.seq !== i + 1 || row.prevHash !== prev || row.leafHash !== leaf || !row.data || typeof row.data !== 'object') {
      throw Object.assign(new Error('receipt chain broken at ' + (i + 1)), { gap: 'receipts' })
    }
    prev = leaf
  }
  return rows
}

function dagFacts(receipts) {
  const head = readJson(DAG_DIR + '/HEAD.json')
  if (!head || !isCount(head.count) || !Array.isArray(head.heads) || !head.heads.every(isHash)) throw Object.assign(new Error('DAG HEAD invalid'), { gap: 'dag' })
  const byId = new Map()
  for (const name of fs.readdirSync(DAG_DIR).map(String).sort()) {
    if (name === 'HEAD.json') continue
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw Object.assign(new Error('unexpected DAG file ' + name), { gap: 'dag' })
    const node = readJson(DAG_DIR + '/' + name)
    const body = Object.assign({}, node)
    delete body.id
    if (node.id !== name.slice(0, -5) || sha256(canonicalJson(body)) !== node.id) throw Object.assign(new Error('DAG node hash mismatch ' + name), { gap: 'dag' })
    const parents = node.parentIds || node.parents || []
    if (!Array.isArray(parents) || !parents.every(isHash)) throw Object.assign(new Error('DAG links invalid ' + name), { gap: 'dag' })
    const append = receipts.find((r) => r.kind === 'memory.dag.append' && (r.data.nodeId === node.id || r.data.id === node.id))
    const anchored = append && (append.data.content === undefined || append.data.content === node.content) &&
      (append.data.summary === undefined || append.data.summary === node.summary) &&
      (node.receiptHash === undefined || node.receiptHash === null || receipts.some((r) => r.leafHash === node.receiptHash && r.seq < append.seq))
    if (!anchored) throw Object.assign(new Error('DAG node not receipt-anchored ' + node.id), { gap: 'dag-receipts' })
    byId.set(node.id, parents)
  }
  if (byId.size !== head.count) throw Object.assign(new Error('DAG count mismatch'), { gap: 'dag' })
  const reachable = new Set()
  const walk = (id, depth) => {
    if (reachable.has(id)) return
    if (!byId.has(id) || depth > 256) throw Object.assign(new Error('DAG link to missing node ' + id), { gap: 'dag' })
    reachable.add(id)
    for (const parent of byId.get(id)) walk(parent, depth + 1)
  }
  for (const id of head.heads) walk(id, 0)
  return { reachableDagNodes: reachable.size, declaredDagNodes: head.count }
}

// Same rows and order as read.ts predictionEvidence: corpus must equal the receipt-derived trajectories,
// scores ordered by observe seq, and every observation leaf must belong to a trajectory. Registers without
// an observation are no longer collapsed into one number here: predictionLedger classifies them by epoch.
function predictionFacts(receipts) {
  const corpus = readRows(CORPUS)
  const trajectories = new Map()
  for (const reg of receipts.filter((r) => r.kind === 'prediction.register')) {
    const d = reg.data
    if (typeof d.predictionId !== 'string' || !isHash(d.targetBallId) || !isCount(d.targetEpoch) || typeof d.metric !== 'string' ||
        typeof d.expected !== 'number' || !Number.isFinite(d.expected) || Object.hasOwn(d, 'surpriseScore')) continue
    const obs = receipts.find((r) => r.kind === 'prediction.observe' && r.seq > reg.seq && r.data.predictionId === d.predictionId)
    if (!obs || typeof obs.data.observed !== 'number' || !Number.isFinite(obs.data.observed) || Object.hasOwn(obs.data, 'surpriseScore') ||
        ['targetBallId', 'targetEpoch', 'metric'].some((k) => obs.data[k] !== d[k])) continue
    const promotion = receipts.find((r) => PROMOTIONS.has(r.kind) && r.seq > reg.seq && r.seq < obs.seq && r.data.ballId === d.targetBallId && r.data.epoch === d.targetEpoch)
    if (!promotion) continue
    const score = predictionError(d.expected, obs.data.observed)
    if (score === null) throw Object.assign(new Error('prediction calibration invalid'), { gap: 'discovery' })
    const id = reg.leafHash + ':' + promotion.leafHash + ':' + obs.leafHash
    trajectories.set(id, { id, register: reg.leafHash, observe: obs.leafHash, observeSeq: obs.seq, predicted: d.expected, observed: obs.data.observed,
      score })
  }
  const seen = new Set()
  for (const row of corpus) {
    const t = row && trajectories.get(row.trajectoryId)
    if (!t || seen.has(t.id) || row.registerReceiptHash !== t.register || row.observeReceiptHash !== t.observe || row.predicted !== t.predicted || row.observed !== t.observed) {
      throw Object.assign(new Error('discovery corpus does not match the receipt chain'), { gap: 'discovery' })
    }
    seen.add(t.id)
  }
  if (seen.size !== trajectories.size) throw Object.assign(new Error('discovery corpus incomplete'), { gap: 'discovery' })
  const anchored = new Set([...trajectories.values()].flatMap((t) => [t.register, t.observe]))
  const loose = receipts.filter((r) => (r.kind === 'prediction.register' || r.kind === 'prediction.observe') && !anchored.has(r.leafHash))
  if (loose.some((r) => r.kind === 'prediction.observe')) throw Object.assign(new Error('an observation is outside any trajectory'), { gap: 'discovery' })
  const scores = [...trajectories.values()].sort((a, b) => a.observeSeq - b.observeSeq).map((t) => t.score)
  // Kept for audit, no longer the driftRisk input: this is a structural count of receipt leaves, not a state.
  return { observedSurpriseScores: scores, receiptOrphanPredictions: loose.length }
}

function readPredictionLog() {
  try { return readRows(PREDICTION_LOG) } catch (_) { return null }
}

const promisedEpochOf = (reg) => {
  const epoch = Number.isInteger(reg.targetEpoch) ? reg.targetEpoch : Number.isInteger(reg.expectedEpoch) ? reg.expectedEpoch : null
  return epoch
}
const promisedBallOf = (reg) => {
  if (typeof reg.targetBallId === 'string') return reg.targetBallId
  if (typeof reg.expectedBallId === 'string' && isHash(reg.expectedBallId)) return reg.expectedBallId
  return null
}

/**
 * Classify every closed-when register into pending / superseded / unanchored from the head epoch alone.
 * The log is the register authority; verified receipt leaves are the fallback when the log is absent, so a
 * lost log degrades the counts instead of zeroing them. Returns null only when the log exists but is not a
 * list of rows, which is a real gap.
 */
function predictionLedger(head, receipts) {
  const headEpoch = Number.isInteger(head.epoch) ? head.epoch : null
  const headBall = typeof head.ballId === 'string' ? head.ballId : null
  if (headEpoch === null) throw Object.assign(new Error('head epoch unavailable for the prediction ledger'), { gap: 'predictions' })
  const rows = readPredictionLog()
  if (rows !== null && !Array.isArray(rows)) throw Object.assign(new Error('prediction log is not a row list'), { gap: 'predictions' })
  const registrations = new Map()
  const observed = new Set()
  for (const row of rows || []) {
    if (!row || typeof row !== 'object' || typeof row.predictionHash !== 'string') continue
    if (row.kind === 'prediction.observe') observed.add(row.predictionHash)
    else if (row.kind === 'prediction.register') {
      const prior = registrations.get(row.predictionHash)
      // A recovered register row may carry no deadline; keep the one that does.
      if (!prior || promisedEpochOf(row) !== null) registrations.set(row.predictionHash, row)
    }
  }
  for (const row of receipts) {
    if (!row.data || typeof row.data.predictionId !== 'string') continue
    if (row.kind === 'prediction.observe') observed.add(row.data.predictionId)
    else if (row.kind === 'prediction.register' && !registrations.has(row.data.predictionId)) {
      registrations.set(row.data.predictionId, { targetBallId: row.data.targetBallId, targetEpoch: row.data.targetEpoch, headEpoch: null })
    }
  }
  const counts = { pendingPredictions: 0, supersededPredictions: 0, unanchoredPredictions: 0, stalePendingPredictions: 0 }
  for (const [hash, reg] of registrations) {
    if (observed.has(hash)) continue
    const epoch = promisedEpochOf(reg)
    if (epoch === null) { counts.unanchoredPredictions += 1; continue }
    if (epoch > headEpoch) {
      counts.pendingPredictions += 1
      // Age is only asserted with evidence: a register that never recorded the head it was sealed at
      // gets the benefit of the doubt rather than a fabricated age.
      const sealedAt = Number.isInteger(reg.headEpoch) ? reg.headEpoch : null
      if (sealedAt !== null && headEpoch - sealedAt >= PENDING_HORIZON_EPOCHS) counts.stalePendingPredictions += 1
      continue
    }
    if (epoch === headEpoch) {
      const ball = promisedBallOf(reg)
      if (ball !== null && ball === headBall) { counts.pendingPredictions += 1; continue }
    }
    counts.supersededPredictions += 1
  }
  counts.observedPredictions = observed.size
  counts.registers = registrations.size
  counts.source = rows === null ? 'receipt-leaves' : 'prediction-log'
  return counts
}

function pulseTime(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))) return Date.parse(value)
  return null
}

/** Same heartbeat precedence, timestamp parsing, and future-skew limit as server/aura-rules.mjs. */
function staleHeartbeatFacts(assignments, now, staleAfterMs = STALE_HEARTBEAT_MS) {
  if (!Array.isArray(assignments) || !isNonnegativeFinite(now) || !isNonnegativeFinite(staleAfterMs)) return null
  let running = 0
  let stale = 0
  const tickets = new Set()
  for (const assignment of assignments) {
    if (!isRecord(assignment)) return null
    if (assignment.state !== 'running') continue
    running += 1
    const reports = Array.isArray(assignment.reports) ? assignment.reports : []
    const last = reports.length > 0 ? reports[reports.length - 1] : undefined
    let at
    for (const field of [assignment.heartbeatAt, (isRecord(last) ? last.at : undefined) ?? assignment.reportedAt, assignment.startedAt]) {
      at = pulseTime(field)
      if (at !== undefined) break
    }
    if (typeof at !== 'number' || now - at < -HEARTBEAT_FUTURE_SKEW_MS) return null
    if (now - at > staleAfterMs) {
      stale += 1
      tickets.add(assignment.ticketId)
    }
  }
  return { staleHeartbeatRatio: stale / Math.max(running, 1), staleTickets: tickets.size }
}

function heartbeatRatio(now) {
  const state = readJson(SUPERAGENT_STATE)
  const facts = staleHeartbeatFacts(state.assignments, now)
  if (!facts) throw Object.assign(new Error('running assignment pulse missing, invalid, or future-skewed'), { gap: 'heartbeat' })
  const running = state.assignments.filter((assignment) => assignment.state === 'running').length
  return { ...facts, runningAssignments: running, staleAssignments: facts.staleHeartbeatRatio * running }
}

function rankSalience(signals, vector, targetId) {
  const candidates = []
  const add = (kind, score, code) => { if (score > 0) candidates.push({ kind, targetId, score: clamp01(score), code }) }
  add('high-surprise', vector.surprisePressure, 'recent-surprise')
  add('dag-orphan', 1 - signals.reachableDagNodes / Math.max(signals.declaredDagNodes, 1), 'unreachable-dag')
  add('handoff-drift', signals.handOffEpochMismatch ? 0.4 : 0, 'epoch-mismatch')
  add('stale-ticket', signals.staleHeartbeatRatio, 'stale-heartbeat')
  add('stale-ticket', signals.pendingWakes >= 2 ? 0.2 : 0, 'pending-wakes')
  add('stale-ticket', signals.lastRollbackAgeEpochs < 3 ? 0.1 : 0, 'recent-rollback')
  add('stale-ticket', 1 - signals.activeOrgans / Math.max(signals.declaredOrgans, 1), 'inactive-organs')
  add('unanchored-claim', signals.unanchoredPredictions > 0 ? 0.4 : 0, 'unanchored-predictions')
  add('unanchored-claim', signals.stalePendingPredictions > 0 ? 0.25 : 0, 'stale-pending-predictions')
  // An open claim on the future is not drift, but it is also not "all signals clear": a clean-state
  // sentinel next to an unresolved pre-registration would be the counter reading calm.
  add('unanchored-claim', signals.pendingPredictions > 0 ? 0.1 : 0, 'pending-predictions')
  add('unanchored-claim', 1 - signals.verifiedReceipts / Math.max(signals.totalReceipts, 1), 'unverified-receipts')
  if (candidates.length === 0) add('clean-state', 1, 'all-signals-clear')
  candidates.sort((l, r) => r.score - l.score || KINDS.indexOf(l.kind) - KINDS.indexOf(r.kind) ||
    CODES[l.kind].indexOf(l.code) - CODES[r.kind].indexOf(r.code) || (l.targetId < r.targetId ? -1 : l.targetId > r.targetId ? 1 : 0))
  const selected = []
  for (const c of candidates) {
    if (!selected.some((s) => s.kind === c.kind)) selected.push(c)
    if (selected.length === 3) break
  }
  return selected
}

function focusOf(v) {
  if (v.wakeUrgency >= 0.7) return 'escalate-to-owner'
  if (v.driftRisk >= 0.4) return 'verify'
  if (v.surprisePressure >= 0.3) return 'observe'
  if (v.coherence < 0.95) return 'consolidate'
  return 'rest'
}

function statusOf(v) {
  if (v.wakeUrgency >= 0.7) return 'alert'
  if (v.driftRisk >= 0.4 || v.coherence < 0.7) return 'strained'
  if (v.surprisePressure >= 0.3 || v.coherence < 0.95 || v.wakeUrgency > 0) return 'attentive'
  return 'calm'
}

/** Read and check every input; returns signals or the list of gaps. */
function collect(args, now) {
  const gaps = []
  const signals = {}
  let head = null
  const step = (gap, fn) => { try { return fn() } catch (error) { gaps.push((error && error.gap) || gap); return null } }
  head = step('head', () => {
    const h = readJson(HEAD)
    if (!isHash(h.ballId) || !isCount(h.epoch) || !h.entries || typeof h.entries !== 'object') throw new Error('head invalid')
    return h
  })
  const receipts = step('receipts', verifiedReceipts)
  if (head) {
    const entries = Object.values(head.entries)
    signals.activeOrgans = entries.filter((e) => e && e.disabled !== true).length
    signals.declaredOrgans = entries.length
    step('handoff', () => {
      const text = String(fs.readFileSync(HANDOFF, 'utf8'))
      const epoch = /epoch\s*\|\s*\*\*(\d+)\*\*/i.exec(text)
      const ball = /ballId\s*\|\s*`([0-9a-f]{64})`/i.exec(text)
      if (!epoch || !ball) throw new Error('HANDOFF.md has no epoch/ballId rows')
      signals.handOffEpochMismatch = Number(epoch[1]) !== head.epoch || ball[1] !== head.ballId
    })
  }
  if (receipts) {
    signals.verifiedReceipts = receipts.length
    signals.totalReceipts = receipts.length
    Object.assign(signals, step('dag', () => dagFacts(receipts)) || {})
    const ledger = step('predictions', () => predictionLedger(head, receipts))
    // Without a readable head there is no epoch to classify against; the zeroes below are never used
    // because the 'predictions' gap already makes the reading incomplete.
    const counts = ledger || { pendingPredictions: 0, supersededPredictions: 0, unanchoredPredictions: 0, stalePendingPredictions: 0 }
    Object.assign(signals, step('discovery', () => predictionFacts(receipts)) || {})
    signals.pendingPredictions = counts.pendingPredictions
    signals.supersededPredictions = counts.supersededPredictions
    signals.stalePendingPredictions = counts.stalePendingPredictions
    signals.unanchoredPredictions = counts.unanchoredPredictions
    if (ledger) signals.predictionLedgerSource = counts.source
    if (head) {
      const rollback = receipts.filter((r) => r.kind === 'tree.undo' || r.kind === 'snapshot.restore').at(-1)
      if (rollback && (!isCount(rollback.data.epoch) || rollback.data.epoch > head.epoch)) gaps.push('rollback')
      else signals.lastRollbackAgeEpochs = rollback ? head.epoch - rollback.data.epoch : Number.MAX_SAFE_INTEGER
    }
  }
  Object.assign(signals, step('heartbeat', () => heartbeatRatio(now)) || {})
  const pending = args && args.wake && args.wake.pendingWakes
  if (isCount(pending)) signals.pendingWakes = pending
  else gaps.push('wakes')
  for (const [field, gap] of [['declaredDagNodes', 'dag'], ['totalReceipts', 'receipts'], ['declaredOrgans', 'organs']]) {
    if (!isCount(signals[field]) || signals[field] === 0) gaps.push(gap)
  }
  if (gaps.length === 0 && !auraInputsComplete(signals)) gaps.push('signals')
  return { head, receipts, signals, gaps: [...new Set(gaps)] }
}

/** Pure rules-v1 projection; invalid evidence emits only the conservative verify sentinel. */
function computeAura(inputs) {
  if (!isRecord(inputs)) throw new TypeError('Aura inputs must be a plain object')
  const computedAt = ownValue(inputs, 'computedAt')
  const ballId = ownValue(inputs, 'ballId')
  const epoch = ownValue(inputs, 'epoch')
  if (!isCount(computedAt) || typeof ballId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(ballId) || !isCount(epoch)) {
    throw new TypeError('Aura requires an integer timestamp, 64-hex ballId, and nonnegative integer epoch')
  }
  let signals
  try { signals = readSignals(inputs) } catch (_) { signals = null }
  const metadata = { schema: 'aukora.aura.v1', computedAt, ballId, epoch, scorer: 'rules-v1', authorityTier: 'peripheral-hint' }
  if (!signals) return { ...metadata, vector: { coherence: 0, surprisePressure: 1, driftRisk: 1, wakeUrgency: 1 },
    salience: [{ kind: 'handoff-drift', targetId: ballId, score: 1, code: 'invalid-signals' }], recommendedFocus: 'verify' }
  const recent = signals.observedSurpriseScores.slice(-5)
  let mean = 0
  recent.forEach((score, index) => { mean += (score - mean) / (index + 1) })
  const anchorCoherence = 1 / (1 + 0.2 * signals.unanchoredPredictions)
  const coherence = clamp01((signals.reachableDagNodes / signals.declaredDagNodes) *
    (signals.verifiedReceipts / signals.totalReceipts) * (signals.activeOrgans / signals.declaredOrgans) * anchorCoherence)
  const surprisePressure = clamp01(Math.tanh(mean / 25))
  // One slot, one meaning: a claim is not reconciled with evidence. Unanchored (nothing to test it
  // against) and stale pending (a deadline that never arrives) both qualify. Superseded never does.
  const evidenceDebt = signals.unanchoredPredictions > 0 || signals.stalePendingPredictions > 0
  const driftRisk = clamp01((signals.handOffEpochMismatch ? 0.4 : 0) + (signals.unanchoredPredictions > 0 ? 0.4 : 0) +
    (signals.pendingWakes >= 2 ? 0.2 : 0) + (signals.lastRollbackAgeEpochs < 3 ? 0.1 : 0))
  const vector = { coherence, surprisePressure, driftRisk, wakeUrgency: clamp01(Math.max(surprisePressure, driftRisk, signals.staleHeartbeatRatio)) }
  return {
    ...metadata, vector, salience: rankSalience(signals, vector, ballId), recommendedFocus: signals.pendingWakes >= 2 && focusOf(vector) === 'rest' ? 'verify' : focusOf(vector),
  }
}

/** The three prediction states, from already-admitted signals. Missing optional fields read as zero. */
function predictionCounts(inputs) {
  let signals = null
  try { signals = readSignals(inputs) } catch (_) { signals = null }
  if (!signals) return null
  return {
    pending: signals.pendingPredictions,
    superseded: signals.supersededPredictions,
    unanchored: signals.unanchoredPredictions,
    stalePending: signals.stalePendingPredictions,
  }
}

module.exports = {
  computeAura,
  auraInputsComplete,
  staleHeartbeatFacts,
  predictionError,
  predictionCounts,
  name: 'seed-aura',
  description:
    'The periphery (aura.v1, rules-v1): coherence, surprisePressure, driftRisk and wakeUrgency computed from her own checked files with the ' +
    'server/aura-rules.mjs formulas. A peripheral hint, never authority. compute (needs wake.pendingWakes from the host) writes aura.v1.json and an ' +
    'aura.signal receipt only when every input verifies; otherwise status "incomplete" with the gaps. read returns the stored file. This version splits ' +
    'open pre-registrations into pendingPredictions / supersededPredictions / unanchoredPredictions (returned as `counts`, never written into ' +
    'aura.v1.json): driftRisk keys off evidence debt (unanchored registers, or a pending register older than 3 epochs), never off the superseded ' +
    'count and never off a fresh pending one.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['compute', 'dry_run', 'read'] },
      inputs: { type: 'object', description: 'Synthetic signals for Pearl trials: bypasses collect() so a degraded head can be graded.' },
      wake: { type: 'object', properties: { pendingWakes: { type: 'number' } }, description: 'Host wake facts: consecutive unacknowledged wakes plus a pending probe.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (args && args.inputs && typeof args.inputs === 'object') {
      const need = [...COUNT_FIELDS, ...OPTIONAL_COUNT_FIELDS].filter((k) => typeof args.inputs[k] !== 'number')
      if (need.length > 0) return { ok: false, action: args.action, error: 'AURA_INPUTS_INCOMPLETE', missingFields: need, written: false }
    }
    const action = args && args.action
    if (action === 'read') {
      try { return { ok: true, action, aura: readJson(AURA_FILE) } } catch (_) { return { ok: false, action, error: 'AURA_NOT_WRITTEN' } }
    }
    if (action !== 'compute' && action !== 'dry_run') return { ok: false, error: 'UNKNOWN_ACTION', action: action || null }
    const now = Date.now()
    if (isRecord(args.inputs) || (isRecord(args.wake) && isRecord(args.wake.trialInputs))) {
      let injected
      const raw = (isRecord(args.inputs) && args.inputs) || args.wake.trialInputs
      try { injected = computeAura({ computedAt: now, ballId: ''.padEnd(64, '0'), epoch: 0, ...raw }) }
      catch (error) { return { ok: false, action, error: 'INVALID_INPUTS', message: String((error && error.message) || error) } }
      return { ok: true, action, injected: true, aura: injected, counts: predictionCounts({ ...raw }), ...injected }
    }
    const { head, signals, gaps } = collect(args, now)
    if (gaps.length) return { ok: true, action, status: 'incomplete', authorityTier: 'peripheral-hint', gaps, vector: null, written: false }
    const aura = computeAura({ ...signals, ballId: head.ballId, epoch: head.epoch, computedAt: now })
    const status = statusOf(aura.vector)
    const inputs = { ...signals, observedSurpriseScores: signals.observedSurpriseScores.slice(-5) }
    const counts = predictionCounts(signals)
    if (action === 'dry_run') return { ok: true, action, status, aura, inputs, counts, written: false }
    const organs = ctx && ctx.organs
    if (!organs || typeof organs.call !== 'function') return { ok: false, action, status, error: 'RECEIPTS_ORGAN_UNAVAILABLE', written: false }
    const body = JSON.stringify(aura, null, 2) + '\n'
    const priorAura = fs.existsSync(AURA_FILE) ? fs.readFileSync(AURA_FILE) : null
    fs.writeFileSync(AURA_FILE, body)
    const receipt = await organs.call('seed-receipts', {
      action: 'append',
      kind: 'aura.signal',
      data: { ballId: aura.ballId, epoch: aura.epoch, computedAt: aura.computedAt, scorer: aura.scorer, authorityTier: aura.authorityTier,
        vector: aura.vector, recommendedFocus: aura.recommendedFocus, status, auraSha256: sha256(canonicalJson(aura)) },
    })
    if (!receipt || receipt.ok !== true) {
      if (priorAura) fs.writeFileSync(AURA_FILE, priorAura)
      else { try { fs.unlinkSync(AURA_FILE) } catch (_) {} }
      return { ok: false, action, error: 'AURA_RECEIPT_FAILED', written: false, receiptError: receipt && receipt.error ? String(receipt.error).slice(0, 200) : null }
    }
    if (!receipt || receipt.ok !== true) return { ok: false, action, status, aura, written: true, error: (receipt && receipt.error) || 'RECEIPT_NOT_ACKNOWLEDGED' }
    return { ok: true, action, status, aura, inputs, counts, written: true, receipt: { seq: receipt.receipt.seq, leafHash: receipt.receipt.leafHash } }
  },
}
