/**
 * A fetch that FAILS when the network stops answering, and never while bytes are still arriving (the boot stall:
 * the app sat forever on "Loading plugins…" whenever the network dropped during boot).
 *
 * The deadline is an IDLE deadline, not a total cap, and it times only the NETWORK: it runs while the headers are
 * awaited and while a body read is pending, and it is suspended whenever the consumer is not asking for bytes
 * (downstream backpressure), so a slow 80 MB snapshot that keeps arriving, or a fully received body its consumer reads
 * late, is never cut off. A pending read that receives nothing for `idleMs` fails with a named code
 * (`<CODE>: no bytes for Ns while fetching <what>`). The returned Response streams the same bytes.
 *
 * Every way a read ends (done, error, stall, caller abort, consumer cancel) goes through ONE terminal cleanup: the
 * timer is cleared, the caller's abort listener removed, and the source reader cancelled or released.
 * @module idle-fetch
 */

export interface IdleFetchOptions {
  /** Longest silence allowed, in milliseconds, before a pending read fails. */
  readonly idleMs: number
  /** Named failure code, e.g. BOOT_IMAGE_STALLED. */
  readonly code: string
  /** Words for what was being fetched, for the failure message. */
  readonly what: string
  /** Called with the running byte count as body bytes arrive. */
  readonly onBytes?: (bytes: number) => void
  readonly fetchImpl?: typeof fetch
}

/** Every body chunk any idleFetch receives, as a byte count; the worker boot reports these as progress. */
const byteWatchers = new Set<(bytes: number) => void>()

/**
 * Watch the bytes every idleFetch read receives (the image, overlays, lazy archives, her head).
 * @param watcher - Called with each chunk's byte length.
 * @returns Stops watching.
 */
export function watchIdleFetchBytes(watcher: (bytes: number) => void): () => void {
  byteWatchers.add(watcher)
  return () => { byteWatchers.delete(watcher) }
}

/** The error an idle deadline raises: its message starts with the code, and `code` carries it. */
export function idleStallError(options: Pick<IdleFetchOptions, 'idleMs' | 'code' | 'what'>): Error & { code: string } {
  const seconds = Math.max(1, Math.round(options.idleMs / 1000))
  return Object.assign(new Error(`${options.code}: no bytes for ${String(seconds)}s while fetching ${options.what}`), { code: options.code })
}

/**
 * Fetch with an idle deadline over the headers and every pending body read.
 * @param input - URL to fetch.
 * @param init - Request init; its own signal, if any, still aborts the read.
 * @param options - Idle deadline, failure code and progress hook.
 * @returns A Response whose body fails with the named code if it stalls. A caller that does not want the body (an
 *   HTTP error, say) must cancel it, which ends the read at once.
 */
export async function idleFetch(input: string, init: RequestInit, options: IdleFetchOptions): Promise<Response> {
  const controller = new AbortController()
  const stalled = idleStallError(options)
  const outer = init.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = undefined
  let finished = false
  /** Read through a call: an await may have ended the read meanwhile. */
  const ended = (): boolean => finished
  /** Why the read was aborted (a stall or the caller's reason), else the error itself. */
  const why = (error: unknown): unknown => (controller.signal.aborted ? controller.signal.reason as unknown : error)
  /** How the current stage fails: rejects the headers, or errors the body. */
  let failStage: ((reason: unknown) => void) | undefined
  const disarm = (): void => { clearTimeout(timer); timer = undefined }
  /** The one terminal cleanup: no timer, no listener, the source reader cancelled (on failure) and released. */
  const finish = (cancelReason?: unknown): void => {
    if (finished) return
    finished = true
    disarm()
    outer?.removeEventListener('abort', forward)
    if (reader === undefined) return
    if (cancelReason !== undefined) void reader.cancel(cancelReason).catch(() => {})
    try { reader.releaseLock() } catch { /* already released */ }
  }
  const fail = (reason: unknown): void => {
    controller.abort(reason)
    failStage?.(reason)
    finish(reason)
  }
  // Timed only while the network owes bytes: the headers, or a read the consumer is waiting on.
  const arm = (): void => {
    disarm()
    timer = setTimeout(() => { timer = undefined; fail(stalled) }, options.idleMs)
  }
  function forward(): void { fail(outer?.reason) }
  if (outer?.aborted) throw outer.reason
  outer?.addEventListener('abort', forward, { once: true })
  let response: Response
  try {
    arm()
    // The headers race the deadline too: a fetch that never answers is a stall, not a wait.
    response = await new Promise<Response>((resolve, reject) => {
      failStage = reject
      ;(options.fetchImpl ?? fetch)(input, { ...init, signal: controller.signal }).then(resolve, reject)
    })
    disarm()
  } catch (error) {
    const reason = why(error)
    finish(reason)
    throw reason
  }
  if (ended()) {
    // An abort or stall landed while the headers were completing: the read is already over. The body is cancelled and
    // the caller gets the reason, never a Response whose body would hang with its source locked.
    const reason = why(undefined)
    await response.body?.cancel(reason).catch(() => {})
    throw reason
  }
  if (response.body === null) {
    finish()
    return response
  }
  const source = response.body.getReader()
  reader = source
  let bytes = 0
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      failStage = (reason) => { try { stream.error(reason) } catch { /* already closed */ } }
    },
    async pull(stream) {
      if (finished) return
      arm()
      let part: ReadableStreamReadResult<Uint8Array>
      try {
        part = await source.read()
      } catch (error) {
        fail(why(error))
        return
      }
      if (ended()) return
      // The read answered: the clock stops until the consumer asks again (a paused consumer is never a stall).
      disarm()
      if (part.done) {
        finish()
        stream.close()
        return
      }
      bytes += part.value.byteLength
      try {
        options.onBytes?.(bytes)
        for (const watcher of byteWatchers) watcher(part.value.byteLength)
      } catch (error) {
        // A progress callback that throws ends the read through the same terminal cleanup as any failure.
        fail(error)
        return
      }
      stream.enqueue(part.value)
    },
    cancel(reason) {
      // The consumer gave up (an HTTP error body, say): the source is cancelled now, not left until a timeout.
      failStage = undefined
      finish(reason ?? new Error(`${options.code}: the reader cancelled ${options.what}`))
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
