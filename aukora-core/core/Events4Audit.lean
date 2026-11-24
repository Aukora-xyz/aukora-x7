import core.Core2

namespace Aukora.Events4Audit

def baseFrame (x : Envelope) : R2.Frame := ⟨x.parent, x.seq, .base x.event⟩

/-- For every base event and an identical hashing rule, the unified ledger's
    eligibility, head and book agree with the original transition. The round-4
    candidate check independently strengthens the upgrade branch. -/
theorem base_agrees (d : R2.Frame → Digest) (l : R2.Ledger) (s : State)
    (head : l.head = s.head) (book : l.book = s.book) (x : Envelope) :
    (R2.next d l (baseFrame x)).map (fun t => (t.head, t.book)) =
    (Aukora.next (fun e => d (baseFrame e)) s x).map (fun t => (t.head, t.book)) := by
  have eligible : R2.Allowed l (baseFrame x) ↔ Good s x := by
    simp [R2.Allowed, Good, baseFrame, R2.policy, R2.withinLimit, R2.debit, head, book]
  by_cases h : Good s x
  · simp only [R2.next, if_pos (eligible.mpr h), Aukora.next, if_pos h, Option.map_some]
    simp [R2.append, R2.nextBook, baseFrame, appendEvent, book]
  · simp [R2.next, Aukora.next, eligible, h]
#print axioms base_agrees

end Aukora.Events4Audit
