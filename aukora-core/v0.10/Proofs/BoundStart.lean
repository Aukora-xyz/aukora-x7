import Bound12c
import Proofs.FinalHistory
import Proofs.InstalledPorts
import Versions

/-! Round 12c D2, item 1. The clauses of the 37 that speak of the start state name
`m.genesis` literally, so they cover the ordinary genesis only. A bound start
(`Bound12c.genesis`) is an ordinary start with another head (`Bound12c.genesis_old`).
Here each such clause is stated again, unchanged except that the start comes from
`Bound12c.genesis`, and proved for the full machine.

The clause `record.ledger` also names `m.genesis`, but its conclusion quantifies over
every state and never mentions the start, so it already covers runs from a bound start;
it needs no twin. -/

namespace Aukora.RootFinal.BoundStart
open Release
open Safe11 (innerModel)
open Versions
open R6.KernelCell (Context)
open private Release.initialLedger from Proofs.History
open private Root12.History12.view from Proofs.Root12Record
open private Versions.allFindings from Versions

/-- Law b3: the start clauses of the 37, for a record started by bound genesis. -/
def StartClauses (m : Model) : Prop :=
  ∀ law keys host start, Bound12c.genesis law keys host = some start →
    -- twin of `record.view`
    (∀ ctx xs, R2.ViewSound (ledger (run m ctx start xs))) ∧
    -- twin of `memory`
    Memory m start ∧
    -- twin of `outcome`
    Outcome m start ∧
    -- twin of the start part of `grants`
    ((ledger start).history = [] ∧ pool start = [] ∧ ∀ ctx xs i, i ∈ pool (run m ctx start xs) →
      GrantOrigin9.Signed (owner (run m ctx start xs)) i) ∧
    -- twin of `floor`
    Ports.Floor m start ∧
    -- twin of the start part of `threshold`
    start.base.risk.threshold = 0

theorem full_start : StartClauses innerModel := by
  intro law keys host s ok
  obtain ⟨b, gb, hs⟩ := Bound12c.genesis_old ok
  have g : newest.genesis keys = some b := gb
  have init := Release.initialLedger g
  have sInit : (ledger s).history = [] ∧ (ledger s).active = [] ∧ (ledger s).book.seq = 0 ∧
      (ledger s).book.claims = [] := by rw [hs]; exact init
  have sPool : pool s = [] := by rw [hs]; exact (newest_lawful.grants.2 keys b g).2.1
  have signedInit : ∀ i ∈ pool s, GrantOrigin9.Signed (owner s) i := by
    intro i h
    rw [sPool] at h
    exact False.elim (List.not_mem_nil h)
  have hist : ∀ ctx xs, (ledger (run innerModel ctx s xs)).history = Root12.Grammar.history innerModel ctx s xs := by
    intro ctx xs
    rw [Root12.full_record.ledger keys b g ctx s xs, sInit.1, List.nil_append]
  have empty : s.outcomes = [] := by
    rw [hs]
    change (Core8.genesis keys).map _ = some b at gb
    obtain ⟨c, _, rfl⟩ := Option.map_eq_some'.mp gb
    rfl
  refine ⟨?_, memory_from ⟨sInit.1, sInit.2.2.1, sInit.2.2.2⟩ hist, ?_,
    ⟨sInit.1, sPool, signed_from signedInit⟩, Ports.floor_of_legacy (floor_from signedInit) full_binding,
    by rw [hs]; exact (initial_threshold g : b.base.risk.threshold = 0)⟩
  · intro ctx xs
    apply Root12.History12.view
    intro id member
    rw [sInit.2.1] at member
    exact False.elim (List.not_mem_nil member)
  · constructor
    · intro ctx xs i
      dsimp only
      unfold everConfirmed
      rw [hist]
      by_cases h : ∃ f ∈ Root12.Grammar.history innerModel ctx s xs, f.action = .base (.outcome i .confirmed)
      · have yes : (Root12.Grammar.history innerModel ctx s xs).any
          (fun f => decide (f.action = .base (.outcome i .confirmed))) = true := by simpa using h
        simp [yes, h]
      · have no : (Root12.Grammar.history innerModel ctx s xs).any
          (fun f => decide (f.action = .base (.outcome i .confirmed))) = false := by simpa using h
        simp [no, h]
    · intro ctx xs d
      dsimp only
      have trace := Versions.allFindings ctx s xs
      rw [empty, List.append_nil] at trace
      exact ⟨trace, by change Policy9.outcomeCode _ d = _; rw [← trace]⟩

#print axioms full_start
end Aukora.RootFinal.BoundStart
