/**
 * AUKORA: her chat's file links and images open her drive ("Media and Documents") under the
 * Spatial shell. Pure parts: which links the drive takes, and how an inline image is read (the drive rule first, then
 * `stat`, then windows of at most 2 MiB from one version, into a raster-typed Blob). Every path and byte is made up.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DRIVE_IMAGE_CAP, driveClaimsImage, driveImageType, loadDriveImage, openInDrive, parseDriveTarget, type DriveImageFiles,
} from '../src/client/drive-link.ts'

const HOME = '/dsh/home/auma'
const MiB = 1024 * 1024

const spatial = () => ({ openSurface: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })

interface Disk {
  [path: string]: { bytes: Uint8Array; version?: (read: number) => string; size?: number; absolutePath?: string; ignoreRange?: true }
}

/** A fake files service over a made-up disk; every call is logged. */
function files(disk: Disk) {
  const calls: string[] = []
  const reads = new Map<string, number>()
  const service: DriveImageFiles = {
    stat: async (sessionId, path) => {
      calls.push(`stat ${sessionId} ${path}`)
      const file = disk[path]
      if (file === undefined) return { ok: false, error: { code: 'workspace-file/not-found' } }
      return { ok: true, value: { absolutePath: file.absolutePath ?? path, version: 'v1', bytes: file.size ?? file.bytes.byteLength } }
    },
    readBytes: async (sessionId, path, options) => {
      const offset = options.range?.offset ?? 0
      const asked = options.range?.length ?? Infinity
      calls.push(`read ${sessionId} ${path} ${String(offset)}+${String(asked)}`)
      const file = disk[path]
      if (file === undefined) return { ok: false, error: { code: 'workspace-file/not-found' } }
      const length = file.ignoreRange === true ? Infinity : asked
      const count = (reads.get(path) ?? 0) + 1
      reads.set(path, count)
      const data = file.bytes.subarray(offset, offset + length)
      return { ok: true, value: { data, version: file.version?.(count) ?? 'v1', eof: offset + data.byteLength >= file.bytes.byteLength } }
    },
  }
  return { service, calls }
}

describe('drive links in her chat', () => {
  it('K1 under the Spatial shell, a path in the drive\'s places, kept out, or not plain opens the drive at it, contained', () => {
    const layout = spatial()
    for (const path of [
      `${HOME}/docs/PENTORA.v0.md`, `${HOME}/captures/latest.png`, `${HOME}/docs/My notes: v2.md`, `${HOME}/private/a.md`,
      // The drive answers these with its own refusal line; they never reach the old viewer: a kept-out name anywhere in her
      // home folder, and a path that is not plain.
      `${HOME}/docs/credentials.yaml`, `${HOME}/seed/.env.local`, `${HOME}/memory/id_rsa`, `${HOME}/docs/../private/x.md`,
      `${HOME}/seed/../docs/a.md`, `${HOME}//seed/x.js`, `${HOME}/seed/./x.js`,
    ]) {
      expect(openInDrive(layout, path), path).toBe(true)
      const [id, target, presentation] = layout.openSurface.mock.lastCall as [string, string, string]
      expect([id, presentation]).toEqual(['media', 'contained'])
      expect(target).toMatch(/^drive:[0-9]+:/u)
      expect(parseDriveTarget(target)).toBe(path)
    }
    // A second click on the same link is a new target, so the drive selects the file again.
    openInDrive(layout, `${HOME}/docs/a.md`)
    openInDrive(layout, `${HOME}/docs/a.md`)
    const [a, b] = layout.openSurface.mock.calls.slice(-2).map(call => call[1] as string)
    expect(a).not.toBe(b)
    expect(layout.openRightbar).not.toHaveBeenCalled()
  })

  it('K2 every other path, in her home folder or not, and a shell without openSurface, keep the stock behaviour', () => {
    const layout = spatial()
    for (const path of [
      '/proj/src/a.ts', '/dsh/home/auma-one/docs/x.md', '/dsh/home/owner/a.md', '/dsh/home/auma', 'docs/x.md', '/tmp/graph.png',
      // Her own working files outside the drive's places open where they always did.
      `${HOME}/HANDOFF.md`, `${HOME}/NORTH-STAR.md`, `${HOME}/seed/plan.md`, `${HOME}/seed/mind.js`, `${HOME}/memory/today.md`,
      `${HOME}/staged/loop.js`, `${HOME}/latest.png`, `${HOME}/docs`, `${HOME}/captures`,
    ]) {
      expect(openInDrive(layout, path), path).toBe(false)
      expect(driveClaimsImage(layout, path), path).toBe(false)
    }
    expect(layout.openSurface).not.toHaveBeenCalled()
    for (const stock of [undefined, null, {}, { openRightbar: vi.fn(), closeRightbar: vi.fn() }, { openSurface: 'no' }]) {
      expect(openInDrive(stock, `${HOME}/docs/PENTORA.v0.md`)).toBe(false)
      expect(driveClaimsImage(stock, `${HOME}/captures/latest.png`)).toBe(false)
    }
    expect(driveClaimsImage(layout, `${HOME}/captures/latest.png`)).toBe(true)
  })

  it('K3 an image the drive would refuse, a non-raster image, or one in Private is refused with zero reads', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const refused = [
      `${HOME}/docs/logo.svg`, `${HOME}/docs/page.html`, `${HOME}/docs/notes.md`, `${HOME}/docs/noext`,
      `${HOME}/private/me.png`, `${HOME}/docs/credentials/shot.png`, `${HOME}/docs/id_rsa.png`, `${HOME}/docs/secret-plan.png`,
      `${HOME}/seed/x.png`, `${HOME}/latest.png`, `${HOME}/docs/../private/me.png`, `${HOME}/docs//a.png`, '/dsh/home/owner/a.png',
      '/tmp/graph.png',
    ]
    const disk: Disk = Object.fromEntries(refused.map(path => [path, { bytes: png }]))
    const { service, calls } = files(disk)
    for (const path of refused) expect(await loadDriveImage(service, 's1', path, new AbortController().signal), path).toBeNull()
    expect(calls).toEqual([])
    // No files service, no thread, or an aborted signal: nothing is read either.
    const signal = AbortSignal.abort()
    expect(await loadDriveImage(null, 's1', `${HOME}/captures/latest.png`, new AbortController().signal)).toBeNull()
    expect(await loadDriveImage(service, undefined, `${HOME}/captures/latest.png`, new AbortController().signal)).toBeNull()
    expect(await loadDriveImage(service, 's1', `${HOME}/captures/latest.png`, signal)).toBeNull()
    expect(calls).toEqual([])
    expect(['a.PNG', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.svg', '.png'].map(name => driveImageType(`${HOME}/docs/${name}`)))
      .toEqual(['image/png', 'image/jpeg', 'image/jpeg', 'image/webp', 'image/gif', null, null])
  })

  it('K4 reads an image as the drive reads: stat, then windows of at most 2 MiB from one version, into a typed Blob', async () => {
    const big = new Uint8Array(5 * MiB)
    for (let index = 0; index < big.length; index += 4099) big[index] = index % 251
    const path = `${HOME}/captures/ring/20261112T140500Z-bbbbbbbbbbbb.png`
    const { service, calls } = files({
      [path]: { bytes: big },
      [`${HOME}/docs/photo.JPG`]: { bytes: new Uint8Array([0xff, 0xd8]) },
      [`${HOME}/docs/huge.png`]: { bytes: new Uint8Array(1), size: DRIVE_IMAGE_CAP + 1 },
      [`${HOME}/docs/moving.png`]: { bytes: big, version: read => (read === 1 ? 'v1' : 'v2') },
      [`${HOME}/docs/link.png`]: { bytes: big, absolutePath: `${HOME}/private/real.png` },
    })
    const blob = await loadDriveImage(service, 's1', path, new AbortController().signal)
    expect(blob?.type).toBe('image/png')
    expect(Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(big))).toBe(true)
    expect(calls).toEqual([`stat s1 ${path}`, `read s1 ${path} 0+${String(2 * MiB)}`, `read s1 ${path} ${String(2 * MiB)}+${String(2 * MiB)}`,
      `read s1 ${path} ${String(4 * MiB)}+${String(MiB)}`])
    expect((await loadDriveImage(service, 's1', `${HOME}/docs/photo.JPG`, new AbortController().signal))?.type).toBe('image/jpeg')
    calls.length = 0
    // Over the 16 MiB cap, or a stat that points into Private: refused after stat, with zero reads.
    expect(await loadDriveImage(service, 's1', `${HOME}/docs/huge.png`, new AbortController().signal)).toBeNull()
    expect(await loadDriveImage(service, 's1', `${HOME}/docs/link.png`, new AbortController().signal)).toBeNull()
    expect(calls.filter(call => call.startsWith('read'))).toEqual([])
    // A file that changes while it is read is not shown.
    expect(await loadDriveImage(service, 's1', `${HOME}/docs/moving.png`, new AbortController().signal)).toBeNull()
    // Missing: null.
    expect(await loadDriveImage(service, 's1', `${HOME}/docs/missing.png`, new AbortController().signal)).toBeNull()
    // A files service that throws: null, never a thrown error in her chat.
    const throwing: DriveImageFiles = { stat: () => Promise.reject(new Error('gone')), readBytes: () => Promise.reject(new Error('gone')) }
    expect(await loadDriveImage(throwing, 's1', path, new AbortController().signal)).toBeNull()
  })

  it('K5 the rule copy refuses prefixes and control characters, reads only drive targets, and a re-pointed or short read is refused', async () => {
    const layout = spatial()
    for (const path of [`${HOME}/docs/.env.local`, `${HOME}/docs/.aukora-key`, `${HOME}/docs/a\u0007.png`]) {
      expect(await loadDriveImage(files({}).service, 's1', path.endsWith('.png') ? path : `${path}.png`, new AbortController().signal), path).toBeNull()
    }
    for (const bad of [undefined, 7, '', 'drive:x:/a', `${HOME}/docs/a.md`]) expect(parseDriveTarget(bad), String(bad)).toBeNull()
    openInDrive(layout, `${HOME}/docs/a.md`)
    expect(parseDriveTarget(layout.openSurface.mock.lastCall?.[1])).toBe(`${HOME}/docs/a.md`)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const { service } = files({
      // Re-pointed to another raster file in her places: shown; to another type: refused.
      [`${HOME}/captures/alias.png`]: { bytes: png, absolutePath: `${HOME}/captures/ring/real.png` },
      [`${HOME}/captures/odd.png`]: { bytes: png, absolutePath: `${HOME}/captures/real.gif` },
      // A window with no bytes, or more bytes than the size said: refused.
      [`${HOME}/captures/empty.png`]: { bytes: new Uint8Array(), size: 4 },
      [`${HOME}/captures/long.png`]: { bytes: new Uint8Array(8), size: 4, ignoreRange: true },
    })
    expect((await loadDriveImage(service, 's1', `${HOME}/captures/alias.png`, new AbortController().signal))?.type).toBe('image/png')
    expect(await loadDriveImage(service, 's1', `${HOME}/captures/odd.png`, new AbortController().signal)).toBeNull()
    expect(await loadDriveImage(service, 's1', `${HOME}/captures/empty.png`, new AbortController().signal)).toBeNull()
    expect(await loadDriveImage(service, 's1', `${HOME}/captures/long.png`, new AbortController().signal)).toBeNull()
  })
})
