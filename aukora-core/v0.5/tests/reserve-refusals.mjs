import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cat, encoders, host, owner, sha, text, u64} from './host.mjs';
import {bytes32, rawKeys} from './segments.mjs';

let step = 'arguments';
try {
  const [file, flag, count, ...extra] = process.argv.slice(2);
  assert.ok(file && extra.length === 0 &&
    (flag === undefined || (flag === '--expect-reserve' && /^(0|[1-9]\d*)$/.test(count ?? ''))),
    'usage: reserve-refusals.mjs <wasm file> [--expect-reserve N]');
  const expectedReserve = flag === undefined ? 16 : Number(count);
  assert.ok(Number.isSafeInteger(expectedReserve), 'invalid expected reserve');

  step = '1 genesis';
  const image = readFileSync(file);
  const first = owner();
  let active = first, generation = 0;
  const h = host(image);
  const accepted = [];
  assert.equal(h.consume(rawKeys(first), 'init'), 1);
  const wire = encoders(() => cat(bytes32(h.api.head), u64(accepted.length + 1)));
  const speech = i => wire.unsigned(cat(Buffer.of(0), text('reserve filler ' + i)));
  const snapshot = () => [bytes32(h.api.head), bytes32(h.api.core), h.api.halted()];
  const submit = (frame, label) => {
    const before = snapshot();
    const result = h.consume(frame, 'step');
    if (result === 1) {
      accepted.push(frame);
      assert.deepEqual(bytes32(h.api.head), sha(frame), label + ': accepted head');
    } else {
      assert.equal(result, 0, label + ': unexpected verdict');
      assert.deepEqual(snapshot(), before, label + ': refusal changed state');
    }
    return result;
  };
  const refuse = (frame, label) => assert.equal(submit(frame, label), 0, label);

  step = '2 ordinary capacity';
  let ordinary = 0;
  while (ordinary <= 512 && submit(speech(ordinary), 'ordinary ' + (ordinary + 1)) === 1) ordinary++;
  assert.equal(ordinary, 512, 'accepted ordinary count');

  step = '3 stranger key changes';
  const stranger = owner(), unusedReplacement = owner();
  for (let i = 0; i < 40; i++) {
    refuse(wire.rebind(stranger, unusedReplacement, generation), 'stranger ' + (i + 1));
  }

  step = '4 malformed key changes';
  const valid = wire.rebind(active, unusedReplacement, generation);
  for (let i = 0; i < 10; i++) {
    refuse(valid.subarray(0, valid.length - 1), 'truncated ' + (i + 1));
    refuse(cat(valid, Buffer.of(0)), 'trailing byte ' + (i + 1));
  }

  step = '5 owner recovery capacity';
  let recovered = 0;
  while (recovered <= 16) {
    const next = owner();
    if (submit(wire.rebind(active, next, generation), 'recovery ' + (recovered + 1)) === 0) break;
    active = next;
    generation++;
    recovered++;
  }
  assert.equal(recovered, expectedReserve, 'observed accepted recovery count');
  assert.equal(recovered, 16, 'release reserve must remain exactly 16');

  step = '6 final refusal';
  refuse(wire.rebind(active, owner(), generation), 'additional recovery');
  refuse(speech(ordinary + 1), 'additional speech');

  step = '7 cold replay';
  const replay = host(image);
  assert.equal(replay.consume(rawKeys(first), 'init'), 1);
  for (const [i, frame] of accepted.entries()) {
    assert.equal(replay.consume(frame, 'step'), 1, 'replay frame ' + (i + 1));
  }
  assert.deepEqual([bytes32(replay.api.head), bytes32(replay.api.core), replay.api.halted()], snapshot());

  console.log('PASS reserve-refusals ' + file +
    ': ordinary 512; stranger 0 of 40; malformed 0 of 20; recovered 16; then refused; replay equal');
} catch (error) {
  console.error('FAIL reserve-refusals step ' + step + ': ' + (error?.message ?? String(error)));
  process.exitCode = 1;
}
