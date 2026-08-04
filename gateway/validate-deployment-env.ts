import {
  currentDeploymentEnvironment,
  readStaticDeploymentEnvironment,
} from '../ts/shared/kernel/deploymentEnvironment'
import { textReasoningRegistryEntry } from './providerRegistry'
import {
  GATEWAY_CAPACITY_POLICY_REVISION_ENV,
  loadCapacityPolicy,
} from './capacityPolicy'
import { loadGatewayProviderCredentials, type GatewayCredentialProvider } from './providerCredentials'
import { loadGatewayServiceCredentials } from './serviceCredentials'
import {
  gatewayUsagePolicyFromEnvironment,
  MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT_ENV,
  QUOTA_POLICY_REVISION_ENV,
} from './quotaPolicy'

type DeploymentEnvironment = Record<string, string>

function fail(message: string): never {
  throw new Error(`Gateway deployment environment invalid: ${message}`)
}

/**
 * Read the deliberately small EnvironmentFile subset used by this service.
 * It never evaluates shell syntax, expands variables or prints values, so a
 * malformed production environment cannot execute while it is being checked.
 */
export function readDeploymentEnvironment(path: string): DeploymentEnvironment {
  try {
    return readStaticDeploymentEnvironment(path)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'cannot read gateway.env')
  }
}

function requireValue(environment: DeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) fail(`${name} is required`)
  return value
}

/**
 * Production may not accidentally inherit the development profile embedded in
 * capacityPolicy.ts. The runtime still has safe defaults for local tests and
 * isolated development, while this preflight makes the operator-owned policy
 * wholly visible and editable in gateway.env.
 */
export const GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES = [
  GATEWAY_CAPACITY_POLICY_REVISION_ENV,
  'GW_BOOTSTRAP_RPM',
  'GW_BOOTSTRAP_QUEUE_MAX',
  'GW_BOOTSTRAP_QUEUE_MAX_WAIT',
  'GW_DEEPSEEK_RPM',
  'GW_DEEPSEEK_CONC',
  'GW_DEEPSEEK_USER_CONC',
  'GW_DEEPSEEK_TOKEN_CONC',
  'GW_DEEPSEEK_INFLIGHT_PER_USER',
  'GW_DEEPSEEK_QUEUE_MAX',
  'GW_DEEPSEEK_QUEUE_MAX_WAIT',
  'GW_DEEPSEEK_RESPONSE_TIMEOUT_MS',
  'GW_MIMO_RPM',
  'GW_MIMO_CONC',
  'GW_MIMO_MEDIA_CONC',
  'GW_VISION_CONC',
  'GW_MIMO_USER_CONC',
  'GW_MIMO_TOKEN_CONC',
  'GW_MIMO_INFLIGHT_PER_USER',
  'GW_MIMO_QUEUE_MAX',
  'GW_MIMO_QUEUE_MAX_WAIT',
  'GW_VISION_QUEUE_MAX',
  'GW_VISION_QUEUE_MAX_WAIT_MS',
  'GW_VISION_PER_CLIENT_CONC',
  'GW_VISION_MAX_INFLIGHT_PER_CLIENT',
  'GW_VISION_PER_REQUEST_CONC',
  'GW_VISION_TIMEOUT_MS',
  'GW_QWEN_RPM',
  'GW_QWEN_CONC',
  'GW_QWEN_USER_CONC',
  'GW_QWEN_TOKEN_CONC',
  'GW_QWEN_INFLIGHT_PER_USER',
  'GW_QWEN_QUEUE_MAX',
  'GW_QWEN_QUEUE_MAX_WAIT',
  'GW_QWEN_RESPONSE_TIMEOUT_MS',
  'GW_TRANSCRIBE_RPM',
  'GW_TRANSCRIBE_CONC',
  'GW_TRANSCRIBE_USER_CONC',
  'GW_TRANSCRIBE_TOKEN_CONC',
  'GW_TRANSCRIBE_INFLIGHT_PER_USER',
  'GW_TRANSCRIBE_QUEUE_MAX',
  'GW_QUEUE_MAX_WAIT',
  'GW_TRANSCRIBE_MAX_BYTES',
  'GW_TRANSCRIBE_TIMEOUT_MS',
  'GW_INGRESS_INFLIGHT_BODY_BYTES',
  'GW_INGRESS_BODY_READ_TIMEOUT_MS',
  'GW_SERVER_IDLE_TIMEOUT_SECONDS',
] as const

const GATEWAY_QUOTA_CAPABILITIES = [
  'TEXT_REASONING',
  'VISUAL_EVIDENCE',
  'MEDIA_REASONING',
  'IMAGE_ADVICE',
  'SPEECH_TRANSCRIPTION',
] as const
const GATEWAY_QUOTA_SCOPES = ['PRINCIPAL', 'INSTALLATION'] as const
const GATEWAY_QUOTA_AXES = ['REQUESTS', 'INPUT_BYTES', 'OUTPUT_UNITS', 'TOTAL_TOKENS'] as const

/**
 * Capacity and entitlement are independent policies. Production must name
 * every quota cell explicitly, rather than inheriting source-code ceilings.
 * TextReasoning installation TOTAL_TOKENS retains one compatibility alias,
 * but the policy parser rejects setting both spellings at the same time.
 */
export const GATEWAY_PRODUCTION_QUOTA_POLICY_REVISION_ENV = QUOTA_POLICY_REVISION_ENV

function requireProductionQuotaEnvironment(environment: DeploymentEnvironment): void {
  requireValue(environment, GATEWAY_PRODUCTION_QUOTA_POLICY_REVISION_ENV)
  for (const capability of GATEWAY_QUOTA_CAPABILITIES) {
    for (const scope of GATEWAY_QUOTA_SCOPES) {
      for (const axis of GATEWAY_QUOTA_AXES) {
        const name = `GW_QUOTA_${capability}_${scope}_${axis}`
        const usesDailyAlias = capability === 'TEXT_REASONING' && scope === 'INSTALLATION' && axis === 'TOTAL_TOKENS'
        if (!usesDailyAlias) {
          requireValue(environment, name)
          continue
        }
        const named = environment[name]?.trim()
        const alias = environment[MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT_ENV]?.trim()
        if (!named && !alias) {
          fail(`${name} or ${MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT_ENV} is required`)
        }
      }
    }
  }
}

/** Validate startup-critical values without opening the production database. */
export function validateDeploymentEnvironment(environment: DeploymentEnvironment): void {
  const selectedModel = environment.BB_GATEWAY_MODEL?.trim()
  const textModel = selectedModel ? textReasoningRegistryEntry(selectedModel) : textReasoningRegistryEntry()
  if (!textModel || textModel.provider !== 'deepseek' || textModel.text_reasoning_transport !== 'responses') {
    fail('BB_GATEWAY_MODEL must select a registered DeepSeek Responses TextReasoning model')
  }

  const signingKey = requireValue(environment, 'GW_AUTH_SIGNING_KEY')
  if (signingKey.length < 32) fail('GW_AUTH_SIGNING_KEY must be at least 32 characters')

  for (const name of [
    'GW_ADMIN_TOKEN',
    'GW_DB',
  ]) requireValue(environment, name)
  for (const name of GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES) requireValue(environment, name)
  requireProductionQuotaEnvironment(environment)

  let credentials
  try {
    credentials = loadGatewayProviderCredentials(environment)
    loadGatewayServiceCredentials(environment)
    loadCapacityPolicy(environment)
    gatewayUsagePolicyFromEnvironment(environment)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'provider governance configuration is invalid')
  }
  for (const provider of ['deepseek', 'mimo', 'funasr'] as const satisfies readonly GatewayCredentialProvider[]) {
    if (!credentials.view(provider).secret_configured) fail(`${credentials.view(provider).secret_slot} is required`)
  }
  const qwenEnabled = environment.GW_QWEN_ENABLED?.trim() ?? '0'
  if (qwenEnabled !== '0' && qwenEnabled !== '1') fail('GW_QWEN_ENABLED must be 0 or 1')
  if (qwenEnabled === '1' && !credentials.view('qwen').secret_configured) fail('GW_QWEN_KEY is required when Qwen is enabled')
}

if (import.meta.main) {
  if (process.argv.length !== 3) fail('usage: bun validate-deployment-env.ts /path/to/gw.env | --process-env')
  const input = process.argv[2]
  if (input === '--process-env') {
    validateDeploymentEnvironment(currentDeploymentEnvironment())
  } else {
    validateDeploymentEnvironment(readDeploymentEnvironment(input))
  }
  console.log('Gateway deployment environment passed static validation.')
}
