import Policy

namespace Aukora.Evidence11

open private Policy9.append from Policy

inductive Kind where
  | observed | reported | inferred | guessed | cellResult
  deriving Repr, DecidableEq

structure Claim where
  kind : Kind
  stated : UInt8
  refs : List Nat
  absence : Option Digest
  deriving Repr, DecidableEq

structure Read where
  query : Digest
  first : Nat
  last : Nat
  empty : Bool
  result : Digest
  confidence : UInt8
  deriving Repr, DecidableEq

/-- Receipt digests attest only to what the host recorded about a cell call. -/
structure Cell where
  name : String
  pin : Digest
  op : String
  input : Option Digest
  output : Option Digest
  status : String
  deriving Repr, DecidableEq

inductive Body where
  | assessment (intent : Digest) (score : UInt8) (claims : List Claim)
  | read (r : Read)
  | source (name : String) (statement : Digest) (value : UInt8)
  | outcome (i : Intent) (result : Result) (corrected : Bool) (value : UInt8)
  | cell (receipt : Cell)
  | premise (c : Claim)
  | setCeiling (value : UInt8) (ed ml : Bytes)
  deriving Repr, DecidableEq

structure Envelope where
  parent : Digest
  seq : Nat
  body : Body
  deriving Repr, DecidableEq

def subtag (w : ByteArray) : Option UInt8 :=
  if w[0]? = some 255 ∧ w[1]? = some 2 then w[2]? else none

private def many (p : Wire4.Reader α) : Nat → Wire4.Reader (List α)
  | 0 => pure []
  | n+1 => do
    let v ← p
    return v :: (← many p n)

private def claimField (v3 : Bool) : Wire4.Reader Claim := do
  let kind ← match (← Wire4.byte).toNat with
    | 0 => pure Kind.observed | 1 => pure .reported | 2 => pure .inferred
    | 3 => pure .guessed
    | 4 => if v3 then pure .cellResult else Wire4.invalid
    | _ => Wire4.invalid
  let stated ← Wire4.byte
  let refs ← many (Wire4.uint 8) (← Wire4.byte).toNat
  let hasQuery ← Wire4.boolField
  let absence ← if hasQuery then some <$> Wire4.digestField else pure none
  return ⟨kind, stated, refs, absence⟩

private def bodyField (tag : UInt8) : Wire4.Reader Body := do
  match tag.toNat with
  | 40 => do
    let key ← Wire4.digestField
    let risk ← Wire4.byte
    return Body.assessment key risk (← many (claimField false) (← Wire4.byte).toNat)
  | 41 => do
    match (← Wire4.byte).toNat with
    | 0 => return .read ⟨← Wire4.digestField, ← Wire4.uint 8, ← Wire4.uint 8,
               ← Wire4.boolField, ← Wire4.digestField, ← Wire4.byte⟩
    | 1 =>
      let name ← Wire4.textField
      if name.isEmpty then Wire4.invalid else
        return .source name (← Wire4.digestField) (← Wire4.byte)
    | 2 => return .outcome (← Wire4.intentField) (← Wire4.resultField)
               (← Wire4.boolField) (← Wire4.byte)
    | _ => Wire4.invalid
  | 42 => return .premise (← claimField false)
  | 43 => return .setCeiling (← Wire4.byte) (← Wire4.takeBytes 64) (← Wire4.takeBytes 3309)
  | _ => Wire4.invalid

private def fields (tag : UInt8) : Wire4.Reader Envelope := do
  let parent ← Wire4.digestField
  let seq ← Wire4.uint 8
  let body ← bodyField tag
  return ⟨parent, seq, body⟩

/-- Version three has its own tag space. An invalid v2 tag never dispatches here. -/
def cellSubtag (w : ByteArray) : Option UInt8 :=
  if w[0]? = some 255 ∧ w[1]? = some 3 then
    match (w[2]? : Option UInt8) with
    | some 1 => some 1
    | some 2 => some 2
    | _ => none
  else none

private def token : Wire4.Reader String := do
  let s ← Wire4.textField
  let valid := fun (c : Char) =>
    ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z') ||
    c == '.' || c == '_' || c == '-'
  if !s.isEmpty && s.length ≤ 64 && s.data.all valid then return s else Wire4.invalid

private def optionalDigest : Wire4.Reader (Option Digest) := do
  if ← Wire4.boolField then return some (← Wire4.digestField) else return none

private def cellBody (tag : UInt8) : Wire4.Reader Body := do
  match tag.toNat with
    | 1 => do return Body.cell ⟨← token, ← Wire4.digestField, ← token,
               ← optionalDigest, ← optionalDigest, ← token⟩
    | 2 => do
      let key ← Wire4.digestField
      let risk ← Wire4.byte
      return Body.assessment key risk (← many (claimField true) (← Wire4.byte).toNat)
    | _ => Wire4.invalid

private def cellFields (tag : UInt8) : Wire4.Reader Envelope := do
  return ⟨← Wire4.digestField, ← Wire4.uint 8, ← cellBody tag⟩

def decode (w : ByteArray) : Option Envelope := do
  if let some code := cellSubtag w then
    let (e,[]) ← cellFields code (w.extract 3 w.size).data.toList | none
    return e
  let tag ← subtag w
  guard (40 ≤ tag && tag ≤ 43)
  let (e, []) ← fields tag (w.extract 3 w.size).data.toList | none
  return e

abbrev Record := Array ByteArray

def ceilingAfter (z : UInt8) (wire : ByteArray) : UInt8 :=
  if subtag wire != some 43 then z else
    match decode wire with
    | some ⟨_, _, .setCeiling n ..⟩ => n
    | _ => z

def ceiling (s : Policy9.Machine) : UInt8 := s.base.record.toList.foldl ceilingAfter 0

/-- One-based index in this record. The parsed envelope also names that exact position. -/
def atPos (h : Record) (r : Nat) : Option Body := do
  guard (0 < r)
  let bytes ← h[r-1]?
  let e ← decode bytes
  guard (e.seq = r)
  return e.body

def fitsKind (k : Kind) (body : Option Body) : Bool :=
  match k, body with
  | .observed, some (.read _) | .observed, some (.outcome ..) => true
  | .reported, some (.source name ..) => !name.isEmpty
  | .inferred, some (.premise _) => true
  | .cellResult, some (.cell c) => c.output.isSome
  | _, _ => false

def recordsAbsence (h : Record) (r : Nat) (q : Digest) : Bool :=
  match atPos h r with
  | some (.read v) => v.empty && decide (v.query = q ∧ v.first ≤ v.last ∧ v.last ≤ r)
  | _ => false

def shape (c : Claim) : Bool :=
  match c.kind with
  | .observed | .reported | .cellResult => c.refs.length == 1
  | .inferred => !c.refs.isEmpty
  | .guessed => c.refs.isEmpty

def recordedValue (h : Record) (r : Nat) : Nat :=
  match atPos h r with
  | some (.read v) => v.confidence.toNat
  | some (.outcome _ _ _ n) | some (.source _ _ n) => n.toNat
  | _ => 0

structure Grade where
  bound : Nat
  good : Bool
  deriving Inhabited, DecidableEq, Repr

def previous (grades : Array Grade) (r : Nat) : Grade :=
  grades[r-1]?.getD ⟨0, false⟩

/-- Fixed bound calculation. No branch reads the claim's stated confidence. -/
def bound (h : Record) (z : Nat) (grades : Array Grade) (c : Claim) : Nat :=
  match c.kind with
  | .observed | .reported => recordedValue h (c.refs.headD 0)
  | .cellResult => 0
  | .guessed => z
  | .inferred => c.refs.foldr (fun r acc => min (previous grades r).bound acc) 255

def refsOK (h : Record) (pos : Nat) (c : Claim) : Bool :=
  c.refs.all fun r => decide (0 < r ∧ r < pos ∧ r ≤ h.size) && fitsKind c.kind (atPos h r)

def absenceOK (h : Record) (c : Claim) : Bool :=
  match c.absence with
  | none => true
  | some q => decide (c.kind = .observed) && c.refs.any (fun r => recordsAbsence h r q)

def parentsOK (grades : Array Grade) (c : Claim) : Bool :=
  c.kind != .inferred || c.refs.all (fun r => (previous grades r).good)

def grade (h : Record) (pos : Nat) (z : Nat) (grades : Array Grade) (c : Claim) : Grade :=
  let limit := bound h z grades c
  ⟨limit, shape c && refsOK h pos c && absenceOK h c && parentsOK grades c && decide (c.stated.toNat ≤ limit)⟩

structure Index where
  values : Array Grade := #[]
  ceilingAtPosition : UInt8 := 0

/-- Build a chronological table once. Lowering today's ceiling invalidates old dependencies;
    raising it cannot increase an old guess above the ceiling recorded when it was made. -/
def index (h : Record) (today : UInt8) : Nat → Index
  | 0 => {}
  | n+1 =>
    let old := index h today n
    let value := match atPos h (n+1) with
      | some (.premise c) => grade h (n+1) (min today.toNat old.ceilingAtPosition.toNat) old.values c
      | _ => ⟨0, false⟩
    let nextCeiling := match h[n]? with
      | some bytes => ceilingAfter old.ceilingAtPosition bytes
      | none => old.ceilingAtPosition
    ⟨old.values.push value, nextCeiling⟩

structure Assessment where
  pos : Nat
  bundle : Digest
  claims : List Claim
  deriving DecidableEq, Repr

/-- Only the latest assessment for the intent applies. Historical tag 21 has an empty list. -/
def selected (h : Record) (key : Digest) : Option Assessment :=
  h.foldl (init := none) fun old wire =>
    if wire[0]? = some 21 then
      if Digest.mk ((wire.extract 41 73).data.toList) = key then none else old
    else
      match decode wire with
      | some ⟨_, pos, .assessment d _ claims⟩ =>
        if d = key then some ⟨pos, Bound4.digest wire, claims⟩ else old
      | _ => old

def scoreAt (h : Record) (today : UInt8) (pos : Nat) (c : Claim) : Grade :=
  let old := index h today (pos-1)
  grade h pos (min today.toNat old.ceilingAtPosition.toNat) old.values c

def allows (s : Policy9.Machine) (wire : ByteArray) (i : Intent) : Bool :=
  match selected s.base.record (Risk8.intentDigest i) with
  | none => true
  | some a =>
    decide (a.bundle = ⟨(wire.extract 1 33).data.toList⟩ ∧ 0 < a.pos ∧
      a.pos ≤ s.base.record.size ∧ a.pos < Policy9.nextSeq s) &&
      (let today := ceiling s
       let old := index s.base.record today (a.pos-1)
       a.claims.all (fun c =>
         (grade s.base.record a.pos (min today.toNat old.ceilingAtPosition.toNat) old.values c).good))

def ceilingMessage (s : Policy9.Machine) (parent : Digest) (seq : Nat) (z : UInt8) : Bytes :=
  Policy9.message "R11/ceiling" s parent seq [z]

private def metadata (s : Policy9.Machine) (wire : ByteArray) (e : Envelope)
    (risk : Risk8.State) : Option Policy9.Machine := do
  let base ← Policy9.append s.base wire ⟨e.parent, e.seq, .base (.advise "AUKORA/R11/evidence" 0)⟩
  return {s with base := {base with risk}}

def submit (s : Policy9.Machine) (wire : ByteArray) (e : Envelope) : Option Policy9.Machine :=
  match e.body with
  | .assessment key score _ =>
    metadata s wire e (Risk8.assess s.base.risk key score (Bound4.digest wire))
  | .outcome i result corrected _ =>
    Policy9.submit s wire (.report e.parent e.seq i result corrected)
  | .read r => if r.first ≤ r.last ∧ r.last ≤ e.seq then metadata s wire e s.base.risk else none
  | .source .. | .premise _ | .cell _ => metadata s wire e s.base.risk
  | .setCeiling z ed ml =>
    if Policy9.signed s (ceilingMessage s e.parent e.seq z) ed ml then metadata s wire e s.base.risk else none

abbrev BaseStep := ByteArray → Policy9.Machine → Option Policy9.Machine

def routed (prior : BaseStep) (wire : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  if wire[0]? = some 23 then do
    let .use i ← Policy9.decode wire | none
    guard (allows s wire i)
    prior wire s
  else if (subtag wire).any (fun tag => 40 ≤ tag && tag ≤ 43) || (cellSubtag wire).isSome then do
    let e ← decode wire
    submit s wire e
  else prior wire s

/-- All branches commit precisely this frame at one public record position. -/
def step (prior : BaseStep) (wire : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  (routed prior wire s).map fun t => {t with base.record := s.base.record.push wire}

end Aukora.Evidence11
