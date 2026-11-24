import core.Other7
import ExportTerm
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command
open private exprBytes refsIn record varNat from ExportTerm

namespace R7.Export

-- A certificate must carry its assembly, even when the source proof uses another
-- complete Lawful theorem. The private environment may not contain such a theorem.
private def isCompleteLaw (ty : Expr) : Bool :=
  ty.getForallBody.getAppFn.isConstOf ``Laws7.Lawful

private def expandAssemblies (input : Expr) : CommandElabM Expr := do
  let env ← getEnv
  let mut proof := input
  for _ in [:64] do
    let mut bodies : NameMap TheoremVal := {}
    for name in proof.getUsedConstants do
      if let some (.thmInfo t) := env.find? name then
        if isCompleteLaw t.type || name == ``Aukora.Bound5.wrong_digest then
          bodies := bodies.insert name t
    if RBMap.isEmpty bodies then return proof
    proof := proof.replace fun e => do
      let .const name levels := e | none
      let t ← bodies.find? name
      return t.value.instantiateLevelParams t.levelParams levels
  throwError "certificate assembly nesting exceeds 64"

private def writeExpr (file : String) (e : Expr) : CommandElabM Unit := do
  let .ok bytes := exprBytes true e | throwError "cannot serialize {file}"
  liftIO <| IO.FS.writeBinFile ("logs/r7/" ++ file ++ ".expr") bytes.toByteArray
  logInfo m!"{file}: {bytes.length} bytes"

private def package (label : String) (name model : Name) : CommandElabM (Expr × Expr) := do
  let .thmInfo t ← getConstInfo name | throwError "expected theorem {name}"
  unless t.levelParams.isEmpty && t.type == mkApp (mkConst ``Laws7.Lawful) (mkConst model) do
    throwError "{name} must have the literal type Lawful {model}"
  let value ← expandAssemblies t.value
  writeExpr (label ++ ".proof") value
  writeExpr (label ++ ".type") t.type
  let refs := value.getUsedConstants.toList.map Name.toString
  liftIO <| IO.FS.writeFile ("logs/r7/" ++ label ++ ".proof.references.txt") (String.intercalate "\n" refs ++ "\n")
  return (t.type, value)

-- Follow every original reducible definition, including the complete R6 checker.
private def sharedEnvironment (expressions : List Expr) : CommandElabM Unit := do
  let mut seen := expressions.foldl (fun acc e => refsIn e acc) {}
  let mut pending := RBTree.toList seen
  let mut payload := ByteArray.empty
  let mut index : Array String := #[]
  for _ in [:12000] do
    let name :: rest := pending | break
    if [``Laws7.r6_lawful, ``Laws7.other_lawful, ``Aukora.Bound5.wrong_digest, ``sorryAx].contains name then
      throwError "forbidden dependency {name}"
    let c ← getConstInfo name
    if c.isTheorem && isCompleteLaw c.type then
      throwError "complete Lawful theorem in trusted environment: {name}"
    match record c with
    | .error why => throwError "snapshot failed at {name}: {why}"
    | .ok (bytes, deps, kind) =>
      payload := payload ++ bytes.toByteArray
      if payload.size > 24 * 1024 * 1024 then throwError "environment exceeds 24 MiB at {name}"
      index := index.push s!"{kind}\t{name}\t{bytes.length}"
      pending := rest
      for dep in deps do
        unless seen.contains dep do
          seen := seen.insert dep
          pending := dep :: pending
  unless pending.isEmpty do throwError "environment exceeds 12000 declarations"
  let bytes := "R6E1".toUTF8 ++ (varNat index.size).toByteArray ++ payload
  liftIO <| IO.FS.writeBinFile "logs/r7/laws.env" bytes
  liftIO <| IO.FS.writeFile "logs/r7/laws.env.tsv" (String.intercalate "\n" index.toList ++ "\n")
  logInfo m!"shared fixed environment: {index.size} declarations, {bytes.size} bytes; both Lawful targets excluded"

run_cmd
  let (t, p) ← package "model" ``Laws7.r6_lawful ``Laws7.R6Machine
  let (u, q) ← package "other" ``Laws7.other_lawful ``Laws7.OtherMachine
  let .thmInfo old ← getConstInfo ``Aukora.Bound5.wrong_digest | throwError "missing R6 negative control"
  -- Both cross-goal negatives must fail on their types in the same environment.
  sharedEnvironment [t, p, u, q, old.type, old.value]

end R7.Export
