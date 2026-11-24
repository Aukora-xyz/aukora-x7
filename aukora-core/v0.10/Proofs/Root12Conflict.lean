import Proofs.Round11Safe
import Bounds12

namespace Aukora.Root12
open Release
open R6.KernelCell (Context)
open private Safe11.blank Safe11.witness from Proofs.Round11Safe

theorem legacy_decoder_ff {w : ByteArray} (tag : w[0]? = some (255 : UInt8)) :
    Policy9.decode w = none := by
  simp [Policy9.decode,Core8.request,tag]

/-- Neither half of this disjunction can hold for an ff-prefixed frame, even if
    no grant rule changed at all. This is the unchanged safety conjunct in P1. -/
theorem no_ff_rules {m : Release.Model} {ctx w s t}
    (tag : w[0]? = some (255 : UInt8)) (ok : m.step ctx w s = some t) : ¬ RulesLaw m := by
  intro rules
  rcases rules ctx w s t ok with ⟨install,_⟩ | ⟨c,tracked,_⟩
  · simp [Tagged,tag] at install
  · have parsed := tracked.2
    rw [legacy_decoder_ff tag] at parsed
    contradiction

/-- D5 likewise classifies every admitted frame, including ones with identical risk state. -/
theorem no_ff_risk {m : Release.Model} {ctx w s t}
    (tag : w[0]? = some (255 : UInt8)) (ok : m.step ctx w s = some t) : ¬ RiskStateLaw m := by
  intro risk
  rcases risk ctx w s t ok with ⟨install,_⟩ | ⟨c,tracked,_⟩
  · simp [Tagged,tag] at install
  · have parsed := tracked.2
    rw [legacy_decoder_ff tag] at parsed
    contradiction

/-- A valid clear is a format-02 frame; unlike P1/D5, H5 explicitly demands success. -/
theorem recovery_excludes_root {m : Release.Model} (ctx : Context) {w s}
    (clear : Safe11.ValidClear s w) (safe : Safe11.PublicLaws m) : ¬ Lawful m := by
  obtain ⟨t,ok,_⟩ := safe.recovery.1 ctx s w clear
  have tag : w[0]? = some (255 : UInt8) := by
    have r := clear.1
    unfold Safe11.route at r
    split at r
    · rename_i hdr
      exact hdr.1
    · contradiction
  intro root
  exact no_ff_rules tag ok (revoke_safety root).2

set_option maxRecDepth 4096 in
/-- A concrete failed-act halt in the full model needs no keys or crypto hypothesis. -/
theorem full_violates_both (ctx : Context) :
    ¬ RulesLaw Safe11.innerModel ∧ ¬ RiskStateLaw Safe11.innerModel := by
  have ok : (Safe11.innerModel.step ctx Safe11.witness Safe11.blank).isSome = true := by rfl
  obtain ⟨t,hit⟩ := Option.isSome_iff_exists.mp ok
  have tag : Safe11.witness[0]? = some (255 : UInt8) := by decide
  exact ⟨no_ff_rules tag hit, no_ff_risk tag hit⟩

theorem full_excludes_root (ctx : Context) : ¬ Lawful Safe11.innerModel :=
  fun h => (full_violates_both ctx).1 (revoke_safety h).2

/-- A genuinely changed owner on a version-02 frame separately violates the exact
    first conjunct of old H2, even with both current signatures verified. -/
theorem ff_rebind_excludes_binding {m : Release.Model} {ctx w s t}
    (tag : w[0]? = some (255 : UInt8)) (ok : m.step ctx w s = some t)
    (changed : owner t ≠ owner s) : ¬ BindingLaw m := by
  intro binding
  obtain ⟨_,_,_,_,tracked,_⟩ := binding.1 _ _ _ _ ok changed
  have parsed := tracked.2
  rw [legacy_decoder_ff tag] at parsed
  contradiction

/-- Omission of a version-02 report also contradicts L10's exact finding list.
    This shows the conflict for a single nonempty versioned report at genesis. -/
theorem ff_report_excludes_outcome {m : Release.Model} {ctx w key s t}
    (genesis : m.genesis key = some s) (tag : w[0]? = some (255 : UInt8))
    (ok : m.step ctx w s = some t) (reported : t.outcomes ≠ []) : ¬ Lawful m := by
  intro root
  have listEq := ((root.outcome key s genesis).2 ctx [.frame w] ByteArray.empty).1
  apply reported
  simpa [run, execute, ok, findingsIn, findingAt, wireFinding, tag, legacy_decoder_ff tag] using listEq

/-- Even the qualified feed promise still conflicts with a hard cap in an open
    state. A machine-level cap needs an explicit resource predicate in that promise. -/
theorem open_feed_refusal {m : Release.Model} {s b}
    (active : Open s (.feed b)) (changes : fed b s ≠ s) (refusal : m.feed b s = s) : ¬ Lawful m := by
  intro root
  exact changes ((root.replay.feedWhen s b active).symm.trans refusal)

theorem finite_session_excludes_H5 {m : Release.Model} {s w} (ctx : Context)
    (good : Safe11.ValidClear s w) (inner : Safe11.PublicLaws m)
    (full : Bounds12.maxEntries ≤ Bounds12.entries s) :
    (∃ t, m.step ctx w s = some t ∧ Safe11.halted t = false) ∧
    Bounds12.submit m ctx s (.frame w) = none :=
  ⟨inner.recovery.1 ctx s w good,(Bounds12.record_limit m ctx s w (.inl full)).1.1⟩

#print axioms finite_session_excludes_H5
#print axioms no_ff_rules
#print axioms no_ff_risk
#print axioms recovery_excludes_root
#print axioms full_violates_both
#print axioms full_excludes_root
#print axioms ff_rebind_excludes_binding
#print axioms ff_report_excludes_outcome
#print axioms open_feed_refusal
end Aukora.Root12
