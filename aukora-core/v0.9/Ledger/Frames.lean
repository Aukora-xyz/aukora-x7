import Ledger.Events

namespace Aukora.R2

structure Mandate where
  audience : String
  payload : Bytes
  generation : Nat
  count : Nat
  expiry : Nat
  deriving DecidableEq
structure Budget where
  generation : Nat
  cap : Nat
  deriving DecidableEq
structure Pass where
  reader : String
  scope : String
  generation : Nat
  expiry : Nat
  deriving DecidableEq

-- A control event's Boolean reports current-owner verification of the exact request.
-- read's Boolean reports authentication of the named reader. Expiry is inclusive.
inductive Action where
  | base (e : Event)
  | retract (count : Nat) (ownerVerified : Bool)
  | mandate (m : Mandate) (ownerVerified : Bool)
  | useMandate (id : Nat) (request : Event)
  | grantBudget (b : Budget) (ownerVerified : Bool)
  | spend (id amount : Nat)
  | pass (p : Pass) (ownerVerified : Bool)
  | revoke (id : Nat) (ownerVerified : Bool)
  | read (id : Nat) (reader scope : String) (readerVerified : Bool)
  deriving DecidableEq

structure Frame where
  parent : Digest
  seq : Nat
  action : Action
  deriving DecidableEq

structure Ledger where
  head : Digest
  book : Book
  history : List Frame := []     -- Chronological. Its zero-based positions are stable IDs.
  active : List Nat := []        -- Newest line address first.
  deriving DecidableEq

def initial (head core : Digest) (owner : String) : Ledger :=
  ⟨head, (genesis head core owner).book, [], []⟩

def lookup (f : Action → Option α) (h : List Frame) (id : Nat) : Option α := do
  let x ← h[id]?
  f x.action

def lineAt := lookup (fun | .base (.say text) => some text | _ => none)
def mandateAt := lookup (fun | .mandate m true => some m | _ => none)
def budgetAt := lookup (fun | .grantBudget b true => some b | _ => none)
def passAt := lookup (fun | .pass p true => some p | _ => none)

def revoked (h : List Frame) (id : Nat) : Bool :=
  h.any fun x => match x.action with | .revoke key true => key == id | _ => false

inductive Meter where | money | uses deriving DecidableEq
def debit : Action → Option (Meter × Nat × Nat)
  | .spend id n => some (.money, id, n)
  | .useMandate id _ => some (.uses, id, 1)
  | _ => none

def quantity (meter : Meter) (id : Nat) (e : Action) : Nat :=
  match debit e with
  | some (m,k,n) => if m = meter ∧ k = id then n else 0
  | none => 0

def total (h : List Frame) (m : Meter) (id : Nat) : Nat :=
  (h.map (fun x => quantity m id x.action)).sum

def limit (h : List Frame) (m : Meter) (id : Nat) : Nat :=
  match m with
  | .money => ((budgetAt h id).map Budget.cap).getD 0
  | .uses => ((mandateAt h id).map Mandate.count).getD 0

def withinLimit (h : List Frame) (e : Action) : Bool :=
  match debit e with
  | some (m,id,n) => decide (total h m id + n ≤ limit h m id)
  | none => true

def inScope (s : Ledger) (m : Mandate) : Event → Bool
  | .act i => decide (i.audience = m.audience ∧ i.body = .deliver m.payload ∧
      i.generation = m.generation ∧ m.generation = s.book.auth.generation ∧ s.book.seq + 1 ≤ m.expiry)
  | _ => false

def policy (s : Ledger) : Action → Bool
  | .base e => decide (Eligible s.book e)
  | .retract n ok => ok && decide (0 < n ∧ n ≤ s.active.length)
  | .mandate m ok => ok && decide (m.generation = s.book.auth.generation ∧
      0 < m.count ∧ s.book.seq + 1 < m.expiry)
  | .useMandate id op => (mandateAt s.history id).any (fun m => inScope s m op)
  | .grantBudget b ok => ok && decide (b.generation = s.book.auth.generation)
  | .spend id n => (budgetAt s.history id).any (fun b => decide (b.generation = s.book.auth.generation ∧ 0 < n))
  | .pass p ok => ok && decide (p.generation = s.book.auth.generation ∧ s.book.seq + 1 < p.expiry)
  | .revoke id ok => ok && (passAt s.history id).isSome && !(revoked s.history id)
  | .read id reader scope verified => verified && !(revoked s.history id) &&
      (passAt s.history id).any (fun p => decide (reader = p.reader ∧ scope = p.scope ∧
        p.generation = s.book.auth.generation ∧ s.book.seq + 1 ≤ p.expiry))

def nextBook (b : Book) : Action → Book
  | .base e => advance b e
  | .useMandate _ (.act i) => {b with seq := b.seq + 1, auth := {b.auth with admitted := i :: b.auth.admitted}}
  | _ => {b with seq := b.seq + 1}

def nextView (s : Ledger) : Action → List Nat
  | .base (.say _) => s.history.length :: s.active
  | .retract n _ => s.active.drop n
  | _ => s.active

def append (d : Frame → Digest) (s : Ledger) (x : Frame) : Ledger :=
  ⟨d x, nextBook s.book x.action, s.history ++ [x], nextView s x.action⟩
def Allowed (s : Ledger) (x : Frame) : Prop :=
  x.parent = s.head ∧ x.seq = s.book.seq + 1 ∧ policy s x.action = true ∧ withinLimit s.history x.action = true
instance (s : Ledger) (x : Frame) : Decidable (Allowed s x) := inferInstanceAs (Decidable (_ ∧ _ ∧ _ ∧ _))
def next (d : Frame → Digest) (s : Ledger) (x : Frame) : Option Ledger :=
  if Allowed s x then some (append d s x) else none
def step (d : Frame → Digest) (s : Ledger) (x : Frame) := (next d s x).getD s
def replay (d : Frame → Digest) (s : Ledger) (xs : List Frame) := xs.foldl (step d) s

theorem next_spec {d s x t} (ok : next d s x = some t) : Allowed s x ∧ t = append d s x := by
  unfold next at ok
  split at ok <;> simp_all
#print axioms next_spec

end Aukora.R2
