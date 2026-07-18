/**
 * Agents REST API
 *
 * GET    /api/agents        — 获取可执行的协作助手命令
 * GET    /api/agents/:name  — 检查已保存的 Agent 是否可用
 * POST   /api/agents        — 创建 Agent
 * PUT    /api/agents/:name  — 更新 Agent
 * DELETE /api/agents/:name  — 删除 Agent
 *
 * GET    /api/tasks         — 获取后台任务列表
 * GET    /api/tasks/:id     — 获取任务详情
 */

import { AgentService } from '../services/agentService.js'
import { taskService } from '../services/taskService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { resetTaskList } from '../../utils/tasks.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type AgentDefinition as SharedAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'

const agentService = new AgentService()

export async function handleAgentsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'agents' | 'tasks'

    if (resource === 'tasks') {
      return await handleTasksApi(req, segments)
    }

    return await handleAgents(req, url, segments)
  } catch (error) {
    if (segments[1] === 'agents') {
      return agentErrorResponse(error)
    }
    return errorResponse(error)
  }
}

// ─── Agent CRUD ─────────────────────────────────────────────────────────────

async function handleAgents(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const method = req.method
  const agentName = segments[2] ? decodeURIComponent(segments[2]) : undefined

  // ── GET /api/agents ──────────────────────────────────────────────────
  if (method === 'GET' && !agentName) {
    const cwd = url.searchParams.get('cwd') || getCwd()
    const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)

    return Response.json({
      agents: serializeAgentCommands(activeAgents),
    })
  }

  // ── GET /api/agents/:name ────────────────────────────────────────────
  if (method === 'GET' && agentName) {
    const agent = await agentService.getAgent(agentName)
    if (!agent) {
      throw ApiError.notFound(`Agent not found: ${agentName}`)
    }
    return Response.json({ available: true })
  }

  // ── POST /api/agents ─────────────────────────────────────────────────
  if (method === 'POST' && !agentName) {
    const body = await parseJsonBody(req)
    if (!body.name || typeof body.name !== 'string') {
      throw ApiError.badRequest('Missing or invalid "name" in request body')
    }
    await agentService.createAgent({
      name: body.name as string,
      description: body.description as string | undefined,
      model: body.model as string | undefined,
      tools: body.tools as string[] | undefined,
      systemPrompt: body.systemPrompt as string | undefined,
      color: body.color as string | undefined,
    })
    clearAgentDefinitionsCache()
    return Response.json({ ok: true }, { status: 201 })
  }

  // ── PUT /api/agents/:name ────────────────────────────────────────────
  if (method === 'PUT' && agentName) {
    const body = await parseJsonBody(req)
    await agentService.updateAgent(agentName, body as Record<string, unknown>)
    clearAgentDefinitionsCache()
    return Response.json({ ok: true })
  }

  // ── DELETE /api/agents/:name ─────────────────────────────────────────
  if (method === 'DELETE' && agentName) {
    await agentService.deleteAgent(agentName)
    clearAgentDefinitionsCache()
    return Response.json({ ok: true })
  }

  throw new ApiError(
    405,
    `Method ${method} not allowed on /api/agents${agentName ? `/${agentName}` : ''}`,
    'METHOD_NOT_ALLOWED',
  )
}

// ─── Tasks API ─────────────────────────────────────────────────────────────
//
// GET /api/tasks                         → list all tasks (across all task lists)
// GET /api/tasks/lists                   → list all task lists with summaries
// GET /api/tasks/lists/:taskListId       → get all tasks for a specific task list
// GET /api/tasks/lists/:taskListId/:id   → get a single task
// POST /api/tasks/lists/:taskListId/reset → clear a completed task list

async function handleTasksApi(
  req: Request,
  segments: string[],
): Promise<Response> {
  const sub = segments[2] // 'lists' or undefined

  if (sub === 'lists') {
    const taskListId = segments[3]
    const taskId = segments[4]

    if (req.method === 'POST' && taskListId && taskId === 'reset') {
      await resetTaskList(taskListId)
      return Response.json({ ok: true })
    }

    if (req.method !== 'GET') {
      throw new ApiError(
        405,
        `Method ${req.method} not allowed on /api/tasks/lists`,
        'METHOD_NOT_ALLOWED',
      )
    }

    if (taskListId && taskId) {
      // GET /api/tasks/lists/:taskListId/:taskId
      const task = await taskService.getTask(taskListId, taskId)
      if (!task) throw ApiError.notFound(`Task not found: ${taskListId}/${taskId}`)
      return Response.json({ task })
    }

    if (taskListId) {
      // GET /api/tasks/lists/:taskListId
      const tasks = await taskService.getTasksForList(taskListId)
      return Response.json({ tasks })
    }

    // GET /api/tasks/lists
    const lists = await taskService.listTaskLists()
    return Response.json({ lists })
  }

  if (req.method !== 'GET') {
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/tasks`,
      'METHOD_NOT_ALLOWED',
    )
  }

  // GET /api/tasks — list all tasks
  const tasks = await taskService.listTasks()
  return Response.json({ tasks })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function agentErrorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.statusCode : 500
  const code =
    status === 400 || status === 405
      ? 'AGENT_REQUEST_INVALID'
      : status === 404
        ? 'AGENT_NOT_FOUND'
        : status === 409
          ? 'AGENT_NAME_CONFLICT'
          : 'AGENT_UNAVAILABLE'

  return Response.json({ error: code }, { status })
}

export type ProductAgentCommand = {
  displayName: string
  runtimeName: string
}

const GUIDE_RUNTIME_NAME = 'claude-code-guide'
const GUIDE_DISPLAY_NAME = 'agent-guide'

/**
 * Keep the desktop's Agent discovery surface limited to the two values needed
 * to insert a working `/agent` command. Runtime definitions carry prompts,
 * permissions, hooks, MCP references, source precedence, and local paths;
 * none of those belong in an ordinary product-facing response.
 */
function serializeAgentCommands(
  agents: SharedAgentDefinition[],
): ProductAgentCommand[] {
  const runtimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: ProductAgentCommand[] = []
  let nextAssistantNumber = 1

  for (const agent of agents) {
    const runtimeName = agent.agentType.trim()
    if (!runtimeName || runtimeNames.has(runtimeName)) continue
    runtimeNames.add(runtimeName)

    const displayName = agent.source === 'built-in' && runtimeName === GUIDE_RUNTIME_NAME
      ? GUIDE_DISPLAY_NAME
      : nextGenericAssistantName(displayNames, () => nextAssistantNumber++)
    displayNames.add(displayName)

    commands.push({ displayName, runtimeName })
  }

  return commands
}

function nextGenericAssistantName(
  usedNames: ReadonlySet<string>,
  nextNumber: () => number,
): string {
  let candidate = ''
  do {
    candidate = `assistant-${nextNumber()}`
  } while (usedNames.has(candidate))
  return candidate
}
