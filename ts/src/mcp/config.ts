import type { ApprovalClass } from '../permissions/types'
import { readFile } from 'node:fs/promises'

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  disabled?: boolean
  // 远程 http 传输的自定义请求头(含 Authorization: Bearer xxx)。
  // 对齐 cc(services/mcp/types.ts McpHTTPServerConfigSchema.headers):cc 没有单独的
  // "token" 字段,鉴权就是用户在这里自己写 Authorization 头;我们照做,不发明新字段。
  headers?: Record<string, string>
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
      // 传输判定对齐 cc(services/mcp/types.ts 的 type 判别):显式 type:'sse' → SSE(旧式长连 + POST 回发);
      // 其余带 url 的(type:'http' 或仅有 url 的历史写法)→ streamable http。type 缺省保持向后兼容走 http。
      const transport: McpTransport = raw.type === 'sse' ? 'sse' : 'http'
      out.push({
        name,
        transport,
        url: raw.url.trim(),
        env: stringRecord(raw.env),
        disabled: raw.disabled === true,
        headers: stringRecord(raw.headers),
      })
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

export function approvalClassFromAnnotations(annotations: McpToolAnnotations | undefined): ApprovalClass {
  // cc 对齐:MCP server 是外部不可信代码,其 checkPermissions 恒为 passthrough→ask;
  // annotations 是 server 自报的提示,只能用于展示/并发/只读判断,不能替用户做免审批决策。
  // 因此所有 MCP 工具默认都要过审批闸(requiresApproval=true);readOnlyHint 不再短路免审批,
  // 只在 client.makeTool 里单独驱动 isReadOnly(plan 模式/并发)。想免审批只能靠用户显式 allow 规则。
  if (annotations?.destructiveHint) return 'destructive'
  return 'outreach'
}
