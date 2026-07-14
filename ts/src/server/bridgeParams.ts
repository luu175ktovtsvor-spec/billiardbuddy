// Remote Bridge 入参收敛:桥接远端配置、权限应答、状态枚举与入站内容摘要。

import type { BridgeRemoteOutboxStatus, BridgeRemotePermissionResponse, BridgeRemotePermissionStatus } from '../tasks/bridgeRemoteState'
import { bridgeRemoteConfigFromEnv } from '../tasks/bridgeRemoteTransport'
import type { BridgeWorkerSessionState } from '../tasks/bridgeWorkerClient'
import type { BridgeInboundContent } from '../tasks/bridgeInboundMessages'
import { textBlock, type ContentBlock } from '../types/message'
import { isRecord, numberFrom, stringOr } from './requestParams'

export function bridgePermissionStatusFrom(value: unknown): BridgeRemotePermissionStatus | undefined {
  return value === 'pending' || value === 'allowed' || value === 'denied' || value === 'cancelled'
    ? value
    : undefined
}

export function bridgeOutboxStatusFrom(value: unknown): BridgeRemoteOutboxStatus | undefined {
  return value === 'queued' || value === 'sent' ? value : undefined
}

export function bridgeWorkerSessionStateFrom(value: unknown): BridgeWorkerSessionState | undefined {
  return value === 'idle' || value === 'running' || value === 'requires_action'
    ? value
    : undefined
}

export function bridgePermissionResponseFrom(body: Record<string, unknown>): BridgeRemotePermissionResponse {
  const behavior = body.behavior
  if (behavior === 'allow') {
    return { behavior: 'allow', updatedInput: isRecord(body.updatedInput) ? body.updatedInput : isRecord(body.updated_input) ? body.updated_input : {} }
  }
  if (behavior === 'deny') {
    return { behavior: 'deny', message: stringOr(body.message, 'Permission denied') }
  }
  throw new Error('behavior required')
}

export function bridgeRemoteConfigFromBody(rawBody: Record<string, unknown>, env: Record<string, string | undefined>) {
  const fromEnv = bridgeRemoteConfigFromEnv(env)
  const nested = isRecord(rawBody.bridgeRemote) ? rawBody.bridgeRemote : isRecord(rawBody.bridge_remote) ? rawBody.bridge_remote : {}
  const baseUrl = stringOr(rawBody.bridgeRemoteBaseUrl ?? rawBody.bridge_remote_base_url ?? nested.baseUrl ?? nested.base_url, '') || fromEnv?.baseUrl
  const token = stringOr(rawBody.bridgeRemoteToken ?? rawBody.bridge_remote_token ?? nested.token, '') || fromEnv?.token
  if (!baseUrl || !token) return null
  const timeoutRaw = rawBody.bridgeRemoteTimeoutMs ?? rawBody.bridge_remote_timeout_ms ?? nested.timeoutMs ?? nested.timeout_ms
  const timeoutMs = typeof timeoutRaw === 'number'
    ? timeoutRaw
    : typeof timeoutRaw === 'string'
      ? Number.parseInt(timeoutRaw, 10)
      : fromEnv?.timeoutMs
  return {
    baseUrl,
    token,
    orgUuid: stringOr(rawBody.bridgeRemoteOrgUuid ?? rawBody.bridge_remote_org_uuid ?? nested.orgUuid ?? nested.org_uuid, '') || fromEnv?.orgUuid,
    betaHeader: typeof rawBody.bridgeRemoteBetaHeader === 'string'
      ? rawBody.bridgeRemoteBetaHeader
      : typeof rawBody.bridge_remote_beta_header === 'string'
        ? rawBody.bridge_remote_beta_header
        : typeof nested.betaHeader === 'string'
          ? nested.betaHeader
          : typeof nested.beta_header === 'string'
            ? nested.beta_header
            : fromEnv?.betaHeader,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  }
}

export function bridgeCodeSessionConfigFromBody(rawBody: Record<string, unknown>, env: Record<string, string | undefined>) {
  const remote = bridgeRemoteConfigFromBody(rawBody, env)
  if (!remote) return null
  return {
    baseUrl: remote.baseUrl,
    token: remote.token,
    timeoutMs: remote.timeoutMs,
  }
}

export function bridgeRefreshConfigFromBody(rawBody: Record<string, unknown>) {
  const nested = isRecord(rawBody.bridgeRefresh) ? rawBody.bridgeRefresh : isRecord(rawBody.bridge_refresh) ? rawBody.bridge_refresh : {}
  const enabledRaw = rawBody.bridgeRefreshEnabled ?? rawBody.bridge_refresh_enabled ?? nested.enabled
  if (enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0') return { enabled: false }
  return {
    enabled: true,
    refreshBufferMs: numberFrom(rawBody.bridgeRefreshBufferMs ?? rawBody.bridge_refresh_buffer_ms ?? nested.refreshBufferMs ?? nested.refresh_buffer_ms, 5 * 60 * 1000),
    minDelayMs: numberFrom(rawBody.bridgeRefreshMinDelayMs ?? rawBody.bridge_refresh_min_delay_ms ?? nested.minDelayMs ?? nested.min_delay_ms, 30_000),
    retryDelayMs: numberFrom(rawBody.bridgeRefreshRetryDelayMs ?? rawBody.bridge_refresh_retry_delay_ms ?? nested.retryDelayMs ?? nested.retry_delay_ms, 60_000),
    maxConsecutiveFailures: numberFrom(rawBody.bridgeRefreshMaxFailures ?? rawBody.bridge_refresh_max_failures ?? nested.maxConsecutiveFailures ?? nested.max_consecutive_failures, 3),
  }
}

export function inboundContentBlocks(content: BridgeInboundContent): ContentBlock[] {
  return typeof content === 'string' ? [textBlock(content)] : content
}

export function inboundContentPreview(content: BridgeInboundContent): string {
  if (typeof content === 'string') return content
  return content.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return `[image ${block.source.media_type}]`
    if (block.type === 'tool_result') {
      // 多模态兼容:tool_result.content 现在可能是 string 或 blocks 数组(#46)。
      // string 直接返回;数组时逐块摘要(text 取正文、image 给中性占位),别把数组/对象原样塞进预览。
      if (typeof block.content === 'string') return block.content
      return block.content
        .map(inner => (inner.type === 'text' ? inner.text : `[image ${inner.source.media_type}]`))
        .filter(Boolean)
        .join('\n')
    }
    return `[${block.type}]`
  }).filter(Boolean).join('\n').trim()
}
