# CONTRACT-DECISIONS v0.1.3 (reader 1's author, 2026-11-21)

Sources: CONTRACT-ISSUES.md (reader 2, Go, 13 items) and c/NOTES.md "Questions and readings" (reader 3, Swift, 12 items).
Columns: issue | decision (CONTRACT.md section 12) | matches reader 3 | matches reader 2 | changes a vector or a reader's behaviour.
"not raised" = that reader did not state a reading; nothing they wrote contradicts the decision.
Receiver, owner, client A and the vectors are unchanged.

| # | issue (sources) | decision | reader 3 | reader 2 | changes |
|---|---|---|---|---|---|
| 1 | verifier command line, exit 2 output (B5, C1) | C1: `verifier BUNDLE PINS`; exit 2 writes stderr only; pins checked first | yes | yes | no |
| 2 | BAD_BUNDLE output (B6, C3) | C2: pins line, integrity line, `BUNDLE INVALID BAD_BUNDLE`, exit 4 | yes | yes | no |
| 3 | JSON depth counting and scope (B2, C4) | C3: top object = level 1, 9th level BAD_JSON, all JSON files | yes | yes | no |
| 4 | trailing whitespace, size limit scope (C4) | C4: allowed; 64 KiB only for payloads | yes | not raised | no |
| 5 | duplicate-name equality (C4) | C5: after unescaping, no normalisation | yes | not raised | no |
| 6 | error layer for malformed envelopes (C5) | C6: outer syntax/duplicate = BAD_BUNDLE; parsed non-object or bad envelope members (null too) = BAD_ENVELOPE | yes | yes (reader 2 parses null, then item check) | no |
| 7 | null/boolean in payload (B1, C5) | C7: BAD_JSON at E4, only outcome.approval/effect may be null | yes | yes | no (reader 1's internal self-check would say BAD_SCHEMA; it is not a reader and no vector covers it) |
| 8 | v/type position (C6) | C8: any position | yes | not raised | no |
| 9 | reason OK reserved for DONE (B3, C6) | C9: DONE needs OK (else BAD_SCHEMA); REFUSED any code | yes | yes | no (the receiver only ever signs OK with DONE) |
| 10 | client keys from grants, role order (C7) | C10: only S1-verified owner grants; grant fields do not gate S2; no second role | yes | not raised | no |
| 11 | notes (C8) | C11: E1-E5 and known-key S1/S2 apply; never in O1-D14 | yes | not raised | no |
| 12 | D10 with several signers of one payload (B4, C9) | C12: passes if any OK envelope of those bytes has the grant's client keyid | yes | yes | no |
| 13 | how much the verifier re-checks (C10) | C13: section 8.2 is complete; not_after == at passes; no seq/prev check | yes | not raised | no |
| 14 | D13 with several authority snapshots (C11) | C14: existential | yes | not raised | no |
| 15 | empty bundle / no ops (C12) | C15: zero items BAD_BUNDLE; OK with no ops exits 0 | yes | yes (reader 2 rejects zero items) | no |
| 16 | owner deliver --wait-ms (B7) | C16: default 10000; 0 = `SENT`, exit 3 | not raised | yes | no |
| 17 | concurrent run-once (B8) | C17: waits up to 60 s for the lock, breaks a dead holder's lock, exit 0 | not raised | yes | no |
| 18 | die-after-effect exit (B9) | C18: SIGKILL, shell 137 | not raised | yes | no |
| 19 | status answer authority (B10) | C19: authority at the stored outcome's epoch, else null | not raised | yes | no |
| 20 | acceptance item 10(b) reason order (B12) | C20: REFUSED GRANT_NOT_IN_AUTHORITY | not raised | yes | no |
| 21 | acceptance item 13 wording (B13) | C20: section 10 mapping kept | not raised | yes | no |

## The contract editor's decisions (v0.1.2): L1 and L2

| # | issue | decision (CONTRACT.md) | reader 3 | reader 2 | changes |
|---|---|---|---|---|---|
| L1 | `true`/`false` inside an unsigned file | resolved by the contract editor, C21: parses; a boolean item is BAD_ENVELOPE at its index | yes | no: reader 2 must change (today BAD_BUNDLE) | yes: reader 2's verifier; new vector `invalid-boolean-item.json` |
| L2 | control characters in `coverage` / `supplied_by` | resolved by the contract editor, C22: accept any UTF-8; verifier prints U+0000-U+001F and U+007F escaped (`\n`, `\r`, `\t`, else `\u00xx`) | yes (reader 3 already escapes CR/LF; other controls to check) | no: reader 2 must change (today prints raw) | yes: reader 2's verifier; new vector `done-coverage-control-chars.json` |

New vectors (25 in total now): `invalid-boolean-item.json` and `done-coverage-control-chars.json`, both derived from
`done.bundle.json` by changing unsigned bundle bytes only (no new signature), with exact `stdout` lines in
`expected-verdicts.json`. Made by `a/tools/add-v012-vectors.mjs`; the other 23 vectors are byte-identical.
Both separately written readers (reader 2: Go, reader 3: Swift) must re-run all 25 vectors, including the new `stdout` lines.
Reader 1's internal self-check does not escape headers; it is not a reader and only its verdicts were cross-checked.

## v0.1.3: C7 clarified by the contract editor after the reader differential; reader 3's reading changes

| # | issue | decision (CONTRACT.md) | reader 3 | reader 2 | changes |
|---|---|---|---|---|---|
| L3 | `true` as the value of `outcome.approval` / `outcome.effect` (differential test, `diff-test/approval-true.json`) | C7 rewritten: any `true`/`false` anywhere in a payload is BAD_JSON (E4); `null` is BAD_JSON except as the direct value of `outcome.approval` / `outcome.effect` | no: reader 3 must change (today BAD_SCHEMA) | yes | yes: reader 3's verifier; new vector `invalid-approval-true.json` (`BUNDLE INVALID BAD_JSON item=4`, exit 4) |

The new vector is the DONE bundle with the outcome payload's approval hash replaced by `true`, old signature kept
(26 vectors now; the other 25 entries are byte-identical). Both readers must re-run all 26.
Reader 1's internal self-check now applies C7 too (it gave BAD_SCHEMA before); it is test-only code, not a reader,
and the receiver, owner and client A are unchanged.

## Earlier open-decision record (v0.1.1, now resolved above)

| # | issue (sources) | reader 3 reading | reader 2 reading | reader 1 behaviour |
|---|---|---|---|---|
| L1 | `true`/`false` inside an unsigned file, e.g. a boolean as a bundle item (C5 vs reader 2's json.go) | parse it; the item is BAD_ENVELOPE at its index | the whole file fails to parse: BAD_BUNDLE | parses it; BAD_ENVELOPE (reader 1's self-check); the receiver gives REJECTED BAD_REQUEST for requests either way |
| L2 | CR/LF and other control characters in `coverage` / `supplied_by` (C2, B11) | accept, print CR as `\r` and LF as `\n` | accept any UTF-8, print raw | accepts any string; emitter never writes control characters; `receiver pins --supplied-by` copies the argument as given |

No vector covers L1 or L2. Either choice changes one reader's behaviour; the other reader and every vector stay as they are.
