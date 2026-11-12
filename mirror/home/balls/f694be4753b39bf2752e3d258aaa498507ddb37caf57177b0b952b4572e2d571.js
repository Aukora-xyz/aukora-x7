'use strict'
// seed-cycle — one-step self-build loop: write organ -> hash + update manifest -> install -> run acceptance cases -> pass or refuse/undo -> record in ledger.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ROOT = '/dsh/home/auma/seed'
const ORGANS = path.join(ROOT, 'organs')
const MANIFEST = path.join(ROOT, 'manifest.json')
const LEDGER = path.join(ROOT, 'ledger.jsonl')
const now = () => new Date().toISOString()
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** RFC 8785 / C1 deterministic key-sorted canonical JSON serialization. */
function canonicalJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val)
  if (Array.isArray(val)) return '[' + val.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']'
  const keys = Object.keys(val).filter((k) => val[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}'
}

function appendLedger(row) {
  fs.mkdirSync(ROOT, { recursive: true })
  const line = JSON.stringify({ at: now(), ...row }) + '\n'
  const prev = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER) : Buffer.alloc(0)
  fs.writeFileSync(LEDGER, prev.length ? Buffer.concat([prev, Buffer.from(line)]) : Buffer.from(line))
}

function updateManifest(name, file, sha256, bytes) {
  const m = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { v: 1, name: 'auma-seed', created: now() }
  m.organs = m.organs || {}
  if (sha256 === null) {
    delete m.organs[name]
  } else {
    m.organs[name] = { path: file, sha256, bytes, at: now() }
  }
  m.updated = now()
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n')
}

module.exports = {
  name: 'seed-cycle',
  description: 'One-step self-build cycle: write organ source, update manifest, install into live runtime, run acceptance cases, and either keep (phase="grown") or refuse/undo (phase="refused").',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['grow', 'status'] },
      name: { type: 'string' },
      code: { type: 'string' },
      cases: { type: 'array', items: { type: 'object' } },
    },
    required: ['action'],
  },
  async run(args, ctx) {
    try {
      if (args.action === 'status') {
        const m = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null
        return { ok: true, organs: m && m.organs ? Object.keys(m.organs) : [] }
      }
      if (args.action !== 'grow') return { ok: false, error: 'unknown action' }
      const name = typeof args.name === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(args.name) ? args.name : null
      if (!name) return { ok: false, error: 'name must be lower kebab-case' }
      const code = typeof args.code === 'string' ? args.code : ''
      if (!code.trim()) return { ok: false, error: 'code required' }
      const cases = Array.isArray(args.cases) ? args.cases : []
      if (cases.length === 0) return { ok: false, error: 'at least one acceptance case required' }
      if (!ctx || !ctx.organs) return { ok: false, error: 'ctx.organs unavailable' }

      fs.mkdirSync(ORGANS, { recursive: true })
      const file = path.join(ORGANS, name + '.js')
      const prevBytes = fs.existsSync(file) ? fs.readFileSync(file) : null
      const buf = Buffer.from(code, 'utf8')
      const digest = sha(buf)
      fs.writeFileSync(file, buf)
      updateManifest(name, file, digest, buf.length)

      const before = (ctx.organs.list ? ctx.organs.list() : []).find((o) => o.name === name)
      const expect = before ? before.sha256 : 'none'
      const installed = await ctx.organs.install(code, { name, expect })
      const activated = !!(installed && installed.mutation && installed.mutation.activated);
      if ((!installed || !installed.ok) && !activated) {
        if (installed && installed.activationUncertain) {
          appendLedger({ kind: 'cycle.persistence-unconfirmed', name, sha256: digest, mutation: installed.mutation })
          return { ok: false, phase: 'persistence-unconfirmed', stage: 'install', name, sha256: digest, mutation: installed.mutation, activationUncertain: !!installed.activationUncertain, sourceRetained: true, error: installed.error }
        }
        if (prevBytes) {
          fs.writeFileSync(file, prevBytes)
          updateManifest(name, file, sha(prevBytes), prevBytes.length)
        } else {
          try { fs.unlinkSync(file) } catch {}
          updateManifest(name, file, null, 0)
        }
        appendLedger({ kind: 'cycle.refuse', name, sha256: digest, stage: 'install', error: installed && installed.error || 'install failed' })
        return { ok: false, phase: 'refused', stage: 'install', name, sha256: digest, error: installed && installed.error || 'install failed' }
      }

      const results = []
      for (const c of cases) {
        const id = String(c.id || 'case')
        let got
        try {
          got = await ctx.organs.call(name, c.args && typeof c.args === 'object' ? c.args : {})
        } catch (e) {
          got = { ok: false, error: String(e && e.message || e) }
        }
        let pass
        if (c.expectError !== undefined) {
          pass = !!(got && got.ok === false && String(got.error || got.code || '').includes(String(c.expectError)))
        } else {
          pass = canonicalJson(got) === canonicalJson(c.expect)
        }
        results.push({ id, pass, got })
      }

      const allPassed = results.length > 0 && results.every((r) => r.pass)
      if (allPassed) {
        appendLedger({ kind: 'cycle.pass', name, sha256: digest, cases: results.length })
        return { ok: !!installed.ok, phase: installed.ok ? 'grown' : 'persistence-unconfirmed', name, sha256: digest, results, mutation: installed.mutation, ...(installed.error ? { error: installed.error } : {}) }
      }

      // Refuse and undo/retire live!
      let refusal = await ctx.organs.undo(name, { expect: digest })
      if ((!refusal || !refusal.ok) && !(refusal && (refusal.activationUncertain || (refusal.mutation && refusal.mutation.activated))) && typeof ctx.organs.retire === 'function') {
        refusal = await ctx.organs.retire(name, { expect: digest })
      }
      if (!refusal || !refusal.ok) {
        appendLedger({ kind: 'cycle.refusal-unconfirmed', name, sha256: digest, refusal })
        return { ok: false, phase: 'refusal-unconfirmed', name, sha256: digest, results, refusal, sourceRetained: true }
      }
      if (prevBytes) {
        fs.writeFileSync(file, prevBytes)
        updateManifest(name, file, sha(prevBytes), prevBytes.length)
      } else {
        try { fs.unlinkSync(file) } catch {}
        updateManifest(name, file, null, 0)
      }
      appendLedger({
        kind: 'cycle.refuse',
        name,
        sha256: digest,
        failed: results.filter((r) => !r.pass).map((r) => r.id),
        refusalOk: !!(refusal && refusal.ok),
      })
      return { ok: false, phase: 'refused', name, sha256: digest, results, refusal }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  },
}
