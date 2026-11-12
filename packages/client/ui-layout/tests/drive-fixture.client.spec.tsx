// @vitest-environment jsdom
/**
 * The drive fixture page (`apps/web/drive-fixture.html`), mounted headless: it shows the real Media and Documents
 * surface inside the REAL Spatial frame (`AppFrame`, the layout store, `LayoutController`) over the made-up her, keeps
 * every secret-shaped name off the page, its captures are real PNGs, its chat mode opens the drive from each link form
 * the drive owns and the right sidebar (a stand-in) for her other files, shows inline images from one blob: URL, and
 * nothing on it reaches the network. At phone and tablet widths the frame is the compact frame (one lane at full width)
 * by the frame's own query. Every file is made up (`tests/drive-fixture/world.ts`).
 *
 * jsdom does no layout: widths are pinned by what the frame renders for the viewport (its own `matchMedia` query) and by
 * what the stylesheets say, never by measured pixels.
 */
import { inflateSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPACT_QUERY } from '../src/client/spatial/AppFrame.tsx'
import { DriveFixture, FIXTURE_MESSAGE, refuseNetwork, type RefusedAttempt } from './drive-fixture/fixture.tsx'
import { capturePng, fixtureWorld, HOME, SECRET_PATHS } from './drive-fixture/world.ts'
import { fakeLane } from './drive-fixture/lane.ts'

let refused: readonly RefusedAttempt[] = []
let made: Blob[] = []
beforeEach(() => {
  made = []
  URL.createObjectURL = vi.fn((blob: Blob) => { made.push(blob); return `blob:http://localhost/${String(made.length)}` })
  URL.revokeObjectURL = vi.fn()
  // The page's own guard, as `prepareFixture` installs it: every network attempt is refused and listed.
  refused = refuseNetwork()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** The viewport the frame's own query sees: at 1023px and below it is the compact frame. */
function viewport(width: number): void {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query === COMPACT_QUERY ? width <= 1023 : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function mount(chat: boolean, width = 1440) {
  viewport(width)
  const world = fixtureWorld({ latencyMs: 0, now: new Date(2026, 10, 12, 18, 0).getTime() })
  vi.stubGlobal('__AUKORA_SUPERAGENT__', world.bridge)
  const view = render(<DriveFixture chat={chat} world={world} />)
  const frame = view.container.querySelector<HTMLElement>('[data-drive-fixture] > div') as HTMLElement
  const lanesInFront = (): string[] => [...frame.querySelectorAll(':scope > [data-lane]')]
    .filter(lane => lane.hasAttribute('data-pane-active')).map(lane => lane.getAttribute('data-lane') ?? '')
  return { world, view, frame, lanesInFront }
}
const listed = async (container: HTMLElement): Promise<void> => {
  await waitFor(() => { expect(container.querySelector('[data-drive-list][data-state="ready"]')).not.toBeNull() })
}
const secretsAbsent = (container: HTMLElement): void => {
  const page = container.innerHTML
  for (const path of SECRET_PATHS) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    expect(page.includes(path), path).toBe(false)
    expect([...container.querySelectorAll('.ak-row__title')].map(node => node.textContent), name).not.toContain(name)
  }
}
const read = (file: string): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${file}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${file}`)
  return readFileSync(path, 'utf8')
}

describe('the drive fixture page', () => {
  it('F1 the captures are real PNGs of different sizes', () => {
    const sizes = new Set<string>()
    for (const [width, height] of [[960, 540], [480, 300], [300, 400]] as const) {
      const png = capturePng(width, height, 1)
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const view = new DataView(png.buffer, png.byteOffset)
      expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([width, height])
      const idat = view.getUint32(33)
      expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT')
      expect(inflateSync(png.subarray(41, 41 + idat)).byteLength).toBe((width * 3 + 1) * height)
      sizes.add(String(png.byteLength))
    }
    expect(sizes.size).toBe(3)
  })

  it('F2 drive mode: her drive in the centre lane, made-up files listed newest first, no secret-shaped name anywhere', async () => {
    const { view } = mount(false)
    const { container } = view
    await listed(container)
    expect(container.querySelector('[data-drive-fixture="drive"] [data-lane="center"][data-pane-active] [data-slot="shell.surface"], [data-drive-fixture="drive"] [data-lane="center"][data-pane-active] [data-media-studio]')).not.toBeNull()
    const rows = (): string[] => [...container.querySelectorAll('[data-drive-list] .ak-row__title')].map(node => node.textContent ?? '')
    expect(rows()).toHaveLength(7)
    expect(rows()[0]).toMatch(/^20261112T\d{6}Z-a{12}\.png$/u)
    secretsAbsent(container)
    fireEvent.click(container.querySelector('[data-drive-place="documents"]') as HTMLElement)
    expect(rows()).toEqual(['PENTORA.v0.md', 'notes.txt', 'data.json', 'readme.txt', 'logo.svg', 'unknown.bin', 'big-log.txt'])
    secretsAbsent(container)
    // The 3 MiB text is over the preview cap: Download only, zero reads.
    fireEvent.click(container.querySelector(`[data-drive-open="${HOME}/docs/big-log.txt"]`) as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-drive-body]')?.textContent).toContain('Too large to preview here (3.0 MB)') })
    // Private: one closed row; two made-up files after Open folder; its secret-shaped file never shows.
    fireEvent.click(container.querySelector('[data-drive-place="private"]') as HTMLElement)
    fireEvent.click(container.querySelector(`[data-drive-open-folder="${HOME}/private"]`) as HTMLElement)
    await waitFor(() => { expect(rows()).toEqual(['diary.md', 'photo.png']) })
    secretsAbsent(container)
  })

  it('F3 chat mode: each link form the drive owns opens the drive; her other files open in the sidebar; one blob: for both images', async () => {
    const { view, world, lanesInFront } = mount(true)
    const { container } = view
    const chat = container.querySelector('[data-fixture-chat]') as HTMLElement
    expect(chat.closest('[data-lane]')?.getAttribute('data-lane')).toBe('left')
    expect(container.querySelector('[data-surface-empty]')?.hasAttribute('hidden')).toBe(false)
    await waitFor(() => { expect(chat.querySelectorAll('img[src^="blob:"]')).toHaveLength(2) })
    // Her last screenshot twice (once with a query): one read, one Blob, one blob: URL.
    expect([...chat.querySelectorAll('img')].map(image => [image.getAttribute('alt'), image.getAttribute('src')]))
      .toEqual([['her last screenshot', 'blob:http://localhost/1'], ['her last screenshot again', 'blob:http://localhost/1']])
    expect(world.calls.filter(call => call.path === `${HOME}/captures/latest.png`).map(call => call.channel)).toEqual(['stat', 'read'])
    expect(within(chat).getAllByRole('button', { name: 'Open in drive' })).toHaveLength(2)
    expect(world.calls.filter(call => call.path.endsWith('logo.svg') || call.path.startsWith(`${HOME}/private/`))).toEqual([])

    const previewText = (): string => container.querySelector('[data-drive-body]')?.textContent ?? ''
    fireEvent.click(within(chat).getByRole('button', { name: 'PENTORA' }))
    await waitFor(() => { expect(container.querySelector('[data-drive-body] h1')?.textContent).toBe('Pentora (made up)') })
    expect(container.querySelector('[data-surface-empty]')?.hasAttribute('hidden')).toBe(true)
    expect(lanesInFront()).toContain('center')
    fireEvent.click(within(chat).getByRole('button', { name: `${HOME}/docs/pentora/notes.txt` }))
    await waitFor(() => { expect(container.querySelector('[data-drive-body] pre')?.textContent).toBe('Made-up notes.\nLine two.\nLine three.\n') })
    fireEvent.click(within(chat).getByRole('button', { name: 'credentials' }))
    await waitFor(() => { expect(previewText()).toBe('This file is kept out of the drive.') })
    // Her own working files outside the drive's places open where they always did: the right sidebar (its stand-in).
    const sidebar = (): HTMLElement | null => container.querySelector('[data-lane="right"] [data-fixture-sidebar]')
    fireEvent.click(within(chat).getByRole('button', { name: 'seed plan' }))
    await waitFor(() => { expect(sidebar()?.textContent).toContain(`${HOME}/seed/plan.md`) })
    expect(previewText()).toBe('This file is kept out of the drive.')
    expect(container.textContent).not.toContain('This file is not in Captures, Documents or Private')
    fireEvent.click(within(chat).getByRole('button', { name: 'HANDOFF.md' }))
    await waitFor(() => { expect(sidebar()?.textContent).toContain(`${HOME}/HANDOFF.md`) })
    fireEvent.click(sidebar()?.querySelector('[data-fixture-sidebar-close]') as HTMLElement)
    expect(sidebar()).toBeNull()
    fireEvent.click(within(chat).getAllByRole('button', { name: 'Open in drive' })[0] as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-drive-body] pre')?.textContent).toContain('<svg') })
    expect(document.getElementById('evil')).toBeNull()
    fireEvent.click(within(chat).getAllByRole('button', { name: 'Open in drive' })[1] as HTMLElement)
    await waitFor(() => { expect(previewText()).toContain('This file is in Private.') })
    // Her message names the kept-out file (she wrote it); the drive never shows it.
    secretsAbsent(container.querySelector('[data-lane="center"]') as HTMLElement)
    expect(FIXTURE_MESSAGE).toContain(`[PENTORA](<${HOME}/docs/PENTORA.v0.md>)`)
  })

  it('F4 nothing on the page reaches the network: the drive and the chat attempt nothing; the frame\'s own HEAD reads are refused', async () => {
    const { view } = mount(true)
    await waitFor(() => { expect(view.container.querySelector('img[alt="her last screenshot"]')).not.toBeNull() })
    for (const button of view.container.querySelectorAll('[data-fixture-chat] button')) fireEvent.click(button)
    await listed(view.container)
    for (const anchor of view.container.querySelectorAll('a[href]')) {
      expect(new URL(anchor.getAttribute('href')!, document.baseURI).origin).not.toBe(window.location.origin)
    }
    // Every attempt was refused by the page; each is the Spatial frame's own read of HEAD (its fingerprint card and live
    // socket, which the real app has too), never a write, never a file of hers, never the file route.
    for (const attempt of refused) {
      expect(attempt.method, attempt.url).toBe('GET')
      expect(['fetch', 'socket']).toContain(attempt.kind)
      expect(new URL(attempt.url, 'http://localhost/').pathname, attempt.url).toMatch(/^\/_head\//u)
      expect(decodeURIComponent(attempt.url)).not.toMatch(/\/dsh\/home|api\/file/u)
    }
    // The guard is the page's real fetch: a probe is refused and listed.
    await expect(globalThis.fetch('/probe')).rejects.toThrow('drive fixture: no network')
    expect(refused.at(-1)).toEqual({ kind: 'fetch', url: '/probe', method: 'GET' })
  })

  it('F5 the fixture is not an input of the production build', () => {
    const file = ['apps/web/vite.config.ts', '../../../apps/web/vite.config.ts'].map(name => resolve(process.cwd(), name)).find(existsSync)
    const config = readFileSync(file ?? '', 'utf8')
    const input = /input:\s*\{([^}]*)\}/u.exec(config)?.[1] ?? ''
    expect(input).toContain("src('./index.html')")
    expect(input).toContain("src('./src/preview.ts')")
    expect(input).not.toContain('drive-fixture')
    expect(config).not.toContain('drive-fixture')
  })

  it('F6 a phone (375 and 320 px): the real frame is the compact frame, the drive is the one lane at full width', async () => {
    for (const width of [375, 320]) {
      const { view, frame, lanesInFront } = mount(false, width)
      await listed(view.container)
      // The frame's own query decided it: compact, the centre in front, none of the desktop's thirds.
      expect(frame.getAttribute('data-compact-lane'), String(width)).toBe('center')
      expect(frame.hasAttribute('data-pane-preset')).toBe(false)
      expect(frame.hasAttribute('data-single-measure')).toBe(false)
      expect(lanesInFront()).toEqual(['center'])
      const lane = frame.querySelector('[data-lane="center"]') as HTMLElement
      expect(lane.querySelector('[data-media-drive]')).not.toBeNull()
      for (const other of ['left', 'right']) expect(frame.querySelector(`[data-lane="${other}"]`)?.getAttribute('aria-hidden')).toBe('true')
      // jsdom draws nothing, so this only proves no script set a width; the geometry is the stylesheets' (below, and D24).
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
      // Every file row: the whole name, its size and time, one Open.
      for (const row of lane.querySelectorAll('[data-drive-list] .ak-row')) {
        expect(row.querySelector('[data-drive-name]')?.textContent).toMatch(/\.[a-z]+$/u)
        expect(row.querySelector('.ak-row__summary time')).not.toBeNull()
        expect(row.querySelectorAll('button')).toHaveLength(1)
        // The kind chip is in the box the compact frame hides (Drive.module.css, D24), under the frame's own attribute.
        expect(row.querySelector('[data-drive-kind]')?.closest('[data-compact-lane]')).toBe(frame)
      }
      cleanup()
    }
    // The compact frame's rules, as the stylesheet states them: one full-width column, each lane's shell at 100%.
    const sheet = read('packages/client/ui-layout/src/client/spatial/SpatialFrame.module.css')
    const compact = sheet.slice(sheet.indexOf(`@media ${COMPACT_QUERY} {`))
    expect(compact).toMatch(/\.frame\[data-compact-lane\] \{[^}]*grid-template-columns: minmax\(0, 1fr\);/u)
    expect(compact).toMatch(/\.frame\[data-compact-lane\] \.laneShell,[^{]*\{[^}]*width: 100%;[^}]*max-width: 100%;/u)
  })

  it('F7 a phone in chat mode: her chat is the lane in front; a link brings the drive to the front; a tablet is compact too, a desktop is not', async () => {
    const phone = mount(true, 375)
    expect(phone.lanesInFront()).toEqual(['left'])
    const chat = phone.view.container.querySelector('[data-fixture-chat]') as HTMLElement
    fireEvent.click(within(chat).getByRole('button', { name: 'PENTORA' }))
    await waitFor(() => { expect(phone.lanesInFront()).toEqual(['center']) })
    await waitFor(() => { expect(phone.view.container.querySelector('[data-drive-body] h1')?.textContent).toBe('Pentora (made up)') })
    cleanup()

    const tablet = mount(false, 768)
    expect(tablet.frame.getAttribute('data-compact-lane')).toBe('center')
    expect(tablet.lanesInFront()).toEqual(['center'])
    cleanup()

    const desktop = mount(false, 1440)
    expect(desktop.frame.hasAttribute('data-compact-lane')).toBe(false)
    expect(desktop.frame.getAttribute('data-pane-preset')).toBe('balanced')
    expect(desktop.lanesInFront()).toEqual(['left', 'center', 'right'])
  })

  it('F8 every way a file is opened shows its preview card at the top of the drive\'s own lane: chat link, Open in drive, a row\'s Open', async () => {
    // jsdom does no layout: the rects are made up (drive-fixture/lane.ts), so this pins which element scrolls, by how much
    // for those rects, and that the page never moves; pixels on a real screen are not provable here.
    const lane = fakeLane((node) => {
      if (node.matches('.ak-app')) return { top: 60, height: 800 }
      if (node.matches('[data-drive-preview-card]')) return { top: 1260 }
      return undefined
    }, { scrollTop: 0, clientHeight: 800 })
    // Her composer (a stand-in): the keyboard is there when she clicks in Auma's message.
    const composer = document.createElement('textarea')
    document.body.append(composer)
    try {
      const { view } = mount(true)
      const { container } = view
      const chat = container.querySelector('[data-fixture-chat]') as HTMLElement
      const heading = (): HTMLElement | null => container.querySelector('[data-drive-preview-heading]')
      const announced = (): string | null | undefined => container.querySelector('[data-drive-announce]')?.textContent
      const shown = { lane: true, top: 1200, behavior: 'smooth' }
      // 1. A chat link: the drive opens in the centre, reads its list, then shows the card; the composer keeps the focus.
      composer.focus()
      fireEvent.click(within(chat).getByRole('button', { name: 'PENTORA' }))
      await listed(container)
      await waitFor(() => { expect(lane.scrolls).toEqual([shown]) })
      expect(document.activeElement).toBe(composer)
      expect(announced()).toBe('Showing PENTORA.v0.md in the drive.')
      // 2. "Open in drive" beside an image the chat does not show: a chat action too, so no focus move.
      fireEvent.click(within(chat).getAllByRole('button', { name: 'Open in drive' })[0] as HTMLElement)
      await waitFor(() => { expect(lane.scrolls).toEqual([shown, shown]) })
      expect(document.activeElement).toBe(composer)
      // Every other said line carries one trailing no-break space, so the same words twice still change the region.
      expect((announced() ?? '').replace(/\u00a0$/, '')).toBe('Showing logo.svg in the drive.')
      // 3. A row's Open, in the drive itself: the preview heading takes the focus.
      fireEvent.click(container.querySelector('[data-drive-place="captures"]') as HTMLElement)
      fireEvent.click(container.querySelector(`[data-drive-open="${HOME}/captures/latest.png"]`) as HTMLElement)
      await waitFor(() => { expect(lane.scrolls).toEqual([shown, shown, shown]) })
      expect(document.activeElement).toBe(heading())
      expect(lane.page).not.toHaveBeenCalled()
      expect(lane.intoView).not.toHaveBeenCalled()
    } finally {
      composer.remove()
      lane.restore()
    }
  })
})
