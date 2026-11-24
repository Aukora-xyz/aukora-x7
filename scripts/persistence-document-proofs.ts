/** Machine records checked on the two independently stored copies in the public parent. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const proofDigest = '66b25debcd47096bf3877c9ec9399bcf70df76684d2808e648e576e03fb722dc'
type Evidence = { blocks: Record<string,string> }
const cache = new Map<string, Record<string,Evidence>>()

export function publishedDocument(root: string, path: string): Evidence | undefined {
  const file = join(root, 'scripts/persistence-document-proofs.json')
  if (!existsSync(file)) return undefined
  let pages = cache.get(file)
  if (!pages) {
    const bytes = readFileSync(file)
    if (digest(bytes) !== proofDigest) throw Error('Persistence document evidence pin differs')
    pages = JSON.parse(bytes.toString('utf8')).pages as Record<string,Evidence>
    cache.set(file,pages)
  }
  return Object.hasOwn(pages,path) ? pages[path] : undefined
}

export function checkMachineRecord(evidence: Evidence, kind: string, body: string): void {
  if (digest(body) !== evidence.blocks[kind]) throw Error(kind+' machine record differs from the sealed public evidence')
}
