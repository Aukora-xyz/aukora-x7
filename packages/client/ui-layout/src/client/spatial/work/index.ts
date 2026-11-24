/**
 * Register the Work surface and its menu entry in the Spatial shell.
 *
 * Scoped on `remote.workspaceFiles`: the stock web-app bundle mounts that service, and a profile without it simply
 * has no Work entry rather than one that pretends to read.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from '../locales.ts'
import { en as labelsEn, WORK_LABELS_NS, zh as labelsZh, type WorkLabelKey, type WorkLabels } from './labels.ts'
import { WorkMenu } from './WorkMenu.tsx'
import { WORK_SURFACE, WorkSurface } from './WorkSurface.tsx'
import type { FileRead, WorkReader, WorkSurfaceInjected } from './WorkSurface.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Work view's attention headings and its tab-click wording (`./labels.ts`). */
    'work.labels': WorkLabelKey
  }
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/** A Remote failure's code or message, never the whole object. */
const failureOf = (failure: unknown): string => {
  if (failure !== null && typeof failure === 'object') {
    const f = failure as { code?: unknown; message?: unknown }
    if (typeof f.code === 'string' && f.code !== '') return f.code
    if (typeof f.message === 'string' && f.message !== '') return f.message
  }
  return 'failed'
}

const reasonOf = (error: unknown): string => {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.message : String(error)
}

type WorkspaceFiles = {
  readBytes(sessionId: SessionId, path: string, options: object, signal: AbortSignal): Promise<
    { ok: true; value: { data: Uint8Array } } | { ok: false; error: unknown }
  >
}

/**
 * One whole-file reader over a Session's worker filesystem, shared by every Spatial surface that shows her files.
 * @param files - the stock `remote.workspaceFiles` service.
 * @returns the reader; it never throws, a failure is `{ ok: false, reason }`.
 */
export function createWorkReader(files: WorkspaceFiles): WorkReader {
  return {
    whole: async (sessionId: SessionId, path: string, signal: AbortSignal): Promise<FileRead> => {
      try {
        const read = await files.readBytes(sessionId, path, {}, signal)
        if (!read.ok) return { ok: false, reason: failureOf(read.error) }
        return { ok: true, text: decoder.decode(read.value.data) }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }
}

/**
 * Where the page's reader of her files is, for a part of the frame that is not itself inside the files service's scope (the
 * chat lane's Fingerprint card). Empty until the service is there, and again once it goes; whoever shows it is told.
 */
export interface WorkReaderDoor {
  /** The reader, or null while the files service is not there. */
  readonly current: () => WorkReader | null
  readonly set: (reader: WorkReader | null) => void
  /** Be told when the reader comes or goes; returns a function that stops telling. */
  readonly subscribe: (listener: () => void) => () => void
}

/** @returns an empty door. */
export function createWorkReaderDoor(): WorkReaderDoor {
  let reader: WorkReader | null = null
  const listeners = new Set<() => void>()
  return {
    current: () => reader,
    set: (next) => {
      reader = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * @param ctx - client root context.
 * @param door - where the frame finds the same reader, for the chat lane (the Fingerprint card reads her staged files).
 */
export function installWorkSurface(ctx: ClientContext, door?: WorkReaderDoor): void {
  ctx.inject(['slots', 'locale', 'remote', 'remote.workspaceFiles'], (scope) => {
    const reader = createWorkReader(scope.remote.workspaceFiles)
    if (door !== undefined) {
      scope.effect(() => {
        door.set(reader)
        return () => { door.set(null) }
      }, 'ui-layout: chat home reader')
    }
    scope.effect(() => scope.locale.register(WORK_LABELS_NS, { zh: labelsZh, en: labelsEn }), 'ui-layout: work labels')
    // One stable translator; it reads the active language at call time, so a language switch needs no re-registration.
    const labels = scope.locale.bind(WORK_LABELS_NS) as unknown as WorkLabels
    scope.effect(() => scope.slots.register({
      name: 'shell.surface', id: WORK_SURFACE, locale: NS,
      inject: (): WorkSurfaceInjected => ({ reader, labels }),
    }, WorkSurface), 'ui-layout: spatial work surface')
    scope.effect(() => scope.slots.register({
      name: 'shell.menu.system', id: WORK_SURFACE, locale: NS, order: 0,
    }, WorkMenu), 'ui-layout: spatial work menu entry')
  })
}
