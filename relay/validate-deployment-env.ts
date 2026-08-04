import {
  currentDeploymentEnvironment,
  readStaticDeploymentEnvironment,
  type StaticDeploymentEnvironment,
} from '../ts/shared/kernel/deploymentEnvironment'
import { relayCapacityPolicyFromEnvironment } from './capacityPolicy'
import { loadImageRelayIdentityIntrospector } from './identityIntrospection'
import { loadRelayProviderCredentials } from './providerCredentials'
import { IMAGE_RELAY_QUOTA_POLICY_ENVIRONMENT_VARIABLES, imageRelayQuotaPolicyFromEnvironment } from './quotaPolicy'
import { loadImageRelayResultCredentials } from './resultCredentials'

/** Production has no implicit image-provider admission profile. */
export const IMAGE_RELAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES = [
  'RELAY_CAPACITY_POLICY_REVISION',
  'RELAY_IMG_CONC',
  'RELAY_IMG_USER_CONC',
  'RELAY_OPENAI_RPM',
  'RELAY_SEEDREAM_CONC',
  'RELAY_SEEDREAM_USER_CONC',
  'RELAY_SEEDREAM_RPM',
  'RELAY_QUEUE_MAX',
  'RELAY_USER_MAX',
  'RELAY_RETRY_AFTER_SECONDS',
  'RELAY_REQUEST_BODY_TIMEOUT_MS',
  'RELAY_UPSTREAM_TIMEOUT_MS',
  'RELAY_MAX_BODY_BYTES',
  'RELAY_PENDING_INPUT_BYTES_MAX',
  'RELAY_ACTIVE_INPUT_BYTES_MAX',
  'RELAY_IDENTITY_TIMEOUT_MS',
  'RELAY_IDENTITY_MAX_ACTIVE',
  'RELAY_IDENTITY_QUEUE_MAX',
  'RELAY_IDENTITY_MAX_WAIT_MS',
  'RELAY_RESULT_GLOBAL_CONC',
  'RELAY_RESULT_OWNER_CONC',
  'RELAY_RESULT_MAX_BYTES',
  'RELAY_QUOTA_LEDGER_RETENTION_DAYS',
] as const

/** Paid spend is enabled only with an explicit daily policy, never a source default. */
export const IMAGE_RELAY_PRODUCTION_QUOTA_ENVIRONMENT_VARIABLES = IMAGE_RELAY_QUOTA_POLICY_ENVIRONMENT_VARIABLES

function fail(message: string): never {
  throw new Error(`Image Relay deployment environment invalid: ${message}`)
}

function requireValue(environment: StaticDeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) fail(`${name} is required`)
  return value
}

function requireBoundedInteger(environment: StaticDeploymentEnvironment, name: string, min: number, max: number): void {
  const value = requireValue(environment, name)
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${name} must be an integer between ${min} and ${max}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${name} must be an integer between ${min} and ${max}`)
}

function requireAtMost(environment: StaticDeploymentEnvironment, name: string, max: number): void {
  const value = Number(requireValue(environment, name))
  if (!Number.isSafeInteger(value) || value > max) fail(`${name} must not exceed ${max} for the bounded production memory envelope`)
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
  for (const name of IMAGE_RELAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES) requireValue(environment, name)
  for (const name of IMAGE_RELAY_PRODUCTION_QUOTA_ENVIRONMENT_VARIABLES) requireValue(environment, name)
  // This wait owns both the fair provider-admission deadline and the rate-limit
  // queue deadline in relay/app.ts, so it is part of the explicit policy too.
  requireBoundedInteger(environment, 'RELAY_RETRY_AFTER_SECONDS', 1, 3_600)
  requireBoundedInteger(environment, 'RELAY_REQUEST_BODY_TIMEOUT_MS', 1_000, 120_000)
  requireBoundedInteger(environment, 'RELAY_IDENTITY_TIMEOUT_MS', 1, 60_000)
  requireBoundedInteger(environment, 'RELAY_RESULT_GLOBAL_CONC', 1, 64)
  requireBoundedInteger(environment, 'RELAY_RESULT_OWNER_CONC', 1, 16)
  requireBoundedInteger(environment, 'RELAY_RESULT_MAX_BYTES', 1, 32 * 1024 * 1024)
  requireBoundedInteger(environment, 'RELAY_QUOTA_LEDGER_RETENTION_DAYS', 7, 3650)
  // A three-output Provider envelope can legitimately approach ~129 MiB before
  // parse/base64 expansion. Until the worker gets an incremental JSON parser,
  // production accepts only one paid generation and at most two direct result
  // deliveries at a time on a 2 GiB Relay container.
  requireAtMost(environment, 'RELAY_IMG_CONC', 1)
  requireAtMost(environment, 'RELAY_SEEDREAM_CONC', 1)
  requireAtMost(environment, 'RELAY_RESULT_GLOBAL_CONC', 2)
  requireAtMost(environment, 'RELAY_RESULT_OWNER_CONC', 1)

  try {
    relayCapacityPolicyFromEnvironment(environment)
    imageRelayQuotaPolicyFromEnvironment(environment)
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
