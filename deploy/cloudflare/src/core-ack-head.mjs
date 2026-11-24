// Pure transition proposal: persist only in the existing authoritative append
// transaction, after the bytes are durable. Never derive this from reader state.
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const nat = value => Number.isSafeInteger(value) && value >= 0

export const readAckHead = head => {
  if (!head || !nat(head.version) || head.version < 1 ||
      (head.version === 1 ? head.parent !== null : !sha(head.parent)) ||
      !nat(head.bytes) || !nat(head.lineEnd) || head.lineEnd > head.bytes ||
      !sha(head.tailSha) || !nat(head.at)) return null
  return { parent: head.parent, version: head.version, bytes: head.bytes,
    lineEnd: head.lineEnd, tailSha: head.tailSha, at: head.at }
}

export async function coreSha256(domain, value) {
  const bytes = new TextEncoder().encode(domain + '\n' + value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function ackHeadId(head) {
  const fields = readAckHead(head)
  return fields === null ? null : coreSha256('aukora.core.ack-head.v0', JSON.stringify(fields))
}

export async function proposeAckHead(current, expectedParent, observation) {
  const previous = current === null ? null : readAckHead(current)
  if (current !== null && previous === null) return { ok: false, code: 'ACK_HEAD_INVALID' }
  const parent = previous === null ? null : await ackHeadId(previous)
  if (expectedParent !== parent) return { ok: false, code: 'ACK_PARENT_STALE' }
  const head = readAckHead({
    parent, version: (previous?.version ?? 0) + 1, bytes: observation?.bytes,
    lineEnd: observation?.lineEnd, tailSha: observation?.tailSha, at: observation?.at,
  })
  if (head === null || (previous !== null &&
      (head.bytes <= previous.bytes || head.lineEnd < previous.lineEnd || head.at < previous.at))) {
    return { ok: false, code: 'ACK_HEAD_INVALID' }
  }
  return { ok: true, head, id: await ackHeadId(head) }
}
