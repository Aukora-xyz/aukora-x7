import Proofs.DangerPolicy
import Proofs.PublicBehavior

namespace Aukora.Release
open R6.KernelCell (Context)
open private Core8.act Core8.thresholdControl Core8.assessment from Ledger.Assessed
open private Policy9.ran Policy9.parsed Policy9.bound from Proofs.Policy
open private Policy9.applyBase Policy9.append from Policy
open private mapped from Proofs.Authority
open private same_risk from Proofs.DangerPolicy

/-- Positive availability for a frozen command class, on the same state and input.
    The semantic laws separately constrain the accepting successor state. -/
def Supports (m : Ops) (kind : Policy9.Command → Prop) : Prop :=
  ∀ ctx w s t c, Tracked w c → kind c → Policy9.step w s = some t → ∃ u, m.step ctx w s = some u

theorem newest_supports (kind : Policy9.Command → Prop) : Supports newest kind := by
  intro ctx w s t cmd decoded _ ok
  exact ⟨t, by simpa [newest, Core9.step, decoded.1] using ok⟩

def isAssessment : Policy9.Command → Prop | .assessment => True | _ => False
def isThreshold : Policy9.Command → Prop | .threshold => True | _ => False
def isRevocation : Policy9.Command → Prop | .cancel .. => True | _ => False
def isIssue : Policy9.Command → Prop | .issue .. => True | _ => False
def isReport : Policy9.Command → Prop | .report .. => True | _ => False

def RulesLaw (m : Ops) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t →
    (Tagged w 27 ∧ t.rules = s.rules) ∨ ∃ c, Tracked w c ∧
      t.rules = Policy9.rulesAfter s.rules (Policy9.selected s c) c

theorem newest_rules : RulesLaw newest := by
  intro ctx w s t ok
  by_cases tag : Tagged w 27
  · obtain ⟨_, _, _, _, eq, _⟩ := Core9.package_admission tag ok
    exact Or.inl ⟨tag, eq⟩
  · have pol : Policy9.step w s = some t := by simpa [newest, Core9.step, tag] using ok
    obtain ⟨c, dec⟩ := Policy9.parsed pol
    exact Or.inr ⟨c, ⟨tag, dec⟩, (Policy9.ran dec pol).2.1⟩

def riskAfter (w : ByteArray) (s : State) : Policy9.Command → Option Risk8.State
  | .assessment => (Core8.assessment w s.base).map (·.risk)
  | .threshold => (Core8.thresholdControl w s.base).map (·.risk)
  | .use _ => (Core8.act w s.base).map (·.risk)
  | _ => some s.base.risk

def RiskStateLaw (m : Ops) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t →
    (Tagged w 27 ∧ t.base.risk = s.base.risk) ∨ ∃ c, Tracked w c ∧ riskAfter w s c = some t.base.risk

theorem newest_riskState : RiskStateLaw newest := by
  intro ctx w s t ok
  by_cases tag : Tagged w 27
  · unfold newest Core9.step at ok
    simp only [tag, ne_eq, not_true_eq_false, Bool.false_eq_true, if_false] at ok
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, eq⟩ := Policy9.bound h
    cases Option.some.inj eq
    exact Or.inl ⟨tag,rfl⟩
  · have pol : Policy9.step w s = some t := by simpa [newest, Core9.step, tag] using ok
    obtain ⟨c, dec⟩ := Policy9.parsed pol
    refine Or.inr ⟨c, ⟨tag, dec⟩, ?_⟩
    have h := (Policy9.ran dec pol).1
    cases c with
    | ordinary | report =>
      obtain ⟨_, _, app⟩ := Policy9.bound h
      have eq := same_risk app
      simpa only [riskAfter, eq]
    | issue =>
      obtain ⟨_, _, h⟩ := Policy9.bound h
      obtain ⟨_, _, h⟩ := Policy9.bound h
      obtain ⟨_, _, app⟩ := Policy9.bound h
      have eq := same_risk app
      exact congrArg some eq.symm
    | cancel =>
      obtain ⟨_, _, h⟩ := Policy9.bound h
      obtain ⟨_, _, app⟩ := Policy9.bound h
      have eq := same_risk app
      exact congrArg some eq.symm
    | rebind =>
      obtain ⟨_, _, h⟩ := Policy9.bound h
      obtain ⟨b, app, eq⟩ := Policy9.bound h
      have same := same_risk app
      rw [← Option.some.inj eq]
      exact congrArg some same.symm
    | use i =>
      have allowed := Policy9.use_requires_permission dec pol
      simp only [Policy9.applyBase, allowed, if_true] at h
      obtain ⟨b, applied, eq⟩ := mapped h
      simp [riskAfter, applied, eq]
    | threshold | assessment =>
      obtain ⟨b, applied, eq⟩ := mapped h
      simp [riskAfter, applied, eq]

theorem initial_threshold {key s} (init : newest.genesis key = some s) : s.base.risk.threshold = 0 := by
  cases base : Core8.genesis key with
  | none => simp [newest, Core9.genesis, Policy9.genesis, base] at init
  | some b =>
    have eq : ({base := b} : State) = s := by simpa [newest, Core9.genesis, Policy9.genesis, base] using init
    subst s
    obtain ⟨_, _, h⟩ := Policy9.bound base
    obtain ⟨_, _, eq⟩ := Policy9.bound h
    cases Option.some.inj eq
    rfl

end Aukora.Release
