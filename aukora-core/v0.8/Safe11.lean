import Policy

namespace Aukora.Safe11

abbrev Machine := Policy9.Machine
abbrev Next := ByteArray → Machine → Option Machine

inductive Route where
  | ordinary | halt | clear | refusal | rebind
  deriving DecidableEq, Repr

/-- Recovery operations use the release-2 envelope ff 02 and a distinct command byte. -/
def route (w : ByteArray) : Route :=
  if w[0]? = some (255 : UInt8) ∧ w[1]? = some (2 : UInt8) then
    match (w[2]? : Option UInt8) with
    | some 50 => .halt
    | some 51 => .clear
    | some 52 => .refusal
    | some 53 => .rebind
    | _ => .ordinary
  else .ordinary

/-- The flag is the projection of committed records. A submitted but refused clear cannot change it. -/
def flagAfter (old : Bool) (w : ByteArray) : Bool :=
  match route w with
  | .halt | .refusal => true
  | .clear => false
  | _ => old

def halted (s : Machine) : Bool := s.base.record.toList.foldl flagAfter false

def head (s : Machine) := s.base.hybrid.inner.ledger.head

private def bytes (w : ByteArray) (start stop : Nat) := (w.extract start stop).data.toList

/-- Decimal natural numbers have no wraparound. NUL delimits the digits from the following field. -/
def number (n : Nat) : Bytes := Wire4.textBytes (toString n) ++ [0]

def header (s : Machine) (op : UInt8) : Bytes :=
  [255, 2, op] ++ (head s).bytes ++ number (Policy9.nextSeq s)

def bodyStart (s : Machine) (op : UInt8) := (header s op).length

def addressed (s : Machine) (w : ByteArray) (op : UInt8) : Bool :=
  bytes w 0 (bodyStart s op) == header s op

def newKeys (s : Machine) (w : ByteArray) : Hybrid7.Keys :=
  let p := bodyStart s 53
  ⟨bytes w p (p+32), bytes w (p+32) (p+1984)⟩

def signatureOffset (s : Machine) (op : UInt8) :=
  bodyStart s op + (if op = 53 then 1984 else 0)

def edSignature (s : Machine) (w : ByteArray) (op : UInt8) :=
  let p := signatureOffset s op
  bytes w p (p+64)

def mlSignature (s : Machine) (w : ByteArray) (op : UInt8) :=
  bytes w (signatureOffset s op + 64) w.size

/-- Both current keys sign the domain, their key pair, generation, addressed command and any new keys. -/
def message (s : Machine) (w : ByteArray) (op : UInt8) : Bytes :=
  Wire4.putText "AUKORA/R11/safe" ++ Hybrid7.keyBytes s.base.hybrid.owner ++
    number (Policy9.generation s) ++ bytes w 0 (signatureOffset s op)

def shape (s : Machine) (w : ByteArray) (op : UInt8) : Bool :=
  addressed s w op && w.size == signatureOffset s op + 64 + 3309

def ownerOK (s : Machine) (w : ByteArray) (op : UInt8) : Bool :=
  shape s w op && Hybrid7.verifyHybrid Core8.verifiers s.base.hybrid.owner
    (message s w op) (edSignature s w op) (mlSignature s w op)

def Both (s : Machine) (w : ByteArray) (op : UInt8) : Prop :=
  Hybrid7.Both Core8.verifiers s.base.hybrid.owner
    (message s w op) (edSignature s w op) (mlSignature s w op)

theorem owner_iff (s w op) : ownerOK s w op = true ↔ shape s w op = true ∧ Both s w op := by
  simp [ownerOK, Both, Hybrid7.verifyHybrid_iff]

/-- Only the listed ordinary commands may pass through the halted branch; they retain their original checks. -/
def allowedCommand : Policy9.Command → Bool
  | .ordinary x _ =>
    match x.action with
    | .plain (.base (.say ..)) | .plain (.base (.remember ..)) | .plain (.base (.advise ..)) => true
    | .control (.revoke _) _ => true
    | _ => false
  | .report .. | .cancel .. | .rebind .. | .threshold | .assessment => true
  | _ => false

/-- The evidence outcome carries subtag 41, discriminant 2 after the release-2 header. -/
def outcomeWire (w : ByteArray) : Bool :=
  w[0]? == some 255 && w[1]? == some 2 && w[2]? == some 41 && w[43]? == some 2

def allowedOrdinary (w : ByteArray) :=
  match Policy9.decode w with
  | some cmd => allowedCommand cmd
  | none => outcomeWire w

/-- Project the addressed, already-validated special frame into the ledger with its exact wire digest. -/
def append (s : Machine) (w : ByteArray) (e : Event) : Machine :=
  let f : R2.Frame := ⟨head s, Policy9.nextSeq s, .base e⟩
  let ledger := R2.append (fun _ => Bound4.digest w) s.base.hybrid.inner.ledger f
  {s with base.hybrid.inner.ledger := ledger}

def metadata (s : Machine) (w : ByteArray) (name : String) : Machine :=
  append s w (.advise ("AUKORA/R11/" ++ name) 0)

def rebound (s : Machine) (w : ByteArray) : Machine :=
  let keys := newKeys s w
  let t := append s w (.rebind (Wire5.keyName keys.ed) true)
  {t with base.hybrid.owner := keys, rules := []}

/-- Replay a recognized act without committing it. Its submitted bytes remain inside the halt frame. -/
def refusedAct (next : Next) (s : Machine) (w : ByteArray) : Bool :=
  let attempt := w.extract (bodyStart s 52) w.size
  addressed s w 52 &&
    (match Policy9.decode attempt with | some (.use _) => true | _ => false) &&
    (next attempt s).isNone

def raw (next : Next) (w : ByteArray) (s : Machine) : Option Machine :=
  match route w with
  | .halt => if ownerOK s w 50 then some (metadata s w "halt") else none
  | .clear => if ownerOK s w 51 then some (metadata s w "clear") else none
  | .refusal =>
    if !halted s && refusedAct next s w then some (metadata s w "refused-act") else none
  | .rebind =>
    if ownerOK s w 53 && Hybrid7.validKey (newKeys s w) then some (rebound s w) else none
  | .ordinary => if halted s && !allowedOrdinary w then none else next w s

/-- Every admission appends the exact wire once, including special controls. -/
def step (next : Next) (w : ByteArray) (s : Machine) : Option Machine :=
  (raw next w s).map fun t => {t with base.record := s.base.record.push w}

end Aukora.Safe11
