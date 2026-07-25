export const PRODUCT_CAPABILITY_STATES = [
  'configured',
  'available',
  'running',
  'degraded',
] as const

export type ProductCapabilityState = (typeof PRODUCT_CAPABILITY_STATES)[number]

export const PRODUCT_CAPABILITY_IDS = [
  'assistant',
  'image_understanding',
  'image_creation',
  'voice_input',
  'video_editing',
  'scheduled_tasks',
  'recruiting_browser',
] as const

export type ProductCapabilityId = (typeof PRODUCT_CAPABILITY_IDS)[number]

export const PRODUCT_CAPABILITY_REASON_CODES = [
  'installation_activation_required',
  'privacy_confirmation_required',
  'service_unreachable',
  'service_unavailable',
  'daily_quota_used',
  'media_tools_missing',
  'browser_extension_disconnected',
  'browser_bridge_failed',
] as const

export type ProductCapabilityReasonCode = (typeof PRODUCT_CAPABILITY_REASON_CODES)[number]

export const PRODUCT_CAPABILITY_REPAIR_ACTIONS = [
  'retry',
  'open_privacy',
  'check_update',
  'install_recruiting_browser',
  'restart_app',
  'wait_for_reset',
] as const

export type ProductCapabilityRepairAction = (typeof PRODUCT_CAPABILITY_REPAIR_ACTIONS)[number]

export type ProductCapabilityQuota = {
  remaining_percent: number
  resets_at: string
}

export type ProductCapability = {
  id: ProductCapabilityId
  state: ProductCapabilityState
  reason_code?: ProductCapabilityReasonCode
  repair_action?: ProductCapabilityRepairAction
  quota?: ProductCapabilityQuota
}

export type ProductCapabilitySnapshot = {
  schema_version: 1
  observed_at: string
  capabilities: ProductCapability[]
}
