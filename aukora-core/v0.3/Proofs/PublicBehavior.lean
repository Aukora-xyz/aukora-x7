import Proofs.Authority
import Proofs.History
import Proofs.Stamp

namespace Aukora.Release
open R6.KernelCell (Context)
open private Core8.append Core8.metadata Core8.assessment Core8.actRoute Core8.slice from Ledger.Assessed
open private Policy9.ran Policy9.parsed Policy9.bound from Proofs.Policy
open private Policy9.applyBase Policy9.append from Policy
open private Upgrade9.install_ok from Gate
open private Core9PolicyLaws.stamped from Proofs.PublicPolicy
open private mapped from Proofs.Authority

/-- Filtering only drops refused frames and stamps. Staging commands are retained. -/
def kept (m : Ops) (ctx : Context) (s : State) : List Input → List Input
  | [] => []
  | c :: cs =>
    let tail := kept m ctx (execute m ctx s c) cs
    match c with
    | .frame w => if (m.step ctx w s).isSome then c :: tail else tail
    | .stamp w => if (m.stamp w s).isSome then c :: tail else tail
    | _ => c :: tail

def ReplayLaw (m : Ops) : Prop :=
  (∀ ctx s xs, run m ctx s (kept m ctx s xs) = run m ctx s xs) ∧
    (∀ s b, m.feed b s = {s with base.hybrid.inner.candidate := s.base.hybrid.inner.candidate ++ b}) ∧
    ∀ s, m.reset s = {s with base.hybrid.inner.candidate := ByteArray.empty}

theorem newest_replay : ReplayLaw newest := by
  refine ⟨?_, fun _ _ => rfl, fun _ => rfl⟩
  intro ctx s xs
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | feed | reset => exact ih _
    | frame w =>
      cases h : newest.step ctx w s with
      | none => simpa [kept, run, execute, h] using ih s
      | some t => simpa [kept, run, execute, h] using ih t
    | stamp w =>
      cases h : newest.stamp w s with
      | none => simpa [kept, run, execute, h] using ih s
      | some t => simpa [kept, run, execute, h] using ih t

inductive PassiveWire (w : ByteArray) : Prop where
  | ordinary {x extra e} : Tracked w (.ordinary x extra) → x.project.action = .base e → Passive e → PassiveWire w
  | report {p n i v fix} : Tracked w (.report p n i v fix) → PassiveWire w
  | assess : Tracked w .assessment → PassiveWire w

def PassiveLaw (m : Ops) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → PassiveWire w → auth t = auth s ∧ t.rules = s.rules

private theorem book_passive (b : Book) {f : R2.Frame} {e : Event} (ev : f.action = .base e)
    (passive : Passive e) : (R2.nextBook b f.action).auth = b.auth := by
  rw [ev]
  cases e <;> simp_all [Passive, R2.nextBook, advance, changeAuth]

private theorem append_passive {s w f t e} (ok : Policy9.append s w f = some t)
    (ev : f.action = .base e) (passive : Passive e) :
    (t.hybrid.owner, t.hybrid.inner.ledger.book.auth) = (s.hybrid.owner, s.hybrid.inner.ledger.book.auth) := by
  obtain ⟨next, inner, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  have hh := (R2.next_spec (Bound4.accepted inner).2).2
  exact Prod.ext rfl (by change next.ledger.book.auth = _; rw [hh]; exact book_passive _ ev passive)

private theorem assess_passive {s w t} (ok : Core8.assessment w s = some t) :
    (t.hybrid.owner, t.hybrid.inner.ledger.book.auth) = (s.hybrid.owner, s.hybrid.inner.ledger.book.auth) := by
  obtain ⟨_, _, h⟩ := Policy9.bound ok
  obtain ⟨⟨p,n⟩, _, h⟩ := Policy9.bound h
  obtain ⟨v, _, h⟩ := Policy9.bound h
  obtain ⟨hy, app, eq⟩ := Policy9.bound h
  obtain ⟨inner, step, same⟩ := Policy9.bound app
  cases Option.some.inj eq
  cases Option.some.inj same
  have hh := (R2.next_spec (Bound4.accepted step).2).2
  exact Prod.ext rfl (by change inner.ledger.book.auth = _; rw [hh]; rfl)

theorem newest_passive : PassiveLaw newest := by
  intro ctx w s t ok frame
  cases frame with
  | ordinary cmd ev plain =>
    have pol := policy_step cmd ok
    have app := (ordinary_policy cmd.2 pol).2
    exact ⟨append_passive app ev plain, (Policy9.ran cmd.2 pol).2.1⟩
  | report cmd =>
    obtain ⟨h, rules, _⟩ := Policy9.ran cmd.2 (policy_step cmd ok)
    obtain ⟨_, _, app⟩ := Policy9.bound h
    exact ⟨append_passive app rfl trivial, rules⟩
  | assess cmd =>
    obtain ⟨h, rules, _⟩ := Policy9.ran cmd.2 (policy_step cmd ok)
    obtain ⟨b, act, eq⟩ := mapped h
    exact ⟨by change (t.base.hybrid.owner, t.base.hybrid.inner.ledger.book.auth) = _; rw [eq]; exact assess_passive (t := b) act,
      rules⟩

def StampLaw (m : Ops) : Prop :=
  ∀ w s t, m.stamp w s = some t →
    (∃ beacon receipt, Core8.decodeStamp w = some ((ledger s).head, beacon, receipt)) ∧
      t = {s with base.stamps := s.base.stamps.push w}

theorem newest_stamp : StampLaw newest := by
  intro w s t ok
  cases got : Core8.stamp w s.base with
  | none => simp [newest, Core9.stamp, got] at ok
  | some b =>
    have eq : {s with base := b} = t := by simpa [newest, Core9.stamp, got] using ok
    obtain ⟨parsed, step⟩ := Stamp8.accepted got
    exact ⟨parsed, by rw [← eq, step]⟩

def UpgradeLaw (m : Ops) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → (ledger t).book.auth.core ≠ (ledger s).book.auth.core →
    w[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode w = some u ∧
      Checker9.check ctx u.model u.proof = true ∧ Policy9.grantOK s u.intent = true ∧
      ModelSection9.read s.base.hybrid.inner.candidate = some (Bound4.digest u.model) ∧
      u.target = (ledger t).book.auth.core ∧ (ledger t).book.auth.core = Bound4.digest s.base.hybrid.inner.candidate ∧
      u.intent.body = .install u.target ∧ u.intent ∈ pool s ∧ u.intent ∉ pool t ∧
      ∀ approved, u.intent.body = .install (Bound4.digest approved) →
        (Bound4.digest s.base.hybrid.inner.candidate = Bound4.digest approved → s.base.hybrid.inner.candidate = approved) →
        s.base.hybrid.inner.candidate = approved

theorem newest_upgrade : UpgradeLaw newest := by
  intro ctx w s t ok changed
  obtain ⟨tag, _, _, _⟩ := OnlyGate9.core_change_requires_package ok changed
  obtain ⟨u, dec, eligible, run, _⟩ := Core9.package_admission tag ok
  obtain ⟨commitment, checked, staged, core, body, held, spent⟩ := Upgrade9.admission run
  exact ⟨tag, u, dec, checked, eligible, commitment, staged.symm.trans core.symm, core, staged ▸ body,
    held, spent, fun approved body' collision => collision (Body.install.inj (body.symm.trans body'))⟩

private theorem generations_step {ctx w s t} (ok : newest.step ctx w s = some t) :
    Policy9.generation s ≤ Policy9.generation t := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨_, _, _, run, _⟩ := Core9.package_admission tag ok
    exact Nat.le_of_eq (Upgrade9.install_clocks run).1.symm
  · exact (Policy9.clocks (by simpa [newest, Core9.step, tag] using ok)).1

theorem generation_run (ctx s xs) : Policy9.generation s ≤ Policy9.generation (run newest ctx s xs) := by
  induction xs generalizing s with
  | nil => exact Nat.le_refl _
  | cons c cs ih =>
    apply Nat.le_trans _ (ih (execute newest ctx s c))
    cases c with
    | frame w =>
      cases ok : newest.step ctx w s with
      | none => simp [execute, ok]
      | some t => simpa [execute, ok] using generations_step ok
    | reset | feed => exact Nat.le_refl _
    | stamp w =>
      cases ok : newest.stamp w s with
      | none => simp [execute, ok]
      | some t => simp [execute, ok, (newest_stamp w s t ok).2, Policy9.generation]

def RestoreLaw (m : Ops) : Prop :=
  ∀ ctx w s t p n keys ed ml, Tracked w (.rebind p n keys ed ml) → m.step ctx w s = some t →
    t.rules = [] ∧ pool t = [] ∧ Policy9.generation t = Policy9.generation s + 1 ∧
    ∀ xs later i, i.generation ≤ Policy9.generation s → Core9PolicyLaws.spends later i →
      m.step ctx later (run m ctx t xs) = none

theorem newest_restore : RestoreLaw newest := by
  intro ctx w s t p n keys ed ml cmd ok
  obtain ⟨rules, empty, gen, _⟩ := Policy9.rebind_clears cmd.2 (policy_step cmd ok)
  refine ⟨rules, empty, gen, ?_⟩
  intro xs later i old spend
  cases used : newest.step ctx later (run newest ctx t xs) with
  | none => rfl
  | some after_ =>
    have allowed := Core9PolicyLaws.admission_requires_open spend used
    have mono := generation_run ctx t xs
    simp only [Policy9.grantOK, Bool.and_eq_true, decide_eq_true_eq] at allowed
    have same := allowed.1
    omega

def RevokeLaw (m : Ops) : Prop :=
  ∀ ctx w s t p n d ed ml, Tracked w (.cancel p n d ed ml) → m.step ctx w s = some t →
    p = (ledger s).head ∧ n = Policy9.nextSeq s ∧ Policy9.generation t = Policy9.generation s ∧
    ∃ victim, Policy9.matchingGrants s d = [victim] ∧
      (∀ j, j ∈ pool t ↔ j ∈ pool s ∧ j ≠ victim) ∧
      Policy9.lookup victim t.rules = some .revoked ∧
      (∀ j, j ≠ victim → Policy9.lookup j t.rules = Policy9.lookup j s.rules)

theorem newest_revoke : RevokeLaw newest := fun _ _ _ _ _ _ _ _ _ cmd ok =>
  (Policy9.revoke_effect cmd.2 (policy_step cmd ok)).2

def withoutRenewal (m : Ops) (ctx : Context) (s : State) (i : Intent) : List Input → Prop
  | [] => True
  | c :: cs =>
    (match c with
     | .frame w => ∀ t, m.step ctx w s = some t → ¬Policy9.Fresh s w i
     | _ => True) ∧ withoutRenewal m ctx (execute m ctx s c) i cs

private theorem newest_without {ctx s i xs} :
    withoutRenewal newest ctx s i xs → Core9PolicyLaws.noFresh ctx s i xs := by
  induction xs generalizing s with
  | nil => intro; trivial
  | cons c cs ih =>
    intro h
    exact ⟨h.1, newest_execute ctx s c ▸ ih h.2⟩

def ExpiryLaw (m : Ops) : Prop :=
  (∀ ctx w s t p n last i ed ml, Tracked w (.issue p n last i ed ml) → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml ∧
    n < last ∧ i ∈ pool t ∧ Policy9.lookup i t.rules = some (.validThrough last) ∧
    ∀ proposed, Policy9.permits t.rules i proposed = decide (proposed ≤ last)) ∧
  (∀ ctx w s i, (Policy9.lookup i s.rules = some .revoked ∨
     ∃ last, Policy9.lookup i s.rules = some (.validThrough last) ∧ last < Policy9.nextSeq s) →
    Core9PolicyLaws.spends w i → m.step ctx w s = none) ∧
  ∀ ctx s i xs w, Policy9.Closed s i → withoutRenewal m ctx s i xs → Core9PolicyLaws.spends w i →
    m.step ctx w (run m ctx s xs) = none

theorem newest_expiry : ExpiryLaw newest := by
  refine ⟨?_, fun _ _ _ _ h spend => Core9PolicyLaws.revoked_or_expired_refused h spend, ?_⟩
  · intro ctx w s t p n last i ed ml cmd ok
    obtain ⟨both, _, _, after_, _, held, rule, _⟩ := Policy9.issue_effect cmd.2 (policy_step cmd ok)
    exact ⟨both, after_, held, rule, by intro at_; simp [Policy9.permits, rule]⟩
  · intro ctx s i xs w closed noRenew spend
    rw [newest_run]
    exact Core9PolicyLaws.cannot_readmit_without_new_signed_grant closed (newest_without noRenew) spend

def CorrectionLaw (m : Ops) : Prop :=
  (∀ s key, m.outcome s key = Policy9.outcomeCode s key) ∧
  (∀ ctx w s t p n i v fix, Tracked w (.report p n i v fix) → m.step ctx w s = some t →
    (Policy9.view s.outcomes (Risk8.intentDigest i)).isSome = fix ∧
      t.outcomes = ⟨Risk8.intentDigest i,i,v,fix⟩ :: s.outcomes ∧
      ∀ key, Digest.mk key.data.toList = Risk8.intentDigest i →
        m.outcome t key = (if fix then 4 else 0) + (match v with | .confirmed => 0 | .failed => 1 | .unknown => 2)) ∧
  ∀ ctx w s t p n i v, Tracked w (.report p n i v true) → m.step ctx w s = some t →
    ∃ previous, Policy9.view s.outcomes (Risk8.intentDigest i) = some previous ∧ previous.intent = i

theorem newest_correction : CorrectionLaw newest := by
  refine ⟨fun _ _ => rfl, ?_, ?_⟩
  · intro ctx w s t p n i v fix cmd ok
    have hist := Policy9.report_history cmd.2 (policy_step cmd ok)
    refine ⟨hist.1, hist.2.1, ?_⟩
    intro key ident
    cases v <;> exact Core9PolicyLaws.outcome_value cmd.1 cmd.2 ok key ident
  · intro ctx w s t p n i v cmd ok
    exact Policy9.correction_exact cmd.2 (policy_step cmd ok)

def RetentionLaw (m : Ops) : Prop :=
  ∀ ctx s xs, ∃ prefix_, (run m ctx s xs).outcomes = prefix_ ++ s.outcomes

theorem newest_retention : RetentionLaw newest := by
  intro ctx s xs
  rw [newest_run]
  exact Core9PolicyLaws.outcome_history ctx s xs

end Aukora.Release
