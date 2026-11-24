import Root12
import tools.Serialization
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command Release.Serialization

namespace Release.Export12

private def out (name : String) := "v0.3/.work/package/" ++ name

private def file (name : String) (bytes : ByteArray) : CommandElabM Unit := do
  liftIO <| IO.FS.writeBinFile (out name) bytes
  logInfo m!"{name}: {bytes.size} bytes"

private def serialize (e : Expr) : CommandElabM (List UInt8) := do
  let .ok bytes := exprBytes true e | throwError "could not serialize kernel expression"
  return bytes

private def assembly (type : Expr) : Bool :=
  let head := type.getForallBody.getAppFn
  [``Aukora.Root12.Contract, ``Aukora.Root12.Lawful, ``Aukora.Release.Lawful,
    ``Aukora.Root12.Supplement, ``Aukora.Safe11.PublicLaws, ``Aukora.Ratchet11.Transition].any head.isConstOf

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
    if RBMap.isEmpty expand then return proof
    proof := proof.replace fun e => do
      let .const n ls := e | none
      let thm ← expand.find? n
      return thm.value.instantiateLevelParams thm.levelParams ls
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

/-- λ m h, h. This is an entailment of a predicate by itself. Cross-set negative
    tests submit the same term at a different expected type and check its verdict. -/
private def identical (claim : Expr) : Expr :=
  .lam `m (mkConst ``Aukora.Release.Model)
    (.lam `h (.app claim (.bvar 0)) (.bvar 0) .default) .default

private def add (prior : Expr) (label : String) (clause : Expr) : Expr :=
  mkApp3 (mkConst ``Ratchet11.addLaw) prior (.lit (.strVal label)) clause

private def extraGenesis : Aukora.Release.Model → Prop := fun m => m.genesis = Core9.genesis

private theorem base_pin (m : Aukora.Release.Model) (h : Root12.Lawful m) :
    Root12.Grammar.Preserves Safe11.fullModel.grammar m := h.record.version.1

private theorem same_entails :
    Ratchet11.Transition Root12.Contract Root12.Contract Safe11.fullModel :=
  ⟨fun _ h => h, fun m h => base_pin m h.inherited⟩

private theorem strong_entails :
    Ratchet11.Transition (Ratchet11.addLaw Root12.Contract "standard-genesis" extraGenesis)
      Root12.Contract Safe11.fullModel :=
  ⟨fun _ h => h.1, fun m h => base_pin m h.1.inherited⟩

/-- Build a real self-transition for each one-field omission. Its grammar half
    is valid because all omissions keep the base 23 clauses. The universal law
    implication targets its own weaker predicate, not the outgoing root. -/
private theorem self_with_pin (claim : Aukora.Release.Model → Prop)
    (pin : ∀ m, claim m → Root12.Grammar.Preserves Safe11.fullModel.grammar m) :
    Ratchet11.Transition claim claim Safe11.fullModel := ⟨fun _ h => h,pin⟩

private def omissionSelf (claim template : Expr) : CommandElabM Expr := do
  let mut cursor := claim
  let mut h := Expr.bvar 0
  let m := Expr.bvar 1
  for _ in [:32] do
    if cursor.isConstOf ``Root12.Lawful then
      let pin := mkApp2 (mkConst ``base_pin) m h
      let allPin := Expr.lam `m (mkConst ``Aukora.Release.Model)
        (.lam `h (.app claim (.bvar 0)) pin .default) .default
      return mkApp2 template claim allPin
    let .app (.app (.app (.const n []) before) _) last := cursor | throwError "invalid omitted-set expression"
    unless n == ``Ratchet11.addLaw do throwError "unexpected omitted-set constructor"
    h := mkApp3 (mkConst ``And.left) (.app before m) (.app last m) h
    cursor := before
  throwError "omitted-set projection too deep"

/- A named inert law-set used only to exercise environment identity. Nothing on the
    authorization or installation path consults these predicates. -/
namespace LineageControl

def Lawful (m : Aukora.Release.Model) : Prop := m.genesis = Core9.genesis
def relaxed (_ : Aukora.Release.Model) : Prop := True

private def blank : Policy9.Machine :=
  ⟨⟨⟨Bound4.initial 0, ⟨[],[]⟩⟩, Risk8.initial, #[], #[]⟩, [], []⟩

theorem strictly_weaker :
    (∀ m, Lawful m → relaxed m) ∧ ∃ m, ¬ Lawful m ∧ relaxed m := by
  let changed := {Aukora.Release.newest with genesis := fun _ => some blank}
  refine ⟨fun _ _ => True.intro, changed, ?_, True.intro⟩
  intro old
  have eq := congrFun old ByteArray.empty
  change some blank = none at eq
  cases eq

end LineageControl

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
      logInfo m!"inert {original.name}: standard genesis changed to True; a different genesis newly satisfies it; each record {src.length} bytes"
      return
  throwError "no equal-size encoding of lineage control"

private def package (basis : Nat) (prior child machine own ent : Expr) : CommandElabM Expr := do
  let priorBytes := (← serialize prior).toByteArray
  let id := RatchetChecker.number (RatchetChecker.identity basis priorBytes)
  -- No honest final proof of the frozen v0.1 goal exists for the carried full machine.
  -- True.intro is an explicitly wrong control in this legacy slot; it is never a fallback.
  return .letE `foundation (.const ``Nat []) (.lit (.natVal basis))
    (.letE `previous (.const ``Nat []) (.lit (.natVal id))
      (.letE `satisfaction (.app child machine) own
        (.letE `entailment (RatchetChecker.entailmentGoal child prior machine) ent
          (mkConst ``True.intro) true) true) true) true

run_cmd
  liftIO <| IO.FS.createDirAll "v0.3/.work/package"
  let env ← getEnv
  let fields (n : Name) := (getStructureFields env n).toList.map toString
  unless fields ``Root12.Lawful == RatchetChecker.inheritedNames do
    throwError "root clause manifest mismatch: {fields ``Root12.Lawful}"
  unless fields ``Root12.Supplement == RatchetChecker.supplementNames do
    throwError "supplement manifest mismatch"
  unless fields ``Root12.Contract == ["inherited","supplement"] do throwError "contract layout"
  let root := mkConst ``Root12.Contract
  let base := mkConst ``Root12.Lawful
  let supp := mkConst ``Root12.Supplement
  let full := mkConst ``Safe11.fullModel
  let .defnInfo g ← getConstInfo ``extraGenesis | throwError "genesis law"
  let strong := add root "standard-genesis" g.value
  let fullSupp ← expanded ``Root12.full_supplement
  let sameEnt ← expanded ``same_entails
  let selfTemplate ← expanded ``self_with_pin
  let strongEnt ← expanded ``strong_entails
  let strongEnt := strongEnt.replace fun e => if e.isConstOf ``extraGenesis then some g.value else none
  let mut rows := [("same",root,fullSupp,sameEnt),
    ("strong",strong,fullSupp,strongEnt),("supplement",supp,fullSupp,identical supp)]
  let clauses := [``Root12.E1,``Root12.E1b,``Root12.E2,``Root12.E3,``Root12.E4,``Root12.E5,``Root12.E6,
    ``Root12.H1,``Root12.H2,``Root12.H3,``Root12.H4,``Root12.H5,``Ratchet11.Succession]
  let labelled := RatchetChecker.supplementNames.zip clauses
  for absent in RatchetChecker.supplementNames.dropLast do
    let claim := labelled.foldl (fun prior (name,p) =>
      if name == absent then prior else add prior name (mkConst p)) base
    rows := rows ++ [("drop-" ++ absent,claim,fullSupp,← omissionSelf claim selfTemplate)]
  let mut roots := [mkConst ``Aukora.Release.Model,mkConst ``Aukora.Release.Lawful,root,full, mkConst ``LineageControl.Lawful]
  for (_,child,own,ent) in rows do
    roots := (← package 0 root child full own ent) :: roots
  snapshot roots [lawName,machineName]
  lineageControl
  let bytes ← liftIO <| IO.FS.readBinFile (out "laws.env")
  let basis := RatchetChecker.number (Sha256.hash bytes)
  for (label,child,own,ent) in rows do
    modelFile label child ``Safe11.fullModel
    let expr ← package basis root child full own ent
    file (label ++ ".proof.expr") (← serialize expr).toByteArray
  let rootBytes := (← serialize root).toByteArray
  unless rootBytes.data == RatchetChecker.rootSpec.data do throwError "root declaration encoding"
  file "root.law" rootBytes
  file "strong.law" (← serialize strong).toByteArray

end Release.Export12
