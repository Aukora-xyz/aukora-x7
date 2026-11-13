import { describe, expect, it } from 'vitest'
import { trialScionRetention } from '../../src/x6/scion-growth.ts'

const trial = (code: string, args: Record<string, unknown> = {}, peers: Record<string, string> = {}) =>
  trialScionRetention({ target: code, ...peers }, {
    fixedNow: 0, fixtures: { base: { '/probe': 'fixture' } },
    cases: [{ id: 'probe', args: { organ: 'target', fixture: 'base', ...args }, expect: { ok: true } }],
  })

const surfaces = ['tools', 'organs', 'snapshots', 'fs']
const reads = surfaces.flatMap(service => [
  { access: `ctx.${service}.unknownMember`, code: `${service}.unknownMember` },
  { access: `'unknownMember' in ctx.${service}`, code: `${service}.unknownMember` },
  { access: `Object.getOwnPropertyDescriptor(ctx.${service},'unknownMember')`, code: `${service}.unknownMember` },
  { access: `Reflect.ownKeys(ctx.${service})`, code: `${service}.ownKeys` },
  { access: `Object.getPrototypeOf(ctx.${service})`, code: `${service}.getPrototypeOf` },
])

// Each caught or feature-tested adapter gap must remain visible to the parent grader.
describe('retention member-level parity evidence', () => {
  it.each(reads)('records $access', async ({ access, code }) => {
    const result = await trial(`module.exports={name:'target',run(_,ctx){void (${access});return {ok:true}}}`)
    expect(result).toMatchObject({ ok: false, results: [{ pass: false, got: { ok: true },
      infrastructure: [{ phase: 'dependency', code: `PEARL_CTX_SERVICE_UNAVAILABLE:${code}`, subject: 'target' }] }] })
  })

  it.each([
    ['ctx.tools.definitions', 'tools.definitions'], ['ctx.tools.get', 'tools.get'],
    ['ctx.organs.install', 'organs.install'], ['ctx.snapshots.buildSha', 'snapshots.buildSha'],
    ['ctx.fs.rmSync', 'fs.rmSync'], ['ctx.fs.lstatSync("/probe")', 'fs.lstatSync'],
    ['require("fs").lstatSync', 'fs.lstatSync'], ['process.getBuiltinModule("node:fs").rmSync', 'fs.rmSync'],
    ['ctx.organs.list()', 'organs.list'], ['ctx.scion', 'scion'],
  ])('records the D1-D4 gap %s even when caught', async (access, code) => {
    const result = await trial(`module.exports={name:'target',run(_,ctx){try {void (${access})} catch {} return {ok:true}}}`)
    expect(result).toMatchObject({ ok: false, results: [{ pass: false,
      infrastructure: [{ phase: 'dependency', code: `PEARL_CTX_SERVICE_UNAVAILABLE:${code}`, subject: 'target' }] }] })
  })

  it('keeps supported fixture operations usable without infrastructure records', async () => {
    const result = await trial(`module.exports={name:'target',run(_,ctx){
      ctx.fs.writeFileSync('/new','yes');
      return {ok:ctx.fs.readFileSync('/probe','utf8')==='fixture' && ctx.fs.existsSync('/new')
        && ctx.snapshots.persistenceState().writable && typeof ctx.organs.call==='function'
        && typeof ctx.tools.register==='function'}
    }}`)
    expect(result).toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
  })

  it('attributes missing peer members to the peer', async () => {
    const result = await trial('module.exports={name:\'target\',run(_,ctx){return ctx.organs.call(\'peer\',{})}}', {}, {
      peer: 'module.exports={name:\'peer\',run(_,ctx){void ctx.tools.definitions;return {ok:true}}}',
    })
    expect(result).toMatchObject({ ok: false, results: [{ infrastructure: [
      { phase: 'dependency', code: 'PEARL_CTX_SERVICE_UNAVAILABLE:tools.definitions', subject: 'peer' },
    ] }] })
  })
})

describe('retention production input normalization', () => {
  it.each([undefined, null, false, 0, 'text'])('normalizes %j for Seed, tool and peer dispatch', async (input) => {
    const check = 'input && typeof input===\'object\' && !Array.isArray(input) && Object.keys(input).length===0'
    const source = `module.exports={name:'target',setup(ctx){ctx.tools.register('probe',{execute(input){return {ok:${check}}}})},run(input){return {ok:${check}}}}`
    const rowInput = input === undefined ? {} : { input }
    for (const args of [rowInput, { ...rowInput, tool: 'probe' }]) {
      expect(await trial(source, args)).toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
    }
    const peerInput = input === undefined ? 'undefined' : JSON.stringify(input)
    expect(await trial(`module.exports={name:'target',run(_,ctx){return ctx.organs.call('peer',${peerInput})}}`, {}, {
      peer: `module.exports={name:'peer',run(input){return {ok:${check}}}}`,
    })).toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
  })

  it.each([{ input: { value: 7 } }, { input: [7] }])('preserves production object input $input, including arrays', async ({ input }) => {
    const check = Array.isArray(input) ? 'Array.isArray(input) && input[0]===7' : 'input.value===7'
    const source = `module.exports={name:'target',setup(ctx){ctx.tools.register('probe',{execute(input){return {ok:${check}}}})},run(input){return {ok:${check}}}}`
    for (const args of [{ input }, { input, tool: 'probe' }]) {
      expect(await trial(source, args)).toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
    }
    expect(await trial('module.exports={name:\'target\',run(input,ctx){return ctx.organs.call(\'peer\',input)}}', { input }, {
      peer: `module.exports={name:'peer',run(input){return {ok:${check}}}}`,
    })).toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
  })
})
