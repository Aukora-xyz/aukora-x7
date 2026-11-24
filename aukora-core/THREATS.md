# Threat model

One page. What the core is built to withstand, what it trusts, and what it does not try to do.

## What the core is
A pure function, compiled to WebAssembly with no imports, that reads a record one frame at a time and says
admitted or refused. An admitted frame is appended to a hash-chained record. Approvals are signed by an owner with
two keys at once (Ed25519 and ML-DSA-65). The core keeps no secret and makes no call out.

## The adversary
- **Is the agent, and everything the agent reads.** It can put any bytes in front of the core, in any order, as
  often as it likes: forged frames, frames signed for another record, old frames replayed, frames cut short or
  extended, garbage. It can read every line of this repository, including the laws.
- **Cannot** change the core bytes the host has pinned by digest, and cannot use the owner's private keys.

What the Lean model is proved to do against this adversary is stated as laws in `v0.8/PROVED.md` (and for the next line in `NEXT-LINE.md`), each
about the Lean model. The ones that matter most against this adversary:
- an act that needs approval is refused unless a current approval for exactly that act exists, and an approval is
  spent once within one record (in v0.8 an old plain approval was used again in a second record: open defect 1 in the README);
- a frame built on a stale head or a stale position is refused, and leaves the state unchanged;
- owner commands need both of the owner's current signatures;
- in a record started bound (v0.10), the two old command forms that name no record are refused, and a new
  grant or a change of the owner's keys can come only from a form that signs the record's head (`hardening/BoundEffects.lean`; mandates, budgets and passes are not covered by that law);
- a refused input changes nothing.

## What is trusted (and so is a place to look for faults)
- **The host.** It chooses which bytes reach the core. It is believed for the time, for assessments and bundle
  digests, and for appending a halt after a refused act. It can drop the newest lines of a record; only a head kept
  elsewhere shows that.
- **The compilers and the runtime.** The proofs are about the Lean text. Lean's compiler, the C compiler, the
  WebAssembly runtime and the small C shim that maps exports to Lean functions are trusted. The shim also keeps
  the segment limits and the record identifier; that logic is tested, not proved. The compiled files are compared
  with each other by differential tests (`drt/`); that is evidence, not proof.
- **The cryptography.** Ed25519, ML-DSA-65, SHA-256, SHA-512 and SHAKE are tested against vectors, not proved.
  Two properties are NAMED ASSUMPTIONS in the laws that use them: SHA-256 gives different digests to the different
  byte strings compared (`NoCollision`), and one pair of signatures does not verify for two different
  (keys, message) pairs (`SignatureOnce`).
- **The proof checker** that gates changes of the law set, inside the full file. It is compared, not proved.

## Out of scope
- **Enforcement.** The core is a witness, not a lock. Nothing forces a system to ask it, or to obey a refusal. The
  sink rehearsal (`bailiff-rehearsal/`) shows the shape of a door that applies nothing without the core's yes; it is
  wired into nothing.
- **Meaning.** The core checks that the owner approved these exact bytes. Whether the owner should have approved
  them is not its question.
- **Timing and other side channels**, and attacks on the machine the host runs on.
- **Filling a record.** Unsigned lines are free, so anyone can fill a segment to its limit; the owner can still
  recover, seal and continue. A record's whole chain still ends in a trap: after 34,987 lines of 3,000 bytes
  in one measurement on the shipped small core (open defect, stated on the front page).
- **Lost keys.** A lost pair of owner keys ends the record. There is no recovery without them.
