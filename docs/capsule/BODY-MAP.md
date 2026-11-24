# The capsule and the nested-cell body: what is real, what is designed, what is not there yet

SOURCE identifies source files. DESIGNED marks proposed behavior. SPECULATIVE marks open ideas.

## A. What the capsule is, and what it is not

**The capsule is her passport and her outer fence.** It is one small canonical record that says exactly what she is made of (every organ, module and file by digest, her three heads, her receipt roots, what was left out and why), plus one rule at the destination that an action happens once, even if she is moved, copied or restored. Two programs written without sight of each other read the record identically, byte for byte. Her mind travels as bytes; the credential that lets a body act never travels; a new body earns its own authority from the owner's passkey.

**It is not** her weights, not a container of her code, not a model, not a grant of any authority (a record gates nothing), and not one big Wasm file. It describes the blankets. It does not replace them and it does not melt them.

## B. How it maps to the nested-Wasm Markov-blanket architecture

| The architecture | Runtime components | Where the capsule sits |
|---|---|---|
| External states (host, world, the owner) | the browser host, the edge Worker, Cloudflare, GitHub, Linear, model providers | never inside a record |
| Outer blanket (complete mediation and the owner's key) | AUMLOK passkeys and Class 3 cards at the edge (`deploy/cloudflare/src/aumlok.mjs`, `cloud-brokers.mjs`) | The proposed act door requires the holder’s key, the generation, a valid lease, the gate’s ALLOW and, for protected actions, the owner’s passkey. |
| Active states (typed proposals out) | staged outward requests (`aukora.staged-outward-class3.v1`), proposal branches, promotions | DESIGNED: the act command `aukora.act.v1`, a closed typed object whose id is the digest of its bytes |
| Sensory states (evidence in) | The receipts organ and its receipt chain | The record carries only the receipt root (`roots.receipts`). A root alone does not establish that the underlying observations are true. |
| Internal states (cortex and private memory) | the cortex is a remote model behind her model doors; her organs are JavaScript modules that share one realm with no wall between them (SOURCE `src/module-system/module-loader.ts`, `src/x6/ball-loader.ts`) | the record lists organs and modules by digest; it holds no weights and no memory contents |
| Inner organelles (hard-walled cells) | **30 pinned cells (24 Rust-to-Wasm, 6 hand-written integer WAT), zero imports, checked against a SHA-256 pin before compiling, metered fuel, a separate worker, a 5 s deadline**: SOURCE `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts:1-22` and the pin table at `:45`; shipped at `apps/web/public/cells/` (among them `gate-judge`, `aukora-kernel`, `aumlok-keys`, `kira-core`, `laya`, `skillsmith`, `nucleus`, `kyber-cpu`, `cord-echo`, `menger-hive`) | NOT in the record yet: the inventory has no kind for a cell |
| The deterministic nucleus (a CPU the cortex consults before it proposes) | the pinned `nucleus` cell (`docs/auma/nucleus.md`; SOURCE `wasm-cells.ts` CELL_PINS) with the Touch ID tier reflex as data (`apps/web/public/cells/reflexes/touch-id-tier.json`, a shadow of `classifyTransition`); her runtime consults it IN SHADOW before every promotion or head commit leaves for the edge and tallies it against the edge (`x6_self_state` `nucleusShadow`; SOURCE `src/x6/nucleus-shadow.ts`). No cell or code named WxCPU or Qwenputer is in this repository (RAN: search finds only prose that says so); the small four-bit weight CPU in the pinned cell `kyber-cpu` is a different machine (`docs/auma/kyber-cpu.md`). | not designed yet: its answer as part of the proposal, judged at the edge, is what is missing (item D5) |
| Self-forged sub-organs | `x6_cell compile_and_run` compiles WAT through the pinned `skillsmith` cell, admits zero-import modules of at most 16 memory pages and runs them on bounded fuel. `forge` keeps the admitted bytes by SHA-256. After a reload, `run_forged` rebuilds the kept WAT with the pinned compiler and runs the fresh bytes only if their hash matches. | A kept cell is unpinned and outside both the head and the capsule record. |
| The gate and the court (no model in the gate) | DESIGNED as a pure JavaScript function with a static import scan | pushing the limit: the same gate as a zero-import cell, the same pinned bytes at the edge and in the body, where the wall is the sandbox and not a scan |

## C. Real, designed, speculative

**In source.** A skill (`x6_skill`, `aukora.skill.v1`) names a pinned or forged cell, a program and evidence computed by the cell. The host keeps the skill and can rerun its cases. A skill confers no authority and sits outside the capsule record. JavaScript and Python implementations cover the canonical form `aukora.canon.v1`, record verification and act-door data types. Other components include the Wasm cell host, AUMLOK, the Cloudflare and Linear doors, the managed voice bridge, `x6_self_state` and the pinned `nucleus` and `kyber-cpu` cells. The runtime consults the nucleus in shadow before promotions.
**Designed and modelled, not built:** the act door, the key chain, the fence, the gate and its court, the record builder and its window, the body's client, the two-body test.
**Speculative:** a CPU compiled into a real model's own weights (the small four-bit weight CPU in the pinned cell `kyber-cpu` exists, as an instrument); any cortex of her own inside the capsule; one outer Wasm that contains the whole organism; every statement about physics.

Zero imports rule out direct imported calls. They do not establish non-interference through outputs, timing, traps or surrounding host code.

## D. How far the capsule is from "one portable capsule with a CPU nucleus and self-forged sub-organs"

1. **Cells are invisible to the capsule.** The pin table lives in code (`wasm-cells.ts`), not in her portable description. In the runtime, `x6_self_state` `cells` has one row per pinned cell (sha256, bytes, fuel, ops) and whether this session's host verified it against its pin, failed it (with a closed reason) or has not loaded it (`docs/auma/cells.md`). The capsule inventory has no `wasm-cell` record.
2. **A forged cell survives, but only in her home.** The runtime keeps up to 32 forged cells by content address in her home. After a reload it recompiles the stored WAT and checks the digest before running the cell. `x6_self_state` lists these cells under `forgedCells`. These cells stay outside the pinned head and capsule record.
3. **No receipt at the cell boundary.** Every call to a pinned cell leaves a journal line at the host (cell, op, pin, request and answer digests, status, fuel, time, caller) and a running root she can read (`x6_cell {"action":"journal"}`, `x6_self_state` `cellJournal`). The journal lasts for the session and stays outside the signed receipt chain. The capsule has no cell-call journal root.
4. **Capsule gate.** The gate described in the design has no implementation in the export at the proposed module path and no pinned cell for the act transaction.
5. **A nucleus in shadow only.** The runtime consults the pinned `nucleus` cell (`docs/auma/nucleus.md`) in shadow before staging a head or organ promotion for the edge (`stage_organ_promotion`, `stage_organ_set_promotion`, `x6_repo promote_staged` and `head_rollback`) and before every head her own edit commits to the edge (`tree_patch`, `tree_undo`, snapshot restore; SOURCE `packages/experimental/webworker-runtime/src/x6/nucleus-shadow.ts`, `ball-loader.ts`): the Touch ID tier reflex's answer is shown to her beside her result and tallied against the edge's classification (`x6_self_state` `nucleusShadow`). It is NOT part of the proposal's bytes, NOT run at the edge and NOT authority: the edge's `classifyTransition` alone decides, and a test pins that every request byte is the same whatever the consult answers. The runtime skips the consult for a first head with no parent.
6. **Her organs have no walls between them.** They are JavaScript in one realm.
7. **One file.** The record describes; it does not contain. A single export (the record plus every byte it names, verifiable against it) is a pack format, not designed yet. It is not one Wasm binary and should not be: the walls between cells are the point.

## E. Pentora

In, hold and out are conversation phases shown in Auma Live and in the core of each Aura Coherence cell (`docs/foundations/PENTORA-LIVE-FLOW.md`). The ring shows health. In the proposed capsule view, a match between loaded and stored organ bytes is verified, a mismatch is failed and an unread value is undetermined. The figure displays the available evidence and confers no authority.
