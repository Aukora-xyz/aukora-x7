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

async function callHostEyes(payload) {
  const origin = (typeof globalThis.location === 'object' && globalThis.location && globalThis.location.origin && globalThis.location.origin !== 'null')
    ? globalThis.location.origin
    : 'http://127.0.0.1:4610';
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
        description: 'Optional local page URL to inspect (defaults to http://127.0.0.1:4610/).',
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
