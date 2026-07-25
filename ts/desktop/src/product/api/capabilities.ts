import {
  PRODUCT_CAPABILITY_IDS,
  PRODUCT_CAPABILITY_REASON_CODES,
  PRODUCT_CAPABILITY_REPAIR_ACTIONS,
  PRODUCT_CAPABILITY_STATES,
  type ProductCapability,
  type ProductCapabilitySnapshot,
} from '../../../../shared/product/capabilitySnapshot'
import { productApi } from './client'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function parseCapability(value: unknown): ProductCapability | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'state', 'reason_code', 'repair_action', 'quota'])) return null
  if (!(PRODUCT_CAPABILITY_IDS as readonly unknown[]).includes(value.id)
    || !(PRODUCT_CAPABILITY_STATES as readonly unknown[]).includes(value.state)) return null
  if (value.reason_code !== undefined && !(PRODUCT_CAPABILITY_REASON_CODES as readonly unknown[]).includes(value.reason_code)) return null
  if (value.repair_action !== undefined && !(PRODUCT_CAPABILITY_REPAIR_ACTIONS as readonly unknown[]).includes(value.repair_action)) return null
  if ((value.reason_code === undefined) !== (value.repair_action === undefined)) return null
  let quota: ProductCapability['quota']
  if (value.quota !== undefined) {
    if (!isRecord(value.quota) || !hasOnlyKeys(value.quota, ['remaining_percent', 'resets_at'])
      || !Number.isSafeInteger(value.quota.remaining_percent)
      || (value.quota.remaining_percent as number) < 0
      || (value.quota.remaining_percent as number) > 100
      || typeof value.quota.resets_at !== 'string'
      || Number.isNaN(Date.parse(value.quota.resets_at))) return null
    quota = { remaining_percent: value.quota.remaining_percent as number, resets_at: value.quota.resets_at }
  }
  return {
    id: value.id as ProductCapability['id'],
    state: value.state as ProductCapability['state'],
    ...(value.reason_code ? { reason_code: value.reason_code as ProductCapability['reason_code'] } : {}),
    ...(value.repair_action ? { repair_action: value.repair_action as ProductCapability['repair_action'] } : {}),
    ...(quota ? { quota } : {}),
  }
}

export function parseProductCapabilitySnapshot(value: unknown): ProductCapabilitySnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schema_version', 'observed_at', 'capabilities'])
    || value.schema_version !== 1
    || typeof value.observed_at !== 'string'
    || Number.isNaN(Date.parse(value.observed_at))
    || !Array.isArray(value.capabilities)) return null
  const capabilities = value.capabilities.map(parseCapability)
  if (capabilities.some(item => item === null)) return null
  const ids = capabilities.map(item => item!.id)
  if (ids.length !== PRODUCT_CAPABILITY_IDS.length
    || new Set(ids).size !== PRODUCT_CAPABILITY_IDS.length
    || PRODUCT_CAPABILITY_IDS.some(id => !ids.includes(id))) return null
  return { schema_version: 1, observed_at: value.observed_at, capabilities: capabilities as ProductCapability[] }
}

export async function getProductCapabilitySnapshot(): Promise<ProductCapabilitySnapshot> {
  const value = await productApi.get<unknown>('/api/product/capabilities', { timeout: 8_000 })
  const parsed = parseProductCapabilitySnapshot(value)
  if (!parsed) throw new Error('PRODUCT_CAPABILITY_SNAPSHOT_INVALID')
  return parsed
}
