;; SPDX-License-Identifier: AGPL-3.0-or-later
;; Copyright (c) 2026 The Aukora authors
;; pentora-codec.wat : PENTORA as an exact instrument on her own geometry (the Kyber Kernel
;; report), one hand-written integer cell (Microverse ABI v1 guest). i32 and i64 only. No imports. 16 pages, fixed.
;; An instrument with no authority: it carries integers onto the 110 directions and back, and it checks itself.
;;
;; The exact algebra is done once at build time (server/pentora-codec.build.mjs, BigInt, from the pinned geometry
;; sha256 96b27c9b...8c61) and ships below as integer tables (base64, decoded on every call):
;;   A     the 880 x 72 evaluation matrix of the degree-five model over Q(phi), times 13,824 (all integers), sparse.
;;         Row 8n + m is component m (basis 1, sqrt2, sqrt3, sqrt6, sqrt5, sqrt10, sqrt15, sqrt30) of the value at
;;         node n; a packet component is an integer numerator over 13,824.
;;   L, D  per keep-set, an integer left inverse with one common denominator: L A_kept = D I (proved at build time and
;;         again by the tests). L is only an accelerator: the answer rests on A alone (see decode).
;;
;; Ops (canonical JSON in and out):
;;   pentora.encode {keep?, values}          -> {blocks, count, packets, profile, scale}
;;     values: 1..1728 integers in -32768..32767, in blocks of 72 (the last zero-padded; count says how many are real).
;;     packets[n][b] is the 8 integer components at node n (0..109) for block b. keep may only be "all".
;;   pentora.decode {count, keep, packets}  -> {blocks, keep, kept, rank, residual, values}
;;     keep "all": packets has all 110 nodes; keep "drop-0-9": nodes 10..109 only (100 entries), in order;
;;     keep "menger-80": the 80 Menger skeleton nodes (squared radius 2 or 3, dropping all 30 face-centres), in order.
;;     Per block: S = L y (128-bit). Every kept row must satisfy A S = D y exactly (else PENTORA_INCONSISTENT); every
;;     S must be D times an integer in -32768..32767 (else PENTORA_NOT_INTEGER); x = S / D is then checked again
;;     against every kept packet, A x = y, in plain i64 (else PENTORA_INCONSISTENT); padding past count must be zero
;;     (else PENTORA_SHAPE). A_kept has rank 72 (the build's certificate), so an x that passes A x = y is the only one,
;;     whatever L says: a wrong L can only refuse.
;;   pentora.info {}                         -> the geometry sha256, the keep-sets, D's bit lengths, the block size.
;; Refusals (closed): PENTORA_SHAPE (not exactly the shape above, a value or packet component out of range, a count
;; that does not fit the blocks), PENTORA_KEEP_UNSUPPORTED, PENTORA_INCONSISTENT, PENTORA_NOT_INTEGER; MALFORMED and
;; OP_UNKNOWN for the envelope. A refusal never carries values.
;;
;; Storage map (bytes):
;;   64..1151 literals (32-byte slots; refusal codes at 896 + 32 * code)   1152..1215 digit scratch
;;   4224 X i64[72]   4864 SH i64[72] (S high halves)   5504 SL i64[72] (S low halves)
;;   8192.. decoded tables ($T_* below)   126976 INFO text   131072.. table text (base64)
;;   229376..557055 request   557056..726015 packets i64[24 blocks][880 rows]   726016..732927 values i32[1728]
;;   737280.. response
(module
  (memory (export "memory") 16 16)

  (global $p (mut i32) (i32.const 0))       ;; parse cursor
  (global $end (mut i32) (i32.const 0))     ;; end of request
  (global $err (mut i32) (i32.const 0))     ;; 0 ok, else refusal code number (first wins)
  (global $bad (mut i32) (i32.const 0))     ;; the request text itself did not parse
  (global $inInput (mut i32) (i32.const 0)) ;; inside the input object: a parse failure there is PENTORA_SHAPE
  (global $seq (mut i64) (i64.const 0))
  (global $o (mut i32) (i32.const 737280))  ;; response cursor
  (global $keep (mut i32) (i32.const 0))    ;; 0 all, 1 drop-0-9, 2 menger-80, 3 unsupported
  (global $count (mut i32) (i32.const 0))   ;; values (encode) or the declared count (decode)
  (global $nb (mut i32) (i32.const 0))      ;; blocks
  (global $ph (mut i64) (i64.const 0))      ;; a 128-bit product: high
  (global $pl (mut i64) (i64.const 0))      ;;                    low (unsigned)
  (global $ah (mut i64) (i64.const 0))      ;; a 128-bit sum: high
  (global $al (mut i64) (i64.const 0))      ;;                low (unsigned)

  ;; ---- request literals ----
  (data (i32.const 64) "{\22abi\22:1,\22input\22:{")
  (data (i32.const 96) "\22count\22:")
  (data (i32.const 128) ",\22keep\22:\22")
  (data (i32.const 160) "\22keep\22:\22")
  (data (i32.const 192) ",\22packets\22:")
  (data (i32.const 224) "\22values\22:")
  (data (i32.const 256) ",\22values\22:")
  (data (i32.const 288) "},\22op\22:\22")
  (data (i32.const 320) "pentora.decode\22")
  (data (i32.const 352) "pentora.encode\22")
  (data (i32.const 384) "pentora.info\22")
  (data (i32.const 416) ",\22seq\22:")
  (data (i32.const 448) "all")
  (data (i32.const 480) "drop-0-9")
  ;; ---- response literals ----
  (data (i32.const 512) "{\22abi\22:1,\22result\22:")
  (data (i32.const 544) ",\22status\22:\22ok\22}")
  (data (i32.const 576) "{\22blocks\22:")
  (data (i32.const 608) ",\22count\22:")
  (data (i32.const 640) ",\22packets\22:[")
  (data (i32.const 672) "],\22profile\22:\22pentora110-qphi72\22")
  (data (i32.const 704) ",\22scale\22:13824}")
  (data (i32.const 736) "\22,\22kept\22:")
  (data (i32.const 768) ",\22rank\22:72,\22residual\22:\22exact\22")
  (data (i32.const 800) ",\22values\22:[")
  (data (i32.const 832) "{\22abi\22:1,\22code\22:\22")
  (data (i32.const 864) "\22,\22seq\22:")
  (data (i32.const 896) ",\22status\22:\22refused\22}")
  ;; ---- refusal codes: address = 896 + 32 * code number ----
  (data (i32.const 928) "MALFORMED")
  (data (i32.const 960) "OP_UNKNOWN")
  (data (i32.const 992) "PENTORA_SHAPE")
  (data (i32.const 1024) "PENTORA_KEEP_UNSUPPORTED")
  (data (i32.const 1056) "PENTORA_INCONSISTENT")
  (data (i32.const 1088) "PENTORA_NOT_INTEGER")
  (data (i32.const 1120) "menger-80")

  ;; ================= the tables =================
  (func $b64 (param $c i32) (result i32)
    (if (i32.lt_u (i32.sub (local.get $c) (i32.const 65)) (i32.const 26)) (then (return (i32.sub (local.get $c) (i32.const 65)))))
    (if (i32.lt_u (i32.sub (local.get $c) (i32.const 97)) (i32.const 26)) (then (return (i32.sub (local.get $c) (i32.const 71)))))
    (if (i32.lt_u (i32.sub (local.get $c) (i32.const 48)) (i32.const 10)) (then (return (i32.add (local.get $c) (i32.const 4)))))
    (select (i32.const 62) (i32.const 63) (i32.eq (local.get $c) (i32.const 43))))

  ;; Decode the base64 table text at 131072 into the binary tables at 8192.
  (func $tables
    (local $i i32) (local $o i32) (local $v i32)
    (local.set $o (i32.const 8192))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (global.get $T_TEXTLEN)))
        (local.set $v (i32.or
          (i32.or (i32.shl (call $b64 (i32.load8_u (i32.add (i32.const 131072) (local.get $i)))) (i32.const 18))
                  (i32.shl (call $b64 (i32.load8_u (i32.add (i32.const 131073) (local.get $i)))) (i32.const 12)))
          (i32.or (i32.shl (call $b64 (i32.load8_u (i32.add (i32.const 131074) (local.get $i)))) (i32.const 6))
                  (call $b64 (i32.load8_u (i32.add (i32.const 131075) (local.get $i)))))))
        (i32.store8 (local.get $o) (i32.shr_u (local.get $v) (i32.const 16)))
        (i32.store8 (i32.add (local.get $o) (i32.const 1)) (i32.shr_u (local.get $v) (i32.const 8)))
        (i32.store8 (i32.add (local.get $o) (i32.const 2)) (local.get $v))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (local.set $o (i32.add (local.get $o) (i32.const 3)))
        (br $next))))

  ;; Row r's entries are [rs r, rs (r + 1)).
  (func $rs (param $r i32) (result i32)
    (i32.load16_u (i32.add (global.get $T_ROWPTR) (i32.shl (local.get $r) (i32.const 1)))))

  (func $ecol (param $e i32) (result i32)
    (i32.load8_u (i32.add (global.get $T_ECOLS) (local.get $e))))

  (func $eval (param $e i32) (result i64)
    (i64.extend_i32_s (i32.load16_s (i32.add (global.get $T_EVALS) (i32.shl (local.get $e) (i32.const 1))))))

  (func $y (param $b i32) (param $r i32) (result i64)
    (i64.load (i32.add (i32.const 557056)
      (i32.shl (i32.add (i32.mul (local.get $b) (i32.const 880)) (local.get $r)) (i32.const 3)))))

  (func $val (param $slot i32) (result i64)
    (i64.extend_i32_s (i32.load (i32.add (i32.const 726016) (i32.shl (local.get $slot) (i32.const 2))))))

  (func $kept_count (result i32)
    (select (i32.const 110)
      (select (i32.const 100) (i32.const 80) (i32.eq (global.get $keep) (i32.const 1)))
      (i32.eqz (global.get $keep))))

  (func $kept_node (param $k i32) (result i32)
    (if (result i32) (i32.eqz (global.get $keep))
      (then (local.get $k))
      (else
        (if (result i32) (i32.eq (global.get $keep) (i32.const 1))
          (then (i32.add (i32.const 10) (local.get $k)))
          (else (i32.load8_u (i32.add (global.get $T_MENGER) (local.get $k))))))))

  ;; ================= parsing =================
  (func $seterr (param $c i32)
    (if (i32.eqz (global.get $err)) (then (global.set $err (local.get $c)))))

  (func $fail
    (global.set $bad (i32.const 1))
    (call $seterr (select (i32.const 3) (i32.const 1) (global.get $inInput))))

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

  ;; Canonical signed decimal: an optional '-' before a canonical unsigned one; "-0" is not canonical.
  (func $sint (result i64)
    (local $v i64)
    (if (i32.eq (call $peek) (i32.const 45))
      (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (local.set $v (call $uint))
        (if (i64.eqz (local.get $v)) (then (call $fail)))
        (return (i64.sub (i64.const 0) (local.get $v)))))
    (call $uint))

  (func $same (param $a i32) (param $b i32) (param $n i32) (result i32)
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $n)))
        (if (i32.ne (i32.load8_u (local.get $a)) (i32.load8_u (local.get $b))) (then (return (i32.const 0))))
        (local.set $a (i32.add (local.get $a) (i32.const 1)))
        (local.set $b (i32.add (local.get $b) (i32.const 1)))
        (local.set $n (i32.sub (local.get $n) (i32.const 1)))
        (br $next)))
    (i32.const 1))

  ;; After `"keep":"`: the string up to its closing quote. "all" -> 0, "drop-0-9" -> 1, "menger-80" -> 2, anything else -> 3 (refused).
  (func $parse_keep
    (local $q i32) (local $n i32) (local $c i32) (local $esc i32)
    (local.set $q (global.get $p))
    (block $done
      (loop $next
        (if (i32.ge_u (global.get $p) (global.get $end)) (then (call $fail) (return)))
        (local.set $c (i32.load8_u (global.get $p)))
        (br_if $done (i32.eq (local.get $c) (i32.const 34)))
        (if (i32.eq (local.get $c) (i32.const 92))
          (then (local.set $esc (i32.const 1)) (global.set $p (i32.add (global.get $p) (i32.const 1)))))
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $next)))
    (local.set $n (i32.sub (global.get $p) (local.get $q)))
    (global.set $keep (i32.const 3))
    (if (i32.eqz (local.get $esc))
      (then
        (if (i32.eq (local.get $n) (i32.const 3))
          (then (if (call $same (local.get $q) (i32.const 448) (i32.const 3)) (then (global.set $keep (i32.const 0))))))
        (if (i32.eq (local.get $n) (i32.const 8))
          (then (if (call $same (local.get $q) (i32.const 480) (i32.const 8)) (then (global.set $keep (i32.const 1))))))
        (if (i32.eq (local.get $n) (i32.const 9))
          (then (if (call $same (local.get $q) (i32.const 1120) (i32.const 9)) (then (global.set $keep (i32.const 2))))))))
    (if (i32.eq (global.get $keep) (i32.const 3)) (then (call $seterr (i32.const 4))))
    (call $eat (i32.const 34)))

  ;; `[` 1..1728 integers in -32768..32767 `]` into the values (i32). Out of range or too many is PENTORA_SHAPE.
  (func $parse_values
    (local $v i64) (local $n i32)
    (call $eat (i32.const 91))
    (if (i32.eq (call $peek) (i32.const 93))
      (then (call $eat (i32.const 93)) (call $seterr (i32.const 3)) (return)))
    (block $done
      (loop $next
        (br_if $done (global.get $bad))
        (local.set $v (call $sint))
        (if (i32.or (i64.lt_s (local.get $v) (i64.const -32768)) (i64.gt_s (local.get $v) (i64.const 32767)))
          (then (call $seterr (i32.const 3))))
        (if (i32.lt_u (local.get $n) (i32.const 1728))
          (then (i32.store (i32.add (i32.const 726016) (i32.shl (local.get $n) (i32.const 2))) (i32.wrap_i64 (local.get $v))))
          (else (call $seterr (i32.const 3))))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (if (i32.eq (call $peek) (i32.const 44))
          (then (call $eat (i32.const 44)) (br $next)))))
    (call $eat (i32.const 93))
    (global.set $count (local.get $n)))

  ;; `[` nodes `]`, a node `[` blocks `]`, a block `[` exactly eight integers `]`. With keep 0, 1 or 2 the node count must
  ;; be the keep-set's (110, 100 or 80) and component m of kept node k, block b is stored at packets[b][8 * kept_node(k) + m];
  ;; every node must carry the same number of blocks, 1..24; every component must be within PACKET_MAX.
  (func $parse_packets
    (local $store i32) (local $want i32) (local $k i32) (local $nd i32) (local $b i32) (local $m i32)
    (local $v i64) (local $max i64)
    (local.set $store (i32.lt_u (global.get $keep) (i32.const 3)))
    (if (local.get $store) (then (local.set $want (call $kept_count))))
    (local.set $max (i64.load (global.get $T_PMAX)))
    (global.set $nb (i32.const -1))
    (call $eat (i32.const 91))
    (if (i32.ne (call $peek) (i32.const 93))
      (then
        (block $nodes
          (loop $node
            (br_if $nodes (global.get $bad))
            (if (i32.and (local.get $store) (i32.lt_u (local.get $k) (local.get $want)))
              (then (local.set $nd (call $kept_node (local.get $k)))))
            (call $eat (i32.const 91))
            (local.set $b (i32.const 0))
            (if (i32.ne (call $peek) (i32.const 93))
              (then
                (block $blocks
                  (loop $block
                    (br_if $blocks (global.get $bad))
                    (call $eat (i32.const 91))
                    (local.set $m (i32.const 0))
                    (block $comps
                      (loop $comp
                        (br_if $comps (global.get $bad))
                        (local.set $v (call $sint))
                        (if (i32.or (i64.gt_s (local.get $v) (local.get $max))
                                    (i64.lt_s (local.get $v) (i64.sub (i64.const 0) (local.get $max))))
                          (then (call $seterr (i32.const 3))))
                        (if (i32.and (local.get $store)
                              (i32.and (i32.lt_u (local.get $k) (local.get $want))
                                (i32.and (i32.lt_u (local.get $b) (i32.const 24)) (i32.lt_u (local.get $m) (i32.const 8)))))
                          (then
                            (i64.store
                              (i32.add (i32.const 557056)
                                (i32.shl
                                  (i32.add (i32.mul (local.get $b) (i32.const 880))
                                    (i32.add (i32.shl (local.get $nd) (i32.const 3)) (local.get $m)))
                                  (i32.const 3)))
                              (local.get $v))))
                        (local.set $m (i32.add (local.get $m) (i32.const 1)))
                        (if (i32.eq (call $peek) (i32.const 44))
                          (then (call $eat (i32.const 44)) (br $comp)))))
                    (call $eat (i32.const 93))
                    (if (i32.ne (local.get $m) (i32.const 8)) (then (call $seterr (i32.const 3))))
                    (local.set $b (i32.add (local.get $b) (i32.const 1)))
                    (if (i32.eq (call $peek) (i32.const 44))
                      (then (call $eat (i32.const 44)) (br $block)))))))
            (call $eat (i32.const 93))
            (if (i32.lt_s (global.get $nb) (i32.const 0))
              (then (global.set $nb (local.get $b)))
              (else (if (i32.ne (global.get $nb) (local.get $b)) (then (call $seterr (i32.const 3))))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (if (i32.eq (call $peek) (i32.const 44))
              (then (call $eat (i32.const 44)) (br $node)))))))
    (call $eat (i32.const 93))
    (if (local.get $store)
      (then
        (if (i32.ne (local.get $k) (local.get $want)) (then (call $seterr (i32.const 3))))
        (if (i32.or (i32.lt_s (global.get $nb) (i32.const 1)) (i32.gt_s (global.get $nb) (i32.const 24)))
          (then (call $seterr (i32.const 3))))
        ;; the count must fit the blocks: (nb - 1) * 72 < count <= nb * 72
        (if (i32.or (i32.le_s (global.get $count) (i32.mul (i32.sub (global.get $nb) (i32.const 1)) (i32.const 72)))
                    (i32.gt_s (global.get $count) (i32.mul (global.get $nb) (i32.const 72))))
          (then (call $seterr (i32.const 3)))))))

  ;; ================= fixed-width arithmetic =================
  ;; Unsigned 64 x 64 -> 128 into ($ph, $pl), by 32-bit halves.
  (func $umul (param $a i64) (param $b i64)
    (local $a0 i64) (local $a1 i64) (local $b0 i64) (local $b1 i64)
    (local $p00 i64) (local $p01 i64) (local $p10 i64) (local $mid i64)
    (local.set $a0 (i64.and (local.get $a) (i64.const 0xffffffff)))
    (local.set $a1 (i64.shr_u (local.get $a) (i64.const 32)))
    (local.set $b0 (i64.and (local.get $b) (i64.const 0xffffffff)))
    (local.set $b1 (i64.shr_u (local.get $b) (i64.const 32)))
    (local.set $p00 (i64.mul (local.get $a0) (local.get $b0)))
    (local.set $p01 (i64.mul (local.get $a0) (local.get $b1)))
    (local.set $p10 (i64.mul (local.get $a1) (local.get $b0)))
    (local.set $mid (i64.add (i64.shr_u (local.get $p00) (i64.const 32))
      (i64.add (i64.and (local.get $p01) (i64.const 0xffffffff)) (i64.and (local.get $p10) (i64.const 0xffffffff)))))
    (global.set $pl (i64.or (i64.and (local.get $p00) (i64.const 0xffffffff)) (i64.shl (local.get $mid) (i64.const 32))))
    (global.set $ph (i64.add (i64.mul (local.get $a1) (local.get $b1))
      (i64.add (i64.add (i64.shr_u (local.get $p01) (i64.const 32)) (i64.shr_u (local.get $p10) (i64.const 32)))
               (i64.shr_u (local.get $mid) (i64.const 32))))))

  ;; ($ph, $pl) = -($ph, $pl)
  (func $neg128
    (global.set $ph (i64.sub (i64.sub (i64.const 0) (global.get $ph)) (i64.extend_i32_u (i64.ne (global.get $pl) (i64.const 0)))))
    (global.set $pl (i64.sub (i64.const 0) (global.get $pl))))

  (func $iabs (param $v i64) (result i64)
    (select (i64.sub (i64.const 0) (local.get $v)) (local.get $v) (i64.lt_s (local.get $v) (i64.const 0))))

  ;; Signed 64 x 64 -> 128 (both operands are far inside i64 by the build's bounds).
  (func $smul (param $a i64) (param $b i64)
    (call $umul (call $iabs (local.get $a)) (call $iabs (local.get $b)))
    (if (i32.xor (i64.lt_s (local.get $a) (i64.const 0)) (i64.lt_s (local.get $b) (i64.const 0)))
      (then (call $neg128))))

  ;; Signed 128 ($sh, $sl) x small signed $a -> ($ph, $pl). The true product fits 128 bits by the build's bounds.
  (func $smul_wide (param $sh i64) (param $sl i64) (param $a i64)
    (local $neg i32) (local $ua i64) (local $h i64)
    (local.set $neg (i32.xor (i64.lt_s (local.get $sh) (i64.const 0)) (i64.lt_s (local.get $a) (i64.const 0))))
    (if (i64.lt_s (local.get $sh) (i64.const 0))
      (then
        (local.set $sh (i64.sub (i64.sub (i64.const 0) (local.get $sh)) (i64.extend_i32_u (i64.ne (local.get $sl) (i64.const 0)))))
        (local.set $sl (i64.sub (i64.const 0) (local.get $sl)))))
    (local.set $ua (call $iabs (local.get $a)))
    (local.set $h (i64.mul (local.get $sh) (local.get $ua)))
    (call $umul (local.get $sl) (local.get $ua))
    (global.set $ph (i64.add (global.get $ph) (local.get $h)))
    (if (local.get $neg) (then (call $neg128))))

  ;; ($ah, $al) += ($ph, $pl)
  (func $acc
    (local $lo i64)
    (local.set $lo (i64.add (global.get $al) (global.get $pl)))
    (global.set $ah (i64.add (i64.add (global.get $ah) (global.get $ph))
      (i64.extend_i32_u (i64.lt_u (local.get $lo) (global.get $al)))))
    (global.set $al (local.get $lo)))

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
    (local.set $q (i32.const 1216))
    (loop $next
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (i32.store8 (local.get $q)
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
      (br_if $next (i64.ne (local.get $v) (i64.const 0))))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $q) (i32.const 1216)))
        (call $putc (i32.load8_u (local.get $q)))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))
        (br $copy))))

  (func $puts64 (param $v i64)
    (if (i64.lt_s (local.get $v) (i64.const 0))
      (then (call $putc (i32.const 45)) (call $putu (i64.sub (i64.const 0) (local.get $v))))
      (else (call $putu (local.get $v)))))

  (func $refuse
    (global.set $o (i32.const 737280))
    (call $puts (i32.const 832))
    (call $puts (i32.add (i32.const 896) (i32.shl (global.get $err) (i32.const 5))))
    (if (i32.eqz (global.get $bad))
      (then (call $puts (i32.const 864)) (call $putu (global.get $seq)))
      (else (call $putc (i32.const 34))))
    (call $puts (i32.const 896)))

  (func $ok_tail
    (call $puts (i32.const 416)) (call $putu (global.get $seq))
    (call $puts (i32.const 544)))

  ;; ================= ops =================
  (func $op_info
    (global.set $o (i32.const 737280))
    (call $puts (i32.const 512))
    (call $puts (i32.const 126976))
    (call $ok_tail))

  (func $op_encode
    (local $slot i32) (local $n i32) (local $b i32) (local $m i32) (local $r i32) (local $e i32) (local $sum i64)
    (global.set $nb (i32.div_u (i32.add (global.get $count) (i32.const 71)) (i32.const 72)))
    ;; zero the padding of the last block
    (local.set $slot (global.get $count))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $slot) (i32.mul (global.get $nb) (i32.const 72))))
        (i32.store (i32.add (i32.const 726016) (i32.shl (local.get $slot) (i32.const 2))) (i32.const 0))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $next)))
    (global.set $o (i32.const 737280))
    (call $puts (i32.const 512))
    (call $puts (i32.const 576)) (call $putu (i64.extend_i32_u (global.get $nb)))
    (call $puts (i32.const 608)) (call $putu (i64.extend_i32_u (global.get $count)))
    (call $puts (i32.const 640))
    (block $nodes
      (loop $node
        (br_if $nodes (i32.ge_u (local.get $n) (i32.const 110)))
        (if (local.get $n) (then (call $putc (i32.const 44))))
        (call $putc (i32.const 91))
        (local.set $b (i32.const 0))
        (block $blocks
          (loop $block
            (br_if $blocks (i32.ge_u (local.get $b) (global.get $nb)))
            (if (local.get $b) (then (call $putc (i32.const 44))))
            (call $putc (i32.const 91))
            (local.set $m (i32.const 0))
            (block $comps
              (loop $comp
                (br_if $comps (i32.ge_u (local.get $m) (i32.const 8)))
                (if (local.get $m) (then (call $putc (i32.const 44))))
                ;; y = A row (8n + m) . block b of the values, in i64 (|y| <= PACKET_MAX)
                (local.set $r (i32.add (i32.shl (local.get $n) (i32.const 3)) (local.get $m)))
                (local.set $sum (i64.const 0))
                (local.set $e (call $rs (local.get $r)))
                (block $edone
                  (loop $enext
                    (br_if $edone (i32.ge_u (local.get $e) (call $rs (i32.add (local.get $r) (i32.const 1)))))
                    (local.set $sum (i64.add (local.get $sum)
                      (i64.mul (call $eval (local.get $e))
                        (call $val (i32.add (i32.mul (local.get $b) (i32.const 72)) (call $ecol (local.get $e)))))))
                    (local.set $e (i32.add (local.get $e) (i32.const 1)))
                    (br $enext)))
                (call $puts64 (local.get $sum))
                (local.set $m (i32.add (local.get $m) (i32.const 1)))
                (br $comp)))
            (call $putc (i32.const 93))
            (local.set $b (i32.add (local.get $b) (i32.const 1)))
            (br $block)))
        (call $putc (i32.const 93))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $node)))
    (call $puts (i32.const 672))
    (call $puts (i32.const 704))
    (call $ok_tail))

  ;; S[col] = sum over the block's chosen rows of L * y (L i32 entries), for one parity block of one keep table.
  (func $apply_l (param $b i32) (param $n i32) (param $colsAt i32) (param $rowsAt i32) (param $lAt i32)
    (local $i i32) (local $m i32) (local $col i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (global.set $ah (i64.const 0)) (global.set $al (i64.const 0))
        (local.set $m (i32.const 0))
        (block $mdone
          (loop $mnext
            (br_if $mdone (i32.ge_u (local.get $m) (local.get $n)))
            (call $smul
              (i64.load32_s (i32.add (local.get $lAt) (i32.shl (i32.add (i32.mul (local.get $i) (local.get $n)) (local.get $m)) (i32.const 2))))
              (call $y (local.get $b) (i32.load16_u (i32.add (local.get $rowsAt) (i32.shl (local.get $m) (i32.const 1))))))
            (call $acc)
            (local.set $m (i32.add (local.get $m) (i32.const 1)))
            (br $mnext)))
        (local.set $col (i32.load8_u (i32.add (local.get $colsAt) (local.get $i))))
        (i64.store (i32.add (i32.const 4864) (i32.shl (local.get $col) (i32.const 3))) (global.get $ah))
        (i64.store (i32.add (i32.const 5504) (i32.shl (local.get $col) (i32.const 3))) (global.get $al))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next))))

  ;; One block of a decode; sets $err on the first failure.
  (func $decode_block (param $b i32)
    (local $kt i32) (local $d i64) (local $want i32) (local $k i32) (local $r i32) (local $rend i32)
    (local $e i32) (local $c i32) (local $sh i64) (local $sl i64) (local $x i64) (local $sum i64) (local $slot i32)
    (local.set $kt
      (select (global.get $T_KEEP0)
        (select (global.get $T_KEEP1) (global.get $T_KEEP2) (i32.eq (global.get $keep) (i32.const 1)))
        (i32.eqz (global.get $keep))))
    (local.set $want (call $kept_count))
    (local.set $d (i64.load (local.get $kt)))
    ;; 1. S = L y, the even block then the odd block (128-bit)
    (call $apply_l (local.get $b) (i32.const 30) (global.get $T_COLS)
      (i32.add (local.get $kt) (i32.const 8)) (i32.add (local.get $kt) (i32.const 152)))
    (call $apply_l (local.get $b) (i32.const 42) (i32.add (global.get $T_COLS) (i32.const 30))
      (i32.add (local.get $kt) (i32.const 68)) (i32.add (local.get $kt) (i32.const 3752)))
    ;; 2. consistency on every kept row: A S = D y exactly (a row that is always zero must carry zero)
    (local.set $k (i32.const 0))
    (block $knodes
      (loop $knode
        (br_if $knodes (i32.ge_u (local.get $k) (local.get $want)))
        (local.set $r (i32.shl (call $kept_node (local.get $k)) (i32.const 3)))
        (local.set $rend (i32.add (local.get $r) (i32.const 8)))
        (block $rows
          (loop $row
            (br_if $rows (i32.ge_u (local.get $r) (local.get $rend)))
            (global.set $ah (i64.const 0)) (global.set $al (i64.const 0))
            (local.set $e (call $rs (local.get $r)))
            (block $edone
              (loop $enext
                (br_if $edone (i32.ge_u (local.get $e) (call $rs (i32.add (local.get $r) (i32.const 1)))))
                (local.set $c (call $ecol (local.get $e)))
                (call $smul_wide
                  (i64.load (i32.add (i32.const 4864) (i32.shl (local.get $c) (i32.const 3))))
                  (i64.load (i32.add (i32.const 5504) (i32.shl (local.get $c) (i32.const 3))))
                  (call $eval (local.get $e)))
                (call $acc)
                (local.set $e (i32.add (local.get $e) (i32.const 1)))
                (br $enext)))
            (call $smul (local.get $d) (call $y (local.get $b) (local.get $r)))
            (if (i32.or (i64.ne (global.get $ah) (global.get $ph)) (i64.ne (global.get $al) (global.get $pl)))
              (then (call $seterr (i32.const 5)) (return)))
            (local.set $r (i32.add (local.get $r) (i32.const 1)))
            (br $row)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $knode)))
    ;; 3. x = S / D only when exact, and only an integer in -32768..32767
    (local.set $c (i32.const 0))
    (block $xs
      (loop $xn
        (br_if $xs (i32.ge_u (local.get $c) (i32.const 72)))
        (local.set $sh (i64.load (i32.add (i32.const 4864) (i32.shl (local.get $c) (i32.const 3)))))
        (local.set $sl (i64.load (i32.add (i32.const 5504) (i32.shl (local.get $c) (i32.const 3)))))
        (if (i64.ne (local.get $sh) (i64.shr_s (local.get $sl) (i64.const 63)))
          (then (call $seterr (i32.const 6)) (return)))
        (if (i64.ne (i64.rem_s (local.get $sl) (local.get $d)) (i64.const 0))
          (then (call $seterr (i32.const 6)) (return)))
        (local.set $x (i64.div_s (local.get $sl) (local.get $d)))
        (if (i32.or (i64.lt_s (local.get $x) (i64.const -32768)) (i64.gt_s (local.get $x) (i64.const 32767)))
          (then (call $seterr (i32.const 6)) (return)))
        (i64.store (i32.add (i32.const 4224) (i32.shl (local.get $c) (i32.const 3))) (local.get $x))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $xn)))
    ;; 4. the residual, independent of L: A x = y on every kept row, plain i64
    (local.set $k (i32.const 0))
    (block $knodes2
      (loop $knode2
        (br_if $knodes2 (i32.ge_u (local.get $k) (local.get $want)))
        (local.set $r (i32.shl (call $kept_node (local.get $k)) (i32.const 3)))
        (local.set $rend (i32.add (local.get $r) (i32.const 8)))
        (block $rows2
          (loop $row2
            (br_if $rows2 (i32.ge_u (local.get $r) (local.get $rend)))
            (local.set $sum (i64.const 0))
            (local.set $e (call $rs (local.get $r)))
            (block $edone2
              (loop $enext2
                (br_if $edone2 (i32.ge_u (local.get $e) (call $rs (i32.add (local.get $r) (i32.const 1)))))
                (local.set $sum (i64.add (local.get $sum)
                  (i64.mul (call $eval (local.get $e))
                           (i64.load (i32.add (i32.const 4224) (i32.shl (call $ecol (local.get $e)) (i32.const 3)))))))
                (local.set $e (i32.add (local.get $e) (i32.const 1)))
                (br $enext2)))
            (if (i64.ne (local.get $sum) (call $y (local.get $b) (local.get $r)))
              (then (call $seterr (i32.const 5)) (return)))
            (local.set $r (i32.add (local.get $r) (i32.const 1)))
            (br $row2)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $knode2)))
    ;; 5. the values; padding past count must be zero
    (local.set $c (i32.const 0))
    (block $vs
      (loop $vn
        (br_if $vs (i32.ge_u (local.get $c) (i32.const 72)))
        (local.set $slot (i32.add (i32.mul (local.get $b) (i32.const 72)) (local.get $c)))
        (local.set $x (i64.load (i32.add (i32.const 4224) (i32.shl (local.get $c) (i32.const 3)))))
        (if (i32.lt_u (local.get $slot) (global.get $count))
          (then (i32.store (i32.add (i32.const 726016) (i32.shl (local.get $slot) (i32.const 2))) (i32.wrap_i64 (local.get $x))))
          (else (if (i64.ne (local.get $x) (i64.const 0)) (then (call $seterr (i32.const 3)) (return)))))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $vn))))

  (func $op_decode
    (local $b i32) (local $i i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $b) (global.get $nb)))
        (call $decode_block (local.get $b))
        (br_if $done (global.get $err))
        (local.set $b (i32.add (local.get $b) (i32.const 1)))
        (br $next)))
    (if (global.get $err) (then (return)))
    (global.set $o (i32.const 737280))
    (call $puts (i32.const 512))
    (call $puts (i32.const 576)) (call $putu (i64.extend_i32_u (global.get $nb)))
    (call $puts (i32.const 128))
    (call $puts
      (select (i32.const 448)
        (select (i32.const 480) (i32.const 1120) (i32.eq (global.get $keep) (i32.const 1)))
        (i32.eqz (global.get $keep))))
    (call $puts (i32.const 736)) (call $putu (i64.extend_i32_u (call $kept_count)))
    (call $puts (i32.const 768))
    (call $puts (i32.const 800))
    (block $vdone
      (loop $vnext
        (br_if $vdone (i32.ge_u (local.get $i) (global.get $count)))
        (if (local.get $i) (then (call $putc (i32.const 44))))
        (call $puts64 (call $val (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $vnext)))
    (call $putc (i32.const 93))
    (call $putc (i32.const 125))
    (call $ok_tail))

  ;; ================= ABI =================
  (func (export "mv_abi_version") (result i32) (i32.const 1))

  (func (export "mv_alloc") (param $len i32) (result i32)
    (if (result i32) (i32.le_u (local.get $len) (i32.const 327680))
      (then (i32.const 229376))
      (else (i32.const 0))))

  ;; form: 0 {}  1 {keep?, values}  2 {count, keep, packets}
  ;; op:   0 pentora.info  1 pentora.encode  2 pentora.decode
  (func (export "mv_run") (param $ptr i32) (param $len i32) (result i64)
    (local $form i32) (local $op i32) (local $v i64)
    (global.set $err (i32.const 0))
    (global.set $bad (i32.const 0))
    (global.set $inInput (i32.const 0))
    (global.set $seq (i64.const 0))
    (global.set $o (i32.const 737280))
    (global.set $keep (i32.const 0))
    (global.set $count (i32.const 0))
    (global.set $nb (i32.const 0))
    (local.set $op (i32.const -1))
    (call $tables)
    (if (i32.or (i32.ne (local.get $ptr) (i32.const 229376)) (i32.gt_u (local.get $len) (i32.const 327680)))
      (then (call $fail))
      (else
        (global.set $p (local.get $ptr))
        (global.set $end (i32.add (local.get $ptr) (local.get $len)))
        (call $lit (i32.const 64))
        (global.set $inInput (i32.eqz (global.get $bad)))
        (if (i32.eq (call $peek) (i32.const 125))
          (then (local.set $form (i32.const 0)))
          (else
            (if (call $try (i32.const 96))
              (then
                (local.set $form (i32.const 2))
                (local.set $v (call $uint))
                (if (i32.or (i64.eqz (local.get $v)) (i64.gt_u (local.get $v) (i64.const 1728)))
                  (then (call $seterr (i32.const 3)))
                  (else (global.set $count (i32.wrap_i64 (local.get $v)))))
                (call $lit (i32.const 128))
                (call $parse_keep)
                (call $lit (i32.const 192))
                (call $parse_packets))
              (else
                (local.set $form (i32.const 1))
                (if (call $try (i32.const 160))
                  (then (call $parse_keep) (call $lit (i32.const 256)))
                  (else (call $lit (i32.const 224))))
                (call $parse_values)))))
        (global.set $inInput (i32.const 0))
        (call $lit (i32.const 288))
        (if (call $try (i32.const 384)) (then (local.set $op (i32.const 0)))
          (else (if (call $try (i32.const 352)) (then (local.set $op (i32.const 1)))
            (else (if (call $try (i32.const 320)) (then (local.set $op (i32.const 2)))
              (else
                (call $seterr (i32.const 2))
                ;; skip the unknown op name to its closing quote
                (block $skip
                  (loop $s
                    (br_if $skip (i32.ge_u (global.get $p) (global.get $end)))
                    (br_if $skip (i32.eq (i32.load8_u (global.get $p)) (i32.const 34)))
                    (global.set $p (i32.add (global.get $p) (i32.const 1)))
                    (br $s)))
                (call $eat (i32.const 34))))))))
        (call $lit (i32.const 416))
        (global.set $seq (call $uint))
        (call $eat (i32.const 125))
        (if (i32.ne (global.get $p) (global.get $end)) (then (call $fail)))
        ;; the input's form must be the op's
        (if (i32.and (i32.ge_s (local.get $op) (i32.const 0)) (i32.ne (local.get $op) (local.get $form)))
          (then (call $seterr (i32.const 3))))
        ;; encode carries every node: only keep "all"
        (if (i32.and (i32.eq (local.get $op) (i32.const 1)) (i32.ne (global.get $keep) (i32.const 0)))
          (then (call $seterr (i32.const 4))))
        (if (i32.eqz (global.get $err))
          (then
            (if (i32.eqz (local.get $op)) (then (call $op_info)))
            (if (i32.eq (local.get $op) (i32.const 1)) (then (call $op_encode)))
            (if (i32.eq (local.get $op) (i32.const 2)) (then (call $op_decode)))))))
    (if (global.get $err) (then (call $refuse)))
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.sub (global.get $o) (i32.const 737280))) (i64.const 32))
      (i64.const 737280)))

  ;; ---- PENTORA TABLES begin (generated by server/pentora-codec.build.mjs --write; never edit by hand) ----
  ;; 69018 bytes of tables (11556 nonzero entries of A; Menger u8[80]; L and D of all three keep-sets) as base64,
  ;; decoded by $tables to $T_BASE on every call. D is 23 bits ("all"), 32 bits ("drop-0-9") and 23 bits ("menger-80").
  (global $T_TEXTLEN i32 (i32.const 92024))
  (global $T_ROWPTR i32 (i32.const 8192))
  (global $T_ECOLS i32 (i32.const 9954))
  (global $T_EVALS i32 (i32.const 21510))
  (global $T_COLS i32 (i32.const 44622))
  (global $T_MENGER i32 (i32.const 44694))
  (global $T_PMAX i32 (i32.const 44776))
  (global $T_KEEP0 i32 (i32.const 44784))
  (global $T_KEEP1 i32 (i32.const 55592))
  (global $T_KEEP2 i32 (i32.const 66400))
  (data (i32.const 126976) "{\22blockSize\22:72,\22denominatorBits\22:{\22all\22:23,\22drop-0-9\22:32,\22menger-80\22:23},\22geometrySha256\22:\2296b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61\22,\22keepSets\22:[\22all\22,\22drop-0-9\22,\22menger-80\22],\22kept\22:{\22all\22:110,\22drop-0-9\22:100,\22menger-80\22:80},\22maxBlocks\22:24,\22nodes\22:110,\22packetMax\22:5881724928,\22profile\22:\22pentora110-qphi72\22,\22rank\22:72,\22scale\22:13824,\22valueMax\22:32767,\22valueMin\22:-32768}")
  (data (i32.const 131072)
    "AAAKAAoAFgAWAB4AHgApACkAMwAzAD8APwBHAEcAUgBSAHAAmgCaAJoAswDYANgA2AD2ACABIAEgATkBXgFeAV4BfAGmAaYB"
    "pgG/AeQB5AHkAQICLAIsAiwCRQJqAmoCagKGAqsCqwKrAsQC6wLrAusCBwMsAywDLANFA2wDbANsA4gDrQOtA60DxgPtA+0D"
    "7QMJBC4ELgQuBEcEbgRuBG4EjASMBLYEtgTFBMUE2gTaBOwEBAUEBQQFDQUZBRkFGQU3BTcFYQVhBXAFcAWFBYUFjwWbBZsF"
    "mwWgBaYFpgWmBbIFsgWyBbIFuAW4BbgFuAXCBc4FzgXOBdMF2QXZBdkF9wX3BSEGIQYwBjAGRQZFBlcGbwZvBm8GeAaEBoQG"
    "hAaiBqIGzAbMBtsG2wbwBvAGDAczBzMHMwdOB3UHdQd1B70HvQe9B70H+gf6B/oH+gdCCEIIQghCCH8Ifwh/CH8ImwjCCMII"
    "wgjdCAQJBAkECSAJRwlHCUcJYgmJCYkJiQnRCdEJ0QnRCQ4KDgoOCg4KVgpWClYKVgqTCpMKkwqTCq8K1grWCtYK8QoYCxgL"
    "GAsqCyoLQgtCC1ELUQtmC2YLeAt4C5ALkAufC58LtAu0C/wL/Av8C/wLNQw1DDUMNQx9DH0MfQx9DLYMtgy2DLYM1Az+DP4M"
    "/gwXDTwNPA08DVoNhA2EDYQNnQ3CDcINwg3gDQoOCg4KDiMOSA5IDkgOZg6QDpAOkA6pDs4Ozg7ODhYPFg8WDxYPTw9PD08P"
    "Tw+XD5cPlw+XD9AP0A/QD9AP6w8QEBAQEBApEE4QThBOEGkQjhCOEI4QpxDMEMwQzBAUERQRFBEUEUoRShFKEUoRkhGSEZIR"
    "khHIEcgRyBHIERASEBIQEhASRhJGEkYSRhKOEo4SjhKOEsQSxBLEEsQS3xIEEwQTBBMdE0ITQhNCE10TghOCE4ITmxPAE8AT"
    "wBPeEwgUCBQIFCMUShRKFEoUaBSSFJIUkhStFNQU1BTUFPIUHBUcFRwVNxVeFV4VXhV8FaYVphWmFcEV6BXoFegV8hX+Ff4V"
    "/hUDFgkWCRYJFhUWFRYVFhUWGxYbFhsWGxYlFjEWMRYxFjYWPBY8FjwWRhZGFlIWUhZaFloWZBZkFm4WbhZ6FnoWghaCFowW"
    "jBaQFpAWkBaQFpIWkhaSFpIWlhaWFpYWlhaYFpgWmBaYFqIWohauFq4Wtha2FsAWwBbKFsoW1hbWFt4W3hboFugW8hb+Fv4W"
    "/hYDFwkXCRcJFxUXFRcVFxUXGxcbFxsXGxclFzEXMRcxFzYXPBc8FzwXWheEF4QXhBefF8YXxhfGF+QXDhgOGA4YKRhQGFAY"
    "UBhuGJgYmBiYGLMY2hjaGNoY+BgiGSIZIhk9GWQZZBlkGX8ZpBmkGaQZvRniGeIZ4hn9GSIaIhoiGjsaYBpgGmAaqBqoGqga"
    "qBreGt4a3hreGiYbJhsmGyYbXBtcG1wbXBukG6QbpBukG9ob2hvaG9obIhwiHCIcIhxYHFgcWBxYHHMcmByYHJgcsRzWHNYc"
    "1hzxHBYdFh0WHS8dVB1UHVQdnB2cHZwdnB3VHdUd1R3VHR0eHR4dHh0eVh5WHlYeVh50Hp4enh6eHrce3B7cHtwe+h4kHyQf"
    "JB89H2IfYh9iH4Afqh+qH6ofwx/oH+gf6B8GIDAgMCAwIEkgbiBuIG4gtiC2ILYgtiDvIO8g7yDvIDchNyE3ITchcCFwIXAh"
    "cCGCIYIhmiGaIakhqSG+Ib4h0CHQIegh6CH3IfchDCIMIigiTyJPIk8iaiKRIpEikSLZItki2SLZIhYjFiMWIxYjXiNeI14j"
    "XiObI5sjmyObI7cj3iPeI94j+SMgJCAkICQ8JGMkYyRjJH4kpSSlJKUk7STtJO0k7SQqJSolKiUqJXIlciVyJXIlryWvJa8l"
    "ryXLJfIl8iXyJQ0mNCY0JjQmUiZSJnwmfCaLJosmoCagJrImyibKJsom0ybfJt8m3yb9Jv0mJycnJzYnNidLJ0snVSdhJ2En"
    "YSdmJ2wnbCdsJ3gneCd4J3gnfid+J34nfieIJ5QnlCeUJ5knnyefJ58nvSe9J+cn5yf2J/YnCygLKB0oNSg1KDUoPihKKEoo"
    "SihoKGgokiiSKKEooSi2KLYo0ij3KPco9ygQKTcpNyk3KVMpeCl4KXgpkSm4KbgpuCnUKfkp+Sn5KRIqOSo5KjkqVSp6Knoq"
    "eiqTKroquiq6KtgqAisCKwIrGytAK0ArQCteK4griCuIK6ErxivGK8Yr5CsOLA4sDiwnLEwsTCxMLGoslCyULJQsrSzSLNIs"
    "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"
    "Njc4OTs8PT5AQUJDREVGRwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3"
    "ODk6Ozw9Pj9AQUJDREVGRwECBAYHCAkKCwwNDxARExQVFhcYGRobHB0eHyAiIyQmJygpKiwtLzAxMjM0NTY3ODk7PD0+QEFC"
    "Q0RFRkcABAUGBwgQERITFBUWFxgkKCkqLDQ1Njc4OTs8AQIJCgsMDQ8ZGhscHR4fICIjJSYnLS4vMDEyMz0+P0BBQkNERUZH"
    "BAYHCBARExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJictLzAxMjM9PkBBQkNERUZHAAQFBhAR"
    "EhMUJCgpKjQ1Njc4AQIJCgsMGRobHB0eJSYtLi8wPT4/QEFCBAYQERMUJCgpKjQ1Njc4AQIJCgsMGRobHB0eJS0uMD0+P0FC"
    "AAQFBhAREhMUJCgpKjQ1Njc4AQIJCgsMGRobHB0eJSYtLi8wPT4/QEFCBAYQERMUJCgpKjQ1Njc4AQIJCgsMGRobHB0eJS0u"
    "MD0+P0FCAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BB"
    "QkNERUZHAQMEBQgJCgsNDxAREhMVFhgZGhscHR8gISMkJSYoKSorLS4vMDEyNDU2Nzg5Ojs9Pj9AQUJDREVGAAECAwQFBgcI"
    "CQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAQMEBQgJCgsN"
    "DxAREhMVFhgZGhscHR8gISMkJSYoKSorLS4vMDEyNDU2Nzg5Ojs9Pj9AQUJDREVGAAQFBgcIEBESExQVFhcYJCgpKissNDU2"
    "Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4OTo7"
    "PAEDCQoLDQ8ZGhscHR8gISMlJictLi8wMTIzPT4/QEFCQ0RFRkcABAUGBwgQERITFBUWFxgkKCkqKyw0NTY3ODk6OzwBAgMJ"
    "CgsMDQ4PGRobHB0eHyAhIiMlJictLi8wMTIzPT4/QEFCQ0RFRkcEBQgQERITFRYYJCgpKissNDU2Nzg5Ojs8AQMJCgsNDxka"
    "GxwdHyAhIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwAEBQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhsc"
    "HR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwQFCBAREhMVFhgkKCkqKyw0NTY3ODk6OzwBAwkKCw0PGRobHB0fICEjJSYn"
    "LS4vMDEyMz0+P0BBQkNERUZHAAQFBgcIEBESExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJSYn"
    "LS4vMDEyMz0+P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4OTo7PAEDCQoLDQ8ZGhscHR8gISMlJictLi8wMTIzPT4/"
    "QEFCQ0RFRkcAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/"
    "QEFCQ0RFRkcBAwQFCAkKCw0PEBESExUWGBkaGxwdHyAhIyQlJigpKistLi8wMTI0NTY3ODk6Oz0+P0BBQkNERUYAAQIDBAUG"
    "BwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcBAwQFCAkK"
    "Cw0PEBESExUWGBkaGxwdHyAhIyQlJigpKistLi8wMTI0NTY3ODk6Oz0+P0BBQkNERUYABAUGBwgQERITFBUWFxgkKCorLDQ2"
    "Nzg5OjwCAwoLDA0PGhscHR4fISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBQYHERITFBUXGCQoKSorLDQ1Njc4OTo7PAECAwkK"
    "CwwNDg8ZGhscHR4fICEiIyUnLS8wMTI9P0BBQkNERkcABAUGBwgQERITFBUWFxgkKCorLDQ2Nzg5OjwCAwoLDA0PGhscHR4f"
    "ISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBQYHERITFBUXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUn"
    "LS8wMTI9P0BBQkNERkcAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5"
    "Ojs8PT4/QEFCQ0RFRkcCAwUGBwoLDA0PERITFBUXGBobHB0eHyEiIyQlJygqKywtLzAxMjQ2Nzg5Ojw9P0BBQkNERkcAAQID"
    "BAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcCAwUG"
    "BwoLDA0PERITFBUXGBobHB0eHyEiIyQlJygqKywtLzAxMjQ2Nzg5Ojw9P0BBQkNERkcAAQIDBAUGBwgJCgsMDQ4PEBESExQV"
    "FhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcCAwUGBwoLDA0PERITFBUXGBobHB0e"
    "HyEiIyQlJygqKywtLzAxMjQ2Nzg5Ojw9P0BBQkNERkcAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYn"
    "KCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcCAwUGBwoLDA0PERITFBUXGBobHB0eHyEiIyQlJygqKywtLzAxMjQ2"
    "Nzg5Ojw9P0BBQkNERkcABAUGBwgQERITFBUWFxgkKCorLDQ2Nzg5OjwCAwoLDA0PGhscHR4fISIjJSYnLS4vMDEyMz0+P0BB"
    "QkNERUZHBQYHERITFBUXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUnLS8wMTI9P0BBQkNERkcABAUG"
    "BwgQERITFBUWFxgkKCorLDQ2Nzg5OjwCAwoLDA0PGhscHR4fISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBQYHERITFBUXGCQo"
    "KSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUnLS8wMTI9P0BBQkNERkcABAUGBwgQERITFBUWFxgkKCkqKyw0"
    "NTY3ODk6OzwBAgMJCgsMDQ4PGRobHB0eHyAhIiMlJictLi8wMTIzPT4/QEFCQ0RFRkcEBgcIEBETFBUWFxgkKCkqKyw0NTY3"
    "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"
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZH"
    "AgMFBgcKCwwNDxESExQVFxgaGxwdHh8hIiMkJScoKissLS8wMTI0Njc4OTo8PT9AQUJDREZHAAECAwQFBgcICQoLDA0ODxAR"
    "EhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAgMFBgcKCwwNDxESExQVFxga"
    "GxwdHh8hIiMkJScoKissLS8wMTI0Njc4OTo8PT9AQUJDREZHAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIj"
    "JCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAgMFBgcKCwwNDxESExQVFxgaGxwdHh8hIiMkJScoKissLS8w"
    "MTI0Njc4OTo8PT9AQUJDREZHAAQFBgcIEBESExQVFhcYJCgqKyw0Njc4OTo8AgMKCwwNDxobHB0eHyEiIyUmJy0uLzAxMjM9"
    "Pj9AQUJDREVGRwUGBxESExQVFxgkKCkqKyw0NTY3ODk6OzwBAgMJCgsMDQ4PGRobHB0eHyAhIiMlJy0vMDEyPT9AQUJDREZH"
    "AAQFBgcIEBESExQVFhcYJCgqKyw0Njc4OTo8AgMKCwwNDxobHB0eHyEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwUGBxESExQV"
    "FxgkKCkqKyw0NTY3ODk6OzwBAgMJCgsMDQ4PGRobHB0eHyAhIiMlJy0vMDEyPT9AQUJDREZHAAECAwQFBgcICQoLDA0ODxAR"
    "EhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAQMEBQgJCgsNDxAREhMVFhgZ"
    "GhscHR8gISMkJSYoKSorLS4vMDEyNDU2Nzg5Ojs9Pj9AQUJDREVGAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g"
    "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAQMEBQgJCgsNDxAREhMVFhgZGhscHR8gISMkJSYoKSor"
    "LS4vMDEyNDU2Nzg5Ojs9Pj9AQUJDREVGAAQFBgcIEBESExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8g"
    "ISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4OTo7PAEDCQoLDQ8ZGhscHR8gISMlJictLi8w"
    "MTIzPT4/QEFCQ0RFRkcABAUGBwgQERITFBUWFxgkKCkqKyw0NTY3ODk6OzwBAgMJCgsMDQ4PGRobHB0eHyAhIiMlJictLi8w"
    "MTIzPT4/QEFCQ0RFRkcEBQgQERITFRYYJCgpKissNDU2Nzg5Ojs8AQMJCgsNDxkaGxwdHyAhIyUmJy0uLzAxMjM9Pj9AQUJD"
    "REVGRwAEBQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJD"
    "REVGRwQFCBAREhMVFhgkKCkqKyw0NTY3ODk6OzwBAwkKCw0PGRobHB0fICEjJSYnLS4vMDEyMz0+P0BBQkNERUZHAAQFBgcI"
    "EBESExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBES"
    "ExUWGCQoKSorLDQ1Njc4OTo7PAEDCQoLDQ8ZGhscHR8gISMlJictLi8wMTIzPT4/QEFCQ0RFRkcAAQIDBAUGBwgJCgsMDQ4P"
    "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcBAwQFCAkKCw0PEBESExUW"
    "GBkaGxwdHyAhIyQlJigpKistLi8wMTI0NTY3ODk6Oz0+P0BBQkNERUYAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e"
    "HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcBAwQFCAkKCw0PEBESExUWGBkaGxwdHyAhIyQlJigp"
    "KistLi8wMTI0NTY3ODk6Oz0+P0BBQkNERUYABAUGEBESExQkKCkqNDU2NzgBAgkKCwwZGhscHR4lJi0uLzA9Pj9AQUIEBhAR"
    "ExQkKCkqNDU2NzgBAgkKCwwZGhscHR4lLS4wPT4/QUIABAUGEBESExQkKCkqNDU2NzgBAgkKCwwZGhscHR4lJi0uLzA9Pj9A"
    "QUIEBhARExQkKCkqNDU2NzgBAgkKCwwZGhscHR4lLS4wPT4/QUIABAUGBwgQERITFBUWFxgkKCkqLDQ1Njc4OTs8AQIJCgsM"
    "DQ8ZGhscHR4fICIjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAYHCBARExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxka"
    "GxwdHh8gISIjJictLzAxMjM9PkBBQkNERUZHAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKiss"
    "LS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHAQIEBgcICQoLDA0PEBETFBUWFxgZGhscHR4fICIjJCYnKCkqLC0vMDEyMzQ1"
    "Njc4OTs8PT5AQUJDREVGRwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3"
    "ODk6Ozw9Pj9AQUJDREVGRwECBAYHCAkKCwwNDxARExQVFhcYGRobHB0eHyAiIyQmJygpKiwtLzAxMjM0NTY3ODk7PD0+QEFC"
    "Q0RFRkcABAUGBwgQERITFBUWFxgkKCkqLDQ1Njc4OTs8AQIJCgsMDQ8ZGhscHR4fICIjJSYnLS4vMDEyMz0+P0BBQkNERUZH"
    "BAYHCBARExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJictLzAxMjM9PkBBQkNERUZHAAQFBgcI"
    "EBESExQVFhcYJCgpKiw0NTY3ODk7PAECCQoLDA0PGRobHB0eHyAiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwQGBwgQERMUFRYX"
    "GCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyYnLS8wMTIzPT5AQUJDREVGRwABAgMEBQYHCAkKCwwNDg8Q"
    "ERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGRwECBAYHCAkKCwwNDxARExQV"
    "FhcYGRobHB0eHyAiIyQmJygpKiwtLzAxMjM0NTY3ODk7PD0+QEFCQ0RFRkcAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRob"
    "HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkcBAgQGBwgJCgsMDQ8QERMUFRYXGBkaGxwdHh8g"
    "IiMkJicoKSosLS8wMTIzNDU2Nzg5Ozw9PkBBQkNERUZHAAQFBgcIEBESExQVFhcYJCgpKiw0NTY3ODk7PAECCQoLDA0PGRob"
    "HB0eHyAiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwQGBwgQERMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4f"
    "ICEiIyYnLS8wMTIzPT5AQUJDREVGRwAEBQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEi"
    "IyUmJy0uLzAxMjM9Pj9AQUJDREVGRyQoKSorLDQ1Njc4OTo7PCUmJy0uLzAxMjM9Pj9AQUJDREVGRwAEBQYQERITFCQoKSo0"
    "NTY3OAECCQoLDBkaGxwdHiUmLS4vMD0+P0BBQiQoKSo0NTY3OCUmLS4vMD0+P0BBQgAEBQYHCBAREhMUFRYXGCQoKSorLDQ1"
    "Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRyQoKSorLDQ1Njc4OTo7PCUmJy0uLzAx"
    "MjM9Pj9AQUJDREVGRwAGCBQYJCosODwCAwwPHiMmJzAzQkckKiw4PCYnMDNCRwACBgwUHiQmKjA4QiQmKjA4QgAGCBQYJCos"
    "ODwCAwwPHiMmJzAzQkckKiw4PCYnMDNCRwAEBQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4f"
    "ICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRyQoKSorLDQ1Njc4OTo7PCUmJy0uLzAxMjM9Pj9AQUJDREVGRwAEBQYQERITFCQo"
    "KSo0NTY3OAECCQoLDBkaGxwdHiUmLS4vMD0+P0BBQiQoKSo0NTY3OCUmLS4vMD0+P0BBQgAEBQYHCBAREhMUFRYXGCQoKSor"
    "LDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRyQoKSorLDQ1Njc4OTo7PCUmJy0u"
    "LzAxMjM9Pj9AQUJDREVGRwAEBQYHCBAREhMUFRYXGCQoKSorNDU2Nzg5OjsBAwkKCw0PGRobHB0fICEjJSYnLS4vMDEyMz0+"
    "P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmLS4vMDEyPT4/QEFCQ0RF"
    "RgAEBQYHCBAREhMUFRYXGCQoKSorNDU2Nzg5OjsBAwkKCw0PGRobHB0fICEjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBES"
    "ExUWGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmLS4vMDEyPT4/QEFCQ0RFRgAEBQYHCBAREhMUFRYX"
    "GCQoKSorNDU2Nzg5OjsBAwkKCw0PGRobHB0fICEjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4"
    "OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmLS4vMDEyPT4/QEFCQ0RFRgAEBQYHCBAREhMUFRYXGCQoKSorNDU2Nzg5OjsB"
    "AwkKCw0PGRobHB0fICEjJSYnLS4vMDEyMz0+P0BBQkNERUZHBAUIEBESExUWGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8Z"
    "GhscHR4fICEiIyUmLS4vMDEyPT4/QEFCQ0RFRgAEBQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhsc"
    "HR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwUGBxESExQVFxgkKCkqKyw0NTY3ODk6OzwCAwoLDA0PGhscHR4fISIjJSYn"
    "LS4vMDEyMz0+P0BBQkNERUZHAAQFBgcIEBESExQVFhcYJCgpKissNDU2Nzg5Ojs8AQIDCQoLDA0ODxkaGxwdHh8gISIjJSYn"
    "LS4vMDEyMz0+P0BBQkNERUZHBQYHERITFBUXGCQoKSorLDQ1Njc4OTo7PAIDCgsMDQ8aGxwdHh8hIiMlJictLi8wMTIzPT4/"
    "QEFCQ0RFRkcABAUGBwgQERITFBUWFxgkKCkqKyw0NTY3ODk6OzwBAgMJCgsMDQ4PGRobHB0eHyAhIiMlJictLi8wMTIzPT4/"
    "QEFCQ0RFRkcFBgcREhMUFRcYJCgpKissNDU2Nzg5Ojs8AgMKCwwNDxobHB0eHyEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwAE"
    "BQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwUG"
    "BxESExQVFxgkKCkqKyw0NTY3ODk6OzwCAwoLDA0PGhscHR4fISIjJSYnLS4vMDEyMz0+P0BBQkNERUZHAAYIFBgkKiw4PAID"
    "DA8eIyYnMDNCRwYUGCQqLDg8AgMMDx4jJjAzQkcABggUGCQqLDg8AgMMDx4jJicwM0JHBhQYJCosODwCAwwPHiMmMDNCRwA2"
    "ABsAEgAVAAkAGwAkAAkAIQAMAPcACQD0AP0A9QD8AOUA7gDrAPcA7gD5AAkACQADABsAEgAJAA8ABgD3APcA+gD9APsA/gD3"
    "APcA/QD4AP0ANgAbAO4AFQD3ABsAJAD3ACEA9AD3APcA9AADAPUABADlABIA6wAJAO4ABwAJAAkA/QAbABIA9wAPAPoA9wAJ"
    "APoAAwD7AAIA9wD3AAMA+AADADbABiAKoBcgCsAG2ABEAfQCmAfUE0QB2ABEAfQCABtgA4ANICWg/GADbACwAaQEPAwQIJT/"
    "bACwAaQEgPLA68DrUP54/Rj60PB4/VD+eP3K/6//Q/8a/gv7B/Ov/8r/r/9D/xr+QPkA5cAGKP+g/Lj2iOfYACj/oPzl/5T/"
    "1/7x/Pz3A+sbAOX/lP/X/vH8YAMgCqD8bABEAWAD3AiU/2wARAEAG2ADwAbgEGADYANsANgAHAJ8BVgObABsANgAHAJA+cAG"
    "KP94/UD52AAo/+X/r/8o/8n9M/obAOX/r/8o/0D5gPJA+Sj/UP7I+wj1KP8o/1D+5f/K/3n/of5q/J325f/l/8r/ef+h/gA2"
    "wAYgCqAX4PVA+dgARAH0ApgH1BO8/ij/vP4M/QAbYAOADSAlYAOg/GwAsAGkBDwMECBsAJT/UP5c+4DywOtAFFD+eP0Y+tDw"
    "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"
    "QPmIAqD8OATI+9gAKP/YANf+lQHk/aMCXf1RAJT/hwB5/wA2ABIAEgASABIAEgAGAAYABgAGAAYABgAGAAYABgAbAAkACQAJ"
    "AAkACQADAAMAAwADAAMAAwADAAMAAwDuAO4A7gD6APoA+gD6APoA+gD6AP4A/gD+AP4A/gD+AP4A/gD+AP4A/gD3APcA9wD9"
    "AP0A/QD9AP0A/QD9AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wAbAAkACQAJAAkACQADAAMAAwADAAMAAwADAAMAAwD3APcA9wD9"
    "AP0A/QD9AP0A/QD9AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wA2ABsAGwAbgA2ADYANgA2ADQAbgA2ADYANwAbABsAGwAbABgDl"
    "AOWA8oDygPKA8kD5QPlA+UD5QPlA+YDygPJA+UD5QPlA+aD8oPyg/KD8oPyg/AAbgA2ADYANwAbABsAGwAbABoDygPJA+UD5"
    "QPlA+aD8oPyg/KD8oPyg/AA2ABIAEgASAO4A7gAGAAYABgAGAAYA+gD6APoA+gAbAAkACQAJAPcA9wADAAMAAwADAAMA/QD9"
    "AP0A/QDuAO4AEgD6APoA+gD6AAYABgAGAP4A/gD+AP4A/gD+AAIAAgACAAIAAgD3APcACQD9AP0A/QD9AAMAAwADAP8A/wD/"
    "AP8A/wD/AAEAAQABAAEAAQAbAAkACQAJAPcA9wADAAMAAwADAAMA/QD9AP0A/QD3APcACQD9AP0A/QD9AAMAAwADAP8A/wD/"
    "AP8A/wD/AAEAAQABAAEAAQA2ABsAG4ANgA0AG4ANgA3ABsAGAOUA5YDygPJA+UD5gPKA8kD5QPmg/KD8ABuADYANwAbABoDy"
    "gPJA+UD5oPyg/AA2AMoANgDKADYAygAbAOUAGwDlABsA5QAbAOUAGwDlABsA5QA2ABsA5YANgPIAG4ANgPLABkD5AOUAG4Dy"
    "gA1A+cAGgPKADUD5wAag/GADABuADYDywAZA+YDygA1A+cAGoPxgAwA2ABIA7gASAO4AEgAGAPoABgD6AAYA+gAGAPoABgAb"
    "AAkA9wAJAPcACQADAP0AAwD9AAMA/QADAP0AAwASAO4A7gAGAPoABgD6APoABgD6AAIA/gACAP4AAgD+AP4AAgD+AAIA/gAJ"
    "APcA9wADAP0AAwD9AP0AAwD9AAEA/wABAP8AAQD/AP8AAQD/AAEA/wAbAAkA9wAJAPcACQADAP0AAwD9AAMA/QADAP0AAwAJ"
    "APcA9wADAP0AAwD9AP0AAwD9AAEA/wABAP8AAQD/AP8AAQD/AAEA/wA2ABsA5QAbgA2A8oANgPKADQAbgA2A8oANwAZA+cAG"
    "QPnABgAbAOWADYDygA2A8sAGQPnABkD5wAZA+YANgPLABkD5wAZA+WADoPxgA6D8YAOg/AAbgA2A8oANwAZA+cAGQPnABoAN"
    "gPLABkD5wAZA+WADoPxgA6D8YAOg/AA2ABIA7gASABIA7gAGAPoABgD6AAYABgD6AAYA+gAbAAkA9wAJAAkA9wADAP0AAwD9"
    "AAMAAwD9AAMA/QASAO4AEgAGAPoABgD6AAYA+gAGAAIA/gACAP4AAgD+AAIA/gACAP4AAgAJAPcACQADAP0AAwD9AAMA/QAD"
    "AAEA/wABAP8AAQD/AAEA/wABAP8AAQAbAAkA9wAJAAkA9wADAP0AAwD9AAMAAwD9AAMA/QAJAPcACQADAP0AAwD9AAMA/QAD"
    "AAEA/wABAP8AAQD/AAEA/wABAP8AAQA2IArABiAK4BDgEPQCRAHYAEQB9AI4BBwCHAI4BAAboPxgA4AN4BBQ/pT/bACwAaQE"
    "5P0cAlQGwAZA+WAD2AAo/6D8OATI+ykBbAAbAOX/lP/X/pUBhwB5/2v+gPLA60DeeP1Q/nj9GPrI+8j7kPdD/6//yv+v/0P/"
    "Gv7y/nn/ef/y/l39oPxgA6D8YAO8/pT/bABEAVD+lP9sALABABtgA2ADwAbABiAK2ABsAGwA2AAcAkQB2ABEAfQCQPlA+YDy"
    "UP4o/yj/UP54/VD+eP15/8r/5f/l/8r/ef9D/6//yv+v/0P/QPlA+dgAKP94/dgAKP+g/FEAGwDl/6//KP9sABsA5f+U/9f+"
    "ADaADYDyAOVAFIANQBRA+cAGgA1gA6D8gPLg9UD54PXQCxAFYAMQBdALQPlQ/rABwAZICWAD2AAo/6D8uPYY+nj9UP54/Rj6"
    "ABsA5YDXgPJA+cAGABuADUAU4PVA+eD1YOhgA6D8gPJA+VD+sAHABpASEAVgAxAF0AsY+nj9UP54/Rj60PBgA9gAKP+g/Lj2"
    "gPKA8kD5wAbABsAGQPmg/KD8QPlgA6D88PpQ/rABEAVgA7ABsAFgA8j7UP4o/yj/UP7I+4gC2AAo/3j9ABuA8oDywAbABoAN"
    "wAZgA6D84PWg/KD8QPlgA7ABsAFgA3AIUP6wARAFiALYACj/eP1A+VD+KP8o/1D+yPsANoANgPIAG0AUgA1AFMAGQPmADWAD"
    "oPyA8iAKwAYgCtALEAVgAxAF0AvABrABUP5A+UgJYAPYACj/oPy49ugFiAKwAYgC6AUAGwDlgNeADUD5wAYAG4DywOvg9UD5"
    "4PVg6KD8YAOADUD5UP6wAcAGkBLw+qD88Pow9Bj6eP1Q/nj9GPrQ8KD8KP/YAGADSAmA8oDyQPnABkD5QPlA+aD8oPxA+aD8"
    "YAPw+lD+sAEQBaD8UP5Q/qD8yPtQ/ij/KP9Q/sj7eP0o/9gAiAIAG4DygA3ABsAGgA1A+WADoPzg9WADYAPABmADsAGwAWAD"
    "cAiwAVD+8PqIAtgAKP94/UD5sAHYANgAsAE4BAA2IArABiAKIO8g7/QCRAHYAEQB9ALI++T95P3I+wAboPxgA4ANIO9Q/pT/"
    "bACwAaQEHALk/az5wAZA+WAD2AAo/6D8yPs4BCkBbAAbAOX/lP/X/mv+ef+HAJUBgPLA68AheP1Q/nj9GPo4BDgEcAhD/6//"
    "yv+v/0P/Gv4OAYcAhwAOAaMCoPxgA2ADoPy8/pT/bABEAbABbACU/1D+ABtgA2ADwAZA+eD12ABsAGwA2AAcArz+KP+8/gz9"
    "QPlA+YANUP4o/yj/UP6IArABiAJ5/8r/5f/l/8r/ef+9AFEANgBRAL0AQPnABtgAKP94/Sj/2ABgA1EAGwDl/6//KP+U/+X/"
    "GwBsACkBADYgCkD5IAog7+AQ9AK8/tgAvP70Asj7HALk/TgEABug/KD8gA3gEFD+bABsAFD+pAQcAuT9VAZA+UD5oPzYANgA"
    "oPw4BMj71/5sAOX/5f9sANf+lQF5/4cAa/6ADcDrQN6IAlD+iAIY+sj7OASQ970Ar/82AK//vQAa/vL+hwB5/w4BXf2g/GAD"
    "YANgA7z+bACU/0QBsAGU/5T/sAEAG2ADoPzABkD5IArYAJT/bAAo/xwCvP7YALz+9ALABkD5gPKwASj/2ABQ/nj9sAF4/YcA"
    "yv8bAOX/NgB5/0P/UQDK/1EAQ/9A+UD5KP/YAHj92ADYAKD8r/8bAOX/UQAo/2wA5f/l/2wA1/4ANoDygPIA5UAUgPJAFMAG"
    "wAaA8mADYAOA8uD1wAbg9dAL8PpgA/D60AvABlD+UP7ABrj2YAMo/yj/YAO49hj6iAJQ/ogCGPoAGwAbgNeA8kD5QPkAG4Dy"
    "QBQgCkD5IApg6GADYAOA8kD5sAGwAUD5kBLw+mAD8PrQC+gFeP2wAXj96AXQ8GADKP8o/2ADuPaADYDyQPnABkD5wAbABqD8"
    "YANA+WADoPzw+rABUP4QBaD8sAFQ/mADOARQ/tgAKP+wAcj7iAIo/9gAeP0AG4DygPLABkD5gA3ABqD8YAPg9aD8YANA+WAD"
    "UP6wAaD8cAiwAVD+EAV4/dgAKP+IAkD5UP7YACj/sAHI+wA2gPKA8gAbQBSA8kAUQPlA+YDyYANgA4DyIApA+SAK0Avw+mAD"
    "8PrQC0D5sAGwAUD5uPZgAyj/KP9gA7j26AV4/bABeP3oBQAbABuA14ANQPlA+QAbgA3A6yAKQPkgCmDooPyg/IANQPmwAbAB"
    "QPmQEhAFoPwQBTD06AV4/bABeP3oBdDwoPzYANgAoPxICYANgPJA+cAGwAZA+cAGoPxgA0D5oPxgA/D6sAFQ/hAFYANQ/rAB"
    "oPw4BFD+2AAo/7AByPt4/dgAKP+IAgAbgPKADcAGQPmADUD5oPxgA+D1YAOg/MAGYANQ/rABoPxwCFD+sAHw+nj92AAo/4gC"
    "QPmwASj/2ABQ/jgEADYgCkD5IArgECDv9AK8/tgAvP70AjgE5P0cAsj7ABug/KD8gA0g71D+bABsAFD+pATk/RwCrPlA+UD5"
    "oPzYANgAoPzI+zgE1/5sAOX/5f9sANf+a/6HAHn/lQGADcDrwCGIAlD+iAIY+jgEyPtwCL0Ar/82AK//vQAa/g4Bef+HAPL+"
    "owKg/GADoPyg/Lz+bACU/0QBUP5sAGwAUP4AG2ADoPzABsAG4PXYAJT/bAAo/xwCRAEo/0QBDP3ABkD5gA2wASj/2ABQ/ogC"
    "UP6IAocAyv8bAOX/NgB5/70Ar/82AK//vQBA+cAGKP/YAHj9KP8o/2ADr/8bAOX/UQAo/5T/GwAbAJT/KQEANgAbABIAGwAV"
    "AAkABgAJABUAGwAkAAkA9wAhAAwAAwD9APQA9wAJAPQA/QADAAwA9QD8AP8AAQAEAAsA5QDuAOsA9wD6APcA7gD5AP0A/gD9"
    "APkACQD3AAkAAwD9APcAGwASAAkACQAPAAYAAwADAAYA9wD3APoA/QD9APoA+wD+AP8A/wD+APsA9wD3AP0AAwD4AP0A/wAB"
    "AAMANgAbAO4AGwAVAPcABgD3ABUAGwAkAPcA9wAhAPQAAwADAPQACQAJAAwA/QD9AAwACwD8AAEAAQD8AAsAGwDuABUA9wAG"
    "APcAEgD5AAMA/gADAPkACQD3AAkA/QADAPcAGwASAPcACQAPAPoAAwD9AAYACQD3AAYA/QADAPoABQD+AAEA/wACAPsACQAJ"
    "AP0AAwAIAP0AAQD/AAMANoDyAOWADUAUwAaADYANQPmA8uD1oPxA+aD8QPlgA9ALwAYQBbABYAMQBbABYANQ/rj2GPqg/Hj9"
    "KP9Q/qD8eP0o/1D+2AAAG4DXgPIA5QAbQBTABsAGgA1g6IDy4PWg/OD1oPxA+ZAS0AvABhAFsAHABhAFsAFgA9DwuPYY+qD8"
    "eP0o/xj6oPx4/Sj/UP6A8oDywAbABsAGQPmg/KD8oPyg/BAFYAOwAbABsAGwAbAByPt4/VD+KP8o/1D+KP8o/yj/ABuA8oDy"
    "gA3ABsAGwAbg9UD5oPyg/KD8oPxwCBAFYAOwAbABYAOwAbABQPnI+3j9UP4o/yj/eP1Q/ij/KP8ANoDyAOWA8kAUwAaADYDy"
    "wAaA8uD1oPxA+WADwAag/NALwAYQBbABYAPw+lD+oPywAbj2GPqg/Hj9KP9Q/mADiALYALABKP8AG4DXgPIAGwAbQBTABkD5"
    "gPJg6IDy4PWg/CAKYAPABpAS0AvABhAFsAFA+fD6UP6g/NDwuPYY+qD8eP0o/+gFYAOIAtgAsAGA8oANwAbABkD5QPmg/KD8"
    "YANgAxAFYAOwAbABUP5Q/lD+yPt4/VD+KP8o/7AB2ADYANgAABuA8oDygA3ABsAGQPng9UD5oPyg/GADYANwCBAFYAOwAbAB"
    "oPxQ/lD+QPnI+3j9UP4o/yj/iAKwAdgA2AAANqAXIArABsAGIArUE5gH9AJEAdgA9AJEAdgARAEAG4DyoPxgA2ADgA3E81z7"
    "UP6U/2wAUP6U/2wAsAHA64DywOvQ8Bj6eP1Q/nj9UP54/QfzC/sa/kP/r//K/xr+Q/+v/8r/r//ABkD5AOVICWAD2AAo/9gA"
    "KP+g/AQIDwMpAWwAGwDl/ykBbAAbAOX/lP/g9aD8YAMk96D8vP6U/7z+lP9sAAAbwAZgA2ADYAPABnwFHALYAGwAbADYAGwA"
    "bADYAMAGQPnABogC2ADYACj/zQU3AtgAUQAbANgAUQAbAOX/QPlA+YDyyPtQ/ij/KP8o/yj/UP5q/KH+ef/K/+X/5f95/8r/"
    "5f/l/8r/ADagFyAKwAZA+eD11BOYB/QCRAHYAAz9vP4o/7z+ABuA8qD8YAOg/IDyxPNc+1D+lP9sALABbACU/1D+wOuA8kAU"
    "0PAY+nj9UP6IArABiAIH8wv7Gv5D/6//yv/mAb0AUQA2AFEAwAZA+QAbSAlgA9gAKP8o/9gAYAMECA8DKQFsABsA5f/X/pT/"
    "5f8bAGwA4PWg/KD8JPeg/Lz+lP9EAWwAlP8AG8AGYANgA6D8QPl8BRwC2ABsAGwAKP+U/5T/KP/ABsAGwAaIAtgAKP/YAM0F"
    "NwLYAFEAGwAo/6//5f8bAED5QPmADcj7UP4o/yj/2ADYALABavyh/nn/yv/l/+X/hwA2ABsAGwA2AAA2oBfg9cAGQPkgCtQT"
    "aPj0Arz+2AAM/UQBKP9EAQAbgPJgA2ADoPyADcTzpARQ/mwAbACwAZT/lP+wAUAUgPLA6zAPGPqIAlD+eP2wAXj9+QwL++YB"
    "Q/9RAMr/Gv69AK//NgCv/0D5QPkA5bj2YAMo/yj/2ADYAKD8/PcPA9f+bADl/+X/KQGU/xsAGwCU/+D1YANgAyT3YAO8/mwA"
    "RAGU/2wAABvABqD8YAOg/MAGfAXk/dgAlP9sACj/bACU/9gAQPlA+UD5iAIo/9gAKP8z+jcCKP9RAOX/2ACv/xsA5f/ABkD5"
    "gPI4BFD+2AAo/yj/2ABQ/pYDof6HAMr/GwDl/3n/NgDl/xsAyv8ANqAX4PXABsAG4PXUE2j49AK8/tgA9AK8/tgAvP4AG4Dy"
    "YANgA2ADgPLE86QEUP5sAGwAUP5sAGwAUP5AFIDyQBQwDxj6iAJQ/ogCUP6IAvkMC/vmAUP/UQDK/+YBQ/9RAMr/UQBA+UD5"
    "ABu49mADKP8o/yj/KP9gA/z3DwPX/mwA5f/l/9f+bADl/+X/bADg9WADoPwk92ADvP5sALz+bACU/wAbwAag/GADYANA+XwF"
    "5P3YAJT/bADYAJT/bAAo/0D5wAZA+YgCKP8o/9gAM/o3Aij/UQDl/yj/UQDl/xsAwAZA+YANOARQ/tgAKP/YACj/sAGWA6H+"
    "hwDK/xsA5f+HAMr/GwDl/zYAADaADQDlgA1AFED5gA2A8kD5gA3g9WADQPmg/MAGYAPQC0D5EAVQ/mAD8PqwAaD8UP5ICRj6"
    "YAN4/dgAUP6g/IgCKP+wAdgAABuAKIDyAOUAG8DrwAZA+YANoBeA8iAKoPzg9WADQPmQEjD0wAbw+rABQPkQBVD+YAMwD7j2"
    "6AWg/IgCKP8Y+mADeP3YAFD+gA2A8sAGQPnABsAGoPxgA6D8oPwQBaD8sAFQ/lD+sAGwATgEeP2wASj/2ABQ/tgAKP8o/wAb"
    "gA2A8oANQPnABkD5IApA+WADoPyg/GADcAjw+mADUP6wAaD8sAFQ/sAGyPuIAlD+2AAo/3j9sAEo/9gAADaADQDlgPJAFED5"
    "gA2ADcAGgA3g9WADQPlgA0D5oPzQC0D5EAVQ/mADEAVQ/mADsAFICRj6YAN4/dgAUP5gA3j92ABQ/ij/ABuAKIDyABsAG8Dr"
    "wAbABoDyoBeA8iAKoPwgCqD8wAaQEjD0wAbw+rABwAbw+rABoPwwD7j26AWg/IgCKP/oBaD8iAIo/7ABgA2ADcAGQPlA+cAG"
    "oPxgA2ADYAMQBaD8sAFQ/rABUP5Q/jgEeP2wASj/2ACwASj/2ADYAAAbgA2A8oANQPnABsAGIApA+WADoPxgA6D8cAjw+mAD"
    "UP6wAWADUP6wAcAGyPuIAlD+2AAo/4gCUP7YACj/ADbAIeAQIArgEMAGGBWMClQGOAT0AowKOAQcAkQBABvgEKD84BBgA4wK"
    "5P3k/VD+jAocApT/wAZA+TgEOARgA8j72ACjAqMCHAKVASkBXf2HAIcAbABA3oDywOvo6pD3yPt4/VjzyPtQ/tHyuvpd/Wv+"
    "8v5D/xf4Xf3y/nn/r/+g/KD8YAPk/eT9UP68/hwClP+U/wAb4BDABmADIApgA4wKOAQcAkQB2ABUBhwC2ABsAIDyQPlA+ZD3"
    "yPt4/VD+yPtQ/ij/uvpd/Wv+8v5D/3n/Xf3y/nn/r//K/0D5QPnI+9gA2ADI+yj/Xf2HAIcAbABRAF39ef8bABsAADbAIeAQ"
    "IAog70D5GBWMClQGOAT0AnT1yPvk/bz+ABvgEKD8IO+g/IwK5P3k/VD+dPXk/WwAwAbABjgEOARgAzgEKP+jAqMCHAKVASkB"
    "owJ5/3n/lP9A3oDyQBTo6pD3yPt4/agMOASwAdHyuvpd/Wv+8v5D/+kHowIOAYcAUQCg/KD8oPzk/eT9UP68/uT9bABsAAAb"
    "4BDABmAD4PWg/IwKOAQcAkQB2ACs+eT9KP+U/4DyQPnABpD3yPt4/VD+OASwAdgAuvpd/Wv+8v5D/3n/owIOAYcAUQA2AED5"
    "wAbI+9gA2AA4BNgAXf2HAIcAbABRAKMChwDl/+X/ADYA5YANgPKADUD5QBTABoANQPlgA+D1gA2g/ED5YANgA1D+EAVA+dAL"
    "sAFgA1D+EAVQ/tgAeP1gAxj6SAko/1D+2AB4/WADABuA8gDlgNfABoANQPlAFMAGoPxA+WAD4PXg9aD8QPmwAWADUP4QBUD5"
    "EAWwAWADUP4o/1D+2AB4/WADGPp4/Sj/UP7YAHj9gPKA8sAGQPnABqD8YANA+aD8oPywAVD+YAPw+rABsAFQ/ij/2ABQ/ogC"
    "yPso/yj/2ABQ/gAbgPKA8sAGwAbABsAGoPyg/GADoPyg/LABsAFQ/mADsAGwAbABKP8o/9gAUP6IAij/KP8o/9gAADYA5YAN"
    "gA2ADUD5QBRA+YDyQPlgA+D1gA1gA8AGoPxgA1D+EAVA+dALUP6g/LAB8PpQ/tgAeP1gAxj6SAnYALABKP+IAqD8ABuA8gDl"
    "gCjABoANQPnA60D5oPxA+WAD4PUgCmADwAawAWADUP4QBUD58PpQ/qD8sAEo/1D+2AB4/WADGPqIAtgAsAEo/4gCgPKADcAG"
    "QPlA+aD8YANA+WADYAOwAVD+YAPw+lD+UP6wASj/2ABQ/ogCyPvYANgAKP+wAQAbgPKADcAGwAZA+UD5oPyg/GADYANgA7AB"
    "sAFQ/mADUP5Q/lD+KP8o/9gAUP6IAtgA2ADYACj/ADYAG4ANgPKADcAGQBRA+YANwAZgAyAKgA2g/MAGYANgA7ABEAXABtAL"
    "UP5gA7ABEAWwAdgAiAJgA+gFSAko/7AB2ACIAmADABuADQDlgNfABoDyQPnA68AGYANA+aD84PXg9WADQPmwAaD8UP7w+kD5"
    "8PqwAaD8UP7YAFD+KP94/aD8GPp4/dgAUP4o/3j9gPKA8kD5QPlA+aD8oPxA+aD8oPxQ/lD+oPzw+lD+UP5Q/ij/KP9Q/nj9"
    "yPso/yj/KP9Q/gAbgA2A8sAGwAZA+cAGYANgA2ADoPxgA7ABsAGwAWADUP6wAbAB2ADYANgAsAGIAij/2ADYANgAADYAG4AN"
    "gA2ADcAGQBTABoDywAZgAyAKgA1gA0D5oPxgA7ABEAXABtALsAGg/FD+8PqwAdgAiAJgA+gFSAnYAFD+KP94/aD8ABuADQDl"
    "gCjABoDyQPlAFED5YANA+aD84PUgCqD8wAawAaD8UP7w+kD5EAVQ/mADsAHYAFD+KP94/aD8GPqIAij/sAHYAIgCgPKADUD5"
    "QPnABqD8oPxA+WADYANQ/lD+oPzw+rABsAGwASj/KP9Q/nj9yPvYANgA2ACwAQAbgA2ADcAGwAbABkD5YANgA2ADYAOg/LAB"
    "sAGwAWADsAFQ/lD+2ADYANgAsAGIAtgAKP8o/yj/ADbAISDvIAog78AGGBV09VQGyPv0AnT1OATk/UQBABvgEKD8IO9gA4wK"
    "5P0cAlD+dPUcApT/wAZA+TgEyPtgA8j72ACjAl39HAJr/ikBXf2HAHn/bADAIYDywOsYFZD3OAR4/VjzOARQ/i8NuvqjAmv+"
    "DgFD/xf4owLy/ocAr/9gA6D8oPwcAuT9sAG8/uT9bACU/wAb4BBA+WAD4PVgA4wKyPscArz+2ACs+RwCKP9sAIANQPlA+XAI"
    "yPuIAlD+yPuwASj/RgVd/ZUB8v69AHn/Xf0OAXn/UQDK/8AGQPk4BCj/2ADI+9gAowJ5/4cAlP9RAF39hwDl/xsAADbAISDv"
    "IArgEED5GBV09VQGyPv0AowKyPscArz+ABvgEKD84BCg/IwK5P0cAlD+jArk/WwAwAbABjgEyPtgAzgEKP+jAl39HAJr/ikB"
    "owJ5/4cAlP/AIYDyQBQYFZD3OAR4/agMyPuwAS8NuvqjAmv+DgFD/+kHXf0OAXn/UQBgA6D8YAMcAuT9sAG8/hwClP9sAAAb"
    "4BBA+WADIAqg/IwKyPscArz+2ABUBuT92ACU/4ANQPnABnAIyPuIAlD+OARQ/tgARgVd/ZUB8v69AHn/owLy/ocAr/82AMAG"
    "wAY4BCj/2AA4BCj/owJ5/4cAlP9RAKMCef8bAOX/ADagF8AGoBcgCiAK1BP0AtgA9ALUE5gHRAFEAZgHABsgJWADgPKADaD8"
    "ECCkBGwAUP7E8zwMsAGU/1z7wOvA64Dy0PB4/Xj90PAY+lD+GPoH8xr+r/+v/xr+B/ML+0P/yv9D/wv7AOXABkD5iOeg/NgA"
    "SAm49ij/YAMD6/H8lP8bACkBBAj899f+5f9sAA8DIArg9WADoPzcCEQBvP4k92ADbACU/6D8ABvgEGADwAbABmADWA4cAmwA"
    "2AB8BXwF2ABsABwCQPnABkD5KP/YAMAGeP2IAjP6KP/l/xsA2ADNBcn9r/9RADcCgPJA+UD5CPVQ/ij/yPvI+yj/UP6d9qH+"
    "yv/l/3n/avxq/Hn/5f/K/6H+ADagF8AGoBfg9eD11BP0AtgA9ALUE2j4vP68/mj4ABsgJWADgPKA8mADECCkBGwAUP7E88Tz"
    "UP5sAKQEwOvA64AN0PB4/Xj90PDoBbAB6AUH8xr+r/+v/xr+B/P1BL0ANgC9APUEAOXABsAGiOeg/NgASAlICdgAoPwD6/H8"
    "lP8bACkBBAgECCkBGwCU//H8IArg9aD8YAPcCEQBvP4k96D8lP9sAGADABvgEGADwAZA+aD8WA4cAmwA2AB8BYT6KP+U/+T9"
    "QPnABkD5KP/YAMAGiAJ4/TP6KP/l/xsA2ADNBTcCUQCv/8n9gPJA+cAGCPVQ/ij/yPs4BNgAsAGd9qH+yv/l/3n/avyWA4cA"
    "GwA2AF8BADagF0D5oBfg9SAK1BMM/dgADP3UE2j4RAG8/pgHABsgJaD8gPKA8qD8ECBc+2wAsAHE88TzsAFsAFz7QBTA64Dy"
    "MA94/YgC0PAY+rABGPr5DBr+UQCv/+YBB/ML+70Ayv+9AAv7ABvABkD5eBig/Cj/SAm49tgAYAP9FPH8bAAbANf+BAj89ykB"
    "5f+U/w8DIArg9aD8oPzcCLz+RAEk96D8bABsAKD8ABvgEKD8wAZA+WADWA7k/WwAKP98BYT62ACU/xwCwAbABsAGKP8o/8AG"
    "eP2IAs0FKP8bABsAKP/NBcn9UQCv/zcCgA1A+UD5+ApQ/tgAyPvI+9gAUP5jCaH+NgDl/4cAavxq/IcA5f82AKH+ADagF0D5"
    "oBcgCuD11BMM/dgADP3UE5gHvP5EAWj4ABsgJaD8gPKADWADECBc+2wAsAHE8zwMUP6U/6QEQBTA64ANMA94/YgC0PDoBVD+"
    "6AX5DBr+UQCv/+YBB/P1BEP/NgBD//UEABvABsAGeBig/Cj/SAlICSj/oPz9FPH8bAAbANf+BAgECNf+GwBsAPH8IArg9WAD"
    "YAPcCLz+RAEk92ADlP+U/2ADABvgEKD8wAbABqD8WA7k/WwAKP98BXwFKP9sAOT9wAbABsAGKP8o/8AGiAJ4/c0FKP8bABsA"
    "KP/NBTcCr/9RAMn9gA1A+cAG+ApQ/tgAyPs4BCj/sAFjCaH+NgDl/4cAavyWA3n/GwDK/18BADYAGwAbgA2ADQAbgA2ADcAG"
    "wAYA5QDlgPKA8kD5QPmA8oDyQPlA+aD8oPwAG4ANgA3ABsAGgPKA8kD5QPmg/KD8ADYAygA2AMoANgDKABsA5QAbAOUAGwDl"
    "ABsA5QAbAOUAGwDlADYAGwDlgA2A8gAbgA2A8sAGQPkA5QAbgPKADUD5wAaA8oANQPnABqD8YAMAG4ANgPLABkD5gPKADUD5"
    "wAag/GADADYAGwASABUACQAbAPcACQD0AP0ACQD3AAwAAwALAAQA7gDlAPcA+gD5AP0A9wD3AP0AGwAJAAkABgADAPcA9wD6"
    "AP0A+wD+APcAAwADAAEANgAbAO4AFQD3ABsA9wD3APQAAwAJAAkADAD9AAsA/ADuABsA9wAGAPkAAwD3APcAAwAbAAkA9wAG"
    "AP0A9wAJAPoAAwD7AAIACQADAAMA/wA2AMoAGwDlABsA5QA2ADYAGwAbABsAGwA2ABsA7gAVAPcAGwD3APcA9AADAPcA9wD0"
    "AAMA9QAEABIA5QAJAPoABwD9APcA9wADABsACQD3AAYA/QAJAPcABgD9AAUA/gD3AP0A/QABADYAGwASABUACQAbAPcACQD0"
    "AP0A9wAJAPQA/QD1APwAEgAbAAkABgAHAAMA9wD3AP0AGwAJAAkABgADAAkACQAGAAMABQACAAkA/QD9AP8ANgAbAOWADYDy"
    "ABuADYDywAZA+QAbAOWADYDywAZA+YANgPLABkD5YAOg/AAbgA2A8sAGQPmADYDywAZA+WADoPwANgA2ADYANgA2ADYAGwAb"
    "ABsAGwAbABsAGwAbABsAGwAbABsANgAbABuADYANABuADYANwAbABgAbABuADYANwAbABoANgA3ABsAGYANgAwAbgA2ADcAG"
    "wAaADYANwAbABmADYAMANqAXQPmgFyAK4PXUEwz92AAM/dQTmAe8/kQBaPgAGyAloPyA8oANYAMQIFz7bACwAcTzPAxQ/pT/"
    "pATA60AUgPLQ8IgCeP0wDxj6sAEY+gfz5gGv/1EAGv75DAv7vQDK/70AC/sA5UD5QPmI52AD2AC49rj22ABgAwPrDwOU/+X/"
    "KQH89/z3KQHl/5T/DwMgCuD1YANgA9wIvP5EAST3YAOU/5T/YAMAG+AQoPzABsAGoPxYDuT9bAAo/3wFfAUo/2wA5P1A+UD5"
    "QPnYANgAQPl4/YgCM/rYAOX/5f/YADP6yf1RAK//NwKA8sAGQPkI9bABKP84BMj72ABQ/p32XwHK/xsAef+WA2r8hwDl/zYA"
    "of4ANqAXQPmgF+D1IArUEwz92AAM/dQTaPhEAbz+mAcAGyAloPyA8oDyoPwQIFz7bACwAcTzxPOwAWwAXPvA60AUgA3Q8IgC"
    "eP0wD+gFUP7oBQfz5gGv/1EAGv75DPUEQ/82AEP/9QQA5UD5wAaI52AD2AC49kgJKP+g/APrDwOU/+X/KQH89wQI1/4bAGwA"
    "8fwgCuD1oPyg/NwIvP5EAST3oPxsAGwAoPwAG+AQoPzABkD5YANYDuT9bAAo/3wFhPrYAJT/HAJA+UD5QPnYANgAQPmIAnj9"
    "M/rYAOX/5f/YADP6NwKv/1EAyf2A8sAGwAYI9bABKP84BDgEKP+wAZ32XwHK/xsAef+WA5YDef8bAMr/XwEANqAXwAagF+D1"
    "4PXUE/QC2AD0AtQTaPi8/rz+aPgAGyAlYAOA8oDyYAMQIKQEbABQ/sTzxPNQ/mwApARAFEAUgPIwD4gCiAIwDxj6UP4Y+vkM"
    "5gFRAFEA5gH5DAv7Q//K/0P/C/sAG0D5QPl4GGADKP+49rj2KP9gA/0UDwNsAOX/1/789/z31/7l/2wADwMgCuD1oPxgA9wI"
    "RAG8/iT3oPyU/2wAYAMAG+AQYAPABkD5oPxYDhwCbADYAHwFhPoo/5T/5P3ABkD5wAbYACj/QPl4/YgCzQXYABsA5f8o/zP6"
    "yf2v/1EANwKADcAGQPn4CrAB2AA4BMj7KP9Q/mMJXwE2ABsAhwCWA2r8ef/l/8r/of4ANqAXwAagFyAKIArUE/QC2AD0AtQT"
    "mAdEAUQBmAcAGyAlYAOA8oANoPwQIKQEbABQ/sTzPAywAZT/XPtAFEAUgA0wD4gCiAIwD+gFsAHoBfkM5gFRAFEA5gH5DPUE"
    "vQA2AL0A9QQAG0D5wAZ4GGADKP+49kgJ2ACg/P0UDwNsAOX/1/789wQIKQEbAJT/8fwgCuD1YAOg/NwIRAG8/iT3YANsAJT/"
    "oPwAG+AQYAPABsAGYANYDhwCbADYAHwFfAXYAGwAHALABkD5wAbYACj/QPmIAnj9zQXYABsA5f8o/zP6NwJRAK//yf2ADcAG"
    "wAb4CrAB2AA4BDgE2ACwAWMJXwE2ABsAhwCWA5YDhwAbADYAXwEANsAhIO8gCuAQQPkYFXT1VAbI+/QCjArI+xwCvP4AG+AQ"
    "oPzgEKD8jArk/RwCUP6MCuT9bABA+UD5yPs4BKD8yPvYAF39owLk/ZUB1/5d/YcAef9sAEDegA3A6+jqcAjI+4gCWPM4BFD+"
    "0fJGBV39lQHy/r0AF/ijAvL+hwCv/2ADoPxgAxwC5P2wAbz+HAKU/2wAABvgEED5YAMgCqD8jArI+xwCvP7YAFQG5P3YAJT/"
    "gPLABkD5kPc4BHj9sAHI+7ABKP+6+qMCa/4OAUP/hwBd/Q4Bef9RAMr/QPlA+cj72AAo/8j72ABd/YcAef9sAK//Xf2HAOX/"
    "GwAANsAhIO8gCiDvwAYYFXT1VAbI+/QCdPU4BOT9RAEAG+AQoPwg72ADjArk/RwCUP509RwClP9A+cAGyPs4BKD8OAQo/139"
    "owLk/ZUB1/6jAnn/hwCU/0DegA1AFOjqcAjI+4gCqAzI+7AB0fJGBV39lQHy/r0A6Qdd/Q4Bef9RAGADoPyg/BwC5P2wAbz+"
    "5P1sAJT/ABvgEED5YAPg9WADjArI+xwCvP7YAKz5HAIo/2wAgPLABsAGkPc4BHj9sAE4BFD+2AC6+qMCa/4OAUP/hwCjAvL+"
    "hwCv/zYAQPnABsj72AAo/zgEKP9d/YcAef9sAK//owJ5/xsA5f8ANgDlgPKA8oANwAZAFMAGgPJA+aD84PWA8qD8wAZgA2AD"
    "sAEQBcAG0AuwAaD8UP7w+lD+KP94/aD8GPq49ij/sAHYAIgCYAMAG4DyABuA18AGgPJA+UAUQPmg/MAGYAMgCuD1YANA+bAB"
    "oPxQ/vD6QPkQBVD+YAOwASj/sAHYAIgCYAPoBXj92ABQ/ij/eP2ADYDyQPlA+cAGYANgA8AGoPyg/FD+UP6g/PD6sAGwAbAB"
    "2ADYALABiAI4BCj/KP8o/1D+ABuA8oDywAbABsAGQPmg/KD8oPyg/GADsAGwAbABYAOwAVD+UP4o/yj/KP9Q/nj9KP/YANgA"
    "2AAANgDlgPKADYANwAZAFED5gA1A+aD84PWA8mADQPmg/GADsAEQBcAG0AtQ/mADsAEQBVD+KP94/aD8GPq49tgAUP4o/3j9"
    "oPwAG4DyABuAKMAGgPJA+cDrwAag/MAGYAMgCiAKoPzABrABoPxQ/vD6QPnw+rABoPxQ/ij/sAHYAIgCYAPoBYgCKP+wAdgA"
    "iAKADYANQPlA+UD5YANgA8AGYANgA1D+UP6g/PD6UP5Q/lD+2ADYALABiAI4BNgA2ADYALABABuA8oANwAbABkD5wAag/KD8"
    "oPxgA6D8sAGwAbABYANQ/rABsAEo/yj/KP9Q/nj92AAo/yj/KP8ANgAbgPKA8oANQPlAFED5gPLABqD8IAqA8qD8QPlgA2AD"
    "UP4QBUD50AtQ/qD8sAHw+rABKP+IAqD86AW49ij/UP7YAHj9YAMAG4ANABuA18AGgA1A+cDrQPlgA8AGoPwgCuD1oPxA+bAB"
    "YANQ/hAFQPnw+lD+oPywAdgAsAEo/4gCoPzoBXj9KP9Q/tgAeP2ADYDywAZA+UD5YAOg/MAGoPyg/LABUP5gA/D6UP5Q/rAB"
    "2AAo/7ABeP04BCj/KP/YAFD+ABuADYDywAbABkD5QPlgA2ADoPyg/KD8sAGwAVD+YANQ/lD+UP7YANgAKP+wAXj9KP8o/yj/"
    "2AAANgAbgPKADYANQPlAFMAGgA3ABqD8IAqA8mADwAag/GADUP4QBUD50AuwAWADUP4QBbABKP+IAqD86AW49tgAsAEo/4gC"
    "oPwAG4ANABuAKMAGgA1A+UAUwAZgA8AGoPwgCiAKYAPABrABYANQ/hAFQPkQBbABYANQ/tgAsAEo/4gCoPzoBYgC2ACwASj/"
    "iAKADYANwAZA+cAGYAOg/MAGYANgA7ABUP5gA/D6sAGwAVD+2AAo/7ABeP04BNgA2AAo/7ABABuADYANwAbABsAGwAZgA2AD"
    "oPxgA2ADsAGwAVD+YAOwAbABsAHYANgAKP+wAXj92ADYANgAKP8ANsAh4BAgCiDvQPkYFYwKVAY4BPQCdPXI++T9vP4AG+AQ"
    "oPwg76D8jArk/eT9UP509eT9bABA+UD5yPvI+6D8yPvYAF39Xf3k/Wv+1/5d/YcAhwBsAMAhgA3A6xgVcAg4BIgCWPPI+1D+"
    "Lw1GBaMClQEOAb0AF/hd/fL+ef+v/6D8oPyg/OT95P1Q/rz+5P1sAGwAABvgEMAGYAPg9aD8jAo4BBwCRAHYAKz55P0o/5T/"
    "gA3ABkD5cAg4BIgCsAHI+1D+KP9GBaMClQEOAb0AhwBd/fL+ef+v/8r/wAZA+TgEKP8o/8j7KP+jAnn/ef+U/6//Xf15/xsA"
    "GwAANsAh4BAgCuAQwAYYFYwKVAY4BPQCjAo4BBwCRAEAG+AQoPzgEGADjArk/eT9UP6MChwClP9A+cAGyPvI+6D8OAQo/139"
    "Xf3k/Wv+1/6jAnn/ef+U/8AhgA1AFBgVcAg4BIgCqAw4BLABLw1GBaMClQEOAb0A6QejAg4BhwBRAKD8oPxgA+T95P1Q/rz+"
    "HAKU/5T/ABvgEMAGYAMgCmADjAo4BBwCRAHYAFQGHALYAGwAgA3ABsAGcAg4BIgCsAE4BLAB2ABGBaMClQEOAb0AhwCjAg4B"
    "hwBRADYAwAbABjgEKP8o/zgE2ACjAnn/ef+U/6//owKHAOX/5f8ANoDyABuADUAUQPmADYANwAaA8iAKoPzABqD8wAZgA9AL"
    "QPkQBVD+YAMQBVD+YAOwAbj26AWg/IgCKP+wAaD8iAIo/7AB2AAAG4DXgA0A5QAbwOvABsAGgPJg6IAN4PVgA+D1YANA+ZAS"
    "MPTABvD6sAHABvD6sAGg/NDwSAkY+mADeP3YABj6YAN4/dgAUP6A8oDywAZA+UD5QPlgA6D8oPyg/BAFoPywAVD+sAFQ/lD+"
    "yPuIAlD+2AAo/1D+2AAo/yj/ABuA8oANgA1A+cAGwAbg9cAGoPxgA6D8YANwCPD6YANQ/rABYANQ/rABQPk4BHj9sAEo/9gA"
    "eP2wASj/2AAANoDyABuA8kAUQPmADYDyQPmA8iAKoPzABmADQPmg/NALQPkQBVD+YAPw+rABoPxQ/rj26AWg/IgCKP+wAWAD"
    "eP3YAFD+KP8AG4DXgA0AGwAbwOvABkD5gA1g6IAN4PVgAyAKoPzABpASMPTABvD6sAFA+RAFUP5gA9DwSAkY+mADeP3YAOgF"
    "oPyIAij/sAGA8oANwAZA+cAGQPlgA6D8YANgAxAFoPywAVD+UP6wAbAByPuIAlD+2AAo/7ABKP/YANgAABuA8oANgA1A+cAG"
    "QPng9cAGoPxgA2ADoPxwCPD6YANQ/rABoPywAVD+QPk4BHj9sAEo/9gAiAJQ/tgAKP8ANqAX4PXABsAG4PXUE2j49AK8/tgA"
    "9AK8/tgAvP4AG4DyYANgA2ADgPLE86QEUP5sAGwAUP5sAGwAUP7A64ANwOvQ8OgFeP2wAXj9sAF4/Qfz9QQa/r0Ar/82ABr+"
    "vQCv/zYAr//ABsAGAOVICaD82ADYANgA2ACg/AQI8fwpAZT/GwAbACkBlP8bABsAlP/g9WADoPwk92ADvP5sALz+bACU/wAb"
    "wAag/GADYANA+XwF5P3YAJT/bADYAJT/bAAo/8AGQPnABnj92ADYACj/zQXJ/dgAr/8bANgAr/8bAOX/QPnABoDyyPuwASj/"
    "2AAo/9gAUP5q/F8Bef82AOX/GwB5/zYA5f8bAMr/ADagF+D1wAZA+SAK1BNo+PQCvP7YAAz9RAEo/0QBABuA8mADYAOg/IAN"
    "xPOkBFD+bABsALABlP+U/7ABwOuADUAU0PDoBXj9sAGIAlD+iAIH8/UEGv69AK//NgDmAUP/UQDK/1EAwAbABgAbSAmg/NgA"
    "2AAo/yj/YAMECPH8KQGU/xsAGwDX/mwA5f/l/2wA4PVgA2ADJPdgA7z+bABEAZT/bAAAG8AGoPxgA6D8wAZ8BeT92ACU/2wA"
    "KP9sAJT/2ADABsAGwAZ4/dgAKP/YAM0Fyf3YAK//GwAo/1EA5f8bAED5wAaADcj7sAEo/9gA2AAo/7ABavxfAXn/NgDl/xsA"
    "hwDK/xsA5f82AAA2oBcgCsAGQPng9dQTmAf0AkQB2AAM/bz+KP+8/gAbgPKg/GADoPyA8sTzXPtQ/pT/bACwAWwAlP9Q/kAU"
    "gA3A6zAP6AWIArABeP1Q/nj9+Qz1BOYBvQBRADYAGv5D/6//yv+v/0D5wAYA5bj2oPwo/9gA2AAo/6D8/Pfx/Nf+lP/l/xsA"
    "KQFsABsA5f+U/+D1oPyg/CT3oPy8/pT/RAFsAJT/ABvABmADYAOg/ED5fAUcAtgAbABsACj/lP+U/yj/QPlA+UD5eP0o/9gA"
    "KP8z+sn9KP+v/+X/2ABRABsA5f/ABsAGgPI4BLAB2ADYACj/KP9Q/pYDXwGHADYAGwAbAHn/yv/l/+X/yv8ANqAXIArABsAG"
    "IArUE5gH9AJEAdgA9AJEAdgARAEAG4DyoPxgA2ADgA3E81z7UP6U/2wAUP6U/2wAsAFAFIANQBQwD+gFiAKwAYgCsAGIAvkM"
    "9QTmAb0AUQA2AOYBvQBRADYAUQBA+cAGABu49qD8KP/YACj/2ABgA/z38fzX/pT/5f8bANf+lP/l/xsAbADg9aD8YAMk96D8"
    "vP6U/7z+lP9sAAAbwAZgA2ADYAPABnwFHALYAGwAbADYAGwAbADYAED5wAZA+Xj9KP8o/9gAM/rJ/Sj/r//l/yj/r//l/xsA"
    "wAbABoANOASwAdgA2ADYANgAsAGWA18BhwA2ABsAGwCHADYAGwAbADYAADaADQAbgA1AFMAGgA2A8sAGgA0gCmADwAag/ED5"
    "YAPQC8AGEAWwAWAD8PpQ/qD8sAFICegFYAOIAtgAsAGg/Hj9KP9Q/tgAABuAKIANAOUAG0AUwAZA+YDyoBeADSAKYAPg9aD8"
    "QPmQEtALwAYQBbABQPnw+lD+oPwwD0gJ6AVgA4gC2AAY+qD8eP0o/1D+gA2A8sAGwAZA+cAGYANgA6D8oPwQBWADsAGwAVD+"
    "UP5Q/jgEiAKwAdgA2ABQ/ij/KP8o/wAbgA2ADYANwAbABkD5IArABmADYAOg/KD8cAgQBWADsAGwAaD8UP5Q/sAGOASIArAB"
    "2ADYAHj9UP4o/yj/ADaADQAbgPJAFMAGgA2ADUD5gA0gCmADwAZgA8AGoPzQC8AGEAWwAWADEAWwAWADUP5ICegFYAOIAtgA"
    "sAFgA4gC2ACwASj/ABuAKIANABsAG0AUwAbABoANoBeADSAKYAMgCmADwAaQEtALwAYQBbABwAYQBbABYAMwD0gJ6AVgA4gC"
    "2ADoBWADiALYALABgA2ADcAGwAbABsAGYANgA2ADYAMQBWADsAGwAbABsAGwATgEiAKwAdgA2ACwAdgA2ADYAAAbgA2ADYAN"
    "wAbABsAGIArABmADYANgA2ADcAgQBWADsAGwAWADsAGwAcAGOASIArAB2ADYAIgCsAHYANgAADYAGwDuABsAFQD3AAYA9wAV"
    "ABsAJAD3APcAIQD0AAMAAwD0APcA9wD0AAMAAwD0APUABAD/AP8ABAD1AOUAEgDrAAkA+gAJAO4ABwD9AAIA/QAHAAkA9wAJ"
    "AP0AAwD3ABsAEgD3AAkADwD6AAMA/QAGAPcACQD6AAMA/QAGAPsAAgD/AAEA/gAFAPcA9wADAP0A+AADAP8AAQD9ADYAGwAS"
    "ABsAFQAJAAYACQAVABsAJAAJAPcAIQAMAAMA/QD0AAkA9wAMAAMA/QD0AAsABAABAP8A/AD1ABsAEgAVAAkABgAJABIABwAD"
    "AAIAAwAHAAkA9wAJAAMA/QD3ABsAEgAJAAkADwAGAAMAAwAGAAkACQAGAAMAAwAGAAUAAgABAAEAAgAFAAkACQADAP0ACAAD"
    "AAEA/wD9ADYgCkD5IArgECDv9AK8/tgAvP70AjgE5P0cAsj7ABug/KD8gA0g71D+bABsAFD+pATk/RwCrPnABsAGYAMo/yj/"
    "YAM4BMj7KQGU/xsAGwCU/ykBlQF5/4cAa/6A8kAUQN54/bABeP3oBcj7OASQ90P/UQDK/1EAQ//mAfL+hwB5/w4BXf2g/GAD"
    "oPyg/Lz+bACU/0QBUP5sAGwAUP4AG2ADoPzABsAG4PXYAJT/bAAo/xwCRAEo/0QBDP1A+cAGgPJQ/tgAKP+wAXj9sAF4/Xn/"
    "NgDl/xsAyv+HAEP/UQDK/1EAQ//ABkD52AAo/4gC2ADYAKD8UQDl/xsAr//YAGwA5f/l/2wA1/4ANoANgA0A5UAUgPJAFED5"
    "QPmADaD8oPyADeD1wAbg9dAL8PpgA/D60AtA+bABsAFA+UgJoPzYANgAoPxICRj6iAJQ/ogCGPoAGwDlgCiA8kD5QPkAG4AN"
    "wOvg9cAG4PWgF2ADYAOA8kD5sAGwAUD5kBIQBaD8EAUw9Bj6iAJQ/ogCGPowD2ADKP8o/2ADuPaA8oANQPnABsAGQPlA+WAD"
    "oPzABmADoPzw+rABUP4QBWADUP6wAaD8yPuwASj/2ABQ/jgEiAIo/9gAeP0AG4ANgPLABkD5gA1A+WADoPwgCqD8YANA+WAD"
    "UP6wAaD8cAhQ/rAB8PqIAij/2AB4/cAGUP7YACj/sAHI+wA2gA2ADQAbQBSA8kAUwAbABoANoPyg/IANIApA+SAK0Avw+mAD"
    "8PrQC8AGUP5Q/sAGSAmg/NgA2ACg/EgJ6AV4/bABeP3oBQAbAOWAKIANQPlA+QAbgPJAFOD1wAbg9aAXoPyg/IANQPmwAbAB"
    "QPmQEvD6YAPw+tALGPqIAlD+iAIY+jAPoPzYANgAoPxICYDygA1A+cAGQPnABkD5YAOg/MAGoPxgA/D6sAFQ/hAFoPywAVD+"
    "YAPI+7ABKP/YAFD+OAR4/dgAKP+IAgAbgA2ADcAGQPmADcAGYAOg/CAKYAOg/MAGYANQ/rABoPxwCLABUP4QBYgCKP/YAHj9"
    "wAawASj/2ABQ/jgEADYgCkD5IAog7+AQ9AK8/tgAvP70Asj7HALk/TgEABug/KD8gA3gEFD+bABsAFD+pAQcAuT9VAbABsAG"
    "YAMo/yj/YAPI+zgEKQGU/xsAGwCU/ykBa/6HAHn/lQGA8kAUwCF4/bABeP3oBTgEyPtwCEP/UQDK/1EAQ//mAQ4Bef+HAPL+"
    "owKg/GADYANgA7z+bACU/0QBsAGU/5T/sAEAG2ADoPzABkD5IArYAJT/bAAo/xwCvP7YALz+9AJA+cAGgA1Q/tgAKP+wAYgC"
    "UP6IAnn/NgDl/xsAyv+HAL0Ar/82AK//vQDABsAG2AAo/4gCKP8o/2ADUQDl/xsAr//YAJT/GwAbAJT/KQEANiAKwAYgCiDv"
    "IO/0AkQB2ABEAfQCyPvk/eT9yPsAG6D8YAOADSDvUP6U/2wAsAGkBBwC5P2s+UD5wAag/Cj/2ABgAzgEyPvX/pT/5f8bAGwA"
    "KQGVAYcAef9r/oANQBRA3ogCsAGIAugFyPvI+5D3vQBRADYAUQC9AOYB8v55/3n/8v5d/aD8YANgA6D8vP6U/2wARAGwAWwA"
    "lP9Q/gAbYANgA8AGQPng9dgAbABsANgAHAK8/ij/vP4M/cAGwAaA8rAB2ADYALABeP1Q/nj9hwA2ABsAGwA2AIcAQ/+v/8r/"
    "r/9D/8AGQPko/9gAiALYACj/oPyv/+X/GwBRANgAbAAbAOX/lP/X/gA2gPKADQDlQBSADUAUwAZA+YDyoPxgA4AN4PVA+eD1"
    "0AsQBWADEAXQC8AGsAFQ/kD5uPag/Cj/2ABgA0gJGPp4/VD+eP0Y+gAbABuAKIDyQPnABgAbgPLA6yAKwAYgCqAXYAOg/IDy"
    "QPlQ/rABwAaQEvD6oPzw+jD06AWIArABiALoBTAPYAPYACj/oPy49oANgA1A+cAGQPlA+cAGYANgA8AGYAOg/PD6UP6wARAF"
    "oPxQ/lD+oPw4BLAB2ADYALABOASIAtgAKP94/QAbgA2A8sAGwAaADUD5oPxgAyAKoPyg/ED5YAOwAbABYANwCLABUP7w+nj9"
    "KP/YAIgCwAZQ/ij/KP9Q/sj7ADaA8oANABtAFIANQBRA+cAGgPKg/GADgA0gCsAGIArQCxAFYAMQBdALQPlQ/rABwAa49qD8"
    "KP/YAGADSAnoBYgCsAGIAugFABsAG4AogA1A+cAGABuADUAUIArABiAKoBeg/GADgA1A+VD+sAHABpASEAVgAxAF0AvoBYgC"
    "sAGIAugFMA+g/Cj/2ABgA0gJgA2ADUD5wAbABsAGwAZgA2ADwAag/GAD8PpQ/rABEAVgA7ABsAFgAzgEsAHYANgAsAE4BHj9"
    "KP/YAIgCABuADYANwAbABoANwAag/GADIApgA2ADwAZgA7ABsAFgA3AIUP6wARAFeP0o/9gAiALABrAB2ADYALABOAQANiAK"
    "wAYgCuAQ4BD0AkQB2ABEAfQCOAQcAhwCOAQAG6D8YAOADeAQUP6U/2wAsAGkBOT9HAJUBkD5wAag/Cj/2ABgA8j7OATX/pT/"
    "5f8bAGwAKQFr/nn/hwCVAYANQBTAIYgCsAGIAugFOAQ4BHAIvQBRADYAUQC9AOYBDgGHAIcADgGjAqD8YAOg/GADvP6U/2wA"
    "RAFQ/pT/bACwAQAbYANgA8AGwAYgCtgAbABsANgAHAJEAdgARAH0AsAGwAaADbAB2ADYALABiAKwAYgChwA2ABsAGwA2AIcA"
    "vQBRADYAUQC9AMAGwAYo/9gAiAIo/9gAYAOv/+X/GwBRANgAlP/l/xsAbAApAQA2ABIA7gASABIA7gAGAPoABgD6AAYABgD6"
    "AAYA+gAbAAkA9wAJAAkA9wADAP0AAwD9AAMAAwD9AAMA/QDuABIA7gD6AAYA+gAGAPoABgD6AP4AAgD+AAIA/gACAP4AAgD+"
    "AAIA/gD3AAkA9wD9AAMA/QADAP0AAwD9AP8AAQD/AAEA/wABAP8AAQD/AAEA/wAbAAkA9wAJAAkA9wADAP0AAwD9AAMAAwD9"
    "AAMA/QD3AAkA9wD9AAMA/QADAP0AAwD9AP8AAQD/AAEA/wABAP8AAQD/AAEA/wA2ABsA5QAbgA2A8oANgPKADQAbgA2A8oAN"
    "wAZA+cAGQPnABgDlABuA8oANgPKADUD5wAZA+cAGQPnABoDygA1A+cAGQPnABqD8YAOg/GADoPxgAwAbgA2A8oANwAZA+cAG"
    "QPnABoDygA1A+cAGQPnABqD8YAOg/GADoPxgAwA2ABIA7gASAO4AEgAGAPoABgD6AAYA+gAGAPoABgAbAAkA9wAJAPcACQAD"
    "AP0AAwD9AAMA/QADAP0AAwDuABIAEgD6AAYA+gAGAAYA+gAGAP4AAgD+AAIA/gACAAIA/gACAP4AAgD3AAkACQD9AAMA/QAD"
    "AAMA/QADAP8AAQD/AAEA/wABAAEA/wABAP8AAQAbAAkA9wAJAPcACQADAP0AAwD9AAMA/QADAP0AAwD3AAkACQD9AAMA/QAD"
    "AAMA/QADAP8AAQD/AAEA/wABAAEA/wABAP8AAQA2ABsA5YANgPIAG4ANgPLABkD5ABsA5YANgPLABkD5gA2A8sAGQPlgA6D8"
    "ABuADYDywAZA+YANgPLABkD5YAOg/AA2ADYANgA2ADYANgAbABsAGwAbABsAGwAbABsAGwAbABsAGwA2ABsAG4ANgA0AG4AN"
    "gA3ABsAGABsAG4ANgA3ABsAGgA2ADcAGwAZgA2ADABuADYANwAbABoANgA3ABsAGYANgAwA2ABIAEgASAO4A7gAGAAYABgAG"
    "AAYA+gD6APoA+gAbAAkACQAJAPcA9wADAAMAAwADAAMA/QD9AP0A/QASABIA7gAGAAYABgAGAPoA+gD6AAIAAgACAAIAAgAC"
    "AP4A/gD+AP4A/gAJAAkA9wADAAMAAwADAP0A/QD9AAEAAQABAAEAAQABAP8A/wD/AP8A/wAbAAkACQAJAPcA9wADAAMAAwAD"
    "AAMA/QD9AP0A/QAJAAkA9wADAAMAAwADAP0A/QD9AAEAAQABAAEAAQABAP8A/wD/AP8A/wA2ABsAGwAbgA2ADYANgA2ADQAb"
    "gA2ADYANwAbABsAGwAbABgAbABuADYANgA2ADcAGwAbABsAGwAbABoANgA3ABsAGwAbABmADYANgA2ADYANgAwAbgA2ADYAN"
    "wAbABsAGwAbABoANgA3ABsAGwAbABmADYANgA2ADYANgAwA2ABIAEgASABIAEgAGAAYABgAGAAYABgAGAAYABgAbAAkACQAJ"
    "AAkACQADAAMAAwADAAMAAwADAAMAAwASABIAEgAGAAYABgAGAAYABgAGAAIAAgACAAIAAgACAAIAAgACAAIAAgAJAAkACQAD"
    "AAMAAwADAAMAAwADAAEAAQABAAEAAQABAAEAAQABAAEAAQAbAAkACQAJAAkACQADAAMAAwADAAMAAwADAAMAAwAJAAkACQAD"
    "AAMAAwADAAMAAwADAAEAAQABAAEAAQABAAEAAQABAAEAAQA2IAog78AhwAYg7/QCyPtUBnT1GBVEAeT9OAR09QAbgA0g7+AQ"
    "YAOkBKz5cAh09YwKsAHk/RwCQPnABqD8OATI+yj/OATX/pUB5P2jAl39lP+HAHn/owLA68AhgPIY+nAIWPMYFXj9OASQ9xr+"
    "owJP/EYFF/gvDUP/DgFr/qMCuvpgA6D8YANEAVD+HALk/WwAlP8cAgAbwAbg9eAQYANA+RwCDP04BKz5jArYALz+HALI+0D5"
    "gA1A+VD+iALI+3AIKP+wAcj7ef+9APL+lQFd/UYFyv9RAHn/DgFd/UD5wAZ4/WADyPs4BCj/2AAo/ykBa/4cAl39owKv/2wA"
    "ef+HAAA2IAog78AhQPngEPQCyPtUBnT1GBW8/hwCyPuMCgAbgA0g7+AQoPykBKz5cAh09YwKUP4cAuT9QPlA+aD8OATI+9gA"
    "yPvX/pUB5P2jAl39bAB5/4cAXf3A68AhgA0Y+nAIWPMYFYgCyPtwCBr+owJP/EYFF/gvDb0A8v6VAV39RgVgA6D8oPxEAVD+"
    "HALk/ZT/bADk/QAbwAbg9eAQoPzABhwCDP04BKz5jAoo/0QB5P04BED5gA3ABlD+iALI+3AI2ABQ/jgEef+9APL+lQFd/UYF"
    "NgCv/4cA8v6jAkD5wAZ4/WADyPs4BNgAKP8o/ykBa/4cAl39owJRAJT/hwB5/wA2IArgEMAhQPkg7/QCOARUBowKGBW8/uT9"
    "yPt09QAbgA3gEOAQoPykBFQGcAiMCowKUP7k/eT9wAbABmADOAQ4BCj/OAQpAZUBHAKjAqMClP95/3n/owJAFMAhgPLoBXAI"
    "qAwYFXj9yPuQ9+YBowKxA0YF6QcvDUP/8v5r/l39uvpgA2ADYANEAbABHAIcApT/lP8cAgAbwAYgCuAQoPxA+RwC9AI4BFQG"
    "jAoo/7z+5P3I+8AGgA1A+bABiAI4BHAIKP9Q/sj7hwC9AA4BlQGjAkYFyv+v/3n/8v5d/cAGwAaIAmADOAQ4BCj/KP/YACkB"
    "lQEcAqMCowKv/5T/ef95/wA2IArgEMAhwAbgEPQCOARUBowKGBVEARwCOASMCgAbgA3gEOAQYAOkBFQGcAiMCowKsAEcAhwC"
    "wAZA+WADOAQ4BNgAyPspAZUBHAKjAqMCbACHAIcAXf1AFMAhgA3oBXAIqAwYFYgCOARwCOYBowKxA0YF6QcvDb0ADgGVAaMC"
    "RgVgA2ADoPxEAbABHAIcAmwAbADk/QAbwAYgCuAQYAPABhwC9AI4BFQGjArYAEQBHAI4BMAGgA3ABrABiAI4BHAI2ACwATgE"
    "hwC9AA4BlQGjAkYFNgBRAIcADgGjAsAGwAaIAmADOAQ4BNgA2ADYACkBlQEcAqMCowJRAGwAhwCHAAA2wAbg9aAXIApA+dgA"
    "vP70Amj41BNEASj/RAEM/QAbYAOA8iAloPyg/GwAUP6kBMTzECCU/5T/sAFc+4DyQBTA61D+iAIY+jAPeP2wAXj9yv9RAEP/"
    "5gEL+/kMr/82AK//vQAa/kD5ABvABij/YAO49ngY2ADYAKD85f9sANf+DwP89/0UGwAbAJT/KQHx/KD8IAqg/JT/RAGg/NwI"
    "lP9sALz+ABtgA0D54BBgA6D8bAAo/xwChPpYDmwAlP/YAOT9wAbABtgAeP3ABtgAKP8bAK//2ADJ/c0FGwDl/1EAKP9A+YAN"
    "QPko/7AByPv4Cij/2ABQ/uX/NgB5/18BavxjCeX/GwDK/4cAof4ANsAG4PWgF+D1wAbYALz+9AJo+NQTvP7YALz+9AIAG2AD"
    "gPIgJWADYANsAFD+pATE8xAgbABsAFD+pASA8kAUQBRQ/ogCGPowD4gCUP6IAsr/UQBD/+YBC/v5DFEAyv9RAEP/5gFA+QAb"
    "QPko/2ADuPZ4GCj/KP9gA+X/bADX/g8D/Pf9FOX/5f9sANf+DwOg/CAKYAOU/0QBoPzcCGwAlP9EAQAbYANA+eAQoPxgA2wA"
    "KP8cAoT6WA6U/2wAKP8cAsAGQPnYAHj9wAYo/9gAGwCv/9gAyf3NBeX/GwCv/9gAQPmADcAGKP+wAcj7+ArYACj/sAHl/zYA"
    "ef9fAWr8YwkbAOX/NgB5/18BADbABiAKoBfg9UD52ABEAfQCmAfUE7z+KP+8/gz9ABtgA4ANICVgA6D8bACwAaQEPAwQIGwA"
    "lP9Q/lz7gA1AFMDrsAGIAugFMA94/VD+eP02AFEAvQDmAfUE+Qyv/8r/r/9D/xr+wAYAG8AG2ABgA0gJeBjYACj/oPwbAGwA"
    "KQEPAwQI/RQbAOX/lP/X/vH8YAMgCmADbABEAWAD3AhsAJT/vP4AG2ADwAbgEKD8oPxsANgAHAJ8BVgOlP+U/yj/5P3ABsAG"
    "2ACIAsAG2AAo/xsAUQDYADcCzQUbAOX/r/8o/8AGgA1A+dgAsAE4BPgKKP8o/1D+GwA2AIcAXwGWA2MJ5f/l/8r/ef+h/gA2"
    "wAYgCqAXIArABtgARAH0ApgH1BNEAdgARAH0AgAbYAOADSAloPxgA2wAsAGkBDwMECCU/2wAsAGkBIANQBRAFLABiALoBTAP"
    "iAKwAYgCNgBRAL0A5gH1BPkMUQA2AFEAvQDmAcAGABtA+dgAYANICXgYKP/YAGADGwBsACkBDwMECP0U5f8bAGwAKQEPA2AD"
    "IAqg/GwARAFgA9wIlP9sAEQBABtgA8AG4BBgA2ADbADYABwCfAVYDmwAbADYABwCwAZA+dgAiALABij/2AAbAFEA2AA3As0F"
    "5f8bAFEA2ADABoANwAbYALABOAT4CtgA2ACwARsANgCHAF8BlgNjCRsAGwA2AIcAXwEANgAbAO4AFQD3ABsAJAD3ACEA9AAJ"
    "AAkADAD9AAsA/AAbAO4AFQD3ABIA+QAJAAkA/QAbABIA9wAPAPoACQD3AAYA/QAFAP4ACQAJAP0ACAD9ADYAGwASABUACQAb"
    "ACQACQAhAAwACQD3AAwAAwALAAQAGwASABUACQASAAcACQAJAAMAGwASAAkADwAGAAkACQAGAAMABQACAAkACQADAAgAAwAE"
    "BQYHCBAREhMUFRYXGCQoKSorLDQ1Njc4OTo7PAECAwkKCwwNDg8ZGhscHR4fICEiIyUmJy0uLzAxMjM9Pj9AQUJDREVGRwAB"
    "AgMEBQYHCAkKCwwNDxAREhMWFxobHB8gISIlJissLS4vMDEzNDU4OTo8PT4/QEFCR0hLTE1OUVJTVldaW1xdXmBhYmNkZWZn"
    "aGlqa2xtAAAAAJReAQAAAADQXAAAAAAAAAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0ADgAPABAAEQASABMAFAAVABYAFwA"
    "YABkAGgAbACAAIQAAgAGAAoADgARABUAGQAdACEAJQApAC0AMQA1ADkAPQBBAEUASQBNAFIAVgBZAF0AYgBmAGkAbQB5AH0A"
    "ggCGAIkAjQCSAJYAmQCdALEAtQDaAN4ACvn//6rs///eAwAA9gYAALALAAAQGAAA0Pn//9Du//+gCQAAYBcAAMD3//8g7v//"
    "MPv//1D0//8AAAAAAAAAAED9//8g+f//EAIAANAEAAAAAAAAjAEAABACAABwAwAAAAAAAIwBAABgAQAAgAUAAAAAAAAAAAAA"
    "1AoAAGguAAC49v//LPX//1Dp//8w2v//wAIAAEApAAAg+f//QMb//5ASAABQFQAAQAgAACAPAABwAwAAUAoAAMACAAAAAAAA"
    "8P3//zD7//9qBQAAlvr//xD3//+Q/P//3gMAANry//9w+P//EPf//4wBAAC8BwAAvAcAALwHAABE+P//RPj//9D5//8w2v//"
    "EBgAAHADAADw5///kPz//zAGAADQJQAA0AQAAFAKAADQ+f//0O7//zAGAAAwEQAAMPv//7D1//8AAAAAAAAAAAAAAAAAAAAA"
    "jAEAALwHAAAAAAAAAAAAAHT+//9E+P//PhAAAIoqAACu/f//wu///3Di//9Q0///IAQAAEApAADQ7v//UMj//4AQAABAHgAA"
    "AAsAAAAhAADAAgAA4AYAANAEAAAwEQAAkPz//xD3//9SAgAA8vX//8D3//8g+f//UgIAAPL1//+wAAAAcO3//wAAAAAAAAAA"
    "RPj//0T4//+8BwAAvAcAAKAUAACAGwAAYOv//4Dk//+gCQAAwA0AAGD2//9A8v//EPf///Dn///wCAAAEBgAAPD9//+Q/P//"
    "EAIAAHADAACMAQAAvAcAAAAAAAAAAAAAdP7//0T4//8AAAAAAAAAAAAAAAAAAAAAvAcAALwHAABE+P//RPj//7D1///w5///"
    "UAoAABAYAACw9f//8Of//1AKAAAQGAAAwAIAAOAGAABA/f//IPn//8ACAADgBgAAQP3//yD5//8AAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQOf///AeAADQ+f//wBgAAJAdAAAw2v//UCsAADCj//9w4v//kEkAADDw//+QEgAA"
    "8Of//7AhAACQ/P//EOH//3Dt//9wOgAAEAIAAND5//+I8P//2BsAAGAXAABg6///5Ov//wwzAAAANwAAwJT//6QEAADM6P//"
    "zOj//zQXAAA0FwAAzOj//7AWAABwAwAAcMz//7AsAACQMwAAUNP//1Dp//+Q/P//gPr//yD5///AAgAAYCIAAED9//+g3f//"
    "gAUAAOAGAAAAAAAAAAAAAAAAAAAAAAAApAQAAMzo//8AAAAAAAAAAFz7//80FwAATBoAAAxt//+MAQAAHBQAAHD4//9QeAAA"
    "cPj//xDh//8QAgAAMFMAABACAADwu///8AgAAPDG///Q+f//kPz//9APAABQ0///sAAAAPAIAACkBAAA/O7//2ABAACgFAAA"
    "MAYAALj2//9A0f//AIQAAHT+//9E+P//RPj//0T4//+8BwAAvAcAAMACAAAgMAAAgOT//+AGAACAGwAAIPn//0D9///gz///"
    "8P3//9Du///wCAAAUAoAABD3//+w9f//EAIAADARAAAAAAAAAAAAAAAAAAAAAAAAdP7//0T4//8AAAAAAAAAAIwBAAC8BwAA"
    "oPP//4jw///o/P//YAwAALAWAABQCgAAMAYAABDh//8wBgAAECMAALD1///Q+f//0Pn//1Dp///w/f//sPX///D9//+w9f//"
    "EAIAABACAABc+///7A0AAEAIAAAAAAAAXPv//+wNAAAAAAAAQAgAAAAAAAAAAAAANBcAAMzo///M6P//NBcAAHDM//+Q/P//"
    "kDMAAHADAABQ6f//sCwAALAWAABQ0///kAcAAJAzAABw+P//cMz//7AAAACw9f//UP///1AKAACkBAAAzOj//wAAAAAAAAAA"
    "XPv//zQXAAAAAAAAAAAAAAAAAAAAAAAAzOj//zQXAAA0FwAAzOj//4AbAABg6///gOT//6AUAACAGwAAYOv//4Dk//+gFAAA"
    "sAAAAJD8//9Q////cAMAALAAAACQ/P//UP///3ADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "vAcAALwHAABE+P//RPj//9Du///Q7v//MBEAADARAADw8v//8Of//xANAAAQGAAAYAwAAMANAACg8///QPL//6D+///ADQAA"
    "YAEAAEDy//90/v//RPj//wAAAAAAAAAAjAEAALwHAAAAAAAAAAAAAAAAAAAAAAAARPj//0T4//+8BwAAvAcAAFAKAADwHgAA"
    "sPX//xDh//9QCgAA8B4AALD1//8Q4f//8P3//7D1//8QAgAAUAoAAPD9//+w9f//EAIAAFAKAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2vL//+7k//9qBQAAJg0AAOARAABAKQAAUPT///Dn//+AEAAAwCMAAPDy//9w4v//"
    "wPf//yDu//8AAAAAAAAAADD7//+w9f//cAMAAJAHAADGAAAAxgAAAMACAADgBgAAxgAAAMYAAABwAwAAMAYAAAAAAAAAAAAA"
    "nhwAAEYyAADy9f//YuP//8Dh//9gtP//ABYAAIAbAACw3///8NH///ATAAAQOQAAsAsAADAcAADgBgAAwA0AAGABAADgBgAA"
    "kPz//3D4//8AAAAA1AoAAND5///w5///XPv//xgDAADA9///oOj//6QEAAC8BwAAvAcAADQXAABE+P//zOj//wDq//+g3f//"
    "wA0AAOA9AABA8v//IML//wAWAABgIgAAkAcAADARAABQ9P//8Of//7ALAAAQGAAAcPj//9Du//8AAAAAAAAAAAAAAAAAAAAA"
    "pAQAALwHAAAAAAAAAAAAAFz7//9E+P//ZB0AAOA9AAC49v//FPL//+Da///An///sBYAAPAeAACQ2///MLn//2AXAABgOAAA"
    "ABYAAAAsAADQBAAAUAoAAAALAACgFAAA0Pn///Dy//8i/P//xgAAAHD4///w5///Ivz//8YAAAAQ9///cPj//wAAAAAAAAAA"
    "RPj//8zo//+8BwAANBcAABAYAABQQQAA8Of//7C+//+wCwAA8B4AAFD0//8Q4f//gO///6Dd//+AEAAAYCIAAED9//8g+f//"
    "wAIAAOAGAACkBAAAvAcAAAAAAAAAAAAAXPv//0T4//8AAAAAAAAAAAAAAAAAAAAAvAcAADQXAABE+P//zOj//9Du//8w2v//"
    "MBEAANAlAADQ7v//MNr//zARAADQJQAA0AQAAFAKAAAw+///sPX//9AEAABQCgAAMPv//7D1//8AAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAMAAJjR//9ICQAA6Pz//+D7//8ANwAAQOf//+A9AAAAFgAA4Nr//2ABAADA4f//"
    "0AQAALDU///Q7v//8Of///ATAADQ7v//8P3//xACAAAwBgAAQOf//2ABAAAgMAAAeA8AAEDn///g5f//4FMAALj2//8AAAAA"
    "AAAAAJjR//8AAAAAaC4AABANAABwOgAAkPz//3CV//9wAwAAkGoAAPDy//+Qxf//0Pn//9Du//+QEgAAEBgAAHDt///w5///"
    "MAYAADARAAAAAAAAAAAAAAAAAAAAAAAAuPb//wAAAAAAAAAAAAAAAEgJAAAAAAAArMP//0T4///UCgAA7A0AAGA4AABAKQAA"
    "wOz//6Dd//+gKgAAwC4AAADf//8g4///8Of//9D5//8w+///0O7//5Dx//8wEQAA0AQAADAGAADQ+f//GAMAAAALAADADQAA"
    "dP7//9QKAACgKgAAIM3//1z7//9E+P//RPj//8zo//+8BwAANBcAAHAZAADwHgAAsPX//7C+//9QCgAAUEEAAJDm//8Q4f//"
    "YPb//0Dy//+gCQAAgBsAAGD2//+A5P//oAkAAMANAAAAAAAAAAAAAAAAAAAAAAAAXPv//0T4//8AAAAAAAAAAKQEAAC8BwAA"
    "FPL//1TZ//+kBAAAdP7//4AQAADgPQAAoPP//wAAAACgFAAAACEAAMD3//8g4///kPH//zDl///Q+f//sPX//9D5//+w9f//"
    "EAIAADAGAACkBAAAXPv//yAEAACgFAAApAQAAFz7//8gBAAAIAQAAAAAAAAAAAAAAAAAAGguAAAAAAAAmNH//4Dk//9gff//"
    "gBsAAKCCAAAACwAAoN3//wD1//9gIgAAkB0AALAsAABw4v//UNP//zD7//+Q/P//0AQAAHADAAC49v//AAAAAAAAAAAAAAAA"
    "SAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJjR//8AAAAAaC4AAHADAABwOgAAkPz//5DF//9wAwAAcDoAAJD8//+Qxf//"
    "oP7//wAAAABgAQAAAAAAAKD+//8AAAAAYAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "vAcAADQXAABE+P//zOj//9Du//9wzP//MBEAAJAzAABw7f//UNP//5ASAACwLAAAEA0AANAlAADw8v//MNr//zAGAABwAwAA"
    "0Pn//5D8//9c+///RPj//wAAAAAAAAAApAQAALwHAAAAAAAAAAAAAAAAAAAAAAAARPj//8zo//+8BwAANBcAAKAUAABAKQAA"
    "YOv//8DW//+gFAAAQCkAAGDr///A1v//0Pn//7D1//8wBgAAUAoAAND5//+w9f//MAYAAFAKAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhPr///z3//+E+v///Pf//yD6//9gBQAAIPr//2AFAACgBQAA4AwAAKAFAADgDAAA"
    "QAoAAIANAABACgAAgA0AAID3///A6///gPf//8Dr//+9AAAA1fr//3Dz//+Q6P//vQAAANX6//8gBQAAAAQAACAFAAAABAAA"
    "XwEAAFMEAACwBwAAUBAAAF8BAABTBAAAwPz//0D7///A/P//QPv//0QBAAC0CQAA9gYAAFICAAD2BgAAUgIAAOD7//+g/v//"
    "4Pv//6D+///g+///oP7//+D7//+g/v//wAIAAIAFAADAAgAAgAUAAMACAACABQAAwAIAAIAFAAAAAAAArv3///D9//+Q/P//"
    "AAAAAK79//+g/v//gPr//6D+//+A+v//AAAAAK79///w/f//kPz//wAAAACu/f//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "rv3//8Lv//9SAgAAPhAAAAALAAAAFgAAAPX//wDq//8AAAAAAAAAAAAAAAAAAAAAgPr//4Dv//+ABQAAgBAAAMACAADAAgAA"
    "QP3//0D9//97AwAAzQUAAAAAAAAAAAAAhfz//zP6//+ABQAAwAIAAID6//9A/f//1/7//4X8//8AAAAAAAAAACkBAAB7AwAA"
    "QP3//8D3///AAgAAQAgAAAAAAAAAAAAAQBQAAFAZAABAFAAAUBkAAKASAACgv///oBIAAKC///8gAQAAIMz//yABAAAgzP//"
    "oOT//+A4AACg5P//4DgAACAKAADgKQAAIAoAAOApAACk6f//QhgAAFAUAABQ+///pOn//0IYAADw2v//kBUAAPDa//+QFQAA"
    "5gEAAKz5//9Q8f//UOj//+YBAACs+f//wA4AAMARAADADgAAwBEAAAgQAADA0P//eub//+IUAAB65v//4hQAAOD7///gHAAA"
    "4Pv//+AcAADg+///4BwAAOD7///gHAAA4Pv//6Dz///g+///oPP//+D7//+g8///4Pv//6Dz///h9///HwgAAPAIAABwAwAA"
    "4ff//x8IAACQBwAA8AgAAJAHAADwCAAA4ff//x8IAADwCAAAcAMAAOH3//8fCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "LAcAAMQOAAAsBwAAxA4AAMAKAACAJQAAwAoAAIAlAADA4v//gPP//8Di//+A8///IOj//6CD//8g6P//oIP//2AgAABgOwAA"
    "YCAAAGA7AAARBwAALw0AAGAxAAAAcwAAEQcAAC8NAABwCwAAcNb//3ALAABw1v//2QIAABvl//9g4f//AM3//9kCAAAb5f//"
    "gAEAAAAGAACAAQAAAAYAAKTp//+8/v//uPb//4Tf//+49v//hN///8AYAAAA6v//wBgAAADq///AGAAAAOr//8AYAAAA6v//"
    "YPb//+Dw//9g9v//4PD//2D2///g8P//YPb//+Dw//+F/P//FQ8AAEAIAADgBgAAhfz//xUPAABQ////kBIAAFD///+QEgAA"
    "hfz//xUPAABACAAA4AYAAIX8//8VDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArv3//w5tAABSAgAA8pL//4DD//8As///"
    "gDwAAABNAAAA6v//gOT//wAWAACAGwAAQBMAAEBVAADA7P//wKr//0D9///AGAAAwAIAAEDn//+Z7v//me7//wAAAAAAAAAA"
    "ZxEAAGcRAADA4f//wBgAAEAeAABA5///1/7//3sDAAAAAAAAAAAAACkBAACF/P//wAIAAMAjAABA/f//QNz//wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAMDs///ADQAAQBMAAEDy//9AEwAAQPL//8Ds///ADQAAQAgAAMANAADA9///QPL//8D3//9A8v//"
    "QAgAAMANAACu/f//ZvT//wAAAAAAAAAAUgIAAJoLAAAAAAAAAAAAAAAAAAAAAAAAUgIAAJoLAAAAAAAAAAAAAK79//9m9P//"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApAQAAPhAAABc+///CL///4DZ//+Aw///gCYAAIA8AAAAAAAAAAAAAAAAAAAAAAAA"
    "AAsAAABCAAAA9f//AL7//0Dy///AAgAAwA0AAED9//8U8v//ZvT//wAAAAAAAAAA7A0AAJoLAAAA3///gBAAAAAhAACA7///"
    "UgIAAOwNAAAAAAAAAAAAAK79//8U8v//gAUAAAAhAACA+v//AN///wAAAAAAAAAA1BMAAJyj///UEwAAnKP//0AMAABAAgAA"
    "QAwAAEACAADACAAAwAQAAMAIAADABAAAwDYAAEBi///ANgAAQGL//0AHAADA0v//QAcAAMDS//9mKgAAPr///8Du//+AOQAA"
    "ZioAAD6///9ATgAAQH7//0BOAABAfv//PvX//54TAABADgAAgPz//z71//+eEwAAgAMAAIDR//+AAwAAgNH//6jW//84VQAA"
    "CL///8idAAAIv///yJ0AAIDD//+AfgAAgMP//4B+AACAw///gH4AAIDD//+AfgAAAPX//wAsAAAA9f//ACwAAAD1//8ALAAA"
    "APX//wAsAAA0FwAAPNb//6Do//+gFAAANBcAADzW//8Ayf//QGsAAADJ//9AawAANBcAADzW//+g6P//oBQAADQXAAA81v//"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMn//xA7AAAoyf//EDsAAIDN//8AXwAAgM3//wBfAAAA+f//gFcAAAD5//+AVwAA"
    "QPv//0B5AABA+///QHkAAMDk///AzP//wOT//8DM//92+f//7hEAAODU///grP//dvn//+4RAACg5///4GUAAKDn///gZQAA"
    "bgQAANb8//9gGwAAYDIAAG4EAADW/P//AOX//wAYAAAA5f//ABgAAPAVAADw+v//BHQAAHQ4//8EdAAAdDj//8BEAADAR///"
    "wEQAAMBH///ARAAAwEf//8BEAADAR///QBMAAMDs//9AEwAAwOz//0ATAADA7P//QBMAAMDs//8K+f//hhkAAKD+//9g6///"
    "Cvn//4YZAADALgAAAHz//8AuAAAAfP//Cvn//4YZAACg/v//YOv//wr5//+GGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "HAIAADzx//8cAgAAPPH//wADAAAAv///AAMAAAC///8AIAAAAPH//wAgAAAA8f//gAsAAIB1AACACwAAgHUAAADh//8A5///"
    "AOH//wDn///G9///nvj//2Dc//+gof//xvf//574///g6P//4DMAAODo///gMwAAWvf//7IgAAAgGQAAYB4AAFr3//+yIAAA"
    "AAQAAAD6//8ABAAAAPr//wAbAAAQ6v//uPb//7A3AAC49v//sDcAAADf//+AMQAAAN///4AxAAAA3///gDEAAADf//+AMQAA"
    "QAgAAEAIAABACAAAQAgAAEAIAABACAAAQAgAAEAIAAD2BgAAHuv//8D3//8AAAAA9gYAAB7r//8AAAAAwPf//wAAAADA9///"
    "9gYAAB7r///A9///AAAAAPYGAAAe6///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApAQAAAwK//9c+///9PUAAMCGAABAawAA"
    "QHn//8CU///AOQAAQGAAAEDG///An///AOr//4Bg//8AFgAAgJ8AAAAAAACAw///AAAAAIA8AAB8IAAAAAAAAAAAAAAAAAAA"
    "hN///wAAAACgQAAAoLz//2C///9gQwAAAAAAAFz7//8AAAAAAAAAAAAAAACkBAAAgBAAAICi//+A7///gF0AAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAIAmAAAAAAAAgNn//wAAAACA2f//AAAAAIAmAAAAAAAAQOf//0Dy///AGAAAwA0AAMAYAADADQAA"
    "QOf//0Dy//8K+f//ziIAAAAAAAAAAAAA9gYAADLd//8AAAAAAAAAAAAAAAAAAAAA9gYAADLd//8AAAAAAAAAAAr5///OIgAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAkAAAi///+49v//+EAAAEAeAABASgAAwOH//8C1//9ACAAAQPL//8D3///ADQAA"
    "wOz//0Cw//9AEwAAwE8AAEAIAADA4f//wPf//0AeAACkBAAAaC4AAAAAAAAAAAAAXPv//5jR//+AJgAAANT//4DZ//8ALAAA"
    "XPv//0gJAAAAAAAAAAAAAKQEAAC49v//gO///4D6//+AEAAAgAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEATAADA1v//"
    "wOz//0ApAADA7P//QCkAAEATAADA1v//AAAAAIDk//8AAAAAgBsAAAAAAACAGwAAAAAAAIDk//9SAgAAmgsAAAAAAAAAAAAA"
    "rv3//2b0//8AAAAAAAAAAAAAAAAAAAAArv3//2b0//8AAAAAAAAAAFICAACaCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAi///8AAAAA+EAAAAAhAAAAIQAAAN///wDf//8AAAAAAAAAAAAAAAAAAAAAAAAAAAC+//8AAAAAAEIAAIAQAACA7///"
    "gO///4AQAADsDQAAAAAAAAAAAAAAAAAAFPL//wAAAAAgJQAA4Nr//+Da//8gJQAAAAAAABTy//8AAAAAAAAAAAAAAADsDQAA"
    "AAAAAADf//8AAAAAACEAAAAAAAAAAAAAQPn//0ju//9A+f//SO7//8D///8A9P//wP///wD0//9ACQAAgBQAAEAJAACAFAAA"
    "4AsAAGAgAADgCwAAYCAAAKDx//+g4P//oPH//6Dg///J/f//Q////wDu///g1P//yf3//0P///+QBAAA0A4AAJAEAADQDgAA"
    "2QIAAJcFAAAADAAAYBsAANkCAACXBQAAAPz//4D1//8A/P//gPX//3wFAAAECAAApAQAAJASAACkBAAAkBIAAED9//8A9f//"
    "QP3//wD1//9A/f//APX//0D9//8A9f//IAQAAKAJAAAgBAAAoAkAACAEAACgCQAAIAQAAKAJAADX/v//1/7//0D9//8g+f//"
    "1/7//9f+//+Q/P//0Pn//5D8///Q+f//1/7//9f+//9A/f//IPn//9f+///X/v//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "uPb//xTy//9ICQAA7A0AAIAQAACAJgAAgO///4DZ//8AAAAAAAAAAAAAAAAAAAAAAPX//wDq//8ACwAAABYAAMACAABACAAA"
    "QP3//8D3//+kBAAAmgsAAAAAAAAAAAAAXPv//2b0//8gBAAAIA8AAOD7///g8P//rv3//1z7//8AAAAAAAAAAFICAACkBAAA"
    "gPr//wD1//+ABQAAAAsAAAAAAAAAAAAAyBYAAEg/AADIFgAASD8AACDp//9gDgAAIOn//2AOAACg5v//4Oj//6Dm///g6P//"
    "wA4AAADY///ADgAAANj//wAaAABALgAAABoAAEAuAADzAAAAO9T//9AHAABwMAAA8wAAADvU//9A+P//IK7//0D4//8grv//"
    "yf3//5UBAADQ7P//cM///8n9//+VAQAAQBAAAMAtAABAEAAAwC0AAGTw//90EAAArv3//6LK//+u/f//osr//2AMAAAgBAAA"
    "YAwAACAEAABgDAAAIAQAAGAMAAAgBAAAwPf//4Dv///A9///gO///8D3//+A7///wPf//4Dv//8AAAAAwu///zAGAAAQGAAA"
    "AAAAAMLv//9ACAAAYBcAAEAIAABgFwAAAAAAAMLv//8wBgAAEBgAAAAAAADC7///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "+AoAAFAZAAD4CgAAUBkAACAYAACgLQAAIBgAAKAtAAAg6///oLD//yDr//+gsP//4LX//yCG///gtf//IIb//+AtAACgbgAA"
    "4C0AAKBuAAAgCgAAQhgAADBSAADwtAAAIAoAAEIYAADw8P//0AcAAPDw///QBwAA+vP//6z5//8w1///8Jn///rz//+s+f//"
    "wAMAAMAGAADAAwAAwAYAADD0//94x///Huv//47Y//8e6///jtj//2ABAADgMgAAYAEAAOAyAABgAQAA4DIAAGABAADgMgAA"
    "oPP//2Dg//+g8///YOD//6Dz//9g4P//oPP//2Dg///NBQAA1/7//5AHAAAQGAAAzQUAANf+///wCAAAkAcAAPAIAACQBwAA"
    "zQUAANf+//+QBwAAEBgAAM0FAADX/v//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXjUAALowAACiyv//Rs///0C7//9AQv//"
    "wEQAAMC9AABA5///QLv//8AYAADARAAAQDQAAMBaAADAy///QKX//wALAACABQAAAPX//4D6//+Z7v//y8v//wAAAAAAAAAA"
    "ZxEAADU0AABA/f//wMD//8ACAABAPwAAKQEAANf+//8AAAAAAAAAANf+//8pAQAAQBMAAMAYAADA7P//QOf//wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAED9///A1v//wAIAAEApAADAAgAAQCkAAED9///A1v//AAsAAIAbAAAA9f//gOT//wD1//+A5P//"
    "AAsAAIAbAAAK+f//ZvT//wAAAAAAAAAA9gYAAJoLAAAAAAAAAAAAAAAAAAAAAAAA9gYAAJoLAAAAAAAAAAAAAAr5//9m9P//"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAziIAABYsAAAy3f//6tP//4DO//+Agf//gDEAAIB+AAAAAAAAAAAAAAAAAAAAAAAA"
    "gCYAAIA8AACA2f//gMP//4D6//8A3///gAUAAAAhAAA98///Zdf//wAAAAAAAAAAwwwAAJsoAADA9///wLX//0AIAABASgAA"
    "HwgAAMMMAAAAAAAAAAAAAOH3//898///QBMAAEAeAADA7P//wOH//wAAAAAAAAAAuNv//2ADAAC42///YAMAAEAHAADAHwAA"
    "QAcAAMAfAADABgAAQBgAAMAGAABAGAAAgMz//wA6AACAzP//ADoAAADt//+A+///AO3//4D7///S9P//nkkAACAUAACg8f//"
    "0vT//55JAABA5v//wIIAAEDm///AggAAbgQAAOru//9gBQAA4CEAAG4EAADq7v//gOr//4Dx//+A6v//gPH///AVAABAw///"
    "aC4AAHis//9oLgAAeKz//wAhAAAAqP//ACEAAACo//8AIQAAAKj//wAhAAAAqP//gBAAAID6//+AEAAAgPr//4AQAACA+v//"
    "gBAAAID6//+49v//ICUAAKD+///gz///uPb//yAlAAAgGgAAIKz//yAaAAAgrP//uPb//yAlAACg/v//4M///7j2//8gJQAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAIAAGyU//8cAgAAbJT//0AWAABAsf//QBYAAECx//9AKAAAQBoAAEAoAABAGgAA"
    "QDoAAMAwAABAOgAAwDAAAMDY//9Aov//wNj//0Ci//+yBQAAnvj//+DA//+gav//sgUAAJ74///AJgAAAPb//8AmAAAA9v//"
    "ogAAAH4JAADgJgAAoF0AAKIAAAB+CQAAgP7//4DI//+A/v//gMj//3AIAABQNAAAPNb//0S+AAA81v//RL4AAEDG///ATwAA"
    "QMb//8BPAABAxv//wE8AAEDG///ATwAAAAAAAIAmAAAAAAAAgCYAAAAAAACAJgAAAAAAAIAmAABICQAAXPv//wD1//9A8v//"
    "SAkAAFz7//9g1f//4DIAAGDV///gMgAASAkAAFz7//8A9f//QPL//0gJAABc+///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "rPn//+T9//+s+f//5P3//wDh//8A5///AOH//wDn//+ACAAAgEgAAIAIAACASAAAgEAAAIBXAACAQAAAgFcAAADk//8Apv//"
    "AOT//wCm//8y+P//vuf//wC////Ad///Mvj//77n//9gDgAAIOD//2AOAAAg4P//BgwAALr6///AGwAAAE4AAAYMAAC6+v//"
    "AP///wAHAAAA////AAcAAIgCAACIOAAANBcAAKQEAAA0FwAApAQAAEAIAABAxv//QAgAAEDG//9ACAAAQMb//0AIAABAxv//"
    "QAgAAMAYAABACAAAwBgAAEAIAADAGAAAQAgAAMAYAAAK+f//9gYAAOD7//9g6///Cvn///YGAADg+///4Pv//+D7///g+///"
    "Cvn///YGAADg+///YOv//wr5///2BgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWIf//6CQ//+oeAAAYG8AAAB5AACAhgEA"
    "AIf//4B5/v8ATQAAgMAAAACz//+AP///QKX//0B5///AWgAAwIYAAMDh///A4f//QB4AAEAeAAA+EAAANlEAAAAAAAAAAAAA"
    "wu///8qu//+g/v//4H8AAGABAAAggP//rv3//679//8AAAAAAAAAAFICAABSAgAAgNn//4D6//+AJgAAgAUAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAEATAABAYAAAwOz//8Cf///A7P//wJ///0ATAABAYAAAwOz//0C7//9AEwAAwEQAAEATAADARAAA"
    "wOz//0C7///sDQAAAAAAAAAAAAAAAAAAFPL//wAAAAAAAAAAAAAAAAAAAAAAAAAAFPL//wAAAAAAAAAAAAAAAOwNAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKOT//7j2///YGwAASAkAAEA0AADAcAAAwMv//0CP//9A/f//wA0AAMACAABA8v//"
    "gM7//wCo//+AMQAAAFgAAAD1//+ABQAAAAsAAID6//+GGQAAziIAAAAAAAAAAAAAeub//zLd//9A/f//QEoAAMACAADAtf//"
    "UgIAAAr5//8AAAAAAAAAAK79///2BgAAAPX//wDU//8ACwAAACwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD1//+AGwAA"
    "AAsAAIDk//8ACwAAgOT//wD1//+AGwAAQPL//0Dy///ADQAAwA0AAMANAADADQAAQPL//0Dy///2BgAAmgsAAAAAAAAAAAAA"
    "Cvn//2b0//8AAAAAAAAAAAAAAAAAAAAACvn//2b0//8AAAAAAAAAAPYGAACaCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "hN///4Tf//98IAAAfCAAAAAhAAAAYwAAAN///wCd//8AAAAAAAAAAAAAAAAAAAAAAN///wDf//8AIQAAACEAAAAAAAAAIQAA"
    "AAAAAADf///2BgAAziIAAAAAAAAAAAAACvn//zLd//8AAAAAQEoAAAAAAADAtf//Cvn//wr5//8AAAAAAAAAAPYGAAD2BgAA"
    "gO///4Dv//+AEAAAgBAAAAAAAAAAAAAAACBC9wAAAABQAFQAWABcAGAAZABoAGwAeAB8AIAAhACIAIwAkACUAJgAnACwALQA"
    "uAC8ANAA1ADYANwA+AD8AAABBAFSAFYAWQBdAGIAZgBpAG0AeQB9AIIAhgCJAI0AkgCWAJkAnQCxALUAuQC9ANEA1QDaAN4A"
    "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"
    "0O7//1DI//+AEAAAQB4AAAALAAAAIQAAwAIAAOAGAADQBAAAMBEAAJD8//8Q9///UgIAAPL1///A9///IPn//1ICAADy9f//"
    "sAAAAHDt//8AAAAAAAAAAET4//9E+P//vAcAALwHAACgFAAAgBsAAGDr//+A5P//oAkAAMANAABg9v//QPL//xD3///w5///"
    "8AgAABAYAADw/f//kPz//xACAABwAwAAjAEAALwHAAAAAAAAAAAAAHT+//9E+P//AAAAAAAAAAAAAAAAAAAAALwHAAC8BwAA"
    "RPj//0T4//+w9f//8Of//1AKAAAQGAAAsPX///Dn//9QCgAAEBgAAMACAADgBgAAQP3//yD5///AAgAA4AYAAED9//8g+f//"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDn///wHgAA0Pn//8AYAACQHQAAMNr//1ArAAAwo///"
    "cOL//5BJAAAw8P//kBIAAPDn//+wIQAAkPz//xDh//9w7f//cDoAABACAADQ+f//iPD//9gbAABgFwAAYOv//+Tr//8MMwAA"
    "ADcAAMCU//+kBAAAzOj//8zo//80FwAANBcAAMzo//+wFgAAcAMAAHDM//+wLAAAkDMAAFDT//9Q6f//kPz//4D6//8g+f//"
    "wAIAAGAiAABA/f//oN3//4AFAADgBgAAAAAAAAAAAAAAAAAAAAAAAKQEAADM6P//AAAAAAAAAABc+///NBcAAEwaAAAMbf//"
    "jAEAABwUAABw+P//UHgAAHD4//8Q4f//EAIAADBTAAAQAgAA8Lv///AIAADwxv//0Pn//5D8///QDwAAUNP//7AAAADwCAAA"
    "pAQAAPzu//9gAQAAoBQAADAGAAC49v//QNH//wCEAAB0/v//RPj//0T4//9E+P//vAcAALwHAADAAgAAIDAAAIDk///gBgAA"
    "gBsAACD5//9A/f//4M////D9///Q7v//8AgAAFAKAAAQ9///sPX//xACAAAwEQAAAAAAAAAAAAAAAAAAAAAAAHT+//9E+P//"
    "AAAAAAAAAACMAQAAvAcAAKDz//+I8P//6Pz//2AMAACwFgAAUAoAADAGAAAQ4f//MAYAABAjAACw9f//0Pn//9D5//9Q6f//"
    "8P3//7D1///w/f//sPX//xACAAAQAgAAXPv//+wNAABACAAAAAAAAFz7///sDQAAAAAAAEAIAAAAAAAAAAAAADQXAADM6P//"
    "zOj//zQXAABwzP//kPz//5AzAABwAwAAUOn//7AsAACwFgAAUNP//5AHAACQMwAAcPj//3DM//+wAAAAsPX//1D///9QCgAA"
    "pAQAAMzo//8AAAAAAAAAAFz7//80FwAAAAAAAAAAAAAAAAAAAAAAAMzo//80FwAANBcAAMzo//+AGwAAYOv//4Dk//+gFAAA"
    "gBsAAGDr//+A5P//oBQAALAAAACQ/P//UP///3ADAACwAAAAkPz//1D///9wAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAALwHAAC8BwAARPj//0T4///Q7v//0O7//zARAAAwEQAA8PL///Dn//8QDQAAEBgAAGAMAADADQAA"
    "oPP//0Dy//+g/v//wA0AAGABAABA8v//dP7//0T4//8AAAAAAAAAAIwBAAC8BwAAAAAAAAAAAAAAAAAAAAAAAET4//9E+P//"
    "vAcAALwHAABQCgAA8B4AALD1//8Q4f//UAoAAPAeAACw9f//EOH///D9//+w9f//EAIAAFAKAADw/f//sPX//xACAABQCgAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANry///u5P//agUAACYNAADgEQAAQCkAAFD0///w5///"
    "gBAAAMAjAADw8v//cOL//8D3//8g7v//AAAAAAAAAAAw+///sPX//3ADAACQBwAAxgAAAMYAAADAAgAA4AYAAMYAAADGAAAA"
    "cAMAADAGAAAAAAAAAAAAAJ4cAABGMgAA8vX//2Lj///A4f//YLT//wAWAACAGwAAsN////DR///wEwAAEDkAALALAAAwHAAA"
    "4AYAAMANAABgAQAA4AYAAJD8//9w+P//AAAAANQKAADQ+f//8Of//1z7//8YAwAAwPf//6Do//+kBAAAvAcAALwHAAA0FwAA"
    "RPj//8zo//8A6v//oN3//8ANAADgPQAAQPL//yDC//8AFgAAYCIAAJAHAAAwEQAAUPT///Dn//+wCwAAEBgAAHD4///Q7v//"
    "AAAAAAAAAAAAAAAAAAAAAKQEAAC8BwAAAAAAAAAAAABc+///RPj//2QdAADgPQAAuPb//xTy///g2v//wJ///7AWAADwHgAA"
    "kNv//zC5//9gFwAAYDgAAAAWAAAALAAA0AQAAFAKAAAACwAAoBQAAND5///w8v//Ivz//8YAAABw+P//8Of//yL8///GAAAA"
    "EPf//3D4//8AAAAAAAAAAET4///M6P//vAcAADQXAAAQGAAAUEEAAPDn//+wvv//sAsAAPAeAABQ9P//EOH//4Dv//+g3f//"
    "gBAAAGAiAABA/f//IPn//8ACAADgBgAApAQAALwHAAAAAAAAAAAAAFz7//9E+P//AAAAAAAAAAAAAAAAAAAAALwHAAA0FwAA"
    "RPj//8zo///Q7v//MNr//zARAADQJQAA0O7//zDa//8wEQAA0CUAANAEAABQCgAAMPv//7D1///QBAAAUAoAADD7//+w9f//"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgDAACY0f//SAkAAOj8///g+///ADcAAEDn///gPQAA"
    "ABYAAODa//9gAQAAwOH//9AEAACw1P//0O7///Dn///wEwAA0O7///D9//8QAgAAMAYAAEDn//9gAQAAIDAAAHgPAABA5///"
    "4OX//+BTAAC49v//AAAAAAAAAACY0f//AAAAAGguAAAQDQAAcDoAAJD8//9wlf//cAMAAJBqAADw8v//kMX//9D5///Q7v//"
    "kBIAABAYAABw7f//8Of//zAGAAAwEQAAAAAAAAAAAAAAAAAAAAAAALj2//8AAAAAAAAAAAAAAABICQAAAAAAAKzD//9E+P//"
    "1AoAAOwNAABgOAAAQCkAAMDs//+g3f//oCoAAMAuAAAA3///IOP///Dn///Q+f//MPv//9Du//+Q8f//MBEAANAEAAAwBgAA"
    "0Pn//xgDAAAACwAAwA0AAHT+///UCgAAoCoAACDN//9c+///RPj//0T4///M6P//vAcAADQXAABwGQAA8B4AALD1//+wvv//"
    "UAoAAFBBAACQ5v//EOH//2D2//9A8v//oAkAAIAbAABg9v//gOT//6AJAADADQAAAAAAAAAAAAAAAAAAAAAAAFz7//9E+P//"
    "AAAAAAAAAACkBAAAvAcAABTy//9U2f//pAQAAHT+//+AEAAA4D0AAKDz//8AAAAAoBQAAAAhAADA9///IOP//5Dx//8w5f//"
    "0Pn//7D1///Q+f//sPX//xACAAAwBgAApAQAAFz7//8gBAAAoBQAAKQEAABc+///IAQAACAEAAAAAAAAAAAAAAAAAABoLgAA"
    "AAAAAJjR//+A5P//YH3//4AbAACgggAAAAsAAKDd//8A9f//YCIAAJAdAACwLAAAcOL//1DT//8w+///kPz//9AEAABwAwAA"
    "uPb//wAAAAAAAAAAAAAAAEgJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACY0f//AAAAAGguAABwAwAAcDoAAJD8//+Qxf//"
    "cAMAAHA6AACQ/P//kMX//6D+//8AAAAAYAEAAAAAAACg/v//AAAAAGABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAALwHAAA0FwAARPj//8zo///Q7v//cMz//zARAACQMwAAcO3//1DT//+QEgAAsCwAABANAADQJQAA"
    "8PL//zDa//8wBgAAcAMAAND5//+Q/P//XPv//0T4//8AAAAAAAAAAKQEAAC8BwAAAAAAAAAAAAAAAAAAAAAAAET4///M6P//"
    "vAcAADQXAACgFAAAQCkAAGDr///A1v//oBQAAEApAABg6///wNb//9D5//+w9f//MAYAAFAKAADQ+f//sPX//zAGAABQCgAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIT6///89///hPr///z3//8g+v//YAUAACD6//9gBQAA"
    "oAUAAOAMAACgBQAA4AwAAEAKAACADQAAQAoAAIANAACA9///wOv//4D3///A6///vQAAANX6//9w8///kOj//70AAADV+v//"
    "IAUAAAAEAAAgBQAAAAQAAF8BAABTBAAAsAcAAFAQAABfAQAAUwQAAMD8//9A+///wPz//0D7//9EAQAAtAkAAPYGAABSAgAA"
    "9gYAAFICAADg+///oP7//+D7//+g/v//4Pv//6D+///g+///oP7//8ACAACABQAAwAIAAIAFAADAAgAAgAUAAMACAACABQAA"
    "AAAAAK79///w/f//kPz//wAAAACu/f//oP7//4D6//+g/v//gPr//wAAAACu/f//8P3//5D8//8AAAAArv3//wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAK79///C7///UgIAAD4QAAAACwAAABYAAAD1//8A6v//AAAAAAAAAAAAAAAAAAAAAID6//+A7///"
    "gAUAAIAQAADAAgAAwAIAAED9//9A/f//ewMAAM0FAAAAAAAAAAAAAIX8//8z+v//gAUAAMACAACA+v//QP3//9f+//+F/P//"
    "AAAAAAAAAAApAQAAewMAAED9///A9///wAIAAEAIAAAAAAAAAAAAAEAUAABQGQAAQBQAAFAZAACgEgAAoL///6ASAACgv///"
    "IAEAACDM//8gAQAAIMz//6Dk///gOAAAoOT//+A4AAAgCgAA4CkAACAKAADgKQAApOn//0IYAABQFAAAUPv//6Tp//9CGAAA"
    "8Nr//5AVAADw2v//kBUAAOYBAACs+f//UPH//1Do///mAQAArPn//8AOAADAEQAAwA4AAMARAAAIEAAAwND//3rm///iFAAA"
    "eub//+IUAADg+///4BwAAOD7///gHAAA4Pv//+AcAADg+///4BwAAOD7//+g8///4Pv//6Dz///g+///oPP//+D7//+g8///"
    "4ff//x8IAADwCAAAcAMAAOH3//8fCAAAkAcAAPAIAACQBwAA8AgAAOH3//8fCAAA8AgAAHADAADh9///HwgAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAACwHAADEDgAALAcAAMQOAADACgAAgCUAAMAKAACAJQAAwOL//4Dz///A4v//gPP//yDo//+gg///"
    "IOj//6CD//9gIAAAYDsAAGAgAABgOwAAEQcAAC8NAABgMQAAAHMAABEHAAAvDQAAcAsAAHDW//9wCwAAcNb//9kCAAAb5f//"
    "YOH//wDN///ZAgAAG+X//4ABAAAABgAAgAEAAAAGAACk6f//vP7//7j2//+E3///uPb//4Tf///AGAAAAOr//8AYAAAA6v//"
    "wBgAAADq///AGAAAAOr//2D2///g8P//YPb//+Dw//9g9v//4PD//2D2///g8P//hfz//xUPAABACAAA4AYAAIX8//8VDwAA"
    "UP///5ASAABQ////kBIAAIX8//8VDwAAQAgAAOAGAACF/P//FQ8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK79//8ObQAA"
    "UgIAAPKS//+Aw///ALP//4A8AAAATQAAAOr//4Dk//8AFgAAgBsAAEATAABAVQAAwOz//8Cq//9A/f//wBgAAMACAABA5///"
    "me7//5nu//8AAAAAAAAAAGcRAABnEQAAwOH//8AYAABAHgAAQOf//9f+//97AwAAAAAAAAAAAAApAQAAhfz//8ACAADAIwAA"
    "QP3//0Dc//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA7P//wA0AAEATAABA8v//QBMAAEDy///A7P//wA0AAEAIAADADQAA"
    "wPf//0Dy///A9///QPL//0AIAADADQAArv3//2b0//8AAAAAAAAAAFICAACaCwAAAAAAAAAAAAAAAAAAAAAAAFICAACaCwAA"
    "AAAAAAAAAACu/f//ZvT//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKQEAAD4QAAAXPv//wi///+A2f//gMP//4AmAACAPAAA"
    "AAAAAAAAAAAAAAAAAAAAAAALAAAAQgAAAPX//wC+//9A8v//wAIAAMANAABA/f//FPL//2b0//8AAAAAAAAAAOwNAACaCwAA"
    "AN///4AQAAAAIQAAgO///1ICAADsDQAAAAAAAAAAAACu/f//FPL//4AFAAAAIQAAgPr//wDf//8AAAAAAAAAANQTAACco///"
    "1BMAAJyj//9ADAAAQAIAAEAMAABAAgAAwAgAAMAEAADACAAAwAQAAMA2AABAYv//wDYAAEBi//9ABwAAwNL//0AHAADA0v//"
    "ZioAAD6////A7v//gDkAAGYqAAA+v///QE4AAEB+//9ATgAAQH7//z71//+eEwAAQA4AAID8//8+9f//nhMAAIADAACA0f//"
    "gAMAAIDR//+o1v//OFUAAAi////InQAACL///8idAACAw///gH4AAIDD//+AfgAAgMP//4B+AACAw///gH4AAAD1//8ALAAA"
    "APX//wAsAAAA9f//ACwAAAD1//8ALAAANBcAADzW//+g6P//oBQAADQXAAA81v//AMn//0BrAAAAyf//QGsAADQXAAA81v//"
    "oOj//6AUAAA0FwAAPNb//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjJ//8QOwAAKMn//xA7AACAzf//AF8AAIDN//8AXwAA"
    "APn//4BXAAAA+f//gFcAAED7//9AeQAAQPv//0B5AADA5P//wMz//8Dk///AzP//dvn//+4RAADg1P//4Kz//3b5///uEQAA"
    "oOf//+BlAACg5///4GUAAG4EAADW/P//YBsAAGAyAABuBAAA1vz//wDl//8AGAAAAOX//wAYAADwFQAA8Pr//wR0AAB0OP//"
    "BHQAAHQ4///ARAAAwEf//8BEAADAR///wEQAAMBH///ARAAAwEf//0ATAADA7P//QBMAAMDs//9AEwAAwOz//0ATAADA7P//"
    "Cvn//4YZAACg/v//YOv//wr5//+GGQAAwC4AAAB8///ALgAAAHz//wr5//+GGQAAoP7//2Dr//8K+f//hhkAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAABwCAAA88f//HAIAADzx//8AAwAAAL///wADAAAAv///ACAAAADx//8AIAAAAPH//4ALAACAdQAA"
    "gAsAAIB1AAAA4f//AOf//wDh//8A5///xvf//574//9g3P//oKH//8b3//+e+P//4Oj//+AzAADg6P//4DMAAFr3//+yIAAA"
    "IBkAAGAeAABa9///siAAAAAEAAAA+v//AAQAAAD6//8AGwAAEOr//7j2//+wNwAAuPb//7A3AAAA3///gDEAAADf//+AMQAA"
    "AN///4AxAAAA3///gDEAAEAIAABACAAAQAgAAEAIAABACAAAQAgAAEAIAABACAAA9gYAAB7r///A9///AAAAAPYGAAAe6///"
    "AAAAAMD3//8AAAAAwPf///YGAAAe6///wPf//wAAAAD2BgAAHuv//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKQEAAAMCv//"
    "XPv///T1AADAhgAAQGsAAEB5///AlP//wDkAAEBgAABAxv//wJ///wDq//+AYP//ABYAAICfAAAAAAAAgMP//wAAAACAPAAA"
    "fCAAAAAAAAAAAAAAAAAAAITf//8AAAAAoEAAAKC8//9gv///YEMAAAAAAABc+///AAAAAAAAAAAAAAAApAQAAIAQAACAov//"
    "gO///4BdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAJgAAAAAAAIDZ//8AAAAAgNn//wAAAACAJgAAAAAAAEDn//9A8v//"
    "wBgAAMANAADAGAAAwA0AAEDn//9A8v//Cvn//84iAAAAAAAAAAAAAPYGAAAy3f//AAAAAAAAAAAAAAAAAAAAAPYGAAAy3f//"
    "AAAAAAAAAAAK+f//ziIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgJAAAIv///uPb///hAAABAHgAAQEoAAMDh///Atf//"
    "QAgAAEDy///A9///wA0AAMDs//9AsP//QBMAAMBPAABACAAAwOH//8D3//9AHgAApAQAAGguAAAAAAAAAAAAAFz7//+Y0f//"
    "gCYAAADU//+A2f//ACwAAFz7//9ICQAAAAAAAAAAAACkBAAAuPb//4Dv//+A+v//gBAAAIAFAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAABAEwAAwNb//8Ds//9AKQAAwOz//0ApAABAEwAAwNb//wAAAACA5P//AAAAAIAbAAAAAAAAgBsAAAAAAACA5P//"
    "UgIAAJoLAAAAAAAAAAAAAK79//9m9P//AAAAAAAAAAAAAAAAAAAAAK79//9m9P//AAAAAAAAAABSAgAAmgsAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAIv///AAAAAPhAAAAAIQAAACEAAADf//8A3///AAAAAAAAAAAAAAAAAAAAAAAAAAAAvv//"
    "AAAAAABCAACAEAAAgO///4Dv//+AEAAA7A0AAAAAAAAAAAAAAAAAABTy//8AAAAAICUAAODa///g2v//ICUAAAAAAAAU8v//"
    "AAAAAAAAAAAAAAAA7A0AAAAAAAAA3///AAAAAAAhAAAAAAAAAAAAAED5//9I7v//QPn//0ju///A////APT//8D///8A9P//"
    "QAkAAIAUAABACQAAgBQAAOALAABgIAAA4AsAAGAgAACg8f//oOD//6Dx//+g4P//yf3//0P///8A7v//4NT//8n9//9D////"
    "kAQAANAOAACQBAAA0A4AANkCAACXBQAAAAwAAGAbAADZAgAAlwUAAAD8//+A9f//APz//4D1//98BQAABAgAAKQEAACQEgAA"
    "pAQAAJASAABA/f//APX//0D9//8A9f//QP3//wD1//9A/f//APX//yAEAACgCQAAIAQAAKAJAAAgBAAAoAkAACAEAACgCQAA"
    "1/7//9f+//9A/f//IPn//9f+///X/v//kPz//9D5//+Q/P//0Pn//9f+///X/v//QP3//yD5///X/v//1/7//wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAALj2//8U8v//SAkAAOwNAACAEAAAgCYAAIDv//+A2f//AAAAAAAAAAAAAAAAAAAAAAD1//8A6v//"
    "AAsAAAAWAADAAgAAQAgAAED9///A9///pAQAAJoLAAAAAAAAAAAAAFz7//9m9P//IAQAACAPAADg+///4PD//679//9c+///"
    "AAAAAAAAAABSAgAApAQAAID6//8A9f//gAUAAAALAAAAAAAAAAAAAMgWAABIPwAAyBYAAEg/AAAg6f//YA4AACDp//9gDgAA"
    "oOb//+Do//+g5v//4Oj//8AOAAAA2P//wA4AAADY//8AGgAAQC4AAAAaAABALgAA8wAAADvU///QBwAAcDAAAPMAAAA71P//"
    "QPj//yCu//9A+P//IK7//8n9//+VAQAA0Oz//3DP///J/f//lQEAAEAQAADALQAAQBAAAMAtAABk8P//dBAAAK79//+iyv//"
    "rv3//6LK//9gDAAAIAQAAGAMAAAgBAAAYAwAACAEAABgDAAAIAQAAMD3//+A7///wPf//4Dv///A9///gO///8D3//+A7///"
    "AAAAAMLv//8wBgAAEBgAAAAAAADC7///QAgAAGAXAABACAAAYBcAAAAAAADC7///MAYAABAYAAAAAAAAwu///wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAPgKAABQGQAA+AoAAFAZAAAgGAAAoC0AACAYAACgLQAAIOv//6Cw//8g6///oLD//+C1//8ghv//"
    "4LX//yCG///gLQAAoG4AAOAtAACgbgAAIAoAAEIYAAAwUgAA8LQAACAKAABCGAAA8PD//9AHAADw8P//0AcAAPrz//+s+f//"
    "MNf///CZ///68///rPn//8ADAADABgAAwAMAAMAGAAAw9P//eMf//x7r//+O2P//Huv//47Y//9gAQAA4DIAAGABAADgMgAA"
    "YAEAAOAyAABgAQAA4DIAAKDz//9g4P//oPP//2Dg//+g8///YOD//6Dz//9g4P//zQUAANf+//+QBwAAEBgAAM0FAADX/v//"
    "8AgAAJAHAADwCAAAkAcAAM0FAADX/v//kAcAABAYAADNBQAA1/7//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF41AAC6MAAA"
    "osr//0bP//9Au///QEL//8BEAADAvQAAQOf//0C7///AGAAAwEQAAEA0AADAWgAAwMv//0Cl//8ACwAAgAUAAAD1//+A+v//"
    "me7//8vL//8AAAAAAAAAAGcRAAA1NAAAQP3//8DA///AAgAAQD8AACkBAADX/v//AAAAAAAAAADX/v//KQEAAEATAADAGAAA"
    "wOz//0Dn//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA/f//wNb//8ACAABAKQAAwAIAAEApAABA/f//wNb//wALAACAGwAA"
    "APX//4Dk//8A9f//gOT//wALAACAGwAACvn//2b0//8AAAAAAAAAAPYGAACaCwAAAAAAAAAAAAAAAAAAAAAAAPYGAACaCwAA"
    "AAAAAAAAAAAK+f//ZvT//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM4iAAAWLAAAMt3//+rT//+Azv//gIH//4AxAACAfgAA"
    "AAAAAAAAAAAAAAAAAAAAAIAmAACAPAAAgNn//4DD//+A+v//AN///4AFAAAAIQAAPfP//2XX//8AAAAAAAAAAMMMAACbKAAA"
    "wPf//8C1//9ACAAAQEoAAB8IAADDDAAAAAAAAAAAAADh9///PfP//0ATAABAHgAAwOz//8Dh//8AAAAAAAAAALjb//9gAwAA"
    "uNv//2ADAABABwAAwB8AAEAHAADAHwAAwAYAAEAYAADABgAAQBgAAIDM//8AOgAAgMz//wA6AAAA7f//gPv//wDt//+A+///"
    "0vT//55JAAAgFAAAoPH//9L0//+eSQAAQOb//8CCAABA5v//wIIAAG4EAADq7v//YAUAAOAhAABuBAAA6u7//4Dq//+A8f//"
    "gOr//4Dx///wFQAAQMP//2guAAB4rP//aC4AAHis//8AIQAAAKj//wAhAAAAqP//ACEAAACo//8AIQAAAKj//4AQAACA+v//"
    "gBAAAID6//+AEAAAgPr//4AQAACA+v//uPb//yAlAACg/v//4M///7j2//8gJQAAIBoAACCs//8gGgAAIKz//7j2//8gJQAA"
    "oP7//+DP//+49v//ICUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwCAABslP//HAIAAGyU//9AFgAAQLH//0AWAABAsf//"
    "QCgAAEAaAABAKAAAQBoAAEA6AADAMAAAQDoAAMAwAADA2P//QKL//8DY//9Aov//sgUAAJ74///gwP//oGr//7IFAACe+P//"
    "wCYAAAD2///AJgAAAPb//6IAAAB+CQAA4CYAAKBdAACiAAAAfgkAAID+//+AyP//gP7//4DI//9wCAAAUDQAADzW//9EvgAA"
    "PNb//0S+AABAxv//wE8AAEDG///ATwAAQMb//8BPAABAxv//wE8AAAAAAACAJgAAAAAAAIAmAAAAAAAAgCYAAAAAAACAJgAA"
    "SAkAAFz7//8A9f//QPL//0gJAABc+///YNX//+AyAABg1f//4DIAAEgJAABc+///APX//0Dy//9ICQAAXPv//wAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAKz5///k/f//rPn//+T9//8A4f//AOf//wDh//8A5///gAgAAIBIAACACAAAgEgAAIBAAACAVwAA"
    "gEAAAIBXAAAA5P//AKb//wDk//8Apv//Mvj//77n//8Av///wHf//zL4//++5///YA4AACDg//9gDgAAIOD//wYMAAC6+v//"
    "wBsAAABOAAAGDAAAuvr//wD///8ABwAAAP///wAHAACIAgAAiDgAADQXAACkBAAANBcAAKQEAABACAAAQMb//0AIAABAxv//"
    "QAgAAEDG//9ACAAAQMb//0AIAADAGAAAQAgAAMAYAABACAAAwBgAAEAIAADAGAAACvn///YGAADg+///YOv//wr5///2BgAA"
    "4Pv//+D7///g+///4Pv//wr5///2BgAA4Pv//2Dr//8K+f//9gYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFiH//+gkP//"
    "qHgAAGBvAAAAeQAAgIYBAACH//+Aef7/AE0AAIDAAAAAs///gD///0Cl//9Aef//wFoAAMCGAADA4f//wOH//0AeAABAHgAA"
    "PhAAADZRAAAAAAAAAAAAAMLv///Krv//oP7//+B/AABgAQAAIID//679//+u/f//AAAAAAAAAABSAgAAUgIAAIDZ//+A+v//"
    "gCYAAIAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAEwAAQGAAAMDs///An///wOz//8Cf//9AEwAAQGAAAMDs//9Au///"
    "QBMAAMBEAABAEwAAwEQAAMDs//9Au///7A0AAAAAAAAAAAAAAAAAABTy//8AAAAAAAAAAAAAAAAAAAAAAAAAABTy//8AAAAA"
    "AAAAAAAAAADsDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjk//+49v//2BsAAEgJAABANAAAwHAAAMDL//9Aj///"
    "QP3//8ANAADAAgAAQPL//4DO//8AqP//gDEAAABYAAAA9f//gAUAAAALAACA+v//hhkAAM4iAAAAAAAAAAAAAHrm//8y3f//"
    "QP3//0BKAADAAgAAwLX//1ICAAAK+f//AAAAAAAAAACu/f//9gYAAAD1//8A1P//AAsAAAAsAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAA9f//gBsAAAALAACA5P//AAsAAIDk//8A9f//gBsAAEDy//9A8v//wA0AAMANAADADQAAwA0AAEDy//9A8v//"
    "9gYAAJoLAAAAAAAAAAAAAAr5//9m9P//AAAAAAAAAAAAAAAAAAAAAAr5//9m9P//AAAAAAAAAAD2BgAAmgsAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAITf//+E3///fCAAAHwgAAAAIQAAAGMAAADf//8Anf//AAAAAAAAAAAAAAAAAAAAAADf//8A3///"
    "ACEAAAAhAAAAAAAAACEAAAAAAAAA3///9gYAAM4iAAAAAAAAAAAAAAr5//8y3f//AAAAAEBKAAAAAAAAwLX//wr5//8K+f//"
    "AAAAAAAAAAD2BgAA9gYAAIDv//+A7///gBAAAIAQAAAAAAAAAAAAAAAA")
  ;; ---- PENTORA TABLES end ----
)
