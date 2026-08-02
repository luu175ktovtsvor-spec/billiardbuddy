import type {
  PersonalModelAuthMode,
  PersonalModelProtocol,
} from './personalModels'
import {
  personalModelCatalogEntries,
  type PersonalModelCatalogEntry,
} from './personalModelCatalog'

/**
 * Product-owned onboarding facts for user-supplied model credentials.
 *
 * These records deliberately describe only a provider's public setup path:
 * where to obtain a Key, its canonical API base URL, and the wire protocols
 * that BilliardBuddy can route.  They do not claim model capacity.  Exact
 * context and output limits remain in `personalModelCatalog.ts`, where each
 * model must have its own official evidence.
 */
export const PERSONAL_MODEL_PROVIDER_SETUP_CATALOG_REVISION = 3 as const

/**
 * A provider route is deliberately more precise than a vendor name.  One
 * vendor can expose a normal API and a separately billed coding plan with a
 * different Key, base URL, or usage restriction.
 */
export type PersonalModelProviderPresetKind = 'official' | 'aggregator'
export type PersonalModelDiscoveryMode = 'openai-compatible' | 'manual-only'

type PersonalModelProviderSetupPreset = {
  /** Stable BilliardBuddy identifier, never derived from the display label. */
  id: string
  provider_id: string
  provider_label: string
  /** Shown with the vendor name when this is a separate subscription route. */
  plan_label?: string
  kind: PersonalModelProviderPresetKind
  is_coding_plan: boolean
  /**
   * Some vendors limit a Coding Plan to named tools or products.  We retain
   * the preset for users who have confirmed compatibility with that vendor,
   * but never imply that BilliardBuddy is an automatically approved client.
   */
  requires_provider_compatibility_confirmation: boolean
  /** Canonical origin used to prefill a new direct-provider configuration. */
  base_url: string
  /**
   * Azure-style providers have a user-specific resource hostname. The
   * template is shown as a starting point, while Electron Main validates the
   * entered hostname against `base_url_host_suffix` before using it.
   */
  requires_user_base_url?: boolean
  base_url_host_suffix?: string
  default_protocol: PersonalModelProtocol
  supported_protocols: readonly PersonalModelProtocol[]
  auth_mode: PersonalModelAuthMode
  /** Official account portal where the user can create or manage an API Key. */
  api_key_url: string
  /** Official provider documentation, not a community compatibility guide. */
  documentation_url: string
  /** `/models` is attempted only with the entered Key and never persisted. */
  model_discovery: PersonalModelDiscoveryMode
}

/**
 * A setup preset plus only the verified model contracts that exactly match its
 * direct upstream route.  Keeping this derived prevents the provider list and
 * the model-capability list from becoming two competing sources of truth.
 */
export type PersonalModelProviderPreset = PersonalModelProviderSetupPreset & {
  catalog_entries: readonly PersonalModelCatalogEntry[]
}

// These URLs are onboarding links only. They are sent to the Renderer as
// immutable catalog data; the user Key is never part of this catalog or URL.
//
// The shape follows the useful part of CC Switch's provider model: normal API
// and Coding Plan routes are independent entries, rather than a model-name
// toggle. Unlike CC Switch, BilliardBuddy does not write another product's
// `~/.codex` files or take over that product's process. These routes feed only
// BilliardBuddy's private Electron Main credential broker and Rust App Server.
const PERSONAL_MODEL_PROVIDER_SETUP_CATALOG: readonly PersonalModelProviderSetupPreset[] = [
  {
    id: 'deepseek',
    provider_id: 'deepseek',
    provider_label: 'DeepSeek',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.deepseek.com/v1',
    default_protocol: 'openai-responses',
    supported_protocols: ['openai-responses', 'openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    documentation_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'openai',
    provider_id: 'openai',
    provider_label: 'OpenAI',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.openai.com/v1',
    default_protocol: 'openai-responses',
    supported_protocols: ['openai-responses', 'openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.openai.com/api-keys',
    documentation_url: 'https://developers.openai.com/api/docs/models',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'azure-openai',
    provider_id: 'azure-openai',
    provider_label: 'Azure OpenAI',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    requires_user_base_url: true,
    base_url_host_suffix: '.openai.azure.com',
    default_protocol: 'openai-responses',
    supported_protocols: ['openai-responses', 'openai-compatible'],
    auth_mode: 'api-key',
    api_key_url: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI',
    documentation_url: 'https://learn.microsoft.com/azure/ai-foundry/openai/how-to/switching-endpoints',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'kimi-api',
    provider_id: 'moonshot',
    provider_label: 'Kimi',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.moonshot.cn/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.moonshot.cn/console/api-keys',
    documentation_url: 'https://platform.kimi.com/docs/api/overview',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'kimi-coding',
    provider_id: 'moonshot',
    provider_label: 'Kimi',
    plan_label: 'Kimi Code',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: true,
    base_url: 'https://api.kimi.com/coding/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://www.kimi.com/code/',
    documentation_url: 'https://www.kimi.com/help/kimi-code',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'zhipu-glm',
    provider_id: 'zhipu',
    provider_label: '智谱 GLM',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    documentation_url: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'zhipu-coding-plan',
    provider_id: 'zhipu',
    provider_label: '智谱 GLM',
    plan_label: 'Coding Plan',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: true,
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    documentation_url: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'qianfan-api',
    provider_id: 'qianfan',
    provider_label: '百度千帆',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://qianfan.baidubce.com/v2',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    documentation_url: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'qianfan-coding-plan',
    provider_id: 'qianfan',
    provider_label: '百度千帆',
    plan_label: 'Coding Plan',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://qianfan.baidubce.com/v2/coding',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    documentation_url: 'https://cloud.baidu.com/doc/qianfan/s/imlg0beiu',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'aliyun-model-studio-cn',
    provider_id: 'aliyun-model-studio',
    provider_label: '阿里云百炼',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://bailian.console.aliyun.com/#/api-key',
    documentation_url: 'https://help.aliyun.com/en/model-studio/first-api-call-to-qwen',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'minimax-api',
    provider_id: 'minimax',
    provider_label: 'MiniMax',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.minimaxi.com/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    documentation_url: 'https://platform.minimaxi.com/docs/api-reference/text-openai-api',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'minimax-token-plan',
    provider_id: 'minimax',
    provider_label: 'MiniMax',
    plan_label: 'Token Plan',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.minimaxi.com/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.minimaxi.com/subscribe/coding-plan',
    documentation_url: 'https://platform.minimaxi.com/docs/token-plan/other-tools',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'stepfun-step-plan',
    provider_id: 'stepfun',
    provider_label: '阶跃星辰',
    plan_label: 'Step Plan',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.stepfun.com/step_plan/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.stepfun.com/interface-key',
    documentation_url: 'https://platform.stepfun.com/docs/zh/step-plan/overview',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'tencent-hunyuan-tokenhub',
    provider_id: 'tencent-hunyuan',
    provider_label: '腾讯混元',
    plan_label: 'Token Hub',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://tokenhub.tencentmaas.com/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://console.cloud.tencent.com/tokenhub/apikey',
    documentation_url: 'https://cloud.tencent.com/document/product/1729',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'volcengine-ark',
    provider_id: 'volcengine-ark',
    provider_label: '火山引擎方舟',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    documentation_url: 'https://www.volcengine.com/docs/82379',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'byteplus-modelark-coding',
    provider_id: 'byteplus-modelark',
    provider_label: 'BytePlus ModelArk',
    plan_label: 'Coding',
    kind: 'official',
    is_coding_plan: true,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://www.byteplus.com/en/product/modelark',
    documentation_url: 'https://docs.byteplus.com/en/docs/ModelArk',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'longcat',
    provider_id: 'longcat',
    provider_label: 'LongCat',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.longcat.chat/openai/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://longcat.chat/platform/api_keys',
    documentation_url: 'https://longcat.chat/platform',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'xiaomi-mimo',
    provider_id: 'xiaomi-mimo',
    provider_label: '小米 MiMo',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.xiaomimimo.com/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.xiaomimimo.com/#/console/api-keys',
    documentation_url: 'https://platform.xiaomimimo.com',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'siliconflow',
    provider_id: 'siliconflow',
    provider_label: '硅基流动',
    kind: 'aggregator',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.siliconflow.cn/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://cloud.siliconflow.cn/account/ak',
    documentation_url: 'https://docs.siliconflow.cn',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'modelscope',
    provider_id: 'modelscope',
    provider_label: 'ModelScope',
    kind: 'aggregator',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api-inference.modelscope.cn/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://modelscope.cn/my/myaccesstoken',
    documentation_url: 'https://modelscope.cn/docs',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'openrouter',
    provider_id: 'openrouter',
    provider_label: 'OpenRouter',
    kind: 'aggregator',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://openrouter.ai/api/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://openrouter.ai/keys',
    documentation_url: 'https://openrouter.ai/docs',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'xai',
    provider_id: 'xai',
    provider_label: 'xAI',
    kind: 'official',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://api.x.ai/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://console.x.ai',
    documentation_url: 'https://docs.x.ai',
    model_discovery: 'openai-compatible',
  },
  {
    id: 'nvidia-nim',
    provider_id: 'nvidia-nim',
    provider_label: 'NVIDIA NIM',
    kind: 'aggregator',
    is_coding_plan: false,
    requires_provider_compatibility_confirmation: false,
    base_url: 'https://integrate.api.nvidia.com/v1',
    default_protocol: 'openai-compatible',
    supported_protocols: ['openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://build.nvidia.com/settings/api-keys',
    documentation_url: 'https://docs.nvidia.com/nim/large-language-models/latest',
    model_discovery: 'openai-compatible',
  },
] as const

function validProviderSetupUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

/** Catch accidental duplicate routes or an unsafe onboarding URL at startup. */
function assertProviderSetupCatalog(): void {
  const ids = new Set<string>()
  for (const preset of PERSONAL_MODEL_PROVIDER_SETUP_CATALOG) {
    if (
      !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(preset.id)
      || ids.has(preset.id)
      || !preset.provider_id
      || !preset.provider_label
      || !validProviderSetupUrl(preset.base_url)
      || !validProviderSetupUrl(preset.api_key_url)
      || !validProviderSetupUrl(preset.documentation_url)
      || !preset.supported_protocols.includes(preset.default_protocol)
      || (preset.requires_user_base_url && !preset.base_url_host_suffix)
    ) throw new Error('PERSONAL_MODEL_PROVIDER_SETUP_CATALOG_CORRUPT')
    ids.add(preset.id)
  }
}

assertProviderSetupCatalog()

function normalizedProviderPresetId(value: string | undefined | null): string | undefined {
  const id = value?.trim()
  return id || undefined
}

export function personalModelProviderPresets(): readonly PersonalModelProviderPreset[] {
  return PERSONAL_MODEL_PROVIDER_SETUP_CATALOG.map(providerPresetWithCatalogEntries)
}

export function personalModelProviderPreset(
  id: string | undefined | null,
): PersonalModelProviderPreset | undefined {
  const normalized = normalizedProviderPresetId(id)
  const preset = normalized
    ? PERSONAL_MODEL_PROVIDER_SETUP_CATALOG.find(entry => entry.id === normalized)
    : undefined
  return preset ? providerPresetWithCatalogEntries(preset) : undefined
}

function providerPresetWithCatalogEntries(
  preset: PersonalModelProviderSetupPreset,
): PersonalModelProviderPreset {
  const catalogEntries = personalModelCatalogEntries().filter(entry =>
    entry.provider_id === preset.provider_id
    && entry.base_url === preset.base_url
    && entry.auth_mode === preset.auth_mode
    && preset.supported_protocols.includes(entry.protocol))
  // Provider onboarding and model capability evidence are intentionally
  // separate. `/models` tells us what a particular Key can access, but not a
  // model's context or output contract. A newly added provider therefore
  // remains usable for secure discovery before BilliardBuddy has shipped an
  // evidence-backed one-click model entry for it.
  return { ...preset, catalog_entries: catalogEntries }
}
