import Proofs.Root12Grammar

namespace Aukora.Root12
open Release
open R6.KernelCell (Context)
open private Grammar.second Grammar.evidenceFrame from Laws
open private Policy9.append Policy9.applyBase from Policy
open private Evidence11.metadata from Evidence11
open private header from Proofs.Root12Grammar

namespace History12

private def Sound (a b : R2.Ledger) (f : R2.Frame) : Prop :=
  b.history = a.history ++ [f] ∧ (R2.ViewSound a → R2.ViewSound b)

private def Explained (w : ByteArray) (s t : Release.State) : Prop :=
  ∃ d, Grammar.decode Grammar.installed s w = some d ∧ Sound (ledger s) (ledger t) d.frame

private theorem acceptedNext {a b : R2.Ledger} {hash f}
    (ok : R2.next hash a f = some b) : Sound a b f := by
  refine ⟨by rw [(R2.next_spec ok).2]; rfl,?_⟩
  intro valid
  simpa only [R2.step,ok,Option.getD_some] using R2.view_step hash a f valid

private theorem legacy {ctx w s t} (ok : Ratchet11.step ctx w s = some t) : Explained w s t := by
  unfold Ratchet11.step at ok
  split at ok
  · obtain ⟨f,_,proj,h⟩ := step_projection ok
    have old : w[0]? ≠ some (255 : UInt8) := by
      intro tag
      rw [Safe11.frozen_projection tag] at proj
      contradiction
    have checked := acceptedNext h
    exact ⟨⟨f,.legacy⟩,by simp [Grammar.legacy_stable _ _ _ old,proj],checked⟩
  · contradiction

private theorem append9 {base w f b} (ok : Policy9.append base w f = some b) :
    Sound base.hybrid.inner.ledger b.hybrid.inner.ledger f := by
  obtain ⟨i,run,eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact acceptedNext (Bound4.accepted run).2

private theorem metadata {s w e risk t} (ok : Evidence11.metadata s w e risk = some t) :
    Sound (ledger s) (ledger t) ⟨e.parent,e.seq,.base (.advise "AUKORA/R11/evidence" 0)⟩ := by
  obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  have checked := append9 app
  exact checked

private theorem submitted {s w e t} (ok : Evidence11.submit s w e = some t) :
    Sound (ledger s) (ledger t) (Grammar.evidenceFrame e) := by
  rcases e with ⟨p,n,body⟩
  cases body with
  | assessment | source | premise | cell =>
    exact metadata ok
  | read | setCeiling =>
    simp only [Evidence11.submit] at ok
    split at ok
    · exact metadata ok
    · contradiction
  | outcome i val fix conf =>
    obtain ⟨b,applyBase,eq⟩ := Option.bind_eq_some.mp ok
    cases Option.some.inj eq
    obtain ⟨_,_,app⟩ := Option.bind_eq_some.mp applyBase
    exact append9 app

private theorem parsedEvidence {w s e} (rt : Safe11.route w = .ordinary)
    (hit : Evidence11.decode w = some e) :
    ∃ d, Grammar.decode Grammar.installed s w = some d ∧ d.frame = Grammar.evidenceFrame e := by
  classical
  have tag : w[0]? = some (255 : UInt8) := by
    by_contra no
    simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,no] at hit
  by_cases v2 : w[1]? = some (2 : UInt8)
  · exact ⟨⟨Grammar.evidenceFrame e,.evidence e⟩,by simp [Grammar.decode,Grammar.installed,tag,v2,Grammar.second,rt,hit],rfl⟩
  · have v3 : w[1]? = some (3 : UInt8) := by
      by_contra other
      simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,v2,other] at hit
    exact ⟨⟨Grammar.evidenceFrame e,.versionThree e⟩,by simp [Grammar.decode,Grammar.installed,tag,v3,Grammar.third,hit,guard],rfl⟩

private theorem routed {ctx w s t} (rt : Safe11.route w = .ordinary)
    (ok : Evidence11.routed (Ratchet11.step ctx) w s = some t) : Explained w s t := by
  unfold Evidence11.routed at ok
  split at ok
  · obtain ⟨c,_,branch⟩ := Option.bind_eq_some.mp ok
    cases c <;> try contradiction
    obtain ⟨_,_,passed⟩ := Option.bind_eq_some.mp branch
    exact legacy passed
  · split at ok
    · obtain ⟨e,dec,hit⟩ := Option.bind_eq_some.mp ok
      obtain ⟨d,good,frame⟩ := parsedEvidence (s := s) rt dec
      exact ⟨d,good,frame ▸ submitted hit⟩
    · exact legacy ok

private def controlFrame (s : Release.State) (w : ByteArray) (r : Safe11.Route) : R2.Frame :=
  ⟨Safe11.head s,Policy9.nextSeq s,.base (match r with
    | .halt => .advise "AUKORA/R11/halt" 0
    | .clear => .advise "AUKORA/R11/clear" 0
    | .refusal => .advise "AUKORA/R11/refused-act" 0
    | .rebind => .rebind (Wire5.keyName (Safe11.newKeys s w).ed) true
    | .ordinary => .advise "" 0)⟩

private theorem controlProjection {r w s d} (rt : Safe11.route w = r) (special : r ≠ .ordinary)
    (got : Grammar.decode Grammar.installed s w = some d) : d.frame = controlFrame s w r := by
  obtain ⟨tag,version⟩ := header rt special
  have inside : Grammar.second s w = some d := by simpa [Grammar.decode,Grammar.installed,tag,version] using got
  cases r with
  | ordinary => contradiction
  | halt | clear | rebind =>
    simp only [Grammar.second,rt] at inside
    obtain ⟨_,_,eq⟩ := Option.bind_eq_some.mp inside
    cases Option.some.inj eq
    rfl
  | refusal =>
    simp only [Grammar.second,rt] at inside
    obtain ⟨_,_,part⟩ := Option.bind_eq_some.mp inside
    obtain ⟨cmd,_,eq⟩ := Option.bind_eq_some.mp part
    cases cmd <;> cases eq <;> rfl

private theorem sameView {a b : R2.Ledger} {f : R2.Frame} (hist : b.history = a.history ++ [f]) (active : b.active = a.active) :
    Sound a b f := by
  refine ⟨hist,?_⟩
  intro old id member
  rw [active] at member
  obtain ⟨line,h⟩ := old id member
  exact ⟨line,by rw [hist]; exact R2.lookup_persists h _⟩

private theorem fullStep {ctx w s t} (hit : Safe11.fullModel.step ctx w s = some t) : Explained w s t := by
  obtain ⟨d,decode⟩ := full_parses hit
  obtain ⟨u,raw,eq⟩ := Option.map_eq_some'.mp hit
  cases eq
  change Explained w s u
  cases rt : Safe11.route w with
  | ordinary =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · contradiction
    · obtain ⟨v,go,eq⟩ := Option.map_eq_some'.mp raw
      cases eq
      have explained := routed rt go
      exact explained
  | halt | clear | refusal | rebind =>
    refine ⟨d,decode,?_⟩
    rw [controlProjection rt (by decide) decode]
    simp only [Safe11.raw,rt] at raw
    split at raw
    · cases Option.some.inj raw
      exact sameView rfl rfl
    · contradiction

private theorem command (ctx : Context) (s : Release.State) (c : Input) :
    let t := execute Safe11.fullModel ctx s c
    (ledger t).history = (ledger s).history ++ Grammar.entry Safe11.fullModel ctx s c ∧
    (R2.ViewSound (ledger s) → R2.ViewSound (ledger t)) := by
  cases c with
  | feed | reset => exact ⟨(List.append_nil _).symm,id⟩
  | stamp w =>
    cases ok : Safe11.fullModel.stamp w s with
    | none => simp [execute,ok,Grammar.entry]
    | some t =>
      have eq := (newest_stamp w s t ok).2
      simp [execute,ok,eq,Grammar.entry]
  | frame w =>
    cases ok : Safe11.fullModel.step ctx w s with
    | none => simp [execute,ok,Grammar.entry]
    | some t =>
      obtain ⟨d,dec,good⟩ := fullStep ok
      have selected : Grammar.decode Safe11.fullModel.grammar s w = some d := dec
      simpa [Sound,execute,ok,Grammar.entry,selected] using good

private theorem history (ctx : Context) (s : Release.State) (xs) :
    (ledger (run Safe11.fullModel ctx s xs)).history =
      (ledger s).history ++ Grammar.history Safe11.fullModel ctx s xs := by
  induction xs generalizing s with
  | nil => simp [run,Grammar.history]
  | cons c cs ih => simp only [run,Grammar.history,ih,(command ctx s c).1,List.append_assoc]

private theorem view (ctx : Context) (s : Release.State) (xs) (good : R2.ViewSound (ledger s)) :
    R2.ViewSound (ledger (run Safe11.fullModel ctx s xs)) := by
  induction xs generalizing s with
  | nil => exact good
  | cons c cs ih => exact ih _ ((command ctx s c).2 good)

end History12

/-- All four record obligations hold at the actual full dispatcher. Neither H5
    signatures nor an assumption that the model satisfies other clauses is needed. -/
theorem full_record : Record Safe11.fullModel where
  raw := full_raw_record
  version := ⟨⟨[],by simp [Grammar.extend,Safe11.fullModel]⟩,by decide⟩
  parses := fun _ _ _ _ => full_parses
  ledger := fun _ _ _ => History12.history
  view := by
    intro key start genesis ctx xs
    have initial := (newest_record genesis).2 ctx []
    exact History12.view ctx start xs initial

#print axioms full_record
end Aukora.Root12
