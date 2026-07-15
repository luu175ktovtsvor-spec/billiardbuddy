import { z } from 'zod'

const shortTextSchema = z.string().max(500)
const nameSchema = z.string().trim().min(1).max(200)

export const extensionSourceSchema = z.enum(['builtin', 'skill', 'pack', 'plugin'])
export const extensionLayerSchema = z.enum(['bundled', 'user', 'workspace', 'plugin'])
export const extensionInvocationKindSchema = z.enum(['command', 'skill'])

export const extensionCommandSchema = z.object({
  name: nameSchema,
  description: z.string().max(2_000),
  source: extensionSourceSchema,
  kind: extensionInvocationKindSchema,
  layer: extensionLayerSchema.optional(),
  whenToUse: z.string().max(2_000).optional(),
  argHint: shortTextSchema.optional(),
})

export const extensionCommandsResponseSchema = z.object({
  commands: z.array(extensionCommandSchema).max(10_000),
})

export const extensionSkillSchema = z.object({
  name: nameSchema,
  description: z.string().max(2_000),
  display_name: nameSchema.optional(),
  short_description: z.string().max(2_000).optional(),
  source: z.enum(['skills', 'plugin']),
  layer: extensionLayerSchema,
  when_to_use: z.string().max(2_000).optional(),
  argument_hint: shortTextSchema.optional(),
  user_invocable: z.boolean(),
})

export const extensionSkillsResponseSchema = z.object({
  skills: z.array(extensionSkillSchema).max(10_000),
})

const contributionCountSchema = z.number().int().nonnegative().max(100_000)

export const pluginComponentsSchema = z.object({
  skills: contributionCountSchema,
  commands: contributionCountSchema,
  hooks: contributionCountSchema.default(0),
  'output-styles': contributionCountSchema,
  mcp: contributionCountSchema,
})

export const pluginListItemSchema = z.object({
  name: nameSchema,
  enabled: z.boolean(),
  description: z.string().max(2_000).default(''),
  components: pluginComponentsSchema,
})

export const pluginListResponseSchema = z.object({
  plugins: z.array(pluginListItemSchema).max(10_000),
})

export const pluginToggleRequestSchema = z.object({
  name: nameSchema,
  enabled: z.boolean(),
})

export const pluginInstallRequestSchema = z.object({
  repo: z.string().trim().min(1).max(2_000),
})

export const extensionMutationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(2_000).default(''),
})

export const mcpTransportSchema = z.enum(['stdio', 'sse', 'http'])

export const mcpPresetSchema = z.object({
  id: nameSchema,
  name: nameSchema,
  desc: z.string().max(2_000),
  transport: mcpTransportSchema,
  command: z.string().max(4_096).optional(),
  args: z.array(z.string().max(4_096)).max(1_000).optional(),
  url: z.string().max(8_192).optional(),
  headers: z.record(z.string(), z.string().max(8_192)).optional(),
  needsKey: z.boolean().optional(),
  keyHint: z.string().max(2_000).optional(),
  needsAsset: nameSchema.optional(),
  note: z.string().max(2_000).optional(),
})

export const mcpPresetsResponseSchema = z.object({
  presets: z.array(mcpPresetSchema).max(1_000),
})

export const mcpServerStatusSchema = z.object({
  name: nameSchema,
  command: z.string().max(4_096).optional(),
  url: z.string().max(8_192).optional(),
  transport: mcpTransportSchema.optional(),
  status: z.enum(['disabled', 'connected', 'error', 'configured']),
  tools: contributionCountSchema,
  disabled: z.boolean(),
})

export const mcpListResponseSchema = z.object({
  servers: z.array(mcpServerStatusSchema).max(10_000),
  workspaceRoot: z.string().max(8_192).optional(),
  untrusted_workspace_config: z.boolean().optional(),
  note: z.string().max(2_000).optional(),
})

export const mcpAddRequestSchema = z.object({
  name: nameSchema,
  command: z.string().trim().min(1).max(4_096).optional(),
  args: z.array(z.string().max(4_096)).max(1_000).optional(),
  env: z.record(z.string(), z.string().max(32_768)).optional(),
  url: z.string().trim().min(1).max(8_192).optional(),
  transport: mcpTransportSchema.optional(),
  headers: z.record(z.string(), z.string().max(8_192)).optional(),
}).refine(value => Boolean(value.command || value.url), {
  message: 'command or url required',
})

export const mcpNameRequestSchema = z.object({ name: nameSchema })
export const mcpToggleRequestSchema = z.object({ name: nameSchema, disabled: z.boolean() })
export const workspaceTrustRequestSchema = z.object({ workspaceRoot: z.string().trim().min(1).max(8_192) })
export const workspaceTrustResponseSchema = z.object({
  ok: z.boolean().optional(),
  trusted: z.boolean().optional(),
  approved_workspace_roots: z.array(z.string().max(8_192)).max(10_000),
})

export type ExtensionSource = z.infer<typeof extensionSourceSchema>
export type ExtensionLayer = z.infer<typeof extensionLayerSchema>
export type ExtensionInvocationKind = z.infer<typeof extensionInvocationKindSchema>
export type ExtensionCommand = z.infer<typeof extensionCommandSchema>
export type ExtensionSkill = z.infer<typeof extensionSkillSchema>
export type PluginListItem = z.infer<typeof pluginListItemSchema>
export type ExtensionMutationResult = z.infer<typeof extensionMutationResultSchema>
export type McpPreset = z.infer<typeof mcpPresetSchema>
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>
export type McpListResponse = z.infer<typeof mcpListResponseSchema>
export type McpAddRequest = z.infer<typeof mcpAddRequestSchema>
export type WorkspaceTrustResponse = z.infer<typeof workspaceTrustResponseSchema>
