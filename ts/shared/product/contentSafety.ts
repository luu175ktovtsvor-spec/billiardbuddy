export const CONTENT_SAFETY_POLICY_SCHEMA_VERSION = 1 as const
export const CONTENT_SAFETY_POLICY_ID = 'content-safety-policy' as const
export const CONTENT_PROFILE_REQUIRED = 'CONTENT_PROFILE_REQUIRED' as const

export type ContentSafetyLimits = {
  magic_byte_allowlist: string[]
  max_source_bytes: number
  max_uncompressed_bytes: number
  max_entries: number
  max_nested_depth: number
  max_pages: number
  max_frames: number
  max_pixels: number
  max_characters: number
  max_cpu_ms: number
  max_wall_ms: number
  max_memory_bytes: number
  max_temp_bytes: number
  max_output_bytes: number
}

export type ContentSafetyRequirement = ContentSafetyLimits & {
  consumer_id: string
  platform: string
  toolchain: string
  expires_at: string
}

export type ContentSafetyProfile = ContentSafetyLimits & {
  policy_schema_version: typeof CONTENT_SAFETY_POLICY_SCHEMA_VERSION
  policy_id: typeof CONTENT_SAFETY_POLICY_ID
  owner_module: '03'
  policy_revision: string
  platform: string
  toolchain: string
  expires_at: string
  evidence: ['owner-module-evidence']
  sha256: string
}
