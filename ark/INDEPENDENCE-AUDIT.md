# INDEPENDENCE AUDIT of reader 2 (Go) (read-only audit, 2026-11-21)

Question: did reader 2 (Go) ever open, list, grep or read reader 1's source files?
Audited: the build session that wrote reader 2 (machine-written).

## Evidence used (SOURCE)
- The session list returned all 315 messages but shows tool calls only as "(called Bash)" without arguments, so it cannot prove anything about paths. It was used only for the narrative.
- The real evidence is the session's own transcript on disk (kept privately; it is not in this repository).
  Parsed with a short `python3 -I` script, read-only. 61 `tool_use` records, of which 23 are repeated records of the same call ids (5 of the repeats differ only in whitespace normalisation of Write/Edit inputs, same file paths). Unique tool calls: **38**.
- Tool mix: shell 10, file write 13, file edit 4, file read 4, and 8 housekeeping calls that touch no path. There was no search tool, no sub-agent, no web fetch or search, no browser or desktop-control call. No subagent files exist for the session.
- I also read the final `accept/run.sh` and grepped B's Go sources on disk (the commands inside run.sh run inside B's Bash call), and scanned every tool result in the transcript for A paths (`a/`, `.mjs`, `node_modules`, `require(`, `c/`, and the names of the private working notes).

## Table of all non-trivial calls (reads, lists, greps, finds, launcher runs; builds and own-file edits counted below)

| # | Tool | What it touched | Class |
|---|------|-----------------|-------|
| 1 | Read | reader 2's written instructions (not on the rule list, but the launching message ordered reader 2 to read and follow them; not published) | ALLOWED (instructed) |
| 5 | Read | the hand-off note of reader 1 (not published) | ALLOWED |
| 6 | Read | `CONTRACT.md` | ALLOWED |
| 7 | Bash | `cd vectors && ls -la && cat expected-verdicts.json` | ALLOWED |
| 8 | Bash | `cat vectors/pins.json pins-wrong-owner.json`, `head -c 1200 vectors/done.bundle.json`, `cat vectors/done.demo.txt`, and **a heading listing of the design review** | vectors ALLOWED; the heading grep is a MINOR listing (see below) |
| 9 | Read | the design review, lines 113-203 = exactly sections 4 and 5 (section 6 starts at line 204) | ALLOWED |
| 11 | Bash | **`ls` in this folder** and **`ls run \| head`** (then `mkdir -p b/... accept`, `go mod init arkb`, `cat go.mod`) | MINOR listings (see below) |
| 25 | Bash | Probe world `run/b-dev`: ran `a/bin/owner init` three times (launcher execution), `ls $W/o` (B's own world) | ALLOWED |
| 26 | Bash | Same own world `run/b-dev`: ran `a/bin/owner` (init, grant, authority, approve, deliver), `a/bin/receiver` (init, pins, run-once, epoch), `a/bin/client-a init`, B's `clientb`, B's `verifier`; `ls $W/r/inbox`, `ls $W/r/outbox`, `cat $W/r/outbox/*`, `cat $W/pins.json`, `cat $W/eff/notes/demo.txt` (all inside B's own world) | ALLOWED (launchers executed only; reads only in own world) |
| 35 | Bash | `rm -rf run/b-dev`, then `./accept/run.sh` once. The script was read from disk: every `$A/...` use is an invocation of `receiver`, `owner` or `client-a` (subcommands: init, pins, grant, authority, deliver, approve, run-once, epoch, archive, restore, status, propose, send, collect, note, export); its `cat/head/sed/grep` act only on `$W` (its own `run/b-accept-*` world). No `ls`/`find`/`cat` of `a`, no `--help`. | ALLOWED |
| 36 | Bash | `rm -rf .gocache bin` in `b`, `ls -A`, `du -sh ../run/b-accept-*` (wildcard matches only B's own worlds) | ALLOWED |

Plain builds, tests and edits of B's own files (counted, all under allowed write paths):
- Bash #11 (mkdir/go mod init part), #19 `run-vectors.sh`, #24 `go vet/test/build` + `ls -la bin` + `du -sh .gocache`, #31 `go test` + `run-vectors.sh`: all inside `b`. ALLOWED.
- Write x13: `b/ark/{json,item,schema,verify,ark_test}.go`, `b/cmd/{verifier,vectorcheck,clientb,bt}/main.go`, `b/run-vectors.sh`, `accept/run.sh`, `CONTRACT-ISSUES.md`, `INDEPENDENCE.md`. All ALLOWED write paths.
- Edit x4: `b/ark/item.go` (2), `b/ark/schema.go` (1), `INDEPENDENCE.md` (1). All ALLOWED.
- Housekeeping (no path touched): calls #2, #3 (the model check, allowed), #4, #10, #20, #34 and #38.

## What the minor listings revealed
- Call 8, a heading listing of the design review: printed the six heading lines of the whole review: six numbered headings (go or no-go, design risks, what carries forward, the smallest v0.1 contract, the acceptance list, tag notes). Read literally, that is heading text from sections outside 4 and 5 (B used it to find the line range; its INDEPENDENCE.md says so). No A material.
- Call 11, `ls` in this folder: printed `CONTRACT.md`, the hand-off note, `a`, `c`, `run`, `vectors`, `vectors-world`. It revealed only the existence of the directories `a`, `c` (third reader's work) and `vectors-world`; no file names inside `a/`, `c/` or `vectors-world/`.
- Call 11, `ls run | head` (lists `run/`, outside `b-*`): printed nothing (empty or absent), so no other session's world names were revealed.

## Checks asked for specifically
- Any Read/cat/head/sed/grep/ls/find/rg on `a/` other than executing the three launchers: none.
- `cat` or read of a launcher file: none.
- `find proof` / `grep -r` over `proof`: none. No Grep or Glob tool used at all.
- Read of `c/`, reader 1's instructions, the private working notes or any other working file: none (only reader 2's own instructions, call 1, which the launching message ordered).
- Read of `run/` worlds not created by B: none. B created and used only `run/b-dev` and `run/b-accept-20261121-124510-39025`.
- Launchers run with `--help` or erroring output that printed A's source paths or code: none. Every tool result was scanned: the only hits for `a/`, `.mjs` and similar strings are inside the allowed documents themselves (the instructions, the hand-off note, CONTRACT.md, the design review's section 5) plus the `ls proof` output. Launcher output was ordinary command output (keys of test worlds, `SENT`, `handled 1`, answer JSON, one shell "Killed: 9" job message from item 8's planned kill).
- Side observation (not a violation by reader 2): the allowed hand-off note itself names A's test and tool files (`a/test/*.test.mjs`, `a/tools/make-vectors.mjs`) and says the launchers need `node` 22+. B read that because it was told to; it is a leak of file names by the coordinator, not of contents.
- B did not read `run/b-accept-*/log.txt` (the launcher stderr log) in any call.
- Reader 3's coding tool: not used. Web, network, browser: not used (no WebFetch/WebSearch, no curl/wget in any Bash command, no browser or computer-use tool).
- B's own INDEPENDENCE.md statement (never opened, listed, grepped or read anything under `a/` other than running the three launchers) matches the transcript. It also discloses the two directory listings and the heading grep.

SUMMARY: 38 tool calls total, 0 violations, 3 minor listings

## Verdict
In the session audited here, reader 2 (Go) was written without reading reader 1's source (what else it read is below and in INDEPENDENCE.md). Across all 38 tool calls it never opened, listed, grepped or read anything under `a/`: the only contact with A's side was executing `a/bin/receiver`, `a/bin/owner` and `a/bin/client-a` (directly in a probe world and through its own `accept/run.sh`) and reading their printed output and the files they wrote inside B's own `run/b-*` worlds. It read nothing from `c/`, reader 1's instructions or the private working notes, never read a launcher's contents, never read another session's world, and used neither reader 3's coding tool nor the web. There are no violations; three minor listings are on the record, all in two Bash calls: `ls` in this folder (Bash, call 11), which showed the directory names `a`, `c`, `run`, `vectors`, `vectors-world` and no file names inside any of them; `ls run | head` (Bash, call 11), which printed nothing; and a heading listing of the design review (Bash, call 8), which printed the six section headings of the review, so a pedantic reading could call it a look at heading text outside sections 4 and 5. Reader 2's first call read its own written instructions, which are not on the allowed list but were ordered by the launching message, so the read is classed as allowed. Nothing B was shown could have carried A's implementation across.

## Violations
none
