import Proofs.FinalPolicies

/-! Round 12c D, step 1. The frozen law `PriorVerdicts` (a clause of `w1` in the 37)
fixes the verdict of every legacy non-install frame on every state. A plain approval
(tag 13 hex = 19) and a legacy key change (tag 14 hex = 20) sign no ledger head and no
record. These theorems state, for every model satisfying the frozen clause, that such a
frame is admitted wherever the frozen reference admits it on a state that is not halted,
and that the reference's owner check of either form reads no head and no record. -/

namespace Aukora.BindingConflict
open Release
open R6.KernelCell (Context)

/-- Any legacy, non-install frame that is not an act is admitted by every model
    satisfying `PriorVerdicts` whenever the frozen reference admits it and the state is
    not halted. No owner rule, mode or record field enters. -/
theorem forced {m : Model} (law : RootFinal.PriorVerdicts m) {ctx : Context} {w : ByteArray}
    {s t : Release.State} {c : Policy9.Command}
    (legacy : w[0]? ≠ some (255 : UInt8)) (nonInstall : w[0]? ≠ some (27 : UInt8))
    (notAct : ∀ i, c ≠ .use i) (dec : Policy9.decode w = some c)
    (running : Safe11.halted s = false) (ref : Policy9.step w s = some t) :
    ∃ u, m.step ctx w s = some u := by
  have h := law ctx w s legacy nonInstall
  rw [dec] at h
  cases c with
  | use i => exact absurd rfl (notAct i)
  | _ =>
    have admitted : (m.step ctx w s).isSome = true := by simpa [running, ref] using h
    exact Option.isSome_iff_exists.mp admitted

/-- Plain approval (tag 13 hex): forced admission on every lawful machine. -/
theorem forced_approval {m : Model} (law : RootFinal.PriorVerdicts m) {ctx : Context}
    {w : ByteArray} {s t : Release.State} {x : Wire5.Frame} {ml : Bytes}
    (tag : w[0]? = some (19 : UInt8)) (dec : Policy9.decode w = some (.ordinary x (.signed ml)))
    (running : Safe11.halted s = false) (ref : Policy9.step w s = some t) :
    ∃ u, m.step ctx w s = some u :=
  forced law (by rw [tag]; decide) (by rw [tag]; decide) (fun _ h => by cases h) dec running ref

/-- Legacy key change (tag 14 hex): forced admission on every lawful machine. -/
theorem forced_key_change {m : Model} (law : RootFinal.PriorVerdicts m) {ctx : Context}
    {w : ByteArray} {s t : Release.State} {p : Digest} {n : Nat} {keys : Hybrid7.Keys} {ed ml : Bytes}
    (tag : w[0]? = some (20 : UInt8)) (dec : Policy9.decode w = some (.rebind p n keys ed ml))
    (running : Safe11.halted s = false) (ref : Policy9.step w s = some t) :
    ∃ u, m.step ctx w s = some u :=
  forced law (by rw [tag]; decide) (by rw [tag]; decide) (fun _ h => by cases h) dec running ref

/-- The reference owner check of a plain approval reads only the owner keys and the
    nonce view: two frames with the same approval (any parent and sequence, so any
    re-wrapping) on two states with the same keys and the same nonce verdict get the
    same answer. The signed message names no head and no record. -/
theorem approval_reads_no_record {v : Hybrid7.Verifiers} {a b : Hybrid7.Machine}
    {x y : Wire5.Frame} {i : Intent} {sig pq : Bytes}
    (ax : x.action = .grant i sig) (ay : y.action = .grant i sig) (keys : a.owner = b.owner)
    (nonce : Bound5.usedNonce (Hybrid7.edView a) i = Bound5.usedNonce (Hybrid7.edView b) i) :
    Hybrid7.authorized v a x (.signed pq) = Hybrid7.authorized v b y (.signed pq) := by
  simp only [Hybrid7.authorized, ax, ay, Hybrid7.signatureOK, keys, nonce]

/-- The same for the legacy key change: only the owner keys and the generation are read. -/
theorem key_change_reads_no_record {v : Hybrid7.Verifiers} {a b : Hybrid7.Machine}
    {x y : Wire5.Frame} {ed sig ml pq : Bytes}
    (ax : x.action = .rebind ed sig) (ay : y.action = .rebind ed sig) (keys : a.owner = b.owner)
    (gen : Hybrid7.generation a = Hybrid7.generation b) :
    Hybrid7.authorized v a x (.binding ml pq) = Hybrid7.authorized v b y (.binding ml pq) := by
  simp only [Hybrid7.authorized, ax, ay, Hybrid7.signatureOK, keys, gen]

#print axioms forced
#print axioms forced_approval
#print axioms forced_key_change
#print axioms approval_reads_no_record
#print axioms key_change_reads_no_record
end Aukora.BindingConflict
