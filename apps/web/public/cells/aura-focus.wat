;; aura_focus.wat : the x6.1 Aura focus decision as one hand-written integer cell (Microverse ABI v1 guest).
;; i32 and i64 only. No imports. One page of linear storage, fixed.
;; Ops: aura.focus, aura.decide_net, aura.focus_both, aura.decide_both. Contract: PROFILE.md.
;;
;; Storage map (bytes):
;;   64..1151   text literals, NUL-terminated, one per 32-byte slot
;;   1152       focus code for each of the 11 outcomes
;;   1184       four guarded surprise thresholds, each (G << 18) as four LE u32 limbs:
;;              observe lower 1184, observe upper 1200, escalate lower 1216, escalate upper 1232
;;   1280       circuit: W1 1280 (16x16), b1 1536, W2 1552 (14x16), b2 1776, W3 1790 (11x14), b3 1944,
;;              shifts 1955..1957
;;   2048       nine counts as u64
;;   2128       up to five scores as (hi u32, lo u32)
;;   2176       ACC: 36 LE u32 limbs, exact sum of the scores in units of 2^-1074
;;   2320       T: 4 limbs, n * threshold
;;   2368 2432 2496 2560   four 10-limb integers for the coherence comparison
;;   2624 2656 2688 2720   circuit activations: input, layer 1, layer 2, layer 3
;;   2752       decimal digit scratch
;;   3072..4095 response
;;   4096..8191 request
(module
  (memory (export "memory") 1 1)

  (global $p (mut i32) (i32.const 0))       ;; parse cursor
  (global $end (mut i32) (i32.const 0))     ;; end of request
  (global $err (mut i32) (i32.const 0))     ;; 0 ok, else refusal code number
  (global $ovf (mut i32) (i32.const 0))     ;; a multi-limb carry left its buffer
  (global $seqok (mut i32) (i32.const 0))
  (global $seq (mut i64) (i64.const 0))
  (global $o (mut i32) (i32.const 3072))    ;; response cursor
  (global $hbhi (mut i32) (i32.const 0))
  (global $hblo (mut i32) (i32.const 0))
  (global $n (mut i32) (i32.const 0))       ;; number of scores
  (global $h (mut i32) (i32.const 0))       ;; handoff mismatch
  (global $U (mut i32) (i32.const 0))       ;; unanchored > 0
  (global $w (mut i32) (i32.const 0))       ;; pending wakes >= 2
  (global $r (mut i32) (i32.const 0))       ;; rollback age < 3
  (global $drift (mut i32) (i32.const 0))
  (global $hb (mut i32) (i32.const 0))      ;; checks: 0 below, 1 boundary, 2 above
  (global $esc (mut i32) (i32.const 0))
  (global $obs (mut i32) (i32.const 0))
  (global $coh (mut i32) (i32.const 0))
  (global $focus (mut i32) (i32.const 0))
  (global $reason (mut i32) (i32.const 0))
  (global $status (mut i32) (i32.const 0))
  (global $rule (mut i32) (i32.const 0))
  (global $net (mut i32) (i32.const 0))

  ;; ---- request literals ----
  (data (i32.const 64) "{\22abi\22:1,\22input\22:{\22")
  (data (i32.const 96) "counts\22:[")
  (data (i32.const 128) "],\22heartbeat\22:[")
  (data (i32.const 160) "],\22mismatch\22:")
  (data (i32.const 192) ",\22scores\22:[")
  (data (i32.const 224) "},\22op\22:\22")
  (data (i32.const 256) "bits\22:[")
  (data (i32.const 288) "],\22checks\22:[")
  (data (i32.const 320) ",\22seq\22:")
  (data (i32.const 352) "aura.focus\22")
  (data (i32.const 384) "aura.decide_net\22")
  (data (i32.const 416) "aura.focus_both\22")
  (data (i32.const 448) "aura.decide_both\22")
  ;; ---- response literals ----
  (data (i32.const 480) "{\22abi\22:1,\22result\22:{")
  (data (i32.const 512) "\22checks\22:[")
  (data (i32.const 544) "\22focus\22:")
  (data (i32.const 576) ",\22net\22:")
  (data (i32.const 608) ",\22out\22:[")
  (data (i32.const 640) ",\22reason\22:")
  (data (i32.const 672) ",\22rule\22:")
  (data (i32.const 704) ",\22status\22:")
  (data (i32.const 736) "},\22seq\22:")
  (data (i32.const 768) ",\22status\22:\22ok\22}")
  (data (i32.const 800) "{\22abi\22:1,\22code\22:\22")
  (data (i32.const 832) "\22,\22seq\22:")
  (data (i32.const 864) ",\22status\22:\22refused\22}")
  ;; ---- refusal codes: address = 864 + 32 * code number ----
  (data (i32.const 896) "MALFORMED")
  (data (i32.const 928) "INPUTS_INCOMPLETE")
  (data (i32.const 960) "OP_UNKNOWN")
  (data (i32.const 992) "SCORES_OVER_FIVE")
  (data (i32.const 1024) "INTERNAL")
  (data (i32.const 1056) "NET_NOT_ONE_HOT")
  ;; ---- focus code per outcome 0..10: escalate x3, null, verify x2, observe, null, null, consolidate, rest ----
  (data (i32.const 1152) "\05\05\05\00\04\04\03\00\00\02\01")
  ;; <thresholds> written by tools/splice.py from constants.json
  (data (i32.const 1184) "\00\00\58\1d\48\69\ec\4e\a9\ee\97\ad\b3\f3\1e\00\00\00\58\1e\48\69\ec\4e\a9\b6\98\ad\b3\f3\1e\00\00\00\74\23\e2\92\8e\34\38\8f\00\bd\e4\ba\56\00\00\00\e8\b7\a3\dd\8e\34\38\57\01\bd\e4\ba\56\00")
  ;; </thresholds>
  ;; <net> written by tools/splice.py from decision_net.json
  (data (i32.const 1280) "\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\04\04\02\01\00\00\00\00\00\00\00\00\00\00\00\00\04\04\02\01\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\08\01\04\00\f8\00\00\00\00\00\00\00\00\00\00\7f\00\00\00\00\00\00\00\00\00\00\00\00\00\81\00\00\00\00\7f\00\00\00\00\00\00\00\00\81\00\00\00\00\81\00\7f\00\00\00\00\00\00\81\00\00\81\00\81\00\81\00\00\00\00\00\00\81\7f\7f\00\81\81\81\81\00\00\00\00\00\00\81\7f\81\00\81\81\81\81\00\00\00\00\00\00\81\81\00\00\81\81\81\81\00\00\7f\00\00\00\81\81\00\00\81\81\81\81\00\7f\00\00\00\00\81\81\00\00\81\81\81\81\7f\00\00\00\7f\00\81\81\00\00\81\81\81\81\7f\00\00\7f\00\00\81\81\00\00\81\81\81\81\7f\00\00\00\00\7f\00\00\00\7f\81\00\00\00\81\81\81\06\03\00")
  ;; </net>

  ;; ================= parsing =================
  (func $seterr (param $c i32)
    (if (i32.eqz (global.get $err)) (then (global.set $err (local.get $c)))))

  (func $fail (call $seterr (i32.const 1)))

  (func $peek (result i32)
    (if (result i32) (i32.lt_u (global.get $p) (global.get $end))
      (then (i32.load8_u (global.get $p)))
      (else (i32.const 0))))

  (func $eat (param $c i32)
    (if (i32.eq (call $peek) (local.get $c))
      (then (global.set $p (i32.add (global.get $p) (i32.const 1))))
      (else (call $fail))))

  ;; Match the NUL-terminated literal at $a. On a full match advance and return 1; else return 0, cursor unmoved.
  (func $try (param $a i32) (result i32)
    (local $q i32) (local $c i32)
    (local.set $q (global.get $p))
    (block $done
      (loop $next
        (local.set $c (i32.load8_u (local.get $a)))
        (br_if $done (i32.eqz (local.get $c)))
        (if (i32.ge_u (local.get $q) (global.get $end)) (then (return (i32.const 0))))
        (if (i32.ne (i32.load8_u (local.get $q)) (local.get $c)) (then (return (i32.const 0))))
        (local.set $a (i32.add (local.get $a) (i32.const 1)))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))
        (br $next)))
    (global.set $p (local.get $q))
    (i32.const 1))

  (func $lit (param $a i32)
    (if (i32.eqz (call $try (local.get $a))) (then (call $fail))))

  ;; Canonical unsigned decimal, at most 16 digits, no leading zero, value <= 2^53 - 1.
  (func $uint (result i64)
    (local $c i32) (local $v i64) (local $k i32)
    (local.set $c (call $peek))
    (if (i32.or (i32.lt_u (local.get $c) (i32.const 48)) (i32.gt_u (local.get $c) (i32.const 57)))
      (then (call $fail) (return (i64.const 0))))
    (if (i32.eq (local.get $c) (i32.const 48))
      (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (local.set $c (call $peek))
        (if (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
          (then (call $fail)))
        (return (i64.const 0))))
    (block $done
      (loop $next
        (local.set $c (call $peek))
        (br_if $done (i32.or (i32.lt_u (local.get $c) (i32.const 48)) (i32.gt_u (local.get $c) (i32.const 57))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (if (i32.gt_u (local.get $k) (i32.const 16)) (then (call $fail) (return (i64.const 0))))
        (local.set $v (i64.add (i64.mul (local.get $v) (i64.const 10))
                               (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 48)))))
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $next)))
    (if (i64.gt_u (local.get $v) (i64.const 9007199254740991)) (then (call $fail) (return (i64.const 0))))
    (local.get $v))

  ;; An integer in 0..$max (max below 2^32).
  (func $small (param $max i64) (result i32)
    (local $v i64)
    (local.set $v (call $uint))
    (if (i64.gt_u (local.get $v) (local.get $max)) (then (call $fail) (return (i32.const 0))))
    (i32.wrap_i64 (local.get $v)))

  ;; After `counts":[` : nine counts, heartbeat halves, mismatch, up to five score pairs, closing bracket.
  (func $parse_full
    (local $i i32)
    (block $done
      (loop $next
        (i64.store (i32.add (i32.const 2048) (i32.shl (local.get $i) (i32.const 3))) (call $uint))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $done (i32.ge_u (local.get $i) (i32.const 9)))
        (call $eat (i32.const 44))
        (br $next)))
    (call $lit (i32.const 128))
    (global.set $hbhi (call $small (i64.const 4294967295)))
    (call $eat (i32.const 44))
    (global.set $hblo (call $small (i64.const 4294967295)))
    (call $lit (i32.const 160))
    (global.set $h (call $small (i64.const 1)))
    (call $lit (i32.const 192))
    (global.set $n (i32.const 0))
    (if (i32.eq (call $peek) (i32.const 93))
      (then (call $eat (i32.const 93)))
      (else
        (block $sdone
          (loop $snext
            (br_if $sdone (global.get $err))
            (if (i32.ge_u (global.get $n) (i32.const 5))
              (then (call $seterr (i32.const 4)) (br $sdone)))
            (call $eat (i32.const 91))
            (i32.store (i32.add (i32.const 2128) (i32.shl (global.get $n) (i32.const 3)))
                       (call $small (i64.const 4294967295)))
            (call $eat (i32.const 44))
            (i32.store (i32.add (i32.const 2132) (i32.shl (global.get $n) (i32.const 3)))
                       (call $small (i64.const 4294967295)))
            (call $eat (i32.const 93))
            (global.set $n (i32.add (global.get $n) (i32.const 1)))
            (if (i32.eq (call $peek) (i32.const 44))
              (then (call $eat (i32.const 44)) (br $snext)))))
        (call $eat (i32.const 93)))))

  ;; After `bits":[` : four bits, four check codes, closing bracket.
  (func $parse_dec
    (global.set $h (call $small (i64.const 1)))
    (call $eat (i32.const 44))
    (global.set $U (call $small (i64.const 1)))
    (call $eat (i32.const 44))
    (global.set $w (call $small (i64.const 1)))
    (call $eat (i32.const 44))
    (global.set $r (call $small (i64.const 1)))
    (call $lit (i32.const 288))
    (global.set $hb (call $small (i64.const 2)))
    (call $eat (i32.const 44))
    (global.set $esc (call $small (i64.const 2)))
    (call $eat (i32.const 44))
    (global.set $obs (call $small (i64.const 2)))
    (call $eat (i32.const 44))
    (global.set $coh (call $small (i64.const 2)))
    (call $eat (i32.const 93)))

  ;; ================= response writing =================
  (func $putc (param $c i32)
    (i32.store8 (global.get $o) (local.get $c))
    (global.set $o (i32.add (global.get $o) (i32.const 1))))

  (func $puts (param $a i32)
    (local $c i32)
    (block $done
      (loop $next
        (local.set $c (i32.load8_u (local.get $a)))
        (br_if $done (i32.eqz (local.get $c)))
        (call $putc (local.get $c))
        (local.set $a (i32.add (local.get $a) (i32.const 1)))
        (br $next))))

  (func $putu (param $v i64)
    (local $q i32)
    (local.set $q (i32.const 2776))
    (loop $next
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (i32.store8 (local.get $q)
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
      (br_if $next (i64.ne (local.get $v) (i64.const 0))))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $q) (i32.const 2776)))
        (call $putc (i32.load8_u (local.get $q)))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))
        (br $copy))))

  (func $puti (param $v i32) (call $putu (i64.extend_i32_u (local.get $v))))

  ;; $checks: include the five checks. $mode: 0 plain, 1 both paths (net and rule fields), 2 circuit outputs.
  (func $emit (param $checks i32) (param $mode i32)
    (local $i i32)
    (global.set $o (i32.const 3072))
    (call $puts (i32.const 480))
    (if (local.get $checks)
      (then
        (call $puts (i32.const 512))
        (call $puti (select (i32.const 10) (global.get $drift) (i32.gt_u (global.get $drift) (i32.const 10))))
        (call $putc (i32.const 44)) (call $puti (global.get $hb))
        (call $putc (i32.const 44)) (call $puti (global.get $esc))
        (call $putc (i32.const 44)) (call $puti (global.get $obs))
        (call $putc (i32.const 44)) (call $puti (global.get $coh))
        (call $putc (i32.const 93)) (call $putc (i32.const 44))))
    (call $puts (i32.const 544)) (call $puti (global.get $focus))
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then (call $puts (i32.const 576)) (call $puti (global.get $net))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then
        (call $puts (i32.const 608))
        (block $done
          (loop $next
            (br_if $done (i32.ge_u (local.get $i) (i32.const 11)))
            (if (local.get $i) (then (call $putc (i32.const 44))))
            (call $puti (i32.load8_u (i32.add (i32.const 2720) (local.get $i))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $next)))
        (call $putc (i32.const 93))))
    (call $puts (i32.const 640)) (call $puti (global.get $reason))
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then (call $puts (i32.const 672)) (call $puti (global.get $rule))))
    (call $puts (i32.const 704)) (call $puti (global.get $status))
    (call $puts (i32.const 736)) (call $putu (global.get $seq))
    (call $puts (i32.const 768)))

  (func $refuse
    (global.set $o (i32.const 3072))
    (call $puts (i32.const 800))
    (call $puts (i32.add (i32.const 864) (i32.shl (global.get $err) (i32.const 5))))
    (if (global.get $seqok)
      (then (call $puts (i32.const 832)) (call $putu (global.get $seq)))
      (else (call $putc (i32.const 34))))
    (call $puts (i32.const 864)))

  ;; ================= the five checks =================
  ;; A binary64 high half is admitted when the sign bit is clear and the exponent field is not 2047.
  (func $finite_nonneg (param $hi i32) (result i32)
    (i32.and
      (i32.eqz (i32.shr_u (local.get $hi) (i32.const 31)))
      (i32.ne (i32.and (i32.shr_u (local.get $hi) (i32.const 20)) (i32.const 2047)) (i32.const 2047))))

  ;; heartbeat against 7/10 -+ 2^-40. Exponent field 1022 means value = m * 2^-53 with m in [2^52, 2^53).
  (func $heartbeat (result i32)
    (local $e i32) (local $t i64)
    (local.set $e (i32.and (i32.shr_u (global.get $hbhi) (i32.const 20)) (i32.const 2047)))
    (if (i32.ge_u (local.get $e) (i32.const 1023)) (then (return (i32.const 2))))
    (if (i32.le_u (local.get $e) (i32.const 1021)) (then (return (i32.const 0))))
    (local.set $t (i64.mul (i64.const 10)
      (i64.or (i64.const 4503599627370496)
        (i64.or (i64.shl (i64.extend_i32_u (i32.and (global.get $hbhi) (i32.const 1048575))) (i64.const 32))
                (i64.extend_i32_u (global.get $hblo))))))
    (if (i64.lt_u (local.get $t) (i64.const 63050394783105024)) (then (return (i32.const 0))))
    (if (i64.gt_u (local.get $t) (i64.const 63050394783268864)) (then (return (i32.const 2))))
    (i32.const 1))

  ;; Add $v (below 2^32) into ACC at limb $j, carrying upward.
  (func $acc_put (param $j i32) (param $v i64)
    (local $a i32) (local $t i64)
    (block $done
      (loop $next
        (br_if $done (i64.eqz (local.get $v)))
        (if (i32.ge_u (local.get $j) (i32.const 36)) (then (global.set $ovf (i32.const 1)) (br $done)))
        (local.set $a (i32.add (i32.const 2176) (i32.shl (local.get $j) (i32.const 2))))
        (local.set $t (i64.add (i64.load32_u (local.get $a)) (local.get $v)))
        (i64.store32 (local.get $a) (local.get $t))
        (local.set $v (i64.shr_u (local.get $t) (i64.const 32)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $next))))

  ;; ACC += $m << $shift, $m below 2^53.
  (func $acc_add (param $m i64) (param $shift i32)
    (local $j i32) (local $b i64) (local $lo i64) (local $top i64)
    (local.set $j (i32.shr_u (local.get $shift) (i32.const 5)))
    (local.set $b (i64.extend_i32_u (i32.and (local.get $shift) (i32.const 31))))
    (local.set $lo (i64.shl (local.get $m) (local.get $b)))
    (if (i64.ne (local.get $b) (i64.const 0))
      (then (local.set $top (i64.shr_u (local.get $m) (i64.sub (i64.const 64) (local.get $b))))))
    (call $acc_put (local.get $j) (i64.and (local.get $lo) (i64.const 4294967295)))
    (call $acc_put (i32.add (local.get $j) (i32.const 1)) (i64.shr_u (local.get $lo) (i64.const 32)))
    (call $acc_put (i32.add (local.get $j) (i32.const 2)) (local.get $top)))

  ;; Compare ACC with (n * G) << 978, G18 = G << 18 stored at $g. Returns 0 less, 1 equal, 2 greater.
  (func $acc_cmp (param $g i32) (result i32)
    (local $i i32) (local $carry i64) (local $t i64) (local $x i64) (local $y i64) (local $nn i64)
    (local.set $nn (i64.extend_i32_u (global.get $n)))
    (block $d
      (loop $l
        (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $t (i64.add
          (i64.mul (i64.load32_u (i32.add (local.get $g) (i32.shl (local.get $i) (i32.const 2)))) (local.get $nn))
          (local.get $carry)))
        (i64.store32 (i32.add (i32.const 2320) (i32.shl (local.get $i) (i32.const 2))) (local.get $t))
        (local.set $carry (i64.shr_u (local.get $t) (i64.const 32)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (if (i64.ne (local.get $carry) (i64.const 0)) (then (global.set $ovf (i32.const 1))))
    ;; limbs 34 and 35 lie above T
    (if (i64.ne (i64.load (i32.const 2312)) (i64.const 0)) (then (return (i32.const 2))))
    ;; limbs 33..30 against T limbs 3..0
    (local.set $i (i32.const 4))
    (block $d2
      (loop $l2
        (br_if $d2 (i32.eqz (local.get $i)))
        (local.set $i (i32.sub (local.get $i) (i32.const 1)))
        (local.set $x (i64.load32_u (i32.add (i32.const 2296) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $y (i64.load32_u (i32.add (i32.const 2320) (i32.shl (local.get $i) (i32.const 2)))))
        (if (i64.gt_u (local.get $x) (local.get $y)) (then (return (i32.const 2))))
        (if (i64.lt_u (local.get $x) (local.get $y)) (then (return (i32.const 0))))
        (br $l2)))
    ;; limbs 29..0: T is zero there
    (local.set $i (i32.const 0))
    (block $d3
      (loop $l3
        (br_if $d3 (i32.ge_u (local.get $i) (i32.const 30)))
        (if (i32.load (i32.add (i32.const 2176) (i32.shl (local.get $i) (i32.const 2))))
          (then (return (i32.const 2))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l3)))
    (i32.const 1))

  ;; below iff ACC < n*lower ; above iff ACC > n*upper ; else boundary.
  (func $band (param $gl i32) (param $gu i32) (result i32)
    (if (i32.eqz (call $acc_cmp (local.get $gl))) (then (return (i32.const 0))))
    (if (i32.eq (call $acc_cmp (local.get $gu)) (i32.const 2)) (then (return (i32.const 2))))
    (i32.const 1))

  ;; Sets $esc and $obs from the exact mean of the n scores.
  (func $surprise
    (local $i i32) (local $hi i32) (local $e i32) (local $m i64) (local $a i32)
    (global.set $esc (i32.const 0))
    (global.set $obs (i32.const 0))
    (if (i32.eqz (global.get $n)) (then (return)))
    ;; one score of 128 or more puts the mean of at most five above both thresholds
    (block $d1
      (loop $l1
        (br_if $d1 (i32.ge_u (local.get $i) (global.get $n)))
        (local.set $e (i32.and
          (i32.shr_u (i32.load (i32.add (i32.const 2128) (i32.shl (local.get $i) (i32.const 3)))) (i32.const 20))
          (i32.const 2047)))
        (if (i32.ge_u (local.get $e) (i32.const 1030))
          (then (global.set $esc (i32.const 2)) (global.set $obs (i32.const 2)) (return)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l1)))
    ;; clear ACC (36 limbs, 144 bytes)
    (local.set $a (i32.const 2176))
    (block $d2
      (loop $l2
        (br_if $d2 (i32.ge_u (local.get $a) (i32.const 2320)))
        (i64.store (local.get $a) (i64.const 0))
        (local.set $a (i32.add (local.get $a) (i32.const 8)))
        (br $l2)))
    ;; exact sum in units of 2^-1074
    (local.set $i (i32.const 0))
    (block $d3
      (loop $l3
        (br_if $d3 (i32.ge_u (local.get $i) (global.get $n)))
        (local.set $a (i32.add (i32.const 2128) (i32.shl (local.get $i) (i32.const 3))))
        (local.set $hi (i32.load (local.get $a)))
        (local.set $e (i32.and (i32.shr_u (local.get $hi) (i32.const 20)) (i32.const 2047)))
        (local.set $m (i64.or
          (i64.shl (i64.extend_i32_u (i32.and (local.get $hi) (i32.const 1048575))) (i64.const 32))
          (i64.load32_u (i32.add (local.get $a) (i32.const 4)))))
        (if (i32.eqz (local.get $e))
          (then (call $acc_add (local.get $m) (i32.const 0)))
          (else (call $acc_add (i64.or (local.get $m) (i64.const 4503599627370496))
                               (i32.sub (local.get $e) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l3)))
    (global.set $obs (call $band (i32.const 1184) (i32.const 1200)))
    (global.set $esc (call $band (i32.const 1216) (i32.const 1232))))

  ;; dst = v, ten limbs.
  (func $bn_set (param $dst i32) (param $v i64)
    (i64.store (local.get $dst) (local.get $v))
    (i64.store (i32.add (local.get $dst) (i32.const 8)) (i64.const 0))
    (i64.store (i32.add (local.get $dst) (i32.const 16)) (i64.const 0))
    (i64.store (i32.add (local.get $dst) (i32.const 24)) (i64.const 0))
    (i64.store (i32.add (local.get $dst) (i32.const 32)) (i64.const 0)))

  ;; dst = src * k over ten limbs; dst and src distinct. A lost carry sets $ovf.
  (func $mulk (param $dst i32) (param $src i32) (param $k i64)
    (local $i i32) (local $klo i64) (local $khi i64) (local $carry i64) (local $t i64) (local $a i32)
    (local.set $klo (i64.and (local.get $k) (i64.const 4294967295)))
    (local.set $khi (i64.shr_u (local.get $k) (i64.const 32)))
    (block $d
      (loop $l
        (br_if $d (i32.ge_u (local.get $i) (i32.const 10)))
        (local.set $t (i64.add
          (i64.mul (i64.load32_u (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2)))) (local.get $klo))
          (local.get $carry)))
        (i64.store32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2))) (local.get $t))
        (local.set $carry (i64.shr_u (local.get $t) (i64.const 32)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (if (i64.ne (local.get $carry) (i64.const 0)) (then (global.set $ovf (i32.const 1))))
    (local.set $carry (i64.const 0))
    (local.set $i (i32.const 0))
    (block $d2
      (loop $l2
        (br_if $d2 (i32.ge_u (local.get $i) (i32.const 9)))
        (local.set $a (i32.add (local.get $dst) (i32.shl (i32.add (local.get $i) (i32.const 1)) (i32.const 2))))
        (local.set $t (i64.add
          (i64.add
            (i64.mul (i64.load32_u (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2)))) (local.get $khi))
            (i64.load32_u (local.get $a)))
          (local.get $carry)))
        (i64.store32 (local.get $a) (local.get $t))
        (local.set $carry (i64.shr_u (local.get $t) (i64.const 32)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l2)))
    (if (i64.ne (local.get $carry) (i64.const 0)) (then (global.set $ovf (i32.const 1))))
    (if (i32.and (i32.ne (i32.load (i32.add (local.get $src) (i32.const 36))) (i32.const 0))
                 (i64.ne (local.get $khi) (i64.const 0)))
      (then (global.set $ovf (i32.const 1)))))

  ;; Ten-limb compare: 0 a<b, 1 equal, 2 a>b.
  (func $bn_cmp (param $a i32) (param $b i32) (result i32)
    (local $i i32) (local $x i32) (local $y i32)
    (local.set $i (i32.const 10))
    (block $d
      (loop $l
        (br_if $d (i32.eqz (local.get $i)))
        (local.set $i (i32.sub (local.get $i) (i32.const 1)))
        (local.set $x (i32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $y (i32.load (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2)))))
        (if (i32.gt_u (local.get $x) (local.get $y)) (then (return (i32.const 2))))
        (if (i32.lt_u (local.get $x) (local.get $y)) (then (return (i32.const 0))))
        (br $l)))
    (i32.const 1))

  ;; coherence = 5*Rd*Rr*Ro / (Dd*Dr*Do*(5+u)) against 19/20 -+ 2^-40:
  ;;   below iff 25*2^40*Rd*Rr*Ro < (19*2^38 - 5) * Dd*Dr*Do*(5+u) ; above iff > with (19*2^38 + 5).
  (func $coherence (result i32)
    (call $bn_set (i32.const 2368) (i64.const 27487790694400))
    (call $mulk (i32.const 2432) (i32.const 2368) (i64.load (i32.const 2048)))
    (call $mulk (i32.const 2368) (i32.const 2432) (i64.load (i32.const 2064)))
    (call $mulk (i32.const 2432) (i32.const 2368) (i64.load (i32.const 2080)))
    (call $bn_set (i32.const 2368) (i64.load (i32.const 2056)))
    (call $mulk (i32.const 2496) (i32.const 2368) (i64.load (i32.const 2072)))
    (call $mulk (i32.const 2368) (i32.const 2496) (i64.load (i32.const 2088)))
    (call $mulk (i32.const 2496) (i32.const 2368) (i64.add (i64.load (i32.const 2096)) (i64.const 5)))
    (call $mulk (i32.const 2368) (i32.const 2496) (i64.const 5222680231931))
    (if (i32.eqz (call $bn_cmp (i32.const 2432) (i32.const 2368))) (then (return (i32.const 0))))
    (call $mulk (i32.const 2560) (i32.const 2496) (i64.const 5222680231941))
    (if (i32.eq (call $bn_cmp (i32.const 2432) (i32.const 2560)) (i32.const 2)) (then (return (i32.const 2))))
    (i32.const 1))

  ;; ================= decision: rule chain =================
  (func $decide_rule (result i32)
    (if (i32.ge_u (global.get $drift) (i32.const 7)) (then (return (i32.const 0))))
    (if (i32.eq (global.get $hb) (i32.const 2)) (then (return (i32.const 1))))
    (if (i32.eq (global.get $esc) (i32.const 2)) (then (return (i32.const 2))))
    (if (i32.or (i32.eq (global.get $hb) (i32.const 1)) (i32.eq (global.get $esc) (i32.const 1)))
      (then (return (i32.const 3))))
    (if (i32.ge_u (global.get $drift) (i32.const 4))
      (then (return (select (i32.const 4) (i32.const 5) (global.get $U)))))
    (if (i32.eq (global.get $obs) (i32.const 2)) (then (return (i32.const 6))))
    (if (i32.eq (global.get $obs) (i32.const 1)) (then (return (i32.const 7))))
    (if (i32.eq (global.get $coh) (i32.const 1)) (then (return (i32.const 8))))
    (if (i32.eqz (global.get $coh)) (then (return (i32.const 9))))
    (i32.const 10))

  ;; ================= decision: int8 circuit =================
  ;; One layer: acc = b + sum W*x ; y = clamp(acc >> shift, 0, 127). W, b signed bytes; x unsigned bytes.
  (func $layer (param $wp i32) (param $bp i32) (param $nin i32) (param $nout i32) (param $shift i32)
               (param $xin i32) (param $xout i32)
    (local $j i32) (local $i i32) (local $acc i32)
    (block $odone
      (loop $onext
        (br_if $odone (i32.ge_u (local.get $j) (local.get $nout)))
        (local.set $acc (i32.load8_s (i32.add (local.get $bp) (local.get $j))))
        (local.set $i (i32.const 0))
        (block $idone
          (loop $inext
            (br_if $idone (i32.ge_u (local.get $i) (local.get $nin)))
            (local.set $acc (i32.add (local.get $acc)
              (i32.mul (i32.load8_s (local.get $wp)) (i32.load8_u (i32.add (local.get $xin) (local.get $i))))))
            (local.set $wp (i32.add (local.get $wp) (i32.const 1)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $inext)))
        (local.set $acc (i32.shr_s (local.get $acc) (local.get $shift)))
        (if (i32.lt_s (local.get $acc) (i32.const 0)) (then (local.set $acc (i32.const 0))))
        (if (i32.gt_s (local.get $acc) (i32.const 127)) (then (local.set $acc (i32.const 127))))
        (i32.store8 (i32.add (local.get $xout) (local.get $j)) (local.get $acc))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $onext))))

  ;; Returns the index of the single output at 127, or 255 if the output is not one-hot.
  (func $decide_net (result i32)
    (local $i i32) (local $v i32) (local $hot i32) (local $nz i32) (local $k i32)
    (i64.store (i32.const 2624) (i64.const 0))
    (i64.store (i32.const 2632) (i64.const 0))
    (i32.store8 (i32.const 2624) (i32.mul (global.get $h) (i32.const 127)))
    (i32.store8 (i32.const 2625) (i32.mul (global.get $U) (i32.const 127)))
    (i32.store8 (i32.const 2626) (i32.mul (global.get $w) (i32.const 127)))
    (i32.store8 (i32.const 2627) (i32.mul (global.get $r) (i32.const 127)))
    (i32.store8 (i32.add (i32.const 2628) (global.get $hb)) (i32.const 127))
    (i32.store8 (i32.add (i32.const 2631) (global.get $esc)) (i32.const 127))
    (i32.store8 (i32.add (i32.const 2634) (global.get $obs)) (i32.const 127))
    (i32.store8 (i32.add (i32.const 2637) (global.get $coh)) (i32.const 127))
    (call $layer (i32.const 1280) (i32.const 1536) (i32.const 16) (i32.const 16)
                 (i32.load8_u (i32.const 1955)) (i32.const 2624) (i32.const 2656))
    (call $layer (i32.const 1552) (i32.const 1776) (i32.const 16) (i32.const 14)
                 (i32.load8_u (i32.const 1956)) (i32.const 2656) (i32.const 2688))
    (call $layer (i32.const 1790) (i32.const 1944) (i32.const 14) (i32.const 11)
                 (i32.load8_u (i32.const 1957)) (i32.const 2688) (i32.const 2720))
    (local.set $k (i32.const 255))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 11)))
        (local.set $v (i32.load8_u (i32.add (i32.const 2720) (local.get $i))))
        (if (local.get $v) (then (local.set $nz (i32.add (local.get $nz) (i32.const 1)))))
        (if (i32.eq (local.get $v) (i32.const 127))
          (then (local.set $hot (i32.add (local.get $hot) (i32.const 1))) (local.set $k (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (if (result i32) (i32.and (i32.eq (local.get $hot) (i32.const 1)) (i32.eq (local.get $nz) (i32.const 1)))
      (then (local.get $k))
      (else (i32.const 255))))

  ;; ================= result assembly =================
  (func $set_outcome (param $k i32)
    (global.set $reason (local.get $k))
    (global.set $focus (i32.load8_u (i32.add (i32.const 1152) (local.get $k))))
    (global.set $status (select (i32.const 2) (i32.const 1) (i32.eqz (global.get $focus)))))

  (func $set_both
    (global.set $rule (call $decide_rule))
    (global.set $net (call $decide_net))
    (if (i32.eq (global.get $rule) (global.get $net))
      (then (call $set_outcome (global.get $rule)))
      (else
        (global.set $reason (i32.const 11))
        (global.set $focus (i32.const 0))
        (global.set $status (i32.const 3)))))

  ;; Ops 1 and 3: the full input.
  (func $run_full (param $op i32)
    (local $i i32)
    (if (i32.or
          (i32.or (i64.eqz (i64.load (i32.const 2056)))
                  (i32.or (i64.eqz (i64.load (i32.const 2072))) (i64.eqz (i64.load (i32.const 2088)))))
          (i32.or (i64.gt_u (i64.load (i32.const 2048)) (i64.load (i32.const 2056)))
                  (i32.or (i64.gt_u (i64.load (i32.const 2064)) (i64.load (i32.const 2072)))
                          (i64.gt_u (i64.load (i32.const 2080)) (i64.load (i32.const 2088))))))
      (then (call $seterr (i32.const 2)) (return)))
    (if (i32.eqz (call $finite_nonneg (global.get $hbhi))) (then (call $seterr (i32.const 2)) (return)))
    (block $d
      (loop $l
        (br_if $d (i32.ge_u (local.get $i) (global.get $n)))
        (if (i32.eqz (call $finite_nonneg (i32.load (i32.add (i32.const 2128) (i32.shl (local.get $i) (i32.const 3))))))
          (then (call $seterr (i32.const 2)) (return)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (global.set $U (i64.ne (i64.load (i32.const 2096)) (i64.const 0)))
    (global.set $w (i64.ge_u (i64.load (i32.const 2104)) (i64.const 2)))
    (global.set $r (i64.lt_u (i64.load (i32.const 2112)) (i64.const 3)))
    (global.set $drift (i32.add
      (i32.add (i32.shl (global.get $h) (i32.const 2)) (i32.shl (global.get $U) (i32.const 2)))
      (i32.add (i32.shl (global.get $w) (i32.const 1)) (global.get $r))))
    (global.set $hb (call $heartbeat))
    (call $surprise)
    (global.set $coh (call $coherence))
    (if (global.get $ovf) (then (call $seterr (i32.const 5)) (return)))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then (call $set_outcome (call $decide_rule)) (call $emit (i32.const 1) (i32.const 0)))
      (else (call $set_both) (call $emit (i32.const 1) (i32.const 1)))))

  ;; Ops 2 and 4: the decision inputs.
  (func $run_dec (param $op i32)
    (global.set $drift (i32.add
      (i32.add (i32.shl (global.get $h) (i32.const 2)) (i32.shl (global.get $U) (i32.const 2)))
      (i32.add (i32.shl (global.get $w) (i32.const 1)) (global.get $r))))
    (if (i32.eq (local.get $op) (i32.const 2))
      (then
        (global.set $net (call $decide_net))
        (if (i32.eq (global.get $net) (i32.const 255)) (then (call $seterr (i32.const 6)) (return)))
        (call $set_outcome (global.get $net))
        (call $emit (i32.const 0) (i32.const 2)))
      (else (call $set_both) (call $emit (i32.const 0) (i32.const 1)))))

  ;; ================= ABI =================
  (func (export "mv_abi_version") (result i32) (i32.const 1))

  (func (export "mv_alloc") (param $len i32) (result i32)
    (if (result i32) (i32.le_u (local.get $len) (i32.const 4096))
      (then (i32.const 4096))
      (else (i32.const 0))))

  (func (export "mv_run") (param $ptr i32) (param $len i32) (result i64)
    (local $form i32) (local $op i32)
    (global.set $err (i32.const 0))
    (global.set $ovf (i32.const 0))
    (global.set $seqok (i32.const 0))
    (global.set $seq (i64.const 0))
    (global.set $o (i32.const 3072))
    (if (i32.or (i32.ne (local.get $ptr) (i32.const 4096)) (i32.gt_u (local.get $len) (i32.const 4096)))
      (then (call $fail))
      (else
        (global.set $p (local.get $ptr))
        (global.set $end (i32.add (local.get $ptr) (local.get $len)))
        (call $lit (i32.const 64))
        (if (call $try (i32.const 96))
          (then (local.set $form (i32.const 1)) (call $parse_full))
          (else
            (if (call $try (i32.const 256))
              (then (local.set $form (i32.const 2)) (call $parse_dec))
              (else (call $fail)))))
        (call $lit (i32.const 224))
        (if (call $try (i32.const 352)) (then (local.set $op (i32.const 1)))
          (else (if (call $try (i32.const 384)) (then (local.set $op (i32.const 2)))
            (else (if (call $try (i32.const 416)) (then (local.set $op (i32.const 3)))
              (else (if (call $try (i32.const 448)) (then (local.set $op (i32.const 4)))
                (else (call $seterr (i32.const 3))))))))))
        (call $lit (i32.const 320))
        (global.set $seq (call $uint))
        (call $eat (i32.const 125))
        (if (i32.ne (global.get $p) (global.get $end)) (then (call $fail)))
        (if (i32.eqz (global.get $err))
          (then
            (global.set $seqok (i32.const 1))
            ;; ops 1 and 3 take the full input (form 1); ops 2 and 4 take the decision input (form 2)
            (if (i32.ne (local.get $form) (i32.sub (i32.const 2) (i32.and (local.get $op) (i32.const 1))))
              (then (call $seterr (i32.const 3))))))
        (if (i32.eqz (global.get $err))
          (then
            (if (i32.eq (local.get $form) (i32.const 1))
              (then (call $run_full (local.get $op)))
              (else (call $run_dec (local.get $op))))))))
    (if (global.get $err) (then (call $refuse)))
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.sub (global.get $o) (i32.const 3072))) (i64.const 32))
      (i64.const 3072))))
