import Round11

namespace Aukora.Evidence11

private theorem routed_of_step {prior w s t} (ok : step prior w s = some t) :
    ∃ u, routed prior w s = some u ∧ t.base.record = s.base.record.push w := by
  obtain ⟨u, run, eq⟩ := Option.map_eq_some'.mp ok
  cases eq
  exact ⟨u, run, rfl⟩

/-- Composition used by the release-2 research cell. -/
abbrev publicStep (prior : BaseStep) := Safe11.step (step prior)

private theorem ordinary_passed {prior w s t} (ok : publicStep prior w s = some t)
    (ordinary : Safe11.route w = .ordinary) :
    ∃ u, step prior w s = some u ∧ t.base.record = s.base.record.push w := by
  obtain ⟨u,raw,eq⟩ := Option.map_eq_some'.mp ok
  cases eq
  by_cases blocked : (Safe11.halted s && !Safe11.allowedOrdinary w) = true
  · simp [Safe11.raw,ordinary,blocked] at raw
  · exact ⟨u,by simpa [Safe11.raw,ordinary,blocked] using raw,rfl⟩

def Names (s : Policy9.Machine) (w : ByteArray) (i : Intent) (a : Assessment) : Prop :=
  w[0]? = some 23 ∧ Policy9.decode w = some (.use i) ∧
    selected s.base.record (Risk8.intentDigest i) = some a

private theorem selected_ok {prior w s t i a} (ok : publicStep prior w s = some t) (named : Names s w i a) :
    (a.bundle = ⟨(w.extract 1 33).data.toList⟩ ∧ 0 < a.pos ∧ a.pos ≤ s.base.record.size ∧
      a.pos < Policy9.nextSeq s) ∧
    ∀ c ∈ a.claims, (scoreAt s.base.record (ceiling s) a.pos c).good = true := by
  obtain ⟨tag, dec, sel⟩ := named
  obtain ⟨t', passed, _⟩ := ordinary_passed ok (by simp [Safe11.route,tag])
  obtain ⟨u, run, _⟩ := routed_of_step passed
  have pass : allows s w i = true := by
    by_contra no
    simp [routed,tag,dec,guard,no] at run
    cases run
  simpa [allows, sel, scoreAt, List.all_eq_true] using pass

private theorem grade_facts {h pos z values c} (ok : (grade h pos z values c).good = true) :
    (shape c = true ∧ refsOK h pos c = true ∧ absenceOK h c = true ∧ parentsOK values c = true)
      ∧ c.stated.toNat ≤ bound h z values c := by
  simp only [grade,Bool.and_eq_true,decide_eq_true_eq] at ok
  exact ⟨⟨ok.1.1.1.1,ok.1.1.1.2,ok.1.1.2,ok.1.2⟩,ok.2⟩

private theorem checked_ref {h pos today c r} (ok : (scoreAt h today pos c).good = true)
    (mem : r ∈ c.refs) : (0 < r ∧ r < pos ∧ r ≤ h.size) ∧ fitsKind c.kind (atPos h r) = true := by
  have allRefs := (grade_facts ok).1.2.1
  simpa using List.all_eq_true.mp allRefs r mem

/-- E1. A cited sequence is a committed slot before its assessment and the admitted act. -/
theorem resolves {prior w s t i a c r} (ok : publicStep prior w s = some t) (named : Names s w i a)
    (claim : c ∈ a.claims) (ref : r ∈ c.refs) :
    ∃ bytes, s.base.record[r-1]? = some bytes ∧ 0 < r ∧ r < a.pos ∧ a.pos < Policy9.nextSeq s := by
  obtain ⟨bounds,allClaims⟩ := selected_ok ok named
  obtain ⟨⟨positive,earlier,size⟩,_⟩ := checked_ref (allClaims c claim) ref
  have inside : r-1 < s.base.record.size := by omega
  exact ⟨s.base.record[r-1],by simp [inside],positive,earlier,bounds.2.2.2⟩

private theorem entry_exists {h r body} (eq : atPos h r = some body) :
    ∃ wire parent, h[r-1]? = some wire ∧ decode wire = some ⟨parent,r,body⟩ := by
  unfold atPos at eq
  obtain ⟨_,_,rest⟩ := Option.bind_eq_some.mp eq
  obtain ⟨wire,hit,rest⟩ := Option.bind_eq_some.mp rest
  obtain ⟨⟨parent,seq,b⟩,parsed,rest⟩ := Option.bind_eq_some.mp rest
  by_cases same : seq = r
  · simp [guard,same] at rest
    subst seq
    subst body
    exact ⟨wire,parent,hit,parsed⟩
  · simp [guard,same] at rest
    cases rest

/-- E1b. Every cited slot decodes to a committed entry of the kind its claim requires. -/
theorem kind_matches {prior w s t i a c r} (ok : publicStep prior w s = some t) (named : Names s w i a)
    (claim : c ∈ a.claims) (ref : r ∈ c.refs) :
    ∃ wire parent body, s.base.record[r-1]? = some wire ∧
      decode wire = some ⟨parent,r,body⟩ ∧ fitsKind c.kind (some body) = true := by
  have fit := (checked_ref ((selected_ok ok named).2 c claim) ref).2
  cases eq : atPos s.base.record r with
  | none => cases ck : c.kind <;> simp [eq,ck,fitsKind] at fit
  | some b =>
    obtain ⟨wire,parent,slot,dec⟩ := entry_exists eq
    exact ⟨wire,parent,b,slot,dec,eq ▸ fit⟩

private theorem index_size (h : Record) (today : UInt8) (n : Nat) :
    (index h today n).values.size = n := by
  induction n with
  | zero => rfl
  | succ n ih => simp [index,ih]

private theorem prefix_value (h : Record) (today : UInt8) {r n c}
    (positive : 0 < r) (le : r ≤ n) (entry : atPos h r = some (.premise c)) :
    (index h today n).values[r-1]? = some (scoreAt h today r c) := by
  induction n with
  | zero => omega
  | succ n ih =>
    by_cases last : r = n+1
    · subst r
      simp only [index,entry,Nat.add_sub_cancel,Array.getElem?_push,index_size,if_pos rfl,if_true,scoreAt]
    · have earlier : r ≤ n := by omega
      have ne : r-1 ≠ n := by omega
      simpa [index,Array.getElem?_push,index_size,ne] using ih earlier

structure Located where
  pos : Nat
  claim : Claim
  deriving DecidableEq, Repr

inductive Derives (h : Record) : Located → Located → Prop where
  | self (c) : Derives h c c
  | via {c p last} (inferred : c.claim.kind = .inferred) (cites : p.pos ∈ c.claim.refs)
      (entry : atPos h p.pos = some (.premise p.claim)) (rest : Derives h p last) : Derives h c last

private theorem fold_min_le (refs : List Nat) (f : Nat → Nat) {r} (mem : r ∈ refs) :
    refs.foldr (fun n acc => min (f n) acc) 255 ≤ f r := by
  induction refs with
  | nil => simp at mem
  | cons n ns ih =>
    rcases List.mem_cons.mp mem with eq | tail
    · subst n
      exact Nat.min_le_left .. 
    · exact Nat.le_trans (Nat.min_le_right ..) (ih tail)

private theorem ancestor_grade {h today root leaf} (chain : Derives h root leaf)
    (good : (scoreAt h today root.pos root.claim).good = true) :
    (scoreAt h today leaf.pos leaf.claim).good = true ∧
    (scoreAt h today root.pos root.claim).bound ≤ (scoreAt h today leaf.pos leaf.claim).bound := by
  induction chain with
  | self => exact ⟨good,Nat.le_refl _⟩
  | @via c p last kind mem entry _ ih =>
    obtain ⟨⟨positive,earlier,_⟩,_⟩ := checked_ref good mem
    have prev := prefix_value h today positive (show p.pos ≤ c.pos-1 by omega) entry
    have back : previous (index h today (c.pos-1)).values p.pos = scoreAt h today p.pos p.claim := by
      simp [previous,prev]
    have ps := (grade_facts good).1.2.2.2
    have gp : (scoreAt h today p.pos p.claim).good = true := by
      simp [parentsOK,kind,List.all_eq_true] at ps
      simpa [back] using ps p.pos mem
    have lower : (scoreAt h today c.pos c.claim).bound ≤ (scoreAt h today p.pos p.claim).bound := by
      rw [← back]
      simpa only [scoreAt,grade,bound,kind] using
        fold_min_le c.claim.refs (fun n => (previous (index h today (c.pos-1)).values n).bound) mem
    obtain ⟨gl, upper⟩ := ih gp
    exact ⟨gl,Nat.le_trans lower upper⟩

/-- E2. Along every finite inference chain used by an admitted act, each stated confidence fits its bound and the root bound is at most the ancestor bound. -/
theorem no_laundering {prior w s t i a c ancestor} (ok : publicStep prior w s = some t)
    (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) :
    let h := s.base.record
    let z := ceiling s
    c.stated.toNat ≤ (scoreAt h z a.pos c).bound ∧
    (scoreAt h z a.pos c).bound ≤ (scoreAt h z ancestor.pos ancestor.claim).bound ∧
    ancestor.claim.stated.toNat ≤ (scoreAt h z ancestor.pos ancestor.claim).bound := by
  have root := (selected_ok ok named).2 c claim
  have anc := ancestor_grade chain root
  exact ⟨(grade_facts root).2,anc.2,(grade_facts anc.1).2⟩

/-- E3a. Every guess on an admitted derivation, including its root, is under today's ceiling. -/
theorem guess_ceiling {prior w s t i a c ancestor} (ok : publicStep prior w s = some t)
    (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) (guess : ancestor.claim.kind = .guessed) :
    ancestor.claim.stated.toNat ≤ (ceiling s).toNat := by
  have le := (no_laundering ok named claim chain).2.2
  simp [scoreAt,grade,bound,guess] at le
  omega

/-- E3b. A changed ceiling requires a committed control signed by both current owner keys. -/
private theorem ceiling_owner_inner {prior w s t} (ok : step prior w s = some t) (changed : ceiling t ≠ ceiling s) :
    ∃ p n z ed ml, decode w = some ⟨p,n,.setCeiling z ed ml⟩ ∧
      Hybrid7.Both Core8.verifiers s.base.hybrid.owner (ceilingMessage s p n z) ed ml := by
  obtain ⟨u,run,appended⟩ := routed_of_step ok
  have diff : ceilingAfter (ceiling s) w ≠ ceiling s := by
    simpa [ceiling,appended,Array.push_toList,List.foldl_append] using changed
  by_cases tag : subtag w = some 43
  · have header : w[0]? = some 255 := by
      unfold subtag at tag
      split at tag
      next h => exact h.1
      next => contradiction
    cases dec : decode w with
    | none => simp [ceilingAfter,tag,dec] at diff
    | some e =>
      rcases e with ⟨p,n,body⟩
      cases body <;> simp [ceilingAfter,tag,dec] at diff
      next z ed ml =>
        by_cases sigs : Policy9.signed s (ceilingMessage s p n z) ed ml = true
        · refine ⟨p,n,z,ed,ml,rfl,?_⟩
          simp only [Policy9.signed,Bool.and_eq_true] at sigs
          exact (Hybrid7.verifyHybrid_iff ..).mp sigs.2
        · simp [routed,header,tag,dec,submit,sigs] at run
  · simp [ceilingAfter,tag] at diff

/-- E3b at the public dispatcher, including safe-state controls. -/
theorem ceiling_owner {prior w s t} (ok : publicStep prior w s = some t) (changed : ceiling t ≠ ceiling s) :
    ∃ p n z ed ml, decode w = some ⟨p,n,.setCeiling z ed ml⟩ ∧
      Hybrid7.Both Core8.verifiers s.base.hybrid.owner (ceilingMessage s p n z) ed ml := by
  obtain ⟨v,_,eq⟩ := Option.map_eq_some'.mp ok
  have rec : t.base.record = s.base.record.push w := by cases eq; rfl
  have diff : ceilingAfter (ceiling s) w ≠ ceiling s := by
    simpa [ceiling,rec,Array.push_toList,List.foldl_append] using changed
  by_cases tag : subtag w = some 43
  · have parts : w[0]? = some 255 ∧ w[1]? = some 2 ∧ w[2]? = some 43 := by
      unfold subtag at tag
      split at tag
      next h => exact ⟨h.1,h.2,tag⟩
      next => contradiction
    obtain ⟨u,passed,_⟩ := ordinary_passed ok (by simp [Safe11.route,parts])
    have innerRec := (routed_of_step passed).choose_spec.2
    apply ceiling_owner_inner passed
    simpa [ceiling,innerRec,Array.push_toList,List.foldl_append] using diff
  · simp [ceilingAfter,tag] at diff

/-- E4. Every admitted absence claim cites a prior empty read with the same query and an already closed window. -/
private theorem search_witness {h today pos c q} (good : (scoreAt h today pos c).good = true)
    (absent : c.absence = some q) :
    ∃ r wire parent read, r ∈ c.refs ∧ r < pos ∧ h[r-1]? = some wire ∧
      decode wire = some ⟨parent,r,.read read⟩ ∧ read.empty = true ∧
      read.query = q ∧ read.first ≤ read.last ∧ read.last ≤ r := by
  have search := (grade_facts good).1.2.2.1
  simp [absenceOK,absent,List.any_eq_true] at search
  obtain ⟨r,ref,found⟩ := search.2
  have earlier := (checked_ref good ref).1.2.1
  cases hit : atPos h r with
  | none => simp [recordsAbsence,hit] at found
  | some body =>
    cases body <;> simp [recordsAbsence,hit] at found
    case read v =>
      obtain ⟨bytes,parent,slot,dec⟩ := entry_exists hit
      exact ⟨r,bytes,parent,v,ref,earlier,slot,dec,found⟩

/-- E4. Every absence claim in an admitted derivation cites a prior empty read with the same query and a closed window. -/
theorem looked {prior w s t i a c ancestor q} (ok : publicStep prior w s = some t) (named : Names s w i a)
    (claim : c ∈ a.claims) (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor)
    (absent : ancestor.claim.absence = some q) :
    ∃ r wire parent read, r ∈ ancestor.claim.refs ∧ r < ancestor.pos ∧ s.base.record[r-1]? = some wire ∧
      decode wire = some ⟨parent,r,.read read⟩ ∧ read.empty = true ∧
      read.query = q ∧ read.first ≤ read.last ∧ read.last ≤ r :=
  search_witness (ancestor_grade chain ((selected_ok ok named).2 c claim)).1 absent

/-- E5. Every ordinary unsigned frame, including say, remember and advise, keeps the underlying admission verdict. -/
private theorem speech_inner (prior : BaseStep) (w s) (ordinary : w[0]? = some 0) :
    (step prior w s).isSome = (prior w s).isSome := by
  simp [step,routed,subtag,cellSubtag,ordinary]

/-- E5 at the public dispatcher. Evidence preserves the safe-state dispatcher's verdict on all unsigned ordinary frames. -/
theorem speech_free (prior : BaseStep) (w s) (ordinary : w[0]? = some 0) :
    (publicStep prior w s).isSome = (Safe11.step prior w s).isSome := by
  have rt : Safe11.route w = .ordinary := by simp [Safe11.route,ordinary]
  by_cases blocked : (Safe11.halted s && !Safe11.allowedOrdinary w) = true
  · simp [publicStep,Safe11.step,Safe11.raw,rt,blocked]
  · simpa [publicStep,Safe11.step,Safe11.raw,rt,blocked] using speech_inner prior w s ordinary

/-- E6. With class, references and query fixed, lowering stated confidence preserves every successful evidence check at the act boundary. -/
theorem lower_stated {h pos today c} (n : UInt8) (weaker : n.toNat ≤ c.stated.toNat)
    (ok : (scoreAt h today pos c).good = true) :
    (scoreAt h today pos {c with stated := n}).good = true := by
  obtain ⟨⟨shapeOK,refs,query,parents⟩,cap⟩ := grade_facts ok
  have same : bound h (min today.toNat (index h today (pos-1)).ceilingAtPosition.toNat)
      (index h today (pos-1)).values {c with stated := n} =
      bound h (min today.toNat (index h today (pos-1)).ceilingAtPosition.toNat)
      (index h today (pos-1)).values c := by cases c <;> rfl
  have cap' := Nat.le_trans weaker cap
  simpa only [scoreAt,grade,Bool.and_eq_true,decide_eq_true_eq,same] using
    And.intro (And.intro (And.intro (And.intro shapeOK refs) query) parents) cap'

/-- These are the data read by the evidence check; the assessment's own bytes and the act's addressed head may differ. -/
structure SameBasis (s t : Policy9.Machine) (pos : Nat) : Prop where
  size : s.base.record.size = t.base.record.size
  ceiling : Evidence11.ceiling s = Evidence11.ceiling t
  historical : (index s.base.record (Evidence11.ceiling s) (pos-1)).ceilingAtPosition =
    (index t.base.record (Evidence11.ceiling t) (pos-1)).ceilingAtPosition
  earlier : (index s.base.record (Evidence11.ceiling s) (pos-1)).values =
    (index t.base.record (Evidence11.ceiling t) (pos-1)).values
  kinds : ∀ k r, fitsKind k (atPos s.base.record r) = fitsKind k (atPos t.base.record r)
  readings : ∀ r q, recordsAbsence s.base.record r q = recordsAbsence t.base.record r q
  values : ∀ r, recordedValue s.base.record r = recordedValue t.base.record r

private theorem basis_score {s t pos} (eq : SameBasis s t pos) (c : Claim) :
    scoreAt s.base.record (ceiling s) pos c = scoreAt t.base.record (ceiling t) pos c := by
  simp only [scoreAt,grade,bound,refsOK,absenceOK,eq.size,eq.kinds,eq.readings,eq.values,
    eq.historical,eq.earlier]
  rw [eq.ceiling]

def Weaker (a b : Claim) : Prop :=
  b = {a with stated := b.stated} ∧ b.stated.toNat ≤ a.stated.toNat

private theorem weaker_list {s t pos xs ys} (basis : SameBasis s t pos) (pairs : List.Forall₂ Weaker xs ys)
    (old : ∀ c ∈ xs, (scoreAt s.base.record (ceiling s) pos c).good = true) :
    ∀ c ∈ ys, (scoreAt t.base.record (ceiling t) pos c).good = true := by
  induction pairs with
  | nil => simp
  | @cons a b _ _ pair _ ih =>
    intro c member
    rcases List.mem_cons.mp member with hi | tail
    · subst c
      rw [← basis_score basis b]
      have accepted := lower_stated b.stated pair.2 (old a (List.mem_cons_self ..))
      rwa [← pair.1] at accepted
    · exact ih (fun x hx => old x (List.mem_cons_of_mem _ hx)) c tail

/-- E6 on whole acts. With the same evidence basis and a valid readdressed credential route, lowering any stated confidences preserves admission. -/
theorem act_lowering {ctx w s t i a w' s' b} (accepted : Round11.step ctx w s = some t)
    (named : Names s w i a) (newName : Names s' w' i b) (pos : b.pos = a.pos)
    (basis : SameBasis s s' a.pos) (changes : List.Forall₂ Weaker a.claims b.claims)
    (address : b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
      b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s')
    (active : Safe11.halted s' = false) (authorized : (Ratchet11.step ctx w' s').isSome = true) :
    (Round11.step ctx w' s').isSome = true := by
  obtain ⟨tag,decoded,choice⟩ := newName
  have ok := weaker_list basis changes (selected_ok accepted named).2
  have pass : allows s' w' i = true := by
    simp only [allows,choice,Bool.and_eq_true,decide_eq_true_eq,List.all_eq_true]
    exact ⟨address,by simpa [pos,scoreAt] using ok⟩
  simpa [Round11.step,Safe11.step,Safe11.raw,Safe11.route,active,step,routed,tag,decoded,pass,guard] using authorized

/-- The public exported step enforces the per-claim and transitive bound on every listed justification. -/
theorem release_bounds {ctx w s t i a c ancestor} (accepted : Round11.step ctx w s = some t)
    (named : Names s w i a) (claim : c ∈ a.claims)
    (chain : Derives s.base.record ⟨a.pos,c⟩ ancestor) :
    c.stated.toNat ≤ (scoreAt s.base.record (ceiling s) a.pos c).bound ∧
    (scoreAt s.base.record (ceiling s) a.pos c).bound ≤
      (scoreAt s.base.record (ceiling s) ancestor.pos ancestor.claim).bound :=
  ⟨(no_laundering accepted named claim chain).1, (no_laundering accepted named claim chain).2.1⟩

private def exampleRead : ByteArray :=
  ([255,2,41] ++ List.replicate 32 0 ++ Wire4.putUInt 8 1 ++ [0] ++ List.replicate 32 0 ++
    Wire4.putUInt 8 0 ++ Wire4.putUInt 8 1 ++ [1] ++ List.replicate 32 0 ++ [190]).toByteArray

set_option maxHeartbeats 1500000 in
set_option maxRecDepth 8192 in
/-- E6 counterexample. Reclassifying a read-backed observation as a guess while retaining its reference makes it fail. -/
theorem weaker_class_can_fail :
    let h := #[exampleRead]
    let c : Claim := ⟨.observed, 1, [1], none⟩
    (scoreAt h 0 2 c).good = true ∧ (scoreAt h 0 2 {c with kind := .guessed}).good = false := by
  decide +kernel

#print axioms release_bounds
#print axioms act_lowering
#print axioms weaker_class_can_fail
#print axioms resolves
#print axioms kind_matches
#print axioms no_laundering
#print axioms guess_ceiling
#print axioms ceiling_owner
#print axioms looked
#print axioms speech_free
#print axioms lower_stated

end Aukora.Evidence11
