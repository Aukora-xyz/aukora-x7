import Lean4Lean.TypeChecker
import Lean.Environment

open Lean
open private Lean.Kernel.Environment.mk from Lean.Environment
open Lean4Lean.TypeChecker

private def emptyKernel := Lean.Kernel.Environment.mk {} false {} {} #[] {} {}

/-- Reflexivity uses the equality cache; the next type check must see the spent credit. -/
private def checkAt (budget : Nat) : String :=
  match M.runWithBudget budget emptyKernel (x := do
    let term := Lean.Expr.sort .zero
    unless ← isDefEq term term do return false
    let kind ← check term []
    return kind == .sort (.succ .zero)) with
  | .ok true => "accepted"
  | .error .deterministicTimeout => "budget refused"
  | _ => "unexpected result"

def main : IO Unit := do
  for (budget, expected) in [(0,"budget refused"),(1,"budget refused"),(2,"accepted")] do
    let actual := checkAt budget
    unless actual == expected do throw (IO.userError s!"budget {budget}: {actual}, expected {expected}")
    IO.println s!"budget {budget}: {actual}"
