import type {
  ProductCapability,
  ProductCapabilityId,
  ProductCapabilitySnapshot,
} from '../../../shared/product/capabilitySnapshot.js'
import type { ProductScheduledTaskRun } from '../../../shared/product/scheduledTasks.js'
import { loadNetworkSettings, getNetworkProxyFetchOptions } from './networkSettings.js'
import { productGatewayConfigured, productGatewayTarget } from '../product/productGatewayRuntime.js'
import { runtimePersonalModelProfile } from './personalModelRuntimeState.js'

type MeteredCapability = 'TextReasoning' | 'VisualEvidence' | 'MediaReasoning' | 'SpeechTranscription'

type GatewayProductStatus = {
  features: {
    assistant: boolean
    image_understanding: boolean
    image_creation: boolean
    voice_input: boolean
  }
  usage: Record<MeteredCapability, { remaining_percent: number; exhausted: boolean }>
  resets_at: string
}

type CapabilitySnapshotDependencies = {
  gatewayConfigured: () => boolean
  /** A deliberate BYOK Agent route bypasses Gateway quota accounting. */
  personalTextRouteConfigured: () => boolean
  gatewayStatus: () => Promise<GatewayProductStatus>
  mediaToolchainStatus: () => Promise<{ ffmpeg: { available: boolean }; ffprobe: { available: boolean } }>
  scheduledRuns: () => Promise<ProductScheduledTaskRun[]>
  now: () => Date
}

type CapabilitySnapshotOverrides = Pick<CapabilitySnapshotDependencies, 'mediaToolchainStatus' | 'scheduledRuns'>
  & Partial<Omit<CapabilitySnapshotDependencies, 'mediaToolchainStatus' | 'scheduledRuns'>>

const GATEWAY_STATUS_BODY_LIMIT = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedPercent(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100
    ? value as number
    : null
}

function parseGatewayProductStatus(value: unknown): GatewayProductStatus {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.features) || !isRecord(value.usage_summary)) {
    throw new Error('CAPABILITY_STATUS_INVALID')
  }
  const features = value.features
  const summary = value.usage_summary
  const capabilities = summary.capabilities
  if (!isRecord(capabilities) || typeof summary.resets_at !== 'string' || Number.isNaN(Date.parse(summary.resets_at))) {
    throw new Error('CAPABILITY_STATUS_INVALID')
  }
  const usage = {} as GatewayProductStatus['usage']
  for (const capability of ['TextReasoning', 'VisualEvidence', 'MediaReasoning', 'SpeechTranscription'] as const) {
    const entry = capabilities[capability]
    if (!isRecord(entry)) throw new Error('CAPABILITY_STATUS_INVALID')
    const remaining = boundedPercent(entry.remaining_percent)
    if (remaining === null || typeof entry.exhausted !== 'boolean') throw new Error('CAPABILITY_STATUS_INVALID')
    usage[capability] = { remaining_percent: remaining, exhausted: entry.exhausted }
  }
  return {
    features: {
      assistant: features.chat_deepseek === true,
      image_understanding: features.vision_bridge === true,
      image_creation: features.image_tasks === true,
      voice_input: features.transcription === true,
    },
    usage,
    resets_at: summary.resets_at,
  }
}

async function readBoundedBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > GATEWAY_STATUS_BODY_LIMIT) throw new Error('CAPABILITY_STATUS_INVALID')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('CAPABILITY_STATUS_INVALID')
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > GATEWAY_STATUS_BODY_LIMIT) {
      await reader.cancel()
      throw new Error('CAPABILITY_STATUS_INVALID')
    }
    chunks.push(value)
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
}

async function fetchGatewayStatus(): Promise<GatewayProductStatus> {
  const target = productGatewayTarget()
  if (!target) throw new Error('CAPABILITY_STATUS_UNREACHABLE')
  const url = `${target.baseUrl}/healthz`
  const network = await loadNetworkSettings()
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${target.token}` },
    signal: AbortSignal.timeout(Math.min(network.aiRequestTimeoutMs, 5_000)),
    ...getNetworkProxyFetchOptions(network, url),
  })
  if (!response.ok) throw new Error('CAPABILITY_STATUS_UNREACHABLE')
  return parseGatewayProductStatus(await readBoundedBody(response))
}

function remoteCapability(
  id: ProductCapabilityId,
  gateway: GatewayProductStatus,
  feature: keyof GatewayProductStatus['features'],
  metered: MeteredCapability | null,
): ProductCapability {
  if (!gateway.features[feature]) {
    return { id, state: 'degraded', reason_code: 'service_unavailable', repair_action: 'check_update' }
  }
  if (!metered) return { id, state: 'available' }
  const usage = gateway.usage[metered]
  const quota = { remaining_percent: usage.remaining_percent, resets_at: gateway.resets_at }
  return usage.exhausted
    ? { id, state: 'degraded', reason_code: 'daily_quota_used', repair_action: 'wait_for_reset', quota }
    : { id, state: 'available', quota }
}

function unavailableRemoteCapabilities(
  state: 'configured' | 'degraded',
  reason: 'installation_session_unavailable' | 'service_unreachable',
): ProductCapability[] {
  const repair_action = 'retry'
  return (['assistant', 'image_understanding', 'image_creation', 'voice_input'] as const)
    .map(id => ({ id, state, reason_code: reason, repair_action }))
}

export class ProductCapabilitySnapshotService {
  private readonly deps: CapabilitySnapshotDependencies

  constructor(overrides: CapabilitySnapshotOverrides) {
    this.deps = {
      gatewayConfigured: productGatewayConfigured,
      personalTextRouteConfigured: () => {
        try { return runtimePersonalModelProfile('TextReasoning') !== null } catch { return false }
      },
      gatewayStatus: fetchGatewayStatus,
      now: () => new Date(),
      ...overrides,
    }
  }

  async snapshot(): Promise<ProductCapabilitySnapshot> {
    const [remote, media, browser, scheduledRuns] = await Promise.all([
      this.remoteCapabilities(),
      this.mediaCapability(),
      this.browserCapability(),
      this.deps.scheduledRuns().catch(() => null),
    ])
    const scheduled: ProductCapability = scheduledRuns === null
      ? { id: 'scheduled_tasks', state: 'degraded', reason_code: 'service_unavailable', repair_action: 'retry' }
      : scheduledRuns.some(run => run.status === 'running')
        ? { id: 'scheduled_tasks', state: 'running' }
        : { id: 'scheduled_tasks', state: 'available' }
    return {
      schema_version: 1,
      observed_at: this.deps.now().toISOString(),
      capabilities: [...remote, media, scheduled, browser],
    }
  }

  private async remoteCapabilities(): Promise<ProductCapability[]> {
    const personalTextRoute = this.deps.personalTextRouteConfigured()
    const withTextRoute = (capabilities: ProductCapability[]): ProductCapability[] => personalTextRoute
      ? capabilities.map(capability => capability.id === 'assistant'
        // A personal key is intentionally direct-to-provider. Do not display
        // BilliardBuddy Gateway quota as if it governed this Agent route.
        ? { id: 'assistant', state: 'available' }
        : capability)
      : capabilities
    if (!this.deps.gatewayConfigured()) {
      return withTextRoute(unavailableRemoteCapabilities('configured', 'installation_session_unavailable'))
    }
    try {
      const gateway = await this.deps.gatewayStatus()
      return withTextRoute([
        remoteCapability('assistant', gateway, 'assistant', 'TextReasoning'),
        remoteCapability('image_understanding', gateway, 'image_understanding', 'VisualEvidence'),
        remoteCapability('image_creation', gateway, 'image_creation', null),
        remoteCapability('voice_input', gateway, 'voice_input', 'SpeechTranscription'),
      ])
    } catch {
      return withTextRoute(unavailableRemoteCapabilities('degraded', 'service_unreachable'))
    }
  }

  private async mediaCapability(): Promise<ProductCapability> {
    try {
      const status = await this.deps.mediaToolchainStatus()
      return status.ffmpeg.available && status.ffprobe.available
        ? { id: 'video_editing', state: 'available' }
        : { id: 'video_editing', state: 'degraded', reason_code: 'media_tools_missing', repair_action: 'check_update' }
    } catch {
      return { id: 'video_editing', state: 'degraded', reason_code: 'media_tools_missing', repair_action: 'check_update' }
    }
  }

  private browserCapability(): ProductCapability {
    return { id: 'recruiting_browser', state: 'degraded', reason_code: 'service_unavailable', repair_action: 'check_update' }
  }
}
