/** 任务式 SSE 事件集。W4a 加 approval_request;steering/todo_update/context_note 等留 W4b/W4c。 */
export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; output: string }
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
