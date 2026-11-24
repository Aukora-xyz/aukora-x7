import core.Policy9

namespace Aukora.Policy9

open private applyBase append setPool from core.Policy9
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.act from core.Core8

private theorem bound {input : Option α} {f : α → Option β} {result}
    (ok : (input >>= f) = some result) : ∃ x, input = some x ∧ f x = some result :=
  Option.bind_eq_some.mp ok

private theorem ran {s wire t cmd} (dec : decode wire = some cmd) (ok : step wire s = some t) :
    applyBase s wire (selected s cmd) cmd = some t.base ∧ t.rules = rulesAfter s.rules (selected s cmd) cmd ∧
      t.outcomes = outcomesAfter s.outcomes cmd := by
  have h : submit s wire cmd = some t := by simpa [step, dec] using ok
  obtain ⟨b, hb, done_⟩ := bound h
  cases Option.some.inj done_
  exact ⟨hb, rfl, rfl⟩

private theorem parsed {s wire t} (ok : step wire s = some t) : ∃ c, decode wire = some c := by
  obtain ⟨c, dec, _⟩ := bound ok
  exact ⟨c, dec⟩

private theorem hasBoth {s msg ed ml} (ok : signed s msg ed ml = true) :
    Hybrid7.Both Core8.verifiers s.base.hybrid.owner msg ed ml := by
  simp only [signed, Bool.and_eq_true] at ok
  exact (Hybrid7.verifyHybrid_iff ..).mp ok.2

/-- Both ordinary grant spends and mandate spends are subject to the restriction
    on this exact intent, before the previous core checks the chosen route. -/
theorem use_requires_permission {s wire t i} (dec : decode wire = some (.use i))
    (ok : step wire s = some t) : grantOK s i = true := by
  have h := (ran dec ok).1
  unfold applyBase at h
  split at h <;> simp_all

theorem revoked_refused {s wire i} (dec : decode wire = some (.use i))
    (rev : lookup i s.rules = some .revoked) : step wire s = none := by
  cases h : step wire s with
  | none => rfl
  | some t => have a := use_requires_permission dec h; simp [grantOK, permits, rev] at a

theorem expired_refused {s wire i last} (dec : decode wire = some (.use i))
    (limit : lookup i s.rules = some (.validThrough last))
    (past : last < nextSeq s) : step wire s = none := by
  cases h : step wire s with
  | none => rfl
  | some t =>
    have a := use_requires_permission dec h
    simp [grantOK, permits, limit, Nat.not_le_of_gt past] at a

private theorem appended {base wire frame t} (ok : append base wire frame = some t) :
    R2.Allowed base.hybrid.inner.ledger frame ∧
    t.hybrid.inner.ledger = R2.append (fun _ => Bound4.digest wire) base.hybrid.inner.ledger frame := by
  obtain ⟨inner, good, same⟩ := bound ok
  cases Option.some.inj same
  exact R2.next_spec (Bound4.accepted good).2

theorem resolve_unique {s d i} : resolve s d = some i ↔ matchingGrants s d = [i] := by
  cases eq : matchingGrants s d with
  | nil => simp [resolve, eq]
  | cons a more => cases more <;> simp [resolve, eq]

/-- A valid cancellation resolves its signed digest to exactly one eligible intent,
    removes that intent, and leaves every different intent's grant and rule alone. -/
theorem revoke_effect {s wire t parent seq d ed ml}
    (dec : decode wire = some (.cancel parent seq d ed ml)) (ok : step wire s = some t) :
    Hybrid7.Both Core8.verifiers s.base.hybrid.owner (cancelMessage s parent seq d) ed ml ∧
    parent = s.base.hybrid.inner.ledger.head ∧ seq = nextSeq s ∧ generation t = generation s ∧
    ∃ victim, matchingGrants s d = [victim] ∧
      (∀ j, j ∈ pool t.base ↔ j ∈ pool s.base ∧ j ≠ victim) ∧
      lookup victim t.rules = some .revoked ∧
      (∀ j, j ≠ victim → lookup j t.rules = lookup j s.rules) := by
  obtain ⟨h, rules, _⟩ := ran dec ok
  unfold applyBase at h
  obtain ⟨_, checked, h⟩ := bound h
  obtain ⟨victim, choice, h⟩ := bound h
  have resolved : resolve s d = some victim := choice
  have chk : signed s (cancelMessage s parent seq d) ed ml = true := by
    by_contra bad
    simp [guard, bad] at checked
  obtain ⟨header, ledger⟩ := appended h
  refine ⟨hasBoth chk, header.1, header.2.1, ?_, victim, resolve_unique.mp resolved, ?_, ?_, ?_⟩
  · simp [generation, Hybrid7.generation, ledger, R2.append, R2.nextBook, advance, changeAuth, setPool]
  · intro j
    simp [pool, ledger, R2.append, R2.nextBook, advance, changeAuth, setPool]
  · simp [rules, rulesAfter, selected, resolved, lookup]
  · intro j ne
    simp [rules, rulesAfter, selected, resolved, lookup, ne]

theorem issue_effect {s wire t parent seq last i ed ml}
    (dec : decode wire = some (.issue parent seq last i ed ml)) (ok : step wire s = some t) :
    Hybrid7.Both Core8.verifiers s.base.hybrid.owner (issueMessage s parent seq last i) ed ml ∧
    parent = s.base.hybrid.inner.ledger.head ∧ seq = nextSeq s ∧ seq < last ∧
    generation t = generation s ∧ i ∈ pool t.base ∧
    lookup i t.rules = some (.validThrough last) ∧
    (∀ j, j ≠ i →
      (j ∈ pool t.base ↔ j ∈ pool s.base) ∧
      lookup j t.rules = lookup j s.rules) := by
  obtain ⟨h, rules, _⟩ := ran dec ok
  unfold applyBase at h
  obtain ⟨_, checked, h⟩ := bound h
  obtain ⟨_, time, h⟩ := bound h
  obtain ⟨_, _, h⟩ := bound h
  have chk : signed s (issueMessage s parent seq last i) ed ml = true := by
    by_contra bad
    simp [guard, bad] at checked
  have later : seq < last := by
    by_contra bad
    simp [guard, bad] at time
  obtain ⟨header, ledger⟩ := appended h
  refine ⟨hasBoth chk, header.1, header.2.1, later, ?_, ?_, ?_, ?_⟩
  · simp [generation, Hybrid7.generation, ledger, R2.append, R2.nextBook, advance, changeAuth, setPool]
  · simp [pool, ledger, R2.append, R2.nextBook, advance, changeAuth, setPool]
  · simp [rules, rulesAfter, lookup]
  · intro j ne
    simp [pool, ledger, R2.append, R2.nextBook, advance, changeAuth, setPool, rules, rulesAfter,
      lookup, ne]

/-- Expiry is tested at the proposed sequence number. Testing it performs no
    sweep or ledger update; all other grants retain their own independent cutoff. -/
theorem expiry_local {rules i last n} (issued : lookup i rules = some (.validThrough last))
    (past : last < n) (other : Intent) (distinct : other ≠ i) :
    permits rules i n = false ∧
    permits (.cancel i :: rules) other n = permits rules other n := by
  simp [permits, issued, Nat.not_le_of_gt past, lookup, distinct]

theorem rebind_clears {s wire t parent seq keys ed ml}
    (dec : decode wire = some (.rebind parent seq keys ed ml)) (ok : step wire s = some t) :
    t.rules = [] ∧ pool t.base = [] ∧ generation t = generation s + 1 ∧
      ∀ i, i.generation = generation s → grantOK t i = false := by
  obtain ⟨h, rules, _⟩ := ran dec ok
  unfold applyBase at h
  obtain ⟨_, _, h⟩ := bound h
  obtain ⟨b, app, same⟩ := bound h
  have ledger := (appended app).2
  have eq := Option.some.inj same
  have gen : generation t = generation s + 1 := by
    simp [generation, Hybrid7.generation, ← eq, ledger, R2.append, R2.nextBook, advance, changeAuth,
      Wire5.Frame.project, Wire5.Action.project]
  refine ⟨rules, ?_, gen, ?_⟩
  · simp [pool, ← eq, ledger, R2.append, R2.nextBook, advance, changeAuth, Wire5.Frame.project, Wire5.Action.project]
  · intro i old
    simp [grantOK, old, gen]

/-- Public reporting has the same original/correction check at the wire step for both formats. -/
theorem report_history {s wire t p n i r fix} (dec : decode wire = some (.report p n i r fix))
    (ok : step wire s = some t) :
    (view s.outcomes (Risk8.intentDigest i)).isSome = fix ∧
    t.outcomes = ⟨Risk8.intentDigest i, i, r, fix⟩ :: s.outcomes ∧
    view t.outcomes (Risk8.intentDigest i) = some ⟨Risk8.intentDigest i, i, r, fix⟩ ∧
    t.base.record = s.base.record.push wire := by
  obtain ⟨h, _, hist⟩ := ran dec ok
  unfold applyBase at h
  obtain ⟨_, marked, app⟩ := bound h
  have flag : (view s.outcomes (Risk8.intentDigest i)).isSome = fix := by
    cases old : view s.outcomes (Risk8.intentDigest i) <;> cases fix <;>
      simp_all [reportOK, guard]
  obtain ⟨_, _, record⟩ := bound app
  exact ⟨flag, hist, by simp [hist, outcomesAfter, view], by rw [← Option.some.inj record]⟩

/-- A same-digest report for a different full intent cannot supersede this outcome. -/
theorem correction_exact {s wire t p n i r} (dec : decode wire = some (.report p n i r true))
    (ok : step wire s = some t) : ∃ previous,
      view s.outcomes (Risk8.intentDigest i) = some previous ∧ previous.intent = i := by
  have h := (ran dec ok).1
  obtain ⟨_, valid, _⟩ := bound h
  cases hit : view s.outcomes (Risk8.intentDigest i) with
  | none => simp [reportOK, guard, hit] at valid
  | some prev =>
    refine ⟨prev, rfl, ?_⟩
    by_contra neq
    simp [reportOK, guard, hit, neq] at valid

theorem history_extends {s wire t} (ok : step wire s = some t) :
    ∃ prefix_ : List Finding, t.outcomes = prefix_ ++ s.outcomes := by
  obtain ⟨cmd, dec⟩ := parsed ok
  have h := (ran dec ok).2.2
  rw [h]
  cases cmd <;> first | exact ⟨[], rfl⟩ | exact ⟨[_], rfl⟩

/-- A corrected failure and an original failure return distinct read-interface values,
    5 and 1. The older confirmed report remains in the corrected history. -/
theorem distinguish_failure {s orig t corr} {i : Intent} {a b x y}
    (first : decode orig = some (.report a x i .confirmed false)) (h₁ : step orig s = some t)
    (second : decode corr = some (.report b y i .failed true)) {u} (h₂ : step corr t = some u)
    {s' wire' f p n} (plain : decode wire' = some (.report p n i .failed false))
    (h₃ : step wire' s' = some f) :
    view u.outcomes (Risk8.intentDigest i) ≠ view f.outcomes (Risk8.intentDigest i) ∧
    (⟨Risk8.intentDigest i, i, .confirmed, false⟩ : Finding) ∈ u.outcomes := by
  have old := report_history first h₁
  have fixed_ := report_history second h₂
  have pure_ := report_history plain h₃
  constructor
  · rw [fixed_.2.2.1, pure_.2.2.1]
    simp
  · simp [fixed_.2.1, old.2.1]

#print axioms use_requires_permission
#print axioms revoked_refused
#print axioms expired_refused
#print axioms revoke_effect
#print axioms issue_effect
#print axioms expiry_local
#print axioms rebind_clears
#print axioms correction_exact
#print axioms report_history
#print axioms history_extends
#print axioms distinguish_failure

end Aukora.Policy9
