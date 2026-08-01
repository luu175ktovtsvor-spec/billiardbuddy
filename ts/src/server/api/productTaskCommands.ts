import { getCwd } from '../../utils/cwd.js'
import {
  listProductTaskSkillCommands,
  type ProductTaskSkillCommand,
} from '../product/taskCommandDiscovery.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

type ProductTaskCommandDiscoveryApi = {
  listSkills: (cwd?: string) => Promise<ProductTaskSkillCommand[]>
}

const defaultDiscovery: ProductTaskCommandDiscoveryApi = {
  listSkills: listProductTaskSkillCommands,
}

function requestedCwd(url: URL): string {
  return url.searchParams.get('cwd')?.trim() || getCwd()
}

/**
 * Product task Composer command discovery.
 *
 * GET /api/product/task-commands/skills?cwd=...
 */
export async function handleProductTaskCommandsApi(
  req: Request,
  url: URL,
  segments: string[],
  discovery: ProductTaskCommandDiscoveryApi = defaultDiscovery,
): Promise<Response> {
  try {
    if (segments[2] !== 'task-commands' || !segments[3] || segments[4]) {
      throw ApiError.notFound('未知任务命令资源')
    }
    if (req.method !== 'GET') {
      throw new ApiError(405, '当前任务命令操作暂不支持', 'METHOD_NOT_ALLOWED')
    }

    const cwd = requestedCwd(url)
    if (segments[3] === 'skills') {
      return Response.json({ commands: await discovery.listSkills(cwd) })
    }

    throw ApiError.notFound('未知任务命令资源')
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error)
    return errorResponse(new ApiError(
      503,
      '暂时无法读取可用命令，请稍后重试。',
      'PRODUCT_TASK_COMMANDS_UNAVAILABLE',
    ))
  }
}
