# The canonical-form vectors: what the file holds, and six digests anyone can check by shell

**Status: the capsule canon, against the capsule contract, draft 7 (not published in this repository).** The JavaScript vector file is
`deploy/cloudflare/src/capsule-canon.vectors.json` (202 rows, 182,717 bytes of its 200,000-byte bound), written by a generator
that never imports the module (classes and positions by hand from section 3.3; digests by `node:crypto`). Its format
(section 3.8): a row stores `inputHex`, or for a long input `inputGen` in one of two forms, which a test expands:
`{ prefixHex, unitHex, count, suffixHex }` is the prefix, the unit `count` times, the suffix; and
`{ prefixHex, beforeHex, width, afterHex, sepHex, count, suffixHex }` is the prefix, then for i from 0 to count - 1 the
piece `before`, i as `width` zero-padded decimal digits, `after`, the pieces joined by `sep`, then the suffix. An accepted
row stores its digests and no second copy of its bytes (an accepted text is its own canonical form:
`encode(parse(t)) == t`). A row with `presentedUnder` is the verdict for bytes presented under an id (3.6).

Rows: 92 accepted parse rows, 100 refused parse rows, 10 presented under an id. A runner ignores row members it
does not know (ruling 1); `runner-unknown-member-accepted` and `runner-unknown-member-refused` carry one, `comment`, and are ordinary rows otherwise.

The second generator form carries the two member-bound rows: `object-8192-members` (keys `k0000` to `k8191`, accepted)
and `object-8193-members` (keys to `k8192`, `LIMIT` at 81,921, the 8,193rd key's opening quote: 1 + 8,192 x 10).

45 act-* rows (19 accepted, 26 refused) of a shape of section 6.5a, of the gate's inputs or of a request also
carry `shape` `{ check, call?, ok, rule? }`: the closed-schema verdict of that check on the parsed text, including the rulings
a row can show (9: the four state members; 10: what every row obeys; 11: the row in an answer; 12: no stored commit verdict
but ALLOW; 13: `logicalTime.rows` from 1 in a commit call). Every such text is canonical (`expect.ok` true), so a shape
refusal is `SCHEMA`, never a canon class; the rule names are this implementation's, the verdicts are the contract's.

7 record-* rows carry a whole capsule record (section 4) and `shape` `{ check: "record", ok, complete, code?, rule? }`:
the verifier's verdict, every problem it reports having that code and rule (rulings 4, 5 and 6 at the record level):
- `record-complete`: complete
- `record-inventory-id-forms`: complete
- `record-inventory-organ-id-129-after-prefix`: SCHEMA, rule `inventory-id`
- `record-inventory-module-id-with-organ-kind`: SCHEMA, rule `inventory-kind`
- `record-excluded-row-another-reason`: SCHEMA, rule `excluded-constant`
- `record-excluded-row-missing`: CAPSULE_INCOMPLETE, rule `required-excluded` (ok, not complete)
- `record-authority-required-two-codes`: SCHEMA, rule `authority-required`

## Six digests by shell

Each is `sha256(ascii(domain) || 0x00 || bytes)`. `printf '%s\0%s'` writes the domain, one zero byte and the text;
`shasum -a 256` hashes it. Each command was RUN under zsh, bash and sh on macOS on 2026-11-13; the output under it is
what it printed. The test keys are fixed (private scalars of 32 bytes of `01` and of `02`; never used outside tests).

1. The empty object under `aukora.capsule.v1` (the contract's anchor, section 3.5); vector row `empty-object`.

```sh
printf '%s\0%s' 'aukora.capsule.v1' '{}' | shasum -a 256
```

```
1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691  -
```

2. The act lineage of the test world under `aukora.act-lineage.v1` (section 6.2); row `act-lineage`.

```sh
printf '%s\0%s' 'aukora.act-lineage.v1' '{"mirror":"0f8fad5b-d9cb-469f-a165-70867728950e","world":"node-main-v1"}' | shasum -a 256
```

```
ddf940959b479f3676645e226db0defe6505613ea9c4e94da95a8b375b7b6688  -
```

3. The command with the safe payload under `aukora.act.v1`: its action id (section 6.3); row `act-command-safe-payload`.

```sh
printf '%s\0%s' 'aukora.act.v1' '{"intentId":"0123456789abcdef0123456789abcdef","lineageId":"ddf940959b479f3676645e226db0defe6505613ea9c4e94da95a8b375b7b6688","op":"ledger.note.append","payloadHex":"63617073756c652d76302e332d736166652d616374696f6e","prev":"0000000000000000000000000000000000000000000000000000000000000000","schema":"aukora.act.v1","seq":1,"target":"test-ledger"}' | shasum -a 256
```

```
33b35d4c2686c56276a5691cc5ff0f2b3c3b910c369582cc91c0e123df55e671  -
```

4. The thumb of test key 1 under `aukora.key.v1` (section 3.5); row `act-key-thumb`.

```sh
printf '%s\0%s' 'aukora.key.v1' '{"key":"BG_wO5SSQc4drdQ1GeaWDgqFtBppoFwygQOqK84VlMoWPE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo"}' | shasum -a 256
```

```
43d422b68be57de76f65a9ba9a0f171c0a0abca9ecb0ad082b9606db93c67e73  -
```

5. The intent envelope under `aukora.proof.v3`: the digest the act key signs (section 6.4); row `act-envelope-intent`.

```sh
printf '%s\0%s' 'aukora.proof.v3' '{"actionId":"33b35d4c2686c56276a5691cc5ff0f2b3c3b910c369582cc91c0e123df55e671","holderGeneration":1,"leaseGeneration":1,"lineageId":"ddf940959b479f3676645e226db0defe6505613ea9c4e94da95a8b375b7b6688","nextKey":"BFUPRxAD89-Xw99QaseX9nIfsaH7e49vg9IkSYplyI4kE2CT1wEuUJpzcVy9CwCjzA_0tcAbP_oZarH7MnA2uOY","schema":"aukora.proof.v3","signerThumb":"43d422b68be57de76f65a9ba9a0f171c0a0abca9ecb0ad082b9606db93c67e73","verb":"intent"}' | shasum -a 256
```

```
7092e339776d129822b4a6a7615d3c06345e3896b24844431da7f7ee8db9a61f  -
```

6. Policy v0 under `aukora.capsule-policy.v0` (section 8); row `act-policy-v0`, and `POLICY_V0_DIGEST` in `capsule-act-shapes.mjs`.

```sh
printf '%s\0%s' 'aukora.capsule-policy.v0' '{"rules":[{"decision":"ALLOW","needsBudget":false,"op":"ledger.note.append","payloadHex":"63617073756c652d76302e332d736166652d616374696f6e","target":"test-ledger"}],"schema":"aukora.capsule-policy.v0","version":0}' | shasum -a 256
```

```
cb9cc3d997a67844fd765f6079c9f9e6724e3daf11674b848b9027432d9a481c  -
```
