/** Render published persistence documents without Git or file mutation. */

/** One repository-relative generated file and its complete UTF-8 content. */
export interface PersistenceArtifact {
  readonly path: string
  readonly content: string
}

/** Return the English document as it will be published. */
export function renderPersistencePair(_root: string, source: string, en: string, _zh?: string): PersistenceArtifact[] {
  const content = en.replace(/^English \| \[中文\]\([^)]+\)\r?\n(?:\r?\n)?/gm, '')
  if (!source.endsWith('.md') || source.endsWith('.zh.md')) throw new Error('Expected an English document path')
  return [{ path: source, content }]
}
