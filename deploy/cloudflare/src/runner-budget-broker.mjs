// The browser never supplies a budget key, owner, world, clock, or pick.
export const RUNNER_BUDGET_PATH = '/_head/runner-budget-v1'
const SHA = /^[a-f0-9]{64}$/
const ID = /^[a-z0-9-]{16,64}$/
const pickScopes = new WeakMap()
const REC = 'node-main-v1'

function failure(code, status, fields={}) {
  return Object.assign(new Error(code), { code, status, ...fields })
}

/** Create internal budget scope only after the host has verified the active PICK.
 * The token conveys no execution authority and cannot be serialized as a tool argument. */
export function createRunnerPickScope(verifiedPickId, { reserveLocal, requestId } = {}) {
  if (typeof verifiedPickId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(verifiedPickId)) throw failure('EXEC_PICK_SCOPE_INVALID', 503)
  const scope = Object.freeze({})
  if (reserveLocal !== undefined && (typeof reserveLocal !== 'function' || typeof requestId !== 'string' || !ID.test(requestId))) throw failure('EXEC_PICK_SCOPE_INVALID', 503)
  pickScopes.set(scope, { pickId: verifiedPickId, reserveLocal, requestId })
  return scope
}

export async function reserveRunnerMinutesAtHead({ head, seedId, minutes, requestId, requestHash, signal, pickScope, requireLocal = false }) {
  const scope = pickScope === undefined ? undefined : pickScopes.get(pickScope)
  if ((pickScope !== undefined && !scope) || (requireLocal && !scope?.reserveLocal)) throw failure('EXEC_PICK_SCOPE_INVALID', 503)
  if (typeof seedId !== 'string' || !SHA.test(seedId)
    || typeof requestId !== 'string' || !ID.test(requestId) || typeof requestHash !== 'string' || !SHA.test(requestHash)
    || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 30) {
    throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
  }
  if (scope?.reserveLocal) {
    try {
      signal?.throwIfAborted()
      const result = await scope.reserveLocal({ minutes, requestId: scope.requestId, requestHash })
      signal?.throwIfAborted()
      if (result?.dispatch !== true) throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
      return { ok: true }
    } catch (error) {
      if (error?.code === 'EXEC_RATE_LIMITED' && Number.isSafeInteger(error.retryAt)) throw failure('EXEC_RATE_LIMITED', 429, { retryAt: error.retryAt, limit: '600 runner minutes per UTC day' })
      if (error?.code === 'PICK_RATE_LIMITED') throw failure('PICK_RATE_LIMITED', 429)
      throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
    }
  }
  if (!head || typeof head.idFromName !== 'function') throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
  const pickId = scope?.pickId
  let response, data
  try {
    signal?.throwIfAborted()
    response = await head.get(head.idFromName(REC)).fetch(new Request('https://x61.internal' + RUNNER_BUDGET_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId },
      body: JSON.stringify({ minutes, requestId, requestHash, ...(pickId === undefined ? {} : { pickId }) }),
      signal,
    }))
    data = await response.json()
    signal?.throwIfAborted()
  } catch {
    throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
  }
  if (response.status === 429 && data?.code === 'EXEC_RATE_LIMITED' && Number.isSafeInteger(data.retryAt)) {
    throw failure('EXEC_RATE_LIMITED', 429, { retryAt: data.retryAt, limit: '600 runner minutes per UTC day' })
  }
  if (response.status === 429 && data?.code === 'PICK_RATE_LIMITED') throw failure('PICK_RATE_LIMITED', 429)
  if (!response.ok || data?.ok !== true || data.reservedMinutes !== minutes || data.dispatch !== true) {
    throw failure('EXEC_BUDGET_UNAVAILABLE', 503)
  }
  return { ok: true }
}
