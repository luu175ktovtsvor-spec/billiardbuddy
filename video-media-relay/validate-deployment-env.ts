import { readFileSync } from 'node:fs'

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
export function validateVideoMediaRelayEnvironment(env: Environment): void {
  requireValue(env, 'GW_VIDEO_MEDIA_INTROSPECTION_TOKEN', 32)
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
  optionalBytes(env, 'VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES', 5 * 1024 * 1024, 5 * 1024 * 1024 * 1024)
  optionalBytes(env, 'VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES', 1024 * 1024, 512 * 1024 * 1024)
}
if (import.meta.main) { const input = process.argv[2]; if (!input) fail('usage: bun validate-deployment-env.ts /path/to/video-media-relay.env'); validateVideoMediaRelayEnvironment(read(input)); console.log('Video Media Relay deployment environment passed static validation.') }
