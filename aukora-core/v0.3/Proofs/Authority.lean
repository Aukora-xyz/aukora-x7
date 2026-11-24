import ReleaseInterface
import Proofs.GrantOrigin
import Proofs.DangerWire
import Proofs.SingleGate

namespace Aukora.Release
open R6.KernelCell (Context)
open private Policy9.ran Policy9.parsed Policy9.bound from Proofs.Policy
open private Policy9.applyBase Policy9.append Policy9.setPool from Policy
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.act Core8.actRoute from Ledger.Assessed
open private Hybrid7.both_of_sig from Hybrid
open private Upgrade9.install_ok from Gate
open private GrantOrigin9.history GrantOrigin9.initial from Proofs.GrantOrigin

abbrev Tracked (w : ByteArray) (c : Policy9.Command) :=
  w[0]? ≠ some (27 : UInt8) ∧ Policy9.decode w = some c

theorem policy_step {ctx w s t c} (cmd : Tracked w c) (ok : newest.step ctx w s = some t) :
    Policy9.step w s = some t := by
  simpa [newest, Core9.step, cmd.1] using ok

def Issued (s : State) (w : ByteArray) (i : Intent) : Prop :=
  (∃ x ed ml, Tracked w (.ordinary x (.signed ml)) ∧ x.action = .grant i ed ∧
    Hybrid7.Both Core8.verifiers (owner s) (Hybrid7.grantMessage (owner s) i) ed ml) ∨
  ∃ p n last ed ml, Tracked w (.issue p n last i ed ml) ∧
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml

def Rebound (s t : State) (w : ByteArray) : Prop :=
  ∃ p n ed ml, Tracked w (.rebind p n (owner t) ed ml) ∧
    Hybrid7.Both Core8.verifiers (owner s) (Hybrid7.rebindMessage (owner s)
      (Policy9.generation s) (owner t)) ed ml

def GrantLaw (m : Ops) : Prop :=
  ∀ ctx w s t i, m.step ctx w s = some t → i ∉ pool s → i ∈ pool t → Issued s w i

def BindingLaw (m : Ops) : Prop :=
  (∀ ctx w s t, m.step ctx w s = some t → owner t ≠ owner s → Rebound s t w) ∧
    ∀ ctx w s t p n keys ed ml, Tracked w (.rebind p n keys ed ml) → m.step ctx w s = some t →
      owner t = keys ∧ Hybrid7.Both Core8.verifiers (owner s)
        (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml

def ControlLaw (m : Ops) : Prop :=
  (∀ ctx w s t x extra op ed, Tracked w (.ordinary x extra) → x.action = .control op ed →
    m.step ctx w s = some t → ∃ ml, extra = .signed ml ∧ Hybrid7.Both Core8.verifiers (owner s)
      (Hybrid7.controlMessage (owner s) (Policy9.generation s) x op) ed ml) ∧
  ∀ ctx w s t p n d ed ml, Tracked w (.cancel p n d ed ml) → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.cancelMessage s p n d) ed ml

private theorem guard_true {b : Bool} {u : Unit} (ok : (guard b : Option Unit) = some u) : b = true := by
  cases b <;> simp_all [guard]

theorem ordinary_policy {s w t x e} (dec : Policy9.decode w = some (.ordinary x e))
    (ok : Policy9.step w s = some t) :
    Hybrid7.authorized Core8.verifiers s.base.hybrid x e = true ∧
      Policy9.append s.base w x.project = some t.base := by
  obtain ⟨_, sig, app⟩ := Policy9.bound (Policy9.ran dec ok).1
  exact ⟨guard_true sig, app⟩

private theorem new_in_bound {s t hash f i} (ok : Bound4.next hash s f = some t)
    (absent : i ∉ s.ledger.book.auth.grants) (held : i ∈ t.ledger.book.auth.grants) :
    f.action = .base (.grant i true) := by
  apply Classical.byContradiction
  intro different
  exact Events4.grant_absent_after (Bound4.accepted ok).2 absent different held

private theorem new_in_append {s w f t i} (ok : Policy9.append s w f = some t)
    (absent : i ∉ Policy9.pool s) (held : i ∈ Policy9.pool t) : f.action = .base (.grant i true) := by
  obtain ⟨inner, applied, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact new_in_bound applied absent held

private theorem new_in_append_inner {s w f t i} (ok : Core8.append s w f = some t)
    (absent : i ∉ Policy9.pool s) (held : i ∈ t.inner.ledger.book.auth.grants) :
    f.action = .base (.grant i true) := by
  obtain ⟨inner, applied, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact new_in_bound applied absent held

private theorem metadata_pool_owner {s w p n label val r t}
    (ok : Core8.metadata s w p n label val r = some t) :
    (∀ i ∈ Policy9.pool t, i ∈ Policy9.pool s) ∧ t.hybrid.owner = s.hybrid.owner := by
  obtain ⟨hy, app, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  refine ⟨?_, ?_⟩
  · intro i held
    by_contra absent
    have bad := new_in_append_inner app absent held
    cases bad
  · obtain ⟨_, _, eq⟩ := Policy9.bound app
    cases Option.some.inj eq
    rfl

private theorem assess_pool_owner {w s t} (ok : Core8.assessment w s = some t) :
    (∀ i ∈ Policy9.pool t, i ∈ Policy9.pool s) ∧ t.hybrid.owner = s.hybrid.owner := by
  obtain ⟨_, _, h⟩ := Policy9.bound ok
  obtain ⟨⟨_, _⟩, _, h⟩ := Policy9.bound h
  obtain ⟨_, _, h⟩ := Policy9.bound h
  exact metadata_pool_owner h

private theorem threshold_pool_owner {w s t} (ok : Core8.thresholdControl w s = some t) :
    (∀ i ∈ Policy9.pool t, i ∈ Policy9.pool s) ∧ t.hybrid.owner = s.hybrid.owner := by
  obtain ⟨_, _, h⟩ := Policy9.bound ok
  obtain ⟨⟨_, _⟩, _, h⟩ := Policy9.bound h
  obtain ⟨_, _, h⟩ := Policy9.bound h
  obtain ⟨_, _, h⟩ := Policy9.bound h
  obtain ⟨_, _, h⟩ := Policy9.bound h
  exact metadata_pool_owner h

private theorem act_pool_owner {w s t} (ok : Core8.act w s = some t) :
    (∀ i ∈ Policy9.pool t, i ∈ Policy9.pool s) ∧ t.hybrid.owner = s.hybrid.owner := by
  obtain ⟨_, _, h⟩ := Policy9.bound ok
  obtain ⟨x, _, h⟩ := Policy9.bound h
  obtain ⟨⟨i, g⟩, route, h⟩ := Policy9.bound h
  obtain ⟨hy, app, h⟩ := Policy9.bound h
  obtain ⟨_, _, eq⟩ := Policy9.bound h
  cases Option.some.inj eq
  refine ⟨?_, ?_⟩
  · intro j held
    by_contra absent
    have ev := new_in_append_inner app absent held
    unfold Core8.actRoute at route
    split at route <;> simp_all [Wire5.Frame.project, Wire5.Action.project]
  · obtain ⟨_, _, eq⟩ := Policy9.bound app
    cases Option.some.inj eq
    rfl

private theorem mapped {s : Option Core8.Machine} {rec : Array ByteArray} {w t}
    (ok : s.map (fun b => {b with record := rec.push w}) = some t) :
    ∃ b, s = some b ∧ t = {b with record := rec.push w} := by
  cases s with
  | none => contradiction
  | some b => exact ⟨b, rfl, (Option.some.inj ok).symm⟩

theorem rebind_policy {s w t p n keys ed ml}
    (dec : Policy9.decode w = some (.rebind p n keys ed ml)) (ok : Policy9.step w s = some t) :
    owner t = keys ∧ Hybrid7.Both Core8.verifiers (owner s)
      (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml := by
  obtain ⟨_, allowed, h⟩ := Policy9.bound (Policy9.ran dec ok).1
  obtain ⟨b, _, eq⟩ := Policy9.bound h
  have sig := guard_true allowed
  change Hybrid7.authorized _ _ ⟨p,n,.rebind keys.ed ed⟩ (.binding keys.ml ml) = true at sig
  simp only [Hybrid7.authorized, Bool.and_eq_true] at sig
  have e := (Option.some.inj eq).symm
  exact ⟨by change t.base.hybrid.owner = _; rw [e], Hybrid7.both_of_sig sig.2⟩

private theorem appended_owner {s w f t} (ok : Policy9.append s w f = some t) :
    t.hybrid.owner = s.hybrid.owner := by
  obtain ⟨_, _, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  rfl

private theorem policy_authority {s w t} (old : w[0]? ≠ some (27 : UInt8))
    (ok : Policy9.step w s = some t) :
    (∀ i, i ∉ pool s → i ∈ pool t → Issued s w i) ∧ (owner t = owner s ∨ Rebound s t w) := by
  obtain ⟨c, dec⟩ := Policy9.parsed ok
  have h := (Policy9.ran dec ok).1
  cases c with
  | ordinary x extra =>
    obtain ⟨authorized, app⟩ := ordinary_policy dec ok
    refine ⟨?_, Or.inl (by have same := appended_owner app; exact same)⟩
    intro i absent held
    have ev := new_in_append app absent held
    left
    cases a : x.action with
    | grant j ed =>
      have jeq : j = i := by simpa [Wire5.Frame.project, Wire5.Action.project, a] using ev
      subst j
      cases extra <;> simp [Hybrid7.authorized, a] at authorized
      exact ⟨x, ed, _, ⟨old, dec⟩, a, Hybrid7.both_of_sig authorized.2⟩
    | plain op =>
      have shape : op = .base (.grant i true) := by simpa [Wire5.Frame.project, Wire5.Action.project, a] using ev
      cases extra <;> simp [Hybrid7.authorized, a, shape, Wire5.plainOK] at authorized
    | rebind => simp [Wire5.Frame.project, Wire5.Action.project, a] at ev
    | control op ed => cases op <;> simp [Wire5.Frame.project, Wire5.Action.project, Wire5.Control.project, a] at ev
  | issue p n last j ed ml =>
    obtain ⟨both, _, _, _, _, _, _, other⟩ := Policy9.issue_effect dec ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    refine ⟨?_, Or.inl (by have same := appended_owner app; exact same)⟩
    intro i absent held
    by_cases eq : i = j
    · subst j; exact Or.inr ⟨p, n, last, ed, ml, ⟨old, dec⟩, both⟩
    · exact False.elim (absent ((other i eq).1.mp held))
  | cancel p n d ed ml =>
    obtain ⟨_, _, _, _, _, _, poolEq, _⟩ := Policy9.revoke_effect dec ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    exact ⟨fun i absent held => False.elim (absent ((poolEq i).mp held).1), Or.inl (by have same := appended_owner app; exact same)⟩
  | report =>
    obtain ⟨_, _, app⟩ := Policy9.bound h
    refine ⟨?_, Or.inl (by have same := appended_owner app; exact same)⟩
    intro i absent held
    cases new_in_append app absent held
  | rebind p n keys ed ml =>
    have empty := (Policy9.rebind_clears dec ok).2.1
    obtain ⟨key, sig⟩ := rebind_policy dec ok
    exact ⟨fun i _ held => by change i ∈ Policy9.pool t.base at held; simp [empty] at held,
      Or.inr ⟨p,n,ed,ml,key ▸ ⟨old, dec⟩,key ▸ sig⟩⟩
  | use i =>
    have eligible := Policy9.use_requires_permission dec ok
    have hm : (Core8.act w s.base).map (fun b => {b with record := s.base.record.push w}) = some t.base := by
      simpa [Policy9.applyBase, eligible] using h
    obtain ⟨_, applied, eq⟩ := mapped hm
    obtain ⟨sub, same⟩ := act_pool_owner applied
    refine ⟨fun j absent held => False.elim (absent (sub j ?_)), Or.inl ?_⟩
    · simpa only [pool, eq] using held
    · simpa only [owner, eq] using same
  | assessment =>
    obtain ⟨_, applied, eq⟩ := mapped h
    obtain ⟨sub, same⟩ := assess_pool_owner applied
    refine ⟨fun j absent held => False.elim (absent (sub j ?_)), Or.inl ?_⟩
    · simpa only [pool, eq] using held
    · simpa only [owner, eq] using same
  | threshold =>
    obtain ⟨_, applied, eq⟩ := mapped h
    obtain ⟨sub, same⟩ := threshold_pool_owner applied
    refine ⟨fun j absent held => False.elim (absent (sub j ?_)), Or.inl ?_⟩
    · simpa only [pool, eq] using held
    · simpa only [owner, eq] using same

private theorem authority_step {ctx w s t} (ok : newest.step ctx w s = some t) :
    (∀ i, i ∉ pool s → i ∈ pool t → Issued s w i) ∧ (owner t = owner s ∨ Rebound s t w) := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨u, _, _, installed, _⟩ := Core9.package_admission tag ok
    obtain ⟨_, _, h⟩ := Policy9.bound installed
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨inner, applied, eq⟩ := Policy9.bound h
    have hy := (Option.some.inj eq).symm
    refine ⟨?_, Or.inl (by change t.base.hybrid.owner = _; rw [hy])⟩
    intro i absent held
    have held' : i ∈ inner.ledger.book.auth.grants := by
      change i ∈ t.base.hybrid.inner.ledger.book.auth.grants at held
      simpa [hy] using held
    have ev := new_in_bound applied absent held'
    cases ev
  · exact policy_authority tag (by simpa [newest, Core9.step, tag] using ok)

theorem newest_grant : GrantLaw newest := fun _ _ _ _ i ok => (authority_step ok).1 i

theorem newest_binding : BindingLaw newest :=
  ⟨fun _ _ _ _ ok changed => ((authority_step ok).2.resolve_left changed),
    fun _ _ _ _ _ _ _ _ _ cmd ok => rebind_policy cmd.2 (policy_step cmd ok)⟩

theorem newest_control : ControlLaw newest := by
  constructor
  · intro ctx w s t x e op ed cmd act ok
    have allowed := (ordinary_policy cmd.2 (policy_step cmd ok)).1
    cases e <;> simp [Hybrid7.authorized, act] at allowed
    exact ⟨_, rfl, Hybrid7.both_of_sig allowed.2⟩
  · intro ctx w s t p n d ed ml cmd ok
    exact (Policy9.revoke_effect cmd.2 (policy_step cmd ok)).1

theorem reachable_grants {keys start} (init : newest.genesis keys = some start) (ctx xs) :
    ∀ i ∈ pool (run newest ctx start xs), GrantOrigin9.Signed (owner (run newest ctx start xs)) i := by
  rw [newest_run]
  exact GrantOrigin9.history ctx start xs (GrantOrigin9.initial init)

end Aukora.Release
