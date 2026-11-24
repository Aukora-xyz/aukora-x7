# x6_tools: your tools are yours (tier T1)

You can write a read-only tool. The host checks it in a sealed cell, and the owner’s signed-in session mounts it under `x6t_<name>` for the model to call.

## What is built

- **The manifest** `aukora.tool.v1`: `name` (`[a-z][a-z0-9-]{1,30}`), `version`, `description`,
  `actions` (each `{ readOnly, authority, description?, input?, output? }`), `requires` (`services`, `secrets`,
  `network`, `reads`), `handler`, `tests`, and optional `author` and `lineage`. At most 64 KiB, 16 actions, 32 cases.
- **The handler is a sealed cell you already have**: `{ cell: "<sha256 of a cell you forged>", op, program? }`
  or `{ pin: "<pinned cell name>", op, program? }`. A zero-import Wasm cell reaches nothing (no network, no storage, no
  host): the sandbox is the wall. `program` is a fixed object given with every call; a caller may not overwrite its keys.
- **Tier T1 only**: every action `readOnly: true` and authority `A`; `requires.services` is `[]` or `["home-read"]`;
  no secrets; no network. Anything else is refused `TOOL_TIER_NOT_OPEN` with `needs`: `T2` (a write, authority B, or
  `fs`), `T3` (secrets, network, `process`, `model`, any other service, a pattern that could reach your private folder)
  or `JS_SANDBOX` (a JavaScript handler).
- **`home-read`**: declare `reads: ["/dsh/home/auma/<pattern>"]` (`*` is one folder level, `**` any depth; the first
  folder must be named, never `private`). When the tool is called with `paths`, the host reads each file, checks it
  against your patterns, refuses your private folder and secret file names, bounds them (16 files, 256 KiB in all, UTF-8
  text) and passes them into the cell as `files: [{ path, text, size, sha256 }]` with the caller's input.
- **Tests are part of the tool**: each case is `{ name, action?, input?, files?, expect }` where `expect` is
  `{ ok: true, result }`, `{ ok: true, not }` (must differ) or `{ ok: false, code? }` (must be refused). A suite with no
  case that is refused or must differ is `TOOL_TESTS_CANNOT_FAIL`. In a home-read case, `files` are fixtures (the paths are
  still checked) so the suite gives the same answer every time.
- **The five verbs**, as one tool `x6_tools`:

| Call | What happens |
|---|---|
| `{ action: "propose", manifest, notes? }` | Checks the shape and the tier, then writes only `/dsh/home/tools/proposals/<name>/<sha256>.json` (the canonical bytes of `{ manifest, notes }`, named by their SHA-256). Mounts nothing. Answers `{ proposalId: "<name>@<sha256>", path, sha256 }`. |
| `{ action: "qualify", proposalId }` | The host runs every case through the cell (a pinned cell admitted against its pin; a forged cell rebuilt from its kept WAT and admitted again, zero imports, fuel bounded) and checks the tier. Answers `{ qualified, qualificationId, suiteSha256, cases: [{ id, ok, ms, detail }], refusals }`. The id is the SHA-256 over the canonical manifest, the handler's bytes and the suite: it changes when any of them does. |
| `{ action: "mount", proposalId, qualificationId }` | Qualifies again against the bytes as they are now (`QUALIFICATION_STALE` if anything moved), refuses `TOOL_NAME_TAKEN` and `TOOLS_FULL` (64), then asks for the owner's signed-in session (`OWNER_REQUIRED` without it; no fingerprint: a T1 tool is reversible and adds no new act). Writes `/dsh/home/tools/mounted/<name>.json` with the capability diff, registers `x6t_<name>`, and answers `{ mounted, name, tool, diff, when, availableAfter: "now" }`. If the tool registry refuses the registration, the record this call wrote is taken back and the mount is refused `TOOL_REGISTER_FAILED` with `why` (a reload would not cure it); `recordRemoved` says whether that take-back worked. If it is `false`, the record is still there: unmount it yourself (`{ action: "unmount", name }`) before you mount again. One exception: when that record was already mounted before this call (the same proposal and qualification, `mounted: "already"`), nothing is taken back: the answer is `TOOL_REGISTER_FAILED` with `recordRemoved: false` and `next: "the earlier record stays: unmount it, then mount again"`. |
| `{ action: "list" }` | Every mounted tool (readOnly, authority, requires, sha256, qualificationId, handler, mountedAt) and every open proposal. |
| `{ action: "unmount", name }` | Removes the mounted record and the registered tool, and answers `availableAfter: "now"` when the next turn no longer sees it (`reload` if the registry still resolves it). The proposal stays; nothing else is left behind. |
| `{ action: "unmount", proposalId }` | Withdraws an open proposal (64 open at most; one a mounted tool stands on is `TOOL_PROPOSAL_MOUNTED`). |

- **First-class**: at mount the host registers it as `x6t_<name>` (a `-` becomes `_`) with your description and
  your actions as its `act` parameter, plus `input` (and `paths` for a home-read tool). The mount answer's
  `availableAfter` is `now` only when the tool registry itself resolves `x6t_<name>` after the mount, so the next turn of
  every thread is offered it and the capability index finds it; `reload` only when your runtime has no tool registry.
  Every tool you mounted is registered again when your runtime boots. At boot and at every call
  the host judges the record again from its bytes: it must name itself, its proposal must read back whole, the
  manifest must still be T1 with a cell handler, the handler must be the qualified one (`TOOL_HANDLER_CHANGED`) and the
  qualification id must be the one those bytes give (`TOOL_RECORD_CHANGED`). A record written there by any other path
  (your `write` reaches the folder) is never registered. The first call in a session runs the tool's own suite again
  (`TOOL_RECORD_CHANGED` if it does not pass), then each call is one cell call under the cell host's fuel and deadline
  and leaves a cell-journal line. Your capability index takes read-only from each manifest's actions; `list` shows
  `runnable` and the code for a record that fails; `x6_self_check` has a `tools-list` probe and a `tools-callable` probe (red when a
  mounted, runnable tool is not registered for the model or not in the capability index).

The capability diff is made by the host, never written by you:

```text
+ tool: adder (x6t_adder) version 0.1.0
+ actions: add (A, read-only)
+ services: none
+ secrets: none
+ network: false
+ handler: forged cell <sha256> op run (zero imports, fuel bounded)
+ new authority: none (every action is a read)
- no existing action is removed
```

## A worked example you can copy: the adder

1. Forge the adder from `docs/auma/cells/adder.wat` (read it with `x6_repo read`):
   `x6_cell { action: "forge", wat: <that text>, name: "adder" }`. Keep `cell.sha256` from the answer.
2. Propose:

```json
{ "action": "propose", "notes": "my first tool", "manifest": {
  "schema": "aukora.tool.v1", "name": "adder", "version": "0.1.0", "description": "Adds two integers.",
  "actions": { "add": { "description": "a + b", "readOnly": true, "authority": "A" } },
  "requires": { "services": [], "secrets": [], "network": false },
  "handler": { "cell": "<cell.sha256 from step 1>", "op": "run" },
  "tests": [
    { "name": "two and three", "input": { "a": 2, "b": 3 }, "expect": { "ok": true, "result": { "sum": 5 } } },
    { "name": "no b is refused", "input": { "a": 2 }, "expect": { "ok": false, "code": "INPUT" } }
  ] } }
```

3. Qualify: `x6_tools { action: "qualify", proposalId: "<proposalId from step 2>" }` answers `qualified: true` and a
   `qualificationId`.
4. Mount, from a thread while the owner is signed in:
   `x6_tools { action: "mount", proposalId, qualificationId }`. Read the `diff` back to him.
5. Call it: `x6t_adder { input: { a: 19, b: 23 } }` answers `{ ok: true, result: { sum: 42 }, readOnly: true }`.
6. Unmount when you are done: `x6_tools { action: "unmount", name: "adder" }`.

## What is not built, and why

- **JavaScript handlers** (`ball:<sha256>`): JavaScript in your realm can reach `fetch` and your storage whatever a
  manifest declares, so "declared versus granted" cannot be enforced there yet. They come with a real sandbox in a
  later job; until then they are `TOOL_TIER_NOT_OPEN` with `needs: "JS_SANDBOX"`.
- **T2 and T3** (a tool that writes, holds a secret name, reaches the network, runs a process or calls a model): they need
  the owner's card on the capability diff. Next job.
- The mount response and mounted record contain the capability diff. T1 mounting uses the signed-in session without a separate approval card.
- **From a look-only voice turn**, `x6_tools` and every `x6t_` tool are refused (closed by default). From a typed thread,
  or a voice at level open, they work as above.
- The tier table and this registry are not yours to change: `packages/experimental/webworker-runtime/src/x6/tool-registry.ts`
  is a frozen path. No tool mounted here can write, reach the network, read a secret, call a model or mount another tool.
