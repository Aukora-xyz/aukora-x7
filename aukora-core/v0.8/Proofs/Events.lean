import Ledger.Events

namespace Aukora

theorem next_spec {d : Hasher} {s t : State} {x : Envelope} (h : next d s x = some t) :
    Good s x ∧ t = appendEvent d s x := by
  -- Repair: the first proof's `simpa` left the gate in the hypothesis.
  unfold next at h
  by_cases ok : Good s x
  · rw [if_pos ok] at h
    exact ⟨ok, (Option.some.inj h).symm⟩
  · rw [if_neg ok] at h
    cases h
#print axioms next_spec

-- L1. Replaying only the accepted envelopes recovers the entire state.
theorem replay_accepted (d : Hasher) (s : State) (xs : List Envelope) :
    replay d s (accepted d s xs) = replay d s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons x xs ih =>
    cases h : next d s x with
    | none => simpa [accepted, replay, step, h] using ih s
    | some t => simpa [accepted, replay, step, h] using ih t
#print axioms replay_accepted

theorem same_accepted_same_state (d : Hasher) (s : State) (xs ys : List Envelope)
    (h : accepted d s xs = accepted d s ys) : replay d s xs = replay d s ys := by
  rw [← replay_accepted d s xs, h, replay_accepted]
#print axioms same_accepted_same_state

-- L2. The final record is the initial record followed by exactly the accepted input.
theorem record_replay (d : Hasher) (s : State) (xs : List Envelope) :
    (replay d s xs).record = s.record ++ accepted d s xs := by
  induction xs generalizing s with
  | nil => simp [replay, accepted]
  | cons x xs ih =>
    cases hx : next d s x with
    | none => simpa [replay, accepted, step, hx] using ih s
    | some t =>
      have hr : t.record = s.record ++ [x] := congrArg State.record (next_spec hx).2
      simpa [replay, accepted, step, hx, hr, List.append_assoc] using ih t
#print axioms record_replay

-- L3. A stale parent is refused and replay leaves every field untouched.
theorem stale_parent (d : Hasher) (s : State) (x : Envelope) (h : x.parent ≠ s.head) :
    next d s x = none ∧ step d s x = s := by
  simp [step, next, Good, h]
#print axioms stale_parent

theorem bad_sequence (d : Hasher) (s : State) (x : Envelope) (h : x.seq ≠ s.book.seq + 1) :
    next d s x = none ∧ step d s x = s := by
  simp [step, next, Good, h]
#print axioms bad_sequence

theorem spend_requires_grant {d : Hasher} {s t : State} {x : Envelope} {i : Intent} (ok : next d s x = some t)
    (use : spendIntent x.event = some i) :
    i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have gate := (next_spec ok).1.2.2.1
  simpa [spendOK, use] using gate
#print axioms spend_requires_grant

theorem absence_after_change (a : Authority) (e : Event) (i : Intent)
    (absent : i ∉ a.grants) (noIssue : e ≠ .grant i true) :
    i ∉ (changeAuth a e).grants := by
  cases e with
  | grant j verified =>
    cases verified with
    | false => simpa [changeAuth] using absent
    | true =>
      have ne : i ≠ j := by intro h; subst j; exact noIssue rfl
      simp [changeAuth, ne, absent]
  | _ => simp_all [changeAuth, spend, List.mem_filter]
#print axioms absence_after_change

theorem absence_replay (d : Hasher) (s : State) (xs : List Envelope) (i : Intent)
    (absent : i ∉ s.book.auth.grants)
    (noIssue : ∀ x ∈ xs, x.event ≠ .grant i true) :
    i ∉ (replay d s xs).book.auth.grants := by
  induction xs generalizing s with
  | nil => exact absent
  | cons x xs ih =>
    apply ih (s := step d s x)
    · cases hx : next d s x with
      | none => simpa [step, hx] using absent
      | some t =>
        have ha := absence_after_change s.book.auth x.event i absent
          (noIssue x (List.mem_cons_self ..))
        simpa only [step, hx, Option.getD_some, (next_spec hx).2, appendEvent, advance] using ha
    · intro y hy
      exact noIssue y (List.mem_cons_of_mem x hy)
#print axioms absence_replay

-- L4. One accepted act records and consumes its exact grant. No later act or upgrade
-- can spend it after any intervening trace without a new verified grant for that intent.
-- The ownerVerified field reports host verification over the exact intent.
theorem one_grant_once (d : Hasher) (s t : State) (x : Envelope) (i : Intent)
    (ok : next d s x = some t) (act : x.event = .act i) :
    t.book.auth.admitted = i :: s.book.auth.admitted ∧ i ∉ t.book.auth.grants ∧
    ∀ (xs : List Envelope), (∀ y ∈ xs, y.event ≠ .grant i true) →
      ∀ y : Envelope, spendIntent y.event = some i →
        next d (replay d t xs) y = none := by
  have ht := (next_spec ok).2
  have spent : i ∉ t.book.auth.grants := by
    simp [ht, appendEvent, advance, act, changeAuth, spend, List.mem_filter]
  refine ⟨?_, spent, ?_⟩
  · simp [ht, appendEvent, advance, act, changeAuth, spend]
  · intro xs noIssue y use
    have missing := absence_replay d t xs i spent noIssue
    cases hy : next d (replay d t xs) y with
    | none => rfl
    | some u => exact False.elim (missing (spend_requires_grant hy use).1)
#print axioms one_grant_once

-- L5. An accepted passive event preserves every authority field.
theorem passive_preserves_authority {d : Hasher} {s t : State} {x : Envelope} (h : next d s x = some t)
    (passive : Passive x.event) : t.book.auth = s.book.auth := by
  rw [(next_spec h).2]
  change changeAuth s.book.auth x.event = s.book.auth
  cases he : x.event <;> simp_all [Passive, changeAuth]
#print axioms passive_preserves_authority

-- Only a score is erased. Each host addresses proposals to its own actual head.
def maskScore : Event → Event
  | .advise cell _ => .advise cell 0
  | e => e

def bookStep (b : Book) (e : Event) : Book :=
  if Eligible b e then advance b e else b

def localReplay (d : Hasher) (s : State) : List Event → State
  | [] => s
  | e :: es => localReplay d (step d s (pack s e)) es

theorem project_step (d : Hasher) (s : State) (e : Event) :
    (step d s (pack s e)).book = bookStep s.book (maskScore e) := by
  have erase : bookStep s.book (maskScore e) = bookStep s.book e := by cases e <;> rfl
  rw [erase]
  -- Repair: `simp` did not discharge the gate; do it by hand.
  have good : Good s (pack s e) ↔ Eligible s.book e := by
    constructor
    · intro h; exact h.2.2
    · intro h; exact ⟨rfl, rfl, h⟩
  by_cases gate : Eligible s.book e
  · have hn : next d s (pack s e) = some (appendEvent d s (pack s e)) := if_pos (good.mpr gate)
    show ((next d s (pack s e)).getD s).book = bookStep s.book e
    rw [hn]
    show (appendEvent d s (pack s e)).book = bookStep s.book e
    unfold bookStep
    rw [if_pos gate]
    rfl
  · have hn : next d s (pack s e) = none := if_neg (fun h => gate (good.mp h))
    show ((next d s (pack s e)).getD s).book = bookStep s.book e
    rw [hn]
    unfold bookStep
    rw [if_neg gate]
    rfl
#print axioms project_step

theorem project_replay (d : Hasher) (s : State) (xs : List Event) :
    (localReplay d s xs).book = (xs.map maskScore).foldl bookStep s.book := by
  induction xs generalizing s with
  | nil => rfl
  | cons e es ih =>
    simpa only [localReplay, List.map_cons, List.foldl_cons, project_step] using
      ih (step d s (pack s e))
#print axioms project_replay

-- L6. Equal proposals modulo advice scores give equal authority under local framing.
theorem advice_only (d : Hasher) (s t : State) (xs ys : List Event)
    (start : s.book = t.book) (aligned : xs.map maskScore = ys.map maskScore) :
    (localReplay d s xs).book.auth = (localReplay d t ys).book.auth := by
  rw [project_replay, project_replay, start, aligned]
#print axioms advice_only

theorem generation_mono_step (d : Hasher) (s : State) (x : Envelope) :
    s.book.auth.generation ≤ (step d s x).book.auth.generation := by
  by_cases g : Good s x
  · simp only [step, next, if_pos g, Option.getD_some]
    change s.book.auth.generation ≤ (changeAuth s.book.auth x.event).generation
    cases x.event <;> simp [changeAuth, spend, Nat.le_succ]
  · simp [step, next, g]
#print axioms generation_mono_step

theorem generation_mono (d : Hasher) (s : State) (xs : List Envelope) :
    s.book.auth.generation ≤ (replay d s xs).book.auth.generation := by
  induction xs generalizing s with
  | nil => exact Nat.le_refl _
  | cons x xs ih => exact Nat.le_trans (generation_mono_step d s x) (ih (step d s x))
#print axioms generation_mono

-- L7. A rebind carrying the host's ownerVerified = true clears the pool and bars old spends.
theorem restore_kills_authority (d : Hasher) (s t : State) (x : Envelope) (owner : String)
    (binding : x.event = .rebind owner true) (ok : next d s x = some t) :
    t.book.auth.grants = [] ∧ t.book.auth.generation = s.book.auth.generation + 1 ∧
    ∀ (xs : List Envelope) (y : Envelope) (i : Intent),
      i.generation ≤ s.book.auth.generation → spendIntent y.event = some i →
      next d (replay d t xs) y = none := by
  have ht := (next_spec ok).2
  have gen : t.book.auth.generation = s.book.auth.generation + 1 := by
    simp [ht, appendEvent, advance, binding, changeAuth]
  refine ⟨?_, gen, ?_⟩
  · simp [ht, appendEvent, advance, binding, changeAuth]
  · intro xs y i old use
    have later := generation_mono d t xs
    rw [gen] at later
    cases hy : next d (replay d t xs) y with
    | none => rfl
    | some u =>
      have eqn := (spend_requires_grant hy use).2
      have lt := Nat.lt_of_lt_of_le (Nat.lt_succ_of_le old) later
      exact False.elim ((Nat.ne_of_lt lt) eqn)
#print axioms restore_kills_authority

-- An accepted grant before a rebind has the old generation, even with arbitrary intervening input.
theorem issued_before_rebind (d : Hasher) (s issued rebound : State) (grant binding : Envelope)
    (between later : List Envelope) (i : Intent) (owner : String)
    (grantEvent : grant.event = .grant i true) (issueOK : next d s grant = some issued)
    (bindEvent : binding.event = .rebind owner true)
    (bindOK : next d (replay d issued between) binding = some rebound)
    (attempt : Envelope) (use : spendIntent attempt.event = some i) :
    next d (replay d rebound later) attempt = none := by
  have gate := (next_spec issueOK).1.2.2.2
  have verified : i.generation = s.book.auth.generation ∧ i ∉ s.book.auth.grants := by
    simpa [grantEvent, eventOK] using gate
  have issuedGen : issued.book.auth.generation = s.book.auth.generation := by
    simp [(next_spec issueOK).2, appendEvent, advance, grantEvent, changeAuth]
  have old := generation_mono d issued between
  rw [issuedGen, ← verified.1] at old
  exact (restore_kills_authority d _ rebound binding owner bindEvent bindOK).2.2 later attempt i old use
#print axioms issued_before_rebind

-- L8. A core change requires the host's proofChecked = true for the granted target.
theorem core_change_requires_upgrade {d : Hasher} {s t : State} {x : Envelope} (ok : next d s x = some t)
    (changed : t.book.auth.core ≠ s.book.auth.core) :
    ∃ i, x.event = .upgrade t.book.auth.core true i ∧ i.body = .install t.book.auth.core ∧
      i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have ht := (next_spec ok).2
  have hc : (changeAuth s.book.auth x.event).core ≠ s.book.auth.core := by
    simpa only [ht, appendEvent, advance] using changed
  cases he : x.event <;> simp [he, changeAuth, spend] at hc
  case upgrade candidate checked i =>
    have gate := (next_spec ok).1.2.2.2
    have checks : checked = true ∧ i.body = .install candidate := by
      simpa [he, eventOK] using gate
    have use := spend_requires_grant ok (i := i) (by simp [he, spendIntent])
    have target : t.book.auth.core = candidate := by
      simp [ht, appendEvent, advance, he, changeAuth]
    exact ⟨i, by rw [target, checks.1], by rw [target]; exact checks.2, use⟩
#print axioms core_change_requires_upgrade

end Aukora
