import type { Message, ToolUseBlock } from '../types/message'
import { stableStringify } from '../permissions/canonical'

export const CORE_SAME_CALL_LIMIT = 4
export const EXTENSION_SAME_CALL_LIMIT = 40
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

const CORE_STUCK_GUARD_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'write_file',
  'edit_file',
  'patch_files',
  'list_dir',
  'glob_files',
  'grep_files',
  'code_outline',
  'file_history',
  'restore_file',
  'run_command',
  'project_diagnostics',
  'git_status',
  'git_history',
  'tool_search',
  'todo_write',
  'read_stored_tool_result',
  'search_store_docs',
  'list_project_instructions',
])

export function sameCallLimitForTool(toolName: string): number {
  if (toolName.startsWith('mcp__')) return EXTENSION_SAME_CALL_LIMIT
  return CORE_STUCK_GUARD_TOOLS.has(toolName) ? CORE_SAME_CALL_LIMIT : EXTENSION_SAME_CALL_LIMIT
}

function trailingSameCallStreak(calls: ToolUseBlock[]): { toolName: string; count: number } | null {
  const last = calls.at(-1)
  if (!last) return null
  const key = callKey(last.name, last.input)
  let count = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!
    if (callKey(call.name, call.input) !== key) break
    count++
  }
  return { toolName: last.name, count }
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

  const calls = toolUses(messages)
  const streak = trailingSameCallStreak(calls)
  if (streak && streak.count >= sameCallLimitForTool(streak.toolName)) {
    return {
      pattern: 'action_observation',
      message: `你正在重复同一个工具调用(${streak.count} 次)。不要原地打转;根据已有结果换一个动作,或向老板说明卡点。`,
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
