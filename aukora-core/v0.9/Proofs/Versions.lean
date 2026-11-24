import Versions
import Proofs.FinalCore
namespace Aukora.RootFinal

open Release
open Versions
open Safe11 (fullModel)
open R6.KernelCell (Context)
open private Core8.slice from Ledger.Assessed
open private Root12.Grammar.second from Laws

namespace Bridges

theorem old_interpretation (g : WireGrammar) (s : Release.State) {w} (old : Legacy w) :
    interpretations g s w = (projected w).map (fun _ => Meaning.legacy) := by
  simp [interpretations,Root12.Grammar.legacy_stable _ _ _ old,Function.comp_def,meaning]

theorem old_effect {m : Model} {property} (h : ExplainedBy m property) {ctx w s t}
    (old : Legacy w) (hit : m.step ctx w s = some t) : property s t w .legacy := by
  obtain ⟨k,found,ok⟩ := h ctx w s t hit
  rw [old_interpretation _ _ old] at found
  obtain ⟨_,_,rfl⟩ := Option.map_eq_some'.mp found
  exact ok

theorem record_parse {m : Model} (h : Root12.Record m) {ctx w s t}
    (old : Legacy w) (hit : m.step ctx w s = some t) : ∃ f, projected w = some f := by
  obtain ⟨d,parse⟩ := h.parses ctx w s t hit
  rw [Root12.Grammar.legacy_stable _ _ _ old] at parse
  obtain ⟨f,proj,_⟩ := Option.map_eq_some'.mp parse
  exact ⟨f,proj⟩

theorem record_history {m : Model} (h : Root12.Record m) {key start}
    (gen : m.genesis key = some start) {ctx s xs} (old : Only01 xs) :
    (ledger (run m ctx s xs)).history = (ledger s).history ++ acceptedHistory m ctx s xs := by
  rw [h.ledger key start gen ctx s xs,old_history m ctx s xs old]

theorem rules {m : Model} (h : Rules m) {ctx w s t} (old : Legacy w)
    (hit : m.step ctx w s = some t) :
    (Tagged w 27 ∧ t.rules = s.rules) ∨ ∃ c, Tracked w c ∧
      t.rules = Policy9.rulesAfter s.rules (Policy9.selected s c) c := old_effect h old hit

theorem risk {m : Model} (h : RiskState m) {ctx w s t} (old : Legacy w)
    (hit : m.step ctx w s = some t) :
    (Tagged w 27 ∧ t.base.risk = s.base.risk) ∨ ∃ c, Tracked w c ∧
      riskAfter w s c = some t.base.risk := old_effect h old hit

theorem binding {m : Model} (h : Binding m) {ctx w s t} (old : Legacy w)
    (hit : m.step ctx w s = some t) :
    (owner t ≠ owner s → Rebound s t w) ∧
    ∀ p n keys ed ml, Tracked w (.rebind p n keys ed ml) →
      owner t = keys ∧ Hybrid7.Both Core8.verifiers (owner s)
        (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml := old_effect h old hit

theorem findings {m : Model} (h : Root12.Record m) (ctx s xs) (old : Only01 xs) :
    RootFinal.findings m ctx s xs = findingsIn m ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    have tail : Only01 cs := fun w mem => old w (List.mem_cons_of_mem _ mem)
    simp only [RootFinal.findings,findingsIn,ih _ tail]
    congr 1
    cases c with
    | frame w =>
      cases hit : m.step ctx w s with
      | none => simp [RootFinal.findingAt,Release.findingAt,hit]
      | some t =>
        have baseline := old w (by simp)
        obtain ⟨f,dec⟩ := record_parse h baseline hit
        simp [RootFinal.findingAt,Release.findingAt,hit,old_interpretation _ _ baseline,dec,Versions.finding]
    | _ => rfl

theorem outcome {m : Model} {start} (record : Root12.Record m) (h : Outcome m start)
    (ctx xs key i) (old : Only01 xs) :
    let reported := ∃ f ∈ acceptedHistory m ctx start xs, f.action = .base (.outcome i .confirmed)
    let found := findingsIn m ctx start xs
    let final := run m ctx start xs
    ((everConfirmed final i = .confirmed ↔ reported) ∧ (everConfirmed final i = .unknown ↔ ¬ reported)) ∧
      final.outcomes = found ∧ m.outcome final key = Policy9.outcomeCode {final with outcomes := found} key := by
  exact ⟨by simpa only [old_history m ctx start xs old] using h.1 ctx xs i,
    by simpa only [findings record ctx start xs old] using h.2 ctx xs key⟩

end Bridges

/-- A new grant originates in a signed issue of the installed dialect.
    Old signed grants and timed issues keep their original message meanings. -/
def grantWitness (s : Release.State) (w : ByteArray) (i : Intent) : Meaning → Prop
  | .legacy => Issued s w i
  | .extension (.issue p n last j ed ml) =>
    i = j ∧ addressed s p n ∧ n < last ∧
      Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml
  | _ => False

def GrantSource (m : Model) : Prop :=
  ∀ ctx w s t i, m.step ctx w s = some t → i ∉ pool s → i ∈ pool t →
    ∃ k, interpretations m.grammar s w = some k ∧ grantWitness s w i k

private theorem legacy_of_issue {s w i} (issued : Issued s w i) : Legacy w := by
  rcases issued with ⟨_,_,_,tr,_⟩ | ⟨_,_,_,_,_,tr,_⟩ <;> exact tracked_old tr

private theorem legacyEvent {m : Model} (r : Root12.Record m) {ctx s w t}
    (old : Legacy w) (hit : m.step ctx w s = some t) : interpretations m.grammar s w = some .legacy := by
  obtain ⟨f,parsed⟩ := Bridges.record_parse r old hit
  simp [Bridges.old_interpretation _ _ old,parsed]

theorem full_grantSource : GrantSource fullModel := by
  intro ctx w s t i hit absent held
  have issued := full_grant ctx w s t i hit absent held
  exact ⟨_,legacyEvent Root12.full_record (legacy_of_issue issued) hit,issued⟩

def thresholdWitness (s t : Release.State) (w : ByteArray) : Meaning → Prop
  | .legacy =>
    Tracked w .threshold ∧ w[41]? = some t.base.risk.threshold ∧
      Hybrid7.Both Core8.verifiers (owner s) (Risk8.thresholdMessage (owner s)
        (Policy9.generation s) (ledger s).head (Policy9.nextSeq s) t.base.risk.threshold)
        (Core8.slice w 42 106) (Core8.slice w 106 w.size)
  | .extension (.threshold p n level ed ml) =>
    addressed s p n ∧ t.base.risk.threshold = level ∧ Hybrid7.Both Core8.verifiers (owner s)
      (Risk8.thresholdMessage (owner s) (Policy9.generation s) p n level) ed ml
  | _ => False

def SignedThreshold (m : Model) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → t.base.risk.threshold ≠ s.base.risk.threshold →
    ∃ k, interpretations m.grammar s w = some k ∧ thresholdWitness s t w k

theorem full_signedThreshold : SignedThreshold fullModel := by
  intro ctx w s t hit changed
  have signed := full_threshold ctx w s t hit changed
  exact ⟨_,legacyEvent Root12.full_record (tracked_old signed.1) hit,signed⟩

/-- The stamp port has no reserved prefix. Check the old reader first, even for a
    digest beginning ff. Only previously undecoded inputs may reach a new slot. -/
def decodeSidecar (g : WireGrammar) (w : ByteArray) : Option (Digest × ByteArray × Digest) :=
  match Core8.decodeStamp w with
  | some stamp => some stamp
  | none => do
    guard (w[0]? = some (255 : UInt8) ∧ g.versionTwo = true)
    let v ← w[1]?
    guard (3 ≤ v.toNat)
    let slot ← g.later[v.toNat - 3]?
    slot.sidecar w

theorem sidecar_preserves_old {g w p} (old : Core8.decodeStamp w = some p) :
    decodeSidecar g w = some p := by simp [decodeSidecar,old]

theorem sidecar_stable {a b w p} (growth : Grows a b) (h : decodeSidecar a w = some p) :
    decodeSidecar b w = some p := by
  cases old : Core8.decodeStamp w with
  | some val => simpa [decodeSidecar,old] using h
  | none =>
    simp only [decodeSidecar,old] at h ⊢
    obtain ⟨_,head,h⟩ := Option.bind_eq_some.mp h
    have ready : w[0]? = some (255 : UInt8) ∧ a.versionTwo = true := by
      by_contra no
      simp [guard,no] at head
    obtain ⟨v,tag,h⟩ := Option.bind_eq_some.mp h
    obtain ⟨_,ok,h⟩ := Option.bind_eq_some.mp h
    have valid : 3 ≤ v.toNat := by
      by_contra no
      simp [guard,no] at ok
    obtain ⟨slot,read,result⟩ := Option.bind_eq_some.mp h
    have ix : v.toNat - 3 < a.later.length := by
      by_contra no
      rw [List.getElem?_eq_none (Nat.le_of_not_gt no)] at read
      contradiction
    obtain ⟨more,append⟩ := growth.2
    simp [guard,ready.1,growth.1 ready.2,tag,valid,append,List.getElem?_append_left ix,read,result]

private theorem currentSidecar (w : ByteArray) : decodeSidecar fullModel.grammar w = Core8.decodeStamp w := by
  cases old : Core8.decodeStamp w with
  | some val => exact sidecar_preserves_old old
  | none =>
    simp only [decodeSidecar,old]
    by_cases leading : w[0]? = some (255 : UInt8)
    · cases tag : w[1]? with
      | none => simp [fullModel,Root12.Grammar.installed,leading,tag,guard]
      | some v =>
        cases ix : v.toNat - 3 <;> simp [fullModel,Root12.Grammar.installed,leading,tag,guard,ix]
    · simp [fullModel,Root12.Grammar.installed,leading,guard]

def Stamping (m : Model) : Prop :=
  ∀ w s t, m.stamp w s = some t →
    (∃ beacon receipt, decodeSidecar m.grammar w = some ((ledger s).head,beacon,receipt)) ∧
      t = {s with base.stamps := s.base.stamps.push w}

theorem full_stamping : Stamping fullModel := by
  intro w s t hit
  rw [currentSidecar]
  exact newest_stamp w s t hit

/-- Retain every old unsigned verdict, including failed parses, while expressing
    the reference as the underlying policy and halted boundary. Extensions with
    passive speech get the same ledger address and statement checks. -/
def speechReference (s : Release.State) (w : ByteArray) :=
  if Safe11.halted s && !Safe11.allowedOrdinary w then false else (Policy9.step w s).isSome

def Speech (m : Model) : Prop :=
  (∀ ctx w s, Tagged w 0 → ¬ Forms.Refused s w → (m.step ctx w s).isSome = speechReference s w) ∧
  ∀ ctx s w d v raw line, Root12.Grammar.decode m.grammar s w = some d →
    d.payload = .later v raw .passive → d.frame.action = .base (.say line) →
    (m.grammar.later[v.toNat-3]?.bind (fun slot => (slot.canonicalEvidence w).bind Evidence11.decode)) = none →
    ¬ Forms.Refused s w →
    (m.step ctx w s).isSome = (Bound4.next (fun _ => Bound4.digest w) s.base.hybrid.inner d.frame).isSome

/-- The v0.7 text of `Speech`, kept only for the E5 bridge and step 4. -/
def Old.Speech (m : Model) : Prop :=
  (∀ ctx w s, Tagged w 0 → (m.step ctx w s).isSome = speechReference s w) ∧
  ∀ ctx s w d v raw line, Root12.Grammar.decode m.grammar s w = some d →
    d.payload = .later v raw .passive → d.frame.action = .base (.say line) →
    (m.grammar.later[v.toNat-3]?.bind (fun slot => (slot.canonicalEvidence w).bind Evidence11.decode)) = none →
    (m.step ctx w s).isSome = (Bound4.next (fun _ => Bound4.digest w) s.base.hybrid.inner d.frame).isSome

theorem speech_reference_01 {ctx w s} (tag : Tagged w 0) :
    (Safe11.step (Ratchet11.step ctx) w s).isSome = speechReference s w := by
  have no : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
  have normal : Safe11.route w = .ordinary := by simp [Safe11.route,tag]
  simp only [Safe11.step,Safe11.raw,normal,speechReference]
  split <;> simp [Ratchet11.step,Ratchet11.allow_ordinary no,Core9.step,no]

private theorem noFuture {s w d v raw op} (parsed : Root12.Grammar.decode fullModel.grammar s w = some d) :
    d.payload ≠ .later v raw op := by
  intro future
  by_cases ff : w[0]? = some (255 : UInt8)
  · cases code : w[1]? with
    | none => simp [Root12.Grammar.decode,ff,code] at parsed
    | some byte =>
      by_cases v2 : byte = 2
      · subst byte
        have p : Root12.Grammar.second s w = some d := by
          simpa [fullModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,code] using parsed
        cases rt : Safe11.route w with
        | ordinary =>
          simp only [Root12.Grammar.second,rt] at p
          obtain ⟨e,_,eq⟩ := Option.bind_eq_some.mp p
          cases Option.some.inj eq
          contradiction
        | halt | clear | rebind =>
          simp only [Root12.Grammar.second,rt] at p
          obtain ⟨_,_,eq⟩ := Option.bind_eq_some.mp p
          cases Option.some.inj eq
          contradiction
        | refusal =>
          simp only [Root12.Grammar.second,rt] at p
          obtain ⟨_,_,part⟩ := Option.bind_eq_some.mp p
          obtain ⟨cmd,_,eq⟩ := Option.bind_eq_some.mp part
          cases cmd <;> cases eq <;> contradiction
      · by_cases three : byte = 3
        · subst byte
          cases de : Evidence11.decode w with
          | none => simp [fullModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,code,guard,Root12.Grammar.third,de] at parsed
          | some e =>
            simp [fullModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,code,guard,Root12.Grammar.third,de] at parsed
            subst d
            contradiction
        · cases ix : byte.toNat - 3 <;>
            simp [fullModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,code,v2,three,ix,guard] at parsed
  · rw [Root12.Grammar.legacy_stable _ _ _ ff] at parsed
    obtain ⟨f,_,rfl⟩ := Option.map_eq_some'.mp parsed
    contradiction

theorem Old.full_speech : Old.Speech fullModel :=
  ⟨fun ctx w s tag => (Root12.full_supplement.e5 ctx w s tag).trans (speech_reference_01 tag),
   fun _ _ _ _ _ _ _ parsed later _ _ => False.elim (noFuture parsed later)⟩

theorem full_speech : Speech fullModel :=
  ⟨fun ctx w s tag _ => Old.full_speech.1 ctx w s tag,
   fun ctx s w d v raw line dec p act none_ _ => Old.full_speech.2 ctx s w d v raw line dec p act none_⟩

namespace Bridges

theorem grant {m : Model} (h : GrantSource m) {ctx w s t i} (old : Legacy w)
    (hit : m.step ctx w s = some t) (absent : i ∉ pool s) (held : i ∈ pool t) : Issued s w i := by
  obtain ⟨k,found,ok⟩ := h ctx w s t i hit absent held
  rw [old_interpretation _ _ old] at found
  obtain ⟨_,_,rfl⟩ := Option.map_eq_some'.mp found
  exact ok

theorem threshold {m : Model} (h : SignedThreshold m) {ctx w s t} (old : Legacy w)
    (hit : m.step ctx w s = some t) (changed : t.base.risk.threshold ≠ s.base.risk.threshold) :
    thresholdWitness s t w .legacy := by
  obtain ⟨k,found,ok⟩ := h ctx w s t hit changed
  rw [old_interpretation _ _ old] at found
  obtain ⟨_,_,rfl⟩ := Option.map_eq_some'.mp found
  exact ok

theorem stamp {m : Model} (h : Stamping m) {w s t p b r} (old : Core8.decodeStamp w = some (p,b,r))
    (hit : m.stamp w s = some t) : p = (ledger s).head ∧ t = {s with base.stamps := s.base.stamps.push w} := by
  obtain ⟨⟨beacon,receipt,parsed⟩,eq⟩ := h w s t hit
  rw [sidecar_preserves_old old] at parsed
  cases Option.some.inj parsed
  exact ⟨rfl,eq⟩

theorem speech {m : Model} (h : Old.Speech m) : Root12.E5 m :=
  fun ctx w s tag => (h.1 ctx w s tag).trans (speech_reference_01 tag).symm

end Bridges
end Aukora.RootFinal
