import Proofs.BoundRefuses
import Proofs.FinalCore
import Versions

/-! Hardening round 1. The refusal of the two old command forms, stated on what the machine DOES rather than on
how the decoder files a frame. On every state reachable from a bound start, for every frame the public machine
admits:
  * a grant that was not held before can only come from a TIMED approval (a signed issue, whose signed message
    names a parent head and a position), never from the plain approval that names no record;
  * the owner's keys can only change by the newer key change (ff 02 35, both signatures over a message that
    carries the head) or by the extension dialect's key change, which is addressed to the current head and
    position; never by the old key change that names no record.
These are statements about the effects (the grant pool and the owner register), so no other route that reaches
the same effect is left open by them. They are proved for the Lean model; the compiled files are compared with
each other by the differential tests, not proved. -/

namespace Aukora.RootFinal.Bound
open Release
open Refusal
open Safe11 (innerModel fullModel)
open R6.KernelCell (Context)
open Versions

/-- A frame the public machine admits is admitted by the inner machine and is not refused. -/
theorem admitted_inner {ctx : Context} {w : ByteArray} {s t : Release.State} (h : fullModel.step ctx w s = some t) :
    innerModel.step ctx w s = some t ∧ refuses s (.frame w) = false := by
  refine ⟨Carry.inner_hit h, ?_⟩
  cases r : refuses s (.frame w) with
  | false => rfl
  | true => rw [frame_ref r] at h; cases h

/-- EFFECT LAW 1: in a bound record a new grant comes only from a timed approval. -/
theorem bound_grant_source {s t : Release.State} (r : BReach s) {ctx : Context} {w : ByteArray} {i : Intent}
    (ok : fullModel.step ctx w s = some t) (absent : i ∉ pool s) (held : i ∈ pool t) :
    ∃ p n last ed ml, Tracked w (.issue p n last i ed ml) ∧
      Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml := by
  obtain ⟨inner, _⟩ := admitted_inner ok
  rcases full_grant ctx w s t i inner absent held with ⟨x, ed, ml, tr, act, _⟩ | issued
  · -- the plain approval: the bound start refuses it, so it was never admitted
    have none := (bound_refuses_legacy r ctx w (Or.inl ⟨x, ml, i, ed, tr.2, act⟩)).1
    rw [none] at ok; cases ok
  · exact issued

/-- EFFECT LAW 2: in a bound record the owner's keys change only by a key change addressed to this record. -/
theorem bound_owner_change {s t : Release.State} (r : BReach s) {ctx : Context} {w : ByteArray}
    (ok : fullModel.step ctx w s = some t) (changed : owner t ≠ owner s) :
    (∃ keys, interpretations innerModel.grammar s w = some (.rebind keys) ∧ owner t = keys ∧ Safe11.Both s w 53) ∨
    (∃ p n keys ed ml, interpretations innerModel.grammar s w = some (.extension (.rebind p n keys ed ml)) ∧
      addressed s p n ∧ owner t = keys) := by
  obtain ⟨inner, _⟩ := admitted_inner ok
  obtain ⟨k, parsed, eff⟩ := full_binding ctx w s t inner
  cases k with
  | legacy =>
    simp only [bindingEffect] at eff
    obtain ⟨p, n, ed, ml, tr, _⟩ := eff.1 changed
    have none := (bound_refuses_legacy r ctx w (Or.inr ⟨p, n, owner t, ed, ml, tr.2⟩)).1
    rw [none] at ok; cases ok
  | rebind keys =>
    simp only [bindingEffect] at eff
    exact Or.inl ⟨keys, parsed, eff.1, eff.2⟩
  | extension e =>
    cases e with
    | rebind p n keys ed ml =>
      simp only [bindingEffect] at eff
      exact Or.inr ⟨p, n, keys, ed, ml, parsed, eff.1, eff.2.1⟩
    | _ => exact absurd (by simpa [bindingEffect] using eff) changed
  | _ => exact absurd (by simpa [bindingEffect] using eff) changed

#print axioms bound_grant_source
#print axioms bound_owner_change
end Aukora.RootFinal.Bound
