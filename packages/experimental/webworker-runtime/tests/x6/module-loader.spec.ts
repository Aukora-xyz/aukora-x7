import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256HexSync, WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

describe('sha256HexSync', () => {
  it.each([
    ['empty', ''],
    ['abc', 'abc'],
    ['multiple blocks', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'.repeat(4)],
    ['UTF-8', '你好, café 🙂'],
  ])('matches Node crypto for %s as text and bytes', (_name, source) => {
    const expected = createHash('sha256').update(source).digest('hex')
    expect(sha256HexSync(source)).toBe(expected)
    expect(sha256HexSync(new TextEncoder().encode(source))).toBe(expected)
  })

  it('matches Node crypto for every byte value across block boundaries', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index)
    expect(sha256HexSync(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})

function fixture() {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/workspace')
  vfs.seedDirectory('/dsh/home/balls')
  const builtin = { marker: 'builtin' }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { 'node:fixture': () => builtin } })
  return { vfs, loader, require: loader.requireFrom('/dsh/workspace'), builtin }
}

describe('WorkerModuleLoader mutable file cache', () => {
  it('reuses unchanged bytes and reloads same-length rewrites without eviction', () => {
    const { vfs, require } = fixture()
    const path = '/dsh/workspace/module.js'
    vfs.writeFileSync(path, 'module.exports = { value: 1 }')
    const first = require(path)
    expect(require(path)).toBe(first)
    vfs.writeFileSync(path, 'module.exports = { value: 1 }')
    expect(require(path)).toBe(first)
    vfs.writeFileSync(path, 'module.exports = { value: 2 }')
    const second = require(path)
    expect(second).toEqual({ value: 2 })
    expect(second).not.toBe(first)
    expect(require(path)).toBe(second)
  })

  it('detects in-place byte changes that do not update VFS timestamps', () => {
    const { vfs, require } = fixture()
    const path = '/dsh/workspace/module.js'
    const source = 'module.exports = { value: 1 }'
    vfs.writeFileSync(path, source)
    require(path)
    const before = vfs.statSync(path).mtimeMs
    const bytes = vfs.readFileSync(path) as Uint8Array
    bytes[source.indexOf('1')] = '2'.charCodeAt(0)
    expect(vfs.statSync(path).mtimeMs).toBe(before)
    expect(require(path)).toEqual({ value: 2 })
  })

  it('uses one cached identity for normalized absolute, relative and file URL paths', () => {
    const { vfs, require } = fixture()
    vfs.writeFileSync('/dsh/workspace/module.js', 'module.exports = {}')
    const first = require('./module')
    for (const path of ['/dsh//workspace/./module.js', '/dsh/workspace/missing/../module.js', 'file:///dsh/workspace/%6dodule.js', '/dsh/workspace/module.js/']) {
      expect(require(path)).toBe(first)
    }
  })

  it('keeps CommonJS partial exports and unchanged dependency identities through cycles', () => {
    const { vfs, require } = fixture()
    vfs.writeFileSync('/dsh/workspace/a.js', 'exports.name = "a"; exports.b = require("./b"); exports.ready = true')
    vfs.writeFileSync('/dsh/workspace/b.js', 'exports.a = require("./a"); exports.sawReady = exports.a.ready === true')
    const a = require('./a') as { b: { a: unknown; sawReady: boolean }; ready: boolean }
    expect(a.b.a).toBe(a)
    expect(a.b.sawReady).toBe(false)
    expect(a.ready).toBe(true)
    expect(require('./a')).toBe(a)
    expect(require('./b')).toBe(a.b)
  })

  it('does not reload an evaluating ordinary module when its body rewrites itself', () => {
    const { vfs } = fixture()
    const path = '/dsh/workspace/module.js'
    const loader = new WorkerModuleLoader({ vfs, staticModules: {
      'node:rewrite': () => () => { vfs.writeFileSync(path, 'module.exports = { version: 2 }') },
    } })
    const require = loader.requireFrom('/dsh/workspace')
    vfs.writeFileSync(path, 'exports.version = 1; require("node:rewrite")(); exports.self = require("./module")')
    const first = require(path) as { self: unknown; version: number }
    expect(first.self).toBe(first)
    expect(first.version).toBe(1)
    expect(require(path)).toEqual({ version: 2 })
  })

  it('reloads directly requested dependencies without replacing cached importers or held exports', () => {
    const { vfs, loader, require } = fixture()
    vfs.writeFileSync('/dsh/workspace/parent.js', 'module.exports = { child: require("./child") }')
    vfs.writeFileSync('/dsh/workspace/child.js', 'module.exports = { value: 1 }')
    const parent = require('./parent') as { child: { value: number } }
    vfs.writeFileSync('/dsh/workspace/child.js', 'module.exports = { value: 2 }')
    expect(require('./parent')).toBe(parent)
    expect(parent.child.value).toBe(1)
    const child = require('./child')
    expect(child).toEqual({ value: 2 })
    expect(parent.child).not.toBe(child)
    loader.evict('/dsh/workspace/parent.js')
    expect(require('./parent')).toEqual({ child })
  })

  it('invalidates JSON and discards failed JSON replacements', () => {
    const { vfs, loader, require } = fixture()
    const path = '/dsh/workspace/value.json'
    vfs.writeFileSync(path, '{"value":1}')
    const first = require(path)
    expect(require(path)).toBe(first)
    vfs.writeFileSync(path, '{"value":2}')
    expect(require(path)).toEqual({ value: 2 })
    vfs.writeFileSync(path, '{')
    expect(() => require(path)).toThrow()
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, '{"value":1}')
    expect(require(path)).toEqual(first)
    expect(require(path)).not.toBe(first)
  })

  it.each(['throw new Error("broken")', 'const = ;'])('discards failed replacement bodies and allows repair: %s', (broken) => {
    const { vfs, loader, require } = fixture()
    const path = '/dsh/workspace/module.js'
    vfs.writeFileSync(path, 'module.exports = { version: 1 }')
    const first = require(path)
    vfs.writeFileSync(path, broken)
    expect(() => require(path)).toThrow()
    expect(() => require(path)).toThrow()
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, 'module.exports = { version: 1 }')
    expect(require(path)).toEqual(first)
    expect(require(path)).not.toBe(first)
  })

  it('refuses deleted files through a prior resolution and clears their cached exports', () => {
    const { vfs, loader, require } = fixture()
    const path = '/dsh/workspace/module.js'
    vfs.writeFileSync(path, 'module.exports = {}')
    const resolution = loader.resolve(path, '/dsh')
    const first = require(path)
    vfs.unlinkSync(path)
    expect(() => loader.load(resolution)).toThrow(/ENOENT/)
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, 'module.exports = {}')
    expect(require(path)).not.toBe(first)
  })

  it('invalidates a missing source and a replaced rename destination', () => {
    const { vfs, loader, require } = fixture()
    vfs.writeFileSync('/dsh/workspace/a.js', 'module.exports = { value: "a" }')
    vfs.writeFileSync('/dsh/workspace/b.js', 'module.exports = { value: "b" }')
    require('./a')
    require('./b')
    vfs.renameSync('/dsh/workspace/a.js', '/dsh/workspace/b.js')
    expect(() => require('./a')).toThrow(/cannot resolve/)
    expect(require('./b')).toEqual({ value: 'a' })
    expect(loader.usage().modules).toBe(1)
  })

  it('preserves builtin identity, ESM lowering and explicit eviction', () => {
    const { vfs, loader, require, builtin } = fixture()
    expect(require('fixture')).toBe(builtin)
    expect(require('node:fixture')).toBe(builtin)
    vfs.writeFileSync('/dsh/workspace/module.js', 'export const value = 1')
    const first = require('./module')
    expect(first).toMatchObject({ value: 1 })
    loader.evict('/dsh/workspace')
    expect(require('./module')).not.toBe(first)
    vfs.writeFileSync('/dsh/workspace/module.js', 'export const value = 2')
    expect(require('./module')).toMatchObject({ value: 2 })
  })
})

const ballRequests = [
  ['ball specifier', (sha: string) => `ball:${sha}`],
  ['absolute path', (sha: string) => `/dsh/home/balls/${sha}.js`],
  ['relative path', (sha: string) => `../home/balls/${sha}.js`],
  ['file URL', (sha: string) => `file:///dsh/home/balls/${sha}.js`],
  ['normalized alias', (sha: string) => `/dsh//home/balls/absent/../${sha}.js/`],
  ['extension probe', (sha: string) => `/dsh/home/balls/${sha}`],
  ['encoded file URL', (sha: string) => `file:///dsh/home/%62alls%2F${sha}.js`],
] as const

const ballFilenameCases = [
  ['uppercase', (sha: string) => sha.toUpperCase()],
  ['mixed-case', (sha: string) => sha.replace(/[a-f]/, letter => letter.toUpperCase())],
] as const

describe('WorkerModuleLoader content-addressed ball integrity', () => {
  it.each(ballFilenameCases)('rejects tampered %s filenames before a cold file load', (_name, filenameSha) => {
    const { vfs, loader, require } = fixture()
    const source = 'module.exports = { value: 1 }'
    const path = `/dsh/home/balls/${filenameSha(sha256HexSync(source))}.js`
    vfs.writeFileSync(path, 'throw new Error("unverified bytes executed")')
    expect(loader.resolve(path, '/dsh')).toEqual({ kind: 'file', path })
    expect(() => require(path)).toThrow(/Ball integrity check failed/)
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, source)
    expect(require(path)).toEqual({ value: 1 })
  })

  it.each(ballFilenameCases)('rechecks %s filenames before cached file reuse', (_name, filenameSha) => {
    const { vfs, loader, require } = fixture()
    const source = 'module.exports = { value: 1 }'
    const path = `/dsh/home/balls/${filenameSha(sha256HexSync(source))}.js`
    vfs.writeFileSync(path, source)
    const resolution = loader.resolve(path, '/dsh')
    expect(resolution).toEqual({ kind: 'file', path })
    const first = require(path)
    expect(first).toEqual({ value: 1 })
    expect(require(path)).toBe(first)
    const view = vfs.readFileSync(path) as Uint8Array
    view[source.indexOf('1')] = '2'.charCodeAt(0)
    expect(() => require(path)).toThrow(/Ball integrity check failed/)
    expect(() => loader.load(resolution)).toThrow(/Ball integrity check failed/)
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, source)
    expect(require(path)).toEqual(first)
    expect(require(path)).not.toBe(first)
  })

  it.each(ballRequests)('checks current bytes before a cold load or cache hit through %s', (_name, request) => {
    const { vfs, loader, require } = fixture()
    const source = 'module.exports = { value: "verified" }'
    const sha = sha256HexSync(source)
    const path = `/dsh/home/balls/${sha}.js`
    vfs.writeFileSync(path, 'throw new Error("unverified bytes executed")')
    expect(() => require(request(sha))).toThrow(/Ball integrity check failed/)
    vfs.writeFileSync(path, source)
    const first = require(request(sha))
    expect(first).toEqual({ value: 'verified' })
    vfs.writeFileSync(path, 'throw new Error("unverified bytes executed")')
    expect(() => require(request(sha))).toThrow(/Ball integrity check failed/)
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, source)
    expect(require(request(sha))).toEqual(first)
  })

  it('hashes exact stored bytes rather than decoded and re-encoded source', () => {
    const { vfs, require } = fixture()
    const source = 'module.exports = { value: 1 }; // '
    const bytes = new Uint8Array([...new TextEncoder().encode(source), 0x80])
    const sha = sha256HexSync(bytes)
    const path = `/dsh/home/balls/${sha}.js`
    vfs.writeFileSync(path, bytes)
    expect(require(`ball:${sha}`)).toEqual({ value: 1 })
    require(path)
    const view = vfs.readFileSync(path) as Uint8Array
    view[view.length - 1] = 0x81
    expect(() => require(path)).toThrow(/Ball integrity check failed/)
  })

  it('refuses a tampered full path even when valid exports were already cached', () => {
    const { vfs, loader, require } = fixture()
    const source = 'module.exports = { value: 1 }'
    const sha = sha256HexSync(source)
    const path = `/dsh/home/balls/${sha}.js`
    vfs.writeFileSync(path, source)
    const first = require(path)
    const resolution = loader.resolve(path, '/dsh')
    const view = vfs.readFileSync(path) as Uint8Array
    view[source.indexOf('1')] = '2'.charCodeAt(0)
    expect(() => loader.load(resolution)).toThrow(/Ball integrity check failed/)
    expect(() => require(path)).toThrow(/Ball integrity check failed/)
    expect(loader.usage().modules).toBe(0)
    vfs.writeFileSync(path, source)
    expect(require(path)).toEqual(first)
    expect(require(path)).not.toBe(first)
  })

  it('retains fresh ball-specifier evaluation and cached full-path identity', () => {
    const { vfs, require } = fixture()
    const source = 'module.exports = {}'
    const sha = sha256HexSync(source)
    const path = `/dsh/home/balls/${sha}.js`
    vfs.writeFileSync(path, source)
    const first = require(path)
    expect(require(path)).toBe(first)
    expect(require(`ball:${sha}`)).not.toBe(require(`ball:${sha}`))
    expect(require(path)).toBe(first)
  })

  it('verifies paths resolved from package main and internal imports under a normalized root', async () => {
    const { vfs } = fixture()
    const source = 'module.exports = { value: 1 }'
    const sha = sha256HexSync(source)
    const path = `/dsh/home/balls/${sha}.js`
    vfs.writeFileSync(path, source)
    vfs.seedDirectory('/dsh/node_modules/pkg')
    vfs.writeFileSync('/dsh/node_modules/pkg/package.json', JSON.stringify({ main: `../../home/balls/${sha}.js` }))
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh/alias/../', staticModules: {} })
    expect(loader.requireFrom('/dsh')('pkg')).toEqual({ value: 1 })
    vfs.writeFileSync(path, 'module.exports = { value: 2 }')
    expect(() => loader.requireFrom('/dsh')('pkg')).toThrow(/Ball integrity check failed/)
    await expect(loader.internal.import(`file://${path}`)).rejects.toThrow(/Ball integrity check failed/)
  })
})
