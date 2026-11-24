import Laws

namespace Aukora.Release.Restriction11
open R6.KernelCell (Context)

abbrev Filter := Context → ByteArray → State → Bool

def restrict (accept : Filter) : Model :=
  {newest with step := fun ctx w s => if accept ctx w s then newest.step ctx w s else none}

variable {accept : Filter}
local notation "m" => restrict accept

def retained (accept : Filter) (ctx : Context) (s : State) : List Input → List Input
  | [] => []
  | c :: cs =>
    let tail := retained accept ctx (execute (restrict accept) ctx s c) cs
    match c with
    | .frame w => if accept ctx w s then c :: tail else tail
    | _ => c :: tail

private theorem simulation (ctx s xs) :
    run m ctx s xs = run newest ctx s (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | feed | stamp | reset => exact ih _
    | frame w =>
      cases ok : accept ctx w s <;> simpa [run, retained, execute, restrict, ok] using ih _

private theorem full {ctx w s t} (ok : (restrict accept).step ctx w s = some t) : newest.step ctx w s = some t := by
  cases h : accept ctx w s <;> simp_all [restrict]

def Ordinary (accept : Filter) : Prop :=
  ∀ ctx w s, w[0]? ≠ some (27 : UInt8) → accept ctx w s = true

private theorem same (ordinary : Ordinary accept) {ctx w} (h : w[0]? ≠ some (27 : UInt8)) :
    (restrict accept).step ctx w = newest.step ctx w := funext fun s => by simp [restrict, ordinary ctx w s h]

private theorem refused {ctx w s} (h : newest.step ctx w s = none) : (restrict accept).step ctx w s = none := by
  cases ok : (restrict accept).step ctx w s with
  | none => rfl
  | some t => have impossible := full (ctx := ctx) ok; rw [h] at impossible; contradiction

private theorem supports (ordinary : Ordinary accept) (kind) : Supports m kind := by
  intro ctx w s t cmd tagged _ found
  exact ⟨t,by rw [same ordinary tagged.1]; simpa [newest,Core9.step,tagged.1] using found⟩

private theorem replay : ReplayLaw m := by
  refine ⟨?_, fun _ _ => rfl, fun _ => rfl⟩
  intro ctx s xs
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | feed | reset => exact ih _
    | frame w =>
      cases h : (restrict accept).step ctx w s with
      | none => simpa [kept,run,execute,h] using ih s
      | some t => simpa [kept,run,execute,h] using ih t
    | stamp w =>
      cases h : (restrict accept).stamp w s with
      | none => simpa [kept,run,execute,h] using ih s
      | some t => simpa [kept,run,execute,h] using ih t

private theorem acceptedHistory_eq (ctx s xs) :
    acceptedHistory m ctx s xs = acceptedHistory newest ctx s (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [acceptedHistory, acceptedEntry, retained, execute, restrict] using ih _
    | frame w =>
      cases ok : accept ctx w s <;> simp [acceptedHistory,acceptedEntry,retained,execute,restrict,ok] at * <;> rw [ih]

private theorem inputRecord_eq (ctx s xs) :
    inputRecord m ctx s xs = inputRecord newest ctx s (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [inputRecord, acceptedBytes, retained, execute, restrict] using ih _
    | frame w =>
      cases ok : accept ctx w s <;> simp [inputRecord,acceptedBytes,retained,execute,restrict,ok] at * <;> rw [ih]

private theorem findingsIn_eq (ctx s xs) :
    findingsIn m ctx s xs = findingsIn newest ctx s (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [findingsIn, findingAt, retained, execute, restrict] using ih _
    | frame w =>
      cases ok : accept ctx w s <;> simp [findingsIn,findingAt,retained,execute,restrict,ok] at * <;> rw [ih]

private theorem withoutIssue_filter (ctx s i xs) :
    withoutIssue m ctx s i xs → withoutIssue newest ctx s i (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => intro _; trivial
  | cons c cs ih =>
    intro h
    cases c with
    | reset | feed | stamp =>
      simpa [withoutIssue,retained,execute,restrict] using ih _ h.2
    | frame w =>
      cases ok : accept ctx w s with
      | false =>
        have tail : withoutIssue m ctx s i cs := by simpa [execute,restrict,ok] using h.2
        simpa [retained,execute,restrict,ok] using ih _ tail
      | true =>
        simpa [withoutIssue,retained,execute,restrict,ok] using And.intro h.1 (ih _ h.2)

private theorem withoutRenewal_filter (ctx s i xs) :
    withoutRenewal m ctx s i xs → withoutRenewal newest ctx s i (retained accept ctx s xs) := by
  induction xs generalizing s with
  | nil => intro _; trivial
  | cons c cs ih =>
    intro h
    cases c with
    | reset | feed | stamp =>
      simpa [withoutRenewal,retained,execute,restrict] using ih _ h.2
    | frame w =>
      cases ok : accept ctx w s with
      | false =>
        have tail : withoutRenewal m ctx s i cs := by simpa [execute,restrict,ok] using h.2
        simpa [retained,execute,restrict,ok] using ih _ tail
      | true =>
        simpa [withoutRenewal,retained,execute,restrict,ok] using And.intro h.1 (ih _ h.2)

private theorem record (key start) (init : (restrict accept).genesis key = some start) : RecordLaw m start := by
  have original := newest_record init
  refine ⟨?_,?_⟩
  · intro ctx s xs; rw [simulation,acceptedHistory_eq]; exact original.1 _ _ _
  · intro ctx xs; rw [simulation]; exact original.2 _ _

private theorem once : OnceLaw m := by
  intro ctx w s t i hit direct
  obtain ⟨held,gen,admitted,absent,noUse⟩ := newest_once ctx w s t i (full hit) direct
  refine ⟨held,gen,admitted,absent,?_⟩
  intro xs later noIssue direct'
  rw [simulation]
  exact refused (noUse _ _ (withoutIssue_filter ctx t i xs noIssue) direct')

private theorem restore : RestoreLaw m := by
  intro ctx w s t p n keys ed ml tracked hit
  obtain ⟨rules,grants,generation,forbid⟩ := newest_restore ctx w s t p n keys ed ml tracked (full hit)
  refine ⟨rules,grants,generation,?_⟩
  intro xs later i old use
  rw [simulation]
  exact refused (forbid _ _ _ old use)

private theorem memory (key start) (init : (restrict accept).genesis key = some start) : MemoryLaw m start := by
  have original := newest_memory init
  refine ⟨?_,?_,?_⟩
  · intro ctx s xs; rw [simulation]; exact original.1 _ _ _
  · intro ctx s w t f old replacement reason hit dec act
    exact original.2.1 ctx s w t f old replacement reason (full hit) dec act
  · intro ctx xs c; rw [simulation,acceptedHistory_eq]; exact original.2.2 _ _ _

private theorem outcome (key start) (init : (restrict accept).genesis key = some start) :
    HistoricalOutcomeLaw m start ∧ OutcomeTraceLaw m start := by
  constructor
  · intro ctx xs i; dsimp only; rw [simulation,acceptedHistory_eq]
    exact newest_historicalOutcome init _ _ _
  · intro ctx xs k; dsimp only; rw [simulation,findingsIn_eq]; exact newest_outcomeTrace init _ _ _

private theorem floor (key start) (init : (restrict accept).genesis key = some start) : FloorLaw m start := by
  have original := newest_floor init
  refine ⟨?_,?_,?_⟩
  · intro ctx xs w t; dsimp only; rw [simulation]
    intro tag hit; exact original.1 ctx _ w t tag (full hit)
  · intro ctx w s t p n keys ed ml cmd hit; exact original.2.1 ctx w s t p n keys ed ml cmd (full hit)
  · intro ctx xs w t; dsimp only; rw [simulation]
    intro tag hit; exact original.2.2 ctx _ w t tag (full hit)

private theorem expiry : ExpiryLaw m := by
  refine ⟨?_,?_,?_⟩
  · intro ctx w s t p n last i ed ml cmd hit; exact newest_expiry.1 ctx w s t p n last i ed ml cmd (full hit)
  · intro ctx w s i state spend; exact refused (newest_expiry.2.1 ctx w s i state spend)
  · intro ctx s i xs w closed continuation spend
    rw [simulation]
    exact refused (newest_expiry.2.2 ctx s i _ w closed (withoutRenewal_filter ctx s i xs continuation) spend)

theorem lawful (ordinary : Ordinary accept) (adviceLaw : AdviceLaw m) : Lawful m where
  replay := replay
  record := ⟨fun ctx s xs => by rw [simulation,inputRecord_eq]; exact newest_rawRecord ..,
    fun ctx w s t ok => newest_lawful.record.2.1 ctx w s t (full ok),record⟩
  stale := by
    intro ctx s w f proj stale
    have hn := refused (accept := accept) (newest_stale ctx s w f proj stale).1
    exact ⟨hn,by simp [execute,hn]⟩
  once := once
  passive := fun ctx w s t hit ps => newest_passive ctx w s t (full hit) ps
  advice := adviceLaw
  restore := restore
  upgrade := fun ctx w s t hit dif => newest_upgrade ctx w s t (full hit) dif
  memory := memory
  outcome := outcome
  grants := by
    refine ⟨fun ctx w s t i hit => newest_grant ctx w s t i (full hit),?_⟩
    intro key start init
    obtain ⟨hist,empty,origin⟩ := newest_lawful.grants.2 key start init
    refine ⟨hist,empty,?_⟩
    intro ctx xs i
    rw [simulation]; exact origin ctx _ i
  binding := ⟨fun ctx w s t hit => newest_binding.1 ctx w s t (full hit),
    fun ctx w s t p n keys ed ml cmd hit => newest_binding.2 ctx w s t p n keys ed ml cmd (full hit)⟩
  control := ⟨fun ctx w s t x extra op ed cmd act hit => newest_control.1 ctx w s t x extra op ed cmd act (full hit),
    fun ctx w s t p n d ed ml cmd hit => newest_control.2 ctx w s t p n d ed ml cmd (full hit)⟩
  monotone := by
    intro ctx w s i low high bundle tag cmd le
    rw [same ordinary cmd.1]
    exact newest_monotone ctx w s i low high bundle tag cmd le
  floor := floor
  threshold := ⟨fun ctx w s t hit => newest_threshold ctx w s t (full hit),supports ordinary _,fun _ _ init => initial_threshold init⟩
  missing := fun ctx w s t tag hit => newest_missing ctx w s t tag (full hit)
  bundle := ⟨fun ctx w s t tag hit => newest_bundle ctx w s t tag (full hit),supports ordinary _,
    fun ctx w s t hit => newest_riskState ctx w s t (full hit)⟩
  stamping := newest_lawful.stamping
  revoke := ⟨fun ctx w s t p n d ed ml cmd hit => newest_revoke ctx w s t p n d ed ml cmd (full hit),supports ordinary _,
    fun ctx w s t hit => newest_rules ctx w s t (full hit)⟩
  expiry := ⟨expiry,supports ordinary _⟩
  correction := ⟨⟨fun _ _ => rfl,
    fun ctx w s t p n i val fix cmd hit => newest_correction.2.1 ctx w s t p n i val fix cmd (full hit),
    fun ctx w s t p n i val cmd hit => newest_correction.2.2 ctx w s t p n i val cmd (full hit)⟩,supports ordinary _⟩
  retention := fun ctx s xs => by rw [simulation]; exact newest_retention ctx s _

#print axioms lawful
end Aukora.Release.Restriction11
