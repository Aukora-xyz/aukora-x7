// Mythos, 23 Nov: how far does seal-and-continue really go? Fill a record to its ordinary limit, seal, continue,
// again and again in ONE running instance; watch memory and step time; then replay the whole chain in a fresh
// instance. Usage: node mythos-long-chain.mjs <wasm> <segments> [payload bytes per line]
import { readFileSync } from 'node:fs';
import { cat, host, owner, text, sha } from '../../v0.5/tests/host.mjs';
import { bytes32, rawKeys, signedSeal, genesisFor } from '../../v0.5/tests/segments.mjs';
const [file, segmentsArg, sizeArg] = process.argv.slice(2); const SEGMENTS = Number(segmentsArg || 20), SIZE = Number(sizeArg || 24);
const image = readFileSync(file); const keys = owner(), pub = rawKeys(keys);
const quiet = f => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const mem = () => process.memoryUsage().rss / 1048576;   // the core exports no memory handle; whole-process resident size is the only outside view
const h = host(image); if (h.consume(pub, 'init') !== 1) throw new Error('init refused');
const ops = []; let lines = 0, stoppedAt = null, why = '', lastWire = null;
const line = (s, n) => cat(Buffer.of(0), text(`s${s} n${n} `.padEnd(SIZE, '.')));
const t0 = performance.now();
try {
  for (let s = 0; s < SEGMENTS; s++) {
    let n = 0, slowest = 0; const started = performance.now();
    for (; n < 512; n++) { const wire = h.unsigned(line(s, n)); lastWire = wire; const ms = quiet(() => h.submit('fill', wire, true)); ops.push(['step', wire]); if (ms > slowest) slowest = ms; }
    lines += n;
    const extra = h.unsigned(line(s, 'extra')); const over = h.consume(extra, 'step');                 // line 513 of this segment
    const head = bytes32(h.api.head);
    const trailer = signedSeal(h, keys); if (h.consume(trailer, 'seal') !== 1) { stoppedAt = s; why = 'seal refused'; break; } ops.push(['seal', trailer]);
    const closedSpeech = h.consume(h.unsigned(line(s, 'closed')), 'step');                          // a sealed record admits nothing
    const genesis = genesisFor(h, keys, trailer); if (h.consume(genesis, 'continueRecord') !== 1) { stoppedAt = s; why = 'continuation refused'; break; } h.acceptGenesis(genesis); ops.push(['continueRecord', genesis]);
    if (over !== 0 || closedSpeech !== 0) { stoppedAt = s; why = `limit not held: line 513 gave ${over}, speech in a sealed record gave ${closedSpeech}`; break; }
    if (s < 3 || (s + 1) % 5 === 0 || s === SEGMENTS - 1) console.log(`segment ${s + 1}: 512 lines admitted, line 513 refused, sealed, continued | process ${mem().toFixed(0)} MiB | segment ${((performance.now() - started) / 1000).toFixed(2)} s, slowest step ${slowest.toFixed(2)} ms | head before seal ${head.toString('hex').slice(0, 12)}…`);
  }
} catch (e) { stoppedAt = 'exception'; why = String(e && e.message || e).slice(0, 200); }
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(stoppedAt === null ? `RAN ${SEGMENTS} segments, ${lines} lines, ${secs} s, process ${mem().toFixed(0)} MiB, no refusal of a valid seal or continuation, no trap` : `STOPPED at segment ${stoppedAt}: ${why} (${lines} lines, ${secs} s, process ${mem().toFixed(0)} MiB)`);
// Fresh instance: replay every accepted operation; the head and the journal must match.
const g = host(image); if (g.consume(pub, 'init') !== 1) throw new Error('init refused'); let bad = -1; const t1 = performance.now();
for (let i = 0; i < ops.length && bad < 0; i++) if (g.consume(ops[i][1], ops[i][0]) !== 1) bad = i;
const same = bad < 0 && bytes32(g.api.head).equals(bytes32(h.api.head)) && bytes32(g.api.journalByte).equals(bytes32(h.api.journalByte));
console.log(`fresh-instance replay of ${ops.length} operations: ${bad < 0 ? 'all admitted' : 'REFUSED at operation ' + bad}; same head and journal: ${same}; ${((performance.now() - t1) / 1000).toFixed(1)} s; process ${mem().toFixed(0)} MiB`);
if (stoppedAt === 'exception') {
  // Is the stop deterministic, and what is left of an instance after it?
  const probe = (name, f) => { try { return `${name}: ${f()}`; } catch (e) { return `${name}: TRAP (${String(e.message).slice(0, 40)})`; } };
  console.log('the line that stopped the first instance, given to the fresh instance after its replay ->', probe('step', () => g.consume(lastWire, 'step')));
  console.log('the first instance after its stop ->', probe('read head', () => bytes32(h.api.head).toString('hex').slice(0, 12) + '…'), '|', probe('same line again', () => h.consume(lastWire, 'step')), '|', probe('owner seal', () => h.consume(signedSeal(h, keys), 'seal')));
  console.log(`accepted before the stop: ${ops.filter(o => o[0] === 'step').length} lines in ${ops.filter(o => o[0] === 'seal').length} sealed segments plus the open one; bytes of accepted frames ${(ops.reduce((a, o) => a + o[1].length, 0) / 1048576).toFixed(1)} MiB`);
}
// One changed byte in the very first line of the chain: where does a fresh instance notice?
const forged = ops.map(o => [o[0], Buffer.from(o[1])]); forged[0][1][forged[0][1].length - 1] ^= 1; const f = host(image); f.consume(pub, 'init'); let first = -1;
for (let i = 0; i < forged.length && first < 0; i++) if (f.consume(forged[i][1], forged[i][0]) !== 1) first = i;
console.log(`one changed byte in line 1 of segment 1: first refusal at operation ${first} (${first < 0 ? 'NEVER: the change went unnoticed' : forged[first][0]})`);
process.exit(stoppedAt === null && same && first >= 0 ? 0 : 1);
