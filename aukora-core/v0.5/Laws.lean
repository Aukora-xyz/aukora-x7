import Safe11
import Evidence11
import Proofs.PolicyEffects
import Proofs.Spending
import Proofs.AdvicePolicy
import Proofs.RawRecord
import Proofs.OutcomeTrace

namespace Aukora.Release

/-- The checker applies this single proposition to the final carried definition.
    Operations quantify over all public states unless the law explicitly starts at genesis. -/
structure Lawful (m : Model) : Prop where
  /-- L1. Dropping refused frames and stamps preserves replay; feed and reset only append or clear staged bytes. -/
  replay : ReplayLaw m
  /-- L2. Accepted frames decode and extend both records in order; active line IDs from genesis name recorded statements. -/
  record : RawRecordLaw m ∧ (∀ ctx w s t, m.step ctx w s = some t → ∃ f, projected w = some f) ∧
    ∀ key start, m.genesis key = some start → RecordLaw m start
  /-- L3. A decoded frame with a stale parent or wrong sequence is refused and leaves the state unchanged. -/
  stale : StaleLaw m
  /-- L4. Direct spends consume a current-generation grant and cannot recur along a trace without a new signed issue. -/
  once : OnceLaw m
  /-- L5. Accepted passive events, outcome reports and assessments leave owner keys, ledger authority and grant rules unchanged. -/
  passive : PassiveLaw m
  /-- L6. Locally addressed, aligned traces with matching credential verdicts and differing ordinary advice scores give equal authority and frame verdicts. -/
  advice : AdviceLaw m
  /-- L7. A rebind clears rules and grants, advances the generation and bars old-generation spends on every continuation. -/
  restore : RestoreLaw m
  /-- L8. A core change checks the committed model and proof and consumes the exact grant for the staged file's digest. -/
  upgrade : UpgradeLaw m
  /-- L9. Claims grow, corrections preserve them and every claim from genesis names an earlier accepted source. -/
  memory : ∀ key start, m.genesis key = some start → MemoryLaw m start
  /-- L10. Historical confirmation means an accepted confirmation exists; the latest query reads the newest accepted report. -/
  outcome : ∀ key start, m.genesis key = some start → HistoricalOutcomeLaw m start ∧ OutcomeTraceLaw m start
  /-- H1. Genesis has empty history and grants, every new grant carries both signatures, and every reachable grant has hybrid provenance. -/
  grants : GrantLaw m ∧ ∀ key start, m.genesis key = some start →
    (ledger start).history = [] ∧ pool start = [] ∧ ∀ ctx xs i, i ∈ pool (run m ctx start xs) →
      GrantOrigin9.Signed (owner (run m ctx start xs)) i
  /-- H2. Changing either owner key requires a decoded rebind; both old keys verify every accepted binding. -/
  binding : BindingLaw m
  /-- H3. Every accepted legacy owner control and single-grant revocation has both current signatures. -/
  control : ControlLaw m
  /-- D1. Raising only the recorded score for a bundled delivery preserves a refusal of the same wire and route. -/
  monotone : MonotoneLaw m
  /-- D2. Rebinds require both old keys at every score; reachable installs and high-score deliveries consume signed grants. -/
  floor : ∀ key start, m.genesis key = some start → FloorLaw m start
  /-- D3. The initial threshold is zero; changes need both signatures, and valid threshold controls remain available. -/
  threshold : ThresholdLaw m ∧ Supports m isThreshold ∧ ∀ key s, m.genesis key = some s → s.base.risk.threshold = 0
  /-- D4. A delivery with no assessment uses the signed-grant route and records score 255 with the intent's missing-evidence digest. -/
  missing : MissingLaw m
  /-- D5. Deliveries record their effective score and bundle; assessments remain available and only risk commands update risk state. -/
  bundle : BundleLaw m ∧ Supports m isAssessment ∧ RiskStateLaw m
  /-- S1. A valid reference stamp can be attached; success appends only that stamp to the current head's sidecar. -/
  stamping : StampLaw m ∧ ∀ w s t, Core9.stamp w s = some t → ∃ u, m.stamp w s = some u
  /-- P1. A valid revocation remains available, removes one eligible grant and preserves the generation and every other grant rule. -/
  revoke : RevokeLaw m ∧ Supports m isRevocation ∧ RulesLaw m
  /-- P2. Timed issues remain available and sign an inclusive cutoff; revoked or expired intents cannot be readmitted without renewal. -/
  expiry : ExpiryLaw m ∧ Supports m isIssue
  /-- O1. Valid reports remain available, and a correction names the same full intent and returns a labelled result code. -/
  correction : CorrectionLaw m ∧ Supports m isReport
  /-- O2. Every command history retains the complete prior list of outcome reports. -/
  retention : RetentionLaw m

theorem Lawful.grant {m : Model} (h : Lawful m) : GrantLaw m := h.grants.1

private theorem empty_genesis {key start} (ok : newest.genesis key = some start) :
    (ledger start).history = [] ∧ pool start = [] := by
  change (Core8.genesis key).map _ = some start at ok
  obtain ⟨base, init, rfl⟩ := Option.map_eq_some'.mp ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp init
  obtain ⟨hy, initial, eq⟩ := Option.bind_eq_some.mp h
  cases Option.some.inj eq
  unfold Hybrid7.genesis at initial
  split at initial
  · cases Option.some.inj initial
    exact ⟨rfl,rfl⟩
  · contradiction

theorem newest_lawful : Lawful newest where
  replay := newest_replay
  record := ⟨newest_rawRecord, fun _ _ _ _ ok => by
    obtain ⟨f, _, dec, _⟩ := step_projection ok
    exact ⟨f,dec⟩, fun _ _ ok => newest_record ok⟩
  stale := newest_stale
  once := newest_once
  passive := newest_passive
  advice := newest_advice
  restore := newest_restore
  upgrade := newest_upgrade
  memory := fun _ _ ok => newest_memory ok
  outcome := fun _ _ ok => ⟨newest_historicalOutcome ok, newest_outcomeTrace ok⟩
  grants := ⟨newest_grant, fun _ _ init =>
    ⟨(empty_genesis init).1, (empty_genesis init).2, reachable_grants init⟩⟩
  binding := newest_binding
  control := newest_control
  monotone := newest_monotone
  floor := fun _ _ ok => newest_floor ok
  threshold := ⟨newest_threshold, newest_supports _, fun _ _ ok => initial_threshold ok⟩
  missing := newest_missing
  bundle := ⟨newest_bundle, newest_supports _, newest_riskState⟩
  stamping := ⟨newest_stamp, fun _ _ t ok => ⟨t,ok⟩⟩
  revoke := ⟨newest_revoke, newest_supports _, newest_rules⟩
  expiry := ⟨newest_expiry, newest_supports _⟩
  correction := ⟨newest_correction, newest_supports _⟩
  retention := newest_retention

/-- Preprocessing genesis key bytes preserves all operations and merely selects a previously covered start. -/
theorem lawful_withGenesis {m : Model} (h : Lawful m) (f : ByteArray → ByteArray) : Lawful (withGenesis m f) where
  replay := h.replay
  record := ⟨h.record.1, h.record.2.1, fun key start => h.record.2.2 (f key) start⟩
  stale := h.stale
  once := h.once
  passive := h.passive
  advice := h.advice
  restore := h.restore
  upgrade := h.upgrade
  memory := fun key start => h.memory (f key) start
  outcome := fun key start => h.outcome (f key) start
  grants := ⟨h.grant, fun key start => h.grants.2 (f key) start⟩
  binding := h.binding
  control := h.control
  monotone := h.monotone
  floor := fun key start => h.floor (f key) start
  threshold := ⟨h.threshold.1, h.threshold.2.1, fun key start => h.threshold.2.2 (f key) start⟩
  missing := h.missing
  bundle := h.bundle
  stamping := h.stamping
  revoke := h.revoke
  expiry := h.expiry
  correction := h.correction
  retention := h.retention

#print axioms newest_lawful
#print axioms lawful_withGenesis
end Aukora.Release

namespace Aukora.Root12
open Release
open R6.KernelCell (Context)

namespace Grammar

/-- An evidence envelope retains every field, including claims and their references.
    The frame is its projection into the append-only ledger. -/
inductive Payload where
  | legacy
  | evidence (e : Evidence11.Envelope)
  | versionThree (e : Evidence11.Envelope)
  | halt | clear | refused (attempt : ByteArray) | rebind (keys : Hybrid7.Keys)
  | later (version : UInt8) (wire : ByteArray) (kind : Release.ExtensionKind)

structure Decoded where
  frame : R2.Frame
  payload : Payload

private def evidenceFrame (e : Evidence11.Envelope) : R2.Frame :=
  ⟨e.parent, e.seq, match e.body with
    | .outcome i result _ _ => .base (.outcome i result)
    | _ => .base (.advise "AUKORA/R11/evidence" 0)⟩

/-- Recovery headers use the expected head and canonical decimal successor sequence.
    Parsing does not grant authority. The dispatcher independently checks signatures. -/
private def second (s : Release.State) (w : ByteArray) : Option Decoded := do
  let f := fun (e : Event) => (⟨Safe11.head s, Policy9.nextSeq s, .base e⟩ : R2.Frame)
  match Safe11.route w with
  | .ordinary =>
    let e ← Evidence11.decode w
    return ⟨evidenceFrame e, .evidence e⟩
  | .halt =>
    guard (Safe11.shape s w 50)
    return ⟨f (.advise "AUKORA/R11/halt" 0), .halt⟩
  | .clear =>
    guard (Safe11.shape s w 51)
    return ⟨f (.advise "AUKORA/R11/clear" 0), .clear⟩
  | .refusal =>
    guard (Safe11.addressed s w 52)
    let attempt := w.extract (Safe11.bodyStart s 52) w.size
    let .use _ ← Policy9.decode attempt | none
    return ⟨f (.advise "AUKORA/R11/refused-act" 0), .refused attempt⟩
  | .rebind =>
    guard (Safe11.shape s w 53)
    let keys := Safe11.newKeys s w
    return ⟨f (.rebind (Wire5.keyName keys.ed) true), .rebind keys⟩

/-- The installed model carries its version table. A new dialect gets an unused
    ff VV namespace. Old parsers run even when they reject the particular bytes. -/
def decode (g : WireGrammar) (s : Release.State) (w : ByteArray) : Option Decoded :=
  if w[0]? ≠ some (255 : UInt8) then (projected w).map fun f => ⟨f, .legacy⟩
  else do
    let v ← w[1]?
    if !g.versionTwo then none
    else if v = 2 then second s w
    else do
      guard (3 ≤ v.toNat)
      let parser ← g.later[v.toNat - 3]?
      let frame ← parser.project s w
      if v = 3 then
        let envelope ← Evidence11.decode w
        return ⟨frame, .versionThree envelope⟩
      let kind ← parser.interpret s w
      return ⟨frame, .later v w kind⟩

def version (g : WireGrammar) : Nat := if g.versionTwo then 2 + g.later.length else 1

def extend (g : WireGrammar) (newParsers : List Release.WireSlot) :
    WireGrammar := {g with later := g.later ++ newParsers}

/-- The third table entry fixes the ledger projection. The public decode result
    also includes the full typed envelope of the same cell or assessment. -/
def third (_s : Release.State) (w : ByteArray) : Option R2.Frame :=
  (Evidence11.decode w).map evidenceFrame

def installed : WireGrammar := {versionTwo := true, later := [{project := third, interpret := fun _ _ => none}]}

/-- A new namespace appends one parser; all earlier slots keep the same functions. -/
def Extends (prior next : WireGrammar) : Prop :=
  ∃ more, next = extend prior more

/-- The model's installed table is the subject of the gate's parser commitment. -/
def Preserves (prior : WireGrammar) (m : Model) : Prop := Extends prior m.grammar

theorem Extends.refl (g : WireGrammar) : Extends g g :=
  ⟨[],by simp [extend]⟩

theorem Extends.trans {a b c : WireGrammar} (ab : Extends a b) (bc : Extends b c) : Extends a c := by
  obtain ⟨first,rfl⟩ := ab
  obtain ⟨second,rfl⟩ := bc
  exact ⟨first ++ second,by simp [extend,List.append_assoc]⟩

theorem inherits_parser_pin {p : WireGrammar} {child : Model → Prop} {m : Model}
    (entails : ∀ x, child x → Preserves p x) (own : child m) : Preserves p m :=
  entails m own

/-- An old tag that fails its parser also keeps that failure in every extension. -/
theorem legacy_stable (g : WireGrammar) (s w) (tag : w[0]? ≠ some (255 : UInt8)) :
    decode g s w = (projected w).map (fun f => ⟨f, .legacy⟩) := by
  simp [decode,tag]

theorem v2_stable (g : WireGrammar) (more s w) (old : w[0]? = some (255 : UInt8))
    (v2 : w[1]? = some (2 : UInt8)) :
    decode (extend g more) s w = decode g s w := by
  simp [decode,extend,old,v2]

theorem later_stable (g : WireGrammar) (more s w) {v : UInt8} (old : w[0]? = some (255 : UInt8))
    (tag : w[1]? = some v) (known : v.toNat - 3 < g.later.length) :
    decode (extend g more) s w = decode g s w := by
  simp [decode,extend,old,tag,List.getElem?_append_left known]

/-- All legacy byte strings, the truncated extension prefix, the reserved version
    bytes below 3, and every assigned extension namespace. Invalid bodies are included. -/
def Known (g : WireGrammar) (w : ByteArray) : Prop :=
  w[0]? ≠ some (255 : UInt8) ∨ w[1]? = none ∨
  ∃ v : UInt8, w[1]? = some v ∧ (v.toNat < 3 ∨ v.toNat - 3 < g.later.length)

/-- Both a successful parse and a rejection have identical meaning after an extension. -/
theorem Extends.decode_of_known {prior next : WireGrammar} (growth : Extends prior next)
    (s : Release.State) (w : ByteArray) (known : Known prior w) :
    decode next s w = decode prior s w := by
  obtain ⟨more,rfl⟩ := growth
  by_cases tag : w[0]? = some (255 : UInt8)
  · rcases known with old | missing | ⟨v,kind,small | slot⟩
    · contradiction
    · simp [decode,tag,missing]
    · by_cases v2 : v = 2
      · subst v
        exact v2_stable _ _ _ _ tag kind
      · cases enabled : prior.versionTwo <;>
          simp [decode,extend,tag,kind,v2,guard,Nat.not_le_of_gt small,enabled] <;> rfl
    · exact later_stable _ _ _ _ tag kind slot
  · rw [legacy_stable _ _ _ tag,legacy_stable _ _ _ tag]

/-- The accepted current model supplies the first prefix link. The next
    universal commitment carries that prefix through another succession. -/
theorem transports_decode {prior : WireGrammar} {current child : Model}
    {nextLaw : Model → Prop} (currentPin : Preserves prior current)
    (commitment : ∀ m, nextLaw m → Preserves current.grammar m) (childProof : nextLaw child)
    (s w) (old : Known prior w) : decode child.grammar s w = decode prior s w :=
  (Extends.trans currentPin (commitment child childProof)).decode_of_known s w old

/-- The prior gate certified that the old predicate pins the installed parent
    table. An accepted child's satisfaction and universal entailment give the
    specific child→parent parser link without trusting a self-report. -/
theorem consecutive_decode {parent child : Model} {old new : Model → Prop}
    (parentPin : ∀ m, old m → Preserves parent.grammar m) (entails : ∀ m, new m → old m)
    (satisfied : new child) (s w) (known : Known parent.grammar w) :
    decode child.grammar s w = decode parent.grammar s w :=
  Extends.decode_of_known (parentPin child (entails child satisfied)) s w known

/-- A v3 receipt or assessment retains every field of its decoded envelope in
    every model preserving the installed table, including digests and references. -/
theorem version_three_fields {m : Model} (pin : Preserves installed m) (s : Release.State)
    {w : ByteArray} (tag : w[0]? = some (255 : UInt8)) (versionTag : w[1]? = some (3 : UInt8))
    {env : Evidence11.Envelope} (body : Evidence11.decode w = some env) :
    decode m.grammar s w = some ⟨evidenceFrame env,.versionThree env⟩ := by
  have old : Known installed w := Or.inr (Or.inr ⟨3,versionTag,Or.inr (by decide)⟩)
  rw [Extends.decode_of_known pin s w old]
  simp [decode,installed,tag,versionTag,third,body,guard]

#print axioms version_three_fields
#print axioms consecutive_decode
#print axioms Extends.trans
#print axioms Extends.decode_of_known
#print axioms transports_decode

def entry (m : Model) (ctx : Context) (s : Release.State) : Input → List R2.Frame
  | .frame w => if (m.step ctx w s).isSome then ((decode m.grammar s w).map Decoded.frame).toList else []
  | _ => []

def history (m : Model) (ctx : Context) (s : Release.State) : List Input → List R2.Frame
  | [] => []
  | c :: cs => entry m ctx s c ++ history m ctx (execute m ctx s c) cs

end Grammar

/-- Owner rules currently restrict direct spends and installs. Issuance, reporting,
    maintenance and sidecars have no owner prohibition in the current rule language. -/
def ownerPermits (s : Release.State) : Input → Bool
  | .frame w =>
    if w[0]? = some (27 : UInt8) then
      match Upgrade9.decode w with
      | some u => Policy9.permits s.rules u.intent (Policy9.nextSeq s)
      | none => true
    else
      match Policy9.decode w with
      | some (.use i) => Policy9.permits s.rules i (Policy9.nextSeq s)
      | _ => true
  | _ => true

def Open (s : Release.State) (op : Input) : Prop := Safe11.halted s = false ∧ ownerPermits s op = true

def SupportsWhen (m : Model) (kind : Policy9.Command → Prop) : Prop :=
  ∀ ctx w s t c, Tracked w c → kind c → Policy9.step w s = some t →
    Open s (.frame w) → ∃ u, m.step ctx w s = some u

def fed (b : ByteArray) (s : Release.State) : Release.State :=
  {s with base.hybrid.inner.candidate := s.base.hybrid.inner.candidate ++ b}

def cleared (s : Release.State) : Release.State :=
  {s with base.hybrid.inner.candidate := ByteArray.empty}

/-- feed/reset have total state-returning interfaces. A refused update is represented
    by the unchanged state, including every authority, record, and grant field. -/
structure Replay (m : Model) : Prop where
  kept : ∀ ctx s xs, run m ctx s (Release.kept m ctx s xs) = run m ctx s xs
  feedEffect : ∀ s b, m.feed b s = s ∨ m.feed b s = fed b s
  resetEffect : ∀ s, m.reset s = s ∨ m.reset s = cleared s
  feedWhen : ∀ s b, Open s (.feed b) → m.feed b s = fed b s
  resetWhen : ∀ s, Open s .reset → m.reset s = cleared s

structure Record (m : Model) : Prop where
  raw : RawRecordLaw m
  version : Grammar.Preserves Grammar.installed m ∧ m.grammar.later.length ≤ 253
  parses : ∀ ctx w s t, m.step ctx w s = some t → ∃ parsed, Grammar.decode m.grammar s w = some parsed
  ledger : ∀ key start, m.genesis key = some start →
    ∀ ctx s xs, (Release.ledger (run m ctx s xs)).history =
      (Release.ledger s).history ++ Grammar.history m ctx s xs
  view : ∀ key start, m.genesis key = some start → ∀ ctx xs, R2.ViewSound (Release.ledger (run m ctx start xs))

/-- The 23 clauses of the restated root. All original predicates asserting safety
    remain literal, except the stated L2 exception for versioned grammar. H5 is
    supplied in the encompassing contract by Safe11.PublicLaws.recovery. -/
structure Lawful (m : Model) : Prop where
  replay : Replay m
  record : Record m
  stale : StaleLaw m
  once : OnceLaw m
  passive : PassiveLaw m
  advice : AdviceLaw m
  restore : RestoreLaw m
  upgrade : UpgradeLaw m
  memory : ∀ key start, m.genesis key = some start → MemoryLaw m start
  outcome : ∀ key start, m.genesis key = some start → HistoricalOutcomeLaw m start ∧ OutcomeTraceLaw m start
  grants : GrantLaw m ∧ ∀ key start, m.genesis key = some start →
    (ledger start).history = [] ∧ pool start = [] ∧ ∀ ctx xs i, i ∈ pool (run m ctx start xs) →
      GrantOrigin9.Signed (owner (run m ctx start xs)) i
  binding : BindingLaw m
  control : ControlLaw m
  monotone : MonotoneLaw m
  floor : ∀ key start, m.genesis key = some start → FloorLaw m start
  threshold : ThresholdLaw m ∧ SupportsWhen m isThreshold ∧ ∀ key s, m.genesis key = some s → s.base.risk.threshold = 0
  missing : MissingLaw m
  bundle : BundleLaw m ∧ SupportsWhen m isAssessment ∧ RiskStateLaw m
  stamping : StampLaw m ∧ ∀ w s t, Core9.stamp w s = some t → Open s (.stamp w) → ∃ u, m.stamp w s = some u
  revoke : RevokeLaw m ∧ SupportsWhen m isRevocation ∧ RulesLaw m
  expiry : ExpiryLaw m ∧ SupportsWhen m isIssue
  correction : CorrectionLaw m ∧ SupportsWhen m isReport
  retention : RetentionLaw m

theorem replay_safety {m} (h : Lawful m) :
    (∀ ctx s xs, run m ctx s (Release.kept m ctx s xs) = run m ctx s xs) ∧
    (∀ s b, m.feed b s ≠ s → m.feed b s = fed b s) ∧
    (∀ s, m.reset s ≠ s → m.reset s = cleared s) :=
  ⟨h.replay.kept, fun s b moved => (h.replay.feedEffect s b).resolve_left moved,
    fun s moved => (h.replay.resetEffect s).resolve_left moved⟩

theorem record_safety {m} (h : Lawful m) : RawRecordLaw m ∧
    (∀ ctx w s t, w[0]? ≠ some (255 : UInt8) → m.step ctx w s = some t → ∃ f, projected w = some f) ∧
    (∀ key start, m.genesis key = some start → ∀ ctx xs, R2.ViewSound (ledger (run m ctx start xs))) := by
  refine ⟨h.record.raw, ?_, h.record.view⟩
  intro ctx w s t old hit
  obtain ⟨p, parsed⟩ := h.record.parses ctx w s t hit
  rw [Grammar.legacy_stable _ _ _ old] at parsed
  obtain ⟨f,ok,_⟩ := Option.map_eq_some'.mp parsed
  exact ⟨f,ok⟩

theorem threshold_safety {m} (h : Lawful m) : ThresholdLaw m ∧
    ∀ key s, m.genesis key = some s → s.base.risk.threshold = 0 := ⟨h.threshold.1,h.threshold.2.2⟩
theorem bundle_safety {m} (h : Lawful m) : BundleLaw m ∧ RiskStateLaw m := ⟨h.bundle.1,h.bundle.2.2⟩
theorem stamping_safety {m} (h : Lawful m) : StampLaw m := h.stamping.1
theorem revoke_safety {m} (h : Lawful m) : RevokeLaw m ∧ RulesLaw m := ⟨h.revoke.1,h.revoke.2.2⟩
theorem expiry_safety {m} (h : Lawful m) : ExpiryLaw m := h.expiry.1
theorem correction_safety {m} (h : Lawful m) : CorrectionLaw m := h.correction.1

#print axioms Grammar.later_stable
#print axioms record_safety
#print axioms replay_safety
#print axioms threshold_safety
#print axioms bundle_safety
#print axioms stamping_safety
#print axioms revoke_safety
#print axioms expiry_safety
#print axioms correction_safety

end Aukora.Root12
