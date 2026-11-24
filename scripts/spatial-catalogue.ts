/**
 * THE SPATIAL CATALOGUE (Spatial design spec 11, the smallest true version).
 *
 * Generates `docs/foundations/SPATIAL-CATALOGUE.md` from the component and token owners themselves: each supported
 * native component's source file, its props as the source declares them (read with the TypeScript parser, syntax
 * only), the custom properties its stylesheet rules read, and its interaction meaning (spec 6). The contract token
 * table is read from the one `:root` block of `primitives.css`. Nothing here is a second, handwritten set of
 * measurements: change a component's props or a token and the catalogue changes with it
 * (`scripts/spatial-catalogue.spec.ts` fails until it is regenerated).
 *
 *   ./node_modules/.bin/tsx scripts/spatial-catalogue.ts           print the catalogue
 *   ./node_modules/.bin/tsx scripts/spatial-catalogue.ts --write   regenerate the committed file
 *   ./node_modules/.bin/tsx scripts/spatial-catalogue.ts --check   exit 1 when the committed file is stale
 *
 * The catalogue describes UI only. It grants no tools, signing, enrolment, memory or code execution.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Repository root (this file lives in `scripts/`). */
export const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the generated catalogue is committed, repository-relative. */
export const CATALOGUE_PATH = 'docs/foundations/SPATIAL-CATALOGUE.md'

const SPATIAL = 'packages/client/ui-layout/src/client/spatial/'
const COMPONENTS = `${SPATIAL}primitives/components.tsx`
/** The one owner of the contract tokens. */
export const TOKEN_OWNER = `${SPATIAL}primitives/primitives.css`

/** Which stylesheet rules a component reads: rules whose selectors name one of these class families, or the whole file. */
type StyleScope =
  | { readonly file: string; readonly classes: readonly string[] }
  | { readonly file: string; readonly whole: true }

/** One supported native component. */
export interface CatalogueEntry {
  readonly name: string
  /** Repository-relative source file. */
  readonly source: string
  /** The exported function that renders it. */
  readonly exportName: string
  /** The supported import. */
  readonly importFrom: string
  readonly purpose: string
  /** What selecting it means (spec 6): launcher, disclosure, record row, action, or none. */
  readonly interaction: string
  readonly styles: readonly StyleScope[]
}

const PORTAL_STYLES: readonly StyleScope[] = [{ file: TOKEN_OWNER, classes: ['ak-portal', 'ak-icon-tile', 'ak-expander'] }]

/** The supported native components, in the spec's order. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    name: 'AppHeader',
    source: COMPONENTS,
    exportName: 'AppHeader',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'The standard application header: the white title first, then the smaller descriptive line (the `eyebrow` prop) '
      + 'in the app\'s tone on the same left edge, then the badges in a trailing area that is not drawn when empty. '
      + 'The DOM order is the visible order; it keeps clear of the lane\'s hot corner.',
    interaction: 'None. A heading; its badges are labels, not controls.',
    styles: [{ file: TOKEN_OWNER, classes: ['ak-header'] }],
  },
  {
    name: 'PortalLauncher',
    source: COMPONENTS,
    exportName: 'PortalLauncher',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'The application launcher, in the centre lane and the right-hand menus alike: the one portal head, with no body.',
    interaction: 'Launcher: opens or reveals an application in the centre lane (`onOpen`); `aria-current="page"` while it is '
      + 'shown, never `aria-expanded`. Selecting the one already shown closes it when `onClose` is given, otherwise reveals it '
      + 'again. Navigation only: it authorises nothing.',
    styles: PORTAL_STYLES,
  },
  {
    name: 'PortalButton',
    source: COMPONENTS,
    exportName: 'PortalButton',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'The in-place disclosure: the same head as a launcher, and a body (its children) that opens below it, inside '
      + 'the lane it is in. Without children it draws as a launcher for old callers; new launchers use `PortalLauncher`.',
    interaction: 'Disclosure: expands and collapses its own body (`aria-expanded`, `aria-controls`); it never navigates and '
      + 'never resizes a lane. A visual "open" authorises nothing.',
    styles: PORTAL_STYLES,
  },
  {
    name: 'PortalFold',
    source: COMPONENTS,
    exportName: 'PortalFold',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'A disclosure whose closed body stays in the page (a native `<details>`); without children, a static head-only '
      + 'card whose words wrap instead of being cut.',
    interaction: 'Disclosure (native `<details>` toggle, keyboard included); the head-only form is not interactive.',
    styles: PORTAL_STYLES,
  },
  {
    name: 'RecordRow',
    source: COMPONENTS,
    exportName: 'RecordRow',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'A compact record, message or evidence row: smaller than a portal and a distinct component, never a launcher.',
    interaction: 'Record row: selects or inspects one item (expands its own detail when it has children); a row without '
      + 'children is static.',
    styles: [{ file: TOKEN_OWNER, classes: ['ak-row', 'ak-expander'] }],
  },
  {
    name: 'ActionControl',
    source: COMPONENTS,
    exportName: 'ActionControl',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'An ordinary action in place: a native button (or, with `href`, a link) in the tone\'s outline, for an app\'s own '
      + 'controls (a mode switch, a settings toggle, a disabled Generate). Its look is a zero-specificity floor the app refines.',
    interaction: 'Action: does what its app does on a click, behind that app\'s own checks. It never approves, signs or grants '
      + '(an owner approval is `LockedAction` or the passkey card). `aria-pressed` and `aria-current` light it.',
    styles: [{ file: TOKEN_OWNER, classes: ['ak-control'] }],
  },
  {
    name: 'Panel',
    source: COMPONENTS,
    exportName: 'Panel',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'A plain dark-glass surface (hairline, the portal radius, the portal surface) that an app composes its own '
      + 'content in; not a portal: it has no head and opens nothing. A zero-specificity floor the app\'s class refines.',
    interaction: 'None.',
    styles: [{ file: TOKEN_OWNER, classes: ['ak-panel'] }],
  },
  {
    name: 'SectionHeader',
    source: COMPONENTS,
    exportName: 'SectionHeader',
    importFrom: `${SPATIAL}primitives/index.ts`,
    purpose: 'A heading row inside a panel: the caller\'s own heading, glyphs and controls on one flex line, in their order.',
    interaction: 'None of its own; the controls inside it keep theirs.',
    styles: [{ file: TOKEN_OWNER, classes: ['ak-section-header'] }],
  },
  {
    name: 'SpatialFrame',
    source: `${SPATIAL}AppFrame.tsx`,
    exportName: 'AppFrame',
    importFrom: '@deepseek-ai/dsh-client-ui-layout/client (registered by the layout plugin as the root slot)',
    purpose: 'The three lanes (threads and conversation, the centre application, the right-hand menus), their hot corners, '
      + 'the menu tabs and the surface layer that hosts each application.',
    interaction: 'Hot corners change the Spatial presentation or the conversation depth; menu tabs switch the right-hand menu.',
    styles: [{ file: `${SPATIAL}SpatialFrame.module.css`, whole: true }],
  },
  {
    name: 'Conversation',
    source: 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
    exportName: 'ConversationRoot',
    importFrom: '@deepseek-ai/dsh-client-ui-conversation (the `main` slot\'s `conversation` entry; SpatialFrame renders it '
      + 'in the left lane through `renderSlot(\'main\', {}, { entryKey: \'conversation\' })`)',
    purpose: 'The transcript, the editor, the header tools and the bottom composer of one thread.',
    interaction: 'Neither a launcher nor a disclosure: its composer sends the owner\'s message to the open thread. Opening a '
      + 'thread authorises nothing.',
    styles: [{ file: 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css', whole: true }],
  },
]

/** One declared prop, or a whole inherited prop set. */
export interface PropLine {
  readonly name: string
  readonly optional: boolean
  readonly type: string
}

const flat = (text: string) => text.replace(/\s+/gu, ' ').trim()

type LocalTypes = Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>

function topLevelDeclarations(file: ts.SourceFile): LocalTypes {
  const out: LocalTypes = new Map()
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) out.set(statement.name.text, statement)
  }
  return out
}

function membersOf(members: ts.NodeArray<ts.TypeElement>, file: ts.SourceFile): PropLine[] {
  const out: PropLine[] = []
  for (const member of members) {
    if (ts.isPropertySignature(member)) {
      out.push({ name: flat(member.name.getText(file)), optional: member.questionToken !== undefined, type: flat(member.type?.getText(file) ?? 'unknown') })
    } else {
      out.push({ name: '…', optional: false, type: flat(member.getText(file)) })
    }
  }
  return out
}

function propsOfType(node: ts.TypeNode, file: ts.SourceFile, local: LocalTypes, seen: Set<string>): PropLine[] {
  if (ts.isParenthesizedTypeNode(node)) return propsOfType(node.type, file, local, seen)
  if (ts.isTypeLiteralNode(node)) return membersOf(node.members, file)
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(part => propsOfType(part, file, local, seen))
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined) {
    const name = node.typeName.text
    const declaration = local.get(name)
    if (declaration !== undefined && !seen.has(name)) {
      seen.add(name)
      if (ts.isTypeAliasDeclaration(declaration)) return propsOfType(declaration.type, file, local, seen)
      const inherited = (declaration.heritageClauses ?? []).flatMap(clause => clause.types.map(type => ({
        name: '(inherits)', optional: false, type: flat(type.getText(file)),
      })))
      return [...inherited, ...membersOf(declaration.members, file)]
    }
  }
  return [{ name: '(inherits)', optional: false, type: flat(node.getText(file)) }]
}

/**
 * The props an exported component function declares, read from its source text (syntax only, no type checker).
 * @param sourceText - the component file's text.
 * @param fileName - its name (for the parser's dialect).
 * @param exportName - the exported function.
 * @returns each declared prop, and each inherited prop set as one `(inherits)` line.
 */
export function propsOf(sourceText: string, fileName: string, exportName: string): PropLine[] {
  const file = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const local = topLevelDeclarations(file)
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== exportName) continue
    const exported = ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    if (!exported) throw new Error(`spatial-catalogue: ${exportName} in ${fileName} is not exported`)
    const parameter = statement.parameters[0]
    if (parameter === undefined) return []
    if (parameter.type === undefined) throw new Error(`spatial-catalogue: ${exportName} in ${fileName} has an untyped props parameter`)
    return propsOfType(parameter.type, file, local, new Set())
  }
  throw new Error(`spatial-catalogue: no exported function ${exportName} in ${fileName}`)
}

const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '')
const varsIn = (text: string) => [...text.matchAll(/var\(\s*(--[\w-]+)/gu)].map(match => match[1] ?? '')

/**
 * The custom properties a stylesheet's rules read for a component.
 * @param css - the stylesheet text.
 * @param scope - the class families whose rules count, or the whole file.
 * @returns the sorted, distinct custom property names.
 */
export function tokensRead(css: string, scope: StyleScope): string[] {
  const text = uncomment(css)
  if ('whole' in scope) return [...new Set(varsIn(text))].sort()
  const families = scope.classes.map(name => new RegExp(`\\.${name}(?:__|--|[^\\w-]|$)`, 'u'))
  const out = new Set<string>()
  for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (families.some(family => family.test(selectors ?? ''))) for (const name of varsIn(body ?? '')) out.add(name)
  }
  return [...out].sort()
}

/**
 * The contract tokens as declared in the one `:root` block of the owner stylesheet.
 * @param css - `primitives.css`.
 * @returns name and value, in declaration order.
 */
export function rootTokens(css: string): (readonly [string, string])[] {
  const blocks = [...uncomment(css).matchAll(/:root\s*\{([^}]*)\}/gu)]
  if (blocks.length !== 1) throw new Error(`spatial-catalogue: ${TOKEN_OWNER} must have exactly one :root block`)
  return [...(blocks[0]?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(([, name, value]) => [name ?? '', flat(value ?? '')] as const)
}

/** The tokens of spec 5's table (the portal and header contract); the rest of `:root` is palette and radii. */
const CONTRACT_FIRST = '--ak-portal-header-height'
const CONTRACT_LAST = '--ak-corner-clearance'

const cell = (text: string) => text.replace(/\|/gu, '\\|')
/** Inline code that survives a backtick inside it (a template-literal type). */
const code = (text: string) => (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``)

/**
 * Render the catalogue.
 * @param read - reads a repository-relative file.
 * @returns the Markdown text of `docs/foundations/SPATIAL-CATALOGUE.md`.
 */
export function renderCatalogue(read: (path: string) => string): string {
  const root = rootTokens(read(TOKEN_OWNER))
  const values = new Map(root)
  const first = root.findIndex(([name]) => name === CONTRACT_FIRST)
  const last = root.findIndex(([name]) => name === CONTRACT_LAST)
  if (first === -1 || last < first) throw new Error('spatial-catalogue: the contract tokens are missing from :root')
  const lines: string[] = [
    '# Spatial catalogue',
    '',
    '<!-- GENERATED by scripts/spatial-catalogue.ts from the component and token owners. Do not edit by hand:',
    '     ./node_modules/.bin/tsx scripts/spatial-catalogue.ts --write -->',
    '',
    'The supported native Spatial components (Spatial design spec 11, the smallest true version). Use these; do not',
    'start a third component family, restyle one per app, or reorder a header in CSS. Rules and measurements:',
    '`docs/foundations/SPATIAL-DESIGN-RULES.md` (rule 10). This catalogue describes UI only: it grants no tools,',
    'signing, enrolment, memory or code execution.',
    '',
    `## Contract tokens (owner: \`${TOKEN_OWNER}\`, \`:root\`)`,
    '',
    '| Token | Value |',
    '|---|---|',
    ...root.slice(first, last + 1).map(([name, value]) => `| \`${name}\` | \`${cell(value)}\` |`),
    '',
  ]
  for (const entry of CATALOGUE) {
    const props = propsOf(read(entry.source), entry.source, entry.exportName)
    const tokens = [...new Set(entry.styles.flatMap(scope => tokensRead(read(scope.file), scope)))].sort()
    lines.push(
      `## ${entry.name}`,
      '',
      `- Source: \`${entry.source}\` (\`${entry.exportName}\`)`,
      `- Import: ${entry.importFrom.startsWith('@') ? entry.importFrom : `\`${entry.importFrom}\``}`,
      `- Purpose: ${entry.purpose}`,
      `- Interaction: ${entry.interaction}`,
      `- Styles read from: ${entry.styles.map(scope => `\`${scope.file}\`${'whole' in scope ? '' : ` (${scope.classes.map(name => `.${name}`).join(', ')})`}`).join('; ')}`,
      '',
      'Props:',
      '',
      ...(props.length === 0 ? ['- (none)'] : props.map(prop => prop.name === '(inherits)'
        ? `- (inherits) ${code(prop.type)}`
        : `- ${code(`${prop.name}${prop.optional ? '?' : ''}`)}: ${code(prop.type)}`)),
      '',
      'Custom properties read:',
      '',
      ...(tokens.length === 0 ? ['- (none)'] : tokens.map((name) => {
        const value = values.get(name)
        return value === undefined ? `- \`${name}\`` : `- \`${name}\` = \`${value}\``
      })),
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

const readRepository = (path: string) => readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8')

function main(argv: readonly string[]): number {
  const text = renderCatalogue(readRepository)
  const target = resolve(REPOSITORY_ROOT, CATALOGUE_PATH)
  if (argv.includes('--write')) {
    writeFileSync(target, text)
    return 0
  }
  if (argv.includes('--check')) {
    if (readFileSync(target, 'utf8') === text) return 0
    process.stderr.write(`${CATALOGUE_PATH} is stale: run ./node_modules/.bin/tsx scripts/spatial-catalogue.ts --write\n`)
    return 1
  }
  process.stdout.write(text)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
