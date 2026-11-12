/**
 * Browser replacement for the pi-ai entry points used by `llm-pi-ai`.
 * Moonshot AI and DeepSeek chat completions use browser Fetch directly; all
 * other providers and protocols retain the worker-host refusal.
 */
import { notImplementedFail } from '../notImplementedFail.ts'
import { isModelDoor, modelDoorFor } from '../../model-doors.ts'

const MODULE = '@earendil-works/pi-ai'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'

interface ModelCompat {
  supportsDeveloperRole?: boolean
  supportsReasoningEffort?: boolean
  supportsUsageInStreaming?: boolean
  supportsFinishReason?: boolean
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  requiresToolResultName?: boolean
  requiresAssistantAfterToolResult?: boolean
  requiresThinkingAsText?: boolean
  requiresReasoningContentOnAssistantMessages?: boolean
  thinkingFormat?: string
  supportsStrictMode?: boolean
  supportsMidConvoSystemMessages?: boolean
  supportsMidConvoToolAdditions?: boolean
}

interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  input: ('text' | 'image')[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  compat?: ModelCompat
  headers?: Record<string, string>
  samplingParams?: Record<string, unknown>
  inputLimits?: unknown
  type?: 'chat'
}

interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface TextContent {
  type: 'text'
  text: string
}

interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
}

interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  argumentsError?: string
  partialArgs?: string
}

type AssistantContent = TextContent | ThinkingContent | ToolCallContent

interface SystemMessage {
  role: 'system'
  content: string | readonly TextContent[]
  sections?: Record<string, string | null>
  toolsAdded?: Tool[]
  toolsRemoved?: { name: string }[]
  timestamp: number
}

interface UserMessage {
  role: 'user'
  content: string | readonly (TextContent | ImageContent)[]
  timestamp: number
}

interface AssistantHistoryMessage {
  role: 'assistant'
  content: readonly AssistantContent[]
  timestamp: number
}

interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: readonly (TextContent | ImageContent)[]
  timestamp: number
}

type PiMessage = SystemMessage | UserMessage | AssistantHistoryMessage | ToolResultMessage

interface PiContext {
  systemPrompt?: string
  tools?: Tool[]
  messages: readonly PiMessage[]
}

interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

interface AssistantOutput {
  role: 'assistant'
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  responseId?: string
  responseModel?: string
  usage: Usage
  stopReason: StopReason
  errorMessage?: string
  rawStopReason?: string
  timestamp: number
}

type AssistantEvent =
  | { type: 'start'; partial: AssistantOutput }
  | { type: 'text_start' | 'thinking_start' | 'toolcall_start'; contentIndex: number; partial: AssistantOutput }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantOutput }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string; partial: AssistantOutput }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallContent; partial: AssistantOutput }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantOutput }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantOutput }

interface StreamOptions {
  signal?: AbortSignal
  apiKey?: string
  headers?: Readonly<Record<string, string | null>>
  fetch?: typeof globalThis.fetch
  onPayload?: (payload: unknown, model: Model) => unknown
  onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model) => void | Promise<void>
  onProviderStreamEvent?: (data: unknown, model: Model) => void | Promise<void>
  temperature?: number
  maxTokens?: number
  reasoning?: ThinkingLevel
  reasoningEffort?: Exclude<ThinkingLevel, 'off'> | undefined
  toolChoice?: 'auto' | 'none'
  samplingParams?: Record<string, unknown>
}

interface ProviderStreams {
  stream(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
  streamSimple(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
}

interface Credential {
  type: string
  key?: string
  env?: Record<string, string>
}

interface AuthContext {
  env(name: string): Promise<string | undefined>
  fileExists(path: string): Promise<boolean>
}

interface CredentialStore {
  read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined>
}

interface AuthResolution {
  auth: {
    apiKey?: string
    headers?: Record<string, string | null>
    baseUrl?: string
  }
  source: string
  env?: Record<string, string>
}

interface ApiKeyAuth {
  name: string
  resolve(input: {
    ctx: AuthContext
    credential?: Credential | undefined
    signal: AbortSignal
  }): Promise<AuthResolution | undefined>
}

interface Provider {
  id: string
  name: string
  baseUrl?: string
  auth: { apiKey: ApiKeyAuth }
  getModels(): readonly Model[]
  stream(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
  streamSimple(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
}

interface CreateModelsOptions {
  credentials?: CredentialStore
  authContext?: AuthContext
}

interface ModelsCollection {
  setProvider(provider: Provider): void
  clearProviders(): void
  getModels(provider?: string): Model[]
  getModel(provider: string, id: string): Model | undefined
  stream(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
  streamSimple(model: Model, context: PiContext, options?: StreamOptions): AsyncIterable<AssistantEvent>
}

interface StaticProviderOptions {
  id: string
  name: string
  baseUrl?: string
  auth: { apiKey: ApiKeyAuth }
  models: readonly Model[]
  api: ProviderStreams
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function pendingOutput(model: Model): AssistantOutput {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorEvent(model: Model, error: unknown, aborted = false): AssistantEvent {
  const output = pendingOutput(model)
  output.stopReason = aborted ? 'aborted' : 'error'
  output.errorMessage = errorText(error)
  return { type: 'error', reason: output.stopReason, error: output }
}

function normalizeContext(context: PiContext): PiContext {
  const hasPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0
  const hasTools = context.tools !== undefined && context.tools.length > 0
  if (!hasPrompt && !hasTools) return context
  const initial: SystemMessage = {
    role: 'system',
    content: context.systemPrompt ?? '',
    ...hasTools ? { toolsAdded: context.tools } : {},
    timestamp: 0,
  }
  return { messages: [initial, ...context.messages] }
}

function mergeHeaders(
  base: Readonly<Record<string, string | null>> | undefined,
  override: Readonly<Record<string, string | null>> | undefined,
): Record<string, string | null> | undefined {
  if (base === undefined && override === undefined) return undefined
  const merged = new Map<string, { name: string; value: string | null }>()
  for (const [name, value] of [...Object.entries(base ?? {}), ...Object.entries(override ?? {})]) {
    merged.set(name.toLowerCase(), { name, value })
  }
  return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]))
}

function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
  return {
    name,
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted()
      if (credential?.key !== undefined && credential.key.length > 0) {
        return { auth: { apiKey: credential.key }, ...credential.env === undefined ? {} : { env: credential.env }, source: 'stored credential' }
      }
      for (const envVar of envVars) {
        const value = await ctx.env(envVar)
        signal.throwIfAborted()
        if (value !== undefined && value.length > 0) return { auth: { apiKey: value }, source: envVar }
      }
      return undefined
    },
  }
}

async function* lazyStream(model: Model, setup: () => Promise<AsyncIterable<AssistantEvent>>): AsyncGenerator<AssistantEvent> {
  try {
    yield* await setup()
  } catch (error: unknown) {
    yield errorEvent(model, error)
  }
}

/**
 * Create the static provider used by a configured OpenAI-completions route.
 * @param input - provider identity, models, authentication, and protocol implementation.
 * @returns a provider that delegates to the supplied protocol.
 */
export function createProvider(input: StaticProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name,
    ...input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl },
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => input.api.stream(model, context, options),
    streamSimple: (model, context, options) => input.api.streamSimple(model, context, options),
  }
}

/**
 * Create the request-dispatch collection used by `llm-pi-ai`.
 * @param options - credential store and ambient authentication integration.
 * @returns an empty provider collection.
 */
export function createModels(options?: CreateModelsOptions): ModelsCollection {
  const providers = new Map<string, Provider>()
  const credentials = options?.credentials
  const authContext = options?.authContext ?? {
    env: () => Promise.resolve(undefined),
    fileExists: () => Promise.resolve(false),
  }

  const prepare = async (model: Model, request: StreamOptions | undefined): Promise<{
    provider: Provider
    model: Model
    options: StreamOptions | undefined
  }> => {
    const provider = providers.get(model.provider)
    if (provider === undefined) throw new Error(`Unknown provider: ${model.provider}`)
    const signal = request?.signal ?? new AbortController().signal
    signal.throwIfAborted()
    const credential = request?.apiKey !== undefined
      ? { type: 'api_key', key: request.apiKey }
      : await credentials?.read(provider.id, { signal })
    const resolution = credential?.type !== undefined && credential.type !== 'api_key'
      ? undefined
      : await provider.auth.apiKey.resolve({ ctx: authContext, credential, signal })
    if (resolution === undefined) throw new Error(`Provider is not configured: ${model.provider}`)
    const requestModel = resolution.auth.baseUrl === undefined ? model : { ...model, baseUrl: resolution.auth.baseUrl }
    const headers = mergeHeaders(mergeHeaders(resolution.auth.headers, model.headers), request?.headers)
    return {
      provider,
      model: requestModel,
      options: {
        ...request,
        ...resolution.auth.apiKey === undefined ? {} : { apiKey: resolution.auth.apiKey },
        ...headers === undefined ? {} : { headers },
      },
    }
  }

  return {
    setProvider: (provider) => { providers.set(provider.id, provider) },
    clearProviders: () => { providers.clear() },
    getModels(providerId) {
      if (providerId !== undefined) return [...(providers.get(providerId)?.getModels() ?? [])]
      return [...providers.values()].flatMap(provider => [...provider.getModels()])
    },
    getModel(providerId, id) {
      return providers.get(providerId)?.getModels().find(model => model.id === id)
    },
    stream(model, context, request) {
      const normalized = normalizeContext(context)
      return lazyStream(model, async () => {
        const prepared = await prepare(model, request)
        return prepared.provider.stream(prepared.model, normalized, prepared.options)
      })
    },
    streamSimple(model, context, request) {
      const normalized = normalizeContext(context)
      return lazyStream(model, async () => {
        const prepared = await prepare(model, request)
        return prepared.provider.streamSimple(prepared.model, normalized, prepared.options)
      })
    },
  }
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * List the reasoning levels declared by one model.
 * @param model - model descriptor carrying reasoning support and wire mappings.
 * @returns supported levels in escalation order.
 */
export function getSupportedThinkingLevels(model: Model): ThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeded model token limit/i,
  /context window exceeds limit/i,
  /model_context_window_exceeded/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

/**
 * Detect provider overflow errors and usage-based overflow results.
 * @param message - terminal assistant response to classify.
 * @param contextWindow - configured model capacity, when known.
 * @returns whether the response represents context overflow.
 */
export function isContextOverflow(message: AssistantOutput, contextWindow?: number): boolean {
  const errorMessage = message.errorMessage
  if (message.stopReason === 'error' && errorMessage !== undefined
    && !/rate limit|too many requests/i.test(errorMessage)
    && OVERFLOW_PATTERNS.some(pattern => pattern.test(errorMessage))) return true
  const input = message.usage.input + message.usage.cacheRead
  if (contextWindow !== undefined && message.stopReason === 'stop' && input > contextWindow) return true
  return contextWindow !== undefined && message.stopReason === 'length' && message.usage.output === 0
    && input >= contextWindow * 0.99
}

const DEEPSEEK_MODELS: Model[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    input: ['text', 'image'],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
      supportsStrictMode: true,
    },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    reasoning: true,
    input: ['text'],
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
      supportsStrictMode: true,
      supportsMidConvoSystemMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
  },
]

const MOONSHOT_MODELS: Model[] = [
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    api: 'openai-completions',
    provider: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 262_144,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'deepseek',
      supportsMidConvoSystemMessages: true,
    },
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    api: 'openai-completions',
    provider: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 262_144,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'deepseek',
      supportsMidConvoSystemMessages: true,
    },
    thinkingLevelMap: { off: null },
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    name: 'Kimi K2.7 Code HighSpeed',
    api: 'openai-completions',
    provider: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 262_144,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'deepseek',
      supportsMidConvoSystemMessages: true,
    },
    thinkingLevelMap: { off: null },
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    api: 'openai-completions',
    provider: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'openai',
      requiresReasoningContentOnAssistantMessages: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: true,
    },
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  },
]

const MOONSHOT_CN_MODELS: Model[] = MOONSHOT_MODELS.map(model => ({
  ...model,
  provider: 'moonshotai-cn',
  baseUrl: 'https://api.moonshot.cn/v1',
}))

const MODEL_CATALOGS: Readonly<Record<string, readonly Model[]>> = {
  deepseek: DEEPSEEK_MODELS,
  moonshotai: MOONSHOT_MODELS,
  'moonshotai-cn': MOONSHOT_CN_MODELS,
}

const BUILTIN_PROVIDER_IDS: readonly string[] = [
  'amazon-bedrock', 'ant-ling', 'anthropic', 'azure', 'baseten', 'cerebras',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot',
  'google', 'google-vertex', 'groq', 'huggingface', 'kimi-coding', 'minimax', 'minimax-cn',
  'mistral', 'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openai-codex', 'opencode',
  'opencode-go', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn',
  'qwen-token-plan-individual', 'together',
  'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]

const PROVIDER_DETAILS: Readonly<Record<string, { name: string; baseUrl: string; env: readonly string[] }>> = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', env: ['DEEPSEEK_API_KEY'] },
  moonshotai: { name: 'Moonshot AI', baseUrl: 'https://api.moonshot.ai/v1', env: ['MOONSHOT_API_KEY'] },
  'moonshotai-cn': { name: 'Moonshot AI CN', baseUrl: 'https://api.moonshot.cn/v1', env: ['MOONSHOT_API_KEY'] },
}

/**
 * Construct the installed provider metadata and three browser dispatchers.
 * @returns installed providers in catalog order.
 */
export function builtinProviders(): Provider[] {
  return BUILTIN_PROVIDER_IDS.map((id) => {
    const details = PROVIDER_DETAILS[id]
    return createProvider({
      id,
      name: details?.name ?? id,
      ...details === undefined ? {} : { baseUrl: details.baseUrl },
      auth: { apiKey: envApiKeyAuth(details?.name ?? id, details?.env ?? []) },
      models: getBuiltinModels(id),
      api: openAICompletionsApi(),
    })
  })
}

/**
 * Return chat models for one of the three browser-supported providers.
 * @param provider - installed provider identifier.
 * @returns chat models, empty for an unsupported provider.
 */
export function getBuiltinModels(provider: string): Model[] {
  return [...(MODEL_CATALOGS[provider] ?? [])]
}

/**
 * Return every model type for one provider; these catalogs contain chat models only.
 * @param provider - installed provider identifier.
 * @returns all models in the provider catalog.
 */
export function getAllBuiltinModels(provider: string): Model[] {
  return getBuiltinModels(provider)
}

/**
 * Create a collection populated with the installed provider subset.
 * @param options - credential store and ambient authentication integration.
 * @returns a collection containing every installed provider entry.
 */
export function builtinModels(options?: CreateModelsOptions): ModelsCollection {
  const models = createModels(options)
  for (const provider of builtinProviders()) models.setProvider(provider)
  return models
}

interface ResolvedCompat {
  supportsDeveloperRole: boolean
  supportsReasoningEffort: boolean
  supportsUsageInStreaming: boolean
  supportsFinishReason: boolean
  maxTokensField: 'max_completion_tokens' | 'max_tokens'
  requiresToolResultName: boolean
  requiresAssistantAfterToolResult: boolean
  requiresThinkingAsText: boolean
  requiresReasoningContentOnAssistantMessages: boolean
  thinkingFormat: string
  supportsMidConvoSystemMessages: boolean
  supportsMidConvoToolAdditions: boolean
}

function completionsCompat(model: Model): ResolvedCompat {
  const deepseek = model.provider === 'deepseek' || model.baseUrl.toLowerCase().includes('deepseek.com')
  return {
    supportsDeveloperRole: false,
    supportsReasoningEffort: deepseek,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: 'max_tokens',
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: deepseek,
    thinkingFormat: deepseek ? 'deepseek' : 'openai',
    supportsMidConvoSystemMessages: false,
    supportsMidConvoToolAdditions: false,
    ...model.compat,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentText(content: string | readonly TextContent[]): string {
  return typeof content === 'string' ? content : content.map(block => block.text).join('\n')
}

function systemText(message: SystemMessage, update: boolean): string {
  const parts: string[] = []
  const text = contentText(message.content)
  if (text.length > 0) parts.push(text)
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (!update) {
      if (value !== null) parts.push(value)
    } else {
      parts.push(value === null ? `Removed system prompt section "${name}".` : `Updated system prompt section "${name}":\n\n${value}`)
    }
  }
  return parts.join('\n\n')
}

function currentTools(messages: readonly PiMessage[]): Tool[] {
  const tools = new Map<string, Tool>()
  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return [...tools.values()]
}

function currentSystem(messages: readonly PiMessage[]): SystemMessage | undefined {
  const content: string[] = []
  const sections = new Map<string, string>()
  let timestamp: number | undefined
  for (const message of messages) {
    if (message.role !== 'system') continue
    timestamp ??= message.timestamp
    const text = contentText(message.content)
    if (text.length > 0) content.push(text)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else sections.set(name, value)
    }
  }
  const tools = currentTools(messages)
  if (timestamp === undefined && tools.length === 0) return undefined
  return {
    role: 'system',
    content: content.join('\n\n'),
    ...sections.size === 0 ? {} : { sections: Object.fromEntries(sections) },
    ...tools.length === 0 ? {} : { toolsAdded: tools },
    timestamp: timestamp ?? 0,
  }
}

function resolvedMessages(context: PiContext, compat: ResolvedCompat): PiMessage[] {
  if (compat.supportsMidConvoSystemMessages) return [...context.messages]
  const head = currentSystem(context.messages)
  const rest = context.messages.filter(message => message.role !== 'system')
  return head === undefined ? rest : [head, ...rest]
}

function additiveTools(messages: readonly PiMessage[], enabled: boolean): {
  requestTools: Tool[]
  anchorsAdditions: boolean
} {
  if (!enabled) return { requestTools: currentTools(messages), anchorsAdditions: false }
  const declared = new Set<string>()
  let additive = true
  for (const message of messages) {
    if (message.role !== 'system') continue
    if ((message.toolsRemoved?.length ?? 0) > 0) additive = false
    for (const tool of message.toolsAdded ?? []) {
      if (declared.has(tool.name)) additive = false
      declared.add(tool.name)
    }
  }
  const first = messages[0]
  return {
    requestTools: additive
      ? first?.role === 'system' ? first.toolsAdded ?? [] : []
      : currentTools(messages),
    anchorsAdditions: additive,
  }
}

function wireTools(tools: readonly Tool[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function userWireContent(content: UserMessage['content']): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content
  // Text alone travels as one string: every chat endpoint takes it, and the Aukora edge door's provider budget accepts
  // only string message content on the chat wire (Round 36).
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).filter(text => text.length > 0).join('\n')
  const wire: Record<string, unknown>[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) wire.push({ type: 'text', text: block.text })
    } else {
      wire.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
    }
  }
  return wire
}

function assistantWireMessage(
  message: AssistantHistoryMessage,
  model: Model,
  compat: ResolvedCompat,
): Record<string, unknown> | undefined {
  const wire: Record<string, unknown> = { role: 'assistant', content: compat.requiresAssistantAfterToolResult ? '' : null }
  const textParts: string[] = []
  const thinking: ThinkingContent[] = []
  const toolCalls: ToolCallContent[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) textParts.push(block.text)
    } else if (block.type === 'thinking') {
      if (block.thinking.trim().length > 0) thinking.push(block)
    } else {
      toolCalls.push(block)
    }
  }
  const text = textParts.join('')
  if (thinking.length > 0 && compat.requiresThinkingAsText) {
    wire.content = [
      { type: 'text', text: thinking.map(block => block.thinking).join('\n\n') },
      ...text.length === 0 ? [] : [{ type: 'text', text }],
    ]
  } else {
    if (text.length > 0) wire.content = text
    if (thinking.length > 0) {
      const signature = thinking[0]?.thinkingSignature
      if (signature === 'reasoning' || signature === 'reasoning_content' || signature === 'reasoning_text') {
        wire[signature] = thinking.map(block => block.thinking).join('\n')
      }
    }
  }
  if (toolCalls.length > 0) {
    wire.tool_calls = toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }))
  }
  if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning && wire.reasoning_content === undefined) {
    wire.reasoning_content = ''
  }
  const content = wire.content
  const hasContent = content !== null && content !== undefined
    && (typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0)
  if (!hasContent && wire.tool_calls === undefined) return undefined
  return wire
}

function convertMessages(
  model: Model,
  messages: readonly PiMessage[],
  compat: ResolvedCompat,
  anchorsAdditions: boolean,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  let previousRole: string | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message === undefined) continue
    if (compat.requiresAssistantAfterToolResult && previousRole === 'toolResult' && message.role === 'user') {
      wire.push({ role: 'assistant', content: 'I have processed the tool results.' })
    }
    if (message.role === 'system') {
      const additions = index > 0 && anchorsAdditions ? message.toolsAdded ?? [] : []
      if (additions.length > 0) wire.push({ role: 'system', tools: wireTools(additions) })
      const text = systemText(message, index > 0)
      if (text.length > 0) {
        wire.push({ role: model.reasoning && compat.supportsDeveloperRole ? 'developer' : 'system', content: text })
      }
    } else if (message.role === 'user') {
      const content = userWireContent(message.content)
      if (content.length > 0) wire.push({ role: 'user', content })
    } else if (message.role === 'assistant') {
      const converted = assistantWireMessage(message, model, compat)
      if (converted !== undefined) wire.push(converted)
    } else {
      const images: Record<string, unknown>[] = []
      let last = index
      for (; last < messages.length; last++) {
        const result = messages[last]
        if (result?.role !== 'toolResult') break
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const hasImages = result.content.some(block => block.type === 'image')
        const tool: Record<string, unknown> = {
          role: 'tool',
          content: text.length > 0 ? text : hasImages ? '(see attached image)' : '(no tool output)',
          tool_call_id: result.toolCallId,
        }
        if (compat.requiresToolResultName && result.toolName.length > 0) tool.name = result.toolName
        wire.push(tool)
        if (model.input.includes('image')) {
          for (const block of result.content) {
            if (block.type === 'image') images.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
          }
        }
      }
      index = last - 1
      if (images.length > 0) {
        if (compat.requiresAssistantAfterToolResult) wire.push({ role: 'assistant', content: 'I have processed the tool results.' })
        wire.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...images] })
        previousRole = 'user'
        continue
      }
      previousRole = 'toolResult'
      continue
    }
    previousRole = message.role
  }
  return wire
}

function buildPayload(model: Model, context: PiContext, options: StreamOptions | undefined): Record<string, unknown> {
  const compat = completionsCompat(model)
  const messages = resolvedMessages(context, compat)
  const tools = additiveTools(messages, compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolAdditions)
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model, messages, compat, tools.anchorsAdditions),
    stream: true,
    ...compat.supportsUsageInStreaming ? { stream_options: { include_usage: true } } : {},
    ...options?.maxTokens === undefined ? {} : { [compat.maxTokensField]: options.maxTokens },
    ...options?.temperature === undefined ? {} : { temperature: options.temperature },
    ...tools.requestTools.length === 0 ? {} : { tools: wireTools(tools.requestTools) },
    ...options?.toolChoice === undefined ? {} : { tool_choice: options.toolChoice },
    ...model.samplingParams,
    ...options?.samplingParams,
  }
  if (model.reasoning) {
    const effort = options?.reasoningEffort
    if (compat.thinkingFormat === 'deepseek') {
      if (effort !== undefined) payload.thinking = { type: 'enabled' }
      else if (model.thinkingLevelMap?.off !== null) payload.thinking = { type: 'disabled' }
      if (effort !== undefined && compat.supportsReasoningEffort) {
        payload.reasoning_effort = model.thinkingLevelMap?.[effort] ?? effort
      }
    } else if (compat.thinkingFormat === 'openai') {
      if (effort !== undefined && compat.supportsReasoningEffort) {
        payload.reasoning_effort = model.thinkingLevelMap?.[effort] ?? effort
      } else if (effort === undefined && compat.supportsReasoningEffort) {
        const off = model.thinkingLevelMap?.off
        if (typeof off === 'string') payload.reasoning_effort = off
      }
    } else {
      throw new Error(`web-preview: thinking format "${compat.thinkingFormat}" is not available for ${model.provider}`)
    }
  }
  return payload
}

const ALLOWED_ENDPOINTS = new Set([
  'https://api.moonshot.ai/v1/chat/completions',
  'https://api.moonshot.cn/v1/chat/completions',
  'https://api.deepseek.com/chat/completions',
])

const pageOrigin = (): string | undefined => (globalThis as { location?: { origin?: string } }).location?.origin

function endpointOf(model: Model): string {
  const endpoint = new URL(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`).href
  // Aukora X5 P3: any same-origin /door/ path is a door endpoint (keys live server-side).
  const origin = pageOrigin()
  // In the browser body every native provider goes through its same-origin edge door (cap, outbound
  // log, key floor), whichever fetch the caller hands in; a provider with no door is refused. Every door provider is
  // reachable this way (Round 36: the composer's Anthropic and OpenRouter routes), not only the two built-in ones.
  if (origin !== undefined) {
    if (isModelDoor(endpoint, origin)) return endpoint
    const door = modelDoorFor(endpoint, origin)
    if (door === null || door === endpoint) throw new Error(`web-preview: "${endpoint}" has no Aukora edge door and is not called directly`)
    return door
  }
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    throw new Error(`web-preview: OpenAI completions endpoint "${endpoint}" is not available in the worker host`)
  }
  return endpoint
}

function hasAuthorization(headers: Readonly<Record<string, string | null>> | undefined): boolean {
  return Object.entries(headers ?? {}).some(([name, value]) => name.toLowerCase() === 'authorization' && value !== null && value.trim().length > 0)
}

function assertCredentials(model: Model, options: StreamOptions | undefined): void {
  if (options?.apiKey !== undefined && options.apiKey.length > 0) return
  if (hasAuthorization(options?.headers)) return
  throw new Error(`No API key for provider: ${model.provider}`)
}

function requestHeaders(model: Model, options: StreamOptions | undefined): Headers {
  const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' })
  for (const [name, value] of Object.entries(model.headers ?? {})) headers.set(name, value)
  if (options?.apiKey !== undefined && options.apiKey.length > 0) headers.set('authorization', `Bearer ${options.apiKey}`)
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }
  return headers
}

function acceptSseLine(line: string, data: string[]): string | undefined {
  if (line.length === 0) {
    if (data.length === 0) return undefined
    const event = data.join('\n')
    data.length = 0
    return event
  }
  if (line.startsWith(':')) return undefined
  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  if (field !== 'data') return undefined
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  data.push(value)
  return undefined
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const data: string[] = []
  let buffer = ''
  while (true) {
    const result = await reader.read()
    if (result.done) break
    buffer += decoder.decode(result.value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const event = acceptSseLine(line, data)
      if (event !== undefined) yield event
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
}

function parseSseJson(data: string): unknown {
  try {
    const value: unknown = JSON.parse(data)
    return value
  } catch (_invalidProviderJson) {
    throw new Error('Provider stream contains invalid JSON')
  }
}

function numberField(value: Record<string, unknown> | undefined, name: string): number {
  const field = value?.[name]
  return typeof field === 'number' && Number.isFinite(field) ? field : 0
}

function parseUsage(raw: Record<string, unknown> | undefined): Usage {
  const prompt = numberField(raw, 'prompt_tokens')
  const details = isRecord(raw?.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const cacheRead = numberField(details, 'cached_tokens') || numberField(raw, 'prompt_cache_hit_tokens') || numberField(raw, 'cached_tokens')
  const cacheWrite = numberField(details, 'cache_write_tokens')
  const input = Math.max(0, prompt - cacheRead - cacheWrite)
  const output = numberField(raw, 'completion_tokens')
  const completionDetails = isRecord(raw?.completion_tokens_details) ? raw.completion_tokens_details : undefined
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: numberField(completionDetails, 'reasoning_tokens'),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseToolArguments(json: string): Pick<ToolCallContent, 'arguments' | 'argumentsError'> {
  if (json.trim().length === 0) return { arguments: {} }
  try {
    const parsed: unknown = JSON.parse(json)
    if (!isRecord(parsed)) throw new Error('Tool arguments must be a JSON object')
    return { arguments: parsed }
  } catch (error: unknown) {
    return { arguments: {}, argumentsError: `${errorText(error)}\n\nReceived arguments:\n${json}` }
  }
}

function providerHttpError(status: number, body: string): Error {
  let detail = body
  try {
    const raw: unknown = JSON.parse(body)
    if (isRecord(raw)) {
      const error = isRecord(raw.error) ? raw.error : undefined
      const message = error?.message
      if (typeof message === 'string') detail = message
      else if (typeof raw.message === 'string') detail = raw.message
    }
  } catch (_nonJsonProviderError) {
    // The plain response body is already the most useful diagnostic.
  }
  return new Error(`${status}${detail.length === 0 ? '' : ` ${detail}`}`)
}

function applyFinishReason(output: AssistantOutput, reason: string): void {
  output.rawStopReason = reason
  if (reason === 'stop' || reason === 'end') output.stopReason = 'stop'
  else if (reason === 'length') output.stopReason = 'length'
  else if (reason === 'function_call' || reason === 'tool_calls') output.stopReason = 'toolUse'
  else {
    output.stopReason = 'error'
    output.errorMessage = `Provider finish_reason: ${reason}`
  }
}

async function* streamEvents(model: Model, context: PiContext, options: StreamOptions | undefined): AsyncGenerator<AssistantEvent> {
  const output = pendingOutput(model)
  try {
    options?.signal?.throwIfAborted()
    const compat = completionsCompat(model)
    let payload = buildPayload(model, normalizeContext(context), options)
    const replacement = await options?.onPayload?.(payload, model)
    if (replacement !== undefined) {
      if (!isRecord(replacement)) throw new Error('Provider payload hook returned a non-object value')
      payload = replacement
    }
    const requestFetch = options?.fetch ?? globalThis.fetch
    const endpoint = endpointOf(model)
    const headers = requestHeaders(model, options)
    // A door never takes a browser key: the edge strips it and attaches its own (as the worker-host fetch door does).
    const origin = pageOrigin()
    const door = origin !== undefined && isModelDoor(endpoint, origin)
    if (door) { headers.delete('authorization'); headers.delete('x-api-key') }
    const response = await requestFetch(endpoint, {
      method: 'POST',
      headers,
      ...door ? { credentials: 'same-origin' as const } : {},
      body: JSON.stringify(payload),
      ...options?.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) throw providerHttpError(response.status, await response.text())
    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)
    if (response.body === null) throw new Error('Provider returned no response body')
    yield { type: 'start', partial: output }

    let textBlock: TextContent | undefined
    let thinkingBlock: ThinkingContent | undefined
    const toolsByIndex = new Map<number, ToolCallContent>()
    const toolsById = new Map<string, ToolCallContent>()
    const startedTools = new Set<ToolCallContent>()
    let hasFinishReason = false

    const ensureText = (): TextContent => {
      if (textBlock === undefined) {
        textBlock = { type: 'text', text: '' }
        output.content.push(textBlock)
      }
      return textBlock
    }
    const ensureThinking = (signature: string): ThinkingContent => {
      if (thinkingBlock === undefined) {
        thinkingBlock = { type: 'thinking', thinking: '', thinkingSignature: signature }
        output.content.push(thinkingBlock)
      }
      return thinkingBlock
    }
    const ensureTool = (raw: Record<string, unknown>): ToolCallContent => {
      const index = typeof raw.index === 'number' ? raw.index : undefined
      const id = typeof raw.id === 'string' ? raw.id : undefined
      const fn = isRecord(raw.function) ? raw.function : undefined
      const name = typeof fn?.name === 'string' ? fn.name : ''
      let block = index === undefined ? undefined : toolsByIndex.get(index)
      if (block === undefined && id !== undefined) block = toolsById.get(id)
      if (block === undefined) {
        block = { type: 'toolCall', id: id ?? '', name, arguments: {}, partialArgs: '' }
        output.content.push(block)
      }
      if (index !== undefined) toolsByIndex.set(index, block)
      if (id !== undefined) {
        toolsById.set(id, block)
        if (block.id.length === 0) block.id = id
      }
      if (block.name.length === 0 && name.length > 0) block.name = name
      return block
    }

    for await (const data of sseEvents(response.body)) {
      if (data === '[DONE]') break
      const raw = parseSseJson(data)
      await options?.onProviderStreamEvent?.(raw, model)
      if (!isRecord(raw)) throw new Error('Provider stream event is not an object')
      if (raw.error !== undefined) throw new Error(`Provider stream error: ${JSON.stringify(raw.error)}`)
      if (typeof raw.id === 'string') output.responseId ??= raw.id
      if (typeof raw.model === 'string' && raw.model.length > 0 && raw.model !== model.id) output.responseModel ??= raw.model
      const rawUsage = isRecord(raw.usage) ? raw.usage : undefined
      if (rawUsage !== undefined) output.usage = parseUsage(rawUsage)
      if (raw.choices !== undefined && !Array.isArray(raw.choices)) throw new Error('Provider stream choices are not an array')
      const first: unknown = Array.isArray(raw.choices) ? raw.choices[0] : undefined
      if (first === undefined) continue
      if (!isRecord(first)) throw new Error('Provider stream choice is not an object')
      if (rawUsage === undefined && isRecord(first.usage)) output.usage = parseUsage(first.usage)
      if (first.finish_reason !== undefined && first.finish_reason !== null) {
        if (typeof first.finish_reason !== 'string') throw new Error('Provider finish_reason is not a string')
        applyFinishReason(output, first.finish_reason)
        hasFinishReason = true
      }
      if (first.delta === undefined || first.delta === null) continue
      if (!isRecord(first.delta)) throw new Error('Provider stream delta is not an object')
      const delta = first.delta
      let reasoning: string | undefined
      let reasoningField: string | undefined
      for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        if (typeof delta[field] === 'string' && delta[field].length > 0) {
          reasoning = delta[field]
          reasoningField = field
          break
        }
      }
      if (reasoning !== undefined && reasoningField !== undefined) {
        let block = thinkingBlock
        if (block === undefined) {
          block = ensureThinking(reasoningField)
          yield { type: 'thinking_start', contentIndex: output.content.indexOf(block), partial: output }
        }
        block.thinking += reasoning
        yield { type: 'thinking_delta', contentIndex: output.content.indexOf(block), delta: reasoning, partial: output }
      }
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== 'string') throw new Error('Provider text delta is not a string')
        if (delta.content.length > 0) {
          let block = textBlock
          if (block === undefined) {
            block = ensureText()
            yield { type: 'text_start', contentIndex: output.content.indexOf(block), partial: output }
          }
          block.text += delta.content
          yield { type: 'text_delta', contentIndex: output.content.indexOf(block), delta: delta.content, partial: output }
        }
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw new Error('Provider tool_calls delta is not an array')
        for (const value of delta.tool_calls) {
          if (!isRecord(value)) throw new Error('Provider tool call delta is not an object')
          const block = ensureTool(value)
          if (!startedTools.has(block)) {
            startedTools.add(block)
            yield { type: 'toolcall_start', contentIndex: output.content.indexOf(block), partial: output }
          }
          const fn = isRecord(value.function) ? value.function : undefined
          const argumentDelta = typeof fn?.arguments === 'string' ? fn.arguments : ''
          block.partialArgs = (block.partialArgs ?? '') + argumentDelta
          yield { type: 'toolcall_delta', contentIndex: output.content.indexOf(block), delta: argumentDelta, partial: output }
        }
      }
    }

    for (const block of output.content) {
      const contentIndex = output.content.indexOf(block)
      if (block.type === 'text') yield { type: 'text_end', contentIndex, content: block.text, partial: output }
      else if (block.type === 'thinking') yield { type: 'thinking_end', contentIndex, content: block.thinking, partial: output }
      else {
        Object.assign(block, parseToolArguments(block.partialArgs ?? ''))
        delete block.partialArgs
        yield { type: 'toolcall_end', contentIndex, toolCall: block, partial: output }
      }
    }
    options?.signal?.throwIfAborted()
    if (!hasFinishReason && !compat.supportsFinishReason) {
      output.stopReason = output.content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop'
    }
    if (output.stopReason === 'error') throw new Error(output.errorMessage ?? 'Provider returned an error stop reason')
    if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === 'pending') {
      throw new Error('Stream ended without finish_reason')
    }
    if (output.stopReason !== 'stop' && output.stopReason !== 'length' && output.stopReason !== 'toolUse') {
      throw new Error(`Provider stream ended with invalid stop reason: ${output.stopReason}`)
    }
    yield { type: 'done', reason: output.stopReason, message: output }
  } catch (error: unknown) {
    for (const block of output.content) {
      if (block.type === 'toolCall') delete block.partialArgs
    }
    output.stopReason = options?.signal?.aborted === true ? 'aborted' : 'error'
    output.errorMessage = errorText(error)
    yield { type: 'error', reason: output.stopReason, error: output }
  }
}

/**
 * Browser Fetch implementation of OpenAI-compatible chat completions.
 * @returns the completions stream and simple-stream bindings.
 */
export function openAICompletionsApi(): ProviderStreams {
  return {
    stream(model, context, options) {
      assertCredentials(model, options)
      return streamEvents(model, context, options)
    },
    streamSimple(model, context, options) {
      assertCredentials(model, options)
      const reasoningEffort = options?.reasoning === 'off' ? undefined : options?.reasoning
      return streamEvents(model, context, { ...options, reasoningEffort })
    },
  }
}

/** Anthropic messages API binding (unavailable). */
export const anthropicMessagesApi = notImplementedFail(MODULE, 'anthropicMessagesApi')

/** OpenAI responses API binding (unavailable). */
export const openAIResponsesApi = notImplementedFail(MODULE, 'openAIResponsesApi')

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createProvider, createModels, getSupportedThinkingLevels, isContextOverflow, builtinModels, builtinProviders,
  getBuiltinModels, getAllBuiltinModels, anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi,
}
