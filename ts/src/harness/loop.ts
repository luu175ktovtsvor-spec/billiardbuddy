import type { AgentEvent } from '../types/events'
import type { Message, ToolCall } from '../types/message'
import type { Model } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'

export interface RunAgentLoopOptions {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  userMessage: string
  maxTurns?: number
  signal?: AbortSignal
}

/**
 * 真 ReAct 主循环(照 cc-haha query.ts / 现有 loop.py):
 * think → 有 tool_calls 就逐个执行 → 结果作 role:tool 回灌 → 再 think,直到收敛或 max_turns 兜底。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry, workspace } = opts
  const maxTurns = opts.maxTurns ?? 12
  const ctx: ToolContext = { workspace, signal: opts.signal }
  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userMessage },
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    const step = await model.step({ messages, tools: registry.specs() })
    if (step.kind === 'final') {
      messages.push({ role: 'assistant', content: step.text })
      yield { type: 'final', text: step.text }
      return
    }
    if (step.text) yield { type: 'thinking', text: step.text }
    messages.push({ role: 'assistant', content: step.text ?? '', toolCalls: step.calls })
    for (const call of step.calls) {
      yield { type: 'tool_call', tool: call.name, input: call.input }
      const output = await executeTool(registry, call, ctx)
      yield { type: 'tool_result', tool: call.name, output }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output })
    }
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ messages, tools: [] })
  yield { type: 'final', text: forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)' }
}

/** 工具执行永不抛:不存在/入参非法/执行异常都转成错误文本回灌,让模型自救(照 loop.py)。 */
async function executeTool(registry: ToolRegistry, call: ToolCall, ctx: ToolContext): Promise<string> {
  const tool = registry.get(call.name)
  if (!tool) return `错误:未知工具 ${call.name}`
  try {
    return await tool.execute(call.input, ctx)
  } catch (err) {
    return `错误:工具 ${call.name} 执行失败:${err instanceof Error ? err.message : String(err)}`
  }
}
