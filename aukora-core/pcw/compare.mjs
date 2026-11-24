import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = (name) => readFile(new URL(`./build/${name}`, import.meta.url));
const { weights, cases } = JSON.parse(await load("vectors.json"));
const uint = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
assert.ok(Array.isArray(weights) && weights.length === 9 && weights.every(w => uint(w, 255)));
assert.ok(Array.isArray(cases) && cases.length === 4);

const module = await WebAssembly.compile(await load("Lattice.wasm"));
assert.deepEqual(WebAssembly.Module.imports(module), [], "Wasm must have zero imports");
const { exports } = await WebAssembly.instantiate(module);
assert.equal(typeof exports.pcw_run, "function");
assert.equal(exports.pcw_run.length, 11, "expected nine parameter bytes and two input bits");

console.log("weight bytes", JSON.stringify(weights));
const remaining = new Set(["0,0", "0,1", "1,0", "1,1"]);
for (const row of cases) {
  assert.ok(Array.isArray(row) && row.length === 3);
  const [x, y, lean] = row;
  assert.ok(uint(x, 1) && uint(y, 1) && uint(lean, 0xffffffff));
  assert.ok(remaining.delete(`${x},${y}`), "duplicate or out-of-domain input");
  const wasm = exports.pcw_run(...weights, x, y) >>> 0;
  console.log(`(${x}, ${y}) Lean=${lean} Wasm=${wasm}`);
  assert.equal(wasm, lean);
}
assert.equal(remaining.size, 0);
console.log("PASS — all four inputs agree, zero Wasm imports");
