export type AskQuestionOption = { label: string; description?: string; preview?: string }
export type AskQuestionField = {
  name: string
  label: string
  type?: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect'
  required?: boolean
  description?: string
  defaultValue?: string | number | boolean | string[]
  options?: string[]
  placeholder?: string
}

export interface UsageUpdateEvent {
  type: 'usage_update'
  input_tokens: number
  output_tokens: number
  total_tokens: number
  last_input_tokens: number
  last_output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  context_window?: number
  context_percent?: number
}

/** 任务式 SSE 事件集。W4a 加 approval_request;W4b 加 steering/todo_update/context_note。 */
export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'command_invocation'; name: string; args: string; raw: string; source: 'commands'; contentLength: number }
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'tool_progress'; tool: string; id?: string; chunk: string; stream?: string }
  | { type: 'tool_result'; tool: string; output: string }
  | UsageUpdateEvent
  | {
      type: 'ask_question'
      id: string
      question: string
      options: AskQuestionOption[]
      multi?: boolean
      allowFreeform?: boolean
      placeholder?: string
      fields?: AskQuestionField[]
      url?: string
    }
  | { type: 'final'; text: string }
  | {
      type: 'approval_request'
      tool: string
      args: unknown
      id: string
      token: string
      preview?: string
      reason?: { what: string; why: string; impact: string }
      rememberable?: boolean
    }
  | { type: 'steering'; content: string } // 老板插话纠偏,前端渲成用户气泡
  | { type: 'todo_update'; content: string } // 任务清单变化,前端渲成清单
  | { type: 'context_note'; text: string } // 灰色系统旁白(W4c 打转提醒用;W4b 只加类型)
  | { type: 'max_turns_reached'; turnCount: number; maxTurns: number } // 到最大轮次被强制收尾(区别于自然收敛),供前端/日志辨识与遥测
