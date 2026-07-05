import type { Message, ToolCall } from './message'
import type { ToolSpec } from '../tools/Tool'

export interface ModelStepInput {
  messages: Message[]
  tools: ToolSpec[]
}

/** 模型一步的产出:要么请求若干工具,要么收敛到最终答复。真模型(W6)把 LLM 响应解析成这个;fake 直接返回。 */
export type AssistantStep =
  | { kind: 'tool_calls'; text?: string; calls: ToolCall[] }
  | { kind: 'final'; text: string }

/** 主循环依赖注入的小接口——真模型出口留 W6,测试用脚本化 fake 驱动。 */
export interface Model {
  step(input: ModelStepInput): Promise<AssistantStep>
}
