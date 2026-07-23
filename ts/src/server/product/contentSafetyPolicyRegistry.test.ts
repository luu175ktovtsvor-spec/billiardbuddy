import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ContentSafetyPolicyRegistry } from './contentSafetyPolicyRegistry.js'

const requirement = (consumer_id: string, overrides: Record<string, unknown> = {}) => ({
  consumer_id, platform: 'test', toolchain: 'toolchain', expires_at: '2030-01-01T00:00:00.000Z',
  magic_byte_allowlist: ['pdf', 'png'], max_source_bytes: 100, max_uncompressed_bytes: 200,
  max_entries: 10, max_nested_depth: 2, max_pages: 20, max_frames: 30, max_pixels: 40,
  max_characters: 50, max_cpu_ms: 60, max_wall_ms: 70, max_memory_bytes: 80,
  max_temp_bytes: 90, max_output_bytes: 100, ...overrides,
}) as Parameters<ContentSafetyPolicyRegistry['register']>[0]

test('registry writes one signed strictest runtime profile and rejects tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-safety-'))
  const profile = path.join(root, 'content-safety-profile.json')
  const registry = new ContentSafetyPolicyRegistry(profile, () => new Date('2026-01-01T00:00:00.000Z'))
  registry.register(requirement('parser'))
  registry.register(requirement('media', { magic_byte_allowlist: ['pdf'], max_source_bytes: 10, max_pages: 3 }))
  const result = await registry.generate('test', 'toolchain')
  expect(result.magic_byte_allowlist).toEqual(['pdf'])
  expect(result.max_source_bytes).toBe(10)
  expect(result.max_pages).toBe(3)
  expect(await registry.valid('test', 'toolchain')).toBe(true)
  await fs.writeFile(profile, JSON.stringify({ ...result, max_pages: 999 }))
  expect(await registry.valid('test', 'toolchain')).toBe(false)
})

test('registry fails closed for absent, expired, malformed, and incompatible requirements', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-safety-'))
  const registry = new ContentSafetyPolicyRegistry(path.join(root, 'profile.json'), () => new Date('2026-01-01T00:00:00.000Z'))
  expect(await registry.valid('test', 'toolchain')).toBe(false)
  expect(() => registry.register(requirement('expired', { expires_at: '2020-01-01T00:00:00.000Z' }))).toThrow('CONTENT_PROFILE_REQUIRED')
  registry.register(requirement('wrong-platform', { platform: 'other' }))
  await expect(registry.generate('test', 'toolchain')).rejects.toThrow('CONTENT_PROFILE_REQUIRED')
})
