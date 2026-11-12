// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * PURE VERDICT for the fresh-window cold-boot observer (deploy/ci/observe-fresh-x61.mjs).
 *
 * No I/O, no clock, no network: it reads only the observation records the observer wrote and returns a verdict.
 * It lives under deploy/ (a T2 path, deploy/cloudflare/src/cloud-brokers.mjs isT2ProtectedRepoPath) because a CI job
 * that holds the owner credential executes it; a T1 commit must not be able to soften it.
 *
 * Every field read here is produced by the observer from a source-cited endpoint:
 *   head      GET /__x6/status       deploy/cloudflare/src/head-do.mjs:1293-1298 ({ head: { ballId, epoch } })
 *   facts     GET /__x6/facts        deploy/cloudflare/src/head-do.mjs:1284-1291, server/verified-facts.mjs:393-417
 *             (receiptTotal, receiptsVerified, checkpointsTotal, lastCheckpointSeq, lastCheckpointReceiptCount,
 *             checkpointSignerTrust). Facts that are not complete (503 / ok:false) FAIL: a broken receipt or checkpoint
 *             chain surfaces only that way.
 *             merkleRoot: every usable context must carry the same 64-hex receipt Merkle root. A missing root, the
 *             string 'unavailable', or any non-hex value FAILS (MERKLE_ROOT_UNAVAILABLE): a green run must prove memory,
 *             not merely report that it could not. (When this was written no endpoint exposed the root:
 *             verified-facts.mjs:348 checks body.merkleRoot internally and the projection omits it. Until the edge projects
 *             it, this verdict fails closed by design.)
 *   workspace the active workspace chip the page shows after cold boot; it must read exactly 'auma' in every context
 *             (a second fresh window that lands on no workspace or a cloud-session workspace FAILS WORKSPACE_NOT_AUMA).
 *   headSocket the head WebSocket (/_head/ws) as the observer resolved it; state must be exactly 'open'
 *             (closed, connecting, missing or unobserved FAILS HEAD_SOCKET_NOT_OPEN). Lane E3: 'open' must also be
 *             frame-backed by a witness the record carries: page { state: 'open', open > 0 } (or the same fields at the
 *             top level, as headSocketState records them) or runtime { state: 'open', framesReceived + framesSent > 0 }
 *             (her worker's own GET /__x6__/status report). A bare or zero-frame 'open' claim FAILS ('open-unproven').
 *   runtime   __DSH_TRANSPORT__.fetch('/__x6__/status') in the page
 *             (webworker-runtime/src/client/index.ts:160, src/x6/ball-loader.ts:3155-3183, 5085-5089):
 *             ballId, epoch, persistence (src/storage/idb-persist.ts:377-414), mutation (ball-loader.ts:540-551, 1199).
 *   surfaces  real Spatial launchers (packages/client/ui-layout/src/client/spatial/portal/menus.tsx).
 *
 * Allowlist entries must name a justification; an entry without one is refused, never silently applied.
 */

export const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit'])
export const CONTEXTS = Object.freeze(['A', 'B'])
/** Surface ids as AppFrame's data-surface-active reports them (AppFrame.tsx:500). */
export const REQUIRED_SURFACES = Object.freeze(['messages', 'media', 'identity', 'aumlok', 'settings'])
const FACT_COUNTS = Object.freeze(['receiptTotal', 'receiptsVerified', 'checkpointsTotal', 'lastCheckpointSeq', 'lastCheckpointReceiptCount'])
const ALLOW_KINDS = new Set(['console', 'request', 'http'])

/**
 * Explicit allowlist of diagnostics that do not fail the run. Empty on purpose: nothing on x6.1 is known to be
 * harmless boot noise yet. Add an entry only with a written justification, in a T2 commit.
 * Shape: { id, kind: 'console'|'request'|'http', pattern: string (RegExp source), justification, engines?: string[] }
 */
export const DEFAULT_ALLOWLIST = Object.freeze([])

/** Validate allowlist entries; throws ALLOWLIST_INVALID on any entry that is not explicit and justified. */
export function compileAllowlist(list) {
  if (!Array.isArray(list)) throw new Error('ALLOWLIST_INVALID')
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9-]{3,64}$/.test(entry.id)
      || !ALLOW_KINDS.has(entry.kind) || typeof entry.pattern !== 'string' || entry.pattern.length < 4
      || typeof entry.justification !== 'string' || entry.justification.trim().length < 20
      || (entry.engines !== undefined && (!Array.isArray(entry.engines) || entry.engines.some((e) => !ENGINES.includes(e))))) {
      throw new Error('ALLOWLIST_INVALID')
    }
    return { ...entry, re: new RegExp(entry.pattern) }
  })
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0
/** A receipt Merkle root the verdict accepts as proof: lowercase or uppercase SHA-256 hex, nothing else. */
const isMerkleRoot = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
/** The only workspace a fresh owner window may land on. */
export const REQUIRED_WORKSPACE = 'auma'
const isId = (value) => typeof value === 'string' && /^[0-9a-f]{16,128}$/i.test(value)

function allowed(rules, kind, engine, text) {
  return rules.some((rule) => rule.kind === kind && (!rule.engines || rule.engines.includes(engine)) && rule.re.test(text))
}

/** Text the allowlist matches for a failed request or an HTTP error row. */
export function requestText(row) {
  return `${row?.method ?? '?'} ${row?.path ?? '?'} ${row?.status ?? row?.failure ?? ''}`.trim()
}

/** One value shared by every context, or a mismatch listing each context's value. */
function agree(observations, pick) {
  const values = observations.map((o) => ({ where: `${o.engine}/${o.context}`, value: pick(o) }))
  const distinct = [...new Set(values.map((v) => JSON.stringify(v.value)))]
  return distinct.length === 1 ? { ok: true, value: values[0]?.value } : { ok: false, values }
}

/** A non-negative safe integer frame counter, else 0. */
const frames = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

/**
 * Whether an 'open' head socket is backed by a frame-carrying witness: the page capture (open sockets > 0, recorded at the
 * top level by headSocketState or under .page by resolveHeadSocket) or her worker's own report under .runtime.
 * @param {any} hs The context's headSocket record.
 * @returns {boolean}
 */
export function headSocketProven(hs) {
  if (!hs || typeof hs !== 'object') return false
  const pageProof = (p) => !!p && typeof p === 'object' && p.state === 'open' && frames(p.open) > 0
  const runtimeProof = (r) => !!r && typeof r === 'object' && r.state === 'open' && frames(r.framesReceived) + frames(r.framesSent) > 0
  return pageProof(hs) || pageProof(hs.page) || runtimeProof(hs.runtime)
}

/**
 * Decide PASS or FAIL for one observer run.
 * @param {object[]} observations One record per engine x context, as observe-fresh-x61.mjs writes them.
 * @param {{ allowlist?: object[], turn?: boolean, expectedBuildSha?: string|null }} options
 * @returns {{ pass: boolean, failures: {code: string, where: string, detail?: unknown}[], consensus: object, unavailable: string[] }}
 */
export function verdict(observations, { allowlist = DEFAULT_ALLOWLIST, turn = false, expectedBuildSha = null } = {}) {
  const rules = compileAllowlist(allowlist)
  const failures = []
  const unavailable = []
  const fail = (code, where, detail) => failures.push(detail === undefined ? { code, where } : { code, where, detail })
  const list = Array.isArray(observations) ? observations.filter((o) => o && typeof o === 'object') : []

  // Coverage: exactly one record per engine and context.
  for (const engine of ENGINES) for (const context of CONTEXTS) {
    const n = list.filter((o) => o.engine === engine && o.context === context).length
    if (n !== 1) fail(n === 0 ? 'CONTEXT_MISSING' : 'CONTEXT_DUPLICATED', `${engine}/${context}`)
  }
  for (const o of list) if (!ENGINES.includes(o.engine) || !CONTEXTS.includes(o.context)) fail('CONTEXT_UNKNOWN', `${o.engine}/${o.context}`)

  const usable = []
  for (const o of list) {
    const where = `${o.engine}/${o.context}`
    if (typeof o.fatal === 'string') { fail('CONTEXT_FATAL', where, o.fatal); continue }
    if (o.signedIn !== true) { fail('SIGN_IN_FAILED', where); continue }
    if (o.appReady !== true) { fail('APP_NOT_READY', where); continue }
    usable.push(o)

    if (o.health?.status !== 200 || o.health?.ok !== true || o.health?.ready !== true) fail('HEALTH_NOT_READY', where, o.health ?? null)
    if (expectedBuildSha && o.health?.buildSha !== expectedBuildSha) fail('BUILD_MISMATCH', where, o.health?.buildSha ?? null)

    if (o.head?.status !== 200 || !isId(o.head?.ballId) || !Number.isSafeInteger(o.head?.epoch) || o.head.epoch < 1) {
      fail('HEAD_UNAVAILABLE', where, o.head ?? null)
    }
    // The receipt and checkpoint chain is part of what this check proves. /__x6/facts answers 503 { ok: false } whenever
    // the evidence snapshot is incomplete, and that includes a broken ledger: a Merkle-root, signature or checkpoint-chain
    // failure throws AURA_CHECKPOINT_INVALID (server/verified-facts.mjs:15,348,357,360), mirror-do.mjs:943-945 turns it into
    // an incomplete snapshot, projectVerifiedFacts sets ok=false (verified-facts.mjs:394,398) and head-do.mjs:1291 answers 503.
    // The projection drops the reason code, so a context without complete facts FAILS; it is never filed as unavailable.
    if (o.facts?.status !== 200 || o.facts?.ok !== true) {
      fail('FACTS_UNAVAILABLE', where, { status: o.facts?.status ?? null, ok: o.facts?.ok ?? null, attempts: o.facts?.attempts ?? null })
    } else {
      if (o.facts.ballId !== o.head?.ballId || o.facts.epoch !== o.head?.epoch) fail('FACTS_HEAD_DIVERGED', where)
      // Complete facts always carry these counts: mirror-do.mjs:924 sets both receipt totals to receipts.length,
      // verified-facts.mjs:375,400-401 project them, head-do.mjs:863-869 validates them before projection.
      for (const key of ['receiptTotal', 'receiptsVerified', 'checkpointsTotal']) if (!isCount(o.facts[key])) fail('FACTS_INVALID', where, key)
      // The edge verifies every receipt it counts (mirror-do.mjs:924), so the two totals must be equal.
      if (isCount(o.facts.receiptTotal) && o.facts.receiptsVerified !== o.facts.receiptTotal) {
        fail('FACTS_RECEIPTS_UNVERIFIED', where, { receiptTotal: o.facts.receiptTotal, receiptsVerified: o.facts.receiptsVerified })
      }
      // The last-checkpoint fields are null exactly when there is no checkpoint (verified-facts.mjs:375-376).
      for (const key of ['lastCheckpointSeq', 'lastCheckpointReceiptCount']) {
        const none = o.facts.checkpointsTotal === 0
        if (none ? o.facts[key] !== null : !isCount(o.facts[key])) fail('FACTS_INVALID', where, key)
      }
      // A checkpoint signed by a key other than the configured one, or an unparsable pin (verified-facts.mjs:378-382,407).
      if (o.facts.checkpointSignerTrust === 'mismatch' || o.facts.checkpointSignerTrust === 'invalid-pin') {
        fail('FACTS_SIGNER_UNTRUSTED', where, o.facts.checkpointSignerTrust)
      }
      // Merkle root, per context, so one context without proof cannot hide behind the others. A context whose facts are
      // incomplete already failed FACTS_UNAVAILABLE and is not double-reported here.
      if (!isMerkleRoot(o.facts.merkleRoot)) {
        fail('MERKLE_ROOT_UNAVAILABLE', where, typeof o.facts.merkleRoot === 'string' ? o.facts.merkleRoot.slice(0, 80) : (o.facts.merkleRoot ?? null))
      }
    }

    const rt = o.runtime
    if (rt?.available !== true) fail('RUNTIME_STATUS_UNAVAILABLE', where, rt?.reason ?? null)
    else {
      if (rt.ballId !== o.head?.ballId || rt.epoch !== o.head?.epoch) fail('RUNTIME_HEAD_DIVERGED', where, { runtime: [rt.ballId, rt.epoch], edge: [o.head?.ballId, o.head?.epoch] })
      const p = rt.persistence ?? {}
      if (!Array.isArray(p.quarantinedPaths)) fail('PERSISTENCE_UNOBSERVABLE', where, 'quarantinedPaths')
      else if (p.quarantinedPaths.length) fail('PERSISTENCE_QUARANTINED', where, p.quarantinedPaths.slice(0, 10))
      const pending = { localPendingPaths: p.localPendingPaths, pendingBatches: p.pendingBatches, pendingBytes: p.pendingBytes,
        deferredJournals: p.deferredJournals }
      for (const [key, value] of Object.entries(pending)) {
        if (!isCount(value)) fail('PERSISTENCE_UNOBSERVABLE', where, key)
        else if (value !== 0) fail('PERSISTENCE_PENDING', where, { [key]: value })
      }
      if (p.sending === true || p.resyncPending === true) fail('PERSISTENCE_PENDING', where, { sending: p.sending, resyncPending: p.resyncPending })
      if (p.conflict != null || p.mirrorConflict != null || p.reconciliationRequired === true) fail('PERSISTENCE_CONFLICT', where)
      if (p.localError != null || p.mirrorError != null || p.transient != null) fail('PERSISTENCE_ERROR', where, { local: p.localError ?? null, mirror: p.mirrorError ?? null, transient: p.transient ?? null })
      if (p.durable !== true || p.readOnly === true) fail('PERSISTENCE_NOT_DURABLE', where, { durable: p.durable, readOnly: p.readOnly })
      if (typeof p.target !== 'string' || !p.target) fail('MIRROR_TARGET_MISSING', where)
      if (rt.mutation && rt.mutation.remoteSaved === false) fail('PERSISTENCE_REMOTE_UNSAVED', where, rt.mutation.ballId ?? null)
      if (rt.idle !== true) fail('PERSISTENCE_NOT_IDLE', where)
    }

    // Default workspace: the chip must read exactly 'auma'. Missing, empty, padded or any other value fails closed.
    const chip = o.workspace?.chip
    if (chip !== REQUIRED_WORKSPACE) fail('WORKSPACE_NOT_AUMA', where, typeof chip === 'string' ? chip.slice(0, 80) : (chip ?? null))
    // Head socket: the live /_head/ws connection must be observed open. Anything else (closed, closing, connecting,
    // a numeric readyState, missing) fails closed; a page that cannot hear head changes cannot prove recall.
    const socketState = o.headSocket?.state
    if (socketState !== 'open') fail('HEAD_SOCKET_NOT_OPEN', where, typeof socketState === 'string' ? socketState.slice(0, 40) : (socketState ?? null))
    else if (!headSocketProven(o.headSocket)) fail('HEAD_SOCKET_NOT_OPEN', where, 'open-unproven')

    const reached = new Map((Array.isArray(o.surfaces) ? o.surfaces : []).map((s) => [s?.id, s]))
    for (const id of REQUIRED_SURFACES) {
      const s = reached.get(id)
      if (!s || s.reachable !== true) fail('SURFACE_UNREACHABLE', where, { id, active: s?.active ?? null, error: s?.error ?? null })
    }

    for (const text of Array.isArray(o.consoleErrors) ? o.consoleErrors : []) {
      if (!allowed(rules, 'console', o.engine, String(text))) fail('CONSOLE_ERROR', where, String(text).slice(0, 300))
    }
    if (!Array.isArray(o.consoleErrors)) fail('DIAGNOSTICS_UNOBSERVED', where, 'consoleErrors')
    for (const row of Array.isArray(o.failedRequests) ? o.failedRequests : []) {
      if (!allowed(rules, 'request', o.engine, requestText(row))) fail('REQUEST_FAILED', where, requestText(row))
    }
    if (!Array.isArray(o.failedRequests)) fail('DIAGNOSTICS_UNOBSERVED', where, 'failedRequests')
    for (const row of Array.isArray(o.httpErrors) ? o.httpErrors : []) {
      if (!allowed(rules, 'http', o.engine, requestText(row))) fail('HTTP_ERROR', where, requestText(row))
    }
    if (!Array.isArray(o.httpErrors)) fail('DIAGNOSTICS_UNOBSERVED', where, 'httpErrors')

    if (turn) {
      const t = o.turn ?? {}
      if (o.context === 'A' && !(t.typed === true && t.markerHere === true && t.settled === true && typeof t.threadId === 'string')) {
        fail('TURN_NOT_COMPLETED', where, { typed: t.typed ?? null, markerHere: t.markerHere ?? null, settled: t.settled ?? null })
      }
      if (o.context === 'B') {
        if (t.markerThere !== true) fail('TURN_NOT_RESTORED', where)
        if (t.modelRequests !== 0) fail('TURN_RESTORE_SPENT_MODEL', where, t.modelRequests ?? null)
      }
    }
  }

  // Cross-context identity: every usable context must see the same head.
  const consensus = { epoch: null, ballId: null, merkleRoot: 'unavailable' }
  if (usable.length) {
    const epoch = agree(usable, (o) => o.head?.epoch ?? null)
    const ballId = agree(usable, (o) => o.head?.ballId ?? null)
    if (epoch.ok) consensus.epoch = epoch.value; else fail('HEAD_EPOCH_MISMATCH', 'all', epoch.values)
    if (ballId.ok) consensus.ballId = ballId.value; else fail('HEAD_BALLID_MISMATCH', 'all', ballId.values)

    // Contexts without complete facts already failed FACTS_UNAVAILABLE above; the rest must agree with each other.
    const withFacts = usable.filter((o) => o.facts?.status === 200 && o.facts?.ok === true)
    if (withFacts.length) {
      for (const key of FACT_COUNTS) {
        const same = agree(withFacts, (o) => o.facts[key] ?? null)
        if (same.ok) consensus[key] = same.value; else fail('FACTS_MISMATCH', 'all', { key, values: same.values })
      }
    }
    // Every usable context already failed MERKLE_ROOT_UNAVAILABLE or FACTS_UNAVAILABLE above without a hex root; 'unavailable' is
    // reported here for the record but is never a passing state.
    // Only complete facts can vouch for a root; an incomplete snapshot's root is never consensus material.
    const roots = withFacts.filter((o) => isMerkleRoot(o.facts.merkleRoot))
    if (roots.length === 0) unavailable.push('merkleRoot')
    else {
      if (roots.length !== withFacts.length) fail('MERKLE_ROOT_PARTIAL', 'all')
      const same = agree(roots, (o) => o.facts.merkleRoot.toLowerCase())
      if (same.ok) consensus.merkleRoot = same.value; else fail('MERKLE_ROOT_MISMATCH', 'all', same.values)
    }
    if (usable.every((o) => o.runtime?.mutation == null)) unavailable.push('remoteSaved (no mutation in a fresh window)')
  }

  return { pass: failures.length === 0, failures, consensus, unavailable }
}
