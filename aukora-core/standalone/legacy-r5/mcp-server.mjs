#!/usr/bin/env node
// AUKORA Core as an MCP server over stdio (lab). Any agent host that speaks MCP can attach and keep a checkable
// record of what it did. The server decides nothing: the Wasm core accepts or refuses.
//   node mcp-server.mjs <record dir>      (make the record first with: node cli.mjs init <record dir>)
// Tools: aukora_say (append a line), aukora_head (read the head), aukora_verify (replay the whole record).
// It never signs anything: approvals need the owner's key, which an agent host must not hold.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Core, replay } from './aukora-core.mjs'

const dir = process.argv[2]
if (!dir) { console.error('usage: node mcp-server.mjs <record dir>'); process.exit(2) }
const file = join(dir, 'record.log')
const open = () => {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const core = new Core(); core.genesis(Buffer.from(JSON.parse(lines[0]).owner, 'hex'))
  for (const hex of lines.slice(1)) if (!core.send(Buffer.from(hex, 'hex'))) throw new Error('stored record does not replay')
  return core
}
const tools = [
  { name: 'aukora_say', description: 'Append one line to the record (for example what you just did, tagged RAN or REPORTED). Returns the new head. Cannot change any authority.',
    inputSchema: { type: 'object', properties: { line: { type: 'string', maxLength: 4000 } }, required: ['line'], additionalProperties: false } },
  { name: 'aukora_head', description: 'Read the current head (a 64-hex fingerprint of the whole record) and the number of events.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'aukora_verify', description: 'Replay the whole record in a fresh core and say whether it is valid.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]
const call = (name, args) => {
  if (name === 'aukora_say') {
    const core = open(); const ok = core.say(String(args?.line ?? '')); if (ok) writeFileSync(file, core.exportLog())
    return { accepted: ok, head: core.head().toString('hex'), events: core.seq }
  }
  if (name === 'aukora_head') { const core = open(); return { head: core.head().toString('hex'), events: core.seq } }
  if (name === 'aukora_verify') return replay(readFileSync(file, 'utf8'))
  throw new Error('unknown tool')
}
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // a notification
  try {
    if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aukora-core-lab', version: '0.0.1' } })
    if (msg.method === 'tools/list') return reply(msg.id, { tools })
    if (msg.method === 'tools/call') return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(call(msg.params?.name, msg.params?.arguments)) }] })
    if (msg.method === 'ping') return reply(msg.id, {})
    fail(msg.id, 'method not supported')
  } catch (error) { fail(msg.id, String(error?.message ?? error)) }
})
