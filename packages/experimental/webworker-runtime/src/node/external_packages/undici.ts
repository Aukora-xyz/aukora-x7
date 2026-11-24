/**
 * Aukora X5: `undici` for the browser worker. Real undici needs node:net/tls/assert; browser CORS blocks most direct
 * page fetches, so `fetch` goes through the deployment's web-eyes broker, `POST /_host/web-eyes {action:'fetch'}`.
 * The edge answers it (deploy/cloudflare/src/cloud-brokers.mjs webEyes) and so does the Mac host,
 * so code she runs or imports fetches the same way with the Mac off. Dispatcher classes are inert.
 *
 * THE BROKER'S LIMITS ARE THIS SHIM'S LIMITS, said plainly rather than hidden: GET (or HEAD, answered without a body)
 * of a public `https:` URL only; no redirects; text, HTML, Markdown and JSON only; at most 256 KiB; no query keys that
 * look like credentials; request headers are not forwarded. A non-2xx upstream answer, and every refusal, rejects with
 * a TypeError naming the broker's code, as undici's own `fetch failed` does.
 *
 * THE MAC HOST IS THE ONE EXCEPTION. Its web-eyes (server/local-host.mjs) is lossy for code: it ignores
 * `format: 'raw'`, strips HTML to text, and cuts bodies at 80,000 characters while still answering 200. So the Mac host
 * is read only through its own raw relay (`GET /api/fetch?url=`, marked `x-relay: 1`), as the shim always read it, and
 * its web-eyes content is never used.
 *
 * WHICH ONE THIS DEPLOYMENT IS is decided once per origin, without reading any target: the shim asks the broker an
 * action neither host performs. The edge refuses it with `macFallback: false` (every edge answer carries it); the Mac
 * host refuses it with a 400 and no such field. The decision is kept; an answer that is neither (signed out, a network
 * failure) decides nothing and the fetch rejects plainly. A network failure of the chosen transport rejects too: one
 * transport per deployment, no second read of the target, no lossy substitute.
 */
export const __esModule = true

const BROKER = '/_host/web-eyes'
/** The Mac host's raw relay (server/local-host.mjs `/api/fetch`); no edge route answers it. */
const MAC_RELAY = '/api/fetch'
/** An action neither host performs: the refusal says which host answered, and no target is read. */
const TRANSPORT_PROBE = { action: 'transport' } as const

/** What the broker answers for one fetch (cloud-brokers.mjs webEyes). */
interface WebEyesFetch {
  readonly ok?: unknown
  readonly code?: unknown
  readonly error?: unknown
  readonly status?: unknown
  readonly contentType?: unknown
  readonly content?: unknown
  /** The edge sets this (always false) on every web-eyes answer; the Mac host never does. */
  readonly macFallback?: unknown
}

/** The deployment's one transport for this shim. */
type Transport = 'edge-web-eyes' | 'mac-relay'

/** The decided transport per origin (a worker has one origin; specs load the module fresh). */
const decided = new Map<string, Transport>()
/** A decision being made, shared by every fetch that starts meanwhile. */
const deciding = new Map<string, Promise<Transport>>()

/** Why a stopped fetch rejects: the signal's own reason when it is an error, as fetch() does, else an AbortError. */
function stopReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

/** Settle as `work` does, or reject when the caller's signal stops first (the shared decision itself is not stopped). */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === null || signal === undefined) return await work
  if (signal.aborted) throw stopReason(signal)
  let onAbort = (): void => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(stopReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, stopped])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Ask the broker the probe action once and read which host refused it. Rejects when the answer decides nothing. */
async function probeTransport(origin: string): Promise<Transport> {
  let response: Response
  try {
    response = await globalThis.fetch(new URL(BROKER, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TRANSPORT_PROBE),
      credentials: 'same-origin',
    })
  } catch (error) {
    throw new TypeError(`fetch failed: ${BROKER} could not be reached to choose a transport`, { cause: error })
  }
  let answer: WebEyesFetch | null = null
  try { answer = await response.json() as WebEyesFetch } catch { answer = null }
  if (answer !== null && answer.macFallback === false) return 'edge-web-eyes'
  if (response.status === 400 && answer !== null && answer.ok === false && !('macFallback' in answer)) return 'mac-relay'
  throw new TypeError(`fetch failed: HTTP ${String(response.status)} from ${BROKER} decides no transport`)
}

/** This deployment's transport: decided once, kept; a failed decision is not kept, so the next fetch asks again. */
function transportFor(origin: string): Promise<Transport> {
  const known = decided.get(origin)
  if (known !== undefined) return Promise.resolve(known)
  let pending = deciding.get(origin)
  if (pending === undefined) {
    pending = probeTransport(origin).then(
      (transport) => { decided.set(origin, transport); deciding.delete(origin); return transport },
      (error: unknown) => { deciding.delete(origin); throw error },
    )
    deciding.set(origin, pending)
  }
  return pending
}

/**
 * Read the target through the Mac host's raw relay, forwarding the three headers it accepts. A network failure, or an
 * answer that is not the relay's (no `x-relay: 1`), rejects.
 * @returns The relayed answer with the upstream status and headers.
 */
async function viaMacRelay(target: string, method: string, init: RequestInit): Promise<Response> {
  const relay = new URL(MAC_RELAY, globalThis.location.origin)
  relay.searchParams.set('url', target)
  const asked = new Headers(init.headers)
  const forwarded = new Headers()
  for (const name of ['accept', 'user-agent', 'accept-language']) {
    const value = asked.get(name)
    if (value !== null) forwarded.set('x-relay-' + name, value)
  }
  const response = await globalThis.fetch(relay, { method, headers: forwarded, signal: init.signal ?? null, credentials: 'same-origin' })
  if (response.headers.get('x-relay') !== '1') {
    void response.body?.cancel().catch(() => {})
    throw new TypeError(`fetch relay unavailable (HTTP ${String(response.status)} from ${MAC_RELAY})`)
  }
  const reported = Number(response.headers.get('x-relay-status') ?? response.status)
  const status = Number.isInteger(reported) && reported >= 200 && reported <= 599 ? reported : 200
  const headers = new Headers()
  response.headers.forEach((value, name) => {
    if (name.startsWith('x-relay-h-')) headers.set(name.slice('x-relay-h-'.length), value)
  })
  const nullBody = method === 'HEAD' || [101, 204, 205, 304].includes(status)
  return new Response(nullBody ? null : response.body, { status, headers })
}

/** Read the target through the edge's web-eyes broker. Every refusal rejects with the broker's code. */
async function viaEdgeWebEyes(target: string, method: string, init: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(new URL(BROKER, globalThis.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // raw: the bytes as served; the broker otherwise turns HTML into readable text.
    body: JSON.stringify({ action: 'fetch', url: target, format: 'raw' }),
    signal: init.signal ?? null,
    credentials: 'same-origin',
  })
  let answer: WebEyesFetch | null = null
  try { answer = await response.json() as WebEyesFetch } catch { answer = null }
  if (!response.ok || answer === null || answer.ok !== true || typeof answer.content !== 'string') {
    const code = typeof answer?.code === 'string' ? answer.code : typeof answer?.error === 'string' ? answer.error : `HTTP ${String(response.status)}`
    throw new TypeError(`fetch failed: ${code} from ${BROKER} for ${target}`)
  }
  const status = typeof answer.status === 'number' && answer.status >= 200 && answer.status <= 599 ? answer.status : 200
  const headers = new Headers()
  if (typeof answer.contentType === 'string' && answer.contentType !== '') headers.set('content-type', answer.contentType)
  const nullBody = method === 'HEAD' || [101, 204, 205, 304].includes(status)
  return new Response(nullBody ? null : answer.content, { status, headers })
}

export async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError(`fetch failed: ${method} is not available here; the web-eyes broker only reads (GET) public https pages`)
  }
  const transport = await untilStopped(transportFor(globalThis.location.origin), init.signal)
  return transport === 'mac-relay' ? await viaMacRelay(target, method, init) : await viaEdgeWebEyes(target, method, init)
}

/** Dispatchers take any constructor arguments (subclasses inherit the default constructor) and do nothing. */
class Inert {
  close(): Promise<void> { return Promise.resolve() }
  destroy(): Promise<void> { return Promise.resolve() }
}
export class Agent extends Inert {}
export class Pool extends Inert {}
export class ProxyAgent extends Inert {}
export class EnvHttpProxyAgent extends Inert {}
let dispatcher: unknown = new Agent()
export function getGlobalDispatcher(): unknown { return dispatcher }
export function setGlobalDispatcher(next: unknown): void { dispatcher = next }
export const Headers_ = globalThis.Headers
export { Headers_ as Headers }
export const Request_ = globalThis.Request
export { Request_ as Request }
export const Response_ = globalThis.Response
export { Response_ as Response }
export default { fetch, Agent, Pool, ProxyAgent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher }
