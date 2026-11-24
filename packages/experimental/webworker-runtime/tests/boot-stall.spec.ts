/**
 * The boot stall: the app sat forever on "Loading plugins…" whenever the network dropped during boot.
 * Each boot network read now has an IDLE deadline (no bytes for N seconds, never a total cap) that fails with a named
 * code, the worker reports its boot step to the page, and a read that keeps receiving bytes is never failed.
 * A stalled fetch is reproduced per phase: the seed image, a lazy archive, and her cold head read.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { idleFetch } from '../src/idle-fetch.ts'
import { bootProgress, readImage } from '../src/worker-host.ts'
import { TunnelServer } from '../src/transport/tunnel.ts'
import { parseInboundFrame } from '../src/transport/frames.ts'
import { BOOT_PHASE_EVENT, WorkerTunnel } from '../src/client/client.ts'
import { FakeSocket, mountE4 } from './x6/e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const never = () => new Promise<never>(() => {})
/** A body that sends `first` and then never another byte. */
const stalledBody = (first: string) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(first)) },
})
/** A body that keeps sending a byte every `everyMs`, `count` times, then closes. */
const tricklingBody = (count: number, everyMs: number) => new ReadableStream<Uint8Array>({
  async start(controller) {
    for (let i = 0; i < count; i += 1) {
      await new Promise(resolveTick => setTimeout(resolveTick, everyMs))
      controller.enqueue(new Uint8Array([120]))
    }
    controller.close()
  },
})

describe('idleFetch: fails on silence, never while bytes arrive', () => {
  it('a fetch that never answers fails with its named code', async () => {
    const started = Date.now()
    await expect(idleFetch('https://x.invalid/a', {}, { idleMs: 40, code: 'BOOT_IMAGE_STALLED', what: 'her seed image', fetchImpl: never }))
      .rejects.toMatchObject({ code: 'BOOT_IMAGE_STALLED',
        message: expect.stringMatching(/^BOOT_IMAGE_STALLED: no bytes for 1s while fetching her seed image$/) as unknown })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('a body that stops mid-way fails with the code when read', async () => {
    const response = await idleFetch('https://x.invalid/a', {}, { idleMs: 40, code: 'HEAD_READ_STALLED', what: 'her head',
      fetchImpl: async () => new Response(stalledBody('{"ok":')) })
    await expect(response.text()).rejects.toMatchObject({ code: 'HEAD_READ_STALLED' })
  })

  it('a slow body that keeps arriving is never failed, even past many idle windows', async () => {
    const seen: number[] = []
    const response = await idleFetch('https://x.invalid/a', {}, { idleMs: 60, code: 'BOOT_IMAGE_STALLED', what: 'her seed image',
      onBytes: (bytes) => { seen.push(bytes) }, fetchImpl: async () => new Response(tricklingBody(8, 25)) })
    expect(await response.text()).toBe('x'.repeat(8))
    expect(seen.at(-1)).toBe(8)
  })

  it('the caller can still abort it', async () => {
    const controller = new AbortController()
    const pending = idleFetch('https://x.invalid/a', { signal: controller.signal }, { idleMs: 10_000, code: 'X', what: 'x',
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) }) })
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
})

describe('the worker boot reads (worker-host.ts readImage)', () => {
  it('phase image: a seed image fetch that stalls fails BOOT_IMAGE_STALLED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stalledBody('\u001f'))))
    await expect(readImage('https://x.invalid/image.tar.gz', { idleMs: 40, code: 'BOOT_IMAGE_STALLED', what: 'her seed image' }))
      .rejects.toMatchObject({ code: 'BOOT_IMAGE_STALLED' })
  })

  it('a lazy archive fetch that never answers fails BOOT_ARCHIVE_STALLED', async () => {
    vi.stubGlobal('fetch', vi.fn(never))
    await expect(readImage('https://x.invalid/part.tar.gz', { idleMs: 40, code: 'BOOT_ARCHIVE_STALLED', what: 'part of her image' }))
      .rejects.toMatchObject({ code: 'BOOT_ARCHIVE_STALLED' })
  })

  it('start() reports every phase, in order, and bounds every network read', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/worker-host.ts'), 'utf8')
    const start = source.slice(source.indexOf('const start = async (): Promise<void> => {'), source.indexOf('started.resolve()'))
    const order = ['image', 'storage', 'plugins', 'head', 'serving'].map(phase => start.indexOf(`progress.enter('${phase}'`))
    expect(order.every(index => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(source).toContain("code: 'BOOT_IMAGE_STALLED', what: 'her seed image' })")
    // The heartbeat ends with the boot, either way.
    expect(source).toMatch(/\} finally \{\n\s+boot\?\.stop\(\)/)
    expect(source).toContain("code: 'BOOT_ARCHIVE_STALLED'")
    expect(source).not.toMatch(/await fetch\(image\)/)
  })
})

describe('phase head: her cold head read', () => {
  it('a head read that stalls fails HEAD_READ_STALLED and the boot goes on without a selected head', async () => {
    vi.stubGlobal('__X6_HEAD_READ_IDLE_MS__', 40)
    const m = await mountE4({ respond: call => call.method === 'GET' && call.path === '/_head/ball'
      ? new Response(stalledBody('{"ok":true,'), { headers: { 'content-type': 'application/json' } }) : null })
    const status = await m.status()
    expect(String(status.headFetchError)).toMatch(/^HEAD_READ_STALLED: no bytes/)
  })
})

describe('the boot step reaches the page', () => {
  it('the worker posts a boot-phase frame, and the page tunnel turns it into a page event', () => {
    const posted: unknown[] = []
    const server = new TunnelServer({ port: { postMessage: (frame) => { posted.push(frame) } }, requestListener: (() => {}) as never,
      pageFeatures: ['boot-phase'] })
    server.bootPhase('image', 3 * 1024 * 1024)
    server.bootPhase('plugins')
    expect(posted).toEqual([{ t: 'boot-phase', phase: 'image', bytes: 3 * 1024 * 1024 }, { t: 'boot-phase', phase: 'plugins' }])

    const listeners: Array<(event: { data: unknown }) => void> = []
    const worker = { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener) },
      postMessage: () => {} } as unknown as Worker
    new WorkerTunnel(worker)
    // The page's global scope, as a plain EventTarget (this suite runs in Node).
    const page = new EventTarget()
    vi.stubGlobal('dispatchEvent', page.dispatchEvent.bind(page))
    const seen: unknown[] = []
    page.addEventListener(BOOT_PHASE_EVENT, (event) => { seen.push((event as CustomEvent).detail) })
    for (const frame of posted) for (const listener of listeners) listener({ data: frame })
    expect(seen).toEqual([{ phase: 'image', bytes: 3 * 1024 * 1024 }, { phase: 'plugins' }])
    expect(BOOT_PHASE_EVENT).toBe('dsh:boot-phase')
  })
})

/** A body that sends `chunk` bytes every `everyMs`, `count` times, then closes; `cancelled` records a cancel. */
function meteredBody(count: number, everyMs: number, chunk: number, cancelled: unknown[] = []) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0
      const tick = (): void => {
        if (sent === count) { controller.close(); return }
        sent += 1
        controller.enqueue(new Uint8Array(chunk))
        timer = setTimeout(tick, everyMs)
      }
      timer = setTimeout(tick, everyMs)
    },
    cancel(reason) { clearTimeout(timer); cancelled.push(reason) },
  }, { highWaterMark: 0 })
}

describe('A healthy slow download reaches the page on a TIME interval', () => {
  it('10 KiB/s for 120 s: a byte heartbeat every 5 s, never a gap the page (45 s) could call a stall', async () => {
    vi.useFakeTimers()
    const frames: Array<{ at: number; phase: string; bytes?: number }> = []
    const progress = bootProgress((phase, bytes) => {
      frames.push({ at: Date.now(), phase, ...(bytes === undefined ? {} : { bytes }) })
    }, 5_000)
    const started = Date.now()
    progress.enter('image')
    const response = await idleFetch('https://x.invalid/image', {}, { idleMs: 30_000, code: 'BOOT_IMAGE_STALLED', what: 'her seed image',
      fetchImpl: async () => new Response(meteredBody(120, 1_000, 10 * 1024)) })
    const body = response.arrayBuffer()
    await vi.advanceTimersByTimeAsync(126_000)
    expect((await body).byteLength).toBe(120 * 10 * 1024)
    progress.stop()
    const beats = frames.filter(frame => frame.bytes !== undefined)
    expect(beats.length).toBeGreaterThanOrEqual(23)
    const times = [started, ...beats.map(frame => frame.at)]
    expect(Math.max(...times.slice(1).map((at, i) => at - (times[i] as number)))).toBeLessThanOrEqual(5_000)
    expect(beats.at(-1)?.bytes).toBe(120 * 10 * 1024)
  })

  it('every transfer counts (an overlay, a lazy archive, her head: no onBytes of their own), and silence sends nothing', async () => {
    vi.useFakeTimers()
    const frames: Array<{ phase: string; bytes?: number }> = []
    const progress = bootProgress((phase, bytes) => { frames.push({ phase, ...(bytes === undefined ? {} : { bytes }) }) }, 5_000)
    progress.enter('head')
    const head = await idleFetch('https://x.invalid/_head/ball', {}, { idleMs: 20_000, code: 'HEAD_READ_STALLED', what: 'her head',
      fetchImpl: async () => new Response(meteredBody(4, 2_000, 1024)) })
    const text = head.text()
    await vi.advanceTimersByTimeAsync(10_000)
    await text
    expect(frames).toEqual([{ phase: 'head' }, { phase: 'head', bytes: 2 * 1024 }, { phase: 'head', bytes: 4 * 1024 }])
    // No bytes, no heartbeat: the page's own clock keeps its meaning.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames).toHaveLength(3)
    progress.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('The idle deadline times only pending reads', () => {
  it('a fully received, closed body read late by its consumer is not rejected', async () => {
    const response = await idleFetch('https://x.invalid/a', {}, { idleMs: 40, code: 'BOOT_IMAGE_STALLED', what: 'her seed image',
      fetchImpl: async () => new Response('all of it') })
    await new Promise(resolveLater => setTimeout(resolveLater, 150))
    expect(await response.text()).toBe('all of it')
  })

  it('a consumer paused mid-body (downstream backpressure) for many idle windows is not rejected', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([97])) },
      pull(controller) { controller.enqueue(new Uint8Array([98])); controller.close() },
    })
    const response = await idleFetch('https://x.invalid/a', {}, { idleMs: 40, code: 'X', what: 'x', fetchImpl: async () => new Response(source) })
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([97]))
    await new Promise(resolveLater => setTimeout(resolveLater, 150))
    expect((await reader.read()).value).toEqual(new Uint8Array([98]))
    expect((await reader.read()).done).toBe(true)
  })
})

describe('One terminal cleanup', () => {
  it('on a stall: the caller abort listener is removed and the source is cancelled and unlocked', async () => {
    const outer = new AbortController()
    const removed = vi.spyOn(outer.signal, 'removeEventListener')
    const cancelled: unknown[] = []
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel(reason) { cancelled.push(reason) },
    })
    const response = await idleFetch('https://x.invalid/a', { signal: outer.signal }, { idleMs: 40, code: 'HEAD_READ_STALLED', what: 'her head',
      fetchImpl: async () => new Response(source) })
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'HEAD_READ_STALLED' })
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(cancelled).toEqual([expect.objectContaining({ code: 'HEAD_READ_STALLED' })])
    expect(source.locked).toBe(false)
  })

  it('on the end of a body and on a headers stall: no listener is left behind', async () => {
    for (const fetchImpl of [async () => new Response('done'), never]) {
      const outer = new AbortController()
      const removed = vi.spyOn(outer.signal, 'removeEventListener')
      const read = idleFetch('https://x.invalid/a', { signal: outer.signal }, { idleMs: 40, code: 'X', what: 'x', fetchImpl })
        .then(response => response.text())
      await read.catch(() => {})
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    }
  })

  it('an HTTP error image read cancels its body at once instead of holding it until the deadline', async () => {
    const cancelled: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(meteredBody(1_000, 10, 1, cancelled), { status: 503 })))
    const started = Date.now()
    await expect(readImage('https://x.invalid/image.tar.gz', { idleMs: 10_000, code: 'BOOT_IMAGE_STALLED', what: 'her seed image' }))
      .rejects.toThrow(/image fetch failed with 503/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(cancelled).toHaveLength(1)
  })

  it('an HTTP error head read cancels its body (HEAD_FETCH_FAILED)', async () => {
    const cancelled: unknown[] = []
    const m = await mountE4({ respond: call => call.method === 'GET' && call.path === '/_head/ball'
      ? new Response(meteredBody(1_000, 10, 1, cancelled), { status: 503 }) : null })
    const status = await m.status()
    expect(String(status.headFetchError)).toMatch(/^HEAD_FETCH_FAILED: HTTP 503/)
    expect(cancelled).toHaveLength(1)
  })
})

describe('The boot-phase frame is negotiated, and unknown frames are ignored', () => {
  it('a page that did not announce boot-phase (the previous build) is never sent the frame', () => {
    const posted: unknown[] = []
    const server = new TunnelServer({ port: { postMessage: (frame) => { posted.push(frame) } }, requestListener: (() => {}) as never })
    server.bootPhase('image', 1024)
    server.bootPhase('serving')
    expect(posted).toEqual([])
  })

  it('this page announces boot-phase in its init frame, and the worker entry threads it to the host', () => {
    const sent: unknown[] = []
    const worker = { addEventListener: () => {}, postMessage: (frame: unknown) => { sent.push(frame) } }
    const tunnel = new WorkerTunnel(worker as unknown as Worker)
    tunnel.init('https://x.invalid/image.tar.gz', [])
    expect(sent).toEqual([{ t: 'init', image: 'https://x.invalid/image.tar.gz', overlays: [], features: ['boot-phase'] }])
    expect(parseInboundFrame(sent[0])).toEqual(sent[0])
    expect(parseInboundFrame({ t: 'init', image: 'i', overlays: [] })).toEqual({ t: 'init', image: 'i', overlays: [] })
    expect(() => parseInboundFrame({ t: 'init', image: 'i', overlays: [], features: [1] })).toThrow(/features/)
    const entry = readFileSync(resolve(import.meta.dirname, '../src/worker.ts'), 'utf8')
    expect(entry).toMatch(/pageFeatures: \(data\.features as unknown\[\]\)/)
  })

  it('a receiver given a frame type it does not know ignores it and keeps serving', () => {
    const listeners: Array<(event: { data: unknown }) => void> = []
    const worker = { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener) },
      postMessage: () => {} } as unknown as Worker
    new WorkerTunnel(worker)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = new EventTarget()
    vi.stubGlobal('dispatchEvent', page.dispatchEvent.bind(page))
    const seen: unknown[] = []
    page.addEventListener(BOOT_PHASE_EVENT, (event) => { seen.push((event as CustomEvent).detail) })
    for (const listener of listeners) expect(() => { listener({ data: { t: 'a-frame-from-a-newer-worker', x: 1 } }) }).not.toThrow()
    for (const listener of listeners) listener({ data: { t: 'boot-phase', phase: 'head' } })
    expect(seen).toEqual([{ phase: 'head' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored unknown frame type "a-frame-from-a-newer-worker"'))
  })
})

describe('Terminal state holds across the headers and progress callbacks', () => {
  it('an abort that lands while the headers complete rejects, and the body is cancelled, never a hanging locked source', async () => {
    const outer = new AbortController()
    const cancelled: unknown[] = []
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel(reason) { cancelled.push(reason) },
    })
    const late = new Error('late abort')
    const response = new Response(source)
    const answered = Promise.resolve(response)
    // Ordered so the abort runs after idleFetch's own resolve and before its await resumes.
    const fetchImpl = (() => { queueMicrotask(() => { void answered.then(() => { outer.abort(late) }) }); return answered }) as typeof fetch
    await expect(idleFetch('https://x.invalid/a', { signal: outer.signal }, { idleMs: 10_000, code: 'X', what: 'x', fetchImpl })).rejects.toBe(late)
    expect(cancelled).toEqual([late])
    expect(source.locked).toBe(false)
  })

  it('a throwing onBytes callback ends the read through the terminal cleanup', async () => {
    const outer = new AbortController()
    const removed = vi.spyOn(outer.signal, 'removeEventListener')
    const cancelled: unknown[] = []
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel(reason) { cancelled.push(reason) },
    })
    const broke = new Error('progress callback broke')
    const response = await idleFetch('https://x.invalid/a', { signal: outer.signal }, { idleMs: 10_000, code: 'X', what: 'x',
      onBytes: () => { throw broke }, fetchImpl: async () => new Response(source) })
    await expect(response.arrayBuffer()).rejects.toBe(broke)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(cancelled).toEqual([broke])
    expect(source.locked).toBe(false)
  })
})
