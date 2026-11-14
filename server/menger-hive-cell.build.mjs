/**
 * Derive the 80-site Menger sponge skeleton and the 80-site deterministic two-sided (4|4 bipartite) plain
 * control from server/pentora/geometry_index_table_v1.json, verify all ten rank-7 organ coupling factorizations over
 * F_65521, write apps/web/public/cells/menger/wirings.v1.json, embed the table digests and 9,760-byte wiring/factorization
 * blob into apps/web/public/cells/menger-hive.wat, and compile + meter apps/web/public/cells/menger-hive.wasm through
 * the repository's pinned skillsmith.wasm cell (zero external toolchain).
 *
 * Usage:
 *   node server/menger-hive-cell.build.mjs           (check mode: exit 1 if wirings.v1.json, .wat, or .wasm differs)
 *   node server/menger-hive-cell.build.mjs --write   (write wirings.v1.json, .wat, and metered .wasm)
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellRequestBytes } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'

const P = 65521
const CELLS = new URL('../apps/web/public/cells/', import.meta.url)
const GEOMETRY_TABLE = new URL('./pentora/geometry_index_table_v1.json', import.meta.url)
export const EXPECTED_GEOMETRY_TABLE_SHA256 = '96b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61'
export const MENGER_WIRINGS_FILE = 'menger/wirings.v1.json'
/** CELL_PINS.skillsmith in wasm-cells.ts; the compiler is refused unless it is exactly these bytes. */
const SKILLSMITH_PIN = Object.freeze({ sha256: '35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa', bytes: 592220 })
const SKILLSMITH_FUEL = 300_000_000n

const TABLE_SHA_LINE = /\(data \(i32\.const 1728\) "((?:\\[0-9a-f]{2}){32})"\)/u
const WIRINGS_SHA_LINE = /\(data \(i32\.const 1760\) "((?:\\[0-9a-f]{2}){32})"\)/u
const TABLES_BLOCK = / {2};; ---- HIVE-TABLES begin \(written by server\/menger-hive-cell\.build\.mjs; do not edit by hand\) ----\n[\s\S]*?\n {2};; ---- HIVE-TABLES end ----/u

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const utf8Sort = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort(utf8Sort)
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function modP(x) {
  const r = Number(BigInt(x) % BigInt(P))
  return r < 0 ? r + P : r
}

function modPow(base, exp) {
  let b = BigInt(modP(base)), e = BigInt(exp), acc = 1n
  const mod = BigInt(P)
  while (e > 0n) {
    if (e & 1n) acc = (acc * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return Number(acc)
}

function modInv(a) {
  const x = modP(a)
  if (x === 0) throw new Error('modInv(0)')
  return modPow(x, P - 2)
}

/** RREF over F_65521: returns { R: rows[rank][cols], pivots: number[] }. */
function rrefModP(matrix) {
  const rows = matrix.length, cols = rows > 0 ? matrix[0].length : 0
  const A = matrix.map(row => row.map(modP))
  const pivots = []
  let r = 0
  for (let c = 0; c < cols && r < rows; c += 1) {
    let p = -1
    for (let i = r; i < rows; i += 1) {
      if (A[i][c] !== 0) { p = i; break }
    }
    if (p === -1) continue
    if (p !== r) { const tmp = A[r]; A[r] = A[p]; A[p] = tmp }
    const inv = modInv(A[r][c])
    for (let j = c; j < cols; j += 1) A[r][j] = Number((BigInt(A[r][j]) * BigInt(inv)) % BigInt(P))
    for (let i = 0; i < rows; i += 1) {
      if (i === r || A[i][c] === 0) continue
      const f = BigInt(A[i][c])
      for (let j = c; j < cols; j += 1) {
        const sub = Number((f * BigInt(A[r][j])) % BigInt(P))
        A[i][j] = (A[i][j] + P - sub) % P
      }
    }
    pivots.push(c)
    r += 1
  }
  return { R: A.slice(0, r), pivots }
}

function matMulModP(A, B) {
  const m = A.length, k = A[0].length, n = B[0].length
  const out = Array.from({ length: m }, () => new Array(n).fill(0))
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let sum = 0n
      for (let t = 0; t < k; t += 1) sum += BigInt(A[i][t]) * BigInt(B[t][j])
      out[i][j] = Number(sum % BigInt(P))
    }
  }
  return out
}

function connectedComponents(n, edges) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u) }
  const seen = new Uint8Array(n)
  let comps = 0
  for (let s = 0; s < n; s += 1) {
    if (seen[s]) continue
    comps += 1
    const stack = [s]
    while (stack.length > 0) {
      const x = stack.pop()
      if (seen[x]) continue
      seen[x] = 1
      for (const y of adj[x]) if (!seen[y]) stack.push(y)
    }
  }
  return comps
}

function buildWaveOperator(n, edges, det, detuned) {
  const adj = Array.from({ length: n }, () => new Array(n).fill(0))
  const deg = new Array(n).fill(0)
  for (const [u, v] of edges) {
    adj[u][v] += 1; adj[v][u] += 1
    deg[u] += 1; deg[v] += 1
  }
  const M = Array.from({ length: 2 * n }, () => new Array(2 * n).fill(0))
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let lij = adj[i][j]
      if (i === j) lij -= deg[i] + (detuned ? det[i] : 0)
      const lp = modP(lij)
      M[i][j] = modP((i === j ? 1 : 0) + lp)
      M[i][n + j] = i === j ? 1 : 0
      M[n + i][j] = lp
      M[n + i][n + j] = i === j ? 1 : 0
    }
  }
  return { M, deg }
}

function krylovReach(M, b) {
  const dim = M.length
  const rows = new Map()
  let v = b.map(modP)
  let count = 0
  while (true) {
    const x = [...v]
    for (const j of [...rows.keys()].sort((a, z) => a - z)) {
      if (x[j] !== 0) {
        const r = rows.get(j), f = BigInt(x[j])
        for (let c = j; c < dim; c += 1) x[c] = (x[c] + P - Number((f * BigInt(r[c])) % BigInt(P))) % P
      }
    }
    let piv = -1
    for (let c = 0; c < dim; c += 1) if (x[c] !== 0) { piv = c; break }
    if (piv === -1) break
    const inv = BigInt(modInv(x[piv]))
    rows.set(piv, x.map(val => Number((BigInt(val) * inv) % BigInt(P))))
    count += 1
    const next = new Array(dim).fill(0)
    for (let i = 0; i < dim; i += 1) {
      let s = 0n
      for (let j = 0; j < dim; j += 1) if (M[i][j] !== 0 && v[j] !== 0) s += BigInt(M[i][j]) * BigInt(v[j])
      next[i] = Number(s % BigInt(P))
    }
    v = next
  }
  return count
}

/** Derive both wirings, verify all structural invariants and rank-7 factorizations, and pack the 9,760-byte table blob. */
export function deriveMengerHiveTables() {
  const tableBytes = readFileSync(GEOMETRY_TABLE)
  const tableSha256 = sha256(tableBytes)
  if (tableSha256 !== EXPECTED_GEOMETRY_TABLE_SHA256) {
    throw new Error(`geometry_index_table_v1.json sha256 mismatch: ${tableSha256}`)
  }
  const G = JSON.parse(tableBytes.toString('utf8'))
  const nz = lc => lc.reduce((acc, x) => acc + (x !== 0 ? 1 : 0), 0)

  const kind = new Map()
  const cubesOf = new Map()
  const mengerGlobalEdges = new Set()
  for (let ci = 0; ci < G.cubes.length; ci += 1) {
    const cube = G.cubes[ci]
    const l2g = new Map()
    for (const s of cube.slots) {
      const key = s.local_coord.join(',')
      l2g.set(key, s.global_index)
      const k = nz(s.local_coord)
      if (kind.has(s.global_index) && kind.get(s.global_index) !== k) throw new Error('inconsistent kind')
      kind.set(s.global_index, k)
      if (!cubesOf.has(s.global_index)) cubesOf.set(s.global_index, new Set())
      cubesOf.get(s.global_index).add(ci)
    }
    for (const s of cube.slots) {
      if (nz(s.local_coord) === 2) {
        const ax = s.local_coord.findIndex(x => x === 0)
        for (const sign of [-1, 1]) {
          const cc = [...s.local_coord]
          cc[ax] = sign
          const other = l2g.get(cc.join(','))
          const a = Math.min(s.global_index, other), b = Math.max(s.global_index, other)
          mengerGlobalEdges.add(`${a},${b}`)
        }
      }
    }
  }

  const ids110 = G.points
    .map(pt => pt.global_index)
    .filter(id => id !== G.centre_index)
    .sort((a, b) => a - b)
  if (ids110.length !== 110) throw new Error(`expected 110 non-centre points, got ${ids110.length}`)
  const posOf = new Map(ids110.map((id, idx) => [id, idx]))
  const det110 = Array.from({ length: 110 }, (_, idx) => (idx * 17 + 3) % 11)

  const cornersGlobal = [...kind.entries()].filter(([, k]) => k === 3).map(([g]) => g).sort((a, b) => a - b)
  const organsGlobal = Array.from({ length: 5 }, (_, k) =>
    [...kind.entries()]
      .filter(([g, kd]) => kd === 2 && cubesOf.get(g).size === 1 && cubesOf.get(g).has(k))
      .map(([g]) => g)
      .sort((a, b) => a - b))

  if (cornersGlobal.length !== 20 || organsGlobal.some(o => o.length !== 12)) {
    throw new Error('unexpected Menger corner/organ counts')
  }
  const mengerGlobalSites = [...cornersGlobal, ...organsGlobal.flat()]
  const localOfGlobal = new Map(mengerGlobalSites.map((g, idx) => [g, idx]))
  const mengerEdges = [...mengerGlobalEdges]
    .map(pair => {
      const [ga, gb] = pair.split(',').map(Number)
      const la = localOfGlobal.get(ga), lb = localOfGlobal.get(gb)
      return la < lb ? [la, lb] : [lb, la]
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const mengerDet = mengerGlobalSites.map(g => det110[posOf.get(g)])

  // Deterministic two-sided (4|4 bipartite) plain baseline:
  // 10 pairs (a, b) own 2 shared words each (0..19), so each bank touches 8 shared words.
  // Each bank splits its 8 shared words 4|4 (after rotating by bank index k) and wires its 12 private words
  // as K_{4,4} minus a perfect matching (each shared word used 3 times, each private word degree 2).
  const bankShared = Array.from({ length: 5 }, () => [])
  let nextShared = 0
  for (let a = 0; a < 5; a += 1) {
    for (let b = a + 1; b < 5; b += 1) {
      bankShared[a].push(nextShared, nextShared + 1)
      bankShared[b].push(nextShared, nextShared + 1)
      nextShared += 2
    }
  }
  const plainEdges = []
  for (let k = 0; k < 5; k += 1) {
    const sh = bankShared[k]
    const rot = Array.from({ length: 8 }, (_, idx) => sh[(idx + k) % 8])
    const left = rot.slice(0, 4), right = rot.slice(4, 8)
    let j = 0
    for (let l = 0; l < 4; l += 1) {
      for (let r = 0; r < 4; r += 1) {
        if (r === (l + 1) % 4) continue
        const priv = 20 + 12 * k + j
        plainEdges.push([left[l], priv], [right[r], priv])
        j += 1
      }
    }
  }
  plainEdges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const plainDet = det110.slice(0, 80)

  const specs = [
    { name: 'menger', edges: mengerEdges, det: mengerDet, globalSites: mengerGlobalSites, expectedUndetunedReach: 20 },
    { name: 'plain', edges: plainEdges, det: plainDet, globalSites: null, expectedUndetunedReach: 80 },
  ]

  const tableBlob = Buffer.alloc(9760)
  const wiringsMeta = {}

  specs.forEach((spec, wIdx) => {
    if (spec.edges.length !== 120) throw new Error(`${spec.name}: expected 120 edges`)
    const comps = connectedComponents(80, spec.edges)
    const cycleRank = spec.edges.length - 80 + comps
    if (comps !== 1 || cycleRank !== 41) throw new Error(`${spec.name}: expected 1 component & cycle rank 41`)

    const { M, deg } = buildWaveOperator(80, spec.edges, spec.det, true)
    for (let i = 0; i < 80; i += 1) {
      const wantDeg = i < 20 ? 6 : 2
      if (deg[i] !== wantDeg) throw new Error(`${spec.name}: unexpected degree ${deg[i]} at site ${i}`)
    }
    const inlet = new Array(160).fill(0)
    inlet[0] = 1; inlet[80] = 1
    const detunedReach = krylovReach(M, inlet)
    const { M: M0 } = buildWaveOperator(80, spec.edges, spec.det, false)
    const undetunedReach = krylovReach(M0, inlet)
    if (detunedReach !== 160) throw new Error(`${spec.name}: expected detuned reach 160, got ${detunedReach}`)
    if (undetunedReach !== spec.expectedUndetunedReach) {
      throw new Error(`${spec.name}: expected undetuned reach ${spec.expectedUndetunedReach}, got ${undetunedReach}`)
    }

    const base = wIdx * 4880
    spec.edges.forEach(([u, v], eIdx) => {
      tableBlob[base + 2 * eIdx] = u
      tableBlob[base + 2 * eIdx + 1] = v
    })
    deg.forEach((d, i) => { tableBlob[base + 240 + i] = d })
    spec.det.forEach((d, i) => { tableBlob[base + 320 + i] = d })

    for (let k = 0; k < 5; k += 1) {
      const s0 = 20 + 12 * k
      const Sa = [
        ...Array.from({ length: 12 }, (_, j) => s0 + j),
        ...Array.from({ length: 12 }, (_, j) => 80 + s0 + j),
      ]
      const saSet = new Set(Sa)
      const Sb = Array.from({ length: 160 }, (_, idx) => idx).filter(idx => !saSet.has(idx))

      const Xab = Sa.map(r => Sb.map(c => M[r][c]))
      const Xba = Sb.map(r => Sa.map(c => M[r][c]))
      const { R: Ra, pivots: pa } = rrefModP(Xab)
      const Fa = Sa.map((_, r) => pa.map(c => Xab[r][c]))
      const { R: Rb, pivots: pb } = rrefModP(Xba)
      const Fb = Sb.map((_, r) => pb.map(c => Xba[r][c]))

      if (Ra.length !== 7 || Rb.length !== 7) {
        throw new Error(`${spec.name} organ ${k}: expected rank (7, 7), got (${Ra.length}, ${Rb.length})`)
      }
      const prodAB = matMulModP(Fa, Ra)
      const prodBA = matMulModP(Fb, Rb)
      for (let r = 0; r < 24; r += 1) {
        for (let c = 0; c < 136; c += 1) {
          if (prodAB[r][c] !== Xab[r][c]) throw new Error(`${spec.name} organ ${k}: Fa*Ra != Xab`)
        }
      }
      for (let r = 0; r < 136; r += 1) {
        for (let c = 0; c < 24; c += 1) {
          if (prodBA[r][c] !== Xba[r][c]) throw new Error(`${spec.name} organ ${k}: Fb*Rb != Xba`)
        }
      }

      // Verify exact structural sparsity exploited by menger-hive.wat:
      for (let r = 0; r < 7; r += 1) {
        for (let c = 20; c < 136; c += 1) if (Ra[r][c] !== 0) throw new Error('Ra nonzero outside 0..19')
        for (let c = 12; c < 24; c += 1) if (Rb[r][c] !== 0) throw new Error('Rb nonzero outside 0..11')
      }
      for (let j = 0; j < 12; j += 1) {
        for (let r = 0; r < 7; r += 1) if (Fa[j][r] !== Fa[12 + j][r]) throw new Error('Fa top/bottom mismatch')
      }
      for (let idx = 0; idx < 136; idx += 1) {
        const isQCorner = idx < 20
        const isPCorner = idx >= 68 && idx < 88
        for (let r = 0; r < 7; r += 1) {
          if (!isQCorner && !isPCorner && Fb[idx][r] !== 0) throw new Error('Fb nonzero outside corner rows')
          if (isQCorner && Fb[idx][r] !== Fb[68 + idx][r]) throw new Error('Fb q/p corner mismatch')
        }
      }

      const ob = base + 400 + 896 * k
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 20; c += 1) tableBlob.writeUInt16LE(Ra[r][c], ob + 2 * (r * 20 + c))
      }
      for (let j = 0; j < 12; j += 1) {
        for (let r = 0; r < 7; r += 1) tableBlob.writeUInt16LE(Fa[j][r], ob + 280 + 2 * (j * 7 + r))
      }
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 12; c += 1) tableBlob.writeUInt16LE(Rb[r][c], ob + 448 + 2 * (r * 12 + c))
      }
      for (let c = 0; c < 20; c += 1) {
        for (let r = 0; r < 7; r += 1) tableBlob.writeUInt16LE(Fb[c][r], ob + 616 + 2 * (c * 7 + r))
      }
    }

    wiringsMeta[spec.name] = {
      deg,
      det: spec.det,
      detunedWaveReach: detunedReach,
      edges: spec.edges,
      ...(spec.globalSites ? { globalSites: spec.globalSites } : {}),
      undetunedOneCornerWaveReach: undetunedReach,
    }
  })

  const wiringsDoc = {
    boundaryWords: 7,
    corners: 20,
    cycleRank: 41,
    field: P,
    horizonTicks: 8,
    inletCornerIndex: 0,
    links: 120,
    organPrivateSites: 12,
    organWords: 24,
    organs: 5,
    schema: 'aukora.menger.wirings.v1',
    sites: 80,
    stateWords: 160,
    tableSha256,
    wirings: wiringsMeta,
  }
  const wiringsBytes = Buffer.from(canonicalJson(wiringsDoc), 'utf8')
  const wiringsSha256 = sha256(wiringsBytes)
  return { tableSha256, wiringsBytes, wiringsSha256, tableBlob }
}

function escapeBytes(buf) {
  let out = ''
  for (let i = 0; i < buf.length; i += 1) out += `\\${buf[i].toString(16).padStart(2, '0')}`
  return out
}

function formatTablesBlock(tableBlob) {
  const lines = ['  ;; ---- HIVE-TABLES begin (written by server/menger-hive-cell.build.mjs; do not edit by hand) ----']
  for (let off = 0; off < tableBlob.length; off += 64) {
    const slice = tableBlob.subarray(off, Math.min(off + 64, tableBlob.length))
    lines.push(`  (data (i32.const ${4096 + off}) "${escapeBytes(slice)}")`)
  }
  lines.push('  ;; ---- HIVE-TABLES end ----')
  return lines.join('\n')
}

function skillsmith() {
  const bytes = readFileSync(new URL('skillsmith.wasm', CELLS))
  if (bytes.byteLength !== SKILLSMITH_PIN.bytes || sha256(bytes) !== SKILLSMITH_PIN.sha256) {
    throw new Error('skillsmith.wasm does not match its pin')
  }
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
    if (answer.abi !== 1 || answer.seq !== seq || answer.status !== 'ok') {
      throw new Error(`skillsmith ${op}: ${answer.code ?? 'bad envelope'}`)
    }
    return { result: answer.result, fuelUsed }
  }
}

function selfTestMeteredHive(meteredBytes, expectedTableSha256, expectedWiringsSha256) {
  const module = new WebAssembly.Module(meteredBytes)
  const grant = 20_000_000n
  let seq = 0
  let maxFuel = 0
  const invoke = (op, input) => {
    seq += 1
    const exports = new WebAssembly.Instance(module, {}).exports
    const req = cellRequestBytes(op, input, seq)
    exports.__mv_fuel_set(grant)
    const ptr = exports.mv_alloc(req.byteLength)
    if (ptr === 0) throw new Error(`menger-hive ${op}: ALLOC`)
    new Uint8Array(exports.memory.buffer, ptr, req.byteLength).set(req)
    exports.__mv_fuel_set(grant)
    const packed = exports.mv_run(ptr, req.byteLength)
    const fuelUsed = Number(grant - exports.__mv_fuel_remaining())
    if (fuelUsed > maxFuel) maxFuel = fuelUsed
    const len = Number(packed >> 32n), off = Number(packed & 0xffff_ffffn)
    const raw = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, off, len))
    const parsed = JSON.parse(raw)
    if (canonicalJson(parsed) !== raw) throw new Error(`menger-hive ${op}: non-canonical response JSON: ${raw}`)
    if (parsed.status !== 'ok') throw new Error(`menger-hive ${op} refused: ${parsed.code}`)
    return { result: parsed.result, fuelUsed }
  }

  const info = invoke('hive.info', {}).result
  if (info.tableSha256 !== expectedTableSha256 || info.wiringsSha256 !== expectedWiringsSha256) {
    throw new Error('hive.info sha256 mismatch')
  }

  // Co-simulate 16 ticks with mid-run handover at cut=8 (organ 0 -> organ 3) for both "menger" and "plain":
  const splitState = (full, k) => {
    const s0 = 20 + 12 * k
    const organState = [...full.slice(s0, s0 + 12), ...full.slice(80 + s0, 80 + s0 + 12)]
    const bodyQ = [], bodyP = []
    for (let s = 0; s < 80; s += 1) {
      if (s >= s0 && s < s0 + 12) continue
      bodyQ.push(full[s]); bodyP.push(full[80 + s])
    }
    return { organState, bodyState: [...bodyQ, ...bodyP] }
  }
  const joinState = (organState, bodyState, k) => {
    const s0 = 20 + 12 * k
    const full = new Array(160).fill(0)
    for (let j = 0; j < 12; j += 1) {
      full[s0 + j] = organState[j]
      full[80 + s0 + j] = organState[12 + j]
    }
    let idx = 0
    for (let s = 0; s < 80; s += 1) {
      if (s >= s0 && s < s0 + 12) continue
      full[s] = bodyState[idx]
      full[80 + s] = bodyState[68 + idx]
      idx += 1
    }
    return full
  }
  const wordsShaHex = words => {
    const buf = Buffer.alloc(words.length * 2)
    words.forEach((w, i) => buf.writeUInt16LE(w, 2 * i))
    return sha256(buf)
  }

  for (const wiring of ['menger', 'plain']) {
    let mono = Array.from({ length: 160 }, (_, idx) => (idx * 4099 + 17) % P)
    let activeOrgan = 0
    let { organState, bodyState } = splitState(mono, activeOrgan)
    for (let t = 0; t < 16; t += 1) {
      if (t === 8) {
        const joined = joinState(organState, bodyState, activeOrgan)
        activeOrgan = 3
        ;({ organState, bodyState } = splitState(joined, activeOrgan))
      }
      const input = (t * 7919 + 65500) % P
      const mStep = invoke('hive.step_monolith', { input, state: mono, wiring }).result
      const { msgToEdge } = invoke('hive.boundary', { bodyState, edgeOrgan: activeOrgan, wiring }).result
      const oStep = invoke('hive.step_organ', { input, msgIn: msgToEdge, organ: activeOrgan, organState, wiring }).result
      const bStep = invoke('hive.step_body', { bodyState, edgeOrgan: activeOrgan, input, msgFromEdge: oStep.msgOut, wiring }).result
      organState = oStep.nextOrganState
      bodyState = bStep.nextBodyState
      mono = mStep.nextState
      const reassembled = joinState(organState, bodyState, activeOrgan)
      if (wordsShaHex(reassembled) !== mStep.stateSha256) {
        throw new Error(`self-test mismatch at tick ${t} on wiring ${wiring}`)
      }
    }
  }
  return { maxFuel }
}

export function mengerHiveSource() {
  const { tableSha256, wiringsBytes, wiringsSha256, tableBlob } = deriveMengerHiveTables()
  const shippedWat = readFileSync(new URL('menger-hive.wat', CELLS), 'utf8')
  if (!TABLE_SHA_LINE.test(shippedWat)) throw new Error('menger-hive.wat missing TABLE-SHA256 line')
  if (!WIRINGS_SHA_LINE.test(shippedWat)) throw new Error('menger-hive.wat missing WIRINGS-SHA256 line')
  if (!TABLES_BLOCK.test(shippedWat)) throw new Error('menger-hive.wat missing HIVE-TABLES block')
  const escTable = tableSha256.replace(/../gu, b => `\\${b}`)
  const escWirings = wiringsSha256.replace(/../gu, b => `\\${b}`)
  const wat = shippedWat
    .replace(TABLE_SHA_LINE, `(data (i32.const 1728) "${escTable}")`)
    .replace(WIRINGS_SHA_LINE, `(data (i32.const 1760) "${escWirings}")`)
    .replace(TABLES_BLOCK, formatTablesBlock(tableBlob))
  return { tableSha256, wiringsBytes, wiringsSha256, shippedWat, wat }
}

export function buildMengerHiveCell() {
  const { tableSha256, wiringsBytes, wiringsSha256, shippedWat, wat: text } = mengerHiveSource()
  const wat = Buffer.from(text, 'utf8')
  const call = skillsmith()
  const build = call('build', {
    wat: text, name: 'menger-hive', version: 'v1',
    input_schema: { type: 'object' }, output_schema: { type: 'object' }, fuel: 10_000_000,
  })
  const raw = Buffer.from(build.result.bytes, 'base64')
  if (sha256(raw) !== build.result.code_sha256) throw new Error('skillsmith build: code_sha256 mismatch')
  const meter = call('meter', { bytes: build.result.bytes })
  const metered = Buffer.from(meter.result.bytes, 'base64')
  if (sha256(metered) !== meter.result.metered_sha256) throw new Error('skillsmith meter: metered_sha256 mismatch')
  const { maxFuel } = selfTestMeteredHive(metered, tableSha256, wiringsSha256)
  return {
    wat, raw, metered, wiringsBytes, tableSha256, wiringsSha256,
    buildFuel: build.fuelUsed, meterFuel: meter.fuelUsed, maxCallFuel: maxFuel,
    watCurrent: shippedWat === text,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write')
  const {
    wat, raw, metered, wiringsBytes, tableSha256, wiringsSha256,
    buildFuel, meterFuel, maxCallFuel, watCurrent,
  } = buildMengerHiveCell()
  const wiringsUrl = new URL(MENGER_WIRINGS_FILE, CELLS)
  const watUrl = new URL('menger-hive.wat', CELLS)
  const wasmUrl = new URL('menger-hive.wasm', CELLS)
  if (write) {
    mkdirSync(dirname(fileURLToPath(wiringsUrl)), { recursive: true })
    writeFileSync(wiringsUrl, wiringsBytes)
    writeFileSync(watUrl, wat)
    writeFileSync(wasmUrl, metered)
  }
  let shippedWirings = Buffer.alloc(0)
  let shippedWasm = Buffer.alloc(0)
  try { shippedWirings = readFileSync(wiringsUrl) } catch { /* missing */ }
  try { shippedWasm = readFileSync(wasmUrl) } catch { /* missing */ }
  const wiringsSame = Buffer.compare(shippedWirings, wiringsBytes) === 0
  const wasmSame = Buffer.compare(shippedWasm, metered) === 0
  const same = wiringsSame && wasmSame && (write || watCurrent)
  console.log(`geometry_table   sha256 ${tableSha256}`)
  console.log(`wirings.v1.json  ${wiringsBytes.byteLength} bytes sha256 ${wiringsSha256} identical: ${wiringsSame}`)
  console.log(`menger-hive.wat  ${wat.byteLength} bytes sha256 ${sha256(wat)} current: ${write || watCurrent}`)
  console.log(`skillsmith build ${raw.byteLength} bytes sha256 ${sha256(raw)} fuel ${buildFuel}`)
  console.log(`skillsmith meter ${metered.byteLength} bytes sha256 ${sha256(metered)} fuel ${meterFuel}`)
  console.log(`menger-hive.wasm ${shippedWasm.byteLength} bytes sha256 ${sha256(shippedWasm)} maxCallFuel ${maxCallFuel} identical to rebuild: ${same}`)
  process.exit(same ? 0 : 1)
}
