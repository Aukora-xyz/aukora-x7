import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const bytes = await readFile(new URL('./Add.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes)
const { accept_length } = instance.exports
for (const [parent, actual, length, expected] of [
  [7, 7, 19, 1],
  [7, 8, 19, 0],
  [7, 7, 0, 0],
]) {
  const answer = accept_length(parent, actual, length)
  console.log(`accept_length(${parent}, ${actual}, ${length}) = ${answer}`)
  assert.equal(answer, expected)
}
