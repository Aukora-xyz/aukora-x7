# Hardening round 1: proofs over the v0.10 machine

Two files of Lean, checked by the Lean 4.19.0 kernel against the frozen v0.10 sources (they import them and change
nothing in them). Each prints the axioms its theorems rest on; none rests on `sorryAx`.

## `BoundEffects.lean`: the refusal of the two old forms, stated on what the machine DOES
In v0.10 a record started bound refuses the plain approval and the old key change, as the decoder classifies frames.
These two theorems state it on the EFFECTS, so no other route to the same effect is left open by them. For every
state reachable from a bound start and every frame the public machine admits:
- `bound_grant_source`: if a grant appears that was not held before, the frame is a TIMED approval (a signed issue
  whose signed message names a parent head and a position), signed by both of the owner's current keys;
- `bound_owner_change`: if the owner's keys change, the frame is the newer key change (both signatures over a
  message that carries the head) or the extension dialect's key change, addressed to the current head and position.
Axioms: `propext`, `Classical.choice`, `Quot.sound`.

## `Obligations.lean`: four properties a monitor must have, named for this machine
1. `refusal_noop`: a refused input leaves the state exactly as it was.
2. `deny_overrides`: a form on the refused list is refused, whatever the inner machine would have said.
3. `order_free`: two refused lists with the same members refuse exactly the same inputs.
4. `refused_constant`, `never_loses`: along any history, with seals and continuations, the list never changes, so
   what a record refuses never shrinks.
And `not_bypassable`: every history of the public machine equals a history of the inner machine over exactly the
inputs the record does not refuse.
Most of these follow from laws v0.10 already has; this file names them in one place.

## To check them
They need the compiled v0.10 library: copy both files into a staged v0.10 build's `Proofs/` folder, add
`Proofs.BoundEffects` and `Proofs.Obligations` to the module list in its `tools/check.py`, and build. The build of
23 November 2026 printed the axiom lines above. Everything here is about the Lean model; the compiled files are
compared, not proved (`drt/`).
