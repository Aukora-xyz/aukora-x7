import core.Checker9

namespace Aukora.Checker9
open Lean R6.KernelCell
open private modelField Definition Definition.name addChecked from core.Checker9
open private R6.KernelCell.exactly from KernelCell

/-- The machine's name is read from the final entry in the carried model. -/
def machineName (model : ByteArray) : Option Name := do
  let defs ← R6.KernelCell.exactly modelField model
  return Definition.name (← defs.getLast?)

private theorem derived {base model ctx} (made : context base model = some ctx) :
    ∃ name, machineName model = some name ∧ ctx.goal = mkApp (mkConst `Laws7.Lawful) (mkConst name) := by
  unfold context at made
  obtain ⟨_, _, scanned⟩ := Option.bind_eq_some.mp made
  obtain ⟨defs, decoded, tagged⟩ := Option.bind_eq_some.mp scanned
  obtain ⟨last, final_, checked⟩ := Option.bind_eq_some.mp tagged
  obtain ⟨env, _, result⟩ := Option.bind_eq_some.mp checked
  dsimp only at result
  split at result <;> try contradiction
  cases Option.some.inj result
  exact ⟨Definition.name last, by simp [machineName, decoded, final_], rfl⟩

/-- Acceptance used the pinned law applied to the last carried definition, and the
    proof itself was accepted against that constructed goal in the extended environment. -/
theorem checked_goal {base model proof} (accepted : check base model proof = true) :
    ∃ name ctx, machineName model = some name ∧ context base model = some ctx ∧
      ctx.goal = mkApp (mkConst `Laws7.Lawful) (mkConst name) ∧ R6.KernelCell.check ctx proof = true := by
  cases made : context base model with
  | none => simp [check, made] at accepted
  | some ctx =>
    obtain ⟨name, last, goal⟩ := derived made
    exact ⟨name, ctx, last, rfl, goal, (by simpa [check, made] using accepted : _ ∧ _).2⟩

#print axioms checked_goal
end Aukora.Checker9
