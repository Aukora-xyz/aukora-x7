import Ratchet11
import tools.Serialization

open Lean Aukora

private def pkg (name : String) := IO.FS.readBinFile ("v0.2/.work/package/" ++ name)

private def want {α : Type} [DecidableEq α] [ToString α] (title : String) (value expected : α) : IO Unit := do
  IO.println s!"{title}: {value} (expected {expected})"
  unless value = expected do throw (IO.userError title)

private def altEnvironment (env : ByteArray) : ByteArray := Id.run do
  -- Add one unused declaration of True. Both snapshots remain well-formed and keep all old names.
  let mut at_ := 4
  let mut count := 0
  let mut shift := 1
  for _ in [:10] do
    let b := env[at_]!.toNat
    count := count + (b % 128)*shift
    at_ := at_ + 1
    if b < 128 then break
    shift := shift * 128
  let .ok ty := _root_.Release.Serialization.exprBytes true (mkConst ``True) | return .empty
  let decl := [0] ++ _root_.Release.Serialization.putName `Unused.AuditMarker ++ [0] ++ ty
  return "R6E1".toUTF8 ++ (_root_.Release.Serialization.varNat (count+1)).toByteArray ++
    env.extract at_ env.size ++ decl.toByteArray

def main : IO Unit := do
  let env ← pkg "laws.env"
  let some ctx := RatchetChecker.init env | throw (IO.userError "init")
  let some basis := RatchetChecker.basis ctx | throw (IO.userError "basis")
  let root ← pkg "root.law"
  let strong ← pkg "strong.law"
  let own ← pkg "same.model"
  let sat ← pkg "same.proof.expr"
  for (name, labels) in [("same",RatchetChecker.rootNames),
      ("strong",RatchetChecker.rootNames ++ ["standard-genesis"]),
      ("weak",RatchetChecker.inheritedNames),("bottom",["impossible"])] do
    let m ← pkg (name ++ ".model")
    let some clause := (RatchetChecker.spec m).bind RatchetChecker.expression | throw (IO.userError name)
    want s!"finite named law list for {name}" (RatchetChecker.manifest clause == some labels) true
  let anonymousLaw := Expr.lam `m (.const `Aukora.Release.Model []) (.const ``True []) .default
  want "unnamed predicate has no manifest" (RatchetChecker.manifest anonymousLaw).isNone true
  for name in [`R9Candidate.claimedLaw,`R9Candidate.successor,`Aukora.Ratchet11.legacy_lawful,
      `Aukora.Ratchet11.Cases.same_sat, `Aukora.Ratchet11.Cases.strong, `Aukora.Release.newest_lawful] do
    want s!"omitted pinned declaration {name}" (ctx.env.find? name).isSome false
  for (model, certificate, prev, expected) in [
      ("same","same",none,0), ("strong","strong",none,0), ("weak","weak",none,8),
      ("bottom","bottom",none,7), ("weak-claims-root","weak-claims-root",none,7), ("same","same-on-strong",some (basis,strong),8),
      ("strong","strong-on-strong",some (basis,strong),0), ("same","same",some (basis,strong),4)] do
    let m ← pkg (model ++ ".model")
    let p ← pkg (certificate ++ ".proof.expr")
    want s!"{certificate}, prior={if prev.isSome then "strong" else "root"}"
      (Ratchet11.packageReason ctx prev m p) expected
    if expected == 0 then want s!"{certificate}, v0.1 independent check" (Checker9.check ctx m p) true
  let bottomModel ← pkg "bottom.model"
  let bottomProof ← pkg "bottom.proof.expr"
  let some bottomGoals := RatchetChecker.goals ctx root bottomModel bottomProof
    | throw (IO.userError "bottom goals")
  want "impossible child independently proves entailment"
    (RatchetChecker.verifies bottomGoals.env bottomGoals.entails bottomGoals.cert.entails) true
  want "impossible child cannot supply this satisfaction witness"
    (RatchetChecker.verifies bottomGoals.env bottomGoals.own bottomGoals.cert.own) false
  let alt := altEnvironment env
  let some altCtx := RatchetChecker.init alt | throw (IO.userError "alternate snapshot")
  want "same declarations plus one inert audit marker, old record binding"
    (Ratchet11.packageReason altCtx (some (basis,root)) own sat) 1
