/** Patch-derived fixture provenance must reconstruct, not merely trust a new digest. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPinnedPatch, verifyPinnedProvenance } from './fixtures/organs/pinned.mjs'
const base = 'a\nb\nc\n'
const patch = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
test('Pearl fixture exact patch reconstruction', () => assert.equal(applyPinnedPatch(base, patch), 'a\nB\nc\n'))
test('Pearl fixture rejects changed base context', () => assert.throws(() => applyPinnedPatch('a\nx\nc\n', patch), /PATCH_CONTEXT/))
test('Pearl fixture rejects hunk count tampering', () => assert.throws(() => applyPinnedPatch(base, patch.replace('-1,3', '-1,2')), /PATCH_COUNTS/))
test('Pearl fixture rejects output-offset tampering', () => assert.throws(() => applyPinnedPatch(base, patch.replace('+1,3', '+2,3')), /PATCH_OUTPUT_OFFSET/))
test('Pearl fixture rejects an empty patch', () => assert.throws(() => applyPinnedPatch(base, ''), /PATCH_EMPTY/))
test('Pearl and unchanged fixture provenance match Git when history exists', () => {
  const result = verifyPinnedProvenance()
  if (result.checked) assert.deepEqual(result.mismatches, [])
})
