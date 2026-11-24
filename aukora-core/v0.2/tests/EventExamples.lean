import Proofs.Events

namespace Aukora
namespace Witness
-- Deliberately colliding examples. No injectivity, cryptographic or host assumption is used.
def d0 : Digest := ⟨[0]⟩
def d1 : Digest := ⟨[1]⟩
def d2 : Digest := ⟨[2]⟩
def digest (x : Envelope) : Digest :=
  match x.event with
  | .advise _ 0 => d1
  | .advise _ _ => d2
  | _ => d0
def initial := genesis d0 d0 "owner"
def send : Intent := ⟨.deliver [42], "dest", 0, 1⟩
def install : Intent := ⟨.install d1, "core", 0, 2⟩
def after (s : State) (e : Event) := appendEvent digest s (pack s e)
def call (s : State) (e : Event) := next digest s (pack s e)
def granted := after initial (.grant send true)
def queue (s : State) : List Event → List Envelope
  | [] => []
  | e :: es => pack s e :: queue (after s e) es

-- L1 witness: a refusal and an accepted line yield the same populated state as the line.
theorem replay_witness :
    let x := pack initial (.say "hello")
    let bad := {x with seq := 2}
    accepted digest initial [bad, x] = [x] ∧
    (replay digest initial [bad, x]).lines = ["hello"] := by decide
#print axioms replay_witness

-- L2 witness: two distinct accepted lines remain in order, even with equal heads.
theorem record_witness :
    let xs := queue initial [.say "first", .say "second"]
    (replay digest initial xs).record = xs ∧ (replay digest initial xs).lines = ["first", "second"] := by decide
#print axioms record_witness

-- L3 witness: the same event succeeds with the correct parent and next sequence.
theorem parent_witness : call initial (.say "hello") = some (after initial (.say "hello")) := by decide
#print axioms parent_witness

-- L4 witness: an actual grant succeeds and exactly one of two locally addressed acts wins.
theorem once_witness :
    let xs := queue initial [.grant send true, .act send, .act send]
    call initial (.grant send true) = some granted ∧
    call granted (.act send) = some (after granted (.act send)) ∧
    (replay digest initial xs).book.auth.admitted = [send] ∧
    call (after granted (.act send)) (.act send) = none := by decide
#print axioms once_witness

-- L5 witness: all five passive event kinds pass with a real unspent grant present.
theorem passive_witness :
    let xs := queue granted [.say "source", .remember 3 2 "one", .remember 4 2 "two",
      .correct 3 4 "revision", .advise "a" 7, .outcome send .unknown]
    accepted digest granted xs = xs ∧
    (replay digest granted xs).book.auth.grants = [send] := by decide
#print axioms passive_witness

-- L6 witness: scores and immediate heads differ. Both chains then accept the same act.
theorem advice_witness :
    let a := after granted (.advise "cell" 0)
    let b := after granted (.advise "cell" 9)
    call granted (.advise "cell" 0) = some a ∧ call granted (.advise "cell" 9) = some b ∧
    a.head ≠ b.head ∧ a.advice ≠ b.advice ∧
    call a (.act send) = some (after a (.act send)) ∧
    call b (.act send) = some (after b (.act send)) := by decide
#print axioms advice_witness

-- Literal L6 fails with an identical suffix of envelopes containing the first chain's parent.
theorem raw_suffix_counterexample :
    let a := after granted (.advise "cell" 0)
    let b := after granted (.advise "cell" 9)
    let x := pack a (.act send)
    (step digest a x).book.auth.admitted = [send] ∧
    (step digest b x).book.auth.admitted = [] := by decide
#print axioms raw_suffix_counterexample

-- L7 witness: an actual rebind kills a live grant. The new generation can issue another.
theorem rebind_witness :
    let r := after granted (.rebind "second-owner" true)
    let fresh := { send with generation := 1 }
    call initial (.grant send true) = some granted ∧
    call granted (.rebind "second-owner" true) = some r ∧ r.book.auth.grants = [] ∧
    call r (.act send) = none ∧ call r (.grant fresh true) = some (after r (.grant fresh true)) := by decide
#print axioms rebind_witness

-- L8 witness: exact verified target, live grant, and passed check produce a different core.
theorem upgrade_witness :
    let g := after initial (.grant install true)
    let u := after g (.upgrade d1 true install)
    call initial (.grant install true) = some g ∧ call g (.upgrade d1 true install) = some u ∧
    u.book.auth.core ≠ g.book.auth.core ∧ u.book.auth.grants = [] ∧
    call g (.upgrade d2 true install) = none ∧ call g (.upgrade d1 false install) = none := by decide
#print axioms upgrade_witness

end Witness
end Aukora
