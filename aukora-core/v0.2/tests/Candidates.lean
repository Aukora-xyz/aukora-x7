import Laws
import FixedGenesis
import tests.LegacyGrantProof

namespace R9Candidate
open Aukora.Release

/-- The candidate model changes only the genesis key transformation. -/
def successor : Model := withGenesis newest fixedKey

/-- The source function selected by the fixed Wasm link is precisely this model's genesis. -/
theorem successor_genesis (bytes : ByteArray) : successor.genesis bytes = fixedGenesis bytes := rfl

theorem successor_operations : successor.toOps = newest.toOps := rfl

theorem successor_lawful : Lawful successor := lawful_withGenesis newest_lawful fixedKey

/-- The historical observed grant is an explicit counterexample to the hybrid grant law. -/
theorem ed_only_unlawful : ¬ Lawful edOnly := fun law => legacyGrantFails law.grant

#print axioms ed_only_unlawful
#print axioms successor_lawful
end R9Candidate
