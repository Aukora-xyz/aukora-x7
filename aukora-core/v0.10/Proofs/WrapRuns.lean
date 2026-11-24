import Refusal
import Proofs.PolicyCarried

/-! Root v2 step 3a-ii, first job: the fixed-filter equality for the REAL machine, including seals and
continuations. Seals and continuations are not model inputs (they are the fixed `SegmentFinal` operations
that `RecordBinding.walk` applies); they are never refused, and they carry the refused register. -/

namespace Aukora.Refusal
open Release Forms
open Safe11 (innerModel)
open R6.KernelCell (Context)

/-- The full machine of v0.9 carries the refused register (from `policy_carried`). -/
theorem full_carries : Carries innerModel := fun ctx s c => by rw [PolicyCarried.policy_carried]

/-- Which history operations the starting state keeps: an input it does not refuse, and every seal and continuation. -/
def keepOp (s : Release.State) : RecordBinding.Op → Bool
  | .input c => !refuses s c
  | .continue .. => true

theorem walk_refused {m : Model} (car : Carries m) (ctx : Context) :
    ∀ (ops : List RecordBinding.Op) (x : Release.State × List ByteArray),
      (RecordBinding.walk m ctx x ops).1.policy.refused = x.1.policy.refused
  | [], _ => rfl
  | o :: os, x => by
    simp only [RecordBinding.walk]
    rw [walk_refused car ctx os]
    cases o with
    | input c =>
      cases c with
      | frame w =>
        simp only [RecordBinding.apply]
        cases h : m.step ctx w x.1 with
        | none => rfl
        | some t =>
          have := car ctx x.1 (.frame w)
          simp only [execute, h, Option.getD_some] at this
          exact this
      | feed b => exact car ctx x.1 (.feed b)
      | reset => exact car ctx x.1 .reset
      | stamp w => exact car ctx x.1 (.stamp w)
    | «continue» prior law wire packed =>
      simp only [RecordBinding.apply]
      cases SegmentFinal.closeRecord prior law wire x.1 with
      | none => rfl
      | some pin =>
        dsimp only
        cases cont : SegmentFinal.continueAt pin law packed x.1 with
        | none => rfl
        | some u => rw [PolicyCarried.continue_carried cont]

/-- THE FIXED FILTER, with seals and continuations: a history of the wrapper equals a history of the inner
    model over the operations the STARTING state keeps. -/
theorem walk_wrap {m : Model} (car : Carries m) (ctx : Context) :
    ∀ (ops : List RecordBinding.Op) (x : Release.State × List ByteArray),
      RecordBinding.walk (wrap m) ctx x ops = RecordBinding.walk m ctx x (ops.filter (keepOp x.1))
  | [], _ => rfl
  | o :: os, x => by
    have tail : ∀ y : Release.State × List ByteArray, y.1.policy.refused = x.1.policy.refused →
        RecordBinding.walk (wrap m) ctx y os = RecordBinding.walk m ctx y (os.filter (keepOp x.1)) := by
      intro y hy
      rw [walk_wrap car ctx os y]
      congr 1
      apply List.filter_congr
      intro o _
      cases o with
      | input c => simp only [keepOp, refuses_congr hy]
      | «continue» => rfl
    cases o with
    | input c =>
      cases r : refuses x.1 c with
      | true =>
        have same : RecordBinding.apply (wrap m) ctx x (.input c) = x := by
          cases c with
          | frame w =>
            simp only [RecordBinding.apply]
            have : (wrap m).step ctx w x.1 = none := by
              show (if refuses x.1 (.frame w) then none else m.step ctx w x.1) = none
              rw [if_pos r]
            rw [this]
          | feed b => simp only [RecordBinding.apply]; rw [refused_noop r]
          | reset => simp only [RecordBinding.apply]; rw [refused_noop r]
          | stamp w => simp only [RecordBinding.apply]; rw [refused_noop r]
        simp only [RecordBinding.walk, same, List.filter_cons, keepOp, r, Bool.not_true, Bool.false_eq_true, if_false]
        exact tail x rfl
      | false =>
        have same : RecordBinding.apply (wrap m) ctx x (.input c) = RecordBinding.apply m ctx x (.input c) := by
          cases c with
          | frame w =>
            simp only [RecordBinding.apply]
            have : (wrap m).step ctx w x.1 = m.step ctx w x.1 := by
              show (if refuses x.1 (.frame w) then none else m.step ctx w x.1) = _
              rw [if_neg (by rw [r]; decide)]
            rw [this]
          | feed b => simp only [RecordBinding.apply]; rw [execute_wrap, if_neg (by rw [r]; decide)]
          | reset => simp only [RecordBinding.apply]; rw [execute_wrap, if_neg (by rw [r]; decide)]
          | stamp w => simp only [RecordBinding.apply]; rw [execute_wrap, if_neg (by rw [r]; decide)]
        simp only [RecordBinding.walk, same, List.filter_cons, keepOp, r, Bool.not_false, if_true]
        exact tail _ (walk_refused car ctx [.input c] x)
    | «continue» prior law wire packed =>
      simp only [RecordBinding.walk, List.filter_cons, keepOp, if_true]
      exact tail _ (walk_refused car ctx [.continue prior law wire packed] x)

/-- The real counterpart of an independent review's `Wrapper.run_wrap`, for the full machine. -/
theorem full_run_wrap (ctx : Context) (xs : List Input) (s : Release.State) :
    run (wrap innerModel) ctx s xs = run innerModel ctx s (xs.filter fun c => !refuses s c) :=
  run_wrap full_carries ctx xs s

theorem full_walk_wrap (ctx : Context) (ops : List RecordBinding.Op) (x : Release.State × List ByteArray) :
    RecordBinding.walk (wrap innerModel) ctx x ops = RecordBinding.walk innerModel ctx x (ops.filter (keepOp x.1)) :=
  walk_wrap full_carries ctx ops x

#print axioms full_run_wrap
#print axioms full_walk_wrap
end Aukora.Refusal
