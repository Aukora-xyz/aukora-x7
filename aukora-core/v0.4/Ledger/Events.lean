import Types

namespace Aukora

def genesis (head core : Digest) (owner : String) : State :=
  { head, book := { auth := { owner, core } } }

def spendIntent : Event → Option Intent
  | .act i | .upgrade _ _ i => some i
  | _ => none

def spendOK (a : Authority) (e : Event) : Bool :=
  match spendIntent e with
  | none => true
  | some i => decide (i ∈ a.grants ∧ i.generation = a.generation)

def eventOK (b : Book) : Event → Bool
  | .say _ | .outcome _ _ | .advise _ _ => true
  | .remember id src _ =>
      decide (0 < src ∧ src ≤ b.seq) && !(b.claims.any fun c => c.id == id)
  | .correct old replacement _ =>
      decide (old ≠ replacement) && b.claims.any (fun c => c.id == old) &&
        b.claims.any (fun c => c.id == replacement)
  | .grant i verified => verified && decide (i.generation = b.auth.generation ∧ i ∉ b.auth.grants)
  | .act i => match i.body with | .deliver _ => true | .install _ => false
  | .upgrade candidate checked i => checked && decide (i.body = .install candidate)
  | .rebind _ verified => verified

abbrev Eligible (b : Book) (e : Event) : Prop :=
  spendOK b.auth e = true ∧ eventOK b e = true

abbrev Good (s : State) (x : Envelope) : Prop :=
  x.parent = s.head ∧ x.seq = s.book.seq + 1 ∧ Eligible s.book x.event

def spend (a : Authority) (i : Intent) : Authority :=
  { a with grants := a.grants.filter (fun j => decide (j ≠ i)), admitted := i :: a.admitted }

def changeAuth (a : Authority) : Event → Authority
  | .grant i verified => { a with grants := if verified then i :: a.grants else a.grants }
  | .act i => spend a i
  | .upgrade target _ i => { spend a i with core := target }
  | .rebind owner _ => { a with owner, generation := a.generation + 1, grants := [] }
  | _ => a

def advance (b : Book) (e : Event) : Book :=
  { seq := b.seq + 1, auth := changeAuth b.auth e
    claims := match e with
      | .remember id source text => b.claims ++ [⟨id, source, text⟩]
      | _ => b.claims
    corrections := match e with
      | .correct old replacement reason => b.corrections ++ [⟨old, replacement, reason⟩]
      | _ => b.corrections }

def appendEvent (digest : Hasher) (s : State) (x : Envelope) : State :=
  { head := digest x, book := advance s.book x.event, record := s.record ++ [x]
    lines := match x.event with | .say l => s.lines ++ [l] | _ => s.lines
    outcomes := match x.event with | .outcome i r => s.outcomes ++ [(i, r)] | _ => s.outcomes
    advice := match x.event with | .advise c k => s.advice ++ [(c, k)] | _ => s.advice }

def next (digest : Hasher) (s : State) (x : Envelope) : Option State :=
  if Good s x then some (appendEvent digest s x) else none

def step (d : Hasher) (s : State) (x : Envelope) : State :=
  (next d s x).getD s

def replay (d : Hasher) (s : State) : List Envelope → State
  | [] => s
  | x :: xs => replay d (step d s x) xs

def accepted (d : Hasher) (s : State) : List Envelope → List Envelope
  | [] => []
  | x :: xs => match next d s x with
    | none => accepted d s xs
    | some t => x :: accepted d t xs

def pack (s : State) (e : Event) : Envelope := ⟨s.head, s.book.seq + 1, e⟩

def Passive : Event → Prop
  | .say _ | .remember _ _ _ | .correct _ _ _ | .advise _ _ | .outcome _ _ => True
  | _ => False

end Aukora
