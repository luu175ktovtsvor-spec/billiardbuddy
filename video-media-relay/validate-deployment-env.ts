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
export function validateVideoMediaRelayEnvironment(env: Environment): void {
  requireValue(env, 'GW_VIDEO_MEDIA_INTROSPECTION_TOKEN', 32)
  const base = requireValue(env, 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE')
  const url = new URL(base)
  if (!((url.protocol === 'http:' && url.hostname === 'gateway' && (!url.port || url.port === '8799')) || url.protocol === 'https:')) fail('VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE must be the private gateway service or HTTPS')
  requireValue(env, 'VIDEO_MEDIA_RELAY_DB')
  requireValue(env, 'VIDEO_MEDIA_DASHSCOPE_API_KEY', 16)
  if ((env.VIDEO_MEDIA_REGION ?? 'cn-beijing') !== 'cn-beijing') fail('VIDEO_MEDIA_REGION must be cn-beijing')
}
if (import.meta.main) { const input = process.argv[2]; if (!input) fail('usage: bun validate-deployment-env.ts /path/to/video-media-relay.env'); validateVideoMediaRelayEnvironment(read(input)); console.log('Video Media Relay deployment environment passed static validation.') }
