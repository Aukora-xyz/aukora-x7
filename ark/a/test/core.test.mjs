import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pae, parseStrict, b64uDecodeStrict, b64uEncode, newTestKey, seal, openEnvelope, verifySig } from '../lib/core.mjs';
import { selfcheck, checkPins } from '../lib/selfcheck.mjs';
import { PROOF } from './helpers.mjs';

test('PAE matches the DSSE spec vector', () => {
  assert.equal(pae('http://example.com/HelloWorld', Buffer.from('hello world')).toString(), 'DSSEv1 29 http://example.com/HelloWorld 11 hello world');
});

test('strict JSON rejects duplicates, non-integers, lone surrogates, trailing bytes, BOM', () => {
  for (const bad of ['{"a":1,"a":2}', '{"a":1.0}', '{"a":1e3}', '{"a":-1}', '{"a":01}', '{"a":"\\ud800"}', '{"a":1} x', '[1]',
    '{"a":9007199254740992}', '﻿{"a":1}']) {
    assert.throws(() => parseStrict(Buffer.from(bad)), (e) => e.code === 'BAD_JSON', bad);
  }
  assert.throws(() => parseStrict(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), (e) => e.code === 'BAD_JSON');
  assert.deepEqual({ ...parseStrict('{"a":"\\ud83d\\ude00","b":[0]}') }, { a: '\u{1F600}', b: [0] });
});

test('base64url strict: no padding, no standard alphabet, canonical trailing bits', () => {
  assert.equal(b64uDecodeStrict(b64uEncode(Buffer.from('hi'))).toString(), 'hi');
  for (const bad of ['aGk=', 'a+/b', 'aGl', 'A']) assert.throws(() => b64uDecodeStrict(bad), (e) => e.code === 'BAD_ENCODING', bad);
});

test('seal/open round trip; unknown field is BAD_SCHEMA', () => {
  const k = newTestKey();
  const env = seal({ v: '0.1', type: 'note', about: '0'.repeat(64), label: 'summary', grants: 'none', text: 'x' }, k);
  assert.ok(verifySig(openEnvelope(env), k.pubHex));
  assert.throws(() => seal({ v: '0.1', type: 'note', about: '0'.repeat(64), label: 'summary', grants: 'none', text: 'x', extra: 1 }, k), (e) => e.code === 'BAD_SCHEMA');
});

test('every vector reproduces its expected verdict (internal self-check, not the verifier of record)', (t) => {
  const vdir = path.join(PROOF, 'vectors');
  const ef = path.join(vdir, 'expected-verdicts.json');
  if (!fs.existsSync(ef)) { t.skip('vectors not generated yet'); return; }
  const exp = JSON.parse(fs.readFileSync(ef, 'utf8'));
  for (const v of exp.vectors) {
    const r = selfcheck(fs.readFileSync(path.join(vdir, v.bundle)), checkPins(fs.readFileSync(path.join(vdir, v.pins))));
    assert.deepEqual({ bundle: r.bundle, ops: r.ops, exit: r.exit }, { bundle: v.bundle_verdict, ops: v.ops, exit: v.exit }, v.bundle);
  }
});
