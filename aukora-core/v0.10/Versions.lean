import Proofs.FinalStep
namespace Aukora.RootFinal
open Release
open Safe11 (innerModel)
open R6.KernelCell (Context)
open private Root12.Grammar.second Root12.Grammar.evidenceFrame from Laws
open private Root12.header from Proofs.Root12Grammar
open private Release.submittedFinding from Proofs.OutcomeTrace
open private Release.initialLedger from Proofs.History
open private Policy9.append Policy9.applyBase from Policy
open private Evidence11.metadata from Evidence11

namespace Versions

/-- 01 is the unprefixed dialect. 02 adds a disjoint namespace. 03 adds the cell dialect. -/
def v01 : WireGrammar := {}
def v02 : WireGrammar := { versionTwo := true }
def member (g : WireGrammar) (v : Nat) : Prop :=
  v = 1 ∨ g.versionTwo = true ∧ 2 ≤ v ∧ v ≤ 2 + g.later.length ∧ v ≤ 255

def Grows (a b : WireGrammar) : Prop :=
  (a.versionTwo = true → b.versionTwo = true) ∧ ∃ more, b.later = a.later ++ more

theorem v01_in_v02 : Grows v01 v02 := ⟨by decide,[],rfl⟩
theorem v02_in_installed : Grows v02 Root12.Grammar.installed := ⟨fun _ => rfl,[_],rfl⟩

theorem members_grow {a b} (inc : Grows a b) {v} (old : member a v) : member b v := by
  rcases old with eq | ⟨yes,lo,hi,byte⟩
  · exact .inl eq
  · obtain ⟨more,eq⟩ := inc.2
    exact .inr ⟨inc.1 yes,lo,by simp only [eq,List.length_append]; omega,byte⟩

theorem grows_of_pin {a b} (pin : Root12.Grammar.Extends a b) : Grows a b := by
  obtain ⟨more,rfl⟩ := pin
  exact ⟨id,more,rfl⟩

/-- A successfully decoded event retains its complete payload, including signatures and
    risk bundle fields recoverable from the same original legacy bytes. -/
theorem event_stable {a b : WireGrammar} (inc : Grows a b) {s w d}
    (hit : Root12.Grammar.decode a s w = some d) : Root12.Grammar.decode b s w = some d := by
  by_cases ff : w[0]? = some (255 : UInt8)
  · cases va : w[1]? with
    | none => simp [Root12.Grammar.decode,ff,va] at hit
    | some v =>
      cases enabled : a.versionTwo with
      | false => simp [Root12.Grammar.decode,ff,va,enabled] at hit
      | true =>
        have on := inc.1 enabled
        by_cases two : v = 2
        · simpa [Root12.Grammar.decode,ff,va,enabled,on,two] using hit
        · obtain ⟨more,slots⟩ := inc.2
          have ix : v.toNat - 3 < a.later.length := by
            by_contra no
            have miss := List.getElem?_eq_none (l := a.later)
              (Nat.le_of_not_gt no)
            simp [Root12.Grammar.decode,ff,va,enabled,two,miss] at hit
          simpa [Root12.Grammar.decode,ff,va,enabled,on,two,slots,List.getElem?_append_left ix] using hit
  · rw [Root12.Grammar.legacy_stable _ _ _ ff] at hit ⊢
    exact hit

theorem v01_event_v02 {s w d} (h : Root12.Grammar.decode v01 s w = some d) :
    Root12.Grammar.decode v02 s w = some d := event_stable v01_in_v02 h

abbrev Legacy (w : ByteArray) := w[0]? ≠ some (255 : UInt8)

def Only01 (inputs : List Input) : Prop :=
  ∀ w, Core9PolicyLaws.Input.frame w ∈ inputs → Legacy w

/-- These implications apply independently to arbitrary models and any starting state.
    The trace consumes the same original bytes on both sides. -/
theorem old_history (m : Model) (ctx : Context) (s : Release.State) (xs : List Input) (old : Only01 xs) :
    Root12.Grammar.history m ctx s xs = acceptedHistory m ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    have tail : Only01 cs := fun w h => old w (List.mem_cons_of_mem _ h)
    simp only [Root12.Grammar.history,acceptedHistory,ih _ tail]
    congr 1
    cases c with
    | frame w =>
      have eq := Root12.Grammar.legacy_stable m.grammar s w (old w (by simp))
      simp [Root12.Grammar.entry,acceptedEntry,eq,Function.comp_def]
    | _ => rfl

/-- The pinned wire slot returns a closed typed effect independently of admission. -/
inductive Meaning where
  | legacy
  | evidence (body : Evidence11.Body)
  | note
  | rebind (keys : Hybrid7.Keys)
  | extension (kind : ExtensionKind)

def meaning (d : Root12.Grammar.Decoded) : Meaning :=
  match d.payload with
  | .legacy => .legacy
  | .evidence e | .versionThree e => .evidence e.body
  | .halt | .clear | .refused _ => .note
  | .rebind keys => .rebind keys
  | .later _ _ kind => .extension kind

def addressed (s : Release.State) (p : Digest) (n : Nat) : Prop :=
  p = (ledger s).head ∧ n = Policy9.nextSeq s

def futureRebindMessage (s : Release.State) (p : Digest) (n : Nat) (keys : Hybrid7.Keys) :=
  Policy9.message "key-change" s p n (Hybrid7.keyBytes keys)


def ruleEffect (s t : Release.State) (w : ByteArray) : Meaning → Prop
  | .legacy =>
    (Tagged w 27 ∧ t.rules = s.rules) ∨ ∃ c, Tracked w c ∧
        t.rules = Policy9.rulesAfter s.rules (Policy9.selected s c) c
  | .rebind _ => t.rules = []
  | .extension (.issue p n last i ed ml) =>
    addressed s p n ∧ n < last ∧ Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml ∧
    t.rules = .issue i last :: s.rules
  | .extension (.cancel p n d ed ml) =>
    addressed s p n ∧ Hybrid7.Both Core8.verifiers (owner s) (Policy9.cancelMessage s p n d) ed ml ∧
    ∃ i, Policy9.resolve s d = some i ∧ t.rules = .cancel i :: s.rules
  | .extension (.rebind ..) => t.rules = []
  | _ => t.rules = s.rules

def evidenceRisk (s : Release.State) (w : ByteArray) : Evidence11.Body → Risk8.State
  | .assessment key score _ => Risk8.assess s.base.risk key score (Bound4.digest w)
  | _ => s.base.risk

def riskEffect (s t : Release.State) (w : ByteArray) : Meaning → Prop
  | .legacy =>
    (Tagged w 27 ∧ t.base.risk = s.base.risk) ∨ ∃ c, Tracked w c ∧ riskAfter w s c = some t.base.risk
  | .evidence body => t.base.risk = evidenceRisk s w body
  | .extension (.assessment i score) => t.base.risk = Risk8.assess s.base.risk i score (Bound4.digest w)
  | .extension (.threshold p n level ed ml) =>
    addressed s p n ∧ Hybrid7.Both Core8.verifiers (owner s)
      (Risk8.thresholdMessage (owner s) (Policy9.generation s) p n level) ed ml ∧
      t.base.risk = {s.base.risk with threshold := level}
  | _ => t.base.risk = s.base.risk

def evidenceFinding : Evidence11.Body → Option Policy9.Finding
  | .outcome i v fix _ => some ⟨Risk8.intentDigest i,i,v,fix⟩
  | _ => none

def finding (_s : Release.State) (w : ByteArray) : Meaning → Option Policy9.Finding
  | .legacy => wireFinding w
  | .evidence body => evidenceFinding body
  | .extension (.report i v fix) => some ⟨Risk8.intentDigest i,i,v,fix⟩
  | _ => none

def bindingEffect (s t : Release.State) (w : ByteArray) : Meaning → Prop
  | .legacy =>
    (owner t ≠ owner s → Rebound s t w) ∧
    ∀ p n keys ed ml, Tracked w (.rebind p n keys ed ml) →
      owner t = keys ∧ Hybrid7.Both Core8.verifiers (owner s)
        (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml
  | .rebind keys => owner t = keys ∧ Safe11.Both s w 53
  | .extension (.rebind p n keys ed ml) =>
    addressed s p n ∧ owner t = keys ∧ Hybrid7.validKey keys = true ∧
    Hybrid7.Both Core8.verifiers (owner s) (futureRebindMessage s p n keys) ed ml
  | _ => owner t = owner s

def interpretations (g : WireGrammar) (s : Release.State) (w : ByteArray) : Option Meaning :=
  (Root12.Grammar.decode g s w).map meaning

theorem interpretations_stable {a b g s w} (growth : Grows a b)
    (known : interpretations a s w = some g) : interpretations b s w = some g := by
  obtain ⟨d,hit,rfl⟩ := Option.map_eq_some'.mp known
  simp [interpretations,event_stable growth hit]

/-- Derive all three effects from the same installed slot, independently of
    the candidate's transition. No rule, risk or finding is read back from the verdict. -/
theorem effects_stable {a b k s w} (inc : Grows a b) (known : interpretations a s w = some k) :
    ∀ t, (interpretations b s w).map (ruleEffect s t w) = some (ruleEffect s t w k) ∧
      (interpretations b s w).map (riskEffect s t w) = some (riskEffect s t w k) ∧
      (interpretations b s w).bind (finding s w) = finding s w k ∧
      (interpretations b s w).map (bindingEffect s t w) = some (bindingEffect s t w k) := by
  intro t
  simp [interpretations_stable inc known]

end Versions
open Versions

def W1 (m : Model) : Prop :=
  Grows Versions.v01 m.grammar ∧
  ∀ child : Model, Root12.Grammar.Preserves m.grammar child →
    (∀ v, member m.grammar v → member child.grammar v) ∧
    (∀ s w d, Root12.Grammar.decode m.grammar s w = some d → Root12.Grammar.decode child.grammar s w = some d) ∧
    ∀ s w k, interpretations m.grammar s w = some k → interpretations child.grammar s w = some k

theorem full_w1 : W1 innerModel :=
  ⟨⟨by decide,[_],rfl⟩,fun _ pin =>
    ⟨fun _ => members_grow (grows_of_pin pin),fun _ _ _ => event_stable (grows_of_pin pin),
      fun _ _ _ => interpretations_stable (grows_of_pin pin)⟩⟩

/-- Bridge the succession witness actually used by the gate to both semantic conclusions. -/
theorem installed_edge {a b c : Model → Prop} {parent child : Model}
    (first : Ratchet11.Transition b a parent) (edge : Ratchet11.Transition c b child)
    (own : c child) (laws : W1 parent) :
    (∀ v, member parent.grammar v → member child.grammar v) ∧
    (∀ s w d, Root12.Grammar.decode parent.grammar s w = some d → Root12.Grammar.decode child.grammar s w = some d) ∧
    ∀ s w k, interpretations parent.grammar s w = some k → interpretations child.grammar s w = some k :=
  laws.2 child (Ratchet11.next_preserves_carried_grammar first edge own)

def ExplainedBy (m : Model) (property : Release.State → Release.State → ByteArray → Meaning → Prop) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t →
    ∃ k, interpretations m.grammar s w = some k ∧ property s t w k

def Rules (m : Model) := ExplainedBy m ruleEffect
def RiskState (m : Model) := ExplainedBy m riskEffect
def Binding (m : Model) := ExplainedBy m bindingEffect

def findingAt (m : Model) (ctx : Context) (s : Release.State) : Input → List Policy9.Finding
  | .frame w =>
    if (m.step ctx w s).isSome then ((interpretations m.grammar s w).bind (finding s w)).toList else []
  | _ => []

def findings (m : Model) (ctx : Context) (s : Release.State) : List Input → List Policy9.Finding
  | [] => []
  | c :: cs => findings m ctx (execute m ctx s c) cs ++ findingAt m ctx s c

def Outcome (m : Model) (start : Release.State) : Prop :=
  (∀ ctx xs i, let reported := ∃ f ∈ Root12.Grammar.history m ctx start xs, f.action = .base (.outcome i .confirmed)
    let final := run m ctx start xs
    (everConfirmed final i = .confirmed ↔ reported) ∧ (everConfirmed final i = .unknown ↔ ¬ reported)) ∧
  ∀ ctx xs key, let found := findings m ctx start xs
    let final := run m ctx start xs
    final.outcomes = found ∧ m.outcome final key = Policy9.outcomeCode {final with outcomes := found} key

namespace Versions

private structure Effects (s t : Release.State) (w : ByteArray) (k : Meaning) : Prop where
  rules : ruleEffect s t w k
  risk : riskEffect s t w k
  binding : bindingEffect s t w k
  outcomes : t.outcomes = (finding s w k).toList ++ s.outcomes

private theorem legacyEffects {ctx w s t} (hit : Core9.step ctx w s = some t) : Effects s t w .legacy := by
  exact ⟨newest_rules ctx w s t hit,newest_riskState ctx w s t hit,
    ⟨newest_binding.1 ctx w s t hit,fun p n keys ed ml match_ =>
      newest_binding.2 ctx w s t p n keys ed ml match_ hit⟩,Release.submittedFinding hit⟩

private theorem legacyParsed {ctx w s t} (hit : Core9.step ctx w s = some t) :
    interpretations innerModel.grammar s w = some .legacy := by
  obtain ⟨f,_,proj,_⟩ := step_projection hit
  have old : Legacy w := by
    intro ff
    rw [Safe11.frozen_projection ff] at proj
    contradiction
  simp [interpretations,Root12.Grammar.legacy_stable _ _ _ old,proj,meaning]

private theorem evidenceParsed {w s e} (ff : w[0]? = some (255 : UInt8)) (rt : Safe11.route w = .ordinary)
    (dec : Evidence11.decode w = some e) : interpretations innerModel.grammar s w = some (.evidence e.body) := by
  by_cases two : w[1]? = some (2 : UInt8)
  · simp [interpretations,meaning,innerModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,two,
      Root12.Grammar.second,rt,dec]
  · have three : w[1]? = some (3 : UInt8) := by
      by_contra no
      simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,two,no] at dec
    simp [interpretations,meaning,innerModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,three,
      Root12.Grammar.third,dec,guard]

private theorem evidenceMetadata {s w e risk u} (hit : Evidence11.metadata s w e risk = some u) :
    u.rules = s.rules ∧ u.base.risk = risk ∧ owner u = owner s ∧ u.outcomes = s.outcomes := by
  obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp hit
  cases Option.some.inj eq
  obtain ⟨inner,_,eq⟩ := Option.bind_eq_some.mp app
  cases Option.some.inj eq
  exact ⟨rfl,rfl,rfl,rfl⟩

private theorem evidenceEffects {s w e u} (hit : Evidence11.submit s w e = some u) :
    Effects s (recordPush s w u) w (.evidence e.body) := by
  rcases e with ⟨p,n,body⟩
  cases body with
  | assessment | source | premise | cell =>
    obtain ⟨r,v,b,o⟩ := evidenceMetadata hit
    exact ⟨r,v,b,o⟩
  | read | setCeiling =>
    simp only [Evidence11.submit] at hit
    split at hit
    · obtain ⟨r,v,b,o⟩ := evidenceMetadata hit
      exact ⟨r,v,b,o⟩
    · contradiction
  | outcome =>
    obtain ⟨b,applied,eq⟩ := Option.bind_eq_some.mp hit
    cases Option.some.inj eq
    obtain ⟨_,_,app⟩ := Option.bind_eq_some.mp applied
    obtain ⟨inner,_,eq⟩ := Option.bind_eq_some.mp app
    cases Option.some.inj eq
    exact ⟨rfl,rfl,rfl,rfl⟩

private theorem controlParsed {ctx w s t} (hit : innerModel.step ctx w s = some t)
    (special : Safe11.route w ≠ .ordinary) :
    interpretations innerModel.grammar s w =
      some (if Safe11.route w = .rebind then .rebind (Safe11.newKeys s w) else .note) := by
  obtain ⟨d,dok⟩ := Root12.full_parses hit
  have ⟨ff,two⟩ := Root12.header (r := Safe11.route w) rfl special
  have inside : Root12.Grammar.second s w = some d := by
    simpa [innerModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,two] using dok
  simp only [interpretations,dok,Option.map_some]
  cases rt : Safe11.route w with
  | ordinary => contradiction
  | halt | clear | rebind =>
    simp only [Root12.Grammar.second,rt] at inside
    obtain ⟨_,_,eq⟩ := Option.bind_eq_some.mp inside
    cases Option.some.inj eq
    simp [meaning]
  | refusal =>
    simp only [Root12.Grammar.second,rt] at inside
    obtain ⟨_,_,part⟩ := Option.bind_eq_some.mp inside
    obtain ⟨cmd,_,eq⟩ := Option.bind_eq_some.mp part
    cases cmd <;> cases eq <;> rfl

private theorem fullEffects {ctx w s t} (hit : innerModel.step ctx w s = some t) :
    ∃ k, interpretations innerModel.grammar s w = some k ∧ Effects s t w k := by
  cases dispatch hit with
  | legacy old => exact ⟨_,legacyParsed old,legacyEffects old⟩
  | evidence ff rt dec ok => exact ⟨_,evidenceParsed ff rt dec,evidenceEffects ok⟩
  | note ff special noKey =>
    exact ⟨.note,by simpa [noKey] using controlParsed hit special,⟨rfl,rfl,rfl,rfl⟩⟩
  | rebind ff rt shape sigs =>
    exact ⟨.rebind _,by simpa [rt] using controlParsed hit (by simp [rt]),⟨rfl,rfl,⟨rfl,sigs⟩,rfl⟩⟩

private theorem commandFinding (ctx s c) :
    (execute innerModel ctx s c).outcomes = RootFinal.findingAt innerModel ctx s c ++ s.outcomes := by
  cases c with
  | reset | feed => rfl
  | frame w =>
    cases ok : innerModel.step ctx w s with
    | none => simp [execute,RootFinal.findingAt,ok]
    | some t =>
      obtain ⟨k,parsed,eff⟩ := fullEffects ok
      simpa [execute,RootFinal.findingAt,ok,parsed] using eff.outcomes
  | stamp w =>
    cases ok : innerModel.stamp w s with
    | none => simp [execute,RootFinal.findingAt,ok]
    | some t => simp [execute,RootFinal.findingAt,ok,(newest_stamp w s t ok).2]

private theorem allFindings (ctx s xs) :
    (run innerModel ctx s xs).outcomes = findings innerModel ctx s xs ++ s.outcomes := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih => simp only [run,findings,ih,commandFinding,List.append_assoc]

end Versions

theorem full_rules : Rules innerModel := by
  intro ctx w s t ok
  obtain ⟨k,parsed,eff⟩ := Versions.fullEffects ok
  exact ⟨k,parsed,eff.rules⟩

theorem full_riskState : RiskState innerModel := by
  intro ctx w s t ok
  obtain ⟨k,parsed,eff⟩ := Versions.fullEffects ok
  exact ⟨k,parsed,eff.risk⟩

theorem full_binding : Binding innerModel := by
  intro ctx w s t ok
  obtain ⟨k,parsed,eff⟩ := Versions.fullEffects ok
  exact ⟨k,parsed,eff.binding⟩

theorem full_outcome {key start} (ok : innerModel.genesis key = some start) : Outcome innerModel start := by
  constructor
  · intro ctx xs i
    dsimp only
    unfold everConfirmed
    rw [Root12.full_record.ledger key start ok ctx start xs,(Release.initialLedger ok).1,List.nil_append]
    by_cases h : ∃ f ∈ Root12.Grammar.history innerModel ctx start xs, f.action = .base (.outcome i .confirmed)
    · have yes : (Root12.Grammar.history innerModel ctx start xs).any
        (fun f => decide (f.action = .base (.outcome i .confirmed))) = true := by simpa using h
      simp [yes,h]
    · have no : (Root12.Grammar.history innerModel ctx start xs).any
        (fun f => decide (f.action = .base (.outcome i .confirmed))) = false := by simpa using h
      simp [no,h]
  · intro ctx xs d
    dsimp only
    have empty : start.outcomes = [] := by
      change (Core8.genesis key).map _ = some start at ok
      obtain ⟨b,_,rfl⟩ := Option.map_eq_some'.mp ok
      rfl
    have trace := Versions.allFindings ctx start xs
    rw [empty,List.append_nil] at trace
    exact ⟨trace,by change Policy9.outcomeCode _ d = _; rw [← trace]⟩

end Aukora.RootFinal
