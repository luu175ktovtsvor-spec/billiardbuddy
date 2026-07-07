import type { Message, ToolCall } from './message'
import type { ToolSpec } from '../tools/Tool'

export interface ModelUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ModelStepInput {
  /** 系统提示单列(Anthropic 语义:不是一条 role:'system' 消息)。proxy 出方向会把它塞成 OpenAI 的 system 消息。 */
  system?: string
  messages: Message[]
  tools: ToolSpec[]
  /** 外部中断信号;server interrupt 用它取消模型 fetch 与工具执行。 */
  signal?: AbortSignal
}

export const MODEL_OUTPUT_TRUNCATED_NOTICE = '模型输出被长度上限截断,已要求继续补全。'

/**
 * 模型一步的产出:要么请求若干工具,要么收敛到最终答复。真模型(W6)把 LLM 响应解析成这个;fake 直接返回。
 * text=正文叙述(会进历史 text 块);thinking=推理(仅展示、不回灌模型)。
 * kind 由"有没有 tool_use"决定,不看 finish_reason(见 ProxyModel;05 清单⑥)。
 */
export type AssistantStep =
  | { kind: 'tool_calls'; text?: string; thinking?: string; calls: ToolCall[]; usage?: ModelUsage; notices?: string[] }
  | { kind: 'final'; text: string; thinking?: string; usage?: ModelUsage; notices?: string[] }

/** 主循环依赖注入的小接口——真模型出口留 W6,测试用脚本化 fake 驱动。 */
export interface Model {
  step(input: ModelStepInput): Promise<AssistantStep>
}
