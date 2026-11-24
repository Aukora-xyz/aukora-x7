import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PASS = 2;
const PRIVATE = 18;
const SLOTS = 8;
const TRIALS = 2000;
const SEED = 20261124;
const range = n => Array.from({ length: n }, (_, i) => i);
const organs = range(5);
const corners = range(20);
let state = SEED;

function random(n) {
  state = (Math.imul(1664525, state) + 1013904223) >>> 0;
  return Math.floor(state / 0x100000000 * n);
}

function run(control) {
  const binary = readFileSync(new URL('./pentora.wasm', import.meta.url));
  const { owner, vertex, reset, input, judge } =
    new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;
  const vertices = organs.map(c => range(SLOTS).map(j => vertex(c, j)));
  const owners = corners.map(v => [owner(v, 0), owner(v, 1)]);
  const reportIndex = (c, v) => PRIVATE + vertices[c].indexOf(v);

  for (const v of corners) {
    const actual = organs.filter(c => vertices[c].includes(v));
    assert.equal(actual.length, 2, `vertex count for corner ${v}`);
    assert.deepEqual(new Set(owners[v]), new Set(actual), `owner/vertex mismatch at ${v}`);
  }

  // go4 here is JavaScript, not the proved Lean function.
  function go4(reports, offline) {
    const cellsPass = organs.every(c =>
      c === offline || reports[c].every(t => t === PASS));
    const ownersAgree = owners.every(([a, b], v) =>
      a === offline || b === offline ||
      reports[a][reportIndex(a, v)] === reports[b][reportIndex(b, v)]);
    return cellsPass && ownersAgree;
  }

  function makeBody(trit = () => PASS) {
    return {
      privateCells: organs.map(() => Array.from({ length: PRIVATE }, trit)),
      cornerCells: corners.map(trit),
    };
  }

  function views(body) {
    return organs.map(c =>
      [...body.privateCells[c], ...vertices[c].map(v => body.cornerCells[v])]);
  }

  function judgeReports(reports) {
    reset();
    for (const report of reports) {
      for (const t of report) assert.equal(input(t), 1, 'Wasm refused a trit');
    }
    return judge() >>> 0;
  }

  const arbitraryTrit = () => random(3);
  const arbitraryReport = () => Array.from({ length: PRIVATE + SLOTS }, arbitraryTrit);

  for (let i = 0; i < TRIALS; ++i) {
    const x = random(5);
    const y = (x + 1 + random(4)) % 5;
    const eligible = corners.filter(v => owners[v].some(c => c !== x && c !== y));
    const v = eligible[random(eligible.length)];
    // Include near-passing bodies and a liar who reports all passes.
    const body = i % 2 === 0 ? makeBody() : makeBody(arbitraryTrit);
    body.cornerCells[v] = random(2);
    const reports = views(body);
    reports[x] = arbitraryReport();
    reports[y] = i % 4 < 2 ? Array(PRIVATE + SLOTS).fill(PASS) : arbitraryReport();
    assert.equal(go4(reports, x), false, `visible bad corner ${v}, trial ${i}`);
  }

  for (let i = 0; i < TRIALS; ++i) {
    const v = random(20);
    const side = random(2);
    const [x, y] = [owners[v][side], owners[v][1 - side]];
    const body = makeBody();
    body.cornerCells[v] = random(2);
    const reports = views(body);
    reports[x] = arbitraryReport();
    assert.equal(go4(reports, x), false, `truthful remaining owner, trial ${i}`);
    reports[y][reportIndex(y, v)] = PASS;
    assert.equal(go4(reports, x), true, `hidden shared corner ${v}, trial ${i}`);
  }

  for (let i = 0; i < TRIALS; ++i) {
    const reports = views(makeBody());
    const c = random(5);
    const j = random(PRIVATE + SLOTS);
    reports[c][j] = random(2);
    assert.notEqual(judgeReports(reports), 0, `single objection, trial ${i}`);
    reports[c][j] = PASS;
    assert.equal(judgeReports(reports), 0, `repaired packet, trial ${i}`);
    for (const x of organs) assert.equal(go4(reports, x), true, `judge zero, offline ${x}, trial ${i}`);
  }

  console.log(`PASS seed ${SEED}: ${TRIALS} visible faults, ${TRIALS} hidden shared faults, ${TRIALS} judge-zero packets x 5 offline choices`);
  if (control) {
    const result = go4(views(makeBody()), 0);
    assert.equal(result, false, `planted control expected go4=false for all passes; got ${result}`);
  }
}

try {
  run(process.argv[2] === 'control');
} catch (error) {
  console.error(`FAIL ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
