/** Serialized, compare-and-swap publication for the local selected manifest. */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { legacyManifestPreimage, validateManifestStructure } from './ball-manifest.mjs'

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const canonicalJson = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(x => canonicalJson(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
const manifestId = ball => digest(legacyManifestPreimage(ball))
const manifestIdCanon = ball => {
  const { ballId: _ignore, ...rest } = ball
  return digest(canonicalJson(rest))
}
const validateManifest = ball => {
  const invalid = validateManifestStructure(ball)
  if (invalid) return invalid
  return (manifestId(ball) === ball.ballId || manifestIdCanon(ball) === ball.ballId) ? null : 'MANIFEST_HASH_MISMATCH'
}

/** Create one head owner; all HTTP and WebSocket writers share its queue. */
export function createBallHeadStore({ ballsDir, homeBallsDir }) {
  let queue = Promise.resolve()
  let lease = null
  let generation = null
  const generationPath = path.join(ballsDir, '..', '.transport', 'head-lease-generation.json')
  const serialized = operation => {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }
  const serializedMutation = operation => serialized(async () => {
    try { return await operation() }
    catch (error) {
      if (error.code !== 'SELECTED_HEAD_INVALID') throw error
      return { ok: false, code: error.code, status: 409, notApplied: true }
    }
  })
  const currentLease = () => lease && lease.expiresAt > Date.now() ? { ...lease } : null
  const read = async () => {
    let raw
    try { raw = await fs.readFile(path.join(ballsDir, 'HEAD.json'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    let selected
    try { selected = JSON.parse(raw) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw Object.assign(new Error('SELECTED_HEAD_INVALID'), { code: 'SELECTED_HEAD_INVALID', status: 409 })
    }
    if (validateManifest(selected)) throw Object.assign(new Error('SELECTED_HEAD_INVALID'), { code: 'SELECTED_HEAD_INVALID', status: 409 })
    return selected
  }
  const atomicWrite = async (target, value, beforeRename) => {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(value); await handle.sync() }
    finally { await handle.close() }
    if (beforeRename && !beforeRename()) { await fs.unlink(temporary); return false }
    await fs.rename(temporary, target)
    return true
  }
  const publish = async ({ ball, codeBySha = {}, expectedParentBallId, expectedEpoch, writerLease }) => {
    const invalid = validateManifest(ball)
    if (invalid) return { ok: false, code: invalid, status: 400 }
    const selected = await read()
    if (selected?.ballId === ball.ballId) {
      let homeMetadataSaved = true
      try { await atomicWrite(path.join(homeBallsDir, 'HEAD.json'), JSON.stringify(selected, null, 2) + '\n') }
      catch { homeMetadataSaved = false }
      return { ok: true, ballId: ball.ballId, idempotent: true, homeMetadataSaved }
    }
    const selectedId = selected?.ballId ?? null
    const selectedEpoch = selected?.epoch ?? -1
    if (expectedParentBallId !== selectedId || expectedEpoch !== selectedEpoch ||
        ball.parentBallId !== selectedId || ball.epoch !== selectedEpoch + 1) {
      const forksDir = path.join(ballsDir, 'forks')
      await fs.mkdir(forksDir, { recursive: true })
      await atomicWrite(path.join(forksDir, `${ball.ballId}.json`), JSON.stringify({ ball, codeBySha }, null, 2) + '\n')
      return { ok: false, code: 'REBASE_REQUIRED', status: 409, ballId: selectedId, epoch: selectedEpoch, retainedFork: ball.ballId }
    }
    const held = currentLease()
    if (!held || writerLease?.ownerPeerId !== held.ownerPeerId || writerLease?.generation !== held.generation || ball.authorPeerId !== held.ownerPeerId) {
      const forksDir = path.join(ballsDir, 'forks')
      await fs.mkdir(forksDir, { recursive: true })
      await atomicWrite(path.join(forksDir, `${ball.ballId}.json`), JSON.stringify({ ball, codeBySha }, null, 2) + '\n')
      return { ok: false, code: 'WRITER_LEASE_REQUIRED', status: 423, retainedFork: ball.ballId }
    }
    const modules = {}
    for (const [sha, meta] of Object.entries(ball.modules)) {
      if (!isSha(sha) || meta?.sha256 !== sha || meta?.specifier !== `ball:${sha}`) {
        return { ok: false, code: 'INVALID_MODULE', status: 400 }
      }
      let code = codeBySha[sha]
      if (code === undefined) {
        try { code = await fs.readFile(path.join(ballsDir, `${sha}.js`), 'utf8') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      if (typeof code !== 'string' || digest(code) !== sha) return { ok: false, code: 'MODULE_HASH_MISMATCH', status: 400, sha }
      modules[sha] = code
    }
    await fs.mkdir(ballsDir, { recursive: true })
    await fs.mkdir(homeBallsDir, { recursive: true })
    for (const [sha, code] of Object.entries(modules)) {
      await atomicWrite(path.join(ballsDir, `${sha}.js`), code)
      await atomicWrite(path.join(homeBallsDir, `${sha}.js`), code)
    }
    const serialized = JSON.stringify(ball, null, 2) + '\n'
    if (!currentLease() || lease.generation !== writerLease.generation || lease.ownerPeerId !== writerLease.ownerPeerId) {
      const forksDir = path.join(ballsDir, 'forks')
      await fs.mkdir(forksDir, { recursive: true })
      await atomicWrite(path.join(forksDir, `${ball.ballId}.json`), JSON.stringify({ ball, codeBySha }, null, 2) + '\n')
      return { ok: false, code: 'WRITER_LEASE_EXPIRED', status: 423, retainedFork: ball.ballId }
    }
    await atomicWrite(path.join(ballsDir, `manifest-${ball.ballId}.json`), serialized)
    // balls/HEAD.json is the sole selection point; never publish the home copy first.
    const committed = await atomicWrite(path.join(ballsDir, 'HEAD.json'), serialized, () => Boolean(currentLease() && lease.generation === writerLease.generation && lease.ownerPeerId === writerLease.ownerPeerId))
    if (!committed) {
      const forksDir = path.join(ballsDir, 'forks')
      await fs.mkdir(forksDir, { recursive: true })
      await atomicWrite(path.join(forksDir, `${ball.ballId}.json`), JSON.stringify({ ball, codeBySha }, null, 2) + '\n')
      return { ok: false, code: 'WRITER_LEASE_EXPIRED', status: 423, retainedFork: ball.ballId }
    }
    let homeMetadataSaved = true
    try { await atomicWrite(path.join(homeBallsDir, 'HEAD.json'), serialized) } catch { homeMetadataSaved = false }
    return { ok: true, ballId: ball.ballId, epoch: ball.epoch, homeMetadataSaved }
  }
  const changeLease = async ({ action, ownerPeerId, generation: expectedGeneration, ttlMs = 30000 } = {}) => {
    if (!['acquire', 'renew', 'release'].includes(action) || typeof ownerPeerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(ownerPeerId) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30000) return { ok: false, code: 'INVALID_WRITER_LEASE', status: 400 }
    const held = currentLease()
    if (action === 'release') {
      if (!held || held.ownerPeerId !== ownerPeerId || held.generation !== expectedGeneration) return { ok: false, code: 'WRITER_LEASE_STALE', status: 409 }
      lease = null
      return { ok: true, released: true }
    }
    const selected = await read()
    const live = currentLease()
    if (action === 'renew') {
      if (!live || live.ownerPeerId !== ownerPeerId || live.generation !== expectedGeneration) return { ok: false, code: 'WRITER_LEASE_STALE', status: 409 }
    } else if (live) return { ok: false, code: 'WRITER_LEASE_HELD', status: 423, lease: live }
    // Acquisition never replaces a live grant, including the same peer. After an
    // uncertain acquire/release, wait for exact release or expiry before retrying.
    // Each subsequent grant has a new generation fencing delayed old requests.

    if (action === 'acquire') {
      if (generation === null) {
        try {
          const saved = JSON.parse(await fs.readFile(generationPath, 'utf8'))
          if (!Number.isSafeInteger(saved.generation) || saved.generation < 0) throw new Error('Writer generation metadata is corrupt')
          generation = saved.generation
        } catch (error) { if (error.code === 'ENOENT') generation = 0; else throw error }
      }
      generation += 1
      if (!Number.isSafeInteger(generation)) throw new Error('Writer generation exhausted')
      await fs.mkdir(path.dirname(generationPath), { recursive: true })
      await atomicWrite(generationPath, JSON.stringify({ generation }) + '\n')
      lease = { ownerPeerId, generation, expiresAt: Date.now() + ttlMs, deadlineAt: Date.now() + 60000 }
    } else lease.expiresAt = Math.min(Date.now() + ttlMs, lease.deadlineAt)
    return { ok: true, lease: { ...lease }, ballId: selected?.ballId ?? null, epoch: selected?.epoch ?? -1 }
  }
  const retained = async ballId => {
    if (!isSha(ballId)) throw Object.assign(new Error('INVALID_RECOVERY_TARGET'), { status: 400 })
    for (const file of [path.join(ballsDir, `manifest-${ballId}.json`), path.join(ballsDir, `${ballId}.json`), path.join(ballsDir, `manifest-${ballId.slice(0, 12)}.json`), path.join(homeBallsDir, 'history', `${ballId}.json`)]) {
      let ball
      try { ball = JSON.parse(await fs.readFile(file, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error }
      if (!validateManifest(ball) && ball.ballId === ballId) return ball
    }
    throw Object.assign(new Error('RECOVERY_TARGET_UNAVAILABLE'), { status: 404 })
  }
  const recoveryCompatibility = (selected, target) => {
    const currentVersion = entry => entry ? JSON.stringify({ specifier: entry.specifier, config: entry.config, disabled: entry.disabled }) : null
    const changed = ['auma-memory-domain', 'seed-receipts'].filter(id => currentVersion(selected?.entries[id]) !== currentVersion(target.entries[id]))
    return { blocked: changed.length > 0, protectedStateOrgansChanged: changed }
  }
  const recoveryView = async targetBallId => {
    const selected = await read()
    const summary = ball => ({ ballId: ball.ballId, epoch: ball.epoch, entries: Object.keys(ball.entries).length, enabled: Object.values(ball.entries).filter(entry => !entry.disabled).length, createdAt: Number.isFinite(ball.createdAt) ? ball.createdAt : null })
    if (targetBallId !== undefined) {
      const target = await retained(targetBallId)
      const before = selected?.entries ?? {}
      const changed = Object.keys(target.entries).filter(id => Object.hasOwn(before, id) && JSON.stringify(before[id]) !== JSON.stringify(target.entries[id]))
      return { ok: true, selected: selected ? summary(selected) : null, target: summary(target), expectedParentBallId: selected?.ballId ?? null, expectedEpoch: selected?.epoch ?? -1, candidateBallId: selected ? manifestId({ ...target, parentBallId: selected.ballId, epoch: selected.epoch + 1 }) : null, changes: { changed, added: Object.keys(target.entries).filter(id => !Object.hasOwn(before, id)), removed: Object.keys(before).filter(id => !Object.hasOwn(target.entries, id)) }, moduleBytesChecked: false, compatibility: recoveryCompatibility(selected, target), scope: 'organ-manifest-only' }
    }
    const candidates = new Map()
    for (const directory of [ballsDir, path.join(homeBallsDir, 'history')]) {
      let names
      try { names = await fs.readdir(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for (const name of names) {
        if (!/^(?:[a-f0-9]{64}|manifest-[a-f0-9]{12,64})\.json$/.test(name)) continue
        try {
          const ball = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
          if (!validateManifest(ball)) candidates.set(ball.ballId, summary(ball))
        } catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error }
      }
    }
    return { ok: true, selected: selected ? summary(selected) : null, lease: currentLease(), candidates: [...candidates.values()].sort((left, right) => right.epoch - left.epoch || left.ballId.localeCompare(right.ballId)), scope: 'organ-manifest-only', retainedIsNotSelectedEvidence: true }
  }
  const recover = async ({ targetBallId, expectedParentBallId, expectedEpoch } = {}) => {
    const selected = await read()
    if (!selected) return { ok: false, code: 'HEAD_AUTHORITY_MISSING', status: 409 }
    const target = await retained(targetBallId)
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || expectedEpoch === Number.MAX_SAFE_INTEGER || !isSha(expectedParentBallId)) return { ok: false, code: 'INVALID_RECOVERY_PRECONDITION', status: 400 }
    const ball = { ...target, parentBallId: expectedParentBallId, epoch: expectedEpoch + 1, authorPeerId: `recovery:${crypto.randomUUID()}`, createdAt: Date.now(), recovery: { targetBallId, scope: 'organ-manifest-only' } }
    ball.ballId = manifestId(ball)
    // An exact retry may arrive after another selection. The validated selected
    // parent chain, not the mere presence of a candidate file, establishes application.
    let cursor = selected
    let absenceProven = false
    for (let depth = 0; cursor && depth < 512; depth += 1) {
      if (cursor.ballId === ball.ballId) return { ok: true, ballId: ball.ballId, epoch: ball.epoch, selectedBallId: selected.ballId, idempotent: true, scope: 'organ-manifest-only' }
      if (cursor.epoch < ball.epoch) { absenceProven = true; break }
      if (cursor.parentBallId === null) { absenceProven = cursor.epoch === 0; break }
      try {
        const parent = await retained(cursor.parentBallId)
        if (parent.epoch !== cursor.epoch - 1) break
        cursor = parent
      } catch (error) { if (error.status === 404) break; throw error }
    }
    if (selected.ballId !== expectedParentBallId || selected.epoch !== expectedEpoch) return { ok: false, code: 'REBASE_REQUIRED', status: 409, ballId: selected.ballId, epoch: selected.epoch, notApplied: absenceProven, reconciliation: absenceProven ? 'not-applied' : 'inconclusive' }
    if (recoveryCompatibility(selected, target).blocked) return { ok: false, code: 'STATE_ORGAN_MIGRATION_REQUIRED', status: 409, notApplied: true, reconciliation: 'not-applied' }
    if (targetBallId === selected.ballId) return { ok: true, unchanged: true, ballId: selected.ballId, epoch: selected.epoch, scope: 'organ-manifest-only' }
    // Preserve the exact current body before the forward transition. This never
    // rewinds private state, receipts, writer generations or unresolved effects.
    const grant = await changeLease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
    if (!grant.ok) return { ...grant, notApplied: true, reconciliation: 'not-applied' }
    try {
      await atomicWrite(path.join(ballsDir, `manifest-${selected.ballId}.json`), JSON.stringify(selected, null, 2) + '\n')
      const result = await publish({ ball, expectedParentBallId, expectedEpoch, writerLease: grant.lease })
      return { ...result, scope: 'organ-manifest-only', ...(result.ok ? { ball } : { notApplied: true, reconciliation: 'not-applied' }) }
    } finally { await changeLease({ action: 'release', ownerPeerId: ball.authorPeerId, generation: grant.lease.generation }) }
  }
  return {
    read,
    recoveryView: targetBallId => serialized(() => recoveryView(targetBallId)),
    recover: input => serializedMutation(() => recover(input)),
    lease: input => serializedMutation(() => changeLease(input)),
    inspectLease: () => serialized(async () => ({ ok: true, lease: currentLease() })),
    publish: input => serializedMutation(() => publish(input)),
  }
}
