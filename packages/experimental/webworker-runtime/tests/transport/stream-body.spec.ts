/**
 * Stream bodies on engines without a ReadableStream async iterator, streaming request bodies, or
 * transferable streams. Each missing feature is simulated by removing or refusing it; the bytes that arrive must be the
 * same bytes the Chrome path carries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferedRequestBody, bufferedStreamInit, bufferStream, readStreamChunks, requestStreamsSupported, streamsTransferable,
} from '../../src/transport/stream-body.ts'
import { createSyntheticExchange, type ResponseSink } from '../../src/transport/synthetic-http.ts'
import type { TunnelRequestFrame } from '../../src/transport/frames.ts'

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values)
function streamOf(chunks: Uint8Array<ArrayBuffer>[], onCancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index++]
      if (next === undefined) controller.close()
      else controller.enqueue(next)
    },
    cancel(reason) { onCancel?.(reason) },
  })
}

describe('readStreamChunks: a reader loop, not the stream\'s async iterator', () => {
  it('yields every chunk in order and releases the stream', async () => {
    const stream = streamOf([bytes(1, 2), bytes(3)])
    const seen: number[] = []
    for await (const chunk of readStreamChunks(stream)) seen.push(...chunk)
    expect(seen).toEqual([1, 2, 3])
    expect(stream.locked).toBe(false)
  })

  it('leaving early cancels the stream, as the iterator would', async () => {
    const cancelled: unknown[] = []
    const stream = streamOf([bytes(1), bytes(2), bytes(3)], (reason) => { cancelled.push(reason) })
    for await (const chunk of readStreamChunks(stream)) { if (chunk[0] === 1) break }
    expect(cancelled).toHaveLength(1)
    expect(stream.locked).toBe(false)
  })

  it('a rejection from the source\'s cancel() reaches the caller, as native iteration propagates it, and the lock is released', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes(1)) },
      cancel() { return Promise.reject(new Error('cancel refused')) },
    })
    const leaveEarly = async (): Promise<void> => { for await (const _chunk of readStreamChunks(stream)) break }
    await expect(leaveEarly()).rejects.toThrow('cancel refused')
    expect(stream.locked).toBe(false)
  })

  it('a stream error reaches the consumer', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('broken pipe')) } })
    const read = async (): Promise<void> => { for await (const _chunk of readStreamChunks(stream)) { /* drain */ } }
    await expect(read()).rejects.toThrow('broken pipe')
  })
})

describe('the worker reads request bodies without ReadableStream[Symbol.asyncIterator] (older Safari)', () => {
  const iterator = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator)
  afterEach(() => { if (iterator !== undefined) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, iterator) })

  const sink: ResponseSink = { head: () => {}, chunk: () => {}, end: () => {}, fail: () => {} }
  const frame = (body: TunnelRequestFrame['body']): TunnelRequestFrame =>
    ({ t: 'req', id: 1, method: 'POST', url: '/upload', headers: {}, body })
  async function drain(req: unknown): Promise<number[]> {
    const out: number[] = []
    for await (const chunk of req as AsyncIterable<Uint8Array>) out.push(...chunk)
    return out
  }

  it('a stream body and a Blob body both arrive whole', async () => {
    Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator)
    expect((ReadableStream.prototype as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBeUndefined()
    const streamed = createSyntheticExchange(frame(streamOf([bytes(1, 2), bytes(), bytes(3)])), sink)
    expect(await drain(streamed.req)).toEqual([1, 2, 3])
    const blob = createSyntheticExchange(frame(new Blob([bytes(4, 5)])), sink)
    expect(await drain(blob.req)).toEqual([4, 5])
  })

  it('a non-byte chunk is still refused', async () => {
    Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator)
    const odd = new ReadableStream({ start(controller) { controller.enqueue('text'); controller.close() } })
    const exchange = createSyntheticExchange(frame(odd as ReadableStream<Uint8Array>), sink)
    await expect(drain(exchange.req)).rejects.toThrow('non-Uint8Array chunk')
  })
})

describe('feature tests, never the user agent', () => {
  it('streaming request bodies: an engine that reads duplex and keeps the stream supports them', () => {
    class Streams { readonly headers = new Headers(); constructor(_url: string, init: { duplex?: string }) { void init.duplex } }
    class Stringifies { readonly headers = new Headers({ 'content-type': 'text/plain;charset=UTF-8' }); constructor(_url: string, init: { duplex?: string }) { void init.duplex } }
    class IgnoresDuplex { readonly headers = new Headers() }
    function Refuses(): void { throw new TypeError('ReadableStream uploading is not supported') }
    expect(requestStreamsSupported(Streams)).toBe(true)
    expect(requestStreamsSupported(Stringifies)).toBe(false) // Firefox: the stream became "[object ReadableStream]"
    expect(requestStreamsSupported(IgnoresDuplex)).toBe(false) // Safari: duplex unknown
    expect(requestStreamsSupported(Refuses)).toBe(false)
    expect(requestStreamsSupported(null)).toBe(false)
  })

  it('transferable streams: a refused transfer means the page buffers', () => {
    class Refusing {
      readonly port1 = { postMessage: () => { throw new DOMException('ReadableStream could not be cloned', 'DataCloneError') }, close: () => {} }
      readonly port2 = { close: () => {} }
    }
    expect(streamsTransferable(Refusing)).toBe(false)
    expect(streamsTransferable(null)).toBe(false)
    expect(streamsTransferable()).toBe(true) // Node transfers web streams
  })
})

describe('the model door forwards a buffered body where stream bodies are missing (Safari, Firefox)', () => {
  it('a POST body arrives as the same bytes; GET and HEAD carry none', async () => {
    const post = new Request('https://api.example.invalid/v1/messages', { method: 'POST', body: '{"model":"m"}' })
    const body = await bufferedRequestBody(post)
    expect(new TextDecoder().decode(body ?? new ArrayBuffer(0))).toBe('{"model":"m"}')
    expect(await bufferedRequestBody(new Request('https://api.example.invalid/v1/models'))).toBeNull()
    expect(await bufferedRequestBody(new Request('https://api.example.invalid/v1/models', { method: 'HEAD' }))).toBeNull()
  })
})

describe('the page tunnel buffers a stream body where streams cannot be transferred', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  async function post(transferable: boolean): Promise<{ body: unknown; transfer: Transferable[] | undefined }> {
    vi.resetModules()
    if (!transferable) {
      vi.stubGlobal('MessageChannel', class {
        readonly port1 = { postMessage: () => { throw new DOMException('not transferable', 'DataCloneError') }, close: () => {} }
        readonly port2 = { close: () => {} }
      })
    }
    vi.stubGlobal('location', { origin: 'http://localhost:4173' })
    const { WorkerTunnel } = await import('../../src/client/client.ts')
    const posted: { frame: { t: string; id: number; body?: unknown }; transfer: Transferable[] | undefined }[] = []
    let deliver: ((event: { data: unknown }) => void) | undefined
    const worker = {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') deliver = listener },
      postMessage: (frame: { t: string; id: number; body?: unknown }, transfer?: Transferable[]) => {
        posted.push({ frame, transfer })
        if (frame.t === 'req') queueMicrotask(() => deliver?.({ data: { t: 'res', id: frame.id, status: 204, headers: {} } }))
      },
    } as unknown as Worker
    const tunnel = new WorkerTunnel(worker)
    const response = await tunnel.fetch('/upload', { method: 'POST', body: streamOf([bytes(1, 2), bytes(3)]), duplex: 'half' } as RequestInit)
    expect(response.status).toBe(204)
    const request = posted.find(entry => entry.frame.t === 'req')
    return { body: request?.frame.body, transfer: request?.transfer }
  }

  it('Chrome path: the stream itself is transferred, unchanged', async () => {
    const { body, transfer } = await post(true)
    expect(body).toBeInstanceOf(ReadableStream)
    expect(transfer).toEqual([body])
  })

  it('no transferable streams: the same bytes cross as one buffer', async () => {
    const { body, transfer } = await post(false)
    expect(body).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2, 3])
    expect(transfer).toBeUndefined()
  })
})

/** A body that gives one chunk and then never another: a stalled (or slow, still-growing) upload. */
function stalledUpload(): { stream: ReadableStream<Uint8Array>; cancelled: unknown[] } {
  const cancelled: unknown[] = []
  let sent = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => {})
      sent = true
      controller.enqueue(bytes(1, 2, 3))
      return undefined
    },
    cancel(reason) { cancelled.push(reason) },
  }, { highWaterMark: 0 })
  return { stream, cancelled }
}
/** Whether a promise is still pending after a short wait (the old buffering never settled once a body stalled). */
async function settledSoon<T>(promise: Promise<T>): Promise<'settled' | 'pending'> {
  const outcome = promise.then(() => 'settled' as const, () => 'settled' as const)
  return await Promise.race([outcome, new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 200) })])
}

describe('stopping a buffered upload cancels it at once (engines without stream transfer or stream bodies)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('bufferStream: the stop is heard while a read is pending; the source is cancelled and the lock released', async () => {
    const { stream, cancelled } = stalledUpload()
    const controller = new AbortController()
    const buffering = bufferStream(stream, controller.signal)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort(new DOMException('stopped by the caller', 'AbortError'))
    expect(await settledSoon(buffering)).toBe('settled')
    await expect(buffering).rejects.toThrow('stopped by the caller')
    expect(cancelled).toHaveLength(1)
    expect(stream.locked).toBe(false)
  })

  it('bufferStream: a signal already stopped reads nothing; a whole body arrives as its bytes', async () => {
    const { stream, cancelled } = stalledUpload()
    await expect(bufferStream(stream, AbortSignal.abort())).rejects.toThrow()
    expect(cancelled).toHaveLength(1)
    expect(stream.locked).toBe(false)
    const whole = await bufferStream(streamOf([bytes(1, 2), bytes(), bytes(3)]))
    expect([...new Uint8Array(whole)]).toEqual([1, 2, 3])
  })

  it('bufferStream: a chunk that is not bytes is refused, and the source is cancelled', async () => {
    const cancelled: unknown[] = []
    const odd = new ReadableStream({ pull(controller) { controller.enqueue('text') }, cancel(reason) { cancelled.push(reason) } })
    await expect(bufferStream(odd)).rejects.toThrow('not bytes')
    expect(cancelled).toHaveLength(1)
    expect(odd.locked).toBe(false)
  })

  it('the page tunnel: a stalled upload stopped by the caller rejects at once, never reaches the worker, and is cancelled', async () => {
    vi.resetModules()
    vi.stubGlobal('MessageChannel', class {
      readonly port1 = { postMessage: () => { throw new DOMException('not transferable', 'DataCloneError') }, close: () => {} }
      readonly port2 = { close: () => {} }
    })
    vi.stubGlobal('location', { origin: 'http://localhost:4173' })
    const { WorkerTunnel } = await import('../../src/client/client.ts')
    const posted: { t: string }[] = []
    const worker = {
      addEventListener: () => {},
      postMessage: (frame: { t: string }) => { posted.push(frame) },
    } as unknown as Worker
    const tunnel = new WorkerTunnel(worker)
    const { stream, cancelled } = stalledUpload()
    const controller = new AbortController()
    const pending = tunnel.fetch('/upload', { method: 'POST', body: stream, duplex: 'half', signal: controller.signal } as RequestInit)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    expect(await settledSoon(pending)).toBe('settled')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toHaveLength(1)
    expect(stream.locked).toBe(false)
    expect(posted.filter(frame => frame.t === 'req')).toEqual([])
  })

  it('the model door, fetch(Request): stopping the request cancels its buffered body at once', async () => {
    const { stream, cancelled } = stalledUpload()
    const controller = new AbortController()
    const request = new Request('https://api.example.invalid/v1/messages', { method: 'POST', body: stream, duplex: 'half', signal: controller.signal } as RequestInit)
    const buffering = bufferedRequestBody(request)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    expect(await settledSoon(buffering)).toBe('settled')
    await expect(buffering).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toHaveLength(1)
  })

  it('the model door, fetch(url, { body: stream }): the stream is buffered (not forwarded), duplex dropped, and a stop cancels it', async () => {
    const whole = await bufferedStreamInit({ method: 'POST', body: streamOf([bytes(7), bytes(8)]), duplex: 'half', headers: { a: 'b' } } as RequestInit & { body: ReadableStream<Uint8Array> })
    expect(whole.body).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(whole.body as ArrayBuffer)]).toEqual([7, 8])
    expect(Object.hasOwn(whole, 'duplex')).toBe(false)
    expect(whole.method).toBe('POST')
    expect(whole.headers).toEqual({ a: 'b' })
    const { stream, cancelled } = stalledUpload()
    const controller = new AbortController()
    const buffering = bufferedStreamInit({ method: 'POST', body: stream, signal: controller.signal })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    expect(await settledSoon(buffering)).toBe('settled')
    await expect(buffering).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toHaveLength(1)
  })
})
