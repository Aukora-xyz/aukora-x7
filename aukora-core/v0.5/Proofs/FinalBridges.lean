import Proofs.FinalPolicies
namespace Aukora.RootFinal.Bridges
open Release
open Versions
open R6.KernelCell (Context)

private theorem old_noIssue {m : Model} {s w i} (old : Legacy w) : ¬ NewIssue m s w i := by
  rintro ⟨p,n,e,ed,ml,kind,_⟩
  rw [old_interpretation _ _ old] at kind
  obtain ⟨_,_,eq⟩ := Option.map_eq_some'.mp kind
  cases eq

private theorem old_without_issue {m : Model} {ctx start i xs} (old : Only01 xs)
    (no : withoutIssue m ctx start i xs) : without m ctx (fun s w => Issued s w i ∨ NewIssue m s w i) start xs := by
  induction xs generalizing start with
  | nil => trivial
  | cons c cs ih =>
    refine ⟨?_,ih (fun w h => old w (List.mem_cons_of_mem _ h)) no.2⟩
    cases c with
    | frame w => exact fun t hit p => p.elim (no.1 t hit) (old_noIssue (old w (by simp)))
    | _ => trivial

private theorem old_without_renewal {m : Model} {ctx start i xs} (old : Only01 xs)
    (no : withoutRenewal m ctx start i xs) : without m ctx (fun s w => Policy9.Fresh s w i ∨ NewIssue m s w i) start xs := by
  induction xs generalizing start with
  | nil => trivial
  | cons c cs ih =>
    refine ⟨?_,ih (fun w h => old w (List.mem_cons_of_mem _ h)) no.2⟩
    cases c with
    | frame w => exact fun t hit p => p.elim (no.1 t hit) (old_noIssue (old w (by simp)))
    | _ => trivial

theorem once {m : Model} (law : Once m) {ctx w s t i} (hit : m.step ctx w s = some t) (direct : Direct w i) :
    i ∈ pool s ∧ i.generation = Policy9.generation s ∧
    (ledger t).book.auth.admitted = i :: (ledger s).book.auth.admitted ∧ i ∉ pool t ∧
    ∀ xs later, Only01 xs → withoutIssue m ctx t i xs → Direct later i → m.step ctx later (run m ctx t xs) = none := by
  obtain ⟨a,b,c,d,all⟩ := law ctx w s t i hit direct
  exact ⟨a,b,c,d,fun xs later old no => all xs later (old_without_issue old no)⟩

theorem revoke {m : Model} (h : Revocation m) : RevokeLaw m :=
  fun ctx w s t p n d ed ml tr => h ctx w s t p n d ed ml (.inl tr)

theorem expiry {m : Model} (h : Expiry m) :
  (∀ ctx w s t p n last i ed ml, Tracked w (.issue p n last i ed ml) → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml ∧
    n < last ∧ i ∈ pool t ∧ Policy9.lookup i t.rules = some (.validThrough last) ∧
    ∀ proposed, Policy9.permits t.rules i proposed = decide (proposed ≤ last)) ∧
  (∀ ctx w s i, (Policy9.lookup i s.rules = some .revoked ∨
     ∃ last, Policy9.lookup i s.rules = some (.validThrough last) ∧ last < Policy9.nextSeq s) →
    Core9PolicyLaws.spends w i → m.step ctx w s = none) ∧
  ∀ ctx s i xs w, Only01 xs → Policy9.Closed s i → withoutRenewal m ctx s i xs → Core9PolicyLaws.spends w i →
    m.step ctx w (run m ctx s xs) = none :=
  ⟨fun ctx w s t p n e i ed ml tr => h.1 ctx w s t p n e i ed ml (.inl tr),
    h.2.1,fun ctx s i xs w old closed no => h.2.2 ctx s i xs w closed (old_without_renewal old no)⟩

theorem correction {m : Model} (law : Correction m) : CorrectionLaw m := by
  refine ⟨law.1,?_,?_⟩
  · intro ctx w s t p n i v fix tr hit
    obtain ⟨allowed,after,view⟩ := law.2 ctx w s t i v fix (.inl ⟨p,n,tr⟩) hit
    refine ⟨?_,after,view⟩
    cases prior : Policy9.view s.outcomes (Risk8.intentDigest i) <;> cases fix <;>
      simp_all [Policy9.reportOK,prior]
  · intro ctx w s t p n i v tr hit
    have allowed := (law.2 ctx w s t i v true (.inl ⟨p,n,tr⟩) hit).1
    cases prior : Policy9.view s.outcomes (Risk8.intentDigest i) with
    | none => simp [Policy9.reportOK,prior] at allowed
    | some previous => exact ⟨previous,rfl,by simpa [Policy9.reportOK,prior] using allowed⟩

theorem halt_boundary {m : Model} (boundary : Boundary m) {ctx w s}
    (old : Legacy w) (halted : Safe11.halted s = true) (route : Safe11.route w = .ordinary)
    (barred : Safe11.allowedOrdinary w = false) : m.step ctx w s = none := by
  apply boundary ctx w s halted route
  rintro (allowed | ⟨op,kind,_⟩)
  · rw [barred] at allowed
    contradiction
  · rw [old_interpretation _ _ old] at kind
    obtain ⟨_,_,bad⟩ := Option.map_eq_some'.mp kind
    cases bad

theorem control {m : Model} (h : Control m) : ControlLaw m := h.1
theorem passive {m : Model} (h : PassiveFrames m) : PassiveLaw m := h.1
theorem restore {m : Model} (h : Restore m) : RestoreLaw m := h.1

#print axioms once
#print axioms expiry
#print axioms correction
#print axioms halt_boundary
end Aukora.RootFinal.Bridges
