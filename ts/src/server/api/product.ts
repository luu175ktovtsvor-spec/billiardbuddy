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
import { handleProductVoiceApi } from './productVoice.js'

type ProductTaskReviewApi = Pick<
  ProductTaskReviewService,
  'getStatus' | 'getTree' | 'getFile' | 'getDiff'
>

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
  > = productTaskService,
  review: ProductTaskReviewApi = productTaskReviewService,
  media: ProductTaskMediaApi = new ProductTaskMediaService(tasks),
  scheduledTasks: ProductScheduledTaskService = productScheduledTaskService,
): Promise<Response> {
  try {
    if (segments[2] === 'voice') {
      return await handleProductVoiceApi(req, segments)
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
      if (req.method === 'GET') return Response.json(publicTaskIndex(await tasks.listTasks()))
      if (req.method === 'POST') {
        const input = await readJson<CreateProductTaskInput>(req)
        return Response.json({ task: publicTask(await tasks.createTask(input)) }, { status: 201 })
      }
      return methodNotAllowed(req.method)
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
          return Response.json({ sideTasks: (await tasks.listSideTasks(taskId)).map(publicTask) })
        }
        if (req.method === 'POST') {
          const input = await readJson<CreateProductSideTaskInput>(req)
          return Response.json(
            { sideTask: publicTask(await tasks.createSideTask(taskId, input)) },
            { status: 201 },
          )
        }
        return methodNotAllowed(req.method)
      }

      if (sideTaskAction === 'close') {
        if (req.method !== 'POST') return methodNotAllowed(req.method)
        return Response.json({ sideTask: publicTask(await tasks.closeSideTask(taskId, sideTaskId)) })
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
      return Response.json({ task: publicTask(await tasks.updateTask(taskId, input)) })
    }

    if (req.method !== 'POST') return methodNotAllowed(req.method)
    switch (action) {
      case 'pin':
        return Response.json({ task: publicTask(await tasks.setPinned(taskId, true)) })
      case 'unpin':
        return Response.json({ task: publicTask(await tasks.setPinned(taskId, false)) })
      case 'archive':
        return Response.json({ task: publicTask(await tasks.setArchived(taskId, true)) })
      case 'restore':
        return Response.json({ task: publicTask(await tasks.setArchived(taskId, false)) })
      case 'continue': {
        const input = await readJson<ContinueProductTaskInput>(req)
        return Response.json({ task: publicTask(await tasks.continueTask(taskId, input)) }, { status: 201 })
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
