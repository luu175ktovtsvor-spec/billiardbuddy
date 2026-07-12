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
