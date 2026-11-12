'use strict'
// seed-wish — the wish/acceptance surface of the seed. Local files, no model, no network.
const fs = require('fs')
const path = require('path')
const ROOT = '/dsh/home/auma/seed'
const FILE = path.join(ROOT, 'WISH.md')
module.exports = {
  name: 'seed-wish',
  description: 'Read or replace the seed wish and its acceptance. Local only.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'write', 'status'] }, wish: { type: 'string' }, acceptance: { type: 'string' } }, required: ['action'] },
  run(args) {
    if (args.action === 'read' || args.action === 'status') {
      const text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : ''
      return { ok: true, exists: fs.existsSync(FILE), bytes: Buffer.byteLength(text), lines: text.split('\n').length, text: args.action === 'read' ? text : undefined, file: FILE }
    }
    if (args.action === 'write') {
      const wish = typeof args.wish === 'string' ? args.wish.trim() : ''
      const acceptance = typeof args.acceptance === 'string' ? args.acceptance.trim() : ''
      if (!wish) return { ok: false, error: 'wish required' }
      if (!acceptance) return { ok: false, error: 'acceptance required' }
      const text = '# Wish\n\n' + wish + '\n\n## Acceptance\n\n' + acceptance + '\n'
      fs.mkdirSync(ROOT, { recursive: true })
      fs.writeFileSync(FILE, text)
      return { ok: true, file: FILE, bytes: Buffer.byteLength(text), sha256: require('crypto').createHash('sha256').update(text).digest('hex') }
    }
    return { ok: false, error: 'unknown action' }
  },
}
