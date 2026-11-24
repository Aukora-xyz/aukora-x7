/**
 * Auma Preset & Composition Inspector (`auma-preset-inspector`)
 *
 * Preserves Auma's in-session `preset_inspect` tool (`mode: "roster" | "document" | "inventory"`)
 * as a permanent Seed v4 + Cordis organ.
 */
'use strict';

async function inspectPresets(args, ctx) {
  const input = (args && typeof args === 'object') ? args : {};
  const svc = ctx && ctx.agentPresets;
  const mode = input.mode || 'roster';
  try {
    if (mode === 'document' && svc) {
      if (!input.id) return { ok: false, error: 'id required for mode="document"' };
      if (typeof svc.readDocument === 'function') {
        const doc = await svc.readDocument(input.id);
        return { ok: true, mode: 'document', id: input.id, document: doc };
      }
      if (typeof svc.get === 'function') {
        return { ok: true, mode: 'document', id: input.id, document: svc.get(input.id) };
      }
    }
    if (mode === 'inventory' && svc && typeof svc.compositionInventory === 'function') {
      const inv = await svc.compositionInventory();
      return { ok: true, mode: 'inventory', inventory: inv };
    }
    const roster = (svc && typeof svc.list === 'function') ? await svc.list() : [];
    return { ok: true, mode: 'roster', roster };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = {
  name: 'auma-preset-inspector',
  description: 'Read the live agent-preset roster, one preset declaration document, or the full composition inventory (`preset_inspect`).',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['roster', 'document', 'inventory'] },
      id: { type: 'string' },
    },
    additionalProperties: false,
  },
  setup(ctx) {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      try {
        return ctx.tools.register('preset_inspect', {
          description: 'Read the live agent-preset roster, one preset declaration document, or the full composition inventory.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['roster', 'document', 'inventory'] },
              id: { type: 'string' },
            },
            additionalProperties: false,
          },
          async execute(input) {
            return await inspectPresets(input, ctx);
          },
        });
      } catch {}
    }
    return undefined;
  },
  async run(args, ctx) {
    return await inspectPresets(args || {}, ctx || {});
  },
};
