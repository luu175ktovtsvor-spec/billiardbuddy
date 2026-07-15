import { z } from 'zod'

export const defaultAgentPermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan'])
export const agentThemeSchema = z.enum(['light', 'dark', 'auto'])

export const agentUserSettingsSchema = z.object({
  defaultPermissionMode: defaultAgentPermissionModeSchema,
  theme: agentThemeSchema,
  allowBypassPermissionsMode: z.boolean(),
  lastWorkspaceRoot: z.string().min(1).max(4096).optional(),
  workspaceBaseDir: z.string().min(1).max(4096).optional(),
})

export const agentUserSettingsPatchSchema = z.object({
  defaultPermissionMode: defaultAgentPermissionModeSchema.optional(),
  theme: agentThemeSchema.optional(),
  allowBypassPermissionsMode: z.boolean().optional(),
  lastWorkspaceRoot: z.string().min(1).max(4096).optional(),
  workspaceBaseDir: z.string().min(1).max(4096).optional(),
}).passthrough()

export const agentSettingsIssueSchema = z.object({
  code: z.enum(['invalid_json', 'invalid_shape']),
  message: z.string(),
})

export const agentSettingsResponseSchema = z.object({
  settings: agentUserSettingsSchema,
  issues: z.array(agentSettingsIssueSchema).default([]),
  source: z.enum(['default', 'user']),
  policy: z.object({
    managedBypassDisabled: z.boolean(),
    bypassPermissionsAvailable: z.boolean(),
  }),
})

export type AgentUserSettings = z.infer<typeof agentUserSettingsSchema>
export type AgentUserSettingsPatch = z.infer<typeof agentUserSettingsPatchSchema>
export type AgentSettingsIssue = z.infer<typeof agentSettingsIssueSchema>
export type AgentSettingsResponse = z.infer<typeof agentSettingsResponseSchema>
