/** Ordered local mirror delivery. IDs and digests are receipts, never authentication credentials. */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const fail = (code, status = 409) => { const error = new Error(code); error.code = code; error.status = status; throw error }
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

/** Replace a file only after flushing its complete bytes. Journal replay covers interrupted batches. */
export async function atomicMirrorWrite(target, bytes, mode = 0o600, temporaryDirectory = path.dirname(target)) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.mkdir(temporaryDirectory, { recursive: true })
  const temporary = path.join(temporaryDirectory, `${crypto.randomUUID()}.tmp`)
  const handle = await fs.open(temporary, 'wx', mode)
  try { await handle.writeFile(bytes); await handle.sync() }
  finally { await handle.close() }
  await fs.rename(temporary, target)
}

/**
 * A single queue owns batch writes, journal recovery and snapshot reads. `withheldEntry(item)` (optional) names an entry
 * the current path rule refuses although an older rule admitted it: a well-formed FILE or DIRECTORY entry matching the
 * secret-path rule (server/local-host.mjs `withheldMirrorEntry`). Recovery uses it for a pending batch journaled under the
 * older rule; new batches never reach the journal with one (validateEntries refuses them first).
 */
export function createMirrorPublisher({ directory, apply, validateEntries, preflightEntries = async () => {}, readSnapshot, withheldEntry = () => false }) {
  let queue = Promise.resolve()
  const pendingPath = path.join(directory, 'pending.json')
  const progressPath = path.join(directory, 'pending-progress.json')
  const serialized = operation => {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }
  const clientRoot = clientId => path.join(directory, 'clients', clientId)
  const tipPath = clientId => path.join(clientRoot(clientId), 'HEAD.json')
  const receiptPath = batch => path.join(clientRoot(batch.clientId), `${batch.seq}.json`)
  // The batch's identity, digest and size: enough to look up the receipt of a batch already applied.
  const validateShape = envelope => {
    const { batch, digest } = envelope ?? {}
    if (!batch || typeof batch.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batch.clientId) || !Number.isSafeInteger(batch.seq) || batch.seq < 1 || batch.id !== `${batch.clientId}:${batch.seq}` || typeof digest !== 'string' || sha256(JSON.stringify(batch)) !== digest) fail('INVALID_MIRROR_BATCH', 400)
    if (!Array.isArray(batch.entries) || !batch.entries.length || batch.entries.length > 50000) fail('INVALID_MIRROR_ENTRIES', 400)
    return { batch, digest }
  }
  const validate = async envelope => {
    const valid = validateShape(envelope)
    await validateEntries(valid.batch.entries)
    return valid
  }
  const advanceTip = async (batch, digest) => {
    const previous = await readJson(tipPath(batch.clientId))
    const seq = previous?.seq ?? 0
    if (seq < batch.seq) {
      if (seq + 1 !== batch.seq) fail('MIRROR_SEQUENCE_GAP')
      await atomicMirrorWrite(tipPath(batch.clientId), JSON.stringify({ seq: batch.seq, digest }) + '\n')
    }
  }
  // The journaled batch's durable cursor: how many of its entries are already applied.
  const appliedSoFar = async ({ batch, digest }) => {
    const progress = await readJson(progressPath)
    if (progress?.id !== batch.id) return 0
    if (progress.digest !== digest || !Number.isSafeInteger(progress.applied) || progress.applied < 0 || progress.applied > batch.entries.length) fail('MIRROR_PROGRESS_CONFLICT')
    return progress.applied
  }
  // Apply entries [cursor, end) one idempotent primitive at a time. The durable cursor prevents
  // replaying an old prefix after later operations changed its ancestors. An entry `withheld` names (crash recovery of an
  // older host's journal only) is passed over: never preflighted, never applied, still counted by the cursor.
  const applyThrough = async ({ batch, digest }, end, withheld = () => false) => {
    let applied = await appliedSoFar({ batch, digest })
    await preflightEntries(batch.entries.slice(applied, end).filter(item => !withheld(item)))
    for (; applied < end;) {
      const item = batch.entries[applied]
      if (!withheld(item) && await apply([item]) !== 1) fail('MIRROR_APPLICATION_INCOMPLETE', 503)
      applied += 1
      await atomicMirrorWrite(progressPath, JSON.stringify({ id: batch.id, digest, applied }) + '\n')
    }
    return applied
  }
  const clearJournal = async () => {
    await fs.rm(pendingPath, { force: true })
    await fs.rm(progressPath, { force: true })
  }
  const finish = async ({ batch, digest }, withheld = null) => {
    let receipt = await readJson(receiptPath(batch))
    if (receipt) {
      if (receipt.digest !== digest || receipt.id !== batch.id) fail('MIRROR_REPLAY_CONFLICT')
    } else {
      const applied = await applyThrough({ batch, digest }, batch.entries.length, withheld ?? undefined)
      receipt = { ok: true, id: batch.id, clientId: batch.clientId, seq: batch.seq, digest, applied,
        ...(withheld ? { withheldEntries: batch.entries.filter(withheld).length } : {}), acknowledgedAt: Date.now() }
      await atomicMirrorWrite(receiptPath(batch), JSON.stringify(receipt) + '\n')
    }
    await advanceTip(batch, digest)
    await clearJournal()
    return receipt
  }
  /**
   * CRASH RECOVERY. A pending batch is judged by its identity and digest first, then by its
   * receipt, and only then by the current entry rules:
   *   - a receipt for exactly this batch (same id and digest): the batch was applied; the tip is advanced and the journal
   *     cleared, whatever paths it names (a rule tightened since never blocks it);
   *   - no receipt, and no entry the current rule withholds: finished as before (ordinary entries applied, a `gone` matching
   *     the secret-path rule an applied no-op), then receipted;
   *   - no receipt, and a FILE or DIRECTORY entry matching the secret-path rule (journaled by an older host): that entry
   *     is WITHHELD (never written, exactly as the browser's own outbox now leaves it out) and every other entry is
   *     applied in order; a readable record goes to `set-aside/<clientId>.<seq>.record.json` (MIRROR_PENDING_SET_ASIDE:
   *     which batch, how many entries are to be applied and withheld; no path, no content) with the batch as journaled
   *     beside it, then the batch is receipted (`withheldEntries` says how many were withheld) and that browser's tip
   *     advances. The record is written BEFORE the work, so it says `status: 'pending'` and names its `receipt` file (the
   *     only proof the batch is done); once the receipt exists it is rewritten as `status: 'receipted'` with `receiptAt`
   *     (it used to say "applied" and "receipted" before either was true).
   *     Review of job 4: a batch stopped and never receipted was refused on every retry and held that browser's later
   *     saves for ever. Now its exact replay gets the stored receipt and its queue moves on; snapshots and other
   *     browsers' publishes were never blocked. A NEW batch naming such an entry is still refused (400 INVALID_MIRROR_PATH).
   */
  const asideDirectory = path.join(directory, 'set-aside')
  const asideRecordPath = batch => path.join(asideDirectory, `${batch.clientId}.${batch.seq}.record.json`)
  // A set-aside record still marked pending for exactly this batch is rewritten once its receipt exists (never before).
  const markReceipted = async (batch, digest, receipt) => {
    const record = await readJson(asideRecordPath(batch))
    if (record?.code !== 'MIRROR_PENDING_SET_ASIDE' || record.id !== batch.id || record.digest !== digest || record.status === 'receipted') return
    await atomicMirrorWrite(asideRecordPath(batch), JSON.stringify({ ...record, status: 'receipted', receiptAt: receipt.acknowledgedAt,
      reason: 'an older host journaled this batch with a file or directory entry matching the secret-path rule and never '
        + 'acknowledged it; those entries were withheld, every other entry was applied, and the batch was receipted (see receipt)' }) + '\n')
  }
  const recover = async () => {
    const pending = await readJson(pendingPath)
    if (!pending) return
    const valid = validateShape(pending)
    const { batch, digest } = valid
    const receipt = await readJson(receiptPath(batch))
    if (receipt) {
      if (receipt.digest !== digest || receipt.id !== batch.id) fail('MIRROR_REPLAY_CONFLICT')
      await markReceipted(batch, digest, receipt)
      await advanceTip(batch, digest)
      await clearJournal()
      return
    }
    const cursor = await appliedSoFar(valid)
    const withheld = batch.entries.filter(item => withheldEntry(item)).length
    if (!withheld) {
      await validateEntries(batch.entries.slice(cursor))
      await finish(valid)
      return
    }
    await validateEntries(batch.entries.slice(cursor).filter(item => !withheldEntry(item)))
    // The record and the batch as journaled are written before anything is applied (a crash here repeats them, the same,
    // keeping the first setAsideAt). Written before the work, the record says what is planned and points to the receipt.
    const name = `${batch.clientId}.${batch.seq}`
    await fs.mkdir(asideDirectory, { recursive: true })
    const earlier = await readJson(asideRecordPath(batch))
    const setAsideAt = earlier?.id === batch.id && earlier.digest === digest && Number.isSafeInteger(earlier.setAsideAt) ? earlier.setAsideAt : Date.now()
    await atomicMirrorWrite(asideRecordPath(batch), JSON.stringify({
      code: 'MIRROR_PENDING_SET_ASIDE', id: batch.id, clientId: batch.clientId, seq: batch.seq, digest,
      entryCount: batch.entries.length, appliedEntries: batch.entries.length - withheld, withheldEntries: withheld, setAsideAt,
      status: 'pending', receipt: path.relative(directory, receiptPath(batch)),
      reason: 'an older host journaled this batch with a file or directory entry matching the secret-path rule and never '
        + 'acknowledged it; those entries will be withheld and every other entry applied; the batch counts as done only when '
        + 'its receipt exists (see receipt)',
    }) + '\n')
    await atomicMirrorWrite(path.join(asideDirectory, `${name}.json`), JSON.stringify(pending) + '\n')
    const receipted = await finish(valid, item => withheldEntry(item))
    await markReceipted(batch, digest, receipted)
    console.warn(`mirror: MIRROR_PENDING_SET_ASIDE batch ${batch.id}: ${withheld} of ${batch.entries.length} entries withheld, `
      + 'the rest applied and receipted; recorded in .transport/set-aside')
  }
  return {
    publish(envelope) {
      return serialized(async () => {
        try {
          await recover()
          // An exact replay (same id, same digest) of a batch this host already applied gets its stored receipt before
          // the entry rules run, as at the edge: a rule tightened since (a secret-shaped path) never strands a browser
          // whose acknowledgement was lost. The receipt exists only for bytes that passed the rules when they applied.
          const { batch, digest } = validateShape(envelope)
          const receipt = await readJson(receiptPath(batch))
          if (receipt) {
            if (receipt.digest !== digest || receipt.id !== batch.id) fail('MIRROR_REPLAY_CONFLICT')
            await advanceTip(batch, digest)
            return { ...receipt, replayed: true }
          }
          const valid = await validate(envelope)
          const previous = await readJson(tipPath(batch.clientId))
          if (batch.seq !== (previous?.seq ?? 0) + 1) fail('MIRROR_SEQUENCE_GAP')
          await preflightEntries(batch.entries)
          await atomicMirrorWrite(pendingPath, JSON.stringify(valid) + '\n')
          return await finish(valid)
        } catch (error) {
          return { ok: false, status: error.status ?? 503, code: error.code ?? 'MIRROR_DELIVERY_FAILED', error: error.message }
        }
      })
    },
    snapshot() { return serialized(async () => { await recover(); return readSnapshot() }) },
  }
}
