import type { ProviderUsageAmount, ProviderUsageBudgetPolicy } from '../ts/shared/product/providerContracts'

export type GatewayQuotaEnvironment = Readonly<Record<string, string | undefined>>

export const DEFAULT_MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT = 50_000_000
export const QUOTA_POLICY_REVISION_ENV = 'GW_QUOTA_POLICY_REVISION'
export const MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT_ENV = 'GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT'

const UNBOUNDED_USAGE_LIMIT: ProviderUsageAmount = {
  requests: 1_000_000_000,
  input_bytes: 1_000_000_000_000,
  output_units: 1_000_000_000_000,
  total_tokens: 1_000_000_000_000,
}

const METERED_CAPABILITIES = [
  ['TextReasoning', 'TEXT_REASONING'],
  ['VisualEvidence', 'VISUAL_EVIDENCE'],
  ['MediaReasoning', 'MEDIA_REASONING'],
  ['ImageAdvice', 'IMAGE_ADVICE'],
  ['SpeechTranscription', 'SPEECH_TRANSCRIPTION'],
] as const

const LIMIT_SCOPES = ['principal', 'installation'] as const
const LIMIT_AXES = ['requests', 'input_bytes', 'output_units', 'total_tokens'] as const

export const DEFAULT_GATEWAY_USAGE_POLICY: ProviderUsageBudgetPolicy = gatewayUsagePolicyFromEnvironment()
export const MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT = DEFAULT_GATEWAY_USAGE_POLICY
  .capabilities.TextReasoning.installation.total_tokens

/**
 * Returns the one product-owned Gateway policy. All limits may be overridden
 * only through named, non-negative safe-integer environment values:
 * GW_QUOTA_<CAPABILITY>_<PRINCIPAL|INSTALLATION>_<REQUESTS|INPUT_BYTES|OUTPUT_UNITS|TOTAL_TOKENS>.
 *
 * The managed Agent installation token limit also has the clearer alias
 * GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT. Supplying both names is rejected so
 * production never silently selects one entitlement over another.
 */
export function gatewayUsagePolicyFromEnvironment(environment: GatewayQuotaEnvironment = process.env): ProviderUsageBudgetPolicy {
  const revision = readRevision(environment)
  const capabilities = Object.fromEntries(METERED_CAPABILITIES.map(([capability, environmentPrefix]) => [
    capability,
    {
      principal: readLimit(environment, environmentPrefix, 'principal', defaultPrincipalLimit(capability)),
      installation: readLimit(environment, environmentPrefix, 'installation', defaultInstallationLimit(capability)),
    },
  ])) as ProviderUsageBudgetPolicy['capabilities']

  return freezePolicy({ revision, period: 'utc_day', capabilities })
}

function defaultPrincipalLimit(capability: (typeof METERED_CAPABILITIES)[number][0]): ProviderUsageAmount {
  if (capability === 'TextReasoning') return { ...UNBOUNDED_USAGE_LIMIT }
  return {
    requests: 20_000,
    input_bytes: 500 * 1024 ** 3,
    output_units: capability === 'SpeechTranscription' ? 200_000_000 : 20_000_000,
    total_tokens: UNBOUNDED_USAGE_LIMIT.total_tokens,
  }
}

function defaultInstallationLimit(capability: (typeof METERED_CAPABILITIES)[number][0]): ProviderUsageAmount {
  if (capability === 'TextReasoning') {
    return { ...UNBOUNDED_USAGE_LIMIT, total_tokens: DEFAULT_MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT }
  }
  return {
    requests: 2_000,
    input_bytes: 50 * 1024 ** 3,
    output_units: capability === 'SpeechTranscription' ? 20_000_000 : 2_000_000,
    total_tokens: UNBOUNDED_USAGE_LIMIT.total_tokens,
  }
}

function readRevision(environment: GatewayQuotaEnvironment): string {
  const value = environment[QUOTA_POLICY_REVISION_ENV]
  if (value === undefined) return 'bb-agent-daily-token-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${QUOTA_POLICY_REVISION_ENV} must be 1-128 ASCII letters, digits, dots, underscores, or hyphens`)
  }
  return value
}

function readLimit(
  environment: GatewayQuotaEnvironment,
  capability: string,
  scope: (typeof LIMIT_SCOPES)[number],
  defaults: ProviderUsageAmount,
): ProviderUsageAmount {
  const limit = { ...defaults }
  for (const axis of LIMIT_AXES) {
    const name = `GW_QUOTA_${capability}_${scope.toUpperCase()}_${axis.toUpperCase()}`
    const alias = capability === 'TEXT_REASONING' && scope === 'installation' && axis === 'total_tokens'
      ? MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT_ENV
      : undefined
    limit[axis] = readLimitValue(environment, name, alias, defaults[axis])
  }
  return limit
}

function readLimitValue(environment: GatewayQuotaEnvironment, name: string, alias: string | undefined, fallback: number): number {
  const names = [name, alias].filter((candidate): candidate is string => candidate !== undefined && environment[candidate] !== undefined)
  if (names.length > 1) throw new Error(`${name} and ${alias} cannot both be set`)
  if (!names.length) return fallback
  const value = environment[names[0]!]
  if (!/^(0|[1-9][0-9]*)$/.test(value!)) throw new Error(`${names[0]} must be a non-negative safe integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${names[0]} must be a non-negative safe integer`)
  return parsed
}

function freezePolicy(policy: ProviderUsageBudgetPolicy): ProviderUsageBudgetPolicy {
  for (const limits of Object.values(policy.capabilities)) {
    Object.freeze(limits.principal)
    Object.freeze(limits.installation)
    Object.freeze(limits)
  }
  Object.freeze(policy.capabilities)
  return Object.freeze(policy)
}
