import core.Bound5

namespace Aukora.Stateful5

open Bound5

@[export r5_step]
def stepBytes (wire : @& ByteArray) (s : @& Machine) : Option Machine := do
  let x ← Wire5.decode wire
  Bound5.next Ed25519.verify s x

/-- Direct tests reach the same verifier as the production transition. -/
@[export r5_verify_packed]
def verifyPacked (bytes : ByteArray) : Bool :=
  if bytes.size < 96 then false else
    let xs := bytes.data.toList
    Ed25519.verify (xs.take 32) (xs.drop 96) ((xs.drop 32).take 64)

theorem step_decoded {s wire x} (decoded : Wire5.decode wire = some x) :
    stepBytes wire s = Bound5.next Ed25519.verify s x := by simp [stepBytes, decoded]
#print axioms step_decoded

theorem step_malformed {s wire} (bad : Wire5.decode wire = none) :
    stepBytes wire s = none := by simp [stepBytes, bad]
#print axioms step_malformed

theorem ledger_refinement {s wire x t} (decoded : Wire5.decode wire = some x) (ok : stepBytes wire s = some t) :
    R2.next (fun _ => frameDigest x) s.inner.ledger x.project = some t.inner.ledger :=
  (Bound4.accepted (Bound5.accepted ((step_decoded decoded).symm.trans ok)).2.1).2
#print axioms ledger_refinement

inductive Command where
  | feed (chunk : ByteArray)
  | reset
  | submit (wire : ByteArray)

def applyCommand (s : Machine) : Command → Machine
  | .feed chunk => feed chunk s
  | .reset => reset s
  | .submit wire => (stepBytes wire s).getD s

/-- The ABI cannot alter the owner through staging or refusal. -/
theorem owner_change_requires_signed_submission {s cmd}
    (changed : (applyCommand s cmd).ownerKey ≠ s.ownerKey) :
    ∃ wire x sig, cmd = .submit wire ∧ Wire5.decode wire = some x ∧
      stepBytes wire s = some (applyCommand s cmd) ∧ x.action = .rebind (applyCommand s cmd).ownerKey sig ∧
      Ed25519.verify s.ownerKey (Wire5.rebindBytes s.inner.ledger.book.auth.generation
        (applyCommand s cmd).ownerKey) sig = true ∧ (applyCommand s cmd).inner.ledger.book.auth.grants = [] := by
  cases cmd with
  | feed | reset => exact False.elim (changed rfl)
  | submit wire =>
    cases ok : stepBytes wire s with
    | none => exact False.elim (changed (by simp [applyCommand, ok]))
    | some t =>
      have eq : applyCommand s (.submit wire) = t := by simp [applyCommand, ok]
      cases dec : Wire5.decode wire with
      | none => simp [step_malformed dec] at ok
      | some x =>
        obtain ⟨sig, ev, signed, empty⟩ := Bound5.owner_change_only ((step_decoded dec).symm.trans ok) (eq ▸ changed)
        exact ⟨wire, x, sig, rfl, dec, eq.symm ▸ ok, eq.symm ▸ ev, eq.symm ▸ signed, eq.symm ▸ empty⟩
#print axioms owner_change_requires_signed_submission

theorem new_grant_requires_signed_submission {s cmd i} (old : i ∉ s.inner.ledger.book.auth.grants)
    (added : i ∈ (applyCommand s cmd).inner.ledger.book.auth.grants) :
    ∃ wire x sig, cmd = .submit wire ∧ Wire5.decode wire = some x ∧
      stepBytes wire s = some (applyCommand s cmd) ∧ x.action = .grant i sig ∧
      Ed25519.verify s.ownerKey (Wire5.intentBytes i) sig = true := by
  cases cmd with
  | feed | reset => exact False.elim (old added)
  | submit wire =>
    cases ok : stepBytes wire s with
    | none => exact False.elim (old (by simpa [applyCommand, ok] using added))
    | some t =>
      have eq : applyCommand s (.submit wire) = t := by simp [applyCommand, ok]
      cases dec : Wire5.decode wire with
      | none => simp [step_malformed dec] at ok
      | some x =>
        obtain ⟨sig, ev, signed⟩ := Bound5.new_grant_requires_signature
          ((step_decoded dec).symm.trans ok) old (eq ▸ added)
        exact ⟨wire, x, sig, rfl, dec, eq.symm ▸ ok, ev, signed⟩
#print axioms new_grant_requires_signed_submission

theorem core_changes_only_by_accepted_upgrade {s cmd}
    (changed : (applyCommand s cmd).inner.ledger.book.auth.core ≠ s.inner.ledger.book.auth.core) :
    ∃ wire x i, cmd = .submit wire ∧ Wire5.decode wire = some x ∧
      stepBytes wire s = some (applyCommand s cmd) ∧
      x.action = .plain (.base (.upgrade (Bound4.digest s.inner.candidate) true i)) ∧
      (applyCommand s cmd).inner.ledger.book.auth.core = Bound4.digest s.inner.candidate ∧
      i.body = .install (Bound4.digest s.inner.candidate) ∧ i ∈ s.inner.ledger.book.auth.grants ∧
      i.generation = s.inner.ledger.book.auth.generation := by
  cases cmd with
  | feed | reset => exact False.elim (changed rfl)
  | submit wire =>
    cases ok : stepBytes wire s with
    | none => exact False.elim (changed (by simp [applyCommand, ok]))
    | some t =>
      have eq : applyCommand s (.submit wire) = t := by simp [applyCommand, ok]
      cases dec : Wire5.decode wire with
      | none => simp [step_malformed dec] at ok
      | some x =>
        obtain ⟨i, action, coreEq, props⟩ := Bound5.core_change_only
          ((step_decoded dec).symm.trans ok) (eq ▸ changed)
        exact ⟨wire, x, i, rfl, dec, eq.symm ▸ ok, action, eq.symm ▸ coreEq, props⟩
#print axioms core_changes_only_by_accepted_upgrade

theorem mismatch_refused {s wire x target checked i approved}
    (dec : Wire5.decode wire = some x) (ev : x.action = .plain (.base (.upgrade target checked i)))
    (body : i.body = .install approved) (wrong : Bound4.digest s.inner.candidate ≠ approved) :
    stepBytes wire s = none ∧ applyCommand s (.submit wire) = s := by
  simpa only [applyCommand, step_decoded dec] using
    (Bound5.wrong_digest (verify := Ed25519.verify) ev body wrong)
#print axioms mismatch_refused

theorem different_bytes_refused {s wire x target checked i} (approved : ByteArray)
    (dec : Wire5.decode wire = some x) (ev : x.action = .plain (.base (.upgrade target checked i)))
    (body : i.body = .install (Bound4.digest approved)) (different : s.inner.candidate ≠ approved)
    (noSecondPreimage : Bound4.digest s.inner.candidate = Bound4.digest approved → s.inner.candidate = approved) :
    stepBytes wire s = none ∧ applyCommand s (.submit wire) = s :=
  mismatch_refused dec ev body (fun same => different (noSecondPreimage same))
#print axioms different_bytes_refused

/-- Every suffix of public commands preserves all earlier accepted event IDs. -/
theorem history_extends (s : Machine) (cs : List Command) :
    ∃ suffix, (cs.foldl applyCommand s).inner.ledger.history = s.inner.ledger.history ++ suffix := by
  induction cs generalizing s with
  | nil => exact ⟨[], (List.append_nil _).symm⟩
  | cons c cs ih =>
    obtain ⟨suffix, after⟩ := ih (applyCommand s c)
    change ∃ _, (cs.foldl applyCommand (applyCommand s c)).inner.ledger.history = _
    rw [after]
    cases c with
    | feed | reset => exact ⟨suffix, rfl⟩
    | submit wire =>
      cases ok : stepBytes wire s with
      | none => exact ⟨suffix, by simp [applyCommand, ok]⟩
      | some t =>
        cases dec : Wire5.decode wire with
        | none => simp [step_malformed dec] at ok
        | some x =>
          have ht := (R2.next_spec (ledger_refinement dec ok)).2
          exact ⟨x.project :: suffix, by simp [applyCommand, ok, ht, R2.append, List.append_assoc]⟩
#print axioms history_extends

/-- Even a newly generated valid signature cannot reissue an accepted nonce in
    the same generation, regardless of subsequent staging, spending or rebind. -/
theorem no_grant_nonce_replay {s t wire x i sig} (dec : Wire5.decode wire = some x)
    (ok : stepBytes wire s = some t) (ev : x.action = .grant i sig)
    (cs : List Command) {later y j sig'} (dec' : Wire5.decode later = some y) (ev' : y.action = .grant j sig')
    (gen : j.generation = i.generation) (nonce : j.nonce = i.nonce) :
    stepBytes later (cs.foldl applyCommand t) = none := by
  obtain ⟨suffix, hs⟩ := history_extends t cs
  have ht := (R2.next_spec (ledger_refinement dec ok)).2
  have spent : usedNonce (cs.foldl applyCommand t) j = true := by
    unfold usedNonce
    apply List.any_eq_true.mpr
    refine ⟨x.project, ?_, ?_⟩
    · simp [hs, ht, R2.append]
    · simp [Wire5.Frame.project, Wire5.Action.project, ev, gen, nonce]
  cases laterOK : stepBytes later (cs.foldl applyCommand t) with
  | none => rfl
  | some u =>
    have fresh := (Bound5.grant_verified ((step_decoded dec').symm.trans laterOK) ev').2
    simp [spent] at fresh
#print axioms no_grant_nonce_replay

/-- A reissue is an actual accepted, signed grant for the same intent. -/
def issues (i : Intent) (s : Machine) : Command → Prop
  | .submit wire => (stepBytes wire s).isSome = true ∧
      ∃ x sig, Wire5.decode wire = some x ∧ x.action = .grant i sig
  | _ => False

def noReissue (i : Intent) (s : Machine) : List Command → Prop
  | [] => True
  | c :: cs => ¬ issues i s c ∧ noReissue i (applyCommand s c) cs

private theorem absent_trace (s : Machine) (cs : List Command) (i : Intent)
    (absent : i ∉ s.inner.ledger.book.auth.grants) (noNew : noReissue i s cs) :
    i ∉ (cs.foldl applyCommand s).inner.ledger.book.auth.grants := by
  induction cs generalizing s with
  | nil => exact absent
  | cons c cs ih =>
    apply ih (applyCommand s c) _ noNew.2
    intro added
    obtain ⟨wire, x, sig, cmd, dec, ok, ev, _⟩ := new_grant_requires_signed_submission absent added
    subst c
    exact noNew.1 ⟨by simp [ok], x, sig, dec, ev⟩
#print axioms absent_trace

/-- R4's at-most-once law on the R5 public command interface. For any issued
    nonce, `no_grant_nonce_replay` also rules out a second signature-based issue. -/
theorem one_grant_upgrades_at_most_once {s t wire x target checked i}
    (dec : Wire5.decode wire = some x) (ok : stepBytes wire s = some t)
    (ev : x.action = .plain (.base (.upgrade target checked i))) :
    i ∉ t.inner.ledger.book.auth.grants ∧ ∀ cs, noReissue i t cs →
      ∀ later y target' checked', Wire5.decode later = some y →
        y.action = .plain (.base (.upgrade target' checked' i)) → stepBytes later (cs.foldl applyCommand t) = none := by
  have facts := Bound5.upgrade_facts ((step_decoded dec).symm.trans ok) ev
  have spent := facts.2.2.2.2.2
  refine ⟨spent, ?_⟩
  intro cs noNew later y target' checked' dec' ev'
  have absent := absent_trace t cs i spent noNew
  cases ok' : stepBytes later (cs.foldl applyCommand t) with
  | none => rfl
  | some u => exact False.elim (absent (Bound5.upgrade_facts ((step_decoded dec').symm.trans ok') ev').2.2.1)
#print axioms one_grant_upgrades_at_most_once

private theorem no_reissue_after_issuance {s granted wire x i sig} (dec : Wire5.decode wire = some x)
    (ok : stepBytes wire s = some granted) (ev : x.action = .grant i sig) (before cs : List Command) :
    noReissue i (before.foldl applyCommand granted) cs := by
  induction cs generalizing before with
  | nil => trivial
  | cons c cs ih =>
    constructor
    · intro issued
      cases c with
      | feed | reset => exact issued
      | submit later =>
        obtain ⟨someOK, y, sig', dec', ev'⟩ := issued
        have refused := no_grant_nonce_replay dec ok ev before dec' ev' rfl rfl
        simp [refused] at someOK
    · simpa only [List.foldl_append, List.foldl_cons, List.foldl_nil] using ih (before ++ [c])
#print axioms no_reissue_after_issuance

/-- Once an actually issued signed grant funds one upgrade, every later attempt
    with that intent fails under every command suffix, even if the host resubmits
    the signature or obtains another signature for the same nonce. -/
theorem signed_grant_upgrades_at_most_once {s granted wire x i sig} (grantDec : Wire5.decode wire = some x)
    (grantOk : stepBytes wire s = some granted) (grantEv : x.action = .grant i sig) (before : List Command)
    {upgrade y upgraded target checked} (upDec : Wire5.decode upgrade = some y)
    (upOk : stepBytes upgrade (before.foldl applyCommand granted) = some upgraded)
    (upEv : y.action = .plain (.base (.upgrade target checked i))) :
    i ∉ upgraded.inner.ledger.book.auth.grants ∧ ∀ (cs : List Command) later z target' checked',
      Wire5.decode later = some z → z.action = .plain (.base (.upgrade target' checked' i)) →
        stepBytes later (cs.foldl applyCommand upgraded) = none := by
  have once := one_grant_upgrades_at_most_once upDec upOk upEv
  refine ⟨once.1, ?_⟩
  intro cs
  have noNew := no_reissue_after_issuance grantDec grantOk grantEv (before ++ [Command.submit upgrade]) cs
  have landed : (before ++ [Command.submit upgrade]).foldl applyCommand granted = upgraded := by
    simp [applyCommand, upOk]
  exact once.2 cs (landed ▸ noNew)
#print axioms signed_grant_upgrades_at_most_once

end Aukora.Stateful5
