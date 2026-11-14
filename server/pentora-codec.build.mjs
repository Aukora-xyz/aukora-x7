// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The exact algebra of the `pentora-codec` cell, done once at build time, and the cell's
 * rebuild through the repository's own pinned compiler cell (exactly as server/kyber-cpu-cell.build.mjs does).
 *
 * What is computed here, in plain Node with BigInt and no float anywhere:
 *   1. The pinned PENTORA geometry (server/pentora/geometry_index_table_v1.json, sha256 96b27c9b...8c61, the same table
 *      packages/client/ui-layout/src/client/spatial/aura/tables.ts pins as GEOMETRY_SHA256): 111 points with exact
 *      coordinates a + b*phi in Q(phi); the centre (index 55) is skipped, so 110 nodes. Each node is put on the unit
 *      sphere exactly (squared radius 1, 2 or 3; scale 1, sqrt2/2 or sqrt3/3).
 *   2. The evaluation matrix A (880 x 72) of the degree-five model: unknown slot j < 36 is the a part and slot 36 + j the
 *      b part of the coefficient (a + b*phi) of monomial j = x^i y^k z^e (e in {0,1}, i + k + e <= 5; 36 monomials).
 *      Row 8n + m is component m of the polynomial's value at node n, written in Q(sqrt2, sqrt3, sqrt5) on the basis
 *      1, sqrt2, sqrt3, sqrt6, sqrt5, sqrt10, sqrt15, sqrt30. Every entry is a rational whose denominator divides
 *      SCALE = 13,824 (proved below), so the integer matrix A = SCALE * (that matrix) is exact, and a packet component is
 *      an integer numerator over SCALE.
 *   3. For each supported keep-set ("all" 110 nodes, "drop-0-9" nodes 10..109, "menger-80" the 80 Menger skeleton nodes
 *      at squared radius 2 or 3 with all 30 face-centres at squared radius 1 dropped) an exact integer LEFT INVERSE L
 *      with one common denominator D: L * A_kept = D * I, checked entry by entry (the rank certificate: A_kept has rank
 *      72), and L strictly zero on every dropped row. It is built per parity block (the 30 slots of even degree and the
 *      42 of odd degree never share a row of a node at squared radius 2 or 3): in each block a square set of independent
 *      kept rows is chosen (deterministically, smallest denominator over a fixed list of candidate orders) and its exact
 *      inverse is taken. Nothing here is trusted by the cell's soundness: the cell checks A * x = y on every kept row,
 *      so a wrong L can only cause a refusal. It is an accelerator with a certificate.
 *   4. The bounds the cell's fixed-width arithmetic relies on (all asserted; the build refuses to write otherwise).
 * The tables are written into apps/web/public/cells/pentora-codec.wat between its two GENERATED markers; the WAT is
 * then built and metered by the pinned skillsmith cell into pentora-codec.wasm.
 *
 * The algorithm is written new here from the description in the Kyber Kernel report and the PENTORA exact instrument
 * (an earlier repository); no code of it is copied. This file is AGPL-3.0-or-later.
 *
 * Usage: node server/pentora-codec.build.mjs           (check: tables and wasm identical to a rebuild; exit 1 if not)
 *        node server/pentora-codec.build.mjs --write   (regenerate the WAT's tables and write the metered wasm)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cellRequestBytes } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'

const CELLS = new URL('../apps/web/public/cells/', import.meta.url)
export const GEOMETRY_URL = new URL('pentora/geometry_index_table_v1.json', import.meta.url)
export const GEOMETRY_SHA256 = '96b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61'
export const GEOMETRY_BYTES = 138070
export const PROFILE = 'pentora110-qphi72'
export const NODES = 110
export const COMPONENTS = 8
export const ROWS = NODES * COMPONENTS
export const SLOTS = 72
export const SCALE = 13824n
/** Values are int16: VALUE_MIN..VALUE_MAX, both accepted; anything beyond is refused. */
export const VALUE_MIN = -32768
export const VALUE_MAX = 32767
export const MAX_BLOCKS = 24
/** The 30 face-centre nodes (squared radius 1), dropped by "menger-80", and the 80 Menger skeleton nodes (squared radius 2 or 3). */
export const FACE_30_NODES = Object.freeze([
  14, 20, 21, 24, 25, 29, 30, 35, 36, 39, 40, 41, 42, 50, 54,
  55, 59, 67, 68, 69, 70, 73, 74, 79, 80, 84, 85, 88, 89, 95,
])
export const MENGER_80_NODES = Object.freeze(
  Array.from({ length: NODES }, (_, n) => n).filter(n => !FACE_30_NODES.includes(n)),
)
/** The keep-sets: name -> the explicit kept-node index list in sorted node order 0..109. */
export const KEEP_SETS = Object.freeze({
  'all': Object.freeze(Array.from({ length: NODES }, (_, n) => n)),
  'drop-0-9': Object.freeze(Array.from({ length: NODES - 10 }, (_, i) => i + 10)),
  'menger-80': MENGER_80_NODES,
})
const SKILLSMITH_PIN = Object.freeze({ sha256: '35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa', bytes: 592220 })
const SKILLSMITH_FUEL = 300_000_000n
const BEGIN = ';; ---- PENTORA TABLES begin (generated by server/pentora-codec.build.mjs --write; never edit by hand) ----'
const END = ';; ---- PENTORA TABLES end ----'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const abs = v => (v < 0n ? -v : v)
const bitLength = v => (v === 0n ? 0 : abs(v).toString(2).length)
const gcd = (a, b) => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a }
const lcm = (a, b) => a / gcd(a, b) * b

// ---------- exact arithmetic in Q(sqrt2, sqrt3, sqrt5): eight integer numerators over one positive denominator ----------
/** Component k's radicand product: bit 0 sqrt2, bit 1 sqrt3, bit 2 sqrt5. */
const RADICAND = [1n, 2n, 3n, 6n, 5n, 10n, 15n, 30n]
const reduce = (n, d) => {
  let g = d
  for (const v of n) g = gcd(g, v)
  if (g === 0n) return { n: n.map(() => 0n), d: 1n }
  if (d < 0n) g = -g
  return { n: n.map(v => v / g), d: d / g }
}
const rad = (components, d = 1n) => reduce(components.map(BigInt), BigInt(d))
const radAdd = (a, b) => reduce(a.n.map((v, i) => v * b.d + b.n[i] * a.d), a.d * b.d)
function radMul(a, b) {
  const out = Array(8).fill(0n)
  for (let i = 0; i < 8; i += 1) {
    if (a.n[i] === 0n) continue
    for (let j = 0; j < 8; j += 1) {
      if (b.n[j] === 0n) continue
      // sqrt(p) * sqrt(q): the shared radicands come out as an integer factor, the rest stays under the root.
      out[i ^ j] += a.n[i] * b.n[j] * (RADICAND[i & j] ?? 0n)
    }
  }
  return reduce(out, a.d * b.d)
}
const ONE = rad([1, 0, 0, 0, 0, 0, 0, 0])
/** phi = (1 + sqrt5) / 2. */
const PHI = rad([1, 0, 0, 0, 1, 0, 0, 0], 2)
/** A coordinate a + b*phi (a and b as [numerator, denominator]) as a radical. */
function coordinate(wire) {
  const [an, ad] = wire.a.map(BigInt), [bn, bd] = wire.b.map(BigInt)
  if (ad <= 0n || bd <= 0n) throw new Error('geometry: denominator')
  return radAdd(rad([an, 0, 0, 0, 0, 0, 0, 0], ad), radMul(rad([bn, 0, 0, 0, 0, 0, 0, 0], bd), PHI))
}

/** The 36 monomials x^i y^k z^e, by degree d = 0..5, e in {0, 1}, i descending last. */
export const BASIS = Object.freeze((() => {
  const basis = []
  for (let d = 0; d <= 5; d += 1) for (const e of [0, 1]) if (e <= d) for (let i = 0; i <= d - e; i += 1) basis.push([i, d - e - i, e])
  if (basis.length !== 36) throw new Error('basis')
  return basis
})())
/** Slot j's parity block: the degree of monomial j mod 36 is even or odd. */
export const EVEN_SLOTS = Object.freeze([...Array(SLOTS).keys()].filter(j => (BASIS[j % 36].reduce((s, v) => s + v, 0) % 2) === 0))
export const ODD_SLOTS = Object.freeze([...Array(SLOTS).keys()].filter(j => (BASIS[j % 36].reduce((s, v) => s + v, 0) % 2) === 1))

/** @returns {Buffer} the geometry's exact bytes, refused unless they are the pinned table. */
export function geometryBytes() {
  const bytes = readFileSync(GEOMETRY_URL)
  if (bytes.byteLength !== GEOMETRY_BYTES || sha256(bytes) !== GEOMETRY_SHA256) throw new Error('geometry: bytes do not match the pin')
  return bytes
}

/**
 * The integer evaluation matrix, from the pinned geometry.
 * @returns {{ A: bigint[][], radii: number[] }} A is 880 x 72 (row 8n + m), every entry an integer (SCALE times exact).
 */
export function evaluationMatrix() {
  const geometry = JSON.parse(geometryBytes().toString('utf8'))
  const points = [...geometry.points].sort((p, q) => p.global_index - q.global_index)
  if (points.length !== 111 || points.some((p, i) => p.global_index !== i) || geometry.centre_index !== 55) throw new Error('geometry: points')
  const rows = [], radii = []
  for (const point of points) {
    if (point.global_index === 55) continue
    const raw = point.coordinates.map(coordinate)
    const r2 = raw.reduce((sum, v) => radAdd(sum, radMul(v, v)), rad([0, 0, 0, 0, 0, 0, 0, 0]))
    if (r2.d !== 1n || r2.n.slice(1).some(v => v !== 0n) || ![1n, 2n, 3n].includes(r2.n[0])) throw new Error('geometry: radius')
    const r = Number(r2.n[0])
    radii.push(r)
    const scale = r === 1 ? ONE : r === 2 ? rad([0, 1, 0, 0, 0, 0, 0, 0], 2) : rad([0, 0, 1, 0, 0, 0, 0, 0], 3)
    const xyz = raw.map(v => radMul(v, scale))
    const powers = xyz.map(v => { const p = [ONE]; for (let k = 1; k <= 5; k += 1) p.push(radMul(p[k - 1], v)); return p })
    const monomials = BASIS.map(([i, k, e]) => radMul(radMul(powers[0][i], powers[1][k]), powers[2][e]))
    const values = [...monomials, ...monomials.map(v => radMul(v, PHI))]
    for (let m = 0; m < COMPONENTS; m += 1) rows.push(values.map(v => ({ n: v.n[m], d: v.d })))
  }
  let common = 1n
  for (const row of rows) for (const { n, d } of row) if (n !== 0n) common = lcm(common, d / gcd(n, d))
  if (common !== SCALE) throw new Error(`geometry: common denominator ${String(common)} is not ${String(SCALE)}`)
  const faces = radii.flatMap((r, n) => (r === 1 ? [n] : []))
  const menger = radii.flatMap((r, n) => (r !== 1 ? [n] : []))
  if (faces.length !== FACE_30_NODES.length || faces.some((n, i) => n !== FACE_30_NODES[i])
    || menger.length !== MENGER_80_NODES.length || menger.some((n, i) => n !== MENGER_80_NODES[i])) {
    throw new Error('geometry: Menger/face node partition does not match pinned radii')
  }
  const A = rows.map(row => row.map(({ n, d }) => n * SCALE / d))
  return { A, radii }
}

// ---------- the left inverses ----------
const PRIME = 2147483647n
/** Exact inverse of a square integer matrix by fraction-free Gauss-Jordan: { L, D } with L * M = D * I, D > 0, reduced. */
function exactInverse(M) {
  const n = M.length
  const W = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1n : 0n))])
  let previous = 1n
  for (let k = 0; k < n; k += 1) {
    let p = k
    while (p < n && W[p][k] === 0n) p += 1
    if (p === n) return null
    if (p !== k) [W[p], W[k]] = [W[k], W[p]]
    const pivot = W[k][k]
    for (let i = 0; i < n; i += 1) {
      if (i === k) continue
      const f = W[i][k], Wi = W[i], Wk = W[k]
      for (let j = 0; j < 2 * n; j += 1) {
        const v = pivot * Wi[j] - f * Wk[j]
        if (v % previous !== 0n) throw new Error('inverse: inexact division')
        Wi[j] = v / previous
      }
    }
    previous = pivot
  }
  let L = W.map(row => row.slice(n)), D = previous
  let g = D
  for (const row of L) for (const v of row) g = gcd(g, v)
  L = L.map(row => row.map(v => v / g)); D /= g
  if (D < 0n) { D = -D; L = L.map(row => row.map(v => -v)) }
  return { L, D }
}

/** Greedy: the first rows of `order` that are independent (mod a prime, so an exact rank at least that), `size` of them. */
function independentRows(order, A, cols) {
  const basis = [] // echelon rows mod PRIME with their pivot column
  const chosen = []
  const inv = a => { let r = 1n, b = a, e = PRIME - 2n; while (e) { if (e & 1n) r = r * b % PRIME; b = b * b % PRIME; e >>= 1n } return r }
  for (const r of order) {
    if (chosen.length === cols.length) break
    const v = cols.map(c => ((A[r][c] % PRIME) + PRIME) % PRIME)
    for (const { row, pivot } of basis) {
      const f = v[pivot]
      if (f !== 0n) for (let j = 0; j < v.length; j += 1) v[j] = ((v[j] - f * row[j]) % PRIME + PRIME) % PRIME
    }
    const pivot = v.findIndex(x => x !== 0n)
    if (pivot < 0) continue
    const s = inv(v[pivot])
    basis.push({ row: v.map(x => x * s % PRIME), pivot })
    chosen.push(r)
  }
  return chosen.length === cols.length ? chosen : null
}

/**
 * The left inverse of one keep-set: per parity block, the square row choice with the smallest denominator over a fixed,
 * seeded list of candidate orders; then one common denominator.
 * @returns {{ keptNodes: readonly number[], D: bigint, even: { rows: number[], L: bigint[][] }, odd: { rows: number[], L: bigint[][] } }}
 */
export function leftInverse(A, keep) {
  const keptNodes = KEEP_SETS[keep]
  if (keptNodes === undefined) throw new Error('keep-set')
  const block = cols => {
    const pool = []
    for (const n of keptNodes) {
      for (let m = 0; m < COMPONENTS; m += 1) {
        const r = n * COMPONENTS + m
        const row = A[r]
        if (row.some(v => v !== 0n) && row.every((v, c) => v === 0n || cols.includes(c))) pool.push(r)
      }
    }
    let state = 0x2545f491 // xorshift32, fixed seed: the choice is the same on every build
    const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state }
    const candidates = []
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const order = pool.slice()
      if (attempt > 0) for (let i = order.length - 1; i > 0; i -= 1) { const j = random() % (i + 1); [order[i], order[j]] = [order[j], order[i]] }
      const rows = independentRows(order, A, cols)
      if (!rows) continue
      const inverse = exactInverse(rows.map(r => cols.map(c => A[r][c])))
      if (!inverse) continue
      const lMax = inverse.L.flat().reduce((m, v) => (abs(v) > m ? abs(v) : m), 0n)
      candidates.push({ rows, L: inverse.L, D: inverse.D, lMax })
    }
    if (candidates.length === 0) throw new Error(`keep ${keep}: rank below ${String(cols.length)}`)
    return candidates
  }
  // One common D for both blocks; the pair whose scaled L fits i32 with the smallest D, then the smallest L.
  const I32 = (1n << 31n) - 1n
  const before = (a, b) => { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false }
  const evens = block(EVEN_SLOTS), odds = block(ODD_SLOTS)
  let best = null
  for (const even of evens) {
    for (const odd of odds) {
      const D = lcm(even.D, odd.D)
      const lMax = [even.lMax * (D / even.D), odd.lMax * (D / odd.D)].reduce((m, v) => (v > m ? v : m))
      const key = [lMax <= I32 ? 0 : 1, bitLength(D), bitLength(lMax)]
      if (!best || before(key, best.key)) best = { even, odd, D, key }
    }
  }
  if (best.key[0] !== 0) throw new Error(`keep ${keep}: no left inverse with entries inside i32`)
  const { even, odd, D } = best
  return {
    keptNodes, D,
    even: { rows: even.rows, L: even.L.map(row => row.map(v => v * (D / even.D))) },
    odd: { rows: odd.rows, L: odd.L.map(row => row.map(v => v * (D / odd.D))) },
  }
}

/** The full 72 x 880 left inverse (zero outside the chosen rows). */
export function fullLeftInverse(inverse) {
  const L = Array.from({ length: SLOTS }, () => Array(ROWS).fill(0n))
  for (const [cols, part] of [[EVEN_SLOTS, inverse.even], [ODD_SLOTS, inverse.odd]]) {
    cols.forEach((c, i) => { part.rows.forEach((r, k) => { L[c][r] = part.L[i][k] }) })
  }
  return L
}

/**
 * The rank certificate: L * A_kept = D * I exactly, and L is strictly zero on every dropped row. Throws otherwise.
 * @returns {true}
 */
export function proveLeftInverse(A, L, D, keptNodes) {
  if (D <= 0n || !Array.isArray(keptNodes) || keptNodes.length === 0) throw new Error('certificate: args')
  const keptRows = new Set()
  for (let idx = 0; idx < keptNodes.length; idx += 1) {
    const n = keptNodes[idx]
    if (!Number.isInteger(n) || n < 0 || n >= NODES || (idx > 0 && n <= keptNodes[idx - 1])) {
      throw new Error('certificate: keptNodes order')
    }
    for (let m = 0; m < COMPONENTS; m += 1) keptRows.add(n * COMPONENTS + m)
  }
  for (let i = 0; i < SLOTS; i += 1) {
    for (let r = 0; r < ROWS; r += 1) if (!keptRows.has(r) && L[i][r] !== 0n) throw new Error('certificate: a dropped row is used')
    for (let j = 0; j < SLOTS; j += 1) {
      let sum = 0n
      for (const r of keptRows) if (L[i][r] !== 0n) sum += L[i][r] * A[r][j]
      if (sum !== (i === j ? D : 0n)) throw new Error(`certificate: (L A)[${String(i)}][${String(j)}] is not D * I`)
    }
  }
  return true
}

/** Every bound the cell's fixed-width arithmetic relies on; throws if one fails. */
export function bounds(A, inverses) {
  const valueBound = BigInt(-VALUE_MIN)
  const rowBound = A.map(row => row.reduce((s, v) => s + abs(v), 0n))
  /** A packet component a value vector in range can produce is at most this in size; larger is refused on sight. */
  const packetMax = rowBound.reduce((m, v) => (v > m ? v : m), 0n) * valueBound
  const out = { packetMax, packetBits: bitLength(packetMax), aBits: Math.max(...A.flat().map(bitLength)), keep: {} }
  const LIMIT_64 = 1n << 62n, LIMIT_128 = 1n << 126n
  for (const [name, inv] of Object.entries(inverses)) {
    const L = fullLeftInverse(inv)
    const lMax = L.flat().reduce((m, v) => (abs(v) > m ? abs(v) : m), 0n)
    // S = L y for any in-bound packets; A_r S; D y; and a valid S = D x with |x| <= 32768.
    const sMax = L.reduce((m, row) => { const s = row.reduce((t, v) => t + abs(v), 0n) * packetMax; return s > m ? s : m }, 0n)
    const wideMax = rowBound.reduce((m, v) => (v > m ? v : m), 0n) * sMax
    if (lMax >= LIMIT_64 || inv.D >= LIMIT_64 || packetMax >= LIMIT_64) throw new Error('bounds: an operand does not fit i64')
    if (sMax >= LIMIT_128 || wideMax >= LIMIT_128 || inv.D * packetMax >= LIMIT_128) throw new Error('bounds: a sum does not fit 128 bits')
    if (inv.D * valueBound >= LIMIT_64) throw new Error('bounds: a valid S does not fit i64')
    out.keep[name] = { kept: inv.keptNodes.length, dBits: bitLength(inv.D), lBits: bitLength(lMax), sBits: bitLength(sMax), wideBits: bitLength(wideMax) }
  }
  return out
}

// ---------- the tables as WAT data ----------
const le = (value, bytes) => { const out = []; let v = BigInt.asUintN(bytes * 8, BigInt(value)); for (let i = 0; i < bytes; i += 1) { out.push(Number(v & 0xffn)); v >>= 8n } return out }
const pad = (bytes, align) => { while (bytes.length % align !== 0) bytes.push(0); return bytes }
/** Where the cell decodes the binary tables to, where their base64 text lives, and where the INFO text lives. */
export const TABLE_BASE = 8192
export const TABLE_TEXT = 131072
export const TABLE_TEXT_MAX = 98304
export const INFO_AT = 126976
const KEEP_BYTES = 152 + 4 * (30 * 30 + 42 * 42)

/**
 * The binary tables, as one blob the cell decodes to TABLE_BASE:
 *   ROWPTR u16[881]  row r's entries are [ROWPTR[r], ROWPTR[r+1]) (an empty range: the row is always zero)
 *   ECOLS  u8[N]     each entry's slot (0..71)
 *   EVALS  i16[N]    each entry's value (A = 13,824 x the exact evaluation matrix)
 *   COLS   u8[72]    the 30 even-degree slots, then the 42 odd-degree slots
 *   MENGER u8[80]    the 80 Menger skeleton node indices in sorted order 0..109 (packet i -> node MENGER[i])
 *   PMAX   i64       PACKET_MAX
 *   KEEP k           D i64, even rows u16[30], odd rows u16[42], L_even i32[30][30], L_odd i32[42][42]
 * @returns {{ blob: number[], at: Record<string, number>, entries: number }} `at` holds absolute addresses.
 */
export function tableBlob(A, inverses, packetMax) {
  const rowptr = [], ecols = [], evals = []
  for (const row of A) {
    rowptr.push(ecols.length)
    row.forEach((v, c) => {
      if (v === 0n) return
      if (abs(v) > 32767n) throw new Error('A entry exceeds i16')
      ecols.push(c); evals.push(v)
    })
  }
  rowptr.push(ecols.length)
  if (ecols.length > 65535) throw new Error('A: too many entries for u16 row pointers')
  const mengerNodes = inverses['menger-80']?.keptNodes
  if (!mengerNodes || mengerNodes.length !== 80 || mengerNodes.some(n => n < 0 || n >= NODES)) throw new Error('menger table')
  const blob = [], at = {}
  const put = (name, bytes, align) => { pad(blob, align); at[name] = TABLE_BASE + blob.length; for (const b of bytes) blob.push(b) }
  put('rowptr', rowptr.flatMap(v => le(v, 2)), 2)
  put('ecols', ecols, 1)
  put('evals', evals.flatMap(v => le(v, 2)), 2)
  put('cols', [...EVEN_SLOTS, ...ODD_SLOTS], 1)
  put('menger', [...mengerNodes], 1)
  put('pmax', le(packetMax, 8), 8)
  Object.keys(KEEP_SETS).forEach((keep, i) => {
    const inv = inverses[keep]
    const bytes = [...le(inv.D, 8), ...inv.even.rows.flatMap(r => le(r, 2)), ...inv.odd.rows.flatMap(r => le(r, 2))]
    for (const row of [...inv.even.L, ...inv.odd.L]) {
      for (const v of row) {
        if (v > 2147483647n || v < -2147483648n) throw new Error('L entry exceeds i32')
        bytes.push(...le(v, 4))
      }
    }
    if (bytes.length !== KEEP_BYTES) throw new Error('keep table size')
    put(`keep${String(i)}`, bytes, 8)
  })
  pad(blob, 3)
  if (TABLE_BASE + blob.length > INFO_AT) throw new Error('tables overflow their region')
  return { blob, at, entries: ecols.length }
}

/**
 * Read the shipped tables back out of the WAT text: the inverse of tableBlob (for the tests and the check mode).
 * @returns {{ A: bigint[][], keeps: Record<string, { keptNodes: number[], D: bigint, even: { rows: number[], L: bigint[][] }, odd: { rows: number[], L: bigint[][] } }>, cols: number[], mengerNodes: number[], packetMax: bigint }}
 */
export function tablesFromWat(wat) {
  const start = wat.indexOf(`(data (i32.const ${String(TABLE_TEXT)})`)
  if (start < 0) throw new Error('pentora-codec.wat: no table text')
  const lines = wat.indexOf('\n', start)
  const blob = Buffer.from(wat.slice(lines, wat.indexOf(')', lines)).replace(/[\s"]/gu, ''), 'base64')
  const global = name => {
    const marker = `(global $${name} i32 (i32.const `
    const at = wat.indexOf(marker)
    if (at < 0) throw new Error(`pentora-codec.wat: no global ${name}`)
    return Number.parseInt(wat.slice(at + marker.length), 10) - TABLE_BASE
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const rowptr = Array.from({ length: ROWS + 1 }, (_, r) => view.getUint16(global('T_ROWPTR') + 2 * r, true))
  const ecols = global('T_ECOLS'), evals = global('T_EVALS')
  const A = Array.from({ length: ROWS }, (_, r) => {
    const row = Array(SLOTS).fill(0n)
    for (let e = rowptr[r]; e < rowptr[r + 1]; e += 1) row[blob[ecols + e]] = BigInt(view.getInt16(evals + 2 * e, true))
    return row
  })
  const mengerNodes = [...blob.subarray(global('T_MENGER'), global('T_MENGER') + 80)]
  const keeps = {}
  Object.keys(KEEP_SETS).forEach((keep, i) => {
    const base = global(`T_KEEP${String(i)}`)
    const L = (n, offset) => Array.from({ length: n }, (_, k) => Array.from({ length: n }, (_, m) => BigInt(view.getInt32(base + offset + 4 * (n * k + m), true))))
    const keptNodes = keep === 'menger-80' ? mengerNodes : [...KEEP_SETS[keep]]
    keeps[keep] = {
      keptNodes, D: view.getBigInt64(base, true),
      even: { rows: Array.from({ length: 30 }, (_, m) => view.getUint16(base + 8 + 2 * m, true)), L: L(30, 152) },
      odd: { rows: Array.from({ length: 42 }, (_, m) => view.getUint16(base + 68 + 2 * m, true)), L: L(42, 152 + 3600) },
    }
  })
  const cols = [...blob.subarray(global('T_COLS'), global('T_COLS') + 72)]
  return { A, keeps, cols, mengerNodes, packetMax: view.getBigInt64(global('T_PMAX'), true) }
}

/** The generated section of the WAT (between the markers, markers excluded) and the facts it carries. */
export function generateTables() {
  const { A } = evaluationMatrix()
  const inverses = {}
  for (const keep of Object.keys(KEEP_SETS)) {
    const inv = leftInverse(A, keep)
    proveLeftInverse(A, fullLeftInverse(inv), inv.D, inv.keptNodes)
    inverses[keep] = inv
  }
  const facts = bounds(A, inverses)
  const { blob, at, entries } = tableBlob(A, inverses, facts.packetMax)
  const b64 = Buffer.from(blob).toString('base64')
  if (b64.length > TABLE_TEXT_MAX || b64.includes('=')) throw new Error('table text')
  const info = `{"blockSize":72,`
    + `"denominatorBits":{"all":${String(facts.keep['all'].dBits)},"drop-0-9":${String(facts.keep['drop-0-9'].dBits)},"menger-80":${String(facts.keep['menger-80'].dBits)}},`
    + `"geometrySha256":"${GEOMETRY_SHA256}",`
    + `"keepSets":["all","drop-0-9","menger-80"],`
    + `"kept":{"all":${String(facts.keep['all'].kept)},"drop-0-9":${String(facts.keep['drop-0-9'].kept)},"menger-80":${String(facts.keep['menger-80'].kept)}},`
    + `"maxBlocks":${String(MAX_BLOCKS)},"nodes":${String(NODES)},`
    + `"packetMax":${String(facts.packetMax)},"profile":"${PROFILE}","rank":72,"scale":${String(SCALE)},`
    + `"valueMax":${String(VALUE_MAX)},"valueMin":${String(VALUE_MIN)}}`
  if (info.length >= TABLE_TEXT - INFO_AT || info.includes('\\')) throw new Error('INFO text')
  const lines = [
    `  ;; ${String(blob.length)} bytes of tables (${String(entries)} nonzero entries of A; Menger u8[80]; L and D of all three keep-sets) as base64,`,
    `  ;; decoded by $tables to $T_BASE on every call. D is ${String(facts.keep['all'].dBits)} bits ("all"), ${String(facts.keep['drop-0-9'].dBits)} bits ("drop-0-9") and ${String(facts.keep['menger-80'].dBits)} bits ("menger-80").`,
    `  (global $T_TEXTLEN i32 (i32.const ${String(b64.length)}))`,
    `  (global $T_ROWPTR i32 (i32.const ${String(at.rowptr)}))`,
    `  (global $T_ECOLS i32 (i32.const ${String(at.ecols)}))`,
    `  (global $T_EVALS i32 (i32.const ${String(at.evals)}))`,
    `  (global $T_COLS i32 (i32.const ${String(at.cols)}))`,
    `  (global $T_MENGER i32 (i32.const ${String(at.menger)}))`,
    `  (global $T_PMAX i32 (i32.const ${String(at.pmax)}))`,
    `  (global $T_KEEP0 i32 (i32.const ${String(at.keep0)}))`,
    `  (global $T_KEEP1 i32 (i32.const ${String(at.keep1)}))`,
    `  (global $T_KEEP2 i32 (i32.const ${String(at.keep2)}))`,
    `  (data (i32.const ${String(INFO_AT)}) "${info.replace(/"/gu, '\\22')}")`,
    `  (data (i32.const ${String(TABLE_TEXT)})`,
  ]
  for (let i = 0; i < b64.length; i += 96) lines.push(`    "${b64.slice(i, i + 96)}"`)
  lines[lines.length - 1] += ')'
  return { text: lines.join('\n'), facts, inverses, A, entries, info, blobBytes: blob.length }
}

/** The WAT with its generated section replaced by `tables`. */
export function watWithTables(wat, tables) {
  const begin = wat.indexOf(BEGIN), end = wat.indexOf(END)
  if (begin < 0 || end < begin || wat.indexOf(BEGIN, begin + 1) >= 0) throw new Error('pentora-codec.wat: markers')
  return `${wat.slice(0, begin + BEGIN.length)}\n${tables}\n  ${wat.slice(end)}`
}

// ---------- the cell, through the pinned compiler ----------
function skillsmith() {
  const bytes = readFileSync(new URL('skillsmith.wasm', CELLS))
  if (bytes.byteLength !== SKILLSMITH_PIN.bytes || sha256(bytes) !== SKILLSMITH_PIN.sha256) throw new Error('skillsmith.wasm does not match its pin')
  const module = new WebAssembly.Module(bytes)
  let seq = 0
  return (op, input) => {
    seq += 1
    const exports = new WebAssembly.Instance(module, {}).exports
    const request = cellRequestBytes(op, input, seq)
    exports.__mv_fuel_set(SKILLSMITH_FUEL)
    const pointer = exports.mv_alloc(request.byteLength)
    if (pointer === 0) throw new Error(`skillsmith ${op}: ALLOC`)
    new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
    exports.__mv_fuel_set(SKILLSMITH_FUEL)
    const packed = exports.mv_run(pointer, request.byteLength)
    const fuelUsed = Number(SKILLSMITH_FUEL - exports.__mv_fuel_remaining())
    const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
    const answer = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, offset, length)))
    if (answer.abi !== 1 || answer.seq !== seq || answer.status !== 'ok') throw new Error(`skillsmith ${op}: ${answer.code ?? 'bad envelope'}`)
    return { result: answer.result, fuelUsed }
  }
}

/** Build and meter WAT text exactly as compileAndRun does (name 'pentora-codec', version 'v1', object schemas). */
export function buildPentoraCodecCell(watText = readFileSync(new URL('pentora-codec.wat', CELLS), 'utf8')) {
  const call = skillsmith()
  const build = call('build', { wat: watText, name: 'pentora-codec', version: 'v1',
    input_schema: { type: 'object' }, output_schema: { type: 'object' }, fuel: 1_000_000 })
  const raw = Buffer.from(build.result.bytes, 'base64')
  if (sha256(raw) !== build.result.code_sha256) throw new Error('skillsmith build: code_sha256 does not match its bytes')
  const meter = call('meter', { bytes: build.result.bytes })
  const metered = Buffer.from(meter.result.bytes, 'base64')
  if (sha256(metered) !== meter.result.metered_sha256) throw new Error('skillsmith meter: metered_sha256 does not match its bytes')
  return { raw, metered, buildFuel: build.fuelUsed, meterFuel: meter.fuelUsed }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const watUrl = new URL('pentora-codec.wat', CELLS), wasmUrl = new URL('pentora-codec.wasm', CELLS)
  const shippedWat = readFileSync(watUrl, 'utf8')
  const tables = generateTables()
  const freshWat = watWithTables(shippedWat, tables.text)
  for (const [keep, f] of Object.entries(tables.facts.keep)) {
    console.log(`keep ${keep.padEnd(9)} L A = D I proved; D ${String(f.dBits)} bits, largest L entry ${String(f.lBits)} bits, |L y| < 2^${String(f.sBits)}, |A (L y)| < 2^${String(f.wideBits)}`)
  }
  console.log(`A: ${String(tables.entries)} nonzero entries (${String(tables.blobBytes)} table bytes), largest entry ${String(tables.facts.aBits)} bits; packet components |y| <= ${String(tables.facts.packetMax)} (${String(tables.facts.packetBits)} bits)`)
  if (process.argv.includes('--write')) writeFileSync(watUrl, freshWat)
  const wat = process.argv.includes('--write') ? freshWat : shippedWat
  const { raw, metered, buildFuel, meterFuel } = buildPentoraCodecCell(wat)
  if (process.argv.includes('--write')) writeFileSync(wasmUrl, metered)
  const shipped = readFileSync(wasmUrl)
  const tablesSame = freshWat === shippedWat || process.argv.includes('--write')
  console.log(`pentora-codec.wat  ${String(Buffer.byteLength(wat))} bytes sha256 ${sha256(Buffer.from(wat))} tables identical to regeneration: ${String(tablesSame)}`)
  console.log(`skillsmith build   ${String(raw.byteLength)} bytes sha256 ${sha256(raw)} fuel ${String(buildFuel)}`)
  console.log(`skillsmith meter   ${String(metered.byteLength)} bytes sha256 ${sha256(metered)} fuel ${String(meterFuel)}`)
  const same = Buffer.compare(shipped, metered) === 0
  console.log(`pentora-codec.wasm ${String(shipped.byteLength)} bytes sha256 ${sha256(shipped)} identical to rebuild: ${String(same)}`)
  process.exit(same && tablesSame ? 0 : 1)
}
