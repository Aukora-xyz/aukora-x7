/**
 * Aukora X5: `execa` for the worker host. No processes exist here, so only the package-manager
 * commands the plugin manager issues are emulated, over the VFS, for LOCAL bundles:
 *   pnpm add <abs dir | file:dir | link:dir> [flags]  copy the directory into <cwd>/node_modules/<name>
 *                                                     and save "<name>": "link:<relative dir>" as pnpm does;
 *                                                     its dependencies must already resolve (profile or /dsh/node_modules).
 *   pnpm remove <name...>                             drop the dependency and its node_modules copy.
 *   pnpm install                                      succeeds when every direct dependency is present.
 *   pnpm config get registry / pnpm view ...          answer "unavailable" (exit 1), so registry specs fail cleanly.
 * Anything else (registry, git, tarball installs; other commands) exits 1 with a diagnostic.
 */
import * as fs from '../builtin_modules/implemented/fs.ts'
import { dirname, join, relative, resolve } from '../builtin_modules/implemented/path.ts'
import { EventEmitter } from '../builtin_modules/implemented/events.ts'

export const __esModule = true

interface Outcome { exitCode: number; stdout: string; stderr: string }
const ok = (stdout = ''): Outcome => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): Outcome => ({ exitCode: 1, stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n' })

const readJson = (path: string): Record<string, any> => JSON.parse(String(fs.readFileSync(path, 'utf8'))) as Record<string, any>
function writeJson(path: string, value: unknown): void { fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true }) as fs.Dirent[]) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const src = join(from, entry.name), dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else fs.writeFileSync(dst, fs.readFileSync(src) as Uint8Array)
  }
}

/** A dependency resolves when some ancestor node_modules of `fromDir` holds it. */
function resolves(name: string, fromDir: string): boolean {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (fs.existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    if (dirname(dir) === dir) return false
  }
}

function pnpm(args: string[], cwd: string): Outcome {
  const [command, ...rest] = args
  const operands = rest.filter(a => !a.startsWith('-'))
  const manifestPath = join(cwd, 'package.json')
  if (command === 'config' || command === 'view' || command === 'info') return fail(`web-preview: pnpm ${command} has no registry in the worker host`)
  if (command === 'install' || command === 'i') {
    if (operands.length > 0) return pnpm(['add', ...rest], cwd)
    const deps = readJson(manifestPath).dependencies ?? {}
    const missing = Object.keys(deps).filter(n => !fs.existsSync(join(cwd, 'node_modules', n, 'package.json')))
    return missing.length === 0 ? ok('Already up to date (web-preview)\n') : fail(`web-preview: cannot install ${missing.join(', ')} without pnpm; only local bundles can be added`)
  }
  if (command === 'add') {
    if (operands.length === 0) return fail('web-preview: pnpm add needs a spec')
    const manifest = readJson(manifestPath)
    const added: string[] = []
    for (const spec of operands) {
      const path = spec.replace(/^(file|link):/, '')
      if (!path.startsWith('/')) return fail(`web-preview: only local directory bundles can be installed in the worker host (got ${spec})`)
      const src = resolve(cwd, path)
      if (!fs.existsSync(join(src, 'package.json'))) return fail(`web-preview: ${src} has no package.json`)
      const pkg = readJson(join(src, 'package.json'))
      if (typeof pkg.name !== 'string' || pkg.name === '') return fail(`web-preview: ${src}/package.json has no name`)
      const target = join(cwd, 'node_modules', pkg.name)
      const needed = Object.keys({ ...pkg.dependencies ?? {}, ...pkg.peerDependencies ?? {} })
      const missing = needed.filter(n => !resolves(n, dirname(target)))
      if (missing.length > 0) return fail(`web-preview: ${pkg.name} needs ${missing.join(', ')}, which is not present in the profile or /dsh/node_modules`)
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      copyTree(src, target)
      manifest.dependencies = { ...manifest.dependencies ?? {}, [pkg.name]: 'link:' + relative(cwd, src) }
      added.push(`+ ${pkg.name} ${String(pkg.version ?? '')} <- ${src}`)
    }
    writeJson(manifestPath, manifest)
    return ok(`web-preview: copied local bundle into node_modules\n${added.join('\n')}\n`)
  }
  if (command === 'remove' || command === 'rm' || command === 'uninstall') {
    const manifest = readJson(manifestPath)
    for (const name of operands) {
      if (manifest.dependencies) delete manifest.dependencies[name]
      fs.rmSync(join(cwd, 'node_modules', name), { recursive: true, force: true })
    }
    writeJson(manifestPath, manifest)
    return ok(operands.map(n => `- ${n}`).join('\n') + '\n')
  }
  return fail(`web-preview: pnpm ${String(command)} is not available in the worker host`)
}

function chunks(text: string) {
  let destroyed = false
  return {
    destroy() { destroyed = true },
    async *[Symbol.asyncIterator]() { if (!destroyed && text !== '') yield text },
  }
}

/** execa(file, args, options): a promise of the result that is also the child (stdout/stderr, nodeChildProcess, kill). */
export function execa(file: string, args: readonly string[] = [], options: Record<string, any> = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : '/'
  const name = file.split('/').pop() ?? file
  const node = new EventEmitter()
  let outcome: Outcome
  try {
    outcome = /pnpm/.test(name) ? pnpm([...args], cwd) : fail(`web-preview: ${file} cannot run in the worker host`)
  } catch (error) {
    outcome = fail(`web-preview: ${String(error instanceof Error ? error.message : error)}`)
  }
  const command = [file, ...args].join(' ')
  const result = {
    command, escapedCommand: command, cwd, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr,
    all: outcome.stdout + outcome.stderr, failed: outcome.exitCode !== 0, timedOut: false, isCanceled: false,
    killed: false, signal: undefined, shortMessage: outcome.exitCode === 0 ? '' : `Command failed with exit code 1: ${command}\n${outcome.stderr}`,
  }
  const piped = options.buffer === false
  const promise = new Promise<typeof result>((res) => { setTimeout(() => { node.emit('exit', outcome.exitCode, null); res(result) }, 0) })
  return Object.assign(promise, {
    pid: undefined, nodeChildProcess: node, kill: () => false,
    stdout: piped ? chunks(outcome.stdout) : null, stderr: piped ? chunks(outcome.stderr) : null,
  })
}
export const execaNode = execa
export default { execa, execaNode }
