import type { Message, ToolUseBlock } from '../types/message'
import { stableStringify } from '../permissions/canonical'

export const MAX_SAME_CALL = 5
export const MAX_TOTAL_TOOL_CALLS_NO_PROGRESS = 40

export type StuckPattern = 'action_observation' | 'action_error' | 'monologue' | 'too_many_tools'

export interface StuckFinding {
  pattern: StuckPattern
  message: string
}

export function callKey(name: string, input: unknown): string {
  try {
    return `${name}:${stableStringify(input ?? {})}`
  } catch {
    return `${name}:<unserializable>`
  }
}

function toolUses(messages: Message[]): ToolUseBlock[] {
  return messages.flatMap(m => m.content.flatMap(b => (b.type === 'tool_use' ? [b] : [])))
}

function assistantTextTurns(messages: Message[]): number {
  let n = 0
  for (const m of messages.slice(-8)) {
    if (m.role === 'assistant' && m.content.some(b => b.type === 'text' && b.text.trim())) n++
  }
  return n
}

export function detectStuck(
  messages: Message[],
  opts: { totalToolCallsNoProgress?: number } = {},
): StuckFinding | null {
  if ((opts.totalToolCallsNoProgress ?? 0) >= MAX_TOTAL_TOOL_CALLS_NO_PROGRESS) {
    return {
      pattern: 'too_many_tools',
      message: `已经连续调用了 ${MAX_TOTAL_TOOL_CALLS_NO_PROGRESS} 次工具还没有收敛。停下来总结已知结果,换策略或给出阶段性结论。`,
    }
  }

  const calls = toolUses(messages).slice(-6)
  if (calls.length >= 4) {
    const last4 = calls.slice(-4).map(c => callKey(c.name, c.input))
    if (last4.every(k => k === last4[0])) {
      return {
        pattern: 'action_observation',
        message: '你正在重复同一个工具调用。不要原地打转;根据已有结果换一个动作,或向老板说明卡点。',
      }
    }
  }

  const recentResults = messages.slice(-8).flatMap(m => m.content.filter(b => b.type === 'tool_result'))
  if (recentResults.length >= 3 && recentResults.slice(-3).every(r => r.type === 'tool_result' && r.is_error)) {
    return {
      pattern: 'action_error',
      message: '最近连续工具报错。先解释失败原因,换更小的验证步骤,不要继续重复失败调用。',
    }
  }

  if (assistantTextTurns(messages) >= 3 && calls.length === 0) {
    return {
      pattern: 'monologue',
      message: '你已经连续多轮只说不做。若任务需要执行,请开始使用工具;若不需要,请直接给出最终结论。',
    }
  }
  return null
}

export function sameCallGuardMessage(toolName: string): string {
  return `连续重复调用 ${toolName} 已达到上限。请停止重复同一动作,根据已有结果换策略或给出阶段性结论。`
}
