import core.Core8

namespace Aukora.Stamp8

/-- Successful submissions parse to the current head and change exactly the sidecar. -/
theorem accepted {wire s t} (ok : Core8.stamp wire s = some t) :
    (∃ beacon receipt, Core8.decodeStamp wire = some (s.hybrid.inner.ledger.head, beacon, receipt)) ∧
    t = {s with stamps := s.stamps.push wire} := by
  unfold Core8.stamp at ok
  obtain ⟨⟨parent, beacon, receipt⟩, decoded, h⟩ := Option.bind_eq_some.mp ok
  by_cases current : parent = s.hybrid.inner.ledger.head
  · have same : {s with stamps := s.stamps.push wire} = t := by simpa [guard, current] using h
    exact ⟨⟨beacon, receipt, current ▸ decoded⟩, same.symm⟩
  · simp [guard, current] at h
    cases h

/-- The entire authority-bearing hybrid ledger and risk state survive unchanged,
    including sequence, expiries and grants. All prior accepted bytes and prior
    stamp bytes are retained. The new slot contains the submitted frame. -/
theorem preserves_authority_and_history {wire s t} (ok : Core8.stamp wire s = some t) :
    t.hybrid = s.hybrid ∧ t.risk = s.risk ∧ t.record = s.record ∧
    (∀ i, i < s.stamps.size → t.stamps[i]? = s.stamps[i]?) ∧
    t.stamps[s.stamps.size]? = some wire := by
  rw [(accepted ok).2]
  refine ⟨rfl, rfl, rfl, ?_, Array.getElem?_push_size⟩
  intro i earlier
  change (s.stamps.push wire)[i]? = s.stamps[i]?
  simp [Array.getElem?_push, Nat.ne_of_lt earlier]

#print axioms accepted
#print axioms preserves_authority_and_history
end Aukora.Stamp8
