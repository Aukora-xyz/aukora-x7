;; cord-echo.wat : one ongoing Cord skill (the cord-echo skill, docs/auma/cord-echo.md). Hand-written integer cell, Microverse
;; ABI v1 guest. i32 and i64 only. No imports. Four pages of linear storage, fixed. An instrument with no authority: it
;; computes and returns, it reads no time and no session, and it signs nothing.
;;
;; Field P = 65,521. Profile `fifo24` (the only one): the state is the last 24 inputs, s[k] = u[t-k]. After input u[t]
;; the output is y[t] = 3u[t-7] - 2u[t-15] + u[t-23] mod P; inputs before tick 1 are zero.
;;
;; Ops (canonical JSON in and out, keys in UTF-8 byte order):
;;   cord.genesis {cell, profile, skill}                    -> {checkpoint}  (tick 0, zero state, parent 64 zeros)
;;   cord.run     {checkpoint, expect: {head, tick}, inputs, profile} -> {checkpoint, outputs}
;;   cord.info    {}                                        -> {field, maxInputs, profile, profileSha256, stateWords}
;; The checkpoint (aukora.cord.checkpoint.v1):
;;   {cell, head, inputRoot, outputRoot, parent, profile, profileSha256, schema, skill, state[24], stateSha256, tick}
;;   stateSha256 = SHA-256 of the 24 state words as u16 little-endian, s[0] first (48 bytes).
;;   inputRoot_t = SHA-256(inputRoot_{t-1} || u32le(t) || u16le(u_t)), seed SHA-256("aukora.cord.inputs.v1");
;;   outputRoot the same over y_t, seed SHA-256("aukora.cord.outputs.v1").
;;   head = SHA-256("aukora.cord.head.v1\n" || cell || skill || profileSha256 || parent || u32le(tick) || stateSha256
;;          || inputRoot || outputRoot): 248 bytes, each hex field as its 32 raw bytes.
;; `cell` is echoed: a cell cannot know its own pin; each HOST checks it. Digests catch edits; anyone can compute them,
;; so a checkpoint is evidence of a run, never permission.
;;
;; Refusals (closed; when several hold, the lowest number wins; a refusal carries no checkpoint and no outputs):
;;   1 MALFORMED  2 OP_UNKNOWN  3 CORD_SHAPE  4 CORD_PROFILE_UNKNOWN  5 CORD_PROFILE_MISMATCH  6 CORD_STATE_RANGE
;;   7 CORD_STATE_DIGEST  8 CORD_HEAD_DIGEST  9 CORD_HEAD_STALE  10 CORD_INPUT_RANGE  11 CORD_LIMIT
;;
;; Storage map (bytes):
;;   64..1535     text literals, NUL-terminated, one per 32-byte slot (the schema line takes two); code c at 1120 + 32c
;;   1536 1568 1600  the head domain and the two root seeds' texts;  1632..1663  the profile's sha256 (raw, set by
;;                server/cord-echo-cell.build.mjs from apps/web/public/cells/cord/fifo24.profile.json)
;;   2048..2655   SHA-256: round constants K 2048, state H 2304, block 2336, schedule W 2400 (nucleus.wat's routine)
;;   2688..3199   32-byte fields: presented cell 2688, head 2720, inputRoot 2752, outputRoot 2784, parent 2816,
;;                profileSha256 2848, skill 2880, stateSha256 2912, expect.head 2944; computed stateSha256 2976,
;;                head 3008; new inputRoot 3040, outputRoot 3072, stateSha256 3104, head 3136, parent 3168
;;   3200..3263   decimal digit scratch
;;   3328..3423   the state, 24 x i32
;;   4096..8095   inputs (1,000 x i32);  8192..12191 outputs (1,000 x i32)
;;   16384..32767 request (mv_alloc);  65536.. response
(module
  (memory (export "memory") 4 4)

  (global $p (mut i32) (i32.const 0))        ;; parse cursor
  (global $end (mut i32) (i32.const 0))      ;; end of request
  (global $errs (mut i32) (i32.const 0))     ;; one bit per refusal code
  (global $bad (mut i32) (i32.const 0))      ;; the request text itself did not parse
  (global $failcode (mut i32) (i32.const 1)) ;; MALFORMED in the envelope, CORD_SHAPE inside the input
  (global $seq (mut i64) (i64.const 0))
  (global $o (mut i32) (i32.const 65536))    ;; response cursor
  (global $fill (mut i32) (i32.const 0))     ;; SHA-256 block fill
  (global $len (mut i64) (i64.const 0))      ;; SHA-256 message length
  (global $n (mut i32) (i32.const 0))        ;; inputs given
  (global $ns (mut i32) (i32.const 0))       ;; state words given
  (global $tick (mut i32) (i32.const 0))
  (global $etick (mut i32) (i32.const 0))

  ;; ---- request literals ----
  (data (i32.const 64) "{\22abi\22:1,\22input\22:{")
  (data (i32.const 96) "\22cell\22:")
  (data (i32.const 128) "\22checkpoint\22:")
  (data (i32.const 160) ",\22head\22:")
  (data (i32.const 192) ",\22inputRoot\22:")
  (data (i32.const 224) ",\22outputRoot\22:")
  (data (i32.const 256) ",\22parent\22:")
  (data (i32.const 288) ",\22profile\22:")
  (data (i32.const 320) ",\22profileSha256\22:")
  (data (i32.const 352) ",\22schema\22:\22aukora.cord.checkpoint.v1\22")
  (data (i32.const 416) ",\22skill\22:")
  (data (i32.const 448) ",\22state\22:[")
  (data (i32.const 480) ",\22stateSha256\22:")
  (data (i32.const 512) ",\22tick\22:")
  (data (i32.const 544) ",\22expect\22:{\22head\22:")
  (data (i32.const 576) ",\22inputs\22:[")
  (data (i32.const 608) "},\22op\22:\22")
  (data (i32.const 640) "cord.genesis\22")
  (data (i32.const 672) "cord.run\22")
  (data (i32.const 704) "cord.info\22")
  (data (i32.const 736) ",\22seq\22:")
  (data (i32.const 768) "fifo24")
  ;; ---- response literals ----
  (data (i32.const 800) "{\22abi\22:1,\22result\22:{")
  (data (i32.const 832) ",\22outputs\22:[")
  (data (i32.const 864) "},\22seq\22:")
  (data (i32.const 896) ",\22status\22:\22ok\22}")
  (data (i32.const 928) "{\22abi\22:1,\22code\22:\22")
  (data (i32.const 960) "\22,\22seq\22:")
  (data (i32.const 992) ",\22status\22:\22refused\22}")
  (data (i32.const 1024) "\22field\22:65521,\22maxInputs\22:1000")
  (data (i32.const 1056) ",\22stateWords\22:24")
  ;; ---- refusal codes: address = 1120 + 32 * code ----
  (data (i32.const 1152) "MALFORMED")
  (data (i32.const 1184) "OP_UNKNOWN")
  (data (i32.const 1216) "CORD_SHAPE")
  (data (i32.const 1248) "CORD_PROFILE_UNKNOWN")
  (data (i32.const 1280) "CORD_PROFILE_MISMATCH")
  (data (i32.const 1312) "CORD_STATE_RANGE")
  (data (i32.const 1344) "CORD_STATE_DIGEST")
  (data (i32.const 1376) "CORD_HEAD_DIGEST")
  (data (i32.const 1408) "CORD_HEAD_STALE")
  (data (i32.const 1440) "CORD_INPUT_RANGE")
  (data (i32.const 1472) "CORD_LIMIT")
  ;; ---- domains ----
  (data (i32.const 1536) "aukora.cord.head.v1\0a")
  (data (i32.const 1568) "aukora.cord.inputs.v1")
  (data (i32.const 1600) "aukora.cord.outputs.v1")
  ;; ---- PROFILE-SHA256 (written by server/cord-echo-cell.build.mjs; do not edit by hand) ----
  (data (i32.const 1632) "\89\fc\0a\8c\95\35\30\97\a4\a5\b6\a2\77\9d\c3\f8\1a\73\6f\af\61\c6\86\9d\f7\10\0d\03\fc\c9\6b\20")

  ;; ================= parsing =================
  (func $flag (param $c i32)
    (global.set $errs (i32.or (global.get $errs) (i32.shl (i32.const 1) (local.get $c)))))

  (func $fail
    (global.set $bad (i32.const 1))
    (call $flag (global.get $failcode)))

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

  ;; A field word: 0..65520; above it is refusal $code (the parse goes on, the word is kept as 0).
  (func $word (param $code i32) (result i32)
    (local $v i64)
    (local.set $v (call $uint))
    (if (i64.gt_u (local.get $v) (i64.const 65520)) (then (call $flag (local.get $code)) (return (i32.const 0))))
    (i32.wrap_i64 (local.get $v)))

  ;; A tick: 0..2^31-1; above it is CORD_SHAPE.
  (func $tickval (result i32)
    (local $v i64)
    (local.set $v (call $uint))
    (if (i64.gt_u (local.get $v) (i64.const 2147483647)) (then (call $flag (i32.const 3)) (return (i32.const 0))))
    (i32.wrap_i64 (local.get $v)))

  (func $nib (result i32)
    (local $c i32)
    (local.set $c (call $peek))
    (if (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
      (then (global.set $p (i32.add (global.get $p) (i32.const 1))) (return (i32.sub (local.get $c) (i32.const 48)))))
    (if (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 102)))
      (then (global.set $p (i32.add (global.get $p) (i32.const 1))) (return (i32.sub (local.get $c) (i32.const 87)))))
    (call $fail)
    (i32.const 0))

  ;; `"` exactly 64 lowercase hex characters `"` into 32 raw bytes at $dst.
  (func $hex (param $dst i32)
    (local $i i32) (local $hi i32)
    (call $eat (i32.const 34))
    (block $done
      (loop $next
        (br_if $done (i32.or (global.get $bad) (i32.ge_u (local.get $i) (i32.const 32))))
        (local.set $hi (call $nib))
        (i32.store8 (i32.add (local.get $dst) (local.get $i))
          (i32.or (i32.shl (local.get $hi) (i32.const 4)) (call $nib)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (call $eat (i32.const 34)))

  ;; An op name this cell does not know: skip to its closing quote (the envelope still parses; OP_UNKNOWN stands).
  (func $skip_name
    (block $d (loop $l
      (br_if $d (i32.or (i32.ge_u (global.get $p) (global.get $end)) (i32.eq (call $peek) (i32.const 34))))
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (br $l)))
    (call $eat (i32.const 34)))

  ;; A profile name: `"` 1..32 of [a-z0-9] `"`. Returns 1 for `fifo24`; any other name is CORD_PROFILE_UNKNOWN.
  (func $profile (result i32)
    (local $q i32) (local $c i32) (local $k i32) (local $known i32)
    (call $eat (i32.const 34))
    (local.set $q (global.get $p))
    (block $done
      (loop $next
        (local.set $c (call $peek))
        (br_if $done (i32.eqz (i32.or
          (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122)))
          (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))))
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $next)))
    (local.set $k (i32.sub (global.get $p) (local.get $q)))
    (if (i32.or (i32.eqz (local.get $k)) (i32.gt_u (local.get $k) (i32.const 32))) (then (call $fail)))
    (call $eat (i32.const 34))
    (if (i32.eq (local.get $k) (i32.const 6))
      (then
        (local.set $known (i32.const 1))
        (local.set $c (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $c) (i32.const 6)))
          (if (i32.ne (i32.load8_u (i32.add (local.get $q) (local.get $c))) (i32.load8_u (i32.add (i32.const 768) (local.get $c))))
            (then (local.set $known (i32.const 0))))
          (local.set $c (i32.add (local.get $c) (i32.const 1)))
          (br $l)))))
    (if (i32.and (i32.eqz (global.get $bad)) (i32.eqz (local.get $known))) (then (call $flag (i32.const 4))))
    (local.get $known))

  ;; `[` words `]`: at most $cap kept at $dst as i32; returns the count (more than $cap are counted, not kept).
  (func $words (param $dst i32) (param $cap i32) (param $code i32) (result i32)
    (local $i i32) (local $v i32)
    (if (i32.eq (call $peek) (i32.const 93))
      (then (call $eat (i32.const 93)) (return (i32.const 0))))
    (block $done
      (loop $next
        (br_if $done (global.get $bad))
        (local.set $v (call $word (local.get $code)))
        (if (i32.lt_u (local.get $i) (local.get $cap))
          (then (i32.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2))) (local.get $v))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (if (i32.eq (call $peek) (i32.const 44))
          (then (call $eat (i32.const 44)) (br $next)))))
    (call $eat (i32.const 93))
    (local.get $i))

  ;; The checkpoint object, every key in order.
  (func $parse_checkpoint (result i32)
    (local $known i32)
    (call $eat (i32.const 123))
    (call $lit (i32.const 96)) (call $hex (i32.const 2688))
    (call $lit (i32.const 160)) (call $hex (i32.const 2720))
    (call $lit (i32.const 192)) (call $hex (i32.const 2752))
    (call $lit (i32.const 224)) (call $hex (i32.const 2784))
    (call $lit (i32.const 256)) (call $hex (i32.const 2816))
    (call $lit (i32.const 288)) (local.set $known (call $profile))
    (call $lit (i32.const 320)) (call $hex (i32.const 2848))
    (call $lit (i32.const 352))
    (call $lit (i32.const 416)) (call $hex (i32.const 2880))
    (call $lit (i32.const 448)) (global.set $ns (call $words (i32.const 3328) (i32.const 24) (i32.const 6)))
    (if (i32.ne (global.get $ns) (i32.const 24)) (then (call $flag (i32.const 3))))
    (call $lit (i32.const 480)) (call $hex (i32.const 2912))
    (call $lit (i32.const 512)) (global.set $tick (call $tickval))
    (call $eat (i32.const 125))
    (local.get $known))

  ;; ================= SHA-256 (nucleus.wat's routine, unchanged) =================
  (func $sha_consts
    (i32.store offset=2048 (i32.const 0) (i32.const 0x428a2f98)) (i32.store offset=2052 (i32.const 0) (i32.const 0x71374491))
    (i32.store offset=2056 (i32.const 0) (i32.const 0xb5c0fbcf)) (i32.store offset=2060 (i32.const 0) (i32.const 0xe9b5dba5))
    (i32.store offset=2064 (i32.const 0) (i32.const 0x3956c25b)) (i32.store offset=2068 (i32.const 0) (i32.const 0x59f111f1))
    (i32.store offset=2072 (i32.const 0) (i32.const 0x923f82a4)) (i32.store offset=2076 (i32.const 0) (i32.const 0xab1c5ed5))
    (i32.store offset=2080 (i32.const 0) (i32.const 0xd807aa98)) (i32.store offset=2084 (i32.const 0) (i32.const 0x12835b01))
    (i32.store offset=2088 (i32.const 0) (i32.const 0x243185be)) (i32.store offset=2092 (i32.const 0) (i32.const 0x550c7dc3))
    (i32.store offset=2096 (i32.const 0) (i32.const 0x72be5d74)) (i32.store offset=2100 (i32.const 0) (i32.const 0x80deb1fe))
    (i32.store offset=2104 (i32.const 0) (i32.const 0x9bdc06a7)) (i32.store offset=2108 (i32.const 0) (i32.const 0xc19bf174))
    (i32.store offset=2112 (i32.const 0) (i32.const 0xe49b69c1)) (i32.store offset=2116 (i32.const 0) (i32.const 0xefbe4786))
    (i32.store offset=2120 (i32.const 0) (i32.const 0x0fc19dc6)) (i32.store offset=2124 (i32.const 0) (i32.const 0x240ca1cc))
    (i32.store offset=2128 (i32.const 0) (i32.const 0x2de92c6f)) (i32.store offset=2132 (i32.const 0) (i32.const 0x4a7484aa))
    (i32.store offset=2136 (i32.const 0) (i32.const 0x5cb0a9dc)) (i32.store offset=2140 (i32.const 0) (i32.const 0x76f988da))
    (i32.store offset=2144 (i32.const 0) (i32.const 0x983e5152)) (i32.store offset=2148 (i32.const 0) (i32.const 0xa831c66d))
    (i32.store offset=2152 (i32.const 0) (i32.const 0xb00327c8)) (i32.store offset=2156 (i32.const 0) (i32.const 0xbf597fc7))
    (i32.store offset=2160 (i32.const 0) (i32.const 0xc6e00bf3)) (i32.store offset=2164 (i32.const 0) (i32.const 0xd5a79147))
    (i32.store offset=2168 (i32.const 0) (i32.const 0x06ca6351)) (i32.store offset=2172 (i32.const 0) (i32.const 0x14292967))
    (i32.store offset=2176 (i32.const 0) (i32.const 0x27b70a85)) (i32.store offset=2180 (i32.const 0) (i32.const 0x2e1b2138))
    (i32.store offset=2184 (i32.const 0) (i32.const 0x4d2c6dfc)) (i32.store offset=2188 (i32.const 0) (i32.const 0x53380d13))
    (i32.store offset=2192 (i32.const 0) (i32.const 0x650a7354)) (i32.store offset=2196 (i32.const 0) (i32.const 0x766a0abb))
    (i32.store offset=2200 (i32.const 0) (i32.const 0x81c2c92e)) (i32.store offset=2204 (i32.const 0) (i32.const 0x92722c85))
    (i32.store offset=2208 (i32.const 0) (i32.const 0xa2bfe8a1)) (i32.store offset=2212 (i32.const 0) (i32.const 0xa81a664b))
    (i32.store offset=2216 (i32.const 0) (i32.const 0xc24b8b70)) (i32.store offset=2220 (i32.const 0) (i32.const 0xc76c51a3))
    (i32.store offset=2224 (i32.const 0) (i32.const 0xd192e819)) (i32.store offset=2228 (i32.const 0) (i32.const 0xd6990624))
    (i32.store offset=2232 (i32.const 0) (i32.const 0xf40e3585)) (i32.store offset=2236 (i32.const 0) (i32.const 0x106aa070))
    (i32.store offset=2240 (i32.const 0) (i32.const 0x19a4c116)) (i32.store offset=2244 (i32.const 0) (i32.const 0x1e376c08))
    (i32.store offset=2248 (i32.const 0) (i32.const 0x2748774c)) (i32.store offset=2252 (i32.const 0) (i32.const 0x34b0bcb5))
    (i32.store offset=2256 (i32.const 0) (i32.const 0x391c0cb3)) (i32.store offset=2260 (i32.const 0) (i32.const 0x4ed8aa4a))
    (i32.store offset=2264 (i32.const 0) (i32.const 0x5b9cca4f)) (i32.store offset=2268 (i32.const 0) (i32.const 0x682e6ff3))
    (i32.store offset=2272 (i32.const 0) (i32.const 0x748f82ee)) (i32.store offset=2276 (i32.const 0) (i32.const 0x78a5636f))
    (i32.store offset=2280 (i32.const 0) (i32.const 0x84c87814)) (i32.store offset=2284 (i32.const 0) (i32.const 0x8cc70208))
    (i32.store offset=2288 (i32.const 0) (i32.const 0x90befffa)) (i32.store offset=2292 (i32.const 0) (i32.const 0xa4506ceb))
    (i32.store offset=2296 (i32.const 0) (i32.const 0xbef9a3f7)) (i32.store offset=2300 (i32.const 0) (i32.const 0xc67178f2)))

  (func $sha_init
    (i32.store offset=2304 (i32.const 0) (i32.const 0x6a09e667)) (i32.store offset=2308 (i32.const 0) (i32.const 0xbb67ae85))
    (i32.store offset=2312 (i32.const 0) (i32.const 0x3c6ef372)) (i32.store offset=2316 (i32.const 0) (i32.const 0xa54ff53a))
    (i32.store offset=2320 (i32.const 0) (i32.const 0x510e527f)) (i32.store offset=2324 (i32.const 0) (i32.const 0x9b05688c))
    (i32.store offset=2328 (i32.const 0) (i32.const 0x1f83d9ab)) (i32.store offset=2332 (i32.const 0) (i32.const 0x5be0cd19))
    (global.set $fill (i32.const 0))
    (global.set $len (i64.const 0)))

  (func $bswap (param $x i32) (result i32)
    (i32.or
      (i32.or (i32.shl (local.get $x) (i32.const 24)) (i32.and (i32.shl (local.get $x) (i32.const 8)) (i32.const 0xff0000)))
      (i32.or (i32.and (i32.shr_u (local.get $x) (i32.const 8)) (i32.const 0xff00)) (i32.shr_u (local.get $x) (i32.const 24)))))

  (func $sha_block
    (local $t i32) (local $q i32) (local $x i32) (local $y i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32) (local $e i32) (local $f i32) (local $g i32) (local $h i32)
    (local $t1 i32) (local $t2 i32)
    (local.set $t (i32.const 0))
    (loop $w0
      (i32.store offset=2400 (i32.shl (local.get $t) (i32.const 2))
        (call $bswap (i32.load offset=2336 (i32.shl (local.get $t) (i32.const 2)))))
      (local.set $t (i32.add (local.get $t) (i32.const 1)))
      (br_if $w0 (i32.lt_u (local.get $t) (i32.const 16))))
    (loop $w1
      ;; q = address of W[t-16]
      (local.set $q (i32.add (i32.const 2336) (i32.shl (local.get $t) (i32.const 2))))
      (local.set $x (i32.load offset=4 (local.get $q)))
      (local.set $y (i32.load offset=56 (local.get $q)))
      (i32.store offset=64 (local.get $q)
        (i32.add
          (i32.add (i32.load (local.get $q))
            (i32.xor (i32.xor (i32.rotr (local.get $x) (i32.const 7)) (i32.rotr (local.get $x) (i32.const 18)))
                     (i32.shr_u (local.get $x) (i32.const 3))))
          (i32.add (i32.load offset=36 (local.get $q))
            (i32.xor (i32.xor (i32.rotr (local.get $y) (i32.const 17)) (i32.rotr (local.get $y) (i32.const 19)))
                     (i32.shr_u (local.get $y) (i32.const 10))))))
      (local.set $t (i32.add (local.get $t) (i32.const 1)))
      (br_if $w1 (i32.lt_u (local.get $t) (i32.const 64))))
    (local.set $a (i32.load offset=2304 (i32.const 0)))
    (local.set $b (i32.load offset=2308 (i32.const 0)))
    (local.set $c (i32.load offset=2312 (i32.const 0)))
    (local.set $d (i32.load offset=2316 (i32.const 0)))
    (local.set $e (i32.load offset=2320 (i32.const 0)))
    (local.set $f (i32.load offset=2324 (i32.const 0)))
    (local.set $g (i32.load offset=2328 (i32.const 0)))
    (local.set $h (i32.load offset=2332 (i32.const 0)))
    (local.set $t (i32.const 0))
    (loop $r
      (local.set $t1
        (i32.add
          (i32.add (local.get $h)
            (i32.xor (i32.xor (i32.rotr (local.get $e) (i32.const 6)) (i32.rotr (local.get $e) (i32.const 11)))
                     (i32.rotr (local.get $e) (i32.const 25))))
          (i32.add
            (i32.xor (i32.and (local.get $e) (local.get $f)) (i32.and (i32.xor (local.get $e) (i32.const -1)) (local.get $g)))
            (i32.add (i32.load offset=2048 (i32.shl (local.get $t) (i32.const 2)))
                     (i32.load offset=2400 (i32.shl (local.get $t) (i32.const 2)))))))
      (local.set $t2
        (i32.add
          (i32.xor (i32.xor (i32.rotr (local.get $a) (i32.const 2)) (i32.rotr (local.get $a) (i32.const 13)))
                   (i32.rotr (local.get $a) (i32.const 22)))
          (i32.xor (i32.xor (i32.and (local.get $a) (local.get $b)) (i32.and (local.get $a) (local.get $c)))
                   (i32.and (local.get $b) (local.get $c)))))
      (local.set $h (local.get $g))
      (local.set $g (local.get $f))
      (local.set $f (local.get $e))
      (local.set $e (i32.add (local.get $d) (local.get $t1)))
      (local.set $d (local.get $c))
      (local.set $c (local.get $b))
      (local.set $b (local.get $a))
      (local.set $a (i32.add (local.get $t1) (local.get $t2)))
      (local.set $t (i32.add (local.get $t) (i32.const 1)))
      (br_if $r (i32.lt_u (local.get $t) (i32.const 64))))
    (i32.store offset=2304 (i32.const 0) (i32.add (i32.load offset=2304 (i32.const 0)) (local.get $a)))
    (i32.store offset=2308 (i32.const 0) (i32.add (i32.load offset=2308 (i32.const 0)) (local.get $b)))
    (i32.store offset=2312 (i32.const 0) (i32.add (i32.load offset=2312 (i32.const 0)) (local.get $c)))
    (i32.store offset=2316 (i32.const 0) (i32.add (i32.load offset=2316 (i32.const 0)) (local.get $d)))
    (i32.store offset=2320 (i32.const 0) (i32.add (i32.load offset=2320 (i32.const 0)) (local.get $e)))
    (i32.store offset=2324 (i32.const 0) (i32.add (i32.load offset=2324 (i32.const 0)) (local.get $f)))
    (i32.store offset=2328 (i32.const 0) (i32.add (i32.load offset=2328 (i32.const 0)) (local.get $g)))
    (i32.store offset=2332 (i32.const 0) (i32.add (i32.load offset=2332 (i32.const 0)) (local.get $h))))

  (func $sha_byte (param $b i32)
    (i32.store8 offset=2336 (global.get $fill) (local.get $b))
    (global.set $fill (i32.add (global.get $fill) (i32.const 1)))
    (global.set $len (i64.add (global.get $len) (i64.const 1)))
    (if (i32.eq (global.get $fill) (i32.const 64))
      (then (call $sha_block) (global.set $fill (i32.const 0)))))

  (func $sha_final (param $out i32)
    (local $bits i64) (local $k i32)
    (local.set $bits (i64.shl (global.get $len) (i64.const 3)))
    (call $sha_byte (i32.const 128))
    (block $d (loop $l
      (br_if $d (i32.eq (global.get $fill) (i32.const 56)))
      (call $sha_byte (i32.const 0))
      (br $l)))
    (local.set $k (i32.const 56))
    (loop $lb
      (call $sha_byte (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.extend_i32_u (local.get $k))) (i64.const 255))))
      (local.set $k (i32.sub (local.get $k) (i32.const 8)))
      (br_if $lb (i32.ge_s (local.get $k) (i32.const 0))))
    (local.set $k (i32.const 0))
    (loop $lo
      (i32.store (i32.add (local.get $out) (local.get $k)) (call $bswap (i32.load offset=2304 (local.get $k))))
      (local.set $k (i32.add (local.get $k) (i32.const 4)))
      (br_if $lo (i32.lt_u (local.get $k) (i32.const 32)))))

  ;; ================= the Cord digests =================
  (func $sha_bytes (param $a i32) (param $n i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (call $sha_byte (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $sha_u16le (param $v i32)
    (call $sha_byte (i32.and (local.get $v) (i32.const 255)))
    (call $sha_byte (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 255))))

  (func $sha_u32le (param $v i32)
    (call $sha_u16le (i32.and (local.get $v) (i32.const 65535)))
    (call $sha_u16le (i32.shr_u (local.get $v) (i32.const 16))))

  ;; SHA-256 of the 24 state words (u16 little-endian, s[0] first) into $out.
  (func $state_sha (param $out i32)
    (local $k i32)
    (call $sha_init)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 24)))
      (call $sha_u16le (i32.load (i32.add (i32.const 3328) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (call $sha_final (local.get $out)))

  ;; The head over the fixed 248-byte layout into $out.
  (func $head_of (param $cell i32) (param $skill i32) (param $psha i32) (param $parent i32) (param $tick i32)
                 (param $ssha i32) (param $inr i32) (param $outr i32) (param $out i32)
    (call $sha_init)
    (call $sha_bytes (i32.const 1536) (i32.const 20))
    (call $sha_bytes (local.get $cell) (i32.const 32))
    (call $sha_bytes (local.get $skill) (i32.const 32))
    (call $sha_bytes (local.get $psha) (i32.const 32))
    (call $sha_bytes (local.get $parent) (i32.const 32))
    (call $sha_u32le (local.get $tick))
    (call $sha_bytes (local.get $ssha) (i32.const 32))
    (call $sha_bytes (local.get $inr) (i32.const 32))
    (call $sha_bytes (local.get $outr) (i32.const 32))
    (call $sha_final (local.get $out)))

  ;; One root step in place: root = SHA-256(root || u32le(t) || u16le(v)).
  (func $root (param $r i32) (param $t i32) (param $v i32)
    (call $sha_init)
    (call $sha_bytes (local.get $r) (i32.const 32))
    (call $sha_u32le (local.get $t))
    (call $sha_u16le (local.get $v))
    (call $sha_final (local.get $r)))

  (func $seed (param $a i32) (param $n i32) (param $out i32)
    (call $sha_init)
    (call $sha_bytes (local.get $a) (local.get $n))
    (call $sha_final (local.get $out)))

  (func $eq32 (param $a i32) (param $b i32) (result i32)
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 32)))
      (if (i32.ne (i32.load (i32.add (local.get $a) (local.get $k))) (i32.load (i32.add (local.get $b) (local.get $k))))
        (then (return (i32.const 0))))
      (local.set $k (i32.add (local.get $k) (i32.const 4)))
      (br $l)))
    (i32.const 1))

  (func $copy32 (param $src i32) (param $dst i32)
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 32)))
      (i32.store (i32.add (local.get $dst) (local.get $k)) (i32.load (i32.add (local.get $src) (local.get $k))))
      (local.set $k (i32.add (local.get $k) (i32.const 4)))
      (br $l))))

  (func $zero32 (param $dst i32)
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 32)))
      (i32.store (i32.add (local.get $dst) (local.get $k)) (i32.const 0))
      (local.set $k (i32.add (local.get $k) (i32.const 4)))
      (br $l))))

  ;; ================= the machine =================
  ;; One tick: shift the window, take u, answer y = 3s[7] - 2s[15] + s[23] mod P of the new window.
  (func $tick_once (param $u i32) (result i32)
    (local $k i32) (local $a i32)
    (local.set $k (i32.const 23))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $k)))
      (local.set $a (i32.add (i32.const 3328) (i32.shl (local.get $k) (i32.const 2))))
      (i32.store (local.get $a) (i32.load (i32.sub (local.get $a) (i32.const 4))))
      (local.set $k (i32.sub (local.get $k) (i32.const 1)))
      (br $l)))
    (i32.store (i32.const 3328) (local.get $u))
    (i32.rem_u
      (i32.add
        (i32.add (i32.mul (i32.const 3) (i32.load (i32.const 3356)))
                 (i32.mul (i32.const 2) (i32.sub (i32.const 65521) (i32.load (i32.const 3388)))))
        (i32.load (i32.const 3420)))
      (i32.const 65521)))

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
    (local.set $q (i32.const 3264))
    (loop $next
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (i32.store8 (local.get $q)
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
      (br_if $next (i64.ne (local.get $v) (i64.const 0))))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $q) (i32.const 3264)))
        (call $putc (i32.load8_u (local.get $q)))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))
        (br $copy))))

  (func $puti (param $v i32) (call $putu (i64.extend_i32_u (local.get $v))))

  (func $hexc (param $x i32) (result i32)
    (select (i32.add (i32.const 48) (local.get $x)) (i32.add (i32.const 87) (local.get $x))
      (i32.lt_u (local.get $x) (i32.const 10))))

  (func $puthex (param $a i32)
    (local $k i32) (local $b i32)
    (call $putc (i32.const 34))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 32)))
      (local.set $b (i32.load8_u (i32.add (local.get $a) (local.get $k))))
      (call $putc (call $hexc (i32.shr_u (local.get $b) (i32.const 4))))
      (call $putc (call $hexc (i32.and (local.get $b) (i32.const 15))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (call $putc (i32.const 34)))

  (func $putprofile
    (call $putc (i32.const 34)) (call $puts (i32.const 768)) (call $putc (i32.const 34)))

  (func $putlist (param $a i32) (param $n i32)
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (local.get $n)))
      (if (local.get $k) (then (call $putc (i32.const 44))))
      (call $puti (i32.load (i32.add (local.get $a) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l))))

  ;; `"checkpoint":{...}` from the new fields (parent 3168, state 3328, roots and digests 3040..3136).
  (func $emit_checkpoint (param $tick i32)
    (call $puts (i32.const 128)) (call $putc (i32.const 123))
    (call $puts (i32.const 96)) (call $puthex (i32.const 2688))
    (call $puts (i32.const 160)) (call $puthex (i32.const 3136))
    (call $puts (i32.const 192)) (call $puthex (i32.const 3040))
    (call $puts (i32.const 224)) (call $puthex (i32.const 3072))
    (call $puts (i32.const 256)) (call $puthex (i32.const 3168))
    (call $puts (i32.const 288)) (call $putprofile)
    (call $puts (i32.const 320)) (call $puthex (i32.const 1632))
    (call $puts (i32.const 352))
    (call $puts (i32.const 416)) (call $puthex (i32.const 2880))
    (call $puts (i32.const 448)) (call $putlist (i32.const 3328) (i32.const 24)) (call $putc (i32.const 93))
    (call $puts (i32.const 480)) (call $puthex (i32.const 3104))
    (call $puts (i32.const 512)) (call $puti (local.get $tick))
    (call $putc (i32.const 125)))

  (func $close
    (call $puts (i32.const 864)) (call $putu (global.get $seq))
    (call $puts (i32.const 896)))

  (func $refuse
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 928))
    (call $puts (i32.add (i32.const 1120) (i32.shl (i32.ctz (global.get $errs)) (i32.const 5))))
    (if (i32.eqz (global.get $bad))
      (then (call $puts (i32.const 960)) (call $putu (global.get $seq)))
      (else (call $putc (i32.const 34))))
    (call $puts (i32.const 992)))

  ;; ================= ops =================
  ;; Zero state, tick 0, parent 64 zeros, roots at their seeds.
  (func $op_genesis
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (i32.const 96)))
      (i32.store (i32.add (i32.const 3328) (local.get $k)) (i32.const 0))
      (local.set $k (i32.add (local.get $k) (i32.const 4)))
      (br $l)))
    (call $zero32 (i32.const 3168))
    (call $seed (i32.const 1568) (i32.const 21) (i32.const 3040))
    (call $seed (i32.const 1600) (i32.const 22) (i32.const 3072))
    (call $state_sha (i32.const 3104))
    (call $head_of (i32.const 2688) (i32.const 2880) (i32.const 1632) (i32.const 3168) (i32.const 0)
                   (i32.const 3104) (i32.const 3040) (i32.const 3072) (i32.const 3136))
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 800))
    (call $emit_checkpoint (i32.const 0))
    (call $close))

  ;; Every input in order from the checked checkpoint; parent = its head; roots per tick.
  (func $op_run
    (local $i i32) (local $t i32) (local $u i32) (local $y i32)
    (call $copy32 (i32.const 2752) (i32.const 3040))
    (call $copy32 (i32.const 2784) (i32.const 3072))
    (call $copy32 (i32.const 2720) (i32.const 3168))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (global.get $n)))
      (local.set $t (i32.add (global.get $tick) (i32.add (local.get $i) (i32.const 1))))
      (local.set $u (i32.load (i32.add (i32.const 4096) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $y (call $tick_once (local.get $u)))
      (i32.store (i32.add (i32.const 8192) (i32.shl (local.get $i) (i32.const 2))) (local.get $y))
      (call $root (i32.const 3040) (local.get $t) (local.get $u))
      (call $root (i32.const 3072) (local.get $t) (local.get $y))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.set $t (i32.add (global.get $tick) (global.get $n)))
    (call $state_sha (i32.const 3104))
    (call $head_of (i32.const 2688) (i32.const 2880) (i32.const 1632) (i32.const 3168) (local.get $t)
                   (i32.const 3104) (i32.const 3040) (i32.const 3072) (i32.const 3136))
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 800))
    (call $emit_checkpoint (local.get $t))
    (call $puts (i32.const 832)) (call $putlist (i32.const 8192) (global.get $n)) (call $putc (i32.const 93))
    (call $close))

  (func $op_info
    (global.set $o (i32.const 65536))
    (call $puts (i32.const 800))
    (call $puts (i32.const 1024))
    (call $puts (i32.const 288)) (call $putprofile)
    (call $puts (i32.const 320)) (call $puthex (i32.const 1632))
    (call $puts (i32.const 1056))
    (call $close))

  ;; ================= ABI =================
  (func (export "mv_abi_version") (result i32) (i32.const 1))

  (func (export "mv_alloc") (param $len i32) (result i32)
    (if (result i32) (i32.le_u (local.get $len) (i32.const 16384))
      (then (i32.const 16384))
      (else (i32.const 0))))

  ;; form: 1 info {}  2 genesis {cell,profile,skill}  3 run {checkpoint,expect,inputs,profile}
  ;; op:   1 cord.info  2 cord.genesis  3 cord.run
  (func (export "mv_run") (param $ptr i32) (param $len i32) (result i64)
    (local $form i32) (local $op i32) (local $known i32) (local $known2 i32)
    (global.set $errs (i32.const 0))
    (global.set $bad (i32.const 0))
    (global.set $failcode (i32.const 1))
    (global.set $seq (i64.const 0))
    (global.set $o (i32.const 65536))
    (global.set $n (i32.const 0))
    (global.set $ns (i32.const 0))
    (global.set $tick (i32.const 0))
    (global.set $etick (i32.const 0))
    (call $sha_consts)
    (if (i32.or (i32.ne (local.get $ptr) (i32.const 16384)) (i32.gt_u (local.get $len) (i32.const 16384)))
      (then (call $fail))
      (else
        (global.set $p (local.get $ptr))
        (global.set $end (i32.add (local.get $ptr) (local.get $len)))
        (call $lit (i32.const 64))
        (global.set $failcode (i32.const 3))
        (if (i32.eq (call $peek) (i32.const 125))
          (then (local.set $form (i32.const 1)))
          (else
            (if (call $try (i32.const 96))
              (then
                (local.set $form (i32.const 2))
                (call $hex (i32.const 2688))
                (call $lit (i32.const 288)) (local.set $known (call $profile))
                (call $lit (i32.const 416)) (call $hex (i32.const 2880)))
              (else
                (call $lit (i32.const 128))
                (local.set $form (i32.const 3))
                (local.set $known (call $parse_checkpoint))
                (call $lit (i32.const 544)) (call $hex (i32.const 2944))
                (call $lit (i32.const 512)) (global.set $etick (call $tickval))
                (call $eat (i32.const 125))
                (call $lit (i32.const 576)) (global.set $n (call $words (i32.const 4096) (i32.const 1000) (i32.const 10)))
                (call $lit (i32.const 288)) (local.set $known2 (call $profile))))))
        (if (i32.eqz (global.get $bad)) (then (global.set $failcode (i32.const 1))))
        ;; the rest of the envelope is read only when the input parsed (a bad input is CORD_SHAPE, nothing more)
        (if (i32.eqz (global.get $bad))
          (then
            (call $lit (i32.const 608))
            (if (call $try (i32.const 640)) (then (local.set $op (i32.const 2)))
              (else (if (call $try (i32.const 672)) (then (local.set $op (i32.const 3)))
                (else (if (call $try (i32.const 704)) (then (local.set $op (i32.const 1)))
                  (else (if (i32.eqz (global.get $bad)) (then (call $flag (i32.const 2)) (call $skip_name)))))))))
            (call $lit (i32.const 736))
            (global.set $seq (call $uint))
            (call $eat (i32.const 125))
            (if (i32.ne (global.get $p) (global.get $end)) (then (call $fail)))))
        (if (i32.eqz (global.get $bad))
          (then
            (if (i32.and (i32.ne (local.get $op) (i32.const 0)) (i32.ne (local.get $op) (local.get $form)))
              (then (call $flag (i32.const 3))))
            (if (i32.eq (local.get $form) (i32.const 3))
              (then
                (if (i32.eqz (global.get $n)) (then (call $flag (i32.const 3))))
                ;; both names are fifo24 when both are known: the one profile has the one built-in digest
                (if (i32.and (i32.and (local.get $known) (local.get $known2))
                             (i32.eqz (call $eq32 (i32.const 2848) (i32.const 1632))))
                  (then (call $flag (i32.const 5))))
                (call $state_sha (i32.const 2976))
                (if (i32.eqz (call $eq32 (i32.const 2976) (i32.const 2912))) (then (call $flag (i32.const 7))))
                (call $head_of (i32.const 2688) (i32.const 2880) (i32.const 2848) (i32.const 2816) (global.get $tick)
                               (i32.const 2912) (i32.const 2752) (i32.const 2784) (i32.const 3008))
                (if (i32.eqz (call $eq32 (i32.const 3008) (i32.const 2720))) (then (call $flag (i32.const 8))))
                (if (i32.or (i32.eqz (call $eq32 (i32.const 2720) (i32.const 2944)))
                            (i32.ne (global.get $tick) (global.get $etick)))
                  (then (call $flag (i32.const 9))))
                (if (i32.or (i32.gt_u (global.get $n) (i32.const 1000))
                            (i64.gt_u (i64.add (i64.extend_i32_u (global.get $tick)) (i64.extend_i32_u (global.get $n)))
                                      (i64.const 2147483647)))
                  (then (call $flag (i32.const 11))))))))
        (if (i32.eqz (global.get $errs))
          (then
            (if (i32.eq (local.get $op) (i32.const 1)) (then (call $op_info)))
            (if (i32.eq (local.get $op) (i32.const 2)) (then (call $op_genesis)))
            (if (i32.eq (local.get $op) (i32.const 3)) (then (call $op_run)))))))
    (if (global.get $errs) (then (call $refuse)))
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.sub (global.get $o) (i32.const 65536))) (i64.const 32))
      (i64.const 65536))))
