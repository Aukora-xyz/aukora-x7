# What is NOT proved in v0.8

Read this before `PROVED.md`. This is research code from a lab. These are the limits we know of. The list is not
a guarantee that there are no others; a limit that is missing here is a defect of this page.

## The standing limits
1. **The proofs are about the Lean model.** One text is both proved and compiled, but nothing proves the compiled
   WebAssembly behaves as the model. Byte-identical rebuilds, stored vectors and side-by-side runs of one core
   against the next are evidence, not proof. The Lean compiler, the C compiler and the runtime are trusted.
2. **The judge is compared, not proved.** The comparison covers the actual compiled checker, runtime, goal
   constructor and initialized declaration bytes. Whether those handlers implement the carried model, and whether
   the host continues the ledger, remain unproved.
3. **Upgrades may change law data only.** A successor must carry the identical executable. The machine cannot be
   changed through this gate.
4. **The proof checker inside Wasm takes earlier theorem statements as given**, plus opaque declarations and
   `Classical.choice`. The count for this release was not independently re-derived.
5. **Cryptography is tested, not proved**: Ed25519, ML-DSA-65 (two `partial` rejection-sampling loops), SHA-256,
   SHA-512, SHAKE. Timing side channels were never examined. `NoCollision` (SHA-256) and `SignatureOnce` (one pair
   of signatures does not verify for two different key-and-message pairs) are NAMED ASSUMPTIONS in the laws that
   use them.
6. **Raw owner keys, not a passkey.** A lost pair of keys ends the record. A key change is signed by the old keys
   only; the new keys do not prove possession.
7. **OPEN DEFECT: two old command forms name no record.** The plain one-time approval (first byte 13 hex) and the
   old key change (first byte 14 hex) sign the owner's keys and the intent or the new keys, but no record and no
   position. OBSERVED ON THESE BYTES, for the approval: one approval signature was admitted, and its act carried
   out, in two different bound records of the same owner. The same run was not made for the old key change; its
   signed message names no record either. In v0.8 the LAW SET no longer forces this (see `PROVED.md`, "the
   owner's restriction list"), but the MACHINE is unchanged and still admits both forms everywhere. An owner whose
   tools never sign those two forms is not exposed; the core does not enforce that. Use the timed approval and
   the newer key change, which sign the head.
8. **The newest lines can be dropped.** A record cut at its end replays cleanly. Only a head remembered or
   co-signed outside shows it. `standalone/checkpoint.mjs` can produce checkpoints; nobody keeps them for you.
9. **It is a witness, not a lock.** Nothing downstream is forced to check that an act was admitted.
10. **The host is believed** for assessments, bundle digests, read results, cell results, the time, and for
    appending a halt after a refused act.

## Records and their edges
11. **Finite segments.** 512 ordinary entries or 2 MiB per segment, a 16-entry reserve usable only by a valid clear
    or key change, then one seal. These are lab numbers. When the reserve is spent and the segment is not sealed,
    the only way on is a new genesis.
12. **Speech can still fill a segment.** Unsigned lines are free, so any caller can drive a record to its ordinary
    limit; the owner can then recover, seal and continue, but cannot approve or control until they do.
13. **A refused recovery frame consumes no reserve: tested, not proved as its own law.**
14. **OPEN DEFECT: a record's whole chain has an end, and the end is a crash.** A running core keeps every earlier
    segment and its memory is capped at 256 MiB; nothing lets a fresh core start from a seal. ONE measurement, on
    an earlier small core with 3,000-byte lines: 68 segments sealed and continued, then a trap inside the 69th
    after about 35,000 lines (102 MiB of lines); afterwards nothing more could be added, not even a seal. NOT
    re-measured on these bytes; the figure is one run, not a capacity. From the source, the cause stands: the halt flag, the evidence ceiling and the installed pin
    are each recomputed over the whole record on every step.
15. **Out-of-memory can still trap** inside the runtime before the declared limits refuse.

## Record binding (laws b1 to b4) and its edges
16. **Binding needs a bound start.** A record started the old way has no identifier; two old-start records with the
    same keys accept each other's head-signed frames byte for byte.
17. **The re-addressing law (b4) covers four kinds**: timed approval, cancel, signed control, threshold. For halt,
    clear, the newer key change and the seal, "a signature cannot be moved onto another record's frame" is tested
    in Wasm, not proved.
18. **Host values are a namespace the host governs; collisions are silent.** The same keys and the same 32-byte
    host value give the same identifier: one record twice.

## The owner's restriction list (new in v0.8) and its edges
19. **Nothing reads or writes the list yet.** The state has the registers (`id`, `refused`, `enabled`, `limits`,
    `judge`) and the laws allow a form in `refused` to be refused, but no step looks at them and no frame can
    change them. On every record that can exist today the list is empty.
20. **The 44 laws as a whole are not shown to permit refusing.** One clause is shown not to force admission
    (`forced_blocked`). No machine satisfying all 44 that refuses a refused approval has been exhibited.
21. **The table of forms is not proved to agree with the decoder.** Tested on 14 real admitted frames of 13 of the
    31 forms. The numbering is not final and will change before any release that enforces it.

## Lineage, builds and scope
22. **This is a new starting point, not an upgrade of earlier lab cores.** Its law identity differs, and a record
    made under an earlier identity is not upgraded in place (an earlier judge refused the first package of this line;
    reported from one run). Old-start records replay.
23. **Succession preserves exactly the laws pinned, including mistakes.** A wrong law is inherited until a stronger
    set replaces it; nothing can remove it short of a new genesis.
24. **The pin law covers changes through the gate.** That genesis pins the proved set is checked by a build
    script, not by a law.
25. **Version stability is stated in Lean, not as a table a reader can check**, and is proved for the version pair
    that exists.
26. **Built on one machine.** Two independent from-scratch builds on the same Apple-silicon Mac gave these exact
    bytes. That does not show the README's procedure works from an empty folder; its status is stated in the
    README under "Rebuild from source". The build pins macOS ARM64 tools. No Linux build has been tried.
27. **No live effect anywhere is governed by this core.** A read-only replay of a sample record may run inside an
    application; that shows the file runs and governs nothing. No claim of novelty is made. The licence
    (AGPL-3.0-or-later) applies to the files in this tree written by the Aukora authors.
