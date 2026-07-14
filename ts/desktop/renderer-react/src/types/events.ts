// Renderer 直接复用 sidecar 的权威事件契约，禁止再维护手写镜像。
export {
  agentEventSchema,
  sessionStreamEventSchema,
} from '../../../../shared/contracts/agent-events'
export type {
  AgentEvent,
  ApprovalReason,
  AskQuestionField,
  AskQuestionOption,
  SessionStreamEvent,
  UsageUpdateEvent,
} from '../../../../shared/contracts/agent-events'

import type { AgentEvent } from '../../../../shared/contracts/agent-events'

const LEGACY_ERROR_RE = /<tool_use_error>|(?:^|\n)\s*(?:error|错误|失败)\s*[:：]/i

/** 结构化错误位优先；只为旧 transcript 保留窄化文本兼容。 */
export function toolResultIsError(event: Extract<AgentEvent, { type: 'tool_result' }>): boolean {
  return event.is_error ?? LEGACY_ERROR_RE.test(event.output || '')
}
