import Proofs.Versions
import Proofs.FinalAdvice
import Proofs.FinalUpgrade
namespace Aukora.RootFinal.Ports
open Release
open Versions
open Safe11 (innerModel)
open private Core8.actRoute Core8.slice from Ledger.Assessed
open private Release.route_of_tag from Proofs.DangerPolicy

structure Delivery where
  frame : R2.Frame
  intent : Intent
  useGrant : Bool
  bundle : Digest

private def fromLegacy (w : ByteArray) (x : Wire5.Frame) (i : Intent) (uses : Bool) : Delivery :=
  ⟨x.project,i,uses,⟨Core8.slice w 1 33⟩⟩

/-- Only the immutable prefix currently has a spend or installer. New slots
    may introduce rule, risk and finding kinds but the shared effect type has
    no new spend/install constructor. The contract consumes installed events. -/
def DeliveryAt (g : WireGrammar) (s : Release.State) (w : ByteArray) (d : Delivery) : Prop :=
  ∃ parsed, Root12.Grammar.decode g s w = some parsed ∧
    match parsed.payload with
    | .legacy => Tagged w 23 ∧ Tracked w (.use d.intent) ∧
      ∃ x, Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (d.intent,d.useGrant) ∧
        d.frame = x.project ∧ d.bundle = ⟨Core8.slice w 1 33⟩
    | _ => False

def installation (g : WireGrammar) (s : Release.State) (w : ByteArray) : Option Upgrade9.Package := do
  let d ← Root12.Grammar.decode g s w
  match d.payload with
  | .legacy => Upgrade9.decode w
  | _ => none

private theorem useFields {g s w d} (read : DeliveryAt g s w d) :
    Tagged w 23 ∧ Tracked w (.use d.intent) ∧ ∃ x, Wire5.decode (w.extract 33 w.size) = some x ∧
      Core8.actRoute x = some (d.intent,d.useGrant) ∧ d.frame = x.project ∧ d.bundle = ⟨Core8.slice w 1 33⟩ := by
  obtain ⟨parsed,_,part⟩ := read
  cases parsed with
  | mk f payload => cases payload <;> first | exact part | exact False.elim part

private theorem readUse {w i} (tag : Tagged w 23) (tr : Tracked w (.use i)) (g : WireGrammar) (s) :
    ∃ x granted, Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (i,granted) ∧
      DeliveryAt g s w (fromLegacy w x i granted) := by
  obtain ⟨x,j,grant,eq,wire,route⟩ := Release.route_of_tag tag tr.2
  cases Policy9.Command.use.inj eq
  have old : Legacy w := by change w[0]? ≠ some (255 : UInt8); rw [tag]; decide
  have proj : projected w = some x.project := by simp [projected,tr.1,tr.2,entryFor,wire]
  exact ⟨x,grant,wire,route,⟨⟨x.project,.legacy⟩,by simp [Root12.Grammar.legacy_stable g s w old,proj],
    tag,tr,x,wire,route,rfl,rfl⟩⟩

private theorem admittedUse {m : Model} (rec : Root12.Record m) {ctx w s t} (tag : Tagged w 23)
    (hit : m.step ctx w s = some t) : ∃ d, DeliveryAt m.grammar s w d := by
  have old : Legacy w := by change w[0]? ≠ some (255 : UInt8); rw [tag]; decide
  have no : ¬Tagged w 27 := by change w[0]? ≠ some (27 : UInt8); rw [tag]; decide
  obtain ⟨_,parsed⟩ := Bridges.record_parse rec old hit
  unfold projected at parsed
  rw [if_neg no] at parsed
  obtain ⟨c,dec,_⟩ := Option.bind_eq_some.mp parsed
  obtain ⟨_,i,_,rfl,_⟩ := Release.route_of_tag tag dec
  obtain ⟨_,_,_,_,read⟩ := readUse tag ⟨no,dec⟩ m.grammar s
  exact ⟨_,read⟩

private theorem readInstall {w u} (tag : Tagged w 27) (dec : Upgrade9.decode w = some u) (g : WireGrammar) (s) :
    installation g s w = some u := by
  have old : Legacy w := by change w[0]? ≠ some (255 : UInt8); rw [tag]; decide
  simp [installation,Root12.Grammar.legacy_stable _ _ _ old,projected,tag,dec]

private theorem installFields {g s w u} (read : installation g s w = some u) :
    Tagged w 27 ∧ Upgrade9.decode w = some u := by
  obtain ⟨d,_,last⟩ := Option.bind_eq_some.mp read
  cases p : d.payload <;> simp [p] at last
  have tag : Tagged w 27 := by
    by_contra no
    simp [Upgrade9.decode,guard,show w[0]? ≠ some (27 : UInt8) from no] at last
    cases last
  exact ⟨tag,last⟩

private theorem admittedInstall {m : Model} (rec : Root12.Record m) {ctx w s t} (tag : Tagged w 27)
    (hit : m.step ctx w s = some t) : ∃ u, installation m.grammar s w = some u := by
  have old : Legacy w := by change w[0]? ≠ some (255 : UInt8); rw [tag]; decide
  obtain ⟨_,proj⟩ := Bridges.record_parse rec old hit
  unfold projected at proj
  rw [if_pos tag] at proj
  obtain ⟨u,dec,_⟩ := Option.map_eq_some'.mp proj
  exact ⟨u,readInstall tag dec _ _⟩

def Monotone (m : Model) : Prop :=
  ∀ ctx w s d (low high : UInt8) bundle, DeliveryAt m.grammar s w d → low.toNat ≤ high.toNat →
    m.step ctx w (atScore s (Risk8.intentDigest d.intent) low bundle) = none →
    m.step ctx w (atScore s (Risk8.intentDigest d.intent) high bundle) = none

def Missing (m : Model) : Prop :=
  ∀ ctx w s t d, DeliveryAt m.grammar s w d → m.step ctx w s = some t →
    let i := Risk8.intentDigest d.intent
    Risk8.lookup s.base.risk i = none → d.useGrant = true ∧ d.bundle = Risk8.defaultBundle i ∧
      t.base.risk.admissions = ⟨i,255,Risk8.defaultBundle i,true⟩ :: s.base.risk.admissions

def Bundle (m : Model) : Prop :=
  ∀ ctx w s t d, DeliveryAt m.grammar s w d → m.step ctx w s = some t →
    let i := Risk8.intentDigest d.intent
    let effective := Risk8.effective s.base.risk i
    Bound4.next (fun _ => Bound4.digest w) s.base.hybrid.inner d.frame = some t.base.hybrid.inner ∧
      d.bundle = effective.bundle ∧
      t.base.risk.admissions = ⟨i,effective.score,d.bundle,(Risk8.lookup s.base.risk i).isNone⟩ :: s.base.risk.admissions ∧
      t.base.record = s.base.record.push w

def Floor (m : Model) (start : Release.State) : Prop :=
  (∀ ctx xs w t u, let s := run m ctx start xs
    installation m.grammar s w = some u → m.step ctx w s = some t →
      u.intent.body = .install u.target ∧ GrantOrigin9.Signed (owner s) u.intent ∧ u.intent ∈ pool s ∧ u.intent ∉ pool t) ∧
    Binding m ∧
    ∀ ctx xs w t d, let s := run m ctx start xs
      DeliveryAt m.grammar s w d → m.step ctx w s = some t →
      s.base.risk.threshold.toNat ≤ (Risk8.effective s.base.risk (Risk8.intentDigest d.intent)).score.toNat →
      d.useGrant = true ∧ d.intent ∈ pool s ∧ d.intent ∉ pool t ∧ GrantOrigin9.Signed (owner s) d.intent

def Succession (m : Model) : Prop :=
  ∀ ctx w s t u, installation m.grammar s w = some u → m.step ctx w s = some t → Ratchet11.Demands ctx s t u

def UpgradeInstalled (m : Model) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → (ledger t).book.auth.core ≠ (ledger s).book.auth.core →
    ∃ u, installation m.grammar s w = some u ∧ PackageFacts ctx w s t u

theorem full_monotone : Monotone innerModel := by
  intro ctx w s d low high bundle read
  have f := useFields read
  exact RootFinal.full_monotone ctx w s d.intent low high bundle f.1 f.2.1

theorem full_missing : Missing innerModel := by
  intro ctx w s t d read hit
  obtain ⟨tag,tr,x,dec,route,_,bun⟩ := useFields read
  obtain ⟨y,i,g,yd,yr,missing⟩ := RootFinal.full_missing ctx w s t tag hit
  cases Option.some.inj (dec.symm.trans yd)
  cases Option.some.inj (route.symm.trans yr)
  simpa only [bun] using missing

theorem full_bundle : Bundle innerModel := by
  intro ctx w s t d read hit
  obtain ⟨tag,tr,x,dec,route,frame,bun⟩ := useFields read
  obtain ⟨y,i,g,yd,yr,next,all⟩ := RootFinal.full_bundle ctx w s t tag hit
  cases Option.some.inj (dec.symm.trans yd)
  cases Option.some.inj (route.symm.trans yr)
  exact ⟨frame ▸ next,by simpa only [bun] using all⟩

theorem floor_of_legacy {m : Model} {start} (floor : FloorLaw m start) (bind : Binding m) : Floor m start := by
  refine ⟨?_,bind,?_⟩
  · intro ctx xs w t u
    dsimp only
    intro read ok
    have parts := installFields read
    obtain ⟨v,parsed,rest⟩ := floor.1 ctx xs w t parts.1 ok
    cases Option.some.inj (parts.2.symm.trans parsed)
    exact rest
  · intro ctx xs w t d
    dsimp only
    intro read ok
    obtain ⟨tag,tr,x,dec,route,_,_⟩ := useFields read
    obtain ⟨y,i,g,yd,yr,rest⟩ := floor.2.2 ctx xs w t tag ok
    cases Option.some.inj (dec.symm.trans yd)
    cases Option.some.inj (route.symm.trans yr)
    exact rest

theorem full_floor {key start} (genesis : innerModel.genesis key = some start) : Floor innerModel start :=
  floor_of_legacy (RootFinal.full_floor genesis) full_binding

theorem full_succession : Succession innerModel := by
  intro ctx w s t u parsed hit
  obtain ⟨tag,dec⟩ := installFields parsed
  obtain ⟨v,got,proofs⟩ := Round11.full_succession ctx w s t tag hit
  exact Option.some.inj (got.symm.trans dec) ▸ proofs

theorem full_upgrade : UpgradeInstalled innerModel := by
  intro ctx w s t hit change
  obtain ⟨tag,u,dec,facts⟩ := RootFinal.full_upgrade ctx w s t hit change
  exact ⟨u,readInstall tag dec _ _,facts⟩

namespace Bridge

theorem monotone {m} (law : Monotone m) : MonotoneLaw m := by
  intro ctx w s i low high b tag tr
  obtain ⟨x,granted,_,_,read⟩ := readUse tag tr m.grammar s
  exact law ctx w s (fromLegacy w x i granted) low high b read

theorem missing {m} (rec : Root12.Record m) (law : Missing m) : MissingLaw m := by
  intro ctx w s t tag hit
  obtain ⟨d,read⟩ := admittedUse rec tag hit
  obtain ⟨_,_,x,dec,route,_,bun⟩ := useFields read
  exact ⟨x,d.intent,d.useGrant,dec,route,by simpa only [bun] using law ctx w s t d read hit⟩

theorem bundle {m} (rec : Root12.Record m) (law : Bundle m) : BundleLaw m := by
  intro ctx w s t tag hit
  obtain ⟨d,read⟩ := admittedUse rec tag hit
  obtain ⟨_,_,x,dec,route,frame,bun⟩ := useFields read
  obtain ⟨next,rest⟩ := law ctx w s t d read hit
  exact ⟨x,d.intent,d.useGrant,dec,route,by simpa only [frame] using next,by simpa only [bun] using rest⟩

theorem floor {m} {start} (rec : Root12.Record m) (law : Floor m start) : FloorLaw m start := by
  refine ⟨?_,?_,?_⟩
  · intro ctx xs w t
    dsimp only
    intro tag hit
    obtain ⟨u,read⟩ := admittedInstall rec tag hit
    exact ⟨u,(installFields read).2,law.1 ctx xs w t u read hit⟩
  · intro ctx w s t p n keys ed ml tr hit
    exact ((Bridges.binding law.2.1 (tracked_old tr) hit).2 p n keys ed ml tr).2
  · intro ctx xs w t
    dsimp only
    intro tag hit
    obtain ⟨d,read⟩ := admittedUse rec tag hit
    obtain ⟨_,_,x,dec,route,_,_⟩ := useFields read
    exact ⟨x,d.intent,d.useGrant,dec,route,law.2.2 ctx xs w t d read hit⟩

theorem succession {m} (rec : Root12.Record m) (law : Succession m) : Ratchet11.Succession m := by
  intro ctx w s t tag hit
  obtain ⟨u,read⟩ := admittedInstall rec tag hit
  exact ⟨u,(installFields read).2,law ctx w s t u read hit⟩

theorem upgrade_package {m} (law : UpgradeInstalled m) : Upgrade m := by
  intro ctx w s t hit change
  obtain ⟨u,read,facts⟩ := law ctx w s t hit change
  exact ⟨(installFields read).1,u,(installFields read).2,facts⟩

end Bridge
end Aukora.RootFinal.Ports
