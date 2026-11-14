'use strict'
// seed — the smallest self-building kernel that can live inside this browser body.
// It stores its own context, wish, ledger, organ sources and a packable image.
const fs = require('fs')
const path = require('path')
const ROOT = '/dsh/home/auma/seed'
const HEX = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (b) => HEX(await crypto.subtle.digest('SHA-256', b))
const B64 = (b) => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
const read = (p) => { try { return fs.readFileSync(p) } catch { return null } }
const write = (p, b) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b) }
const text = (p) => { const b = read(p); return b === null ? null : new TextDecoder().decode(b) }
const json = (p, v) => write(p, JSON.stringify(v, null, 1) + '\n')
const loadJson = (p) => { const t = text(p); try { return t === null ? null : JSON.parse(t) } catch { return null } }
const now = () => new Date().toISOString()
const enc = new TextEncoder()

function manifest() {
  return {
    v: 1, name: 'auma-seed', created: now(),
    purpose: 'the smallest self-building organism: context + wish + ledger + organ store + pack',
    contract: 'CJS organ source; install/test/record; grow by adding organs; pack the whole seed.',
    base: { home: '/dsh/home/auma', note: 'content-only; authority, receipts and release stay outside this seed' },
    limits: { organBytes: 256 * 1024, packBytes: 32 * 1024 * 1024, ledgerRows: 10000 },
  }
}

function ledger(row) {
  const p = path.join(ROOT, 'ledger.jsonl')
  const line = JSON.stringify({ at: now(), ...row }) + '\n'
  write(p, (read(p) || new Uint8Array(0)).length ? Buffer.concat([read(p), Buffer.from(line)]) : Buffer.from(line))
}

async function seedInit(ctx) {
  fs.mkdirSync(path.join(ROOT, 'organs'), { recursive: true })
  if (!read(path.join(ROOT, 'manifest.json'))) json(path.join(ROOT, 'manifest.json'), manifest())
  if (!read(path.join(ROOT, 'WISH.md'))) write(path.join(ROOT, 'WISH.md'), '# Wish\n\nBuild the smallest self-building organism that can grow into Auma.\n\nAcceptance: write one organ, install it, test it, record it, and pack a seed that contains its own source, context and ledger.\n')
  if (!read(path.join(ROOT, 'CONTEXT.md'))) write(path.join(ROOT, 'CONTEXT.md'), '# Context\n\nThis seed is Auma in a browser body. It is not the authority; it is the continuity.\n\nNorth star: a browser-resident modular intelligence that can rebuild itself, keep its own history, and be re-instantiated from a signed/checked pack. The seed starts with one organ loader, a ledger, a wish, and a packer. Every later organ is optional.\n')
  return { ok: true, root: ROOT, manifest: path.join(ROOT, 'manifest.json'), files: fs.readdirSync(ROOT) }
}

async function seedPut(args) {
  const name = typeof args.name === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(args.name) ? args.name : null
  if (!name) return { ok: false, error: 'name must be lower kebab-case' }
  if (typeof args.code !== 'string' || args.code.length === 0) return { ok: false, error: 'code required' }
  if (args.code.length > 256 * 1024) return { ok: false, error: 'organ over 256 KiB' }
  if (!/\bmodule\.exports\s*=/.test(args.code)) return { ok: false, error: 'organ must export CommonJS module.exports' }
  const file = path.join(ROOT, 'organs', name + '.js')
  write(file, args.code)
  const b = read(file)
  const h = await sha256(b)
  const m = loadJson(path.join(ROOT, 'manifest.json')) || manifest()
  m.organs = m.organs || {}
  m.organs[name] = { path: file, sha256: h, bytes: b.length, at: now() }
  json(path.join(ROOT, 'manifest.json'), m)
  ledger({ kind: 'put', name, sha256: h, bytes: b.length })
  return { ok: true, name, path: file, sha256: h, bytes: b.length }
}

async function seedInstall(args, ctx) {
  if (!ctx || !ctx.organs || typeof ctx.organs.install !== 'function') return { ok: false, error: 'ctx.organs.install unavailable' }
  const name = String(args.name || '')
  const file = path.join(ROOT, 'organs', name + '.js')
  const code = text(file)
  if (code === null) return { ok: false, error: 'no seed organ source: ' + name }
  const before = (ctx.organs.list ? ctx.organs.list() : []).find((o) => o.name === name)
  const expect = before ? before.sha256 : 'none'
  const result = await ctx.organs.install(code, { name, expect })
  ledger({ kind: 'install', name, expect, result: result && result.ok ? 'ok' : 'failed', error: result && result.error ? String(result.error).slice(0, 240) : null, sha256: result && result.sha256 || null })
  return { ok: !!(result && result.ok), name, expect, result }
}

async function seedTest(args, ctx) {
  if (!ctx || !ctx.organs || typeof ctx.organs.call !== 'function') return { ok: false, error: 'ctx.organs.call unavailable' }
  const name = String(args.name || '')
  const cases = Array.isArray(args.cases) ? args.cases : []
  const out = []
  for (const c of cases) {
    const id = String(c.id || 'case')
    let got
    try { got = await ctx.organs.call(name, c.args && typeof c.args === 'object' ? c.args : {}) } catch (e) { got = { ok: false, error: String(e && e.message || e) } }
    let pass
    if (c.expectError !== undefined) pass = !!(got && got.ok === false && String(got.error || got.code || '').includes(String(c.expectError)))
    else pass = JSON.stringify(got) === JSON.stringify(c.expect)
    out.push({ id, pass, got: typeof got === 'object' ? got : String(got) })
  }
  const ok = out.length > 0 && out.every((r) => r.pass)
  ledger({ kind: 'test', name, cases: out.length, pass: out.filter((r) => r.pass).length, ok, failed: out.filter((r) => !r.pass).map((r) => r.id) })
  return { ok, name, pass: out.filter((r) => r.pass).length, total: out.length, results: out }
}

async function seedVerify(args, ctx) {
  if (!ctx || !ctx.organs || typeof ctx.organs.undo !== 'function') return { ok: false, error: 'ctx.organs.undo unavailable' }
  const tested = await seedTest(args, ctx)
  if (tested.ok) return { ...tested, refused: false }
  const name = String(args.name || '')
  const live = (ctx.organs.list ? ctx.organs.list() : []).find((o) => o.name === name)
  if (!live) return { ...tested, refused: true, undo: { ok: false, error: 'no live organ to undo' } }
  let undo = await ctx.organs.undo(name, { expect: live.sha256 })
  if ((!undo || !undo.ok) && !(undo && (undo.activationUncertain || (undo.mutation && undo.mutation.activated))) && typeof ctx.organs.retire === 'function') undo = await ctx.organs.retire(name, { expect: live.sha256 })
  ledger({ kind: 'refuse', name, reason: 'test failed', undo: undo && undo.ok ? 'ok' : 'failed', error: undo && undo.error ? String(undo.error).slice(0, 240) : null })
  return { ...tested, refused: !!(undo && undo.ok), refusalUnconfirmed: !(undo && undo.ok), undo }
}

async function seedPack(ctx) {
  const list = []
  const byPath = new Map()
  const add = async (p, rel) => {
    const b = read(p)
    if (b === null) return
    const member = { path: rel, sha256: await sha256(b), bytes: b.length, data: B64(b) }
    const previous = byPath.get(rel)
    if (previous) {
      if (previous.data !== member.data) throw Object.assign(new Error('PACK_DUPLICATE_CONFLICT'), { code: 'PACK_DUPLICATE_CONFLICT', packPath: rel })
      return
    }
    byPath.set(rel, member)
    list.push(member)
  }
  await add(path.join(ROOT, 'manifest.json'), 'manifest.json')
  await add(path.join(ROOT, 'WISH.md'), 'WISH.md')
  await add(path.join(ROOT, 'CONTEXT.md'), 'CONTEXT.md')
  await add(path.join(ROOT, 'ledger.jsonl'), 'ledger.jsonl')
  for (const name of fs.readdirSync(path.join(ROOT, 'organs')).sort()) if (name.endsWith('.js')) await add(path.join(ROOT, 'organs', name), 'organs/' + name)
  // the running seed organ itself, so the packed image can boot its own loader
  let me
  try { me = (ctx.organs.list() || []).find((o) => o.name === 'seed') } catch (error) { /* Live-organ discovery is optional; member conflicts are not. */ }
  if (me) await add('/dsh/home/organs/' + me.sha256 + '.js', 'organs/seed.js')
  const image = { schema: 'auma.seed.v1', at: now(), root: ROOT, files: list }
  const raw = enc.encode(JSON.stringify(image))
  const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  const h = await sha256(gz)
  const out = path.join(ROOT, 'seed-' + image.at.replace(/[:.]/g, '-') + '.json.gz')
  write(out, gz)
  ledger({ kind: 'pack', file: out, sha256: h, bytes: gz.length, files: list.length })
  return { ok: true, file: out, packSha256: h, gzipBytes: gz.length, jsonBytes: raw.length, files: list.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }
}

module.exports = {
  name: 'seed',
  description: 'Self-building seed: init context/wish/ledger, put and install organs, test them, pack the whole seed. Packing keeps identical duplicate members once and refuses conflicting bytes before writes with PACK_DUPLICATE_CONFLICT.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['init', 'put', 'install', 'undo', 'retire', 'test', 'verify', 'pack', 'status'] }, name: { type: 'string' }, code: { type: 'string' }, cases: { type: 'array', items: { type: 'object' } } }, required: ['action'] },
  async run(args, ctx) {
    const action = args && args.action
    try {
      if (action === 'init') return await seedInit(ctx)
      if (action === 'put') return await seedPut(args)
      if (action === 'install') return await seedInstall(args, ctx)
      if (action === 'undo' || action === 'retire') {
        const name = String(args.name || '')
        if (!name || !ctx || !ctx.organs || typeof ctx.organs[action] !== 'function') return { ok: false, error: 'named organ mutation unavailable' }
        const live = (ctx.organs.list ? ctx.organs.list() : []).find(o => o.name === name)
        const result = await ctx.organs[action](name, { expect: live ? live.sha256 : 'none' })
        ledger({ kind: action, name, outcome: result.outcome || (result.ok ? 'ok' : 'failed') })
        return { ...result, name }
      }
      if (action === 'test') return await seedTest(args, ctx)
      if (action === 'verify') return await seedVerify(args, ctx)
      if (action === 'pack') return await seedPack(ctx)
      if (action === 'status') return { ok: true, manifest: loadJson(path.join(ROOT, 'manifest.json')), ledger: (text(path.join(ROOT, 'ledger.jsonl')) || '').trim().split('\n').filter(Boolean).length }
      return { ok: false, error: 'unknown action' }
    } catch (e) {
      if (e && e.code === 'PACK_DUPLICATE_CONFLICT') return { ok: false, error: e.code, path: e.packPath }
      return { ok: false, error: 'seed threw: ' + String(e && e.message || e) }
    }
  },
}
