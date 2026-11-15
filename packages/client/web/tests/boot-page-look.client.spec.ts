// @vitest-environment jsdom
/**
 * The loading screen's look 
 *.
 * The boot page paints before any theme or plugin loads, so its colours and its mark are copies by value; these tests
 * hold each copy to its source and each sentence to a readable contrast.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BootPage } from '../src/boot-page.ts'
import { BOOT_MARK_DATA_URI } from '../src/boot-mark.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8')

const BOOT_CSS = read('packages/client/web/src/boot-page.module.css')
const BOOT_TS = read('packages/client/web/src/boot-page.ts')
const BASE_CSS = read('packages/client/web/src/base.css')
const INDEX = read('apps/web/index.html')
const SPATIAL = read('packages/client/ui-layout/src/client/spatial/spatial-tokens.css')
const MARK_SOURCE = read('packages/client/ui-primitives/src/AukoraMark.tsx')
const BOOT_THEME = read('packages/client/ui-theme/src/boot-theme.ts')
const MANIFEST = JSON.parse(read('apps/web/public/manifest.webmanifest')) as { background_color?: string }

/** The value a stylesheet gives a custom property (its first declaration). */
function prop(css: string, name: string): string {
  const value = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(css)?.[1]?.trim()
  if (value === undefined) throw new Error(`${name} is not declared`)
  return value
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  if (at === -1) throw new Error(`${selector} has no rule`)
  return css.slice(at, css.indexOf('}', at))
}

/** rgb()/rgba() channels, 0-255. */
function channels(color: string): [number, number, number] {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color)
  if (match === null) throw new Error(`not an rgb colour: ${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** WCAG 2 relative luminance. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const NIGHT = prop(rule(BOOT_CSS, '.boot'), '--dsh-boot-night')

afterEach(() => { document.body.innerHTML = '' })

describe('the loading screen is the Spatial night in both colour schemes', () => {
  it('its background is the Spatial palette\'s --aukora-background (the night-850 of the Spatial canvas)', () => {
    expect(NIGHT).toBe(prop(SPATIAL, '--aukora-background'))
    expect(NIGHT).toBe(prop(SPATIAL, '--dsw-static-spatial-night-850'))
    expect(NIGHT).toBe('rgb(11, 13, 24)')
    const boot = rule(BOOT_CSS, '.boot')
    expect(prop(boot, 'background')).toBe('var(--dsh-boot-night)')
    expect(prop(boot, 'color-scheme')).toBe('dark')
  })

  it('each text colour mirrors the Spatial token named beside it', () => {
    const boot = rule(BOOT_CSS, '.boot')
    expect(prop(boot, '--dsh-boot-label-primary')).toBe(prop(SPATIAL, '--aukora-text'))
    expect(prop(boot, '--dsh-boot-label-secondary')).toBe(prop(SPATIAL, '--aukora-text-secondary'))
    expect(prop(boot, '--dsh-boot-label-tertiary')).toBe(prop(SPATIAL, '--aukora-text-muted'))
    expect(prop(boot, '--dsh-boot-border')).toBe(prop(SPATIAL, '--aukora-border'))
  })

  it('it follows neither the theme nor the system scheme: no theme palette, no dark-theme or scheme rule', () => {
    expect(BOOT_CSS).not.toMatch(/var\(--dsw-alias-/u)
    expect(BOOT_CSS).not.toContain('data-ds-dark-theme')
    expect(BOOT_CSS).not.toContain('prefers-color-scheme')
  })

  it('every sentence it can show (hint, notes, stall notice, failure report, Reload) reads at 4.5:1 or more', () => {
    const boot = rule(BOOT_CSS, '.boot')
    const colours = [...BOOT_CSS.matchAll(/(?:^|\s)color:\s*([^;]+);/gu)].map(match => match[1]?.trim())
    // Every text colour on the page is one of the three labels; each label clears 4.5:1 on the night.
    expect(new Set(colours)).toEqual(new Set([
      'var(--dsh-boot-label-primary)', 'var(--dsh-boot-label-secondary)', 'var(--dsh-boot-label-tertiary)',
    ]))
    for (const label of ['--dsh-boot-label-primary', '--dsh-boot-label-secondary', '--dsh-boot-label-tertiary']) {
      expect(contrast(prop(boot, label), NIGHT), label).toBeGreaterThanOrEqual(4.5)
    }
    // The classes each state draws with: loading and stall (.hint), failure (.failedTitle, .failedItem), Reload.
    expect(prop(rule(BOOT_CSS, '.wordmark'), 'color')).toBe('var(--dsh-boot-label-primary)')
    expect(prop(rule(BOOT_CSS, '.hint'), 'color')).toBe('var(--dsh-boot-label-tertiary)')
    expect(prop(rule(BOOT_CSS, '.failedTitle'), 'color')).toBe('var(--dsh-boot-label-primary)')
    expect(prop(rule(BOOT_CSS, '.failedItem'), 'color')).toBe('var(--dsh-boot-label-secondary)')
    expect(prop(rule(BOOT_CSS, '.reload'), 'color')).toBe('var(--dsh-boot-label-primary)')
    expect(prop(rule(BOOT_CSS, '.reload'), 'background')).toBe('transparent')
  })

  it('no white frame before it: a dark first canvas, then the shell paints the same night before the theme', () => {
    expect(INDEX).toContain('<meta name="color-scheme" content="dark" />')
    // The Mac host refuses a page with inline style (server/asset-cache.mjs): the night comes from the shell's sheet.
    expect(INDEX).not.toMatch(/<base\b|<style\b|\bsrcset\s*=|\bstyle\s*=/iu)
    expect(BASE_CSS).toContain(`background: var(--dsw-alias-bg-base, ${NIGHT});`)
    // The theme's boot row (applied on her page after base.css) paints the same night while the boot page is mounted.
    expect(BOOT_THEME).toContain(`const BOOT_NIGHT = '${NIGHT}'`)
  })

  it('the installed app\'s splash (manifest background_color) is the same night, so splash to boot page does not jump', () => {
    const hex = `#${channels(NIGHT).map(value => value.toString(16).padStart(2, '0')).join('')}`
    expect(hex).toBe('#0b0d18')
    expect(MANIFEST.background_color).toBe(hex)
  })

  it('Reload\'s edge is the 0.5px hairline, in the boot page\'s own neutral border colour', () => {
    expect(prop(rule(BOOT_CSS, '.reload'), 'border')).toBe('0.5px solid var(--dsh-boot-border)')
  })
})

describe('the AUKORA trefoil turns instead of a wheel', () => {
  it('the mark is the same bytes the app shows as her mark (ui-primitives AukoraMark, aukora-icon-96.png)', () => {
    const source = /export const AUKORA_ICON_DATA_URI = '([^']+)'/u.exec(MARK_SOURCE)?.[1]
    expect(source).toBeDefined()
    expect(BOOT_MARK_DATA_URI).toBe(source)
    const bytes = Buffer.from(BOOT_MARK_DATA_URI.replace('data:image/png;base64,', ''), 'base64')
    const icon = readFileSync(resolve(ROOT, 'apps/web/public/aukora-icon-96.png'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(icon).digest('hex'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('f7b5a4fac8c8a6309b159ee7f6d65995157fba077625f935824bc9130dee1cdb')
  })

  it('the spinner element holds the mark, decorative, and nothing else', () => {
    const el = document.createElement('div')
    document.body.append(el)
    new BootPage(el)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner).not.toBeNull()
    expect(spinner?.children).toHaveLength(1)
    const mark = spinner?.firstElementChild as HTMLImageElement
    expect(mark.tagName).toBe('IMG')
    expect(mark.getAttribute('src')).toBe(BOOT_MARK_DATA_URI)
    expect(mark.getAttribute('alt')).toBe('')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(spinner?.getAttribute('style')).toBeNull()
  })

  it('one calm linear turn every 2.4 s, and under reduced motion it does not move', () => {
    expect(prop(rule(BOOT_CSS, '.spinner'), 'animation')).toBe('turn 2.4s linear infinite')
    // It turns on the trefoil's own centre: the PNG's three-fold symmetry centre, (47.875, 52.625) of 96 px (the point
    // about which its alpha turned 120 and 240 degrees overlaps itself best; the alpha centroid is (47.95, 53.13)).
    // About the box centre (48, 48) the mark circled about 1.5 px off axis at 32 px: a wobble.
    expect(prop(rule(BOOT_CSS, '.spinner'), 'transform-origin')).toBe('49.9% 54.8%')
    expect(BOOT_CSS).toMatch(/@keyframes turn \{\s*to \{ transform: rotate\(360deg\); \}\s*\}/u)
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(BOOT_CSS)?.[1] ?? ''
    expect(reduced).toMatch(/\.spinner \{\s*animation: none;\s*\}/u)
  })

  it('no wheel is left behind: no ring, no arc property', () => {
    expect(BOOT_CSS).not.toContain('--dsh-boot-arc')
    expect(BOOT_TS).not.toContain('--dsh-boot-arc')
    expect(BOOT_CSS).not.toContain('conic-gradient')
  })
})
