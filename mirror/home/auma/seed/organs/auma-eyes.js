/**
 * Auma Seed v4 Organ: `auma-eyes` (Exteroception: Structural Page Projection + On-Demand Screenshot)
 *
 * Gives Auma direct visual & structural perception of her own browser shell without bloating context:
 * - `action: "projection"` (default): returns a ~2KB structural DOM projection (viewport, focused element,
 *   headings, interactive controls with bounding rects, visible text summary).
 * - `action: "screenshot"`: captures a PNG screenshot of her live browser shell to
 *   `/dsh/home/auma-one/captures/latest.png` (and `/dsh/home/auma/captures/latest.png`) + returns the
 *   structural projection.
 */
'use strict';

function resolveHostOrigin(g) {
  const loc = (g && typeof g === 'object') ? g.location : null;
  if (!loc || typeof loc !== 'object') return null;
  const origin = loc.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return null;
  return origin;
}

async function callHostEyes(payload) {
  const origin = resolveHostOrigin(globalThis);
  if (!origin) {
    const err = new Error('EYES_ORIGIN_UNAVAILABLE: this context has no page origin (globalThis.location is absent or opaque). Refusing to dial a local mirror.');
    err.code = 'EYES_ORIGIN_UNAVAILABLE';
    throw err;
  }
  const res = await fetch(`${origin}/_host/eyes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`/_host/eyes HTTP ${res.status}`);
  }
  return await res.json();
}

module.exports = {
  name: 'auma-eyes',
  description:
    'Exteroceptive visual & structural sense organ (`auma_eyes`). ' +
    'Default `action: "projection"` returns a compact ~2KB structural DOM projection of the live UI (viewport, headings, interactive controls with bounding rects, visible text). ' +
    '`action: "screenshot"` captures an on-demand PNG to `/dsh/home/auma-one/captures/latest.png` alongside the projection.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['projection', 'screenshot'],
        description: 'Exteroceptive mode: "projection" (fast ~2KB DOM layout summary) or "screenshot" (PNG capture + projection).',
      },
      url: {
        type: 'string',
        description: "Optional page URL to inspect (defaults to this page's own origin).",
      },
      selector: {
        type: 'string',
        description: 'Optional CSS selector to focus or highlight in the structural projection.',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const input = (args && typeof args === 'object') ? args : {};
    const action = input.action || 'projection';
    const data = await callHostEyes({
      action,
      url: input.url,
      selector: input.selector,
    });
    if (data && data.ok && data.pngBase64) {
      try {
        const fs = (ctx && ctx.fs && typeof ctx.fs.writeFileSync === 'function') ? ctx.fs : require('fs');
        const bytes = Buffer.from(data.pngBase64, 'base64');
        fs.mkdirSync('/dsh/home/auma-one/captures', { recursive: true });
        fs.writeFileSync('/dsh/home/auma-one/captures/latest.png', bytes);
        fs.mkdirSync('/dsh/home/auma/captures', { recursive: true });
        fs.writeFileSync('/dsh/home/auma/captures/latest.png', bytes);
      } catch {}
      delete data.pngBase64;
    }
    return data;
  },
};
