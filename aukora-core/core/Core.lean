/- Round 1. Cryptographic strength, key custody, hosts and screens, the Lean-to-Wasm
   compiler, and the choice of laws are outside these proofs. Digests support equality.
   Both hosts use the same deterministic digest function, which may even be constant. -/
namespace Aukora

abbrev Bytes := List UInt8

structure Digest where
  bytes : Bytes
  deriving DecidableEq, Repr

inductive Body where
  | deliver (payload : Bytes)
  | install (target : Digest)
  deriving DecidableEq, Repr

structure Intent where
  body : Body
  audience : String
  generation : Nat
  nonce : Nat
  deriving DecidableEq, Repr

inductive Result where
  | confirmed | failed | unknown
  deriving DecidableEq, Repr

inductive Event where
  | say (line : String)
  | remember (id source : Nat) (text : String)
  | correct (old replacement : Nat) (reason : String)
  -- Host reports verification by the currently bound owner over this exact intent.
  | grant (intent : Intent) (ownerVerified : Bool)
  | act (intent : Intent)
  -- The destination's report is input, including when it reports uncertainty.
  | outcome (intent : Intent) (reported : Result)
  | advise (cell : String) (score : Nat)
  -- Host reports proof checking for this exact candidate. The old core checks its grant.
  | upgrade (newCore : Digest) (proofChecked : Bool) (intent : Intent)
  -- Host reports current-owner verification over this binding at the current generation.
  | rebind (newOwner : String) (ownerVerified : Bool)
  deriving DecidableEq, Repr

structure Envelope where
  parent : Digest
  seq : Nat
  event : Event
  deriving DecidableEq, Repr

abbrev Hasher := Envelope → Digest

structure Authority where
  owner : String
  generation : Nat := 0
  core : Digest
  grants : List Intent := []
  admitted : List Intent := []
  deriving DecidableEq, Repr

structure Claim where
  id : Nat
  source : Nat  -- Earlier envelope sequence number, starting at one.
  text : String
  deriving DecidableEq, Repr

structure Correction where
  old : Nat
  replacement : Nat
  reason : String
  deriving DecidableEq, Repr

-- Data that can influence acceptance of the next correctly addressed envelope.
structure Book where
  seq : Nat := 0
  auth : Authority
  claims : List Claim := []
  corrections : List Correction := []
  deriving DecidableEq, Repr

structure State where
  head : Digest
  book : Book
  record : List Envelope := []
  lines : List String := []
  outcomes : List (Intent × Result) := []
  advice : List (String × Nat) := []
  deriving DecidableEq, Repr

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

theorem next_spec {d : Hasher} {s t : State} {x : Envelope} (h : next d s x = some t) :
    Good s x ∧ t = appendEvent d s x := by
  -- Round 1 repair (Mythos): the first proof's `simpa` left the gate in the hypothesis.
  unfold next at h
  by_cases ok : Good s x
  · rw [if_pos ok] at h
    exact ⟨ok, (Option.some.inj h).symm⟩
  · rw [if_neg ok] at h
    cases h
#print axioms next_spec

-- L1. Replaying only the accepted envelopes recovers the entire state.
theorem replay_accepted (d : Hasher) (s : State) (xs : List Envelope) :
    replay d s (accepted d s xs) = replay d s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons x xs ih =>
    cases h : next d s x with
    | none => simpa [accepted, replay, step, h] using ih s
    | some t => simpa [accepted, replay, step, h] using ih t
#print axioms replay_accepted

theorem same_accepted_same_state (d : Hasher) (s : State) (xs ys : List Envelope)
    (h : accepted d s xs = accepted d s ys) : replay d s xs = replay d s ys := by
  rw [← replay_accepted d s xs, h, replay_accepted]
#print axioms same_accepted_same_state

-- L2. The final record is the initial record followed by exactly the accepted input.
theorem record_replay (d : Hasher) (s : State) (xs : List Envelope) :
    (replay d s xs).record = s.record ++ accepted d s xs := by
  induction xs generalizing s with
  | nil => simp [replay, accepted]
  | cons x xs ih =>
    cases hx : next d s x with
    | none => simpa [replay, accepted, step, hx] using ih s
    | some t =>
      have hr : t.record = s.record ++ [x] := congrArg State.record (next_spec hx).2
      simpa [replay, accepted, step, hx, hr, List.append_assoc] using ih t
#print axioms record_replay

-- L3. A stale parent is refused and replay leaves every field untouched.
theorem stale_parent (d : Hasher) (s : State) (x : Envelope) (h : x.parent ≠ s.head) :
    next d s x = none ∧ step d s x = s := by
  simp [step, next, Good, h]
#print axioms stale_parent

theorem bad_sequence (d : Hasher) (s : State) (x : Envelope) (h : x.seq ≠ s.book.seq + 1) :
    next d s x = none ∧ step d s x = s := by
  simp [step, next, Good, h]
#print axioms bad_sequence

theorem spend_requires_grant {d : Hasher} {s t : State} {x : Envelope} {i : Intent} (ok : next d s x = some t)
    (use : spendIntent x.event = some i) :
    i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have gate := (next_spec ok).1.2.2.1
  simpa [spendOK, use] using gate
#print axioms spend_requires_grant

theorem absence_after_change (a : Authority) (e : Event) (i : Intent)
    (absent : i ∉ a.grants) (noIssue : e ≠ .grant i true) :
    i ∉ (changeAuth a e).grants := by
  cases e with
  | grant j verified =>
    cases verified with
    | false => simpa [changeAuth] using absent
    | true =>
      have ne : i ≠ j := by intro h; subst j; exact noIssue rfl
      simp [changeAuth, ne, absent]
  | _ => simp_all [changeAuth, spend, List.mem_filter]
#print axioms absence_after_change

theorem absence_replay (d : Hasher) (s : State) (xs : List Envelope) (i : Intent)
    (absent : i ∉ s.book.auth.grants)
    (noIssue : ∀ x ∈ xs, x.event ≠ .grant i true) :
    i ∉ (replay d s xs).book.auth.grants := by
  induction xs generalizing s with
  | nil => exact absent
  | cons x xs ih =>
    apply ih (s := step d s x)
    · cases hx : next d s x with
      | none => simpa [step, hx] using absent
      | some t =>
        have ha := absence_after_change s.book.auth x.event i absent
          (noIssue x (List.mem_cons_self ..))
        simpa only [step, hx, Option.getD_some, (next_spec hx).2, appendEvent, advance] using ha
    · intro y hy
      exact noIssue y (List.mem_cons_of_mem x hy)
#print axioms absence_replay

-- L4. One accepted act records and consumes its exact grant. No later act or upgrade
-- can spend it after any intervening trace without a new verified grant for that intent.
-- The ownerVerified field reports host verification over the exact intent.
theorem one_grant_once (d : Hasher) (s t : State) (x : Envelope) (i : Intent)
    (ok : next d s x = some t) (act : x.event = .act i) :
    t.book.auth.admitted = i :: s.book.auth.admitted ∧ i ∉ t.book.auth.grants ∧
    ∀ (xs : List Envelope), (∀ y ∈ xs, y.event ≠ .grant i true) →
      ∀ y : Envelope, spendIntent y.event = some i →
        next d (replay d t xs) y = none := by
  have ht := (next_spec ok).2
  have spent : i ∉ t.book.auth.grants := by
    simp [ht, appendEvent, advance, act, changeAuth, spend, List.mem_filter]
  refine ⟨?_, spent, ?_⟩
  · simp [ht, appendEvent, advance, act, changeAuth, spend]
  · intro xs noIssue y use
    have missing := absence_replay d t xs i spent noIssue
    cases hy : next d (replay d t xs) y with
    | none => rfl
    | some u => exact False.elim (missing (spend_requires_grant hy use).1)
#print axioms one_grant_once

def Passive : Event → Prop
  | .say _ | .remember _ _ _ | .correct _ _ _ | .advise _ _ | .outcome _ _ => True
  | _ => False

-- L5. An accepted passive event preserves every authority field.
theorem passive_preserves_authority {d : Hasher} {s t : State} {x : Envelope} (h : next d s x = some t)
    (passive : Passive x.event) : t.book.auth = s.book.auth := by
  rw [(next_spec h).2]
  change changeAuth s.book.auth x.event = s.book.auth
  cases he : x.event <;> simp_all [Passive, changeAuth]
#print axioms passive_preserves_authority

-- Only a score is erased. Each host addresses proposals to its own actual head.
def maskScore : Event → Event
  | .advise cell _ => .advise cell 0
  | e => e

def bookStep (b : Book) (e : Event) : Book :=
  if Eligible b e then advance b e else b

def localReplay (d : Hasher) (s : State) : List Event → State
  | [] => s
  | e :: es => localReplay d (step d s (pack s e)) es

theorem project_step (d : Hasher) (s : State) (e : Event) :
    (step d s (pack s e)).book = bookStep s.book (maskScore e) := by
  have erase : bookStep s.book (maskScore e) = bookStep s.book e := by cases e <;> rfl
  rw [erase]
  -- Round 1 repair (Mythos): `simp` did not discharge the gate; do it by hand.
  have good : Good s (pack s e) ↔ Eligible s.book e := by
    constructor
    · intro h; exact h.2.2
    · intro h; exact ⟨rfl, rfl, h⟩
  by_cases gate : Eligible s.book e
  · have hn : next d s (pack s e) = some (appendEvent d s (pack s e)) := if_pos (good.mpr gate)
    show ((next d s (pack s e)).getD s).book = bookStep s.book e
    rw [hn]
    show (appendEvent d s (pack s e)).book = bookStep s.book e
    unfold bookStep
    rw [if_pos gate]
    rfl
  · have hn : next d s (pack s e) = none := if_neg (fun h => gate (good.mp h))
    show ((next d s (pack s e)).getD s).book = bookStep s.book e
    rw [hn]
    unfold bookStep
    rw [if_neg gate]
    rfl
#print axioms project_step

theorem project_replay (d : Hasher) (s : State) (xs : List Event) :
    (localReplay d s xs).book = (xs.map maskScore).foldl bookStep s.book := by
  induction xs generalizing s with
  | nil => rfl
  | cons e es ih =>
    simpa only [localReplay, List.map_cons, List.foldl_cons, project_step] using
      ih (step d s (pack s e))
#print axioms project_replay

-- L6. Equal proposals modulo advice scores give equal authority under local framing.
theorem advice_only (d : Hasher) (s t : State) (xs ys : List Event)
    (start : s.book = t.book) (aligned : xs.map maskScore = ys.map maskScore) :
    (localReplay d s xs).book.auth = (localReplay d t ys).book.auth := by
  rw [project_replay, project_replay, start, aligned]
#print axioms advice_only

theorem generation_mono_step (d : Hasher) (s : State) (x : Envelope) :
    s.book.auth.generation ≤ (step d s x).book.auth.generation := by
  by_cases g : Good s x
  · simp only [step, next, if_pos g, Option.getD_some]
    change s.book.auth.generation ≤ (changeAuth s.book.auth x.event).generation
    cases x.event <;> simp [changeAuth, spend, Nat.le_succ]
  · simp [step, next, g]
#print axioms generation_mono_step

theorem generation_mono (d : Hasher) (s : State) (xs : List Envelope) :
    s.book.auth.generation ≤ (replay d s xs).book.auth.generation := by
  induction xs generalizing s with
  | nil => exact Nat.le_refl _
  | cons x xs ih => exact Nat.le_trans (generation_mono_step d s x) (ih (step d s x))
#print axioms generation_mono

-- L7. A rebind carrying the host's ownerVerified = true clears the pool and bars old spends.
theorem restore_kills_authority (d : Hasher) (s t : State) (x : Envelope) (owner : String)
    (binding : x.event = .rebind owner true) (ok : next d s x = some t) :
    t.book.auth.grants = [] ∧ t.book.auth.generation = s.book.auth.generation + 1 ∧
    ∀ (xs : List Envelope) (y : Envelope) (i : Intent),
      i.generation ≤ s.book.auth.generation → spendIntent y.event = some i →
      next d (replay d t xs) y = none := by
  have ht := (next_spec ok).2
  have gen : t.book.auth.generation = s.book.auth.generation + 1 := by
    simp [ht, appendEvent, advance, binding, changeAuth]
  refine ⟨?_, gen, ?_⟩
  · simp [ht, appendEvent, advance, binding, changeAuth]
  · intro xs y i old use
    have later := generation_mono d t xs
    rw [gen] at later
    cases hy : next d (replay d t xs) y with
    | none => rfl
    | some u =>
      have eqn := (spend_requires_grant hy use).2
      have lt := Nat.lt_of_lt_of_le (Nat.lt_succ_of_le old) later
      exact False.elim ((Nat.ne_of_lt lt) eqn)
#print axioms restore_kills_authority

-- An accepted grant before a rebind has the old generation, even with arbitrary intervening input.
theorem issued_before_rebind (d : Hasher) (s issued rebound : State) (grant binding : Envelope)
    (between later : List Envelope) (i : Intent) (owner : String)
    (grantEvent : grant.event = .grant i true) (issueOK : next d s grant = some issued)
    (bindEvent : binding.event = .rebind owner true)
    (bindOK : next d (replay d issued between) binding = some rebound)
    (attempt : Envelope) (use : spendIntent attempt.event = some i) :
    next d (replay d rebound later) attempt = none := by
  have gate := (next_spec issueOK).1.2.2.2
  have verified : i.generation = s.book.auth.generation ∧ i ∉ s.book.auth.grants := by
    simpa [grantEvent, eventOK] using gate
  have issuedGen : issued.book.auth.generation = s.book.auth.generation := by
    simp [(next_spec issueOK).2, appendEvent, advance, grantEvent, changeAuth]
  have old := generation_mono d issued between
  rw [issuedGen, ← verified.1] at old
  exact (restore_kills_authority d _ rebound binding owner bindEvent bindOK).2.2 later attempt i old use
#print axioms issued_before_rebind

-- L8. A core change requires the host's proofChecked = true for the granted target.
theorem core_change_requires_upgrade {d : Hasher} {s t : State} {x : Envelope} (ok : next d s x = some t)
    (changed : t.book.auth.core ≠ s.book.auth.core) :
    ∃ i, x.event = .upgrade t.book.auth.core true i ∧ i.body = .install t.book.auth.core ∧
      i ∈ s.book.auth.grants ∧ i.generation = s.book.auth.generation := by
  have ht := (next_spec ok).2
  have hc : (changeAuth s.book.auth x.event).core ≠ s.book.auth.core := by
    simpa only [ht, appendEvent, advance] using changed
  cases he : x.event <;> simp [he, changeAuth, spend] at hc
  case upgrade candidate checked i =>
    have gate := (next_spec ok).1.2.2.2
    have checks : checked = true ∧ i.body = .install candidate := by
      simpa [he, eventOK] using gate
    have use := spend_requires_grant ok (i := i) (by simp [he, spendIntent])
    have target : t.book.auth.core = candidate := by
      simp [ht, appendEvent, advance, he, changeAuth]
    exact ⟨i, by rw [target, checks.1], by rw [target]; exact checks.2, use⟩
#print axioms core_change_requires_upgrade

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
