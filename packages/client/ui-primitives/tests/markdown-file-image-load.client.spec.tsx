// @vitest-environment jsdom
/**
 * AUKORA: an owner that reads its own local images (`fileImages.load`). A claimed path never
 * becomes a URL: its bytes show from a `blob:` URL typed as a raster image, revoked (and the read aborted) on unmount;
 * a refused read, or any other Blob type, leaves the alt text and the owner's open control. Unclaimed paths keep the
 * file-route behaviour exactly.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider, type MarkdownFileImageLoader } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'

const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }
const labels = { dragFailed: 'Image drag failed', open: 'View full image', dialog: 'Image preview', close: 'Close preview', loading: 'Loading image', failed: 'Image unavailable' }
const HOME = '/dsh/home/auma/'

let made: Blob[] = []
let revoke = vi.fn<(url: string) => void>()
beforeEach(() => {
  made = []
  revoke = vi.fn<(url: string) => void>()
  URL.createObjectURL = vi.fn((blob: Blob) => { made.push(blob); return `blob:http://localhost/${String(made.length)}` })
  URL.revokeObjectURL = revoke
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** `null` leaves the opener or the label out. */
function mount(text: string, read: MarkdownFileImageLoader['read'], openFile: (() => void) | null = vi.fn(), openLabel: string | null = 'Open in drive') {
  const resolve = vi.fn((path: string) => `https://example.com/api/file?path=${encodeURIComponent(path)}`)
  const load: MarkdownFileImageLoader = { claims: path => path.startsWith(HOME), read, ...(openLabel === null ? {} : { openLabel }) }
  const view = render(
    <MarkdownDelegateProvider openFile={openFile ?? undefined} fileImages={{ fileDrag, resolve, labels, load }}>
      <MarkdownText text={text} pathImages={{ resolve: value => `https://example.com/api/file?path=${encodeURIComponent(value)}` }} />
    </MarkdownDelegateProvider>,
  )
  return { ...view, resolve, openFile }
}

it('L1 shows a claimed image from a blob: URL of its exact bytes; nothing builds a file-route URL for it', async () => {
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
  const read = vi.fn(async (_path: string) => png)
  const { container, resolve } = mount(
    `![latest](<${HOME}captures/latest.png>) and [link](${HOME}captures/latest.png) and ![other](/tmp/graph.png)`, read,
  )
  // While it loads: the alt text, no image.
  expect(container.querySelector('[data-markdown-image-loading]')?.textContent).toBe('latest')
  await waitFor(() => { expect(container.querySelector('img[alt="latest"]')).not.toBeNull() })
  expect(container.querySelector('img[alt="latest"]')?.getAttribute('src')).toBe('blob:http://localhost/1')
  expect(made).toEqual([png])
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls[0]?.[0]).toBe(`${HOME}captures/latest.png`)
  // The claimed path never reached the URL resolver, as an image or as a link's hover preview; the unclaimed one did.
  expect(resolve.mock.calls.map(call => call[0])).toEqual(['/tmp/graph.png'])
  for (const node of container.querySelectorAll('[src],[href]')) {
    const url = node.getAttribute('src') ?? node.getAttribute('href') ?? ''
    if (url.includes('api/file')) expect(url).toContain(encodeURIComponent('/tmp/graph.png'))
  }
})

it('L2 a refused read, a failed read or a non-raster Blob leaves the alt text and an open control, never an image', async () => {
  const svg = new Blob(['<svg id="evil"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' })
  const html = new Blob(['<script>alert(1)</script>'], { type: 'text/html' })
  const answers: Record<string, () => Promise<Blob | null>> = {
    [`${HOME}docs/a.png`]: async () => null,
    [`${HOME}docs/b.png`]: async () => { throw new Error('gone') },
    [`${HOME}docs/c.png`]: async () => svg,
    [`${HOME}docs/d.png`]: async () => html,
  }
  const read = vi.fn((path: string) => (answers[path] ?? (async () => null))())
  const openFile = vi.fn()
  const { container } = mount(Object.keys(answers).map((path, index) => `![alt ${String(index)}](${path})`).join(' '), read, openFile)
  await waitFor(() => { expect(container.querySelectorAll('[data-markdown-image-refused]')).toHaveLength(4) })
  expect(container.querySelector('img')).toBeNull()
  expect(made).toEqual([])
  expect(document.getElementById('evil')).toBeNull()
  const refused = [...container.querySelectorAll('[data-markdown-image-refused]')]
  expect(refused.map(node => node.textContent)).toEqual(['alt 0 · Open in drive', 'alt 1 · Open in drive', 'alt 2 · Open in drive', 'alt 3 · Open in drive'])
  const control = refused[2]?.querySelector('button') as HTMLButtonElement
  expect(control.type).toBe('button')
  expect(control.getAttribute('href')).toBeNull()
  fireEvent.click(control)
  expect(openFile).toHaveBeenCalledWith(`${HOME}docs/c.png`)
})

it('L3 unmounting aborts a read in flight, and revokes a shown image\'s blob: URL', async () => {
  let pending: { signal: AbortSignal; resolve: (blob: Blob | null) => void } | null = null
  const slow = vi.fn((_path: string, signal: AbortSignal) => new Promise<Blob | null>((resolve) => { pending = { signal, resolve } }))
  const first = mount(`![slow](${HOME}captures/latest.png)`, slow)
  await waitFor(() => { expect(pending).not.toBeNull() })
  first.unmount()
  expect(pending!.signal.aborted).toBe(true)
  await act(async () => { pending!.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' })) })
  expect(made).toEqual([])

  const shown = mount(`![shown](${HOME}captures/latest.png)`, vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/gif' })))
  await waitFor(() => { expect(shown.container.querySelector('img')).not.toBeNull() })
  expect(revoke).not.toHaveBeenCalled()
  shown.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:http://localhost/1')
})

it('L4 an image inside a link has no lightbox of its own; an empty alt shows the path; no label or no opener means no control', async () => {
  const png = new Blob([new Uint8Array([1])], { type: 'image/webp' })
  const linked = mount(`[![shot](${HOME}captures/latest.png)](https://example.com/a)`, vi.fn(async () => png))
  await waitFor(() => { expect(linked.container.querySelector('img')).not.toBeNull() })
  expect(linked.container.querySelector('img')?.closest('a')?.getAttribute('href')).toBe('https://example.com/a')
  expect(linked.container.querySelector('button')).toBeNull()
  linked.unmount()

  const refuse = vi.fn(async () => null)
  const empty = mount(`![](${HOME}docs/a.png)`, refuse)
  await waitFor(() => { expect(empty.container.querySelector('[data-markdown-image-refused]')?.textContent).toBe(`${HOME}docs/a.png · Open in drive`) })
  empty.unmount()
  const unlabelled = mount(`![quiet](${HOME}docs/a.png)`, refuse, vi.fn(), null)
  await waitFor(() => { expect(unlabelled.container.querySelector('[data-markdown-image-refused]')?.textContent).toBe('quiet') })
  expect(unlabelled.container.querySelector('button')).toBeNull()
  unlabelled.unmount()
  const noOpener = mount(`![quiet](${HOME}docs/a.png)`, refuse, null)
  await waitFor(() => { expect(noOpener.container.querySelector('[data-markdown-image-refused]')?.textContent).toBe('quiet') })
  noOpener.unmount()
})

it('L5 a read that fails after the image unmounted changes nothing', async () => {
  let fail: ((error: Error) => void) | null = null
  const read = vi.fn((_path: string, _signal: AbortSignal) => new Promise<Blob | null>((_resolve, reject) => { fail = reject }))
  const view = mount(`![late](${HOME}captures/latest.png)`, read)
  await waitFor(() => { expect(fail).not.toBeNull() })
  view.unmount()
  await act(async () => { fail!(new Error('late')) })
  expect(made).toEqual([])
})

// ── Job 3 (reviewer SHOULD 2 and 3) ────────────────────────────────────────────────────────────────────────────────────

/** A render with a spied path vocabulary (the chat's /api/file rewriter), streaming or settled. */
function mountWith(text: string, read: MarkdownFileImageLoader['read'], streaming: boolean) {
  const vocabulary = vi.fn((value: string) => `https://example.com/api/file?path=${encodeURIComponent(value)}`)
  const resolve = vi.fn((path: string) => `https://example.com/api/file?path=${encodeURIComponent(path)}`)
  const load: MarkdownFileImageLoader = { claims: path => path.startsWith(HOME), read, openLabel: 'Open in drive' }
  const tree = (body: string, live: boolean) => (
    <MarkdownDelegateProvider openFile={vi.fn()} fileImages={{ fileDrag, resolve, labels, load }}>
      <MarkdownText text={body} streaming={live} pathImages={{ resolve: vocabulary }} />
    </MarkdownDelegateProvider>
  )
  const view = render(tree(text, streaming))
  return { ...view, vocabulary, resolve, settle: () => { view.rerender(tree(text, false)) } }
}
const fileRoutes = (container: HTMLElement): string[] => [...container.querySelectorAll('[src],[href]')]
  .map(node => node.getAttribute('src') ?? node.getAttribute('href') ?? '').filter(url => url.includes('api/file'))

it('L6 a claimed path with a ? or # suffix is still the owner\'s: read by its plain path, never a file-route URL', async () => {
  const png = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' })
  const read = vi.fn(async (_path: string) => png)
  const { container, vocabulary, resolve } = mountWith([
    `![q](<${HOME}captures/latest.png?v=2>)`, `![h](<${HOME}captures/latest.png#top>)`,
    `![pq](<${HOME}private/photo.png?x=1>)`, `![enc](${HOME}captures/my%20shot.png?t=9)`,
  ].join(' '), read, false)
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(4) })
  expect(read.mock.calls.map(call => call[0])).toEqual([
    `${HOME}captures/latest.png`, `${HOME}captures/latest.png`, `${HOME}private/photo.png`, `${HOME}captures/my shot.png`,
  ])
  expect(vocabulary).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
  expect(fileRoutes(container)).toEqual([])
})

it('L7 while the message streams a claimed image is its alt text: nothing is read and no URL is built, in any form', async () => {
  const read = vi.fn(async (_path: string) => new Blob([new Uint8Array([1])], { type: 'image/png' }))
  const text = [
    `![cap](<${HOME}captures/latest.png>)`, `![capq](<${HOME}captures/latest.png?v=1>)`,
    `![priv](${HOME}private/photo.png)`, `![privh](<${HOME}private/photo.png#a>)`,
  ].join(' ')
  const view = mountWith(text, read, true)
  expect([...view.container.querySelectorAll('[data-markdown-image-loading]')].map(node => node.textContent))
    .toEqual(['cap', 'capq', 'priv', 'privh'])
  expect(view.container.querySelector('img')).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(view.vocabulary).not.toHaveBeenCalled()
  expect(view.resolve).not.toHaveBeenCalled()
  expect(fileRoutes(view.container)).toEqual([])
  // Settled, each is read by the owner (whose rule decides; a Private file is the owner's to refuse) and never a URL.
  view.settle()
  await waitFor(() => { expect(view.container.querySelectorAll('img')).toHaveLength(4) })
  expect(view.vocabulary).not.toHaveBeenCalled()
  expect(fileRoutes(view.container)).toEqual([])
})

it('L8 a claimed image is read only when it nears the viewport', async () => {
  const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[]; live: boolean }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    readonly record: (typeof observers)[number]
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, ...(options === undefined ? {} : { options }), targets: [], live: true }
      observers.push(this.record)
    }
    observe(target: Element) { this.record.targets.push(target) }
    disconnect() { this.record.live = false }
    unobserve() {}
    takeRecords() { return [] }
  })
  const read = vi.fn(async (_path: string) => new Blob([new Uint8Array([1])], { type: 'image/png' }))
  const { container } = mountWith(`![far](${HOME}captures/latest.png)`, read, false)
  expect(observers).toHaveLength(1)
  expect(observers[0]?.options?.rootMargin).toBe('400px 0px')
  expect(observers[0]?.targets[0]?.textContent).toBe('far')
  await act(async () => { await Promise.resolve() })
  expect(read).not.toHaveBeenCalled()
  // Not yet in view: still nothing.
  act(() => { observers[0]!.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver) })
  expect(read).not.toHaveBeenCalled()
  act(() => { observers[0]!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
  await waitFor(() => { expect(container.querySelector('img')).not.toBeNull() })
  expect(read).toHaveBeenCalledTimes(1)
  expect(observers[0]?.live).toBe(false)
  vi.unstubAllGlobals()
})

it('L9 one blob: URL per Blob, shared by every image showing it, revoked when the last one unmounts', async () => {
  const png = new Blob([new Uint8Array([0x89])], { type: 'image/png' })
  const read = vi.fn(async (_path: string) => png)
  const one = mountWith(`![a](${HOME}captures/latest.png)`, read, false)
  const two = mountWith(`![b](${HOME}captures/latest.png) ![c](${HOME}captures/latest.png)`, read, false)
  await waitFor(() => { expect(one.container.querySelectorAll('img').length + two.container.querySelectorAll('img').length).toBe(3) })
  expect(made).toEqual([png])
  const sources = [...document.querySelectorAll('img')].map(image => image.getAttribute('src'))
  expect(new Set(sources)).toEqual(new Set(['blob:http://localhost/1']))
  one.unmount()
  expect(revoke).not.toHaveBeenCalled()
  two.unmount()
  expect(revoke.mock.calls).toEqual([['blob:http://localhost/1']])
})

/** An IntersectionObserver that only records: its callback runs when a test calls it, never by itself. */
function recordingObserver() {
  const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[]; live: boolean }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    readonly record: (typeof observers)[number]
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, ...(options === undefined ? {} : { options }), targets: [], live: true }
      observers.push(this.record)
    }
    observe(target: Element) { this.record.targets.push(target) }
    disconnect() { this.record.live = false }
    unobserve() {}
    takeRecords() { return [] }
  })
  return observers
}
/** jsdom does no layout: the placeholder's rect is made up (a real box at `top`), so this proves the rule, not pixels. */
function placeholderAt(top: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.hasAttribute('data-markdown-image-loading')) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
    return { x: 0, y: top, top, left: 0, right: 200, bottom: top + 20, width: 200, height: 20, toJSON: () => ({}) }
  })
}

it('L10 a claimed image already in or near view on mount is read at once, with no observer report', async () => {
  for (const top of [100, window.innerHeight + 350, -380]) {
    const observers = recordingObserver()
    placeholderAt(top)
    const read = vi.fn(async (_path: string) => new Blob([new Uint8Array([1])], { type: 'image/png' }))
    const { container, unmount } = mountWith(`![near](${HOME}captures/latest.png)`, read, false)
    await waitFor(() => { expect(container.querySelector('img'), String(top)).not.toBeNull() })
    expect(read).toHaveBeenCalledTimes(1)
    // No observer was needed, so no observer report was waited for.
    expect(observers).toHaveLength(0)
    unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('L11 a claimed image out of view on mount waits for the observer; its placeholder is a real box', async () => {
  const observers = recordingObserver()
  placeholderAt(window.innerHeight + 401)
  const read = vi.fn(async (_path: string) => new Blob([new Uint8Array([1])], { type: 'image/png' }))
  const { container } = mountWith(`![far](${HOME}captures/latest.png)`, read, false)
  await act(async () => { await Promise.resolve() })
  expect(read).not.toHaveBeenCalled()
  expect(observers).toHaveLength(1)
  expect(observers[0]?.targets[0]?.getAttribute('data-markdown-image-loading')).toBe('')
  act(() => { observers[0]!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
  await waitFor(() => { expect(container.querySelector('img')).not.toBeNull() })
  expect(read).toHaveBeenCalledTimes(1)
  // The placeholder's box, as the stylesheet states it: a block in the line, never a zero-size inline.
  const sheet = readFileSync(resolvePath(dirname(fileURLToPath(import.meta.url)), '../src/markdown/MarkdownText.module.css'), 'utf8')
  const pending = /\.imagePending \{([^}]*)\}/u.exec(sheet)?.[1] ?? ''
  expect(pending).toContain('display: inline-block;')
  expect(pending).toContain('min-height: 1.25em;')
  expect(pending).toContain('min-width: 1em;')
  vi.unstubAllGlobals()
})
