// ARK proof v0.1 client A and emitter (reader 1 (Node)). TEST key only. Never signs grants, approvals or outcomes.
import fs from 'node:fs';
import path from 'node:path';
import {
  ArkError, EXIT, P, openEnvelope, seal, newTestKey, saveKey, loadKey, parseArgs, need, runMain, parseStrict,
  randHex, writeFileAtomic, nowMs, checkShape,
} from './lib/core.mjs';
import { writeRequest, readAnswer, waitAnswer, newRequestId, writeOutFile } from './lib/wire.mjs';

const out = (s) => process.stdout.write(s + '\n');
const readJson = (f) => parseStrict(fs.readFileSync(path.resolve(f)));
const TYPE_ORDER = ['grant', 'authority', 'proposal', 'approval', 'note', 'outcome'];

// The client's record: every envelope it made, sent or received, by item hash.
function keep(home, env) {
  const o = openEnvelope(env);
  writeFileAtomic(path.join(home, 'items', `${o.type}-${o.hash}.env.json`), JSON.stringify(env));
  return o;
}
function keepAnswer(home, a) {
  if (a.outcome) keep(home, a.outcome);
  if (a.authority) keep(home, a.authority);
}
const exitFor = (status) => ({ DONE: EXIT.OK, ACCEPTED: EXIT.OK, REFUSED: EXIT.REFUSED, UNKNOWN: EXIT.UNKNOWN, REJECTED: EXIT.REJECTED }[status] ?? EXIT.USAGE);

async function sendAndWait(home, R, id, req, wait) {
  writeRequest(R, id, req);
  if (wait === 0) { out(`SENT ${id}`); return EXIT.UNKNOWN; }
  const a = await waitAnswer(R, id, wait);
  if (!a) { out(`UNKNOWN NO_ANSWER ${id}`); return EXIT.UNKNOWN; }
  keepAnswer(home, a);
  out(`${a.status} ${a.reason} ${id}`);
  return exitFor(a.status);
}

runMain(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest, ['note']);
  const home = path.resolve(need(flags, 'home'));
  if (cmd === 'init') {
    if (fs.existsSync(path.join(home, 'key.json'))) throw new ArkError('USAGE', 'already initialised');
    const k = newTestKey(); fs.mkdirSync(path.join(home, 'items'), { recursive: true }); saveKey(path.join(home, 'key.json'), k);
    out(`client_key ${k.pubHex}`); return EXIT.OK;
  }
  const key = loadKey(path.join(home, 'key.json'));
  const wait = Number(flags['wait-ms'] ?? 10000);
  switch (cmd) {
    case 'pubkey': out(`client_key ${key.pubHex}`); return EXIT.OK;
    case 'propose': {
      const g = keep(home, readJson(need(flags, 'grant')));
      if (g.type !== 'grant') throw new ArkError('USAGE', 'not a grant');
      const obj = { v: '0.1', type: 'proposal', op_id: flags['op-id'] || randHex(16), grant: g.hash,
        action: { name: flags.action || g.obj.scope.action, resource: flags.resource || g.obj.scope.resource, text: need(flags, 'text') },
        created_at: nowMs() };
      const env = seal(obj, key); writeOutFile(need(flags, 'out'), env);
      const o = keep(home, env);
      out(`op_id ${obj.op_id} proposal ${o.hash}`); return EXIT.OK;
    }
    case 'send': {
      const R = path.resolve(need(flags, 'receiver-home'));
      const grant = readJson(need(flags, 'grant')); const proposal = readJson(need(flags, 'proposal'));
      const approval = flags.approval ? readJson(flags.approval) : null;
      const notes = (flags.note || []).map(readJson);
      for (const e of [grant, proposal, ...(approval ? [approval] : []), ...notes]) keep(home, e);
      const op = openEnvelope(proposal).obj.op_id;
      const id = flags['request-id'] || newRequestId(op);
      return sendAndWait(home, R, id, { v: '0.1', kind: 'submit', grant, proposal, approval, notes }, wait);
    }
    case 'status': {
      const R = path.resolve(need(flags, 'receiver-home'));
      const op = need(flags, 'op-id'); if (!P.hex32(op)) throw new ArkError('USAGE', 'bad op id');
      return sendAndWait(home, R, flags['request-id'] || newRequestId(`status-${op}`), { v: '0.1', kind: 'status', op_id: op }, wait);
    }
    case 'collect': {
      const R = path.resolve(need(flags, 'receiver-home')); const id = need(flags, 'request-id');
      const a = readAnswer(R, id);
      if (!a) { out(`UNKNOWN NO_ANSWER ${id}`); return EXIT.UNKNOWN; }
      keepAnswer(home, a); out(`${a.status} ${a.reason} ${id}`); return exitFor(a.status);
    }
    case 'note': {
      const obj = { v: '0.1', type: 'note', about: need(flags, 'about'), label: need(flags, 'label'), grants: 'none', text: need(flags, 'text') };
      const env = seal(obj, key); writeOutFile(need(flags, 'out'), env);
      out(`note ${keep(home, env).hash}`); return EXIT.OK;
    }
    case 'keep': {
      let n = 0;
      for (const f of pos) {
        const j = readJson(f);
        const items = checkShape(j, { v: P.lit('0.1'), coverage: (v) => typeof v === 'string', items: Array.isArray }) ? j.items : [j];
        for (const e of items) { keep(home, e); n++; }
      }
      out(`kept ${n}`); return EXIT.OK;
    }
    case 'export': {
      const rid = need(flags, 'receiver-id'); if (!P.rid(rid)) throw new ArkError('USAGE', 'bad receiver id');
      const dir = path.join(home, 'items');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.env.json')) : [];
      files.sort((a, b) => (TYPE_ORDER.indexOf(a.split('-')[0]) - TYPE_ORDER.indexOf(b.split('-')[0])) || (a < b ? -1 : a > b ? 1 : 0));
      const items = files.map((f) => parseStrict(fs.readFileSync(path.join(dir, f))));
      const bundle = { v: '0.1', coverage: `This bundle covers only actions mediated by receiver ${rid}: appending one line to notes/demo.txt. Nothing else the client or its agent did is covered.`, items };
      writeOutFile(need(flags, 'out'), bundle);
      out(`exported ${items.length} items`); return EXIT.OK;
    }
    default: throw new ArkError('USAGE', `unknown command ${cmd}`);
  }
});
