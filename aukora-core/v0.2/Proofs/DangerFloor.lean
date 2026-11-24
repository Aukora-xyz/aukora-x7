import Proofs.DangerWire
import Proofs.Stamp

namespace Aukora.Floor8
open R6.KernelCell (Context)
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.actRoute Core8.act
  Core8.dispatch from Ledger.Assessed

private abbrev Reach (p q : Context) (h : Hybrid7.Machine) := Risk8.Reach Core8.verifiers p q h

private theorem append_preserves {p q s wire x h} (before : Reach p q s.hybrid)
    (ok : Core8.append s wire x = some h)
    (plain : ∀ i, x.action ≠ .base (.grant i true)) : Reach p q h := by
  unfold Core8.append at ok
  obtain ⟨inner, appended, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  apply Risk8.Reach.preserve (h' := ⟨inner, s.hybrid.owner⟩) before rfl
  intro i available
  apply Classical.byContradiction
  intro absent
  exact Events4.grant_absent_after (Bound4.accepted appended).2 absent (plain i) available

private theorem metadata_reach {p q s wire parent seq label val risk t} (before : Reach p q s.hybrid)
    (ok : Core8.metadata s wire parent seq label val risk = some t) : Reach p q t.hybrid := by
  unfold Core8.metadata at ok
  obtain ⟨h, app, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  exact append_preserves before app (by intro i; simp)

private theorem assessment_reach {p q wire s t} (before : Reach p q s.hybrid)
    (ok : Core8.assessment wire s = some t) : Reach p q t.hybrid := by
  unfold Core8.assessment at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨⟨parent,seq⟩, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨score, _, h⟩ := Option.bind_eq_some.mp h
  exact metadata_reach before h

private theorem threshold_reach {p q wire s t} (before : Reach p q s.hybrid)
    (ok : Core8.thresholdControl wire s = some t) : Reach p q t.hybrid := by
  unfold Core8.thresholdControl at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨⟨parent,seq⟩, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨level, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨r, _, h⟩ := Option.bind_eq_some.mp h
  exact metadata_reach before h

private theorem act_not_grant {x i route} (selected : Core8.actRoute x = some (i, route)) (j : Intent) :
    x.project.action ≠ .base (.grant j true) := by
  unfold Core8.actRoute at selected
  split at selected <;> simp_all [Wire5.Frame.project, Wire5.Action.project]

private theorem act_reach {p q wire s t} (before : Reach p q s.hybrid)
    (ok : Core8.act wire s = some t) : Reach p q t.hybrid := by
  unfold Core8.act at ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp ok
  obtain ⟨x, _, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨⟨i,route⟩, selected, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨hybrid, app, h⟩ := Option.bind_eq_some.mp h
  obtain ⟨r, _, eq⟩ := Option.bind_eq_some.mp h
  cases Option.some.inj eq
  exact append_preserves before app (act_not_grant selected)

/-- Every accepted byte frame either uses the hybrid transition or preserves the owner
    and introduces no unspent grant. Applies at every threshold and assessment. -/
theorem step_reachable {p q wire s t} (before : Reach p q s.hybrid)
    (ok : Core8.step p q wire s = some t) : Reach p q t.hybrid := by
  unfold Core8.step at ok
  obtain ⟨next, dispatch, eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  change Reach p q next.hybrid
  unfold Core8.dispatch at dispatch
  obtain ⟨tag, _, branch⟩ := Option.bind_eq_some.mp dispatch
  split at branch
  · exact assessment_reach before branch
  · exact threshold_reach before branch
  · exact act_reach before branch
  · obtain ⟨req, _, h⟩ := Option.bind_eq_some.mp branch
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    obtain ⟨h', accepted, eq⟩ := Option.bind_eq_some.mp h
    cases Option.some.inj eq
    exact Risk8.Reach.submit before accepted

/-- Finite executions through the Core8 byte, staging and refusal entry points. -/
inductive Run (p q : Context) : Core8.Machine → Prop where
  | init {keys s} (ok : Core8.genesis keys = some s) : Run p q s
  | feed {s} (before : Run p q s) (chunk : ByteArray) : Run p q (Core8.feed chunk s)
  | reset {s} (before : Run p q s) : Run p q (Core8.reset s)
  | stamp {s wire} (before : Run p q s) : Run p q ((Core8.stamp wire s).getD s)
  | submit {s wire} (before : Run p q s) : Run p q ((Core8.step p q wire s).getD s)

theorem run_reachable {p q s} (run : Run p q s) : Reach p q s.hybrid := by
  induction run with
  | init h =>
    unfold Core8.genesis at h
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    obtain ⟨_, init, eq⟩ := Option.bind_eq_some.mp h
    cases Option.some.inj eq
    exact Risk8.Reach.genesis init
  | feed _ _ ih | reset _ ih => exact Risk8.Reach.preserve ih rfl (fun _ mem => mem)
  | @stamp s wire before ih =>
    cases ok : Core8.stamp wire s with
    | none => exact ih
    | some t =>
      change Reach p q t.hybrid
      rw [(Stamp8.preserves_authority_and_history ok).1]
      exact ih
  | @submit s wire before ih =>
    cases ok : Core8.step p q wire s with
    | none => exact ih
    | some t => exact step_reachable ih ok

/-- Every unspent grant in an actual Core8 byte-command history has both valid signatures
    over its exact intent under the current key pair. -/
theorem wire_grants_signed {p q s} (run : Run p q s) (i : Intent) (held : i ∈ Risk8.pool s.hybrid) :
    ∃ ed ml, Hybrid7.Both Core8.verifiers s.hybrid.owner (Hybrid7.grantMessage s.hybrid.owner i) ed ml :=
  Risk8.grants_have_signatures (run_reachable run) i held

open private RiskWire8.submitted RiskWire8.act_ok from Proofs.DangerWire

private theorem legacy_tag {wire r} (request : Core8.request wire = some r) :
    ∃ tag : UInt8, wire[0]? = some tag ∧ (tag = 0 ∨ tag = 19 ∨ tag = 20) := by
  unfold Core8.request at request
  obtain ⟨tag, tagged, branch⟩ := Option.bind_eq_some.mp request
  split at branch
  · exact ⟨0, tagged, Or.inl rfl⟩
  · exact ⟨19, tagged, Or.inr (Or.inl rfl)⟩
  · exact ⟨20, tagged, Or.inr (Or.inr rfl)⟩
  · contradiction

private theorem legacy_step {p q wire r s t} (request : Core8.request wire = some r)
    (ok : Core8.step p q wire s = some t) : Hybrid7.step Core8.verifiers p q r s.hybrid = some t.hybrid := by
  obtain ⟨u, dispatch, hy, _, _⟩ := RiskWire8.submitted ok
  rw [hy]
  obtain ⟨tag, tagged, kind⟩ := legacy_tag request
  obtain ⟨actual, hit, branch⟩ := Option.bind_eq_some.mp dispatch
  have tagEq := Option.some.inj (tagged.symm.trans hit)
  subst actual
  rcases kind with h | h | h <;> subst tag
  all_goals
    obtain ⟨req, dec, h⟩ := Option.bind_eq_some.mp branch
    have same := Option.some.inj (request.symm.trans dec)
    subst req
    obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp h
    obtain ⟨next, accepted, eq⟩ := Option.bind_eq_some.mp h
    cases Option.some.inj eq
    exact accepted

/-- A certified installation on any reachable Core8 state consumed the exact grant
    authorized by both current keys and checked the proof for its manifest entry. -/
theorem wire_upgrade_floor {p q wire s t r u} (run : Run p q s) (ok : Core8.step p q wire s = some t)
    (request : Core8.request wire = some r) (up : Upgrade7.decode r.wire = some (.certified u)) :
    (∃ ed ml, Hybrid7.Both Core8.verifiers s.hybrid.owner (Hybrid7.grantMessage s.hybrid.owner u.intent) ed ml) ∧
    u.intent ∈ Risk8.pool s.hybrid ∧ u.intent ∉ Risk8.pool t.hybrid ∧
    ∃ e, Upgrade7.lookup u.target = some e ∧ R6.KernelCell.check (e.context p q) u.proof = true :=
  Risk8.upgrade_floor (run_reachable run) up (legacy_step request ok)

/-- A rebind through the byte entry point has both old signatures on the specified
    replacement pair, whatever the current danger threshold and assessments. -/
theorem wire_rebind_floor {p q wire s t r x newEd ed} (ok : Core8.step p q wire s = some t)
    (request : Core8.request wire = some r) (dec : Upgrade7.decode r.wire = some (.ordinary x))
    (rebind : x.action = .rebind newEd ed) :
    ∃ newML ml, r.extra = .binding newML ml ∧ Hybrid7.Both Core8.verifiers s.hybrid.owner
      (Hybrid7.rebindMessage s.hybrid.owner (Hybrid7.generation s.hybrid) ⟨newEd, newML⟩) ed ml :=
  Risk8.rebind_floor dec (legacy_step request ok) rebind

private theorem exact_route {x i} (h : Core8.actRoute x = some (i, true)) :
    x.project.action = .base (.act i) := by
  unfold Core8.actRoute at h
  split at h <;> simp_all [Wire5.Frame.project, Wire5.Action.project]

/-- For an actual accepted delivery at or above threshold, the decoded intent was
    funded by a dual-signed grant in this command history. This step consumed it. -/
theorem high_act_spends_signed_grant {p q wire s t} (run : Run p q s)
    (ok : Core8.step p q wire s = some t) (tag : wire[0]? = some (23 : UInt8)) :
    ∃ x i g, Wire5.decode (wire.extract 33 wire.size) = some x ∧ Core8.actRoute x = some (i,g) ∧
      (s.risk.threshold.toNat ≤ (Risk8.effective s.risk (Risk8.intentDigest i)).score.toNat →
        g = true ∧ i ∈ Risk8.pool s.hybrid ∧ i ∉ Risk8.pool t.hybrid ∧
          ∃ ed ml, Hybrid7.Both Core8.verifiers s.hybrid.owner (Hybrid7.grantMessage s.hybrid.owner i) ed ml) := by
  obtain ⟨u, dispatch, hy, _, _⟩ := RiskWire8.submitted ok
  have accepted : Core8.act wire s = some u := by simpa [Core8.dispatch, tag] using dispatch
  obtain ⟨x, i, g, dec, route, bound, risk⟩ := RiskWire8.act_ok accepted
  refine ⟨x, i, g, dec, route, ?_⟩
  intro high
  have useGrant : g = true := by
    cases g
    · simp [Risk8.act, Risk8.admit, Risk8.allowAt, Nat.not_lt.mpr high] at risk
    · rfl
  subst g
  have action := exact_route route
  obtain ⟨allowed, ledger⟩ := R2.next_spec (Bound4.accepted bound).2
  have eligible : Eligible s.hybrid.inner.ledger.book (.act i) := by
    simpa [R2.policy, action] using allowed.2.2.1
  have held : i ∈ Risk8.pool s.hybrid := by
    have fresh := eligible.1
    simp [spendOK, spendIntent] at fresh
    exact fresh.1
  refine ⟨rfl, held, ?_, wire_grants_signed run i held⟩
  rw [hy]
  unfold Risk8.pool
  rw [ledger]
  simp [R2.append, R2.nextBook, action, advance, changeAuth, spend]

#print axioms wire_upgrade_floor
#print axioms wire_rebind_floor
#print axioms high_act_spends_signed_grant
#print axioms step_reachable
#print axioms run_reachable
#print axioms wire_grants_signed
end Aukora.Floor8
