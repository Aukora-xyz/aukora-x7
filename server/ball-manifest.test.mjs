/** Synthetic manifest compatibility: temporary local stores and in-memory edge storage, no live state. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { legacyManifestPreimage, validateManifestStructure } from './ball-manifest.mjs'
import { createBallHeadStore } from './ball-head.mjs'
import { canonicalBootstrap, createDurableHeadStore, manifestId, manifestIdCanon, validateManifest } from '../deploy/cloudflare/src/head-do.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
// These literal preimages and SHA-256 values do not use the implementation under test.
const vectors = [
  {
    name: 'empty genesis',
    json: '{"version":"x6.1-ball/v1","parentBallId":null,"epoch":0,"entries":{},"modules":{}}',
    legacy: '{"version":"x6.1-ball/v1","parentBallId":null,"epoch":0,"entries":[],"modules":[]}',
    canonical: '{"entries":{},"epoch":0,"modules":{},"parentBallId":null,"version":"x6.1-ball/v1"}',
    legacyId: '09ac6c55b896d82c9752606affa7f0635eafb6bbe1086c7d0a72df8bd82095bb',
    canonicalId: '25393780b09a9791247c8342bd7418ca117f5768d9518ee87cf74ea4f48e0b38',
  },
  {
    name: 'Unicode, history and unknown metadata',
    json: '{"version":"x6.1-ball/v1","parentBallId":null,"epoch":7,"entries":{"z":{"id":"z","specifier":"pkg:z","disabled":false,"config":{"β":"雪🌱","a":1},"previousSpecifiers":["pkg:old"],"previousVersions":[{"specifier":"pkg:older","disabled":true,"config":{"kept":true}}]},"a":{"id":"a","specifier":"pkg:a","disabled":true,"config":{},"previousSpecifiers":[]}},"modules":{},"authorPeerId":"synthetic:owner","createdAt":123,"extra":{"z":2,"a":1}}',
    legacy: '{"version":"x6.1-ball/v1","parentBallId":null,"epoch":7,"entries":[{"id":"a","specifier":"pkg:a","disabled":true,"config":{},"previousSpecifiers":[]},{"id":"z","specifier":"pkg:z","disabled":false,"config":{"β":"雪🌱","a":1},"previousSpecifiers":["pkg:old"],"previousVersions":[{"specifier":"pkg:older","disabled":true,"config":{"kept":true}}]}],"modules":[]}',
    canonical: '{"authorPeerId":"synthetic:owner","createdAt":123,"entries":{"a":{"config":{},"disabled":true,"id":"a","previousSpecifiers":[],"specifier":"pkg:a"},"z":{"config":{"a":1,"β":"雪🌱"},"disabled":false,"id":"z","previousSpecifiers":["pkg:old"],"previousVersions":[{"config":{"kept":true},"disabled":true,"specifier":"pkg:older"}],"specifier":"pkg:z"}},"epoch":7,"extra":{"a":1,"z":2},"modules":{},"parentBallId":null,"version":"x6.1-ball/v1"}',
    legacyId: 'cd5819e03fad1d3fe08e8ff0d63b8aa33726939c4218245af6b6e004ad2c4755',
    canonicalId: '9282c4d8066c3a5efa3a6b9193b093a77dee6239abfc993a891bc32aa473adb6',
  },
]

// Frozen pre-extraction algorithms identify additional synthetic inputs independently of the shared leaf.
const oldLegacyId = ball => hash(JSON.stringify({
  version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]),
}))
const oldLocalCanonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => oldLocalCanonical(item === undefined ? null : item)).join(',') + ']'
  return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + oldLocalCanonical(value[key])).join(',') + '}'
}
const oldLocalCanonicalId = ball => {
  const { ballId: _ignore, ...rest } = ball
  return hash(oldLocalCanonical(rest))
}
const candidate = (vector = vectors[0], form = 'legacy') => ({ ...JSON.parse(vector.json), ballId: vector[`${form}Id`] })
const entry = id => ({ id, specifier: 'package:' + id, disabled: false, config: {}, previousSpecifiers: [] })
const identify = ball => ({ ...ball, ballId: oldLegacyId(ball) })

async function localFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x61-manifest-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const ballsDir = path.join(root, 'balls'), homeBallsDir = path.join(root, 'home-balls')
  await fs.mkdir(ballsDir)
  await fs.mkdir(homeBallsDir)
  return { root, ballsDir, homeBallsDir, store: createBallHeadStore({ ballsDir, homeBallsDir }) }
}

function edgeFixture(ball, codeBySha = {}) {
  let rows = new Map([
    ['head', ball.ballId], [`manifest:${ball.ballId}:count`, 1], [`manifest:${ball.ballId}:0`, JSON.stringify(ball)],
    ...Object.entries(codeBySha).flatMap(([sha, code]) => [[`module:${sha}:count`, 1], [`module:${sha}:0`, code]]),
  ])
  const storage = { transaction: async operation => {
    const staged = structuredClone(rows)
    const result = await operation({
      get: async key => structuredClone(staged.get(key)),
      put: async (key, value) => staged.set(key, structuredClone(value)),
      delete: async key => staged.delete(key),
      list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...staged].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    })
    rows = staged
    return result
  } }
  return { store: createDurableHeadStore(storage), snapshot: () => structuredClone(rows) }
}

for (const vector of vectors) test(`both hosts retain literal legacy and canonical IDs: ${vector.name}`, async t => {
  const local = await localFixture(t)
  assert.equal(hash(vector.legacy), vector.legacyId)
  assert.equal(hash(vector.canonical), vector.canonicalId)
  for (const form of ['legacy', 'canonical']) {
    const ball = candidate(vector, form)
    assert.equal(legacyManifestPreimage(ball), vector.legacy)
    assert.equal(validateManifestStructure(ball), null)
    assert.equal(await manifestId(ball), vector.legacyId)
    assert.equal(await manifestIdCanon(ball), vector.canonicalId)
    assert.equal(await validateManifest(ball), null)
    const serialized = JSON.stringify(ball, null, 2) + '\n'
    await fs.writeFile(path.join(local.ballsDir, 'HEAD.json'), serialized)
    assert.deepEqual(await local.store.read(), ball)
    assert.equal(await fs.readFile(path.join(local.ballsDir, 'HEAD.json'), 'utf8'), serialized)
    const edge = edgeFixture(ball), before = edge.snapshot()
    assert.deepEqual((await edge.store.read()).ball, ball)
    assert.equal((await edge.store.publish({ ball })).idempotent, true)
    assert.deepEqual(edge.snapshot(), before)
  }
  assert.ok(manifestId(candidate(vector)) instanceof Promise)
  assert.ok(validateManifest(candidate(vector)) instanceof Promise)
})

test('legacy sorting is lexical only at map keys, while canonical identity binds all root metadata', async t => {
  const ball = candidate(vectors[1]), local = await localFixture(t)
  ball.entries = { a: ball.entries.a, z: ball.entries.z }
  assert.equal(legacyManifestPreimage(ball), vectors[1].legacy)
  ball.entries.z.config = { a: 1, β: '雪🌱' }
  assert.notEqual(await manifestId(ball), vectors[1].legacyId)
  assert.equal(await manifestIdCanon(ball), vectors[1].canonicalId)
  assert.equal(await validateManifest(ball), 'MANIFEST_HASH_MISMATCH')
  assert.equal((await local.store.publish({ ball })).code, 'MANIFEST_HASH_MISMATCH')
  ball.ballId = vectors[1].canonicalId
  assert.equal(await validateManifest(ball), null)
  assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
  const metadataOnly = { ...candidate(vectors[1]), authorPeerId: 'another:author', createdAt: 456, recovery: { retained: true } }
  assert.equal(await manifestId(metadataOnly), vectors[1].legacyId)
  assert.notEqual(await manifestIdCanon(metadataOnly), vectors[1].canonicalId)
  assert.equal(await validateManifest(metadataOnly), null)
  metadataOnly.ballId = vectors[1].canonicalId
  assert.equal(await validateManifest(metadataOnly), 'MANIFEST_HASH_MISMATCH')
  assert.equal((await local.store.publish({ ball: metadataOnly })).code, 'MANIFEST_HASH_MISMATCH')
  const lexical = identify({ ...candidate(), entries: { 2: entry('2'), 10: entry('10') } })
  assert.equal(legacyManifestPreimage(lexical), '{"version":"x6.1-ball/v1","parentBallId":null,"epoch":0,"entries":[{"id":"10","specifier":"package:10","disabled":false,"config":{},"previousSpecifiers":[]},{"id":"2","specifier":"package:2","disabled":false,"config":{},"previousSpecifiers":[]}],"modules":[]}')
})

test('module maps preserve metadata order and historical references in local publication and edge reads', async t => {
  const first = 'export default "雪"\n', second = 'export default "🌱"\n'
  const firstSha = hash(first), secondSha = hash(second)
  const meta = sha => ({ sha256: sha, specifier: `ball:${sha}`, extra: { retained: true } })
  const ball = identify({ ...candidate(), authorPeerId: 'synthetic:writer',
    entries: { organ: { ...entry('organ'), specifier: `ball:${firstSha}`,
      previousSpecifiers: [`ball:${secondSha}`], previousVersions: [{ specifier: `ball:${secondSha}`, config: {}, disabled: true }] } },
    modules: { [secondSha]: meta(secondSha), [firstSha]: meta(firstSha) } })
  const reverse = { ...ball, modules: Object.fromEntries(Object.entries(ball.modules).reverse()) }
  assert.equal(await manifestId(reverse), ball.ballId)
  const reordered = structuredClone(ball)
  reordered.modules[firstSha] = { extra: { retained: true }, specifier: `ball:${firstSha}`, sha256: firstSha }
  assert.notEqual(await manifestId(reordered), ball.ballId)
  assert.equal(await manifestIdCanon(reordered), await manifestIdCanon(ball))
  const local = await localFixture(t)
  const lease = await local.store.lease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
  const result = await local.store.publish({ ball, codeBySha: { [firstSha]: first, [secondSha]: second },
    expectedParentBallId: null, expectedEpoch: -1, writerLease: lease.lease })
  assert.equal(result.ok, true)
  assert.equal(result.ballId, ball.ballId)
  assert.deepEqual(await local.store.read(), ball)
  for (const directory of [local.ballsDir, local.homeBallsDir]) {
    assert.equal(await fs.readFile(path.join(directory, 'HEAD.json'), 'utf8'), JSON.stringify(ball, null, 2) + '\n')
    assert.equal(await fs.readFile(path.join(directory, firstSha + '.js'), 'utf8'), first)
    assert.equal(await fs.readFile(path.join(directory, secondSha + '.js'), 'utf8'), second)
  }
  const edge = edgeFixture(ball, { [firstSha]: first, [secondSha]: second })
  assert.deepEqual((await edge.store.read()).codeBySha, { [firstSha]: first, [secondSha]: second })
  assert.equal((await edge.store.publish({ ball })).idempotent, true)
})

test('structural failure codes and precedence remain identical through both host validators', async t => {
  const local = await localFixture(t), sha = 'a'.repeat(64)
  const base = () => ({ ...candidate(), entries: { organ: entry('organ') } })
  const cases = [
    ['null', () => null, 'INVALID_MANIFEST'], ['array', () => [], 'INVALID_MANIFEST'],
    ...[
      { version: 'x63/v1' }, { ballId: 'A'.repeat(64) }, { parentBallId: undefined }, { parentBallId: 'short' },
      { epoch: -1 }, { epoch: 0.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 }, { epoch: NaN },
      { entries: [] }, { modules: [] },
    ].map((change, index) => ['manifest ' + index, () => ({ ...base(), ...change }), 'INVALID_MANIFEST']),
    ...[
      { id: 'wrong' }, { specifier: '' }, { disabled: 0 }, { config: [] }, { previousSpecifiers: null },
      { previousSpecifiers: [''] }, { previousVersions: null }, { previousVersions: [{}] },
    ].map((change, index) => ['entry ' + index, () => ({ ...base(), entries: { organ: { ...entry('organ'), ...change } } }), 'INVALID_ENTRY']),
    ['current module', () => ({ ...base(), entries: { organ: { ...entry('organ'), specifier: `ball:${sha}` } } }), 'MODULE_MISSING'],
    ['old specifier', () => ({ ...base(), entries: { organ: { ...entry('organ'), previousSpecifiers: [`ball:${sha}`] } } }), 'MODULE_MISSING'],
    ['old version', () => ({ ...base(), entries: { organ: { ...entry('organ'), previousVersions: [{ specifier: `ball:${sha}`, config: {}, disabled: true }] } } }), 'MODULE_MISSING'],
    ['malformed reference', () => ({ ...base(), entries: { organ: { ...entry('organ'), specifier: 'ball:short' } } }), 'MODULE_MISSING'],
    ['inherited module', () => ({ ...base(), entries: { organ: { ...entry('organ'), specifier: `ball:${sha}` } }, modules: Object.create({ [sha]: { sha256: sha, specifier: `ball:${sha}` } }) }), 'MODULE_MISSING'],
    ...[null, [], { sha256: 'b'.repeat(64), specifier: `ball:${sha}` }, { sha256: sha, specifier: 'wrong' }]
      .map((meta, index) => ['module metadata ' + index, () => ({ ...base(), modules: { [sha]: meta } }), 'INVALID_MODULE']),
    ['module key', () => ({ ...base(), modules: { invalid: {} } }), 'INVALID_MODULE'],
    ['manifest before entry', () => ({ ...base(), epoch: -1, entries: { organ: null } }), 'INVALID_MANIFEST'],
    ['entry before module', () => ({ ...base(), entries: { organ: null }, modules: { invalid: {} } }), 'INVALID_ENTRY'],
    ['reference before later entry', () => ({ ...base(), entries: { organ: { ...entry('organ'), specifier: `ball:${sha}` }, later: null }, modules: { invalid: {} } }), 'MODULE_MISSING'],
    ['entry before its reference', () => ({ ...base(), entries: { organ: { ...entry('organ'), disabled: null, specifier: `ball:${sha}` } } }), 'INVALID_ENTRY'],
    ['module before hash', () => ({ ...base(), modules: { invalid: {} }, ballId: '0'.repeat(64) }), 'INVALID_MODULE'],
  ]
  for (const [name, build, code] of cases) {
    const ball = build()
    assert.equal(validateManifestStructure(ball), code, name)
    assert.equal(await validateManifest(ball), code, name)
    assert.equal((await local.store.publish({ ball })).code, code, name)
  }
  const wrongHash = { ...candidate(), ballId: '0'.repeat(64) }
  assert.equal(validateManifestStructure(wrongHash), null)
  assert.equal(await validateManifest(wrongHash), 'MANIFEST_HASH_MISMATCH')
  assert.equal((await local.store.publish({ ball: wrongHash })).code, 'MANIFEST_HASH_MISMATCH')
  assert.deepEqual(await fs.readdir(local.ballsDir), [])
})

test('unknown fields, non-ball specifiers, broad objects and uncoupled valid parent/epoch remain admitted', async t => {
  const local = await localFixture(t)
  const ownNames = JSON.parse('{"__proto__":{"id":"__proto__","specifier":"free:form","disabled":false,"config":{},"previousSpecifiers":[]},"constructor":{"id":"constructor","specifier":"anything","disabled":true,"config":{},"previousSpecifiers":[]}}')
  const inputs = [
    { ...candidate(), entries: ownNames },
    { ...candidate(), parentBallId: 'a'.repeat(64), epoch: 0 },
    { ...candidate(), parentBallId: null, epoch: Number.MAX_SAFE_INTEGER },
    { ...candidate(), entries: { organ: { ...entry('organ'), previousVersions: undefined, governance: 'legacy-value', unknown: true } } },
    { ...candidate(), entries: { organ: { ...entry('organ'), config: Object.create(null) } }, authorPeerId: null, createdAt: 'historical' },
    { ...candidate(), entries: Object.create(null), modules: Object.create(null) },
  ]
  for (const input of inputs) {
    const ball = identify(input)
    assert.equal(validateManifestStructure(ball), null)
    assert.equal(await validateManifest(ball), null)
    assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
  }
})

test('valid legacy IDs skip canonical rejection, while edge publication still rejects non-JSON metadata', async t => {
  const local = await localFixture(t)
  const ball = { ...candidate(), extra: { omitted: undefined, array: [undefined], number: NaN } }
  assert.equal(await manifestId(ball), vectors[0].legacyId)
  assert.equal(await validateManifest(ball), null)
  assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
  assert.throws(() => manifestIdCanon(ball), /BOOTSTRAP_INVALID_VALUE/)
  const edge = edgeFixture(candidate()), before = edge.snapshot()
  assert.equal((await edge.store.publish({ ball })).code, 'INVALID_MANIFEST')
  assert.deepEqual(edge.snapshot(), before)
  ball.ballId = oldLocalCanonicalId(ball)
  assert.notEqual(ball.ballId, vectors[0].legacyId)
  assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
  await assert.rejects(validateManifest(ball), /BOOTSTRAP_INVALID_VALUE/)
  for (const extra of [undefined, NaN, Infinity, [undefined]]) {
    const canonical = { ...candidate(), extra }
    canonical.ballId = oldLocalCanonicalId(canonical)
    assert.equal((await local.store.publish({ ball: canonical })).code, 'REBASE_REQUIRED')
    await assert.rejects(validateManifest(canonical), /BOOTSTRAP_INVALID_VALUE/)
  }
})

test('bounded edge canonical depth and node limits do not become local or legacy validation limits', async t => {
  const local = await localFixture(t)
  const nest = depth => { let value = null; while (depth--) value = [value]; return value }
  assert.doesNotThrow(() => canonicalBootstrap(nest(64)))
  assert.throws(() => canonicalBootstrap(nest(65)), /BOOTSTRAP_STRUCTURE_LIMIT/)
  assert.doesNotThrow(() => canonicalBootstrap(Array(199999).fill(null)))
  assert.throws(() => canonicalBootstrap(Array(200000).fill(null)), /BOOTSTRAP_STRUCTURE_LIMIT/)
  for (const extra of [nest(65), Array(200000).fill(null)]) {
    const ball = { ...candidate(), extra }
    assert.equal(await validateManifest(ball), null)
    assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
    ball.ballId = oldLocalCanonicalId(ball)
    assert.equal((await local.store.publish({ ball })).code, 'REBASE_REQUIRED')
    await assert.rejects(validateManifest(ball), /BOOTSTRAP_STRUCTURE_LIMIT/)
  }
})
