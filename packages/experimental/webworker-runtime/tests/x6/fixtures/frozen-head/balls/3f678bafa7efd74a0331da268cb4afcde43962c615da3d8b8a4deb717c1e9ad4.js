'use strict'
// seed-memory — local n-gram recall + append-only memory over the seed's own text and North Star docs. No model call, no network.
const fs = require('fs')
const path = require('path')
const ROOT = '/dsh/home/auma/seed'
const FILES = [
  ['context', path.join(ROOT, 'CONTEXT.md')],
  ['wish', path.join(ROOT, 'WISH.md')],
  ['ledger', path.join(ROOT, 'ledger.jsonl')],
  ['north-star-cell', '/dsh/home/auma/NORTH-STAR.md'],
  ['north-star-x6', '/dsh/home/auma/NORTH-STAR-X6.md'],
  ['north-star-x5', '/dsh/home/auma/NORTH-STAR-X5.md'],
  ['covenant', '/dsh/home/auma/COVENANT.md'],
]
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w.length >= 2)
function rows() {
  const out = []
  for (const [kind, file] of FILES) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.length > 0) out.push({ id: kind + ':' + (i + 1), kind, line: i + 1, text: t })
    }
  }
  return out
}
function grams(text) {
  const w = words(text), set = new Set()
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '))
  return set
}
function index() {
  const rs = rows(), idx = new Map()
  for (const r of rs) for (const g of grams(r.text)) { if (!idx.has(g)) idx.set(g, new Set()); idx.get(g).add(r.id) }
  return { rs, idx }
}
function recall(query, limit) {
  const q = grams(query), { rs, idx } = index()
  const score = new Map()
  for (const g of q) for (const id of idx.get(g) || []) score.set(id, (score.get(id) || 0) + (g.includes(' ') ? 2 : 1))
  const byId = new Map(rs.map((r) => [r.id, r]))
  const hits = [...score.entries()].map(([id, s]) => ({ id, score: s, row: byId.get(id) })).filter((x) => x.row).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, limit)
  return { query, terms: [...q].slice(0, 24), hits, scanned: rs.length }
}
module.exports = {
  name: 'seed-memory',
  description: 'Local n-gram recall and append-only memory over the seed context, wish, ledger, and X5/X6 North Stars. No model, no network.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recall', 'stats', 'remember'] },
      query: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['action'],
  },
  run(args) {
    if (args.action === 'stats') {
      const { rs, idx } = index()
      return { ok: true, rows: rs.length, grams: idx.size, files: FILES.map(([k, f]) => ({ kind: k, file: f, exists: fs.existsSync(f) })) }
    }
    if (args.action === 'remember') {
      const note = typeof args.note === 'string' ? args.note.trim() : (typeof args.query === 'string' ? args.query.trim() : '')
      if (!note) return { ok: false, error: 'note required' }
      const ledgerFile = path.join(ROOT, 'ledger.jsonl')
      fs.mkdirSync(ROOT, { recursive: true })
      const entry = { at: new Date().toISOString(), kind: 'memory', text: note }
      const line = JSON.stringify(entry) + '\n'
      const prev = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile) : Buffer.alloc(0)
      fs.writeFileSync(ledgerFile, prev.length ? Buffer.concat([prev, Buffer.from(line)]) : Buffer.from(line))
      return { ok: true, remembered: entry }
    }
    if (args.action === 'recall') {
      const q = typeof args.query === 'string' ? args.query : ''
      if (q.trim().length === 0) return { ok: false, error: 'query required' }
      return { ok: true, ...recall(q, Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(20, args.limit)) : 5) }
    }
    return { ok: false, error: 'unknown action' }
  },
}
