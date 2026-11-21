// Request / answer files (CONTRACT section 9). Shared by client-a and owner.
import fs from 'node:fs';
import path from 'node:path';
import { parseStrict, writeFileAtomic, randHex, ArkError } from './core.mjs';

export const REQ_ID = /^[a-z0-9-]{1,80}$/;

export function writeRequest(receiverHome, requestId, reqObj) {
  if (!REQ_ID.test(requestId)) throw new ArkError('USAGE', 'bad request id');
  const inbox = path.join(receiverHome, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const final = path.join(inbox, `${requestId}.req.json`);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reqObj));
  fs.renameSync(tmp, final);
  return requestId;
}

export function readAnswer(receiverHome, requestId) {
  const f = path.join(receiverHome, 'outbox', `${requestId}.ans.json`);
  if (!fs.existsSync(f)) return null;
  return parseStrict(fs.readFileSync(f));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitAnswer(receiverHome, requestId, waitMs) {
  const end = Date.now() + waitMs;
  for (;;) {
    const a = readAnswer(receiverHome, requestId);
    if (a) return a;
    if (Date.now() >= end) return null;
    await sleep(25);
  }
}

export const newRequestId = (prefix) => `${prefix}-${randHex(6)}`;

export function writeOutFile(file, obj) { writeFileAtomic(path.resolve(file), JSON.stringify(obj) + '\n'); }
