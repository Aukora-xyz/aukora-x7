import core.Candidate9
import ExportTerm
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command
open private exprBytes putName varNat from ExportTerm

namespace R9.Export

private def serialize (e : Expr) : CommandElabM (List UInt8) := do
  let .ok bs := exprBytes true e | throwError "cannot export expression"
  return bs

private def put (name : String) (bytes : ByteArray) : CommandElabM Unit := do
  liftIO <| IO.FS.writeBinFile ("logs/r9/" ++ name) bytes
  logInfo m!"{name}: {bytes.size} bytes"

private def writeModel (label : String) (names : List (Name × Name)) : CommandElabM Unit := do
  let mut file := "R9M1".toUTF8 ++ (varNat names.length).toByteArray
  for (source, carried) in names do
    let .defnInfo d ← getConstInfo source | throwError "expected definition {source}"
    unless d.levelParams.isEmpty && (d.safety matches .safe) do
      throwError "expected a safe monomorphic definition"
    let record := putName carried ++ (← serialize d.type) ++ (← serialize d.value)
    file := file ++ record.toByteArray
  put (label ++ ".model") file

-- All complete Lawful theorem applications are expanded. Earlier component lemmas are
-- the same assumptions as in the pinned R7 snapshot. The candidate theorem is absent there.
private def expandLaw (input : Expr) : CommandElabM Expr := do
  let env ← getEnv
  let mut proof := input
  for _ in [:64] do
    let mut assemblies : NameMap TheoremVal := {}
    for n in proof.getUsedConstants do
      if let some (.thmInfo t) := env.find? n then
        if t.type.getForallBody.getAppFn.isConstOf ``Laws7.Lawful then
          assemblies := assemblies.insert n t
    if RBMap.isEmpty assemblies then return proof
    proof := proof.replace fun e => do
      let .const n ls := e | none
      let t ← assemblies.find? n
      return t.value.instantiateLevelParams t.levelParams ls
  throwError "proof expansion too deep"

run_cmd
  let key := ``R9Candidate.ownerKey
  let good := ``R9Candidate.honest
  let bad := ``R9Candidate.broken
  writeModel "honest" [(key, key), (good, good)]
  -- The same model name as the honest fixture removes name mismatch as an explanation.
  writeModel "broken" [(key, key), (bad, good)]
  -- The shadowed declaration has its genuine original type and body. Only its name collides.
  writeModel "pinned" [(``Laws7.Lawful, ``Laws7.Lawful), (key, key), (good, good)]
  writeModel "fresh-copy" [(``Laws7.Lawful, `R9Candidate.freshCopy), (key, key), (good, good)]
  let .thmInfo t ← getConstInfo ``R9Candidate.honest_lawful | throwError "missing theorem"
  let proof ← expandLaw t.value
  put "honest.proof.expr" (← serialize proof).toByteArray

end R9.Export
