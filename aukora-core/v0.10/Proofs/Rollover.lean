import Proofs.ChainFinal
import Proofs.ReserveAuth

namespace Aukora.SegmentFinal

/-- The immutable adapter interprets these ports for every carried machine. A
    future change to an adapter port belongs to the executable lineage boundary. -/
structure Rollover (m : Release.Model) : Prop where
  closed : ∀ x : Session, x.quota.closed = true → ∀ ctx law w,
    SessionFinal.frame m ctx x.quota x.machine w = none ∧
    SessionFinal.stamp m x.quota x.machine w = none ∧ finish x law w = none
  available : ∀ (x : Session) law wire pin, x.quota.closed = false →
    closeRecord x.journal law wire x.machine = some pin →
    ∃ done_ next, finish x law wire = some done_ ∧
      resume done_ law (expectedGenesis pin law x.machine) = some next ∧ next.quota = {}
  origin : ∀ {x y : Session} {law data}, resume x law data = some y →
    x.quota.closed = true ∧ ∃ pin, x.sealPin = some pin ∧
      data = genesisData pin law (keyData x.machine) ∧ y.quota = {} ∧ y.sealPin = none ∧
      y.journal = digest data ∧ Safe11.halted y.machine = Safe11.halted x.machine ∧
      ∀ i, Policy9.Closed x.machine i → Policy9.grantOK y.machine i = false
  chain : ∀ {a b : ChainFinal.Seed} {records}, ChainFinal.Consecutive a b records → a.data ≠ b.data →
    ∀ p ∈ records, p.1.next.data ≠ p.2.next.data ∧ digest p.1.next.data ≠ digest p.2.next.data
  altered : ∀ {a b : ChainFinal.Seed} {x y : ChainFinal.Record}, ChainFinal.Edge a b x y →
    (a.data ≠ b.data ∨ x.marks ≠ y.marks) → x.next.data ≠ y.next.data

theorem rollover (m : Release.Model) : Rollover m where
  closed := fun _ h => sealed_admits_nothing h m
  available := fun _ _ _ _ => continue_available
  origin := exact_successor
  chain := ChainFinal.every_later_genesis
  altered := ChainFinal.altered_record_changes_next

#print axioms rollover
end Aukora.SegmentFinal
