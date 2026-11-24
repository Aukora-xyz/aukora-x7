# What is NOT proved in v0.5 (the same machine and Wasm bytes as lab v0.4)

Read this before `PROVED.md`. v0.5 is a lab release. Its two Wasm files are byte-identical to lab v0.4; the
differences are wording, one link replaced by a file, and one added test. It has been re-run once by an
independent reviewer on the same machine. A rebuild on a separate machine is still owed.

## The standing limits
1. **The proofs are about the Lean model.** A digest in the file names the model it claims; conformance vectors
   and byte-identical rebuilds are evidence. Nothing proves the compiled Wasm behaves as the model.
2. **The judge is compared, not proved.** "The comparison covers the actual compiled checker, runtime, goal
   constructor and initialized declaration bytes. Whether those handlers implement the carried model, and whether
   the host continues the ledger, remain unproved."
3. **Upgrades may change law data only.** A successor must carry the identical executable. The machine cannot be
   changed through this gate. Splitting the judge from the machine is planned and is not built.
4. **The proof checker inside Wasm takes earlier theorem statements as given** (506 in v0.2; the count for
   this release was not independently re-derived), plus opaque declarations and `Classical.choice`.
5. **Cryptography is tested, not proved**: Ed25519, ML-DSA-65 (two `partial` rejection-sampling loops), SHA-256,
   SHA-512, SHAKE. Timing side channels were never examined.
6. **Raw owner keys, not a passkey.** A lost pair of keys ends the record. A key change is signed by the old keys
   only; the new keys do not prove possession. Planned, not built.
7. **An approval is not bound to a record, and this law set makes that permanent.** A plain approval's
   signature names no record and no position: another record with the same owner keys, or a rolled-back copy,
   can admit it again (observed on v0.1 and v0.3; the wire for it is unchanged here; not re-run on these bytes).
   The old key-change form has the same property. Worse: one of the 37 laws, `PriorVerdicts`
   (`Proofs/FinalPolicies.lean`), fixes the verdict of every old-format frame on every state, so EVERY lawful
   successor of this root must admit such a frame too. The cure is a restated root, not a patch. Until then an
   owner who never signs those two old forms is not exposed; the core does not enforce that.
8. **The newest lines can be dropped.** A record cut at its end replays cleanly. Only a head remembered or
   co-signed outside shows it. No witness format is built into the core.
9. **It is a witness, not a lock.** Nothing downstream is forced to check that an act was admitted.
10. **The host is believed** for assessments, bundle digests, read results, cell results, the time, and for
    appending a halt after a refused act.

## New in this version, and their edges
11. **Finite records.** 512 ordinary entries or 2 MiB per segment, a 16-entry reserve usable only by a valid clear
    or key change, then one seal. These are lab numbers. When the reserve is spent and the record is not sealed,
    the only way on is a new genesis: loss of continuity. That is the residual lockout.
12. **Speech can still fill a record.** Unsigned lines are free, so any caller can drive a record to its
    ordinary limit; the owner can then recover, seal and continue, but cannot approve or control until they do.
13. **A refused recovery frame consumes no reserve: tested, not proved as its own law.** `tests/reserve-refusals.mjs`
    on both files: 40 recovery frames from a stranger and 20 malformed ones refused, then exactly 16 valid ones
    admitted, then refusal, replay equal. The design law is `SessionFinal.reserve_owner_only`.
14. **Succession preserves exactly the laws pinned, including mistakes.** A wrong law is inherited until a stronger
    set replaces it; nothing can remove it short of a new genesis. Two lessons already cost a round each: do not
    pin a promise that something always succeeds; do not pin a clause that names a version.
15. **Nothing forbids pinning an unsatisfied set in general.** This build's set IS satisfied by its machine
    (`full_lawful`); a law of the gate that makes the opposite impossible is planned and not built.
16. **Version stability is stated in Lean, not yet as a table a reader can check**, and it is proved for the
    version pair that exists; every later version owes its own proof.
17. **No law-lineage continuity from v0.1, v0.2 or v0.3.** This root is weaker than v0.1's in availability, so
    moving from an earlier lab core to it is not a ratchet step. Earlier records without installs replay.
18. **Reproduced on one machine only**: two from-scratch builds by one reviewer and one independent re-run by
    another, all on the same Mac (the first complete pass against the final pins was the independent re-run). The build reads files outside this folder and pins macOS ARM64 tools, so a
    stranger cannot rebuild it from this folder alone.
19. **Out-of-memory can still trap** inside the runtime before the declared limits refuse; the limits bound what
    the model admits, not every allocation.
20. **A record's whole chain is limited by memory, and the limit is a crash.** A running core keeps every earlier
    segment and its memory is capped at 256 MiB; nothing lets a fresh core start from a seal. Measured on the
    small file with 3,000-byte lines: 68 segments sealed and continued, then a trap inside the 69th after about
    35,000 lines (102 MiB of lines). A fresh core replays everything accepted before that and traps on the same
    next line; afterwards nothing more can be added, not even a seal. Not measured on the full file or with
    small lines. Sealing gives room per segment, not an unbounded record.
21. Nothing here runs in any live system. No claim of novelty is made.
