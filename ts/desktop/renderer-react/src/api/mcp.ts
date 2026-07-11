// MCP 服务 api(接后端 /api/v1/agent/mcp*)。前端插件页/连接器用它:
// 列已装、列预设(Playwright/高德一键启用)、增/删/停。契约对齐 src/mcp/configStore + server/index。
import { api } from './client'

/** 后端预设目录条目(= src/mcp/configStore.ts McpPreset)。 */
export interface McpPreset {
  id: string
  name: string
  desc: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  /** 需用户填 key(url 含占位或需鉴权头)。 */
  needsKey?: boolean
  keyHint?: string
  /** 需本机资产(如 'node';未就绪前端提示"正在准备")。 */
  needsAsset?: string
  note?: string
}

/** 已装 MCP 服务状态(= server listMcpStatus 单条)。 */
export interface McpServerStatus {
  name: string
  transport?: string
  status: 'disabled' | 'connected' | 'error' | 'configured'
  tools: number
  disabled: boolean
}

export interface McpListResult {
  servers: McpServerStatus[]
  untrusted_workspace_config?: boolean
  note?: string
}

/** 增/删/停统一返回。 */
export interface McpMutationResult {
  ok: boolean
  message: string
}

/** 添加 MCP 的入参:本机进程(command+args)或远程(url + transport)。 */
export interface AddMcpInput {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'stdio' | 'sse' | 'http'
  headers?: Record<string, string>
}

export const mcpApi = {
  /** 已装 MCP 列表 + 连接/工具数状态。 */
  list: (workspaceRoot?: string) =>
    api.get<McpListResult>(`/api/v1/agent/mcp${workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : ''}`),
  /** 预设目录(一键启用:Playwright / 高德)。 */
  presets: () => api.get<{ presets: McpPreset[] }>('/api/v1/agent/mcp/presets'),
  /** 添加(本机 command 或远程 url)。url 含 <占位> 时后端拒(需先填真实 key)。 */
  add: (input: AddMcpInput) => api.post<McpMutationResult>('/api/v1/agent/mcp/add', input),
  /** 删除。 */
  remove: (name: string) => api.post<McpMutationResult>('/api/v1/agent/mcp/remove', { name }),
  /** 停用/启用。 */
  toggle: (name: string, disabled: boolean) => api.post<McpMutationResult>('/api/v1/agent/mcp/toggle', { name, disabled }),
}

/** 从预设生成 add 入参:stdio 带 command+args;远程带 url+transport(需 key 的调用方先把 <占位> 换成真实值)。 */
export function addInputFromPreset(preset: McpPreset, filledUrl?: string): AddMcpInput {
  if (preset.transport === 'stdio') {
    return { name: preset.id, command: preset.command, args: preset.args }
  }
  return { name: preset.id, url: filledUrl ?? preset.url, transport: preset.transport, headers: preset.headers }
}
