// 经营工作流 REST 边界:定义列表、手动触发与运行历史。编排与执行语义归 WorkflowRunService。

import type { WorkflowRunService } from '../../workflows/workflowRunService'
import { WorkflowAlreadyRunningError, WorkflowNotFoundError } from '../../workflows/workflowRunService'
import { jsonDetailError } from '../middleware/http'

interface WorkflowRouteDependencies {
  service: Pick<WorkflowRunService, 'listWorkflows' | 'listRuns' | 'getRun' | 'startRunInBackground'>
  defaultWorkspaceRoot?: () => string
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createWorkflowRouteHandler(deps: WorkflowRouteDependencies) {
  return async function handleWorkflowRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/workflows')) return null

    if (url.pathname === '/api/v1/workflows') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({ workflows: await deps.service.listWorkflows() })
    }

    if (url.pathname === '/api/v1/workflows/runs') {
      if (req.method !== 'GET') return methodNotAllowed()
      const workflowId = url.searchParams.get('workflow_id')?.trim() || undefined
      return Response.json({ runs: await deps.service.listRuns(workflowId) })
    }

    const runDetailMatch = url.pathname.match(/^\/api\/v1\/workflows\/runs\/([^/]+)$/)
    if (runDetailMatch) {
      if (req.method !== 'GET') return methodNotAllowed()
      const run = await deps.service.getRun(decodeURIComponent(runDetailMatch[1]!))
      if (!run) return jsonDetailError('workflow run not found', 404)
      return Response.json(run)
    }

    const runMatch = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/run$/)
    if (runMatch) {
      if (req.method !== 'POST') return methodNotAllowed()
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const workingDir = typeof body.working_dir === 'string' && body.working_dir.trim()
        ? body.working_dir.trim()
        : deps.defaultWorkspaceRoot?.()
      try {
        const run = await deps.service.startRunInBackground(decodeURIComponent(runMatch[1]!), {
          trigger: 'manual',
          workingDir,
        })
        return Response.json(run, { status: 202 })
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return jsonDetailError('workflow not found', 404)
        if (err instanceof WorkflowAlreadyRunningError) return jsonDetailError(err.message, 409)
        throw err
      }
    }

    return null
  }
}
