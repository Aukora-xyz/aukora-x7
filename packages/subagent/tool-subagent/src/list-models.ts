/** Model-facing discovery of LLM routes available to child Agents. */

import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { AllowedModelRoute, ModelSelectionPolicy } from './model-selection.ts'
import { subagentModelSelectionPolicy } from './model-selection-state.ts'
import { NEW_SESSIONS_ONLY } from './model-selection.ts'
import { doorState, noKeySuffix, readEdgeDoorKeys, type DoorState, type EdgeDoorKeys } from './edge-doors.ts'

interface ListSubagentModelsRequest {
  readonly provider?: string
  readonly model?: string
}

/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(
  llm: LlmRuntime,
  policy: ModelSelectionPolicy,
  providerId: string,
): LlmProviderInfo {
  const providers = llm.listProviders()
  const provider = providers.find(candidate => candidate.id === providerId)
  if (provider !== undefined) return provider
  const available = providers
    .filter(candidate => policy.routes.some(route => route.provider === candidate.id))
    .map(candidate => candidate.id)
    .join(', ') || '(none)'
  throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`)
}

/** The last line of every listing: when its choices were fixed, so an old thread is not read as broken. */
function footer(selectionEnabled: boolean): string {
  return selectionEnabled
    ? NEW_SESSIONS_ONLY
    : `This session started without a subagent model list, so only its own model is offered. ${NEW_SESSIONS_ONLY}`
}

/**
 * Door states for the listed providers, read once per listing and only when one of them leaves through an edge door.
 * @returns a state reader and the notes for providers the edge could not answer for.
 */
async function edgeDoorStates(ctx: Context, providers: readonly string[], signal: AbortSignal) {
  const doors = ctx.get('subagentModelSelection')?.edgeDoors()
  const routed = doors === undefined ? [] : providers.filter(provider => doors.routes.some(route => route.provider === provider))
  const keys: EdgeDoorKeys | undefined = doors === undefined || routed.length === 0
    ? undefined
    : await readEdgeDoorKeys(doors.healthPath, signal)
  const state = (provider: string): DoorState => doors === undefined || keys === undefined ? undefined : doorState(doors, keys, provider)
  const notes = [...new Set(routed.flatMap((provider) => {
    const current = state(provider)
    return current?.kind === 'unknown' ? [`Edge key check not run: ${current.reason}.`] : []
  }))]
  return { state, notes }
}

/** Render one advertised or resolved model. */
function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

/** How her own route reads in a model row. */
const OWN_MODEL = ' (your own model)'

/** Read the requested provider, allowed models, or exact-model efforts. */
async function listSubagentModels(
  ctx: Context,
  policyHandle: ProjectionHandle<AllowedModelRoute[] | null>,
  request: ListSubagentModelsRequest,
  exec: ToolRunContext,
): Promise<string> {
  if (exec.agent === undefined) throw new Error('list_subagent_models requires a calling agent')
  const recorded = subagentModelSelectionPolicy(policyHandle, exec.agent.session)
  const selectionEnabled = recorded !== undefined
  const parent = parentAgentOptionsForDelegation(exec.agent)
  const own: AllowedModelRoute | undefined = parent.provider === undefined || parent.model === undefined
    ? undefined
    : { provider: parent.provider, model: parent.model }
  if (own === undefined && !selectionEnabled) {
    throw new Error('cannot discover child LLM routes without a parent provider and model')
  }
  // Her own route is always offered and answered for, as the subagent tool always allows it: a recorded list adds
  // routes to it and never takes it away (a main mind on a route outside the list still sees and inspects its own).
  const listed = recorded ?? []
  const isOwn = (provider: string, model: string) => own !== undefined && own.provider === provider && own.model === model
  const policy: ModelSelectionPolicy = {
    routes: own === undefined || listed.some(route => isOwn(route.provider, route.model)) ? listed : [...listed, own],
  }
  const ownMark = (provider: string, model: string) => isOwn(provider, model) ? OWN_MODEL : ''
  const { signal } = exec
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
  }
  if (request.model !== undefined && request.provider === undefined) {
    throw new Error('`model` requires `provider`')
  }
  if (request.provider === undefined) {
    const providers = llm.listProviders()
      .filter(provider => policy.routes.some(route => route.provider === provider.id))
    const doors = await edgeDoorStates(ctx, providers.map(provider => provider.id), signal)
    const rows = providers.length === 0
      ? ['(no LLM providers)']
      : providers.map(provider => `${provider.id} — ${provider.name}`
        + (own?.provider === provider.id ? ` (your own model: ${own.model})` : '')
        + (doors.state(provider.id)?.kind === 'no-key' ? noKeySuffix(provider.name) : ''))
    return [...rows, ...doors.notes, footer(selectionEnabled)].join('\n')
  }
  if (request.provider.length === 0) throw new Error('`provider` must be non-empty')
  const allowedRoutes = policy.routes.filter(route => route.provider === request.provider)
  if (allowedRoutes.length === 0) {
    throw new Error(`LLM provider "${request.provider}" is not allowed for this Session; call list_subagent_models with no arguments for the providers it allows`)
  }
  const provider = registeredProvider(llm, policy, request.provider)
  if (request.model === undefined) {
    const doors = await edgeDoorStates(ctx, [provider.id], signal)
    if (doors.state(provider.id)?.kind === 'no-key') {
      // Every allowed route is shown, each marked: none is offered as usable and none is silently dropped.
      return [
        ...allowedRoutes.map(route => `${provider.id}/${route.model}${ownMark(provider.id, route.model)}${noKeySuffix(provider.name)}`),
        footer(selectionEnabled),
      ].join('\n')
    }
    // Listed routes follow the provider's catalog (a removed model is not resolved); her own route is resolved when the
    // catalog does not advertise it, so it is never dropped.
    const advertised = selectionEnabled
      ? (await llm.listModels(provider.id)).filter(model => allowedRoutes.some(route => route.model === model.id))
      : []
    const ownModel = own?.provider === provider.id && !advertised.some(model => model.id === own.model) ? own.model : undefined
    const models = ownModel === undefined
      ? advertised
      : [...advertised, await llm.resolveModelInfo(provider.id, ownModel, signal)]
    signal.throwIfAborted()
    const rows = models.length === 0
      ? [`(no advertised models for ${provider.id})`]
      : models.map(model => `${modelLine(provider.id, model)}${ownMark(provider.id, model.id)}`)
    return [...rows, ...doors.notes, footer(selectionEnabled)].join('\n')
  }
  if (request.model.length === 0) throw new Error('`model` must be non-empty')
  if (!allowedRoutes.some(route => route.model === request.model)) {
    throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session; call list_subagent_models with \`provider\` for the models it allows`)
  }
  const model = await llm.resolveModelInfo(provider.id, request.model, signal)
  const doors = await edgeDoorStates(ctx, [provider.id], signal)
  const efforts = model.reasoning?.efforts.map(effort => (
    `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`
    + (effort.description === undefined ? '' : `: ${effort.description}`)
  )).join('\n') || '(no advertised reasoning efforts)'
  const unavailable = doors.state(provider.id)?.kind === 'no-key' ? noKeySuffix(provider.name) : ''
  return `${modelLine(provider.id, model)}${ownMark(provider.id, model.id)}${unavailable}\nReasoning efforts:\n${efforts}`
}

/**
 * Register discovery of the calling Session’s authorized child models.
 * @param ctx - Context carrying the tool registry and LLM service.
 * @param policyHandle - retained reader for the Session’s authorized child routes.
 */
export function registerListSubagentModels(
  ctx: Context,
  policyHandle: ProjectionHandle<AllowedModelRoute[] | null>,
): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      'Inspect subagent models without changing the current Agent. No arguments: providers; '
      + '`provider`: allowed models; `provider` + `model`: that model and its reasoning efforts. '
      + 'Inspect options here before selecting a child provider and model; use returned ids for delegation. '
      + 'A row marked "unavailable" is switched on but cannot answer yet (its edge door has no key): pick another. '
      + 'Your own model is always listed and allowed, marked "your own model". '
      + NEW_SESSIONS_ONLY,
    parameters: {
      provider: {
        type: 'string',
        description: 'Registered LLM provider id.',
      },
      model: {
        type: 'string',
        description: 'Exact model id; requires provider.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      return listSubagentModels(ctx, policyHandle, args, exec)
    },
  }))
}
