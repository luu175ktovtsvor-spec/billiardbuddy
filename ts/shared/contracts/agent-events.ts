import { z } from 'zod'

export const askQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
})

export const askQuestionFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'number', 'boolean', 'select', 'multiselect']).optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
})

export const approvalReasonSchema = z.object({
  what: z.string(),
  why: z.string(),
  impact: z.string(),
})

export const usageUpdateEventSchema = z.object({
  type: z.literal('usage_update'),
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  last_input_tokens: z.number(),
  last_output_tokens: z.number(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  context_window: z.number().optional(),
  context_percent: z.number().optional(),
})

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('command_invocation'),
    name: z.string(),
    args: z.string(),
    raw: z.string(),
    source: z.literal('commands'),
    contentLength: z.number(),
  }),
  z.object({ type: z.literal('tool_call'), tool: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_progress'),
    tool: z.string(),
    id: z.string().optional(),
    chunk: z.string(),
    stream: z.string().optional(),
  }),
  z.object({ type: z.literal('tool_result'), tool: z.string(), output: z.string() }),
  usageUpdateEventSchema,
  z.object({
    type: z.literal('ask_question'),
    id: z.string(),
    question: z.string(),
    options: z.array(askQuestionOptionSchema),
    multi: z.boolean().optional(),
    allowFreeform: z.boolean().optional(),
    placeholder: z.string().optional(),
    fields: z.array(askQuestionFieldSchema).optional(),
    url: z.string().optional(),
  }),
  z.object({ type: z.literal('final'), text: z.string() }),
  z.object({
    type: z.literal('approval_request'),
    tool: z.string(),
    args: z.unknown(),
    id: z.string(),
    token: z.string(),
    preview: z.string().optional(),
    reason: approvalReasonSchema.optional(),
    warning: z.string().optional(),
    rememberable: z.boolean().optional(),
  }),
  z.object({ type: z.literal('content_delta'), channel: z.enum(['text', 'thinking']), text: z.string() }),
  z.object({ type: z.literal('steering'), content: z.string() }),
  z.object({ type: z.literal('todo_update'), content: z.string() }),
  z.object({ type: z.literal('context_note'), text: z.string() }),
  z.object({ type: z.literal('max_turns_reached'), turnCount: z.number(), maxTurns: z.number() }),
])

export const sessionStreamEventSchema = z.discriminatedUnion('type', [
  ...agentEventSchema.options,
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('user_prompt'), text: z.string() }),
])

// 会话日志是 WS replay 的真相源，因此持久化事件和线上的 session event 使用同一契约。
export const persistedSessionEventSchema = sessionStreamEventSchema

export type AskQuestionOption = z.infer<typeof askQuestionOptionSchema>
export type AskQuestionField = z.infer<typeof askQuestionFieldSchema>
export type ApprovalReason = z.infer<typeof approvalReasonSchema>
export type UsageUpdateEvent = z.infer<typeof usageUpdateEventSchema>
export type AgentEvent = z.infer<typeof agentEventSchema>
export type SessionStreamEvent = z.infer<typeof sessionStreamEventSchema>
export type PersistedSessionEvent = z.infer<typeof persistedSessionEventSchema>
