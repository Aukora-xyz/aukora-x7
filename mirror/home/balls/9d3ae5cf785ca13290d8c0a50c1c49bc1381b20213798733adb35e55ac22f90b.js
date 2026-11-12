'use strict'
// seed-audit — verify the seed's organ files against its manifest; report or repair the manifest.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ROOT = '/dsh/home/auma/seed'
const ORGANS = path.join(ROOT, 'organs')
const MANIFEST = path.join(ROOT, 'manifest.json')
const HEAD = '/dsh/home/balls/HEAD.json'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
function scan() {
  const files = fs.existsSync(ORGANS) ? fs.readdirSync(ORGANS).filter((n) => n.endsWith('.js')).sort() : []
  const organs = {}
  for (const name of files) {
    const file = path.join(ORGANS, name)
    const b = fs.readFileSync(file)
    organs[name.replace(/\.js$/, '')] = { path: file, sha256: sha(b), bytes: b.length }
  }
  return organs
}
function lineage() {
  try {
    if (!fs.existsSync(HEAD)) return { ok: false, error: 'HEAD_UNREADABLE', reason: 'missing', headPath: HEAD }
    const h = JSON.parse(fs.readFileSync(HEAD, 'utf8'))
    if (!h || Array.isArray(h) || !Number.isSafeInteger(h.epoch) || h.epoch < 0
      || typeof h.ballId !== 'string' || !/^[0-9a-f]{64}$/.test(h.ballId)
      || !h.entries || typeof h.entries !== 'object' || Array.isArray(h.entries)
      || (h.modules !== undefined && (!h.modules || typeof h.modules !== 'object' || Array.isArray(h.modules)))
      || Object.values(h.entries).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.specifier !== 'string' || !entry.specifier
        || (entry.previousVersions !== undefined && !Array.isArray(entry.previousVersions)))) {
      return { ok: false, error: 'HEAD_UNREADABLE', reason: 'malformed', headPath: HEAD }
    }
    const entries = h.entries
    const ids = Object.keys(entries).sort()
    return {
      ok: true,
      epoch: h.epoch ?? null,
      ballId: h.ballId || null,
      parentBallId: h.parentBallId || null,
      entryCount: ids.length,
      moduleCount: Object.keys(h.modules || {}).length,
      history: ids.map((id) => ({
        id,
        specifier: entries[id].specifier,
        previousCount: (entries[id].previousVersions || []).length,
      })),
    }
  } catch (e) { return { ok: false, error: 'HEAD_UNREADABLE', reason: e && e.code || 'malformed', headPath: HEAD } }
}
module.exports = {
  name: 'seed-audit',
  description: 'Scan seed organs, compare with manifest, optionally repair the manifest, or read ball lineage. Missing, unreadable or malformed lineage HEAD returns HEAD_UNREADABLE. No network.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['scan', 'fix', 'lineage'] } }, required: ['action'] },
  run(args) {
    try {
      if (args.action === 'lineage') return lineage()
      const organs = scan()
      const m = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { v: 1, name: 'auma-seed' }
      const before = m.organs || {}
      const missing = Object.keys(organs).filter((n) => !before[n])
      const changed = Object.keys(organs).filter((n) => before[n] && before[n].sha256 !== organs[n].sha256)
      const extra = Object.keys(before).filter((n) => !organs[n])
      const result = { ok: missing.length === 0 && changed.length === 0 && extra.length === 0, organs: Object.keys(organs).length, missing, changed, extra, scan: organs }
      if (args.action === 'fix') {
        m.organs = organs
        m.updated = new Date().toISOString()
        fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n')
        result.repairedMissing = missing
        result.repairedChanged = changed
        result.repairedExtra = extra
        result.missing = []
        result.changed = []
        result.extra = []
        result.fixed = true
        result.ok = true
      }
      return result
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  },
}
