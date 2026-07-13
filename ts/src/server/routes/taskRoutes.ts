// 现代后台任务 REST 边界。任务状态、事件与运行生命周期归 TaskService。

import { type TaskMeta, type TaskService, type TaskStatus } from '../../tasks/taskService'
import { numberFrom, taskStatusFrom } from '../requestParams'

type TaskRouteService = Pick<
  TaskService,
  'list' | 'get' | 'resolveBackgroundAgentTarget' | 'loadEvents' | 'cancel' | 'requestForegroundAgentBackground'
>

interface TaskRouteDependencies {
  tasks: TaskRouteService
}

export async function resolveTaskEndpointTarget(
  tasks: Pick<TaskService, 'get' | 'resolveBackgroundAgentTarget'>,
  id: string,
  statuses?: TaskStatus[],
): Promise<{ task: TaskMeta | null; requestedTaskId: string }> {
  const resolution = await tasks.resolveBackgroundAgentTarget(id, {
    ...(statuses ? { statuses } : {}),
  })
  if (resolution.task) return { task: resolution.task, requestedTaskId: id }
  return { task: await tasks.get(id), requestedTaskId: id }
}

function taskAliasPayload(task: TaskMeta, requestedTaskId: string): Record<string, string> {
  const agentId = typeof task.params?.agent_id === 'string' && task.params.agent_id.trim()
    ? task.params.agent_id.trim()
    : ''
  return {
    ...(agentId ? { agentId } : {}),
    ...(requestedTaskId !== task.id ? { requestedTaskId, resolvedTaskId: task.id } : {}),
  }
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createTaskRouteHandler(deps: TaskRouteDependencies) {
  return async function handleTaskRoute(url: URL, req: Request): Promise<Response | null> {
    if (url.pathname === '/tasks') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({
        tasks: await deps.tasks.list({
          conversationId: url.searchParams.get('conversationId') ?? undefined,
          status: taskStatusFrom(url.searchParams.get('status')),
          limit: numberFrom(url.searchParams.get('limit'), 200),
          collapseResumedBackgroundAgents: true,
        }),
      })
    }

    const taskMatch = url.pathname.match(/^\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel|background))?$/)
    if (!taskMatch) return null
    const id = taskMatch[1]!
    const action = taskMatch[2]

    if (!action && req.method === 'GET') {
      const { task, requestedTaskId } = await resolveTaskEndpointTarget(deps.tasks, id)
      if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
      const includeEvents = url.searchParams.get('includeEvents') === '1'
      return Response.json({
        task,
        ...taskAliasPayload(task, requestedTaskId),
        ...(includeEvents ? { events: await deps.tasks.loadEvents(task.id, { limit: 100 }) } : {}),
      })
    }

    if (action === 'events' && req.method === 'GET') {
      const { task, requestedTaskId } = await resolveTaskEndpointTarget(deps.tasks, id)
      if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      const events = await deps.tasks.loadEvents(task.id, { after, limit })
      return Response.json({
        events,
        ...taskAliasPayload(task, requestedTaskId),
        nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
      })
    }

    if (action === 'cancel' && req.method === 'POST') {
      const { task, requestedTaskId } = await resolveTaskEndpointTarget(deps.tasks, id, ['queued', 'running'])
      const taskId = task?.id ?? id
      return Response.json({
        ok: true,
        cancelled: await deps.tasks.cancel(taskId),
        taskId,
        ...(task && task.id !== requestedTaskId ? { requestedTaskId } : {}),
      })
    }

    if (action === 'background' && req.method === 'POST') {
      try {
        const task = await deps.tasks.requestForegroundAgentBackground(id)
        return Response.json({ ok: true, task, ...taskAliasPayload(task, id) })
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 404 })
      }
    }

    return methodNotAllowed()
  }
}
