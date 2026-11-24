import core.Core9PolicyLaws

namespace Aukora.GrantOrigin9
open Core9PolicyLaws (Input execute run)
open private Core9PolicyLaws.stamped from core.Core9PolicyLaws
open private Policy9.applyBase Policy9.append Policy9.setPool from core.Policy9
open private Policy9.ran Policy9.parsed Policy9.bound from core.Policy9Laws
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.act Core8.actRoute from core.Core8
open private Hybrid7.both_of_sig from core.Hybrid7

/-- The exact intent and key pair appear in each message. A timed grant also signs
    its expiry, issuance sequence, parent head and generation. -/
inductive Signed : Hybrid7.Keys → Intent → Prop where
  | legacy {keys i ed ml}
      (both : Hybrid7.Both Core8.verifiers keys (Hybrid7.grantMessage keys i) ed ml) : Signed keys i
  | timed {s parent seq last i ed ml}
      (both : Hybrid7.Both Core8.verifiers s.base.hybrid.owner (Policy9.issueMessage s parent seq last i) ed ml) :
      Signed s.base.hybrid.owner i

private abbrev Valid (h : Hybrid7.Machine) := ∀ i ∈ h.inner.ledger.book.auth.grants, Signed h.owner i
private abbrev Issued (keys : Hybrid7.Keys) (f : R2.Frame) := ∀ i, f.action = .base (.grant i true) → Signed keys i

private theorem bound_valid {s t : Bound4.Machine} {hash keys f}
    (ok : Bound4.next hash s f = some t) (old : Valid ⟨s,keys⟩) (issue : Issued keys f) : Valid ⟨t,keys⟩ := by
  intro i held
  by_cases had : i ∈ s.ledger.book.auth.grants
  · exact old i had
  · apply issue
    apply Classical.byContradiction
    intro other
    exact Events4.grant_absent_after (Bound4.accepted ok).2 had other held

private theorem append9 {s w f t} (ok : Policy9.append s w f = some t)
    (old : Valid s.hybrid) (issue : Issued s.hybrid.owner f) : Valid t.hybrid := by
  obtain ⟨inner, applied, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact bound_valid applied old issue

private theorem filtered {s pred} (old : Valid s.hybrid) :
    Valid (Policy9.setPool s ((Policy9.pool s).filter pred)).hybrid :=
  fun i held => old i (List.mem_filter.mp held).1

private theorem append8 {s w f h} (ok : Core8.append s w f = some h)
    (old : Valid s.hybrid) (issue : Issued s.hybrid.owner f) : Valid h := by
  obtain ⟨inner, applied, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact bound_valid applied old issue

private theorem metadata {s w p n label v risk t} (ok : Core8.metadata s w p n label v risk = some t)
    (old : Valid s.hybrid) : Valid t.hybrid := by
  obtain ⟨h, applied, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact append8 applied old (by intro i; simp)

private theorem act {s w t} (ok : Core8.act w s = some t) (old : Valid s.hybrid) : Valid t.hybrid := by
  obtain ⟨_, _, h⟩ := Policy9.bound ok
  obtain ⟨x, _, h⟩ := Policy9.bound h
  obtain ⟨⟨i,g⟩, route, h⟩ := Policy9.bound h
  obtain ⟨hybrid, applied, h⟩ := Policy9.bound h
  obtain ⟨risk, _, eq⟩ := Policy9.bound h
  cases Option.some.inj eq
  apply append8 applied old
  intro j
  unfold Core8.actRoute at route
  split at route <;> simp_all [Wire5.Frame.project, Wire5.Action.project]

private theorem legacy {s x extra} (ok : Hybrid7.authorized Core8.verifiers s x extra = true) : Issued s.owner x.project := by
  intro i ev
  cases a : x.action with
  | plain op =>
    have shape : op = .base (.grant i true) := by simpa [Wire5.Frame.project, Wire5.Action.project, a] using ev
    cases extra <;> simp [Hybrid7.authorized, a, shape, Wire5.plainOK] at ok
  | grant j ed =>
    have jeq : j = i := by simpa [Wire5.Frame.project, Wire5.Action.project, a] using ev
    subst j
    cases extra <;> simp [Hybrid7.authorized, a] at ok
    exact .legacy (Hybrid7.both_of_sig ok.2)
  | rebind => simp [Wire5.Frame.project, Wire5.Action.project, a] at ev
  | control op ed => cases op <;> simp [Wire5.Frame.project, Wire5.Action.project, Wire5.Control.project, a] at ev

private theorem policy {s w t} (ok : Policy9.step w s = some t) (old : Valid s.base.hybrid) : Valid t.base.hybrid := by
  obtain ⟨cmd, dec⟩ := Policy9.parsed ok
  have h := (Policy9.ran dec ok).1
  cases cmd with
  | ordinary x extra =>
    obtain ⟨_, authorized, app⟩ := Policy9.bound h
    have authorized' : Hybrid7.authorized Core8.verifiers s.base.hybrid x extra = true := by
      by_contra bad
      simp [guard, bad] at authorized
    exact append9 app old (legacy authorized')
  | issue p n last i ed ml =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    apply append9 app (filtered old)
    intro j eq
    have ji : i = j := by simpa using eq
    subst j
    exact .timed (Policy9.issue_effect dec ok).1
  | cancel =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    exact append9 app (filtered old) (by intro i; simp)
  | rebind =>
    intro i held
    have empty := (Policy9.rebind_clears dec ok).2.1
    change i ∈ Policy9.pool t.base at held
    simp [empty] at held
  | report =>
    obtain ⟨_, _, app⟩ := Policy9.bound h
    exact append9 app old (by intro i; simp)
  | use i =>
    have permitted := Policy9.use_requires_permission dec ok
    cases hit : Core8.act w s.base with
    | none => simp [Policy9.applyBase, permitted, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push w} = t.base := by simpa [Policy9.applyBase, permitted, hit] using h
      rw [← eq]
      exact act (t := b) hit old
  | assessment =>
    cases hit : Core8.assessment w s.base with
    | none => simp [Policy9.applyBase, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push w} = t.base := by simpa [Policy9.applyBase, hit] using h
      rw [← eq]
      obtain ⟨_, _, hit⟩ := Policy9.bound hit
      obtain ⟨⟨_,_⟩, _, hit⟩ := Policy9.bound hit
      obtain ⟨_, _, app⟩ := Policy9.bound hit
      exact metadata (t := b) app old
  | threshold =>
    cases hit : Core8.thresholdControl w s.base with
    | none => simp [Policy9.applyBase, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push w} = t.base := by simpa [Policy9.applyBase, hit] using h
      rw [← eq]
      obtain ⟨_, _, hit⟩ := Policy9.bound hit
      obtain ⟨⟨_,_⟩, _, hit⟩ := Policy9.bound hit
      obtain ⟨_, _, hit⟩ := Policy9.bound hit
      obtain ⟨_, _, hit⟩ := Policy9.bound hit
      obtain ⟨_, _, app⟩ := Policy9.bound hit
      exact metadata (t := b) app old

private theorem preserves {ctx w s t} (ok : Core9.step ctx w s = some t) (old : Valid s.base.hybrid) : Valid t.base.hybrid := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨u, _, _, installed, _⟩ := Core9.package_admission tag ok
    obtain ⟨_, _, h⟩ := Policy9.bound installed
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨inner, step, eq⟩ := Policy9.bound h
    rw [← Option.some.inj eq]
    exact bound_valid step old (by intro i; simp [Upgrade9.frame])
  · exact policy (by simpa [Core9.step, tag] using ok) old

private theorem initial {keys start} (ok : Core9.genesis keys = some start) : Valid start.base.hybrid := by
  cases hb : Core8.genesis keys with
  | none => simp [Core9.genesis, Policy9.genesis, hb] at ok
  | some base =>
    have eq : ({base} : Policy9.Machine) = start := by simpa [Core9.genesis, Policy9.genesis, hb] using ok
    subst start
    obtain ⟨_, _, h⟩ := Policy9.bound hb
    obtain ⟨hybrid, init, eq⟩ := Policy9.bound h
    cases Option.some.inj eq
    unfold Hybrid7.genesis at init
    split at init
    · cases Option.some.inj init
      intro i held
      contradiction
    · contradiction

private theorem history (ctx) (s : Policy9.Machine) (xs : List Input) (old : Valid s.base.hybrid) : Valid (run ctx s xs).base.hybrid := by
  induction xs generalizing s with
  | nil => exact old
  | cons cmd rest ih =>
    apply ih
    cases cmd with
    | feed | reset => exact old
    | frame w =>
      cases ok : Core9.step ctx w s with
      | none => simpa [execute, ok] using old
      | some t => simpa [execute, ok] using preserves ok old
    | stamp w =>
      cases ok : Core9.stamp w s with
      | none => simpa [execute, ok] using old
      | some t => simpa [execute, ok, (Core9PolicyLaws.stamped ok).2.2] using old

/-- In every actual byte-command history from genesis, a successful package spends its exact
    install grant with both current-key signatures on the legacy or expiry-bearing grant. -/
theorem reachable_upgrade_spends_signed_grant {ctx keys start s w t} (init : Core9.genesis keys = some start)
    (inputs : List Input) (state : run ctx start inputs = s) (tag : w[0]? = some (27 : UInt8))
    (ok : Core9.step ctx w s = some t) :
    ∃ u, Upgrade9.decode w = some u ∧ u.intent.body = .install u.target ∧
      Signed s.base.hybrid.owner u.intent ∧ u.intent ∈ Policy9.pool s.base ∧ u.intent ∉ Policy9.pool t.base := by
  obtain ⟨u, dec, _, installed, _⟩ := Core9.package_admission tag ok
  obtain ⟨_, _, staged, _, body, held, spent⟩ := Upgrade9.admission installed
  have signed := state ▸ history ctx start inputs (initial init)
  exact ⟨u, dec, staged ▸ body, signed u.intent held, held, spent⟩

#print axioms reachable_upgrade_spends_signed_grant
end Aukora.GrantOrigin9
