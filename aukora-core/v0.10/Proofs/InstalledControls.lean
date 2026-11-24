import Proofs.FinalPolicies
namespace Aukora.RootFinal.ControlAvailability
open Release
open Safe11 (innerModel)
open Versions
open private Policy9.append from Policy

inductive Class where
  | threshold | assessment | cancel | issue | report

def legacyClass : Class → Policy9.Command → Prop
  | .threshold => isThreshold
  | .assessment => isAssessment
  | .cancel => isRevocation
  | .issue => isIssue
  | .report => isReport

/-- The reference test takes the decoded installed fields, independently of the
    proposed machine's verdict. Approvals and cancellations reuse the signed
    policy reference, assessments and thresholds require an addressed ledger
    projection, and thresholds also need both signatures. -/
def extensionValid (s : Release.State) (w : ByteArray) (d : Root12.Grammar.Decoded) : Class → ExtensionKind → Prop
  | .issue, .issue p n e i ed ml => (Policy9.submit s w (.issue p n e i ed ml)).isSome = true
  | .cancel, .cancel p n key ed ml => (Policy9.submit s w (.cancel p n key ed ml)).isSome = true
  | .report, .report i v corrected => (Policy9.submit s w (.report d.frame.parent d.frame.seq i v corrected)).isSome = true
  | .assessment, .assessment .. => (Policy9.append s.base w d.frame).isSome = true
  | .threshold, .threshold p n level ed ml =>
    p = d.frame.parent ∧ n = d.frame.seq ∧ Policy9.generation s < 2^64 ∧
    (Risk8.setThreshold Core8.verifiers (owner s) (Policy9.generation s) p n level ed ml s.base.risk).isSome = true ∧
    (Policy9.append s.base w d.frame).isSome = true
  | _,_ => False

def evidenceClass : Class → Evidence11.Body → Prop
  | .assessment,.assessment .. | .report,.outcome .. => True
  | _,_ => False

def Supports (m : Model) (c : Class) : Prop :=
  Root12.SupportsWhen m (legacyClass c) ∧
  (∀ ctx w s d v raw op, Root12.Grammar.decode m.grammar s w = some d →
    d.payload = .later v raw op → slotAction d op → extensionValid s w d c op →
    Root12.Open s (.frame w) → (m.step ctx w s).isSome = true) ∧
  ∀ ctx w s e,
    (Evidence11.subtag w).any (fun tag => 40 ≤ tag && tag ≤ 43) || (Evidence11.cellSubtag w).isSome →
    Safe11.route w = .ordinary → Evidence11.decode w = some e →
    interpretations m.grammar s w = some (.evidence e.body) → evidenceClass c e.body →
    (Evidence11.submit s w e).isSome = true → Root12.Open s (.frame w) → (m.step ctx w s).isSome = true

open private noFuture currentSidecar from Proofs.Versions

theorem full_supports (c : Class) : Supports innerModel c := by
  refine ⟨?_,?_,?_⟩
  · cases c with
    | threshold => exact Root12.full_positive_controls.1
    | assessment => exact Root12.full_positive_controls.2.1
    | cancel => exact Root12.full_positive_controls.2.2.1
    | issue => exact Root12.full_positive_controls.2.2.2.1
    | report => exact Root12.full_positive_controls.2.2.2.2
  · intro ctx w s d v raw op dec future _ _ _
    exact False.elim (noFuture dec future)
  · intro ctx w s e recognized ordinary decoded _ _ valid opened
    obtain ⟨u,hit⟩ := Option.isSome_iff_exists.mp valid
    have notAct : w[0]? ≠ some (23 : UInt8) := by
      intro tag
      simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,tag] at decoded
    simp [innerModel,Round11.step,Safe11.step,Safe11.raw,ordinary,opened.1,Evidence11.step,
      Evidence11.routed,notAct,recognized,decoded,hit]

def StampSupports (m : Model) : Prop :=
  ∀ w s beacon receipt, decodeSidecar m.grammar w = some ((ledger s).head,beacon,receipt) →
    Root12.Open s (.stamp w) → (m.stamp w s).isSome = true

theorem full_stampSupports : StampSupports innerModel := by
  intro w s b r dec _
  rw [currentSidecar] at dec
  change (Core9.stamp w s).isSome = true
  simp [Core9.stamp,Core8.stamp,dec,ledger,guard]

theorem stamp_positive_bridge {m : Model} (law : StampSupports m) :
    ∀ w s t, Core9.stamp w s = some t → Root12.Open s (.stamp w) → ∃ u, m.stamp w s = some u := by
  intro w s t ref open_
  obtain ⟨b,r,parsed⟩ := (newest_stamp w s t ref).1
  exact Option.isSome_iff_exists.mp (law _ _ _ _ (sidecar_preserves_old parsed) open_)

#print axioms full_stampSupports
#print axioms stamp_positive_bridge
#print axioms full_supports
end Aukora.RootFinal.ControlAvailability
