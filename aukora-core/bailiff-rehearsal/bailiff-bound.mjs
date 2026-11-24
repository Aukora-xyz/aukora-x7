// BAILIFF ON A BOUND RECORD, REHEARSAL (lab only, LAB KEYS, lab cores). The same three checks as bailiff.mjs, plus one:
//   0. IDENTITY: the record is THE record this sink was set up for. Its identifier is pinned at the first acceptance and
//      every later record must replay to that identifier. A twin record of the same owner is refused.
// Uses the next-line adapter (../standalone-next/aukora.mjs) and a core with the bound start. Such cores are not released
// pins, so the core file is named by BAILIFF_CORE and its digest must be in LAB_CORES below.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'; import { createHash } from 'node:crypto';
import { Core } from '../standalone-next/aukora.mjs';
export const AUDIENCE = 'x6.1/promotion/v1';
export const LAB_CORES = { '61e02592287d31ef8ad2ba13b15a46deff7edfd0de0c8866fe245a641abd2419': 'v0.9 small', '2c166cce41a922e5001a7c211285cd03908e0f5d86e27b1e1d1dfbfac505bd14': 'v0.9 full', 'c924c72aec0214b59f1f9405ac2c7467b86e2d96985540570ad1896db3c25d93': 'v0.10 small (built once)', '1d642eac3fd35032d8cf71e2ad015486eae4d866ff34e6e6cf715d60bcd0695f': 'v0.10 full (built once)', '2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9': 'v0.8 small', 'd0d3bfe5f9111419ff4fc98dfc3dc894252d106efe630e0dfce5a2ba4bddf84b': 'v0.8 full',
  '61e02592287d31ef8ad2ba13b15a46deff7edfd0de0c8866fe245a641abd2419': 'v0.9 small', '2c166cce41a922e5001a7c211285cd03908e0f5d86e27b1e1d1dfbfac505bd14': 'v0.9 full' };
export const CORE = process.env.BAILIFF_CORE;
const sha = b => createHash('sha256').update(b).digest();
export const load = async () => { if (!CORE) throw new Error('BAILIFF_CORE must name a core file with the bound start'); const d = sha(readFileSync(CORE)).toString('hex');
  if (!(d in LAB_CORES) && !process.env.BAILIFF_ALLOW) throw new Error('core file is not one of the lab cores this rehearsal names: ' + d); return Core.load(CORE, { allowUnpinned: true }); };
export const intentFor = (patch, base, { generation = 0, nonce }) => ({ payload: Buffer.concat([sha(patch), base]), audience: AUDIENCE, generation, nonce });
const refuse = (reason, detail = '') => ({ applied: false, accepted: false, reason, detail }); const put = (f, d) => { writeFileSync(f + '.tmp', d); renameSync(f + '.tmp', f); };

export class BoundBailiff {
  constructor(dir) { this.dir = dir; mkdirSync(dir + '/tree', { recursive: true }); this.recordFile = dir + '/record.txt'; this.ackFile = dir + '/acknowledged.json'; }
  #ack() { return existsSync(this.ackFile) ? JSON.parse(readFileSync(this.ackFile, 'utf8')) : null; }
  async #check(text) { const ack = this.#ack(), lines = text.trim().split('\n');
    if (lines[0] !== 'aukora-record v0.2 bound') return { ok: false, reason: 'RECORD_NOT_BOUND', detail: 'this sink takes bound records only' };
    const opts = ack ? { expectId: ack.id } : {};
    if (ack) { if (lines.length - 3 < ack.lines) return { ok: false, reason: 'RECORD_SHORTER', detail: `the record has ${lines.length - 3} lines; this sink acknowledged ${ack.lines}` };
      const early = await load(); let head; try { head = await early.replay(lines.slice(0, 3 + ack.lines).join('\n'), opts); } catch (e) { return { ok: false, reason: /different record/.test(e.message) ? 'RECORD_NOT_THIS_ONE' : 'RECORD_DOES_NOT_REPLAY', detail: String(e.message) }; }
      if (head !== ack.head) return { ok: false, reason: 'RECORD_REWRITTEN', detail: 'the part this sink acknowledged is not what it saw' }; }
    const core = await load(); try { await core.replay(text, opts); } catch (e) { return { ok: false, reason: /different record/.test(e.message) ? 'RECORD_NOT_THIS_ONE' : 'RECORD_DOES_NOT_REPLAY', detail: String(e.message) }; }
    return { ok: true, core }; }
  #store(core) { put(this.recordFile, core.exportRecord()); put(this.ackFile, JSON.stringify({ id: core.recordId(), lines: core.frames.length, head: core.headHex() })); }
  async accept(recordText) { const r = await this.#check(recordText); if (!r.ok) return refuse(r.reason, r.detail); this.#store(r.core); return { accepted: true, id: r.core.recordId(), lines: r.core.frames.length }; }
  async promote(patch, base, { generation = 0, nonce }) {
    if (!existsSync(this.recordFile)) return refuse('NO_RECORD');
    const r = await this.#check(readFileSync(this.recordFile, 'utf8')); if (!r.ok) return refuse(r.reason, r.detail);
    if (!r.core.act(intentFor(patch, base, { generation, nonce }))) return refuse('NO_CURRENT_EXACT_PERMIT', 'the core refused the act for these exact bytes');
    this.#store(r.core); const name = sha(patch).toString('hex'); writeFileSync(`${this.dir}/tree/${name}`, patch);
    return { applied: true, file: name, head: r.core.headHex(), line: r.core.frames.length };
  }
}
