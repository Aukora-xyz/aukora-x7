import Wire

namespace Aukora.Wire5

open Wire4 (Reader)

/-- R2 owner-authorized operations other than grants and key changes. -/
inductive Control where
  | retract (count : Nat)
  | mandate (m : R2.Mandate)
  | grantBudget (b : R2.Budget)
  | pass (p : R2.Pass)
  | revoke (id : Nat)

def Control.project : Control → R2.Action
  | .retract n => .retract n true
  | .mandate m => .mandate m true
  | .grantBudget b => .grantBudget b true
  | .pass p => .pass p true
  | .revoke id => .revoke id true

inductive Action where
  | plain (action : R2.Action)
  | grant (intent : Intent) (signature : Bytes)
  | rebind (newKey signature : Bytes)
  | control (op : Control) (signature : Bytes)

structure Frame where
  parent : Digest
  seq : Nat
  action : Action

/-- The old ledger's display name is the hexadecimal public key. -/
def keyName (key : Bytes) : String :=
  let hex := fun n : Nat => Char.ofNat (if n < 10 then 48 + n else 87 + n)
  ⟨key.flatMap (fun b => [hex (b.toNat / 16), hex (b.toNat % 16)])⟩

def Action.project : Action → R2.Action
  | .plain a => a
  | .grant i _ => .base (.grant i true)
  | .rebind k _ => .base (.rebind (keyName k) true)
  | .control c _ => c.project

def Frame.project (x : Frame) : R2.Frame := ⟨x.parent, x.seq, x.action.project⟩

/-- A plain input can never project an owner certificate. The old policy already
    permits only act under useMandate. Enforce this in the new wire grammar too. -/
def plainOK : R2.Action → Bool
  | .base (.grant ..) | .base (.rebind ..) => false
  | .base _ | .useMandate _ (.act _) | .spend .. | .read .. => true
  | _ => false

def plainBase (tag : Nat) : Reader Action := do
  if tag = 3 ∨ tag = 8 then Wire4.invalid else
    return .plain (.base (← Wire4.baseFields tag))

def actionField : Reader Action := do
  match (← Wire4.byte).toNat with
  | 3 => return .grant (← Wire4.intentField) (← Wire4.takeBytes 64)
  | 8 => return .rebind (← Wire4.takeBytes 32) (← Wire4.takeBytes 64)
  | 9 => return .control (.retract (← Wire4.u16)) (← Wire4.takeBytes 64)
  | 10 =>
    let m := R2.Mandate.mk (← Wire4.textField) (← Wire4.blob) (← Wire4.u16) (← Wire4.u16) (← Wire4.u16)
    return .control (.mandate m) (← Wire4.takeBytes 64)
  | 11 =>
    let id ← Wire4.u16
    if (← Wire4.byte).toNat != 4 then Wire4.invalid else
      return .plain (.useMandate id (.act (← Wire4.intentField)))
  | 12 => return .control (.grantBudget ⟨← Wire4.u16, ← Wire4.u16⟩) (← Wire4.takeBytes 64)
  | 13 => return .plain (.spend (← Wire4.u16) (← Wire4.u16))
  | 14 =>
    let p := R2.Pass.mk (← Wire4.textField) (← Wire4.textField) (← Wire4.u16) (← Wire4.u16)
    return .control (.pass p) (← Wire4.takeBytes 64)
  | 15 => return .control (.revoke (← Wire4.u16)) (← Wire4.takeBytes 64)
  | 16 => return .plain (.read (← Wire4.u16) (← Wire4.textField) (← Wire4.textField) (← Wire4.boolField))
  | tag => plainBase tag

def frameField : Reader Frame := do
  return ⟨← Wire4.digestField, ← Wire4.uint 8, ← actionField⟩

def decode (wire : ByteArray) : Option Frame :=
  match frameField wire.data.toList with
  | some (x, []) => some x
  | _ => none

/-- Header, intent and control fields reuse R4's fixed-width lengths, LE numbers
    and unique UTF-8 encoding. No signature input contains an owner Boolean. -/
def controlFields (op : Control) : Bytes := (Wire4.putAction op.project).dropLast

def header (x : Frame) : Bytes := x.parent.bytes ++ Wire4.putUInt 8 x.seq

def putAction : Action → Bytes
  | .plain op => Wire4.putAction op
  | .grant i sig => 3 :: (Wire4.putIntent i ++ sig)
  | .rebind k sig => 8 :: (k ++ sig)
  | .control op sig => controlFields op ++ sig

def encode (x : Frame) : Bytes := header x ++ putAction x.action

def intentBytes (i : Intent) : Bytes := Wire4.textBytes "AUKORA/R5/grant" ++ Wire4.putIntent i

def rebindBytes (generation : Nat) (key : Bytes) : Bytes :=
  Wire4.textBytes "AUKORA/R5/rebind" ++ Wire4.putUInt 8 generation ++ key

def controlBytes (generation : Nat) (x : Frame) (op : Control) : Bytes :=
  Wire4.textBytes "AUKORA/R5/control" ++ Wire4.putUInt 8 generation ++ header x ++ controlFields op

end Aukora.Wire5
