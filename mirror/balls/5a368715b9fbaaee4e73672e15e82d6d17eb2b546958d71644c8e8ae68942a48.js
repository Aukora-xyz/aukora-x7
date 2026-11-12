'use strict';

const nodeFs = require('fs');
const crypto = require('crypto');
const LEGACY_PATH = '/dsh/home/auma/memory-store.json';
const STORE_PATH = '/dsh/home/auma/memory-store.v2.json';
const SESSIONS_ROOT = '/dsh/home/sessions';
const CAPTURE_RANK = { 'web-derived': 0, 'model-generated': 1, 'tool-observed': 2, 'owner-typed': 3, 'owner-signed': 4 };
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result']);
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 16384;
const MAX_RECALL_ROWS = 4096;
const MAX_TEXT_BYTES = 4096;
const MAX_PARENTS = 16;
const MAX_ANCESTRY = 256;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bytes(value) { return Buffer.byteLength(String(value), 'utf8'); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('INVALID_NUMBER');
    const text = JSON.stringify(value);
    if (text === undefined) fail('INVALID_JSON_VALUE');
    return text;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function isId(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('INVALID_BUDGET');
  return value;
}
function textField(value, maximum, required) {
  if (typeof value !== 'string' || bytes(value) > maximum || (required && !value.trim())) fail('INVALID_TEXT');
  return value;
}
function stringList(value, maximum) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || bytes(item) > 512)) fail('INVALID_STRING_LIST');
  return [...new Set(value)].sort();
}
function keyAliases(value) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) fail('ALIAS_BUDGET_EXCEEDED');
  value.forEach(alias => textField(alias, 2048, true));
  return [...new Set(value)].sort();
}
function getFs(ctx) { return ctx && ctx.fs && typeof ctx.fs.readFileSync === 'function' ? ctx.fs : nodeFs; }
function readBounded(fs, file, maximum) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximum) fail('FILE_BUDGET_EXCEEDED');
  const text = String(fs.readFileSync(file, 'utf8'));
  if (bytes(text) > maximum) fail('FILE_BUDGET_EXCEEDED');
  return text;
}
function captureSource(ctx) {
  if (ctx && ctx.captureTaint === true) return 'web-derived';
  return ctx && Object.hasOwn(CAPTURE_RANK, ctx.captureSource) ? ctx.captureSource : 'model-generated';
}
function rootsFor(memoryId, anchor, parents) {
  if (parents.length) return [...new Set(parents.flatMap(parent => parent.ancestry))].sort();
  return [anchor ? 'session:' + anchor.sessionId + ':' + anchor.headerHash : 'memory:' + memoryId];
}
function recordDigest(record) {
  const { recordHash, ...payload } = record;
  return sha256(canonicalJson(payload));
}
function createRecord(input, parents, capture, createdAt) {
  const fact = textField(input.fact, MAX_TEXT_BYTES, true);
  const source = textField(input.source, 2048, true);
  const parentIds = parents.map(parent => parent.memoryId).sort();
  if (parentIds.length > MAX_PARENTS || new Set(parentIds).size !== parentIds.length) fail('INVALID_PARENTS');
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('INVALID_CREATED_AT');
  const memoryId = sha256(canonicalJson({ fact, source, createdAt, parents: parentIds }));
  let trustClamp = Math.min(CAPTURE_RANK[capture], ...parents.map(parent => parent.trustClamp));
  if (input.trustClamp !== undefined) {
    if (typeof input.trustClamp !== 'number' || !Number.isFinite(input.trustClamp) || input.trustClamp < 0 || input.trustClamp > 4) fail('INVALID_TRUST_CLAMP');
    trustClamp = Math.min(trustClamp, input.trustClamp);
  }
  const record = {
    memoryId, id: memoryId, key: textField(input.key || 'fact-' + createdAt, 2048, true),
    kind: input.kind || 'fact', fact, text: fact, source, createdAt, parents: parentIds,
    ancestry: rootsFor(memoryId, input.sourceAnchor, parents), captureSource: capture, trustClamp,
    tags: stringList(input.tags, 32),
    importance: typeof input.importance === 'number' && Number.isFinite(input.importance) ? Math.max(1, Math.min(5, input.importance)) : 3,
    ...(input.corrects ? { corrects: input.corrects } : {}),
    ...(input.tombstones ? { tombstones: input.tombstones } : {}),
    ...(input.sourceAnchor ? { sourceAnchor: input.sourceAnchor } : {}),
    ...(input.legacyEntry ? { legacyEntry: input.legacyEntry } : {}),
  };
  if (record.ancestry.length > MAX_ANCESTRY) fail('ANCESTRY_BUDGET_EXCEEDED');
  record.recordHash = recordDigest(record);
  return record;
}
function verifyStore(store) {
  if (!isObject(store) || store.version !== 2 || !Array.isArray(store.facts) || !Array.isArray(store.sessionChunks)) fail('STORE_CORRUPT');
  const rows = [...store.facts, ...store.sessionChunks];
  if (rows.length > MAX_RECORDS) fail('STORE_RECORD_BUDGET_EXCEEDED');
  const byId = new Map();
  for (const record of rows) {
    if (!isObject(record) || !isId(record.memoryId) || record.id !== record.memoryId || byId.has(record.memoryId)) fail('STORE_CORRUPT');
    if (!['fact', 'correction', 'tombstone', 'session-chunk'].includes(record.kind)) fail('STORE_CORRUPT');
    textField(record.fact, MAX_TEXT_BYTES, true); textField(record.source, 2048, true); textField(record.key, 2048, true);
    if (record.aliases !== undefined && (canonicalJson(keyAliases(record.aliases)) !== canonicalJson(record.aliases) || !record.aliases.includes(record.key))) fail('STORE_CORRUPT');
    if (record.legacyEntries !== undefined && (!Array.isArray(record.legacyEntries) || record.legacyEntries.length < 1 || record.legacyEntries.length > MAX_RECORDS || record.legacyEntries.some(entry => !isObject(entry)))) fail('STORE_CORRUPT');
    if (record.text !== record.fact || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) fail('STORE_CORRUPT');
    if (!Array.isArray(record.parents) || record.parents.length > MAX_PARENTS || record.parents.some(id => !isId(id)) || canonicalJson(record.parents) !== canonicalJson([...new Set(record.parents)].sort())) fail('STORE_CORRUPT');
    if (!Object.hasOwn(CAPTURE_RANK, record.captureSource) || typeof record.trustClamp !== 'number' || !Number.isFinite(record.trustClamp) || record.trustClamp < 0 || record.trustClamp > 4) fail('STORE_CORRUPT');
    if (!Array.isArray(record.ancestry) || record.ancestry.length > MAX_ANCESTRY || record.ancestry.some(root => typeof root !== 'string')) fail('STORE_CORRUPT');
    if (canonicalJson(stringList(record.tags, 32)) !== canonicalJson(record.tags)) fail('STORE_CORRUPT');
    if (typeof record.importance !== 'number' || !Number.isFinite(record.importance) || record.importance < 1 || record.importance > 5) fail('STORE_CORRUPT');
    if (record.kind === 'correction' ? !record.parents.includes(record.corrects) : record.corrects !== undefined) fail('STORE_CORRUPT');
    if (record.kind === 'tombstone' ? !record.parents.includes(record.tombstones) : record.tombstones !== undefined) fail('STORE_CORRUPT');
    if (record.kind === 'session-chunk') {
      const anchor = record.sourceAnchor;
      if (!isObject(anchor) || typeof anchor.file !== 'string' || !anchor.file.startsWith(SESSIONS_ROOT + '/') || typeof anchor.sessionId !== 'string' || !Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || typeof anchor.messageId !== 'string' || !isId(anchor.headerHash) || anchor.textHash !== sha256(record.fact)) fail('STORE_CORRUPT');
    } else if (record.sourceAnchor !== undefined) fail('STORE_CORRUPT');
    if (record.memoryId !== sha256(canonicalJson({ fact: record.fact, source: record.source, createdAt: record.createdAt, parents: record.parents })) || record.recordHash !== recordDigest(record)) fail('STORE_CORRUPT');
    byId.set(record.memoryId, record);
  }
  const visiting = new Set(); const visited = new Set(); const depthById = new Map();
  function visit(record, depth) {
    if (depth > 64 || visiting.has(record.memoryId)) fail('ANCESTRY_INVALID');
    if (visited.has(record.memoryId)) return;
    visiting.add(record.memoryId);
    const parents = record.parents.map(id => { const parent = byId.get(id); if (!parent) fail('PARENT_MISSING'); visit(parent, depth + 1); return parent; });
    const ancestryDepth = parents.reduce((longest, parent) => Math.max(longest, depthById.get(parent.memoryId) + 1), 0);
    if (ancestryDepth > 64) fail('ANCESTRY_INVALID');
    depthById.set(record.memoryId, ancestryDepth);
    if (record.trustClamp > Math.min(CAPTURE_RANK[record.captureSource], ...parents.map(parent => parent.trustClamp))) fail('TRUST_INCREASE_REFUSED');
    if (canonicalJson(record.ancestry) !== canonicalJson(rootsFor(record.memoryId, record.sourceAnchor, parents))) fail('ANCESTRY_INVALID');
    for (const target of [record.corrects, record.tombstones]) if (target && byId.get(target).kind === 'tombstone') fail('INVALID_TARGET');
    visiting.delete(record.memoryId); visited.add(record.memoryId);
  }
  rows.forEach(record => visit(record, 0));
  const supersededBy = new Map(); const tombstonedBy = new Map();
  for (const record of rows) {
    if (record.corrects) {
      if (supersededBy.has(record.corrects)) fail('CORRECTION_FORK');
      supersededBy.set(record.corrects, record.memoryId);
    }
    if (record.tombstones) tombstonedBy.set(record.tombstones, record.memoryId);
  }
  const deadMemo = new Map();
  function isDead(record) {
    if (deadMemo.has(record.memoryId)) return deadMemo.get(record.memoryId);
    const dead = tombstonedBy.has(record.memoryId) || record.parents.some(id => isDead(byId.get(id)));
    deadMemo.set(record.memoryId, dead); return dead;
  }
  function isActive(record) { return record.kind !== 'tombstone' && !supersededBy.has(record.memoryId) && !isDead(record); }
  return { rows, byId, supersededBy, tombstonedBy, isDead, isActive };
}
function loadStore(fs) {
  const legacyText = fs.existsSync(LEGACY_PATH) ? readBounded(fs, LEGACY_PATH, MAX_STORE_BYTES) : null;
  const legacyDigest = legacyText === null ? null : sha256(legacyText);
  const baseText = fs.existsSync(STORE_PATH) ? readBounded(fs, STORE_PATH, MAX_STORE_BYTES) : null;
  let store;
  if (baseText !== null) {
    try { store = JSON.parse(baseText); } catch { fail('STORE_CORRUPT'); }
    if (!isObject(store) || store.legacyDigest !== legacyDigest) fail('LEGACY_STORE_MOVED');
  } else {
    store = { version: 2, legacyDigest, facts: [], sessionChunks: [], index: null };
    if (legacyText !== null) {
      let legacy;
      try { legacy = JSON.parse(legacyText); } catch { fail('LEGACY_STORE_CORRUPT'); }
      if (!isObject(legacy) || legacy.version !== 1 || !Array.isArray(legacy.facts) || !Array.isArray(legacy.sessionChunks)) fail('LEGACY_STORE_CORRUPT');
      store.legacySessionChunks = legacy.sessionChunks;
      store.legacyLastIndexedAt = legacy.lastIndexedAt || 0;
      if (legacy.facts.length > MAX_RECORDS) fail('STORE_RECORD_BUDGET_EXCEEDED');
      const candidates = legacy.facts.map((entry, index) => {
        if (!isObject(entry)) fail('LEGACY_STORE_CORRUPT');
        return createRecord({ ...entry, fact: entry.fact || entry.text, source: typeof entry.source === 'string' && entry.source ? entry.source : 'legacy:agent', key: entry.key || entry.id || 'legacy-' + index, kind: 'fact', legacyEntry: entry }, [], 'model-generated', Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : 0);
      });
      const groups = new Map();
      for (const candidate of candidates) {
        const group = groups.get(candidate.memoryId) || [];
        group.push(candidate); groups.set(candidate.memoryId, group);
      }
      store.facts = [...groups.keys()].sort().map(memoryId => {
        const group = groups.get(memoryId).sort((left, right) => {
          const a = canonicalJson(left.legacyEntry); const b = canonicalJson(right.legacyEntry);
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const record = group[0];
        record.aliases = keyAliases(group.map(candidate => candidate.key));
        record.key = record.aliases[0];
        record.legacyEntries = group.map(candidate => candidate.legacyEntry);
        record.recordHash = recordDigest(record);
        return record;
      });
    }
  }
  verifyStore(store);
  return { store, baseText, legacyDigest, known: baseText !== null || legacyText !== null };
}
function saveStore(fs, loaded, effects) {
  verifyStore(loaded.store);
  const text = canonicalJson(loaded.store) + '\n';
  if (bytes(text) > MAX_STORE_BYTES) fail('STORE_BYTE_BUDGET_EXCEEDED');
  function checkBase() {
    const current = fs.existsSync(STORE_PATH) ? readBounded(fs, STORE_PATH, MAX_STORE_BYTES) : null;
    const legacy = fs.existsSync(LEGACY_PATH) ? sha256(readBounded(fs, LEGACY_PATH, MAX_STORE_BYTES)) : null;
    if (current !== loaded.baseText || legacy !== loaded.legacyDigest) fail('STORE_MOVED');
  }
  checkBase();
  if (typeof fs.renameSync !== 'function') fail('ATOMIC_RENAME_UNAVAILABLE');
  fs.mkdirSync('/dsh/home/auma', { recursive: true });
  const temporary = STORE_PATH + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    if (readBounded(fs, temporary, MAX_STORE_BYTES) !== text) fail('STORE_WRITE_UNVERIFIED');
    checkBase();
    effects.memorySaved = null;
    fs.renameSync(temporary, STORE_PATH);
    if (readBounded(fs, STORE_PATH, MAX_STORE_BYTES) !== text) fail('STORE_WRITE_UNVERIFIED');
    effects.memorySaved = true;
  } finally {
    if (fs.existsSync(temporary) && typeof fs.unlinkSync === 'function') fs.unlinkSync(temporary);
  }
  loaded.baseText = text; loaded.known = true;
}
function sessionOptions(input) {
  return {
    files: boundedInteger(input.maxSessionFiles, 64, 256),
    fileBytes: boundedInteger(input.maxSessionBytes, 512 * 1024, 2 * 1024 * 1024),
    chunks: boundedInteger(input.maxSessionChunks, 2000, 4096),
  };
}
function scanSessions(fs, input) {
  const options = sessionOptions(input); const entries = []; const activeIds = []; const gaps = new Set();
  let directories = 0; let directoryEntries = 0; let scannedFiles = 0; let totalBytes = 0;
  function parseSession(file) {
    const before = fs.statSync(file);
    if (before.size > options.fileBytes || totalBytes + before.size > 8 * 1024 * 1024) fail('SESSION_BYTE_BUDGET');
    const raw = readBounded(fs, file, options.fileBytes); totalBytes += bytes(raw);
    const after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SESSION_MOVED');
    if (!raw.endsWith('\n')) fail('SESSION_INCOMPLETE_TAIL');
    const lines = raw.split('\n'); lines.pop();
    if (lines.length > 10001) fail('SESSION_ROW_BUDGET');
    const header = JSON.parse(lines.shift());
    if (!isObject(header) || header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string' || !header.id || bytes(header.id) > 256) fail('SESSION_FORMAT_UNSUPPORTED');
    const headerHash = sha256(canonicalJson(header)); const surface = [];
    for (let index = 0; index < lines.length; index += 1) {
      const event = JSON.parse(lines[index]);
      if (!isObject(event) || event.seq !== index || typeof event.type !== 'string' || !Number.isSafeInteger(event.time) || event.time < 0) fail('SESSION_EVENT_INVALID');
      if (!SURFACE_TYPES.has(event.type)) { if (event.surfaceOp !== undefined) fail('SESSION_SURFACE_UNSUPPORTED'); continue; }
      if (!isObject(event.data)) fail('SESSION_EVENT_INVALID');
      if (event.surfaceOp === 'append') surface.push(event);
      else {
        const op = event.surfaceOp;
        if (!isObject(op) || op.op !== 'replace') fail('SESSION_SURFACE_INVALID');
        const start = surface.findIndex(row => row.seq === op.startSeq); const end = surface.findIndex(row => row.seq === op.endSeq);
        if (start < 0 || end < start) fail('SESSION_SURFACE_INVALID');
        surface.splice(start, end - start + 1, event);
      }
    }
    const result = [];
    for (const event of surface) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      const message = event.type === 'user/message' ? event.data : event.data.message;
      if (!isObject(message) || !Array.isArray(message.content) || typeof message.id !== 'string' || !message.id || bytes(message.id) > 512) fail('SESSION_MESSAGE_INVALID');
      const role = event.type === 'user/message' ? 'user' : 'assistant';
      if (message.role !== role) fail('SESSION_MESSAGE_INVALID');
      const fact = message.content.filter(part => isObject(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
      if (!fact.trim()) continue;
      if (bytes(fact) > MAX_TEXT_BYTES) { gaps.add('SESSION_TEXT_BUDGET'); continue; }
      const sourceAnchor = { file, sessionId: header.id, headerHash, seq: event.seq, messageId: message.id, role, textHash: sha256(fact) };
      const source = file + '#session=' + encodeURIComponent(header.id) + '&header=' + headerHash + '&seq=' + event.seq + '&message=' + encodeURIComponent(message.id);
      const capture = role === 'user' && isObject(message.source) && message.source.kind === 'user' ? 'tool-observed' : 'model-generated';
      result.push(createRecord({ kind: 'session-chunk', key: 'session:' + header.id + ':' + event.seq, fact, source, sourceAnchor, tags: ['session-log', header.id, role] }, [], capture, event.time));
    }
    return result;
  }
  function walk(directory, depth) {
    if (++directories > 128 || depth > 8) { gaps.add('SESSION_DIRECTORY_BUDGET'); return; }
    let names;
    try { names = fs.readdirSync(directory).map(String).sort(); } catch { gaps.add('SESSION_DIRECTORY_UNREADABLE'); return; }
    if (directoryEntries + names.length > 2048) { gaps.add('SESSION_DIRECTORY_ENTRY_BUDGET'); return; }
    directoryEntries += names.length;
    const generations = names.filter(name => /^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/.test(name));
    const hasPlain = generations.includes('session.v4.jsonl'); const hasCompressed = generations.includes('session.v4.jsonl.zstd');
    if (generations.length && (!hasPlain || hasCompressed)) gaps.add(hasCompressed ? 'SESSION_COMPRESSION_UNSUPPORTED' : 'SESSION_FORMAT_UNSUPPORTED');
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) { gaps.add('SESSION_PATH_INVALID'); continue; }
      const file = directory + '/' + name;
      let stat;
      try { stat = fs.lstatSync(file); } catch { gaps.add('SESSION_STAT_UNREADABLE'); continue; }
      if (stat.isSymbolicLink()) { gaps.add('SESSION_SYMLINK_REFUSED'); continue; }
      if (stat.isDirectory()) { walk(file, depth + 1); continue; }
      if (name !== 'session.v4.jsonl' || hasCompressed) continue;
      if (scannedFiles >= options.files) { gaps.add('SESSION_FILE_BUDGET'); continue; }
      scannedFiles += 1;
      try {
        const records = parseSession(file);
        for (const record of records) {
          if (entries.length >= options.chunks) { gaps.add('SESSION_CHUNK_BUDGET'); break; }
          entries.push(record); activeIds.push(record.memoryId);
        }
      } catch (error) { gaps.add(error.code || 'SESSION_SOURCE_INVALID'); }
    }
  }
  if (!fs.existsSync(SESSIONS_ROOT)) gaps.add('SESSION_STORE_UNINDEXED');
  else {
    try { const stat = fs.lstatSync(SESSIONS_ROOT); if (stat.isSymbolicLink() || !stat.isDirectory()) gaps.add('SESSION_ROOT_INVALID'); else walk(SESSIONS_ROOT, 0); }
    catch { gaps.add('SESSION_ROOT_UNREADABLE'); }
  }
  return { entries, activeIds, scannedFiles, totalBytes, gaps: [...gaps].sort(), complete: gaps.size === 0 };
}

function mergeSessions(store, scan) {
  const byId = new Map(store.sessionChunks.map(record => [record.memoryId, record]));
  for (const record of scan.entries) {
    const previous = byId.get(record.memoryId);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) fail('SESSION_ID_COLLISION');
    if (!previous) { store.sessionChunks.push(record); byId.set(record.memoryId, record); }
  }
  store.index = { at: Date.now(), complete: scan.complete, gaps: scan.gaps, scannedFiles: scan.scannedFiles, totalBytes: scan.totalBytes, activeIds: [...new Set(scan.activeIds)].sort() };
}
function nextCreatedAt(store) {
  return Math.max(Date.now(), [...store.facts, ...store.sessionChunks].reduce((latest, record) => Math.max(latest, record.createdAt + 1), 0));
}
function appendMemory(store, input, ctx, requestedAction) {
  const view = verifyStore(store);
  const isTombstone = requestedAction === 'tombstone' || requestedAction === 'forget';
  let targetId = isTombstone ? (input.tombstones || input.memoryId) : input.corrects;
  if (requestedAction === 'correct') targetId = targetId || input.memoryId;
  if ((isTombstone || requestedAction === 'correct') && !targetId) fail('TARGET_REQUIRED');
  if (!targetId && input.key) {
    const matching = store.facts.filter(record => (record.key === input.key || (record.aliases || []).includes(input.key)) && view.isActive(record));
    if (matching.length > 1) fail('KEY_AMBIGUOUS');
    if (matching.length) targetId = matching[0].memoryId;
  }
  const target = targetId ? view.byId.get(targetId) : null;
  if (targetId && (!isId(targetId) || !target || target.kind === 'tombstone')) fail('TARGET_MISSING');
  if (isTombstone && view.tombstonedBy.has(targetId)) return view.byId.get(view.tombstonedBy.get(targetId));
  if (target && !isTombstone && !view.isActive(target)) fail('TARGET_NOT_ACTIVE');
  const parentIds = [...new Set([...stringList(input.parents, MAX_PARENTS), ...(targetId ? [targetId] : [])])].sort();
  if (parentIds.length > MAX_PARENTS || parentIds.some(id => !isId(id))) fail('INVALID_PARENTS');
  const parents = parentIds.map(id => {
    const record = view.byId.get(id);
    if (!record) fail('PARENT_MISSING');
    if (!isTombstone && !view.isActive(record)) fail('PARENT_NOT_ACTIVE');
    return record;
  });
  const createdAt = nextCreatedAt(store);
  const entry = createRecord({
    fact: isTombstone ? (input.fact || input.text || '[tombstone:' + targetId + ']') : (input.fact || input.text),
    key: input.key || (target && target.key) || 'fact-' + createdAt,
    source: input.source || 'agent', tags: input.tags, importance: input.importance,
    trustClamp: input.trustClamp,
    kind: isTombstone ? 'tombstone' : target ? 'correction' : 'fact',
    ...(isTombstone ? { tombstones: targetId } : target ? { corrects: targetId } : {}),
  }, parents, captureSource(ctx), createdAt);
  if (target && target.aliases) { entry.aliases = keyAliases([...target.aliases, entry.key]); entry.recordHash = recordDigest(entry); }
  store.facts.push(entry); verifyStore(store); return entry;
}
function publicEntry(record) {
  const { legacyEntry, legacyEntries, recordHash, ...entry } = record;
  return entry;
}
function anchorsFor(record, view) {
  const visited = new Set(); const anchors = [];
  function walk(current) {
    if (visited.has(current.memoryId)) return;
    visited.add(current.memoryId);
    if (current.sourceAnchor || current.parents.length === 0) anchors.push({ memoryId: current.memoryId, source: current.source, createdAt: current.createdAt, ...(current.sourceAnchor || {}) });
    current.parents.forEach(id => walk(view.byId.get(id)));
  }
  walk(record);
  return anchors.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}
function correctionLinks(record, view) {
  const links = []; let current = record;
  while (current.corrects) { links.push({ memoryId: current.corrects, supersededBy: current.memoryId }); current = view.byId.get(current.corrects); }
  return links;
}
function tokens(text) { return String(text).toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter(word => word.length >= 2); }
function grams(text) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, ' ').trim(); const result = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) result.add(normalized.slice(index, index + 3));
  return result;
}
function score(record, queryTokens, queryGrams, now) {
  const text = [record.key, ...(record.aliases || []), record.fact, ...record.tags, record.source].join(' ').toLowerCase();
  const entryTokens = new Set(tokens(text)); const entryGrams = grams(text);
  let value = 0; let overlap = 0;
  for (const token of queryTokens) value += entryTokens.has(token) ? 2.5 : text.includes(token) ? 1.2 : 0;
  for (const gram of queryGrams) if (entryGrams.has(gram)) overlap += 1;
  value += overlap / Math.max(queryGrams.size, 1) * 3;
  if (value === 0) return 0;
  value += 0.5 / (1 + Math.max(0, now - record.createdAt) / 3600000 * 0.05);
  return Math.round(value * (record.kind === 'session-chunk' ? 1 : 2.5) * 1000) / 1000;
}
function recall(fs, loaded, input) {
  const query = textField(input.query, MAX_TEXT_BYTES, true).trim();
  const limit = boundedInteger(input.limit, 8, 25); if (limit < 1) fail('INVALID_LIMIT');
  const budgetBytes = boundedInteger(input.budgetBytes, 16384, 65536);
  const gaps = new Set(); let scan = null;
  if (!loaded.known) gaps.add('STORE_UNINITIALIZED');
  if (input.includeSessions !== false) {
    scan = scanSessions(fs, input); scan.gaps.forEach(gap => gaps.add(gap));
    mergeSessions(loaded.store, scan);
  }
  const view = verifyStore(loaded.store); const activeSessionIds = new Set(scan ? scan.activeIds : []);
  const candidates = view.rows.filter(record => record.kind !== 'tombstone' && !view.isDead(record) && (record.kind !== 'session-chunk' || activeSessionIds.has(record.memoryId)));
  let ranked = [];
  if (candidates.length > MAX_RECALL_ROWS) gaps.add('RECALL_ROW_BUDGET');
  else {
    const queryTokens = tokens(query); const queryGrams = grams(query); const now = Date.now();
    const terminalHits = new Map();
    for (const record of candidates) {
      let terminal = record;
      while (view.supersededBy.has(terminal.memoryId)) terminal = view.byId.get(view.supersededBy.get(terminal.memoryId));
      if (!view.isActive(terminal)) continue;
      const value = score(record, queryTokens, queryGrams, now);
      const previous = terminalHits.get(terminal.memoryId);
      if (value > 0 && (!previous || value > previous.score)) terminalHits.set(terminal.memoryId, { record: terminal, score: value });
    }
    ranked = [...terminalHits.values()].sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt || left.record.memoryId.localeCompare(right.record.memoryId)).slice(0, limit);
  }
  const hits = []; let usedBytes = 0;
  for (const candidate of ranked) {
    const record = candidate.record;
    const hit = {
      kind: record.kind === 'session-chunk' ? 'session-chunk' : 'fact', memoryId: record.memoryId,
      key: record.key, text: record.fact, tags: record.tags, source: record.source, score: candidate.score,
      entry: publicEntry(record), anchors: anchorsFor(record, view), supersededBy: correctionLinks(record, view),
    };
    // Every hit appears twice: in hits and in one compatibility category array.
    const cost = bytes(JSON.stringify(hit)) * 2;
    if (usedBytes + cost > budgetBytes) { gaps.add('RECALL_ANCHOR_BUDGET'); break; }
    usedBytes += cost; hits.push(hit);
  }
  return {
    ok: true, action: 'recall', status: gaps.size ? 'UNDETERMINED' : hits.length ? 'FOUND' : 'EMPTY', query,
    totalFacts: loaded.store.facts.filter(record => view.isActive(record)).length,
    totalSessionChunks: scan ? new Set(scan.activeIds).size : 0,
    hits, factHits: hits.filter(hit => hit.kind === 'fact'), sessionHits: hits.filter(hit => hit.kind === 'session-chunk'),
    coverage: { complete: gaps.size === 0, gaps: [...gaps].sort(), scannedSessionFiles: scan ? scan.scannedFiles : 0 },
    budget: { maxBytes: budgetBytes, usedBytes, scope: 'Serialized hit records including complete anchors and duplicated compatibility arrays; response metadata is separate.' },
    memoryIsAuthority: false,
  };
}
const DAG_DIR = '/dsh/home/auma/memory/dag';
const DAG_HEAD = DAG_DIR + '/HEAD.json';
const DAG_RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl';
function dagReadHead(fs) {
  let text;
  try { text = fs.readFileSync(DAG_HEAD, 'utf8'); }
  catch (error) { if (error && error.code === 'ENOENT') return { heads: [], count: 0, updatedAt: 0 }; fail('DAG_HEAD_UNREADABLE'); }
  let head;
  try { head = JSON.parse(text); } catch (error) { fail('DAG_HEAD_UNREADABLE'); }
  if (!isObject(head) || !Array.isArray(head.heads) || head.heads.some(id => !isId(id)) || new Set(head.heads).size !== head.heads.length || !Number.isSafeInteger(head.count) || head.count < 0) fail('DAG_HEAD_UNREADABLE');
  return head;
}
function dagWriteHead(fs, head, effect) {
  const tmp = DAG_HEAD + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(head, null, 2));
  effect.headSaved = null;
  fs.renameSync(tmp, DAG_HEAD);
  effect.headSaved = true;
}
function dagReadNode(fs, id) {
  try { return JSON.parse(fs.readFileSync(DAG_DIR + '/' + id + '.json', 'utf8')); }
  catch (error) { return null; } // Walkers report missing or unreadable nodes as gaps.
}
function dagParents(node) {
  if (!isObject(node) || (!Object.hasOwn(node, 'parentIds') && !Object.hasOwn(node, 'parents'))) fail('DAG_SCHEMA_UNREADABLE');
  for (const field of ['parentIds', 'parents']) {
    if (Object.hasOwn(node, field) && (!Array.isArray(node[field]) || node[field].some(id => !isId(id)))) fail('DAG_SCHEMA_UNREADABLE');
  }
  if (Object.hasOwn(node, 'parentIds') && Object.hasOwn(node, 'parents') && canonicalJson(node.parentIds) !== canonicalJson(node.parents)) fail('DAG_SCHEMA_UNREADABLE');
  return Object.hasOwn(node, 'parentIds') ? node.parentIds : node.parents;
}
function explicitDagParents(input) {
  if (!input || !Object.hasOwn(input, 'dagParents')) return null;
  if (!Array.isArray(input.dagParents) || input.dagParents.length > MAX_PARENTS || input.dagParents.some(id => !isId(id)) || new Set(input.dagParents).size !== input.dagParents.length) fail('INVALID_DAG_PARENTS');
  return input.dagParents.slice();
}
function dagReceiptHead(fs) {
  let text;
  try { text = fs.readFileSync(DAG_RECEIPTS, 'utf8'); }
  catch (error) { if (error && error.code === 'ENOENT') return null; fail('DAG_RECEIPTS_UNREADABLE'); }
  const lines = String(text).trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  let leaf;
  try { leaf = JSON.parse(lines[lines.length - 1]); } catch (error) { fail('DAG_RECEIPTS_UNREADABLE'); }
  if (!isObject(leaf) || !isId(leaf.leafHash)) fail('DAG_RECEIPTS_UNREADABLE');
  return leaf.leafHash;
}
function dagNodeId(node) { const copy = Object.assign({}, node); delete copy.id; return sha256(canonicalJson(copy)); }
// Each operation owns its pending receipt anchors; overlapping calls cannot drain another call's nodes.
function dagPayloadHash(node) { return sha256(canonicalJson({ kind: node.kind, key: node.key, content: node.content, tags: node.tags })); }
function dagAnchorData(node) {
  return { nodeId: node.id, kind: node.kind, parentIds: dagParents(node).slice(), payloadHash: dagPayloadHash(node) };
}
async function anchorPendingDagNodes(ctx, nodes) {
  if (!nodes.length) return null;
  const organs = ctx && ctx.organs;
  if (!organs || typeof organs.call !== 'function') return { ok: false, anchored: 0, pending: nodes.map(node => node.id), receipts: [], error: 'RECEIPTS_ORGAN_UNAVAILABLE' };
  const anchored = [];
  for (const node of nodes) {
    try {
      const result = await organs.call('seed-receipts', { action: 'append', kind: 'memory.dag.append', data: dagAnchorData(node) });
      if (!result || result.ok !== true || !isObject(result.receipt) || !Number.isSafeInteger(result.receipt.seq) || result.receipt.seq < 1 || !isId(result.receipt.leafHash)) return { ok: false, anchored: anchored.length, pending: nodes.slice(anchored.length).map(item => item.id), receipts: anchored, error: (result && result.error) || 'RECEIPT_NOT_ACKNOWLEDGED' };
      anchored.push({ nodeId: node.id, seq: result.receipt.seq, leafHash: result.receipt.leafHash });
    } catch (error) {
      return { ok: false, anchored: anchored.length, pending: nodes.slice(anchored.length).map(item => item.id), receipts: anchored, error: String(error && error.message || error) };
    }
  }
  return { ok: true, anchored: anchored.length, receipts: anchored };
}
// Memory, DAG files, HEAD, receipts, and durable flush are separate writes. Never roll back
// already written records: false means incomplete; null means a write's outcome is unknown.
function dagAppend(fs, entry, input, effects) {
  try {
    const head = dagReadHead(fs);
    const parents = explicitDagParents(input);
    const node = {
      parentIds: parents || head.heads.slice(), kind: entry.kind || 'fact', key: entry.key || null,
      content: entry.fact || null, tags: Array.isArray(entry.tags) ? entry.tags : [],
      createdAt: entry.createdAt || Date.now(), receiptHash: dagReceiptHead(fs),
      ticketId: (input && input.ticketId) || null, tombstoneOf: entry.tombstones || null,
      memoryId: entry.memoryId || null,
    };
    const id = dagNodeId(node); node.id = id;
    const path = DAG_DIR + '/' + id + '.json';
    const isNew = !fs.existsSync(path);
    const effect = { nodeId: id, nodeSaved: !isNew, headSaved: false };
    effects.dagWrites.push(effect);
    fs.mkdirSync(DAG_DIR, { recursive: true });
    if (isNew) {
      effect.nodeSaved = null;
      fs.writeFileSync(path, JSON.stringify(node, null, 2));
      effect.nodeSaved = true;
      effects.pending.push(node);
    }
    dagWriteHead(fs, { heads: [id], count: head.count + (isNew ? 1 : 0), updatedAt: Date.now(), lastMemoryId: node.memoryId }, effect);
    return { id, parentIds: node.parentIds, kind: node.kind, key: node.key, receiptHash: node.receiptHash, ticketId: node.ticketId, created: isNew, path };
  } catch (cause) { throw dagAppendError(cause); }
}
function dagAppendError(cause) {
  const error = new Error('DAG_APPEND_FAILED', { cause });
  error.code = 'DAG_APPEND_FAILED'; error.dagError = cause.code || cause.message || 'DAG_ERROR'; return error;
}
function dagVerify(fs) {
  const head = dagReadHead(fs);
  const seen = new Set(); const memoryIds = new Set(); const errors = []; const stack = head.heads.slice();
  let nodes = 0;
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = dagReadNode(fs, id);
    if (!node) { errors.push({ id, error: 'MISSING_NODE' }); continue; }
    nodes += 1;
    const actual = dagNodeId(node);
    if (actual !== id) errors.push({ id, error: 'SHA_MISMATCH', expected: id, actual });
    let parents;
    try { parents = dagParents(node); }
    catch (error) { errors.push({ id, error: 'DAG_SCHEMA_UNREADABLE' }); continue; }
    if (actual === id && isId(node.memoryId)) memoryIds.add(node.memoryId);
    stack.push(...parents);
  }
  const declared = head.count;
  let orphanIds = [];
  try { orphanIds = fs.readdirSync(DAG_DIR).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(0, -5)).filter(id => !seen.has(id)).sort(); }
  catch (error) { if (!error || error.code !== 'ENOENT' || nodes || declared) errors.push({ error: 'DAG_DIRECTORY_UNREADABLE' }); }
  if (declared !== nodes || orphanIds.length) errors.push({ error: 'DAG_UNREACHABLE_ORPHANS', declaredCount: declared, reachableNodes: nodes, orphanIds });
  const memoryWithoutDag = [];
  try {
    // Session index rows are source material, not DAG-appended facts.
    for (const record of loadStore(fs).store.facts) if (!memoryIds.has(record.memoryId)) {
      memoryWithoutDag.push(record.memoryId); errors.push({ error: 'DAG_MEMORY_NODE_MISSING', memoryId: record.memoryId });
    }
  } catch (error) { errors.push({ error: 'DAG_MEMORY_STORE_UNREADABLE', cause: error.code || 'STORE_UNREADABLE' }); }
  return { ok: errors.length === 0, action: 'dag_verify', heads: head.heads, headCount: head.count, declaredCount: declared, reachableNodes: nodes, memoryWithoutDag, orphanIds, gaps: [...new Set(errors.map(error => error.error))], errors, dagDir: DAG_DIR, headPath: DAG_HEAD };
}
// A repeated tombstone must confirm the previously written node and receipt, not turn a
// prior partial failure into success. Missing evidence is reported without replaying writes.
function existingDagAnchor(fs, entry, effects) {
  try {
    const verification = dagVerify(fs);
    if (!verification.ok) fail(verification.memoryWithoutDag.includes(entry.memoryId) ? 'DAG_MEMORY_NODE_MISSING' : verification.gaps[0]);
    const seen = new Set(); const stack = verification.heads.slice(); const candidates = [];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const node = dagReadNode(fs, id);
      if (!node || dagNodeId(node) !== id) fail('DAG_NODE_UNREADABLE');
      stack.push(...dagParents(node));
      if (node.memoryId === entry.memoryId && node.kind === entry.kind && node.key === entry.key && node.content === entry.fact && node.createdAt === entry.createdAt && node.tombstoneOf === (entry.tombstones || null) && canonicalJson(node.tags) === canonicalJson(entry.tags)) candidates.push(node);
    }
    if (!candidates.length) fail('DAG_MEMORY_NODE_MISMATCH');
    effects.dagSaved = true;
    let raw;
    try { raw = readBounded(fs, DAG_RECEIPTS, MAX_STORE_BYTES); }
    catch (error) { fail(error.code === 'ENOENT' ? 'DAG_RECEIPT_MISSING' : 'DAG_RECEIPTS_UNREADABLE'); }
    if (!raw.endsWith('\n')) fail('DAG_RECEIPTS_UNREADABLE');
    const lines = raw.split('\n'); lines.pop();
    const priorHashes = new Set(); let previous = '0'.repeat(64); let receipt = null;
    for (let index = 0; index < lines.length; index += 1) {
      let row;
      try { row = JSON.parse(lines[index]); } catch (error) { fail('DAG_RECEIPTS_UNREADABLE'); }
      if (!isObject(row) || row.schema !== 'aukora.receipt.v3' || row.seq !== index + 1 || row.prevHash !== previous || !isId(row.leafHash)) fail('DAG_RECEIPTS_UNREADABLE');
      const { leafHash, ...body } = row;
      if (leafHash !== sha256('\0' + canonicalJson(body))) fail('DAG_RECEIPTS_UNREADABLE');
      if (!receipt && row.kind === 'memory.dag.append' && isObject(row.data)) {
        const node = candidates.find(candidate => candidate.id === row.data.nodeId);
        if (node && canonicalJson(row.data) === canonicalJson(dagAnchorData(node)) && (node.receiptHash === null || priorHashes.has(node.receiptHash))) receipt = { nodeId: node.id, seq: row.seq, leafHash };
      }
      previous = leafHash; priorHashes.add(leafHash);
    }
    if (!receipt) fail('DAG_RECEIPT_MISSING');
    return { ok: true, anchored: 1, receipts: [receipt], existing: true };
  } catch (cause) { throw dagAppendError(cause); }
}
function dagLineage(fs, nodeId) {
  if (nodeId !== undefined && !isId(nodeId)) fail('INVALID_NODE_ID');
  const chain = []; let cursor = nodeId || (dagReadHead(fs).heads[0] || null); const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = dagReadNode(fs, cursor);
    if (!node) { chain.push({ id: cursor, error: 'MISSING_NODE' }); break; }
    let parents;
    try { parents = dagParents(node); }
    catch (error) { chain.push({ id: cursor, error: 'DAG_SCHEMA_UNREADABLE' }); break; }
    if (dagNodeId(node) !== cursor) { chain.push({ id: cursor, error: 'SHA_MISMATCH' }); break; }
    chain.push({ id: node.id, kind: node.kind, key: node.key, parentIds: parents, createdAt: node.createdAt, receiptHash: node.receiptHash, ticketId: node.ticketId });
    cursor = parents[0] || null;
  }
  return { ok: chain.every(link => !link.error), action: 'dag_lineage', nodes: chain.length, chain };
}
function writeEffects() { return { memorySaved: false, memoryIds: [], dagSaved: false, dagWrites: [], pending: [] }; }
function failedOperation(error, action) {
  return { ok: false, status: 'UNDETERMINED', action, error: error.code || 'MEMORY_OPERATION_FAILED',
    ...(error.dagError ? { dagError: error.dagError } : {}), memoryIsAuthority: false };
}
async function finishWrites(result, ctx, effects) {
  if (result.ok) {
    const anchor = await anchorPendingDagNodes(ctx, effects.pending);
    if (anchor) result = { ...result, dagAnchor: anchor, ...(anchor.ok ? {} : { ok: false, status: 'UNDETERMINED', error: 'DAG_APPEND_FAILED', dagError: anchor.error }) };
  } else if (effects.pending.length) {
    result = { ...result, dagAnchor: { ok: false, anchored: 0, pending: effects.pending.map(node => node.id), error: 'DAG_APPEND_INCOMPLETE' } };
  }
  const changed = effects.memorySaved !== false || effects.dagWrites.some(write => write.nodeSaved !== false || write.headSaved !== false);
  const saved = { ...result, memorySaved: effects.memorySaved, memoryIds: effects.memoryIds, dagSaved: effects.dagSaved, dagWrites: effects.dagWrites,
    vfsSaved: result.action === 'dag_write' ? effects.dagSaved : effects.memorySaved, localSaved: false, remoteSaved: false,
    ...(!result.ok && changed ? { outcome: 'partial' } : {}) };
  if (!changed) return saved;
  try {
    const ack = await ctx.snapshots.flush();
    if (!ack || ack.localSaved !== true) throw new Error('DURABLE_FLUSH_UNACKNOWLEDGED');
    return { ...saved, localSaved: true };
  } catch (error) {
    return { ...saved, ok: false, status: 'UNDETERMINED', outcome: 'persistence-unconfirmed', saveError: String(error && error.message || error) };
  }
}
async function dagRun(input, ctx) {
  const action = input && input.action; const effects = writeEffects();
  let result;
  try {
    const fs = getFs(ctx);
    if (action === 'dag_verify') return dagVerify(fs);
    if (action === 'dag_lineage') return dagLineage(fs, input.nodeId);
    if (action !== 'dag_write') return { ok: false, action, error: 'UNKNOWN_ACTION' };
    if (!ctx || !ctx.snapshots || typeof ctx.snapshots.flush !== 'function' || typeof ctx.snapshots.persistenceState !== 'function' || ctx.snapshots.persistenceState().writable !== true) {
      return { ok: false, status: 'UNDETERMINED', action, error: 'DURABLE_PERSISTENCE_UNAVAILABLE', vfsSaved: false, localSaved: false, remoteSaved: false };
    }
    const entry = { kind: 'note', key: input.key || null, fact: input.fact || input.text || null, tags: input.tags || [], createdAt: Date.now(), memoryId: null };
    const node = dagAppend(fs, entry, input, effects); effects.dagSaved = true;
    result = { ok: true, action, node };
  } catch (error) { result = failedOperation(error, action); }
  if (action !== 'dag_write') return result;
  const completed = await finishWrites(result, ctx, effects);
  return { ...completed, anchor: completed.dagAnchor || null };
}

function runMemoryOp(input, ctx, effects) {
  if (!isObject(input)) fail('INVALID_INPUT');
  const fs = getFs(ctx); const loaded = loadStore(fs); const store = loaded.store;
  const action = input.action || (input.fact || input.text ? 'remember' : input.query ? 'recall' : 'stats');
  if (action === 'recall') return recall(fs, loaded, input);
  if (['remember', 'correct', 'tombstone', 'forget'].includes(action)) {
    explicitDagParents(input);
    const previousLength = store.facts.length;
    const entry = appendMemory(store, input, ctx, action);
    effects.memoryIds = [entry.memoryId];
    let existingAnchor = null;
    if (store.facts.length === previousLength) {
      effects.memorySaved = true;
      existingAnchor = existingDagAnchor(fs, entry, effects);
    } else {
      saveStore(fs, loaded, effects);
      dagAppend(fs, entry, input, effects); effects.dagSaved = true;
    }
    return { ok: true, action, entry: publicEntry(entry), totalFacts: store.facts.length, storePath: STORE_PATH, legacyPreserved: true, memoryIsAuthority: false, ...(existingAnchor ? { dagAnchor: existingAnchor } : {}) };
  }
  if (action === 'index_sessions') {
    const scan = scanSessions(fs, input); mergeSessions(store, scan); saveStore(fs, loaded, effects);
    return { ok: true, action, status: scan.complete ? (scan.activeIds.length ? 'FOUND' : 'EMPTY') : 'UNDETERMINED', sessionChunks: scan.activeIds.length, retainedSessionChunks: store.sessionChunks.length, totalFacts: store.facts.length, coverage: store.index, legacyPreserved: true };
  }
  if (action === 'distill') {
    explicitDagParents(input);
    const sessionId = textField(input.sessionId, 256, true);
    const facts = Array.isArray(input.facts) ? input.facts : (input.fact || input.text ? [{ fact: input.fact || input.text, key: input.key, tags: input.tags, source: input.source, importance: input.importance }] : []);
    if (!facts.length || facts.length > 16 || facts.some(fact => !isObject(fact))) fail('DISTILL_REQUIRES_EXPLICIT_FACTS');
    const scan = scanSessions(fs, input);
    if (!scan.complete) return { ok: false, action, status: 'UNDETERMINED', reason: 'SOURCE_INDEX_INCOMPLETE', coverage: { gaps: scan.gaps, scannedFiles: scan.scannedFiles } };
    let anchors = scan.entries.filter(record => record.sourceAnchor.sessionId === sessionId);
    if (input.sourceSeqs !== undefined) {
      if (!Array.isArray(input.sourceSeqs) || !input.sourceSeqs.length || input.sourceSeqs.length > MAX_PARENTS || input.sourceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) fail('INVALID_SOURCE_SEQS');
      const seqs = new Set(input.sourceSeqs); anchors = anchors.filter(record => seqs.has(record.sourceAnchor.seq));
      if (new Set(anchors.map(record => record.sourceAnchor.seq)).size !== seqs.size) fail('SOURCE_ANCHOR_UNAVAILABLE');
    }
    if (!anchors.length || anchors.length > MAX_PARENTS) fail('SOURCE_ANCHOR_SELECTION_REQUIRED');
    mergeSessions(store, scan);
    const view = verifyStore(store);
    if (anchors.some(record => !view.isActive(view.byId.get(record.memoryId)))) fail('SOURCE_ANCHOR_NOT_ACTIVE');
    const entries = facts.map(fact => appendMemory(store, {
      ...fact, fact: fact.fact || fact.text, source: fact.source || 'distill:session:' + sessionId,
      parents: anchors.map(record => record.memoryId), trustClamp: input.trustClamp,
    }, ctx, 'remember'));
    effects.memoryIds = entries.map(entry => entry.memoryId);
    saveStore(fs, loaded, effects);
    for (const entry of entries) dagAppend(fs, entry, input, effects);
    effects.dagSaved = true;
    return { ok: true, action, sessionId, entries: entries.map(publicEntry), sourceAnchors: anchors.map(record => ({ memoryId: record.memoryId, ...record.sourceAnchor })), totalFacts: store.facts.length, memoryIsAuthority: false, legacyPreserved: true };
  }
  if (action !== 'stats') fail('UNKNOWN_ACTION');
  const view = verifyStore(store);
  return {
    ok: true, action: 'stats', status: loaded.known ? 'FOUND' : 'UNDETERMINED', storePath: STORE_PATH,
    totalFacts: store.facts.filter(record => view.isActive(record)).length, totalRecords: view.rows.length,
    totalSessionChunks: store.sessionChunks.length, lastIndexedAt: store.index ? store.index.at : 0,
    legacyFacts: store.facts.filter(record => record.legacyEntry !== undefined).length,
    legacySessionChunks: Array.isArray(store.legacySessionChunks) ? store.legacySessionChunks.length : 0,
    legacyPreserved: true, memoryIsAuthority: false,
  };
}
async function safeRun(input, ctx) {
  const args = input || {};
  const action = args.action || (args.fact || args.text ? 'remember' : args.query ? 'recall' : 'stats');
  const writes = ['remember', 'correct', 'tombstone', 'forget', 'index_sessions', 'distill'].includes(action);
  const effects = writeEffects(); let result;
  try {
    if (writes && (!ctx || !ctx.snapshots || typeof ctx.snapshots.flush !== 'function' || typeof ctx.snapshots.persistenceState !== 'function' || ctx.snapshots.persistenceState().writable !== true)) {
      return { ok: false, status: 'UNDETERMINED', action, vfsSaved: false, localSaved: false, remoteSaved: false, error: 'DURABLE_PERSISTENCE_UNAVAILABLE', memoryIsAuthority: false };
    }
    result = runMemoryOp(args, ctx || {}, effects);
  } catch (error) { result = failedOperation(error, action); }
  return writes ? finishWrites(result, ctx, effects) : result;
}
const PROPERTIES = {
  action: { type: 'string', enum: ['remember', 'correct', 'tombstone', 'forget', 'recall', 'index_sessions', 'distill', 'stats'] },
  key: { type: 'string' }, text: { type: 'string' }, fact: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 32 }, source: { type: 'string' }, importance: { type: 'number' },
  memoryId: { type: 'string' }, corrects: { type: 'string' }, tombstones: { type: 'string' },
  parents: { type: 'array', items: { type: 'string' }, maxItems: MAX_PARENTS },
  trustClamp: { type: 'number', minimum: 0, maximum: 4, description: 'Optional lower trust ceiling; cannot raise caller or ancestor trust.' },
  query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25 }, includeSessions: { type: 'boolean' },
  budgetBytes: { type: 'integer', minimum: 0, maximum: 65536, description: 'Hit payload budget, including source anchors and compatibility duplicates; metadata is separate.' },
  maxSessionFiles: { type: 'integer', minimum: 0, maximum: 256 },
  maxSessionBytes: { type: 'integer', minimum: 0, maximum: 2097152, description: 'Maximum bytes per session file.' },
  maxSessionChunks: { type: 'integer', minimum: 0, maximum: 4096 },
  sessionId: { type: 'string' }, sourceSeqs: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: MAX_PARENTS },
  facts: {
    type: 'array', minItems: 1, maxItems: 16,
    items: { type: 'object', properties: { key: { type: 'string' }, fact: { type: 'string' }, text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' }, importance: { type: 'number' } }, additionalProperties: false },
    description: 'Explicit model-generated summaries to persist with verified session parents; this organ does not make a model call.',
  },
};
function schema(keys, required) {
  return { type: 'object', properties: Object.fromEntries(keys.map(key => [key, PROPERTIES[key]])), ...(required ? { required } : {}), additionalProperties: false };
}
module.exports = {
  name: 'auma-memory-domain',
  description: 'Append-only semantic memory v2 with immutable SHA256 ids, parent-clamped trust, corrections, tombstones, verified session anchors and bounded recall. Original v1 store is preserved. Distill persists explicit summaries, not an implicit model call.',
  parameters: { type: 'object', properties: PROPERTIES, additionalProperties: false },
  setup(ctx) {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') return () => {};
    const disposers = [];
    try {
      const remember = ctx.tools.register('remember', {
        description: 'Store an immutable durable fact. Reusing an active key appends a correction. DAG_APPEND_FAILED can follow a saved memory: inspect memorySaved, dagWrites and localSaved before retrying. Source labels do not grant trust.',
        inputSchema: schema(['key', 'text', 'fact', 'tags', 'source', 'importance', 'parents', 'corrects', 'trustClamp']),
        execute(input) { return Promise.resolve(safeRun({ ...(input || {}), action: 'remember' }, ctx)); },
      });
      if (typeof remember === 'function') disposers.push(remember);
      const recallTool = ctx.tools.register('recall', {
        description: 'Recall active facts and user/assistant prose with complete source anchors. UNDETERMINED indicates incomplete source coverage or insufficient anchor budget.',
        inputSchema: schema(['query', 'limit', 'includeSessions', 'budgetBytes', 'maxSessionFiles', 'maxSessionBytes', 'maxSessionChunks'], ['query']),
        execute(input) { return Promise.resolve(safeRun({ ...(input || {}), action: 'recall' }, ctx)); },
      });
      if (typeof recallTool === 'function') disposers.push(recallTool);
      const dagTool = ctx.tools.register('auma_memory_dag', {
        description: 'Append-only content-addressed DAG layer over memory. dag_verify checks HEAD, node hashes, parent fields, unreachable files and stored facts missing a node; dag_lineage returns causal ancestry; dag_write appends an explicit node linked to a ticket.',
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['dag_verify', 'dag_lineage', 'dag_write'] }, nodeId: { type: 'string' }, key: { type: 'string' }, fact: { type: 'string' }, text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ticketId: { type: 'string' }, dagParents: { type: 'array', items: { type: 'string' } } }, required: ['action'], additionalProperties: false },
        execute(input) { return Promise.resolve(dagRun(input, ctx)); },
      });
      if (typeof dagTool === 'function') disposers.push(dagTool);
    } catch (error) {
      for (const dispose of disposers.splice(0)) dispose();
      throw error;
    }
    return () => { for (const dispose of disposers.splice(0)) dispose(); };
  },
  run(args, ctx) { return Promise.resolve(safeRun(args, ctx)); },
};
