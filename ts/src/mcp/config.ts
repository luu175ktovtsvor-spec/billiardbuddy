import type { ApprovalClass } from '../permissions/types'
import { readFile } from 'node:fs/promises'

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  disabled?: boolean
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v
  }
  return out
}

export function normalizeMcpConfig(value: unknown): McpServerConfig[] {
  if (!isRecord(value)) return []
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value
  const out: McpServerConfig[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue
    if (typeof raw.url === 'string' && raw.url.trim()) {
      out.push({ name, transport: 'http', url: raw.url.trim(), env: stringRecord(raw.env), disabled: raw.disabled === true })
      continue
    }
    if (typeof raw.command === 'string' && raw.command.trim()) {
      out.push({
        name,
        transport: 'stdio',
        command: raw.command.trim(),
        args: stringArray(raw.args),
        env: stringRecord(raw.env),
        disabled: raw.disabled === true,
      })
    }
  }
  return out
}

export async function loadMcpConfigFile(filePath: string): Promise<McpServerConfig[]> {
  const raw = await readFile(filePath, 'utf8')
  return normalizeMcpConfig(JSON.parse(raw))
}

export function commandForPlatform(config: McpServerConfig, platform: NodeJS.Platform = process.platform): { command?: string; args: string[] } {
  if (config.transport !== 'stdio' || !config.command) return { args: [] }
  if (platform === 'win32' && /^(npx|pnpm|yarn|bunx)$/i.test(config.command)) {
    return { command: 'cmd', args: ['/c', config.command, ...(config.args ?? [])] }
  }
  return { command: config.command, args: config.args ?? [] }
}

function sanitizeNamePart(value: string): string {
  const sanitized = value.normalize('NFKD').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'server'
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`.slice(0, 64)
}

export function approvalClassFromAnnotations(annotations: McpToolAnnotations | undefined): ApprovalClass | undefined {
  if (!annotations) return undefined
  if (annotations.destructiveHint) return 'destructive'
  if (annotations.openWorldHint) return 'outreach'
  if (annotations.readOnlyHint) return undefined
  return 'outreach'
}
