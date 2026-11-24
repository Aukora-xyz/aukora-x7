import Proofs.PublicLawful
import tools.Serialization
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command Release.Serialization

namespace Release.ExportFinal

private def out (name : String) := "v0.10/.work/package/" ++ name

private def file (name : String) (bytes : ByteArray) : CommandElabM Unit := do
  liftIO <| IO.FS.writeBinFile (out name) bytes
  logInfo m!"{name}: {bytes.size} bytes"

private def serialize (e : Expr) : CommandElabM (List UInt8) := do
  let .ok bytes := exprBytes true e | throwError "could not serialize kernel expression"
  return bytes

private def assembly (type : Expr) : Bool :=
  let head := type.getForallBody.getAppFn
  [``Aukora.RootFinal.Lawful, ``Aukora.Root12.Contract, ``Aukora.Root12.Lawful, ``Aukora.Release.Lawful,
    ``Aukora.Root12.Supplement, ``Aukora.Safe11.PublicLaws, ``Aukora.Ratchet11.Transition].any head.isConstOf

/-- Reduce projections of explicit constructor terms. Shipping each selected field
    once avoids repeatedly embedding an entire record when a component proof is used. -/
private def projection (env : Environment) (e : Expr) : Option Expr := do
  let args := e.getAppArgs
  match e.getAppFn with
  | .const name _ =>
    let info ← env.getProjectionFnInfo? name
    let object ← args[info.numParams]?
    let value := object.consumeMData.headBeta.consumeMData
    guard (value.getAppFn.isConstOf info.ctorName)
    let selected ← value.getAppArgs[info.numParams + info.i]?
    return mkAppN selected (args.extract (info.numParams + 1) args.size)
  | .proj family index term =>
    let value := term.consumeMData.headBeta.consumeMData
    let .const ctor _ := value.getAppFn | none
    let some (.ctorInfo info) := env.find? ctor | none
    guard (info.induct == family)
    let field ← value.getAppArgs[info.numParams + index]?
    return mkAppN field args
  | _ => none

-- Carry the complete assembly; only component theorem statements enter the snapshot.
private def expanded (name : Name) : CommandElabM Expr := do
  let env ← getEnv
  let .thmInfo t ← getConstInfo name | throwError "not a theorem: {name}"
  let mut proof := t.value
  for _ in [:64] do
    let mut expand : NameMap TheoremVal := {}
    for n in proof.getUsedConstants do
      if let some (.thmInfo thm) := env.find? n then
        if assembly thm.type || n == `Aukora.Bound5.wrong_digest then
          expand := expand.insert n thm
    let changed := proof.replace fun e => do
      let .const n ls := e | none
      let thm ← expand.find? n
      return thm.value.instantiateLevelParams thm.levelParams ls
    let projected := changed.replace (projection env)
    if projected == proof then return projected
    proof := projected
  throwError "certificate expansion exceeded bound"

private def snapshot (roots : List Expr) (carried : List Name) : CommandElabM Unit := do
  let mut seen := roots.foldl (fun names e => refsIn e names) {}
  let mut pending := RBTree.toList seen
  let mut payload := ByteArray.empty
  let mut index : Array String := #[]
  for _ in [:24000] do
    let name :: rest := pending | break
    pending := rest
    if carried.contains name then continue
    if name == ``sorryAx || name == `Aukora.Bound5.wrong_digest then
      throwError "forbidden dependency {name}"
    let c ← getConstInfo name
    if c.isTheorem && assembly c.type then
      throwError "complete Lawful theorem would enter pinned environment: {name}"
    let .ok (bytes,deps,kind) := record c | throwError "unsupported declaration {name}"
    payload := payload ++ bytes.toByteArray
    if payload.size > 48 * 1024 * 1024 then throwError "snapshot exceeds 48 MiB at {name}"
    index := index.push s!"{kind}\t{name}\t{bytes.length}"
    for d in deps do
      if carried.contains d then
        throwError "pinned declaration {name} depends on unpinned candidate name {d}"
      unless seen.contains d do
        seen := seen.insert d
        pending := d :: pending
  unless pending.isEmpty do throwError "snapshot exceeds 24000 declarations"
  file "laws.env" ("R6E1".toUTF8 ++ (varNat index.size).toByteArray ++ payload)
  liftIO <| IO.FS.writeFile (out "laws.env.tsv") (String.intercalate "\n" index.toList ++ "\n")
  logInfo m!"pinned {index.size} declarations, excluding candidate and complete Lawful theorems"

open Aukora

private def lawName := `R9Candidate.claimedLaw
private def machineName := `R9Candidate.successor

/-- The leading declaration carries the closed law, the final declaration carries the model. -/
private def modelFile (label : String) (clause : Expr) (m : Name) : CommandElabM Unit := do
  let ty := Expr.forallE `m (mkConst ``Aukora.Release.Model) (.sort .zero) .default
  let put (n : Name) (t v : Expr) : CommandElabM (List UInt8) := do
    return putName n ++ (← serialize t) ++ (← serialize v)
  let first ← put lawName ty clause
  let last ← put machineName (mkConst ``Aukora.Release.Model) (mkConst m)
  file (label ++ ".model") ("R9M1".toUTF8 ++ (varNat 2 ++ first ++ last).toByteArray)

private def add (prior : Expr) (label : String) (clause : Expr) : Expr :=
  mkApp3 (mkConst ``Ratchet11.addLaw) prior (.lit (.strVal label)) clause

/- The extra public law in the stronger package pins genesis. Its unchanged
    declaration is used in the native, Wasm and fixed-judge comparisons. -/
namespace LineageControl

def Lawful (m : Aukora.Release.Model) : Prop := m.genesis = Core9.genesis
def relaxed (_ : Aukora.Release.Model) : Prop := True

private def blank : Policy9.Machine :=
  ⟨⟨⟨Bound4.initial 0, ⟨[],[]⟩⟩, Risk8.initial, #[], #[]⟩, [], [], {}⟩

theorem strictly_weaker :
    (∀ m, Lawful m → relaxed m) ∧ ∃ m, ¬ Lawful m ∧ relaxed m := by
  let changed := {Aukora.Release.newest with genesis := fun _ => some blank}
  refine ⟨fun _ _ => True.intro, changed, ?_, True.intro⟩
  intro old
  have eq := congrFun old ByteArray.empty
  change some blank = none at eq
  cases eq

end LineageControl

private theorem base_pin (m : Aukora.Release.Model) (h : RootFinal.Lawful m) :
    Root12.Grammar.Preserves Safe11.fullModel.grammar m := h.record.version.1

private theorem same_entails :
    Ratchet11.Transition RootFinal.Lawful RootFinal.Lawful Safe11.fullModel :=
  ⟨fun _ h => h, base_pin⟩

private def stronger := Ratchet11.addLaw RootFinal.Lawful "standard-genesis" LineageControl.Lawful

private theorem strong_own : stronger Safe11.fullModel := ⟨RootFinal.full_lawful,rfl⟩

private theorem strong_entails : Ratchet11.Transition stronger RootFinal.Lawful Safe11.fullModel :=
  ⟨fun _ h => h.1, fun m h => base_pin m h.1⟩

private theorem strong_next : Ratchet11.Transition stronger stronger Safe11.fullModel :=
  ⟨fun _ h => h, fun m h => base_pin m h.1⟩

/-- Round 12c A: a set its machine cannot satisfy (the root plus `False`). It entails the root and
    retains every name, so only the satisfaction check (reason 7) can refuse it. -/
private def unsatisfiable := Ratchet11.addLaw RootFinal.Lawful "unsatisfiable" (fun _ => False)

private theorem unsat_entails : Ratchet11.Transition unsatisfiable RootFinal.Lawful Safe11.fullModel :=
  ⟨fun _ h => h.1, fun m h => base_pin m h.1⟩

/-- Generate the actual conjunction of the remaining structure fields and its proof.
    The full assembly occurs once in the outgoing term. No completed root theorem
    is imported as a trusted declaration. -/
private def omitField (fields : List Name) (absent : Name) (full own : Expr) :
    CommandElabM (Expr × Expr) := do
  let law := ``RootFinal.Lawful
  let lawTy := Expr.forallE `m (mkConst ``Aukora.Release.Model) (.sort .zero) .default
  -- The prefix predicate and its proof each get one local binding. Without these
  -- lets the preceding type would be serialized afresh for every conjunction.
  let mut bindings : Array (Name × Expr × Expr) := #[ (`complete,.app (mkConst law) full,own) ]
  let mut claim : Option Expr := none
  for label in fields do
    if label == absent then continue
    let projectionName := Name.str law label.toString
    let info ← getConstInfo projectionName
    let .forallE _ ty (.forallE _ _ clause _) _ := info.type | throwError "field type {projectionName}"
    if clause.hasLooseBVar 0 then throwError "dependent field {projectionName}"
    let pred := Expr.lam `m ty (clause.instantiate1 (mkConst ``True.intro)) .default
    let labelExpr := Expr.lit (.strVal label.toString)
    let first := mkApp2 (mkConst ``Ratchet11.oneLaw) labelExpr pred
    let next := claim.elim first (fun previous => add previous label.toString pred)
    let localNext := claim.elim first (fun _ => add (.bvar 1) label.toString pred)
    -- After pushing the predicate, the root witness is exactly this many binders out.
    let component := mkApp2 (mkConst projectionName) full (.bvar bindings.size)
    let localOwn := claim.elim component (fun _ =>
      mkApp4 (mkConst ``And.intro) (.app (.bvar 2) full) (.app pred full) (.bvar 1) component)
    bindings := bindings.push (label,lawTy,localNext) |>.push (`accepted,.app (.bvar 0) full,localOwn)
    claim := some next
  let some child := claim | throwError "empty set"
  return (child,bindings.foldr (fun (n,t,v) body => Expr.letE n t v body false) (Expr.bvar 0))

/-- Equal-sized declaration records keep Wasm section sizes fixed in the transport
    control. Binder spelling does not affect the weaker predicate's meaning. -/
private def lineageControl : CommandElabM Unit := do
  let .defnInfo original ← getConstInfo ``LineageControl.Lawful | throwError "lineage control"
  let .defnInfo weaker ← getConstInfo ``LineageControl.relaxed | throwError "weaker predicate"
  let .lam _ ty body bi := weaker.value | throwError "weaker predicate shape"
  let .ok (src,_,_) := record (.defnInfo original) | throwError "lineage source record"
  for count in [:src.length+1] do
    let binder := Name.str .anonymous (String.join (List.replicate count "s"))
    let decl := {original with value := Expr.lam binder ty body bi}
    let .ok (dst,_,_) := record (.defnInfo decl) | throwError "lineage alternate record"
    if src.length == dst.length then
      file "lineage-original.decl" src.toByteArray
      file "lineage-weaker.decl" dst.toByteArray
      logInfo m!"stronger-set predicate {original.name}: standard genesis changed to True; a different genesis newly satisfies it; each record {src.length} bytes"
      return
  throwError "no equal-size encoding of lineage control"

private def package (basis : Nat) (prior child machine own ent : Expr) (control := false) : CommandElabM Expr := do
  let priorBytes := (← serialize prior).toByteArray
  let id := RatchetChecker.number (RatchetChecker.identity basis priorBytes)
  let tail := if control then mkConst ``True.intro else Expr.bvar 1
  return .letE `foundation (.const ``Nat []) (.lit (.natVal basis))
    (.letE `previous (.const ``Nat []) (.lit (.natVal id))
      (.letE `satisfaction (.app child machine) own
        (.letE `entailment (RatchetChecker.entailmentGoal child prior machine) ent
          tail control) control) true) true

run_cmd
  liftIO <| IO.FS.createDirAll "v0.10/.work/package"
  let env ← getEnv
  let fields := (getStructureFields env ``RootFinal.Lawful).toList
  unless fields.map toString == RatchetChecker.rootNames do
    throwError "ROOT v1 final field manifest mismatch: {fields}"
  let root := mkConst ``RootFinal.Lawful
  let full := mkConst ``Safe11.fullModel
  let strong := add root "standard-genesis" (mkConst ``LineageControl.Lawful)
  let own ← expanded ``RootFinal.full_lawful
  let ent ← expanded ``same_entails
  let norm (e : Expr) := e.replace fun term =>
    if term.isConstOf ``stronger then some strong
    else none
  let strongOwn := norm (← expanded ``strong_own)
  let strongEnt := norm (← expanded ``strong_entails)
  let strongNext := norm (← expanded ``strong_next)
  let unsat := add root "unsatisfiable"
    (Expr.lam `x (mkConst ``Aukora.Release.Model) (mkConst ``False) .default)
  let unsatEnt := (← expanded ``unsat_entails).replace fun term =>
    if term.isConstOf ``unsatisfiable then some unsat else none
  let supp := mkConst ``Root12.Supplement
  let suppOwn ← expanded ``RootFinal.pub_supplement
  let idSupp := Expr.lam `m (mkConst ``Aukora.Release.Model)
    (.lam `h (.app supp (.bvar 0)) (.bvar 0) .default) .default
  let mut rows := [("supplement",root,supp,suppOwn,idSupp),("wrong-own",root,root,suppOwn,ent),("same",root,root,own,ent),("strong",root,strong,strongOwn,strongEnt),
    ("strong-next",strong,strong,strongOwn,strongNext),("unsatisfied",root,unsat,own,unsatEnt)]
  for field in fields do
    let (child,partialOwn) ← omitField fields field full own
    rows := rows ++ [("drop-" ++ field.toString,root,child,partialOwn,ent)]
  let mut roots := [mkConst ``Aukora.Release.Model,mkConst ``Aukora.Release.Lawful,root,full,mkConst ``LineageControl.Lawful]
  for (label,prior,child,sat,transition) in rows do
    roots := (← package 0 prior child full sat transition (label == "supplement")) :: roots
  snapshot roots [lawName,machineName]
  lineageControl
  let bytes ← liftIO <| IO.FS.readBinFile (out "laws.env")
  let basis := RatchetChecker.number (Sha256.hash bytes)
  -- Round 12c A: the identity of the statement actually proved, derived from the TYPE of
  -- `full_lawful` (not from `rootSpec` or `rootNames`). tools/genesis-check.mjs compares it
  -- with the identity the compiled core reports.
  let .thmInfo provedThm ← getConstInfo ``RootFinal.full_lawful | throwError "full_lawful is not a theorem"
  let .app provedHead provedMachine := provedThm.type.consumeMData | throwError "proved statement shape"
  unless provedMachine.isConstOf ``Safe11.fullModel do throwError "full_lawful is proved of another machine"
  let .const provedName [] := provedHead | throwError "proved head is not a closed constant"
  let provedFields := (getStructureFields env provedName).toList.map toString
  let provedManifest := ("R12B/1\n" ++ String.intercalate "\n" provedFields ++ "\n").toUTF8
  let provedHeadBytes := (← serialize provedHead).toByteArray
  file "proved.id" (Sha256.hash (provedManifest ++ (Sha256.hash bytes).toByteArray ++ provedHeadBytes)).toByteArray
  for (label,prior,child,sat,transition) in rows do
    modelFile label child ``Safe11.fullModel
    let expr ← package basis prior child full sat transition (label == "supplement")
    file (label ++ ".proof.expr") (← serialize expr).toByteArray
  let rootBytes := (← serialize root).toByteArray
  unless rootBytes.data == RatchetChecker.rootSpec.data do throwError "root declaration encoding"
  file "root.law" rootBytes
  file "root.id" (RatchetChecker.identity basis rootBytes).toByteArray
  file "strong.law" (← serialize strong).toByteArray

end Release.ExportFinal
