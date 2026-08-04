import {
  currentDeploymentEnvironment,
  readStaticDeploymentEnvironment,
  type StaticDeploymentEnvironment,
} from '../ts/shared/kernel/deploymentEnvironment'
import { relayCapacityPolicyFromEnvironment } from './capacityPolicy'
import { loadImageRelayIdentityIntrospector } from './identityIntrospection'
import { loadRelayProviderCredentials } from './providerCredentials'
import { loadImageRelayResultCredentials } from './resultCredentials'

function fail(message: string): never {
  throw new Error(`Image Relay deployment environment invalid: ${message}`)
}

function requireValue(environment: StaticDeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) fail(`${name} is required`)
  return value
}

function requireAbsoluteDataPath(environment: StaticDeploymentEnvironment, name: string, expectedLeaf: RegExp): void {
  const value = requireValue(environment, name)
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value === '/' || value.includes('//')) {
    fail(`${name} must be a safe non-root absolute path`)
  }
  for (const segment of value.slice(1).split('/')) {
    if (!segment || segment === '.' || segment === '..') fail(`${name} contains a relative or empty path segment`)
  }
  if (!expectedLeaf.test(value)) fail(`${name} must identify the dedicated image relay data location`)
}

export function validateRelayDeploymentEnvironment(environment: StaticDeploymentEnvironment): void {
  requireAbsoluteDataPath(environment, 'RELAY_DB', /(?:image-)?relay\.db$/i)
  requireAbsoluteDataPath(environment, 'RELAY_BLOB_DIR', /blobs?\/?$/i)

  try {
    relayCapacityPolicyFromEnvironment(environment)
    loadImageRelayIdentityIntrospector(environment)
    loadImageRelayResultCredentials(environment)
    const credentials = loadRelayProviderCredentials(environment)
    if (!credentials.view('openai').secret_configured) fail('RELAY_OPENAI_KEY is required')
    if (!credentials.view('seedream').secret_configured) fail('RELAY_ARK_KEY is required')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Image Relay deployment environment invalid:')) throw error
    fail(error instanceof Error ? error.message : 'provider governance configuration is invalid')
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3) fail('usage: bun validate-deployment-env.ts /path/to/image-relay.env | --process-env')
  const input = process.argv[2]!
  if (input === '--process-env') {
    validateRelayDeploymentEnvironment(currentDeploymentEnvironment())
  } else {
    let environment: StaticDeploymentEnvironment
    try {
      environment = readStaticDeploymentEnvironment(input)
    } catch {
      fail('cannot read image-relay.env')
    }
    validateRelayDeploymentEnvironment(environment)
  }
  console.log('Image Relay deployment environment passed static validation.')
}
