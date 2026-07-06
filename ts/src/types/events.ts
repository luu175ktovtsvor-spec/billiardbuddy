/** 任务式 SSE 事件集。W4a 加 approval_request;W4b 加 steering/todo_update/context_note。 */
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
  | { type: 'steering'; content: string } // 老板插话纠偏,前端渲成用户气泡
  | { type: 'todo_update'; content: string } // 任务清单变化,前端渲成清单
  | { type: 'context_note'; text: string } // 灰色系统旁白(W4c 打转提醒用;W4b 只加类型)
