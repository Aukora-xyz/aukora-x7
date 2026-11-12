// @vitest-environment jsdom
/**
 * Media and Documents, her drive, through its REAL registration (`installPortal`, over a recording Cordis context): the
 * launcher's name, and the files door the portal injects into Media and sets and clears inside the files service's own
 * scope. With the service, a file previews and Private opens; without it, the drive says it cannot read her files.
 * Every file is made up.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { installPortal } from '../src/client/spatial/portal/index.ts'
import { AUKORA_APPS } from '../src/client/spatial/portal/menus.tsx'
import { MEDIA_SURFACE } from '../src/client/spatial/apps/media/MediaSurface.tsx'
import type { DriveFiles } from '../src/client/spatial/apps/media/drive-source.ts'

const HOME = '/dsh/home/auma'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5])
const DISK: Record<string, Uint8Array> = {
  [`${HOME}/captures/latest.png`]: PNG,
  [`${HOME}/private/diary.md`]: new TextEncoder().encode('# made up'),
}

interface Registration {
  readonly options: { readonly id?: string; readonly inject?: () => Record<string, unknown> }
  readonly component: ComponentType<Record<string, unknown>>
}

/** A Cordis context that records what the portal registers, and runs a scoped inject only when asked to. */
function recordingContext() {
  const registrations: Registration[] = []
  const scoped: { deps: readonly string[]; run: (scope: unknown) => void }[] = []
  const slots = {
    inject: (_name: string, register: () => unknown) => { register() },
    register: (options: Registration['options'], component: Registration['component']) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const ctx = {
    slots,
    locale: { register: () => () => {} },
    effect: (run: () => unknown) => run(),
    inject: (deps: readonly string[], run: (scope: unknown) => void) => { scoped.push({ deps, run }) },
  }
  return { ctx, registrations, scoped, slots }
}

function filesService(calls: string[]): DriveFiles {
  return {
    stat: async (_s, path) => {
      calls.push(`stat ${path}`)
      const bytes = DISK[path]
      return bytes === undefined ? { ok: false, error: { code: 'workspace-file/not-found' } } : { ok: true, value: { absolutePath: path, version: 'v1', bytes: bytes.byteLength } }
    },
    readBytes: async (_s, path, options) => {
      calls.push(`read ${path}`)
      const bytes = DISK[path] ?? new Uint8Array()
      const offset = options.range?.offset ?? 0
      return { ok: true, value: { data: bytes.subarray(offset, offset + (options.range?.length ?? bytes.byteLength)), version: 'v1', eof: true } }
    },
    list: async (_s, path) => {
      calls.push(`list ${path}`)
      return { ok: true, value: { entries: path === `${HOME}/private` ? [{ name: 'diary.md', type: 'file' as const, size: 9 }] : [], truncated: false } }
    },
  }
}

const estate = {
  version: 1 as const,
  createRead: (): never => { throw new Error('unused') },
  callTool: async (_name: string, args: Record<string, unknown>) => {
    const root = String(args.root)
    const entries = Object.entries(DISK).filter(([path]) => path.startsWith(root + '/'))
      .map(([path, bytes]) => ({ path, type: 'file', size: bytes.byteLength, mtimeMs: 1_700_000_000_000 }))
    return { kind: 'ok', value: { ok: true, vfs: { root, entries, page: { nextCursor: null }, private: { present: true } } } }
  },
}

const SESSIONS = { ids: ['s1'], byId: { s1: { id: 's1', cwd: HOME, retainedBy: { mainView: 1 } } } }

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:http://localhost/1')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('__AUKORA_SUPERAGENT__', estate)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Media and Documents, registered by the portal', () => {
  it('G1 the launcher is "Media and Documents" with its summary, and keeps the id media', () => {
    const launcher = AUKORA_APPS.find(app => app.id === 'media')
    expect(launcher).toMatchObject({ id: 'media', title: 'Media and Documents', summary: 'her screenshots, images and documents' })
  })

  it('G2 the portal injects the files door into Media and the files scope sets and clears it', async () => {
    const { ctx, registrations, scoped } = recordingContext()
    installPortal(ctx as never)
    const media = registrations.find(entry => entry.options.id === 'aukora-media')
    expect(media?.options.inject).toBeTypeOf('function')
    const injected = media!.options.inject!()
    expect(Object.keys(injected)).toEqual(['driveFiles'])
    const Media = media!.component
    const owner = {
      activeSurface: MEDIA_SURFACE, closeSurface: () => {}, useSessions: (select: (s: unknown) => unknown) => select(SESSIONS),
    }
    const calls: string[] = []
    const view = render(<Media {...owner} {...injected} surfaceTarget={`drive:1:${HOME}/captures/latest.png`} />)

    // Before the files service is up: the listing (her estate tool) works, the preview says the drive cannot read.
    await waitFor(() => { expect(view.container.textContent).toContain('The drive cannot read her files in this build yet.') })
    expect(view.container.querySelector('img')).toBeNull()

    // The service's scope comes up: the portal's own effect sets the door, and the same file now previews.
    const files = filesService(calls)
    const scope = scoped.find(entry => entry.deps.includes('remote.workspaceFiles'))
    expect(scope?.deps).toEqual(['slots', 'remote', 'remote.workspaceFiles'])
    const disposers: (() => void)[] = []
    scope!.run({
      slots: { inject: (_n: string, register: () => unknown) => { register() }, register: () => () => {} },
      remote: { workspaceFiles: files },
      effect: (run: () => unknown) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose as () => void) },
    })
    // No re-render from outside: the door's own change reaches the open drive, which reads the selected file again.
    await waitFor(() => { expect(view.container.querySelector('[data-drive-preview] img')?.getAttribute('src')).toBe('blob:http://localhost/1') })
    expect(view.container.textContent).not.toContain('The drive cannot read her files in this build yet.')
    expect(calls.filter(call => call.startsWith('read'))).toEqual([`read ${HOME}/captures/latest.png`])
    expect(new Set(calls)).toEqual(new Set([`stat ${HOME}/captures/latest.png`, `read ${HOME}/captures/latest.png`]))

    // Private opens through the service (only after Open folder).
    fireEvent.click(view.container.querySelector('[data-drive-place="private"]') as HTMLElement)
    fireEvent.click(view.container.querySelector(`[data-drive-open-folder="${HOME}/private"]`) as HTMLElement)
    await waitFor(() => { expect(view.container.querySelector(`[data-drive-open="${HOME}/private/diary.md"]`)).not.toBeNull() })
    expect(calls).toContain(`list ${HOME}/private`)

    // The scope ends: the door is cleared, and the drive says so again.
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    view.rerender(<Media {...owner} {...injected} surfaceTarget={`drive:3:${HOME}/captures/latest.png`} />)
    await waitFor(() => { expect(view.container.textContent).toContain('The drive cannot read her files in this build yet.') })
  })
})
