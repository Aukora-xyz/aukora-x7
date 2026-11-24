import KernelCell

namespace Aukora.Checker9
open Lean
open R6.KernelCell
open private Parser envField exactly byte varNat exprField nameField from KernelCell
open private Lean.Kernel.Environment.add from Lean.Environment

/-- Only the compiled-in environment is passed by the Wasm adapter. The base goal is unused; each submission constructs its own target. -/
@[export r9_kernel_init]
def init (environment : ByteArray) : Option Context := do
  let env ← exactly envField environment
  guard ((env.find? `Aukora.Release.Lawful).isSome)
  return ⟨env, mkConst ``False⟩

/-- This carrier contains only safe, monomorphic, nonrecursive definitions. A body may
    use pinned constants or earlier declarations. The final declaration denotes the machine.
    There is no record form for an axiom, theorem without proof, or reduction rule. -/
private structure Definition where
  name : Name
  type : Expr
  value : Expr

private def modelField : Parser (List Definition) := do
  for b in "R9M1".toUTF8 do guard ((← byte) == b)
  let count ← varNat
  guard (0 < count && count ≤ 64)
  let mut defs := []
  for _ in [:count] do
    let d : Definition := ⟨← nameField, ← exprField, ← exprField⟩
    defs := d :: defs
  return defs.reverse

private def addChecked (env : Kernel.Environment) (d : Definition) : Option Kernel.Environment := do
  guard ((env.find? d.name).isNone)
  -- Keep kernel primitive names reserved even if the private snapshot omits a primitive.
  guard (Name.isPrefixOf `R9Candidate d.name && d.name != `R9Candidate)
  let .ok true := Lean4Lean.TypeChecker.M.run env (x := do
    let kind ← Lean4Lean.TypeChecker.check d.type []
    let _ ← Lean4Lean.TypeChecker.ensureSort kind d.type
    let inferred ← Lean4Lean.TypeChecker.check d.value []
    Lean4Lean.TypeChecker.isDefEq inferred d.type) | none
  let decl := mkDefinitionValEx d.name [] d.type d.value .abbrev .safe [d.name]
  return env.add (.defnInfo decl)

/-- Derive the target from the final declaration just checked. All extensions live only
    for this invocation; subsequent submissions start from the same pinned environment. -/
def context (base : Context) (model : ByteArray) : Option Context := do
  guard (model.size ≤ 1024 * 1024)
  let defs ← exactly modelField model
  let machine ← defs.getLast?
  let env ← defs.foldlM addChecked base.env
  let goal := mkApp (mkConst `Aukora.Release.Lawful) (mkConst machine.name)
  let .ok true := Lean4Lean.TypeChecker.M.run env (x := do
    let kind ← Lean4Lean.TypeChecker.check goal []
    Lean4Lean.TypeChecker.isDefEq kind (.sort .zero)) | none
  return ⟨env, goal⟩

@[export r9_kernel_check]
def check (base : Context) (model proof : ByteArray) : Bool :=
  proof.size ≤ 1024 * 1024 && (context base model).any fun ctx => R6.KernelCell.check ctx proof

end Aukora.Checker9

namespace Aukora.Checker9
open Lean R6.KernelCell

open private R6.KernelCell.exactly from KernelCell

/-- The machine's name is read from the final entry in the carried model. -/
def machineName (model : ByteArray) : Option Name := do
  let defs ← R6.KernelCell.exactly modelField model
  return Definition.name (← defs.getLast?)

private theorem derived {base model ctx} (made : context base model = some ctx) :
    ∃ name, machineName model = some name ∧ ctx.goal = mkApp (mkConst `Aukora.Release.Lawful) (mkConst name) := by
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
      ctx.goal = mkApp (mkConst `Aukora.Release.Lawful) (mkConst name) ∧ R6.KernelCell.check ctx proof = true := by
  cases made : context base model with
  | none => simp [check, made] at accepted
  | some ctx =>
    obtain ⟨name, last, goal⟩ := derived made
    exact ⟨name, ctx, last, rfl, goal, (by simpa [check, made] using accepted : _ ∧ _).2⟩

#print axioms checked_goal
end Aukora.Checker9
