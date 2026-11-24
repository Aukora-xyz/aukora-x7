import Proofs.PublicLawful
import Proofs.FormsDecoder

/-! Root v2 step 3a-ii: what a bound record now guarantees, in the core, for the public machine. -/

namespace Aukora.RootFinal.Bound
open Release
open Refusal
open Safe11 (innerModel fullModel)
open R6.KernelCell (Context)

/-- Reachable from a bound start by any history of inputs, seals and continuations. -/
def BReach (s : Release.State) : Prop :=
  ∃ law keys host start l ctx ops, Bound12c.genesis law keys host = some start ∧
    s = (RecordBinding.walk fullModel ctx (start, l) ops).1

/-- Reachable from the ordinary start by any history of inputs, seals and continuations. -/
def OReach (s : Release.State) : Prop :=
  ∃ key start l ctx ops, fullModel.genesis key = some start ∧
    s = (RecordBinding.walk fullModel ctx (start, l) ops).1

theorem bound_register {s : Release.State} (r : BReach s) : s.policy.refused = [8, 14] := by
  obtain ⟨law, keys, host, start, l, ctx, ops, g, rfl⟩ := r
  have e : (RecordBinding.walk fullModel ctx (start, l) ops).1.policy.refused = start.policy.refused :=
    walk_refused (wrap_carries full_carries) ctx ops (start, l)
  rw [e]
  obtain ⟨b, _, rfl⟩ := Bound12c.genesis_old g
  rfl

theorem ordinary_register {s : Release.State} (r : OReach s) : s.policy.refused = [] := by
  obtain ⟨key, start, l, ctx, ops, g, rfl⟩ := r
  have e : (RecordBinding.walk fullModel ctx (start, l) ops).1.policy.refused = start.policy.refused :=
    walk_refused (wrap_carries full_carries) ctx ops (start, l)
  rw [e]
  exact ordinary_refused_empty g

/-- On every state reachable from a bound start, a plain approval and an old key change are refused, whatever
    head, sequence or record their bytes name (so also when re-addressed). The decoder reading is the one by
    which the machine takes either effect (`Forms.approval_is_filed`, `Forms.legacy_key_change_is_filed`). -/
theorem bound_refuses_legacy {s : Release.State} (r : BReach s) (ctx : Context) (w : ByteArray) :
    ((∃ x pq i sig, Policy9.decode w = some (.ordinary x (.signed pq)) ∧ x.action = .grant i sig) ∨
      (∃ p n keys ed ml, Policy9.decode w = some (.rebind p n keys ed ml))) →
    fullModel.step ctx w s = none ∧ execute fullModel ctx s (.frame w) = s := by
  intro h
  have reg := bound_register r
  have ref : refuses s (.frame w) = true := by
    rcases h with ⟨x, pq, i, sig, dec, act⟩ | ⟨p, n, keys, ed, ml, dec⟩
    · simp [refuses, Forms.inputForm, Forms.approval_is_filed dec act, essential, reg, Forms.FormId.code]
    · simp [refuses, Forms.inputForm, Forms.legacy_key_change_is_filed dec, essential, reg, Forms.FormId.code]
  exact ⟨frame_ref ref, exec_ref ref⟩

/-- No lockout: on every state reachable from a bound start (indeed on every state), a valid clear and a valid
    newer key change (ff 02 35) are admitted. -/
theorem bound_recovery {s : Release.State} (_ : BReach s) (ctx : Context) :
    (∀ w, Safe11.ValidClear s w → ∃ t, fullModel.step ctx w s = some t ∧ Safe11.halted t = false) ∧
    (∀ w, Safe11.route w = .rebind → Safe11.shape s w 53 = true → Safe11.Both s w 53 →
      Hybrid7.validKey (Safe11.newKeys s w) = true → ∃ t, fullModel.step ctx w s = some t ∧
        t.base.hybrid.owner = Safe11.newKeys s w ∧ Policy9.pool t.base = [] ∧
        Policy9.generation t = Policy9.generation s + 1 ∧ Safe11.halted t = Safe11.halted s) :=
  ⟨fun w v => by
     rw [free_frame' (clear_free v.1)]; exact Root12.full_supplement.h5.1 ctx s w v,
   fun w rt sh b k => by
     rw [free_frame' (rebind_free rt)]; exact Root12.full_supplement.h5.2 ctx s w rt sh b k⟩

/-- The ordinary start is unchanged: every clause of the v0.8 root holds of the public machine, the advice
    clause (restated in v0.10) in its v0.8 text on states reachable from the ordinary start. -/
theorem old_start_unchanged :
    Lawful fullModel ∧
    (∀ ctx s xs ys, OReach s → Advice.Aligned fullModel ctx s s xs ys →
      auth (run fullModel ctx s xs) = auth (run fullModel ctx s ys) ∧
      Advice.verdicts fullModel ctx s xs = Advice.verdicts fullModel ctx s ys) ∧
    (∀ ctx s t xs ys, OReach s → OReach t → auth s = auth t → VersionAdvice.Aligned fullModel ctx s t xs ys →
      auth (run fullModel ctx s xs) = auth (run fullModel ctx t ys) ∧
      Advice.verdicts fullModel ctx s xs = Advice.verdicts fullModel ctx t ys) :=
  ⟨full_lawful,
   fun ctx s xs ys r al => full_lawful.advice.1 ctx s xs ys
     (fun _ _ => Forms.not_refusedIn (ordinary_register r) _) (fun _ _ => Forms.not_refusedIn (ordinary_register r) _) al,
   fun ctx s t xs ys rs rt eq al => full_lawful.advice.2 ctx s t xs ys eq
     (fun _ _ => Forms.not_refusedIn (ordinary_register rs) _) (fun _ _ => Forms.not_refusedIn (ordinary_register rt) _) al⟩

/-- The bound start's codes are the table's codes for the two old owner forms. -/
theorem bound_codes : [Forms.FormId.approval.code, Forms.FormId.legacyKeyChange.code] = [8, 14] := rfl

#print axioms bound_refuses_legacy
#print axioms bound_recovery
#print axioms old_start_unchanged
end Aukora.RootFinal.Bound
