import type { BinaryLike } from 'node:crypto'

interface Archive {
  manifest: Buffer
  pages: Map<string, Buffer>
}

/** SHA-256 digest in hexadecimal. */
export function sha(bytes: BinaryLike): string

/** Read the pinned parent manifest and its English pages from Git. */
export function readArchiveParent(root: string): Archive

/** Rebuild the English archive and expand the substitution records with the original lines. */
export function deriveArchive(
  recordBytes: Buffer,
  oldManifestBytes: Buffer,
  oldPages: ReadonlyMap<string, Buffer>,
): Archive & {
  substitutions: {
    path: string
    line: number
    line_after_switch_removal: number
    old_text: string
    new_text: string
  }[]
}
