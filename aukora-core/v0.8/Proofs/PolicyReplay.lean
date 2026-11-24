import Proofs.Policy

namespace Aukora.Policy9

open private applyBase append setPool from Policy
open private ran parsed appended bound from Proofs.Policy
open private Core8.append Core8.metadata Core8.assessment Core8.thresholdControl Core8.act from Ledger.Assessed

private def Increasing (a b : R2.Ledger) : Prop :=
  a.book.auth.generation ≤ b.book.auth.generation ∧ a.book.seq + 1 = b.book.seq

private theorem book_clock (book : Book) (act : R2.Action) :
    book.auth.generation ≤ (R2.nextBook book act).auth.generation ∧
    book.seq + 1 = (R2.nextBook book act).seq := by
  cases act with
  | base e => cases e <;> simp [R2.nextBook, advance, changeAuth, spend]
  | useMandate _ e => cases e <;> simp [R2.nextBook]
  | _ => simp [R2.nextBook]

private theorem fromLedger {a b : R2.Ledger} {hash frame}
    (eq : b = R2.append hash a frame) : Increasing a b := by
  subst b
  exact book_clock a.book frame.action

private theorem r8Append {base w frame t} (ok : Core8.append base w frame = some t) :
    Increasing base.hybrid.inner.ledger t.inner.ledger := by
  obtain ⟨inner, good, same⟩ := bound ok
  cases Option.some.inj same
  exact fromLedger (R2.next_spec (Bound4.accepted good).2).2

private theorem meta_clock {base w parent seq label val risk t}
    (h : Core8.metadata base w parent seq label val risk = some t) :
    Increasing base.hybrid.inner.ledger t.hybrid.inner.ledger := by
  obtain ⟨hybrid, ok, eq⟩ := bound h
  cases Option.some.inj eq
  exact r8Append ok

private theorem act_clock {wire base t} (h : Core8.act wire base = some t) :
    Increasing base.hybrid.inner.ledger t.hybrid.inner.ledger := by
  obtain ⟨_, _, h⟩ := bound h
  obtain ⟨_, _, h⟩ := bound h
  obtain ⟨⟨_,_⟩, _, h⟩ := bound h
  obtain ⟨hybrid, ok, h⟩ := bound h
  obtain ⟨_, _, eq⟩ := bound h
  cases Option.some.inj eq
  exact r8Append ok

theorem clocks {s wire t} (ok : step wire s = some t) :
    generation s ≤ generation t ∧ nextSeq t = nextSeq s + 1 := by
  suffices h : Increasing s.base.hybrid.inner.ledger t.base.hybrid.inner.ledger from
    ⟨h.1, congrArg (· + 1) h.2.symm⟩
  obtain ⟨cmd, dec⟩ := parsed ok
  have h := (ran dec ok).1
  cases cmd with
  | ordinary x ext | report p n i val fix =>
    obtain ⟨_, _, h⟩ := bound h
    exact fromLedger (appended h).2
  | issue p n lim i ed ml =>
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨_, _, h⟩ := bound h
    have c := fromLedger (appended h).2
    exact c
  | cancel p n d ed ml =>
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨_, _, h⟩ := bound h
    have c := fromLedger (appended h).2
    exact c
  | rebind p n k ed ml =>
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨b, app, eq⟩ := bound h
    have same := Option.some.inj eq
    rw [← same]
    exact fromLedger (appended app).2
  | use i =>
    have permitted := use_requires_permission dec ok
    cases hit : Core8.act wire s.base with
    | none => simp [applyBase, permitted, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push wire} = t.base := by simpa [applyBase, permitted, hit] using h
      rw [← eq]
      exact act_clock (t := b) hit
  | assessment =>
    cases hit : Core8.assessment wire s.base with
    | none => simp [applyBase, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push wire} = t.base := by simpa [applyBase, hit] using h
      rw [← eq]
      obtain ⟨_, _, hit⟩ := bound hit
      obtain ⟨⟨_,_⟩, _, hit⟩ := bound hit
      obtain ⟨_, _, hit⟩ := bound hit
      exact meta_clock (t := b) hit
  | threshold =>
    cases hit : Core8.thresholdControl wire s.base with
    | none => simp [applyBase, hit] at h
    | some b =>
      have eq : {b with record := s.base.record.push wire} = t.base := by simpa [applyBase, hit] using h
      rw [← eq]
      obtain ⟨_, _, hit⟩ := bound hit
      obtain ⟨⟨_,_⟩, _, hit⟩ := bound hit
      obtain ⟨_, _, hit⟩ := bound hit
      obtain ⟨_, _, hit⟩ := bound hit
      obtain ⟨_, _, hit⟩ := bound hit
      exact meta_clock (t := b) hit

/-- Reasons an exact intent is durably closed. Only a renewal naming that exact
    intent may reopen a same-generation grant; rebind makes the generation stale. -/
def Closed (s : Machine) (i : Intent) : Prop :=
  i.generation < generation s ∨ (i.generation = generation s ∧
    (lookup i s.rules = some .revoked ∨
      ∃ last, lookup i s.rules = some (.validThrough last) ∧ last < nextSeq s))

theorem closed_refuses {s i} (closed : Closed s i) : grantOK s i = false := by
  rcases closed with stale | ⟨_, revoked | ⟨n, limited, past⟩⟩
  · simp [grantOK, Nat.ne_of_lt stale]
  · simp [grantOK, permits, revoked]
  · simp [grantOK, permits, limited, Nat.not_le_of_gt past]

def Fresh (s : Machine) (wire : ByteArray) (i : Intent) : Prop :=
  ∃ p n e ed ml, decode wire = some (.issue p n e i ed ml) ∧
    Hybrid7.Both Core8.verifiers s.base.hybrid.owner (issueMessage s p n e i) ed ml

theorem closed_persists {s t i} (before : Closed s i) (gen : generation s ≤ generation t)
    (seq : nextSeq s ≤ nextSeq t) (rules : lookup i t.rules = lookup i s.rules) : Closed t i := by
  rcases before with stale | ⟨current, barred⟩
  · exact Or.inl (Nat.lt_of_lt_of_le stale gen)
  · by_cases eq : generation s = generation t
    · refine Or.inr ⟨current.trans eq, ?_⟩
      rw [rules]
      rcases barred with revoked | ⟨limit, same, past⟩
      · exact Or.inl revoked
      · exact Or.inr ⟨limit, same, Nat.lt_of_lt_of_le past seq⟩
    · exact Or.inl (current ▸ Nat.lt_of_le_of_ne gen eq)

theorem closed_unless_fresh {s wire t i} (before : Closed s i) (ok : step wire s = some t)
    (noRenewal : ¬Fresh s wire i) : Closed t i := by
  obtain ⟨gen, time⟩ := clocks ok
  have earlier : nextSeq s ≤ nextSeq t := by omega
  obtain ⟨cmd, dec⟩ := parsed ok
  have rules := (ran dec ok).2.1
  cases cmd with
  | issue p n e j ed ml =>
    have distinct : i ≠ j := by
      rintro rfl
      exact noRenewal ⟨p,n,e,ed,ml,dec,(issue_effect dec ok).1⟩
    exact closed_persists before gen earlier (by simp [rules, rulesAfter, lookup, distinct])
  | cancel p n d ed ml =>
    obtain ⟨_,_,_,g,victim,_,_,revoked,other⟩ := revoke_effect dec ok
    by_cases target : i = victim
    · rcases before with stale | ⟨eq, _⟩
      · exact Or.inl (Nat.lt_of_lt_of_le stale gen)
      · exact Or.inr ⟨eq.trans g.symm, Or.inl (target ▸ revoked)⟩
    · exact closed_persists before gen earlier (other i target)
  | rebind p n ks ed ml =>
    have later := (rebind_clears dec ok).2.2.1
    rcases before with old | ⟨same, _⟩ <;> exact Or.inl (by omega)
  | _ => exact closed_persists before gen earlier (by rw [rules]; rfl)

#print axioms clocks
#print axioms closed_refuses
#print axioms closed_unless_fresh

end Aukora.Policy9
