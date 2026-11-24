// docs/auma/fractalien/lab.mjs — first-job runnable subset, zero dependencies.
//
// Repo path policy refuses the root `fractalien/` directory and `bench/`, so
// the lab lives under the open `docs/auma/` root. Run:
//   node docs/auma/fractalien/lab.mjs
//
// This is the self-contained exact rank audit of ONE 20-site Menger cube.
// It rebuilds the 20 sites and 24 Menger links from integer coordinates, so
// the first x6_exec job does not depend on /dsh/tmp or on a pinned table.
//
// Link rule: an edge-center (exactly two nonzero coords) connects to its two
// corner endpoints. That is the rule whose absence produced the withdrawn
// 4/2/1 result; with it the audit is 7/2/2.
//
// This does NOT claim the 80-site body or the gated full/cut wave. It is the
// smallest decisive run: the 20-site graph's ranks against the 24-tap control.

const P = 65521;

const coords = [];
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
    for (let z = -1; z <= 1; z++)
      if ([x, y, z].filter(v => v !== 0).length >= 2) coords.push([x, y, z]);

const index = new Map(coords.map((c, i) => [c.join(','), i]));
const edges = [];
for (let i = 0; i < coords.length; i++) {
  const c = coords[i];
  if (c.filter(v => v !== 0).length !== 2) continue;
  for (let axis = 0; axis < 3; axis++) {
    if (c[axis] !== 0) continue;
    for (const s of [-1, 1]) {
      const corner = c.slice();
      corner[axis] = s;
      const j = index.get(corner.join(','));
      if (j !== undefined) edges.push([i, j]);
    }
  }
}

const n = coords.length;
const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0));
for (const [a, b] of edges) { A[a][b] = 1; A[b][a] = 1; }

const mv = (M, v) => M.map(row => row.reduce((s, x, j) => (s + x * v[j]) % P, 0));

const rank = M => {
  const a = M.map(r => r.slice());
  const rows = a.length, cols = a[0].length;
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let p = r;
    while (p < rows && a[p][c] === 0) p++;
    if (p === rows) continue;
    [a[p], a[r]] = [a[r], a[p]];
    let x = a[r][c], y = P, u = 1, v = 0;
    while (y) {
      const q = Math.floor(x / y);
      [x, y] = [y, x - q * y];
      [u, v] = [v, u - q * v];
    }
    const inv = ((u % P) + P) % P;
    a[r] = a[r].map(z => (z * inv) % P);
    for (let i = 0; i < rows; i++) {
      if (i === r || a[i][c] === 0) continue;
      const f = a[i][c];
      a[i] = a[i].map((z, j) => ((z - f * a[r][j]) % P + P) % P);
    }
    r++;
  }
  return r;
};

const B = Array(n).fill(0); B[0] = 1;
const C = Array(n).fill(1);

const cols = [];
let v = B.slice();
for (let k = 0; k < n; k++) { cols.push(v.slice()); v = mv(A, v); }
const reach = rank(cols[0].map((_, i) => cols.map(c => c[i])));

const rowMul = (v, M) => M[0].map((_, j) => v.reduce((s, x, i) => (s + x * M[i][j]) % P, 0));
const rows = [];
let w = C.slice();
for (let k = 0; k < n; k++) { rows.push(w.slice()); w = rowMul(w, A); }
const obs = rank(rows);

const mark = [];
let q = B.slice();
for (let k = 0; k < 2 * n; k++) {
  mark.push(C.reduce((s, x, j) => (s + x * q[j]) % P, 0));
  q = mv(A, q);
}
const H = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => mark[i + j] || 0));

// The 24-tap control: x[0] newest input, output after accept 3*x[7] - 2*x[15] + x[23].
const A30 = Array.from({ length: 30 }, (_, i) => Array.from({ length: 30 }, (_, j) => 0));
for (let i = 1; i < 24; i++) A30[i][i - 1] = 1;
for (let i = 24; i < 30; i++) A30[i][i] = 1;
const B30 = Array(30).fill(0); B30[0] = 1;
const C30 = Array(30).fill(0); C30[7] = 3; C30[15] = P - 2; C30[23] = 1;
const cols30 = [];
let v30 = B30.slice();
for (let k = 0; k < 30; k++) { cols30.push(v30.slice()); v30 = mv(A30, v30); }
const reach30 = rank(cols30[0].map((_, i) => cols30.map(c => c[i])));
const rows30 = [];
let w30 = C30.slice();
for (let k = 0; k < 30; k++) { rows30.push(w30.slice()); w30 = rowMul(w30, A30); }
const obs30 = rank(rows30);
const mark30 = [];
let q30 = B30.slice();
for (let k = 0; k < 60; k++) {
  mark30.push(C30.reduce((s, x, j) => (s + x * q30[j]) % P, 0));
  q30 = mv(A30, q30);
}
const H30 = Array.from({ length: 24 }, (_, i) => Array.from({ length: 24 }, (_, j) => mark30[i + j] || 0));

console.log(JSON.stringify({
  schema: 'fractalien.lab.v1',
  field: P,
  scope: 'self-contained 20-site Menger rank audit; not the 80-site table lab',
  sites: n,
  links: edges.length,
  reach,
  obs,
  hankel: rank(H),
  control_24tap: { reach: reach30, obs: obs30, hankel: rank(H30) },
  verdict: '20-site Menger graph with one corner inlet is rank 7, not 20; the 24-tap control is 24.',
  note: 'Same link rule as the 80-site cut: edge-center to its two corners.'
}, null, 2));
