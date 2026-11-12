/**
 * Aukora X5: `rg`, the ripgrep subset the fs-search tools (`glob`, `grep`) and
 * shell users need, in JavaScript over the shell filesystem.
 *
 * Supported: `--files`, `--json`, `--regexp=P`/`-e P`, positional pattern,
 * `--glob=G`/`-g G` (last match wins, `!` negates, trailing `/` = directories
 * only, slash-less globs match basenames), `--hidden`, `--no-ignore` (accepted;
 * no .gitignore support), `--no-config`, `--sort=modified|path`, `-i`, `-F`,
 * `-n`, `-l`, `--`. Hidden entries are skipped without `--hidden`; `.git` and
 * NUL-containing (binary) files are always skipped for content search.
 * Exit status: 0 found, 1 nothing found, 2 error.
 */
import picomatch from 'picomatch'
import { resolveIn } from '../fs-access.ts'
import type { ShellProgram } from '../types.ts'

interface Glob { readonly negated: boolean; readonly dirOnly: boolean; readonly test: (path: string) => boolean }

function compileGlob(raw: string): Glob {
  let text = raw
  const negated = text.startsWith('!')
  if (negated) text = text.slice(1)
  const dirOnly = text.endsWith('/')
  if (dirOnly) text = text.slice(0, -1)
  if (text.startsWith('/')) text = text.slice(1)
  const anchored = text.includes('/')
  const match = picomatch(text, { dot: true })
  return {
    negated, dirOnly,
    test: (path: string) => match(path) || (!anchored && match(path.slice(path.lastIndexOf('/') + 1))),
  }
}

/** ripgrep override semantics: last matching glob decides; with any whitelist glob, unmatched files are excluded. */
function verdict(globs: readonly Glob[], rel: string, directory: boolean): boolean {
  for (let index = globs.length - 1; index >= 0; index -= 1) {
    const glob = globs[index] as Glob
    if (glob.dirOnly && !directory) continue
    if (glob.test(rel)) return !glob.negated
  }
  return directory || !globs.some(glob => !glob.negated)
}

export const rg: ShellProgram = async (argv, io, state, fs) => {
  const globs: Glob[] = []
  const operands: string[] = []
  let files = false, json = false, hidden = false, ignoreCase = false, fixed = false, numbers = false, listOnly = false
  let sort: string | undefined
  let pattern: string | undefined
  const words = argv.slice(1)
  try {
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] as string
      const value = (flag: string): string | undefined => {
        if (word.startsWith(flag + '=')) return word.slice(flag.length + 1)
        if (word === flag) { index += 1; return words[index] }
        return undefined
      }
      if (word === '--') { operands.push(...words.slice(index + 1)); break }
      if (word === '--files') files = true
      else if (word === '--json') json = true
      else if (word === '--hidden' || word === '-.') hidden = true
      else if (word === '--no-ignore' || word === '--no-config' || word === '--no-messages') { /* accepted */ }
      else if (word === '-i' || word === '--ignore-case') ignoreCase = true
      else if (word === '-F' || word === '--fixed-strings') fixed = true
      else if (word === '-n' || word === '--line-number') numbers = true
      else if (word === '-l' || word === '--files-with-matches') listOnly = true
      else if (word.startsWith('--sort')) sort = value('--sort')
      else if (word.startsWith('--regexp') || word === '-e') pattern = word === '-e' ? words[++index] : value('--regexp')
      else if (word.startsWith('--glob') || word === '-g') {
        const glob = word === '-g' ? words[++index] : value('--glob')
        if (glob === undefined) throw new Error('--glob needs a value')
        globs.push(compileGlob(glob))
      } else if (word.startsWith('-') && word.length > 1) throw new Error(`unsupported flag ${word}`)
      else operands.push(word)
    }
    if (!files && pattern === undefined) pattern = operands.shift()
    if (!files && pattern === undefined) throw new Error('no pattern given')
  } catch (error) {
    io.err(`rg: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  let regex: RegExp
  try {
    const source = fixed ? (pattern ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : (pattern ?? '')
    regex = new RegExp(source, ignoreCase ? 'gi' : 'g')
  } catch (error) {
    io.err(`rg: regex parse error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const roots = operands.length > 0 ? operands : [undefined]
  const found: { display: string; abs: string; mtimeMs: number }[] = []
  let errors = 0
  const walk = async (abs: string, display: string, rel: string, top: boolean): Promise<void> => {
    if (state.signal?.aborted === true) throw new Error('aborted')
    const stats = await fs.stat(abs)
    if (stats === undefined) { io.err(`rg: ${display}: No such file or directory (os error 2)\n`); errors += 1; return }
    if (stats.directory) {
      if (!top && !verdict(globs, rel, true)) return
      for (const entry of await fs.list(abs)) {
        if (!hidden && entry.name.startsWith('.')) continue
        if (entry.name === '.git' || (abs === '/dsh' && entry.name === 'node_modules')) continue
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        const childDisplay = display === '' ? entry.name : `${display.replace(/\/$/, '')}/${entry.name}`
        await walk(`${abs.replace(/\/$/, '')}/${entry.name}`, childDisplay, childRel, false)
      }
      return
    }
    if (top || verdict(globs, rel, false)) found.push({ display, abs, mtimeMs: stats.mtimeMs })
  }
  for (const root of roots) {
    const abs = resolveIn(state.cwd, root ?? '.')
    await walk(abs, root ?? '', root === undefined ? '' : '', true)
  }
  if (sort === 'modified') found.sort((a, b) => a.mtimeMs - b.mtimeMs)
  else if (sort === 'path') found.sort((a, b) => (a.display < b.display ? -1 : 1))
  if (files) {
    for (const file of found) io.out(`${file.display}\n`)
    return errors > 0 ? 2 : found.length > 0 ? 0 : 1
  }
  let matched = 0
  for (const file of found) {
    let text: string
    try { text = await fs.readText(file.abs) } catch { continue }
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    let offset = 0
    let fileHits = 0
    for (const [index, line] of lines.entries()) {
      if (index === lines.length - 1 && line === '') break
      regex.lastIndex = 0
      const submatches: { match: { text: string }; start: number; end: number }[] = []
      for (let hit = regex.exec(line); hit !== null; hit = regex.exec(line)) {
        submatches.push({ match: { text: hit[0] }, start: hit.index, end: hit.index + hit[0].length })
        if (hit[0].length === 0) regex.lastIndex += 1
      }
      if (submatches.length > 0) {
        if (fileHits === 0 && json) io.out(JSON.stringify({ type: 'begin', data: { path: { text: file.display } } }) + '\n')
        fileHits += 1
        if (json) {
          io.out(JSON.stringify({ type: 'match', data: { path: { text: file.display }, lines: { text: line + '\n' }, line_number: index + 1, absolute_offset: offset, submatches } }) + '\n')
        } else if (!listOnly) {
          io.out(`${file.display === '' ? '' : file.display + ':'}${numbers ? String(index + 1) + ':' : ''}${line}\n`)
        }
      }
      offset += line.length + 1
    }
    if (fileHits > 0) {
      matched += 1
      if (json) io.out(JSON.stringify({ type: 'end', data: { path: { text: file.display } } }) + '\n')
      else if (listOnly) io.out(`${file.display}\n`)
    }
  }
  return errors > 0 ? 2 : matched > 0 ? 0 : 1
}
