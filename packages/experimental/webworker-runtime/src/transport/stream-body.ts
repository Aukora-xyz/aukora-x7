/**
 * Stream bodies on every engine. Found by trying, never by reading the user agent.
 *
 * - `for await` over a `ReadableStream` (its async iterator) is missing in some engines (Safari has lagged), so streams
 *   are read with an explicit `getReader()` loop; leaving early cancels the stream exactly as the iterator would.
 * - A `ReadableStream` request body (`duplex: 'half'`) is Chrome-only today: Safari refuses it, and Firefox turns the
 *   stream into the text "[object ReadableStream]". Where it is missing, the body is buffered first.
 * - A `ReadableStream` cannot be transferred through `postMessage` in every engine; where it cannot, the page buffers
 *   the body before it crosses to the worker.
 * Chrome takes the streaming path in each case, so its behaviour is unchanged.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/stream-body
 */

/**
 * Every chunk of a stream, oldest first, through a reader. Returning early (or a consumer `break`) cancels the stream.
 * @param stream - The stream to read; it is locked while this runs and released after.
 */
export async function* readStreamChunks<T>(stream: ReadableStream<T>): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader()
  let finished = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        finished = true
        return
      }
      yield next.value
    }
  } catch (error) {
    finished = true
    throw error
  } finally {
    // Leaving early cancels the source, and a rejection from the source's cancel() reaches the caller, as it does from
    // the native iterator's return(); the lock is released either way.
    try {
      if (!finished) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

/** Why a stopped read rejects: the signal's own reason when it is an error, as fetch() does, else a plain AbortError. */
function stopReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

/** One chunk as bytes; a chunk that is not bytes is refused, as `new Response(stream)` refuses it. */
function chunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new TypeError('request body stream produced a chunk that is not bytes')
}

/**
 * A stream's bytes as one buffer, read through a reader this function owns, for an engine that cannot send or transfer
 * the stream itself. The caller's signal is listened to BEFORE the first read: stopping cancels the source and rejects
 * at once, even while a read is pending, so a stalled or still-growing upload is not kept waiting or kept in memory.
 * The reader is released in every case.
 * @param stream - The body to read; it is locked while this runs.
 * @param signal - The caller's stop signal, if any.
 * @returns The bytes, in order.
 */
export async function bufferStream(stream: ReadableStream<unknown>, signal?: AbortSignal | null): Promise<ArrayBuffer> {
  const reader = stream.getReader()
  /** Set once: the stop's reason, or the failure that ended the read. Read through an object across awaits. */
  const state: { ended: { readonly reason: unknown; readonly stopped: boolean } | null } = { ended: null }
  let stop: (reason: Error) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => { stop = reject })
  stopped.catch(() => {})
  const onAbort = (): void => {
    if (signal === null || signal === undefined || state.ended !== null) return
    const reason = stopReason(signal)
    state.ended = { reason, stopped: true }
    stop(reason)
    // Cancelling settles a pending read and tells the source to stop producing; its answer is not waited for.
    void reader.cancel(reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    if (signal?.aborted === true) onAbort()
    for (;;) {
      const next = await Promise.race([reader.read(), stopped])
      // A cancel settles the pending read as done: that is the stop, never the end of the body.
      if (state.ended?.stopped === true) throw state.ended.reason
      if (next.done) break
      const chunk = chunkBytes(next.value)
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } catch (error) {
    if (state.ended === null) {
      state.ended = { reason: error, stopped: false }
      void reader.cancel(error).catch(() => {})
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

/** A promise that rejects when the signal stops, and otherwise settles as `work` does. */
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

/** The Request constructor shape the probe calls. */
type RequestConstructor = new (input: string, init: RequestInit & { readonly duplex?: string }) => { readonly headers: Headers }

/**
 * Whether this engine sends a `ReadableStream` as a request body (the web.dev feature test): a supporting engine reads
 * the `duplex` member and does not stringify the stream into a text/plain body.
 * @param Ctor - The Request constructor; defaults to the global one.
 * @returns True only when streaming request bodies work.
 */
export function requestStreamsSupported(Ctor: unknown = globalThis.Request): boolean {
  if (typeof Ctor !== 'function' || typeof ReadableStream !== 'function') return false
  // Written by the getter during construction, so it is an object the compiler does not narrow to its first value.
  const seen = { duplex: false }
  try {
    const probe = new (Ctor as RequestConstructor)('https://engine-probe.invalid/', {
      method: 'POST',
      body: new ReadableStream(),
      get duplex() {
        seen.duplex = true
        return 'half'
      },
    })
    return seen.duplex && !probe.headers.has('content-type')
  } catch {
    return false
  }
}

/**
 * A request's body as one buffer, for an engine that cannot send it as a stream. GET and HEAD carry none. Where the
 * engine exposes the body stream it is read through {@link bufferStream}, so stopping cancels it; an engine without
 * the `Request.prototype.body` getter is read with `arrayBuffer()`, and stopping still rejects at once.
 * @param request - The request whose body is forwarded.
 * @param signal - The stop signal; defaults to the request's own.
 * @returns The body bytes, or null for a bodyless method.
 */
export async function bufferedRequestBody(
  request: Request, signal: AbortSignal | null | undefined = request.signal,
): Promise<ArrayBuffer | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return null
  if (signal?.aborted === true) throw stopReason(signal)
  const body: unknown = request.body
  if (body instanceof ReadableStream) return await bufferStream(body, signal)
  return await untilStopped(request.arrayBuffer(), signal)
}

/**
 * A fetch init whose stream body is buffered, for an engine that cannot send a stream (`fetch(url, { body: stream })`):
 * the same init with the bytes in place of the stream and no `duplex`. Stopping the init's signal cancels the stream.
 * @param init - The caller's init; its body must be a stream.
 * @returns The init to forward.
 */
export async function bufferedStreamInit(init: RequestInit & { readonly body: ReadableStream<unknown> }): Promise<RequestInit> {
  const { duplex: _duplex, ...rest } = init as RequestInit & { readonly duplex?: unknown }
  return { ...rest, body: await bufferStream(init.body, init.signal) }
}

/**
 * Whether a `ReadableStream` can be transferred through `postMessage` in this engine.
 * @param Channel - The MessageChannel constructor; defaults to the global one.
 * @returns True when the transfer succeeds.
 */
export function streamsTransferable(Channel: unknown = globalThis.MessageChannel): boolean {
  if (typeof Channel !== 'function' || typeof ReadableStream !== 'function') return false
  let channel: MessageChannel | undefined
  try {
    channel = new (Channel as typeof MessageChannel)()
    const stream = new ReadableStream()
    channel.port1.postMessage(stream, [stream])
    return true
  } catch {
    return false
  } finally {
    channel?.port1.close()
    channel?.port2.close()
  }
}
