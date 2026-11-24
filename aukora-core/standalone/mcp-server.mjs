#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0) giving ANY agent a record it cannot rewrite and acts it cannot self-approve.
// The server never reads owner.key: approval happens only when the owner runs `aukora approve`.
// Start: node mcp-server.mjs <record dir>
import { createInterface } from 'node:readline';
import * as S from './store.mjs';
const dir = process.argv[2]; if (!dir) { console.error('usage: mcp-server.mjs <record dir>'); process.exit(64); }
const tools = [
  { name: 'aukora_say', description: 'Record a statement in the append-only record. Carries no authority.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'aukora_propose', description: 'Propose an act for the owner to approve. Returns an id. Nothing runs yet.', inputSchema: { type: 'object', properties: { audience: { type: 'string' }, payload: { type: 'string' } }, required: ['audience', 'payload'] } },
  { name: 'aukora_act', description: 'Ask the core to admit a proposed act. Admitted only if the owner approved exactly this proposal and it has not been used. Do the real action ONLY if this returns admitted:true.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'aukora_outcome', description: 'Record what happened to an admitted act: confirmed, failed or unknown.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, result: { enum: ['confirmed', 'failed', 'unknown'] } }, required: ['id', 'result'] } },
  { name: 'aukora_head', description: 'The current head (fingerprint) of the record, line count and core file digest.', inputSchema: { type: 'object', properties: {} } },
];
async function call(name, a) {
  const c = await S.open(dir);                       // every call replays the whole record: a changed line stops everything
  if (name === 'aukora_say') { const ok = c.say(a.text); S.save(dir, c); return { admitted: ok, head: c.headHex() }; }
  if (name === 'aukora_propose') { const id = S.propose(dir, c, a.payload, a.audience); return { id, state: 'proposed', next: `the owner must run: aukora approve ${dir} ${id}` }; }
  if (name === 'aukora_act') { const m = S.intents(dir), i = m[a.id]; if (!i) return { admitted: false, reason: 'no such proposal' }; const ok = c.act(i); if (ok) { i.state = 'acted'; S.saveIntents(dir, m); } S.save(dir, c); return { admitted: ok, head: c.headHex(), ...(ok ? {} : { reason: 'the core refused: not approved by the owner, already used, cancelled or expired' }) }; }
  if (name === 'aukora_outcome') { const i = S.intents(dir)[a.id]; const ok = c.outcome(i, a.result) || c.correctOutcome(i, a.result); S.save(dir, c); return { admitted: ok, head: c.headHex() }; }
  if (name === 'aukora_head') return { head: c.headHex(), lines: c.frames.length, core: c.coreDigest };
  throw new Error('unknown tool ' + name);
}
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aukora-core', version: '0.1.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') { try { const r = await call(m.params.name, m.params.arguments ?? {}); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } }); } catch (e) { send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: e.message }] } }); } }
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}
