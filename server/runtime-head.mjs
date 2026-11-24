/** Forward local runtime selection. Static closure capture never calls this publisher. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const isId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isOp = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }) }
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
const genesis = () => ({ epoch: 0, recordId: null, releaseId: null })

export function createRuntimeHead({ repository, directory, verifyRelease }) {
  const history = path.join(directory, 'history')
  const operations = path.join(directory, 'operations')
  const headFile = path.join(directory, 'HEAD.json')
  const pendingFile = path.join(directory, 'pending.json')
  const lockFile = path.join(directory, 'WRITE.lock')
  let queue = Promise.resolve()
  const owned = stat => typeof process.getuid === 'function' && stat.uid === process.getuid()
  async function syncDirectory(file) { const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { await handle.sync() } finally { await handle.close() } }
  async function storage(create = true) {
    const relative = path.relative(repository, directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('INVALID_RUNTIME_HEAD_DIRECTORY')
    let current = repository
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part)
      const stat = await fsp.lstat(current).catch(absent)
      if (!stat) {
        if (!create) return
        try { await fsp.mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const actual = await fsp.lstat(current)
      if (!actual.isDirectory() || actual.isSymbolicLink() || !owned(actual) || (actual.mode & (current === directory ? 0o077 : 0o022))) fail('UNSAFE_RUNTIME_HEAD_DIRECTORY')
      if (create && current !== repository) await syncDirectory(path.dirname(current))
    }
    for (const child of [history, operations]) {
      const stat = await fsp.lstat(child).catch(absent)
      if (!stat) {
        if (!create) continue
        try { await fsp.mkdir(child, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const actual = await fsp.lstat(child)
      if (!actual.isDirectory() || actual.isSymbolicLink() || !owned(actual) || (actual.mode & 0o077)) fail('UNSAFE_RUNTIME_HEAD_DIRECTORY')
      if (create) await syncDirectory(directory)
    }
  }
  async function readJson(file) {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(absent)
    if (!handle) return null
    try { const stat = await handle.stat(); if (!stat.isFile() || !owned(stat) || (stat.mode & 0o077) || stat.size > 16384) fail('UNSAFE_RUNTIME_HEAD_FILE'); const bytes = await handle.readFile(); if (bytes.length > 16384) fail('RUNTIME_HEAD_BYTE_BUDGET'); const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RUNTIME_HEAD_FILE'); return value }
    finally { await handle.close() }
  }
  async function writeJson(file, value, exclusive = false) {
    const temporary = path.join(path.dirname(file), '.' + crypto.randomUUID() + '.tmp')
    const body = JSON.stringify(value) + '\n'
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
      if (exclusive) {
        try { await fsp.link(temporary, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
        if (JSON.stringify(await readJson(file)) !== JSON.stringify(value)) fail('RUNTIME_HISTORY_CONFLICT')
      } else await fsp.rename(temporary, file)
      await syncDirectory(path.dirname(file))
    } finally { await fsp.rm(temporary, { force: true }) }
  }
  function request(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'expectedEpoch,expectedRecordId,operationId,releaseId' || !isOp(value.operationId) || !isId(value.releaseId) || !Number.isSafeInteger(value.expectedEpoch) || value.expectedEpoch < 0 || value.expectedEpoch >= Number.MAX_SAFE_INTEGER || (value.expectedEpoch === 0 ? value.expectedRecordId !== null : !isId(value.expectedRecordId))) fail('INVALID_RUNTIME_SELECTION', 400)
    return { operationId: value.operationId, releaseId: value.releaseId, expectedRecordId: value.expectedRecordId, expectedEpoch: value.expectedEpoch }
  }
  function recordFor(input) {
    const body = { version: 1, epoch: input.expectedEpoch + 1, releaseId: input.releaseId, parentRecordId: input.expectedRecordId, operationId: input.operationId }
    return { ...body, recordId: sha(JSON.stringify(body)) }
  }
  function validate(record) {
    if (!record || record.version !== 1 || !Number.isSafeInteger(record.epoch) || record.epoch < 1 || !isId(record.releaseId) || !isOp(record.operationId) || (record.epoch === 1 ? record.parentRecordId !== null : !isId(record.parentRecordId)) || Object.keys(record).sort().join(',') !== 'epoch,operationId,parentRecordId,recordId,releaseId,version') fail('INVALID_SELECTED_RUNTIME')
    const expected = recordFor({ expectedEpoch: record.epoch - 1, releaseId: record.releaseId, expectedRecordId: record.parentRecordId, operationId: record.operationId })
    if (record.recordId !== expected.recordId) fail('RUNTIME_HEAD_DIGEST_MISMATCH')
    return record
  }
  async function retained(id) { const record = validate(await readJson(path.join(history, id + '.json'))); if (record.recordId !== id) fail('RUNTIME_HISTORY_ID_MISMATCH'); return record }
  async function readHead(pending = null) {
    const value = await readJson(headFile)
    if (value) {
      const head = validate(value)
      if (JSON.stringify(await retained(head.recordId)) !== JSON.stringify(head)) fail('RUNTIME_HEAD_HISTORY_MISMATCH')
      return head
    }
    const names = (await fsp.readdir(history).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    const receipts = (await fsp.readdir(operations).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    if (!names.length && !receipts.length) return genesis()
    const target = pending && recordFor(pending)
    if (pending?.expectedEpoch === 0 && pending.expectedRecordId === null && names.every(name => name === target.recordId + '.json') && receipts.length === 0) return genesis()
    fail('RUNTIME_AUTHORITY_MISSING')
  }
  async function evidence(head, target) {
    if (target.epoch > head.epoch) return 'absent'
    let current = head
    for (let depth = 0; depth < 1024; depth += 1) {
      if (current.recordId === target.recordId) return 'applied'
      if (current.epoch <= target.epoch) return 'absent'
      if (current.epoch === 0 || (current.epoch === 1 && current.parentRecordId === null)) return 'absent'
      let parent
      try { parent = await retained(current.parentRecordId) } catch { return 'unknown' }
      if (parent.epoch !== current.epoch - 1) return 'unknown'
      current = parent
    }
    return 'unknown'
  }
  async function receipt(input, target) {
    const value = { version: 1, request: input, recordId: target.recordId, epoch: target.epoch }
    await writeJson(path.join(operations, input.operationId + '.json'), value, true)
    return value
  }
  async function finish(input) {
    const target = recordFor(input)
    const head = await readHead(input)
    const saved = await readJson(path.join(operations, input.operationId + '.json'))
    if (saved && (saved.version !== 1 || JSON.stringify(saved.request) !== JSON.stringify(input) || saved.recordId !== target.recordId || saved.epoch !== target.epoch)) fail('RUNTIME_OPERATION_CONFLICT', 409)
    const applied = await evidence(head, target)
    if (saved && applied !== 'applied') fail('RUNTIME_RECEIPT_AUTHORITY_CONFLICT')
    if (applied !== 'applied') {
      if (head.recordId !== input.expectedRecordId || head.epoch !== input.expectedEpoch) fail('PENDING_RUNTIME_CONFLICT')
      await verifyRelease(input.releaseId)
      await writeJson(path.join(history, target.recordId + '.json'), target, true)
      await writeJson(headFile, target)
    }
    await receipt(input, target)
    await fsp.rm(pendingFile, { force: true }); await syncDirectory(directory)
    return target
  }
  async function recover() { const pending = await readJson(pendingFile); if (pending) { if (pending.version !== 1 || Object.keys(pending).sort().join(',') !== 'request,version') fail('INVALID_PENDING_RUNTIME'); await finish(request(pending.request)) } }
  function serialized(operation) {
    const result = queue.then(async () => {
      await storage()
      let handle
      try { handle = await fsp.open(lockFile, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') fail('RUNTIME_WRITER_LOCKED', 409); throw error }
      const identity = await handle.stat()
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, id: crypto.randomUUID() })); await handle.sync()
        await recover()
        return await operation()
      } finally {
        try { const current = await fsp.lstat(lockFile); if (current.dev !== identity.dev || current.ino !== identity.ino) fail('RUNTIME_LOCK_CHANGED'); await fsp.rm(lockFile); await syncDirectory(directory) } finally { await handle.close() }
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    async view() {
      // Ordinary serving never creates directories, locks, receipts or recovery writes.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await storage(false)
        const pendingBefore = Boolean(await fsp.lstat(pendingFile).catch(absent))
        const selected = await readHead()
        if (selected.epoch > 0) {
          const input = request({ operationId: selected.operationId, releaseId: selected.releaseId, expectedRecordId: selected.parentRecordId, expectedEpoch: selected.epoch - 1 })
          const saved = await readJson(path.join(operations, selected.operationId + '.json'))
          const expected = { version: 1, request: input, recordId: selected.recordId, epoch: selected.epoch }
          if (JSON.stringify(saved) !== JSON.stringify(expected)) fail('RUNTIME_PUBLICATION_UNCONFIRMED')
        }
        // Sample cleanup after HEAD/receipt: pre-publication flags cannot certify a newly visible selection.
        const pending = Boolean(await fsp.lstat(pendingFile).catch(absent))
        const locked = Boolean(await fsp.lstat(lockFile).catch(absent))
        if (selected.epoch === 0) {
          // Do not return a mixed-snapshot genesis after first publication completed.
          if (await readJson(headFile)) continue
          if (pendingBefore || pending) fail('RUNTIME_PUBLICATION_UNCONFIRMED')
        }
        return { ok: true, selected, writable: !pending && !locked, pendingReconciliation: pending, writerLocked: locked, selectionIsNotHealthProof: true }
      }
      fail('RUNTIME_PUBLICATION_UNCONFIRMED')
    },
    select(value) {
      return serialized(async () => {
        const input = request(value)
        const target = recordFor(input)
        const head = await readHead()
        const saved = await readJson(path.join(operations, input.operationId + '.json'))
        if (saved && (saved.version !== 1 || JSON.stringify(saved.request) !== JSON.stringify(input) || saved.recordId !== target.recordId || saved.epoch !== target.epoch)) return { ok: false, status: 409, code: 'RUNTIME_OPERATION_CONFLICT', notApplied: false }
        const applied = await evidence(head, target)
        if (saved && applied !== 'applied') return { ok: false, status: 409, code: 'RUNTIME_RECEIPT_AUTHORITY_CONFLICT', notApplied: false }
        if (applied === 'applied') { await receipt(input, target); return { ok: true, replayed: true, operationId: input.operationId, releaseId: input.releaseId, epoch: target.epoch, recordId: target.recordId, selected: head, booted: false } }
        if (applied === 'unknown') return { ok: false, status: 409, code: 'RUNTIME_HISTORY_INCONCLUSIVE', notApplied: false }
        if (head.recordId !== input.expectedRecordId || head.epoch !== input.expectedEpoch) return { ok: false, status: 409, code: 'RUNTIME_REBASE_REQUIRED', notApplied: true, selected: head }
        try { await verifyRelease(input.releaseId) } catch (error) { return { ok: false, status: error.status ?? 503, code: error.code ?? 'RUNTIME_CLOSURE_UNAVAILABLE', notApplied: true } }
        await writeJson(pendingFile, { version: 1, request: input })
        const selected = await finish(input)
        return { ok: true, replayed: false, operationId: input.operationId, releaseId: input.releaseId, epoch: selected.epoch, recordId: selected.recordId, selected, booted: false }
      }).catch(error => ({ ok: false, status: error.status ?? 503, code: error.code ?? 'RUNTIME_SELECTION_UNCONFIRMED', error: error.message, notApplied: false }))
    },
  }
}
