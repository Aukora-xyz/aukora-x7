import Proofs.PublicPolicy

namespace Aukora.Release
open R6.KernelCell (Context)

abbrev State := Policy9.Machine
abbrev Input := Core9PolicyLaws.Input

/-- The candidate supplies the operations exposed to the adapter. All candidates share the public state schema. -/
structure Ops where
  step : Context → ByteArray → State → Option State
  feed : ByteArray → State → State
  reset : State → State
  stamp : ByteArray → State → Option State
  outcome : State → ByteArray → Nat

structure WireGrammar where
  versionTwo : Bool := false
  /-- Each entry owns a new ff VV namespace, beginning with VV = 3. -/
  later : List (State → ByteArray → Option R2.Frame) := []

structure Model extends Ops where
  genesis : ByteArray → Option State
  grammar : WireGrammar := {}

instance : Coe Model Ops := ⟨Model.toOps⟩

def newest : Model := ⟨⟨Core9.step, Core9.feed, Core9.reset, Core9.stamp, Core9.outcome⟩, Core9.genesis, {}⟩

def withGenesis (m : Model) (f : ByteArray → ByteArray) : Model :=
  {m with genesis := m.genesis ∘ f}

abbrev ledger (s : State) := s.base.hybrid.inner.ledger
abbrev owner (s : State) := s.base.hybrid.owner
abbrev pool (s : State) := Policy9.pool s.base
abbrev auth (s : State) := (owner s, (ledger s).book.auth)

def execute (m : Ops) (ctx : Context) (s : State) : Input → State
  | .frame w => (m.step ctx w s).getD s
  | .feed b => m.feed b s
  | .reset => m.reset s
  | .stamp w => (m.stamp w s).getD s

def run (m : Ops) (ctx : Context) (s : State) : List Input → State
  | [] => s
  | c :: cs => run m ctx (execute m ctx s c) cs

theorem newest_execute (ctx s c) : execute newest ctx s c = Core9PolicyLaws.execute ctx s c := by
  cases c <;> rfl

theorem newest_run (ctx s xs) : run newest ctx s xs = Core9PolicyLaws.run ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih => simp only [run, Core9PolicyLaws.run, newest_execute, ih]

end Aukora.Release
