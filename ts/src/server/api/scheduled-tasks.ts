/**
 * Scheduled Tasks REST API
 *
 * GET    /api/scheduled-tasks           — 获取任务列表
 * POST   /api/scheduled-tasks           — 创建任务
 * GET    /api/scheduled-tasks/runs      — 获取所有任务的最近执行记录
 * GET    /api/scheduled-tasks/:id/runs  — 获取指定任务的执行记录
 * POST   /api/scheduled-tasks/:id/run   — 立即执行指定任务
 * PUT    /api/scheduled-tasks/:id       — 更新任务
 * DELETE /api/scheduled-tasks/:id       — 删除任务
 */

import {
  CronService,
  isScheduledTaskPermissionMode,
  type CronTask,
} from '../services/cronService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const cronService = new CronService()

type PublicTaskRun = Omit<Awaited<ReturnType<typeof cronScheduler.getRecentRuns>>[number], 'sessionId'>

/**
 * Scheduled-run summaries are a product surface.  The optional Core session
 * used by older manual runs remains server-private and cannot become a raw
 * renderer navigation target.
 */
function publicTaskRun(run: Awaited<ReturnType<typeof cronScheduler.getRecentRuns>>[number]): PublicTaskRun {
  const { sessionId: _coreSessionId, ...publicRun } = run
  return publicRun
}

export async function handleScheduledTasksApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const taskId = segments[2] // /api/scheduled-tasks/:id  or "runs"
    const subResource = segments[3] // /api/scheduled-tasks/:id/runs

    // ── GET /api/scheduled-tasks/runs ────────────────────────────────────
    if (method === 'GET' && taskId === 'runs') {
      const url = new URL(req.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const runs = await cronScheduler.getRecentRuns(limit)
      return Response.json({ runs: runs.map(publicTaskRun) })
    }

    // ── GET /api/scheduled-tasks/:id/runs ────────────────────────────────
    if (method === 'GET' && taskId && subResource === 'runs') {
      const runs = await cronScheduler.getTaskRuns(taskId)
      return Response.json({ runs: runs.map(publicTaskRun) })
    }

    // ── GET /api/scheduled-tasks ──────────────────────────────────────────
    if (method === 'GET' && !taskId) {
      const tasks = await cronService.listTasks()
      return Response.json({ tasks })
    }

    // ── POST /api/scheduled-tasks ─────────────────────────────────────────
    if (method === 'POST' && !taskId) {
      const body = await parseJsonBody(req)
      const task = await cronService.createTask({
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        cron: body.cron as string,
        prompt: body.prompt as string,
        enabled: body.enabled !== undefined ? (body.enabled as boolean) : undefined,
        recurring: body.recurring as boolean | undefined,
        permanent: body.permanent as boolean | undefined,
        permissionMode: parseScheduledTaskPermissionMode(body.permissionMode),
        model: body.model as string | undefined,
        providerId: body.providerId as string | null | undefined,
        folderPath: body.folderPath as string | undefined,
        notification: body.notification as CronTask['notification'],
      })
      return Response.json({ task }, { status: 201 })
    }

    // ── POST /api/scheduled-tasks/:id/run ──────────────────────────────────
    // Fire-and-forget: start execution in background, return immediately.
    // The frontend polls GET /:id/runs to track progress.
    if (method === 'POST' && taskId && subResource === 'run') {
      const tasks = await cronService.listTasks()
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw ApiError.notFound(`Task ${taskId} not found`)
      // Scheduled runs have their own output/error history. Do not create a
      // legacy Core conversation merely to support a renderer escape hatch.
      cronScheduler.executeTask(task).catch((err) => {
        console.error(`[ScheduledTasks] Manual run failed for task ${taskId}:`, err)
      })
      // Small delay to let appendRun() write the "running" entry to disk
      await new Promise((r) => setTimeout(r, 200))
      return Response.json({ ok: true })
    }

    // ── PUT /api/scheduled-tasks/:id ──────────────────────────────────────
    if (method === 'PUT' && taskId && !subResource) {
      const body = await parseJsonBody(req)
      const task = await cronService.updateTask(
        taskId,
        parseScheduledTaskUpdate(body),
      )
      return Response.json({ task })
    }

    // ── DELETE /api/scheduled-tasks/:id ───────────────────────────────────
    if (method === 'DELETE' && taskId && !subResource) {
      await cronService.deleteTask(taskId)
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/scheduled-tasks${taskId ? `/${taskId}` : ''}${subResource ? `/${subResource}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function parseScheduledTaskPermissionMode(
  value: unknown,
): CronTask['permissionMode'] | undefined {
  if (value === undefined) return undefined
  if (isScheduledTaskPermissionMode(value)) return value
  throw ApiError.badRequest(
    'Scheduled tasks never bypass permissions. Actions that need approval are rejected while the task runs unattended.',
  )
}

function parseScheduledTaskUpdate(
  body: Record<string, unknown>,
): Partial<CronTask> {
  const { permissionMode, useWorktree: _legacyUseWorktree, ...updates } = body
  const parsedPermissionMode = parseScheduledTaskPermissionMode(permissionMode)
  return {
    ...updates,
    ...(parsedPermissionMode ? { permissionMode: parsedPermissionMode } : {}),
  } as Partial<CronTask>
}
