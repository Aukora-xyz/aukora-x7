// @vitest-environment jsdom
/**
 * AUKORA: the Chat plugin's real `openFile` and `driveImages`, mounted over a test runtime.
 * Under the Spatial shell (a `layout` service with `openSurface`), a path in her home folder opens her drive at that
 * file and never the right sidebar; her images read through the files service. Every other path, and the stock shell,
 * keep the stock behaviour exactly. Every path and byte is made up.
 */
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyChat, inject as injectChat, type ChatViewInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createChatStore } from '../src/client/stores.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'
import { parseDriveTarget, type DriveImageFiles } from '../src/client/drive-link.ts'

usePinnedBrowserLanguages('zh-CN')

const HOME_THREAD = 'home-1' as SessionId
const HOME = '/dsh/home/auma'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>

async function bench(shell: 'spatial' | 'stock') {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (id: string) => id === CHAT_SETTINGS_NAMESPACE ? stubConfigForm<ChatSettings>().scope : stubConfigForm().scope,
  } as never)
  const layout = shell === 'spatial'
    ? { closeRightbar: vi.fn(), openRightbar: vi.fn(), openSurface: vi.fn() }
    : { closeRightbar: vi.fn(), openRightbar: vi.fn() }
  runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  runtime.ctx.provide('fileDrag', { actions: fileDrag, read: () => undefined })
  runtime.ctx.provide('layout', layout as never)
  const sidebarRight = { openResource: vi.fn<(address: string, options?: unknown) => void>(), openTab: vi.fn() }
  runtime.ctx.provide('sidebarRight', sidebarRight as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  const calls: string[] = []
  const workspaceFiles: DriveImageFiles = {
    stat: async (sessionId, path) => {
      calls.push(`stat ${sessionId} ${path}`)
      return path === `${HOME}/captures/latest.png`
        ? { ok: true, value: { absolutePath: path, version: 'v1', bytes: PNG.byteLength } }
        : { ok: false, error: { code: 'workspace-file/not-found' } }
    },
    readBytes: async (sessionId, path, options) => {
      calls.push(`read ${sessionId} ${path}`)
      const offset = options.range?.offset ?? 0
      return { ok: true, value: { data: PNG.subarray(offset, offset + (options.range?.length ?? PNG.byteLength)), version: 'v1', eof: true } }
    },
  }
  const openWorkspacePath = vi.fn<ClientRemote['session']['openWorkspacePath']>(() => Promise.resolve({ ok: true, value: { opened: true } }))
  runtime.remote.provideNamespaces({ session: { openWorkspacePath }, workspaceFiles })
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => { beforeOpen(HOME_THREAD) }),
    openSession: vi.fn(),
  } as never)
  await runtime.sessions.add({ id: HOME_THREAD, summary: { title: 'H', displayTitle: 'H', cwd: HOME } })
  const reference = runtime.sessions.retain(HOME_THREAD)
  await reference.ready
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  runtime.renderRoot()
  const entry = runtime.slots.entries('conversation.view')[0]!
  const instance = runtime.storeOf('conversation.view', reference) as ChatInstance
  const injected = (entry.inject as unknown as (id: SessionId, actions: ChatInstance['actions']) => ChatViewInjected)(HOME_THREAD, instance.actions)
  return { runtime, layout, sidebarRight, injected, calls, dispose: async () => { reference[Symbol.dispose](); await runtime.dispose() } }
}

describe('her chat opens her drive', () => {
  it('A1 a link to a file in her home folder, absolute or relative, opens the drive at it, never the right sidebar', async () => {
    const b = await bench('spatial')
    const openSurface = (b.layout as { openSurface: ReturnType<typeof vi.fn> }).openSurface
    const targets: string[] = []
    for (const [link, path] of [
      [`${HOME}/docs/PENTORA.v0.md`, `${HOME}/docs/PENTORA.v0.md`],
      ['docs/PENTORA.v0.md', `${HOME}/docs/PENTORA.v0.md`],
      ['./captures/latest.png', `${HOME}/captures/latest.png`],
      // A kept-out name, or a path that is not plain, opens the drive too, which answers with its plain refusal line.
      [`${HOME}/docs/credentials.yaml`, `${HOME}/docs/credentials.yaml`],
      [`${HOME}/seed/.env.local`, `${HOME}/seed/.env.local`],
    ] as const) {
      await b.injected.openFile(link)
      const [id, target, presentation] = openSurface.mock.lastCall as [string, string, string]
      expect([id, parseDriveTarget(target), presentation], link).toEqual(['media', path, 'contained'])
      targets.push(target)
    }
    // A line suffix does not change where it opens.
    await b.injected.openFile(`${HOME}/docs/PENTORA.v0.md`, { line: 4 })
    expect(parseDriveTarget(openSurface.mock.lastCall?.[1] as string)).toBe(`${HOME}/docs/PENTORA.v0.md`)
    expect(new Set(targets).size).toBe(targets.length)
    expect(b.sidebarRight.openResource).not.toHaveBeenCalled()
    expect(b.layout.openRightbar).not.toHaveBeenCalled()
    await b.dispose()
  })

  it('A1b her own files outside the drive\'s places open in the right sidebar exactly as on main', async () => {
    const b = await bench('spatial')
    const at = (path: string): string => `dsh-resource://file/session/${HOME_THREAD}/${path}`
    await b.injected.openFile(`${HOME}/seed/plan.md`)
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(at('seed/plan.md'))
    await b.injected.openFile(`${HOME}/HANDOFF.md`)
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(at('HANDOFF.md'))
    // A relative path resolves from her thread's folder (her home), and still opens in the sidebar.
    await b.injected.openFile('seed/x.js', { line: 7 })
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(at('seed/x.js'), { params: { line: 7 } })
    await b.injected.openFile('./memory/today.md')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(at('memory/today.md'))
    expect(b.sidebarRight.openResource).toHaveBeenCalledTimes(4)
    expect((b.layout as { openSurface: ReturnType<typeof vi.fn> }).openSurface).not.toHaveBeenCalled()
    // Her images there are not the drive's either: they keep the stock image path.
    expect(b.injected.driveImages?.claims(`${HOME}/seed/diagram.png`)).toBe(false)
    await b.dispose()
  })

  it('A2 every other path keeps the right sidebar exactly as before', async () => {
    const b = await bench('spatial')
    await b.injected.openFile('/proj/src/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(`dsh-resource://file/session/${HOME_THREAD}//proj/src/a.ts`)
    await b.injected.openFile('/dsh/home/auma-one/docs/x.md', { line: 3 })
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(`dsh-resource://file/session/${HOME_THREAD}//dsh/home/auma-one/docs/x.md`, { params: { line: 3 } })
    expect((b.layout as { openSurface: ReturnType<typeof vi.fn> }).openSurface).not.toHaveBeenCalled()
    await b.dispose()
  })

  it('A3 the stock shell (no openSurface) keeps the right sidebar for her files too, and claims no image', async () => {
    const b = await bench('stock')
    await b.injected.openFile(`${HOME}/docs/PENTORA.v0.md`)
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith(`dsh-resource://file/session/${HOME_THREAD}/docs/PENTORA.v0.md`)
    expect(b.injected.driveImages?.claims(`${HOME}/captures/latest.png`)).toBe(false)
    await b.dispose()
  })

  it('A4 her images read through the files service in this thread into a PNG Blob; refused ones read nothing', async () => {
    const b = await bench('spatial')
    const images = b.injected.driveImages!
    expect(images.openLabel).toBe('Open in drive')
    expect(images.claims(`${HOME}/captures/latest.png`)).toBe(true)
    expect(images.claims('/tmp/graph.png')).toBe(false)
    const blob = await images.read(`${HOME}/captures/latest.png`, new AbortController().signal)
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG)
    expect(b.calls).toEqual([`stat ${HOME_THREAD} ${HOME}/captures/latest.png`, `read ${HOME_THREAD} ${HOME}/captures/latest.png`])
    b.calls.length = 0
    expect(await images.read(`${HOME}/private/me.png`, new AbortController().signal)).toBeNull()
    expect(await images.read(`${HOME}/docs/logo.svg`, new AbortController().signal)).toBeNull()
    expect(b.calls).toEqual([])
    await b.dispose()
  })
})
