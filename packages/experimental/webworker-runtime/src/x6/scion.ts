/** Bounded, offline organ compilation in a separate browser worker. */
import * as esbuild from 'esbuild-wasm/esm/browser.js'
import type { Loader, Plugin } from 'esbuild-wasm'
import { sha256HexSync } from '../module-system/module-loader.ts'

import { SCION_COMPILER } from './scion-pins.ts'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 128
const EXTERNALS = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', 'fs', 'node:fs', 'path', 'node:path', 'crypto', 'node:crypto', 'buffer', 'node:buffer'])
const RESOLVER_POLICY = 'x61-supplied-files/v1'
const RECIPE = { format: 'cjs', platform: 'browser', target: 'es2022', legalComments: 'inline', sourcemap: false, outfile: 'organ.cjs', bundle: true, write: false, charset: 'utf8', metafile: true, logLevel: 'silent' } as const

/** Explicit source snapshot; relative files are the compiler's entire filesystem. */
export interface ScionInput {
  readonly entry: string
  readonly files: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}
interface ScionRequest { t: 'scion-start'; id: string; input: ScionInput }
/** Compilation is preparation only; it does not execute or select the output. */
export interface ScionOutput {
  readonly code: string
  readonly outputSha256: string
  readonly inputRoot: string
  readonly bytes: number
  readonly modules: number
  readonly warnings: readonly string[]
  readonly compiler: typeof SCION_COMPILER
}

function relativePath(value: string): string {
  if (!value || value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes(':') || value.includes('\0')) throw new Error('Source paths must be relative, without URLs or backslashes')
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) throw new Error('Source path escapes supplied root'); parts.pop() }
    else parts.push(part)
  }
  if (!parts.length) throw new Error('Source file path is empty')
  return parts.join('/')
}

function validateInput(raw: unknown): ScionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Compiler input must be an object')
  const input = raw as Record<string, unknown>
  if (typeof input.entry !== 'string' || !input.files || typeof input.files !== 'object' || Array.isArray(input.files)) throw new Error('Compiler needs entry and files')
  const entries = Object.entries(input.files)
  if (!entries.length || entries.length > MAX_FILES) throw new Error(`Supply 1 to ${String(MAX_FILES)} source files`)
  const files: Record<string, string> = Object.create(null)
  let bytes = 0
  for (const [rawPath, contents] of entries) {
    const file = relativePath(rawPath)
    if (typeof contents !== 'string' || contents.length > MAX_BYTES || file in files) throw new Error('Source files must be unique text files')
    bytes += new TextEncoder().encode(contents).byteLength
    if (bytes > MAX_BYTES) throw new Error('Source snapshot exceeds 2 MiB')
    files[file] = contents
  }
  const entry = relativePath(input.entry)
  if (!(entry in files)) throw new Error(`Entry is not supplied: ${entry}`)
  const timeoutMs = input.timeoutMs === undefined ? 20_000 : input.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('timeoutMs must be 100 to 30000')
  return { entry, files, timeoutMs }
}

function resolveFile(requested: string, files: Readonly<Record<string, string>>): string | undefined {
  const candidates = [requested, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(ext => requested + ext), ...['.ts', '.tsx', '.js', '.json'].map(ext => requested + '/index' + ext)]
  if (/\.m?js$/.test(requested)) candidates.push(requested.replace(/\.m?js$/, '.ts'), requested.replace(/\.m?js$/, '.tsx'))
  return candidates.find(file => Object.hasOwn(files, file))
}

function loaderFor(file: string): Loader {
  const ext = file.split('.').at(-1)
  switch (ext) {
    case 'ts': return 'ts'
    case 'tsx': return 'tsx'
    case 'jsx': return 'jsx'
    case 'json': return 'json'
    case 'js': case 'mjs': case 'cjs': return 'js'
    default: throw new Error(`Unsupported source extension: ${file}`)
  }
}

function inputRootFor(input: ScionInput): string {
  return sha256HexSync(JSON.stringify({ compiler: SCION_COMPILER, resolverPolicy: RESOLVER_POLICY, recipe: RECIPE, entry: input.entry, externals: [...EXTERNALS].sort(), files: Object.keys(input.files).sort().map(file => ({ path: file, sha256: sha256HexSync(input.files[file]!) })) }))
}

async function compile(input: ScionInput): Promise<ScionOutput> {
  const response = await fetch(new URL('./' + SCION_COMPILER.asset, self.location.href), { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Compiler artifact unavailable: HTTP ${String(response.status)}`)
  const wasm = new Uint8Array(await response.arrayBuffer())
  if (wasm.byteLength !== SCION_COMPILER.wasmBytes || sha256HexSync(wasm) !== SCION_COMPILER.wasmSha256) throw new Error('Compiler artifact pin mismatch')
  await esbuild.initialize({ wasmModule: await WebAssembly.compile(wasm), worker: false })
  const plugin: Plugin = {
    name: 'scion-supplied-files',
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.kind !== 'entry-point' && EXTERNALS.has(args.path)) return { path: args.path, external: true }
        if (args.kind !== 'entry-point' && !args.path.startsWith('.')) return { errors: [{ text: `Import is not allowlisted: ${args.path}` }] }
        try {
          const directory = args.importer.includes('/') ? args.importer.slice(0, args.importer.lastIndexOf('/') + 1) : ''
          const requested = relativePath(args.kind === 'entry-point' ? args.path : directory + args.path)
          const file = resolveFile(requested, input.files)
          return file ? { path: file, namespace: 'scion' } : { errors: [{ text: `Missing supplied source: ${requested}` }] }
        } catch (error) { return { errors: [{ text: error instanceof Error ? error.message : String(error) }] } }
      })
      build.onLoad({ filter: /.*/, namespace: 'scion' }, args => ({ contents: input.files[args.path]!, loader: loaderFor(args.path) }))
    },
  }
  const result = await esbuild.build({ ...RECIPE, entryPoints: [input.entry], plugins: [plugin] })
  const code = result.outputFiles[0]?.text
  if (code === undefined || result.outputFiles.length !== 1) throw new Error('Compiler must produce exactly one JavaScript module')
  const bytes = new TextEncoder().encode(code).byteLength
  if (bytes > MAX_BYTES) throw new Error('Compiled output exceeds 2 MiB')
  const inputRoot = inputRootFor(input)
  return { code, bytes, inputRoot, outputSha256: sha256HexSync(code), modules: Object.keys(result.metafile.inputs).length, warnings: result.warnings.slice(0, 20).map(warning => warning.text.slice(0, 1000)), compiler: SCION_COMPILER }
}

/** Run one compiler-role frame without booting a VFS, Cordis tree or model. */
export async function runScionWorker(data: unknown): Promise<void> {
  let id = ''
  try {
    if (!data || typeof data !== 'object' || !('t' in data) || data.t !== 'scion-start' || !('id' in data) || typeof data.id !== 'string' || !data.id || data.id.length > 128) throw new Error('Compiler request needs an id')
    id = data.id
    if (!('input' in data)) throw new Error('Compiler request needs input')
    const input = validateInput(data.input)
    const output = await compile(input)
    self.postMessage({ t: 'scion-result', id, ok: true, output })
  } catch (error) {
    self.postMessage({ t: 'scion-result', id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) })
  } finally { self.close() }
}

/** Create a per-runtime compiler owner with one bounded job at a time. */
export function createScionCompiler(): { compile(input: ScionInput, signal?: AbortSignal): Promise<ScionOutput> } {
  let busy = false
  return {
    async compile(raw, signal) {
      const input = validateInput(raw)
      if (signal?.aborted) throw new Error('Compiler request cancelled')
      if (busy) throw new Error('SCION_BUSY: wait for the current compiler job')
      if (typeof Worker === 'undefined') throw new Error('Nested browser workers are unavailable')
      busy = true
      try {
        return await new Promise<ScionOutput>((resolve, reject) => {
          const worker = new Worker(self.location.href, { type: 'module', name: 'auma-scion' })
          const id = crypto.randomUUID()
          let settled = false
          const finish = (error: Error | null, output?: ScionOutput): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            worker.terminate()
            if (error) reject(error)
            else if (output) resolve(output)
            else reject(new Error('Compiler returned no output'))
          }
          const abort = (): void => finish(new Error('Compiler request cancelled'))
          const timer = setTimeout(() => finish(new Error('SCION_TIMEOUT: compiler worker terminated')), input.timeoutMs)
          signal?.addEventListener('abort', abort, { once: true })
          worker.addEventListener('error', event => finish(new Error(event.message || 'Compiler worker failed')))
          worker.addEventListener('messageerror', () => finish(new Error('Compiler result could not be decoded')))
          worker.addEventListener('message', (event: MessageEvent) => {
            try {
              const reply = event.data as Record<string, unknown>
              if (!reply || reply.t !== 'scion-result' || reply.id !== id) throw new Error('Unexpected compiler response')
              if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'Compiler failed')
              const output = reply.output as ScionOutput
              if (!output || typeof output.code !== 'string' || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > MAX_BYTES || new TextEncoder().encode(output.code).byteLength !== output.bytes || sha256HexSync(output.code) !== output.outputSha256 || output.inputRoot !== inputRootFor(input) || !Number.isSafeInteger(output.modules) || output.modules < 1 || output.modules > MAX_FILES || !Array.isArray(output.warnings) || output.warnings.length > 20 || output.warnings.some(warning => typeof warning !== 'string' || warning.length > 1000) || JSON.stringify(output.compiler) !== JSON.stringify(SCION_COMPILER)) throw new Error('Compiler output integrity check failed')
              finish(null, output)
            } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
          })
          try { worker.postMessage({ t: 'scion-start', id, input } satisfies ScionRequest) }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        })
      } finally { busy = false }
    },
  }
}
