import Proofs.FrameLaws
import Proofs.Events

/- The unified ledger reuses the round-2 transition, including its complete policy,
   counters and append-only history. These lemmas cover *all* its actions. The outer
   round-4 machine additionally checks the candidate hash before calling R2.next. -/
namespace Aukora.Events4

open R2

theorem upgrade_requires_grant {d s x t target checked i}
    (ok : R2.next d s x = some t) (action : x.action = .base (.upgrade target checked i)) :
    checked = true ∧ i.body = .install target ∧
    i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have accepted := (R2.next_spec ok).1.2.2.1
  have gate : Eligible s.book (.upgrade target checked i) := by
    simpa [action, policy] using accepted
  have spendGate : i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
    simpa [spendOK, spendIntent] using gate.1
  have proofGate : checked = true ∧ i.body = .install target := by
    simpa [eventOK] using gate.2
  exact ⟨proofGate.1, proofGate.2, spendGate⟩
#print axioms upgrade_requires_grant

theorem upgrade_spent {d s x t target checked i}
    (ok : R2.next d s x = some t) (action : x.action = .base (.upgrade target checked i)) :
    t.book.auth.core = target ∧ i ∉ t.book.auth.grants := by
  simp [(R2.next_spec ok).2, R2.append, nextBook, advance, action, changeAuth, spend, List.mem_filter]
#print axioms upgrade_spent

private theorem core_change_shape (b : Book) (a : Action)
    (changed : (nextBook b a).auth.core ≠ b.auth.core) :
    ∃ target checked i, a = .base (.upgrade target checked i) := by
  cases a with
  | base e =>
    cases e <;> simp [nextBook, advance, changeAuth, spend] at changed
    case upgrade target checked i => exact ⟨target, checked, i, rfl⟩
  | useMandate id e => cases e <;> simp [nextBook] at changed
  | _ => simp [nextBook] at changed
#print axioms core_change_shape

theorem core_change_requires_upgrade {d s x t} (ok : R2.next d s x = some t)
    (changed : t.book.auth.core ≠ s.book.auth.core) :
    ∃ i, x.action = .base (.upgrade t.book.auth.core true i) ∧ i.body = .install t.book.auth.core ∧
      i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have changedBook : (nextBook s.book x.action).auth.core ≠ s.book.auth.core := by
    simpa [(R2.next_spec ok).2, R2.append] using changed
  obtain ⟨target, checked, i, action⟩ := core_change_shape _ _ changedBook
  obtain ⟨proofFlag, body, grant, gen⟩ := upgrade_requires_grant ok action
  rw [(upgrade_spent ok action).1, ← proofFlag]
  exact ⟨i, action, body, grant, gen⟩
#print axioms core_change_requires_upgrade

theorem grant_absent_after {d s x t i} (ok : R2.next d s x = some t) (absent : i ∉ s.book.auth.grants)
    (noIssue : x.action ≠ .base (.grant i true)) : i ∉ t.book.auth.grants := by
  rw [(R2.next_spec ok).2]
  change i ∉ (nextBook s.book x.action).auth.grants
  cases act : x.action with
  | base e =>
    have other : e ≠ .grant i true := by intro h; exact noIssue (by rw [act, h])
    exact absence_after_change _ _ _ absent other
  | useMandate id e => cases e <;> simpa [nextBook] using absent
  | _ => simpa [nextBook] using absent

#print axioms grant_absent_after

end Aukora.Events4
