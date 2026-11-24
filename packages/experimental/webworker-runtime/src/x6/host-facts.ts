/**
 * `x6_host_facts`: what her host says about her, read-only and bounded.
 *
 * Three same-origin GETs through the existing session, never a model-supplied URL:
 *   - `GET /_head/promotion-status`  her head, lease, governance promotion policy, staged candidate, last publish outcome;
 *   - `GET /_host/aumlok/status`     her identity binding: phase, blockers, counts;
 *   - `GET /__x6/facts`              verified receipt, checkpoint and aura facts.
 * Each answer is projected through an ALLOWLIST: only named fields of known shapes survive. The staged envelope (manifest
 * and module code, most of the ~57 KB of promotion-status), public keys, AUMLOK ids and key commitments are never
 * returned. Each source has its own byte ceiling and deadline, and a failure is a code for that source alone. Nothing
 * is written: no VFS write, no POST, no cache. The result carries `voiceAuthority: 'none'` and `mutating: false`.
 * @module x6/host-facts
 */

export const HOST_FACTS_SCHEMA = 'aukora.host-facts.v1' as const
export const HOST_FACTS_SECTIONS = Object.freeze(['promotion', 'aumlok', 'facts'] as const)
export type HostFactsSection = typeof HOST_FACTS_SECTIONS[number]

export const HOST_FACTS_SOURCES: Readonly<Record<HostFactsSection, { path: string; maxBytes: number }>> = Object.freeze({
  // The raw page carries the staged manifest and module code; it is read under a ceiling and then mostly dropped.
  promotion: Object.freeze({ path: '/_head/promotion-status', maxBytes: 512 * 1024 }),
  aumlok: Object.freeze({ path: '/_host/aumlok/status', maxBytes: 64 * 1024 }),
  facts: Object.freeze({ path: '/__x6/facts', maxBytes: 64 * 1024 }),
})
export const HOST_FACTS_TIMEOUT_MS = 4000
/** Ceiling on the projected answer the tool returns. */
export const HOST_FACTS_RESULT_BYTES = 16 * 1024

type Json = Record<string, unknown>
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const SHA = /^[a-f0-9]{64}$/
const SHORT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const CODE = /^[A-Z0-9_]{1,80}$/
const WORD = /^[a-z0-9][a-z0-9._:-]{0,79}$/i
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/

const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
const epochOf = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= -1 ? Number(value) : undefined
const sha = (value: unknown): string | undefined => typeof value === 'string' && SHA.test(value) ? value : undefined
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
const time = (value: unknown): number | string | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value)
  : typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? value : undefined
const codes = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && CODE.test(item)).slice(0, 16) : undefined
const word = (value: unknown): string | undefined => typeof value === 'string' && WORD.test(value) ? value : undefined

/** Drop `undefined` so the projection says only what was read. */
function defined(value: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

/** promotion-status -> head, lease, policy, staged summary (never the envelope), last outcome, peer count. */
export function projectPromotionStatus(raw: unknown): Json | null {
  if (!record(raw) || raw.ok !== true) return null
  const lease = record(raw.lease)
    ? defined({ held: true, generation: count(raw.lease.generation), expiresAt: time(raw.lease.expiresAt) })
    : { held: false }
  const stagedOf = (value: unknown): Json | null => {
    if (!record(value) || !sha(value.ballId)) return null
    const changed = Array.isArray(value.changedEntries) ? value.changedEntries : Array.isArray(value.entryIds) ? value.entryIds : undefined
    return defined({
      ballId: value.ballId, epoch: epochOf(value.epoch), parentBallId: sha(value.parentBallId), state: word(value.state),
      stagedAt: time(value.stagedAt), stagedForOwner: bool(value.stagedForOwner),
      bindingPresent: value.binding === undefined ? undefined : value.binding !== null,
      changedEntries: changed?.filter((item): item is string => typeof item === 'string' && ID.test(item)).slice(0, 16),
      tier: value.tier === 'T1' || value.tier === 'T2' ? value.tier : undefined,
      t2Reasons: codes(value.t2Reasons),
      governanceClass: value.governanceClass === 1 || value.governanceClass === 3 ? value.governanceClass : undefined,
      organSetCount: record(value.organSet) && Array.isArray(value.organSet.organs) ? value.organSet.organs.length : undefined,
    })
  }
  // The producer's own shape (head-do.mjs `head:last-publish-outcome`): candidate*, expected*, resulting*, never ballId/epoch.
  const last = raw.lastPublishOutcome
  const outcome = record(last) ? defined({
    ok: bool(last.ok), code: typeof last.code === 'string' && CODE.test(last.code) ? last.code : undefined, status: count(last.status),
    at: time(last.at),
    candidateBallId: sha(last.candidateBallId), candidateEpoch: epochOf(last.candidateEpoch),
    expectedParentBallId: sha(last.expectedParentBallId), expectedEpoch: epochOf(last.expectedEpoch),
    resultingBallId: sha(last.resultingBallId), resultingEpoch: epochOf(last.resultingEpoch),
    ownerSessionApproved: bool(last.ownerSessionApproved), hasApprovalToken: bool(last.hasApprovalToken),
  }) : null
  return defined({
    ballId: sha(raw.ballId) ?? null, epoch: epochOf(raw.epoch), lease,
    governancePromotion: bool(raw.governancePromotion), governancePromotionPolicy: word(raw.governancePromotionPolicy),
    governancePromotionBlocker: typeof raw.governancePromotionBlocker === 'string' && CODE.test(raw.governancePromotionBlocker) ? raw.governancePromotionBlocker : undefined,
    staged: stagedOf(raw.staged), supersededStaged: stagedOf(raw.supersededStaged), lastPublishOutcome: outcome,
    peers: Array.isArray(raw.peers) ? raw.peers.length : undefined,
  })
}

/** aumlok status -> binding phase, blockers and counts. Public keys, ids and commitments are never returned. */
export function projectAumlokStatus(raw: unknown): Json | null {
  if (!record(raw) || raw.ok !== true) return null
  const invite = record(raw.invite) ? defined({ issuedThisMonth: count(raw.invite.issuedThisMonth), limit: count(raw.invite.limit),
    revokedCount: count(raw.invite.revokedCount), lifetimeIssuedCount: count(raw.invite.lifetimeIssuedCount) }) : undefined
  return defined({
    phase: raw.phase === 'BOUND' || raw.phase === 'UNBOUND' ? raw.phase : undefined, bound: bool(raw.bound), passkeyVerified: bool(raw.passkeyVerified),
    boundAt: time(raw.boundAt), lastVerifiedAt: time(raw.lastVerifiedAt),
    enrollmentCount: count(raw.enrollmentCount), rotationSeq: count(raw.rotationSeq),
    pepperSeparated: bool(raw.pepperSeparated), pepperMigrationRequired: bool(raw.pepperMigrationRequired),
    authorityAvailable: bool(raw.authorityAvailable), enrollmentAvailable: bool(raw.enrollmentAvailable),
    approvedGrantCount: Array.isArray(raw.approvedGrants) ? raw.approvedGrants.length : undefined,
    blockers: codes(raw.blockers), phraseBlockers: codes(raw.phraseBlockers), invite,
  })
}

/** __x6/facts -> verified counts and statuses (the same allowlist the runtime's x6_facts uses). */
export function projectX6Facts(raw: unknown): Json | null {
  if (!record(raw) || raw.ok !== true) return null
  const out: Json = {}
  for (const key of ['epoch', 'organCount', 'activeOrganCount', 'receiptTotal', 'receiptsVerified', 'checkpointsTotal', 'lastCheckpointSeq',
    'lastCheckpointReceiptCount', 'dagReachable', 'dagDeclared', 'revision', 'moduleCount']) {
    if (raw[key] === null || count(raw[key]) !== undefined) out[key] = raw[key]
  }
  for (const key of ['ballId', 'parentBallId', 'sourceRevision', 'organSourceCommit', 'runtimeArtifactSha256']) {
    if (typeof raw[key] === 'string' && SHORT_SHA.test(raw[key])) out[key] = raw[key]
  }
  for (const key of ['evidenceStatus', 'auraStatus', 'checkpointSignerTrust', 'receiptVerification', 'checkpointVerification']) {
    if (typeof raw[key] === 'string' && /^[a-z0-9-]{1,64}$/.test(raw[key])) out[key] = raw[key]
  }
  return out
}

const PROJECT: Readonly<Record<HostFactsSection, (raw: unknown) => Json | null>> = Object.freeze({
  promotion: projectPromotionStatus, aumlok: projectAumlokStatus, facts: projectX6Facts,
})

export interface HostFactsDeps {
  /** The worker's own origin; never a tool argument. */
  readonly origin: string | undefined
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

/** One bounded same-origin GET, parsed, or a fixed code. */
async function readSource(section: HostFactsSection, deps: HostFactsDeps): Promise<Json> {
  const { path, maxBytes } = HOST_FACTS_SOURCES[section]
  const origin = deps.origin
  if (!origin || origin === 'null') return { ok: false, code: 'HOST_FACTS_ORIGIN_UNAVAILABLE', source: path }
  const doFetch = deps.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, HOST_FACTS_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await doFetch(new URL(path, origin).href, { method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
      cache: 'no-store', signal: controller.signal })
    if (!response.ok) return { ok: false, code: response.status === 401 || response.status === 403 ? 'HOST_FACTS_UNAUTHORIZED' : 'HOST_FACTS_HTTP', status: response.status, source: path }
    if (Number(response.headers.get('content-length')) > maxBytes) return { ok: false, code: 'HOST_FACTS_BYTE_LIMIT', source: path }
    if (!response.body) return { ok: false, code: 'HOST_FACTS_EMPTY', source: path }
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) return { ok: false, code: 'HOST_FACTS_BYTE_LIMIT', source: path }
      text += decoder.decode(next.value, { stream: true })
    }
    const projected = PROJECT[section](JSON.parse(text + decoder.decode()))
    return projected === null ? { ok: false, code: 'HOST_FACTS_INVALID', source: path } : { ok: true, source: path, ...projected }
  } catch {
    return { ok: false, code: controller.signal.aborted ? 'HOST_FACTS_TIMEOUT' : 'HOST_FACTS_UNAVAILABLE', source: path }
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) void reader.cancel().catch(() => undefined)
  }
}

/**
 * Read the requested sections in parallel. Never throws; never writes.
 * @param sections - a subset of `HOST_FACTS_SECTIONS`; anything else is refused by name.
 */
export async function readHostFacts(sections: unknown, deps: HostFactsDeps): Promise<Json> {
  const asked = sections === undefined ? [...HOST_FACTS_SECTIONS] : Array.isArray(sections) ? sections : null
  if (asked === null || asked.length === 0 || asked.some(item => !HOST_FACTS_SECTIONS.includes(item as HostFactsSection))) {
    return { schema: HOST_FACTS_SCHEMA, voiceAuthority: 'none', mutating: false, ok: false, code: 'HOST_FACTS_SECTION_UNKNOWN', sections: [...HOST_FACTS_SECTIONS] }
  }
  const unique = [...new Set(asked as HostFactsSection[])]
  const read = await Promise.all(unique.map(async section => [section, await readSource(section, deps)] as const))
  const out: Json = { schema: HOST_FACTS_SCHEMA, voiceAuthority: 'none', mutating: false, readAt: (deps.now ?? Date.now)(),
    ok: read.every(([, value]) => value.ok === true), ...Object.fromEntries(read) }
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > HOST_FACTS_RESULT_BYTES) {
    return { schema: HOST_FACTS_SCHEMA, voiceAuthority: 'none', mutating: false, ok: false, code: 'HOST_FACTS_RESULT_LIMIT' }
  }
  return out
}

/** The tool's definition, registered by the ball runtime beside `x6_capability_index`. */
export function hostFactsToolSpec(deps: () => HostFactsDeps) {
  return {
    name: 'x6_host_facts',
    description: 'Read-only facts your host reports about you: HEAD (epoch, ballId, lease, governance policy, staged candidate summary, '
      + 'last publish outcome) from /_head/promotion-status, your AUMLOK binding (phase, blockers, counts) from /_host/aumlok/status, '
      + 'and verified receipt/checkpoint facts from /__x6/facts. Bounded, allowlisted, no secrets, keys or module code; '
      + 'each source fails by its own code. It reads only; it stages, promotes, approves or writes nothing.',
    parameters: {
      sections: { type: 'json', description: 'Subset of ["promotion","aumlok","facts"]; default all three.' },
    },
    async execute(args: Record<string, unknown> | undefined) {
      return await readHostFacts(args?.sections, deps())
    },
  }
}
