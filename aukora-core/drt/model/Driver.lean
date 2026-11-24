import Public
import SegmentFinal
import Bound12c

/-! THE MODEL AS AN EXECUTOR, for differential testing. This program calls the same Lean functions the proofs are
about (the public step, feed, reset and stamp of `Public.lean`, the segment functions, the bound genesis) and runs
them under Lean's INTERPRETER, so no compiled C is involved on this side at all. Around them it restates, in Lean, the
bookkeeping the C shim (`Interface.c`, small-core profile) keeps: the 512-entry and 2 MiB segment limits, the
16-entry recovery reserve, the sealed state, the record identifier and the journal.
It reads the same input stream as `drt/native/` and prints the same line per input, so its output can be compared
with the WebAssembly core's byte for byte.
Usage: lean --run Driver.lean <32-byte law identity file> < stream.in > stream.model     (with LEAN_PATH set to a
built v0.10 library). The restatement of the shim is ours and is NOT proved to equal the C; a difference between the
two shows up as a differing line. -/

open Aukora

structure Shim where
  cur : Option Policy9.Machine := none
  journal : Option ByteArray := none
  sealed : Option ByteArray := none
  staged : Nat := 0
  bytes : Nat := 0
  entries : Nat := 0
  recov : Nat := 0
  rid : Option ByteArray := none
  hasLaw : Bool := false

def stagingCap := 16 * 1024 * 1024
def recordByteCap := 2 * 1024 * 1024
def entryCap := 512
def recoverySlots := 16
def frameCap := 1024 * 1024 + 2 * 65535 + 128

def hexDigit (c : Char) : Nat := if c.isDigit then c.toNat - '0'.toNat else (c.toLower.toNat - 'a'.toNat) + 10
def unhex (s : String) : ByteArray := Id.run do
  let cs := s.toList.toArray; let mut out := ByteArray.empty; let mut i := 0
  while i + 1 < cs.size do
    out := out.push (UInt8.ofNat (hexDigit cs[i]! * 16 + hexDigit cs[i+1]!)); i := i + 2
  return out
def hex2 (n : Nat) : String := let d := "0123456789abcdef".toList; String.mk [d[n / 16]!, d[n % 16]!]
def b32 (f : Nat → Nat) : String := Id.run do
  let mut s := ""
  for i in [0:32] do
    let v := f i
    if v > 255 then return "none"
    s := s ++ hex2 v
  return s
def bytes32 (b : Option ByteArray) : String :=
  match b with | some x => b32 (fun i => if h : i < x.size then x[i].toNat else 256) | none => "none"

def ordinaryRoom (st : Shim) (size : Nat) : Bool := st.entries < entryCap && size ≤ recordByteCap - st.bytes

def entryInput (st : Shim) (w : ByteArray) (allowRecovery : Bool) : Bool :=
  st.cur.isSome && st.sealed.isNone &&
  (ordinaryRoom st w.size ||
    (allowRecovery && st.recov < recoverySlots && w.size > 0 &&
      (w[0]! == 20 || (w.size ≥ 3 && w[0]! == 255 && w[1]! == 2 && (w[2]! == 51 || w[2]! == 53)))))

def committed (st : Shim) (w : ByteArray) (kind : UInt8) (ordinary : Bool) : Shim :=
  let st := if ordinary then { st with entries := st.entries + 1, bytes := st.bytes + w.size } else { st with recov := st.recov + 1 }
  { st with journal := st.journal.map (fun j => SegmentFinal.entry j kind w) }

def run1 (law : ByteArray) (st : Shim) (op : String) (w : ByteArray) : Shim × Nat :=
  if w.size > frameCap then (st, 0) else
  match op with
  | "init" =>
    if st.cur.isSome then (st, 0) else
    match Core9.genesis w with
    | some m => ({ st with cur := some m, hasLaw := true, journal := some (SegmentFinal.first law m) }, 1)
    | none => (st, 0)
  | "initBound" =>
    if st.cur.isSome || w.size != 1984 + 32 then (st, 0) else
    let keys := w.extract 0 1984; let host := w.extract 1984 2016
    match Core9.genesis keys with
    | none => (st, 0)
    | some _ =>
      let st := { st with hasLaw := true }
      match Bound12c.boundGenesis law keys host with
      | none => (st, 0)
      | some m =>
        let rid := ByteArray.mk ((List.range 32).map (fun i => UInt8.ofNat (Core9.headByte m (UInt32.ofNat i)))).toArray
        ({ st with cur := some m, rid := some rid, journal := some (SegmentFinal.first law m) }, 1)
  | "reset" =>
    match st.cur with
    | some m => if st.sealed.isSome then (st, 0) else ({ st with staged := 0, cur := some (Public.reset m) }, 1)
    | none => (st, 0)
  | "feed" =>
    match st.cur with
    | some m => if st.sealed.isSome || w.size > stagingCap - st.staged then (st, 0)
                else ({ st with staged := st.staged + w.size, cur := some (Public.feed w m) }, 1)
    | none => (st, 0)
  | "step" =>
    if !entryInput st w true then (st, 0) else
    let ordinary := ordinaryRoom st w.size
    if !ordinary && SessionFinal.recoveryKind w == 0 then (st, 0) else
    match st.cur with
    | none => (st, 0)
    | some m =>
      match Public.liteStep w m with
      | none => (st, 0)
      | some t =>
        let st := committed { st with cur := some t } w 0 ordinary
        let st := if w.size > 0 && w[0]! == 27 then { st with staged := 0, hasLaw := true } else st
        (st, 1)
  | "stamp" =>
    if !entryInput st w false then (st, 0) else
    match st.cur with
    | none => (st, 0)
    | some m =>
      match Public.stamp w m with
      | none => (st, 0)
      | some t => (committed { st with cur := some t } w 1 true, 1)
  | "seal" =>
    match st.cur, st.journal with
    | some m, some j =>
      if !st.hasLaw || st.sealed.isSome then (st, 0) else
      match SegmentFinal.closeRecord j law w m with
      | some h => ({ st with sealed := some h }, 1)
      | none => (st, 0)
    | _, _ => (st, 0)
  | "continueRecord" =>
    match st.sealed, st.cur with
    | some h, some m =>
      match SegmentFinal.continueAt h law w m with
      | some t => ({ st with cur := some t, sealed := none, journal := some (Judge12.digest w), entries := 0, bytes := 0, recov := 0 }, 1)
      | none => (st, 0)
    | _, _ => (st, 0)
  | _ => (st, 0)

def view (law : ByteArray) (st : Shim) : String :=
  let cur := st.cur
  let h := match cur with | some m => b32 (fun i => Core9.headByte m (UInt32.ofNat i)) | none => "none"
  let c := match cur with | some m => b32 (fun i => Core9.coreByte m (UInt32.ofNat i)) | none => "none"
  let l := if st.hasLaw then bytes32 (some law) else "none"
  let scal := match cur with
    | some m => s!"{(Round11.halted m).toNat},{Core9.threshold m},{(Round11.ceiling m).toNat},{Core9.stampCount m}"
    | none => "256,256,256,0"
  s!"{h}|{c}|{bytes32 st.rid}|{l}|{bytes32 st.journal}|{bytes32 st.sealed}|{scal}"

partial def loop (law : ByteArray) (stdin : IO.FS.Stream) (stdout : IO.FS.Stream) (st : Shim) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  let line := line.trimRight
  if line == "NEW" then loop law stdin stdout {} else
  match line.splitOn " " with
  | [op, h] =>
    let w := if h == "-" then ByteArray.empty else unhex h
    let (st', v) := run1 law st op w
    stdout.putStrLn s!"{v} {view law st'}"
    stdout.flush
    loop law stdin stdout st'
  | _ => stdout.putStrLn "ERR bad line"

def main (args : List String) : IO UInt32 := do
  let law ← IO.FS.readBinFile (args.headD "root.id")
  if law.size != 32 then IO.eprintln "the law identity file must hold 32 bytes"; return 2
  loop law (← IO.getStdin) (← IO.getStdout) {}
  return 0
