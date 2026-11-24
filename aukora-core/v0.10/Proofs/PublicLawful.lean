import RootFinal
import Proofs.PublicModel
import Proofs.WrapRuns

/-! Root v2 step 3a-ii: the root law set carried from the inner machine (`inner_lawful`) to the public machine
`Safe11.fullModel = Refusal.wrap innerModel`, family by family. -/

namespace Aukora.RootFinal
open Release
open Refusal
open Safe11 (innerModel fullModel)
open private Historical.canonical Historical.absentExtension from Proofs.InstalledRecovery
open R6.KernelCell (Context)

namespace Carry

theorem step_def (ctx : Context) (w : ByteArray) (s : Release.State) :
    fullModel.step ctx w s = if refuses s (.frame w) then none else innerModel.step ctx w s := rfl

theorem inner_hit {ctx : Context} {w : ByteArray} {s t : Release.State} (h : fullModel.step ctx w s = some t) :
    innerModel.step ctx w s = some t := by
  rw [step_def] at h
  split at h
  · cases h
  · exact h

theorem none_of_inner {ctx : Context} {w : ByteArray} {s : Release.State} (h : innerModel.step ctx w s = none) :
    fullModel.step ctx w s = none := by
  rw [step_def]; split
  · rfl
  · exact h

theorem free_frame {ctx : Context} {w : ByteArray} {s : Release.State} (n : ¬ Forms.Refused s w) :
    fullModel.step ctx w s = innerModel.step ctx w s := by
  rw [step_def, if_neg]
  intro r
  exact n (refuses_refusedIn r)

theorem exec_def (ctx : Context) (s : Release.State) (c : Input) :
    execute fullModel ctx s c = if refuses s c then s else execute innerModel ctx s c := execute_wrap _ _ _ _

theorem exec_frame_of_inner {ctx : Context} {w : ByteArray} {s : Release.State}
    (h : execute innerModel ctx s (.frame w) = s) : execute fullModel ctx s (.frame w) = s := by
  rw [exec_def]; split
  · rfl
  · exact h

theorem run_def (ctx : Context) (s : Release.State) (xs : List Input) :
    run fullModel ctx s xs = run innerModel ctx s (xs.filter fun c => !refuses s c) :=
  run_wrap full_carries ctx xs s

end Carry

open Carry

/-! ### Family A: laws about one admitted step (admission implies a property) -/

theorem pub_passive_law : PassiveLaw fullModel := fun ctx w s t hit p =>
  inner_lawful.passive.1 ctx w s t (inner_hit hit) p

theorem pub_passive : PassiveFrames fullModel :=
  ⟨pub_passive_law, fun ctx w s t d e ff hit dec act pas pay =>
    inner_lawful.passive.2 ctx w s t d e ff (inner_hit hit) dec act pas pay⟩

theorem pub_upgrade : Ports.UpgradeInstalled fullModel := fun ctx w s t hit core =>
  inner_lawful.upgrade ctx w s t (inner_hit hit) core

theorem pub_binding : Binding fullModel := fun ctx w s t hit => inner_lawful.binding ctx w s t (inner_hit hit)
theorem pub_riskState : RiskState fullModel := fun ctx w s t hit => inner_lawful.bundle.2.2 ctx w s t (inner_hit hit)
theorem pub_rules : Rules fullModel := fun ctx w s t hit => inner_lawful.revoke.2.2 ctx w s t (inner_hit hit)
theorem pub_grantSource : GrantSource fullModel := fun ctx w s t i hit a b =>
  inner_lawful.grants.1 ctx w s t i (inner_hit hit) a b
theorem pub_signedThreshold : SignedThreshold fullModel := fun ctx w s t hit ch =>
  inner_lawful.threshold.1 ctx w s t (inner_hit hit) ch
theorem pub_succession : Ports.Succession fullModel := fun ctx w s t u inst hit =>
  inner_lawful.succession ctx w s t u inst (inner_hit hit)
theorem pub_pinned : Pin.PinSatisfied fullModel := fun ctx w s t hit c =>
  inner_lawful.pinned ctx w s t (inner_hit hit) c
theorem pub_missing : Ports.Missing fullModel := fun ctx w s t d del hit =>
  inner_lawful.missing ctx w s t d del (inner_hit hit)
theorem pub_bundle : Ports.Bundle fullModel := fun ctx w s t d del hit =>
  inner_lawful.bundle.1 ctx w s t d del (inner_hit hit)
theorem pub_revocation : Revocation fullModel := fun ctx w s t p n d ed ml c hit =>
  inner_lawful.revoke.1 ctx w s t p n d ed ml c (inner_hit hit)
theorem pub_e1 : Historical.E1 fullModel := fun hit => inner_lawful.e1 (inner_hit hit)
theorem pub_e1b : Historical.E1b fullModel := fun hit => inner_lawful.e1b (inner_hit hit)
theorem pub_e2 : Historical.E2 fullModel := fun hit => inner_lawful.e2 (inner_hit hit)
theorem pub_e3 : Historical.E3 fullModel :=
  ⟨fun hit => inner_lawful.e3.1 (inner_hit hit), fun hit => inner_lawful.e3.2 (inner_hit hit)⟩
theorem pub_e4 : Historical.E4 fullModel := fun hit => inner_lawful.e4 (inner_hit hit)
theorem pub_boundary : Boundary fullModel := fun ctx w s h r n =>
  none_of_inner (inner_lawful.h1 ctx w s h r n)
theorem pub_clearEffect : Historical.ClearEffect fullModel := fun ctx s w t rec hit =>
  inner_lawful.h3 ctx s w t rec (inner_hit hit)
theorem pub_stale : Stale fullModel := fun ctx s w d dec bad =>
  ⟨none_of_inner (inner_lawful.stale ctx s w d dec bad).1, exec_frame_of_inner (inner_lawful.stale ctx s w d dec bad).2⟩

/-! ### Family B: availability promises; each holds where the input is not refused, and the essential forms
    (halt, clear, the newer key change) are never refused -/

theorem free_of_open {s : Release.State} {op : Input} (o : Root12.Open s op) : refuses s op = false :=
  not_refuses o.2.2

theorem free_frame' {ctx : Context} {w : ByteArray} {s : Release.State} (r : refuses s (.frame w) = false) :
    fullModel.step ctx w s = innerModel.step ctx w s := by
  rw [step_def, r]; rfl

theorem essential_free {s : Release.State} {w : ByteArray} {f : Forms.FormId} (h : Forms.formOf w = some f)
    (e : essential f = true) : refuses s (.frame w) = false := by
  simp [refuses, Forms.inputForm, h, e]

theorem route_form {w : ByteArray} {r : Safe11.Route} (h : Safe11.route w = r) (ne : r ≠ .ordinary) :
    (r = .clear → Forms.formOf w = some .clear) ∧ (r = .rebind → Forms.formOf w = some .keyChange) := by
  unfold Safe11.route at h
  split at h
  · rename_i hh
    obtain ⟨h0, h1⟩ := hh
    split at h
    all_goals (subst h)
    all_goals first
      | exact absurd rfl ne
      | (rename_i h2
         refine ⟨fun e => ?_, fun e => ?_⟩ <;> (try cases e) <;>
         (unfold Forms.formOf Forms.byteAt; rw [h0, h1, h2]; rfl))
  · subst h; exact absurd rfl ne

theorem clear_free {s : Release.State} {w : ByteArray} (h : Safe11.route w = .clear) : refuses s (.frame w) = false :=
  essential_free ((route_form h (by decide)).1 rfl) rfl

theorem rebind_free {s : Release.State} {w : ByteArray} (h : Safe11.route w = .rebind) : refuses s (.frame w) = false :=
  essential_free ((route_form h (by decide)).2 rfl) rfl

theorem pub_supports (c : ControlAvailability.Class) : ControlAvailability.Supports fullModel c := by
  obtain ⟨a, b, d⟩ := inner_lawful.threshold.2.1 |> fun _ => ControlAvailability.full_supports c
  refine ⟨fun ctx w s t k tr kind ok o => ?_, fun ctx w s d' v raw op dec fut act val o => ?_,
    fun ctx w s e rec rt dec int cls val o => ?_⟩
  · rw [free_frame' (free_of_open o)]; exact a ctx w s t k tr kind ok o
  · rw [free_frame' (free_of_open o)]; exact b ctx w s d' v raw op dec fut act val o
  · rw [free_frame' (free_of_open o)]; exact d ctx w s e rec rt dec int cls val o

theorem pub_stampSupports : ControlAvailability.StampSupports fullModel := fun w s b r dec o => by
  have := inner_lawful.stamping.2 w s b r dec o
  show (if refuses s (.stamp w) then none else innerModel.stamp w s).isSome = true
  rw [free_of_open o]; exact this

theorem pub_stamping : Stamping fullModel := fun w s t hit => by
  change (if refuses s (.stamp w) then none else innerModel.stamp w s) = some t at hit
  split at hit
  · cases hit
  · exact inner_lawful.stamping.1 w s t hit

theorem pub_prior : PriorVerdicts fullModel := fun ctx w s old ni free => by
  rw [free_frame free]; exact inner_lawful.w1.2.1 ctx w s old ni free

theorem pub_version : VersionVerdicts fullModel :=
  ⟨fun ctx s w v ff ver vs free => by rw [free_frame free]; exact inner_lawful.w1.2.2.2.1 ctx s w v ff ver vs free,
   fun ctx s w v ff ver vs free => by rw [free_frame free]; exact inner_lawful.w1.2.2.2.2 ctx s w v ff ver vs free⟩

theorem pub_lineage : Historical.Lineage fullModel :=
  ⟨inner_lawful.w1.2.2.1.1, fun ctx w s t v e hit => inner_lawful.w1.2.2.1.2 ctx w s t v e (inner_hit hit)⟩

theorem pub_w1 : W1 fullModel ∧ PriorVerdicts fullModel ∧ Historical.Lineage fullModel ∧ VersionVerdicts fullModel :=
  ⟨inner_lawful.w1.1, pub_prior, pub_lineage, pub_version⟩

theorem pub_speech : Speech fullModel :=
  ⟨fun ctx w s t free => by rw [free_frame free]; exact inner_lawful.e5.1 ctx w s t free,
   fun ctx s w d v raw line dec p act none_ free => by rw [free_frame free]; exact inner_lawful.e5.2 ctx s w d v raw line dec p act none_ free⟩

theorem pub_e6 : Historical.E6 fullModel := fun hit n n' pos basis weak bundle running free ready => by
  rw [free_frame free]; exact inner_lawful.e6 (inner_hit hit) n n' pos basis weak bundle running free ready

theorem pub_monotone : Ports.Monotone fullModel := fun ctx w s d low high bundle del le lowNone => by
  rw [step_def]
  split
  · rfl
  · rename_i r
    have same : refuses (atScore s (Risk8.intentDigest d.intent) low bundle) (.frame w) =
        refuses (atScore s (Risk8.intentDigest d.intent) high bundle) (.frame w) := refuses_congr rfl _
    rw [step_def, same, if_neg r] at lowNone
    exact inner_lawful.monotone ctx w s d low high bundle del le lowNone

theorem pub_recovery : Historical.Recovery fullModel := by
  refine ⟨fun ctx s w h => ?_, fun ctx s w keys valid => ?_⟩
  · have r := clear_free (s := s) (Historical.canonical h.1).1
    rw [free_frame' r]; exact inner_lawful.h5.1.1 ctx s w h
  · obtain ⟨sane, ⟨event, sigs⟩ | ext⟩ := valid
    · have r := rebind_free (s := s) (Historical.canonical event).1
      rw [free_frame' r]; exact inner_lawful.h5.1.2 ctx s w keys ⟨sane, .inl ⟨event, sigs⟩⟩
    · obtain ⟨_, _, _, _, e, _⟩ := ext
      exact False.elim (Historical.absentExtension e)

theorem pub_session_recovery : SessionFinal.Recovery fullModel := by
  refine ⟨fun ctx q s w c r sz v => ?_, fun ctx q s w c r sz rt sh b k => ?_⟩
  · have := inner_lawful.h5.2.1.1 ctx q s w c r sz v
    simpa only [SessionFinal.frame, free_frame' (s := s) (ctx := ctx) (clear_free v.1)] using this
  · have := inner_lawful.h5.2.1.2 ctx q s w c r sz rt sh b k
    simpa only [SessionFinal.frame, free_frame' (s := s) (ctx := ctx) (rebind_free rt)] using this

#print axioms pub_supports
#print axioms pub_recovery

/-! ### Family C: laws about whole runs. A run of the public machine is a run of the inner machine over the
    inputs the starting state does not refuse (`run_def`); each list built along a run is carried the same way. -/

theorem exec_ref {ctx : Context} {s : Release.State} {c : Input} (r : refuses s c = true) :
    execute fullModel ctx s c = s := by rw [exec_def, if_pos r]

theorem exec_free {ctx : Context} {s : Release.State} {c : Input} (r : refuses s c = false) :
    execute fullModel ctx s c = execute innerModel ctx s c := by rw [exec_def, if_neg (by rw [r]; decide)]

theorem frame_ref {ctx : Context} {w : ByteArray} {s : Release.State} (r : refuses s (.frame w) = true) :
    fullModel.step ctx w s = none := by rw [step_def, if_pos r]

theorem stays (ctx : Context) (s : Release.State) (c : Input) (d : Input) :
    refuses (execute innerModel ctx s c) d = refuses s d := refuses_congr (full_carries ctx s c) d

theorem history_wrap (ctx : Context) : ∀ (xs : List Input) (s : Release.State),
    Root12.Grammar.history fullModel ctx s xs =
      Root12.Grammar.history innerModel ctx s (xs.filter fun c => !refuses s c)
  | [], _ => rfl
  | c :: cs, s => by
    cases r : refuses s c with
    | true =>
      have e : Root12.Grammar.entry fullModel ctx s c = [] := by
        cases c with
        | frame w => simp [Root12.Grammar.entry, frame_ref r]
        | _ => rfl
      simp only [Root12.Grammar.history, e, List.nil_append, exec_ref r, List.filter_cons, r,
        Bool.not_true, Bool.false_eq_true, if_false]
      exact history_wrap ctx cs s
    | false =>
      have e : Root12.Grammar.entry fullModel ctx s c = Root12.Grammar.entry innerModel ctx s c := by
        cases c with
        | frame w => simp only [Root12.Grammar.entry, free_frame' r]; rfl
        | _ => rfl
      have ih := history_wrap ctx cs (execute innerModel ctx s c)
      simp only [stays] at ih
      simp only [Root12.Grammar.history, e, exec_free r, List.filter_cons, r, Bool.not_false, if_true]
      rw [ih]

theorem inputRecord_wrap (ctx : Context) : ∀ (xs : List Input) (s : Release.State),
    inputRecord fullModel ctx s xs = inputRecord innerModel ctx s (xs.filter fun c => !refuses s c)
  | [], _ => rfl
  | c :: cs, s => by
    cases r : refuses s c with
    | true =>
      have e : acceptedBytes fullModel ctx s c = [] := by
        cases c with
        | frame w => simp [acceptedBytes, frame_ref r]
        | _ => rfl
      simp only [inputRecord, e, List.nil_append, exec_ref r, List.filter_cons, r,
        Bool.not_true, Bool.false_eq_true, if_false]
      exact inputRecord_wrap ctx cs s
    | false =>
      have e : acceptedBytes fullModel ctx s c = acceptedBytes innerModel ctx s c := by
        cases c with
        | frame w => simp only [acceptedBytes, free_frame' r]
        | _ => rfl
      have ih := inputRecord_wrap ctx cs (execute innerModel ctx s c)
      simp only [stays] at ih
      simp only [inputRecord, e, exec_free r, List.filter_cons, r, Bool.not_false, if_true]
      rw [ih]

theorem findings_wrap (ctx : Context) : ∀ (xs : List Input) (s : Release.State),
    findings fullModel ctx s xs = findings innerModel ctx s (xs.filter fun c => !refuses s c)
  | [], _ => rfl
  | c :: cs, s => by
    cases r : refuses s c with
    | true =>
      have e : findingAt fullModel ctx s c = [] := by
        cases c with
        | frame w => simp [findingAt, frame_ref r]
        | _ => rfl
      simp only [findings, e, List.append_nil, exec_ref r, List.filter_cons, r,
        Bool.not_true, Bool.false_eq_true, if_false]
      exact findings_wrap ctx cs s
    | false =>
      have e : findingAt fullModel ctx s c = findingAt innerModel ctx s c := by
        cases c with
        | frame w => simp only [findingAt, free_frame' r]; rfl
        | _ => rfl
      have ih := findings_wrap ctx cs (execute innerModel ctx s c)
      simp only [stays] at ih
      simp only [findings, e, exec_free r, List.filter_cons, r, Bool.not_false, if_true]
      rw [ih]

theorem noClear_wrap (ctx : Context) : ∀ (xs : List Input) (s : Release.State),
    Historical.noClear fullModel ctx s xs → Historical.noClear innerModel ctx s (xs.filter fun c => !refuses s c)
  | [], _, _ => trivial
  | c :: cs, s, ⟨hd, tl⟩ => by
    cases r : refuses s c with
    | true =>
      rw [exec_ref r] at tl
      simp only [List.filter_cons, r, Bool.not_true, Bool.false_eq_true, if_false]
      exact noClear_wrap ctx cs s tl
    | false =>
      rw [exec_free r] at tl
      have ih := noClear_wrap ctx cs _ tl
      simp only [stays] at ih
      simp only [List.filter_cons, r, Bool.not_false, if_true]
      exact ⟨hd, ih⟩

theorem without_wrap (ctx : Context) (P : Release.State → ByteArray → Prop) : ∀ (xs : List Input) (s : Release.State),
    without fullModel ctx P s xs → without innerModel ctx P s (xs.filter fun c => !refuses s c)
  | [], _, _ => trivial
  | c :: cs, s, ⟨hd, tl⟩ => by
    cases r : refuses s c with
    | true =>
      rw [exec_ref r] at tl
      simp only [List.filter_cons, r, Bool.not_true, Bool.false_eq_true, if_false]
      exact without_wrap ctx P cs s tl
    | false =>
      rw [exec_free r] at tl
      have ih := without_wrap ctx P cs _ tl
      simp only [stays] at ih
      simp only [List.filter_cons, r, Bool.not_false, if_true]
      refine ⟨?_, ih⟩
      cases c with
      | frame w => intro t hit; exact hd t (by rw [free_frame' r]; exact hit)
      | _ => trivial

theorem pub_replay : Root12.Replay fullModel where
  kept := by
    intro ctx s xs
    induction xs generalizing s with
    | nil => rfl
    | cons c cs ih =>
      cases c with
      | feed | reset => exact ih _
      | frame w =>
        cases ok : fullModel.step ctx w s with
        | none => simpa [Release.kept,run,execute,ok] using ih s
        | some t => simpa [Release.kept,run,execute,ok] using ih t
      | stamp w =>
        cases ok : fullModel.stamp w s with
        | none => simpa [Release.kept,run,execute,ok] using ih s
        | some t => simpa [Release.kept,run,execute,ok] using ih t
  feedEffect := fun s b => by
    change (if refuses s (.feed b) then s else innerModel.feed b s) = s ∨
      (if refuses s (.feed b) then s else innerModel.feed b s) = Root12.fed b s
    split
    · exact .inl rfl
    · exact inner_lawful.replay.1.feedEffect s b
  resetEffect := fun s => by
    change (if refuses s .reset then s else innerModel.reset s) = s ∨
      (if refuses s .reset then s else innerModel.reset s) = Root12.cleared s
    split
    · exact .inl rfl
    · exact inner_lawful.replay.1.resetEffect s
  feedWhen := fun s b o => by
    change (if refuses s (.feed b) then s else innerModel.feed b s) = _
    rw [free_of_open o]; exact inner_lawful.replay.1.feedWhen s b o
  resetWhen := fun s o => by
    change (if refuses s .reset then s else innerModel.reset s) = _
    rw [free_of_open o]; exact inner_lawful.replay.1.resetWhen s o

theorem pub_record : Record fullModel where
  raw := fun ctx s xs => by
    rw [run_def, inputRecord_wrap]; exact inner_lawful.record.raw ctx s _
  version := inner_lawful.record.version
  parses := fun ctx w s t hit => inner_lawful.record.parses ctx w s t (inner_hit hit)
  ledger := fun key start g ctx s xs => by
    rw [run_def, history_wrap]; exact inner_lawful.record.ledger key start g ctx s _
  view := fun key start g ctx xs => by
    rw [run_def]; exact inner_lawful.record.view key start g ctx _
  consistent := fun ctx w s t d v raw op hit dec later =>
    inner_lawful.record.consistent ctx w s t d v raw op (inner_hit hit) dec later

theorem memory_carry {start : Release.State} (h : Memory innerModel start) : Memory fullModel start :=
  ⟨fun ctx s xs => by rw [run_def]; exact h.1 ctx s _,
   fun ctx s w t d old rep reason hit dec act => h.2.1 ctx s w t d old rep reason (inner_hit hit) dec act,
   fun ctx xs c mem => by
     rw [run_def] at mem; rw [history_wrap]; exact h.2.2 ctx _ c mem⟩

theorem outcome_carry {start : Release.State} (h : Outcome innerModel start) : Outcome fullModel start :=
  ⟨fun ctx xs i => by
     dsimp only; rw [run_def, history_wrap]; exact h.1 ctx _ i,
   fun ctx xs key => by
     dsimp only; rw [run_def, findings_wrap]; exact h.2 ctx _ key⟩

theorem floor_carry {start : Release.State} (h : Ports.Floor innerModel start) : Ports.Floor fullModel start :=
  ⟨fun ctx xs w t u => by
     dsimp only; rw [run_def]; intro inst hit; exact h.1 ctx _ w t u inst (inner_hit hit),
   pub_binding,
   fun ctx xs w t d => by
     dsimp only; rw [run_def]; intro del hit; exact h.2.2 ctx _ w t d del (inner_hit hit)⟩

theorem pub_once : Once fullModel := fun ctx w s t i hit direct => by
  obtain ⟨a, b, c, d, tail⟩ := inner_lawful.once ctx w s t i (inner_hit hit) direct
  refine ⟨a, b, c, d, fun xs later no dl => ?_⟩
  rw [run_def]
  exact none_of_inner (tail _ later (without_wrap ctx _ xs t no) dl)

theorem pub_restore : Restore fullModel :=
  ⟨fun ctx w s t p n keys ed ml tr hit => by
     obtain ⟨a, b, c, tail⟩ := inner_lawful.restore.1 ctx w s t p n keys ed ml tr (inner_hit hit)
     exact ⟨a, b, c, fun xs later i g sp => by rw [run_def]; exact none_of_inner (tail _ later i g sp)⟩,
   fun ctx w s t keys kc hit => by
     obtain ⟨a, b, c, tail⟩ := inner_lawful.restore.2 ctx w s t keys kc (inner_hit hit)
     exact ⟨a, b, c, fun xs later i g sp => by rw [run_def]; exact none_of_inner (tail _ later i g sp)⟩⟩

theorem pub_expiry : Expiry fullModel :=
  ⟨fun ctx w s t p n last i ed ml tm hit => inner_lawful.expiry.1.1 ctx w s t p n last i ed ml tm (inner_hit hit),
   fun ctx w s i closed sp => none_of_inner (inner_lawful.expiry.1.2.1 ctx w s i closed sp),
   fun ctx s i xs w closed no sp => by
     rw [run_def]; exact none_of_inner (inner_lawful.expiry.1.2.2 ctx s i _ w closed (without_wrap ctx _ xs s no) sp)⟩

theorem pub_correction : Correction fullModel :=
  ⟨inner_lawful.correction.1.1, fun ctx w s t i v fix mk hit => inner_lawful.correction.1.2 ctx w s t i v fix mk (inner_hit hit)⟩

theorem pub_control : Control fullModel :=
  ⟨⟨fun ctx w s t x extra op ed tr act hit => inner_lawful.control.1.1 ctx w s t x extra op ed tr act (inner_hit hit),
    fun ctx w s t p n d ed ml tr hit => inner_lawful.control.1.2 ctx w s t p n d ed ml tr (inner_hit hit)⟩,
   fun ctx w s t p n d ed ml c hit => inner_lawful.control.2 ctx w s t p n d ed ml c (inner_hit hit)⟩

theorem pub_retention : RetentionLaw fullModel := fun ctx s xs => by
  rw [run_def]; exact inner_lawful.retention ctx s _

theorem pub_h4 : Root12.H4 fullModel := fun ctx s xs => by
  rw [run_def]; exact inner_lawful.h4 ctx s _

theorem pub_confinement : Historical.Confinement fullModel := fun ctx s xs h no => by
  rw [run_def]; exact inner_lawful.h2 ctx s _ h (noClear_wrap ctx xs s no)

theorem pub_rMono : RMono fullModel := fun ctx s c => by
  rw [exec_def]; split
  · exact List.Subset.refl _
  · exact inner_lawful.r_mono ctx s c

theorem pub_idFixed : IdFixed fullModel := fun ctx s c => by
  rw [exec_def]; split
  · rfl
  · exact inner_lawful.id_fixed ctx s c

theorem walk_def (ctx : Context) (ops : List RecordBinding.Op) (x : Release.State × List ByteArray) :
    RecordBinding.walk fullModel ctx x ops = RecordBinding.walk innerModel ctx x (ops.filter (keepOp x.1)) :=
  walk_wrap full_carries ctx ops x

theorem isSome_inner {ctx : Context} {w : ByteArray} {s : Release.State} (h : (fullModel.step ctx w s).isSome) :
    (innerModel.step ctx w s).isSome := by
  cases e : fullModel.step ctx w s with
  | none => rw [e] at h; cases h
  | some t => rw [inner_hit e]; rfl

theorem pub_separation : RecordBinding.Separation fullModel := fun ctx l1 k1 h1 l2 k2 h2 s1 s2 o1 o2 g1 g2 ne nc => by
  rw [walk_def, walk_def] at nc ⊢
  exact inner_lawful.b1 ctx l1 k1 h1 l2 k2 h2 s1 s2 _ _ g1 g2 ne nc

theorem pub_refusal : RecordBinding.Refusal fullModel := fun ctx l1 k1 h1 l2 k2 h2 s1 s2 o1 o2 w g1 g2 ne nc hs ok => by
  rw [walk_def, walk_def] at nc
  rw [walk_def] at ok ⊢
  exact none_of_inner (inner_lawful.b2 ctx l1 k1 h1 l2 k2 h2 s1 s2 _ _ w g1 g2 ne nc hs (isSome_inner ok))

theorem pub_start : BoundStart.StartClauses fullModel := fun law keys host start g => by
  obtain ⟨v, mem, out, gr, fl, th⟩ := inner_lawful.b3 law keys host start g
  refine ⟨fun ctx xs => by rw [run_def]; exact v ctx _, memory_carry mem, outcome_carry out,
    ⟨gr.1, gr.2.1, fun ctx xs i h => by rw [run_def] at h ⊢; exact gr.2.2 ctx _ i h⟩, floor_carry fl, th⟩

#print axioms pub_replay
#print axioms pub_record
#print axioms pub_start

/-! ### Family D: the advice laws (restated: aligned inputs that are not refused) -/

theorem refusedIn_congr {s t : Release.State} (h : t.policy.refused = s.policy.refused) (c : Input) :
    Forms.RefusedIn t c ↔ Forms.RefusedIn s c := by
  unfold Forms.RefusedIn; rw [h]

theorem free_after {ctx : Context} {s : Release.State} {c : Input} {xs : List Input}
    (n : ∀ d ∈ xs, ¬ Forms.RefusedIn s d) : ∀ d ∈ xs, ¬ Forms.RefusedIn (execute innerModel ctx s c) d :=
  fun d m r => n d m ((refusedIn_congr (full_carries ctx s c) d).mp r)

theorem free_after_full {ctx : Context} {s : Release.State} {c : Input} {xs : List Input}
    (n : ∀ d ∈ xs, ¬ Forms.RefusedIn s d) : ∀ d ∈ xs, ¬ Forms.RefusedIn (execute fullModel ctx s c) d :=
  fun d m r => n d m ((refusedIn_congr (wrap_carries full_carries ctx s c) d).mp r)

theorem run_free {ctx : Context} {s : Release.State} {xs : List Input} (n : ∀ c ∈ xs, ¬ Forms.RefusedIn s c) :
    run fullModel ctx s xs = run innerModel ctx s xs := by
  rw [run_def, List.filter_eq_self.mpr]
  intro c m
  rw [not_refuses (n c m)]; rfl

theorem verdicts_free (ctx : Context) : ∀ (xs : List Input) (s : Release.State), (∀ c ∈ xs, ¬ Forms.RefusedIn s c) →
    Advice.verdicts fullModel ctx s xs = Advice.verdicts innerModel ctx s xs
  | [], _, _ => rfl
  | c :: cs, s, n => by
    have r := not_refuses (n c (List.mem_cons_self ..))
    have tail : ∀ d ∈ cs, ¬ Forms.RefusedIn s d := fun d m => n d (List.mem_cons_of_mem _ m)
    have ih := verdicts_free ctx cs (execute innerModel ctx s c) (free_after tail)
    cases c with
    | frame w => simp only [Advice.verdicts, free_frame' r, exec_free r, ih]
    | feed b => simp only [Advice.verdicts, exec_free r, ih]
    | reset => simp only [Advice.verdicts, exec_free r, ih]
    | stamp w => simp only [Advice.verdicts, exec_free r, ih]

theorem aligned_free {ctx : Context} {s t : Release.State} {xs ys : List Input}
    (al : Advice.Aligned fullModel ctx s t xs ys) (nx : ∀ c ∈ xs, ¬ Forms.RefusedIn s c)
    (ny : ∀ c ∈ ys, ¬ Forms.RefusedIn t c) : Advice.Aligned innerModel ctx s t xs ys := by
  induction al with
  | nil => exact .nil
  | @frame s t wx wy xs ys pair _ ih =>
    have rx := not_refuses (nx _ (List.mem_cons_self ..)); have ry := not_refuses (ny _ (List.mem_cons_self ..))
    rw [exec_free rx, exec_free ry] at ih
    exact .frame pair (ih (free_after fun d m => nx d (List.mem_cons_of_mem _ m))
      (free_after fun d m => ny d (List.mem_cons_of_mem _ m)))
  | @feed s t b xs ys _ ih =>
    have rx := not_refuses (nx _ (List.mem_cons_self ..)); have ry := not_refuses (ny _ (List.mem_cons_self ..))
    have ex : fullModel.feed b s = innerModel.feed b s := exec_free (ctx := ctx) rx
    have ey : fullModel.feed b t = innerModel.feed b t := exec_free (ctx := ctx) ry
    rw [ex, ey] at ih
    exact .feed (ih (free_after (ctx := ctx) (c := .feed b) fun d m => nx d (List.mem_cons_of_mem _ m))
      (free_after (ctx := ctx) (c := .feed b) fun d m => ny d (List.mem_cons_of_mem _ m)))
  | @reset s t xs ys _ ih =>
    have rx := not_refuses (nx _ (List.mem_cons_self ..)); have ry := not_refuses (ny _ (List.mem_cons_self ..))
    have ex : fullModel.reset s = innerModel.reset s := exec_free (ctx := ctx) rx
    have ey : fullModel.reset t = innerModel.reset t := exec_free (ctx := ctx) ry
    rw [ex, ey] at ih
    exact .reset (ih (free_after (ctx := ctx) (c := .reset) fun d m => nx d (List.mem_cons_of_mem _ m))
      (free_after (ctx := ctx) (c := .reset) fun d m => ny d (List.mem_cons_of_mem _ m)))
  | @stamp s t wx wy xs ys _ ih =>
    have rx := not_refuses (nx _ (List.mem_cons_self ..)); have ry := not_refuses (ny _ (List.mem_cons_self ..))
    rw [exec_free rx, exec_free ry] at ih
    exact .stamp (ih (free_after fun d m => nx d (List.mem_cons_of_mem _ m))
      (free_after fun d m => ny d (List.mem_cons_of_mem _ m)))

theorem valigned_free {ctx : Context} {s t : Release.State} {xs ys : List Input}
    (al : VersionAdvice.Aligned fullModel ctx s t xs ys) (nx : ∀ c ∈ xs, ¬ Forms.RefusedIn s c)
    (ny : ∀ c ∈ ys, ¬ Forms.RefusedIn t c) : VersionAdvice.Aligned innerModel ctx s t xs ys := by
  induction al with
  | nil => exact .nil
  | frame left right _ ih =>
    have rx := not_refuses (nx _ (List.mem_cons_self ..)); have ry := not_refuses (ny _ (List.mem_cons_self ..))
    rw [exec_free rx, exec_free ry] at ih
    exact .frame left right (ih (free_after fun d m => nx d (List.mem_cons_of_mem _ m))
      (free_after fun d m => ny d (List.mem_cons_of_mem _ m)))

theorem pub_advice : VersionAdvice fullModel :=
  ⟨fun ctx s xs ys nx ny al => by
     rw [run_free nx, run_free ny, verdicts_free ctx xs s nx, verdicts_free ctx ys s ny]
     exact inner_lawful.advice.1 ctx s xs ys nx ny (aligned_free al nx ny),
   fun ctx s t xs ys equal nx ny al => by
     rw [run_free nx, run_free ny, verdicts_free ctx xs s nx, verdicts_free ctx ys t ny]
     exact inner_lawful.advice.2 ctx s t xs ys equal nx ny (valigned_free al nx ny)⟩

theorem pub_readdressed : Rebinding.Readdressed fullModel := by
  intro ctx l1 k1 h1 l2 k2 h2 s1 s2 o1 o2 g1 g2 ne nc
  rw [walk_def, walk_def] at nc
  have H := inner_lawful.b4 ctx l1 k1 h1 l2 k2 h2 s1 s2 _ _ g1 g2 ne nc
  dsimp only at H ⊢
  rw [walk_def ctx o1, walk_def ctx o2]
  obtain ⟨a, b, c, d⟩ := H
  exact ⟨fun w w' p n e i p' n' e' i' ed ml t1 t2 ok so =>
      none_of_inner (a w w' p n e i p' n' e' i' ed ml t1 t2 (isSome_inner ok) so),
    fun w w' p n d p' n' d' ed ml t1 t2 ok so =>
      none_of_inner (b w w' p n d p' n' d' ed ml t1 t2 (isSome_inner ok) so),
    fun w w' f f' op op' ed ml t1 a1 t2 a2 ok so =>
      none_of_inner (c w w' f f' op op' ed ml t1 a1 t2 a2 (isSome_inner ok) so),
    fun w w' p n v p' n' v' z1 z2 pr1 b1 pr2 b2 f1 f2 ok so =>
      none_of_inner (d w w' p n v p' n' v' z1 z2 pr1 b1 pr2 b2 f1 f2 (isSome_inner ok) so)⟩

theorem ordinary_refused_empty {key start} (g : fullModel.genesis key = some start) : start.policy.refused = [] := by
  change (Core8.genesis key).map (fun base => ({ base } : Policy9.Machine)) = some start at g
  obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp g
  rfl

theorem ledger_carry
    (h : ∀ ctx s xs, (ledger (run innerModel ctx s xs)).history = (ledger s).history ++ Root12.Grammar.history innerModel ctx s xs) :
    ∀ ctx s xs, (ledger (run fullModel ctx s xs)).history = (ledger s).history ++ Root12.Grammar.history fullModel ctx s xs :=
  fun ctx s xs => by rw [run_def, history_wrap]; exact h ctx s _

theorem view_carry {start : Release.State} (h : ∀ ctx xs, R2.ViewSound (ledger (run innerModel ctx start xs))) :
    ∀ ctx xs, R2.ViewSound (ledger (run fullModel ctx start xs)) :=
  fun ctx xs => by rw [run_def]; exact h ctx _

theorem pool_carry {start : Release.State}
    (h : ∀ ctx xs i, i ∈ pool (run innerModel ctx start xs) → GrantOrigin9.Signed (owner (run innerModel ctx start xs)) i) :
    ∀ ctx xs i, i ∈ pool (run fullModel ctx start xs) → GrantOrigin9.Signed (owner (run fullModel ctx start xs)) i :=
  fun ctx xs i m => by rw [run_def] at m ⊢; exact h ctx _ i m

theorem pub_refused_refuses : RefusedRefuses fullModel := fun ctx s c f hf hm he => by
  have r : refuses s c = true := by simp [refuses, hf, he, hm]
  refine ⟨exec_ref r, fun w e => ?_, fun w e => ?_⟩
  · subst e; exact frame_ref r
  · subst e
    show (if refuses s (.stamp w) then none else innerModel.stamp w s) = none
    rw [if_pos r]

theorem pub_essentials_open : EssentialsOpen fullModel := fun ctx s c f _ n => by
  have e : (execute fullModel ctx s c).policy.refused = s.policy.refused := wrap_carries full_carries ctx s c
  rw [e]; exact n

theorem noClearInputs_wrap (ctx : Context) : ∀ (xs : List Input) (s : Release.State),
    Safe11.noClearInputs fullModel ctx s xs → Safe11.noClearInputs innerModel ctx s (xs.filter fun c => !refuses s c)
  | [], _, _ => trivial
  | c :: cs, s, ⟨hd, tl⟩ => by
    cases r : refuses s c with
    | true =>
      rw [exec_ref r] at tl
      simp only [List.filter_cons, r, Bool.not_true, Bool.false_eq_true, if_false]
      exact noClearInputs_wrap ctx cs s tl
    | false =>
      rw [exec_free r] at tl
      have ih := noClearInputs_wrap ctx cs _ tl
      simp only [stays] at ih
      simp only [List.filter_cons, r, Bool.not_false, if_true]
      exact ⟨hd, ih⟩

/-- The v0.5 supplement (restated E5, E6) holds of the public machine. -/
theorem pub_supplement : Root12.Supplement fullModel where
  e1 := fun hit => Root12.full_supplement.e1 (inner_hit hit)
  e1b := fun hit => Root12.full_supplement.e1b (inner_hit hit)
  e2 := fun hit => Root12.full_supplement.e2 (inner_hit hit)
  e3 := ⟨fun hit => Root12.full_supplement.e3.1 (inner_hit hit), fun hit => Root12.full_supplement.e3.2 (inner_hit hit)⟩
  e4 := fun hit => Root12.full_supplement.e4 (inner_hit hit)
  e5 := fun ctx w s tag free => by rw [free_frame free]; exact Root12.full_supplement.e5 ctx w s tag free
  e6 := fun ok a b pos basis weaker addr active free ready => by
    rw [free_frame free]; exact Root12.full_supplement.e6 (inner_hit ok) a b pos basis weaker addr active free ready
  h1 := fun ctx w s h r n => none_of_inner (Root12.full_supplement.h1 ctx w s h r n)
  h2 := fun ctx s xs h no => by rw [run_def]; exact Root12.full_supplement.h2 ctx s _ h (noClearInputs_wrap ctx xs s no)
  h3 := fun ctx s w t r hit => Root12.full_supplement.h3 ctx s w t r (inner_hit hit)
  h4 := pub_h4
  h5 := ⟨fun ctx s w v => by rw [free_frame' (clear_free v.1)]; exact Root12.full_supplement.h5.1 ctx s w v,
    fun ctx s w rt sh b k => by rw [free_frame' (rebind_free rt)]; exact Root12.full_supplement.h5.2 ctx s w rt sh b k⟩
  succession := fun ctx w s t tag hit => Root12.full_supplement.succession ctx w s t tag (inner_hit hit)

/-- The root law set holds of the public machine. -/
theorem full_lawful : Lawful fullModel where
  replay := ⟨pub_replay, ports_of_replay pub_replay⟩
  record := pub_record
  stale := pub_stale
  once := pub_once
  passive := pub_passive
  advice := pub_advice
  restore := pub_restore
  upgrade := pub_upgrade
  memory := fun k s g => memory_carry (inner_lawful.memory k s g)
  outcome := fun k s g => outcome_carry (inner_lawful.outcome k s g)
  grants := ⟨pub_grantSource, fun k s g =>
    ⟨(inner_lawful.grants.2 k s g).1, (inner_lawful.grants.2 k s g).2.1,
     fun ctx xs i h => by rw [run_def] at h ⊢; exact (inner_lawful.grants.2 k s g).2.2 ctx _ i h⟩⟩
  binding := pub_binding
  control := pub_control
  monotone := pub_monotone
  floor := fun k s g => floor_carry (inner_lawful.floor k s g)
  threshold := ⟨pub_signedThreshold, pub_supports .threshold, inner_lawful.threshold.2.2⟩
  missing := pub_missing
  bundle := ⟨pub_bundle, pub_supports .assessment, pub_riskState⟩
  stamping := ⟨pub_stamping, pub_stampSupports⟩
  revoke := ⟨pub_revocation, pub_supports .cancel, pub_rules⟩
  expiry := ⟨pub_expiry, pub_supports .issue⟩
  correction := ⟨pub_correction, pub_supports .report⟩
  retention := pub_retention
  e1 := @pub_e1
  e1b := @pub_e1b
  e2 := @pub_e2
  e3 := pub_e3
  e4 := @pub_e4
  e5 := pub_speech
  e6 := @pub_e6
  h1 := pub_boundary
  h2 := pub_confinement
  h3 := pub_clearEffect
  h4 := pub_h4
  h5 := ⟨pub_recovery, pub_session_recovery, SegmentFinal.rollover fullModel⟩
  succession := pub_succession
  w1 := pub_w1
  b1 := pub_separation
  b2 := pub_refusal
  b3 := pub_start
  b4 := pub_readdressed
  pinned := pub_pinned
  r_mono := pub_rMono
  id_fixed := pub_idFixed
  refused_refuses := pub_refused_refuses
  essentials_open := pub_essentials_open

/-- The witness skeleton 2 left open: the whole root set holds of a machine that refuses a refused approval. -/
theorem refusal_is_lawful : Lawful fullModel ∧
    ∀ ctx s w, Forms.formOf w = some .approval → Forms.FormId.approval.code ∈ s.policy.refused →
      fullModel.step ctx w s = none :=
  ⟨full_lawful, fun ctx s w f m => (pub_refused_refuses ctx s (.frame w) .approval f m rfl).2.1 w rfl⟩

#print axioms full_lawful
#print axioms refusal_is_lawful
#print axioms pub_passive
#print axioms pub_stale
end Aukora.RootFinal
