;; kyber-cpu.wat : the Kyber Kernel weight CPU as one hand-written integer cell (Microverse ABI v1
;; guest). i32 and i64 only. No imports. Twelve pages of linear storage, fixed. An instrument with no authority.
;;
;; The machine is the ISA exactly: four-bit registers a and b, a three-bit pc, a halt bit, eight ROM words of ten bits.
;;   state  (packed)  a[0:4] | b[4:8] | pc[8:11] | halted[11]
;;   word   (packed)  op[0:3] | imm[3:7] | target[7:10]
;;   op 0 INC0 a=a+1   1 ADD01 a=a+b   2 XOR01 a=a^b   3 DEC1 b=b-1   4 JNZ1 if b!=0 pc=target
;;   op 5 MOVI0 a=imm  6 HALT (pc stays, halted=1)     7 SWAP a<->b   (all modulo 16; pc otherwise pc+1 modulo 8)
;; A halted machine stays exactly where it is.
;;
;; The transition is the affine/ReLU circuit of the 9,010-byte lowering (emit_weight_cpu.py), re-expressed here with
;; loops instead of straight-line code: relu(x) = max(x, 0), and(x, y) = relu(x + y - 1), a ripple adder of relus, and
;; every multiplexer an and() against a one-hot selector. Packed values are decoded into bits and one-hots at ingress;
;; past that there is no opcode switch and no indirect branch: the ROM word is fetched by the one-hot pc and every
;; candidate next value is computed and selected by weights 0/1/-1/2.
;;
;; Ops (canonical JSON in and out, keys in UTF-8 byte order):
;;   cpu.step    {rom, state}                          -> {state}
;;   cpu.run     {checkpointEvery?, rom, state, steps}  -> {checkpoints?, halted, state, stepsTaken}
;;   cpu.resume  {checkpoint}                          -> {halted, state, stepsTaken}
;; rom is exactly eight integers 0..1023; state is {a 0..15, b 0..15, halted 0..1, pc 0..7}; steps is 0..4096 (the
;; machine has 4,096 states, so a run that has not halted by then never will); checkpointEvery is 1..4096.
;; A checkpoint is {check, rom, state, steps, stepsTaken}; `check` is a 32-bit mix of the other fields under a fixed
;; constant. It catches a changed or hand-made checkpoint; it is a checksum, not authentication.
;;
;; Storage map (bytes):
;;   64..1151     text literals, NUL-terminated, one per 32-byte slot; refusal codes at 896 + 32 * code
;;   1152         ONE = [1,0,0,0] and 1168 ALL1 = [1,1,1,1], as i32
;;   2048         ROM, eight i32
;;   2112..2575   circuit wires, i32 each: A 2112, B 2128, P 2144, OPS 2176, IMM 2208, TG 2224,
;;                candidates CA 2256 (8 x 4), CB 2384 (8 x 4), next NA 2512, NB 2528, NP 2544
;;   2600..2623   decimal digit scratch
;;   4096..8191   request
;;   65536..      response (at most 4,097 checkpoints of at most 145 bytes each)
(module
  (memory (export "memory") 12 12)

  (global $p (mut i32) (i32.const 0))       ;; parse cursor
  (global $end (mut i32) (i32.const 0))     ;; end of request
  (global $err (mut i32) (i32.const 0))     ;; 0 ok, else refusal code number (first wins)
  (global $bad (mut i32) (i32.const 0))     ;; the request text itself did not parse
  (global $seq (mut i64) (i64.const 0))
  (global $o (mut i32) (i32.const 65536))   ;; response cursor
  (global $h (mut i32) (i32.const 0))       ;; halt bit of the transition being computed
  (global $state (mut i32) (i32.const 0))
  (global $steps (mut i32) (i32.const 0))
  (global $taken (mut i32) (i32.const 0))
  (global $every (mut i32) (i32.const 0))
  (global $check (mut i64) (i64.const 0))

  ;; ---- request literals ----
  (data (i32.const 64) "{\22abi\22:1,\22input\22:{")
  (data (i32.const 96) "\22checkpoint\22:")
  (data (i32.const 128) "\22checkpointEvery\22:")
  (data (i32.const 160) "\22rom\22:")
  (data (i32.const 192) ",\22rom\22:")
  (data (i32.const 224) ",\22state\22:")
  (data (i32.const 256) ",\22steps\22:")
  (data (i32.const 288) "{\22a\22:")
  (data (i32.const 320) ",\22b\22:")
  (data (i32.const 352) ",\22halted\22:")
  (data (i32.const 384) ",\22pc\22:")
  (data (i32.const 416) "{\22check\22:")
  (data (i32.const 448) ",\22stepsTaken\22:")
  (data (i32.const 480) "},\22op\22:\22")
  (data (i32.const 512) "cpu.resume\22")
  (data (i32.const 544) "cpu.run\22")
  (data (i32.const 576) "cpu.step\22")
  (data (i32.const 608) ",\22seq\22:")
  ;; ---- response literals ----
  (data (i32.const 640) "{\22abi\22:1,\22result\22:{")
  (data (i32.const 672) "\22checkpoints\22:[")
  (data (i32.const 704) "\22halted\22:")
  (data (i32.const 736) "\22state\22:")
  (data (i32.const 768) "},\22seq\22:")
  (data (i32.const 800) ",\22status\22:\22ok\22}")
  (data (i32.const 832) "{\22abi\22:1,\22code\22:\22")
  (data (i32.const 864) "\22,\22seq\22:")
  (data (i32.const 896) ",\22status\22:\22refused\22}")
  ;; ---- refusal codes: address = 896 + 32 * code number ----
  (data (i32.const 928) "MALFORMED")
  (data (i32.const 960) "OP_UNKNOWN")
  (data (i32.const 992) "INPUT_SHAPE")
  (data (i32.const 1024) "ROM_INVALID")
  (data (i32.const 1056) "STATE_INVALID")
  (data (i32.const 1088) "STEPS_INVALID")
  (data (i32.const 1120) "CHECKPOINT_INVALID")
  ;; ---- adder constants ----
  (data (i32.const 1152) "\01\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\01\00\00\00\01\00\00\00\01\00\00\00")

  ;; ================= parsing =================
  (func $seterr (param $c i32)
    (if (i32.eqz (global.get $err)) (then (global.set $err (local.get $c)))))

  (func $fail
    (global.set $bad (i32.const 1))
    (call $seterr (i32.const 1)))

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

  ;; An integer in 0..$max; above it is refusal $code (the parse goes on).
  (func $num (param $max i64) (param $code i32) (result i32)
    (local $v i64)
    (local.set $v (call $uint))
    (if (i64.gt_u (local.get $v) (local.get $max)) (then (call $seterr (local.get $code)) (return (i32.const 0))))
    (i32.wrap_i64 (local.get $v)))

  ;; `[` exactly eight words 0..1023 `]` into ROM. Any other length or value is ROM_INVALID.
  (func $parse_rom
    (local $i i32) (local $v i32)
    (call $eat (i32.const 91))
    (if (i32.eq (call $peek) (i32.const 93))
      (then (call $eat (i32.const 93)) (call $seterr (i32.const 4)) (return)))
    (block $done
      (loop $next
        (br_if $done (global.get $bad))
        (local.set $v (call $num (i64.const 1023) (i32.const 4)))
        (if (i32.lt_u (local.get $i) (i32.const 8))
          (then (i32.store (i32.add (i32.const 2048) (i32.shl (local.get $i) (i32.const 2))) (local.get $v))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (if (i32.eq (call $peek) (i32.const 44))
          (then (call $eat (i32.const 44)) (br $next)))))
    (call $eat (i32.const 93))
    (if (i32.ne (local.get $i) (i32.const 8)) (then (call $seterr (i32.const 4)))))

  ;; {"a":..,"b":..,"halted":..,"pc":..} -> packed state. Out of range is STATE_INVALID.
  (func $parse_state (result i32)
    (local $a i32) (local $b i32) (local $h i32) (local $pc i32)
    (call $lit (i32.const 288)) (local.set $a (call $num (i64.const 15) (i32.const 5)))
    (call $lit (i32.const 320)) (local.set $b (call $num (i64.const 15) (i32.const 5)))
    (call $lit (i32.const 352)) (local.set $h (call $num (i64.const 1) (i32.const 5)))
    (call $lit (i32.const 384)) (local.set $pc (call $num (i64.const 7) (i32.const 5)))
    (call $eat (i32.const 125))
    (i32.or (i32.or (local.get $a) (i32.shl (local.get $b) (i32.const 4)))
            (i32.or (i32.shl (local.get $pc) (i32.const 8)) (i32.shl (local.get $h) (i32.const 11)))))

  ;; ================= the circuit =================
  (func $relu (param $x i32) (result i32)
    (select (local.get $x) (i32.const 0) (i32.gt_s (local.get $x) (i32.const 0))))

  (func $and (param $x i32) (param $y i32) (result i32)
    (call $relu (i32.sub (i32.add (local.get $x) (local.get $y)) (i32.const 1))))

  (func $w (param $a i32) (param $i i32) (result i32)
    (i32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2)))))

  (func $set (param $a i32) (param $i i32) (param $v i32)
    (i32.store (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))) (local.get $v)))

  (func $copy4 (param $src i32) (param $dst i32)
    (local $i i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (call $set (local.get $dst) (local.get $i) (call $w (local.get $src) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next))))

  ;; xor(x, y) = x + y - 2 and(x, y), per bit.
  (func $xor4 (param $x i32) (param $y i32) (param $dst i32)
    (local $i i32) (local $u i32) (local $v i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $u (call $w (local.get $x) (local.get $i)))
        (local.set $v (call $w (local.get $y) (local.get $i)))
        (call $set (local.get $dst) (local.get $i)
          (i32.sub (i32.add (local.get $u) (local.get $v)) (i32.shl (call $and (local.get $u) (local.get $v)) (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next))))

  ;; Four-bit ripple adder of relus: z = x + y + c ; out = z - 2 relu(z-1) + 2 relu(z-2) ; c = relu(z-1) - relu(z-2).
  (func $nib (param $x i32) (param $y i32) (param $dst i32)
    (local $i i32) (local $c i32) (local $z i32) (local $hi i32) (local $lo i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $z (i32.add (i32.add (call $w (local.get $x) (local.get $i)) (call $w (local.get $y) (local.get $i)))
                               (local.get $c)))
        (local.set $hi (call $relu (i32.sub (local.get $z) (i32.const 1))))
        (local.set $lo (call $relu (i32.sub (local.get $z) (i32.const 2))))
        (call $set (local.get $dst) (local.get $i)
          (i32.add (i32.sub (local.get $z) (i32.shl (local.get $hi) (i32.const 1))) (i32.shl (local.get $lo) (i32.const 1))))
        (local.set $c (i32.sub (local.get $hi) (local.get $lo)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next))))

  ;; Register multiplexer: out[i] = sum over ops of and(cand[op][i], OPS[op]) + and(prev[i], halt).
  (func $mux (param $cand i32) (param $prev i32) (param $dst i32)
    (local $i i32) (local $k i32) (local $sum i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $sum (call $and (call $w (local.get $prev) (local.get $i)) (global.get $h)))
        (local.set $k (i32.const 0))
        (block $kdone
          (loop $knext
            (br_if $kdone (i32.ge_u (local.get $k) (i32.const 8)))
            (local.set $sum (i32.add (local.get $sum)
              (call $and (call $w (i32.add (local.get $cand) (i32.shl (local.get $k) (i32.const 4))) (local.get $i))
                         (call $w (i32.const 2176) (local.get $k)))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $knext)))
        (call $set (local.get $dst) (local.get $i) (local.get $sum))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next))))

  ;; One transition of the packed state, through the circuit, against ROM at 2048.
  (func $step (param $s i32) (result i32)
    (local $i i32) (local $j i32) (local $sum i32) (local $word i32) (local $pc i32)
    (local $bs i32) (local $nz i32) (local $take i32) (local $stop i32) (local $adv i32) (local $out i32)
    ;; ingress: bits and one-hots
    (global.set $h (i32.and (i32.shr_u (local.get $s) (i32.const 11)) (i32.const 1)))
    (local.set $pc (i32.and (i32.shr_u (local.get $s) (i32.const 8)) (i32.const 7)))
    (block $d0
      (loop $l0
        (br_if $d0 (i32.ge_u (local.get $i) (i32.const 4)))
        (call $set (i32.const 2112) (local.get $i) (i32.and (i32.shr_u (local.get $s) (local.get $i)) (i32.const 1)))
        (call $set (i32.const 2128) (local.get $i)
          (i32.and (i32.shr_u (local.get $s) (i32.add (local.get $i) (i32.const 4))) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l0)))
    (local.set $j (i32.const 0))
    (block $d1
      (loop $l1
        (br_if $d1 (i32.ge_u (local.get $j) (i32.const 8)))
        (call $set (i32.const 2144) (local.get $j) (i32.eq (local.get $pc) (local.get $j)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $l1)))
    ;; fetch through the one-hot pc: opcode one-hot (masked by not-halted), immediate bits, target one-hot
    (local.set $i (i32.const 0))
    (block $d2
      (loop $l2
        (br_if $d2 (i32.ge_u (local.get $i) (i32.const 8)))
        (local.set $sum (i32.const 0))
        (local.set $j (i32.const 0))
        (block $d3
          (loop $l3
            (br_if $d3 (i32.ge_u (local.get $j) (i32.const 8)))
            (local.set $word (call $w (i32.const 2048) (local.get $j)))
            (local.set $sum (i32.add (local.get $sum)
              (call $and (call $w (i32.const 2144) (local.get $j))
                         (i32.eq (i32.and (local.get $word) (i32.const 7)) (local.get $i)))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $l3)))
        (call $set (i32.const 2176) (local.get $i)
          (call $and (i32.sub (i32.const 1) (global.get $h)) (local.get $sum)))
        (local.set $sum (i32.const 0))
        (local.set $j (i32.const 0))
        (block $d4
          (loop $l4
            (br_if $d4 (i32.ge_u (local.get $j) (i32.const 8)))
            (local.set $word (call $w (i32.const 2048) (local.get $j)))
            (local.set $sum (i32.add (local.get $sum)
              (call $and (call $w (i32.const 2144) (local.get $j))
                         (i32.eq (i32.shr_u (local.get $word) (i32.const 7)) (local.get $i)))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $l4)))
        (call $set (i32.const 2224) (local.get $i) (local.get $sum))
        (if (i32.lt_u (local.get $i) (i32.const 4))
          (then
            (local.set $sum (i32.const 0))
            (local.set $j (i32.const 0))
            (block $d5
              (loop $l5
                (br_if $d5 (i32.ge_u (local.get $j) (i32.const 8)))
                (local.set $word (call $w (i32.const 2048) (local.get $j)))
                (local.set $sum (i32.add (local.get $sum)
                  (call $and (call $w (i32.const 2144) (local.get $j))
                             (i32.and (i32.shr_u (local.get $word) (i32.add (local.get $i) (i32.const 3))) (i32.const 1)))))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $l5)))
            (call $set (i32.const 2208) (local.get $i) (local.get $sum))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l2)))
    ;; every candidate next value of a, then of b, one per opcode
    (call $nib (i32.const 2112) (i32.const 1152) (i32.const 2256))
    (call $nib (i32.const 2112) (i32.const 2128) (i32.const 2272))
    (call $xor4 (i32.const 2112) (i32.const 2128) (i32.const 2288))
    (call $copy4 (i32.const 2112) (i32.const 2304))
    (call $copy4 (i32.const 2112) (i32.const 2320))
    (call $copy4 (i32.const 2208) (i32.const 2336))
    (call $copy4 (i32.const 2112) (i32.const 2352))
    (call $copy4 (i32.const 2128) (i32.const 2368))
    (call $copy4 (i32.const 2128) (i32.const 2384))
    (call $copy4 (i32.const 2128) (i32.const 2400))
    (call $copy4 (i32.const 2128) (i32.const 2416))
    (call $nib (i32.const 2128) (i32.const 1168) (i32.const 2432))
    (call $copy4 (i32.const 2128) (i32.const 2448))
    (call $copy4 (i32.const 2128) (i32.const 2464))
    (call $copy4 (i32.const 2128) (i32.const 2480))
    (call $copy4 (i32.const 2112) (i32.const 2496))
    (call $mux (i32.const 2256) (i32.const 2112) (i32.const 2512))
    (call $mux (i32.const 2384) (i32.const 2128) (i32.const 2528))
    ;; pc: jump when JNZ1 and b != 0, stay when halting or halted, else advance
    (local.set $bs (i32.add (i32.add (call $w (i32.const 2128) (i32.const 0)) (call $w (i32.const 2128) (i32.const 1)))
                            (i32.add (call $w (i32.const 2128) (i32.const 2)) (call $w (i32.const 2128) (i32.const 3)))))
    (local.set $nz (i32.sub (call $relu (local.get $bs)) (call $relu (i32.sub (local.get $bs) (i32.const 1)))))
    (local.set $take (call $and (call $w (i32.const 2176) (i32.const 4)) (local.get $nz)))
    (local.set $stop (i32.add (global.get $h) (call $w (i32.const 2176) (i32.const 6))))
    (local.set $adv (i32.sub (i32.sub (i32.const 1) (local.get $take)) (local.get $stop)))
    (local.set $i (i32.const 0))
    (block $d6
      (loop $l6
        (br_if $d6 (i32.ge_u (local.get $i) (i32.const 8)))
        (call $set (i32.const 2544) (local.get $i)
          (i32.add
            (i32.add (call $and (call $w (i32.const 2224) (local.get $i)) (local.get $take))
                     (call $and (call $w (i32.const 2144) (local.get $i)) (local.get $stop)))
            (call $and (call $w (i32.const 2144) (i32.and (i32.add (local.get $i) (i32.const 7)) (i32.const 7)))
                       (local.get $adv))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l6)))
    ;; egress: pack
    (local.set $out (i32.shl (local.get $stop) (i32.const 11)))
    (local.set $i (i32.const 0))
    (block $d7
      (loop $l7
        (br_if $d7 (i32.ge_u (local.get $i) (i32.const 8)))
        (if (i32.lt_u (local.get $i) (i32.const 4))
          (then
            (local.set $out (i32.add (local.get $out)
              (i32.add (i32.shl (call $w (i32.const 2512) (local.get $i)) (local.get $i))
                       (i32.shl (call $w (i32.const 2528) (local.get $i)) (i32.add (local.get $i) (i32.const 4))))))))
        (local.set $out (i32.add (local.get $out)
          (i32.shl (i32.mul (local.get $i) (call $w (i32.const 2544) (local.get $i))) (i32.const 8))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l7)))
    (local.get $out))

  ;; ================= checkpoint check =================
  (func $mix (param $h i32) (param $x i32) (result i32)
    (i32.mul (i32.xor (local.get $h) (local.get $x)) (i32.const 16777619)))

  ;; 32-bit mix of ROM, packed state, steps and stepsTaken under the constant "KYBE"; a checksum, not a signature.
  (func $check_of (result i64)
    (local $h i32) (local $i i32)
    (local.set $h (i32.const 1264140869))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
        (local.set $h (call $mix (local.get $h) (call $w (i32.const 2048) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (local.set $h (call $mix (local.get $h) (global.get $state)))
    (local.set $h (call $mix (local.get $h) (global.get $steps)))
    (local.set $h (call $mix (local.get $h) (global.get $taken)))
    (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))))
    (local.set $h (i32.mul (local.get $h) (i32.const 0x85ebca6b)))
    (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 13))))
    (local.set $h (i32.mul (local.get $h) (i32.const 0xc2b2ae35)))
    (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))))
    (i64.extend_i32_u (local.get $h)))

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
    (local.set $q (i32.const 2624))
    (loop $next
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (i32.store8 (local.get $q)
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
      (br_if $next (i64.ne (local.get $v) (i64.const 0))))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $q) (i32.const 2624)))
        (call $putc (i32.load8_u (local.get $q)))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))
        (br $copy))))

  (func $puti (param $v i32) (call $putu (i64.extend_i32_u (local.get $v))))

  (func $emit_state (param $s i32)
    (call $puts (i32.const 288)) (call $puti (i32.and (local.get $s) (i32.const 15)))
    (call $puts (i32.const 320)) (call $puti (i32.and (i32.shr_u (local.get $s) (i32.const 4)) (i32.const 15)))
    (call $puts (i32.const 352)) (call $puti (i32.and (i32.shr_u (local.get $s) (i32.const 11)) (i32.const 1)))
    (call $puts (i32.const 384)) (call $puti (i32.and (i32.shr_u (local.get $s) (i32.const 8)) (i32.const 7)))
    (call $putc (i32.const 125)))

  (func $emit_rom
    (local $i i32)
    (call $putc (i32.const 91))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
        (if (local.get $i) (then (call $putc (i32.const 44))))
        (call $puti (call $w (i32.const 2048) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (call $putc (i32.const 93)))

  (func $emit_checkpoint
    (call $puts (i32.const 416)) (call $putu (call $check_of))
    (call $puts (i32.const 192)) (call $emit_rom)
    (call $puts (i32.const 224)) (call $emit_state (global.get $state))
    (call $puts (i32.const 256)) (call $puti (global.get $steps))
    (call $puts (i32.const 448)) (call $puti (global.get $taken))
    (call $putc (i32.const 125)))

  (func $refuse
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 832))
    (call $puts (i32.add (i32.const 896) (i32.shl (global.get $err) (i32.const 5))))
    (if (i32.eqz (global.get $bad))
      (then (call $puts (i32.const 864)) (call $putu (global.get $seq)))
      (else (call $putc (i32.const 34))))
    (call $puts (i32.const 896)))

  ;; ================= ops =================
  (func $op_step
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 640))
    (call $puts (i32.const 736)) (call $emit_state (call $step (global.get $state)))
    (call $puts (i32.const 768)) (call $putu (global.get $seq))
    (call $puts (i32.const 800)))

  ;; Run from ($state, $taken) until halted or $taken = $steps; with $k > 0, a checkpoint at every multiple of $k.
  (func $go (param $k i32)
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 640))
    (if (local.get $k) (then (call $puts (i32.const 672)) (call $emit_checkpoint)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (global.get $taken) (global.get $steps)))
        (br_if $done (i32.and (i32.shr_u (global.get $state) (i32.const 11)) (i32.const 1)))
        (global.set $state (call $step (global.get $state)))
        (global.set $taken (i32.add (global.get $taken) (i32.const 1)))
        (if (local.get $k)
          (then
            (if (i32.eqz (i32.rem_u (global.get $taken) (local.get $k)))
              (then (call $putc (i32.const 44)) (call $emit_checkpoint)))))
        (br $next)))
    (if (local.get $k) (then (call $putc (i32.const 93)) (call $putc (i32.const 44))))
    (call $puts (i32.const 704)) (call $puti (i32.and (i32.shr_u (global.get $state) (i32.const 11)) (i32.const 1)))
    (call $puts (i32.const 224)) (call $emit_state (global.get $state))
    (call $puts (i32.const 448)) (call $puti (global.get $taken))
    (call $puts (i32.const 768)) (call $putu (global.get $seq))
    (call $puts (i32.const 800)))

  ;; ================= ABI =================
  (func (export "mv_abi_version") (result i32) (i32.const 1))

  (func (export "mv_alloc") (param $len i32) (result i32)
    (if (result i32) (i32.le_u (local.get $len) (i32.const 4096))
      (then (i32.const 4096))
      (else (i32.const 0))))

  ;; form: 0 {rom,state}  1 {rom,state,steps}  2 {checkpointEvery,rom,state,steps}  3 {checkpoint}
  ;; op:   0 cpu.step     1 cpu.run           3 cpu.resume
  (func (export "mv_run") (param $ptr i32) (param $len i32) (result i64)
    (local $form i32) (local $op i32) (local $hasSteps i32) (local $v i64)
    (global.set $err (i32.const 0))
    (global.set $bad (i32.const 0))
    (global.set $seq (i64.const 0))
    (global.set $o (i32.const 65536))
    (global.set $state (i32.const 0))
    (global.set $steps (i32.const 0))
    (global.set $taken (i32.const 0))
    (global.set $every (i32.const 0))
    (global.set $check (i64.const 0))
    (if (i32.or (i32.ne (local.get $ptr) (i32.const 4096)) (i32.gt_u (local.get $len) (i32.const 4096)))
      (then (call $fail))
      (else
        (global.set $p (local.get $ptr))
        (global.set $end (i32.add (local.get $ptr) (local.get $len)))
        (call $lit (i32.const 64))
        (if (call $try (i32.const 96))
          (then
            (local.set $form (i32.const 3))
            (call $lit (i32.const 416))
            (local.set $v (call $uint))
            (if (i64.gt_u (local.get $v) (i64.const 4294967295)) (then (call $seterr (i32.const 7))))
            (global.set $check (local.get $v))
            (call $lit (i32.const 192)) (call $parse_rom)
            (call $lit (i32.const 224)) (global.set $state (call $parse_state))
            (call $lit (i32.const 256)) (global.set $steps (call $num (i64.const 4096) (i32.const 6)))
            (call $lit (i32.const 448)) (global.set $taken (call $num (i64.const 4096) (i32.const 7)))
            (call $eat (i32.const 125)))
          (else
            (if (call $try (i32.const 128))
              (then
                (local.set $form (i32.const 2))
                (global.set $every (call $num (i64.const 4096) (i32.const 6)))
                (if (i32.eqz (global.get $every)) (then (call $seterr (i32.const 6))))
                (call $lit (i32.const 192)))
              (else (call $lit (i32.const 160))))
            (call $parse_rom)
            (call $lit (i32.const 224)) (global.set $state (call $parse_state))
            (if (call $try (i32.const 256))
              (then
                (local.set $hasSteps (i32.const 1))
                (global.set $steps (call $num (i64.const 4096) (i32.const 6)))))
            (if (i32.eqz (local.get $hasSteps))
              (then (if (i32.eq (local.get $form) (i32.const 2)) (then (call $seterr (i32.const 3)))))
              (else (if (i32.eqz (local.get $form)) (then (local.set $form (i32.const 1))))))))
        (call $lit (i32.const 480))
        (if (call $try (i32.const 512)) (then (local.set $op (i32.const 3)))
          (else (if (call $try (i32.const 544)) (then (local.set $op (i32.const 1)))
            (else (if (call $try (i32.const 576)) (then (local.set $op (i32.const 0)))
              (else (call $seterr (i32.const 2))))))))
        (call $lit (i32.const 608))
        (global.set $seq (call $uint))
        (call $eat (i32.const 125))
        (if (i32.ne (global.get $p) (global.get $end)) (then (call $fail)))
        (if (i32.eqz (global.get $err))
          (then
            (if (i32.eq (local.get $op) (i32.const 0))
              (then (if (local.get $form) (then (call $seterr (i32.const 3))))))
            (if (i32.eq (local.get $op) (i32.const 1))
              (then (if (i32.eqz (i32.or (i32.eq (local.get $form) (i32.const 1)) (i32.eq (local.get $form) (i32.const 2))))
                (then (call $seterr (i32.const 3))))))
            (if (i32.eq (local.get $op) (i32.const 3))
              (then (if (i32.ne (local.get $form) (i32.const 3)) (then (call $seterr (i32.const 3))))))))
        ;; a checkpoint must be one this cell would have written: the check matches and stepsTaken <= steps
        (if (i32.and (i32.eqz (global.get $err)) (i32.eq (local.get $op) (i32.const 3)))
          (then
            (if (i32.or (i32.gt_u (global.get $taken) (global.get $steps))
                        (i64.ne (call $check_of) (global.get $check)))
              (then (call $seterr (i32.const 7))))))
        (if (i32.eqz (global.get $err))
          (then
            (if (i32.eqz (local.get $op))
              (then (call $op_step))
              (else (call $go (global.get $every))))))))
    (if (global.get $err) (then (call $refuse)))
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.sub (global.get $o) (i32.const 65536))) (i64.const 32))
      (i64.const 65536))))
