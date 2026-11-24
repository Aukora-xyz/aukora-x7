/**
 * Reader and paint checks for the Spatial SuperAgent readout.
 * The fixtures are the existing `/__x6__/call-tool` bodies, not a live worker.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  applyEvidence, BALL_HEAD_PATH, CHECKPOINTS_PATH, DAG_HEAD_PATH, extractPromoteEdge, parseDagHead,
  RECEIPTS_LOG_PATH, STALE_HEARTBEAT_MS,
} from './authority.ts'
import { OWNER_GRANT_DOMAIN, OWNER_GRANT_SCHEMA, ownerGrantCanonical } from './owner-grant.ts'
import {
  canonicalJson, classifyToolBody, parseReceipt, parseStatus, scopeLimitSound, STATUS_SCHEMA,
} from './contract.ts'
import { assessPredictions, discoveryJsonl, projectDiscoveryCorpus } from './prediction.ts'
import { phrase } from './phrases.ts'
import { paintLines } from './present.ts'
import { createSuperagentRead, EVIDENCE_READ_LIMITS, type SuperagentReadOptions } from './read.ts'
import type { EvidenceFile } from './authority.ts'
import { sha256Hex } from './lineage.ts'
import { mountSuperagentRooms, type ReadoutNode } from './view.ts'

async function receiptLine(payload: Record<string, unknown>): Promise<{ line: string; leaf: string }> {
  const encoded = new TextEncoder().encode(canonicalJson(payload))
  const bytes = new Uint8Array(encoded.length + 1)
  bytes[0] = 0
  bytes.set(encoded, 1)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const leaf = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { leaf, line: JSON.stringify({ ...payload, leafHash: leaf }) }
}

const NOW = Date.parse('2026-11-08T00:00:00.000Z')
const ROOT = 'a'.repeat(64)
const CHECKPOINT = 'b'.repeat(64)

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: STATUS_SCHEMA,
    observedAt: '2026-11-08T00:00:00.000Z',
    survivedRestart: true,
    mandates: [{
      id: 'mandate-1',
      strength: 'explicit',
      policyVersion: 'policy-7',
      scope: 'organs/seed-receipts.js <not-html>',
      expiry: '2026-11-09T00:00:00.000Z',
    }],
    tickets: [{ id: 'ticket-1', title: '<img src=x onerror=alert(1)>', state: 'open', mandateId: 'mandate-1' }],
    assignments: [{
      id: 'assignment-1',
      ticketId: 'ticket-1',
      state: 'running',
      executor: 'browser-worker',
      survivedRestart: false,
      report: { state: 'blocked', summary: 'Need a decision' },
    }],
    attention: [{ id: 'attention-1', kind: 'question', text: 'Which room mounts this?' }],
    ...overrides,
  }
}

function toolOk(raw: unknown): { status: number; text: () => Promise<string> } {
  return { status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, tool: 'fixture', output: JSON.stringify(raw), raw })) }
}

function toolMissing(name: string): { status: number; text: () => Promise<string> } {
  return { status: 404, text: () => Promise.resolve(JSON.stringify({ ok: false, error: `Tool "${name}" is not registered` })) }
}

interface RecordedCall { name: string; args: { action?: string }; signal: AbortSignal }

function scriptedFetch(handler: (call: RecordedCall) => { status: number; text: () => Promise<string> } | 'hang') {
  const calls: RecordedCall[] = []
  const fetch = (
    input: string,
    init?: { method?: string; body?: string; signal?: AbortSignal },
  ) => new Promise<{ status: number; text: () => Promise<string> }>((resolve, reject) => {
    assert.equal(input, '/__x6__/call-tool')
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(init?.body ?? '{}') as { name: string; args: { action?: string } }
    const signal = init?.signal ?? new AbortController().signal
    const call = { name: body.name, args: body.args, signal }
    calls.push(call)
    const fail = (): void => { reject(new DOMException('The operation was aborted.', 'AbortError')) }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    const result = handler(call)
    if (result !== 'hang') resolve(result)
  })
  return { calls, fetch }
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('parses a status projection and keeps payload text intact', () => {
  const parsed = parseStatus(snapshot(), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.snapshot.tickets[0]?.title, '<img src=x onerror=alert(1)>')
  assert.equal(parsed.snapshot.mandates[0]?.scope, 'organs/seed-receipts.js <not-html>')
  assert.equal(parsed.snapshot.assignments[0]?.executor && 'token' in parsed.snapshot.assignments[0].executor
    ? parsed.snapshot.assignments[0].executor.token
    : '', 'browser-worker')
  assert.equal(parsed.snapshot.attention.some(item => item.source === 'assignment-report' && item.text === 'Need a decision'), true)
  const omitted = parseStatus({ ...snapshot(), tickets: undefined }, 'auma_superagent', NOW)
  assert.equal(omitted.ok, false)
  if (!omitted.ok) assert.equal(omitted.failure.kind, 'schema')
})

test('rejects an unverified receipt hash', () => {
  const failed = parseReceipt({ ok: false, action: 'verify', stage: 'receipt-chain', currentMerkleRoot: ROOT, latestCheckpointHash: CHECKPOINT })
  assert.equal(failed.kind, 'rejected')
  assert.equal('merkleRoot' in failed, false)
  const listed = parseReceipt({ ok: true, action: 'list', currentMerkleRoot: ROOT })
  assert.equal(listed.kind, 'unreadable')
  const verified = parseReceipt({ ok: true, action: 'verify', currentMerkleRoot: ROOT, latestCheckpointHash: null, receiptsVerified: 42, checkpointsVerified: 2 })
  assert.deepEqual(verified, { kind: 'verified', merkleRoot: ROOT, checkpointHash: null, receiptsVerified: 42, checkpointsVerified: 2 })
})

test('her organ refusing the status read is said with its code, not as a schema miss (Round 26)', () => {
  // The call-tool route wraps her refusal in a 200 {ok:true, output}; the organ's own {ok:false, error} is inside.
  const body = classifyToolBody(200, JSON.stringify({ ok: true, output: JSON.stringify({ ok: false, error: 'MANDATE_EXPIRY_INVALID', mandateId: 'm-1' }) }))
  assert.equal(body.kind, 'ok')
  if (body.kind !== 'ok') return
  const parsed = parseStatus(body.value, 'auma_superagent', NOW)
  assert.deepEqual(parsed, { ok: false, failure: { kind: 'refused', detail: 'MANDATE_EXPIRY_INVALID', truncated: false } })
  assert.deepEqual(paintLines({ kind: 'failure', failure: parsed.ok ? { kind: 'schema' } : parsed.failure, receipts: { kind: 'idle' }, refreshing: false }, 'world')
    .map(line => line.text).filter(text => text === 'MANDATE_EXPIRY_INVALID'), ['MANDATE_EXPIRY_INVALID'])
  // A payload that is neither her refusal nor the status schema is still a schema miss.
  const odd = parseStatus({ ok: false }, 'auma_superagent', NOW)
  assert.equal(odd.ok === false && odd.failure.kind, 'schema')
})

test('her receipts verifier names its checkpoint-policy code; anything else in error is not carried (Round 26)', () => {
  assert.deepEqual(parseReceipt({ ok: false, action: 'verify', stage: 'checkpoint-policy', failedCheckpointSeq: 15, error: 'CHECKPOINT_SIGNER_POLICY_MISMATCH' }),
    { kind: 'rejected', stage: 'checkpoint-policy', error: 'CHECKPOINT_SIGNER_POLICY_MISMATCH' })
  assert.deepEqual(parseReceipt({ ok: false, action: 'verify', stage: 'checkpoint-policy', error: '<b>not a code</b>' }),
    { kind: 'rejected', stage: 'checkpoint-policy', error: null })
})

test('classifies the existing control-route bodies', () => {
  assert.equal(classifyToolBody(404, JSON.stringify({ ok: false, error: 'Tool "auma_superagent" is not registered' })).kind, 'missing')
  assert.equal(classifyToolBody(404, JSON.stringify({ error: 'Unknown X6 control route: POST /__x6__/call-tool' })).kind, 'control-unavailable')
  assert.equal(classifyToolBody(200, JSON.stringify({ ok: true, raw: { schema: STATUS_SCHEMA } })).kind, 'ok')
})

test('missing superagent tools are not painted as empty work', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: ROOT, latestCheckpointHash: CHECKPOINT, receiptsVerified: 42, checkpointsVerified: 2 })
    : toolMissing(call.name))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'failure')
  if (phase.kind !== 'failure') return
  assert.equal(phase.failure.kind, 'backend-missing')
  assert.equal(phase.receipts.kind, 'verified')
  const lines = paintLines(phase, 'world').map(line => line.text)
  assert.equal(lines.includes(phrase('state.missing')), true)
  assert.equal(lines.includes(ROOT), true)
  assert.equal(lines.includes(phrase('empty.tickets')), false)
  assert.equal(lines.includes('approve'), false)
  read.stop()
})

test('a registered status paints tickets, mandates, executors, attention, and the verified hash', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: ROOT, latestCheckpointHash: CHECKPOINT })
    : toolOk(snapshot()))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'snapshot')
  const world = paintLines(read.current(), 'world').map(line => line.text)
  const self = paintLines(read.current(), 'self').map(line => line.text)
  for (const lines of [world, self]) {
    const text = lines.join('\n')
    assert.equal(text.includes('<img src=x onerror=alert(1)>'), true)
    assert.equal(text.includes('organs/seed-receipts.js <not-html>'), true)
    assert.equal(text.includes('browser-worker'), true)
    assert.equal(text.includes('Which room mounts this?'), true)
    assert.equal(text.includes(ROOT), true)
    assert.equal(text.includes(CHECKPOINT), true)
    assert.equal(text.includes(phrase('note.authority')), true)
    assert.equal(text.includes(phrase('integration.unverified')), true)
  }
  assert.equal(script.calls.some(call => call.name === 'auma.superagent'), false)
  assert.equal(script.calls.every(call => call.args.action === 'status' || call.args.action === 'verify'), true)
  read.stop()
})

test('an unrecognized status does not fall through to the other tool name', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolMissing('seed_receipts')
    : toolOk({ schema: 'other', observedAt: '2026-11-08T00:00:00.000Z' }))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'failure')
  if (phase.kind === 'failure') assert.equal(phase.failure.kind, 'schema')
  assert.equal(script.calls.some(call => call.name === 'auma.superagent'), false)
  const lines = paintLines(read.current(), 'self').map(line => line.text)
  assert.equal(lines.includes(phrase('state.schema')), true)
  assert.equal(lines.includes(phrase('receipt.missing')), true)
  assert.equal(lines.includes(ROOT), false)
  read.stop()
})

test('the dotted tool name is read only after the underscore name is unregistered', async () => {
  const script = scriptedFetch((call) => {
    if (call.name === 'seed_receipts') return toolMissing('seed_receipts')
    if (call.name === 'auma_superagent') return toolMissing(call.name)
    return toolOk(snapshot({ assignments: [], attention: [], tickets: [], mandates: [] }))
  })
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'snapshot')
  if (phase.kind === 'snapshot') {
    assert.equal(phase.empty, true)
    assert.equal(phase.snapshot.toolName, 'auma.superagent')
  }
  const names = script.calls.map(call => call.name)
  assert.ok(names.indexOf('auma_superagent') < names.indexOf('auma.superagent'))
  read.stop()
})

test('an old observation stays visible and is not called current', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolMissing('seed_receipts')
    : toolOk(snapshot({ observedAt: '2026-11-07T00:00:00.000Z' })))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'stale-snapshot')
  if (phase.kind === 'stale-snapshot') assert.equal(phase.aged, true)
  assert.equal(paintLines(phase, 'world').some(line => line.text === phrase('state.aged')), true)
  read.stop()
})

test('a failed refresh keeps the previous snapshot and does not invent a replacement', async () => {
  let statusReads = 0
  const script = scriptedFetch((call) => {
    if (call.name === 'seed_receipts') return toolMissing('seed_receipts')
    statusReads += 1
    return statusReads === 1 ? toolOk(snapshot()) : toolOk({ schema: 'other' })
  })
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  read.refresh()
  await settled()
  const phase = read.current()
  assert.equal(phase.kind, 'stale-snapshot')
  if (phase.kind !== 'stale-snapshot') return
  assert.equal(phase.failure?.kind, 'schema')
  assert.equal(phase.snapshot.tickets[0]?.title, '<img src=x onerror=alert(1)>')
  read.stop()
})

test('refresh cancels the previous wait and stop ends the reader', async () => {
  const script = scriptedFetch(() => 'hang')
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW, timeoutMs: 5_000 })
  await settled()
  const first = script.calls.map(call => call.signal)
  assert.equal(first.length, 2)
  read.refresh()
  await settled()
  assert.equal(first.every(signal => signal.aborted), true)
  const afterRefresh = script.calls.length
  assert.equal(afterRefresh, 4)
  read.stop()
  await settled()
  assert.equal(script.calls.length, afterRefresh)
  assert.equal(read.current().kind, 'stopped')
  read.refresh()
  await settled()
  assert.equal(script.calls.length, afterRefresh)
})

test('a settled read does not poll', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts' ? toolMissing('seed_receipts') : toolOk(snapshot()))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW })
  await settled()
  const count = script.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(script.calls.length, count)
  read.stop()
})

test('a future observation is not shown as work', () => {
  const parsed = parseStatus(snapshot({ observedAt: '2026-11-08T00:10:00.000Z' }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.equal(parsed.failure.kind, 'time')
})

test('mount shares one reader and paints payload with textContent only', async () => {
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: ROOT, latestCheckpointHash: null })
    : toolOk(snapshot()))
  const nodes: FakeNode[] = []
  const document = { createElement: (tag: string) => new FakeNode(tag, nodes) }
  const world = new FakeNode('div', nodes)
  const self = new FakeNode('div', nodes)
  const mounted = mountSuperagentRooms({ world, self, document, fetch: script.fetch, now: () => NOW })
  await settled()
  assert.equal(script.calls.filter(call => call.name === 'auma_superagent').length, 1)
  const texts = [...world.texts(), ...self.texts()]
  assert.equal(texts.includes('<img src=x onerror=alert(1)>'), true)
  assert.equal(texts.includes(phrase('action.refresh')), true)
  assert.equal(texts.some(text => text.toLowerCase().includes('approve')), false)
  const button = nodes.find(node => node.tag === 'button')
  assert.ok(button)
  const before = script.calls.length
  button.dispatch()
  await settled()
  assert.ok(script.calls.length > before)
  mounted.stop()
  assert.equal(world.children.length, 0)
  assert.equal(self.children.length, 0)
})

test('a copied hash, a tampered leaf, a broken link, or a mismatched grant stays self-attested', async () => {
  const first = await receiptLine({ schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64), data: { mandateId: 'mandate-1', scope: { paths: ['safe'] } } })
  const secondPayload = { schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'mandate.grant', prevHash: first.leaf, data: { mandateId: 'mandate-1', scope: { paths: ['safe'] } } }
  const second = await receiptLine(secondPayload)
  const log = `${first.line}\n${second.line}\n`
  const base = snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      receiptLeafHash: 'ab'.repeat(32), confirmed: true, confirmedBy: 'owner',
    }],
  })
  const parsed = parseStatus(base, 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const files = { checkpoints: { kind: 'missing' as const }, head: { kind: 'missing' as const }, dag: { kind: 'missing' as const } }
  const fabricated = await applyEvidence(parsed.snapshot, { ...files, receipts: { kind: 'ok', text: log } }, NOW)
  assert.equal(fabricated.mandates[0]?.authority.level, 'self-attested')
  assert.equal(fabricated.mandates[0]?.authority.reasons.includes('hash-not-in-chain'), true)

  const tampered = second.line.replace(second.leaf, 'cd'.repeat(32))
  const tamperedMandate = structuredClone(parsed.snapshot)
  const tamperedMandateRow = tamperedMandate.mandates[0]
  if (tamperedMandateRow === undefined) throw new Error('mandate missing')
  tamperedMandateRow.receiptLeafHash = 'cd'.repeat(32)
  const tamperedResult = await applyEvidence(tamperedMandate, { ...files, receipts: { kind: 'ok', text: `${first.line}\n${tampered}\n` } }, NOW)
  assert.equal(tamperedResult.mandates[0]?.authority.level, 'self-attested')
  assert.equal(tamperedResult.mandates[0]?.authority.reasons.includes('leaf-recompute-mismatch'), true)

  const brokenReceipt = await receiptLine({ schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'mandate.grant', prevHash: '11'.repeat(32), data: { mandateId: 'mandate-1', scope: { paths: ['safe'] } } })
  const brokenMandate = structuredClone(parsed.snapshot)
  const brokenMandateRow = brokenMandate.mandates[0]
  if (brokenMandateRow === undefined) throw new Error('mandate missing')
  brokenMandateRow.receiptLeafHash = brokenReceipt.leaf
  const brokenResult = await applyEvidence(brokenMandate, { ...files, receipts: { kind: 'ok', text: `${first.line}\n${brokenReceipt.line}\n` } }, NOW)
  assert.equal(brokenResult.mandates[0]?.authority.level, 'self-attested')
  assert.equal(brokenResult.mandates[0]?.authority.reasons.includes('chain-broken'), true)

  const mismatched = structuredClone(parsed.snapshot)
  const mismatchedRow = mismatched.mandates[0]
  if (mismatchedRow === undefined) throw new Error('mandate missing')
  mismatchedRow.receiptLeafHash = second.leaf
  mismatchedRow.grant = {
    seq: 2, hash: second.leaf, kind: 'other.kind', scope: canonicalJson({ paths: ['other'] }),
    ticketId: null, identity: null, ballId: null, epoch: null,
  }
  const mismatchedResult = await applyEvidence(mismatched, { ...files, receipts: { kind: 'ok', text: log } }, NOW)
  assert.equal(mismatchedResult.mandates[0]?.authority.level, 'self-attested')
  assert.ok(mismatchedResult.mandates[0]?.authority.reasons.some(reason => reason === 'grant-kind-mismatch' || reason === 'scope-mismatch'))
})

test('a valid unpinned signature is not owner confirmation', async () => {
  const record = await receiptLine({ schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64), data: { mandateId: 'mandate-1', scope: { paths: ['safe'] } } })
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const body = { schema: 'aukora.edge-checkpoint.v1', seq: 1, at: '2026-11-08T00:00:02.000Z', receiptCount: 1, lastReceiptHash: record.leaf, merkleRoot: record.leaf, prevCheckpointHash: null }
  const message = new TextEncoder().encode(`aukora.x5.edge-head.v1\0${canonicalJson(body)}`)
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, message))
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))
  const publicKeyHex = [...publicKey].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const signatureHex = [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const checkpointHashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson({ body, publicKeyHex, signatureHex }))))
  const checkpointHash = [...checkpointHashBytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const checkpoint = JSON.stringify({ body, publicKeyHex, signatureHex, checkpointHash })
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      receiptLeafHash: record.leaf, confirmed: true, confirmedBy: 'owner', ballId: 'ab'.repeat(32),
      grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope: { paths: ['safe'] }, ticketId: null, identity: null, ballId: null, epoch: 141 },
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${record.line}\n` },
    checkpoints: { kind: 'ok', text: `${checkpoint}\n` },
    head: { kind: 'ok', text: JSON.stringify({ ballId: 'ab'.repeat(32), epoch: 141, parentBallId: null }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('checkpoint-not-owner-authority'), true)
})

test('running heartbeats go stale only after the threshold and do not change executor state', async () => {
  const running = (pulse: Record<string, unknown>) => snapshot({
    assignments: [{ id: 'assignment-1', ticketId: 'ticket-1', state: 'running', executor: 'browser-worker', report: null, ...pulse }],
    attention: [],
  })
  const atBoundary = parseStatus(running({ startedAt: NOW - STALE_HEARTBEAT_MS }), 'auma_superagent', NOW)
  const past = parseStatus(running({ startedAt: NOW - STALE_HEARTBEAT_MS - 1 }), 'auma_superagent', NOW)
  const future = parseStatus(running({ heartbeatAt: NOW + 300_001, startedAt: NOW - 1 }), 'auma_superagent', NOW)
  const invalid = parseStatus(running({ heartbeatAt: 'not-a-time', startedAt: NOW }), 'auma_superagent', NOW)
  const missing = parseStatus(running({}), 'auma_superagent', NOW)
  assert.equal(atBoundary.ok && past.ok && future.ok && invalid.ok && missing.ok, true)
  if (!atBoundary.ok || !past.ok || !future.ok || !invalid.ok || !missing.ok) return
  const evidence = { receipts: { kind: 'missing' as const }, checkpoints: { kind: 'missing' as const }, head: { kind: 'missing' as const }, dag: { kind: 'missing' as const } }
  const boundary = await applyEvidence(atBoundary.snapshot, evidence, NOW)
  const aged = await applyEvidence(past.snapshot, evidence, NOW)
  const ahead = await applyEvidence(future.snapshot, evidence, NOW)
  const bad = await applyEvidence(invalid.snapshot, evidence, NOW)
  const none = await applyEvidence(missing.snapshot, evidence, NOW)
  assert.equal(boundary.assignments[0]?.heartbeat.availability, 'fresh')
  assert.equal(boundary.assignments[0]?.state, 'running')
  assert.equal(aged.assignments[0]?.heartbeat.availability, 'stale')
  assert.equal(aged.assignments[0]?.state, 'running')
  assert.equal(aged.attention.some(item => item.kind === 'stale-heartbeat' && item.source === 'heartbeat'), true)
  assert.equal(ahead.assignments[0]?.heartbeat.availability, 'future')
  assert.equal(bad.assignments[0]?.heartbeat.availability, 'invalid')
  assert.equal(none.assignments[0]?.heartbeat.availability, 'missing')
  const lines = paintLines({ kind: 'snapshot', snapshot: aged, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'world').map(line => line.text).join('\n')
  assert.equal(lines.includes(phrase('attention.staleHeartbeat')), true)
  assert.equal(lines.includes(phrase('heartbeat.notWork')), true)
  assert.equal(lines.includes(phrase('attention.heartbeatSource')), true)
})

test('DAG head metadata is surfaced and is not ancestry', async () => {
  assert.deepEqual(parseDagHead(JSON.stringify({ heads: ['ab'.repeat(32)], count: 2, updatedAt: 10 })), {
    kind: 'summary', headId: 'ab'.repeat(32), totalNodes: 2, updatedAt: '10', ancestryVerified: false,
  })
  assert.equal(parseDagHead(JSON.stringify({ headId: 'aa'.repeat(32), heads: ['bb'.repeat(32)] })).kind, 'malformed')
  assert.equal(parseDagHead('{').kind, 'malformed')
  const parsed = parseStatus(snapshot({ assignments: [], attention: [] }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'unavailable' }, checkpoints: { kind: 'unavailable' }, head: { kind: 'unavailable' },
    dag: { kind: 'ok', text: JSON.stringify({ heads: ['cd'.repeat(32)], count: 2, updatedAt: '2026-11-08T00:00:00.000Z' }) },
  }, NOW)
  const lines = paintLines({ kind: 'snapshot', snapshot: judged, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'self').map(line => line.text).join('\n')
  assert.equal(lines.includes('cd'.repeat(32)), true)
  assert.equal(lines.includes(phrase('dag.notAncestry')), true)
  assert.equal(lines.includes('lastMemoryId'), false)
})

test('the epoch 141 receipt log does not promote a hash match to owner consent', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const head = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const dag = readFileSync('mirror/home/auma/memory/dag/HEAD.json', 'utf8')
  const leaf = '8b4729b4910e22a42471bb8dfa074fd98f385352416a78788467b0e5ad2eebb4'
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'x6.1/v1', scope: 'deploy/cloudflare/**', expiry: null,
      receiptHash: leaf, confirmed: true, confirmedBy: 'owner',
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: head },
    dag: { kind: 'ok', text: dag },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('hash-linked-without-grant'), true)
  assert.equal(judged.dag.kind, 'summary')
  if (judged.dag.kind === 'summary') {
    assert.equal((judged.dag.totalNodes ?? 0) >= 3, true)
    assert.equal(judged.dag.ancestryVerified, false)
  }
  assert.equal(judged.head.kind, 'summary')
  if (judged.head.kind === 'summary') assert.equal(judged.head.epoch >= 142, true)
})

test('the epoch 142 grant stays chain-linked when only a runtime checkpoint covers it', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const head = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const dag = readFileSync('mirror/home/auma/memory/dag/HEAD.json', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as {
    mandates: Record<string, unknown>[]
  }
  const mnd = state.mandates[0]
  assert.equal(typeof mnd?.id, 'string')
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: mnd?.id,
      strength: mnd?.strength,
      policyVersion: mnd?.policyVersion,
      scope: JSON.stringify(mnd?.scope ?? {}),
      expiry: null,
      confirmed: mnd?.confirmed,
      confirmedBy: mnd?.confirmedBy,
      receiptHash: mnd?.receiptHash,
      receiptLeafHash: mnd?.receiptLeafHash,
      grant: mnd?.grant,
      ballId: mnd?.ballId,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: head },
    dag: { kind: 'ok', text: dag },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.lineage, 'promoted')
  assert.equal(judged.mandates[0]?.authority.identityClaim, 'owner')
  assert.equal(judged.mandates[0]?.authority.userVerification, 'not-attested')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('pinned-checkpoint-covers-grant'), true)
  assert.equal(judged.mandates[0]?.authority.reasons.includes('owner-attestation-missing'), true)
  assert.equal(judged.mandates[0]?.authority.reasons.includes('owner-attestation-verified'), false)
})

test('a spatial-tab grant is a claim beside the level, not a passkey and not owner', async () => {
  const record = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', identity: 'spatial-tab', scope: { paths: ['safe'] } },
  })
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      receiptLeafHash: record.leaf, confirmed: true, confirmedBy: 'spatial-tab',
      grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope: { paths: ['safe'] }, ticketId: null, identity: 'spatial-tab', ballId: null, epoch: null },
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${record.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'missing' }, dag: { kind: 'missing' },
  }, NOW)
  const authority = judged.mandates[0]?.authority
  assert.equal(authority?.level, 'chain-linked')
  assert.equal(authority?.reasons.includes('owner-attestation-missing'), true)
  assert.equal(authority?.identityClaim, 'spatial-tab')
  assert.equal(authority?.identitySource, 'grant-receipt')
  assert.equal(authority?.userVerification, 'not-attested')
  assert.equal(authority?.provenance, 'chain')
  const text = paintLines({ kind: 'snapshot', snapshot: judged, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'self')
    .map(line => line.text).join('\n')
  assert.equal(text.includes('spatial-tab'), true)
  assert.equal(text.includes(phrase('identity.notPasskey')), true)
  assert.equal(text.includes(phrase('identity.grantReceipt')), true)
})

test('plaintext confirmedBy owner cannot replace a spatial-tab grant receipt', async () => {
  const record = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', identity: 'spatial-tab', scope: { paths: ['safe'] } },
  })
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      receiptLeafHash: record.leaf, confirmed: true, confirmedBy: 'owner',
      grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope: { paths: ['safe'] }, ticketId: null, identity: 'spatial-tab', ballId: null, epoch: null },
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${record.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'missing' }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.identitySource, 'contradictory')
  assert.equal(judged.mandates[0]?.authority.identityClaim, null)
  assert.equal(judged.mandates[0]?.authority.reasons.includes('identity-contradictory'), true)
})

test('checkpoint 2 leaves the epoch 142 grant uncovered', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8').trim().split('\n').slice(0, 2).join('\n')
  const head = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as { mandates: Record<string, unknown>[] }
  const mnd = state.mandates[0]
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: mnd?.id, strength: mnd?.strength, policyVersion: mnd?.policyVersion,
      scope: JSON.stringify(mnd?.scope ?? {}), expiry: null, confirmed: mnd?.confirmed, confirmedBy: mnd?.confirmedBy,
      receiptLeafHash: mnd?.receiptLeafHash, grant: mnd?.grant, ballId: mnd?.ballId,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log },
    checkpoints: { kind: 'ok', text: `${checkpoints}\n` },
    head: { kind: 'ok', text: head },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.identityClaim, 'owner')
  assert.equal(judged.mandates[0]?.authority.userVerification, 'not-attested')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('checkpoint-not-owner-authority'), true)
})

test('a changed grant seq, kind, or ball is not owner-confirmed', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const head = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as { mandates: Record<string, unknown>[] }
  const mnd = state.mandates[0]
  const grant = mnd?.grant as { seq: number; kind: string; ballId: string }
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: mnd?.id, strength: mnd?.strength, policyVersion: mnd?.policyVersion,
      scope: JSON.stringify(mnd?.scope ?? {}), expiry: null, confirmed: true, confirmedBy: 'owner',
      receiptLeafHash: mnd?.receiptLeafHash,
      grant: { ...grant, seq: grant.seq + 1 },
      ballId: mnd?.ballId,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log }, checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'self-attested')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('grant-seq-mismatch'), true)
})

test('a later revoke and an expired grant scope are not owner confirmation', async () => {
  const grant = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', identity: 'spatial-tab', scope: { paths: ['safe'], expiresAt: NOW - 1 } },
  })
  const revoke = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'mandate.revoke', prevHash: grant.leaf,
    data: { mandateId: 'mandate-1' },
  })
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      receiptLeafHash: grant.leaf, confirmed: true, confirmedBy: 'spatial-tab',
      grant: { seq: 1, hash: grant.leaf, kind: 'mandate.grant', scope: { paths: ['safe'], expiresAt: NOW - 1 }, ticketId: null, identity: 'spatial-tab', ballId: null, epoch: null },
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${grant.line}\n${revoke.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'missing' }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('grant-revoked'), true)
  assert.equal(judged.mandates[0]?.authority.reasons.includes('grant-expired'), true)
  assert.equal(judged.mandates[0]?.authority.identityClaim, 'spatial-tab')
})

test('epoch 143 does not inherit the epoch 142 grant, and a parent pointer is not ancestry', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const headText = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as { mandates: Record<string, unknown>[] }
  const mnd = state.mandates[0]
  const grantBall = 'bca1e5aa6e2a84efcb07ae6b55b30b4c4d20c45d09ded1c6dcb04aacbba65cb9'
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: mnd?.id, strength: mnd?.strength, policyVersion: mnd?.policyVersion,
      scope: JSON.stringify(mnd?.scope ?? {}), expiry: null, confirmed: mnd?.confirmed, confirmedBy: mnd?.confirmedBy,
      receiptLeafHash: mnd?.receiptLeafHash, grant: mnd?.grant, ballId: mnd?.ballId,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const same = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log }, checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: headText }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(same.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(same.mandates[0]?.authority.lineage, 'promoted')
  assert.equal(same.mandates[0]?.authority.reasons.includes('owner-attestation-missing'), true)
  assert.equal(same.mandates[0]?.scope, parsed.snapshot.mandates[0]?.scope)

  const prior = log.trim().split('\n').slice(0, 47).join('\n')
  const tail = JSON.parse(prior.trim().split('\n').at(-1) ?? '{}') as { leafHash: string; seq: number }
  const mid = 'b1'.repeat(32)
  const next = 'c3'.repeat(32)
  const hop = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 1, at: '2026-11-08T02:00:00.000Z', kind: 'ball.promote', prevHash: tail.leafHash,
    data: { ballId: mid, parentBallId: grantBall, epoch: 143 },
  })
  const hop2 = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 2, at: '2026-11-08T02:00:01.000Z', kind: 'ball.promote', prevHash: hop.leaf,
    data: { ballId: next, parentBallId: mid, epoch: 144 },
  })
  const promotedHead = JSON.stringify({ ballId: next, parentBallId: grantBall, epoch: 144, version: 'x6.1-ball/v1' })
  const promoted = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n${hop2.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: promotedHead }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(promoted.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(promoted.mandates[0]?.authority.lineage, 'promoted')
  assert.equal(promoted.mandates[0]?.authority.reasons.includes('ball-advanced-since-grant'), true)
  assert.equal(promoted.mandates[0]?.authority.userVerification, 'not-attested')
  assert.equal(promoted.mandates[0]?.scope, same.mandates[0]?.scope)

  const claimed = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: promotedHead }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(claimed.mandates[0]?.authority.lineage, 'head-claim-only')
  assert.equal(claimed.mandates[0]?.authority.reasons.includes('ball-head-claim-only'), true)
  assert.equal(claimed.mandates[0]?.authority.reasons.includes('ball-advanced-since-grant'), false)
  assert.equal(claimed.mandates[0]?.authority.level, 'chain-linked')

  const unrelated = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log }, checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: 'd4'.repeat(32), parentBallId: 'e5'.repeat(32), epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(unrelated.mandates[0]?.authority.lineage, 'unrelated')
  assert.equal(unrelated.mandates[0]?.authority.reasons.includes('ball-mismatch'), true)

  const forged = hop.line.replace(hop.leaf, 'f6'.repeat(32))
  const forgedResult = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${forged}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: mid, parentBallId: grantBall, epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(forgedResult.mandates[0]?.authority.lineage, 'head-claim-only')

  const reversed = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 1, at: '2026-11-08T02:00:00.000Z', kind: 'ball.promote', prevHash: tail.leafHash,
    data: { ballId: grantBall, parentBallId: next, epoch: 143 },
  })
  const reversedResult = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${reversed.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: next, parentBallId: grantBall, epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(reversedResult.mandates[0]?.authority.lineage, 'head-claim-only')

  const wrongEpoch = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n${hop2.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: next, parentBallId: grantBall, epoch: 99 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(wrongEpoch.mandates[0]?.authority.lineage, 'unrelated')
  assert.equal(wrongEpoch.mandates[0]?.authority.reasons.includes('promote-epoch-mismatch'), true)
  assert.equal(wrongEpoch.mandates[0]?.authority.level, 'chain-linked')

  const noEpoch = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 1, at: '2026-11-08T02:00:00.000Z', kind: 'ball.promote', prevHash: tail.leafHash,
    data: { ballId: mid, parentBallId: grantBall },
  })
  const omittedEpoch = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${noEpoch.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: mid, parentBallId: grantBall, epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(omittedEpoch.mandates[0]?.authority.lineage, 'unrelated')
  assert.equal(omittedEpoch.mandates[0]?.authority.reasons.includes('promote-epoch-mismatch'), true)
  assert.equal(omittedEpoch.mandates[0]?.authority.level, 'chain-linked')

  const dropped = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: promotedHead }, dag: { kind: 'missing' },
  }, NOW)
  assert.equal(dropped.mandates[0]?.authority.lineage, 'head-claim-only')
  assert.equal(dropped.mandates[0]?.authority.reasons.includes('ball-advanced-since-grant'), false)

  const down = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 2, at: '2026-11-08T02:00:01.000Z', kind: 'ball.promote', prevHash: hop.leaf,
    data: { ballId: next, parentBallId: mid, epoch: 142 },
  })
  const decreased = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n${down.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: next, parentBallId: grantBall, epoch: 142 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(decreased.mandates[0]?.authority.lineage, 'unrelated')
  assert.equal(decreased.mandates[0]?.authority.reasons.includes('promote-epoch-mismatch'), true)
  assert.equal(decreased.mandates[0]?.authority.level, 'chain-linked')
})

test('a loader tree.patch edge is promoted, and a competing edge is a fork', async () => {
  const edge = extractPromoteEdge({
    kind: 'tree.patch', intact: true, seq: 3,
    data: { entryId: 'seed', ballId: 'ab'.repeat(32), parentBallId: 'cd'.repeat(32), epoch: 143 },
  })
  assert.equal(edge === 'bad-epoch', false)
  if (edge === 'bad-epoch' || edge === null) return
  assert.equal(edge.epoch, 143)
  assert.equal(extractPromoteEdge({
    kind: 'mandate.grant', intact: true, seq: 4,
    data: { ballId: 'ab'.repeat(32), parentBallId: 'cd'.repeat(32), epoch: 143 },
  }), null)

  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as { mandates: Record<string, unknown>[] }
  const mnd = state.mandates[0]
  const grantBall = 'bca1e5aa6e2a84efcb07ae6b55b30b4c4d20c45d09ded1c6dcb04aacbba65cb9'
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: mnd?.id, strength: mnd?.strength, policyVersion: mnd?.policyVersion,
      scope: JSON.stringify(mnd?.scope ?? {}), expiry: null, confirmed: mnd?.confirmed, confirmedBy: mnd?.confirmedBy,
      receiptLeafHash: mnd?.receiptLeafHash, grant: mnd?.grant, ballId: mnd?.ballId,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const prior = log.trim().split('\n').slice(0, 47).join('\n')
  const tail = JSON.parse(prior.trim().split('\n').at(-1) ?? '{}') as { leafHash: string; seq: number }
  const mid = 'b1'.repeat(32)
  const side = 'c3'.repeat(32)
  const hop = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 1, at: '2026-11-08T02:00:00.000Z', kind: 'tree.patch', prevHash: tail.leafHash,
    data: { entryId: 'seed', ballId: mid, parentBallId: grantBall, epoch: 143 },
  })
  const other = await receiptLine({
    schema: 'aukora.receipt.v3', seq: tail.seq + 2, at: '2026-11-08T02:00:01.000Z', kind: 'tree.patch', prevHash: hop.leaf,
    data: { entryId: 'seed', ballId: side, parentBallId: grantBall, epoch: 143 },
  })
  const one = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: mid, parentBallId: grantBall, epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(one.mandates[0]?.authority.lineage, 'promoted')
  assert.equal(one.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(one.mandates[0]?.authority.userVerification, 'not-attested')
  const fork = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: `${prior}\n${hop.line}\n${other.line}\n` },
    checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: JSON.stringify({ ballId: mid, parentBallId: grantBall, epoch: 143 }) },
    dag: { kind: 'missing' },
  }, NOW)
  assert.equal(fork.mandates[0]?.authority.lineage, 'unrelated')
  assert.equal(fork.mandates[0]?.authority.reasons.includes('promote-fork'), true)
  assert.equal(fork.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(fork.mandates[0]?.authority.reasons.includes('pinned-checkpoint-covers-grant'), true)
  assert.equal(fork.mandates[0]?.authority.reasons.includes('owner-attestation-missing'), true)
})

test('explicit mandate confirmation is painted as its own attention line', () => {
  const parsed = parseStatus(snapshot({
    attention: [{ id: 'attention-explicit', kind: 'explicit-mandate-confirmation', text: 'Confirm the explicit mandate' }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const text = paintLines({ kind: 'snapshot', snapshot: parsed.snapshot, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'self')
    .map(line => line.text).join('\n')
  assert.equal(text.includes(phrase('attention.explicit')), true)
  assert.equal(text.includes(phrase('attention.inferred')), false)
})

test('a promote receipt hash and a self-minted owner grant are not owner confirmation', async () => {
  const log = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const checkpoints = readFileSync('mirror/home/auma/seed/checkpoints.v1.jsonl', 'utf8')
  const head = readFileSync('mirror/home/balls/HEAD.json', 'utf8')
  const state = JSON.parse(readFileSync('mirror/home/auma/superagent/state.json', 'utf8')) as { mandates: Record<string, unknown>[] }
  const probes = state.mandates.filter(mandate => mandate.confirmed !== true)
  assert.equal(probes.length >= 2, true)
  const parsed = parseStatus(snapshot({
    mandates: probes.map(mandate => ({
      id: mandate.id, strength: mandate.strength, policyVersion: mandate.policyVersion,
      scope: JSON.stringify(mandate.scope ?? {}), expiry: null, confirmed: mandate.confirmed, confirmedBy: mandate.confirmedBy,
      receiptHash: mandate.receiptHash, receiptLeafHash: mandate.receiptLeafHash, grant: mandate.grant, ballId: mandate.ballId,
    })),
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const judged = await applyEvidence(parsed.snapshot, {
    receipts: { kind: 'ok', text: log }, checkpoints: { kind: 'ok', text: checkpoints },
    head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW)
  for (const mandate of judged.mandates) {
    assert.notEqual(mandate.authority.level, 'owner-confirmed')
    if (mandate.grant === null && mandate.confirmed === false) {
      assert.equal(mandate.authority.level, 'unknown')
      const ignored = mandate.authority.reasons.includes('non-grant-receipt-ignored')
      const absent = mandate.authority.reasons.includes('no-receipt-claim')
      assert.equal(ignored || absent, true)
      assert.equal(mandate.authority.reasons.includes('hash-linked-without-grant'), false)
    }
  }

  const ball = 'ab'.repeat(32)
  const scope = { paths: ['safe'] }
  const record = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'owner', ballId: ball, epoch: 142, scope },
  })
  const signer = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', signer.publicKey))
  const publicKeyHex = [...raw].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const binding = {
    schema: OWNER_GRANT_SCHEMA, mandateId: 'mandate-1', ticketId: 'ticket-1', scope, ballId: ball, epoch: 142, expiresAt: null, identity: 'owner',
  }
  const signatureHex = await signOwner(ownerGrantCanonical(binding), signer.privateKey)
  const attestation = { ...binding, publicKeyHex, signatureHex }
  const grantView = {
    id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
    receiptLeafHash: record.leaf, confirmed: true, confirmedBy: 'owner', ballId: ball,
    grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner', ballId: ball, epoch: 142 },
  }
  const sameHead = JSON.stringify({ ballId: ball, parentBallId: null, epoch: 142 })
  const body = parseStatus(snapshot({ mandates: [grantView] }), 'auma_superagent', NOW)
  assert.equal(body.ok, true)
  if (!body.ok) return
  const evidence = {
    receipts: { kind: 'ok' as const, text: `${record.line}\n` },
    checkpoints: { kind: 'missing' as const },
    head: { kind: 'ok' as const, text: sameHead },
    dag: { kind: 'missing' as const },
  }
  const untrusted = await applyEvidence(body.snapshot, evidence, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [], attestations: [attestation] })
  assert.equal(untrusted.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(untrusted.mandates[0]?.authority.reasons.includes('owner-key-untrusted'), true)
  const forged = await applyEvidence(body.snapshot, evidence, NOW, STALE_HEARTBEAT_MS, {
    trustedKeys: [publicKeyHex],
    attestations: [{ ...attestation, signatureHex: 'ab'.repeat(64) }],
  })
  assert.equal(forged.mandates[0]?.authority.reasons.includes('owner-signature-invalid'), true)
  assert.equal(forged.mandates[0]?.authority.level, 'chain-linked')
  const tampered = await applyEvidence(body.snapshot, evidence, NOW, STALE_HEARTBEAT_MS, {
    trustedKeys: [publicKeyHex],
    attestations: [{ ...attestation, mandateId: 'mandate-other' }],
  })
  assert.equal(tampered.mandates[0]?.authority.reasons.includes('owner-binding-mismatch'), true)
  const confirmed = await applyEvidence(body.snapshot, evidence, NOW, STALE_HEARTBEAT_MS, {
    trustedKeys: [publicKeyHex], attestations: [attestation],
  })
  assert.equal(confirmed.mandates[0]?.authority.level, 'owner-confirmed')
  assert.equal(confirmed.mandates[0]?.authority.provenance, 'owner-attestation')
  assert.equal(confirmed.mandates[0]?.authority.userVerification, 'not-attested')
  assert.equal(confirmed.mandates[0]?.authority.reasons.includes('user-verification-not-attested'), true)
  const laterHead = JSON.stringify({ ballId: 'cd'.repeat(32), parentBallId: ball, epoch: 143 })
  const moved = await applyEvidence(body.snapshot, { ...evidence, head: { kind: 'ok', text: laterHead } }, NOW, STALE_HEARTBEAT_MS, {
    trustedKeys: [publicKeyHex], attestations: [attestation],
  })
  assert.equal(moved.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(moved.mandates[0]?.authority.reasons.includes('owner-attestation-not-extended'), true)

  const tabRecord = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'spatial-tab', ballId: ball, epoch: 142, scope },
  })
  const tabBinding = { ...binding, identity: 'spatial-tab' }
  const tabSig = await signOwner(ownerGrantCanonical(tabBinding), signer.privateKey)
  const tabParsed = parseStatus(snapshot({
    mandates: [{ ...grantView, receiptLeafHash: tabRecord.leaf, confirmedBy: 'spatial-tab', grant: { ...grantView.grant, hash: tabRecord.leaf, identity: 'spatial-tab' } }],
  }), 'auma_superagent', NOW)
  assert.equal(tabParsed.ok, true)
  if (!tabParsed.ok) return
  const tab = await applyEvidence(tabParsed.snapshot, { ...evidence, receipts: { kind: 'ok', text: `${tabRecord.line}\n` } }, NOW, STALE_HEARTBEAT_MS, {
    trustedKeys: [publicKeyHex],
    attestations: [{ ...tabBinding, publicKeyHex, signatureHex: tabSig }],
  })
  assert.equal(tab.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(tab.mandates[0]?.authority.reasons.includes('owner-identity-rejected'), true)
})

test('a refused confirm does not treat a promote hash as grant linkage', async () => {
  const promote = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'ball.promote', prevHash: '0'.repeat(64),
    data: { ballId: 'ab'.repeat(32), parentBallId: 'cd'.repeat(32), epoch: 143 },
  })
  const grant = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', identity: 'owner', scope: { paths: ['safe'] } },
  })
  const files = {
    receipts: { kind: 'ok' as const, text: `${promote.line}\n` },
    checkpoints: { kind: 'missing' as const },
    head: { kind: 'missing' as const },
    dag: { kind: 'missing' as const },
  }
  const refused = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: false, confirmedBy: null, grant: null, receiptHash: promote.leaf, receiptLeafHash: null,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(refused.ok, true)
  if (!refused.ok) return
  const judged = await applyEvidence(refused.snapshot, files, NOW)
  assert.equal(judged.mandates[0]?.authority.level, 'unknown')
  assert.equal(judged.mandates[0]?.authority.reasons.includes('non-grant-receipt-ignored'), true)
  assert.equal(judged.mandates[0]?.authority.reasons.includes('hash-linked-without-grant'), false)
  const text = paintLines({ kind: 'snapshot', snapshot: judged, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'self')
    .map(line => line.text).join('\n')
  assert.equal(text.includes(phrase('authority.nonGrantHash')), true)
  assert.equal(text.includes(promote.leaf), false)

  const absent = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'inferred', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: false, grant: null,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(absent.ok, true)
  if (!absent.ok) return
  const noHash = await applyEvidence(absent.snapshot, files, NOW)
  assert.equal(noHash.mandates[0]?.authority.level, 'unknown')
  assert.equal(noHash.mandates[0]?.authority.reasons.includes('no-receipt-claim'), true)

  const leafWins = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: false, grant: null, receiptLeafHash: promote.leaf, receiptHash: grant.leaf,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(leafWins.ok, true)
  if (!leafWins.ok) return
  const preferred = await applyEvidence(leafWins.snapshot, { ...files, receipts: { kind: 'ok', text: `${promote.line}\n${grant.line}\n` } }, NOW)
  assert.equal(preferred.mandates[0]?.authority.level, 'unknown')
  assert.equal(preferred.mandates[0]?.authority.reasons.includes('non-grant-receipt-ignored'), true)

  const realGrant = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: false, grant: null, receiptLeafHash: grant.leaf,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(realGrant.ok, true)
  if (!realGrant.ok) return
  const kept = await applyEvidence(realGrant.snapshot, { ...files, receipts: { kind: 'ok', text: `${grant.line}\n` } }, NOW)
  assert.equal(kept.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(kept.mandates[0]?.authority.reasons.includes('hash-linked-without-grant'), true)
  assert.equal(kept.mandates[0]?.authority.reasons.includes('owner-attestation-verified'), false)
})

test('the reader passes caller owner keys through and does not copy them from the envelope', async () => {
  const ball = 'ab'.repeat(32)
  const next = 'cd'.repeat(32)
  const scope = { paths: ['safe'] }
  const record = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142, scope },
  })
  const hop = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'tree.patch', prevHash: record.leaf,
    data: { entryId: 'seed', ballId: next, parentBallId: ball, epoch: 143 },
  })
  const signer = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', signer.publicKey))
  const publicKeyHex = [...raw].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const binding = {
    schema: OWNER_GRANT_SCHEMA, mandateId: 'mandate-1', ticketId: 'ticket-1', scope,
    ballId: ball, epoch: 142, expiresAt: null, identity: 'owner-key',
  }
  const signatureHex = await signOwner(ownerGrantCanonical(binding), signer.privateKey)
  const attestation = { ...binding, publicKeyHex, signatureHex }
  const status = snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: record.leaf,
      grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  })
  const head = JSON.stringify({ ballId: ball, parentBallId: null, epoch: 142 })
  const later = JSON.stringify({ ballId: next, parentBallId: ball, epoch: 143 })
  const readText = async (path: string) => {
    if (path === RECEIPTS_LOG_PATH) return { kind: 'ok' as const, text: `${record.line}\n` }
    if (path === BALL_HEAD_PATH) return { kind: 'ok' as const, text: head }
    if (path === CHECKPOINTS_PATH || path === DAG_HEAD_PATH) return { kind: 'missing' as const }
    return { kind: 'missing' as const }
  }
  const script = scriptedFetch(call => call.name === 'seed_receipts'
    ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: record.leaf, latestCheckpointHash: null })
    : toolOk(status))
  const read = createSuperagentRead({
    fetch: script.fetch, now: () => NOW, readText, trustedOwnerKeys: [publicKeyHex], ownerAttestations: [attestation],
  })
  const phase = await untilPhase(read)
  assert.equal(phase.kind, 'snapshot')
  if (phase.kind !== 'snapshot') return
  const authority = phase.snapshot.mandates[0]?.authority
  assert.equal(authority?.level, 'owner-confirmed')
  assert.equal(authority?.provenance, 'owner-attestation')
  assert.equal(authority?.reasons.includes('owner-attestation-verified'), true)
  assert.equal(authority?.userVerification, 'not-attested')
  read.stop()

  const bare = createSuperagentRead({
    fetch: scriptedFetch(call => call.name === 'seed_receipts'
      ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: record.leaf, latestCheckpointHash: null })
      : toolOk(status)).fetch,
    now: () => NOW, readText, ownerAttestations: [attestation],
  })
  const barePhase = await untilPhase(bare)
  assert.equal(barePhase.kind, 'snapshot')
  if (barePhase.kind !== 'snapshot') return
  assert.equal(barePhase.snapshot.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(barePhase.snapshot.mandates[0]?.authority.reasons.includes('owner-key-untrusted'), true)
  bare.stop()

  const advancedText = async (path: string) => {
    if (path === RECEIPTS_LOG_PATH) return { kind: 'ok' as const, text: `${record.line}\n${hop.line}\n` }
    if (path === BALL_HEAD_PATH) return { kind: 'ok' as const, text: later }
    return { kind: 'missing' as const }
  }
  const advanced = createSuperagentRead({
    fetch: scriptedFetch(call => call.name === 'seed_receipts'
      ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: hop.leaf, latestCheckpointHash: null })
      : toolOk(status)).fetch,
    now: () => NOW, readText: advancedText, trustedOwnerKeys: [publicKeyHex], ownerAttestations: [attestation],
  })
  const advancedPhase = await untilPhase(advanced)
  assert.equal(advancedPhase.kind, 'snapshot')
  if (advancedPhase.kind !== 'snapshot') return
  const moved = advancedPhase.snapshot.mandates[0]?.authority
  assert.equal(moved?.level, 'chain-linked')
  assert.equal(moved?.reasons.includes('ball-advanced-since-grant'), true)
  assert.equal(moved?.reasons.includes('owner-attestation-not-extended'), true)
  assert.equal(moved?.userVerification, 'not-attested')
  advanced.stop()

  const tampered = createSuperagentRead({
    fetch: scriptedFetch(call => call.name === 'seed_receipts'
      ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: record.leaf, latestCheckpointHash: null })
      : toolOk(status)).fetch,
    now: () => NOW, readText, trustedOwnerKeys: [publicKeyHex],
    ownerAttestations: [{ ...attestation, signatureHex: 'ab'.repeat(64) }],
  })
  const tamperedPhase = await untilPhase(tampered)
  assert.equal(tamperedPhase.kind, 'snapshot')
  if (tamperedPhase.kind !== 'snapshot') return
  assert.equal(tamperedPhase.snapshot.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(tamperedPhase.snapshot.mandates[0]?.authority.reasons.includes('owner-signature-invalid'), true)
  tampered.stop()
})

test('a persisted ownerGrant confirms the matching ball and not the next epoch', async () => {
  const syntheticOwnerKey = '962cbbeae62a10e41036fb4c569b44f1f87e312134b6a59301c99cbc617c1e80'
  const ball = 'ab'.repeat(32)
  const next = 'cd'.repeat(32)
  const scope = { paths: ['safe'] }
  const signer = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', signer.publicKey))
  const publicKeyHex = [...raw].map(byte => byte.toString(16).padStart(2, '0')).join('')
  assert.notEqual(publicKeyHex, syntheticOwnerKey)
  const binding = {
    schema: OWNER_GRANT_SCHEMA, mandateId: 'mandate-1', ticketId: 'ticket-1', scope,
    ballId: ball, epoch: 142, expiresAt: null, identity: 'owner-key',
  }
  const signatureHex = await signOwner(ownerGrantCanonical(binding), signer.privateKey)
  const attestation = { ...binding, publicKeyHex, signatureHex }
  const record = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142, scope, ownerGrant: attestation },
  })
  const hop = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'tree.patch', prevHash: record.leaf,
    data: { entryId: 'seed', ballId: next, parentBallId: ball, epoch: 143 },
  })
  const status = snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: record.leaf,
      grant: { seq: 1, hash: record.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  })
  const head = JSON.stringify({ ballId: ball, parentBallId: null, epoch: 142 })
  const readText = async (path: string) => {
    if (path === RECEIPTS_LOG_PATH) return { kind: 'ok' as const, text: `${record.line}\n` }
    if (path === BALL_HEAD_PATH) return { kind: 'ok' as const, text: head }
    return { kind: 'missing' as const }
  }
  const read = createSuperagentRead({
    fetch: scriptedFetch(call => call.name === 'seed_receipts'
      ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: record.leaf, latestCheckpointHash: null })
      : toolOk(status)).fetch,
    now: () => NOW, readText, trustedOwnerKeys: [publicKeyHex],
  })
  const phase = await untilPhase(read)
  assert.equal(phase.kind, 'snapshot')
  if (phase.kind !== 'snapshot') return
  assert.equal(phase.snapshot.mandates[0]?.authority.level, 'owner-confirmed')
  assert.equal(phase.snapshot.mandates[0]?.authority.provenance, 'owner-attestation')
  assert.equal(phase.snapshot.mandates[0]?.authority.reasons.includes('owner-attestation-verified'), true)
  assert.equal(phase.snapshot.mandates[0]?.authority.userVerification, 'not-attested')
  read.stop()

  const advanced = createSuperagentRead({
    fetch: scriptedFetch(call => call.name === 'seed_receipts'
      ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: hop.leaf, latestCheckpointHash: null })
      : toolOk(status)).fetch,
    now: () => NOW,
    readText: async (path: string) => {
      if (path === RECEIPTS_LOG_PATH) return { kind: 'ok', text: `${record.line}\n${hop.line}\n` }
      if (path === BALL_HEAD_PATH) return { kind: 'ok', text: JSON.stringify({ ballId: next, parentBallId: ball, epoch: 143 }) }
      return { kind: 'missing' }
    },
    trustedOwnerKeys: [publicKeyHex],
  })
  const advancedPhase = await untilPhase(advanced)
  assert.equal(advancedPhase.kind, 'snapshot')
  if (advancedPhase.kind !== 'snapshot') return
  const moved = advancedPhase.snapshot.mandates[0]?.authority
  assert.equal(moved?.level, 'chain-linked')
  assert.equal(moved?.reasons.includes('ball-advanced-since-grant'), true)
  assert.equal(moved?.reasons.includes('owner-attestation-not-extended'), true)
  advanced.stop()

  const bare = await applyEvidence((await mustStatus(status)), {
    receipts: { kind: 'ok', text: `${record.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [] })
  assert.equal(bare.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(bare.mandates[0]?.authority.reasons.includes('owner-key-untrusted'), true)

  const tamperedRecord = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: {
      mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142, scope,
      ownerGrant: { ...attestation, mandateId: 'mandate-other' },
    },
  })
  const tampered = await applyEvidence((await mustStatus(snapshot({
    mandates: [{
      ...(status.mandates as Record<string, unknown>[])[0], receiptLeafHash: tamperedRecord.leaf,
      grant: { seq: 1, hash: tamperedRecord.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  }))), {
    receipts: { kind: 'ok', text: `${tamperedRecord.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [publicKeyHex] })
  assert.equal(tampered.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(tampered.mandates[0]?.authority.reasons.includes('owner-binding-mismatch'), true)

  const plain = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'mandate.grant', prevHash: '0'.repeat(64),
    data: { mandateId: 'mandate-1', ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142, scope },
  })
  const onGrant = await applyEvidence((await mustStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: plain.leaf,
      grant: { seq: 1, hash: plain.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142, ownerGrant: attestation },
    }],
  }))), {
    receipts: { kind: 'ok', text: `${plain.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [publicKeyHex] })
  assert.equal(onGrant.mandates[0]?.authority.level, 'owner-confirmed')
  const onMandate = await applyEvidence((await mustStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: plain.leaf, ownerGrant: attestation,
      grant: { seq: 1, hash: plain.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  }))), {
    receipts: { kind: 'ok', text: `${plain.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [publicKeyHex] })
  assert.equal(onMandate.mandates[0]?.authority.level, 'owner-confirmed')
  assert.equal(onMandate.mandates[0]?.authority.userVerification, 'not-attested')
  assert.equal(onMandate.mandates[0]?.authority.passkeyVerified, false)
  assert.equal(onMandate.mandates[0]?.pearlId, onMandate.mandates[0]?.ballId)
  const flagged = await applyEvidence((await mustStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: plain.leaf,
      ownerGrant: { ...attestation, passkeyVerified: true, credentialId: 'cred-1', aumlokBinding: 'bound' },
      grant: { seq: 1, hash: plain.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  }))), {
    receipts: { kind: 'ok', text: `${plain.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [publicKeyHex] })
  assert.equal(flagged.mandates[0]?.authority.passkeyVerified, false)
  assert.equal(flagged.mandates[0]?.authority.credentialId, null)
  assert.equal(flagged.mandates[0]?.authority.aumlokBinding, 'unknown')
  assert.equal(flagged.mandates[0]?.authority.reasons.includes('presence-flag-ignored'), true)

  const claimed = { ...attestation, publicKeyHex: syntheticOwnerKey }
  const realOnly = await applyEvidence((await mustStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7', scope: 'safe', expiry: null,
      confirmed: true, confirmedBy: 'owner-key', ballId: ball, receiptLeafHash: plain.leaf, ownerGrant: claimed,
      grant: { seq: 1, hash: plain.leaf, kind: 'mandate.grant', scope, ticketId: 'ticket-1', identity: 'owner-key', ballId: ball, epoch: 142 },
    }],
  }))), {
    receipts: { kind: 'ok', text: `${plain.line}\n` },
    checkpoints: { kind: 'missing' }, head: { kind: 'ok', text: head }, dag: { kind: 'missing' },
  }, NOW, STALE_HEARTBEAT_MS, { trustedKeys: [syntheticOwnerKey] })
  assert.equal(realOnly.mandates[0]?.authority.level, 'chain-linked')
  assert.equal(realOnly.mandates[0]?.authority.reasons.includes('owner-signature-invalid'), true)
  assert.equal(realOnly.mandates[0]?.authority.userVerification, 'not-attested')
})

async function mustStatus(body: Record<string, unknown>) {
  const parsed = parseStatus(body, 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('status')
  return parsed.snapshot
}

async function untilPhase(read: ReturnType<typeof createSuperagentRead>) {
  for (let i = 0; i < 20; i += 1) {
    const phase = read.current()
    if (phase.kind !== 'loading') return phase
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return read.current()
}

async function signOwner(canonical: string, privateKey: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' }, privateKey, new TextEncoder().encode(OWNER_GRANT_DOMAIN + canonical),
  ))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const AURA_FILE = '/dsh/home/auma/seed/aura.v1.json'
const RETENTION_FILE = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
const SCARS_FILE = '/dsh/home/auma/seed/scars.jsonl'
const DISCOVERY_FILE = '/dsh/home/auma/seed/discovery-corpus.v1.jsonl'
const HANDOFF_FILE = '/dsh/home/auma/HANDOFF.md'

async function auraFiles() {
  const files = new Map<string, EvidenceFile>()
  const manifest = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 4, entries: { fixture: { id: 'fixture', specifier: 'fixture-organ', config: {}, disabled: false, previousSpecifiers: [] } }, modules: {} }
  const ballId = sha256Hex(new TextEncoder().encode(canonicalJson(manifest)))
  assert.ok(ballId !== null)
  const suite = { schema: 'aukora.pearl.retention-suite.v1', cases: [{ id: 'retain-one', args: { action: 'check' }, expected: true }] }
  const seed = await receiptLine({ schema: 'aukora.receipt.v3', seq: 1, at: new Date(NOW).toISOString(), kind: 'seed.bootstrap', prevHash: '0'.repeat(64), data: { ballId, epoch: 4 } })
  const nodeBody = { parentIds: [], content: 'Synthetic fixture only', receiptHash: seed.leaf, createdAt: NOW }
  const nodeId = sha256Hex(new TextEncoder().encode(canonicalJson(nodeBody)))
  assert.ok(nodeId !== null)
  const node = { ...nodeBody, id: nodeId }
  const append = await receiptLine({ schema: 'aukora.receipt.v3', seq: 2, at: new Date(NOW).toISOString(), kind: 'memory.dag.append', prevHash: seed.leaf, data: { nodeId } })
  const challengeData = {
    ballId, epoch: 4, winnerLabel: 'candidate-a', isolated: true,
    retentionSuiteHash: sha256Hex(new TextEncoder().encode(canonicalJson(suite))),
    candidates: [{ label: 'candidate-a', durationMs: 7, retentionResults: [{ id: 'retain-one', passed: true }] }, { label: 'candidate-b' }],
  }
  const challenge = await receiptLine({ schema: 'aukora.receipt.v3', seq: 3, at: new Date(NOW).toISOString(), kind: 'pearl.challenge', prevHash: append.leaf, data: challengeData })
  const json = (path: string, value: unknown): void => { files.set(path, { kind: 'ok', text: JSON.stringify(value) }) }
  json(BALL_HEAD_PATH, { ...manifest, ballId })
  json(DAG_HEAD_PATH, { heads: [nodeId], count: 1 })
  json(`/dsh/home/auma/memory/dag/nodes/${nodeId}.json`, node)
  json(AURA_FILE, { schema: 'aukora.aura.v1', scorer: 'rules-v1', ballId, epoch: 4, authorityTier: 'peripheral-hint', vector: { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 } })
  json(RETENTION_FILE, suite)
  files.set(SCARS_FILE, { kind: 'ok', text: '{"id":"fixture-scar"}\n' })
  files.set(DISCOVERY_FILE, { kind: 'ok', text: '' })
  files.set(HANDOFF_FILE, { kind: 'ok', text: `| epoch | **4** |\n| ballId | \`${ballId}\` |\n` })
  files.set(RECEIPTS_LOG_PATH, { kind: 'ok', text: [seed.line, append.line, challenge.line].join('\n') + '\n' })
  files.set(CHECKPOINTS_PATH, { kind: 'ok', text: '' })
  return { files, nodeId, challengeData, seed, append }
}

/** The /_host/wake view both real hosts send for a disabled schedule. */
const IDLE_WAKE = Object.freeze({ ok: true, enabled: false, intervalMs: 60000, nextWakeAt: null as number | null,
  wakeCount: 0, consecutiveUnacknowledgedWakes: 0, probePending: false })

function fixtureReader(files: Map<string, EvidenceFile>, options: SuperagentReadOptions = {}) {
  const script = scriptedFetch(call => call.name === 'seed_receipts' ? toolOk({ ok: true, action: 'verify', currentMerkleRoot: ROOT })
    : toolOk(snapshot({ mandates: [], tickets: [], assignments: [], attention: [] })))
  return createSuperagentRead({ fetch: script.fetch, now: () => NOW, readText: path => Promise.resolve(files.get(path) ?? { kind: 'missing' }),
    readWake: () => Promise.resolve({ ...IDLE_WAKE }), ...options })
}

void test('complete bounded VFS evidence recomputes calm and self-attested Pearl without proving worker isolation', async () => {
  const { files } = await auraFiles()
  const read = fixtureReader(files)
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.ok('auraStatus' in phase.snapshot.aura)
    assert.equal(phase.snapshot.aura.status, 'calm')
    assert.equal(phase.snapshot.aura.auraStatus, 'recomputed-verified')
    assert.equal(phase.snapshot.aura.authorityTier, 'peripheral-hint')
    assert.deepEqual(phase.snapshot.pearl, {
      retentionTotal: 1, retentionPassed: 1, scarsCount: 1, lastChallengeAt: new Date(NOW).toISOString(),
      lastWinnerLabel: 'candidate-a', candidateCount: 2, durationMs: 7, authorityTier: 'self-attested', status: 'complete', isolationProved: false, gaps: [],
      candidatesTested: null, coarsePassCount: null, finePassCount: null, negativeControlRejected: null,
      checkpoint: { count: 0, lastReceiptCount: null, receiptTotal: 3, lastSigned: false } })
  } finally { read.stop() }
})

void test('an overdue enabled wake schedule from the host wake view reaches the aura (host parity)', async () => {
  const { files } = await auraFiles()
  const wake = { ...IDLE_WAKE, enabled: true, nextWakeAt: NOW - 10 * 60000 }
  const read = fixtureReader(files, { readWake: () => Promise.resolve(wake) })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.ok('auraStatus' in phase.snapshot.aura)
    // Her stored aura file still says calm, so the recomputed alert is reported as her file disagreeing.
    assert.equal(phase.snapshot.aura.auraStatus, 'self-asserted-mismatch')
    assert.equal(phase.snapshot.aura.wakeUrgency, 1)
    assert.equal(phase.snapshot.aura.recommendedFocus, 'escalate-to-owner')
    assert.deepEqual(phase.snapshot.aura.salience, [{ kind: 'stale-ticket', score: 1 }])
  } finally { read.stop() }
  const unknown = fixtureReader(files, { readWake: () => Promise.resolve({ ...wake, nextWakeAt: 'soon' }) })
  try {
    const phase = await untilPhase(unknown)
    assert.equal(phase.kind, 'snapshot')
    assert.ok('auraStatus' in phase.snapshot.aura)
    assert.equal(phase.snapshot.aura.auraStatus, 'incomplete')
  } finally { unknown.stop() }
})

void test('wake metadata uses a separate same-origin host GET, never the worker tunnel', async () => {
  const { files } = await auraFiles()
  let hostCalls = 0
  const script = scriptedFetch(call => call.name === 'seed_receipts' ? toolMissing(call.name)
    : toolOk(snapshot({ mandates: [], tickets: [], assignments: [], attention: [] })))
  const read = createSuperagentRead({ fetch: script.fetch, now: () => NOW, readText: path => Promise.resolve(files.get(path) ?? { kind: 'missing' }), hostFetch: (path, init) => {
    hostCalls++
    assert.equal(path, '/_host/wake')
    assert.equal(init.method, 'GET')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.cache, 'no-store')
    return Promise.resolve({ status: 200,
      text: () => Promise.resolve(JSON.stringify(IDLE_WAKE)),
    })
  } })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.equal(phase.snapshot.aura.status, 'calm')
    assert.equal(hostCalls, 1)
    assert.deepEqual(script.calls.map(call => call.args.action).sort(), ['status', 'verify'])
  } finally { read.stop() }
})

void test('missing, corrupt, truncated and changing decisive evidence never becomes calm', async () => {
  for (const path of [BALL_HEAD_PATH, DAG_HEAD_PATH, HANDOFF_FILE, RECEIPTS_LOG_PATH, DISCOVERY_FILE, AURA_FILE]) {
    for (const file of [{ kind: 'missing' }, { kind: 'bounded' }, { kind: 'ok', text: '{broken' }] satisfies EvidenceFile[]) {
      const { files } = await auraFiles()
      files.set(path, file)
      const read = fixtureReader(files)
      try {
        const phase = await untilPhase(read)
        assert.equal(phase.kind, 'snapshot')
        assert.equal(phase.snapshot.aura.status, 'incomplete', `${path}: ${file.kind}`)
      } finally { read.stop() }
    }
  }
  const { files } = await auraFiles()
  let headReads = 0
  const read = fixtureReader(files, { readText: path => Promise.resolve(path === BALL_HEAD_PATH && ++headReads > 1
    ? { kind: 'ok', text: JSON.stringify({ ballId: CHECKPOINT, epoch: 5 }) } : files.get(path) ?? { kind: 'missing' }) })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.ok('auraStatus' in phase.snapshot.aura)
    assert.equal(phase.snapshot.aura.status, 'incomplete')
    assert.equal(phase.snapshot.aura.gaps.includes('evidence-changed'), true)
    assert.equal(phase.snapshot.head.kind, 'unavailable')
  } finally { read.stop() }
})

void test('DAG traversal rejects path injection, oversize HEADs and corrupted nodes before following parents', async () => {
  for (const head of [{ heads: ['../../private'], count: 1 }, { heads: [ROOT], count: 257 }, { heads: [ROOT, ROOT], count: 2 }]) {
    const { files } = await auraFiles()
    files.set(DAG_HEAD_PATH, { kind: 'ok', text: JSON.stringify(head) })
    const paths: string[] = []
    const read = fixtureReader(files, { readText: (path) => { paths.push(path); return Promise.resolve(files.get(path) ?? { kind: 'missing' }) } })
    try {
      const phase = await untilPhase(read)
      assert.equal(phase.kind, 'snapshot')
      assert.equal(phase.snapshot.aura.status, 'incomplete')
      assert.equal(paths.some(path => path.includes('/nodes/')), false)
    } finally { read.stop() }
  }
  const { files, nodeId } = await auraFiles()
  files.set(`/dsh/home/auma/memory/dag/nodes/${nodeId}.json`, { kind: 'ok', text: JSON.stringify({ id: nodeId, parentIds: [ROOT], content: 'tampered' }) })
  const paths: string[] = []
  const read = fixtureReader(files, { readText: (path) => { paths.push(path); return Promise.resolve(files.get(path) ?? { kind: 'missing' }) } })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.equal(phase.snapshot.aura.status, 'incomplete')
    assert.equal(paths.includes(`/dsh/home/auma/memory/dag/nodes/${ROOT}.json`), false)
  } finally { read.stop() }
})

void test('byte and record caps retain unknown Pearl counts rather than partial totals', async () => {
  const { files } = await auraFiles()
  files.set(RETENTION_FILE, { kind: 'ok', text: 'é'.repeat(EVIDENCE_READ_LIMITS.fileBytes / 2 + 1) })
  files.set(SCARS_FILE, { kind: 'ok', text: '{}\n'.repeat(EVIDENCE_READ_LIMITS.records + 1) })
  const read = fixtureReader(files)
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.ok(phase.snapshot.pearl)
    assert.equal(phase.snapshot.pearl.retentionTotal, null)
    assert.equal(phase.snapshot.pearl.retentionPassed, null)
    assert.equal(phase.snapshot.pearl.scarsCount, null)
  } finally { read.stop() }
})

void test('deadline settles even when injected file, wake or tool reads ignore cancellation', async () => {
  const { files } = await auraFiles()
  const never = (): Promise<never> => new Promise(() => {})
  for (const options of [{ readText: never }, { readWake: never }, { fetch: never }] satisfies SuperagentReadOptions[]) {
    const read = fixtureReader(files, { ...options, timeoutMs: 5 })
    try {
      const phase = await untilPhase(read)
      assert.notEqual(phase.kind, 'loading')
      if (phase.kind === 'snapshot') assert.equal(phase.snapshot.aura.status, 'incomplete')
    } finally { read.stop() }
  }
})

void test('flat writer layout is supported but competing copies are not silently selected', async () => {
  for (const duplicates of [false, true]) {
    const { files, nodeId } = await auraFiles()
    const nested = `/dsh/home/auma/memory/dag/nodes/${nodeId}.json`
    const node = files.get(nested)
    assert.ok(node)
    files.set(`/dsh/home/auma/memory/dag/${nodeId}.json`, node)
    if (!duplicates) files.delete(nested)
    const read = fixtureReader(files)
    try {
      const phase = await untilPhase(read)
      assert.equal(phase.kind, 'snapshot')
      assert.equal(phase.snapshot.aura.status, duplicates ? 'incomplete' : 'calm')
    } finally { read.stop() }
  }
})

void test('exactly 256 referenced nodes fit the file and concurrency budgets', async () => {
  const { files, nodeId, seed } = await auraFiles()
  files.delete(`/dsh/home/auma/memory/dag/nodes/${nodeId}.json`)
  const ids: string[] = []
  const rows = [seed.line]
  let previous = seed.leaf
  for (let index = 0; index < 256; index++) {
    const body = { content: `fixture-${index}`, parentIds: [], receiptHash: seed.leaf }
    const id = sha256Hex(new TextEncoder().encode(canonicalJson(body)))
    assert.ok(id !== null)
    ids.push(id)
    files.set(`/dsh/home/auma/memory/dag/${id}.json`, { kind: 'ok', text: JSON.stringify({ ...body, id }) })
    const append = await receiptLine({ schema: 'aukora.receipt.v3', seq: index + 2, at: new Date(NOW).toISOString(), kind: 'memory.dag.append', prevHash: previous, data: { nodeId: id } })
    rows.push(append.line)
    previous = append.leaf
  }
  files.set(DAG_HEAD_PATH, { kind: 'ok', text: JSON.stringify({ count: ids.length, heads: ids }) })
  files.set(RECEIPTS_LOG_PATH, { kind: 'ok', text: rows.join('\n') + '\n' })
  let active = 0
  let peak = 0
  let calls = 0
  const read = fixtureReader(files, { readText: async (path) => {
    calls++
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    return files.get(path) ?? { kind: 'missing' }
  } })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.equal(phase.snapshot.aura.status, 'calm')
    assert.equal(calls, EVIDENCE_READ_LIMITS.files)
    assert.ok(peak <= EVIDENCE_READ_LIMITS.concurrency)
  } finally { read.stop() }
})

void test('forged manifest identifiers and unterminated journals remain incomplete', async () => {
  for (const path of [BALL_HEAD_PATH, RECEIPTS_LOG_PATH]) {
    const { files } = await auraFiles()
    const file = files.get(path)
    assert.ok(file?.kind === 'ok')
    if (path === BALL_HEAD_PATH) {
      const head = JSON.parse(file.text) as Record<string, unknown>
      files.set(path, { kind: 'ok', text: JSON.stringify({ ...head, modules: { bogus: {} } }) })
    } else files.set(path, { kind: 'ok', text: file.text.trimEnd() })
    const read = fixtureReader(files)
    try {
      const phase = await untilPhase(read)
      assert.equal(phase.kind, 'snapshot')
      assert.ok('auraStatus' in phase.snapshot.aura)
      assert.ok(phase.snapshot.pearl)
      assert.equal(phase.snapshot.aura.status, 'incomplete')
      assert.equal(phase.snapshot.aura.coherence, null)
      assert.equal(phase.snapshot.pearl.retentionPassed, null)
      assert.equal(phase.snapshot.pearl.status, 'incomplete')
    } finally { read.stop() }
  }
})

void test('discovery exports must contain every receipt-derived trajectory and stored scores are ignored', async () => {
  const { files, challengeData } = await auraFiles()
  const log = files.get(RECEIPTS_LOG_PATH)
  assert.ok(log?.kind === 'ok')
  const base = log.text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  let previous = String(base.at(-1)?.leafHash)
  for (const [kind, data] of [
    ['prediction.register', { predictionId: 'fixture-prediction', targetBallId: CHECKPOINT, targetEpoch: 5, metric: 'fixture', expected: 10 }],
    ['tree.patch', { ballId: CHECKPOINT, parentBallId: challengeData.ballId, epoch: 5 }],
    ['prediction.observe', { predictionId: 'fixture-prediction', targetBallId: CHECKPOINT, targetEpoch: 5, metric: 'fixture', observed: 20 }],
  ] as const) {
    const row = await receiptLine({ schema: 'aukora.receipt.v3', seq: base.length + 1, at: new Date(NOW).toISOString(), kind, prevHash: previous, data })
    base.push(JSON.parse(row.line) as Record<string, unknown>)
    previous = row.leaf
  }
  files.set(RECEIPTS_LOG_PATH, { kind: 'ok', text: base.map(row => JSON.stringify(row)).join('\n') + '\n' })
  const corpus = projectDiscoveryCorpus(base)
  assert.equal(corpus.records.length, 1)
  for (const exported of ['', discoveryJsonl(corpus).replace('"surpriseScore":1,', '"surpriseScore":999,')]) {
    files.set(DISCOVERY_FILE, { kind: 'ok', text: exported })
    // Absence of stored aura is a separate gap; here compare with the recomputed pressure.
    files.set(AURA_FILE, { kind: 'ok', text: JSON.stringify({ schema: 'aukora.aura.v1', scorer: 'rules-v1', authorityTier: 'peripheral-hint', ballId: challengeData.ballId, epoch: 4,
      vector: { coherence: 1, surprisePressure: Math.tanh(1 / 25), driftRisk: 0, wakeUrgency: Math.tanh(1 / 25) } }) })
    const read = fixtureReader(files)
    try {
      const phase = await untilPhase(read)
      assert.equal(phase.kind, 'snapshot')
      assert.ok('auraStatus' in phase.snapshot.aura)
      assert.equal(phase.snapshot.aura.status, exported === '' ? 'incomplete' : 'attentive')
      if (exported !== '') assert.equal(phase.snapshot.aura.surprisePressure, Math.tanh(1 / 25))
    } finally { read.stop() }
  }
})

void test('streamed host evidence is cancelled at its byte cap without buffering text()', async () => {
  const { files } = await auraFiles()
  let cancelled = false
  const read = createSuperagentRead({ now: () => NOW, fetch: scriptedFetch(call => call.name === 'seed_receipts' ? toolMissing(call.name)
    : toolOk(snapshot({ mandates: [], tickets: [], assignments: [], attention: [] }))).fetch,
  readText: path => Promise.resolve(files.get(path) ?? { kind: 'missing' }), hostFetch: () => Promise.resolve({ status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(EVIDENCE_READ_LIMITS.fileBytes + 1)) },
      cancel() { cancelled = true },
    }),
    text: () => Promise.reject(new Error('Streaming path must not call text()')),
  }) })
  try {
    const phase = await untilPhase(read)
    assert.equal(phase.kind, 'snapshot')
    assert.equal(phase.snapshot.aura.status, 'incomplete')
    assert.equal(cancelled, true)
  } finally { read.stop() }
})

void test('synchronous stop prevents deferred external read callbacks from starting', async () => {
  let calls = 0
  const read = createSuperagentRead({ fetch: () => { calls++; return Promise.resolve(toolMissing('fixture')) },
    readText: () => { calls++; return Promise.resolve({ kind: 'missing' }) }, readWake: () => { calls++; return Promise.resolve(null) } })
  read.stop()
  await settled()
  assert.equal(calls, 0)
  assert.equal(read.current().kind, 'stopped')
})

test('an organ status wrapper is read without treating tool ok as consent', () => {
  const raw = {
    output: JSON.stringify({
      ok: true,
      schema: STATUS_SCHEMA,
      observedAt: '2026-11-08T00:00:00.000Z',
      survivedRestart: true,
      mandates: [{ id: 'mandate-1', title: 'Deploy', strength: 'inferred', policyVersion: 'x6.1/v1', scope: { paths: ['deploy/cloudflare/**'] }, expiry: null, confirmed: true, confirmedBy: 'owner', receiptHash: 'ab'.repeat(32) }],
      tickets: [{ id: 'ticket-1', title: 'Deploy', state: 'open', mandateId: 'mandate-1' }],
      assignments: [{ id: 'assignment-1', ticketId: 'ticket-1', state: 'running', executor: 'cloudflare-do', lastReport: 'blocked', startedAt: NOW }],
      attention: [{ id: 'attention-1', kind: 'inferred-mandate-confirmation', detail: { mandateId: 'mandate-1', title: 'Deploy' } }],
    }),
  }
  assert.equal(classifyToolBody(200, JSON.stringify({ ok: true, raw })).kind, 'ok')
  const body = classifyToolBody(200, JSON.stringify({ ok: true, raw }))
  assert.equal(body.kind, 'ok')
  if (body.kind !== 'ok') return
  const parsed = parseStatus(body.value, 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.snapshot.mandates[0]?.authority.level, 'unknown')
  assert.equal(parsed.snapshot.attention[0]?.text.includes('Deploy'), true)
  assert.equal(parsed.snapshot.assignments[0]?.state, 'running')
})

test('scope limits refuse negative zero and non-finite counts before canonical JSON', () => {
  assert.equal(scopeLimitSound({ maxSteps: 3, maxMutations: 0 }), true)
  assert.equal(scopeLimitSound({ maxSteps: -0 }), false)
  assert.equal(scopeLimitSound({ maxMutations: Number.POSITIVE_INFINITY }), false)
  assert.equal(scopeLimitSound({ nested: { maxSteps: Number.NaN } }), false)
  assert.equal(JSON.stringify({ maxSteps: -0 }), '{"maxSteps":0}')
  const parsed = parseStatus(snapshot({
    mandates: [{
      id: 'mandate-1', strength: 'explicit', policyVersion: 'policy-7',
      scope: { maxSteps: -0, paths: ['safe'] }, expiry: null,
    }],
  }), 'auma_superagent', NOW)
  assert.equal(parsed.ok, false)
})

test('prediction receipts are verified only in register, promotion, observation order', async () => {
  const target = 'ab'.repeat(32)
  const parent = 'cd'.repeat(32)
  const live = readFileSync('mirror/home/auma/seed/receipts.v3.jsonl', 'utf8')
  const absent = assessPredictions([])
  assert.equal(absent.status, 'absent')
  assert.equal(absent.surpriseScore, null)
  // The committed log now carries anchored predictions; each of its observations must be in a verified trajectory.
  const liveRows = live.trim().split('\n').map(line => JSON.parse(line) as unknown)
  const liveObservations = liveRows.filter(row => typeof row === 'object' && row !== null && (row as { kind?: unknown }).kind === 'prediction.observe')
  assert.ok(liveObservations.length > 0)
  assert.equal(projectDiscoveryCorpus(liveRows).records.length, liveObservations.length)
  const register = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-08T00:00:00.000Z', kind: 'prediction.register', prevHash: '0'.repeat(64),
    data: { predictionId: 'pred-1', targetBallId: target, targetEpoch: 143, metric: 'organs', expected: 4 },
  })
  const promotion = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 2, at: '2026-11-08T00:00:01.000Z', kind: 'ball.promote', prevHash: register.leaf,
    data: { ballId: target, parentBallId: parent, epoch: 143 },
  })
  const observe = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 3, at: '2026-11-08T00:00:02.000Z', kind: 'prediction.observe', prevHash: promotion.leaf,
    data: { predictionId: 'pred-1', targetBallId: target, targetEpoch: 143, metric: 'organs', observed: 6, surpriseScore: 0 },
  })
  const chain = [register, promotion, observe].map((item, index) => ({
    seq: index + 1, kind: index === 0 ? 'prediction.register' : index === 1 ? 'ball.promote' : 'prediction.observe',
    intact: true, data: JSON.parse(item.line).data as Record<string, unknown>,
  }))
  const scored = assessPredictions(chain)
  assert.equal(scored.status, 'rejected')
  assert.equal(scored.reason, 'prediction-score-untrusted')
  assert.equal(scored.surpriseScore, null)
  const clean = await receiptLine({
    schema: 'aukora.receipt.v3', seq: 3, at: '2026-11-08T00:00:02.000Z', kind: 'prediction.observe', prevHash: promotion.leaf,
    data: { predictionId: 'pred-1', targetBallId: target, targetEpoch: 143, metric: 'organs', observed: 6 },
  })
  const verified = assessPredictions([
    { seq: 1, kind: 'prediction.register', intact: true, data: JSON.parse(register.line).data as Record<string, unknown> },
    { seq: 2, kind: 'ball.promote', intact: true, data: JSON.parse(promotion.line).data as Record<string, unknown> },
    { seq: 3, kind: 'prediction.observe', intact: true, data: JSON.parse(clean.line).data as Record<string, unknown> },
  ])
  assert.equal(verified.status, 'verified')
  assert.equal(verified.surpriseScore, 0.5)
  const early = assessPredictions([
    { seq: 1, kind: 'ball.promote', intact: true, data: JSON.parse(promotion.line).data as Record<string, unknown> },
    { seq: 2, kind: 'prediction.register', intact: true, data: JSON.parse(register.line).data as Record<string, unknown> },
    { seq: 3, kind: 'prediction.observe', intact: true, data: JSON.parse(clean.line).data as Record<string, unknown> },
  ])
  assert.equal(early.reason, 'prediction-order')
  const parsed = parseStatus(snapshot(), 'auma_superagent', NOW)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.snapshot.mandates[0]?.pearlId, parsed.snapshot.mandates[0]?.ballId)
  assert.equal(parsed.snapshot.mandates[0]?.authority.pearlLineage, parsed.snapshot.mandates[0]?.authority.lineage)
  assert.equal(parsed.snapshot.mandates[0]?.authority.passkeyVerified, false)
  assert.equal(parsed.snapshot.mandates[0]?.authority.credentialId, null)
  assert.equal(parsed.snapshot.mandates[0]?.authority.aumlokBinding, 'unknown')
  const text = paintLines({ kind: 'snapshot', snapshot: parsed.snapshot, receipts: { kind: 'idle' }, empty: false, refreshing: false }, 'world')
    .map(line => line.text).join('\n')
  assert.equal(text.includes(phrase('prediction.absent')), true)
  assert.equal(text.includes(phrase('head.ball')), true)
})

test('the readout source does not open a session or parse HTML', () => {
  for (const file of readdirSync(new URL('.', import.meta.url))) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.equal(source.includes('innerHTML'), false, file)
    assert.equal(source.includes('insertAdjacentHTML'), false, file)
    assert.equal(/connectWorkerHost\s*\(/.test(source), false, file)
    assert.equal(/new Worker\s*\(/.test(source), false, file)
    assert.equal(source.includes('dangerouslySetInnerHTML'), false, file)
  }
})

class FakeNode implements ReadoutNode {
  readonly children: FakeNode[] = []
  textContent = ''
  readonly tag: string
  private readonly attrs = new Map<string, string>()
  private readonly clicks: Array<() => void> = []
  private readonly all: FakeNode[]

  constructor(tag: string, all: FakeNode[]) {
    this.tag = tag
    this.all = all
    all.push(this)
  }

  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  append(...nodes: ReadoutNode[]): void { this.children.push(...nodes as FakeNode[]) }
  addEventListener(_type: 'click', listener: () => void): void { this.clicks.push(listener) }
  replaceChildren(...nodes: ReadoutNode[]): void {
    this.children.splice(0, this.children.length, ...nodes as FakeNode[])
  }
  remove(): void {
    for (const node of this.all) {
      const index = node.children.indexOf(this)
      if (index >= 0) node.children.splice(index, 1)
    }
  }
  dispatch(): void { for (const click of this.clicks) click() }
  texts(): string[] {
    return [this.textContent, ...this.children.flatMap(child => child.texts())].filter(text => text.length > 0)
  }
}
