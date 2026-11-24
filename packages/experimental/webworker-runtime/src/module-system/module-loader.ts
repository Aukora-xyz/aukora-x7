/**
 * CommonJS module loader over the worker VFS. It backs the Node internal ESM
 * loader that `node-addon-require-builtin` answers, which Cordis's Loader uses
 * for every entry import, and the `node:module` `createRequire` proxy that
 * `typert-loader`, `client-modules`, and the plugin package inventory resolve
 * package metadata through.
 *
 * Resolution is a narrowed Node `require` algorithm: `exports` walk with a
 * fixed condition order, extension probing, and a byte-validated cache keyed by
 * canonical VFS path. Changed files reload on their next load, without replacing
 * exports already held by dependents. Content-addressed ball paths are verified
 * before evaluation or cache reuse; explicit `ball:` imports evaluate afresh.
 * User modules can fall back to runtime ESM lowering.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader
 */
import { createAlsRuntime, type AlsCausality, type AlsRuntime } from '../polyfill/async-context/als-runtime.ts'
import { createCascadedLoader, type CascadedLoader } from '../node/internal_modules/esm-loader.ts'
import { dirname, fileUrlToPath, isAbsolute, join, pathToFileUrl, resolve as resolvePath } from './posix-path.ts'
import { WRAPPER_PARAMS } from '../image-layout.ts'
import type { MemoryVfs } from '../storage/memory.ts'

/** Condition keys honoured in `exports`, in order; `node` is deliberately absent. */
export const DEFAULT_CONDITIONS = ['browser', 'require', 'import', 'default'] as const

/** Extensions probed when a specifier has no usable one. */
const EXTENSIONS = ['.js', '.json', '.mjs', '.cjs'] as const

type ExportsField = string | null | readonly ExportsField[] | { readonly [key: string]: ExportsField }

interface PackageManifest {
  readonly name?: string
  readonly main?: string
  readonly exports?: ExportsField
}

/**
 * One entry of the static-module table. The loader calls it when a `require`
 * names that specifier and never before, so resolution alone — `require.resolve`
 * or `import.meta.resolve` — evaluates nothing. Repeated requires of one
 * specifier must answer the same module instance: callers depend on class
 * identity across requires (`instanceof EventEmitter`, `Buffer.isBuffer`), so a
 * factory that builds its value has to memoize it.
 * @returns The module object served for that specifier.
 */
export type StaticModuleFactory = () => unknown

/** Where a specifier resolved to. */
export type Resolution =
  | { readonly kind: 'static'; readonly specifier: string; readonly factory: StaticModuleFactory }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'ball'; readonly sha: string; readonly path: string }

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256WordAt(words: Uint32Array, index: number): number {
  const word = words[index]
  if (word === undefined) throw new RangeError(`SHA-256 word index out of range: ${index}`)
  return word
}

export function sha256HexSync(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const bitLen = bytes.length * 8
  const padLen = ((bytes.length + 9 + 63) & ~63)
  const buf = new Uint8Array(padLen)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padLen - 4, bitLen >>> 0, false)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false)
    for (let j = 16; j < 64; j++) {
      const word15 = sha256WordAt(w, j - 15)
      const word2 = sha256WordAt(w, j - 2)
      const s0 = rotr(word15, 7) ^ rotr(word15, 18) ^ (word15 >>> 3)
      const s1 = rotr(word2, 17) ^ rotr(word2, 19) ^ (word2 >>> 10)
      w[j] = (sha256WordAt(w, j - 16) + s0 + sha256WordAt(w, j - 7) + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + sha256WordAt(SHA256_K, j) + sha256WordAt(w, j)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('')
}

/**
 * Lightweight runtime ESM-to-CJS lowering for agent-authored `ball:<sha>` and workspace plugins (and, since Lane E3,
 * `.mjs` modules and `node` entry scripts). Each statement is matched within its own line: a pattern never consumes the
 * line break after a semicolon-less import, so consecutive imports all lower and line numbers are preserved.
 */
export function lowerEsmRuntime(code: string): string {
  const exportedNames: string[] = []
  let impSeq = 0
  let out = code
    .replace(/^[ \t]*import\s+type\s+[^;\n]+;?/gm, '')
    .replace(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"][^'"]+['"])[ \t]*;?/gm, 'const $1 = require($2);')
    .replace(/^[ \t]*import\s+\{([^}]+)\}\s+from\s+(['"][^'"]+['"])[ \t]*;?/gm, (_m, spec: string, pkg: string) => {
      const bindings = spec.replace(/\btype\s+[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?/g, '')
        .replace(/\s+as\s+/g, ': ').trim()
      return bindings ? `const { ${bindings} } = require(${pkg});` : `require(${pkg});`
    })
    .replace(
      /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from\s+(['"][^'"]+['"])[ \t]*;?/gm,
      (_m, def: string, spec: string, pkg: string) => {
        const id = `__x6_imp_${String(++impSeq)}`
        const bindings = spec.replace(/\s+as\s+/g, ': ').trim()
        return `const ${id} = require(${pkg}); const ${def} = ${id}?.default ?? ${id}; const { ${bindings} } = ${id};`
      },
    )
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"][^'"]+['"])[ \t]*;?/gm, (_m, def: string, pkg: string) => {
      const id = `__x6_imp_${String(++impSeq)}`
      return `const ${id} = require(${pkg}); const ${def} = ${id}?.default ?? ${id};`
    })
    .replace(/^[ \t]*import\s+(['"][^'"]+['"])[ \t]*;?/gm, 'require($1);')
    .replace(/^[ \t]*export\s+default\s+/gm, 'exports.default = ')
    .replace(/^[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw: string, id: string) => {
      exportedNames.push(id)
      return `${kw} ${id}`
    })
    .replace(/^[ \t]*export\s+(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw: string, id: string) => {
      exportedNames.push(id)
      return `${kw} ${id}`
    })
    .replace(/^[ \t]*export\s*\{([^}]+)\}[ \t]*;?/gm, (_m, list: string) => {
      return list.split(',').map(part => part.trim()).filter(Boolean).map((item) => {
        const [local, exported] = item.split(/\s+as\s+/).map(s => s.trim())
        return `exports.${exported ?? local} = ${local};`
      }).join(' ')
    })
    // Aukora X6.1 Lane E3: `import.meta` is the wrapper's `__dsh$meta` ({ url, resolve }), as the image packer emits it.
    .replace(/\bimport\.meta\b/g, '__dsh$meta')
  if (exportedNames.length > 0 || out !== code) {
    const tail = exportedNames.map(n => `exports.${n} = ${n};`).join(' ')
    out = `Object.defineProperty(exports, "__esModule", { value: true });\n${out}\n${tail}\n`
  }
  return out
}

/** Node-loader-compatible resolution returned through the Cordis internal seam. */
export interface WorkerInternalResolution {
  readonly format: 'builtin' | 'commonjs' | 'json'
  /** File URL for VFS modules; the original bare specifier for builtins. */
  readonly url: string
}

interface ModuleRecord {
  readonly module: { exports: unknown }
  readonly bytes: Uint8Array
}

/** Resolution helpers carried by a Worker-backed CommonJS require. */
export interface WorkerRequireResolve {
  /**
   * Resolve one specifier without evaluating its module.
   * @param specifier - Module request relative to the require base.
   * @returns Static or VFS-backed module identity.
   */
  (specifier: string): string
  /**
   * Return the directories this loader's Node-style package discovery searches.
   * @param specifier - Module request whose lookup roots are requested.
   * @returns Search roots, or null for a Worker-provided module.
   */
  paths(specifier: string): string[] | null
}

/** The `require` function shape the roster consumes through `createRequire`. */
export interface WorkerRequire {
  (specifier: string): unknown
  readonly resolve: WorkerRequireResolve
}

/** Construction inputs for {@link WorkerModuleLoader}. */
export interface WorkerModuleLoaderOptions {
  /** Filesystem holding package metadata and module sources. */
  readonly vfs: MemoryVfs
  /** Virtual root whose `node_modules` bare specifiers resolve against. */
  readonly root?: string
  /**
   * Modules served from the worker bundle instead of the VFS: `node:*` proxies
   * and the loud stubs for excluded npm packages, each behind a
   * {@link StaticModuleFactory}.
   */
  readonly staticModules: Readonly<Record<string, StaticModuleFactory>>
  /**
   * Prefix-matched proxies for packages whose subpaths are open-ended: a
   * specifier starting with the key resolves to its module. Exact keys win, and
   * the longest matching prefix wins among prefixes.
   */
  readonly staticModulePrefixes?: Readonly<Record<string, StaticModuleFactory>>
  /** Overrides {@link DEFAULT_CONDITIONS}. */
  readonly conditions?: readonly string[]
  /**
   * Ambient-store snapshot face for the suspended `rewrite-await` route; it is
   * read only when that route is the configured {@link lowering}.
   */
  readonly alsCausality?: AlsCausality
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Loader for one VFS mount; construct once per worker. */
export class WorkerModuleLoader {
  private readonly vfs: MemoryVfs
  private readonly root: string
  private readonly staticModules: ReadonlyMap<string, StaticModuleFactory>
  private readonly staticPrefixes: ReadonlyArray<readonly [string, StaticModuleFactory]>
  private readonly conditions: ReadonlySet<string>
  private readonly als: AlsRuntime
  private readonly modules = new Map<string, ModuleRecord>()
  private readonly manifests = new Map<string, PackageManifest>()
  private readonly stack: string[] = []
  private cascaded: CascadedLoader | undefined

  /**
   * Resolution and loading over this mount, in Node's v1 argument order. The cascaded ESM loader
   * ({@link cascadedLoader}) and the packer call it; `parentURL` positions relative specifiers and import attributes
   * are ignored.
   */
  readonly internal: {
    readonly version: 'worker'
    import(specifier: string, parentURL?: string, attributes?: unknown): Promise<unknown>
    resolve(specifier: string, parentURL?: string, attributes?: unknown): Promise<WorkerInternalResolution>
    resolveSync(specifier: string, parentURL?: string, attributes?: unknown): WorkerInternalResolution
  }

  constructor(options: WorkerModuleLoaderOptions) {
    this.vfs = options.vfs
    this.root = resolvePath(options.root ?? '/dsh', '.')
    // A Map, not the record itself: a specifier that names an Object prototype
    // member must miss the table the way any other unregistered name does.
    this.staticModules = new Map(Object.entries(options.staticModules))
    this.staticPrefixes = Object.entries(options.staticModulePrefixes ?? {})
      .sort(([left], [right]) => right.length - left.length)
    this.conditions = new Set(options.conditions ?? DEFAULT_CONDITIONS)
    this.als = createAlsRuntime(options.alsCausality)
    const resolveInternal = (specifier: string, parentURL?: string): WorkerInternalResolution => {
      const from = parentURL === undefined ? this.root : this.baseDirectoryOf(parentURL)
      const resolution = this.resolve(specifier, from)
      if (resolution.kind === 'static') return { format: 'builtin', url: resolution.specifier }
      return {
        format: resolution.path.endsWith('.json') ? 'json' : 'commonjs',
        url: pathToFileUrl(resolution.path),
      }
    }
    this.internal = {
      version: 'worker',
      import: async (specifier: string, parentURL?: string): Promise<unknown> => {
        const from = parentURL === undefined ? this.root : this.baseDirectoryOf(parentURL)
        return this.load(this.resolve(specifier, from))
      },
      resolve: async (specifier: string, parentURL?: string) => resolveInternal(specifier, parentURL),
      resolveSync: resolveInternal,
    }
  }

  /**
   * The `internal/modules/esm/loader` cascaded loader over this mount, created on first use.
   * @returns This loader's one cascaded loader.
   */
  cascadedLoader(): CascadedLoader {
    return this.cascaded ??= createCascadedLoader(this.internal)
  }

  /**
   * Throw this loader's diagnostic.
   * @param detail - What failed.
   * @param code - Node error code for a resolution failure Node also reports by code.
   */
  private fail(detail: string, code?: 'MODULE_NOT_FOUND' | 'ERR_PACKAGE_PATH_NOT_EXPORTED'): never {
    const chain = this.stack.length === 0 ? '' : ` (importer chain: ${this.stack.join(' -> ')})`
    const error = new Error(`webworker modules: ${detail}${chain}`)
    throw code === undefined ? error : Object.assign(error, { code })
  }

  /** @returns Directory a base path or URL resolves specifiers from. */
  private baseDirectoryOf(base: string | URL): string {
    const text = typeof base === 'string' ? base : base.href
    const path = text.startsWith('file://') ? fileUrlToPath(text) : text
    if (path.endsWith('/')) return resolvePath(path)
    return this.vfs.existsSync(path) && this.vfs.statSync(path).isDirectory() ? resolvePath(path) : dirname(path)
  }

  private manifestOf(directory: string): PackageManifest {
    const cached = this.manifests.get(directory)
    if (cached !== undefined) return cached
    const path = join(directory, 'package.json')
    const text = this.vfs.readFileSync(path, 'utf8') as string
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (reason) {
      this.fail(`${path} is not valid JSON: ${(reason as Error).message}`)
    }
    if (!isRecord(parsed)) this.fail(`${path} does not hold an object`)
    const manifest = parsed as PackageManifest
    this.manifests.set(directory, manifest)
    return manifest
  }

  /** Walk one `exports` value against the condition set and requested subpath. */
  private selectExport(field: ExportsField, subpath: string, packageName: string): string | undefined {
    if (field === null) return undefined
    if (typeof field === 'string') return subpath === '.' ? field : undefined
    if (Array.isArray(field)) {
      for (const candidate of field as readonly ExportsField[]) {
        const picked = this.selectExport(candidate, subpath, packageName)
        if (picked !== undefined) return picked
      }
      return undefined
    }
    const entries = Object.entries(field as { [key: string]: ExportsField })
    const isSubpathMap = entries.some(([key]) => key === '.' || key.startsWith('./'))
    if (!isSubpathMap) {
      if (subpath !== '.') return undefined
      return this.selectCondition(field, packageName)
    }
    for (const [key, value] of entries) {
      if (key === subpath) {
        return typeof value === 'string' ? value : this.selectCondition(value, packageName, subpath)
      }
    }
    for (const [key, value] of entries) {
      const star = key.indexOf('*')
      if (star < 0) continue
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length)
      const target = typeof value === 'string' ? value : this.selectCondition(value, packageName, subpath)
      if (target !== undefined) return target.replaceAll('*', captured)
    }
    return undefined
  }

  /** Pick the first condition branch this runtime satisfies. */
  private selectCondition(field: ExportsField, packageName: string, subpath = '.'): string | undefined {
    if (field === null) return undefined
    if (typeof field === 'string') return field
    if (Array.isArray(field)) {
      for (const candidate of field as readonly ExportsField[]) {
        const picked = this.selectCondition(candidate, packageName, subpath)
        if (picked !== undefined) return picked
      }
      return undefined
    }
    for (const [key, value] of Object.entries(field as { [key: string]: ExportsField })) {
      if (!this.conditions.has(key)) continue
      const picked = this.selectCondition(value, packageName, subpath)
      if (picked !== undefined) return picked
    }
    return undefined
  }

  /** Extension and directory probing for a concrete path. */
  private probe(path: string, specifier: string): string {
    path = resolvePath(path, '.')
    const candidates: string[] = [path, ...EXTENSIONS.map(extension => path + extension)]
    for (const candidate of candidates) {
      if (this.vfs.existsSync(candidate) && this.vfs.statSync(candidate).isFile()) return candidate
      this.modules.delete(candidate)
    }
    if (this.vfs.existsSync(path) && this.vfs.statSync(path).isDirectory()) {
      if (this.vfs.existsSync(join(path, 'package.json'))) {
        const main = this.manifestOf(path).main
        if (main !== undefined) return this.probe(join(path, main), specifier)
      }
      return this.probe(join(path, 'index'), specifier)
    }
    return this.fail(`cannot resolve "${specifier}": no file at ${candidates.join(', ')}`, 'MODULE_NOT_FOUND')
  }

  /** @returns The Worker-provided implementation of a static specifier. */
  private staticModule(specifier: string): StaticModuleFactory | undefined {
    const exact = this.staticModules.get(specifier)
    if (exact !== undefined) return exact
    for (const [prefix, factory] of this.staticPrefixes) {
      if (specifier.startsWith(prefix)) return factory
    }
    return this.staticModules.get(`node:${specifier}`)
  }

  /**
   * Resolve a specifier the way the module that requested it would.
   * @param specifier - Bare name, relative path, absolute path, or file URL.
   * @param fromDirectory - Directory of the requesting module.
   * @returns Static module or the resolved VFS path.
   */
  resolve(specifier: string, fromDirectory: string): Resolution {
    if (specifier.startsWith('ball:')) {
      const sha = specifier.slice(5).trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        return this.fail(`invalid ball:<sha256> specifier "${specifier}"`, 'MODULE_NOT_FOUND')
      }
      const ballPath = join(this.root, 'home/balls', `${sha}.js`)
      if (!this.vfs.existsSync(ballPath) || !this.vfs.statSync(ballPath).isFile()) {
        this.modules.delete(ballPath)
        return this.fail(`cannot resolve "${specifier}": no file at ${ballPath}`, 'MODULE_NOT_FOUND')
      }
      return { kind: 'ball', sha, path: ballPath }
    }
    const staticModule = this.staticModule(specifier)
    if (staticModule !== undefined) return { kind: 'static', specifier, factory: staticModule }
    if (specifier.startsWith('cordis:') || specifier.startsWith('node:')) {
      return this.fail(`no static module is registered for "${specifier}"`)
    }
    if (specifier.startsWith('file://')) {
      return { kind: 'file', path: this.probe(fileUrlToPath(specifier), specifier) }
    }
    if (specifier.startsWith('.')) {
      return { kind: 'file', path: this.probe(join(fromDirectory, specifier), specifier) }
    }
    if (isAbsolute(specifier)) {
      return { kind: 'file', path: this.probe(specifier, specifier) }
    }
    const segments = specifier.split('/')
    const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? specifier
    const rest = specifier.slice(packageName.length).replace(/^\//, '')
    // Aukora X5: Node's ancestor lookup, so profile-installed packages (<profile>/node_modules) resolve; the image root last.
    const imageDirectory = join(this.root, 'node_modules', packageName)
    const packageDirectory = this.searchPaths(fromDirectory).map(dir => join(dir, packageName))
      .find(dir => this.vfs.existsSync(join(dir, 'package.json'))) ?? imageDirectory
    if (!this.vfs.existsSync(join(packageDirectory, 'package.json'))) {
      return this.fail(`cannot resolve "${specifier}": ${packageDirectory}/package.json is not in the image`, 'MODULE_NOT_FOUND')
    }
    const manifest = this.manifestOf(packageDirectory)
    const subpath = rest === '' ? '.' : `./${rest}`
    if (manifest.exports !== undefined) {
      const target = this.selectExport(manifest.exports, subpath, packageName)
      if (target === undefined) {
        return this.fail(
          `"${packageName}" does not export "${subpath}" under conditions [${[...this.conditions].join(', ')}]`,
          'ERR_PACKAGE_PATH_NOT_EXPORTED',
        )
      }
      return { kind: 'file', path: this.probe(join(packageDirectory, target), specifier) }
    }
    const legacy = subpath === '.' ? manifest.main ?? 'index.js' : rest
    return { kind: 'file', path: this.probe(join(packageDirectory, legacy), specifier) }
  }

  /** Evict cached modules and package manifests under a VFS path or prefix for live hot-swap. */
  evict(prefix?: string): void {
    if (prefix === undefined) {
      this.modules.clear()
      this.manifests.clear()
      return
    }
    for (const key of this.modules.keys()) {
      if (key === prefix || key.startsWith(prefix + '/')) this.modules.delete(key)
    }
    for (const key of this.manifests.keys()) {
      if (key === prefix || key.startsWith(prefix + '/')) this.manifests.delete(key)
    }
  }

  /**
   * Load current VFS bytes, preserving cached identity while they are unchanged
   * and CommonJS partial exports during evaluation. A changed dependency does
   * not re-evaluate its cached importers. Missing, failed and corrupt entries
   * are discarded; ball integrity is checked before cache reuse, with case-insensitive hex filenames.
   * @param resolution - Result of {@link resolve}.
   * @returns The module's exports.
   */
  load(resolution: Resolution): unknown {
    if (resolution.kind === 'static') return resolution.factory()
    const path = resolvePath(resolution.path, '.')
    let bytes: Uint8Array
    try {
      bytes = this.vfs.readFileSync(path) as Uint8Array
      const ballDirectory = join(this.root, 'home/balls')
      const pathSha = dirname(path) === ballDirectory
        ? /^([0-9a-fA-F]{64})\.js$/.exec(path.slice(ballDirectory.length + 1))?.[1]
        : undefined
      const expectedSha = resolution.kind === 'ball' ? resolution.sha : pathSha
      if (expectedSha !== undefined) {
        const actualSha = sha256HexSync(bytes)
        if (actualSha !== expectedSha.toLowerCase()) {
          this.fail(`Ball integrity check failed: ball:${expectedSha} integrity mismatch (computed ${actualSha} from ${path})`)
        }
      }
    } catch (reason) {
      this.modules.delete(path)
      throw reason
    }
    const cached = this.modules.get(path)
    if (resolution.kind === 'file' && cached !== undefined) {
      if (this.stack.includes(path)
        || (cached.bytes.length === bytes.length && cached.bytes.every((byte, index) => byte === bytes[index]))) {
        return cached.module.exports
      }
      this.modules.delete(path)
    }
    const source = new TextDecoder().decode(bytes)
    if (path.endsWith('.json')) {
      const parsed: unknown = JSON.parse(source)
      this.modules.set(path, { module: { exports: parsed }, bytes: new Uint8Array(bytes) })
      return parsed
    }
    const exports: Record<string, unknown> = {}
    // MemoryVfs exposes mutable byte views, so neither mtime nor a retained view
    // can identify the bytes this evaluation actually consumed.
    const record: ModuleRecord = { module: { exports }, bytes: new Uint8Array(bytes) }
    if (resolution.kind === 'file') this.modules.set(path, record)
    this.stack.push(path)
    try {
      const factory = this.compile(source, path)
      const directory = dirname(path)
      factory(
        record.module.exports,
        this.requireFrom(directory),
        record.module,
        path,
        directory,
        {
          url: pathToFileUrl(path),
          // Node parity for the lowered `import.meta` face: a path resolution
          // answers a file URL; a static (built-in or proxied) module answers
          // its own specifier, the way Node echoes `node:*` back.
          resolve: (specifier: string): string => {
            const resolution = this.resolve(specifier, directory)
            return resolution.kind === 'static' ? resolution.specifier : pathToFileUrl(resolution.path)
          },
        },
        this.als,
      )
      return record.module.exports
    } catch (reason) {
      if (this.modules.get(path) === record) this.modules.delete(path)
      throw reason
    } finally {
      this.stack.pop()
    }
  }

  /**
   * Compile a body the image already lowered (or runtime-lower user/ball ESM under /home or /workspace).
   * @param code - Module body as the image holds it.
   * @param path - Resolved VFS path.
   * @returns The wrapper factory.
   */
  private compile(code: string, path: string): (...args: unknown[]) => void {
    const isUserModule = path.startsWith(join(this.root, 'home/')) || path.startsWith(join(this.root, 'workspace/'))
    // Aukora X6.1 Lane E3: a `.mjs` file is ESM by definition wherever it sits (e.g. a repo test suite and its fixtures
    // run by `node --test`), so module syntax in one lowers too, in strict mode as ESM is. Image bodies the packer
    // already lowered compile on the first try and are untouched; lowering runs after load() verified any ball digest.
    const isEsmFile = path.endsWith('.mjs')
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- wrapping an image body is this loader's job
      return new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
    } catch (reason) {
      if ((isUserModule || isEsmFile) && reason instanceof SyntaxError && /import|export/i.test(reason.message)) {
        try {
          const lowered = (isEsmFile ? '\'use strict\';\n' : '') + lowerEsmRuntime(code)
          // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runtime ESM fallback for ball/workspace modules
          return new Function(...WRAPPER_PARAMS, lowered) as (...args: unknown[]) => void
        } catch (innerReason) {
          this.fail(`${path} failed to compile after ESM lowering: ${(innerReason as Error).message}`)
        }
      }
      if (reason instanceof SyntaxError && /await/i.test(reason.message)) {
        this.fail(`${path} uses top-level await, which cannot run as CommonJS in the worker: ${reason.message}`)
      }
      if (reason instanceof SyntaxError && /import|export/i.test(reason.message)) {
        this.fail(`${path} still carries module syntax, so the image was not lowered by the packer `
          + `(${reason.message}); rebuild the image`)
      }
      this.fail(`${path} failed to compile: ${(reason as Error).message}`)
    }
  }

  /**
   * Build a `require` bound to a directory.
   * @param fromDirectory - Directory relative specifiers resolve against.
   * @returns Callable require with `resolve`.
   */
  requireFrom(fromDirectory: string): WorkerRequire {
    const require = (specifier: string): unknown => this.load(this.resolve(specifier, fromDirectory))
    const resolve = ((specifier: string): string => {
      const resolution = this.resolve(specifier, fromDirectory)
      if (resolution.kind === 'static') {
        return this.fail(`"${specifier}" is a worker-provided module and has no VFS path`)
      }
      return resolution.path
    }) as WorkerRequireResolve
    resolve.paths = (specifier: string): string[] | null => {
      if (this.staticModule(specifier) !== undefined || specifier.startsWith('node:')) return null
      if (specifier.startsWith('.')) return [resolvePath(fromDirectory, '.')]
      return this.searchPaths(fromDirectory)
    }
    return Object.assign(require, { resolve })
  }

  /**
   * Aukora X5: `node_modules` directories a bare specifier is looked up in from a directory, nearest first
   * (Node's nodeModulePaths), always ending with the image root's.
   * @param fromDirectory - Directory the lookup starts from.
   * @returns Candidate directories.
   */
  private searchPaths(fromDirectory: string): string[] {
    const out: string[] = []
    const rootModules = join(this.root, 'node_modules')
    for (let dir = resolvePath(fromDirectory, '.'); ; dir = dirname(dir)) {
      if (!dir.endsWith('/node_modules')) {
        const candidate = join(dir, 'node_modules')
        if (candidate !== rootModules && this.vfs.existsSync(candidate)) out.push(candidate)
      }
      if (dir === '/' || dirname(dir) === dir) break
    }
    out.push(rootModules)
    return out
  }

  /**
   * `node:module` `createRequire` for the VFS.
   * @param base - Module path, directory path, or `file:` URL.
   * @returns Require bound to that base.
   */
  createRequire(base: string | URL): WorkerRequire {
    return this.requireFrom(this.baseDirectoryOf(base))
  }

  /**
   * Report what this loader has done, for the host's boot diagnostics.
   * @returns How many module bodies it has run.
   */
  usage(): { modules: number } {
    return { modules: this.modules.size }
  }
}

let active: WorkerModuleLoader | undefined

/**
 * Publish the loader the `node:module` proxy resolves through.
 * @param loader - Loader built by the worker entry.
 */
export function setActiveModuleLoader(loader: WorkerModuleLoader): void {
  active = loader
}

/**
 * Read the published loader.
 * @returns The active loader.
 */
export function requireActiveModuleLoader(): WorkerModuleLoader {
  if (active === undefined) {
    throw new Error('webworker modules: no loader is mounted; the worker entry must call setActiveModuleLoader before any createRequire use')
  }
  return active
}
