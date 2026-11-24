/- Public event, intent, authority and ledger types. -/
namespace Aukora

abbrev Bytes := List UInt8

structure Digest where
  bytes : Bytes
  deriving DecidableEq, Repr

inductive Body where
  | deliver (payload : Bytes)
  | install (target : Digest)
  deriving DecidableEq, Repr

structure Intent where
  body : Body
  audience : String
  generation : Nat
  nonce : Nat
  deriving DecidableEq, Repr

inductive Result where
  | confirmed | failed | unknown
  deriving DecidableEq, Repr

inductive Event where
  | say (line : String)
  | remember (id source : Nat) (text : String)
  | correct (old replacement : Nat) (reason : String)
  -- Host reports verification by the currently bound owner over this exact intent.
  | grant (intent : Intent) (ownerVerified : Bool)
  | act (intent : Intent)
  -- The destination's report is input, including when it reports uncertainty.
  | outcome (intent : Intent) (reported : Result)
  | advise (cell : String) (score : Nat)
  -- Host reports proof checking for this exact candidate. The old core checks its grant.
  | upgrade (newCore : Digest) (proofChecked : Bool) (intent : Intent)
  -- Host reports current-owner verification over this binding at the current generation.
  | rebind (newOwner : String) (ownerVerified : Bool)
  deriving DecidableEq, Repr

structure Envelope where
  parent : Digest
  seq : Nat
  event : Event
  deriving DecidableEq, Repr

abbrev Hasher := Envelope → Digest

structure Authority where
  owner : String
  generation : Nat := 0
  core : Digest
  grants : List Intent := []
  admitted : List Intent := []
  deriving DecidableEq, Repr

structure Claim where
  id : Nat
  source : Nat  -- Earlier envelope sequence number, starting at one.
  text : String
  deriving DecidableEq, Repr

structure Correction where
  old : Nat
  replacement : Nat
  reason : String
  deriving DecidableEq, Repr

-- Data that can influence acceptance of the next correctly addressed envelope.
structure Book where
  seq : Nat := 0
  auth : Authority
  claims : List Claim := []
  corrections : List Correction := []
  deriving DecidableEq, Repr

structure State where
  head : Digest
  book : Book
  record : List Envelope := []
  lines : List String := []
  outcomes : List (Intent × Result) := []
  advice : List (String × Nat) := []
  deriving DecidableEq, Repr

end Aukora
