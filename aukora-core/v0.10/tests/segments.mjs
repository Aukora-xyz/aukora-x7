// Public adapter for the signed trailer and named continuation descriptor.
import assert from 'node:assert/strict';
import {cat, dual, sha} from './host.mjs';
export const bytes32 = f => {
  const values = Array.from({length:32}, (_, i) => f(i));
  assert.ok(values.every(b => b >= 0 && b < 256));
  assert.equal(f(32), 256);
  return Buffer.from(values);
};
export const rawKeys = keys => cat(keys.edRaw, keys.mlRaw);
export function signedSeal(h, keys, signer = keys) {
  const law = bytes32(h.api.lawByte);
  const body = cat(Buffer.from('AUKORA/R12B/seal'), bytes32(h.api.journalByte), law,
    bytes32(h.api.head), rawKeys(keys));
  const {edSig, mlSig} = dual(signer, body);
  return cat(body, edSig, mlSig);
}
export function genesisFor(h, keys, trailer) {
  return cat(Buffer.from('AUKORA/R12B/genesis'), sha(trailer), bytes32(h.api.lawByte), rawKeys(keys));
}
export function closeAndContinue(h, keys) {
  const wire = signedSeal(h, keys);
  assert.equal(h.consume(wire, 'seal'), 1);
  assert.deepEqual(bytes32(h.api.sealByte), sha(wire));
  const genesis = genesisFor(h, keys, wire);
  assert.equal(h.consume(genesis, 'continueRecord'), 1);
  h.acceptGenesis(genesis);
  assert.deepEqual(bytes32(h.api.journalByte), sha(genesis));
  return {wire, genesis};
}
