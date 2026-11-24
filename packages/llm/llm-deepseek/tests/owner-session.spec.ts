/** Owner edge refusals stay separate from upstream provider credential failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { providerError } from '../src/transport.ts'
import { DeepSeekFilesClient } from '../src/files-api.ts'
import { DeepSeekFileId } from '../src/file-id.ts'
import { adapter, chunks, options } from './helpers.ts'

const owner = { ok: false, code: 'OWNER_ACCESS_REQUIRED' }
const nestedOwner = { error: { code: 'OWNER_ACCESS_REQUIRED', message: 'API key is invalid' } }
afterEach(() => { vi.unstubAllGlobals() })

it('classifies an exact HTTP owner refusal without trusting response copy', () => {
  const error = providerError({ ...owner, message: 'untrusted', error: { message: 'untrusted', type: 'authentication_error' } }, 401)
  expect(error).toMatchObject({ code: 'OWNER_ACCESS_REQUIRED', failure: { status: 401 }, message: 'Owner session expired. Reload to sign in again.' })
})

it.each([
  nestedOwner,
  { ok: false, ...nestedOwner },
  { error: { ...nestedOwner.error, type: 'authentication_error' } },
  { error: { ...nestedOwner.error, type: 'permission_error', message: 'SECRET_QUERY_TOKEN' } },
])('classifies a nested HTTP owner refusal before provider authentication: %j', (body) => {
  expect(providerError(body, 401)).toMatchObject({ code: 'OWNER_ACCESS_REQUIRED', failure: { status: 401 }, message: 'Owner session expired. Reload to sign in again.' })
})

it.each([
  [owner, 403, 'AUTH'], [owner, 500, 'SERVER'], [owner, undefined, 'SERVER'],
  [nestedOwner, 403, 'AUTH'], [nestedOwner, 500, 'SERVER'], [nestedOwner, undefined, 'SERVER'],
  [{ code: 'OWNER_ACCESS_REQUIRED' }, 401, 'AUTH'], [{ ok: true, code: 'OWNER_ACCESS_REQUIRED' }, 401, 'AUTH'],
  [{ ok: true, ...nestedOwner }, 401, 'AUTH'], [{ ok: 'false', ...nestedOwner }, 401, 'AUTH'],
  [{ ok: false, code: 'OWNER_ACCESS_REQUIRED_EXTRA' }, 401, 'AUTH'],
  [{ error: { code: 'owner_access_required' } }, 401, 'AUTH'],
  [{ error: { code: 'OWNER_ACCESS_REQUIRED_EXTRA' } }, 401, 'AUTH'],
  [{ error: { message: 'OWNER_ACCESS_REQUIRED', type: 'OWNER_ACCESS_REQUIRED' } }, 401, 'AUTH'],
  [{ error: { error: { code: 'OWNER_ACCESS_REQUIRED' } } }, 401, 'AUTH'],
  [null, 401, 'AUTH'], [[], 401, 'AUTH'], ['OWNER_ACCESS_REQUIRED', 401, 'AUTH'],
  [{ error: null }, 401, 'AUTH'], [{ error: [] }, 401, 'AUTH'], [{ error: 'OWNER_ACCESS_REQUIRED' }, 401, 'AUTH'],
  [{ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401, 'AUTH'],
] as const)('keeps non-owner failure %j at status %s as %s', (body, status, code) => {
  expect(providerError(body, status).code).toBe(code)
})

it.each([owner, nestedOwner])('preserves owner failure %j through Messages without raw body copy', async (body) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...body, message: 'SECRET_QUERY_TOKEN' }, { status: 401 }))
  vi.stubGlobal('fetch', fetchImpl)
  await expect(chunks(adapter().stream(options()))).rejects.toMatchObject({ code: 'OWNER_ACCESS_REQUIRED', failure: { status: 401 }, message: 'Owner session expired. Reload to sign in again.' })
  expect(fetchImpl).toHaveBeenCalledOnce()
})

it.each([owner, nestedOwner].flatMap(body => (['upload', 'list', 'retrieve', 'delete'] as const).map(operation => ({ body, operation }))))('preserves an owner refusal $body from Files $operation', async ({ body, operation }) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body, { status: 401 }))
  const client = new DeepSeekFilesClient({ baseURL: 'https://fixture.invalid', headers: {}, fetch: fetchImpl })
  const operations = {
    upload: () => client.upload({ data: Uint8Array.of(1), mediaType: 'image/png', filename: 'fixture.png', expiresAfterSeconds: 3600 }),
    list: () => client.list(), retrieve: () => client.retrieve(DeepSeekFileId('fixture-file')), delete: () => client.delete(DeepSeekFileId('fixture-file')),
  }
  await expect(operations[operation]()).rejects.toMatchObject({ code: 'OWNER_ACCESS_REQUIRED', failure: { status: 401 } })
  expect(fetchImpl).toHaveBeenCalledOnce()
})

it('preserves owner failure during request preparation without sending Messages', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchImpl)
  const failure = new LlmError('Owner session expired. Reload to sign in again.', 'OWNER_ACCESS_REQUIRED', { status: 401 })
  await expect(chunks(adapter({}, { prepareExtensions: async () => { throw failure } }).stream(options()))).rejects.toBe(failure)
  expect(fetchImpl).not.toHaveBeenCalled()
})
