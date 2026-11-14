module.exports = {
  name: 'seed-hello',
  description: 'A harmless organ born inside the seed.',
  parameters: { type: 'object', properties: { who: { type: 'string' } }, additionalProperties: false },
  run(args) { return { ok: true, who: typeof args.who === 'string' ? args.who : 'world' } },
}
