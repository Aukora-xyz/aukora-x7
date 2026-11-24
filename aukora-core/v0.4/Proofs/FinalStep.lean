import Root12
import Proofs.Root12Record
import Proofs.Root12Availability

namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)
open private Release.submitted from Proofs.RawRecord
open private Evidence11.metadata from Evidence11
open private Policy9.append Policy9.applyBase from Policy
open private Root12.header from Proofs.Root12Grammar
open private Release.generations_step from Proofs.PublicBehavior

abbrev recordPush (s : Release.State) (w : ByteArray) (t : Release.State) : Release.State :=
  {t with base.record := s.base.record.push w}

inductive Dispatch (ctx : R6.KernelCell.Context) (w : ByteArray) (s : Release.State) : Release.State → Prop where
  | legacy {t} (ok : Core9.step ctx w s = some t) : Dispatch ctx w s t
  | evidence {e u} (ff : w[0]? = some (255 : UInt8)) (rt : Safe11.route w = .ordinary)
      (decoded : Evidence11.decode w = some e) (ok : Evidence11.submit s w e = some u) :
      Dispatch ctx w s (recordPush s w u)
  | note {label} (ff : w[0]? = some (255 : UInt8)) (rt : Safe11.route w ≠ .ordinary)
      (notRebind : Safe11.route w ≠ .rebind) : Dispatch ctx w s (recordPush s w (Safe11.metadata s w label))
  | rebind (ff : w[0]? = some (255 : UInt8)) (rt : Safe11.route w = .rebind)
      (shape : Safe11.shape s w 53 = true) (both : Safe11.Both s w 53) :
      Dispatch ctx w s (recordPush s w (Safe11.rebound s w))

private theorem oldDispatch {ctx w s t} (ok : Ratchet11.step ctx w s = some t) :
    Dispatch ctx w s (recordPush s w t) := by
  unfold Ratchet11.step at ok
  split at ok
  · have recEq := Release.submitted ok
    simpa [recordPush,← recEq] using Dispatch.legacy ok
  · contradiction

theorem dispatch {ctx w s t} (hit : fullModel.step ctx w s = some t) : Dispatch ctx w s t := by
  classical
  obtain ⟨u,raw,rfl⟩ := Option.map_eq_some'.mp hit
  cases rt : Safe11.route w with
  | ordinary =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · contradiction
    · obtain ⟨v,run,rfl⟩ := Option.map_eq_some'.mp raw
      unfold Evidence11.routed at run
      split at run
      · obtain ⟨c,_,branch⟩ := Option.bind_eq_some.mp run
        cases c <;> try contradiction
        obtain ⟨_,_,passed⟩ := Option.bind_eq_some.mp branch
        exact oldDispatch (t := v) passed
      · split at run
        · obtain ⟨e,parsed,applied⟩ := Option.bind_eq_some.mp run
          have ff : w[0]? = some (255 : UInt8) := by
            by_cases tag : w[0]? = some (255 : UInt8)
            · exact tag
            · simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,tag] at parsed
          exact Dispatch.evidence (u := v) ff rt parsed applied
        · exact oldDispatch (t := v) run
  | halt =>
    have ff := (Root12.header rt (by decide)).1
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i guardOK
      cases Option.some.inj raw
      exact Dispatch.note (label := "halt") ff (by rw [rt]; decide) (by rw [rt]; decide)
    · contradiction
  | clear =>
    have ff := (Root12.header rt (by decide)).1
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i guardOK
      cases Option.some.inj raw
      exact Dispatch.note (label := "clear") ff (by rw [rt]; decide) (by rw [rt]; decide)
    · contradiction
  | refusal =>
    have ff := (Root12.header rt (by decide)).1
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i guardOK
      cases Option.some.inj raw
      exact Dispatch.note (label := "refused-act") ff (by rw [rt]; decide) (by rw [rt]; decide)
    · contradiction
  | rebind =>
    have ff := (Root12.header rt (by decide)).1
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i guardOK
      cases Option.some.inj raw
      simp only [Bool.and_eq_true] at guardOK
      have sig := (Safe11.owner_iff ..).mp guardOK.1
      exact Dispatch.rebind ff rt sig.1 sig.2
    · contradiction

theorem legacy_step {ctx w s t} (old : w[0]? ≠ some (255 : UInt8))
    (ok : fullModel.step ctx w s = some t) : Core9.step ctx w s = some t := by
  cases dispatch ok with
  | legacy ok => exact ok
  | _ => contradiction

theorem tracked_old {w c} (cmd : Tracked w c) : w[0]? ≠ some (255 : UInt8) := by
  intro ff
  have bad := cmd.2
  rw [Root12.legacy_decoder_ff ff] at bad
  contradiction

theorem legacy_tracked {ctx w s t c} (cmd : Tracked w c) (ok : fullModel.step ctx w s = some t) :
    Core9.step ctx w s = some t := legacy_step (tracked_old cmd) ok

/-- Extra commands may advance the authority generation only by emptying the pool.
    They never issue grants, change the threshold, or introduce a memory claim. -/
structure Extra (s t : Release.State) : Prop where
  authority : (owner t = owner s ∧ pool t = pool s ∧ t.rules = s.rules ∧
      Policy9.generation t = Policy9.generation s) ∨
    (pool t = [] ∧ Policy9.generation t = Policy9.generation s + 1)
  passive : (auth t = auth s ∧ t.rules = s.rules) ∨
    ∃ f name, (ledger t).history = (ledger s).history ++ [f] ∧ f.action = .base (.rebind name true)
  clock : (ledger t).book.seq = (ledger s).book.seq + 1
  threshold : t.base.risk.threshold = s.base.risk.threshold
  claims : (ledger t).book.claims = (ledger s).book.claims
  history : ∃ f, (ledger t).history = (ledger s).history ++ [f] ∧ f.parent = (ledger s).head ∧ f.seq = (ledger s).book.seq + 1
  outcomes : ∃ pre, t.outcomes = pre ++ s.outcomes

private theorem metadataExtra {s : Release.State} {w e} {risk : Risk8.State} {u} (thresh : risk.threshold = s.base.risk.threshold)
    (hit : Evidence11.metadata s w e risk = some u) : Extra s (recordPush s w u) := by
  obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp hit
  cases Option.some.inj eq
  obtain ⟨inner,bound,eq⟩ := Option.bind_eq_some.mp app
  cases Option.some.inj eq
  have next := R2.next_spec (Bound4.accepted bound).2
  let frame : R2.Frame := ⟨e.parent,e.seq,.base (.advise "AUKORA/R11/evidence" 0)⟩
  have led : inner.ledger = R2.append (fun _ => Bound4.digest w) (ledger s) frame := next.2
  exact {
    authority := .inl ⟨rfl,by change inner.ledger.book.auth.grants = _; rw [led]; rfl,rfl,
      by change inner.ledger.book.auth.generation = _; rw [led]; rfl⟩
    passive := .inl ⟨Prod.ext rfl (by change inner.ledger.book.auth = _; rw [led]; rfl),rfl⟩
    clock := by change inner.ledger.book.seq = _; rw [led]; rfl
    threshold := thresh
    claims := by change inner.ledger.book.claims = _; rw [led]; rfl
    history := ⟨frame,by change inner.ledger.history = _; rw [led]; rfl,next.1.1,next.1.2.1⟩
    outcomes := ⟨[],rfl⟩ }

private theorem evidenceExtra {s w e u} (hit : Evidence11.submit s w e = some u) :
    Extra s (recordPush s w u) := by
  rcases e with ⟨p,n,body⟩
  cases body with
  | assessment key val claims => exact metadataExtra (risk := Risk8.assess s.base.risk key val _) rfl hit
  | source | premise | cell => exact metadataExtra rfl hit
  | read | setCeiling =>
    simp only [Evidence11.submit] at hit
    split at hit
    · exact metadataExtra rfl hit
    · contradiction
  | outcome i val fix conf =>
    obtain ⟨b,applied,eq⟩ := Option.bind_eq_some.mp hit
    cases Option.some.inj eq
    obtain ⟨_,_,app⟩ := Option.bind_eq_some.mp applied
    obtain ⟨inner,bound,eq⟩ := Option.bind_eq_some.mp app
    cases Option.some.inj eq
    have next := R2.next_spec (Bound4.accepted bound).2
    let frame : R2.Frame := ⟨p,n,.base (.outcome i val)⟩
    have led : inner.ledger = R2.append (fun _ => Bound4.digest w) (ledger s) frame := next.2
    exact {
      authority := .inl ⟨rfl,by change inner.ledger.book.auth.grants = _; rw [led]; rfl,rfl,
        by change inner.ledger.book.auth.generation = _; rw [led]; rfl⟩
      passive := .inl ⟨Prod.ext rfl (by change inner.ledger.book.auth = _; rw [led]; rfl),rfl⟩
      clock := by change inner.ledger.book.seq = _; rw [led]; rfl
      threshold := rfl
      claims := by change inner.ledger.book.claims = _; rw [led]; rfl
      history := ⟨frame,by change inner.ledger.history = _; rw [led]; rfl,next.1.1,next.1.2.1⟩
      outcomes := ⟨[_],rfl⟩ }

theorem legacy_or_extra {ctx w s t} (ok : fullModel.step ctx w s = some t) :
    Core9.step ctx w s = some t ∨ Extra s t := by
  cases dispatch ok with
  | legacy ref => exact .inl ref
  | evidence _ _ _ hit => exact .inr (evidenceExtra hit)
  | note => exact .inr ⟨.inl ⟨rfl,rfl,rfl,rfl⟩,.inl ⟨rfl,rfl⟩,rfl,rfl,rfl,⟨_,rfl,rfl,rfl⟩,⟨[],rfl⟩⟩
  | rebind => exact .inr ⟨.inr ⟨rfl,rfl⟩,.inr ⟨_,_,rfl,rfl⟩,rfl,rfl,rfl,⟨_,rfl,rfl,rfl⟩,⟨[],rfl⟩⟩

#print axioms dispatch
#print axioms legacy_or_extra
end Aukora.RootFinal
