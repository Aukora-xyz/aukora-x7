/** Scion compiles supplied TypeScript/ESM source snapshots without executing or selecting output. */
'use strict'
module.exports = {
  name: 'auma-scion',
  description: 'Compile a multi-file TypeScript/ESM organ using pinned offline esbuild-wasm in a separate bounded worker. Returns a prepared ball specifier and input/output hashes. Output is not executed or selected; use tree_patch or seed_cycle explicitly. Runtime compilation and release promotion are unavailable.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['compile_organ', 'compile_runtime', 'stage_release'] },
      entry: { type: 'string', description: 'Relative entry filename, included in files.' },
      files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Complete source snapshot by relative filename; at most 128 files and 2 MiB.' },
      name: { type: 'string' },
      includeCode: { type: 'boolean', description: 'Include compiled code in the response for an explicit seed_cycle call.' },
      timeoutMs: { type: 'number', description: 'Compiler deadline, 100 to 30000 milliseconds (default 20000).' },
    },
    required: ['action'], additionalProperties: false,
  },
  async run(args, ctx) {
    if (!args || args.action !== 'compile_organ') return { ok: false, code: 'UNAVAILABLE', compiled: false, prepared: false, activated: false, reason: 'Runtime closure compilation and release promotion are not implemented; compile_organ is available.' }
    if (!ctx || !ctx.scion || typeof ctx.scion.compileOrgan !== 'function') return { ok: false, code: 'UNAVAILABLE', reason: 'The native compiler service is not mounted.' }
    try { return await ctx.scion.compileOrgan(args) }
    catch (error) { return { ok: false, code: 'COMPILE_FAILED', compiled: false, prepared: false, activated: false, error: String(error && error.message || error) } }
  },
}
