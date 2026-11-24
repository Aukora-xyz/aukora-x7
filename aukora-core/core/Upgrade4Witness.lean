import core.Stateful4

namespace Aukora.Stateful4

open Bound4

/-- For arbitrary candidate bytes, construct a grant and upgrade from genesis.
    This is the decoded path used by stepBytes. The witness uses the real frame
    hash and candidate hash and makes both host verdicts explicit. -/
theorem grant_then_upgrade (bytes : ByteArray) :
    let s := initial 0
    let i : Intent := ⟨.install (digest bytes), "core", 0, 1⟩
    let g : R2.Frame := ⟨s.ledger.head, 1, .base (.grant i true)⟩
    ∃ granted final, Bound4.next frameDigest s g = some granted ∧
      let staged := feed bytes granted
      let u : R2.Frame := ⟨staged.ledger.head, 2, .base (.upgrade (digest bytes) true i)⟩
      Bound4.next frameDigest staged u = some final ∧ final.ledger.book.auth.core = digest bytes ∧
        i ∉ final.ledger.book.auth.grants := by
  dsimp only
  let s := initial 0
  let i : Intent := ⟨.install (digest bytes), "core", 0, 1⟩
  let g : R2.Frame := ⟨s.ledger.head, 1, .base (.grant i true)⟩
  let granted : Machine := ⟨R2.append frameDigest s.ledger g, ByteArray.empty⟩
  have gOK : R2.Allowed s.ledger g := by
    simp [R2.Allowed, R2.policy, R2.withinLimit, R2.debit, g, s, initial, R2.initial,
      genesis, i, spendOK, spendIntent, eventOK]
  have grantedOK : Bound4.next frameDigest s g = some granted := by
    rw [Bound4.next, if_pos (by rfl), R2.next, if_pos gOK]
    rfl
  let staged := feed bytes granted
  let u : R2.Frame := ⟨staged.ledger.head, 2, .base (.upgrade (digest bytes) true i)⟩
  have same : staged.candidate = bytes := by
    change ByteArray.empty ++ bytes = bytes
    cases bytes with
    | mk a =>
      apply congrArg ByteArray.mk
      change (#[] : Array UInt8).extract 0 0 ++ a.extract 0 (0 + a.size) ++
        (#[] : Array UInt8).extract _ 0 = a
      simp
  have uOK : R2.Allowed staged.ledger u := by
    simp [R2.Allowed, R2.policy, R2.withinLimit, R2.debit, u, staged, feed, granted, g, s, i,
      R2.append, R2.nextBook, advance, changeAuth, initial, R2.initial, genesis, spendOK,
      spendIntent, eventOK]
  have accept := Bound4.upgrade_accepts (d := frameDigest) (x := u) (i := i)
    rfl (congrArg digest same) uOK
  have facts := Bound4.upgrade_facts accept (show u.action = .base (.upgrade (digest bytes) true i) from rfl)
  exact ⟨granted, _, grantedOK, accept, facts.2.2.2.2.1.trans (congrArg digest same), facts.2.2.2.2.2⟩
#print axioms grant_then_upgrade

end Aukora.Stateful4
