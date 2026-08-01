import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import type { ProductScheduledTaskService } from '../product/scheduledTaskService.js'

type ProductScheduledTasksApi = Pick<
  ProductScheduledTaskService,
  'listTasks' | 'createTask' | 'updateTask' | 'deleteTask' | 'runTask' | 'listRecentRuns' | 'listTaskRuns' | 'cancelTaskRun'
>

export async function handleProductScheduledTasksApi(
  req: Request,
  url: URL,
  segments: string[],
  scheduledTasks: ProductScheduledTasksApi,
): Promise<Response> {
  try {
    const taskId = segments[3]
    const action = segments[4]

    if (!taskId) {
      if (req.method === 'GET') return Response.json({ tasks: await scheduledTasks.listTasks() })
      if (req.method === 'POST') return Response.json(
        { task: await scheduledTasks.createTask(await readJson(req)) },
        { status: 201 },
      )
      return methodNotAllowed(req.method)
    }

    if (taskId === 'runs' && !action) {
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json({ runs: await scheduledTasks.listRecentRuns(readRunLimit(url)) })
    }

    if (action === 'runs' && !segments[5]) {
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json({ runs: await scheduledTasks.listTaskRuns(taskId) })
    }

    if (action === 'runs' && segments[5] && segments[6] === 'cancel' && !segments[7]) {
      if (req.method !== 'POST') return methodNotAllowed(req.method)
      await scheduledTasks.cancelTaskRun(taskId, segments[5])
      return Response.json({ ok: true })
    }

    if (action === 'run' && !segments[5]) {
      if (req.method !== 'POST') return methodNotAllowed(req.method)
      await scheduledTasks.runTask(taskId)
      return Response.json({ ok: true })
    }

    if (!action) {
      if (req.method === 'PATCH') return Response.json(
        { task: await scheduledTasks.updateTask(taskId, await readJson(req)) },
      )
      if (req.method === 'DELETE') {
        await scheduledTasks.deleteTask(taskId)
        return Response.json({ ok: true })
      }
      return methodNotAllowed(req.method)
    }

    throw ApiError.notFound('未知定时任务资源')
  } catch (error) {
    return errorResponse(error)
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw ApiError.badRequest('请求必须是 JSON')
  }
}

function readRunLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (!raw?.trim()) return 50
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 50
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { error: 'METHOD_NOT_ALLOWED', message: `不支持 ${method} 请求` },
    { status: 405 },
  )
}
