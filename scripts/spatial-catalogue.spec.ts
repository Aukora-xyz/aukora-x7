import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  CATALOGUE, CATALOGUE_PATH, REPOSITORY_ROOT, TOKEN_OWNER, propsOf, renderCatalogue, rootTokens, tokensRead,
} from './spatial-catalogue.ts'

const read = (path: string) => readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8')
const COMPONENTS = 'packages/client/ui-layout/src/client/spatial/primitives/components.tsx'

/**
 * Make PortalLauncher's `current` prop optional. The property is found by the TypeScript parser the catalogue script
 * itself reads props with (review ui3, SHOULD), never by a pattern over the text, so no comment near it, however
 * it is worded, wrapped or linked, decides whether or where the edit lands.
 * @param source - components.tsx text.
 * @returns the text with that one declaration changed, or the same text when the declaration is not there.
 */
const optionalCurrent = (source: string): string => {
  const file = ts.createSourceFile(COMPONENTS, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'PortalLauncherProps')
  const current = declaration?.members.find((member): member is ts.PropertySignature =>
    ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === 'current')
  if (current === undefined || current.questionToken !== undefined) return source
  return `${source.slice(0, current.name.end)}?${source.slice(current.name.end)}`
}

/** A fixed PortalLauncher declaration, with `comment` where the real one documents `current`. */
const launcherFixture = (comment: string): string => [
  'import type { ReactNode } from \'react\'',
  'export interface PortalLauncherProps {',
  '  readonly title: ReactNode',
  comment,
  '  readonly current: boolean',
  '  readonly onOpen: () => void',
  '}',
  'export function PortalLauncher(props: PortalLauncherProps) { return props }',
].join('\n')
/** Every way a comment-only edit may document `current`: none of them may move or defeat the mutation. */
const COMMENT_VARIANTS = [
  '  /** Its application is the one shown in the centre lane. */',
  '  /**\n   * Its application is the one shown in the centre lane,\n   * now wrapped onto a second line.\n   */',
  '  /** Its application is the one {@link PortalLauncher} shows: `{ current }` is that. */',
  '  /** Reworded: shown in the centre lane now. */\n  // and a line comment: readonly current: string }',
  '  /* readonly current: number */',
  '',
]

describe('the Spatial catalogue (Spatial design spec 11)', () => {
  it('the committed catalogue is the one the sources generate now (regenerate it when a prop or a token changes)', () => {
    expect(read(CATALOGUE_PATH)).toBe(renderCatalogue(read))
  })

  it('lists each supported native component with a source that exists and exports it', () => {
    expect(CATALOGUE.map(entry => entry.name))
      .toEqual(['AppHeader', 'PortalLauncher', 'PortalButton', 'PortalFold', 'RecordRow', 'ActionControl', 'Panel', 'SectionHeader',
        'SpatialFrame', 'Conversation'])
    const text = read(CATALOGUE_PATH)
    for (const entry of CATALOGUE) {
      expect(existsSync(resolve(REPOSITORY_ROOT, entry.source)), entry.source).toBe(true)
      expect(text).toContain(`## ${entry.name}\n`)
      expect(text).toContain(`- Source: \`${entry.source}\` (\`${entry.exportName}\`)`)
      for (const scope of entry.styles) expect(existsSync(resolve(REPOSITORY_ROOT, scope.file)), scope.file).toBe(true)
    }
  })

  it('a changed, added or removed prop changes the catalogue, so a stale committed file fails the first case', () => {
    const source = read(COMPONENTS)
    const before = renderCatalogue(read)
    const added = source.replace('  readonly actions?: ReactNode\n}) {', '  readonly actions?: ReactNode\n  readonly align?: \'start\' | \'end\'\n}) {')
    expect(added).not.toBe(source)
    const withAdded = renderCatalogue(path => (path === COMPONENTS ? added : read(path)))
    expect(withAdded).not.toBe(before)
    expect(withAdded).toContain('- `align?`: `\'start\' | \'end\'`')
    // Found by the parser in the real source: the mutation lands, and the catalogue changes with it.
    const retyped = optionalCurrent(source)
    expect(retyped).not.toBe(source)
    expect(renderCatalogue(path => (path === COMPONENTS ? retyped : read(path)))).not.toBe(before)
    expect(propsOf(source, COMPONENTS, 'PortalLauncher').find(prop => prop.name === 'current')).toEqual({ name: 'current', optional: false, type: 'boolean' })
    expect(propsOf(retyped, COMPONENTS, 'PortalLauncher').find(prop => prop.name === 'current')).toEqual({ name: 'current', optional: true, type: 'boolean' })
  })

  it('a comment-only edit near a prop never defeats the prop mutation (review ui3, SHOULD)', () => {
    for (const comment of COMMENT_VARIANTS) {
      const fixture = launcherFixture(comment)
      const current = () => propsOf(fixture, 'fixture.tsx', 'PortalLauncher').find(prop => prop.name === 'current')
      expect(current(), comment).toEqual({ name: 'current', optional: false, type: 'boolean' })
      const retyped = optionalCurrent(fixture)
      expect(retyped, comment).toBe(fixture.replace('\n  readonly current: boolean\n', '\n  readonly current?: boolean\n'))
      expect(propsOf(retyped, 'fixture.tsx', 'PortalLauncher').find(prop => prop.name === 'current'), comment)
        .toEqual({ name: 'current', optional: true, type: 'boolean' })
      // The comment itself is left exactly as it was.
      expect(retyped, comment).toContain(comment)
    }
  })

  it('reads props from the source declarations: inline literals, local interfaces with their bases, aliases and intersections', () => {
    const sample = [
      'interface Base { readonly a: string }',
      'export interface Wide extends Omit<Base, \'a\'> { readonly b?: number }',
      'type Alias = Wide & { readonly c: boolean } & Record<`data-${string}`, string>',
      'export function One({ x }: { readonly x: string; readonly y?: () => void }) { return x }',
      'export function Two(props: Alias) { return props }',
      'function Hidden(props: { readonly z: string }) { return props }',
    ].join('\n')
    expect(propsOf(sample, 'sample.tsx', 'One')).toEqual([
      { name: 'x', optional: false, type: 'string' }, { name: 'y', optional: true, type: '() => void' },
    ])
    expect(propsOf(sample, 'sample.tsx', 'Two')).toEqual([
      { name: '(inherits)', optional: false, type: 'Omit<Base, \'a\'>' },
      { name: 'b', optional: true, type: 'number' },
      { name: 'c', optional: false, type: 'boolean' },
      { name: '(inherits)', optional: false, type: 'Record<`data-${string}`, string>' },
    ])
    expect(() => propsOf(sample, 'sample.tsx', 'Hidden')).toThrow(/not exported/u)
    expect(() => propsOf(sample, 'sample.tsx', 'Missing')).toThrow(/no exported function Missing/u)
  })

  it('the contract token table is the one :root block of the token owner, at the spec values', () => {
    const root = new Map(rootTokens(read(TOKEN_OWNER)))
    const spec = {
      '--ak-portal-header-height': '68px', '--ak-portal-gap': '14px', '--ak-portal-padding-inline': '16px',
      '--ak-portal-content-gap': '12px', '--ak-icon-tile-size': '30px', '--ak-icon-glyph-size': '16px',
      '--ak-heading-size': '1.5rem', '--ak-reading-size': '1rem', '--ak-header-inset': '20px', '--ak-corner-clearance': '64px',
    }
    const text = read(CATALOGUE_PATH)
    for (const [name, value] of Object.entries(spec)) {
      expect(root.get(name), name).toBe(value)
      expect(text).toContain(`| \`${name}\` | \`${value}\` |`)
    }
    expect(() => rootTokens(':root { --a: 1px; } :root { --b: 2px; }')).toThrow(/exactly one :root/u)
  })

  it('a component\'s custom properties come from the rules of its own class family only', () => {
    const css = [
      '/* .ak-row { color: var(--ak-commented); } */',
      '.ak-row { color: var(--ak-a); }',
      '.ak-rows { gap: var(--ak-not-a-row); }',
      '.ak-row__head, .ak-other { min-height: var(--ak-b, 1px); }',
      '@container x (max-width: 1px) { .ak-row--static .ak-row__title { color: var(--ak-c); } }',
    ].join('\n')
    expect(tokensRead(css, { file: 'x.css', classes: ['ak-row'] })).toEqual(['--ak-a', '--ak-b', '--ak-c'])
    expect(tokensRead(css, { file: 'x.css', whole: true })).toEqual(['--ak-a', '--ak-b', '--ak-c', '--ak-not-a-row'])
  })
})
