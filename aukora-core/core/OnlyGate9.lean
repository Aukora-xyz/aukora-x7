import core.Core9

namespace Aukora.OnlyGate9
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.act Core8.actRoute from core.Core8
open private Policy9.append Policy9.applyBase from core.Policy9
open private Upgrade6.isOldUpgrade from core.Upgrade6

private abbrev coreId (s : Core8.Machine) := s.hybrid.inner.ledger.book.auth.core
private abbrev NoUpgrade (f : R2.Frame) := ∀ d i, f.action ≠ .base (.upgrade d true i)

private theorem unchanged {dig s f t} (ok : Bound4.next dig s f = some t) (blocked : NoUpgrade f) :
    t.ledger.book.auth.core = s.ledger.book.auth.core := by
  apply Classical.byContradiction
  intro changed
  obtain ⟨i, ev, _⟩ := Bound4.core_change_only ok changed
  exact blocked _ i ev

private theorem append8 {s w f h} (ok : Core8.append s w f = some h) (noUp : NoUpgrade f) :
    h.inner.ledger.book.auth.core = coreId s := by
  unfold Core8.append at ok
  obtain ⟨inner, step, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact unchanged step noUp

private theorem metadata {s w p n label val risk t} (ok : Core8.metadata s w p n label val risk = some t) :
    coreId t = coreId s := by
  unfold Core8.metadata at ok
  obtain ⟨hybrid, step, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact append8 step (by intro d i; simp)

private theorem assess {w s t} (ok : Core8.assessment w s = some t) : coreId t = coreId s := by
  unfold Core8.assessment at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨⟨_, _⟩, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
  exact metadata h

private theorem threshold {w s t} (ok : Core8.thresholdControl w s = some t) : coreId t = coreId s := by
  unfold Core8.thresholdControl at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨⟨_, _⟩, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
  exact metadata h

private theorem act {w s t} (ok : Core8.act w s = some t) : coreId t = coreId s := by
  unfold Core8.act at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨x, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨⟨i,g⟩, route, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨hybrid, appended, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨risk, _, eq⟩ := Option.bind_eq_some.mp h
  cases Option.some.inj eq
  apply append8 appended
  intro d j
  unfold Core8.actRoute at route
  split at route <;> simp_all [Wire5.Frame.project, Wire5.Action.project]

private theorem append9 {s w f t} (ok : Policy9.append s w f = some t) (noUp : NoUpgrade f) :
    coreId t = coreId s := by
  unfold Policy9.append at ok
  obtain ⟨inner, step, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact unchanged step noUp

private theorem authorized_unrelated {v s x extra} (ok : Hybrid7.authorized v s x extra = true) : NoUpgrade x.project := by
  rcases x with ⟨parent, seq, action⟩
  intro d i
  cases action with
  | plain a =>
    change a ≠ _
    rintro rfl
    cases extra <;> simp [Hybrid7.authorized, Upgrade6.isOldUpgrade] at ok
  | grant _ _ | rebind _ _ => simp [Wire5.Frame.project, Wire5.Action.project]
  | control op _ => cases op <;> simp [Wire5.Frame.project, Wire5.Action.project, Wire5.Control.project]

private theorem apply_same {s w choice c t} (ok : Policy9.applyBase s w choice c = some t) : coreId t = coreId s.base := by
  cases c with
  | use i =>
    by_cases allowed : Policy9.grantOK s i = true
    · cases run : Core8.act w s.base with
      | none => simp [Policy9.applyBase, allowed, run] at ok
      | some next => simp [Policy9.applyBase, allowed, run] at ok; subst t; exact act (t := next) run
    · simp [Policy9.applyBase, allowed, guard] at ok
  | assessment =>
    cases run : Core8.assessment w s.base with
    | none => simp [Policy9.applyBase, run] at ok
    | some next => simp [Policy9.applyBase, run] at ok; subst t; exact assess (t := next) run
  | threshold =>
    cases run : Core8.thresholdControl w s.base with
    | none => simp [Policy9.applyBase, run] at ok
    | some next => simp [Policy9.applyBase, run] at ok; subst t; exact threshold (t := next) run
  | issue =>
    unfold Policy9.applyBase at ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    have same := append9 h (by intro d i; simp)
    exact same
  | cancel =>
    unfold Policy9.applyBase at ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    have same := append9 h (by intro d i; simp)
    exact same
  | report =>
    unfold Policy9.applyBase at ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
    have same := append9 h (by intro d i; simp)
    exact same
  | rebind =>
    unfold Policy9.applyBase at ok
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
    obtain ⟨base, appended, eq⟩ := Option.bind_eq_some.mp h
    cases Option.some.inj eq
    exact append9 (t := base) appended (by intro d i; simp [Wire5.Frame.project, Wire5.Action.project])
  | ordinary x extra =>
    by_cases allowed : Hybrid7.authorized Core8.verifiers s.base.hybrid x extra = true
    · exact append9 (by simpa [Policy9.applyBase, allowed] using ok) (authorized_unrelated allowed)
    · simp [Policy9.applyBase, allowed, guard] at ok
      contradiction

/-- Every successful transition of the complete non-upgrade dispatcher preserves the installed digest. -/
theorem policy_preserves_core {wire s t} (ok : Policy9.step wire s = some t) : coreId t.base = coreId s.base := by
  unfold Policy9.step at ok
  obtain ⟨cmd, _, h⟩ := Option.bind_eq_some.mp ok
  unfold Policy9.submit at h
  obtain ⟨base, accepted, eq⟩ := Option.bind_eq_some.mp h
  cases Option.some.inj eq
  exact apply_same accepted

/-- Any change of the installed digest through the public entry point used tag 27,
    a currently eligible intent, its committed model, and its candidate-specific proof. -/
theorem core_change_requires_package {ctx wire s t} (ok : Core9.step ctx wire s = some t)
    (changed : coreId t.base ≠ coreId s.base) :
    wire[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode wire = some u ∧
      Policy9.grantOK s u.intent = true ∧ Checker9.check ctx u.model u.proof = true ∧
      ModelSection9.read s.base.hybrid.inner.candidate = some (Bound4.digest u.model) ∧
      u.intent ∈ s.base.hybrid.inner.ledger.book.auth.grants ∧
      u.intent ∉ t.base.hybrid.inner.ledger.book.auth.grants ∧ coreId t.base = u.target := by
  by_cases tag : wire[0]? = some (27 : UInt8)
  · obtain ⟨u, dec, eligible, installed, _⟩ := Core9.package_admission tag ok
    obtain ⟨matched, checked, staged, target, _, held, spent⟩ := Upgrade9.admission installed
    exact ⟨tag, u, dec, eligible, checked, matched, held, spent, target.trans staged⟩
  · exact False.elim (changed (policy_preserves_core (by simpa [Core9.step, tag] using ok)))

#print axioms policy_preserves_core
#print axioms core_change_requires_package
end Aukora.OnlyGate9
