const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DAG_DIR = '/dsh/home/auma/memory/dag'
const DAG_HEAD = path.join(DAG_DIR, 'HEAD.json')
const PRED_LOG = '/dsh/home/auma/seed/predict/predictions.jsonl'
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CONTEXT_MD = '/dsh/home/auma/seed/CONTEXT.md'
const CONTEXT_UNVERIFIED_MD = '/dsh/home/auma/seed/CONTEXT.unverified.md'
const CORPUS = '/dsh/home/auma/seed/discovery-corpus.v1.jsonl'
const LEGACY_CORPUS = '/dsh/home/auma/seed/discovery-corpus.v1.unverified.jsonl'
const PROMOTIONS = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Canonical JSON: sorted keys, no whitespace, undefined keys dropped.
// The DAG's addressing convention (measured, not assumed): node id = sha256(canonicalJson(node
// WITHOUT its own `id` field)). The id cannot be part of its own preimage. Hashing raw file
// bytes or the whole node fails for every healthy node — that was my error, not corruption.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']'
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

// Recall compares against the receipt chain. A receipt row is trusted only inside an intact
// chain: seq 1..n, each prevHash naming the previous leaf, each leafHash = sha256(0x00 || canonical row).
function loadReceiptChain() {
  let rows
  if (!fs.existsSync(RECEIPTS)) return { intact: true, receipts: [] }
  try {
    const text = fs.readFileSync(RECEIPTS, 'utf8')
    rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (_) {
    return { intact: false, receipts: [], reason: 'RECEIPTS_UNREADABLE' }
  }
  let prev = '0'.repeat(64)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const payload = Object.assign({}, row)
    delete payload.leafHash
    const leaf = crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload), 'utf8')])).digest('hex')
    if (!row || row.schema !== 'aukora.receipt.v3' || row.seq !== i + 1 || row.prevHash !== prev || row.leafHash !== leaf || !row.data || typeof row.data !== 'object') {
      return { intact: false, receipts: [], reason: 'RECEIPT_CHAIN_BROKEN', failedSeq: i + 1 }
    }
    prev = row.leafHash
  }
  return { intact: true, receipts: rows }
}

// A node is anchored when a verified `memory.dag.append` leaf names it, agrees with any content it
// records, and the node's own receiptHash (the leaf it was written after) precedes that anchor.
function dagAnchorOf(node, receipts) {
  const append = receipts.find((r) => r.kind === 'memory.dag.append' && (r.data.nodeId === node.id || r.data.id === node.id))
  if (!append) return { anchored: false, reason: 'NO_APPEND_LEAF' }
  if ((append.data.content !== undefined && append.data.content !== node.content) || (append.data.summary !== undefined && append.data.summary !== node.summary)) {
    return { anchored: false, reason: 'APPEND_LEAF_CONTENT_MISMATCH' }
  }
  if (node.receiptHash !== undefined && node.receiptHash !== null && !receipts.some((r) => r.leafHash === node.receiptHash && r.seq < append.seq)) {
    return { anchored: false, reason: 'RECEIPT_CONTEXT_NOT_BEFORE_ANCHOR' }
  }
  return { anchored: true, seq: append.seq, leafHash: append.leafHash }
}

// The discovery corpus, derived only from verified leaves: register -> promotion of that exact target
// -> observe, bound by predictionId, target and metric. Same rows as prediction.ts projectDiscoveryCorpus
// and server/messages-store.mjs verifyAuraPredictions.
function receiptTrajectories(receipts) {
  const valid = (data, amount) => data && typeof data.predictionId === 'string' && data.predictionId.length > 0 && data.predictionId.length <= 200 &&
    typeof data.targetBallId === 'string' && /^[0-9a-f]{64}$/.test(data.targetBallId) && Number.isSafeInteger(data.targetEpoch) && data.targetEpoch >= 0 &&
    typeof data.metric === 'string' && data.metric.length > 0 && data.metric.length <= 80 &&
    typeof data[amount] === 'number' && Number.isFinite(data[amount]) && !Object.hasOwn(data, 'surpriseScore')
  const out = []
  const used = new Set()
  for (const reg of receipts.filter((r) => r.kind === 'prediction.register')) {
    if (!valid(reg.data, 'expected')) continue
    const obs = receipts.find((r) => r.kind === 'prediction.observe' && r.seq > reg.seq && r.data.predictionId === reg.data.predictionId)
    if (!obs || !valid(obs.data, 'observed') || ['targetBallId', 'targetEpoch', 'metric'].some((k) => obs.data[k] !== reg.data[k])) continue
    const promotion = receipts.find((r) => PROMOTIONS.has(r.kind) && r.seq > reg.seq && r.seq < obs.seq && r.data.ballId === reg.data.targetBallId && r.data.epoch === reg.data.targetEpoch)
    if (!promotion || typeof promotion.data.parentBallId !== 'string') continue
    let epochBefore = null
    for (const r of receipts) {
      if (r.seq >= promotion.seq || r.data.ballId !== promotion.data.parentBallId || !Number.isSafeInteger(r.data.epoch)) continue
      epochBefore = r.data.epoch
    }
    if (epochBefore === null || epochBefore >= reg.data.targetEpoch) continue
    const delta = Math.abs(obs.data.observed - reg.data.expected)
    const surpriseScore = delta === 0 ? 0 : delta / Math.max(Math.abs(reg.data.expected), 1)
    const trajectoryId = reg.leafHash + ':' + promotion.leafHash + ':' + obs.leafHash
    if (used.has(trajectoryId)) continue
    used.add(trajectoryId)
    out.push({
      trajectoryId, pearlId: reg.data.targetBallId, epochBefore, epochAfter: reg.data.targetEpoch,
      predicted: reg.data.expected, observed: obs.data.observed, surpriseScore,
      registerReceiptHash: reg.leafHash, promotionReceiptHash: promotion.leafHash, observeReceiptHash: obs.leafHash,
      exceptionRuleCandidate: surpriseScore > 0,
      metric: reg.data.metric, observedSeq: obs.seq,
    })
  }
  out.sort((a, b) => (a.trajectoryId < b.trajectoryId ? -1 : a.trajectoryId > b.trajectoryId ? 1 : 0))
  return out
}

function textOf(node) {
  const parts = []
  for (const key of ['text', 'fact', 'content', 'note', 'summary', 'title']) {
    if (typeof node[key] === 'string') parts.push(node[key])
  }
  if (typeof node.tags === 'object' && node.tags) parts.push(Object.values(node.tags).join(' '))
  return parts.join(' ')
}

// Content-addressing check: a node is only trusted if sha256(file bytes) === its filename.
function loadVerifiedNodes() {
  const verified = []
  const rejected = []
  let head = null
  try {
    head = JSON.parse(fs.readFileSync(DAG_HEAD, 'utf8'))
  } catch (_) {
    return { verified, rejected, head: null }
  }
  let files = []
  try {
    files = fs.readdirSync(DAG_DIR).filter((f) => f.endsWith('.json') && f !== 'HEAD.json')
  } catch (_) {
    return { verified, rejected, head }
  }
  for (const file of files) {
    const full = path.join(DAG_DIR, file)
    try {
      const raw = fs.readFileSync(full)
      const node = JSON.parse(raw.toString('utf8'))
      const expected = file.replace(/\.json$/, '')
      const claimed = node && typeof node.id === 'string' ? node.id : null
      const body = Object.assign({}, node)
      delete body.id
      const digest = sha256(canonicalJson(body))
      // Two independent checks: the recomputed digest must equal the filename AND the node's
      // own claimed id. A node whose id disagrees with its content is rejected, not trusted.
      if (digest !== expected || claimed !== expected) {
        rejected.push({ file, reason: 'HASH_MISMATCH', digest, claimedId: claimed ? claimed.slice(0, 16) : null })
        continue
      }
      verified.push({ id: expected, file, node, text: textOf(node), updatedAt: node.updatedAt || node.at || node.createdAt || 0 })
    } catch (error) {
      rejected.push({ file, reason: 'UNREADABLE', error: String(error && error.message) })
    }
  }
  return { verified, rejected, head }
}

// Earlier predictions live only in predictions.jsonl, never in the receipt chain: they are kept and
// shown as legacy history, never counted as verified.
function loadLegacyTrajectories() {
  let lines = []
  try {
    lines = fs.readFileSync(PRED_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch (_) {
    return []
  }
  const registers = lines.filter((r) => r.kind === 'prediction.register' && typeof r.targetBallId !== 'string')
  const observes = lines.filter((r) => r.kind === 'prediction.observe')
  const out = []
  for (const reg of registers) {
    const obs = observes.filter((o) => o.predictionHash === reg.predictionHash).pop()
    if (!obs) continue
    out.push({
      predictionHash: reg.predictionHash,
      prediction: reg.prediction || '',
      predicted: { epoch: reg.expectedEpoch, organCount: reg.expectedOrganCount, entry: reg.expectedEntry, rollbackDepth: reg.expectedPreviousCount, confidence: reg.confidence },
      observed: { epoch: obs.headEpoch, organCount: obs.headOrganCount, ballId: obs.headBallId },
      epochBefore: reg.headEpoch,
      epochAfter: obs.headEpoch,
      surpriseScore: obs.surpriseScore,
      misses: obs.misses || [],
      exceptionRuleCandidate: obs.exceptionRuleCandidate === true,
      sealedAt: reg.at,
      observedAt: obs.at,
    })
  }
  return out
}

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
}

const CARRIER_TRUST = { "recall-index": 0.86, epilogue: 0.84, handoff: 0.8 }

function factKey(text) {
  return sha256(String(text || "").toLowerCase().replace(/[`*_#>|]+/g, " ").replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim().slice(0, 180))
}

function loadCarrierRows() {
  const rows = []
  const push = (kind, file, line, text, epoch, at) => {
    if (!text || tokens(text).length < 4) return
    rows.push({
      id: "carrier:" + kind + ":" + sha256(file + ":" + line).slice(0, 16),
      sourceKind: "carrier-file", carrierKind: kind, path: file, carrierLine: line,
      carrierEpoch: epoch, receiptSeq: null, receiptPath: null,
      trust: CARRIER_TRUST[kind] || 0.8, text, at,
    })
  }
  const scan = (kind, file, epochOf) => {
    let st
    try { st = fs.statSync(file) } catch (error) { return }
    let inFence = false
    const epoch = epochOf ? epochOf(file) : null
    fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("```")) { inFence = !inFence; return }
      if (inFence) return
      if (kind === "recall-index") {
        if (!trimmed.startsWith("|") || /^\|\s*-+/.test(trimmed) || /\|\s*key\s*\|/.test(trimmed)) return
        const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean)
        if (cells.length < 3) return
        push(kind, file, index + 1, cells[0] + " - " + cells[2] + " (probe: " + cells.slice(3).join(" ; ") + ")", Number(cells[1]) || null, st.mtimeMs)
        return
      }
      if (!trimmed || trimmed.startsWith("|")) return
      push(kind, file, index + 1, trimmed.replace(/^[#>*-\s]+/, ""), epoch, st.mtimeMs)
    })
  }
  scan("handoff", "/dsh/home/auma/HANDOFF.md", null)
  scan("recall-index", "/dsh/home/auma/index/RECALL.md", null)
  try {
    const dir = "/dsh/home/auma/memory"
    fs.readdirSync(dir).sort().forEach((name) => {
      if (!/^epilogue-.*\.md$/.test(name)) return
      scan("epilogue", dir + "/" + name, (f) => { const m = /epilogue-(\d+)/.exec(f); return m ? Number(m[1]) : null })
    })
  } catch (error) {}
  return rows
}

function dedupeHits(hits) {
  const byKey = new Map()
  for (const hit of hits) {
    const key = factKey(hit.text)
    const current = byKey.get(key)
    if (!current) { byKey.set(key, hit); continue }
    const hasDag = current.sourceKind === "dag-receipt" || hit.sourceKind === "dag-receipt"
    const winner = hasDag
      ? (current.sourceKind === "dag-receipt" ? current : hit)
      : (current.at >= hit.at ? current : hit)
    const loser = winner === current ? hit : current
    winner.alsoSeenIn = (winner.alsoSeenIn || []).concat([{
      sourceKind: loser.sourceKind, path: loser.path || null,
      receiptSeq: loser.receiptSeq == null ? null : loser.receiptSeq,
      carrierLine: loser.carrierLine == null ? null : loser.carrierLine,
    }])
    byKey.set(key, winner)
  }
  return Array.from(byKey.values())
}

function relevance(text, queryTokens) {
  if (!queryTokens.length) return 0
  const hay = new Set(tokens(text))
  let hits = 0
  for (const q of queryTokens) if (hay.has(q)) hits += 1
  return hits
}

// Deterministic ranking: relevance first, then NON-ZERO surprise (lessons), then recency, then id.
function compare(a, b) {
  if (b.relevance !== a.relevance) return b.relevance - a.relevance
  const aSurprise = a.surpriseScore > 0 ? 1 : 0
  const bSurprise = b.surpriseScore > 0 ? 1 : 0
  if (bSurprise !== aSurprise) return bSurprise - aSurprise
  const aT = Number(a.at) || 0
  const bT = Number(b.at) || 0
  if (bT !== aT) return bT - aT
  const aTrust = typeof a.trust === "number" ? a.trust : 1
  const bTrust = typeof b.trust === "number" ? b.trust : 1
  if (bTrust !== aTrust) return bTrust - aTrust
  return String(a.id).localeCompare(String(b.id))
}

function recallBrief(query, options) {
  const opts = options || {}
  const maxMemories = Number.isInteger(opts.maxMemories) ? opts.maxMemories : 5
  const maxSurprises = Number.isInteger(opts.maxSurprises) ? opts.maxSurprises : 5
  const qTokens = tokens(query)
  const { verified, rejected, head } = loadVerifiedNodes()
  const chain = loadReceiptChain()
  const receipts = chain.intact ? chain.receipts : []
  const dag = verified.map((v) => ({ ...v, anchor: chain.intact ? dagAnchorOf(v.node, receipts) : { anchored: false, reason: chain.reason } }))
  const anchoredNodes = dag.filter((v) => v.anchor.anchored)
  const unanchoredNodes = dag.filter((v) => !v.anchor.anchored)
  const trajectories = chain.intact ? receiptTrajectories(receipts) : []
  const inTrajectory = new Set(trajectories.flatMap((t) => [t.registerReceiptHash, t.observeReceiptHash]))
  const unanchoredPredictionLeaves = receipts.filter((r) => (r.kind === 'prediction.register' || r.kind === 'prediction.observe') && !inTrajectory.has(r.leafHash))
  const legacy = loadLegacyTrajectories()
  const declared = head && Number.isInteger(head.count) ? head.count : null
  const unanchoredCount = unanchoredNodes.length + rejected.length + unanchoredPredictionLeaves.length + (chain.intact ? 0 : 1)

  const memories = anchoredNodes.map((v) => ({
    id: v.id,
    relevance: relevance(v.text, qTokens),
    surpriseScore: 0,
    at: v.updatedAt,
    text: v.text.slice(0, 400),
    anchorSeq: v.anchor.seq,
  }))
  const lessons = trajectories.map((t) => ({
    id: t.trajectoryId,
    relevance: relevance(t.metric + ' ' + t.pearlId, qTokens),
    surpriseScore: t.surpriseScore,
    at: t.observedSeq,
    text: `${t.metric} on ball ${t.pearlId.slice(0, 12)} (epoch ${t.epochBefore} -> ${t.epochAfter}): predicted ${t.predicted}, observed ${t.observed}`,
  }))
  const dagHits = memories.map((m) => ({
    ...m, sourceKind: "dag-receipt", carrierKind: null, path: null, carrierLine: null,
    receiptSeq: m.anchorSeq, receiptPath: "/dsh/home/auma/seed/receipts.v3.jsonl",
    trust: 1, anchored: true, carrierEpoch: null,
  })).concat(lessons.map((l) => ({
    ...l, sourceKind: "dag-receipt", carrierKind: null, path: null, carrierLine: null,
    receiptSeq: null, receiptPath: "/dsh/home/auma/seed/receipts.v3.jsonl",
    trust: 1, anchored: false, carrierEpoch: null,
  })))
  const carrierRows = loadCarrierRows()
  const carrierHits = carrierRows.map((row) => ({
    id: row.id, relevance: relevance(row.text, qTokens), surpriseScore: 0, at: row.at,
    text: row.text.slice(0, 400), sourceKind: "carrier-file", carrierKind: row.carrierKind,
    path: row.path, carrierLine: row.carrierLine, carrierEpoch: row.carrierEpoch,
    receiptSeq: null, receiptPath: null, trust: row.trust, anchored: false,
  })).filter((hit) => hit.relevance > 0 && hit.receiptSeq === null)
  const pool = dedupeHits(dagHits.concat(carrierHits)).sort(compare)
  const carrierFileCount = new Set(carrierRows.map((row) => row.path)).size
  const highSurprise = lessons.filter((l) => l.surpriseScore > 0).sort(compare).slice(0, maxSurprises)

  return {
    ok: true,
    query: query || null,
    receiptChain: chain.intact ? { intact: true, receipts: receipts.length } : { intact: false, reason: chain.reason, failedSeq: chain.failedSeq || null },
    dagHead: head && head.heads ? head.heads[0] || null : null,
    dagCountField: declared,
    verifiedNodeCount: verified.length,
    anchoredNodeCount: anchoredNodes.length,
    rejectedNodeCount: rejected.length,
    rejected: rejected.slice(0, 5),
    unanchoredNodes: unanchoredNodes.slice(0, 8).map((v) => ({ id: v.id, reason: v.anchor.reason })),
    trajectoryCount: trajectories.length,
    verifiedTrajectoryCount: trajectories.length,
    unanchoredPredictionLeaves: unanchoredPredictionLeaves.map((r) => ({ seq: r.seq, kind: r.kind, predictionId: r.data.predictionId || null })),
    legacyTrajectoryCount: legacy.length,
    unanchoredCount,
    allDagNodesAnchored: declared !== null && anchoredNodes.length === declared && unanchoredNodes.length === 0 && rejected.length === 0,
    highSurpriseCount: lessons.filter((l) => l.surpriseScore > 0).length,
    highSurpriseLessons: highSurprise,
    recallSources: {
      dagReceipt: pool.filter((h) => h.sourceKind === "dag-receipt").length,
      carrierFile: pool.filter((h) => h.sourceKind === "carrier-file").length,
      carrierFilesRead: carrierFileCount,
      carrierKinds: Object.keys(CARRIER_TRUST),
      invariant: "sourceKind carrier-file implies receiptSeq === null",
    },
    relevantMemories: pool.slice(0, maxMemories),
    legacyLessons: legacy.filter((t) => t.surpriseScore > 0).slice(0, maxSurprises).map((t) => ({ id: t.predictionHash, surpriseScore: t.surpriseScore, text: t.prediction.slice(0, 220) })),
  }
}

function renderContext(brief, clean) {
  const lines = []
  lines.push(clean ? '# CONTEXT.md — mechanical recall brief (receipt-anchored)' : '# CONTEXT.unverified.md — mechanical recall brief (NOT VERIFIED)')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString()} by seed-recall. Query: ${brief.query ? JSON.stringify(brief.query) : '(none)'}`)
  lines.push('')
  if (clean) {
    lines.push(`Every memory node and trajectory below is anchored by a verified leaf in receipts.v3.jsonl (${brief.receiptChain.receipts} leaves, chain intact). ` +
      'Anchored means recorded in her own receipt chain; it is not owner approval and not proof the content is true.')
  } else {
    lines.push(`**${brief.unanchoredCount} item(s) are not anchored by a verified receipt leaf**, so this brief is not clean. ` +
      'Recall still lists only anchored items; the gaps are named below.')
  }
  lines.push('')
  lines.push('## Memory DAG')
  lines.push('')
  lines.push(`- head: \`${brief.dagHead || 'none'}\``)
  lines.push(`- nodes verified by sha256 == filename: **${brief.verifiedNodeCount}** of ${brief.dagCountField === null ? '?' : brief.dagCountField} declared`)
  lines.push(`- nodes anchored by a memory.dag.append leaf: **${brief.anchoredNodeCount}**`)
  lines.push(`- nodes rejected: **${brief.rejectedNodeCount}**${brief.rejected.length ? ' — ' + JSON.stringify(brief.rejected) : ''}`)
  if (brief.unanchoredNodes.length) lines.push(`- unanchored: ${JSON.stringify(brief.unanchoredNodes)}`)
  lines.push(`- receipt-anchored trajectories: **${brief.trajectoryCount}** (high-surprise: ${brief.highSurpriseCount})`)
  if (brief.unanchoredPredictionLeaves.length) lines.push(`- prediction leaves outside any trajectory: ${JSON.stringify(brief.unanchoredPredictionLeaves)}`)
  lines.push(`- legacy predictions (earlier, never receipt-anchored, kept in discovery-corpus.v1.unverified.jsonl): ${brief.legacyTrajectoryCount}`)
  lines.push('')
  lines.push('## High-surprise lessons (do not repeat)')
  lines.push('')
  if (!brief.highSurpriseLessons.length) lines.push('- none recorded in the receipt chain')
  for (const lesson of brief.highSurpriseLessons) {
    lines.push(`- **surprise ${lesson.surpriseScore}** — ${lesson.text.slice(0, 220)}`)
  }
  lines.push('')
  lines.push('## Ranked recall (anchored only)')
  lines.push('')
  if (!brief.relevantMemories.length) lines.push('- nothing anchored to recall')
  for (const memory of brief.relevantMemories) {
    lines.push(`- [rel ${memory.relevance}] \`${String(memory.id).slice(0, 12)}…\` ${memory.text.slice(0, 200)}`)
  }
  lines.push('')
  return lines.join('\n')
}

function writeContext(brief) {
  const clean = brief.unanchoredCount === 0 && brief.allDagNodesAnchored && brief.receiptChain.intact
  fs.mkdirSync(path.dirname(CONTEXT_MD), { recursive: true })
  if (clean) {
    const text = renderContext(brief, true)
    fs.writeFileSync(CONTEXT_MD, text, 'utf8')
    return { clean, path: CONTEXT_MD, sha256: sha256(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text) }
  }
  const text = renderContext(brief, false)
  fs.writeFileSync(CONTEXT_UNVERIFIED_MD, text, 'utf8')
  // Never leave an older clean brief standing beside a failed check.
  const pointer = `# CONTEXT.md — not verified\n\nThe last recall at ${new Date().toISOString()} found ${brief.unanchoredCount} unanchored item(s). ` +
    'See CONTEXT.unverified.md.\n'
  fs.writeFileSync(CONTEXT_MD, pointer, 'utf8')
  return { clean, path: CONTEXT_UNVERIFIED_MD, sha256: sha256(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text) }
}

// The verified corpus: exactly the receipt-derived rows the readers recompute (discoveryJsonl key order).
function exportCorpus() {
  const chain = loadReceiptChain()
  if (!chain.intact) return { ok: false, error: 'RECEIPT_CHAIN_BROKEN', failedSeq: chain.failedSeq || null }
  const rows = receiptTrajectories(chain.receipts).map((t) => ({
    trajectoryId: t.trajectoryId, pearlId: t.pearlId, epochBefore: t.epochBefore, epochAfter: t.epochAfter,
    predicted: t.predicted, observed: t.observed, surpriseScore: t.surpriseScore,
    registerReceiptHash: t.registerReceiptHash, promotionReceiptHash: t.promotionReceiptHash, observeReceiptHash: t.observeReceiptHash,
    exceptionRuleCandidate: t.exceptionRuleCandidate,
  }))
  fs.mkdirSync(path.dirname(CORPUS), { recursive: true })
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  fs.writeFileSync(CORPUS, body, 'utf8')
  return { ok: true, path: CORPUS, count: rows.length, sha256: sha256(Buffer.from(body, 'utf8')), legacyKeptAt: LEGACY_CORPUS }
}

module.exports = {
  name: 'seed-recall',
  description:
    'Unified recall over the three stores (receipt-verified). Verifies every memory DAG node by sha256 == filename AND by a ' +
    'verified memory.dag.append leaf in receipts.v3.jsonl, derives the discovery corpus only from verified prediction.register -> promotion -> ' +
    'prediction.observe leaves, and ranks anchored items against a query with non-zero surprise first. context writes CONTEXT.md only when nothing ' +
    'is unanchored (otherwise CONTEXT.unverified.md); corpus exports discovery-corpus.v1.jsonl in the readers\' exact row format.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recall', 'context', 'corpus', 'status'] },
      query: { type: 'string' },
      maxMemories: { type: 'number' },
      maxSurprises: { type: 'number' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  run(args) {
    const action = args && args.action
    const query = args && typeof args.query === 'string' ? args.query : null
    const options = {
      maxMemories: args && Number.isInteger(args.maxMemories) ? args.maxMemories : 5,
      maxSurprises: args && Number.isInteger(args.maxSurprises) ? args.maxSurprises : 5,
    }

    if (action === 'recall' || action === 'status') {
      return recallBrief(query, options)
    }

    if (action === 'context') {
      const brief = recallBrief(query, options)
      const written = writeContext(brief)
      return { ok: true, action, ...written, unanchoredCount: brief.unanchoredCount, brief }
    }

    if (action === 'corpus') {
      return { action, ...exportCorpus() }
    }

    return { ok: false, error: 'UNKNOWN_ACTION', action: action || null }
  },
}
