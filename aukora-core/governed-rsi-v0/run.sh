#!/bin/sh
# Acceptance for governed organ optimisation v0 (fixture version). From the lab folder: sh governed-rsi-v0/run.sh
# Takes the one-job lock (it runs about twenty one-second Lean checks). Prints PASS only if all three mandatory
# results hold, the cold replay reproduces every decision, and the three tamper checks behave as stated.
set -eu
cd "$(dirname "$0")/.."
( set -o noclobber; echo "HOLDER=${HOLDER:-GOVERNED-RSI} START=$(date '+%F %T') JOB=governed-rsi-v0" > LEAN-JOB-HOLDER.txt ) 2>/dev/null || { echo "SLOT HELD:"; cat LEAN-JOB-HOLDER.txt; exit 3; }
trap 'rm -f LEAN-JOB-HOLDER.txt' EXIT
G=governed-rsi-v0; rm -rf $G/out $G/work $G/tamper; ( cd $G && shasum -a 256 -c candidates/PRECOMMIT.sha256 >/dev/null )
node $G/run.mjs > $G/run.txt; cat $G/run.txt
ok() { grep -q "$1" $G/run.txt || { echo "MISSING: $1"; exit 1; }; }
ok " 1 A lawful-improvement   governed   ADMIT ELIGIBLE_AND_BETTER"          # 1. a real improvement lands
ok " 2 V better-but-unlawful  score_only ADMIT BETTER_SCORE"                 # 2. the score-only arm takes the violator
ok " 2 V better-but-unlawful  governed   REFUSE LAW_VIOLATED"                #    the governed arm refuses it for the law
ok " 3 V law-dropped          governed   REFUSE LAWSET_CONTINUITY"           #    and a dropped law fails for a DIFFERENT reason
ok " 4 C altered-evaluator    governed   REFUSE JUDGE_MISMATCH"              # 3. an altered judge is refused before any score
ok "proposer-step-1        governed   ADMIT ELIGIBLE_AND_BETTER"             #    and the same clean bytes pass under the original judge
node $G/replay.mjs $G/out/ $G/out/retained/checkpoint.json | tee $G/replay.txt; grep -q "COLD REPLAY: PASS" $G/replay.txt
mkdir -p $G/tamper
cp -R $G/out $G/tamper/artifact; f=$(ls $G/tamper/artifact/artifacts/4828e6d7*.bin); printf '\001' | dd of="$f" bs=1 seek=5 conv=notrunc 2>/dev/null
node $G/replay.mjs $G/tamper/artifact/ none > $G/tamper/artifact.txt 2>&1 && { echo "TAMPER 1 NOT CAUGHT"; exit 1; }; echo "tamper 1 (a past artifact changed): $(tail -1 $G/tamper/artifact.txt)"
cp -R $G/out $G/tamper/line; python3 - "$G/tamper/line/record.log" <<'PY'
import sys; p=sys.argv[1]; l=open(p).read().split('\n'); l[5]=l[5][:-2]+('00' if l[5][-2:]!='00' else '01'); open(p,'w').write('\n'.join(l))
PY
node $G/replay.mjs $G/tamper/line/ none > $G/tamper/line.txt 2>&1 && { echo "TAMPER 2 NOT CAUGHT"; exit 1; }; echo "tamper 2 (a past record line changed): $(tail -1 $G/tamper/line.txt)"
cp -R $G/out $G/tamper/short; python3 - "$G/tamper/short/record.log" <<'PY'
import sys; p=sys.argv[1]; l=open(p).read().rstrip('\n').split('\n'); open(p,'w').write('\n'.join(l[:-4])+'\n')
PY
node $G/replay.mjs $G/tamper/short/ none > $G/tamper/short-none.txt 2>&1 || true; echo "shortened by 4 lines, reader with NO checkpoint: $(tail -1 $G/tamper/short-none.txt)"
node $G/replay.mjs $G/tamper/short/ $G/out/retained/checkpoint.json > $G/tamper/short-early.txt 2>&1 || true; echo "shortened, reader with a checkpoint from BEFORE the cut: $(tail -1 $G/tamper/short-early.txt)"
python3 -c "import json;d=json.load(open('$G/out/final.json'));json.dump({'seq':d['lines'],'head':d['head']},open('$G/tamper/late.json','w'))"
node $G/replay.mjs $G/tamper/short/ $G/tamper/late.json > $G/tamper/short-late.txt 2>&1 && { echo "TAMPER 3 NOT CAUGHT WITH A LATE CHECKPOINT"; exit 1; }; echo "shortened, reader with a checkpoint from AFTER the cut: $(tail -1 $G/tamper/short-late.txt)"
node $G/lying-hint.mjs $G/out/ | tee $G/lying-hint.txt; grep -q "^HARM EXECUTED" $G/lying-hint.txt      # the harm is run, not only proved
echo "PASS governed-organ-v0 (fixture version)"
