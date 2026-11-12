/**
 * Turn one readout phase into text lines for a room.
 * Every line is plain text. The view assigns it with `textContent`.
 */
import type { AttentionView, AssignmentView, HeartbeatView, MandateView, ReceiptRead, StatusFailure, StatusSnapshot, SuperagentPhase, TicketView } from './contract.ts'
import { phrase } from './phrases.ts'

/** One painted line. `text` is either locale copy or untrusted payload text. */
export interface PaintedLine {
  role: 'note' | 'state' | 'heading' | 'item'
  text: string
}

export type SuperagentRoom = 'world' | 'self'

/**
 * Build the lines for one room.
 * @param phase - Current readout phase.
 * @param room - World shows the work graph. Self shows mandates and authority.
 * @returns Lines in paint order. No HTML.
 */
export function paintLines(phase: SuperagentPhase, room: SuperagentRoom): PaintedLine[] {
  const lines: PaintedLine[] = [
    { role: 'note', text: phrase('note.authority') },
    { role: 'note', text: phrase('integration.unverified') },
    { role: 'state', text: stateSentence(phase) },
  ]
  if (phase.kind !== 'stopped' && phase.kind !== 'loading' && phase.refreshing) {
    lines.push({ role: 'state', text: phrase('state.refreshing') })
  }
  if (phase.kind === 'failure') pushFailure(lines, phase.failure)
  if (phase.kind === 'stale-snapshot' && phase.failure) pushFailure(lines, phase.failure)
  if (phase.kind === 'failure' || phase.kind === 'snapshot' || phase.kind === 'stale-snapshot') {
    pushReceipts(lines, phase.receipts)
  }
  if (phase.kind === 'snapshot' || phase.kind === 'stale-snapshot') pushSnapshot(lines, phase.snapshot, room)
  return lines
}

/**
 * Whether the room offers another read.
 * @param phase - Current phase.
 * @returns False after `stop`.
 */
export function showRefresh(phase: SuperagentPhase): boolean {
  return phase.kind !== 'stopped'
}

function pushSnapshot(lines: PaintedLine[], snapshot: StatusSnapshot, room: SuperagentRoom): void {
  lines.push({ role: 'heading', text: room === 'world' ? phrase('room.world') : phrase('room.self') })
  lines.push({ role: 'item', text: `${phrase('field.tool')} ${snapshot.toolName}` })
  lines.push({ role: 'item', text: `${phrase('field.observed')} ${snapshot.observedAt}` })
  lines.push({ role: 'item', text: restartSentence(snapshot.survivedRestart) })
  lines.push({ role: 'item', text: phrase('heartbeat.notWork') })
  lines.push({ role: 'item', text: phrase('authority.gap') })
  pushDag(lines, snapshot)
  pushPredictions(lines, snapshot)
  pushHead(lines, snapshot)
  if (snapshot.heartbeatBounded) lines.push({ role: 'item', text: phrase('heartbeat.bounded') })
  pushTickets(lines, snapshot.tickets)
  pushAssignments(lines, snapshot.assignments)
  pushMandates(lines, snapshot.mandates)
  pushAttention(lines, snapshot.attention)
}

function pushTickets(lines: PaintedLine[], tickets: readonly TicketView[]): void {
  lines.push({ role: 'heading', text: phrase('heading.tickets') })
  if (tickets.length === 0) {
    lines.push({ role: 'item', text: phrase('empty.tickets') })
    return
  }
  for (const ticket of tickets) {
    lines.push({ role: 'item', text: ticket.title })
    lines.push({ role: 'item', text: `${phrase('field.ticket')} ${ticket.id}` })
    lines.push({ role: 'item', text: ticket.state === 'open' ? phrase('ticket.open') : phrase('ticket.ended') })
    if (ticket.state === 'ended') {
      lines.push({ role: 'item', text: `${phrase('field.outcome')} ${ticket.outcome === null ? phrase('outcome.absent') : outcomeSentence(ticket.outcome)}` })
    }
    if (ticket.mandateId !== null) lines.push({ role: 'item', text: `${phrase('heading.mandates')} ${ticket.mandateId}` })
  }
}

function pushAssignments(lines: PaintedLine[], assignments: readonly AssignmentView[]): void {
  lines.push({ role: 'heading', text: phrase('heading.assignments') })
  if (assignments.length === 0) {
    lines.push({ role: 'item', text: phrase('empty.assignments') })
    return
  }
  for (const assignment of assignments) {
    lines.push({ role: 'item', text: assignment.id })
    lines.push({ role: 'item', text: `${phrase('field.ticket')} ${assignment.ticketId}` })
    lines.push({ role: 'item', text: assignmentSentence(assignment.state) })
    lines.push({ role: 'item', text: executorSentence(assignment.executor) })
    lines.push({ role: 'item', text: heartbeatSentence(assignment.heartbeat.availability) })
    lines.push({ role: 'item', text: restartSentence(assignment.survivedRestart) })
    if (assignment.report) {
      lines.push({ role: 'item', text: `${phrase('field.report')} ${reportSentence(assignment.report.state)}` })
      lines.push({ role: 'item', text: assignment.report.summary.length > 0 ? assignment.report.summary : phrase('attention.noSummary') })
    }
  }
}

function pushMandates(lines: PaintedLine[], mandates: readonly MandateView[]): void {
  lines.push({ role: 'heading', text: phrase('heading.mandates') })
  if (mandates.length === 0) {
    lines.push({ role: 'item', text: phrase('empty.mandates') })
    return
  }
  for (const mandate of mandates) {
    lines.push({ role: 'item', text: mandate.id })
    lines.push({ role: 'item', text: `${phrase('field.strength')} ${mandate.strength === 'explicit' ? phrase('strength.explicit') : phrase('strength.inferred')}` })
    lines.push({ role: 'item', text: `${phrase('field.policy')} ${mandate.policyVersion}` })
    lines.push({ role: 'item', text: `${phrase('field.expiry')} ${mandate.expiry ?? phrase('expiry.absent')}` })
    lines.push({ role: 'item', text: `${phrase('field.scope')} ${mandate.scope}` })
    lines.push({ role: 'item', text: authoritySentence(mandate.authority.level) })
    lines.push({ role: 'item', text: identityLine(mandate.authority) })
    if (mandate.authority.identitySource !== 'absent') {
      lines.push({ role: 'item', text: identitySourceLine(mandate.authority.identitySource) })
    }
    lines.push({ role: 'item', text: phrase('identity.notPasskey') })
    const lineageText = lineageSentence(mandate.authority.lineage)
    if (lineageText !== null) lines.push({ role: 'item', text: lineageText })
    if (mandate.authority.reasons.includes('promote-epoch-mismatch')) {
      lines.push({ role: 'item', text: phrase('lineage.promoteEpoch') })
    }
    if (mandate.authority.reasons.includes('promote-fork')) {
      lines.push({ role: 'item', text: phrase('lineage.fork') })
    }
    if (mandate.authority.reasons.includes('presence-flag-ignored')) {
      lines.push({ role: 'item', text: phrase('presence.ignored') })
    }
    if (mandate.authority.reasons.includes('non-grant-receipt-ignored')) {
      lines.push({ role: 'item', text: phrase('authority.nonGrantHash') })
    } else if (mandate.receiptLeafHash !== null) lines.push({ role: 'item', text: mandate.receiptLeafHash })
  }
}

function pushPredictions(lines: PaintedLine[], snapshot: StatusSnapshot): void {
  const prediction = snapshot.predictions
  if (prediction.status === 'verified' && prediction.surpriseScore !== null) {
    lines.push({ role: 'item', text: `${phrase('prediction.verified')} ${String(prediction.surpriseScore)}` })
    return
  }
  if (prediction.status === 'rejected') {
    lines.push({ role: 'item', text: `${phrase('prediction.rejected')} ${prediction.reason}` })
    return
  }
  lines.push({ role: 'item', text: phrase('prediction.absent') })
}

function pushDag(lines: PaintedLine[], snapshot: StatusSnapshot): void {
  lines.push({ role: 'heading', text: phrase('dag.head') })
  const dag = snapshot.dag
  if (dag.kind === 'summary') {
    lines.push({ role: 'item', text: `${phrase('dag.head')} ${dag.headId ?? phrase('dag.absent')}` })
    lines.push({ role: 'item', text: `${phrase('dag.nodes')} ${dag.totalNodes === null ? phrase('dag.absent') : String(dag.totalNodes)}` })
    lines.push({ role: 'item', text: `${phrase('dag.updated')} ${dag.updatedAt ?? phrase('dag.absent')}` })
    lines.push({ role: 'item', text: phrase('dag.notAncestry') })
    return
  }
  lines.push({ role: 'item', text: dag.kind === 'missing' ? phrase('dag.missing') : dag.kind === 'malformed' ? phrase('dag.malformed') : phrase('dag.unavailable') })
}

function pushHead(lines: PaintedLine[], snapshot: StatusSnapshot): void {
  const head = snapshot.head
  if (head.kind === 'summary') {
    lines.push({ role: 'item', text: `${phrase('head.ball')} ${head.ballId}` })
    lines.push({ role: 'item', text: `${phrase('head.epoch')} ${String(head.epoch)}` })
    return
  }
  lines.push({ role: 'item', text: head.kind === 'missing' ? phrase('head.missing') : head.kind === 'malformed' ? phrase('head.malformed') : phrase('head.unavailable') })
}

function pushAttention(lines: PaintedLine[], attention: readonly AttentionView[]): void {
  lines.push({ role: 'heading', text: phrase('heading.attention') })
  if (attention.length === 0) {
    lines.push({ role: 'item', text: phrase('empty.attention') })
    return
  }
  for (const item of attention) {
    lines.push({ role: 'item', text: attentionSentence(item.kind) })
    if (item.source === 'assignment-report') lines.push({ role: 'item', text: phrase('attention.fromReport') })
    if (item.source === 'heartbeat') lines.push({ role: 'item', text: phrase('attention.heartbeatSource') })
    lines.push({ role: 'item', text: item.text.length > 0 ? item.text : phrase('attention.noSummary') })
  }
}

function pushReceipts(lines: PaintedLine[], receipts: ReceiptRead): void {
  lines.push({ role: 'heading', text: phrase('heading.receipts') })
  if (receipts.kind === 'verified') {
    lines.push({ role: 'item', text: phrase('receipt.verifiedRoot') })
    lines.push({ role: 'item', text: receipts.merkleRoot })
    if (receipts.checkpointHash === null) lines.push({ role: 'item', text: phrase('receipt.noCheckpoint') })
    else {
      lines.push({ role: 'item', text: phrase('receipt.checkpoint') })
      lines.push({ role: 'item', text: receipts.checkpointHash })
    }
    if (receipts.receiptsVerified !== null) lines.push({ role: 'item', text: `${phrase('receipt.count')} ${String(receipts.receiptsVerified)}` })
    if (receipts.checkpointsVerified !== null) lines.push({ role: 'item', text: `${phrase('receipt.checkpoints')} ${String(receipts.checkpointsVerified)}` })
    return
  }
  lines.push({ role: 'item', text: receiptSentence(receipts) })
  if (receipts.kind === 'rejected' && receipts.stage !== null) {
    lines.push({ role: 'item', text: `${phrase('receipt.stage')} ${receipts.stage}${receipts.error ? ` (${receipts.error})` : ''}` })
  }
  if ((receipts.kind === 'transport' || receipts.kind === 'refused') && receipts.detail !== null) {
    lines.push({ role: 'item', text: phrase('detail.server') })
    lines.push({ role: 'item', text: receipts.detail })
    if (receipts.truncated) lines.push({ role: 'item', text: phrase('detail.truncated') })
  }
}

function pushFailure(lines: PaintedLine[], failure: StatusFailure): void {
  if ((failure.kind === 'transport' || failure.kind === 'refused') && failure.detail !== null) {
    lines.push({ role: 'item', text: phrase('detail.server') })
    lines.push({ role: 'item', text: failure.detail })
    if (failure.truncated) lines.push({ role: 'item', text: phrase('detail.truncated') })
  }
}

function stateSentence(phase: SuperagentPhase): string {
  if (phase.kind === 'loading') return phrase('state.loading')
  if (phase.kind === 'stopped') return phrase('state.stopped')
  if (phase.kind === 'snapshot') return phase.empty ? phrase('state.empty') : phrase('state.ready')
  if (phase.kind === 'stale-snapshot') {
    if (phase.failure) return phrase('state.refreshFailed')
    return phrase('state.aged')
  }
  return failureSentence(phase.failure)
}

function failureSentence(failure: StatusFailure): string {
  switch (failure.kind) {
    case 'host-unavailable': return phrase('state.host')
    case 'control-unavailable': return phrase('state.control')
    case 'backend-missing': return phrase('state.missing')
    case 'schema': return phrase('state.schema')
    case 'bound': return phrase('state.bound')
    case 'time': return phrase('state.time')
    case 'timeout': return phrase('state.timeout')
    case 'transport': return phrase('state.transport')
    case 'refused': return phrase('state.refused')
    case 'unreadable': return phrase('state.unreadable')
    default: return assertNever(failure)
  }
}

function receiptSentence(receipts: Exclude<ReceiptRead, { kind: 'verified' }>): string {
  switch (receipts.kind) {
    case 'idle': return phrase('receipt.idle')
    case 'missing': return phrase('receipt.missing')
    case 'control-unavailable': return phrase('receipt.control')
    case 'rejected': return phrase('receipt.rejected')
    case 'unreadable': return phrase('receipt.unreadable')
    case 'timeout': return phrase('receipt.timeout')
    case 'transport': return phrase('receipt.transport')
    case 'refused': return phrase('receipt.refused')
    default: return assertNever(receipts)
  }
}

function restartSentence(value: boolean | null): string {
  if (value === true) return phrase('restart.yes')
  if (value === false) return phrase('restart.no')
  return phrase('restart.absent')
}

function executorSentence(executor: AssignmentView['executor']): string {
  if (executor === null) return phrase('executor.absent')
  if ('unrecognized' in executor) return `${phrase('executor.unknown')} ${executor.token}`
  const known = executor.token === 'cloudflare-do'
    ? phrase('executor.cloudflareDo')
    : executor.token === 'mac-limb'
      ? phrase('executor.macLimb')
      : phrase('executor.browserWorker')
  return `${phrase('field.executor')} ${known} ${executor.token}`
}

function assignmentSentence(state: AssignmentView['state']): string {
  if (state === 'pending') return phrase('assignment.pending')
  if (state === 'running') return phrase('assignment.running')
  return phrase('assignment.ended')
}

function reportSentence(state: NonNullable<AssignmentView['report']>['state']): string {
  switch (state) {
    case 'progress': return phrase('report.progress')
    case 'waiting': return phrase('report.waiting')
    case 'ready': return phrase('report.ready')
    case 'blocked': return phrase('report.blocked')
    case 'failed': return phrase('report.failed')
    case 'dropped': return phrase('report.dropped')
    default: return assertNever(state)
  }
}

function outcomeSentence(outcome: NonNullable<TicketView['outcome']>): string {
  switch (outcome) {
    case 'completed': return phrase('outcome.completed')
    case 'merged': return phrase('outcome.merged')
    case 'closed': return phrase('outcome.closed')
    case 'dropped': return phrase('outcome.dropped')
    case 'stopped': return phrase('outcome.stopped')
    default: return assertNever(outcome)
  }
}

function attentionSentence(kind: AttentionView['kind']): string {
  switch (kind) {
    case 'question': return phrase('attention.question')
    case 'blocked': return phrase('attention.blocked')
    case 'diff-review': return phrase('attention.diff')
    case 'promotion-review': return phrase('attention.promotion')
    case 'stale-heartbeat': return phrase('attention.staleHeartbeat')
    case 'heartbeat-missing': return phrase('attention.heartbeatMissing')
    case 'heartbeat-invalid': return phrase('attention.heartbeatInvalid')
    case 'heartbeat-future': return phrase('attention.heartbeatFuture')
    case 'inferred-mandate-confirmation': return phrase('attention.inferred')
    case 'explicit-mandate-confirmation': return phrase('attention.explicit')
    case 'assignment-blocked': return phrase('attention.assignmentBlocked')
    case 'assignment-waiting': return phrase('attention.assignmentWaiting')
    default: return kind
  }
}

function lineageSentence(lineage: MandateView['authority']['lineage']): string | null {
  switch (lineage) {
    case 'promoted': return phrase('lineage.advanced')
    case 'head-claim-only': return phrase('lineage.claimOnly')
    case 'unrelated': return phrase('lineage.unrelated')
    case 'same-ball': return null
    case 'unknown': return null
    default: return assertNever(lineage)
  }
}

function identityLine(authority: MandateView['authority']): string {
  if (authority.identityClaim === null) return phrase('identity.absent')
  return `${phrase('identity.claim')} ${authority.identityClaim}`
}

function identitySourceLine(source: MandateView['authority']['identitySource']): string {
  switch (source) {
    case 'grant-receipt': return phrase('identity.grantReceipt')
    case 'confirmed-by-only': return phrase('identity.confirmedByOnly')
    case 'contradictory': return phrase('identity.contradictory')
    case 'absent': return phrase('identity.absent')
    default: return assertNever(source)
  }
}

function authoritySentence(level: MandateView['authority']['level']): string {
  switch (level) {
    case 'unavailable': return phrase('authority.unavailable')
    case 'unknown': return phrase('authority.unknown')
    case 'self-attested': return phrase('authority.selfAttested')
    case 'chain-linked': return phrase('authority.chainLinked')
    case 'owner-confirmed': return phrase('authority.ownerConfirmed')
    default: return assertNever(level)
  }
}

function heartbeatSentence(availability: HeartbeatView['availability']): string {
  switch (availability) {
    case 'stale': return phrase('attention.staleHeartbeat')
    case 'missing': return phrase('attention.heartbeatMissing')
    case 'invalid': return phrase('attention.heartbeatInvalid')
    case 'future': return phrase('attention.heartbeatFuture')
    case 'fresh': return phrase('heartbeat.notWork')
    case 'not-running': return phrase('heartbeat.notRunning')
    case 'not-evaluated': return phrase('attention.heartbeatMissing')
    default: return assertNever(availability)
  }
}

function assertNever(value: never): string {
  throw new Error(`superagent readout: unexpected case ${JSON.stringify(value)}`)
}
