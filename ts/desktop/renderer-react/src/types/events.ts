// 前端镜像:与后端 ts/src/types/events.ts 的 AgentEvent 逐字段对齐。
// ⚠️ 这是「后端 → 前端」WS event.event 的真实载荷,别照抄 cc 的事件 schema。
// 改后端 events.ts 时同步这里。

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

export interface ApprovalReason {
  what: string
  why: string
  impact: string
}

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
      reason?: ApprovalReason
      warning?: string
      rememberable?: boolean
    }
  | { type: 'content_delta'; channel: 'text' | 'thinking'; text: string }
  | { type: 'steering'; content: string }
  | { type: 'todo_update'; content: string }
  | { type: 'context_note'; text: string }
  | { type: 'max_turns_reached'; turnCount: number; maxTurns: number }

/** 会话流事件 = AgentEvent + 收尾 done(后端 SessionStreamEvent 对齐)。 */
export type SessionStreamEvent = AgentEvent | { type: 'done' }
