/** Synthetic account service proves owner-session expiry never removes provider credentials. */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { afterEach, expect, it, vi } from 'vitest'
import * as Account from '../src/index.ts'

/** No production account service or credential store participates in this fixture. */
class SyntheticAccount extends DeepSeekAccount {
  override async resolveToken(_url: string): Promise<string | undefined> { return 'synthetic-account-token' }
  override async rejectToken(_token: string): Promise<void> {}
  override getState(): never { throw new Error('unexpected account state read') }
  override getProfile(): never { throw new Error('unexpected account profile read') }
  override getBalance(): never { throw new Error('unexpected account balance read') }
  override getUnnotifiedBonuses(): never { throw new Error('unexpected account bonus read') }
  override ackBonusNotified(): never { throw new Error('unexpected account bonus acknowledgment') }
  override startSignIn(): never { throw new Error('unexpected account sign-in') }
  override cancelSignIn(): never { throw new Error('unexpected account cancellation') }
  override signOut(): never { throw new Error('unexpected account sign-out') }
  override watch(): never { throw new Error('unexpected account subscription') }
  override getPlatformSession(): never { throw new Error('unexpected platform session read') }
  override getDeviceIdentity(): never { throw new Error('unexpected device identity read') }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

it.each([
  { body: { ok: false, code: 'OWNER_ACCESS_REQUIRED' }, status: 401, code: 'OWNER_ACCESS_REQUIRED', rejected: false },
  { body: { error: { type: 'authentication_error', message: 'Invalid token' } }, status: 401, code: 'ACCOUNT_TOKEN_INVALID', rejected: true },
  { body: { error: { code: 'OWNER_ACCESS_REQUIRED', message: 'API key is invalid' } }, status: 401, code: 'OWNER_ACCESS_REQUIRED', rejected: false },
  { body: { ok: false, error: { code: 'OWNER_ACCESS_REQUIRED', type: 'authentication_error' } }, status: 401, code: 'OWNER_ACCESS_REQUIRED', rejected: false },
  { body: { error: { code: 'owner_access_required' } }, status: 401, code: 'ACCOUNT_TOKEN_INVALID', rejected: true },
  { body: { ok: true, code: 'OWNER_ACCESS_REQUIRED' }, status: 401, code: 'ACCOUNT_TOKEN_INVALID', rejected: true },
  { body: { ok: true, error: { code: 'OWNER_ACCESS_REQUIRED' } }, status: 401, code: 'ACCOUNT_TOKEN_INVALID', rejected: true },
  { body: { ok: false, code: 'OWNER_ACCESS_REQUIRED' }, status: 403, code: 'AUTH', rejected: false },
  { body: { error: { code: 'OWNER_ACCESS_REQUIRED' } }, status: 403, code: 'AUTH', rejected: false },
])('reports $code and credential rejection=$rejected', async ({ body, status, code, rejected }) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SyntheticAccount)
  const rejectToken = vi.spyOn(ctx.deepseekAccount, 'rejectToken')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/models') return Response.json({ data: [] })
    return Response.json(body, { status })
  })
  await ctx.plugin(Account, { baseURL: 'https://fixture.invalid' })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'deepseek-account', model: 'deepseek-flash', messages: [] })) assembler.push(chunk)
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code } })
  expect(rejectToken.mock.calls).toEqual(rejected ? [['synthetic-account-token']] : [])
})
