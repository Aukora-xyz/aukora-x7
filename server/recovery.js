const status = document.querySelector('#status')
const select = document.querySelector('#target')
const review = document.querySelector('#review')
const previewButton = document.querySelector('#preview')
const restoreButton = document.querySelector('#restore')
const pendingKey = 'x61:recovery-pending:v1'
let proposal = null
let pending = null
let busy = false
let viewGeneration = 0
let historyGeneration = 0
async function refreshHistory() {
  const generation = ++historyGeneration
  const output = document.querySelector('#memory-history-status')
  output.textContent = 'Checking local recovery copies…'
  try {
    const response = await fetch('/_mirror/memory-history', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok || result.ok !== true || result.automaticRestore !== false || !Array.isArray(result.stores) || result.stores.length !== 2) throw new Error('Local recovery-copy verification is unavailable')
    const stores = ['v1', 'v2'].map(name => {
      const store = result.stores.find(item => item?.store === name)
      if (!store || !Number.isSafeInteger(store.versions) || store.versions < 0 || !Number.isSafeInteger(store.bytes) || store.bytes < 0) throw new Error('Local recovery-copy status is invalid')
      return name + ': ' + store.versions.toLocaleString() + ' retained version(s), ' + store.bytes.toLocaleString() + ' bytes'
    })
    if (generation === historyGeneration) output.textContent = 'Verified local copies. ' + stores.join('. ') + '. No automatic restore or pruning.'
  } catch (error) {
    if (generation === historyGeneration) output.textContent = 'Recovery copies could not be verified: ' + error.message + '. Do not assume this safeguard is available.'
  }
}
let assetGeneration = 0
async function refreshAssets() {
  const generation = ++assetGeneration
  const output = document.querySelector('#asset-retention-status')
  output.textContent = 'Checking retained build assets…'
  try {
    const response = await fetch('/_host/runtime-assets', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok || result.ok !== true) throw new Error(result.error || 'Retention is not verified')
    if (!Number.isSafeInteger(result.files) || result.files < 0 || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || !Number.isSafeInteger(result.maxBytes) || result.maxBytes < 1 || !Number.isSafeInteger(result.capturedAt) || result.capturedAt < 0 || result.automaticRuntimeRestore !== false) throw new Error('Retention status is invalid')
    if (generation === assetGeneration) output.textContent = 'Last full verification: ' + new Date(result.capturedAt).toLocaleString() + '. ' + result.files.toLocaleString() + ' named assets. Payload bytes: ' + result.bytes.toLocaleString() + ' of ' + result.maxBytes.toLocaleString() + '. No automatic pruning or runtime selection.' + (result.previewBootBlocked === true ? ' Preview build state is ' + result.buildPhase + '; new boots wait. Inspect an interrupted producer before clearing its lock.' : '')
  } catch (error) {
    if (generation === assetGeneration) output.textContent = 'Asset retention is degraded or unverified: ' + error.message + '. Do not assume older assets are available.'
  }
}
let runtimeGeneration = 0
let runtimePending = null
let runtimeProposal = null
let runtimeBusy = false
const runtimePendingKey = 'x61:runtime-selection-pending:v1'
function validRuntimeSelection(value) {
  return value && Number.isSafeInteger(value.epoch) && value.epoch >= 0 && (value.epoch === 0 ? value.recordId === null && value.releaseId === null : isSha(value.recordId) && isSha(value.releaseId))
}
function readRuntimePending() {
  const text = sessionStorage.getItem(runtimePendingKey)
  if (!text) return null
  const value = JSON.parse(text)
  if (!value || !isSha(value.releaseId) || typeof value.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operationId) || !Number.isSafeInteger(value.expectedEpoch) || value.expectedEpoch < 0 || value.expectedEpoch >= Number.MAX_SAFE_INTEGER || (value.expectedEpoch === 0 ? value.expectedRecordId !== null : !isSha(value.expectedRecordId))) throw new Error('Retained runtime request is invalid; no new selection was sent')
  return value
}
function reviewRuntime(value, retry = false) {
  runtimeProposal = value
  document.querySelector('#runtime-selection-review').hidden = false
  document.querySelector('#runtime-selection-details').textContent = 'Target static closure: ' + value.releaseId + '\nExpected selected epoch: ' + value.expectedEpoch + '\nExpected selected record: ' + (value.expectedRecordId || 'empty genesis') + '\nExact operation: ' + value.operationId + '\nPrivate state is not restored. Selection acknowledgement will not prove a worker booted.'
  const button = document.querySelector('#runtime-select')
  button.textContent = retry ? 'Retry original runtime request' : 'Select for future main boots'
  button.disabled = runtimeBusy
}
async function refreshRuntimeCandidates() {
  const generation = ++runtimeGeneration
  const output = document.querySelector('#runtime-candidates')
  const stateText = document.querySelector('#runtime-selection-status')
  try {
    const response = await fetch('/_head/runtime', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok || result.ok !== true || typeof result.selectionAvailable !== 'boolean' || result.candidateIsLive !== true || result.selectionIsNotHealthProof !== true || !Array.isArray(result.candidates)) throw new Error('Runtime candidates are unavailable')
    if (generation !== runtimeGeneration || runtimeBusy) return
    runtimePending = readRuntimePending()
    // Matching HEAD proves selection, but blocked write authority can still need this exact retry to finish cleanup.
    if (runtimePending && result.selectionAvailable && validRuntimeSelection(result.selected) && result.selected?.operationId === runtimePending.operationId && result.selected.releaseId === runtimePending.releaseId && result.selected.epoch === runtimePending.expectedEpoch + 1 && result.selected.parentRecordId === runtimePending.expectedRecordId) { sessionStorage.removeItem(runtimePendingKey); runtimePending = null }
    const selectable = result.selectionAvailable && validRuntimeSelection(result.selected) && result.selected.epoch < Number.MAX_SAFE_INTEGER
    const items = result.candidates.map(candidate => {
      if (!isSha(candidate.releaseId) || !Number.isSafeInteger(candidate.files) || candidate.files < 1 || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || candidate.storageProtocol !== 2) throw new Error('Invalid runtime candidate metadata')
      const item = document.createElement('li')
      item.append(candidate.releaseId.slice(0, 20) + ' · ' + candidate.files.toLocaleString() + ' files · ' + candidate.bytes.toLocaleString() + ' bytes. ' + (candidate.releaseId === result.latestCapturedRelease ? 'Latest captured build. ' : ''))
      const link = document.createElement('a'); link.href = '/?runtime_candidate=' + candidate.releaseId; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open live candidate'
      const choose = document.createElement('button'); choose.textContent = 'Review main selection'; choose.disabled = !selectable || Boolean(runtimePending) || runtimeBusy || result.selected?.releaseId === candidate.releaseId
      choose.addEventListener('click', () => { if (!runtimePending && !runtimeBusy) reviewRuntime({ operationId: crypto.randomUUID(), releaseId: candidate.releaseId, expectedRecordId: result.selected.recordId, expectedEpoch: result.selected.epoch }) })
      item.append(link, choose); return item
    })
    if (!items.length) { const item = document.createElement('li'); item.textContent = 'No complete compatible runtime closure has been captured yet.'; items.push(item) }
    if (generation !== runtimeGeneration) return
    output.replaceChildren(...items)
    if (runtimePending) {
      reviewRuntime(runtimePending, true)
      stateText.textContent = 'An earlier selection still needs reconciliation or cleanup. Its exact original request is retained, even if matching selected HEAD is visible. Retry never substitutes a new parent.'
    }
    else {
      runtimeProposal = null; document.querySelector('#runtime-selection-review').hidden = true
      const readable = validRuntimeSelection(result.selected)
      stateText.textContent = readable ? 'Selected runtime epoch ' + result.selected.epoch + ': ' + (result.selected.releaseId || 'current mutable build, not yet pinned') + '. This is selection, not boot or health evidence.' + (selectable ? '' : ' New selections are blocked: ' + (result.selectionError || 'write authority unavailable') + '. Intact candidate links remain live.') : 'Runtime selection is unavailable: ' + (result.selectionError || 'invalid authority state') + '. Intact candidate links remain live.'
    }
  } catch (error) {
    if (generation === runtimeGeneration) { stateText.textContent = 'Could not read runtime selection: ' + error.message; const item = document.createElement('li'); item.textContent = 'No new selection is permitted until this is resolved.'; output.replaceChildren(item) }
  }
}
document.querySelector('#runtime-select').addEventListener('click', async () => {
  if (runtimeBusy || (!runtimePending && !runtimeProposal)) return
  runtimeBusy = true; runtimeGeneration += 1; document.querySelector('#runtime-select').disabled = true
  const stateText = document.querySelector('#runtime-selection-status')
  let sent = false
  try {
    if (!runtimePending) { sessionStorage.setItem(runtimePendingKey, JSON.stringify(runtimeProposal)); runtimePending = runtimeProposal }
    const submitted = { ...runtimePending }
    reviewRuntime(submitted, true)
    sent = true
    const response = await fetch('/_head/runtime', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submitted), signal: AbortSignal.timeout(45000) })
    const result = await response.json()
    if (!response.ok || result.ok !== true) {
      if (result.notApplied === true) { sessionStorage.removeItem(runtimePendingKey); runtimePending = null; runtimeProposal = null; document.querySelector('#runtime-selection-review').hidden = true; throw new Error((result.code || 'Selection refused') + '. Confirmed not applied; refresh and review current authority.') }
      throw new Error(result.code || result.error || 'Runtime selection unconfirmed')
    }
    if (result.operationId !== submitted.operationId || result.releaseId !== submitted.releaseId || result.epoch !== submitted.expectedEpoch + 1 || !isSha(result.recordId) || result.booted !== false) throw new Error('Runtime acknowledgement does not match the retained request')
    sessionStorage.removeItem(runtimePendingKey); runtimePending = null; runtimeProposal = null; document.querySelector('#runtime-selection-review').hidden = true
    stateText.textContent = 'Host acknowledged runtime epoch ' + result.epoch + ', closure ' + result.releaseId + '. Current selected epoch: ' + result.selected.epoch + '. Open a new main tab to verify boot. Active workers and private state were not restored.'
  } catch (error) { stateText.textContent = (sent ? 'Runtime request: ' : 'Runtime selection was not sent: ') + error.message + (runtimePending ? '. Exact retry intent remains retained across reload.' : '') }
  finally { runtimeBusy = false; document.querySelector('#runtime-select').disabled = false }
})
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function readPending() {
  const raw = sessionStorage.getItem(pendingKey)
  if (!raw) return null
  const value = JSON.parse(raw)
  if (!value || !isSha(value.targetBallId) || !isSha(value.expectedParentBallId) || !isSha(value.expectedResultBallId) || !Number.isSafeInteger(value.expectedEpoch) || value.expectedEpoch < 0) throw new Error('Retained recovery request is invalid; no restore was sent')
  return value
}
function showPending() {
  select.disabled = true; previewButton.disabled = true; review.hidden = false
  restoreButton.textContent = 'Retry original request'
  document.querySelector('#details').textContent = 'Retained request target: ' + pending.targetBallId + '\nOriginal expected parent: ' + pending.expectedParentBallId + '\nOriginal expected epoch: ' + pending.expectedEpoch + '\nExpected result: ' + pending.expectedResultBallId
}
async function request(body, target) {
  const response = await fetch('/_head/recovery' + (target ? '?targetBallId=' + encodeURIComponent(target) : ''), { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) })
  const result = await response.json()
  if (!response.ok || result.ok !== true) {
    const error = new Error(result.code || result.error || 'Recovery request failed')
    error.notApplied = result.notApplied === true
    throw error
  }
  return result
}
async function refresh() {
  if (busy) return
  const generation = ++viewGeneration
  proposal = null; review.hidden = true; previewButton.disabled = true
  try {
    pending = readPending()
    const state = await request()
    if (generation !== viewGeneration) return
    select.replaceChildren(new Option('Choose a retained body', ''))
    for (const candidate of state.candidates) if (candidate.ballId !== state.selected?.ballId) select.add(new Option('Epoch ' + candidate.epoch + ' · ' + candidate.enabled + '/' + candidate.entries + ' enabled · ' + candidate.ballId.slice(0, 20), candidate.ballId))
    if (pending && state.selected?.ballId === pending.expectedResultBallId) { sessionStorage.removeItem(pendingKey); pending = null }
    if (pending) {
      showPending()
      status.textContent = 'An earlier recovery has no confirmed outcome. Retry only its retained original request; the host checks the selected parent chain and cannot create a second epoch from a changed parent.'
    } else {
      restoreButton.textContent = 'Select retained body'
      status.textContent = state.selected ? 'Selected epoch ' + state.selected.epoch + ', body ' + state.selected.ballId + (state.lease ? '. A writer lease is active until ' + new Date(state.lease.expiresAt).toLocaleTimeString() + '.' : '. No active writer lease.') : 'Selected HEAD is missing. Automatic recovery is blocked to avoid rewinding epoch history; operator recovery is required.'
      select.disabled = !state.selected
    }
  } catch (error) { status.textContent = 'Could not read recovery state: ' + error.message; select.disabled = true }
}
select.addEventListener('change', () => { viewGeneration += 1; proposal = null; review.hidden = true; previewButton.disabled = !select.value || Boolean(pending) })
document.querySelector('#refresh').addEventListener('click', () => { void refresh(); void refreshHistory(); void refreshAssets(); void refreshRuntimeCandidates() })
previewButton.addEventListener('click', async () => {
  const generation = ++viewGeneration
  const target = select.value
  try {
    const result = await request(undefined, target)
    if (generation !== viewGeneration || target !== select.value || busy || pending) return
    proposal = result
    restoreButton.disabled = Boolean(proposal.compatibility?.blocked)
    document.querySelector('#details').textContent = 'Target: ' + proposal.target.ballId + '\nExpected current: ' + proposal.expectedParentBallId + '\nNew epoch: ' + (proposal.expectedEpoch + 1) + '\nChanged: ' + (proposal.changes.changed.join(', ') || 'none') + '\nAdded: ' + (proposal.changes.added.join(', ') || 'none') + '\nRemoved: ' + (proposal.changes.removed.join(', ') || 'none') + '\nEnabled target entries: ' + proposal.target.enabled + (proposal.compatibility?.blocked ? '\nBLOCKED: protected state organ changed: ' + proposal.compatibility.protectedStateOrgansChanged.join(', ') + '. Explicit state migration is required.' : '')
    review.hidden = false
  } catch (error) { proposal = null; review.hidden = true; status.textContent = 'Review failed: ' + error.message }
})
async function refreshAfterRefusal(message) {
  busy = false
  await refresh()
  status.textContent = 'Recovery was not applied: ' + message + '. Review the refreshed current state before a new operation.'
}
restoreButton.addEventListener('click', async () => {
  if (busy || (!proposal && !pending)) return
  busy = true; viewGeneration += 1; restoreButton.disabled = true; previewButton.disabled = true
  let sent = false
  try {
    if (!pending) {
      const original = { targetBallId: proposal.target.ballId, expectedParentBallId: proposal.expectedParentBallId, expectedEpoch: proposal.expectedEpoch, expectedResultBallId: proposal.candidateBallId }
      sessionStorage.setItem(pendingKey, JSON.stringify(original))
      pending = original
    }
    showPending()
    sent = true
    const result = await request({ targetBallId: pending.targetBallId, expectedParentBallId: pending.expectedParentBallId, expectedEpoch: pending.expectedEpoch })
    sessionStorage.removeItem(pendingKey); pending = null; proposal = null; review.hidden = true
    status.textContent = 'Host acknowledged recovery epoch ' + result.epoch + ', body ' + result.ballId + '. Current selected body: ' + (result.selectedBallId || result.ballId) + '. Open Auma in a new tab to verify activation. This is selection acknowledgement, not proof that a worker booted.'
  } catch (error) {
    if (error.notApplied === true) {
      try {
        sessionStorage.removeItem(pendingKey); pending = null; proposal = null; review.hidden = true
        await refreshAfterRefusal(error.message)
      } catch (storageError) { status.textContent = 'Not applied, but retry record could not be cleared: ' + storageError.message }
    } else {
      if (pending) showPending()
      status.textContent = sent ? 'Recovery has no success acknowledgement: ' + error.message + '. The exact original request is retained across reload. Retry it to reconcile; a new parent will not be substituted.' : 'Recovery was not sent because its retry record could not be saved: ' + error.message
    }
  } finally { busy = false; restoreButton.disabled = false }
})
void refresh()
void refreshHistory()
void refreshAssets()
void refreshRuntimeCandidates()
