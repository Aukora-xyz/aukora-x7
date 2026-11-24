import Ledger.Frames

namespace Aukora.R2

-- Every replay extends the accepted history by a suffix, leaving each earlier address stable.
theorem history_extends (d) (s) (xs : List Frame) :
    ∃ suffix, (replay d s xs).history = s.history ++ suffix := by
  induction xs generalizing s with
  | nil => exact ⟨[], (List.append_nil _).symm⟩
  | cons x xs ih =>
    obtain ⟨ys, hy⟩ := ih (step d s x)
    change ∃ _, (replay d (step d s x) xs).history = _
    rw [hy]
    cases hx : next d s x with
    | none => exact ⟨ys, by simp [step, hx]⟩
    | some t => exact ⟨x :: ys, by simp [step, hx, (next_spec hx).2, append, List.append_assoc]⟩
#print axioms history_extends

theorem lookup_persists {f : Action → Option α} {h id v} (hit : lookup f h id = some v) (xs : List Frame) :
    lookup f (h ++ xs) id = some v := by
  by_cases small : id < h.length
  · simpa [lookup, List.getElem?_append_left small] using hit
  · simp [lookup, List.getElem?_eq_none (Nat.le_of_not_gt small)] at hit
#print axioms lookup_persists

def ViewSound (s : Ledger) := ∀ id ∈ s.active, ∃ text, lineAt s.history id = some text

theorem view_step (d s x) (valid : ViewSound s) : ViewSound (step d s x) := by
  cases h : next d s x with
  | none => simpa [step, h] using valid
  | some t =>
    simp only [step, h, Option.getD_some, (next_spec h).2, ViewSound, append]
    have old (id) (hid : id ∈ s.active) : ∃ t, lineAt (s.history ++ [x]) id = some t := by
      obtain ⟨v, hv⟩ := valid id hid
      exact ⟨v, lookup_persists hv _⟩
    intro id hid
    unfold nextView at hid
    split at hid
    next text he =>
      rcases List.mem_cons.mp hid with rfl | prev
      · exact ⟨text, by simp [lineAt, lookup, he]⟩
      · exact old id prev
    next n ok he => exact old id (List.mem_of_mem_drop hid)
    next => exact old id hid
#print axioms view_step

theorem view_replay (d s xs) (valid : ViewSound s) : ViewSound (replay d s xs) := by
  induction xs generalizing s with
  | nil => exact valid
  | cons x xs ih => exact ih _ (view_step d s x valid)
#print axioms view_replay

-- Retraction removes exactly the newest n active addresses, and every removed line stays readable after any suffix.
theorem retract_law {d s x t n v} (ev : x.action = .retract n v) (ok : next d s x = some t)
    (valid : ViewSound s) :
    t.active = s.active.drop n ∧ t.active.length = s.active.length - n ∧ t.active.length < s.active.length ∧
    ∀ id ∈ s.active.take n, ∃ text, lineAt s.history id = some text ∧
      ∀ xs, lineAt (replay d t xs).history id = some text := by
  obtain ⟨gate, ht⟩ := next_spec ok
  have p := gate.2.2.1
  simp [ev, policy] at p
  have hv : t.active = s.active.drop n := by simp [ht, append, ev, nextView]
  refine ⟨hv, by simp [hv], by rw [hv, List.length_drop]; omega, ?_⟩
  intro id hid
  obtain ⟨text, read⟩ := valid id (List.mem_of_mem_take hid)
  refine ⟨text, read, ?_⟩
  intro xs
  obtain ⟨ys, hy⟩ := history_extends d t xs
  rw [hy, ht]
  exact lookup_persists (lookup_persists read [x]) ys
#print axioms retract_law

theorem limit_mono (h : List Frame) (x : Frame) (m id) : limit h m id ≤ limit (h ++ [x]) m id := by
  by_cases small : id < h.length
  · cases m <;> simp [limit, budgetAt, mandateAt, lookup, List.getElem?_append_left small]
  · cases m <;> simp [limit, budgetAt, mandateAt, lookup, List.getElem?_eq_none (Nat.le_of_not_gt small)]
#print axioms limit_mono

theorem sum_snoc (xs : List Nat) (n : Nat) : (xs ++ [n]).sum = xs.sum + n := by
  induction xs with
  | nil => simp
  | cons x xs ih => simp [ih, Nat.add_assoc]
#print axioms sum_snoc

theorem total_step (d s x m id) (bounded : total s.history m id ≤ limit s.history m id) :
    total (step d s x).history m id ≤ limit (step d s x).history m id := by
  cases h : next d s x with
  | none => simpa [step, h] using bounded
  | some t =>
    have gate := (next_spec h).1.2.2.2
    simp only [step, h, Option.getD_some, (next_spec h).2, append]
    apply Nat.le_trans _ (limit_mono _ _ _ _)
    change total (s.history ++ [x]) m id ≤ _
    have sum : total (s.history ++ [x]) m id = total s.history m id + quantity m id x.action := by simp [total, sum_snoc]
    rw [sum]
    cases hd : debit x.action with
    | none => simpa [quantity, hd] using bounded
    | some debitInfo =>
      obtain ⟨k, i, n⟩ := debitInfo
      by_cases same : k = m ∧ i = id
      · obtain ⟨rfl, rfl⟩ := same
        simpa [withinLimit, hd, quantity] using gate
      · simpa [quantity, hd, same] using bounded
#print axioms total_step

theorem total_replay (d s xs m id) (bounded : total s.history m id ≤ limit s.history m id) :
    total (replay d s xs).history m id ≤ limit (replay d s xs).history m id := by
  induction xs generalizing s with
  | nil => exact bounded
  | cons x xs ih => exact ih _ (total_step d s x m id bounded)
#print axioms total_replay

-- A grant's immutable address fixes its cap; every admitted debit in any replay from genesis counts toward that cap.
theorem spend_law (d head core owner xs id b)
    (issued : budgetAt (replay d (initial head core owner) xs).history id = some b) :
    total (replay d (initial head core owner) xs).history .money id ≤ b.cap := by
  have h := total_replay d (initial head core owner) xs .money id (by simp [initial, total])
  simpa [limit, issued] using h
#print axioms spend_law

-- Each mandate use is a delivery of the signed payload to its audience before or at expiry, within its total count.
theorem mandate_law {d s x t id op} (ev : x.action = .useMandate id op) (ok : next d s x = some t) :
    ∃ m i, mandateAt s.history id = some m ∧ op = .act i ∧ i.audience = m.audience ∧
      i.body = .deliver m.payload ∧ i.generation = m.generation ∧ m.generation = s.book.auth.generation ∧
      x.seq ≤ m.expiry ∧ total t.history .uses id ≤ m.count := by
  obtain ⟨g, ht⟩ := next_spec ok
  have access := g.2.2.1
  have cap := g.2.2.2
  rw [ev] at access cap
  cases hm : mandateAt s.history id with
  | none => simp [policy, hm] at access
  | some m =>
    simp [policy, hm] at access
    cases op <;> simp [inScope] at access
    case act i =>
      refine ⟨m, i, rfl, rfl, access.1, access.2.1, access.2.2.1, access.2.2.2.1,
        g.2.1 ▸ access.2.2.2.2, ?_⟩
      simpa [ht, append, total, sum_snoc, quantity, ev, withinLimit, debit, limit, hm] using cap
#print axioms mandate_law

-- An outside read requires the exact authenticated reader and scope of a live pass at the incoming sequence.
theorem pass_law {d s x t id reader scope v} (ev : x.action = .read id reader scope v) (ok : next d s x = some t) :
    v = true ∧ revoked s.history id = false ∧ ∃ p, passAt s.history id = some p ∧
      reader = p.reader ∧ scope = p.scope ∧ p.generation = s.book.auth.generation ∧ x.seq ≤ p.expiry := by
  have g := (next_spec ok).1
  have access := g.2.2.1
  cases hp : passAt s.history id <;> simp [ev, policy, hp, and_assoc] at access
  case some p => exact ⟨access.1, access.2.1, p, rfl, access.2.2.1, access.2.2.2.1,
    access.2.2.2.2.1, g.2.1 ▸ access.2.2.2.2.2⟩
#print axioms pass_law

-- Once revocation is accepted, no later read can use that pass ID, even after a fresh pass is issued.
theorem revoke_law {d s x t id v} (ev : x.action = .revoke id v) (ok : next d s x = some t)
    (xs : List Frame) (y : Frame) (r scope vr) (attempt : y.action = .read id r scope vr) :
    next d (replay d t xs) y = none := by
  have g := (next_spec ok).1.2.2.1
  simp [ev, policy, and_assoc] at g
  obtain ⟨suffix, hs⟩ := history_extends d t xs
  have killed : revoked (replay d t xs).history id = true := by
    rw [hs, (next_spec ok).2]
    apply List.any_eq_true.mpr
    exact ⟨x, by simp [append], by simp [ev, g.1]⟩
  cases h : next d (replay d t xs) y with
  | none => rfl
  | some u => exact False.elim (by simpa [killed] using (pass_law attempt h).2.1)
#print axioms revoke_law

-- Expired reads are refused even with a matching authenticated reader and an unrevoked pass.
theorem expired_pass {d s x id r scope v p} (attempt : x.action = .read id r scope v)
    (issued : passAt s.history id = some p) (expired : p.expiry < x.seq) : next d s x = none := by
  cases h : next d s x with
  | none => rfl
  | some t =>
    obtain ⟨_, _, q, hq, _, _, _, live⟩ := pass_law attempt h
    have eq := Option.some.inj (issued.symm.trans hq)
    subst q
    omega
#print axioms expired_pass

end Aukora.R2
