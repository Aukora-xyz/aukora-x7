import Proofs.Root12Conflict

namespace Aukora.Root12
open Release
open private Release.route_of_tag from Proofs.DangerPolicy

/-- Every frozen Supports command is separate from bundled use. The only recorded
    rules restricting these two paths govern spends, never the reference controls. -/
private def control (c : Policy9.Command) : Prop :=
  isAssessment c ∨ isThreshold c ∨ isRevocation c ∨ isIssue c ∨ isReport c

private theorem no_use {c : Policy9.Command} (ctl : control c) (i) : c ≠ .use i := by
  intro eq
  subst c
  simpa [control,isAssessment,isThreshold,isRevocation,isIssue,isReport] using ctl

private theorem controls : SupportsWhen Safe11.innerModel control := by
  intro ctx w s t cmd tracked ctl hit active
  have notFF : w[0]? ≠ some (255 : UInt8) := by
    intro tag
    have bad := tracked.2
    rw [legacy_decoder_ff tag] at bad
    contradiction
  have noAct : w[0]? ≠ some (23 : UInt8) := by
    intro tag
    obtain ⟨_, i, _, same, _⟩ := Release.route_of_tag tag tracked.2
    exact no_use ctl i same
  have old : Ratchet11.step ctx w s = some t := by
    simpa [Ratchet11.step,Ratchet11.allow_ordinary (ctx := ctx) (s := s) tracked.1,Core9.step,tracked.1] using hit
  refine ⟨{t with base.record := s.base.record.push w}, ?_⟩
  simp [Safe11.innerModel, Round11.step,Safe11.step,Safe11.raw,Safe11.route,notFF,
    active.1,Evidence11.step,Evidence11.routed,noAct,Evidence11.subtag,Evidence11.cellSubtag,old]

/-- D3, D5, P1, P2, O1: all five revised positive frame obligations actually hold
    of the full dispatch. The conditional promises are therefore non-vacuous
    wherever the reference would accept a command from an open state. -/
theorem full_positive_controls :
    SupportsWhen Safe11.innerModel isThreshold ∧ SupportsWhen Safe11.innerModel isAssessment ∧
    SupportsWhen Safe11.innerModel isRevocation ∧ SupportsWhen Safe11.innerModel isIssue ∧
    SupportsWhen Safe11.innerModel isReport :=
  ⟨fun _ _ _ _ _ tr c => controls _ _ _ _ _ tr (.inr (.inl c)),
   fun _ _ _ _ _ tr c => controls _ _ _ _ _ tr (.inl c),
   fun _ _ _ _ _ tr c => controls _ _ _ _ _ tr (.inr (.inr (.inl c))),
   fun _ _ _ _ _ tr c => controls _ _ _ _ _ tr (.inr (.inr (.inr (.inl c)))),
   fun _ _ _ _ _ tr c => controls _ _ _ _ _ tr (.inr (.inr (.inr (.inr c))))⟩

theorem full_positive_stamp : ∀ w s t, Core9.stamp w s = some t →
    Open s (.stamp w) → ∃ u, Safe11.innerModel.stamp w s = some u :=
  fun _ _ t ok _ => ⟨t,ok⟩

theorem full_replay : Replay Safe11.innerModel where
  kept := by
    intro ctx s xs
    induction xs generalizing s with
    | nil => rfl
    | cons c cs ih =>
      cases c with
      | feed | reset => exact ih _
      | frame w =>
        cases ok : Safe11.innerModel.step ctx w s with
        | none => simpa [Release.kept,run,execute,ok] using ih s
        | some t => simpa [Release.kept,run,execute,ok] using ih t
      | stamp w =>
        cases ok : Safe11.innerModel.stamp w s with
        | none => simpa [Release.kept,run,execute,ok] using ih s
        | some t => simpa [Release.kept,run,execute,ok] using ih t
  feedEffect := fun _ _ => .inr rfl
  resetEffect := fun _ => .inr rfl
  feedWhen := fun _ _ _ => rfl
  resetWhen := fun _ _ => rfl

/-- Every carried model satisfying ROOT parses all legacy and implemented version
    namespaces with the pinned interpretation. This includes unsuccessful parses. -/
theorem installed_meanings {m : Model} (root : Lawful m) (s : Release.State) (w : ByteArray)
    (known : w[0]? ≠ some (255 : UInt8) ∨ w[1]? = some (2 : UInt8) ∨ w[1]? = some (3 : UInt8)) :
    Grammar.decode m.grammar s w = Grammar.decode Grammar.installed s w := by
  obtain ⟨more,table⟩ := root.record.version.1
  rw [table]
  by_cases old : w[0]? = some (255 : UInt8)
  · rcases known with invalid | v2 | v3
    · contradiction
    · exact Grammar.v2_stable _ _ _ _ old v2
    · exact Grammar.later_stable _ _ _ _ old v3 (by decide)
  · rw [Grammar.legacy_stable _ _ _ old,Grammar.legacy_stable _ _ _ old]

#print axioms installed_meanings
#print axioms full_positive_controls
#print axioms full_positive_stamp
#print axioms full_replay
end Aukora.Root12
