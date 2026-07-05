/** W1 起步:最小事件集,是 W2/W11「任务式 SSE 12 事件」契约的种子,别在 W1 铺满。 */
export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; output: string }
  | { type: 'final'; text: string }
