import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import { errorResponse, ApiError } from '../middleware/errorHandler.js'
import { productTaskService, type ProductTaskService } from '../product/taskService.js'

export async function handleProductApi(
  req: Request,
  _url: URL,
  segments: string[],
  tasks: Pick<
    ProductTaskService,
    'listTasks' | 'createTask' | 'updateTask' | 'setPinned' | 'setArchived' | 'continueTask'
  > = productTaskService,
): Promise<Response> {
  try {
    if (segments[2] !== 'tasks') {
      throw ApiError.notFound('未知产品资源')
    }

    const taskId = segments[3]
    const action = segments[4]

    if (!taskId) {
      if (req.method === 'GET') return Response.json(await tasks.listTasks())
      if (req.method === 'POST') {
        const input = await readJson<CreateProductTaskInput>(req)
        return Response.json({ task: await tasks.createTask(input) }, { status: 201 })
      }
      return methodNotAllowed(req.method)
    }

    if (!action) {
      if (req.method !== 'PATCH') return methodNotAllowed(req.method)
      const input = await readJson<UpdateProductTaskInput>(req)
      return Response.json({ task: await tasks.updateTask(taskId, input) })
    }

    if (req.method !== 'POST') return methodNotAllowed(req.method)
    switch (action) {
      case 'pin':
        return Response.json({ task: await tasks.setPinned(taskId, true) })
      case 'unpin':
        return Response.json({ task: await tasks.setPinned(taskId, false) })
      case 'archive':
        return Response.json({ task: await tasks.setArchived(taskId, true) })
      case 'restore':
        return Response.json({ task: await tasks.setArchived(taskId, false) })
      case 'continue': {
        const input = await readJson<ContinueProductTaskInput>(req)
        return Response.json({ task: await tasks.continueTask(taskId, input) }, { status: 201 })
      }
      default:
        throw ApiError.notFound(`未知任务操作：${action}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
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
