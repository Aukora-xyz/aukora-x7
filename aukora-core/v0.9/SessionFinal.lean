import Proofs.Round11Safe
import Bounds12

namespace Aukora.SessionFinal
open R6.KernelCell (Context)

def reserveSlots := 16
def ordinaryFits (count used size : Nat) : Bool :=
  decide (count < Bounds12.maxEntries ∧ used + size ≤ Bounds12.maxRecordBytes)

/-- The fixed entry reserve is also backed by 16 times the maximum legal submission.
    Bytes are charged on acceptance and are allocated only when actually used. -/
def reserveBytes := reserveSlots * Bounds12.maxInput

def candidateRecovery (w : ByteArray) : Bool :=
  match Safe11.route w with
  | .clear | .rebind => true
  | _ => if w[0]? = some (20 : UInt8) then
      match Policy9.decode w with | some (.rebind ..) => true | _ => false
    else false

@[export r12b_recovery_kind] def recoveryKind (w : ByteArray) : UInt32 :=
  if candidateRecovery w then 1 else 0

structure Quota where
  entries : Nat := 0
  bytes : Nat := 0
  reserved : Nat := 0
  closed : Bool := false
  deriving DecidableEq

/-- Charge only a successful operation. One independent fixed-size trailer always
    remains available to seal an open segment, even after all recovery slots are spent. -/
def charge (q : Quota) (size : Nat) (recovery : Bool) : Option Quota :=
  if q.closed || decide (Bounds12.maxInput < size) then none
  else if ordinaryFits q.entries q.bytes size then
    some {q with entries := q.entries + 1, bytes := q.bytes + size}
  else if recovery && decide (q.reserved < reserveSlots) then
    some {q with reserved := q.reserved + 1}
  else none

def frame (m : Release.Model) (ctx : Context) (q : Quota) (s : Release.State) (w : ByteArray) :
    Option (Quota × Release.State) := do
  let q' ← charge q w.size (candidateRecovery w)
  let t ← m.step ctx w s
  return (q',t)

def stamp (m : Release.Model) (q : Quota) (s : Release.State) (w : ByteArray) :
    Option (Quota × Release.State) := do
  let q' ← charge q w.size false
  let t ← m.stamp w s
  return (q',t)

def Recovery (m : Release.Model) : Prop :=
  (∀ ctx q s w, q.closed = false → q.reserved < reserveSlots → w.size ≤ Bounds12.maxInput →
    Safe11.ValidClear s w → ∃ q' t, frame m ctx q s w = some (q',t) ∧ Safe11.halted t = false) ∧
  (∀ ctx q s w, q.closed = false → q.reserved < reserveSlots → w.size ≤ Bounds12.maxInput →
    Safe11.route w = .rebind → Safe11.shape s w 53 = true → Safe11.Both s w 53 →
    Hybrid7.validKey (Safe11.newKeys s w) = true → ∃ q' t, frame m ctx q s w = some (q',t) ∧
      t.base.hybrid.owner = Safe11.newKeys s w ∧ Policy9.pool t.base = [] ∧
      Policy9.generation t = Policy9.generation s + 1 ∧ Safe11.halted t = Safe11.halted s)

private theorem room {q w} (opened : q.closed = false) (slots : q.reserved < reserveSlots)
    (size : w.size ≤ Bounds12.maxInput) (valid : candidateRecovery w = true) :
    ∃ q', charge q w.size (candidateRecovery w) = some q' := by
  cases ordinary : ordinaryFits q.entries q.bytes w.size <;>
    simp [charge,opened,Nat.not_lt_of_ge size,ordinary,valid,slots]

theorem full_recovery : Recovery Safe11.fullModel := by
  constructor
  · intro ctx q s w opened slots size clear
    have kind : candidateRecovery w = true := by simp [candidateRecovery,clear.1]
    obtain ⟨q',ready⟩ := room opened slots size kind
    obtain ⟨t,ok,flag⟩ := Safe11.full_safe.recovery.1 ctx s w clear
    exact ⟨q',t,by simp [frame,ready,ok],flag⟩
  · intro ctx q s w opened slots size route shape both keys
    have kind : candidateRecovery w = true := by simp [candidateRecovery,route]
    obtain ⟨q',ready⟩ := room opened slots size kind
    obtain ⟨t,ok,rest⟩ := Safe11.full_safe.recovery.2 ctx s w route shape both keys
    exact ⟨q',t,by simp [frame,ready,ok],rest⟩

theorem reserve_owner_only {m : Release.Model} {ctx q s w q' t}
    (full : ordinaryFits q.entries q.bytes w.size = false)
    (hit : frame m ctx q s w = some (q',t)) :
    candidateRecovery w = true ∧ m.step ctx w s = some t ∧ q'.reserved = q.reserved + 1 := by
  obtain ⟨a,charged,after_⟩ := Option.bind_eq_some.mp hit
  obtain ⟨v,ok,e⟩ := Option.bind_eq_some.mp after_
  cases Option.some.inj e
  by_cases valid : candidateRecovery w = true
  · refine ⟨valid,ok,?_⟩
    unfold charge at charged
    split at charged <;> try contradiction
    simp only [full,Bool.false_eq_true,if_false] at charged
    split at charged <;> cases charged <;> rfl
  · simp [charge,full,valid] at charged

theorem exhausted {m : Release.Model} (ctx q s w)
    (full : ordinaryFits q.entries q.bytes w.size = false) (spent : reserveSlots ≤ q.reserved) :
    frame m ctx q s w = none ∧ stamp m q s w = none := by
  simp [frame,stamp,charge,full,Nat.not_lt_of_ge spent]

theorem sealed_frames (m : Release.Model) (ctx q s w) (sealed_ : q.closed = true) :
    frame m ctx q s w = none ∧ stamp m q s w = none := by simp [frame,stamp,charge,sealed_]

/-- A universally accepting clear and absolute closure would give opposite
    verdicts for the same valid clear at a sealed state. -/
theorem closed_excludes_unconditional (m : Release.Model) (ctx q s w)
    (closed : q.closed = true) (valid : Safe11.ValidClear s w) :
    Safe11.ValidClear s w ∧ ¬ ∃ v, frame m ctx q s w = some v :=
  ⟨valid,by rw [(sealed_frames m ctx q s w closed).1]; simp⟩

#print axioms full_recovery
#print axioms reserve_owner_only
#print axioms exhausted
#print axioms sealed_frames
#print axioms closed_excludes_unconditional
end Aukora.SessionFinal
