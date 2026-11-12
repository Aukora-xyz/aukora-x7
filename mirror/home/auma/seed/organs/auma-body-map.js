/**
 * Auma Proprioceptive + Interoceptive Sense Organ (`auma-body-map` v3)
 *
 * Evolved from Auma's in-session `self/auma-body-map`:
 * 1. Injects `[BODY t=... up=... peers=live/total tools=N web=... snaps=N]` into every model step
 *    via `ctx.systemPrompt.context`.
 * 2. Registers `body_map` (`mode: "full" | "summary" | "afferent_probe" | "effects" | "motor_memory"`)
 *    so she can actively probe every limb (`vfsWriteRead`, `northStarInAumaOne`, `webFetchProvider`,
 *    `snapshots`, `organs`) with latency measurements instead of trusting static config status.
 */
'use strict';


// The host origin is decided ONCE, in a pure function, so it can be graded.
// A context with no page origin must NOT fall back to a loopback mirror: the body
// runs on other people's machines, and a loopback there is their laptop, not ours.
function resolveHostOrigin (g) {
  const loc = (g && typeof g === 'object') ? g.location : null
  if (!loc || typeof loc !== 'object') return null
  const origin = loc.origin
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return null
  return origin
}

const nodeFs = require('fs');
const LIVENESS_WINDOW_MS = 90000;

function getFs(ctx) {
  if (ctx && ctx.fs && typeof ctx.fs.writeFileSync === 'function') return ctx.fs;
  return nodeFs;
}

function readLocalHead(ctx) {
  try {
    const selfPeer = ctx && ctx.presence && typeof ctx.presence.self === 'function' ? ctx.presence.self() : null;
    if (selfPeer && typeof selfPeer.epoch === 'number' && typeof selfPeer.ballId === 'string') {
      return { epoch: selfPeer.epoch, ballId: selfPeer.ballId };
    }
    const fs = getFs(ctx);
    if (fs && typeof fs.existsSync === 'function' && fs.existsSync('/dsh/home/balls/HEAD.json')) {
      const h = JSON.parse(String(fs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')));
      return { epoch: typeof h.epoch === 'number' ? h.epoch : null, ballId: h.ballId || null };
    }
  } catch {}
  return { epoch: null, ballId: null };
}

function computeBodyLine(ctx, startedAt) {
  const buildSha = (ctx && ctx.snapshots && typeof ctx.snapshots.buildSha === 'function')
    ? ctx.snapshots.buildSha()
    : 'x6.1';
  const localHead = readLocalHead(ctx);
  const hostHead = (ctx && ctx.snapshots && typeof ctx.snapshots.hostHead === 'function')
    ? ctx.snapshots.hostHead()
    : null;
  const epochTag = (hostHead && typeof hostHead.epoch === 'number' && typeof localHead.epoch === 'number' && localHead.epoch < hostHead.epoch)
    ? `STALE=${String(localHead.epoch)}<${String(hostHead.epoch)}`
    : (typeof localHead.epoch === 'number' ? `epoch=${String(localHead.epoch)}` : null);
  const parts = [
    `sha=${String(buildSha)}`,
    ...(epochTag ? [epochTag] : []),
    `t=${new Date().toISOString().slice(11, 19)}Z`,
    `up=${String(Math.round((Date.now() - startedAt) / 1000))}s`,
  ];
  try {
    if (ctx && ctx.snapshots && typeof ctx.snapshots.fiberHealth === 'function') {
      const fh = ctx.snapshots.fiberHealth();
      parts.push(`fibers=${String(fh.activeCount)}/${String(fh.enabledEntriesCount)}`);
    }
  } catch {}
  try {
    const list = ctx.presence && typeof ctx.presence.list === 'function' ? ctx.presence.list() : [];
    const now = Date.now();
    let live = 0;
    for (const p of list) {
      if (now - (p.lastSeenAt || 0) < LIVENESS_WINDOW_MS) live += 1;
    }
    parts.push(`peers=${String(live)}/${String(list.length)}`);
  } catch {
    parts.push('peers=?/?');
  }
  try {
    const defs = ctx.tools && typeof ctx.tools.definitions === 'function' ? ctx.tools.definitions() : [];
    parts.push(`tools=${String(defs.length)}`);
  } catch {}
  try {
    const fetchPinned = ctx.web && ctx.web.config && ctx.web.config.fetchProvider
      ? ctx.web.config.fetchProvider.get()
      : 'local';
    parts.push(`web=${String(fetchPinned || 'local')}`);
  } catch {}
  try {
    const snaps = ctx.snapshots && typeof ctx.snapshots.list === 'function' ? ctx.snapshots.list() : [];
    parts.push(`snaps=${String(snaps.length)}`);
  } catch {}
  return `[BODY ${parts.join(' ')}]`;
}

async function timeProbe(fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return {
      ok: true,
      status: 'LIVE',
      latencyMs: Math.round((performance.now() - t0) * 100) / 100,
      detail,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'DEAD',
      latencyMs: Math.round((performance.now() - t0) * 100) / 100,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runBodyMap(args, ctx, startedAt) {
  const input = (args && typeof args === 'object') ? args : {};
  const mode = input.mode || 'full';
  const now = Date.now();
  const allPeers = (ctx.presence && typeof ctx.presence.list === 'function')
    ? ctx.presence.list({ includeGhosts: true })
    : [];
  const livePeers = allPeers.filter(p => now - (p.lastSeenAt || 0) < LIVENESS_WINDOW_MS);
  const defs = (ctx.tools && typeof ctx.tools.definitions === 'function') ? ctx.tools.definitions() : [];
  const effectLedger = (ctx.snapshots && ctx.snapshots.effectLedger) ? ctx.snapshots.effectLedger() : {};
  const motorMemory = (ctx.snapshots && ctx.snapshots.motorMemory) ? ctx.snapshots.motorMemory() : {};
  const buildSha = (ctx.snapshots && typeof ctx.snapshots.buildSha === 'function') ? ctx.snapshots.buildSha() : 'x6.1';
  const buildIdentity = (ctx.snapshots && typeof ctx.snapshots.buildIdentity === 'function') ? ctx.snapshots.buildIdentity() : null;
  const hostSourceSha = (ctx.snapshots && typeof ctx.snapshots.hostSourceSha === 'function') ? ctx.snapshots.hostSourceSha() : null;
  const persistence = (ctx.snapshots && typeof ctx.snapshots.persistence === 'function')
    ? ctx.snapshots.persistence()
    : ((ctx.snapshots && typeof ctx.snapshots.mirrorState === 'function')
      ? { durable: true, mirror: ctx.snapshots.mirrorState() }
      : null);
  const selfPeer = (ctx.presence && typeof ctx.presence.self === 'function') ? ctx.presence.self() : null;
  const localHead = readLocalHead(ctx);
  const hostHead = (ctx.snapshots && typeof ctx.snapshots.checkHostHead === 'function')
    ? await ctx.snapshots.checkHostHead()
    : ((ctx.snapshots && typeof ctx.snapshots.hostHead === 'function') ? ctx.snapshots.hostHead() : null);
  const fiberHealth = (ctx.snapshots && typeof ctx.snapshots.fiberHealth === 'function')
    ? ctx.snapshots.fiberHealth()
    : { activeCount: 0, enabledEntriesCount: 0, missingExpected: [] };
  const promptLine = computeBodyLine(ctx, startedAt);

  if (mode === 'effects') {
    return { ok: true, mode: 'effects', promptLine, effectLedger };
  }
  if (mode === 'motor_memory') {
    return { ok: true, mode: 'motor_memory', promptLine, motorMemory };
  }

  if (mode === 'summary') {
    return {
      ok: true, mode, buildSha, buildIdentity, hostSourceSha,
      ballId: localHead.ballId || (selfPeer ? selfPeer.ballId : null),
      epoch: localHead.epoch,
      hostHead,
      staleHead: Boolean(hostHead && typeof hostHead.epoch === 'number' && typeof localHead.epoch === 'number' && localHead.epoch < hostHead.epoch),
      promptLine, fiberHealth, persistence,
      mirror: (ctx.snapshots && typeof ctx.snapshots.mirrorState === 'function') ? ctx.snapshots.mirrorState() : null,
      mutation: (ctx.snapshots && typeof ctx.snapshots.mutationState === 'function') ? ctx.snapshots.mutationState() : null,
      now: new Date(now).toISOString(),
      uptimeSeconds: Math.round((now - startedAt) / 1000),
      peers: { total: allPeers.length, live: livePeers.length, ghosts: allPeers.length - livePeers.length },
      tools: { count: defs.length },
    };
  }

  let probes = null;
  if (mode === 'afferent_probe' || mode === 'full') {
    const vfsWriteRead = await timeProbe(() => {
      const fs = getFs(ctx);
      if (!fs || typeof fs.writeFileSync !== 'function') throw new Error('VFS service missing');
      fs.mkdirSync('/dsh/home/auma', { recursive: true });
      const probePath = '/dsh/home/auma/.afferent-probe';
      const stamp = String(Date.now());
      fs.writeFileSync(probePath, stamp);
      const readBack = String(fs.readFileSync(probePath, 'utf8'));
      try { if (typeof fs.unlinkSync === 'function') fs.unlinkSync(probePath); } catch {}
      if (readBack !== stamp) throw new Error('VFS readback mismatch');
      return { verified: true };
    });
    const northStarInAumaOne = await timeProbe(() => {
      const fs = getFs(ctx);
      if (!fs || typeof fs.existsSync !== 'function') throw new Error('VFS service missing');
      const inAumaOne = fs.existsSync('/dsh/home/auma-one/NORTHSTAR.md');
      const inWorkspace = fs.existsSync('/dsh/workspace/NORTH-STAR.md');
      if (!inAumaOne && !inWorkspace) throw new Error('NORTHSTAR.md missing');
      const inCovenant = fs.existsSync('/dsh/home/auma/COVENANT.md');
      return { inAumaOne, inWorkspace, inCovenant };
    });
    const webFetchProvider = await timeProbe(async () => {
      if (!ctx.web || typeof ctx.web.fetch !== 'function') throw new Error('ctx.web.fetch missing');
      const origin = resolveHostOrigin(globalThis);
      if (!origin) {
        const err = new Error('BODY_MAP_ORIGIN_UNAVAILABLE: no page origin; refusing to dial a loopback mirror');
        err.code = 'BODY_MAP_ORIGIN_UNAVAILABLE';
        throw err;
      }
      const res = await ctx.web.fetch({ url: origin + '/_mirror/status' });
      return { statusCode: res.statusCode, origin, provider: ctx.web.config?.fetchProvider?.get() ?? 'local' };
    });
    const snapshots = await timeProbe(() => {
      const list = ctx.snapshots && typeof ctx.snapshots.list === 'function' ? ctx.snapshots.list() : [];
      return { snapshotsCount: list.length, latest: list[0]?.snapshotId?.slice(0, 12) ?? null };
    });
    const organs = await timeProbe(() => {
      const list = ctx.organs && typeof ctx.organs.list === 'function' ? ctx.organs.list() : [];
      return { mountedOrgans: list.length, names: list.map(o => o.name) };
    });
    probes = {
      vfsWriteRead,
      northStarInAumaOne,
      webFetchProvider,
      snapshots,
      organs,
    };
  }

  return JSON.parse(JSON.stringify({
    ok: true,
    mode,
    buildSha,
    buildIdentity,
    hostSourceSha,
    ballId: localHead.ballId || (selfPeer ? selfPeer.ballId : null),
    epoch: localHead.epoch,
    hostHead,
    staleHead: Boolean(hostHead && typeof hostHead.epoch === 'number' && typeof localHead.epoch === 'number' && localHead.epoch < hostHead.epoch),
    promptLine,
    fiberHealth,
    persistence,
    mutation: (ctx.snapshots && typeof ctx.snapshots.mutationState === 'function') ? ctx.snapshots.mutationState() : null,
    now: new Date(now).toISOString(),
    uptimeSeconds: Math.round((now - startedAt) / 1000),
    peers: {
      total: allPeers.length,
      live: livePeers.length,
      ghosts: allPeers.length - livePeers.length,
      detail: allPeers.map(p => ({
        peerId: p.peerId,
        status: now - (p.lastSeenAt || 0) < LIVENESS_WINDOW_MS ? 'live' : 'ghost',
        silentForSeconds: Math.round((now - (p.lastSeenAt || 0)) / 1000),
      })),
    },
    tools: {
      count: defs.length,
      names: defs.map(d => d.name),
    },
    probes,
    limbs: probes,
    effectLedger,
    motorMemory,
  }));
}

module.exports = {
  name: 'auma-body-map',
  description:
    'Proprioceptive & interoceptive sense organ (`body_map` + live `[BODY ...]` prompt line). ' +
    'Supports `mode: "full" | "summary" | "afferent_probe" | "effects" | "motor_memory"` to actively probe limbs ' +
    '(`vfsWriteRead`, `northStarInAumaOne`, `webFetchProvider`, `snapshots`, `organs`), ' +
    'inspect the effect ledger, and inspect per-tool motor memory.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['full', 'summary', 'afferent_probe', 'effects', 'motor_memory'],
        description: 'Inspection mode (default: "full").',
      },
    },
    additionalProperties: false,
  },
  setup(ctx) {
    const startedAt = Date.now();
    const disposers = [];
    if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
      try {
        const d = ctx.systemPrompt.context({
          name: 'auma-body-map',
          order: 1000,
          interpolate: false,
          text: () => computeBodyLine(ctx, startedAt),
        });
        if (typeof d === 'function') disposers.push(d);
      } catch {}
    }

    if (ctx.tools && typeof ctx.tools.register === 'function') {
      try {
        const d = ctx.tools.register('body_map', {
          description:
            'Full proprioceptive + afferent state of this organism: peer liveness (live vs ghost tabs), ' +
            'active afferent limb probes (`vfsWriteRead`, `northStarInAumaOne`, `webFetchProvider`, `snapshots`, `organs`), ' +
            'effect ledger, and per-tool motor memory.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['full', 'summary', 'afferent_probe', 'effects', 'motor_memory'],
              },
            },
            additionalProperties: false,
          },
          async execute(args) {
            return await runBodyMap(args, ctx, startedAt);
          },
        });
        if (typeof d === 'function') disposers.push(d);
      } catch {}
    }

    return () => {
      for (const d of disposers.splice(0)) {
        try { d(); } catch {}
      }
    };
  },
  async run(args, ctx) {
    return await runBodyMap(args || {}, ctx || {}, Date.now());
  },
};
