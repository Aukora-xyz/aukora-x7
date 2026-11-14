import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, headManifestIdCanon, mountE4, sha256 } from './e4-fixture.ts'

it('mount fills candidate mirrors; direct and nested organ reads do not write; ball_put fills both mirrors', async () => {
  const context = new Context()
  onTestFinished(async () => {
    await context.fiber.dispose()
    FakeSocket.instances.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const code = `module.exports = { name: 'seed-reader', run(args, ctx) {
    if (args.nested) return ctx.organs.call('seed-reader', { value: args.value });
    return { ok: true, value: args.value };
  } }`
  const sha = sha256(code)
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: 20, createdAt: 1000,
    authorPeerId: 'fixture',
    entries: { 'seed-reader': { id: 'seed-reader', specifier: `ball:${sha}`, disabled: false,
      config: {}, previousSpecifiers: [], updatedAt: 1000 } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'seed-reader', description: 'fixture', size: code.length, createdAt: 1000 } } }
  const vfs = new MemoryVfs()
  const staging = '/dsh/home/auma/seed/staging'
  vfs.mkdirSync(staging, { recursive: true })
  const initial = 'module.exports = { name: "unmounted", run() { return 1 } }'
  vfs.writeFileSync(`${staging}/initial.js`, initial)
  const f = await mountE4({ vfs, head: { ball: { ...body, ballId: headManifestIdCanon(body) }, codeBySha: { [sha]: code } },
    host: { context, dshTools } })
  for (const dir of ['balls', 'organs']) expect(vfs.readFileSync(`/dsh/home/${dir}/${sha256(initial)}.js`, 'utf8')).toBe(initial)
  const later = initial + '; // later candidate'
  vfs.writeFileSync(`${staging}/later.js`, later)
  const write = vi.spyOn(vfs, 'writeFileSync'), mkdir = vi.spyOn(vfs, 'mkdirSync')
  expect(await f.tool('seed-reader').execute({ value: 42 })).toEqual({ ok: true, value: 42 })
  expect(await f.tool('seed-reader').execute({ nested: true, value: 43 })).toEqual({ ok: true, value: 43 })
  expect(write).not.toHaveBeenCalled()
  expect(mkdir).not.toHaveBeenCalled()
  for (const dir of ['balls', 'organs']) expect(vfs.existsSync(`/dsh/home/${dir}/${sha256(later)}.js`)).toBe(false)
  expect(await f.tool('ball_put').execute({ path: `${staging}/later.js` })).toMatchObject({ specifier: `ball:${sha256(later)}` })
  for (const dir of ['balls', 'organs']) expect(vfs.readFileSync(`/dsh/home/${dir}/${sha256(later)}.js`, 'utf8')).toBe(later)
  expect((await f.status()).epoch).toBe(20)
})
