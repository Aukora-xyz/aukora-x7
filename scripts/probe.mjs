import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function localFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw Error('Invalid repository path')
  const resolved = realpathSync(resolve(root, path))
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel) || !statSync(resolved).isFile()) throw Error('Expected a repository file')
  return resolved
}

export function probe(root, version = process.versions.node) {
  root = realpathSync(root)
  const claims = JSON.parse(readFileSync(localFile(root, 'claims.json'), 'utf8'))
  if (claims.schema !== 1 || !Array.isArray(claims.claims) || !claims.claims.length) throw Error('Invalid claims file')
  const paths = new Set(claims.claims.flatMap(claim => {
    if (!Array.isArray(claim.where) || !claim.where.length) throw Error('Invalid claim evidence')
    return claim.where
  }))
  const missing = [...paths].filter(p => { try { localFile(root,p); return false } catch { return true } }).sort()
  const lines = readFileSync(localFile(root,'ark/MANIFEST.sha256'),'utf8').trimEnd().split('\n')
  const failed = [], seen = new Set()
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
    if (!match || seen.has(match[2])) { failed.push('invalid manifest entry'); continue }
    seen.add(match[2])
    try {
      const bytes = readFileSync(localFile(root, 'ark/'+match[2]))
      if (createHash('sha256').update(bytes).digest('hex') !== match[1]) failed.push(match[2])
    } catch { failed.push(match[2]) }
  }
  const [major,minor] = version.split('.').map(Number)
  let knownRed = true
  try { localFile(root,'docs/KNOWN-RED-TESTS.md') } catch { knownRed=false }
  return {schema:1,node:{version,minimum:'24.9',meets_minimum:major > 24 || major === 24 && minor >= 9},
    claims:{count:claims.claims.length,paths_missing:missing},ark_manifest:{checked:lines.length,failed},known_red_file_present:knownRed}
}
export function exitCode(result) {
  return result.claims.paths_missing.length || result.ark_manifest.failed.length || !result.known_red_file_present ? 1 : 0
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = probe(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    console.log(JSON.stringify(result))
    process.exitCode = exitCode(result)
  } catch {
    console.log(JSON.stringify({schema:1,error:'probe could not start'}))
    process.exitCode = 2
  }
}
