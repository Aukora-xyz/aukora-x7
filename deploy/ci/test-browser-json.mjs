// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * Cross-engine tool-JSON validation (ported from X63 scripts/test-browser-json.mjs; Wave 4B Lane E).
 *
 *   node deploy/ci/test-browser-json.mjs            Node checks + real Chromium, Firefox and WebKit (all required)
 *   node deploy/ci/test-browser-json.mjs --node-only Node checks only; browsers are reported UNPERFORMED, never green
 *
 * Proves, for all four realm-boundary validators (core/tools json-schema.ts, ptc-runtime-node json-wire.ts,
 * cordis-host-runner guard.ts, and the generated workflow-ptc guest-source.ts):
 *   1. No validator compares against Chrome's one-line literal `function Array() { [native code] }`.
 *   2. Plain JSON from this realm and from a foreign realm is accepted when the engine prints natives on several
 *      lines (SpiderMonkey/JSC: `function Array() {\n    [native code]\n}`). Node runs a simulated multi-line realm;
 *      the browser leg runs the real engines.
 *   3. The 8 hostile containers stay refused by every validator: a null-prototype-backed forged Object constructor
 *      with a spoofed toString, a class instance, a Date, a symbol-keyed record, a forged Array constructor with a
 *      spoofed toString, an Array subclass, a sparse array and an array with an extra own property.
 *   4. `__proto__` / `constructor.prototype` payloads never pollute Object.prototype through any validator.
 *   5. json-wire keeps its load-time captured intrinsics when globalThis.Object/Array are replaced.
 * Note: a bare Object.create(null) record is deliberately ACCEPTED (it is JSON-equivalent; json-schema.ts
 * isPlainJsonRecord); only forged constructors behind a null prototype are refused.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_ONLY = process.argv.includes('--node-only')
const FILES = [
  'packages/core/tools/src/json-schema.ts',
  'packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts',
  'packages/extensions/cordis-host-runner/src/guard.ts',
  'packages/workflow/workflow-ptc/src/guest-source.ts',
]

// 1. Static: no engine-specific literal comparator survives in any of the four validators.
for (const file of FILES) {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  assert.ok(!/===\s*`function \$\{name\}\(\) \{ \[native code\] \}`/.test(source), `${file}: template native literal`)
  assert.ok(!/===\s*\\?["'`]function (?:Array|Object)\(\) \{ \[native code\] \}\\?["'`]/.test(source), `${file}: fixed native literal`)
  assert.ok(/toString\.call\(name === ['"\\]+Array['"\\]+ \? Array : Object\)|intrinsic(?:Array|Object)ConstructorSource/.test(source), `${file}: engine-derived comparator missing`)
}
console.log(`BROWSER_JSON static ${FILES.length}/${FILES.length} validators use the engine's own native rendering`)

// 2. Bundle the production validators (same aliasing as X63: provider attribution is unrelated to JSON acceptance).
const esbuild = createRequire(resolve(ROOT, 'packages/boot/hmr/package.json'))('esbuild')
const guestSource = readFileSync(resolve(ROOT, 'packages/workflow/workflow-ptc/src/guest-source.ts'), 'utf8')
assert.ok(guestSource.includes('//#region packages/core/tools/src/json-schema.ts'), 'guest-source layout changed')
const bundle = await esbuild.build({
  stdin: {
    contents: `
      export * from './packages/core/tools/src/json-schema.ts';
      export { parameterSchemaSpecToJsonSchema } from './packages/core/tools/src/schema.ts';
      export * from './packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts';
      export { sandboxDefineTool } from './packages/extensions/cordis-host-runner/src/guard.ts';
      import { WORKFLOW_GUEST_SOURCE } from './packages/workflow/workflow-ptc/src/guest-source.ts';
      /** The guest's pure validator regions (realm, values, json-schema), evaluated without its node:vm entry. */
      export function guestValidators() {
        const lines = WORKFLOW_GUEST_SOURCE.split('\\n');
        const end = lines.indexOf('//#region packages/workflow/workflow/src/index.ts');
        if (lines[0] !== 'import * as vm from "node:vm";' || end < 0) throw new Error('guest layout changed');
        return new Function(lines.slice(1, end).join('\\n') + '\\nreturn { isJsonValue, isJsonSchemaRecord, isPlainJsonArray, isPlainJsonRecord };')();
      }
    `,
    resolveDir: ROOT, sourcefile: 'browser-json-entry.ts', loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'jsonValidators', platform: 'browser', target: 'es2022',
  tsconfig: resolve(ROOT, 'tsconfig.base.json'), write: false, logLevel: 'silent',
  alias: { '@deepseek-ai/dsh-llm': resolve(ROOT, 'packages/llm/llm/src/error.ts') },
})
const BUNDLE = bundle.outputFiles[0].text

/**
 * The shared check, serialised into every realm. `foreignEval` evaluates source in a second realm.
 * Runs in Node vm contexts and in real browser pages, so it must stay self-contained.
 */
async function runChecks(v, foreignEval) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const g = v.guestValidators()
  const schema = { type: 'object', properties: { value: { type: 'string', enum: ['ok'] } }, required: ['value'] }
  v.assertSupportedJsonSchema(schema)
  check(v.validateJsonSchemaValue(schema, { value: 'ok' }).length === 0, 'valid schema value')
  check(v.validateJsonSchemaValue(schema, { value: 1 }).length > 0, 'invalid schema value')
  check(v.parameterSchemaSpecToJsonSchema({ value: { type: 'string', required: true } }).required[0] === 'value', 'tool schema compiler')
  check(g.isJsonSchemaRecord(schema) && g.isPlainJsonArray(['a']) && g.isJsonValue({ a: [1, 'b', null] }), 'guest plain values')
  const nativeRendering = Function.prototype.toString.call(Array)
  const foreign = foreignEval('({ schema: { type: "object", properties: { list: { type: "array", items: { type: "number" } } }, required: ["list"] }, value: { list: [1, 2] } })')
  v.assertSupportedJsonSchema(foreign.schema)
  check(v.validateJsonSchemaValue(foreign.schema, foreign.value).length === 0, 'cross-realm schema')
  check(JSON.stringify(v.snapshotPtcJsonValue(foreign.value)) === '{"list":[1,2]}', 'cross-realm wire snapshot')
  check(JSON.stringify(v.decodePtcJsonWire(v.encodePtcJsonWire(foreign.value))) === '{"list":[1,2]}', 'cross-realm wire round trip')
  check(g.isJsonSchemaRecord(foreign.schema) && g.isPlainJsonArray(foreign.value.list) && g.isJsonValue(foreign.value), 'cross-realm guest')
  const options = foreignEval('({ name: "realm_echo", description: "Return text.", parameters: { text: { type: "string", required: true } }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] }, execute: async (args) => args.text })')
  const tool = v.sandboxDefineTool(options)
  check(await tool.execute({ text: 'ok' }, {}) === 'ok', 'cross-realm sandbox tool')

  // The 8 hostile containers.
  const prototype = Object.create(null)
  const ForgedObject = function Object() {}
  ForgedObject.prototype = prototype
  ForgedObject.toString = () => nativeRendering.replace('Array', 'Object')
  Object.defineProperty(prototype, 'constructor', { value: ForgedObject })
  const forgedRecord = Object.assign(Object.create(prototype), { type: 'string' })
  const forgedArrayPrototype = []
  const ForgedArray = function Array() {}
  ForgedArray.prototype = forgedArrayPrototype
  ForgedArray.toString = () => nativeRendering
  Object.defineProperty(forgedArrayPrototype, 'constructor', { value: ForgedArray })
  const forgedArray = [1]
  Object.setPrototypeOf(forgedArray, forgedArrayPrototype)
  class RecordSubclass { constructor() { this.type = 'string' } }
  class ArraySubclass extends Array {}
  const hostileRecords = [forgedRecord, new RecordSubclass(), new Date(), { [Symbol('hidden')]: true }]
  const hostileArrays = [forgedArray, new ArraySubclass(1), new Array(1), Object.assign([1], { extra: true })]
  let refused = 0
  for (const value of hostileRecords) {
    check(!v.isJsonSchemaRecord(value), 'hostile schema record accepted')
    check(v.snapshotPtcJsonValue(value) === undefined, 'hostile wire record accepted')
    check(!g.isJsonSchemaRecord(value) && !g.isJsonValue(value), 'hostile guest record accepted')
    let rejected = false
    try { v.sandboxDefineTool({ ...options, parameters: value }) } catch { rejected = true }
    check(rejected, 'hostile sandbox parameters accepted')
    refused += 1
  }
  for (const value of hostileArrays) {
    check(!v.isPlainJsonArray(value), 'hostile schema array accepted')
    check(v.snapshotPtcJsonValue(value) === undefined, 'hostile wire array accepted')
    check(!g.isPlainJsonArray(value) && !g.isJsonValue(value), 'hostile guest array accepted')
    let rejected = false
    try { v.sandboxDefineTool({ ...options, parameters: { text: { type: 'string', enum: value } } }) } catch { rejected = true }
    check(rejected, 'hostile sandbox enum accepted')
    refused += 1
  }
  const nullRecord = Object.assign(Object.create(null), { type: 'string' })
  v.assertSupportedJsonSchema(nullRecord)

  // Prototype-pollution payloads: whatever each validator decides, Object.prototype must stay clean.
  const payloads = ['{"__proto__":{"polluted":1}}', '{"constructor":{"prototype":{"polluted":1}}}', '{"a":{"__proto__":{"polluted":1}}}']
  for (const text of payloads) {
    for (const value of [JSON.parse(text), foreignEval(`JSON.parse(${JSON.stringify(text)})`)]) {
      const snap = v.snapshotPtcJsonValue(value)
      if (snap !== undefined) {
        const back = v.decodePtcJsonWire(v.encodePtcJsonWire(snap))
        check(JSON.stringify(back) === JSON.stringify(value), 'pollution payload changed shape')
        const proto = back && Object.getPrototypeOf(back)
        check(proto === Object.prototype || proto === null, 'decoded record has exotic prototype')
      }
      v.isJsonSchemaRecord(value); g.isJsonValue(value); g.isJsonSchemaRecord(value)
      try { v.validateJsonSchemaValue({ type: 'object' }, value) } catch {}
      try { v.sandboxDefineTool({ ...options, parameters: value }) } catch {}
      check(({}).polluted === undefined && Object.prototype.polluted === undefined, `Object.prototype polluted by ${text}`)
    }
  }

  // json-wire keeps load-time intrinsics when the globals are swapped.
  const savedObject = globalThis.Object
  const savedArray = globalThis.Array
  try {
    globalThis.Object = ForgedObject
    globalThis.Array = ForgedArray
    check(v.snapshotPtcJsonValue(foreign.value)?.list?.length === 2, 'wire lost captured native constructors')
  } finally {
    globalThis.Object = savedObject
    globalThis.Array = savedArray
  }
  return { nativeRendering, multiLine: nativeRendering.includes('\n'), hostileContainersRefused: refused, pollutionPayloads: payloads.length * 2 }
}

const CHECKS = `(${runChecks.toString()})`

// 3a. Node, this engine's real rendering.
{
  const realm = vm.createContext({ console })
  vm.runInContext(BUNDLE, realm)
  const result = await vm.runInContext(CHECKS, realm)(realm.jsonValidators, (src) => vm.runInNewContext(src))
  assert.equal(result.hostileContainersRefused, 8)
  assert.equal(result.multiLine, false)
  console.log(`BROWSER_JSON node ${JSON.stringify(result)}`)
}

// 3b. Node, simulated SpiderMonkey/JSC multi-line native rendering installed before the validators load.
{
  const realm = vm.createContext({ console })
  vm.runInContext(`{
    const original = Function.prototype.toString
    const multiLine = function toString() {
      const text = Reflect.apply(original, this, [])
      const m = /^function ([\\w$]*)\\(\\) \\{ \\[native code\\] \\}$/.exec(text)
      return m ? 'function ' + m[1] + '() {\\n    [native code]\\n}' : text
    }
    Object.defineProperty(Function.prototype, 'toString', { value: multiLine, writable: true, configurable: true })
  }`, realm)
  assert.equal(vm.runInContext('Function.prototype.toString.call(Array)', realm), 'function Array() {\n    [native code]\n}')
  // Negative control: the pre-fix literal comparator would have refused every plain container in this realm.
  assert.notEqual(vm.runInContext('Function.prototype.toString.call(Array)', realm), 'function Array() { [native code] }')
  vm.runInContext(BUNDLE, realm)
  const result = await vm.runInContext(CHECKS, realm)(realm.jsonValidators, (src) => vm.runInNewContext(src))
  assert.equal(result.hostileContainersRefused, 8)
  assert.equal(result.multiLine, true)
  console.log(`BROWSER_JSON node-multiline ${JSON.stringify(result)}`)
}

// 4. Real engines.
if (NODE_ONLY) {
  console.log('BROWSER_JSON_UNPERFORMED Chromium Firefox WebKit (--node-only); this run is not a cross-engine pass')
  process.exit(0)
}
const playwright = createRequire(resolve(ROOT, 'apps/web/package.json'))('playwright')
const seen = {}
for (const engine of ['chromium', 'firefox', 'webkit']) {
  const browser = await playwright[engine].launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><title>browser-json</title><body></body>')
    await page.addScriptTag({ content: BUNDLE })
    const result = await page.evaluate(async (source) => {
      const frame = document.createElement('iframe')
      document.body.append(frame)
      try {
        // eslint-disable-next-line no-eval
        return await (0, eval)(source)(globalThis.jsonValidators, (src) => frame.contentWindow.eval(src))
      } finally { frame.remove() }
    }, CHECKS)
    assert.equal(result.hostileContainersRefused, 8, engine)
    seen[engine] = result.multiLine
    console.log(`BROWSER_JSON ${engine} ${playwright[engine].name()} ${browser.version()} ${JSON.stringify(result)}`)
  } finally {
    await browser.close()
  }
}
// Firefox and WebKit print natives on several lines; Chromium on one. Both shapes must have been exercised for real.
assert.equal(seen.chromium, false, 'chromium rendering changed')
assert.ok(seen.firefox === true || seen.webkit === true, 'no real multi-line engine exercised')
console.log(`BROWSER_JSON_OK Chromium Firefox WebKit (multi-line real: firefox=${seen.firefox} webkit=${seen.webkit})`)
