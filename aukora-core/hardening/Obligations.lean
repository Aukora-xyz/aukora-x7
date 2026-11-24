import Proofs.BoundRefuses
import Proofs.WrapRuns

/-! Hardening round 1. Four properties a published verified policy engine for agents names as the ones a monitor
must have, stated here as obligations of THIS machine (the public machine of v0.10, `Safe11.fullModel`), each with
its proof. Most follow from laws the machine already has; this file names them in one place so a reader can check
the list. All are about the Lean model.

  1. REFUSAL IS A NO-OP: a refused input leaves the state exactly as it was.
  2. DENY OVERRIDES: a form on the record's refused list is refused, whatever else holds.
  3. ORDER DOES NOT MATTER: two refused lists with the same members refuse exactly the same inputs.
  4. ONLY TIGHTENS: along any history, with seals and continuations, the refused list never loses a member (here:
     never changes at all), so what a record refuses never shrinks.
  And the property the four serve, NOT BYPASSABLE: any history of the public machine is a history of the inner
  machine over the inputs the record does not refuse; nothing a refused input would do can happen by another
  order or interleaving of inputs. -/

namespace Aukora.RootFinal.Obligations
open Release
open Refusal
open Safe11 (innerModel fullModel)
open R6.KernelCell (Context)

/-- 1. A refused input changes nothing. -/
theorem refusal_noop (ctx : Context) (s : Release.State) (c : Input) (r : refuses s c = true) :
    execute fullModel ctx s c = s := exec_ref r

/-- 2. Deny overrides: a refused frame is refused whatever the inner machine would have said. -/
theorem deny_overrides (ctx : Context) (s : Release.State) (w : ByteArray) (b : Blocked s (.frame w)) :
    fullModel.step ctx w s = none := frame_ref (refuses_iff.mpr b)

/-- 3. Order does not matter: the test reads only which codes are on the list. -/
theorem order_free (s t : Release.State) (same : ∀ x, x ∈ s.policy.refused ↔ x ∈ t.policy.refused) (c : Input) :
    refuses s c = refuses t c := by
  unfold refuses
  cases Forms.inputForm c with
  | none => rfl
  | some f =>
    have e : decide (f.code ∈ s.policy.refused) = decide (f.code ∈ t.policy.refused) := decide_eq_decide.mpr (same f.code)
    simp [e]

/-- 4. Only tightens: across any history of inputs, seals and continuations, the list never changes. -/
theorem refused_constant (ctx : Context) (ops : List RecordBinding.Op) (x : Release.State × List ByteArray) :
    (RecordBinding.walk fullModel ctx x ops).1.policy.refused = x.1.policy.refused :=
  walk_refused (wrap_carries full_carries) ctx ops x

theorem never_loses (ctx : Context) (ops : List RecordBinding.Op) (x : Release.State × List ByteArray) :
    x.1.policy.refused ⊆ (RecordBinding.walk fullModel ctx x ops).1.policy.refused := by
  rw [refused_constant]; exact List.Subset.refl _

/-- Not bypassable: every history of the public machine IS a history of the inner machine over exactly the
    inputs the starting state does not refuse (with every seal and continuation kept). -/
theorem not_bypassable (ctx : Context) (ops : List RecordBinding.Op) (x : Release.State × List ByteArray) :
    RecordBinding.walk fullModel ctx x ops = RecordBinding.walk innerModel ctx x (ops.filter (keepOp x.1)) :=
  walk_wrap full_carries ctx ops x

#print axioms refusal_noop
#print axioms deny_overrides
#print axioms order_free
#print axioms refused_constant
#print axioms not_bypassable
end Aukora.RootFinal.Obligations
