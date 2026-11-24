"""Meter the four pinned checker functions and two reduction loops in the release's staging tree."""
import hashlib
from pathlib import Path

UPSTREAM = "06014e0ce4c01b154ec1a9c613956deb224c765cb1cae468af75c6904bab9e5b"
PATCHED = "307e8702812390a9b75846618fa9f37b898024b1c3fbb7a2f61ea14ad33ba256"
STAGED = Path(__file__).resolve().parents[1] / ".work/logs/r6/bootstrap/src/Lean4Lean/TypeChecker.lean"


def patch(original):
    def replace(text, old, new):
        if text.count(old) != 1:
            raise ValueError("unexpected pinned source near " + old[:80])
        return text.replace(old, new, 1)

    result = replace(original, "structure TypeChecker.State where",
                     "def TypeChecker.defaultStepBudget : Nat := 100000\n\nstructure TypeChecker.State where")
    result = replace(result, "  failure : Std.HashSet (Expr × Expr) := {}",
                     "  failure : Std.HashSet (Expr × Expr) := {}\n  remainingSteps : Nat := TypeChecker.defaultStepBudget")
    result = replace(result, """def M.run (env : Environment) (safety : DefinitionSafety := .safe) (lctx : LocalContext := {})
    (x : M α) : Except Exception α :=
  x { env, safety, lctx } |>.run' {}""", """def M.runWithBudget (budget : Nat) (env : Environment) (safety : DefinitionSafety := .safe)
    (lctx : LocalContext := {}) (x : M α) : Except Exception α :=
  x { env, safety, lctx } |>.run' {remainingSteps := budget}

def M.run (env : Environment) (safety : DefinitionSafety := .safe) (lctx : LocalContext := {})
    (x : M α) : Except Exception α :=
  M.runWithBudget defaultStepBudget env safety lctx x

private def chargeStep : M Unit := do
  let s ← get
  match s.remainingSteps with
  | 0 => throw .deterministicTimeout
  | n + 1 => set {s with remainingSteps := n}""")
    # Meter the function bodies: direct recursive calls to inferType' also pay.
    for entry in (
        "def inferType' (e : Expr) (inferOnly : Bool) : RecM Expr := do",
        "def whnfCore' (e : Expr) (cheapRec := false) (cheapProj := false) : RecM Expr := do",
        "def whnf' (e : Expr) : RecM Expr := do",
        "def isDefEqCore' (t s : Expr) : RecM Bool := do",
    ):
        result = replace(result, entry, entry + "\n  chargeStep")
    for first_step in ("let env ← getEnv\n    let t ← whnfCore' t", "let r ← isDefEqOffset tn sn"):
        old = "  | fuel+1 => do\n    " + first_step
        result = replace(result, old, "  | fuel+1 => do\n    chargeStep\n    " + first_step)
    # The original explicitly reconstructed State; a record update retains the counter.
    return replace(result, """  if ← modifyGet fun (.mk a1 a2 a3 a4 a5 a6 (eqvManager := m)) =>
    let (b, m) := m.isEquiv useHash t s
    (b, .mk a1 a2 a3 a4 a5 a6 (eqvManager := m))""",
                   """  if ← modifyGet fun st =>
    let (b, manager) := st.eqvManager.isEquiv useHash t s
    (b, {st with eqvManager := manager})""")


def main():
    original = STAGED.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest == PATCHED:
        print("Pinned checker budget already applied:", digest)
        return
    if digest != UPSTREAM:
        raise ValueError("unexpected staged upstream checker SHA-256: " + digest)
    checked = patch(original.decode()).encode()
    if hashlib.sha256(checked).hexdigest() != PATCHED:
        raise ValueError("unexpected transformed checker SHA-256")
    STAGED.write_bytes(checked)
    print("Pinned checker method/loop budget: 100000 per M.run;", UPSTREAM, "->", PATCHED)


if __name__ == "__main__":
    main()
