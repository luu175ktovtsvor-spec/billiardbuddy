import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createModelFromProviderConfig } from '../../model/modelFactory'
import {
  providerConfigFromEnv,
  redactedProviderSummary,
  type ProviderApiFormat,
  type ProviderAuthStrategy,
  type RuntimeProviderConfig,
  type RuntimeProviderSummary,
} from '../../model/providerConfig'
import { normalizeNetworkSettings, type NetworkSettings } from '../../model/networkSettings'
import { normalizeReasoningEffort, type ReasoningEffort } from '../../model/reasoningEffort'
import type { OpenAIChatImageContentMode } from '../../proxy/toOpenAiChatRequest'
import type { FetchLike } from '../../proxy/ProxyModel'
import { userText } from '../../types/message'
import { makeCredentialCipher, type CredentialCipher } from './credentialCipher'

const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const CURRENT_SCHEMA_VERSION = 1

export interface SavedProvider {
  id: string
  name: string
  enabled: boolean
  apiFormat: ProviderApiFormat
  baseUrl: string
  apiKey?: string
  authToken?: string
  authStrategy?: ProviderAuthStrategy
  model: string
  maxTokens?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  reasoningEffort?: ReasoningEffort
  imageContentMode?: OpenAIChatImageContentMode
  networkSettings?: NetworkSettings
  createdAt: string
  updatedAt: string
}

export type PublicProvider = Omit<SavedProvider, 'apiKey' | 'authToken'> & {
  hasApiKey: boolean
  hasAuthToken: boolean
}

export interface ProvidersIndex {
  schemaVersion: number
  activeId: string | null
  providers: SavedProvider[]
}

export interface ProviderListResult {
  providers: PublicProvider[]
  activeId: string | null
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  summary: RuntimeProviderSummary
  textSample?: string
  error?: string
}

export interface RuntimeProviderResolution {
  config: RuntimeProviderConfig
  summary: RuntimeProviderSummary
  source: 'saved-provider' | 'env'
  providerId?: string
  providerName?: string
}

type ProviderInput = {
  id?: unknown
  name?: unknown
  enabled?: unknown
  apiFormat?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  authToken?: unknown
  authStrategy?: unknown
  model?: unknown
  maxTokens?: unknown
  requestTimeoutMs?: unknown
  idleTimeoutMs?: unknown
  reasoningEffort?: unknown
  imageContentMode?: unknown
  networkSettings?: unknown
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function normalizeApiFormat(value: unknown): ProviderApiFormat | undefined {
  const v = clean(value)?.toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai_chat' || v === 'openai' || v === 'chat_completions') return 'openai_chat'
  return undefined
}

function normalizeAuthStrategy(value: unknown): ProviderAuthStrategy | undefined {
  const v = clean(value)
  if (
    v === 'api_key' ||
    v === 'auth_token' ||
    v === 'auth_token_empty_api_key' ||
    v === 'dual_same_token' ||
    v === 'dual_dummy'
  ) return v
  return undefined
}

function normalizeImageMode(value: unknown): OpenAIChatImageContentMode | undefined {
  return value === 'text_only' || value === 'vision' ? value : undefined
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function publicProvider(provider: SavedProvider): PublicProvider {
  const { apiKey: _apiKey, authToken: _authToken, ...rest } = provider
  return {
    ...rest,
    hasApiKey: !!provider.apiKey,
    hasAuthToken: !!provider.authToken,
  }
}

function validateProviderId(id: string): void {
  if (!PROVIDER_ID_RE.test(id)) throw new Error('非法 provider id')
}

function providerFromInput(input: ProviderInput, existing?: SavedProvider): SavedProvider {
  const timestamp = nowIso()
  const id = clean(input.id) ?? existing?.id ?? crypto.randomUUID()
  validateProviderId(id)

  const name = clean(input.name) ?? existing?.name
  const baseUrl = clean(input.baseUrl) ?? existing?.baseUrl
  const model = clean(input.model) ?? existing?.model
  const apiFormat = normalizeApiFormat(input.apiFormat) ?? existing?.apiFormat ?? 'openai_chat'
  const apiKey = clean(input.apiKey) ?? existing?.apiKey
  const authToken = clean(input.authToken) ?? existing?.authToken

  if (!name) throw new Error('provider.name required')
  if (!baseUrl) throw new Error('provider.baseUrl required')
  if (!model) throw new Error('provider.model required')
  if (!apiKey && !authToken) throw new Error('provider apiKey/authToken required')

  const next: SavedProvider = {
    id,
    name,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
    apiFormat,
    baseUrl: withoutTrailingSlash(baseUrl),
    model,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }

  if (apiKey) next.apiKey = apiKey
  if (authToken) next.authToken = authToken

  const authStrategy = normalizeAuthStrategy(input.authStrategy) ?? existing?.authStrategy
  if (authStrategy) next.authStrategy = authStrategy

  const maxTokens = parsePositiveInt(input.maxTokens) ?? existing?.maxTokens
  if (maxTokens !== undefined) next.maxTokens = maxTokens

  const requestTimeoutMs = parsePositiveInt(input.requestTimeoutMs) ?? existing?.requestTimeoutMs
  if (requestTimeoutMs !== undefined) next.requestTimeoutMs = requestTimeoutMs

  const idleTimeoutMs = parsePositiveInt(input.idleTimeoutMs) ?? existing?.idleTimeoutMs
  if (idleTimeoutMs !== undefined) next.idleTimeoutMs = idleTimeoutMs

  const reasoningEffort = normalizeReasoningEffort(clean(input.reasoningEffort)) ?? existing?.reasoningEffort
  if (reasoningEffort) next.reasoningEffort = reasoningEffort

  const imageContentMode = normalizeImageMode(input.imageContentMode) ?? existing?.imageContentMode
  if (imageContentMode) next.imageContentMode = imageContentMode

  if (input.networkSettings !== undefined || existing?.networkSettings) {
    next.networkSettings = normalizeNetworkSettings(input.networkSettings ?? existing?.networkSettings)
  }

  return next
}

function isSavedProvider(value: unknown): value is SavedProvider {
  if (!isRecord(value)) return false
  if (!clean(value.id) || !clean(value.name) || !clean(value.baseUrl) || !clean(value.model)) return false
  if (!normalizeApiFormat(value.apiFormat)) return false
  if (!clean(value.apiKey) && !clean(value.authToken)) return false
  if (!clean(value.createdAt) || !clean(value.updatedAt)) return false
  return PROVIDER_ID_RE.test(clean(value.id)!)
}

function normalizeSavedProvider(provider: SavedProvider): SavedProvider {
  return { ...provider, enabled: provider.enabled !== false }
}

function providerToRuntimeConfig(provider: SavedProvider): RuntimeProviderConfig {
  return {
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authToken: provider.authToken,
    authStrategy: provider.authStrategy,
    model: provider.model,
    maxTokens: provider.maxTokens,
    requestTimeoutMs: provider.requestTimeoutMs,
    idleTimeoutMs: provider.idleTimeoutMs,
    reasoningEffort: provider.reasoningEffort,
    imageContentMode: provider.imageContentMode,
    networkSettings: provider.networkSettings,
  }
}

function sameRuntimeTarget(a: RuntimeProviderConfig, b: RuntimeProviderConfig): boolean {
  return a.apiFormat === b.apiFormat &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model
}

function runtimeFromProvider(provider: SavedProvider): RuntimeProviderResolution {
  const config = providerToRuntimeConfig(provider)
  return {
    config,
    summary: redactedProviderSummary(config),
    source: 'saved-provider',
    providerId: provider.id,
    providerName: provider.name,
  }
}

function pushRuntimeOnce(runtimes: RuntimeProviderResolution[], runtime: RuntimeProviderResolution): void {
  if (!runtimes.some(existing => sameRuntimeTarget(existing.config, runtime.config))) runtimes.push(runtime)
}

function nextEnabledProviderId(providers: SavedProvider[], excludedId: string): string | null {
  return providers.find(provider => provider.id !== excludedId && provider.enabled !== false)?.id ?? null
}

export interface ProviderServiceOptions {
  /** 凭据 at-rest 加密密钥(hex,32 字节)。缺省读环境 QF_CRED_KEY(sidecar 由 electron 主进程注入)。
   *  无密钥 → 明文透传(不倒退旧行为)。 */
  credentialKeyHex?: string
}

export class ProviderService {
  private readonly indexPath: string
  private readonly cipher: CredentialCipher

  constructor(private readonly rootDir: string, opts: ProviderServiceOptions = {}) {
    this.indexPath = join(rootDir, 'providers.json')
    this.cipher = makeCredentialCipher(opts.credentialKeyHex ?? process.env.QF_CRED_KEY)
  }

  /** 落盘前:把敏感字段(apiKey/authToken)加密成密文;返回副本,绝不改内存里的明文 provider。 */
  private encryptProviderSecrets(provider: SavedProvider): SavedProvider {
    const next = { ...provider }
    if (next.apiKey !== undefined) next.apiKey = this.cipher.encrypt(next.apiKey)
    if (next.authToken !== undefined) next.authToken = this.cipher.encrypt(next.authToken)
    return next
  }

  /** 读回时:把密文解回明文(内存里始终持明文,下游 model factory 不变)。
   *  某条解不开(密钥被换/损坏)时丢弃该 provider 而非整体崩掉,返回 null。 */
  private decryptProviderSecrets(provider: SavedProvider): SavedProvider | null {
    try {
      const next = { ...provider }
      if (next.apiKey !== undefined) next.apiKey = this.cipher.decrypt(next.apiKey)
      if (next.authToken !== undefined) next.authToken = this.cipher.decrypt(next.authToken)
      return next
    } catch {
      return null
    }
  }

  async list(): Promise<ProviderListResult> {
    const index = await this.readIndex()
    return {
      activeId: index.activeId,
      providers: index.providers.map(publicProvider),
    }
  }

  async get(id: string): Promise<PublicProvider | null> {
    const provider = await this.getSaved(id)
    return provider ? publicProvider(provider) : null
  }

  async create(input: ProviderInput): Promise<PublicProvider> {
    const index = await this.readIndex()
    const provider = providerFromInput(input)
    if (index.providers.some(p => p.id === provider.id)) throw new Error(`provider already exists: ${provider.id}`)
    index.providers.push(provider)
    if (!index.activeId) index.activeId = provider.id
    await this.writeIndex(index)
    return publicProvider(provider)
  }

  async update(id: string, input: ProviderInput): Promise<PublicProvider> {
    validateProviderId(id)
    const index = await this.readIndex()
    const idx = index.providers.findIndex(p => p.id === id)
    if (idx === -1) throw new Error(`provider not found: ${id}`)
    const provider = providerFromInput({ ...input, id }, index.providers[idx])
    index.providers[idx] = provider
    if (index.activeId === id && provider.enabled === false) index.activeId = nextEnabledProviderId(index.providers, id)
    await this.writeIndex(index)
    return publicProvider(provider)
  }

  async setEnabled(id: string, enabled: boolean): Promise<PublicProvider> {
    validateProviderId(id)
    const index = await this.readIndex()
    const idx = index.providers.findIndex(p => p.id === id)
    if (idx === -1) throw new Error(`provider not found: ${id}`)
    const provider = { ...index.providers[idx]!, enabled, updatedAt: nowIso() }
    index.providers[idx] = provider
    if (!enabled && index.activeId === id) index.activeId = nextEnabledProviderId(index.providers, id)
    await this.writeIndex(index)
    return publicProvider(provider)
  }

  async reorder(ids: string[]): Promise<ProviderListResult> {
    const order = ids.map(id => {
      const cleanId = clean(id)
      if (!cleanId) throw new Error('provider order contains empty id')
      validateProviderId(cleanId)
      return cleanId
    })
    if (new Set(order).size !== order.length) throw new Error('provider order contains duplicate id')
    const index = await this.readIndex()
    const byId = new Map(index.providers.map(provider => [provider.id, provider]))
    for (const id of order) {
      if (!byId.has(id)) throw new Error(`provider not found: ${id}`)
    }
    index.providers = [
      ...order.map(id => byId.get(id)!),
      ...index.providers.filter(provider => !order.includes(provider.id)),
    ].map(provider => ({ ...provider, updatedAt: order.includes(provider.id) ? nowIso() : provider.updatedAt }))
    await this.writeIndex(index)
    return this.list()
  }

  async delete(id: string): Promise<void> {
    validateProviderId(id)
    const index = await this.readIndex()
    if (index.activeId === id) throw new Error('cannot delete active provider')
    const next = index.providers.filter(p => p.id !== id)
    if (next.length === index.providers.length) throw new Error(`provider not found: ${id}`)
    index.providers = next
    await this.writeIndex(index)
  }

  async activate(id: string): Promise<PublicProvider> {
    validateProviderId(id)
    const index = await this.readIndex()
    const provider = index.providers.find(p => p.id === id)
    if (!provider) throw new Error(`provider not found: ${id}`)
    if (provider.enabled === false) throw new Error('cannot activate disabled provider')
    index.activeId = id
    await this.writeIndex(index)
    return publicProvider(provider)
  }

  async clearActive(): Promise<void> {
    const index = await this.readIndex()
    index.activeId = null
    await this.writeIndex(index)
  }

  async resolveRuntimeConfigs(env: Record<string, string | undefined> = process.env): Promise<RuntimeProviderResolution[]> {
    const index = await this.readIndex()
    const runtimes: RuntimeProviderResolution[] = []
    const enabledProviders = index.providers.filter(provider => provider.enabled !== false)
    if (index.activeId) {
      const provider = enabledProviders.find(p => p.id === index.activeId)
      if (provider) pushRuntimeOnce(runtimes, runtimeFromProvider(provider))
      for (const fallbackProvider of enabledProviders) {
        if (fallbackProvider.id === index.activeId) continue
        pushRuntimeOnce(runtimes, runtimeFromProvider(fallbackProvider))
      }
    }

    const config = providerConfigFromEnv(env)
    if (config && !runtimes.some(runtime => sameRuntimeTarget(runtime.config, config))) {
      runtimes.push({ config, summary: redactedProviderSummary(config), source: 'env' })
    }
    return runtimes
  }

  async resolveRuntimeConfig(env: Record<string, string | undefined> = process.env): Promise<RuntimeProviderResolution | null> {
    return (await this.resolveRuntimeConfigs(env))[0] ?? null
  }

  async testProvider(id: string, opts: { fetchImpl?: FetchLike } = {}): Promise<ProviderTestResult> {
    const provider = await this.getSaved(id)
    if (!provider) {
      return {
        ok: false,
        latencyMs: 0,
        summary: {
          apiFormat: 'openai_chat',
          baseUrl: '',
          model: '',
          hasApiKey: false,
          hasAuthToken: false,
        },
        error: `provider not found: ${id}`,
      }
    }
    return testRuntimeProviderConfig(providerToRuntimeConfig(provider), opts)
  }

  async testProviderConfig(input: ProviderInput, opts: { fetchImpl?: FetchLike } = {}): Promise<ProviderTestResult> {
    const provider = providerFromInput(input)
    return testRuntimeProviderConfig(providerToRuntimeConfig(provider), opts)
  }

  private async getSaved(id: string): Promise<SavedProvider | null> {
    validateProviderId(id)
    return (await this.readIndex()).providers.find(p => p.id === id) ?? null
  }

  private async readIndex(): Promise<ProvidersIndex> {
    let raw = ''
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch {
      return { schemaVersion: CURRENT_SCHEMA_VERSION, activeId: null, providers: [] }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      const record = isRecord(parsed) ? parsed : {}
      const providers = Array.isArray(record.providers)
        ? record.providers
            .filter(isSavedProvider)
            .map(normalizeSavedProvider)
            .map(provider => this.decryptProviderSecrets(provider))
            .filter((provider): provider is SavedProvider => provider !== null)
        : []
      const activeId = typeof record.activeId === 'string' && providers.some(p => p.id === record.activeId)
        ? record.activeId
        : null
      return { schemaVersion: CURRENT_SCHEMA_VERSION, activeId, providers }
    } catch {
      return { schemaVersion: CURRENT_SCHEMA_VERSION, activeId: null, providers: [] }
    }
  }

  private async writeIndex(index: ProvidersIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    // 落盘副本:敏感字段加密,其余不变。内存里的 index 仍是明文,不受影响。
    const serializable: ProvidersIndex = {
      ...index,
      providers: index.providers.map(provider => this.encryptProviderSecrets(provider)),
    }
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8')
    await rename(tmp, this.indexPath)
  }
}

async function testRuntimeProviderConfig(
  config: RuntimeProviderConfig,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ProviderTestResult> {
  const summary = redactedProviderSummary(config)
  const started = Date.now()
  try {
    const model = createModelFromProviderConfig(config, { fetchImpl: opts.fetchImpl })
    const step = await model.step({
      system: 'You are a provider connectivity checker. Reply with a short OK only.',
      messages: [userText('ping')],
      tools: [],
    })
    const latencyMs = Date.now() - started
    const text = step.kind === 'final' ? step.text : step.text ?? `tool_calls:${step.calls.length}`
    return {
      ok: true,
      latencyMs,
      summary,
      textSample: text.slice(0, 120),
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      summary,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
