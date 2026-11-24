# x6_self_state: what I am running, said from inside

One read-only tool, no required arguments (`{ "organs": ["id", ...] }` narrows the organ list). One JSON object, at most
16 KiB, keys always in this order (`nucleusShadow`, then `cellCount`, `cells`, `cellJournal`, `forgedCells` and `skills`, sit
between `doors` and `unknown`). Source:
`packages/experimental/webworker-runtime/src/x6/self-state.ts`.

| Field | What it is |
|---|---|
| `runtime.sourceRevision` | The revision baked into the runtime bundle this session executes (`__X6_BUILD_IDENTITY__`). |
| `runtime.bootedAtMs` | When this runtime mounted. |
| `edge.sourceRevision` | What my edge says it runs: one same-origin `GET /api/build`, 4 s deadline. |
| `head` | `{ ballId, epoch, origin }` of the head my loader holds. `origin` is `host` (booted from, or since read from, my host) or `local` (made in this tab). |
| `organs[]` | Every head entry, sorted by id: `specifier`, `sha256Loaded`, `bytes`, `storeSha256`, `matchesStore`, `state` (`running`, `disabled`, `support-module`, `not-running`). |
| `staged[]` | Modules put (`ball_put`, or an edited store file seen at boot) but not active; sorted by sha256, at most 64. |
| `tools[]` | The tool names registered in this session, sorted. |
| `doors.cloudflare` | `{ level, configured }` from the last `x6_cloudflare status` this session read; never a secret. |
| `nucleusShadow` | `{ reflex, consulted, agree, mismatch, unknown, lastMismatches }`: this session's shadow consult of my nucleus before each promotion or commit leaves for the edge, tallied against the edge's own classification. It decides nothing. How to read it: `docs/auma/nucleus.md`, "The shadow consult". `null` (with an `unknown` row `nucleusShadow: read-failed`) if the tally could not be read. |
| `cellCount` | How many pinned Wasm cells my body has (never cut). |
| `cells[]` | One row per pinned cell, sorted by name: `{ cell, sha256, bytes, fuel, ops, loaded }`. `sha256` and `bytes` are its pin, `fuel` the grant each call gets, `ops` what it does. `loaded` is what THIS session's cell host saw: `verified` only when it fetched the bytes and they hashed to the pin before compiling (and passed zero imports, the memory cap and the export check); `failed`, with `failure` one of `pin-mismatch`, `imports-present`, `memory-over-cap`, `fetch-failed`, `admission-failed`; `not-loaded` when nothing asked for it this session. More: `docs/auma/cells.md`. `null` (rows `cellCount` and `cells: read-failed`) if the host could not be read. |
| `cellJournal` | `{ calls, rootSha256 }` of this session's cell-call journal (`x6_cell {"action":"journal"}` reads the lines). The root is a session fact, not a receipt (`docs/auma/cells.md`). `null` (row `cellJournal: read-failed`) if it could not be read. |
| `forgedCells` | `{ count, cells: [{ name, sha256, bytes }] }`: the cells I forged and keep in my home (`x6_cell` `forge`), newest first. `count` is how many I keep (never cut); `x6_cell {"action":"forged"}` lists them whole. They are mine, unpinned, outside my head and my record (`docs/auma/cells.md`, "Cells you forge"). `null` (row `forgedCells: read-failed`) if my store could not be read. |
| `skills` | `{ count, kept: [{ name, id }] }`: the skills I keep in my home (`x6_skill` `keep`), newest first. `count` is how many (never cut); `x6_skill {"action":"list"}` lists and checks them. Descriptions I can check again, not authority, not in my record (`docs/auma/skills.md`). `null` (row `skills: read-failed`) if my store could not be read. |
| `unknown[]` | One `{ field, reason }` row for every null above, and one for every list cut to fit. Reasons: `not-recorded`, `unreachable`, `not-registered`, `too-many`, `read-failed` (also `nucleusShadow: read-failed`). To stay within 16 KiB the oldest `nucleusShadow.lastMismatches` are cut first (row `nucleusShadow.lastMismatches: too-many`; the counts are never cut), then cell rows, the last names first (row `cells: too-many`; `cellCount` and `cellJournal` are never cut, and `x6_cell list` names every cell), then forged-cell rows, the oldest first (row `forgedCells.cells: too-many`; `forgedCells.count` is never cut, and `x6_cell forged` lists every kept cell), then kept-skill rows, the oldest first (row `skills.kept: too-many`; `skills.count` is never cut), then organs, then staged, then tools. |

Cell rows may be cut under the 16 KiB limit, including rows for failed loads. `x6_cell {"action":"list"}` is the uncut read of every cell's `loaded` state and its `failure` reason when failed, from the same host facts.

**What "loaded" means.** `sha256Loaded` is the SHA-256 of the exact text my loader evaluated for that organ in this
session. It is recorded at evaluation (ball-loader.ts `evaluateCandidate`), from the bytes read in the same synchronous
step as the loader's own read; for a `ball:` specifier they must also hash to its name, as the loader itself checks. It
is never recomputed later from a file. `storeSha256` is the SHA-256 of `/dsh/home/auma/seed/organs/<id>.js` as it is on
disk now (the file I edit); `matchesStore` compares the two.

**What it cannot tell.** Code evaluated outside the organ loader (the runtime bundle itself, the page, preset plugins,
modules an organ requires in turn) has no `sha256Loaded`. Anything at the edge beyond its stamped revision (which Worker
version serves, what the head store holds) is not here: `x6_host_facts` and `x6_repo promotion_status` read those. A
door status is only as fresh as my last `x6_cloudflare status`.

**It writes nothing.** No VFS write, no IndexedDB, no storage, no request but the one GET; it mounts and runs nothing.
Voice may call it.

## Three questions it answers
- "Are you running build X?" Compare `runtime.sourceRevision` (and `edge.sourceRevision`) with X.
- "Which bytes is organ Y?" `organs[Y].sha256Loaded` and `bytes`.
- "Which of my cells did this session check, and did any fail?" `cells[].loaded`, and `failure` on a failed row.
- "Does my running organ match what is in the store?" `organs[Y].matchesStore`; if false, the organ I am running is not the text in my store. Look for that text's sha256 in `staged[]` to see whether it has been put; if it is not there, nothing has been put or proposed yet.
