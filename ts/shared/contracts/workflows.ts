// 经营工作流契约:确定性多步编排(每步 = 一次真 Agent 回合,同一会话串联)。
// 定义(WorkflowDefinition)描述"做什么、分几步";运行(WorkflowRun)记录一次执行的
// 每步状态、摘要与会话归属。REST 与持久化两侧共用本 Schema,边界处解析。

import { z } from 'zod'

export const workflowIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)

export const workflowStepSchema = z.object({
  id: workflowIdSchema,
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
})

export const workflowDefinitionSchema = z.object({
  id: workflowIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  // 领域包随工作流定义走:球房经营工作流默认挂台球包,通用工作流不挂。
  billiardsMode: z.boolean().default(false),
  steps: z.array(workflowStepSchema).min(1).max(20),
  source: z.enum(['bundled', 'user']).default('user'),
}).superRefine((definition, ctx) => {
  const seen = new Set<string>()
  for (const step of definition.steps) {
    if (seen.has(step.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step id: ${step.id}`, path: ['steps'] })
    }
    seen.add(step.id)
  }
})

export const workflowRunTriggerSchema = z.enum(['manual', 'scheduled'])
export const workflowRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled'])
export const workflowStepRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'])

export const workflowStepRunSchema = z.object({
  stepId: workflowIdSchema,
  title: z.string().min(1).max(200),
  status: workflowStepRunStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
})

export const workflowRunSchema = z.object({
  id: z.string().min(1).max(128),
  workflowId: workflowIdSchema,
  workflowName: z.string().min(1).max(120),
  trigger: workflowRunTriggerSchema,
  status: workflowRunStatusSchema,
  conversationId: z.string().optional(),
  workingDir: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  steps: z.array(workflowStepRunSchema),
  error: z.string().optional(),
})

export const workflowListResponseSchema = z.object({
  workflows: z.array(workflowDefinitionSchema),
})

export const workflowRunListResponseSchema = z.object({
  runs: z.array(workflowRunSchema),
})

export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>
export type WorkflowRunTrigger = z.infer<typeof workflowRunTriggerSchema>
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>
export type WorkflowStepRunStatus = z.infer<typeof workflowStepRunStatusSchema>
export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>
export type WorkflowRun = z.infer<typeof workflowRunSchema>
