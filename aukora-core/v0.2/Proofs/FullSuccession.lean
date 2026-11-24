import Proofs.Round11Safe
import RatchetModel

namespace Aukora.Round11

open R6.KernelCell (Context)
open private Evidence11.metadata from Evidence11
open private Policy9.applyBase from Policy
open private OnlyGate9.append9 OnlyGate9.apply_same from Proofs.SingleGate

private abbrev core (s : Policy9.Machine) := (Release.ledger s).book.auth.core

private theorem ratchet_inner {ctx w s t} (hit : Ratchet11.step ctx w s = some t) :
    Core9.step ctx w s = some t := by
  unfold Ratchet11.step at hit
  split at hit
  · exact hit
  · cases hit

/-- A successful full-profile install is the exact state transition of the ratchet profile. -/
theorem install_is_ratchet {ctx w s t} (tag : w[0]? = some (27 : UInt8))
    (hit : step ctx w s = some t) : Ratchet11.step ctx w s = some t := by
  by_cases stopped : Safe11.halted s = true
  · have blocked := Safe11.H1_upgrade (next := Evidence11.step (Ratchet11.step ctx)) stopped tag
    change Safe11.step _ _ _ = some t at hit
    rw [blocked] at hit
    cases hit
  have unwrapped := hit
  simp only [step, Safe11.step, Option.map_eq_some'] at unwrapped
  obtain ⟨u,outer,back⟩ := unwrapped
  have route : Safe11.route w = .ordinary := by simp [Safe11.route,tag]
  have inner : Evidence11.step (Ratchet11.step ctx) w s = some u := by
    simpa [Safe11.raw,route,stopped] using outer
  obtain ⟨v,run,hv⟩ := Option.map_eq_some'.mp inner
  have passed : Ratchet11.step ctx w s = some v := by
    simpa [Evidence11.routed,Evidence11.subtag,tag] using run
  obtain ⟨_,_,_,_,_,_,record⟩ := Core9.package_admission tag (ratchet_inner passed)
  subst u
  subst t
  simpa [← record] using passed

/-- Every full-profile install checks the candidate's own law and its entailment of the recorded law. -/
theorem full_succession : Ratchet11.Succession Safe11.fullModel := by
  intro ctx w s t tag hit
  exact Ratchet11.model_succession ctx w s t tag (install_is_ratchet tag hit)

private theorem metadata_core {s w e risk t} (ok : Evidence11.metadata s w e risk = some t) : core t = core s := by
  obtain ⟨b,append,eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact OnlyGate9.append9 (t := b) append (by intro d i; simp)

private theorem submitted_core {s w e t} (ok : Evidence11.submit s w e = some t) : core t = core s := by
  cases ebody : e.body with
  | assessment | source | premise =>
    simp only [Evidence11.submit,ebody] at ok
    exact metadata_core ok
  | setCeiling | read =>
    simp only [Evidence11.submit,ebody] at ok
    split at ok
    · exact metadata_core ok
    · cases ok
  | outcome =>
    simp only [Evidence11.submit,ebody,Policy9.submit] at ok
    obtain ⟨b,applied,eq⟩ := Option.bind_eq_some.mp ok
    cases Option.some.inj eq
    exact OnlyGate9.apply_same applied

private theorem evidence_core {ctx w s t} (tag : w[0]? ≠ some (27 : UInt8))
    (ok : Evidence11.step (Ratchet11.step ctx) w s = some t) : core t = core s := by
  have preserve {u} (hit : Ratchet11.step ctx w s = some u) : core u = core s := by
    have old := ratchet_inner hit
    apply OnlyGate9.policy_preserves_core (wire := w)
    simpa [Core9.step,tag] using old
  obtain ⟨u,run,eq⟩ := Option.map_eq_some'.mp ok
  cases eq
  change core u = core s
  unfold Evidence11.routed at run
  split at run
  · obtain ⟨c,_,branch⟩ := Option.bind_eq_some.mp run
    cases c <;> try contradiction
    obtain ⟨_,_,passed⟩ := Option.bind_eq_some.mp branch
    exact preserve passed
  · split at run
    · obtain ⟨_,_,hit⟩ := Option.bind_eq_some.mp run
      exact submitted_core hit
    · exact preserve run

/-- A changed core digest in the full profile can only come from an admitted installation. -/
theorem full_core_change {ctx w s t} (ok : step ctx w s = some t) (changed : core t ≠ core s) :
    w[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode w = some u ∧ Ratchet11.Demands ctx s t u := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · exact ⟨tag,full_succession ctx w s t tag ok⟩
  apply False.elim
  apply changed
  obtain ⟨u,raw,eq⟩ := Option.map_eq_some'.mp ok
  cases eq
  change core u = core s
  cases route : Safe11.route w with
  | ordinary =>
    simp only [Safe11.raw,route] at raw
    split at raw
    · cases raw
    · exact evidence_core tag raw
  | halt | clear | refusal | rebind =>
    simp only [Safe11.raw,route] at raw
    split at raw
    · cases Option.some.inj raw
      rfl
    · cases raw

#print axioms install_is_ratchet
#print axioms full_succession
#print axioms full_core_change
end Aukora.Round11
