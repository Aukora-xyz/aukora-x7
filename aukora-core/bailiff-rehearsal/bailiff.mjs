// BAILIFF, REHEARSAL (lab only, LAB KEYS). One effect sink that refuses without a current, exact permit from the core.
// It decides nothing itself. It makes three checks and the core makes the judgement:
//   1. CONTINUITY: the stored record replays in a fresh, byte-pinned core and extends the head this sink last acknowledged.
//   2. PERMIT: an act frame, built from the bytes about to be applied, is admitted by the core.
//   3. RECORD WITH THE EFFECT: the new record and head are stored first; only then is the effect made. It fails closed.
// The released adapter (../standalone/aukora.mjs) and its pinned v0.5 small core are used unchanged.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'; import { createHash } from 'node:crypto';
import { Core } from '../standalone/aukora.mjs';
export const AUDIENCE = 'x6.1/promotion/v1';
/** The core file: a pinned release only (the adapter refuses anything else). BAILIFF_CORE names another pinned file. */
export const CORE = process.env.BAILIFF_CORE || undefined;
const sha = b => createHash('sha256').update(b).digest();
/** What the owner approves and what the sink asks for: the digest of the exact patch bytes, then the 32-byte base it applies to. */
export const intentFor = (patch, base, { generation = 0, nonce }) => ({ payload: Buffer.concat([sha(patch), base]), audience: AUDIENCE, generation, nonce });
const refuse = (reason, detail = '') => ({ applied: false, reason, detail });
const put = (file, data) => { writeFileSync(file + '.tmp', data); renameSync(file + '.tmp', file); };

export class Bailiff {
  constructor(dir) { this.dir = dir; mkdirSync(dir + '/tree', { recursive: true }); this.recordFile = dir + '/record.txt'; this.ackFile = dir + '/acknowledged.json'; }
  /** Take a record the owner's tool produced (it holds the approvals). The sink keeps the copy it will be judged against. */
  async accept(recordText) { const r = await this.#continuity(recordText); if (!r.ok) return refuse(r.reason, r.detail);
    put(this.recordFile, recordText); put(this.ackFile, JSON.stringify({ lines: r.core.frames.length, head: r.core.headHex() })); return { accepted: true, lines: r.core.frames.length, head: r.core.headHex() }; }
  /** Check 1. The record must replay, and its first `lines` lines must end at the acknowledged head. */
  async #continuity(text) {
    const ack = existsSync(this.ackFile) ? JSON.parse(readFileSync(this.ackFile, 'utf8')) : null; const lines = text.trim().split('\n');
    if (ack) { if (lines.length - 2 < ack.lines) return { ok: false, reason: 'RECORD_SHORTER', detail: `the record has ${lines.length - 2} lines; this sink acknowledged ${ack.lines}` };
      const early = await Core.load(CORE); let head; try { head = await early.replay(lines.slice(0, 2 + ack.lines).join('\n')); } catch (e) { return { ok: false, reason: 'RECORD_DOES_NOT_REPLAY', detail: String(e.message) }; }
      if (head !== ack.head) return { ok: false, reason: 'RECORD_REWRITTEN', detail: 'the part this sink acknowledged is not what it saw' }; }
    const core = await Core.load(CORE); try { await core.replay(text); } catch (e) { return { ok: false, reason: 'RECORD_DOES_NOT_REPLAY', detail: String(e.message) }; }
    return { ok: true, core }; }
  /** THE ONE SINK. Apply `patch` on `base` only if the core admits the act for exactly these bytes. */
  async promote(patch, base, { generation = 0, nonce }) {
    if (!existsSync(this.recordFile)) return refuse('NO_RECORD');
    const r = await this.#continuity(readFileSync(this.recordFile, 'utf8')); if (!r.ok) return refuse(r.reason, r.detail);      // 1
    const core = r.core, intent = intentFor(patch, base, { generation, nonce });
    if (!core.act(intent)) return refuse('NO_CURRENT_EXACT_PERMIT', 'the core refused the act for these exact bytes');            // 2
    put(this.recordFile, core.exportRecord()); put(this.ackFile, JSON.stringify({ lines: core.frames.length, head: core.headHex() })); // 3: record first
    const name = sha(patch).toString('hex'); writeFileSync(`${this.dir}/tree/${name}`, patch);                                   //    then the effect
    return { applied: true, file: name, head: core.headHex(), line: core.frames.length };
  }
}
