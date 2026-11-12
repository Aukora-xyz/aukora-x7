// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S GENESIS RPC, POINTED AT THIS PAGE'S OWN DSH.
 *
 * The predecessor's x5 surfaces (an earlier repository) called DeepSeek Harness API methods (`settings/describe`,
 * `settings/mutate`, `session/list`, …) through a Genesis iframe's `__DSH_TRANSPORT__`. On x6.1 the Spatial shell IS
 * that DSH: the same `client-request` envelope goes through this page's own tunnel (the one the stock client uses) and
 * answers `server-response`. Nothing here adds a route or an authority; it is the call the stock settings page makes.
 *
 * @module x5/rpc
 */

interface Tunnel {
  fetch(input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    status: number
    text(): Promise<string>
  }>
}

const tunnel = (): Tunnel | null => {
  const transport = (globalThis as { __DSH_TRANSPORT__?: Partial<Tunnel> }).__DSH_TRANSPORT__
  return typeof transport?.fetch === 'function' ? (transport as Tunnel) : null
}

/** One DSH API error, with the server's own code when it gave one. */
export class DshRpcError extends Error {
  constructor(readonly method: string, readonly code: string | null, message: string) {
    super(`${method}: ${message}`)
    this.name = 'DshRpcError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A v4-shaped request id from `getRandomValues` (which, unlike `randomUUID`, works on plain-HTTP LAN pages). */
function mintRpcId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Typed readers for the loosely shaped answers these surfaces display (no `any`). */
export const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
export const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
export const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** A method's `value` (the `{ ok, value }` result most DSH methods answer), or the result itself. */
export const valueOf = (result: unknown): unknown => (isRecord(result) && 'value' in result ? result.value : result)

/**
 * Call one DSH API method on this page's own host.
 * @param method - e.g. `settings/describe`.
 * @param args - the method's arguments (`payload.args`).
 * @param signal - aborts the call.
 * @returns the `result` object (`{ ok: true, value }` for most methods), exactly as the server sent it.
 */
export async function dshRpc(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
  const t = tunnel()
  if (t === null) throw new DshRpcError(method, 'tunnel-unavailable', 'this page has no DSH transport yet')
  const response = await t.fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: mintRpcId(), method, payload: { args } }),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new DshRpcError(method, 'unreadable', `answered ${String(response.status)} with non-JSON`) }
  const result = isRecord(body) && isRecord(body.result) ? body.result : body
  if (isRecord(result) && result.ok === false) {
    const error = isRecord(result.error) ? result.error : {}
    throw new DshRpcError(method, typeof error.code === 'string' ? error.code : null,
      typeof error.message === 'string' ? error.message : 'refused')
  }
  if (response.status < 200 || response.status >= 300) throw new DshRpcError(method, String(response.status), 'refused')
  return result
}
