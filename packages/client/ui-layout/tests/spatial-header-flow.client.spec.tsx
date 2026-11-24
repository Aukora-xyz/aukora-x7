// @vitest-environment jsdom
/**
 * SPATIAL DESIGN: what was seen on screen, and the navigation requests.
 *
 *   1. A centre header's badges are in the header's flow: no loaded rule takes them (or any header part) out of it, the
 *      header wraps, and on a phone's lane they take a row of their own. (Seen: "READING" over "BACKGROUND MISSIONS ·
 *      AUTONOMOUS WORK" at 416px, "WORKING · LIVE" over "LIVING SYSTEM STATE" at 390px.) Review: Media's Settings joins
 *      that trailing area, and the frame's "below" slot (Plugins' search) follows the header in flow.
 *   2. Every lane and centre header band is a floor that grows with its text, never a fixed height.
 *   3. The fingerprint card starts below the compact frame's corner band; its controls are 44px targets on touch.
 *   4. The thread list's head keeps the compact frame's corner clearance itself (the frame's marked rule can go).
 *   5. Lane header tools wrap under the heading before they would cut or cover it (tablet widths).
 *   6. The newer family has an ordinary action control, a panel and a section header, and Media and AUMLOK use them,
 *      at the legacy look: every declaration resolves to the same value.
 *
 * jsdom applies the cascade (selectors, specificity, order) but does no layout: what is proved here is that every part
 * is in the flow of a wrapping flex header, which cannot overlap; the drawn boxes are for a reviewer's eyes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ActionControl, AppHeader, Panel, SectionHeader } from '../src/client/spatial/primitives/index.ts'
import { SurfaceFrame } from '../src/client/spatial/x5/common.tsx'
import { MEDIA_SURFACE, MediaSurface } from '../src/client/spatial/apps/media/index.ts'

type MediaProps = Parameters<typeof MediaSurface>[0]

const SPATIAL = 'packages/client/ui-layout/src/client/spatial/'
const readSpatial = (file: string): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${SPATIAL}${file}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${file}`)
  return readFileSync(path, 'utf8')
}
const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '')
const PRIMITIVES_SHEET = readSpatial('primitives/primitives.css')
const LAYER_SHEET = readSpatial('portal/spatial-layer.css')
const FIT_SHEET = readSpatial('portal/spatial-layer-fit.css')
const PRIMITIVES = uncomment(PRIMITIVES_SHEET)
const LAYER = uncomment(LAYER_SHEET)
const FIT = uncomment(FIT_SHEET)
const THREADS = uncomment(readSpatial('portal/ThreadsLane.module.css'))
const FINGERPRINT = uncomment(readSpatial('portal/FingerprintWaiting.module.css'))
const FRAME = uncomment(readSpatial('SpatialFrame.module.css'))

/** Every rule of a stylesheet (at-rule bodies included): its selector list and its declarations. */
const rulesOf = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selectors, body]) => ({
  selectors: (selectors ?? '').trim(), body: body ?? '',
}))
const ruleIn = (css: string, selector: string): string => {
  const found = rulesOf(css).filter(entry => entry.selectors === selector)
  if (found.length !== 1) throw new Error(`expected one rule ${selector}, found ${String(found.length)}`)
  return found[0]?.body ?? ''
}
/** A declaration block as property -> value. */
const declarations = (body: string) => new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)]
  .map(([, name, value]) => [name ?? '', (value ?? '').replace(/\s+/gu, ' ').trim()]))

const mountSheets = (...sheets: string[]) => {
  for (const text of sheets) {
    const style = document.createElement('style')
    style.setAttribute('data-test-sheet', '')
    style.textContent = text
    document.head.append(style)
  }
}
afterEach(() => {
  cleanup()
  for (const style of document.querySelectorAll('style[data-test-sheet]')) style.remove()
  vi.restoreAllMocks()
})

/** What was seen: the Work and the Aura Coherence headers, with their long lines and their status badges. */
const SEEN = [
  { width: 416, eyebrow: 'BACKGROUND MISSIONS · AUTONOMOUS WORK', title: 'Work', badges: [{ text: 'READING' }] },
  { width: 390, eyebrow: 'LIVING SYSTEM STATE', title: 'Aura Coherence', badges: [{ text: 'WORKING · LIVE', tone: 'mint' as const }] },
] as const

/** Each element from the header's trailing area up to the header itself. */
const chain = (header: Element) => {
  const out: Element[] = []
  for (let at: Element | null = header.querySelector('.ak-header__badges'); at !== null; at = at.parentElement) {
    out.push(at)
    if (at === header) break
  }
  return out
}
const OUT_OF_FLOW = /^(absolute|fixed)$/u

describe('1. a header\'s badges and tools are in its flow, at every width (spec 5)', () => {
  const mountSeen = (seen: (typeof SEEN)[number]) => render(
    <div data-slot="shell.surface" style={{ width: `${String(seen.width)}px` }}>
      <SurfaceFrame active eyebrow={seen.eyebrow} title={seen.title} badges={seen.badges}><p>body</p></SurfaceFrame>
    </div>,
  )

  it.each(SEEN)('at $width px, "$title": every part from the badges up to the header is in the flow of a wrapping header', (seen) => {
    mountSheets(PRIMITIVES_SHEET, LAYER_SHEET, FIT_SHEET)
    const { container } = mountSeen(seen)
    const header = container.querySelector('.x5-app-header .ak-header')
    if (header === null) throw new Error('no header')
    expect(header.querySelector('.ak-header__eyebrow')?.textContent).toBe(seen.eyebrow)
    expect(header.querySelector('.ak-header__badges')?.textContent).toBe(seen.badges[0].text)
    for (const element of chain(header)) {
      const style = getComputedStyle(element)
      expect(style.position, element.className).not.toMatch(OUT_OF_FLOW)
      for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(style[side], `${element.className} ${side}`).toMatch(/^(auto)?$/u)
      expect(style.transform, element.className).toMatch(/^(none)?$/u)
    }
    // The title and its line are in the flow too: one wrapping row of two flex items cannot put one over the other.
    for (const part of ['.ak-header__copy', '.ak-header__title', '.ak-header__eyebrow']) {
      expect(getComputedStyle(header.querySelector(part) as Element).position, part).not.toMatch(OUT_OF_FLOW)
    }
    const style = getComputedStyle(header)
    expect(style.display).toBe('flex')
    expect(style.flexWrap).toBe('wrap')
    // The trailing area follows the copy: the copy may take the whole line, and the area then wraps onto its own row.
    const copy = getComputedStyle(header.querySelector('.ak-header__copy') as Element)
    expect(copy.maxWidth).toBe('100%')
    const badges = getComputedStyle(header.querySelector('.ak-header__badges') as Element)
    expect(badges.marginInlineStart || badges.marginLeft).toBe('auto')
    expect(badges.flexWrap).toBe('wrap')
  })

  it('control: the check above sees the old absolute badge rule, so its pass is not blind', () => {
    mountSheets(PRIMITIVES_SHEET, LAYER_SHEET, FIT_SHEET,
      '.x5-app-header .ak-header__badges { position: absolute; right: 64px; bottom: 2px; }')
    const { container } = mountSeen(SEEN[0])
    const badges = container.querySelector('.ak-header__badges') as Element
    expect(getComputedStyle(badges).position).toBe('absolute')
  })

  it('no rule in the primitives or the x5 layer positions a header part out of flow; a phone\'s lane gives the badges a row', () => {
    for (const css of [PRIMITIVES, LAYER, FIT]) {
      for (const { selectors, body } of rulesOf(css)) {
        if (!/\.ak-header/u.test(selectors)) continue
        expect(body, selectors).not.toMatch(/position\s*:\s*(absolute|fixed)/u)
        expect(body, selectors).not.toMatch(/(^|[;\s])(top|right|bottom|left|inset|transform)\s*:/u)
      }
    }
    // The old fit file's container rule (two badges or more) is gone: the primitive wraps every header the same way.
    expect(FIT).not.toMatch(/@container/u)
    expect(FIT).not.toMatch(/ak-header__badges/u)
    // On a phone's lane (the app container at 420px or less) the trailing area takes its own row on the title's left edge.
    const phone = /@container ak-app \(max-width: 420px\) \{([\s\S]*?)\n\}/u.exec(PRIMITIVES)?.[1] ?? ''
    expect(ruleIn(phone, '.ak-header')).toContain('flex-direction: column;')
    expect(ruleIn(phone, '.ak-header__badges')).toContain('margin-inline-start: 0;')
    expect(ruleIn(phone, '.ak-header__badges')).toContain('align-self: flex-start;')
  })

  it('the header\'s own tools sit in the same trailing area, after the badges; nothing is drawn when there are none', () => {
    const { container } = render(<AppHeader eyebrow="LINE" title="Title" badges={[{ text: 'B' }]}
      actions={<ActionControl data-tool="">Settings</ActionControl>} />)
    const area = container.querySelector('.ak-header__badges')
    expect([...(area?.children ?? [])].map(child => child.textContent)).toEqual(['B', 'Settings'])
    cleanup()
    const toolsOnly = render(<AppHeader eyebrow="LINE" title="Title" actions={<ActionControl>Settings</ActionControl>} />)
    expect(toolsOnly.container.querySelector('.ak-header__badges')?.textContent).toBe('Settings')
    cleanup()
    const none = render(<AppHeader eyebrow="LINE" title="Title" actions={null} />)
    expect(none.container.querySelector('.ak-header__badges')).toBeNull()
  })

  it('the frame\'s "below" slot (Plugins\' search) is in flow under the header\'s hairline, not drawn over the title and its line', () => {
    mountSheets(PRIMITIVES_SHEET, LAYER_SHEET, FIT_SHEET)
    const { container } = render(
      <div data-slot="shell.surface" style={{ width: '416px' }}>
        <SurfaceFrame active eyebrow="DeepSeek Harness · live inventory" title="Built-in plugins" badges={[{ text: 'READING' }]}
          headerBelow={<input className="x5-field" type="search" aria-label="Search plugins and skills" />}><p>body</p></SurfaceFrame>
      </div>,
    )
    const below = container.querySelector('.x5-app-header > .x5-app-header__below')
    if (below === null) throw new Error('no below slot')
    expect(below.previousElementSibling?.className).toBe('ak-header')
    const style = getComputedStyle(below)
    expect(style.position).not.toMatch(OUT_OF_FLOW)
    for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(style[side], side).toMatch(/^(auto)?$/u)
    expect(style.transform).toMatch(/^(none)?$/u)
    expect(declarations(ruleIn(LAYER, '.x5-app-header__below')).get('margin-top')).toBe('var(--ak-portal-gap)')
  })

  it('Media\'s Settings sits in its header\'s trailing area after "NOT CONNECTED YET", in flow, never over the badge', () => {
    mountSheets(PRIMITIVES_SHEET, LAYER_SHEET, FIT_SHEET)
    const { container } = render(
      <div data-slot="shell.surface" style={{ width: '416px' }}>
        <MediaSurface {...({ activeSurface: MEDIA_SURFACE, closeSurface: () => undefined } as unknown as MediaProps)} />
      </div>,
    )
    const surface = container.querySelector('section[data-media-studio][data-settings-surface]')
    if (surface === null) throw new Error('no Media surface')
    // NOT CONNECTED YET names the studio's connector, so it shows on Studio; on Drive, Settings is alone.
    expect([...(surface.querySelector('.ak-header__badges')?.children ?? [])].map(child => child.textContent)).toEqual(['Settings'])
    fireEvent.click(surface.querySelector('[data-media-view="studio"]') as HTMLElement)
    // No header slot of Media's is positioned: the absolute actions box (top 50%, 64px from the right) is gone.
    expect(surface.querySelector('.x5-app-header__actions, .x5-app-header__below, .x5-app-header__center')).toBeNull()
    const header = surface.querySelector('.x5-app-header > .ak-header')
    if (header === null) throw new Error('no header')
    const area = header.querySelector('.ak-header__badges')
    expect([...(area?.children ?? [])].map(child => child.textContent)).toEqual(['NOT CONNECTED YET', 'Settings'])
    const settings = area?.querySelector('button[data-aukora-action]')
    if (settings === null || settings === undefined) throw new Error('no Settings control in the trailing area')
    for (let at: Element | null = settings; at !== null && at !== header.parentElement; at = at.parentElement) {
      const style = getComputedStyle(at)
      expect(style.position, at.className).not.toMatch(OUT_OF_FLOW)
      expect(style.transform, at.className).toMatch(/^(none)?$/u)
    }
    // It still opens and closes the inline settings.
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(surface.querySelector('[data-media-settings]')).not.toBeNull()
  })
})

describe('2. header bands are floors that grow with their text (spec 5, 200% text)', () => {
  it('the centre header, the menu header, the thread lane head and the Nostr band set a min-height and no height', () => {
    const bands: [string, string, string][] = [
      ['centre', ruleIn(LAYER, ".x5-app-header .ak-header, [data-slot='shell.surface'] .ak-canvas > .ak-header"), '66px'],
      ['menu', ruleIn(LAYER, "[class*='menuHeader']"), '84px'],
      ['threads', ruleIn(THREADS, '.head'), '84px'],
      ['nostr', ruleIn(LAYER, '.x5-app-header--nostr, .x5-app-header--nostr .ak-header'), '84px'],
      ...rulesOf(LAYER).filter(entry => entry.selectors === '.x5-threads__toolbar')
        .map((entry): [string, string, string] => ['toolbar', entry.body, entry.body.includes('min-height') ? '84px' : '']),
    ]
    for (const [name, body, floor] of bands) {
      expect(body, name).not.toMatch(/(^|[;\s])height\s*:/u)
      if (floor !== '') expect(declarations(body).get('min-height'), name).toBe(floor)
    }
  })
  it('the one fixed band left (the conversation header, held by the frame inset under it) is named in the rules and the contract', () => {
    const conversation = declarations(ruleIn(LAYER, '.x5-conversation-header'))
    expect(conversation.get('height')).toBe('84px')
    expect(LAYER).toMatch(/\.x5-genesis-frame \{[^}]*inset: 84px 0 0;/u)
    const rulesPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}docs/foundations/SPATIAL-DESIGN-RULES.md`)).find(existsSync)
    if (rulesPath === undefined) throw new Error('not found: SPATIAL-DESIGN-RULES.md')
    const rules = readFileSync(rulesPath, 'utf8').replace(/\s+/gu, ' ')
    expect(rules).toMatch(/Every header band \(centre 66px, lane 84px\) is a min-height floor[^.]*\. ONE EXCEPTION, still open: /u)
    expect(rules).toMatch(/ONE EXCEPTION, still open: the open conversation's lane header \(`\.x5-conversation-header`/u)
    expect(PRIMITIVES_SHEET.replace(/\s+\*\s+/gu, ' ')).toMatch(/EXCEPT the open conversation's lane header, spatial-layer\.css `\.x5-conversation-header`: fixed 84px/u)
  })
  it('in the cascade, the centre header has the 66px floor and no fixed height', () => {
    mountSheets(PRIMITIVES_SHEET, LAYER_SHEET, FIT_SHEET)
    const { container } = render(
      <div data-slot="shell.surface"><SurfaceFrame active eyebrow="LINE" title="Title"><p>body</p></SurfaceFrame></div>,
    )
    const style = getComputedStyle(container.querySelector('.ak-header') as Element)
    expect(style.minHeight).toBe('66px')
    expect(style.height).toMatch(/^(auto)?$/u)
  })
})

describe('3. the fingerprint card in the compact frame, and on touch', () => {
  const card = ruleIn(FINGERPRINT, 'aside.card[data-fingerprint-waiting]')
  it('starts below the corner band where the frame sets its clearance, and 12px down everywhere else', () => {
    expect(declarations(card).get('top')).toBe('var(--dsh-compact-corner-clearance, 12px)')
    expect(declarations(card).get('max-height')).toBe('calc(100% - var(--dsh-compact-corner-clearance, 12px) - 12px)')
    // The frame sets that property only on its compact mark, so the wide card is exactly where it was.
    const setters = rulesOf(FRAME).filter(entry => /--dsh-compact-corner-clearance\s*:/u.test(entry.body)).map(entry => entry.selectors)
    expect(setters).toEqual(['.frame[data-compact-lane]'])
  })
  it('carries what the frame\'s marked rule gave it (top at the clearance, a 12px foot), so that rule can be deleted', () => {
    const compact = (value: string) => value.replace('var(--dsh-compact-corner-clearance, 12px)', 'var(--dsh-compact-corner-clearance)')
    expect(compact(declarations(card).get('top') ?? '')).toBe('var(--dsh-compact-corner-clearance)')
    expect(compact(declarations(card).get('max-height') ?? '')).toBe('calc(100% - var(--dsh-compact-corner-clearance) - 12px)')
  })
  it('Approve, Inspect and Hide are 44px targets on a coarse pointer', () => {
    const touch = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/u.exec(FINGERPRINT)?.[1] ?? ''
    expect(ruleIn(touch, '.card .primary, .card .secondary')).toContain('min-height: 44px;')
    expect(declarations(ruleIn(touch, '.card .dismiss'))).toEqual(new Map([['width', '44px'], ['height', '44px']]))
  })
  it('nothing in the card cuts its words: no ellipsis, no clamp, no nowrap; the head wraps', () => {
    expect(FINGERPRINT).not.toMatch(/text-overflow|line-clamp|white-space:\s*nowrap/u)
    expect(ruleIn(FINGERPRINT, '.card .head')).toContain('flex-wrap: wrap;')
    for (const part of ['.card .line', '.card .outcome', '.card .value']) expect(ruleIn(FINGERPRINT, part), part).toContain('overflow-wrap: anywhere;')
  })
})

describe('4 and 5. lane heads wrap their tools, and the thread list head keeps the compact clearance itself', () => {
  it('the thread lane head and the menu header wrap; the thread tools keep the row\'s end', () => {
    expect(ruleIn(THREADS, '.head')).toContain('flex-wrap: wrap;')
    expect(ruleIn(THREADS, '.tools')).toContain('margin-inline-start: auto;')
    expect(ruleIn(LAYER, "[class*='menuHeader']")).toContain('flex-wrap: wrap;')
  })
  it('in the compact frame the thread list head takes the corner clearance on both sides', () => {
    const compact = declarations(ruleIn(THREADS, ':global([data-compact-lane]) .head'))
    expect(compact.get('margin-inline')).toBe('var(--dsh-compact-corner-clearance)')
    expect(compact.get('padding-inline')).toBe('0')
  })
  it('carries what the frame\'s marked thread-list rule gave it, so that selector can be deleted', () => {
    const owner = new Map([...declarations(ruleIn(THREADS, '.head')), ...declarations(ruleIn(THREADS, ':global([data-compact-lane]) .head'))])
    // The frame's rule said: wrap, 4px 12px apart, at least 84px tall and no fixed height, the corner clearance outside, no
    // padding of its own inline.
    expect(owner.get('flex-wrap')).toBe('wrap')
    expect(owner.get('gap')).toBe('4px 12px')
    expect(owner.get('min-height')).toBe('84px')
    expect(owner.has('height')).toBe(false)
    expect(owner.get('margin-inline')).toBe('var(--dsh-compact-corner-clearance)')
    expect(owner.get('padding-inline')).toBe('0')
  })
})

describe('6. the newer family\'s action control, panel and section header, at the legacy look', () => {
  /** The token values a browser substitutes: the primitives' `:root`, and the face's palette (`spatial-tokens.css` `body`). */
  const tokens = new Map<string, string>()
  for (const block of [/:root\s*\{([^}]*)\}/u.exec(PRIMITIVES)?.[1], /\nbody\s*\{([^}]*)\}/u.exec(uncomment(readSpatial('spatial-tokens.css')))?.[1]]) {
    for (const [, name, value] of (block ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) tokens.set(name ?? '', (value ?? '').trim())
  }
  const resolveValue = (value: string) => {
    // The control's colour: the legacy accent and the newer tone are the same role (the tone class sets it).
    let out = value.replace(/var\(--ak-tone, var\(--ak-blue\)\)/gu, 'TONE').replace(/var\(--aukora-accent\)/gu, 'TONE')
    for (let depth = 0; depth < 8 && out.includes('var('); depth++) {
      out = out.replace(/var\((--[\w-]+)\)/gu, (_all, name: string) => tokens.get(name) ?? `MISSING(${name})`)
    }
    return out.replace(/\s+/gu, ' ')
  }
  const LEGACY = uncomment(readSpatial('Primitives.module.css'))
  const pairs = [
    [':where(.action)', ':where(.ak-control)'],
    [".action[aria-pressed='false']", ".ak-control[aria-pressed='false']"],
    [".action:hover:not(:disabled), .action[aria-pressed='true'], .action[aria-current='page'], .portal[data-open='yes']",
      ".ak-control:hover:not(:disabled), .ak-control[aria-pressed='true'], .ak-control[aria-current='page']"],
    ['.action:focus-visible, .portalButton:focus-visible', '.ak-control:focus-visible'],
    ['.action:disabled, .portalButton:disabled', '.ak-control:disabled'],
    [':where(.panel)', ':where(.ak-panel)'],
    [':where(.sectionHeader)', ':where(.ak-section-header)'],
  ] as const
  it.each(pairs)('%s and %s declare the same properties, each resolving to the same value, at the same specificity', (legacy, newer) => {
    const before = declarations(ruleIn(LEGACY, legacy))
    const after = declarations(ruleIn(PRIMITIVES, newer))
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [name, value] of before) expect(resolveValue(after.get(name) ?? ''), name).toBe(resolveValue(value))
    expect(JSON.stringify([...after.values()].map(resolveValue))).not.toContain('MISSING')
  })
  it('the legacy tones are the newer tones (blue, green = mint, purple = violet, gold)', () => {
    const legacyTone = (name: string) => resolveValue(declarations(ruleIn(LEGACY, `.${name}`)).get('--aukora-accent') ?? '')
    const newerTone = (name: string) => resolveValue(declarations(ruleIn(PRIMITIVES, `.ak-tone-${name}`)).get('--ak-tone') ?? '')
    for (const [legacy, newer] of [['blue', 'blue'], ['green', 'mint'], ['purple', 'violet'], ['gold', 'gold']] as const) {
      expect(newerTone(newer), legacy).toBe(legacyTone(legacy))
    }
  })
  it('ActionControl: a native button (type=button, blue unless toned) or a link, with its ref and the action mark', () => {
    const ref = createRef<HTMLButtonElement>()
    const onClick = vi.fn()
    const { container } = render(
      <>
        <ActionControl controlRef={ref} aria-pressed={false} onClick={onClick}>Image</ActionControl>
        <ActionControl tone="gold" type="submit" disabled>Save</ActionControl>
        <ActionControl href="https://example.invalid/" tone="violet">Open</ActionControl>
      </>,
    )
    const [plain, toned] = [...container.querySelectorAll('button')]
    expect(ref.current).toBe(plain)
    expect(plain?.getAttribute('type')).toBe('button')
    expect(plain?.className).toBe('ak-control ak-tone-blue')
    expect(plain?.getAttribute('aria-pressed')).toBe('false')
    expect(plain?.hasAttribute('data-aukora-action')).toBe(true)
    plain?.click()
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(toned?.getAttribute('type')).toBe('submit')
    expect(toned?.className).toBe('ak-control ak-tone-gold')
    expect(toned?.disabled).toBe(true)
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.invalid/')
    expect(link?.className).toBe('ak-control ak-tone-violet')
    expect(link?.hasAttribute('data-aukora-action')).toBe(true)
  })
  it('Panel and SectionHeader keep the caller\'s element, attributes and class', () => {
    const { container } = render(
      <Panel className="mine" aria-labelledby="h" data-x=""><SectionHeader className="row"><h3 id="h">Heading</h3></SectionHeader></Panel>,
    )
    const panel = container.firstElementChild
    expect(panel?.tagName).toBe('DIV')
    expect(panel?.className).toBe('ak-panel mine')
    expect(panel?.getAttribute('aria-labelledby')).toBe('h')
    expect(panel?.hasAttribute('data-x')).toBe(true)
    expect(panel?.firstElementChild?.tagName).toBe('HEADER')
    expect(panel?.firstElementChild?.className).toBe('ak-section-header row')
  })
  it('Media and AUMLOK import nothing from the legacy primitives', () => {
    const media = readSpatial('apps/media/MediaSurface.tsx')
    const aumlok = readSpatial('aumlok/AumlokSurface.tsx')
    for (const source of [media, aumlok]) expect(source).not.toMatch(/from '(\.\.\/)+primitives\.tsx'/u)
    expect(media).not.toMatch(/\bActionButton\b/u)
    expect(aumlok).not.toMatch(/<Card\b/u)
    expect(aumlok).toMatch(/import \{[^}]*\bPanel\b[^}]*\bSectionHeader\b[^}]*\} from '\.\.\/primitives\/index\.ts'/u)
  })
})
