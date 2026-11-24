import Root12
import SessionFinal

namespace Aukora.RootFinal
open Release
open R6.KernelCell (Context)
open SessionFinal (Quota charge candidateRecovery)

/-- The segment wrapper may reject a staging update when sealed or out of staging space. -/
def feedPort (m : Model) (q : Quota) (s : Release.State) (b : ByteArray) : Option Release.State :=
  if q.closed || decide (Bounds12.maxInput < b.size ∨ Bounds12.maxStaged < Bounds12.stageSize s + b.size)
    then none else some (m.feed b s)

def resetPort (m : Model) (q : Quota) (s : Release.State) : Option Release.State :=
  if q.closed then none else some (m.reset s)

structure PublicPorts (m : Model) : Prop where
  frame : ∀ ctx q q' s w, charge q w.size (candidateRecovery w) = some q' →
    SessionFinal.frame m ctx q s w = (m.step ctx w s).map (fun t => (q',t))
  frameRefused : ∀ ctx q s w, charge q w.size (candidateRecovery w) = none →
    SessionFinal.frame m ctx q s w = none
  stamp : ∀ q q' s w, charge q w.size false = some q' →
    SessionFinal.stamp m q s w = (m.stamp w s).map (fun t => (q',t))
  stampRefused : ∀ q s w, charge q w.size false = none → SessionFinal.stamp m q s w = none
  feed : ∀ q s b, q.closed = false → b.size ≤ Bounds12.maxInput →
    Bounds12.stageSize s + b.size ≤ Bounds12.maxStaged → Root12.Open s (.feed b) →
    feedPort m q s b = some (Root12.fed b s)
  feedRefused : ∀ q s b, q.closed = true ∨ Bounds12.maxInput < b.size ∨ Bounds12.maxStaged < Bounds12.stageSize s + b.size →
    feedPort m q s b = none
  reset : ∀ q s, q.closed = false → Root12.Open s .reset → resetPort m q s = some (Root12.cleared s)
  resetRefused : ∀ q s, q.closed = true → resetPort m q s = none

theorem ports_of_replay {m : Model} (replay : Root12.Replay m) : PublicPorts m where
  frame := by
    intro ctx q q' s w paid
    cases h : m.step ctx w s <;> simp [SessionFinal.frame,paid,h]
  frameRefused := fun _ _ _ _ h => by simp [SessionFinal.frame,h]
  stamp := by
    intro q q' s w paid
    cases h : m.stamp w s <;> simp [SessionFinal.stamp,paid,h]
  stampRefused := fun _ _ _ h => by simp [SessionFinal.stamp,h]
  feed := by
    intro q s b open_ input stage ok
    simp [feedPort,open_,Nat.not_lt_of_ge input,Nat.not_lt_of_ge stage,replay.feedWhen s b ok]
  feedRefused := by
    intro q s b h
    rcases h with closed | input | stage <;> simp_all [feedPort]
  reset := fun q s open_ ok => by simp [resetPort,open_,replay.resetWhen s ok]
  resetRefused := fun q s h => by simp [resetPort,h]

#print axioms ports_of_replay
end Aukora.RootFinal
