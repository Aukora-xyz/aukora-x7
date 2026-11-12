'use strict'
// seed-boot — verify a seed pack and extract it into a disposable directory, then run an embedded organ.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const HEX = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (b) => HEX(await crypto.webcrypto.subtle.digest('SHA-256', b))
const invalidPack = (code, reason) => Object.assign(new Error(code), { code, reason })
async function load(packPath) {
  const gz = fs.readFileSync(packPath)
  let raw, j
  try {
    raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    j = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch (error) { throw invalidPack('PACK_EMPTY_OR_TRUNCATED', 'gzip-or-json-unreadable') }
  if (!j || !Array.isArray(j.files) || j.files.length === 0) throw invalidPack('PACK_EMPTY_OR_TRUNCATED', 'files-missing')
  const files = []
  const paths = new Set()
  const portablePaths = new Set()
  for (const f of j.files) {
    if (!f || typeof f.path !== 'string' || typeof f.data !== 'string' || typeof f.sha256 !== 'string'
      || !Number.isSafeInteger(f.bytes) || f.bytes < 0) throw invalidPack('PACK_EMPTY_OR_TRUNCATED', 'member-incomplete')
    const portablePath = f.path.normalize('NFC').toLowerCase()
    if (!f.path || path.isAbsolute(f.path) || /[\\:\u0000]/.test(f.path)
      || f.path.split('/').some(part => !part || part === '.' || part === '..') || portablePaths.has(portablePath)) {
      throw invalidPack('PACK_PATH_INVALID', 'unsafe-or-duplicate-path')
    }
    paths.add(f.path)
    portablePaths.add(portablePath)
    const b = Buffer.from(f.data, 'base64')
    const h = await sha(b)
    const good = h === f.sha256 && b.length === f.bytes && b.toString('base64') === f.data
    if (!good) throw invalidPack('PACK_MEMBER_INVALID', 'digest-length-or-encoding-mismatch')
    files.push({ path: f.path, sha256: h, bytes: b.length, good, bytesBuf: b })
  }
  for (const file of portablePaths) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) if (portablePaths.has(parts.slice(0, i).join('/'))) throw invalidPack('PACK_PATH_INVALID', 'file-directory-collision')
  }
  if (!paths.has('organs/seed-hello.js')) throw invalidPack('PACK_EMPTY_OR_TRUNCATED', 'seed-hello-missing')
  return { ok: true, packSha256: await sha(gz), gzipBytes: gz.length, jsonBytes: raw.length, image: j, files }
}

// All existing path components are inspected without following links before any
// writes. Native concurrent ancestor replacement can still race this preflight;
// exclusive member creation prevents overwrites, not atomic whole-pack extraction.
function preflightDestination(target, files) {
  if (typeof fs.lstatSync !== 'function' || !target.trim()) throw invalidPack('PACK_DESTINATION_UNSAFE', 'destination-inspection-unavailable')
  const root = path.resolve(target)
  const checkedDirectories = new Set()
  const inspect = file => {
    let stat
    try { stat = fs.lstatSync(file) } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw invalidPack('PACK_DESTINATION_UNSAFE', 'destination-unreadable')
    }
    if (!stat || typeof stat.isSymbolicLink !== 'function' || typeof stat.isDirectory !== 'function'
      || stat.isSymbolicLink()) throw invalidPack('PACK_DESTINATION_UNSAFE', 'destination-link-or-unknown-type')
    return stat
  }
  const inspectDirectories = directory => {
    const parents = []
    let current = directory
    for (;;) {
      parents.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const parent of parents.reverse()) {
      if (checkedDirectories.has(parent)) continue
      const stat = inspect(parent)
      if (stat && !stat.isDirectory()) throw invalidPack('PACK_DESTINATION_UNSAFE', 'destination-parent-not-directory')
      checkedDirectories.add(parent)
    }
  }
  inspectDirectories(root)
  for (const file of files) {
    const destination = path.join(root, file.path)
    inspectDirectories(path.dirname(destination))
    if (inspect(destination)) throw invalidPack('PACK_DESTINATION_EXISTS', 'member-already-exists')
  }
  return root
}
module.exports = {
  name: 'seed-boot',
  description: 'Verify a nonempty seed pack with seed-hello, safe unique member paths and exact member digests. Extraction preflights the pack and destination before writes, refuses existing output files or linked paths, preserves existing directories, and creates members exclusively. Native concurrent ancestor changes and later I/O failures can leave partial extraction; this is not atomic.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['verify', 'extract'] }, packPath: { type: 'string' }, target: { type: 'string' } }, required: ['action', 'packPath'] },
  async run(args) {
    let extraction = null
    try {
      const l = await load(args.packPath)
      const base = { ok: l.ok, packSha256: l.packSha256, gzipBytes: l.gzipBytes, jsonBytes: l.jsonBytes, files: l.files.map(({ path, sha256, bytes, good }) => ({ path, sha256, bytes, good })) }
      if (args.action === 'verify') return base
      if (args.action !== 'extract') return { ok: false, error: 'unknown action' }
      const requestedTarget = typeof args.target === 'string' ? args.target : '/dsh/home/auma/seed-boot/' + new Date().toISOString().replace(/[:.]/g, '-')
      const target = preflightDestination(requestedTarget, l.files)
      extraction = { target, createdFiles: [], stage: 'mkdir' }
      fs.mkdirSync(target, { recursive: true })
      for (const f of l.files) {
        const dest = path.join(target, f.path)
        extraction.stage = 'mkdir'
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        extraction.stage = 'write'
        fs.writeFileSync(dest, f.bytesBuf, { flag: 'wx' })
        extraction.createdFiles.push(f.path)
      }
      extraction.stage = 'hello'
      const hello = l.files.find((f) => f.path === 'organs/seed-hello.js')
      const m = { exports: {} }
      new Function('module', 'exports', hello.bytesBuf.toString('utf8'))(m, m.exports)
      const helloRun = await m.exports.run({ who: 'seed-boot' })
      if (helloRun && helloRun.ok === false) throw invalidPack('PACK_HELLO_FAILED', 'embedded-hello-refused')
      return { ...base, target, extracted: l.files.length, helloRun }
    } catch (e) {
      return { ok: false, error: String(e && e.code || e && e.message || e), ...(e && e.reason ? { reason: e.reason } : {}),
        ...(extraction ? { target: extraction.target, extracted: extraction.createdFiles.length, createdFiles: extraction.createdFiles,
          stage: extraction.stage, outcome: extraction.createdFiles.length ? 'partial' : 'unknown', effectsUncertain: true }
          : { outcome: 'refused', extracted: 0 }) }
    }
  },
}
