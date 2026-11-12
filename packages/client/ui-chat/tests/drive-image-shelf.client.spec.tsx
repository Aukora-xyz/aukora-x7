// @vitest-environment jsdom
/**
 * AUKORA: her images in one thread, through the chat's real renderer (`AssistantMarkdown`
 * with its real /api/file path vocabulary) and the real drive chain (`driveClaimsImage`, `createDriveImageShelf`,
 * `loadDriveImage`), wired as `ChatView` wires them. A path the drive claims never becomes a file-route URL, while the
 * message streams or with a `?` or `#` suffix; a Private image is never read without the owner's tap, in any state; one
 * file shown by thirty messages is read once and held as one Blob; at most two reads run at once. Every path and byte is
 * made up.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import {
  createDriveImageShelf, driveClaimsImage, DRIVE_IMAGE_READS, OPEN_IN_DRIVE_LABEL, type DriveImageFiles,
} from '../src/client/drive-link.ts'

const HOME = '/dsh/home/auma'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const layout = { openSurface: vi.fn() }
const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }
const IMAGE_LABELS = { open: 'Open image', loading: 'Loading image', failed: 'Image unavailable', dialog: 'Image preview', close: 'Close', dragFailed: 'x' }

interface Disk { [path: string]: { bytes: Uint8Array; version: string } }

/** A made-up files service whose calls are logged; `hold` keeps every stat waiting until `release`. */
function filesOver(disk: Disk, options: { hold?: boolean } = {}) {
  const calls: string[] = []
  let inFlight = 0
  let most = 0
  const waiting: (() => void)[] = []
  const gate = (): Promise<void> => (options.hold === true ? new Promise((resolve) => { waiting.push(resolve) }) : Promise.resolve())
  const service: DriveImageFiles = {
    stat: async (_session, path) => {
      calls.push(`stat ${path}`)
      inFlight += 1
      most = Math.max(most, inFlight)
      await gate()
      inFlight -= 1
      const file = disk[path]
      return file === undefined
        ? { ok: false, error: { code: 'workspace-file/not-found' } }
        : { ok: true, value: { absolutePath: path, version: file.version, bytes: file.bytes.byteLength } }
    },
    readBytes: async (_session, path, request) => {
      calls.push(`read ${path}`)
      const file = disk[path]!
      const offset = request.range?.offset ?? 0
      const data = file.bytes.subarray(offset, offset + (request.range?.length ?? Infinity))
      return { ok: true, value: { data, version: file.version, eof: true } }
    },
  }
  return {
    service, calls, most: () => most,
    release: () => { for (const resolve of waiting.splice(0)) resolve() },
  }
}

/** One thread's message list as `ChatView` delegates it: the drive's claim and the shelf, resolved from her home. */
function Thread({ texts, shelf, streaming = false }: {
  readonly texts: readonly string[]
  readonly shelf: ReturnType<typeof createDriveImageShelf>
  readonly streaming?: boolean
}) {
  const fileImages = {
    fileDrag,
    resolve: (path: string) => {
      const absolute = resolveWorkspacePath(HOME, path)
      return driveClaimsImage(layout, absolute) ? undefined : `https://example.com/api/file?path=${encodeURIComponent(absolute)}`
    },
    labels: IMAGE_LABELS,
    load: {
      claims: (path: string) => driveClaimsImage(layout, resolveWorkspacePath(HOME, path)),
      read: (path: string, signal: AbortSignal) => shelf.read(resolveWorkspacePath(HOME, path), signal),
      openLabel: OPEN_IN_DRIVE_LABEL,
    },
  }
  return (
    <MarkdownDelegateProvider openFile={vi.fn()} fileImages={fileImages}>
      {texts.map((text, index) => (
        <AssistantMarkdown key={index} {...{
          blocks: [{ kind: 'text', text }], streaming, t: (key: string) => key,
          loadImage: () => Promise.reject(new Error('unused')), renderSlot: () => null,
          useDisclosure: () => [false, () => {}], useGroupAction: () => false, usePresentation: () => undefined,
        } as unknown as Parameters<typeof AssistantMarkdown>[0]} />
      ))}
    </MarkdownDelegateProvider>
  )
}

let made: Blob[] = []
let revoked: string[] = []
beforeEach(() => {
  made = []
  revoked = []
  URL.createObjectURL = vi.fn((blob: Blob) => { made.push(blob); return `blob:http://localhost/${String(made.length)}` })
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const fileRoutes = (container: HTMLElement): string[] => [...container.querySelectorAll('[src],[href]')]
  .map(node => node.getAttribute('src') ?? node.getAttribute('href') ?? '').filter(url => url.includes('api/file'))

describe('her images in one thread', () => {
  it('I1 thirty messages showing her last screenshot start one read (stat, then one window) and hold one Blob', async () => {
    const files = filesOver({ [`${HOME}/captures/latest.png`]: { bytes: PNG, version: 'v1' } })
    const shelf = createDriveImageShelf(() => files.service, 'home-1')
    const texts = Array.from({ length: 30 }, (_, index) => `Turn ${String(index)} done.\n\n![her last screenshot](<${HOME}/captures/latest.png>)`)
    const view = render(<Thread texts={texts} shelf={shelf} />)
    await waitFor(() => { expect(view.container.querySelectorAll('img')).toHaveLength(30) })
    expect(files.calls).toEqual([`stat ${HOME}/captures/latest.png`, `read ${HOME}/captures/latest.png`])
    expect(made).toHaveLength(1)
    expect(new Set([...view.container.querySelectorAll('img')].map(image => image.getAttribute('src')))).toEqual(new Set(['blob:http://localhost/1']))
    expect(new Uint8Array(await made[0]!.arrayBuffer())).toEqual(PNG)
    view.unmount()
    expect(revoked).toEqual(['blob:http://localhost/1'])
  })

  it('I2 at most two reads run at once in a thread; the rest wait their turn and all arrive', async () => {
    const disk: Disk = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`${HOME}/captures/ring/shot-${String(index)}.png`, { bytes: PNG, version: 'v1' }]))
    const files = filesOver(disk, { hold: true })
    const shelf = createDriveImageShelf(() => files.service, 'home-1')
    const view = render(<Thread texts={Object.keys(disk).map(path => `![s](${path})`)} shelf={shelf} />)
    await act(async () => { await Promise.resolve() })
    expect(DRIVE_IMAGE_READS).toBe(2)
    expect(files.calls.filter(call => call.startsWith('stat'))).toHaveLength(2)
    for (let round = 0; round < 6 && view.container.querySelectorAll('img').length < 6; round += 1) {
      await act(async () => { files.release(); await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    await waitFor(() => { expect(view.container.querySelectorAll('img')).toHaveLength(6) })
    expect(files.most()).toBe(2)
    expect(files.calls.filter(call => call.startsWith('stat'))).toHaveLength(6)
  })

  it('I3 a message shown later pays one stat and reads no byte while the file is unchanged; a changed file is read again', async () => {
    const disk: Disk = { [`${HOME}/captures/latest.png`]: { bytes: PNG, version: 'v1' } }
    const files = filesOver(disk)
    const shelf = createDriveImageShelf(() => files.service, 'home-1')
    const first = render(<Thread texts={[`![a](${HOME}/captures/latest.png)`]} shelf={shelf} />)
    await waitFor(() => { expect(first.container.querySelector('img')).not.toBeNull() })
    files.calls.length = 0
    const later = render(<Thread texts={[`![b](${HOME}/captures/latest.png)`]} shelf={shelf} />)
    await waitFor(() => { expect(later.container.querySelector('img')).not.toBeNull() })
    expect(files.calls).toEqual([`stat ${HOME}/captures/latest.png`])
    expect(made).toHaveLength(1)
    // She takes a new screenshot: the same path, a new version, new bytes.
    disk[`${HOME}/captures/latest.png`] = { bytes: new Uint8Array([0x89, 0x50, 9, 9]), version: 'v2' }
    files.calls.length = 0
    const changed = render(<Thread texts={[`![c](${HOME}/captures/latest.png)`]} shelf={shelf} />)
    await waitFor(() => { expect(changed.container.querySelector('img')).not.toBeNull() })
    expect(files.calls).toEqual([`stat ${HOME}/captures/latest.png`, `read ${HOME}/captures/latest.png`])
    expect(made).toHaveLength(2)
  })

  it('I4 a read is aborted only when every message that asked for it has gone', async () => {
    const files = filesOver({ [`${HOME}/captures/latest.png`]: { bytes: PNG, version: 'v1' } }, { hold: true })
    const shelf = createDriveImageShelf(() => files.service, 'home-1')
    const a = new AbortController()
    const b = new AbortController()
    const first = shelf.read(`${HOME}/captures/latest.png`, a.signal)
    const second = shelf.read(`${HOME}/captures/latest.png`, b.signal)
    a.abort()
    expect(await first).toBeNull()
    files.release()
    expect((await second)?.type).toBe('image/png')
    expect(files.calls.filter(call => call.startsWith('stat'))).toHaveLength(1)
    // Both gone before the stat answers: nothing is read after it.
    const lone = filesOver({ [`${HOME}/captures/latest.png`]: { bytes: PNG, version: 'v1' } }, { hold: true })
    const quiet = createDriveImageShelf(() => lone.service, 'home-1')
    const c = new AbortController()
    const pending = quiet.read(`${HOME}/captures/latest.png`, c.signal)
    c.abort()
    lone.release()
    expect(await pending).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lone.calls).toEqual([`stat ${HOME}/captures/latest.png`])
    expect(await quiet.read(`${HOME}/captures/latest.png`, AbortSignal.abort())).toBeNull()
  })

  it('I5 no file-route URL for a path the drive claims, streaming or with ? or #; Private is never read, in any state', async () => {
    const files = filesOver({
      [`${HOME}/captures/latest.png`]: { bytes: PNG, version: 'v1' },
      [`${HOME}/private/photo.png`]: { bytes: PNG, version: 'v1' },
    })
    const shelf = createDriveImageShelf(() => files.service, 'home-1')
    const text = [
      `![cap](<${HOME}/captures/latest.png>)`, `![capq](<${HOME}/captures/latest.png?v=3>)`, `![caph](<${HOME}/captures/latest.png#x>)`,
      `![priv](<${HOME}/private/photo.png>)`, `![privq](<${HOME}/private/photo.png?v=3>)`, `![privh](<${HOME}/private/photo.png#x>)`,
      // A file elsewhere keeps the stock file route.
      '![tmp](/tmp/graph.png)',
    ].join('\n\n')
    const view = render(<Thread texts={[text]} shelf={shelf} streaming />)
    expect(fileRoutes(view.container)).toEqual([])
    expect(files.calls).toEqual([])
    view.rerender(<Thread texts={[text]} shelf={shelf} />)
    await waitFor(() => { expect(view.container.querySelectorAll('img[src^="blob:"]')).toHaveLength(3) })
    await waitFor(() => { expect(view.container.querySelectorAll('[data-markdown-image-refused]')).toHaveLength(3) })
    expect([...view.container.querySelectorAll('[data-markdown-image-refused]')].map(node => node.textContent))
      .toEqual(['priv · Open in drive', 'privq · Open in drive', 'privh · Open in drive'])
    expect(files.calls.filter(call => call.includes('/private/'))).toEqual([])
    // The chat's own file-route vocabulary is live here (the unclaimed file got one), and it named none of her files.
    const routes = fileRoutes(view.container)
    expect(routes.length).toBeGreaterThan(0)
    for (const url of routes) expect(decodeURIComponent(url)).toContain('/tmp/graph.png')
  })
})
