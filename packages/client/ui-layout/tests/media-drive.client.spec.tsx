// @vitest-environment jsdom
/**
 * Media and Documents, her drive, on screen (jsdom): the Drive view inside Media, its places, rows, preview, Download
 * and Copy path, chat targets, honest states, and that it never polls or writes. Her worker is faked by an in-memory
 * disk behind a fake page bridge (listing) and a fake files service (stat and byte windows). Every file is made up.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEDIA_SURFACE, MediaSurface } from '../src/client/spatial/apps/media/MediaSurface.tsx'
import { createDriveFilesDoor, type DriveFiles } from '../src/client/spatial/apps/media/drive-source.ts'
import { APP_SCROLLER_RULE, fakeLane } from './drive-fixture/lane.ts'

type MediaProps = Parameters<typeof MediaSurface>[0]
const DRIVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/spatial/apps/media')
const MiB = 1024 * 1024
const HOME = '/dsh/home/auma'
const NOW = new Date(2026, 10, 12, 18, 0).getTime()
const at = (h: number, m: number): number => new Date(2026, 10, 12, h, m).getTime()
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

interface FakeFile { bytes?: Uint8Array; size?: number; mtime?: number; versions?: (read: number) => string }
type Disk = Record<string, FakeFile>

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const BASE: Disk = {
  [`${HOME}/captures/latest.png`]: { bytes: PNG, mtime: at(14, 5) },
  [`${HOME}/captures/ring/20261112T130000Z-aaaaaaaaaaaa.png`]: { bytes: PNG, mtime: at(13, 0) },
  [`${HOME}/captures/ring/20261112T140500Z-bbbbbbbbbbbb.png`]: { bytes: new Uint8Array(48 * 1024), mtime: at(14, 5) },
  [`${HOME}/captures/latest-projection.json`]: { bytes: enc('{}'), mtime: at(14, 5) },
  [`${HOME}/docs/PENTORA.v0.md`]: { bytes: enc('# Pentora\n\nmade-up text'), mtime: at(12, 0) },
  [`${HOME}/docs/pentora/notes.txt`]: { bytes: enc('line one\nline two'), mtime: at(11, 0) },
  [`${HOME}/docs/data.json`]: { bytes: enc('{\n  "made": "up"\n}'), mtime: at(10, 0) },
}

interface World {
  readonly calls: string[]
  readonly toolNames: string[]
  readonly bridge: {
    version: 1
    createRead: () => never
    callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
  readonly files: DriveFiles
  readonly door: ReturnType<typeof createDriveFilesDoor>
}

/** The fake her: an estate listing over the disk, and the files service over the same disk; every call is logged. */
function world(disk: Disk, options: { callTool?: World['bridge']['callTool'] } = {}): World {
  const calls: string[] = []
  const toolNames: string[] = []
  const reads = new Map<string, number>()
  const tree = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    toolNames.push(name)
    calls.push(`tree ${String(args.root)}`)
    const root = String(args.root)
    const dirs = new Set<string>()
    const entries: unknown[] = [{ path: root, type: 'dir' }]
    for (const [path, file] of Object.entries(disk)) {
      if (!path.startsWith(root + '/') || path.startsWith(`${HOME}/private/`)) continue
      for (let cut = path.lastIndexOf('/'); cut > root.length; cut = path.lastIndexOf('/', cut - 1)) dirs.add(path.slice(0, cut))
      entries.push({ path, type: 'file', size: file.size ?? file.bytes?.byteLength ?? 0, mtimeMs: file.mtime ?? 0, sha256: null })
    }
    for (const dir of dirs) entries.push({ path: dir, type: 'dir' })
    const present = Object.keys(disk).some(path => path.startsWith(`${HOME}/private/`))
    return { kind: 'ok', value: { ok: true, vfs: { root, entries, page: { nextCursor: null }, private: { present } } } }
  }
  const sizeOf = (file: FakeFile): number => file.size ?? file.bytes?.byteLength ?? 0
  const filesTarget: DriveFiles = {
    stat: async (_s, path) => {
      const file = disk[path]
      return file === undefined ? { ok: false, error: { code: 'workspace-file/not-found' } } : { ok: true, value: { absolutePath: path, version: 'v1', bytes: sizeOf(file) } }
    },
    readBytes: async (_s, path, opts) => {
      const file = disk[path]
      if (file?.bytes === undefined) return { ok: false, error: { code: 'workspace-file/not-found' } }
      const count = (reads.get(path) ?? 0) + 1
      reads.set(path, count)
      const offset = opts.range?.offset ?? 0
      const data = file.bytes.subarray(offset, offset + (opts.range?.length ?? file.bytes.byteLength))
      return { ok: true, value: { data, version: file.versions?.(count) ?? 'v1', eof: offset + data.byteLength >= file.bytes.byteLength } }
    },
    list: async (_s, path) => {
      const names = new Map<string, 'file' | 'directory'>()
      for (const key of Object.keys(disk)) {
        if (!key.startsWith(path + '/')) continue
        const rest = key.slice(path.length + 1)
        const slash = rest.indexOf('/')
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory')
      }
      return { ok: true, value: { entries: [...names].map(([name, type]) => ({ name, type, ...(type === 'file' ? { size: sizeOf(disk[`${path}/${name}`] ?? {}) } : {}) })), truncated: false } }
    },
  }
  // Every method the drive touches is logged by its own name, so anything beyond the three reads would show.
  const files = new Proxy(filesTarget, {
    get(target, key) {
      const method = Reflect.get(target, key) as ((...args: unknown[]) => unknown) | undefined
      if (typeof method !== 'function') return method
      return (...args: unknown[]) => {
        calls.push(`${key === 'list' ? 'children' : key === 'readBytes' ? 'read' : String(key)} ${String(args[1])}`)
        return method(...args)
      }
    },
  })
  const door = createDriveFilesDoor()
  door.set(files)
  const bridge = { version: 1 as const, createRead: (): never => { throw new Error('the drive never reads Work') }, callTool: options.callTool ?? tree }
  return { calls, toolNames, bridge, files, door }
}

const SESSIONS = { ids: ['s1'], byId: { s1: { id: 's1', cwd: HOME, retainedBy: { mainView: 1 } } } }
const NO_SESSIONS = { ids: [], byId: {} }

function mount(w: World | null, extra: Partial<Record<string, unknown>> = {}, sessions: unknown = SESSIONS) {
  if (w !== null) vi.stubGlobal('__AUKORA_SUPERAGENT__', w.bridge)
  const props = (target?: string) => ({
    activeSurface: MEDIA_SURFACE, closeSurface: extra.closeSurface ?? (() => undefined), surfaceTarget: target,
    useSessions: (select: (s: unknown) => unknown) => select(sessions),
    ...(w === null ? {} : { driveFiles: w.door }),
  }) as unknown as MediaProps
  const view = render(<MediaSurface {...props(extra.target as string | undefined)} />)
  return { ...view, retarget: (target: string) => { view.rerender(<MediaSurface {...props(target)} />) } }
}

const drive = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('[data-media-drive]')
  if (found === null) throw new Error('no drive')
  return found
}
const rowNames = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-drive-list] .ak-row__title')].map(node => node.textContent ?? '')
const place = (container: HTMLElement, name: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-drive-place="${name}"]`)
  if (found === null) throw new Error(`no place ${name}`)
  return found
}
const open = async (container: HTMLElement, path: string): Promise<void> => {
  await waitFor(() => { expect(container.querySelector(`[data-drive-open="${path}"]`)).not.toBeNull() })
  fireEvent.click(container.querySelector(`[data-drive-open="${path}"]`) as HTMLElement)
}
const preview = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('[data-drive-preview]') as HTMLElement
const listed = async (container: HTMLElement): Promise<void> => {
  await waitFor(() => { expect(container.querySelector('[data-drive-list][data-state="ready"]')).not.toBeNull() })
}

let blobs: Blob[] = []
beforeEach(() => {
  blobs = []
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:http://localhost/${String(blobs.length)}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Media and Documents: the Drive view', () => {
  it('D1 opens on Drive; NOT CONNECTED YET only on Studio (it names the studio\'s connector); Generate still disabled', async () => {
    const w = world(BASE)
    const { container } = mount(w)
    expect(container.querySelector('[data-media-studio][data-settings-surface]')).not.toBeNull()
    const trailing = (): (string | null)[] => [...(container.querySelector('.ak-header__badges')?.children ?? [])].map(child => child.textContent)
    // The drive reads her files and needs no connector: on Drive the header says nothing about one.
    expect(trailing()).toEqual(['Settings'])
    expect(container.querySelector('.ak-header')?.textContent).not.toContain('NOT CONNECTED YET')
    expect(container.querySelector('.ak-header')?.textContent).toContain('Media and Documents')
    const tabs = [...container.querySelectorAll('[data-media-view]')]
    expect(tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Drive', 'true'], ['Studio', 'false']])
    expect(drive(container)).toBeTruthy()
    expect(container.querySelector('[data-media-gallery]')).toBeNull()
    await listed(container)
    fireEvent.click(tabs[1] as HTMLElement)
    expect(container.querySelector('[data-media-drive]')).toBeNull()
    expect(trailing()).toEqual(['NOT CONNECTED YET', 'Settings'])
    fireEvent.click(tabs[0] as HTMLElement)
    expect(trailing()).toEqual(['Settings'])
    fireEvent.click(tabs[1] as HTMLElement)
    const generate = [...container.querySelectorAll('button')].find(button => button.textContent === 'Generate')
    expect(generate?.disabled).toBe(true)
    expect(container.querySelector('[data-media-gallery]')).not.toBeNull()
  })

  it('D2 Captures lists her screenshots newest first with name, kind, size and time, and says only 12 are kept', async () => {
    const { container } = mount(world(BASE))
    await listed(container)
    expect(place(container, 'captures').getAttribute('aria-pressed')).toBe('true')
    expect(place(container, 'captures').textContent).toBe('Captures3')
    expect(rowNames(container)).toEqual(['20261112T140500Z-bbbbbbbbbbbb.png', 'latest.png', '20261112T130000Z-aaaaaaaaaaaa.png'])
    const first = container.querySelector('[data-drive-list] .ak-row')
    expect(first?.textContent).toContain('PNG image')
    expect(first?.textContent).toContain('48 KB · 14:05')
    expect(first?.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(at(14, 5)).toISOString())
    expect(drive(container).textContent).toContain('Her last 12 screenshots. Older ones are replaced.')
    expect(drive(container).textContent).toContain('Read only: the drive never changes her files.')
    expect(drive(container).textContent).not.toContain('latest-projection.json')
  })

  it('D3 never shows a secret-shaped or key-like file, in any place', async () => {
    const disk: Disk = {
      ...BASE,
      [`${HOME}/docs/credentials.yaml`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/.credentials.yaml.3fa9c1d2e4b5.tmp`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/.ssh/config`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/device-keypair.json`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/plans/secret-plan.md`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/credentials/notes.md`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/.env.local`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/captures/private-key.png`]: { bytes: PNG, mtime: 1 },
      [`${HOME}/captures/ring/my-password.png`]: { bytes: PNG, mtime: 1 },
      [`${HOME}/docs/id_rsa`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/.npmrc`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/api_token.txt`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/session.cap.json`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/.afferent-probe.json`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/pepper.v2`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/docs/AuthKey_A.p8`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/captures/nsec1shot.png`]: { bytes: PNG, mtime: 1 },
    }
    const { container } = mount(world(disk))
    await listed(container)
    for (const name of ['captures', 'documents', 'images', 'video']) {
      fireEvent.click(place(container, name))
      const text = container.textContent ?? ''
      for (const secret of ['credentials', '.ssh', 'keypair', 'secret-plan', '.env', 'private-key', 'password',
        'id_rsa', 'npmrc', 'api_token', 'session.cap', 'afferent', 'pepper', 'AuthKey', 'nsec']) expect(text, `${name}: ${secret}`).not.toContain(secret)
    }
    fireEvent.click(place(container, 'documents'))
    expect(rowNames(container)).toEqual(['PENTORA.v0.md', 'notes.txt', 'data.json'])
    expect(container.querySelector('[data-drive-place="folder:/dsh/home/auma/docs/pentora"]')?.textContent).toBe('pentora')
    expect(container.querySelector('[data-drive-place^="folder:"][data-drive-place*="plans"]')).not.toBeNull()
  })

  it('D4 Private stays one closed row; its children list only after Open folder; nothing in it is read before Show preview', async () => {
    const disk: Disk = {
      ...BASE,
      [`${HOME}/private/diary.md`]: { bytes: enc('# Dear diary\n\nmade-up'), mtime: 1 },
      [`${HOME}/private/.ssh/id`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/private/my-password.txt`]: { bytes: enc('x'), mtime: 1 },
      [`${HOME}/private/letters/one.txt`]: { bytes: enc('one'), mtime: 1 },
    }
    const w = world(disk)
    const { container } = mount(w)
    await listed(container)
    fireEvent.click(place(container, 'private'))
    expect(container.textContent).toContain('Kept on this device. Opens when you tap it.')
    expect(container.textContent).not.toContain('diary.md')
    expect(w.calls.filter(call => call.includes('/private'))).toEqual([])
    fireEvent.click(container.querySelector('[data-drive-open-folder="/dsh/home/auma/private"]') as HTMLElement)
    await waitFor(() => { expect(rowNames(container)).toEqual(['diary.md', 'letters']) })
    expect(container.textContent).not.toContain('password')
    expect(container.textContent).not.toContain('.ssh')
    fireEvent.click(container.querySelector('[data-drive-open-folder="/dsh/home/auma/private/letters"]') as HTMLElement)
    await waitFor(() => { expect(rowNames(container)).toEqual(['diary.md', 'letters', 'one.txt']) })
    await open(container, `${HOME}/private/diary.md`)
    expect(preview(container).textContent).toContain('This file is in Private.')
    expect(preview(container).querySelector('[data-drive-download]')).toBeNull()
    expect(w.calls.filter(call => /^(stat|read) /u.test(call))).toEqual([])
    fireEvent.click(preview(container).querySelector('[data-drive-reveal]') as HTMLElement)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Dear diary') })
    expect(w.calls.filter(call => /^read /u.test(call))).toEqual([`read ${HOME}/private/diary.md`])
  })

  it('D5 renders Markdown, and links to this site do nothing while other sites open in a new tab', async () => {
    const markdown = '# Title\n\n[same](http://localhost/x) [loud](HTTPS://LOCALHOST./x) [port](http://localhost:9999/y) [js](javascript:alert(1)) [ext](https://example.com/page)'
      + ' [ftp](ftp://example.com/f) [file](file:///etc/hosts) [code](vscode://file/x)'
    const disk: Disk = { ...BASE, [`${HOME}/docs/links.md`]: { bytes: enc(markdown), mtime: at(17, 0) } }
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { container } = mount(world(disk))
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/links.md`)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Title') })
    const anchors = [...preview(container).querySelectorAll('a[href]')]
    for (const name of ['same', 'loud', 'port']) {
      const anchor = anchors.find(a => a.textContent?.includes(name))
      if (anchor === undefined) throw new Error(`no ${name} link`)
      expect(fireEvent.click(anchor), name).toBe(false)
      // A modified click or a middle click would open a second copy of her in a new tab: the guard stops those too.
      expect(fireEvent.click(anchor, { metaKey: true }), `${name} cmd-click`).toBe(false)
      expect(fireEvent.click(anchor, { ctrlKey: true }), `${name} ctrl-click`).toBe(false)
      expect(fireEvent(anchor, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })), `${name} middle click`).toBe(false)
    }
    // Odd schemes never move this tab.
    for (const name of ['ftp', 'file', 'code']) {
      const anchor = anchors.find(a => a.textContent === name)
      if (anchor === undefined) throw new Error(`no ${name} link`)
      expect(fireEvent.click(anchor), name).toBe(false)
      expect(fireEvent(anchor, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })), `${name} middle click`).toBe(false)
    }
    expect(opened).not.toHaveBeenCalled()
    const external = anchors.find(a => a.textContent?.includes('ext'))
    if (external === undefined) throw new Error('no external link')
    expect(fireEvent.click(external)).toBe(false)
    expect(opened).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer')
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('D6 shows text and JSON exactly, in a pre', async () => {
    const { container } = mount(world(BASE))
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/pentora/notes.txt`)
    await waitFor(() => { expect(preview(container).querySelector('pre')?.textContent).toBe('line one\nline two') })
    await open(container, `${HOME}/docs/data.json`)
    await waitFor(() => { expect(preview(container).querySelector('pre')?.textContent).toBe('{\n  "made": "up"\n}') })
    expect(preview(container).textContent).toContain(`${HOME}/docs/data.json`)
    expect(preview(container).textContent).toContain('JSON')
  })

  it('D7 draws a PNG from a typed blob, and shows SVG and HTML only as text, never as a page or an image', async () => {
    const svg = '<svg id="evil" xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const html = '<html><body><div id="evil2">x</div><script>alert(2)</script></body></html>'
    const disk: Disk = { ...BASE, [`${HOME}/docs/draw.svg`]: { bytes: enc(svg), mtime: 3 }, [`${HOME}/docs/page.html`]: { bytes: enc(html), mtime: 2 } }
    const { container } = mount(world(disk))
    await listed(container)
    await open(container, `${HOME}/captures/latest.png`)
    await waitFor(() => { expect(preview(container).querySelector('img[src^="blob:"]')).not.toBeNull() })
    expect(blobs.map(blob => blob.type)).toEqual(['image/png'])
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/draw.svg`)
    await waitFor(() => { expect(preview(container).querySelector('pre')?.textContent).toBe(svg) })
    expect(preview(container).querySelector('img')).toBeNull()
    expect(document.getElementById('evil')).toBeNull()
    await open(container, `${HOME}/docs/page.html`)
    await waitFor(() => { expect(preview(container).querySelector('pre')?.textContent).toBe(html) })
    expect(document.getElementById('evil2')).toBeNull()
    for (const blob of blobs) expect(blob.type).not.toMatch(/svg|html|xml/u)
  })

  it('D8 a file with no preview says so and offers Download, reading nothing', async () => {
    const disk: Disk = { ...BASE, [`${HOME}/docs/blob.bin`]: { bytes: new Uint8Array([0, 1, 2]), mtime: 5 } }
    const w = world(disk)
    const { container } = mount(w)
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/blob.bin`)
    await waitFor(() => { expect(preview(container).textContent).toContain('No preview: download it to open it.') })
    expect(preview(container).querySelector('[data-drive-download]')?.textContent).toContain('Download')
    expect(w.calls.filter(call => call.startsWith('read'))).toEqual([])
  })

  it('D9 previews text up to 2 MiB and images up to 16 MiB; over a cap it says so and reads nothing', async () => {
    const disk: Disk = {
      ...BASE,
      [`${HOME}/docs/full.txt`]: { bytes: new Uint8Array(2 * MiB).fill(0x61), mtime: 9 },
      [`${HOME}/docs/over.txt`]: { size: 2 * MiB + 1, mtime: 8 },
      [`${HOME}/docs/huge.png`]: { size: 16 * MiB + 1, mtime: 7 },
    }
    const w = world(disk)
    const { container } = mount(w)
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/full.txt`)
    await waitFor(() => { expect(preview(container).querySelector('pre')?.textContent?.length).toBe(2 * MiB) })
    await open(container, `${HOME}/docs/over.txt`)
    await waitFor(() => { expect(preview(container).textContent).toContain('Too large to preview here (2.0 MB). Download it instead.') })
    fireEvent.click(place(container, 'images'))
    await open(container, `${HOME}/docs/huge.png`)
    await waitFor(() => { expect(preview(container).textContent).toContain('Too large to preview here (16 MB). Download it instead.') })
    expect(w.calls.filter(call => call.startsWith('read')).every(call => call === `read ${HOME}/docs/full.txt`)).toBe(true)
  })

  it('D10 Download saves the exact bytes under the file\'s own name in 2 MiB windows; over 64 MB it refuses', async () => {
    const big = new Uint8Array(5 * MiB).map((_v, i) => i % 253)
    const disk: Disk = { ...BASE, [`${HOME}/docs/PENTORA.v0.md`]: { bytes: big, mtime: 9 }, [`${HOME}/docs/giant.bin`]: { size: 64 * MiB + 1, mtime: 1 } }
    const w = world(disk)
    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this) })
    const { container } = mount(w)
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(preview(container).querySelector('[data-drive-download]')).not.toBeNull() })
    fireEvent.click(preview(container).querySelector('[data-drive-download]') as HTMLElement)
    await waitFor(() => { expect(clicks).toHaveLength(1) })
    expect(clicks[0]?.download).toBe('PENTORA.v0.md')
    expect(clicks[0]?.href).toMatch(/^blob:/u)
    const saved = blobs.at(-1)
    expect(saved?.type).toBe('application/octet-stream')
    expect(Buffer.from(new Uint8Array(await (saved as Blob).arrayBuffer())).equals(Buffer.from(big))).toBe(true)
    expect(w.calls.filter(call => call.startsWith('read'))).toHaveLength(3)
    await open(container, `${HOME}/docs/giant.bin`)
    await waitFor(() => { expect(preview(container).querySelector('[data-drive-download]')).not.toBeNull() })
    fireEvent.click(preview(container).querySelector('[data-drive-download]') as HTMLElement)
    await waitFor(() => { expect(preview(container).textContent).toContain('Too large to download here (over 64 MB).') })
    expect(clicks).toHaveLength(1)
    expect(w.calls.filter(call => call === `read ${HOME}/docs/giant.bin`)).toEqual([])
  })

  it('D11 a file that changes while it downloads is not saved', async () => {
    const disk: Disk = { ...BASE, [`${HOME}/docs/moving.bin`]: { bytes: new Uint8Array(5 * MiB), mtime: 9, versions: read => (read >= 2 ? 'v2' : 'v1') } }
    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this) })
    const { container } = mount(world(disk))
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/moving.bin`)
    await waitFor(() => { expect(preview(container).querySelector('[data-drive-download]')).not.toBeNull() })
    fireEvent.click(preview(container).querySelector('[data-drive-download]') as HTMLElement)
    await waitFor(() => { expect(preview(container).textContent).toContain('The file changed while it was being read. Try again.') })
    expect(clicks).toEqual([])
  })

  it('D12 Copy path puts the exact path on the clipboard, and says so when it cannot', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = mount(world(BASE))
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/PENTORA.v0.md`)
    const copy = (): HTMLElement => preview(container).querySelector('[data-drive-copy]') as HTMLElement
    await waitFor(() => { expect(copy()).not.toBeNull() })
    fireEvent.click(copy())
    await waitFor(() => { expect(copy().textContent).toContain('Copied') })
    expect(writeText).toHaveBeenCalledWith(`${HOME}/docs/PENTORA.v0.md`)
    writeText.mockRejectedValueOnce(new Error('denied'))
    await open(container, `${HOME}/docs/data.json`)
    fireEvent.click(copy())
    await waitFor(() => { expect(preview(container).textContent).toContain('Could not copy. The path is shown above.') })
  })

  it('D13 a chat target opens the file; the same link again re-selects it; refused targets say why and read nothing', async () => {
    const disk: Disk = { ...BASE, [`${HOME}/private/diary.md`]: { bytes: enc('# d'), mtime: 1 }, [`${HOME}/docs/credentials.yaml`]: { bytes: enc('x'), mtime: 1 } }
    const w = world(disk)
    const { container, retarget } = mount(w)
    await listed(container)
    fireEvent.click(container.querySelector('[data-media-view="studio"]') as HTMLElement)
    retarget(`drive:1:${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pentora') })
    expect(place(container, 'documents').getAttribute('aria-pressed')).toBe('true')
    await open(container, `${HOME}/docs/data.json`)
    await waitFor(() => { expect(preview(container).querySelector('pre')).not.toBeNull() })
    retarget(`drive:2:${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pentora') })
    expect(container.querySelector(`[data-drive-open="${HOME}/docs/PENTORA.v0.md"]`)?.getAttribute('aria-pressed')).toBe('true')

    retarget(`drive:3:${HOME}/docs/credentials.yaml`)
    await waitFor(() => { expect(preview(container).textContent).toContain('This file is kept out of the drive.') })
    expect(preview(container).textContent).not.toContain('credentials')
    retarget(`drive:4:${HOME}/docs/nope.md`)
    await waitFor(() => { expect(preview(container).textContent).toContain(`There is no file at ${HOME}/docs/nope.md.`) })
    retarget('drive:5:/dsh/home/owner/a.md')
    await waitFor(() => { expect(preview(container).textContent).toContain('This file is outside her home folder, so the drive does not open it.') })
    const before = w.calls.length
    retarget(`drive:6:${HOME}/docs/../private/x.md`)
    await waitFor(() => { expect(preview(container).textContent).toContain('This path is not a plain file path, so the drive does not open it.') })
    retarget(`drive:7:${HOME}/private/diary.md`)
    await waitFor(() => { expect(preview(container).textContent).toContain('This file is in Private.') })
    expect(w.calls.slice(before)).toEqual([])
  })

  it('D14 says plainly when it cannot read: no channel, worker not running, no thread, she is busy', async () => {
    const { container: none } = mount(null)
    await waitFor(() => { expect(none.textContent).toContain('The drive cannot read her files in this build yet.') })
    cleanup()

    const stopped = world(BASE, { callTool: async () => ({ kind: 'control-unavailable' }) })
    const { container: down } = mount(stopped)
    await waitFor(() => { expect(down.textContent).toContain('Her worker is not running in this tab, so her files cannot be read right now.') })
    cleanup()

    const { container: threadless, retarget } = mount(world(BASE), {}, NO_SESSIONS)
    await listed(threadless)
    retarget(`drive:9:${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(threadless.textContent).toContain('The drive reads through a thread. Open any thread, then press Refresh.') })
    cleanup()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const stuck = world(BASE, { callTool: (_n, _a, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ kind: 'aborted' }) }) }) })
    const { container: busy } = mount(stuck)
    expect(busy.textContent).toContain('Reading her files…')
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(busy.textContent).toContain('She did not answer in time; she may be busy. Press Refresh to try again.')
  })

  it('D15 lists once on open and on Refresh only: no timer, no background reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const w = world(BASE)
    const { container } = mount(w)
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    }
    await settle()
    const trees = (): number => w.calls.filter(call => call.startsWith('tree')).length
    expect(trees()).toBe(2)
    expect(container.querySelector('[data-drive-list][data-state="ready"]')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    await settle()
    expect(trees()).toBe(2)
    fireEvent.click(container.querySelector('[data-drive-refresh]') as HTMLElement)
    await settle()
    expect(trees()).toBe(4)
  })

  it('D16 calls only the four reads and her estate tool; Escape still closes the surface', async () => {
    const closeSurface = vi.fn()
    const w = world({ ...BASE, [`${HOME}/private/a.md`]: { bytes: enc('a'), mtime: 1 } })
    const { container } = mount(w, { closeSurface })
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(preview(container).querySelector('h1')).not.toBeNull() })
    fireEvent.click(place(container, 'private'))
    fireEvent.click(container.querySelector('[data-drive-open-folder="/dsh/home/auma/private"]') as HTMLElement)
    await waitFor(() => { expect(rowNames(container)).toEqual(['a.md']) })
    expect(new Set(w.calls.map(call => call.split(' ')[0]))).toEqual(new Set(['tree', 'children', 'stat', 'read']))
    expect(new Set(w.toolNames)).toEqual(new Set(['x6_browser_estate']))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeSurface).toHaveBeenCalledTimes(1)
  })

  it('D17 opens nothing outside Captures, Documents and Private, and refuses the new secret shapes, reading nothing', async () => {
    const disk: Disk = {
      ...BASE,
      [`${HOME}/id_rsa`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/.npmrc`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/notes.md`]: { bytes: enc('# made-up'), mtime: 1 },
      [`${HOME}/seed/ball.json`]: { bytes: enc('{}'), mtime: 1 },
      [`${HOME}/docs/api_token.txt`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/docs/session.cap.json`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/.afferent-probe.json`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/pepper.v2`]: { bytes: enc('made-up'), mtime: 1 },
      [`${HOME}/docs/link.md`]: { bytes: enc('[key](</dsh/home/auma/id_rsa>) [organ](/dsh/home/auma/seed/ball.json)'), mtime: 1 },
    }
    const w = world(disk)
    const { container, retarget } = mount(w)
    await listed(container)
    const before = w.calls.length
    let n = 100
    for (const path of [`${HOME}/id_rsa`, `${HOME}/.npmrc`, `${HOME}/notes.md`, `${HOME}/seed/ball.json`, `${HOME}/.afferent-probe.json`, `${HOME}/pepper.v2`]) {
      n += 1
      retarget(`drive:${String(n)}:${path}`)
      await waitFor(() => { expect(preview(container).textContent, path).toContain('This file is not in Captures, Documents or Private, so the drive does not open it.') })
      expect(preview(container).querySelector('[data-drive-download]'), path).toBeNull()
    }
    for (const path of [`${HOME}/docs/api_token.txt`, `${HOME}/docs/session.cap.json`]) {
      n += 1
      retarget(`drive:${String(n)}:${path}`)
      await waitFor(() => { expect(preview(container).textContent, path).toContain('This file is kept out of the drive.') })
      expect(preview(container).querySelector('[data-drive-download]'), path).toBeNull()
    }
    expect(w.calls.slice(before)).toEqual([])
    // A file link inside a previewed document to a file outside the places is refused the same way.
    for (const text of ['key', 'organ']) {
      n += 1
      retarget(`drive:${String(n)}:${HOME}/docs/link.md`)
      const link = (): HTMLElement | undefined => [...preview(container).querySelectorAll('button')].find(b => b.textContent === text)
      await waitFor(() => { expect(link()).toBeDefined() })
      const reads = w.calls.length
      fireEvent.click(link() as HTMLElement)
      await waitFor(() => { expect(preview(container).textContent).toContain('This file is not in Captures, Documents or Private, so the drive does not open it.') })
      expect(w.calls.slice(reads)).toEqual([])
    }
  })

  it('D18 a previewed document never loads an image: remote, this-site and local images show as text, and nothing is fetched', async () => {
    const markdown = '# Pictures\n\n![beacon](https://evil.example/b.png?leak=1) ![same](http://localhost/api/session/x.png)\n\n'
      + '![ref][r]\n\n[r]: https://evil.example/r.png\n\n[![inlink](https://evil.example/c.png)](https://example.com)\n\n'
      + '![cap](</dsh/home/auma/captures/latest.png>)\n\n<img src="https://evil.example/html.png">'
    const disk: Disk = { ...BASE, [`${HOME}/docs/img.md`]: { bytes: enc(markdown), mtime: at(17, 0) } }
    const { container } = mount(world(disk))
    await listed(container)
    fireEvent.click(place(container, 'documents'))
    await open(container, `${HOME}/docs/img.md`)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pictures') })
    expect([...preview(container).querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([])
    expect(container.querySelector('img[src^="http"]')).toBeNull()
    expect(preview(container).textContent).toContain('beacon')
    expect(preview(container).textContent).toContain('inlink')
  })

  it('D19 Refresh also reads the selected file again, so a line that says to press Refresh is true', async () => {
    const sessions: { ids: string[]; byId: Record<string, unknown> } = { ids: [], byId: {} }
    const { container, retarget } = mount(world(BASE), {}, sessions)
    await listed(container)
    retarget(`drive:30:${HOME}/docs/PENTORA.v0.md`)
    await waitFor(() => { expect(preview(container).textContent).toContain('The drive reads through a thread. Open any thread, then press Refresh.') })
    // He opens a thread: the shell hands Media the new thread list.
    sessions.ids = SESSIONS.ids
    sessions.byId = SESSIONS.byId
    retarget(`drive:30:${HOME}/docs/PENTORA.v0.md`)
    fireEvent.click(container.querySelector('[data-drive-refresh]') as HTMLElement)
    await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pentora') })
  })

  it('D20 a listing cut short says the list is incomplete, without claiming which files are shown', async () => {
    const base = world(BASE)
    const cut = world(BASE, { callTool: async (name, args, signal) => {
      const reply = await base.bridge.callTool(name, args, signal) as { value: { vfs: Record<string, unknown> } }
      reply.value.vfs.totals = { walkTruncated: true }
      return reply
    } })
    const { container } = mount(cut)
    await listed(container)
    expect(drive(container).textContent).toContain('Not every file is listed here. The drive lists the first 6 files it finds, by folder and name.')
    expect(drive(container).textContent).not.toContain('newest')
  })

  // ── Job 3: what was seen on screen ──────────────────────────────────────────────────────────────────────────────

  it('D21 a row names its file cut in the middle (the extension stays), with size, time and one 44px Open', async () => {
    const long = `${HOME}/captures/ring/20261112T140500Z-bbbbbbbbbbbb.png`
    const { container } = mount(world(BASE))
    await listed(container)
    const row = container.querySelector(`[data-drive-open="${long}"]`)?.closest('.ak-row') as HTMLElement
    const name = row.querySelector('[data-drive-name]') as HTMLElement
    expect(name.textContent).toBe('20261112T140500Z-bbbbbbbbbbbb.png')
    expect([...name.children].map(part => part.textContent)).toEqual(['20261112T140500Z-bbbbbb', 'bbbbbb.png'])
    expect(row.querySelector('.ak-row__summary')?.textContent).toBe('48 KB · 14:05 · ring')
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(at(14, 5)).toISOString())
    const controls = row.querySelectorAll('button')
    expect(controls).toHaveLength(1)
    expect(controls[0]?.textContent).toBe('Open')
    // The kind chip sits in its own box, which a phone hides (D24) so the name keeps the room.
    expect(row.querySelector('[data-drive-kind] .ak-pill')?.textContent).toBe('PNG image')
    expect(controls[0]?.getAttribute('aria-label')).toBe('Open 20261112T140500Z-bbbbbbbbbbbb.png')
    // Short names and names without an extension keep every character in one of the two parts.
    fireEvent.click(place(container, 'documents'))
    for (const [file, parts] of [['data.json', ['', 'data.json']], ['PENTORA.v0.md', ['PENT', 'ORA.v0.md']]] as const) {
      const cut = container.querySelector(`[data-drive-open="${HOME}/docs/${file}"]`)?.closest('.ak-row')?.querySelector('[data-drive-name]')
      expect([...(cut?.children ?? [])].map(part => part.textContent), file).toEqual(parts)
    }
  })

  it('D22 Open brings the preview card to the top of the lane and focuses its heading; Escape or Back returns to the row', async () => {
    // jsdom does no layout: the rects are made up (tests/drive-fixture/lane.ts); this pins which element scrolls and by
    // how much for those rects, never pixels.
    const latest = `${HOME}/captures/latest.png`
    const lane = fakeLane((node) => {
      if (node.matches('.ak-app')) return { top: 100, height: 700 }
      if (node.matches('[data-drive-preview-card]')) return { top: 1500 }
      if (node.matches(`[data-drive-open="${latest}"]`)) return { top: 20, height: 44 }
      return undefined
    }, { scrollTop: 1000, clientHeight: 700 })
    try {
      const closeSurface = vi.fn()
      const { container } = mount(world(BASE), { closeSurface })
      await listed(container)
      await open(container, latest)
      const heading = container.querySelector('[data-drive-preview-heading]') as HTMLElement
      await waitFor(() => { expect(document.activeElement).toBe(heading) })
      expect(heading.textContent).toBe('Preview')
      // The card's top (1500) to the top of the lane's visible area (100): scrollTop 1000 + 1400, inside the lane only.
      expect(lane.scrolls).toEqual([{ lane: true, top: 2400, behavior: 'smooth' }])
      // Escape inside the preview goes back to the row's Open, brought just into view (it is above the lane's top: 20 < 100).
      fireEvent.keyDown(heading, { key: 'Escape' })
      expect(document.activeElement?.getAttribute('data-drive-open')).toBe(latest)
      expect(lane.scrolls.at(-1)).toEqual({ lane: true, top: 920, behavior: 'smooth' })
      expect(closeSurface).not.toHaveBeenCalled()
      // The Back control does the same.
      await open(container, latest)
      await waitFor(() => { expect(document.activeElement).toBe(heading) })
      fireEvent.click(container.querySelector('[data-drive-back]') as HTMLElement)
      expect(document.activeElement?.getAttribute('data-drive-open')).toBe(latest)
      expect(container.querySelector('[data-drive-back]')?.textContent).toBe('Back to the list')
      // With less motion asked for, the lane jumps instead of gliding.
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }))
      await open(container, latest)
      await waitFor(() => { expect(lane.scrolls.at(-1)).toEqual({ lane: true, top: 2400, behavior: 'auto' }) })
      // The page itself never moved, and nothing asked every scrolling ancestor to move.
      expect(lane.scrolls.every(call => call.lane)).toBe(true)
      expect(lane.page).not.toHaveBeenCalled()
      expect(lane.intoView).not.toHaveBeenCalled()
    } finally {
      lane.restore()
    }
  })

  it('D23 while the list is read, the places count a dash and only one line says it is reading', async () => {
    let answer: (() => void) | null = null
    const w = world(BASE)
    const slowTree = w.bridge.callTool
    w.bridge.callTool = (name, args, signal) => new Promise((resolve) => { answer = () => { resolve(slowTree(name, args, signal)) } })
    const { container } = mount(w, { target: `drive:1:${HOME}/docs/PENTORA.v0.md` })
    await waitFor(() => { expect(answer).not.toBeNull() })
    const counts = (): (string | null)[] => [...container.querySelectorAll('[data-drive-count]')].map(node => node.getAttribute('data-drive-count'))
    expect(counts()).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect([...container.querySelectorAll('[data-drive-count]')].map(node => node.textContent)).toEqual(['–', '–', '–', '–'])
    // The linked file may be read before the list is: either way only one line says "Reading her files…".
    await waitFor(() => { expect(preview(container).querySelector('h1')).not.toBeNull() })
    expect((container.textContent?.match(/Reading her files…/gu) ?? []).length).toBe(1)
    while (answer !== null) {
      const next: () => void = answer
      answer = null
      await act(async () => { next(); await Promise.resolve() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    await listed(container)
    expect(counts()).toEqual(['3', '3', '0', '0'])
    expect(container.textContent).not.toContain('Reading her files…')
  })

  it('D24 the drive\'s own stylesheet: one column under 700px, chips and Open at 44px, the name cut in the middle', () => {
    const sheet = readFileSync(resolve(DRIVE_DIR, 'Drive.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    const rule = (selector: string): string => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, head = '']) => head.trim() === selector).map(([, , body = '']) => body).join('\n')
    expect(rule('.grid')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.placeTabs')).toContain('flex-wrap: wrap;')
    expect(rule('.open')).toContain('min-height: 44px;')
    expect(rule('.open')).toContain('min-width: 44px;')
    expect(sheet).toMatch(/@container media-drive \(max-width: 699\.98px\) \{\s*\.placeTabs button \{ min-height: 44px; \}/u)
    expect(rule('.nameHead')).toContain('text-overflow: ellipsis;')
    expect(rule('.nameTail')).toContain('flex: none;')
    // Nothing in the drive is wider than its lane: no fixed width or min-width over 320px, and no !important.
    for (const [, value = ''] of sheet.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*([^;]+);/gu)) {
      const px = /^(\d+)px$/u.exec(value.trim())
      if (px !== null) expect(Number(px[1]), value).toBeLessThanOrEqual(320)
    }
    expect(sheet).not.toContain('!important')
    // A phone (the frame's compact rule) hides a row's kind chip, so the name keeps the room.
    expect(rule(':global([data-compact-lane]) .kind')).toContain('display: none;')
    expect(rule('.kind')).toContain('flex: none;')
    // The lane scroller the drive scrolls is the app's own (primitives.css), as tests/drive-fixture/lane.ts assumes.
    expect(readFileSync(resolve(DRIVE_DIR, '../../primitives/primitives.css'), 'utf8')).toMatch(APP_SCROLLER_RULE)
  })

  it('D25 a chat link shows the preview card only once its layout exists: never while the list is read, and again after a move to another place', async () => {
    // jsdom does no layout (see lane.ts): the card is made to sit lower once the list is read, and lower still in Captures,
    // so a scroll measured before the layout existed would show as a wrong number.
    let answer: (() => void) | null = null
    const w = world(BASE)
    const slowTree = w.bridge.callTool
    w.bridge.callTool = (name, args, signal) => new Promise((resolve) => { answer = () => { resolve(slowTree(name, args, signal)) } })
    const lane = fakeLane((node) => {
      if (node.matches('.ak-app')) return { top: 100, height: 700 }
      if (!node.matches('[data-drive-preview-card]')) return undefined
      const ready = document.querySelector('[data-drive-list][data-state="ready"]') !== null
      const captures = document.querySelector('[data-drive-place="captures"]')?.getAttribute('aria-pressed') === 'true'
      return { top: !ready ? 300 : captures ? 1700 : 1500 }
    })
    try {
      const { container, retarget } = mount(w, { target: `drive:1:${HOME}/docs/PENTORA.v0.md` })
      await waitFor(() => { expect(answer).not.toBeNull() })
      await waitFor(() => { expect(preview(container).querySelector('h1')).not.toBeNull() })
      // The linked file is shown, the list is still being read: nothing has scrolled yet.
      expect(lane.scrolls).toEqual([])
      while (answer !== null) {
        const next: () => void = answer
        answer = null
        await act(async () => { next(); await Promise.resolve() })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      }
      await listed(container)
      w.bridge.callTool = slowTree
      await waitFor(() => { expect(lane.scrolls).toEqual([{ lane: true, top: 1400, behavior: 'smooth' }]) })
      const heading = container.querySelector('[data-drive-preview-heading]') as HTMLElement
      // A chat link never takes the keyboard (D28 pins it with a composer focused).
      expect(document.activeElement).not.toBe(heading)
      // A link to a file in another place: the card is measured after that place's list is on screen.
      retarget(`drive:2:${HOME}/captures/latest.png`)
      await waitFor(() => { expect(lane.scrolls).toHaveLength(2) })
      expect(lane.scrolls[1]).toEqual({ lane: true, top: 1600, behavior: 'smooth' })
      expect(place(container, 'captures').getAttribute('aria-pressed')).toBe('true')
      expect(document.activeElement).not.toBe(heading)
      // The same link again (a new click in the chat) shows it again.
      retarget(`drive:3:${HOME}/docs/PENTORA.v0.md`)
      await waitFor(() => { expect(lane.scrolls).toHaveLength(3) })
      // The same file once more: the same words, but the live region's text must CHANGE, or no reader says it again.
      const region = container.querySelector('[data-drive-announce]') as HTMLElement
      const said = region.textContent ?? ''
      expect(said.trim()).not.toBe('')
      retarget(`drive:4:${HOME}/docs/PENTORA.v0.md`)
      await waitFor(() => { expect(lane.scrolls).toHaveLength(4) })
      expect(region.textContent).not.toBe(said)
      expect((region.textContent ?? '').trim()).toBe(said.trim())
      // Refresh reads the selection again and moves nothing.
      fireEvent.click(container.querySelector('[data-drive-refresh]') as HTMLElement)
      await listed(container)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(lane.scrolls).toHaveLength(4)
      expect(lane.page).not.toHaveBeenCalled()
      expect(lane.intoView).not.toHaveBeenCalled()
    } finally {
      lane.restore()
    }
  })

  it('D26 after Open in Captures and a tap on another place there is no dead Back: Escape falls through to Media; back in Captures, Back works', async () => {
    const latest = `${HOME}/captures/latest.png`
    const closeSurface = vi.fn()
    const { container } = mount(world(BASE), { closeSurface })
    await listed(container)
    await open(container, latest)
    const heading = container.querySelector('[data-drive-preview-heading]') as HTMLElement
    await waitFor(() => { expect(document.activeElement).toBe(heading) })
    expect(container.querySelector('[data-drive-back]')).not.toBeNull()
    fireEvent.click(place(container, 'documents'))
    // The row that opened the preview is not on screen: no Back, and Escape is Media's (it closes the app).
    expect(container.querySelector(`[data-drive-open="${latest}"]`)).toBeNull()
    expect(container.querySelector('[data-drive-back]')).toBeNull()
    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(closeSurface).toHaveBeenCalledTimes(1)
    // Back in Captures the row is there again, and so is Back; Escape returns to it and Media stays open.
    fireEvent.click(place(container, 'captures'))
    expect(container.querySelector('[data-drive-back]')).not.toBeNull()
    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(document.activeElement?.getAttribute('data-drive-open')).toBe(latest)
    expect(closeSurface).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('[data-drive-back]') as HTMLElement)
    expect(document.activeElement?.getAttribute('data-drive-open')).toBe(latest)
  })

  it('D27 a chat link is revealed once: Studio, then Drive again (the drive mounts anew) restores the file with no scroll and no focus move', async () => {
    const pentora = `${HOME}/docs/PENTORA.v0.md`
    const lane = fakeLane((node) => {
      if (node.matches('.ak-app')) return { top: 100, height: 700 }
      if (node.matches('[data-drive-preview-card]')) return { top: 1500 }
      return undefined
    })
    try {
      const w = world(BASE)
      const { container, retarget } = mount(w)
      await listed(container)
      retarget(`drive:1:${pentora}`)
      await waitFor(() => { expect(lane.scrolls).toEqual([{ lane: true, top: 1400, behavior: 'smooth' }]) })
      await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pentora') })
      // The keyboard on the tablist: ArrowRight to Studio, ArrowLeft back to Drive (the target is still in the store).
      const tab = (value: string): HTMLElement => container.querySelector(`[data-media-view="${value}"]`) as HTMLElement
      tab('drive').focus()
      fireEvent.keyDown(tab('drive'), { key: 'ArrowRight' })
      expect(document.activeElement).toBe(tab('studio'))
      expect(container.querySelector('[data-media-drive]')).toBeNull()
      fireEvent.keyDown(tab('studio'), { key: 'ArrowLeft' })
      expect(document.activeElement).toBe(tab('drive'))
      await listed(container)
      // The file is still selected, in its place, its preview read again...
      await waitFor(() => { expect(preview(container).querySelector('h1')?.textContent).toBe('Pentora') })
      expect(container.querySelector(`[data-drive-open="${pentora}"]`)?.getAttribute('aria-pressed')).toBe('true')
      expect(place(container, 'documents').getAttribute('aria-pressed')).toBe('true')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      // ...but nothing scrolled again, the focus stayed on the Drive tab, and nothing was announced again.
      expect(lane.scrolls).toHaveLength(1)
      expect(document.activeElement).toBe(tab('drive'))
      expect(container.querySelector('[data-drive-announce]')?.textContent).toBe('')
      // A new click in the chat (a new target, even for the same file) is a new reveal.
      retarget(`drive:2:${pentora}`)
      await waitFor(() => { expect(lane.scrolls).toHaveLength(2) })
      expect(document.activeElement).toBe(tab('drive'))
    } finally {
      lane.restore()
    }
  })

  it('D28 a chat link scrolls the preview into view but leaves the composer focused, before and after a slow list; the live region names the file once; a row\'s Open still focuses the heading', async () => {
    let answer: (() => void) | null = null
    const w = world(BASE)
    const slowTree = w.bridge.callTool
    w.bridge.callTool = (name, args, signal) => new Promise((resolve) => { answer = () => { resolve(slowTree(name, args, signal)) } })
    const lane = fakeLane((node) => {
      if (node.matches('.ak-app')) return { top: 100, height: 700 }
      if (node.matches('[data-drive-preview-card]')) return { top: 1500 }
      return undefined
    })
    // Her composer (a stand-in): she is typing to Auma when she clicks the link in Auma's message.
    const composer = document.createElement('textarea')
    document.body.append(composer)
    try {
      const { container, retarget } = mount(w)
      await waitFor(() => { expect(answer).not.toBeNull() })
      composer.focus()
      retarget(`drive:1:${HOME}/docs/PENTORA.v0.md`)
      await waitFor(() => { expect(preview(container).querySelector('h1')).not.toBeNull() })
      expect(document.activeElement).toBe(composer)
      expect(lane.scrolls).toEqual([])
      while (answer !== null) {
        const next: () => void = answer
        answer = null
        await act(async () => { next(); await Promise.resolve() })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      }
      await listed(container)
      w.bridge.callTool = slowTree
      // The list came in late: the card is brought into view in the lane, and the composer keeps the keyboard.
      await waitFor(() => { expect(lane.scrolls).toEqual([{ lane: true, top: 1400, behavior: 'smooth' }]) })
      expect(document.activeElement).toBe(composer)
      // The drive's polite live region says which file opened, naming it once.
      const live = container.querySelector('[data-drive-announce]') as HTMLElement
      expect(live.getAttribute('role')).toBe('status')
      expect(live.getAttribute('aria-live')).toBe('polite')
      expect(live.textContent).toBe('Showing PENTORA.v0.md in the drive.')
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(1)
      // A path the drive refuses is never named there: the refusal is said instead.
      retarget(`drive:2:${HOME}/docs/credentials.yaml`)
      // Every other said line carries one trailing no-break space, so the same words twice still change the region.
      await waitFor(() => { expect((live.textContent ?? '').replace(/\u00a0$/, '')).toBe('This file is kept out of the drive.') })
      expect(document.activeElement).toBe(composer)
      // A row's Open started inside the drive: the heading takes the focus, and the live region falls silent.
      await open(container, `${HOME}/docs/data.json`)
      const heading = container.querySelector('[data-drive-preview-heading]') as HTMLElement
      await waitFor(() => { expect(document.activeElement).toBe(heading) })
      expect(live.textContent).toBe('')
      expect(lane.page).not.toHaveBeenCalled()
      expect(lane.intoView).not.toHaveBeenCalled()
    } finally {
      composer.remove()
      lane.restore()
    }
  })
})
