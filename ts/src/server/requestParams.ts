// 请求入参宽松收敛原语:HTTP/WS 请求体在 Zod 契约之外的兜底解析,
// 供 index 路由与各 server 子模块共用。

import { canonicalPermissionMode } from '../permissions/canonical'
import type { PermissionMode } from '../permissions/types'
import type { TaskStatus } from '../tasks/taskService'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : []
}

export function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function permissionModeFrom(value: unknown): PermissionMode {
  return canonicalPermissionMode(value)
}

export function taskStatusFrom(value: unknown): TaskStatus | undefined {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
