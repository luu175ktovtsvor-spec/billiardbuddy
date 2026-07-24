import { readFileSync } from 'node:fs'

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{16,256}$/
const LICENSE_PATTERN = /^[A-Za-z0-9._-]{8,256}$/
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

type LicenseProvisioning = {
  licenseKey: string
  principalId: string
  deviceLimit: number
  active: boolean
  revision: number
}

export function validateGatewayAuthEnvironment(raw: string): { bootstrapCredentialCount: number; licenseCount: number } {
  const env = parseEnvironmentFile(raw)
  if (env.has('GW_APP_TOKENS')) throw new Error('GW_APP_TOKENS is retired; use GW_APP_CREDENTIALS')
  const credentials = (env.get('GW_APP_CREDENTIALS') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (credentials.length === 0 || credentials.some(value => !CREDENTIAL_PATTERN.test(value)) || new Set(credentials).size !== credentials.length) {
    throw new Error('GW_APP_CREDENTIALS must contain unique URL-safe bootstrap credentials')
  }
  const signingKey = env.get('GW_AUTH_SIGNING_KEY')?.trim() ?? ''
  if (signingKey.length < 32) throw new Error('GW_AUTH_SIGNING_KEY must contain at least 32 characters')
  if (env.get('GW_AUTHORITY_FILE') !== '/opt/qfgw/authority.json') {
    throw new Error('GW_AUTHORITY_FILE must be /opt/qfgw/authority.json')
  }

  let licenses: unknown
  try {
    licenses = JSON.parse(env.get('GW_LICENSE_PROVISIONING') ?? '')
  } catch {
    throw new Error('GW_LICENSE_PROVISIONING must be valid JSON')
  }
  if (!Array.isArray(licenses) || licenses.length === 0) {
    throw new Error('GW_LICENSE_PROVISIONING must contain at least one license')
  }

  const ids = new Set<string>()
  for (const value of licenses) {
    if (!isLicenseProvisioning(value) || ids.has(value.licenseKey)) {
      throw new Error('GW_LICENSE_PROVISIONING contains an invalid or duplicate license')
    }
    ids.add(value.licenseKey)
  }
  return { bootstrapCredentialCount: credentials.length, licenseCount: licenses.length }
}

function parseEnvironmentFile(raw: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!KEY_PATTERN.test(key)) continue
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result.set(key, value)
  }
  return result
}

function isLicenseProvisioning(value: unknown): value is LicenseProvisioning {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<LicenseProvisioning>
  return Object.keys(value).length === 5
    && typeof item.licenseKey === 'string' && LICENSE_PATTERN.test(item.licenseKey)
    && typeof item.principalId === 'string' && PRINCIPAL_PATTERN.test(item.principalId)
    && Number.isSafeInteger(item.deviceLimit) && item.deviceLimit! > 0
    && typeof item.active === 'boolean'
    && Number.isSafeInteger(item.revision) && item.revision! > 0
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) throw new Error('Usage: bun validate-auth-env.ts /path/to/gw.env')
  const result = validateGatewayAuthEnvironment(readFileSync(file, 'utf8'))
  console.log(`Gateway authorization configuration accepted: bootstrap_credentials=${result.bootstrapCredentialCount} licenses=${result.licenseCount}`)
}
