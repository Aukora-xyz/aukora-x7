import Lean4Lean.TypeChecker

namespace R6.KernelCell
open Lean

-- This alias permits a pure, empty-extension environment containing only the
-- privately embedded declarations. The cell exposes no environment mutation.
open private Lean.Kernel.Environment.mk from Lean.Environment

private structure Cursor where
  input : ByteArray
  pos : Nat := 0

private abbrev Parser := StateT Cursor Option

private def remaining : Parser Nat := do
  let c ← get
  return c.input.size - c.pos

private def byte : Parser UInt8 := do
  let c ← get
  if h : c.pos < c.input.size then
    set { c with pos := c.pos + 1 }
    return c.input[c.pos]
  else failure

private def varNatAux : Nat → Parser Nat
  | 0 => failure
  | n + 1 => do
    let b := (← byte).toNat
    if b < 128 then return b
    let upper ← varNatAux n
    guard (upper != 0)
    return b - 128 + 128 * upper

private def varNat : Parser Nat := do
  varNatAux (min (← remaining) 256)

private def textField : Parser String := do
  let n ← varNat
  let c ← get
  guard (n ≤ c.input.size - c.pos)
  set { c with pos := c.pos + n }
  let some s := String.fromUTF8? (c.input.extract c.pos (c.pos + n)) | failure
  return s

private def nameAux : Nat → Parser Name
  | 0 => failure
  | n + 1 => do
    match ← byte with
    | 0 => return .anonymous
    | 1 => return .str (← nameAux n) (← textField)
    | 2 => return .num (← nameAux n) (← varNat)
    | _ => failure

private def nameField : Parser Name := do
  nameAux (min (← remaining) 256)

private def listField (p : Parser α) : Parser (List α) := do
  let n ← varNat
  guard (n ≤ (← remaining))
  let mut xs := []
  for _ in [:n] do xs := (← p) :: xs
  return xs.reverse

private def levelAux : Nat → Parser Level
  | 0 => failure
  | n + 1 => do
    match ← byte with
    | 0 => return .zero
    | 1 => return .succ (← levelAux n)
    | 2 => return .max (← levelAux n) (← levelAux n)
    | 3 => return .imax (← levelAux n) (← levelAux n)
    | 4 => return .param (← nameField)
    | _ => failure

private def levelField : Parser Level := do
  levelAux (min (← remaining) 256)

private def boolField : Parser Bool := do
  match ← byte with
  | 0 => return false
  | 1 => return true
  | _ => failure

private def binderField : Parser BinderInfo := do
  match ← byte with
  | 0 => return .default
  | 1 => return .implicit
  | 2 => return .strictImplicit
  | 3 => return .instImplicit
  | _ => failure

private def exprAux : Nat → Nat → Parser Expr
  | 0, _ => failure
  | n + 1, scope => do
    match ← byte with
    | 0 =>
      let i ← varNat
      guard (i < scope)
      return .bvar i
    | 1 => return .sort (← levelField)
    | 2 => return .const (← nameField) (← listField levelField)
    | 3 => return .app (← exprAux n scope) (← exprAux n scope)
    | 4 =>
      let bi ← binderField
      return .lam (← nameField) (← exprAux n scope) (← exprAux n (scope + 1)) bi
    | 5 =>
      let bi ← binderField
      return .forallE (← nameField) (← exprAux n scope) (← exprAux n (scope + 1)) bi
    | 6 =>
      let nd ← boolField
      return .letE (← nameField) (← exprAux n scope) (← exprAux n scope) (← exprAux n (scope + 1)) nd
    | 7 => return .lit (.natVal (← varNat))
    | 8 => return .lit (.strVal (← textField))
    | 9 => return .proj (← nameField) (← varNat) (← exprAux n scope)
    | _ => failure

private def exprField : Parser Expr := do
  exprAux (min (← remaining) 256) 0

private def hintsField : Parser ReducibilityHints := do
  match ← byte with
  | 0 => return .opaque
  | 1 => return .abbrev
  | 2 =>
    let height ← varNat
    guard (height < 2 ^ 32)
    return .regular height.toUInt32
  | _ => failure

private def ruleField : Parser RecursorRule := do
  return ⟨← nameField, ← varNat, ← exprField⟩

private def quotField : Parser QuotKind := do
  match ← byte with
  | 0 => return .type
  | 1 => return .ctor
  | 2 => return .lift
  | 3 => return .ind
  | _ => failure

private def declaration : Parser ConstantInfo := do
  let tag ← byte
  let name ← nameField
  let params ← listField nameField
  let ty ← exprField
  match tag with
  | 0 => return .axiomInfo (mkAxiomValEx name params ty false)
  | 1 => return .defnInfo (mkDefinitionValEx name params ty (← exprField) (← hintsField) .safe (← listField nameField))
  | 2 =>
    return .inductInfo (mkInductiveValEx name params ty (← varNat) (← varNat)
      (← listField nameField) (← listField nameField) (← varNat) (← boolField) (← boolField) (← boolField))
  | 3 => return .ctorInfo (mkConstructorValEx name params ty (← nameField) (← varNat) (← varNat) (← varNat) (← boolField))
  | 4 =>
    return .recInfo (mkRecursorValEx name params ty (← listField nameField) (← varNat) (← varNat)
      (← varNat) (← varNat) (← listField ruleField) (← boolField) (← boolField))
  | 5 => return .quotInfo (mkQuotValEx name params ty (← quotField))
  | _ => failure

private def envField : Parser Kernel.Environment := do
  for b in "R6E1".toUTF8 do guard ((← byte) == b)
  let count ← varNat
  guard (count ≤ (← remaining))
  let mut constants : ConstMap := {}
  for _ in [:count] do
    let decl ← declaration
    guard (!decl.isUnsafe && !decl.isPartial && decl.name != `sorryAx)
    guard (decl.name != `Aukora.Bound5.wrong_digest)
    guard (!constants.contains decl.name)
    constants := constants.insert decl.name decl
  return Lean.Kernel.Environment.mk constants (constants.contains `Quot) {} {} #[] {} {}

private def exactly (p : Parser α) (bytes : ByteArray) : Option α := do
  let (value, cursor) ← p {input := bytes}
  guard (cursor.pos == bytes.size)
  return value

structure Context where
  env : Kernel.Environment
  goal : Expr

-- Both input byte arrays are private constants compiled into the C adapter.
-- The only untrusted input exported by that adapter is the proof argument.
@[export r6_kernel_init]
def init (environment goal : ByteArray) : Option Context := do
  let env ← exactly envField environment
  let target ← exactly exprField goal
  let .ok true := Lean4Lean.TypeChecker.M.run env (x := do
    let kind ← Lean4Lean.TypeChecker.check target []
    Lean4Lean.TypeChecker.isDefEq kind (.sort .zero)) | none
  return ⟨env, target⟩

@[export r6_kernel_check]
def check (context : Context) (proof : ByteArray) : Bool :=
  match exactly exprField proof with
  | none => false
  | some value =>
    match Lean4Lean.TypeChecker.M.run context.env (x := do
      let inferred ← Lean4Lean.TypeChecker.check value []
      Lean4Lean.TypeChecker.isDefEq inferred context.goal) with
    | .ok result => result
    | .error _ => false

end R6.KernelCell
