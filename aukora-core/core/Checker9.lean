import KernelCell

namespace Aukora.Checker9
open Lean
open R6.KernelCell
open private Parser envField exactly byte varNat exprField nameField from KernelCell
open private Lean.Kernel.Environment.add from Lean.Environment

/-- Only the compiled-in environment is passed by the Wasm adapter. The inherited context's
    goal field is unused by the round-nine checker. -/
@[export r9_kernel_init]
def init (environment : ByteArray) : Option Context := do
  let env ← exactly envField environment
  guard ((env.find? `Laws7.Lawful).isSome)
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
  let goal := mkApp (mkConst `Laws7.Lawful) (mkConst machine.name)
  let .ok true := Lean4Lean.TypeChecker.M.run env (x := do
    let kind ← Lean4Lean.TypeChecker.check goal []
    Lean4Lean.TypeChecker.isDefEq kind (.sort .zero)) | none
  return ⟨env, goal⟩

@[export r9_kernel_check]
def check (base : Context) (model proof : ByteArray) : Bool :=
  proof.size ≤ 1024 * 1024 && (context base model).any fun ctx => R6.KernelCell.check ctx proof

end Aukora.Checker9
