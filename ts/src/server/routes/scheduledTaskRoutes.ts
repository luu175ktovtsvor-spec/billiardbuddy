// 定时任务 REST 边界：CRUD、立即运行与运行历史。调度与执行语义归 ScheduledTaskRunner。

import type { DesktopDataStore } from '../services/desktopDataStore'
import type { ScheduledTaskRunner } from '../services/scheduledTaskRunner'
import { jsonDetailError } from '../middleware/http'

interface ScheduledTaskRouteDependencies {
  store: Pick<
    DesktopDataStore,
    'listScheduledTasks' | 'createScheduledTask' | 'updateScheduledTask' | 'deleteScheduledTask'
  >
  runner: Pick<ScheduledTaskRunner, 'getTaskRuns' | 'runTaskNow'>
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createScheduledTaskRouteHandler(deps: ScheduledTaskRouteDependencies) {
  return async function handleScheduledTaskRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/scheduled-tasks')) return null

    if (url.pathname === '/api/v1/scheduled-tasks') {
      if (req.method === 'GET') return Response.json(await deps.store.listScheduledTasks())
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await deps.store.createScheduledTask(body), { status: 201 })
      }
      return methodNotAllowed()
    }

    const runsMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/runs$/)
    if (runsMatch) {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({ runs: await deps.runner.getTaskRuns(decodeURIComponent(runsMatch[1]!)) })
    }

    const runMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/run$/)
    if (runMatch) {
      if (req.method !== 'POST') return methodNotAllowed()
      const run = await deps.runner.runTaskNow(decodeURIComponent(runMatch[1]!))
      if (!run) return jsonDetailError('scheduled task not found', 404)
      return Response.json(run, { status: 202 })
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)$/)
    if (!taskMatch) return null
    const id = decodeURIComponent(taskMatch[1]!)
    if (req.method === 'PATCH') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const task = await deps.store.updateScheduledTask(id, body)
      if (!task) return jsonDetailError('scheduled task not found', 404)
      return Response.json(task)
    }
    if (req.method === 'DELETE') {
      await deps.store.deleteScheduledTask(id)
      return Response.json({ status: 'ok' })
    }
    return methodNotAllowed()
  }
}
