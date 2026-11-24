import Proofs.FinalStep

namespace Aukora.RootFinal
open Release
open Safe11 (innerModel)
open Evidence11
open private Release.use_formula from Proofs.DangerPolicy
open private Core8.act from Ledger.Assessed

/-- A delivery has a current grant-policy route, a valid ledger action and a
    matching risk bundle. This test is independent of the candidate verdict,
    the current certificate goal and the evidence confidences. -/
def routeReady (g : WireGrammar) (s : Release.State) (w : ByteArray) (i : Intent) : Prop :=
  ∃ d, Root12.Grammar.decode g s w = some d ∧
    Policy9.grantOK s i = true ∧ (Core8.act w s.base).isSome = true

private theorem route_iff {g : WireGrammar} {ctx w s i a} (named : Names s w i a) :
    routeReady g s w i ↔ (Ratchet11.step ctx w s).isSome = true := by
  have tag := named.1
  have old : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
  have tr : Tracked w (.use i) := ⟨old,named.2.1⟩
  have test : (Ratchet11.step ctx w s).isSome = (Policy9.grantOK s i && (Core8.act w s.base).isSome) := by
    rw [Ratchet11.step]
    simp only [Ratchet11.allow_ordinary (ctx := ctx) (s := s) old,if_true]
    exact Release.use_formula tr
  constructor
  · rintro ⟨_,_,grant,act⟩
    rw [test,grant,act]
    rfl
  · intro passed
    obtain ⟨t,ok⟩ := Option.isSome_iff_exists.mp passed
    have inherit : Core9.step ctx w s = some t := by simpa [Ratchet11.step,Ratchet11.allow_ordinary (ctx := ctx) (s := s) old] using ok
    obtain ⟨f,_,decoded,_⟩ := step_projection inherit
    have noFF : w[0]? ≠ some (255 : UInt8) := by rw [tag]; decide
    refine ⟨⟨f,.legacy⟩,by simp [Root12.Grammar.legacy_stable g s w noFF,decoded],?_⟩
    simpa [test] using passed

def Lowering (m : Model) : Prop := ∀ {ctx w s t i a w' s' b},
  m.step ctx w s = some t → Names s w i a → Names s' w' i b → b.pos = a.pos →
  SameBasis s s' a.pos → List.Forall₂ Weaker a.claims b.claims →
  b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
      b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s' →
  Safe11.halted s' = false → routeReady m.grammar s' w' i → (m.step ctx w' s').isSome = true

theorem full_lowering : Lowering innerModel := fun ok a b pos basis weaker addr active ready =>
  act_lowering ok a b pos basis weaker addr active ((route_iff b).mp ready)

theorem lowering_bridge {m : Model} (law : Lowering m) : Root12.E6 m :=
  fun ok a b pos basis weaker addr active _ ready =>
    law ok a b pos basis weaker addr active ((route_iff b).mpr ready)

#print axioms full_lowering
#print axioms lowering_bridge
end Aukora.RootFinal
