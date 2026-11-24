import Bound12c
import SegmentFinal
import Proofs.ChainFinal
import Proofs.BindingConflict
import Proofs.FinalStep
import Proofs.FinalHistory

/-! Round 12c D: laws B1 (separation) and B2 (head-signed owner frames are refused
by every other bound record). The only cryptographic assumption is named in each
statement: SHA-256 gives different digests to the different byte strings that actually
occur on the two histories being compared (the style of `ChainFinal.NoCollision`).

B2 does NOT cover a plain approval (tag 13 hex) or a legacy key change (tag 14 hex):
their signatures name no head, so a copy can be re-wrapped under another record's head,
and the frozen law `PriorVerdicts` forces every lawful machine to admit it
(`BindingConflict.forced_approval`, `BindingConflict.forced_key_change`). -/

namespace Aukora.RecordBinding
open Release
open Safe11 (fullModel)
open R6.KernelCell (Context)
open private Evidence11.metadata from Evidence11
open private Policy9.append Policy9.applyBase from Policy
open private Root12.Grammar.second Root12.Grammar.evidenceFrame from Laws
open private Safe11.bytes from Safe11

/-! ### Byte facts -/

private theorem data_loop (xs : Bytes) (acc : ByteArray) :
    (List.toByteArray.loop xs acc).data.toList = acc.data.toList ++ xs := by
  induction xs generalizing acc with
  | nil => simp [List.toByteArray.loop]
  | cons b bs ih => cases acc; simp [List.toByteArray.loop, ih, ByteArray.push, List.append_assoc]

theorem data_bytes (xs : Bytes) : xs.toByteArray.data.toList = xs := by
  simp [List.toByteArray, data_loop, ByteArray.empty, ByteArray.emptyWithCapacity]

theorem extract_list (w : ByteArray) (a b : Nat) :
    (w.extract a b).data.toList = (w.data.toList.drop a).take (b - a) := by
  rcases w with ⟨⟨l⟩⟩
  simp [ByteArray.extract, ByteArray.copySlice, ByteArray.empty, ByteArray.emptyWithCapacity, List.extract]
  omega

theorem append_list (a b : ByteArray) : (a ++ b).data.toList = a.data.toList ++ b.data.toList := by
  rcases a with ⟨a⟩
  rcases b with ⟨b⟩
  change (a.extract 0 a.size ++ b.extract 0 (0 + b.size) ++
    a.extract (a.size + min b.size (b.size - 0)) a.size).toList = _
  have empty : a.extract (a.size + b.size) a.size = #[] := Array.extract_eq_empty_of_le (by omega)
  rw [Nat.zero_add,Nat.sub_zero,Nat.min_self,empty,Array.extract_eq_self_of_le (Nat.le_refl _),
    Array.extract_eq_self_of_le (Nat.le_refl _)]
  simp

theorem hash_width (x : ByteArray) : (Sha256.hash x).length = 32 := by
  have h := ChainFinal.digest_width x
  unfold SegmentFinal.digest at h
  have e : (Sha256.hash x).toByteArray.data.toList.length = 32 := by
    simpa [ByteArray.size, Array.length_toList] using h
  rwa [data_bytes] at e

/-! ### The predecessor that each committed preimage names -/

/-- The parent head named by a frame's own bytes, read without any state. -/
def wireParent (w : ByteArray) : Option Bytes :=
  if w[0]? ≠ some (255 : UInt8) then (projected w).map (·.parent.bytes)
  else if w[1]? = some (2 : UInt8) then
    match Safe11.route w with
    | .ordinary => (Evidence11.decode w).map (·.parent.bytes)
    | _ => some ((w.data.toList.drop 3).take 32)
  else if w[1]? = some (3 : UInt8) then (Evidence11.decode w).map (·.parent.bytes)
  else none

/-- Seal trailers, continuation descriptors and record descriptors start with `A`
    (65); no accepted frame does. Byte 12 tells the three apart. -/
def link (b : ByteArray) : Option Bytes :=
  if b[0]? = some (65 : UInt8) then
    if b[12]? = some (115 : UInt8) then some ((b.data.toList.drop 80).take 32)
    else if b[12]? = some (103 : UInt8) then some ((b.data.toList.drop 19).take 32)
    else none
  else wireParent b

/-! ### Histories with seal and continuation -/

inductive Op where
  | input (c : Input)
  /-- Seal the open segment with `wire` over journal `prior`, then continue with `packed`. -/
  | continue (prior law wire packed : ByteArray)

/-- The state and, newest first, every byte string whose digest became a head. -/
def apply (m : Model) (ctx : Context) (x : Release.State × List ByteArray) : Op → Release.State × List ByteArray
  | .input (.frame w) =>
    match m.step ctx w x.1 with
    | some t => (t, w :: x.2)
    | none => x
  | .input c => (execute m ctx x.1 c, x.2)
  | .continue prior law wire packed =>
    match SegmentFinal.closeRecord prior law wire x.1 with
    | some pin =>
      match SegmentFinal.continueAt pin law packed x.1 with
      | some u => (u, packed :: wire :: x.2)
      | none => x
    | none => x

def walk (m : Model) (ctx : Context) (x : Release.State × List ByteArray) : List Op → Release.State × List ByteArray
  | [] => x
  | o :: os => walk m ctx (apply m ctx x o) os

/-- The named SHA-256 assumption, only for strings that occur on the two histories. -/
def NoCollision (xs ys : List ByteArray) : Prop :=
  ∀ a ∈ xs, ∀ b ∈ ys, Sha256.hash a = Sha256.hash b → a = b

/-- Start of a bound history: the bound genesis and its descriptor. -/
def started (law keys host : ByteArray) (s : Release.State) : Release.State × List ByteArray :=
  (s, [Bound12c.descriptor law keys host])

/-- B1. Two records started by bound genesis with different identifiers never share a
    ledger head, after any frames, feeds, resets, stamps, key changes, seals and
    continuations, given that SHA-256 separates the strings committed on the two paths. -/
def Separation (m : Model) : Prop :=
  ∀ ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂,
    Bound12c.genesis law₁ keys₁ host₁ = some s₁ → Bound12c.genesis law₂ keys₂ host₂ = some s₂ →
    Bound12c.identifier law₁ keys₁ host₁ ≠ Bound12c.identifier law₂ keys₂ host₂ →
    NoCollision (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).2 (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).2 →
    (ledger (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).1).head ≠
      (ledger (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).1).head

/-- The owner-signed kinds whose signatures cover the current head: a threshold
    control (tag 16 hex), a timed approval (18 hex), a cancel (19 hex), a signed
    legacy control (13 hex carrying a control action), the halt, clear and key change
    of the ff 02 dialect, and every extension form (ff 04 and later). The seal is
    `seal_refused` below. Tags 13 hex with an approval and 14 hex are NOT listed. -/
def HeadSigned (w : ByteArray) : Prop :=
  w[0]? = some (22 : UInt8) ∨ w[0]? = some (24 : UInt8) ∨ w[0]? = some (25 : UInt8) ∨
  (∃ x ml, Policy9.decode w = some (.ordinary x (.signed ml)) ∧ ∃ op ed, x.action = .control op ed) ∨
  (w[0]? = some (255 : UInt8) ∧ w[1]? = some (2 : UInt8) ∧
    (Safe11.route w = .halt ∨ Safe11.route w = .clear ∨ Safe11.route w = .rebind)) ∨
  (w[0]? = some (255 : UInt8) ∧ ∃ v : UInt8, w[1]? = some v ∧ 4 ≤ v.toNat)

/-- B2. A head-signed owner frame admitted at any point of one bound record is refused,
    byte for byte, at every point of every bound record with a different identifier. -/
def Refusal (m : Model) : Prop :=
  ∀ ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ w,
    Bound12c.genesis law₁ keys₁ host₁ = some s₁ → Bound12c.genesis law₂ keys₂ host₂ = some s₂ →
    Bound12c.identifier law₁ keys₁ host₁ ≠ Bound12c.identifier law₂ keys₂ host₂ →
    NoCollision (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).2 (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).2 →
    HeadSigned w → (m.step ctx w (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).1).isSome →
    m.step ctx w (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).1 = none

/-! ### Roots of linked chains -/

def Linked : List ByteArray → Prop
  | [] => False
  | [a] => link a = none
  | a :: b :: rest => link a = some (Sha256.hash b) ∧ Linked (b :: rest)

private theorem linked_some {a b : ByteArray} {rest} (h : Linked (a :: b :: rest)) : (link a).isSome := by
  rw [h.1]; rfl

/-- Two linked chains whose newest entries hash alike have the same root. -/
theorem same_root : ∀ (xs ys : List ByteArray) (a b : ByteArray),
    Linked (a :: xs) → Linked (b :: ys) → NoCollision (a :: xs) (b :: ys) →
    Sha256.hash a = Sha256.hash b → (a :: xs).getLast (by simp) = (b :: ys).getLast (by simp)
  | [], [], a, b, _, _, safe, eq => by
    simpa using safe a (by simp) b (by simp) eq
  | [], c :: ys, a, b, la, lb, safe, eq => by
    have same := safe a (by simp) b (by simp) eq
    subst same
    have := linked_some lb
    simp [Linked] at la
    rw [la] at this
    cases this
  | c :: xs, [], a, b, la, lb, safe, eq => by
    have same := safe a (by simp) b (by simp) eq
    subst same
    have := linked_some la
    simp [Linked] at lb
    rw [lb] at this
    cases this
  | c :: xs, d :: ys, a, b, la, lb, safe, eq => by
    have same := safe a (by simp) b (by simp) eq
    subst same
    have hc : link a = some (Sha256.hash c) := la.1
    have hd : link a = some (Sha256.hash d) := lb.1
    have next : Sha256.hash c = Sha256.hash d := Option.some.inj (hc.symm.trans hd)
    have tails : NoCollision (c :: xs) (d :: ys) :=
      fun p hp q hq => safe p (List.mem_cons_of_mem _ hp) q (List.mem_cons_of_mem _ hq)
    have r := same_root xs ys c d la.2 lb.2 tails next
    simpa [List.getLast_cons] using r

/-! ### The full machine moves its head only to the digest of a linked preimage -/

private theorem meta_head {s : Release.State} {w e} {risk : Risk8.State} {u}
    (hit : Evidence11.metadata s w e risk = some u) : (ledger u).head = Bound4.digest w := by
  obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp hit
  cases Option.some.inj eq
  obtain ⟨inner,bound,eq⟩ := Option.bind_eq_some.mp app
  cases Option.some.inj eq
  have next := R2.next_spec (Bound4.accepted bound).2
  change inner.ledger.head = _
  rw [next.2]
  rfl

private theorem submit_head {s w e u} (hit : Evidence11.submit s w e = some u) :
    (ledger u).head = Bound4.digest w := by
  rcases e with ⟨p,n,body⟩
  cases body with
  | assessment key val claims => exact meta_head hit
  | source | premise | cell => exact meta_head hit
  | read | setCeiling =>
    simp only [Evidence11.submit] at hit
    split at hit
    · exact meta_head hit
    · contradiction
  | outcome i val fix conf =>
    obtain ⟨b,applied,eq⟩ := Option.bind_eq_some.mp hit
    cases Option.some.inj eq
    obtain ⟨_,_,app⟩ := Option.bind_eq_some.mp applied
    obtain ⟨inner,bound,eq⟩ := Option.bind_eq_some.mp app
    cases Option.some.inj eq
    have next := R2.next_spec (Bound4.accepted bound).2
    change inner.ledger.head = _
    rw [next.2]
    rfl

theorem full_head {ctx w s t} (hit : fullModel.step ctx w s = some t) :
    (ledger t).head = Bound4.digest w := by
  cases RootFinal.dispatch hit with
  | legacy ok =>
    obtain ⟨f,g,_,nx⟩ := Release.step_projection ok
    rw [(R2.next_spec nx).2]
    rfl
  | evidence _ _ _ ok =>
    have h := submit_head ok
    exact h
  | note => rfl
  | rebind => rfl

#print axioms full_head

/-! ### Each admitted frame names the current head in its own bytes -/

theorem get_list (b : ByteArray) (i : Nat) : b[i]? = b.data.toList[i]? := by
  rcases b with ⟨⟨l⟩⟩
  by_cases h : i < l.length
  · simp [h, ByteArray.size, ByteArray.get, getElem?_pos, List.getElem?_eq_getElem h]
    rfl
  · simp [h, ByteArray.size, getElem?_neg, List.getElem?_eq_none (Nat.le_of_not_lt h)]

theorem addressed_parent {s : Release.State} {w : ByteArray} {op : UInt8}
    (width : (Safe11.head s).bytes.length = 32) (ok : Safe11.addressed s w op = true) :
    (w.data.toList.drop 3).take 32 = (Safe11.head s).bytes := by
  have e : w.data.toList.take (Safe11.bodyStart s op) = Safe11.header s op := by
    have h := beq_iff_eq.mp ok
    simpa [Safe11.bytes, extract_list] using h
  have long : 35 ≤ Safe11.bodyStart s op := by
    simp [Safe11.bodyStart, Safe11.header, width]
    try omega
  have key : ((w.data.toList.take (Safe11.bodyStart s op)).drop 3).take 32 = (Safe11.head s).bytes := by
    rw [e]
    simp [Safe11.header, List.take_append_eq_append_take, width]
  rw [← key, List.drop_take, List.take_take, Nat.min_eq_left (by omega : 32 ≤ Safe11.bodyStart s op - 3)]

theorem parent_of_decode {s : Release.State} {w : ByteArray} {d : Root12.Grammar.Decoded}
    (width : (Safe11.head s).bytes.length = 32)
    (dec : Root12.Grammar.decode Root12.Grammar.installed s w = some d) :
    wireParent w = some d.frame.parent.bytes := by
  by_cases ff : w[0]? = some (255 : UInt8)
  · by_cases two : w[1]? = some (2 : UInt8)
    · have sec : Root12.Grammar.second s w = some d := by
        simpa [Root12.Grammar.decode, ff, two, Root12.Grammar.installed] using dec
      cases rt : Safe11.route w with
      | ordinary =>
        simp only [Root12.Grammar.second, rt] at sec
        obtain ⟨e, de, eq⟩ := Option.bind_eq_some.mp sec
        cases Option.some.inj eq
        simp [wireParent, ff, two, rt, de, Root12.Grammar.evidenceFrame]
      | halt =>
        simp only [Root12.Grammar.second, rt] at sec
        by_cases sh : Safe11.shape s w 50 = true
        · simp only [sh, guard] at sec
          cases sec
          try subst sec
          have ad : Safe11.addressed s w 50 = true := by
            simp only [Safe11.shape, Bool.and_eq_true] at sh; exact sh.1
          simp [wireParent, ff, two, rt, addressed_parent width ad]
        · simp only [sh, guard] at sec
          cases sec
      | clear =>
        simp only [Root12.Grammar.second, rt] at sec
        by_cases sh : Safe11.shape s w 51 = true
        · simp only [sh, guard] at sec
          cases sec
          try subst sec
          have ad : Safe11.addressed s w 51 = true := by
            simp only [Safe11.shape, Bool.and_eq_true] at sh; exact sh.1
          simp [wireParent, ff, two, rt, addressed_parent width ad]
        · simp only [sh, guard] at sec
          cases sec
      | rebind =>
        simp only [Root12.Grammar.second, rt] at sec
        by_cases sh : Safe11.shape s w 53 = true
        · simp only [sh, guard] at sec
          cases sec
          try subst sec
          have ad : Safe11.addressed s w 53 = true := by
            simp only [Safe11.shape, Bool.and_eq_true] at sh; exact sh.1
          simp [wireParent, ff, two, rt, addressed_parent width ad]
        · simp only [sh, guard] at sec
          cases sec
      | refusal =>
        simp only [Root12.Grammar.second, rt] at sec
        by_cases ad : Safe11.addressed s w 52 = true
        · cases hd : Policy9.decode (w.extract (Safe11.bodyStart s 52) w.size) with
          | none => simp [ad, guard, hd] at sec
          | some c =>
            cases c <;> simp [ad, guard, hd] at sec
            subst sec
            simp [wireParent, ff, two, rt, addressed_parent width ad]
        · simp only [ad, guard] at sec
          cases sec
    · by_cases three : w[1]? = some (3 : UInt8)
      · have parsed : ∃ e, Evidence11.decode w = some e ∧ d.frame = Root12.Grammar.evidenceFrame e := by
          cases de : Evidence11.decode w with
          | none =>
            simp [Root12.Grammar.decode, ff, three, Root12.Grammar.installed, guard,
              Root12.Grammar.third, de] at dec
          | some e =>
            simp [Root12.Grammar.decode, ff, three, Root12.Grammar.installed, guard,
              Root12.Grammar.third, de] at dec
            subst dec
            exact ⟨e, rfl, rfl⟩
        obtain ⟨e, de, fr⟩ := parsed
        rw [fr]
        simp [wireParent, ff, two, three, de, Root12.Grammar.evidenceFrame]
      · exfalso
        cases v : w[1]? with
        | none => simp [Root12.Grammar.decode, ff, v] at dec
        | some v' =>
          have h2 : v' ≠ 2 := fun h => two (by rw [v, h])
          have h3 : v' ≠ 3 := fun h => three (by rw [v, h])
          by_cases le : 3 ≤ v'.toNat
          · have v3 : v'.toNat ≠ 3 := fun h => h3 (UInt8.toNat_inj.mp (by simpa using h))
            obtain ⟨k, hk⟩ : ∃ k, v'.toNat - 3 = k + 1 := ⟨v'.toNat - 4, by omega⟩
            simp [Root12.Grammar.decode, ff, v, h2, Root12.Grammar.installed, guard, le, hk] at dec
          · simp [Root12.Grammar.decode, ff, v, h2, Root12.Grammar.installed, guard, le] at dec <;> cases dec
  · simp [Root12.Grammar.decode, ff] at dec
    obtain ⟨f, pf, rfl⟩ := dec
    simp [wireParent, ff, pf]

theorem full_parent {ctx w s t} (hit : fullModel.step ctx w s = some t)
    (width : (ledger s).head.bytes.length = 32) : wireParent w = some (ledger s).head.bytes := by
  obtain ⟨d, dec⟩ := Root12.full_record.parses ctx w s t hit
  have addr : d.frame.parent = (ledger s).head := by
    by_contra h
    have refused := (RootFinal.full_stale_installed ctx s w d dec (.inl h)).1
    rw [hit] at refused
    cases refused
  rw [← addr]
  exact parent_of_decode width dec

/-- No admitted frame starts with the byte 65 that opens every descriptor and trailer. -/
theorem full_not_ascii {ctx w s t} (hit : fullModel.step ctx w s = some t) : w[0]? ≠ some (65 : UInt8) := by
  intro a
  obtain ⟨d, dec⟩ := Root12.full_record.parses ctx w s t hit
  have notff : w[0]? ≠ some (255 : UInt8) := by rw [a]; decide
  simp [Root12.Grammar.decode, notff, projected, a, Policy9.decode, Core8.request] at dec

theorem full_link {ctx w s t} (hit : fullModel.step ctx w s = some t)
    (width : (ledger s).head.bytes.length = 32) : link w = some (ledger s).head.bytes := by
  simp [link, full_not_ascii hit, full_parent hit width]

/-! ### Seal trailers and continuation descriptors -/

private theorem guarded {b : Bool} {u : Unit} (h : (guard b : Option Unit) = some u) : b = true := by
  cases b <;> simp_all [guard]

theorem sealTag_list : SegmentFinal.sealTag.data.toList =
    [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 66, 47, 115, 101, 97, 108] := by decide

theorem genesisTag_list : ("AUKORA/R12B/genesis".toUTF8).data.toList =
    [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 66, 47, 103, 101, 110, 101, 115, 105, 115] := by decide

theorem recordTag_list : Bound12c.recordTag.data.toList =
    [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 67, 47, 114, 101, 99, 111, 114, 100] := by decide

theorem seal_link {prior law wire : ByteArray} {s : Release.State} {pin : ByteArray}
    (width : (Safe11.head s).bytes.length = 32) (ok : SegmentFinal.closeRecord prior law wire s = some pin) :
    pin = SegmentFinal.digest wire ∧ link wire = some (Safe11.head s).bytes := by
  unfold SegmentFinal.closeRecord at ok
  obtain ⟨_,first,rest⟩ := Option.bind_eq_some.mp ok
  obtain ⟨_,_,eq⟩ := Option.bind_eq_some.mp rest
  have fields := guarded first
  simp only [Bool.and_eq_true, beq_iff_eq] at fields
  have pLen : prior.data.toList.length = 32 := by simpa [ByteArray.size] using fields.1.1.1.1
  have lLen : law.data.toList.length = 32 := by simpa [ByteArray.size] using fields.1.1.1.2
  have hdr := fields.1.2
  refine ⟨(Option.some.inj eq).symm, ?_⟩
  have hdrList : (SegmentFinal.sealHeader prior law s).data.toList =
      [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 66, 47, 115, 101, 97, 108] ++
        (prior.data.toList ++ (law.data.toList ++ ((Safe11.head s).bytes ++ (SegmentFinal.keyData s).data.toList))) := by
    simp only [SegmentFinal.sealHeader, append_list, data_bytes, sealTag_list, List.append_assoc]
  obtain ⟨H, hH⟩ : ∃ H, SegmentFinal.sealHeader prior law s = H := ⟨_, rfl⟩
  rw [hH] at hdr hdrList
  have pre : wire.data.toList.take H.size = H.data.toList := by
    have h := congrArg (fun b : ByteArray => b.data.toList) hdr
    simpa [extract_list] using h
  have size : H.size = H.data.toList.length := by
    show H.data.size = _
    exact Array.length_toList.symm
  have long : 112 ≤ H.size := by
    rw [size, hdrList]
    simp only [List.length_append, pLen, lLen, width, List.length_cons, List.length_nil]
    omega
  have at0 : wire.data.toList[0]? = some (65 : UInt8) := by
    rw [← List.getElem?_take_of_lt (by omega : 0 < H.size), pre, hdrList]
    rfl
  have at12 : wire.data.toList[12]? = some (115 : UInt8) := by
    rw [← List.getElem?_take_of_lt (by omega : 12 < H.size), pre, hdrList]
    rfl
  have mid : (wire.data.toList.drop 80).take 32 = (Safe11.head s).bytes := by
    have e1 : (wire.data.toList.drop 80).take 32 = ((wire.data.toList.take H.size).drop 80).take 32 := by
      rw [List.drop_take, List.take_take, Nat.min_eq_left (by omega : 32 ≤ H.size - 80)]
    rw [e1, pre, hdrList]
    have regroup : ∀ (t p l h k : List UInt8), t ++ (p ++ (l ++ (h ++ k))) = (t ++ p ++ l) ++ (h ++ k) := by
      intros; simp
    rw [regroup, List.drop_left' (by simp [pLen, lLen]), List.take_left' width]
  simp [link, get_list, at0, at12, mid]

theorem continue_link {pin law packed : ByteArray} {s u : Release.State}
    (ok : SegmentFinal.continueAt pin law packed s = some u) (pinLen : pin.data.toList.length = 32) :
    link packed = some pin.data.toList ∧ (ledger u).head = ⟨Sha256.hash packed⟩ := by
  obtain ⟨named, head, _⟩ := SegmentFinal.continuation ok
  have pk : packed.data.toList = [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 66, 47, 103, 101, 110, 101, 115, 105, 115] ++
      (pin.data.toList ++ (law.data.toList ++ (SegmentFinal.keyData s).data.toList)) := by
    rw [named]
    simp only [SegmentFinal.expectedGenesis, SegmentFinal.genesisData, append_list, genesisTag_list, List.append_assoc]
  have at0 : packed.data.toList[0]? = some (65 : UInt8) := by rw [pk]; rfl
  have at12 : packed.data.toList[12]? = some (103 : UInt8) := by rw [pk]; rfl
  have mid : (packed.data.toList.drop 19).take 32 = pin.data.toList := by
    rw [pk]
    have d19 : ∀ l : List UInt8, ([65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 66, 47, 103, 101, 110, 101, 115, 105, 115] ++ l).drop 19 = l :=
      fun l => rfl
    rw [d19]
    simp [List.take_append_eq_append_take, pinLen]
  refine ⟨by simp [link, get_list, at0, at12, mid], ?_⟩
  change Safe11.head u = _
  rw [head]
  simp [SegmentFinal.digest, data_bytes]

/-! ### The invariant along a bound history of the full machine -/

def Inv (x : Release.State × List ByteArray) : Prop :=
  Linked x.2 ∧ ∃ a rest, x.2 = a :: rest ∧ (ledger x.1).head = ⟨Sha256.hash a⟩

private theorem stamp_head {w s t} (ok : fullModel.stamp w s = some t) : (ledger t).head = (ledger s).head := by
  change (Core8.stamp w s.base).map (fun base => {s with base}) = some t at ok
  obtain ⟨b, hit, rfl⟩ := Option.map_eq_some'.mp ok
  unfold Core8.stamp at hit
  obtain ⟨_, _, rest⟩ := Option.bind_eq_some.mp hit
  obtain ⟨_, _, eq⟩ := Option.bind_eq_some.mp rest
  cases Option.some.inj eq
  rfl

/-- Inputs other than frames leave the ledger head unchanged (review finding F1: public). -/
theorem execute_head {ctx s c} (notFrame : ∀ w, c ≠ .frame w) :
    (ledger (execute fullModel ctx s c)).head = (ledger s).head := by
  cases c with
  | frame w => exact absurd rfl (notFrame w)
  | feed b =>
    rcases Root12.full_replay.feedEffect s b with same | fed
    · simp only [execute, same]
    · simp only [execute, fed]; rfl
  | reset =>
    rcases Root12.full_replay.resetEffect s with same | cl
    · simp only [execute, same]
    · simp only [execute, cl]; rfl
  | stamp w =>
    simp only [execute]
    cases h : fullModel.stamp w s with
    | none => rfl
    | some t => exact stamp_head h

theorem inv_apply (ctx : Context) (x : Release.State × List ByteArray) (o : Op) (inv : Inv x) :
    Inv (apply fullModel ctx x o) := by
  obtain ⟨linked, a, rest, chain, head⟩ := inv
  have width : (ledger x.1).head.bytes.length = 32 := by rw [head]; exact hash_width a
  cases o with
  | input c =>
    cases c with
    | frame w =>
      simp only [apply]
      cases hit : fullModel.step ctx w x.1 with
      | none => dsimp only; exact ⟨linked, a, rest, chain, head⟩
      | some t =>
        dsimp only
        refine ⟨?_, w, x.2, rfl, full_head hit⟩
        rw [chain] at linked ⊢
        refine ⟨?_, linked⟩
        rw [full_link hit width, head]
    | feed b => exact ⟨linked, a, rest, chain, by simp only [apply]; rw [execute_head (by intro w h; cases h)]; exact head⟩
    | reset => exact ⟨linked, a, rest, chain, by simp only [apply]; rw [execute_head (by intro w h; cases h)]; exact head⟩
    | stamp w => exact ⟨linked, a, rest, chain, by simp only [apply]; rw [execute_head (by intro w h; cases h)]; exact head⟩
  | «continue» prior law wire packed =>
    simp only [apply]
    cases sealed : SegmentFinal.closeRecord prior law wire x.1 with
    | none => exact ⟨linked, a, rest, chain, head⟩
    | some pin =>
      dsimp only
      cases cont : SegmentFinal.continueAt pin law packed x.1 with
      | none => dsimp only; exact ⟨linked, a, rest, chain, head⟩
      | some u =>
        dsimp only
        obtain ⟨pinEq, wireLink⟩ := seal_link width sealed
        have pinLen : pin.data.toList.length = 32 := by
          rw [pinEq, SegmentFinal.digest, data_bytes]; exact hash_width wire
        obtain ⟨packLink, newHead⟩ := continue_link cont pinLen
        refine ⟨?_, packed, wire :: x.2, rfl, newHead⟩
        rw [chain] at linked ⊢
        refine ⟨?_, ?_, linked⟩
        · rw [packLink, pinEq, SegmentFinal.digest, data_bytes]
        · change link wire = some (Sha256.hash a)
          rw [wireLink]
          change some (ledger x.1).head.bytes = _
          rw [head]

theorem inv_walk (ctx : Context) : ∀ (ops : List Op) (x : Release.State × List ByteArray),
    Inv x → Inv (walk fullModel ctx x ops)
  | [], _, inv => inv
  | o :: os, x, inv => inv_walk ctx os _ (inv_apply ctx x o inv)

theorem walk_root (m : Model) (ctx : Context) : ∀ (ops : List Op) (x : Release.State × List ByteArray),
    ∃ pre, (walk m ctx x ops).2 = pre ++ x.2
  | [], _ => ⟨[], rfl⟩
  | o :: os, x => by
    obtain ⟨pre, eq⟩ := walk_root m ctx os (apply m ctx x o)
    have step : ∃ more, (apply m ctx x o).2 = more ++ x.2 := by
      cases o with
      | input c =>
        cases c with
        | frame w =>
          simp only [apply]
          cases m.step ctx w x.1 with
          | none => exact ⟨[], rfl⟩
          | some t => exact ⟨[w], rfl⟩
        | _ => exact ⟨[], rfl⟩
      | «continue» prior law wire packed =>
        simp only [apply]
        cases SegmentFinal.closeRecord prior law wire x.1 with
        | none => exact ⟨[], rfl⟩
        | some pin =>
          dsimp only
          cases SegmentFinal.continueAt pin law packed x.1 with
          | none => exact ⟨[], rfl⟩
          | some u => exact ⟨[packed, wire], rfl⟩
    obtain ⟨more, e2⟩ := step
    exact ⟨pre ++ more, by simp [walk, eq, e2]⟩

theorem start_inv {law keys host s} (ok : Bound12c.genesis law keys host = some s) :
    Inv (started law keys host s) := by
  refine ⟨?_, _, [], rfl, ?_⟩
  · have d : (Bound12c.descriptor law keys host).data.toList =
        [65, 85, 75, 79, 82, 65, 47, 82, 49, 50, 67, 47, 114, 101, 99, 111, 114, 100] ++
          (law.data.toList ++ (keys.data.toList ++ host.data.toList)) := by
      simp only [Bound12c.descriptor, append_list, recordTag_list, List.append_assoc]
    have at0 : (Bound12c.descriptor law keys host).data.toList[0]? = some (65 : UInt8) := by rw [d]; rfl
    have at12 : (Bound12c.descriptor law keys host).data.toList[12]? = some (114 : UInt8) := by rw [d]; rfl
    show link _ = none
    simp [link, get_list, at0, at12]
  · exact Bound12c.genesis_head ok

/-! ### B1 and B2 for the full machine -/

private theorem root_of {law keys host s} (ctx : Context) (ops : List Op) :
    ∃ a xs, (walk fullModel ctx (started law keys host s) ops).2 = a :: xs ∧
      (a :: xs).getLast (by simp) = Bound12c.descriptor law keys host := by
  obtain ⟨pre, eq⟩ := walk_root fullModel ctx ops (started law keys host s)
  cases h : pre ++ [Bound12c.descriptor law keys host] with
  | nil => simp at h
  | cons a xs =>
    refine ⟨a, xs, by rw [eq]; exact h, ?_⟩
    have : (pre ++ [Bound12c.descriptor law keys host]).getLast (by simp) = Bound12c.descriptor law keys host := by simp
    simpa [h] using this

theorem full_separation : Separation fullModel := by
  intro ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ g₁ g₂ ids safe same
  obtain ⟨l₁, a, xs, c₁, h₁⟩ := inv_walk ctx ops₁ _ (start_inv g₁)
  obtain ⟨l₂, b, ys, c₂, h₂⟩ := inv_walk ctx ops₂ _ (start_inv g₂)
  obtain ⟨a', xs', r₁, root₁⟩ := root_of (law := law₁) (keys := keys₁) (host := host₁) (s := s₁) ctx ops₁
  obtain ⟨b', ys', r₂, root₂⟩ := root_of (law := law₂) (keys := keys₂) (host := host₂) (s := s₂) ctx ops₂
  rw [c₁] at r₁ l₁ safe
  rw [c₂] at r₂ l₂ safe
  obtain ⟨rfl, rfl⟩ := List.cons.inj r₁
  obtain ⟨rfl, rfl⟩ := List.cons.inj r₂
  have eq : Sha256.hash a = Sha256.hash b := by
    have := h₁.symm.trans (same.trans h₂)
    exact Digest.mk.inj this
  have roots := same_root xs ys a b l₁ l₂ safe eq
  rw [root₁, root₂] at roots
  exact ids (by simp [Bound12c.identifier, roots])

theorem full_refusal : Refusal fullModel := by
  intro ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ w g₁ g₂ ids safe _ admitted
  cases hit₂ : fullModel.step ctx w (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
  | none => rfl
  | some t₂ =>
    exfalso
    obtain ⟨t₁, hit₁⟩ := Option.isSome_iff_exists.mp admitted
    obtain ⟨_, a, _, _, h₁⟩ := inv_walk ctx ops₁ _ (start_inv g₁)
    obtain ⟨_, b, _, _, h₂⟩ := inv_walk ctx ops₂ _ (start_inv g₂)
    have w₁ : (ledger (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1).head.bytes.length = 32 := by
      rw [h₁]; exact hash_width a
    have w₂ : (ledger (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1).head.bytes.length = 32 := by
      rw [h₂]; exact hash_width b
    have p₁ := full_parent hit₁ w₁
    have p₂ := full_parent hit₂ w₂
    rw [p₁] at p₂
    apply full_separation ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ g₁ g₂ ids safe
    cases h : (ledger (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1).head
    cases h' : (ledger (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1).head
    rw [h, h'] at p₂
    simp at p₂
    rw [p₂]

/-- The seal, which is outside the step: a trailer accepted at a point of one bound
    record is refused at every point of every bound record with another identifier. -/
theorem seal_refused {ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂}
    (g₁ : Bound12c.genesis law₁ keys₁ host₁ = some s₁) (g₂ : Bound12c.genesis law₂ keys₂ host₂ = some s₂)
    (ids : Bound12c.identifier law₁ keys₁ host₁ ≠ Bound12c.identifier law₂ keys₂ host₂)
    (safe : NoCollision (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).2
      (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).2)
    {prior law prior' law' wire pin} :
    SegmentFinal.closeRecord prior law wire (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1 = some pin →
    SegmentFinal.closeRecord prior' law' wire (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 = none := by
  intro ok₁
  cases ok₂ : SegmentFinal.closeRecord prior' law' wire (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
  | none => rfl
  | some pin' =>
    exfalso
    obtain ⟨_, a, _, _, h₁⟩ := inv_walk ctx ops₁ _ (start_inv g₁)
    obtain ⟨_, b, _, _, h₂⟩ := inv_walk ctx ops₂ _ (start_inv g₂)
    have w₁ : (Safe11.head (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1).bytes.length = 32 := by
      change (ledger _).head.bytes.length = 32; rw [h₁]; exact hash_width a
    have w₂ : (Safe11.head (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1).bytes.length = 32 := by
      change (ledger _).head.bytes.length = 32; rw [h₂]; exact hash_width b
    have l₁ := (seal_link w₁ ok₁).2
    have l₂ := (seal_link w₂ ok₂).2
    rw [l₁] at l₂
    apply full_separation ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ g₁ g₂ ids safe
    change Safe11.head _ = Safe11.head _
    cases h : Safe11.head (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1
    cases h' : Safe11.head (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1
    rw [h, h'] at l₂
    simp at l₂
    rw [l₂]

/-! ### Both laws read only the public operations, not genesis -/

theorem apply_congr {m m' : Model} (h : m.toOps = m'.toOps) (ctx : Context)
    (x : Release.State × List ByteArray) (o : Op) : apply m ctx x o = apply m' ctx x o := by
  have hs : m.step = m'.step := congrArg Ops.step h
  cases o with
  | input c =>
    cases c with
    | frame w => simp only [apply, hs]
    | _ => simp only [apply]; rw [h]
  | «continue» => rfl

theorem walk_congr {m m' : Model} (h : m.toOps = m'.toOps) (ctx : Context) :
    ∀ (x : Release.State × List ByteArray) (ops : List Op), walk m ctx x ops = walk m' ctx x ops
  | _, [] => rfl
  | x, o :: os => by simp only [walk, apply_congr h ctx x o]; exact walk_congr h ctx _ os

theorem separation_congr {m m' : Model} (h : m.toOps = m'.toOps) : Separation m ↔ Separation m' := by
  have e : walk m = walk m' := funext fun ctx => funext fun x => funext fun ops => walk_congr h ctx x ops
  simp only [Separation, e]

theorem refusal_congr {m m' : Model} (h : m.toOps = m'.toOps) : Refusal m ↔ Refusal m' := by
  have e : walk m = walk m' := funext fun ctx => funext fun x => funext fun ops => walk_congr h ctx x ops
  have hs : m.step = m'.step := congrArg Ops.step h
  simp only [Refusal, e, hs]

#print axioms full_parent
#print axioms full_separation
#print axioms full_refusal
#print axioms seal_refused
end Aukora.RecordBinding
