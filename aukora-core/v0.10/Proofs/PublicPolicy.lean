import Machine
import Proofs.PolicyReplay

namespace Aukora.Core9PolicyLaws

open R6.KernelCell (Context)
open Policy9 (Machine Closed Fresh)

private theorem ordinary {ctx w s t} (old : w[0]? ≠ some (27 : UInt8))
    (ok : Core9.step ctx w s = some t) : Policy9.step w s = some t := by
  simpa [Core9.step, old] using ok

/-- Both delivery routes and the installation route name an intent before
    consulting the same grant restriction. Bare legacy upgrades are refused. -/
def spends (w : ByteArray) (i : Intent) : Prop :=
  (w[0]? ≠ some (27 : UInt8) ∧ Policy9.decode w = some (.use i)) ∨
  (w[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode w = some u ∧ u.intent = i)

theorem admission_requires_open {ctx w s t i} (spend : spends w i) (ok : Core9.step ctx w s = some t) :
    Policy9.grantOK s i = true := by
  rcases spend with ⟨old, dec⟩ | ⟨tag, u, dec, rfl⟩
  · exact Policy9.use_requires_permission dec (ordinary old ok)
  · obtain ⟨v, vd, eligible, _⟩ := Core9.package_admission tag ok
    rw [dec] at vd
    cases Option.some.inj vd
    exact eligible

theorem revoked_or_expired_refused {ctx w s i}
    (condition : Policy9.lookup i s.rules = some .revoked ∨
      ∃ last, Policy9.lookup i s.rules = some (.validThrough last) ∧ last < Policy9.nextSeq s)
    (spend : spends w i) : Core9.step ctx w s = none := by
  cases ok : Core9.step ctx w s with
  | none => rfl
  | some t =>
    have h := admission_requires_open spend ok
    rcases condition with revoked | ⟨last, limit, past⟩
    · simp [Policy9.grantOK, Policy9.permits, revoked] at h
    · simp [Policy9.grantOK, Policy9.permits, limit, Nat.not_le_of_gt past] at h

theorem revoke_closes {ctx w s t i p n ed ml} (old : w[0]? ≠ some (27 : UInt8))
    (dec : Policy9.decode w = some (.cancel p n (Risk8.intentDigest i) ed ml))
    (ok : Core9.step ctx w s = some t)
    (held : i ∈ Policy9.pool s.base) (eligible : Policy9.grantOK s i = true) :
    Closed t i ∧ Policy9.generation t = Policy9.generation s ∧
    (∀ j, j ≠ i →
      (j ∈ Policy9.pool t.base ↔ j ∈ Policy9.pool s.base) ∧
      Policy9.lookup j t.rules = Policy9.lookup j s.rules) := by
  obtain ⟨_, _, _, gen, victim, unique, pool, revoked, other⟩ := Policy9.revoke_effect dec (ordinary old ok)
  have hit : i ∈ Policy9.matchingGrants s (Risk8.intentDigest i) := by
    simp [Policy9.matchingGrants, eligible, held]
  rw [unique, List.mem_singleton] at hit
  subst victim
  simp only [Policy9.grantOK, Bool.and_eq_true, decide_eq_true_eq] at eligible
  exact ⟨Or.inr ⟨eligible.1.trans gen.symm, Or.inl revoked⟩, gen,
    fun j ne => ⟨by simp [pool j, ne], other j ne⟩⟩

theorem closed_next {ctx w s t i} (before : Closed s i) (ok : Core9.step ctx w s = some t)
    (noFresh : ¬Fresh s w i) : Closed t i := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨_, _, _, installed, rules, _⟩ := Core9.package_admission tag ok
    obtain ⟨g, n⟩ := Upgrade9.install_clocks installed
    apply Policy9.closed_persists before
    · exact Nat.le_of_eq g.symm
    · unfold Policy9.nextSeq
      rw [n]
      omega
    · rw [rules]
  · exact Policy9.closed_unless_fresh before (ordinary tag ok) noFresh

inductive Input where
  | frame (bytes : ByteArray)
  | feed (bytes : ByteArray)
  | reset
  | stamp (bytes : ByteArray)

def execute (ctx : Context) (s : Machine) : Input → Machine
  | .frame w => (Core9.step ctx w s).getD s
  | .feed b => Core9.feed b s
  | .reset => Core9.reset s
  | .stamp w => (Core9.stamp w s).getD s

def run (ctx : Context) (s : Machine) : List Input → Machine
  | [] => s
  | cmd :: rest => run ctx (execute ctx s cmd) rest

private theorem stamped {s w t} (ok : Core9.stamp w s = some t) :
    t.rules = s.rules ∧ t.outcomes = s.outcomes ∧ t.base.hybrid = s.base.hybrid := by
  cases base : Core8.stamp w s.base with
  | none => simp [Core9.stamp, base] at ok
  | some b =>
    have eq : {s with base := b} = t := by simpa [Core9.stamp, base] using ok
    subst t
    obtain ⟨⟨parent, beacon, receipt⟩, _, h⟩ := Option.bind_eq_some.mp base
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    cases Option.some.inj h
    exact ⟨rfl, rfl, rfl⟩

def noFresh (ctx : Context) (s : Machine) (i : Intent) : List Input → Prop
  | [] => True
  | cmd :: rest =>
    (match cmd with
     | .frame w => ∀ t, Core9.step ctx w s = some t → ¬Fresh s w i
     | _ => True) ∧ noFresh ctx (execute ctx s cmd) i rest

theorem closed_history (ctx : Context) (s : Machine) (i : Intent) (xs : List Input)
    (before : Closed s i) (without : noFresh ctx s i xs) : Closed (run ctx s xs) i := by
  induction xs generalizing s with
  | nil => exact before
  | cons cmd tail ih =>
    apply ih _ _ without.2
    cases cmd with
    | frame w =>
      cases ok : Core9.step ctx w s with
      | none => simpa [execute, ok] using before
      | some t => simpa [execute, ok] using closed_next before ok (without.1 t ok)
    | feed b | reset => exact before
    | stamp w =>
      cases ok : Core9.stamp w s with
      | none => simpa [execute, ok] using before
      | some t =>
        obtain ⟨rules, _, hybrid⟩ := stamped ok
        simpa [execute, ok, Policy9.Closed, Policy9.generation, Policy9.nextSeq, hybrid, rules] using before

/-- From cancellation or expiry in the current generation, any further delivery
    (grant or mandate) or installation of this exact intent must follow a new
    dual-signed issue. This quantifies over submissions, refusals and staging. -/
theorem cannot_readmit_without_new_signed_grant {ctx s i xs w}
    (before : Closed s i) (without : noFresh ctx s i xs) (spend : spends w i) :
    Core9.step ctx w (run ctx s xs) = none := by
  have shut := Policy9.closed_refuses (closed_history ctx s i xs before without)
  cases ok : Core9.step ctx w (run ctx s xs) with
  | none => rfl
  | some t => rw [admission_requires_open spend ok] at shut; contradiction

private theorem history_step (ctx : Context) (s : Machine) (input : Input) :
    ∃ more, (execute ctx s input).outcomes = more ++ s.outcomes := by
  cases input with
  | frame w =>
    cases ok : Core9.step ctx w s with
    | none => exact ⟨[], by simp [execute, ok]⟩
    | some t =>
      simp only [execute, ok, Option.getD_some]
      by_cases tag : w[0]? = some (27 : UInt8)
      · obtain ⟨_, _, _, _, _, same, _⟩ := Core9.package_admission tag ok
        exact ⟨[], same⟩
      · exact Policy9.history_extends (ordinary tag ok)
  | reset | feed _ => exact ⟨[], rfl⟩
  | stamp w =>
    cases ok : Core9.stamp w s with
    | none => exact ⟨[], by simp [execute, ok]⟩
    | some t => exact ⟨[], by simpa [execute, ok] using (stamped ok).2.1⟩

/-- No operation removes an outcome, including across rebind, installation,
    stamp submission, staging or arbitrary refused submissions. -/
theorem outcome_history (ctx : Context) (s : Machine) (xs : List Input) :
    ∃ more, (run ctx s xs).outcomes = more ++ s.outcomes := by
  induction xs generalizing s with
  | nil => exact ⟨[], rfl⟩
  | cons cmd rest ih =>
    obtain ⟨xs, afterStep⟩ := history_step ctx s cmd
    obtain ⟨ys, afterRun⟩ := ih (execute ctx s cmd)
    exact ⟨ys ++ xs, by simp [run, afterRun, afterStep, List.append_assoc]⟩

theorem outcome_value {ctx wire s t p n i v fix} (ordinaryTag : wire[0]? ≠ some (27 : UInt8))
    (dec : Policy9.decode wire = some (.report p n i v fix)) (ok : Core9.step ctx wire s = some t)
    (key : ByteArray) (ident : (Digest.mk key.data.toList) = Risk8.intentDigest i) :
    Core9.outcome t key = (if fix then 4 else 0) +
      (match v with | .confirmed => 0 | .failed => 1 | .unknown => 2) := by
  have val := (Policy9.report_history dec (ordinary ordinaryTag ok)).2.2.1
  cases v <;> simp [Core9.outcome, Policy9.outcomeCode, ident, val]

#print axioms admission_requires_open
#print axioms revoked_or_expired_refused
#print axioms revoke_closes
#print axioms cannot_readmit_without_new_signed_grant
#print axioms outcome_history
#print axioms outcome_value

end Aukora.Core9PolicyLaws
