# What is NOT proved in v0.6 (v0.4 text by the second seat, 22 November 2026; round 12c D additions by the Claude coder, 23 November 2026)

Read this before `PROVED.md`. v0.4 is a LAB release, finished by the second seat after the builder ran out of
allowance; an independent re-run by a seat that did not finish it is still owed.

## The standing limits
1. **The proofs are about the Lean model.** A digest in the file names the model it claims; conformance vectors
   and byte-identical rebuilds are evidence. Nothing proves the compiled Wasm behaves as the model.
2. **The judge is compared, not proved.** "The comparison covers the actual compiled checker, runtime, goal
   constructor and initialized declaration bytes. Whether those handlers implement the carried model, and whether
   the host continues the ledger, remain unproved."
3. **Upgrades may change law data only.** A successor must carry the identical executable. The machine cannot be
   changed through this gate. Splitting the judge from the machine is round 12c's job and is not built.
4. **The proof checker inside Wasm takes earlier theorem statements as given** (506 in v0.2; the count for v0.4
   was not re-derived by the second seat), plus opaque declarations and `Classical.choice`.
5. **Cryptography is tested, not proved**: Ed25519, ML-DSA-65 (two `partial` rejection-sampling loops), SHA-256,
   SHA-512, SHAKE. Timing side channels were never examined.
6. **Raw owner keys, not a passkey.** A lost pair of keys ends the record. A key change is signed by the old keys
   only; the new keys do not prove possession (round 14).
7. **Plain approvals and legacy key changes stay replayable across records (v0.6, round 12c D).** A plain approval (tag 13) and a legacy key change (tag 14) name no head and no record; the frozen law PriorVerdicts forces every lawful machine to admit them on any record with the same owner keys. An owner who never signs those two forms is not exposed; the core does not enforce that.
   Kernel-checked in v0.6: `BindingConflict.forced_approval`, `BindingConflict.forced_key_change` (each conditional
   on the frozen reference admitting the frame). RAN in Wasm (`tests/record-binding.mjs`, both cores): both forms, signed for one bound
   record and re-wrapped under another's head, are admitted (`LIMIT HELD BY THE FROZEN LAWS`), so the two-record case occurs. Removing the limit needs a restated root (root v2),
   not built here.
   A rolled-back copy of the SAME record still admits an unspent approval again; only an outside witness shows it.
7a. **The host must keep the descriptor.** A bound record's first head is SHA-256 of its descriptor (`AUKORA/R12C/record`,
   law digest, keys, host value). The descriptor is not in the record. A lost descriptor (or host value) means the
   record cannot be replayed: its first frame names the identifier as its parent, and any other descriptor refuses
   it from line one.
   A host that starts a record twice with the same host value has started ONE record twice; the two copies share an identifier and every signature travels between them. Only an outside keeper of the record's head shows it.
7b. **B1, B2 and b4 rest on stated assumptions.** Each statement assumes SHA-256 gives different digests to the
   different byte strings on the two histories compared. Nothing about SHA-256 is proved. B2 is about the same bytes
   (its `HeadSigned` list is not used by its proof). The re-addressing law b4 (round 12c D2) adds a second named
   assumption, `Rebinding.SignatureOnce`: for the two messages that actually occur, one pair of signatures does not
   verify for two different (keys, message) pairs. That is an assumption about Ed25519 and ML-DSA-65 as implemented
   here, tested and not proved. b4 covers the timed approval, cancel, signed control and threshold only; the ff 02
   halt, clear and key change and the seal are NOT covered by b4. Their signed message carries the generation as
   variable-width decimal text, and the needed parsing fact about that text was not proved in this job. The
   second seat's Wasm test (`tests/record-rebinding.mjs`) covers them by test only.
7c. **Bound genesis is outside `m.genesis`.** It is a separate function (`Bound12c.genesis`), like seal and
   continuation. Since round 12c D2 the start clauses of the 37 (record view, memory, outcome, the start part of
   grants, floor, the initial threshold) are also proved for a bound start, as law b3 (`BoundStart.full_start`).
   `record.ledger` needs no twin: its conclusion does not mention the start.
7d. **Seal and continuation in B1 are modelled with any journal and law argument** the adapter could pass (an
   over-approximation). The identifier kept by the adapter (`recordIdByte`) is adapter state, not Lean state; its
   constancy is tested, not proved.
8. **The newest lines can be dropped.** A record cut at its end replays cleanly. Only a head remembered or
   co-signed outside shows it. No witness format is built (round 13).
9. **It is a witness, not a lock.** Nothing downstream is forced to check that an act was admitted (round 13).
10. **The host is believed** for assessments, bundle digests, read results, cell results, the time, and for
    appending a halt after a refused act.

7e. **Law `pinned` (round 12c A) is about the checker's verdict.** It says the pinned checker accepted a proof that
   the carried machine satisfies the set it pins. Standing limit 2 still applies in full. The genesis build check
   compares the identity the compiled core reports with the identity derived from the type of `full_lawful` in the
   building Lean environment; it is a build step (RAN, shown failing on a changed byte and on the round-12
   configuration), not a theorem. Both sides use the manifest format tag `R12B/1`.

## New in this version, and their edges
11. **Finite records.** 512 ordinary entries or 2 MiB per segment, a 16-entry reserve usable only by a valid clear
    or key change, then one seal. These are lab numbers. When the reserve is spent and the record is not sealed,
    the only way on is a new genesis: loss of continuity. That is the residual lockout.
12. **Speech can still fill a record.** Unsigned lines are free, so any caller can drive a record to its
    ordinary limit; the owner can then recover, seal and continue, but cannot approve or control until they do.
13. **A refused recovery frame consuming no reserve** is believed from the design (`SessionFinal.reserve_owner_only`)
    and was not separately tested by the second seat.
14. **Succession preserves exactly the laws pinned, including mistakes.** A wrong law is inherited until a stronger
    set replaces it; nothing can remove it short of a new genesis. Two lessons already cost a round each: do not
    pin a promise that something always succeeds; do not pin a clause that names a version.
15. **Nothing forbids pinning an unsatisfied set in general.** This build's set IS satisfied by its machine
    (`full_lawful`); a law of the gate that makes the opposite impossible is round 12c's job.
16. **Version stability is stated in Lean, not yet as a table a reader can check**, and it is proved for the
    version pair that exists; every later version owes its own proof.
17. **No law-lineage continuity from v0.1, v0.2 or v0.3.** This root is weaker than v0.1's in availability, so
    moving from an earlier lab core to it is not a ratchet step. Earlier records without installs replay.
18. **Reproduced on one machine**, by two builds of one seat (the finisher). The build reads files outside this
    folder and pins macOS ARM64 tools.
19. **Out-of-memory can still trap** inside the runtime before the declared limits refuse; the limits bound what
    the model admits, not every allocation.
20. Nothing here runs in any live system. No claim of novelty is made.
