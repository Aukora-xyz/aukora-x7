import { en, type PhraseKey } from './locale.ts'

/**
 * Resolve one English sentence from the SuperAgent locale dictionary.
 * @param key - Dictionary key.
 * @returns The sentence owned by `locale.ts`.
 */
export function phrase(key: PhraseKey): string {
  return en[key]
}
