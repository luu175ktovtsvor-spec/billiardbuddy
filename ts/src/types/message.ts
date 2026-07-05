/** OpenAI 兼容消息(我们的模型出口是 OpenAI 兼容;对标 loop.py 的 role:tool 回灌)。 */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
