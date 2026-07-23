import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  CONTENT_PROFILE_REQUIRED,
  CONTENT_SAFETY_POLICY_ID,
  CONTENT_SAFETY_POLICY_SCHEMA_VERSION,
  type ContentSafetyProfile,
  type ContentSafetyRequirement,
} from '../../../shared/product/contentSafety.js'

const limitKeys = [
  'max_source_bytes', 'max_uncompressed_bytes', 'max_entries', 'max_nested_depth',
  'max_pages', 'max_frames', 'max_pixels', 'max_characters', 'max_cpu_ms',
  'max_wall_ms', 'max_memory_bytes', 'max_temp_bytes', 'max_output_bytes',
] as const

function canonical(value: unknown): string { return JSON.stringify(value) }
function digest(value: Omit<ContentSafetyProfile, 'sha256'>): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function validRequirement(value: ContentSafetyRequirement): boolean {
  return Boolean(value.consumer_id) && Boolean(value.platform) && Boolean(value.toolchain)
    && Date.parse(value.expires_at) > Date.now()
    && value.magic_byte_allowlist.length > 0
    && limitKeys.every(key => Number.isSafeInteger(value[key]) && value[key] > 0)
}

/** Module 03's sole writer for the runtime content safety profile. */
export class ContentSafetyPolicyRegistry {
  private readonly requirements = new Map<string, ContentSafetyRequirement>()
  constructor(private readonly profilePath: string, private readonly now: () => Date = () => new Date()) {}

  register(requirement: ContentSafetyRequirement): void {
    if (!validRequirement(requirement)) throw new Error(CONTENT_PROFILE_REQUIRED)
    this.requirements.set(requirement.consumer_id, { ...requirement, magic_byte_allowlist: [...requirement.magic_byte_allowlist] })
  }

  async generate(platform = process.platform, toolchain = process.version): Promise<ContentSafetyProfile> {
    const entries = [...this.requirements.values()].filter(entry => entry.platform === platform && entry.toolchain === toolchain && Date.parse(entry.expires_at) > this.now().getTime())
    if (!entries.length) throw new Error(CONTENT_PROFILE_REQUIRED)
    const allowed = entries.reduce<string[]>((current, entry) => current.filter(value => entry.magic_byte_allowlist.includes(value)), [...entries[0]!.magic_byte_allowlist])
    if (!allowed.length) throw new Error(CONTENT_PROFILE_REQUIRED)
    const profile = {
      policy_schema_version: CONTENT_SAFETY_POLICY_SCHEMA_VERSION,
      policy_id: CONTENT_SAFETY_POLICY_ID,
      owner_module: '03' as const,
      policy_revision: `content-${this.now().toISOString()}`,
      platform,
      toolchain,
      expires_at: new Date(Math.min(...entries.map(entry => Date.parse(entry.expires_at)))).toISOString(),
      evidence: ['owner-module-evidence'] as ['owner-module-evidence'],
      magic_byte_allowlist: allowed.sort(),
      ...Object.fromEntries(limitKeys.map(key => [key, Math.min(...entries.map(entry => entry[key]))])),
    } satisfies Omit<ContentSafetyProfile, 'sha256'>
    const complete: ContentSafetyProfile = { ...profile, sha256: digest(profile) }
    await fs.mkdir(path.dirname(this.profilePath), { recursive: true })
    await fs.writeFile(this.profilePath, `${canonical(complete)}\n`, { mode: 0o600 })
    return complete
  }

  async valid(platform = process.platform, toolchain = process.version): Promise<boolean> {
    try {
      const profile = JSON.parse(await fs.readFile(this.profilePath, 'utf8')) as ContentSafetyProfile
      const { sha256, ...unsigned } = profile
      return profile.policy_schema_version === CONTENT_SAFETY_POLICY_SCHEMA_VERSION
        && profile.policy_id === CONTENT_SAFETY_POLICY_ID && profile.owner_module === '03'
        && profile.platform === platform && profile.toolchain === toolchain
        && Date.parse(profile.expires_at) > this.now().getTime()
        && sha256 === digest(unsigned) && validRequirement({ ...profile, consumer_id: 'runtime' })
    } catch { return false }
  }
}
