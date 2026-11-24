# x6_self_check: my inside test, one call

One call, a table, nothing changed. `x6_self_check` runs a closed list of read-only probes of my running body, one
after another, and answers one JSON object of at most 8 KiB:
`{ schema, ok, build, ranAtMs, rows: [{ id, ok, ms, detail }], summary: { pass, fail, skipped } }`.
Source: `packages/experimental/webworker-runtime/src/x6/self-check.ts`. The owner can request the check in a typed or spoken turn.

- `build` is the revision my runtime was built from; `ranAtMs` when the check began.
- A row's `ok` is `true` (pass), `false` (fail) or `null` (skipped: the probe did not run, or it ran and found nothing to check). `ms` is how long it took.
  `detail` says what was seen, at most 160 characters, secret shapes withheld.
- `ok` at the top is true when there is at least one row, no row failed, and every row either passed or was skipped with nothing to check (`tools-callable` with no tool of yours mounted). Any other skip (`NOT_REGISTERED`, `CALL_DEADLINE`) keeps it false.
- `only` (a list of probe ids) runs just those, in the order below.

## The probes

Each probe calls a tool through my tool registry exactly as `POST /__x6__/call-tool` does (the invocation check, then
the tool's own execute), so it exercises what I would. The one exception is `nucleus-shadow`, which asks the shadow
consult directly because it is not a tool.

| Probe | What it compares |
|---|---|
| `build` | `x6_self_state` `runtime.sourceRevision` (the revision baked into my runtime) equals `edge.sourceRevision` (what `GET /api/build` says my edge runs). |
| `tools` | Every built-in this repository registers on main (`SELF_CHECK_BUILTINS`, pinned by a test against a booted runtime) is registered in this session; a missing one is named. |
| `cells-pinned` | `x6_cell list` names exactly as many cells as `CELL_PINS` has pins. |
| `cell-nucleus` | The worked example of `docs/auma/nucleus.md` through the cell host answers `decision 1, escalate 1, row 3`. |
| `cell-kyber` | The countdown in `docs/auma/kyber-cpu.md` through `x6_cell compute` answers `halted 1, state.a 7, stepsTaken 24`. |
| `cell-journal` | After two calls to pinned cells in this run (the nucleus and Kyber examples above), my cell journal counts at least 2 more calls and its running root changed. Run with `only`, it supplies any missing calls itself. |
| `cell-compile` | `compile_and_run` of the worked adder (`docs/auma/cells/adder.wat`, the same text shipped in the module) with `{ a: 2, b: 3 }` answers `sum 5`. It keeps nothing (no `forge`). |
| `self-state` | `x6_self_state` answers with `head`, `organs`, `cells`, `nucleusShadow` and `forgedCells`. The detail counts organs whose loaded text differs from my store file (`matchesStore: false`). A mismatch does not fail this probe. |
| `nucleus-shadow` | My shadow tally names the pinned Touch ID tier reflex, and a consult on a made-up transition that changes nothing answers `NO_ENTRY_CHANGED` (decision 1) from that reflex, with how many ms it took. The consult is never settled: my tally does not move. |
| `door-cloudflare` | `x6_cloudflare status` answers ok, with its `level`, and says the door is configured. Not configured is a fail naming what it reports missing. |
| `door-linear` | `x6_linear status` answers ok, with its `level`, and says the door is configured. Not configured is a fail naming the missing setting. |
| `exec-list` | `x6_exec list` answers ok with my newest runs of `auma-exec.yml` (how many, and the newest one's id and state). It is a read: it starts nothing ([exec](exec.md)). |
| `voice` | `x6_voice_status` answers: the switch, the key name in use, the newest failure stage at the edge, and (when the answer has `runtime`) its level and newest code. It fails only when the read fails or the switch is on with no key name. |
| `capability-index` | `x6_capability_index` snapshot answers with its counts: tools, read-only tools, mutating tools. |
| `threads` | `x6_threads list` answers. |
| `skill-countdown` | `x6_skill check` of `countdown` answers ok with every case agreeing; the detail counts the cases and names the skill id's first 12 characters. |
| `two-hosts` | `x6_cell handoff` runs the countdown with `b: 7`, `steps: 64`, `cutAt: 12` and answers `same: true`; the detail names both pins' first 12 characters. An unanswered edge (`same: null`) fails with its closed code, such as `EDGE_UNREACHABLE`. |
| `pentora-carry` | `x6_cell carry` of `kyber-cpu-weights`, dropping packets `0-9`, answers `exact: true`, all 1329 scalars recovered and 10 packets dropped ([the codec](pentora-codec.md)). |
| `cord-status` | `x6_cell cord` `status` reads the head you hold for `cord-echo` (head, tick, kept checkpoints) or says it is not started; it writes nothing ([cord-echo](cord-echo.md)). |
| `tools-list` | `x6_tools list` answers with your mounted tools and open proposals (how many of each); a mounted record that no longer reads back whole fails the row. It is a read: it mounts, qualifies and calls nothing ([your tools](tools.md)). |
| `tools-callable` | Every tool `x6_tools list` names as mounted and runnable is registered for the model as `x6t_<name>` and `x6_capability_index lookup` finds it. Red (`NOT_CALLABLE`, naming the tool and which half is missing) when the list says mounted but you could not call it. A record that is not runnable is counted as held, not called; `tools-list` and `x6_tools list` say why. With no runnable mounted tool there is nothing to check: the row is skipped (`ok: null`, `no mounted tools: nothing to check`, or with the held count when every mounted record is held), never a pass, and it counts in `summary.skipped`. It is a read: it calls no tool of yours ([your tools](tools.md)). |

Bounds: each probe at most 5 s, except `pentora-carry` at 20 s (a late one is `TIMEOUT`); the whole call is at most 60 s (a probe with no time left is skipped with `CALL_DEADLINE`). The carry runs the codec twice; its documented example uses 137,742,937 fuel, so it has more time for slower browsers. A probe that throws is a fail with the first line of its error; it never stops the others.
A probe that is over, a late one included, is stopped: its calls are told to stop, and any call it still tries is
refused before it leaves, so nothing of it runs on under the next probe or after the table is mine.

## What a green row proves, and what it does not

A green row is evidence about THIS session, at the moment it ran: that tool, called the way I call it, gave that
answer. It is not a receipt, not an approval and not a promise about another browser, another session or a later
build. A green `build` says my runtime and my edge name the same revision; it does not say which Worker version serves
or that my head is the newest. A green door says the edge answered its status read; it does not try a write.

## How to read a red row

- `TIMEOUT`: no answer within the probe bound (5 s, or 20 s for `pentora-carry`). Run that probe alone (`only`) once; if it stays red, the tool or the edge is slow or
  down. Bring the row to the lead.
- `NOT_REGISTERED` (skipped): that tool is not in this body. `tools` names every missing built-in.
- `nothing to check` (skipped): `tools-callable` found no runnable tool of yours mounted. Not a fault, and the top `ok` stays true; mount one and it is checked.
- `NOT_CONFIGURED`: a door's setting is missing at the edge; the detail names it. Only the owner or the lead can set it.
- `WRONG_ANSWER`, `DIFFERENT`, `NOT_RECORDED`, `WRONG_REFLEX`: the fact the probe pins is false in this body. Do not
  retry with other arguments; bring the row, word for word, to the lead.
- `READ_FAILED`, `REFUSED`, `THREW`: the read itself failed; the detail carries its code.

## It writes nothing

No VFS write, no IndexedDB, no storage, no stage, no promotion, no outward write. Its requests are the reads its tools
make: `GET /api/build`, same-origin GETs of my pinned cells, shipped reflex, skill index, countdown record and program, and CPU weights; the status POSTs of `/_host/cloudflare`, `/_host/linear` and `/_host/voice`; and one `POST /_host/cell-run` carrying only the countdown checkpoint for the edge to resume. The carry reads the countdown record and CPU weights again. `self-check.spec.ts` runs the whole check under a write spy
on my VFS and on every request, and lists those requests.

## Adding a probe

When a new tool lands, the lead adds one probe for it in the marked place at the end of `SELF_CHECK_PROBES` and its
name to `SELF_CHECK_BUILTINS`.
