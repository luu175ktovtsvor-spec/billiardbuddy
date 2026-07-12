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
  /** 远程 server 的 OAuth(对齐 cc auth.ts 行为,SDK authProvider 路线):true/对象即启用;流程与令牌存储见 mcp/oauth.ts。 */
  oauth?: { scopes?: string[]; clientName?: string }
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
      // oauth 字段:true → 默认配置;对象 → { scopes?: string[]; clientName?: string }。仅远程传输有意义。
      const oauth = raw.oauth === true
        ? {}
        : isRecord(raw.oauth)
          ? { scopes: stringArray(raw.oauth.scopes), clientName: typeof raw.oauth.clientName === 'string' ? raw.oauth.clientName : undefined }
          : undefined
      out.push({
        name,
        transport,
        url: raw.url.trim(),
        env: stringRecord(raw.env),
        disabled: raw.disabled === true,
        headers: stringRecord(raw.headers),
        ...(oauth ? { oauth } : {}),
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

/** 稳定短哈希(djb2→36进制6位):server 名全是非 ASCII(如中文)被替换殆尽时保留跨 server 区分度。 */
function hashSlug(value: string): string {
  let h = 5381
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

/**
 * server 段归一。基线 = cc normalizeNameForMCP(normalization.ts:18-24):只把非法字符替换成 `_`,
 * **不 NFKD、不折叠连续下划线、不去首尾**(旧实现三者全做,把 `my__srv` 折成 `my_srv`,破坏与
 * 权限规则/模型寻址的名字对齐;cc 仅对 "claude.ai " 前缀托管 server 才折叠,本项目无该来源)。
 * 产品分叉(登记):中文 server 名是本产品一等输入,全部字符被替换殆尽(无字母数字残留)时,
 * 旧实现统一回落 `server` 造成**所有中文 server 撞名**;改为 `srv-<稳定短哈希>` 保留区分度。
 */
function sanitizeServerPart(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9_-]/g, '_')
  if (/[A-Za-z0-9]/.test(replaced)) return replaced
  return `srv-${hashSlug(value)}`
}

/** tool 段归一 = cc 原样:只替非法字符。`get__weather` 保形不折叠(折叠会破坏 `__` 分隔符对齐)。 */
function sanitizeToolPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
}

export function mcpToolName(serverName: string, toolName: string): string {
  // 对齐 cc(normalization.ts:17-23 + client.ts:2051):只做字符归一,**不截断长度**。
  // 之前 slice(0,64) 会把长 server+tool 名剪短,不同工具剪成同名 → 权限规则匹配错工具/调用歧义。
  return `mcp__${sanitizeServerPart(serverName)}__${sanitizeToolPart(toolName)}`
}

export function approvalClassFromAnnotations(annotations: McpToolAnnotations | undefined): ApprovalClass {
  // cc 对齐:MCP server 是外部不可信代码,其 checkPermissions 恒为 passthrough→ask;
  // annotations 是 server 自报的提示,只能用于展示/并发/只读判断,不能替用户做免审批决策。
  // 因此所有 MCP 工具默认都要过审批闸(requiresApproval=true);readOnlyHint 不再短路免审批,
  // 只在 client.makeTool 里单独驱动 isReadOnly(plan 模式/并发)。想免审批只能靠用户显式 allow 规则。
  if (annotations?.destructiveHint) return 'destructive'
  return 'outreach'
}
