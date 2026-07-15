import { z } from 'zod'
import { sessionStreamEventSchema } from './agent-events'

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
])

// 只在入站边界兼容旧客户端；规范类型和服务端输出始终保持五档新值。
const inboundPermissionModeSchema = z.union([
  permissionModeSchema,
  z.enum(['ask', 'auto_files', 'full']),
])

const inboundToCanonicalPermissionMode = {
  ask: 'default',
  auto_files: 'acceptEdits',
  full: 'bypassPermissions',
} as const

function canonicalInboundPermissionMode(value: unknown): PermissionMode {
  const parsed = inboundPermissionModeSchema.safeParse(value)
  if (!parsed.success) return 'default'
  return parsed.data in inboundToCanonicalPermissionMode
    ? inboundToCanonicalPermissionMode[parsed.data as keyof typeof inboundToCanonicalPermissionMode]
    : parsed.data as PermissionMode
}

const clientBase = {
  conversationId: z.string().min(1).optional(),
}

const workspaceAccessContext = {
  working_dir: z.string().optional(),
  full_disk_access: z.boolean().optional(),
  fullDiskAccess: z.boolean().optional(),
}

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run'),
    message: z.string(),
    ...clientBase,
    permissionMode: inboundPermissionModeSchema.optional(),
    permission_mode: inboundPermissionModeSchema.optional(),
    enabled_packs: z.array(z.string()).optional(),
    ...workspaceAccessContext,
  }).passthrough(),
  z.object({ type: z.literal('replay'), ...clientBase, after: z.number().nonnegative().default(0) }).passthrough(),
  z.object({ type: z.literal('ping'), ts: z.number().optional() }).passthrough(),
  z.object({ type: z.literal('interrupt'), ...clientBase }).passthrough(),
  z.object({ type: z.literal('steer'), message: z.string(), ...clientBase }).passthrough(),
  z.object({
    type: z.literal('approve'),
    tool: z.string().min(1),
    args: z.unknown().optional(),
    token: z.string().min(1),
    ...clientBase,
    permissionMode: inboundPermissionModeSchema.optional(),
    permission_mode: inboundPermissionModeSchema.optional(),
    remember_approval: z.boolean().optional(),
    ...workspaceAccessContext,
    enabled_packs: z.array(z.string()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('reject'),
    tool: z.string().min(1),
    args: z.unknown().optional(),
    ...clientBase,
    permissionMode: inboundPermissionModeSchema.optional(),
    permission_mode: inboundPermissionModeSchema.optional(),
    ...workspaceAccessContext,
  }).passthrough(),
])

export const assetProgressEventSchema = z.object({
  type: z.literal('asset_progress'),
  id: z.string(),
  status: z.enum(['pending', 'downloading', 'verifying', 'ready', 'failed']),
  progress: z.number(),
  tier: z.union([z.literal(1), z.literal(2)]),
  path: z.string().optional(),
  error: z.string().optional(),
  ts: z.number(),
})

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), conversationId: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('pong'), ts: z.number().optional() }),
  z.object({
    type: z.literal('event'),
    seq: z.number(),
    ts: z.union([z.number(), z.string()]),
    event: sessionStreamEventSchema,
    replay: z.boolean().optional(),
  }),
  z.object({ type: z.literal('approve_result') }).catchall(z.unknown()),
  z.object({ type: z.literal('reject_result'), ok: z.boolean() }),
  z.object({ type: z.literal('steer_result'), conversationId: z.string(), queued: z.number(), running: z.boolean() }),
  z.object({ type: z.literal('interrupt_result'), conversationId: z.string(), interrupted: z.boolean() }),
  assetProgressEventSchema,
])

export type PermissionMode = z.infer<typeof permissionModeSchema>
export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>

export function parseClientMessage(input: unknown): ClientMessage {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) && !('type' in input)
    ? { ...input, type: 'run' }
    : input
  const parsed = clientMessageSchema.parse(candidate)
  if (parsed.type !== 'run' && parsed.type !== 'approve' && parsed.type !== 'reject') return parsed

  const record = { ...parsed } as Record<string, unknown>
  const permissionMode = canonicalInboundPermissionMode(record.permissionMode ?? record.permission_mode)
  record.permissionMode = permissionMode
  record.full_disk_access = permissionMode === 'bypassPermissions'
  delete record.permission_mode
  delete record.fullDiskAccess
  return record as ClientMessage
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input)
}
