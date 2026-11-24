import Checker
import Crypto.Sha256
import Wire

namespace Aukora.RatchetChecker
open Lean R6.KernelCell
open private Cursor Cursor.mk Cursor.input Cursor.pos Parser byte varNat nameField exprField exactly from KernelCell

def inheritedNames := ["replay","record","stale","once","passive","advice","restore","upgrade",
  "memory","outcome","grants","binding","control","monotone","floor","threshold","missing","bundle",
  "stamping","revoke","expiry","correction","retention"]

def supplementNames := ["e1","e1b","e2","e3","e4","e5","e6","h1","h2","h3","h4","h5","succession"]

def rootNames := inheritedNames ++ supplementNames

/-- This finite manifest and its executable declaration foundation both contribute to identity. -/
def rootManifest := ("R12/1\n" ++ String.intercalate "\n" rootNames ++ "\n").toUTF8

/-- Each custom label is attached syntactically to the predicate that its constructor contributes. -/
def manifest : Expr → Option (List String)
  | .const n [] =>
    if n == `Aukora.Root12.Contract then some rootNames
    else if n == `Aukora.Root12.Lawful then some inheritedNames
    else if n == `Aukora.Root12.Supplement then some supplementNames
    else none
  | .app (.app (.app (.const n []) prior) (.lit (.strVal label))) _ => do
    guard (n == `Aukora.Ratchet11.addLaw && !label.isEmpty)
    let names ← manifest prior
    guard (!names.contains label)
    return names ++ [label]
  | .app (.app (.const n []) (.lit (.strVal label))) _ => do
    guard (n == `Aukora.Ratchet11.oneLaw && !label.isEmpty)
    return [label]
  | _ => none

/-- Exact R6 expression encoding of the constant Aukora.Root12.Contract, with no universe arguments. -/
def rootSpec : ByteArray :=
  ⟨#[2,1,1,1,0,6] ++ "Aukora".toUTF8.data ++ #[6] ++ "Root12".toUTF8.data ++
    #[8] ++ "Contract".toUTF8.data ++ #[0]⟩

def number (b : List UInt8) : Nat := b.foldr (fun x n => x.toNat + 256*n) 0

def identity (basis : Nat) (spec : ByteArray) : List UInt8 :=
  Sha256.hash (rootManifest ++ (Wire4.putUInt 32 basis).toByteArray ++ spec)

/-- Bind the parsed foundation to the hash of the actual privately loaded bytes. -/
@[export r11_kernel_init] def init (environment : ByteArray) : Option Context := do
  let old ← Checker9.init environment
  guard ((old.env.find? `Aukora.Root12.Contract).isSome)
  return ⟨old.env, .lit (.natVal (number (Sha256.hash environment)))⟩

def basis (ctx : Context) : Option Nat :=
  match ctx.goal with | .lit (.natVal n) => some n | _ => none

/-- The first ordinary, monomorphic R9 declaration is the candidate's closed law predicate.
    Its body bytes can be recovered later without reconstructing candidate machine definitions. -/
private def specField : Parser ByteArray := do
  for b in "R9M1".toUTF8 do guard ((← byte) == b)
  let n ← varNat
  guard (0 < n && n ≤ 64)
  guard ((← nameField) == `R9Candidate.claimedLaw)
  let _ ← exprField
  let start ← get
  let value ← exprField
  guard ((manifest value).isSome)
  let finish ← get
  return (Cursor.input start).extract (Cursor.pos start) (Cursor.pos finish)

def spec (model : ByteArray) : Option ByteArray := do
  let (b,_) ← specField (Cursor.mk model 0)
  return b

structure Witnesses where
  basis : Nat
  parent : Nat
  own : Expr
  entails : Expr

/-- The last term is still a complete v0.1 proof. Its enclosing lets transport separate checked witnesses. -/
def witnesses (proof : ByteArray) : Option Witnesses := do
  let .letE _ _ (.lit (.natVal b)) tail _ ← exactly exprField proof | none
  let .letE _ _ (.lit (.natVal p)) tail _ := tail | none
  let .letE _ _ sat tail _ := tail | none
  let .letE _ _ ent _ _ := tail | none
  return ⟨b,p,sat,ent⟩

def expression (b : ByteArray) := exactly exprField b

/-- The carry-over witness additionally pins the submitted machine's complete
    grammar for every model satisfying its claimed set. The machine expression
    comes from the final checked declaration in the candidate carrier. -/
def entailmentGoal (newSet oldSet machine : Expr) : Expr :=
  mkApp3 (mkConst `Aukora.Ratchet11.Transition) newSet oldSet machine

/-- Check a standalone term against the independently constructed proposition. -/
def verifies (env : Kernel.Environment) (goal term : Expr) : Bool :=
  match Lean4Lean.TypeChecker.M.run env (x := do
    let k ← Lean4Lean.TypeChecker.check goal []
    if !(← Lean4Lean.TypeChecker.isDefEq k (.sort .zero)) then return false
    let ty ← Lean4Lean.TypeChecker.check term []
    Lean4Lean.TypeChecker.isDefEq ty goal) with
  | .ok v => v | .error _ => false

structure Goals where
  env : Kernel.Environment
  own : Expr
  entails : Expr
  cert : Witnesses

/-- The ledger retains a predicate's syntax. Its constants and projections must
    mean the same thing when reloaded under an independently carried model.
    Candidate-local definitions may implement a machine but cannot occur in
    the persistent law text. Bound variables and literals are self-contained. -/
def foundationOnly (env : Kernel.Environment) : Expr → Bool
  | .const n _ => (env.find? n).isSome
  | .proj n _ e => (env.find? n).isSome && foundationOnly env e
  | .app f a => foundationOnly env f && foundationOnly env a
  | .lam _ t e _ | .forallE _ t e _ => foundationOnly env t && foundationOnly env e
  | .letE _ t v e _ => foundationOnly env t && foundationOnly env v && foundationOnly env e
  | .mdata _ e => foundationOnly env e
  | .lit _ | .bvar _ | .sort _ => true
  | .fvar _ | .mvar _ => false

def goals (ctx : Context) (current model proof : ByteArray) : Option Goals := do
  let newSet ← expression (← spec model)
  let oldSet ← expression current
  guard (foundationOnly ctx.env oldSet && foundationOnly ctx.env newSet)
  let cert ← witnesses proof
  let name ← Checker9.machineName model
  let checked ← Checker9.context ctx model
  return ⟨checked.env, .app newSet (.const name []), entailmentGoal newSet oldSet (.const name []), cert⟩

end Aukora.RatchetChecker
