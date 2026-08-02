import type {
  PersonalModelAuthMode,
  PersonalModelCapability,
  PersonalModelProtocol,
} from './personalModels'

/**
 * Product-owned facts for direct, user-key model presets.
 *
 * A provider's `/v1/models` response can tell us which model IDs a Key can
 * access, but it is not a standardized capability document.  In particular,
 * it normally omits the full context window and the provider output ceiling.
 * Those values live here only after a BilliardBuddy maintainer checks the
 * upstream provider's own documentation.  A discovered but unlisted model
 * remains a user-declared configuration instead of inheriting a guess.
 */
export const PERSONAL_MODEL_CAPABILITY_CATALOG_REVISION = 1 as const

export type PersonalModelCatalogEntry = {
  /** Stable BilliardBuddy id; never derive trust from a display name. */
  id: string
  provider_id: string
  provider_label: string
  label: string
  base_url: string
  model: string
  protocol: PersonalModelProtocol
  auth_mode: PersonalModelAuthMode
  capabilities: readonly PersonalModelCapability[]
  supports_tool_calls: boolean
  supports_parallel_tool_calls: boolean
  context_window_tokens: number
  max_output_tokens: number
  /** Official upstream source, not an aggregator's or a community list. */
  documentation_url: string
  /** Date that the source above was checked for this exact entry. */
  verified_at: string
}

// DeepSeek publishes these values in its Models & Pricing table.  The table
// names the OpenAI-format base URL, a 1M context window and 384K maximum
// output for V4 Flash and V4 Pro; it separately marks Responses support as
// Flash-only.  Verified 2026-08-02:
// https://api-docs.deepseek.com/quick_start/pricing/
const DEEPSEEK_DOCUMENTATION_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
const DEEPSEEK_VERIFIED_AT = '2026-08-02'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_000_000
const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000

/**
 * The bundled catalog is deliberately small and evidence-backed.  Add a new
 * provider/model only with its official capacity source and protocol facts;
 * do not turn a model ID returned by `/v1/models` into a presumed contract.
 */
export const PERSONAL_MODEL_CAPABILITY_CATALOG: readonly PersonalModelCatalogEntry[] = [
  {
    id: 'deepseek/deepseek-v4-flash/responses',
    provider_id: 'deepseek',
    provider_label: 'DeepSeek',
    label: 'DeepSeek V4 Flash',
    base_url: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-flash',
    protocol: 'openai-responses',
    auth_mode: 'bearer',
    capabilities: ['TextReasoning'],
    supports_tool_calls: true,
    supports_parallel_tool_calls: true,
    context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    documentation_url: DEEPSEEK_DOCUMENTATION_URL,
    verified_at: DEEPSEEK_VERIFIED_AT,
  },
  {
    id: 'deepseek/deepseek-v4-pro/chat-completions',
    provider_id: 'deepseek',
    provider_label: 'DeepSeek',
    label: 'DeepSeek V4 Pro',
    base_url: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-pro',
    protocol: 'openai-compatible',
    auth_mode: 'bearer',
    capabilities: ['TextReasoning'],
    supports_tool_calls: true,
    supports_parallel_tool_calls: true,
    context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    documentation_url: DEEPSEEK_DOCUMENTATION_URL,
    verified_at: DEEPSEEK_VERIFIED_AT,
  },
] as const

function catalogEntryId(value: string | undefined | null): string | undefined {
  const id = value?.trim()
  return id || undefined
}

export function personalModelCatalogEntries(): readonly PersonalModelCatalogEntry[] {
  return PERSONAL_MODEL_CAPABILITY_CATALOG
}

export function personalModelCatalogEntry(id: string | undefined | null): PersonalModelCatalogEntry | undefined {
  const normalized = catalogEntryId(id)
  return normalized ? PERSONAL_MODEL_CAPABILITY_CATALOG.find(entry => entry.id === normalized) : undefined
}

/**
 * Match only the exact direct upstream route.  A relay can expose the same
 * model ID with a different output cap, so it must not receive this catalog's
 * trust merely because its `/v1/models` response contains a familiar name.
 */
export function personalModelCatalogEntryForEndpoint(input: {
  base_url: string
  model: string
  protocol: PersonalModelProtocol
}): PersonalModelCatalogEntry | undefined {
  return PERSONAL_MODEL_CAPABILITY_CATALOG.find(entry =>
    entry.base_url === input.base_url
    && entry.model === input.model
    && entry.protocol === input.protocol)
}
