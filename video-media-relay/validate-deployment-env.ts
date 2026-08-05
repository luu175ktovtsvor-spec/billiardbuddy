import { readFileSync } from 'node:fs'
import { videoMediaCapacityPolicyFromEnvironment, videoMediaIdentityAdmissionPolicyFromEnvironment, videoMediaObjectVerificationPolicyFromEnvironment } from './capacityPolicy.ts'

type Environment = Record<string, string>
function fail(message: string): never { throw new Error(`Video Media Relay deployment environment invalid: ${message}`) }
function read(path: string): Environment {
  const result: Environment = {}
  for (const [index, raw] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); if (!match) fail(`line ${index + 1} is not KEY=VALUE`)
    result[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return result
}
function requireValue(env: Environment, name: string, min = 1): string { const value = env[name]?.trim() ?? ''; if (value.length < min) fail(`${name} is required${min > 1 ? ` and must be at least ${min} characters` : ''}`); return value }
function optionalBytes(env: Environment, name: string, min: number, max: number): void { const raw = env[name]?.trim(); if (!raw) return; const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}`) }
function requiredInteger(env: Environment, name: string, min: number, max: number): void {
  const raw = requireValue(env, name)
  const integer = min === 0 ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/
  const value = Number(raw)
  if (!integer.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}`)
}
export function validateVideoMediaRelayEnvironment(env: Environment): void {
  requireValue(env, 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN', 32)
  const base = requireValue(env, 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE')
  const url = new URL(base)
  if (!((url.protocol === 'http:' && url.hostname === 'gateway' && (!url.port || url.port === '8799')) || url.protocol === 'https:')) fail('VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE must be the private gateway service or HTTPS')
  requireValue(env, 'VIDEO_MEDIA_RELAY_DB')
  requireValue(env, 'VIDEO_MEDIA_DASHSCOPE_API_KEY', 16)
  const asrBase = env.VIDEO_MEDIA_DASHSCOPE_ASR_BASE_URL?.trim()
  if (asrBase) {
    const url = new URL(asrBase)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')) fail('VIDEO_MEDIA_DASHSCOPE_ASR_BASE_URL must be a Beijing workspace HTTPS endpoint')
  }
  const endpoint = requireValue(env, 'VIDEO_MEDIA_OSS_ENDPOINT')
  if (endpoint !== 'oss-cn-beijing.aliyuncs.com') fail('VIDEO_MEDIA_OSS_ENDPOINT must be the Beijing public OSS endpoint')
  requireValue(env, 'VIDEO_MEDIA_OSS_BUCKET', 3)
  requireValue(env, 'VIDEO_MEDIA_OSS_ACCESS_KEY_ID', 16)
  requireValue(env, 'VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET', 16)
  if ((env.VIDEO_MEDIA_REGION ?? 'cn-beijing') !== 'cn-beijing') fail('VIDEO_MEDIA_REGION must be cn-beijing')
  // Keep spend and object retention deliberate production choices. Defaults
  // remain available for isolated unit tests only; deployment cannot inherit
  // an accidental unlimited or stale holding period.
  requireValue(env, 'VIDEO_MEDIA_QUOTA_POLICY_REVISION')
  // Zero is a deliberate entitlement stop, not an omitted value. The Relay
  // rejects before new OSS leases or Provider admission with a stable error.
  requiredInteger(env, 'VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS', 0, 1_000_000_000)
  requiredInteger(env, 'VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS', 0, 1_000_000_000)
  if (Number(env.VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS) > Number(env.VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS)) fail('VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS must not exceed VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS')
  // A visual operation needs several independently leased frames. Production
  // may be stricter, but a value below eight makes normal multi-frame analysis
  // impossible before provider admission is even considered.
  requiredInteger(env, 'VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS', 8, 1_000_000)
  requiredInteger(env, 'VIDEO_MEDIA_LEASE_TTL_MS', 60_000, 60 * 60_000)
  requiredInteger(env, 'VIDEO_MEDIA_LEASE_MAX_RETENTION_MS', 60_000, 30 * 24 * 60 * 60_000)
  if (Number(env.VIDEO_MEDIA_LEASE_MAX_RETENTION_MS) < Number(env.VIDEO_MEDIA_LEASE_TTL_MS)) {
    fail('VIDEO_MEDIA_LEASE_MAX_RETENTION_MS must be at least VIDEO_MEDIA_LEASE_TTL_MS')
  }
  requiredInteger(env, 'VIDEO_MEDIA_OUTCOME_UNKNOWN_RETENTION_MS', 60 * 60_000, 7 * 24 * 60 * 60_000)
  requiredInteger(env, 'VIDEO_MEDIA_CONTROL_BODY_TIMEOUT_MS', 1_000, 120_000)
  requiredInteger(env, 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TIMEOUT_MS', 1_000, 60_000)
  requiredInteger(env, 'VIDEO_MEDIA_DASHSCOPE_TIMEOUT_MS', 1_000, 10 * 60_000)
  requiredInteger(env, 'VIDEO_MEDIA_DASHSCOPE_RESPONSE_MAX_BYTES', 1_024, 4 * 1024 * 1024)
  requiredInteger(env, 'VIDEO_MEDIA_DASHSCOPE_TRANSCRIPT_MAX_BYTES', 1_024, 32 * 1024 * 1024)
  optionalBytes(env, 'VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES', 5 * 1024 * 1024, 5 * 1024 * 1024 * 1024)
  optionalBytes(env, 'VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES', 1024 * 1024, 512 * 1024 * 1024)
  // Admission limits are intentionally not hidden source constants in
  // production. A single physical DashScope account has one outer envelope
  // and four workload lanes; deployment must make every limit explicit.
  for (const name of [
    'VIDEO_MEDIA_CAPACITY_POLICY_REVISION',
    // The logical catalog pool resolves to this explicit, non-secret physical
    // account binding. Both fields take part in the durable account key.
    'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF',
    'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION',
    'VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX',
    'VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX',
    'VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS',
    'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_RPM',
    'VIDEO_MEDIA_DASHSCOPE_VISUAL_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_VISUAL_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_VISUAL_RPM',
    'VIDEO_MEDIA_DASHSCOPE_REASONING_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_REASONING_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_REASONING_RPM',
    'VIDEO_MEDIA_DASHSCOPE_ASR_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_ASR_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_ASR_RPM',
    'VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_EMBEDDING_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM',
  ]) requireValue(env, name)
  videoMediaCapacityPolicyFromEnvironment(env)
  for (const name of [
    'VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE',
    'VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE',
    'VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX',
    'VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX',
    'VIDEO_MEDIA_OBJECT_VERIFY_MAX_WAIT_MS',
    'VIDEO_MEDIA_OBJECT_VERIFY_TIMEOUT_MS',
  ]) requireValue(env, name)
  videoMediaObjectVerificationPolicyFromEnvironment(env)
  for (const name of [
    'VIDEO_MEDIA_IDENTITY_MAX_ACTIVE',
    'VIDEO_MEDIA_IDENTITY_QUEUE_MAX',
    'VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS',
  ]) requireValue(env, name)
  videoMediaIdentityAdmissionPolicyFromEnvironment(env)
}
if (import.meta.main) {
  const input = process.argv[2]
  if (!input) fail('usage: bun validate-deployment-env.ts /path/to/video-media-relay.env | --process-env')
  const environment = input === '--process-env'
    ? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : read(input)
  validateVideoMediaRelayEnvironment(environment)
  console.log('Video Media Relay deployment environment passed static validation.')
}
