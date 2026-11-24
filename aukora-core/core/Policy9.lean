import core.Core8

namespace Aukora.Policy9

open private Core8.assessment Core8.thresholdControl Core8.act from core.Core8

inductive Restriction where
  | revoked
  | validThrough (seq : Nat)
  deriving DecidableEq, Repr

/-- Revocation identifies an intent by digest. A renewal unblocks only the exact
    intent that both keys signed, even in a model with a digest collision. -/
inductive Directive where
  | cancel (intent : Intent)
  | issue (intent : Intent) (expiry : Nat)

abbrev Rules := List Directive

def lookup (i : Intent) : Rules → Option Restriction
  | [] => none
  | .cancel j :: rest => if i = j then some .revoked else lookup i rest
  | .issue j last :: rest => if i = j then some (.validThrough last) else lookup i rest

def permits (rules : Rules) (i : Intent) (nextSeq : Nat) : Bool :=
  match lookup i rules with
  | none => true
  | some .revoked => false
  | some (.validThrough last) => decide (nextSeq ≤ last)

structure Finding where
  key : Digest
  intent : Intent
  value : Result
  corrected : Bool
  deriving DecidableEq, Repr

/-- Newest first. All earlier entries remain addressable in the wire record. -/
def view (history : List Finding) (d : Digest) : Option Finding :=
  history.find? (fun entry => decide (entry.key = d))

def reportOK (history : List Finding) (i : Intent) (corrected : Bool) : Bool :=
  match view history (Risk8.intentDigest i) with
  | none => !corrected
  | some prior => corrected && decide (prior.intent = i)

structure Machine where
  base : Core8.Machine
  rules : Rules := []
  outcomes : List Finding := []

def genesis (keys : ByteArray) : Option Machine :=
  (Core8.genesis keys).map fun base => { base }

def generation (s : Machine) := Hybrid7.generation s.base.hybrid
def nextSeq (s : Machine) := s.base.hybrid.inner.ledger.book.seq + 1

/-- Additional check for all admissions, including mandate use and installation.
    The underlying ledger still checks and spends the selected credential. -/
def grantOK (s : Machine) (i : Intent) : Bool :=
  decide (i.generation = generation s) && permits s.rules i (nextSeq s)

def outcomeCode (s : Machine) (digest : ByteArray) : Nat :=
  match view s.outcomes ⟨digest.data.toList⟩ with
  | none => 256
  | some entry =>
    let raw := match entry.value with | .confirmed => 0 | .failed => 1 | .unknown => 2
    (if entry.corrected then 4 else 0) + raw

inductive Command where
  | ordinary (x : Wire5.Frame) (extra : Hybrid7.Extra)
  | assessment | threshold
  | use (i : Intent)
  | issue (parent : Digest) (seq expiry : Nat) (i : Intent) (ed ml : Bytes)
  | cancel (parent : Digest) (seq : Nat) (d : Digest) (ed ml : Bytes)
  | report (parent : Digest) (seq : Nat) (i : Intent) (value : Result) (corrected : Bool)
  | rebind (parent : Digest) (seq : Nat) (newKeys : Hybrid7.Keys) (ed ml : Bytes)

private def issueFields : Wire4.Reader Command := do
  return .issue (← Wire4.digestField) (← Wire4.uint 8) (← Wire4.uint 8) (← Wire4.intentField)
    (← Wire4.takeBytes 64) (← Wire4.takeBytes 3309)

private def cancelFields : Wire4.Reader Command := do
  return .cancel (← Wire4.digestField) (← Wire4.uint 8) (← Wire4.digestField)
    (← Wire4.takeBytes 64) (← Wire4.takeBytes 3309)

private def full (parser : Wire4.Reader α) (wire : ByteArray) : Option α := do
  let (v, []) ← parser (wire.extract 1 wire.size).data.toList | none
  return v

/-- Tags 7, 17 and 18 from the old gate cannot fall through into Core8. -/
def decode (wire : ByteArray) : Option Command := do
  let tag : UInt8 ← wire[0]?
  match tag with
  | 24 => full issueFields wire
  | 25 => full cancelFields wire
  | 26 =>
    let x ← Wire5.decode (wire.extract 1 wire.size)
    let .plain (.base (.outcome i val)) := x.action | none
    return .report x.parent x.seq i val true
  | 23 =>
    let x ← Wire5.decode (wire.extract 33 wire.size)
    match x.action with
    | .plain (.base (.act i)) | .plain (.useMandate _ (.act i)) => return .use i
    | _ => none
  | 21 => return .assessment
  | 22 => return .threshold
  | _ =>
    let r ← Core8.request wire
    let x ← Wire5.decode r.wire
    match x.action with
    | .plain (.base (.upgrade ..)) | .plain (.base (.act _)) | .plain (.useMandate ..) => none
    | .plain (.base (.outcome i val)) =>
      let .unsigned := r.extra | none
      return .report x.parent x.seq i val false
    | .rebind k sig =>
      let .binding ml pq := r.extra | none
      return .rebind x.parent x.seq ⟨k, ml⟩ sig pq
    | _ => return .ordinary x r.extra

def message (role : String) (s : Machine) (parent : Digest) (seq : Nat) (payload : Bytes) : Bytes :=
  Wire4.putText ("AUKORA/R9/" ++ role) ++ Hybrid7.keyBytes s.base.hybrid.owner ++
    Wire4.putUInt 8 (generation s) ++ parent.bytes ++ Wire4.putUInt 8 seq ++ payload

def signed (s : Machine) (msg ed ml : Bytes) : Bool :=
  decide (generation s < 2^64) && ed.length == 64 && ml.length == 3309 &&
    Hybrid7.verifyHybrid Core8.verifiers s.base.hybrid.owner msg ed ml

def issueMessage (s : Machine) (parent : Digest) (seq expiry : Nat) (i : Intent) :=
  message "grant" s parent seq (Wire4.putUInt 8 expiry ++ Wire4.putIntent i)

def cancelMessage (s : Machine) (parent : Digest) (seq : Nat) (d : Digest) :=
  message "revoke" s parent seq d.bytes

def pool (s : Core8.Machine) := s.hybrid.inner.ledger.book.auth.grants

def matchingGrants (s : Machine) (d : Digest) : List Intent :=
  (pool s.base).filter fun i => decide (Risk8.intentDigest i = d) && grantOK s i

/-- A digest is an unambiguous selector only when exactly one eligible grant matches.
    Reject both a missing grant and any collision; cancellation stores the full intent. -/
def resolve (s : Machine) (d : Digest) : Option Intent :=
  match matchingGrants s d with
  | [i] => some i
  | _ => none

def selected (s : Machine) : Command → Option Intent
  | .cancel _ _ d _ _ => resolve s d
  | _ => none

private def setPool (s : Core8.Machine) (grants : List Intent) : Core8.Machine :=
  {s with hybrid.inner.ledger.book.auth.grants := grants}

/-- Append using the original submitted bytes for both the public record and head,
    including the correction flag or the owner signatures. -/
private def append (s : Core8.Machine) (wire : ByteArray) (frame : R2.Frame) : Option Core8.Machine := do
  let inner ← Bound4.next (fun _ => Bound4.digest wire) s.hybrid.inner frame
  return {s with hybrid.inner := inner, record := s.record.push wire}

private def hadGrant (s : Machine) (i : Intent) : Bool :=
  s.base.hybrid.inner.ledger.history.any fun x =>
    match x.action with
    | .base (.grant prior true) => decide (prior = i)
    | _ => false

private def applyBase (s : Machine) (wire : ByteArray) (choice : Option Intent) : Command → Option Core8.Machine
  | .use i =>
    if grantOK s i then
      (Core8.act wire s.base).map (fun base => {base with record := s.base.record.push wire})
    else none
  | .assessment => (Core8.assessment wire s.base).map (fun base => {base with record := s.base.record.push wire})
  | .threshold => (Core8.thresholdControl wire s.base).map (fun base => {base with record := s.base.record.push wire})
  | .issue parent seq expiry i ed ml => do
    guard (signed s (issueMessage s parent seq expiry i) ed ml)
    guard (seq < expiry && Bound5.intentFits i)
    -- A replayed legacy signature cannot renew. Renewal binds today's head/seq,
    -- and a previously used nonce must name the very same, now inactive intent.
    let fresh := !Bound5.usedNonce (Hybrid7.edView s.base.hybrid) i
    guard (fresh || (!grantOK s i && hadGrant s i))
    let base := setPool s.base ((pool s.base).filter (fun j => decide (j ≠ i)))
    append base wire ⟨parent, seq, .base (.grant i true)⟩
  | .cancel parent seq d ed ml => do
    guard (signed s (cancelMessage s parent seq d) ed ml)
    let victim ← choice
    let base := setPool s.base ((pool s.base).filter (fun j => decide (j ≠ victim)))
    append base wire ⟨parent, seq, .base (.advise "AUKORA/R9/revoke" 0)⟩
  | .report parent seq i val corrected => do
    guard (reportOK s.outcomes i corrected)
    append s.base wire ⟨parent, seq, .base (.outcome i val)⟩
  | .rebind parent seq keys ed ml => do
    let x : Wire5.Frame := ⟨parent, seq, .rebind keys.ed ed⟩
    guard (Hybrid7.authorized Core8.verifiers s.base.hybrid x (.binding keys.ml ml))
    let b ← append s.base wire x.project
    return {b with hybrid.owner := keys}
  | .ordinary x extra => do
    guard (Hybrid7.authorized Core8.verifiers s.base.hybrid x extra)
    append s.base wire x.project

def rulesAfter (before : Rules) (choice : Option Intent) : Command → Rules
  | .issue _ _ expiry i _ _ => .issue i expiry :: before
  | .cancel .. => match choice with
    | some victim => .cancel victim :: before
    | none => before
  | .rebind .. => []
  | _ => before

def outcomesAfter (before : List Finding) : Command → List Finding
  | .report _ _ i val fix => ⟨Risk8.intentDigest i, i, val, fix⟩ :: before
  | _ => before

def submit (s : Machine) (wire : ByteArray) (cmd : Command) : Option Machine := do
  let choice := selected s cmd
  let base ← applyBase s wire choice cmd
  return ⟨base, rulesAfter s.rules choice cmd, outcomesAfter s.outcomes cmd⟩

def step (wire : ByteArray) (s : Machine) : Option Machine := do
  let cmd ← decode wire
  submit s wire cmd

end Aukora.Policy9
