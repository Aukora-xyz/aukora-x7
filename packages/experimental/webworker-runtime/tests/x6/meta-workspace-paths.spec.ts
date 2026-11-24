/**
 * Lane E5 task 2: legacy `/dsh/home/auma-one` runtime stragglers move to the meta-workspace home `/dsh/home/auma`, with a
 * read-only fallback to the legacy home. Page-eyes captures (ring, latest, projection) and HANDOFF.md reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  CAPTURE_PATHS, CAPTURE_RING_DIR, LEGACY_CAPTURE_RING_DIR, PROJECTION_PATHS,
  eyesWithPageFallback, keepCapture, latestCapturePath, readCaptureRing,
} from '../../src/x6/page-eyes-bridge.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3))

describe('page-eyes captures live under /dsh/home/auma', () => {
  it('the ring, latest frame and projection are rooted in /dsh/home/auma first', () => {
    expect(CAPTURE_RING_DIR).toBe('/dsh/home/auma/captures/ring')
    expect(LEGACY_CAPTURE_RING_DIR).toBe('/dsh/home/auma-one/captures/ring')
    expect(CAPTURE_PATHS[0]).toBe('/dsh/home/auma/captures/latest.png')
    expect(PROJECTION_PATHS[0]).toBe('/dsh/home/auma/captures/latest-projection.json')
    const vfs = new MemoryVfs()
    const ring = keepCapture(vfs, PNG, { at: '2026-11-11T09:00:00Z', sha256: 'a'.repeat(64) })
    expect(ring).toBe('/dsh/home/auma/captures/ring/20261111T090000Z-aaaaaaaaaaaa.png')
    expect(vfs.existsSync(LEGACY_CAPTURE_RING_DIR)).toBe(false)
    // latest.png is still mirrored into the legacy home for pinned organs that read it there.
    expect(CAPTURE_PATHS.every(path => vfs.existsSync(path))).toBe(true)
    expect(latestCapturePath(vfs)).toBe('/dsh/home/auma/captures/latest.png')
  })

  it('readers fall back to the legacy ring only while the new ring is empty', () => {
    const vfs = new MemoryVfs()
    expect(readCaptureRing(vfs)).toEqual({ dir: CAPTURE_RING_DIR, frames: [], legacy: false })
    expect(latestCapturePath(vfs)).toBeNull()
    vfs.mkdirSync(LEGACY_CAPTURE_RING_DIR, { recursive: true })
    vfs.writeFileSync(`${LEGACY_CAPTURE_RING_DIR}/1-old.png`, 'x')
    vfs.mkdirSync('/dsh/home/auma-one/captures', { recursive: true })
    vfs.writeFileSync('/dsh/home/auma-one/captures/latest.png', 'x')
    expect(readCaptureRing(vfs)).toEqual({ dir: LEGACY_CAPTURE_RING_DIR, frames: ['1-old.png'], legacy: true })
    expect(latestCapturePath(vfs)).toBe('/dsh/home/auma-one/captures/latest.png')
    keepCapture(vfs, PNG, { at: '2', sha256: 'b'.repeat(64) })
    expect(readCaptureRing(vfs)).toEqual({ dir: CAPTURE_RING_DIR, frames: ['2-bbbbbbbbbbbb.png'], legacy: false })
    // The fallback is read-only: the legacy frame is left where it was.
    expect(vfs.existsSync(`${LEGACY_CAPTURE_RING_DIR}/1-old.png`)).toBe(true)
  })

  it('the page answer reports the /dsh/home/auma paths', async () => {
    const vfs = new MemoryVfs()
    const listeners: Array<(event: MessageEvent) => void> = []
    const channel = {
      addEventListener: (_type: string, listener: EventListener) => {
        listeners.push(listener as unknown as (event: MessageEvent) => void)
      },
      removeEventListener: () => {},
      close: () => {},
      postMessage: (message: { id: string }) => {
        queueMicrotask(() => { for (const listener of listeners) listener({ data: { t: 'eyes-answer', id: message.id, projection: { nodes: [] }, pngBase64: PNG, watermark: { at: '3', sha256: 'c'.repeat(64) } } } as MessageEvent) })
      },
    }
    const response = await eyesWithPageFallback(async () => new Response(null, { status: 501 }), '{"action":"screenshot"}', { vfs: () => vfs, channel, id: 'req-1', timeoutMs: 1000 })
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({ projectionPath: '/dsh/home/auma/captures/latest-projection.json', capturePath: '/dsh/home/auma/captures/latest.png',
      ringPath: '/dsh/home/auma/captures/ring/3-cccccccccccc.png' })
  })
})

describe('HANDOFF.md reads /dsh/home/auma, falling back to the legacy home', () => {
  it('auma_handoff read uses the legacy copy only when the auma copy is absent', async () => {
    const { vfs, tool } = await mountE4()
    if (vfs.existsSync('/dsh/home/auma/HANDOFF.md')) vfs.rmSync('/dsh/home/auma/HANDOFF.md')
    for (const dir of ['/dsh/home/auma-one', '/dsh/workspace']) vfs.mkdirSync(dir, { recursive: true })
    vfs.writeFileSync('/dsh/home/auma-one/HANDOFF.md', '# legacy map\n')
    expect(await tool('auma_handoff').execute({ action: 'read' })).toMatchObject({ path: '/dsh/home/auma/HANDOFF.md', content: '# legacy map\n' })
    // Append carries the legacy text forward into the auma home.
    await tool('auma_handoff').execute({ action: 'append', content: 'epoch 169 staged' })
    expect(vfs.readFileSync('/dsh/home/auma/HANDOFF.md', 'utf8')).toBe('# legacy map\n\nepoch 169 staged\n')
    vfs.writeFileSync('/dsh/home/auma/HANDOFF.md', '# auma map\n')
    expect(await tool('auma_handoff').execute({ action: 'read' })).toMatchObject({ content: '# auma map\n' })
  })
})
