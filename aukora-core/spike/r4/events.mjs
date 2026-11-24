import assert from 'node:assert/strict';

// Run on a fresh instance. The chain checks each verdict and its complete head
// against an independent SHA-256 of the accepted wire bytes.
export function exerciseEvents(api, tool) {
  const { u8, u16, blob, text, sent, digest } = tool;
  const currentCore = digest(api.core);
  const zero = Buffer.alloc(32);
  const next = tool.chain(api);
  const check = (label, tag, fields, expected = 1) => {
    const id = next(label, tag, fields, expected);
    assert.deepEqual(digest(api.core), currentCore, label);
    return id;
  };
  const yes = u8(1), no = u8(0);
  const payload = Buffer.from([42, 0, 255]);
  const delivery = sent(payload, 'service', 0, 9);
  const spendMandate = (id, intent) => [u16(id), u8(4), intent];
  const budget = [u16(0), u16(5), yes];
  const read = (id, reader = 'guest', scope = 'thread', flag = yes) =>
    [u16(id), text(reader), text(scope), flag];

  check('say Unicode and NUL', 0, [text('line 語\0')]);
  check('remember', 1, [u16(5), u16(1), text('first')]);
  check('duplicate claim', 1, [u16(5), u16(1), text('duplicate')], 0);
  check('remember replacement', 1, [u16(6), u16(1), text('replacement')]);
  check('correct', 2, [u16(5), u16(6), text('reason')]);
  check('outcome', 5, [delivery, u8(2)]);
  check('advise', 6, [text('cell'), u16(350)]);
  check('ungranted act', 4, [delivery], 0);
  check('unsigned grant', 3, [delivery, no], 0);
  check('grant delivery', 3, [delivery, yes]);
  check('wrong audience', 4, [sent(payload, 'elsewhere', 0, 9)], 0);
  check('act', 4, [delivery]);
  check('duplicate act', 4, [delivery], 0);

  check('unsigned retract', 9, [u16(1), no], 0);
  check('too many lines', 9, [u16(2), yes], 0);
  check('retract only active line', 9, [u16(1), yes]);
  check('active view now empty', 9, [u16(1), yes], 0);
  const mandate = [text('service'), blob(payload), u16(0), u16(1), u16(100)];
  check('unsigned mandate', 10, [...mandate, no], 0);
  const mandateId = check('issue bounded mandate', 10, [...mandate, yes]);
  check('mandate cannot rebind', 11, [u16(mandateId), u8(8), text('other'), yes], 0);
  check('mandate wrong payload', 11, spendMandate(mandateId, sent(zero, 'service', 0, 9)), 0);
  check('use exact mandate', 11, spendMandate(mandateId, delivery));
  check('mandate exhausted', 11, spendMandate(mandateId, delivery), 0);

  check('spend without a budget', 13, [u16(65535), u16(1)], 0);
  const budgetId = check('issue budget', 12, budget);
  check('spend two', 13, [u16(budgetId), u16(2)]);
  check('cap exceeded', 13, [u16(budgetId), u16(4)], 0);
  check('spend remaining three', 13, [u16(budgetId), u16(3)]);
  check('budget exhausted', 13, [u16(budgetId), u16(1)], 0);

  const pass = [text('guest'), text('thread'), u16(0), u16(100), yes];
  const passId = check('issue pass', 14, pass);
  check('read as wrong reader', 16, read(passId, 'other'), 0);
  check('read wrong scope', 16, read(passId, 'guest', 'other'), 0);
  check('unauthenticated read', 16, read(passId, 'guest', 'thread', no), 0);
  check('authenticated read', 16, read(passId));
  check('unsigned revoke', 15, [u16(passId), no], 0);
  check('revoke pass', 15, [u16(passId), yes]);
  check('revoked read', 16, read(passId), 0);
  const freshPass = check('fresh pass', 14, pass);
  check('old pass still revoked', 16, read(passId), 0);
  check('fresh read', 16, read(freshPass));

  // The preceding read is at sequence freshPass + 2. Issue at +3, use
  // exactly at +4 (expiry inclusive), then attempt another read at +5.
  const shortPass = check('short pass', 14,
    [text('guest'), text('thread'), u16(0), u16(freshPass + 4), yes]);
  check('read on expiry', 16, read(shortPass));
  check('expired pass', 16, read(shortPass), 0);
  const oldBudget = check('issue budget before rebind', 12, budget);
  const oldMandate = check('issue mandate before rebind', 10, [...mandate, yes]);
  check('rebind owner', 8, [text('second'), yes]);
  check('old pass generation', 16, read(freshPass), 0);
  check('old budget generation', 13, [u16(oldBudget), u16(1)], 0);
  check('old mandate generation', 11, spendMandate(oldMandate, delivery), 0);
  check('old grant generation', 3, [delivery, yes], 0);
  check('truncated UTF-8', 0, [blob(Buffer.from([0xf0]))], 0);
  check('trailing byte', 0, [text('ok'), u8(0)], 0);
  check('good frame after rejection', 0, [text('ok')]);
  console.log('Original non-upgrade events and all eight round-2 operations passed with independent heads; ' +
    'verified mandate exhaustion, budget cap, pass expiry/revocation and generation changes.');
}
