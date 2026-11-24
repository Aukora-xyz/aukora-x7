import Lean.Elab.Command
import Lean.Util.FoldConsts

open Lean

namespace Release.Serialization

-- Version 1 uses prefix tags, unsigned LEB128 naturals and length-prefixed UTF-8.
-- Unknown constructors cause an error. Neither stream contains a pretty-printed term.
abbrev Bytes := List UInt8

def varNat (n : Nat) : Bytes :=
  if h : n < 128 then [n.toUInt8]
  else (128 + n % 128).toUInt8 :: varNat (n / 128)
termination_by n
decreasing_by exact Nat.div_lt_self (by omega) (by decide)

def putString (s : String) : Bytes :=
  let bytes := s.toUTF8
  varNat bytes.size ++ bytes.data.toList

def putName : Name → Bytes
  | .anonymous => [0]
  | .str p s => 1 :: (putName p ++ putString s)
  | .num p i => 2 :: (putName p ++ varNat i)

def putLevel : Level → Except String Bytes
  | .zero => pure [0]
  | .succ u => return 1 :: (← putLevel u)
  | .max u v => return 2 :: ((← putLevel u) ++ (← putLevel v))
  | .imax u v => return 3 :: ((← putLevel u) ++ (← putLevel v))
  | .param n => pure (4 :: putName n)
  | .mvar _ => throw "unexpected universe metavariable"

def binderTag : BinderInfo → UInt8
  | .default => 0
  | .implicit => 1
  | .strictImplicit => 2
  | .instImplicit => 3

def exprBytes (skipMetadata : Bool) : Expr → Except String Bytes
  | .bvar i => pure (0 :: varNat i)
  | .sort u => return 1 :: (← putLevel u)
  | .const n us => return 2 :: (putName n ++ varNat us.length ++ (← us.mapM putLevel).flatten)
  | .app f a => return 3 :: ((← exprBytes skipMetadata f) ++ (← exprBytes skipMetadata a))
  | .lam n ty body bi => return 4 :: binderTag bi :: (putName n ++ (← exprBytes skipMetadata ty) ++ (← exprBytes skipMetadata body))
  | .forallE n ty body bi => return 5 :: binderTag bi :: (putName n ++ (← exprBytes skipMetadata ty) ++ (← exprBytes skipMetadata body))
  | .letE n ty val body nd =>
    return 6 :: nd.toUInt8 :: (putName n ++ (← exprBytes skipMetadata ty) ++ (← exprBytes skipMetadata val) ++ (← exprBytes skipMetadata body))
  | .lit (.natVal n) => pure (7 :: varNat n)
  | .lit (.strVal s) => pure (8 :: putString s)
  | .proj n i e => return 9 :: (putName n ++ varNat i ++ (← exprBytes skipMetadata e))
  | .mdata _ body => if skipMetadata then exprBytes skipMetadata body else throw "metadata outside R6 format"
  | .fvar .. => throw "unexpected free variable"
  | .mvar .. => throw "unexpected metavariable"

def refsIn (e : Expr) (s : NameSet) : NameSet :=
  match e with
  | .const n _ => s.insert n
  | .proj n _ b => refsIn b (s.insert n)
  | .app f a => refsIn a (refsIn f s)
  | .lam _ t b _ | .forallE _ t b _ => refsIn b (refsIn t s)
  | .letE _ t v b _ => refsIn b (refsIn v (refsIn t s))
  | .mdata _ b => refsIn b s
  | .lit (.natVal _) => s.insert ``Nat
  | .lit (.strVal _) => [``String, ``Char, ``List, ``Char.ofNat].foldl NameSet.insert s
  | _ => s

def putNames (ns : List Name) : Bytes := varNat ns.length ++ ns.flatMap putName

def hintBytes : ReducibilityHints → Bytes
  | .opaque => [0]
  | .abbrev => [1]
  | .regular n => 2 :: varNat n.toNat

def quotTag : QuotKind → UInt8
  | .type => 0
  | .ctor => 1
  | .lift => 2
  | .ind => 3

-- The fixed imported environment treats previously checked theorem types and opaque
-- constants as axioms. It carries the actual bodies of safe reducible definitions.
-- Expression metadata is transparent to the kernel and omitted from this snapshot.
def record (c : ConstantInfo) : Except String (Bytes × NameSet × String) := do
  if c.isUnsafe || c.isPartial then throw s!"unsafe or partial dependency {c.name}"
  let header := putName c.name ++ putNames c.levelParams ++ (← exprBytes true c.type)
  let typeRefs := refsIn c.type {}
  let done := fun (tag : UInt8) (fields : Bytes) (deps : NameSet) (kind : String) =>
    (tag :: (header ++ fields), deps, kind)
  match c with
  | .axiomInfo _ => return done 0 [] typeRefs "axiom"
  | .thmInfo _ => return done 0 [] typeRefs "trusted-theorem"
  | .opaqueInfo _ => return done 0 [] typeRefs "trusted-opaque"
  | .defnInfo d =>
    let fields := (← exprBytes true d.value) ++ hintBytes d.hints ++ putNames d.all
    return done 1 fields (d.all.foldl NameSet.insert (refsIn d.value typeRefs)) "definition"
  | .inductInfo d =>
    let fields := varNat d.numParams ++ varNat d.numIndices ++ putNames d.all ++ putNames d.ctors ++
      varNat d.numNested ++ [d.isRec.toUInt8, d.isUnsafe.toUInt8, d.isReflexive.toUInt8]
    return done 2 fields ((d.all ++ d.ctors).foldl NameSet.insert typeRefs) "inductive"
  | .ctorInfo d =>
    let fields := putName d.induct ++ varNat d.cidx ++ varNat d.numParams ++
      varNat d.numFields ++ [d.isUnsafe.toUInt8]
    return done 3 fields (typeRefs.insert d.induct) "constructor"
  | .recInfo d =>
    let mut deps := d.all.foldl NameSet.insert typeRefs
    let mut rules : Bytes := []
    for rule in d.rules do
      deps := refsIn rule.rhs (deps.insert rule.ctor)
      rules := rules ++ putName rule.ctor ++ varNat rule.nfields ++ (← exprBytes true rule.rhs)
    let fields := putNames d.all ++ varNat d.numParams ++ varNat d.numIndices ++
      varNat d.numMotives ++ varNat d.numMinors ++ varNat d.rules.length ++ rules ++
      [d.k.toUInt8, d.isUnsafe.toUInt8]
    return done 4 fields deps "recursor"
  | .quotInfo d => return done 5 [quotTag d.kind] typeRefs "quotient"

end Release.Serialization
