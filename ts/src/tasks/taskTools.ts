import { runAgentLoop } from '../harness/loop'
import type { AgentDefinition } from '../agents/agentLoader'
import { resolveAgentTools } from '../agents/agentLoader'
import type { Model } from '../types/model'
import type { Tool, ToolContext } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import type { TaskService, TaskStatus } from './taskService'

export interface BackgroundAgentTaskInput {
  agent?: string
  task: string
  context?: string
  title?: string
}

export interface BackgroundAgentTaskOptions {
  tasks: TaskService
  agents: AgentDefinition[]
  model: Model
  baseTools: Tool[]
  baseSystemPrompt?: string
  maxTurns?: number
}

function pickAgent(agents: AgentDefinition[], name: unknown): AgentDefinition | null {
  if (typeof name === 'string' && name.trim()) {
    const wanted = name.trim()
    return agents.find(agent => agent.name === wanted) ?? null
  }
  return agents.length === 1 ? agents[0]! : null
}

function agentList(agents: AgentDefinition[]): string {
  return agents.map(agent => `${agent.name}: ${agent.description}`).join('\n')
}

function taskMessage(input: BackgroundAgentTaskInput): string {
  return input.context?.trim()
    ? `${input.task}\n\n<context>\n${input.context.trim()}\n</context>`
    : input.task
}

function taskTitle(input: BackgroundAgentTaskInput, agent: AgentDefinition): string {
  return input.title?.trim() || `${agent.name}: ${input.task.trim().slice(0, 80)}`
}

function agentSystemPrompt(agent: AgentDefinition, baseSystemPrompt = ''): string {
  return [
    baseSystemPrompt,
    `<background_subagent name="${agent.name}">`,
    agent.prompt,
    '</background_subagent>',
    'You are running in a background task. Keep progress concise and return a final result for the user.',
  ].filter(Boolean).join('\n\n')
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function statusFrom(value: unknown): TaskStatus | undefined {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

function formatTasks(tasks: Awaited<ReturnType<TaskService['list']>>): string {
  if (tasks.length === 0) return '当前没有后台任务。'
  return tasks.map(task => {
    const suffix = [
      task.conversationId ? `conversation=${task.conversationId}` : '',
      task.error ? `error=${task.error}` : '',
    ].filter(Boolean).join(' ')
    return `- ${task.id} [${task.status}] ${task.title}${suffix ? ` ${suffix}` : ''}`
  }).join('\n')
}

function formatTaskEvents(task: NonNullable<Awaited<ReturnType<TaskService['get']>>>, events: Awaited<ReturnType<TaskService['loadEvents']>>): string {
  const lines = [
    `<background_task id="${task.id}" status="${task.status}" title="${task.title}">`,
    ...events.map(record => `#${record.seq} ${record.event.type} ${JSON.stringify(record.event)}`),
    '</background_task>',
  ]
  return lines.join('\n')
}

export function createTaskTools(tasks: TaskService): Tool[] {
  const listTasks: Tool = {
    name: 'list_background_tasks',
    description: 'List background tasks for this conversation or all conversations. Input: { conversationId?, status?, limit? }.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const args = recordInput(input)
      const conversationId = typeof args.conversationId === 'string' && args.conversationId.trim()
        ? args.conversationId.trim()
        : ctx.conversationId
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return formatTasks(await tasks.list({ conversationId, status: statusFrom(args.status), limit }))
    },
  }

  const readTask: Tool = {
    name: 'read_background_task',
    description: 'Read background task status and recent events. Input: { task_id, after?, limit? }.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        after: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['task_id'],
    },
    isReadOnly: true,
    async execute(input) {
      const args = recordInput(input)
      if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('read_background_task 需要 string 参数 task_id')
      const task = await tasks.get(args.task_id.trim())
      if (!task) return `没有找到后台任务:${args.task_id}`
      const after = typeof args.after === 'number' ? args.after : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return formatTaskEvents(task, await tasks.loadEvents(task.id, { after, limit }))
    },
  }

  const cancelTask: Tool = {
    name: 'cancel_background_task',
    description: 'Cancel a running background task. Input: { task_id }.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    isReadOnly: false,
    async execute(input) {
      const args = recordInput(input)
      if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('cancel_background_task 需要 string 参数 task_id')
      const cancelled = await tasks.cancel(args.task_id.trim())
      return cancelled ? `已请求取消后台任务:${args.task_id}` : `后台任务未在运行:${args.task_id}`
    },
  }

  return [listTasks, readTask, cancelTask]
}

export function createBackgroundAgentTaskTool(opts: BackgroundAgentTaskOptions): Tool<BackgroundAgentTaskInput> {
  return {
    name: 'start_background_agent_task',
    description: `Start a focused subagent in the background and return a task id immediately. Available agents:\n${agentList(opts.agents)}`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name. Required when more than one agent is available.' },
        task: { type: 'string' },
        context: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['task'],
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'spend',
    approvalReasonFor(input) {
      return {
        what: '启动后台子代理任务',
        why: typeof input.task === 'string' ? input.task.slice(0, 120) : '模型请求启动后台任务',
        impact: '会继续调用模型直到后台任务完成或被取消。',
      }
    },
    async execute(input, ctx: ToolContext) {
      if (!input || typeof input.task !== 'string' || !input.task.trim()) throw new Error('start_background_agent_task 需要 string 参数 task')
      const agent = pickAgent(opts.agents, input.agent)
      if (!agent) throw new Error(`start_background_agent_task 需要指定 agent;可用 agent:\n${agentList(opts.agents)}`)
      const task = await opts.tasks.create({
        title: taskTitle(input, agent),
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      const tools = resolveAgentTools(agent, opts.baseTools)
        .filter(tool => tool.name !== 'start_background_agent_task' && tool.name !== 'cancel_background_task')
      opts.tasks.start(task.id, async taskCtx => {
        let finalText = ''
        for await (const event of runAgentLoop({
          model: opts.model,
          registry: new ToolRegistry(tools),
          workspace: ctx.workspace,
          systemPrompt: agentSystemPrompt(agent, opts.baseSystemPrompt),
          userMessage: taskMessage(input),
          maxTurns: opts.maxTurns ?? 8,
          signal: taskCtx.signal,
          sandbox: ctx.sandbox,
          permissionMode: ctx.permissionMode,
          conversationId: `${ctx.conversationId ?? task.id}_${agent.name}_bg`,
        })) {
          await taskCtx.emit(event)
          if (event.type === 'final') finalText = event.text
        }
        return finalText
      })
      return `<background_task_started id="${task.id}" agent="${agent.name}" status="queued">\n${task.title}\n</background_task_started>`
    },
  }
}
