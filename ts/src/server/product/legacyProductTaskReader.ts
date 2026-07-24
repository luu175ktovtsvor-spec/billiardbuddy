import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { isProductPermissionSnapshot, type ProductTask } from '../../../shared/product/domain.js'
import { ApiError } from '../middleware/errorHandler.js'
import type { ProductProject, ProductProjectDirectory, ProductSideTask } from '../../../shared/product/domain.js'
import type { ProductTaskMetadata, ProductSideTaskMetadata, ProductProjectMetadata, ProductProjectDirectoryMetadata, ProductTaskStore } from './taskService.js'

const PRODUCT_TASK_STORE_VERSION = 4 as const
export type StrictLegacyTask = ProductTask & { coreSessionId: string }
export const legacyProductTaskId = (id: string) => `task_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('UNSUPPORTED_SCHEMA'); return value as Record<string, unknown> }
/** Read-only strict v1/v3/v4 projection. v2 deliberately stays provisional. */
export function readStrictLegacyProductTasks(value: unknown): StrictLegacyTask[] { const root = record(value); if (root.version === 2) throw new Error('UNSUPPORTED_SCHEMA'); if (root.version !== 1 && root.version !== 3 && root.version !== 4) throw new Error('UNSUPPORTED_SCHEMA'); const tasks = record(root.tasks); return Object.entries(tasks).map(([key, raw]) => { const item = record(raw); const core = root.version === 1 ? key : item.coreSessionId; if (typeof core !== 'string' || !core) throw new Error('UNSUPPORTED_SCHEMA'); const id = root.version === 1 ? legacyProductTaskId(core) : key; return { id, coreSessionId: core, projectId: typeof item.projectId === 'string' ? item.projectId : '', directoryId: typeof item.directoryId === 'string' ? item.directoryId : '', workDir: '', title: typeof item.title === 'string' ? item.title : '', lifecycle: item.lifecycle === 'archived' ? 'archived' : 'active', kind: item.kind === 'continuation' ? 'continuation' : 'main', createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(), updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(), worktreeState: 'not_requested' } }) }


export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Core transcript activity is the authoritative recency signal for a task.
 * Product metadata can also move independently for lifecycle actions, so keep
 * whichever valid timestamp is newer instead of letting the first stored
 * value permanently mask later Core work.
 */
export function latestProductTimestamp(...values: Array<string | undefined>): string {
  let latest = ''
  let latestTime = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) continue
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
      if (!latest) latest = value
      continue
    }
    if (timestamp > latestTime) {
      latest = value
      latestTime = timestamp
    }
  }

  return latest
}

function storedLifecycle(value: unknown): ProductTask['lifecycle'] {
  return value === 'archived' ? 'archived' : 'active'
}

function storedKind(value: unknown): ProductTask['kind'] {
  return value === 'continuation' ? 'continuation' : 'main'
}

function storedWorktreeState(value: unknown): ProductTask['worktreeState'] {
  return value === 'planned' || value === 'materialized' ? value : 'not_requested'
}

export function normalizeMetadata(
  value: unknown,
  fallback: { id: string; coreSessionId: string },
): ProductTaskMetadata {
  const record = isRecord(value) ? value : {}
  return {
    id: fallback.id,
    coreSessionId: fallback.coreSessionId,
    ...(optionalString(record.projectId) ? { projectId: optionalString(record.projectId) } : {}),
    ...(optionalString(record.directoryId) ? { directoryId: optionalString(record.directoryId) } : {}),
    ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}),
    lifecycle: storedLifecycle(record.lifecycle),
    kind: storedKind(record.kind),
    ...(optionalString(record.pinnedAt) ? { pinnedAt: optionalString(record.pinnedAt) } : {}),
    ...(optionalString(record.archivedAt) ? { archivedAt: optionalString(record.archivedAt) } : {}),
    ...(optionalString(record.parentTaskId) ? { parentTaskId: optionalString(record.parentTaskId) } : {}),
    ...(optionalString(record.sourceTurnId) ? { sourceTurnId: optionalString(record.sourceTurnId) } : {}),
    createdAt: optionalString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: optionalString(record.updatedAt) ?? new Date(0).toISOString(),
    worktreeState: storedWorktreeState(record.worktreeState),
    ...(record.visibility === 'side_task' ? { visibility: 'side_task' as const } : { visibility: 'main' as const }),
    ...(isProductPermissionSnapshot(record.permission_snapshot)
      ? { permission_snapshot: { ...record.permission_snapshot } }
      : {}),
  }
}

function normalizeSideTasks(value: unknown): Record<string, ProductSideTaskMetadata> {
  const sideTasks: Record<string, ProductSideTaskMetadata> = {}
  if (!isRecord(value)) return sideTasks

  for (const [sideTaskId, rawSideTask] of Object.entries(value)) {
    if (!isRecord(rawSideTask) || typeof rawSideTask.coreSessionId !== 'string' || !rawSideTask.coreSessionId) {
      continue
    }
    const taskId = typeof rawSideTask.taskId === 'string' && rawSideTask.taskId
      ? rawSideTask.taskId
      : legacyProductTaskId(rawSideTask.coreSessionId)
    const parentTaskId = optionalString(rawSideTask.parentTaskId)
    const sourceTurnId = optionalString(rawSideTask.sourceTurnId)
    const title = optionalString(rawSideTask.title)
    const createdAt = optionalString(rawSideTask.createdAt)
    const updatedAt = optionalString(rawSideTask.updatedAt)
    if (!parentTaskId || !sourceTurnId || !title || !createdAt || !updatedAt) continue
    sideTasks[sideTaskId] = {
      id: sideTaskId,
      parentTaskId,
      taskId,
      sourceTurnId,
      coreSessionId: rawSideTask.coreSessionId,
      title,
      status: rawSideTask.status === 'closed' ? 'closed' : 'open',
      createdAt,
      updatedAt,
      ...(optionalString(rawSideTask.closedAt) ? { closedAt: optionalString(rawSideTask.closedAt) } : {}),
    }
  }
  return sideTasks
}

export function normalizeLegacyV1SideTasks(value: unknown): Record<string, ProductSideTaskMetadata> {
  const sideTasks: Record<string, ProductSideTaskMetadata> = {}
  if (!isRecord(value)) return sideTasks

  for (const [sideTaskId, rawSideTask] of Object.entries(value)) {
    if (!isRecord(rawSideTask) || typeof rawSideTask.coreSessionId !== 'string' || !rawSideTask.coreSessionId) {
      continue
    }
    const parentCoreSessionId = optionalString(rawSideTask.parentTaskId)
    const sourceTurnId = optionalString(rawSideTask.sourceTurnId)
    const title = optionalString(rawSideTask.title)
    const createdAt = optionalString(rawSideTask.createdAt)
    const updatedAt = optionalString(rawSideTask.updatedAt)
    if (!parentCoreSessionId || !sourceTurnId || !title || !createdAt || !updatedAt) continue
    sideTasks[sideTaskId] = {
      id: sideTaskId,
      parentTaskId: legacyProductTaskId(parentCoreSessionId),
      taskId: legacyProductTaskId(rawSideTask.coreSessionId),
      sourceTurnId,
      coreSessionId: rawSideTask.coreSessionId,
      title,
      status: rawSideTask.status === 'closed' ? 'closed' : 'open',
      createdAt,
      updatedAt,
      ...(optionalString(rawSideTask.closedAt) ? { closedAt: optionalString(rawSideTask.closedAt) } : {}),
    }
  }
  return sideTasks
}

function normalizeProjects(value: unknown): Record<string, ProductProjectMetadata> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  const projects: Record<string, ProductProjectMetadata> = {}
  for (const [projectId, rawProject] of Object.entries(value)) {
    if (!isRecord(rawProject)) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const rootDir = optionalString(rawProject.rootDir)?.trim()
    if (!projectId || !rootDir) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    projects[projectId] = {
      id: projectId,
      title: optionalString(rawProject.title)?.trim() || projectTitle(rootDir),
      rootDir,
      createdAt: optionalString(rawProject.createdAt) ?? new Date(0).toISOString(),
      updatedAt: optionalString(rawProject.updatedAt) ?? new Date(0).toISOString(),
    }
  }
  return projects
}

function normalizeDirectories(value: unknown): Record<string, ProductProjectDirectoryMetadata> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  const directories: Record<string, ProductProjectDirectoryMetadata> = {}
  for (const [directoryId, rawDirectory] of Object.entries(value)) {
    if (!isRecord(rawDirectory)) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const projectId = optionalString(rawDirectory.projectId)?.trim()
    const directoryPath = optionalString(rawDirectory.path)?.trim()
    if (!directoryId || !projectId || !directoryPath) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    directories[directoryId] = {
      id: directoryId,
      projectId,
      path: directoryPath,
      label: optionalString(rawDirectory.label)?.trim() || path.basename(directoryPath) || directoryPath,
      createdAt: optionalString(rawDirectory.createdAt) ?? new Date(0).toISOString(),
      updatedAt: optionalString(rawDirectory.updatedAt) ?? new Date(0).toISOString(),
    }
  }
  return directories
}

export function normalizeModernTaskStore(value: Record<string, unknown>): ProductTaskStore {
  const tasks: Record<string, ProductTaskMetadata> = {}
  const taskIdByCoreSessionId = new Map<string, string>()
  const rawTasks = value.tasks
  if (!isRecord(rawTasks)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  for (const [taskId, rawMetadata] of Object.entries(rawTasks)) {
    if (!isRecord(rawMetadata) || typeof rawMetadata.coreSessionId !== 'string' || !rawMetadata.coreSessionId) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const existingTaskId = taskIdByCoreSessionId.get(rawMetadata.coreSessionId)
    if (existingTaskId && existingTaskId !== taskId) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    taskIdByCoreSessionId.set(rawMetadata.coreSessionId, taskId)
    tasks[taskId] = normalizeMetadata(rawMetadata, {
      id: taskId,
      coreSessionId: rawMetadata.coreSessionId,
    })
  }

  return {
    version: PRODUCT_TASK_STORE_VERSION,
    projects: normalizeProjects(value.projects),
    directories: normalizeDirectories(value.directories),
    tasks,
    sideTasks: normalizeSideTasks(value.sideTasks),
    ...(optionalString(value.legacyCoreSessionsImportedAt)
      ? { legacyCoreSessionsImportedAt: optionalString(value.legacyCoreSessionsImportedAt) }
      : {}),
  }
}


function projectTitle(rootDir: string): string { const base = path.basename(rootDir.replace(/[\\/]+$/, '')); return base || rootDir || '未命名项目' }
