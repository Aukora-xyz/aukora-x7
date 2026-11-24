// ARK proof v0.1 stand-in owner tool (reader 1 (Node)). TEST key only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ArkError, EXIT, P, openEnvelope, seal, newTestKey, saveKey, loadKey, parseArgs, need, runMain, parseTime,
  parseStrict, randHex, writeFileAtomic,
} from './lib/core.mjs';
import { writeRequest, waitAnswer, newRequestId, writeOutFile } from './lib/wire.mjs';

const out = (s) => process.stdout.write(s + '\n');
const readEnv = (f) => parseStrict(fs.readFileSync(path.resolve(f)));

async function askYes(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => { rl.question(q, r); rl.once('close', () => r('')); });
  rl.close();
  return /^y(es)?$/i.test(String(ans).trim());
}

runMain(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest, ['grant']);
  if (cmd === 'init') {
    const home = path.resolve(need(flags, 'home'));
    if (fs.existsSync(path.join(home, 'key.json'))) throw new ArkError('USAGE', 'already initialised');
    const k = newTestKey(); fs.mkdirSync(home, { recursive: true }); saveKey(path.join(home, 'key.json'), k);
    out(`owner_key ${k.pubHex}`); return EXIT.OK;
  }
  const key = loadKey(path.join(path.resolve(need(flags, 'home')), 'key.json'));
  switch (cmd) {
    case 'pubkey': out(`owner_key ${key.pubHex}`); return EXIT.OK;
    case 'grant': {
      const obj = { v: '0.1', type: 'grant', grant_id: randHex(16), owner_key: key.pubHex, client_key: need(flags, 'client-key'),
        receiver_id: need(flags, 'receiver-id'), scope: { action: need(flags, 'action'), resource: need(flags, 'resource') },
        not_after: parseTime(need(flags, 'not-after')) };
      const env = seal(obj, key); writeOutFile(need(flags, 'out'), env);
      out(`grant ${openEnvelope(env).hash}`); return EXIT.OK;
    }
    case 'authority': {
      const grants = (flags.grant || []).map((f) => {
        const o = openEnvelope(readEnv(f));
        if (o.type !== 'grant') throw new ArkError('USAGE', `${f} is not a grant`);
        return o.hash;
      });
      const obj = { v: '0.1', type: 'authority', owner_key: key.pubHex, receiver_id: need(flags, 'receiver-id'),
        epoch: Number(need(flags, 'epoch')), grants };
      const env = seal(obj, key); writeOutFile(need(flags, 'out'), env);
      out(`authority ${openEnvelope(env).hash}`); return EXIT.OK;
    }
    case 'approve': {
      // Read the proposal BYTES and show what they say before signing anything.
      const p = openEnvelope(readEnv(need(flags, 'proposal')));
      if (p.type !== 'proposal') throw new ArkError('USAGE', 'not a proposal');
      const decision = flags.decision || 'approve';
      if (!['approve', 'refuse'].includes(decision)) throw new ArkError('USAGE', 'bad --decision');
      out('APPROVAL REQUEST (read from the proposal bytes, not from the client)');
      out(`  proposal: ${p.hash}`);
      out(`  op_id:    ${p.obj.op_id}`);
      out(`  action:   ${p.obj.action.name}`);
      out(`  resource: ${p.obj.action.resource}`);
      out(`  text:     ${JSON.stringify(p.obj.action.text)}`);
      out(`  receiver: ${need(flags, 'receiver-id')}  epoch: ${need(flags, 'epoch')}  decision: ${decision}`);
      if (!flags.yes && !(await askYes('Sign this approval? [y/N] '))) { out('NOT SIGNED'); return EXIT.REFUSED; }
      const obj = { v: '0.1', type: 'approval', proposal: p.hash, receiver_id: need(flags, 'receiver-id'),
        epoch: Number(need(flags, 'epoch')), decision, not_after: parseTime(need(flags, 'not-after')) };
      const env = seal(obj, key); writeOutFile(need(flags, 'out'), env);
      out(`approval ${openEnvelope(env).hash}`); return EXIT.OK;
    }
    case 'deliver': {
      const R = path.resolve(need(flags, 'receiver-home'));
      const env = readEnv(need(flags, 'authority'));
      const id = flags['request-id'] || newRequestId('auth');
      writeRequest(R, id, { v: '0.1', kind: 'authority', authority: env });
      const wait = Number(flags['wait-ms'] ?? 10000);
      if (wait === 0) { out(`SENT ${id}`); return EXIT.UNKNOWN; }
      const a = await waitAnswer(R, id, wait);
      if (!a) { out(`UNKNOWN NO_ANSWER ${id}`); return EXIT.UNKNOWN; }
      out(`${a.status} ${a.reason} ${id}`);
      return a.status === 'ACCEPTED' ? EXIT.OK : EXIT.REJECTED;
    }
    default: throw new ArkError('USAGE', `unknown command ${cmd}`);
  }
});
