# CONTRACT-ISSUES (reader 2 (Go), Go reader, 2026-11-21)

One entry per gap: section, what I read, the two readings, the one I chose. No vector was bent to match: all 23
vectors matched reader 2's verifier as first written (RAN). None of these gaps changed a vector result.

1. **s3 rule 6 vs rule 7 (null in a field that is not "or null").** Rule 6 says null only where allowed; rule 7 says
   a field of the wrong type is BAD_SCHEMA; s8.1 E4 says rules 1-6 give BAD_JSON. Readings: BAD_JSON or BAD_SCHEMA.
   Chose BAD_JSON (E4 names rule 6 explicitly). Nulls are allowed only at outcome.approval and outcome.effect.
2. **s3 rule 8 depth counting.** "Nesting at most 8 levels deep": is the top-level object level 1 or 0? Chose: the
   top object is level 1, each object/array adds one; 9 or more is BAD_JSON. Also applied the same limit to bundle,
   pins, request and answer files (rule 8 names only payloads; rule list says "every unsigned JSON file" must satisfy
   the rules). No contract object comes near either limit.
3. **s4 outcome `reason` "OK" when DONE.** Is a DONE outcome with another reason a schema failure or allowed?
   Chose BAD_SCHEMA (value outside its pattern). A REFUSED outcome with reason "OK" is accepted (nothing forbids it).
4. **s8.2 D10 "P's envelope keyid" when one proposal payload appears in several envelopes** (dedupe is by item hash
   and type). Readings: the first envelope, or any envelope. Chose: D10 passes if any OK envelope of that payload is
   signed by keyid(G.client_key).
5. **s8 verifier command line.** The contract gives inputs and output, not argument syntax. Chose
   `verifier BUNDLE PINS` (also `--bundle F --pins F`).
6. **s8 BAD_BUNDLE output.** "The first line is omitted only for BAD_BUNDLE": chose to still print the pins line and
   the integrity line, then `BUNDLE INVALID BAD_BUNDLE`. Pins are read first; bad pins exit 2 before any bundle line.
7. **s10 `owner deliver --wait-ms`.** No default and no meaning for 0 is stated (client-a send defines 0 = do not
   wait). Chose to pass `--wait-ms 0` and then `receiver run-once`; observed in a probe world: prints `SENT <id>`,
   exit 3 (RAN, 1 probe).
8. **s10 two `receiver run-once` at once.** Lock behaviour of a second process (wait, skip, or exit code) is not
   stated. Acceptance item 5 "8 times at once" is driven as 8 pending identical requests plus 4 racing run-once processes
   and one draining run-once; run.sh ignores the racers' exit codes and checks only answers and the file.
9. **s10 exit code of `run-once --fault die-after-effect`.** Not stated (SIGKILL). run.sh checks only that it is
   non-zero.
10. **s9 status answer `authority` field.** For kind status, what `authority` carries is not stated. Client B stores
    any authority envelope it receives and does not depend on it.
11. **s6 coverage and pins `supplied_by` character rules.** Only byte lengths are given. Chose: any valid UTF-8 of the
    stated length (no `line` character rule).
12. **Acceptance item 10(b).** The acceptance list says REFUSED for an approval signed at epoch 1; with epoch 2 listing only B's grant
    the s7 decision order gives GRANT_NOT_IN_AUTHORITY before STALE_EPOCH. run.sh accepts any signed REFUSED with no
    effect and prints the reason it got.
14. **s7 R4 vs "the same proposal with a fresh approval gives DONE" (contract editor's request for check 16).** Once the receiver
    signs REFUSED STALE_EPOCH for an op_id, R4 makes that outcome final: the same proposal bytes return the stored
    REFUSED whatever approval comes with them. Readings: (a) a fresh approval re-opens the op, (b) R4 holds. Chose (b):
    check 16 asserts that the same op_id returns the stored REFUSED, and that a NEW op_id with an epoch-2 approval
    gives DONE once.
15. **s7 R6/R7 rejection reason for an authority at or below the restore floor.** The s7 list names only
    `BAD_AUTHORITY` and `STALE_AUTHORITY` for authority requests; which one applies below the floor is not said.
    Chose STALE_AUTHORITY (the epoch is not above floor), asserted exactly in check 12.
16. **s7 order for an approval naming another receiver.** BAD_APPROVAL (9) is "bad envelope/schema/signature/not
    owner"; a well-signed approval for recv-2 is none of those, so WRONG_RECEIVER (12) applies. Asserted in check 19.

## Round 3: contract v0.1.2 (C1-C22), 25 vectors
Re-read CONTRACT.md v0.1.2 in full. C1-C20 settle entries 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 12 the way I had
already chosen; no code change was needed for them. Code changes: C21 (a boolean parses in unsigned files: a boolean
item or envelope member is BAD_ENVELOPE at its index, a boolean bundle member is BAD_BUNDLE; payloads still reject
booleans as BAD_JSON per C7) and C22 (coverage and supplied_by printed escaped). The vector checker now also compares
exact `stdout` where a vector gives it. 25 of 25 matched; no expectation looked wrong to me.

17. **C22 does not escape the backslash.** A coverage that literally contains the two characters `\` `n` prints the
    same as one holding a real LF, so the printed header is one line but not always reversible. Readings: (a) as
    written, (b) also print `\` as `\\`. Chose (a), as written. Harmless for verdicts; a candidate for v0.2.
18. **C21 and the pins file.** C21 speaks of bundles; a boolean in a pins file parses, then fails the pins shape check:
    exit 2, as for any bad pins. Chose that; no vector covers it.

13. **Acceptance item 13 wording** (verifier INVALID) vs s10 mapping (receiver REFUSED NO_APPROVAL, verifier INVALID only
    for a bundle claiming DONE). Followed s10; run.sh checks both halves.
