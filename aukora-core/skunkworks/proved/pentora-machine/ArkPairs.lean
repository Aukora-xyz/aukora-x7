import ArkDefs
import Pentora

namespace Pentora

/-- Number distinct pairs by their larger endpoint, then by their smaller one.
    There are 0 + 1 + ... + (hi - 1) pairs before the block for hi. -/
def pairRow (a b : Fin 5) : Nat :=
  let hi := max a.val b.val
  hi * (hi - 1) / 2 + min a.val b.val

theorem pairRow_symm : ∀ a b : Fin 5, pairRow a b = pairRow b a := by decide +kernel

theorem pairRow_bijection :
    (∀ a b : Fin 5, a ≠ b → pairRow a b < 10) ∧
    (∀ a b c d : Fin 5, a ≠ b → c ≠ d → (pairRow a b = pairRow c d ↔ (a = c ∧ b = d) ∨ (a = d ∧ b = c))) ∧
    (∀ r : Fin 10, ∃ a b : Fin 5, a ≠ b ∧ pairRow a b = r.val) := by
  refine ⟨by decide +kernel, by decide +kernel, ?_⟩
  have hits : ∀ r : Fin 10, (fins 5).any (fun a =>
      (fins 5).any fun b => a != b && pairRow a b == r.val) = true := by decide +kernel
  intro r
  simpa [List.any_eq_true, mem_fins] using hits r

/-- Enumerating the other endpoints in order gives the incident row labels in order. -/
def organRows (x : Fin 5) : List Nat :=
  ((fins 5).filter fun y => y != x).map (pairRow x)

theorem organRows_four : ∀ x : Fin 5, (organRows x).length = 4 ∧ (organRows x).Nodup := by decide +kernel

theorem organRows_common : ∀ a b : Fin 5, a ≠ b → ((organRows a).filter fun r => (organRows b).contains r) = [pairRow a b] := by decide +kernel

/-- Each row held by at least one selected organ appears once. -/
def coveredRows (organs : List (Fin 5)) : List Nat := (organs.flatMap organRows).eraseDups

theorem coverage_counts :
    (∀ a, (coveredRows [a]).length = 4) ∧
    (∀ a b, a ≠ b → (coveredRows [a,b]).length = 7) ∧
    (∀ a b c, [a,b,c].Nodup → (coveredRows [a,b,c]).length = 9) ∧
    (∀ a b c d, [a,b,c,d].Nodup → (coveredRows [a,b,c,d]).length = 10) := by decide +kernel

private def rowMask (x : Fin 5) : Nat :=
  (organRows x).foldl (fun mask row => mask ||| (1 <<< row)) 0

set_option maxRecDepth 8192 in
set_option maxHeartbeats 1600000 in
/-- Verify both products on the four actual labels using ARK's candidate inverse for their mask. -/
theorem one_organ_rebuilds (x : Fin 5) : ∃ b, Aukora.Ark.TwoSided (organRows x) b := by
  have checked : ∀ c : Fin 5,
      Aukora.Ark.checksProducts (organRows c) (Aukora.Ark.inverseAt (rowMask c)) = true := by decide
  exact ⟨Aukora.Ark.inverseAt (rowMask x), (Aukora.Ark.checksProducts_spec _ _).mp (checked x)⟩

end Pentora
