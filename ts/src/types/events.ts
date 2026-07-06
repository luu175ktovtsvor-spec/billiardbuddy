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

/** 任务式 SSE 事件集。W4a 加 approval_request;W4b 加 steering/todo_update/context_note。 */
export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'command_invocation'; name: string; args: string; raw: string; source: 'commands'; contentLength: number }
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; output: string }
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
    }
  | { type: 'steering'; content: string } // 老板插话纠偏,前端渲成用户气泡
  | { type: 'todo_update'; content: string } // 任务清单变化,前端渲成清单
  | { type: 'context_note'; text: string } // 灰色系统旁白(W4c 打转提醒用;W4b 只加类型)
