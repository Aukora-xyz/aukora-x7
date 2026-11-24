/**
 * Test vectors for the Aura focus cell shadow, copied from the weight-space lab's test set (
 * t_reference_cases.mjs, t_random.mjs and verify_cases.json, the last one byte-identical as aura-focus-cell.vectors.json).
 * The lab ran 2.1 million inputs; this suite runs a bounded deterministic part of them:
 *  - every plain-input case of aura-focus-shadow.test.mjs and the 211 cases its verify.py builds;
 *  - the lab's whole targeted boundary sweep (every double within a few ulp of each edge, every exponent field,
 *    short and huge lists, very large counts at the coherence edges, drift counts at their edges);
 *  - a seeded random sample drawn from the lab's four distributions (ordinary, wide, near, invalid).
 */
import { readFileSync } from 'node:fs'

export const META = Object.freeze({ ballId: 'a'.repeat(64), epoch: 7, computedAt: 1_794_398_400_000 })
export const BASE = Object.freeze({ ...META, reachableDagNodes: 10, declaredDagNodes: 10, verifiedReceipts: 10, totalReceipts: 10,
  activeOrgans: 10, declaredOrgans: 10, unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 20,
  observedSurpriseScores: [], handOffEpochMismatch: false, staleHeartbeatRatio: 0 })
const MAXS = Number.MAX_SAFE_INTEGER, MAXV = Number.MAX_VALUE, MINV = Number.MIN_VALUE
const T_OBS = 7.737990105077793, T_ESC = 21.68251319235133, BAND = 25 * 2 ** -40, UNIT = 2 ** -40
const s = overrides => ({ ...BASE, ...overrides })

const view = new DataView(new ArrayBuffer(8))
const bits = x => { view.setFloat64(0, x, false); return [view.getUint32(0, false), view.getUint32(4, false)] }
const fromBits = (hi, lo) => { view.setUint32(0, hi, false); view.setUint32(4, lo, false); return view.getFloat64(0, false) }

/** Move a positive double by k units in the last place. */
function step(x, k) {
  const [hi, lo] = bits(x)
  let p = (BigInt(hi) << 32n) | BigInt(lo)
  p += BigInt(k)
  if (p < 0n) p = 0n
  if (p > 0x7fefffffffffffffn) p = 0x7fefffffffffffffn
  return fromBits(Number(p >> 32n), Number(p & 0xffffffffn))
}

/** Deterministic 32-bit generator (mulberry32), as the lab used. */
export function rng(seed) {
  let a = seed >>> 0
  const u32 = () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  const unit = () => (u32() * 2 ** 21 + (u32() >>> 11)) / 2 ** 53
  const int = n => Math.floor(unit() * n)
  const range = (lo, hi) => lo + int(hi - lo + 1)
  const pick = arr => arr[int(arr.length)]
  return { u32, unit, int, range, pick }
}

/** t_reference_cases.mjs: the reference's own plain-input cases, then verify.py's 211. */
export function referenceCases() {
  const cases = []
  const add = (group, input) => cases.push({ group, input })
  for (const o of [{}, { activeOrgans: 9 }, { observedSurpriseScores: [10] }, { handOffEpochMismatch: true }, { unanchoredPredictions: 1 },
    { observedSurpriseScores: [25] }, { staleHeartbeatRatio: 0.8 }]) add('every recommendation', s(o))
  for (let mask = 0; mask < 16; mask += 1) {
    add('sixteen drift cases', s({ handOffEpochMismatch: Boolean(mask & 8), unanchoredPredictions: mask & 4 ? 1 : 0,
      pendingWakes: mask & 2 ? 2 : 0, lastRollbackAgeEpochs: mask & 1 ? 0 : 10 }))
  }
  add('sixteen drift cases', s({ handOffEpochMismatch: true, pendingWakes: 2, lastRollbackAgeEpochs: 0 }))
  for (const t of [T_OBS, T_ESC]) for (const x of [t, t - 1e-8, t + 1e-8]) add('surprise boundaries', s({ observedSurpriseScores: [x] }))
  for (const o of [{ staleHeartbeatRatio: 0.7 }, { reachableDagNodes: 8556839292003941, declaredDagNodes: 9007199254740991 },
    { staleHeartbeatRatio: 0.7 - 1e-8 }, { staleHeartbeatRatio: 0.7 + 1e-8 }, { reachableDagNodes: 19, declaredDagNodes: 20 }]) add('heartbeat and coherence edges', s(o))
  for (const o of [{ handOffEpochMismatch: true, unanchoredPredictions: 1, staleHeartbeatRatio: 0.7 },
    { staleHeartbeatRatio: 0.8, observedSurpriseScores: [T_ESC] }, { observedSurpriseScores: [25], staleHeartbeatRatio: 0.7 },
    { handOffEpochMismatch: true, observedSurpriseScores: [T_OBS] }]) add('higher priority dominates', s(o))
  for (const v of [[MAXV], Array(5).fill(MAXV), [MINV, MAXV, 0, MINV, 0]]) add('whole binary64 and count range', s({ observedSurpriseScores: v }))
  for (const o of [{ observedSurpriseScores: [MINV], staleHeartbeatRatio: MINV }, { staleHeartbeatRatio: MAXV },
    { reachableDagNodes: MAXS, declaredDagNodes: MAXS, verifiedReceipts: MAXS, totalReceipts: MAXS, activeOrgans: MAXS, declaredOrgans: MAXS },
    { unanchoredPredictions: MAXS }]) add('whole binary64 and count range', s(o))
  for (const v of [[MAXV, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5], Array(10_000).fill(0)]) add('last five only', s({ observedSurpriseScores: v }))
  for (const o of [{ declaredOrgans: 0 }, { reachableDagNodes: 11 }, { staleHeartbeatRatio: -0 }, { observedSurpriseScores: [Infinity] },
    { observedSurpriseScores: [-0] }, { observedSurpriseScores: Array(2) }, { observedSurpriseScores: Array(10_001).fill(0) },
    { observedSurpriseScores: [NaN, 0, 0, 0, 0, 0] }]) add('incomplete evidence', s(o))
  for (const field of Object.keys(BASE)) {
    const v = s({})
    delete v[field]
    add('incomplete evidence (field removed)', v)
  }
  for (const v of [null, [], {}]) add('incomplete evidence (not a signal object)', v)
  add('ignored claims', { ...s({ activeOrgans: 9 }), recommendedFocus: 'rest', vector: { coherence: 1, wakeUrgency: 0 },
    scorer: 'super-verified', authorityTier: 'owner', granted: true, hints: { reward: 100 }, auraShadow: { focus: 'rest' } })
  const verify = JSON.parse(readFileSync(new URL('./aura-focus-cell.vectors.json', import.meta.url), 'utf8'))
  for (const c of verify) add('verify.py', c)
  return cases
}

/** t_random.mjs `targeted`: the deterministic boundary sweep, yielded one input at a time. */
export function* targetedCases() {
  const run = (group, o) => ({ group, input: s(o) })
  for (const centre of [0.7, 0.7 - UNIT, 0.7 + UNIT]) for (let k = -300; k <= 300; k += 1) yield run('heartbeat near 7/10 and both band edges', { staleHeartbeatRatio: step(centre, k) })
  for (let e = 0; e <= 2046; e += 1) for (const [fh, fl] of [[0, 0], [0xfffff, 0xffffffff], [0x66666, 0x66666666], [0, 1]]) {
    const x = fromBits(((e << 20) | fh) >>> 0, fl >>> 0)
    yield run('heartbeat at every exponent field', { staleHeartbeatRatio: x })
    yield run('one score at every exponent field', { observedSurpriseScores: [x] })
    yield run('five scores at every exponent field', { observedSurpriseScores: [x, step(x, 1), x, 0, MINV] })
    yield run('subnormal and huge mixed with a near-threshold score', { observedSurpriseScores: [MINV, T_OBS * 3, 0, x] })
  }
  for (const t of [T_OBS, T_ESC]) for (const centre of [t, t - BAND, t + BAND]) for (let n = 1; n <= 5; n += 1) for (let k = -120; k <= 120; k += 1) {
    const x = step(centre, k)
    yield run('n equal scores near each threshold and band edge', { observedSurpriseScores: Array(n).fill(x) })
    yield run('one score of n*x with n-1 zeros', { observedSurpriseScores: [step(centre * n, k), ...Array(n - 1).fill(0)] })
    if (n > 1) yield run('one score of n*x, one subnormal, zeros', { observedSurpriseScores: [step(centre * n, k), MINV, ...Array(n - 2).fill(0)] })
  }
  for (const list of [[], [0], [0, 0, 0, 0, 0], [MINV], Array(5).fill(MINV), [MAXV], Array(5).fill(MAXV),
    [127.99999999999999], Array(5).fill(127.99999999999999), [128], [2 ** -1074, 2 ** -1022, 2 ** -537, 1, 127.99999999999999],
    [T_OBS * 5, MINV, 0, 0, 0], [T_ESC * 5, MINV, 0, 0, 0], [38.68995052538896, 0, 0, 0, MINV]]) yield run('empty, short, subnormal and huge lists', { observedSurpriseScores: list })
  for (const dd of [20, 2 ** 40, 2 ** 41 + 7, 20 * 2 ** 40, 2 ** 52 + 1, 8765432109876543, MAXS - 1, MAXS]) {
    const centre = (19n * BigInt(dd)) / 20n, half = BigInt(dd) >> 40n
    for (const c of [centre - half, centre, centre + half]) for (let k = -60; k <= 60; k += 1) {
      const rd = c + BigInt(k)
      if (rd < 0n || rd > BigInt(dd)) continue
      yield run('coherence near 19/20 and both band edges, large totals', { reachableDagNodes: Number(rd), declaredDagNodes: dd })
      yield run('same with all three totals at the largest safe integer', { reachableDagNodes: Number(rd), declaredDagNodes: dd,
        verifiedReceipts: MAXS, totalReceipts: MAXS, activeOrgans: MAXS - (k & 1), declaredOrgans: MAXS })
    }
  }
  for (const u of [0, 1, 2, 5, 2 ** 32, MAXS]) for (const w of [0, 1, 2, 3, MAXS]) for (const a of [0, 2, 3, MAXS]) for (const h of [false, true]) {
    yield run('drift counts at their edges and at the largest safe integer', { unanchoredPredictions: u, pendingWakes: w, lastRollbackAgeEpochs: a, handOffEpochMismatch: h })
  }
}

/** t_random.mjs `random`: ordinary 35 %, wide 30 %, near 30 %, invalid 5 %, from one seed. */
export function* randomCases(seed, count) {
  const R = rng(seed)
  const bigCount = () => Math.min(MAXS, R.int(2 ** R.range(1, 53)))
  const pair = () => {
    const den = Math.max(1, bigCount()), pickN = R.int(10)
    return [pickN < 4 ? den : pickN < 7 ? R.int(den + 1) : Math.max(0, den - R.int(4)), den]
  }
  const anyDouble = () => fromBits(((R.int(2047)) << 20 | R.int(2 ** 20)) >>> 0, R.u32())
  const bitsOf = () => ({ handOffEpochMismatch: R.int(2) === 1, unanchoredPredictions: R.int(3) === 0 ? R.range(1, 3) : 0,
    pendingWakes: R.int(4), lastRollbackAgeEpochs: R.int(2) ? R.int(3) : R.range(3, 500) })
  function ordinary() {
    const dd = R.range(1, 5000), dr = R.range(1, 20000), dorg = R.range(1, 40)
    const hbRoll = R.int(10), running = R.range(1, 12), ratio = R.int(running + 1) / running
    const len = (() => { const r = R.int(1000); return r < 150 ? 0 : r < 750 ? R.range(1, 5) : r < 999 ? R.range(6, 200) : R.range(201, 10000) })()
    const score = () => { const r = R.int(100); return r < 70 ? R.unit() * 2 : r < 90 ? R.unit() * 12 : r < 98 ? R.unit() * 40 : 0 }
    return { ...META,
      declaredDagNodes: dd, reachableDagNodes: R.int(10) < 9 ? dd : dd - R.int(Math.min(dd, 50) + 1),
      totalReceipts: dr, verifiedReceipts: R.int(10) < 7 ? dr : dr - R.int(Math.floor(dr / 20) + 1),
      declaredOrgans: dorg, activeOrgans: R.int(10) < 8 ? dorg : dorg - R.int(Math.min(dorg, 2) + 1),
      unanchoredPredictions: R.int(100) < 85 ? 0 : R.range(1, 4), pendingWakes: R.pick([0, 0, 0, 0, 1, 1, 2, 3]),
      lastRollbackAgeEpochs: R.int(100) < 5 ? R.int(3) : R.range(3, 2000), handOffEpochMismatch: R.int(100) < 3,
      staleHeartbeatRatio: hbRoll < 6 ? 0 : hbRoll < 9 ? ratio : Math.max(ratio, R.unit()),
      observedSurpriseScores: Array.from({ length: len }, score) }
  }
  function wide() {
    const [rd, dd] = pair(), [rr, dr] = pair(), [ro, dorg] = pair()
    const len = R.int(9)
    return { ...META, reachableDagNodes: rd, declaredDagNodes: dd, verifiedReceipts: rr, totalReceipts: dr,
      activeOrgans: ro, declaredOrgans: dorg, unanchoredPredictions: R.int(2) ? 0 : bigCount(),
      pendingWakes: R.int(2) ? R.int(4) : bigCount(), lastRollbackAgeEpochs: R.int(2) ? R.int(6) : bigCount(),
      handOffEpochMismatch: R.int(2) === 1, staleHeartbeatRatio: R.int(2) ? anyDouble() : R.unit() * 1.4,
      observedSurpriseScores: Array.from({ length: len }, () => (R.int(2) ? anyDouble() : R.unit() * 60)) }
  }
  const nearHeartbeat = () => {
    const sign = R.pick([-1, 0, 1])
    return R.int(4) === 0 ? 0.7 + sign * UNIT * (1 + (R.unit() - 0.5) * 0.2) : step(0.7 + sign * UNIT, R.range(-40, 40))
  }
  function nearScores() {
    const t = R.pick([T_OBS, T_ESC]), sign = R.pick([-1, 0, 1])
    const target = R.int(3) === 0 ? t + (R.unit() * 2 - 1) * 1.1 * BAND : step(t + sign * BAND, R.range(-40, 40))
    const n = R.range(1, 5)
    let recent
    if (n === 1) recent = [target]
    else if (R.int(3) === 0) recent = Array(n).fill(target)
    else {
      const others = Array.from({ length: n - 1 }, () => t * (0.5 + R.unit()))
      const last = n * target - others.reduce((a, v) => a + v, 0)
      recent = last >= 0 ? [...others, last] : Array(n).fill(target)
      if (R.int(2)) recent = [n * target, ...Array(n - 1).fill(0)]
    }
    const older = R.int(4) === 0 ? Array.from({ length: R.range(1, 12) }, () => R.unit() * 50) : []
    return [...older, ...recent]
  }
  function nearCoherence() {
    const dd = R.int(10) < 6 ? R.range(2 ** 41, MAXS) : R.range(20, 2 ** 41)
    const centre = (19n * BigInt(dd)) / 20n, half = BigInt(dd) >> 40n
    let rd = centre + BigInt(R.pick([-1, 0, 1])) * half + BigInt(R.range(-3, 3))
    if (rd < 0n) rd = 0n
    if (rd > BigInt(dd)) rd = BigInt(dd)
    const out = { reachableDagNodes: Number(rd), declaredDagNodes: dd }
    const kind = R.int(3)
    if (kind === 0) { const d = bigCount() || 1; out.verifiedReceipts = d; out.totalReceipts = d; const e = bigCount() || 1; out.activeOrgans = e; out.declaredOrgans = e }
    else if (kind === 1) {
      const a = R.range(1, 2 ** 40) * 20; out.reachableDagNodes = (a / 20) * 19; out.declaredDagNodes = a
      const d = R.range(2 ** 38, MAXS); out.totalReceipts = d; out.verifiedReceipts = d - R.int(Math.floor(d / 2 ** 39) + 3)
      const e = Math.max(1, bigCount()); out.activeOrgans = e; out.declaredOrgans = e
    } else { out.verifiedReceipts = 10; out.totalReceipts = 10; out.activeOrgans = 10; out.declaredOrgans = 10 }
    return out
  }
  function near() {
    const which = R.int(7)
    const base = s({})
    if (which === 0 || which >= 3) base.staleHeartbeatRatio = which >= 5 && R.int(2) ? 0 : nearHeartbeat()
    if (which === 1 || which >= 3) base.observedSurpriseScores = nearScores()
    if (which === 2 || which >= 4) Object.assign(base, nearCoherence())
    if (which >= 3 && R.int(2)) { Object.assign(base, bitsOf()); if (R.int(2)) base.unanchoredPredictions = 0 }
    return base
  }
  function invalid() {
    const c = R.int(2) ? ordinary() : wide()
    const bad = () => R.pick([NaN, Infinity, -Infinity, -0, -R.unit() * 10, -MINV, -MAXV])
    switch (R.int(10)) {
      case 0: c.declaredDagNodes = 0; c.reachableDagNodes = 0; break
      case 1: c.totalReceipts = 0; c.verifiedReceipts = 0; break
      case 2: c.declaredOrgans = 0; c.activeOrgans = 0; break
      case 3: c.reachableDagNodes = Math.min(MAXS, c.declaredDagNodes + R.range(1, 3)); if (c.reachableDagNodes === c.declaredDagNodes) c.declaredDagNodes -= 1; break
      case 4: c.verifiedReceipts = Math.min(MAXS, c.totalReceipts + 1); if (c.verifiedReceipts === c.totalReceipts) c.totalReceipts -= 1; break
      case 5: c.activeOrgans = Math.min(MAXS, c.declaredOrgans + 1); if (c.activeOrgans === c.declaredOrgans) c.declaredOrgans -= 1; break
      case 6: c.staleHeartbeatRatio = bad(); break
      case 7: case 8: {
        const sc = c.observedSurpriseScores.length ? c.observedSurpriseScores.slice() : [1]
        sc[sc.length - 1 - R.int(Math.min(5, sc.length))] = bad(); c.observedSurpriseScores = sc; break
      }
      default: {
        const sc = Array.from({ length: R.range(6, 30) }, () => R.unit() * 5)
        sc[R.int(sc.length - 5)] = bad(); c.observedSurpriseScores = sc
      }
    }
    return c
  }
  const kinds = { ordinary, wide, near, invalid }
  for (let index = 0; index < count; index += 1) {
    const r = R.int(100)
    const kind = r < 35 ? 'ordinary' : r < 65 ? 'wide' : r < 95 ? 'near' : 'invalid'
    yield { group: `random ${kind}`, input: kinds[kind]() }
  }
}
