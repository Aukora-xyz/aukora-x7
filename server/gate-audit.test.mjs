/** Reviewed synthetic fixtures only. No candidate suite executes on the host. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { createGateAudit, listDeterministicGates } from './gate-audit.mjs'

const exec = promisify(execFile)
const gateId = 'asset-cache-retention'
const hybridGateId = 'hybrid-pqc-and-chokepoint'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const runnerBytes = await fsp.readFile(new URL('./gate-audit.mjs', import.meta.url))
const files = ['server/asset-cache.mjs', 'server/asset-cache.test.mjs', 'server/runtime-head.mjs']
const hybridFiles = ['deploy/cloudflare/src/owner-grant-policy.mjs', 'deploy/cloudflare/src/__tests__/hybrid-envelope.test.mjs', 'package.json', 'pnpm-lock.yaml']

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-gate-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const repository = path.join(root, 'repository'), directory = path.join(root, 'audit')
  await fsp.mkdir(repository, { mode: 0o700 })
  for (const file of [...files, ...hybridFiles, 'server/gate-audit.mjs']) {
    await fsp.mkdir(path.dirname(path.join(repository, file)), { recursive: true, mode: 0o700 })
    await fsp.writeFile(path.join(repository, file), file === 'server/gate-audit.mjs' ? runnerBytes : 'export {}\n')
  }
  async function git(...args) {
    const result = await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=synthetic@example.invalid', ...args], {
      cwd: repository, maxBuffer: 1024 * 1024, timeout: 10000,
      env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C' },
    })
    return result.stdout.trim()
  }
  await git('init', '--initial-branch=main')
  await git('add', '--', ...files, ...hybridFiles, 'server/gate-audit.mjs')
  await git('commit', '-m', 'Synthetic runner fixture')
  const sourceCommit = await git('rev-parse', 'HEAD')
  return { root, repository, directory, sourceCommit, git, audit: createGateAudit({ repository, directory }) }
}

async function recordFixture(data, overrides = {}) {
  const fixtureDigests = await Promise.all(files.map(async file => ({ path: file, sha256: hash(await fsp.readFile(path.join(data.repository, file))) })))
  const args = ['--test', '--test-concurrency=1', 'server/asset-cache.test.mjs']
  const record = { schema: 'aukora.gate-run.v1', gateId, kind: 'deterministic_regression', sourceCommit: data.sourceCommit,
    suiteDigest: hash(JSON.stringify({ gateId, args, files: fixtureDigests })), runnerDigest: hash(runnerBytes),
    fixtureDigests, startedAt: '2026-11-09T00:00:00.000Z', completedAt: '2026-11-09T00:00:01.000Z',
    sourceStable: true, exitCode: 0, signal: null, timedOut: false, outputLimited: false, passed: true, ...overrides }
  await fsp.mkdir(data.directory, { mode: 0o700, recursive: true })
  const bytes = Buffer.from(JSON.stringify(record) + '\n'), recordId = hash(bytes)
  await fsp.writeFile(path.join(data.directory, recordId + '.json'), bytes, { mode: 0o600 })
  return { record, recordId, bytes }
}

async function auditFiles(directory) {
  return Promise.all((await fsp.readdir(directory)).sort().map(async name => {
    const file = path.join(directory, name), stat = await fsp.stat(file)
    return { name, bytes: await fsp.readFile(file), ino: stat.ino, mtimeMs: stat.mtimeMs, mode: stat.mode }
  }))
}

test('fixed gate inventory rejects execution without genuine confinement, without a test bypass', async t => {
  const data = await fixture(t)
  assert.deepEqual(listDeterministicGates(), [gateId, hybridGateId])
  const marker = path.join(data.root, 'must-not-run')
  const suite = path.join(data.repository, 'server/asset-cache.test.mjs')
  await fsp.writeFile(suite, 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(marker) + ', "executed")\n')
  await data.git('add', '--', 'server/asset-cache.test.mjs')
  await data.git('commit', '-m', 'Synthetic negative execution control')
  const sourceCommit = await data.git('rev-parse', 'HEAD')
  for (const id of [gateId, hybridGateId]) await assert.rejects(data.audit.runGate({ gateId: id, sourceCommit }), { code: 'GATE_CONFINED_RUNNER_REQUIRED' })
  await assert.rejects(fsp.stat(marker), { code: 'ENOENT' })
  assert.deepEqual(await fsp.readdir(data.directory), [])
  assert.deepEqual((await data.audit.project({ sourceCommit })).gates, [])
})

test('unknown gates, dirty sources, stale commits, symlinks and changed dependencies refuse before confinement', async t => {
  const data = await fixture(t)
  await assert.rejects(data.audit.runGate({ gateId: 'asset-cache-retention; echo injected', sourceCommit: data.sourceCommit }), { code: 'UNKNOWN_DETERMINISTIC_GATE' })
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: '--help' }), { code: 'INVALID_GATE_COMMIT' })
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: '0'.repeat(40) }), { code: 'GATE_SOURCE_MOVED' })
  const suite = path.join(data.repository, 'server/asset-cache.test.mjs')
  await fsp.appendFile(suite, '// changed\n')
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: data.sourceCommit }), { code: 'GATE_SOURCE_DIRTY' })
  await fsp.writeFile(suite, 'export {}\n')
  const target = path.join(data.repository, 'source-link.mjs')
  await fsp.writeFile(target, 'export {}\n')
  await fsp.unlink(suite)
  await fsp.symlink(target, suite)
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: data.sourceCommit }), { code: 'GATE_SOURCE_DIRTY' })
  await fsp.appendFile(path.join(data.repository, 'pnpm-lock.yaml'), '# dependency drift\n')
  await assert.rejects(data.audit.runGate({ gateId: hybridGateId, sourceCommit: data.sourceCommit }), { code: 'GATE_SOURCE_DIRTY' })
})

test('stored observations remain unverified without independent admissions and stale after source drift', async t => {
  const data = await fixture(t)
  const { recordId } = await recordFixture(data)
  const projection = await data.audit.project({ sourceCommit: data.sourceCommit })
  assert.equal(projection.gates[0].recordId, recordId)
  assert.equal(projection.gates[0].verification, 'unverified')
  assert.equal(projection.gates[0].authority, 'none')
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(data.directory, 'gates.json'), 'utf8')), projection)
  await fsp.appendFile(path.join(data.repository, files[0]), '// drift\n')
  assert.equal((await data.audit.project({ sourceCommit: data.sourceCommit })).gates[0].verification, 'stale')
})

test('only pinned runner admissions verify records; fabricated fields and signature changes do not', async t => {
  const data = await fixture(t)
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const audit = createGateAudit({ repository: data.repository, directory: data.directory,
    trustedRunners: [{ publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), runnerDigest: hash(runnerBytes) }] })
  const { bytes, recordId } = await recordFixture(data)
  const signatureHex = crypto.sign(null, Buffer.concat([Buffer.from('aukora.gate-admission.v1\0'), bytes]), privateKey).toString('hex')
  assert.equal((await audit.project({ sourceCommit: data.sourceCommit, admissions: [{ recordId, signatureHex }] })).gates[0].verification, 'verified')
  assert.equal((await data.audit.project({ sourceCommit: data.sourceCommit, admissions: [{ recordId, signatureHex }] })).gates[0].verification, 'unverified')
  assert.equal((await audit.project({ sourceCommit: data.sourceCommit, admissions: [{ recordId, signatureHex: '0'.repeat(128) }] })).gates[0].verification, 'unverified')
  const forged = await recordFixture(data, { completedAt: '2099-01-01T00:00:00.000Z', verified: true, attackedWithModel: 'fabricated' })
  assert.equal((await audit.project({ sourceCommit: data.sourceCommit, admissions: [{ recordId: forged.recordId, signatureHex }] })).gates[0].verification, 'unverified')
})

test('locks, invalid store locations and corrupted stored records remain explicit refusals', async t => {
  const data = await fixture(t)
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: data.sourceCommit }), { code: 'GATE_CONFINED_RUNNER_REQUIRED' })
  const lock = path.join(data.directory, 'RUN.lock')
  await fsp.writeFile(lock, 'held', { mode: 0o600 })
  await assert.rejects(data.audit.runGate({ gateId, sourceCommit: data.sourceCommit }), { code: 'GATE_RUNNER_LOCKED' })
  assert.equal(await fsp.readFile(lock, 'utf8'), 'held')
  await fsp.unlink(lock)
  assert.throws(() => createGateAudit({ repository: data.repository, directory: path.join(data.repository, 'mirror/audit') }), { code: 'INVALID_GATE_DIRECTORY' })
  const stored = await recordFixture(data)
  await fsp.appendFile(path.join(data.directory, stored.recordId + '.json'), ' ')
  await assert.rejects(data.audit.project({ sourceCommit: data.sourceCommit }), { code: 'GATE_RECORD_DIGEST_MISMATCH' })
})

test('digest-matching invalid JSON refuses projection without replacing stored evidence', async t => {
  const data = await fixture(t)
  await recordFixture(data)
  await data.audit.project({ sourceCommit: data.sourceCommit })
  const bytes = Buffer.from('{"gateId":')
  await fsp.writeFile(path.join(data.directory, hash(bytes) + '.json'), bytes, { mode: 0o600 })
  const before = await auditFiles(data.directory)
  await assert.rejects(data.audit.project({ sourceCommit: data.sourceCommit }), { code: 'GATE_RECORD_MALFORMED' })
  assert.deepEqual(await auditFiles(data.directory), before)
})

test('invalid stored record types refuse projection instead of crashing or being skipped', async t => {
  const data = await fixture(t)
  const { record } = await recordFixture(data)
  await data.audit.project({ sourceCommit: data.sourceCommit })
  const cases = [
    ['null', null], ['boolean', false], ['number', 1], ['string', 'record'], ['array', []], ['missing fields', {}],
    ...['gateId', 'startedAt', 'completedAt']
      .map(field => [field + ' object', { ...record, [field]: { toString: null } }]),
    ...['startedAt', 'completedAt'].map(field => [field + ' array', { ...record, [field]: [record[field]] }]),
  ]
  for (const [name, value] of cases) await t.test(name, async subtest => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n'), file = path.join(data.directory, hash(bytes) + '.json')
    await fsp.writeFile(file, bytes, { mode: 0o600 })
    subtest.after(() => fsp.unlink(file))
    const before = await auditFiles(data.directory)
    await assert.rejects(data.audit.project({ sourceCommit: data.sourceCommit }), { code: 'GATE_RECORD_INVALID_TYPE' })
    assert.deepEqual(await auditFiles(data.directory), before)
  })
})

test('well-typed unsuccessful observations remain unverified', async t => {
  const data = await fixture(t)
  const { recordId } = await recordFixture(data, { sourceStable: false, exitCode: null, signal: 'SIGKILL', timedOut: true, outputLimited: true, passed: false })
  const projection = await data.audit.project({ sourceCommit: data.sourceCommit })
  assert.equal(projection.gates[0].recordId, recordId)
  assert.equal(projection.gates[0].exitCode, null)
  assert.equal(projection.gates[0].passed, false)
  assert.equal(projection.gates[0].verification, 'unverified')
  assert.equal(projection.gates[0].authority, 'none')
})
