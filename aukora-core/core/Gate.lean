import core.Core

namespace Aukora.Gate

-- The export accepts only Wasm i64 and i32 scalars. One is accept, zero is refuse.
@[inline] def same256 (a b c d w x y z : UInt64) : Bool :=
  a == w && b == x && c == y && d == z

@[inline] def successor (current incoming : UInt64) : Bool :=
  current < incoming && incoming - current == 1

-- a is the source, old claim ID, or intent generation according to the tag.
-- b is the replacement claim ID. hitA is claim/grant membership, hitB a claim lookup.
-- body = 0 for deliver and 1 for install. The two flags are owner and proof reports.
@[inline] def eventPass (seq gen a b : UInt64)
    (tag hitA hitB owner proof body : UInt32) (sameTarget : Bool) : Bool :=
  if tag == 0 then true                                          -- say
  else if tag == 1 then 0 < a && a ≤ seq && hitA == 0            -- remember
  else if tag == 2 then a != b && hitA == 1 && hitB == 1         -- correct
  else if tag == 3 then owner == 1 && a == gen && hitA == 0      -- grant
  else if tag == 4 then body == 0 && a == gen && hitA == 1       -- act
  else if tag == 5 then true                                     -- outcome
  else if tag == 6 then true                                     -- advise
  else if tag == 7 then proof == 1 && body == 1 && sameTarget &&
    a == gen && hitA == 1                                        -- upgrade
  else if tag == 8 then owner == 1                               -- rebind
  else false

@[export aukora_gate]
def verdict (p0 p1 p2 p3 h0 h1 h2 h3 current incoming gen a b : UInt64)
    (tag hitA hitB owner proof body : UInt32) (t0 t1 t2 t3 c0 c1 c2 c3 : UInt64) : UInt32 :=
  if same256 p0 p1 p2 p3 h0 h1 h2 h3 && successor current incoming &&
    eventPass current gen a b tag hitA hitB owner proof body (same256 t0 t1 t2 t3 c0 c1 c2 c3)
  then 1 else 0

-- Records below describe a call for the proof. They are absent from the exported ABI.
structure Lanes where
  a : UInt64
  b : UInt64
  c : UInt64
  d : UInt64
  deriving DecidableEq

def equalLanes (p q : Lanes) := same256 p.a p.b p.c p.d q.a q.b q.c q.d

theorem equalLanes_spec (p q : Lanes) : equalLanes p q = true ↔ p = q := by
  cases p; cases q; simp [equalLanes, same256, and_assoc]
#print axioms equalLanes_spec

-- The host supplies four limbs per digest. For each pair used, word equality must
-- preserve AND reflect equality of the original bytes. Digest.bytes has no fixed length.
def PairEncodes (p q : Lanes) (u v : Digest) : Prop := (p = q ↔ u = v)

theorem successor_spec (current incoming : UInt64) :
    successor current incoming = true ↔ incoming.toNat = current.toNat + 1 := by
  simp only [successor, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq]
  by_cases h : current < incoming
  · have le : current ≤ incoming := UInt64.le_of_lt h
    rw [and_iff_right h, ← UInt64.toNat_inj, UInt64.toNat_sub_of_le _ _ le, UInt64.toNat_one]
    have := UInt64.lt_iff_toNat_lt.mp h
    omega
  · have hn : ¬ current.toNat < incoming.toNat := fun lt => h (UInt64.lt_iff_toNat_lt.mpr lt)
    constructor
    · intro both; exact (h both.1).elim
    · intro step; omega
#print axioms successor_spec

def flag (v : Bool) : UInt32 := if v then 1 else 0

theorem flag_one (v : Bool) : (flag v = 1) ↔ v = true := by cases v <;> decide
#print axioms flag_one
theorem flag_zero (v : Bool) : (flag v = 0) ↔ v = false := by cases v <;> decide
#print axioms flag_zero

structure Query where
  a : UInt64
  b : UInt64
  tag : UInt32
  hitA : UInt32
  hitB : UInt32
  owner : UInt32
  proof : UInt32
  body : UInt32
  target : Lanes
  candidate : Lanes

def member (book : Book) (i : Intent) : UInt32 := flag (decide (i ∈ book.auth.grants))
def hasClaim (book : Book) (id : Nat) : UInt32 := flag (book.claims.any (fun c => c.id == id))

-- Exact natural values, never truncations. Membership is for the full intent
-- (body, audience, generation, nonce) or the individual ID in this same book.
-- Fields unused by a tag may take any value.
def PayloadEncodes (q : Query) (book : Book) : Event → Prop
  | .say _ => q.tag = 0
  | .remember id src _ => q.tag = 1 ∧ q.a.toNat = src ∧ q.hitA = hasClaim book id
  | .correct old replacement _ => q.tag = 2 ∧ q.a.toNat = old ∧ q.b.toNat = replacement ∧
      q.hitA = hasClaim book old ∧ q.hitB = hasClaim book replacement
  | .grant i v => q.tag = 3 ∧ q.a.toNat = i.generation ∧ q.hitA = member book i ∧ q.owner = flag v
  | .act i => q.tag = 4 ∧ q.a.toNat = i.generation ∧ q.hitA = member book i ∧
      q.body = (match i.body with | .deliver _ => 0 | .install _ => 1)
  | .outcome _ _ => q.tag = 5
  | .advise _ _ => q.tag = 6
  | .upgrade candidate checked i => q.tag = 7 ∧ q.a.toNat = i.generation ∧
      q.hitA = member book i ∧ q.proof = flag checked ∧
      (match i.body with
      | .deliver _ => q.body = 0
      | .install target => q.body = 1 ∧ PairEncodes q.target q.candidate target candidate)
  | .rebind _ v => q.tag = 8 ∧ q.owner = flag v

def evalQuery (q : Query) (seq gen : UInt64) : Bool :=
  eventPass seq gen q.a q.b q.tag q.hitA q.hitB q.owner q.proof q.body (equalLanes q.target q.candidate)

theorem event_refines (q : Query) (book : Book) (e : Event) (seq gen : UInt64)
    (hs : seq.toNat = book.seq) (hg : gen.toNat = book.auth.generation)
    (rep : PayloadEncodes q book e) :
    evalQuery q seq gen = true ↔ Eligible book e := by
  cases e with
  | say | outcome | advise =>
    simp_all [PayloadEncodes, evalQuery, eventPass, Eligible, spendOK, spendIntent, eventOK]
  | remember id src t =>
    obtain ⟨tag, ha, hit⟩ := rep
    simp [evalQuery, eventPass, tag, hit, hasClaim, flag_zero, UInt64.lt_iff_toNat_lt,
      UInt64.le_iff_toNat_le, hs, ha, Eligible, spendOK, spendIntent, eventOK, and_assoc]
  | correct old replacement r =>
    obtain ⟨tag, ha, hb, hit, hit'⟩ := rep
    simp [evalQuery, eventPass, tag, hit, hit', hasClaim, flag_one, ← UInt64.toNat_inj,
      ha, hb, Eligible, spendOK, spendIntent, eventOK, and_assoc]
  | grant i v =>
    obtain ⟨tag, ha, hit, hv⟩ := rep
    simp [evalQuery, eventPass, tag, hit, hv, member, flag_one, flag_zero,
      ← UInt64.toNat_inj, hg, ha, Eligible, spendOK, spendIntent, eventOK, and_assoc]
  | act i =>
    obtain ⟨tag, ha, hit, kind⟩ := rep
    cases hi : i.body <;> simp [evalQuery, eventPass, tag, hit, kind, hi, member,
      flag_one, ← UInt64.toNat_inj, hg, ha, Eligible, spendOK, spendIntent, eventOK, and_comm]
  | upgrade candidate checked i =>
    obtain ⟨tag, ha, hit, hp, kind⟩ := rep
    cases hi : i.body with
    | deliver payload =>
      rw [hi] at kind
      simp [evalQuery, eventPass, tag, kind, Eligible, spendOK, spendIntent, eventOK, hi]
    | install target =>
      rw [hi] at kind
      obtain ⟨body, eqv⟩ := kind
      simp [evalQuery, eventPass, tag, body, equalLanes_spec, hit, hp,
        member, flag_one, ← UInt64.toNat_inj, ha, hg, Eligible, spendOK, spendIntent, eventOK, hi,
        show q.target = q.candidate ↔ target = candidate from eqv, and_assoc, and_left_comm, and_comm]
  | rebind newOwner v =>
    obtain ⟨tag, hv⟩ := rep
    simp [evalQuery, eventPass, tag, hv, flag_one, Eligible, spendOK, spendIntent, eventOK]
#print axioms event_refines

-- This is an equivalence for the exported function itself on every faithful encoding.
theorem gate_refines (s : State) (x : Envelope) (p h : Lanes) (current incoming gen : UInt64)
    (q : Query) (heads : PairEncodes p h x.parent s.head)
    (hs : current.toNat = s.book.seq) (hx : incoming.toNat = x.seq)
    (hg : gen.toNat = s.book.auth.generation) (payload : PayloadEncodes q s.book x.event) :
    verdict p.a p.b p.c p.d h.a h.b h.c h.d current incoming gen q.a q.b
      q.tag q.hitA q.hitB q.owner q.proof q.body
      q.target.a q.target.b q.target.c q.target.d
      q.candidate.a q.candidate.b q.candidate.c q.candidate.d = 1 ↔ Good s x := by
  change (if equalLanes p h && successor current incoming && evalQuery q current gen
    then (1 : UInt32) else 0) = 1 ↔ _
  simp [Bool.and_eq_true, equalLanes_spec, show p = h ↔ x.parent = s.head from heads,
    successor_spec, hs, hx, event_refines q s.book x.event current gen hs hg payload, Good, and_assoc]
#print axioms gate_refines

end Aukora.Gate
