import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  ProductRecentProject,
  ProductRecentProjectList,
  UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import { errorResponse, ApiError } from '../middleware/errorHandler.js'
import {
  productTaskReviewService,
  type ProductTaskReviewService,
} from '../product/taskReviewService.js'
import { assertOperationEnvelope } from '../../../shared/product/authority.js'
import { CoreOperationBridge, SessionCoreOperationBackend } from '../product/coreOperationBridge.js'
import { productTaskService, type ProductTaskService } from '../product/taskService.js'
import {
  ProductTaskMediaService,
  type ProductTaskMediaApi,
} from '../product/taskMediaService.js'
import { handleProductScheduledTasksApi } from './productScheduledTasks.js'
import {
  productScheduledTaskService,
  type ProductScheduledTaskService,
} from '../product/scheduledTaskService.js'
import { handleProductSettingsApi } from './productSettings.js'
import { handleProductTaskCommandsApi } from './productTaskCommands.js'
import { handleProductVoiceApi } from './productVoice.js'

type ProductTaskReviewApi = Pick<
  ProductTaskReviewService,
  'getStatus' | 'getTree' | 'getFile' | 'getDiff'
>

function authorityPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'billiardbuddy', 'product-task-authority.v1.json')
}

const authorityBridge = new CoreOperationBridge(new SessionCoreOperationBackend())

function authoritativeEnvelope(value: unknown): { expected_revision: number; client_operation_id: string } {
  try {
    assertOperationEnvelope(value)
    return value
  } catch {
    throw ApiError.badRequest('expected_revision 和 client_operation_id 必填且格式正确')
  }
}

export async function handleProductApi(
  req: Request,
  url: URL,
  segments: string[],
  tasks: Pick<
    ProductTaskService,
    | 'listTasks'
    | 'listRecentProjects'
    | 'createTask'
    | 'updateTask'
    | 'setPinned'
    | 'setArchived'
    | 'continueTask'
    | 'getTask'
    | 'getTaskThread'
    | 'listSideTasks'
    | 'createSideTask'
    | 'closeSideTask'
    | 'createTaskAuthoritatively'
    | 'continueTaskAuthoritatively'
    | 'createSideTaskAuthoritatively'
    | 'closeSideTaskAuthoritatively'
    | 'renameTaskAuthoritatively'
    | 'reconcileRenameAuthoritatively'
    | 'mutateTaskAuthoritatively'
    | 'getAuthorityOperation'
  > = productTaskService,
  review: ProductTaskReviewApi = productTaskReviewService,
  media: ProductTaskMediaApi = new ProductTaskMediaService(tasks),
  scheduledTasks: ProductScheduledTaskService = productScheduledTaskService,
): Promise<Response> {
  try {
    if (segments[2] === 'voice') {
      return await handleProductVoiceApi(req, segments)
    }

    if (segments[2] === 'task-commands') {
      return await handleProductTaskCommandsApi(req, url, segments)
    }

    if (segments[2] === 'settings') {
      return await handleProductSettingsApi(req, url, segments)
    }

    if (segments[2] === 'scheduled-tasks') {
      return await handleProductScheduledTasksApi(req, url, segments, scheduledTasks)
    }

    if (segments[2] === 'projects') {
      if (segments[3] !== 'recent' || segments[4]) {
        throw ApiError.notFound('未知产品项目资源')
      }
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(
        publicRecentProjectList(await tasks.listRecentProjects(recentProjectLimit(url))),
      )
    }

    if (segments[2] !== 'tasks') {
      throw ApiError.notFound('未知产品资源')
    }

    const taskId = segments[3]
    const action = segments[4]

    if (!taskId) {
      if (req.method === 'GET') return Response.json(publicTaskIndex(await tasks.listTasksAuthoritatively()))
      if (req.method === 'POST') {
        const input = await readJson<CreateProductTaskInput>(req)
        const envelope = authoritativeEnvelope(input)
        const result = await tasks.createTaskAuthoritatively({ ...input, ...envelope }, { authorityPath: authorityPath(), bridge: authorityBridge })
        const operation = await tasks.getAuthorityOperation(result.task.id, envelope.client_operation_id, { authorityPath: authorityPath() })
        return Response.json({ receipt: result.receipt, authority: publicAuthority(operation.authority), task: publicTask(result.task) }, { status: 201 })
      }
      return methodNotAllowed(req.method)
    }

    if (action === 'operations') {
      const operationId = segments[5]
      if (req.method !== 'GET' || !operationId || segments[6]) return methodNotAllowed(req.method)
      return Response.json(await tasks.getAuthorityOperation(taskId, operationId, { authorityPath: authorityPath() }))
    }

    if (action === 'thread') {
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(await tasks.getTaskThread(taskId))
    }

    if (action === 'review') {
      return await handleTaskReviewRoute(review, req, url, taskId, segments[5])
    }

    if (action === 'media') {
      const resource = segments[5]
      if (!resource) {
        if (req.method !== 'GET') return methodNotAllowed(req.method)
        return Response.json(await media.listForTask(taskId))
      }
      if (resource === 'attachable-projects' && !segments[6]) {
        if (req.method !== 'GET') return methodNotAllowed(req.method)
        return Response.json(await media.listAttachableForTask(taskId))
      }
      if (
        resource === 'projects'
        && segments[6]
      ) {
        const projectId = segments[6]
        if (segments[7] === 'assets' && segments[8] && !segments[9]) {
          if (req.method !== 'GET') return methodNotAllowed(req.method)
          return await media.assetResponse(taskId, projectId, segments[8], req)
        }
        if (segments[7] === 'attach' && !segments[8]) {
          if (req.method !== 'POST') return methodNotAllowed(req.method)
          return Response.json({ project: await media.attachProject(taskId, projectId) })
        }
      }
      throw ApiError.notFound('未知任务媒体资源')
    }

    if (action === 'side-tasks') {
      const sideTaskId = segments[5]
      const sideTaskAction = segments[6]

      if (!sideTaskId) {
        if (req.method === 'GET') {
          return Response.json({ sideTasks: (await tasks.listSideTasksAuthoritatively(taskId)).map(publicTask) })
        }
        if (req.method === 'POST') {
          const input = await readJson<CreateProductSideTaskInput & { sideTaskId?: string }>(req)
          const envelope = authoritativeEnvelope(input)
          if (!input.sideTaskId) throw ApiError.badRequest('sideTaskId 必填')
          const result = await tasks.createSideTaskAuthoritatively({ taskId, sideTaskId: input.sideTaskId, ...envelope, canonical_input: JSON.stringify(input) }, { authorityPath: authorityPath(), bridge: authorityBridge })
          const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
          return Response.json({ receipt: operation.receipt, authority: publicAuthority(operation.authority), sideTask: operation.authority.side_tasks?.find((sideTask) => sideTask.id === input.sideTaskId) }, { status: 201 })
        }
        return methodNotAllowed(req.method)
      }

      if (sideTaskAction === 'close') {
        if (req.method !== 'POST') return methodNotAllowed(req.method)
        const input = await readJson<Record<string, unknown>>(req)
        const envelope = authoritativeEnvelope(input)
        const result = await tasks.closeSideTaskAuthoritatively({ taskId, sideTaskId, ...envelope, canonical_input: JSON.stringify(input) }, { authorityPath: authorityPath() })
        const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
        return Response.json({ receipt: operation.receipt, authority: publicAuthority(operation.authority), sideTask: operation.authority.side_tasks?.find((sideTask) => sideTask.id === sideTaskId) })
      }

      throw ApiError.notFound(
        sideTaskAction
          ? `未知侧边任务操作：${sideTaskAction}`
          : `未知侧边任务资源：${sideTaskId}`,
      )
    }

    if (!action) {
      if (req.method !== 'PATCH') return methodNotAllowed(req.method)
      const input = await readJson<UpdateProductTaskInput>(req)
      const envelope = authoritativeEnvelope(input)
      if (input.title !== undefined) {
        const result = await tasks.renameTaskAuthoritatively({ taskId, title: input.title, ...envelope }, { authorityPath: authorityPath(), bridge: authorityBridge })
        let mirror = result.mirror
        try {
          mirror = await tasks.reconcileRenameAuthoritatively(envelope.client_operation_id, { authorityPath: authorityPath(), bridge: authorityBridge })
        } catch {
          mirror = { state: 'failed', error: 'OPERATION_REJECTED' }
        }
        return Response.json({ receipt: result.receipt, authority: publicAuthority(result.snapshot), mirror, task: publicTask(result.task) })
      }
      const result = await tasks.mutateTaskAuthoritatively({ taskId, patch: { pinned: input.pinned }, ...envelope }, { authorityPath: authorityPath() })
      return Response.json({ receipt: result.receipt, authority: result.snapshot, task: publicTask(result.task) })
    }

    if (req.method !== 'POST') return methodNotAllowed(req.method)
    const input = await readJson<Record<string, unknown>>(req)
    const envelope = authoritativeEnvelope(input)
    switch (action) {
      case 'pin':
      case 'unpin':
      case 'archive':
      case 'restore': {
        const patch = action === 'pin' ? { pinned: true } : action === 'unpin' ? { pinned: false } : { archived: action === 'archive' }
        const result = await tasks.mutateTaskAuthoritatively({ taskId, patch, ...envelope }, { authorityPath: authorityPath() })
        return Response.json({ receipt: result.receipt, authority: result.snapshot, task: publicTask(result.task) })
      }
      case 'continue': {
        const body = input as ContinueProductTaskInput
        const result = await tasks.continueTaskAuthoritatively({ taskId, ...envelope, canonical_input: JSON.stringify(body) }, { authorityPath: authorityPath(), bridge: authorityBridge })
        const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
        return Response.json({ receipt: { outcome: result.outcome, revision: result.revision }, authority: publicAuthority(operation.authority) }, { status: 201 })
      }
      default:
        throw ApiError.notFound(`未知任务操作：${action}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

function recentProjectLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null || !raw.trim()) return 10
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 10
}

async function handleTaskReviewRoute(
  review: ProductTaskReviewApi,
  req: Request,
  url: URL,
  taskId: string,
  resource?: string,
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(req.method)

  switch (resource) {
    case 'status':
      return Response.json(await review.getStatus(taskId))
    case 'tree':
      return Response.json(await review.getTree(taskId, url.searchParams.get('path') ?? ''))
    case 'file':
      return Response.json(await review.getFile(taskId, requireReviewPath(url)))
    case 'diff':
      return Response.json(await review.getDiff(taskId, requireReviewPath(url)))
    default:
      throw ApiError.notFound('未知任务审阅资源')
  }
}

function requireReviewPath(url: URL): string {
  const filePath = url.searchParams.get('path')
  if (!filePath?.trim()) {
    throw ApiError.badRequest('审阅文件需要 path 参数')
  }
  return filePath
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T
  } catch {
    throw ApiError.badRequest('请求必须是 JSON')
  }
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { error: 'METHOD_NOT_ALLOWED', message: `不支持 ${method} 请求` },
    { status: 405 },
  )
}

function publicTask<T extends object>(task: T): T {
  const {
    coreSessionId: _legacyCoreSessionId,
    sourceTurnId: _privateCoreSourceTurnId,
    parentThreadId: _legacyCoreParentThreadId,
    ...publicTask
  } = task as T & {
    coreSessionId?: unknown
    sourceTurnId?: unknown
    parentThreadId?: unknown
  }
  return publicTask as T
}

function publicAuthority<T extends { tasks: object[] }>(authority: T): T {
  return { ...authority, tasks: authority.tasks.map(publicTask) }
}

function publicTaskIndex<T extends { tasks: object[] }>(index: T): T {
  return {
    ...index,
    tasks: index.tasks.map(publicTask),
  }
}

/**
 * The task service returns this public shape already, but retain a narrow
 * projection at the HTTP boundary so future private task metadata cannot be
 * serialized into the ordinary project picker by accident.
 */
function publicRecentProjectList(
  result: ProductRecentProjectList,
): ProductRecentProjectList {
  return {
    projects: result.projects.map(publicRecentProject),
  }
}

function publicRecentProject(project: ProductRecentProject): ProductRecentProject {
  return {
    projectPath: project.projectPath,
    realPath: project.realPath,
    projectName: project.projectName,
    isGit: project.isGit,
    repoName: project.repoName,
    branch: project.branch,
    modifiedAt: project.modifiedAt,
    sessionCount: project.sessionCount,
  }
}
