import core.Bound4
import core.Wire4

namespace Aukora.Stateful4

open Bound4

def frameDigest (x : R2.Frame) : Digest := digest (Wire4.encode x).toByteArray

@[export r4_step]
def stepBytes (wire : @& ByteArray) (s : @& Machine) : Option Machine := do
  let x ← Wire4.decode wire
  Bound4.next frameDigest s x

theorem step_decoded {s wire x} (decoded : Wire4.decode wire = some x) :
    stepBytes wire s = Bound4.next frameDigest s x := by simp [stepBytes, decoded]
#print axioms step_decoded

theorem step_malformed {s wire} (bad : Wire4.decode wire = none) :
    stepBytes wire s = none := by simp [stepBytes, bad]
#print axioms step_malformed

/-- Every successful wire submission is also an exact R2 ledger transition.
    Its entire ledger (including the history, book and active view) is determined. -/
theorem ledger_refinement {s wire x t} (decoded : Wire4.decode wire = some x)
    (ok : stepBytes wire s = some t) :
    R2.next frameDigest s.ledger x = some t.ledger :=
  (Bound4.accepted ((step_decoded decoded).symm.trans ok)).2
#print axioms ledger_refinement

/-- Commands after the ABI has assembled a complete chunk or frame. -/
inductive Command where
  | feed (chunk : ByteArray)
  | reset
  | submit (wire : ByteArray)

def applyCommand (s : Machine) : Command → Machine
  | .feed chunk => feed chunk s
  | .reset => reset s
  | .submit wire => (stepBytes wire s).getD s

theorem core_changes_only_by_accepted_upgrade {s cmd}
    (changed : (applyCommand s cmd).ledger.book.auth.core ≠ s.ledger.book.auth.core) :
    ∃ wire x i, cmd = .submit wire ∧ Wire4.decode wire = some x ∧
      stepBytes wire s = some (applyCommand s cmd) ∧
      x.action = .base (.upgrade (digest s.candidate) true i) ∧
      (applyCommand s cmd).ledger.book.auth.core = digest s.candidate ∧
      i.body = .install (digest s.candidate) ∧ i ∈ s.ledger.book.auth.grants ∧
      i.generation = s.ledger.book.auth.generation := by
  cases cmd with
  | feed | reset => exact False.elim (changed rfl)
  | submit wire =>
    cases ok : stepBytes wire s with
    | none => exact False.elim (changed (by simp [applyCommand, ok]))
    | some t =>
      have eq : applyCommand s (.submit wire) = t := by simp [applyCommand, ok]
      cases dec : Wire4.decode wire with
      | none => simp [step_malformed dec] at ok
      | some x =>
        obtain ⟨i, action, coreEq, props⟩ := Bound4.core_change_only
          ((step_decoded dec).symm.trans ok) (eq ▸ changed)
        exact ⟨wire, x, i, rfl, dec, eq.symm ▸ ok, action, eq.symm ▸ coreEq, props⟩
#print axioms core_changes_only_by_accepted_upgrade

theorem mismatch_refused {s wire x target checked i approved}
    (dec : Wire4.decode wire = some x) (ev : x.action = .base (.upgrade target checked i))
    (body : i.body = .install approved) (different : digest s.candidate ≠ approved) :
    stepBytes wire s = none ∧ applyCommand s (.submit wire) = s := by
  simpa only [applyCommand, step_decoded dec] using
    (Bound4.wrong_digest (d := frameDigest) ev body different)
#print axioms mismatch_refused

theorem different_bytes_refused {s wire x target checked i} (approved : ByteArray)
    (dec : Wire4.decode wire = some x) (ev : x.action = .base (.upgrade target checked i))
    (body : i.body = .install (digest approved)) (different : s.candidate ≠ approved)
    (noSecondPreimage : digest s.candidate = digest approved → s.candidate = approved) :
    stepBytes wire s = none ∧ applyCommand s (.submit wire) = s :=
  mismatch_refused dec ev body (fun eq => different (noSecondPreimage eq))
#print axioms different_bytes_refused

/-- A new issuance is an actual acceptance of a fresh grant for this exact intent.
    Rejected or malformed submissions do not interrupt the once-only guarantee. -/
def issues (i : Intent) (s : Machine) : Command → Prop
  | .submit wire => (stepBytes wire s).isSome = true ∧
      ∃ x, Wire4.decode wire = some x ∧ x.action = .base (.grant i true)
  | _ => False

def noReissue (i : Intent) (s : Machine) : List Command → Prop
  | [] => True
  | c :: cs => ¬ issues i s c ∧ noReissue i (applyCommand s c) cs

private theorem absent_trace (s : Machine) (commands : List Command) (i : Intent)
    (absent : i ∉ s.ledger.book.auth.grants) (noNew : noReissue i s commands) :
    i ∉ (commands.foldl applyCommand s).ledger.book.auth.grants := by
  induction commands generalizing s with
  | nil => exact absent
  | cons cmd rest ih =>
    apply ih (applyCommand s cmd) _ noNew.2
    cases cmd with
    | feed | reset => exact absent
    | submit wire =>
      cases ok : stepBytes wire s with
      | none => simpa [applyCommand, ok] using absent
      | some t =>
        cases dec : Wire4.decode wire with
        | none => simp [step_malformed dec] at ok
        | some x =>
          have noIssue : x.action ≠ .base (.grant i true) := by
            intro ev
            exact noNew.1 ⟨by simp [ok], x, dec, ev⟩
          simpa [applyCommand, ok] using
            Events4.grant_absent_after (ledger_refinement dec ok) absent noIssue
#print axioms absent_trace

theorem one_grant_upgrades_at_most_once {s t wire x target checked i}
    (dec : Wire4.decode wire = some x) (ok : stepBytes wire s = some t)
    (ev : x.action = .base (.upgrade target checked i)) :
    i ∉ t.ledger.book.auth.grants ∧
    ∀ commands, noReissue i t commands →
      ∀ later y target' checked', Wire4.decode later = some y →
        y.action = .base (.upgrade target' checked' i) →
        stepBytes later (commands.foldl applyCommand t) = none := by
  have spent := (Events4.upgrade_spent (ledger_refinement dec ok) ev).2
  refine ⟨spent, ?_⟩
  intro cs noNew later y target' checked' dec' ev'
  have missing := absent_trace t cs i spent noNew
  cases ok' : stepBytes later (cs.foldl applyCommand t) with
  | none => rfl
  | some u => exact False.elim (missing (Events4.upgrade_requires_grant (ledger_refinement dec' ok') ev').2.2.1)
#print axioms one_grant_upgrades_at_most_once

end Aukora.Stateful4
