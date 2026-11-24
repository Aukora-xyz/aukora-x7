// @vitest-environment jsdom
/**
 * THE SPATIAL DESIGN CONTRACT (Spatial design spec 4-6): one header order, one portal head
 * geometry for every launcher and disclosure (centre and menu alike), large text that grows a head instead of clipping
 * it, and one meaning per interaction. The last block drives the migrated slice end to end on the real components:
 * System menu -> Aura Coherence -> its "How it works" disclosure -> back through the same launcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  AppHeader, FALLBACK_ICON, PortalButton, PortalFold, PortalLauncher, RecordList, RecordRow,
} from '../src/client/spatial/primitives/index.ts'
import { SettingsMenu, SystemMenu } from '../src/client/spatial/portal/menus.tsx'
import { AuraPentoraSurface } from '../src/client/spatial/aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE } from '../src/client/spatial/aura/model.ts'
import { SurfaceFrame } from '../src/client/spatial/x5/common.tsx'
import { WorkMenu } from '../src/client/spatial/work/WorkMenu.tsx'
import { WORK_SURFACE } from '../src/client/spatial/work/WorkSurface.tsx'

const SPATIAL = 'packages/client/ui-layout/src/client/spatial/'
const readSpatial = (file: string): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${SPATIAL}${file}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${file}`)
  return readFileSync(path, 'utf8')
}
const read = (file: string): string => readSpatial(`primitives/${file}`)
const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '')
const SHEET = read('primitives.css')
const SKIN = read('skin-face.css')
const RULES = uncomment(SHEET)

/** The declarations of the one `:root` block, by name. */
const ROOT = ((): Map<string, string> => {
  const blocks = [...RULES.matchAll(/:root\s*\{([^}]*)\}/gu)]
  if (blocks.length !== 1) throw new Error(`primitives.css must have one :root block, has ${String(blocks.length)}`)
  const body = blocks[0]?.[1] ?? ''
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(([, name, value]) => [name ?? '', (value ?? '').trim()]))
})()
/** The declarations of the one rule whose selector list is exactly this. */
const rule = (selector: string): string => {
  const at = RULES.indexOf(`\n${selector} {`)
  if (at === -1) throw new Error(`no rule: ${selector}`)
  return RULES.slice(at + selector.length + 3, RULES.indexOf('}', at))
}
/** A value with every `var(--token)` replaced by the token's `:root` value, as the browser resolves it. */
const resolveVars = (value: string): string => {
  let out = value
  for (let depth = 0; depth < 8 && out.includes('var('); depth++) {
    out = out.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/gu, (_all, name: string, fallback?: string) => ROOT.get(name) ?? fallback ?? '')
  }
  return out
}

/** THE CONTRACT TABLE (spec 5): the values a reviewer reads, in the one place that declares them. */
const CONTRACT = {
  '--ak-portal-header-height': '68px',
  '--ak-portal-gap': '14px',
  '--ak-portal-padding-inline': '16px',
  '--ak-portal-content-gap': '12px',
  '--ak-icon-tile-size': '30px',
  '--ak-icon-glyph-size': '16px',
  '--ak-heading-size': '1.5rem',
  '--ak-reading-size': '1rem',
  '--ak-header-inset': '20px',
} as const

beforeEach(() => {
  // The real stylesheet in the page, so the cascade below is the one a browser applies (jsdom resolves the rules;
  // it does not substitute custom properties, which `resolveVars` does from the same file).
  const style = document.createElement('style')
  style.setAttribute('data-test-primitives', '')
  style.textContent = SHEET
  document.head.append(style)
})
afterEach(() => {
  cleanup()
  for (const style of document.querySelectorAll('style[data-test-primitives]')) style.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The head's geometry as the cascade gives it, tokens resolved. */
const geometry = (head: Element) => {
  const computed = getComputedStyle(head)
  return {
    minHeight: resolveVars(computed.minHeight),
    height: resolveVars(computed.height),
    paddingInline: resolveVars(computed.getPropertyValue('padding-inline')),
    gap: resolveVars(computed.gap || computed.columnGap),
  }
}

describe('the tokens: one owner, the spec values, and read by the components', () => {
  it('primitives.css declares each contract token once, at the spec value', () => {
    for (const [token, value] of Object.entries(CONTRACT)) {
      expect([...RULES.matchAll(new RegExp(`${token}\\s*:`, 'gu'))], token).toHaveLength(1)
      expect(ROOT.get(token), token).toBe(value)
    }
    // Text sizes are rem, so they follow the reader's text size.
    for (const token of ['--ak-portal-title-size', '--ak-portal-summary-size', '--ak-heading-size', '--ak-reading-size']) {
      expect(ROOT.get(token), token).toMatch(/^[\d.]+rem$/u)
    }
    // The old title-only height is gone; the old name of the head height is only an alias of the one token.
    expect(ROOT.has('--ak-portal-h1')).toBe(false)
    expect(ROOT.get('--ak-portal-h2')).toBe('var(--ak-portal-header-height)')
  })
  it('the portal, the tile, the grid and the stock-launcher skin read the tokens instead of numbers of their own', () => {
    expect(rule('.ak-portal__head')).toContain('min-height: var(--ak-portal-header-height);')
    expect(rule('.ak-portal__head')).toContain('gap: var(--ak-portal-content-gap);')
    expect(rule('.ak-portal__head')).toContain('padding-inline: var(--ak-portal-padding-inline);')
    expect(rule('.ak-icon-tile')).toContain('width: var(--ak-icon-tile-size);')
    expect(rule('.ak-icon-tile svg')).toContain('width: var(--ak-icon-glyph-size);')
    expect(rule('.ak-header__title')).toContain('font-size: var(--ak-heading-size);')
    expect(RULES).toMatch(/\.ak-grid \{[^}]*gap: var\(--ak-portal-gap\);/u)
    const skin = uncomment(SKIN)
    for (const token of ['--ak-portal-header-height', '--ak-portal-content-gap', '--ak-portal-padding-inline', '--ak-icon-tile-size',
      '--ak-icon-glyph-size', '--ak-portal-title-size']) expect(skin, token).toContain(`var(${token}`)
    expect(skin).not.toMatch(/font-size:\s*13\.5px/u)
  })
  it('no !important, and no rule that gives a portal head a height of its own', () => {
    for (const css of [RULES, uncomment(SKIN)]) expect(css).not.toContain('!important')
    expect(RULES).not.toContain('ak-portal--one-line')
    // No fixed `height:` on any portal head selector: the head's floor is the only height it has.
    for (const [, selectors, body] of RULES.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
      if ((selectors ?? '').includes('ak-portal__head')) expect(body ?? '', selectors).not.toMatch(/(^|[;\s])height\s*:/u)
    }
  })
})

describe('the app header: title first, then its descriptive line (spec 5)', () => {
  it('the DOM order is the visible order, and no stylesheet reorders it', () => {
    const { container } = render(<AppHeader eyebrow="BACKGROUND MISSIONS" title="Work" tone="mint" />)
    const copy = container.querySelector('.ak-header__copy')
    expect([...(copy?.children ?? [])].map(child => [child.tagName, child.className]))
      .toEqual([['H2', 'ak-header__title'], ['P', 'ak-header__eyebrow']])
    expect(rule('.ak-header__title')).toContain('color: var(--ak-text);')
    expect(rule('.ak-header__title')).toContain('margin: 0;')
    expect(rule('.ak-header__eyebrow')).toContain('margin: 6px 0 0;')
    expect(rule('.ak-header__eyebrow')).toContain('color: var(--ak-tone, var(--ak-violet));')
    expect(RULES).not.toMatch(/\border\s*:/u)
  })
  it('an unused badge area is not drawn, so it holds no space; the hot corner is kept clear', () => {
    const { container } = render(<AppHeader eyebrow="LINE" title="Title" />)
    expect(container.querySelector('.ak-header__badges')).toBeNull()
    expect(rule('.ak-header')).toContain('padding-inline-end: var(--ak-corner-clearance);')
    cleanup()
    const badged = render(<AppHeader eyebrow="LINE" title="Title" badges={[{ text: 'Read-only' }]} />)
    expect(badged.container.querySelector('.ak-header__badges')?.textContent).toBe('Read-only')
  })
})

describe('one portal head: centre and menu, launcher and disclosure, title-only or not (spec 5)', () => {
  it('the computed head geometry is the same for a centre disclosure, a title-only one, a legacy-prop one and a menu launcher', () => {
    const { container } = render(
      <>
        <div data-case="centre"><PortalButton tone="violet" icon="aura" title="How it works" summary="what it means"><p>body</p></PortalButton></div>
        <div data-case="title-only"><PortalButton tone="blue" icon="general" title="Only a title"><p>body</p></PortalButton></div>
        <div data-case="legacy"><PortalButton variant="green" subtitle="an old caller" trailing={<i>t</i>} title="Old props" /></div>
        <div data-case="menu"><SystemMenu {...menuProps(undefined)} /></div>
        <div data-case="settings"><SettingsMenu {...menuProps(undefined)} /></div>
      </>,
    )
    const heads = [...container.querySelectorAll('[data-case]')].map(box => [box.getAttribute('data-case'), box.querySelector('.ak-portal__head')] as const)
    const reference = geometry(heads[0]?.[1] as Element)
    expect(reference.minHeight).toBe('68px')
    expect(reference.gap).toBe('12px')
    expect(reference.paddingInline).toBe('16px')
    expect(reference.height === '' || reference.height === 'auto').toBe(true)
    for (const [name, head] of heads) expect(geometry(head as Element), name ?? '').toEqual(reference)
    // An old prop never selects another form: every one of these frames has the same geometry classes.
    for (const portal of container.querySelectorAll('.ak-portal')) {
      expect(portal.classList.contains('ak-portal--free')).toBe(false)
      expect(portal.classList.contains('ak-portal--one-line')).toBe(false)
    }
  })
  it('a missing icon gets the intentional fallback tile, so titles keep one left edge', () => {
    const { container } = render(
      <>
        <PortalButton title="No icon disclosure"><p>body</p></PortalButton>
        <PortalLauncher title="No icon launcher" current={false} onOpen={() => {}} />
        <PortalButton icon="aura" title="With icon"><p>body</p></PortalButton>
      </>,
    )
    for (const head of container.querySelectorAll('.ak-portal__head')) {
      expect(head.firstElementChild?.classList.contains('ak-icon-tile')).toBe(true)
      expect(head.firstElementChild?.querySelector('svg')).not.toBeNull()
      expect(head.children[1]?.classList.contains('ak-portal__copy')).toBe(true)
    }
    expect(FALLBACK_ICON).toEqual({ launcher: 'app', disclosure: 'general' })
  })
  it('an empty trailing area is not rendered; a badge or the expander keeps it', () => {
    const { container } = render(
      <>
        <div data-case="empty"><PortalButton icon="thread" title="A row" showIndicator={false} /></div>
        <div data-case="badge"><PortalButton icon="thread" title="A row" showIndicator={false} badge={<b>1</b>} /></div>
        <div data-case="expander"><PortalButton icon="thread" title="A row"><p>body</p></PortalButton></div>
      </>,
    )
    const end = (name: string) => container.querySelector(`[data-case="${name}"] .ak-portal__end`)
    expect(end('empty')).toBeNull()
    expect(end('badge')?.textContent).toBe('1')
    expect(end('expander')?.textContent).toBe('+')
  })
  it('larger text grows the head: a floor and rem text, never a fixed height or a fixed text size', () => {
    expect(rule('.ak-portal__title')).toContain('font-size: var(--ak-portal-title-size);')
    expect(rule('.ak-portal__summary')).toContain('font-size: var(--ak-portal-summary-size);')
    // Unitless line-heights scale with the text.
    expect(rule('.ak-portal__title')).toMatch(/line-height: [\d.]+;/u)
    expect(rule('.ak-portal__summary')).toMatch(/line-height: [\d.]+;/u)
    // The stock launchers and thread rows the skin draws as portals take the same floor.
    const skin = uncomment(SKIN)
    expect(skin.match(/min-height: calc\(var\(--ak-portal-header-height\) \+ 2px\);/gu)).toHaveLength(2)
    expect(skin).not.toMatch(/height: calc\(var\(--ak-portal-h2\)/u)
    // At twice the default text size the head's content is taller than the floor, so the floor is what gives way.
    const rem = 32
    const size = (token: string) => Number.parseFloat(ROOT.get(token) ?? '0') * rem
    const lineOf = (selector: string) => Number(/line-height: ([\d.]+);/u.exec(rule(selector))?.[1] ?? 0)
    const content = size('--ak-portal-title-size') * lineOf('.ak-portal__title') + size('--ak-portal-summary-size') * lineOf('.ak-portal__summary')
    expect(content).toBeGreaterThan(Number.parseFloat(CONTRACT['--ak-portal-header-height']))
  })
  it('the skin\'s launcher and thread-row text grows with its line box: rem text never sits in a fixed px line', () => {
    // A rem font-size in a px line box overflows it at large text; with `overflow: hidden` the glyphs are cut.
    const skinRules = [...uncomment(SKIN).matchAll(/([^{}]+)\{([^}]*)\}/gu)].map(([, selectors, body]) => ({
      selectors: (selectors ?? '').trim(), body: body ?? '',
    }))
    const decl = (body: string, prop: string) => new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`, 'u').exec(body)?.[1]?.trim()
    let clipped = 0
    for (const { selectors, body } of skinRules) {
      const fontSize = decl(body, 'font-size')
      const lineHeight = decl(body, 'line-height')
      if (fontSize === undefined) continue
      const resolved = resolveVars(fontSize)
      if (resolved.endsWith('rem')) expect(lineHeight ?? '', selectors).not.toMatch(/px$/u)
      // Text that hides its overflow (the one-line titles and summaries) must scale, size and line together.
      if (/(^|[;\s])overflow\s*:\s*hidden/u.test(body)) {
        clipped++
        expect(resolved, selectors).toMatch(/rem$/u)
        expect(lineHeight ?? '', selectors).toMatch(/^[\d.]+$/u)
      }
    }
    // The stock-launcher title and summary and the thread-row title.
    expect(clipped).toBeGreaterThanOrEqual(3)
  })
  it('a record row stays its own, smaller component, not a launcher', () => {
    const { container } = render(<RecordList><RecordRow tone="blue" title="A record" summary="one line"><p>more</p></RecordRow></RecordList>)
    expect(container.querySelector('.ak-portal')).toBeNull()
    expect(container.querySelector('li.ak-row > button.ak-row__head')).not.toBeNull()
    expect(rule('.ak-row__head')).toContain('min-height: var(--ak-row-h);')
  })
})

describe('one meaning per interaction (spec 6)', () => {
  it('a launcher opens or reveals an application: aria-current, never aria-expanded, and no body', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const { container, rerender } = render(<PortalLauncher title="Media" icon="app" current={false} onOpen={onOpen} onClose={onClose} />)
    const head = () => container.querySelector('button.ak-portal__head') as HTMLButtonElement
    expect(container.querySelector('[data-portal-kind="launcher"]')).not.toBeNull()
    expect(head().hasAttribute('aria-expanded')).toBe(false)
    expect(head().hasAttribute('aria-current')).toBe(false)
    fireEvent.click(head())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    rerender(<PortalLauncher title="Media" icon="app" current onOpen={onOpen} onClose={onClose} />)
    expect(head().getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('.ak-portal__body')).toBeNull()
    fireEvent.click(head())
    expect(onClose).toHaveBeenCalledTimes(1)
    // Without onClose, selecting the app already shown reveals it again; it never empties the centre lane.
    rerender(<PortalLauncher title="Media" icon="app" current onOpen={onOpen} />)
    fireEvent.click(head())
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
  it('a disclosure expands its own body in place and opens nothing else', () => {
    const { container } = render(<PortalButton icon="general" title="Explain" summary="in place"><p data-body="">words</p></PortalButton>)
    const head = container.querySelector('button.ak-portal__head') as HTMLButtonElement
    expect(container.querySelector('[data-portal-kind="disclosure"]')).not.toBeNull()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.hasAttribute('aria-current')).toBe(false)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    const body = container.querySelector('[data-body]')?.closest('.ak-portal__body')
    expect(body?.id).toBe(head.getAttribute('aria-controls'))
  })
  it('a fold is a disclosure too; a head-only fold is a static card whose words wrap', () => {
    const { container } = render(
      <>
        <PortalFold icon="approvals" title="Kept" data-case="fold"><p>body</p></PortalFold>
        <PortalFold icon="approvals" title="Static" data-case="static" />
      </>,
    )
    expect(container.querySelector('[data-case="fold"]')?.getAttribute('data-portal-kind')).toBe('disclosure')
    expect(container.querySelector('[data-case="static"]')?.classList.contains('ak-portal--free')).toBe(true)
    expect(container.querySelector('[data-case="static"] .ak-portal__end')).toBeNull()
  })
})

// ── The migrated slice: menu -> application -> disclosure -> return ──────────────────────────────────────────────

type MenuProps = Parameters<typeof SystemMenu>[0]
function menuProps(activeSurface: string | undefined, openSurface = vi.fn(), closeSurface = vi.fn()): MenuProps {
  const props: Pick<MenuProps, 'activeSurface' | 'openSurface' | 'closeSurface'> = {
    ...(activeSurface === undefined ? {} : { activeSurface }), openSurface, closeSurface,
  }
  return props as MenuProps
}

type AuraProps = Parameters<typeof AuraPentoraSurface>[0]
const auraHooks = (): Pick<AuraProps, 'useSessions' | 'useSessionStatus' | 'reader'> => {
  const list: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  type StatusSnapshot = Parameters<Parameters<AuraProps['useSessionStatus']>[0]>[0]
  return {
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<StatusSnapshot>(new Map())),
    reader: { whole: async () => ({ ok: false, reason: 'not-found' }) },
  }
}

/** The shell's part, reduced to its state: which surface the centre lane shows. Menu and surface share it. */
function Slice({ opened, closed }: { readonly opened: (id: string) => void; readonly closed: () => void }) {
  const [active, setActive] = useState<string | undefined>(undefined)
  const openSurface = (id: string) => { opened(id); setActive(id) }
  const closeSurface = () => { closed(); setActive(undefined) }
  const hooks = auraHooks()
  const surface: Pick<AuraProps, 'activeSurface' | 'closeSurface'> & typeof hooks = {
    ...(active === undefined ? {} : { activeSurface: active }), closeSurface, ...hooks,
  }
  return (
    <>
      <nav data-lane="menu"><SystemMenu {...menuProps(active, vi.fn(openSurface), vi.fn(closeSurface))} /></nav>
      <main data-lane="centre"><AuraPentoraSurface {...(surface as AuraProps)} /></main>
    </>
  )
}

describe('the migrated slice, end to end: System menu -> Aura Coherence -> How it works -> back', () => {
  it('opens the app from its launcher, discloses in place, and returns through the same launcher', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const opened = vi.fn()
    const closed = vi.fn()
    const { container } = render(<Slice opened={opened} closed={closed} />)
    const launcher = () => container.querySelector(`[data-lane="menu"] [data-launcher="${AURA_SURFACE}"]`) as HTMLButtonElement
    const surface = () => container.querySelector('[data-aura-coherence-surface]') as HTMLElement

    // MENU: a launcher, drawn with the one portal head.
    expect(launcher().classList.contains('ak-portal__head')).toBe(true)
    expect(launcher().closest('.ak-portal')?.getAttribute('data-portal-kind')).toBe('launcher')
    expect(launcher().hasAttribute('aria-expanded')).toBe(false)
    expect(surface().hidden).toBe(true)

    // APPLICATION: it opens in the centre lane; the launcher says it is the current one.
    fireEvent.click(launcher())
    expect(opened.mock.calls).toEqual([[AURA_SURFACE]])
    expect(surface().hidden).toBe(false)
    expect(launcher().getAttribute('aria-current')).toBe('page')
    const copy = surface().querySelector('.ak-header__copy')
    expect([...(copy?.children ?? [])].map(child => child.className)).toEqual(['ak-header__title', 'ak-header__eyebrow'])
    expect(copy?.firstElementChild?.textContent).toBe('Aura Coherence')

    // DISCLOSURE: How it works opens in place, inside the app; nothing navigates.
    const how = [...surface().querySelectorAll<HTMLButtonElement>('button.ak-portal__head')]
      .find(head => head.querySelector('.ak-portal__title')?.textContent === 'How it works')
    if (how === undefined) throw new Error('no How it works disclosure')
    expect(how.closest('.ak-portal')?.getAttribute('data-portal-kind')).toBe('disclosure')
    // The centre disclosure and the menu launcher have one head geometry.
    expect(geometry(how)).toEqual(geometry(launcher()))
    fireEvent.click(how)
    expect(how.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(how.getAttribute('aria-controls') ?? '')
    expect(body?.classList.contains('ak-portal__body')).toBe(true)
    expect(surface().contains(body)).toBe(true)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
    expect(surface().hidden).toBe(false)

    // RETURN: the same launcher closes the app, and the lane is as it was.
    fireEvent.click(launcher())
    expect(closed).toHaveBeenCalledTimes(1)
    expect(surface().hidden).toBe(true)
    expect(launcher().hasAttribute('aria-current')).toBe(false)
  })
})

// ── The old overrides on the contract: spatial-layer.css, ThreadsLane.module.css, the Work launcher ───────────────

const LAYER_SHEET = readSpatial('portal/spatial-layer.css')
const LAYER = uncomment(LAYER_SHEET)
const THREADS = uncomment(readSpatial('portal/ThreadsLane.module.css'))
/** Every rule of a stylesheet: its selector list and its declarations. */
const rulesOf = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selectors, body]) => ({
  selectors: (selectors ?? '').trim(), body: body ?? '',
}))
/** The declarations of the one rule whose selector list is exactly this, in a given sheet. */
const ruleIn = (css: string, selector: string): string => {
  const found = rulesOf(css).filter(entry => entry.selectors === selector)
  if (found.length !== 1) throw new Error(`expected one rule ${selector}, found ${String(found.length)}`)
  return found[0]?.body ?? ''
}
/** The order a flex container shows its children in: by `order`, then by DOM position. */
const visibleOrder = (parent: Element) => [...parent.children]
  .map((child, index) => ({ child, index, order: Number(getComputedStyle(child).order || '0') }))
  .sort((a, b) => a.order - b.order || a.index - b.index)
  .map(entry => entry.child.className)

describe('spatial-layer.css: the header order is the markup order, with no order rule (spec 5)', () => {
  const mount = () => {
    const style = document.createElement('style')
    style.setAttribute('data-test-primitives', '')
    style.textContent = LAYER_SHEET
    document.head.append(style)
    return render(
      <div data-slot="shell.surface">
        <SurfaceFrame active eyebrow="LIVING SYSTEM STATE" title="Aura Coherence" badges={[{ text: 'Read-only' }]}><p>body</p></SurfaceFrame>
      </div>,
    )
  }
  it('no rule in spatial-layer.css sets `order`, and the visible order of the header copy equals its DOM order', () => {
    expect(LAYER).not.toMatch(/(^|[;{\s])order\s*:/u)
    const { container } = mount()
    const copy = container.querySelector('.x5-app-header .ak-header__copy')
    if (copy === null) throw new Error('no header copy')
    const dom = [...copy.children].map(child => child.className)
    expect(dom).toEqual(['ak-header__title', 'ak-header__eyebrow'])
    expect(visibleOrder(copy)).toEqual(dom)
    // The rules that used to carry the order keep the rest of what they said.
    expect(ruleIn(LAYER, ".x5-app-header .ak-header__title, [data-slot='shell.surface'] .ak-canvas > .ak-header .ak-header__title"))
      .toBe(' margin: 0; white-space: nowrap; ')
    expect(ruleIn(LAYER, ".x5-app-header .ak-header__eyebrow, [data-slot='shell.surface'] .ak-canvas > .ak-header .ak-header__eyebrow"))
      .toBe(' margin-top: 6px; ')
  })
  it('control: the same check sees a reordering rule, so the pass above is not blind', () => {
    const { container } = mount()
    const control = document.createElement('style')
    control.setAttribute('data-test-primitives', '')
    control.textContent = '.x5-app-header .ak-header__title { order: 1; } .x5-app-header .ak-header__eyebrow { order: 0; }'
    document.head.append(control)
    const copy = container.querySelector('.x5-app-header .ak-header__copy') as Element
    expect(visibleOrder(copy)).toEqual(['ak-header__eyebrow', 'ak-header__title'])
  })
})

describe('the lane headers and portal stacks read the contract tokens (spec 5)', () => {
  it('left (Threads), centre (app header) and right (menu) headings are all the heading size', () => {
    expect(rule('.ak-header__title')).toContain('font-size: var(--ak-heading-size);')
    expect(ruleIn(LAYER, "[class*='menuHeading']")).toContain('font-size: var(--ak-heading-size);')
    // Two rules carry this selector (the predecessor's margin reset, then the type); together they set the heading size.
    expect(rulesOf(LAYER).filter(entry => entry.selectors === '.x5-threads__toolbar .ak-label').map(entry => entry.body).join(''))
      .toContain('font-size: var(--ak-heading-size);')
    expect(ruleIn(THREADS, '.heading')).toContain('font-size: var(--ak-heading-size);')
    for (const css of [LAYER, THREADS]) expect(css).not.toMatch(/clamp\(22px/u)
  })
  it('lane headers take the header inset and keep the hot-corner clearance, by token', () => {
    const headers = [
      ruleIn(LAYER, "[class*='menuHeader']"),
      ruleIn(LAYER, '.x5-conversation-header'),
      ...rulesOf(LAYER).filter(entry => entry.selectors === '.x5-threads__toolbar').map(entry => entry.body),
      ruleIn(THREADS, '.head'),
    ]
    expect(headers).toHaveLength(5)
    for (const body of headers) {
      expect(body).toContain('var(--ak-corner-clearance)')
      expect(body).not.toMatch(/\b(?:20|64)px/u)
    }
    for (const body of [ruleIn(LAYER, "[class*='menuHeader']"), ruleIn(LAYER, '.x5-conversation-header'), ruleIn(THREADS, '.head')]) {
      expect(body).toContain('var(--ak-header-inset)')
    }
    expect(ROOT.get('--ak-corner-clearance')).toBe('64px')
  })
  it('no portal head in the old overrides has a fixed height: the 68px floor is a min-height, by token', () => {
    for (const css of [LAYER, THREADS]) {
      for (const { selectors, body } of rulesOf(css)) {
        if (selectors.includes('ak-portal__head')) {
          expect(body, selectors).not.toMatch(/(^|[;\s])height\s*:/u)
          expect(body, selectors).not.toMatch(/68px\s*;/u)
        }
      }
    }
    expect(ruleIn(LAYER, '.x5-threads .ak-portal > .ak-portal__head')).toContain('min-height: var(--ak-portal-header-height);')
    expect(ruleIn(LAYER, '.x5-nostr-list .ak-portal > .ak-portal__head')).toContain('min-height: var(--ak-portal-header-height);')
    expect(ruleIn(THREADS, '.card :global(.ak-portal__head)')).toContain('min-height: var(--ak-portal-header-height, 68px);')
  })
  it('the portal stacks are the portal gap', () => {
    expect(ruleIn(LAYER, '.ak-canvas, .ak-grid')).toContain('gap: var(--ak-portal-gap);')
    expect(ruleIn(LAYER, "[data-slot^='shell.menu.']")).toContain('gap: var(--ak-portal-gap);')
    expect(ruleIn(LAYER, '.x5-nostr-list')).toContain('gap: var(--ak-portal-gap);')
    expect(LAYER).not.toMatch(/gap:\s*14px/u)
  })
  it('the reading size is applied only to the threads lane\'s How it works explanation', () => {
    expect(ruleIn(THREADS, '.how :global(.ak-portal__body .ak-lead)')).toBe('\n  font-size: var(--ak-reading-size);\n')
    const readers = [LAYER, THREADS, RULES].flatMap(css => rulesOf(css).filter(entry => entry.body.includes('--ak-reading-size') && !entry.selectors.includes(':root')))
    expect(readers.map(entry => entry.selectors)).toEqual(['.how :global(.ak-portal__body .ak-lead)'])
  })
})

describe('the Work launcher is a PortalLauncher like every other menu entry (spec 6)', () => {
  const workProps = (activeSurface: string | undefined, openSurface = vi.fn(), closeSurface = vi.fn()) => ({
    ...menuProps(activeSurface, openSurface, closeSurface), t: (key: string) => key,
  }) as unknown as Parameters<typeof WorkMenu>[0]
  it('opens Work in the centre, says aria-current while shown, never aria-expanded, and closes from the same head', () => {
    const openSurface = vi.fn()
    const closeSurface = vi.fn()
    const { container, rerender } = render(<WorkMenu {...workProps(undefined, openSurface, closeSurface)} />)
    const head = () => container.querySelector('[data-work-launcher]') as HTMLButtonElement
    expect(head().classList.contains('ak-portal__head')).toBe(true)
    expect(head().closest('.ak-portal')?.getAttribute('data-portal-kind')).toBe('launcher')
    expect(head().closest('.ak-portal')?.classList.contains('ak-portal--menu')).toBe(true)
    expect(head().hasAttribute('aria-expanded')).toBe(false)
    expect(head().hasAttribute('aria-current')).toBe(false)
    expect(head().querySelector('.ak-portal__title')?.textContent).toBe('menu.work')
    expect(head().querySelector('.ak-portal__summary')?.textContent).toBe('menu.work.tip')
    fireEvent.click(head())
    expect(openSurface.mock.calls).toEqual([[WORK_SURFACE, undefined, 'contained']])
    rerender(<WorkMenu {...workProps(WORK_SURFACE, openSurface, closeSurface)} />)
    expect(head().getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('.ak-portal__body')).toBeNull()
    fireEvent.click(head())
    expect(closeSurface).toHaveBeenCalledTimes(1)
    expect(openSurface).toHaveBeenCalledTimes(1)
  })
  it('has the same head geometry as the System menu launchers beside it', () => {
    const { container } = render(
      <>
        <div data-case="work"><WorkMenu {...workProps(undefined)} /></div>
        <div data-case="system"><SystemMenu {...menuProps(undefined)} /></div>
      </>,
    )
    const work = container.querySelector('[data-case="work"] .ak-portal__head') as Element
    const system = container.querySelector('[data-case="system"] .ak-portal__head') as Element
    expect(geometry(work)).toEqual(geometry(system))
    expect(geometry(work).minHeight).toBe('68px')
  })
})
