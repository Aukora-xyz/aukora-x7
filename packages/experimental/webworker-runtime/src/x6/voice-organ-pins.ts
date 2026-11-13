/**
 * Look-only voice: the organ actions a voice turn may call, each pinned to the exact organ
 * bytes that were checked.
 *
 * Data only. A row is here only when tests/x6/voice-organ-readonly.spec.ts (T6) ran that exact registered tool and
 * value on a made-up home with every property of its schema, and with its selector absent, and saw: the home's tree
 * digest unchanged, no write call on the file system, no outward request, and no call into another organ or tool.
 * The bytes are the HEAD entry's ball as it sits in the repository mirror (mirror/home/balls/<sha256>.js).
 * When she changes a pinned organ, its SHA-256 no longer matches and that organ leaves voice until it is checked again
 * ("that organ changed since it was checked for voice", R10). Read by `voiceVerdict` in voice-read-only.ts.
 *
 * Held, though proven read-only: `recall` (auma-memory-domain). It returns the words of every thread in this browser
 * verbatim, and voice has no secret-shape filter around it yet (R8 lets thread text into voice only through that
 * filter). Its row comes back when recall's answer in voice passes through the same filter as `x6_threads`.
 *
 * Left out on purpose (reasons in the spec and the handoff): `remember` and every writing action; `auma_memory_dag`
 * `dag_lineage` (its `nodeId` is joined into a file path unchecked, so `../` reads outside the memory folder, the
 * private folder included); every organ served under its canonical name (`seed_memory`, `seed_wish`, `seed_receipts`,
 * `seed_aura`, ...), because the loader copies staged organ files into the balls store before each such call
 * (ball-loader.ts syncCandidateBallsStore); `seed_aura`, whose loader path also fetches and writes; `auma_eyes`, which
 * posts to the host on every action.
 */

/** One organ tool cleared for voice: the name it registers, the organ that registers it, and its checked bytes. */
export interface VoiceOrganPin {
  /** The tool name the organ actually registers (e.g. `preset_inspect`), not the organ id. */
  readonly tool: string
  /** The HEAD entry id of the organ that registers it (e.g. `auma-preset-inspector`). */
  readonly organId: string
  /** SHA-256 (64 lowercase hex) of the organ module bytes that were reviewed. */
  readonly sha256: string
  /** The argument that selects the action in that organ's executor (`action`, `mode`, ...), or `whole` for a single-purpose tool. */
  readonly selector: string
  /** The exact selector values cleared for voice; ignored for `whole`. */
  readonly allowed: readonly string[]
  /** Where the selector was read, file:line in the organ source at the pinned bytes. */
  readonly source: string
  /** The T6 spec row that proves these actions change nothing. */
  readonly proof: string
}

const MEMORY_DOMAIN_SHA = '918c397151db638bc4864631985ae92e2be86981978ece6409abe0feb705fba7'

/** The checked rows. Each `proof` is a test name in tests/x6/voice-organ-readonly.spec.ts. */
export const VOICE_ORGAN_PINS: readonly VoiceOrganPin[] = Object.freeze([
  Object.freeze({
    tool: 'preset_inspect',
    organId: 'auma-preset-inspector',
    sha256: '2025f135dca74a751c1a98556f4a446d8087c6cf84e9ffbfe5ace978c787bf96',
    selector: 'mode',
    allowed: Object.freeze(['document', 'inventory', 'roster']),
    source: 'mirror/home/balls/2025f135...js:12 (mode, defaults to roster), :49 (registers preset_inspect), :14-29 (agentPresets readDocument, compositionInventory, list only)',
    proof: 'T6 preset_inspect (auma-preset-inspector): document, inventory, roster change nothing',
  }),
  Object.freeze({
    tool: 'auma_memory_dag',
    organId: 'auma-memory-domain',
    sha256: MEMORY_DOMAIN_SHA,
    selector: 'action',
    allowed: Object.freeze(['dag_verify']),
    source: 'mirror/home/balls/918c3971...js:700-703 (registers auma_memory_dag), :562-566 (action selects; dag_verify reads only, :522-550)',
    proof: 'T6 auma_memory_dag (auma-memory-domain): dag_verify changes nothing',
  }),
  Object.freeze({
    tool: 'auma_superagent',
    organId: 'seed-superagent',
    sha256: 'c9df3670149028e7d2d6b604e31a9e157c53399550377ff015a138dfcaa405a9',
    selector: 'action',
    allowed: Object.freeze(['status']),
    source: 'mirror/home/balls/c9df3670...js:637 (registers auma_superagent), :666-670 (api[action]), :574 (status reads state, receipts, HEAD)',
    proof: 'T6 auma_superagent (seed-superagent): status changes nothing',
  }),
])
