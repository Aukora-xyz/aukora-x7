import Lite12
import Bounds12
import Proofs.Evidence11
import Proofs.Round11Safe

namespace Aukora.Cell12
open Release (Model Input)
open Evidence11 (Names)
open R6.KernelCell (Context)
open private Evidence11.metadata from Evidence11
open private Release.append_passive from Proofs.PublicBehavior

/-- C1. An act's direct cell-result reference identifies the exact earlier
    recorded receiver slot, its receipt and a present output commitment. -/
def Citation (m : Model) : Prop :=
  ∀ {ctx w s t i a c r}, m.step ctx w s = some t → Names s w i a →
    c ∈ a.claims → c.kind = .cellResult → r ∈ c.refs →
    ∃ wire parent receipt out, s.base.record[r-1]? = some wire ∧
      Evidence11.decode wire = some ⟨parent,r,.cell receipt⟩ ∧ receipt.output = some out ∧
      0 < r ∧ r < a.pos ∧ a.pos < Policy9.nextSeq s

theorem full_citation : Citation Safe11.fullModel := by
  intro ctx w s t i a c r ok named mem kind ref
  obtain ⟨_,_,positive,earlier,before⟩ := Evidence11.resolves (prior := Ratchet11.step ctx) ok named mem ref
  obtain ⟨wire,p,b,slot,dec,fit⟩ := Evidence11.kind_matches (prior := Ratchet11.step ctx) ok named mem ref
  cases b with
  | cell receipt =>
    have someOut : receipt.output.isSome = true := by simpa only [kind,Evidence11.fitsKind] using fit
    obtain ⟨out,found⟩ := Option.isSome_iff_exists.mp someOut
    exact ⟨wire,p,receipt,out,slot,dec,found,positive,earlier,before⟩
  | _ => simp [Evidence11.fitsKind,kind] at fit

/-- C2. A committed cell event preserves both owner keys, every authorization field
    (including grants), owner rules and the entire risk state (including threshold). -/
def Passive (m : Model) : Prop :=
  ∀ {ctx w s t p n c}, w[0]? = some (255 : UInt8) → w[1]? = some (3 : UInt8) →
    w[2]? = some (1 : UInt8) → Evidence11.decode w = some ⟨p,n,.cell c⟩ →
    m.step ctx w s = some t →
    Release.auth t = Release.auth s ∧ t.rules = s.rules ∧ t.base.risk = s.base.risk

theorem full_passive : Passive Safe11.fullModel := by
  intro ctx w s t p n c v tag op dec ok
  obtain ⟨u,raw,rfl⟩ := Option.map_eq_some'.mp ok
  have route : Safe11.route w = .ordinary := by simp [Safe11.route,v,tag]
  have ev : Evidence11.step (Ratchet11.step ctx) w s = some u := by
    simp only [Safe11.raw,route] at raw
    split at raw
    · cases raw
    · exact raw
  obtain ⟨z,done,rfl⟩ := Option.map_eq_some'.mp ev
  have md : Evidence11.metadata s w ⟨p,n,.cell c⟩ s.base.risk = some z := by
    simpa [Evidence11.routed,Evidence11.subtag,Evidence11.cellSubtag,v,tag,op,dec,Evidence11.submit] using done
  obtain ⟨b,append,eq⟩ := Option.bind_eq_some.mp md
  cases Option.some.inj eq
  exact ⟨Release.append_passive (t := b) append rfl trivial,rfl,rfl⟩

private theorem evidence_ordinary (ctx : Context) (w s) (h : w[0]? ≠ some (27 : UInt8)) :
    Evidence11.step Lite.step w s = Evidence11.step (Ratchet11.step ctx) w s := by
  have same : Lite.step w s = Ratchet11.step ctx w s := by
    simpa [Ratchet11.step,Ratchet11.allow_ordinary h] using Lite.ordinary ctx w s h
  simp only [Evidence11.step,Evidence11.routed,same]

/-- The halt-on-refusal check runs only an embedded act. Even if someone embeds
    a tag-27 package, Policy9.decode cannot identify it as that act. -/
private theorem probe_same (ctx : Context) (w s) :
    Safe11.refusedAct (Evidence11.step Lite.step) s w =
      Safe11.refusedAct (Evidence11.step (Ratchet11.step ctx)) s w := by
  let a := w.extract (Safe11.bodyStart s 52) w.size
  by_cases tag : a[0]? = some (27 : UInt8)
  · have bad : Policy9.decode (w.extract (Safe11.bodyStart s 52) w.size) = none := by
      change Policy9.decode a = none
      simp [Policy9.decode,Core8.request,tag]
    simp [Safe11.refusedAct,bad]
  · have equal : Evidence11.step Lite.step (w.extract (Safe11.bodyStart s 52) w.size) s =
        Evidence11.step (Ratchet11.step ctx) (w.extract (Safe11.bodyStart s 52) w.size) s :=
      evidence_ordinary ctx a s tag
    simp only [Safe11.refusedAct,equal]

theorem step_same (ctx : Context) (w s) (h : w[0]? ≠ some (27 : UInt8)) :
    Lite12.step w s = Round11.step ctx w s := by
  simp only [Lite12.step,Round11.step,Safe11.step,Safe11.raw,probe_same ctx w s,evidence_ordinary ctx w s h]

theorem lite_no_install (w s) (h : w[0]? = some (27 : UInt8)) : Lite12.step w s = none := by
  simp [Lite12.step,Safe11.step,Safe11.raw,Safe11.route,Evidence11.step,
    Evidence11.routed,Evidence11.subtag,Evidence11.cellSubtag,Lite.step,h]

/-- Re-submit the saved frames in order through exactly the supplied public step.
    No auxiliary genesis or model is evaluated while proving the generic fold. -/
def replayFrames (next : Safe11.Next) (s : Release.State) (frames : List ByteArray) : Release.State :=
  frames.foldl (fun old wire => (next wire old).getD old) s

private theorem replay_congr (f g : Safe11.Next) (s : Release.State) (xs : List ByteArray)
    (agree : ∀ wire ∈ xs, ∀ old, f wire old = g wire old) :
    replayFrames f s xs = replayFrames g s xs := by
  induction xs generalizing s with
  | nil => simp only [replayFrames,List.foldl_nil]
  | cons w ws ih =>
    change replayFrames f ((f w s).getD s) ws = replayFrames g ((g w s).getD s) ws
    rw [agree w (List.mem_cons_self ..) s]
    exact ih _ (fun wire mem => agree wire (List.mem_cons_of_mem _ mem))

/-- C3. Replaying any record without installs, including cell receipts and
    assessments, gives identical complete state and thus identical head. -/
theorem replay (ctx : Context) (s : Release.State) (xs : List ByteArray)
    (noInstall : ∀ w ∈ xs, w[0]? ≠ some (27 : UInt8)) :
    replayFrames Lite12.step s xs = replayFrames (Round11.step ctx) s xs :=
  replay_congr _ _ s xs (fun w mem st => step_same ctx w st (noInstall w mem))

/-- The release adapters apply the same wire, count, and total-byte limit
    before calling their steps. Bounded record replay likewise preserves the head. -/
def bounded (step : Safe11.Next) : Safe11.Next :=
  fun w st => if Bounds12.room st w then step w st else none

theorem bounded_replay (ctx : Context) (s : Release.State) (xs : List ByteArray)
    (noInstall : ∀ w ∈ xs, w[0]? ≠ some (27 : UInt8)) :
    Safe11.head (replayFrames (bounded Lite12.step) s xs) =
      Safe11.head (replayFrames (bounded (Round11.step ctx)) s xs) := by
  apply congrArg Safe11.head
  apply replay_congr
  intro w mem st
  simp only [bounded,step_same ctx w st (noInstall w mem)]

private theorem frames_cons (f : Safe11.Next) (s w ws) :
    replayFrames f s (w :: ws) = replayFrames f ((f w s).getD s) ws := rfl

private theorem replay_suffix (f g : Safe11.Next)
    (writes : ∀ {s w t}, f w s = some t → t.base.record = s.base.record.push w)
    (s : Release.State) (xs : List ByteArray)
    (agree : ∀ w ∈ xs, ∀ st, g w st = f w st) :
    ∃ stored, (replayFrames f s xs).base.record.toList = s.base.record.toList ++ stored ∧
      replayFrames g s stored = replayFrames f s xs := by
  induction xs generalizing s with
  | nil => exact ⟨[],by simp [replayFrames],rfl⟩
  | cons w ws ih =>
    have tail : ∀ x ∈ ws, ∀ st, g x st = f x st := fun x mem => agree x (List.mem_cons_of_mem _ mem)
    cases hit : f w s with
    | none => simpa only [frames_cons,hit,Option.getD_none] using ih s tail
    | some t =>
      obtain ⟨stored,record,same⟩ := ih t tail
      have wrote := writes hit
      have taken := (agree w (List.mem_cons_self ..) s).trans hit
      refine ⟨w::stored,?_,?_⟩
      · simpa only [frames_cons,hit,Option.getD_some,record,wrote,Array.push_toList,
          List.append_assoc,List.singleton_append]
      · simpa only [frames_cons,taken,hit,Option.getD_some] using same

/-- Extracting the actual appended record suffix drops rejected submissions. Lite
    replay of exactly those bytes recovers the full final state from the same start. -/
theorem replay_exported (ctx : Context) (s : Release.State) (xs : List ByteArray)
    (noInstall : ∀ w ∈ xs, w[0]? ≠ some (27 : UInt8)) :
    let final := replayFrames (bounded (Round11.step ctx)) s xs
    ∃ stored, final.base.record.toList = s.base.record.toList ++ stored ∧
      replayFrames (bounded Lite12.step) s stored = final := by
  apply replay_suffix
  · intro st w t hit
    unfold bounded at hit
    split at hit
    · obtain ⟨_,_,eq⟩ := Option.map_eq_some'.mp hit
      cases eq
      rfl
    · cases hit
  · intro w mem st
    simp only [bounded,step_same ctx w st (noInstall w mem)]

#print axioms full_citation
#print axioms full_passive
#print axioms replay
#print axioms bounded_replay
#print axioms replay_exported
end Aukora.Cell12
