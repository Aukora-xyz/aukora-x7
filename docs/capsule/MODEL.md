# The "once" model (contract M2, draft 7): how to run it and what it does not cover

The model is `deploy/cloudflare/src/__tests__/capsule-once-model.mjs`: the capsule contract draft 7, sections 6 (the act door, the procedure of 6.7, the table of 6.8) and 7 (the chain of the holder's installation key, 7.2 selection, the key step of 7.3, and the client of 7.4 read literally), as an explicit-state machine (destination, bodies, network; symbolic keys, ids and digests). It imports nothing; nothing in the product imports it. The test explores breadth first with a visited set, so every violation printed is a shortest trace. States travel between events as text: the model calls the platform serialiser once (`keyText`) and the parser once (`fromKey`; `deepCopy` is the two together), and its test calls neither (the capsule rule scan's allow entries: model 1 and 1, test 0 and 0). No capsule or act bytes pass through it.
**Run (gate):** `node --test --test-concurrency=1 deploy/cloudflare/src/__tests__/capsule-once-model.test.mjs` (about 60 s at load average 4 to 6; the first and last lines print the bounds, the states and the whole file's time). **Deep (manual):** prefix `CAPSULE_MODEL_DEEP=1`, add `--max-old-space-size=6144` and `--test-name-pattern="sound model|^\("`.
**A trace** is numbered steps: who acted, the envelope `verb(actionId) kS->kN gen G [digest]`, and the door's answer. `kN` is a key (k1 = A's installation key, k2 = B's), `cXXXXXXXX` a command id, `iN` an intent id, `wN` a ghost "human wish" no actor sees. `replay(cfg, patterns)` takes any trace back through the model; `exploredTraces(cfg)` exports every explored trace as data for the conformance replay.

## What the client does (7.4, draft 7)
Its store holds the current key, at most one next key, the OPEN INTENT (command bytes and intent id) apart from the signed request, and what it last saw. Step 1 takes the lease whenever none is held and there is something to send. Step 3 first commits or abandons a pending row that is not the open intent's (F8). Step 5 has one rule per verified outcome (committed, abandoned, or a refusal at creation that leaves no row retire the open intent (F9); pending keeps it; `WRITER_LEASE_REQUIRED` goes to step 1; stale or conflict re-issue the same intent id at the head; already placed reads that row), and compares no generations. Step 6 sends a refusal for an earlier stay back to step 1. Out of step, it keeps the open intent and reads it with the `row` read by intent id. The door runs step 7 whenever a ledger effect is staged; an `act` whose commit gate says DENY answers `CAPSULE_GATE_DENIED` and keeps its new row pending; a creation DENY makes no row (`ActCreationDenyKeepsRow` is caught at 3 steps).

## Scenarios (A holds at generation 1, lease generation 1; B is an owner body; `kept` scales the 32 retained keys)
| Scenario | What may happen (each at most once per trace unless said) | Gate depth / states |
|---|---|---|
| honest | the list of 7.5: a lost answer, a crash, a new sign-in, a late duplicate, a lease expiry (also between the checks), a move | 9 / 157,124 |
| moves | two moves (same key, away, back), a lost answer, a late duplicate | 11 / 112,015 |
| tabs | A as two tabs under the Web Lock, a tab closing, a lost answer, an expiry, a move | 8 / 50,491 |
| full | a one-row ledger, a gate-denied payload, a policy change (v1 escalates), an expiry, a move | 9 / 42,333 |
| gate | payloads whose two gate calls differ (creation ALLOW and commit DENY; the reverse), an expiry, a move | 8 / 14,518 |
| copy | a whole-profile copy at any step of 7.4 (prepare and send apart), a move, a lost answer | 9 / 32,490 |
| fork | a copy and a move, one retained key | 9 / 50,129 |
| wire | a stranger, a late duplicate, one field changed in flight, a body naming a seen key | 8 / 45,502 |
| forget | her notes' memory of a command goes back (not the act store), a loss, two moves | 10 / 21,876 |
| inherit | A's storage goes back one step (no copy), a move | 10 / 12,367 |
Gate total 538,845 states, sound runs about 33 s, whole file 59.9 s (RAN 2026-11-13, load average 4 to 6; question (g) at the full gate depth). Deep (one step deeper): honest 10/468,576, moves 12/241,868, tabs 9/161,412, full 10/106,667, gate 9/40,528, copy 10/95,537, fork 10/124,574, wire 9/133,425, forget 11/48,326, inherit 11/25,041: 1,445,954 states, all clean, 163 s with the questions at load up to 18 (RAN). Second configuration (RAN): 3 retained keys one step shallower (honest 8/49,135, moves 10/47,785, copy 8/10,385) and burned capacity 2 with two earlier locks (fork 9/49,355): all clean; the third lock stays (fails closed). Faults and replays run at their own recorded depths. Progress (honest, moves, tabs, full, gate): from every quiescent state and every state where the holder holds, fair events only (deliver, process, the holder's 7.4 cycle) reach "no pending row, the holder in step with an empty journal and no open intent, holding nothing" within 14 events.

## Findings against draft 6, now in draft 7's text (each modelled both ways; `amend: []` is draft 6)
- **F8** (7.4 steps 3 and 5, with section 16 "do not retry that position"): a body whose open intent was never placed meets a pending row another body left; nothing in 7.4 clears another body's row, and its own intent can never be placed. No lock, no hold, but A never acts again until a move to the body that placed the row (10 steps, moves). Amendment `ResolveOtherPendingFirst` (on in the sound model): while `status` shows a pending row that is not the open intent's, the body first commits or abandons it under a journal entry of its own, keeping its open intent.
- **F9** (7.4 step 5, first and last bullets): "Nothing else retires it" against "stays until its row is terminal or it never got one". Read strictly, an intent refused at creation (gate DENY, ledger full) is never retired and the body can never issue another (4 steps). Modelled: a creation refusal with no row retires it with that outcome.
- **F10** (bench): `GenerationsComparedInStep5` cannot differ: a verified answer is the answer as first given, under an envelope verified at the holder's generation; no verified answer in any explored state named another generation (probe), and the mutant explores the same states. Retired with `PromoteWithoutGenCheck`.

## Not modelled
A destination with no holder; the lineage (one world); real signatures (only a key's holder signs with it; a changed field fails); ambient owner access and the route checks of 6.1 other than the session; the switch `WORLD_ACT`; HEAD's lease; thread writes; sign-in expiry; more than one lease expiry, clock skew; the 1,024 burned thumbs and 32 retained keys beyond the scaled values; the gate beyond four payloads and two policies; `courtResult`; evidence contents; reads failing (status, pending and row are atomic reads); a cycle overlapping its own in-flight request in one tab (the cycle that sent it holds the lock until its answer).

## AMBIGUITIES (the text did not decide; the reading modelled)
1. A hold ends on a reload or when `status` shows a holder generation above the one the refusal reported; it is not in the store; a held body ignores later answers.
2. `status` while the stored row is another key's chain: the selected (new) chain.
3. A new chain has no `startedAtGeneration` until its first verification (stale before, revoked after).
4. "A successor the chain has seen": the current key, the first key and the retained used keys.
5. "Placed under a chain that was locked" is the row's chain first thumb being burned.
6. Step 6 of 7.4 for an answer to another digest: ignored, whatever its code.
7. `commit` and `abandon` with command bytes: `CAPSULE_ACTION_ID_MISMATCH`.
8. A new sign-in leaves the old session valid; requests carry the session they were sent under.
9. With no open intent the body takes a pending row at the head as its open intent (M6's "B reads it ... commits once"); 7.4 does not say so.
10. A promotion through `status` whose `row` read finds no row keeps the open intent and sends it again (the refusal's code is not in `status`).
11. When a 7.2 burned list is full, a locked chain is kept as the selected chain: every envelope gets `BODY_KEY_FORKED`.
12. SETTLED by draft 7, 6.5a "The row in an answer": a commit DENY carries this action's pending row, a creation DENY none. The client reads `row` only on `CAPSULE_GATE_DENIED` (pending row: the intent stays; none: retired) and does exactly that (test "draft 7, 6.5a"). The door's symbolic `row` is this action's row state in every answer: equal to 6.5a for results and for the codes about this action's own row, but `CAPSULE_INTENT_ALREADY_PLACED` and `CAPSULE_ACTION_CONFLICT` carry null here (6.5a: the row in the way), and other refusals about an existing row of this action carry its state (6.5a: null). No client outcome reads those; aligning them changes the answers, so the state counts.
