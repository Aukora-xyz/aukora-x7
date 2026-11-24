import Proofs.Versions
import Proofs.FinalEvidence

namespace Aukora.RootFinal.Historical
open Release
open Versions
open Safe11 (fullModel)
open Evidence11

/-- Historical lookup has no pre-state. The slot supplies a *pure* interpretation
    of a receipt. The complete original bytes stay in the record and bind its digest. -/
def wire (g : WireGrammar) (w : ByteArray) : ByteArray := Id.run do
  if w[0]? ≠ some (255 : UInt8) then return w
  let some v := w[1]? | return w
  if v = 2 then return if g.versionTwo then w else ByteArray.empty
  if v = 3 then return if g.versionTwo && !g.later.isEmpty then w else ByteArray.empty
  if v.toNat < 4 || !g.versionTwo then return w
  let some slot := g.later[v.toNat - 3]? | return w
  let some image := slot.canonicalEvidence w | return w
  return if (Evidence11.decode image).isSome then image else w

theorem legacy_wire (g : WireGrammar) {w} (old : Legacy w) : wire g w = w := by
  simp [wire,old,Id.run]

theorem installed_wire (w : ByteArray) : wire fullModel.grammar w = w := by
  by_cases ff : w[0]? = some (255 : UInt8)
  · cases tag : w[1]? with
    | none => simp [wire,Id.run,ff,tag]
    | some v =>
      by_cases two : v = 2
      · simp [wire,Id.run,ff,tag,two,fullModel,Root12.Grammar.installed]
      · by_cases three : v = 3
        · simp [wire,Id.run,ff,tag,two,three,fullModel,Root12.Grammar.installed]
        · cases ix : v.toNat - 3 <;> simp [wire,Id.run,ff,tag,two,three,fullModel,Root12.Grammar.installed,ix]
  · exact legacy_wire _ ff

/-- All assigned historical dialects, including bytes their reference decoder
    rejects. Reserved prefixes are shared before any assigned namespace. -/
def Known (g : WireGrammar) (w : ByteArray) : Prop :=
  Legacy w ∨ w[1]? = none ∨ ∃ v : UInt8, w[1]? = some v ∧
    ((v.toNat < 2) ∨ (g.versionTwo = true ∧ (v = 2 ∨ (3 ≤ v.toNat ∧ v.toNat - 3 < g.later.length))))

theorem wire_stable {a b} (grow : Grows a b) {w} (known : Known a w) : wire b w = wire a w := by
  by_cases ff : w[0]? = some (255 : UInt8)
  · rcases known with old | no | ⟨v,tag,small | ⟨enabled,early | ⟨lo,slot⟩⟩⟩
    · contradiction
    · simp [wire,Id.run,ff,no]
    · have two : v ≠ 2 := by rintro rfl; exact (by decide : ¬ (2 : UInt8).toNat < 2) small
      have three : v ≠ 3 := by rintro rfl; exact (by decide : ¬ (3 : UInt8).toNat < 2) small
      have low : v.toNat < 4 := by omega
      simp [wire,Id.run,ff,tag,two,three,low]
    · subst v
      simp [wire,Id.run,ff,tag,enabled,grow.1 enabled]
    · obtain ⟨more,eq⟩ := grow.2
      have nonempty : a.later.isEmpty = false := by cases h : a.later <;> simp_all
      have newNonempty : b.later.isEmpty = false := by rw [eq]; cases oldSlots : a.later <;> simp_all
      by_cases three : v = 3
      · subst v
        simp [wire,Id.run,ff,tag,enabled,grow.1 enabled,nonempty,newNonempty]
      · simp [wire,Id.run,ff,tag,enabled,grow.1 enabled,three,eq,List.getElem?_append_left slot]
  · rw [legacy_wire _ ff,legacy_wire _ ff]

def record (g : WireGrammar) (s : Release.State) := s.base.record.map (wire g)
def state (g : WireGrammar) (s : Release.State) : Release.State := {s with base.record := record g s}

/-- Scan the interpreted assessment, retaining the digest of the *original*
    admitted record entry even when its canonical evidence representation differs. -/
def pick (g : WireGrammar) (h : Evidence11.Record) (key : Digest) : Option Assessment :=
  (h.map (fun w => (wire g w,w))).foldl (init := none) fun old (view,raw) =>
    if raw[0]? = some 21 then
      if Digest.mk ((raw.extract 41 73).data.toList) = key then none else old
    else
      match Evidence11.decode view with
      | some ⟨_,pos,.assessment d _ cs⟩ => if d = key then some ⟨pos,Bound4.digest raw,cs⟩ else old
      | _ => old

def names (g : WireGrammar) (s : Release.State) (w : ByteArray) (i : Intent) (a : Assessment) : Prop :=
  w[0]? = some 23 ∧ Policy9.decode w = some (.use i) ∧ pick g s.base.record (Risk8.intentDigest i) = some a

def Stable (g : WireGrammar) (s : Release.State) : Prop := ∀ w ∈ s.base.record, wire g w = w

theorem stable_current (s : Release.State) : Stable fullModel.grammar s := fun w _ => installed_wire w

theorem stable_01 (g : WireGrammar) {s : Release.State}
    (legacy : ∀ w ∈ s.base.record, Legacy w) : Stable g s := fun w mem => legacy_wire g (legacy w mem)

theorem same_record {g s} (old : Stable g s) : record g s = s.base.record := by
  unfold record
  calc
    _ = s.base.record.map id := Array.map_congr_left old
    _ = _ := Array.map_id _

theorem same_state {g s} (old : Stable g s) : state g s = s := by simp [state,same_record old]

theorem same_pick {g s} (old : Stable g s) (key : Digest) : pick g s.base.record key = selected s.base.record key := by
  have eq : s.base.record.map (fun w => (wire g w,w)) = s.base.record.map (fun w => (w,w)) :=
    Array.map_congr_left (fun w member => by rw [old w member])
  simp [pick,selected,eq,Array.foldl_map' (xs := s.base.record) rfl]
  rfl

theorem same_names {g s} (old : Stable g s) {w i a} : names g s w i a ↔ Names s w i a := by
  simp [names,Names,same_pick old]

def E1 (m : Model) : Prop := ∀ {ctx w s t i a c r}, m.step ctx w s = some t →
  names m.grammar s w i a → c ∈ a.claims → r ∈ c.refs →
  ∃ raw, s.base.record[r-1]? = some raw ∧ 0 < r ∧ r < a.pos ∧ a.pos < Policy9.nextSeq s

def E1b (m : Model) : Prop := ∀ {ctx w s t i a c r}, m.step ctx w s = some t →
  names m.grammar s w i a → c ∈ a.claims → r ∈ c.refs →
  ∃ raw parent body, s.base.record[r-1]? = some raw ∧
    Evidence11.decode (wire m.grammar raw) = some ⟨parent,r,body⟩ ∧ fitsKind c.kind (some body) = true

def E2 (m : Model) : Prop := ∀ {ctx w s t i a c ancestor}, m.step ctx w s = some t →
  names m.grammar s w i a → c ∈ a.claims → Derives (record m.grammar s) ⟨a.pos,c⟩ ancestor →
  let hist := record m.grammar s
  let z := ceiling (state m.grammar s)
  c.stated.toNat ≤ (scoreAt hist z a.pos c).bound ∧
    (scoreAt hist z a.pos c).bound ≤ (scoreAt hist z ancestor.pos ancestor.claim).bound ∧
    ancestor.claim.stated.toNat ≤ (scoreAt hist z ancestor.pos ancestor.claim).bound

def E3 (m : Model) : Prop :=
  (∀ {ctx w s t i a c ancestor}, m.step ctx w s = some t →
    names m.grammar s w i a → c ∈ a.claims → Derives (record m.grammar s) ⟨a.pos,c⟩ ancestor →
    ancestor.claim.kind = .guessed → ancestor.claim.stated.toNat ≤ (ceiling (state m.grammar s)).toNat) ∧
  ∀ {ctx w s t}, m.step ctx w s = some t → ceiling (state m.grammar t) ≠ ceiling (state m.grammar s) →
    ∃ p n z ed ml, Evidence11.decode (wire m.grammar w) = some ⟨p,n,.setCeiling z ed ml⟩ ∧
      Hybrid7.Both Core8.verifiers (owner s) (ceilingMessage s p n z) ed ml

def E4 (m : Model) : Prop := ∀ {ctx w s t i a c ancestor q}, m.step ctx w s = some t →
  names m.grammar s w i a → c ∈ a.claims → Derives (record m.grammar s) ⟨a.pos,c⟩ ancestor →
  ancestor.claim.absence = some q →
  ∃ r raw parent read, r ∈ ancestor.claim.refs ∧ r < ancestor.pos ∧ s.base.record[r-1]? = some raw ∧
    Evidence11.decode (wire m.grammar raw) = some ⟨parent,r,.read read⟩ ∧ read.empty = true ∧
    read.query = q ∧ read.first ≤ read.last ∧ read.last ≤ r

def E6 (m : Model) : Prop := ∀ {ctx w s t i a w' s' b},
  m.step ctx w s = some t → names m.grammar s w i a → names m.grammar s' w' i b →
  b.pos = a.pos → SameBasis (state m.grammar s) (state m.grammar s') a.pos →
  List.Forall₂ Weaker a.claims b.claims →
  b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
    b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s' →
  Safe11.halted s' = false → ¬ Forms.Refused s' w' → routeReady m.grammar s' w' i → (m.step ctx w' s').isSome = true

/-- The v0.7 text of `E6`, kept only for the bridge `e6` and step 4. -/
def Old.E6 (m : Model) : Prop := ∀ {ctx w s t i a w' s' b},
  m.step ctx w s = some t → names m.grammar s w i a → names m.grammar s' w' i b →
  b.pos = a.pos → SameBasis (state m.grammar s) (state m.grammar s') a.pos →
  List.Forall₂ Weaker a.claims b.claims →
  b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
    b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s' →
  Safe11.halted s' = false → routeReady m.grammar s' w' i → (m.step ctx w' s').isSome = true

theorem full_e1 : E1 fullModel := by
  simpa only [E1,same_names (stable_current _),Root12.E1] using @Root12.full_supplement.e1

theorem full_e1b : E1b fullModel := by
  simpa only [E1b,same_names (stable_current _),installed_wire,Root12.E1b] using @Root12.full_supplement.e1b

theorem full_e2 : E2 fullModel := by
  simpa only [E2,same_names (stable_current _),same_record (stable_current _),
    same_state (stable_current _),Root12.E2] using @Root12.full_supplement.e2

theorem full_e3 : E3 fullModel := by
  simpa only [E3,same_names (stable_current _),same_record (stable_current _),
    same_state (stable_current _),installed_wire,Root12.E3,Root12.GuessBound,Root12.CeilingControl] using @Root12.full_supplement.e3

theorem full_e4 : E4 fullModel := by
  simpa only [E4,same_names (stable_current _),same_record (stable_current _),
    installed_wire,Root12.E4] using @Root12.full_supplement.e4

theorem Old.full_e6 : Old.E6 fullModel := by
  simpa only [Old.E6,same_names (stable_current _),same_state (stable_current _),Lowering] using @full_lowering

theorem full_e6 : E6 fullModel :=
  fun hit n n' pos basis weak bundle running _ ready => Old.full_e6 hit n n' pos basis weak bundle running ready

def allows (g : WireGrammar) (s : Release.State) (w : ByteArray) (i : Intent) : Bool :=
  match pick g s.base.record (Risk8.intentDigest i) with
  | none => true
  | some a =>
    decide (a.bundle = ⟨(w.extract 1 33).data.toList⟩ ∧ 0 < a.pos ∧
      a.pos ≤ s.base.record.size ∧ a.pos < Policy9.nextSeq s) &&
    a.claims.all (fun c => (scoreAt (record g s) (ceiling (state g s)) a.pos c).good)

theorem allows_of_stable {g s} (old : Stable g s) (w i) : allows g s w i = Evidence11.allows s w i := by
  simp [allows,Evidence11.allows,same_pick old,same_record old,same_state old,scoreAt]
  cases selected s.base.record (Risk8.intentDigest i) <;> rfl

theorem full_allows (s w i) : allows fullModel.grammar s w i = Evidence11.allows s w i :=
  allows_of_stable (stable_current s) w i

/- The old declarations quantify over history as well as the final input. On a
    01 trace, each stored receipt and the last frame lie in the 01 namespace.
    These statements also apply verbatim to any mixed history with stable semantics. -/
namespace Bridge

theorem e1 {m} (h : E1 m) {ctx w s t i a c r} (old : Stable m.grammar s)
    (hit : m.step ctx w s = some t) (named : Names s w i a) (claim : c ∈ a.claims) (ref : r ∈ c.refs) :
    ∃ raw, s.base.record[r-1]? = some raw ∧ 0 < r ∧ r < a.pos ∧ a.pos < Policy9.nextSeq s :=
  h hit ((same_names old).mpr named) claim ref

theorem e1b {m} (h : E1b m) {ctx w s t i a c r} (old : Stable m.grammar s)
    (hit : m.step ctx w s = some t) (named : Names s w i a) (claim : c ∈ a.claims) (ref : r ∈ c.refs) :
    ∃ raw p b, s.base.record[r-1]? = some raw ∧ Evidence11.decode raw = some ⟨p,r,b⟩ ∧ fitsKind c.kind (some b) = true := by
  obtain ⟨raw,p,b,idx,dec,good⟩ := h hit ((same_names old).mpr named) claim ref
  rw [old raw (Array.mem_of_getElem? idx)] at dec
  exact ⟨raw,p,b,idx,dec,good⟩

theorem e2 {m} (h : E2 m) {ctx w s t i a c ancestor} (old : Stable m.grammar s)
    (hit : m.step ctx w s = some t) (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) :
    let hist := s.base.record
    let z := ceiling s
    c.stated.toNat ≤ (scoreAt hist z a.pos c).bound ∧
      (scoreAt hist z a.pos c).bound ≤ (scoreAt hist z ancestor.pos ancestor.claim).bound ∧
      ancestor.claim.stated.toNat ≤ (scoreAt hist z ancestor.pos ancestor.claim).bound := by
  simpa only [same_record old,same_state old] using
    h hit ((same_names old).mpr named) claim (by simpa only [same_record old] using chain)

theorem guess {m} (h : E3 m) {ctx w s t i a c ancestor} (old : Stable m.grammar s)
    (hit : m.step ctx w s = some t) (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) (guess : ancestor.claim.kind = .guessed) :
    ancestor.claim.stated.toNat ≤ (ceiling s).toNat := by
  simpa only [same_state old] using h.1 hit ((same_names old).mpr named) claim
    (by simpa only [same_record old] using chain) guess

theorem ceiling_control {m} (h : E3 m) {ctx w s t} (before : Stable m.grammar s) (after_ : Stable m.grammar t)
    (old : Legacy w) (hit : m.step ctx w s = some t) (change : ceiling t ≠ ceiling s) :
    ∃ p n z ed ml, Evidence11.decode w = some ⟨p,n,.setCeiling z ed ml⟩ ∧
      Hybrid7.Both Core8.verifiers (owner s) (ceilingMessage s p n z) ed ml := by
  simpa only [legacy_wire m.grammar old] using h.2 hit
    (by simpa only [same_state before,same_state after_] using change)

theorem e4 {m} (h : E4 m) {ctx w s t i a c ancestor q} (old : Stable m.grammar s)
    (hit : m.step ctx w s = some t) (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) (absent : ancestor.claim.absence = some q) :
    ∃ r raw parent read, r ∈ ancestor.claim.refs ∧ r < ancestor.pos ∧ s.base.record[r-1]? = some raw ∧
      Evidence11.decode raw = some ⟨parent,r,.read read⟩ ∧ read.empty = true ∧
      read.query = q ∧ read.first ≤ read.last ∧ read.last ≤ r := by
  obtain ⟨r,raw,p,b,ref,pos,idx,dec,tail⟩ := h hit ((same_names old).mpr named) claim
    (by simpa only [same_record old] using chain) absent
  rw [old raw (Array.mem_of_getElem? idx)] at dec
  exact ⟨r,raw,p,b,ref,pos,idx,dec,tail⟩

open private RootFinal.route_iff from Proofs.FinalEvidence

theorem e6 {m} (h : Old.E6 m) {ctx w s t i a w' s' b} (old : Stable m.grammar s)
    (other : Stable m.grammar s') (hit : m.step ctx w s = some t) (named : Names s w i a) (second : Names s' w' i b)
    (pos : b.pos = a.pos) (basis : SameBasis s s' a.pos) (weaker : List.Forall₂ Weaker a.claims b.claims)
    (address : b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
      b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s') (active : Safe11.halted s' = false)
    (route : (Ratchet11.step ctx w' s').isSome = true) : (m.step ctx w' s').isSome = true :=
  h hit ((same_names old).mpr named) ((same_names other).mpr second) pos
    (by simpa only [same_state old,same_state other] using basis) weaker address active ((RootFinal.route_iff second).mpr route)

end Bridge

def describes (s : Release.State) (e : Evidence11.Envelope) (op : ExtensionKind) : Prop :=
  match e.body with
  | .assessment i score _ => op = .assessment i score
  | .outcome i v fix _ => op = .report i v fix
  | .setCeiling z ed ml => op = .passive ∧ Hybrid7.Both Core8.verifiers (owner s)
      (ceilingMessage s e.parent e.seq z) ed ml
  | _ => op = .passive

def Lineage (m : Model) : Prop :=
  (∀ (child : Model), Root12.Grammar.Preserves m.grammar child →
    ∀ w, Known m.grammar w → wire child.grammar w = wire m.grammar w) ∧
  ∀ ctx w s t (v : UInt8) e, m.step ctx w s = some t → w[0]? = some 255 → w[1]? = some v → 4 ≤ v.toNat →
    Evidence11.decode (wire m.grammar w) = some e →
    ∃ d op, Root12.Grammar.decode m.grammar s w = some d ∧ d.payload = .later v w op ∧
      d.frame.parent = e.parent ∧ d.frame.seq = e.seq ∧ describes s e op

theorem full_lineage : Lineage fullModel := by
  refine ⟨fun _ pin _ known => wire_stable (grows_of_pin pin) known,?_⟩
  intro ctx w s t v e hit ff vv large dec
  have two : v ≠ 2 := by rintro rfl; exact (by decide : ¬ 4 ≤ (2 : UInt8).toNat) large
  have three : v ≠ 3 := by rintro rfl; exact (by decide : ¬ 4 ≤ (3 : UInt8).toNat) large
  simp [installed_wire,Evidence11.decode,Evidence11.cellSubtag,Evidence11.subtag,ff,vv,two,three] at dec

#print axioms full_lineage
#print axioms full_e3
#print axioms full_e6
end Aukora.RootFinal.Historical
