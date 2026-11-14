// packages/client/ui-layout/src/client/spatial/aura/tables.ts
var POINTS = {
  0: [-0.934172, 0, -0.356822],
  1: [-0.934172, 0, 0.356822],
  2: [-0.755761, -0.288675, -0.110264],
  3: [-0.755761, -0.288675, 0.110264],
  4: [-0.755761, 0.288675, -0.110264],
  5: [-0.755761, 0.288675, 0.110264],
  6: [-0.645497, -0.467086, -0.178411],
  7: [-0.645497, -0.467086, 0.178411],
  8: [-0.645497, 0.467086, -0.178411],
  9: [-0.645497, 0.467086, 0.178411],
  10: [-0.57735, -0.57735, -0.57735],
  11: [-0.57735, -0.57735, 0],
  12: [-0.57735, -0.57735, 0.57735],
  13: [-0.57735, 0, -0.57735],
  14: [-0.57735, 0, 0],
  15: [-0.57735, 0, 0.57735],
  16: [-0.57735, 0.57735, -0.57735],
  17: [-0.57735, 0.57735, 0],
  18: [-0.57735, 0.57735, 0.57735],
  19: [-0.467086, -0.178411, -0.645497],
  20: [-0.467086, -0.178411, -0.288675],
  21: [-0.467086, -0.178411, 0.288675],
  22: [-0.467086, -0.178411, 0.645497],
  23: [-0.467086, 0.178411, -0.645497],
  24: [-0.467086, 0.178411, -0.288675],
  25: [-0.467086, 0.178411, 0.288675],
  26: [-0.467086, 0.178411, 0.645497],
  27: [-0.356822, -0.934172, 0],
  28: [-0.356822, 0.934172, 0],
  29: [-0.288675, -0.467086, -0.178411],
  30: [-0.288675, -0.467086, 0.178411],
  31: [-0.288675, -0.110264, -0.755761],
  32: [-0.288675, -0.110264, 0.755761],
  33: [-0.288675, 0.110264, -0.755761],
  34: [-0.288675, 0.110264, 0.755761],
  35: [-0.288675, 0.467086, -0.178411],
  36: [-0.288675, 0.467086, 0.178411],
  37: [-0.178411, -0.645497, -0.467086],
  38: [-0.178411, -0.645497, 0.467086],
  39: [-0.178411, -0.288675, -0.467086],
  40: [-0.178411, -0.288675, 0.467086],
  41: [-0.178411, 0.288675, -0.467086],
  42: [-0.178411, 0.288675, 0.467086],
  43: [-0.178411, 0.645497, -0.467086],
  44: [-0.178411, 0.645497, 0.467086],
  45: [-0.110264, -0.755761, -0.288675],
  46: [-0.110264, -0.755761, 0.288675],
  47: [-0.110264, 0.755761, -0.288675],
  48: [-0.110264, 0.755761, 0.288675],
  49: [0, -0.57735, -0.57735],
  50: [0, -0.57735, 0],
  51: [0, -0.57735, 0.57735],
  52: [0, -0.356822, -0.934172],
  53: [0, -0.356822, 0.934172],
  54: [0, 0, -0.57735],
  55: [0, 0, 0],
  56: [0, 0, 0.57735],
  57: [0, 0.356822, -0.934172],
  58: [0, 0.356822, 0.934172],
  59: [0, 0.57735, -0.57735],
  60: [0, 0.57735, 0],
  61: [0, 0.57735, 0.57735],
  62: [0.110264, -0.755761, -0.288675],
  63: [0.110264, -0.755761, 0.288675],
  64: [0.110264, 0.755761, -0.288675],
  65: [0.110264, 0.755761, 0.288675],
  66: [0.178411, -0.645497, -0.467086],
  67: [0.178411, -0.645497, 0.467086],
  68: [0.178411, -0.288675, -0.467086],
  69: [0.178411, -0.288675, 0.467086],
  70: [0.178411, 0.288675, -0.467086],
  71: [0.178411, 0.288675, 0.467086],
  72: [0.178411, 0.645497, -0.467086],
  73: [0.178411, 0.645497, 0.467086],
  74: [0.288675, -0.467086, -0.178411],
  75: [0.288675, -0.467086, 0.178411],
  76: [0.288675, -0.110264, -0.755761],
  77: [0.288675, -0.110264, 0.755761],
  78: [0.288675, 0.110264, -0.755761],
  79: [0.288675, 0.110264, 0.755761],
  80: [0.288675, 0.467086, -0.178411],
  81: [0.288675, 0.467086, 0.178411],
  82: [0.356822, -0.934172, 0],
  83: [0.356822, 0.934172, 0],
  84: [0.467086, -0.178411, -0.645497],
  85: [0.467086, -0.178411, -0.288675],
  86: [0.467086, -0.178411, 0.288675],
  87: [0.467086, -0.178411, 0.645497],
  88: [0.467086, 0.178411, -0.645497],
  89: [0.467086, 0.178411, -0.288675],
  90: [0.467086, 0.178411, 0.288675],
  91: [0.467086, 0.178411, 0.645497],
  92: [0.57735, -0.57735, -0.57735],
  93: [0.57735, -0.57735, 0],
  94: [0.57735, -0.57735, 0.57735],
  95: [0.57735, 0, -0.57735],
  96: [0.57735, 0, 0],
  97: [0.57735, 0, 0.57735],
  98: [0.57735, 0.57735, -0.57735],
  99: [0.57735, 0.57735, 0],
  100: [0.57735, 0.57735, 0.57735],
  101: [0.645497, -0.467086, -0.178411],
  102: [0.645497, -0.467086, 0.178411],
  103: [0.645497, 0.467086, -0.178411],
  104: [0.645497, 0.467086, 0.178411],
  105: [0.755761, -0.288675, -0.110264],
  106: [0.755761, -0.288675, 0.110264],
  107: [0.755761, 0.288675, -0.110264],
  108: [0.755761, 0.288675, 0.110264],
  109: [0.934172, 0, -0.356822],
  110: [0.934172, 0, 0.356822]
};
var CUBES = [
  {
    edges: [[10, 12], [10, 16], [10, 92], [12, 18], [12, 94], [16, 18], [16, 98], [18, 100], [92, 94], [92, 98], [94, 100], [98, 100]],
    edgeMidpoints: [11, 13, 49, 15, 51, 17, 59, 61, 93, 95, 97, 99],
    faceCentres: [14, 50, 54, 56, 60, 96],
    private: [11, 13, 14, 15, 17, 49, 50, 51, 54, 56, 59, 60, 61, 93, 95, 96, 97, 99],
    corners: [10, 12, 16, 18, 92, 94, 98, 100]
  },
  {
    edges: [[10, 57], [10, 1], [10, 82], [100, 53], [100, 109], [100, 28], [53, 1], [53, 82], [57, 109], [57, 28], [109, 82], [1, 28]],
    edgeMidpoints: [31, 2, 45, 79, 108, 65, 22, 67, 88, 43, 101, 9],
    faceCentres: [24, 30, 42, 68, 80, 86],
    private: [2, 9, 22, 24, 30, 31, 42, 43, 45, 65, 67, 68, 79, 80, 86, 88, 101, 108],
    corners: [1, 10, 28, 53, 57, 82, 100, 109]
  },
  {
    edges: [[12, 58], [12, 0], [12, 82], [98, 52], [98, 110], [98, 28], [52, 0], [52, 82], [58, 110], [58, 28], [0, 28], [110, 82]],
    edgeMidpoints: [32, 3, 46, 78, 107, 64, 19, 66, 91, 44, 8, 102],
    faceCentres: [25, 29, 41, 69, 81, 85],
    private: [3, 8, 19, 25, 29, 32, 41, 44, 46, 64, 66, 69, 78, 81, 85, 91, 102, 107],
    corners: [0, 12, 28, 52, 58, 82, 98, 110]
  },
  {
    edges: [[16, 52], [16, 1], [16, 83], [94, 58], [94, 109], [94, 27], [52, 109], [52, 27], [58, 1], [58, 83], [109, 83], [1, 27]],
    edgeMidpoints: [33, 4, 47, 77, 106, 63, 84, 37, 26, 73, 103, 7],
    faceCentres: [20, 36, 40, 70, 74, 90],
    private: [4, 7, 20, 26, 33, 36, 37, 40, 47, 63, 70, 73, 74, 77, 84, 90, 103, 106],
    corners: [1, 16, 27, 52, 58, 83, 94, 109]
  },
  {
    edges: [[18, 53], [18, 0], [18, 83], [92, 57], [92, 110], [92, 27], [53, 110], [53, 27], [57, 0], [57, 83], [0, 27], [110, 83]],
    edgeMidpoints: [34, 5, 48, 76, 105, 62, 87, 38, 23, 72, 6, 104],
    faceCentres: [21, 35, 39, 71, 75, 89],
    private: [5, 6, 21, 23, 34, 35, 38, 39, 48, 62, 71, 72, 75, 76, 87, 89, 104, 105],
    corners: [0, 18, 27, 53, 57, 83, 92, 110]
  }
];
var CORNER_CELLS = [10, 100, 12, 98, 16, 94, 18, 92, 28, 82, 1, 109, 53, 57, 52, 58, 0, 110, 27, 83];

// apps/web/scripts/stock-apps/pentora-live/lattice.mjs
var HEART = 55;
var SHELL = Object.freeze({ CORNER: 0, EDGE: 1, FACE: 2, HEART: 3 });
var distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
function pointOf(g) {
  const point = POINTS[g];
  if (point === void 0) throw new Error(`pentora lattice: point ${String(g)} is missing from POINTS`);
  return point;
}
function cornerCycle(cube) {
  const next = new Map(cube.corners.map((g) => [g, []]));
  for (const [p, q] of cube.edges) {
    next.get(p).push(q);
    next.get(q).push(p);
  }
  const start = cube.corners[0];
  const path = [start];
  const seen = new Set(path);
  const walk = () => {
    const here = path[path.length - 1];
    if (path.length === cube.corners.length) return next.get(here).includes(start);
    for (const g of [...next.get(here)].sort((x, y) => x - y)) {
      if (seen.has(g)) continue;
      path.push(g);
      seen.add(g);
      if (walk()) return true;
      path.pop();
      seen.delete(g);
    }
    return false;
  };
  if (!walk()) throw new Error("pentora lattice: a cube has no Hamiltonian cycle (not a cube)");
  return path;
}
function buildLattice(cubes = CUBES, cornerCells = CORNER_CELLS) {
  const heart = pointOf(HEART);
  if (heart.some((v) => Math.abs(v) > 1e-9)) throw new Error("pentora lattice: point 55 is not the centre");
  const byGlobal = /* @__PURE__ */ new Map();
  const claim = (g, shell, cube) => {
    const found = byGlobal.get(g);
    if (found === void 0) {
      byGlobal.set(g, { g, shell, cubes: [cube] });
      return;
    }
    if (found.shell !== shell) throw new Error(`pentora lattice: cell ${String(g)} sits on two shells`);
    if (!found.cubes.includes(cube)) found.cubes.push(cube);
  };
  cubes.forEach((cube, c) => {
    for (const g of cube.corners) claim(g, SHELL.CORNER, c);
    for (const g of cube.edgeMidpoints) claim(g, SHELL.EDGE, c);
    for (const g of cube.faceCentres) claim(g, SHELL.FACE, c);
  });
  if (byGlobal.has(HEART)) throw new Error("pentora lattice: the heart must not be a cell");
  const cells = [...byGlobal.values()].sort((x, y) => x.g - y.g).map((cell, index) => Object.freeze({
    index,
    g: cell.g,
    shell: cell.shell,
    cubes: Object.freeze([...cell.cubes].sort((x, y) => x - y)),
    point: pointOf(cell.g)
  }));
  const cellOf = new Map(cells.map((cell) => [cell.g, cell.index]));
  const lines = [];
  const add = (family, cube, a, b) => {
    lines.push(Object.freeze({ index: lines.length, family, cube, a, b }));
  };
  cubes.forEach((cube, c) => {
    cube.edges.forEach(([p, q], e) => {
      const m = cube.edgeMidpoints[e];
      if (m === void 0) throw new Error("pentora lattice: an edge has no midpoint");
      add("edge", c, p, m);
      add("edge", c, q, m);
    });
  });
  cubes.forEach((cube, c) => {
    for (const f of cube.faceCentres) {
      const at = pointOf(f);
      const near = cube.edgeMidpoints.map((m) => ({ m, d: distance(at, pointOf(m)) })).sort((x, y) => x.d - y.d);
      const nearest = near[0]?.d ?? 0;
      const own = near.filter((each) => each.d <= nearest * 1.02);
      if (own.length !== 4) throw new Error(`pentora lattice: face centre ${String(f)} is beside ${String(own.length)} midpoints, not 4`);
      for (const { m } of own.sort((x, y) => x.m - y.m)) add("cross", c, m, f);
    }
  });
  cubes.forEach((cube, c) => {
    for (const f of cube.faceCentres) add("spoke", c, f, HEART);
  });
  const inward = new Map([...cellOf.keys()].map((g) => [g, []]));
  const outward = new Map([...cellOf.keys(), HEART].map((g) => [g, []]));
  for (const line of lines) {
    inward.get(line.a)?.push(line.index);
    outward.get(line.b)?.push(line.index);
  }
  const cornerEdges = new Map(cornerCells.map((g) => [g, lines.filter((line) => line.family === "edge" && line.a === g).map((line) => line.index)]));
  const orbits = cubes.map((cube, c) => {
    const ring = cornerCycle(cube);
    const route = [];
    ring.forEach((p, k) => {
      const q = ring[(k + 1) % ring.length];
      const e = cube.edges.findIndex(([x, y]) => x === p && y === q || x === q && y === p);
      const m = cube.edgeMidpoints[e];
      const out = lines.find((line) => line.family === "edge" && line.cube === c && line.a === p && line.b === m);
      const back = lines.find((line) => line.family === "edge" && line.cube === c && line.a === q && line.b === m);
      route.push(Object.freeze({ line: out.index, dir: 1 }), Object.freeze({ line: back.index, dir: -1 }));
    });
    return Object.freeze(route);
  });
  const freezeMap = (map) => new Map([...map].map(([k, v]) => [k, Object.freeze(v)]));
  return Object.freeze({
    heart: HEART,
    cells: Object.freeze(cells),
    cellOf,
    lines: Object.freeze(lines),
    inward: freezeMap(inward),
    outward: freezeMap(outward),
    cornerEdges: freezeMap(cornerEdges),
    orbits: Object.freeze(orbits),
    cubeCount: cubes.length
  });
}
var LATTICE = buildLattice();
function pointAt(g) {
  return pointOf(g);
}

// apps/web/scripts/stock-apps/pentora-live/flow.mjs
var FLOW = Object.freeze({
  /** ms a shell lags the one before it */
  T_MS: 110,
  /** how much of each signal's past is kept */
  HISTORY_MS: 1500,
  /** HOLD's amplitude with no thinking at all: silence is a calm blue lattice */
  HOLD_FLOOR: 0.1,
  /** how far a challenger must lead */
  MARGIN: 0.06,
  /** for how many consecutive steps */
  CONFIRM_FRAMES: 2,
  /** how much of a voice survives each shell it crosses */
  REACH: 0.8,
  /** ms each cube lags the one before it (cube k hears everything k*PHASE_MS later): the five cubes talk in turn */
  PHASE_MS: 35
});
var VALUE = Object.freeze({ IN: -1, HOLD: 0, OUT: 1 });
var clamp01 = (v) => typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
function createHistory(keepMs = FLOW.HISTORY_MS) {
  const times = [];
  const values = [];
  return {
    push(t, v) {
      if (times.length > 0 && t < times[times.length - 1]) {
        times.length = 0;
        values.length = 0;
      }
      times.push(t);
      values.push(clamp01(v));
      while (times.length > 2 && times[1] < t - keepMs) {
        times.shift();
        values.shift();
      }
    },
    at(t) {
      const n = times.length;
      if (n === 0 || t < times[0]) return 0;
      if (t >= times[n - 1]) return values[n - 1];
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = lo + hi >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid;
      }
      const span = times[hi] - times[lo];
      return span <= 0 ? values[hi] : values[lo] + (values[hi] - values[lo]) * ((t - times[lo]) / span);
    },
    get size() {
      return times.length;
    }
  };
}
function amplitudes(shell, t, history, flow = FLOW, cube = 0) {
  const lag = cube * flow.PHASE_MS;
  return {
    in: history.mic.at(t - shell * flow.T_MS - lag) * flow.REACH ** shell,
    hold: flow.HOLD_FLOOR + history.think.at(t),
    out: history.say.at(t - (3 - shell) * flow.T_MS - lag) * flow.REACH ** (2 - shell)
  };
}
function phaseCubeOf(cubes) {
  return cubes.length === 0 ? 0 : Math.min(...cubes);
}
function candidateOf(amp) {
  let value = VALUE.HOLD, best = amp.hold;
  if (amp.out > best) {
    value = VALUE.OUT;
    best = amp.out;
  }
  if (amp.in > best) {
    value = VALUE.IN;
    best = amp.in;
  }
  return value;
}
var ampOf = (amp, value) => value === VALUE.IN ? amp.in : value === VALUE.OUT ? amp.out : amp.hold;
function createFlow(shells, flow = FLOW, phases = void 0) {
  const count = shells.length;
  const phaseOf = Int16Array.from({ length: count }, (_, i) => phases?.[i] ?? 0);
  const cubeCount = count === 0 ? 1 : Math.max(...phaseOf) + 1;
  if (phaseOf.some((k) => k < 0)) throw new Error("pentora flow: a phase cube is negative");
  const values = new Int8Array(count);
  const challenger = new Int8Array(count).fill(2);
  const confirmations = new Uint8Array(count);
  const history = { mic: createHistory(flow.HISTORY_MS), think: createHistory(flow.HISTORY_MS), say: createHistory(flow.HISTORY_MS) };
  const changed = [];
  const perGroup = Array.from({ length: 3 * cubeCount }, () => ({ in: 0, hold: 0, out: 0 }));
  return {
    values,
    history,
    step(t, levels) {
      history.mic.push(t, levels?.mic);
      history.think.push(t, levels?.think);
      history.say.push(t, levels?.say);
      for (let shell = 0; shell < 3; shell += 1) {
        for (let cube = 0; cube < cubeCount; cube += 1) Object.assign(perGroup[shell * cubeCount + cube], amplitudes(shell, t, history, flow, cube));
      }
      changed.length = 0;
      for (let i = 0; i < count; i += 1) {
        const amp = perGroup[shells[i] * cubeCount + phaseOf[i]];
        const now = values[i];
        const next = candidateOf(amp);
        if (next !== now && ampOf(amp, next) > ampOf(amp, now) + flow.MARGIN) {
          if (challenger[i] === next) confirmations[i] += 1;
          else {
            challenger[i] = next;
            confirmations[i] = 1;
          }
          if (confirmations[i] >= flow.CONFIRM_FRAMES) {
            values[i] = next;
            challenger[i] = 2;
            confirmations[i] = 0;
            changed.push(i);
          }
        } else {
          challenger[i] = 2;
          confirmations[i] = 0;
        }
      }
      return { values, changed };
    }
  };
}

// apps/web/scripts/stock-apps/pentora-live/packets.mjs
var PACKETS = Object.freeze({
  CAP: 220,
  /** the most packets alive on one line at once */
  PER_LINE: 2,
  /** ms for a flow packet to run one line */
  FLOW_MS: 240,
  /** ms for a blue packet to run one half-edge: slow */
  ORBIT_MS: 420,
  /** `think` above which the blue orbit starts, and below which a blue packet stops at its next corner */
  ORBIT_START: 0.4,
  ORBIT_KEEP: 0.25,
  /** ms between blue packets on one cube at full `think` (slower as `think` falls toward ORBIT_START) */
  ORBIT_EVERY_MS: 520,
  /** half-edges a blue packet runs before it fades: one lap of its cube */
  ORBIT_STEPS: 16
});
function createPackets(lattice, { cap = PACKETS.CAP, still = false, perLine = PACKETS.PER_LINE } = {}) {
  const list = [];
  const pending = [];
  const onLine = new Uint8Array(lattice.lines.length);
  const orbitClock = new Float64Array(lattice.cubeCount);
  const orbitNext = new Uint8Array(lattice.cubeCount);
  let isStill = still;
  const empty = () => {
    list.length = 0;
    onLine.fill(0);
  };
  const add = (packet) => {
    if (isStill || onLine[packet.line] >= perLine) return false;
    if (list.length >= cap) {
      const oldest = list.shift();
      onLine[oldest.line] -= 1;
    }
    list.push(packet);
    onLine[packet.line] += 1;
    return true;
  };
  function emitChange(g, value) {
    if (isStill) return 0;
    const lines = value < 0 ? lattice.inward.get(g) : value > 0 ? lattice.outward.get(g) : void 0;
    if (lines === void 0) return 0;
    let sent = 0;
    for (const line of lines) {
      if (add({ kind: "flow", line, dir: value < 0 ? 1 : -1, t: 0, value, hop: 0, cube: lattice.lines[line].cube, steps: 0 })) sent += 1;
    }
    return sent;
  }
  const endOf = (p) => p.dir > 0 ? lattice.lines[p.line].b : lattice.lines[p.line].a;
  function arrive(p, overflow, think) {
    if (p.kind === "flow") {
      if (p.value > 0 && p.hop === 0) {
        const corner = endOf(p);
        for (const line of lattice.cornerEdges.get(corner) ?? []) {
          const cube = lattice.lines[line].cube;
          if (cube === p.cube) continue;
          pending.push({ kind: "flow", line, dir: 1, t: overflow, value: p.value, hop: 1, cube, steps: 0 });
        }
      }
      return false;
    }
    if (think < PACKETS.ORBIT_KEEP || p.steps + 1 >= PACKETS.ORBIT_STEPS) return false;
    const route = lattice.orbits[p.cube];
    const next = (p.route + 1) % route.length;
    if (onLine[route[next].line] >= perLine) return false;
    onLine[p.line] -= 1;
    onLine[route[next].line] += 1;
    p.steps += 1;
    p.route = next;
    p.line = route[p.route].line;
    p.dir = route[p.route].dir;
    p.t = overflow;
    return true;
  }
  function step(dtMs, think) {
    if (isStill) {
      empty();
      return;
    }
    const level = typeof think === "number" && Number.isFinite(think) ? think : 0;
    if (level > PACKETS.ORBIT_START) {
      const pace = (level - PACKETS.ORBIT_START) / (1 - PACKETS.ORBIT_START);
      for (let c = 0; c < lattice.cubeCount; c += 1) {
        orbitClock[c] += dtMs * pace;
        if (orbitClock[c] < PACKETS.ORBIT_EVERY_MS) continue;
        orbitClock[c] = 0;
        const route = lattice.orbits[c];
        const at = orbitNext[c] % route.length;
        orbitNext[c] = (at + 5) % route.length;
        pending.push({ kind: "orbit", line: route[at].line, dir: route[at].dir, t: 0, value: 0, hop: 0, cube: c, steps: 0, route: at });
      }
    }
    let keep = 0;
    for (const p of list) {
      p.t += dtMs / (p.kind === "orbit" ? PACKETS.ORBIT_MS : PACKETS.FLOW_MS);
      let alive = true;
      while (alive && p.t >= 1) alive = arrive(p, p.t - 1, level);
      if (alive) list[keep++] = p;
      else onLine[p.line] -= 1;
    }
    list.length = keep;
    for (const p of pending) add(p);
    pending.length = 0;
  }
  return {
    list,
    emitChange,
    step,
    clear() {
      empty();
      pending.length = 0;
    },
    setStill(value) {
      isStill = Boolean(value);
      if (isStill) empty();
    },
    /** packets alive on line `i` right now */
    onLine(i) {
      return onLine[i] ?? 0;
    },
    get size() {
      return list.length;
    }
  };
}

// apps/web/scripts/stock-apps/pentora-live/renderer.mjs
var TOKENS = Object.freeze([
  Object.freeze(["--hue-l", Object.freeze([129, 212, 180])]),
  Object.freeze(["--hue-c", Object.freeze([150, 180, 255])]),
  Object.freeze(["--hue-r", Object.freeze([196, 170, 255])])
]);
var PROJECTION = Object.freeze({
  VIEW: 184,
  SPAN: 76,
  TILT: 0.5,
  PERSPECTIVE: 4.5,
  START_ANGLE: 0.7,
  FIGURE_SHARE: 0.72,
  FIGURE_MAX_PX: 440,
  DPR_MAX: 2
});
var CORE = Object.freeze([1.9, 1.55, 1.3]);
var LIT_CORE = 1.2;
var GLOW = 4.2;
var LINE_ALPHA = { edge: 0.17, cross: 0.11, spoke: 0.085 };
var LEVELS = [0.4, 0.6, 0.8, 1];
var FLARE_MS = 420;
var TENSION = 2;
var CANVAS = Object.freeze({ MARGIN: 1.25, SIDE_MAX_PX: 1024 });
var LIGHT = Object.freeze({ BOUND: 1, BUDGET: 0.92, BIN: 6 });
var LIT_ALPHA = 0.28;
var PACKET_ALPHA = Object.freeze({ flow: 0.6, orbit: 0.4 });
var PACKET_R = 3.2;
var PACKETS_MAX = PACKETS.CAP;
var SPRITE_STOPS = Object.freeze({
  glow: Object.freeze([[0, 0.55], [0.25, 0.22], [0.6, 0.06], [1, 0]]),
  packet: Object.freeze([[0, 0.55], [0.25, 0.22], [0.6, 0.06], [1, 0]]),
  core: Object.freeze([[0, 1], [0.42, 0.95], [0.68, 0.22], [1, 0]]),
  heart: Object.freeze([[0, 0.9], [0.18, 0.45], [0.5, 0.12], [1, 0]])
});
function profileAt(stops, u) {
  if (!(u < 1)) return 0;
  for (let k = 1; k < stops.length; k += 1) {
    const [b, vb] = stops[k], [a, va] = stops[k - 1];
    if (u <= b) return va + (vb - va) * ((u - a) / (b - a));
  }
  return 0;
}
var RADIUS = Math.max(...LATTICE.cells.filter((cell) => cell.shell === SHELL.CORNER).map((cell) => Math.hypot(...cell.point)));
function project(point, angle, tilt, roll, breath) {
  const [x, y, z] = point;
  const c = Math.cos(angle), s = Math.sin(angle);
  const turned = -x * s + z * c;
  const tilted = y * Math.cos(tilt) - turned * Math.sin(tilt);
  const depth = y * Math.sin(tilt) + turned * Math.cos(tilt);
  const near = 1 / (1 - depth / (RADIUS * PROJECTION.PERSPECTIVE));
  const scale = PROJECTION.SPAN / RADIUS;
  const px = (x * c + z * s) * scale * near, py = -tilted * scale * near;
  return [(px * Math.cos(roll) - py * Math.sin(roll)) * breath, (px * Math.sin(roll) + py * Math.cos(roll)) * breath, depth, near];
}
function figureSize(width) {
  return Math.min(width * PROJECTION.FIGURE_SHARE, PROJECTION.FIGURE_MAX_PX);
}
function readTokens(win, doc) {
  let style = null;
  try {
    style = win?.getComputedStyle?.(doc?.documentElement) ?? null;
  } catch {
    style = null;
  }
  return TOKENS.map(([name, fallback]) => {
    let raw = "";
    try {
      raw = String(style?.getPropertyValue?.(name) ?? "");
    } catch {
      raw = "";
    }
    const parts = raw.trim().split(",").map(parseFloat);
    return parts.length === 3 && !parts.some(Number.isNaN) ? parts : [...fallback];
  });
}
var rgba = (rgb, a) => `rgba(${String(rgb[0])}, ${String(rgb[1])}, ${String(rgb[2])}, ${String(a)})`;
var level01 = (v) => typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
function createPentoraLive(options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window ?? globalThis;
  const requestFrame = options.requestAnimationFrame ?? ((cb) => typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame(cb) : 0);
  const cancelFrame = options.cancelAnimationFrame ?? ((id) => {
    if (typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(id);
  });
  const clock = options.now ?? (() => globalThis.performance.now());
  const contextOf = options.getContext ?? ((canvas2) => {
    try {
      return canvas2.getContext("2d");
    } catch {
      return null;
    }
  });
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const ctx = contextOf(canvas);
  const colours = readTokens(win, doc);
  const solid = colours.map((rgb) => `rgb(${String(rgb[0])}, ${String(rgb[1])}, ${String(rgb[2])})`);
  const sprite = (size2, c, stops) => {
    const image = doc.createElement("canvas");
    image.width = size2;
    image.height = size2;
    const paint = contextOf(image);
    if (paint) {
      const g = paint.createRadialGradient(size2 / 2, size2 / 2, 0, size2 / 2, size2 / 2, size2 / 2);
      for (const [at, alpha] of stops) g.addColorStop(at, rgba(c, alpha));
      paint.fillStyle = g;
      paint.fillRect(0, 0, size2, size2);
    }
    return image;
  };
  const sprites = Object.freeze({
    glow: Object.freeze(colours.map((c) => sprite(64, c, SPRITE_STOPS.glow))),
    packet: Object.freeze(colours.map((c) => sprite(32, c, SPRITE_STOPS.packet))),
    core: Object.freeze(colours.map((c) => sprite(32, c, SPRITE_STOPS.core))),
    heart: Object.freeze([colours[1], colours[2]].map((c) => sprite(96, c, SPRITE_STOPS.heart)))
  });
  const cells = LATTICE.cells;
  const lines = LATTICE.lines;
  const changedAt = new Float64Array(cells.length).fill(-Infinity);
  let reduced = null;
  try {
    reduced = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  } catch {
    reduced = null;
  }
  let still = reduced?.matches === true;
  const shellOf = cells.map((cell) => cell.shell);
  const flowMoving = createFlow(shellOf, void 0, cells.map((cell) => phaseCubeOf(cell.cubes)));
  const flowStill = createFlow(shellOf);
  const flow = {
    get values() {
      return (still ? flowStill : flowMoving).values;
    },
    step(now, levels) {
      const moving = flowMoving.step(now, levels);
      const quiet = flowStill.step(now, levels);
      return still ? quiet : moving;
    }
  };
  const packets = createPackets(LATTICE, { still });
  const positions = [...cells.map((cell) => cell.g), HEART];
  const size = Math.max(...positions) + 1;
  const X = new Float32Array(size), Y = new Float32Array(size), D = new Float32Array(size), N = new Float32Array(size);
  const POINTS_OF = positions.map((g) => [g, pointAt(g)]);
  const cellIndex = (g) => g === HEART ? -1 : LATTICE.cellOf.get(g) ?? -1;
  const lineCells = lines.map((line) => [cellIndex(line.a), cellIndex(line.b)]);
  const FAMILIES = ["edge", "cross", "spoke"];
  const buckets = [0, 1, 2].map(() => FAMILIES.map(() => LEVELS.map(() => [])));
  const mixed = [];
  const litLines = [[], [], []];
  const litColour = new Int8Array(lines.length);
  const litCell = new Uint8Array(cells.length);
  const signals = { mic: 0, think: 0, say: 0 };
  const stats = { frames: 0, cores: 0, heart: 0, strokes: 0, packets: 0, packetsDrawn: 0, lit: 0, lastMs: 0, meanMs: 0 };
  let W = 0, H = 0, dpr = 1, side = 0, left = 0, top = 0;
  let active = true;
  let hidden = doc.hidden === true;
  let destroyed = false;
  let frame = 0;
  let last = 0;
  let angle = PROJECTION.START_ANGLE;
  let work = 0;
  let born = -1;
  let drawnStill = false;
  let cols = 0, rows = 0;
  let tally = new Float32Array(0), stamp = new Int32Array(0), wanted = new Uint8Array(0), summed = new Int32Array(0);
  let pathId = 0;
  const heads = { x: new Float32Array(PACKETS_MAX), y: new Float32Array(PACKETS_MAX), r: new Float32Array(PACKETS_MAX) };
  function grid() {
    cols = Math.max(1, Math.ceil(side / LIGHT.BIN) + 1);
    rows = cols;
    if (tally.length !== cols * rows) {
      tally = new Float32Array(cols * rows);
      stamp = new Int32Array(cols * rows);
      wanted = new Uint8Array(cols * rows);
      summed = new Int32Array((cols + 1) * (rows + 1));
    }
  }
  function sumWanted() {
    const w = cols + 1;
    for (let r = 0; r < rows; r += 1) {
      let run = 0;
      for (let c = 0; c < cols; c += 1) {
        run += wanted[r * cols + c];
        summed[(r + 1) * w + c + 1] = summed[r * w + c + 1] + run;
      }
    }
  }
  const anyWanted = (x0, x1, y0, y1) => {
    if (x1 < x0 || y1 < y0) return false;
    const w = cols + 1;
    return summed[(y1 + 1) * w + x1 + 1] - summed[y0 * w + x1 + 1] - summed[(y1 + 1) * w + x0] + summed[y0 * w + x0] > 0;
  };
  const binLo = (lo) => Math.max(0, Math.floor(lo / LIGHT.BIN));
  const binHi = (hi, n) => Math.min(n - 1, Math.floor(hi / LIGHT.BIN));
  const binDistance = (x, y, bx, by) => {
    const dx = Math.max(bx * LIGHT.BIN - x, 0, x - (bx + 1) * LIGHT.BIN);
    const dy = Math.max(by * LIGHT.BIN - y, 0, y - (by + 1) * LIGHT.BIN);
    return Math.hypot(dx, dy);
  };
  function depositSprite(x, y, r, alpha, stops) {
    if (!(alpha > 0) || !(r > 0)) return;
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows);
    if (!anyWanted(x0, x1, y0, y1)) return;
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) {
      const i = by * cols + bx;
      if (wanted[i] === 0) continue;
      const p = profileAt(stops, binDistance(x, y, bx, by) / r);
      if (p > 0) tally[i] += alpha * p;
    }
  }
  function want(x, y, r) {
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows);
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) wanted[by * cols + bx] = 1;
  }
  function headroom(x, y, r, stops) {
    let most = Infinity;
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows);
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) {
      const p = profileAt(stops, binDistance(x, y, bx, by) / r);
      if (p > 0) most = Math.min(most, (LIGHT.BUDGET - tally[by * cols + bx]) / p);
    }
    return most;
  }
  function depositPath(list, alpha, width) {
    if (!(alpha > 0)) return;
    pathId += 1;
    if (pathId > 1e9) {
      pathId = 1;
      stamp.fill(0);
    }
    const h = width / 2 + 1;
    const step = LIGHT.BIN / 2;
    for (const line of list) {
      const ax = X[line.a], ay = Y[line.a], bx = X[line.b], by = Y[line.b];
      if (!anyWanted(binLo(Math.min(ax, bx) - h), binHi(Math.max(ax, bx) + h, cols), binLo(Math.min(ay, by) - h), binHi(Math.max(ay, by) + h, rows))) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k <= n; k += 1) {
        const x = ax + (bx - ax) * (k / n), y = ay + (by - ay) * (k / n);
        const c0 = binLo(x - h), c1 = binHi(x + h, cols), r0 = binLo(y - h), r1 = binHi(y + h, rows);
        for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) {
          const i = r * cols + c;
          if (wanted[i] !== 0 && stamp[i] !== pathId) {
            stamp[i] = pathId;
            tally[i] += alpha;
          }
        }
      }
    }
  }
  const valueAt = (g) => g === HEART ? -2 : flow.values[LATTICE.cellOf.get(g)];
  const colourAt = (g, other) => {
    const v = valueAt(g);
    return v === -2 ? valueAt(other) + 1 : v + 1;
  };
  const boxOf = () => options.box ?? canvas.parentElement ?? null;
  let watched = null;
  function measure() {
    const box = boxOf();
    let rect = null;
    try {
      rect = box?.getBoundingClientRect?.() ?? null;
    } catch {
      rect = null;
    }
    W = Math.max(0, rect?.width ?? 0);
    H = Math.max(0, rect?.height ?? 0);
    dpr = Math.min(Number(win.devicePixelRatio) || 1, PROJECTION.DPR_MAX);
    side = W > 0 && H > 0 ? Math.min(figureSize(W) * CANVAS.MARGIN, CANVAS.SIDE_MAX_PX) : 0;
    left = (W - side) / 2;
    top = (H - side) / 2;
    const backing = Math.max(1, Math.round(side * dpr));
    if (canvas.width !== backing || canvas.height !== backing) {
      canvas.width = backing;
      canvas.height = backing;
    }
    const style = canvas.style;
    if (style) {
      style.width = `${String(side)}px`;
      style.height = `${String(side)}px`;
      style.left = `${String(left)}px`;
      style.top = `${String(top)}px`;
    }
    grid();
    if (box !== null && box !== watched && observer !== null) {
      try {
        if (watched !== null) observer.unobserve?.(watched);
        observer.observe?.(box);
        watched = box;
      } catch {
      }
    }
  }
  function render(now, moving) {
    if (ctx === null || side <= 0) return;
    const started = clock();
    if (born < 0) born = now;
    const t = now - born;
    const ramp = moving ? Math.min(1, t / 3500) : 0;
    const tilt = PROJECTION.TILT + (0.32 + 0.18 * work) * Math.sin(t / 4700) * ramp;
    const roll = 0.24 * Math.sin(t / 7300 + 1) * ramp;
    const breath = 1 + 0.035 * Math.sin(t / 1900) * ramp;
    const turn = moving ? angle : PROJECTION.START_ANGLE;
    const unit = figureSize(W) / PROJECTION.VIEW;
    const cx = side / 2, cy = side / 2;
    for (const [g, point] of POINTS_OF) {
      const [px, py, depth, near] = project(point, turn, tilt, roll, breath);
      X[g] = cx + px * unit;
      Y[g] = cy + py * unit;
      D[g] = (depth / RADIUS + 1) / 2;
      N[g] = near;
    }
    const light = moving && packets.size > 0;
    if (light) {
      tally.fill(0);
      wanted.fill(0);
      packets.list.forEach((p, k) => {
        const line = lines[p.line];
        const head = p.dir > 0 ? p.t : 1 - p.t;
        heads.x[k] = X[line.a] + (X[line.b] - X[line.a]) * head;
        heads.y[k] = Y[line.a] + (Y[line.b] - Y[line.a]) * head;
        heads.r[k] = PACKET_R * unit * (N[line.a] + N[line.b]) / 2;
        want(heads.x[k], heads.y[k], heads.r[k]);
      });
      sumWanted();
    }
    litColour.fill(-1);
    litCell.fill(0);
    for (const list of litLines) list.length = 0;
    for (const p of packets.list) litColour[p.line] = p.value + 1;
    for (let i = 0; i < lines.length; i += 1) {
      if (litColour[i] < 0) continue;
      litLines[litColour[i]].push(lines[i]);
      for (const c of lineCells[i]) if (c >= 0) litCell[c] = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    let strokes = 0;
    for (const cell of cells) {
      const colour = flow.values[cell.index] + 1;
      const g = cell.g;
      const flare = moving ? Math.max(0, 1 - (now - changedAt[cell.index]) / FLARE_MS) : 0;
      const rg = CORE[cell.shell] * unit * N[g] * (GLOW + 3 * flare);
      const alpha = (0.45 + 0.55 * D[g]) * (0.6 + 0.4 * flare);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites.glow[colour], X[g] - rg, Y[g] - rg, rg * 2, rg * 2);
      if (light) depositSprite(X[g], Y[g], rg, alpha, SPRITE_STOPS.glow);
    }
    const rh = 9 * unit * (1 + 0.35 * signals.say + 0.2 * signals.think);
    const heartAlpha = [0.18 + 0.6 * signals.think, 0.75 * signals.say];
    heartAlpha.forEach((alpha, k) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites.heart[k], X[HEART] - rh, Y[HEART] - rh, rh * 2, rh * 2);
      if (light) depositSprite(X[HEART], Y[HEART], rh, alpha, SPRITE_STOPS.heart);
    });
    for (const byFamily of buckets) for (const byLevel of byFamily) for (const list of byLevel) list.length = 0;
    mixed.length = 0;
    for (const line of lines) {
      if (litColour[line.index] >= 0) continue;
      const ca = colourAt(line.a, line.b), cb = colourAt(line.b, line.a);
      if (ca !== cb) {
        mixed.push(line);
        continue;
      }
      const level = Math.min(LEVELS.length - 1, Math.floor((D[line.a] + D[line.b]) / 2 * LEVELS.length));
      buckets[ca][FAMILIES.indexOf(line.family)][level].push(line);
    }
    const strokeBatch = (list, alpha, width) => {
      ctx.beginPath();
      for (const line of list) {
        ctx.moveTo(X[line.a], Y[line.a]);
        ctx.lineTo(X[line.b], Y[line.b]);
      }
      ctx.stroke();
      strokes += 1;
      if (light) depositPath(list, alpha, width);
    };
    ctx.lineWidth = 0.75;
    buckets.forEach((byFamily, colour) => byFamily.forEach((byLevel, family) => byLevel.forEach((list, level) => {
      if (list.length === 0) return;
      const alpha = LINE_ALPHA[FAMILIES[family]] * LEVELS[level];
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = solid[colour];
      strokeBatch(list, alpha, 0.75);
    })));
    for (const line of mixed) {
      const ca = colourAt(line.a, line.b), cb = colourAt(line.b, line.a);
      const tension = ca + cb === 2 && ca !== 1;
      const depth = 0.5 + 0.5 * ((D[line.a] + D[line.b]) / 2);
      const shimmer = tension && moving ? 0.65 + 0.35 * Math.sin(now / 110 + line.index * 1.7) : 1;
      const gradient = ctx.createLinearGradient(X[line.a], Y[line.a], X[line.b], Y[line.b]);
      gradient.addColorStop(0, solid[ca]);
      gradient.addColorStop(1, solid[cb]);
      const alpha = LINE_ALPHA[line.family] * depth * (tension ? TENSION * shimmer : 1.2);
      const width = tension ? 1.15 : 0.85;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.strokeStyle = gradient;
      strokeBatch([line], alpha, width);
    }
    ctx.lineWidth = 1.1;
    litLines.forEach((list, colour) => {
      if (list.length === 0) return;
      ctx.globalAlpha = LIT_ALPHA;
      ctx.strokeStyle = solid[colour];
      strokeBatch(list, LIT_ALPHA, 1.1);
    });
    let drawn = 0;
    for (let k = 0; k < packets.size; k += 1) {
      const p = packets.list[k];
      const x = heads.x[k], y = heads.y[k], r = heads.r[k];
      const alpha = Math.min(PACKET_ALPHA[p.kind], headroom(x, y, r, SPRITE_STOPS.packet));
      if (!(alpha > 0.02)) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites.packet[p.value + 1], x - r, y - r, r * 2, r * 2);
      depositSprite(x, y, r, alpha, SPRITE_STOPS.packet);
      drawn += 1;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 0.6;
    const rings = [[], [], []];
    for (const cell of cells) if (cell.shell === SHELL.CORNER) rings[flow.values[cell.index] + 1].push(cell);
    rings.forEach((list, colour) => {
      if (list.length === 0) return;
      ctx.globalAlpha = 0.42;
      ctx.strokeStyle = solid[colour];
      ctx.beginPath();
      for (const cell of list) {
        const r = CORE[SHELL.CORNER] * unit * N[cell.g] * 2.3;
        ctx.moveTo(X[cell.g] + r, Y[cell.g]);
        ctx.arc(X[cell.g], Y[cell.g], r, 0, Math.PI * 2);
      }
      ctx.stroke();
      strokes += 1;
    });
    let cores = 0;
    for (const cell of cells) {
      const g = cell.g;
      const rc = CORE[cell.shell] * unit * N[g] * (litCell[cell.index] === 1 ? LIT_CORE : 1);
      ctx.globalAlpha = 0.7 + 0.3 * D[g];
      ctx.drawImage(sprites.core[flow.values[cell.index] + 1], X[g] - rc, Y[g] - rc, rc * 2, rc * 2);
      cores += 1;
    }
    ctx.globalAlpha = 1;
    const spent = clock() - started;
    stats.frames += 1;
    stats.cores = cores;
    stats.heart = 2;
    stats.strokes = strokes;
    stats.packets = packets.size;
    stats.packetsDrawn = drawn;
    stats.lit = litLines.reduce((n, list) => n + list.length, 0);
    stats.lastMs = spent;
    stats.meanMs = stats.frames === 1 ? spent : stats.meanMs + (spent - stats.meanMs) * 0.05;
  }
  const running = () => active && !hidden && !still && !destroyed;
  function advance(now, dt) {
    const { changed } = flow.step(now, signals);
    for (const i of changed) {
      changedAt[i] = now;
      packets.emitChange(cells[i].g, flow.values[i]);
    }
    packets.step(dt, signals.think);
    work += (signals.think - work) * (1 - Math.exp(-dt / 450));
    angle += dt * (0.55 + 0.95 * work) / 6400;
  }
  function tick(now) {
    frame = 0;
    if (!running()) return;
    if (side <= 0) measure();
    const dt = last === 0 ? 16.67 : Math.min(50, Math.max(0, now - last));
    last = now;
    advance(now, dt);
    render(now, true);
    schedule();
  }
  function schedule() {
    if (frame === 0 && running()) frame = requestFrame(tick);
  }
  function halt() {
    if (frame !== 0) {
      cancelFrame(frame);
      frame = 0;
    }
    last = 0;
  }
  function drawStill() {
    if (!active || destroyed || hidden) return;
    if (side <= 0) measure();
    render(clock(), false);
    drawnStill = side > 0 && ctx !== null;
  }
  const onVisibility = () => {
    hidden = doc.hidden === true;
    if (hidden) halt();
    else if (still) drawStill();
    else schedule();
  };
  const onMotion = () => {
    still = reduced?.matches === true;
    packets.setStill(still);
    if (still) {
      halt();
      changedAt.fill(-Infinity);
      drawStill();
    } else schedule();
  };
  doc.addEventListener?.("visibilitychange", onVisibility);
  reduced?.addEventListener?.("change", onMotion);
  let observer = null;
  try {
    observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => {
      api.resize();
    }) : null;
  } catch {
    observer = null;
  }
  const api = {
    element: canvas,
    canvas,
    stats,
    sprites,
    resize() {
      if (destroyed) return;
      measure();
      if (still) drawStill();
    },
    setActive(value) {
      active = Boolean(value);
      if (!active) {
        halt();
        return;
      }
      if (still) drawStill();
      else schedule();
    },
    /** Auma Live's frame: the three levels (and a colour this renderer does not need). */
    draw(_elapsedMs, state) {
      signals.mic = level01(state?.mic);
      signals.think = level01(state?.think);
      signals.say = level01(state?.say);
      if (!still || !active || destroyed) return;
      const { changed } = flow.step(clock(), signals);
      if (changed.length > 0 || !drawnStill) drawStill();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      halt();
      doc.removeEventListener?.("visibilitychange", onVisibility);
      reduced?.removeEventListener?.("change", onMotion);
      try {
        observer?.disconnect();
      } catch {
      }
      packets.clear();
      canvas.remove?.();
    },
    /** For the tests and the harness: what the renderer holds right now. */
    inspect() {
      return {
        values: flow.values,
        packets: packets.list,
        still,
        running: running(),
        frame,
        angle,
        work,
        size: [W, H, dpr],
        layout: { side, left, top, backing: canvas.width },
        /** a cell's or the heart's canvas CSS px and perspective scale in the last frame drawn */
        at: (g) => [X[g], Y[g], N[g]]
      };
    }
  };
  if (options.box) measure();
  schedule();
  return api;
}

// apps/web/scripts/stock-apps/auma-live-trace.mjs
function createAuraTrace(options = {}) {
  const doc = options.document ?? document;
  const element = doc.createElement("div");
  element.className = "alv-aura-trace alv-pentora-live";
  element.setAttribute("aria-hidden", "true");
  const live = createPentoraLive({ ...options, document: doc, box: element });
  element.append(live.element);
  return {
    element,
    resize() {
      live.resize();
    },
    setActive(value) {
      live.setActive(value);
    },
    draw(elapsedMs, state) {
      live.draw(elapsedMs, state);
    },
    destroy() {
      live.destroy();
    }
  };
}
export {
  createAuraTrace
};
