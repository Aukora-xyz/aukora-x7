/** ONE wake evidence allowlist, read by MIRROR's checkpoint append (and HEAD's wake,
 * REQUEST to AURA). Each repo tool's evidence is appended through MirrorDO's own route. Synthetic storage only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CLOUD_WAKE_PATHS } from '../head-do.mjs'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'
import { CLOUD_WAKE_EVIDENCE_TOOLS } from '../wake-evidence.mjs'
import { CLOUD_WAKE_REPO_TOOL_NAMES } from '../cloud-wake-tools.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const PREFIX = 'mirror:v2:', FENCE = PREFIX + 'global-fence'

function fixtureStorage(initial = []) {
  let rows = new Map(initial), tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list'].map(key => [key, (...args) => view(rows)[key](...args)]))
  storage.transaction = operation => {
    const next = tail.then(async () => { const copy = structuredClone(rows); const result = await operation(view(copy)); rows = copy; return result })
    tail = next.catch(() => {})
    return next
  }
  return { storage }
}

async function mirror() {
  const f = fixtureStorage([['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1,
    ballId: BALL, epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }], [FENCE, { lineageId: LINEAGE, revision: 1 }]])
  const path = CLOUD_WAKE_PATHS[0], key = await mirrorDigest(path), bytes = new TextEncoder().encode('Continuity epoch 2')
  await f.storage.put(PREFIX + 'entry:' + key, { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: bytes.length, chunks: 1 })
  await f.storage.put(PREFIX + 'chunk:' + key + ':0', btoa(String.fromCharCode(...bytes)))
  return new MirrorDO({ storage: f.storage }, {})
}
const append = (mirrorDo, input) => mirrorDo.fetch(new Request('https://internal.invalid/_mirror/wake-checkpoint', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(input) }))
const checkpoint = (tool, n) => ({ id: n.toString(16).padStart(64, '0'), at: 1000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool, digest: 'd'.repeat(64) }] })

test('the list is exactly the wake tools that can succeed, never the checkpoint itself', () => {
  assert.deepEqual([...CLOUD_WAKE_EVIDENCE_TOOLS].sort(), ['inspectHeadWish', 'readMirrorText', ...CLOUD_WAKE_REPO_TOOL_NAMES].sort())
  assert.equal(CLOUD_WAKE_EVIDENCE_TOOLS.includes('appendWakeCheckpoint'), false)
})

test('each wake tool, the three repo tools included, is accepted as evidence through MirrorDO', async () => {
  const mirrorDo = await mirror()
  let n = 1
  for (const tool of CLOUD_WAKE_EVIDENCE_TOOLS) {
    const response = await append(mirrorDo, checkpoint(tool, n++))
    assert.equal(response.status, 200, tool)
    assert.equal((await response.json()).ok, true, tool)
  }
})

test('a name outside the list is still refused', async () => {
  const mirrorDo = await mirror()
  for (const tool of ['exec', 'appendWakeCheckpoint', 'readrepofile']) {
    const response = await append(mirrorDo, checkpoint(tool, 99))
    assert.ok(response.status >= 400, tool)
  }
})
