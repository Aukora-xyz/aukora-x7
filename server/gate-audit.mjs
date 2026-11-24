/** Offline gate runner. Local execution is evidence, not admission by a trusted runner.
 * Trusted runner public keys/digests must come from owner-controlled configuration outside candidate authority.
 * This module never signs records or writes the live mirror. Deployment must separately protect that configuration
 * and publish the returned gates.json projection through its trusted host path.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const runnerPath = 'server/gate-audit.mjs'
const loadedRunnerDigest = sha(fs.readFileSync(fileURLToPath(import.meta.url)))
const GATES = Object.freeze({
  'asset-cache-retention': Object.freeze({
    args: Object.freeze(['--test', '--test-concurrency=1', 'server/asset-cache.test.mjs']),
    files: Object.freeze(['server/asset-cache.mjs', 'server/asset-cache.test.mjs', 'server/runtime-head.mjs']),
  }),
  'hybrid-pqc-and-chokepoint': Object.freeze({
    args: Object.freeze(['--test', '--test-concurrency=1', 'deploy/cloudflare/src/__tests__/hybrid-envelope.test.mjs']),
    files: Object.freeze(['deploy/cloudflare/src/owner-grant-policy.mjs',
      'deploy/cloudflare/src/__tests__/hybrid-envelope.test.mjs', 'package.json', 'pnpm-lock.yaml']),
  }),
})
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_RECORD_BYTES = 256 * 1024
const MAX_RECORDS = 256
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const own = stat => typeof process.getuid === 'function' && stat.uid === process.getuid()
const absent = error => { if (error.code === 'ENOENT') return null; throw error }

/** Returns the fixed gate names; caller text is never interpreted as a command. */
export const listDeterministicGates = () => Object.keys(GATES)

function environment(home) {
  return { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
}

async function command(executable, args, cwd, home, maximum, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: environment(home), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let outputBytes = 0, timedOut = false, outputLimited = false, spawnError = null
    const stdout = [], stderr = []
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') } }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    function collect(chunks, bytes) {
      const remaining = Math.max(0, maximum - outputBytes)
      if (remaining) chunks.push(bytes.subarray(0, remaining))
      outputBytes += bytes.length
      if (outputBytes > maximum) { outputLimited = true; kill() }
    }
    child.stdout.on('data', bytes => collect(stdout, bytes))
    child.stderr.on('data', bytes => collect(stderr, bytes))
    child.on('error', error => { spawnError = error })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (spawnError) reject(spawnError)
      else resolve({ exitCode, signal, timedOut, outputLimited, outputBytes, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

async function safeDirectory(directory, privateMode = true) {
  const stat = await fsp.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat) || (stat.mode & (privateMode ? 0o077 : 0o022)) || await fsp.realpath(directory) !== directory) fail('UNSAFE_GATE_DIRECTORY')
}
async function readFile(file, maximum) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) fail('GATE_FILE_BUDGET')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) fail('GATE_FILE_CHANGED')
    return bytes
  } finally { await handle.close() }
}
async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeJson(directory, name, value, immutable = false) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  const temporary = path.join(directory, '.' + crypto.randomUUID() + '.tmp')
  const handle = await fsp.open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    if (immutable) await fsp.link(temporary, path.join(directory, name))
    else await fsp.rename(temporary, path.join(directory, name))
    await syncDirectory(directory)
  } finally { await fsp.unlink(temporary).catch(absent) }
}

/** Creates an audit store outside mirror. No trustedRunners means every record remains unverified.
 * Each trusted runner entry contains an Ed25519 publicKeyPem and exact runnerDigest approved independently.
 * Source checks require clean allowlisted input files at sourceCommit; unrelated dirty work is neither read nor changed.
 * Candidate execution is unavailable without an installed confined runner. A private cwd and clean environment are not confinement.
 */
export function createGateAudit({ repository, directory, trustedRunners = [], timeoutMs = 30000, maxOutputBytes = 65536 }) {
  if (!path.isAbsolute(repository) || !path.isAbsolute(directory) || path.resolve(repository) !== repository || path.resolve(directory) !== directory || directory === repository || directory.split(path.sep).includes('mirror')) fail('INVALID_GATE_DIRECTORY')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_RECORD_BYTES) fail('INVALID_GATE_LIMITS')
  if (!Array.isArray(trustedRunners) || trustedRunners.length > 16) fail('INVALID_GATE_TRUST')
  const trust = trustedRunners.map(value => {
    if (!isDigest(value.runnerDigest)) fail('INVALID_GATE_TRUST')
    const key = crypto.createPublicKey(value.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') fail('INVALID_GATE_TRUST')
    return { key, runnerDigest: value.runnerDigest }
  })
  let queue = Promise.resolve()
  async function storage() {
    await safeDirectory(repository, false)
    await safeDirectory(path.dirname(directory), false)
    await fsp.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await safeDirectory(directory)
  }
  async function locked(action) {
    const result = queue.then(async () => {
      await storage()
      const lock = path.join(directory, 'RUN.lock')
      const handle = await fsp.open(lock, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('GATE_RUNNER_LOCKED'); throw error })
      const identity = await handle.stat()
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() })); await handle.sync()
        return await action()
      } finally {
        try {
          const current = await fsp.lstat(lock)
          if (current.dev !== identity.dev || current.ino !== identity.ino) fail('GATE_LOCK_CHANGED')
          await fsp.unlink(lock); await syncDirectory(directory)
        } finally { await handle.close() }
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  async function git(args) {
    const result = await command('/usr/bin/git', ['--no-pager', ...args], repository, directory, MAX_SOURCE_BYTES, 10000)
    if (result.exitCode !== 0 || result.timedOut || result.outputLimited) fail('GATE_SOURCE_UNAVAILABLE')
    return result.stdout
  }
  async function source(gateId, sourceCommit) {
    if (!Object.hasOwn(GATES, gateId)) fail('UNKNOWN_DETERMINISTIC_GATE')
    if (!isCommit(sourceCommit)) fail('INVALID_GATE_COMMIT')
    if ((await git(['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim() !== sourceCommit) fail('GATE_SOURCE_MOVED')
    const files = new Map()
    for (const file of [...GATES[gateId].files, runnerPath]) {
      const committed = await git(['show', sourceCommit + ':' + file])
      const absolute = path.join(repository, file)
      if (await fsp.realpath(absolute) !== absolute || !(await readFile(absolute, MAX_SOURCE_BYTES)).equals(committed)) fail('GATE_SOURCE_DIRTY')
      files.set(file, committed)
    }
    const runnerDigest = sha(files.get(runnerPath))
    if (runnerDigest !== loadedRunnerDigest) fail('GATE_RUNNER_CHANGED')
    const fixtureDigests = GATES[gateId].files.map(file => ({ path: file, sha256: sha(files.get(file)) }))
    const testCommand = [process.execPath, ...GATES[gateId].args]
    const suiteDigest = sha(JSON.stringify({ gateId, args: GATES[gateId].args, files: fixtureDigests }))
    return { files, runnerDigest, fixtureDigests, testCommand, suiteDigest }
  }
  async function records() {
    const names = (await fsp.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()
    if (names.length > MAX_RECORDS) fail('GATE_RECORD_BUDGET')
    const rows = []
    for (const name of names) {
      const bytes = await readFile(path.join(directory, name), MAX_RECORD_BYTES)
      if (sha(bytes) !== name.slice(0, -5)) fail('GATE_RECORD_DIGEST_MISMATCH')
      let record
      try { record = JSON.parse(bytes.toString('utf8')) } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        fail('GATE_RECORD_MALFORMED')
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record) ||
        !['gateId', 'startedAt', 'completedAt'].every(field => typeof record[field] === 'string')) fail('GATE_RECORD_INVALID_TYPE')
      rows.push({ recordId: name.slice(0, -5), record, bytes })
    }
    return rows
  }
  async function project(sourceCommit, admissions) {
    if (!isCommit(sourceCommit) || !Array.isArray(admissions) || admissions.length > MAX_RECORDS) fail('INVALID_GATE_PROJECTION')
    const rows = await records()
    const gates = []
    for (const gateId of listDeterministicGates()) {
      const candidates = rows.filter(row => row.record.gateId === gateId)
      candidates.sort((a, b) => (Date.parse(b.record.completedAt) || 0) - (Date.parse(a.record.completedAt) || 0) || a.recordId.localeCompare(b.recordId))
      const latest = candidates[0]
      if (!latest) continue
      const { record, recordId, bytes } = latest
      let matchingSource = false
      try {
        const expected = await source(gateId, sourceCommit)
        matchingSource = record.sourceCommit === sourceCommit && record.suiteDigest === expected.suiteDigest && record.runnerDigest === expected.runnerDigest
      } catch (error) { if (!['GATE_SOURCE_MOVED', 'GATE_SOURCE_DIRTY', 'GATE_RUNNER_CHANGED', 'GATE_SOURCE_UNAVAILABLE'].includes(error.code)) throw error }
      const complete = record.schema === 'aukora.gate-run.v1' && record.kind === 'deterministic_regression' && Number.isFinite(Date.parse(record.startedAt)) && Number.isFinite(Date.parse(record.completedAt)) && Date.parse(record.completedAt) >= Date.parse(record.startedAt) && record.sourceStable === true && record.exitCode === 0 && record.signal === null && record.timedOut === false && record.outputLimited === false && record.passed === true
      const admitted = complete && admissions.some(admission => admission.recordId === recordId && typeof admission.signatureHex === 'string' && /^[a-f0-9]{128}$/.test(admission.signatureHex) && trust.some(runner => runner.runnerDigest === record.runnerDigest && crypto.verify(null, Buffer.concat([Buffer.from('aukora.gate-admission.v1\0'), bytes]), runner.key, Buffer.from(admission.signatureHex, 'hex'))))
      gates.push({ gateId, kind: 'deterministic_regression', sourceCommit: record.sourceCommit, suiteDigest: record.suiteDigest, runnerDigest: record.runnerDigest, startedAt: record.startedAt, completedAt: record.completedAt, exitCode: record.exitCode, passed: record.passed === true, recordId,
        verification: !matchingSource ? 'stale' : admitted ? 'verified' : 'unverified', authority: admitted ? 'pinned-runner-signature' : 'none' })
    }
    const projection = { schema: 'aukora.gates.v1', sourceCommit, generatedAt: new Date().toISOString(), gates }
    await writeJson(directory, 'gates.json', projection)
    return projection
  }
  return {
    directory,
    /** Validate the fixed source set, then refuse execution until a genuinely confined runner is installed.
     * @param {object} input Fixed gateId and sourceCommit, never a command or executable supplied by the candidate.
     * @returns {Promise<never>} GATE_CONFINED_RUNNER_REQUIRED after source validation; no candidate code runs.
     */
    runGate({ gateId, sourceCommit }) {
      return locked(async () => {
        await source(gateId, sourceCommit)
        fail('GATE_CONFINED_RUNNER_REQUIRED')
      })
    },
    /** Only detached signatures checked against factory-pinned runner keys can admit a matching successful run.
     * Malformed stored JSON or invalid record field types refuse the whole projection with GATE_RECORD_MALFORMED
     * or GATE_RECORD_INVALID_TYPE; records and any existing gates.json remain unchanged, and the runner lock is released.
     */
    project({ sourceCommit, admissions = [] }) { return locked(() => project(sourceCommit, admissions)) },
  }
}
