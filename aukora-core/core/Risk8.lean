import core.Hybrid7

namespace Aukora.Risk8

structure Assessment where
  score : UInt8
  bundle : Digest
  deriving DecidableEq

structure Admission where
  intent : Digest
  score : UInt8
  bundle : Digest
  defaulted : Bool
  deriving DecidableEq

structure State where
  threshold : UInt8 := 0
  assessments : List (Digest × Assessment) := []
  admissions : List Admission := []

def initial : State := {}

def intentDigest (i : Intent) : Digest := Bound4.digest (Wire4.putIntent i).toByteArray

/-- The fallback explicitly commits to the absent evidence and witness fields
    and the full intent digest. It never asserts that a witness assessed it. -/
def defaultBundle (d : Digest) : Digest :=
  Bound4.digest ((Wire4.putText
    "AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing"
    ++ d.bytes).toByteArray)

def assess (s : State) (d : Digest) (score : UInt8) (bundle : Digest) : State :=
  {s with assessments := (d, ⟨score, bundle⟩) :: s.assessments}

private def findAssessment (d : Digest) : List (Digest × Assessment) → Option Assessment
  | [] => none
  | (key, a) :: more => if d = key then some a else findAssessment d more

def lookup (s : State) (d : Digest) := findAssessment d s.assessments

def effective (s : State) (d : Digest) : Assessment :=
  match lookup s d with
  | some a => a
  | none => ⟨255, defaultBundle d⟩

@[simp] theorem effective_assess (s d score bundle) :
    effective (assess s d score bundle) d = ⟨score, bundle⟩ := by
  simp [effective, lookup, assess, findAssessment]

/-- An exact grant route consumes a fresh unspent grant in the hybrid ledger.
    A mandate route is permitted only strictly below the current threshold. -/
def allowAt (threshold score : UInt8) (exactGrant mandate : Bool) : Bool :=
  exactGrant || (mandate && decide (score.toNat < threshold.toNat))

def admit (s : State) (d named : Digest) (exactGrant mandate : Bool) : Bool :=
  let a := effective s d
  decide (named = a.bundle) && allowAt s.threshold a.score exactGrant mandate

def act (s : State) (d named : Digest) (exactGrant mandate : Bool) : Option State :=
  if admit s d named exactGrant mandate then
    let entry : Admission := ⟨d, (effective s d).score, named, (lookup s d).isNone⟩
    some {s with admissions := entry :: s.admissions}
  else none

/-- Both verifiers see the same current owner, generation, parent, sequence and proposed threshold. -/
def thresholdMessage (owner : Hybrid7.Keys) (gen : Nat) (parent : Digest) (seq : Nat) (threshold : UInt8) : Bytes :=
  Wire4.putText "AUKORA/R8/threshold" ++ Hybrid7.keyBytes owner ++ Wire4.putUInt 8 gen ++
    parent.bytes ++ Wire4.putUInt 8 seq ++ [threshold]

def setThreshold (v : Hybrid7.Verifiers) (owner : Hybrid7.Keys) (gen : Nat) (parent : Digest)
    (seq : Nat) (threshold : UInt8) (ed ml : Bytes) (s : State) : Option State :=
  if ed.length == 64 && ml.length == 3309 &&
      Hybrid7.verifyHybrid v owner (thresholdMessage owner gen parent seq threshold) ed ml then
    some {s with threshold}
  else none

inductive Event where
  | keep
  | assessment (d : Digest) (score : UInt8) (bundle : Digest)
  | control (threshold : UInt8) (ed ml : Bytes)
  | action (d named : Digest) (exactGrant mandate : Bool)

/-- Risk-state projection of a submission. Unrelated events retain the risk state. -/
def step (v : Hybrid7.Verifiers) (owner : Hybrid7.Keys) (gen : Nat) (parent : Digest) (seq : Nat)
    (s : State) : Event → Option State
  | .keep => some s
  | .assessment d n b => some (assess s d n b)
  | .control n ed ml => setThreshold v owner gen parent seq n ed ml s
  | .action d named g m => act s d named g m

private theorem allowAt_monotone {threshold low high : UInt8} (le : low.toNat ≤ high.toNat)
    (g m : Bool) (refused : allowAt threshold low g m = false) :
    allowAt threshold high g m = false := by
  cases g <;> cases m <;> simp [allowAt] at * <;> omega

/-- MONOTONE on actual stateful act submissions. Hold intent, bundle, threshold and both
    authority routes fixed, change only the recorded score, and preserve every refusal. -/
theorem monotone {s d low high assessed named g m} (le : low.toNat ≤ high.toNat)
    (refused : act (assess s d low assessed) d named g m = none) :
    act (assess s d high assessed) d named g m = none := by
  by_cases eq : named = assessed
  · subst named
    have h : allowAt s.threshold low g m = false := by
      simpa [act, admit, effective, lookup, assess, findAssessment] using refused
    have higher := allowAt_monotone le g m h
    simp [act, admit, effective, lookup, assess, findAssessment, higher]
  · simp [act, admit, eq]

theorem missing_is_highest {s d} (missing : lookup s d = none) :
    effective s d = ⟨255, defaultBundle d⟩ := by simp [effective, missing]

theorem missing_requires_exact {s d named g m t} (missing : lookup s d = none)
    (ok : act s d named g m = some t) : g = true ∧ named = defaultBundle d := by
  have top := missing_is_highest missing
  unfold act at ok
  split at ok
  next attended =>
    simp only [admit, top, Bool.and_eq_true, decide_eq_true_eq] at attended
    obtain ⟨nameEq, route⟩ := attended
    refine ⟨?_, nameEq⟩
    have limit : s.threshold.toNat < 256 := s.threshold.toNat_lt_size
    cases g <;> simp [allowAt] at *
    omega
  next => contradiction

/-- The acceptance result itself records the submitted bundle and the effective score.
    The defaulted flag distinguishes a missing assessment from any recorded model score. -/
theorem admitted_names_assessment {s d named g m t} (ok : act s d named g m = some t) :
    named = (effective s d).bundle ∧
    t.admissions = ⟨d, (effective s d).score, named, (lookup s d).isNone⟩ :: s.admissions := by
  unfold act at ok
  split at ok
  next allow =>
    simp only [admit, Bool.and_eq_true, decide_eq_true_eq] at allow
    cases Option.some.inj ok
    exact ⟨allow.1, rfl⟩
  next => contradiction

theorem threshold_changes_only_signed {v owner gen parent seq s t event}
    (ok : step v owner gen parent seq s event = some t) (changed : t.threshold ≠ s.threshold) :
    ∃ ed ml, event = .control t.threshold ed ml ∧
      Hybrid7.Both v owner (thresholdMessage owner gen parent seq t.threshold) ed ml := by
  cases event with
  | keep => cases Option.some.inj ok; exact False.elim (changed rfl)
  | assessment => cases Option.some.inj ok; exact False.elim (changed rfl)
  | action d named g m =>
    change act s d named g m = some t at ok
    unfold act at ok
    split at ok
    next => cases Option.some.inj ok; exact False.elim (changed rfl)
    next => contradiction
  | control n ed ml =>
    change setThreshold v owner gen parent seq n ed ml s = some t at ok
    unfold setThreshold at ok
    split at ok
    next sigs =>
      cases Option.some.inj ok
      simp only [Bool.and_eq_true] at sigs
      exact ⟨ed, ml, rfl, (Hybrid7.verifyHybrid_iff ..).mp sigs.2⟩
    next => contradiction

-- The hybrid ledger is the source of exact grants. Its signed provenance must
-- survive ordinary steps and R8 metadata steps before a certified upgrade can use it.
open R6.KernelCell (Context)

def pool (h : Hybrid7.Machine) := h.inner.ledger.book.auth.grants

inductive Reach (v : Hybrid7.Verifiers) (p q : Context) : Hybrid7.Machine → Prop where
  | genesis {k h} (init : Hybrid7.genesis k = some h) : Reach v p q h
  | submit {h h' r} (old : Reach v p q h) (ok : Hybrid7.step v p q r h = some h') : Reach v p q h'
  | preserve {h h'} (old : Reach v p q h) (owner : h'.owner = h.owner)
      (noNew : ∀ i, i ∈ pool h' → i ∈ pool h) : Reach v p q h'

theorem grants_have_signatures {v p q h} (reach : Reach v p q h) :
    ∀ i, i ∈ pool h → ∃ ed ml, Hybrid7.Both v h.owner (Hybrid7.grantMessage h.owner i) ed ml := by
  induction reach with
  | genesis init =>
    unfold Hybrid7.genesis at init
    split at init
    next => cases Option.some.inj init; simp [pool, Bound5.initial, R2.initial, Aukora.genesis]
    next => contradiction
  | @preserve s t _ owner noNew ih =>
    intro i available
    rw [owner]
    exact ih i (noNew i available)
  | @submit s t r _ ok ih =>
    intro i available
    by_cases eq : t.owner = s.owner
    · rw [eq]
      by_cases had : i ∈ pool s
      · exact ih i had
      · obtain ⟨_, ed, ml, _, _, _, both⟩ := Hybrid7.new_grant_requires_both ok had available
        exact ⟨ed, ml, both⟩
    · obtain ⟨_, _, _, _, _, _, _, empty⟩ := Hybrid7.owner_change_requires_both ok eq
      simp [pool, empty] at available

/-- FLOOR for the full certified upgrade path. Threshold and assessments do not
    enter this branch. The exact unspent grant has both signatures from the current owner
    and is removed on acceptance. The manifest's proof check succeeds as well. -/
theorem upgrade_floor {v p q h h' r u} (reach : Reach v p q h)
    (dec : Upgrade7.decode r.wire = some (.certified u)) (ok : Hybrid7.step v p q r h = some h') :
    (∃ ed ml, Hybrid7.Both v h.owner (Hybrid7.grantMessage h.owner u.intent) ed ml) ∧
    u.intent ∈ pool h ∧ u.intent ∉ pool h' ∧
    ∃ e, Upgrade7.lookup u.target = some e ∧ R6.KernelCell.check (e.context p q) u.proof = true := by
  obtain ⟨e, listed, cert, grant, spent⟩ := Hybrid7.certified_requires_entry_proof dec ok
  exact ⟨grants_have_signatures reach u.intent grant, grant, spent, e, listed, cert⟩

/-- FLOOR for rebind at every score and threshold. Both OLD keys authorize the
    exact new pair in the current generation, regardless of the risk state. -/
theorem rebind_floor {v p q h h' r x newEd ed}
    (dec : Upgrade7.decode r.wire = some (.ordinary x)) (ok : Hybrid7.step v p q r h = some h')
    (binding : x.action = .rebind newEd ed) :
    ∃ newML ml, r.extra = .binding newML ml ∧
      Hybrid7.Both v h.owner (Hybrid7.rebindMessage h.owner (Hybrid7.generation h) ⟨newEd,newML⟩) ed ml := by
  obtain ⟨ml, sig, extra, both, _, _, _⟩ := Hybrid7.rebind_verified dec ok binding
  exact ⟨ml, sig, extra, both⟩

#print axioms monotone
#print axioms upgrade_floor
#print axioms rebind_floor
#print axioms threshold_changes_only_signed
#print axioms missing_is_highest
#print axioms missing_requires_exact
#print axioms admitted_names_assessment
end Aukora.Risk8
