import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Core } from '../../standalone/aukora.mjs';

export function profileId(profileText) {
  return createHash('sha256').update(profileText, 'utf8').digest('hex');
}

export const PROFILES = Object.freeze([
  '{"name":"prefix/1","relation":"prefix","reflexive":true,"transitivity":"definition-derived"}',
  '{"name":"at-most/1","relation":"at-most","reflexive":true,"transitivity":"definition-derived"}',
  '{"name":"strict-prefix/1","relation":"prefix","reflexive":false,"transitivity":"asserted"}',
  '{"name":"none/1","relation":"none","reflexive":false,"transitivity":"asserted"}',
]);

function heldProfile(id, held) {
  const text = held.get(id);
  if (typeof text !== 'string' || profileId(text) !== id) return null;
  try {
    const profile = JSON.parse(text);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
        typeof profile.name !== 'string' || typeof profile.relation !== 'string' ||
        typeof profile.reflexive !== 'boolean' || typeof profile.transitivity !== 'string') return null;
    return profile;
  } catch {
    return null;
  }
}

const verdict = (result, reason = null) => ({ result, reason });
const integer = value => Number.isInteger(value) && value >= 0;

export function compare(profileIdHex, held, received, emitted) {
  if (!held.has(profileIdHex)) return verdict('UNDECIDED', 'PROFILE_NOT_HELD');
  const profile = heldProfile(profileIdHex, held);
  if (profile?.relation === 'none') return verdict('UNDECIDED', 'NO_COMPARISON_RELATION');
  if (!profile) return verdict('UNDECIDED');

  let noBroader;
  if (profile.relation === 'prefix') {
    if (typeof received !== 'string' || typeof emitted !== 'string') {
      return verdict('UNDECIDED', 'VALUE_NOT_COMPARABLE');
    }
    noBroader = (profile.reflexive && emitted === received) || emitted.startsWith(received + '/');
  } else if (profile.relation === 'at-most') {
    if (!integer(received) || !integer(emitted)) {
      return verdict('UNDECIDED', 'VALUE_NOT_COMPARABLE');
    }
    noBroader = profile.reflexive ? emitted <= received : emitted < received;
  } else {
    return verdict('UNDECIDED');
  }
  return verdict(noBroader ? 'NO_BROADER' : 'BROADER');
}

export function evaluateChain(hops, held) {
  const decide = (established, cause = null, at = null) => ({ established, cause, at });
  if (hops.length === 0) return decide(true, 'EMPTY_CHAIN_AUTHORIZES_NOTHING');

  const comparisons = hops.map(({ profile, received, emitted }) => compare(profile, held, received, emitted));
  const undecided = comparisons.findIndex(({ result }) => result === 'UNDECIDED');
  if (undecided !== -1) return decide(false, 'HOP_UNDECIDED:' + comparisons[undecided].reason, undecided);
  const broader = comparisons.findIndex(({ result }) => result === 'BROADER');
  if (broader !== -1) return decide(false, 'HOP_BROADER', broader);

  if (hops.length > 1) {
    const id = hops[0].profile;
    const changed = hops.findIndex(({ profile }) => profile !== id);
    if (changed !== -1) return decide(false, 'PROFILE_DIFFERS', changed);
    for (let i = 0; i + 1 < hops.length; i++) {
      if (hops[i].emitted !== hops[i + 1].received) return decide(false, 'VALUE_NOT_SHARED', i);
    }
    const basis = heldProfile(id, held)?.transitivity;
    if (basis !== 'definition-derived' && basis !== 'mechanically-checkable') {
      return decide(false, 'BASIS_ASSERTED');
    }
  }
  return decide(true);
}

const chainDigest = hops => createHash('sha256').update(JSON.stringify(hops), 'utf8').digest('hex');

export function receipt(hops, held) {
  return {
    v: 'delegation-receipt/1',
    profile: hops[0]?.profile ?? null,
    hops,
    ...evaluateChain(hops, held),
    chain: chainDigest(hops),
  };
}

export function record(core, hops, held) {
  const entry = receipt(hops, held);
  if (core.say(JSON.stringify(entry)) !== true) throw new Error('core refused receipt speech');
  return entry;
}

function speechReceipt(frame) {
  // Outer tag | 32-byte parent | u64le sequence | speech tag | u16le size | UTF-8.
  if (frame.length < 44 || frame[0] !== 0 || frame[41] !== 0) return null;
  const size = frame.readUInt16LE(42);
  if (44 + size !== frame.length) return null;
  try {
    const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(frame.subarray(44)));
    return entry?.v === 'delegation-receipt/1' ? entry : null;
  } catch {
    return null;
  }
}

export async function audit(recordText, held) {
  const core = await Core.load();
  await core.replay(recordText);

  let receipts = 0, agree = 0;
  const disagree = [];
  core.frames.forEach((frame, index) => {
    const entry = speechReceipt(frame);
    if (!entry) return;
    receipts++;
    try {
      if (Array.isArray(entry.hops) && entry.hops.every(hop => hop && typeof hop === 'object' && !Array.isArray(hop))) {
        const { established, cause, at } = evaluateChain(entry.hops, held);
        if (entry.established === established && entry.cause === cause && entry.at === at &&
            entry.chain === chainDigest(entry.hops)) {
          agree++;
          return;
        }
      }
    } catch {
      // A malformed versioned evaluation is not an agreement.
    }
    disagree.push(index);
  });
  return { lines: core.frames.length, receipts, agree, disagree };
}
