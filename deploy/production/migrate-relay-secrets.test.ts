import { afterEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { migrateRelaySecrets, parseEnvironmentFile } from './migrate-relay-secrets'
import { validateDeploymentEnvironment } from '../../gateway/validate-deployment-env'
import { validateRelayDeploymentEnvironment } from '../../relay/validate-deployment-env'
import { validateVideoMediaRelayEnvironment } from '../../video-media-relay/validate-deployment-env'

const temporaryDirectories: string[] = []

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'bb-relay-secret-migration-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})
function write(path: string, contents: string): void { writeFileSync(path, contents, { mode: 0o600 }) }

function fixture(root: string): Parameters<typeof migrateRelaySecrets>[0] {
  const source = join(root, 'source'); const output = join(root, 'output')
  mkdirSync(source, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 })
  const gateway = [
    'GW_AUTH_SIGNING_KEY=gateway-signing-key-12345678901234567890',
    'GW_ADMIN_TOKEN=admin token with spaces',
    'GW_DEEPSEEK_KEY=deepseek=key with spaces',
    'GW_MIMO_KEY="mimo; $(touch should-not-run)"',
    "GW_FUNASR_KEY='fun=asr key'",
    'BB_GATEWAY_MODEL=deepseek-chat',
    'GW_RELAY_TOKEN=legacy-gateway-relay-token',
    'GW_VIDEO_MEDIA_INTROSPECTION_TOKEN=legacy-video-token',
    'GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT=999',
    'GW_DEEPSEEK_RPM=17',
  ].join('\n')
  const image = [
    'RELAY_OPENAI_KEY="openai=key with spaces"',
    "RELAY_ARK_KEY='ark key=with quotes'",
    'RELAY_TOKEN=legacy-relay-token',
    'RELAY_GATEWAY_URL=https://legacy.example.test',
    'RELAY_TASK_TTL_MS=999999',
    'RELAY_IMG_CONC=1',
    'RELAY_OPENAI_RPM=11',
    'RELAY_RESULT_GLOBAL_CONC=2',
  ].join('\n')
  const video = [
    'VIDEO_MEDIA_DASHSCOPE_API_KEY=dashscope-key-1234567890123456',
    'VIDEO_MEDIA_OSS_BUCKET=bb-video-media',
    'VIDEO_MEDIA_OSS_ACCESS_KEY_ID=oss-access-key-id-123456',
    'VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET=oss-access-key-secret-123456',
    'GW_VIDEO_MEDIA_INTROSPECTION_TOKEN=legacy-video-token',
    'VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX=24',
  ].join('\n')
  write(join(source, 'gateway.env'), gateway)
  write(join(source, 'relay.env'), image)
  write(join(source, 'video-media-relay.env'), video)
  return {
    gatewayInput: join(source, 'gateway.env'), imageInput: join(source, 'relay.env'), videoInput: join(source, 'video-media-relay.env'),
    gatewayOutput: join(output, 'gateway.env'), imageOutput: join(output, 'image-relay.env'), videoOutput: join(output, 'video-media-relay.env'),
    backupDirectory: join(root, 'backup'), enforceRoot: false,
  }
}

function environment(path: string): Record<string, string> { return parseEnvironmentFile(readFileSync(path, 'utf8'), path) }

test('literal parser preserves spaces, equals signs and quotes without shell execution', () => {
  const root = directory(); const paths = fixture(root)
  expect(migrateRelaySecrets(paths)).toEqual({ status: 'migrated' })
  expect(readFileSync(paths.gatewayOutput, 'utf8')).toContain('GW_MIMO_KEY="mimo; $(touch should-not-run)"')
  expect(readFileSync(paths.imageOutput, 'utf8')).toContain('RELAY_OPENAI_KEY="openai=key with spaces"')
  expect(readFileSync(paths.imageOutput, 'utf8')).toContain("RELAY_ARK_KEY='ark key=with quotes'")
  expect(() => lstatSync(join(root, 'should-not-run'))).toThrow()
})

test('writes separated generated tokens, complete production defaults and no legacy coupling keys', () => {
  const root = directory(); const paths = fixture(root)
  migrateRelaySecrets(paths)
  const gateway = environment(paths.gatewayOutput); const image = environment(paths.imageOutput); const video = environment(paths.videoOutput)
  expect(gateway.GW_IMAGE_RELAY_INTROSPECTION_TOKEN).toBe(image.IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN)
  expect(gateway.GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN).toBe(video.VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN)
  expect(gateway.GW_IMAGE_RELAY_INTROSPECTION_TOKEN).not.toBe(gateway.GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN)
  expect(Buffer.from(gateway.GW_IMAGE_RELAY_INTROSPECTION_TOKEN!, 'base64url')).toHaveLength(32)
  expect(image.IMAGE_RELAY_RESULT_SIGNING_KEY).toBeDefined()
  expect(gateway.GW_RELAY_TOKEN).toBeUndefined()
  expect(gateway.GW_VIDEO_MEDIA_INTROSPECTION_TOKEN).toBeUndefined()
  expect(gateway.GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT).toBeUndefined()
  expect(image.RELAY_TOKEN).toBeUndefined(); expect(image.RELAY_GATEWAY_URL).toBeUndefined(); expect(image.RELAY_TASK_TTL_MS).toBeUndefined()
  for (const name of ['GW_CAPACITY_POLICY_REVISION', 'GW_QUOTA_TEXT_REASONING_PRINCIPAL_REQUESTS', 'GW_INGRESS_BODY_READ_TIMEOUT_MS']) expect(gateway[name]).toBeDefined()
  for (const name of ['RELAY_CAPACITY_POLICY_REVISION', 'RELAY_RESULT_MAX_BYTES', 'RELAY_QUOTA_POLICY_REVISION', 'IMAGE_RELAY_RESULT_GRANT_TTL_MS']) expect(image[name]).toBeDefined()
  expect(image.RELAY_IMG_CONC).toBe('1'); expect(image.RELAY_SEEDREAM_CONC).toBe('1')
  expect(image.RELAY_OPENAI_RPM).toBe('11')
  expect(image.RELAY_RESULT_GLOBAL_CONC).toBe('2'); expect(image.RELAY_RESULT_OWNER_CONC).toBe('1')
  expect(gateway.GW_DEEPSEEK_RPM).toBe('17'); expect(video.VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX).toBe('24')
  expect(gateway.BB_GATEWAY_MODEL).toBe('deepseek-v4-flash')
  expect(video.VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS).toBe('50000')
  expect(video.VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS).toBe('1000000')
  expect(video.VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS).toBe('32')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE).toBe('2')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE).toBe('1')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX).toBe('16')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX).toBe('2')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_MAX_WAIT_MS).toBe('30000')
  expect(video.VIDEO_MEDIA_OBJECT_VERIFY_TIMEOUT_MS).toBe('120000')
  expect(video.VIDEO_MEDIA_IDENTITY_MAX_ACTIVE).toBe('8')
  expect(video.VIDEO_MEDIA_IDENTITY_QUEUE_MAX).toBe('32')
  expect(image.RELAY_IDENTITY_MAX_ACTIVE).toBe('8')
  expect(image.RELAY_IDENTITY_QUEUE_MAX).toBe('32')
  expect(image.RELAY_IDENTITY_MAX_WAIT_MS).toBe('5000')
  expect(video.VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS).toBe('5000')
  expect(gateway.GW_QUOTA_TEXT_REASONING_PRINCIPAL_REQUESTS).toBe('1000000000')
  expect(gateway.GW_QUOTA_TEXT_REASONING_INSTALLATION_TOTAL_TOKENS).toBe('50000000')
  expect(gateway.GW_QUOTA_VISUAL_EVIDENCE_PRINCIPAL_INPUT_BYTES).toBe(String(500 * 1024 ** 3))
  expect(gateway.GW_QUOTA_SPEECH_TRANSCRIPTION_INSTALLATION_OUTPUT_UNITS).toBe('20000000')
  for (const name of ['VIDEO_MEDIA_CAPACITY_POLICY_REVISION', 'VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM', 'VIDEO_MEDIA_LEASE_TTL_MS', 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TIMEOUT_MS']) expect(video[name]).toBeDefined()
  expect(() => validateDeploymentEnvironment(gateway)).not.toThrow()
  expect(() => validateRelayDeploymentEnvironment(image)).not.toThrow()
  expect(() => validateVideoMediaRelayEnvironment(video)).not.toThrow()
})

test('targets and backups are owner-only, and a repeat run fails closed', () => {
  const root = directory(); const paths = fixture(root)
  migrateRelaySecrets(paths)
  for (const path of [paths.gatewayOutput, paths.imageOutput, paths.videoOutput, join(paths.backupDirectory, 'gateway.env')]) {
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  }
  expect(lstatSync(paths.backupDirectory).mode & 0o777).toBe(0o700)
  expect(() => migrateRelaySecrets(paths)).toThrow('refusing to replace existing output')
})

test('validate-only writes neither outputs nor a backup', () => {
  const root = directory(); const paths = fixture(root)
  expect(migrateRelaySecrets({ ...paths, validateOnly: true })).toEqual({ status: 'validated' })
  expect(() => lstatSync(paths.gatewayOutput)).toThrow()
  expect(() => lstatSync(paths.backupDirectory)).toThrow()
})

test('rejects group-readable input secrets before it creates a backup or target', () => {
  const root = directory(); const paths = fixture(root)
  chmodSync(paths.imageInput, 0o640)
  expect(() => migrateRelaySecrets(paths)).toThrow('must not be readable or writable by group or others')
  expect(() => lstatSync(paths.gatewayOutput)).toThrow()
  expect(() => lstatSync(paths.backupDirectory)).toThrow()
})

test('preserves explicit policy values but rejects an invalid one before writing outputs or backups', () => {
  const root = directory(); const paths = fixture(root)
  write(paths.gatewayInput, `${readFileSync(paths.gatewayInput, 'utf8')}\nGW_DEEPSEEK_CONC=999999\n`)
  expect(() => migrateRelaySecrets(paths)).toThrow('GW_DEEPSEEK_CONC')
  expect(() => lstatSync(paths.gatewayOutput)).toThrow()
  expect(() => lstatSync(paths.backupDirectory)).toThrow()
})

test('a write failure rolls back output files while retaining a recoverable backup', () => {
  const root = directory(); const paths = fixture(root)
  const blocked = join(root, 'blocked-output')
  mkdirSync(blocked, { mode: 0o700 })
  chmodSync(blocked, 0o500)
  const blockedPaths = { ...paths, videoOutput: join(blocked, 'video-media-relay.env') }
  expect(() => migrateRelaySecrets(blockedPaths)).toThrow()
  expect(() => lstatSync(paths.gatewayOutput)).toThrow()
  expect(() => lstatSync(paths.imageOutput)).toThrow()
  expect(readFileSync(join(paths.backupDirectory, 'gateway.env'), 'utf8')).toContain('GW_AUTH_SIGNING_KEY=')
})
