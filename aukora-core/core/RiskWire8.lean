import core.Core8

namespace Aukora.RiskWire8
open Core8 (Machine verifiers)
open private Core8.append Core8.metadata Core8.header Core8.assessment Core8.thresholdControl
  Core8.actRoute Core8.act Core8.dispatch Core8.slice from core.Core8

private theorem bound {input : Option α} {f : α → Option β} {result}
    (ok : (input >>= f) = some result) : ∃ x, input = some x ∧ f x = some result :=
  Option.bind_eq_some.mp ok

private theorem submitted {p q bytes s t} (ok : Core8.step p q bytes s = some t) :
    ∃ u, Core8.dispatch p q bytes s = some u ∧ t.hybrid = u.hybrid ∧ t.risk = u.risk ∧
      t.record = s.record.push bytes := by
  obtain ⟨u, hu, endOK⟩ := bound ok
  cases Option.some.inj endOK
  exact ⟨u, hu, rfl, rfl, rfl⟩

private theorem metadata_ok {s wire parent seq label value risk t}
    (ok : Core8.metadata s wire parent seq label value risk = some t) :
    t.risk = risk ∧ parent = s.hybrid.inner.ledger.head ∧ seq = s.hybrid.inner.ledger.book.seq + 1 := by
  obtain ⟨hybrid, hy, done_⟩ := bound ok
  obtain ⟨inner, innerOK, _⟩ := bound hy
  have allowed := (R2.next_spec (Bound4.accepted innerOK).2).1
  cases Option.some.inj done_
  exact ⟨rfl, allowed.1, allowed.2.1⟩

private theorem assessment_threshold {s wire t} (ok : Core8.assessment wire s = some t) :
    t.risk.threshold = s.risk.threshold := by
  obtain ⟨_, _, h⟩ := bound ok
  obtain ⟨⟨parent, seq⟩, _, h⟩ := bound h
  obtain ⟨score, _, h⟩ := bound h
  rw [(metadata_ok h).1]
  rfl

private theorem act_ok {s wire t} (ok : Core8.act wire s = some t) :
    ∃ x i g, Wire5.decode (wire.extract 33 wire.size) = some x ∧ Core8.actRoute x = some (i, g) ∧
      Bound4.next (fun _ => Bound4.digest wire) s.hybrid.inner x.project = some t.hybrid.inner ∧
      Risk8.act s.risk (Risk8.intentDigest i) ⟨Core8.slice wire 1 33⟩ g (!g) = some t.risk := by
  obtain ⟨_, _, h⟩ := bound ok
  obtain ⟨x, dec, h⟩ := bound h
  obtain ⟨⟨i, g⟩, selected, h⟩ := bound h
  obtain ⟨hybrid, hy, h⟩ := bound h
  obtain ⟨risk, riskOK, done_⟩ := bound h
  obtain ⟨inner, innerOK, hyEq⟩ := bound hy
  cases Option.some.inj hyEq
  cases Option.some.inj done_
  exact ⟨x, i, g, dec, selected, innerOK, riskOK⟩

private theorem act_threshold {s wire t} (ok : Core8.act wire s = some t) :
    t.risk.threshold = s.risk.threshold := by
  obtain ⟨_, _, _, _, _, _, h⟩ := act_ok ok
  unfold Risk8.act at h
  split at h
  · have state := Option.some.inj h
    exact (congrArg Risk8.State.threshold state).symm
  · cases h

/-- Every threshold change at the byte dispatcher is a tag-22 submission signed
    by both current keys over this head, next sequence, generation and new value. -/
theorem threshold_changed {p q wire s t} (ok : Core8.step p q wire s = some t)
    (changed : t.risk.threshold ≠ s.risk.threshold) :
    wire[0]? = some (22 : UInt8) ∧ wire[41]? = some t.risk.threshold ∧
      Hybrid7.Both verifiers s.hybrid.owner (Risk8.thresholdMessage s.hybrid.owner
        (Hybrid7.generation s.hybrid) s.hybrid.inner.ledger.head (s.hybrid.inner.ledger.book.seq+1)
        t.risk.threshold) (Core8.slice wire 42 106) (Core8.slice wire 106 wire.size) := by
  obtain ⟨u, run, _, risk, _⟩ := submitted ok
  rw [risk] at changed ⊢
  obtain ⟨tag, tagged, branch⟩ := bound run
  split at branch
  · exact False.elim (changed (assessment_threshold branch))
  · obtain ⟨_, _, h⟩ := bound branch
    obtain ⟨⟨parent, seq⟩, _, h⟩ := bound h
    obtain ⟨level, levelAt, h⟩ := bound h
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨next, signed, appended⟩ := bound h
    obtain ⟨nextEq, parentEq, seqEq⟩ := metadata_ok appended
    rw [nextEq] at changed ⊢
    obtain ⟨ed, ml, same, both⟩ := Risk8.threshold_changes_only_signed
      (event := .control level (Core8.slice wire 42 106) (Core8.slice wire 106 wire.size)) signed changed
    cases same
    exact ⟨tagged, levelAt, parentEq ▸ seqEq ▸ both⟩
  · exact False.elim (changed (act_threshold branch))
  · obtain ⟨_, _, h⟩ := bound branch
    obtain ⟨_, _, h⟩ := bound h
    obtain ⟨_, _, h⟩ := bound h
    have same := Option.some.inj h
    exact False.elim (changed (congrArg (fun x : Machine => x.risk.threshold) same).symm)

/-- On the actual bundle-bearing act wire, the legacy ledger admits the decoded
    credential route and the model records the prior effective score, exact named
    bundle and whether it defaulted. The immutable record appends the same bytes. -/
theorem admitted_wire_names_bundle {p q wire s t} (ok : Core8.step p q wire s = some t)
    (isAct : wire[0]? = some (23 : UInt8)) :
    ∃ x i g, Wire5.decode (wire.extract 33 wire.size) = some x ∧ Core8.actRoute x = some (i, g) ∧
      Bound4.next (fun _ => Bound4.digest wire) s.hybrid.inner x.project = some t.hybrid.inner ∧
      let d := Risk8.intentDigest i
      let named := Digest.mk (Core8.slice wire 1 33)
      named = (Risk8.effective s.risk d).bundle ∧
      t.risk.admissions = ⟨d, (Risk8.effective s.risk d).score, named, (Risk8.lookup s.risk d).isNone⟩ ::
        s.risk.admissions ∧ t.record = s.record.push wire := by
  obtain ⟨u, run, hy, risk, record⟩ := submitted ok
  have branch : Core8.act wire s = some u := by simpa [Core8.dispatch, isAct] using run
  obtain ⟨x, i, g, dec, selected, accepted, assessed⟩ := act_ok branch
  obtain ⟨named, entry⟩ := Risk8.admitted_names_assessment assessed
  exact ⟨x, i, g, dec, selected, hy ▸ accepted, named, risk ▸ entry, record⟩

#print axioms threshold_changed
#print axioms admitted_wire_names_bundle
end Aukora.RiskWire8
