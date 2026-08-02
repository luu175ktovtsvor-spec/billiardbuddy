import { readFileSync } from 'node:fs'
import { textReasoningRegistryEntry } from './providerRegistry'

type DeploymentEnvironment = Record<string, string>

function fail(message: string): never {
  throw new Error(`Gateway deployment environment invalid: ${message}`)
}

function valueWithoutQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Read the deliberately small EnvironmentFile subset used by this service.
 * It never evaluates shell syntax, expands variables or prints values, so a
 * malformed production environment cannot execute while it is being checked.
 */
export function readDeploymentEnvironment(path: string): DeploymentEnvironment {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    fail('cannot read gw.env')
  }
  const environment: DeploymentEnvironment = {}
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) fail(`line ${index + 1} is not KEY=VALUE`)
    environment[match[1]] = valueWithoutQuotes(match[2])
  }
  return environment
}

function requireValue(environment: DeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) fail(`${name} is required`)
  return value
}

function requireHttpsUrl(environment: DeploymentEnvironment, name: string): void {
  const value = requireValue(environment, name)
  try {
    if (new URL(value).protocol !== 'https:') fail(`${name} must use https`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Gateway deployment environment invalid:')) throw error
    fail(`${name} must be a valid URL`)
  }
}

/** Relay is HTTPS in every cross-host deployment, but Compose uses this fixed private hop. */
function requireRelayTasksUrl(environment: DeploymentEnvironment): void {
  const value = requireValue(environment, 'GW_RELAY_TASKS_BASE')
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) fail('GW_RELAY_TASKS_BASE must not contain credentials or query data')
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && url.hostname === 'relay' && (url.port === '' || url.port === '8790')) return
    fail('GW_RELAY_TASKS_BASE must use https outside the private Compose relay service')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Gateway deployment environment invalid:')) throw error
    fail('GW_RELAY_TASKS_BASE must be a valid URL')
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
    'GW_RELAY_TOKEN',
    'GW_DEEPSEEK_KEY',
    'GW_MIMO_KEY',
    'GW_FUNASR_KEY',
  ]) requireValue(environment, name)

  requireRelayTasksUrl(environment)
  for (const name of ['GW_DEEPSEEK_BASE', 'GW_MIMO_BASE']) {
    if (environment[name]?.trim()) requireHttpsUrl(environment, name)
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3) fail('usage: bun validate-deployment-env.ts /path/to/gw.env | --process-env')
  const input = process.argv[2]
  if (input === '--process-env') {
    const environment: DeploymentEnvironment = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string') environment[name] = value
    }
    validateDeploymentEnvironment(environment)
  } else {
    validateDeploymentEnvironment(readDeploymentEnvironment(input))
  }
  console.log('Gateway deployment environment passed static validation.')
}
