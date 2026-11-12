/** Explicit offline preparation and authenticated, fixed-destination Cloudflare bootstrap. */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSeedPackage, readSeedPackage, uploadSeedPackage, writeSeedPackage } from './seed-cloudflare.mjs'

const ORIGIN = 'https://node.example.invalid'
const ENDPOINT = ORIGIN + '/_bootstrap'
const DEFAULT_MIRROR = fileURLToPath(new URL('../mirror/', import.meta.url))
const AUTH_BYTES = 16 * 1024
const AUTH_READ_MS = 15000
const booleanOptions = new Set(['--dry-run', '--prepare', '--access-token-stdin'])
const valueOptions = new Set(['--mirror', '--out', '--package', '--url', '--confirm-seed-id'])
const helperCodes = new Set([
  'SEED_ANCESTOR_NOT_DIRECTORY', 'SEED_BATCH_COUNT_MISMATCH', 'SEED_BATCH_DIGEST_MISMATCH',
  'SEED_BATCH_LIMIT', 'SEED_BATCH_TOO_LARGE', 'SEED_DEPTH_LIMIT', 'SEED_ENTRY_COUNT_MISMATCH',
  'SEED_ENTRY_LIMIT', 'SEED_FILE_TOO_LARGE', 'SEED_HEAD_COPIES_DIFFER', 'SEED_INVALID_ENTRY',
  'SEED_INVALID_JSON', 'SEED_MANIFEST_INVALID', 'SEED_MODULE_ENCODING_INVALID',
  'SEED_MODULE_HASH_MISMATCH', 'SEED_OUTPUT_CHANGED', 'SEED_OUTPUT_NOT_PRIVATE',
  'SEED_OUTPUT_PARENT_MISSING', 'SEED_PACKAGE_FILES_MISMATCH', 'SEED_PACKAGE_TOO_LARGE',
  'SEED_REQUEST_TOO_LARGE', 'SEED_ROOT_NOT_DIRECTORY', 'SEED_SCAN_LIMIT',
  'SEED_SNAPSHOT_TOO_LARGE', 'SEED_SOURCE_CHANGED', 'SEED_SOURCE_MISSING',
  'SEED_SPECIAL_FILE_REFUSED', 'SEED_SYMLINK_REFUSED', 'SEED_UNSAFE_SOURCE_FILE',
  'SEED_UPLOAD_ACK_MISMATCH', 'SEED_UPLOAD_CONFIRMATION_REQUIRED',
  'SEED_UPLOAD_NOT_ACKNOWLEDGED', 'SEED_UPLOAD_OUTCOME_UNKNOWN',
])
const usage = [
  'node server/cloudflare-bootstrap-cli.mjs --dry-run [--mirror <directory> | --package <directory>]',
  'node server/cloudflare-bootstrap-cli.mjs --prepare [--mirror <directory>] --out <new-private-directory>',
  'node server/cloudflare-bootstrap-cli.mjs --url https://node.example.invalid --package <directory> --confirm-seed-id <seedId> --access-token-stdin',
  'The default mirror is the repository mirror directory. Dry-run never writes or connects.',
  'Prepare saves private snapshot bytes offline. Upload uses only that saved package.',
  'Access input must be an RS256 Access or EdDSA owner JWT, supplied through non-TTY stdin, never arguments or environment discovery.',
  'The token is sent only as the CF_Authorization cookie to the fixed HTTPS bootstrap endpoint.',
  'At most 16 KiB and one terminal newline are accepted; the token must not be expired.',
  'No redirects or automatic retries. After an uncertain upload, retain and review the same package before an explicit resume.',
].join('\n')

class CliFailure extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new CliFailure(code) }
const bytes = value => Buffer.byteLength(JSON.stringify(value))

function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { mode: 'help' }
  const options = new Map()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (options.has(key)) fail('SEED_INVALID_ARGUMENTS')
    if (booleanOptions.has(key)) options.set(key, true)
    else if (valueOptions.has(key)) {
      const value = argv[++index]
      if (typeof value !== 'string' || !value || value.startsWith('--')) fail('SEED_INVALID_ARGUMENTS')
      options.set(key, value)
    } else fail('SEED_INVALID_ARGUMENTS')
  }
  if (options.has('--url') && options.get('--url') !== ORIGIN) fail('SEED_DESTINATION_REFUSED')
  const modes = ['--dry-run', '--prepare', '--url'].filter(key => options.has(key))
  if (modes.length !== 1) fail('SEED_INVALID_ARGUMENTS')
  const mode = modes[0]
  const permitted = mode === '--dry-run'
    ? new Set(['--dry-run', '--mirror', '--package'])
    : mode === '--prepare'
      ? new Set(['--prepare', '--mirror', '--out'])
      : new Set(['--url', '--package', '--confirm-seed-id', '--access-token-stdin'])
  for (const key of options.keys()) if (!permitted.has(key)) fail('SEED_INVALID_ARGUMENTS')
  if (options.has('--mirror') && options.has('--package')) fail('SEED_INVALID_ARGUMENTS')
  if (mode === '--prepare' && !options.has('--out')) fail('SEED_INVALID_ARGUMENTS')
  if (mode === '--url') {
    if (!options.has('--package') || !/^[0-9a-f]{64}$/.test(options.get('--confirm-seed-id') ?? '')) fail('SEED_UPLOAD_CONFIRMATION_REQUIRED')
    if (!options.has('--access-token-stdin')) fail('SEED_ACCESS_REQUIRED')
  }
  const mirrorDir = options.get('--mirror') ?? DEFAULT_MIRROR
  const outDir = options.get('--out')
  if (outDir) {
    const mirror = path.resolve(mirrorDir)
    const output = path.resolve(outDir)
    if (output === mirror || output.startsWith(mirror + path.sep)) fail('SEED_OUTPUT_INSIDE_SOURCE')
  }
  return { mode, mirrorDir, outDir, packageDir: options.get('--package'), confirmSeedId: options.get('--confirm-seed-id') }
}

function report(verified) {
  const manifest = verified.package
  const batches = verified.batches.map((entries, index) => ({ index, bytes: bytes({ action: 'batch', seedId: manifest.seedId, index, entries }) }))
  const prepare = bytes({ action: 'prepare', package: manifest })
  const commit = bytes({ action: 'commit', seedId: manifest.seedId })
  return {
    seedId: manifest.seedId,
    ballId: manifest.ball.ballId,
    epoch: manifest.ball.epoch,
    batchCount: verified.batches.length,
    batches,
    bytes: {
      prepare,
      commit,
      modules: Object.values(manifest.codeBySha).reduce((total, source) => total + Buffer.byteLength(source), 0),
      decodedFiles: verified.summary.decodedBytes,
      totalRequests: prepare + commit + batches.reduce((total, batch) => total + batch.bytes, 0),
    },
  }
}

function validateToken(token, now) {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('SEED_ACCESS_INVALID')
  let claims
  try {
    const parts = token.split('.')
    if (parts.some(part => Buffer.from(part, 'base64url').toString('base64url') !== part)) fail('SEED_ACCESS_INVALID')
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[0], 'base64url')))
    if (!header || !['RS256', 'EdDSA'].includes(header.alg)) fail('SEED_ACCESS_INVALID')
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url')))
  }
  catch (error) { fail('SEED_ACCESS_INVALID') }
  const seconds = now() / 1000
  if (!claims || !Number.isFinite(claims.exp) || !Number.isFinite(seconds)) fail('SEED_ACCESS_INVALID')
  if (claims.exp <= seconds) fail('SEED_ACCESS_EXPIRED')
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds)) fail('SEED_ACCESS_INVALID')
  // These are unverified lifetime checks only; the edge server verifies the signature and owner.
  return claims.exp
}

async function readAccessToken(stdin, now) {
  if (stdin.isTTY || typeof stdin[Symbol.asyncIterator] !== 'function') fail('SEED_ACCESS_STDIN_REQUIRED')
  const buffer = Buffer.alloc(AUTH_BYTES)
  let used = 0
  let timeout
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      stdin.destroy?.()
      reject(new CliFailure('SEED_ACCESS_READ_TIMEOUT'))
    }, AUTH_READ_MS)
  })
  try {
    await Promise.race([deadline, (async () => {
      for await (const chunk of stdin) {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (used + next.length > AUTH_BYTES) fail('SEED_ACCESS_TOO_LARGE')
        next.copy(buffer, used)
        used += next.length
      }
    })()])
    const token = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)).replace(/\r?\n$/, '')
    return { token, expires: validateToken(token, now) }
  } catch (error) {
    if (error instanceof CliFailure) throw error
    fail('SEED_ACCESS_READ_FAILED')
  } finally {
    clearTimeout(timeout)
    buffer.fill(0)
  }
}

/** Run one command with injectable streams and transport; importing performs no work.
 * Offline modes never read authentication or call fetch. Upload validates the saved
 * package and exact confirmation before reading the explicitly supplied stdin JWT.
 * Errors emit only fixed codes, stop all dependent work and never retry. Retain a
 * partially written package for inspection, or the unchanged saved upload package
 * for an operator-reviewed resume; an upload failure may have changed remote state.
 * @param {string[]} argv CLI arguments, excluding the executable and script.
 * @param {{ fetchImpl?: Function, stdin?: import('node:stream').Readable, stdout?: import('node:stream').Writable, stderr?: import('node:stream').Writable, now?: () => number }} dependencies Overrides for transport, streams and clock; omitted values use native fetch, process streams and Date.now.
 * @returns {Promise<number>} Zero on success; one after a content-free failure report.
 */
export async function runBootstrapCli(argv, { fetchImpl = globalThis.fetch, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  let access
  try {
    const options = parseOptions(argv)
    if (options.mode === 'help') { stdout.write(usage + '\n'); return 0 }
    const verified = options.packageDir
      ? await readSeedPackage({ packageDir: options.packageDir })
      : await prepareSeedPackage({ mirrorDir: options.mirrorDir })
    const summary = report(verified)
    if (options.mode === '--dry-run') { stdout.write(JSON.stringify(summary) + '\n'); return 0 }
    if (options.mode === '--prepare') {
      await writeSeedPackage({ outDir: options.outDir, ...verified })
      stdout.write(JSON.stringify({ ok: true, offline: true, written: true, ...summary }) + '\n')
      return 0
    }
    if (options.confirmSeedId !== verified.package.seedId) fail('SEED_UPLOAD_CONFIRMATION_REQUIRED')
    if (typeof fetchImpl !== 'function') fail('SEED_TRANSPORT_REQUIRED')
    access = await readAccessToken(stdin, now)
    await uploadSeedPackage({
      packageDir: options.packageDir,
      confirmSeedId: options.confirmSeedId,
      fetchImpl: (url, init) => {
        if (url !== ENDPOINT || init.method !== 'POST' || init.redirect !== 'error') fail('SEED_DESTINATION_REFUSED')
        if (now() / 1000 >= access.expires) fail('SEED_ACCESS_EXPIRED')
        const headers = new Headers(init.headers)
        headers.set('cookie', 'CF_Authorization=' + access.token)
        return fetchImpl(url, { ...init, headers })
      },
    })
    stdout.write(JSON.stringify({ ok: true, complete: true, ...summary }) + '\n')
    return 0
  } catch (error) {
    const code = error instanceof CliFailure || helperCodes.has(error?.code) ? error.code : 'SEED_OPERATION_FAILED'
    stderr.write(JSON.stringify({ ok: false, code }) + '\n')
    return 1
  } finally {
    access = undefined
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBootstrapCli(process.argv.slice(2)).then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
}
