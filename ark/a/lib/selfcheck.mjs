// Reader 1's INTERNAL self-check of CONTRACT section 8, used only to generate and test vectors.
// It is NOT the verifier of record. Reader 2 (Go) never reads it.
import { ArkError, P, checkShape, openEnvelope, verifySig, keyid, parseStrict, b64uDecodeStrict, MAX_PAYLOAD } from './core.mjs';

const OWNER_TYPES = ['grant', 'authority', 'approval', 'note'];
const RECV_TYPES = ['outcome', 'note'];
const CLIENT_TYPES = ['proposal', 'note'];

export function checkPins(raw) {
  const p = parseStrict(raw);
  if (!checkShape(p, { v: P.lit('0.1'), owner_key: P.hex64, receiver_key: P.hex64, receiver_id: P.rid, supplied_by: P.str(200) })) throw new ArkError('BAD_PINS');
  if (p.owner_key === p.receiver_key) throw new ArkError('BAD_PINS');
  return p;
}

// CONTRACT C7 (E4): any boolean in a payload, or a null other than outcome.approval / outcome.effect, is BAD_JSON.
function c7Violation(env) {
  let obj;
  try { const b = b64uDecodeStrict(env.payload); if (b.length > MAX_PAYLOAD) return false; obj = parseStrict(b); } catch { return false; }
  const walk = (v, allowNull) => {
    if (v === true || v === false) return true;
    if (v === null) return !allowNull;
    if (Array.isArray(v)) return v.some((x) => walk(x, false));
    if (typeof v === 'object') return Object.keys(v).some((k) => walk(v[k], false));
    return false;
  };
  return Object.keys(obj).some((k) => walk(obj[k], obj.type === 'outcome' && (k === 'approval' || k === 'effect')));
}

export function selfcheck(bundleRaw, pins) {
  const lines = [];
  let b;
  try {
    b = parseStrict(bundleRaw);
    if (!checkShape(b, { v: P.lit('0.1'), coverage: P.str(500), items: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10000 })) throw new ArkError('BAD_BUNDLE');
  } catch {
    lines.push(`pins supplied by: ${pins.supplied_by}`, 'integrity only; freshness and completeness not shown', 'BUNDLE INVALID BAD_BUNDLE');
    return { lines, bundle: { verdict: 'INVALID', reason: 'BAD_BUNDLE' }, ops: {}, exit: 4 };
  }
  lines.push(`coverage: ${b.coverage}`, `pins supplied by: ${pins.supplied_by}`, 'integrity only; freshness and completeness not shown');

  const res = b.items.map(() => null); // null = unresolved, else {ok, reason}
  const opened = b.items.map((env, i) => {
    try { return openEnvelope(env); } catch (e) {
      let reason = e.code || 'BAD_ENVELOPE';
      if (reason === 'BAD_SCHEMA' && c7Violation(env)) reason = 'BAD_JSON';
      res[i] = { verdict: 'INVALID', reason }; return null;
    }
  });
  const kOwner = keyid(pins.owner_key), kRecv = keyid(pins.receiver_key);
  const resolve = (i, pub, types) => {
    const o = opened[i];
    if (!verifySig(o, pub)) res[i] = { verdict: 'INVALID', reason: 'BAD_SIGNATURE' };
    else if (!types.includes(o.type)) res[i] = { verdict: 'INVALID', reason: 'WRONG_SIGNER' };
    else res[i] = { verdict: 'OK', signer: pub };
  };
  opened.forEach((o, i) => {
    if (!o) return;
    if (o.keyid === kOwner) resolve(i, pins.owner_key, OWNER_TYPES);
    else if (o.keyid === kRecv) resolve(i, pins.receiver_key, RECV_TYPES);
  });
  const clientKeys = new Map();
  opened.forEach((o, i) => { if (o && o.type === 'grant' && res[i]?.verdict === 'OK' && res[i].signer === pins.owner_key) clientKeys.set(keyid(o.obj.client_key), o.obj.client_key); });
  opened.forEach((o, i) => {
    if (!o || res[i]) return;
    if (clientKeys.has(o.keyid)) resolve(i, clientKeys.get(o.keyid), CLIENT_TYPES);
    else if (o.type === 'note') res[i] = { verdict: 'OK', signer: null };
    else res[i] = { verdict: 'UNTRUSTED_KEY' };
  });
  const firstInvalid = res.findIndex((r) => r.verdict === 'INVALID');
  const firstUntrusted = res.findIndex((r) => r.verdict === 'UNTRUSTED_KEY');
  if (firstInvalid >= 0) {
    lines.push(`BUNDLE INVALID ${res[firstInvalid].reason} item=${firstInvalid}`);
    return { lines, bundle: { verdict: 'INVALID', reason: res[firstInvalid].reason, item: firstInvalid }, ops: {}, exit: 4 };
  }
  if (firstUntrusted >= 0) {
    lines.push(`BUNDLE UNTRUSTED_KEY item=${firstUntrusted}`);
    return { lines, bundle: { verdict: 'UNTRUSTED_KEY', item: firstUntrusted }, ops: {}, exit: 5 };
  }
  lines.push('BUNDLE OK');

  // unique items by type:hash
  const uniq = new Map();
  opened.forEach((o) => { uniq.set(`${o.type}:${o.hash}`, o); });
  const all = [...uniq.values()];
  const of = (t) => all.filter((o) => o.type === t);
  const find = (t, h) => uniq.get(`${t}:${h}`);
  const ops = new Set([...of('proposal'), ...of('outcome')].map((o) => o.obj.op_id));
  const verdicts = {};
  const verdict = (X) => {
    const outs = of('outcome').filter((o) => o.obj.op_id === X);
    if (outs.length === 0) return ['UNKNOWN'];
    if (outs.length > 1) return ['INVALID', 'CONFLICTING_OUTCOMES'];
    const O = outs[0].obj;
    if (O.receiver_id !== pins.receiver_id) return ['INVALID', 'WRONG_RECEIVER'];
    const Pp = find('proposal', O.proposal);
    if (!Pp || Pp.obj.op_id !== X) return ['INVALID', 'PROPOSAL_MISSING'];
    if ((O.status === 'DONE') !== (O.effect !== null)) return ['INVALID', 'BAD_OUTCOME'];
    if (O.status === 'REFUSED') return ['REFUSED'];
    const Ao = O.approval && find('approval', O.approval);
    if (!Ao) return ['INVALID', 'NO_APPROVAL'];
    const A = Ao.obj;
    if (A.decision !== 'approve') return ['INVALID', 'APPROVAL_NOT_APPROVE'];
    if (A.proposal !== O.proposal) return ['INVALID', 'APPROVAL_MISMATCH'];
    if (A.receiver_id !== pins.receiver_id) return ['INVALID', 'WRONG_RECEIVER'];
    if (A.epoch !== O.epoch) return ['INVALID', 'STALE_EPOCH'];
    if (A.not_after < O.at) return ['INVALID', 'APPROVAL_EXPIRED'];
    const Go = find('grant', Pp.obj.grant);
    if (!Go) return ['INVALID', 'GRANT_MISSING'];
    const G = Go.obj;
    if (G.owner_key !== pins.owner_key) return ['INVALID', 'WRONG_OWNER'];
    if (G.receiver_id !== pins.receiver_id) return ['INVALID', 'WRONG_RECEIVER'];
    if (Pp.keyid !== keyid(G.client_key)) return ['INVALID', 'WRONG_CLIENT'];
    if (G.scope.action !== Pp.obj.action.name || G.scope.resource !== Pp.obj.action.resource) return ['INVALID', 'SCOPE_MISMATCH'];
    if (G.not_after < O.at) return ['INVALID', 'GRANT_EXPIRED'];
    const okAuth = of('authority').some((a) => a.obj.epoch === O.epoch && a.obj.receiver_id === pins.receiver_id
      && a.obj.owner_key === pins.owner_key && a.obj.grants.includes(Pp.obj.grant));
    if (!okAuth) return ['INVALID', 'GRANT_NOT_IN_AUTHORITY'];
    if (O.effect.resource !== Pp.obj.action.resource) return ['INVALID', 'EFFECT_MISMATCH'];
    return ['DONE'];
  };
  let exit = 0;
  for (const X of [...ops].sort()) {
    const [v, r] = verdict(X);
    verdicts[X] = r ? { verdict: v, reason: r } : { verdict: v };
    lines.push(`OP ${X} ${v}${r ? ' ' + r : ''}`);
    if (v === 'INVALID') exit = 4; else if (v === 'UNKNOWN' && exit === 0) exit = 3;
  }
  return { lines, bundle: { verdict: 'OK' }, ops: verdicts, exit };
}
