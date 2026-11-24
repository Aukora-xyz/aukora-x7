import RatchetChecker
import Machine

namespace Aukora.Ratchet11
open R6.KernelCell (Context)
open RatchetChecker (Witnesses)

abbrev Pin := Nat × ByteArray

def packagePin (u : Upgrade9.Package) : Option Pin := do
  let law ← RatchetChecker.spec u.model
  let cert ← RatchetChecker.witnesses u.proof
  return (cert.basis, law)

def update (prior : Option Pin) (w : ByteArray) : Option Pin :=
  ((Upgrade9.decode w).bind packagePin).orElse fun _ => prior

/-- The immutable raw record holds the most recently admitted foundation and law predicate. -/
def current (s : Policy9.Machine) : Option Pin :=
  s.base.record.toList.foldl update none

theorem current_push {s t : Policy9.Machine} {w} (h : t.base.record = s.base.record.push w) :
    current t = update (current s) w := by simp [current,h]

def basisAndSet (ctx : Context) (prev : Option Pin) : Option Pin := do
  let b ← RatchetChecker.basis ctx
  match prev with
  | none => return (b, RatchetChecker.rootSpec)
  | some (prior, law) => guard (b = prior); return (b,law)

def lawDigest (ctx : Context) (s : Policy9.Machine) : List UInt8 :=
  match current s with
  | some (b, law) => RatchetChecker.identity b law
  | none => (RatchetChecker.basis ctx).elim [] (fun b => RatchetChecker.identity b RatchetChecker.rootSpec)

@[export r11_law_byte] def lawByte (ctx : Context) (s : Policy9.Machine) (i : UInt32) : Nat :=
  ((lawDigest ctx s)[i.toNat]?).elim 256 UInt8.toNat

/-- Zero accepts the additional ratchet checks. Codes 1..8 identify the first failed condition. -/
def packageReason (ctx : Context) (prev : Option Pin) (model proof : ByteArray) : Nat := Id.run do
  let some (b, law) := basisAndSet ctx prev | return 1
  let some cert := RatchetChecker.witnesses proof | return 2
  if cert.basis != b then return 3
  if cert.parent != RatchetChecker.number (RatchetChecker.identity b law) then return 4
  let some next := RatchetChecker.spec model | return 5
  let some g := RatchetChecker.goals ctx law model proof | return 6
  -- Report an invalid transition before testing that the candidate inhabits its proposed set.
  if !RatchetChecker.verifies g.env g.entails g.cert.entails then return 8
  if !RatchetChecker.verifies g.env g.own g.cert.own then return 7
  return if RatchetChecker.retainsNames law next then 0 else 13

def reason (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : Nat :=
  if w[0]? = some (27 : UInt8) then
    match Upgrade9.decode w with
    | none => 9
    | some u =>
      if Upgrade9.ownerBound u then packageReason ctx (current s) u.model u.proof else 10
  else 0

@[export r11_reason] def wireReason (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : Nat := reason ctx w s

/-- Read-only result for the two independently constructed witness goals.
    This diagnostic cannot grant authority or select code. -/
@[export r12_witness_mask] def witnessMask (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : Nat := Id.run do
  let some u := Upgrade9.decode w | return 256
  if !Upgrade9.ownerBound u then return 256
  let some (b,law) := basisAndSet ctx (current s) | return 256
  let some cert := RatchetChecker.witnesses u.proof | return 256
  if cert.basis != b || cert.parent != RatchetChecker.number (RatchetChecker.identity b law) then return 256
  let some g := RatchetChecker.goals ctx law u.model u.proof | return 256
  let own := RatchetChecker.verifies g.env g.own g.cert.own
  let entails := RatchetChecker.verifies g.env g.entails g.cert.entails
  return (if own then 1 else 0) + (if entails then 2 else 0)

def allow (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : Bool := decide (reason ctx w s = 0)

@[export r11_ratchet_step] def step (ctx : Context) (w : ByteArray) (s : Policy9.Machine) :=
  if allow ctx w s then Core9.step ctx w s else none

theorem allow_ordinary {ctx w s} (tag : w[0]? ≠ some (27 : UInt8)) : allow ctx w s = true := by
  simp [allow, reason, tag]

theorem allows_match {ctx s t wx wy x y}
    (same : current s = current t)
    (tx : wx[0]? = some (27 : UInt8)) (ty : wy[0]? = some (27 : UInt8))
    (dx : Upgrade9.decode wx = some x) (dy : Upgrade9.decode wy = some y)
    (model : x.model = y.model) (proof : x.proof = y.proof) (intent : x.intent = y.intent) :
    allow ctx wx s = allow ctx wy t := by
  simp [allow, reason, tx, ty, dx, dy, same, Upgrade9.ownerBound, model, proof, intent]

/-- The outgoing gate checks the owner's package commitment before reading proof terms. -/
theorem allowed_owner_bound {ctx s w u} (tag : w[0]? = some (27 : UInt8))
    (dec : Upgrade9.decode w = some u) (ok : allow ctx w s = true) :
    Upgrade9.ownerBound u = true := by
  cases bound : Upgrade9.ownerBound u with
  | false => simp [allow,reason,tag,dec,bound] at ok
  | true => rfl

#print axioms allowed_owner_bound
end Aukora.Ratchet11
