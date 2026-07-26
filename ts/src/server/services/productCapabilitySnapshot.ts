import type {
  ProductCapability,
  ProductCapabilityId,
  ProductCapabilitySnapshot,
} from '../../../shared/product/capabilitySnapshot.js'
import type { BrowserCapabilityStatus } from '../../../shared/product/browserCapability.js'
import type { ProductScheduledTaskRun } from '../../../shared/product/scheduledTasks.js'
import { getChromeSessionBridge } from './chromeSessionBridge.js'
import { loadNetworkSettings, getNetworkProxyFetchOptions } from './networkSettings.js'
import { productGatewayConfigured, productGatewayTarget } from '../product/productGatewayRuntime.js'
import { MediaProjectService } from './mediaProjectService.js'
import { productScheduledTaskService } from '../product/scheduledTaskService.js'

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
  gatewayStatus: () => Promise<GatewayProductStatus>
  mediaToolchainStatus: () => Promise<{ ffmpeg: { available: boolean }; ffprobe: { available: boolean } }>
  browserStatus: () => BrowserCapabilityStatus
  scheduledRuns: () => Promise<ProductScheduledTaskRun[]>
  now: () => Date
}

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
  reason: 'installation_activation_required' | 'service_unreachable',
): ProductCapability[] {
  const repair_action = reason === 'installation_activation_required' ? 'restart_app' : 'retry'
  return (['assistant', 'image_understanding', 'image_creation', 'voice_input'] as const)
    .map(id => ({ id, state, reason_code: reason, repair_action }))
}

export class ProductCapabilitySnapshotService {
  private readonly deps: CapabilitySnapshotDependencies

  constructor(overrides: Partial<CapabilitySnapshotDependencies> = {}) {
    const media = overrides.mediaToolchainStatus ? null : new MediaProjectService()
    this.deps = {
      gatewayConfigured: productGatewayConfigured,
      gatewayStatus: fetchGatewayStatus,
      mediaToolchainStatus: overrides.mediaToolchainStatus ?? (() => media!.toolchainStatus()),
      browserStatus: () => getChromeSessionBridge().status(),
      scheduledRuns: () => productScheduledTaskService.listRecentRuns(100),
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
    if (!this.deps.gatewayConfigured()) {
      return unavailableRemoteCapabilities('configured', 'installation_activation_required')
    }
    try {
      const gateway = await this.deps.gatewayStatus()
      return [
        remoteCapability('assistant', gateway, 'assistant', 'TextReasoning'),
        remoteCapability('image_understanding', gateway, 'image_understanding', 'VisualEvidence'),
        remoteCapability('image_creation', gateway, 'image_creation', null),
        remoteCapability('voice_input', gateway, 'voice_input', 'SpeechTranscription'),
      ]
    } catch {
      return unavailableRemoteCapabilities('degraded', 'service_unreachable')
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
    try {
      const status = this.deps.browserStatus()
      if (status.state === 'connected') return { id: 'recruiting_browser', state: 'running' }
      if (status.state === 'degraded') {
        return { id: 'recruiting_browser', state: 'degraded', reason_code: 'browser_bridge_failed', repair_action: 'install_recruiting_browser' }
      }
      return { id: 'recruiting_browser', state: 'configured', reason_code: 'browser_extension_disconnected', repair_action: 'install_recruiting_browser' }
    } catch {
      return { id: 'recruiting_browser', state: 'degraded', reason_code: 'browser_bridge_failed', repair_action: 'install_recruiting_browser' }
    }
  }
}
