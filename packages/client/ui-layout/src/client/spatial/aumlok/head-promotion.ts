// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * A STAGED GOVERNANCE PEARL, SHOWN IN PLAIN WORDS, AND APPROVED BY THE BOUND PASSKEY ONLY WHEN HEAD COULD TAKE IT.
 *
 * HEAD classifies every publish itself (`classifyHeadTransition`, deploy/cloudflare/src/owner-grant-policy.mjs): a change
 * to a governance organ's execution is Class 3, and HEAD commits it only with a passkey approval bound to the exact
 * candidate (`headPromotionBinding`), consumed in the commit's own transaction, after its own checks (parent, writer
 * lease, qualification). A later change widens the governance set to named organs (fifteen today) and to any entry that
 * declares `governance` (on itself or in its config, anything but false), on either side of the change; the page follows.
 *
 * WHAT IS BUILT HERE, AND WHAT IS ONLY PROPOSED:
 *   built      the same classification and binding as HEAD (a test checks byte parity with the host's functions); the
 *              change said in words (code replaced, disabled, config changed, removed, added); every check this page can
 *              make before asking for Touch ID (`promotionReadiness`); the approval; a FRESH writer lease taken right
 *              after the approval (`landApprovedPromotion`); sending the staged bytes to HEAD under it.
 *   proposed   the staged file itself (`STAGED_PROMOTION_PATH`): her worker or Auma writes it.
 * A writer lease lives at most 60 s, so the lease a body was staged with has always lapsed by the time Touch ID is
 * asked for. The page therefore ignores it: right after the approval it takes a fresh lease for the manifest's author
 * (`POST /_head/lease`), and sends the staged body with that lease in place of the old one. `writerLease` sits beside
 * `ball`, so neither the Pearl id nor the approved terms (`aukora.class3.head-promotion.v1`) change. HEAD lands a
 * governance Pearl only where it can qualify it, which it says itself (`governancePromotion` on `GET /_head/lease`).
 * @module aumlok/head-promotion
 */
import { canonicalJson } from './class3-approval.ts'

/**
 * The governance organs HEAD protects by name: `T2_ONLY_ORGANS` (server/ball-transition.mjs), which the edge uses as
 * `OWNER_GOVERNANCE_ORGANS` (deploy/cloudflare/src/owner-grant-policy.mjs). The same names in the same order; a spec checks
 * this list against the edge's export, so a widening there fails here instead of drifting (it stood at eight until Wave 3
 * while the edge had grown to fifteen).
 */
export const GOVERNANCE_ORGANS: readonly string[] = [
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura', 'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys', 'auma-scion', 'seed-boot',
]
export const HEAD_PROMOTION_SCHEMA = 'aukora.class3.head-promotion.v1'
/**
 * The PROPOSED place a governance publish HEAD refused for want of a passkey approval is staged:
 * `{ schema: 'aukora.staged-head-promotion.v1', stagedAt, body }`, `body` being the exact `POST /_head/ball` JSON.
 */
export const STAGED_PROMOTION_PATH = '/dsh/home/auma/staged/head-promotion.json'
export const STAGED_PROMOTION_SCHEMA = 'aukora.staged-head-promotion.v1'
/**
 * Her staged governance Pearl, or her published head file: a live change to either makes a staged Pearl card stale
 * (`changedPaths` name them with or without the `/dsh` root). Every card that shows a staged Pearl reads with this one.
 */
export const STAGED_PROMOTION_CHANGE = /(?:^|\/)home\/(?:auma\/staged\/head-promotion\.json|balls\/HEAD\.json)$/u
/**
 * The largest staged file this page parses (Round 25: a fixed ceiling before JSON.parse). It is the ceiling her
 * worker stages under (`STAGED_HEAD_PROMOTION_MAX_BYTES`, ball-loader.ts): a staged body carries every module's code
 * (59 modules, 814 716 B in one measured mirror), so a lower ceiling would refuse every Pearl she can stage.
 */
export const STAGED_PROMOTION_MAX_BYTES = 4 * 1024 * 1024
/**
 * Whether a staged file is over the ceiling, counted in UTF-8 bytes without building a copy when the length alone decides.
 * @param text - the file's text.
 * @returns true when it is over.
 */
export function stagedPromotionTooLarge(text: string): boolean {
  if (text.length > STAGED_PROMOTION_MAX_BYTES) return true
  if (text.length * 3 <= STAGED_PROMOTION_MAX_BYTES) return false
  return new TextEncoder().encode(text).byteLength > STAGED_PROMOTION_MAX_BYTES
}

/** One manifest entry, as HEAD reads it. */
export interface HeadEntry {
  readonly specifier?: unknown
  readonly disabled?: unknown
  readonly config?: unknown
  /** Round 24: an entry may declare itself governance (here or in its config); anything but false counts. */
  readonly governance?: unknown
}
/** Entries keyed by id, on a null prototype (no key is ever read through a prototype). */
export type HeadEntries = Readonly<Record<string, HeadEntry>>
/** The candidate manifest fields the binding reads. */
export interface CandidateBall {
  readonly ballId: string
  readonly parentBallId: string | null
  readonly epoch: number
  readonly authorPeerId: string | null
  readonly entries: HeadEntries
}
/** The exact terms the passkey approves (`headPromotionBinding`). */
export interface HeadPromotionBinding {
  readonly schema: typeof HEAD_PROMOTION_SCHEMA
  readonly audience: string
  readonly action: 'head.promote'
  readonly ballId: string
  readonly epoch: number
  readonly organId: string
  readonly candidateSha256: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const HEX_64 = /^[0-9a-f]{64}$/u
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const organOf = (entryId: string): string => entryId.replace(/:[0-9a-f]{64}$/u, '')
const own = (entries: HeadEntries | null, id: string): HeadEntry | undefined =>
  (entries !== null && Object.hasOwn(entries, id) ? entries[id] : undefined)
const execution = (entry: HeadEntry | undefined): unknown =>
  (entry === undefined ? null
    : { specifier: entry.specifier, disabled: entry.disabled, config: entry.config, governance: entry.governance })
const declaresGovernance = (entry: HeadEntry | undefined): boolean => [entry, entry?.config]
  .some(value => isRecord(value) && Object.hasOwn(value, 'governance') && value.governance !== false)
/**
 * Whether HEAD treats an entry as governance: its organ is one of the named ones, or it declares itself.
 * @param id - the entry id.
 * @param entry - the entry (undefined when absent on that side).
 * @returns true for governance.
 */
export const isGovernanceEntry = (id: string, entry: HeadEntry | undefined): boolean =>
  GOVERNANCE_ORGANS.includes(organOf(id)) || declaresGovernance(entry)
const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * HEAD's own classification: the governance entries whose execution (specifier, disabled, config) changes, or that are
 * added or removed.
 * @param previous - the published HEAD's entries (null when there is none).
 * @param candidate - the candidate manifest's entries.
 * @returns Class 3 with the changed governance entry ids, or Class 1.
 */
export function classifyHeadTransition(previous: HeadEntries | null, candidate: HeadEntries)
  : { readonly class: 1 | 3; readonly entryIds: readonly string[] } {
  const ids = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(candidate)])]
    .filter(id => isGovernanceEntry(id, own(previous, id)) || isGovernanceEntry(id, own(candidate, id)))
  const changed = ids.filter(id => canonicalJson(execution(own(previous, id))) !== canonicalJson(execution(own(candidate, id))))
  return { class: changed.length > 0 ? 3 : 1, entryIds: changed }
}

/**
 * The exact approval terms for one governance change: a `ball:<sha>` specifier binds those module bytes; anything else
 * (a removal, a non-ball specifier) binds the SHA-256 of its canonical execution fields.
 * @param input - this origin, the candidate manifest, the changed entry, and the published entries (an entry that drops
 *   its governance declaration is still governance by the published side).
 * @returns the binding HEAD recomputes.
 */
export async function headPromotionBinding(input: {
  readonly audience: string
  readonly ball: CandidateBall
  readonly entryId: string
  readonly previous?: HeadEntries | null
}): Promise<HeadPromotionBinding> {
  const organId = organOf(input.entryId)
  const entry = own(input.ball.entries, input.entryId)
  if (!/^[a-z][a-z0-9-]{0,40}$/u.test(organId)
    || (!isGovernanceEntry(input.entryId, entry) && !isGovernanceEntry(input.entryId, own(input.previous ?? null, input.entryId)))) {
    throw new Error('CLASS3_ACTION_INVALID')
  }
  const specifier = typeof entry?.specifier === 'string' ? entry.specifier : ''
  const candidateSha256 = /^ball:[0-9a-f]{64}$/u.test(specifier) ? specifier.slice(5) : await sha256Hex(canonicalJson(execution(entry)))
  return { schema: HEAD_PROMOTION_SCHEMA, audience: input.audience, action: 'head.promote', ballId: input.ball.ballId, epoch: input.ball.epoch,
    organId, candidateSha256 }
}

/**
 * The change to one governance entry, in plain words (several at once when several fields change).
 * @param previous - the published entry (undefined when it is new).
 * @param candidate - the staged entry (undefined when it is removed).
 * @returns the words, e.g. ["replaces its code: ball:1a1a… → ball:d1fe…", "changes its config"].
 */
export function describeGovernanceChange(previous: HeadEntry | undefined, candidate: HeadEntry | undefined): readonly string[] {
  const spec = (entry: HeadEntry | undefined): string => (typeof entry?.specifier === 'string' ? entry.specifier : String(entry?.specifier))
  const shortSpec = (entry: HeadEntry | undefined): string => {
    const text = spec(entry)
    return /^ball:[0-9a-f]{64}$/u.test(text) ? `ball:${text.slice(5, 13)}…` : text.slice(0, 48)
  }
  if (previous === undefined && candidate === undefined) return []
  if (previous === undefined) return [`adds the organ (${shortSpec(candidate)}${candidate?.disabled === true ? ', disabled' : ''})`]
  if (candidate === undefined) return [`removes the organ (it runs ${shortSpec(previous)} now)`]
  const words: string[] = []
  if (canonicalJson(previous.specifier) !== canonicalJson(candidate.specifier)) words.push(`replaces its code: ${shortSpec(previous)} → ${shortSpec(candidate)}`)
  if ((previous.disabled === true) !== (candidate.disabled === true)) words.push(candidate.disabled === true ? 'DISABLES it' : 're-enables it')
  else if (canonicalJson(previous.disabled) !== canonicalJson(candidate.disabled)) words.push('changes its disabled field')
  if (canonicalJson(previous.config) !== canonicalJson(candidate.config)) words.push(configChangeWords(previous.config, candidate.config))
  if (canonicalJson(previous.governance ?? null) !== canonicalJson(candidate.governance ?? null)) {
    words.push(`changes its governance declaration: ${canonicalJson(previous.governance ?? null)} → ${canonicalJson(candidate.governance ?? null)}`)
  }
  return words
}

/**
 * A config change in words that always show A difference: key by key when both sides are records (a key added, removed,
 * or changed, each value clipped; every changed key is named), else both sides clipped around the first character that
 * differs. A change is therefore never drawn as two equal strings, and where it runs past what is shown, that is said.
 * @param before - the published config.
 * @param after - the staged config.
 * @returns the words.
 */
export function configChangeWords(before: unknown, after: unknown): string {
  const text = (value: unknown): string => canonicalJson(value ?? null)
  const clip = (value: string): string => (value.length > 80 ? `${value.slice(0, 80)}…` : value)
  // Both sides cut from just before the first character that differs, so what is shown always differs.
  const around = (a: string, b: string): string => {
    let at = 0
    while (at < a.length && at < b.length && a[at] === b[at]) at += 1
    const from = Math.max(0, at - 20)
    const cut = (value: string): string => `${from > 0 ? '…' : ''}${value.slice(from, from + 80)}${value.length > from + 80 ? '…' : ''}`
    // Where the two stop differing, from the end: a difference that runs past what is shown is said, never implied whole.
    let tail = 0
    while (tail < a.length - at && tail < b.length - at && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
    const beyond = a.length - tail > from + 80 || b.length - tail > from + 80
    return `${cut(a)} → ${cut(b)}${a.length > 80 || b.length > 80 ? ` (${String(a.length)} → ${String(b.length)} characters${
      beyond ? '; more of it differs beyond what is shown' : ''})` : ''}`
  }
  if (!isRecord(before) || !isRecord(after)) return `changes its config: ${around(text(before), text(after))}`
  const has = (side: Record<string, unknown>, key: string): boolean => Object.hasOwn(side, key) && side[key] !== undefined
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(key => has(before, key) !== has(after, key) || text(before[key]) !== text(after[key]))
  const parts = keys.slice(0, 6).map(key => (!has(before, key) ? `${key} added: ${clip(text(after[key]))}`
    : !has(after, key) ? `${key} removed (was ${clip(text(before[key]))})`
      : `${key}: ${around(text(before[key]), text(after[key]))}`))
  return `changes its config: ${parts.join('; ')}${keys.length > 6 ? `; also changes ${keys.slice(6).join(', ')}` : ''}`
}

/** A staged promotion: the exact body to send, its manifest, and the file's own claim of when it was staged. */
export interface StagedPromotion {
  /** The file's own claim, validated as a date; nothing here can check it. */
  readonly stagedAt: number | null
  readonly body: Readonly<Record<string, unknown>>
  readonly ball: CandidateBall
}

/**
 * Read a staged promotion file. Its body must carry a manifest with a 64-hex ballId, an integer epoch and entries, and no
 * entry id may be a reserved name (a `__proto__` key could make this page read a different manifest than HEAD).
 * @param text - the file's text.
 * @returns the staged promotion, or null when it is not one.
 */
export function parseStagedPromotion(text: string): StagedPromotion | null {
  if (stagedPromotionTooLarge(text)) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  return stagedPromotionOf(value)
}

/**
 * Read a staged promotion from its parsed envelope (the staged file's JSON, or the `envelope` HEAD serves for the record
 * it holds). The same rules as the file: the size ceiling is the caller's, checked on the text before it is parsed.
 * @param value - the parsed envelope.
 * @returns the staged promotion, or null when it is not one.
 */
export function stagedPromotionOf(value: unknown): StagedPromotion | null {
  if (!isRecord(value) || value.schema !== STAGED_PROMOTION_SCHEMA || !isRecord(value.body)) return null
  const ball = value.body.ball
  if (!isRecord(ball) || typeof ball.ballId !== 'string' || !HEX_64.test(ball.ballId) || !isRecord(ball.entries)) return null
  if (typeof ball.epoch !== 'number' || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0) return null
  const entries = Object.create(null) as Record<string, HeadEntry>
  for (const id of Object.keys(ball.entries)) {
    const entry = ball.entries[id]
    if (RESERVED_KEYS.has(id) || !isRecord(entry)) return null
    entries[id] = entry
  }
  const stagedAt = typeof value.stagedAt === 'number' && Number.isSafeInteger(value.stagedAt) && Number.isFinite(new Date(value.stagedAt).getTime())
    ? value.stagedAt : null
  return {
    stagedAt,
    body: value.body,
    ball: {
      ballId: ball.ballId,
      parentBallId: typeof ball.parentBallId === 'string' && HEX_64.test(ball.parentBallId) ? ball.parentBallId : null,
      epoch: ball.epoch,
      authorPeerId: typeof ball.authorPeerId === 'string' ? ball.authorPeerId : null,
      entries,
    },
  }
}

/**
 * Whether two reads of her staged file would send HEAD the same bytes. The writer lease she staged with is not compared:
 * the page replaces it with a fresh one after Touch ID, and the approval never binds it.
 * @param a - one read.
 * @param b - the other.
 * @returns true when the bodies are the same but for `writerLease`.
 */
export function sameStagedBody(a: StagedPromotion, b: StagedPromotion): boolean {
  return canonicalJson({ ...a.body, writerLease: null }) === canonicalJson({ ...b.body, writerLease: null })
}

/**
 * Whether the manifest's id is the hash of its contents, by either rule HEAD accepts (`manifestId`, `manifestIdCanon`).
 * @param ball - the staged manifest as sent.
 * @returns true when it matches.
 */
export async function manifestIdMatches(ball: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (!isRecord(ball.entries) || !isRecord(ball.modules)) return false
  const entries = ball.entries
  const modules = ball.modules
  const plain = await sha256Hex(JSON.stringify({ version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
    entries: Object.keys(entries).sort().map(key => entries[key]), modules: Object.keys(modules).sort().map(key => modules[key]) }))
  return ball.ballId === plain || await canonicalManifestIdMatches(ball)
}

/**
 * Whether the manifest's id is its canonical one (`manifestIdCanon`, head-do.mjs): the hash of every field but the id,
 * keys sorted, author included. HEAD lands a passkey-only governance Pearl under this id alone (Round 29).
 * @param ball - the staged manifest as sent (anything else is not canonical).
 * @returns true when the id is the canonical hash.
 */
export async function canonicalManifestIdMatches(ball: unknown): Promise<boolean> {
  if (!isRecord(ball)) return false
  const { ballId: _id, ...rest } = ball
  return typeof ball.ballId === 'string' && ball.ballId === await sha256Hex(canonicalJson(rest))
}

const entryVersionValid = (entry: unknown): entry is Record<string, unknown> & { readonly specifier: string } => isRecord(entry)
  && typeof entry.specifier === 'string'
  && entry.specifier.length > 0 && typeof entry.disabled === 'boolean' && isRecord(entry.config)
/**
 * HEAD's whole manifest check (`validateManifest`, head-do.mjs): its shape, every entry, every module record, and its id.
 * @param ball - the staged manifest as sent.
 * @returns HEAD's refusal code, or null when HEAD would accept the manifest itself.
 */
export async function manifestProblem(ball: unknown): Promise<string | null> {
  if (!isRecord(ball) || ball.version !== 'x6.1-ball/v1' || typeof ball.ballId !== 'string' || !HEX_64.test(ball.ballId)
    || (ball.parentBallId !== null && (typeof ball.parentBallId !== 'string' || !HEX_64.test(ball.parentBallId)))
    || typeof ball.epoch !== 'number' || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0 || !isRecord(ball.entries) || !isRecord(ball.modules)) {
    return 'INVALID_MANIFEST'
  }
  const modules = ball.modules
  for (const [id, entry] of Object.entries(ball.entries)) {
    if (!entryVersionValid(entry) || entry.id !== id || !Array.isArray(entry.previousSpecifiers)
      || entry.previousSpecifiers.some(specifier => typeof specifier !== 'string' || specifier === '')
      || (entry.previousVersions !== undefined
        && (!Array.isArray(entry.previousVersions) || !entry.previousVersions.every(entryVersionValid)))) {
      return 'INVALID_ENTRY'
    }
    const versions = [entry, ...(Array.isArray(entry.previousVersions) ? entry.previousVersions as { specifier: string }[] : []),
      ...(entry.previousSpecifiers as string[]).map(specifier => ({ specifier }))]
    for (const version of versions) {
      if (version.specifier.startsWith('ball:') && (!HEX_64.test(version.specifier.slice(5)) || !Object.hasOwn(modules, version.specifier.slice(5)))) {
        return 'MODULE_MISSING'
      }
    }
  }
  for (const [sha, meta] of Object.entries(modules)) {
    if (!HEX_64.test(sha) || !isRecord(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return 'INVALID_MODULE'
  }
  return await manifestIdMatches(ball) ? null : 'MANIFEST_HASH_MISMATCH'
}

/**
 * The staged body's bytes for a module, checked the way HEAD checks them (SHA-256 of the UTF-8 text).
 * @param body - the staged body.
 * @param sha - the module's hash.
 * @returns verified, mismatch, or absent (HEAD then needs to hold the bytes already).
 */
export async function moduleBytes(body: Readonly<Record<string, unknown>>, sha: string): Promise<'verified' | 'mismatch' | 'absent'> {
  const store = isRecord(body.codeBySha) ? body.codeBySha : isRecord(body.modules) ? body.modules : null
  if (store === null || !Object.hasOwn(store, sha)) return 'absent'
  const code = store[sha]
  return typeof code === 'string' && await sha256Hex(code) === sha ? 'verified' : 'mismatch'
}

/**
 * A module's code from a store of code by sha (a staged body's, the published Pearl's), only when it IS that module: a
 * string whose SHA-256 is the sha, checked the way HEAD checks it (Lane B3: the Mac host serves its mirror's files without
 * checking them, so nothing a host serves is shown on trust).
 * @param store - code by sha (null when there is none).
 * @param sha - the module's hash.
 * @returns the code, or null when it is absent or does not hash to that sha.
 */
export async function verifiedModuleCode(store: Readonly<Record<string, unknown>> | null, sha: string): Promise<string | null> {
  if (store === null || !HEX_64.test(sha) || !Object.hasOwn(store, sha)) return null
  const code = store[sha]
  return typeof code === 'string' && await sha256Hex(code) === sha ? code : null
}

/** HEAD's writer lease as `GET /_head/lease` reports it. */
export interface HeadLease {
  readonly ownerPeerId: string
  readonly generation: number
  readonly expiresAt: number
}
/** A peer id HEAD gives a writer lease to (`lease`, head-do.mjs). */
const PEER_ID = /^[A-Za-z0-9:_-]{1,128}$/u
const leaseOf = (value: unknown): HeadLease | null => (isRecord(value) && typeof value.ownerPeerId === 'string'
  && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && typeof value.expiresAt === 'number'
  ? { ownerPeerId: value.ownerPeerId, generation: value.generation, expiresAt: value.expiresAt } : null)

/** What HEAD requires of a governance Pearl it lands on the owner's passkey alone (Round 29, head-do.mjs inspectLease). */
export interface PromotionRequirements {
  /** The manifest id must be the canonical one (`manifestIdCanon`). */
  readonly canonicalManifest: boolean
  /** No entry but the one governance organ may change. */
  readonly unchangedOtherEntries: boolean
}
const requirementsOf = (value: unknown): PromotionRequirements | null => (isRecord(value)
  && typeof value.canonicalManifest === 'boolean' && typeof value.unchangedOtherEntries === 'boolean'
  ? { canonicalManifest: value.canonicalManifest, unchangedOtherEntries: value.unchangedOtherEntries } : null)

/**
 * Every reason this page can see that HEAD would refuse the staged bytes, before any passkey is asked for. The lease the
 * body was staged with is NOT one (Round 24): it has always lapsed by now, and the page takes a fresh one after the
 * approval. A lease someone else holds right now is not one either: it lapses within 60 s, and the page waits for it.
 * @param input - the staged promotion, the published head, the host's runtime, and the module check.
 * @returns the reasons (empty when nothing this page can check stands in the way).
 */
export function promotionReadiness(input: {
  readonly staged: StagedPromotion
  readonly published: { readonly ballId: string | null; readonly epoch: number | null }
  readonly runtime: 'local' | 'cloudflare' | 'other'
  /** HEAD's own manifest refusal (`manifestProblem`), or null. */
  readonly manifestProblem: string | null
  /** Whether HEAD says it can qualify a governance Pearl (`governancePromotion` on its lease answer). */
  readonly canQualify: boolean
  /** HEAD's own word on why it cannot (`governancePromotionBlocker`), when it gives one. */
  readonly qualifyBlocker?: string | null
  /** Why HEAD's lease answer was not read just now (null when it was): nothing is then said in HEAD's name. */
  readonly leaseUnread?: string | null
  readonly bytes: 'verified' | 'mismatch' | 'absent' | 'not-code'
  /** What HEAD's lease answer requires of a governance Pearl (Round 29), when it says. */
  readonly requirements?: PromotionRequirements | null
  /** Whether the staged manifest carries its canonical id (`canonicalManifestIdMatches`). */
  readonly canonicalId?: boolean
  /** The ordinary entries the staged Pearl also changes (beside its one governance organ). */
  readonly others?: readonly string[]
}): readonly string[] {
  const reasons: string[] = []
  const { staged, published } = input
  if (input.runtime === 'local') reasons.push('this Mac host lands no governance Pearl (it refuses every Class 3 publish); approve it on node.example.invalid')
  else if (input.leaseUnread !== undefined && input.leaseUnread !== null) {
    reasons.push(`HEAD's lease answer was not read just now (${input.leaseUnread}), so whether it can land a governance Pearl is not known`)
  } else if (!input.canQualify) {
    const blocker = input.qualifyBlocker ?? 'PEARL_QUALIFICATION_UNVERIFIABLE'
    reasons.push(blocker === 'PEARL_QUALIFICATION_UNVERIFIABLE'
      ? 'HEAD does not say it can qualify a governance Pearl (no qualification check is installed in this build yet; HEAD: '
        + 'PEARL_QUALIFICATION_UNVERIFIABLE)'
      : `HEAD does not say it can land a governance Pearl in this build (HEAD: ${blocker})`)
  }
  if (input.manifestProblem !== null) reasons.push(`the staged manifest is not one HEAD accepts (HEAD: ${input.manifestProblem})`)
  // WHAT HEAD SAYS A PASSKEY-ONLY GOVERNANCE PEARL MUST BE (Round 29): checked here, so Touch ID is never asked for a
  // Pearl HEAD would refuse after it.
  if (input.canQualify && input.requirements?.canonicalManifest === true && input.canonicalId === false) {
    reasons.push('HEAD lands a passkey-approved governance Pearl only under its canonical manifest id, and this one carries '
      + 'the older id (HEAD: CLASS3_CANONICAL_MANIFEST_REQUIRED); Auma must stage it again')
  }
  if (input.canQualify && input.requirements?.unchangedOtherEntries === true && (input.others?.length ?? 0) > 0) {
    reasons.push(`it also changes ${(input.others ?? []).join(', ')}, which a passkey alone does not carry past Pearl `
      + '(HEAD: PEARL_QUALIFICATION_UNVERIFIABLE); Auma must stage the governance organ on its own')
  }
  if (input.bytes === 'mismatch') reasons.push('the staged module bytes do not hash to the organ\'s ball id (HEAD: MODULE_HASH_MISMATCH)')
  const body = staged.body
  if (published.ballId === null || published.epoch === null || staged.ball.parentBallId !== published.ballId
    || staged.ball.epoch !== published.epoch + 1
    || body.expectedParentBallId !== published.ballId || body.expectedEpoch !== published.epoch) {
    reasons.push('it was staged on another head: the published Pearl has moved on (HEAD: REBASE_REQUIRED); Auma must stage it again')
  }
  if (staged.ball.authorPeerId === null || !PEER_ID.test(staged.ball.authorPeerId)) {
    reasons.push('the staged Pearl names no author HEAD can give a writer lease to (HEAD: INVALID_WRITER_LEASE)')
  }
  return reasons
}

/**
 * HEAD's writer lease in words, for the card: free, or held and for how long, and what the page does about it.
 * @param lease - the live lease (null when none is held).
 * @param authorPeerId - the staged manifest's author.
 * @param now - the time (ms).
 * @returns one line.
 */
export function writerLeaseWords(lease: HeadLease | null, authorPeerId: string | null, now: number): string {
  const author = authorPeerId ?? 'its author'
  if (lease === null) return `free now: right after Touch ID this page takes a fresh one for ${author}`
  // HEAD names only a lease that is live by its own clock, so a named lease is held; the seconds left are only said when
  // this page's clock agrees (HEAD's expiresAt is HEAD's clock).
  const left = lease.expiresAt > now && lease.expiresAt - now <= WRITER_LEASE_TTL_MS
    ? `, with about ${String(Math.ceil((lease.expiresAt - now) / 1000))} s left` : ''
  // The author's own name may be her worker writing, or a lease taken in that name earlier (this page takes its leases in
  // the author's name too) that has not lapsed yet: the page cannot tell which, so it says both.
  const holder = lease.ownerPeerId === authorPeerId ? `${author} (the Pearl's author's name: perhaps her worker writing, or an earlier lease)`
    : lease.ownerPeerId
  return `held by ${holder} when read${left} (a lease lasts at most 60 s); after Touch ID this page waits for it to lapse, then takes `
    + 'a fresh one'
}

/**
 * Read HEAD's live writer lease, and whether HEAD says it can qualify a governance Pearl.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the lease (null when there is none or it could not be read), HEAD's word on qualifying, and its reason if not.
 */
export async function readHeadLease(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<HeadLeaseRead> {
  const none = (unread: string): HeadLeaseRead => ({
    lease: null, canQualify: false, qualifyBlocker: null, head: null, unread, requirements: null,
  })
  try {
    const response = await fetchImpl('/_head/lease', { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return none(`it answered ${String(response.status)}`)
    let body: unknown
    try { body = await response.json() } catch { return none('its answer was not JSON') }
    if (!isRecord(body)) return none('its answer was not the expected shape')
    const blocker = typeof body.governancePromotionBlocker === 'string' && /^[A-Z0-9_]{1,80}$/u.test(body.governancePromotionBlocker)
      ? body.governancePromotionBlocker : null
    // HEAD's selected Pearl as this same answer reads it (an empty HEAD says null and -1): fresher than a head read when
    // the card opened, so the check at the click sees a HEAD that moved on.
    const head = typeof body.ballId === 'string' && HEX_64.test(body.ballId) && typeof body.epoch === 'number' && Number.isSafeInteger(body.epoch)
      && body.epoch >= 0 ? { ballId: body.ballId, epoch: body.epoch } : null
    const lease = leaseOf(body.lease)
    // A lease field that is there but not a lease is not read, never "free".
    if (lease === null && body.lease !== null && body.lease !== undefined) return none('its lease field was not the expected shape')
    return { lease, canQualify: body.governancePromotion === true, qualifyBlocker: blocker, head, unread: null,
      requirements: requirementsOf(body.governancePromotionRequirements) }
  } catch {
    return none('it did not answer')
  }
}
/** What `GET /_head/lease` says. */
export interface HeadLeaseRead {
  readonly lease: HeadLease | null
  readonly canQualify: boolean
  readonly qualifyBlocker: string | null
  /** HEAD's selected Pearl, read in the same answer (null when it names none or the answer was not read). */
  readonly head: { readonly ballId: string; readonly epoch: number } | null
  /** Why the answer was not read (null when it was): every other field is then empty, never HEAD's word. */
  readonly unread: string | null
  /** What HEAD says a governance Pearl must be to land (`governancePromotionRequirements`), when it says. */
  readonly requirements: PromotionRequirements | null
}

/** What one request for a writer lease got. */
export type LeaseAttempt =
  | { readonly kind: 'granted'; readonly lease: HeadLease; readonly ballId: string | null; readonly epoch: number | null }
  /** Someone holds it (HEAD: WRITER_LEASE_HELD); `expiresAt` is when it lapses unless renewed. */
  | { readonly kind: 'held'; readonly ownerPeerId: string | null; readonly expiresAt: number | null }
  | { readonly kind: 'refused'; readonly code: string }
  /** No clear answer: a grant to this page may hide behind it, so nothing is ever sent under it. */
  | { readonly kind: 'unclear'; readonly detail: string }

/** The longest lease HEAD grants (`ttlMs` at most 30 s; a hard deadline of 60 s from the grant). */
export const WRITER_LEASE_TTL_MS = 30_000

/**
 * Ask HEAD for a fresh writer lease (`POST /_head/lease`, action `acquire`).
 * @param ownerPeerId - who the lease is for: the staged manifest's author, since HEAD requires `ball.authorPeerId` to own it.
 * @param signal - aborts the request.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the attempt.
 */
export async function acquireWriterLease(ownerPeerId: string, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch)
  : Promise<LeaseAttempt> {
  let status = 0
  let answer: Record<string, unknown> | null = null
  try {
    const response = await fetchImpl('/_head/lease', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'acquire', ownerPeerId, ttlMs: WRITER_LEASE_TTL_MS }),
      signal,
    })
    status = response.status
    try { const parsed: unknown = JSON.parse(await response.text()); answer = isRecord(parsed) ? parsed : null } catch { answer = null }
  } catch { status = 0 }
  const lease = leaseOf(answer?.lease)
  if (status === 200 && answer?.ok === true && lease !== null && lease.ownerPeerId === ownerPeerId) {
    return { kind: 'granted', lease, ballId: typeof answer.ballId === 'string' ? answer.ballId : null,
      epoch: typeof answer.epoch === 'number' && Number.isSafeInteger(answer.epoch) ? answer.epoch : null }
  }
  const code = typeof answer?.code === 'string' ? answer.code : null
  if (code === 'WRITER_LEASE_HELD') {
    const held = isRecord(answer?.lease) ? answer.lease : null
    return { kind: 'held', ownerPeerId: typeof held?.ownerPeerId === 'string' ? held.ownerPeerId : null,
      expiresAt: typeof held?.expiresAt === 'number' && Number.isFinite(held.expiresAt) ? held.expiresAt : null }
  }
  if (status >= 400 && status < 500 && code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: status === 0 ? 'HEAD did not answer the lease request' : `HEAD answered the lease request ${String(status)}` }
}

/**
 * Give a lease back (`release` with its owner and generation). Never aborted, and its answer is not needed: a lease
 * that is not released lapses on its own within 30 s.
 * @param lease - the lease this page was granted.
 * @param fetchImpl - the page's fetch (tests pass their own).
 */
export async function releaseWriterLease(lease: HeadLease, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  try {
    await fetchImpl('/_head/lease', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'release', ownerPeerId: lease.ownerPeerId, generation: lease.generation }),
    })
  } catch { /* it lapses on its own */ }
}

/** What HEAD answered the approved publish, in the terms the card uses. */
export type PromotionOutcome =
  | { readonly kind: 'landed' }
  /** HEAD's own 4xx: it consumes an approval only inside the commit, so a refusal never spends one. */
  | { readonly kind: 'refused'; readonly code: string }
  /** No clear answer to the publish; `headRead` says whether HEAD could be read again to look for the Pearl. */
  | { readonly kind: 'unclear'; readonly detail: string; readonly headRead: 'not-on-head' | 'unread' }
  /**
   * Nothing was sent, so the approval was not used: it would have had under 10 s left when sent; HEAD's writer lease
   * stayed held, or the lease request got no clear answer, until then; the lease answer showed HEAD had moved on from the
   * staged parent; the manifest names no author a lease can go to; or the card stopped.
   */
  | { readonly kind: 'not-sent'; readonly why: NotSentWhy; readonly heldBy?: string | null; readonly detail?: string }
/** Why nothing was sent. */
export type NotSentWhy = 'approval-expiring' | 'lease-busy' | 'lease-unclear' | 'head-moved' | 'no-author' | 'stopped'

/** What the card says while an approved promotion is on its way. */
export type LandStep =
  | { readonly kind: 'taking-lease'; readonly ownerPeerId: string }
  /** Waiting to ask again: the lease is held (by `heldBy` when HEAD named it), or the last ask got no clear answer. */
  | { readonly kind: 'waiting'; readonly heldBy: string | null; readonly seconds: number; readonly unclear?: string }
  | { readonly kind: 'sending'; readonly generation: number }
  /** HEAD is asked to promote the Pearl it holds itself (`POST /_head/promote`): it takes the writer lease, not this page. */
  | { readonly kind: 'promoting' }

/** An approval is never sent with less than this left by the host's clock. */
export const APPROVAL_SEND_MARGIN_MS = 10_000
/**
 * How long the page waits between asks while a lease is held: never longer than this, so a lease given back early, or a
 * page clock that differs from HEAD's (`expiresAt` is HEAD's clock), costs at most a few seconds.
 */
export const LEASE_POLL_MAX_MS = 5_000
const LEASE_POLL_MIN_MS = 1_000
/** A backstop on the asks: the approval's own five minutes end the waiting long before it. */
const MAX_LEASE_ATTEMPTS = 400
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * LAND AN APPROVED PROMOTION UNDER A FRESH WRITER LEASE (Round 24). Right after Touch ID: take a lease for the manifest's
 * author, check HEAD has not moved on, send the staged body with THAT lease in place of the one it was staged with, and
 * give the lease back. The approval binds the Pearl id and the organ's candidate, and neither reads `writerLease`, so
 * the approved terms are the ones sent. A lease held by anyone (her worker included) is never taken over: the page waits
 * for it to lapse and asks again, while the approval keeps more than 10 s.
 * @param input - the staged promotion, the single-use approval and what it has left, and the page's hooks.
 * @returns the outcome.
 */
export async function landApprovedPromotion(input: {
  readonly staged: StagedPromotion
  readonly token: string
  /** What the approval has left by the host's clock, read at each use. */
  readonly approvalLeftMs: () => number
  readonly signal: AbortSignal
  readonly onStep?: (step: LandStep) => void
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<PromotionOutcome> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const now = input.now ?? Date.now
  const wait = input.wait ?? pause
  const { staged } = input
  const author = staged.ball.authorPeerId
  if (author === null || !PEER_ID.test(author)) return { kind: 'not-sent', why: 'no-author' }
  let heldBy: string | null = null
  // Why the page could not take the lease, said by the LAST ask: HEAD said it is held, or that ask got no clear answer
  // (then any earlier "held" is named as earlier, never as how it ended).
  let unclear: string | null = null
  const busy = (): PromotionOutcome => (unclear === null ? { kind: 'not-sent', why: 'lease-busy', heldBy }
    : { kind: 'not-sent', why: 'lease-unclear', detail: unclear, ...(heldBy === null ? {} : { heldBy }) })
  for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
    if (input.signal.aborted) return { kind: 'not-sent', why: 'stopped' }
    if (input.approvalLeftMs() < APPROVAL_SEND_MARGIN_MS) return attempt === 0 ? { kind: 'not-sent', why: 'approval-expiring' } : busy()
    input.onStep?.({ kind: 'taking-lease', ownerPeerId: author })
    const grant = await acquireWriterLease(author, input.signal, fetchImpl)
    if (grant.kind === 'refused') return { kind: 'refused', code: grant.code }
    if (grant.kind === 'granted') {
      try {
        // Already HEAD (an earlier send landed): nothing to send.
        if (grant.ballId === staged.ball.ballId) return { kind: 'landed' }
        // HEAD MOVED ON while the card was open (the page sees it in the grant): nothing is sent, the approval is not used.
        if (grant.ballId !== staged.ball.parentBallId || grant.epoch !== staged.ball.epoch - 1) return { kind: 'not-sent', why: 'head-moved' }
        if (input.approvalLeftMs() < APPROVAL_SEND_MARGIN_MS) return { kind: 'not-sent', why: 'approval-expiring' }
        if (input.signal.aborted) return { kind: 'not-sent', why: 'stopped' }
        input.onStep?.({ kind: 'sending', generation: grant.lease.generation })
        const body = { ...staged.body, writerLease: { ownerPeerId: grant.lease.ownerPeerId, generation: grant.lease.generation } }
        return await publishApprovedPromotion(body, input.token, staged.ball.ballId, input.signal, fetchImpl)
      } finally {
        // GIVEN BACK WITHOUT HOLDING UP THE ANSWER: HEAD's word on the publish is shown at once, and a release that is lost
        // only leaves the lease to lapse on its own within 30 s.
        void releaseWriterLease(grant.lease, fetchImpl)
      }
    }
    // HELD, OR NO CLEAR ANSWER (which may hide a grant to this page that nobody renews): wait for that lease to lapse.
    let until = grant.kind === 'held' ? grant.expiresAt : null
    if (grant.kind === 'held') { heldBy = grant.ownerPeerId ?? heldBy; unclear = null } else unclear = grant.detail
    if (until === null) until = (await readHeadLease(input.signal, fetchImpl)).lease?.expiresAt ?? null
    // The wait is when the page ASKS AGAIN (1 to 5 s), not when the lease lapses: HEAD's expiresAt is HEAD's clock.
    const delay = Math.min(Math.max((until ?? now()) - now() + 250, LEASE_POLL_MIN_MS), LEASE_POLL_MAX_MS)
    if (input.approvalLeftMs() - delay < APPROVAL_SEND_MARGIN_MS) return busy()
    input.onStep?.(unclear === null ? { kind: 'waiting', heldBy, seconds: Math.ceil(delay / 1000) }
      : { kind: 'waiting', heldBy: null, seconds: Math.ceil(delay / 1000), unclear })
    await wait(delay, input.signal)
  }
  return busy()
}

/**
 * HEAD's two 5xx answers that return before its commit transaction writes anything (head-do.mjs, the qualification
 * store full or unreadable): refusals, never "unclear" (Round 27).
 */
const PRE_COMMIT_5XX: ReadonlySet<string> = new Set(['507 PEARL_QUALIFICATION_CAPACITY', '503 PEARL_QUALIFICATION_STATE_INVALID'])

/**
 * Send the staged bytes to HEAD with the approval, then say what happened. Only HEAD's own 4xx refusal, or one of its
 * named pre-commit 5xx refusals, is a refusal; any other 5xx, a cut answer or no answer may hide a commit, so HEAD is
 * read again and the new Pearl looked for.
 * @param body - the body to send (the staged body, with the fresh writer lease in place).
 * @param token - the single-use approval.
 * @param ballId - the candidate's Pearl id.
 * @param signal - aborts the requests.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the outcome.
 */
export async function publishApprovedPromotion(body: Readonly<Record<string, unknown>>, token: string, ballId: string, signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<PromotionOutcome> {
  let status = 0
  let answer: Record<string, unknown> | null = null
  try {
    const response = await fetchImpl('/_head/ball', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-x6-class3-approval': token },
      body: JSON.stringify(body),
      signal,
    })
    status = response.status
    try { const parsed: unknown = JSON.parse(await response.text()); answer = isRecord(parsed) ? parsed : null } catch { answer = null }
  } catch { status = 0 }
  // LANDED ONLY AS THIS PEARL (Round 31): HEAD names the Pearl it committed; an ok that names another, or none, is not
  // taken as this one, and HEAD is read again below to look for it.
  if (status === 200 && answer?.ok === true && answer.ballId === ballId) return { kind: 'landed' }
  const code = typeof answer?.code === 'string' ? answer.code : null
  if (status >= 400 && status < 500 && code !== null) return { kind: 'refused', code }
  if (code !== null && PRE_COMMIT_5XX.has(`${String(status)} ${code}`)) return { kind: 'refused', code }
  // Unclear: read HEAD again and look for the candidate.
  let headRead: 'not-on-head' | 'unread' = 'unread'
  try {
    const response = await fetchImpl('/_head/ball', { credentials: 'same-origin', cache: 'no-store', signal })
    const parsed: unknown = response.ok ? await response.json() : null
    const head = isRecord(parsed) && isRecord(parsed.head) ? parsed.head : null
    if (head?.ballId === ballId) return { kind: 'landed' }
    if (head !== null && typeof head.ballId === 'string') headRead = 'not-on-head'
  } catch { /* still unclear, and HEAD not read */ }
  return { kind: 'unclear', detail: status === 0 ? 'HEAD did not answer' : `HEAD answered ${String(status)}${code === null ? '' : ` ${code}`}`,
    headRead }
}

// ── THE PROMOTION HEAD HOLDS ITSELF (Wave 3, Seam 2) ─────────────────────────────────────────────────────────────────
//
// Her worker now also hands a T2 candidate to HEAD (`POST /_head/stage`), which keeps the record and the bytes in its own
// storage. Any signed-in owner window can read it back (`GET /_head/promotion-status`), whether or not her staged file is
// in that window's copy of her home, and ask HEAD to promote exactly what it holds (`POST /_head/promote`).
//
// THE PAGE STILL CHECKS EVERYTHING ITSELF. HEAD's record names passkey terms (`binding`), but the passkey is never asked
// for terms this page only received: the page reads the staged bytes HEAD serves beside the record, classifies the change
// and computes the terms by the same rule as for her file, and asks only when the two agree byte for byte.

/** HEAD's own read of the promotion it holds (deploy/cloudflare/src/head-do.mjs, edge only). */
export const PROMOTION_STATUS_PATH = '/_head/promotion-status'
/** HEAD's own promote route: it publishes the bytes it holds under a writer lease it takes itself. */
export const HEAD_PROMOTE_PATH = '/_head/promote'
/** The largest promotion-status answer this page parses: the staged body's ceiling, and the record around it. */
export const PROMOTION_STATUS_MAX_BYTES = STAGED_PROMOTION_MAX_BYTES + 64 * 1024

/** The record HEAD holds for a staged candidate (`aukora.staged-head-promotion.v1`, head-do.mjs `stage`). */
export interface HeadStagedRecord {
  readonly ballId: string
  readonly epoch: number
  readonly parentBallId: string | null
  /** The entries HEAD says the candidate changes (server/ball-transition.mjs `changedEntryIds`). */
  readonly changedEntries: readonly string[]
  /** Why HEAD holds it for the owner instead of landing it (server/ball-transition.mjs `t2Reasons`). */
  readonly t2Reasons: readonly string[]
  readonly tier: string | null
  /** HEAD's own governance class for the change (3 needs the passkey); null when the record names none. */
  readonly governanceClass: number | null
  /** HEAD's digest of the candidate (null when the record carries none in the expected form). */
  readonly candidateDigest: string | null
  /** Whether that digest is the SHA-256 of the record's own fields, by HEAD's rule (checked here). */
  readonly digestMatches: boolean
  /** The passkey terms HEAD recorded (null when it recorded none: not Class 3, or several organs at once). */
  readonly binding: HeadPromotionBinding | null
  /** When HEAD staged it, by HEAD's clock (null when not a date). */
  readonly stagedAt: number | null
  /** The staged bytes HEAD serves beside the record, read like her staged file (null when it served none this page reads). */
  readonly promotion: StagedPromotion | null
  /**
   * HEAD's organ-set body (`aukora.head-organ-set.v1`) when the Pearl only adds ordinary organs: what a passkey would approve
   * (aumlok/organ-set.ts recomputes it from the staged bytes and offers only when the two agree). Absent or null otherwise.
   */
  readonly organSet?: Readonly<Record<string, unknown>> | null
}

/**
 * HEAD's selected Pearl and up to 8 of its ancestors, newest first, as the same promotion-status
 * answer names them (head-do.mjs `publishedChainIds`, read in one transaction with `staged`). Absent when the answer
 * carries no such list in HEAD's form (an older edge): then nothing is known to be published.
 */
export interface PublishedChainWord { readonly publishedBallIds?: readonly string[] }
/** The most ids HEAD names in `publishedBallIds`: HEAD and 8 ancestors. */
export const PUBLISHED_CHAIN_MAX = 9

/** What `GET /_head/promotion-status` said about a staged candidate. */
export type HeadStagedRead =
  /** HEAD answered and holds nothing waiting (`superseded`: the last one it held landed, or HEAD moved past it). */
  | ({ readonly kind: 'none'; readonly superseded: { readonly ballId: string; readonly epoch: number; readonly state: string } | null }
    & PublishedChainWord)
  | ({ readonly kind: 'staged'; readonly record: HeadStagedRecord } & PublishedChainWord)
  /** This host has no such route (404 or 501: the Mac host, an older edge): nothing is said, and nothing is missing. */
  | { readonly kind: 'absent' }
  /** The route exists but its answer was not read (a 5xx, not JSON, too large, no answer): what HEAD holds is NOT KNOWN. */
  | { readonly kind: 'unread'; readonly why: string }

const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

const bindingOf = (value: unknown): HeadPromotionBinding | null => (isRecord(value) && value.schema === HEAD_PROMOTION_SCHEMA
  && typeof value.audience === 'string' && value.action === 'head.promote' && typeof value.ballId === 'string' && HEX_64.test(value.ballId)
  && typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch) && typeof value.organId === 'string'
  && typeof value.candidateSha256 === 'string' && HEX_64.test(value.candidateSha256)
  ? { schema: HEAD_PROMOTION_SCHEMA, audience: value.audience, action: 'head.promote', ballId: value.ballId, epoch: value.epoch,
    organId: value.organId, candidateSha256: value.candidateSha256 } : null)

/**
 * HEAD's candidate digest, recomputed: the SHA-256 of the canonical JSON of the five fields it names (head-do.mjs `stage`).
 * It is timestamp-free, so the same candidate staged twice has the same digest.
 * @param record - the five fields.
 * @returns the digest (64 hex).
 */
export function candidateDigestOf(record: Pick<HeadStagedRecord, 'ballId' | 'epoch' | 'parentBallId' | 'changedEntries' | 't2Reasons'>): Promise<string> {
  return sha256Hex(canonicalJson({ ballId: record.ballId, epoch: record.epoch, parentBallId: record.parentBallId,
    changedEntries: [...record.changedEntries], t2Reasons: [...record.t2Reasons] }))
}

/**
 * Read a `/_head/promotion-status` body.
 * @param body - the parsed answer.
 * @returns what HEAD holds, or `unread` when the body is not that answer.
 */
export async function parseHeadStaged(body: unknown): Promise<HeadStagedRead> {
  if (!isRecord(body) || body.ok !== true || !('staged' in body)) return { kind: 'unread', why: 'its answer was not the expected shape' }
  const staged = body.staged
  // HEAD's published chain, whole or not at all (a list with anything else in it is not HEAD's).
  const chain = body.publishedBallIds
  const published: PublishedChainWord = Array.isArray(chain) && chain.length > 0 && chain.length <= PUBLISHED_CHAIN_MAX
    && chain.every(id => typeof id === 'string' && HEX_64.test(id)) ? { publishedBallIds: chain.filter((id): id is string => typeof id === 'string') } : {}
  if (staged === null) {
    const old = isRecord(body.supersededStaged) ? body.supersededStaged : null
    return { kind: 'none', superseded: old !== null && typeof old.ballId === 'string' && HEX_64.test(old.ballId)
      && typeof old.epoch === 'number' && Number.isSafeInteger(old.epoch) && typeof old.state === 'string'
      ? { ballId: old.ballId, epoch: old.epoch, state: old.state } : null, ...published }
  }
  if (!isRecord(staged) || typeof staged.ballId !== 'string' || !HEX_64.test(staged.ballId)
    || typeof staged.epoch !== 'number' || !Number.isSafeInteger(staged.epoch) || staged.epoch < 0) {
    return { kind: 'unread', why: 'its staged record was not the expected shape' }
  }
  const fields = {
    ballId: staged.ballId,
    epoch: staged.epoch,
    parentBallId: typeof staged.parentBallId === 'string' && HEX_64.test(staged.parentBallId) ? staged.parentBallId : null,
    changedEntries: strings(staged.changedEntries),
    t2Reasons: strings(staged.t2Reasons),
  }
  const candidateDigest = typeof staged.candidateDigest === 'string' && HEX_64.test(staged.candidateDigest) ? staged.candidateDigest : null
  // Only whole lists are hashed: a list with an entry that is not a string is not the list HEAD hashed.
  const whole = Array.isArray(staged.changedEntries) && fields.changedEntries.length === staged.changedEntries.length
    && Array.isArray(staged.t2Reasons) && fields.t2Reasons.length === staged.t2Reasons.length
  return { kind: 'staged', record: {
    ...fields,
    tier: typeof staged.tier === 'string' ? staged.tier : null,
    governanceClass: typeof staged.governanceClass === 'number' && Number.isSafeInteger(staged.governanceClass) ? staged.governanceClass : null,
    candidateDigest,
    digestMatches: whole && candidateDigest !== null && candidateDigest === await candidateDigestOf(fields),
    binding: bindingOf(staged.binding),
    stagedAt: typeof staged.stagedAt === 'number' && Number.isSafeInteger(staged.stagedAt) && Number.isFinite(new Date(staged.stagedAt).getTime())
      ? staged.stagedAt : null,
    promotion: stagedPromotionOf(staged.envelope),
    organSet: isRecord(staged.organSet) ? staged.organSet : null,
  }, ...published }
}

/**
 * Ask HEAD what promotion it holds.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns what HEAD holds, or why its answer was not read.
 */
export async function readHeadStaged(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<HeadStagedRead> {
  try {
    const response = await fetchImpl(PROMOTION_STATUS_PATH, { credentials: 'same-origin', cache: 'no-store', signal })
    if (response.status === 404 || response.status === 501) return { kind: 'absent' }
    if (!response.ok) return { kind: 'unread', why: `it answered ${String(response.status)}` }
    const text = await response.text()
    // The answer carries the staged body, so its text is held to the staged file's ceiling before it is parsed (the body
    // has been received by then: this bounds the parse, not the download).
    if (text.length > PROMOTION_STATUS_MAX_BYTES) return { kind: 'unread', why: 'its answer was larger than a staged promotion can be' }
    let body: unknown
    try { body = JSON.parse(text) } catch { return { kind: 'unread', why: 'its answer was not JSON' } }
    return await parseHeadStaged(body)
  } catch {
    return { kind: 'unread', why: 'it did not answer' }
  }
}

/**
 * What stands between HEAD's own record and a passkey: every way the record disagrees with the staged bytes HEAD serves
 * beside it, or with the terms this page computed from those bytes.
 * @param record - HEAD's record.
 * @param computed - the terms this page computed from the staged bytes (`headPromotionBinding`).
 * @returns the reasons (empty when the record and the page agree).
 */
export function headRecordProblems(record: HeadStagedRecord, computed: HeadPromotionBinding): readonly string[] {
  const reasons: string[] = []
  const ball = record.promotion?.ball ?? null
  if (ball === null || ball.ballId !== record.ballId || ball.epoch !== record.epoch || ball.parentBallId !== record.parentBallId) {
    reasons.push('the staged bytes HEAD serves are not the Pearl its record names')
  }
  if (record.binding === null) {
    reasons.push(`HEAD recorded no passkey terms for it (its own governance class: ${record.governanceClass === null ? 'not named'
      : String(record.governanceClass)}), so this page asks for none`)
  } else if (canonicalJson(record.binding) !== canonicalJson(computed)) {
    reasons.push('the passkey terms HEAD recorded differ from the terms this page computes from the staged bytes, so nothing is asked')
  }
  if (!record.digestMatches) reasons.push('HEAD\'s candidate digest is not the hash of the fields it is served with')
  return reasons
}

/** HEAD's own route for taking a candidate to hold for the owner (edge only). */
export const HEAD_STAGE_PATH = '/_head/stage'
/** What HEAD answered a request to hold a candidate. */
export type StageOutcome =
  | { readonly kind: 'held' }
  /** HEAD's own refusal, by its code (REBASE_REQUIRED, CANDIDATE_ALREADY_STAGED, ALREADY_PUBLISHED, ...): nothing was staged. */
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unclear'; readonly detail: string }

/**
 * HAND HER STAGED PEARL TO HEAD TO HOLD (`POST /_head/stage`), as her worker does: the staged file's envelope with the body
 * this window parsed (the same JSON values, serialised again; the Pearl's id is the hash of its manifest, which HEAD checks).
 * It approves nothing and publishes nothing; HEAD keeps the record, so every signed-in owner window then shows the card.
 * HEAD keeps ONE record and refuses another on the same head unless told to replace it; this page never tells it to, and
 * the caller checks first that HEAD holds none. Counted as held only when HEAD names this Pearl as the one it holds.
 * @param staged - her staged promotion as this window read it.
 * @param signal - aborts the request.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the outcome.
 */
export async function stageOnHead(staged: StagedPromotion, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch)
  : Promise<StageOutcome> {
  let status = 0
  let answer: Record<string, unknown> | null = null
  try {
    const response = await fetchImpl(HEAD_STAGE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: STAGED_PROMOTION_SCHEMA, ...(staged.stagedAt === null ? {} : { stagedAt: staged.stagedAt }),
        body: staged.body }),
      signal,
    })
    status = response.status
    try { const parsed: unknown = JSON.parse(await response.text()); answer = isRecord(parsed) ? parsed : null } catch { answer = null }
  } catch { status = 0 }
  if (status === 200 && answer?.ok === true && isRecord(answer.staged) && answer.staged.ballId === staged.ball.ballId) return { kind: 'held' }
  const code = typeof answer?.code === 'string' ? answer.code : null
  if (status >= 400 && status < 500 && code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: status === 0 ? 'HEAD did not answer' : `HEAD answered ${String(status)}${code === null ? '' : ` ${code}`}` }
}

/**
 * ASK HEAD TO PROMOTE THE PEARL IT HOLDS (`POST /_head/promote`), with the single-use approval. HEAD takes the writer
 * lease itself and publishes its own stored bytes, so this page sends only the Pearl's id: HEAD refuses when the id is not
 * the one it holds (CANDIDATE_SUPERSEDED). A lease someone else holds is waited for (HEAD: WRITER_LEASE_HELD, at most 60 s),
 * while the approval keeps more than 10 s. HEAD spends an approval only inside its commit, so a refusal never uses one.
 * @param input - the Pearl's id, the approval and what it has left, and the page's hooks.
 * @returns the outcome, in the same terms as a landing from her staged file.
 */
export async function promoteStagedOnHead(input: {
  readonly ballId: string
  readonly token: string
  /**
   * The exact request body the approval binds, when it binds one (an organ set, aumlok/organ-set.ts): sent as it is, and
   * it must name `ballId`. Absent: the body is `{ ballId }`, as for a governance Pearl.
   */
  readonly body?: Readonly<Record<string, unknown>>
  /** What the approval has left by the host's clock, read at each use. */
  readonly approvalLeftMs: () => number
  readonly signal: AbortSignal
  readonly onStep?: (step: LandStep) => void
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<PromotionOutcome> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const now = input.now ?? Date.now
  const wait = input.wait ?? pause
  let heldBy: string | null = null
  for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
    if (input.signal.aborted) return { kind: 'not-sent', why: 'stopped' }
    if (input.approvalLeftMs() < APPROVAL_SEND_MARGIN_MS) {
      return attempt === 0 ? { kind: 'not-sent', why: 'approval-expiring' } : { kind: 'not-sent', why: 'lease-busy', heldBy }
    }
    input.onStep?.({ kind: 'promoting' })
    let status = 0
    let answer: Record<string, unknown> | null = null
    try {
      const response = await fetchImpl(HEAD_PROMOTE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-x6-class3-approval': input.token },
        body: JSON.stringify(input.body ?? { ballId: input.ballId }),
        signal: input.signal,
      })
      status = response.status
      try { const parsed: unknown = JSON.parse(await response.text()); answer = isRecord(parsed) ? parsed : null } catch { answer = null }
    } catch { status = 0 }
    // LANDED ONLY AS THIS PEARL: an ok that names another Pearl, or none, is not taken as this one.
    if (status === 200 && answer?.ok === true && answer.ballId === input.ballId) return { kind: 'landed' }
    const code = typeof answer?.code === 'string' ? answer.code : null
    // HEAD says the Pearl it held is already published: this one, when it names this id.
    if (code === 'ALREADY_PUBLISHED' && isRecord(answer?.supersededStaged) && answer.supersededStaged.ballId === input.ballId) return { kind: 'landed' }
    if (code === 'WRITER_LEASE_HELD') {
      // HELD (her worker writing, most often): nothing was published and the approval was not used. Ask again shortly.
      // HEAD's promote route answers the held lease without naming it (head-do.mjs), so the lease is read for its holder and
      // its lapse, as a landing from her file does; an answer that does name it is used as it is.
      const named = isRecord(answer?.lease) ? leaseOf(answer.lease) : null
      const read = named === null ? await readHeadLease(input.signal, fetchImpl) : null
      // The same answer names HEAD's Pearl: another window's approval may just have landed this one.
      if (read?.head?.ballId === input.ballId) return { kind: 'landed' }
      const held = named ?? read?.lease ?? null
      heldBy = held?.ownerPeerId ?? heldBy
      // Held: until it lapses. Free by now: ask again at once (the 1 s minimum). Not read: the 5 s maximum, never every second.
      const until = held !== null && Number.isFinite(held.expiresAt) ? held.expiresAt
        : read !== null && read.unread === null ? now() : now() + LEASE_POLL_MAX_MS
      const delay = Math.min(Math.max(until - now() + 250, LEASE_POLL_MIN_MS), LEASE_POLL_MAX_MS)
      if (input.approvalLeftMs() - delay < APPROVAL_SEND_MARGIN_MS) return { kind: 'not-sent', why: 'lease-busy', heldBy }
      input.onStep?.({ kind: 'waiting', heldBy, seconds: Math.ceil(delay / 1000) })
      await wait(delay, input.signal)
      continue
    }
    // HEAD NO LONGER HOLDS IT (another window's approval landed it, and HEAD drops its record on a landing): the Pearl is
    // looked for on HEAD before this is called a refusal.
    if (code === 'CANDIDATE_UNKNOWN' || code === 'CANDIDATE_SUPERSEDED') {
      if ((await readHeadLease(input.signal, fetchImpl)).head?.ballId === input.ballId) return { kind: 'landed' }
      return { kind: 'refused', code }
    }
    if (status >= 400 && status < 500 && code !== null) return { kind: 'refused', code }
    if (code !== null && PRE_COMMIT_5XX.has(`${String(status)} ${code}`)) return { kind: 'refused', code }
    // UNCLEAR (a 5xx, a cut answer, no answer) may hide a commit: HEAD is read again and the Pearl looked for.
    const again = await readHeadLease(input.signal, fetchImpl)
    if (again.head?.ballId === input.ballId) return { kind: 'landed' }
    return { kind: 'unclear', detail: status === 0 ? 'HEAD did not answer' : `HEAD answered ${String(status)}${code === null ? '' : ` ${code}`}`,
      headRead: again.unread === null && again.head !== null ? 'not-on-head' : 'unread' }
  }
  return { kind: 'not-sent', why: 'lease-busy', heldBy }
}
