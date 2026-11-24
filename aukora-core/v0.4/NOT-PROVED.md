# What is NOT proved in v0.4 (written by the second seat, 22 November 2026)

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
7. **An approval is not bound to a record.** A plain approval's signature names no record and no position:
   another record with the same owner keys, or a rolled-back copy, admits it again (second seat, RAN on v0.1 and
   v0.3; not re-run on v0.4, where the wire for it is unchanged as far as the second seat knows). Round 12c.
8. **The newest lines can be dropped.** A record cut at its end replays cleanly. Only a head remembered or
   co-signed outside shows it. No witness format is built (round 13).
9. **It is a witness, not a lock.** Nothing downstream is forced to check that an act was admitted (round 13).
10. **The host is believed** for assessments, bundle digests, read results, cell results, the time, and for
    appending a halt after a refused act.

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
