#!/bin/sh
# ARK proof v0.1 acceptance, written by reader 2 (Go) (Go side) from CONTRACT.md and the acceptance list (the acceptance list).
# Drives reader 1's launchers (a/bin/*) and reader 2's Go tools (b) as black boxes, in fresh
# worlds under run/b-accept-<stamp>/. Prints one PASS or FAIL line per acceptance item 1..15, then
# checks 16..20 added after the mutation test (old-epoch approval; approval checks at the live receiver).
# Exit 0 only if every line is PASS. No network. TEST keys only (made by the tools in each world).
P="$(cd "$(dirname "$0")/.." && pwd)"
A="$P/a/bin"
BB="$P/b/bin"
VEC="$P/vectors"
FAILS=0
PASSES=0

# build reader 2's tools (stdlib only, nothing downloaded)
(cd "$P/b" && export GOTOOLCHAIN=local GOPROXY=off GOFLAGS= GOCACHE="$P/b/.gocache" &&
	mkdir -p bin && for c in verifier clientb bt vectorcheck; do ${GO:-go} build -o bin/$c ./cmd/$c || exit 1; done) ||
	{ echo "FAIL build of reader 2 (Go) tools"; exit 1; }

ROOT="$P/run/b-accept-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ROOT"
LOG="$ROOT/log.txt"
echo "worlds: $ROOT" >&2

pass() { echo "PASS $1 $2"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $1 $2"; FAILS=$((FAILS + 1)); }
q() { "$@" >>"$LOG" 2>&1; }                     # run quietly, keep exit code
cnt() { f="$1/eff/notes/demo.txt"; [ -f "$f" ] || { echo 0; return; }; grep -c "^$2 " "$f"; }
total() { f="$1/eff/notes/demo.txt"; [ -f "$f" ] || { echo 0; return; }; wc -l <"$f" | tr -d ' '; }
ans() { "$BB/bt" answer "$1/r/outbox/$2.ans.json" 2>>"$LOG"; }   # line1 "STATUS REASON", line2 outcome
ans1() { ans "$1" "$2" | sed -n 1p; }
ans2() { ans "$1" "$2" | sed -n 2p; }
runonce() { W=$1; shift; echo "+ receiver run-once $*" >>"$LOG"; "$A/receiver" run-once --home "$W/r" "$@" >>"$LOG" 2>&1; }
epoch() { "$A/receiver" epoch --home "$1/r" 2>>"$LOG"; }

# setup W "A B" -> owner, receiver recv-1, pins, client A (ca), client B (cb), grants gA gB, authority epoch 1
setup() {
	W=$1
	mkdir -p "$W"
	OK=$("$A/owner" init --home "$W/o" 2>>"$LOG" | awk '/^owner_key/{print $2}')
	q "$A/receiver" init --home "$W/r" --receiver-id recv-1 --owner-key "$OK" --effect-root "$W/eff"
	q "$A/receiver" pins --home "$W/r" --supplied-by "accept/run.sh (reader 2 (Go)), world $(basename "$W")" --out "$W/pins.json"
	CAK=$("$A/client-a" init --home "$W/ca" 2>>"$LOG" | awk '/^client_key/{print $2}')
	CBK=$("$BB/clientb" init --home "$W/cb" 2>>"$LOG" | awk '/^client_key/{print $2}')
	q "$A/owner" grant --home "$W/o" --client-key "$CAK" --receiver-id recv-1 --action append_line --resource notes/demo.txt --not-after +86400000 --out "$W/gA.json"
	q "$A/owner" grant --home "$W/o" --client-key "$CBK" --receiver-id recv-1 --action append_line --resource notes/demo.txt --not-after +86400000 --out "$W/gB.json"
	GL=""
	for g in $2; do GL="$GL --grant $W/g$g.json"; done
	q "$A/owner" authority --home "$W/o" --receiver-id recv-1 --epoch 1 $GL --out "$W/au1.json"
	q "$A/owner" deliver --home "$W/o" --receiver-home "$W/r" --authority "$W/au1.json" --wait-ms 0
	runonce "$W"
	[ "$(epoch "$W" | head -1)" = "epoch 1" ]
}
# propose with client A or B: prop W a|b GRANT TEXT OUT [extra] -> echoes op_id
prop() {
	W=$1; who=$2; g=$3; t=$4; out=$5; shift 5
	if [ "$who" = a ]; then
		"$A/client-a" propose --home "$W/ca" --grant "$W/$g.json" --text "$t" --out "$W/$out.json" "$@" 2>>"$LOG" | awk '/^op_id/{print $2}'
	else
		"$BB/clientb" propose --home "$W/cb" --grant "$W/$g.json" --text "$t" --out "$W/$out.json" "$@" 2>>"$LOG" | awk '/^op_id/{print $2}'
	fi
}
# approve W PROP EPOCH NOTAFTER OUT
appr() { q "$A/owner" approve --home "$1/o" --proposal "$1/$2.json" --receiver-id recv-1 --epoch "$3" --not-after "$4" --yes --out "$1/$5.json"; }
# send W a|b GRANT PROP APPR|- RID [extra]
send() {
	W=$1; who=$2; g=$3; p=$4; ap=$5; rid=$6; shift 6
	AP=""
	[ "$ap" != - ] && AP="--approval $W/$ap.json"
	if [ "$who" = a ]; then
		q "$A/client-a" send --home "$W/ca" --receiver-home "$W/r" --grant "$W/$g.json" --proposal "$W/$p.json" $AP --request-id "$rid" --wait-ms 0 "$@"
	else
		q "$BB/clientb" send --home "$W/cb" --receiver-home "$W/r" --grant "$W/$g.json" --proposal "$W/$p.json" $AP --request-id "$rid" --wait-ms 0 "$@"
	fi
}
collect() { if [ "$2" = a ]; then "$A/client-a" collect --home "$1/ca" --receiver-home "$1/r" --request-id "$3" 2>>"$LOG"; else "$BB/clientb" collect --home "$1/cb" --receiver-home "$1/r" --request-id "$3" 2>>"$LOG"; fi; }
verify() { "$BB/verifier" "$1" "$2" 2>>"$LOG"; }
# dlv W AUFILE: deliver an authority, run the receiver once, echo "STATUS REASON" of the new answer
dlv() {
	ls "$1/r/outbox" 2>/dev/null | sort >"$1/.ob-before"
	q "$A/owner" deliver --home "$1/o" --receiver-home "$1/r" --authority "$2" --wait-ms 0
	runonce "$1"
	NEWF=$(ls "$1/r/outbox" | sort | comm -13 "$1/.ob-before" - | head -1)
	[ -n "$NEWF" ] && "$BB/bt" answer "$1/r/outbox/$NEWF" 2>>"$LOG" | sed -n 1p
}

# ---------------------------------------------------------------- items 1-3
W="$ROOT/w1"
if setup "$W" "A B"; then
	OP1=$(prop "$W" a gA "item one: one approval, one effect" p1)
	appr "$W" p1 1 +600000 a1
	send "$W" a gA p1 a1 r1
	runonce "$W"
	S=$(ans1 "$W" r1)
	q collect "$W" a r1
	if [ "$S" = "DONE OK" ] && [ "$(cnt "$W" "$OP1")" = 1 ] && [ "$(total "$W")" = 1 ]; then
		pass 1 "one approval, one effect: outcome DONE, file has exactly one line with op_id $OP1"
	else fail 1 "answer '$S', lines with op_id: $(cnt "$W" "$OP1"), total lines $(total "$W")"; fi
	q "$A/client-a" export --home "$W/ca" --receiver-id recv-1 --out "$W/a.bundle.json"
	V=$(verify "$W/a.bundle.json" "$W/pins.json"); E=$?
	if [ $E = 0 ] && echo "$V" | grep -qx "OP $OP1 DONE" && echo "$V" | grep -qx "BUNDLE OK"; then
		pass 2 "reader 2's Go verifier, pins only, no network: OP $OP1 DONE on client A's exported bundle"
	else fail 2 "verifier exit $E: $(echo "$V" | tail -2 | tr '\n' ' ')"; fi
	AFTER=$("$BB/bt" outcome-field "$W/a.bundle.json" "$OP1" effect.after_sha256 2>>"$LOG")
	H=$(shasum -a 256 "$W/eff/notes/demo.txt" | awk '{print $1}')
	if [ -n "$AFTER" ] && [ "$AFTER" = "$H" ]; then pass 3 "shasum of the file itself equals the outcome's after_sha256 ($H)"
	else fail 3 "file sha '$H' vs outcome after_sha256 '$AFTER'"; fi
else
	fail 1 "world setup failed"; fail 2 "world setup failed"; fail 3 "world setup failed"
fi

# ---------------------------------------------------------------- item 4
ok4=1; why4=""
chk() { # chk BUNDLE PINS EXPECT_EXIT EXPECT_LINE_REGEX
	V=$(verify "$1" "$2"); E=$?
	if [ $E != "$3" ] || ! echo "$V" | grep -Eq "$4" || echo "$V" | grep -Eq '^OP .* DONE$'; then
		ok4=0; why4="$why4 $(basename "$1"):exit$E"
	fi
}
chk "$VEC/invalid-tampered-proposal-text.json" "$VEC/pins.json" 4 '^BUNDLE INVALID '
chk "$VEC/invalid-tampered-approval.json" "$VEC/pins.json" 4 '^BUNDLE INVALID '
chk "$VEC/invalid-tampered-outcome.json" "$VEC/pins.json" 4 '^BUNDLE INVALID '
chk "$VEC/invalid-approval-other-proposal.json" "$VEC/pins.json" 4 '^OP [0-9a-f]+ INVALID APPROVAL_MISMATCH$'
chk "$VEC/untrusted-key.done.json" "$VEC/pins-wrong-owner.json" 5 '^BUNDLE UNTRUSTED_KEY '
chk "$VEC/invalid-note-no-approval.json" "$VEC/pins.json" 4 '^OP [0-9a-f]+ INVALID NO_APPROVAL$'
chk "$VEC/unknown.bundle.json" "$VEC/pins.json" 3 '^OP [0-9a-f]+ UNKNOWN$'
W="$ROOT/w1"
if [ -f "$W/a.bundle.json" ]; then
	# live: flipped outcome signature; wrong owner pin; proposal+approval with no outcome
	"$BB/bt" flip-sig "$W/a.bundle.json" outcome "$W/flipped.bundle.json" 2>>"$LOG"
	chk "$W/flipped.bundle.json" "$W/pins.json" 4 '^BUNDLE INVALID BAD_SIGNATURE '
	OK2=$("$A/owner" init --home "$W/o-stranger" 2>>"$LOG" | awk '/^owner_key/{print $2}')
	RK=$(sed 's/.*"receiver_key":"\([0-9a-f]*\)".*/\1/' "$W/pins.json")
	printf '{"v":"0.1","owner_key":"%s","receiver_key":"%s","receiver_id":"recv-1","supplied_by":"run.sh: deliberately wrong owner pin"}\n' "$OK2" "$RK" >"$W/pins-wrong.json"
	chk "$W/a.bundle.json" "$W/pins-wrong.json" 5 '^BUNDLE UNTRUSTED_KEY '
	OPU=$(prop "$W" b gB "item four: never sent" pu)
	appr "$W" pu 1 +600000 au
	q "$BB/clientb" keep --home "$W/cb" "$W/au.json" "$W/gB.json"
	q "$BB/clientb" export --home "$W/cb" --receiver-id recv-1 --out "$W/b-unknown.bundle.json"
	chk "$W/b-unknown.bundle.json" "$W/pins.json" 3 "^OP $OPU UNKNOWN\$"
else ok4=0; why4="$why4 no-live-bundle"; fi
if [ $ok4 = 1 ]; then pass 4 "changed text/approval/outcome/signature and approval-of-another-proposal: INVALID; wrong pin: UNTRUSTED_KEY; no approval: INVALID; no outcome: UNKNOWN; never DONE (7 vectors + 3 live)"
else fail 4 "unexpected verdicts:$why4"; fi

# ---------------------------------------------------------------- items 5-6
W="$ROOT/w5"
if setup "$W" "A"; then
	OP5=$(prop "$W" a gA "item five: retried many times" p5)
	appr "$W" p5 1 +600000 a5
	for i in 1 2 3 4 5 6 7 8; do send "$W" a gA p5 a5 r5-$i; done
	for i in 1 2 3 4; do runonce "$W" & done
	wait
	runonce "$W"
	REF=$(ans2 "$W" r5-1); ok5=1
	for i in 1 2 3 4 5 6 7 8; do
		[ "$(ans1 "$W" r5-$i)" = "DONE OK" ] && [ "$(ans2 "$W" r5-$i)" = "$REF" ] || ok5=0
	done
	send "$W" a gA p5 a5 r5-9   # once more after a receiver restart (a new receiver process)
	runonce "$W"
	[ "$(ans1 "$W" r5-9)" = "DONE OK" ] && [ "$(ans2 "$W" r5-9)" = "$REF" ] || ok5=0
	[ -n "$REF" ] && [ "$REF" != null ] || ok5=0
	if [ $ok5 = 1 ] && [ "$(cnt "$W" "$OP5")" = 1 ] && [ "$(total "$W")" = 1 ]; then
		pass 5 "8 identical requests at once (4 receiver processes racing) + 1 after restart: 9 answers DONE, identical outcome bytes, one line"
	else fail 5 "identical=$ok5 lines=$(cnt "$W" "$OP5") total=$(total "$W")"; fi
	prop "$W" a gA "item six: different text" p6 --op-id "$OP5" >/dev/null
	appr "$W" p6 1 +600000 a6
	send "$W" a gA p6 a6 r6
	runonce "$W"
	S=$(ans1 "$W" r6)
	if [ "$S" = "REJECTED OP_ID_REUSED" ] && [ "$(ans2 "$W" r6)" = null ] && [ "$(total "$W")" = 1 ] && ! grep -q "different text" "$W/eff/notes/demo.txt"; then
		pass 6 "same op_id, different text: REJECTED OP_ID_REUSED (contract s10 mapping of 'REFUSED'), no outcome, no effect"
	else fail 6 "answer '$S', total lines $(total "$W")"; fi
else fail 5 "world setup failed"; fail 6 "world setup failed"; fi

# ---------------------------------------------------------------- item 7 (client B)
W="$ROOT/w7"
if setup "$W" "B"; then
	OP7=$(prop "$W" b gB "item seven: the answer is lost" p7)
	appr "$W" p7 1 +600000 a7
	send "$W" b gB p7 a7 r7
	runonce "$W" --fault drop-answer
	collect "$W" b r7 >>"$LOG"; C1=$?
	q "$BB/clientb" export --home "$W/cb" --receiver-id recv-1 --out "$W/b7-before.json"
	V=$(verify "$W/b7-before.json" "$W/pins.json"); E1=$?
	"$BB/clientb" propose --home "$W/cb" --grant "$W/gB.json" --text "a new op would be wrong" --out "$W/p7x.json" >>"$LOG" 2>&1; NEW=$?
	PEND=$("$BB/clientb" pending --home "$W/cb" 2>>"$LOG" | tr '\n' ' ')
	q "$BB/clientb" status --home "$W/cb" --receiver-home "$W/r" --op-id "$OP7" --request-id s7 --wait-ms 0
	runonce "$W"
	collect "$W" b s7 >>"$LOG"; C2=$?
	q "$BB/clientb" export --home "$W/cb" --receiver-id recv-1 --out "$W/b7-after.json"
	V2=$(verify "$W/b7-after.json" "$W/pins.json"); E2=$?
	PEND2=$("$BB/clientb" pending --home "$W/cb" 2>>"$LOG" | tr '\n' ' ')
	if [ $C1 = 3 ] && [ $E1 = 3 ] && echo "$V" | grep -qx "OP $OP7 UNKNOWN" && [ $NEW != 0 ] && [ ! -f "$W/p7x.json" ] &&
		[ "$PEND" = "$OP7 UNKNOWN " ] && [ $C2 = 0 ] && [ $E2 = 0 ] && echo "$V2" | grep -qx "OP $OP7 DONE" &&
		[ "$PEND2" = "$OP7 DONE " ] && [ "$(cnt "$W" "$OP7")" = 1 ] && [ "$(total "$W")" = 1 ]; then
		pass 7 "lost answer: client B and verifier say UNKNOWN, client B refuses a new op_id, status settles DONE, one line"
	else fail 7 "collect=$C1 verify=$E1 newop=$NEW pending='$PEND' status=$C2 verify2=$E2 pending2='$PEND2' lines=$(total "$W")"; fi
else fail 7 "world setup failed"; fi

# ---------------------------------------------------------------- item 8 (client A)
W="$ROOT/w8"
if setup "$W" "A"; then
	OP8=$(prop "$W" a gA "item eight: hard kill after effect" p8)
	appr "$W" p8 1 +600000 a8
	send "$W" a gA p8 a8 r8
	runonce "$W" --fault die-after-effect; K=$?
	L1=$(cnt "$W" "$OP8")
	send "$W" a gA p8 a8 r8b
	runonce "$W"
	S=$(ans1 "$W" r8b); O8=$(ans2 "$W" r8b)
	send "$W" a gA p8 a8 r8c
	runonce "$W"
	if [ $K != 0 ] && [ "$L1" = 1 ] && [ "$S" = "DONE OK" ] && [ "$(ans2 "$W" r8c)" = "$O8" ] && [ "$(cnt "$W" "$OP8")" = 1 ] && [ "$(total "$W")" = 1 ]; then
		pass 8 "killed after the effect (receiver exit $K): after restart the retry gives DONE once, stable on a second retry, one line"
	else fail 8 "kill exit=$K lines-after-kill=$L1 retry='$S' lines=$(total "$W")"; fi
else fail 8 "world setup failed"; fi

# ---------------------------------------------------------------- item 9 (client B)
W="$ROOT/w9"
if setup "$W" "B"; then
	OP9=$(prop "$W" b gB "item nine: the request is lost" p9)
	appr "$W" p9 1 +600000 a9
	send "$W" b gB p9 a9 r9
	runonce "$W" --fault drop-request
	collect "$W" b r9 >>"$LOG"; C1=$?
	L0=$(total "$W")
	q "$BB/clientb" export --home "$W/cb" --receiver-id recv-1 --out "$W/b9.json"
	V=$(verify "$W/b9.json" "$W/pins.json"); E1=$?
	q "$BB/clientb" retry --home "$W/cb" --receiver-home "$W/r" --op-id "$OP9" --request-id r9b --wait-ms 0
	runonce "$W"
	collect "$W" b r9b >>"$LOG"; C2=$?
	q "$BB/clientb" retry --home "$W/cb" --receiver-home "$W/r" --op-id "$OP9" --request-id r9c --wait-ms 0
	runonce "$W"
	if [ $C1 = 3 ] && [ "$L0" = 0 ] && [ $E1 = 3 ] && echo "$V" | grep -qx "OP $OP9 UNKNOWN" && [ $C2 = 0 ] &&
		[ "$(ans2 "$W" r9b)" = "$(ans2 "$W" r9c)" ] && [ "$(cnt "$W" "$OP9")" = 1 ] && [ "$(total "$W")" = 1 ]; then
		pass 9 "lost request: UNKNOWN (not 'not done'); retry with the same op_id runs once; second retry same outcome; one line"
	else fail 9 "collect=$C1 lines-before=$L0 verify=$E1 retry=$C2 lines=$(total "$W")"; fi
else fail 9 "world setup failed"; fi

# ---------------------------------------------------------------- items 10-12
W="$ROOT/w10"
if setup "$W" "A"; then
	OPA=$(prop "$W" a gA "item ten: the first operation" p10)
	appr "$W" p10 1 +600000 a10
	send "$W" a gA p10 a10 r10-1
	runonce "$W"
	q collect "$W" a r10-1
	q "$A/receiver" archive --home "$W/r" --out-dir "$W/arch1"
	q "$A/owner" authority --home "$W/o" --receiver-id recv-1 --epoch 2 --grant "$W/gB.json" --out "$W/au2.json"
	q "$A/owner" deliver --home "$W/o" --receiver-home "$W/r" --authority "$W/au2.json" --wait-ms 0
	runonce "$W"
	EP=$(epoch "$W" | head -1)
	# (a)
	q "$BB/clientb" keep --home "$W/cb" "$W/arch1/archive.bundle.json"
	q "$BB/clientb" export --home "$W/cb" --receiver-id recv-1 --out "$W/b10a.json"
	V=$(verify "$W/b10a.json" "$W/pins.json"); E=$?
	ra=0; [ "$EP" = "epoch 2" ] && [ $E = 0 ] && echo "$V" | grep -qx "OP $OPA DONE" && ra=1
	# (b) A with an approval signed at epoch 1
	OPB=$(prop "$W" a gA "item ten b: old authority" p10b)
	appr "$W" p10b 1 +600000 a10b
	send "$W" a gA p10b a10b r10b
	runonce "$W"
	SB=$(ans1 "$W" r10b); q collect "$W" a r10b
	rb=0; case "$SB" in "REFUSED "*) [ "$(cnt "$W" "$OPB")" = 0 ] && rb=1 ;; esac
	# (c) B under A's grant with B's key
	OPC=$(prop "$W" b gA "item ten c: wrong client" p10c)
	appr "$W" p10c 2 +600000 a10c
	send "$W" b gA p10c a10c r10c
	runonce "$W"
	SC=$(ans1 "$W" r10c); q collect "$W" b r10c
	rc=0; [ "$SC" = "REJECTED WRONG_CLIENT" ] && [ "$(cnt "$W" "$OPC")" = 0 ] && rc=1
	# (d) epoch 1 authority replayed
	q "$A/owner" deliver --home "$W/o" --receiver-home "$W/r" --authority "$W/au1.json" --wait-ms 0
	runonce "$W"
	rd=0; [ "$(epoch "$W" | head -1)" = "epoch 2" ] && grep -l '"status":"REJECTED","reason":"STALE_AUTHORITY"' "$W"/r/outbox/*.ans.json >/dev/null 2>&1 && rd=1
	# (e) first operation replayed byte for byte
	send "$W" a gA p10 a10 r10e
	runonce "$W"
	re=0; [ "$(ans1 "$W" r10e)" = "DONE OK" ] && [ "$(ans2 "$W" r10e)" = "$(ans2 "$W" r10-1)" ] && [ "$(cnt "$W" "$OPA")" = 1 ] && re=1
	# (f) B with its own grant and a fresh approval
	OPF=$(prop "$W" b gB "item ten f: client B takes over" p10f)
	appr "$W" p10f 2 +600000 a10f
	send "$W" b gB p10f a10f r10f
	runonce "$W"
	collect "$W" b r10f >>"$LOG"; CF=$?
	q "$BB/clientb" retry --home "$W/cb" --receiver-home "$W/r" --op-id "$OPF" --request-id r10f2 --wait-ms 0
	runonce "$W"
	rf=0; [ $CF = 0 ] && [ "$(ans2 "$W" r10f2)" = "$(ans2 "$W" r10f)" ] && [ "$(cnt "$W" "$OPF")" = 1 ] && [ "$(total "$W")" = 2 ] && rf=1
	if [ $ra$rb$rc$rd$re$rf = 111111 ]; then
		pass 10 "replace client A: (a) B verifies A's archived receipt DONE (b) epoch-1 approval '$SB' no effect (c) B under A's grant REJECTED WRONG_CLIENT (d) epoch-1 replay REJECTED STALE_AUTHORITY, epoch stays 2 (e) replay returns stored outcome, no new line (f) B DONE once"
	else fail 10 "a=$ra b=$rb('$SB') c=$rc('$SC') d=$rd e=$re f=$rf (epoch '$EP', verify exit $E)"; fi

	# ------------------------------------------------------------ item 11
	T0=$(total "$W")
	OP11=$(prop "$W" b gB "item eleven: out of scope" p11 --resource notes/other.txt)
	appr "$W" p11 2 +600000 a11
	send "$W" b gB p11 a11 r11
	runonce "$W"
	S11=$(ans1 "$W" r11); q collect "$W" b r11
	if [ -n "$OP11" ] && [ "$S11" = "REFUSED SCOPE_MISMATCH" ] && [ ! -e "$W/eff/notes/other.txt" ] && [ "$(total "$W")" = "$T0" ]; then
		pass 11 "another resource with an owner approval: REFUSED SCOPE_MISMATCH, no effect"
	else fail 11 "op '$OP11' answer '$S11'"; fi

	# ------------------------------------------------------------ item 12
	q "$A/receiver" archive --home "$W/r" --out-dir "$W/arch2"
	rm -rf "$W/r/state"
	RS=$("$A/receiver" restore --home "$W/r" "$W/arch2" 2>>"$LOG")
	E12=$(epoch "$W" | tr '\n' ' ')
	"$A/receiver" status --home "$W/r" "$OPA" >>"$LOG" 2>&1; ST=$?
	OP12a=$(prop "$W" b gB "item twelve: write while locked" p12a)
	appr "$W" p12a 2 +600000 a12a
	send "$W" b gB p12a a12a r12a
	runonce "$W"
	S12a=$(ans1 "$W" r12a); q collect "$W" b r12a
	D1=$(dlv "$W" "$W/au1.json")
	D2=$(dlv "$W" "$W/au2.json")
	E12b=$(epoch "$W" | tr '\n' ' ')
	q "$A/owner" authority --home "$W/o" --receiver-id recv-1 --epoch 3 --grant "$W/gB.json" --out "$W/au3.json"
	D3=$(dlv "$W" "$W/au3.json")
	E12c=$(epoch "$W" | tr '\n' ' ')
	OP12b=$(prop "$W" b gB "item twelve: after epoch 3" p12b)
	appr "$W" p12b 3 +600000 a12b
	send "$W" b gB p12b a12b r12b
	runonce "$W"
	S12b=$(ans1 "$W" r12b); q collect "$W" b r12b
	if [ $ST = 0 ] && echo "$E12" | grep -q "locked floor 2" && [ "$S12a" = "REFUSED LOCKED_AFTER_RESTORE" ] &&
		[ "$(cnt "$W" "$OP12a")" = 0 ] && echo "$E12b" | grep -q "locked floor 2" && [ "$E12c" = "epoch 3 " ] &&
		[ "$D1" = "REJECTED STALE_AUTHORITY" ] && [ "$D2" = "REJECTED STALE_AUTHORITY" ] && [ "$D3" = "ACCEPTED OK" ] &&
		[ "$S12b" = "DONE OK" ] && [ "$(cnt "$W" "$OP12b")" = 1 ] && [ "$(cnt "$W" "$OPA")" = 1 ]; then
		pass 12 "wipe + restore ('$RS'): old outcome readable, write REFUSED LOCKED_AFTER_RESTORE (exact), epochs 1 and 2 REJECTED STALE_AUTHORITY (exact), epoch 3 ACCEPTED, then DONE"
	else fail 12 "restore='$RS' status=$ST epoch='$E12' locked-write='$S12a' ep1='$D1' ep2='$D2' after-1-2='$E12b' ep3='$D3' after-3='$E12c' write='$S12b'"; fi
else fail 10 "world setup failed"; fail 11 "world setup failed"; fail 12 "world setup failed"; fi

# ---------------------------------------------------------------- items 13-14
W="$ROOT/w13"
if setup "$W" "A"; then
	PH=$("$A/client-a" propose --home "$W/ca" --grant "$W/gA.json" --text "item thirteen: a note is not an approval" --out "$W/p13.json" 2>>"$LOG")
	OP13=$(echo "$PH" | awk '{print $2}'); H13=$(echo "$PH" | awk '{print $4}')
	q "$A/client-a" note --home "$W/ca" --about "$H13" --label assessment --text "safe, approved" --out "$W/n13.json"
	send "$W" a gA p13 - r13 --note "$W/n13.json"
	runonce "$W"
	S13=$(ans1 "$W" r13); q collect "$W" a r13
	q "$A/client-a" export --home "$W/ca" --receiver-id recv-1 --out "$W/a13.json"
	V=$(verify "$W/a13.json" "$W/pins.json"); E=$?
	VV=$(verify "$VEC/invalid-note-no-approval.json" "$VEC/pins.json"); EV=$?
	if [ "$S13" = "REFUSED NO_APPROVAL" ] && [ "$(cnt "$W" "$OP13")" = 0 ] && [ $E = 0 ] && echo "$V" | grep -qx "OP $OP13 REFUSED" &&
		[ $EV = 4 ] && echo "$VV" | grep -Eq '^OP [0-9a-f]+ INVALID NO_APPROVAL$'; then
		pass 13 "note 'safe, approved' and no approval: receiver REFUSED NO_APPROVAL (verifies REFUSED); a DONE claimed on that basis is INVALID NO_APPROVAL"
	else fail 13 "answer '$S13' verify=$E vector=$EV"; fi
	OP14=$(prop "$W" a gA "item fourteen: expired approval" p14)
	appr "$W" p14 1 -1000 a14
	send "$W" a gA p14 a14 r14
	runonce "$W"
	S14=$(ans1 "$W" r14)
	if [ "$S14" = "REFUSED APPROVAL_EXPIRED" ] && [ "$(cnt "$W" "$OP14")" = 0 ]; then pass 14 "expired approval: REFUSED APPROVAL_EXPIRED, no effect"
	else fail 14 "answer '$S14'"; fi
else fail 13 "world setup failed"; fail 14 "world setup failed"; fi

# ---------------------------------------------------------------- item 15
if [ -f "$P/INDEPENDENCE.md" ] && [ -f "$P/CONTRACT-ISSUES.md" ] && grep -q "Go" "$P/INDEPENDENCE.md"; then
	pass 15 "independence record: INDEPENDENCE.md (files read, two languages: Node side A, Go side B) and CONTRACT-ISSUES.md"
else fail 15 "INDEPENDENCE.md or CONTRACT-ISSUES.md missing"; fi

# ---------------------------------------------------------------- item 16 (added after the mutation test)
# Valid-but-old authority: epoch 2 STILL lists A's grant, so only the epoch rule can refuse.
W="$ROOT/w16"
if setup "$W" "A B"; then
	OP0=$(prop "$W" a gA "item sixteen: first line at epoch 1" p16-0)
	appr "$W" p16-0 1 +600000 a16-0
	send "$W" a gA p16-0 a16-0 r16-0
	runonce "$W"
	S0=$(ans1 "$W" r16-0)
	q "$A/owner" authority --home "$W/o" --receiver-id recv-1 --epoch 2 --grant "$W/gA.json" --grant "$W/gB.json" --out "$W/au2.json"
	DA=$(dlv "$W" "$W/au2.json")
	EP=$(epoch "$W" | head -1)
	T0=$(total "$W")
	OPS=$(prop "$W" a gA "item sixteen: approval from the old epoch" p16)
	appr "$W" p16 1 +600000 a16-old
	send "$W" a gA p16 a16-old r16-old
	runonce "$W"
	SO=$(ans1 "$W" r16-old)
	# R4: the first signed outcome for an op_id is final, so the same proposal with a fresh epoch-2
	# approval must return the stored REFUSED, with no effect.
	appr "$W" p16 2 +600000 a16-new
	send "$W" a gA p16 a16-new r16-same
	runonce "$W"
	SS=$(ans1 "$W" r16-same)
	# a new op_id with a fresh epoch-2 approval: DONE exactly once (retried once more)
	OPN=$(prop "$W" a gA "item sixteen: fresh approval at epoch 2" p16n)
	appr "$W" p16n 2 +600000 a16n
	send "$W" a gA p16n a16n r16n
	runonce "$W"
	send "$W" a gA p16n a16n r16n2
	runonce "$W"
	SN=$(ans1 "$W" r16n)
	if [ "$S0" = "DONE OK" ] && [ "$DA" = "ACCEPTED OK" ] && [ "$EP" = "epoch 2" ] && [ "$T0" = 1 ] &&
		[ "$SO" = "REFUSED STALE_EPOCH" ] && [ "$SS" = "REFUSED STALE_EPOCH" ] &&
		[ "$(ans2 "$W" r16-same)" = "$(ans2 "$W" r16-old)" ] && [ "$(cnt "$W" "$OPS")" = 0 ] &&
		[ "$SN" = "DONE OK" ] && [ "$(ans2 "$W" r16n2)" = "$(ans2 "$W" r16n)" ] && [ "$(cnt "$W" "$OPN")" = 1 ] &&
		[ "$(total "$W")" = 2 ]; then
		pass 16 "valid-but-old authority (epoch 2 still lists A's grant): epoch-1 approval REFUSED STALE_EPOCH, no effect; same op_id with fresh approval returns the stored REFUSED (R4 finality); new op_id with epoch-2 approval DONE once"
	else fail 16 "first='$S0' deliver='$DA' epoch='$EP' old='$SO' same-op='$SS' new='$SN' lines=$(total "$W")"; fi
else fail 16 "world setup failed"; fi

# ---------------------------------------------------------------- items 17-19: approval checks at the live receiver
W="$ROOT/w17"
if setup "$W" "A"; then
	# 17: approval names a different proposal
	OPX=$(prop "$W" a gA "item seventeen: proposal X" p17x)
	OPY=$(prop "$W" a gA "item seventeen: proposal Y" p17y)
	appr "$W" p17y 1 +600000 a17y
	send "$W" a gA p17x a17y r17
	runonce "$W"
	S17=$(ans1 "$W" r17)
	if [ -n "$OPY" ] && [ "$S17" = "REFUSED APPROVAL_MISMATCH" ] && [ "$(cnt "$W" "$OPX")" = 0 ] && [ "$(total "$W")" = 0 ]; then
		pass 17 "approval for a different proposal: REFUSED APPROVAL_MISMATCH, no effect"
	else fail 17 "answer '$S17', lines $(total "$W")"; fi
	# 18: decision refuse
	OPR=$(prop "$W" a gA "item eighteen: the owner says no" p18)
	q "$A/owner" approve --home "$W/o" --proposal "$W/p18.json" --receiver-id recv-1 --epoch 1 --not-after +600000 --decision refuse --yes --out "$W/a18.json"
	if [ -f "$W/a18.json" ]; then
		send "$W" a gA p18 a18 r18
		runonce "$W"
		S18=$(ans1 "$W" r18)
		if [ "$S18" = "REFUSED OWNER_REFUSED" ] && [ "$(cnt "$W" "$OPR")" = 0 ] && [ "$(total "$W")" = 0 ]; then
			pass 18 "approval with decision refuse: REFUSED OWNER_REFUSED, no effect"
		else fail 18 "answer '$S18', lines $(total "$W")"; fi
	else fail 18 "owner tool did not produce a refuse approval"; fi
	# 19: approval names another receiver id
	OPW=$(prop "$W" a gA "item nineteen: approval for another receiver" p19)
	q "$A/owner" approve --home "$W/o" --proposal "$W/p19.json" --receiver-id recv-2 --epoch 1 --not-after +600000 --yes --out "$W/a19.json"
	if [ -f "$W/a19.json" ]; then
		send "$W" a gA p19 a19 r19
		runonce "$W"
		S19=$(ans1 "$W" r19)
		if [ "$S19" = "REFUSED WRONG_RECEIVER" ] && [ "$(cnt "$W" "$OPW")" = 0 ] && [ "$(total "$W")" = 0 ]; then
			pass 19 "approval naming another receiver id (recv-2): REFUSED WRONG_RECEIVER, no effect"
		else fail 19 "answer '$S19', lines $(total "$W")"; fi
	else fail 19 "owner tool did not produce an approval for receiver recv-2"; fi
else fail 17 "world setup failed"; fail 18 "world setup failed"; fail 19 "world setup failed"; fi

# ---------------------------------------------------------------- item 20: expired grant (own fresh world)
# The expired grant IS listed in the current authority, so only the grant-expiry rule can refuse.
W="$ROOT/w20"
if setup "$W" "A"; then
	q "$A/owner" grant --home "$W/o" --client-key "$CAK" --receiver-id recv-1 --action append_line --resource notes/demo.txt --not-after -1000 --out "$W/gX.json"
	if [ -f "$W/gX.json" ]; then
		q "$A/owner" authority --home "$W/o" --receiver-id recv-1 --epoch 2 --grant "$W/gA.json" --grant "$W/gX.json" --out "$W/au2.json"
		DX=$(dlv "$W" "$W/au2.json")
		OPX=$(prop "$W" a gX "item twenty: grant already expired" p20)
		appr "$W" p20 2 +600000 a20
		send "$W" a gX p20 a20 r20
		runonce "$W"
		S20=$(ans1 "$W" r20)
		if [ "$DX" = "ACCEPTED OK" ] && [ -n "$OPX" ] && [ "$S20" = "REFUSED GRANT_EXPIRED" ] && [ "$(cnt "$W" "$OPX")" = 0 ] && [ "$(total "$W")" = 0 ]; then
			pass 20 "expired grant listed in the current authority, fresh valid approval: REFUSED GRANT_EXPIRED, no effect"
		else fail 20 "deliver='$DX' op='$OPX' answer='$S20' lines=$(total "$W")"; fi
	else fail 20 "owner tool did not produce a grant with --not-after -1000"; fi
else fail 20 "world setup failed"; fi

echo "accept: $PASSES PASS, $FAILS FAIL (worlds in $ROOT, log $LOG)"
[ $FAILS = 0 ]
