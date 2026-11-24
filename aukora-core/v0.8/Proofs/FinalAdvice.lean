import Proofs.Root12Availability
import Proofs.RawRecord

namespace Aukora.RootFinal
open Release
open R6.KernelCell (Context)
open private Advice7.Pair Advice7.pairGet Advice7.InnerEq.mk Advice7.InnerEq.led Advice7.InnerEq.stage
  Advice7.LedgerEq.book from Proofs.Advice
open private Advice.Equiv Advice.Equiv.refl Advice.Equiv.mk Advice.BaseEq.mk Advice.one
  Advice.stampOne Advice.pairedVerdict Advice.Equiv.toBaseEq Advice.Equiv.rules Advice.Equiv.findings
  Advice.BaseEq.inner Advice.BaseEq.keys Advice.BaseEq.risk from Proofs.AdvicePolicy
open private Release.submitted from Proofs.RawRecord
open private Core8.slice from Ledger.Assessed

abbrev machine := Safe11.fullModel

/-- The additional evidence and halt guards read the same raw history at both risk scores. -/
private theorem absent {o : Option α} : o.isSome = false ↔ o = none := by cases o <;> simp

theorem full_monotone : MonotoneLaw machine := by
  intro ctx w s i lo hi b tag cmd le refused
  have other := cmd.1
  have halt (z : UInt8) : Safe11.halted (atScore s (Risk8.intentDigest i) z b) = Safe11.halted s := rfl
  have evidence (z : UInt8) : Evidence11.allows (atScore s (Risk8.intentDigest i) z b) w i =
      Evidence11.allows s w i := rfl
  have raw (z : UInt8) : (machine.step ctx w (atScore s (Risk8.intentDigest i) z b)).isSome =
      (if Safe11.halted s && !Safe11.allowedOrdinary w then false else
        if Evidence11.allows s w i then (newest.step ctx w (atScore s (Risk8.intentDigest i) z b)).isSome else false) := by
    cases a : Safe11.halted s <;> cases o : Safe11.allowedOrdinary w <;> cases e : Evidence11.allows s w i <;>
      simp [machine,Safe11.fullModel,Round11.step,Safe11.step,Safe11.raw,Safe11.route,tag,
        halt,a,o,Evidence11.step,Evidence11.routed,cmd.2,evidence,e,guard,Ratchet11.step,
        Ratchet11.allow_ordinary other,newest]
  apply absent.mp
  have low := absent.mpr refused
  rw [raw] at low ⊢
  by_cases stopped : (Safe11.halted s && !Safe11.allowedOrdinary w) = true
  · simp [stopped]
  by_cases pass : Evidence11.allows s w i = true
  · simp only [stopped,pass,if_false,if_true] at low ⊢
    exact absent.mpr (newest_monotone ctx w s i lo hi b tag cmd le (absent.mp low))
  · simp [pass,stopped]

namespace Paired
open Evidence11
private abbrev R := Array ByteArray

/-- These projections are all the ways the evidence guard reads prior bytes.
    Knowing their equality permits the two heads and the advisory bytes to differ. -/
private structure Reads (a b : R) : Prop where
  size : a.size = b.size
  decoded : ∀ (n : Nat), a[n]?.bind decode = b[n]?.bind decode
  levels : ∀ (z : UInt8) (n : Nat), (a[n]?.map (ceilingAfter z)) = (b[n]?.map (ceilingAfter z))
  today : a.toList.foldl ceilingAfter 0 = b.toList.foldl ceilingAfter 0
  assessment : ∀ d, selected a d = selected b d

private theorem Reads.refl (a : R) : Reads a a := ⟨rfl,fun _ => rfl, fun _ _ => rfl,rfl,fun _ => rfl⟩

private theorem position {a b : R} (eq : Reads a b) (r) : atPos a r = atPos b r := by
  have eqBody := eq.decoded (r-1)
  by_cases pos : 0 < r
  · let result (d : Option Evidence11.Envelope) := d.bind fun e => if e.seq = r then some e.body else none
    have fold (h : R) : atPos h r = result (h[r-1]?.bind decode) := by
      cases hx : h[r-1]? with
      | none => simp [atPos,result,guard,pos,hx]
      | some w =>
        cases d : decode w with
        | none => simp [atPos,result,guard,pos,hx,d]
        | some e => by_cases good : e.seq = r <;> simp [atPos,result,guard,pos,hx,d,good] <;> rfl
    rw [fold,fold,eqBody]
  · simp [atPos,guard,pos]; rfl

private theorem grades {a b : R} (eq : Reads a b) (pos z vs c) :
    grade a pos z vs c = grade b pos z vs c := by
  simp only [grade,bound,recordedValue,refsOK,absenceOK,recordsAbsence,position eq,eq.size]

private theorem indexEq {a b : R} (eq : Reads a b) (z) (n) : index a z n = index b z n := by
  induction n with
  | zero => rfl
  | succ n ih =>
    unfold index
    rw [ih,position eq]
    simp only [grades eq]
    have c := eq.levels (index b z n).ceilingAtPosition n
    cases h : a[n]? <;> cases k : b[n]? <;> simp [h,k] at c <;> simp_all

private theorem allowEq {s t : Release.State} (eq : Reads s.base.record t.base.record)
    (seq : Policy9.nextSeq s = Policy9.nextSeq t) {wx wy : ByteArray} (i)
    (bundle : (wx.extract 1 33).data.toList = (wy.extract 1 33).data.toList) :
    allows s wx i = allows t wy i := by
  have today : ceiling s = ceiling t := eq.today
  simp only [allows,eq.assessment,seq,bundle,eq.size,today,indexEq eq,grades eq]

private theorem assessPush (h : R) (w : ByteArray) (key) (legacy : w[0]? ≠ some (255 : UInt8)) :
    selected (h.push w) key =
      if w[0]? = some 21 ∧ Digest.mk ((w.extract 41 73).data.toList) = key then none else selected h key := by
  have dec : decode w = none := by simp [decode,subtag,cellSubtag,legacy]
  simp only [selected,← Array.foldl_toList,Array.push_toList,List.foldl_append,List.foldl_cons,List.foldl_nil,dec]
  split <;> simp_all

private theorem readsPush {a b : R} {x y : ByteArray} (eq : Reads a b)
    (lx : x[0]? ≠ some (255 : UInt8)) (ly : y[0]? ≠ some (255 : UInt8))
    (assess : ∀ d : Digest, (x[0]? = some 21 ∧ Digest.mk ((x.extract 41 73).data.toList) = d) ↔
      (y[0]? = some 21 ∧ Digest.mk ((y.extract 41 73).data.toList) = d)) : Reads (a.push x) (b.push y) := by
  have dx : decode x = none := by simp [decode,subtag,cellSubtag,lx]
  have dy : decode y = none := by simp [decode,subtag,cellSubtag,ly]
  have cx (z) : ceilingAfter z x = z := by simp [ceilingAfter,subtag,lx]
  have cy (z) : ceilingAfter z y = z := by simp [ceilingAfter,subtag,ly]
  constructor
  · simp [eq.size]
  · intro n
    by_cases last : n = a.size
    · rw [show n = a.size from last,Array.getElem?_push_size,eq.size,Array.getElem?_push_size]; simp [dx,dy]
    · simpa [Array.getElem?_push,last,← eq.size] using eq.decoded n
  · intro z n
    by_cases last : n = a.size
    · rw [show n = a.size from last,Array.getElem?_push_size,eq.size,Array.getElem?_push_size]; simp [cx,cy]
    · simpa [Array.getElem?_push,last,← eq.size] using eq.levels z n
  · simp [List.foldl_append,cx,cy,eq.today]
  · intro d
    simp only [assessPush _ _ _ lx,assessPush _ _ _ ly,assess d,eq.assessment]

private def role : Policy9.Command → Nat
  | .assessment => 1 | .use _ => 2 | _ => 0

open private Policy9.full Policy9.issueFields Policy9.cancelFields from Policy
private theorem parseRole {w : ByteArray} {c : Policy9.Command} (ok : Policy9.decode w = some c) :
    role c = (if w[0]? = some 21 then 1 else if w[0]? = some 23 then 2 else 0) := by
  unfold Policy9.decode at ok
  obtain ⟨tag,hdr,run⟩ := Option.bind_eq_some.mp ok
  rw [hdr]
  split at run
  · obtain ⟨⟨x,r⟩,h,after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.issueFields at h
    simp only [bind,StateT.bind,pure,StateT.pure,Option.pure_def,Option.bind_eq_some] at h
    grind [role]
  · obtain ⟨⟨x,r⟩,h,after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.cancelFields at h
    simp only [bind,StateT.bind,pure,StateT.pure,Option.pure_def,Option.bind_eq_some] at h
    grind [role]
  · obtain ⟨x,_,after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after
    rfl
  · obtain ⟨x,_,after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after <;> rfl
  · cases run; rfl
  · cases run; rfl
  · obtain ⟨r,rq,after⟩ := Option.bind_eq_some.mp run
    obtain ⟨x,_,after⟩ := Option.bind_eq_some.mp after
    have tags : tag ≠ 21 ∧ tag ≠ 23 := by grind
    simp [tags.1,tags.2]
    split at after <;> try contradiction
    all_goals first | cases after; rfl | split at after <;> cases after <;> rfl

private theorem legacyTag {w c} (p : Advice.Parsed w c) : w[0]? ≠ some (255 : UInt8) := by
  intro tag
  have h := p.2
  rw [Root12.legacy_decoder_ff tag] at h
  contradiction

private def checks (ctx : Context) (s : Release.State) (w : ByteArray) :=
  Ratchet11.allow ctx w s && !(Safe11.halted s && !Safe11.allowedOrdinary w) &&
  match Policy9.decode w with | some (.use i) => allows s w i | _ => true

private theorem ordinaryFull {w : ByteArray} (old : w[0]? ≠ some (255 : UInt8)) (ctx : Context) (s : Release.State) :
    machine.step ctx w s = if checks ctx s w then Core9.step ctx w s else none := by
  have wrap (v : Release.State) (hit : Core9.step ctx w s = some v) :
      ({v with base.record := s.base.record.push w} : Release.State) = v := by rw [← Release.submitted hit]
  cases dec : Policy9.decode w with
  | none =>
    by_cases tag : w[0]? = some (23 : UInt8)
    · have no : Core9.step ctx w s = none := by simp [Core9.step,tag,Policy9.step,dec]
      simp [machine,Safe11.fullModel,Round11.step,Safe11.step,Safe11.raw,Safe11.route,tag,
        Evidence11.step,routed,dec,checks,no]
    · cases block : (Safe11.halted s && !Safe11.allowedOrdinary w) <;> cases pass : Ratchet11.allow ctx w s <;>
        cases core : Core9.step ctx w s <;>
        simp [machine,Safe11.fullModel,Round11.step,Safe11.step,Safe11.raw,Safe11.route,old,
          Evidence11.step,routed,tag,subtag,cellSubtag,checks,dec,block,pass,Ratchet11.step,core,wrap]
  | some c =>
    have roleEq := parseRole dec
    cases c with
    | use i =>
      have tag : w[0]? = some (23 : UInt8) := by split at roleEq <;> simp_all [role] <;> split at roleEq <;> simp_all
      cases block : (Safe11.halted s && !Safe11.allowedOrdinary w) <;> cases pass : Ratchet11.allow ctx w s <;>
        cases ev : allows s w i <;> cases core : Core9.step ctx w s <;>
        simp [machine,Safe11.fullModel,Round11.step,Safe11.step,Safe11.raw,Safe11.route,tag,
          Evidence11.step,routed,checks,dec,block,pass,ev,guard,Ratchet11.step,core,wrap]
    | _ =>
      all_goals
        have tag : w[0]? ≠ some (23 : UInt8) := by intro no; simp [no,role] at roleEq
        cases block : (Safe11.halted s && !Safe11.allowedOrdinary w) <;> cases pass : Ratchet11.allow ctx w s <;>
          cases core : Core9.step ctx w s <;>
          simp [machine,Safe11.fullModel,Round11.step,Safe11.step,Safe11.raw,Safe11.route,old,
            Evidence11.step,routed,tag,subtag,cellSubtag,checks,dec,block,pass,Ratchet11.step,core,wrap]

private structure Agree (s t : Release.State) : Prop where
  reads : Reads s.base.record t.base.record
  pin : Ratchet11.current s = Ratchet11.current t
  halt : Safe11.halted s = Safe11.halted t

private structure PairFields (ctx : Context) (s t : Release.State) (x y : ByteArray) : Prop where
  lx : x[0]? ≠ some (255 : UInt8)
  ly : y[0]? ≠ some (255 : UInt8)
  checks : checks ctx s x = checks ctx t y
  pin : Ratchet11.update (Ratchet11.current s) x = Ratchet11.update (Ratchet11.current t) y
  assessment : ∀ d : Digest, (x[0]? = some 21 ∧ Digest.mk ((x.extract 41 73).data.toList) = d) ↔
      (y[0]? = some 21 ∧ Digest.mk ((y.extract 41 73).data.toList) = d)

private theorem parsedFields {ctx s t x y c e} (a : Agree s t) (px : Advice.Parsed x c) (py : Advice.Parsed y e)
    (safe : Safe11.allowedCommand c = Safe11.allowedCommand e)
    (ev : (match c with | .use i => allows s x i | _ => true) =
          (match e with | .use i => allows t y i | _ => true))
    (key : role c = 1 → (x.extract 41 73).data.toList = (y.extract 41 73).data.toList)
    (same : role c = role e) : PairFields ctx s t x y := by
  classical
  have ax : Upgrade9.decode x = none := by simp [Upgrade9.decode, guard,px.1]
  have ay : Upgrade9.decode y = none := by simp [Upgrade9.decode, guard,py.1]
  refine ⟨legacyTag px,legacyTag py,?_,?_,?_⟩
  · cases c <;> cases e <;> simp_all only [checks,Ratchet11.allow_ordinary px.1,Ratchet11.allow_ordinary py.1,Safe11.allowedOrdinary,
      px.2,py.2,safe,ev,a.halt] <;> first | rfl | simp_all
  · simp [Ratchet11.update,ax,ay,Option.orElse,a.pin]
  · have rx := parseRole px.2
    have ry := parseRole py.2
    intro d
    by_cases hx : x[0]? = some (21 : UInt8)
    · have one : role c = 1 := by simp [hx] at rx; exact rx
      have hy : y[0]? = some (21 : UInt8) := by
        by_contra no
        simp [no] at ry
        rw [← same,one] at ry
        split at ry <;> contradiction
      simp [hx,hy,key one]
    · have hy : y[0]? ≠ some (21 : UInt8) := by
        intro tag
        rw [←same] at ry
        simp [tag] at ry
        simp [hx,ry] at rx
        split at rx <;> contradiction
      simp [hx,hy]

private theorem matched {s t x y ctx} (h : Advice.Equiv s t) (a : Agree s t)
    (p : Advice.Matched s t x y) : PairFields ctx s t x y := by
  cases p with
  | install u v tx ty dx dy hx hy tgt m cert intent =>
    have lx : Policy9.decode x = none := by simp [Policy9.decode,tx,Core8.request]
    have ly : Policy9.decode y = none := by simp [Policy9.decode,ty,Core8.request]
    refine ⟨by simp [tx],by simp [ty],?_,?_,by simp [tx,ty]⟩
    · simp [checks,Ratchet11.allows_match a.pin tx ty dx dy m cert intent,lx,ly,Safe11.allowedOrdinary,
        Safe11.outcomeWire,tx,ty,a.halt]
    · simp [Ratchet11.update,dx,dy,Ratchet11.packagePin,m,cert,a.pin]
  | ordinary _ _ _ _ dx dy _ _ op =>
    apply parsedFields a dx dy _ rfl (by intro bad; cases bad) rfl
    cases op with
    | equal act => simp [Safe11.allowedCommand,act]
    | advice _ _ _ ax ay => simp [Safe11.allowedCommand,ax,ay]
    | control op _ _ _ _ ax ay => cases op <;> simp [Safe11.allowedCommand,ax,ay]
  | use i g v z dx dy _ _ _ _ _ _ _ _ _ bundle =>
    apply parsedFields a dx dy rfl _ (by intro bad; cases bad) rfl
    exact allowEq a.reads (by
      exact congrArg (fun b : Book => b.seq + 1) (Advice7.LedgerEq.book (Advice7.InnerEq.led
        (Advice.BaseEq.inner (Advice.Equiv.toBaseEq h))))) i bundle
  | assessment _ _ _ _ _ dx dy _ _ _ _ _ _ intent _ _ _ =>
    exact parsedFields a dx dy rfl rfl (fun _ => intent) rfl
  | rebind _ _ _ _ _ _ _ _ _ dx dy | report _ _ _ _ _ _ _ dx dy
    | issue _ _ _ _ _ _ _ _ _ _ dx dy | cancel _ _ _ _ _ _ _ _ _ dx dy | threshold _ _ _ _ _ dx dy =>
    exact parsedFields a dx dy rfl rfl (by intro h; cases h) rfl

private theorem framePair {s t x y ctx} (h : Advice.Equiv s t) (a : Agree s t)
    (p : Advice.Matched s t x y) :
    Advice7.Pair Advice.Equiv (machine.step ctx x s) (machine.step ctx y t) ∧
    Agree (execute machine ctx s (.frame x)) (execute machine ctx t (.frame y)) := by
  have f := matched (ctx := ctx) h a p
  have left := ordinaryFull f.lx ctx s
  have right := ordinaryFull f.ly ctx t
  rw [f.checks] at left
  simp only [execute,left,right]
  cases pass : checks ctx t y with
  | false => exact ⟨.none,a⟩
  | true =>
    simp only [if_true]
    have pair := Advice.one (ctx := ctx) h p
    refine ⟨pair,?_⟩
    cases ex : Core9.step ctx x s <;> cases ey : Core9.step ctx y t <;>
      rw [ex,ey] at pair <;> cases pair
    · exact a
    · have xr := Release.submitted ex
      have yr := Release.submitted ey
      exact ⟨by simp only [Option.getD_some,xr,yr]; exact readsPush a.reads f.lx f.ly f.assessment,
        (Ratchet11.current_push xr).trans (f.pin.trans (Ratchet11.current_push yr).symm),
        by simp only [Option.getD_some,Safe11.halted,xr,yr,Array.push_toList,List.foldl_append,
                      List.foldl_cons,List.foldl_nil]
           simpa [Safe11.flagAfter,Safe11.route,f.lx,f.ly] using (show s.base.record.toList.foldl Safe11.flagAfter false = t.base.record.toList.foldl Safe11.flagAfter false from a.halt)⟩

private theorem stampSame (s : Release.State) (w : ByteArray) :
    ((machine.stamp w s).getD s).base.record = s.base.record := by
  cases hit : machine.stamp w s with
  | none => rfl
  | some v => exact (newest_stamp w s v hit).2 ▸ rfl

private theorem trace {s t xs ys ctx} (p : Advice.Aligned machine ctx s t xs ys)
    (h : Advice.Equiv s t) (a : Agree s t) :
    Advice.Equiv (run machine ctx s xs) (run machine ctx t ys) ∧
    Advice.verdicts machine ctx s xs = Advice.verdicts machine ctx t ys := by
  induction p with
  | nil => exact ⟨h,rfl⟩
  | frame pair _ ih =>
    obtain ⟨paired, views⟩ := framePair (ctx := ctx) h a pair
    have tail := ih (Advice7.pairGet paired h) views
    refine ⟨tail.1,?_⟩
    simp only [Advice.verdicts,tail.2,List.cons.injEq,and_true]; exact Advice.pairedVerdict paired
  | feed _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq
      (congrArg (· ++ _) (Advice7.InnerEq.stage inner))) keys risk) rules findings) ⟨a.reads,a.pin,a.halt⟩
  | reset _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq rfl)
      keys risk) rules findings) ⟨a.reads,a.pin,a.halt⟩
  | @stamp s t wx wy _ _ _ ih =>
    have left := Advice.stampOne s wx
    have right := Advice.stampOne t wy
    apply ih
    · change Advice.Equiv ((newest.stamp wx s).getD s) ((newest.stamp wy t).getD t)
      constructor
      · constructor
        · rw [left.1,right.1]; exact (Advice.BaseEq.inner (Advice.Equiv.toBaseEq h))
        · rw [left.1,right.1]; exact (Advice.BaseEq.keys (Advice.Equiv.toBaseEq h))
        · exact left.2.1.trans ((Advice.BaseEq.risk (Advice.Equiv.toBaseEq h)).trans right.2.1.symm)
      · exact left.2.2.1.trans ((Advice.Equiv.rules h).trans right.2.2.1.symm)
      · exact left.2.2.2.trans ((Advice.Equiv.findings h).trans right.2.2.2.symm)
    · constructor
      · simpa only [execute,stampSame] using a.reads
      · simpa only [execute,Ratchet11.current,stampSame] using a.pin
      · simpa only [execute,Safe11.halted,stampSame] using a.halt

end Paired

theorem full_advice : AdviceLaw machine := by
  intro ctx s xs ys aligned
  obtain ⟨paired,vs⟩ := Paired.trace aligned (Advice.Equiv.refl s) ⟨.refl _,rfl,rfl⟩
  exact ⟨Prod.ext (Advice.BaseEq.keys (Advice.Equiv.toBaseEq paired))
    (congrArg Book.auth (Advice7.LedgerEq.book (Advice7.InnerEq.led
      (Advice.BaseEq.inner (Advice.Equiv.toBaseEq paired))))),vs⟩
#print axioms full_monotone
#print axioms full_advice
end Aukora.RootFinal
