/** Private local message persistence. Construction performs no filesystem I/O. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { handleMessagesRequest, readMessagesStatus, projectPredictionReceipts, predictionUnavailable, createWakeProbeRunner, createWakeAuraReader, isWakeProbeExecutor } from '../deploy/cloudflare/src/messages-store.mjs'
import { createMirrorUpdate } from '../deploy/cloudflare/src/head-do.mjs'
import { computeAura, overdueWakeRatio, staleHeartbeatFacts, validateAuraVector } from './aura-rules.mjs'
import { computeAuraFocusShadow } from '../deploy/cloudflare/src/aura-focus-shadow.mjs'
import { auraFocusCellShadow } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'
import { loadAuraFocusCell } from '../deploy/cloudflare/src/aura-focus-cell.mjs'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { verifyFactCheckpoints, projectVerifiedFacts, projectBuildInfo } from './verified-facts.mjs'

const STATE_KEY = 'messages:v1'
const AURA_FOCUS_CELL = loadAuraFocusCell()
const STATE_LIMIT = 112 * 1024
const RECEIPT_LIMIT = 1024 * 1024
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
const sameVersion = (left, right) => sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
const lstatOrAbsent = async file => {
  try { return await fsp.lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function assertRegular(stat, privateFile = false) {
  if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (privateFile && (stat.mode & 0o777) !== 0o600)) throw failure('MESSAGES_PATH_REFUSED')
}

/** Check every ancestor, including existing ancestors outside the private directory. */
async function directoryChain(directory, create = false) {
  const chain = []
  let current = path.parse(directory).root
  for (const segment of ['', ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment)
    let stat = await lstatOrAbsent(current)
    if (!stat && create) {
      if (chain.length) await verifyChain(chain)
      try { await fsp.mkdir(current, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      stat = await fsp.lstat(current)
      if (chain.length) {
        const parent = await fsp.open(chain.at(-1).file, DIRECTORY_FLAGS)
        try {
          if (!sameFile(await parent.stat(), chain.at(-1).stat)) throw failure('MESSAGES_PATH_CHANGED')
          await parent.sync()
        } finally { await parent.close() }
      }
    }
    if (!stat) throw Object.assign(failure('MESSAGES_DIRECTORY_ABSENT'), { code: 'ENOENT' })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('MESSAGES_PATH_REFUSED')
    chain.push({ file: current, stat })
  }
  await verifyChain(chain)
  return chain
}

async function verifyChain(chain) {
  for (const entry of chain) {
    const stat = await fsp.lstat(entry.file)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, entry.stat) || stat.uid !== entry.stat.uid || stat.mode !== entry.stat.mode) throw failure('MESSAGES_PATH_CHANGED')
  }
  if (await fsp.realpath(chain.at(-1).file) !== chain.at(-1).file) throw failure('MESSAGES_PATH_REFUSED')
}

/** Read at most limit + 1 bytes from a single regular, unlinked-to-elsewhere file. */
async function readBounded(file, chain, limit, privateFile = false, signal) {
  signal?.throwIfAborted()
  await verifyChain(chain)
  const before = await lstatOrAbsent(file)
  if (!before) { await verifyChain(chain); return null }
  assertRegular(before, privateFile)
  if (before.size > limit) throw failure('MESSAGES_FILE_TOO_LARGE')
  const handle = await fsp.open(file, READ_FLAGS)
  let bytes
  try {
    const opened = await handle.stat()
    assertRegular(opened, privateFile)
    if (!sameVersion(before, opened)) throw failure('MESSAGES_PATH_CHANGED')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > limit) throw failure('MESSAGES_FILE_TOO_LARGE')
    const after = await handle.stat()
    assertRegular(after, privateFile)
    if (!sameVersion(opened, after) || length !== after.size) throw failure('MESSAGES_PATH_CHANGED')
    bytes = buffer.subarray(0, length)
  } finally { await handle.close() }
  await verifyChain(chain)
  const after = await fsp.lstat(file)
  assertRegular(after, privateFile)
  if (!sameVersion(before, after)) throw failure('MESSAGES_PATH_CHANGED')
  signal?.throwIfAborted()
  return { bytes, stat: after }
}

function stateBytes(value) {
  let text
  try { text = JSON.stringify(value) }
  catch (error) { throw failure('MESSAGES_STATE_INVALID') }
  if (typeof text !== 'string') throw failure('MESSAGES_STATE_INVALID')
  if (Buffer.byteLength(text) > STATE_LIMIT) throw failure('MESSAGES_STATE_LIMIT', 507)
  return Buffer.from(text)
}
const cloneState = value => value === undefined ? undefined : JSON.parse(stateBytes(value).toString('utf8'))

/**
 * Create one serialized adapter for messages:v1. Call only after request authorization.
 * @param {{directory: string}} options Absolute private runtime directory, never replicated.
 * @returns {{transaction: Function}} Atomic JSON transactions; stale locks require operator recovery.
 */
export function createLocalMessagesStorage({ directory }) {
  return createPrivateLocalStorage({ directory, key: STATE_KEY, filename: 'messages.v1.json' })
}

/** One private JSON file per fixed key; callers cannot select paths through transactions. */
function createPrivateLocalStorage({ directory, key: storageKey, filename }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw failure('MESSAGES_DIRECTORY_INVALID')
  const root = path.resolve(directory)
  const statePath = path.join(root, filename)
  const lockPath = path.join(root, 'WRITE.lock')
  let queue = Promise.resolve()

  const transact = async operation => {
    const chain = await directoryChain(root, true)
    const rootStat = chain.at(-1).stat
    if ((rootStat.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) throw failure('MESSAGES_DIRECTORY_NOT_PRIVATE')
    const directoryHandle = await fsp.open(root, DIRECTORY_FLAGS)
    let lock
    let lockStat
    let keepLock = false
    let lockReady = false
    try {
      if (!sameFile(await directoryHandle.stat(), rootStat)) throw failure('MESSAGES_PATH_CHANGED')
      await verifyChain(chain)
      try { lock = await fsp.open(lockPath, CREATE_FLAGS, 0o600) }
      catch (error) { if (error.code === 'EEXIST') throw failure('MESSAGES_STORAGE_LOCKED', 423); throw error }
      lockStat = await lock.stat()
      assertRegular(lockStat, true)
      // A crash leaves this exclusive lock in place. Never infer that another writer is dead.
      keepLock = true
      await lock.writeFile(crypto.randomUUID() + '\n')
      await lock.sync()
      await directoryHandle.sync()
      await verifyChain(chain)
      keepLock = false
      lockReady = true
      let stored
      try { stored = await readBounded(statePath, chain, STATE_LIMIT, true) }
      catch (error) { if (error.code === 'MESSAGES_FILE_TOO_LARGE') throw failure('MESSAGES_STATE_CORRUPT'); throw error }
      let value
      if (stored) {
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)) }
        catch (error) { throw failure('MESSAGES_STATE_CORRUPT') }
      }
      let active = true
      let dirty = false
      const checkKey = key => {
        if (!active) throw failure('MESSAGES_TRANSACTION_CLOSED')
        if (key !== storageKey) throw failure('MESSAGES_STORAGE_KEY_REFUSED')
      }
      let result
      try {
        result = await operation({
          async get(key) { checkKey(key); return cloneState(value) },
          async put(key, incoming) { checkKey(key); value = cloneState(incoming); dirty = true },
        })
      } finally { active = false }
      if (dirty) {
        const bytes = stateBytes(value)
        const temporary = path.join(root, `.messages.${crypto.randomUUID()}.tmp`)
        let temporaryStat
        let renamed = false
        try {
          await verifyChain(chain)
          const handle = await fsp.open(temporary, CREATE_FLAGS, 0o600)
          try {
            temporaryStat = await handle.stat()
            assertRegular(temporaryStat, true)
            await handle.writeFile(bytes)
            await handle.sync()
            temporaryStat = await handle.stat()
          } finally { await handle.close() }
          await verifyChain(chain)
          const temporaryNow = await fsp.lstat(temporary)
          assertRegular(temporaryNow, true)
          if (!sameVersion(temporaryStat, temporaryNow)) throw failure('MESSAGES_PATH_CHANGED')
          const targetNow = await lstatOrAbsent(statePath)
          if (targetNow) assertRegular(targetNow, true)
          if (stored ? !targetNow || !sameVersion(stored.stat, targetNow) : targetNow !== null) throw failure('MESSAGES_STATE_CHANGED')
          // A rename or directory-flush failure leaves an explicit recovery lock.
          keepLock = true
          await fsp.rename(temporary, statePath)
          renamed = true
          await verifyChain(chain)
          const replaced = await fsp.lstat(statePath)
          assertRegular(replaced, true)
          if (!sameFile(replaced, temporaryStat)) throw failure('MESSAGES_PATH_CHANGED')
          await directoryHandle.sync()
          keepLock = false
        } finally {
          if (!renamed && temporaryStat) {
            await verifyChain(chain)
            const residue = await lstatOrAbsent(temporary)
            if (residue && sameFile(residue, temporaryStat) && residue.nlink === 1 && residue.isFile()) await fsp.unlink(temporary)
          }
        }
      }
      return result
    } finally {
      try {
        if (lock) await lock.close()
        if (lockReady && !keepLock) {
          await verifyChain(chain)
          const held = await fsp.lstat(lockPath)
          assertRegular(held, true)
          if (!sameFile(held, lockStat)) throw failure('MESSAGES_LOCK_CHANGED')
          await fsp.unlink(lockPath)
          await directoryHandle.sync()
        }
      } finally { await directoryHandle.close() }
    }
  }
  return {
    transaction(operation) {
      const result = queue.then(() => transact(operation))
      queue = result.catch(() => undefined)
      return result
    },
  }
}

/**
 * Read only the fixed receipt journal; no directories are created and no receipt is trusted.
 * @param {{mirrorDirectory: string}} options Absolute mirror root for the fixed journal path.
 * @returns {Promise<object>} Sanitized projection or an explicit absent/unavailable result.
 */
export async function readLocalPredictionStatus({ mirrorDirectory }) {
  if (typeof mirrorDirectory !== 'string' || !path.isAbsolute(mirrorDirectory) || mirrorDirectory.includes('\0')) return predictionUnavailable('PREDICTION_RECEIPTS_UNAVAILABLE')
  const directory = path.join(path.resolve(mirrorDirectory), 'home', 'auma', 'seed')
  try {
    const chain = await directoryChain(directory)
    const source = await readBounded(path.join(directory, 'receipts.v3.jsonl'), chain, RECEIPT_LIMIT)
    if (!source) return predictionUnavailable('PREDICTION_RECEIPTS_ABSENT', 'absent')
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) }
    catch (error) { return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed') }
    return projectPredictionReceipts(text)
  } catch (error) {
    if (error.code === 'ENOENT') return predictionUnavailable('PREDICTION_RECEIPTS_ABSENT', 'absent')
    if (error.code === 'MESSAGES_FILE_TOO_LARGE') return predictionUnavailable('PREDICTION_RECEIPTS_TOO_LARGE')
    return predictionUnavailable('PREDICTION_RECEIPTS_UNAVAILABLE')
  }
}

const AURA_LOCAL_LIMITS = Object.freeze({ files: 256, bytes: 4 * 1024 * 1024, jsonBytes: 256 * 1024, nodeBytes: 64 * 1024, rows: 2048, depth: 32, values: 20000 })
const auraHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const auraCount = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const auraObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const auraDigest = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
const auraWithout = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const auraRequire = (condition, code) => { if (!condition) throw failure(code) }

function parseAuraJson(text) {
  const value = JSON.parse(text)
  const pending = [[value, 0]]
  let visited = 0
  while (pending.length) {
    const [item, depth] = pending.pop()
    auraRequire(++visited <= AURA_LOCAL_LIMITS.values && depth <= AURA_LOCAL_LIMITS.depth, 'AURA_JSON_LIMIT')
    if (typeof item === 'number') auraRequire(Number.isFinite(item) && !Object.is(item, -0), 'AURA_JSON_INVALID')
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1])
  }
  return value
}

function auraRows(text) {
  if (text === '') return []
  // A nonterminated append may be a torn journal, even when its last JSON value parses.
  auraRequire(text.endsWith('\n'), 'AURA_JOURNAL_TRUNCATED')
  const lines = text.slice(0, -1).split('\n')
  auraRequire(lines.length <= AURA_LOCAL_LIMITS.rows, 'AURA_RECORD_LIMIT')
  return lines.map(line => {
    auraRequire(line.trim() !== '' && Buffer.byteLength(line) <= AURA_LOCAL_LIMITS.nodeBytes, 'AURA_RECORD_INVALID')
    const row = parseAuraJson(line)
    auraRequire(auraObject(row), 'AURA_RECORD_INVALID')
    return row
  })
}

function verifyAuraHead(head) {
  auraRequire(auraObject(head) && head.version === 'x6.1-ball/v1' && auraHash(head.ballId) && auraCount(head.epoch)
    && (head.parentBallId === null || auraHash(head.parentBallId)) && auraObject(head.entries) && auraObject(head.modules), 'AURA_HEAD_INVALID')
  const entries = Object.entries(head.entries), modules = Object.entries(head.modules)
  auraRequire(entries.length <= 256 && modules.length <= 512, 'AURA_HEAD_LIMIT')
  const entryValid = entry => auraObject(entry) && typeof entry.specifier === 'string' && entry.specifier.length > 0
    && typeof entry.disabled === 'boolean' && auraObject(entry.config)
  for (const [id, entry] of entries) {
    auraRequire(entryValid(entry) && entry.id === id && Array.isArray(entry.previousSpecifiers)
      && entry.previousSpecifiers.every(specifier => typeof specifier === 'string' && specifier.length > 0)
      && (entry.previousVersions === undefined || (Array.isArray(entry.previousVersions) && entry.previousVersions.every(entryValid))), 'AURA_HEAD_INVALID')
    for (const version of [entry, ...(entry.previousVersions ?? []), ...entry.previousSpecifiers.map(specifier => ({ specifier }))]) {
      auraRequire(!version.specifier.startsWith('ball:') || (auraHash(version.specifier.slice(5)) && Object.hasOwn(head.modules, version.specifier.slice(5))), 'AURA_HEAD_INVALID')
    }
  }
  for (const [sha, module] of modules) auraRequire(auraHash(sha) && auraObject(module) && module.sha256 === sha && module.specifier === `ball:${sha}`, 'AURA_HEAD_INVALID')
  const legacy = crypto.createHash('sha256').update(JSON.stringify({ version: head.version, parentBallId: head.parentBallId, epoch: head.epoch,
    entries: Object.keys(head.entries).sort().map(key => head.entries[key]), modules: Object.keys(head.modules).sort().map(key => head.modules[key]) })).digest('hex')
  auraRequire(head.ballId === legacy || head.ballId === auraDigest(auraWithout(head, 'ballId')), 'AURA_HEAD_HASH_MISMATCH')
}

function verifyAuraReceipts(rows) {
  let previous = '0'.repeat(64)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    auraRequire(row.schema === 'aukora.receipt.v3' && row.seq === index + 1 && row.prevHash === previous
      && typeof row.at === 'string' && row.at.length > 0 && row.at.length <= 80
      && typeof row.kind === 'string' && row.kind.length > 0 && row.kind.length <= 80 && auraObject(row.data), 'AURA_RECEIPT_CHAIN_INVALID')
    const claimed = row.leafHash ?? row.hash
    auraRequire(auraHash(claimed) && (row.hash === undefined || row.hash === claimed), 'AURA_RECEIPT_HASH_INVALID')
    const payload = auraWithout(row, row.leafHash === undefined ? 'hash' : 'leafHash')
    const recomputed = crypto.createHash('sha256').update(Buffer.from([0])).update(canonicalJson(payload)).digest('hex')
    auraRequire(recomputed === claimed, 'AURA_RECEIPT_HASH_MISMATCH')
    previous = recomputed
  }
  return rows.map(row => ({ ...row, leafHash: row.leafHash ?? row.hash }))
}

function verifyAuraDag(head, nodes, receipts) {
  const ids = value => Array.isArray(value) && value.length <= 256 && value.every(auraHash) && new Set(value).size === value.length
  auraRequire(auraObject(head) && auraCount(head.count) && head.count <= 256 && ids(head.heads) && head.count === nodes.length, 'AURA_DAG_HEAD_INVALID')
  const byId = new Map()
  for (const node of nodes) {
    auraRequire(auraObject(node) && auraHash(node.id) && node.id === auraDigest(auraWithout(node, 'id')) && !byId.has(node.id), 'AURA_DAG_HASH_MISMATCH')
    const parents = node.parentIds ?? node.parents
    auraRequire(ids(parents) && parents.length <= 16
      && (node.parentIds === undefined || node.parents === undefined || canonicalJson(node.parentIds) === canonicalJson(node.parents)), 'AURA_DAG_LINKS_INVALID')
    const receipt = receipts.find(row => row.kind === 'memory.dag.append' && (row.data.nodeId === node.id || row.data.id === node.id))
    // The node hashes its preceding receipt context; its append receipt is necessarily later.
    auraRequire(receipt !== undefined && (node.receiptHash === undefined || node.receiptHash === null
      || receipts.some(row => row.leafHash === node.receiptHash && row.seq < receipt.seq))
      && (receipt.data.content === undefined || receipt.data.content === node.content)
      && (receipt.data.summary === undefined || receipt.data.summary === node.summary), 'AURA_DAG_UNANCHORED')
    byId.set(node.id, parents)
  }
  const reachable = new Set(), visiting = new Set()
  const walk = (id, depth) => {
    auraRequire(depth <= AURA_LOCAL_LIMITS.depth && !visiting.has(id) && byId.has(id), 'AURA_DAG_LINKS_INVALID')
    if (reachable.has(id)) return
    visiting.add(id)
    for (const parent of byId.get(id)) walk(parent, depth + 1)
    visiting.delete(id)
    reachable.add(id)
  }
  for (const id of head.heads) walk(id, 0)
  // Validate disconnected components too; corrupt or missing ancestors are not healthy orphans.
  const fromHeads = reachable.size
  for (const id of byId.keys()) walk(id, 0)
  return { reachableDagNodes: fromHeads, declaredDagNodes: head.count }
}

function verifyAuraPredictions(receipts, corpus, epoch) {
  const promotions = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])
  const registrations = new Map(), observations = new Set(), trajectories = new Map(), scores = []
  let rollback = null
  const fieldsValid = (data, amount) => typeof data.predictionId === 'string' && data.predictionId.length > 0 && data.predictionId.length <= 200
    && auraHash(data.targetBallId) && auraCount(data.targetEpoch) && typeof data.metric === 'string' && data.metric.length > 0 && data.metric.length <= 80
    && typeof data[amount] === 'number' && Number.isFinite(data[amount]) && !Object.hasOwn(data, 'surpriseScore')
  for (const row of receipts) {
    if (row.kind === 'tree.undo' || row.kind === 'snapshot.restore') {
      auraRequire(auraCount(row.data.epoch) && row.data.epoch <= epoch, 'AURA_ROLLBACK_INVALID')
      rollback = row.data.epoch
    }
    if (row.kind === 'prediction.register') {
      auraRequire(fieldsValid(row.data, 'expected') && !registrations.has(row.data.predictionId), 'AURA_PREDICTION_INVALID')
      registrations.set(row.data.predictionId, row)
    }
    if (row.kind !== 'prediction.observe') continue
    auraRequire(fieldsValid(row.data, 'observed') && !observations.has(row.data.predictionId), 'AURA_PREDICTION_INVALID')
    const register = registrations.get(row.data.predictionId)
    auraRequire(register && ['targetBallId', 'targetEpoch', 'metric'].every(key => row.data[key] === register.data[key]), 'AURA_PREDICTION_BINDING_INVALID')
    const promotion = receipts.find(item => promotions.has(item.kind) && item.seq > register.seq && item.seq < row.seq
      && item.data.ballId === row.data.targetBallId && item.data.epoch === row.data.targetEpoch)
    auraRequire(promotion, 'AURA_PREDICTION_ORDER_INVALID')
    const parent = receipts.filter(item => item.seq < promotion.seq && item.data.ballId === promotion.data.parentBallId && auraCount(item.data.epoch)).at(-1)
    auraRequire(parent && parent.data.epoch < promotion.data.epoch, 'AURA_PREDICTION_PARENT_UNKNOWN')
    const score = Math.abs(row.data.observed - register.data.expected) / Math.max(Math.abs(register.data.expected), 1)
    auraRequire(Number.isFinite(score), 'AURA_PREDICTION_INVALID')
    const trajectoryId = `${register.leafHash}:${promotion.leafHash}:${row.leafHash}`
    trajectories.set(trajectoryId, { trajectoryId, pearlId: row.data.targetBallId, epochBefore: parent.data.epoch, epochAfter: row.data.targetEpoch,
      predicted: register.data.expected, observed: row.data.observed, surpriseScore: score, registerReceiptHash: register.leafHash,
      promotionReceiptHash: promotion.leafHash, observeReceiptHash: row.leafHash, exceptionRuleCandidate: score > 0 })
    observations.add(row.data.predictionId)
    scores.push(score)
  }
  auraRequire(corpus.length === trajectories.size, 'AURA_DISCOVERY_INCOMPLETE')
  for (const row of corpus) {
    const expected = trajectories.get(row.trajectoryId)
    auraRequire(expected && canonicalJson(row) === canonicalJson(expected), 'AURA_DISCOVERY_UNVERIFIED')
    trajectories.delete(row.trajectoryId)
  }
  return { observedSurpriseScores: scores, unanchoredPredictions: registrations.size - observations.size,
    lastRollbackAgeEpochs: rollback === null ? Number.MAX_SAFE_INTEGER : epoch - rollback }
}

function auraWakeMetrics(wake, now) {
  auraRequire(auraObject(wake) && wake.ok === true && typeof wake.enabled === 'boolean' && wakeInterval(wake.intervalMs)
    && auraCount(wake.wakeCount) && auraCount(wake.consecutiveUnacknowledgedWakes) && wake.consecutiveUnacknowledgedWakes <= WAKE_UNACKNOWLEDGED_LIMIT
    && typeof wake.probePending === 'boolean' && (wake.lastWakeAt === null ? wake.wakeCount === 0 : wakeTimestamp(wake.lastWakeAt) && wake.lastWakeAt <= now)
    && (wake.enabled ? wakeTimestamp(wake.nextWakeAt) : wake.nextWakeAt === null), 'AURA_WAKE_UNKNOWN')
  // Wake-schedule lateness is overdueWakeRatio (aura-rules.mjs), the same rule the browser reader applies.
  const overdue = overdueWakeRatio(wake, now)
  auraRequire(overdue !== null, 'AURA_WAKE_UNKNOWN')
  return { pendingWakes: wake.consecutiveUnacknowledgedWakes + Number(wake.probePending), overdueWakeRatio: overdue }
}

function localAuraResult(head, now, metrics, gaps, dagLayout) {
  const complete = gaps.length === 0
  const inputs = { ...(complete ? metrics : {}), ballId: head?.ballId ?? null, epoch: head?.epoch ?? null, computedAt: now }
  const computed = complete ? computeAura(inputs) : null
  const status = !computed ? 'incomplete' : computed.vector.wakeUrgency >= 0.7 ? 'alert'
    : computed.vector.driftRisk >= 0.4 || computed.vector.coherence < 0.7 ? 'strained'
      : computed.vector.surprisePressure >= 0.3 || computed.vector.coherence < 0.95 || computed.vector.wakeUrgency > 0 ? 'attentive' : 'calm'
  const auraShadow = computeAuraFocusShadow(inputs, computed)
  return { ...(complete ? metrics : {}), auraShadow, auraFocusCell: auraFocusCellShadow(inputs, auraShadow, AURA_FOCUS_CELL), evidence: { status: complete ? 'complete' : 'incomplete', gaps, dagLayout,
    organCounts: 'declared-enabled-not-runtime-health', selectionIsNotHealthProof: true },
  aura: { schema: 'aukora.aura.v1', scorer: 'rules-v1', status, authorityTier: 'peripheral-hint', computedAt: auraCount(now) ? now : null,
    ballId: head?.ballId ?? null, epoch: head?.epoch ?? null, vector: computed?.vector ?? null,
    recommendedFocus: computed?.recommendedFocus ?? 'verify', salience: computed?.salience ?? [], gaps,
    selectionIsNotHealthProof: true, organCounts: 'declared-enabled-not-runtime-health' } }
}

/**
 * Read a bounded, coherent local mirror snapshot without writes, startup, or network access.
 * Recomputes selected-manifest, receipt, DAG and discovery hashes/bindings; no stored vector is trusted.
 * Missing, changing, unsafe, truncated or unverified input omits scorer metrics and returns an
 * incomplete summary with null axes. Counts of enabled manifest entries do not establish organ health.
 * DAG files use either dag/<id>.json or dag/nodes/<id>.json. A nodes directory selects the latter;
 * any simultaneous flat node files are ambiguous and rejected, even if one layout is incomplete.
 * @param {object} options Absolute mirrorDirectory, optional expected head, now timestamp, AbortSignal,
 * and an explicitly supplied immutable wake metadata snapshot. Absent wake metadata stays unknown.
 * Optional checkpointSignerPin/checkpointSignerPolicy come from independent host configuration, never mirror content; absent trust remains unpinned.
 * @returns {Promise<object>} Scorer metrics only when complete, plus bounded evidence, aura, a read-only focus shadow and optional recorded-source summaries.
 */
export async function readLocalAuraInputs({ mirrorDirectory, head: expectedHead, now = Date.now(), signal, wake, includeFacts = false, checkpointSignerPin, checkpointSignerPolicy }) {
  let head = null
  let dagLayout = 'unknown'
  const sources = [], directories = []
  let consumed = 0
  let sourceName = 'mirror'
  try {
    signal?.throwIfAborted()
    auraRequire(typeof mirrorDirectory === 'string' && path.isAbsolute(mirrorDirectory) && !mirrorDirectory.includes('\0')
      && mirrorDirectory.length <= 4096 && mirrorDirectory.split(path.sep).length <= 128
      && !mirrorDirectory.split(path.sep).some(part => part === '..' || part === '.'), 'AURA_DIRECTORY_INVALID')
    auraRequire(wakeTimestamp(now), 'AURA_TIME_INVALID')
    const root = path.resolve(mirrorDirectory)
    const read = async (relative, limit) => {
      sourceName = relative
      signal?.throwIfAborted()
      const file = path.join(root, relative), chain = await directoryChain(path.dirname(file))
      const source = await readBounded(file, chain, Math.min(limit, AURA_LOCAL_LIMITS.bytes - consumed), false, signal)
      auraRequire(source !== null, 'AURA_SOURCE_ABSENT')
      consumed += source.bytes.length
      sources.push({ file, chain, ...source })
      return new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
    }
    const headText = await read('balls/HEAD.json', AURA_LOCAL_LIMITS.jsonBytes)
    const selected = parseAuraJson(headText)
    verifyAuraHead(selected)
    head = selected
    auraRequire(expectedHead === undefined || (expectedHead?.ballId === head.ballId && expectedHead?.epoch === head.epoch), 'AURA_HEAD_CHANGED')
    const handoff = await read('home/auma/HANDOFF.md', AURA_LOCAL_LIMITS.nodeBytes)
    const epochMatch = /epoch\s*\|\s*\*\*(\d+)\*\*/i.exec(handoff), ballMatch = /ballId\s*\|\s*`([0-9a-f]{64})`/i.exec(handoff)
    auraRequire(epochMatch && ballMatch && auraCount(Number(epochMatch[1])), 'AURA_HANDOFF_UNKNOWN')
    const dagText = await read('home/auma/memory/dag/HEAD.json', AURA_LOCAL_LIMITS.nodeBytes), dagHead = parseAuraJson(dagText)
    const dagRelative = 'home/auma/memory/dag'
    const scanNodes = async (relative, metadataAllowed) => {
      sourceName = relative
      const file = path.join(root, relative), chain = await directoryChain(file), stat = await fsp.lstat(file)
      const directory = await fsp.opendir(file), names = []
      let hasNodes = false, hasHead = false
      try {
        for (let index = 0; ; index++) {
          signal?.throwIfAborted()
          const entry = await directory.read()
          if (entry === null) break
          auraRequire(index < AURA_LOCAL_LIMITS.files + (metadataAllowed ? 2 : 0), 'AURA_DAG_FILE_LIMIT')
          if (metadataAllowed && entry.name === 'HEAD.json') {
            auraRequire(entry.isFile(), 'AURA_DAG_PATH_REFUSED')
            hasHead = true
          } else if (metadataAllowed && entry.name === 'nodes') {
            auraRequire(entry.isDirectory(), 'AURA_DAG_PATH_REFUSED')
            hasNodes = true
          } else {
            auraRequire(entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), 'AURA_DAG_PATH_REFUSED')
            names.push(entry.name)
            auraRequire(names.length <= AURA_LOCAL_LIMITS.files, 'AURA_DAG_FILE_LIMIT')
          }
        }
      } finally { await directory.close() }
      await verifyChain(chain)
      auraRequire(sameVersion(stat, await fsp.lstat(file)) && (!metadataAllowed || hasHead), 'AURA_SNAPSHOT_CHANGED')
      directories.push({ file, chain, stat })
      return { names, hasNodes }
    }
    const flat = await scanNodes(dagRelative, true)
    auraRequire(!flat.hasNodes || flat.names.length === 0, 'AURA_DAG_LAYOUT_AMBIGUOUS')
    dagLayout = flat.hasNodes ? 'nodes' : 'flat'
    const nodeRelative = flat.hasNodes ? `${dagRelative}/nodes` : dagRelative
    const names = flat.hasNodes ? (await scanNodes(nodeRelative, false)).names : flat.names
    const nodes = []
    for (const name of names.sort()) {
      const node = parseAuraJson(await read(`${nodeRelative}/${name}`, AURA_LOCAL_LIMITS.nodeBytes))
      auraRequire(auraObject(node) && node.id === name.slice(0, -5), 'AURA_DAG_HASH_MISMATCH')
      nodes.push(node)
    }
    const receipts = verifyAuraReceipts(auraRows(await read('home/auma/seed/receipts.v3.jsonl', RECEIPT_LIMIT)))
    const facts = includeFacts ? await verifyFactCheckpoints(auraRows(await read('home/auma/seed/checkpoints.v1.jsonl', AURA_LOCAL_LIMITS.jsonBytes)), receipts, () => signal?.throwIfAborted(), { checkpointSignerPin, checkpointSignerPolicy }) : undefined
    const corpus = auraRows(await read('home/auma/seed/discovery-corpus.v1.jsonl', RECEIPT_LIMIT))
    const superagent = parseAuraJson(await read('home/auma/superagent/state.json', AURA_LOCAL_LIMITS.jsonBytes))
    const heartbeat = auraObject(superagent) ? staleHeartbeatFacts(superagent.assignments, now) : null
    auraRequire(heartbeat !== null, 'AURA_HEARTBEAT_UNKNOWN')
    const metrics = { ...verifyAuraDag(dagHead, nodes, receipts), verifiedReceipts: receipts.length, totalReceipts: receipts.length,
      activeOrgans: Object.values(head.entries).filter(entry => !entry.disabled).length, declaredOrgans: Object.keys(head.entries).length,
      handOffEpochMismatch: Number(epochMatch[1]) !== head.epoch || ballMatch[1] !== head.ballId,
      ...verifyAuraPredictions(receipts, corpus, head.epoch), ...auraWakeMetrics(wake, now) }
    // One pulse rule for both readers: stale running assignments or an overdue enabled wake schedule, whichever is worse.
    metrics.staleHeartbeatRatio = Math.max(heartbeat.staleHeartbeatRatio, metrics.overdueWakeRatio)
    sourceName = 'snapshot'
    auraRequire(await read('balls/HEAD.json', AURA_LOCAL_LIMITS.jsonBytes) === headText
      && await read('home/auma/memory/dag/HEAD.json', AURA_LOCAL_LIMITS.nodeBytes) === dagText, 'AURA_HEAD_CHANGED')
    let sourceMetadata, buildSource
    if (includeFacts) {
      try {
        const file = path.join(root, 'home/auma/seed/BUILD_INFO.json'), chain = await directoryChain(path.dirname(file))
        const source = await readBounded(file, chain, Math.min(65536, AURA_LOCAL_LIMITS.bytes - consumed), false, signal)
        sourceMetadata = projectBuildInfo(source === null ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(source.bytes))
        if (source !== null) buildSource = { file, chain, stat: source.stat }
      } catch (error) {
        signal?.throwIfAborted()
        sourceMetadata = { status: 'invalid', organSourceCommit: null }
      }
    }
    for (const source of [...sources, ...directories]) {
      signal?.throwIfAborted()
      await verifyChain(source.chain)
      auraRequire(sameVersion(source.stat, await fsp.lstat(source.file)), 'AURA_SNAPSHOT_CHANGED')
    }
    if (buildSource) {
      try {
        await verifyChain(buildSource.chain)
        if (!sameVersion(buildSource.stat, await fsp.lstat(buildSource.file))) sourceMetadata = { status: 'invalid', organSourceCommit: null }
      } catch (error) {
        signal?.throwIfAborted()
        sourceMetadata = { status: 'invalid', organSourceCommit: null }
      }
    }
    signal?.throwIfAborted()
    return { ...localAuraResult(head, now, metrics, [], dagLayout), ...(includeFacts ? { facts, sourceMetadata } : {}) }
  } catch (error) {
    const code = signal?.aborted ? 'AURA_ABORTED' : typeof error?.code === 'string' && error.code.startsWith('AURA_') ? error.code
      : error?.code === 'ENOENT' ? 'AURA_SOURCE_ABSENT' : error?.code === 'MESSAGES_FILE_TOO_LARGE' ? 'AURA_BYTE_LIMIT'
        : error?.code === 'MESSAGES_PATH_REFUSED' || error?.code === 'ELOOP' ? 'AURA_PATH_REFUSED'
          : error?.code === 'MESSAGES_PATH_CHANGED' ? 'AURA_SNAPSHOT_CHANGED' : 'AURA_SOURCE_INVALID'
    return localAuraResult(head, now, {}, [`${code}:${sourceName}`], dagLayout)
  }
}

const MESSAGE_BODY_LIMIT = 16 * 1024
const MESSAGE_BODY_DEADLINE_MS = 5000
const messageResponse = (status, payload, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
})
const rejectedRequest = (status, code, headers = {}) => ({ kind: 'rejected', status, code, headers: { Connection: 'close', ...headers } })
const stringHeader = (request, name) => typeof request.headers[name] === 'string' ? request.headers[name] : ''

function matchingCapability(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false
  const actualBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes)
}

function capabilityCookie(request) {
  const cookies = stringHeader(request, 'cookie').split(';').map(part => part.trim()).filter(part => part.startsWith('__x6_cap='))
  return cookies.length === 1 ? cookies[0].slice('__x6_cap='.length) : ''
}

/**
 * Require an actual session capability for live head events; same-origin headers alone grant none.
 * @param {object} request Node-style WebSocket upgrade request.
 * @param {URL} url Parsed upgrade URL, including the existing optional capability query.
 * @param {object} policy Expected capability, allowed origins, and host/origin validator.
 * @returns {{ok: boolean}} Whether the existing WebSocket server may admit this peer.
 */
export function authorizeLocalHeadWebSocket(request, url, { sessionCapability, allowedOrigins, verifyHostAndOrigin }) {
  const origin = `http://${stringHeader(request, 'host').trim().toLowerCase()}`
  const suppliedOrigin = stringHeader(request, 'origin').trim()
  const site = stringHeader(request, 'sec-fetch-site')
  const query = url.searchParams.getAll('cap')
  const capability = matchingCapability(stringHeader(request, 'x-x6-capability').trim(), sessionCapability)
    || matchingCapability(capabilityCookie(request), sessionCapability)
    || (query.length === 1 && matchingCapability(query[0], sessionCapability))
  return { ok: request.method === 'GET' && url.pathname === '/_head/ws'
    && verifyHostAndOrigin(request).ok && new Set(allowedOrigins).has(origin) && url.origin === origin
    && (!suppliedOrigin || suppliedOrigin === origin) && (!site || site === 'same-origin' || site === 'none') && capability }
}

/**
 * Classify the local message routes using explicit capabilities, never same-origin fallback.
 * @param {object} request Node-style request method and headers; no body is consumed.
 * @param {URL} url Parsed incoming URL.
 * @param {object} policy Expected capability, allowed origins, and existing host/origin validator.
 * @returns {object} Unhandled, rejected, status, or messages classification without any I/O.
 */
export function classifyLocalMessagesRequest(request, url, { sessionCapability, allowedOrigins, verifyHostAndOrigin }) {
  const { pathname } = url
  const statusRoute = pathname === '/__x6/status' || pathname === '/api/x61/status'
  const factsRoute = pathname === '/__x6/facts' || pathname === '/api/x61/facts'
  if (!statusRoute && !factsRoute && pathname !== '/aukora-messages' && !pathname.startsWith('/aukora-messages/')) return { kind: 'unhandled' }
  const origin = `http://${stringHeader(request, 'host').trim().toLowerCase()}`
  const suppliedOrigin = stringHeader(request, 'origin').trim()
  const site = stringHeader(request, 'sec-fetch-site')
  const hostAllowed = verifyHostAndOrigin(request).ok && allowedOrigins.has(origin) && url.origin === origin
  const originAllowed = (!suppliedOrigin || suppliedOrigin === origin) && (!site || site === 'same-origin' || site === 'none')
  const capabilityAllowed = matchingCapability(stringHeader(request, 'x-x6-capability').trim(), sessionCapability) || matchingCapability(capabilityCookie(request), sessionCapability)
  if (!hostAllowed || !originAllowed || !capabilityAllowed || (request.method === 'POST' && (suppliedOrigin !== origin || site !== 'same-origin'))) return rejectedRequest(403, 'MESSAGES_CAPABILITY_REQUIRED')
  if (url.href.includes('?') || url.href.includes('#')) return rejectedRequest(400, 'MESSAGES_QUERY_NOT_ALLOWED')
  const method = statusRoute || factsRoute || pathname === '/aukora-messages/contacts.json' ? 'GET' : ['/aukora-messages/thread', '/aukora-messages/send', '/aukora-messages/add-contact'].includes(pathname) ? 'POST' : null
  if (!method) return rejectedRequest(404, 'MESSAGES_ROUTE_NOT_FOUND')
  if (request.method !== method) return rejectedRequest(405, 'MESSAGES_METHOD_NOT_ALLOWED', { Allow: method })
  if (method === 'GET' && (request.headers['transfer-encoding'] || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) return rejectedRequest(400, 'MESSAGES_BODY_NOT_ALLOWED')
  return { kind: factsRoute ? 'facts' : statusRoute ? 'status' : 'messages', method }
}

/** Bound both declared/chunked bodies and the time spent waiting for their completion. */
function readMessagesBody(request, limit = MESSAGE_BODY_LIMIT) {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^[0-9]+$/.test(String(declared)) || !Number.isSafeInteger(Number(declared)))) return Promise.reject(failure('MESSAGES_BODY_INVALID', 400))
  if (Number(declared ?? 0) > limit) return Promise.reject(failure('MESSAGES_BODY_TOO_LARGE', 413))
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return Promise.reject(failure('MESSAGES_ENCODING_UNSUPPORTED', 415))
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const cleanup = () => {
      clearTimeout(deadline)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
    }
    const stop = (code, status) => { cleanup(); request.pause(); reject(failure(code, status)) }
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes.length > limit - size) { stop('MESSAGES_BODY_TOO_LARGE', 413); return }
      size += bytes.length
      chunks.push(bytes)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)) }
    const onError = () => stop('MESSAGES_BODY_UNAVAILABLE', 400)
    const onAborted = () => stop('MESSAGES_BODY_ABORTED', 400)
    const deadline = setTimeout(() => stop('MESSAGES_BODY_TIMEOUT', 408), MESSAGE_BODY_DEADLINE_MS)
    deadline.unref()
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
    if (request.readableEnded) onEnd()
    else if (request.destroyed || request.aborted) onAborted()
  })
}

/**
 * Construct the actual local dispatcher without importing or starting the host or reading its vault.
 * Optional readWake adds wake metadata, current-head aura and read-only Nostr status to both aliases; without it,
 * readStatus retains its original response. A freshly computed status.aura (including incomplete)
 * takes precedence over persisted wake.aura; the latter remains separately available on wake.
 * Existing status fields, including nostr, are preserved.
 * @param {object} options Storage, capability/origins, host validator, readStatus, and optional readWake.
 * @returns {Function} Async (Node request, URL) => Response, or null for unrelated routes.
 */
export function createLocalMessagesRequestHandler({ storage, sessionCapability, allowedOrigins, verifyHostAndOrigin, readStatus, readWake, readFacts }) {
  if (readWake !== undefined && typeof readWake !== 'function') throw new TypeError('LOCAL_WAKE_READER_INVALID')
  const policy = { sessionCapability, allowedOrigins: new Set(allowedOrigins), verifyHostAndOrigin }
  return async (incoming, url) => {
    const route = classifyLocalMessagesRequest(incoming, url, policy)
    if (route.kind === 'unhandled') return null
    if (route.kind === 'rejected') return messageResponse(route.status, { ok: false, code: route.code }, route.headers)
    try {
      if (route.kind === 'facts') {
        const result = readFacts ? await readFacts() : projectVerifiedFacts('local', null)
        return messageResponse(result.ok ? 200 : 503, result)
      }
      if (route.kind === 'status') {
        const status = await readStatus()
        if (readWake === undefined) return messageResponse(200, status)
        const wake = await readWake()
        const aura = validateAuraVector(wake?.aura) && wake.aura.ballId === status.head?.ballId && wake.aura.epoch === status.head?.epoch
          ? cloneState(wake.aura) : null
        const nostr = Object.hasOwn(status, 'nostr') ? status.nostr : await readMessagesStatus(storage)
        return messageResponse(200, { ...status, wake: { ...wake, aura }, aura: Object.hasOwn(status, 'aura') ? status.aura : aura, nostr })
      }
      const body = route.method === 'POST' ? await readMessagesBody(incoming) : undefined
      const headers = { 'Content-Type': stringHeader(incoming, 'content-type') }
      if (incoming.headers['idempotency-key'] !== undefined) headers['Idempotency-Key'] = stringHeader(incoming, 'idempotency-key')
      const request = new Request(url, { method: route.method, headers, ...(body === undefined ? {} : { body }) })
      return await handleMessagesRequest(request, storage, { authorized: true })
    } catch (error) {
      const bodyFailure = ['MESSAGES_BODY_INVALID', 'MESSAGES_BODY_TOO_LARGE', 'MESSAGES_ENCODING_UNSUPPORTED', 'MESSAGES_BODY_UNAVAILABLE', 'MESSAGES_BODY_ABORTED', 'MESSAGES_BODY_TIMEOUT'].includes(error.code)
      return messageResponse(bodyFailure ? error.status : 503, { ok: false, code: bodyFailure ? error.code : 'LOCAL_MESSAGES_UNAVAILABLE' }, { Connection: 'close' })
    }
  }
}

const WAKE_KEY = 'wake:v1'
const AURA_KEY = 'aura:latest'
const WAKE_RECEIPT_LIMIT = 64
const WAKE_UNACKNOWLEDGED_LIMIT = 3
const WAKE_INTERVAL_MIN = 60000
const WAKE_INTERVAL_MAX = 86400000
const wakeExecutor = () => ({ available: false, invoked: false, status: 'executor_unavailable' })
const wakeTimestamp = value => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= 8640000000000000
const wakeInterval = value => Number.isSafeInteger(value) && value >= WAKE_INTERVAL_MIN && value <= WAKE_INTERVAL_MAX
const wakeObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const wakeKeys = (value, keys) => wakeObject(value) && Object.keys(value).every(key => keys.includes(key))
const wakeRequestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const wakeEmptyState = () => ({ version: 1, enabled: false, intervalMs: WAKE_INTERVAL_MIN, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null, receipts: [], consecutiveUnacknowledgedWakes: 0, autoPaused: false })
const wakeMetadataValid = value => typeof value.wakeId === 'string' && /^[a-f0-9-]{36}$/.test(value.wakeId)
  && wakeTimestamp(value.at) && ['alarm', 'manual'].includes(value.trigger)
  && ['available', 'absent', 'unavailable'].includes(value.headStatus)
  && (value.headStatus === 'available'
    ? typeof value.headBallId === 'string' && /^[a-f0-9]{64}$/.test(value.headBallId) && Number.isSafeInteger(value.headEpoch) && !Object.is(value.headEpoch, -0) && value.headEpoch >= 0
    : value.headBallId === null && value.headEpoch === null)
  && (value.requestId === undefined || (value.trigger === 'manual' && wakeRequestId(value.requestId)))
const wakeMetadataFields = ['wakeId', 'at', 'trigger', 'headEpoch', 'headBallId', 'headStatus', 'requestId']

function validateWakeState(value) {
  if (value === undefined) return wakeEmptyState()
  const invalid = () => { throw failure('LOCAL_WAKE_STATE_CORRUPT') }
  if (!wakeKeys(value, ['version', 'enabled', 'intervalMs', 'lastWakeAt', 'lastWakeOutcome', 'wakeCount', 'nextWakeAt', 'receipts', 'pendingProbe', 'consecutiveUnacknowledgedWakes', 'autoPaused', AURA_KEY]) || value.version !== 1 || typeof value.enabled !== 'boolean' || !wakeInterval(value.intervalMs) || !Number.isSafeInteger(value.wakeCount) || value.wakeCount < 0 || !Array.isArray(value.receipts) || value.receipts.length !== Math.min(value.wakeCount, WAKE_RECEIPT_LIMIT)) invalid()
  if (value.enabled ? !wakeTimestamp(value.nextWakeAt) : value.nextWakeAt !== null) invalid()
  if (value.wakeCount === 0 ? value.lastWakeAt !== null || value.lastWakeOutcome !== null || value.receipts.length !== 0 : !wakeTimestamp(value.lastWakeAt) || value.receipts.length === 0) invalid()
  const ids = new Set()
  const requestIds = new Set()
  for (const receipt of value.receipts) {
    if (!wakeKeys(receipt, [...wakeMetadataFields, 'status', 'executor']) || !wakeMetadataValid(receipt) || ids.has(receipt.wakeId)) invalid()
    ids.add(receipt.wakeId)
    if (!isWakeProbeExecutor(receipt.executor) || receipt.status !== receipt.executor.status || ['probe_busy', 'probe_ready'].includes(receipt.status)) invalid()
    if (receipt.requestId !== undefined) {
      if (receipt.trigger !== 'manual' || !wakeRequestId(receipt.requestId) || requestIds.has(receipt.requestId)) invalid()
      requestIds.add(receipt.requestId)
    }
  }
  if (value.receipts.length && (value.receipts.at(-1).at !== value.lastWakeAt || value.receipts.at(-1).status !== value.lastWakeOutcome)) invalid()
  if (value.pendingProbe !== undefined) {
    if (!wakeKeys(value.pendingProbe, wakeMetadataFields) || !wakeMetadataValid(value.pendingProbe)) invalid()
    const retained = value.receipts.find(receipt => receipt.wakeId === value.pendingProbe.wakeId)
    if (retained && (retained !== value.receipts.at(-1) || wakeMetadataFields.some(key => retained[key] !== value.pendingProbe[key]))) invalid()
    if (!retained && value.pendingProbe.requestId !== undefined && requestIds.has(value.pendingProbe.requestId)) invalid()
  }
  const next = cloneState(value)
  if (!Object.hasOwn(value, 'consecutiveUnacknowledgedWakes') && !Object.hasOwn(value, 'autoPaused')) {
    // Legacy receipts have no acknowledgement marker: never infer operator approval from them.
    next.consecutiveUnacknowledgedWakes = Math.min(WAKE_UNACKNOWLEDGED_LIMIT, value.receipts.filter(receipt => receipt.trigger === 'alarm').length)
    next.autoPaused = next.consecutiveUnacknowledgedWakes === WAKE_UNACKNOWLEDGED_LIMIT
    if (next.autoPaused) { next.enabled = false; next.nextWakeAt = null }
  } else if (!Number.isSafeInteger(value.consecutiveUnacknowledgedWakes) || Object.is(value.consecutiveUnacknowledgedWakes, -0)
    || value.consecutiveUnacknowledgedWakes < 0 || value.consecutiveUnacknowledgedWakes > Math.min(value.wakeCount, WAKE_UNACKNOWLEDGED_LIMIT)
    || typeof value.autoPaused !== 'boolean' || value.autoPaused !== (value.consecutiveUnacknowledgedWakes === WAKE_UNACKNOWLEDGED_LIMIT)
    || (value.autoPaused && value.enabled)) invalid()
  if (Object.hasOwn(value, AURA_KEY) && value[AURA_KEY] !== null && !validateAuraVector(value[AURA_KEY])) invalid()
  return next
}

/** One outstanding asynchronous notification per owner; dropped invalidations recover by polling. */
function createLocalUpdateNotifier(callback) {
  let pending = false
  return value => {
    if (callback === undefined || pending) return
    pending = true
    try {
      const result = callback(value)
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
        Promise.resolve(result).then(() => { pending = false }, () => { pending = false })
      } else pending = false
    } catch (_error) {
      pending = false
      // Delivery failure never changes the durable operation or blocks its lifecycle.
    }
  }
}

/**
 * Deliver an already projected invalidation to authenticated sockets without affecting its ACK.
 * Closed, backpressured, or failed peers recover through polling rather than growing a send queue.
 * @param {Iterable<object>} peers Sockets admitted by the host's existing upgrade authorization.
 * @param {object} value Bounded event produced by createLocalLiveUpdates.
 * @returns {void} Each socket's send failure is isolated from the other sockets.
 */
export function broadcastLocalUpdate(peers, value) {
  const message = JSON.stringify(value)
  for (const peer of peers) {
    try {
      if (peer.readyState === 1 && !(peer.bufferedAmount > 256 * 1024)) peer.send(message, () => undefined)
    } catch (_error) { /* A lost invalidation is repaired by the client's authoritative poll. */ }
  }
}

/**
 * Attach import-safe postcommit hooks to the actual local mirror/runtime entry points.
 * A first confirmed runtime view establishes a baseline; later views discover external selections.
 * Runtime manifests do not identify a source commit, so buildSha is explicitly unknown.
 * A pending asynchronous broadcast drops further invalidations of its class until settlement; synchronous sends
 * receive every event. Neither delivery nor settlement delays ACKs, and polling repairs missed events.
 * @param {object} options Mirror publisher, runtime head, and optional best-effort broadcast callback.
 * @returns {object} publishMirror, selectRuntime, viewRuntime, and wakeUpdated hooks. No startup I/O.
 */
export function createLocalLiveUpdates({ mirrorPublisher, runtimeHead, broadcast }) {
  const notify = createLocalUpdateNotifier(broadcast)
  const notifyAura = createLocalUpdateNotifier(broadcast)
  let observedAuraWakeId = null
  let runtimeQueue = Promise.resolve()
  let observedRuntime = null
  const serializeRuntime = operation => {
    const result = runtimeQueue.then(operation)
    runtimeQueue = result.catch(() => undefined)
    return result
  }
  const observeRuntime = value => {
    const selected = value?.selected
    if (value?.ok !== true || value.writable !== true || !wakeObject(selected) || !Number.isSafeInteger(selected.epoch) || selected.epoch < 0
      || (selected.epoch === 0 ? selected.releaseId !== null || selected.recordId !== null
        : typeof selected.releaseId !== 'string' || !/^[a-f0-9]{64}$/.test(selected.releaseId) || typeof selected.recordId !== 'string' || !/^[a-f0-9]{64}$/.test(selected.recordId))) return
    if (observedRuntime !== null && selected.epoch <= observedRuntime.epoch) return
    const previous = observedRuntime
    observedRuntime = { epoch: selected.epoch, recordId: selected.recordId, releaseId: selected.releaseId }
    if (previous !== null && selected.releaseId !== null && selected.releaseId !== previous.releaseId) {
      notify({ type: 'runtime:updated', releaseId: selected.releaseId, buildSha: null })
    }
  }
  return {
    async publishMirror(envelope) {
      const result = await mirrorPublisher.publish(envelope)
      if (result.ok === true && result.replayed !== true) {
        try { notify(createMirrorUpdate(result, envelope.batch.entries.map(entry => entry[0]))) }
        catch (_error) { /* A failed projection cannot turn a durable mirror ACK into a retry. */ }
      }
      return result
    },
    viewRuntime() {
      return serializeRuntime(async () => {
        const result = await runtimeHead.view()
        observeRuntime(result)
        return result
      })
    },
    selectRuntime(input) {
      return serializeRuntime(async () => {
        try { observeRuntime(await runtimeHead.view()) }
        catch (_error) { /* Selection may recover a pending journal; the postcommit view must confirm it. */ }
        const result = await runtimeHead.select(input)
        if (result.ok === true && result.replayed === false) {
          try {
            const confirmed = await runtimeHead.view()
            if (confirmed.selected?.recordId === result.recordId && confirmed.selected?.releaseId === result.releaseId) observeRuntime(confirmed)
          } catch (_error) { /* A later authoritative view can deliver this optional invalidation. */ }
        }
        return result
      })
    },
    wakeUpdated(wake) {
      try {
        const state = validateWakeState({ version: 1, enabled: wake.enabled, intervalMs: wake.intervalMs, lastWakeAt: wake.lastWakeAt,
          lastWakeOutcome: wake.lastWakeOutcome, wakeCount: wake.wakeCount, nextWakeAt: wake.nextWakeAt, receipts: wake.receipts,
          ...(wake.consecutiveUnacknowledgedWakes === undefined ? {} : { consecutiveUnacknowledgedWakes: wake.consecutiveUnacknowledgedWakes, autoPaused: wake.autoPaused }) })
        if (!isWakeProbeExecutor(wake.executor)) return
        const { version: _version, ...metadata } = state
        const aura = validateAuraVector(wake.aura) ? cloneState(wake.aura) : null
        notify({ type: 'wake:updated', wake: { ok: wake.ok === true, ...metadata,
          executor: { available: wake.executor.available, invoked: wake.executor.invoked, status: wake.executor.status },
          aura, probePending: wake.probePending === true, selectionIsNotHealthProof: true } })
        const receipt = state.receipts.at(-1)
        if (aura && receipt && aura.computedAt === receipt.at && aura.ballId === receipt.headBallId && aura.epoch === receipt.headEpoch
          && receipt.wakeId !== observedAuraWakeId) {
          observedAuraWakeId = receipt.wakeId
          if (aura.vector.wakeUrgency >= 0.7) notifyAura({ type: 'wake.changed', aura: {
            wakeUrgency: aura.vector.wakeUrgency, recommendedFocus: aura.recommendedFocus, authorityTier: 'peripheral-hint',
          } })
        }
      } catch (_error) { /* Only bounded validated metadata may leave the wake service. */ }
    },
  }
}

/**
 * Create wake:v1 storage using the same hardened adapter as messages, in a separate fixed file.
 * @param {{directory: string}} options Private, non-replicated runtime directory.
 * @returns {{transaction: Function}} Atomic wake-only transactions; construction performs no I/O.
 */
export function createLocalWakeStorage({ directory }) {
  return createPrivateLocalStorage({ directory, key: WAKE_KEY, filename: 'wake.v1.json' })
}

/**
 * Own a disabled-by-default, metadata-only wake schedule. No model executor is installed here.
 * Optional runWakeProbe receives selected-head metadata outside storage transactions and returns
 * only a bounded outcome. Missing callbacks retain executor_unavailable. A durable pendingProbe
 * fences both optional callbacks until actual settlement; reconstruction never repeats an unknown invocation.
 * Optional readAuraInputs reads independent verification metrics under a deadline and AbortSignal,
 * with an immutable scalar wake metadata snapshot. It must not call this scheduler's queued status().
 * Without a metric reader, DAG reachability, receipt verification,
 * organ health and prediction/heartbeat history remain unknown and aura is null.
 * Aura routes attention only. Rest ticks with urgency below 0.2 persist a heartbeat without a probe.
 * Three unacknowledged automatic ticks pause the schedule. configure({enabled:true}) explicitly
 * acknowledges/resets that counter; manual ticks and interval-only changes never reset it.
 * configure({enabled:false}) is the operator kill switch. Legacy counts derive conservatively from receipts.
 * start/status load once; overdue restart schedules one immediate alarm, not missed intervals.
 * Persistence failure suspends this instance until operator recovery and a fresh construction.
 * dispose aborts immediately, cancels future callbacks, and waits for actual callback settlement.
 * Optional onUpdated receives bounded state only after durable writes; its failures are contained.
 * Only one asynchronous notification may remain pending; later invalidations rely on polling.
 * @param {object} options Storage, readHead, optional runWakeProbe/readAuraInputs and probeTimeoutMs/auraTimeoutMs, clocks, timers, and onUpdated.
 * @returns {object} start/status, configure(settings), trigger({requestId}?), and dispose promises.
 */
export function createLocalWakeScheduler({ storage, readHead, runWakeProbe, readAuraInputs, probeTimeoutMs, auraTimeoutMs, monotonicNow, onUpdated,
  now = Date.now, setTimeout: scheduleTimer = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout }) {
  const probe = createWakeProbeRunner({ runWakeProbe, timeoutMs: probeTimeoutMs, monotonicNow, setTimeout: scheduleTimer, clearTimeout: cancelTimer })
  if (readAuraInputs !== undefined && typeof readAuraInputs !== 'function') throw new TypeError('WAKE_AURA_READER_INVALID')
  const auraReader = createWakeAuraReader({ readAuraInputs: readAuraInputs === undefined ? undefined : input => readAuraInputs({ ...input,
    wake: Object.freeze({ ok: !unavailable && !disposed, enabled: state.enabled, intervalMs: state.intervalMs,
      lastWakeAt: state.lastWakeAt, wakeCount: state.wakeCount, nextWakeAt: state.nextWakeAt,
      consecutiveUnacknowledgedWakes: state.consecutiveUnacknowledgedWakes, probePending: state.pendingProbe !== undefined }) }),
    timeoutMs: auraTimeoutMs, monotonicNow, setTimeout: scheduleTimer, clearTimeout: cancelTimer })
  const notifyUpdated = createLocalUpdateNotifier(onUpdated)
  let state = wakeEmptyState()
  let initialized = false
  let unavailable = null
  let disposed = false
  let timer = null
  let generation = 0
  let queue = Promise.resolve()
  let claimCleanup = Promise.resolve()

  const clearTimer = () => {
    generation += 1
    if (timer !== null) { cancelTimer(timer); timer = null }
  }
  const suspend = (code = 'LOCAL_WAKE_STORAGE_UNAVAILABLE') => { unavailable = code; clearTimer() }
  const clock = () => {
    let at
    try { at = now() }
    catch (error) { throw failure('LOCAL_WAKE_CLOCK_UNAVAILABLE') }
    if (!wakeTimestamp(at) || !wakeTimestamp(at + WAKE_INTERVAL_MAX)) throw failure('LOCAL_WAKE_CLOCK_UNAVAILABLE')
    return at
  }
  const view = () => ({
    ok: !unavailable && !disposed,
    ...((unavailable || disposed) ? { code: disposed ? 'LOCAL_WAKE_DISPOSED' : unavailable } : {}),
    enabled: state.enabled && !unavailable && !disposed, intervalMs: state.intervalMs,
    lastWakeAt: state.lastWakeAt, lastWakeOutcome: state.lastWakeOutcome, wakeCount: state.wakeCount,
    nextWakeAt: unavailable || disposed ? null : state.nextWakeAt,
    receipts: cloneState(state.receipts),
    consecutiveUnacknowledgedWakes: state.consecutiveUnacknowledgedWakes, autoPaused: state.autoPaused,
    aura: validateAuraVector(state[AURA_KEY]) ? cloneState(state[AURA_KEY]) : null,
    executor: state.pendingProbe !== undefined ? { available: true, invoked: false, status: 'probe_busy' }
      : probe.available ? { available: true, invoked: false, status: 'probe_ready' } : wakeExecutor(),
    probePending: state.pendingProbe !== undefined, selectionIsNotHealthProof: true,
  })
  const persist = async incoming => {
    try {
      await storage.transaction(async transaction => {
        const stored = validateWakeState(await transaction.get(WAKE_KEY))
        if (JSON.stringify(stored) !== JSON.stringify(state)) throw failure('LOCAL_WAKE_STATE_CHANGED')
        await transaction.put(WAKE_KEY, incoming)
      })
      state = incoming
    } catch (error) { suspend(); throw failure('LOCAL_WAKE_STORAGE_UNAVAILABLE') }
  }
  const initialize = async () => {
    if (initialized) return
    initialized = true
    try {
      state = await storage.transaction(async transaction => validateWakeState(await transaction.get(WAKE_KEY)))
    } catch (error) { suspend(); throw failure('LOCAL_WAKE_STORAGE_UNAVAILABLE') }
    if (state.pendingProbe !== undefined) {
      suspend('LOCAL_WAKE_PROBE_RECOVERY_REQUIRED')
      throw failure('LOCAL_WAKE_PROBE_RECOVERY_REQUIRED')
    }
    armTimer()
  }
  const enqueue = operation => {
    const result = queue.then(async () => {
      if (disposed) throw failure('LOCAL_WAKE_DISPOSED')
      if (unavailable) throw failure(unavailable)
      await initialize()
      return operation()
    }).catch(error => {
      if (error.code === 'LOCAL_WAKE_CLOCK_UNAVAILABLE' || error.code === 'LOCAL_WAKE_TIMER_UNAVAILABLE') suspend(error.code)
      throw error
    })
    queue = result.catch(() => undefined)
    return result
  }
  const recordWake = async (trigger, requestId) => {
    if (requestId !== undefined) {
      const previous = state.receipts.find(receipt => receipt.requestId === requestId)
      if (previous) return { ...view(), receipt: cloneState(previous), replayed: true }
    }
    if (state.pendingProbe !== undefined || probe.busy || auraReader.busy) throw failure('LOCAL_WAKE_PROBE_BUSY', 409)
    if (state.wakeCount === Number.MAX_SAFE_INTEGER) throw failure('LOCAL_WAKE_COUNT_EXHAUSTED', 409)
    const at = clock()
    let headBallId = null
    let headEpoch = null
    let headStatus = 'unavailable'
    try {
      const head = await readHead()
      if (head === null) headStatus = 'absent'
      else if (wakeObject(head) && typeof head.ballId === 'string' && /^[a-f0-9]{64}$/.test(head.ballId) && Number.isSafeInteger(head.epoch) && !Object.is(head.epoch, -0) && head.epoch >= 0) {
        headBallId = head.ballId
        headEpoch = head.epoch
        headStatus = 'available'
      }
    } catch (error) { /* The receipt reports that selected-head metadata could not be read. */ }
    const metadata = { wakeId: crypto.randomUUID(), at, trigger, headEpoch, headBallId, headStatus, ...(requestId === undefined ? {} : { requestId }) }
    const head = headStatus === 'available' ? { ballId: headBallId, epoch: headEpoch } : null
    let aura = null
    let executor = wakeExecutor()
    if (probe.available || (auraReader.available && head !== null)) {
      // Persist admission with unknown aura before either optional reader/probe can execute.
      await persist({ ...state, pendingProbe: metadata, [AURA_KEY]: aura })
      clearTimer()
    }
    try {
      aura = await auraReader.read({ head, now: at })
      if (auraReader.busy) {
        // An aborted reader may still be running; never stack optional probe work behind it.
        executor = { available: true, invoked: false, status: disposed ? 'probe_cancelled' : 'probe_timeout' }
      } else if (aura?.recommendedFocus === 'rest' && aura.vector.wakeUrgency < 0.2) {
        executor = { available: probe.available, invoked: false, status: 'probe_skipped_rest' }
      } else if (probe.available) executor = await probe.run({ head, now: at })
    } catch (error) {
      // Setup failed before invocation. Retain the claim on any uncertain callback outcome.
      if (!probe.busy && !auraReader.busy && state.pendingProbe !== undefined) {
        const next = { ...state }
        delete next.pendingProbe
        await persist(next)
      }
      suspend('LOCAL_WAKE_PROBE_UNAVAILABLE')
      throw failure('LOCAL_WAKE_PROBE_UNAVAILABLE')
    }
    const receipt = { ...metadata, status: executor.status, executor }
    const consecutiveUnacknowledgedWakes = Math.min(WAKE_UNACKNOWLEDGED_LIMIT, state.consecutiveUnacknowledgedWakes + (trigger === 'alarm' ? 1 : 0))
    const autoPaused = consecutiveUnacknowledgedWakes === WAKE_UNACKNOWLEDGED_LIMIT
    const enabled = state.enabled && !autoPaused
    const next = { ...state, enabled, consecutiveUnacknowledgedWakes, autoPaused,
      lastWakeAt: at, lastWakeOutcome: receipt.status, wakeCount: state.wakeCount + 1, [AURA_KEY]: aura,
      nextWakeAt: enabled ? trigger === 'alarm' ? clock() + state.intervalMs : state.nextWakeAt : null,
      receipts: [...state.receipts, receipt].slice(-WAKE_RECEIPT_LIMIT) }
    if (!probe.busy && !auraReader.busy) delete next.pendingProbe
    await persist(next)
    notifyUpdated(view())
    if (state.pendingProbe !== undefined) {
      claimCleanup = Promise.all([probe.whenSettled(), auraReader.whenSettled()]).then(() => {
        const cleanup = queue.then(async () => {
          if (unavailable || state.pendingProbe?.wakeId !== metadata.wakeId) return
          const settled = { ...state }
          delete settled.pendingProbe
          await persist(settled)
          notifyUpdated(view())
          armTimer()
        })
        queue = cleanup.catch(() => undefined)
        return cleanup
      }).catch(error => { suspend(typeof error.code === 'string' && error.code.startsWith('LOCAL_WAKE_') ? error.code : 'LOCAL_WAKE_PROBE_UNAVAILABLE') })
    } else if (probe.available || auraReader.available) armTimer()
    return { ...view(), receipt: cloneState(receipt), replayed: false }
  }
  function armTimer() {
    clearTimer()
    if (disposed || unavailable || !state.enabled || state.pendingProbe !== undefined) return
    const observedGeneration = generation
    try {
      timer = scheduleTimer(() => {
        if (disposed || unavailable || observedGeneration !== generation) return Promise.resolve(view())
        // Consume this callback before enqueueing, so repeated delivery cannot create another wake.
        clearTimer()
        const deliveredGeneration = generation
        return enqueue(async () => {
          if (deliveredGeneration !== generation || !state.enabled) return view()
          if (state.nextWakeAt > clock()) { armTimer(); return view() }
          const result = await recordWake('alarm')
          armTimer()
          return result
        }).catch(error => { if (!disposed) suspend(typeof error.code === 'string' && error.code.startsWith('LOCAL_WAKE_') ? error.code : 'LOCAL_WAKE_UNAVAILABLE'); return view() })
      }, Math.max(0, state.nextWakeAt - clock()))
      if (timer !== null && typeof timer.unref === 'function') timer.unref()
    } catch (error) {
      suspend(error.code === 'LOCAL_WAKE_CLOCK_UNAVAILABLE' ? error.code : 'LOCAL_WAKE_TIMER_UNAVAILABLE')
      throw failure(unavailable)
    }
  }

  return {
    start() { return enqueue(view).catch(error => view()) },
    status() { return enqueue(view).catch(error => view()) },
    configure(settings) {
      if (!wakeKeys(settings, ['enabled', 'intervalMs']) || Object.keys(settings).length === 0 || (Object.hasOwn(settings, 'enabled') && typeof settings.enabled !== 'boolean') || (Object.hasOwn(settings, 'intervalMs') && !wakeInterval(settings.intervalMs))) return Promise.reject(failure('LOCAL_WAKE_CONFIG_INVALID', 400))
      return enqueue(async () => {
        const enabled = settings.enabled ?? state.enabled
        const intervalMs = settings.intervalMs ?? state.intervalMs
        const consecutiveUnacknowledgedWakes = settings.enabled === true ? 0 : state.consecutiveUnacknowledgedWakes
        const autoPaused = settings.enabled === true ? false : state.autoPaused
        if (enabled === state.enabled && intervalMs === state.intervalMs && consecutiveUnacknowledgedWakes === state.consecutiveUnacknowledgedWakes && autoPaused === state.autoPaused) return view()
        const nextWakeAt = enabled ? clock() + intervalMs : null
        clearTimer()
        await persist({ ...state, enabled, intervalMs, nextWakeAt, consecutiveUnacknowledgedWakes, autoPaused })
        notifyUpdated(view())
        armTimer()
        return view()
      })
    },
    trigger(options = {}) {
      if (!wakeKeys(options, ['requestId']) || (Object.hasOwn(options, 'requestId') && !wakeRequestId(options.requestId))) return Promise.reject(failure('LOCAL_WAKE_REQUEST_ID_INVALID', 400))
      return enqueue(() => recordWake('manual', options.requestId))
    },
    dispose() {
      disposed = true
      clearTimer()
      const settled = Promise.all([probe.dispose(), auraReader.dispose()])
      return Promise.all([queue, settled]).then(() => claimCleanup).then(() => queue).then(() => undefined)
    },
  }
}

/**
 * Authenticate wake requests before reading bodies, schedules, or selected-head metadata.
 * @param {object} request Node-style request method and headers.
 * @param {URL} url Parsed incoming URL.
 * @param {object} policy Exact host/origins and real session capability; query caps are refused.
 * @returns {object} Unhandled, rejected, or authenticated wake classification without I/O.
 */
export function classifyLocalWakeRequest(request, url, { sessionCapability, allowedOrigins, verifyHostAndOrigin }) {
  if (url.pathname !== '/_host/wake' && !url.pathname.startsWith('/_host/wake/')) return { kind: 'unhandled' }
  const origin = `http://${stringHeader(request, 'host').trim().toLowerCase()}`
  const suppliedOrigin = stringHeader(request, 'origin').trim()
  const site = stringHeader(request, 'sec-fetch-site')
  const hostAllowed = verifyHostAndOrigin(request).ok && allowedOrigins.has(origin) && url.origin === origin
  const originAllowed = (!suppliedOrigin || suppliedOrigin === origin) && (!site || site === 'same-origin' || site === 'none')
  const capabilityAllowed = matchingCapability(stringHeader(request, 'x-x6-capability').trim(), sessionCapability) || matchingCapability(capabilityCookie(request), sessionCapability)
  if (!hostAllowed || !originAllowed || !capabilityAllowed || (request.method === 'POST' && (suppliedOrigin !== origin || site !== 'same-origin'))) return rejectedRequest(403, 'LOCAL_WAKE_CAPABILITY_REQUIRED')
  if (url.href.includes('?') || url.href.includes('#')) return rejectedRequest(400, 'LOCAL_WAKE_QUERY_NOT_ALLOWED')
  if (url.pathname !== '/_host/wake') return rejectedRequest(404, 'LOCAL_WAKE_ROUTE_NOT_FOUND')
  if (!['GET', 'POST'].includes(request.method)) return rejectedRequest(405, 'LOCAL_WAKE_METHOD_NOT_ALLOWED', { Allow: 'GET, POST' })
  if (request.method === 'GET' && (request.headers['transfer-encoding'] || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) return rejectedRequest(400, 'LOCAL_WAKE_BODY_NOT_ALLOWED')
  return { kind: 'wake', method: request.method }
}

/**
 * Construct the wake dispatcher without importing the local host or reading credentials.
 * @param {object} options Wake scheduler and the same explicit capability policy as messages.
 * @returns {Function} Async (Node request, URL) => Response, or null for unrelated routes.
 */
export function createLocalWakeRequestHandler({ wake, sessionCapability, allowedOrigins, verifyHostAndOrigin }) {
  const policy = { sessionCapability, allowedOrigins: new Set(allowedOrigins), verifyHostAndOrigin }
  return async (incoming, url) => {
    const route = classifyLocalWakeRequest(incoming, url, policy)
    if (route.kind === 'unhandled') return null
    if (route.kind === 'rejected') return messageResponse(route.status, { ok: false, code: route.code }, route.headers)
    try {
      if (route.method === 'GET') {
        const result = await wake.status()
        return messageResponse(result.ok ? 200 : 503, result)
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(stringHeader(incoming, 'content-type'))) throw failure('LOCAL_WAKE_CONTENT_TYPE_REQUIRED', 415)
      const bytes = await readMessagesBody(incoming, 1024)
      let body
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch (error) { throw failure('LOCAL_WAKE_JSON_INVALID', 400) }
      if (!wakeObject(body)) throw failure('LOCAL_WAKE_ACTION_INVALID', 400)
      const requestId = incoming.headers['idempotency-key']
      if (requestId !== undefined && !wakeRequestId(requestId)) throw failure('LOCAL_WAKE_REQUEST_ID_INVALID', 400)
      if (body.action === 'configure' && wakeKeys(body, ['action', 'enabled', 'intervalMs']) && requestId === undefined) {
        const { action, ...settings } = body
        return messageResponse(200, await wake.configure(settings))
      }
      if (body.action === 'trigger' && wakeKeys(body, ['action'])) return messageResponse(200, await wake.trigger(requestId === undefined ? {} : { requestId }))
      throw failure('LOCAL_WAKE_ACTION_INVALID', 400)
    } catch (error) {
      const bodyFailure = ['MESSAGES_BODY_INVALID', 'MESSAGES_BODY_TOO_LARGE', 'MESSAGES_ENCODING_UNSUPPORTED', 'MESSAGES_BODY_UNAVAILABLE', 'MESSAGES_BODY_ABORTED', 'MESSAGES_BODY_TIMEOUT'].includes(error.code)
      const known = typeof error.code === 'string' && error.code.startsWith('LOCAL_WAKE_')
      return messageResponse(bodyFailure || known ? error.status : 503, { ok: false, code: bodyFailure ? error.code.replace('MESSAGES_', 'LOCAL_WAKE_') : known ? error.code : 'LOCAL_WAKE_UNAVAILABLE' }, { Connection: 'close' })
    }
  }
}
