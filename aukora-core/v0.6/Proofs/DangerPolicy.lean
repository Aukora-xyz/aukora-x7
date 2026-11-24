import Proofs.Authority
import Proofs.Stamp
import Proofs.Spending

namespace Aukora.Release
open R6.KernelCell (Context)
open private Policy9.applyBase Policy9.append from Policy
open private Policy9.ran Policy9.parsed Policy9.bound from Proofs.Policy
open private Core8.act Core8.actRoute Core8.append Core8.dispatch Core8.thresholdControl Core8.assessment Core8.slice from Ledger.Assessed
open private RiskWire8.submitted RiskWire8.metadata_ok RiskWire8.act_ok RiskWire8.assessment_threshold RiskWire8.act_threshold from Proofs.DangerWire
open private Upgrade9.install_ok from Gate
open private mapped from Proofs.Authority

abbrev Tagged (w : ByteArray) (t : UInt8) := w[0]? = some t

def atScore (s : State) (d : Digest) (v : UInt8) (b : Digest) : State :=
  {s with base.risk := Risk8.assess s.base.risk d v b}

def MonotoneLaw (m : Ops) : Prop :=
  ∀ ctx w s i (low high : UInt8) bundle, Tagged w 23 → Tracked w (.use i) → low.toNat ≤ high.toNat →
    m.step ctx w (atScore s (Risk8.intentDigest i) low bundle) = none →
    m.step ctx w (atScore s (Risk8.intentDigest i) high bundle) = none

private theorem use_formula {ctx w s i} (cmd : Tracked w (.use i)) :
    (newest.step ctx w s).isSome =
      (Policy9.grantOK s i && (Core8.act w s.base).isSome) := by
  simp [newest, Core9.step, cmd.1, Policy9.step, cmd.2, Policy9.submit, Policy9.applyBase]
  split <;> cases Core8.act w s.base <;> simp_all

private theorem act_present {w x i g} (s : Core8.Machine)
    (dec : Wire5.decode (w.extract 33 w.size) = some x) (route : Core8.actRoute x = some (i,g)) :
    (Core8.act w s).isSome =
      (decide (33 ≤ w.size) && (Core8.append s w x.project).isSome &&
        (Risk8.act s.risk (Risk8.intentDigest i) ⟨Core8.slice w 1 33⟩ g (!g)).isSome) := by
  by_cases size : 33 ≤ w.size
  · cases ap : Core8.append s w x.project <;> cases risk : Risk8.act s.risk (Risk8.intentDigest i)
      ⟨Core8.slice w 1 33⟩ g (!g) <;> simp [Core8.act, guard, size, dec, route, ap, risk]
  · simp [Core8.act, guard, size]

private theorem route_of_tag {w c} (tag : Tagged w 23) (dec : Policy9.decode w = some c) :
    ∃ x i g, c = .use i ∧ Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (i,g) := by
  have h : (do
      let x ← Wire5.decode (w.extract 33 w.size)
      match x.action with
      | .plain (.base (.act i)) | .plain (.useMandate _ (.act i)) => return Policy9.Command.use i
      | _ => none) = some c := by simpa [Policy9.decode, tag] using dec
  obtain ⟨x, decx, branch⟩ := Policy9.bound h
  split at branch
  · rename_i j action
    exact ⟨x, j, true, (Option.some.inj branch).symm, decx, by simp [Core8.actRoute, action]⟩
  · rename_i id j action
    exact ⟨x, j, false, (Option.some.inj branch).symm, decx, by simp [Core8.actRoute, action]⟩
  · contradiction

private theorem none_of_isSome {o : Option α} (h : o.isSome = false) : o = none := by cases o <;> simp_all

theorem newest_monotone : MonotoneLaw newest := by
  intro ctx w s i low high b tag cmd le refused
  obtain ⟨x,j,g,eq,dec,route⟩ := route_of_tag tag cmd.2
  cases Policy9.Command.use.inj eq
  have lowRef : (newest.step ctx w (atScore s (Risk8.intentDigest i) low b)).isSome = false := by simp [refused]
  rw [use_formula cmd, act_present _ dec route] at lowRef
  apply none_of_isSome
  rw [use_formula cmd, act_present _ dec route]
  change (_ && (_ && _ && (Risk8.act (Risk8.assess s.base.risk _ high b) _ _ g (!g)).isSome)) = false
  change (_ && (_ && _ && (Risk8.act (Risk8.assess s.base.risk _ low b) _ _ g (!g)).isSome)) = false at lowRef
  by_cases active : (Risk8.act (Risk8.assess s.base.risk (Risk8.intentDigest i) low b)
    (Risk8.intentDigest i) ⟨Core8.slice w 1 33⟩ g (!g)).isSome = true
  · simp [active] at lowRef
    simp only [Bool.and_eq_false_imp]
    intro granted
    simp only [Bool.and_eq_true, decide_eq_true_eq]
    rintro ⟨size, possible⟩
    have no : Core8.append (atScore s (Risk8.intentDigest i) high b).base w x.project = none :=
      lowRef granted size
    simp [no] at possible
  · have noLow := none_of_isSome (Bool.eq_false_iff.mpr active)
    have noHigh := Risk8.monotone le noLow
    simp [noHigh]

theorem act_link {ctx w s t} (tag : Tagged w 23) (ok : newest.step ctx w s = some t) :
    Core8.step ctx ctx w s.base = some t.base := by
  have old : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
  have policy : Policy9.step w s = some t := by simpa [newest, Core9.step, old] using ok
  obtain ⟨cmd, dec⟩ := Policy9.parsed policy
  obtain ⟨_, i, _, rfl, _⟩ := route_of_tag tag dec
  have base := (Policy9.ran dec policy).1
  have eligible := Policy9.use_requires_permission dec policy
  cases hit : Core8.act w s.base <;> simpa [Core8.step, Core8.dispatch, tag, Policy9.applyBase, eligible, hit] using base

def ThresholdLaw (m : Ops) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → t.base.risk.threshold ≠ s.base.risk.threshold →
    Tracked w .threshold ∧ w[41]? = some t.base.risk.threshold ∧
    Hybrid7.Both Core8.verifiers (owner s) (Risk8.thresholdMessage (owner s)
      (Policy9.generation s) (ledger s).head (Policy9.nextSeq s) t.base.risk.threshold)
        (Core8.slice w 42 106) (Core8.slice w 106 w.size)

private theorem same_risk {s w f t} (ok : Policy9.append s w f = some t) : t.risk = s.risk := by
  obtain ⟨_, _, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  rfl

private theorem classified_threshold {w s t} (policy : Policy9.step w s = some t)
    (changed : t.base.risk.threshold ≠ s.base.risk.threshold) :
    Policy9.decode w = some .threshold ∧ w[41]? = some t.base.risk.threshold ∧
      Hybrid7.Both Core8.verifiers (owner s) (Risk8.thresholdMessage (owner s)
        (Policy9.generation s) (ledger s).head (Policy9.nextSeq s) t.base.risk.threshold)
          (Core8.slice w 42 106) (Core8.slice w 106 w.size) := by
  obtain ⟨cmd, dec⟩ := Policy9.parsed policy
  have h := (Policy9.ran dec policy).1
  cases cmd with
  | ordinary x e =>
    exact False.elim (changed (congrArg Risk8.State.threshold (same_risk (ordinary_policy dec policy).2)))
  | rebind =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨b, app, eq⟩ := Policy9.bound h
    have same := congrArg Risk8.State.threshold (same_risk app)
    exact False.elim (changed (by rw [← Option.some.inj eq]; exact same))
  | report =>
    obtain ⟨_, _, app⟩ := Policy9.bound h
    have same := congrArg Risk8.State.threshold (same_risk app)
    exact False.elim (changed same)
  | issue =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    have same := congrArg Risk8.State.threshold (same_risk app)
    exact False.elim (changed same)
  | cancel =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, app⟩ := Policy9.bound h
    have same := congrArg Risk8.State.threshold (same_risk app)
    exact False.elim (changed same)
  | use i =>
    have permitted := Policy9.use_requires_permission dec policy
    simp only [Policy9.applyBase, permitted, if_true] at h
    obtain ⟨b, run, eq⟩ := mapped h
    exact False.elim (changed (by rw [eq]; exact RiskWire8.act_threshold (t := b) run))
  | assessment =>
    simp only [Policy9.applyBase] at h
    obtain ⟨b, run, eq⟩ := mapped h
    exact False.elim (changed (by rw [eq]; exact RiskWire8.assessment_threshold (t := b) run))
  | threshold =>
    simp only [Policy9.applyBase] at h
    obtain ⟨b, applied, eq⟩ := mapped h
    obtain ⟨_, _, h⟩ := Policy9.bound applied
    obtain ⟨⟨p,n⟩, _, h⟩ := Policy9.bound h
    obtain ⟨level, levelAt, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨next, signed, app⟩ := Policy9.bound h
    obtain ⟨nextEq, parentEq, seqEq⟩ := RiskWire8.metadata_ok app
    rw [eq] at changed ⊢
    change b.risk.threshold ≠ _ at changed
    rw [nextEq] at changed
    obtain ⟨ed, ml, same, both⟩ := Risk8.threshold_changes_only_signed
      (event := .control level (Core8.slice w 42 106) (Core8.slice w 106 w.size)) signed changed
    cases same
    exact ⟨dec, by simpa [nextEq] using levelAt, by simpa [nextEq, parentEq, seqEq] using both⟩

theorem newest_threshold : ThresholdLaw newest := by
  intro ctx w s t ok changed
  by_cases tag : Tagged w 27
  · unfold newest Core9.step at ok
    simp only [tag, ne_eq, not_true_eq_false, Bool.false_eq_true, if_false] at ok
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, eq⟩ := Policy9.bound h
    cases Option.some.inj eq
    exact False.elim (changed rfl)
  · have pol : Policy9.step w s = some t := by simpa [newest, Core9.step, tag] using ok
    obtain ⟨dec, atLevel, both⟩ := classified_threshold pol changed
    exact ⟨⟨tag, dec⟩, atLevel, both⟩

def BundleLaw (m : Ops) : Prop :=
  ∀ ctx w s t, Tagged w 23 → m.step ctx w s = some t →
    ∃ x i g, Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (i,g) ∧
      Bound4.next (fun _ => Bound4.digest w) s.base.hybrid.inner x.project = some t.base.hybrid.inner ∧
      let d := Risk8.intentDigest i
      let named := Digest.mk (Core8.slice w 1 33)
      named = (Risk8.effective s.base.risk d).bundle ∧
      t.base.risk.admissions = ⟨d, (Risk8.effective s.base.risk d).score, named, (Risk8.lookup s.base.risk d).isNone⟩ ::
        s.base.risk.admissions ∧ t.base.record = s.base.record.push w

theorem newest_bundle : BundleLaw newest := fun _ _ _ _ tag ok =>
  RiskWire8.admitted_wire_names_bundle (act_link tag ok) tag

def MissingLaw (m : Ops) : Prop :=
  ∀ ctx w s t, Tagged w 23 → m.step ctx w s = some t →
    ∃ x i g, Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (i,g) ∧
      let d := Risk8.intentDigest i
      Risk8.lookup s.base.risk d = none →
        g = true ∧ Digest.mk (Core8.slice w 1 33) = Risk8.defaultBundle d ∧
        t.base.risk.admissions = ⟨d,255,Risk8.defaultBundle d,true⟩ :: s.base.risk.admissions

theorem newest_missing : MissingLaw newest := by
  intro ctx w s t tag ok
  have submit := act_link tag ok
  obtain ⟨b, dispatch, _, risk, _⟩ := RiskWire8.submitted submit
  have act : Core8.act w s.base = some b := by simpa [Core8.dispatch, tag] using dispatch
  obtain ⟨x,i,g,dec,route,_,riskOK⟩ := RiskWire8.act_ok act
  refine ⟨x,i,g,dec,route,?_⟩
  dsimp only
  intro missing
  obtain ⟨exactRoute, bundle⟩ := Risk8.missing_requires_exact missing riskOK
  have entry := (Risk8.admitted_names_assessment riskOK).2
  have top := Risk8.missing_is_highest missing
  exact ⟨exactRoute, bundle, by simpa [risk, top, bundle, missing] using entry⟩

/-- At any score, installations spend a currently signed exact grant, and rebinds need both old keys. High deliveries spend an exact signed grant. -/
def FloorLaw (m : Ops) (start : State) : Prop :=
  (∀ ctx xs w t, let s := run m ctx start xs
    Tagged w 27 → m.step ctx w s = some t → ∃ u, Upgrade9.decode w = some u ∧
      u.intent.body = .install u.target ∧ GrantOrigin9.Signed (owner s) u.intent ∧
      u.intent ∈ pool s ∧ u.intent ∉ pool t) ∧
  (∀ ctx w s t p n keys ed ml, Tracked w (.rebind p n keys ed ml) → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml) ∧
  ∀ ctx xs w t, let s := run m ctx start xs
    Tagged w 23 → m.step ctx w s = some t → ∃ x i g,
      Wire5.decode (w.extract 33 w.size) = some x ∧ Core8.actRoute x = some (i,g) ∧
      (s.base.risk.threshold.toNat ≤ (Risk8.effective s.base.risk (Risk8.intentDigest i)).score.toNat →
        g = true ∧ i ∈ pool s ∧ i ∉ pool t ∧ GrantOrigin9.Signed (owner s) i)

theorem newest_floor {key start} (init : newest.genesis key = some start) : FloorLaw newest start := by
  refine ⟨?_, fun ctx w s t p n ks ed ml cmd ok => (newest_binding.2 ctx w s t p n ks ed ml cmd ok).2, ?_⟩
  · intro ctx xs w t
    dsimp only
    intro tag ok
    exact GrantOrigin9.reachable_upgrade_spends_signed_grant init xs (newest_run ctx start xs).symm tag ok
  · intro ctx xs w t
    dsimp only
    let s := run newest ctx start xs
    intro tag ok
    obtain ⟨b, dispatch, _, _, _⟩ := RiskWire8.submitted (act_link tag ok)
    have act : Core8.act w s.base = some b := by simpa [Core8.dispatch, tag] using dispatch
    obtain ⟨x,i,g,dec,route,_,riskOK⟩ := RiskWire8.act_ok act
    refine ⟨x,i,g,dec,route,?_⟩
    intro high
    have exactGrant : g = true := by
      cases g
      · simp [Risk8.act, Risk8.admit, Risk8.allowAt, Nat.not_lt.mpr high, s] at riskOK
      · rfl
    subst g
    have ev : x.project.action = .base (.act i) := by
      unfold Core8.actRoute at route
      split at route <;> simp_all [Wire5.Frame.project, Wire5.Action.project]
    have old : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
    have decCmd : Policy9.decode w = some (.use i) := by
      unfold Core8.actRoute at route
      split at route <;> simp_all [Policy9.decode]
    obtain ⟨held,_,_,spent,_⟩ := newest_once ctx w s t i ok (Or.inl ⟨⟨old,decCmd⟩,x,dec,ev⟩)
    exact ⟨rfl, held, spent, reachable_grants init ctx xs i held⟩

end Aukora.Release
