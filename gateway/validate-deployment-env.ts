import {
  currentDeploymentEnvironment,
  readStaticDeploymentEnvironment,
} from '../ts/shared/kernel/deploymentEnvironment'
import { textReasoningRegistryEntry } from './providerRegistry'
import { loadCapacityPolicy } from './capacityPolicy'
import { loadGatewayProviderCredentials, type GatewayCredentialProvider } from './providerCredentials'
import { loadGatewayServiceCredentials } from './serviceCredentials'
import { gatewayUsagePolicyFromEnvironment } from './quotaPolicy'

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
