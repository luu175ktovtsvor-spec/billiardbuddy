import { runAgentLoop } from '../harness/loop'
import type { Model } from '../types/model'
import type { Tool } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import type { AgentDefinition } from './agentLoader'
import { resolveAgentTools } from './agentLoader'

export interface AgentTaskInput {
  agent?: string
  task: string
  context?: string
}

export interface AgentTaskToolOptions {
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

function buildAgentSystemPrompt(agent: AgentDefinition, baseSystemPrompt = ''): string {
  return [
    baseSystemPrompt,
    `<subagent name="${agent.name}">`,
    agent.prompt,
    '</subagent>',
    'You are running as an isolated subagent. Return only the useful result for the parent agent.',
  ].filter(Boolean).join('\n\n')
}

function buildTaskMessage(input: AgentTaskInput): string {
  return input.context?.trim()
    ? `${input.task}\n\n<context>\n${input.context.trim()}\n</context>`
    : input.task
}

export function createAgentTaskTool(opts: AgentTaskToolOptions): Tool<AgentTaskInput> {
  return {
    name: 'agent_task',
    description: `Run a focused subagent and return only its final result. Available agents:\n${agentList(opts.agents)}`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name. Required when more than one agent is available.' },
        task: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['task'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      if (!input || typeof input.task !== 'string' || !input.task.trim()) {
        throw new Error('agent_task 需要 string 参数 task')
      }
      const agent = pickAgent(opts.agents, input.agent)
      if (!agent) {
        throw new Error(`agent_task 需要指定 agent;可用 agent:\n${agentList(opts.agents)}`)
      }

      const tools = resolveAgentTools(agent, opts.baseTools).filter(tool => tool.name !== 'agent_task')
      const registry = new ToolRegistry(tools)
      let finalText = ''
      for await (const ev of runAgentLoop({
        model: opts.model,
        registry,
        workspace: ctx.workspace,
        systemPrompt: buildAgentSystemPrompt(agent, opts.baseSystemPrompt),
        userMessage: buildTaskMessage(input),
        maxTurns: opts.maxTurns ?? 8,
        signal: ctx.signal,
        sandbox: ctx.sandbox,
        permissionMode: ctx.permissionMode,
        conversationId: ctx.conversationId ? `${ctx.conversationId}_${agent.name}` : undefined,
      })) {
        if (ev.type === 'final') finalText = ev.text
      }
      return `<agent_task agent="${agent.name}">\n${finalText}\n</agent_task>`
    },
  }
}

