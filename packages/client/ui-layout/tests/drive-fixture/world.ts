// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * A MADE-UP HER, IN MEMORY, for the drive fixture page (`apps/web/drive-fixture.html`, page `fixture.tsx` here).
 * Nothing here is her real data: every file, name, time and byte is invented here. It stands in for the two channels
 * the drive reads through:
 *
 * - her estate tool (`x6_browser_estate`) behind a fake page bridge, as `globalThis.__AUKORA_SUPERAGENT__` publishes it;
 * - the files service (`stat`, `readBytes`, `list`) behind a drive files door.
 *
 * Like the real tool, the fake estate never lists the children of her Private folder; unlike the real tool, it does NOT
 * redact secret-shaped names, so the drive's own rule is what keeps them off the page. It never touches the network.
 *
 * @module drive-fixture/world
 */
import type { DriveFiles } from '../../src/client/spatial/apps/media/drive-source.ts'

export const HOME = '/dsh/home/auma'
const MiB = 1024 * 1024
const MINUTE = 60_000

/** Files whose names must never reach the page (the drive rule keeps them out). */
export const SECRET_PATHS: readonly string[] = [
  `${HOME}/docs/credentials.yaml`,
  `${HOME}/docs/.env.local`,
  `${HOME}/docs/.ssh/config`,
  `${HOME}/docs/device-keypair.json`,
  `${HOME}/docs/id_rsa`,
  `${HOME}/docs/api-key.txt`,
  `${HOME}/docs/credentials/notes.md`,
  `${HOME}/captures/ring/session.cap`,
  `${HOME}/private/.credentials.yaml`,
]

// ---- PNG, made in code (stored deflate: no compression library, real PNG bytes) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** zlib with stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let at = 2
  for (let block = 0; block < blocks; block++) {
    const start = block * 65535
    const length = Math.min(65535, raw.length - start)
    out[at] = block === blocks - 1 ? 1 : 0
    out[at + 1] = length & 0xff
    out[at + 2] = length >>> 8
    out[at + 3] = ~length & 0xff
    out[at + 4] = (~length >>> 8) & 0xff
    out.set(raw.subarray(start, start + length), at + 5)
    at += 5 + length
  }
  let a = 1
  let b = 0
  for (const byte of raw) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0)
  return out
}

type Rgb = readonly [number, number, number]
const NIGHT: Rgb = [11, 13, 24]
const ACCENTS: readonly Rgb[] = [[150, 180, 255], [129, 212, 180], [196, 170, 255], [224, 183, 106]]

/**
 * A made-up "screenshot": the night canvas with three rounded lane panels tinted by one accent.
 * @returns real PNG bytes (8-bit RGB).
 */
export function capturePng(width: number, height: number, accent: number): Uint8Array {
  const tint = ACCENTS[accent % ACCENTS.length] ?? ACCENTS[0]!
  const raw = new Uint8Array((width * 3 + 1) * height)
  const gap = Math.max(4, Math.round(width / 80))
  const laneWidth = (width - gap * 4) / 3
  const radius = Math.max(6, Math.round(Math.min(width, height) / 18))
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const glow = Math.max(0, 1 - Math.hypot(x / width - 0.2, y / height + 0.1) * 1.4)
      let pixel: Rgb = [NIGHT[0] + glow * 18, NIGHT[1] + glow * 30, NIGHT[2] + glow * 26]
      const lane = Math.floor((x - gap) / (laneWidth + gap))
      const lx = x - gap - lane * (laneWidth + gap)
      const top = gap
      const bottom = height - gap
      if (lane >= 0 && lane < 3 && lx >= 0 && lx < laneWidth && y >= top && y < bottom) {
        const cx = Math.min(lx, laneWidth - 1 - lx)
        const cy = Math.min(y - top, bottom - 1 - y)
        const inside = cx >= radius || cy >= radius || Math.hypot(radius - cx, radius - cy) <= radius
        if (inside) {
          const strength = lane === 1 ? 0.22 : 0.12
          const mix = (from: number, to: number): number => from + (to - from) * strength
          pixel = [mix(pixel[0], tint[0]), mix(pixel[1], tint[1]), mix(pixel[2], tint[2])]
          // A few "lines of text" in each lane.
          const pitch = Math.max(8, Math.round(height / 24))
          const line = Math.floor((y - top - radius) / pitch)
          const lineEnd = laneWidth * (0.55 + ((line * 7 + lane) % 4) / 10)
          if (line >= 1 && line < 9 && (y - top - radius) % pitch < 2 && lx > radius && lx < lineEnd) {
            pixel = [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7]
          }
        }
      }
      raw[row + 1 + x * 3] = pixel[0]
      raw[row + 2 + x * 3] = pixel[1]
      raw[row + 3 + x * 3] = pixel[2]
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// ---- The made-up disk ----

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

const PENTORA = `# Pentora (made up)

A made-up planning note for the drive fixture. None of this is real.

## What it holds

| Part | State | Owner |
|---|---|---|
| Drive | built | Auma |
| Studio | waiting for a connector | a helper |
| Upload | later | nobody yet |

## Links

- Another site, which opens in a new tab: [example.com](https://example.com/)
- A file beside this one, which the drive selects: [notes](./pentora/notes.txt)
- This site, which does nothing: [home](/)

## An image reference (inert here: a previewed document never loads an image)

![her last screenshot](/dsh/home/auma/captures/latest.png)

## Code

\`\`\`ts
const drive = 'read only'
console.log(drive)
\`\`\`
`

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" id="evil">
  <script>alert('an SVG in the drive is shown as text, never run')</script>
  <circle cx="32" cy="32" r="28" fill="rgb(150,180,255)" />
</svg>
`

/** About 3 MiB of text: over the 2 MiB text preview cap, so the drive offers Download only. */
function bigLog(): Uint8Array {
  const line = 'made-up log line: the drive previews text up to 2 MiB and downloads up to 64 MiB.\n'
  return text(line.repeat(Math.ceil((3 * MiB) / line.length)))
}

interface FakeFile { readonly bytes: Uint8Array; readonly mtime: number }

/** The made-up disk, built once per page. */
export function fixtureDisk(now: number): ReadonlyMap<string, FakeFile> {
  const disk = new Map<string, FakeFile>()
  const captures: readonly (readonly [number, number])[] = [[960, 540], [800, 450], [640, 400], [480, 300], [360, 360], [300, 400]]
  captures.forEach(([width, height], index) => {
    const mtime = now - (2 + index * 7) * MINUTE
    const stamp = new Date(mtime).toISOString().replace(/[-:]/gu, '').replace(/\.\d+/u, '')
    const hash = (index + 10).toString(16).repeat(12).slice(0, 12)
    const bytes = capturePng(width, height, index)
    disk.set(`${HOME}/captures/ring/${stamp}-${hash}.png`, { bytes, mtime })
    if (index === 0) disk.set(`${HOME}/captures/latest.png`, { bytes, mtime })
  })
  disk.set(`${HOME}/captures/latest-projection.json`, { bytes: text('{"made":"up"}'), mtime: now - 2 * MINUTE })
  disk.set(`${HOME}/docs/PENTORA.v0.md`, { bytes: text(PENTORA), mtime: now - 40 * MINUTE })
  disk.set(`${HOME}/docs/pentora/notes.txt`, { bytes: text('Made-up notes.\nLine two.\nLine three.\n'), mtime: now - 3 * 60 * MINUTE })
  disk.set(`${HOME}/docs/pentora/diagram.png`, { bytes: capturePng(320, 200, 2), mtime: now - 5 * 60 * MINUTE })
  disk.set(`${HOME}/docs/data.json`, { bytes: text('{\n  "made": "up",\n  "files": 12,\n  "readOnly": true\n}\n'), mtime: now - 2 * 24 * 60 * MINUTE })
  disk.set(`${HOME}/docs/readme.txt`, { bytes: text('A plain made-up text file.\n'), mtime: now - 30 * 24 * 60 * MINUTE })
  disk.set(`${HOME}/docs/logo.svg`, { bytes: text(SVG), mtime: now - 90 * 24 * 60 * MINUTE })
  disk.set(`${HOME}/docs/unknown.bin`, { bytes: new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0, 7]), mtime: now - 200 * 24 * 60 * MINUTE })
  disk.set(`${HOME}/docs/big-log.txt`, { bytes: bigLog(), mtime: now - 400 * 24 * 60 * MINUTE })
  disk.set(`${HOME}/private/diary.md`, { bytes: text('# Made-up diary\n\nNothing real.\n'), mtime: now - 60 * MINUTE })
  disk.set(`${HOME}/private/photo.png`, { bytes: capturePng(240, 160, 3), mtime: now - 70 * MINUTE })
  for (const path of SECRET_PATHS) disk.set(path, { bytes: text('made-up secret: this must never be shown'), mtime: now - MINUTE })
  return disk
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
})

/** One call to a channel, for the page's own call log (made-up names only). */
export type WorldCall = { readonly channel: 'estate' | 'stat' | 'read' | 'list'; readonly path: string }

/**
 * The fake her over the made-up disk.
 * @param options.latencyMs - how long each call takes (0 in tests).
 * @returns the page bridge, the files service, and the call log.
 */
export function fixtureWorld(options: { readonly now?: number; readonly latencyMs?: number } = {}) {
  const now = options.now ?? Date.now()
  const latency = options.latencyMs ?? 120
  const disk = fixtureDisk(now)
  const calls: WorldCall[] = []

  const estate = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ kind: string; value?: unknown }> => {
    if (name !== 'x6_browser_estate') return { kind: 'missing' }
    const root = String(args.root)
    calls.push({ channel: 'estate', path: root })
    await wait(latency, signal)
    const rows: { path: string; type: 'file' | 'dir'; size?: number; mtimeMs?: number }[] = [{ path: root, type: 'dir' }]
    const dirs = new Set<string>()
    for (const [path, file] of disk) {
      if (!path.startsWith(root + '/') || path.startsWith(`${HOME}/private/`)) continue
      for (let cut = path.lastIndexOf('/'); cut > root.length; cut = path.lastIndexOf('/', cut - 1)) dirs.add(path.slice(0, cut))
      rows.push({ path, type: 'file', size: file.bytes.byteLength, mtimeMs: file.mtime })
    }
    for (const dir of dirs) rows.push({ path: dir, type: 'dir' })
    rows.sort((a, b) => (a.path < b.path ? -1 : 1))
    const cursor = typeof args.cursor === 'number' ? args.cursor : 0
    const limit = typeof args.limit === 'number' ? args.limit : 200
    const page = rows.slice(cursor, cursor + limit)
    const nextCursor = cursor + limit < rows.length ? cursor + limit : null
    const present = [...disk.keys()].some(path => path.startsWith(`${HOME}/private/`))
    return { kind: 'ok', value: { ok: true, vfs: { root, entries: page, page: { nextCursor }, private: { present }, totals: { walkTruncated: false } } } }
  }

  const files: DriveFiles = {
    stat: async (_session, path, signal) => {
      calls.push({ channel: 'stat', path })
      await wait(latency / 2, signal)
      const file = disk.get(path)
      return file === undefined
        ? { ok: false, error: { code: 'workspace-file/not-found' } }
        : { ok: true, value: { absolutePath: path, version: 'made-up-v1', bytes: file.bytes.byteLength } }
    },
    readBytes: async (_session, path, opts, signal) => {
      calls.push({ channel: 'read', path })
      await wait(latency / 2, signal)
      const file = disk.get(path)
      if (file === undefined) return { ok: false, error: { code: 'workspace-file/not-found' } }
      const offset = opts.range?.offset ?? 0
      const data = file.bytes.subarray(offset, offset + (opts.range?.length ?? file.bytes.byteLength))
      return { ok: true, value: { data, version: 'made-up-v1', eof: offset + data.byteLength >= file.bytes.byteLength } }
    },
    list: async (_session, dir, signal) => {
      calls.push({ channel: 'list', path: dir })
      await wait(latency / 2, signal)
      const children = new Map<string, { name: string; type: 'file' | 'directory'; size?: number }>()
      for (const [path, file] of disk) {
        if (!path.startsWith(dir + '/')) continue
        const rest = path.slice(dir.length + 1)
        const slash = rest.indexOf('/')
        const name = slash < 0 ? rest : rest.slice(0, slash)
        children.set(name, slash < 0 ? { name, type: 'file', size: file.bytes.byteLength } : { name, type: 'directory' })
      }
      return { ok: true, value: { entries: [...children.values()], truncated: false } }
    },
  }

  const bridge = {
    version: 1 as const,
    createRead: (): never => { throw new Error('the drive fixture has no Work readout') },
    callTool: estate,
  }
  // One made-up thread in her home folder, shown in the main view (the Spatial frame's thread list and the drive read it).
  const sessions = {
    phase: 'ready' as const,
    ids: ['made-up-home-thread'],
    byId: {
      'made-up-home-thread': {
        id: 'made-up-home-thread', cwd: HOME, retainedBy: { mainView: 1 }, displayTitle: 'A made-up thread', title: 'A made-up thread',
        running: false, blank: false, updatedAt: now - 3 * MINUTE,
      },
    },
  }
  return { disk, calls, bridge, files, sessions }
}
