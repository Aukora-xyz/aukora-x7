# Shell anchors for the Python vectors (capsule_canon_vectors_py.json)

Contract: the capsule contract, draft 7, section 3.8. Each one-liner uses only `printf` and `shasum`
(no project code). It is written out in full, and below it is the output of running it with `/bin/sh` from
the repository root; the last line names the vector row and domain whose stored digest it must equal.
Rows 1 to 6 are canonical texts; rows 7 to 10 are the act rows (a command id, an envelope digest, a key
thumb, the policy v0 digest); rows 11 and 12 were added for draft 6 (the act lineage from a mirror id with
its dashes, 6.2; a status read whose chain has a null lastDigest, 6.5a, under the record domain); rows 13
and 14 were added for draft 7 (a mirror id whose version and variant digits are zeros, ruling 7; the small
record that is ok and complete, whose id is this digest, rulings 2 to 6).

1. `empty-object-anchor` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{}' | shasum -a 256
```

```
1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691  -
```

Stored in the row: `1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691` (equal).

2. `int-one` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{"a":1}' | shasum -a 256
```

```
4a44023320d8f817701ad92cc8b04b3ded6e6c24441cb64531f178ae73c192f2  -
```

Stored in the row: `4a44023320d8f817701ad92cc8b04b3ded6e6c24441cb64531f178ae73c192f2` (equal).

3. `literals` under `aukora.capsule.state.v1`

```sh
printf 'aukora.capsule.state.v1\000%s' '{"f":false,"n":null,"t":true}' | shasum -a 256
```

```
6738036366795157767b512b3b12c9d407abd3ef79f439ace7b76a54e8925b5d  -
```

Stored in the row: `6738036366795157767b512b3b12c9d407abd3ef79f439ace7b76a54e8925b5d` (equal).

4. `keys-10-and-2` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{"10":1,"2":2}' | shasum -a 256
```

```
2bb6dae12359c13e8a235ff4f22741938c087bafe77ebe04ab1662da7fb092e8  -
```

Stored in the row: `2bb6dae12359c13e8a235ff4f22741938c087bafe77ebe04ab1662da7fb092e8` (equal).

5. `keys-proto-and-constructor` under `aukora.capsule-policy.v0`

```sh
printf 'aukora.capsule-policy.v0\000%s' '{"__proto__":{"x":1},"constructor":2}' | shasum -a 256
```

```
3f74b1187baf0801033bb0d7c80e22ef10c8863bf55197ceaad74c2cff33beb6  -
```

Stored in the row: `3f74b1187baf0801033bb0d7c80e22ef10c8863bf55197ceaad74c2cff33beb6` (equal).

6. `string-two-escapes` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{"s":"q\"b\\e"}' | shasum -a 256
```

```
9463f2bf6ff56ed9703a67039b0097702100aea1e3e280e37eb2bf6fd51025c9  -
```

Stored in the row: `9463f2bf6ff56ed9703a67039b0097702100aea1e3e280e37eb2bf6fd51025c9` (equal).

7. `act-command-with-its-id` under `aukora.act.v1`

```sh
printf 'aukora.act.v1\000%s' '{"intentId":"0123456789abcdef0123456789abcdef","lineageId":"98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209","op":"ledger.note.append","payloadHex":"63617073756c652d76302e332d736166652d616374696f6e","prev":"0000000000000000000000000000000000000000000000000000000000000000","schema":"aukora.act.v1","seq":1,"target":"test-ledger"}' | shasum -a 256
```

```
e29f504b69c6beff3998ebdb2b45d96634aafc6d5f56e3f71f8de7825704ec58  -
```

Stored in the row: `e29f504b69c6beff3998ebdb2b45d96634aafc6d5f56e3f71f8de7825704ec58` (equal).

8. `act-envelope-with-digest` under `aukora.proof.v3`

```sh
printf 'aukora.proof.v3\000%s' '{"actionId":"e29f504b69c6beff3998ebdb2b45d96634aafc6d5f56e3f71f8de7825704ec58","holderGeneration":7,"leaseGeneration":3,"lineageId":"98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209","nextKey":"BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E","schema":"aukora.proof.v3","signerThumb":"26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497","verb":"act"}' | shasum -a 256
```

```
69c51ac58067c2999fb6b134baf8a4f70406eba797554dca9f4f023020672199  -
```

Stored in the row: `69c51ac58067c2999fb6b134baf8a4f70406eba797554dca9f4f023020672199` (equal).

9. `act-key-thumb` under `aukora.key.v1`

```sh
printf 'aukora.key.v1\000%s' '{"key":"BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"}' | shasum -a 256
```

```
26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497  -
```

Stored in the row: `26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497` (equal).

10. `act-policy-v0` under `aukora.capsule-policy.v0`

```sh
printf 'aukora.capsule-policy.v0\000%s' '{"rules":[{"decision":"ALLOW","needsBudget":false,"op":"ledger.note.append","payloadHex":"63617073756c652d76302e332d736166652d616374696f6e","target":"test-ledger"}],"schema":"aukora.capsule-policy.v0","version":0}' | shasum -a 256
```

```
cb9cc3d997a67844fd765f6079c9f9e6724e3daf11674b848b9027432d9a481c  -
```

Stored in the row: `cb9cc3d997a67844fd765f6079c9f9e6724e3daf11674b848b9027432d9a481c` (equal).

11. `act-lineage-id` under `aukora.act-lineage.v1`

```sh
printf 'aukora.act-lineage.v1\000%s' '{"mirror":"3f2a9c1e-5b7d-4a60-8e1f-2c3b4a5d6e7f","world":"node-main-v1"}' | shasum -a 256
```

```
98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209  -
```

Stored in the row: `98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209` (equal).

12. `act-status-null-last-digest` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{"chain":{"currentThumb":"26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497","firstThumb":"26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497","lastDigest":null,"locked":false},"head":{"id":"0000000000000000000000000000000000000000000000000000000000000000","seq":0},"holderGeneration":7,"holderKeyThumb":"26587b218af6b745f6b36a8d87b97590cab8f82fa87406959dc881ca30b57497","lease":{"generation":3,"held":true},"lineageId":"98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209","pending":false,"schema":"aukora.act-status.v1"}' | shasum -a 256
```

```
d10bea2f92f9fb4808a443223f06c87df76aa01afcd98dc3e772edc078451bf7  -
```

Stored in the row: `d10bea2f92f9fb4808a443223f06c87df76aa01afcd98dc3e772edc078451bf7` (equal).

13. `r7-act-lineage-mirror-version-digits-not-checked` under `aukora.act-lineage.v1`

```sh
printf 'aukora.act-lineage.v1\000%s' '{"mirror":"00000000-0000-0000-0000-000000000000","world":"node-main-v1"}' | shasum -a 256
```

```
3b8b5d3398d2210083436cad3b2fbc3f7976e9d9376b263c2348e445b4327209  -
```

Stored in the row: `3b8b5d3398d2210083436cad3b2fbc3f7976e9d9376b263c2348e445b4327209` (equal).

14. `r2-r3-r5-r6-record-ok-complete` under `aukora.capsule.v1`

```sh
printf 'aukora.capsule.v1\000%s' '{"observation":{"attempt":1,"capturedAtMs":1,"sources":[{"code":null,"name":"baseline","observedAtMs":1,"ok":true},{"code":null,"name":"head.published","observedAtMs":1,"ok":true},{"code":null,"name":"head.staged","observedAtMs":1,"ok":true},{"code":null,"name":"memory","observedAtMs":1,"ok":true},{"code":null,"name":"policy","observedAtMs":1,"ok":true},{"code":null,"name":"producer","observedAtMs":1,"ok":true},{"code":null,"name":"receipts","observedAtMs":1,"ok":true},{"code":null,"name":"suite","observedAtMs":1,"ok":true}]},"schema":"aukora.capsule.v1","state":{"authorityRequired":["OWNER_APPROVED_MOVE","OWNER_SESSION","WRITER_LEASE"],"compatibility":{"canon":"aukora.canon.v1","readerMin":1,"unsupported":[]},"evidence":{"checkpoints":[],"receipts":[],"retention":[{"digest":null,"issuer":"edge","ref":"r","scope":"behavioral-retention-only","status":"unverified"}]},"extensions":{},"heads":{"agreement":"unknown","local":{"ballId":"ball-1","ballIdForm":"legacy","epoch":1,"parentBallId":null},"published":null,"staged":null},"inventory":[{"byteLength":null,"digest":null,"digestKind":null,"disposition":"excluded","id":"headHistory","kind":"other","reason":"EXCLUDED_NOT_PORTABLE"},{"byteLength":null,"digest":null,"digestKind":null,"disposition":"excluded","id":"messages","kind":"other","reason":"EXCLUDED_PRIVATE"},{"byteLength":null,"digest":null,"digestKind":null,"disposition":"excluded","id":"ownerBinding","kind":"other","reason":"EXCLUDED_AUTHORITY"},{"byteLength":null,"digest":null,"digestKind":null,"disposition":"excluded","id":"providerBudget","kind":"other","reason":"EXCLUDED_HOST_SPECIFIC"},{"byteLength":null,"digest":null,"digestKind":null,"disposition":"excluded","id":"turnJournal","kind":"other","reason":"EXCLUDED_PRIVATE"}],"lineageId":"98a8767a2dd34d961b9f05642ef0b646500458ef3c5cbf44f365922d8f5e6209","parentCapsuleId":null,"pending":[],"producer":{"builder":"host/capsule-record","builderVersion":1,"claim":"self-asserted","runtimeArtifactSha256":null,"sourceRevision":null},"roots":{"baseline":null,"memory":null,"policy":null,"receipts":null,"suite":null}}}' | shasum -a 256
```

```
ed5f4bb8551e9bd1ebe62a237e77d7aed487025e093f7a9858b10233274f1293  -
```

Stored in the row: `ed5f4bb8551e9bd1ebe62a237e77d7aed487025e093f7a9858b10233274f1293` (equal).

# The draft 7 rulings in the Python checkers

Generated from `RULES` in `capsule_record_check.py` and `capsule_act_shapes.py`, and from the `rulings`
annotation of the vector rows (a member the runner ignores, ruling 1). Ruling 1 lives in the runner
(`check_vector_row` reads only the members 3.8 names). `capsule_canon_test.py` tests each rule by name
(labels `ruling N <rule>`).

| Ruling | Rule | Held by | Module |
|---|---|---|---|
| 2 | `evidence-scope-own-list` | `_evidence` | capsule_record_check.py |
| 3 | `failed-source-once-per-row` | `check_body` | capsule_record_check.py |
| 4 | `inventory-id-rest-1-to-128` | `_inventory_id` | capsule_record_check.py |
| 4 | `inventory-id-form-fixes-kind` | `_inventory` | capsule_record_check.py |
| 5 | `always-excluded-rows-are-constants` | `_inventory` | capsule_record_check.py |
| 6 | `authority-required-exactly-three` | `_state` | capsule_record_check.py |
| 7 | `mirror-id-dashed-lowercase-hex` | `check_mirror_lineage_id` | capsule_act_shapes.py |
| 8 | `unparsed-request-is-a-class-not-an-answer` | `check_request_bytes` | capsule_act_shapes.py |
| 9 | `answer-state-null-only-at-steps-1-2` | `_answer_state` | capsule_act_shapes.py |
| 9 | `answer-no-holder-only-instance-revoked` | `_answer_state` | capsule_act_shapes.py |
| 9 | `holder-thumb-null-exactly-when-chain-null` | `_holder_and_chain` | capsule_act_shapes.py |
| 9 | `lease-generation-an-integer` | `check_lease` | capsule_act_shapes.py |
| 10 | `row-resolved-by-null-exactly-when-pending` | `_row_rules` | capsule_act_shapes.py |
| 10 | `row-commit-verdict-exactly-when-committed` | `_row_rules` | capsule_act_shapes.py |
| 10 | `row-action-id-is-command-digest` | `_row_rules` | capsule_act_shapes.py |
| 10 | `row-seq-and-intent-id-are-the-command-s` | `_row_rules` | capsule_act_shapes.py |
| 11 | `answer-row-present-with-result-state` | `_answer_row` | capsule_act_shapes.py |
| 11 | `answer-row-null-at-steps-1-2` | `_answer_row` | capsule_act_shapes.py |
| 12 | `stored-commit-verdict-is-allow` | `_row_rules` | capsule_act_shapes.py |
| 13 | `gate-commit-call-rows-at-least-1` | `_call_rules` | capsule_act_shapes.py |

| Ruling | Vector rows (shapeVerdict) |
|---|---|
| 1 | `runner-ignores-unknown-members` (ok) |
| 2 | `r2-r3-r5-r6-record-ok-complete` (ok), `r2-record-retention-row-with-checkpoint-scope` (SCHEMA) |
| 3 | `r2-r3-r5-r6-record-ok-complete` (ok), `r3-record-failed-source-naming-two-nulls-reported-once` (CAPSULE_INCOMPLETE) |
| 4 | `r4-record-file-id-with-128-after-the-prefix-kind-log` (ok), `r4-record-file-id-with-129-after-the-prefix` (SCHEMA), `r4-record-organ-id-with-kind-file` (SCHEMA) |
| 5 | `r2-r3-r5-r6-record-ok-complete` (ok), `r5-record-provider-budget-excluded-secret` (SCHEMA) |
| 6 | `r2-r3-r5-r6-record-ok-complete` (ok), `r6-record-authority-required-two-of-three` (SCHEMA) |
| 7 | `r7-act-lineage-mirror-version-digits-not-checked` (ok) |
| 8 | `r8-act-request-does-not-parse` (SYNTAX) |
| 9 | `r9-act-answer-action-id-mismatch-all-four-null` (ok), `r9-act-answer-lineage-mismatch-with-a-head` (SCHEMA), `r9-act-answer-writer-lease-all-four-null` (SCHEMA), `r9-act-answer-no-holder-instance-revoked` (ok), `r9-act-answer-no-holder-with-another-code` (SCHEMA), `r9-act-answer-thumb-null-chain-present` (SCHEMA), `r9-act-status-no-holder` (ok), `r9-act-status-thumb-null-chain-present` (SCHEMA), `r9-act-status-no-lease-held-generation-an-integer` (ok) |
| 10 | `r10-act-row-abandoned` (ok), `r10-act-row-pending-with-a-resolver` (SCHEMA), `r10-act-row-committed-without-a-commit-verdict` (SCHEMA), `r10-act-row-action-id-not-the-command-digest` (SCHEMA), `r10-act-row-seq-not-the-command-s` (SCHEMA) |
| 11 | `r11-act-answer-pending-with-its-pending-row` (ok), `r11-act-answer-committed-with-a-null-row` (SCHEMA), `r11-act-answer-pending-with-a-committed-row` (SCHEMA), `r11-act-answer-lineage-mismatch-with-a-row` (SCHEMA) |
| 12 | `r12-act-row-committed-with-a-deny-commit-verdict` (SCHEMA) |
| 13 | `r13-act-gate-inputs-commit-rows-0` (SCHEMA) |
