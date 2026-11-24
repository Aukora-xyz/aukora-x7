/**
 * Structural hygiene tripwire for the LIVE mirror organs (not a sandbox, not a behaviour test).
 *
 * Behavioural contracts run against pinned fixtures (./pinned.mjs). This only proves a live organ
 * still loads as a tool module under the same narrow host surface the suites give it: a fresh
 * node:vm context (module, exports, require, Buffer, Date; no timers, no fetch, no process) with a
 * 2 s timeout, an fs whose every call throws, and a size/UTF-8 check. It asserts zero side effects
 * (including deferred ones, after one macrotask), no leaked implicit globals, and the exports
 * { name === id, description, JSON-serialisable parameters, run }. It never calls run(), so Auma
 * changing organ behaviour cannot turn it red; changing the load contract (new dependency, top-level
 * I/O, syntax error, renamed export) will, and should. node:vm is not a security boundary.
 */
import * as nodeCrypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const NAME = /^seed-[a-z0-9-]+$/
const MAX_BYTES = 512 * 1024

export async function loadLiveOrganShape(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('LIVE_ORGAN_NAME_INVALID: ' + String(name))
  const bytes = readFileSync(new URL(`../../../mirror/home/auma/seed/organs/${name}.js`, import.meta.url))
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error(`LIVE_ORGAN_SIZE_INVALID: ${name} ${bytes.length}`)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const effects = []
  const deny = label => () => { effects.push(label); throw Object.assign(new Error('LIVE_SHAPE_NO_SIDE_EFFECTS: ' + label), { code: 'ENOENT' }) }
  const fs = new Proxy({}, { get: (_, key) => deny('fs.' + String(key)) })
  const require = specifier => {
    if (specifier === 'node:fs' || specifier === 'fs') return fs
    if (specifier === 'node:crypto' || specifier === 'crypto') return nodeCrypto
    if (specifier === 'node:path' || specifier === 'path') return path
    throw new Error('LIVE_SHAPE_UNAPPROVED_DEPENDENCY: ' + specifier)
  }
  const module = { exports: {} }
  const globals = { module, require, Buffer, Date }
  for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'fetch']) globals[name] = deny(name)
  const declared = new Set(Object.keys(globals))
  const context = vm.createContext(globals)
  new vm.Script(`(function (module, exports, require) {${source}\n})(module, module.exports, require)`, { filename: `live/${name}.js` })
    .runInContext(context, { timeout: 2000 })
  await new Promise(resolve => setImmediate(resolve))
  return {
    exports: module.exports,
    effects,
    leakedGlobals: Object.keys(context).filter(key => !declared.has(key)),
    sha256: nodeCrypto.createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function assertLiveOrganShape(assert, name) {
  const live = await loadLiveOrganShape(name)
  const { exports } = live
  assert.deepEqual(live.effects, [], `${name}: loading must have no side effects`)
  assert.deepEqual(live.leakedGlobals, [], `${name}: loading must not leak implicit globals`)
  assert.ok(exports !== null && typeof exports === 'object', `${name}: module.exports must be an object`)
  assert.equal(exports.name, name, `${name}: exports.name must equal the organ id`)
  assert.equal(typeof exports.description, 'string', `${name}: description must be a string`)
  assert.ok(exports.description.trim().length > 0, `${name}: description must be non-empty`)
  assert.ok(exports.parameters && typeof exports.parameters === 'object' && !Array.isArray(exports.parameters), `${name}: parameters must be an object`)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(exports.parameters)), `${name}: parameters must be JSON`)
  assert.equal(typeof exports.run, 'function', `${name}: run must be a function`)
  return live
}
