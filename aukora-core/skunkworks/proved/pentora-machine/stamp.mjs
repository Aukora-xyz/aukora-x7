import { readFileSync } from 'node:fs';

const PASS = 2;
const SEED = 20261124;
const indices = n => Array.from({ length: n }, (_, i) => i);
const organs = indices(5);
const corners = indices(20);
const slots = indices(8);

function run(control) {
  const binary = readFileSync(new URL('./pentora.wasm', import.meta.url));
  const { owner, vertex, reset, input, judge, seams } =
    new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;

  function expect(condition, message) {
    if (!condition) throw new Error(message);
  }

  // Recover each label from owner and independently check the pair with vertex.
  const vertices = organs.map(c => slots.map(j => vertex(c, j)));
  const owners = corners.map(v => [owner(v, 0), owner(v, 1)]);
  for (const v of corners) {
    const [a, b] = owners[v];
    expect(organs.includes(a) && organs.includes(b) && a !== b, `invalid owners for corner ${v}`);
  }
  for (const c of organs) {
    expect(new Set(vertices[c]).size === 8 && vertices[c].every(v => corners.includes(v)),
      `invalid corner slots for organ ${c}`);
  }
  const labels = [];
  for (const a of organs) {
    for (const b of organs.slice(a + 1)) {
      const pair = corners.filter(v => owners[v].includes(a) && owners[v].includes(b));
      expect(pair.length === 2, `pair ${a},${b} owns ${pair.length} corners`);
      const [truth, safety] = pair; // corners were visited in ascending order
      const shared = vertices[a].filter(v => vertices[b].includes(v));
      expect(shared.length === 2 && Math.min(...shared) === truth && Math.max(...shared) === safety,
        `vertex disagrees with the labels for pair ${a},${b}`);
      labels.push({ a, b, truth, safety });
    }
  }

  let seed = SEED;
  function random(n) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x100000000) * n);
  }
  function makeBody(trit = () => PASS) {
    return {
      priv: organs.map(() => Array.from({ length: 18 }, trit)),
      corn: Array.from({ length: 20 }, trit),
    };
  }
  function views(body) {
    return organs.map(c => [...body.priv[c], ...vertices[c].map(v => body.corn[v])]);
  }
  function send(reports) {
    reset();
    for (const report of reports) {
      for (const t of report) expect(input(t) === 1, 'input refused a report byte');
    }
    return judge() >>> 0;
  }
  function expectJudge(reports, expected, label) {
    const got = send(reports);
    expect(got === expected, `${label} expected judge ${expected}, got ${got}`);
  }

  // Include near-acceptance cases with only the surviving owner's objection,
  // as well as arbitrary trits in both the body and the replacement report.
  let single = 0;
  for (; single < 2000; single++) {
    const x = random(5);
    const v = random(20);
    const body = single % 2 === 0 ? makeBody() : makeBody(() => random(3));
    body.corn[v] = random(2);
    const allPassReplacement = single % 4 < 2;
    if (allPassReplacement) body.priv[x][random(18)] = random(2);
    const reports = views(body);
    reports[x] = Array.from({ length: 26 }, () => allPassReplacement ? PASS : random(3));
    const got = send(reports);
    expect((got > 0 && got <= 242) || (got >= 256 && got < 276),
      `single-organ trial ${single} returned judge ${got}`);
  }

  // Exercise each of the 130 positions with each objection as its only non-pass.
  let veto = 0;
  for (; veto < 260; veto++) {
    const position = veto % 130;
    const c = Math.floor(position / 26);
    const j = position % 26;
    const objection = Math.floor(veto / 130);
    const reports = views(makeBody());
    reports[c][j] = objection;
    const expected = j < 18 ? (2 - objection) * 3 ** c : 256 + vertices[c][j - 18];
    expectJudge(reports, expected, `veto trial ${veto}`);
  }

  // For each pair, combine two private vetoes at ten distinct first-owner slots.
  for (const { a, b } of labels) {
    const start = random(18);
    for (let offset = 0; offset < 10; offset++) {
      for (const first of [0, 1]) {
        const second = random(2);
        const reports = views(makeBody());
        reports[a][(start + offset) % 18] = first;
        reports[b][random(18)] = second;
        const expected = (2 - first) * 3 ** a + (2 - second) * 3 ** b;
        expectJudge(reports, expected, `paired private veto trial ${veto}`);
        veto++;
      }
    }
  }

  // Both owners agree on each possible objection at each of the twenty corners.
  for (const v of corners) {
    const [a, b] = owners[v];
    for (const objection of [0, 1]) {
      const body = makeBody();
      body.corn[v] = objection;
      const expected = (2 - objection) * (3 ** a + 3 ** b);
      expectJudge(views(body), expected, `shared corner veto trial ${veto}`);
      expect((seams() >>> 0) === 0, `shared corner veto trial ${veto} has a seam`);
      veto++;
    }
  }

  const { truth, a, b } = labels[0];
  const cornerFault = makeBody();
  cornerFault.corn[truth] = 0;
  const collusion = views(cornerFault);
  expectJudge(collusion, 2 * (3 ** a + 3 ** b), 'truthful corner fault');
  collusion[a][18 + vertices[a].indexOf(truth)] = PASS;
  expectJudge(collusion, 256 + truth, 'one owner hides the corner fault');
  expect((seams() >>> 0) === 2 ** truth, 'one owner should leave exactly the faulty corner disputed');
  collusion[b][18 + vertices[b].indexOf(truth)] = PASS;
  expectJudge(collusion, 0, 'two owners hide the corner fault');

  const privateFault = makeBody();
  privateFault.priv[4][17] = 1;
  const concealment = views(privateFault);
  expectJudge(concealment, 3 ** 4, 'truthful private fault');
  concealment[4][17] = PASS;
  const expected = control ? 1 : 0;
  const got = send(concealment);
  const failure = got === expected ? '' : ` (private limit expected judge ${expected}, got ${got})`;
  console.log(`${failure ? 'FAIL' : 'PASS'} seed ${SEED}, ${labels.length} pairs, ${single} single-organ trials, ${veto} veto trials, 2 limit cases${failure}`);
  process.exitCode = failure ? 1 : 0;
}

try {
  run(process.argv[2] === 'control');
} catch (error) {
  console.log(`FAIL ${error.message}`);
  process.exitCode = 1;
}
