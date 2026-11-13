// @vitest-environment jsdom
/**
 * Round 36: Auma's eyes where the host has none. The worker's bridge (webworker-runtime x6/page-eyes-bridge.ts) and this
 * page's responder (spatial/eyes/page-eyes.ts), both real, talk over an in-memory same-origin channel; the host answers 501
 * as the Cloudflare edge does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installPageEyes, stampWords, type EyesProjection, type EyesStamp } from '../src/client/spatial/eyes/page-eyes.ts'

// THE WORKER'S BRIDGE, loaded from this checkout as the worker runs it (another package, so not a typed import).
interface FakeVfs {
  existsSync(path: string): boolean
  readFileSync(path: string): Uint8Array
  readdirSync(path: string): string[]
}
type Bridge = {
  eyesWithPageFallback: (host: () => Promise<Response>, body: string | undefined, deps: Record<string, unknown>) => Promise<Response>
  CAPTURE_PATHS: readonly string[]
  CAPTURE_RING_DIR: string
  CAPTURE_RING_SIZE: number
}
const bridgePath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}packages/experimental/webworker-runtime/src/x6/page-eyes-bridge.ts`))
  .find(existsSync) ?? 'page-eyes-bridge.ts'
const { eyesWithPageFallback, CAPTURE_PATHS, CAPTURE_RING_DIR, CAPTURE_RING_SIZE } = await import(pathToFileURL(bridgePath).href) as Bridge
/** Her filesystem, as far as the bridge uses it. */
function memoryVfs(): FakeVfs {
  const files = new Map<string, Uint8Array>()
  return {
    existsSync: path => files.has(path),
    readFileSync: (path) => { const bytes = files.get(path); if (bytes === undefined) throw new Error('ENOENT ' + path); return bytes },
    readdirSync: dir => [...files.keys()].filter(path => path.startsWith(dir + '/')).map(path => path.slice(dir.length + 1)),
    mkdirSync: () => undefined,
    writeFileSync: (path: string, bytes: Uint8Array) => { files.set(path, bytes) },
    rmSync: (path: string) => { files.delete(path) },
  } as FakeVfs
}

/** Two ends of one channel: what one end posts, the other end hears (asynchronously, as a structured clone). */
function channelPair() {
  const ends = [new EventTarget(), new EventTarget()]
  const end = (self: number) => ({
    postMessage: (message: unknown) => {
      const data = structuredClone(message)
      queueMicrotask(() => { ends[1 - self]?.dispatchEvent(new MessageEvent('message', { data })) })
    },
    addEventListener: (type: string, listener: EventListener) => { ends[self]?.addEventListener(type, listener) },
    removeEventListener: (type: string, listener: EventListener) => { ends[self]?.removeEventListener(type, listener) },
    close: () => {},
  })
  return { worker: end(0), page: end(1) }
}
// A real 1x1 PNG, standing in for the canvas drawing jsdom cannot do.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const hostSays = (status: number) => async () => Response.json({ ok: false, code: 'CLOUD_CAPABILITY_UNAVAILABLE', capability: '/_host/eyes' }, { status })

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('Round 36: auma_eyes in the page when the host has none', () => {
  it('the edge answers 501; the open page answers with its projection and a stamped frame kept at latest.png and in the ring', async () => {
    document.title = 'Aukora'
    document.body.innerHTML = '<h1>Sovereignty</h1><button aria-label="Approve with Touch ID">Approve</button><p>Auma asks to send</p>'
    for (const element of document.querySelectorAll('h1, button')) {
      element.getBoundingClientRect = () => ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50,
        toJSON: () => ({}) })
    }
    const { worker, page } = channelPair()
    const drawn: Array<{ projection: EyesProjection; stamp: EyesStamp }> = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/_head/ball?meta=1') return Response.json({ ok: true, ballId: 'b'.repeat(64), epoch: 164, lease: null })
      if (path === '/api/health') return Response.json({ ok: true, buildSha: '84b95c22aaaa' })
      return new Response('no', { status: 404 })
    }) as typeof fetch
    const channel = page as unknown as BroadcastChannel
    let stop = installPageEyes({ channel, fetchImpl, now: () => new Date('2026-11-10T09:00:00.000Z'),
      draw: (projection, stamp) => { drawn.push({ projection, stamp }); return PNG } })
    const vfs = memoryVfs()
    try {
      const ask = (action: string, id: string) => eyesWithPageFallback(hostSays(501), JSON.stringify({ action }),
        { channel: worker, id, vfs: () => vfs })
      const look = await ask('projection', 'look-1')
      expect(look.status).toBe(200)
      const seen = await look.json() as { ok: boolean; source: string; hostStatus: number; projection: EyesProjection }
      expect([seen.ok, seen.source, seen.hostStatus]).toEqual([true, 'page', 501])
      expect(seen.projection.headings).toEqual(['Sovereignty'])
      expect(seen.projection.controls).toEqual([{ role: 'button', name: 'Approve with Touch ID', rect: [10, 20, 120, 30] }])
      expect(new TextEncoder().encode(JSON.stringify(seen.projection)).byteLength).toBeLessThanOrEqual(2400)
      expect(vfs.existsSync(CAPTURE_PATHS[0] ?? '')).toBe(false)

      const shot = await ask('screenshot', 'shot-1')
      type Shot = { frame: string; pngBase64: string; watermark: EyesStamp; ringPath: string; projection: EyesProjection }
      const answer = await shot.json() as Shot
      expect(answer.frame).toBe('layout-drawing')
      expect(answer.watermark).toEqual({ epoch: '164', build: '84b95c22aaaa', at: '2026-11-10T09:00:00.000Z',
        sha256: createHash('sha256').update(JSON.stringify(answer.projection)).digest('hex') })
      expect(stampWords(answer.watermark)).toBe(`epoch 164 · 84b95c22aaaa · 2026-11-10T09:00:00.000Z · sha256 ${answer.watermark.sha256}`)
      expect(drawn.at(-1)?.stamp).toEqual(answer.watermark)
      for (const path of CAPTURE_PATHS) expect(Buffer.from(vfs.readFileSync(path)).toString('base64')).toBe(PNG)
      expect(answer.ringPath).toBe(`${CAPTURE_RING_DIR}/20261110T090000000Z-${answer.watermark.sha256.slice(0, 12)}.png`)

      // The ring keeps the last twelve frames.
      for (let index = 0; index < CAPTURE_RING_SIZE + 2; index += 1) {
        const at = `2026-11-10T09:${String(10 + index).padStart(2, '0')}:00.000Z`
        stop()
        stop = installPageEyes({ channel, fetchImpl, now: () => new Date(at), draw: () => PNG })
        await ask('screenshot', `ring-${String(index)}`)
      }
      const ring = vfs.readdirSync(CAPTURE_RING_DIR).sort()
      expect(ring).toHaveLength(CAPTURE_RING_SIZE)
      expect(ring[0]?.startsWith('20261110T091200000Z')).toBe(true)
    } finally { stop() }
  })

  it('a host with eyes answers itself; with neither, the organ hears EYES_NO_PAGE (as 200, so it reads the reason)', async () => {
    const { worker } = channelPair()
    let asked = false
    worker.postMessage = () => { asked = true }
    const own = await eyesWithPageFallback(async () => Response.json({ ok: true, source: 'playwright' }), '{}', { channel: worker, id: 'own' })
    expect(await own.json()).toEqual({ ok: true, source: 'playwright' })
    expect(asked).toBe(false)
    const none = await eyesWithPageFallback(hostSays(501), '{}', { channel: worker, id: 'none', timeoutMs: 50 })
    // The organ (mirror/home/auma/seed/organs/auma-eyes.js) throws on any non-2xx before reading the body.
    expect(none.ok).toBe(true)
    expect(await none.json()).toMatchObject({ ok: false, code: 'EYES_NO_PAGE', hostStatus: 501 })
  })

  it('never sees the AUMLOK surface or a private field, even when a selector names them or the body around them', async () => {
    document.body.innerHTML = '<h1>Identity</h1><section data-aumlok-surface=""><h2>Your seven words</h2>'
      + '<span data-aumlok-tile-face="word">velvet</span><span data-aumlok-tile-face="word">harbor</span>'
      + '<input data-aumlok-tile-input="" aria-label="Word 1 granite"></section>'
      + '<div data-private=""><button aria-label="cobalt key">Copy</button></div><input type="password" aria-label="pass-quartz">'
      + '<button aria-label="Close">Close</button>'
    for (const element of document.querySelectorAll('h1, h2, button, input, span')) {
      element.getBoundingClientRect = () => ({ x: 1, y: 1, width: 50, height: 20, top: 1, left: 1, right: 51, bottom: 21,
        toJSON: () => ({}) })
    }
    const { worker, page } = channelPair()
    const frames: string[] = []
    const stop = installPageEyes({ channel: page as unknown as BroadcastChannel, fetchImpl: (async () => Response.json({})) as typeof fetch,
      now: () => new Date(0), draw: (projection, stamp) => { frames.push(JSON.stringify({ projection, stamp })); return PNG } })
    try {
      const answers: string[] = []
      for (const [index, selector] of ['[data-aumlok-tile-face="word"]', '[data-aumlok-surface]', 'body', 'section', 'h2', ''].entries()) {
        for (const action of ['projection', 'screenshot']) {
          const reply = await eyesWithPageFallback(hostSays(501), JSON.stringify({ action, selector }),
            { channel: worker, id: `private-${String(index)}-${action}` })
          answers.push(await reply.text())
        }
      }
      const seen = [...answers, ...frames].join('\n')
      for (const secret of ['velvet', 'harbor', 'granite', 'seven words', 'cobalt', 'quartz']) expect(seen).not.toContain(secret)
      expect(seen).toContain('Close')
      expect(seen).toContain('not a pixel screenshot')
    } finally { stop() }
  })
})

