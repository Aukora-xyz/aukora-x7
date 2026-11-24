/** Source-only absence regressions: synthetic in-memory files plus isolated temporary link fixtures. */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { gzipSync } from 'node:zlib'
import { parseStatus } from '../apps/web/src/spatial/superagent/contract.ts'

const NOW = 1800000000000
const FIRST_STATUS_EXPIRY = Date.parse('0000-01-01T00:00:00.000Z')
const LAST_STATUS_EXPIRY = Date.parse('9999-12-31T23:59:59.999Z')
const STATE = '/dsh/home/auma/superagent/state.json'
const HEAD = '/dsh/home/balls/HEAD.json'
const NORTHSTARS = ['/dsh/home/auma-one/NORTHSTAR.md', '/dsh/workspace/NORTH-STAR.md']
const PACK = '/synthetic/seed.json.gz'
const code = name => readFileSync(new URL('../mirror/home/auma/seed/organs/' + name + '.js', import.meta.url), 'utf8')
const ioError = code => Object.assign(new Error(code), { code })
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])) }
  static now() { return NOW }
}

function fixture(name, date = Clock) {
  const files = new Map(), events = [], tools = new Map(), unreadable = new Set(), directories = new Set()
  const fs = {
    existsSync: file => files.has(file) || directories.has(file),
    readFileSync(file, encoding) {
      events.push(['read', file])
      if (unreadable.has(file)) throw ioError('EACCES')
      if (!files.has(file)) throw ioError('ENOENT')
      const bytes = Buffer.from(files.get(file))
      return encoding ? bytes.toString(encoding) : bytes
    },
    statSync(file) {
      if (!files.has(file) && !directories.has(file)) throw ioError('ENOENT')
      return { isFile: () => files.has(file), size: files.has(file) ? Buffer.byteLength(files.get(file)) : 0 }
    },
    lstatSync(file) {
      if (!files.has(file) && !directories.has(file)) throw ioError('ENOENT')
      return { isDirectory: () => directories.has(file), isSymbolicLink: () => false, isFile: () => files.has(file) }
    },
    mkdirSync(file) { events.push(['mkdir', file]); directories.add(file) },
    writeFileSync(file, value, options) { events.push(['write', file]); if (options?.flag === 'wx' && files.has(file)) throw ioError('EEXIST'); files.set(file, value) },
    renameSync(from, to) { events.push(['rename', to]); files.set(to, files.get(from)); files.delete(from) },
    unlinkSync(file) { events.push(['unlink', file]); files.delete(file) },
    readdirSync(dir) { return [...files.keys()].filter(file => file.startsWith(dir + '/') && !file.slice(dir.length + 1).includes('/')).map(file => file.slice(dir.length + 1)) },
  }
  let api
  const ctx = {
    fs, provide() {}, set(_key, value) { api = value },
    tools: { register(name, tool) { tools.set(name, tool); return () => {} }, definitions: () => [] },
    web: { async fetch() { return { statusCode: 200 } } },
  }
  const module = { exports: {} }
  const builtin = name => {
    if (name === 'fs' || name === 'node:fs') return fs
    if (name === 'crypto' || name === 'node:crypto') return crypto
    if (name === 'path') return path
    throw new Error('Unapproved synthetic dependency: ' + name)
  }
  runInNewContext(code(name).replace(/^export /gm, '') + (name === 'seed-superagent' ? '\napply(ctx)' : ''),
    { module, require: builtin, process: { getBuiltinModule: builtin }, ctx, Buffer, Date: date,
      Uint8Array, Blob, Response, DecompressionStream, CompressionStream, performance,
      crypto: crypto.webcrypto, TextEncoder, TextDecoder, btoa }, { timeout: 1000 })
  const run = name === 'seed-superagent'
    ? async args => JSON.parse((await tools.get('auma_superagent').execute(args)).output)
    : async args => JSON.parse(JSON.stringify(await module.exports.run(args, ctx)))
  const mutations = () => events.filter(([event]) => ['mkdir', 'write', 'rename', 'unlink'].includes(event))
  return { files, events, tools, unreadable, directories, fs, ctx, run, mutations, api: () => api }
}

const stored = expiresAt => ({ version: 1, updatedAt: NOW, triggers: [], threads: [],
  mandates: [{ id: 'mandate', title: 'Synthetic mandate', scope: { organs: ['fixture'], expiresAt }, expiresAt,
    confirmed: true, strength: 'inferred', budgetSteps: 1 }],
  tickets: [{ id: 'ticket', title: 'Synthetic ticket', mandateId: 'mandate', state: 'open' }], assignments: [], attention: [], outbox: [] })

for (const expiresAt of [null, false, 0, 'forever', String(NOW + 60000), {}, [], NaN, Infinity, NOW, NOW - 1, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
  test('Round26: supplied invalid expiry is rejected before state writes: ' + String(expiresAt), async () => {
    const f = fixture('seed-superagent')
    const result = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'], expiresAt } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
    assert.deepEqual(f.mutations(), [])
  })
}

test('Round26: omitted expiry defaults to six hours; valid explicit expiry remains inferred', async () => {
  for (const expiry of [undefined, NOW + 60000]) {
    const f = fixture('seed-superagent')
    const result = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'], ...(expiry === undefined ? {} : { expiresAt: expiry }) } })
    assert.equal(result.ok, true)
    assert.equal(result.confirmed, false)
    assert.equal(result.requiresConfirmation, true)
    const mandate = JSON.parse(f.files.get(STATE)).mandates[0]
    assert.equal(mandate.expiresAt, expiry ?? NOW + 21600000)
    assert.equal(mandate.scope.expiresAt, mandate.expiresAt)
    assert.equal((await f.run({ action: 'confirm', mandateId: result.mandateId })).error, 'OWNER_SIGNATURE_REQUIRED')
    assert.equal((await f.run({ action: 'assign', ticketId: result.ticketId })).ok, false)
  }
})

test('Round26: a default expiry outside the supported date range fails before writes', async () => {
  class FarFutureClock extends Clock { static now() { return 8640000000000000 } }
  const f = fixture('seed-superagent', FarFutureClock)
  const result = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'] } })
  assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
  assert.deepEqual(f.mutations(), [])
})

test('Round26: explicit expiry fits the status consumer through the final four-digit-year millisecond', async () => {
  const f = fixture('seed-superagent')
  const accepted = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'], expiresAt: LAST_STATUS_EXPIRY } })
  assert.equal(accepted.ok, true)
  const status = await f.run({ action: 'status' })
  assert.equal(status.mandates[0].expiry, '9999-12-31T23:59:59.999Z')
  assert.equal(parseStatus(status, 'auma_superagent', NOW).ok, true)
})

for (const expiresAt of [LAST_STATUS_EXPIRY + 1, 8640000000000000]) {
  test('Round26: extended-year expiry cannot mint a mandate unreadable by the status consumer: ' + expiresAt, async () => {
    const f = fixture('seed-superagent')
    const result = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'], expiresAt } })
    if (result.ok) assert.equal(parseStatus(await f.run({ action: 'status' }), 'auma_superagent', NOW).ok, true, 'An accepted expiry must remain readable by the actual status consumer')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
    assert.deepEqual(f.mutations(), [])
  })
}

test('Round26: the default expiry is checked at the status consumer upper boundary', async () => {
  for (const overflow of [0, 1]) {
    class BoundaryClock extends Clock { static now() { return LAST_STATUS_EXPIRY - 21600000 + overflow } }
    const f = fixture('seed-superagent', BoundaryClock)
    const result = await f.run({ action: 'eval_accept', scope: { organs: ['fixture'] } })
    assert.equal(result.ok, overflow === 0)
    if (overflow === 0) {
      const status = await f.run({ action: 'status' })
      assert.equal(status.mandates[0].expiry, '9999-12-31T23:59:59.999Z')
      assert.equal(parseStatus(status, 'auma_superagent', NOW).ok, true)
    } else {
      assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
      assert.deepEqual(f.mutations(), [])
    }
  }
})

for (const expiresAt of [FIRST_STATUS_EXPIRY - 1, LAST_STATUS_EXPIRY + 1]) {
  test('Round26: persisted extended-year expiry is refused before formatting or mutation: ' + expiresAt, async () => {
    const f = fixture('seed-superagent'), raw = JSON.stringify(stored(expiresAt)); f.files.set(STATE, raw)
    for (const action of ['status', 'assign', 'confirm']) {
      const result = await f.run({ action, mandateId: 'mandate', ticketId: 'ticket' })
      assert.equal(result.ok, false)
      assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
      assert.equal(f.files.get(STATE), raw)
    }
    assert.deepEqual(f.mutations(), [])
  })
}

test('Round26: explicit strength still requires owner confirmation without minting', async () => {
  const f = fixture('seed-superagent')
  assert.equal((await f.run({ action: 'eval_accept', strength: 'explicit', scope: { organs: ['fixture'], expiresAt: NOW + 60000 } })).error, 'EXPLICIT_REQUIRES_CONFIRM')
  assert.deepEqual(f.mutations(), [])
})

for (const expiresAt of [undefined, null, 'forever', String(NOW + 60000), {}, NOW + 0.5, Number.MAX_SAFE_INTEGER]) {
  test('Round26: persisted invalid expiry is not formatted or mutated: ' + String(expiresAt), async () => {
    const f = fixture('seed-superagent'), raw = JSON.stringify(stored(expiresAt)); f.files.set(STATE, raw)
    for (const action of ['status', 'assign', 'confirm', 'trigger', 'subscribe', 'eval_accept', 'heartbeat', 'check_heartbeats', 'report', 'stop', 'outbox_flush']) {
      const result = await f.run({ action, mandateId: 'mandate', ticketId: 'ticket' })
      assert.equal(result.ok, false)
      assert.equal(result.error, 'MANDATE_EXPIRY_INVALID')
      assert.equal(f.files.get(STATE), raw)
    }
    assert.deepEqual(f.mutations(), [])
  })
}

test('Round26: historical expired mandates remain inspectable but cannot assign or confirm', async () => {
  for (const expiry of [NOW - 1, NOW, 0, -1, FIRST_STATUS_EXPIRY]) {
    const f = fixture('seed-superagent'); f.files.set(STATE, JSON.stringify(stored(expiry)))
    const status = await f.run({ action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.mandates[0].expiry, new Date(expiry).toISOString())
    assert.equal(parseStatus(status, 'auma_superagent', NOW).ok, true)
    assert.equal((await f.run({ action: 'assign', ticketId: 'ticket' })).error, 'mandate-expired')
    assert.equal((await f.run({ action: 'confirm', mandateId: 'mandate' })).error, 'mandate-expired')
    assert.deepEqual(f.mutations(), [])
  }
})

test('Round26: persisted scope expiry cannot disagree with mandate expiry', async () => {
  const f = fixture('seed-superagent'), state = stored(NOW + 60000)
  state.mandates[0].scope.expiresAt = NOW + 120000
  f.files.set(STATE, JSON.stringify(state))
  assert.equal((await f.run({ action: 'assign', ticketId: 'ticket' })).error, 'MANDATE_EXPIRY_INVALID')
  assert.deepEqual(f.mutations(), [])
})

const malformedHeads = [undefined, '{', 'null', '[]', '{}',
  ...[{ epoch: '1' }, { ballId: 'bad' }, { entries: [] }, { entries: { invalid: null } }, { entries: { invalid: {} } },
    { entries: { invalid: { specifier: 'ball:x', previousVersions: 'not-an-array' } } }, { modules: [] }]
    .map(fields => JSON.stringify({ epoch: 1, ballId: 'b'.repeat(64), entries: {}, modules: {}, ...fields }))]
for (const head of malformedHeads) test('Round26: missing or malformed audit HEAD is explicitly unreadable: ' + head, async () => {
  const f = fixture('seed-audit'); if (head !== undefined) f.files.set(HEAD, head)
  const result = await f.run({ action: 'lineage' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'HEAD_UNREADABLE')
  assert.deepEqual(f.mutations(), [])
})

test('Round26: audit HEAD read failure is structured and a valid HEAD remains readable', async () => {
  const f = fixture('seed-audit')
  f.files.set(HEAD, JSON.stringify({ epoch: 1, ballId: 'b'.repeat(64), entries: {}, modules: {} }))
  f.unreadable.add(HEAD)
  assert.equal((await f.run({ action: 'lineage' })).error, 'HEAD_UNREADABLE')
  f.unreadable.clear()
  assert.equal((await f.run({ action: 'lineage' })).ok, true)
})

const member = (file, text) => {
  const bytes = Buffer.from(text)
  return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }
}
const hello = () => member('organs/seed-hello.js', 'module.exports = { run: () => ({ ok: true, synthetic: true }) }')
const pack = files => gzipSync(JSON.stringify({ schema: 'auma.seed.v1', files }))
const badPacks = [
  ['empty gzip bytes', Buffer.alloc(0), 'PACK_EMPTY_OR_TRUNCATED'],
  ['truncated gzip', pack([hello()]).subarray(0, 20), 'PACK_EMPTY_OR_TRUNCATED'],
  ['truncated JSON', gzipSync('{"files":['), 'PACK_EMPTY_OR_TRUNCATED'],
  ['missing members', gzipSync('{}'), 'PACK_EMPTY_OR_TRUNCATED'],
  ['empty members', pack([]), 'PACK_EMPTY_OR_TRUNCATED'],
  ['missing hello', pack([member('CONTEXT.md', 'Synthetic')]), 'PACK_EMPTY_OR_TRUNCATED'],
  ['missing bytes', pack([hello(), { path: 'file' }]), 'PACK_EMPTY_OR_TRUNCATED'],
  ['bad digest after valid hello', pack([hello(), { ...member('last', 'Synthetic'), sha256: '0'.repeat(64) }]), 'PACK_MEMBER_INVALID'],
  ['bad length', pack([{ ...hello(), bytes: 1 }]), 'PACK_MEMBER_INVALID'],
  ['noncanonical base64', pack([{ ...hello(), data: hello().data + '!' }]), 'PACK_MEMBER_INVALID'],
  ...['/outside', '../outside', 'organs/../../outside', 'organs/../outside', 'organs//file', './file', 'C:/outside', 'C:\\outside', 'file\u0000name']
    .map(file => ['unsafe path ' + JSON.stringify(file), pack([hello(), member(file, 'Synthetic')]), 'PACK_PATH_INVALID']),
  ['duplicate path', pack([hello(), hello()]), 'PACK_PATH_INVALID'],
  ['case-folded duplicate', pack([hello(), member('ORGANS/SEED-HELLO.JS', 'Synthetic')]), 'PACK_PATH_INVALID'],
  ['normalized Unicode duplicate', pack([hello(), member('caf\u00e9', 'Synthetic'), member('cafe\u0301', 'Synthetic')]), 'PACK_PATH_INVALID'],
  ['file directory collision', pack([hello(), member('organs', 'Synthetic')]), 'PACK_PATH_INVALID'],
  ['case-folded file directory collision', pack([hello(), member('ORGANS', 'Synthetic')]), 'PACK_PATH_INVALID'],
]
test('Round26: extraction validates late members before creating even the target directory', async () => {
  const f = fixture('seed-boot')
  f.files.set(PACK, pack([hello(), { ...member('late', 'Synthetic'), sha256: '0'.repeat(64) }]))
  const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
  assert.deepEqual(f.mutations(), [])
  assert.equal(result.ok, false)
})
for (const [label, bytes, expected] of badPacks) test('Round26: boot rejects ' + label + ' before any extraction writes', async () => {
  const f = fixture('seed-boot'); f.files.set(PACK, bytes)
  for (const action of ['verify', 'extract']) {
    const result = await f.run({ action, packPath: PACK, target: '/synthetic/extracted' })
    assert.equal(result.ok, false)
    assert.equal(result.error, expected)
    assert.deepEqual(f.mutations(), [])
  }
})

test('Round26: valid synthetic pack verifies and extracts with its embedded hello', async () => {
  const f = fixture('seed-boot'); f.files.set(PACK, pack([hello(), member('CONTEXT.md', 'Synthetic')]))
  assert.equal((await f.run({ action: 'verify', packPath: PACK })).ok, true)
  assert.deepEqual(f.mutations(), [])
  const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
  assert.equal(result.ok, true)
  assert.equal(result.extracted, 2)
  assert.deepEqual(result.helloRun, { ok: true, synthetic: true })
  assert.equal(f.files.has('/synthetic/extracted/organs/seed-hello.js'), true)
})

for (const failure of ['missing-lstat', 'unreadable-lstat', 'incomplete-lstat']) test('Round26: extraction refuses uncertain destination metadata: ' + failure, async () => {
  const f = fixture('seed-boot'); f.files.set(PACK, pack([hello()]))
  if (failure === 'missing-lstat') delete f.fs.lstatSync
  else if (failure === 'unreadable-lstat') f.fs.lstatSync = () => { throw ioError('EACCES') }
  else f.fs.lstatSync = () => ({ isDirectory: () => true })
  const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
  assert.deepEqual(f.mutations(), [])
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PACK_DESTINATION_UNSAFE')
})

function realBootFixture(t) {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(tmpdir(), 'round26-absence-')))
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target'), outside = path.join(root, 'outside'), packPath = path.join(root, 'pack.json.gz')
  nodeFs.mkdirSync(outside)
  nodeFs.writeFileSync(packPath, pack([hello()]))
  const mutations = []
  const inside = file => {
    const absolute = path.resolve(file)
    assert.ok(absolute.startsWith(root + path.sep), 'Synthetic fixture cannot read/write outside its isolated directory')
    return absolute
  }
  const fs = {
    readFileSync: file => nodeFs.readFileSync(inside(file)),
    lstatSync(file) {
      const absolute = path.resolve(file)
      assert.ok(absolute === root || absolute.startsWith(root + path.sep) || root.startsWith(absolute.endsWith(path.sep) ? absolute : absolute + path.sep))
      return nodeFs.lstatSync(absolute)
    },
    mkdirSync(file, options) { mutations.push(['mkdir', file]); return nodeFs.mkdirSync(inside(file), options) },
    writeFileSync(file, value, options) { mutations.push(['write', file]); return nodeFs.writeFileSync(inside(file), value, options) },
  }
  const module = { exports: {} }
  runInNewContext(code('seed-boot'), { module, Buffer, Uint8Array, Blob, Response, DecompressionStream,
    require: name => { if (name === 'fs') return fs; if (name === 'path') return path; if (name === 'crypto') return crypto; throw new Error('Unapproved dependency: ' + name) },
  }, { timeout: 1000 })
  return { root, target, outside, mutations, run: args => module.exports.run({ action: 'extract', packPath, target, ...args }) }
}

for (const position of ['target', 'ancestor', 'member-directory', 'final-file', 'dangling-file', 'dangling-directory', 'hard-link', 'existing-file']) {
  test('Round26: extraction refuses a real temporary ' + position + ' destination before writes', async t => {
    const f = realBootFixture(t), outsideFile = path.join(f.outside, 'payload')
    nodeFs.writeFileSync(outsideFile, 'SYNTHETIC OUTSIDE SENTINEL')
    let target = f.target
    if (position === 'target') nodeFs.symlinkSync(f.outside, target, 'dir')
    else if (position === 'ancestor') {
      const ancestor = path.join(f.root, 'linked-parent')
      nodeFs.symlinkSync(f.outside, ancestor, 'dir'); target = path.join(ancestor, 'new-target')
    } else {
      nodeFs.mkdirSync(target)
      const organs = path.join(target, 'organs'), final = path.join(organs, 'seed-hello.js')
      if (position === 'member-directory' || position === 'dangling-directory') {
        nodeFs.symlinkSync(position === 'member-directory' ? f.outside : path.join(f.outside, 'missing'), organs, 'dir')
      } else {
        nodeFs.mkdirSync(organs)
        if (position === 'final-file' || position === 'dangling-file') nodeFs.symlinkSync(position === 'final-file' ? outsideFile : path.join(f.outside, 'missing'), final, 'file')
        else if (position === 'hard-link') nodeFs.linkSync(outsideFile, final)
        else nodeFs.writeFileSync(final, 'SYNTHETIC EXISTING FILE')
      }
    }
    const result = await f.run({ target })
    assert.deepEqual(f.mutations, [])
    assert.equal(result.ok, false)
    assert.equal(result.error, position === 'hard-link' || position === 'existing-file' ? 'PACK_DESTINATION_EXISTS' : 'PACK_DESTINATION_UNSAFE')
    assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'SYNTHETIC OUTSIDE SENTINEL')
    assert.deepEqual(nodeFs.readdirSync(f.outside), ['payload'])
  })
}

test('Round26: extraction into an ordinary isolated directory uses exclusive output creation', async t => {
  const f = realBootFixture(t)
  nodeFs.mkdirSync(f.target)
  const result = await f.run({})
  assert.equal(result.ok, true)
  assert.equal(nodeFs.readFileSync(path.join(f.target, 'organs', 'seed-hello.js'), 'utf8'), Buffer.from(hello().data, 'base64').toString())
})

test('Round26: a late extraction write failure leaves explicit failure and preserves already created members', async () => {
  const f = fixture('seed-boot'); f.files.set(PACK, pack([hello(), member('late', 'Synthetic')]))
  const write = f.fs.writeFileSync
  f.fs.writeFileSync = (file, bytes, options) => {
    assert.equal(options.flag, 'wx')
    if (file.endsWith('/late')) throw ioError('EIO')
    write(file, bytes, options)
  }
  const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'EIO')
  assert.equal(result.outcome, 'partial')
  assert.equal(result.extracted, 1)
  assert.deepEqual(result.createdFiles, ['organs/seed-hello.js'])
  assert.equal(result.effectsUncertain, true)
  assert.equal(f.files.has('/synthetic/extracted/organs/seed-hello.js'), true)
  assert.equal(f.files.has('/synthetic/extracted/late'), false)
  assert.equal(f.mutations().some(([event]) => event === 'unlink'), false)
})

test('Round26: a failed first write may have created bytes and reports unknown effects', async () => {
  const f = fixture('seed-boot'); f.files.set(PACK, pack([hello()]))
  const write = f.fs.writeFileSync
  f.fs.writeFileSync = (file, bytes, options) => { write(file, bytes, options); throw ioError('EIO') }
  const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.extracted, 0)
  assert.equal(result.effectsUncertain, true)
  assert.equal(f.files.has('/synthetic/extracted/organs/seed-hello.js'), true)
  assert.equal(f.mutations().some(([event]) => event === 'unlink'), false)
})

for (const source of ['module.exports = { run: () => { throw new Error("Synthetic hello failure") } }',
  'module.exports = { run: async () => { throw new Error("Synthetic async hello failure") } }',
  'module.exports = { run: () => ({ ok: false }) }']) {
  test('Round26: embedded hello failure reports preserved extracted files: ' + source, async () => {
    const f = fixture('seed-boot'); f.files.set(PACK, pack([member('organs/seed-hello.js', source)]))
    const result = await f.run({ action: 'extract', packPath: PACK, target: '/synthetic/extracted' })
    assert.equal(result.ok, false)
    assert.equal(result.outcome, 'partial')
    assert.equal(result.extracted, 1)
    assert.equal(result.stage, 'hello')
    assert.equal(result.effectsUncertain, true)
    assert.equal(f.files.has('/synthetic/extracted/organs/seed-hello.js'), true)
    assert.equal(f.mutations().some(([event]) => event === 'unlink'), false)
  })
}

for (const localCopy of [true, false]) test('Round26: seed producer retains one running seed and emits a boot-verifiable pack: local copy ' + localCopy, async () => {
  const f = fixture('seed'), seedBytes = 'module.exports = { run: () => ({ synthetic: true }) }'
  f.files.set('/dsh/home/auma/seed/organs/seed-hello.js', Buffer.from(hello().data, 'base64'))
  if (localCopy) f.files.set('/dsh/home/auma/seed/organs/seed.js', seedBytes)
  f.files.set('/dsh/home/organs/' + 'a'.repeat(64) + '.js', seedBytes)
  f.ctx.organs = { list: () => [{ name: 'seed', sha256: 'a'.repeat(64) }] }
  const produced = await f.run({ action: 'pack' })
  assert.equal(produced.ok, true)
  assert.equal(produced.files.filter(file => file.path === 'organs/seed.js').length, 1)
  const boot = fixture('seed-boot'); boot.files.set(PACK, f.files.get(produced.file))
  const verified = await boot.run({ action: 'verify', packPath: PACK })
  assert.equal(verified.ok, true)
  assert.equal(verified.files.find(file => file.path === 'organs/seed.js').sha256, member('organs/seed.js', seedBytes).sha256)
  assert.deepEqual(boot.mutations(), [])
})

test('Round26: seed producer refuses conflicting duplicate seed bytes before writes', async () => {
  const f = fixture('seed')
  f.files.set('/dsh/home/auma/seed/organs/seed-hello.js', Buffer.from(hello().data, 'base64'))
  f.files.set('/dsh/home/auma/seed/organs/seed.js', 'LOCAL SYNTHETIC SEED')
  f.files.set('/dsh/home/organs/' + 'a'.repeat(64) + '.js', 'DIFFERENT SYNTHETIC SEED')
  f.ctx.organs = { list: () => [{ name: 'seed', sha256: 'a'.repeat(64) }] }
  const result = await f.run({ action: 'pack' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PACK_DUPLICATE_CONFLICT')
  assert.deepEqual(f.mutations(), [])
})

for (const mode of ['missing', 'unreadable', 'directory', 'oversized']) test('Round26: NORTHSTAR ' + mode + ' is a per-limb failure without changing aggregate collection success', async () => {
  const f = fixture('auma-body-map')
  if (mode === 'unreadable') { f.files.set(NORTHSTARS[0], 'SECRET SYNTHETIC CONTENT'); f.unreadable.add(NORTHSTARS[0]) }
  if (mode === 'directory') f.directories.add(NORTHSTARS[0])
  if (mode === 'oversized') f.files.set(NORTHSTARS[0], 'x'.repeat(256 * 1024 + 1))
  const result = await f.run({ mode: 'afferent_probe' }), limb = result.probes.northStarInAumaOne
  assert.equal(result.ok, true)
  assert.equal(limb.ok, false)
  assert.equal(limb.status, 'DEAD')
  assert.equal(limb.error, mode === 'missing' ? 'NORTHSTAR_MISSING' : 'NORTHSTAR_UNREADABLE')
  assert.deepEqual(result.limbs, result.probes)
  assert.equal(JSON.stringify(result).includes('SECRET SYNTHETIC CONTENT'), false)
  if (mode === 'oversized') assert.equal(f.events.some(([event, file]) => event === 'read' && file === NORTHSTARS[0]), false)
})

test('Round26: readable NORTHSTAR fallback stays live without exposing text', async () => {
  const f = fixture('auma-body-map')
  f.files.set(NORTHSTARS[0], 'SECRET SYNTHETIC CONTENT'); f.unreadable.add(NORTHSTARS[0])
  f.files.set(NORTHSTARS[1], 'READABLE SYNTHETIC CONTENT')
  const result = await f.run({ mode: 'full' })
  assert.equal(result.probes.northStarInAumaOne.ok, true)
  assert.equal(result.probes.northStarInAumaOne.status, 'LIVE')
  assert.equal(JSON.stringify(result).includes('SYNTHETIC CONTENT'), false)
  assert.equal(f.events.some(([event, file]) => event === 'read' && file === NORTHSTARS[1]), true)
})

test('Round26: NORTHSTAR permission failure is unreadable even when existsSync returns false', async () => {
  const f = fixture('auma-body-map'), stat = f.fs.statSync
  f.fs.existsSync = () => false
  f.fs.statSync = file => { if (file === NORTHSTARS[0]) throw ioError('EACCES'); return stat(file) }
  const result = await f.run({ mode: 'afferent_probe' })
  assert.equal(result.probes.northStarInAumaOne.error, 'NORTHSTAR_UNREADABLE')
  assert.equal(result.probes.northStarInAumaOne.detail.sources[0].exists, null)
})

test('Round26: NORTHSTAR size is rechecked on the opened descriptor before reading', async () => {
  const f = fixture('auma-body-map'), events = []
  f.files.set(NORTHSTARS[0], 'Synthetic')
  f.fs.openSync = () => { events.push('open'); return 5 }
  f.fs.fstatSync = () => ({ isFile: () => true, size: 256 * 1024 + 1 })
  f.fs.readSync = () => { events.push('read'); return 1 }
  f.fs.closeSync = () => { events.push('close') }
  const result = await f.run({ mode: 'afferent_probe' })
  assert.equal(result.probes.northStarInAumaOne.error, 'NORTHSTAR_UNREADABLE')
  assert.deepEqual(events, ['open', 'close'])
})

for (const fails of [false, true]) test('Round26: NORTHSTAR descriptor read is bounded and closed on ' + (fails ? 'failure' : 'success'), async () => {
  const f = fixture('auma-body-map'), descriptorEvents = []
  f.files.set(NORTHSTARS[0], 'SECRET SYNTHETIC CONTENT')
  f.fs.openSync = (file, mode) => { assert.equal(file, NORTHSTARS[0]); assert.equal(mode, 'r'); descriptorEvents.push('open'); return 5 }
  f.fs.fstatSync = fd => { assert.equal(fd, 5); return f.fs.statSync(NORTHSTARS[0]) }
  f.fs.readSync = (fd, bytes, offset, length, position) => {
    assert.equal(fd, 5); assert.equal(bytes.length, 1); assert.equal(offset, 0); assert.equal(length, 1); assert.equal(position, 0)
    descriptorEvents.push('read')
    if (fails) throw ioError('EACCES')
    bytes[0] = 83
    return 1
  }
  f.fs.closeSync = fd => { assert.equal(fd, 5); descriptorEvents.push('close') }
  const result = await f.run({ mode: 'afferent_probe' })
  assert.equal(result.probes.northStarInAumaOne.ok, !fails)
  if (fails) assert.equal(result.probes.northStarInAumaOne.error, 'NORTHSTAR_UNREADABLE')
  assert.deepEqual(descriptorEvents, ['open', 'read', 'close'])
  assert.equal(f.events.some(([event, file]) => event === 'read' && file === NORTHSTARS[0]), false)
  assert.equal(JSON.stringify(result).includes('SECRET SYNTHETIC CONTENT'), false)
})
