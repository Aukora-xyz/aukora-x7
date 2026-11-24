import assert from 'node:assert/strict';
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { PROFILES, audit, compare, evaluateChain, profileId, receipt, record } from './exhibit.mjs';

const [prefix, atMost, strict, none] = PROFILES.map(profileId);
const held = new Map(PROFILES.map(text => [profileId(text), text]));
const unknown = profileId('unheld synthetic profile');
const hop = (domain, profile, received, emitted) => ({ domain, profile, received, emitted });
const numeric = [hop('A', atMost, 1, 1), hop('B', atMost, 3, 2)];
const narrowing = [
  hop('A', prefix, 'pay', 'pay/supplier'),
  hop('B', prefix, 'pay/supplier', 'pay/supplier/eu'),
  hop('C', prefix, 'pay/supplier/eu', 'pay/supplier/eu/fr'),
];
const broader = narrowing.map((item, i) => i === 1 ? { ...item, emitted: 'pay' } : item);
const missing = [hop('A', unknown, 'pay', 'pay/supplier')];
const unrelated = [hop('A', none, 'pay', 'pay/supplier')];
const strictOne = [hop('A', strict, 'pay', 'pay/supplier')];
const unchanged = [hop('A', strict, 'pay', 'pay')];
const strictTwo = [...strictOne, hop('B', strict, 'pay/supplier', 'pay/supplier/eu')];
const changed = narrowing.map((item, i) => i === 1 ? { ...item, profile: strict } : item);
const empty = [];
const wrongType = [hop('A', atMost, 2, '1')];
const cases = [numeric, narrowing, broader, missing, unrelated, strictOne, unchanged, strictTwo, changed, empty];

const noBroader = { result: 'NO_BROADER', reason: null };
const success = { established: true, cause: null, at: null };
const failure = (cause, at = null) => ({ established: false, cause, at });
const decide = hops => evaluateChain(hops, held);

let passed = 0, failed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log('ok ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL ' + name + ': ' + String(error.message).replace(/\s+/gu, ' '));
  }
}

await check('a numeric hops do not share a middle value', () => {
  for (const { profile, received, emitted } of numeric) {
    assert.deepEqual(compare(profile, held, received, emitted), noBroader);
  }
  assert.deepEqual(decide(numeric), failure('VALUE_NOT_SHARED', 0));
});
await check('b linked prefixes narrow', () => assert.deepEqual(decide(narrowing), success));
await check('c a broader hop takes precedence over a broken link', () => {
  assert.deepEqual(decide(broader), failure('HOP_BROADER', 1));
});
await check('d a missing profile is distinct', () => {
  assert.deepEqual(compare(unknown, held, 'pay', 'pay/supplier'), {
    result: 'UNDECIDED', reason: 'PROFILE_NOT_HELD',
  });
  assert.deepEqual(decide(missing), failure('HOP_UNDECIDED:PROFILE_NOT_HELD', 0));
});
await check('e a held profile can lack a comparison relation', () => {
  assert.deepEqual(compare(none, held, 'pay', 'pay/supplier'), {
    result: 'UNDECIDED', reason: 'NO_COMPARISON_RELATION',
  });
  assert.deepEqual(decide(unrelated), failure('HOP_UNDECIDED:NO_COMPARISON_RELATION', 0));
});
await check('f one strict hop can narrow but assertion cannot support composition', () => {
  assert.deepEqual(decide(strictOne), success);
  assert.deepEqual(decide(unchanged), failure('HOP_BROADER', 0));
  assert.deepEqual(decide(strictTwo), failure('BASIS_ASSERTED'));
});
await check('g a profile change blocks composition', () => {
  assert.deepEqual(decide(changed), failure('PROFILE_DIFFERS', 1));
});
await check('h an empty chain authorizes nothing', () => {
  assert.deepEqual(decide(empty), { established: true, cause: 'EMPTY_CHAIN_AUTHORIZES_NOTHING', at: null });
});

let exported;
await check('i all evaluations agree on replay of one record', async () => {
  const core = await Core.load();
  core.init(newOwner());
  assert.equal(core.say('synthetic delegation exhibit'), true);
  for (const hops of cases) assert.deepEqual(record(core, hops, held), receipt(hops, held));
  exported = core.exportRecord();
  assert.deepEqual(await audit(exported, held), {
    lines: cases.length + 1, receipts: cases.length, agree: cases.length, disagree: [],
  });
});
await check('j edited receipt speech breaks its unchanged successor', async () => {
  assert.equal(typeof exported, 'string');
  const lines = exported.split('\n');
  const frame = Buffer.from(lines[3], 'hex');
  const match = Buffer.from('"domain":"A"', 'utf8');
  const location = frame.indexOf(match, 44);
  assert.ok(location >= 44 && lines[4].length > 0);
  frame[location + match.length - 2] = 'X'.charCodeAt(0);
  lines[3] = frame.toString('hex');
  await assert.rejects(audit(lines.join('\n'), held), /line 3 of the record is refused by the core/u);
});
await check('k admitted speech can contain a dishonest result', async () => {
  const core = await Core.load();
  core.init(newOwner());
  assert.equal(core.say('the next frame is a synthetic evaluation'), true);
  const dishonest = { ...receipt(broader, held), established: true };
  assert.equal(core.say(JSON.stringify(dishonest)), true);
  assert.deepEqual(await audit(core.exportRecord(), held), {
    lines: 2, receipts: 1, agree: 0, disagree: [1],
  });
});
await check('l a string is not comparable under at-most', () => {
  assert.deepEqual(decide(wrongType), failure('HOP_UNDECIDED:VALUE_NOT_COMPARABLE', 0));
});
await check('an unresolved hop takes precedence across the chain', () => {
  const mixed = [hop('A', prefix, 'pay/supplier', 'pay'), ...missing];
  assert.deepEqual(decide(mixed), failure('HOP_UNDECIDED:PROFILE_NOT_HELD', 1));
});
await check('mismatched held bytes are not a missing profile or missing relation', () => {
  assert.deepEqual(compare(prefix, new Map([[prefix, PROFILES[3]]]), 'pay', 'pay/supplier'), {
    result: 'UNDECIDED', reason: null,
  });
});

await check('malformed held definition does not claim an absent relation', () => {
  const invalid = '{"relation":"none"}';
  const id = profileId(invalid);
  assert.deepEqual(compare(id, new Map([[id, invalid]]), 'pay', 'pay/supplier'), {
    result: 'UNDECIDED', reason: null,
  });
});

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
