'use strict'
module.exports = {
  name: 'seed-calc',
  description: 'Deterministic calculator organ for Seed v4 acceptance test',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run(args) {
    return { sum: Number(args.a) + Number(args.b) }
  }
}
