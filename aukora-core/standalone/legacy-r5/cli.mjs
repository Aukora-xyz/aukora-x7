#!/usr/bin/env node
// AUKORA Core, standalone command line (lab). A record is one folder: record.log (public) and owner.key (private).
//   node cli.mjs init <dir>                      make a LAB owner key and an empty record
//   node cli.mjs say <dir> <text>                append one line
//   node cli.mjs approve-and-act <dir> <audience> <text>   owner signs one exact action; the core admits it once
//   node cli.mjs head <dir>                      print the head
//   node cli.mjs verify <log file>               replay a log in a fresh core; needs no key
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { join } from 'node:path'
import { Core, replay, grantMessage } from './aukora-core.mjs'

const [cmd, target, ...rest] = process.argv.slice(2)
const rawPublic = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32)
const open = dir => {
  const log = readFileSync(join(dir, 'record.log'), 'utf8')
  const lines = log.split('\n').filter(Boolean)
  const core = new Core()
  core.genesis(Buffer.from(JSON.parse(lines[0]).owner, 'hex'))
  for (const hex of lines.slice(1)) if (!core.send(Buffer.from(hex, 'hex'))) throw new Error('stored record does not replay')
  return core
}
const save = (dir, core) => writeFileSync(join(dir, 'record.log'), core.exportLog())

if (cmd === 'init') {
  if (existsSync(join(target, 'record.log'))) throw new Error('a record already exists there')
  mkdirSync(target, { recursive: true })
  const { privateKey } = generateKeyPairSync('ed25519')
  const keyFile = join(target, 'owner.key')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); chmodSync(keyFile, 0o600)
  const core = new Core(); core.genesis(rawPublic(privateKey)); save(target, core)
  console.log('record created; head', core.head().toString('hex'))
} else if (cmd === 'say') {
  const core = open(target); const ok = core.say(rest.join(' ')); if (ok) save(target, core)
  console.log(ok ? 'accepted' : 'REFUSED', 'head', core.head().toString('hex'))
} else if (cmd === 'approve-and-act') {
  const core = open(target); const [audience, ...words] = rest
  const key = createPrivateKey(readFileSync(join(target, 'owner.key')))
  const intent = { payload: words.join(' '), audience, generation: 0, nonce: (core.seq % 65000) + 1 }
  const granted = core.grant(intent, sign(null, grantMessage(intent), key))
  const acted = granted && core.act(intent)
  const again = core.act(intent) // must be refused: one approval, one use
  if (granted) save(target, core)
  console.log(`grant ${granted ? 'accepted' : 'REFUSED'}; act ${acted ? 'accepted' : 'REFUSED'}; same act again ${again ? 'ACCEPTED (BUG)' : 'refused'}; head`, core.head().toString('hex'))
} else if (cmd === 'head') {
  const core = open(target); console.log(core.head().toString('hex'), 'events', core.seq)
} else if (cmd === 'verify') {
  const result = replay(readFileSync(target, 'utf8'))
  console.log(result.ok ? `VALID RECORD: ${result.events} events, head ${result.head}` : `NOT VALID: refused at line ${result.refusedAt}`)
  process.exit(result.ok ? 0 : 1)
} else {
  console.log('usage: init <dir> | say <dir> <text> | approve-and-act <dir> <audience> <text> | head <dir> | verify <log>')
  process.exit(2)
}
