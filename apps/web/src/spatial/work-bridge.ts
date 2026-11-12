/**
 * THE ONE SUPERAGENT READER, HANDED TO THE SPATIAL SHELL.
 *
 * The Spatial shell lives in a Cordis client package (`packages/client/ui-layout`), which cannot import from
 * `apps/web`. The readout (`./superagent/`) is the canonical page-side reader: it asks Auma's own organs
 * (`auma_superagent` status, `seed_receipts` verify) through the existing `POST /__x6__/call-tool` worker route and
 * classifies every answer. This bridge publishes that reader and the same call path on the page, so the shell's Work
 * surface uses it instead of a second parser. One rule is applied on the way in (`withoutUngrantedReceiptClaims`):
 * a mandate that was never granted names no grant receipt. Nothing here adds a route, a session, or authority: an action sent
 * through `callTool` is exactly the tool call the model itself can make.
 */
import {
  CALL_TOOL_PATH, MAX_TOOL_BODY_CHARS, STATUS_SCHEMA, SUPERAGENT_TOOL_NAMES, classifyToolBody, pageTunnelFetch,
  type ToolBody, type TunnelFetch,
} from './superagent/contract.ts'
import { RECEIPTS_LOG_PATH } from './superagent/authority.ts'
import { OWNER_GRANT_SCHEMA } from './superagent/owner-grant.ts'
import { createSuperagentRead, type SuperagentReadOptions } from './superagent/read.ts'

/** The page global the Spatial Work surface reads. Bump `version` on any shape change. */
export const WORK_BRIDGE_GLOBAL = '__AUKORA_SUPERAGENT__'

export interface WorkBridge {
  readonly version: 1
  readonly createRead: typeof createSuperagentRead
  /**
   * Call one worker tool through the page tunnel and classify the answer with the readout's own rules.
   * @returns `{ kind: 'aborted' }` when `signal` aborted, otherwise the readout's `ToolBody`.
   */
  readonly callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolBody | { kind: 'aborted' }>
}

async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolBody | { kind: 'aborted' }> {
  const fetch = pageTunnelFetch()
  if (fetch === null) return { kind: 'control-unavailable' }
  try {
    const response = await fetch(CALL_TOOL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args }),
      signal,
    })
    const text = await response.text()
    if (signal.aborted) return { kind: 'aborted' }
    return classifyToolBody(response.status, text.length > MAX_TOOL_BODY_CHARS + 1 ? text.slice(0, MAX_TOOL_BODY_CHARS + 1) : text)
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' }
    return { kind: 'transport', detail: error instanceof Error ? error.message.slice(0, 500) : null, truncated: false }
  }
}

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * NO GRANT, NO GRANT RECEIPT. Her organ's `status` writes each mandate's `receiptHash` — for a mandate that was never
 * granted, the head of the receipt log when it was proposed — and copies it into `receiptLeafHash` when no grant
 * leaf exists (`seed-superagent.js` status). The readout then links that unrelated receipt (a `ball.promote`, say) and
 * shows a never-granted mandate as `chain-linked`. A mandate with no `grant` that is not `confirmed` names no grant
 * receipt, so both fields are dropped before the readout sees them, and it reads "no receipt claim". Resolved
 * attention, which her organ already filters, is dropped too. Nothing else in her answer is touched; once her organ
 * stops copying the head (Round 7, her lane) this changes nothing.
 * @param status - one parsed `auma.superagent.status.v1` object; mutated in place.
 * @returns how many mandates lost a receipt claim, and how many resolved rows were dropped.
 */
export function dropUngrantedReceiptClaims(status: Json): { mandates: number; resolved: number } {
  let mandates = 0
  if (Array.isArray(status.mandates)) {
    for (const m of status.mandates) {
      if (!isJson(m) || m.confirmed === true || (m.grant !== null && m.grant !== undefined)) continue
      if (m.receiptHash === null && m.receiptLeafHash === null) continue
      m.receiptHash = null
      m.receiptLeafHash = null
      mandates++
    }
  }
  let resolved = 0
  if (Array.isArray(status.attention)) {
    const kept = status.attention.filter(a => !(isJson(a) && a.resolved === true))
    resolved = status.attention.length - kept.length
    status.attention = kept
  }
  return { mandates, resolved }
}

/**
 * Apply {@link dropUngrantedReceiptClaims} to a `/__x6__/call-tool` body, wherever the status object sits in it
 * (`raw`, `output`, or a JSON string inside either, as `payloadOf` in the readout accepts). Unparseable text, or a
 * body with no status object, comes back unchanged, so the readout classifies it exactly as before.
 * @param text - the response body as the worker sent it.
 * @returns the body with ungranted mandates' receipt claims dropped.
 */
export function withoutUngrantedReceiptClaims(text: string): string {
  return readStatusBody(text).text
}

/**
 * Owner-grant envelopes her status carries: a mandate's `ownerGrant`, or its `grant.ownerGrant`. Only objects that
 * name the `aukora.x6.owner-grant.v1` schema are taken; whether they verify is the readout's decision, never this one's.
 * @param status - one parsed `auma.superagent.status.v1` object.
 * @returns the envelopes, in mandate order.
 */
export function ownerGrantsOf(status: Json): unknown[] {
  const found: unknown[] = []
  if (!Array.isArray(status.mandates)) return found
  for (const m of status.mandates) {
    if (!isJson(m)) continue
    const grant = isJson(m.grant) ? m.grant : null
    for (const candidate of [m.ownerGrant, grant?.ownerGrant]) {
      if (isJson(candidate) && candidate.schema === OWNER_GRANT_SCHEMA && !found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Owner-grant envelopes embedded in her receipt log: `data.ownerGrant` on `mandate.grant` receipts (once her
 * organ writes the verified envelope into the grant receipt). Unparseable lines are skipped; verifying is the readout's.
 * @param text - the receipt log, one canonical JSON receipt per line.
 * @returns the envelopes, in log order.
 */
export function ownerGrantsInReceipts(text: string): unknown[] {
  const found: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let receipt: unknown
    try { receipt = JSON.parse(line) } catch { continue }
    if (!isJson(receipt) || receipt.kind !== 'mandate.grant' || !isJson(receipt.data)) continue
    const envelope = receipt.data.ownerGrant
    if (isJson(envelope) && envelope.schema === OWNER_GRANT_SCHEMA) found.push(envelope)
  }
  return found
}

/**
 * One pass over a `/__x6__/call-tool` body: drop ungranted mandates' receipt claims and collect owner envelopes.
 * @param text - the response body as the worker sent it.
 * @returns the (possibly rewritten) body and the envelopes found.
 */
function readStatusBody(text: string): { text: string; ownerGrants: unknown[] } {
  const ownerGrants: unknown[] = []
  const visit = (value: unknown, depth: number): { value: unknown; changed: boolean } => {
    if (depth > 3) return { value, changed: false }
    if (typeof value === 'string') {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { return { value, changed: false } }
      const inner = visit(parsed, depth + 1)
      return inner.changed ? { value: JSON.stringify(inner.value), changed: true } : { value, changed: false }
    }
    if (!isJson(value)) return { value, changed: false }
    if (value.schema === STATUS_SCHEMA) {
      ownerGrants.push(...ownerGrantsOf(value))
      const dropped = dropUngrantedReceiptClaims(value)
      return { value, changed: dropped.mandates > 0 || dropped.resolved > 0 }
    }
    let changed = false
    for (const field of ['raw', 'output'] as const) {
      if (value[field] === undefined) continue
      const inner = visit(value[field], depth + 1)
      if (inner.changed) { value[field] = inner.value; changed = true }
    }
    return { value, changed }
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { return { text, ownerGrants } }
  const result = visit(body, 0)
  return { text: result.changed ? JSON.stringify(result.value) : text, ownerGrants }
}

/** Whether a call-tool request asks her SuperAgent organ for `status`. */
function isStatusRead(init: Parameters<TunnelFetch>[1]): boolean {
  if (typeof init?.body !== 'string') return false
  try {
    const request = JSON.parse(init.body) as { name?: unknown; args?: { action?: unknown } }
    return (SUPERAGENT_TOOL_NAMES as readonly unknown[]).includes(request.name) && request.args?.action === 'status'
  } catch {
    return false
  }
}

/**
 * The page tunnel, with status answers passed through {@link readStatusBody}. Each status answer refills `attestations`
 * — the owner envelopes it carries — BEFORE the body reaches the readout,
 * whose evidence step reads that same list. It resolves the tunnel on every call; a tunnel that has gone away surfaces
 * as a transport failure.
 * @param attestations - the reader's live owner-attestation list (handed to the reader as `ownerAttestations`).
 * @returns the tunnel fetch for one reader.
 */
function statusTunnelFor(sources: OwnerSources): TunnelFetch {
  return async (input, init) => {
    const tunnel = pageTunnelFetch()
    if (tunnel === null) throw new Error('page tunnel unavailable')
    const response = await tunnel(input, init)
    if (input !== CALL_TOOL_PATH || !isStatusRead(init)) return response
    return {
      status: response.status,
      text: async () => {
        const read = readStatusBody(await response.text())
        sources.set('status', read.ownerGrants)
        return read.text
      },
    }
  }
}

/**
 * One reader's owner evidence, from two places: what her status carries and what her receipt log embeds. `list` is
 * the single array handed to the reader as `ownerAttestations`; each source replaces only its own share, so a status
 * answer never erases what the receipt log said in the same read.
 */
interface OwnerSources {
  readonly list: unknown[]
  set(source: 'status' | 'receipts', envelopes: readonly unknown[]): void
}

function ownerSources(): OwnerSources {
  const by: Record<'status' | 'receipts', readonly unknown[]> = { status: [], receipts: [] }
  const list: unknown[] = []
  const rebuild = (): void => {
    const all: unknown[] = []
    for (const item of [...by.receipts, ...by.status]) if (!all.includes(item)) all.push(item)
    list.splice(0, list.length, ...all)
  }
  return { list, set: (source, envelopes) => { by[source] = envelopes; rebuild() } }
}

/** The host's owner public key route (`server/local-host.mjs`). */
export const OWNER_KEY_PATH = '/_host/owner-key'

const HEX_64 = /^[0-9a-f]{64}$/
let ownerKey: { readonly publicKeyHex: string; readonly keyId: string | null } | null = null

/**
 * Read the host's owner public key (a plain same-origin host route, not the worker tunnel). Absent, refused or
 * malformed all mean "no owner key": the reader then trusts no owner key, which verifies nothing.
 * @param signal - aborts the read.
 * @returns the key, or null.
 */
async function readOwnerKey(signal?: AbortSignal): Promise<typeof ownerKey> {
  try {
    const response = await fetch(OWNER_KEY_PATH, { credentials: 'same-origin', cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
    if (!response.ok) return null
    const body = await response.json() as { ok?: unknown; publicKeyHex?: unknown; keyId?: unknown }
    if (body.ok !== true || typeof body.publicKeyHex !== 'string' || !HEX_64.test(body.publicKeyHex)) return null
    return { publicKeyHex: body.publicKeyHex, keyId: typeof body.keyId === 'string' ? body.keyId : null }
  } catch {
    return null
  }
}

/**
 * The reader, given {@link statusTunnel} when the page has a tunnel and the caller did not choose a fetch (with no
 * tunnel the reader reports "host unavailable" itself), and the host's owner key as `trustedOwnerKeys` once it has
 * been read. The key list is passed beside the options, so a reader that does not take it simply ignores it.
 */
const createRead: typeof createSuperagentRead = (options: SuperagentReadOptions = {}) => {
  const sources = ownerSources()
  const transport = options.fetch === undefined && pageTunnelFetch() !== null ? { fetch: statusTunnelFor(sources) } : {}
  // The receipt log the readout reads is the same text the envelopes are taken from: no second read.
  const callerRead = options.readText
  const evidence = callerRead === undefined ? {} : {
    readText: async (path: string, signal: AbortSignal) => {
      const file = await callerRead(path, signal)
      if (path === RECEIPTS_LOG_PATH && file.kind === 'ok') sources.set('receipts', ownerGrantsInReceipts(file.text))
      return file
    },
  }
  const owner = ownerKey === null ? {} : { trustedOwnerKeys: [ownerKey.publicKeyHex] }
  return createSuperagentRead({ ...options, ...transport, ...evidence, ...owner, ownerAttestations: sources.list })
}

/** Publish the bridge once. Safe to call more than once. */
export function installWorkBridge(): void {
  // The owner key is read once now so the first Work reader can trust it.
  void readOwnerKey().then((key) => { ownerKey = key })
  const bridge: WorkBridge = { version: 1, createRead, callTool }
  Object.defineProperty(globalThis, WORK_BRIDGE_GLOBAL, { value: bridge, configurable: true, enumerable: false, writable: false })
}
